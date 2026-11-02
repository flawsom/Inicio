import { describe, expect, it } from 'vitest';
import {
  XLSFORM_VERSION_FORMULA,
  exportXlsForm,
  importXlsForm,
  xlsFormSheets,
  xlsFormWorkbook,
  type XlsFormBook,
} from '../src/adapters/xlsform.js';
import { readWorkbook, type CellValue, type OutSheet } from '../src/adapters/xlsx.js';
import { validateXlsFormSheets } from '../src/adapters/xlsform-validate.js';
import type { FormDefinition } from '../src/types.js';

/**
 * A form with one of each colour rule, all three audit fields, a group and a
 * select. Small enough to read, complete enough that every branch of the style
 * book has something to colour.
 */
const definition: FormDefinition = {
  title: 'Audit compile',
  defaultLanguage: 'en',
  languages: ['en'],
  groups: [{ id: 'g_admin', name: 'admin', label: { en: 'Admin' } }],
  questions: [
    {
      id: 'q1',
      groupId: 'g_admin',
      name: 'color',
      type: 'select_one',
      label: { en: 'Favourite colour' },
      required: true,
      choices: { listName: 'colors' },
    },
    { id: 'q2', name: 'notes', type: 'text', label: { en: 'Notes' }, rules: { visibleIf: '${color} = "red"' } },
    { id: 'q3', name: 'typing', type: 'calculate', label: {}, audit: { kind: 'text_audit', spec: 'p=25' } },
    {
      id: 'q4',
      name: 'recording',
      type: 'calculate',
      label: {},
      audit: { kind: 'audio_audit', spec: 'p=50; s=120-300; d=45' },
    },
    { id: 'q5', name: 'too_fast', type: 'calculate', label: {}, audit: { kind: 'speed_violations', spec: 'total=60' } },
  ],
  choiceLists: {
    colors: [
      { value: 'red', label: { en: 'Red' } },
      { value: 'blue', label: { en: 'Blue' } },
    ],
  },
  settings: { xlsform: { formId: 'audit_compile', version: '2611010900' } },
};

function sheet(book: XlsFormBook, name: string): OutSheet {
  const found = book.sheets.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`sheet ${name} missing`);
  return found;
}

function column(headers: CellValue[], name: string): number {
  const index = headers.findIndex((cell) => String(cell ?? '') === name);
  if (index < 0) throw new Error(`column ${name} missing`);
  return index;
}

function text(cell: CellValue): string {
  if (cell === null || cell === undefined) return '';
  if (typeof cell === 'object') return String(cell.cached);
  return String(cell);
}

