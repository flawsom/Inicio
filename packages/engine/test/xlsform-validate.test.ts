import { describe, expect, it } from 'vitest';
import {
  checkUpload,
  compareVersions,
  validateXlsFormSheets,
} from '../src/adapters/xlsform-validate.js';
import type { Sheet } from '../src/adapters/xlsx.js';

const surveyHeader = ['type', 'name', 'label', 'required', 'relevant', 'appearance'];
const settingsHeader = ['form_title', 'form_id', 'version'];

function validSheets(): Sheet[] {
  return [
    {
      name: 'survey',
      rows: [
        surveyHeader,
        ['begin_group', 'admin', 'Admin', '', '', ''],
        ['select_one colors', 'color', 'Favourite colour', 'yes', '', 'minimal'],
        ['end_group'],
        ['text audit', 'typing', '', '', '', 'p=25'],
      ],
    },
    {
      name: 'choices',
      rows: [
        ['list_name', 'name', 'label'],
        ['colors', 'red', 'Red'],
        ['colors', 'blue', 'Blue'],
      ],
    },
    {
      name: 'settings',
      rows: [settingsHeader, ['Colour survey', 'colour_survey', '2611010900']],
    },
  ];
}

describe('workbook validation', () => {
  it('accepts a complete workbook and reports no errors', () => {
    const report = validateXlsFormSheets(validSheets());
    expect(report.errors).toBe(0);
    expect(report.valid).toBe(true);
    expect(report.sheetNames).toEqual(['survey', 'choices', 'settings']);
  });

  it('addresses a diagnostic by sheet, row and cell', () => {
    const sheets = validSheets();
    // A second question named `color`, with a reference to a question that does not exist.
    sheets[0]!.rows.push(['text', 'color', 'Again', '', '${missing} = 1', '']);
    const report = validateXlsFormSheets(sheets);
    const duplicate = report.diagnostics.find((diagnostic) => diagnostic.code === 'duplicate-name');
    expect(duplicate).toMatchObject({ sheet: 'survey', row: 6, column: 'name', cell: 'B6' });

    const unknown = report.diagnostics.find((diagnostic) => diagnostic.code === 'unknown-reference');
    expect(unknown).toMatchObject({ sheet: 'survey', row: 6, column: 'relevant', cell: 'E6' });
  });

  it('catches an unbalanced group and names the row that opened it', () => {
    const sheets = validSheets();
    sheets[0]!.rows.splice(3, 1); // remove end_group
    const report = validateXlsFormSheets(sheets);
    const unclosed = report.diagnostics.find((diagnostic) => diagnostic.code === 'unclosed-group');
    expect(unclosed?.row).toBe(2);
    expect(unclosed?.message).toContain('never closed');
  });

  it('catches an end without a begin', () => {
    const sheets = validSheets();
    sheets[0]!.rows.push(['end_repeat']);
    const report = validateXlsFormSheets(sheets);
    expect(report.diagnostics.some((diagnostic) => diagnostic.code === 'unbalanced-end')).toBe(true);
    expect(report.diagnostics.some((diagnostic) => diagnostic.code === 'mismatched-end')).toBe(false);
  });

  it('rejects a select that names a list the choices sheet does not have', () => {
    const sheets = validSheets();
    sheets[0]!.rows[2] = ['select_one districts', 'district', 'District', 'yes', '', ''];
    const report = validateXlsFormSheets(sheets);
    const listError = report.diagnostics.find((diagnostic) => diagnostic.code === 'unknown-choice-list');
    expect(listError?.row).toBe(3);
    expect(listError?.message).toContain('districts');
  });

  it('rejects a duplicate choice and a choice with no name', () => {
    const sheets = validSheets();
    sheets[1]!.rows.push(['colors', 'red', 'Red again'], ['colors', '', 'Nameless']);
    const report = validateXlsFormSheets(sheets);
    expect(report.diagnostics.some((diagnostic) => diagnostic.code === 'duplicate-choice')).toBe(true);
    expect(report.diagnostics.some((diagnostic) => diagnostic.code === 'choice-without-name')).toBe(true);
  });

  it('reports expression syntax, bare names and self references', () => {
    const sheets = validSheets();
    sheets[0]!.rows.push(
      ['text', 'broken', 'Broken', '', '(', ''],
      ['text', 'bare', 'Bare', '', '', ''],
      ['calculate', 'loop', 'Loop', '', '', ''],
    );
    // Give `bare` an expression with a name that is not a reference, and make `loop` self-referential.
    sheets[0]!.rows[7] = ['text', 'bare', 'Bare', '', 'colour = 1', ''];
    sheets[0]!.rows[8] = ['calculate', 'loop', 'Loop', '', '${loop} + 1', ''];

    const report = validateXlsFormSheets(sheets);
    expect(report.diagnostics.some((diagnostic) => diagnostic.code === 'expression')).toBe(true);
    expect(report.diagnostics.some((diagnostic) => diagnostic.code === 'bare-name')).toBe(true);
    expect(report.diagnostics.some((diagnostic) => diagnostic.code === 'self-reference')).toBe(true);
  });

  it('checks the audit parameter string in the appearance column', () => {
    const sheets = validSheets();
    sheets[0]!.rows[4] = ['audio audit', 'recording', '', '', '', 'p=25; s=60'];
    const report = validateXlsFormSheets(sheets);
    const auditError = report.diagnostics.find((diagnostic) => diagnostic.code === 'audit-spec');
    expect(auditError?.row).toBe(5);
    expect(auditError?.message).toContain('needs a duration');
  });

  it('warns about a missing version without refusing the workbook', () => {
    const sheets = validSheets();
    (sheets[2]!.rows[1] as string[])[2] = '';
    const report = validateXlsFormSheets(sheets);
    expect(report.valid).toBe(true);
    expect(report.diagnostics.some((diagnostic) => diagnostic.code === 'missing-version')).toBe(true);
  });

  it('accepts a key/value settings sheet from an older workbook', () => {
    const sheets = validSheets().slice(0, 2);
    sheets.push({
      name: 'settings',
      rows: [
        ['form_title', 'Colour survey'],
        ['form_id', 'colour_survey'],
        ['version', '2611010900'],
      ],
    });
    expect(validateXlsFormSheets(sheets).errors).toBe(0);
  });

  it('names the sheets that are present when the survey sheet is missing', () => {
    const report = validateXlsFormSheets([{ name: 'choices', rows: [['list_name', 'name']] }]);
    expect(report.errors).toBe(1);
    expect(report.diagnostics[0]?.code).toBe('missing-survey');
    expect(report.sheetNames).toEqual(['choices']);
  });

  it('does not treat a name that matches a question declared later as unknown', () => {
    const sheets = validSheets();
    sheets[0]!.rows.splice(1, 0, ['text', 'first', 'First', '', '${color} = "red"', '']);
    expect(validateXlsFormSheets(sheets).diagnostics.some((diagnostic) => diagnostic.code === 'unknown-reference')).toBe(false);
  });
});

