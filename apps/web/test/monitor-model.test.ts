import { describe, expect, it } from 'vitest';
import type { Definition, FormAnalytics } from '../src/api';
import {
  buildMonitorModel,
  monitorCsv,
  powerBiPlanJson,
  powerBiPlanSummary,
  questionCsv,
} from '../src/monitor-model';

/**
 * The monitor model is pure, so the claims can be checked without a browser:
 * every answerable field survives, every base size is honest, multi-select is a
 * mention share rather than a respondent share, and the Power BI plan is on the
 * 8 px grid it advertises.
 */

const definition: Definition = {
  title: 'Dog cushion concept test',
  defaultLanguage: 'en',
  languages: ['en'],
  groups: [{ id: 'main', name: 'main', label: { en: 'Product reaction' } }],
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
          { value: '1', label: { en: 'Orthopedic' } },
          { value: '2', label: { en: 'Plush' } },
        ],
      },
    },
    {
      id: 'q2',
      name: 'q2',
      type: 'select_multiple',
      label: { en: 'Which features appeal?' },
      groupId: 'main',
      choices: {
        inline: [
          { value: 'a', label: { en: 'Washable cover' } },
          { value: 'b', label: { en: 'Chew-proof edge' } },
        ],
      },
    },
    { id: 'q3', name: 'q3', type: 'integer', label: { en: 'Expected price' }, groupId: 'main' },
    { id: 'q4', name: 'q4', type: 'date', label: { en: 'Date seen' }, groupId: 'main' },
    { id: 'q5', name: 'q5', type: 'geopoint', label: { en: 'Store location' }, groupId: 'main' },
    {
      id: 'q6',
      name: 'q6',
      type: 'text',
      label: { en: 'What would you change?' },
      groupId: 'main',
      rules: { visibleIf: "${q1} = '1'" },
    },
    { id: 'q7', name: 'q7', type: 'note', label: { en: 'Show card' }, groupId: 'main' },
    { id: 'q8', name: 'q8', type: 'calculate', label: { en: 'Score' }, groupId: 'main' },
  ],
};

const analytics: FormAnalytics = {
  definition,
  publishedVersion: 3,
  byStatus: [
    { status: 'submitted', count: 4 },
    { status: 'in_progress', count: 2 },
    { status: 'screened_out', count: 1 },
  ],
  answered: [
    { question_id: 'q1', answered: 4 },
    { question_id: 'q2', answered: 4 },
    { question_id: 'q3', answered: 4 },
    { question_id: 'q4', answered: 4 },
    { question_id: 'q5', answered: 3 },
    { question_id: 'q6', answered: 3 },
  ],
  tallies: [
    { question_id: 'q1', value: '1', count: 3 },
    { question_id: 'q1', value: '2', count: 1 },
    { question_id: 'q2', value: ['a', 'b'], count: 2 },
    { question_id: 'q2', value: ['a'], count: 1 },
    { question_id: 'q2', value: ['b'], count: 1 },
    { question_id: 'q3', value: 10, count: 1 },
    { question_id: 'q3', value: 20, count: 2 },
    { question_id: 'q3', value: 30, count: 1 },
    { question_id: 'q4', value: '2026-10-01', count: 2 },
    { question_id: 'q4', value: '2026-10-02', count: 2 },
    { question_id: 'q5', value: ['12.97', '77.59'], count: 2 },
    { question_id: 'q5', value: ['12.98', '77.60'], count: 1 },
    { question_id: 'q6', value: 'too soft', count: 2 },
    { question_id: 'q6', value: 'too small', count: 1 },
  ],
  timeline: [
    { day: '2026-10-01', started: 2, submitted: 2 },
    { day: '2026-10-02', started: 2, submitted: 2 },
  ],
  conflicts: 2,
  generatedAt: '2026-10-02T12:00:00.000Z',
};

