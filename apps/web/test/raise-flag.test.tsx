// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataTab } from '../src/App';

/**
 * Raising a finding by hand, from the screen where the responses actually are.
 *
 * The claim worth holding down here is not "a POST happens". It is that the two
 * possible answers are reported as two different things. The API records one
 * hand-raised finding per response and kind — a unique index refuses a second
 * identical one — and it says which happened: `201 { queued: true }` when something
 * was written, `200 { queued: false, reason: 'already_recorded' }` when the finding
 * was already there. A screen that printed "raised" for both would tell somebody
 * their complaint had been recorded when it had been dropped, which is the same
 * class of lie as "sent" for a mail that never left the building.
 *
 * The other two assertions are about not making a person fight the form: the raise
 * waits for a note (the API rejects an empty one, and a finding without a reason is
 * not actionable), and a server refusal is shown in the server's own words rather
 * than as "something went wrong".
 */

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

interface FakeEvent {
  data: string;
}

/** The console subscribes to a form's stream; jsdom has no `EventSource`. */
class FakeSource {
  private readonly listeners = new Map<string, Array<(event: FakeEvent) => void>>();
  onerror: (() => void) | null = null;
  static latest: FakeSource | null = null;

  constructor(readonly url: string) {
    FakeSource.latest = this;
  }

  addEventListener(name: string, listener: (event: FakeEvent) => void): void {
    const existing = this.listeners.get(name) ?? [];
    existing.push(listener);
    this.listeners.set(name, existing);
  }

  emit(name: string, payload: unknown): void {
    const event: FakeEvent = { data: JSON.stringify(payload) };
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }

  close(): void {
    /* nothing to release */
  }
}

interface Call {
  method: string;
  url: string;
  body: unknown;
}

const ORG = 'org-1';
const FORM = 'form-1';
const FIRST = 'aaaa1111-bbbb-2222-cccc-333344445555';
const SECOND = 'dddd1111-eeee-2222-ffff-333344445555';

const responsesBody = {
  responses: [
    {
      id: FIRST,
      form_version_id: 'ver-1',
      form_version: 1,
      status: 'submitted',
      started_at: '2026-10-13T09:00:00.000Z',
      submitted_at: '2026-10-13T09:04:00.000Z',
      updated_at: '2026-10-13T09:04:00.000Z',
      answers: { q1: 'yes', q2: 4 },
      conflict_count: 0,
    },
    {
      id: SECOND,
      form_version_id: 'ver-1',
      form_version: 1,
      status: 'in_progress',
      started_at: '2026-10-13T09:10:00.000Z',
      submitted_at: null,
      updated_at: '2026-10-13T09:10:00.000Z',
      answers: { q1: 'no' },
      conflict_count: 1,
    },
  ],
  counts: [
    { status: 'submitted', count: 1 },
    { status: 'in_progress', count: 1 },
  ],
  limit: 50,
  offset: 0,
};

const analyticsBody = {
  definition: { defaultLanguage: 'en', questions: [{ name: 'q1', label: { en: 'Household visited?' } }] },
  publishedVersion: 1,
  byStatus: [{ status: 'submitted', count: 1 }],
  tallies: [{ question_id: 'q1', value: 'yes', count: 1 }],
  timeline: [{ day: '2026-10-13', started: 2, submitted: 1 }],
  conflicts: 1,
  generatedAt: '2026-10-13T09:20:00.000Z',
};

let container: HTMLDivElement;
let root: Root;
let calls: Call[];
/** What the next raise answers. */
let raiseAnswer: { status: number; body: unknown };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  FakeSource.latest = null;
  vi.stubGlobal('EventSource', FakeSource as unknown as typeof EventSource);
  calls = [];
  raiseAnswer = { status: 201, body: { queued: true } };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });

    // `api.responses` asks for `?limit=200`, so match on the path rather than on the
    // end of the URL.
    if (method === 'GET' && url.includes(`/forms/${FORM}/responses?`)) return json(responsesBody);
    if (url.endsWith('/analytics')) return json(analyticsBody);
    if (url.includes('/flags') && method === 'POST') return json(raiseAnswer.body, raiseAnswer.status);
    return json({});
  }) as unknown as typeof fetch);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((el) => el.textContent?.trim() === label);
  if (!found) throw new Error(`no button labelled "${label}"`);
  return found as HTMLButtonElement;
}

