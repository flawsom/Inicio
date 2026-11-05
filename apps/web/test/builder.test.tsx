/**
 * The builder: the questions as a list, and one question's logic, over the same JSON
 * every other panel reads.
 *
 * These cases hold the transforms rather than the markup, and that is deliberate. The
 * risk in a builder is not that a button renders — it is that an edit lands in the
 * list and not in the definition the other three panels read, or that an edit which
 * makes the model inconsistent quietly disappears instead of being reported. So every
 * case goes through the same door the screen uses: a definition in, a definition out,
 * then through `readDefinition` — the guard the JSON panel itself must pass — and the
 * JSON round trip that writing the panel's text actually is.
 *
 * There is no DOM test here on purpose. A drag gesture and a click are jsdom's least
 * trustworthy territory, and `moveQuestion`/`reorderQuestion` are the functions both
 * gestures call; what a keyboard user gets is those same two functions behind buttons.
 */
import { describe, expect, it } from 'vitest';
import { validateForm, type FormDefinition, type Question } from '@inicio/engine';
import {
  addChoice,
  addGroup,
  addQuestion,
  choiceListName,
  choicesOf,
  duplicateQuestion,
  editingText,
  moveChoice,
  moveQuestion,
  questionLabel,
  readDefinition,
  removeChoice,
  removeGroup,
  removeQuestion,
  reorderQuestion,
  setChoiceLabel,
  setChoiceValue,
  setGroupLabel,
  setQuestionContent,
  setQuestionLogic,
  translationPlaceholder,
} from '../src/studio';

/** A three-question form, with one rule already written and one select to filter. */
function form(): FormDefinition {
  return {
    title: 'Pulse check',
    defaultLanguage: 'en',
    languages: ['en'],
    groups: [],
    choiceLists: {},
    questions: [
      { id: 'q_consent', name: 'consent', type: 'yesno', label: { en: 'Consent' }, required: true },
      {
        id: 'q_reason',
        name: 'reason',
        type: 'text',
        label: { en: 'Why not' },
        rules: { visibleIf: "${consent} = 'no'" },
      },
      { id: 'q_score', name: 'score', type: 'integer', label: { en: 'Score' } },
    ],
  };
}

const names = (definition: FormDefinition): string[] => definition.questions.map((question) => question.name);

/** Exactly what the screen does with an edit: serialise it into the JSON panel and read it back. */
function throughTheJsonPanel(next: FormDefinition): FormDefinition {
  const read = readDefinition(JSON.parse(JSON.stringify(next)));
  if ('problem' in read) throw new Error(`the builder produced a definition the panel would refuse: ${read.problem}`);
  return read.definition as unknown as FormDefinition;
}

