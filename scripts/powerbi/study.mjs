/**
 * Turn any canonical FormDefinition into the analytical model behind a Power BI
 * report.
 *
 * The important boundary: nothing here invents a respondent. The study model
 * describes the instrument that was submitted — its sections, questions, routing,
 * constraints, choice load and the analysis each question will require. Response
 * tables are carried separately and may be empty. The report is therefore useful
 * before fieldwork and remains honest after it.
 */
import { collectRefs, parse } from '../../packages/engine/dist/index.js';

const DISPLAY_TYPES = new Set(['note', 'calculate']);
const CHOICE_TYPES = new Set(['select_one', 'select_multiple', 'rank', 'yesno']);
const NUMERIC_TYPES = new Set(['integer', 'decimal', 'percentage', 'currency']);
const DATE_TYPES = new Set(['date', 'datetime', 'time']);
const GEO_TYPES = new Set(['geopoint', 'geotrace', 'geoshape']);
const MEDIA_TYPES = new Set(['image', 'audio', 'video', 'file', 'barcode']);

const TYPE_LABELS = {
  text: 'Open text',
  textarea: 'Long text',
  integer: 'Whole number',
  decimal: 'Decimal',
  percentage: 'Percentage',
  currency: 'Currency',
  date: 'Date',
  datetime: 'Date & time',
  time: 'Time',
  yesno: 'Yes / No',
  select_one: 'Single choice',
  select_multiple: 'Multi-select',
  rank: 'Ranking',
  enumerator: 'Enumerator',
  geopoint: 'Geo point',
  geotrace: 'Geo trace',
  geoshape: 'Geo shape',
  image: 'Image',
  audio: 'Audio',
  video: 'Video',
  file: 'File',
  barcode: 'Barcode',
  note: 'Note',
  calculate: 'Calculated / audit',
};

const TYPE_ORDER = [
  'Single choice', 'Multi-select', 'Ranking', 'Open text', 'Long text',
  'Whole number', 'Decimal', 'Percentage', 'Currency', 'Yes / No',
  'Date', 'Date & time', 'Time', 'Geo point', 'Geo trace', 'Geo shape',
  'Image', 'Audio', 'Video', 'File', 'Barcode', 'Enumerator', 'Note',
  'Calculated / audit',
];

const FAMILIES = {
  'Frequency distribution': {
    order: 1,
    method: 'Respondent frequency and share of eligible base; full distribution, not just the top box.',
    chart: 'Horizontal bar · respondent %',
    caution: 'Denominator is the eligible base after routing, not the total sample.',
  },
  'Ordered categorical': {
    order: 2,
    method: 'Ordered frequency, median and top-two-box; keep the full ordered distribution visible.',
    chart: 'Ordered bar · distribution + median',
    caution: 'Do not assume equal intervals between labels without a documented scale.',
  },
  'Scale / rating': {
    order: 3,
    method: 'Mean, median, standard deviation and distribution; report the base and scale direction.',
    chart: 'Diverging bar · distribution + mean',
    caution: 'A mean is only meaningful when the scale direction and anchors are explicit.',
  },
  'Multi-response frequency': {
    order: 4,
    method: 'Respondent-level frequency; shares can total more than 100% because one respondent may choose several options.',
    chart: 'Horizontal bar · % of respondents',
    caution: 'Do not divide mentions by answers; the denominator is respondents.',
  },
  'Rank analysis': {
    order: 5,
    method: 'Mean rank, first-choice share and full rank distribution; inspect concentration before averages.',
    chart: 'Ranked bar · mean rank + first choice',
    caution: 'A mean rank can hide a polarised first-choice pattern.',
  },
  'Numeric distribution': {
    order: 6,
    method: 'n, mean, median, IQR, range, histogram and outlier review; no inference without a design.',
    chart: 'Histogram · n / median / IQR',
    caution: 'Do not report a mean without a distribution check; segment by routing if bases differ.',
  },
  'Binary frequency': {
    order: 7,
    method: 'Yes/no frequency and share of eligible base; report the base beside the percentage.',
    chart: 'Horizontal bar · yes / no',
    caution: 'A binary split is not an attitude scale and should not be averaged.',
  },
  'Verbatim coding': {
    order: 8,
    method: 'Build a code frame from the verbatims, then report themes, mentions and representative exemplars.',
    chart: 'Code frame · themes + exemplars',
    caution: 'Verbatim counts describe coded mentions, not prevalence in the population.',
  },
  'Temporal distribution': {
    order: 9,
    method: 'Distribution over time and fieldwork pace; inspect gaps and clustering before interpretation.',
    chart: 'Column · responses by period',
    caution: 'A time pattern can reflect fieldwork operations rather than respondent behaviour.',
  },
  'Geographic coverage': {
    order: 10,
    method: 'Point density and coverage by area; review missing or duplicated locations.',
    chart: 'Point map · coverage + density',
    caution: 'Overlapping coordinates can hide multiple responses; aggregate intentionally.',
  },
  'Media / audit': {
    order: 11,
    method: 'Completion and quality audit only; media content needs a separate coding protocol.',
    chart: 'Completion table · QC flags',
    caution: 'Do not treat upload completion as evidence of answer quality.',
  },
  'Metadata / QA': {
    order: 12,
    method: 'Not a respondent question; use it for field operations, timestamps and audit checks.',
    chart: 'No chart · design metadata',
    caution: 'Never include administrative fields in a respondent base.',
  },
};

