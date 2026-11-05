import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { analyzeDefinition, parseCsv } from './powerbi/study.mjs';
import { buildSemanticModel, semanticModelFiles, validateSemanticModel } from './powerbi/tmdl.mjs';
import { buildReportPackage, validateReportPackage } from './powerbi/pbir.mjs';
import { writeStudyProject } from './build-powerbi-report.mjs';

const definition = {
  title: 'Customer Experience Pulse',
  defaultLanguage: 'english',
  languages: ['english'],
  groups: [
    { id: 'g_intro', name: 'intro', label: { english: 'Introduction' }, order: 1 },
    { id: 'g_main', name: 'main', label: { english: 'Main interview' }, order: 2 },
    { id: 'g_close', name: 'close', label: { english: 'Close' }, order: 3 },
  ],
  choiceLists: {
    frequency: [
      { value: '1', label: { english: 'Never' } },
      { value: '2', label: { english: 'Sometimes' } },
      { value: '3', label: { english: 'Often' } },
      { value: '4', label: { english: 'Always' } },
    ],
    brands: [
      { value: 'a', label: { english: 'Brand A' } },
      { value: 'b', label: { english: 'Brand B' } },
    ],
  },
  questions: [
    {
      id: 'q_consent',
      name: 'consent',
      type: 'select_one',
      groupId: 'g_intro',
      order: 1,
      label: { english: 'Do you consent to this interview?' },
      required: true,
      choices: { listName: 'brands' },
    },
    {
      id: 'q_age',
      name: 'age',
      type: 'integer',
      groupId: 'g_intro',
      order: 2,
      label: { english: 'What is your age?' },
      validation: { constraint: '. >= 18 and . <= 99', message: { english: 'Please enter a valid age.' } },
    },
    {
      id: 'q_frequency',
      name: 'frequency',
      type: 'select_one',
      groupId: 'g_main',
      order: 3,
      label: { english: 'How often do you use the service?' },
      required: true,
      choices: { listName: 'frequency' },
      rules: { visibleIf: '${consent} = "a"' },
    },
    {
      id: 'q_brands',
      name: 'brands_seen',
      type: 'select_multiple',
      groupId: 'g_main',
      order: 4,
      label: { english: 'Which brands have you seen?' },
      choices: { listName: 'brands' },
    },
    {
      id: 'q_comment',
      name: 'comment',
      type: 'textarea',
      groupId: 'g_main',
      order: 5,
      label: { english: 'What would you improve?' },
      required: '${frequency} = "4"',
    },
    {
      id: 'q_score',
      name: 'score',
      type: 'calculate',
      groupId: 'g_close',
      order: 6,
      label: { english: 'Interview score' },
      rules: { calculate: '${age} + 1' },
    },
    {
      id: 'q_note',
      name: 'interviewer_note',
      type: 'note',
      groupId: 'g_close',
      order: 7,
      label: { english: 'Thank the respondent.' },
    },
  ],
};

const options = {
  code: 'PULSE-01',
  sourceLabel: 'pulse.docx',
  generatedAt: '2026-11-04T00:00:00.000Z',
};

test('study analysis is questionnaire-derived, not name-derived', () => {
  const study = analyzeDefinition(definition, options);
  assert.equal(study.code, 'PULSE-01');
  assert.equal(study.counts.questions, 7);
  assert.equal(study.counts.sections, 3);
  assert.equal(study.counts.answerable, 5);
  assert.equal(study.counts.required, 2);
  assert.equal(study.counts.conditional, 1);
  assert.equal(study.counts.routed, 1);
  assert.equal(study.counts.constraints, 1);
  assert.equal(study.counts.choiceOptions, 8);
  assert.equal(study.counts.responses, 0);
  assert.equal(study.counts.answers, 0);
  assert.equal(study.sections.find((section) => section.key === 'g_main').questions, 3);
  assert.equal(study.questions.find((question) => question.name === 'frequency').analysis.family, 'Ordered categorical');
  assert.equal(study.questions.find((question) => question.name === 'comment').analysis.family, 'Verbatim coding');
  assert.equal(study.questions.find((question) => question.name === 'consent').analysis.family, 'Frequency distribution');
  assert.equal(study.questions.find((question) => question.name === 'score').analysis.family, 'Metadata / QA');
  assert.ok(study.anchors.some((anchor) => anchor.name === 'frequency'));
  assert.ok(study.anchors.some((anchor) => anchor.name === 'consent'));
  assert.match(study.narrative.executive.join(' '), /7 instrument rows/);
});

