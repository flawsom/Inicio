import { useEffect, useMemo, useRef, useState } from 'react';
import {
  validateForm,
  xlsFormSheets,
  type AdapterNote,
  type Choice,
  type FormDefinition,
  type Group,
  type OutSheet,
  type Question,
  type QuestionRules,
  type QuestionType,
  type ValidationReport,
} from '@inicio/engine';
import { ApiError, api, download, type Definition, type VersionSummary } from './api';
import { RespondentForm } from './respondent';

/**
 * The definition studio: one definition, three live views of it.
 *
 * The three panels are not three screens. They are the same parsed object, read
 * three ways, and they are live while you type because there is nothing to wait for
 * that is not already here:
 *
 *   1. **JSON** — the source. It is what the API stores, so it is the thing that is
 *      edited; the analyser under it runs on every keystroke, not on save, because
 *      "publish-blocking" is only useful as a warning at the moment you are typing
 *      the mistake.
 *   2. **XLSForm** — the six tabs the export writes, from `xlsFormSheets`, which
 *      is the function `exportXlsForm` zips. The panel and the downloaded file are
 *      therefore the same rows by construction; a viewer built on a second
 *      implementation of the export would eventually show something the file does not
 *      contain.
 *   3. **The form itself** — rendered by `./respondent`, the component the collection
 *      page uses. This is what a respondent sees when the link is opened, evaluated
 *      by the engine that also re-checks every submission on the server.
 *
 * Nothing on this screen is a fixture. The definition comes from the version being
 * edited, the sheets come from that definition, and the preview answers live in this
 * component and are never sent anywhere — the submit button is present and disabled,
 * because a preview that could write a response is not a preview.
 *
 * The **builder** below the JSON is not a fourth definition. It is a list and a
 * handful of fields over the *same* text: every edit it makes is serialised back into
 * the JSON panel, so the panels below repaint for the same reason they repaint when
 * you type. That is the only property that matters here — a builder holding its own
 * copy of the form is a builder that can disagree with the thing it is editing.
 *
 * It also refuses to be clever. An edit that makes the model inconsistent (a rule
 * naming a question you just removed, a select with no choices yet) is *kept*, and
 * the analyser under the JSON reports it: silently repairing an author's mistake
 * hides the mistake, which is the failure mode this whole console is built against.
 */

/* ------------------------------------------------------------------- the guard */

/**
 * Enough of a definition to render, or a sentence saying what is missing.
 *
 * The JSON panel is a textarea, so for most keystrokes the text is not a form at all
 * — half an array, a trailing comma, an object with the wrong key. Throwing there
 * would take the whole console down with a React error boundary, and showing a stale
 * definition would be the sort of quiet lie this codebase keeps removing. So a value
 * has to *earn* the right to be rendered by the panels below, and until it does, the
 * status line says what it is instead.
 */
export function readDefinition(value: unknown): { definition: Definition } | { problem: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { problem: 'the JSON parses, but a form definition is an object' };
  }
  const candidate = value as Partial<FormDefinition> & { questions?: unknown; groups?: unknown };
  if (typeof candidate.title !== 'string' || candidate.title.trim() === '') {
    return { problem: 'the JSON parses, but this object has no `title`' };
  }
  if (!Array.isArray(candidate.questions)) {
    return { problem: 'the JSON parses, but `questions` is not an array' };
  }
  if (candidate.groups !== undefined && !Array.isArray(candidate.groups)) {
    return { problem: 'the JSON parses, but `groups` is not an array' };
  }
  // The canonical model requires `groups`, `languages` and `choiceLists`; a definition
  // read from this editor always has them, and a hand-written one may not.
  const filled: FormDefinition = {
    ...(candidate as FormDefinition),
    defaultLanguage: typeof candidate.defaultLanguage === 'string' ? candidate.defaultLanguage : 'en',
    languages: Array.isArray(candidate.languages) ? candidate.languages : ['en'],
    groups: Array.isArray(candidate.groups) ? candidate.groups : [],
    choiceLists:
      candidate.choiceLists !== null && typeof candidate.choiceLists === 'object'
        ? (candidate.choiceLists as FormDefinition['choiceLists'])
        : {},
  };
  return { definition: filled as unknown as Definition };
}

/**
 * What the panels are drawn from: a definition that has earned the right to be
 * rendered, or the sentence that says why it has not.
 */
type Live =
  | { ok: true; definition: Definition; report: ValidationReport; sheets: OutSheet[]; notes: AdapterNote[] }
  | { ok: false; problem: string };

/* -------------------------------------------------------------------- panels */

const PANEL = {
  json: 'Definition',
  xlsform: 'XLSForm',
  preview: 'Preview',
} as const;

/** Formula cells carry both the formula and its last value; the tab shows the value. */
function cellText(cell: OutSheet['rows'][number][number]): string {
  if (cell === null || cell === undefined) return '';
  if (typeof cell === 'object') return String(cell.cached);
  return String(cell);
}