describe('the builder', () => {
  it('moves a question with the buttons, and the definition every panel reads is the reordered one', () => {
    const moved = moveQuestion(form(), 'q_score', -1);
    expect(names(moved)).toEqual(['consent', 'score', 'reason']);
    expect(names(throughTheJsonPanel(moved))).toEqual(['consent', 'score', 'reason']);
    // Nothing else moved with it: a reorder is an order, not an edit.
    expect(moved.questions.find((question) => question.name === 'reason')?.rules?.visibleIf).toBe("${consent} = 'no'");
  });

  it('moves a question down, and off either end is a no-op rather than a wrap', () => {
    expect(names(moveQuestion(form(), 'q_consent', 1))).toEqual(['reason', 'consent', 'score']);
    expect(names(moveQuestion(form(), 'q_consent', -1))).toEqual(['consent', 'reason', 'score']);
    expect(names(moveQuestion(form(), 'q_score', 1))).toEqual(['consent', 'reason', 'score']);
  });

  it('drops a dragged question where its target is', () => {
    expect(names(reorderQuestion(form(), 'q_score', 'q_consent'))).toEqual(['score', 'consent', 'reason']);
    expect(names(reorderQuestion(form(), 'q_consent', 'q_score'))).toEqual(['reason', 'score', 'consent']);
    // Dropping a question on itself is not an edit.
    expect(names(reorderQuestion(form(), 'q_reason', 'q_reason'))).toEqual(['consent', 'reason', 'score']);
  });

  it('adds a question after the selected one, and at the end when none is selected', () => {
    expect(names(addQuestion(form(), 'text', null))).toEqual(['consent', 'reason', 'score', 'question']);
    const inserted = addQuestion(form(), 'integer', 'q_consent');
    expect(names(inserted)).toEqual(['consent', 'question', 'reason', 'score']);
    // The new question is renderable and analysable, not a stub the rest of the studio refuses.
    expect(validateForm(throughTheJsonPanel(inserted)).errors).toEqual([]);
  });

  it('gives a new question a name that cannot collide with an existing export column', () => {
    const twice = addQuestion(addQuestion(form(), 'text', null), 'text', null);
    expect(names(twice)).toEqual(['consent', 'reason', 'score', 'question', 'question_2']);
    expect(validateForm(twice).errors).toEqual([]);
  });

  it('removes exactly the question that was removed', () => {
    const without = removeQuestion(form(), 'q_reason');
    expect(names(without)).toEqual(['consent', 'score']);
    expect(names(throughTheJsonPanel(without))).toEqual(['consent', 'score']);
  });

  it('writes logic into the fields the engine evaluates, and clearing a field removes the rule', () => {
    const withRule = setQuestionLogic(form(), 'q_score', {
      visibleIf: '${consent} = "yes"',
      constraint: '. >= 0 and . <= 10',
      constraintMessage: 'Between 0 and 10',
    });
    const score = withRule.questions.find((question) => question.name === 'score');
    expect(score?.rules?.visibleIf).toBe('${consent} = "yes"');
    expect(score?.validation?.constraint).toBe('. >= 0 and . <= 10');
    expect(score?.validation?.message).toEqual({ en: 'Between 0 and 10' });

    const cleared = setQuestionLogic(withRule, 'q_score', { visibleIf: '   ', constraintMessage: '' });
    const after = cleared.questions.find((question) => question.name === 'score');
    // Cleared means "no rule", not a rule that matches an empty string.
    expect(after?.rules?.visibleIf).toBeUndefined();
    expect(after?.validation?.message).toBeUndefined();
    // The constraint the patch did not mention is kept: typing in one field cannot clear another.
    expect(after?.validation?.constraint).toBe('. >= 0 and . <= 10');
  });

  it('offers the choice filter on a question whose options can be filtered', () => {
    const withSelect = addQuestion(form(), 'select_one', null);
    const added = withSelect.questions[withSelect.questions.length - 1] as Question;
    const filtered = setQuestionLogic(withSelect, added.id, { choiceFilter: 'district = ${district}' });
    expect(filtered.questions.find((question) => question.id === added.id)?.rules?.choiceFilter).toBe(
      'district = ${district}',
    );
    // A select with no choice list yet is reported rather than refused: the edit is the author's.
    expect(validateForm(filtered).errors.length).toBeGreaterThan(0);
  });

  it('keeps a rule that names a question you have since removed, so the analyser can say so', () => {
    const without = throughTheJsonPanel(removeQuestion(form(), 'q_consent'));
    // The edit is kept exactly as it was made: the builder does not tidy up after an author.
    expect(without.questions.find((question) => question.name === 'reason')?.rules?.visibleIf).toBe("${consent} = 'no'");
    const report = validateForm(without);
    expect(report.errors.some((message) => message.includes('consent'))).toBe(true);
  });

  it('reads a label the way the respondent reads it, and falls back rather than showing nothing', () => {
    expect(questionLabel(form().questions[0] as Question, 'en')).toBe('Consent');
    expect(questionLabel({ id: 'q_bare', name: 'bare', type: 'text', label: {} }, 'en')).toBe('bare');
  });

  it('edits content without touching another language or a conditional requirement', () => {
    const bilingual: FormDefinition = {
      ...form(),
      languages: ['en', 'fr'],
      groups: [{ id: 'g1', name: 'admin', label: { en: 'Administration', fr: 'Administration' } }],
      questions: form().questions.map((question) =>
        question.id === 'q_reason'
          ? { ...question, required: "${consent} = 'no'", label: { en: 'Why not', fr: 'Pourquoi pas' } }
          : question,
      ),
    };
    const edited = setQuestionContent(
      bilingual,
      'q_reason',
      { name: 'why_not', label: 'Pourquoi pas ?', hint: 'Expliquez', groupId: 'g1' },
      'fr',
    );
    const reason = edited.questions.find((question) => question.id === 'q_reason') as Question;
    expect(reason.name).toBe('why_not');
    expect(reason.label).toEqual({ en: 'Why not', fr: 'Pourquoi pas ?' });
    expect(reason.hint).toEqual({ fr: 'Expliquez' });
    expect(reason.groupId).toBe('g1');
    // The conditional expression is an author decision, not a checkbox to flatten.
    expect(reason.required).toBe("${consent} = 'no'");

    const cleared = setQuestionContent(edited, 'q_reason', { label: '' }, 'fr');
    expect((cleared.questions.find((question) => question.id === 'q_reason') as Question).label).toEqual({
      en: 'Why not',
    });
    expect(editingText({ en: 'Why not' }, 'fr')).toBe('');
    expect(translationPlaceholder({ en: 'Why not' }, 'fr')).toBe('en: Why not');
  });

  it('turns a question into a choice field and edits its options in render order', () => {
    const converted = setQuestionContent(form(), 'q_reason', { type: 'select_one' });
    const reason = converted.questions.find((question) => question.id === 'q_reason') as Question;
    expect(reason.choices).toEqual({ inline: [] });
    expect(choicesOf(converted, reason)).toEqual([]);

    const one = addChoice(converted, 'q_reason');
    const two = addChoice(one, 'q_reason');
    expect(choicesOf(two, two.questions.find((question) => question.id === 'q_reason') as Question).map((choice) => [
      choice.value,
      choice.label.en,
    ])).toEqual([
      ['1', 'Option 1'],
      ['2', 'Option 2'],
    ]);

    const relabelled = setChoiceLabel(setChoiceValue(two, 'q_reason', 0, 'yes'), 'q_reason', 0, 'Yes');
    const reordered = moveChoice(relabelled, 'q_reason', 0, 1);
    const options = choicesOf(reordered, reordered.questions.find((question) => question.id === 'q_reason') as Question);
    expect(options.map((choice) => [choice.value, choice.label.en])).toEqual([
      ['2', 'Option 2'],
      ['yes', 'Yes'],
    ]);
    const removed = removeChoice(reordered, 'q_reason', 0);
    expect(choicesOf(removed, removed.questions.find((question) => question.id === 'q_reason') as Question)).toHaveLength(1);
  });

  it('edits a shared choice list once rather than copying it onto one question', () => {
    const shared: FormDefinition = {
      ...form(),
      choiceLists: { districts: [{ value: 'n', label: { en: 'North' } }] },
      questions: [
        {
          id: 'q_district',
          name: 'district',
          type: 'select_one',
          label: { en: 'District' },
          choices: { listName: 'districts' },
        },
      ],
    };
    const question = shared.questions[0] as Question;
    expect(choiceListName(question)).toBe('districts');
    expect(choicesOf(shared, question)).toEqual([{ value: 'n', label: { en: 'North' } }]);

    const added = addChoice(shared, 'q_district');
    expect(added.choiceLists.districts).toHaveLength(2);
    expect(added.questions[0]?.choices).toEqual({ listName: 'districts' });
  });

  it('duplicates a question beside itself with fresh identity and independent inline choices', () => {
    const original = duplicateQuestion(form(), 'q_consent').questions[1] as Question;
    expect(original.id).not.toBe('q_consent');
    expect(original.name).toBe('consent_copy');
    expect(original.required).toBe(true);

    const withChoices = setQuestionContent(form(), 'q_consent', { type: 'select_one' });
    const withOne = addChoice(withChoices, 'q_consent');
    const copied = duplicateQuestion(withOne, 'q_consent');
    const source = copied.questions.find((question) => question.id === 'q_consent') as Question;
    const copy = copied.questions.find((question) => question.name === 'consent_copy') as Question;
    expect(copy.choices).not.toBe(source.choices);
    expect(choicesOf(copied, copy)).toEqual(choicesOf(copied, source));
  });

  it('adds, relabels and removes a section without removing its questions', () => {
    const withSection = addGroup(form(), 'Screening');
    const group = withSection.groups[0];
    expect(group?.id).toBe('g_1');
    expect(group?.name).toBe('section');

    const second = addGroup(withSection, 'Screening');
    expect(second.groups[1]?.name).toBe('section_2');
    const assigned = setQuestionContent(second, 'q_consent', { groupId: second.groups[0]?.id ?? null });
    const relabelled = setGroupLabel(assigned, assigned.groups[0]?.id ?? '', 'Screening questions', 'en');
    expect(relabelled.groups[0]?.label.en).toBe('Screening questions');

    const removed = removeGroup(relabelled, relabelled.groups[0]?.id ?? '');
    expect(removed.groups).toHaveLength(1);
    expect(removed.questions.find((question) => question.id === 'q_consent')?.groupId).toBeNull();
    expect(removed.questions).toHaveLength(3);
  });

  it('writes enable, calculate and localized validation messages without dropping the rest of the logic', () => {
    const withRules = setQuestionLogic(
      { ...form(), languages: ['en', 'fr'] },
      'q_score',
      {
        visibleIf: '${consent} = "yes"',
        enableIf: '${consent} = "yes"',
        calculate: '${score} + 1',
        constraint: '. >= 0',
        constraintMessage: 'Pas négatif',
      },
      'fr',
    );
    const score = withRules.questions.find((question) => question.id === 'q_score') as Question;
    expect(score.rules).toMatchObject({
      visibleIf: '${consent} = "yes"',
      enableIf: '${consent} = "yes"',
      calculate: '${score} + 1',
    });
    expect(score.validation?.message).toEqual({ fr: 'Pas négatif' });

    const onlyConstraint = setQuestionLogic(withRules, 'q_score', { enableIf: '   ' }, 'fr');
    const after = onlyConstraint.questions.find((question) => question.id === 'q_score') as Question;
    expect(after.rules?.enableIf).toBeUndefined();
    expect(after.rules?.visibleIf).toBe('${consent} = "yes"');
    expect(after.validation?.constraint).toBe('. >= 0');
  });
});
