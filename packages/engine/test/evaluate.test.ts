import { describe, expect, it } from 'vitest';
import { datasetContext } from '../src/datasets.js';
import { evaluateForm, filterChoices, orderChoices, randomizedAppearance, otherSpecifyCode } from '../src/evaluate.js';
import type { FormDefinition, Question } from '../src/types.js';

function q(partial: Partial<Question> & Pick<Question, 'name' | 'type'>): Question {
  return { id: partial.id ?? `q_${partial.name}`, label: { en: partial.name }, ...partial };
}

const form = (questions: Question[], extra: Partial<FormDefinition> = {}): FormDefinition => ({
  title: 'T', defaultLanguage: 'en', languages: ['en'],
  groups: [], questions, choiceLists: {}, ...extra,
});

describe('form evaluation', () => {
  it('hides a question whose visibleIf is false and nulls its answer', () => {
    const def = form([
      q({ name: 'consent', type: 'yesno' }),
      q({ name: 'reason', type: 'text', rules: { visibleIf: "${consent} = 'no'" } }),
    ]);
    const shown = evaluateForm(def, { consent: 'no', reason: 'because' });
    expect(shown.states['reason']!.visible).toBe(true);
    expect(shown.states['reason']!.value).toBe('because');

    const hidden = evaluateForm(def, { consent: 'yes', reason: 'because' });
    expect(hidden.states['reason']!.visible).toBe(false);
    expect(hidden.states['reason']!.value).toBeNull();
    expect(hidden.visibleNames).toEqual(['consent']);
  });

  it('a hidden group hides every question inside it', () => {
    const def: FormDefinition = {
      title: 'T', defaultLanguage: 'en', languages: ['en'], choiceLists: {},
      groups: [{ id: 'g_fin', name: 'finance', label: { en: 'Finance' }, rules: { visibleIf: "${has_finance} = 'yes'" } }],
      questions: [
        q({ name: 'has_finance', type: 'yesno' }),
        q({ name: 'budget', type: 'decimal', groupId: 'g_fin' }),
      ],
    };
    expect(evaluateForm(def, { has_finance: 'no', budget: 5 }).states['budget']!.visible).toBe(false);
    expect(evaluateForm(def, { has_finance: 'yes', budget: 5 }).states['budget']!.visible).toBe(true);
  });

  it('computes calculations and lets one calculation depend on another', () => {
    const def = form([
      q({ name: 'a', type: 'decimal' }),
      q({ name: 'b', type: 'decimal' }),
      q({ name: 'total', type: 'calculate', rules: { calculate: '${a} + ${b}' } }),
      q({ name: 'with_tax', type: 'calculate', rules: { calculate: 'round(${total} * 1.18, 2)' } }),
    ]);
    const res = evaluateForm(def, { a: 100, b: 50 });
    expect(res.states['total']!.value).toBe(150);
    expect(res.states['with_tax']!.value).toBe(177);
    expect(res.states['total']!.computed).toBe(true);
  });

  it('evaluates a conditional required as an expression', () => {
    const def = form([
      q({ name: 'consent', type: 'yesno' }),
      q({ name: 'reason', type: 'text', required: "${consent} = 'no'" }),
    ]);
    expect(evaluateForm(def, { consent: 'no' }).missing).toEqual(['reason']);
    expect(evaluateForm(def, { consent: 'yes' }).missing).toEqual([]);
    expect(evaluateForm(def, { consent: 'no', reason: 'x' }).missing).toEqual([]);
  });

  it('does not evaluate a constraint against a blank answer', () => {
    const def = form([q({ name: 'age', type: 'integer', validation: { constraint: '. >= 18', message: { en: 'Must be 18+' } } })]);
    expect(evaluateForm(def, { age: '' }).states['age']!.error).toBeNull();
    expect(evaluateForm(def, { age: 20 }).states['age']!.error).toBeNull();
    expect(evaluateForm(def, { age: 12 }).states['age']!.error).toBe('Must be 18+');
    expect(evaluateForm(def, { age: 12 }).invalid).toEqual(['age']);
  });

  it('treats an empty multi-select as missing when required', () => {
    const def = form([q({ name: 'langs', type: 'select_multiple', required: true })]);
    expect(evaluateForm(def, { langs: [] }).missing).toEqual(['langs']);
    expect(evaluateForm(def, { langs: ['en'] }).missing).toEqual([]);
  });

  it('never requires a note', () => {
    const def = form([q({ name: 'info', type: 'note', required: true })]);
    const res = evaluateForm(def, {});
    expect(res.missing).toEqual([]);
    expect(res.states['info']!.required).toBe(false);
  });

  it('keeps a once() calculation at its first value across evaluations', () => {
    const def = form([
      q({ name: 'a', type: 'integer' }),
      q({ name: 'draw', type: 'calculate', rules: { calculate: 'once(${a} * 2)' } }),
    ]);
    const onceValues: Record<string, unknown> = {};
    expect(evaluateForm(def, { a: 1 }, { onceValues }).states['draw']!.value).toBe(2);
    expect(evaluateForm(def, { a: 5 }, { onceValues }).states['draw']!.value).toBe(2);
    // Without a store the expression is still evaluated, which is the behaviour a
    // preview needs; persistence is the caller's promise, not the engine's.
    expect(evaluateForm(def, { a: 5 }).states['draw']!.value).toBe(10);
  });

  it('marks a visible-but-read-only question via enableIf', () => {
    const def = form([
      q({ name: 'mode', type: 'text' }),
      q({ name: 'locked', type: 'text', rules: { enableIf: "${mode} = 'edit'" } }),
    ]);
    expect(evaluateForm(def, { mode: 'view' }).states['locked']!.enabled).toBe(false);
    expect(evaluateForm(def, { mode: 'edit' }).states['locked']!.enabled).toBe(true);
  });
});