test('CSV reader handles quoted commas and escaped quotes', () => {
  const rows = parseCsv('ResponseId,Status,Interviewer,SectionReached\nR1,Submitted,"Doe, Jane","Main ""A"""\n');
  assert.deepEqual(rows, [{ ResponseId: 'R1', Status: 'Submitted', Interviewer: 'Doe, Jane', SectionReached: 'Main "A"' }]);
});

test('semantic model is indented TMDL with a valid star schema', () => {
  const study = analyzeDefinition(definition, options);
  const model = buildSemanticModel(study);
  assert.deepEqual(validateSemanticModel(model), []);
  const files = semanticModelFiles(study, model);
  assert.match(files.database, /^\tdatabase|^database/m);
  assert.match(files.model, /\tref table Questions/);
  assert.match(files.tables['Questions.tmdl'], /\n\tcolumn QuestionKey\n\t\tdataType: string/);
  assert.match(files.tables['Questions.tmdl'], /\n\tpartition Questions = m\n\t\tmode: import\n\t\tsource =\n\t\t\t\tlet/);
  assert.match(files.tables['_Measures.tmdl'], /partition _Measures = calculated/);
  assert.equal(model.relationships.length, 7);
  assert.equal(model.tables.find((table) => table.name === 'Questions').rows.length, 7);
  assert.equal(model.tables.find((table) => table.name === 'Responses').rows.length, 0);
});

test('report package has unique pages, in-bounds visuals and resolvable fields', () => {
  const study = analyzeDefinition(definition, options);
  const model = buildSemanticModel(study);
  const pkg = buildReportPackage(study);
  assert.deepEqual(validateReportPackage(pkg, model), []);
  assert.equal(pkg.pages.length, 7);
  assert.equal(pkg.pagesJson.activePageName, pkg.pages[0].id);
  assert.equal(new Set(pkg.pages.map((page) => page.id)).size, 7);
  assert.ok(pkg.pages.some((page) => page.displayName.includes('Question atlas')));
  assert.ok(pkg.pages.some((page) => page.displayName.includes('Fieldwork readiness')));
  assert.equal(pkg.themeJson.name, 'Inicio Research Intelligence.json');
  assert.equal(pkg.themeJson.visualStyles.cardVisual['*'].value[0].fontColor !== undefined, true);
  assert.equal(pkg.pages[0].json.visuals, undefined);
  const chart = pkg.pages
    .flatMap((page) => page.visuals)
    .map((visual) => visual.json)
    .find((visual) => visual.visual.visualType === 'clusteredBarChart');
  assert.ok(chart, 'the dossier contains a bar chart');
  assert.equal(chart.visual.query.queryState.Y.projections[0].field.Measure !== undefined, true);
  assert.equal(chart.visual.objects.totals, undefined);
  assert.ok(pkg.pages.some((page) => page.visuals.some((visual) => visual.json.visual.visualType === 'shape')));
  assert.ok(pkg.reportJson.resourcePackages.some((pack) => pack.type === 'RegisteredResources'));
});

test('writer produces a complete PBIP with an empty response layer', () => {
  const base = mkdtempSync(join(tmpdir(), 'inicio-powerbi-'));
  try {
    const study = analyzeDefinition(definition, options);
    const result = writeStudyProject(study, { out: base });
    assert.ok(existsSync(join(result.projectDir, 'PULSE-01.pbip')));
    assert.ok(existsSync(join(result.projectDir, 'PULSE-01.Report', 'definition.pbir')));
    assert.ok(existsSync(join(result.projectDir, 'PULSE-01.SemanticModel', 'definition', 'model.tmdl')));
    assert.ok(existsSync(join(result.projectDir, 'PULSE-01.Report', 'StaticResources', 'RegisteredResources', 'Inicio Research Intelligence.json')));
    const manifest = JSON.parse(readFileSync(join(result.projectDir, 'report-manifest.json'), 'utf8'));
    assert.equal(manifest.code, 'PULSE-01');
    assert.equal(manifest.evidence.respondentData, 'none');
    assert.equal(manifest.counts.questions, 7);
    assert.equal(manifest.pages.length, 7);
    const report = JSON.parse(readFileSync(join(result.projectDir, 'PULSE-01.Report', 'definition', 'pages', manifest.pages[0].id, 'page.json'), 'utf8'));
    assert.equal(report.visuals, undefined);
    assert.equal(report.name, manifest.pages[0].id);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
