// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VersionHistory } from '../src/App';
import type { VersionComparison, VersionLineage, VersionSummary } from '../src/api';

/**
 * The form's version history, as the graph it claims to be.
 *
 * Three things are worth holding down here, and none of them is "a row renders".
 *
 * The first is that a version says where it came from. A restore forks a new version
 * that points back at the one it was taken from, so the history is a graph rather than
 * a count of edits: a row that only shows a number and a status cannot tell a reviewer
 * whether v3 descends from the version they approved or from the one before it.
 *
 * The second is that the comparison is the **server's** sentences, not ones the browser
 * invented. The API computes them from the two stored definitions with
 * `diffDefinitions`, and a console that re-derived its own would be a second opinion
 * nobody can check. So this test asserts the exact sentences arrived over the wire on
 * the diff request, that they are displayed, and that a version with nothing before it
 * says so instead of showing an empty list that reads as "nothing changed".
 *
 * The third is that restoring does not pretend to rewrite history: it offers the control
 * only where it means something (a draft is already editable), it asks first because it
 * replaces the current draft, and the sentence it reports names both versions.
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
const V1 = 'aaaaaaaa-1111-2222-3333-444444444444';
const V2 = 'bbbbbbbb-1111-2222-3333-444444444444';
const V3 = 'cccccccc-1111-2222-3333-444444444444';
const V4 = 'dddddddd-1111-2222-3333-444444444444';
const AUTHOR = 'user-1';
const FORMER = 'user-gone';

/**
 * A form that has been through the whole story: v1 published, v2 a draft forked from it
 * and archived, and v3 a draft restored from v1 — which is why v3's parent is v1 and not
 * the v2 immediately before it. That is the shape a number-only list gets wrong.
 */
const VERSIONS: VersionSummary[] = [
  {
    id: V3,
    version: 3,
    status: 'draft',
    title: 'School ranking',
    published_at: null,
    created_at: '2026-10-14T08:00:00.000Z',
    question_count: 12,
    based_on: V1,
    created_by: AUTHOR,
  },
  {
    id: V2,
    version: 2,
    status: 'archived',
    title: 'School ranking',
    published_at: '2026-10-13T10:00:00.000Z',
    created_at: '2026-10-13T09:30:00.000Z',
    question_count: 11,
    based_on: V1,
    created_by: AUTHOR,
  },
  {
    id: V1,
    version: 1,
    status: 'published',
    title: 'School ranking',
    published_at: '2026-10-12T12:00:00.000Z',
    created_at: '2026-10-12T11:00:00.000Z',
    question_count: 11,
    based_on: null,
    // An account that has since left the organisation: the history still names it.
    created_by: FORMER,
  },
];

const V1_LINEAGE: VersionLineage = {
  id: V1,
  version: 1,
  status: 'published',
  title: 'School ranking',
  based_on: null,
  created_at: '2026-10-12T11:00:00.000Z',
  published_at: '2026-10-12T12:00:00.000Z',
};

/** What the API answers for v3: a restore that dropped a question and changed a prompt. */
const V3_COMPARISON: VersionComparison = {
  to: {
    id: V3,
    version: 3,
    status: 'draft',
    title: 'School ranking',
    based_on: V1,
    created_at: '2026-10-14T08:00:00.000Z',
    published_at: null,
  },
  from: V1_LINEAGE,
  diff: {
    identical: false,
    counts: { added: 1, removed: 0, changed: 1 },
    changes: [
      'Added question "gps_accuracy" (decimal).',
      '"school" label in hi changed from "स्कूल" to "विद्यालय".',
    ],
    questions: [
      { name: 'gps_accuracy', kind: 'added', details: ['Added question "gps_accuracy" (decimal).'] },
      { name: 'school', kind: 'changed', details: ['"school" label in hi changed from "स्कूल" to "विद्यालय".'] },
    ],
    notes: ['The options of "school_type" come from a different source in each version, so their contents are not compared here.'],
  },
};

