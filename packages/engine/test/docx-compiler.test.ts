import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { compileDocx, readDocx } from '../src/index.js';
import { readWorkbook } from '../src/adapters/xlsx.js';

function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function paragraph(text: string, bold = false): string {
  return `<w:p><w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`;
}

function table(rows: string[][]): string {
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr>${rows
    .map((row) => `<w:tr>${row.map((cell) => `<w:tc>${paragraph(cell)}</w:tc>`).join('')}</w:tr>`)
    .join('')}</w:tbl>`;
}

function docx(blocks: string[]): Uint8Array {
  const document =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${blocks.join('')}<w:sectPr/></w:body></w:document>`;
  return zipSync({
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '</Types>',
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '</Relationships>',
    ),
    'word/document.xml': strToU8(document),
  });
}

const GRID: string[][] = [
  ['Education (SQ5) Total Number of Durables', 'Illiterate', 'School 1-4', 'School 5-9', 'SSC/HSC', 'Some college', 'Graduate', 'Postgraduate'],
  ['', '1', '2', '3', '4', '5', '6', '7'],
  ['None', 'E3', 'E2', 'E2', 'E2', 'E2', 'E1', 'D2'],
  ['1', 'E2', 'E1', 'E1', 'E1', 'D2', 'D2', 'D2'],
  ['2', 'E1', 'E1', 'D2', 'D2', 'D1', 'D1', 'D1'],
  ['3', 'D2', 'D2', 'D1', 'D1', 'C2', 'C2', 'C2'],
  ['4', 'D1', 'C2', 'C2', 'C1', 'C1', 'B2', 'B2'],
  ['5', 'C2', 'C1', 'C1', 'B2', 'B1', 'B1', 'B1'],
  ['6', 'C1', 'B2', 'B2', 'B1', 'A3', 'A3', 'A3'],
  ['7', 'C1', 'B1', 'B1', 'A3', 'A3', 'A2', 'A2'],
  ['8', 'B1', 'A3', 'A3', 'A3', 'A2', 'A2', 'A2'],
  ['9+', 'B1', 'A3', 'A3', 'A2', 'A2', 'A1', 'A1'],
];

const FIXTURE = docx([
  paragraph('PROJECT: COMPILER BENCH'),
  paragraph('MAIN QUESTIONNAIRE', true),
  table([
    ['Interviewer Name', ''],
    ['Respondent Name', ''],
    ['Respondent Phone no.', ''],
    ['Respondent Address', ''],
    ['Starting Point', ''],
  ]),
  paragraph('SQ1. Do you work for a market research agency? SA'),
  table([
    ['Yes', '1', 'TERMINATE'],
    ['No', '2', 'CONTINUE'],
  ]),
  paragraph('SQ2. What is your age? _____ years old. RECORD VERBATIM.'),
  table([
    ['19 years and below', '1', 'TERMINATE'],
    ['20 - 24 years', '2', 'CONTINUE'],
    ['25 - 35 years', '3', 'CONTINUE'],
    ['36 years and above', '4', 'TERMINATE'],
  ]),
  paragraph('SQ3. Which brand comes to mind? SA. ROTATE OPTIONS'),
  table([
    ['Alpha', '1', ''],
    ['Beta', '2', ''],
    ['Other (specify)', '99', ''],
  ]),
  paragraph('SQ4. Which channels do you use? MA'),
  table([
    ['Television', '1', ''],
    ['Radio', '2', ''],
    ['None of these', '99', ''],
  ]),
  paragraph('SQ5. What is the highest education of the Chief Wage Earner? SA'),
  table([
    ['Illiterate', '01'],
    ['Schooling up to 4 years', '02'],
    ['Schooling 5 to 9 years', '03'],
    ['SSC / HSC', '04'],
    ['Some college', '05'],
    ['Graduate', '06'],
    ['Postgraduate', '07'],
  ]),
  paragraph('SQ6. Which of the items do you have at your home? MA'),
  table([
    ['Electricity', '01'],
    ['Fan', '02'],
    ['Stove', '03'],
    ['Two-wheeler', '04'],
    ['Colour TV', '05'],
    ['Refrigerator', '06'],
    ['Washing machine', '07'],
    ['Computer', '08'],
    ['Car', '09'],
    ['Air conditioner', '10'],
  ]),
  table(GRID),
  table([
    ['NCCS A1', 'NCCS A2', 'NCCS A3', 'NCCS B1'],
    ['1', '2', '3', '4'],
    ['CONTINUE', 'CONTINUE', 'CONTINUE', 'TERMINATE'],
  ]),
  paragraph('MQ2a. Which of these brands have you heard of? MA. ROTATE OPTIONS'),
  table([
    ['Brand', 'MQ2a', 'MQ2b', 'MQ2c', 'MQ2d', 'MQ2e'],
    ['', 'Aided', 'Ever Purchased', 'L2Y', 'Last Purchase', 'MOUB'],
    ['Alpha', '1', '1', '1', '1', '1'],
    ['Beta', '2', '2', '2', '2', '2'],
  ]),
  paragraph('MQ8. Statements about brands. ROTATE STATEMENTS'),
  table([
    ['Statement', '1', '2', '3'],
    ['Is trustworthy', '', '', ''],
    ['Is modern', '', '', ''],
  ]),
  paragraph('PLEASE CAPTURE GEOPOINT AT THE END. AUDIO AUDIT THE MAIN SECTION.'),
]);