describe('cascading selects (choice_filter)', () => {
  const def = form(
    [
      q({ name: 'state', type: 'select_one', choices: { listName: 'states' } }),
      q({
        name: 'district',
        type: 'select_one',
        choices: { listName: 'districts' },
        rules: { choiceFilter: 'state = ${state}' },
      }),
    ],
    {
      choiceLists: {
        states: [
          { value: 'ka', label: { en: 'Karnataka' } },
          { value: 'mh', label: { en: 'Maharashtra' } },
        ],
        districts: [
          { value: 'ka_blr', label: { en: 'Bengaluru' }, extra: { state: 'ka' } },
          { value: 'mh_pun', label: { en: 'Pune' }, extra: { state: 'mh' } },
          { value: 'unknown', label: { en: 'No attribute' } },
        ],
      },
    },
  );

  it('keeps only the options whose attribute matches the answered question', () => {
    expect(filterChoices(def, def.questions[1]!, { state: 'ka' }).map((c) => c.value)).toEqual(['ka_blr']);
    expect(filterChoices(def, def.questions[1]!, { state: 'mh' }).map((c) => c.value)).toEqual(['mh_pun']);
  });

  it('follows XPath blank-equals-blank: an option missing the attribute still passes', () => {
    // `'' = ''` is true in XPath, and XLSForm inherits that. So an unanswered
    // controlling question does NOT hide options that lack the attribute column — which
    // is exactly why a cascading select needs every option to carry a value for it.
    expect(filterChoices(def, def.questions[1]!, {}).map((c) => c.value)).toEqual(['unknown']);
  });

  it('returns the whole list when the question has no filter', () => {
    expect(filterChoices(def, def.questions[0]!, {}).map((c) => c.value)).toEqual(['ka', 'mh']);
  });
});

