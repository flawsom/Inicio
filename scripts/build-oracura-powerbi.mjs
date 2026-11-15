#!/usr/bin/env node
/**
 * Build ORACURA - Module 1 Customer Feedback (204 respondents, 220 product
 * evaluations) as a data-driven Power BI Project (PBIP/PBIR + TMDL).
 *
 * Unlike scripts/build-powerbi-report.mjs (a questionnaire design dossier with
 * zero respondent rows, which is why those .pbip files look blank), this
 * builder embeds the real respondent data from
 * reports/power-bi/oracura/data/evaluations.csv and produces five analytical
 * pages: Executive, Who & What, Usage, Experience, Recommendation & Voice.
 *
 * Usage: node scripts/build-oracura-powerbi.mjs [--out reports/power-bi]
 * Open reports/power-bi/oracura/ORACURA.pbip in Power BI Desktop.
 * No .pbix is written: Microsoft does not support generating a model-bearing
 * PBIX outside Desktop (see docs/POWER-BI.md).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { semanticModelFiles, validateSemanticModel } from './powerbi/tmdl.mjs';
import { BASE_THEME_NAME, buildTheme, THEME_NAME, validateReportPackage } from './powerbi/pbir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CODE = 'ORACURA';
const GENERATED_AT = '2026-11-13T00:00:00.000Z';

// ---------- data ----------
// RFC4180 CSV parser (extractor output is properly quoted; verbatims contain commas).
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i += 1; } else inQuotes = false; }
      else cell += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); cell = ''; rows.push(row); row = []; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  const head = rows[0].map((h) => h.trim());
  return rows.slice(1).filter((r) => r.some((c) => c.trim() !== '')).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}
const DATA_CSV = join(ROOT, 'reports/power-bi/oracura-data/evaluations.csv');
const raw = parseCsv(readFileSync(DATA_CSV, 'utf8'));
const satBand = (s) => ({ 5: '5 Very satisfied', 4: '4 Satisfied', 3: '3 Neutral', 2: '2 Dissatisfied', 1: '1 Very dissatisfied' })[s] ?? '-';
const recBand = (r) => (r >= 9 ? 'Promoter (9-10)' : r >= 7 ? 'Passive (7-8)' : 'Detractor (0-6)');
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
// Ordinal axes must read in their natural order, not sorted by bar length. Each
// displayed label gets a hidden numeric partner and `sortByColumn`, the same rule
// Power BI applies to Jan..Dec months.
const rank = (value, order) => { const i = order.findIndex((o) => String(value).toLowerCase().startsWith(o.toLowerCase())); return i === -1 ? 99 : i + 1; };
const AGE_ORDER = ['18-24', '25-34', '35-44', '45-54', '55+'];
const TIMING_ORDER = ['<3 months', '3-6 months', '6-12 months', '12-24 months', 'Do not remember'];
const FREQ_ORDER = ['Daily', 'Several times a week', 'Once a week', 'A few times a month', 'Less often', 'Rarely', 'Never'];
const EXPECT_ORDER = ['Better than expected', 'About as expected', 'Worse than expected'];
const USAGE_ORDER = ['More frequent', 'About the same', 'Less frequent', 'Stopped'];
const SITUATION_ORDER = ['Current', 'Occasionally', 'Stopped', 'Never used'];
const HOUSEHOLD_ORDER = ['Only me', 'Me and my partner', 'Whole family', 'Children'];

// Single dimension path: Age/Gender/City live ONLY in Respondents (S1-S3).
// Evaluations (CF2-CF16) reaches them via RespId, so slicers on Respondents
// cross-filter every Evaluations visual through the one relationship.
const evaluations = raw.map((r, i) => ({
  EvalId: i + 1,
  RespId: num(r.Resp),
  Family: r.Family, Product: r.Product, Slot: num(r.Slot),
  Situation: r.Situation, BuyReason: r.BuyReason, Timing: r.Timing, Household: r.Household,
  Frequency: r.Frequency, UsageChange: r.UsageChange,
  Satisfaction: num(r.Satisfaction), Expectation: r.Expectation, Recommend: num(r.Recommend),
  LikeTheme: r.LikeTheme, ImproveTheme: r.ImproveTheme,
  CF9: r.CF9_ReasonChange ?? '', CF12: r.CF12_LikeMost ?? '', CF13: r.CF13_ImproveOne ?? '',
  CF15: r.CF15_RecommendReason ?? '', CF16: r.CF16_AnythingElse ?? '',
  SatisfactionBand: satBand(num(r.Satisfaction)),
  RecommendBand: recBand(num(r.Recommend)),
  StillUsing: r.Situation === 'Current' ? 'Yes' : 'No',
  SatisfactionOrder: num(r.Satisfaction) ?? 99,
  RecommendOrder: num(r.Recommend) ?? -1,
  TimingOrder: rank(r.Timing, TIMING_ORDER),
  FrequencyOrder: rank(r.Frequency, FREQ_ORDER),
  ExpectationOrder: rank(r.Expectation, EXPECT_ORDER),
  UsageOrder: rank(r.UsageChange, USAGE_ORDER),
  SituationOrder: rank(r.Situation, SITUATION_ORDER),
  HouseholdOrder: rank(r.Household, HOUSEHOLD_ORDER),
}));
const respondentMap = new Map();
for (const r of raw) { const id = num(r.Resp); if (!respondentMap.has(id)) respondentMap.set(id, { RespId: id, Age: r.Age, Gender: r.Gender, City: r.City, AgeOrder: rank(r.Age, AGE_ORDER) }); }
const respondents = [...respondentMap.values()].sort((a, b) => a.RespId - b.RespId);

// KPI facts (computed here only for cover/narrative text; visuals use DAX)
const avg = (f) => evaluations.reduce((s, e) => s + f(e), 0) / evaluations.length;
const kpi = {
  respondents: respondents.length,
  evaluations: evaluations.length,
  avgSat: avg((e) => e.Satisfaction).toFixed(2),
  top2: (100 * evaluations.filter((e) => e.Satisfaction >= 4).length / evaluations.length).toFixed(1),
  avgRec: avg((e) => e.Recommend).toFixed(2),
  nps: Math.round(100 * (evaluations.filter((e) => e.Recommend >= 9).length - evaluations.filter((e) => e.Recommend <= 6).length) / evaluations.length),
  better: (100 * evaluations.filter((e) => e.Expectation === 'Better than expected').length / evaluations.length).toFixed(1),
  daily: (100 * evaluations.filter((e) => e.Frequency === 'Daily').length / evaluations.length).toFixed(1),
  current: (100 * evaluations.filter((e) => e.Situation === 'Current').length / evaluations.length).toFixed(1),
  service: evaluations.filter((e) => /service/i.test(e.CF13) || /care/i.test(e.CF13)).length,
  top2Count: evaluations.filter((e) => e.Satisfaction >= 4).length,
  promoters: evaluations.filter((e) => e.Recommend >= 9).length,
  detractors: evaluations.filter((e) => e.Recommend <= 6).length,
  currentCount: evaluations.filter((e) => e.Situation === 'Current').length,
  dailyCount: evaluations.filter((e) => e.Frequency === 'Daily').length,
  warrantyN: evaluations.filter((e) => e.Family === 'Warranty').length,
  warrantyDetPct: '0.0',
  detBasePct: '0.0',
  detThemes: [],
  improveCounts: {},
  serviceDet: 0,
};
// Narrative facts: every number printed in narrative text is computed here from
// the CSV, never typed into a string. If the data changes, the copy moves with it.
{
  const by = (arr, f) => arr.reduce((m, e) => { const k = f(e); m[k] = (m[k] ?? 0) + 1; return m; }, {});
  const det = evaluations.filter((e) => e.Recommend <= 6);
  const war = evaluations.filter((e) => e.Family === 'Warranty');
  kpi.detThemes = Object.entries(by(det, (e) => e.ImproveTheme)).sort((a, b) => b[1] - a[1]);
  kpi.improveCounts = by(evaluations, (e) => e.ImproveTheme);
  kpi.warrantyDetPct = (100 * war.filter((e) => e.Recommend <= 6).length / Math.max(1, war.length)).toFixed(1);
  kpi.detBasePct = (100 * det.length / evaluations.length).toFixed(1);
  kpi.serviceDet = det.filter((e) => /service/i.test(e.CF13) || /care/i.test(e.CF13)).length;
}
// Detractor theme split as copy: themes with 3+ detractors, then the remainder.
const detSplit = () => {
  const big = kpi.detThemes.filter(([, n]) => n >= 3);
  const rest = kpi.detractors - big.reduce((s, [, n]) => s + n, 0);
  const parts = big.map(([t, n]) => `${t.charAt(0).toLowerCase() + t.slice(1)} (${n})`);
  return parts.join(', ') + (rest > 0 ? ` and ${rest} in smaller themes` : '');
};
const promPct = ((100 * kpi.promoters) / kpi.evaluations).toFixed(1);
// Respondent-grain facts (204 respondents, first evaluation each) - the grain
// the client deck reports in. Computed here for the reconciliation page.
const byResp = new Map();
for (const e of evaluations) { if (!byResp.has(e.RespId)) byResp.set(e.RespId, []); byResp.get(e.RespId).push(e); }
const respFirst = [...byResp.values()].map((v) => v[0]);
const respNps = (scores) => {
  const p = scores.filter((x) => x >= 9).length, d = scores.filter((x) => x <= 6).length, pa = scores.length - p - d;
  return { p, pa, d, nps: Math.round(100 * (p - d) / scores.length) };
};
const respGrain = {
  avgSat: (respFirst.reduce((s, e) => s + e.Satisfaction, 0) / respFirst.length).toFixed(2),
  top2: (100 * respFirst.filter((e) => e.Satisfaction >= 4).length / respFirst.length).toFixed(1),
  better: (100 * respFirst.filter((e) => e.Expectation === 'Better than expected').length / respFirst.length).toFixed(1),
  current: (100 * respFirst.filter((e) => e.Situation === 'Current').length / respFirst.length).toFixed(1),
  currents: respFirst.filter((e) => e.Situation === 'Current').length,
  lapsed: respFirst.filter((e) => e.Situation === 'Used earlier').length,
};
const npsAggregations = [
  [`Evaluation level (this report, ${kpi.evaluations})`, respNps(evaluations.map((e) => e.Recommend))],
  ['First evaluation per respondent', respNps(respFirst.map((e) => e.Recommend))],
  ['Last evaluation per respondent', respNps([...byResp.values()].map((v) => v[v.length - 1].Recommend))],
  ['Mean score per respondent, banded', respNps([...byResp.values()].map((v) => v.reduce((s, e) => s + e.Recommend, 0) / v.length))],
  ['Minimum score per respondent', respNps([...byResp.values()].map((v) => Math.min(...v.map((e) => e.Recommend))))],
  ['Maximum score per respondent', respNps([...byResp.values()].map((v) => Math.max(...v.map((e) => e.Recommend))))],
  ['Single-product respondents only', respNps([...byResp.values()].filter((v) => v.length === 1).map((v) => v[0].Recommend))],
];

// ---------- semantic model ----------
const col = (name, source, type, extra = {}) => ({ name, source, type, ...extra });
const evCols = [
  col('EvalId', 'EvalId', 'int64', { hidden: true, format: '0' }),
  col('RespId', 'RespId', 'int64', { hidden: true, format: '0' }),
  col('Family', 'Family', 'string'), col('Product', 'Product', 'string'),
  col('Slot', 'Slot', 'int64', { hidden: true, format: '0' }),
  col('Situation', 'Situation', 'string', { sortBy: 'Situation order' }), col('BuyReason', 'BuyReason', 'string'),
  col('Timing', 'Timing', 'string', { sortBy: 'Timing order' }), col('Household', 'Household', 'string', { sortBy: 'Household order' }),
  col('Frequency', 'Frequency', 'string', { sortBy: 'Frequency order' }), col('UsageChange', 'UsageChange', 'string', { sortBy: 'Usage order' }),
  col('Satisfaction', 'Satisfaction', 'int64', { format: '0' }),
  col('Satisfaction band', 'SatisfactionBand', 'string', { sortBy: 'Satisfaction order' }),
  col('Satisfaction order', 'SatisfactionOrder', 'int64', { hidden: true }),
  col('Expectation', 'Expectation', 'string', { sortBy: 'Expectation order' }),
  col('Timing order', 'TimingOrder', 'int64', { hidden: true }),
  col('Frequency order', 'FrequencyOrder', 'int64', { hidden: true }),
  col('Expectation order', 'ExpectationOrder', 'int64', { hidden: true }),
  col('Usage order', 'UsageOrder', 'int64', { hidden: true }),
  col('Situation order', 'SituationOrder', 'int64', { hidden: true }),
  col('Household order', 'HouseholdOrder', 'int64', { hidden: true }),
  col('Recommend', 'Recommend', 'int64', { format: '0' }),
  col('Recommend band', 'RecommendBand', 'string', { sortBy: 'Recommend order' }),
  col('Recommend order', 'RecommendOrder', 'int64', { hidden: true }),
  col('Still using', 'StillUsing', 'string', { hidden: true }),
  col('Like theme', 'LikeTheme', 'string'), col('Improve theme', 'ImproveTheme', 'string'),
  // Verbatim text (CF9 / CF12 / CF13 / CF15 / CF16). Filled by the XLSX extractor;
  // blank in the current build rather than invented.
  col('CF9 reason change', 'CF9', 'string'),
  col('CF12 liked most', 'CF12', 'string'),
  col('CF13 improve one', 'CF13', 'string'),
  col('CF15 score reason', 'CF15', 'string'),
  col('CF16 anything else', 'CF16', 'string'),
];
const respCols = [
  col('RespId', 'RespId', 'int64', { format: '0' }),
  col('Age', 'Age', 'string', { sortBy: 'Age order' }), col('Gender', 'Gender', 'string'), col('City', 'City', 'string'),
  col('Age order', 'AgeOrder', 'int64', { hidden: true }),
];
// Measure layer: one definition per business fact, everything else divides by it.
//
// The base counts are the only places a predicate is evaluated; every rate is
// DIVIDE(<base count>, [Evaluations]) and every ratio reuses [Promoters] / [Detractors].
// Before this, six percentages each carried its own copy of the same
// CALCULATE(...)/COUNTROWS(...) skeleton, NPS rebuilt promoter and detractor counts
// inline, and three "... plotted" aliases duplicated real measures verbatim - so a
// change to the base definition had to be made in up to seven places.
const measures = [
  { name: 'Respondents', expression: 'COUNTROWS(Respondents)', formatString: '#,##0' },
  { name: 'Evaluations', expression: 'COUNTROWS(Evaluations)', formatString: '#,##0' },
  { name: 'Promoters', expression: 'CALCULATE([Evaluations], Evaluations[Recommend] >= 9)', formatString: '#,##0' },
  { name: 'Detractors', expression: 'CALCULATE([Evaluations], Evaluations[Recommend] <= 6)', formatString: '#,##0' },
  { name: 'Top-2 evaluations', expression: 'CALCULATE([Evaluations], Evaluations[Satisfaction] >= 4)', formatString: '#,##0' },
  { name: 'Better than expected', expression: 'CALCULATE([Evaluations], Evaluations[Expectation] = "Better than expected")', formatString: '#,##0' },
  { name: 'About as expected', expression: 'CALCULATE([Evaluations], Evaluations[Expectation] = "About as expected")', formatString: '#,##0' },
  { name: 'Worse than expected', expression: 'CALCULATE([Evaluations], Evaluations[Expectation] = "Worse than expected")', formatString: '#,##0' },
  { name: 'Daily users', expression: 'CALCULATE([Evaluations], Evaluations[Frequency] = "Daily")', formatString: '#,##0' },
  { name: 'Current users', expression: 'CALCULATE([Evaluations], Evaluations[Situation] = "Current")', formatString: '#,##0' },
  { name: 'Stopped', expression: 'CALCULATE([Evaluations], Evaluations[UsageChange] = "Stopped")', formatString: '#,##0' },
  { name: 'Commented', expression: 'CALCULATE([Evaluations], NOT ISBLANK(Evaluations[CF13 improve one]))', formatString: '#,##0' },
  { name: 'Avg satisfaction (1-5)', expression: 'AVERAGE(Evaluations[Satisfaction])', formatString: '0.00' },
  { name: 'Avg recommend (0-10)', expression: 'AVERAGE(Evaluations[Recommend])', formatString: '0.00' },
  { name: 'Top-2 satisfaction %', expression: 'DIVIDE([Top-2 evaluations], [Evaluations])', formatString: '0.0%' },
  { name: 'Promoter %', expression: 'DIVIDE([Promoters], [Evaluations])', formatString: '0.0%' },
  { name: 'Detractor %', expression: 'DIVIDE([Detractors], [Evaluations])', formatString: '0.0%' },
  { name: 'Better than expected %', expression: 'DIVIDE([Better than expected], [Evaluations])', formatString: '0.0%' },
  { name: 'Daily use %', expression: 'DIVIDE([Daily users], [Evaluations])', formatString: '0.0%' },
  { name: 'Still using %', expression: 'DIVIDE([Current users], [Evaluations])', formatString: '0.0%' },
  // NPS is the same two base counts as Promoter % and Detractor %, not a third copy.
  { name: 'NPS', expression: 'IF([Evaluations] = 0, BLANK(), ROUND(DIVIDE([Promoters] - [Detractors], [Evaluations]) * 100, 0))', formatString: '0', description: 'Net Promoter Score: %promoters (9-10) minus %detractors (0-6) across product evaluations. Rounded to a whole number; blank when no evaluations are in context.' },
  { name: 'Verbatims', expression: 'CALCULATE([Evaluations], NOT ISBLANK(Evaluations[CF12 liked most]) || NOT ISBLANK(Evaluations[CF13 improve one]))', formatString: '#,##0', description: 'Evaluations carrying captured verbatim text in CF12 (liked most) or CF13 (improve one thing).' },
  { name: 'Detractor verbatims', expression: 'CALCULATE([Evaluations], Evaluations[Recommend] <= 6, NOT ISBLANK(Evaluations[CF13 improve one]))', formatString: '#,##0', description: 'Detractor evaluations (0-6) that left an improvement comment - the escalation queue.' },
  // One predicate, one count: the previous version added two CALCULATEs and
  // double-counted a comment that mentioned both words.
  // The one measure a product owner actually asks for: the complaint to fix first, per
  // family. TOPN over the theme dimension, ranked by the shared [Evaluations] count.
  { name: 'Top complaint', expression: 'VAR _themes = FILTER(VALUES(Evaluations[Improve theme]), Evaluations[Improve theme] <> "No issue")\nVAR _ranked = ADDCOLUMNS(_themes, "@n", CALCULATE([Evaluations]))\nVAR _top = TOPN(1, _ranked, [@n], DESC)\nRETURN CONCATENATEX(_top, Evaluations[Improve theme], ", ")', formatString: null, description: 'Most frequent CF13 improvement theme in the current filter context, excluding "No issue" so the result is an action rather than the absence of one.' },
  { name: 'Service mentions', expression: 'CALCULATE([Evaluations], SEARCH("service", Evaluations[CF13 improve one], 1, 0) > 0 || SEARCH("care", Evaluations[CF13 improve one], 1, 0) > 0)', formatString: '#,##0', description: 'Improvement comments mentioning service or customer care. One row counts once however many keywords it contains.' },
  // The journey funnel: each stage is one of the shared base measures, picked by
  // _Journey[Stage]. Kept next to those measures so the stages read as a single story.
  { name: 'Journey value', expression: 'SWITCH(TRUE(), _Journey[Stage] = "Evaluations", [Evaluations], _Journey[Stage] = "Current users", [Current users], _Journey[Stage] = "Daily users", [Daily users], _Journey[Stage] = "Promoters", [Promoters])', formatString: '#,##0', description: 'The funnel measure: value of the active journey stage. Evaluations to current use to daily habit to advocacy.' },
  // Gauge scale anchors: the built-in gauge wants MinValue/MaxValue/TargetValue as
  // measures. Constants keep the Overview cards at a fixed, honest scale instead of
  // whatever auto-range the visual chooses, which rescales every card differently.
  { name: 'Scale max 100', expression: '100', formatString: '0', description: 'Constant 100: the top of a 0-100 gauge scale (NPS-style cards).' },
  { name: 'Scale min -100', expression: '-100', formatString: '0', description: 'Constant -100: the bottom of an NPS (-100 to +100) gauge scale.' },
];
// Every measure carries a description: the model is read by the next analyst and by
// Copilot, and an undocumented measure is one that gets duplicated.
const MEASURE_DOCS = {
  Respondents: 'Distinct respondents in Module 1 (one row per questionnaire).',
  Evaluations: 'Product evaluations in Module 1 - one row per product a respondent rated.',
  'Avg satisfaction (1-5)': 'Mean CF10 overall satisfaction on the 1-5 scale.',
  'Top-2 satisfaction %': 'Share of evaluations rating 4 or 5 (top-two-box satisfaction).',
  'Avg recommend (0-10)': 'Mean CF14 likelihood-to-recommend on the 0-10 scale.',
  'Promoter %': 'Share of evaluations scoring 9-10 on CF14.',
  'Detractor %': 'Share of evaluations scoring 0-6 on CF14.',
  'Better than expected %': 'Share of evaluations where CF11 says the product beat expectations.',
  'Daily use %': 'Share of evaluations where CF7 usage is Daily.',
  'Still using %': 'Share of evaluations from respondents currently using the product (CF3).',
  Stopped: 'Evaluations where CF8 says usage has stopped.',
  Promoters: 'Evaluations scoring 9-10 on CF14 - the base count behind NPS and Promoter %.',
  Detractors: 'Evaluations scoring 0-6 on CF14 - the base count behind NPS and Detractor %.',
  'Top-2 evaluations': 'Evaluations rating 4 or 5 on CF10 - the base count behind Top-2 satisfaction %.',
  'Better than expected': 'Evaluations where CF11 says the product beat expectations.',
  'Daily users': 'Evaluations where CF7 usage is Daily.',
  'Current users': 'Evaluations from respondents still using the product (CF3).',
  'About as expected': 'Evaluations where CF11 says the experience matched expectations.',
  'Worse than expected': 'Evaluations where CF11 says the product fell short of expectations.',
  Commented: 'Evaluations that left an improvement comment (CF13).',
  'Scale max 100': 'Constant 100: the top of a 0-100 gauge scale (NPS-style cards).',
  'Scale min -100': 'Constant -100: the bottom of an NPS (-100 to +100) gauge scale.',
};
for (const m of measures) if (!m.description && MEASURE_DOCS[m.name]) m.description = MEASURE_DOCS[m.name];
const model = {
  tables: [
    { name: 'Evaluations', columns: evCols, rows: evaluations },
    { name: 'Respondents', columns: respCols, rows: respondents },
    { name: '_Measures', columns: [{ name: 'Dummy', source: 'Dummy', sourceColumn: '[Dummy]', type: 'string', hidden: true }], rows: [], measures, calculated: 'ROW("Dummy", BLANK())' },
    // The four funnel stages in order. Disconnected (no relationship) - [Journey value]
    // switches on them, and the funnel sorts itself by the value.
    { name: '_Journey', columns: [{ name: 'Stage', source: 'Stage', type: 'string' }], rows: [], calculated: 'DATATABLE("Stage", STRING, "Evaluations", "Current users", "Daily users", "Promoters")' },
  ],
  relationships: [{ name: 'EvaluationsToRespondents', from: 'Evaluations', fromColumn: 'RespId', to: 'Respondents', toColumn: 'RespId' }],
};

// ---------- PBIR helpers (same grammar as scripts/powerbi/pbir.mjs) ----------
// 2.7.0 is the version Microsoft's own PBIP template validates against Desktop
// (Agentic-PBIP-Template / copilot-instructions.md). A newer container schema can
// fail to resolve on older Desktop builds, which drops every visual in the report.
const VISUAL_SCHEMA = 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.12.0/schema.json';
const PAGE_SCHEMA = 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/page/2.1.0/schema.json';
const C = { paper: '#F6F0E6', card: '#FFFDF9', ink: '#1C1917', muted: '#756A5E', faint: '#A79B8D', hairline: '#DED1C0', accent: '#B4431D', accentSoft: '#D97A4B', dark: '#151210', darkPanel: '#201B17', darkLine: '#40352C', cream: '#F5EADB', teal: '#0E6B63', ochre: '#B27A1E', slate: '#395B70', plum: '#70465F', olive: '#66704A' };
const FONT = { display: 'Georgia', body: 'Segoe UI', semibold: 'Segoe UI Semibold' };
const stableId = (l) => createHash('sha1').update(String(l)).digest('hex').slice(0, 20);
const literal = (v) => ({ expr: { Literal: { Value: String(v) } } });
const textLiteral = (v) => literal(`'${String(v ?? '').replace(/'/g, "''")}'`);
const bool = (v) => literal(v ? 'true' : 'false');
const numL = (v) => literal(`${v}D`);
const colorValue = (v) => ({ solid: { color: textLiteral(v) } });
const fCol = (e, p) => ({ Column: { Expression: { SourceRef: { Entity: e } }, Property: p } });
const fMeas = (e, p) => ({ Measure: { Expression: { SourceRef: { Entity: e } }, Property: p } });
const cProj = (e, p) => ({ field: fCol(e, p), queryRef: `${e}.${p}`, nativeQueryRef: p });
const mProj = (e, p) => ({ field: fMeas(e, p), queryRef: `${e}.${p}`, nativeQueryRef: p });
function container({ fill = null, border = null, radius = 8, showTitle = false, title = '' } = {}) {
  return {
    title: [{ properties: { show: bool(showTitle), ...(showTitle ? { text: textLiteral(title) } : {}) } }],
    background: [{ properties: fill ? { show: bool(true), color: colorValue(fill), transparency: numL(0) } : { show: bool(false) } }],
    border: [{ properties: border ? { show: bool(true), color: colorValue(border), radius: numL(radius), width: numL(1) } : { show: bool(false) } }],
    dropShadow: [{ properties: { show: bool(false) } }],
    // Only title/background/border/dropShadow are declared container objects in the
    // 2.7.0 schema; an unknown key raises AdditionalProperties and can drop visuals.
  };
}
class Page {
  constructor(name) { this.displayName = name; this.id = stableId(`page:${CODE}:${name}`); this.visuals = []; this.n = 0; }
  add(label, position, visual) {
    this.n += 1; const name = stableId(`visual:${CODE}:${this.displayName}:${label}:${this.n}`);
    this.visuals.push({ name, json: { $schema: VISUAL_SCHEMA, name, position, visual } });
  }
  text(label, x, y, w, h, text, o = {}) {
    const { font = FONT.body, size = 10, color = C.ink, weight = 'normal', fill = null, border = null, radius = 8, z = 20 } = o;
    if (h > 1) h = Math.max(h, size >= 60 ? Math.ceil(size * 1.78) : size >= 15 ? Math.ceil(size * 1.6) : size >= 7 ? 18 : h);
    const style = { fontFamily: font, fontSize: `${size}pt`, color, fontWeight: weight };
    const paragraphsValue = String(text).split('\n').map((line) => ({ textRuns: [{ value: line || ' ', textStyle: style }] }));
    this.add(label, { x, y, z, height: h, width: w, tabOrder: z }, { visualType: 'textbox', objects: { general: [{ properties: { paragraphs: paragraphsValue } }] }, visualContainerObjects: container({ fill, border, radius }), drillFilterOtherVisuals: false });
  }
  panel(label, x, y, w, h, o = {}) { this.text(label, x, y, w, h, ' ', { size: 1, color: o.fill ?? C.card, fill: o.fill ?? C.card, border: o.border ?? C.hairline, radius: o.radius ?? 8, z: o.z ?? 0 }); }
  line(label, x, y, w, h, o = {}) {
    this.add(label, { x, y, z: 0, height: h, width: w, tabOrder: -1 }, { visualType: 'shape', objects: { fill: [{ properties: { show: bool(true), fillColor: colorValue(o.fill ?? C.hairline) } }], outline: [{ properties: { show: bool(false) } }], shape: [{ properties: { tileShape: literal("'rectangle'") } }] }, visualContainerObjects: container({}), drillFilterOtherVisuals: false });
  }
  card(label, x, y, w, h, measure, o = {}) {
    this.add(label, { x, y, z: 20, height: h, width: w, tabOrder: 20 }, {
      visualType: 'cardVisual',
      query: { queryState: { Data: { projections: [mProj('_Measures', measure)] } } },
      objects: {
        value: [{ properties: { fontSize: numL(o.valueSize ?? 24), fontFamily: textLiteral(FONT.display), fontColor: colorValue(C.ink) }, selector: { id: 'default' } }],
        label: [{ properties: { fontSize: numL(9), fontFamily: textLiteral(FONT.body), fontColor: colorValue(C.muted), show: bool(true) }, selector: { id: 'default' } }],
        padding: [{ properties: { paddingSelection: literal("'Custom'"), leftMargin: numL(8), topMargin: numL(8), bottomMargin: numL(8), rightMargin: numL(8) }, selector: { id: 'default' } }],
        layout: [{ properties: { cellPadding: numL(0), alignment: literal("'top'"), orientation: numL(0), columnCount: numL(1), rowCount: numL(1) }, selector: { id: 'default' } }],
        spacing: [{ properties: { verticalSpacing: numL(2) }, selector: { id: 'default' } }],
      },
      visualContainerObjects: container({ fill: C.card, border: C.hairline, radius: 9 }),
      drillFilterOtherVisuals: true,
    });
  }
  // `sort` = { e, p } sorts the category axis by a column (ordinal axes); otherwise the
  // chart ranks by value, which is right for City / Family / theme rankings.
  chart(label, x, y, w, h, { catE, catP, valE = '_Measures', valP = 'Evaluations', valKind = 'measure', fill = C.accent, sort = null, type = 'clusteredBarChart' }) {
    const sortField = sort ? fCol(sort.e, sort.p) : valKind === 'measure' ? fMeas(valE, valP) : fCol(valE, valP);
    const sortDir = sort ? 'Ascending' : 'Descending';
    const valProj = valKind === 'measure' ? mProj(valE, valP) : cProj(valE, valP);
    this.add(label, { x, y, z: 20, height: h, width: w, tabOrder: 20 }, {
      visualType: type,
      query: { sortDefinition: { sort: [{ field: sortField, direction: sortDir }], isDefaultSort: !sort }, queryState: { Category: { projections: [cProj(catE, catP)] }, Y: { projections: [valProj] } } },
      objects: {
        dataPoint: [{ properties: { fill: colorValue(fill) } }],
        labels: [{
          properties: {
            show: bool(true),
            fontSize: numL(9),
            fontFamily: textLiteral(FONT.body),
            color: colorValue(C.ink),
            labelPrecision: literal('0L'),
            labelDisplayUnits: numL(1),
            enableValueDataLabel: bool(true),
          },
        }],
        legend: [{ properties: { show: bool(false) } }],
        categoryAxis: [{ properties: { show: bool(true), showAxisTitle: bool(false), fontFamily: textLiteral(FONT.body), fontSize: numL(9), labelColor: colorValue(C.ink), maxMarginFactor: numL(35) } }],
        valueAxis: [{ properties: { show: bool(false), showAxisTitle: bool(false) } }],
      },
      visualContainerObjects: container({ fill: C.card, border: C.hairline, radius: 8 }),
      drillFilterOtherVisuals: true,
    });
  }
  // Donut/pie: category slices by a measure. Donuts suit distribution stories, pies
  // suit the same story when the centre should not be hollow.
  donut(label, x, y, w, h, { catE, catP, valE = '_Measures', valP = 'Evaluations', sort = null }, visualType = 'donutChart') {
    const query = { queryState: { Category: { projections: [cProj(catE, catP)] }, Y: { projections: [mProj(valE, valP)] } } };
    if (sort) query.sortDefinition = { sort: [{ field: fCol(sort.e, sort.p), direction: 'Ascending' }], isDefaultSort: false };
    this.add(label, { x, y, z: 20, height: h, width: w, tabOrder: 20 }, {
      visualType, query,
      objects: {
        legend: [{ properties: { show: bool(true), position: literal("'Right'"), fontSize: numL(8), fontFamily: textLiteral(FONT.body) } }],
        labels: [{ properties: { show: bool(true), fontSize: numL(8), fontFamily: textLiteral(FONT.body), color: colorValue(C.ink), labelDisplayUnits: numL(0) } }],
      },
      visualContainerObjects: container({ fill: C.card, border: C.hairline, radius: 8 }),
      drillFilterOtherVisuals: true,
    });
  }
  // Funnel: ordered stages by one measure. The built-in ID is `funnel` -
  // `funnelChart` is NOT a real type and Desktop renders it as an unknown
  // "custom visual" placeholder (sampled in the field, not guessed).
  funnel(label, x, y, w, h, { catE = '_Journey', catP = 'Stage', valP = 'Journey value' }) {
    this.add(label, { x, y, z: 20, height: h, width: w, tabOrder: 20 }, {
      visualType: 'funnel',
      query: { queryState: { Category: { projections: [cProj(catE, catP)] }, Y: { projections: [mProj('_Measures', valP)] } } },
      objects: {
        labels: [{ properties: { show: bool(true), fontSize: numL(9), fontFamily: textLiteral(FONT.body), color: colorValue(C.ink), labelDisplayUnits: numL(0) } }],
        dataPoint: [{ properties: { fill: colorValue(C.accent) } }],
      },
      visualContainerObjects: container({ fill: C.card, border: C.hairline, radius: 8 }),
      drillFilterOtherVisuals: true,
    });
  }
  // Scatter: points by category, X/Y measures, bubble size, legend = series.
  scatter(label, x, y, w, h, { catE, catP, xP, yP, sizeP }) {
    this.add(label, { x, y, z: 20, height: h, width: w, tabOrder: 20 }, {
      visualType: 'scatterChart',
      query: {
        queryState: {
          Category: { projections: [cProj(catE, catP)] },
          X: { projections: [mProj('_Measures', xP)] },
          Y: { projections: [mProj('_Measures', yP)] },
          Size: { projections: [mProj('_Measures', sizeP)] },
          Series: { projections: [cProj(catE, catP)] },
        },
      },
      objects: {
        xAxis: [{ properties: { show: bool(true), showAxisTitle: bool(false), fontFamily: textLiteral(FONT.body), fontSize: numL(8), labelColor: colorValue(C.ink) } }],
        yAxis: [{ properties: { show: bool(true), showAxisTitle: bool(false), fontFamily: textLiteral(FONT.body), fontSize: numL(8), labelColor: colorValue(C.ink) } }],
        legend: [{ properties: { show: bool(true), position: literal("'Right'"), fontSize: numL(8), fontFamily: textLiteral(FONT.body) } }],
        bubbles: [{ properties: { transparency: numL(15), displayValue: bool(false) } }],
      },
      visualContainerObjects: container({ fill: C.card, border: C.hairline, radius: 8 }),
      drillFilterOtherVisuals: true,
    });
  }
  // Treemap: group tiles, subtiles by a detail column, sized by a measure.
  treemap(label, x, y, w, h, { gE, gP, dE, dP, valP = 'Evaluations' }) {
    const queryState = { Group: { projections: [cProj(gE, gP)] }, Values: { projections: [mProj('_Measures', valP)] } };
    if (dE && dP) queryState.Details = { projections: [cProj(dE, dP)] };
    this.add(label, { x, y, z: 20, height: h, width: w, tabOrder: 20 }, {
      visualType: 'treemap',
      query: { queryState },
      objects: {
        labels: [{ properties: { show: bool(true), fontSize: numL(8), fontFamily: textLiteral(FONT.body), color: colorValue(C.ink) } }],
        legend: [{ properties: { show: bool(true), fontSize: numL(8), fontFamily: textLiteral(FONT.body) } }],
      },
      visualContainerObjects: container({ fill: C.card, border: C.hairline, radius: 8 }),
      drillFilterOtherVisuals: true,
    });
  }
  // Line: one value across an ordinal axis. NOT `line` - that name is the divider shape
  // helper, and shadowing it makes every rule on the page a broken lineChart.
  lineChart(label, x, y, w, h, { axisE, axisP, valP, sort }) {
    const query = { queryState: { Axis: { projections: [cProj(axisE, axisP)] }, Values: { projections: [mProj('_Measures', valP)] } } };
    if (sort) query.sortDefinition = { sort: [{ field: fCol(sort.e, sort.p), direction: 'Ascending' }], isDefaultSort: false };
    this.add(label, { x, y, z: 20, height: h, width: w, tabOrder: 20 }, {
      visualType: 'lineChart', query,
      objects: {
        categoryAxis: [{ properties: { show: bool(true), showAxisTitle: bool(false), fontFamily: textLiteral(FONT.body), fontSize: numL(8), labelColor: colorValue(C.ink) } }],
        valueAxis: [{ properties: { show: bool(true), showAxisTitle: bool(false), fontFamily: textLiteral(FONT.body), fontSize: numL(8), labelColor: colorValue(C.ink) } }],
        line: [{ properties: { transparency: numL(0) } }],
      },
      visualContainerObjects: container({ fill: C.card, border: C.hairline, radius: 8 }),
      drillFilterOtherVisuals: true,
    });
  }
  // Stacked columns: one category, several measures stacked.
  stackedColumn(label, x, y, w, h, { catE, catP, vals }) {
    this.add(label, { x, y, z: 20, height: h, width: w, tabOrder: 20 }, {
      visualType: 'columnChart',
      query: { queryState: { Category: { projections: [cProj(catE, catP)] }, Y: { projections: vals.map((v) => mProj('_Measures', v)) } } },
      objects: {
        legend: [{ properties: { show: bool(true), position: literal("'Bottom'"), fontSize: numL(8), fontFamily: textLiteral(FONT.body) } }],
        categoryAxis: [{ properties: { show: bool(true), showAxisTitle: bool(false), fontFamily: textLiteral(FONT.body), fontSize: numL(8), labelColor: colorValue(C.ink) } }],
        valueAxis: [{ properties: { show: bool(false), showAxisTitle: bool(false) } }],
      },
      visualContainerObjects: container({ fill: C.card, border: C.hairline, radius: 8 }),
      drillFilterOtherVisuals: true,
    });
  }
  // Gauge: a single value on a fixed min..max scale, with an optional target tick.
  // MinValue/MaxValue/TargetValue are measures in PBIR (verified against the
  // data-goblin gauge example), so the scale anchors are the constant measures.
  // `flat` puts the gauge on the parent card's surface instead of inside its own
  // bordered mini-card (the KPI cards on the Overview want this).
  gauge(label, x, y, w, h, { valP, minP = null, maxP, targetP = null, fill = C.accent, flat = false }) {
    const queryState = { Y: { projections: [mProj('_Measures', valP)] } };
    if (maxP) queryState.MaxValue = { projections: [mProj('_Measures', maxP)] };
    if (minP) queryState.MinValue = { projections: [mProj('_Measures', minP)] };
    if (targetP) queryState.TargetValue = { projections: [mProj('_Measures', targetP)] };
    this.add(label, { x, y, z: 20, height: h, width: w, tabOrder: 20 }, {
      visualType: 'gauge',
      query: { queryState },
      // Object keys mirror the formatted gauge example: dataPoint.fill and
      // calloutValue (show/fontFamily/color). No axis object - the MinValue/MaxValue
      // measures drive the scale, and a literal axis max would fight them.
      objects: {
        dataPoint: [{ properties: { fill: colorValue(fill) } }],
        calloutValue: [{ properties: { show: bool(true), fontFamily: textLiteral(FONT.body), fontSize: numL(11), color: colorValue(C.ink) } }],
      },
      visualContainerObjects: flat ? container({ fill: null, border: null, radius: 8 }) : container({ fill: C.card, border: C.hairline, radius: 8 }),
      drillFilterOtherVisuals: true,
    });
  }
  // Combo: columns for one measure, a line for a second on a secondary axis.
  combo(label, x, y, w, h, { catE, catP, yP, y2P }) {
    this.add(label, { x, y, z: 20, height: h, width: w, tabOrder: 20 }, {
      visualType: 'lineStackedColumnComboChart',
      query: { queryState: { Category: { projections: [cProj(catE, catP)] }, Y: { projections: [mProj('_Measures', yP)] }, Y2: { projections: [mProj('_Measures', y2P)] } } },
      objects: {
        legend: [{ properties: { show: bool(true), position: literal("'Bottom'"), fontSize: numL(8), fontFamily: textLiteral(FONT.body) } }],
        dataPoint: [{ properties: { fill: colorValue(C.accent) } }],
        categoryAxis: [{ properties: { show: bool(true), showAxisTitle: bool(false), fontFamily: textLiteral(FONT.body), fontSize: numL(8), labelColor: colorValue(C.ink) } }],
        valueAxis: [{ properties: { show: bool(false), showAxisTitle: bool(false), secShow: bool(true) } }],
      },
      visualContainerObjects: container({ fill: C.card, border: C.hairline, radius: 8 }),
      drillFilterOtherVisuals: true,
    });
  }
  // Area: a trend across an ordered category axis. With a Series column it becomes a
  // stacked area, which is how a mix-over-time reads without a legend table.
  areaChart(label, x, y, w, h, { catE, catP, valP, sort = null, seriesE = null, seriesP = null }) {
    const queryState = { Category: { projections: [cProj(catE, catP)] }, Y: { projections: [mProj('_Measures', valP)] } };
    if (seriesE) queryState.Series = { projections: [cProj(seriesE, seriesP)] };
    const query = { queryState };
    if (sort) query.sortDefinition = { sort: [{ field: fCol(sort.e, sort.p), direction: 'Ascending' }], isDefaultSort: false };
    this.add(label, { x, y, z: 20, height: h, width: w, tabOrder: 20 }, {
      visualType: seriesE ? 'stackedAreaChart' : 'areaChart', query,
      objects: {
        categoryAxis: [{ properties: { show: bool(true), showAxisTitle: bool(false), fontFamily: textLiteral(FONT.body), fontSize: numL(8), labelColor: colorValue(C.ink) } }],
        valueAxis: [{ properties: { show: bool(false), showAxisTitle: bool(false) } }],
        legend: [{ properties: { show: bool(!!seriesE), position: literal("'Bottom'"), fontSize: numL(8), fontFamily: textLiteral(FONT.body) } }],
        line: [{ properties: { transparency: numL(0) } }],
      },
      visualContainerObjects: container({ fill: C.card, border: C.hairline, radius: 8 }),
      drillFilterOtherVisuals: true,
    });
  }
  // Waterfall: sequential additions accumulating to a total - the shape of a
  // "how the 21 add up" story. Breakdown is optional; without it every bar steps.
  waterfall(label, x, y, w, h, { catE, catP, valP }) {
    this.add(label, { x, y, z: 20, height: h, width: w, tabOrder: 20 }, {
      visualType: 'waterfallChart',
      query: { queryState: { Category: { projections: [cProj(catE, catP)] }, Y: { projections: [mProj('_Measures', valP)] } } },
      objects: {
        categoryAxis: [{ properties: { show: bool(true), showAxisTitle: bool(false), fontFamily: textLiteral(FONT.body), fontSize: numL(8), labelColor: colorValue(C.ink) } }],
        valueAxis: [{ properties: { show: bool(false), showAxisTitle: bool(false) } }],
        dataPoint: [{ properties: { fill: colorValue(C.accent) } }],
      },
      visualContainerObjects: container({ fill: C.card, border: C.hairline, radius: 8 }),
      drillFilterOtherVisuals: true,
    });
  }
  // Matrix heatmap: a pivotTable with a FillRule gradient driving cell backgrounds.
  // Rows × Columns × Values, and an explicit two-stop gradient (linearGradient2 with
  // fixed bounds) whose Input measure drives the color. The per-cell entry mirrors the
  // tableEx gradient example: dataViewWildcard matchingOption 1 + selector metadata
  // carrying the measure's queryRef.
  matrix(label, x, y, w, h, { rowE, rowP, colE, colP, valP, minColor = '#F7F3EC', maxColor = '#B4431D', maxValue = 4 }) {
    const fillRule = {
      expr: {
        FillRule: {
          Input: fMeas('_Measures', valP),
          FillRule: {
            linearGradient2: {
              min: { color: { Literal: { Value: `'${minColor}'` } }, value: { Literal: { Value: '0D' } } },
              max: { color: { Literal: { Value: `'${maxColor}'` } }, value: { Literal: { Value: `${maxValue}D` } } },
              nullColoringStrategy: { strategy: { Literal: { Value: "'asZero'" } } },
            },
          },
        },
      },
    };
    this.add(label, { x, y, z: 20, height: h, width: w, tabOrder: 20 }, {
      visualType: 'pivotTable',
      query: { queryState: { Rows: { projections: [cProj(rowE, rowP)] }, Columns: { projections: [cProj(colE, colP)] }, Values: { projections: [mProj('_Measures', valP)] } } },
      objects: {
        grid: [{ properties: { gridHorizontal: bool(true), gridHorizontalColor: colorValue(C.hairline), rowPadding: numL(2), outlineStyle: numL(1), outlineColor: colorValue(C.hairline), textSize: numL(9) } }],
        columnHeaders: [{ properties: { fontFamily: textLiteral(FONT.semibold), fontSize: numL(7), fontColor: colorValue(C.ink), backColor: colorValue('#F1E7DA'), alignment: literal("'Center'"), titleAlignment: literal("'Center'") } }],
        rowHeaders: [{ properties: { fontFamily: textLiteral(FONT.body), fontSize: numL(8), fontColor: colorValue(C.ink), backColor: colorValue('#F1E7DA'), stepped: bool(true) } }],
        values: [
          { properties: { fontFamily: textLiteral(FONT.body), fontSize: numL(8.5), fontColor: colorValue(C.ink), backColor: colorValue(C.card), backColorSecondary: colorValue('#FBF6EE') } },
          { properties: { backColor: { solid: { color: fillRule } } }, selector: { data: [{ dataViewWildcard: { matchingOption: 1 } }], metadata: `_Measures.${valP}` } },
        ],
      },
      visualContainerObjects: container({ fill: C.card, border: C.hairline, radius: 8 }),
      drillFilterOtherVisuals: true,
    });
  }
  // Key Drivers (Key Influencers): one Analyze measure explained by one or more
  // dimensions. Type is `keyDriversVisual` (`keyInfluencersVisual` resolves to a
  // theme key, not a visual) and the roles are `Analyze` / `ExplainBy` - the
  // AI-family wells verified against Desktop-exported PBIR, NOT Y/Legend.
  keyInfluencers(label, x, y, w, h, { valP, explain }) {
    this.add(label, { x, y, z: 20, height: h, width: w, tabOrder: 20 }, {
      visualType: 'keyDriversVisual',
      query: { queryState: { Analyze: { projections: [mProj('_Measures', valP)] }, ExplainBy: { projections: explain.map(([e, p]) => cProj(e, p)) } } },
      objects: {},
      visualContainerObjects: container({ fill: C.card, border: C.hairline, radius: 8 }),
      drillFilterOtherVisuals: true,
    });
  }
  table(label, x, y, w, h, projections, sort) {
    const query = { queryState: { Values: { projections } } };
    if (sort) query.sortDefinition = { sort: [{ field: sort.kind === 'measure' ? fMeas(sort.e, sort.p) : fCol(sort.e, sort.p), direction: sort.d ?? 'Ascending' }], isDefaultSort: false };
    this.add(label, { x, y, z: 20, height: h, width: w, tabOrder: 20 }, {
      visualType: 'tableEx', query,
      objects: {
        grid: [{ properties: { gridHorizontal: bool(true), gridHorizontalColor: colorValue(C.hairline), rowPadding: numL(7), outlineStyle: numL(1), outlineColor: colorValue(C.hairline) } }],
        columnHeaders: [{ properties: { fontFamily: textLiteral(FONT.semibold), fontSize: numL(8.5), fontColor: colorValue(C.muted), backColor: colorValue('#F1E7DA'), alignment: literal("'Left'") } }],
        values: [{ properties: { fontFamily: textLiteral(FONT.body), fontSize: numL(8.5), fontColor: colorValue(C.ink), backColor: colorValue(C.card), backColorSecondary: colorValue('#FBF6EE') } }],
      },
      visualContainerObjects: container({ fill: C.card, border: C.hairline, radius: 8 }),
      drillFilterOtherVisuals: true,
    });
  }
  slicer(label, x, y, w, h, e, p) {
    this.add(label, { x, y, z: 20, height: h, width: w, tabOrder: 20 }, {
      visualType: 'slicer', query: { queryState: { Values: { projections: [cProj(e, p)] } } },
      objects: { data: [{ properties: { mode: literal("'Dropdown'") } }], selection: [{ properties: { singleSelect: bool(false) } }], header: [{ properties: { show: bool(false) } }] },
      visualContainerObjects: container({ fill: C.card, border: C.hairline, radius: 8 }), drillFilterOtherVisuals: true,
    });
  }
  header(num, eyebrow, title, subtitle) {
    this.panel('bg', 0, 0, 1280, 720, { fill: C.paper, border: null, radius: 0, z: 0 });
    this.text('brand', 48, 24, 500, 18, 'ORACURA  /  MODULE 1 CUSTOMER FEEDBACK', { size: 8, color: C.accent, weight: '600', z: 200 });
    this.text('pageno', 1170, 24, 62, 18, String(num), { size: 9, color: C.muted, weight: '600', z: 200 });
    this.text('title', 48, 46, 1100, 42, title, { font: FONT.display, size: title.length > 52 ? 23 : 26, z: 200 });
    if (subtitle) this.text('sub', 48, 90, 1120, 22, subtitle, { size: 9.5, color: C.muted, z: 200 });
    this.line('rule', 48, 122, 1184, 1, { z: 190 });
    this.text('footer', 48, 692, 930, 15, `ORACURA MODULE 1  ·  ${kpi.respondents} RESPONDENTS  ·  ${kpi.evaluations} PRODUCT EVALUATIONS  ·  LIVE RAW DATA (CODED)`, { size: 7, color: C.faint, z: 200 });
  }
  // Page navigation: a real actionButton per target, wired through visualLink. This is
  // the one object type here whose behaviour cannot be simulated, so it is kept to a
  // minimal, Desktop-authored shape: text + fill + outline on the button, and only
  // show/type/navigationSection inside visualLink.
  navButton(label, x, y, w, h, targetPageId, o = {}) {
    this.add(label, { x, y, z: 300, height: h, width: w, tabOrder: 300 }, {
      visualType: 'actionButton',
      objects: {
        // Dual entry: `show` alone unselectored, styling in the `id: 'default'`
        // selectored entry (Microsoft spec) - a single-entry bag renders the
        // button with defaults, which is exactly the invisible-text bug.
        text: [
          { properties: { show: bool(true) } },
          {
            properties: {
              text: textLiteral(o.text ?? ''),
              fontFamily: textLiteral(FONT.body),
              fontSize: numL(o.size ?? 8),
              fontColor: colorValue(o.color ?? C.muted),
              horizontalAlignment: literal("'center'"),
            },
            selector: { id: 'default' },
          },
        ],
        fill: [
          { properties: { show: bool(!!o.fill) } },
          { properties: { fillColor: colorValue(o.fill ?? C.card), transparency: numL(o.fill ? 0 : 100) }, selector: { id: 'default' } },
        ],
        // Desktop writes an `icon` member on every actionButton (usually show:false);
        // keep it - a button without it is a shape Desktop may treat as a plain rect.
        icon: [{ properties: { show: bool(false) } }],
        outline: [{ properties: { show: bool(false) } }],
      },
      visualContainerObjects: {
        title: [{ properties: { show: bool(false) } }],
        background: [{ properties: { show: bool(false) } }],
        border: [{ properties: { show: bool(false) } }],
        dropShadow: [{ properties: { show: bool(false) } }],
        visualLink: [{
          properties: {
            show: bool(true),
            type: literal(`'${o.linkType ?? 'PageNavigation'}'`),
            ...(targetPageId
              ? { [o.linkType === 'Drillthrough' ? 'drillthroughSection' : 'navigationSection']: literal(`'${targetPageId}'`) }
              : {}),
          },
        }],
      },
      drillFilterOtherVisuals: true,
    });
  }
  // NOTE: no `howCreated` on the visual object. Desktop's visual schema
  // rejects it ("An additional property 'howCreated' was included in the
  // /visual property") - it belongs only on filter entries, e.g. the
  // drillthrough filterConfig below. Verified in the field, not guessed.
  // Two buttons in the footer: back one page, forward one page (or back to the index).
  nav(prevName, nextName, dark = false) {
    // Footer text stops at 988px; the two buttons own 996-1232. Labels are truncated
    // rather than allowed to wrap, because a wrapped button grows out of its box.
    // Short, intentional labels: a truncated page name reads like a bug.
    const NAV_LABEL = {
      '00 Cover': 'INDEX', '01 Findings': 'FINDINGS', '02 Executive': 'EXECUTIVE',
      '03 Who bought what': 'WHO BOUGHT', '04 Usage & retention': 'USAGE',
      '05 Experience & satisfaction': 'EXPERIENCE', '06 Recommendation & voice': 'RECOMMEND',
      '07 Voice of customer': 'VERBATIMS', '08 Where to act': 'ACTIONS', '09 Journey & heat': 'JOURNEY',
      '00 Overview': 'OVERVIEW', '10 Family deep-dive': 'DEEP-DIVE', '11 Deck reconciliation': 'RECON',
    };
    const label = (name) => NAV_LABEL[name] ?? name.replace(/^\d+\s/, '').toUpperCase().slice(0, 12);
    const base = { color: dark ? '#E8D9C6' : C.muted, fill: dark ? C.darkPanel : C.card };
    if (prevName) {
      this.navButton('navprev', 996, 684, 106, 22, pageIdOf(prevName), { ...base, size: 7.5, text: `\u2039  ${label(prevName)}` });
    }
    if (nextName) {
      const back = nextName === '00 Cover';
      this.navButton('navnext', 1110, 684, 122, 22, pageIdOf(nextName), { ...base, size: 7.5, text: `${back ? 'INDEX' : label(nextName)}  \u203a`, color: dark ? C.accentSoft : C.accent });
    }
  }
  heading(x, y, t, s = '', w = 560) {
    this.text('ch', x, y, w, 18, t.toUpperCase(), { size: 8.5, color: C.muted, weight: '600', z: 200 });
    if (s) this.text('cs', x, y + 19, w, 16, s, { size: 8, color: C.faint, z: 200 });
  }
  narrative(x, y, w, h, title, body) {
    this.panel('np', x, y, w, h, { fill: '#EFE4D5', border: null, radius: 6, z: 10 });
    this.text('nt', x + 14, y + 10, w - 28, 14, title.toUpperCase(), { size: 8, color: C.accent, weight: '600', z: 100 });
    this.text('nb', x + 14, y + 30, w - 28, h - 38, body, { size: 8.8, z: 100 });
  }
  // A drillthrough page is a regular page plus three extra keys: type Drillthrough,
  // a filterConfig entry whose howCreated is "Drillthrough", and a pageBinding
  // parameter whose boundFilter references that filter (Microsoft authoring guide).
  json() {
    const base = { $schema: PAGE_SCHEMA, name: this.id, displayName: this.displayName, displayOption: 'FitToPage', width: 1280, height: 720, objects: { background: [{ properties: { color: colorValue(C.paper), transparency: numL(0) } }] } };
    if (this.drillthroughField) {
      const filterName = `Filter${stableId(`dt-filter:${CODE}`)}`;
      const fieldExpr = { Column: { Expression: { SourceRef: { Entity: 'Evaluations' } }, Property: this.drillthroughField } };
      return {
        ...base,
        type: 'Drillthrough',
        filterConfig: { filters: [{ name: filterName, field: fieldExpr, type: 'Categorical', howCreated: 'Drillthrough' }] },
        pageBinding: { name: 'Pod', type: 'Drillthrough', parameters: [{ name: `Param_${filterName}`, boundFilter: filterName, fieldExpr }] },
      };
    }
    return base;
  }
}

// ---------- pages ----------
// Navigation targets are computed from the same stable ids the pages get, so a button
// always points at a page that exists (the validator checks every navigationSection).
// Manifest order is push order below; there is no separate page list.
const pageIdOf = (name) => stableId(`page:${CODE}:${name}`);
const pages = [];

// Cover
{
  const p = new Page('00 Cover');
  p.panel('bg', 0, 0, 1280, 720, { fill: C.dark, border: null, radius: 0, z: 0 });
  p.panel('accent', 0, 0, 13, 720, { fill: C.accent, border: null, radius: 0, z: 5 });
  p.text('l', 64, 54, 600, 18, 'POWER BI  /  CUSTOMER FEEDBACK  /  ANALYTICAL REPORT', { size: 8.5, color: C.accentSoft, weight: '600', z: 100 });
  p.text('code', 64, 130, 800, 110, 'ORACURA', { font: FONT.display, size: 78, color: C.cream, z: 100 });
  p.text('deck', 64, 260, 720, 58, 'Module 1 - Customer Feedback', { font: FONT.display, size: 24, color: C.cream, z: 100 });
  p.text('sub', 64, 320, 720, 60, `${kpi.respondents} respondents · ${kpi.evaluations} product evaluations · CF1-CF16\nSatisfaction, usage, expectation and recommendation - from the live raw data.`, { size: 11, color: '#B9A897', z: 100 });
  p.line('rule', 64, 400, 620, 1, { fill: C.darkLine, z: 100 });
  const meta = [['RESPONDENTS', String(kpi.respondents)], ['EVALUATIONS', String(kpi.evaluations)], ['AVG SATISFACTION', `${kpi.avgSat} / 5`], ['NPS', String(kpi.nps)]];
  p.panel('mp', 850, 130, 366, 286, { fill: C.darkPanel, border: C.darkLine, radius: 6, z: 120 });
  meta.forEach(([l, v], i) => { const y = 154 + i * 62; p.text('mk', 878, y, 300, 14, l, { size: 7.5, color: '#988675', weight: '600', z: 160 }); p.text('mv', 878, y + 19, 310, 26, v, { font: FONT.display, size: 17, color: C.cream, z: 160 }); });
  const strip = [['TOP-2 SATISFACTION', `${kpi.top2}%`], ['BETTER THAN EXPECTED', `${kpi.better}%`], ['DAILY USE', `${kpi.daily}%`]];
  strip.forEach(([l, v], i) => { const x = 64 + i * 286; p.panel(`k${i}`, x, 450, 260, 92, { fill: C.darkPanel, border: C.darkLine, radius: 6, z: 120 }); p.text('kv', x + 18, 466, 220, 36, v, { font: FONT.display, size: 27, color: C.cream, z: 160 }); p.text('kl', x + 18, 510, 220, 16, l, { size: 7.5, color: C.accentSoft, weight: '600', z: 160 }); });
  p.text('bottom', 64, 596, 940, 56, 'Twelve analytical pages + drillthrough: 00 Overview · 01 Findings · 02 Executive · 03 Who bought what · 04 Usage · 05 Experience · 06 Recommendation · 07 Voice · 08 Actions · 09 Journey · 10 Deep-dive · 11 Reconciliation.\nAll visuals are live DAX over the embedded Evaluations / Respondents tables.', { size: 8.5, color: '#B9A897', z: 100 });
  p.nav(null, '00 Overview', true);
  pages.push(p);
}

// 01 Findings - the answer first, the evidence second.
{
  const p = new Page('01 Findings');
  p.header(1, '', 'Five things this data actually says', `Read this page instead of the charts. Each line is a claim with the number that supports it, taken from the ${kpi.evaluations} evaluations.`);
  const findings = [
    ['The experience is strong, not marginal.',
     `Average satisfaction is ${kpi.avgSat}/5 and ${kpi.top2}% of evaluations sit in the top two boxes, with ${kpi.better}% beating expectations. This is not a product-quality crisis; it is a mature product with a service tail.`,
     `${kpi.top2}%`, 'TOP-2'],
    [`The unhappy ${kpi.detractors} are dispersed, not systemic.`,
     `Detractors split across ${detSplit()}. No single defect would move the score - this is a casework queue, not a design flaw to re-engineer.`,
     String(kpi.detractors), 'DETRACTORS'],
    ['Warranty is the risk line, not the volume line.',
     `${kpi.warrantyDetPct}% of warranty evaluations are detractors against a ${kpi.detBasePct}% base rate. The base is small (${kpi.warrantyN}), but a replacement journey that misfires costs trust in a way a spec miss does not.`,
     `${kpi.warrantyDetPct}%`, 'WARRANTY'],
    ['The habit is real, and it is earned.',
     `Usage is more likely to have gone up than down, ${kpi.daily}% use the product daily and ${kpi.current}% are still using it. Retention is being won at the point of use, not by discount.`,
     `${kpi.daily}%`, 'DAILY USE'],
    ['The next product fix is battery.',
     `${kpi.improveCounts.Battery ?? 0} of ${kpi.evaluations} improvement comments name battery - the largest single fixable theme, ahead of pressure (${kpi.improveCounts['Pressure speed'] ?? 0}) and service (${kpi.improveCounts.Service ?? 0}). The ${kpi.promoters} promoters already carry the brand; battery protects the next cohort.`,
     String(kpi.improveCounts.Battery ?? 0), 'BATTERY'],
  ];
  findings.forEach(([claim, evidence, metric, label], i) => {
    const y = 140 + i * 108;
    p.text(`f${i}n`, 48, y, 40, 30, String(i + 1).padStart(2, '0'), { font: FONT.display, size: 20, color: C.accent, z: 200 });
    p.text(`f${i}c`, 100, y + 2, 800, 26, claim, { font: FONT.display, size: 15, z: 200 });
    p.text(`f${i}e`, 100, y + 34, 800, 56, evidence, { size: 8.8, color: C.muted, z: 200 });
    p.text(`f${i}m`, 940, y + 2, 292, 40, metric, { font: FONT.display, size: 26, z: 200 });
    p.text(`f${i}l`, 942, y + 44, 292, 18, label, { size: 7.5, color: C.accent, weight: '600', z: 200 });
    if (i < findings.length - 1) p.line(`f${i}r`, 48, y + 96, 1184, 1, { z: 190 });
  });
  p.nav('00 Overview', '02 Executive');
  pages.push(p);
}

// 00 Overview - the whole study on one screen, in the operations style of the
// reference: pill tabs, slicer row, KPI cards with gauges, a dark hero, and a
// three-card bottom band. Every visual is live; the tabs are real nav buttons.
{
  const p = new Page('00 Overview');
  p.panel('bg', 0, 0, 1280, 720, { fill: C.paper, border: null, radius: 0, z: 0 });
  // Chrome: wordmark + pill tabs + context chip (the reference puts tabs top-centre).
  p.panel('brand', 48, 14, 176, 32, { fill: C.dark, border: null, radius: 16, z: 200 });
  p.text('brandt', 70, 22, 150, 16, 'ORACURA', { font: FONT.display, size: 13, color: C.cream, weight: '600', z: 210 });
  p.navButton('tab-o', 240, 16, 112, 28, pageIdOf('00 Overview'), { color: C.cream, fill: C.dark, size: 7.5, text: 'OVERVIEW' });
  p.navButton('tab-f', 360, 16, 112, 28, pageIdOf('01 Findings'), { color: C.muted, fill: C.card, size: 7.5, text: 'FINDINGS' });
  p.navButton('tab-e', 480, 16, 118, 28, pageIdOf('02 Executive'), { color: C.muted, fill: C.card, size: 7.5, text: 'EXECUTIVE' });
  p.navButton('tab-j', 606, 16, 112, 28, pageIdOf('09 Journey & heat'), { color: C.muted, fill: C.card, size: 7.5, text: 'JOURNEY' });
  p.navButton('tab-r', 724, 16, 112, 28, pageIdOf('11 Deck reconciliation'), { color: C.muted, fill: C.card, size: 7.5, text: 'RECON' });
  p.panel('chip', 876, 16, 356, 28, { fill: C.card, border: C.hairline, radius: 14, z: 200 });
  p.text('chipt', 892, 24, 330, 12, `Module 1 · ${kpi.respondents} respondents · ${kpi.evaluations} evaluations`, { size: 8, color: C.muted, weight: '600', z: 210 });
  p.text('caption', 48, 52, 600, 12, 'CUSTOMER PULSE · MODULE 1', { size: 8, color: C.accent, weight: '600', z: 200 });
  p.text('title', 48, 66, 760, 40, 'Satisfaction pulse', { font: FONT.display, size: 27, z: 200 });
  p.text('sub', 48, 106, 820, 16, 'The whole study on one screen. Filter below; every card, gauge and chart follows the same cut.', { size: 9.5, color: C.muted, z: 200 });
  p.slicer('s-family', 48, 126, 280, 56, 'Evaluations', 'Family');
  p.slicer('s-city', 340, 126, 280, 56, 'Respondents', 'City');
  p.slicer('s-age', 632, 126, 280, 56, 'Respondents', 'Age');
  p.slicer('s-gender', 924, 126, 280, 56, 'Respondents', 'Gender');
  // Three KPI + gauge composite cards (reference's left stack). Each card reads like the
  // reference: icon chip + label, a small delta in accent, then the big number - the
  // accent line is a CHANGE or a count, never the value again (that read as a bug).
  const kpiCards = [
    ['Top-2 satisfaction', `${kpi.top2Count} of ${kpi.evaluations} evaluations`, 'Rated 4 or 5 on CF10 (1-5)', 'Top-2 satisfaction %', { maxP: 'Scale max 100', fill: C.accent }, '#F6E3D6', 'SAT'],
    ['NPS', `+${kpi.nps} - the client deck read +6`, 'Promoters (9-10) minus detractors (0-6)', 'NPS', { minP: 'Scale min -100', maxP: 'Scale max 100', fill: C.accent }, '#F6E3D6', 'NPS'],
    ['Daily use', `${kpi.dailyCount} of ${kpi.evaluations} evaluations`, 'CF7 = Daily', 'Daily use %', { maxP: 'Scale max 100', fill: C.teal }, '#D7EBE9', 'USE'],
  ];
  // The card visual prints the measure name as its label under the value, so no
  // separate sub-caption: it would overprint that label (seen in the screenshot pass).
  kpiCards.forEach(([label, note, , measure, scale, chipFill, mono], i) => {
    const y = 184 + i * 100;
    p.panel(`kc${i}`, 48, y, 320, 92, { fill: C.card, border: C.hairline, radius: 9, z: 10 });
    p.panel(`kch${i}`, 64, y + 9, 30, 21, { fill: chipFill, border: null, radius: 6, z: 100 });
    p.text(`kchm${i}`, 64, y + 13, 30, 12, mono, { size: 7, color: '#1C1917', weight: '600', z: 110 });
    p.text(`kl${i}`, 100, y + 11, 200, 14, label.toUpperCase(), { size: 8.5, color: C.muted, weight: '600', z: 200 });
    p.text(`kd${i}`, 64, y + 29, 200, 13, note, { size: 8, color: C.accent, weight: '600', z: 200 });
    p.card(`kv${i}`, 64, y + 44, 160, 44, measure, { valueSize: 24 });
    p.gauge(`kg${i}`, 232, y + 8, 124, 76, { valP: measure, ...scale, flat: true });
  });
  // Dark hero: a dense status card in the reference's idiom - badge + name, one huge
  // number and its delta, five mini progress bars, then label/value rows. The funnel
  // moves to the right column as the page's big illustration (like the building).
  p.panel('hero', 380, 184, 468, 292, { fill: C.dark, border: null, radius: 10, z: 10 });
  p.panel('hbadge', 398, 196, 34, 30, { fill: '#E5B83E', border: null, radius: 5, z: 100 });
  p.text('hbadgem', 398, 205, 34, 12, 'ALL', { size: 7, color: C.dark, weight: '700', z: 110 });
  p.text('ht', 442, 196, 320, 18, 'All journeys', { size: 13, color: C.cream, weight: '600', z: 200 });
  p.text('hs', 442, 216, 320, 12, `${kpi.evaluations} product evaluations`, { size: 8, color: '#B9A897', z: 200 });
  p.panel('hgo', 816, 196, 26, 26, { fill: C.darkPanel, border: C.darkLine, radius: 13, z: 100 });
  p.text('hgom', 816, 202, 26, 14, '→', { size: 10, color: C.cream, z: 110 });
  p.text('hhuge', 398, 238, 220, 34, `${kpi.current}%`, { size: 26, color: C.cream, weight: '600', z: 200 });
  p.text('hdelta', 620, 250, 210, 14, `${kpi.currentCount} of ${kpi.evaluations} still in use`, { size: 8.5, color: '#8FD0B4', z: 200 });
  const stages = [['Evaluations', String(kpi.evaluations), 1, C.slate], ['Still using', String(kpi.currentCount), kpi.currentCount / kpi.evaluations, C.teal], ['Daily', String(kpi.dailyCount), kpi.dailyCount / kpi.evaluations, C.ochre], ['Promoters', String(kpi.promoters), kpi.promoters / kpi.evaluations, C.accentSoft], ['Detractors', String(kpi.detractors), kpi.detractors / kpi.evaluations, C.plum]];
  stages.forEach(([l, v, frac, color], i) => {
    const y = 292 + i * 20;
    p.text(`hbl${i}`, 398, y, 70, 12, l, { size: 7.5, color: '#B9A897', z: 200 });
    p.panel(`hbt${i}`, 474, y + 3, 292, 8, { fill: '#2A251F', border: null, radius: 4, z: 100 });
    p.panel(`hbf${i}`, 474, y + 3, Math.max(10, Math.round(292 * Math.min(1, frac))), 8, { fill: color, border: null, radius: 4, z: 105 });
    p.text(`hbv${i}`, 774, y, 58, 12, `${v} · ${Math.round(frac * 100)}%`, { size: 8, color: C.cream, z: 200 });
  });
  p.line('hrule', 398, 400, 432, 1, { fill: C.darkLine, z: 100 });
  const rows = [
    ['ON USE', `${kpi.current}% - ${kpi.currentCount} of ${kpi.evaluations} evaluations remain in use`],
    ['DAILY HABIT', `${kpi.daily}% - ${kpi.dailyCount} of ${kpi.evaluations} use the product daily`],
    ['ADVOCATES', `${kpi.promoters} promoters - ${promPct}% of evaluations advocate`],
    ['WATCH-OUT', `Warranty ${kpi.warrantyDetPct}% detractors - battery is the top fix`],
  ];
  rows.forEach(([l, v], i) => {
    const y = 408 + i * 16;
    p.text(`hrl${i}`, 398, y, 90, 12, l, { size: 7, color: '#988675', weight: '600', z: 200 });
    p.text(`hrv${i}`, 494, y, 336, 12, v, { size: 8.2, color: C.cream, z: 200 });
  });
  // Right: the journey funnel as the bold centerpiece (the building in the reference).
  // The satisfaction-mix donut still lives on 02 Executive.
  p.funnel('pfun', 860, 184, 372, 292, {});
  // Bottom band: combo (evaluations columns + NPS line by family), area (avg satisfaction by age), scoreboard.
  p.heading(48, 482, 'Evaluations and NPS by family', 'Column = evaluations · line = NPS (right axis)', 470);
  p.combo('cf', 48, 514, 470, 156, { catE: 'Evaluations', catP: 'Family', yP: 'Evaluations', y2P: 'NPS' });
  p.heading(530, 482, 'Avg satisfaction by age', 'Mean CF10 by respondent age band', 360);
  p.areaChart('agearea', 530, 514, 360, 156, { catE: 'Respondents', catP: 'Age', valP: 'Avg satisfaction (1-5)', sort: { e: 'Respondents', p: 'Age order' } });
  p.heading(902, 482, 'Family scoreboard', 'Evaluations · avg satisfaction · NPS', 330);
  p.table('sboard', 902, 514, 330, 156, [
    cProj('Evaluations', 'Family'),
    mProj('_Measures', 'Evaluations'),
    mProj('_Measures', 'Avg satisfaction (1-5)'),
    mProj('_Measures', 'NPS'),
  ], { e: '_Measures', p: 'Evaluations', kind: 'measure', d: 'Descending' });
  p.nav('00 Cover', '01 Findings');
  pages.push(p);
}

// 02 Executive
{
  const p = new Page('02 Executive');
  p.header(2, '', 'The headline: satisfied, daily, and recommending', `Every card and chart below is computed from the ${kpi.evaluations} product evaluations. Use the slicers to cut the same story by city, age, gender or family.`);
  ['Respondents', 'Evaluations', 'Avg satisfaction (1-5)', 'NPS'].forEach((m, i) => p.card(`k${i}`, 48 + i * 300, 140, 282, 94, m));
  p.heading(48, 252, 'Evaluations by product family', 'Water flossers dominate the base; accessories are the long tail');
  p.chart('fam', 48, 286, 580, 210, { catE: 'Evaluations', catP: 'Family', fill: C.accent });
  p.heading(650, 252, 'Satisfaction (1-5) distribution', 'Top-2 (4-5) is the KPI card on the cover');
  p.donut('sat', 650, 286, 580, 210, { catE: 'Evaluations', catP: 'Satisfaction band', sort: { e: 'Evaluations', p: 'Satisfaction order' } });
  p.heading(48, 512, 'Recommendation bands (NPS)', 'Promoters 9-10 · Passives 7-8 · Detractors 0-6');
  // A pie, not a third bar: distribution stories compare against the whole.
  p.donut('nps', 48, 546, 580, 130, { catE: 'Evaluations', catP: 'Recommend band', sort: { e: 'Evaluations', p: 'Recommend order' } }, 'pieChart');
  p.narrative(650, 512, 582, 164, 'Analyst read · all data', `Average satisfaction is ${kpi.avgSat}/5 with ${kpi.top2}% in the top two boxes, and NPS sits at ${kpi.nps}. ${kpi.better}% beat expectations - the experience is over-delivering, not just meeting the brief. The risk is concentrated in a small detractor tail (see page 05), not in the mainstream experience.`);
  // slicers row is on page 02; keep executive clean
  p.nav('01 Findings', '03 Who bought what');
  pages.push(p);
}

// 02 Who & What
{
  const p = new Page('03 Who bought what');
  p.header(3, '', 'Who bought what - and why', 'Profile (S1-S3) comes from Respondents; purchase context (CF2-CF6) is per product evaluation.');
  p.text('sl', 48, 140, 300, 16, 'FILTER THIS REPORT', { size: 8, color: C.muted, weight: '600', z: 200 });
  p.slicer('city', 48, 160, 280, 64, 'Respondents', 'City');
  p.slicer('age', 340, 160, 280, 64, 'Respondents', 'Age');
  p.slicer('gender', 632, 160, 280, 64, 'Respondents', 'Gender');
  p.slicer('family', 924, 160, 280, 64, 'Evaluations', 'Family');
  p.heading(48, 240, 'Respondents by city', 'S3 - where the base lives');
  p.chart('cityc', 48, 274, 580, 190, { catE: 'Respondents', catP: 'City', valP: 'Respondents', fill: C.slate });
  p.heading(650, 240, 'Respondents by age', 'S1 - an ordinal axis, read as a curve');
  p.lineChart('agec', 650, 274, 580, 190, { axisE: 'Respondents', axisP: 'Age', valP: 'Respondents', sort: { e: 'Respondents', p: 'Age order' } });
  p.heading(48, 480, 'Main reason for purchase (CF4)', 'Dentist recommendation is the biggest single door in');
  p.donut('why', 48, 514, 580, 160, { catE: 'Evaluations', catP: 'BuyReason' });
  p.heading(650, 480, 'When purchased (CF5)', 'Most of the base bought within the last year');
  p.areaChart('when', 650, 514, 580, 160, { catE: 'Evaluations', catP: 'Timing', valP: 'Evaluations', sort: { e: 'Evaluations', p: 'Timing order' } });
  p.nav('02 Executive', '04 Usage & retention');
  pages.push(p);
}

// 03 Usage
{
  const p = new Page('04 Usage & retention');
  p.header(4, '', 'Usage: daily habit, still in use', 'CF3 current situation, CF7 frequency, CF8 change since purchase. Retention is the story - churn is small but visible.');
  ['Still using %', 'Daily use %', 'Stopped', 'Evaluations'].forEach((m, i) => p.card(`k${i}`, 48 + i * 300, 140, 282, 90, m, { valueSize: 22 }));
  p.heading(48, 246, 'How often used now (CF7)', 'Daily + several-times-a-week is the active core');
  p.areaChart('freq', 48, 280, 580, 200, { catE: 'Evaluations', catP: 'Frequency', valP: 'Evaluations', sort: { e: 'Evaluations', p: 'Frequency order' } });
  p.heading(650, 246, 'Usage vs. first purchase (CF8)', 'More frequent is the modal answer - habit is building, not fading');
  p.chart('chg', 650, 280, 580, 200, { catE: 'Evaluations', catP: 'UsageChange', fill: C.accent, sort: { e: 'Evaluations', p: 'Usage order' } });
  p.heading(48, 496, 'Current situation (CF3)', 'The hardly-used and lapsed minority');
  p.chart('sit', 48, 530, 280, 140, { catE: 'Evaluations', catP: 'Situation', fill: C.slate, sort: { e: 'Evaluations', p: 'Situation order' }, type: 'columnChart' });
  p.heading(348, 496, 'Who uses it (CF6)', 'Household reach - family use retains', 280);
  p.donut('hh', 348, 530, 280, 140, { catE: 'Evaluations', catP: 'Household', sort: { e: 'Evaluations', p: 'Household order' } }, 'pieChart');
  p.narrative(650, 496, 582, 174, 'Analyst read · all data', `${kpi.current}% of evaluations are from current users and ${kpi.daily}% use the product daily. Usage is more likely to have increased than decreased since purchase. The 'stopped' group is small in count - the table on page 05 names what they complain about, which is where the retention playbook lives.`);
  p.nav('03 Who bought what', '05 Experience & satisfaction');
  pages.push(p);
}

// 04 Experience
{
  const p = new Page('05 Experience & satisfaction');
  p.header(5, '', 'Experience beats expectation', 'CF10 satisfaction, CF11 expectation gap, and satisfaction by product family - the family cut is where product management should act.');
  ['Avg satisfaction (1-5)', 'Top-2 satisfaction %', 'Better than expected %', 'Avg recommend (0-10)'].forEach((m, i) => p.card(`k${i}`, 48 + i * 300, 140, 282, 90, m, { valueSize: 22 }));
  p.heading(48, 246, 'Avg satisfaction by family', 'Accessories and warranty rows rate differently from devices - read with the counts on page 01');
  p.chart('famSat', 48, 280, 580, 168, { catE: 'Evaluations', catP: 'Family', valP: 'Avg satisfaction (1-5)', fill: C.ochre, type: 'columnChart' });
  p.heading(650, 246, 'Experience vs. expectation, by family (CF11)', 'Better / about / worse - the gap that predicts recommendation');
  p.stackedColumn('exp', 650, 280, 580, 168, { catE: 'Evaluations', catP: 'Family', vals: ['Better than expected', 'About as expected', 'Worse than expected'] });
  p.heading(48, 462, 'Product scoreboard', 'Evaluations · avg satisfaction · top-2 % · NPS · detractor % - read the small-base families (Toothpaste, ManualBrush) with care', 1184);
  p.table('board', 48, 496, 1184, 180, [
    cProj('Evaluations', 'Family'),
    mProj('_Measures', 'Evaluations'),
    mProj('_Measures', 'Avg satisfaction (1-5)'),
    mProj('_Measures', 'Top-2 satisfaction %'),
    mProj('_Measures', 'NPS'),
    mProj('_Measures', 'Detractor %'),
  ], { e: '_Measures', p: 'Evaluations', kind: 'measure', d: 'Descending' });
  p.nav('04 Usage & retention', '06 Recommendation & voice');
  pages.push(p);
}

// 05 Recommendation & Voice
{
  const p = new Page('06 Recommendation & voice');
  p.header(6, '', 'Recommendation & the voice behind it', 'CF14 recommendation (0-10), CF12 most-liked themes and CF13 one-thing-to-improve themes, coded from the verbatims.');
  ['NPS', 'Promoter %', 'Detractor %', 'Avg recommend (0-10)'].forEach((m, i) => p.card(`k${i}`, 48 + i * 300, 140, 282, 90, m, { valueSize: 22 }));
  p.heading(48, 246, 'What they like MOST (CF12 themes)', 'Coded themes - cleaning, ease and battery lead');
  p.chart('like', 48, 280, 580, 190, { catE: 'Evaluations', catP: 'Like theme', fill: C.teal, type: 'columnChart' });
  p.heading(650, 246, 'Improve ONE thing (CF13 themes)', '"No issue" is a large bar - the rest is the product roadmap');
  p.treemap('imp', 650, 280, 580, 190, { gE: 'Evaluations', gP: 'Improve theme' });
  p.heading(48, 486, 'Escalation list', 'Lowest scores first - the calls and fixes that protect the base', 600);
  p.table('low', 48, 520, 596, 150, [cProj('Evaluations', 'RespId'), cProj('Respondents', 'City'), cProj('Evaluations', 'Product'), cProj('Evaluations', 'Recommend'), cProj('Evaluations', 'Improve theme')], { e: 'Evaluations', p: 'Recommend', kind: 'column', d: 'Ascending' });
  p.heading(660, 486, 'Evaluation detail', 'One row per product evaluation - page 02 slicers cross-filter this table', 570);
  p.table('detail', 660, 520, 572, 150, [cProj('Evaluations', 'RespId'), cProj('Evaluations', 'Family'), cProj('Evaluations', 'Satisfaction'), cProj('Evaluations', 'Recommend band'), cProj('Evaluations', 'Expectation')], { e: 'Evaluations', p: 'RespId', kind: 'column', d: 'Ascending' });
  p.nav('05 Experience & satisfaction', '07 Voice of customer');
  pages.push(p);
}

// 06 Voice of customer (verbatims)
{
  const p = new Page('07 Voice of customer');
  p.header(7, '', 'The voice of the customer, in their words', 'Verbatim text from CF12 (liked most), CF13 (improve one thing), CF9, CF15 and CF16. Quotes are shown as captured; low scores surface first.');
  ['Verbatims', 'Detractor verbatims', 'Service mentions'].forEach((m, i) => p.card(`k${i}`, 48 + i * 300, 140, 282, 90, m, { valueSize: 22 }));
  p.narrative(948, 140, 284, 90, 'How to read this', 'Left: the escalation queue, lowest score first. Right: advocacy, highest first. Every row is the respondent’s own wording.');
  p.heading(48, 246, 'Escalation queue - improve one thing (CF13)', 'Lowest recommendation scores first; City and product travel with the quote', 600);
  p.table('vlow', 48, 280, 596, 394, [cProj('Evaluations', 'RespId'), cProj('Respondents', 'City'), cProj('Evaluations', 'Product'), cProj('Evaluations', 'Recommend'), cProj('Evaluations', 'CF13 improve one')], { e: 'Evaluations', p: 'Recommend', kind: 'column', d: 'Ascending' });
  p.heading(660, 246, 'Advocacy - liked most (CF12)', 'Highest recommendation scores first; the themes to keep', 570);
  p.table('vhigh', 660, 280, 572, 394, [cProj('Evaluations', 'RespId'), cProj('Evaluations', 'Family'), cProj('Evaluations', 'Recommend'), cProj('Evaluations', 'CF12 liked most')], { e: 'Evaluations', p: 'Recommend', kind: 'column', d: 'Descending' });
  p.nav('06 Recommendation & voice', '08 Where to act');
  pages.push(p);
}

// 07 Where to act - the heat grid, the drivers, and the deep-dive door.
{
  const p = new Page('08 Where to act');
  p.header(8, '', 'Where to act - ranked, not listed', 'The detractor lens, upgraded: a heat grid, the Key Drivers read, and a drillthrough deep-dive.');
  ['Detractors', 'Detractor %', 'Service mentions', 'Promoters'].forEach((m, i) => p.card(`k${i}`, 48 + i * 300, 140, 282, 90, m, { valueSize: 22 }));
  p.heading(48, 240, 'Heat map: detractors by family × improve theme', 'Cell color = detractors - cream is none, deep orange is the pile-up. Select a family row, then open the deep-dive:', 580);
  p.matrix('heat', 48, 274, 580, 200, { rowE: 'Evaluations', rowP: 'Family', colE: 'Evaluations', colP: 'Improve theme', valP: 'Detractors' });
  p.heading(660, 240, 'What actually drives NPS', 'Key Drivers - Analyze = NPS, explained by Family + Improve theme', 570);
  p.keyInfluencers('ki', 660, 274, 572, 200, { valP: 'NPS', explain: [['Evaluations', 'Family'], ['Evaluations', 'Improve theme']] });
  // Waterfall: each complaint arrives as a step; the accumulation is the 21. It lives in
  // the bottom band now, below the heat grid - same detractor lens, different story shape.
  p.heading(48, 488, 'What DETRACTORS complain about (CF13)', 'Page 05 counts every evaluation; this counts only those scoring 0-6', 580);
  p.waterfall('dth', 48, 522, 580, 158, { catE: 'Evaluations', catP: 'Improve theme', valP: 'Detractors' });
  p.narrative(652, 488, 580, 140, 'Analyst read · all data', `The detractor tail does not point at one system: ${detSplit()}. Only ${kpi.serviceDet} detractor verbatims name service - the ${kpi.service} service mentions are mostly satisfied users, which makes service a latent irritant rather than the cause. Read the heat grid by row for family risk, by column for theme.`);
  // Drillthrough: enables only when the selection carries Family (the heat map rows).
  p.navButton('deep-dive', 652, 638, 580, 30, pageIdOf('10 Family deep-dive'), { color: C.accent, fill: C.card, size: 8, text: 'FAMILY DEEP-DIVE ›', linkType: 'Drillthrough' });
  p.nav('07 Voice of customer', '09 Journey & heat');
  pages.push(p);
}

// 08 Journey & heat - the funnel, the perception map, where the evaluations sit.
{
  const p = new Page('09 Journey & heat');
  p.header(9, '', 'From purchase to advocacy', 'The funnel is the commitment ladder; the map is where satisfaction stops predicting advocacy; the tiles are where the evaluations live.');
  ['Evaluations', 'Current users', 'Daily users', 'Promoters'].forEach((m, i) => p.card(`k${i}`, 48 + i * 300, 140, 282, 88, m, { valueSize: 22 }));
  p.heading(48, 244, 'The journey funnel', 'Evaluations → still using → daily → promoters', 420);
  p.funnel('pfunnel', 48, 278, 420, 200, {});
  p.heading(492, 244, 'Experience vs advocacy, by family', 'Bubble size = evaluations in the family', 380);
  p.scatter('pcat', 492, 278, 380, 200, { catE: 'Evaluations', catP: 'Family', xP: 'Avg satisfaction (1-5)', yP: 'Avg recommend (0-10)', sizeP: 'Evaluations' });
  p.heading(896, 244, 'Where the evaluations sit', 'Tile area = evaluations, one tile per city', 356);
  // Single level on purpose: nine cities are readable at 356px, sixty-three city×family
  // tiles are not - the family cut already has its own visual (the scatter beside it).
  p.treemap('pgrid', 896, 278, 356, 200, { gE: 'Respondents', gP: 'City' });
  p.heading(48, 494, 'Recommendation by age', 'Mean CF14 by age band - the line behind the cohort story', 580);
  p.lineChart('pline', 48, 528, 580, 140, { axisE: 'Respondents', axisP: 'Age', valP: 'Avg recommend (0-10)', sort: { e: 'Respondents', p: 'Age order' } });
  p.narrative(652, 494, 580, 174, 'Analyst read · all data', `The funnel shows the shape of the business: ${kpi.evaluations} evaluations narrow to ${kpi.currentCount} current users, ${kpi.dailyCount} daily users and ${kpi.promoters} promoters - daily habit and advocacy are about the same size, and both dwarf the ${kpi.detractors} detractors. On the map, read each family against the diagonal: families above it turn satisfaction into advocacy, below it they bank goodwill they do not spend. The tiles show how concentrated evaluations are across cities once family is taken into account.`);
  p.nav('08 Where to act', '11 Deck reconciliation');
  pages.push(p);
}

// 10 Family deep-dive - the drillthrough target. Not linked from the tab bar; it opens
// from a Family data point via the drillthrough button (or right-click Drill through).
// json() adds type/filterConfig/pageBinding so every visual follows the filter.
{
  const p = new Page('10 Family deep-dive');
  p.drillthroughField = 'Family';
  p.header(10, '', 'Family deep-dive', 'Drillthrough page - reached by selecting a family on page 08 and opening the deep-dive, or right-clicking any family data point. Every visual follows the drillthrough filter.');
// Microsoft's drillthrough contract: every drillthrough page carries a Back
// button; it returns the user to wherever they drilled from.
p.navButton('dtback', 1056, 24, 106, 22, null, { size: 7.5, text: 'BACK', linkType: 'Back', color: C.muted, fill: C.card });
  ['Evaluations', 'Avg satisfaction (1-5)', 'NPS', 'Detractor %'].forEach((m, i) => p.card(`k${i}`, 48 + i * 300, 140, 282, 90, m, { valueSize: 22 }));
  p.heading(48, 246, 'What this family complains about (CF13)', 'The fix is usually one darkest bar', 580);
  p.chart('dtThemes', 48, 280, 580, 210, { catE: 'Evaluations', catP: 'Improve theme', fill: C.plum });
  p.heading(660, 246, 'This family by city', 'Where the evaluations live - the filter flows through Respondents', 570);
  p.chart('dtCity', 660, 280, 572, 210, { catE: 'Respondents', catP: 'City', valP: 'Respondents', fill: C.slate });
  p.heading(48, 510, 'The casework queue for this family', 'Lowest recommendation scores first - every row is one evaluation of this family', 1184);
  p.table('dtQueue', 48, 544, 1184, 126, [
    cProj('Evaluations', 'RespId'),
    cProj('Evaluations', 'Product'),
    cProj('Evaluations', 'Satisfaction'),
    cProj('Evaluations', 'Recommend'),
    cProj('Evaluations', 'Improve theme'),
    cProj('Evaluations', 'CF13 improve one'),
  ], { e: 'Evaluations', p: 'Recommend', kind: 'column', d: 'Ascending' });
  pages.push(p);
}

// 11 Deck reconciliation - workbook vs the client findings deck, same
// respondents, different recommendation cut. Every number is computed from the
// embedded CSV at build time except the deck column, which quotes the PDF
// (Oracura Customer Satisfaction Study, October 2026) and is labelled as such.
{
  const p = new Page('11 Deck reconciliation');
  p.header(11, '', 'Deck reconciliation: workbook vs client deck', 'Why the headline NPS differs. The workbook is the source of truth; the deck cuts the same respondents at a different grain.');
  // Deck column, quoted from the PDF (Oct 2026): satisfaction slide (mean 4.1,
  // T2B 90%), expectation slide (~66% better), NPS slide (21/64/15, NPS +6),
  // sample slide (current 91%). Not recomputed - it is the client's number.
  const DECK = { avgSat: '4.1', top2: '90%', avgRec: '-', nps: '+6', better: '~66%', daily: '-', current: '91%' };
  const firstNps = respNps(respFirst.map((e) => e.Recommend));
  const respAvgRec = (respFirst.reduce((s, e) => s + e.Recommend, 0) / respFirst.length).toFixed(2);
  const respDaily = (100 * respFirst.filter((e) => e.Frequency === 'Daily').length / respFirst.length).toFixed(1);
  const kpiRows = [
    ['Avg satisfaction (CF10, 1-5)', kpi.avgSat, respGrain.avgSat, DECK.avgSat],
    ['Top-2 satisfaction %', `${kpi.top2}%`, `${respGrain.top2}%`, DECK.top2],
    ['Avg recommend (CF14, 0-10)', kpi.avgRec, respAvgRec, DECK.avgRec],
    ['NPS', `+${kpi.nps}`, `+${firstNps.nps}`, DECK.nps],
    ['Better than expected %', `${kpi.better}%`, `${respGrain.better}%`, DECK.better],
    ['Daily use %', `${kpi.daily}%`, `${respDaily}%`, DECK.daily],
    ['Still using %', `${kpi.current}%`, `${respGrain.current}%`, DECK.current],
  ];
  const drawTable = (x, y, w, title, subtitle, cols, rows, rowH) => {
    p.heading(x, y, title, subtitle, w);
    const colW = cols.map((c) => c.w);
    const headY = y + 34;
    cols.forEach((c, j) => p.text(`t${x}h${j}`, x + colW.slice(0, j).reduce((s, v) => s + v, 0), headY, colW[j], 14, c.label, { size: 7.5, color: C.accent, weight: '600', z: 200 }));
    p.line(`tr${x}`, x, headY + 16, w, 1, { z: 190 });
    rows.forEach((row, i) => {
      const ry = headY + 22 + i * rowH;
      row.forEach((cell, j) => p.text(`t${x}c${i}${j}`, x + colW.slice(0, j).reduce((s, v) => s + v, 0), ry, colW[j] - 8, rowH - 2, String(cell), { size: j === 0 ? 8.4 : 9, weight: j === 0 ? '600' : '400', z: 200 }));
      if (i < rows.length - 1) p.line(`t${x}r${i}`, x, ry + rowH - 2, w, 1, { fill: C.hairline, z: 190 });
    });
  };
  drawTable(48, 146, 580, 'Headline KPIs - three grains', 'Workbook (evaluation grain) vs respondent grain vs the client deck',
    [{ label: 'Measure', w: 190 }, { label: 'Workbook · 220', w: 120 }, { label: 'Respondent · 204', w: 130 }, { label: 'Client deck', w: 140 }],
    kpiRows, 21);
  drawTable(660, 146, 572, 'NPS under every aggregation of CF14', 'Promoters 9-10 · Passives 7-8 · Detractors 0-6 · 204 respondents',
    [{ label: 'Aggregation', w: 232 }, { label: 'Prom', w: 70 }, { label: 'Pass', w: 70 }, { label: 'Det', w: 70 }, { label: 'NPS', w: 130 }],
    npsAggregations.map(([label, a]) => [label, a.p, a.pa, a.d, `+${a.nps}`]), 21);
  p.narrative(48, 470, 1184, 196, 'Analyst read · methodology', `The deck's split (21% promoters, 64% passives, 15% detractors, NPS +6) cannot be reproduced from CF14 in the workbook: every aggregation above puts promoters near ${firstNps.p} of ${respFirst.length} and detractors near ${firstNps.d}. The deck therefore used a different recommendation cut - a different wave, an overall recommendation question, or pre-cleaning data - while the workbook repeats CF14 per product purchased (CF7-CF16 per product, per the questionnaire routing). The same grain difference explains the smaller gaps: better than expected ${kpi.better}% here vs ~66% in the deck, top-2 satisfaction ${kpi.top2}% vs 90%. Demographics reconcile exactly (all nine cities, gender 56/44, under-35 64%), which confirms both files describe the same ${kpi.respondents} respondents. This report stands on the workbook numbers; the deck column is shown so the gap is audited, not hidden.`);
  p.nav('09 Journey & heat', '00 Cover');
  pages.push(p);
}

// ---------- package ----------
const pkg = {
  pages: pages.map((p) => ({ id: p.id, displayName: p.displayName, json: p.json(), visuals: p.visuals })),
  pagesJson: { $schema: 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/pagesMetadata/1.1.0/schema.json', pageOrder: pages.map((p) => p.id), activePageName: pages[0].id },
};
const reportJson = {
  $schema: 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/report/3.3.0/schema.json',
  themeCollection: {
    baseTheme: { name: BASE_THEME_NAME, reportVersionAtImport: { visual: '2.11.0', report: '3.4.0', page: '2.3.1' }, type: 'SharedResources' },
    customTheme: { name: `${THEME_NAME}.json`, reportVersionAtImport: { visual: '2.9.0', report: '3.3.0', page: '2.1.0' }, type: 'RegisteredResources' },
  },
  resourcePackages: [
    { name: 'SharedResources', type: 'SharedResources', items: [{ name: BASE_THEME_NAME, path: `BaseThemes/${BASE_THEME_NAME}.json`, type: 'BaseTheme' }] },
    { name: 'RegisteredResources', type: 'RegisteredResources', items: [{ name: `${THEME_NAME}.json`, path: `${THEME_NAME}.json`, type: 'CustomTheme' }] },
  ],
  settings: { useStylableVisualContainerHeader: true, exportDataMode: 'AllowSummarized', defaultDrillFilterOtherVisuals: true, allowChangeFilterTypes: true, useEnhancedTooltips: true, useDefaultAggregateDisplayName: true },
};
const fullPkg = {
  pages: pkg.pages, pagesJson: pkg.pagesJson, reportJson,
  versionJson: { $schema: 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/versionMetadata/1.0.0/schema.json', version: '2.0.0' },
  definitionPbir: { $schema: 'https://developer.microsoft.com/json-schemas/fabric/item/report/definitionProperties/2.0.0/schema.json', version: '4.0', datasetReference: { byPath: { path: `../${CODE}.SemanticModel` } } },
  pbip: { $schema: 'https://developer.microsoft.com/json-schemas/fabric/pbip/pbipProperties/1.0.0/schema.json', version: '1.0', artifacts: [{ report: { path: `${CODE}.Report` } }], settings: { enableAutoRecovery: true } },
  reportPlatform: null, modelPlatform: null,
  pbism: { $schema: 'https://developer.microsoft.com/json-schemas/fabric/item/semanticModel/definitionProperties/1.0.0/schema.json', version: '4.2', settings: { qnaEnabled: true } },
  themeJson: buildTheme(),
};
const stableUuid = (l) => { const h = createHash('sha1').update(l).digest('hex').slice(0, 32).split(''); h[12] = '4'; h[16] = '8'; const v = h.join(''); return `${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-${v.slice(16, 20)}-${v.slice(20)}`; };
fullPkg.reportPlatform = { $schema: 'https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json', metadata: { type: 'Report', displayName: CODE }, config: { version: '2.0', logicalId: stableUuid(`report:${CODE}`) } };
fullPkg.modelPlatform = { $schema: 'https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json', metadata: { type: 'SemanticModel', displayName: CODE }, config: { version: '2.0', logicalId: stableUuid(`model:${CODE}`) } };

const modelErrors = validateSemanticModel(model);
if (modelErrors.length) throw new Error(`Invalid semantic model: ${modelErrors.join('; ')}`);
// validateReportPackage expects pkg.pages with visuals etc - adapt
const reportErrors = validateReportPackage(
  { pages: fullPkg.pages.map((p) => ({ id: p.id, displayName: p.displayName, visuals: p.visuals })), pagesJson: fullPkg.pagesJson },
  model,
);
if (reportErrors.length) throw new Error(`Invalid report: ${reportErrors.join('; ')}`);

// ---------- write ----------
const outBase = resolve(ROOT, process.argv[2] === '--out' ? process.argv[3] : 'reports/power-bi');
const projectDir = join(outBase, 'oracura');
const reportDir = join(projectDir, `${CODE}.Report`);
const modelDir = join(projectDir, `${CODE}.SemanticModel`);
const writeJson = (path, v) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(v, null, 2)}\n`); };
const writeText = (path, v) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, v); };
rmSync(projectDir, { recursive: true, force: true });
mkdirSync(projectDir, { recursive: true });
writeJson(join(projectDir, `${CODE}.pbip`), fullPkg.pbip);
writeText(join(reportDir, '.platform'), `${JSON.stringify(fullPkg.reportPlatform, null, 2)}\n`);
writeJson(join(reportDir, 'definition.pbir'), fullPkg.definitionPbir);
writeJson(join(reportDir, 'definition/version.json'), fullPkg.versionJson);
writeJson(join(reportDir, 'definition/report.json'), fullPkg.reportJson);
writeJson(join(reportDir, 'definition/pages/pages.json'), fullPkg.pagesJson);
for (const page of fullPkg.pages) {
  writeJson(join(reportDir, 'definition/pages', page.id, 'page.json'), page.json);
  for (const v of page.visuals) writeJson(join(reportDir, 'definition/pages', page.id, 'visuals', v.name, 'visual.json'), v.json);
}
writeText(join(reportDir, 'StaticResources/SharedResources/BaseThemes', `${BASE_THEME_NAME}.json`), readFileSync(join(HERE, 'powerbi/assets', `${BASE_THEME_NAME}.json`), 'utf8'));
writeJson(join(reportDir, 'StaticResources/RegisteredResources', `${THEME_NAME}.json`), fullPkg.themeJson);
const files = semanticModelFiles({ code: CODE }, model);
writeText(join(modelDir, '.platform'), `${JSON.stringify(fullPkg.modelPlatform, null, 2)}\n`);
writeJson(join(modelDir, 'definition.pbism'), fullPkg.pbism);
writeText(join(modelDir, 'definition/database.tmdl'), files.database);
writeText(join(modelDir, 'definition/model.tmdl'), files.model);
writeText(join(modelDir, 'definition/relationships.tmdl'), files.relationships);
writeText(join(modelDir, 'definition/cultures/en-US.tmdl'), files.culture);
for (const [name, contents] of Object.entries(files.tables)) writeText(join(modelDir, 'definition/tables', name), contents);

function projectReadme(m, pages) {
  return `# ORACURA - Module 1 Customer Feedback (Power BI)

Open \`ORACURA.pbip\` in Power BI Desktop. This is a **data-driven** PBIP: the semantic
model embeds ${m.counts.respondents} respondents and ${m.counts.evaluations} product evaluations
from the Module 1 raw data, so every visual renders immediately - there are no empty charts.

## Pages (${m.visualCount} visuals)

${pages.map((p, i) => `${i + 1}. **${p.displayName}** - ${p.visuals.length} visuals`).join('\n')}

## Model

| Table | Rows | Grain |
| --- | ---: | --- |
| \`Evaluations\` | ${m.semanticModel.tables.find((t) => t.name === 'Evaluations')?.rows} | one row per respondent × product slot (CF2-CF16) |
| \`Respondents\` | ${m.semanticModel.tables.find((t) => t.name === 'Respondents')?.rows} | one row per respondent (S1-S3: Age, Gender, City) |
| \`_Measures\` | 0 | ${m.semanticModel.tables.find((t) => t.name === '_Measures')?.measures ?? 0} DAX measures |

**Single dimension path.** \`City\`, \`Age\` and \`Gender\` exist only in \`Respondents\`.
\`Evaluations\` joins on \`RespId\`, so the page 02 slicers cross-filter every chart and
table through that one relationship. Duplicating those columns into \`Evaluations\` would
create two filter paths, which is what makes slicers blank or double-count.

## KPI snapshot

${m.counts.respondents} respondents · ${m.counts.evaluations} evaluations · avg satisfaction
**${m.counts.kpi.avgSat}/5** (${m.counts.kpi.top2}% top-2) · avg recommend **${m.counts.kpi.avgRec}/10** ·
**NPS ${m.counts.kpi.nps > 0 ? '+' : ''}${m.counts.kpi.nps}** · ${m.counts.kpi.better}% better than expected ·
${m.counts.kpi.daily}% daily use · ${m.counts.kpi.current}% still using.

## Rebuild

\`\`\`bash
node scripts/check-syntax.mjs                                    # syntax gate (all scripts)
node scripts/build-oracura-powerbi.mjs                             # PBIP
# package + model + data + slicers, one command:
node scripts/validate-pbip.mjs reports/power-bi/oracura --data reports/power-bi/oracura/data/evaluations.csv --dimensions City,Age,Gender,Family --manifest reports/power-bi/oracura/report-manifest.json --strict-relationship
node scripts/package-oracura.mjs                                   # reproducible zip: fixed mtimes, -X, delete-first
node scripts/validate-pbip.mjs reports/power-bi/ORACURA_Module1_PBIP.zip --data reports/power-bi/oracura/data/evaluations.csv --dimensions City,Age,Gender,Family --manifest reports/power-bi/oracura/report-manifest.json --strict-relationship
PYTHONPATH=/tmp/xlsxlibs python3 scripts/build-oracura-excel.py   # Excel companion
\`\`\`

To refresh from the client's original workbook:

\`\`\`bash
PYTHONPATH=/tmp/xlsxlibs python3 scripts/extract-oracura-xlsx.py path/to/raw-data.xlsx
\`\`\`

The extractor parses the wide \`204 data\` sheet directly (S1-S3, the CF2 product group,
then the repeated CF4-CF16 blocks - including the third block's reordered
\`CF5…CF10, CF4, CF11…CF16\`), normalises answer labels, derives product family, codes
CF12/CF13 themes and keeps full verbatims. It prints a drift report against
\`data/evaluations.baseline.csv\`.

## Excel companion

\`ORACURA_Module1_Data.xlsx\` - Cover KPIs, \`Evaluations\`, \`Respondents\`, eight
\`Summary_*\` tables and a \`Charts\` sheet with native Excel bar charts.

## Boundary

No \`.pbix\` is generated: Microsoft does not support creating a model-bearing PBIX outside
Power BI Desktop. In Desktop, use **File → Save as → Power BI Desktop (.pbix)**.
`;
}

const manifest = {
  schemaVersion: 1, code: CODE, source: 'MODULE 1 CUSTOMER FEEDBACK_Live_Rawdata204N.xlsx + _Coded.xlsx + MODULE_1_QNR_CUST_FEEDBACK_V1.4.docx',
  generatedAt: GENERATED_AT,
  boundary: `Real respondent data embedded (${kpi.respondents} respondents, ${kpi.evaluations} product evaluations). Like/Improve verbatims are coded themes derived from CF12/CF13 text; full verbatims remain in the source workbooks.`,
  counts: { respondents: kpi.respondents, evaluations: kpi.evaluations, kpi },
  pages: fullPkg.pages.map((p) => ({ name: p.displayName, id: p.id, visuals: p.visuals.length })),
  visualCount: fullPkg.pages.reduce((s, p) => s + p.visuals.length, 0),
  semanticModel: { tables: model.tables.map((t) => ({ name: t.name, columns: t.columns.length, rows: t.rows.length, measures: (t.measures ?? []).length })), relationships: model.relationships.length },
  paths: { project: `${CODE}.pbip`, report: `${CODE}.Report`, semanticModel: `${CODE}.SemanticModel` },
};
writeJson(join(projectDir, 'report-manifest.json'), manifest);
mkdirSync(join(projectDir, 'data'), { recursive: true });
writeFileSync(join(projectDir, 'data/evaluations.csv'), readFileSync(DATA_CSV));
writeText(join(projectDir, 'README.md'), projectReadme(manifest, fullPkg.pages));
console.log(`${CODE}: ${manifest.pages.length} pages, ${manifest.visualCount} visuals, ${kpi.respondents} respondents, ${kpi.evaluations} evaluations -> ${projectDir}`);
