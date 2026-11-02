import { describe, expect, it } from 'vitest';
import { ExpressionError, collectRefs, parse, runExpression } from '../src/expression.js';
import { datasetContext, findCase } from '../src/datasets.js';

describe('expression language', () => {
  it('honours arithmetic precedence and parentheses', () => {
    expect(runExpression('1 + 2 * 3')).toBe(7);
    expect(runExpression('(1 + 2) * 3')).toBe(9);
    expect(runExpression('10 % 3')).toBe(1);
    expect(runExpression('10 div 3')).toBe(3);
    expect(runExpression('10 mod 3')).toBe(1);
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

  it('reads pulled data by code without caring about case, and returns null for a miss', () => {
    const datasets = datasetContext([
      {
        code: 'Cases',
        kind: 'cases',
        uniqueField: 'id',
        columns: ['id', 'head_name', 'village'],
        rows: [
          { id: 'HH-101', head_name: 'Amina', village: 'Kigoma' },
          { id: 'HH-102', head_name: 'Joseph', village: 'Mwanza' },
        ],
      },
    ]);
    expect(runExpression("pulldata('cases', 'head_name', 'id', 'HH-101')", { datasets })).toBe('Amina');
    expect(runExpression("pulldata('CASES', 'village', 'id', ${caseid})", { datasets, answers: { caseid: 'HH-102' } })).toBe('Mwanza');
    expect(runExpression("pulldata('cases', 'head_name', 'id', 'missing')", { datasets })).toBeNull();
    expect(runExpression("pulldata('cases', 'head_name', 'id', '')", { datasets })).toBeNull();
    expect(runExpression("pulldata('unknown', 'head_name', 'id', 'HH-101')", { datasets })).toBeNull();
    expect(findCase(datasets, 'HH-101')?.row.head_name).toBe('Amina');
    expect(findCase(datasets, 'HH-999')).toBeNull();
  });

  it('supports the pure SurveyCTO scripting helpers', () => {
    expect(runExpression("string(12)")).toBe('12');
    expect(runExpression("concat('a', 'b', 'c')")).toBe('abc');
    expect(runExpression("substr('abcdef', 1, 4)")).toBe('bcd');
    expect(runExpression("string-length('hello')")).toBe(5);
    expect(runExpression('linebreak()')).toBe('\n');
    expect(runExpression("selected-at(${tags}, 1)", { answers: { tags: ['a', 'b', 'c'] } })).toBe('b');
    expect(runExpression("selected-at(${tags}, 9)", { answers: { tags: ['a'] } })).toBeNull();
    expect(runExpression("join(', ', ${nums})", { answers: { nums: [1, 2, 3] } })).toBe('1, 2, 3');
    expect(runExpression("join('|', ${a}, ${b})", { answers: { a: 'x', b: 'y' } })).toBe('x|y');
    expect(runExpression("count-if(${nums}, . > 1)", { answers: { nums: [1, 2, 3] } })).toBe(2);
    expect(runExpression("sum-if(${nums}, . > 1)", { answers: { nums: [1, 2, 3] } })).toBe(5);
    expect(runExpression("join-if('|', ${nums}, . > 1)", { answers: { nums: [1, 2, 3] } })).toBe('2|3');
    expect(runExpression('empty(${a})', { answers: { a: [] } })).toBe(true);
    expect(runExpression('empty(${a})', { answers: { a: 'x' } })).toBe(false);
    expect(runExpression("choice-label(${meal}, 'v')", {
      answers: { meal: 'v' },
      choiceLabels: { meal: { v: 'Vegetarian' } },
    })).toBe('Vegetarian');
    expect(runExpression('pow(2, 5)')).toBe(32);
    expect(runExpression('sqrt(81)')).toBe(9);
    expect(runExpression('round(atan2(1, 1), 4)')).toBe(0.7854);
    expect(runExpression("format-date-time('2026-11-01T13:41:00Z', '%Y-%m-%d %H:%M')")).toBe('2026-11-01 13:41');
    expect(runExpression("date('2026-11-01T13:41:00Z')")).toBe('2026-11-01');
    expect(runExpression("date-time('2026-11-01T13:41:00Z')")).toBe('2026-11-01T13:41:00.000Z');
    expect(runExpression("format-date-time(decimal-date-time('2026-11-01T13:41:00Z'), '%Y-%m-%d')")).toBe('2026-11-01');
    expect(runExpression('round(asin(1), 4)')).toBe(1.5708);
    expect(runExpression('round(acos(0), 4)')).toBe(1.5708);
    expect(runExpression('atan(1) > 0.78 and atan(1) < 0.79')).toBe(true);
    expect(runExpression("count-items(',', 'a,b,,d')")).toBe(4);
    expect(runExpression("item-at(',', 'a,b,c', 1)")).toBe('b');
    expect(runExpression("item-at(',', 'a,b,c', 9)")).toBeNull();
    expect(runExpression("item-index(',', 'a,b,c', 'b')")).toBe(1);
    expect(runExpression("item-index(',', 'a,b,c', 'z')")).toBe(-1);
    expect(runExpression("item-present(',', 'a,b,,d', '')")).toBe(true);
    expect(runExpression("de-duplicate(' ', 'a b a c')")).toBe('a b c');
    expect(runExpression("rank-value(3, '4 2 1 9 3 7')")).toBe(4);
    expect(runExpression("short-geopoint('1.23 4.56 0 5')")).toBe('4.56 1.23');
  });

  it('reads SurveyCTO plug-in metadata without overloading the answer', () => {
    expect(runExpression("plug-in-metadata(${q6})", {
      answers: { q6: '99' },
      pluginMetadata: { q6: '99|Groundnut oil' },
    })).toBe('99|Groundnut oil');
    expect(runExpression("item-at('|', plug-in-metadata(${q6}), 1)", {
      pluginMetadata: { q6: '99|Groundnut oil' },
    })).toBe('Groundnut oil');
    expect(runExpression("coalesce(plug-in-metadata(${missing}), 'fallback')", {})).toBe('fallback');
    expect(runExpression("item-at('|', plug-in-metadata(${q6}), 1)", {})).toBeNull();
  });

  it('supports regex, device-info, duration and once without a hidden clock dependency', () => {
    expect(runExpression("regex('9876543210', '^[0-9]{10}$')")).toBe(true);
    expect(runExpression("regex('98765', '^[0-9]{10}$')")).toBe(false);
    expect(() => runExpression("regex('x', '[')")).toThrow(/invalid pattern/);
    expect(runExpression("device-info()", { deviceInfo: { brand: 'Test', sdk: 34 } })).toBe('{"brand":"Test","sdk":34}');
    expect(runExpression("device-info()", { deviceInfo: 'mounted' })).toBe('mounted');
    expect(runExpression("duration()", { startedAt: '2026-11-02T03:59:00Z', now: '2026-11-02T04:00:05Z' })).toBe(65);
    expect(runExpression("duration()", { durationSeconds: 12 })).toBe(12);
    expect(runExpression("once('drawn')")).toBe('drawn');
  });
});
