/**
 * Statistical quality control, as pure arithmetic.
 *
 * These functions produce evidence, not a verdict. Every report carries the
 * numbers that made it fire and the rule that was applied, so a reviewer can
 * disagree with the threshold without having to reverse-engineer it. The API
 * turns the reports into `response_flag` rows; the engine never reads a database.
 */

export interface OutlierReport {
  n: number;
  q1: number;
  q3: number;
  iqr: number;
  lowerBound: number;
  upperBound: number;
  multiple: number;
  excluded: number[];
  outliers: Array<{ index: number; value: number }>;
}

function finite(values: readonly number[]): number[] {
  return values.filter((value) => Number.isFinite(value));
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? Number.NaN : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleVariance(values: readonly number[]): number {
  if (values.length < 2) return Number.NaN;
  const average = mean(values);
  return values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
}

function median(sorted: readonly number[]): number {
  if (sorted.length === 0) return Number.NaN;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Tukey's hinges, the quartiles a box plot actually uses. */
function quartiles(values: readonly number[]): { q1: number; q3: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const lower = sorted.slice(0, middle);
  const upper = sorted.length % 2 === 1 ? sorted.slice(middle + 1) : sorted.slice(middle);
  return { q1: median(lower), q3: median(upper) };
}

/**
 * Outliers outside `q1 - multiple * iqr` and `q3 + multiple * iqr`.
 *
 * `exclusions` is for sentinel values (a refusal coded as -99, say). They are
 * removed before the quartiles are computed *and* before a row can be called an
 * outlier, because a sentinel is missing data and a missing answer is not an
 * extreme answer.
 */
export function detectOutliers(
  values: readonly number[],
  multiple = 1.5,
  exclusions: readonly number[] = [],
): OutlierReport {
  const excluded = new Set(exclusions);
  const indexed = values
    .map((value, index) => ({ index, value }))
    .filter((entry) => Number.isFinite(entry.value) && !excluded.has(entry.value));
  const numbers = indexed.map((entry) => entry.value);
  if (numbers.length < 4) {
    return { n: numbers.length, q1: Number.NaN, q3: Number.NaN, iqr: Number.NaN, lowerBound: Number.NaN, upperBound: Number.NaN, multiple, excluded: [...exclusions], outliers: [] };
  }
  const { q1, q3 } = quartiles(numbers);
  const iqr = q3 - q1;
  const lowerBound = q1 - multiple * iqr;
  const upperBound = q3 + multiple * iqr;
  return {
    n: numbers.length,
    q1,
    q3,
    iqr,
    lowerBound,
    upperBound,
    multiple,
    excluded: [...exclusions],
    outliers: indexed.filter((entry) => entry.value < lowerBound || entry.value > upperBound),
  };
}

export interface FrequencyFinding {
  value: string;
  count: number;
  share: number;
  kind: 'too_frequent' | 'too_infrequent';
}

/** Too common and too rare, against explicit shares rather than a hidden default. */
export function frequencyReport(
  counts: Readonly<Record<string, number>>,
  total: number,
  minShare = 0.02,
  maxShare = 0.8,
): FrequencyFinding[] {
  if (total <= 0) return [];
  const findings: FrequencyFinding[] = [];
  for (const [value, count] of Object.entries(counts)) {
    const share = count / total;
    if (share >= maxShare) findings.push({ value, count, share, kind: 'too_frequent' });
    else if (share <= minShare) findings.push({ value, count, share, kind: 'too_infrequent' });
  }
  return findings;
}

export interface MeanTestReport {
  n: number;
  mean: number;
  sd: number;
  expected: number;
  t: number;
  df: number;
  p: number;
  alpha: number;
  significant: boolean;
  test: string;
}

function logGamma(z: number): number {
  const coefficients = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  const shifted = z - 1;
  let x = 0.99999999999980993;
  for (let i = 0; i < coefficients.length; i += 1) x += coefficients[i]! / (shifted + i + 1);
  const t = shifted + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(x);
}

/** Regularized lower incomplete gamma P(a, x), using the standard series. */
function gammaP(a: number, x: number): number {
  if (x <= 0) return 0;
  if (x < a + 1) {
    let sum = 1 / a;
    let term = sum;
    for (let n = 1; n < 200; n += 1) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-14) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
  }
  return 1 - gammaQ(a, x);
}

/** Regularized upper incomplete gamma Q(a, x), using the continued fraction. */
function gammaQ(a: number, x: number): number {
  if (x <= 0) return 1;
  if (x < a + 1) return 1 - gammaP(a, x);
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 200; i += 1) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-14) break;
  }
  return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}