describe('the six tab compiler', () => {
  it('writes exactly the six tabs, in reading order', () => {
    expect(xlsFormSheets(definition).sheets.map((entry) => entry.name)).toEqual([
      'survey', 'choices', 'settings', 'help-survey', 'help-choices', 'help-settings',
    ]);
  });

  it('has the exact 23 column SurveyCTO survey header', () => {
    const survey = sheet(xlsFormWorkbook(definition), 'survey');
    const headers = (survey.rows[0] ?? []).map(text);
    expect(headers).toEqual([
      'type', 'name', 'label', 'hint', 'default', 'appearance', 'constraint', 'constraint message',
      'relevance', 'disabled', 'required', 'required message', 'read only', 'calculation',
      'repeat_count', 'media:image', 'media:audio', 'media:video', 'choice_filter', 'note',
      'response_note', 'publishable', 'minimum_seconds',
    ]);
  });

  it('colours the key cells yellow, group rows peach and select rows green', () => {
    const survey = sheet(xlsFormWorkbook(definition), 'survey');
    const headers = survey.rows[0] ?? [];
    const nameColumn = column(headers, 'name');
    const typeColumn = column(headers, 'type');
    const styles = survey.styles ?? [];

    expect(styles[0]?.[nameColumn]).toBe('keyHeader');
    // Row 1 is begin_group: the whole row is peach.
    expect(text(survey.rows[1]?.[typeColumn] ?? '')).toBe('begin_group');
    expect(styles[1]?.[typeColumn]).toBe('group');
    // The select row is green, except its name cell, which is a key cell and wins.
    const selectRow = survey.rows.findIndex((row) => text(row[typeColumn] ?? '').startsWith('select_one'));
    expect(selectRow).toBeGreaterThan(0);
    expect(styles[selectRow]?.[typeColumn]).toBe('choice');
    expect(styles[selectRow]?.[nameColumn]).toBe('key');
    // A text row is plain, and its constraint_message cell is yellow.
    const textRow = survey.rows.findIndex((row) => text(row[nameColumn] ?? '') === 'notes');
    expect(styles[textRow]?.[typeColumn]).toBe('body');
    expect(styles[textRow]?.[column(headers, 'constraint message')]).toBe('key');
    expect(styles[textRow]?.[column(headers, 'choice_filter')]).toBe('key');
  });

  it('puts the live YYMMDDHHmm formula in settings C2 with the existing version cached', () => {
    const settings = sheet(xlsFormWorkbook(definition), 'settings');
    const headers = settings.rows[0] ?? [];
    const versionColumn = column(headers, 'version');
    const cell = settings.rows[1]?.[versionColumn];
    expect(cell).toEqual({ formula: XLSFORM_VERSION_FORMULA, cached: '2611010900' });
    expect(XLSFORM_VERSION_FORMULA).toContain('YEAR(NOW())');
    expect(XLSFORM_VERSION_FORMULA).toContain('MINUTE(NOW())');
  });

  it('leaves the cached version blank when the form has none, so a download round trips', () => {
    const withoutVersion: FormDefinition = {
      ...definition,
      settings: { xlsform: { formId: 'audit_compile' } },
    };
    const settings = sheet(xlsFormWorkbook(withoutVersion), 'settings');
    const versionColumn = column(settings.rows[0] ?? [], 'version');
    expect(settings.rows[1]?.[versionColumn]).toEqual({ formula: XLSFORM_VERSION_FORMULA, cached: '' });
  });

  it('can write a plain value instead of a formula for readers that cannot recalculate', () => {
    const settings = sheet(xlsFormWorkbook(definition, { versionFormula: false }), 'settings');
    const versionColumn = column(settings.rows[0] ?? [], 'version');
    expect(settings.rows[1]?.[versionColumn]).toBe('2611010900');
  });

  it('documents each sheet on its own help tab', () => {
    const book = xlsFormWorkbook(definition);
    for (const name of ['help-survey', 'help-choices', 'help-settings']) {
      const help = sheet(book, name);
      expect(help.rows.length).toBeGreaterThan(8);
      expect(text(help.rows[0]?.[0] ?? '')).toContain(name.replace('help-', ''));
    }
    const settingsHelp = sheet(book, 'help-settings');
    expect(settingsHelp.rows.some((row) => text(row[0] ?? '') === 'version')).toBe(true);
    const surveyHelp = sheet(book, 'help-survey');
    expect(surveyHelp.rows.some((row) => text(row[0] ?? '') === 'constraint message')).toBe(true);
    expect(surveyHelp.rows.some((row) => text(row[0] ?? '') === 'choice_filter')).toBe(true);
  });

  it('freezes the survey header and the first two columns', () => {
    const survey = sheet(xlsFormWorkbook(definition), 'survey');
    expect(survey.freeze).toEqual({ rows: 1, columns: 2 });
    expect(survey.widths?.length).toBe(survey.rows[0]?.length);
  });

  it('zips a workbook it can read back with all six tabs', () => {
    const file = exportXlsForm(definition);
    const parsed = readWorkbook(file.bytes);
    expect(parsed.sheets.map((entry) => entry.name)).toEqual([
      'survey', 'choices', 'settings', 'help-survey', 'help-choices', 'help-settings',
    ]);
    const settings = parsed.sheets.find((entry) => entry.name === 'settings');
    const versionColumn = column(settings?.rows[0] ?? [], 'version');
    expect(settings?.rows[1]?.[versionColumn]).toBe('2611010900');
  });

  it('round trips every audit field with its phrase and parameter string', () => {
    const imported = importXlsForm(exportXlsForm(definition).bytes).definition;
    const audit = (name: string) => imported.questions.find((question) => question.name === name)?.audit;
    expect(audit('typing')).toEqual({ kind: 'text_audit', spec: 'p=25' });
    expect(audit('recording')).toEqual({ kind: 'audio_audit', spec: 'p=50; s=120-300; d=45' });
    expect(audit('too_fast')).toEqual({ kind: 'speed_violations', spec: 'total=60' });
    expect(imported.settings?.['xlsform']).toMatchObject({ formId: 'audit_compile', version: '2611010900' });
  });

  it('compiles a workbook its own validator accepts', () => {
    const file = exportXlsForm(definition);
    const report = validateXlsFormSheets(readWorkbook(file.bytes).sheets);
    expect(report.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
  });
});
