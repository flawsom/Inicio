import { env } from '../env.js';

export interface RenderedMail {
  template: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * The emails.
 *
 * Four of them, one layout. They matter more than their size suggests: for most
 * people the first thing this product ever shows them is an inbox, and a
 * sign-in code is the one message where "did it arrive, and did it look like
 * something real" decides whether the account is ever used. So they are built to
 * the standard of the landing page rather than as a paragraph with a heading on
 * it — same palette, same voice, same one-screen-one-idea composition.
 *
 * Five rules, each of them a decision rather than a habit:
 *
 * 1. **No remote anything.** No image, no tracking pixel, no web font, no
 *    linked stylesheet. An email that fetches a file from a server is a read
 *    receipt by another name, and this project does not put one on a page; it is
 *    not going to put one in an inbox. Every mark here is text, a border or a
 *    colour, so nothing is blocked, no open is reported back to us, and the
 *    message renders complete with images turned off — which is how most people
 *    read mail.
 * 2. **Tables and inline styles**, because Outlook's renderer is Word's: no
 *    flex, no grid, no float, no margin collapsing to rely on. One `<style>`
 *    block survives, for the two things inline styles cannot express — the
 *    dark-mode overrides and hiding the preheader — and a client that strips it
 *    still gets the complete light design.
 * 3. **The code is never in the subject.** A subject is rendered by the
 *    operating system on a locked screen, quoted back in replies, and written
 *    into every mail log on the way. The body is where a reader has already
 *    chosen to look. `mail-templates.test.ts` asserts the absence.
 * 4. **The palette is the product's own, unmodified.** #ea580c, #fdba74,
 *    #ffffff, #191c21, #111827, #4b5563, #c2410c and #9ca3af are the values the
 *    landing page is measured against in `apps/web/test/contrast.test.ts`, and
 *    the reasoning carries over exactly: the primary action's label is ink on
 *    orange because white on #ea580c is 3.6:1, and the link colour is #c2410c
 *    because #ea580c as *type* needs a 5.2:1 partner. An email is not a special
 *    case of contrast; it is the same screen, in a different client.
 * 5. **The plain-text part is written, not generated.** The clients that ask for
 *    text/plain are watches, terminals and screen readers, and the HTML with the
 *    tags stripped is unreadable in all three.
 */

/**
 * Brand values, copied from `apps/web/src/landing.css` because an email cannot
 * read a stylesheet. If one of these changes it must change in both places, and
 * `mail-templates.test.ts` pins the values here so the copy is at least loud.
 */
const BRAND = {
  primary: '#ea580c',
  primaryText: '#c2410c',
  accent: '#fdba74',
  surface: '#191c21',
  text: '#111827',
  muted: '#4b5563',
  line: '#e5e7eb',
  panel: '#f9fafb',
  tint: '#fff7ed',
  /** Dark-mode card: the surface plus one step, so a card is still a card. */
  cardDark: '#1f242b',
  lineDark: '#2e343c',
  textDark: '#d1d5db',
} as const;

/** No web fonts — Outlook, Gmail and Apple Mail all drop them differently. */
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * An absolute URL in the body, or nothing.
 *
 * A relative href in an email is a dead link in every client, so the origin has
 * to be a real one. It is `APP_ORIGIN` — the same variable the API already
 * trusts for CORS and cookies, so a deployment that can sign someone in can also
 * link them back to itself.
 */
function appUrl(path: string): string | null {
  try {
    return new URL(path, env.APP_ORIGIN).toString();
  } catch {
    return null;
  }
}

function appHost(): string {
  try {
    return new URL(env.APP_ORIGIN).host;
  } catch {
    return env.APP_ORIGIN;
  }
}

/**
 * A fixed, readable instant.
 *
 * Written out rather than localised on purpose: "14 October 2026 at 09:03 UTC"
 * means the same thing to a reader in Nairobi, Boston and Tashkent, and it is a
 * record — it should not move depending on where the mail is opened.
 */
export function formatUtcDateTime(at: Date): string {
  const months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getUTCDate()} ${months[at.getUTCMonth()]} ${at.getUTCFullYear()} at ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())} UTC`;
}

/**
 * What each role can actually do, said plainly.
 *
 * An invitation that names a role without describing it makes the reader hunt
 * for the permission model before they can start. The four strings match the
 * guards in `platform/orgs.ts` and `platform/admin.ts`; an unknown role gets no
 * sentence rather than a guess.
 */
const ROLE_BLURB: Record<string, string> = {
  owner: 'Owners manage the organisation: members, API keys, webhooks and every form inside it.',
  admin: 'Admins manage members, API keys, webhooks and every form in the organisation.',
  member: 'Members author forms and read the answers for the forms they can reach.',
  viewer: 'Viewers read the answers for the forms they can reach, and cannot change them.',
};

function titleCase(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}

/* ------------------------------------------------------------------ pieces */

function paragraph(inner: string, opts: { last?: boolean } = {}): string {
  return `<tr><td class="e-text" style="padding:0 0 ${opts.last ? '0' : '16px'};font:400 15px/1.65 ${FONT};color:${BRAND.muted};">${inner}</td></tr>`;
}

function lead(inner: string): string {
  return `<tr><td class="e-lead" style="padding:0 0 24px;font:400 16px/1.6 ${FONT};color:${BRAND.muted};">${inner}</td></tr>`;
}

function strong(value: string): string {
  return `<strong class="e-strong" style="font-weight:650;color:${BRAND.text};">${value}</strong>`;
}

/** The code, as the one thing on the screen that is not prose. */
function codeBlock(code: string): string {
  return `<tr><td style="padding:2px 0 22px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr><td class="e-code" align="center" style="background:${BRAND.tint};border:1px solid ${BRAND.accent};border-radius:12px;padding:20px 10px;">
        <span class="e-code-inner" style="font:700 34px/1 ${MONO};letter-spacing:.26em;color:${BRAND.text};">${escapeHtml(code)}</span>
      </td></tr>
    </table>
  </td></tr>`;
}

function divider(): string {
  return `<tr><td style="padding:22px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="e-line" height="1" style="background:${BRAND.line};font-size:0;line-height:0;">&nbsp;</td></tr></table></td></tr>`;
}

