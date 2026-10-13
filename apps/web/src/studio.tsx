import { useEffect, useMemo, useRef, useState } from 'react';
import {
  validateForm,
  xlsFormSheets,
  type AdapterNote,
  type FormDefinition,
  type OutSheet,
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
