import { wilsonInterval, type AnalysisRange } from './analysis-model';
import type { MonitorModel, MonitorQuestion } from './monitor-model';

/**
 * The visual analysis layer of the live monitor.
 *
 * This is a pure projection of the counts the server already returns. It exists
 * so the monitor can show analytical structure without pretending to have
 * response-level data it does not have: no segment cuts, no driver model and no
 * causal claim is derived here. A confidence band is only drawn for a
 * single-choice answer, where a respondent contributes exactly one observation
 * to the base. Multi-select shares are left to the question cards because their
 * denominator is not a binomial one.
 */

export interface InsightConfidenceBand {
  name: string;
  label: string;
  type: string;
  groupLabel: string;
  base: number;
  coverage: number;
  topLabel: string;
  topCount: number;
  share: number;
  interval: AnalysisRange;
  intervalWidth: number;
  effectiveOptions: number;
  thinBase: boolean;
}

export interface InsightCoverageGroup {
  id: string;
  label: string;
  questionCount: number;
  answered: number;
  possible: number;
  coverage: number;
  thinQuestions: number;
}

export interface InsightTypeSlice {
  type: string;
  label: string;
  count: number;
  share: number;
}

export interface InsightTimelinePoint {
  day: string;
  started: number;
  submitted: number;
  cumulativeStarted: number;
  cumulativeSubmitted: number;
}

export interface MonitorInsights {
  generatedAt: string;
  submitted: number;
  started: number;
  open: number;
  screenedOut: number;
  conflicts: number;
  completionRate: number | null;
  coverageRate: number | null;
  integrityRate: number | null;
  answerable: number;
  noAnswers: number;
  thinQuestions: number;
  confidenceBands: InsightConfidenceBand[];
  coverageGroups: InsightCoverageGroup[];
  typeMix: InsightTypeSlice[];
  timeline: InsightTimelinePoint[];
  recentTimeline: InsightTimelinePoint[];
  activeDays: number;
  peakDay: InsightTimelinePoint | null;
  velocity: number | null;
}

const SINGLE_CHOICE_TYPES = new Set(['select_one', 'yesno']);
const THIN_BASE = 30;
const CHART_BAND_LIMIT = 7;

function percent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function questionLabel(question: MonitorQuestion): string {
  return question.label.replace(/\s+/g, ' ').trim();
}

/**
 * How many options are genuinely competitive. This is the reciprocal of the
 * Herfindahl-Hirschman index over the observed answer counts. It is descriptive:
 * it says the answers are concentrated or fragmented, not that the options are
 * independent or that one causes another.
 */
function effectiveOptions(question: MonitorQuestion): number {
  const total = question.options.reduce((sum, option) => sum + option.count, 0);
  if (total <= 0) return 0;
  const hhi = question.options.reduce((sum, option) => {
    const share = option.count / total;
    return sum + share * share;
  }, 0);
  return hhi > 0 ? 1 / hhi : 0;
}

function confidenceBand(question: MonitorQuestion): InsightConfidenceBand | null {
  if (!SINGLE_CHOICE_TYPES.has(question.type) || question.answered <= 0) return null;
  const top = question.options[0];
  if (!top) return null;
  const interval = wilsonInterval(top.count, question.answered);
  if (!interval) return null;
  return {
    name: question.name,
    label: questionLabel(question),
    type: question.type,
    groupLabel: question.groupLabel,
    base: question.answered,
    coverage: question.total > 0 ? question.answered / question.total : 0,
    topLabel: top.label,
    topCount: top.count,
    share: (top.count / question.answered) * 100,
    interval,
    intervalWidth: interval.high - interval.low,
    effectiveOptions: effectiveOptions(question),
    thinBase: question.answered < THIN_BASE,
  };
}

/**
 * Rank the bands by the weight of the lead and the size of the base. A 90% lead
 * on three answers should not outrank a 55% lead on 300. The square root keeps a
 * very large base from making every chart look identical without letting a tiny
 * base dominate.
 */
