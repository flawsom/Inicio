import { describe, expect, it } from 'vitest';
import { ExpressionError, collectRefs, parse, runExpression } from '../src/expression.js';

describe('expression language', () => {
  it('honours arithmetic precedence and parentheses', () => {
    expect(runExpression('1 + 2 * 3')).toBe(7);
    expect(runExpression('(1 + 2) * 3')).toBe(9);
    expect(runExpression('10 % 3')).toBe(1);
    expect(runExpression('-4 + 1')).toBe(-3);
  });

  it('reads references and embedded variables', () => {
    expect(runExpression("${answer} = 'yes'", { answers: { answer: 'yes' } })).toBe(true);
    expect(runExpression('${age} >= 18', { answers: { age: 20 } })).toBe(true);
    expect(runExpression('${plan} = \'pro\'', { variables: { plan: 'pro' } })).toBe(true);
    expect(runExpression('${missing} = 1')).toBe(false); // unknown ref resolves to null, not an error
  });

  it('treats multi-selects as sets', () => {
    const ctx = { answers: { conditions: ['diabetes', 'asthma'] } };
    expect(runExpression("selected(${conditions}, 'asthma')", ctx)).toBe(true);
    expect(runExpression("selected(${conditions}, 'none')", ctx)).toBe(false);
    expect(runExpression('count-selected(${conditions})', ctx)).toBe(2);
  });

  it('short-circuits and/or so unreached branches are not evaluated', () => {
    // the right-hand call would throw if evaluated
    expect(runExpression("false and nosuchfn(1)")).toBe(false);
    expect(runExpression("true or nosuchfn(1)")).toBe(true);
  });

  it('supports the documented functions', () => {
    expect(runExpression("if(${a} > 1, 'big', 'small')", { answers: { a: 5 } })).toBe('big');
    expect(runExpression('round(3.14159, 2)')).toBe(3.14);
    expect(runExpression("coalesce(${a}, 'fallback')", { answers: { a: null } })).toBe('fallback');
    expect(runExpression("upper('ab')")).toBe('AB');
    expect(runExpression("length('abcd')")).toBe(4);
    expect(runExpression('min(3, 1, 2)')).toBe(1);
    expect(runExpression('max(3, 1, 2)')).toBe(3);
    expect(runExpression('sum(1, 2, 3)')).toBe(6);
    expect(runExpression('sum(${nums})', { answers: { nums: [1, 2, 3] } })).toBe(6);
    expect(runExpression('int(7.9)')).toBe(7);
    expect(runExpression("number('12.5')")).toBe(12.5);
    expect(runExpression("number('abc')")).toBeNull();
  });

  it('binds "." to the current value inside a constraint', () => {
    expect(runExpression('. >= 18 and . <= 120', { current: 40 })).toBe(true);
    expect(runExpression('. >= 18', { current: 12 })).toBe(false);
  });

  it('does not treat a blank numeric answer as zero', () => {
    // null > 0 must be false, not "0 > 0"
    expect(runExpression('${n} > 0', { answers: { n: null } })).toBe(false);
  });

  it('reports malformed input rather than silently mis-evaluating', () => {
    expect(() => runExpression('${unclosed')).toThrow(ExpressionError);
    expect(() => runExpression("'unterminated")).toThrow(ExpressionError);
    expect(() => runExpression('nosuchfn(1)')).toThrow(/Unknown function/);
    // A bare name parses (it is a choice attribute inside a choice_filter) and
    // resolves to null unless the context supplies attributes; `validateForm`
    // rejects it everywhere except choice_filter.
    expect(() => runExpression('bareword')).not.toThrow();
    expect(runExpression('bareword = "ka"', { attributes: { bareword: 'ka' } })).toBe(true);
    expect(runExpression('bareword = "ka"')).toBe(false);
    expect(() => runExpression('1 +')).toThrow(ExpressionError);
  });

  it('collects the references an expression depends on', () => {
    expect(collectRefs(parse("${a} > 1 and selected(${b}, 'x')")).sort()).toEqual(['a', 'b']);
  });
});
