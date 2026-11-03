import type { Definition, DefinitionQuestion, FormAnalytics } from './api';

/**
 * The monitoring model.
 *
 * This is deliberately a pure function over the analytics response. The server
 * already computes the tallies from the live tables on every request, so this file
 * does not fetch, cache or invent a number. It turns those counts into the shape a
 * monitor needs: one entry per answerable question, a base size for every chart,
 * and a Power BI report plan that names the visual, the field and the measure.
 *
 * The chart planner is strict about what it can say. A question with no answers is
 * still present, with a zero base and an empty chart, rather than disappearing from
 * the screen. A note or calculate is not answerable and is counted as omitted. Every
 * percentage is a respondent share, including a multi-select's, where the shares can
 * add past 100% and the model says so.
 */

export type MonitorChart = 'bar' | 'histogram' | 'line' | 'points' | 'count';

export interface MonitorOption {
  value: string;
  label: string;
  count: number;
  /** Percentage of respondents who gave this answer. Multi-select shares can exceed 100%. */
  percent: number;
}

export interface MonitorBin {
  from: number;
  to: number;
  count: number;
}

export interface MonitorNumeric {
  n: number;
  mean: number;
  median: number;
  min: number;
  max: number;
  bins: MonitorBin[];
}

export interface MonitorSeriesPoint {
  key: string;
  label: string;
  count: number;
}

export interface MonitorGeoPoint {
  lat: number;
  lon: number;
  /** Responses at this coordinate, so overlapping points are not silently dropped. */
  count: number;
}

export interface MonitorQuestion {
  id: string;
  name: string;
  label: string;
  type: string;
  groupId: string | null;
  groupLabel: string;
  chart: MonitorChart;
  answered: number;
  missing: number;
  total: number;
  options: MonitorOption[];
  numeric: MonitorNumeric | null;
  series: MonitorSeriesPoint[];
  points: MonitorGeoPoint[];
  distinct: number;
  notes: string[];
}

export interface MonitorGroup {
  id: string;
  label: string;
  questions: MonitorQuestion[];
}

export interface MonitorModel {
  title: string;
  defaultLanguage: string;
  generatedAt: string;
  submitted: number;
  open: number;
  screenedOut: number;
  conflicts: number;
  total: number;
  completionRate: number | null;
  timeline: FormAnalytics['timeline'];
  groups: MonitorGroup[];
  questions: MonitorQuestion[];
  omitted: number;
  answerable: number;
  powerBi: PowerBiPlan;
}

export interface PowerBiVisual {
  id: string;
  page: string;
  visualType: string;
  title: string;
  question?: string;
  field?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  roles: string[];
  note?: string;
}

export interface PowerBiPage {
  name: string;
  displayName: string;
  width: 1280;
  height: 720;
  visuals: PowerBiVisual[];
}

export interface PowerBiMeasure {
  name: string;
  expression: string;
  formatString?: string;
  description: string;
}

export interface PowerBiTheme {
  name: string;
  dataColors: string[];
  background: string;
  foreground: string;
  tableAccent: string;
  good: string;
  neutral: string;
  bad: string;
  textClasses: Record<string, { fontFace: string; fontSize: number; color: string }>;
}

export interface PowerBiPlan {
  schemaVersion: 1;
  generatedAt: string;
  form: { title: string; defaultLanguage: string };
  source: {
    kind: 'inicio-live-analytics';
    endpoint: string;
    transport: 'server-sent-events';
    revisionTickMs: number;
  };
  canvas: { width: 1280; height: 720; grid: 8 };
  theme: PowerBiTheme;
  measures: PowerBiMeasure[];
  pages: PowerBiPage[];
  visualCount: number;
  limitations: string[];
}

const NUMERIC_TYPES = new Set(['integer', 'decimal', 'percentage', 'currency']);
const DATE_TYPES = new Set(['date', 'datetime']);
const GEO_TYPES = new Set(['geopoint', 'geotrace', 'geoshape']);
const MEDIA_TYPES = new Set(['image', 'audio', 'video', 'file']);
const MULTI_TYPES = new Set(['select_multiple', 'rank']);
const DISPLAY_TYPES = new Set(['note', 'calculate']);

