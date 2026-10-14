import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { env } from '../env.js';
import { generateOtpCode, sha256Hex, timingSafeEqualHex } from '../lib/crypto.js';
import { deliverForLogin, deliverInBackground, mailStatus, type MailStatus } from '../mail/transport.js';
import { bareAddress, otpEmail, otpVerifiedEmail, welcomeEmail } from '../mail/templates.js';
import { issueSession, revokeSession } from '../auth/session.js';
import { termsSatisfied } from './terms.js';
import { sessionCookieOptions } from '../auth/routes.js';
import { withUser } from './db.js';
import { audit, currentIdentity, requireIdentity } from './guards.js';

const requestSchema = z.object({ email: z.string().trim().toLowerCase().email() });
const verifySchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  code: z.string().regex(/^[0-9]{6}$/, 'code must be 6 digits'),
});

/** Internal only: signup is closed for this deployment (0005). Shaped as
 *  `not_invited` so nothing about the policy choice is revealed in the reply. */
class SignupClosed extends Error {}

interface UserRow {
  id: string;
  email: string;
  status: string;
}

/**
 * Identity for the platform: any email can request a code, because the product is
 * open-signup (§ open signup in specs/PLATFORM.md). The account is created on first
 * request through `app_find_or_create_user`, which is SECURITY DEFINER for the same
 * reason as signup in Phase 1: there is no session to satisfy a policy with yet.
 *
 * Abuse control at this layer is deliberately conservative and visible: a per-email
 * cooldown, a hard cap on attempts per code, and the same uniform response for
 * "unknown" as for "known" so the endpoint is not an account oracle.
 */
async function findOrCreateUser(email: string): Promise<UserRow> {
  const { rows } = await pool.query<UserRow>(
    `SELECT id, email, status FROM app_get_user($1::citext)`,
    [email],
  );
  const existing = rows[0];
  if (existing) return existing;

  // Closed bridge: an unknown address may only get an account through an
  // organisation invitation. Open signup was a Phase-1 affordance and is
  // exactly the hole "people we don't want could walk in" referred to.
  // INVITE_ONLY=true (the default) blocks self-signup here; the only callers
  // that survive are invited emails created by app_invite_member().
  if (env.INVITE_ONLY) {
    throw new SignupClosed();
  }
  const { rows: created } = await pool.query<UserRow>(
    `SELECT app_find_or_create_user($1::citext) AS id`,
    [email],
  );
  const id = created[0]?.id;
  if (!id) throw new Error('signup failed');
  return { id, email, status: 'active' };
}

/**
 * The public view of mail health.
 *
 * A visitor learns whether a code can be sent and how that was established.
 * The relay, the transport and the provider's own error text are operational
 * detail: they belong in the admin console, not in a response anybody can read.
 *
 * Two facts travel with that answer because the sign-in screen has to state
 * them and neither can be typed into a component: `from` is the mailbox the
 * code will arrive from (the same reduction the message's own footer prints,
 * from the same variable, so the page cannot name a sender the relay did not
 * use) and `otpTtlMinutes` is the lifetime the server enforces. A page that
 * hard-codes "expires in 10 minutes" is stating a number it does not own, and
 * that is exactly the second number beside the first the emails were just
 * relieved of.
 */
function publicMailStatus(status: MailStatus): {
  configured: boolean;
  reachable: boolean;
  basis: MailStatus['basis'];
  transport: MailStatus['transport'];
  from: string;
  otpTtlMinutes: number;
} {
  return {
    configured: status.configured,
    reachable: status.reachable,
    basis: status.basis,
    transport: status.transport,
    from: bareAddress(status.from),
    otpTtlMinutes: env.OTP_TTL_MINUTES,
  };
}

