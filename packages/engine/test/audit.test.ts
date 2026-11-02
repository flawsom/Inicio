import { describe, expect, it } from 'vitest';
import {
  auditSeed,
  audioWindow,
  evaluateSpeed,
  hashSeed,
  isAudited,
  parseAuditSpec,
  parseSpeedSpec,
  random01,
  type FieldTiming,
} from '../src/audit.js';

describe('audit parameters', () => {
  it('reads a text audit percentage', () => {
    const plan = parseAuditSpec('text_audit', 'p=25');
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.probability).toBeCloseTo(0.25);
    expect(plan.kind).toBe('text_audit');
  });

  it('defaults text audit to every interview and refuses a window it cannot record', () => {
    const all = parseAuditSpec('text_audit', '');
    if ('error' in all) throw new Error(all.error);
    expect(all.probability).toBe(1);

    const refusal = parseAuditSpec('text_audit', 'p=10; d=30');
    expect('error' in refusal && refusal.error).toContain('text audit has no recording window');
  });

  it('reads the audio window: probability, start range and duration', () => {
    const plan = parseAuditSpec('audio_audit', 'p=50; s=300-600; d=45');
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.probability).toBeCloseTo(0.5);
    expect(plan.start).toEqual({ min: 300, max: 600 });
    expect(plan.duration).toEqual({ seconds: 45 });
  });

  it('reads a start field and a stop field', () => {
    const plan = parseAuditSpec('audio_audit', 's=consent_at; d=interview_end');
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.start).toEqual({ field: 'consent_at' });
    expect(plan.duration).toEqual({ stopField: 'interview_end' });
  });

  it('requires a duration and rejects nonsense with a sentence', () => {
    const missing = parseAuditSpec('audio_audit', 'p=10; s=60');
    expect('error' in missing && missing.error).toContain('needs a duration');

    for (const spec of ['p=101', 'p=ten', 's=600-300; d=30', 'd=0', 'p=10; p=20; d=5', 'p=10; z=2; d=5']) {
      const parsed = parseAuditSpec('audio_audit', spec);
      expect('error' in parsed).toBe(true);
    }
  });

  it('resolves an audio window deterministically from the seed', () => {
    const plan = parseAuditSpec('audio_audit', 'p=100; s=100-200; d=30');
    if ('error' in plan) throw new Error(plan.error);
    const seed = auditSeed('e8f1', 'recording');
    const first = audioWindow(plan, seed);
    const second = audioWindow(plan, seed);
    expect(first).toEqual(second);
    if ('error' in first) throw new Error(first.error);
    expect(first.startSeconds).toBeGreaterThanOrEqual(100);
    expect(first.startSeconds).toBeLessThan(200);
    expect(first.durationSeconds).toBe(30);
  });

  it('refuses to guess when a start field has no usable value', () => {
    const plan = parseAuditSpec('audio_audit', 's=consent_at; d=30');
    if ('error' in plan) throw new Error(plan.error);
    const result = audioWindow(plan, 'seed', () => '');
    expect('error' in result && result.error).toContain('consent_at');
  });

  it('samples deterministically and at the edges', () => {
    const seed = auditSeed('response-1', 'audit_text');
    const always = parseAuditSpec('text_audit', 'p=100');
    const never = parseAuditSpec('text_audit', 'p=0');
    if ('error' in always || 'error' in never) throw new Error('spec');
    expect(isAudited(always, seed)).toBe(true);
    expect(isAudited(never, seed)).toBe(false);

    const half = parseAuditSpec('text_audit', 'p=50');
    if ('error' in half) throw new Error(half.error);
    expect(isAudited(half, seed)).toBe(isAudited(half, seed));
    // The seed function itself must be stable across calls and distinct per field.
    expect(hashSeed('a')).toBe(hashSeed('a'));
    expect(random01('a')).toBe(random01('a'));
    expect(random01(auditSeed('r', 'a'))).not.toBe(random01(auditSeed('r', 'b')));
  });
});

describe('speed violations', () => {
  const timings: FieldTiming[] = [
    { question: 'school_name', type: 'text', shownAt: 0, answeredAt: 800, answer: 'Springfield' },
    { question: 'teacher_quality', type: 'integer', shownAt: 1000, answeredAt: 6000, answer: '4' },
    { question: 'skipped_field', type: 'text', shownAt: 0, answeredAt: 200, answer: '' },
    { question: 'thanks', type: 'note', shownAt: 0, answeredAt: 100, answer: 'read' },
    { question: 'fee_annual', type: 'currency', shownAt: 2000, answeredAt: 3200, answer: '1200' },
  ];

  it('flags answers that are faster than a person could give them', () => {
    const report = evaluateSpeed(timings);
    expect(report.findings.map((finding) => finding.question)).toEqual(['school_name', 'fee_annual']);
    expect(report.count).toBe(2);
    expect(report.list).toBe('school_name,fee_annual');
    expect(report.values['speed_violations']).toBe(2);
    expect(report.values['speed_violations_count']).toBe(2);
    expect(report.values['speed_violations_list']).toBe('school_name,fee_annual');
    expect(report.totalSeconds).toBe(6);
  });

  it('does not flag a skipped field, a note or an answer at the threshold', () => {
    const report = evaluateSpeed([
      { question: 'a', type: 'text', shownAt: 0, answeredAt: 2500, answer: 'x' },
      { question: 'b', type: 'select_one', shownAt: 0, answeredAt: 999, answer: '' },
      { question: 'c', type: 'note', shownAt: 0, answeredAt: 1, answer: 'note' },
    ]);
    expect(report.findings).toEqual([]);
  });

  it('honours a per-field override and a form floor', () => {
    const report = evaluateSpeed(timings, {
      thresholds: { fee_annual: 0.5 },
      minimumFormSeconds: 120,
    });
    expect(report.findings.map((finding) => finding.question)).toEqual(['school_name']);
    expect(report.formTooFast).toBe(true);
  });

  it('reads speed thresholds from a parameter string', () => {
    const spec = parseSpeedSpec('total=180; consent=2.5; barcode=0.2');
    if ('error' in spec) throw new Error(spec.error);
    expect(spec.minimumFormSeconds).toBe(180);
    expect(spec.thresholds).toEqual({ consent: 2.5, barcode: 0.2 });

    const bad = parseSpeedSpec('total=soon');
    expect('error' in bad && bad.error).toContain('total');
  });
});
