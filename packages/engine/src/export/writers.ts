/**
 * Export writers.
 *
 * The CSV injection hazard is real and specific: any respondent text beginning `=`,
 * `+`, `-` or `@` is a *formula* when the file is opened in Excel, so a survey can be
 * made to exfiltrate or execute. Our answer is the one that does not corrupt the data:
 * the canonical `data.csv` is written exactly as captured, and a separate
 * `spreadsheet-view.csv` is emitted with dangerous cells tab-prefixed. Recipients get
 * both, and the meta file says which is which.
 *
 * XLSX is not exposed to that class of attack at all: a text cell is a shared string,
 * never a formula element, so the workbook can carry the raw values.
 */
import { strToU8, zipSync } from 'fflate';
import { writeWorkbook } from '../adapters/xlsx.js';
import { MISSING_CODES, type Cell, type ExportDataset } from './dataset.js';

export interface BundleFile {
  name: string;
  contentType: string;
  bytes: Uint8Array;
  /** What this file is, for a recipient who has never seen a survey export. */
  description: string;
}

/** A plain number is not a formula, so `-5` stays `-5`; `-2+3|cmd` does not. */
const PLAIN_NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const FORMULA_LEADS = new Set(['=', '@', '\t', '\r', '\uFF1D', '\uFF0B', '\uFF0D', '\uFF20']);

export function sanitizeSpreadsheetCell(value: string): string {
  const first = value.charAt(0);
  if (FORMULA_LEADS.has(first)) return `\t${value}`;
  if ((first === '+' || first === '-') && !PLAIN_NUMBER.test(value)) return `\t${value}`;
  return value;
}

