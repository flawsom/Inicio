import type { MonitorModel, MonitorQuestion } from './monitor-model';

/**
 * The client analysis brief.
 *
 * This is deliberately a pure function over the counts the live analytics API
 * already returns. It does not call an LLM, invent a benchmark or claim to have
 * seen the client's market. The client-specific part is the questionnaire: the
 * lens comes from the questions that are actually present, and the confidence
 * arithmetic comes from the base each question actually has.
 *
 * The output is written twice: once for a person who has never read a confidence
 * interval, and once, behind "show the working", for the analyst who has to check
 * it. Every number in the plain sentence is derived below; none is a template
 * placeholder.
 */

export type AnalysisCertainty = 'high' | 'medium' | 'low';
export type AnalysisQuadrant = 'act' | 'investigate' | 'note' | 'wait';

export interface AnalysisRange {
  /** Percentage points, 0-100. */
  low: number;
  high: number;
}

export interface AnalysisFinding {
  id: string;
  questionName: string | null;
  questionLabel: string;
  title: string;
  /** One or two sentences with no statistical notation. */
  plain: string;
  /** Why the pattern changes a decision. */
  why: string;
  /** A concrete next move, not a generic recommendation. */
  action: string;
  certainty: AnalysisCertainty;
  /** 0-100 heuristic for how much the evidence supports the sentence. */
  certaintyScore: number;
  /** 0-100 heuristic for how strong the practical pattern is. */
  signalScore: number;
  quadrant: AnalysisQuadrant;
  evidence: string[];
  method: string;
}

export interface AnalysisLens {
  id: string;
  label: string;
  why: string;
  used: boolean;
}

export interface AnalysisReadinessFact {
  label: string;
  value: string;
  note: string;
}

export interface AnalysisReadiness {
  score: number;
  label: 'No data' | 'Early signal' | 'Directional' | 'Ready to read';
  summary: string;
  facts: AnalysisReadinessFact[];
  improvements: string[];
}

export interface AnalysisGlossaryEntry {
  term: string;
  plain: string;
}

export interface AnalysisMethod {
  name: string;
  plain: string;
  source: string;
}

/** The methods the brief actually uses, in the order a reader should meet them. */
export const ANALYSIS_METHODS: AnalysisMethod[] = [
  {
    name: 'Wilson score interval',
    plain: 'A 95% range for a share that still behaves sensibly when the base is small or the share is near 0% or 100%.',
    source: 'Wilson (1927), Journal of the American Statistical Association',
  },
  {
    name: 'Weighted median and quantiles',
    plain: 'The middle answer and the middle half of the answers, computed from the tallies so a value answered many times counts many times.',
    source: 'Standard survey-weighted descriptive statistics',
  },
  {
    name: 'Tukey fences',
    plain: 'A named rule for flagging answers far outside the middle 50%: below Q1 − 1.5×IQR or above Q3 + 1.5×IQR.',
    source: 'Tukey (1977), Exploratory Data Analysis',
  },
  {
    name: 'Herfindahl-Hirschman index',
    plain: 'A concentration measure that turns a set of answer shares into “how many options are genuinely competitive”.',
    source: 'Herfindahl (1950); Hirschman (1945); used in competition analysis',
  },
];

export interface AnalysisBrief {
  schemaVersion: 1;
  client: string;
  instrument: string;
  generatedAt: string;
  focus: string;
  focusWhy: string;
  bottomLine: string;
  readiness: AnalysisReadiness;
  findings: AnalysisFinding[];
  lenses: AnalysisLens[];
  limits: string[];
  nextQuestions: string[];
  glossary: AnalysisGlossaryEntry[];
}

export interface AnalysisOptions {
  /** The organisation or client the brief is prepared for. */
  client?: string;
}

const NUMERIC_TYPES = new Set(['integer', 'decimal', 'percentage', 'currency']);
const MULTI_TYPES = new Set(['select_multiple', 'rank']);
const TEXT_TYPES = new Set(['text', 'textarea']);
const PROFILE_WORDS =
  /\b(age|gender|sex|income|education|region|district|location|urban|rural|household|employ|occupation|language|disability)\b/i;
const RATING_WORDS =
  /\b(satisf|rate|rating|agree|likely|recommend|trust|quality|experience|easy|helpful|score|nps|opinion)\b/i;
const PRIORITY_WORDS = /\b(need|priorit|important|choose|prefer|barrier|challenge|concern|want)\b/i;
const MARKET_WORDS = /\b(price|pay|cost|value|afford|purchase|intend|buy|spend|fee)\b/i;
const ADOPTION_WORDS = /\b(use|used|tried|aware|would|recommend|adopt|switch|access)\b/i;

const QUADRANT_LABELS: Record<AnalysisQuadrant, string> = {
  act: 'Act on it',
  investigate: 'Big, but uncertain',
  note: 'Solid, but small',
  wait: 'Too early',
};

const CERTAINTY_LABELS: Record<AnalysisCertainty, string> = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
};

export function quadrantLabel(quadrant: AnalysisQuadrant): string {
  return QUADRANT_LABELS[quadrant];
}