function byName(definition: Awaited<ReturnType<typeof compileDocx>>['definition'], name: string) {
  const question = definition.questions.find((candidate) => candidate.name === name);
  if (!question) throw new Error(`question ${name} missing`);
  return question;
}

describe('the Word to XLSForm compiler', () => {
  it('reads paragraphs and tables in document order', () => {
    const document = readDocx(FIXTURE);
    expect(document.blocks[0]?.kind).toBe('paragraph');
    expect(document.blocks[2]?.kind).toBe('table');
    if (document.blocks[2]?.kind === 'table') {
      expect(document.blocks[2].table.rows[0]?.[0]?.text).toBe('Interviewer Name');
    }
  });

  it('writes the six benchmark sheets and the 23 survey columns', () => {
    const result = compileDocx(FIXTURE, { projectNumber: 1234, now: new Date('2026-11-02T03:59:00Z') });
    expect(result.book.sheets.map((sheet) => sheet.name)).toEqual([
      'survey', 'choices', 'settings', 'help-survey', 'help-choices', 'help-settings',
    ]);
    const survey = result.book.sheets.find((sheet) => sheet.name === 'survey')!;
    expect(survey.rows[0]).toEqual([
      'type', 'name', 'label', 'hint', 'default', 'appearance', 'constraint', 'constraint message',
      'relevance', 'disabled', 'required', 'required message', 'read only', 'calculation',
      'repeat_count', 'media:image', 'media:audio', 'media:video', 'choice_filter', 'note',
      'response_note', 'publishable', 'minimum_seconds',
    ]);
    const settings = result.book.sheets.find((sheet) => sheet.name === 'settings')!;
    expect(settings.rows[0]).toEqual([
      'form_title', 'form_id', 'version', 'public_key', 'submission_url', 'default_language',
    ]);
    expect(settings.rows[1]?.slice(0, 2)).toEqual(['COMPILER BENCH', 'GDN01234_COMPILER_BENCH']);
    expect(settings.rows[1]?.[2]).toEqual({ formula: expect.stringContaining('YEAR(NOW())'), cached: '2611020359' });
    expect(settings.rows[1]?.[5]).toBe('english');
  });

  it('adds the benchmark regional columns in the same order as the workbooks', () => {
    const result = compileDocx(FIXTURE, { projectNumber: 1234, languages: ['Marathi'] });
    const survey = result.book.sheets.find((sheet) => sheet.name === 'survey')!;
    expect(survey.rows[0]?.slice(23)).toEqual([
      'label:Marathi', 'constraint message:Marathi', 'media:image:Marathi',
    ]);
    const choices = result.book.sheets.find((sheet) => sheet.name === 'choices')!;
    expect(choices.rows[0]).toEqual([
      'list_name', 'label', 'value', 'image', 'filter', 'label:Marathi', 'image:Marathi',
    ]);
  });

  it('compiles metadata, intro validation, age post-codes and a screener gate', () => {
    const result = compileDocx(FIXTURE, { projectNumber: 1234 });
    const def = result.definition;
    expect(def.questions.slice(0, 8).map((question) => question.source?.type ?? question.type)).toEqual([
      'start', 'end', 'deviceid', 'phonenumber', 'username', 'calculate', 'calculate', 'caseid',
    ]);
    expect(byName(def, 'int_name').validation?.constraint).toContain('regex');
    expect(byName(def, 'resp_no').validation?.constraint).toContain('string-length');
    expect(byName(def, 'st_point').validation?.constraint).toBe('(.) >= 1 and (.) <= 99');
    expect(byName(def, 'sq2').type).toBe('integer');
    expect(byName(def, 'age_grp').rules?.calculate).toContain('${sq2} <= 24');
    expect(byName(def, 'age_term').rules?.calculate).toContain("selected(${age_grp}, '2')");
    expect(byName(def, 'age_dis').rules?.calculate).toContain('20 - 24 years');
    expect(byName(def, 'glob_term').rules?.calculate).toContain("selected(${sq1}, '2')");
    expect(byName(def, 'glob_term').rules?.calculate).toContain("selected(${age_term}, '1')");
    expect(result.report.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
  });

  it('compiles NCCS, other-specify metadata and the exclusive option constraint', () => {
    const result = compileDocx(FIXTURE, { projectNumber: 1234 });
    const def = result.definition;
    expect(byName(def, 'sq6_total').rules?.calculate).toBe('count-selected(${sq6})');
    expect(byName(def, 'sech').rules?.calculate).toContain("'E3'");
    expect(byName(def, 'sech').rules?.calculate).toContain("'A1'");
    expect(byName(def, 'nccs_term').rules?.calculate).toContain("selected(${sech}, 'A1')");
    expect(byName(def, 'n_nccs').label.english).toBe('NCCS : ${sech}');
    expect(byName(def, 'sq3').appearance).toContain("custom-specify-other(other='99')");
    expect(byName(def, 'sq3_oth').rules?.calculate).toBe("item-at('|', plug-in-metadata(${sq3}), 1)");
    expect(byName(def, 'sq3_oth').rules?.visibleIf).toBe("selected(${sq3}, '99')");
    expect(byName(def, 'sq4').validation?.constraint).toContain('selected(.,99)');
    expect(byName(def, 'sq4').validation?.message?.english).toContain("Can't be selected");
  });

  it('compiles a brand cascade, a rotation draw and field quality gates', () => {
    const result = compileDocx(FIXTURE, { projectNumber: 1234 });
    const def = result.definition;
    for (const name of ['mq2a', 'mq2b', 'mq2c', 'mq2d', 'mq2e']) expect(byName(def, name).type).toBeDefined();
    expect(byName(def, 'mq2b').rules?.choiceFilter).toBe('selected(${mq2a}, filter)');
    expect(byName(def, 'mq12a_all').rules?.calculate).toContain('concat(');
    expect(byName(def, 'ad_num1').rules?.calculate).toBe('once(random())');
    expect(byName(def, 'rot').rules?.calculate).toContain('string(int(');
    expect(byName(def, 'audio_audit').audit?.kind).toBe('audio_audit');
    expect(byName(def, 'geopoint').type).toBe('geopoint');
    expect(result.report.rules.find((rule) => rule.id === 8)?.status).toBe('applied');
  });

  it('turns a statement grid into one choice field per statement', () => {
    const result = compileDocx(docx([
      paragraph('PROJECT: MATRIX TEST'),
      table([
        ['DQ1. How much do you agree with each statement? SA'],
        ['', 'Strongly disagree', 'Disagree', 'Neither', 'Agree', 'Strongly agree'],
        ['The store was clean.', '', '', '', '', ''],
        ['The staff were helpful.', '', '', '', '', ''],
      ]),
    ]), { projectNumber: 1608 });
    const clean = result.definition.questions.find((entry) => entry.name.includes('store_was_clean'));
    const staff = result.definition.questions.find((entry) => entry.name.includes('staff_were_helpful'));
    expect(clean?.type).toBe('select_one');
    expect(staff?.type).toBe('select_one');
    expect(result.definition.choiceLists[clean?.choices?.listName ?? '']?.map((choice) => choice.label.english)).toEqual([
      'Strongly disagree', 'Disagree', 'Neither', 'Agree', 'Strongly agree',
    ]);
    const group = result.definition.groups.find((entry) => entry.id === clean?.groupId);
    expect(group?.label.english).toBe('How much do you agree with each statement? SA');
    expect(group?.appearance).toBe('field-list');
    expect(clean?.appearance).toContain('label');
    expect(staff?.appearance).toContain('list-nolabel');
  });

  it('reads a rating scale written as labels above codes', () => {
    const result = compileDocx(docx([
      paragraph('PROJECT: SCALE TEST'),
      table([
        ['DQ2. How would you rate the store? SA'],
        ['Very poor', 'Poor', 'Neither', 'Good', 'Very good'],
        ['1', '2', '3', '4', '5'],
      ]),
    ]), { projectNumber: 1608 });
    const question = result.definition.questions.find((entry) => entry.name === 'dq2');
    expect(question?.type).toBe('select_one');
    expect(result.definition.choiceLists[question?.choices?.listName ?? '']?.map((choice) => choice.label.english)).toEqual([
      'Very poor', 'Poor', 'Neither', 'Good', 'Very good',
    ]);
  });

  it('skips section banners that Word stores in one-cell tables', () => {
    const result = compileDocx(docx([
      paragraph('PROJECT: SECTION TEST'),
      table([['MAIN QUESTIONNAIRE']]),
      paragraph('S1. Which city do you deliver in? SA'),
      table([['Bengaluru', '1'], ['Delhi NCR', '2']]),
    ]), { projectNumber: 1608 });
    expect(result.definition.questions.some((question) => question.name === 'main_questionnaire')).toBe(false);
    expect(result.definition.questions.some((question) => question.label.english === 'MAIN QUESTIONNAIRE')).toBe(false);
  });

  it('extracts the field code from a routing instruction before the question', () => {
    const result = compileDocx(docx([
      paragraph('PROJECT: CODE TEST'),
      paragraph('ASK FOR BRANDS CODED IN TOM MQ3. Which brand would you consider? SA'),
      table([['Alpha', '1'], ['Beta', '2']]),
    ]), { projectNumber: 1608 });
    const question = result.definition.questions.find((entry) => entry.name === 'mq3');
    expect(question?.type).toBe('select_one');
    expect(question?.label.english).toBe('Which brand would you consider? SA');

    const routed = compileDocx(docx([
      paragraph('PROJECT: CODE TEST'),
      paragraph('ASK FOR PEOPLE CODED 12 IN MQ2b. DQ2. How would you rate the store? SA'),
      table([['Good', '1'], ['Poor', '2']]),
    ]), { projectNumber: 1608 });
    const second = routed.definition.questions.find((entry) => entry.name === 'dq2');
    expect(second?.type).toBe('select_one');
    expect(second?.label.english).toBe('How would you rate the store? SA');
  });

  it('compiles X/Y statement rotation as two real pages and a harmonised answer', () => {
    const result = compileDocx(docx([
      paragraph('PROJECT: ROTATION TEST'),
      paragraph('D1. Please rate each statement. ROTATE STATEMENTS'),
      table([
        ['Statement', '1', '2', '3'],
        ['The app is easy to use', '', '', ''],
        ['Support is helpful', '', '', ''],
      ]),
    ]), { projectNumber: 1608 });
    const def = result.definition;
    expect(byName(def, 'ad_num1').rules?.calculate).toBe('once(random())');
    expect(byName(def, 'rot').rules?.calculate).toContain('string(int(');
    expect(def.groups.find((group) => group.name === 'bg_d1_x')?.rules?.visibleIf).toContain("selected(${rot}, '1')");
    expect(def.groups.find((group) => group.name === 'bg_d1_y')?.rules?.visibleIf).toContain("selected(${rot}, '2')");
    expect(byName(def, 'd1_x1').label.english).toBe('The app is easy to use');
    expect(byName(def, 'd1_y1').label.english).toBe('The app is easy to use');
    expect(def.questions.filter((question) => question.groupId === 'g_bg_d1_y').map((question) => question.label.english)).toEqual([
      'Support is helpful',
      'The app is easy to use',
    ]);
    expect(byName(def, 'd1_1').rules?.calculate).toBe('coalesce(${d1_x1}, ${d1_y1})');
    expect(result.report.rules.find((rule) => rule.id === 10)?.status).toBe('applied');
  });

  it('compiles MaxDiff as a most/least pair with a real exclusion', () => {
    const result = compileDocx(docx([
      paragraph('PROJECT: MAXDIFF TEST'),
      paragraph('D2. Which promo is most likely and least likely? MaxDiff'),
      table([
        ['Most Likely to buy', '', 'Least Likely to buy'],
        ['1', 'Promo A', '1'],
        ['2', 'Promo B', '2'],
        ['3', 'Promo C', '3'],
      ]),
    ]), { projectNumber: 1608 });
    const def = result.definition;
    expect(byName(def, 'd2_most').type).toBe('select_one');
    expect(byName(def, 'd2_least').type).toBe('select_one');
    expect(byName(def, 'd2_least').rules?.choiceFilter).toBe('not(selected(${d2_most}, filter))');
    expect(def.choiceLists['d2']?.map((choice) => choice.value)).toEqual(['1', '2', '3']);
    expect(def.groups.find((group) => group.name === 'bg_d2')?.appearance).toBe('field-list');
  });

  it('compiles rank columns with unique choices and duplicate filtering', () => {
    const result = compileDocx(docx([
      paragraph('PROJECT: RANK TEST'),
      paragraph('D3. Please rank these items.'),
      table([
        ['Item', 'Rank 1', 'Rank 2'],
        ['Alpha', '1', '1'],
        ['Beta', '2', '2'],
        ['Gamma', '3', '3'],
      ]),
    ]), { projectNumber: 1608 });
    const def = result.definition;
    expect(def.choiceLists['d3']?.map((choice) => choice.value)).toEqual(['1', '2', '3']);
    expect(byName(def, 'd3_2').rules?.choiceFilter).toBe('not(selected(${d3_1}, filter))');
    expect(byName(def, 'd3_1').appearance).toBe('quick');
  });

  it('reads regional language columns when the source supplies translations', () => {
    const result = compileDocx(docx([
      paragraph('PROJECT: TRANSLATION TEST'),
      paragraph('D4. Which option do you prefer? SA'),
      table([
        ['English', 'Marathi', 'Hindi'],
        ['Alpha', 'अल्फा', 'अल्फा हिंदी'],
        ['Beta', 'बीटा', 'बीटा हिंदी'],
      ]),
    ]), { projectNumber: 1608 });
    const question = byName(result.definition, 'd4');
    expect(question.label.english).toContain('Which option do you prefer?');
    const choices = result.definition.choiceLists['d4']!;
    expect(choices[0]?.label.Marathi).toBe('अल्फा');
    expect(choices[0]?.label.Hindi).toBe('अल्फा हिंदी');
    const survey = result.book.sheets.find((sheet) => sheet.name === 'survey')!;
    expect(survey.rows[0]).toEqual(expect.arrayContaining(['label:Marathi', 'label:Hindi']));
    const choiceSheet = result.book.sheets.find((sheet) => sheet.name === 'choices')!;
    expect(choiceSheet.rows[0]).toEqual(expect.arrayContaining(['label:Marathi', 'label:Hindi']));
  });

  it('does not emit a regional column when the source header has no translated text', () => {
    const result = compileDocx(docx([
      paragraph('PROJECT: BLANK TRANSLATION'),
      paragraph('D6. Which option do you prefer? SA'),
      table([
        ['English', 'Marathi'],
        ['Alpha', ''],
        ['Beta', ''],
      ]),
    ]), { projectNumber: 1608 });
    const survey = result.book.sheets.find((sheet) => sheet.name === 'survey')!;
    expect(survey.rows[0]).not.toContain('label:Marathi');
  });

  it('emits caller-supplied translations without inventing a regional column', () => {
    const result = compileDocx(docx([
      paragraph('PROJECT: CALLER TRANSLATION'),
      paragraph('D5. Do you agree? SA'),
      table([
        ['Yes', '1'],
        ['No', '2'],
      ]),
    ]), {
      projectNumber: 1608,
      translations: { d5: { Marathi: 'तुम्ही सहमत आहात का?' } },
      choiceTranslations: { d5: { '1': { Marathi: 'होय' }, '2': { Marathi: 'नाही' } } },
    });
    const question = byName(result.definition, 'd5');
    expect(question.label.Marathi).toBe('तुम्ही सहमत आहात का?');
    expect(result.definition.choiceLists['d5']?.[0]?.label.Marathi).toBe('होय');
    expect(result.book.sheets.find((sheet) => sheet.name === 'survey')?.rows[0]).toContain('label:Marathi');
  });

  it('splits E1 consideration from E1B usage and E2A most from E2B other reasons', () => {
    const result = compileDocx(docx([
      paragraph('PROJECT: SPLIT TEST'),
      paragraph('E1. Before choosing Bounce, which of these did you consider or actually use? mark all ROTATE OPTIONS'),
      paragraph('Yulu'),
      paragraph('Zypp'),
      paragraph('Other: ______'),
      paragraph('E2a. Which of these mattered most in choosing Bounce? ROTATE OPTIONS mark all that apply'),
      paragraph('Lower cost'),
      paragraph('Vehicle available'),
      paragraph('Other: ______'),
    ]), { projectNumber: 1608 });
    const def = result.definition;
    expect(byName(def, 'e1').type).toBe('select_multiple');
    expect(byName(def, 'e1b').type).toBe('select_multiple');
    expect(byName(def, 'e1b').validation?.constraint).toContain("selected(.,9)");
    expect(def.choiceLists['e1b']?.map((choice) => choice.value)).not.toContain('5');
    expect(def.choiceLists['e1b']?.find((choice) => choice.value === '9')?.label.english).toBe('None');
    expect(byName(def, 'e2a').type).toBe('select_one');
    expect(byName(def, 'e2b').type).toBe('select_multiple');
    expect(byName(def, 'e2b').rules?.choiceFilter).toBe('not(selected(${e2a}, filter))');
  });

  it('infers a project title from a headed document and warns when there is none', () => {
    const headed = compileDocx(docx([
      paragraph('Bounce - Rider Survey Instrument'),
      paragraph('S1. Which city do you deliver in? SA'),
      table([['Bengaluru', '1'], ['Delhi NCR', '2']]),
    ]), { projectNumber: 1608 });
    expect(headed.definition.title).toBe('BOUNCE');
    expect(headed.definition.settings?.xlsform).toMatchObject({ formId: 'GDN01608_BOUNCE' });
    expect(headed.report.diagnostics.some((diagnostic) => diagnostic.code === 'missing_title')).toBe(false);

    const untitled = compileDocx(docx([
      paragraph('S1. Which city do you deliver in? SA'),
      table([['Bengaluru', '1'], ['Delhi NCR', '2']]),
    ]), { projectNumber: 1608 });
    expect(untitled.definition.title).toBe('Untitled form');
    expect(untitled.report.diagnostics.some((diagnostic) => diagnostic.code === 'missing_title')).toBe(true);
  });

  it('round-trips the generated workbook through the reader', () => {
    const result = compileDocx(FIXTURE, { projectNumber: 1234 });
    const read = readWorkbook(result.bytes);
    expect(read.sheets.map((sheet) => sheet.name)).toEqual([
      'survey', 'choices', 'settings', 'help-survey', 'help-choices', 'help-settings',
    ]);
    const choices = read.sheets.find((sheet) => sheet.name === 'choices')!;
    expect(choices.rows[0]).toEqual(['list_name', 'label', 'value', 'image', 'filter']);
    expect(choices.rows.some((row) => row[0] === 'sq3' && row[2] === '99')).toBe(true);
  });
});
