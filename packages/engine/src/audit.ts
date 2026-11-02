/**
 * Audit instruments: text audit, audio audit and speed violations.
 *
 * These fields are how a market research instrument checks itself. They are
 * invisible on the device (they are `calculate` questions with an `audit`
 * descriptor), they carry a parameter string written by the scripter, and they
 * produce values that exist only to be reviewed later.
 *
 * Two rules shape everything here:
 *
 * 1. Sampling is deterministic. Given a submission seed, the same field is
 *    audited every time the plan is recomputed (a retry, a sync replay, a
 *    re-export). A coin flip at render time would make two copies of one
 *    interview disagree about whether audio exists.
 * 2. A malformed parameter string is an error with a sentence, not a silently
 *    ignored field. `p=50;` on an audio field is a scripter's typo, and the
 *    compiler is the only place it is cheap to find.
 */
import type { QuestionType } from './types.js';

/* ------------------------------------------------------------- parameters */

/**
 * The parsed form of an audit field's parameter text.
 *
 * `p` is a percentage, because that is how these parameters are written in the
 * wild (`p=50` means half of interviews). `s` is a start offset in seconds and
 * may be a range or the name of a field whose answer gives the offset. `d` is a
 * duration in seconds or the name of a field that stops the recording.
 */
export interface AuditPlan {
  kind: AuditCadenceKind;
  /** 0..1, converted from the authored percentage. */
  probability: number;
  start: { min: number; max: number } | { field: string };
  duration: { seconds: number } | { stopField: string };
  raw: string;
}

export type AuditCadenceKind = 'text_audit' | 'audio_audit';

export interface AuditSpecError {
  error: string;
}

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RANGE = /^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/;

function splitParameters(spec: string): Array<[string, string] | { error: string }> {
  const parts = spec.split(';').map((part) => part.trim()).filter((part) => part !== '');
  const out: Array<[string, string]> = [];
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) return [{ error: `"${part}" is not a parameter; write key=value, for example p=10; s=120-300; d=45` }];
    const key = part.slice(0, eq).trim().toLowerCase();
    const value = part.slice(eq + 1).trim();
    if (key === '') return [{ error: `"${part}" has no parameter name` }];
    if (value === '') return [{ error: `"${key}=" has no value` }];
    out.push([key, value]);
  }
  return out;
}

function seconds(value: string, label: string): number | { error: string } {
  if (!/^\d+(?:\.\d+)?$/.test(value)) return { error: `${label} must be a number of seconds, got "${value}"` };
  const n = Number(value);
  if (!Number.isFinite(n)) return { error: `${label} is not a finite number` };
  return n;
}

/**
 * Parse the `appearance` text of a text or audio audit field.
 *
 * Text audit captures typed text, so it has no start or duration. Audio audit
 * records a window, so it needs a duration (or a stop field) and may have a
 * delayed or randomised start. Speed fields are computed from timings rather
 * than sampled and are handled by `evaluateSpeed`.
 */
