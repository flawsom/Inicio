import { describe, expect, it } from 'vitest';
import { buildDataset, statisticalPayload, type ExportResponse, type StatisticalPayload } from '../src/export/index.js';
import type { FormDefinition } from '../src/types.js';

/**
 * The dataset as the statistical worker's contract.
 *
 * `services/pyreadstat` is deployed separately and turns this JSON into `.sav`/`.dta`
 * bytes, so this mapping is the seam between the two halves of the export: a label lost
 * here is a label the worker never had, and a missing code lost here is a respondent's
 * non-answer arriving in a mean. The API's own suite stubs the worker over HTTP, so it
 * can see the body — but only this test holds the body to what the *engine* built, from
 * a real instrument, without a worker in the way.
 *
 * Every assertion below is a value, not a length: these are the facts a researcher reads
 * off the file at the import step.
 */

const def: FormDefinition = {
  title: 'School ranking',
  defaultLanguage: 'en',
  languages: ['en', 'hi'],
  groups: [],
  questions: [
    { id: 'q1', name: 'school', type: 'text', label: { en: 'School name', hi: 'विद्यालय का नाम' } },
    {
      id: 'q2',
      name: 'school_type',
      type: 'select_one',
      label: { en: 'Type', hi: 'प्रकार' },
      choices: { listName: 'school_types' },
    },
    { id: 'q3', name: 'enrolment', type: 'integer', label: { en: 'Enrolment', hi: 'नामांकन' } },
    {
      id: 'q4',
      name: 'facilities',
      type: 'select_multiple',
      label: { en: 'Facilities' },
      choices: { listName: 'facilities' },
    },
    // Not a variable at all: a display question must not become a column here either.
    { id: 'q5', name: 'note_only', type: 'note', label: { en: 'A note is not a variable' } },
  ],
  choiceLists: {
    school_types: [
      { value: 'govt', label: { en: 'Government', hi: 'सरकारी' } },
      { value: 'private', label: { en: 'Private', hi: 'निजी' } },
    ],
    facilities: [
      { value: 'library', label: { en: 'Library' } },
      { value: 'lab', label: { en: 'Science lab' } },
    ],
  },
};

const responses: ExportResponse[] = [
  {
    id: 'r1',
    status: 'submitted',
    startedAt: '2026-09-01T09:00:00Z',
    submittedAt: '2026-09-01T09:20:00Z',
    answers: { school: 'St Mary', school_type: 'govt', enrolment: 5000, facilities: ['library', 'lab'] },
  },
  {
    // One blank answer and one refusal: both arrive as "no value" in the data, and which
    // kind of missing they are is the codebook's business, not the cell's.
    id: 'r2',
    status: 'in_progress',
    startedAt: '2026-09-02T09:00:00Z',
    answers: { school: 'St Joseph' },
    special: { enrolment: 'refused' },
  },
];

