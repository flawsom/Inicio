import { describe, expect, it } from 'vitest';
import { chiSquareTest, detectOutliers, formatP, frequencyReport, normalCdf, tTestMean, twoSampleTTest } from '../src/qc.js';

describe('statistical quality control', () => {
  it('finds a Tukey outlier and states the fences it used', () => {
    const report = detectOutliers([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 100]);
    expect(report.outliers.map((entry) => entry.value)).toEqual([100]);
    expect(report.multiple).toBe(1.5);
    expect(report.upperBound).toBeLessThan(100);
    expect(report.n).toBe(11);
  });

  it('removes explicit sentinel values before computing the fences', () => {
    const report = detectOutliers([1, 2, 3, 4, 5, -99], 1.5, [-99]);
    expect(report.excluded).toEqual([-99]);
    expect(report.outliers).toEqual([]);
    expect(report.n).toBe(5);
  });

  it('reports too frequent and too infrequent shares with the counts that made them', () => {
    const findings = frequencyReport({ yes: 90, no: 8, missing: 2 }, 100, 0.05, 0.8);
    expect(findings).toContainEqual({ value: 'yes', count: 90, share: 0.9, kind: 'too_frequent' });
    expect(findings).toContainEqual({ value: 'missing', count: 2, share: 0.02, kind: 'too_infrequent' });
    expect(findings.map((finding) => finding.value)).not.toContain('no');
  });

  it('runs a one-sample t test against an explicit expected mean', () => {
    const report = tTestMean([9, 10, 11, 10, 10, 9, 11], 10);
    expect(report.n).toBe(7);
    expect(report.mean).toBe(10);
    expect(report.p).toBeGreaterThan(0.05);
    expect(report.significant).toBe(false);
    expect(report.test).toBe('one-sample t test');
  });

  it('separates two groups with a Welch test and records the p value', () => {
    const report = twoSampleTTest([1, 2, 3, 4, 5], [10, 11, 12, 13, 14]);
    expect(report.n).toBe(10);
    expect(report.t).toBeLessThan(0);
    expect(report.p).toBeLessThan(0.01);
    expect(report.significant).toBe(true);
  });

  it('computes a chi-squared result for a contingency table', () => {
    const report = chiSquareTest([[40, 10], [10, 40]]);
    expect(report.df).toBe(1);
    expect(report.statistic).toBeGreaterThan(10);
    expect(report.p).toBeLessThan(0.01);
    expect(report.significant).toBe(true);
    expect(report.expected).toHaveLength(2);
  });

  it('prints a p value without claiming more precision than it has', () => {
    expect(formatP(0.5)).toBe('0.5000');
    expect(formatP(0.00001)).toBe('< 0.0001');
    expect(formatP(Number.NaN)).toBe('not enough data');
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.96)).toBeGreaterThan(0.974);
  });
});