describe('SurveyCTO appearances', () => {
  const question = q({
    name: 'brands',
    type: 'select_one',
    choices: { listName: 'brands' },
    appearance: "randomized(0,2) custom-specify-other(other='99')",
  });
  const choices = [
    { value: 'a', label: { en: 'Alpha' } },
    { value: 'b', label: { en: 'Beta' } },
    { value: 'c', label: { en: 'Gamma' } },
    { value: '98', label: { en: 'Other' } },
    { value: '99', label: { en: 'None' } },
  ];

  it('parses the randomized anchor count and the other code', () => {
    expect(randomizedAppearance(question)).toEqual({ anchors: 2 });
    expect(otherSpecifyCode(question)).toBe('99');
  });

  it('shuffles only the free options and keeps the anchors at the end', () => {
    const left = orderChoices(choices, question, 7).map((choice) => choice.value);
    const right = orderChoices(choices, question, 7).map((choice) => choice.value);
    expect(left).toEqual(right);
    expect(left.slice(-2)).toEqual(['98', '99']);
    expect(left.slice(0, 3).sort()).toEqual(['a', 'b', 'c']);
    expect(orderChoices(choices, question).map((choice) => choice.value)).toEqual(['a', 'b', 'c', '98', '99']);
  });

  it('applies the shuffle after a choice_filter has narrowed the list', () => {
    const def = form([
      q({ name: 'state', type: 'select_one' }),
      q({ name: 'district', type: 'select_one', choices: { listName: 'districts' }, appearance: 'randomized(0,1)', rules: { choiceFilter: 'state = ${state}' } }),
    ], {
      choiceLists: {
        districts: [
          { value: 'a', label: { en: 'A' }, extra: { state: 'ka' } },
          { value: 'b', label: { en: 'B' }, extra: { state: 'ka' } },
          { value: 'c', label: { en: 'C' }, extra: { state: 'ka' } },
          { value: 'x', label: { en: 'X' }, extra: { state: 'mh' } },
          { value: 'z', label: { en: 'Z' }, extra: { state: 'ka' } },
        ],
      },
    });
    const result = filterChoices(def, def.questions[1]!, { state: 'ka' }, { randomSeed: 3 }).map((choice) => choice.value);
    expect(result.slice(-1)).toEqual(['z']);
    expect(result.slice(0, -1).sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('dynamic choice lists (search)', () => {
  const def = form(
    [
      q({ name: 'search_text', type: 'text' }),
      q({
        name: 'person',
        type: 'select_one',
        appearance: "quick search('people', 'contains', 'name', ${search_text})",
        choices: { listName: 'people' },
      }),
    ],
    {
      choiceLists: {
        people: [{ value: 'person_id', label: { en: 'name' }, extra: { image: 'photo' } }],
      },
    },
  );
  const datasets = datasetContext([
    {
      code: 'people',
      uniqueField: 'person_id',
      columns: ['person_id', 'name', 'village', 'sortby', 'photo'],
      rows: [
        { person_id: 'p2', name: 'Joseph', village: 'Mwanza', sortby: 2, photo: 'j.jpg' },
        { person_id: 'p1', name: 'Amina', village: 'Kigoma', sortby: 1, photo: 'a.jpg' },
        { person_id: 'p3', name: 'Amina', village: 'Kigoma', sortby: 3, photo: 'a2.jpg' },
      ],
    },
  ]);

  it('loads rows from the named dataset and uses the placeholder columns', () => {
    const choices = filterChoices(def, def.questions[1]!, { search_text: 'am' }, { datasets });
    expect(choices.map((choice) => choice.value)).toEqual(['p1', 'p3']);
    expect(choices[0]).toMatchObject({ label: { en: 'Amina' }, image: 'a.jpg' });
  });

  it('supports startswith, endswith, matches and the extra exact filter', () => {
    const question = def.questions[1]!;
    const withAppearance = (appearance: string): Question => ({ ...question, appearance });
    expect(filterChoices(def, withAppearance("search('people', 'startswith', 'name', ${search_text})"), { search_text: 'Jo' }, { datasets })
      .map((choice) => choice.value)).toEqual(['p2']);
    expect(filterChoices(def, withAppearance("search('people', 'endswith', 'name', ${search_text})"), { search_text: 'mina' }, { datasets })
      .map((choice) => choice.value)).toEqual(['p1', 'p3']);
    expect(filterChoices(def, withAppearance("search('people', 'matches', 'name', ${search_text})"), { search_text: 'Joseph' }, { datasets })
      .map((choice) => choice.value)).toEqual(['p2']);
    expect(filterChoices(
      def,
      withAppearance("search('people', 'contains', 'name', ${search_text}, 'village', 'Kigoma')"),
      { search_text: '' },
      { datasets },
    ).map((choice) => choice.value)).toEqual(['p1', 'p3']);
  });

  it('returns no choices for a blank dataset or a search with no matches', () => {
    expect(filterChoices(def, def.questions[1]!, { search_text: 'zzz' }, { datasets })).toEqual([]);
    expect(filterChoices(def, def.questions[1]!, { search_text: '' }, {})).toEqual([]);
  });
});
