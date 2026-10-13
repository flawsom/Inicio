import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { exportXlsForm, importXlsForm, xlsFormSheets } from '../src/adapters/xlsform.js';
import { readWorkbook, writeWorkbook, type OutSheet } from '../src/adapters/xlsx.js';
import type { FormDefinition } from '../src/types.js';
import { validateForm } from '../src/validate.js';

/**
 * The fixture is a realistic field survey: cascading selects with a choice_filter,
 * a repeat, a field-list group, ODK metadata types, a passthrough column the
 * canonical model has no field for, two languages, and XML-hostile text.
 */
const SURVEY_HEADER = [
  'type', 'name', 'label::English (en)', 'label::Hindi (hi)', 'hint::English (en)',
  'required', 'required_message', 'relevant', 'constraint', 'constraint_message',
  'calculation', 'choice_filter', 'appearance', 'default', 'read_only', 'repeat_count',
  'parameters', 'guidance_hint',
];

const SURVEY_ROWS: string[][] = [
  SURVEY_HEADER,
  ['begin_group', 'admin', 'Administration', 'प्रशासन', '', '', '', '', '', '', '', '', 'field-list'],
  ['start', 'start', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ['text', 'school_name', 'School name — official', 'विद्यालय का नाम', 'As printed on the board', 'yes', '', '', '', '', '', '', '', '', '', '', '', 'Enter it exactly'],
  ['select_one school_types', 'school_type', 'School type', 'विद्यालय प्रकार', '', 'yes', 'Choose one', '', '', '', '', '', 'minimal'],
  ['select_one states', 'state', 'State', 'राज्य', '', 'yes', '', '', '', '', '', '', '', '', '', '', '', ''],
  ['select_one districts', 'district', 'District', 'जिला', '', 'yes', '', '', '', '', '', 'state = ${state}', '', '', '', '', '', ''],
  ['end_group'],
  ['begin_group', 'metrics', 'Ranking metrics', 'रैंकिंग मानदंड', '', '', '', '', '', '', '', '', 'field-list'],
  ['integer', 'teacher_quality', 'Teacher quality (1-5)', 'शिक्षक गुणवत्ता', '', 'yes', '', '', '. >= 1 and . <= 5', 'Between 1 and 5', '', '', 'rating', '3'],
  ['select_multiple facilities', 'facilities', 'Facilities available', '', '', 'yes', '', '', '', '', '', '', '', '', '', '', 'randomize=true'],
  ['decimal', 'fee_annual', 'Annual fee (INR)', 'वार्षिक शुल्क', '', '', '', '${school_type} = "private"', '', '', '', '', '', '', '', '', '', 'Fee & charges <annual>'],
  ['note', 'thanks', 'Thank you', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ['end_group'],
  ['begin_repeat', 'contacts', 'Contacts', '', '', '', '', '', '', '', '', '', 'field-list', '', '', '', '', ''],
  ['text', 'contact_name', 'Contact name', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ['text', 'contact_phone', 'Contact phone', '', '', '', '10 digits', '', 'length(.) = 10', 'Exactly 10 digits', '', '', '', '', '', '', ''],
  ['end_repeat'],
  ['calculate', 'normalised_quality', 'Normalised quality', '', '', '', '', '', '', '', '${teacher_quality} * 20', '', '', '', '', ''],
  ['text', 'captured_by', 'Captured by', '', '', '', '', '', '', '', '', '', '', '', 'yes', '', '', ''],
];

const CHOICES_ROWS: string[][] = [
  ['list_name', 'name', 'label::English (en)', 'label::Hindi (hi)', 'state'],
  ['school_types', 'govt', 'Government', 'सरकारी', ''],
  ['school_types', 'private', 'Private', 'निजी', ''],
  ['states', 'ka', 'Karnataka', 'कर्नाटक', ''],
  ['states', 'mh', 'Maharashtra', 'महाराष्ट्र', ''],
  ['districts', 'ka_blr', "Bengaluru 'Urban'", 'बेंगलुरु', 'ka'],
  ['districts', 'mh_pun', 'Pune', 'पुणे', 'mh'],
  ['facilities', 'library', 'Library', '', ''],
  ['facilities', 'lab', 'Science lab', '', ''],
];

const SETTINGS_ROWS: string[][] = [
  ['form_title', 'School Ranking Survey 2026'],
  ['form_id', 'school_ranking_2026'],
  ['version', '2026091501'],
  ['default_language', 'en'],
  ['instance_name', '${school_name}'],
  ['style', 'pages'],
];

function workbookBytes(): Uint8Array {
  return writeWorkbook({
    sheets: [
      { name: 'survey', rows: SURVEY_ROWS },
      { name: 'choices', rows: CHOICES_ROWS },
      { name: 'settings', rows: SETTINGS_ROWS },
    ],
  });
}

describe('fixture integrity', () => {
  it('no survey row carries more values than there are columns', () => {
    // A hand-written fixture that drifts out of alignment silently tests the wrong
    // column (a row one cell too long shifts every value right), so the fixture is
    // checked before it is trusted. Short rows are fine — missing cells are blank.
    for (const [i, row] of SURVEY_ROWS.entries()) {
      expect(row.length, `survey row ${i + 1} is longer than the header`).toBeLessThanOrEqual(SURVEY_HEADER.length);
    }
    for (const [i, row] of CHOICES_ROWS.entries()) {
      expect(row.length, `choices row ${i + 1} is longer than the header`).toBeLessThanOrEqual(CHOICES_ROWS[0]!.length);
    }
  });
});

function find(def: FormDefinition, name: string) {
  const q = def.questions.find((x) => x.name === name);
  if (!q) throw new Error(`fixture question ${name} missing`);
  return q;
}

describe('xlsform import', () => {
  it('maps structure, types, languages and logic onto the canonical model', () => {
    const { definition: def, sheets, notes } = importXlsForm(workbookBytes());

    expect(sheets).toEqual(['survey', 'choices', 'settings']);
    expect(def.title).toBe('School Ranking Survey 2026');
    expect(def.defaultLanguage).toBe('en');
    expect(def.languages).toEqual(['en', 'hi']);

    expect(def.groups.map((g) => [g.name, g.repeat, g.appearance])).toEqual([
      ['admin', false, 'field-list'],
      ['metrics', false, 'field-list'],
      ['contacts', true, 'field-list'],
    ]);

    const schoolType = find(def, 'school_type');
    expect(schoolType.type).toBe('select_one');
    expect(schoolType.choices?.listName).toBe('school_types');
    expect(schoolType.required).toBe(true);
    expect(schoolType.appearance).toBe('minimal');
    expect(schoolType.label['hi']).toBe('विद्यालय प्रकार');

    const district = find(def, 'district');
    expect(district.rules?.choiceFilter).toBe('state = ${state}');
    expect(def.choiceLists['districts']?.find((c) => c.value === 'ka_blr')?.extra).toEqual({ state: 'ka' });
    expect(def.choiceLists['districts']?.find((c) => c.value === 'ka_blr')?.label['en']).toBe("Bengaluru 'Urban'");

    const quality = find(def, 'teacher_quality');
    expect(quality.validation?.constraint).toBe('. >= 1 and . <= 5');
    expect(quality.validation?.message?.['en']).toBe('Between 1 and 5');
    expect(quality.defaultValue).toBe(3);

    const fee = find(def, 'fee_annual');
    expect(fee.rules?.visibleIf).toBe('${school_type} = "private"');
    expect(fee.required).toBe(false);

    const phone = find(def, 'contact_phone');
    expect(phone.validation?.constraint).toBe('length(.) = 10');
    expect(phone.groupId).toBe('g_contacts');

    expect(find(def, 'thanks').type).toBe('note');
    expect(find(def, 'normalised_quality').rules?.calculate).toBe('${teacher_quality} * 20');
    expect(find(def, 'captured_by').rules?.enableIf).toBe('false');

    // ODK metadata: preserved verbatim, collected as a calculation.
    const start = find(def, 'start');
    expect(start.type).toBe('calculate');
    expect(start.rules?.calculate).toBe('now()');
    expect(start.source).toEqual({ adapter: 'xlsform', type: 'start' });
    expect(notes.some((n) => n.kind === 'preserved' && n.message.includes('"start"'))).toBe(true);

    // A column the canonical model does not model is kept, not dropped...
    expect(find(def, 'facilities').source?.columns).toEqual({ parameters: 'randomize=true' });
    // ...and the fact that we do not act on it is reported, not hidden.
    expect(notes.some((n) => n.kind === 'lossy' && n.message.includes('parameters'))).toBe(true);
    expect(notes.some((n) => n.kind === 'lossy' && n.message.includes('guidance_hint'))).toBe(true);

    // settings, including keys we do not understand.
    expect(def.settings?.['xlsform']).toMatchObject({
      formId: 'school_ranking_2026',
      version: '2026091501',
      instanceName: '${school_name}',
      extra: { style: 'pages' },
    });
  });

  it('produces a form the publish-time analyser accepts', () => {
    const { definition } = importXlsForm(workbookBytes());
    const report = validateForm(definition);
    expect(report.errors).toEqual([]);
  });

  it('round-trips: import(export(import(x))) ≡ import(x)', () => {
    const first = importXlsForm(workbookBytes()).definition;
    const exported = exportXlsForm(first);
    const second = importXlsForm(exported.bytes);

    expect(second.definition).toEqual(first);
    expect(second.definition.title).toBe(first.title);
  });

  it('round-trips through its own XLSForm output repeatedly (fixpoint stable)', () => {
    let def = importXlsForm(workbookBytes()).definition;
    for (let i = 0; i < 3; i++) def = importXlsForm(exportXlsForm(def).bytes).definition;
    expect(def).toEqual(importXlsForm(exportXlsForm(importXlsForm(workbookBytes()).definition).bytes).definition);
  });

  /**
   * A trailing empty cell is not a thing a spreadsheet can store, so a sheet that
   * round-tripped through the file comes back one cell narrower on some rows. It
   * carries no information, which is why this comparison is made modulo it.
   */
  const withoutTrailingBlanks = (sheets: OutSheet[]): OutSheet[] =>
    sheets.map((sheet) => ({
      name: sheet.name,
      rows: sheet.rows.map((row) => {
        const trimmed = [...row];
        while (trimmed.length > 0 && trimmed[trimmed.length - 1] === '') trimmed.pop();
        return trimmed;
      }),
    }));

  it('hands the viewer the same rows the file is zipped from', () => {
    const def = importXlsForm(workbookBytes()).definition;
    const { sheets, notes } = xlsFormSheets(def);
    const exported = exportXlsForm(def);

    // The viewer is not a second implementation of the export: it *is* the export,
    // minus the zip. Comparing it against the parsed file is what keeps that true —
    // a screen that agreed with the download by coincidence would eventually stop.
    expect(withoutTrailingBlanks(readWorkbook(exported.bytes).sheets)).toEqual(withoutTrailingBlanks(sheets));
    expect(sheets.map((sheet) => sheet.name)).toEqual(['survey', 'choices', 'settings']);
    expect(notes).toEqual(exported.notes);

    // And the rows are the form's own questions, not a placeholder table.
    const survey = sheets.find((sheet) => sheet.name === 'survey');
    const names = (survey?.rows ?? []).slice(1).map((row) => row[1]);
    for (const question of def.questions) expect(names).toContain(question.name);
  });

  it('reads inline strings, sparse rows and self-closing cells', () => {
    // Hand-built package: ODK/Kobo writers emit inline strings and omit empty rows.
    const sheetXml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>',
      '<row r="1">',
      '<c r="A1" t="inlineStr"><is><t>type</t></is></c>',
      '<c r="B1" t="inlineStr"><is><t>name</t></is></c>',
      '<c r="C1" t="inlineStr"><is><t>label</t></is></c>',
      '<c r="D1" t="inlineStr"><is><t>relevant</t></is></c>',
      '</row>',
      '<row r="2"><c r="A2" t="inlineStr"><is><t>text</t></is></c><c r="B2" t="inlineStr"><is><t>q_one</t></is></c><c r="C2" t="inlineStr"><is><t>One &amp; only &lt;first&gt;</t></is></c><c r="D2"/></row>',
      // row 3 intentionally absent (sparse)
      '<row r="4"><c r="A4" t="inlineStr"><is><t>integer</t></is></c><c r="B4" t="inlineStr"><is><t>q_two</t></is></c><c r="C4" t="inlineStr"><is><t>Two</t></is></c><c r="D4" t="inlineStr"><is><t>${q_one} != &quot;&quot;</t></is></c><c r="E4"/></row>',
      '</sheetData></worksheet>',
    ].join('');
    const bytes = zipSync({
      '[Content_Types].xml': strToU8(
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/></Types>',
      ),
      '_rels/.rels': strToU8(
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      ),
      'xl/workbook.xml': strToU8(
        '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
          'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          '<sheets><sheet name="survey" sheetId="1" r:id="rId1"/></sheets></workbook>',
      ),
      'xl/_rels/workbook.xml.rels': strToU8(
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
      ),
      'xl/worksheets/sheet1.xml': strToU8(sheetXml),
    });

    const { definition: def, notes } = importXlsForm(bytes);
    expect(def.questions).toHaveLength(2);
    expect(def.questions[0]?.label['en']).toBe('One & only <first>');
    expect(def.questions[1]?.rules?.visibleIf).toBe('${q_one} != ""');
    expect(notes.some((n) => n.kind === 'normalised' && n.message.includes('no `settings` sheet'))).toBe(true);
  });

  it('rejects a workbook that is not an XLSForm, naming the sheets it found', () => {
    const bytes = writeWorkbook({ sheets: [{ name: 'Sheet1', rows: [['hello']] }] });
    expect(() => importXlsForm(bytes)).toThrow(/no "survey" sheet found \(workbook has: Sheet1\)/);
  });

  it('reports what it had to change instead of failing silently', () => {
    const bytes = writeWorkbook({
      sheets: [
        {
          name: 'survey',
          rows: [
            ['type', 'name', 'label'],
            ['select_one', 'choices_missing', 'No list'],
            ['mycustomtype', 'weird', 'Unknown type'],
            ['end_group', '', ''],
            ['text', 'has a space', 'Bad name'],
          ],
        },
      ],
    });
    const { definition: def, notes } = importXlsForm(bytes);
    const kinds = notes.map((n) => n.kind);
    expect(kinds).toContain('unsupported'); // select_one without a list / unknown type
    expect(kinds).toContain('dropped'); // orphan end_group
    expect(kinds).toContain('normalised'); // invalid identifier
    expect(def.questions.map((q) => q.name)).toEqual(['choices_missing', 'weird', 'has_a_space']);
  });
});
