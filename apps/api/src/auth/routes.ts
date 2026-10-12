import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../env.js';
import { requestOtp, verifyOtp } from './otp.js';
import { issueSession, resolveSession, revokeSession, touchSession } from './session.js';
import { otpEmail, otpVerifiedEmail } from '../mail/templates.js';
import { deliverInBackground } from '../mail/transport.js';

const requestSchema = z.object({ email: z.string().email() });
const verifySchema = z.object({
  email: z.string().email(),
  code: z.string().regex(/^[0-9]{6}$/, 'code must be 6 digits'),
});

export function sessionCookieOptions(maxAgeSeconds?: number) {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: 'lax' as const,
    path: '/',
    ...(maxAgeSeconds ? { maxAge: maxAgeSeconds } : {}),
  };
}

export async function readSession(req: FastifyRequest) {
  const token = req.cookies[env.SESSION_COOKIE_NAME];
  if (!token) return null;
  return resolveSession(token);
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post('/otp/request', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });

    const result = await requestOtp({ email: parsed.data.email, ip: req.ip });
    if (result.status === 'not_invited') return reply.code(404).send({ error: 'not_invited' });
    if (result.status === 'cooldown') {
      return reply
        .code(429)
        .send({ error: 'rate_limited', retryAfterSeconds: result.retryAfterSeconds });
    }

    // Off the response path: SMTP latency/outage must not block the respondent.
    deliverInBackground({ ...otpEmail(result.school.registered_email, result.code), schoolId: result.school.id });

    // The code is delivered by mail and nowhere else. There is no debug echo:
    // a code that reaches the browser is a login anybody can complete.
    return reply.code(200).send({ status: 'sent' });
  });

  app.post('/otp/verify', async (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = verifySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });

    const result = await verifyOtp({ email: parsed.data.email, code: parsed.data.code, ip: req.ip });
    if (result.status !== 'verified') {
      return reply.code(401).send({ error: 'invalid_otp', reason: result.status });
    }

    const subject = `school:${result.school.id}`;
    const session = await issueSession(subject, req.ip);
    reply.setCookie(
      env.SESSION_COOKIE_NAME,
      session.token,
      sessionCookieOptions(env.SESSION_IDLE_MINUTES * 60),
    );
    deliverInBackground({ ...otpVerifiedEmail(result.school.registered_email), schoolId: result.school.id });
    return reply.code(200).send({ subject });
  });

  app.post('/logout', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = req.cookies[env.SESSION_COOKIE_NAME];
    if (token) await revokeSession(token, req.ip);
    reply.clearCookie(env.SESSION_COOKIE_NAME, { path: '/' });
    return reply.code(204).send();
  });

  // Not in openapi.yaml v1; added so the SPA can render signed-in state.
  app.get('/me', async (req: FastifyRequest, reply: FastifyReply) => {
    const session = await readSession(req);
    if (!session) return reply.code(401).send({ error: 'unauthenticated' });
    await touchSession(session);
    return reply.code(200).send({ subject: session.subject });
  });
};
