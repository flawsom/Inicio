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
  addQuestion,
  moveQuestion,
  questionLabel,
  readDefinition,
  removeQuestion,
  reorderQuestion,
  setQuestionLogic,
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
});
