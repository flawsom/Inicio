// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Login } from '../src/App';

/**
 * The sign-in card, held to the facts it does not own.
 *
 * The card used to say "It expires in 10 minutes" — a number typed into a
 * component, standing beside the lifetime the server enforces and the lifetime
 * the email states. Three places, one fact, and any two of them can drift. The
 * sender is the same shape of claim: the message's footer prints the mailbox it
 * left from, and a page that names a different one has sent the reader looking
 * for a message that does not exist.
 *
 * So this drives the card the way a person does — type an address, ask for a
 * code — with the server answering twice, differently, and requires the copy to
 * follow the server both times. A page with the numbers baked in passes the
 * first assertion and fails the second, which is the point.
 *
 * The one thing that stays the card's own: what a visitor can act on. A relay
 * that refused is said in plain words and names no relay, because that is the
 * administrator's business (the admin console shows it) and not a stranger's.
 */

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

interface MailStatusBody {
  configured: boolean;
  reachable: boolean;
  basis: 'smtp-verify' | 'last-send' | 'none';
  transport: 'resend' | 'smtp';
  from: string;
  otpTtlMinutes: number;
}

let container: HTMLDivElement;
let root: Root;
let status: MailStatusBody;
/** What the request itself answers, when it is not the same as `status`. */
let requestMail: MailStatusBody;
let delivery: { ok: boolean; transport: string; detail: string; at: string };
let requested: string[];
/** When set, the mount-time mail-status read is held open until it is called. */
let releaseStatus: (() => void) | null;
let holdStatus: boolean;

function json(body: unknown, statusCode = 200): Response {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  requested = [];
  holdStatus = false;
  releaseStatus = null;
  status = {
    configured: true,
    reachable: true,
    basis: 'last-send',
    transport: 'resend',
    from: 'inicio@unifies.codes',
    otpTtlMinutes: 10,
  };
  requestMail = status;
  delivery = { ok: true, transport: 'resend', detail: 'accepted', at: '2026-10-14T09:03:00.000Z' };

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  vi.stubGlobal('fetch', (async (input: RequestInfo | URL) => {
    const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.endsWith('/auth/mail-status')) {
      if (!holdStatus) return json(status);
      return new Promise<Response>((resolve) => {
        releaseStatus = () => resolve(json(status));
      });
    }
    if (url.endsWith('/auth/otp/request')) {
      requested.push(url);
      return json({ status: delivery.ok ? 'sent' : 'not_delivered', mail: requestMail, delivery });
    }
    return json({ error: 'unexpected' }, 500);
  }) as unknown as typeof fetch);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
});

/** Mount, wait for the mail-status read to land, and hand back the rendered text. */
async function mountLogin(): Promise<() => string> {
  await act(async () => {
    root.render(<Login onSignedIn={() => undefined} />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return () => (container.textContent ?? '').replace(/\s+/g, ' ');
}

async function askForCode(email: string): Promise<void> {
  const input = container.querySelector('input[type="email"]') as HTMLInputElement;
  await act(async () => {
    // A controlled input ignores a plain assignment: React's own setter is what
    // makes the keystroke real, the same way every other page here is typed into.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, email);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const button = Array.from(container.querySelectorAll('button')).find((b) => /send me a code/i.test(b.textContent ?? ''));
  await act(async () => {
    button?.click();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe('the sign-in card states the server’s numbers, not its own', () => {
  it('asks whether email works before anyone waits for an inbox', async () => {
    const text = await mountLogin();
    expect(requested).toHaveLength(0);
    // Nothing about a lifetime or a sender until the server has said what they are.
    expect(text()).not.toMatch(/expires in/i);
    expect(text()).not.toContain('inicio@unifies.codes');
    // The card is the invitation-only front door and says so.
    expect(text()).toContain('invitation only');
  });

  it('names the sender and the lifetime the server reported, and follows it when it changes', async () => {
    const text = await mountLogin();
    await askForCode('owner@example.com');

    expect(requested).toHaveLength(1);
    expect(text()).toContain('We sent a 6 digit code to owner@example.com.');
    expect(text()).toContain('It comes from inicio@unifies.codes and expires in 10 minutes.');
    expect(text()).toContain('Look for the message from inicio@unifies.codes.');
    // Stated once. The same number twice on one screen is how a reader starts
    // wondering which of the two is the real one.
    expect((text().match(/expires in 10 minutes/g) ?? []).length).toBe(1);

    // A second deployment, with other values: the card has to move with them.
    // Both reads, because the card states the answer that came with the code and
    // a deployment that answered one way at mount and another at request time
    // would be a different defect (covered by the test below).
    status = { ...status, from: 'codes@example.org', otpTtlMinutes: 7 };
    requestMail = status;
    await act(async () => {
      root.unmount();
    });
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    const second = await mountLogin();
    await askForCode('member@example.org');
    expect(second()).toContain('It comes from codes@example.org and expires in 7 minutes.');
    expect(second()).toContain('Look for the message from codes@example.org.');
    expect((second().match(/expires in 7 minutes/g) ?? []).length).toBe(1);
    expect(second()).not.toContain('10 minutes');
  });

  /**
   * The two reads arrive in whichever order the network chooses.
   *
   * Found in a browser rather than here: the card was clicked before the
   * mount-time `mail-status` had answered, and the notice came out without its
   * second sentence — because the handler read the state that was still empty
   * instead of the answer that had just travelled with the code. The fix is not
   * to wait longer: it is to state the numbers the *request* reported, and to let
   * a slower earlier read fill a gap rather than overwrite a fresher answer.
   */
  it('states the answer that came with the code when the mount-time read is still in flight', async () => {
    holdStatus = true;
    status = { ...status, from: 'stale@example.org', otpTtlMinutes: 99 };
    requestMail = { ...status, from: 'inicio@unifies.codes', otpTtlMinutes: 10 };

    const text = await mountLogin();
    await askForCode('owner@example.com');
    expect(text()).toContain('It comes from inicio@unifies.codes and expires in 10 minutes.');
    expect(text()).toContain('Look for the message from inicio@unifies.codes.');
    expect(text()).not.toContain('stale@example.org');

    // And when the slow read finally lands, it does not replace what the code
    // came with: a card that names an older sender is worse than one that names
    // none, because the reader goes looking for the wrong message.
    await act(async () => {
      releaseStatus?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(text()).toContain('It comes from inicio@unifies.codes and expires in 10 minutes.');
    expect(text()).toContain('Look for the message from inicio@unifies.codes.');
    expect(text()).not.toContain('stale@example.org');
  });

  it('says a refusal in words a visitor can act on, and names no relay', async () => {
    delivery = { ok: false, transport: 'resend', detail: 'domain is not verified', at: '2026-10-14T09:03:00.000Z' };
    await mountLogin();
    await askForCode('owner@example.com');

    const text = (container.textContent ?? '').replace(/\s+/g, ' ');
    expect(text).toContain('We could not send a code to that address. Check the address and try again.');
    // The provider's own error text is operational detail: it belongs in the
    // admin console, not in a sentence an anonymous visitor reads.
    expect(text).not.toContain('domain is not verified');
    // And with no delivery there is no claim about where a code came from.
    expect(text).not.toMatch(/expires in/i);
  });

  it('tells the visitor up front when this deployment cannot send at all', async () => {
    status = { ...status, reachable: false, basis: 'last-send' };
    const text = await mountLogin();
    expect(text()).toContain('Sign in codes cannot be sent right now.');
    expect(text()).toContain('contact your organisation administrator');
  });
});
