/**
 * Build a self-contained TMDL semantic model for a questionnaire study.
 *
 * All questionnaire-level data is embedded with M #table so the PBIP opens
 * without a file-path parameter or a gateway. Responses and answers are also
 * embedded when supplied; otherwise their tables carry the schema and no rows.
 * That is the line between a design dossier and a fabricated fieldwork result.
 */

import { createHash } from 'node:crypto';

const TYPE_TO_M = {
  string: 'text',
  int64: 'Int64.Type',
  double: 'number',
  boolean: 'logical',
  dateTime: 'datetime',
};

const TYPE_TO_TMDL = {
  string: 'string',
  int64: 'int64',
  double: 'double',
  boolean: 'boolean',
  dateTime: 'dateTime',
};

function stableUuid(label) {
  const hex = createHash('sha1').update(String(label)).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = '8';
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}

function qName(name) {
  const value = String(name);
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ? value : `'${value.replace(/'/g, "''")}'`;
}

function mText(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, ' ')
    .replace(/\n/g, ' ')
    .replace(/"/g, '""');
}

function mValue(value, type) {
  if (value === null || value === undefined || value === '') return 'null';
  if (type === 'string') return `"${mText(value)}"`;
  if (type === 'boolean') return value ? 'true' : 'false';
  if (type === 'dateTime') {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return 'null';
    return `#datetime(${date.getUTCFullYear()}, ${date.getUTCMonth() + 1}, ${date.getUTCDate()}, ${date.getUTCHours()}, ${date.getUTCMinutes()}, ${date.getUTCSeconds()})`;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) return 'null';
  return type === 'int64' ? String(Math.trunc(number)) : String(number);
}

function mPartition(name, columns, rows) {
  const type = columns.map((column) => `${column.source} = ${TYPE_TO_M[column.type] ?? 'text'}`).join(', ');
  const rowLines = rows.map((row) => {
    const values = columns.map((column) => mValue(row[column.source], column.type)).join(', ');
    return `\t\t\t\t            {${values}}`;
  });
  const body = rowLines.length
    ? `\t\t\t\t        {\n${rowLines.join(',\n')}\n\t\t\t\t        }`
    : '\t\t\t\t        {}';
  // TMDL indentation is semantic. This mirrors the shape Desktop writes:
  // table (0) > partition (1) > properties (2) > M expression (4).
  return `\tpartition ${qName(name)} = m
\t\tmode: import
\t\tsource =
\t\t\t\tlet
\t\t\t\t    Source = #table(
\t\t\t\t        type table [${type}],
${body}
\t\t\t\t    )
\t\t\t\tin
\t\t\t\t    Source`;
}

function columnTmdl(column) {
  const lines = [`\tcolumn ${qName(column.name)}`];
  lines.push(`\t\tdataType: ${TYPE_TO_TMDL[column.type] ?? 'string'}`);
  if (column.format) lines.push(`\t\tformatString: ${column.format}`);
  if (column.hidden) lines.push('\t\tisHidden');
  lines.push('\t\tsummarizeBy: none');
  if (column.sortBy) lines.push(`\t\tsortByColumn: ${qName(column.sortBy)}`);
  lines.push(`\t\tsourceColumn: ${column.sourceColumn ?? column.source}`);
  return lines.join('\n');
}

function tableTmdl(table) {
  const parts = [`table ${qName(table.name)}`];
  if (table.measures?.length) {
    for (const measure of table.measures) {
      parts.push(`\tmeasure ${qName(measure.name)} = ${measure.expression}`);
      if (measure.formatString) parts.push(`\t\tformatString: ${measure.formatString}`);
    }
  }
  for (const column of table.columns) {
    parts.push(columnTmdl(column));
  }
  if (table.calculated) {
    parts.push(`\tpartition ${qName(table.name)} = calculated`);
    parts.push('\t\tmode: import');
    parts.push(`\t\tsource = ${table.calculated}`);
  } else {
    parts.push(mPartition(table.name, table.columns, table.rows ?? []));
  }
  return `${parts.join('\n')}\n`;
}

function makeTable(name, columns, rows = [], extras = {}) {
  return { name, columns, rows, ...extras };
}

