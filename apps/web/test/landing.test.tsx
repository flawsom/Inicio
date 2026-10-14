// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Landing } from '../src/landing';
import { BEAT_IDS } from '../src/immersive/choreography';

/**
 * The landing page, mounted.
 *
 * The page is a flight through six beats of the product, and what is worth a test is
 * not the flight itself (a scene needs a GPU) but everything around it: that every
 * figure on the page is the API's rather than the author's, that the hero really is
 * typography with no 3D object in it, that one of the six beats really carries no words
 * at all, and that the page is complete and readable when the scene cannot be created.
 * The instrument is mocked to resolve to null, which is exactly what it does on a device
 * with no WebGL, so this file also holds the fallback path honest.
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

const HEADLINE = 'Real logic. Offline collection. Analysis-ready data.';

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

/**
 * What the reveal was actually handed, not just what it did with it.
 *
 * Revealing whatever it is given makes this stub blind to the defect it should catch:
 * content the observer was never given cannot be revealed by it, and a stub that only
 * ever reports success cannot tell "revealed" from "never observed". Recording the
 * targets is what lets a test ask whether the template rows the API renders, which exist
 * only after the fetch resolves, were handed over at all.
 */
const observed = new Set<Element>();

class StubObserver {
  root = null;
  rootMargin = '';
  thresholds: number[] = [];
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element): void {
    observed.add(target);
    // Everything is in view immediately: the reveal is decoration, and a test should not
    // have to scroll to see a word.
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
  observed.clear();

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
const journey = (): HTMLElement => container.querySelector<HTMLElement>('#landing-journey')!;

describe('the landing page', () => {
  it('reads its figures from the API rather than printing its own', async () => {
    await renderLanding();

    const requested = String(fetchMock.mock.calls[0]?.[0]);
    expect(requested.endsWith('/api/v1/public/summary')).toBe(true);

    // The headline is real text, not a canvas, and it is the product's own tagline.
    expect(text()).toContain(HEADLINE);

    // Every live figure is the number the stub API returned.
    expect(text()).toContain('4.3 ms');
    expect(text()).toContain('9');
    expect(text()).toContain('migrations applied, latest 0009_mail.sql');
    expect(text()).toContain('question types the shipped templates actually use');
    expect(text()).toContain('Household roster');
    expect(text()).toContain('12 questions, 3 groups, 2 languages, 2 question types');
    // It says where the numbers came from.
    expect(text()).toContain('GET /api/v1/public/summary');
  });

  it('opens with typography and no 3D object in the hero', async () => {
    await renderLanding();

    const hero = container.querySelector<HTMLElement>('.lhero');
    expect(hero).not.toBeNull();
    // The scene is one canvas for the whole page, fixed behind it and never inside the
    // hero: the beat the reader meets first is a sentence.
    expect(hero?.querySelector('canvas')).toBeNull();
    const canvas = container.querySelector('canvas');
    expect(canvas).not.toBeNull();
    expect(canvas?.getAttribute('aria-hidden')).toBe('true');
    // The hero comes before the flight.
    expect(hero?.compareDocumentPosition(journey())).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('flies through six beats in order, one of which carries no words at all', async () => {
    await renderLanding();

    const panels = Array.from(journey().children).map((child) => child.id);
    expect(panels).toEqual([...BEAT_IDS]);

    // The corridor is the breathing room between two scenes: no heading, no sentence,
    // nothing for a screen reader either.
    const silent = container.querySelector<HTMLElement>('#flythrough');
    expect(silent).not.toBeNull();
    expect(silent?.textContent).toBe('');
    expect(silent?.querySelector('h1, h2, h3, p')).toBeNull();
    expect(silent?.getAttribute('aria-hidden')).toBe('true');

    // Every other beat says what it is, what it does and how to watch it work.
    for (const id of BEAT_IDS.filter((beat) => beat !== 'flythrough')) {
      const panel = container.querySelector<HTMLElement>(`#${id}`);
      expect((panel?.querySelector('h2')?.textContent ?? '').length, `${id} has no heading`).toBeGreaterThan(0);
      expect(panel?.querySelector('.lwhere'), `${id} has no way to check it`).not.toBeNull();
    }
    expect(container.querySelectorAll('.lwhere').length).toBeGreaterThanOrEqual(6);
    expect(text()).toContain('Where to check it');
  });

  it('reveals the template rows the API renders after the page has mounted', async () => {
    await renderLanding();

    // The rows in this band are the API's: they do not exist when the reveal effect runs,
    // so an observer built there never sees them and they keep the hidden state for good.
    const rows = Array.from(container.querySelectorAll<HTMLElement>('#templates li'));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(observed.has(row), 'the row was never handed to the reveal observer').toBe(true);
      expect(row.classList.contains('in')).toBe(true);
    }

    // And nothing anywhere on the page is left in the hidden state.
    const stillHidden = Array.from(container.querySelectorAll<HTMLElement>('[data-reveal]:not(.in)'));
    expect(stillHidden.map((element) => element.textContent?.slice(0, 40))).toEqual([]);
  });

  it('is complete when the scene cannot be created', async () => {
    await renderLanding();

    // The mocked instrument returned null, so the fallback is on screen and the page is
    // still readable underneath it.
    expect(container.querySelector('.lfallback')).not.toBeNull();
    expect(text()).toContain(HEADLINE);
    for (const id of BEAT_IDS) expect(container.querySelector(`#${id}`)).not.toBeNull();
  });

  it('is complete and still when the reader has asked for no motion', async () => {
    stubMatchMedia(() => true);
    await renderLanding();

    // Reduced motion is a complete path rather than a degraded one: every beat is there,
    // in order, with its text.
    expect(text()).toContain(HEADLINE);
    for (const id of BEAT_IDS.filter((beat) => beat !== 'flythrough')) {
      expect((container.querySelector(`#${id} h2`)?.textContent ?? '').length).toBeGreaterThan(0);
    }
  });

  it('shows nothing rather than something old when the API does not answer', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ error: 'unavailable' }, false));
    await renderLanding();

    expect(text()).toContain('the API did not answer');
    expect(text()).toContain('could not be read from the API, so it is not being guessed at');
    // No figure is printed at all: a stale number presented as live is worse than an
    // empty band.
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

    // The reveal gives every character its own box, and that box is exactly the two
    // things the sentence cannot survive: it is a line-break opportunity, and a space
    // inside one collapses to no width, which is how headlines once rendered as words
    // broken mid-letter. No jsdom assertion notices, because jsdom applies no stylesheet
    // and `textContent` keeps its spaces either way, so the structure the split produces
    // is asserted here and the two declarations that make it lay out are asserted from
    // the stylesheet.
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

    // The sentence a reader is meant to read, intact.
    expect(container.querySelector('h1')?.textContent?.trim()).toBe(HEADLINE);
    // ... and announced as one sentence, because the character boxes would otherwise
    // leave a screen reader reading the words with no spaces between them.
    expect(container.querySelector('h1')?.getAttribute('aria-label')).toBe(HEADLINE);

    const css = readFileSync(join(__dirname, '..', 'src', 'landing.css'), 'utf8');
    expect(css).toMatch(/\.lword\s*\{[^}]*white-space:\s*nowrap/);
    expect(css).toMatch(/\.lchar\.lspace\s*\{[^}]*white-space:\s*pre/);
  });

  it('splits once, even though the effect runs twice in development', async () => {
    // StrictMode mounts, unmounts and mounts again, so the splitting effect runs twice
    // over markup it has already changed. A second pass is not idempotent: it wraps every
    // existing character box in a word and a box of its own, which is what the browser
    // was rendering as doubled, mis-staggered letters.
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
      expect(strictContainer.querySelector('h1')?.textContent?.trim()).toBe(HEADLINE);
    } finally {
      act(() => strictRoot.unmount());
      strictContainer.remove();
    }
  });

  /**
   * This deployment is one organisation's private application, so the public page is not
   * allowed to point at where its source lives, and it is not allowed to point anywhere
   * that is not the deployment itself.
   *
   * Both are asserted rather than trusted to review: a link added to a beat, or a source
   * link pasted into a footer, is exactly the kind of change that reads as harmless in a
   * diff and publishes a private repository's address to everyone who visits the login
   * screen behind it. The rule is the whole page, so the test is the whole page: every
   * anchor, resolved.
   */
  it('links to nothing but this deployment', async () => {
    await renderLanding();

    const anchors = Array.from(container.querySelectorAll('a'));
    expect(anchors.length).toBeGreaterThan(3);
    for (const anchor of anchors) {
      const href = anchor.getAttribute('href') ?? '';
      if (href.startsWith('#')) continue;
      const resolved = new URL(href, window.location.href);
      expect(resolved.origin, `${href} leaves the deployment`).toBe(window.location.origin);
      expect(resolved.pathname, `${href} is a source link`).not.toMatch(/github|gitlab|bitbucket|sourcehut/i);
    }
    // The words that would give it away even without a link.
    expect(text()).not.toMatch(/github|repository|open source|apache/i);
  });

  it('renders no typographic dash a reader can see', async () => {
    await renderLanding();
    // Em dash or en dash: both are the punctuation a generated paragraph reaches for, and
    // this page is written for a reader rather than printed at them.
    expect(text()).not.toMatch(/[\u2014\u2013]/);
  });

  it('says where a claim can be checked in the product, not in a file', async () => {
    await renderLanding();

    const checks = Array.from(container.querySelectorAll('.lwhere'));
    expect(checks.length).toBeGreaterThanOrEqual(6);
    expect(text()).toContain('Where to check it');
    // A path into the source was the thing this line used to hold. (`.sql` is not on the
    // list on purpose: the migration the API reports is named `0009_mail.sql`, and that
    // is a fact about the deployment rather than a path into a checkout.)
    expect(text()).not.toContain('packages/');
    expect(text()).not.toMatch(/\.(ts|tsx|jsx|js)\b/);
  });
});
