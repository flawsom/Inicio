// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Landing } from '../src/landing';

/**
 * The landing page, mounted.
 *
 * Two claims are worth a test and neither is visible in a build log: that every
 * figure on the page is the API's rather than the author's, and that the page is
 * complete and readable when the scene cannot be created at all. The instrument is
 * mocked to resolve to null, which is exactly what it does on a device with no
 * WebGL, so this file also holds the fallback path honest.
 */
vi.mock('../src/immersive/instrument', () => ({
  createInstrument: async () => null,
}));

// React only treats `act` as the test environment's flusher when this is set.
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

const SUMMARY = {
  generatedAt: '2026-10-13T10:00:00.000Z',
  database: {
    latencyMs: 4.25,
    serverTime: '2026-10-13T10:00:00.000Z',
    version: '16.2',
    startedAt: '2026-10-13T09:00:00.000Z',
    migrationsApplied: 9,
    latestMigration: '0009_mail.sql',
    listening: true,
  },
  templates: [
    {
      id: 'household',
      title: 'Household roster',
      description: 'A household listing with a repeating group per member.',
      questionCount: 12,
      groupCount: 3,
      languages: ['en', 'fr'],
      questionTypes: ['select_one', 'integer'],
    },
  ],
  engine: {
    questionTypesInUse: ['select_one', 'integer', 'calculate'],
    templateQuestions: 12,
    templateGroups: 3,
  },
};

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