function SheetTable({ sheet }: { sheet: OutSheet }): JSX.Element {
  const [header, ...rows] = sheet.rows;
  const columns = header ?? [];
  if (columns.length === 0) {
    return <p className="muted small">This sheet is empty.</p>;
  }
  return (
    <div className="sheet-scroll">
      <table className="sheet">
        <thead>
          <tr>
            {columns.map((cell, index) => (
              <th key={index} scope="col">
                {cellText(cell) === '' ? <span className="muted">·</span> : cellText(cell)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {columns.map((_, columnIndex) => {
                const cell = row[columnIndex];
                const isFormula = typeof cell === 'object' && cell !== null && 'formula' in cell;
                return (
                  <td key={columnIndex} className={isFormula ? 'formula-cell' : undefined}>
                    {cellText(cell)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p className="muted small">Only a header row so far.</p>}
    </div>
  );
}

/* ------------------------------------------------------------------- the builder */

/**
 * The types the builder offers, in the order a form is usually written.
 *
 * The list now covers every editable canonical type. Audit fields are not here: they
 * are a `calculate` carrying an `audit` descriptor, and that descriptor is a
 * workbook-level concern the JSON keeps. The builder never invents an audit field,
 * but it carries one untouched when a question is edited around it.
 */
export const BUILDER_TYPES: readonly QuestionType[] = [
  'text',
  'textarea',
  'integer',
  'decimal',
  'percentage',
  'currency',
  'date',
  'datetime',
  'time',
  'yesno',
  'select_one',
  'select_multiple',
  'rank',
  'enumerator',
  'geopoint',
  'geotrace',
  'geoshape',
  'image',
  'audio',
  'video',
  'file',
  'barcode',
  'note',
  'calculate',
];

/** Empty means "no rule", not a rule that matches an empty string. */
function blank(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.trim() === '' ? null : value;
}

/** A name no other question holds: it is the export column, so a collision is an error. */
function uniqueName(form: FormDefinition, base: string): string {
  const taken = new Set(form.questions.map((question) => question.name));
  if (!taken.has(base)) return base;
  let index = 2;
  while (taken.has(`${base}_${index}`)) index += 1;
  return `${base}_${index}`;
}

function uniqueId(form: FormDefinition): string {
  const taken = new Set(form.questions.map((question) => question.id));
  let index = form.questions.length + 1;
  while (taken.has(`q_${index}`)) index += 1;
  return `q_${index}`;
}

/** The label in the form's own language, falling back the way the respondent's form does. */
export function questionLabel(question: Question, language: string): string {
  return question.label?.[language] ?? Object.values(question.label ?? {})[0] ?? question.name;
}

/**
 * Add a question of `type`, after `afterId` when one is named and at the end otherwise.
 *
 * The name is derived from the type rather than numbered blindly, because the name is
 * the export column and an author who adds a question wants a column they can read.
 */
export function addQuestion(form: FormDefinition, type: QuestionType, afterId?: string | null): FormDefinition {
  const base = type === 'note' || type === 'calculate' ? type : 'question';
  const question: Question = {
    id: uniqueId(form),
    name: uniqueName(form, base),
    type,
    label: { [form.defaultLanguage]: type === 'note' ? 'A note' : 'Untitled question' },
    required: false,
  };
  const at = afterId ? form.questions.findIndex((question) => question.id === afterId) : -1;
  const questions = [...form.questions];
  questions.splice(at === -1 ? questions.length : at + 1, 0, question);
  return { ...form, questions };
}

export function removeQuestion(form: FormDefinition, questionId: string): FormDefinition {
  return { ...form, questions: form.questions.filter((question) => question.id !== questionId) };
}

/** Swap with the neighbour `delta` places away. A move off either end changes nothing. */
export function moveQuestion(form: FormDefinition, questionId: string, delta: number): FormDefinition {
  const from = form.questions.findIndex((question) => question.id === questionId);
  const to = from + delta;
  if (from === -1 || to < 0 || to >= form.questions.length) return form;
  const questions = [...form.questions];
  const [moved] = questions.splice(from, 1);
  if (!moved) return form;
  questions.splice(to, 0, moved);
  return { ...form, questions };
}

/** The drag gesture: take the question that was dragged and drop it where this one is. */
export function reorderQuestion(form: FormDefinition, fromId: string, toId: string): FormDefinition {
  const from = form.questions.findIndex((question) => question.id === fromId);
  const to = form.questions.findIndex((question) => question.id === toId);
  if (from === -1 || to === -1 || from === to) return form;
  const questions = [...form.questions];
  const [moved] = questions.splice(from, 1);
  if (!moved) return form;
  questions.splice(to, 0, moved);
  return { ...form, questions };
}

/** One question's logic, as the engine's own fields name it. */
export interface QuestionLogicPatch {
  visibleIf?: string | null;
  enableIf?: string | null;
  calculate?: string | null;
  choiceFilter?: string | null;
  constraint?: string | null;
  constraintMessage?: string | null;
}

/**
 * Write one question's logic.
 *
 * Every value here is a string the expression engine parses; this function never
 * checks one. Two properties are deliberate: a field omitted from the patch keeps
 * whatever it had, so typing in one input cannot clear another; and a field cleared
 * to an empty string becomes `null` and then disappears, so "no rule" is stored as
 * no rule rather than as an expression that evaluates to nothing.
 *
 * `enableIf` and `calculate` moved into this patch when the builder exposed them.
 * They are still carried for a caller that does not mention them, because a control
 * appearing on screen must not quietly erase a rule it has not been asked about.
 */
export function setQuestionLogic(
  form: FormDefinition,
  questionId: string,
  patch: QuestionLogicPatch,
  language = form.defaultLanguage,
): FormDefinition {
  return {
    ...form,
    questions: form.questions.map((question) => {
      if (question.id !== questionId) return question;

      const existing = question.rules ?? {};
      const visibleIf = patch.visibleIf === undefined ? blank(existing.visibleIf) : blank(patch.visibleIf);
      const enableIf = patch.enableIf === undefined ? blank(existing.enableIf) : blank(patch.enableIf);
      const calculate = patch.calculate === undefined ? blank(existing.calculate) : blank(patch.calculate);
      const choiceFilter = patch.choiceFilter === undefined ? blank(existing.choiceFilter) : blank(patch.choiceFilter);
      const rules: QuestionRules = {};
      if (visibleIf) rules.visibleIf = visibleIf;
      if (enableIf) rules.enableIf = enableIf;
      if (calculate) rules.calculate = calculate;
      if (choiceFilter) rules.choiceFilter = choiceFilter;

      const constraint = patch.constraint === undefined ? blank(question.validation?.constraint) : blank(patch.constraint);
      const message = { ...(question.validation?.message ?? {}) };
      if (patch.constraintMessage !== undefined) {
        const text = blank(patch.constraintMessage);
        if (text) message[language] = text;
        else delete message[language];
      }
      const hasMessage = Object.keys(message).length > 0;
      const validation = constraint || hasMessage ? { constraint, ...(hasMessage ? { message } : {}) } : null;

      const next: Question = { ...question, validation };
      if (Object.keys(rules).length > 0) next.rules = rules;
      else delete next.rules;
      return next;
    }),
  };
}

/** The choice questions whose options can be filtered, so the editor offers that field only there. */
function canFilterChoices(type: QuestionType): boolean {
  return type === 'select_one' || type === 'select_multiple' || type === 'rank';
}

function hasChoices(type: QuestionType): boolean {
  return canFilterChoices(type);
}

function isInput(type: QuestionType): boolean {
  return type !== 'note' && type !== 'calculate';
}

/** One localized string written without dropping the other languages. */
function withLocalized(existing: Record<string, string> | undefined, language: string, value: string): Record<string, string> {
  const next = { ...(existing ?? {}) };
  if (value.trim() === '') delete next[language];
  else next[language] = value;
  return next;
}

function withoutEmptyLocalized(existing: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!existing || Object.keys(existing).length === 0) return undefined;
  return existing;
}

/** What a field should show while editing a translation: blank, not another language's text. */
export function editingText(existing: Record<string, string> | undefined, language: string): string {
  return existing?.[language] ?? '';
}

/** A placeholder that names the text already written, without pretending it is this language. */
export function translationPlaceholder(existing: Record<string, string> | undefined, language: string): string {
  if (!existing) return '';
  const other = Object.entries(existing).find(([key, value]) => key !== language && value.trim() !== '');
  return other ? `${other[0]}: ${other[1]}` : '';
}

/**
 * The authoring fields on a question, separate from its logic.
 *
 * The builder writes only what it was asked to write. A patch that names `label`
 * leaves the hint alone; changing a language does not copy the default text into it;
 * and `required` is a boolean here because a conditional requirement is an expression
 * and belongs in the JSON until the builder can edit it without replacing it.
 */
export interface QuestionContentPatch {
  name?: string;
  type?: QuestionType;
  label?: string;
  hint?: string | null;
  required?: boolean;
  groupId?: string | null;
  requiredMessage?: string | null;
}

export function setQuestionContent(
  form: FormDefinition,
  questionId: string,
  patch: QuestionContentPatch,
  language = form.defaultLanguage,
): FormDefinition {
  return {
    ...form,
    questions: form.questions.map((question) => {
      if (question.id !== questionId) return question;
      const next: Question = { ...question };

      if (patch.name !== undefined) next.name = patch.name;
      if (patch.groupId !== undefined) next.groupId = patch.groupId;
      if (patch.required !== undefined) next.required = patch.required;
      if (patch.type !== undefined && patch.type !== question.type) {
        next.type = patch.type;
        // Switching to a choice type gives the options editor a list to edit. It is
        // empty, not pre-filled with invented answers: the analyser reports that the
        // choices are missing, and the author decides what belongs there.
        if (hasChoices(patch.type) && !next.choices) next.choices = { inline: [] };
      }
      if (patch.label !== undefined) next.label = withLocalized(question.label, language, patch.label);
      if (patch.hint !== undefined) {
        const hint = withoutEmptyLocalized(withLocalized(question.hint, language, patch.hint ?? ''));
        if (hint) next.hint = hint;
        else delete next.hint;
      }
      if (patch.requiredMessage !== undefined) {
        const message = withoutEmptyLocalized(
          withLocalized(question.requiredMessage, language, patch.requiredMessage ?? ''),
        );
        if (message) next.requiredMessage = message;
        else delete next.requiredMessage;
      }
      return next;
    }),
  };
}

/** Duplicate a question beside itself, with an id and export column that cannot collide. */
export function duplicateQuestion(form: FormDefinition, questionId: string): FormDefinition {
  const at = form.questions.findIndex((question) => question.id === questionId);
  if (at === -1) return form;
  const original = form.questions[at];
  if (!original) return form;

  const copy = JSON.parse(JSON.stringify(original)) as Question;
  copy.id = uniqueId(form);
  copy.name = uniqueName(form, original.name ? `${original.name}_copy` : 'question');
  const questions = [...form.questions];
  questions.splice(at + 1, 0, copy);
  return { ...form, questions };
}

/** The options a choice question actually renders, whether they are inline or shared. */
export function choicesOf(form: FormDefinition, question: Question): Choice[] {
  const listName = question.choices?.listName;
  if (listName) return form.choiceLists?.[listName] ?? [];
  return question.choices?.inline ?? [];
}

/** The shared-list name, when editing one choice edits more than this question. */
export function choiceListName(question: Question): string | null {
  return question.choices?.listName ?? null;
}

function withChoices(
  form: FormDefinition,
  questionId: string,
  change: (choices: Choice[]) => Choice[],
): FormDefinition {
  const question = form.questions.find((entry) => entry.id === questionId);
  if (!question) return form;
  const listName = question.choices?.listName;
  if (listName) {
    const current = form.choiceLists?.[listName] ?? [];
    return {
      ...form,
      choiceLists: { ...(form.choiceLists ?? {}), [listName]: change([...current]) },
    };
  }
  return {
    ...form,
    questions: form.questions.map((entry) => {
      if (entry.id !== questionId) return entry;
      return {
        ...entry,
        choices: { ...(entry.choices ?? {}), inline: change([...(entry.choices?.inline ?? [])]) },
      };
    }),
  };
}

function uniqueChoiceValue(choices: Choice[]): string {
  const taken = new Set(choices.map((choice) => choice.value));
  let index = choices.length + 1;
  while (taken.has(String(index))) index += 1;
  return String(index);
}

/** Add an option with a usable value and a label the author can replace. */
export function addChoice(form: FormDefinition, questionId: string, language = form.defaultLanguage): FormDefinition {
  return withChoices(form, questionId, (choices) => {
    const number = choices.length + 1;
    const label = `Option ${number}`;
    return [
      ...choices,
      {
        value: uniqueChoiceValue(choices),
        label: { [form.defaultLanguage]: label, ...(language !== form.defaultLanguage ? { [language]: label } : {}) },
      },
    ];
  });
}

export function setChoiceValue(form: FormDefinition, questionId: string, index: number, value: string): FormDefinition {
  return withChoices(form, questionId, (choices) =>
    choices.map((choice, choiceIndex) => (choiceIndex === index ? { ...choice, value } : choice)),
  );
}

export function setChoiceLabel(
  form: FormDefinition,
  questionId: string,
  index: number,
  value: string,
  language = form.defaultLanguage,
): FormDefinition {
  return withChoices(form, questionId, (choices) =>
    choices.map((choice, choiceIndex) =>
      choiceIndex === index ? { ...choice, label: withLocalized(choice.label, language, value) } : choice,
    ),
  );
}

export function removeChoice(form: FormDefinition, questionId: string, index: number): FormDefinition {
  return withChoices(form, questionId, (choices) => choices.filter((_, choiceIndex) => choiceIndex !== index));
}

export function moveChoice(form: FormDefinition, questionId: string, index: number, delta: number): FormDefinition {
  return withChoices(form, questionId, (choices) => {
    const to = index + delta;
    if (index < 0 || index >= choices.length || to < 0 || to >= choices.length) return choices;
    const next = [...choices];
    const [moved] = next.splice(index, 1);
    if (!moved) return choices;
    next.splice(to, 0, moved);
    return next;
  });
}

function uniqueGroupId(form: FormDefinition): string {
  const taken = new Set(form.groups.map((group) => group.id));
  let index = form.groups.length + 1;
  while (taken.has(`g_${index}`)) index += 1;
  return `g_${index}`;
}

function uniqueGroupName(form: FormDefinition, base: string): string {
  const taken = new Set(form.groups.map((group) => group.name));
  if (!taken.has(base)) return base;
  let index = 2;
  while (taken.has(`${base}_${index}`)) index += 1;
  return `${base}_${index}`;
}

/** Add a section. The questions stay independent until one is assigned to it. */
export function addGroup(form: FormDefinition, label: string, language = form.defaultLanguage): FormDefinition {
  const text = label.trim() === '' ? 'New section' : label;
  const group: Group = {
    id: uniqueGroupId(form),
    name: uniqueGroupName(form, 'section'),
    label: { [form.defaultLanguage]: text, ...(language !== form.defaultLanguage ? { [language]: text } : {}) },
  };
  return { ...form, groups: [...form.groups, group] };
}

export function setGroupLabel(
  form: FormDefinition,
  groupId: string,
  value: string,
  language = form.defaultLanguage,
): FormDefinition {
  return {
    ...form,
    groups: form.groups.map((group) =>
      group.id === groupId ? { ...group, label: withLocalized(group.label, language, value) } : group,
    ),
  };
}

/**
 * Remove a section, not its questions: they become ungrouped so no answer loses its
 * field. The confirmation lives in the control, because the JSON still knows how to
 * put the section back and the analyser does not need to be taught about this one.
 */
export function removeGroup(form: FormDefinition, groupId: string): FormDefinition {
  if (!form.groups.some((group) => group.id === groupId)) return form;
  return {
    ...form,
    groups: form.groups.filter((group) => group.id !== groupId),
    questions: form.questions.map((question) =>
      question.groupId === groupId ? { ...question, groupId: null } : question,
    ),
  };
}

export function groupLabel(group: Group, language: string): string {
  return group.label?.[language] ?? Object.values(group.label ?? {})[0] ?? group.name;
}

/**
 * The builder surface: the questions as an ordered list, and one question's logic.
 *
 * Reordering is a drag where a pointer exists and two buttons everywhere else. A
 * drag-only control is unusable by keyboard, and a control that silently does nothing
 * is the thing this file keeps refusing to ship (see the geolocation button in
 * `respondent.tsx`), so both gestures write through the same functions.
 */
function BuilderPanel({
  form,
  onEdit,
}: {
  form: FormDefinition;
  /** Hands the next definition back to the JSON, which is the only place it is stored. */
  onEdit: (next: FormDefinition) => void;
}): JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [adding, setAdding] = useState<QuestionType>('text');
  const [editingLanguage, setEditingLanguage] = useState<string | null>(null);
  const availableLanguages = form.languages.length > 0 ? form.languages : [form.defaultLanguage];
  const language =
    editingLanguage && availableLanguages.includes(editingLanguage) ? editingLanguage : form.defaultLanguage;
  const selected = form.questions.find((question) => question.id === selectedId) ?? null;
  const selectedIndex = selected ? form.questions.findIndex((question) => question.id === selected.id) : -1;
  const selectedChoices = selected ? choicesOf(form, selected) : [];
  const sharedList = selected ? choiceListName(selected) : null;

  const add = (): void => {
    const next = addQuestion(form, adding, selectedId);
    const created = next.questions.find((question) => !form.questions.some((before) => before.id === question.id));
    onEdit(next);
    if (created) setSelectedId(created.id);
  };

  return (
    <div className="studio-builder">
      <div className="studio-builder-toolbar">
        <div>
          <span className="eyebrow">Builder</span>
          <p className="small muted">
            Edit the question, its choices and its rules here. Every change is written straight into the JSON
            above, so the workbook and preview move with it.
          </p>
        </div>
        <label className="small muted">
          Editing language{' '}
          <select
            value={language}
            aria-label="Builder language"
            onChange={(event) => setEditingLanguage(event.target.value)}
          >
            {availableLanguages.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="row wrap">
        <label className="small muted">
          New question of type{' '}
          <select
            value={adding}
            aria-label="New question type"
            onChange={(event) => setAdding(event.target.value as QuestionType)}
          >
            {BUILDER_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="ghost small" onClick={add}>
          Add question
        </button>
      </div>

      <details className="studio-builder-sections">
        <summary>
          Sections <span className="muted small">{form.groups.length}</span>
        </summary>
        <p className="small muted">
          A section is a group of questions, often shown on one screen. Removing one never removes its
          questions; they become ungrouped.
        </p>
        {form.groups.length > 0 && (
          <div className="studio-builder-section-list">
            {form.groups.map((group) => (
              <div className="studio-builder-section" key={group.id}>
                <label className="small">
                  Section label
                  <input
                    aria-label={`Section ${group.name} label`}
                    value={editingText(group.label, language)}
                    placeholder={translationPlaceholder(group.label, language) || group.name}
                    onChange={(event) => onEdit(setGroupLabel(form, group.id, event.target.value, language))}
                  />
                </label>
                <button
                  type="button"
                  className="ghost small"
                  aria-label={`Remove section ${group.name}`}
                  onClick={() => onEdit(removeGroup(form, group.id))}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
        <button
          type="button"
          className="ghost small"
          onClick={() => onEdit(addGroup(form, 'New section', language))}
        >
          Add section
        </button>
      </details>

      {form.questions.length === 0 ? (
        <p className="muted small">
          No questions yet. Adding one puts it in the JSON, the workbook and the preview at the same moment,
          because all three read the same definition.
        </p>
      ) : (
        <ul className="studio-builder-list">
          {form.questions.map((question, index) => (
            <li
              key={question.id}
              className={[
                'studio-builder-row',
                question.id === selectedId ? 'selected' : '',
                question.id === draggingId ? 'dragging' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              aria-current={question.id === selectedId ? 'true' : undefined}
              draggable
              onDragStart={(event) => {
                event.dataTransfer?.setData('text/plain', question.id);
                setDraggingId(question.id);
              }}
              onDragEnd={() => setDraggingId(null)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                if (draggingId !== null && draggingId !== question.id) onEdit(reorderQuestion(form, draggingId, question.id));
                setDraggingId(null);
              }}
            >
              <span className="studio-builder-index muted small" aria-hidden="true">
                {index + 1}
              </span>
              <span className="studio-builder-grip muted small" aria-hidden="true">
                ⠿
              </span>
              <button
                type="button"
                className="studio-builder-label"
                aria-pressed={question.id === selectedId}
                onClick={() => setSelectedId(question.id)}
              >
                {questionLabel(question, language)}
                <span className="muted small"> · {question.type}</span>
              </button>
              <button
                type="button"
                className="ghost small"
                aria-label={`Move ${question.name} up`}
                disabled={index === 0}
                onClick={() => onEdit(moveQuestion(form, question.id, -1))}
              >
                ↑
              </button>
              <button
                type="button"
                className="ghost small"
                aria-label={`Move ${question.name} down`}
                disabled={index === form.questions.length - 1}
                onClick={() => onEdit(moveQuestion(form, question.id, 1))}
              >
                ↓
              </button>
              <button
                type="button"
                className="ghost small"
                aria-label={`Remove ${question.name}`}
                onClick={() => {
                  onEdit(removeQuestion(form, question.id));
                  if (selectedId === question.id) setSelectedId(null);
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected && (
        <div className="studio-builder-editor">
          <div className="studio-builder-editor-head">
            <div>
              <span className="eyebrow">
                Question {selectedIndex + 1} of {form.questions.length}
              </span>
              <h3>{questionLabel(selected, language)}</h3>
            </div>
            <button
              type="button"
              className="ghost small"
              onClick={() => {
                const next = duplicateQuestion(form, selected.id);
                const copy = next.questions[selectedIndex + 1];
                onEdit(next);
                if (copy) setSelectedId(copy.id);
              }}
            >
              Duplicate
            </button>
          </div>

          <div className="studio-builder-fields">
            <label className="studio-builder-field wide">
              Question label · {language}
              <input
                aria-label="Question label"
                value={editingText(selected.label, language)}
                placeholder={translationPlaceholder(selected.label, language) || selected.name}
                onChange={(event) => onEdit(setQuestionContent(form, selected.id, { label: event.target.value }, language))}
              />
            </label>
            <label className="studio-builder-field">
              Export name
              <input
                aria-label="Question name"
                value={selected.name}
                spellCheck={false}
                onChange={(event) => onEdit(setQuestionContent(form, selected.id, { name: event.target.value }, language))}
              />
            </label>
            <label className="studio-builder-field">
              Type
              <select
                aria-label="Question type"
                value={selected.type}
                onChange={(event) =>
                  onEdit(setQuestionContent(form, selected.id, { type: event.target.value as QuestionType }, language))
                }
              >
                {BUILDER_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </label>
            <label className="studio-builder-field">
              Section
              <select
                aria-label="Question section"
                value={selected.groupId ?? ''}
                onChange={(event) =>
                  onEdit(
                    setQuestionContent(
                      form,
                      selected.id,
                      { groupId: event.target.value === '' ? null : event.target.value },
                      language,
                    ),
                  )
                }
              >
                <option value="">No section</option>
                {form.groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {groupLabel(group, language)}
                  </option>
                ))}
              </select>
            </label>
            <label className="studio-builder-field wide">
              Hint · {language}
              <input
                aria-label="Question hint"
                value={editingText(selected.hint, language)}
                placeholder={translationPlaceholder(selected.hint, language) || 'Optional help under the question'}
                onChange={(event) => onEdit(setQuestionContent(form, selected.id, { hint: event.target.value }, language))}
              />
            </label>
          </div>

          {isInput(selected.type) && (
            <div className="studio-builder-requirement">
              <label className="small">
                <input
                  type="checkbox"
                  checked={Boolean(selected.required)}
                  disabled={typeof selected.required === 'string'}
                  onChange={(event) =>
                    onEdit(setQuestionContent(form, selected.id, { required: event.target.checked }, language))
                  }
                />{' '}
                Required
              </label>
              {typeof selected.required === 'string' && (
                <span className="muted small">
                  A conditional requirement is preserved: <code>{selected.required}</code>
                </span>
              )}
            </div>
          )}

          {Boolean(selected.required) && isInput(selected.type) && (
            <label className="small">
              Message if missing · {language}
              <input
                aria-label="Required message"
                value={editingText(selected.requiredMessage, language)}
                placeholder={translationPlaceholder(selected.requiredMessage, language) || 'Please answer this question'}
                onChange={(event) =>
                  onEdit(setQuestionContent(form, selected.id, { requiredMessage: event.target.value }, language))
                }
              />
            </label>
          )}

          {hasChoices(selected.type) && (
            <fieldset className="studio-builder-choices">
              <legend>
                Choices <span className="muted small">{selectedChoices.length}</span>
              </legend>
              {sharedList ? (
                <p className="small muted">
                  These options are the shared list <code>{sharedList}</code>. Editing one changes every question
                  that uses it.
                </p>
              ) : (
                <p className="small muted">The options a respondent chooses from, in render order.</p>
              )}
              {selectedChoices.length === 0 ? (
                <p className="small error">This question has no choices yet. Add one below.</p>
              ) : (
                <ol className="studio-builder-option-list">
                  {selectedChoices.map((choice, index) => (
                    <li className="studio-builder-option" key={`${choice.value}-${index}`}>
                      <span className="studio-builder-option-index muted small" aria-hidden="true">
                        {index + 1}
                      </span>
                      <input
                        aria-label={`Option ${index + 1} value`}
                        value={choice.value}
                        spellCheck={false}
                        placeholder="value"
                        onChange={(event) => onEdit(setChoiceValue(form, selected.id, index, event.target.value))}
                      />
                      <input
                        aria-label={`Option ${index + 1} label`}
                        value={editingText(choice.label, language)}
                        placeholder={translationPlaceholder(choice.label, language) || 'Label'}
                        onChange={(event) =>
                          onEdit(setChoiceLabel(form, selected.id, index, event.target.value, language))
                        }
                      />
                      <div className="row">
                        <button
                          type="button"
                          className="ghost small"
                          aria-label={`Move option ${index + 1} up`}
                          disabled={index === 0}
                          onClick={() => onEdit(moveChoice(form, selected.id, index, -1))}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="ghost small"
                          aria-label={`Move option ${index + 1} down`}
                          disabled={index === selectedChoices.length - 1}
                          onClick={() => onEdit(moveChoice(form, selected.id, index, 1))}
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          className="ghost small"
                          aria-label={`Remove option ${index + 1}`}
                          onClick={() => onEdit(removeChoice(form, selected.id, index))}
                        >
                          Remove
                        </button>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
              <button
                type="button"
                className="ghost small"
                onClick={() => onEdit(addChoice(form, selected.id, language))}
              >
                Add option
              </button>
            </fieldset>
          )}

          <details className="studio-builder-logic" open>
            <summary>Logic & validation</summary>
            <div className="studio-builder-logic-grid">
              <label className="small">
                Show this question when <code>visibleIf</code>
                <input
                  aria-label="Show this question when"
                  value={selected.rules?.visibleIf ?? ''}
                  spellCheck={false}
                  placeholder="${consent} = 'yes'"
                  onChange={(event) =>
                    onEdit(setQuestionLogic(form, selected.id, { visibleIf: event.target.value }, language))
                  }
                />
              </label>
              <label className="small">
                Make it read-only when <code>enableIf</code>
                <input
                  aria-label="Make it read-only when"
                  value={selected.rules?.enableIf ?? ''}
                  spellCheck={false}
                  placeholder="${locked} = 'yes'"
                  onChange={(event) =>
                    onEdit(setQuestionLogic(form, selected.id, { enableIf: event.target.value }, language))
                  }
                />
              </label>
              {selected.type === 'calculate' && (
                <label className="small">
                  Calculate its value with <code>calculate</code>
                  <input
                    aria-label="Calculate its value with"
                    value={selected.rules?.calculate ?? ''}
                    spellCheck={false}
                    placeholder="${q1} + ${q2}"
                    onChange={(event) =>
                      onEdit(setQuestionLogic(form, selected.id, { calculate: event.target.value }, language))
                    }
                  />
                </label>
              )}
              {canFilterChoices(selected.type) && (
                <label className="small">
                  Filter its choices <code>choiceFilter</code>
                  <input
                    aria-label="Filter its choices"
                    value={selected.rules?.choiceFilter ?? ''}
                    spellCheck={false}
                    placeholder="district = ${district}"
                    onChange={(event) =>
                      onEdit(setQuestionLogic(form, selected.id, { choiceFilter: event.target.value }, language))
                    }
                  />
                </label>
              )}
              <label className="small">
                Only accept a value when <code>constraint</code>
                <input
                  aria-label="Only accept a value when"
                  value={selected.validation?.constraint ?? ''}
                  spellCheck={false}
                  placeholder=". >= 0 and . <= 10"
                  onChange={(event) =>
                    onEdit(setQuestionLogic(form, selected.id, { constraint: event.target.value }, language))
                  }
                />
              </label>
              <label className="small">
                Message when it fails · {language}
                <input
                  aria-label="Message when it fails"
                  value={editingText(selected.validation?.message, language)}
                  spellCheck={false}
                  placeholder={translationPlaceholder(selected.validation?.message, language) || 'Between 0 and 10'}
                  onChange={(event) =>
                    onEdit(setQuestionLogic(form, selected.id, { constraintMessage: event.target.value }, language))
                  }
                />
              </label>
            </div>
            <p className="muted small">
              These are the strings the expression engine evaluates, and nothing here is checked by a second
              parser. The analyser above reports what is wrong with them, and the preview shows what they do,
              including an edit that named a question you have since removed.
            </p>
          </details>
        </div>
      )}
    </div>
  );
}

export function DefinitionStudio({
  formId,
  version,
  revision,
}: {
  formId: string;
  version: VersionSummary;
  /** Bumped by the parent when the server-side definition changed (an import, say). */
  revision: number;
}): JSX.Element {
  const [text, setText] = useState('');
  const [loadedVersion, setLoadedVersion] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState('survey');
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  // Unsaved keystrokes must never be clobbered by a background refresh.
  const dirty = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.version(formId, version.id);
        if (cancelled || dirty.current) return;
        setText(JSON.stringify(res.version.definition, null, 2));
        setLoadedVersion(version.id);
        setProblem(null);
      } catch {
        // The parent surfaces the request error; say that the panel is empty and
        // why, rather than showing a blank editor that looks like a definition of
        // nothing.
        if (!cancelled) setProblem('This version could not be read from the server.');
      }
    })();
    return () => {
      cancelled = true;
    };
    // `revision` and the question count are what change when an import rewrites
    // this same version in place. Without them the panels below went stale while
    // the stored definition had already moved on.
  }, [formId, version.id, version.question_count, revision]);

  /**
   * The live views, all three of them, from the text that is on screen right now.
   *
   * Parsing and analysing a form definition is a few hundred microseconds at the
   * sizes this product deals with, so this runs per keystroke rather than behind a
   * debounce: a debounce here would only mean the preview lags the thing it is
   * previewing.
   */
  const live: Live = useMemo(() => {
    if (text.trim() === '') return { ok: false, problem: 'nothing yet: the definition is empty' };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return { ok: false, problem: `not valid JSON: ${err instanceof Error ? err.message : 'unparseable'}` };
    }
    const read = readDefinition(parsed);
    if ('problem' in read) return { ok: false, problem: read.problem };
    const form = read.definition as unknown as FormDefinition;
    try {
      const workbook = xlsFormSheets(form);
      return {
        ok: true,
        definition: read.definition,
        report: validateForm(form),
        sheets: workbook.sheets,
        notes: workbook.notes,
      };
    } catch (err) {
      // A definition that cannot be exported must not take the console down with it.
      return { ok: false, problem: err instanceof Error ? err.message : 'this definition cannot be read' };
    }
  }, [text]);

  const sheets = live.ok ? live.sheets : [];
  const notes = live.ok ? live.notes : [];
  const report: ValidationReport | null = live.ok ? live.report : null;
  const definition: Definition | null = live.ok ? live.definition : null;
  const active = sheets.find((entry) => entry.name === sheet) ?? sheets[0];

  const save = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const parsed: unknown = JSON.parse(text);
      const res = await api.saveVersion(formId, version.id, parsed);
      // Show exactly what was stored (the server canonicalises), so the panels
      // below describe the database rather than the textarea.
      if (res.version?.definition) setText(JSON.stringify(res.version.definition, null, 2));
      dirty.current = false;
      const stored = res.version?.definition as { questions?: unknown[] } | undefined;
      setNotice(
        `Saved. The server kept ${stored?.questions?.length ?? 0} question(s)${
          res.errors.length > 0 ? `, and refused ${res.errors.length} thing(s) at publish time.` : '.'
        }`,
      );
    } catch (err) {
      setNotice(err instanceof ApiError ? (err.message ?? 'could not save') : 'That is not valid JSON.');
    } finally {
      setBusy(false);
    }
  };

  const immutable = version.status === 'published';
  const questions = definition?.questions.length ?? 0;
  const status = live.ok ? `${questions} question(s) · valid JSON` : live.problem;

  return (
    <div className="studio">
      {/*
        --------------------------------------------------------------- the JSON

        This panel is the one surface in the workspace: what it holds is code, and
        code is ink here rather than paper. It re-binds the whole palette underneath
        it (see `.surface` in styles.css), so its heading, its hairline, its field and
        the sheet below all arrive in the other material without a rule of their own.
      */}
      <section className="studio-panel surface" aria-label={PANEL.json}>
        <header className="studio-head">
          <span className="eyebrow">1 · {PANEL.json}</span>
          <h2>JSON</h2>
          <p className="muted small">
            The definition as the API stores it, and what the XLSForm importer produces: one model, two
            representations. Edits here repaint both panels to the right as you type.
          </p>
        </header>
        <div className="studio-body">
          {immutable && (
            <p className="warn small">
              This version is published and cannot be edited: responses already record it. Use{' '}
              <strong>New draft from published</strong> to make changes.
            </p>
          )}
          {problem && <p className="error small">{problem}</p>}
          {loadedVersion !== version.id && !problem && <p className="muted">Loading...</p>}
          <textarea
            value={text}
            aria-label="Form definition JSON"
            onChange={(e) => {
              dirty.current = true;
              setText(e.target.value);
            }}
            spellCheck={false}
            rows={22}
          />
          <p className={live.ok ? 'small muted' : 'small error'}>
            <span className="studio-dot" aria-hidden="true" data-state={live.ok ? 'ok' : 'bad'} />
            {status}
          </p>
          <div className="row wrap">
            <button type="button" onClick={() => void save()} disabled={busy || immutable}>
              {busy ? 'Saving…' : immutable ? 'Published (immutable)' : 'Save draft'}
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => void download(`/forms/${formId}/xlsform?versionId=${version.id}`, 'form.xlsx')}
            >
              Download .xlsx
            </button>
          </div>
          {notice && <p className="small muted">{notice}</p>}
          {report && (
            <div className={report.errors.length > 0 ? 'card error' : 'card ok'}>
              {report.errors.length === 0 ? <p>No publish-blocking problems.</p> : null}
              {report.errors.map((message) => (
                <p key={message} className="small">
                  ✕ {message}
                </p>
              ))}
              {report.warnings.map((message) => (
                <p key={message} className="small muted">
                  ! {message}
                </p>
              ))}
            </div>
          )}
          {definition && (
            <BuilderPanel
              form={definition as unknown as FormDefinition}
              onEdit={(next) => {
                // A builder edit is a keystroke on the JSON: one state change, and
                // every panel repaints because every panel reads this text.
                dirty.current = true;
                setText(JSON.stringify(next, null, 2));
              }}
            />
          )}
        </div>
      </section>

      {/* ---------------------------------------------------------- the workbook */}
      <section className="studio-panel" aria-label={PANEL.xlsform}>
        <header className="studio-head">
          <span className="eyebrow">2 · {PANEL.xlsform}</span>
          <h2>The workbook</h2>
          <p className="muted small">
            The rows <code>Download .xlsx</code> writes. It is the same function the file is zipped from, so
            what is on this screen is what a spreadsheet opens.
          </p>
        </header>
        <div className="studio-body">
          <div className="tabs" role="tablist">
            {sheets.map((entry) => (
              <button
                key={entry.name}
                type="button"
                role="tab"
                aria-selected={entry.name === active?.name}
                className={entry.name === active?.name ? 'tab active' : 'tab'}
                onClick={() => setSheet(entry.name)}
              >
                {entry.name}
                {/* Rows, not questions: a group is a `begin_group`/`end_group` pair. */}
                <span className="muted small"> {Math.max(0, entry.rows.length - 1)} rows</span>
              </button>
            ))}
          </div>
          {!live.ok && <p className="muted small">Nothing to export until the JSON above is a form definition.</p>}
          {active && <SheetTable sheet={active} />}
          {notes.length > 0 && (
            <ul className="notes">
              {notes.map((note) => (
                <li key={`${note.kind}-${note.message}`} className="small muted">
                  <strong>{note.kind}</strong> · {note.message}
                  {note.where ? ` (${note.where})` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* ------------------------------------------------------------- the form */}
      <section className="studio-panel" aria-label={PANEL.preview}>
        <header className="studio-head">
          <span className="eyebrow">3 · {PANEL.preview}</span>
          <h2>What the respondent opens</h2>
          <p className="muted small">
            Rendered by the same component and the same engine as the collection page, from this definition,
            including edits that have not been saved yet.
          </p>
        </header>
        <div className="studio-body">
          {!definition ? (
            <p className="muted small">The preview appears once the JSON above is a form definition.</p>
          ) : (
            <>
              <div className="row wrap">
                <span className="pill" aria-hidden="true">
                  Preview
                </span>
                <span className="muted small">
                  Nothing typed here is sent or stored. The submit button is real and disabled.
                </span>
                <button
                  type="button"
                  className="ghost small"
                  onClick={() => setAnswers({})}
                  disabled={Object.keys(answers).length === 0}
                >
                  Clear answers
                </button>
              </div>
              <div className="preview-frame">
                <RespondentForm
                  definition={definition}
                  answers={answers}
                  onChange={(name, value) => setAnswers((prev) => ({ ...prev, [name]: value }))}
                  subtitle="This is the form as it will be opened from a distribution link."
                  status={<span className="pill">preview</span>}
                  submit={{ label: 'Submit', disabled: true, busy: false }}
                  footer={<span className="muted small">Disabled in the preview: a real response is only written from the link.</span>}
                />
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
