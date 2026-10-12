/**
 * A response export is not a value grid.
 *
 * What makes a survey export analysis-ready, according to what the statistical
 * packages actually need (CESSDA/IBM/pyreadstat/Stata docs):
 *   data  +  codebook  +  value labels  +  missing-code definitions  +  metadata
 *
 * Three things this module refuses to do the sloppy way:
 *   1. Multi-selects are expanded explicitly (dichotomous 0/1 or categorical slots),
 *      never left as a delimiter-packed string.
 *   2. `not selected` (0) is distinguished from `not asked` (blank) — they are
 *      different facts and collapsing them destroys the analysis.
 *   3. Missing values carry *which kind* of missing they are: system missing, not
 *      asked, skipped by logic, refused, don't know.
 */
import { evaluateForm } from '../evaluate.js';
import { DISPLAY_TYPES, MULTI_TYPES, type AnswerMap, type FormDefinition, type Question, type QuestionType } from '../types.js';

export type MissingCode = 'system' | 'not_asked' | 'skipped' | 'refused' | 'dont_know';

/**
 * `canonical` is what the data files carry (blank, because a data cell holds a value
 * or nothing). `numeric` is the code a statistical package uses, which is why the
 * distinction is preserved in the missing table and the codebook rather than only
 * in this comment.
 */
export const MISSING_CODES: Record<MissingCode, { numeric: number | null; label: string }> = {
  system: { numeric: null, label: 'System missing — the question was asked and no answer was recorded' },
  not_asked: { numeric: -99, label: 'Not asked — the response ended (or the version changed) before this question' },
  skipped: { numeric: -98, label: 'Skipped by logic — the question was not shown to this respondent' },
  refused: { numeric: -97, label: 'Refused — the respondent declined to answer' },
  dont_know: { numeric: -96, label: "Don't know — the respondent answered that they do not know" },
};

export type ResponseStatus = 'in_progress' | 'submitted' | 'screened_out' | 'quota_full';

export interface ExportResponse {
  id: string;
  status: ResponseStatus;
  startedAt?: string | null;
  submittedAt?: string | null;
  answers: AnswerMap;
  /** A real answer of "refused" / "don't know" — not the same as a blank. */
  special?: Record<string, 'refused' | 'dont_know'>;
  /** Questions never asked for this response (it predates the current version). */
  notAsked?: string[];
}

export interface ValueLabel {
  code: string;
  label: string;
}

export interface ExportColumn {
  variable: string;
  /** Question name this column came from. Empty for the response-metadata columns. */
  question: string;
  prompt: string;
  type: QuestionType | 'meta' | 'geopoint_latitude' | 'geopoint_longitude' | 'geopoint_altitude' | 'geopoint_accuracy' | 'slot';
  numeric: boolean;
  valueLabels: ValueLabel[];
  multiSelect?: { kind: 'dichotomous' | 'slot'; choice?: string; slot?: number };
}

export interface CodebookEntry {
  variable: string;
  question: string;
  prompt: string;
  type: string;
  numeric: boolean;
  valueLabels: ValueLabel[];
  missingCodes: Array<{ code: MissingCode; numeric: number | null; label: string }>;
  notes: string[];
}

export interface MissingCell {
  response: string;
  variable: string;
  question: string;
  code: MissingCode;
}

export type Cell = string | number | boolean | null;

export interface ExportDataset {
  columns: ExportColumn[];
  rows: Cell[][];
  missing: MissingCell[];
  codebook: CodebookEntry[];
  valueLabels: Array<{ variable: string; code: string; label: string }>;
  meta: {
    title: string;
    formVersion: number | null;
    publishedAt: string | null;
    generatedAt: string;
    language: string;
    multiSelect: 'dichotomous' | 'slots';
    responseCount: number;
    byStatus: Record<string, number>;
    columnCount: number;
    missingCount: number;
    /** Honest note about what the data files do and do not contain. */
    notes: string[];
  };
}

export interface BuildOptions {
  /** `dichotomous` = one 0/1 column per option; `slots` = q_1..q_n in order. */
  multiSelect?: 'dichotomous' | 'slots';
  language?: string;
  /** Include responses that were never submitted. Default true — they are real data. */
  includeInProgress?: boolean;
  formVersion?: number | null;
  publishedAt?: string | null;
  now?: Date;
}

const META_COLUMNS: ExportColumn[] = [
  { variable: 'response_id', question: '', prompt: 'Response identifier', type: 'meta', numeric: false, valueLabels: [] },
  { variable: 'status', question: '', prompt: 'Response status', type: 'meta', numeric: false, valueLabels: [] },
  { variable: 'started_at', question: '', prompt: 'First saved', type: 'meta', numeric: false, valueLabels: [] },
  { variable: 'submitted_at', question: '', prompt: 'Submitted', type: 'meta', numeric: false, valueLabels: [] },
];

const STATUS_LABELS: ValueLabel[] = [
  { code: 'in_progress', label: 'In progress' },
  { code: 'submitted', label: 'Submitted' },
  { code: 'screened_out', label: 'Screened out' },
  { code: 'quota_full', label: 'Quota full' },
];

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

