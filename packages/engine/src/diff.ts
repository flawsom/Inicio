/**
 * What changed between two versions of an instrument, in words.
 *
 * A version history is only worth having if somebody can ask "what is different
 * from the version we are collecting on?" and get an answer they can act on. The
 * two stored definitions *are* that answer: they are the bytes that were published
 * and the bytes that will be published, so a diff computed from them cannot drift
 * from what is stored the way a hand-written changelog does.
 *
 * Three rules this module holds to:
 *
 *   1. **Questions are matched by `name`, never by database id.** `name` is the
 *      export column and the answer key, so it is the thing a change is *about*;
 *      re-importing the same workbook with fresh ids is not a change at all.
 *   2. **Nothing is silently swallowed.** Every field below has a sentence, and a
 *      difference it cannot phrase still makes the two versions non-identical and
 *      is named in `notes` — reporting "identical" for two different definitions
 *      would be worse than having no diff at all.
 *   3. **A value is quoted so it stays readable.** An organiser's prompt and an
 *      expression like `${school_type} = "private"` both end up inside a sentence,
 *      so text containing a double quote is quoted with single quotes instead of
 *      producing `"… = "private""` — a sentence nobody can parse.
 *
 * It is pure and deterministic: same inputs, same sentences, same order, always.
 */

import type { Choice, FormDefinition, Group, LocalizedText, Question } from './types.js';

export interface DefinitionDiff {
  /** True when the two definitions describe the same instrument. */
  identical: boolean;
  counts: { added: number; removed: number; changed: number };
  /**
   * Every sentence, in a stable order: the instrument itself, the groups, then the
   * questions (removals, then additions, then changes), then the ordering.
   */
  changes: string[];
  /** The same sentences grouped by question, for a screen that shows detail per row. */
  questions: Array<{ name: string; kind: 'added' | 'removed' | 'changed'; details: string[] }>;
  /** Anything that made the comparison partial, and anything it could not phrase. */
  notes: string[];
}

/** Question fields that have a sentence of their own. Anything else is named in `notes`. */
const DESCRIBED_QUESTION_KEYS = new Set([
  'name',
  'type',
  'label',
  'hint',
  'required',
  'requiredMessage',
  'choices',
  'validation',
  'rules',
  'groupId',
]);

/** A question's identity here is its name, so `id` is never a difference. */
const IGNORED_QUESTION_KEYS = new Set(['id']);

const DESCRIBED_GROUP_KEYS = new Set(['name', 'label', 'repeat', 'repeatCount', 'rules']);

/* ------------------------------------------------------------------- helpers */

/** A value inside a sentence: double-quoted, or single-quoted when it holds a double quote. */
function quoted(text: string): string {
  return text.includes('"') ? `'${text}'` : `"${text}"`;
}

function asText(value: LocalizedText | null | undefined): LocalizedText {
  return value && typeof value === 'object' ? value : {};
}

function list<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asQuestions(def: FormDefinition): Question[] {
  return list<Question>(def.questions);
}

function asGroups(def: FormDefinition): Group[] {
  return list<Group>(def.groups);
}

function asLanguages(def: FormDefinition): string[] {
  return list<string>(def.languages).filter((language) => typeof language === 'string');
}

function hasQuestionList(def: FormDefinition): boolean {
  return Array.isArray(def.questions as unknown);
}

