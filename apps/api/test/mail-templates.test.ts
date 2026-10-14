import { describe, expect, it } from 'vitest';
import { env } from '../src/env.js';
import {
  formatUtcDateTime,
  otpEmail,
  otpVerifiedEmail,
  submissionConfirmationEmail,
  welcomeEmail,
  type RenderedMail,
} from '../src/mail/templates.js';

/**
 * The emails, pinned.
 *
 * These do not need a database: a template is a string function, and every claim
 * here is a claim about that string. What is worth pinning is the set of things
 * that quietly go wrong in mail — a code quoted on a lock screen, a tracking
 * pixel in a security notice, an apostrophe in an organisation's name ending the
 * attribute it sits in, a colour that fails contrast the moment the reader's
 * client swaps it, a message so long Gmail truncates it behind "…".
 *
 * No pool import, no fixtures: this file measures text.
 */

const ALL: Array<[string, () => RenderedMail]> = [
  ['otp', () => otpEmail('owner@example.com', '482913')],
  ['welcome', () => welcomeEmail('member@example.com', { organisation: 'Kampala Schools Study', role: 'member' })],
  ['otp_verified', () => otpVerifiedEmail('owner@example.com', { at: new Date('2026-10-14T09:03:00Z'), ip: '203.0.113.7' })],
  ['submission_confirmation', () => submissionConfirmationEmail('respondent@example.com', 'f2c1-4a', '14 October 2026 at 09:03 UTC')],
];