export function parseAuditSpec(kind: AuditCadenceKind, spec: string): AuditPlan | AuditSpecError {
  const parameters = splitParameters(spec);
  const bad = parameters.find((p): p is { error: string } => 'error' in p);
  if (bad) return bad;

  const pairs = parameters as Array<[string, string]>;
  const seen = new Set<string>();
  const values = new Map<string, string>();
  for (const [key, value] of pairs) {
    if (seen.has(key)) return { error: `parameter "${key}" is set twice` };
    seen.add(key);
    if (!['p', 's', 'd'].includes(key)) {
      return { error: `unknown parameter "${key}"; this field accepts p, s and d` };
    }
    values.set(key, value);
  }

  const probabilityRaw = values.get('p') ?? '100';
  const probability = seconds(probabilityRaw, 'p (percent)');
  if (typeof probability === 'object') return probability;
  if (probability > 100) return { error: `p must be between 0 and 100 (a percentage), got ${probabilityRaw}` };

  if (kind === 'text_audit') {
    const extra = ['s', 'd'].filter((key) => values.has(key));
    if (extra.length > 0) {
      return { error: `text audit has no recording window, so ${extra.join(' and ')} cannot be set` };
    }
    return {
      kind,
      probability: probability / 100,
      start: { min: 0, max: 0 },
      duration: { seconds: 0 },
      raw: spec,
    };
  }

  const startRaw = values.get('s') ?? '0';
  let start: AuditPlan['start'];
  const range = RANGE.exec(startRaw);
  if (range) {
    const min = Number(range[1]);
    const max = Number(range[2]);
    if (max < min) return { error: `s range starts at ${min} but ends at ${max}; the second number must be larger` };
    start = { min, max };
  } else if (/^\d+(?:\.\d+)?$/.test(startRaw)) {
    start = { min: Number(startRaw), max: Number(startRaw) };
  } else if (FIELD_NAME.test(startRaw)) {
    start = { field: startRaw };
  } else {
    return { error: `s must be seconds, a range like 120-300, or a field name, got "${startRaw}"` };
  }

  const durationRaw = values.get('d');
  let duration: AuditPlan['duration'];
  if (durationRaw === undefined) {
    return { error: 'audio audit needs a duration: write d=<seconds> or d=<field name>' };
  }
  if (/^\d+(?:\.\d+)?$/.test(durationRaw)) {
    const n = Number(durationRaw);
    if (n <= 0) return { error: 'd must be more than 0 seconds' };
    duration = { seconds: n };
  } else if (FIELD_NAME.test(durationRaw)) {
    duration = { stopField: durationRaw };
  } else {
    return { error: `d must be seconds or a field name, got "${durationRaw}"` };
  }

  return { kind, probability: probability / 100, start, duration, raw: spec };
}

/* --------------------------------------------------------------- sampling */

/**
 * A stable 32 bit seed from a string. FNV-1a: small, well distributed for short
 * ASCII seeds, and identical in every JavaScript runtime this code runs in.
 */
