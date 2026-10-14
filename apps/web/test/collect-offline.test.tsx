// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Collect } from '../src/collect';

/**
 * What the collection page does when the network is the problem.
 *
 * `offline.test.ts` holds the queue's rules without a browser, and `scripts/e2e-offline.mjs`
 * drives the API from outside one. Neither can see the thing this file is about: the page
 * a person actually holds, on the two occasions where field data is really lost. A photo
 * that never finished uploading while the signal dropped, and a device that is wiped,
 * replaced, or full.
 *
 * The rule under test is that the three failures are kept apart rather than reported alike:
 *
 * - a file the **server refused** is the server's verdict, and trying it again unchanged
 *   would fail in exactly the same way, so it is not remembered;
 * - a file **the network dropped** is not a verdict at all, so it is held on the device and
 *   sent by itself when the connection returns, with the answer only written once the
 *   server has looked at what arrived;
 * - a device with **no room left** is told about before it costs anything, because the
 *   alternative is discovering it through a save that silently did not happen.
 *
 * And the recovery that needs nothing at all: a copy of the draft, written to a file and
 * read back, so a device that goes away does not take unsent answers with it.
 *
 * `fetch` is stubbed rather than the API module, so the real client, the real queue and the
 * real renderer all run; the only thing replaced is the wire.
 */

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

/**
 * A link of this test's own.
 *
 * The durable store is keyed by the link's token and is opened once per module, so two
 * tests sharing one token would share one draft — and the second would start from the
 * answers the first left behind, which is a test artefact rather than a product fact.
 * A fresh token is a fresh device.
 */
let TOKEN = '';

const DEFINITION = {
  title: 'Household visit',
  defaultLanguage: 'en',
  languages: ['en'],
  groups: [],
  questions: [
    { id: 'q_name', name: 'name', type: 'text', label: { en: 'Household head' } },
    { id: 'q_photo', name: 'photo', type: 'image', label: { en: 'Photograph of the house' } },
  ],
  choiceLists: {},
};

const CAPABILITY = {
  enabled: true,
  maxBytes: 5_000_000,
  scan: 'off' as const,
  unscanned: 'accepted' as const,
  mime: { image: ['image/jpeg'], audio: [], video: [], file: [] },
};

interface Call {
  method: string;
  url: string;
  body: unknown;
}

let container: HTMLDivElement;
let root: Root;
let calls: Call[];
/** What the next authorisation for an upload answers. */
let authoriseMode: 'network-error' | 'ok' | 'refused';
let written: Blob | null;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const count = (predicate: (call: Call) => boolean): number => calls.filter(predicate).length;
const authorisations = (): number => count((call) => call.method === 'POST' && call.url.endsWith('/attachments'));
const uploads = (): number => count((call) => call.method === 'PUT');
const completions = (): number => count((call) => call.method === 'POST' && call.url.endsWith('/complete'));

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  TOKEN = `tok-${Math.random().toString(36).slice(2, 10)}`;
  calls = [];
  written = null;
  authoriseMode = 'ok';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  // jsdom implements no object URLs, so the two the browser would provide for a download
  // are supplied here — and the blob is captured, which is how the test reads the copy.
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: (blob: Blob) => {
      written = blob;
      return 'blob:copy';
    },
  });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: () => undefined });
  // jsdom would otherwise try to navigate to a blob URL and warn about it.
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

  vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });

    if (method === 'PUT') return new Response('', { status: 200 });
    if (method === 'POST' && url.endsWith('/attachments')) {
      if (authoriseMode === 'network-error') throw new TypeError('Failed to fetch');
      if (authoriseMode === 'refused') {
        return json(
          { error: 'type_not_allowed', message: 'That kind of file cannot be attached to this question.' },
          422,
        );
      }
      return json({
        attachmentId: 'att-1',
        uploadUrl: 'https://store.example/put/att-1',
        expiresInSeconds: 300,
        headers: { 'content-type': 'image/jpeg' },
        maxBytes: 5_000_000,
      });
    }
    if (method === 'POST' && url.endsWith('/complete')) {
      return json({
        attachmentId: 'att-1',
        questionId: 'photo',
        filename: 'photo.jpg',
        status: 'uploaded',
        scanStatus: 'skipped',
        sizeBytes: 11,
      });
    }
    if (method === 'PATCH' && url.includes('/responses/')) {
      const sent = (init?.body ? (JSON.parse(String(init.body)) as { answers: Record<string, unknown> }) : { answers: {} })
        .answers;
      return json({ missing: [], invalid: [], answers: sent, conflicts: 0 });
    }
    if (method === 'POST' && url.endsWith('/submit')) return json({ status: 'submitted', conflicts: 0 });
    if (method === 'POST' && url.endsWith('/responses')) {
      return json({ responseId: 'srv-1', created: true, status: 'in_progress' }, 201);
    }
    if (method === 'GET' && url.includes('/responses/')) return json({ responseId: 'srv-1', status: 'in_progress', answers: {} });
    if (method === 'GET' && url.endsWith(`/api/v1/collect/${TOKEN}`)) {
      return json({
        form: { id: 'form-1', title: DEFINITION.title, version: 1, definition: DEFINITION },
        link: { kind: 'anonymous' },
        attachments: CAPABILITY,
      });
    }
    return json({});
  }) as unknown as typeof fetch);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Let the pending promises of a boot or an upload settle. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 4; tick += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(): Promise<void> {
  await act(async () => {
    root.render(<Collect token={TOKEN} />);
  });
  await settle();
}