describe('the emails never fetch anything', () => {
  /**
   * An email that loads a resource from a server is a read receipt: the request
   * itself reports that it was opened, to whom, and when. A product that does not
   * track its readers is not allowed a tracking pixel because the medium made it
   * convenient.
   */
  it('carries no image, frame, stylesheet, font or CSS url()', () => {
    for (const [name, build] of ALL) {
      const { html } = build();
      expect(html, name).not.toMatch(/<img|<picture|<iframe|<video|<audio|<object|<embed/i);
      expect(html, name).not.toMatch(/url\s*\(/i);
      expect(html, name).not.toMatch(/@import|<link/i);
      expect(html, name).not.toMatch(/src=/i);
    }
  });

  it('links out in absolute http(s) only, and to nothing but our own origin', () => {
    for (const [name, build] of ALL) {
      const { html } = build();
      // Every remaining reference to a network is a link the reader chooses to
      // follow; a bare host left elsewhere in the document would be a fetch.
      const withoutHrefs = html.replace(/href="[^"]*"/g, '');
      expect(withoutHrefs, name).not.toMatch(/https?:\/\//i);

      const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!);
      expect(hrefs.length, name).toBeGreaterThan(0);
      for (const href of hrefs) {
        expect(href, name).toMatch(/^https?:\/\//);
        expect(href.startsWith(env.APP_ORIGIN.replace(/\/+$/, '')), `${name}: ${href}`).toBe(true);
      }
    }
  });

  it('hides the preheader but still writes one for the inbox list', () => {
    for (const [name, build] of ALL) {
      const { html } = build();
      expect(html, name).toMatch(/class="e-preheader" style="display:none/);
      const preheader = /<div class="e-preheader"[^>]*>(.*?)<\/div>/s.exec(html)?.[1] ?? '';
      // Long enough to be a sentence, not the word "Inicio": the inbox shows this
      // next to the subject, and it is the second half of the subject line.
      expect(preheader.replace(/&#\d+;/g, '').length, name).toBeGreaterThan(30);
    }
  });
});

describe('the sign-in code stays in the body', () => {
  /**
   * A subject line is rendered by the operating system on a locked screen, quoted
   * back in every reply, and written into every mail log and gateway on the way.
   * A one-time code in it is a code published to places the reader cannot see.
   */
  it('is in the html and the text part, never in the subject or the title', () => {
    const mail = otpEmail('owner@example.com', '482913');
    expect(mail.html).toContain('482913');
    expect(mail.text).toContain('482913');
    expect(mail.subject).toBe('Your Inicio sign-in code');
    expect(mail.subject).not.toContain('482913');
    expect(/<title>(.*?)<\/title>/s.exec(mail.html)?.[1]).not.toContain('482913');
    expect(/class="e-preheader"[^>]*>(.*?)<\/div>/s.exec(mail.html)?.[1]).not.toContain('482913');
  });

  it('states the lifetime the server enforces, not a number of its own', () => {
    const mail = otpEmail('owner@example.com', '482913');
    expect(mail.html).toContain(`${env.OTP_TTL_MINUTES} minutes`);
    expect(mail.text).toContain(`${env.OTP_TTL_MINUTES} minutes`);
    // And says the two things a reader needs to trust it: once, and expiring.
    expect(mail.html.toLowerCase()).toContain('works once');
  });
});

describe('a template cannot be broken by the data in it', () => {
  it('escapes the address, the organisation and the role', () => {
    const mail = welcomeEmail('"><script>alert(1)</script>@example.com', {
      organisation: `St Mary's <b>School</b> & "Friends"`,
      role: 'member',
    });
    expect(mail.html).not.toMatch(/<script|<b>School/i);
    expect(mail.html).toContain('St Mary&#39;s &lt;b&gt;School&lt;/b&gt; &amp; &quot;Friends&quot;');
    // The plain-text part is not markup, so it keeps the name as written and
    // cannot be read as anything else.
    expect(mail.text).toContain(`St Mary's <b>School</b> & "Friends"`);
  });

  it('escapes the submission id and the facts around it', () => {
    const mail = submissionConfirmationEmail('respondent@example.com', '<img src=x>', 'now', {
      school: 'Kampala High <1>',
    });
    expect(mail.html).not.toMatch(/<img/i);
    expect(mail.html).toContain('&lt;img src=x&gt;');
    expect(mail.html).toContain('Kampala High &lt;1&gt;');
  });
});

describe('an email that is truncated is an email that was not read', () => {
  it('stays far inside the point where clients clip the message', () => {
    // Gmail clips at 102 KB — and clipping hides the footer, which is where the
    // "why did I get this" lives. These are text-only designs; they have no
    // business being long.
    for (const [name, build] of ALL) {
      const { html, text } = build();
      expect(html.length, `${name} html`).toBeLessThan(40_000);
      expect(text.length, `${name} text`).toBeGreaterThan(200);
      expect(text.length, `${name} text`).toBeLessThan(4_000);
    }
  });

  it('carries no typographic dash into an inbox', () => {
    // The copy rule for this product: an em dash is the punctuation a generated
    // paragraph reaches for, and a sign-in code that reads as generated is a
    // sign-in code somebody distrusts. En and em alike, in every part of every
    // message, including the subject a lock screen shows.
    for (const [name, build] of ALL) {
      const { html, text, subject } = build();
      expect(html, `${name} html`).not.toMatch(/[\u2014\u2013]/);
      expect(text, `${name} text`).not.toMatch(/[\u2014\u2013]/);
      expect(subject, `${name} subject`).not.toMatch(/[\u2014\u2013]/);
    }
  });

  it('writes a text alternative in prose, not markup with the tags removed', () => {
    for (const [name, build] of ALL) {
      const { text } = build();
      expect(text, name).not.toMatch(/<[a-z/]/i);
      expect(text.split('\n').length, name).toBeGreaterThan(5);
    }
  });
});

describe('the palette is the product palette', () => {
  const hex = (value: string): [number, number, number] => [
    parseInt(value.slice(1, 3), 16),
    parseInt(value.slice(3, 5), 16),
    parseInt(value.slice(5, 7), 16),
  ];
  /** WCAG relative luminance → contrast ratio. Same arithmetic as `contrast.test.ts`. */
  function ratio(foreground: string, background: string): number {
    const channel = (c: number) => {
      const s = c / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (value: string) => {
      const [r, g, b] = hex(value).map(channel) as [number, number, number];
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const [a, b] = [luminance(foreground), luminance(background)].sort((x, y) => y - x) as [number, number];
    return (a + 0.05) / (b + 0.05);
  }

  it('uses the measured values from the landing page', () => {
    const { html } = otpEmail('owner@example.com', '482913');
    for (const value of ['#ea580c', '#fdba74', '#191c21', '#111827', '#4b5563', '#c2410c']) {
      expect(html).toContain(value);
    }
  });

  it('declares both schemes and carries a dark palette for the client that switches', () => {
    const { html } = otpEmail('owner@example.com', '482913');
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).toContain('@media (prefers-color-scheme: dark)');
    // Dark ground is the product's own surface, not an inverted guess at white.
    expect(html).toContain('.e-body { background:#191c21 !important; }');
  });

  it('labels the primary button in ink, because white on #ea580c is 3.6:1', () => {
    const { html } = otpEmail('owner@example.com', '482913');
    expect(ratio('#ffffff', '#ea580c')).toBeLessThan(4.5);
    expect(ratio('#111827', '#ea580c')).toBeGreaterThanOrEqual(4.5);

    const button = html.slice(html.indexOf('bgcolor="#ea580c"'));
    expect(button.length).toBeGreaterThan(0);
    expect(button.indexOf('color:#111827')).toBeLessThan(400);
  });

  it('holds every pair of colours the reader actually has to read above 4.5:1', () => {
    const pairs: Array<[string, string, string]> = [
      ['heading on card', '#111827', '#ffffff'],
      ['body on card', '#4b5563', '#ffffff'],
      ['link on card', '#c2410c', '#ffffff'],
      ['code on tint', '#111827', '#fff7ed'],
      ['step number on tint', '#c2410c', '#fff7ed'],
      ['fact label on panel', '#4b5563', '#f9fafb'],
      ['fact value on panel', '#111827', '#f9fafb'],
      ['button label on primary', '#111827', '#ea580c'],
      ['heading on dark card', '#ffffff', '#1f242b'],
      ['body on dark card', '#d1d5db', '#1f242b'],
      ['code on dark tint', '#fdba74', '#241a10'],
      ['link on dark card', '#fdba74', '#1f242b'],
      ['footer on dark ground', '#9ca3af', '#191c21'],
      ['footer on light ground', '#4b5563', '#ffffff'],
    ];
    for (const [label, foreground, background] of pairs) {
      expect(ratio(foreground, background), `${label} ${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('the sign-in notice is a record', () => {
  it('marks the instant in one unambiguous way', () => {
    expect(formatUtcDateTime(new Date('2026-10-14T09:03:00Z'))).toBe('14 October 2026 at 09:03 UTC');
    expect(formatUtcDateTime(new Date('2026-01-02T00:00:00Z'))).toBe('2 January 2026 at 00:00 UTC');
  });

  it('lists the time and, when it is known, the address the sign-in came from', () => {
    const withIp = otpVerifiedEmail('owner@example.com', { at: new Date('2026-10-14T09:03:00Z'), ip: '203.0.113.7' });
    expect(withIp.html).toContain('14 October 2026 at 09:03 UTC');
    expect(withIp.html).toContain('203.0.113.7');
    expect(withIp.text).toContain('203.0.113.7');
    expect(withIp.subject).toBe('New sign-in to your Inicio account');

    const withoutIp = otpVerifiedEmail('owner@example.com', { at: new Date('2026-10-14T09:03:00Z') });
    expect(withoutIp.html).not.toContain('Network address');
  });

  it('tells the reader what to actually do, which is about the inbox and not a password', () => {
    const { text } = otpVerifiedEmail('owner@example.com', { at: new Date('2026-10-14T09:03:00Z') });
    expect(text).toContain('security of the email account itself');
  });
});

describe('the welcome says what to do next and what the role means', () => {
  it('names the organisation, the role and the workspace', () => {
    const mail = welcomeEmail('member@example.com', { organisation: 'Kampala Schools Study', role: 'admin' });
    expect(mail.subject).toBe('Welcome to Inicio, Kampala Schools Study');
    expect(mail.html).toContain('Kampala Schools Study');
    expect(mail.html).toContain('Admin');
    expect(mail.html).toContain('Admins manage members');
    expect(mail.html).toContain(`href="${env.APP_ORIGIN.replace(/\/+$/, '')}/console"`);
  });

  it('describes each of the four real roles and guesses at nothing else', () => {
    for (const [role, phrase] of [
      ['owner', 'Owners manage the organisation'],
      ['admin', 'Admins manage members'],
      ['member', 'Members author forms'],
      ['viewer', 'Viewers read the answers'],
    ] as const) {
      expect(welcomeEmail('a@example.com', { organisation: 'Org', role }).html).toContain(phrase);
    }
    const unknown = welcomeEmail('a@example.com', { organisation: 'Org', role: 'headmaster' }).html;
    expect(unknown).not.toContain('manages the organisation');
    // The role still shows, it just is not described with someone else's words.
    expect(unknown).toContain('Headmaster');
  });

  it('says the one thing a new member would otherwise hunt for: there is no sign-up page', () => {
    const { html } = welcomeEmail('member@example.com', { organisation: 'Kampala Schools Study', role: 'member' });
    expect(html).toContain('invitation only');
  });

  /**
   * An instruction that bounces is worse than no instruction: the reader believes
   * they asked and waits for an answer that is never coming. So the invitation to
   * reply is printed only when the environment names a mailbox someone reads.
   */
  it('invites a reply only when a reply target is configured', () => {
    const saved = env.MAIL_REPLY_TO;
    try {
      env.MAIL_REPLY_TO = 'Inicio <reply@inicio.example>';
      const withReplies = welcomeEmail('member@example.com', { organisation: 'Org', role: 'member' });
      expect(withReplies.html).toContain('reply to this email and it reaches us');
      expect(withReplies.text).toContain('reply to this email and it reaches us');

      env.MAIL_REPLY_TO = undefined;
      const without = welcomeEmail('member@example.com', { organisation: 'Org', role: 'member' });
      expect(without.html).not.toContain('reply to this email');
      expect(without.text).not.toContain('reply to this email');
      expect(without.html).toContain('an owner or an admin of the organisation is the person to ask');
    } finally {
      env.MAIL_REPLY_TO = saved;
    }
  });
});

describe('the receipt is traceable', () => {
  it('carries the id and the time, and adds school and instrument only when it knows them', () => {
    const bare = submissionConfirmationEmail('r@example.com', 'f2c1-4a', '14 October 2026 at 09:03 UTC');
    expect(bare.text).toContain('f2c1-4a');
    expect(bare.text).toContain('14 October 2026 at 09:03 UTC');
    expect(bare.text).not.toMatch(/^\s+School:/m);
    expect(bare.text).not.toMatch(/^\s+Questionnaire:/m);

    const full = submissionConfirmationEmail('r@example.com', 'f2c1-4a', '14 October 2026 at 09:03 UTC', {
      school: 'Kampala High',
      instrument: 'Head teacher questionnaire',
    });
    expect(full.text).toMatch(/^\s+School: Kampala High$/m);
    expect(full.text).toMatch(/^\s+Questionnaire: Head teacher questionnaire$/m);
  });
});