function labelFor(question: Question, language: string): string {
  const chosen = question.label?.[language];
  if (chosen) return chosen;
  const first = Object.values(question.label ?? {})[0];
  return first ?? question.name;
}

function choicesOf(def: FormDefinition, q: Question): Array<{ value: string; label: string; extra?: Record<string, string> }> {
  const list = q.choices?.listName ? def.choiceLists[q.choices.listName] : q.choices?.inline;
  return (list ?? []).map((c) => {
    const label = c.label?.[def.defaultLanguage] ?? Object.values(c.label ?? {})[0] ?? c.value;
    return c.extra ? { value: c.value, label, extra: c.extra } : { value: c.value, label };
  });
}

export interface GeoPoint {
  latitude: number | null;
  longitude: number | null;
  altitude: number | null;
  accuracy: number | null;
}

/** XLSForm geopoints arrive as `lat lon altitude accuracy`, or as an object from a map widget. */
export function splitGeoPoint(value: unknown): GeoPoint | null {
  const empty: GeoPoint = { latitude: null, longitude: null, altitude: null, accuracy: null };
  if (isBlank(value)) return empty;
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    const num = (x: unknown): number | null => (x === undefined || x === null || x === '' ? null : Number(x));
    if ('latitude' in v || 'longitude' in v) {
      return { latitude: num(v['latitude']), longitude: num(v['longitude']), altitude: num(v['altitude']), accuracy: num(v['accuracy']) };
    }
    return empty;
  }
  const parts = String(value).trim().split(/\s+/);
  if (parts.length < 2) return empty;
  const num = (i: number): number | null => {
    const raw = parts[i];
    if (raw === undefined || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  return { latitude: num(0), longitude: num(1), altitude: num(2), accuracy: num(3) };
}

function asMultiValue(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (isBlank(value)) return [];
  return String(value).split(/[\s,]+/).filter(Boolean);
}

function numericType(type: QuestionType): boolean {
  return type === 'integer' || type === 'decimal' || type === 'percentage' || type === 'currency';
}

/* ------------------------------------------------------------- column layout */

export function buildColumns(def: FormDefinition, options: BuildOptions = {}): ExportColumn[] {
  const language = options.language ?? def.defaultLanguage;
  const multiSelect = options.multiSelect ?? 'dichotomous';
  const columns: ExportColumn[] = META_COLUMNS.map((c) => (c.variable === 'status' ? { ...c, valueLabels: STATUS_LABELS } : { ...c }));

  for (const q of def.questions) {
    if (DISPLAY_TYPES.has(q.type)) continue;
    const prompt = labelFor(q, language);

    if (q.type === 'geopoint') {
      const parts: Array<[string, ExportColumn['type']]> = [
        ['latitude', 'geopoint_latitude'],
        ['longitude', 'geopoint_longitude'],
        ['altitude', 'geopoint_altitude'],
        ['accuracy', 'geopoint_accuracy'],
      ];
      for (const [suffix, type] of parts) {
        columns.push({ variable: `${q.name}_${suffix}`, question: q.name, prompt: `${prompt} (${suffix})`, type, numeric: true, valueLabels: [] });
      }
      continue;
    }

    if (MULTI_TYPES.has(q.type)) {
      const choices = choicesOf(def, q);
      if (multiSelect === 'dichotomous') {
        for (const choice of choices) {
          columns.push({
            variable: `${q.name}__${choice.value}`,
            question: q.name,
            prompt: `${prompt} — ${choice.label}`,
            type: q.type,
            numeric: true,
            valueLabels: [
              { code: '0', label: 'Not selected' },
              { code: '1', label: 'Selected' },
            ],
            multiSelect: { kind: 'dichotomous', choice: choice.value },
          });
        }
      } else {
        choices.forEach((_choice, index) => {
          columns.push({
            variable: `${q.name}_${index + 1}`,
            question: q.name,
            prompt: `${prompt} — slot ${index + 1}`,
            type: 'slot',
            numeric: false,
            valueLabels: choices.map((c) => ({ code: c.value, label: c.label })),
            multiSelect: { kind: 'slot', slot: index + 1 },
          });
        });
      }
      continue;
    }

    const isSelect = q.type === 'select_one' || q.type === 'yesno';
    const choices = choicesOf(def, q).map((c) => ({ code: c.value, label: c.label }));
    columns.push({
      variable: q.name,
      question: q.name,
      prompt,
      type: q.type,
      numeric: numericType(q.type),
      valueLabels: !isSelect
        ? []
        : choices.length > 0
          ? choices
          : [{ code: 'yes', label: 'Yes' }, { code: 'no', label: 'No' }],
    });
  }

  return columns;
}

/* ------------------------------------------------------------------ dataset */

export function buildDataset(def: FormDefinition, responses: ExportResponse[], options: BuildOptions = {}): ExportDataset {
  const language = options.language ?? def.defaultLanguage;
  const multiSelect = options.multiSelect ?? 'dichotomous';
  const includeInProgress = options.includeInProgress ?? true;
  const now = options.now ?? new Date();

  const columns = buildColumns(def, options);
  const usable = includeInProgress ? responses : responses.filter((r) => r.status !== 'in_progress');

  const rows: Cell[][] = [];
  const missing: MissingCell[] = [];
  const byStatus: Record<string, number> = {};

  for (const response of usable) {
    byStatus[response.status] = (byStatus[response.status] ?? 0) + 1;
    const states = evaluateForm(def, response.answers).states;
    const row: Cell[] = [response.id, response.status, response.startedAt ?? '', response.submittedAt ?? ''];

    for (const column of columns.slice(META_COLUMNS.length)) {
      const question = def.questions.find((x) => x.name === column.question);
      if (!question) {
        row.push('');
        continue;
      }
      const special = response.special?.[question.name];
      const raw = response.answers[question.name];
      const state = states[question.name];

      const record = (code: MissingCode): void => {
        missing.push({ response: response.id, variable: column.variable, question: question.name, code });
      };

      let code: MissingCode | null = null;
      if (special) code = special;
      else if (response.notAsked?.includes(question.name)) code = 'not_asked';
      else if (state && !state.visible) code = 'skipped';
      else if (isBlank(raw) && !(MULTI_TYPES.has(question.type) && Array.isArray(raw))) {
        code = response.status === 'in_progress' ? 'not_asked' : 'system';
      }

      if (column.multiSelect?.kind === 'dichotomous') {
        if (code) {
          record(code);
          row.push(null); // blank: "not asked", distinct from 0 "not selected"
          continue;
        }
        const selected = asMultiValue(raw);
        row.push(selected.includes(column.multiSelect.choice ?? '') ? 1 : 0);
        continue;
      }

      if (column.multiSelect?.kind === 'slot') {
        if (code) {
          record(code);
          row.push('');
          continue;
        }
        const selected = asMultiValue(raw);
        row.push(selected[(column.multiSelect.slot ?? 1) - 1] ?? '');
        continue;
      }

      if (column.type === 'geopoint_latitude' || column.type === 'geopoint_longitude' || column.type === 'geopoint_altitude' || column.type === 'geopoint_accuracy') {
        if (code) {
          record(code);
          row.push(null);
          continue;
        }
        const point = splitGeoPoint(raw) ?? { latitude: null, longitude: null, altitude: null, accuracy: null };
        const suffix = column.type.replace('geopoint_', '');
        row.push(point[suffix as keyof GeoPoint]);
        continue;
      }

      if (code) {
        record(code);
        row.push('');
        continue;
      }

      row.push(column.numeric && raw !== '' ? Number(raw) : String(raw));
    }

    rows.push(row);
  }

  /* -- codebook + value labels -- */
  const codebook: CodebookEntry[] = columns.map((column) => {
    const notes: string[] = [];
    if (column.multiSelect?.kind === 'dichotomous') {
      notes.push('One of the expanded columns of a multi-select: 1 = selected, 0 = not selected, blank = the question was not answered.');
    }
    if (column.multiSelect?.kind === 'slot') {
      notes.push('Ordered slot of a multi-select. A blank slot means fewer options were chosen than there are slots.');
    }
    if (column.type === 'geopoint_latitude') notes.push('Split from the geopoint answer.');
    if (column.numeric) notes.push('Numeric column; blank cells are missing, never zero.');
    if (column.variable === 'status') notes.push("Use the status to separate partial responses from submitted ones.");
    const missingCodes = (Object.keys(MISSING_CODES) as MissingCode[]).map((code) => ({ code, ...MISSING_CODES[code] }));
    return {
      variable: column.variable,
      question: column.question,
      prompt: column.prompt,
      type: String(column.type),
      numeric: column.numeric,
      valueLabels: column.valueLabels,
      missingCodes,
      notes,
    };
  });

  const valueLabels: Array<{ variable: string; code: string; label: string }> = [];
  for (const column of columns) {
    for (const label of column.valueLabels) valueLabels.push({ variable: column.variable, code: label.code, label: label.label });
  }

  return {
    columns,
    rows,
    missing,
    codebook,
    valueLabels,
    meta: {
      title: def.title,
      formVersion: options.formVersion ?? null,
      publishedAt: options.publishedAt ?? null,
      generatedAt: now.toISOString(),
      language,
      multiSelect,
      responseCount: rows.length,
      byStatus,
      columnCount: columns.length,
      missingCount: missing.length,
      notes: [
        'Blank data cells mean "no value" — the kind of missingness is in the missing table (system / not_asked / skipped / refused / dont_know), not in the data cell.',
        `Multi-select questions are expanded ${multiSelect === 'dichotomous' ? 'dichotomously (one 0/1 column per option)' : 'into ordered value slots'}.`,
        'Values are stored codes, not labels; the value-labels table is the code→label mapping.',
      ],
    },
  };
}