const REQUIRED_SECONDS = {
  note: 0,
  calculate: 0,
  yesno: 8,
  select_one: 12,
  select_multiple: 22,
  rank: 28,
  text: 40,
  textarea: 72,
  integer: 15,
  decimal: 15,
  percentage: 15,
  currency: 15,
  date: 10,
  datetime: 10,
  time: 10,
  geopoint: 28,
  geotrace: 35,
  geoshape: 35,
  image: 22,
  audio: 30,
  video: 30,
  file: 22,
  barcode: 10,
  enumerator: 12,
};

export function cleanText(value, fallback = '') {
  const text = String(value ?? '')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text || fallback;
}

export function clip(value, max = 120) {
  const text = cleanText(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

export function localizedText(value, language = 'english') {
  if (!value || typeof value !== 'object') return '';
  return cleanText(value[language] ?? value.english ?? value.en ?? Object.values(value)[0] ?? '');
}

export function studyCodeFrom(value) {
  return cleanText(value, 'INSTRUMENT')
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toUpperCase()
    .slice(0, 40) || 'INSTRUMENT';
}

function typeLabel(question) {
  return TYPE_LABELS[question.type] ?? cleanText(question.type, 'Question');
}

function choicesOf(definition, question) {
  if (question.choices?.inline) return question.choices.inline;
  const listName = question.choices?.listName;
  return listName ? definition.choiceLists?.[listName] ?? [] : [];
}

function numericChoiceSequence(choices) {
  const values = choices
    .map((choice) => Number(choice.value))
    .filter((value) => Number.isFinite(value));
  if (values.length !== choices.length || values.length < 3) return false;
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  if (sorted.length !== values.length) return false;
  return sorted.every((value, index) => index === 0 || value === sorted[index - 1] + 1);
}

function looksLikeScale(question, choices) {
  if (question.type !== 'select_one') return false;
  const label = `${localizedText(question.label)} ${localizedText(question.hint)}`.toLowerCase();
  if (/\b(rating|rate|scale|importance|important|likelihood|likely|agreement|agree|satisfaction|satisfied|nps|recommend)\b/.test(label)) {
    return true;
  }
  const labels = choices.map((choice) => localizedText(choice.label));
  return labels.length > 0 && labels.every((text) => /^-?\d+(\.\d+)?$/.test(text));
}

function analysisFor(question, choices) {
  if (!question.type || DISPLAY_TYPES.has(question.type)) {
    return { family: 'Metadata / QA', ...FAMILIES['Metadata / QA'] };
  }
  let family = 'Frequency distribution';
  if (question.type === 'select_one') {
    if (looksLikeScale(question, choices)) family = 'Scale / rating';
    else if (numericChoiceSequence(choices)) family = 'Ordered categorical';
  } else if (question.type === 'select_multiple') {
    family = 'Multi-response frequency';
  } else if (question.type === 'rank') {
    family = 'Rank analysis';
  } else if (NUMERIC_TYPES.has(question.type)) {
    family = 'Numeric distribution';
  } else if (question.type === 'yesno') {
    family = 'Binary frequency';
  } else if (question.type === 'text' || question.type === 'textarea') {
    family = 'Verbatim coding';
  } else if (DATE_TYPES.has(question.type)) {
    family = 'Temporal distribution';
  } else if (GEO_TYPES.has(question.type)) {
    family = 'Geographic coverage';
  } else if (MEDIA_TYPES.has(question.type)) {
    family = 'Media / audit';
  }
  return { family, ...FAMILIES[family] };
}

function requiredState(question) {
  if (DISPLAY_TYPES.has(question.type)) return { label: 'Not asked', flag: false, conditional: false };
  if (question.required === true) return { label: 'Required', flag: true, conditional: false };
  if (typeof question.required === 'string' && question.required.trim()) {
    return { label: 'Conditional', flag: false, conditional: true };
  }
  return { label: 'Optional', flag: false, conditional: false };
}

function ruleKinds(question) {
  const kinds = [];
  if (cleanText(question.rules?.visibleIf)) kinds.push('visibility');
  if (cleanText(question.rules?.enableIf)) kinds.push('enablement');
  if (cleanText(question.rules?.calculate)) kinds.push('calculation');
  if (cleanText(question.rules?.choiceFilter)) kinds.push('choice filter');
  if (cleanText(question.validation?.constraint)) kinds.push('constraint');
  if (typeof question.required === 'string' && cleanText(question.required)) kinds.push('conditional required');
  return kinds;
}

function referencesIn(expression) {
  const text = cleanText(expression);
  if (!text) return [];
  try {
    return collectRefs(parse(text));
  } catch {
    // The compiler already reports expression diagnostics. This fallback keeps
    // the design report useful for a partially broken instrument.
    return [...text.matchAll(/\$\{([^}]+)\}/g)].map((match) => cleanText(match[1]));
  }
}

function estimateSeconds(question, choices, required, routed, constrained) {
  const base = REQUIRED_SECONDS[question.type] ?? 12;
  const choiceLoad = CHOICE_TYPES.has(question.type) ? Math.min(choices.length, 14) * 0.65 : 0;
  const routingLoad = routed ? 3 : 0;
  const constraintLoad = constrained ? 2 : 0;
  const requiredLoad = required.flag || required.conditional ? 1 : 0;
  return Math.max(0, Math.round(base + choiceLoad + routingLoad + constraintLoad + requiredLoad));
}

function burdenBand(seconds) {
  if (seconds <= 0) return 'No respondent time';
  if (seconds <= 15) return 'Light';
  if (seconds <= 30) return 'Moderate';
  if (seconds <= 60) return 'Heavy';
  return 'Very heavy';
}

function groupLabel(group, language) {
  return localizedText(group?.label, language) || cleanText(group?.name, 'Unassigned section');
}

function sectionKey(group) {
  return cleanText(group?.id || group?.name || 'unassigned', 'unassigned');
}

export function emptyResponses() {
  return [];
}

export function emptyAnswers() {
  return [];
}

/**
 * Build the study-level analysis that both the TMDL model and the report pages
 * consume. `responses` and `answers` are optional arrays of already-normalised
 * rows; when absent, the response tables are deliberately empty.
 */
export function analyzeDefinition(definition, options = {}) {
  if (!definition || !Array.isArray(definition.questions)) {
    throw new TypeError('analyzeDefinition requires a canonical FormDefinition with a questions array.');
  }
  const language = definition.defaultLanguage || 'english';
  const code = studyCodeFrom(options.code || options.name || definition.title);
  const generatedAt = options.generatedAt || new Date().toISOString();
  const sourceLabel = cleanText(options.sourceLabel || options.source || 'Submitted questionnaire');
  const groups = Array.isArray(definition.groups) ? definition.groups : [];
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const questions = [...definition.questions]
    .map((question, index) => ({ question, index }))
    .sort((a, b) => (a.question.order ?? Number.MAX_SAFE_INTEGER) - (b.question.order ?? Number.MAX_SAFE_INTEGER) || a.index - b.index);

  const nameToQuestion = new Map(questions.map(({ question }) => [question.name, question]));
  const referenceCounts = new Map();
  const outgoing = new Map();

  const prepared = questions.map(({ question }, index) => {
    const group = question.groupId ? groupById.get(question.groupId) : null;
    const choices = choicesOf(definition, question);
    const required = requiredState(question);
    const routed = Boolean(cleanText(question.rules?.visibleIf));
    const constrained = Boolean(cleanText(question.validation?.constraint));
    const choiceFiltered = Boolean(cleanText(question.rules?.choiceFilter));
    const analysis = analysisFor(question, choices);
    const refs = new Set();
    for (const expression of [
      question.rules?.visibleIf,
      question.rules?.enableIf,
      question.rules?.choiceFilter,
      question.rules?.calculate,
      typeof question.required === 'string' ? question.required : null,
      question.validation?.constraint,
    ]) {
      for (const reference of referencesIn(expression)) {
        if (reference) refs.add(reference);
      }
    }
    const knownRefs = [...refs].filter((reference) => nameToQuestion.has(reference));
    for (const reference of knownRefs) {
      referenceCounts.set(reference, (referenceCounts.get(reference) ?? 0) + 1);
    }
    outgoing.set(question.name, knownRefs);
    const seconds = estimateSeconds(question, choices, required, routed, constrained);
    const label = localizedText(question.label, language) || cleanText(question.name, 'Untitled question');
    return {
      key: cleanText(question.id || question.name || `q_${index + 1}`),
      order: index + 1,
      name: cleanText(question.name),
      label,
      labelShort: clip(label, 128),
      type: typeLabel(question),
      typeKey: cleanText(question.type, 'unknown'),
      answerable: !DISPLAY_TYPES.has(question.type),
      required,
      routed,
      constrained,
      choiceFiltered,
      choices,
      choiceCount: choices.length,
      analysis,
      seconds,
      burdenBand: burdenBand(seconds),
      refs: knownRefs,
      ruleKinds: ruleKinds(question),
      groupId: group?.id ?? null,
      sectionKey: group ? sectionKey(group) : 'unassigned',
      sectionLabel: group ? groupLabel(group, language) : 'Unassigned section',
      sectionOrder: group?.order ?? Number.MAX_SAFE_INTEGER,
      sourceType: cleanText(question.type),
      question,
    };
  });

  // Sections keep the instrument's own order. A question outside a group is a
  // real section of one (or more) rows, not a reason to drop it.
  const sectionBuckets = new Map();
  for (const question of prepared) {
    if (!sectionBuckets.has(question.sectionKey)) {
      sectionBuckets.set(question.sectionKey, {
        key: question.sectionKey,
        label: question.sectionLabel,
        order: question.sectionOrder,
        questions: [],
      });
    }
    sectionBuckets.get(question.sectionKey).questions.push(question);
  }
  const sections = [...sectionBuckets.values()]
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))
    .map((section, index) => {
      const totalSeconds = section.questions.reduce((sum, question) => sum + question.seconds, 0);
      return {
        key: section.key,
        label: clip(section.label, 48),
        labelFull: section.label,
        order: index + 1,
        questions: section.questions.length,
        answerable: section.questions.filter((question) => question.answerable).length,
        required: section.questions.filter((question) => question.required.flag).length,
        conditional: section.questions.filter((question) => question.required.conditional).length,
        routed: section.questions.filter((question) => question.routed).length,
        constrained: section.questions.filter((question) => question.constrained).length,
        choiceOptions: section.questions.reduce((sum, question) => sum + question.choiceCount, 0),
        estimatedSeconds: totalSeconds,
        estimatedMinutes: totalSeconds / 60,
      };
    });

  const totalSeconds = prepared.reduce((sum, question) => sum + question.seconds, 0);
  const totalMinutes = totalSeconds / 60;
  for (const section of sections) {
    section.burdenShare = totalMinutes > 0 ? section.estimatedMinutes / totalMinutes : 0;
  }

  const typeBuckets = new Map();
  for (const question of prepared) {
    if (!typeBuckets.has(question.type)) {
      typeBuckets.set(question.type, {
        key: question.typeKey,
        label: question.type,
        order: TYPE_ORDER.indexOf(question.type) === -1 ? 999 : TYPE_ORDER.indexOf(question.type),
        questions: [],
      });
    }
    typeBuckets.get(question.type).questions.push(question);
  }
  const types = [...typeBuckets.values()]
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label))
    .map((type) => ({
      key: type.key,
      label: type.label,
      order: type.order,
      questions: type.questions.length,
      answerable: type.questions.filter((question) => question.answerable).length,
      required: type.questions.filter((question) => question.required.flag).length,
      routed: type.questions.filter((question) => question.routed).length,
      constrained: type.questions.filter((question) => question.constrained).length,
      choiceOptions: type.questions.reduce((sum, question) => sum + question.choiceCount, 0),
      estimatedMinutes: type.questions.reduce((sum, question) => sum + question.seconds, 0) / 60,
    }));

  const familyBuckets = new Map();
  for (const question of prepared) {
    const family = question.analysis.family;
    if (!familyBuckets.has(family)) familyBuckets.set(family, []);
    familyBuckets.get(family).push(question);
  }
  const families = [...familyBuckets.entries()]
    .map(([family, members]) => ({
      key: family,
      label: family,
      order: FAMILIES[family]?.order ?? 99,
      questions: members.length,
      share: prepared.length ? members.length / prepared.length : 0,
      method: FAMILIES[family]?.method ?? 'Document the analysis method before fieldwork.',
      chart: FAMILIES[family]?.chart ?? 'No chart specified',
      caution: FAMILIES[family]?.caution ?? '',
    }))
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));

  const referenced = prepared
    .filter((question) => (referenceCounts.get(question.name) ?? 0) > 0)
    .sort((a, b) => (referenceCounts.get(b.name) ?? 0) - (referenceCounts.get(a.name) ?? 0) || a.order - b.order);
  const anchors = referenced.slice(0, 10).map((question, index) => ({
    rank: index + 1,
    key: question.key,
    name: question.name,
    question: clip(question.label, 58),
    section: clip(question.sectionLabel, 38),
    type: question.type,
    inbound: referenceCounts.get(question.name) ?? 0,
    ruleKinds: question.ruleKinds.join(', ') || 'referenced',
  }));

  const hotspots = prepared
    .filter((question) => question.refs.length > 0 || question.ruleKinds.length > 0)
    .sort((a, b) => b.refs.length - a.refs.length || b.ruleKinds.length - a.ruleKinds.length || a.order - b.order)
    .slice(0, 10)
    .map((question, index) => ({
      rank: index + 1,
      key: question.key,
      name: question.name,
      question: clip(question.label, 72),
      section: clip(question.sectionLabel, 34),
      type: question.type,
      refs: question.refs.length,
      ruleKinds: question.ruleKinds.join(', ') || 'none',
      sample: clip(question.question.rules?.visibleIf || question.question.validation?.constraint || '', 140),
    }));

  const responses = Array.isArray(options.responses) ? options.responses : [];
  const answers = Array.isArray(options.answers) ? options.answers : [];
  const responseStatus = responses.length ? `${responses.length} rows` : 'Schema ready · no rows';
  const answerStatus = answers.length ? `${answers.length} rows` : 'Schema ready · no rows';

  const counts = {
    questions: prepared.length,
    answerable: prepared.filter((question) => question.answerable).length,
    sections: sections.length,
    required: prepared.filter((question) => question.required.flag).length,
    conditional: prepared.filter((question) => question.required.conditional).length,
    requiredInAnyPath: prepared.filter((question) => question.required.flag || question.required.conditional).length,
    routed: prepared.filter((question) => question.routed).length,
    constraints: prepared.filter((question) => question.constrained).length,
    choiceFilters: prepared.filter((question) => question.choiceFiltered).length,
    choiceOptions: prepared.reduce((sum, question) => sum + question.choiceCount, 0),
    logicReferences: prepared.reduce((sum, question) => sum + question.refs.length, 0),
    families: families.length,
    types: types.length,
    estimatedSeconds: totalSeconds,
    estimatedMinutes: totalMinutes,
    responses: responses.length,
    answers: answers.length,
  };

  const largestSection = [...sections].sort((a, b) => b.questions - a.questions)[0] ?? null;
  const heaviestSection = [...sections].sort((a, b) => b.estimatedMinutes - a.estimatedMinutes)[0] ?? null;
  const topAnchor = anchors[0] ?? null;
  const topHotspot = hotspots[0] ?? null;
  const openText = prepared.filter((question) => question.analysis.family === 'Verbatim coding').length;
  const numeric = prepared.filter((question) => question.analysis.family === 'Numeric distribution').length;
  const categorical = prepared.filter((question) => ['Frequency distribution', 'Ordered categorical', 'Scale / rating', 'Multi-response frequency', 'Binary frequency'].includes(question.analysis.family)).length;

  const narrative = {
    executive: [
      `${code} contains ${counts.questions} instrument rows across ${counts.sections} sections: ${counts.answerable} answerable questions and ${counts.questions - counts.answerable} administrative or calculated fields.`,
      `${counts.required} questions are required outright and ${counts.conditional} are conditionally required; ${counts.routed} carry a visibility rule. The planning burden is ${totalMinutes.toFixed(1)} minutes, a design heuristic rather than a measured interview length.`,
      `${largestSection ? `The largest section is “${clip(largestSection.labelFull, 60)}” with ${largestSection.questions} rows.` : 'No sections were declared.'} The analysis plan is dominated by categorical work (${categorical} questions), with ${openText} open-text fields needing a code frame and ${numeric} numeric fields needing distribution checks.`,
    ],
    architecture: [
      `The instrument is organised into ${counts.sections} sections. ${largestSection ? `“${clip(largestSection.labelFull, 64)}” is the volume centre at ${largestSection.questions} rows (${((largestSection.questions / Math.max(1, counts.questions)) * 100).toFixed(0)}% of the instrument).` : 'No section metadata was available.'}`,
      heaviestSection ? `Estimated respondent time is highest in “${clip(heaviestSection.labelFull, 64)}” at ${heaviestSection.estimatedMinutes.toFixed(1)} minutes (${(heaviestSection.burdenShare * 100).toFixed(0)}% of the design burden). This is where field length and fatigue deserve a deliberate review.` : '',
      `${counts.requiredInAnyPath} questions require an answer in at least one path. Conditional requirements are not the same as optional questions: check the route before treating a blank as missing data.`,
    ],
    routing: [
      `${counts.routed} questions carry visibility logic and ${counts.logicReferences} distinct question references sit inside routing or validation expressions. ${topAnchor ? `“${clip(topAnchor.question, 54)}” is the most-referenced anchor (${topAnchor.inbound} references).` : 'No question is referenced by another rule.'}`,
      `${counts.constraints} questions have a validation constraint; ${counts.choiceFilters} use a dynamic choice filter. Constraints reduce invalid entries but can also create field queries when an edge case is legitimate.`,
      topHotspot ? `The highest rule-load question is “${clip(topHotspot.question, 58)}” with ${topHotspot.refs} references across ${topHotspot.ruleKinds}. Review it before launch, because an error there propagates through every dependent route.` : 'No rule-load hotspots were detected.',
    ],
    analysis: [
      `${counts.families} analysis families are represented. ${categorical} questions call for a categorical distribution, ${openText} for verbatim coding and ${numeric} for a numeric distribution; these are different analytical contracts and should not be collapsed into one “percentage” column.`,
      `No inferential test is pre-committed here. Significance, subgroup comparisons and driver analysis depend on the sampling design, achieved base and the response data — none of which are fabricated in this build.`,
      `Conditional questions must be analysed on their eligible base. A percentage with the total sample as its denominator is a design error, not a finding.`,
    ],
    readiness: [
      `No respondent data is represented in this build. The semantic model contains empty Responses and Answers tables with stable keys, plus a data contract that names the grain of every analytical table.`,
      `The report is intentionally useful before fieldwork: it exposes question load, routing dependencies, constraint coverage and the analysis method each question will require.`,
      `When fieldwork data is supplied, the response layer can be populated without changing the questionnaire-level pages. Do not present an empty base as a result.`,
    ],
  };

  return {
    code,
    displayName: code,
    sourceTitle: (() => {
      const title = cleanText(definition.title);
      // A parser can mistake the first question fragment for a title. Do not
      // repeat that fragment in the manifest or project README.
      return title.length >= 4 && !title.includes('…') ? title : code;
    })(),
    sourceLabel,
    generatedAt,
    language,
    definition,
    questions: prepared,
    sections,
    types,
    families,
    anchors,
    hotspots,
    responses,
    answers,
    counts,
    narrative,
    dataContract: [
      { order: 1, artifact: 'Questions', grain: 'One row per instrument row', keys: 'QuestionKey, SectionKey, TypeKey', status: 'Loaded', note: 'Compiled from the submitted questionnaire.' },
      { order: 2, artifact: 'Sections', grain: 'One row per declared section', keys: 'SectionKey', status: 'Loaded', note: 'Includes questions outside a declared group.' },
      { order: 3, artifact: 'QuestionTypes', grain: 'One row per rendered type', keys: 'TypeKey', status: 'Loaded', note: 'Counts and control density by type.' },
      { order: 4, artifact: 'AnalysisFamilies', grain: 'One row per analysis method', keys: 'FamilyKey', status: 'Loaded', note: 'The method is a plan, not a finding.' },
      { order: 5, artifact: 'RoutingAnchors', grain: 'Top referenced questions', keys: 'QuestionKey', status: 'Loaded', note: 'Derived from rule-expression references.' },
      { order: 6, artifact: 'RoutingHotspots', grain: 'Highest rule-load questions', keys: 'QuestionKey', status: 'Loaded', note: 'Outgoing references and rule kinds.' },
      { order: 7, artifact: 'Responses', grain: 'One row per interview', keys: 'ResponseId', status: responseStatus, note: responses.length ? 'Supplied response rows are embedded in the model.' : 'No synthetic responses were created.' },
      { order: 8, artifact: 'Answers', grain: 'One row per answer', keys: 'ResponseId + QuestionKey', status: answerStatus, note: answers.length ? 'Supplied answer rows are embedded in the model.' : 'Answer-level analysis activates with fieldwork data.' },
    ],
  };
}