let container: HTMLDivElement;
let root: Root;
let calls: Call[];
let onSelect: ReturnType<typeof vi.fn>;
let onNotice: ReturnType<typeof vi.fn>;
let onChanged: ReturnType<typeof vi.fn>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  calls = [];
  onSelect = vi.fn();
  onNotice = vi.fn();
  onChanged = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // Restoring replaces the current draft, so the screen asks first — and a test cannot
  // answer a modal.
  vi.stubGlobal('confirm', () => true);

  vi.stubGlobal('fetch', (async (input: RequestInfo | URL) => {
    const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push({ method: 'GET', url, body: null });

    if (url.includes(`/orgs/${ORG}/members`)) {
      return json({ members: [{ user_id: AUTHOR, email: 'organiser@example.org', role: 'admin' }] });
    }
    if (url.endsWith(`/forms/${FORM}/versions/${V3}/diff`)) return json(V3_COMPARISON);
    // A version with nothing before it: the API answers `diff: null` rather than an
    // empty diff, and that is the difference this test is checking.
    if (url.includes(`/forms/${FORM}/versions/${V1}/diff`)) {
      return json({ to: V1_LINEAGE, from: null, diff: null } satisfies VersionComparison);
    }
    return json({});
  }) as unknown as typeof fetch);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function button(label: string, index = 0): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].filter((el) => el.textContent?.trim() === label);
  if (!found[index]) throw new Error(`no button labelled "${label}" at index ${index}`);
  return found[index] as HTMLButtonElement;
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount(versions: VersionSummary[] = VERSIONS): Promise<void> {
  await act(async () => {
    root.render(
      <VersionHistory
        formId={FORM}
        orgId={ORG}
        versions={versions}
        selectedId={V3}
        onSelect={onSelect}
        onChanged={onChanged}
        onNotice={onNotice}
      />,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('the version history', () => {
  it('shows every version with who made it, when, and where it came from', async () => {
    await mount();

    const text = container.textContent ?? '';
    expect(text).toContain('v1 · published · 11 question(s)');
    expect(text).toContain('v2 · archived · 11 question(s)');
    expect(text).toContain('v3 · draft · 12 question(s)');

    // The author is an email, not an id: a history naming `user-1` tells nobody anything.
    expect(text).toContain('organiser@example.org');
    // A member who has left is named as such rather than rendered as a blank.
    expect(text).toContain('a former member');

    // v3 was restored from v1, not from v2 which sits above it in the list.
    expect(text).toContain('based on v1');
    expect(text).toContain('the first version of this form');
    // v2 was published and then archived: both facts are on the row.
    expect(text).toContain('published');
    expect(text.match(/based on v1/g) ?? []).toHaveLength(2);
  });

  it('shows the comparison the API computed, sentence for sentence', async () => {
    await mount();
    // Newest first, so the first "What changed" belongs to v3.
    await click(button('What changed'));

    const diffCall = calls.find((call) => call.url.includes('/diff'));
    expect(diffCall?.url).toContain(`/forms/${FORM}/versions/${V3}/diff`);

    const text = container.textContent ?? '';
    expect(text).toContain('v1 → v3:');
    expect(text).toContain('1 added, 0 removed, 1 changed.');
    expect(text).toContain('Added question "gps_accuracy" (decimal).');
    expect(text).toContain('"school" label in hi changed from "स्कूल" to "विद्यालय".');
    // A partial comparison is stated, not hidden: the option source moved.
    expect(text).toContain('come from a different source in each version');
  });

  it('says a first version is where the form started rather than showing no changes', async () => {
    await mount();
    await click(button('What changed', 2));

    const text = container.textContent ?? '';
    expect(text).toContain('where this form started');
    expect(text).not.toContain('v1 → v1:');
  });

  it('offers restore only on a version that is not already editable, and reports both numbers', async () => {
    await mount();

    // Three versions, two of them not drafts: a draft is edited, not restored.
    expect([...container.querySelectorAll('button')].filter((el) => el.textContent?.trim() === 'Restore as draft')).toHaveLength(2);

    vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      calls.push({ method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (init?.method === 'POST' && url.endsWith(`/forms/${FORM}/versions/${V1}/restore`)) {
        return json({ version: { id: V4, version: 4, status: 'draft', based_on: V1 } }, 201);
      }
      return json({});
    }) as unknown as typeof fetch);

    await click(button('Restore as draft', 1));

    const post = calls.find((call) => call.method === 'POST');
    expect(post?.url).toContain(`/forms/${FORM}/versions/${V1}/restore`);
    // It lands on the new draft, and it says what happened in the two numbers a person
    // needs: the version they restored and the draft that came out of it.
    expect(onSelect).toHaveBeenCalledWith(V4);
    expect(onChanged).toHaveBeenCalled();
    expect(String(onNotice.mock.calls.at(-1)?.[0])).toContain('Restored v1 as draft v4');
    expect(String(onNotice.mock.calls.at(-1)?.[0])).toContain('Nothing was rewritten');
  });

  it('shows the server’s refusal when a restore is not allowed', async () => {
    await mount();
    vi.stubGlobal('fetch', (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return json({ error: 'forbidden', message: 'your role in this organisation cannot edit forms' }, 403);
      }
      return json({});
    }) as unknown as typeof fetch);

    await click(button('Restore as draft', 1));

    expect(String(onNotice.mock.calls.at(-1)?.[0])).toContain('cannot edit forms');
    expect(onSelect).not.toHaveBeenCalled();
  });
});