/** An expression, or null for "there is none" — an empty string is not a rule. */
function expression(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Languages to report in, in a stable order: the newer instrument's first. */
function languageOrder(base: string[], ...texts: LocalizedText[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const language of [...base, ...texts.flatMap((text) => Object.keys(text))]) {
    if (seen.has(language)) continue;
    seen.add(language);
    out.push(language);
  }
  return out;
}

/**
 * One sentence per language whose text changed, gained or was dropped.
 *
 * `subject` arrives already quoted (`"school"`) or as a phrase (`The group "admin"`),
 * so a sentence always starts with the thing being described.
 */
function textSentences(
  subject: string,
  kind: string,
  from: LocalizedText | null | undefined,
  to: LocalizedText | null | undefined,
  base: string[],
): string[] {
  const before = asText(from);
  const after = asText(to);
  const out: string[] = [];
  for (const language of languageOrder(base, before, after)) {
    const was = before[language];
    const now = after[language];
    if (was === now) continue;
    if (was !== undefined && now !== undefined) {
      out.push(`${subject} ${kind} in ${language} changed from ${quoted(was)} to ${quoted(now)}.`);
    } else if (was === undefined && now !== undefined) {
      out.push(`${subject} gained a ${language} ${kind}: ${quoted(now)}.`);
    } else if (was !== undefined) {
      out.push(`${subject} lost its ${language} ${kind} (it was ${quoted(was)}).`);
    }
  }
  return out;
}

/** Whether a question is mandatory: never, always, or when an expression holds. */
type Requirement = { kind: 'never' } | { kind: 'always' } | { kind: 'when'; expr: string };

function requirement(value: Question['required']): Requirement {
  if (value === true) return { kind: 'always' };
  const expr = expression(value);
  return expr === null ? { kind: 'never' } : { kind: 'when', expr };
}

function describeRequirement(value: Requirement): string {
  if (value.kind === 'never') return 'never';
  if (value.kind === 'always') return 'always';
  return `when:${value.expr}`;
}

function requiredSentence(name: string, from: Question['required'], to: Question['required']): string | null {
  const was = requirement(from);
  const now = requirement(to);
  if (describeRequirement(was) === describeRequirement(now)) return null;
  const subject = quoted(name);
  if (was.kind === 'never') {
    return now.kind === 'when' ? `${subject} is now mandatory when ${quoted(now.expr)}.` : `${subject} is now mandatory.`;
  }
  if (was.kind === 'always') {
    return now.kind === 'when'
      ? `${subject} is now mandatory only when ${quoted(now.expr)}.`
      : `${subject} is no longer mandatory.`;
  }
  if (now.kind === 'never') return `${subject} is no longer mandatory (it was required when ${quoted(was.expr)}).`;
  if (now.kind === 'always') {
    return `${subject} is now mandatory in every response (it was required when ${quoted(was.expr)}).`;
  }
  return `${subject} is now mandatory when ${quoted(now.expr)} instead of when ${quoted(was.expr)}.`;
}

type RuleKey = 'visibleIf' | 'enableIf' | 'calculate' | 'choiceFilter';

function ruleSentence(subject: string, rule: RuleKey, from: string | null, to: string | null): string | null {
  if (from === to) return null;
  switch (rule) {
    case 'visibleIf':
      if (to === null) return `${subject} is now always shown (it was shown only when ${quoted(from ?? '')}).`;
      if (from === null) return `${subject} is now only shown when ${quoted(to)}.`;
      return `${subject} relevance changed from ${quoted(from)} to ${quoted(to)}.`;
    case 'enableIf':
      if (to === null) return `${subject} is now always editable (it was editable only when ${quoted(from ?? '')}).`;
      if (from === null) return `${subject} is now editable only when ${quoted(to)}.`;
      return `${subject} enable rule changed from ${quoted(from)} to ${quoted(to)}.`;
    case 'calculate':
      if (to === null) return `${subject} is no longer a calculated question (it was ${quoted(from ?? '')}).`;
      if (from === null) return `${subject} is now calculated as ${quoted(to)}.`;
      return `${subject} is now calculated as ${quoted(to)} (it was ${quoted(from)}).`;
    case 'choiceFilter':
      if (to === null) return `${subject} options are no longer filtered (they were filtered by ${quoted(from ?? '')}).`;
      if (from === null) return `${subject} options are now filtered by ${quoted(to)}.`;
      return `${subject} option filter changed from ${quoted(from)} to ${quoted(to)}.`;
  }
}

function stable(value: unknown): string {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value) ?? 'undefined';
  } catch {
    // A value that cannot be serialised is compared by reference, which is the
    // honest answer: something differs and this module will not pretend otherwise.
    return String(value);
  }
}

/** Every key whose value differs, sorted, ignoring the ones identity is not made of. */
function differingKeys(
  from: Record<string, unknown>,
  to: Record<string, unknown>,
  described: Set<string>,
  ignored: Set<string>,
): string[] {
  const keys = new Set([...Object.keys(from), ...Object.keys(to)]);
  return [...keys]
    .filter((key) => !described.has(key) && !ignored.has(key))
    .filter((key) => stable(from[key]) !== stable(to[key]))
    .sort();
}

/** The options a question actually offers, wherever they were declared. */
function resolvedChoices(def: FormDefinition, question: Question): { listName: string | null; choices: Choice[] } {
  const listName = expression(question.choices?.listName);
  if (listName !== null) return { listName, choices: list<Choice>(def.choiceLists?.[listName]) };
  return { listName: null, choices: list<Choice>(question.choices?.inline) };
}