export function buildSemanticModel(study) {
  const questionRows = study.questions.map((question) => ({
    QuestionKey: question.key,
    QuestionOrder: question.order,
    SectionKey: question.sectionKey,
    SectionText: question.sectionLabel,
    SectionOrder: question.sectionOrder,
    QuestionName: question.name,
    QuestionText: question.labelShort,
    QuestionFull: question.label,
    TypeKey: question.typeKey,
    TypeText: question.type,
    FamilyKey: question.analysis.family,
    AnswerableText: question.answerable ? 'Yes' : 'No',
    AnswerableFlag: question.answerable,
    RequiredText: question.required.label,
    RequiredFlag: question.required.flag,
    RequiredMode: question.required.conditional ? 'conditional' : question.required.flag ? 'required' : question.answerable ? 'optional' : 'not-asked',
    LogicText: question.routed ? 'Conditional' : '—',
    LogicFlag: question.routed,
    ConstraintText: question.constrained ? 'Set' : '—',
    ConstraintFlag: question.constrained,
    ChoiceFilterFlag: question.choiceFiltered,
    ChoiceCount: question.choiceCount,
    AnalysisText: question.analysis.family,
    ChartText: question.analysis.chart,
    CautionText: question.analysis.caution,
    EstimatedSeconds: question.seconds,
    BurdenBand: question.burdenBand,
    DependencyCount: question.refs.length,
    InboundReferences: study.anchors.find((anchor) => anchor.name === question.name)?.inbound ?? 0,
    RuleKinds: question.ruleKinds.join(', '),
  }));

  const questions = makeTable('Questions', [
    { name: 'QuestionKey', source: 'QuestionKey', type: 'string', hidden: true },
    { name: '#', source: 'QuestionOrder', type: 'int64', format: '0' },
    { name: 'SectionKey', source: 'SectionKey', type: 'string', hidden: true },
    { name: 'Section', source: 'SectionText', type: 'string' },
    { name: 'SectionOrder', source: 'SectionOrder', type: 'int64', hidden: true },
    { name: 'QuestionName', source: 'QuestionName', type: 'string', hidden: true },
    { name: 'Question', source: 'QuestionText', type: 'string' },
    { name: 'QuestionFull', source: 'QuestionFull', type: 'string', hidden: true },
    { name: 'TypeKey', source: 'TypeKey', type: 'string', hidden: true },
    { name: 'Type', source: 'TypeText', type: 'string' },
    { name: 'FamilyKey', source: 'FamilyKey', type: 'string', hidden: true },
    { name: 'Answerable', source: 'AnswerableText', type: 'string', hidden: true },
    { name: 'AnswerableFlag', source: 'AnswerableFlag', type: 'boolean', hidden: true },
    { name: 'Required', source: 'RequiredText', type: 'string' },
    { name: 'RequiredFlag', source: 'RequiredFlag', type: 'boolean', hidden: true },
    { name: 'RequiredMode', source: 'RequiredMode', type: 'string', hidden: true },
    { name: 'Logic', source: 'LogicText', type: 'string' },
    { name: 'LogicFlag', source: 'LogicFlag', type: 'boolean', hidden: true },
    { name: 'Constraint', source: 'ConstraintText', type: 'string' },
    { name: 'ConstraintFlag', source: 'ConstraintFlag', type: 'boolean', hidden: true },
    { name: 'ChoiceFilterFlag', source: 'ChoiceFilterFlag', type: 'boolean', hidden: true },
    { name: 'Choices', source: 'ChoiceCount', type: 'int64', format: '0' },
    { name: 'Analysis', source: 'AnalysisText', type: 'string' },
    { name: 'Chart', source: 'ChartText', type: 'string', hidden: true },
    { name: 'Caution', source: 'CautionText', type: 'string', hidden: true },
    { name: 'Est. sec', source: 'EstimatedSeconds', type: 'int64', format: '0' },
    { name: 'Burden', source: 'BurdenBand', type: 'string' },
    { name: 'Logic refs', source: 'DependencyCount', type: 'int64', format: '0', hidden: true },
    { name: 'Inbound refs', source: 'InboundReferences', type: 'int64', format: '0', hidden: true },
    { name: 'Rule kinds', source: 'RuleKinds', type: 'string', hidden: true },
  ], questionRows);

  const sections = makeTable('Sections', [
    { name: 'SectionKey', source: 'SectionKey', type: 'string', hidden: true },
    { name: 'Section', source: 'SectionText', type: 'string', sortBy: 'SectionOrder' },
    { name: 'SectionOrder', source: 'SectionOrder', type: 'int64', hidden: true },
    { name: 'Questions', source: 'QuestionCount', type: 'int64', format: '0' },
    { name: 'Answerable', source: 'AnswerableCount', type: 'int64', format: '0' },
    { name: 'Required', source: 'RequiredCount', type: 'int64', format: '0' },
    { name: 'Conditional', source: 'ConditionalCount', type: 'int64', format: '0' },
    { name: 'Routed', source: 'RoutedCount', type: 'int64', format: '0' },
    { name: 'Constraints', source: 'ConstraintCount', type: 'int64', format: '0' },
    { name: 'Choices', source: 'ChoiceCount', type: 'int64', format: '0' },
    { name: 'Est. minutes', source: 'EstimatedMinutes', type: 'double', format: '0.0' },
    { name: '% burden', source: 'BurdenShare', type: 'double', format: '0.0%' },
    { name: 'SectionFull', source: 'SectionFull', type: 'string', hidden: true },
  ], study.sections.map((section) => ({
    SectionKey: section.key,
    SectionText: section.label,
    SectionOrder: section.order,
    QuestionCount: section.questions,
    AnswerableCount: section.answerable,
    RequiredCount: section.required,
    ConditionalCount: section.conditional,
    RoutedCount: section.routed,
    ConstraintCount: section.constrained,
    ChoiceCount: section.choiceOptions,
    EstimatedMinutes: section.estimatedMinutes,
    BurdenShare: section.burdenShare,
    SectionFull: section.labelFull,
  })), {
    measures: [
      { name: 'Plotted section questions', expression: "SUM('Sections'[Questions])", formatString: '#,##0' },
      { name: 'Plotted section minutes', expression: "SUM('Sections'[Est. minutes])", formatString: '0.0' },
    ],
  });

  const types = makeTable('QuestionTypes', [
    { name: 'TypeKey', source: 'TypeKey', type: 'string', hidden: true },
    { name: 'Type', source: 'TypeText', type: 'string', sortBy: 'TypeOrder' },
    { name: 'TypeOrder', source: 'TypeOrder', type: 'int64', hidden: true },
    { name: 'Questions', source: 'QuestionCount', type: 'int64', format: '0' },
    { name: 'Answerable', source: 'AnswerableCount', type: 'int64', format: '0' },
    { name: 'Required', source: 'RequiredCount', type: 'int64', format: '0' },
    { name: 'Routed', source: 'RoutedCount', type: 'int64', format: '0' },
    { name: 'Constraints', source: 'ConstraintCount', type: 'int64', format: '0' },
    { name: 'Choices', source: 'ChoiceCount', type: 'int64', format: '0' },
    { name: 'Est. minutes', source: 'EstimatedMinutes', type: 'double', format: '0.0' },
  ], study.types.map((type) => ({
    TypeKey: type.key,
    TypeText: type.label,
    TypeOrder: type.order,
    QuestionCount: type.questions,
    AnswerableCount: type.answerable,
    RequiredCount: type.required,
    RoutedCount: type.routed,
    ConstraintCount: type.constrained,
    ChoiceCount: type.choiceOptions,
    EstimatedMinutes: type.estimatedMinutes,
  })), {
    measures: [
      { name: 'Plotted type questions', expression: "SUM('QuestionTypes'[Questions])", formatString: '#,##0' },
    ],
  });

  const families = makeTable('AnalysisFamilies', [
    { name: 'FamilyKey', source: 'FamilyKey', type: 'string', hidden: true },
    { name: 'Analysis family', source: 'FamilyText', type: 'string', sortBy: 'FamilyOrder' },
    { name: 'FamilyOrder', source: 'FamilyOrder', type: 'int64', hidden: true },
    { name: 'Questions', source: 'QuestionCount', type: 'int64', format: '0' },
    { name: 'Share', source: 'Share', type: 'double', format: '0.0%' },
    { name: 'Method', source: 'MethodText', type: 'string' },
    { name: 'Chart', source: 'ChartText', type: 'string' },
    { name: 'Caution', source: 'CautionText', type: 'string' },
  ], study.families.map((family) => ({
    FamilyKey: family.key,
    FamilyText: family.label,
    FamilyOrder: family.order,
    QuestionCount: family.questions,
    Share: family.share,
    MethodText: family.method,
    ChartText: family.chart,
    CautionText: family.caution,
  })), {
    measures: [
      { name: 'Plotted family questions', expression: "SUM('AnalysisFamilies'[Questions])", formatString: '#,##0' },
    ],
  });

  const anchors = makeTable('RoutingAnchors', [
    { name: 'Rank', source: 'Rank', type: 'int64', hidden: true },
    { name: 'QuestionKey', source: 'QuestionKey', type: 'string', hidden: true },
    { name: 'Question', source: 'QuestionText', type: 'string' },
    { name: 'Section', source: 'SectionText', type: 'string' },
    { name: 'Type', source: 'TypeText', type: 'string' },
    { name: 'Inbound refs', source: 'InboundReferences', type: 'int64', format: '0' },
    { name: 'Rule kinds', source: 'RuleKinds', type: 'string' },
  ], study.anchors.map((anchor) => ({
    Rank: anchor.rank,
    QuestionKey: anchor.key,
    QuestionText: anchor.question,
    SectionText: anchor.section,
    TypeText: anchor.type,
    InboundReferences: anchor.inbound,
    RuleKinds: anchor.ruleKinds,
  })), {
    measures: [
      { name: 'Plotted inbound references', expression: "SUM('RoutingAnchors'[Inbound refs])", formatString: '#,##0' },
    ],
  });

  const hotspots = makeTable('RoutingHotspots', [
    { name: 'Rank', source: 'Rank', type: 'int64', hidden: true },
    { name: 'QuestionKey', source: 'QuestionKey', type: 'string', hidden: true },
    { name: 'Question', source: 'QuestionText', type: 'string' },
    { name: 'Section', source: 'SectionText', type: 'string' },
    { name: 'Type', source: 'TypeText', type: 'string' },
    { name: 'Logic refs', source: 'LogicReferences', type: 'int64', format: '0' },
    { name: 'Rule kinds', source: 'RuleKinds', type: 'string' },
    { name: 'Rule sample', source: 'RuleSample', type: 'string', hidden: true },
  ], study.hotspots.map((hotspot) => ({
    Rank: hotspot.rank,
    QuestionKey: hotspot.key,
    QuestionText: hotspot.question,
    SectionText: hotspot.section,
    TypeText: hotspot.type,
    LogicReferences: hotspot.refs,
    RuleKinds: hotspot.ruleKinds,
    RuleSample: hotspot.sample,
  })));

  const dataContract = makeTable('DataContract', [
    { name: 'SortOrder', source: 'SortOrder', type: 'int64', hidden: true },
    { name: 'Artifact', source: 'Artifact', type: 'string' },
    { name: 'Grain', source: 'Grain', type: 'string' },
    { name: 'Key fields', source: 'KeyFields', type: 'string' },
    { name: 'Status', source: 'Status', type: 'string' },
    { name: 'Note', source: 'Note', type: 'string' },
  ], study.dataContract.map((row) => ({
    SortOrder: row.order,
    Artifact: row.artifact,
    Grain: row.grain,
    KeyFields: row.keys,
    Status: row.status,
    Note: row.note,
  })));

  const responses = makeTable('Responses', [
    { name: 'ResponseId', source: 'ResponseId', type: 'string' },
    { name: 'Status', source: 'Status', type: 'string' },
    { name: 'StartedAt', source: 'StartedAt', type: 'dateTime' },
    { name: 'SubmittedAt', source: 'SubmittedAt', type: 'dateTime' },
    { name: 'DurationMinutes', source: 'DurationMinutes', type: 'double', format: '0.0' },
    { name: 'DeviceId', source: 'DeviceId', type: 'string', hidden: true },
    { name: 'Interviewer', source: 'Interviewer', type: 'string' },
    { name: 'SectionReached', source: 'SectionReached', type: 'string' },
    { name: 'CompletionPct', source: 'CompletionPct', type: 'double', format: '0.0%' },
    { name: 'ConflictCount', source: 'ConflictCount', type: 'int64', format: '0' },
    { name: 'FlagCount', source: 'FlagCount', type: 'int64', format: '0' },
  ], study.responses);

  const answers = makeTable('Answers', [
    { name: 'ResponseId', source: 'ResponseId', type: 'string' },
    { name: 'QuestionKey', source: 'QuestionKey', type: 'string' },
    { name: 'AnswerText', source: 'AnswerText', type: 'string', hidden: true },
    { name: 'AnswerNumber', source: 'AnswerNumber', type: 'double', format: '0.0' },
    { name: 'AnsweredAt', source: 'AnsweredAt', type: 'dateTime' },
    { name: 'DurationSeconds', source: 'DurationSeconds', type: 'int64', format: '0' },
    { name: 'IsFlagged', source: 'IsFlagged', type: 'boolean', hidden: true },
  ], study.answers);

  const measures = [
    { name: 'Question count', expression: "COUNTROWS('Questions')", formatString: '#,##0' },
    { name: 'Answerable questions', expression: "CALCULATE(COUNTROWS('Questions'), 'Questions'[AnswerableFlag] = TRUE())", formatString: '#,##0' },
    { name: 'Required questions', expression: "CALCULATE(COUNTROWS('Questions'), 'Questions'[RequiredFlag] = TRUE())", formatString: '#,##0' },
    { name: 'Conditionally required', expression: "CALCULATE(COUNTROWS('Questions'), 'Questions'[RequiredMode] = \"conditional\")", formatString: '#,##0' },
    { name: 'Routing rules', expression: "CALCULATE(COUNTROWS('Questions'), 'Questions'[LogicFlag] = TRUE())", formatString: '#,##0' },
    { name: 'Constraints', expression: "CALCULATE(COUNTROWS('Questions'), 'Questions'[ConstraintFlag] = TRUE())", formatString: '#,##0' },
    { name: 'Choice filters', expression: "CALCULATE(COUNTROWS('Questions'), 'Questions'[ChoiceFilterFlag] = TRUE())", formatString: '#,##0' },
    { name: 'Choice options', expression: "SUM('Questions'[Choices])", formatString: '#,##0' },
    { name: 'Section count', expression: "DISTINCTCOUNT('Questions'[SectionKey])", formatString: '#,##0' },
    { name: 'Estimated minutes', expression: "DIVIDE(SUM('Questions'[Est. sec]), 60)", formatString: '0.0' },
    { name: 'Analysis families', expression: "DISTINCTCOUNT('Questions'[Analysis])", formatString: '#,##0' },
    { name: 'Logic references', expression: "SUM('Questions'[Logic refs])", formatString: '#,##0' },
    { name: 'Open text questions', expression: "CALCULATE(COUNTROWS('Questions'), 'Questions'[Analysis] = \"Verbatim coding\")", formatString: '#,##0' },
    { name: 'Numeric questions', expression: "CALCULATE(COUNTROWS('Questions'), 'Questions'[Analysis] = \"Numeric distribution\")", formatString: '#,##0' },
    { name: 'Median choices', expression: "MEDIAN('Questions'[Choices])", formatString: '0' },
    { name: 'Fieldwork status', expression: "IF(COUNTROWS('Responses') = 0, \"Awaiting data\", \"Loaded\")" },
    { name: 'Responses loaded', expression: "IF(COUNTROWS('Responses') = 0, \"0\", FORMAT(COUNTROWS('Responses'), \"#,##0\"))" },
    { name: 'Completion', expression: "IF(COUNTROWS('Responses') = 0, \"—\", FORMAT(DIVIDE(CALCULATE(COUNTROWS('Responses'), 'Responses'[Status] = \"Submitted\"), COUNTROWS('Responses')), \"0.0%\"))" },
    { name: 'Quality flags', expression: "IF(COUNTROWS('Responses') = 0, \"—\", FORMAT(SUM('Responses'[FlagCount]), \"#,##0\"))" },
    { name: 'Answer rows', expression: "COUNTROWS('Answers')", formatString: '#,##0' },
  ];

  const measureTable = makeTable('_Measures', [
    { name: 'Dummy', source: 'Dummy', sourceColumn: '[Dummy]', type: 'string', hidden: true },
  ], [], {
    measures,
    calculated: 'ROW("Dummy", BLANK())',
  });

  const tables = [questions, sections, types, families, anchors, hotspots, dataContract, responses, answers, measureTable];
  const relationships = [
    { name: 'QuestionsToSections', from: 'Questions', fromColumn: 'SectionKey', to: 'Sections', toColumn: 'SectionKey' },
    { name: 'QuestionsToTypes', from: 'Questions', fromColumn: 'TypeKey', to: 'QuestionTypes', toColumn: 'TypeKey' },
    { name: 'QuestionsToFamilies', from: 'Questions', fromColumn: 'FamilyKey', to: 'AnalysisFamilies', toColumn: 'FamilyKey' },
    { name: 'AnchorsToQuestions', from: 'RoutingAnchors', fromColumn: 'QuestionKey', to: 'Questions', toColumn: 'QuestionKey' },
    { name: 'HotspotsToQuestions', from: 'RoutingHotspots', fromColumn: 'QuestionKey', to: 'Questions', toColumn: 'QuestionKey' },
    { name: 'AnswersToQuestions', from: 'Answers', fromColumn: 'QuestionKey', to: 'Questions', toColumn: 'QuestionKey' },
    { name: 'AnswersToResponses', from: 'Answers', fromColumn: 'ResponseId', to: 'Responses', toColumn: 'ResponseId' },
  ];

  return { tables, relationships, measures };
}