function languageOf(definition: Definition): string {
  return definition.defaultLanguage || 'en';
}

function textOf(value: Record<string, string> | undefined, language: string): string {
  return value?.[language] ?? value?.en ?? '';
}

function labelOf(definition: Definition, question: DefinitionQuestion): string {
  return textOf(question.label, languageOf(definition)) || question.name;
}

function hasAnswer(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

function valuesOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

function choiceLabel(definition: Definition, question: DefinitionQuestion, value: unknown): string {
  const code = String(value);
  const choices = question.choices?.inline ?? (question.choices?.listName ? definition.choiceLists[question.choices.listName] : undefined);
  const found = choices?.find((choice) => choice.value === code);
  return found ? textOf(found.label, languageOf(definition)) || code : code;
}

function weightedMedian(entries: Array<{ value: number; count: number }>): number {
  const sorted = [...entries].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((sum, entry) => sum + entry.count, 0);
  if (total === 0) return 0;
  const valueAt = (rank: number): number => {
    let seen = 0;
    for (const entry of sorted) {
      seen += entry.count;
      if (seen >= rank) return entry.value;
    }
    return sorted.at(-1)?.value ?? 0;
  };
  // An even number of answers has two middle values, and a median is their mean.
  // Returning the lower one would be a defensible weighted-median convention, but
  // it is not the median a researcher reading the card expects.
  if (total % 2 === 0) return (valueAt(total / 2) + valueAt(total / 2 + 1)) / 2;
  return valueAt((total + 1) / 2);
}

function numericStats(entries: Array<{ value: number; count: number }>): MonitorNumeric | null {
  if (entries.length === 0) return null;
  const n = entries.reduce((sum, entry) => sum + entry.count, 0);
  if (n === 0) return null;
  const weighted = entries.reduce((sum, entry) => sum + entry.value * entry.count, 0);
  const values = entries.map((entry) => entry.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const binCount = Math.min(6, Math.max(1, new Set(values).size));
  const width = max === min ? 0 : (max - min) / binCount;
  const bins: MonitorBin[] = Array.from({ length: binCount }, (_, index) => ({
    from: min + width * index,
    to: index === binCount - 1 ? max : min + width * (index + 1),
    count: 0,
  }));
  for (const entry of entries) {
    const index = width === 0 ? 0 : Math.min(binCount - 1, Math.floor((entry.value - min) / width));
    bins[index].count += entry.count;
  }
  return { n, mean: weighted / n, median: weightedMedian(entries), min, max, bins };
}

function parseDate(value: unknown): Date | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function dayKey(value: unknown): string | null {
  const parsed = parseDate(value);
  if (!parsed) return null;
  return parsed.toISOString().slice(0, 10);
}

function pointOf(value: unknown): MonitorGeoPoint | null {
  const parts = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.trim().split(/[\s,]+/)
      : [];
  if (parts.length < 2) return null;
  const lat = Number(parts[0]);
  const lon = Number(parts[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon, count: 1 };
}

function geoPoints(value: unknown): MonitorGeoPoint[] {
  if (Array.isArray(value)) {
    // ODK can store a trace as a flat numeric list of lat, lon, altitude,
    // accuracy groups. More than one group is a trace, not a point with an
    // unusually long accuracy column.
    if (
      value.length > 4 &&
      value.length % 4 === 0 &&
      value.every((entry) => Number.isFinite(Number(entry)))
    ) {
      const points: MonitorGeoPoint[] = [];
      for (let index = 0; index < value.length; index += 4) {
        const point = pointOf([value[index], value[index + 1]]);
        if (point) points.push(point);
      }
      return points;
    }
    // A coordinate pair can be stored as an array of strings ("12.97", "77.59")
    // or as an array of arrays. A direct pair wins; anything else is a trace.
    const direct = pointOf(value);
    if (direct) return [direct];
    return value.flatMap((entry) => geoPoints(entry));
  }
  if (typeof value !== 'string') return [];
  const tokens = value.trim().split(/[\s,]+/).filter(Boolean);
  if (tokens.length < 2) return [];
  // ODK stores a point as "lat lon alt accuracy" and a trace or shape as the
  // same four-token group repeated. Every vertex is part of the answer, not just
  // the first one, so plot all of them.
  const points: MonitorGeoPoint[] = [];
  const stride = tokens.length % 4 === 0 ? 4 : 2;
  for (let index = 0; index + 1 < tokens.length; index += stride) {
    const point = pointOf([tokens[index], tokens[index + 1]]);
    if (point) points.push(point);
  }
  return points;
}

function timeLabel(day: string): string {
  const parsed = new Date(`${day}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime())
    ? day
    : parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function buildQuestion(
  definition: Definition,
  question: DefinitionQuestion,
  tallies: FormAnalytics['tallies'],
  submitted: number,
  answered: number,
  groupLabel: string,
): MonitorQuestion {
  const own = tallies.filter((row) => row.question_id === question.name && hasAnswer(row.value));
  const missing = Math.max(0, submitted - Math.min(answered, submitted));
  const notes: string[] = [];
  if (question.rules?.visibleIf) {
    notes.push('Missing includes submissions where the relevance rule did not ask this question.');
  }
  const chart: MonitorChart = NUMERIC_TYPES.has(question.type)
    ? 'histogram'
    : DATE_TYPES.has(question.type)
      ? 'line'
      : GEO_TYPES.has(question.type)
        ? 'points'
        : MEDIA_TYPES.has(question.type)
          ? 'count'
          : 'bar';

  let numeric: MonitorNumeric | null = null;
  let series: MonitorSeriesPoint[] = [];
  let points: MonitorGeoPoint[] = [];
  let options: MonitorOption[] = [];
  let distinct = 0;

  if (chart === 'histogram') {
    const entries = own.flatMap((row) => {
      const value = Number(row.value);
      return Number.isFinite(value) ? [{ value, count: row.count }] : [];
    });
    numeric = numericStats(entries);
    if (numeric) {
      notes.push(`Mean ${numeric.mean.toFixed(2)}, median ${numeric.median.toFixed(2)} across ${numeric.n} answers.`);
    }
  } else if (chart === 'line') {
    const byDay = new Map<string, number>();
    for (const row of own) {
      for (const value of valuesOf(row.value)) {
        const key = dayKey(value);
        if (key) byDay.set(key, (byDay.get(key) ?? 0) + row.count);
      }
    }
    series = [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, count]) => ({ key, label: timeLabel(key), count }));
    if (series.length > 30) notes.push('The chart shows the most recent 30 days; the table retains every day.');
  } else if (chart === 'points') {
    const byPoint = new Map<string, MonitorGeoPoint>();
    for (const row of own) {
      // A trace can cross or return to the same vertex. Count a response once
      // per coordinate, not once per visit.
      const seenInResponse = new Set<string>();
      for (const point of geoPoints(row.value)) {
        const key = `${point.lat},${point.lon}`;
        if (seenInResponse.has(key)) continue;
        seenInResponse.add(key);
        const existing = byPoint.get(key);
        if (existing) existing.count += row.count;
        else byPoint.set(key, { ...point, count: row.count });
      }
    }
    points = [...byPoint.values()].sort((a, b) => b.count - a.count || a.lat - b.lat || a.lon - b.lon);
    if (points.length > 0) {
      notes.push('Coordinates are plotted without a basemap: latitude and longitude only.');
      notes.push('Every vertex of a trace or shape is plotted; a point count is the number of responses that include it.');
    }
  } else if (chart === 'count') {
    notes.push(`${answered} response${answered === 1 ? '' : 's'} attached a file, image, audio or video.`);
  } else {
    const byValue = new Map<string, number>();
    for (const row of own) {
      for (const value of valuesOf(row.value)) {
        const code = String(value);
        byValue.set(code, (byValue.get(code) ?? 0) + row.count);
      }
    }
    distinct = byValue.size;
    options = [...byValue.entries()]
      .map(([value, count]) => ({
        value,
        label: choiceLabel(definition, question, value),
        count,
        percent: answered > 0 ? (count / answered) * 100 : 0,
      }))
      .sort((a, b) => {
        // A clock time reads chronologically; a category reads by frequency.
        if (question.type === 'time') return a.value.localeCompare(b.value);
        return b.count - a.count || a.label.localeCompare(b.label);
      });
    if (MULTI_TYPES.has(question.type)) {
      notes.push('Each bar is the share of respondents who selected that option; the shares can add past 100%.');
    }
    if (question.type === 'text' || question.type === 'textarea') {
      notes.push(`${distinct} distinct answer${distinct === 1 ? '' : 's'} in the top-value view.`);
    }
  }

  return {
    id: question.id,
    name: question.name,
    label: labelOf(definition, question),
    type: question.type,
    groupId: question.groupId ?? null,
    groupLabel,
    chart,
    answered,
    missing,
    total: submitted,
    options,
    numeric,
    series,
    points,
    distinct,
    notes,
  };
}

function theme(): PowerBiTheme {
  return {
    name: 'Inicio Live Monitor',
    // Every data colour is at least 3:1 on white, so a category is never lost
    // to the background. The peach is reserved for the dark product surface and
    // is not a chart colour here.
    dataColors: ['#ea580c', '#0f766e', '#b45309', '#15803d', '#4b5563', '#7c2d12', '#111827', '#78716c'],
    background: '#ffffff',
    foreground: '#111827',
    tableAccent: '#ea580c',
    good: '#15803d',
    neutral: '#b45309',
    bad: '#b91c1c',
    textClasses: {
      callout: { fontFace: 'Archivo', fontSize: 40, color: '#111827' },
      title: { fontFace: 'Archivo', fontSize: 14, color: '#111827' },
      header: { fontFace: 'Archivo', fontSize: 12, color: '#111827' },
      label: { fontFace: 'Archivo', fontSize: 10, color: '#4b5563' },
    },
  };
}

function measures(): PowerBiMeasure[] {
  return [
    {
      name: 'Responses Started',
      expression: "COUNTROWS('Responses')",
      formatString: '#,0',
      description: 'Every response that exists, including partial interviews.',
    },
    {
      name: 'Responses Submitted',
      expression: "CALCULATE(COUNTROWS('Responses'), 'Responses'[Status] = \"submitted\")",
      formatString: '#,0',
      description: 'Completed responses. Every question chart uses this as its base.',
    },
    {
      name: 'Completion Rate',
      expression: 'DIVIDE([Responses Submitted], [Responses Started])',
      formatString: '0.0%',
      description: 'Submitted responses divided by started responses, with BLANK when nothing started.',
    },
    {
      name: 'Open Responses',
      expression: "CALCULATE(COUNTROWS('Responses'), 'Responses'[Status] = \"in_progress\")",
      formatString: '#,0',
      description: 'Partial interviews still in progress.',
    },
    {
      name: 'Median Completion (minutes)',
      expression:
        "DIVIDE(MEDIANX(FILTER('Responses', 'Responses'[Status] = \"submitted\"), DATEDIFF('Responses'[Started At], 'Responses'[Submitted At], SECOND)), 60)",
      formatString: '#,0.0',
      description: 'Median elapsed time from start to submit for completed responses.',
    },
    {
      name: 'Sync Conflicts',
      expression: "CALCULATE(COUNTROWS('Responses'), 'Responses'[Conflict Count] > 0)",
      formatString: '#,0',
      description: 'Responses where a device and the server disagreed about at least one answer.',
    },
  ];
}

function visualType(chart: MonitorChart): string {
  switch (chart) {
    case 'histogram':
      return 'columnChart';
    case 'line':
      return 'lineChart';
    case 'points':
      return 'map';
    case 'count':
      return 'card';
    default:
      return 'clusteredBarChart';
  }
}

function roleFor(chart: MonitorChart): string[] {
  switch (chart) {
    case 'histogram':
      return ['Value', 'Count'];
    case 'line':
      return ['Date', 'Count'];
    case 'points':
      return ['Latitude', 'Longitude'];
    case 'count':
      return ['Value'];
    default:
      return ['Category', 'Count'];
  }
}

/**
 * The report plan is a specification, not a PBIX. It is generated deterministically
 * so a reviewer can diff it, and every visual sits on the 8 px grid the theme and
 * desktop layout use.
 */
export function buildPowerBiPlan(model: MonitorModel, formId: string): PowerBiPlan {
  const pages: PowerBiPage[] = [];
  const overviewVisuals: PowerBiVisual[] = [
    {
      id: 'title',
      page: 'Overview',
      visualType: 'textbox',
      title: model.title,
      x: 24,
      y: 24,
      width: 1232,
      height: 56,
      roles: [],
      note: 'Page title. The subtitle carries the data-as-of time and the form name.',
    },
    ...[
      { key: 'submitted', title: 'Submitted', value: String(model.submitted) },
      { key: 'open', title: 'Open', value: String(model.open) },
      { key: 'completion', title: 'Completion rate', value: model.completionRate === null ? 'No starts' : `${(model.completionRate * 100).toFixed(1)}%` },
      { key: 'conflicts', title: 'Sync conflicts', value: String(model.conflicts) },
    ].map((item, index) => ({
      id: `kpi-${item.key}`,
      page: 'Overview',
      visualType: 'card',
      title: item.title,
      field: item.key,
      x: 24 + index * 312,
      y: 96,
      width: 296,
      height: 112,
      roles: ['Value'],
      note: `Live value at plan generation: ${item.value}.`,
    })),
    {
      id: 'activity',
      page: 'Overview',
      visualType: 'lineChart',
      title: 'Responses over the field period',
      field: 'timeline',
      x: 24,
      y: 224,
      width: 1232,
      height: 248,
      roles: ['Date', 'Started', 'Submitted'],
      note: 'Two lines. The y-axis starts at zero; the x-axis is one point per day.',
    },
    {
      id: 'coverage',
      page: 'Overview',
      visualType: 'tableEx',
      title: 'Question coverage',
      field: 'questions',
      x: 24,
      y: 488,
      width: 608,
      height: 208,
      roles: ['Question', 'Type', 'Answered', 'Missing'],
      note: `${model.answerable} answerable question(s), ${model.omitted} display or calculated field(s) omitted.`,
    },
    {
      id: 'freshness',
      page: 'Overview',
      visualType: 'textbox',
      title: 'Data freshness',
      x: 648,
      y: 488,
      width: 608,
      height: 208,
      roles: [],
      note: `Snapshot generated at ${model.generatedAt}. The Inicio monitor is pushed by SSE; a published Power BI report needs a Fabric refresh or a push dataset.`,
    },
  ];
  pages.push({ name: 'Overview', displayName: 'Overview', width: 1280, height: 720, visuals: overviewVisuals });

  const pageSize = 6;
  for (let offset = 0; offset < model.questions.length; offset += pageSize) {
    const pageName = offset === 0 ? 'Questions' : `Questions ${offset / pageSize + 1}`;
    const displayName = offset === 0 ? 'Question detail' : `Question detail ${offset / pageSize + 1}`;
    const visuals: PowerBiVisual[] = [
      {
        id: `${pageName}-title`,
        page: pageName,
        visualType: 'textbox',
        title: displayName,
        x: 24,
        y: 24,
        width: 1232,
        height: 56,
        roles: [],
      },
    ];
    for (let index = 0; index < pageSize; index += 1) {
      const question = model.questions[offset + index];
      if (!question) break;
      const column = index % 2;
      const row = Math.floor(index / 2);
      visuals.push({
        id: `q-${question.id}`,
        page: pageName,
        visualType: visualType(question.chart),
        title: question.label,
        question: question.name,
        field: question.name,
        x: 24 + column * 624,
        y: 96 + row * 200,
        width: 608,
        height: 184,
        roles: roleFor(question.chart),
        note: `${question.answered} answered, ${question.missing} missing. ${question.notes.join(' ')}`.trim(),
      });
    }
    pages.push({ name: pageName, displayName, width: 1280, height: 720, visuals });
  }

  return {
    schemaVersion: 1,
    generatedAt: model.generatedAt,
    form: { title: model.title, defaultLanguage: model.defaultLanguage },
    source: {
      kind: 'inicio-live-analytics',
      endpoint: `/api/v1/forms/${formId}/analytics`,
      transport: 'server-sent-events',
      revisionTickMs: 1500,
    },
    canvas: { width: 1280, height: 720, grid: 8 },
    theme: theme(),
    measures: measures(),
    pages,
    visualCount: pages.reduce((sum, page) => sum + page.visuals.length, 0),
    limitations: [
      'This is a deterministic report specification, not a .pbix binary.',
      'Microsoft does not support creating or converting a model-bearing .pbix programmatically outside Power BI Desktop. Report-only PBIX/PBIT compilation is possible, but a full PBIX still needs Desktop or Fabric.',
      'The Inicio monitor is live. A Power BI report built from this plan is live only after it is connected to a push dataset or refreshed from the published data source.',
    ],
  };
}

export function buildMonitorModel(analytics: FormAnalytics, formId: string): MonitorModel {
  const definition = analytics.definition;
  if (!definition) {
    return {
      title: 'Live monitor',
      defaultLanguage: 'en',
      generatedAt: analytics.generatedAt,
      submitted: 0,
      open: 0,
      screenedOut: 0,
      conflicts: analytics.conflicts,
      total: 0,
      completionRate: null,
      timeline: analytics.timeline,
      groups: [],
      questions: [],
      omitted: 0,
      answerable: 0,
      powerBi: {
        schemaVersion: 1,
        generatedAt: analytics.generatedAt,
        form: { title: 'Live monitor', defaultLanguage: 'en' },
        source: {
          kind: 'inicio-live-analytics',
          endpoint: `/api/v1/forms/${formId}/analytics`,
          transport: 'server-sent-events',
          revisionTickMs: 1500,
        },
        canvas: { width: 1280, height: 720, grid: 8 },
        theme: theme(),
        measures: measures(),
        pages: [],
        visualCount: 0,
        limitations: [
          'No published version is available, so there is no questionnaire to plan.',
          'Microsoft does not support creating a model-bearing .pbix programmatically outside Power BI Desktop.',
        ],
      },
    };
  }

  const byStatus = new Map(analytics.byStatus.map((row) => [row.status, row.count]));
  const submitted = byStatus.get('submitted') ?? 0;
  const total = [...byStatus.values()].reduce((sum, count) => sum + count, 0);
  const groupsById = new Map(definition.groups.map((group) => [group.id, group]));
  const questions: MonitorQuestion[] = [];
  const answeredByQuestion = new Map(analytics.answered.map((row) => [row.question_id, row.answered]));
  let omitted = 0;

  for (const question of definition.questions) {
    if (DISPLAY_TYPES.has(question.type) || question.rules?.calculate) {
      omitted += 1;
      continue;
    }
    const group = question.groupId ? groupsById.get(question.groupId) : undefined;
    const groupLabel = group ? textOf(group.label, languageOf(definition)) || group.name : 'Questions';
    questions.push(
      buildQuestion(definition, question, analytics.tallies, submitted, answeredByQuestion.get(question.name) ?? 0, groupLabel),
    );
  }

  const groups: MonitorGroup[] = [];
  for (const question of questions) {
    const id = question.groupId ?? '__ungrouped';
    const existing = groups.find((group) => group.id === id);
    if (existing) {
      existing.questions.push(question);
    } else {
      groups.push({ id, label: question.groupLabel, questions: [question] });
    }
  }

  const model: MonitorModel = {
    title: definition.title,
    defaultLanguage: languageOf(definition),
    generatedAt: analytics.generatedAt,
    submitted,
    open: byStatus.get('in_progress') ?? 0,
    screenedOut: byStatus.get('screened_out') ?? 0,
    conflicts: analytics.conflicts,
    total,
    completionRate: total > 0 ? submitted / total : null,
    timeline: analytics.timeline,
    groups,
    questions,
    omitted,
    answerable: questions.length,
    powerBi: {} as PowerBiPlan,
  };
  model.powerBi = buildPowerBiPlan(model, formId);
  return model;
}

export function powerBiPlanJson(model: MonitorModel): string {
  return `${JSON.stringify(model.powerBi, null, 2)}\n`;
}

/** A short, stable sentence for the monitor header and the report-plan card. */
export function powerBiPlanSummary(plan: PowerBiPlan): string {
  return `${plan.pages.length} page${plan.pages.length === 1 ? '' : 's'} · ${plan.visualCount} visual${plan.visualCount === 1 ? '' : 's'} · ${plan.measures.length} measures · ${plan.canvas.width}×${plan.canvas.height}`;
}

/**
 * The monitor tables as CSV, for the person who needs the numbers beside the chart.
 *
 * The shape is deliberately one row per plotted value rather than a header block
 * followed by a table: a reader can open it in a spreadsheet, filter one question,
 * and still know its base, its missing count and its share denominator. Every
 * question is included, including one with nothing plotted yet.
 *
 * A cell that begins with a formula marker is prefixed with an apostrophe. A
 * respondent can type `=HYPERLINK(...)` into a text field, and exporting the
 * monitor must not turn that answer into a spreadsheet instruction. Numbers stay
 * numbers; only text is guarded.
 */
const CSV_HEADER = [
  'question_id',
  'question_name',
  'question_label',
  'question_type',
  'chart',
  'group',
  'answered',
  'missing',
  'submitted',
  'table',
  'row',
  'value',
  'count',
  'share_percent',
] as const;

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  // A number is data, not text: prefixing a negative count or coordinate would
  // turn a real value into a string in the reader's spreadsheet. Only a textual
  // cell can start a formula, so only a textual cell is neutralised.
  const safe = typeof value === 'string' && /^\s*[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

function csvLine(values: readonly unknown[]): string {
  return values.map(csvCell).join(',');
}

function csvRows(question: MonitorQuestion): unknown[][] {
  const base = [
    question.id,
    question.name,
    question.label,
    question.type,
    question.chart,
    question.groupLabel,
    question.answered,
    question.missing,
    question.total,
  ];
  const rows: unknown[][] = [];
  const push = (table: string, row: string, value: unknown, count: number, share: string | number = ''): void => {
    rows.push([...base, table, row, value, count, share]);
  };

  if (question.chart === 'histogram' && question.numeric) {
    for (const bin of question.numeric.bins) {
      push(
        'bin',
        bin.from === bin.to ? bin.from.toFixed(2) : `${bin.from.toFixed(2)} to ${bin.to.toFixed(2)}`,
        JSON.stringify([bin.from, bin.to]),
        bin.count,
        question.numeric.n > 0 ? ((bin.count / question.numeric.n) * 100).toFixed(1) : '',
      );
    }
  } else if (question.chart === 'line') {
    for (const point of question.series) push('day', point.label, point.key, point.count);
  } else if (question.chart === 'points') {
    for (const point of question.points) {
      push(
        'coordinate',
        `${point.lat.toFixed(6)}, ${point.lon.toFixed(6)}`,
        JSON.stringify([point.lat, point.lon]),
        point.count,
      );
    }
  } else if (question.chart === 'count') {
    push(
      'presence',
      'responses with a file, image, audio or video',
      '',
      question.answered,
      question.total > 0 ? ((question.answered / question.total) * 100).toFixed(1) : '',
    );
  } else {
    for (const option of question.options) push('option', option.label, option.value, option.count, option.percent.toFixed(1));
  }

  if (rows.length === 0) push('base', 'no plotted values', '', 0);
  return rows;
}

/** One question's data table, with its base repeated on every row. */
export function questionCsv(question: MonitorQuestion): string {
  return [CSV_HEADER, ...csvRows(question)].map(csvLine).join('\r\n') + '\r\n';
}

/** Every monitor table in one tidy file, ready for a spreadsheet or a pivot table. */
export function monitorCsv(model: MonitorModel): string {
  return [CSV_HEADER, ...model.questions.flatMap(csvRows)].map(csvLine).join('\r\n') + '\r\n';
}