/**
 * A deliberately small CSV reader for the response/answer append path. It
 * supports quoted fields, escaped quotes, embedded commas and CRLF, which is what
 * survey exports actually contain. It does not attempt type inference.
 */
export function parseCsv(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (character !== '\r') {
      field += character;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length === 0) return [];
  const headers = rows[0].map((header) => cleanText(header));
  return rows.slice(1)
    .filter((values) => values.some((value) => cleanText(value)))
    .map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])));
}

function valueFor(row, names) {
  for (const name of names) {
    if (row[name] !== undefined) return row[name];
    const found = Object.keys(row).find((key) => key.toLowerCase() === name.toLowerCase());
    if (found !== undefined) return row[found];
  }
  return '';
}

export function normalizeResponses(rows) {
  return (rows ?? []).map((row, index) => ({
    ResponseId: cleanText(valueFor(row, ['ResponseId', 'response_id', 'id']), `R${String(index + 1).padStart(4, '0')}`),
    Status: cleanText(valueFor(row, ['Status', 'status']), 'Unknown'),
    StartedAt: parseDate(valueFor(row, ['StartedAt', 'started_at', 'start'])),
    SubmittedAt: parseDate(valueFor(row, ['SubmittedAt', 'submitted_at', 'end'])),
    DurationMinutes: parseNumber(valueFor(row, ['DurationMinutes', 'duration_minutes', 'duration'])),
    DeviceId: cleanText(valueFor(row, ['DeviceId', 'device_id'])),
    Interviewer: cleanText(valueFor(row, ['Interviewer', 'interviewer', 'username'])),
    SectionReached: cleanText(valueFor(row, ['SectionReached', 'section_reached'])),
    CompletionPct: parseNumber(valueFor(row, ['CompletionPct', 'completion_pct', 'completion'])),
    ConflictCount: parseInteger(valueFor(row, ['ConflictCount', 'conflict_count', 'conflicts'])),
    FlagCount: parseInteger(valueFor(row, ['FlagCount', 'flag_count', 'flags'])),
  }));
}

