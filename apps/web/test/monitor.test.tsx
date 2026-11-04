// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MonitorTab } from '../src/monitor';

/**
 * The monitor is allowed to say "live" only when the form stream is carrying it,
 * and the numbers have to move when the server says the analytics aggregate moved.
 * This is the same contract as the rest of the console, but it is worth pinning
 * here because a dashboard that quietly polls is exactly the failure the user
 * asked us not to ship.
 */

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

interface FakeEvent {
  data: string;
}

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

const formId = 'form-monitor';
const definition = {
  title: 'Dog cushion field test',
  defaultLanguage: 'en',
  languages: ['en'],
  groups: [{ id: 'main', name: 'main', label: { en: 'Reactions' } }],
  choiceLists: {},
  triggers: [],
  questions: [
    {
      id: 'q1',
      name: 'q1',
      type: 'select_one',
      label: { en: 'Which cushion shape?' },
      groupId: 'main',
      choices: {
        inline: [
          { value: 'ortho', label: { en: 'Orthopedic' } },
          { value: 'plush', label: { en: 'Plush' } },
        ],
      },
    },
    {
      id: 'q2',
      name: 'q2',
      type: 'integer',
      label: { en: 'What would you pay?' },
      groupId: 'main',
    },
  ],
};

function analytics(submitted: number, tallies: Array<{ question_id: string; value: unknown; count: number }>, generatedAt: string) {
  return {
    definition,
    publishedVersion: 2,
    byStatus: [
      { status: 'submitted', count: submitted },
      { status: 'in_progress', count: 1 },
    ],
    tallies,
    answered: [...new Set(tallies.map((row) => row.question_id))].map((question_id) => ({
      question_id,
      answered: Math.min(submitted, tallies.filter((row) => row.question_id === question_id).reduce((sum, row) => sum + row.count, 0)),
    })),
    timeline: [{ day: '2026-10-01', started: submitted + 1, submitted }],
    conflicts: 0,
    generatedAt,
  };
}

let container: HTMLDivElement;
let root: Root;
let reads: number;
let latest: ReturnType<typeof analytics>;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  FakeSource.latest = null;
  vi.stubGlobal('EventSource', FakeSource as unknown as typeof EventSource);
  reads = 0;
  latest = analytics(1, [{ question_id: 'q1', value: 'ortho', count: 1 }], '2026-10-01T10:00:00.000Z');
  vi.stubGlobal('fetch', (async () => {
    reads += 1;
    return json(latest);
  }) as unknown as typeof fetch);

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the live monitor', () => {
  it('stays silent while the stream is live, then refetches when analytics moves', async () => {
    await act(async () => {
      root.render(<MonitorTab formId={formId} publishedVersion={2} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();

    expect(reads).toBe(1);
    expect(container.textContent).toContain('Dog cushion field test');
    expect(container.textContent).toContain('Which cushion shape?');
    expect(container.textContent).toContain('The signal room');
    expect(container.textContent).toContain('Confidence bands');
    expect(container.textContent).toContain('How the field is moving');
    expect(container.textContent).toContain('Client analysis brief');
    expect(container.textContent).toContain('The one-page answer');
    expect(container.textContent).toContain('Report plan for this questionnaire');
    expect(container.textContent).toContain('not a .pbix');
    expect([...container.querySelectorAll('.monitor-kpi strong')][0].textContent).toBe('1');
    expect(container.querySelectorAll('.monitor-bar-row')).toHaveLength(1);

    const source = FakeSource.latest;
    expect(source).not.toBeNull();
    await act(async () => {
      source?.emit('ready', {});
    });
    expect(container.textContent).toContain('pushed by the server');

    // A live stream means the fallback interval is not armed. A minute passing is
    // one minute of no queries, not a dashboard quietly polling behind the pill.
    await advance(60_000);
    expect(reads).toBe(1);

    latest = analytics(
      2,
      [
        { question_id: 'q1', value: 'ortho', count: 1 },
        { question_id: 'q1', value: 'plush', count: 1 },
        { question_id: 'q2', value: 1200, count: 1 },
        { question_id: 'q2', value: 1800, count: 1 },
      ],
      '2026-10-01T10:00:02.000Z',
    );
    await act(async () => {
      source?.emit('change', { aggregates: ['analytics'] });
    });
    await advance(32);
    await flush();

    expect(reads).toBe(2);
    expect([...container.querySelectorAll('.monitor-kpi strong')][0].textContent).toBe('2');
    expect([...container.querySelectorAll('.monitor-bar-label')].map((node) => node.textContent)).toEqual([
      'Orthopedic',
      'Plush',
    ]);
  });

  it('says there is nothing to monitor before a version is published', async () => {
    await act(async () => {
      root.render(<MonitorTab formId={formId} publishedVersion={null} />);
      await Promise.resolve();
    });
    await flush();
    expect(container.textContent).toContain('Nothing to monitor yet');
    expect(container.textContent).toContain('Publish a version');
  });
});
