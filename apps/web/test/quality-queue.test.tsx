// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QualityTab } from '../src/App';

/**
 * The quality queue, through the interface a reviewer uses it through.
 *
 * Two claims are worth holding down here, because both are easy to lose in a
 * refactor and neither is visible from the API tests:
 *
 * 1. The queue shows *evidence*, not a verdict. A row has to render the numbers the
 *    detector recorded — the share that repeated, the duration against the
 *    threshold — because a reviewer's job is to disagree with the rule when the
 *    evidence does not support it.
 * 2. A decision is a write with a reason attached, and the screen that made it
 *    re-reads the queue afterwards: the tab is on `open`, so a flag that has just
 *    been resolved must leave the list rather than sit there looking unresolved.
 *
 * The duplicate scan is asserted separately because it is the one action on this
 * screen that runs a detector over the whole form rather than reading what has
 * already been recorded.
 */

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

interface Call {
  method: string;
  url: string;
  body: unknown;
}

const ORG = 'org-1';
const FORM = 'form-1';

const queueBody = {
  flags: [
    {
      id: 'flag-1',
      formId: FORM,
      formName: 'Household survey',
      responseId: 'aaaa1111-bbbb-2222-cccc-333344445555',
      questionId: null,
      kind: 'straight_lining',
      kindDetail: 'Most answers share one value, which is what answering without reading looks like.',
      severity: 'warn',
      detail: { share: 1, questionsInLine: 4 },
      status: 'open',
      note: null,
      createdAt: '2026-10-13T09:00:00.000Z',
      resolvedAt: null,
      resolvedBy: null,
    },
    {
      id: 'flag-2',
      formId: FORM,
      formName: 'Household survey',
      responseId: 'dddd1111-eeee-2222-ffff-333344445555',
      questionId: null,
      kind: 'speeding',
      kindDetail: 'The interview was completed faster than the threshold for its length.',
      severity: 'severe',
      detail: { durationSeconds: 5, thresholdSeconds: 20, answeredQuestions: 2 },
      status: 'open',
      note: null,
      createdAt: '2026-10-13T09:05:00.000Z',
      resolvedAt: null,
      resolvedBy: null,
    },
  ],
  summary: { byStatus: { open: 2 }, byKind: { straight_lining: 1, speeding: 1 }, open: 2 },
};

let container: HTMLDivElement;
let root: Root;
let calls: Call[];
/** What the next `POST …/flags/scan` answers. */
let scanned: number;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  calls = [];
  scanned = 2;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (method === 'POST' && url.endsWith('/flags/scan')) return json({ flagged: scanned });
    if (method === 'PATCH') return json({ flag: { ...queueBody.flags[0], status: 'resolved' } });
    return json(queueBody);
  }) as unknown as typeof fetch);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

/** React only reads a controlled input through the native setter. */
function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((el) => el.textContent?.trim() === label);
  if (!found) throw new Error(`no button labelled "${label}"`);
  return found as HTMLButtonElement;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
    await Promise.resolve();
  });
}

async function mount(): Promise<void> {
  await act(async () => {
    root.render(<QualityTab formId={FORM} orgId={ORG} />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

const reads = (): Call[] => calls.filter((c) => c.method === 'GET');

describe('the quality queue', () => {
  it('reads the open queue for this form, and shows the evidence behind each finding', async () => {
    await mount();

    expect(reads()).toHaveLength(1);
    const first = new URL(reads()[0]!.url, 'http://console.test');
    expect(first.pathname).toBe(`/api/v1/orgs/${ORG}/flags`);
    // Scoped to the form on screen, and to the status the tab is showing.
    expect(first.searchParams.get('formId')).toBe(FORM);
    expect(first.searchParams.get('status')).toBe('open');

    const text = container.textContent ?? '';
    // The queue is scoped to the form on screen, and says how much of it is open.
    expect(text).toContain('2 open');
    // The finding is named in words, and the rule that produced it is quoted: a
    // reviewer is judging the rule, not merely accepting its output.
    expect(text).toContain('straight lining');
    expect(text).toContain('Most answers share one value');
    // The evidence itself, as named facts rather than a raw JSON blob.
    expect(text).toContain('share: 1');
    expect(text).toContain('questionsInLine: 4');
    expect(text).toContain('durationSeconds: 5');
    expect(text).toContain('thresholdSeconds: 20');
    // Severity is legible at a glance rather than left to the reader.
    expect(container.querySelectorAll('.pill.warn')).toHaveLength(1);
    expect(container.querySelectorAll('.pill.bad')).toHaveLength(1);
  });

  it('records the decision with the reason, then re-reads the queue it just changed', async () => {
    await mount();

    await click(button('Review'));
    const input = container.querySelector('input');
    expect(input).not.toBeNull();
    await act(async () => {
      type(input as HTMLInputElement, 'supervisor confirmed the answers');
      await Promise.resolve();
    });

    await click(button('Resolve'));

    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch).toBeDefined();
    expect(patch!.url).toContain(`/orgs/${ORG}/flags/flag-1`);
    expect(patch!.body).toEqual({ status: 'resolved', note: 'supervisor confirmed the answers' });

    // The screen was on `open`, so the write has to be followed by a read of the
    // same list — otherwise the row stays on screen looking undecided.
    expect(reads()).toHaveLength(2);
    expect(reads()[1]!.url).toContain('status=open');
    expect(container.textContent).toContain('Recorded as resolved');
  });

  it('dismisses as its own outcome, which is not the same answer as resolving', async () => {
    await mount();

    await click(button('Review'));
    await act(async () => {
      type(container.querySelector('input') as HTMLInputElement, 'duplicate of 1042');
      await Promise.resolve();
    });
    await click(button('Dismiss'));

    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch!.body).toEqual({ status: 'dismissed', note: 'duplicate of 1042' });
  });

  it('runs the duplicate scan over the whole form and reports what it found', async () => {
    await mount();

    await click(button('Scan for duplicates'));

    const scan = calls.find((c) => c.method === 'POST');
    expect(scan).toBeDefined();
    expect(scan!.url).toContain(`/orgs/${ORG}/forms/${FORM}/flags/scan`);
    expect(container.textContent).toContain('2 duplicate responses flagged');
    // The scan wrote findings, so the queue on screen has to be re-read too.
    expect(reads()).toHaveLength(2);

    // And the idempotent answer is stated as idempotence rather than as "nothing
    // happened", because a second scan legitimately finds nothing new.
    scanned = 0;
    await click(button('Scan for duplicates'));
    expect(container.textContent).toContain('No new duplicates');
  });

  it('switches the queue to another status by re-reading with that status', async () => {
    await mount();

    await click(button('resolved'));

    const last = reads()[reads().length - 1]!;
    expect(last.url).toContain('status=resolved');
  });
});