function choiceSentences(
  fromDef: FormDefinition,
  toDef: FormDefinition,
  name: string,
  previous: Question,
  current: Question,
  base: string[],
  notes: string[],
): string[] {
  const was = resolvedChoices(fromDef, previous);
  const now = resolvedChoices(toDef, current);
  const subject = quoted(name);
  const out: string[] = [];

  // A shared list that a version does not declare is a partial comparison, and the
  // absence has to be said rather than read as "the question has no options".
  if (was.listName !== null && fromDef.choiceLists?.[was.listName] === undefined) {
    notes.push(`The earlier version does not declare the option list ${quoted(was.listName)} used by ${subject}.`);
  }
  if (now.listName !== null && toDef.choiceLists?.[now.listName] === undefined) {
    notes.push(`This version does not declare the option list ${quoted(now.listName)} used by ${subject}.`);
  }

  let sourceChanged = false;
  if (was.listName !== null && now.listName !== null && was.listName !== now.listName) {
    out.push(`${subject} now takes its options from the list ${quoted(now.listName)} instead of ${quoted(was.listName)}.`);
    sourceChanged = true;
  } else if (was.listName === null && now.listName !== null) {
    out.push(
      `${subject} now takes its options from the shared list ${quoted(now.listName)} instead of options written into the question.`,
    );
    sourceChanged = true;
  } else if (was.listName !== null && now.listName === null) {
    out.push(
      `${subject} now writes its options into the question instead of taking them from the list ${quoted(was.listName)}.`,
    );
    sourceChanged = true;
  }

  if (sourceChanged) {
    // The two versions draw their options from different places, so a diff of the
    // option sets would compare one instrument's options against another's and report
    // every difference as an edit. The sentence above is the change; the options
    // themselves are described by comparing each version against its own lists.
    //
    // Said out loud only when there were options to compare and both sources are
    // declared: an undeclared list already pushes its own note a few lines up, and two
    // sentences explaining one partial comparison is noise rather than candour.
    const declared = (listName: string | null, def: FormDefinition): boolean =>
      listName === null || def.choiceLists?.[listName] !== undefined;
    if (was.choices.length + now.choices.length > 0 && declared(was.listName, fromDef) && declared(now.listName, toDef)) {
      notes.push(
        `The options of ${subject} come from a different source in each version, so their contents are not compared here.`,
      );
    }
    return out;
  }

  const before = new Map(was.choices.map((choice) => [String(choice.value), choice]));
  const after = new Map(now.choices.map((choice) => [String(choice.value), choice]));
  const added = [...after.keys()].filter((value) => !before.has(value));
  const removed = [...before.keys()].filter((value) => !after.has(value));
  if (added.length > 0 || removed.length > 0) {
    const parts: string[] = [];
    if (added.length > 0) parts.push(`added ${added.map((value) => quoted(value)).join(', ')}`);
    if (removed.length > 0) parts.push(`removed ${removed.map((value) => quoted(value)).join(', ')}`);
    out.push(`${subject} choices: ${parts.join('; ')}.`);
  }

  for (const [value, choice] of before) {
    const replacement = after.get(value);
    if (!replacement) continue;
    const choiceSubject = `${subject} choice ${quoted(value)}`;
    out.push(...textSentences(choiceSubject, 'label', choice.label, replacement.label, base));
    // The columns the canonical model does not interpret (a cascading select's parent
    // code, for one) are still part of the option, so a change to them is a change.
    if (stable(choice.extra) !== stable(replacement.extra)) {
      out.push(`${choiceSubject} extra attributes changed.`);
    }
  }

  return out;
}

/* ---------------------------------------------------------------------- diff */