export function certaintyLabel(certainty: AnalysisCertainty): string {
  return CERTAINTY_LABELS[certainty];
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function text(value: number, digits = 1): string {
  return value.toFixed(digits);
}

function percent(value: number): string {
  return `${text(value * 100)}%`;
}

function rangeText(range: AnalysisRange): string {
  return `${text(range.low)}% to ${text(range.high)}%`;
}

/**
 * Wilson score interval for a share, returned in percentage points.
 *
 * The Wilson interval is used instead of the textbook normal approximation
 * because it behaves far better when a share is near 0% or 100% or the base is
 * small, which is exactly where a client brief is most likely to be read.
 * It assumes independent observations from a simple random sample; that
 * assumption is stated wherever the result appears.
 */
export function wilsonInterval(successes: number, total: number, z = 1.96): AnalysisRange | null {
  if (!Number.isFinite(successes) || !Number.isFinite(total) || total <= 0) return null;
  const n = Math.max(0, total);
  const x = clamp(successes, 0, n);
  const p = x / n;
  const denominator = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denominator;
  const margin =
    (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  return {
    low: clamp((centre - margin) * 100, 0, 100),
    high: clamp((centre + margin) * 100, 0, 100),
  };
}

/** The worst-case half-width at 50%, for a plain-language sample scope. */
export function samplingRange(total: number): number | null {
  if (!Number.isFinite(total) || total <= 0) return null;
  const interval = wilsonInterval(Math.round(total / 2), total);
  return interval ? (interval.high - interval.low) / 2 : null;
}

function certaintyFromBase(base: number): number {
  return Math.round(clamp(Math.sqrt(Math.max(0, base)) * 9.5, 0, 95));
}

function certaintyFromShare(base: number, interval: AnalysisRange | null): number {
  const baseScore = certaintyFromBase(base);
  if (!interval) return baseScore;
  const widthScore = clamp(100 - (interval.high - interval.low) * 2.5, 0, 100);
  return Math.round(baseScore * 0.55 + widthScore * 0.45);
}

function certaintyOf(score: number): AnalysisCertainty {
  if (score >= 70) return 'high';
  if (score >= 40) return 'medium';
  return 'low';
}

function quadrantOf(signal: number, certainty: number): AnalysisQuadrant {
  if (signal >= 55 && certainty >= 55) return 'act';
  if (signal >= 55) return 'investigate';
  if (certainty >= 55) return 'note';
  return 'wait';
}

interface Candidate {
  finding: AnalysisFinding;
}

function makeFinding(
  input: Omit<AnalysisFinding, 'certainty' | 'quadrant'>,
): AnalysisFinding {
  return {
    ...input,
    certainty: certaintyOf(input.certaintyScore),
    quadrant: quadrantOf(input.signalScore, input.certaintyScore),
  };
}

function shortLabel(label: string, limit = 90): string {
  const clean = label.replace(/\s+/g, ' ').trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

function optionShare(option: { count: number }, base: number): number {
  return base > 0 ? option.count / base : 0;
}

function concentration(options: Array<{ count: number }>): { hhi: number; effective: number } {
  const total = options.reduce((sum, option) => sum + option.count, 0);
  if (total <= 0) return { hhi: 0, effective: 0 };
  const hhi = options.reduce((sum, option) => {
    const share = option.count / total;
    return sum + share * share;
  }, 0);
  return { hhi, effective: hhi > 0 ? 1 / hhi : 0 };
}

function categoricalFinding(question: MonitorQuestion): Candidate | null {
  const base = question.answered;
  const top = question.options[0];
  if (!top || base <= 0) return null;
  const second = question.options[1] ?? null;
  const topRange = wilsonInterval(top.count, base);
  if (!topRange) return null;
  const secondRange = second ? wilsonInterval(second.count, base) : null;
  const topShare = optionShare(top, base);
  const secondShare = second ? optionShare(second, base) : 0;
  const separated = !secondRange || topRange.low > secondRange.high || topRange.high < secondRange.low;
  const multi = MULTI_TYPES.has(question.type);
  const { hhi, effective } = concentration(question.options);
  const certaintyScore = certaintyFromShare(base, topRange);
  const averageSelections =
    multi && base > 0
      ? question.options.reduce((sum, option) => sum + option.count, 0) / base
      : null;
  const signalScore = clamp(topShare * 100 + (multi && averageSelections ? (averageSelections - 1) * 8 : 0), 0, 100);

  const title = multi
    ? topShare >= 0.5
      ? `“${shortLabel(top.label, 64)}” is the strongest mention`
      : `“${shortLabel(top.label, 64)}” leads a scattered set of mentions`
    : topShare >= 0.95 && base >= 10
      ? `“${shortLabel(top.label, 64)}” is near-unanimous`
      : separated && topShare >= 0.5
        ? `“${shortLabel(top.label, 64)}” is the clear majority choice`
        : separated
          ? `“${shortLabel(top.label, 64)}” leads the field`
          : `No single answer owns this question`;

  const plain = multi
    ? `${top.count} of ${base} respondents selected “${top.label}” (${percent(topShare)})${second ? `; “${second.label}” was next at ${percent(secondShare)}` : ''}. Because respondents could choose more than one option, these shares can add past 100%.`
    : `${top.count} of ${base} respondents chose “${top.label}” (${percent(topShare)})${second ? `; “${second.label}” was next at ${percent(secondShare)}` : ''}.`;

  const why = separated
    ? multi
      ? 'The top two 95% ranges do not overlap. That is consistent with a real difference in mention weight, not proof that the options are independent or that the same ranking will hold in a different population.'
      : 'The top two 95% ranges do not overlap. That is consistent with a real difference in preference, though it is not proof that the order will hold in a different population.'
    : 'The top two 95% ranges overlap. Another sample of this size could reverse the order, so this is a shortlist rather than a mandate.';

  const action = multi
    ? `Treat the leading mentions as a bundle, not a single vote.${averageSelections === null ? '' : ` The average respondent selected ${text(averageSelections)} option${averageSelections === 1 ? '' : 's'}.`} Decide which combination is feasible.`
    : separated && topShare >= 0.5
      ? `Use “${top.label}” as the default and test it in the next round.`
      : separated
        ? `Take “${top.label}” forward as the leading option, with “${second?.label ?? 'the next option'}” as the challenger.`
        : `Ask a follow-up that forces a choice between “${top.label}”${second ? ` and “${second.label}”` : ''}, or collect more answers.`;

  const evidence = [
    `Base: ${base} respondents answered; ${question.missing} submitted responses did not.`,
    `Top: ${top.count} of ${base} = ${percent(topShare)}; 95% range ${rangeText(topRange)}.`,
    ...(second && secondRange
      ? [`Runner-up: ${second.count} of ${base} = ${percent(secondShare)}; 95% range ${rangeText(secondRange)}.`]
      : []),
    `Concentration among answers: ${text(effective)} effective options (HHI ${text(hhi, 3)}).`,
    ...(averageSelections !== null ? [`Mentions per respondent: ${text(averageSelections)}.`] : []),
    ...(question.missing > 0 && question.notes.some((note) => /relevance rule/i.test(note))
      ? ['Missing includes submissions where a relevance rule did not ask this question.']
      : []),
  ];

  return {
    finding: makeFinding({
      id: `question-${question.name}`,
      questionName: question.name,
      questionLabel: question.label,
      title,
      plain,
      why,
      action,
      certaintyScore,
      signalScore,
      evidence,
      method: `${multi ? 'Wilson score interval (95%) for each respondent share; shares are not mutually exclusive. ' : 'Wilson score interval (95%) for each respondent share. '}Concentration is the Herfindahl-Hirschman index over answers. The interval assumes a simple random sample; clustering, quotas or weighting need a design effect.`,
    }),
  };
}

function numericFinding(question: MonitorQuestion): Candidate | null {
  const numeric = question.numeric;
  if (!numeric || numeric.n <= 0) return null;
  const { n, mean, median, sd, q1, q3, iqr, lowFence, highFence, outliers, skew } = numeric;
  const outlierShare = n > 0 ? outliers / n : 0;
  const shift = sd > 0 ? Math.abs(mean - median) / sd : 0;
  const direction = mean > median ? 'high' : 'low';
  const certaintyScore = certaintyFromBase(n);
  const signalScore = clamp(45 + shift * 40 + outlierShare * 100, 0, 100);

  const title =
    n < 5
      ? `“${shortLabel(question.label, 64)}” has too few answers to read`
      : outliers > 0 && outlierShare >= 0.05
        ? `A few extreme answers pull “${shortLabel(question.label, 64)}”`
        : shift >= 0.35
          ? `The average and the typical answer disagree`
          : sd === 0
            ? `Every answer to “${shortLabel(question.label, 64)}” is the same`
            : `The typical answer is ${text(median, 2)}`;

  const plain =
    n < 5
      ? `Only ${n} answer${n === 1 ? '' : 's'} can be read. Most answers sit around ${text(median, 2)}, but that is not enough to describe a population.`
      : `Most answers sit around ${text(median, 2)}. Half fall between ${text(q1, 2)} and ${text(q3, 2)}, and the average is ${text(mean, 2)}.${outliers > 0 ? ` ${outliers} of ${n} answers are outside the usual range.` : ''}`;

  const why =
    n < 5
      ? 'A handful of answers can be checked individually, but an average would look more certain than the evidence is.'
      : shift >= 0.35
        ? `The average is ${text(Math.abs(mean - median), 2)} ${direction === 'high' ? 'above' : 'below'} the median. A ${direction} tail is moving it, so a total based on the mean will ${direction === 'high' ? 'overstate' : 'understate'} the typical case.`
        : outliers > 0
          ? 'A small number of extreme answers can change a total or an average. They may be real, or they may be data-entry errors; the average alone cannot tell you which.'
          : 'The middle is stable. The spread is the honest range for a typical answer, and it is wider than a single average suggests.';

  const action =
    n < 5
      ? 'Collect more answers before using this number in a decision.'
      : shift >= 0.35 || outliers > 0
        ? 'Check the highest and lowest answers. Report the median for a typical case and the mean for a total; do not use one in place of the other.'
        : 'Use the median for a typical case and the interquartile range for the middle 50%; quote the mean separately if the total matters.';

  return {
    finding: makeFinding({
      id: `question-${question.name}`,
      questionName: question.name,
      questionLabel: question.label,
      title,
      plain,
      why,
      action,
      certaintyScore,
      signalScore,
      evidence: [
        `Answers: ${n}; mean ${text(mean, 2)}; median ${text(median, 2)}; sample SD ${text(sd, 2)}.`,
        `Middle 50%: ${text(q1, 2)} to ${text(q3, 2)} (IQR ${text(iqr, 2)}); full range ${text(numeric.min, 2)} to ${text(numeric.max, 2)}.`,
        `Outside Tukey fences (${text(lowFence, 2)} to ${text(highFence, 2)}): ${outliers} answers. Skew indicator: ${text(skew, 2)}.`,
        `${question.missing} submitted responses did not answer this question.`,
      ],
      method:
        'Weighted mean, weighted median and quantiles, sample standard deviation, interquartile range and Tukey 1.5×IQR fences. No distributional test and no causal claim; the skew indicator is descriptive.',
    }),
  };
}

function textFinding(question: MonitorQuestion): Candidate | null {
  const top = question.options[0];
  if (!top || question.answered <= 0) return null;
  const base = question.answered;
  const topShare = optionShare(top, base);
  const repeated = top.count > 1;
  return {
    finding: makeFinding({
      id: `question-${question.name}`,
      questionName: question.name,
      questionLabel: question.label,
      title: repeated
        ? `“${shortLabel(top.label, 64)}” is the most repeated answer`
        : 'Free text is broad, not a vote',
      plain: `${question.distinct} distinct answer${question.distinct === 1 ? '' : 's'} across ${base} respondents.${repeated ? ` The most repeated is “${top.label}” (${top.count} of ${base}).` : ' No answer is repeated.'}`,
      why: 'A repeated phrase is a clue, not a theme. The same words can mean different things, and a phrase that appears once can still be the most important answer in the file.',
      action: 'Read the full answers and code them into themes before quoting a percentage. This brief has not inferred sentiment or intent.',
      certaintyScore: certaintyFromBase(base),
      signalScore: Math.min(45, 20 + topShare * 100),
      evidence: [
        `Answers: ${base}; distinct strings: ${question.distinct}.`,
        `Most repeated exact string: ${repeated ? `${top.count} mentions` : 'none'}.`,
        `${question.missing} submitted responses did not answer.`,
      ],
      method: 'Exact-string frequency only. No stemming, sentiment analysis, theme coding or language model is applied.',
    }),
  };
}

function dateFinding(question: MonitorQuestion): Candidate | null {
  if (question.series.length === 0) return null;
  const total = question.series.reduce((sum, point) => sum + point.count, 0);
  const first = question.series[0]!;
  const last = question.series.at(-1)!;
  return {
    finding: makeFinding({
      id: `question-${question.name}`,
      questionName: question.name,
      questionLabel: question.label,
      title:
        question.series.length === 1
          ? `Every answer falls on one day`
          : `Answers span ${question.series.length} days`,
      plain: `${total} answers are distributed across ${question.series.length} day${question.series.length === 1 ? '' : 's'}, from ${first.label} to ${last.label}.`,
      why: 'This is the date the answer was recorded, not a time trend in opinion. A cluster can mean a single field visit, a link launch or a reminder, not a change in what people think.',
      action: 'Check the field log and link distribution before treating the shape as a trend. A trend claim needs repeated measurement, not one field period.',
      certaintyScore: certaintyFromBase(total),
      signalScore: 30,
      evidence: [
        `Days represented: ${question.series.length}; answers: ${total}.`,
        `First day: ${first.label} (${first.count}); last day: ${last.label} (${last.count}).`,
      ],
      method: 'Counts by answer date. No seasonality adjustment, significance test or forecast.',
    }),
  };
}

function geoFinding(question: MonitorQuestion): Candidate | null {
  if (question.points.length === 0) return null;
  const total = question.points.reduce((sum, point) => sum + point.count, 0);
  const top = question.points[0]!;
  const share = total > 0 ? top.count / total : 0;
  return {
    finding: makeFinding({
      id: `question-${question.name}`,
      questionName: question.name,
      questionLabel: question.label,
      title: `Coverage reaches ${question.points.length} distinct coordinate${question.points.length === 1 ? '' : 's'}`,
      plain: `The answers contain ${total} plotted point${total === 1 ? '' : 's'} across ${question.points.length} unique coordinate${question.points.length === 1 ? '' : 's'}. The most common point accounts for ${percent(share)} of plotted points.`,
      why: 'A map shows where the answers came from, not who was missing from the sample. A few dense points can make coverage look wider than it is.',
      action: 'Compare the map with the intended sampling frame. If the frame names areas with no points, that is a coverage question before it is an opinion question.',
      certaintyScore: certaintyFromBase(question.answered),
      signalScore: 35,
      evidence: [
        `Answered: ${question.answered}; unique coordinates: ${question.points.length}; plotted points: ${total}.`,
        'Point counts are plotted responses, not unique respondents; a trace can contribute more than one point.',
      ],
      method: 'Unique latitude/longitude points, no basemap, population layer, travel-distance model or spatial significance test.',
    }),
  };
}

function mediaFinding(question: MonitorQuestion): Candidate | null {
  if (question.answered <= 0) return null;
  const share = question.total > 0 ? question.answered / question.total : 0;
  return {
    finding: makeFinding({
      id: `question-${question.name}`,
      questionName: question.name,
      questionLabel: question.label,
      title: `${percent(share)} of submitted responses attached evidence`,
      plain: `${question.answered} of ${question.total} submitted responses (${percent(share)}) attached a file, image, audio or video.`,
      why: 'Presence is not quality. This says an attachment exists; it does not say the file is clear, relevant or usable.',
      action: 'Review a sample of the files before treating the attachment rate as evidence quality.',
      certaintyScore: certaintyFromBase(question.answered),
      signalScore: clamp(share * 100, 0, 100),
      evidence: [
        `Attached: ${question.answered}; submitted: ${question.total}; missing: ${question.missing}.`,
      ],
      method: 'Presence count only. No assessment of file contents, resolution or relevance.',
    }),
  };
}

function coverageFinding(question: MonitorQuestion): Candidate | null {
  if (question.total <= 0 || question.missing <= 0) return null;
  if (question.notes.some((note) => /relevance rule/i.test(note))) return null;
  const missingShare = question.missing / question.total;
  if (missingShare < 0.1) return null;
  return {
    finding: makeFinding({
      id: 'coverage',
      questionName: question.name,
      questionLabel: question.label,
      title: `“${shortLabel(question.label, 64)}” has the weakest answer coverage`,
      plain: `${question.missing} of ${question.total} submitted responses have no answer to this question (${percent(missingShare)}).`,
      why: 'A gap can be an optional question, a confusing field, a relevance rule or a fieldwork problem. Until you know which, the answered share is a share of respondents, not of the target population.',
      action: 'Check the skip logic and the field team’s notes before treating the answered answers as representative.',
      certaintyScore: certaintyFromBase(question.total),
      signalScore: clamp(missingShare * 100, 0, 100),
      evidence: [
        `Submitted: ${question.total}; answered: ${question.answered}; missing: ${question.missing}.`,
        'This is unweighted item nonresponse, not a test of why the answer is missing.',
      ],
      method: 'Unweighted item nonresponse. A missing answer is not a “no”, a zero or a neutral score.',
    }),
  };
}

function conflictFinding(model: MonitorModel): Candidate | null {
  if (model.conflicts <= 0) return null;
  const rate = model.submitted > 0 ? model.conflicts / model.submitted : 0;
  return {
    finding: makeFinding({
      id: 'conflicts',
      questionName: null,
      questionLabel: 'Sync integrity',
      title: `${model.conflicts} response${model.conflicts === 1 ? '' : 's'} had a device/server disagreement`,
      plain: `${model.conflicts} of ${model.submitted} submitted responses (${percent(rate)}) contain a field where the device and the server disagreed.`,
      why: 'The server kept the value it held and the device value was retained beside it. That is good for recovery, but the analytical value is ambiguous until somebody decides which one is authoritative.',
      action: 'Review the conflicts before aggregating. Record a decision per conflict rather than silently choosing a side in the report.',
      certaintyScore: 95,
      signalScore: clamp(55 + rate * 100, 0, 100),
      evidence: [
        `Conflicts: ${model.conflicts}; submitted: ${model.submitted}; rate: ${percent(rate)}.`,
        'The monitor reports the count; the conflict table holds the two values.',
      ],
      method: 'Count from the live analytics response. This is a data-integrity fact, not an opinion measure.',
    }),
  };
}

function collectFindings(model: MonitorModel): AnalysisFinding[] {
  const candidates: Candidate[] = [];
  for (const question of model.questions) {
    if (question.answered <= 0) continue;
    let candidate: Candidate | null = null;
    if (NUMERIC_TYPES.has(question.type) && question.numeric) candidate = numericFinding(question);
    else if (TEXT_TYPES.has(question.type)) candidate = textFinding(question);
    else if (question.chart === 'line') candidate = dateFinding(question);
    else if (question.chart === 'points') candidate = geoFinding(question);
    else if (question.chart === 'count') candidate = mediaFinding(question);
    else if (question.chart === 'bar' && question.options.length > 0) candidate = categoricalFinding(question);
    if (candidate) candidates.push(candidate);
    const coverage = coverageFinding(question);
    if (coverage) candidates.push(coverage);
  }
  const conflict = conflictFinding(model);
  if (conflict) candidates.push(conflict);

  return candidates
    .map((candidate) => candidate.finding)
    .sort(
      (a, b) =>
        b.signalScore * 0.55 +
        b.certaintyScore * 0.45 -
        (a.signalScore * 0.55 + a.certaintyScore * 0.45),
    )
    .slice(0, 6);
}

function readinessFor(model: MonitorModel): AnalysisReadiness {
  const questionCount = model.questions.length;
  const possible = model.questions.reduce((sum, question) => sum + question.total, 0);
  const answered = model.questions.reduce((sum, question) => sum + question.answered, 0);
  const coverage = possible > 0 ? answered / possible : 0;
  const completion = model.completionRate ?? 0;
  const conflictRate = model.submitted > 0 ? model.conflicts / model.submitted : 0;
  const sampleScore =
    model.submitted >= 100
      ? 100
      : model.submitted >= 30
        ? 60 + ((model.submitted - 30) / 70) * 40
        : (model.submitted / 30) * 60;
  const coverageScore = clamp(coverage * 100, 0, 100);
  const completionScore = clamp(completion * 100, 0, 100);
  const conflictScore = clamp(100 - conflictRate * 200, 0, 100);
  const score =
    model.submitted === 0
      ? 0
      : Math.round(sampleScore * 0.3 + coverageScore * 0.3 + completionScore * 0.25 + conflictScore * 0.15);
  const label = model.submitted === 0 ? 'No data' : score >= 75 ? 'Ready to read' : score >= 50 ? 'Directional' : 'Early signal';
  const worstRange = samplingRange(model.submitted);
  const summary =
    model.submitted === 0
      ? 'There are no submitted answers yet. The brief is ready, but it will not invent a finding before the first response arrives.'
      : label === 'Early signal'
        ? `This is an early read, not a decision-grade result. ${model.submitted} submitted answer${model.submitted === 1 ? '' : 's'} can point to a question worth following up, but the ranges are wide.`
        : label === 'Directional'
          ? `The sample is large enough to read directionally. ${model.submitted} submitted responses are enough to see a pattern; representativeness is a separate question the data cannot answer here.`
          : `The data quality is strong enough to support a decision, provided the sampling frame matches the population you care about. ${model.submitted} submitted responses and ${percent(coverage)} answer coverage are the evidence for that sentence.`;

  const facts: AnalysisReadinessFact[] = [
    {
      label: 'Submitted',
      value: String(model.submitted),
      note: `${model.open} still open; ${model.screenedOut} screened out`,
    },
    {
      label: 'Completion',
      value: percent(completion),
      note: 'submitted divided by every started response',
    },
    {
      label: 'Answer coverage',
      value: possible > 0 ? percent(coverage) : 'No questions',
      note: `${questionCount} answerable question${questionCount === 1 ? '' : 's'}; skip logic can lower this by design`,
    },
    {
      label: 'Worst-case sampling range',
      value: worstRange === null ? 'No data' : `±${text(worstRange)} pts`,
      note: 'at 50%, 95% Wilson interval; assumes a simple random sample',
    },
    {
      label: 'Sync conflicts',
      value: String(model.conflicts),
      note: 'device/server disagreements retained for review',
    },
  ];

  const improvements: string[] = [];
  if (model.submitted < 30) improvements.push('Collect at least 30 submitted responses before treating a pattern as more than a lead.');
  else if (model.submitted < 100) improvements.push('For a stable read, aim for 100+ submitted responses; for subgroup claims, the base needs to be checked separately.');
  if (coverage < 0.8 && possible > 0) improvements.push('Check the weakest-coverage question before reading its percentages as representative.');
  if (completion < 0.7) improvements.push('Follow up on partial interviews; a low completion rate can change who is in the final sample.');
  if (model.conflicts > 0) improvements.push('Resolve sync conflicts before aggregating the affected fields.');
  if (improvements.length === 0) improvements.push('No mechanical data-quality gap is visible. Representativeness and the sampling frame are still unverified.');

  return { score, label, summary, facts, improvements };
}

function matchingQuestions(
  questions: MonitorQuestion[],
  pattern: RegExp,
  include: (question: MonitorQuestion) => boolean = () => true,
): MonitorQuestion[] {
  return questions.filter((question) => include(question) && pattern.test(question.label));
}

function uniqueCount(...groups: MonitorQuestion[][]): number {
  return new Set(groups.flat().map((question) => question.name)).size;
}

function lensesFor(model: MonitorModel): { lenses: AnalysisLens[]; focus: string; focusWhy: string } {
  const questions = model.questions;
  const numericQuestions = questions.filter((question) => NUMERIC_TYPES.has(question.type));
  const multiQuestions = questions.filter((question) => MULTI_TYPES.has(question.type));
  const textQuestions = questions.filter((question) => TEXT_TYPES.has(question.type));
  const geoQuestions = questions.filter((question) => ['geopoint', 'geotrace', 'geoshape'].includes(question.type));
  const mediaQuestions = questions.filter((question) => ['image', 'audio', 'video', 'file'].includes(question.type));
  const dateQuestions = questions.filter((question) => question.type === 'date' || question.type === 'datetime');
  const yesnoQuestions = questions.filter((question) => question.type === 'yesno');
  const ratingQuestions = matchingQuestions(questions, RATING_WORDS);
  const profileQuestions = matchingQuestions(
    questions,
    PROFILE_WORDS,
    (question) => !['geopoint', 'geotrace', 'geoshape', 'image', 'audio', 'video', 'file', 'note'].includes(question.type),
  );
  const priorityQuestions = [...multiQuestions, ...matchingQuestions(questions, PRIORITY_WORDS)];
  const marketQuestions = [
    ...questions.filter((question) => question.type === 'currency'),
    ...matchingQuestions(questions, MARKET_WORDS),
  ];
  const adoptionQuestions = [...yesnoQuestions, ...matchingQuestions(questions, ADOPTION_WORDS)];
  const rating = uniqueCount(ratingQuestions);
  const profile = uniqueCount(profileQuestions);
  const priority = uniqueCount(priorityQuestions);
  const market = uniqueCount(marketQuestions);
  const adoption = uniqueCount(adoptionQuestions);
  const numeric = numericQuestions.length;
  const geo = geoQuestions.length;
  const text = textQuestions.length;
  const media = mediaQuestions.length;
  const dates = dateQuestions.length;

  const raw: Array<[string, string, number]> = [
    ['rating', 'Experience & ratings', rating],
    ['profile', 'Client profile & equity', profile],
    ['priority', 'Needs & priorities', priority],
    ['market', 'Price & willingness', market],
    ['coverage', 'Reach & coverage', geo],
    ['voice', 'Open-ended voice', text],
    ['adoption', 'Adoption & access', adoption],
    ['evidence', 'Attached evidence', media],
    ['fieldwork', 'Fieldwork timing', dates],
    ['distribution', 'Performance distribution', numeric],
  ];

  const lenses: AnalysisLens[] = raw.map(([id, label, count]) => ({
    id,
    label,
    why:
      count > 0
        ? `${count} question${count === 1 ? '' : 's'} in this questionnaire match${count === 1 ? 'es' : ''} this lens.`
        : 'No question in this questionnaire matches this lens.',
    used: count > 0,
  }));

  const focus =
    priority > 0 && market > 0
      ? 'Market choices & priorities'
      : profile > 0 && (rating > 0 || numeric > 0)
        ? 'Experience, with an equity lens'
        : priority > 0
          ? 'Needs & priorities'
          : rating > 0
            ? 'Experience & satisfaction'
            : market > 0
              ? 'Price & willingness'
              : geo > 0
                ? 'Reach & coverage'
                : text > 0
                  ? 'Open-ended voice'
                  : numeric > 0
                    ? 'Performance & distribution'
                    : 'Mixed instrument';
  const usedCount = lenses.filter((lens) => lens.used).length;
  return {
    lenses,
    focus,
    focusWhy: `Chosen from this questionnaire’s ${usedCount} detected lens${usedCount === 1 ? '' : 'es'}, not from an industry template.`,
  };
}

function bottomLineFor(model: MonitorModel, readiness: AnalysisReadiness, findings: AnalysisFinding[]): string {
  if (model.submitted === 0) {
    return 'No submitted answers yet. The brief will populate itself as responses arrive; it will not guess.';
  }
  if (findings.length === 0) {
    return 'There are answers, but none has enough structure to support a finding yet. Collect more responses or review the question design.';
  }
  const first = findings[0]!;
  const prefix = readiness.label === 'Early signal' ? 'Early read, not a verdict. ' : '';
  return `${prefix}${first.title}. ${first.action}`;
}

function limitsFor(model: MonitorModel, lenses: AnalysisLens[]): string[] {
  const profile = lenses.find((lens) => lens.id === 'profile' && lens.used);
  return [
    'This brief uses the live marginal counts only. It cannot cross-tabulate questions, segment respondents, or identify what drives an outcome; those need response-level analysis.',
    'No external benchmark, population weights or sampling frame is supplied. It cannot say whether this sample represents a market, region or population.',
    'The 95% ranges assume independent answers from a simple random sample. Clustered, quota or weighted samples need a design effect; a non-probability sample has no formal margin of error.',
    'A difference or an overlap is described, not tested for causation. Nothing here is an experiment.',
    'Free-text counts are exact repeated strings, not themes, sentiment or intent.',
    'A missing answer is not a “no”, a zero or a neutral score.',
    'Multi-select shares are the share of respondents who selected each option; they can add past 100%.',
    'The decision grid is a reading aid, not a significance test.',
    ...(profile
      ? ['Profile questions are detected, but no segment cuts are computed in this brief. Treat the equity lens as a prompt for the next analysis, not a result.']
      : []),
    ...(model.submitted === 0 ? ['There are no submitted answers yet, so the readiness score is zero by construction.'] : []),
  ];
}

function nextQuestionsFor(model: MonitorModel, lenses: AnalysisLens[], findings: AnalysisFinding[]): string[] {
  const questions: string[] = [];
  const has = (id: string): boolean => lenses.some((lens) => lens.id === id && lens.used);
  if (model.submitted < 30) questions.push('How many more submitted responses are needed before this decision can be made?');
  if (has('profile')) questions.push('Which two or three profile questions should define the first segment cuts, and what minimum base should each cut have?');
  if (has('priority')) questions.push('Which of the leading priorities is feasible to act on, at what cost, and for whom?');
  if (has('voice')) questions.push('Who will read and code the verbatims, and what coding frame will they use?');
  if (has('market')) questions.push('What price or value range would change the decision, rather than merely describe the answers?');
  if (has('coverage')) questions.push('What is the intended sampling frame, and which areas in it have no answers?');
  if (findings.some((finding) => finding.id === 'coverage')) questions.push('Is the weakest-coverage question optional by design, or is it failing in the field?');
  questions.push('What decision will this evidence change, and what result would change your mind?');
  return [...new Set(questions)].slice(0, 5);
}

function glossary(): AnalysisGlossaryEntry[] {
  return [
    {
      term: 'Base',
      plain: 'The number of submitted respondents who actually answered this question. A percentage without its base is not a result.',
    },
    {
      term: '95% range',
      plain: 'A range that would contain the true share in about 95 of 100 similar random samples. It is not a 95% chance that this particular answer is right.',
    },
    {
      term: 'Median',
      plain: 'The middle answer when every answer is put in order. It is less affected by a few extreme answers than the mean.',
    },
    {
      term: 'Middle 50% (IQR)',
      plain: 'The range that holds the middle half of the answers. It shows how spread out the typical experience is.',
    },
    {
      term: 'Effective options',
      plain: 'How many options are genuinely competitive. Two means a two-horse race; five means the answers are fragmented.',
    },
    {
      term: 'Missing',
      plain: 'A submitted response with no value for this question. It is not a “no”, a zero or a neutral score.',
    },
  ];
}

export function buildAnalysisBrief(model: MonitorModel, options: AnalysisOptions = {}): AnalysisBrief {
  const lenses = lensesFor(model);
  const findings = collectFindings(model);
  const readiness = readinessFor(model);
  return {
    schemaVersion: 1,
    client: options.client?.trim() || 'the client organisation',
    instrument: model.title,
    generatedAt: model.generatedAt,
    focus: lenses.focus,
    focusWhy: lenses.focusWhy,
    bottomLine: bottomLineFor(model, readiness, findings),
    readiness,
    findings,
    lenses: lenses.lenses,
    limits: limitsFor(model, lenses.lenses),
    nextQuestions: nextQuestionsFor(model, lenses.lenses, findings),
    glossary: glossary(),
  };
}

function markdownText(value: string): string {
  return value.replace(/\r?\n/g, ' ').trim();
}

/** A portable client brief. Plain Markdown only: no HTML, embedded state or hidden data. */
export function analysisBriefMarkdown(brief: AnalysisBrief): string {
  const lines: string[] = [
    `# ${markdownText(brief.instrument)}`,
    '',
    `Prepared for **${markdownText(brief.client)}**`,
    '',
    `Focus: ${markdownText(brief.focus)}. ${markdownText(brief.focusWhy)}`,
    '',
    `Data as of ${markdownText(brief.generatedAt)}.`,
    '',
    '## The one-page answer',
    '',
    markdownText(brief.bottomLine),
    '',
    '## Readiness',
    '',
    `**${brief.readiness.label}** (${brief.readiness.score}/100). ${markdownText(brief.readiness.summary)}`,
    '',
    ...brief.readiness.facts.map((fact) => `- **${fact.label}:** ${markdownText(fact.value)}. ${markdownText(fact.note)}`),
    '',
    '## Findings',
    '',
  ];

  if (brief.findings.length === 0) {
    lines.push('No finding yet: there are no submitted answers, or none with enough structure to support one.', '');
  }
  for (const [index, finding] of brief.findings.entries()) {
    lines.push(
      `### ${index + 1}. ${markdownText(finding.title)}`,
      '',
      `*${certaintyLabel(finding.certainty)} · ${quadrantLabel(finding.quadrant)}${finding.questionName ? ` · ${markdownText(finding.questionName)}` : ''}*`,
      '',
      markdownText(finding.plain),
      '',
      `**Why it matters.** ${markdownText(finding.why)}`,
      '',
      `**What to do.** ${markdownText(finding.action)}`,
      '',
      `**Show the working.** ${markdownText(finding.method)}`,
      '',
      ...finding.evidence.map((line) => `- ${markdownText(line)}`),
      '',
    );
  }

  lines.push('## What this brief cannot tell you', '', ...brief.limits.map((limit) => `- ${markdownText(limit)}`), '');
  lines.push('## Questions to ask next', '', ...brief.nextQuestions.map((question) => `- ${markdownText(question)}`), '');
  lines.push('## Plain-language glossary', '', ...brief.glossary.map((entry) => `- **${entry.term}:** ${markdownText(entry.plain)}`), '');
  lines.push('## Methods used', '', ...ANALYSIS_METHODS.map((method) => `- **${method.name}.** ${markdownText(method.plain)} *${markdownText(method.source)}.*`), '');
  lines.push('---', '', 'Generated from the live Inicio analytics response. Counts change as responses arrive; the brief is a reading aid, not a substitute for reviewing the instrument and the sampling frame.', '');
  return `${lines.join('\n')}\n`;
}