/** Label and value, stacked, in a quiet panel — used for facts a reader keeps. */
function facts(rows: Array<{ label: string; value: string }>): string {
  const body = rows
    .map(
      ({ label, value }, index) => `<tr>
        <td class="e-muted" style="padding:${index === 0 ? '0' : '10px'} 0 2px;font:600 11px/1.4 ${FONT};letter-spacing:.12em;text-transform:uppercase;color:${BRAND.muted};">${escapeHtml(label)}</td></tr>
      <tr><td class="e-text" style="padding:0 0 0;font:500 14px/1.55 ${MONO};color:${BRAND.text};word-break:break-word;">${escapeHtml(value)}</td></tr>`,
    )
    .join('');
  return `<tr><td class="e-panel" style="background:${BRAND.panel};border:1px solid ${BRAND.line};border-radius:12px;padding:16px 18px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${body}</table>
  </td></tr>`;
}

/** Numbered next steps — three of them, because that is a beginning, not a manual. */
function steps(items: Array<{ title: string; body: string }>): string {
  const rows = items
    .map(
      (item, index) => `<tr>
        <td width="30" valign="top" style="padding:0 0 ${index === items.length - 1 ? '0' : '16px'};">
          <span class="e-step" style="display:inline-block;width:22px;height:22px;border-radius:11px;background:${BRAND.tint};border:1px solid ${BRAND.accent};color:${BRAND.primaryText};font:700 12px/22px ${FONT};text-align:center;">${index + 1}</span>
        </td>
        <td valign="top" style="padding:0 0 ${index === items.length - 1 ? '0' : '16px'} 8px;">
          <span class="e-strong" style="font:650 15px/1.5 ${FONT};color:${BRAND.text};">${item.title}</span><br/>
          <span class="e-text" style="font:400 14.5px/1.6 ${FONT};color:${BRAND.muted};">${item.body}</span>
        </td>
      </tr>`,
    )
    .join('');
  return `<tr><td style="padding:4px 0 4px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table></td></tr>`;
}

