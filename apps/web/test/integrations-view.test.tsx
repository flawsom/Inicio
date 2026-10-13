// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntegrationsView } from '../src/App';

/**
 * The integration screen, through the interface an operator uses it through.
 *
 * Three claims here are the ones worth holding down, because all three are
 * promises the API makes and a screen can quietly break:
 *
 * 1. A secret is shown **once**, in a panel that says so. The server stores only a
 *    hash and cannot return it again, so a screen that let someone come back for it
 *    later would be lying about what the database holds.
 * 2. A scope no route declares cannot be granted. The console was offering
 *    `forms:read` and `responses:read` by default, and a key carrying only those is
 *    a key that can call nothing — so the catalogue's `enforced` flag drives the
 *    controls rather than decorating the list.
 * 3. Hiding a control is a courtesy, not a control: every admin-only action asserted
 *    here as *absent* for a member is independently refused by the API, which is
 *    where that is really tested. This test only proves the screen does not offer
 *    what the caller cannot use.
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

const scopeCatalogue = {
  scopes: [
    { scope: 'forms:read', detail: 'Read forms and their published definitions.', enforced: false },
    { scope: 'flags:read', detail: 'Read the quality-flag queue.', enforced: true },
    { scope: 'flags:write', detail: 'Resolve, dismiss or raise a quality flag.', enforced: true },
  ],
};

const keysBody = {
  keys: [
    {
      id: 'key-1',
      name: 'nightly export',
      prefix: 'ik_ab12cd34',
      scopes: ['flags:read'],
      createdAt: '2026-10-13T08:00:00.000Z',
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
      createdBy: 'owner@example.org',
      active: true,
    },
  ],
};

const endpointsBody = {
  endpoints: [
    {
      id: 'hook-1',
      url: 'https://example.org/hooks/inicio',
      description: 'warehouse',
      events: ['form.published'],
      active: true,
      createdAt: '2026-10-13T08:30:00.000Z',
      lastSuccessAt: null,
      lastFailureAt: null,
      failureCount: 0,
      disabledAt: null,
      reason: null,
      pending: 2,
      failed: 0,
    },
  ],
};

let container: HTMLDivElement;
let root: Root;
let calls: Call[];
/** What the next `Send test` answers. */
let testAnswer: { delivered: boolean; status: number | null; responseBody: string | null; error: string | null };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  calls = [];
  testAnswer = { delivered: false, status: 500, responseBody: 'boom', error: null };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  vi.stubGlobal('fetch', (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });

    if (url.endsWith('/api-scopes')) return json(scopeCatalogue);
    if (url.endsWith('/webhook-events')) return json({ events: [{ event: 'form.published', detail: 'A version was published.' }] });
    if (url.endsWith('/api-keys') && method === 'POST') {
      return json(
        {
          key: { ...keysBody.keys[0], id: 'key-2', name: 'QC pipeline', scopes: ['flags:read'] },
          secret: `ik_${'a'.repeat(64)}`,
        },
        201,
      );
    }
    if (url.includes('/api-keys')) return json(keysBody);
    if (url.includes('/webhooks/') && url.endsWith('/test')) {
      return json({ ...testAnswer, deliveryId: 'd-1' }, 200);
    }
    if (url.includes('/webhooks/') && url.endsWith('/deliveries')) {
      return json({
        deliveries: [
          {
            id: 'd-1',
            event: 'form.published',
            status: 'failed',
            attempts: 5,
            response_status: 500,
            error: 'receiver said no',
            created_at: '2026-10-13T08:31:00.000Z',
            delivered_at: null,
            next_attempt_at: '2026-10-13T09:31:00.000Z',
            payload: {},
          },
        ],
      });
    }
    if (url.includes('/webhooks')) return json(endpointsBody);
    return json({});
  }) as unknown as typeof fetch);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
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

function input(placeholder: string): HTMLInputElement {
  const found = [...container.querySelectorAll('input')].find((el) => el.placeholder === placeholder);
  if (!found) throw new Error(`no input with placeholder "${placeholder}"`);
  return found as HTMLInputElement;
}