function hasButton(label: string): boolean {
  return [...container.querySelectorAll('button')].some((el) => el.textContent?.trim() === label);
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
    await Promise.resolve();
  });
}

function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

const noteField = (): HTMLInputElement =>
  [...container.querySelectorAll('input')].find((el) => el.placeholder === 'Why? kept with the finding') as HTMLInputElement;

const severityRadio = (level: string): HTMLInputElement =>
  [...container.querySelectorAll('input[type="radio"]')].find(
    (el) => el.parentElement?.textContent?.trim() === level,
  ) as HTMLInputElement;

async function mount(): Promise<void> {
  await act(async () => {
    root.render(<DataTab formId={FORM} orgId={ORG} publishedVersion={1} />);
    await Promise.resolve();
    await Promise.resolve();
  });
  // The stream says it is live, so no fallback timer is armed and the reads below
  // are the only requests this screen makes.
  await act(async () => {
    FakeSource.latest?.emit('ready', {});
  });
}

describe('raising a finding by hand', () => {
  it('lists the responses with their answers, and offers the raise control on a row', async () => {
    await mount();

    const text = container.textContent ?? '';
    expect(text).toContain('aaaa1111');
    expect(text).toContain('yes');
    // Two responses, two raise controls — the form opens on the row it belongs to.
    expect([...container.querySelectorAll('button')].filter((el) => el.textContent?.trim() === 'Flag')).toHaveLength(2);
  });

  it('waits for a note, then records the severity and the note with the finding', async () => {
    await mount();

    await click(button('Flag'));
    expect(noteField()).toBeDefined();
    // The API rejects an empty note, so the button waits for one rather than
    // letting a 400 explain it after the fact.
    expect(button('Raise').disabled).toBe(true);

    await act(async () => {
      severityRadio('severe').click();
      await Promise.resolve();
    });
    await act(async () => {
      type(noteField(), 'questionnaire answered in four minutes');
      await Promise.resolve();
    });
    expect(button('Raise').disabled).toBe(false);

    await click(button('Raise'));

    const raised = calls.find((c) => c.method === 'POST');
    expect(raised).toBeDefined();
    expect(raised!.url).toContain(`/orgs/${ORG}/forms/${FORM}/responses/${FIRST}/flags`);
    expect(raised!.body).toEqual({ severity: 'severe', note: 'questionnaire answered in four minutes' });
    expect(container.textContent).toContain('Raised a severe finding for aaaa1111');
    // The form closes on success: a second click must not raise the same thing twice.
    expect(hasButton('Raise')).toBe(false);
  });

  it('does not report a dropped finding as a recorded one', async () => {
    await mount();

    // First raise: the finding is new, so the API wrote it.
    await click(button('Flag'));
    await act(async () => {
      type(noteField(), 'answers look copied');
      await Promise.resolve();
    });
    await click(button('Raise'));
    const recorded = container.textContent ?? '';
    expect(recorded).toContain('Raised a warn finding');
    expect(recorded).not.toContain('already in the queue');

    // Second raise of the same kind on the same response: the unique index refuses
    // it and the API says so. The screen has to say so too.
    raiseAnswer = { status: 200, body: { queued: false, reason: 'already_recorded' } };
    await click(button('Flag'));
    await act(async () => {
      type(noteField(), 'saying the same thing again');
      await Promise.resolve();
    });
    await click(button('Raise'));

    const second = container.textContent ?? '';
    expect(second).toContain('already in the queue');
    expect(second).not.toContain('Raised a warn finding');
    expect(second).toContain('keeps the note it was raised with');
  });

  it('surfaces a refusal in the server’s own words', async () => {
    await mount();
    raiseAnswer = { status: 400, body: { error: 'invalid_request', message: 'a note is required' } };

    await click(button('Flag'));
    await act(async () => {
      type(noteField(), 'note that the server will refuse');
      await Promise.resolve();
    });
    await click(button('Raise'));

    expect(container.textContent).toContain('a note is required');
    // The form stays open on its error rather than pretending the finding went in.
    expect(hasButton('Raise')).toBe(true);
  });
});