export function semanticModelFiles(study, model) {
  const database = `database ${study.code}
\tid: ${stableUuid(`database:${study.code}`)}
\tcompatibilityLevel: 1567
\tcompatibilityMode: powerBI
\tlanguage: 1033
`;

  const refs = model.tables.map((table) => `\tref table ${qName(table.name)}`).join('\n');
  const modelFile = `model Model
\tculture: en-US
\tdefaultPowerBIDataSourceVersion: powerBI_V3
\tsourceQueryCulture: en-US
${refs}
`;

  const relationships = model.relationships.map((relationship) => (
    `relationship ${qName(relationship.name)}\n\tfromColumn: ${qName(relationship.from)}.${qName(relationship.fromColumn)}\n\ttoColumn: ${qName(relationship.to)}.${qName(relationship.toColumn)}`
  )).join('\n\n');

  return {
    database,
    model: modelFile,
    relationships: relationships ? `${relationships}\n` : '',
    tables: Object.fromEntries(model.tables.map((table) => [`${table.name}.tmdl`, tableTmdl(table)])),
  };
}

/**
 * Assert the invariants that make a semantic model inspectable without Power BI
 * Desktop: unique table/measure names, known column references and no duplicate
 * relationship endpoints.
 */
export function validateSemanticModel(model) {
  const errors = [];
  const tableNames = new Set();
  const measureNames = new Set();
  for (const table of model.tables) {
    if (tableNames.has(table.name)) errors.push(`duplicate table ${table.name}`);
    tableNames.add(table.name);
    const sources = new Set();
    for (const column of table.columns) {
      if (sources.has(column.source)) errors.push(`duplicate source column ${table.name}.${column.source}`);
      sources.add(column.source);
    }
    for (const measure of table.measures ?? []) {
      if (measureNames.has(measure.name)) errors.push(`duplicate measure ${measure.name}`);
      measureNames.add(measure.name);
    }
  }
  const relationshipNames = new Set();
  for (const relationship of model.relationships) {
    if (relationshipNames.has(relationship.name)) errors.push(`duplicate relationship ${relationship.name}`);
    relationshipNames.add(relationship.name);
    for (const side of [relationship.from, relationship.to]) {
      if (!tableNames.has(side)) errors.push(`relationship ${relationship.name} references missing table ${side}`);
    }
  }
  return errors;
}