/** Type into a field the way a keyboard does, through the setter React listens to. */
async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  await act(async () => {
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

/** Hand the file control a file, the way a picker does. */
async function pickFile(name = 'photo.jpg'): Promise<void> {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement | null;
  if (!input) throw new Error('the form rendered no file control');
  const file = new File([new Uint8Array(11)], name, { type: 'image/jpeg' });
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
}

/** The connection coming back, which is the only thing that starts a retry. */
async function reconnect(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new Event('online'));
  });
  await settle();
}

async function saveCopy(): Promise<Record<string, unknown>> {
  const button = [...container.querySelectorAll('button')].find((el) => el.textContent?.trim() === 'Save a copy');
  if (!button) throw new Error('no "Save a copy" button');
  await act(async () => {
    button.click();
  });
  if (!written) throw new Error('no file was written');
  return JSON.parse(await written.text()) as Record<string, unknown>;
}

describe('a file the network dropped', () => {
  it('is held on the device and sent by itself when the connection returns', async () => {
    authoriseMode = 'network-error';
    await mount();

    await pickFile();
    // Nothing was thrown away and nothing pretends to be sent: the page says where the
    // file is, and that it needs no further action from the person holding the phone.
    const held = container.textContent ?? '';
    expect(held).toContain('still held on this device');
    expect(held).toContain('waiting for a connection');
    expect(authorisations()).toBe(1);
    expect(completions()).toBe(0);

    authoriseMode = 'ok';
    await reconnect();

    // One more attempt, this time all the way through.
    expect(authorisations()).toBe(2);
    expect(uploads()).toBe(1);
    expect(completions()).toBe(1);
    expect(container.textContent).toContain('Attached: photo.jpg');
    expect(container.textContent).not.toContain('waiting for a connection');
  });

  it('writes the answer only once the server has accepted the file', async () => {
    authoriseMode = 'network-error';
    await mount();
    await pickFile();
    // Held, and not yet an answer: the draft still has no value for that question.
    const before = (await saveCopy()) as { draft: { answers: Record<string, unknown> } };
    expect(before.draft.answers.photo).toBeUndefined();

    authoriseMode = 'ok';
    await reconnect();

    const after = (await saveCopy()) as { draft: { answers: Record<string, unknown> }; form: { title: string } };
    expect(after.draft.answers.photo).toBe('att-1');
    expect(after.form.title).toBe(DEFINITION.title);
  });
});

describe('a file the server refused', () => {
  it('is not remembered for a retry, because it would be refused again', async () => {
    authoriseMode = 'refused';
    await mount();
    await pickFile();

    const said = container.textContent ?? '';
    // The server's own sentence, not a guess at it, and no promise of a retry.
    expect(said).toContain('That kind of file cannot be attached to this question.');
    expect(said).not.toContain('still held on this device');
    expect(authorisations()).toBe(1);

    await reconnect();
    // A reconnect is not a reason to send the same refused file again.
    expect(authorisations()).toBe(1);
    expect(uploads()).toBe(0);
  });
});

describe('the copy that needs no network', () => {
  it('answers what is on the device, and names the file after the survey', async () => {
    await mount();
    const backup = (await saveCopy()) as {
      format: string;
      token: string;
      draft: { answers: Record<string, unknown>; token: string };
      form: { title: string; version: number };
    };
    expect(backup.format).toBe('inicio.device-copy');
    expect(backup.token).toBe(TOKEN);
    expect(backup.form).toEqual({ title: DEFINITION.title, version: 1 });
    expect(backup.draft.token).toBe(TOKEN);
    expect(container.textContent).toContain('Saved a copy of your answers as inicio-household-visit-');
    expect(container.textContent).toContain('Keep it somewhere other than this device.');
  });
});

describe('a page opened a second time', () => {
  it('finds the answers the device already had, and still sends them', async () => {
    await mount();
    const answerField = (): HTMLInputElement => container.querySelector('input[type="text"]') as HTMLInputElement;
    await typeInto(answerField(), 'Amina');
    expect(answerField().value).toBe('Amina');
    expect(container.textContent).toContain('Saved on this device at');

    // The page is closed and opened again. The draft is the device's, so what comes back
    // is what was typed here rather than whatever the server last knew — the answers that
    // never went up are exactly the ones a reload must not lose.
    await act(() => root.unmount());
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await mount();

    expect(answerField().value).toBe('Amina');
    // And the queue picked it up: the second visit sent the answer rather than showing it.
    const saved = calls.filter((call) => call.method === 'PATCH').at(-1);
    expect((saved?.body as { answers: Record<string, unknown> } | undefined)?.answers.name).toBe('Amina');
  });
});

describe('a device with almost no room left', () => {
  function reportStorage(usage: number, quota: number): void {
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { estimate: async () => ({ usage, quota }) },
    });
  }

  it('says so before it costs anything', async () => {
    reportStorage(96, 100);
    await mount();
    expect(container.textContent).toContain('nearly out of storage space');
    // And it is still a working form: a full device is a warning, not a refusal.
    expect(container.querySelector('input[type="file"]')).not.toBeNull();
  });

  it('stays quiet while there is room', async () => {
    reportStorage(4, 100);
    await mount();
    const said = container.textContent ?? '';
    expect(said).not.toContain('storage space');
    expect(said).not.toContain('running low');
  });
});
