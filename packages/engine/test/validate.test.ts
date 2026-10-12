import { describe, expect, it } from 'vitest';
import { isPublishable, validateForm } from '../src/validate.js';
import type { FormDefinition } from '../src/types.js';

const base: FormDefinition = {
  title: 'Valid', defaultLanguage: 'en', languages: ['en'],
  groups: [],
  questions: [
    { id: 'q1', name: 'consent', type: 'yesno', label: { en: 'Consent' } },
    { id: 'q2', name: 'detail', type: 'text', label: { en: 'Detail' }, rules: { visibleIf: "${consent} = 'no'" } },
  ],
  choiceLists: {},
};

describe('static form validation', () => {
  it('accepts a well-formed form', () => {
    const report = validateForm(base);
    expect(report.errors).toEqual([]);
    expect(isPublishable(base)).toBe(true);
  });

  it('rejects duplicate question names (they would collide as export columns)', () => {
    const dup: FormDefinition = { ...base, questions: [...base.questions, { id: 'q3', name: 'consent', type: 'text', label: { en: 'x' } }] };
    expect(validateForm(dup).errors.join(' ')).toMatch(/Duplicate question name/);
  });

  it('allows a bare name inside choice_filter but rejects it everywhere else', () => {
    // XLSForm writes cascading selects as `state = ${state}`, where the bare name is a
    // column on the choices sheet. The same bare name in visibleIf is a typo.
    const cascading: FormDefinition = {
      ...base,
      questions: [
        { id: 'q1', name: 'state', type: 'select_one', label: { en: 'State' }, choices: { listName: 'states' } },
        {
          id: 'q2', name: 'district', type: 'select_one', label: { en: 'District' },
          choices: { listName: 'districts' },
          rules: { choiceFilter: 'state = ${state}' },
        },
      ],
      choiceLists: {
        states: [{ value: 'ka', label: { en: 'Karnataka' } }],
        districts: [{ value: 'ka_blr', label: { en: 'Bengaluru' }, extra: { state: 'ka' } }],
      },
    };
    expect(validateForm(cascading).errors).toEqual([]);

    const typo: FormDefinition = {
      ...base,
      questions: [{ id: 'q1', name: 'a', type: 'text', label: { en: 'A' }, rules: { visibleIf: 'state = 1' } }],
    };
    expect(validateForm(typo).errors.join(' ')).toMatch(/unknown bare name "state"/);

    const wrongAttribute: FormDefinition = {
      ...cascading,
      questions: [
        cascading.questions[0]!,
        { ...cascading.questions[1]!, rules: { choiceFilter: 'province = ${state}' } },
      ],
    };
    expect(validateForm(wrongAttribute).warnings.join(' ')).toMatch(/not an attribute column/);
  });

  it('rejects a reference to a question that does not exist', () => {
    const bad: FormDefinition = { ...base, questions: [{ id: 'q1', name: 'a', type: 'text', label: { en: 'A' }, rules: { visibleIf: "${ghost} = 1" } }] };
    expect(validateForm(bad).errors.join(' ')).toMatch(/unknown question or variable/);
  });

  it('rejects a question that refers to itself', () => {
    const bad: FormDefinition = { ...base, questions: [{ id: 'q1', name: 'a', type: 'text', label: { en: 'A' }, rules: { visibleIf: "${a} = 1" } }] };
    expect(validateForm(bad).errors.join(' ')).toMatch(/refers to itself/);
  });

  it('rejects an undefined choice list and invalid identifiers', () => {
    const bad: FormDefinition = {
      ...base,
      questions: [{ id: 'q1', name: 'bad name', type: 'select_one', label: { en: 'A' }, choices: { listName: 'nope' } }],
    };
    const joined = validateForm(bad).errors.join(' ');
    expect(joined).toMatch(/undefined choice list/);
    expect(joined).toMatch(/must start with a letter/);
  });

  it('reports syntax errors in expressions instead of throwing', () => {
    const bad: FormDefinition = { ...base, questions: [{ id: 'q1', name: 'a', type: 'text', label: { en: 'A' }, rules: { visibleIf: '${unclosed' } }] };
    expect(validateForm(bad).errors.join(' ')).toMatch(/Unclosed|Malformed|Unexpected/);
  });

  it('flags duplicate choice values', () => {
    const bad: FormDefinition = {
      ...base,
      questions: [{ id: 'q1', name: 'a', type: 'select_one', label: { en: 'A' }, choices: { listName: 'l' } }],
      choiceLists: { l: [{ value: 'x', label: { en: 'X' } }, { value: 'x', label: { en: 'Y' } }] },
    };
    expect(validateForm(bad).errors.join(' ')).toMatch(/duplicate value/);
  });
});