describe('the live monitor model', () => {
  const model = buildMonitorModel(analytics, 'form-1');

  it('carries every answerable question and names the omitted fields honestly', () => {
    expect(model.title).toBe('Dog cushion concept test');
    expect(model.answerable).toBe(6);
    expect(model.omitted).toBe(2);
    expect(model.questions.map((question) => question.name)).toEqual(['q1', 'q2', 'q3', 'q4', 'q5', 'q6']);
    expect(model.groups).toHaveLength(1);
    expect(model.groups[0].label).toBe('Product reaction');
  });

  it('uses the submitted count as the base and separates a missing answer from a wrong one', () => {
    expect(model.submitted).toBe(4);
    expect(model.open).toBe(2);
    expect(model.total).toBe(7);
    expect(model.completionRate).toBeCloseTo(4 / 7);
    expect(model.conflicts).toBe(2);

    const q1 = model.questions.find((question) => question.name === 'q1')!;
    expect(q1.answered).toBe(4);
    expect(q1.missing).toBe(0);
    expect(q1.options[0]).toMatchObject({ label: 'Orthopedic', count: 3, percent: 75 });

    const q6 = model.questions.find((question) => question.name === 'q6')!;
    expect(q6.answered).toBe(3);
    expect(q6.missing).toBe(1);
    expect(q6.distinct).toBe(2);
    expect(q6.notes.join(' ')).toContain('relevance rule');
  });

  it('uses respondents, not mentions, as the base for a multi-select', () => {
    const q2 = model.questions.find((question) => question.name === 'q2')!;
    expect(q2.answered).toBe(4);
    expect(q2.missing).toBe(0);
    expect(q2.options).toEqual([
      expect.objectContaining({ label: 'Chew-proof edge', count: 3, percent: 75 }),
      expect.objectContaining({ label: 'Washable cover', count: 3, percent: 75 }),
    ]);
    expect(q2.notes.join(' ')).toContain('share of respondents');
    expect(q2.notes.join(' ')).toContain('past 100%');
  });

  it('uses the mean of the two middle answers as an even median', () => {
    const even = buildMonitorModel(
      {
        ...analytics,
        definition: { ...definition, questions: [definition.questions[2]!] },
        answered: [{ question_id: 'q3', answered: 2 }],
        tallies: [
          { question_id: 'q3', value: 10, count: 1 },
          { question_id: 'q3', value: 20, count: 1 },
        ],
      },
      'form-1',
    );
    const q3 = even.questions[0]!;
    expect(q3.numeric?.median).toBe(15);
  });

  it('computes numeric and date charts from the live tallies, not from a seed', () => {
    const q3 = model.questions.find((question) => question.name === 'q3')!;
    expect(q3.numeric).not.toBeNull();
    expect(q3.numeric!.n).toBe(4);
    expect(q3.numeric!.mean).toBe(20);
    expect(q3.numeric!.median).toBe(20);
    expect(q3.numeric!.min).toBe(10);
    expect(q3.numeric!.max).toBe(30);

    const q4 = model.questions.find((question) => question.name === 'q4')!;
    expect(q4.series.map(({ key, count }) => ({ key, count }))).toEqual([
      { key: '2026-10-01', count: 2 },
      { key: '2026-10-02', count: 2 },
    ]);
  });

  it('plots a coordinate question as latitude and longitude without pretending it has a basemap', () => {
    const q5 = model.questions.find((question) => question.name === 'q5')!;
    expect(q5.answered).toBe(3);
    expect(q5.missing).toBe(1);
    expect(q5.points).toHaveLength(2);
    expect(q5.points[0]).toEqual({ lat: 12.97, lon: 77.59, count: 2 });
    expect(q5.points[1]).toEqual({ lat: 12.98, lon: 77.6, count: 1 });
    expect(q5.notes.join(' ')).toContain('without a basemap');
  });

  it('charts a barcode as a value and every vertex of a trace, not as a file or a single point', () => {
    const extraDefinition: Definition = {
      ...definition,
      questions: [
        { id: 'b1', name: 'b1', type: 'barcode', label: { en: 'Scanned code' }, groupId: 'main' },
        { id: 't1', name: 't1', type: 'time', label: { en: 'Visit time' }, groupId: 'main' },
        { id: 'g1', name: 'g1', type: 'geotrace', label: { en: 'Route walked' }, groupId: 'main' },
      ],
    };
    const extra = buildMonitorModel(
      {
        ...analytics,
        definition: extraDefinition,
        answered: [
          { question_id: 'b1', answered: 2 },
          { question_id: 't1', answered: 3 },
          { question_id: 'g1', answered: 1 },
        ],
        tallies: [
          { question_id: 'b1', value: 'SKU-1', count: 2 },
          { question_id: 't1', value: '17:15', count: 2 },
          { question_id: 't1', value: '08:30', count: 1 },
          { question_id: 'g1', value: '12.97 77.59 0 5 12.98 77.60 0 5', count: 1 },
        ],
      },
      'form-1',
    );

    const barcode = extra.questions.find((question) => question.name === 'b1')!;
    expect(barcode.chart).toBe('bar');
    expect(barcode.options).toEqual([expect.objectContaining({ label: 'SKU-1', count: 2, percent: 100 })]);

    const time = extra.questions.find((question) => question.name === 't1')!;
    expect(time.chart).toBe('bar');
    expect(time.options.map((option) => option.value)).toEqual(['08:30', '17:15']);

    const trace = extra.questions.find((question) => question.name === 'g1')!;
    expect(trace.chart).toBe('points');
    expect(trace.points).toEqual([
      { lat: 12.97, lon: 77.59, count: 1 },
      { lat: 12.98, lon: 77.6, count: 1 },
    ]);
    expect(trace.notes.join(' ')).toContain('Every vertex');
  });

  it('exports every question table as CSV without turning an answer into a formula', () => {
    const q1 = model.questions.find((question) => question.name === 'q1')!;
    const one = questionCsv(q1);
    expect(one.split('\r\n')[0]).toContain('question_id,question_name,question_label');
    expect(one).toContain('Which cushion shape?');
    expect(one).toContain('Orthopedic,1,3');
    expect(one).toContain('Plush,2,1');

    const all = monitorCsv(model);
    expect(all).toContain('Which features appeal?');
    expect(all).toContain('Store location');
    expect(all).toContain('coordinate,"12.970000, 77.590000","[12.97,77.59]",2');
    expect(all.split('\r\n').filter(Boolean)).toHaveLength(1 + 2 + 2 + 3 + 2 + 2 + 2);

    const dangerous = buildMonitorModel(
      {
        ...analytics,
        definition: {
          ...definition,
          questions: [
            {
              id: 'q6',
              name: 'q6',
              type: 'text',
              label: { en: 'What would you change?' },
              groupId: 'main',
            },
          ],
        },
        answered: [{ question_id: 'q6', answered: 1 }],
        tallies: [{ question_id: 'q6', value: '=SUM(1,2)', count: 1 }],
      },
      'form-1',
    );
    expect(monitorCsv(dangerous)).toContain("'=SUM(1,2)");
  });

  it('builds a deterministic Power BI plan on the advertised grid', () => {
    const plan = model.powerBi;
    expect(plan.pages.map((page) => page.name)).toEqual(['Overview', 'Questions']);
    expect(plan.canvas).toEqual({ width: 1280, height: 720, grid: 8 });
    expect(plan.visualCount).toBe(plan.pages.reduce((sum, page) => sum + page.visuals.length, 0));
    expect(plan.measures.map((measure) => measure.name)).toContain('Completion Rate');
    expect(plan.theme.dataColors[0]).toBe('#ea580c');
    expect(plan.source.endpoint).toBe('/api/v1/forms/form-1/analytics');
    expect(plan.limitations.join(' ')).toContain('not a .pbix');
    expect(plan.limitations.join(' ')).toContain('Power BI Desktop');

    for (const page of plan.pages) {
      for (const visual of page.visuals) {
        expect(visual.x % 8, `${visual.id} x`).toBe(0);
        expect(visual.y % 8, `${visual.id} y`).toBe(0);
        expect(visual.width % 8, `${visual.id} width`).toBe(0);
        expect(visual.height % 8, `${visual.id} height`).toBe(0);
      }
    }

    expect(JSON.parse(powerBiPlanJson(model)).form.title).toBe('Dog cushion concept test');
    expect(powerBiPlanSummary(plan)).toContain('2 pages');
  });

  it('stays empty rather than inventing a questionnaire before a version is published', () => {
    const empty = buildMonitorModel(
      {
        definition: null,
        publishedVersion: null,
        byStatus: [],
        tallies: [],
        answered: [],
        timeline: [],
        conflicts: 0,
        generatedAt: '2026-10-02T12:00:00.000Z',
      },
      'form-2',
    );
    expect(empty.questions).toEqual([]);
    expect(empty.powerBi.pages).toEqual([]);
    expect(empty.completionRate).toBeNull();
  });
});