/**
 * A button that survives Outlook.
 *
 * Padding on an `<a>` is ignored by Word's renderer and the result is a bare
 * link with an orange background the height of one line. A table cell with
 * `bgcolor` renders everywhere; the corner radius is a bonus for the clients
 * that keep it. The label is ink, not white: white on #ea580c is 3.6:1.
 */
function button(label: string, href: string, tone: 'primary' | 'quiet' = 'primary'): string {
  const primary = tone === 'primary';
  const background = primary ? BRAND.primary : '#ffffff';
  const border = primary ? BRAND.primary : BRAND.line;
  const color = primary ? BRAND.text : BRAND.primaryText;
  return `<tr><td style="padding:6px 0 2px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
      <tr><td class="e-btn" align="center" bgcolor="${background}" style="background:${background};border:1px solid ${border};border-radius:999px;padding:13px 26px;">
        <a href="${href}" style="display:inline-block;font:650 15px/1.2 ${FONT};color:${color};text-decoration:none;">${escapeHtml(label)}</a>
      </td></tr>
    </table>
  </td></tr>`;
}

/**
 * What to say when something is unclear, said only when it is true.
 *
 * `MAIL_REPLY_TO` is an operator's statement that a mailbox at that address is
 * read. Without it, the sender may still be an address nobody watches, so the
 * template must not invite a reply it cannot receive: an instruction that bounces
 * is worse than no instruction, because the reader believes they asked.
 */
function unclearAdvice(): string {
  return env.MAIL_REPLY_TO
    ? 'if anything is unclear, reply to this email and it reaches us.'
    : 'if anything is unclear, an owner or an admin of the organisation is the person to ask.';
}

/** The sentence that explains, in the footer, why this arrived. */
function whyLine(text: string): string {
  return `<p class="e-muted" style="margin:0 0 10px;font:400 12px/1.6 ${FONT};color:${BRAND.muted};">${text}</p>`;
}

/* ------------------------------------------------------------------ layout */

interface Card {
  /** `<title>` and the client's tab: kept short, never the code. */
  title: string;
  preheader: string;
  heading: string;
  /** First line — the reason the mail exists, before any detail. */
  leadLine: string;
  rows: string[];
  /** Anything that belongs at the foot of the card, in small print. */
  smallPrint?: string;
  why: string;
}

/**
 * Which fields carry markup and which are plain text.
 *
 * The first three are escaped by `layout` itself, so a caller passes them as
 * data — an organisation called `St Mary's <b>School</b>` reaches this function
 * as that string and cannot close an attribute on the way through. The rest are
 * composed by the builders above, which escape the values they are handed, and
 * exist for the parts of a card that genuinely need emphasis.
 *
 * The rule is enforced by `mail-templates.test.ts`, which fails if any of the
 * data-bearing fields can carry a tag into the document.
 */