describe('the statistical worker payload', () => {
  const dataset = buildDataset(def, responses, { now: new Date('2026-10-01T00:00:00Z') });
  const payload = statisticalPayload('sav', dataset, 'School ranking 2026');

  const indexOf = (variable: string): number => dataset.columns.findIndex((column) => column.variable === variable);
  const cell = (row: number, variable: string): unknown => payload.rows[row]?.[indexOf(variable)];

  it('carries the format and the file label as given', () => {
    expect(payload.format).toBe('sav');
    expect(payload.fileLabel).toBe('School ranking 2026');
    expect(statisticalPayload('dta', dataset, 'Other label').format).toBe('dta');
    expect(statisticalPayload('dta', dataset, 'Other label').fileLabel).toBe('Other label');
  });

  it('carries every column in order, with the prompt as the label', () => {
    expect(payload.columns).toEqual([
      { variable: 'response_id', label: 'Response identifier', numeric: false },
      { variable: 'status', label: 'Response status', numeric: false },
      { variable: 'started_at', label: 'First saved', numeric: false },
      { variable: 'submitted_at', label: 'Submitted', numeric: false },
      { variable: 'school', label: 'School name', numeric: false },
      { variable: 'school_type', label: 'Type', numeric: false },
      { variable: 'enrolment', label: 'Enrolment', numeric: true },
      { variable: 'facilities__library', label: 'Facilities: Library', numeric: true },
      { variable: 'facilities__lab', label: 'Facilities: Science lab', numeric: true },
    ]);
    // A note is not a variable, so it must not reach the worker as one.
    expect(payload.columns.map((column) => column.variable)).not.toContain('note_only');
  });

  it('carries a non-ASCII label byte for byte', () => {
    // A label mangled on the way to the worker is a respondent reading the wrong question,
    // and a codebook whose question text does not match the instrument.
    const hindi = buildDataset(def, responses, { language: 'hi', now: new Date('2026-10-01T00:00:00Z') });
    const original = statisticalPayload('sav', hindi, 'Ranking');
    expect(original.columns.find((column) => column.variable === 'school')?.label).toBe('विद्यालय का नाम');
    expect(original.columns.find((column) => column.variable === 'school_type')?.label).toBe('प्रकार');
    expect(JSON.parse(JSON.stringify(original)).columns[4].label).toBe('विद्यालय का नाम');
  });

  it('carries the rows exactly as the dataset built them', () => {
    expect(payload.rows).toHaveLength(dataset.rows.length);
    // The cells themselves, by variable: the answer, the stored code, and the blank.
    expect(cell(0, 'response_id')).toBe('r1');
    expect(cell(0, 'status')).toBe('submitted');
    expect(cell(0, 'school')).toBe('St Mary');
    expect(cell(0, 'school_type')).toBe('govt');
    expect(cell(0, 'enrolment')).toBe(5000);
    // A multi-select is expanded dichotomously, so each option is its own 0/1 column.
    expect(cell(0, 'facilities__library')).toBe(1);
    expect(cell(0, 'facilities__lab')).toBe(1);

    // A refused answer is a blank cell, never a zero and never the word "refused".
    expect(cell(1, 'enrolment')).toBe('');
    // Not asked: blank. Not selected is the 0 in the column above.
    expect(cell(1, 'school_type')).toBe('');
    expect(cell(1, 'facilities__library')).toBe(null);
    expect(payload.rows).toEqual(dataset.rows);
  });

  it('carries the value labels flattened, beside the columns they belong to', () => {
    expect(payload.valueLabels).toContainEqual({ variable: 'school_type', code: 'govt', label: 'Government' });
    expect(payload.valueLabels).toContainEqual({ variable: 'school_type', code: 'private', label: 'Private' });
    // The dichotomous expansion explains its own 0 and 1.
    expect(payload.valueLabels).toContainEqual({ variable: 'facilities__library', code: '0', label: 'Not selected' });
    expect(payload.valueLabels).toContainEqual({ variable: 'facilities__library', code: '1', label: 'Selected' });
    expect(payload.valueLabels).toContainEqual({ variable: 'facilities__lab', code: '1', label: 'Selected' });
    // The response status is a variable too, so its codes travel with it.
    expect(payload.valueLabels).toContainEqual({ variable: 'status', code: 'submitted', label: 'Submitted' });
    expect(payload.valueLabels).toEqual(dataset.valueLabels);
  });

  it('carries the engine’s missing-code table once, with the meaning of each code', () => {
    // Taken from the dataset rather than from a column on purpose: the table is global —
    // the same in every column's codebook entry — so the worker is given it once.
    const byCode = new Map(payload.missingCodes.map((entry) => [String(entry.code), entry]));
    expect(payload.missingCodes).toHaveLength(5);
    expect(byCode.get('system')).toEqual({ code: 'system', numeric: null, label: expect.any(String) });
    expect(byCode.get('not_asked')?.numeric).toBe(-99);
    expect(byCode.get('not_asked')?.label).toContain('Not asked');
    expect(byCode.get('skipped')?.numeric).toBe(-98);
    expect(byCode.get('skipped')?.label).toContain('Skipped by logic');
    expect(byCode.get('refused')?.numeric).toBe(-97);
    expect(byCode.get('refused')?.label).toContain('Refused');
    expect(byCode.get('dont_know')?.numeric).toBe(-96);
    expect(byCode.get('dont_know')?.label).toContain("Don't know");
    expect(payload.missingCodes).toEqual(dataset.codebook[0]?.missingCodes);
  });

  it('carries the dataset’s own notes, without dropping one', () => {
    expect(payload.notes.length).toBeGreaterThan(0);
    expect(payload.notes).toEqual(dataset.meta.notes);
    // The note that stops a reader treating a blank cell as a zero travels with the
    // export, in the dataset's own words rather than a paraphrase written here.
    expect(payload.notes).toContain(
      'Blank data cells mean "no value". The kind of missingness is in the missing table (system / not_asked / skipped / refused / dont_know), not in the data cell.',
    );
  });

  it('produces a payload for an instrument with no answerable question', () => {
    const display: FormDefinition = {
      title: 'Cover sheet',
      defaultLanguage: 'en',
      languages: ['en'],
      groups: [],
      questions: [{ id: 'q1', name: 'intro', type: 'note', label: { en: 'Read this first' } }],
      choiceLists: {},
    };
    const cover = statisticalPayload('sav', buildDataset(display, responses, { now: new Date() }), 'Cover');
    // Only the four response-metadata columns, and the codes are still declared: the
    // export is not empty, it simply has nothing a respondent answered.
    expect(cover.columns.map((column) => column.variable)).toEqual([
      'response_id',
      'status',
      'started_at',
      'submitted_at',
    ]);
    expect(cover.missingCodes).toHaveLength(5);
  });

  it('does not throw when a dataset arrives with no codebook at all', () => {
    const bare: typeof dataset = { ...dataset, codebook: [] };
    const without: StatisticalPayload = statisticalPayload('sav', bare, 'No codebook');
    expect(without.missingCodes).toEqual([]);
    expect(without.columns).toEqual(payload.columns);
  });
});