function stubMatchMedia(matches: (query: string) => boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: matches(query),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

class StubObserver {
  root = null;
  rootMargin = '';
  thresholds: number[] = [];
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element): void {
    // Everything is in view immediately: the reveal is decoration, and a test
    // should not have to scroll to see a word.
    this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  stubMatchMedia(() => false);
  globalThis.IntersectionObserver = StubObserver as unknown as typeof IntersectionObserver;
  fetchMock = vi.fn(async () => jsonResponse(SUMMARY));
  vi.stubGlobal('fetch', fetchMock);
  window.history.replaceState({}, '', '/');

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

/** Render, then let the summary request and the scene chunk both settle. */
async function renderLanding(): Promise<void> {
  await act(async () => {
    root.render(<Landing />);
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const text = (): string => container.textContent ?? '';

describe('the landing page', () => {
  it('reads its figures from the API rather than printing its own', async () => {
    await renderLanding();

    const requested = String(fetchMock.mock.calls[0]?.[0]);
    expect(requested.endsWith('/api/v1/public/summary')).toBe(true);

    // The headline is real text, not a canvas.
    expect(text()).toContain('Real logic.');
    expect(text()).toContain('Real collection.');

    // Every live figure is the number the stub API returned.
    expect(text()).toContain('4.3 ms');
    expect(text()).toContain('9');
    expect(text()).toContain('migrations applied, latest 0009_mail.sql');
    expect(text()).toContain('question types the shipped templates actually use');
    expect(text()).toContain('Household roster');
    expect(text()).toContain('12');
    // It says where the numbers came from.
    expect(text()).toContain('GET /api/v1/public/summary');
  });

  it('is complete when the scene cannot be created', async () => {
    await renderLanding();

    const canvas = container.querySelector('canvas');
    expect(canvas).not.toBeNull();
    // Decoration is hidden from assistive technology.
    expect(canvas?.getAttribute('aria-hidden')).toBe('true');
    // The mocked instrument returned null, so the fallback is on screen and the
    // page is still readable underneath it.
    expect(container.querySelector('.lfallback')).not.toBeNull();
    expect(text()).toContain('Real logic.');
  });

  it('shows nothing rather than something old when the API does not answer', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ error: 'unavailable' }, false));
    await renderLanding();

    expect(text()).toContain('the API did not answer');
    expect(text()).toContain('could not be read from the API, so it is not being guessed at');
    // No figure is printed at all: a stale number presented as live is worse than
    // an empty band.
    expect(text()).not.toContain('migrations applied');
    expect(text()).not.toContain('Household roster');
  });

  it('sends a reader who wants in to the sign-in route', async () => {
    await renderLanding();

    const cta = Array.from(container.querySelectorAll('button')).find((button) =>
      (button.textContent ?? '').includes('Sign in with a one-time code'),
    );
    expect(cta).toBeDefined();

    await act(async () => {
      cta?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(window.location.pathname).toBe('/login');
  });

  it('keeps the words apart when the reveal splits a headline into characters', async () => {
    await renderLanding();

    // The reveal gives every character its own box. That box is exactly the two
    // things the sentence cannot survive: it is a line-break opportunity, and a
    // space inside one collapses to no width — which is how the headlines
    // rendered as "Startfromarealinstrument" with words broken mid-letter
    // (`instrumen` / `t`), and how a comma ended up starting a line. No jsdom
    // assertion noticed, because jsdom applies no stylesheet and `textContent`
    // keeps its spaces either way. So the structure the split produces is
    // asserted here, and the two declarations that make it lay out correctly are
    // asserted from the stylesheet — the way this suite already checks anything
    // CSS decides.
    const split = Array.from(container.querySelectorAll<HTMLElement>('[data-split]'));
    expect(split.length).toBeGreaterThan(0);

    for (const element of split) {
      const sentence = element.textContent ?? '';
      const words = Array.from(element.querySelectorAll<HTMLElement>('.lword'));
      const spaces = Array.from(element.querySelectorAll<HTMLElement>('.lchar.lspace'));

      expect(words.length).toBeGreaterThan(0);
      // A word is the unit a line may break at, so a word holds no whitespace and
      // nothing is hidden inside one box.
      for (const word of words) {
        expect(word.textContent ?? '').not.toMatch(/\s/);
        expect(word.children.length).toBe((word.textContent ?? '').length);
      }
      // Every space in the sentence is still there, one piece per space.
      expect(spaces.map((space) => space.textContent).join('')).toBe((sentence.match(/ /g) ?? []).join(''));
      for (const space of spaces) expect(space.textContent).toBe(' ');
    }

    // The headline a reader is meant to read, intact.
    expect(container.querySelector('h1')?.textContent?.trim()).toBe('Real logic.');

    const css = readFileSync(join(__dirname, '..', 'src', 'landing.css'), 'utf8');
    expect(css).toMatch(/\.lword\s*\{[^}]*white-space:\s*nowrap/);
    expect(css).toMatch(/\.lchar\.lspace\s*\{[^}]*white-space:\s*pre/);
  });

  it('splits once, even though the effect runs twice in development', async () => {
    // StrictMode mounts, unmounts and mounts again, so the splitting effect runs
    // twice over markup it has already changed. A second pass is not idempotent:
    // it wraps every existing character box in a word and a box of its own, which
    // is what the browser was rendering as doubled, mis-staggered letters.
    const strictContainer = document.createElement('div');
    document.body.appendChild(strictContainer);
    const strictRoot = createRoot(strictContainer);
    try {
      await act(async () => {
        strictRoot.render(
          <StrictMode>
            <Landing />
          </StrictMode>,
        );
        await Promise.resolve();
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const words = Array.from(strictContainer.querySelectorAll<HTMLElement>('.lword'));
      expect(words.length).toBeGreaterThan(0);
      // No box inside a box: a word holds characters, and a character holds nothing.
      expect(strictContainer.querySelectorAll('.lchar .lchar, .lword .lword, .lchar .lword').length).toBe(0);
      for (const word of words) {
        for (const child of Array.from(word.children)) {
          expect(child.classList.contains('lchar')).toBe(true);
        }
      }
      // And the sentence is still whole.
      expect(strictContainer.querySelector('h1')?.textContent?.trim()).toBe('Real logic.');
    } finally {
      act(() => strictRoot.unmount());
      strictContainer.remove();
    }
  });
});