export function normalizeAnswers(rows) {
  return (rows ?? []).map((row) => ({
    ResponseId: cleanText(valueFor(row, ['ResponseId', 'response_id'])),
    QuestionKey: cleanText(valueFor(row, ['QuestionKey', 'question_key', 'question'])),
    AnswerText: cleanText(valueFor(row, ['AnswerText', 'answer_text', 'text', 'value'])),
    AnswerNumber: parseNumber(valueFor(row, ['AnswerNumber', 'answer_number', 'number'])),
    AnsweredAt: parseDate(valueFor(row, ['AnsweredAt', 'answered_at'])),
    DurationSeconds: parseInteger(valueFor(row, ['DurationSeconds', 'duration_seconds'])),
    IsFlagged: parseBoolean(valueFor(row, ['IsFlagged', 'is_flagged', 'flagged'])),
  }));
}

function parseDate(value) {
  const text = cleanText(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(String(value).replace(/,/g, '').replace(/%$/, ''));
  return Number.isFinite(number) ? number : null;
}

function parseInteger(value) {
  const number = parseNumber(value);
  return number === null ? null : Math.trunc(number);
}

function parseBoolean(value) {
  const text = cleanText(value).toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(text)) return true;
  if (['false', '0', 'no', 'n'].includes(text)) return false;
  return null;
}

export function formatMinutes(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return '0.0';
  return minutes.toFixed(1);
}
