// @vitest-environment jsdom
import axe from 'axe-core';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Landing } from '../src/landing';
import { TermsGate } from '../src/legal';

/**
 * Accessibility, checked by a rule engine rather than by intent.
 *
 * Two surfaces are mounted and audited: the public page, because it is the one a
 * stranger meets first, and the consent gate, because it is the one a person cannot
 * get past. Both are rendered through the real components with the network stubbed,
 * so what is audited is the markup that ships.
 *
 * One rule is switched off, deliberately and with a reason: `color-contrast` cannot
 * run without a renderer to resolve the effective background behind a glyph, so in
 * jsdom it reports "incomplete" and passes regardless. It is not skipped, it is
 * checked elsewhere: `contrast.test.ts` measures every text pair in both themes
 * straight out of the stylesheets, which is a stronger check than axe could make
 * here even with a browser. Everything else runs.
 */
vi.mock('../src/immersive/instrument', () => ({
  createInstrument: async () => null,
}));

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
    questionTypesInUse: ['select_one', 'integer'],
    templateQuestions: 12,
    templateGroups: 3,
  },
};

const TERMS = {
  required: true,
  currentVersion: '2026-01',
  acceptedVersion: null,
  checkboxText: 'I have read and accept the terms of service and the privacy notice.',
  terms: { version: '2026-01', hash: 'a'.repeat(64) },
  privacy: { version: '2026-01', hash: 'b'.repeat(64) },
};

function stubMatchMedia(): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false,
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
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

let container: HTMLDivElement;
let root: Root;
let rendered = false;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  stubMatchMedia();
  globalThis.IntersectionObserver = StubObserver as unknown as typeof IntersectionObserver;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => SUMMARY })),
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  rendered = false;
});

afterEach(() => {
  if (rendered) act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function audit(): Promise<axe.Result[]> {
  const results = await axe.run(container, {
    rules: {
      // See the note at the top of this file: measured in contrast.test.ts instead.
      'color-contrast': { enabled: false },
    },
  });
  return results.violations;
}

function report(violations: axe.Result[]): string {
  return violations
    .map((violation) => `${violation.id} (${violation.impact}): ${violation.help}\n    ${violation.nodes[0]?.html ?? ''}`)
    .join('\n  ');
}

describe('the public page, audited', () => {
  it('has no structural accessibility violations', async () => {
    await act(async () => {
      root.render(<Landing />);
      rendered = true;
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The page rendered something: an audit of an empty div passes for the wrong
    // reason, so the headline is asserted before the rules are.
    expect(container.textContent).toContain('Real logic.');

    const violations = await audit();
    expect(violations.length, `\n  ${report(violations)}\n`).toBe(0);
  });
});

describe('the consent gate, audited', () => {
  it('has no structural accessibility violations', async () => {
    await act(async () => {
      root.render(<TermsGate status={TERMS} onAccepted={() => {}} />);
      rendered = true;
      await Promise.resolve();
    });

    expect(container.textContent).toContain('I have read and accept');

    const violations = await audit();
    expect(violations.length, `\n  ${report(violations)}\n`).toBe(0);
  });

  it('reports a violation when there is one', async () => {
    // The audits above pass, and a check that passes is only worth something if it
    // can fail. This is the negative control: markup with two known, common defects
    // dropped into the same container the real surfaces are audited in.
    const broken = document.createElement('div');
    broken.innerHTML = '<label for="nowhere">Email</label><input id="typo" type="text" /><img src="x.png" />';
    container.appendChild(broken);

    const violations = await audit();
    const ids = violations.map((violation) => violation.id);
    expect(ids).toContain('label');
    expect(ids).toContain('image-alt');
  });
});