export function hashSeed(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Deterministic [0, 1) from a seed. */
export function random01(seed: string): number {
  // mulberry32
  let t = (hashSeed(seed) + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** The seed for one field of one submission. Fields sample independently. */
export function auditSeed(submissionId: string, questionName: string): string {
  return `${submissionId}::${questionName}`;
}

/** Whether this submission is in the audit sample for this field. */
export function isAudited(plan: AuditPlan, seed: string): boolean {
  if (plan.probability <= 0) return false;
  if (plan.probability >= 1) return true;
  return random01(seed) < plan.probability;
}

export interface AudioWindow {
  startSeconds: number;
  /** Absent when a stop field ends the recording instead of a fixed duration. */
  durationSeconds?: number;
  stopField?: string;
}

/**
 * Resolve a plan into a concrete recording window.
 *
 * `fieldValue` is the value of the start or stop field named in the plan, when
 * the plan named one. A missing or non-numeric value is reported rather than
 * defaulted: recording 180 seconds from second zero when the scripter asked for
 * "after the consent question" would quietly capture the wrong part of an
 * interview.
 */
export function audioWindow(
  plan: AuditPlan,
  seed: string,
  fieldValue?: (name: string) => unknown,
): AudioWindow | AuditSpecError {
  let startSeconds = 0;
  if ('field' in plan.start) {
    const value = fieldValue?.(plan.start.field);
    // `Number('')` is 0, and a blank start field is not a plan to start at zero:
    // it is a field that has not been answered yet. Refuse rather than record the
    // wrong part of the interview.
    const blank = value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
    const n = typeof value === 'number' ? value : Number(value);
    if (blank || !Number.isFinite(n) || n < 0) {
      return { error: `audio audit start field "${plan.start.field}" has no usable number yet` };
    }
    startSeconds = n;
  } else if (plan.start.max > plan.start.min) {
    startSeconds = plan.start.min + random01(`${seed}::start`) * (plan.start.max - plan.start.min);
  } else {
    startSeconds = plan.start.min;
  }

  if ('stopField' in plan.duration) return { startSeconds, stopField: plan.duration.stopField };
  return { startSeconds, durationSeconds: plan.duration.seconds };
}

/* ------------------------------------------------------- speed violations */

/** The fewest seconds a considered answer takes, by control. */
export const SPEED_THRESHOLDS: Partial<Record<QuestionType, number>> = {
  text: 2.5,
  textarea: 3,
  integer: 1.2,
  decimal: 1.4,
  percentage: 1.2,
  currency: 1.4,
  date: 1.5,
  datetime: 1.8,
  time: 1.5,
  yesno: 0.8,
  select_one: 1,
  select_multiple: 1.2,
  rank: 2,
  geopoint: 1,
  geotrace: 2,
  geoshape: 2,
  image: 1,
  audio: 1,
  video: 1,
  file: 1,
  barcode: 0.8,
};

export const DEFAULT_SPEED_THRESHOLD_SECONDS = 1.2;

export interface FieldTiming {
  question: string;
  type?: QuestionType;
  /** When the field became visible, in milliseconds since the interview began. */
  shownAt: number;
  /** When the answer was committed, same clock. */
  answeredAt: number;
  /** Serialised answer at commit time. Empty means the field was skipped. */
  answer?: string;
}

export interface FieldSpeedFinding {
  question: string;
  seconds: number;
  thresholdSeconds: number;
  type?: QuestionType;
}

export interface SpeedReport {
  findings: FieldSpeedFinding[];
  count: number;
  /** Comma separated question names, ready for a `speed violations list` field. */
  list: string;
  totalSeconds: number;
  formTooFast: boolean;
  /** Values for the three computed metadata fields, when the form has them. */
  values: Record<string, number | string>;
}

export interface SpeedOptions {
  /** Override the per-control floor for one question, in seconds. */
  thresholds?: Record<string, number>;
  /** A floor for the whole interview. Omitted when not set; the caller owns it. */
  minimumFormSeconds?: number;
}

/**
 * Find answers that were committed faster than a person could plausibly give
 * them.
 *
 * This is a screening tool, not a verdict: a barcode scanned in half a second is
 * not fraud, and a two second text answer can be. It reports the fields and lets
 * the review queue decide. Skipped fields are not violations, and neither are
 * audit fields or notes, which have no answer of their own.
 */
export function evaluateSpeed(timings: FieldTiming[], options: SpeedOptions = {}): SpeedReport {
  const findings: FieldSpeedFinding[] = [];
  for (const timing of timings) {
    const answered = timing.answer !== undefined && timing.answer !== null && String(timing.answer).trim() !== '';
    if (!answered) continue;
    if (timing.type === 'note' || timing.type === 'calculate') continue;
    const threshold = options.thresholds?.[timing.question]
      ?? (timing.type ? SPEED_THRESHOLDS[timing.type] : undefined)
      ?? DEFAULT_SPEED_THRESHOLD_SECONDS;
    if (threshold <= 0) continue;
    const seconds = Math.max(0, (timing.answeredAt - timing.shownAt) / 1000);
    if (seconds < threshold) {
      findings.push({
        question: timing.question,
        seconds: Math.round(seconds * 100) / 100,
        thresholdSeconds: threshold,
        ...(timing.type ? { type: timing.type } : {}),
      });
    }
  }

  const span = timings.reduce(
    (max, timing) => Math.max(max, timing.answeredAt, timing.shownAt),
    0,
  );
  const totalSeconds = Math.round(span) / 1000;
  const list = findings.map((finding) => finding.question).join(',');
  const formTooFast = options.minimumFormSeconds !== undefined && totalSeconds < options.minimumFormSeconds;

  return {
    findings,
    count: findings.length,
    list,
    totalSeconds,
    formTooFast,
    values: {
      speed_violations: findings.length,
      speed_violations_count: findings.length,
      speed_violations_list: list,
    },
  };
}

/** Parse the optional thresholds on a `speed violations` field. */
export function parseSpeedSpec(spec: string): { minimumFormSeconds?: number; thresholds: Record<string, number> } | AuditSpecError {
  const parameters = splitParameters(spec);
  const bad = parameters.find((p): p is { error: string } => 'error' in p);
  if (bad) return bad;
  const thresholds: Record<string, number> = {};
  let minimumFormSeconds: number | undefined;
  for (const [key, value] of parameters as Array<[string, string]>) {
    const n = seconds(value, key);
    if (typeof n === 'object') return n;
    if (key === 'total') minimumFormSeconds = n;
    else if (FIELD_NAME.test(key)) thresholds[key] = n;
    else return { error: `unknown speed parameter "${key}"; name a question or write total=<seconds>` };
  }
  return minimumFormSeconds === undefined ? { thresholds } : { thresholds, minimumFormSeconds };
}