function csvField(value: Cell, sanitize: boolean): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  const text = sanitize ? sanitizeSpreadsheetCell(value) : value;
  if (/[",\n\r]/.test(text) || text !== text.trim()) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(rows: Cell[][], options: { sanitize?: boolean; bom?: boolean } = {}): string {
  const sanitize = options.sanitize ?? false;
  const body = rows.map((row) => row.map((cell) => csvField(cell, sanitize)).join(',')).join('\r\n');
  return `${options.bom ? '\uFEFF' : ''}${body}\r\n`;
}

/* ---------------------------------------------------------------------- csv */

export function csvBundle(dataset: ExportDataset): BundleFile[] {
  const header: Cell[] = dataset.columns.map((c) => c.variable);
  const data: Cell[][] = [header, ...dataset.rows];

  const codebookHeader: Cell[] = ['variable', 'question', 'prompt', 'type', 'numeric', 'value_labels', 'missing_1_system', 'missing_2_not_asked', 'missing_3_skipped', 'missing_4_refused', 'missing_5_dont_know', 'notes'];
  const missingName: Array<[string, keyof typeof MISSING_CODES]> = [
    ['missing_1_system', 'system'],
    ['missing_2_not_asked', 'not_asked'],
    ['missing_3_skipped', 'skipped'],
    ['missing_4_refused', 'refused'],
    ['missing_5_dont_know', 'dont_know'],
  ];
  const codebook: Cell[][] = [
    codebookHeader,
    ...dataset.codebook.map((entry) => [
      entry.variable,
      entry.question,
      entry.prompt,
      entry.type,
      entry.numeric ? 'yes' : 'no',
      entry.valueLabels.map((v) => `${v.code}=${v.label}`).join('; '),
      ...missingName.map(([, code]) => `${MISSING_CODES[code].numeric ?? 'blank'}: ${MISSING_CODES[code].label}`),
      entry.notes.join(' '),
    ] as Cell[]),
  ];

  const valueLabels: Cell[][] = [
    ['variable', 'code', 'label'],
    ...dataset.valueLabels.map((v) => [v.variable, v.code, v.label] as Cell[]),
  ];

  const missing: Cell[][] = [
    ['response_id', 'variable', 'question', 'missing_code', 'numeric_code'],
    ...dataset.missing.map((m) => [m.response, m.variable, m.question, m.code, MISSING_CODES[m.code].numeric ?? ''] as Cell[]),
  ];

  return [
    { name: 'data.csv', contentType: 'text/csv; charset=utf-8', bytes: strToU8(toCsv(data)), description: 'The data, exactly as captured. Values are stored codes, not labels.' },
    {
      name: 'spreadsheet-view.csv',
      contentType: 'text/csv; charset=utf-8',
      bytes: strToU8(toCsv(data, { sanitize: true, bom: true })),
      description: 'Same data, safe to open in Excel: cells that Excel would treat as a formula are tab-prefixed. Prefer data.csv for programmatic use.',
    },
    { name: 'codebook.csv', contentType: 'text/csv; charset=utf-8', bytes: strToU8(toCsv(codebook)), description: 'Every variable: its question text, type, valid codes and the meaning of each missing code.' },
    { name: 'value-labels.csv', contentType: 'text/csv; charset=utf-8', bytes: strToU8(toCsv(valueLabels)), description: 'code → label mapping, normalised so it imports into any statistical package.' },
    { name: 'missing.csv', contentType: 'text/csv; charset=utf-8', bytes: strToU8(toCsv(missing)), description: 'Which kind of missing each blank cell is: system, not_asked, skipped, refused or dont_know.' },
    { name: 'meta.json', contentType: 'application/json', bytes: strToU8(`${JSON.stringify(dataset.meta, null, 2)}\n`), description: 'Form version, collection window, response counts and the export format choices.' },
  ];
}

/**
 * Packs a file list into one archive. A CSV export is a *bundle* (data, codebook,
 * value labels, missing table, metadata), so a download has to keep them together and
 * named. The fixed timestamp keeps the archive byte-identical for identical input.
 */
export function zipFiles(files: BundleFile[], folder?: string): Uint8Array {
  const prefix = folder ? `${folder.replace(/\/+$/, '')}/` : '';
  return zipSync(
    Object.fromEntries(files.map((f) => [`${prefix}${f.name}`, f.bytes])),
    { level: 6, mtime: new Date('2020-01-01T00:00:00Z') },
  );
}

/* --------------------------------------------------------------------- xlsx */

function flattenLabels(labels: Array<{ code: string; label: string }>): string {
  return labels.map((l) => `${l.code}=${l.label}`).join('; ');
}

export function xlsxBundle(dataset: ExportDataset): BundleFile[] {
  const dataSheet = [dataset.columns.map((c) => c.variable) as Cell[], ...dataset.rows];

  const codebookSheet: Cell[][] = [
    ['variable', 'question', 'prompt', 'type', 'numeric', 'value_labels', 'missing_codes', 'notes'],
    ...dataset.codebook.map((entry) => [
      entry.variable,
      entry.question,
      entry.prompt,
      entry.type,
      entry.numeric ? 'yes' : 'no',
      flattenLabels(entry.valueLabels),
      entry.missingCodes.map((m) => `${m.code}=${m.numeric ?? 'blank'}`).join('; '),
      entry.notes.join(' '),
    ] as Cell[]),
  ];

  const valueLabelSheet: Cell[][] = [
    ['variable', 'code', 'label'],
    ...dataset.valueLabels.map((v) => [v.variable, v.code, v.label] as Cell[]),
  ];

  const missingSheet: Cell[][] = [
    ['response_id', 'variable', 'question', 'missing_code', 'numeric_code'],
    ...dataset.missing.map((m) => [m.response, m.variable, m.question, m.code, MISSING_CODES[m.code].numeric ?? ''] as Cell[]),
  ];

  const metaSheet: Cell[][] = [
    ['key', 'value'],
    ['title', dataset.meta.title],
    ['form_version', dataset.meta.formVersion ?? ''],
    ['published_at', dataset.meta.publishedAt ?? ''],
    ['generated_at', dataset.meta.generatedAt],
    ['language', dataset.meta.language],
    ['multi_select', dataset.meta.multiSelect],
    ['responses', dataset.meta.responseCount],
    ...Object.entries(dataset.meta.byStatus).map(([status, count]) => [`responses_${status}`, count] as Cell[]),
    ['columns', dataset.meta.columnCount],
    ['missing_cells', dataset.meta.missingCount],
    ...dataset.meta.notes.map((note, i) => [`note_${i + 1}`, note] as Cell[]),
  ];

  const bytes = writeWorkbook({
    sheets: [
      { name: 'data', rows: dataSheet },
      { name: 'codebook', rows: codebookSheet },
      { name: 'value_labels', rows: valueLabelSheet },
      { name: 'missing', rows: missingSheet },
      { name: 'meta', rows: metaSheet },
    ],
  });

  return [
    {
      name: 'export.xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      bytes,
      description: 'One workbook: data, codebook, value_labels, missing and meta sheets. Text cells are strings, never formulas.',
    },
  ];
}

/* --------------------------------------------------------------------- json */

export interface JsonExport {
  meta: ExportDataset['meta'];
  columns: ExportDataset['columns'];
  codebook: ExportDataset['codebook'];
  valueLabels: ExportDataset['valueLabels'];
  missing: ExportDataset['missing'];
  data: Array<Record<string, Cell>>;
}

export function toJsonExport(dataset: ExportDataset): JsonExport {
  const names = dataset.columns.map((c) => c.variable);
  return {
    meta: dataset.meta,
    columns: dataset.columns,
    codebook: dataset.codebook,
    valueLabels: dataset.valueLabels,
    missing: dataset.missing,
    data: dataset.rows.map((row) => {
      const record: Record<string, Cell> = {};
      names.forEach((name, i) => {
        record[name] = row[i] ?? null;
      });
      return record;
    }),
  };
}

export function jsonBundle(dataset: ExportDataset): BundleFile[] {
  return [
    {
      name: 'export.json',
      contentType: 'application/json',
      bytes: strToU8(`${JSON.stringify(toJsonExport(dataset), null, 2)}\n`),
      description: 'Data plus the full codebook, value labels and missing-code table in one document.',
    },
  ];
}