function layout(card: Card): string {
  const signIn = appUrl('/login');
  const host = escapeHtml(appHost());
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<meta name="format-detection" content="telephone=no,address=no,email=no,date=no">
<title>${escapeHtml(card.title)}</title>
<style>
  /* The only stylesheet in these emails. Inline styles carry the design; this
     block exists for what cannot be said inline: the dark palette, and keeping
     the preheader out of the visible card. A client that ignores it renders the
     light design, which is the complete one. */
  body { margin:0 !important; padding:0 !important; width:100% !important; }
  a { text-decoration:none; }
  @media (max-width: 480px) {
    .e-pad { padding:26px 20px !important; }
    .e-h1 { font-size:22px !important; }
    .e-code-inner { font-size:30px !important; }
  }
  @media (prefers-color-scheme: dark) {
    .e-body { background:${BRAND.surface} !important; }
    .e-card { background:${BRAND.cardDark} !important; border-color:${BRAND.lineDark} !important; }
    .e-wordmark, .e-h1, .e-strong { color:#ffffff !important; }
    .e-lead, .e-text { color:${BRAND.textDark} !important; }
    .e-muted { color:#9ca3af !important; }
    .e-line { background:${BRAND.lineDark} !important; }
    .e-panel { background:#22272e !important; border-color:${BRAND.lineDark} !important; }
    .e-code { background:#241a10 !important; border-color:#7c3a10 !important; }
    .e-code span { color:${BRAND.accent} !important; }
    .e-step { background:#2a1c0d !important; border-color:#7c3a10 !important; color:${BRAND.accent} !important; }
    .e-btn { background:${BRAND.primary} !important; border-color:${BRAND.primary} !important; }
    .e-quiet { background:${BRAND.cardDark} !important; border-color:${BRAND.lineDark} !important; }
    .e-link { color:${BRAND.accent} !important; }
  }
</style>
</head>
<body class="e-body" style="margin:0;padding:0;background:#ffffff;">
<!-- Preheader: the line an inbox shows next to the subject. Hidden in the card,
     and padded with zero-width characters so the client cannot pull the first
     sentence of the body up into it instead. -->
<div class="e-preheader" style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:#ffffff;opacity:0;">${escapeHtml(card.preheader)}&#8203;&#8199;&#65279;&#8203;&#8199;&#65279;&#8203;&#8199;&#65279;&#8203;&#8199;&#65279;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="e-body" style="background:#ffffff;">
<tr><td align="center" style="padding:34px 16px 10px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">

  <tr><td style="padding:0 4px 16px;">
    <span class="e-wordmark" style="font:700 18px/1 ${FONT};letter-spacing:-.01em;color:${BRAND.text};"><span style="color:${BRAND.primary};">&#9679;</span> Inicio</span>
    <span class="e-muted" style="font:600 11px/1 ${FONT};letter-spacing:.16em;text-transform:uppercase;color:${BRAND.muted};">&nbsp;&nbsp;School ranking surveys</span>
  </td></tr>

  <tr><td class="e-card e-pad" style="background:#ffffff;border:1px solid ${BRAND.line};border-radius:16px;padding:36px 40px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr><td style="padding:0 0 20px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="44" height="3" bgcolor="${BRAND.primary}" style="background:${BRAND.primary};border-radius:2px;font-size:0;line-height:0;">&nbsp;</td></tr></table></td></tr>
      <tr><td><h1 class="e-h1" style="margin:0 0 12px;font:700 26px/1.22 ${FONT};letter-spacing:-.02em;color:${BRAND.text};">${escapeHtml(card.heading)}</h1></td></tr>
      ${lead(card.leadLine)}
      ${card.rows.join('\n      ')}
      ${
        card.smallPrint
          ? `<tr><td style="padding:24px 0 0;"><p class="e-muted" style="margin:0;font:400 12.5px/1.6 ${FONT};color:${BRAND.muted};">${card.smallPrint}</p></td></tr>`
          : ''
      }
    </table>
  </td></tr>

  <tr><td style="padding:20px 6px 0;">
    ${whyLine(card.why)}
    <p class="e-muted" style="margin:0;font:400 12px/1.6 ${FONT};color:${BRAND.muted};">Inicio &#183; <a class="e-link" href="${signIn ?? escapeHtml(env.APP_ORIGIN)}" style="color:${BRAND.primaryText};">${host}</a> &#183; This is a service message about your account.</p>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

/* --------------------------------------------------------------- templates */

/**
 * The sign-in code.
 *
 * The code is the whole message and gets the only treatment nothing else in the
 * card gets: a monospaced block on the tinted panel, sized so it can be read off
 * a phone at arm's length while typing it into a laptop. One quiet button
 * returns the reader to the sign-in screen — a link back is the difference
 * between two taps and hunting for the tab — and it is deliberately *not* the
 * primary orange: the code is the action here, and two competing calls to action
 * is how a reader clicks the wrong one.
 */
export function otpEmail(to: string, code: string): RenderedMail {
  const minutes = env.OTP_TTL_MINUTES;
  const signIn = appUrl('/login');
  return {
    template: 'otp',
    to,
    subject: 'Your Inicio sign-in code',
    html: layout({
      title: `Your Inicio sign-in code`,
      preheader: `Expires in ${minutes} minutes. If you did not ask for it, you can ignore this email.`,
      heading: 'Your sign-in code',
      leadLine: `Enter this code to finish signing in as ${strong(escapeHtml(to))}.`,
      rows: [
        codeBlock(code),
        paragraph(`This code works once and expires in ${strong(`${minutes} minutes`)}.`),
        paragraph(
          `If you did not try to sign in, nothing has happened to your account: nobody can sign in without this code, and you can ignore this email.`,
        ),
        ...(signIn ? [button('Back to the sign-in screen', signIn, 'quiet')] : []),
      ],
      smallPrint: `Inicio will never ask you for this code by phone, chat or email. If someone does, it is not us.`,
      why: `You are reading this because someone entered <strong>${escapeHtml(to)}</strong> on the sign-in screen.`,
    }),
    text: `Your Inicio sign-in code

    ${code}

It works once and expires in ${minutes} minutes. Enter it on the sign-in screen
to finish signing in as ${to}.

If you did not try to sign in, nothing has happened to your account: nobody can
sign in without this code, and you can ignore this email. Inicio will never ask
you for this code by phone, chat or email.

Inicio - school ranking surveys${signIn ? `\n${signIn}` : ''}`,
  };
}

/**
 * The welcome.
 *
 * Sent when an invitation is redeemed, which is the moment somebody stops being
 * a name on a list and becomes a person with a workspace — and it is the only
 * email they will get that is not about a code. It answers the three questions a
 * new member actually has, in order: what this is, what I can do here, and what
 * my role means. It also says out loud that there is no sign-up page, because a
 * reader who does not know that will spend their first afternoon trying to find
 * one.
 */
export function welcomeEmail(
  to: string,
  context: { organisation: string; role?: string },
): RenderedMail {
  const organisation = context.organisation;
  const role = context.role ?? 'member';
  const blurb = ROLE_BLURB[role] ?? '';
  const open = appUrl('/console');
  const display = titleCase(role);
  return {
    template: 'welcome',
    to,
    subject: `Welcome to Inicio, ${organisation}`,
    html: layout({
      title: `Welcome to ${organisation}`,
      preheader: `You have joined ${organisation} on Inicio as ${display.toLowerCase()}. Three things to try first.`,
      heading: 'Welcome to Inicio',
      leadLine: `${strong(escapeHtml(organisation))} has a place for you as ${strong(display)}. Here is what you can do with it.`,
      rows: [
        paragraph(
          `Inicio builds school ranking surveys from end to end: author the questionnaire, circulate it to the schools in your sample, and read the answers back as they arrive, including the ones collected where there is no network at all.`,
        ),
        ...(blurb ? [paragraph(escapeHtml(blurb))] : []),
        divider(),
        steps([
          {
            title: 'Start from the questionnaire you already have',
            body: 'Build a form in the console or import the XLSForm your study is already using. The logic, the choices and the labels come across.',
          },
          {
            title: 'Circulate it',
            body: 'One link per school, or an offline pack that a field worker can complete and sync when they are back online.',
          },
          {
            title: 'Read the answers back',
            body: 'Live counts as submissions arrive, with exports in SPSS, Stata, CSV and XLSX when the study is ready for analysis.',
          },
        ]),
        ...(open ? [button('Open your workspace', open)] : []),
      ],
      smallPrint: `Accounts here are created by invitation only, so there is no sign-up page to pass around. If a colleague needs access, an owner or an admin can invite them from the members list, and ${unclearAdvice()}`,
      why: `This address was invited to <strong>${escapeHtml(organisation)}</strong> and the invitation was accepted.`,
    }),
    text: `Welcome to Inicio.

${organisation} has a place for you as ${display}.
${blurb ? `\n${blurb}\n` : ''}
What you can do with it:

  1. Start from the questionnaire you already have
     Build a form in the console or import the XLSForm your study is already
     using. The logic, the choices and the labels come across.

  2. Circulate it
     One link per school, or an offline pack that a field worker can complete
     and sync when they are back online.

  3. Read the answers back
     Live counts as submissions arrive, with exports in SPSS, Stata, CSV and
     XLSX when the study is ready for analysis.

${open ? `Open your workspace: ${open}\n` : ''}
Accounts here are created by invitation only, so there is no sign-up page to
pass around. If a colleague needs access, an owner or an admin can invite them
from the members list, and ${unclearAdvice()}

Inicio - school ranking surveys. This is a service message about your account.`,
  };
}

/**
 * The sign-in notice.
 *
 * Sent after a code is accepted. For an account whose only credential is an
 * inbox this is not decoration: it is the one signal that something happened
 * with the address, and the only useful advice in that case is about the inbox
 * itself rather than a password we do not have.
 */
export function otpVerifiedEmail(
  to: string,
  context: { at?: Date; ip?: string } = {},
): RenderedMail {
  const at = context.at ?? new Date();
  const when = formatUtcDateTime(at);
  const where = context.ip ? context.ip : null;
  const open = appUrl('/console');
  const rows: string[] = [
    paragraph('A sign-in to your Inicio account just completed with this email address.'),
    facts([
      { label: 'Account', value: to },
      { label: 'Time', value: when },
      ...(where ? [{ label: 'Network address', value: where }] : []),
    ]),
    paragraph(
      `If this was you, there is nothing to do. If it was not, someone has the code that was sent to this address for it to be used, so the thing to review is the security of the email account itself: its password, its recovery address, and any device still signed in. Then let an owner of your organisation know.`,
      { last: true },
    ),
    ...(open ? [button('Open Inicio', open, 'quiet')] : []),
  ];
  return {
    template: 'otp_verified',
    to,
    subject: 'New sign-in to your Inicio account',
    html: layout({
      title: 'New sign-in to your Inicio account',
      preheader: `${when}. If this was you, there is nothing to do.`,
      heading: 'You are signed in',
      leadLine: 'This is a record of a sign-in that just finished.',
      rows,
      why: `You are reading this because a sign-in code sent to <strong>${escapeHtml(to)}</strong> was used.`,
    }),
    text: `New sign-in to your Inicio account

A sign-in to your Inicio account just completed with this email address.

  Account: ${to}
  Time:    ${when}${where ? `\n  Network: ${where}` : ''}

If this was you, there is nothing to do. If it was not, someone has the code
that was sent to this address for it to be used, so the thing to review is the
security of the email account itself: its password, its recovery address, and
any device still signed in. Then let an owner of your organisation know.

Inicio - school ranking surveys. This is a service message about your account.`,
  };
}

/**
 * The submission receipt.
 *
 * The respondent's side of a submission: what was sent, and the identifier to
 * quote if anything needs to be traced. It names the school and the instrument
 * because a field worker filing several questionnaires a day needs to know
 * *which* one this was, and an id alone does not say.
 */
export function submissionConfirmationEmail(
  to: string,
  uniqueId: string,
  at: string,
  context: { school?: string; instrument?: string } = {},
): RenderedMail {
  const items = [
    { label: 'Submission ID', value: uniqueId },
    { label: 'Received', value: at },
    ...(context.school ? [{ label: 'School', value: context.school }] : []),
    ...(context.instrument ? [{ label: 'Questionnaire', value: context.instrument }] : []),
  ];
  return {
    template: 'submission_confirmation',
    to,
    subject: 'Inicio survey: submission received',
    html: layout({
      title: 'Inicio survey: submission received',
      preheader: `Received ${at}. Keep the submission ID for your records.`,
      heading: 'Submission received',      leadLine: 'Your questionnaire reached us complete and is now read-only. No further answers can be added to it.',
      rows: [
        facts(items),
        paragraph(
          `Keep this message: the submission ID above is what to quote if a question about this response ever comes up.`,
          { last: true },
        ),
      ],
      why: `You are reading this because this address submitted a questionnaire and asked for a receipt.`,
    }),
    text: `Submission received

Your questionnaire reached us complete and is now read-only. No further
answers can be added to it.

${items.map((i) => `  ${i.label}: ${i.value}`).join('\n')}

Keep this message: the submission ID above is what to quote if a question
about this response ever comes up.

Inicio - school ranking surveys. This is a service message about your account.`,
  };
}
