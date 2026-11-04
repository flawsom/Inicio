import { describe, expect, it } from 'vitest';
import {
  analysisBriefMarkdown,
  buildAnalysisBrief,
  samplingRange,
  wilsonInterval,
} from '../src/analysis-model';
import type { MonitorModel, MonitorQuestion } from '../src/monitor-model';

function question(overrides: Partial<MonitorQuestion> = {}): MonitorQuestion {
  return {
    id: 'q1',
    name: 'q1',
    label: 'Which city do you ride in?',
    type: 'select_one',
    groupId: null,
    groupLabel: 'Questions',
    chart: 'bar',
    answered: 10,
    missing: 0,
    total: 10,
    options: [
      { value: '1', label: 'Bengaluru', count: 6, percent: 60 },
      { value: '2', label: 'Delhi NCR', count: 4, percent: 40 },
    ],
    numeric: null,
    series: [],
    points: [],
    distinct: 2,
    notes: [],
    ...overrides,
  };
}

function model(overrides: Partial<MonitorModel> = {}): MonitorModel {
  return {
    title: 'Bounce rider survey',
    defaultLanguage: 'en',
    generatedAt: '2026-11-02T03:59:00.000Z',
    submitted: 10,
    open: 0,
    screenedOut: 0,
    conflicts: 0,
    total: 10,
    completionRate: 1,
    timeline: [],
    groups: [],
    questions: [question()],
    omitted: 0,
    answerable: 1,
    powerBi: {} as MonitorModel['powerBi'],
    ...overrides,
  };
}

describe('the client analysis brief', () => {
  it('states a share with its base and a Wilson range instead of inventing a benchmark', () => {
    const interval = wilsonInterval(6, 10);
    expect(interval).not.toBeNull();
    expect(interval!.low).toBeGreaterThan(20);
    expect(interval!.high).toBeLessThan(90);

    const brief = buildAnalysisBrief(model(), { client: 'Bounce' });
    expect(brief.client).toBe('Bounce');
    expect(brief.findings.length).toBeGreaterThan(0);
    expect(brief.findings[0]?.plain).toContain('6 of 10');
    expect(brief.findings[0]?.plain).toContain('60.0%');
    expect(brief.findings[0]?.method).toContain('Wilson');
    expect(brief.limits.join(' ')).toContain('cannot cross-tabulate');
  });

  it('does not manufacture a finding when there are no submitted answers', () => {
    const brief = buildAnalysisBrief(model({ submitted: 0, total: 0, completionRate: null, questions: [] }));
    expect(brief.readiness.label).toBe('No data');
    expect(brief.findings).toEqual([]);
    expect(brief.bottomLine).toContain('No submitted answers yet');
  });

  it('exports a readable brief with its method, limits and next questions', () => {
    const brief = buildAnalysisBrief(model(), { client: 'Bounce' });
    const markdown = analysisBriefMarkdown(brief);
    expect(markdown).toContain('Prepared for **Bounce**');
    expect(markdown).toContain('Show the working');
    expect(markdown).toContain('What this brief cannot tell you');
    expect(markdown).toContain('Questions to ask next');
  });

  it('reports the worst-case sampling range for a base, not a fake precision', () => {
    expect(samplingRange(10)).toBeGreaterThan(10);
    expect(samplingRange(1000)).toBeLessThan(samplingRange(10)!);
    expect(samplingRange(0)).toBeNull();
  });
});