export function diffDefinitions(from: FormDefinition, to: FormDefinition): DefinitionDiff {
  const notes: string[] = [];
  const instrumentLines: string[] = [];
  const removedGroupLines: string[] = [];
  const addedGroupLines: string[] = [];
  const changedGroupLines: string[] = [];
  const removedLines: string[] = [];
  const addedLines: string[] = [];
  const changedLines: string[] = [];
  const orderLines: string[] = [];
  const removedRecords: DefinitionDiff['questions'] = [];
  const addedRecords: DefinitionDiff['questions'] = [];
  const changedRecords: DefinitionDiff['questions'] = [];
  const undescribed = new Set<string>();

  const baseLanguages = [...asLanguages(to), ...asLanguages(from)];

  if (!hasQuestionList(from) || !hasQuestionList(to)) {
    notes.push('One of the two versions has no question list, so only the instrument around the questions could be compared.');
  }

  /* -- the instrument around the questions -- */

  if (from.title !== to.title) {
    instrumentLines.push(`The title changed from ${quoted(from.title)} to ${quoted(to.title)}.`);
  }
  if (from.defaultLanguage !== to.defaultLanguage) {
    instrumentLines.push(`The default language changed from ${from.defaultLanguage} to ${to.defaultLanguage}.`);
  }
  const languagesBefore = new Set(asLanguages(from));
  const languagesAfter = new Set(asLanguages(to));
  for (const language of asLanguages(from)) {
    if (!languagesAfter.has(language)) instrumentLines.push(`The language ${language} is no longer in the instrument.`);
  }
  for (const language of asLanguages(to)) {
    if (!languagesBefore.has(language)) instrumentLines.push(`The language ${language} was added to the instrument.`);
  }

  /* -- groups -- */

  const groupsBefore = new Map(asGroups(from).map((group) => [group.id, group]));
  const groupsAfter = new Map(asGroups(to).map((group) => [group.id, group]));

  for (const group of asGroups(from)) {
    if (!groupsAfter.has(group.id)) removedGroupLines.push(`Removed the group ${quoted(group.name)}.`);
  }

  for (const group of asGroups(to)) {
    const previous = groupsBefore.get(group.id);
    if (!previous) {
      addedGroupLines.push(
        group.repeat === true
          ? `Added the group ${quoted(group.name)}, which repeats once per response.`
          : `Added the group ${quoted(group.name)}.`,
      );
      continue;
    }

    const details: string[] = [];
    const subject = `The group ${quoted(group.name)}`;
    if (previous.name !== group.name) details.push(`The group ${quoted(previous.name)} is now called ${quoted(group.name)}.`);
    details.push(...textSentences(subject, 'label', previous.label, group.label, baseLanguages));
    if (previous.repeat !== group.repeat) {
      details.push(group.repeat === true ? `${subject} now repeats once per response.` : `${subject} no longer repeats.`);
    }
    const countWas = expression(previous.repeatCount);
    const countNow = expression(group.repeatCount);
    if (countWas !== countNow) {
      if (countNow === null) details.push(`${subject} no longer declares how many times it repeats.`);
      else if (countWas === null) details.push(`${subject} now repeats ${quoted(countNow)} times.`);
      else details.push(`${subject} now repeats ${quoted(countNow)} times instead of ${quoted(countWas)}.`);
    }
    for (const key of ['visibleIf', 'enableIf'] as const) {
      const sentence = ruleSentence(
        subject,
        key,
        expression((previous.rules ?? {})[key]),
        expression((group.rules ?? {})[key]),
      );
      if (sentence) details.push(sentence);
    }
    const groupUndescribed = differingKeys(
      previous as unknown as Record<string, unknown>,
      group as unknown as Record<string, unknown>,
      DESCRIBED_GROUP_KEYS,
      new Set(['id']),
    );
    if (groupUndescribed.length > 0) {
      details.push(`${subject} changed in a way this diff does not describe in words (${groupUndescribed.join(', ')}).`);
      for (const key of groupUndescribed) undescribed.add(`group ${key}`);
    }
    changedGroupLines.push(...details);
  }

  /* -- questions, matched by name -- */

  const questionsBefore = new Map<string, Question>();
  for (const question of asQuestions(from)) {
    const name = String(question.name ?? '');
    if (questionsBefore.has(name)) {
      notes.push(`Two questions are called ${quoted(name)} in the earlier version; only the first of them is compared.`);
      continue;
    }
    questionsBefore.set(name, question);
  }

  const namesAfter: string[] = [];
  for (const question of asQuestions(to)) {
    const name = String(question.name ?? '');
    if (namesAfter.includes(name)) {
      notes.push(`Two questions are called ${quoted(name)} in this version; only the first of them is compared.`);
      continue;
    }
    namesAfter.push(name);

    const previous = questionsBefore.get(name);
    if (!previous) {
      const details = [`Added question ${quoted(name)} (${String(question.type ?? '')}).`];
      addedLines.push(...details);
      addedRecords.push({ name, kind: 'added', details });
      continue;
    }

    const details: string[] = [];
    const subject = quoted(name);

    if (previous.type !== question.type) details.push(`${subject} is now ${question.type} instead of ${previous.type}.`);
    details.push(...textSentences(subject, 'label', previous.label, question.label, baseLanguages));
    details.push(...textSentences(subject, 'hint', previous.hint, question.hint, baseLanguages));

    const required = requiredSentence(name, previous.required, question.required);
    if (required) details.push(required);
    details.push(...textSentences(subject, 'required message', previous.requiredMessage, question.requiredMessage, baseLanguages));
    details.push(...choiceSentences(from, to, name, previous, question, baseLanguages, notes));

    const constraintWas = expression(previous.validation?.constraint);
    const constraintNow = expression(question.validation?.constraint);
    if (constraintWas !== constraintNow) {
      if (constraintNow === null) details.push(`${subject} no longer has a validation rule (it was ${quoted(constraintWas ?? '')}).`);
      else if (constraintWas === null) details.push(`${subject} must now satisfy ${quoted(constraintNow)}.`);
      else details.push(`${subject} must now satisfy ${quoted(constraintNow)} instead of ${quoted(constraintWas)}.`);
    }
    details.push(...textSentences(subject, 'validation message', previous.validation?.message, question.validation?.message, baseLanguages));

    for (const key of ['visibleIf', 'enableIf', 'calculate', 'choiceFilter'] as const) {
      const sentence = ruleSentence(subject, key, expression((previous.rules ?? {})[key]), expression((question.rules ?? {})[key]));
      if (sentence) details.push(sentence);
    }

    const groupWas = previous.groupId ?? null;
    const groupNow = question.groupId ?? null;
    if (groupWas !== groupNow) {
      const nameOf = (def: FormDefinition, id: string | null): string | null => {
        if (id === null) return null;
        const group = asGroups(def).find((candidate) => candidate.id === id);
        return group ? group.name : id;
      };
      const wasIn = nameOf(from, groupWas);
      const nowIn = nameOf(to, groupNow);
      if (wasIn === null && nowIn !== null) details.push(`${subject} moved into the group ${quoted(nowIn)}.`);
      else if (wasIn !== null && nowIn === null) details.push(`${subject} is no longer inside a group (it was in ${quoted(wasIn)}).`);
      else if (wasIn !== null && nowIn !== null) details.push(`${subject} moved from the group ${quoted(wasIn)} to ${quoted(nowIn)}.`);
    }

    const questionUndescribed = differingKeys(
      previous as unknown as Record<string, unknown>,
      question as unknown as Record<string, unknown>,
      DESCRIBED_QUESTION_KEYS,
      IGNORED_QUESTION_KEYS,
    );
    if (questionUndescribed.length > 0) {
      details.push(`${subject} also changed in a way this diff does not describe in words (${questionUndescribed.join(', ')}).`);
      for (const key of questionUndescribed) undescribed.add(key);
    }

    if (details.length > 0) {
      changedLines.push(...details);
      changedRecords.push({ name, kind: 'changed', details });
    }
  }

  const namesAfterSet = new Set(namesAfter);
  const reportedRemovals = new Set<string>();
  for (const question of asQuestions(from)) {
    const name = String(question.name ?? '');
    if (namesAfterSet.has(name) || reportedRemovals.has(name)) continue;
    reportedRemovals.add(name);
    const details = [`Removed question ${quoted(name)}.`];
    removedLines.push(...details);
    removedRecords.push({ name, kind: 'removed', details });
  }

  /* -- ordering, and what made the comparison partial -- */

  // Only the first of any duplicated name counts on either side, so a question
  // someone accidentally added twice is not mistaken for a reordering.
  const commonFrom: string[] = [];
  const seenCommon = new Set<string>();
  for (const name of asQuestions(from).map((question) => String(question.name ?? ''))) {
    if (!namesAfterSet.has(name) || seenCommon.has(name)) continue;
    seenCommon.add(name);
    commonFrom.push(name);
  }
  const commonTo = namesAfter.filter((name) => questionsBefore.has(name));
  if (commonFrom.length > 1 && commonFrom.join('\u0000') !== commonTo.join('\u0000')) {
    orderLines.push('The questions were reordered.');
  }

  const fromCount = asQuestions(from).length;
  const toCount = asQuestions(to).length;
  if (fromCount === 0 && toCount > 0) notes.push('The earlier version had no questions, so every question is new.');
  if (toCount === 0 && fromCount > 0) notes.push('This version has no questions, so every question was removed.');
  if (undescribed.size > 0) {
    notes.push(
      `Some differences are real but are not described in words: ${[...undescribed].sort().join(', ')}. The two versions are not identical.`,
    );
  }

  const changes = [
    ...instrumentLines,
    ...removedGroupLines,
    ...addedGroupLines,
    ...changedGroupLines,
    ...removedLines,
    ...addedLines,
    ...changedLines,
    ...orderLines,
  ];

  return {
    identical: changes.length === 0,
    counts: { added: addedRecords.length, removed: removedRecords.length, changed: changedRecords.length },
    changes,
    questions: [...removedRecords, ...addedRecords, ...changedRecords],
    notes,
  };
}