function betaContinuedFraction(a: number, b: number, x: number): number {
  const tiny = 1e-300;
  let c = 1;
  let d = 1 - (a + b) * x / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m += 1) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = -(a + m) * (a + b + m) * x / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-14) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b). */
function incompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2)
    ? front * betaContinuedFraction(a, b, x) / a
    : 1 - front * betaContinuedFraction(b, a, 1 - x) / b;
}

function normalCdf(value: number): number {
  // Abramowitz and Stegun 7.1.26, more than enough for a displayed p-value.
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

function tTail(t: number, df: number): number {
  if (df <= 0 || !Number.isFinite(t)) return Number.NaN;
  const x = df / (df + t * t);
  return 0.5 * incompleteBeta(df / 2, 0.5, x);
}

/** One sample, two sided, against an expected mean. */
export function tTestMean(values: readonly number[], expected: number, alpha = 0.05): MeanTestReport {
  const numbers = finite(values);
  const n = numbers.length;
  const average = mean(numbers);
  const sd = Math.sqrt(sampleVariance(numbers));
  if (n < 2 || !Number.isFinite(sd) || sd === 0) {
    return { n, mean: average, sd, expected, t: Number.NaN, df: n - 1, p: Number.NaN, alpha, significant: false, test: 'one-sample t test' };
  }
  const t = (average - expected) / (sd / Math.sqrt(n));
  const p = 2 * tTail(Math.abs(t), n - 1);
  return { n, mean: average, sd, expected, t, df: n - 1, p, alpha, significant: p < alpha, test: 'one-sample t test' };
}

/** Welch's two sample t test, for a group against the rest. */
export function twoSampleTTest(
  left: readonly number[],
  right: readonly number[],
  alpha = 0.05,
): MeanTestReport {
  const a = finite(left);
  const b = finite(right);
  if (a.length < 2 || b.length < 2) {
    return { n: a.length + b.length, mean: mean(a), sd: Number.NaN, expected: mean(b), t: Number.NaN, df: Number.NaN, p: Number.NaN, alpha, significant: false, test: 'Welch two-sample t test' };
  }
  const va = sampleVariance(a) / a.length;
  const vb = sampleVariance(b) / b.length;
  const t = (mean(a) - mean(b)) / Math.sqrt(va + vb);
  const df = (va + vb) ** 2 / (va ** 2 / (a.length - 1) + vb ** 2 / (b.length - 1));
  const p = 2 * tTail(Math.abs(t), df);
  return {
    n: a.length + b.length,
    mean: mean(a),
    sd: Math.sqrt(sampleVariance(a)),
    expected: mean(b),
    t,
    df,
    p,
    alpha,
    significant: p < alpha,
    test: 'Welch two-sample t test',
  };
}

export interface ChiSquareReport {
  statistic: number;
  df: number;
  p: number;
  alpha: number;
  significant: boolean;
  test: string;
  observed: number[][];
  expected: number[][];
}

/** Pearson's chi-squared test of independence over a contingency table. */
export function chiSquareTest(observed: readonly (readonly number[])[], alpha = 0.05): ChiSquareReport {
  const rows = observed.map((row) => [...row]);
  const rowTotals = rows.map((row) => row.reduce((sum, value) => sum + value, 0));
  const columns = Math.max(0, ...rows.map((row) => row.length));
  const columnTotals = Array.from({ length: columns }, (_, column) =>
    rows.reduce((sum, row) => sum + (row[column] ?? 0), 0),
  );
  const total = rowTotals.reduce((sum, value) => sum + value, 0);
  const expected = rows.map((row, r) => row.map((_, c) => (rowTotals[r]! * columnTotals[c]!) / total));
  let statistic = 0;
  for (let r = 0; r < rows.length; r += 1) {
    for (let c = 0; c < rows[r]!.length; c += 1) {
      const e = expected[r]![c]!;
      // A zero expected count makes the statistic undefined. Skipping it is the
      // honest, conventional treatment; it cannot create evidence of dependence.
      if (e > 0) statistic += (rows[r]![c]! - e) ** 2 / e;
    }
  }
  const df = Math.max(0, (rows.length - 1) * (columns - 1));
  const p = df === 0 ? Number.NaN : gammaQ(df / 2, statistic / 2);
  return { statistic, df, p, alpha, significant: p < alpha, test: 'Pearson chi-squared test of independence', observed: rows, expected };
}

/** A p-value rendered for a human, without pretending to more precision than it has. */
export function formatP(p: number): string {
  if (!Number.isFinite(p)) return 'not enough data';
  if (p < 0.0001) return '< 0.0001';
  return p.toFixed(4);
}

export { normalCdf };
