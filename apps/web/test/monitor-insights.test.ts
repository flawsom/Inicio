import { describe, expect, it } from 'vitest';
import { buildMonitorInsights, insightPercent } from '../src/monitor-insights';
import type { MonitorModel, MonitorQuestion } from '../src/monitor-model';

function question(overrides: Partial<MonitorQuestion> = {}): MonitorQuestion {
  return {
    id: 'q1',
    name: 'q1',
    label: 'Which option do you prefer?',
    type: 'select_one',
    groupId: 'main',
    groupLabel: 'Main',
    chart: 'bar',
    answered: 100,
    missing: 0,
    total: 100,
    options: [
      { value: '1', label: 'Alpha', count: 60, percent: 60 },
      { value: '2', label: 'Beta', count: 40, percent: 40 },
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
  const questions = [
    question(),
    question({
      id: 'q2',
      name: 'q2',
      label: 'Which channels do you use?',
      type: 'select_multiple',
      answered: 90,
      missing: 10,
      chart: 'bar',
      options: [
        { value: '1', label: 'Search', count: 70, percent: 77.8 },
        { value: '2', label: 'Social', count: 40, percent: 44.4 },
      ],
    }),
    question({
      id: 'q3',
      name: 'q3',
      label: 'How much would you pay?',
      type: 'integer',
      answered: 20,
      total: 100,
      groupId: 'other',
      groupLabel: 'Other',
      chart: 'histogram',
      options: [],
      numeric: {
        n: 20,
        mean: 50,
        median: 45,
        min: 10,
        max: 90,
        sd: 12,
        q1: 38,
        q3: 62,
        iqr: 24,
        lowFence: 2,
        highFence: 98,
        outliers: 0,
        skew: 0.2,
        bins: [],
      },
    }),
  ];
  return {
    title: 'Signal test',
    defaultLanguage: 'en',
    generatedAt: '2026-11-04T10:00:00.000Z',
    submitted: 100,
    open: 10,
    screenedOut: 2,
    conflicts: 1,
    total: 112,
    completionRate: 100 / 112,
    timeline: [
      { day: '2026-11-01', started: 40, submitted: 20 },
      { day: '2026-11-02', started: 72, submitted: 60 },
    ],
    groups: [
      { id: 'main', label: 'Main', questions: questions.slice(0, 2) },
      { id: 'other', label: 'Other', questions: [questions[2]!] },
    ],
    questions,
    omitted: 2,
    answerable: 3,
    powerBi: {} as MonitorModel['powerBi'],
    ...overrides,
  };
}

describe('the monitor insight model', () => {
  it('draws confidence bands only for single-choice questions with a real base', () => {
    const insights = buildMonitorInsights(model());
    expect(insights.confidenceBands).toHaveLength(1);
    const [band] = insights.confidenceBands;
    expect(band?.name).toBe('q1');
    expect(band?.share).toBe(60);
    expect(band?.interval.low).toBeGreaterThan(50);
    expect(band?.interval.high).toBeLessThan(70);
    expect(band?.intervalWidth).toBeGreaterThan(0);
    expect(band?.topLabel).toBe('Alpha');
    expect(band?.effectiveOptions).toBeGreaterThan(1);
  });

  it('makes the field period cumulative and keeps its observed cadence', () => {
    const insights = buildMonitorInsights(model());
    expect(insights.timeline.map((point) => point.cumulativeSubmitted)).toEqual([20, 80]);
    expect(insights.timeline.map((point) => point.cumulativeStarted)).toEqual([40, 112]);
    expect(insights.activeDays).toBe(2);
    expect(insights.peakDay?.day).toBe('2026-11-02');
    expect(insights.velocity).toBe(40);
  });

  it('reports sectional coverage and the instrument mix without inventing a segment cut', () => {
    const insights = buildMonitorInsights(model());
    expect(insights.coverageGroups.find((group) => group.id === 'main')).toMatchObject({
      questionCount: 2,
      answered: 190,
      possible: 200,
      coverage: 0.95,
    });
    expect(insights.coverageGroups.find((group) => group.id === 'other')?.coverage).toBe(0.2);
    expect(insights.typeMix.find((slice) => slice.type === 'select_one')).toMatchObject({ count: 1, share: 1 / 3 });
    expect(insights.typeMix.find((slice) => slice.type === 'integer')?.count).toBe(1);
    expect(insights.integrityRate).toBeCloseTo(0.99);
    expect(insightPercent(insights.coverageRate)).toBe(`${(insights.coverageRate! * 100).toFixed(1)}%`);
  });

  it('returns honest empty states before the first response', () => {
    const insights = buildMonitorInsights(
      model({
        submitted: 0,
        total: 0,
        open: 0,
        screenedOut: 0,
        conflicts: 0,
        completionRate: null,
        timeline: [],
        questions: [],
        groups: [],
        answerable: 0,
      }),
    );
    expect(insights.confidenceBands).toEqual([]);
    expect(insights.coverageGroups).toEqual([]);
    expect(insights.typeMix).toEqual([]);
    expect(insights.coverageRate).toBeNull();
    expect(insights.integrityRate).toBeNull();
    expect(insights.velocity).toBeNull();
    expect(insights.peakDay).toBeNull();
  });
});
