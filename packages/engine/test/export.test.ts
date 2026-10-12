import { strFromU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { readWorkbook } from '../src/adapters/xlsx.js';
import { MISSING_CODES } from '../src/export/dataset.js';
import {
  buildColumns,
  buildDataset,
  buildExportBundle,
  sanitizeSpreadsheetCell,
  toCsv,
  type ExportResponse,
} from '../src/export/index.js';
import type { FormDefinition } from '../src/types.js';

const def: FormDefinition = {
  title: 'Facility survey',
  defaultLanguage: 'en',
  languages: ['en'],
  groups: [],
  questions: [
    { id: 'q1', name: 'consent', type: 'yesno', label: { en: 'Consent to continue' }, choices: { listName: 'yesno' } },
    { id: 'q2', name: 'facilities', type: 'select_multiple', label: { en: 'Facilities' }, choices: { listName: 'facilities' } },
    { id: 'q3', name: 'fee', type: 'integer', label: { en: 'Annual fee' } },
    { id: 'q4', name: 'note_only', type: 'note', label: { en: 'A note is not a variable' } },
    { id: 'q5', name: 'location', type: 'geopoint', label: { en: 'Location' } },
    { id: 'q6', name: 'extra', type: 'text', label: { en: 'Extra detail' }, rules: { visibleIf: "${consent} = 'yes'" } },
    { id: 'q7', name: 'ranked', type: 'rank', label: { en: 'Ranking' }, choices: { listName: 'facilities' } },
  ],
  choiceLists: {
    yesno: [{ value: 'yes', label: { en: 'Yes' } }, { value: 'no', label: { en: 'No' } }],
    facilities: [{ value: 'library', label: { en: 'Library' } }, { value: 'lab', label: { en: 'Science lab' } }],
  },
};

const responses: ExportResponse[] = [
  {
    id: 'r1',
    status: 'submitted',
    startedAt: '2026-09-01T09:00:00Z',
    submittedAt: '2026-09-01T09:20:00Z',
    answers: {
      consent: 'yes',
      facilities: ['library', 'lab'],
      fee: 5000,
      location: '12.9716 77.5946 920 5',
      extra: '=SUM(A1)',
      ranked: ['lab', 'library'],
    },
  },
  {
    id: 'r2',
    status: 'submitted',
    answers: { consent: 'no', facilities: [], fee: '' },
  },
  { id: 'r3', status: 'in_progress', answers: { fee: 1200 } },
  { id: 'r4', status: 'submitted', answers: { consent: 'yes', extra: '' }, special: { extra: 'refused' } },
  { id: 'r5', status: 'submitted', answers: { consent: 'yes' }, special: { fee: 'dont_know' } },
  { id: 'r6', status: 'submitted', answers: { consent: 'yes' }, notAsked: ['fee'] },
];

const col = (dataset: ReturnType<typeof buildDataset>, variable: string): number =>
  dataset.columns.findIndex((c) => c.variable === variable);

describe('export column layout', () => {
  it('puts response metadata first and expands multi-selects dichotomously', () => {
    const variables = buildColumns(def).map((c) => c.variable);
    expect(variables).toEqual([
      'response_id', 'status', 'started_at', 'submitted_at',
      'consent',
      'facilities__library', 'facilities__lab',
      'fee',
      'location_latitude', 'location_longitude', 'location_altitude', 'location_accuracy',
      'extra',
      'ranked__library', 'ranked__lab',
    ]);
    // A note is not a variable, and must not appear as a column at all.
    expect(variables).not.toContain('note_only');
  });

  it('can expand multi-selects into ordered slots instead', () => {
    const variables = buildColumns(def, { multiSelect: 'slots' }).map((c) => c.variable);
    expect(variables).toContain('facilities_1');
    expect(variables).toContain('facilities_2');
    expect(variables).not.toContain('facilities__library');
  });
});

describe('export data', () => {
  const dataset = buildDataset(def, responses, { now: new Date('2026-10-01T00:00:00Z') });

  it('keeps every row the same width as the header', () => {
    for (const row of dataset.rows) expect(row).toHaveLength(dataset.columns.length);
  });

  it('distinguishes "not selected" (0) from "not asked" (blank)', () => {
    const r2 = dataset.rows.find((r) => r[0] === 'r2')!;
    // Facilities were answered with nothing chosen: 0, not blank.
    expect(r2[col(dataset, 'facilities__library')]).toBe(0);
    expect(r2[col(dataset, 'facilities__lab')]).toBe(0);

    const r3 = dataset.rows.find((r) => r[0] === 'r3')!;
    // The question was never reached: blank, which is a different fact.
    expect(r3[col(dataset, 'facilities__library')]).toBeNull();
    // ...and a scalar that was never asked is blank too, never 0 or 'false'.
    expect(r3[col(dataset, 'consent')]).toBe('');
  });

  it('records which kind of missing each blank is', () => {
    const codeFor = (response: string, variable: string): string | undefined =>
      dataset.missing.find((m) => m.response === response && m.variable === variable)?.code;

    expect(codeFor('r2', 'fee')).toBe('system'); // asked, no answer
    expect(codeFor('r3', 'consent')).toBe('not_asked'); // response never got there
    expect(codeFor('r3', 'extra')).toBe('skipped'); // consent unanswered => not shown
    expect(codeFor('r2', 'extra')).toBe('skipped'); // answered 'no' => not shown
    expect(codeFor('r4', 'extra')).toBe('refused'); // a real answer of "refused"
    expect(codeFor('r5', 'fee')).toBe('dont_know');
    expect(codeFor('r6', 'fee')).toBe('not_asked'); // question did not exist in that version
  });

  it('splits a geopoint into named coordinate columns', () => {
    const r1 = dataset.rows.find((r) => r[0] === 'r1')!;
    expect(r1[col(dataset, 'location_latitude')]).toBeCloseTo(12.9716);
    expect(r1[col(dataset, 'location_longitude')]).toBeCloseTo(77.5946);
    expect(r1[col(dataset, 'location_altitude')]).toBe(920);
    expect(r1[col(dataset, 'location_accuracy')]).toBe(5);
  });

  it('writes numeric columns as numbers, not text', () => {
    const r1 = dataset.rows.find((r) => r[0] === 'r1')!;
    expect(r1[col(dataset, 'fee')]).toBe(5000);
    expect(typeof r1[col(dataset, 'facilities__library')]).toBe('number');
  });

  it('carries a codebook, value labels and a missing-code definition for every variable', () => {
    const fee = dataset.codebook.find((c) => c.variable === 'fee')!;
    expect(fee.prompt).toBe('Annual fee');
    expect(fee.numeric).toBe(true);
    expect(fee.missingCodes.map((m) => m.code)).toEqual(['system', 'not_asked', 'skipped', 'refused', 'dont_know']);
    expect(fee.missingCodes.find((m) => m.code === 'refused')?.numeric).toBe(-97);

    const consent = dataset.codebook.find((c) => c.variable === 'consent')!;
    expect(consent.valueLabels).toEqual([{ code: 'yes', label: 'Yes' }, { code: 'no', label: 'No' }]);

    const libraryColumn = dataset.codebook.find((c) => c.variable === 'facilities__library')!;
    expect(libraryColumn.valueLabels).toEqual([{ code: '0', label: 'Not selected' }, { code: '1', label: 'Selected' }]);
    expect(libraryColumn.notes.join(' ')).toMatch(/1 = selected, 0 = not selected/);

    expect(dataset.valueLabels).toContainEqual({ variable: 'consent', code: 'yes', label: 'Yes' });
  });

  it('reports the collection window and response counts', () => {
    expect(dataset.meta.responseCount).toBe(6);
    expect(dataset.meta.byStatus).toEqual({ submitted: 5, in_progress: 1 });
    expect(dataset.meta.formVersion).toBeNull();
    expect(dataset.meta.notes.join(' ')).toMatch(/blank data cells mean "no value"/i);
  });

  it('can exclude partial responses on request, and says so by their absence', () => {
    const submittedOnly = buildDataset(def, responses, { includeInProgress: false });
    expect(submittedOnly.rows.map((r) => r[0])).toEqual(['r1', 'r2', 'r4', 'r5', 'r6']);
  });
});

describe('csv injection', () => {
  it('leaves a plain negative number alone but neutralises a formula-looking one', () => {
    expect(sanitizeSpreadsheetCell('-5')).toBe('-5');
    expect(sanitizeSpreadsheetCell('-2+3|cmd')).toBe('\t-2+3|cmd');
    expect(sanitizeSpreadsheetCell('=SUM(A1)')).toBe('\t=SUM(A1)');
    expect(sanitizeSpreadsheetCell('@foo')).toBe('\t@foo');
    expect(sanitizeSpreadsheetCell('\uFF1DSUM(A1)')).toBe('\t\uFF1DSUM(A1)');
    expect(sanitizeSpreadsheetCell('ordinary text')).toBe('ordinary text');
  });

  it('keeps the canonical data file untouched and sanitises only the spreadsheet view', () => {
    const bundle = buildExportBundle(def, responses, { formats: ['csv'] });
    const data = strFromU8(bundle.files.find((f) => f.name === 'data.csv')!.bytes);
    const safe = strFromU8(bundle.files.find((f) => f.name === 'spreadsheet-view.csv')!.bytes);

    expect(data).toContain('=SUM(A1)');
    expect(data).not.toContain('\t=SUM(A1)');
    expect(safe).toContain('\t=SUM(A1)');
    // Excel needs the UTF-8 BOM to read non-ASCII text; a machine-readable CSV should
    // not have one. Asserted on the bytes: TextDecoder strips a BOM when decoding.
    const safeBytes = bundle.files.find((f) => f.name === 'spreadsheet-view.csv')!.bytes;
    const dataBytes = bundle.files.find((f) => f.name === 'data.csv')!.bytes;
    expect([...safeBytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect([...dataBytes.slice(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
  });

  it('quotes csv fields that contain separators, quotes or newlines', () => {
    const csv = toCsv([['a,b', 'say "hi"', 'two\nlines', ' padded ']]);
    expect(csv).toBe('"a,b","say ""hi""","two\nlines"," padded "\r\n');
  });
});

describe('export bundle', () => {
  it('emits a complete csv bundle with a file for each part of the export', () => {
    const bundle = buildExportBundle(def, responses, { formats: ['csv'], formVersion: 3, publishedAt: '2026-09-01T00:00:00Z' });
    expect(bundle.files.map((f) => f.name)).toEqual([
      'data.csv', 'spreadsheet-view.csv', 'codebook.csv', 'value-labels.csv', 'missing.csv', 'meta.json',
    ]);
    const meta = JSON.parse(strFromU8(bundle.files.find((f) => f.name === 'meta.json')!.bytes)) as Record<string, unknown>;
    expect(meta['formVersion']).toBe(3);
    expect(meta['columnCount']).toBe(15);
    expect(bundle.dataset.meta.missingCount).toBe(bundle.dataset.missing.length);
  });

  it('refuses statistical formats with a reason instead of shipping a broken file', () => {
    const bundle = buildExportBundle(def, responses, { formats: ['csv'] });
    expect(bundle.unavailable.map((u) => u.format)).toEqual(['sav', 'dta']);
    expect(bundle.unavailable[0]?.reason).toMatch(/pyreadstat/);
    expect(bundle.files.some((f) => f.name.endsWith('.sav'))).toBe(false);
  });

  it('produces a workbook whose sheets a reader can open', () => {
    const bundle = buildExportBundle(def, responses, { formats: ['xlsx'] });
    const book = readWorkbook(bundle.files[0]!.bytes);
    expect(book.sheets.map((s) => s.name)).toEqual(['data', 'codebook', 'value_labels', 'missing', 'meta']);

    const data = book.sheets[0]!;
    expect(data.rows[0]?.[0]).toBe('response_id');
    const header = data.rows[0] ?? [];
    const feeAt = header.indexOf('fee');
    const r1 = data.rows.find((row) => row[0] === 'r1');
    expect(r1?.[feeAt]).toBe('5000');
    const labels = book.sheets[2]!;
    expect(labels.rows).toContainEqual(['consent', 'yes', 'Yes']);
  });

  it('produces json with data, codebook and missing table together', () => {
    const bundle = buildExportBundle(def, responses, { formats: ['json'] });
    const parsed = JSON.parse(strFromU8(bundle.files[0]!.bytes)) as {
      data: Array<Record<string, unknown>>;
      codebook: unknown[];
      missing: unknown[];
      valueLabels: unknown[];
    };
    expect(parsed.data).toHaveLength(6);
    expect(parsed.data.find((r) => r['response_id'] === 'r1')?.['fee']).toBe(5000);
    expect(parsed.codebook).toHaveLength(15);
    expect(parsed.missing.length).toBeGreaterThan(0);
    expect(parsed.valueLabels.length).toBeGreaterThan(0);
  });

  it('documents the numeric missing codes it will use in statistical exports', () => {
    expect(MISSING_CODES.refused.numeric).toBe(-97);
    expect(MISSING_CODES.dont_know.numeric).toBe(-96);
    expect(MISSING_CODES.skipped.numeric).toBe(-98);
    expect(MISSING_CODES.not_asked.numeric).toBe(-99);
    expect(MISSING_CODES.system.numeric).toBeNull();
  });
});