describe('upload guards', () => {
  it('uses the exact duplicate form id sentence', () => {
    const result = checkUpload({ formId: 'household_2026', version: '2611011200', conflictingFormId: 'household_2026' });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toBe(
      "Your form definition specifies a form ID (household_2026) that already exists. " +
        "If you would like to update that existing form, please use the 'Upload' option for that form.",
    );
  });

  it('uses the exact non-monotonic version sentence', () => {
    const same = checkUpload({ formId: 'household_2026', version: '2611011200', currentVersion: '2611011200' });
    expect(same.errors[0]).toBe(
      'Your uploaded form version (2611011200) is not newer than existing form version (2611011200). ' +
        'Update the form version and resubmit.',
    );

    const older = checkUpload({ formId: 'household_2026', version: '2610310900', currentVersion: '2611011200' });
    expect(older.ok).toBe(false);
  });

  it('allows a newer version, and a first version when none exists', () => {
    expect(checkUpload({ formId: 'hh', version: '2611011201', currentVersion: '2611011200' }).ok).toBe(true);
    expect(checkUpload({ formId: 'hh', version: '2611011200' }).ok).toBe(true);
  });

  it('does not refuse a blank version at creation when asked not to', () => {
    expect(checkUpload({ formId: 'hh', version: '', requireVersion: false }).ok).toBe(true);
    expect(checkUpload({ formId: 'hh', version: '' }).ok).toBe(false);
  });

  it('compares stamps numerically, not as floats', () => {
    expect(compareVersions('2611011200', '2611011200')).toBe(0);
    expect(compareVersions('2611011201', '2611011200')).toBe(1);
    expect(compareVersions('999999999', '2611011200')).toBe(-1);
    expect(compareVersions('2026-11-01', '2026-10-31')).toBeGreaterThan(0);
  });
});