function bandScore(band: InsightConfidenceBand): number {
  return band.share * Math.sqrt(Math.max(1, band.base));
}

function buildTypeMix(questions: MonitorQuestion[]): InsightTypeSlice[] {
  const counts = new Map<string, number>();
  for (const question of questions) counts.set(question.type, (counts.get(question.type) ?? 0) + 1);
  const total = questions.length;
  return [...counts.entries()]
    .map(([type, count]) => ({
      type,
      label: type.replaceAll('_', ' '),
      count,
      share: total > 0 ? count / total : 0,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function buildTimeline(model: MonitorModel): InsightTimelinePoint[] {
  let cumulativeStarted = 0;
  let cumulativeSubmitted = 0;
  return model.timeline.map((point) => {
    cumulativeStarted += point.started;
    cumulativeSubmitted += point.submitted;
    return {
      ...point,
      cumulativeStarted,
      cumulativeSubmitted,
    };
  });
}

function lastObservedVelocity(points: InsightTimelinePoint[]): number | null {
  if (points.length === 0) return null;
  const recent = points.slice(-7);
  const submitted = recent.reduce((sum, point) => sum + point.submitted, 0);
  return submitted / recent.length;
}

export function buildMonitorInsights(model: MonitorModel): MonitorInsights {
  const possible = model.questions.reduce((sum, question) => sum + question.total, 0);
  const answered = model.questions.reduce((sum, question) => sum + question.answered, 0);
  const timeline = buildTimeline(model);
  const recentTimeline = timeline.slice(-30);
  const peakDay = timeline.reduce<InsightTimelinePoint | null>(
    (best, point) => (!best || point.submitted > best.submitted ? point : best),
    null,
  );

  const coverageGroups: InsightCoverageGroup[] = model.groups.map((group) => {
    const answeredInGroup = group.questions.reduce((sum, question) => sum + question.answered, 0);
    const possibleInGroup = group.questions.reduce((sum, question) => sum + question.total, 0);
    return {
      id: group.id,
      label: group.label,
      questionCount: group.questions.length,
      answered: answeredInGroup,
      possible: possibleInGroup,
      coverage: possibleInGroup > 0 ? answeredInGroup / possibleInGroup : 0,
      thinQuestions: group.questions.filter((question) => question.answered > 0 && question.answered < THIN_BASE).length,
    };
  });

  const bands = model.questions
    .map(confidenceBand)
    .filter((band): band is InsightConfidenceBand => band !== null)
    .sort((a, b) => bandScore(b) - bandScore(a) || b.base - a.base)
    .slice(0, CHART_BAND_LIMIT);

  return {
    generatedAt: model.generatedAt,
    submitted: model.submitted,
    started: model.total,
    open: model.open,
    screenedOut: model.screenedOut,
    conflicts: model.conflicts,
    completionRate: model.completionRate,
    coverageRate: possible > 0 ? answered / possible : null,
    integrityRate: model.submitted > 0 ? Math.max(0, 1 - model.conflicts / model.submitted) : null,
    answerable: model.answerable,
    noAnswers: model.questions.filter((question) => question.answered === 0).length,
    thinQuestions: model.questions.filter((question) => question.answered > 0 && question.answered < THIN_BASE).length,
    confidenceBands: bands,
    coverageGroups,
    typeMix: buildTypeMix(model.questions),
    timeline,
    recentTimeline,
    activeDays: timeline.filter((point) => point.submitted > 0).length,
    peakDay: peakDay && peakDay.submitted > 0 ? peakDay : null,
    velocity: lastObservedVelocity(timeline),
  };
}

export function insightPercent(value: number | null): string {
  return value === null ? 'No data' : percent(value * 100);
}

export function insightNumber(value: number): string {
  return value.toLocaleString();
}
