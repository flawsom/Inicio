import { useEffect, useMemo, useRef, useState } from 'react';
import {
  validateForm,
  xlsFormSheets,
  type AdapterNote,
  type FormDefinition,
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
 *   2. **XLSForm** — the three sheets the export writes, from `xlsFormSheets`, which
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
              <th key={`${cell}-${index}`} scope="col">
                {cell === '' ? <span className="muted">·</span> : cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {columns.map((_, columnIndex) => (
                <td key={columnIndex}>{row[columnIndex] ?? ''}</td>
              ))}
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
 * Not every type is here on purpose: a `rank`, a `geoshape` or an `appearance` is a
 * thing an author reaches for in the JSON, and offering a control for it would
 * suggest a guidance this list cannot give. Everything absent is still editable in
 * the JSON, which remains the source of truth.
 */
export const BUILDER_TYPES: readonly QuestionType[] = [
  'text',
  'textarea',
  'integer',
  'decimal',
  'date',
  'yesno',
  'select_one',
  'select_multiple',
  'geopoint',
  'image',
  'audio',
  'video',
  'file',
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
 */
export function setQuestionLogic(form: FormDefinition, questionId: string, patch: QuestionLogicPatch): FormDefinition {
  const language = form.defaultLanguage;
  return {
    ...form,
    questions: form.questions.map((question) => {
      if (question.id !== questionId) return question;

      const existing = question.rules ?? {};
      const visibleIf = patch.visibleIf === undefined ? blank(existing.visibleIf) : blank(patch.visibleIf);
      const choiceFilter = patch.choiceFilter === undefined ? blank(existing.choiceFilter) : blank(patch.choiceFilter);
      const rules: QuestionRules = {};
      if (visibleIf) rules.visibleIf = visibleIf;
      if (choiceFilter) rules.choiceFilter = choiceFilter;
      // Fields this editor does not offer are carried, not dropped.
      if (existing.enableIf) rules.enableIf = existing.enableIf;
      if (existing.calculate) rules.calculate = existing.calculate;

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
  const language = form.defaultLanguage;
  const selected = form.questions.find((question) => question.id === selectedId) ?? null;

  const add = (): void => {
    const next = addQuestion(form, adding, selectedId);
    const created = next.questions.find((question) => !form.questions.some((before) => before.id === question.id));
    onEdit(next);
    if (created) setSelectedId(created.id);
  };

  return (
    <div className="studio-builder">
      <div className="row wrap">
        <span className="eyebrow">Builder</span>
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
              className={question.id === selectedId ? 'studio-builder-row selected' : 'studio-builder-row'}
              aria-current={question.id === selectedId}
              draggable
              onDragStart={() => setDraggingId(question.id)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                if (draggingId !== null && draggingId !== question.id) onEdit(reorderQuestion(form, draggingId, question.id));
                setDraggingId(null);
              }}
            >
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
        <div className="studio-builder-logic">
          <p className="small">
            <strong>{questionLabel(selected, language)}</strong> <span className="muted">· {selected.name}</span>
          </p>
          <label className="small">
            Show this question when <code>visibleIf</code>
            <input
              value={selected.rules?.visibleIf ?? ''}
              spellCheck={false}
              placeholder="${consent} = 'yes'"
              onChange={(event) => onEdit(setQuestionLogic(form, selected.id, { visibleIf: event.target.value }))}
            />
          </label>
          {canFilterChoices(selected.type) && (
            <label className="small">
              Filter its choices <code>choiceFilter</code>
              <input
                value={selected.rules?.choiceFilter ?? ''}
                spellCheck={false}
                placeholder="district = ${district}"
                onChange={(event) => onEdit(setQuestionLogic(form, selected.id, { choiceFilter: event.target.value }))}
              />
            </label>
          )}
          <label className="small">
            Only accept a value when <code>constraint</code>
            <input
              value={selected.validation?.constraint ?? ''}
              spellCheck={false}
              placeholder=". >= 0 and . <= 10"
              onChange={(event) => onEdit(setQuestionLogic(form, selected.id, { constraint: event.target.value }))}
            />
          </label>
          <label className="small">
            Message when it fails
            <input
              value={selected.validation?.message?.[language] ?? ''}
              spellCheck={false}
              placeholder="Between 0 and 10"
              onChange={(event) => onEdit(setQuestionLogic(form, selected.id, { constraintMessage: event.target.value }))}
            />
          </label>
          <p className="muted small">
            These are the strings the expression engine evaluates, and nothing here is checked by a second
            parser. The analyser above reports what is wrong with them, and the preview shows what they do —
            including an edit that named a question you have since removed.
          </p>
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
      return { ok: false, problem: `not valid JSON — ${err instanceof Error ? err.message : 'unparseable'}` };
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
      {/* ------------------------------------------------------------- the JSON */}
      <section className="studio-panel" aria-label={PANEL.json}>
        <header className="studio-head">
          <span className="eyebrow">1 · {PANEL.json}</span>
          <h2>JSON</h2>
          <p className="muted small">
            The definition as the API stores it, and what the XLSForm importer produces — one model, two
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
            Rendered by the same component and the same engine as the collection page, from this definition —
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