async function mount(canAdminister = true): Promise<void> {
  await act(async () => {
    root.render(<IntegrationsView orgId={ORG} canAdminister={canAdminister} />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('the integrations screen', () => {
  it('reads the scope and event catalogues from the server rather than hard-coding them', async () => {
    await mount();
    const urls = calls.filter((c) => c.method === 'GET').map((c) => c.url);
    // The vocabularies come from the API, so the console cannot drift from what the
    // server will accept.
    expect(urls.some((url) => url.endsWith('/api-scopes'))).toBe(true);
    expect(urls.some((url) => url.endsWith('/webhook-events'))).toBe(true);
    expect(urls.some((url) => url.includes(`/orgs/${ORG}/api-keys`))).toBe(true);
    expect(urls.some((url) => url.includes(`/orgs/${ORG}/webhooks`))).toBe(true);

    const text = container.textContent ?? '';
    expect(text).toContain('nightly export');
    expect(text).toContain('ik_ab12cd34');
    expect(text).toContain('2 pending, 0 failed');
  });

  it('offers only the scopes a route enforces, and never offers them to a member', async () => {
    await mount();

    const boxes = [...container.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
    const byLabel = (name: string): HTMLInputElement =>
      boxes.find((box) => box.parentElement?.textContent?.includes(name)) as HTMLInputElement;

    // `flags:read` is declared by a route, so it can be granted — and it is the
    // default selection, because the old default (`forms:read`) produced a key that
    // could call nothing.
    expect(byLabel('flags:read').disabled).toBe(false);
    expect(byLabel('flags:read').checked).toBe(true);
    // No route declares `forms:read` yet, so the control is disabled and says why
    // rather than letting somebody mint a dead credential.
    expect(byLabel('forms:read').disabled).toBe(true);
    expect(container.textContent).toContain('No route declares this scope yet');
    expect(byLabel('forms:read').checked).toBe(false);

    act(() => root.unmount());
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await mount(false);
    expect(hasButton('Create key')).toBe(false);
    expect(hasButton('Revoke')).toBe(false);
    expect(container.textContent).toContain('Only an owner or an admin can issue or revoke a key');
    // The read-only half stays: a member may see where the organisation's data goes.
    expect(hasButton('Deliveries')).toBe(true);
    expect(hasButton('Send test')).toBe(true);
  });

  it('shows a key secret once, in a panel that says so, and never asks for it again', async () => {
    await mount();

    await act(async () => {
      type(input('Name, for example: nightly export'), 'QC pipeline');
      await Promise.resolve();
    });
    await click(button('Create key'));

    const created = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api-keys'));
    expect(created?.body).toEqual({ name: 'QC pipeline', scopes: ['flags:read'] });
    expect(container.textContent).toContain('this is the only time it is shown');
    const secret = `ik_${'a'.repeat(64)}`;
    const shown = [...container.querySelectorAll('input')].filter((el) => el.value === secret);
    expect(shown).toHaveLength(1);
    expect(shown[0]!.readOnly).toBe(true);
    // The list was re-read after the write, and the panel goes away for good when it
    // is dismissed — there is nothing to come back for.
    expect(calls.filter((c) => c.method === 'GET' && c.url.includes('/api-keys')).length).toBe(2);
    await click(button('Done'));
    expect([...container.querySelectorAll('input')].some((el) => el.value === secret)).toBe(false);
  });

  it('will not add an endpoint over plaintext, and reports what a test delivery really got', async () => {
    await mount();

    const url = input('https://example.org/hooks/inicio');
    await act(async () => {
      type(url, 'http://example.org/hooks');
      await Promise.resolve();
    });
    // A signature over plaintext proves nothing, so the control refuses before the
    // request — and the database refuses it too.
    expect(button('Add endpoint').disabled).toBe(true);

    await act(async () => {
      type(url, 'https://example.org/hooks/inicio');
      await Promise.resolve();
    });
    expect(button('Add endpoint').disabled).toBe(false);

    await click(button('Send test'));
    // The receiver's real answer, including a failure status, rather than "sent".
    expect(container.textContent).toContain('Test not delivered');
    expect(container.textContent).toContain('HTTP 500');
  });
});