export const platformAuthRoutes: FastifyPluginAsync = async (app) => {
  app.post('/otp/request', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const email = parsed.data.email;

    let user: UserRow;
    try {
      user = await findOrCreateUser(email);
    } catch (err) {
      // Signup closed and "not invited" are deliberately one indistinguishable
      // failure: both mean "this address cannot get in", and neither should
      // confirm whether any account exists.
      if (err instanceof SignupClosed) return reply.code(404).send({ error: 'not_invited' });
      throw err;
    }

    const { rows: recent } = await pool.query<{ retry_after: number | null }>(
      `SELECT GREATEST(
                0,
                CEIL(EXTRACT(EPOCH FROM (created_at + make_interval(secs => $2::int) - now())))
              )::int AS retry_after
         FROM user_otp
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [user.id, env.OTP_RESEND_COOLDOWN_SECONDS],
    );
    const retryAfter = recent[0]?.retry_after;
    if (retryAfter !== null && retryAfter !== undefined && retryAfter > 0) {
      return reply.code(429).send({ error: 'rate_limited', retryAfterSeconds: retryAfter });
    }
    if (user.status === 'disabled') {
      // Same shape as a successful send: never reveal account status.
      return reply.code(200).send({ status: 'sent' });
    }

    const code = generateOtpCode();
    // One live code per user, atomically: consuming the previous slot in the
    // same transaction that opens the new one is what makes the attempt
    // counter un-resettable by re-issuing (0005's unique index is the second
    // half of that guarantee).
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE user_otp SET consumed = true WHERE user_id = $1 AND consumed = false`, [user.id]);
      await client.query(
        `INSERT INTO user_otp (user_id, code_hash, expires_at)
         VALUES ($1, $2, now() + make_interval(mins => $3::int))`,
        [user.id, sha256Hex(`${code}${env.OTP_PEPPER}`), env.OTP_TTL_MINUTES],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    await audit(req, `user:${user.id}`, 'platform.otp_requested', user.id, { email });
    // Deliver, then report what the relay actually said. An HTTPS relay answers
    // inside the request (the message id, or the provider's refusal); SMTP keeps
    // its verdict to a probe, because waiting on a dead relay there costs
    // seconds.
    // The request's own instant and its source address ride with the code, so
    // the message can say when it was asked for and from where. Both are facts
    // this request already has, and a reader deciding whether a sign-in attempt
    // was them is the one reader who needs them.
    const delivery = await deliverForLogin(otpEmail(email, code, { at: new Date(), ip: req.ip }));

    // Whether an email can actually be delivered is part of the answer, not a
    // detail the client has to infer from an empty inbox. Only the HTTPS relay
    // has new information to report (the send that just returned); an SMTP probe
    // is cached, because re-verifying it on every request would cost seconds.
    const mail = publicMailStatus(await mailStatus(delivery.transport === 'resend'));

    // The code is NEVER echoed back to the client — that turned login into
    // something any script could complete without reading an inbox. A failed
    // delivery is reported honestly (D18/D19); the user asks for a new code or
    // the operator fixes the relay.
    return reply.code(200).send({
      status: delivery.ok ? 'sent' : 'not_delivered',
      mail,
      delivery,
    });
  });

  app.post('/otp/verify', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = verifySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const { email, code } = parsed.data;

    const user = await findOrCreateUser(email);
    // Only the newest slot may be verified. A user_otp lookup that walked
    // through to an older, unconsumed row would be a parallel guess channel:
    // several slots would multiply the attempts budget (the reason 0005 keeps
    // exactly one live slot, and why this query is nargs-limited here too).
    const { rows } = await pool.query<{ newest: string; id: string; code_hash: string; expires_at: Date; attempts: number; consumed: boolean }>(
      `SELECT (SELECT id FROM user_otp u2
                WHERE u2.user_id = u.user_id
                ORDER BY created_at DESC LIMIT 1) AS newest,
              u.id, u.code_hash, u.expires_at, u.attempts, u.consumed
         FROM user_otp u
        WHERE u.user_id = $1
        ORDER BY u.created_at DESC
        LIMIT 1`,
      [user.id],
    );
    const otp = rows[0];
    if (!otp || otp.id !== otp.newest) {
      // No live code exists — including "an older slot was somehow checked".
      return reply.code(401).send({ error: 'invalid_otp', reason: 'expired' });
    }
    if (otp.consumed || otp.expires_at.getTime() <= Date.now()) {
      return reply.code(401).send({ error: 'invalid_otp', reason: 'expired' });
    }
    if (otp.attempts >= env.OTP_MAX_ATTEMPTS) {
      return reply.code(401).send({ error: 'invalid_otp', reason: 'attempts_exceeded' });
    }

    const expected = sha256Hex(`${code}${env.OTP_PEPPER}`);
    if (!timingSafeEqualHex(expected, otp.code_hash)) {
      await pool.query(`UPDATE user_otp SET attempts = attempts + 1 WHERE id = $1`, [otp.id]);
      return reply.code(401).send({ error: 'invalid_otp', reason: 'mismatch' });
    }

    await pool.query(`UPDATE user_otp SET consumed = true WHERE id = $1`, [otp.id]);
    const session = await issueSession(`user:${user.id}`, req.ip);
    reply.setCookie(env.SESSION_COOKIE_NAME, session.token, sessionCookieOptions(env.SESSION_IDLE_MINUTES * 60));
    await audit(req, `user:${user.id}`, 'platform.signed_in', user.id, { email });
    // The notice goes out on every sign-in, off the response path (D32). For an
    // account whose only credential is an inbox, this is the one thing that
    // makes a compromise visible, and it costs the reader one line if it was
    // them. No `schoolId`: this is a platform user, and `email_log.school_id`
    // references `school` — an organisation id is a different table.
    deliverInBackground({ ...otpVerifiedEmail(email, { at: new Date(), ip: req.ip }) });
    return reply.code(200).send({ subject: session.subject });
  });

  app.post('/logout', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = req.cookies[env.SESSION_COOKIE_NAME];
    if (token) await revokeSession(token, req.ip);
    reply.clearCookie(env.SESSION_COOKIE_NAME, { path: '/' });
    return reply.code(204).send();
  });

  /** Who am I, and which organisations can I see — the first screen after login. */
  app.get('/me', async (req: FastifyRequest, reply: FastifyReply) => {
    const identity = await requireIdentity(req);
    const organisations = await withUser(identity.userId, async (client) => {
      const { rows } = await client.query(
        `SELECT o.id, o.name, o.slug, o.plan, m.role, o.created_at,
                (SELECT count(*)::int FROM form f WHERE f.org_id = o.id AND f.archived_at IS NULL) AS form_count,
                (SELECT count(*)::int FROM membership mm WHERE mm.org_id = o.id) AS member_count
           FROM membership m
           JOIN org o ON o.id = m.org_id
          WHERE m.user_id = $1
          ORDER BY o.created_at`,
        [identity.userId],
      );
      return rows;
    });
    return reply.code(200).send({
      user: { id: identity.userId, email: identity.email, displayName: identity.displayName },
      organisations,
    });
  });

  /**
   * Does this deployment have working email? Asked by the login screen before
   * anyone types an address, so "no code arrived" is never a silent failure.
   */
  app.get('/mail-status', async (_req: FastifyRequest, reply: FastifyReply) => {
    const status = await mailStatus(true);
    // Public, so it carries only what a visitor can act on: whether codes can be
    // sent, how that answer was reached, which mailbox a code arrives from, and
    // how long it lives. The relay, the transport and the provider's error text
    // are operational detail and live behind the admin console instead. (No echo
    // field, ever: that shortcut made email optional.)
    return reply.code(200).send(publicMailStatus(status));
  });

  /**
   * Look at an invitation without spending it.
   *
   * A GET must not consume the link: mail scanners and link previews fetch URLs
   * before a human sees the mail, and a consumed-by-robot invitation is
   * indistinguishable from a broken one. Redemption is the POST below.
   */
  app.get('/invite/:token', async (req: FastifyRequest<{ Params: { token: string } }>, reply: FastifyReply) => {
    const hash = sha256Hex(req.params.token);
    const { rows } = await pool.query<{
      email: string;
      role: string;
      org_name: string;
      expires_at: Date;
      pending: boolean;
    }>(`SELECT email, role, org_name, expires_at, pending FROM app_peek_invite($1)`, [hash]);

    const invite = rows[0];
    // Used, revoked, expired and never existed all answer the same way: the
    // endpoint does not confirm which invitations are real.
    if (!invite || !invite.pending) return reply.code(404).send({ error: 'invite_invalid' });
    return reply.send({
      invite: { email: invite.email, role: invite.role, organisation: invite.org_name, expiresAt: invite.expires_at },
    });
  });

  /**
   * Redeem an invitation: one atomic step consuming the link, joining the
   * organisation with the role the invitation carries (never one supplied by the
   * caller), and issuing a fresh session.
   */
  app.post('/invite/redeem', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = z.object({ token: z.string().min(20).max(200) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });

    const { rows } = await pool.query<{
      user_id: string;
      org_id: string;
      role: string;
      email: string;
      org_name: string;
    }>(
      // The function prefixes its OUT names so they cannot shadow table columns
      // inside its body (see 0008); the aliases here keep the API shape stable.
      `SELECT out_user_id AS user_id, out_org_id AS org_id, out_role AS role,
              out_email AS email, out_org_name AS org_name
         FROM app_redeem_invite($1)`,
      [sha256Hex(parsed.data.token)],
    );

    const joined = rows[0];
    if (!joined) return reply.code(410).send({ error: 'invite_invalid' });

    const session = await issueSession(`user:${joined.user_id}`, req.ip);
    reply.setCookie(env.SESSION_COOKIE_NAME, session.token, sessionCookieOptions(env.SESSION_IDLE_MINUTES * 60));
    await audit(req, `user:${joined.user_id}`, 'user.invite_accepted', joined.org_id, {
      role: joined.role,
      email: joined.email,
    });

    // The welcome, and the only email in the product that is not about a code.
    // It is fire-and-forget because the reader is already signed in by the time
    // it would send: a relay that is down must not turn accepting an invitation
    // into a failure. `schoolId` stays empty for the same reason as above — the
    // log's column is a school, and this is an organisation.
    deliverInBackground({
      ...welcomeEmail(joined.email, {
        organisation: joined.org_name,
        role: joined.role,
        at: new Date(),
      }),
    });

    return reply.send({
      subject: session.subject,
      organisation: { id: joined.org_id, name: joined.org_name },
      role: joined.role,
      // The client accepts the terms before entering the workspace, so it needs
      // to know whether that step is still outstanding.
      termsRequired: !(await termsSatisfied(joined.user_id)),
    });
  });

  // Kept for parity with the Phase-1 route shape: signed-out callers get 401.
  app.get('/session', async (req: FastifyRequest, reply: FastifyReply) => {
    const identity = await currentIdentity(req);
    if (!identity) return reply.code(401).send({ error: 'unauthenticated' });
    return reply.code(200).send({ user: { id: identity.userId, email: identity.email } });
  });
};
