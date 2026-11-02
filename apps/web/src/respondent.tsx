import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  datasetContext,
  evaluateForm,
  filterChoices,
  otherSpecifyCode,
  type DatasetTable,
  type FormDefinition,
  type Question,
} from '@inicio/engine';
import type { AttachmentCapability, Definition } from './api';

/**
 * The respondent's form, rendered in one place for both audiences.
 *
 * There are two screens that show this form: the collection page a respondent opens
 * from a distribution link, and the studio's preview in the console. They must not be
 * two renderers. A preview that is a *lookalike* is worse than no preview, because it
 * is a promise the author checks against the wrong thing — a field that renders in the
 * preview and not on the phone sends a survey out broken, and the person who could
 * have caught it was shown a picture instead of the thing.
 *
 * So this component is the form: the title block, the sections in the order the
 * definition declares, the label and hint for each question with the required marker,
 * the control chosen by question type, the choice filtering, and the two validation
 * messages. Everything around it — the connection pill, the queue state, the submit
 * button's wiring — is a prop, because that part genuinely differs between the two
 * screens: in the collection app the submit writes a response, and in the preview
 * there is nothing to write to.
 *
 * Logic is evaluated here with `evaluateForm`, the same function the API uses to
 * re-check a submission, so hiding, calculations, cascading choices and required
 * questions cannot mean one thing on screen and another in the database.
 */

const UPLOAD_TYPES = new Set(['image', 'audio', 'video', 'file']);
const GEO_TYPES = new Set(['geopoint', 'geotrace', 'geoshape']);

/** What a question's file control is doing right now, kept per question name. */
interface AttachmentProgress {
  name: string;
  busy: boolean;
  /** The server's own words when something was refused, never a guess at them. */
  error?: string;
}

/**
 * A ceiling a person can read.
 *
 * `Math.round(bytes / 1 MB)` turns anything under half a megabyte into "0 MB",
 * which is a limit that reads as a bug rather than as a limit.
 */
function readableLimit(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    const whole = bytes / (1024 * 1024);
    return `${Number.isInteger(whole) ? whole : whole.toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export interface RespondentProblems {
  missing: string[];
  invalid: string[];
}

export interface RespondentSubmit {
  label: string;
  busy?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}

export interface RespondentFormProps {
  definition: Definition;
  /** Attached server datasets, so pulldata() works on the device as it does on the server. */
  datasets?: DatasetTable[];
  answers: Record<string, unknown>;
  /** `custom-specify-other` metadata, keyed by field name. */
  pluginMetadata?: Record<string, string>;
  /** Called on every edit. Whether that is persisted is the caller's business. */
  onChange: (name: string, value: unknown) => void;
  /** Called when an inline other-specify text changes. */
  onPluginMetadataChange?: (name: string, value: string) => void;
  /** Called when a control loses focus: the collection app flushes its queue here. */
  onFlush?: () => void;
  /**
   * Called the first time a visible question is rendered. The collection page uses
   * it to start that field's clock for the audit timings; the studio preview does
   * not pass it, because a preview is not an interview.
   */
  onFieldVisible?: (name: string) => void;
  /** Names that block submission, from the server's own answer. */
  problems?: RespondentProblems;
  /** The line under the title: device state in the app, an explanation in the studio. */
  subtitle?: ReactNode;
  /** The header's right column: the connection pill and *Send now* in the app. */
  status?: ReactNode;
  /** The submit row. The studio passes a disabled button rather than hiding it. */
  submit?: RespondentSubmit;
  /** After the sections, before the submit row: the app's error card. */
  notice?: ReactNode;
  /** Inside the submit row, beside the button. */
  footer?: ReactNode;
  /**
   * What this deployment can do with files, taken from the link itself rather than
   * assumed. Absent means nobody has told this component anything, and it says so
   * instead of offering a control that would fail on use.
   */
  attachments?: AttachmentCapability;
  /**
   * Send one file for one question. The question is named, never id'd: answers are
   * stored under the question's name, so that is the key this passes back.
   *
   * The sequence behind it - authorise, upload straight to the store, complete -
   * belongs to the collection page, which is why a preview can render this control
   * without being able to write anything.
   */
  onAttachFile?: (questionName: string, file: File) => Promise<void>;
}

export function RespondentForm({
  definition,
  datasets,
  answers,
  pluginMetadata,
  onChange,
  onPluginMetadataChange,
  onFlush,
  onFieldVisible,
  problems,
  subtitle,
  status,
  submit,
  notice,
  footer,
  attachments,
  onAttachFile,
}: RespondentFormProps): JSX.Element {
  const form = definition as unknown as FormDefinition;
  const datasetSnapshot = useMemo(() => (datasets ? datasetContext(datasets) : undefined), [datasets]);
  // `once()` is per interview, not per render. The map is deliberately a ref: a
  // new object every render would redraw a random number every time the screen
  // repainted. The server keeps the authoritative copy in the response's answers.
  const onceValues = useRef<Record<string, unknown>>({});
  const [localMetadata, setLocalMetadata] = useState<Record<string, string>>({});
  const metadata = pluginMetadata ?? localMetadata;
  const setMetadata = (name: string, value: string): void => {
    if (onPluginMetadataChange) {
      onPluginMetadataChange(name, value);
      return;
    }
    setLocalMetadata((previous) => {
      const next = { ...previous };
      if (value === '') delete next[name];
      else next[name] = value;
      return next;
    });
  };
  const evaluation = useMemo(
    () => evaluateForm(form, answers, { datasets: datasetSnapshot, onceValues: onceValues.current, pluginMetadata: metadata }),
    [form, answers, datasetSnapshot, metadata],
  );
  // One effect for every visible question, not a hook per question: hooks cannot be
  // called in a loop, and the signature is what makes "newly visible" cheap to spot.
  // Audit fields are calculates with no control of their own. They must not
  // produce an empty output row, and they must not start a timing clock: they are
  // instrumentation, not questions.
  const rendered = (question: Question): boolean =>
    evaluation.states[question.name]?.visible === true && !question.audit;
  const visibleSignature = form.questions
    .filter(rendered)
    .map((question) => question.name)
    .join('\n');
  useEffect(() => {
    if (!onFieldVisible) return;
    for (const name of visibleSignature.split('\n')) if (name !== '') onFieldVisible(name);
  }, [visibleSignature, onFieldVisible]);
  // Per question, because two file questions on one screen are two transfers, and a
  // single flag would make one of them claim the other's progress.
  const [uploads, setUploads] = useState<Record<string, AttachmentProgress>>({});

  const label = (question: Question): string =>
    question.label?.[definition.defaultLanguage] ?? Object.values(question.label ?? {})[0] ?? question.name;

  const otherSpecify = (question: Question, value: unknown): JSX.Element | null => {
    const code = otherSpecifyCode(question);
    if (!code) return null;
    const selected = Array.isArray(value) ? value.map(String) : [String(value ?? '')];
    if (!selected.includes(code)) return null;
    const stored = metadata[question.name] ?? '';
    const separator = stored.indexOf('|');
    const text = separator >= 0 ? stored.slice(separator + 1) : stored;
    return (
      <div className="field">
        <label>Please specify</label>
        <input
          type="text"
          value={text}
          disabled={evaluation.states[question.name]?.enabled === false || evaluation.states[question.name]?.computed === true}
          onChange={(event) => {
            const verbatim = event.target.value;
            // SurveyCTO stores every selected choice, not only the `other` code:
            // `selectedChoices|verbatim`, with multi-select choices space-separated.
            setMetadata(question.name, verbatim === '' ? '' : `${selected.join(' ')}|${verbatim}`);
          }}
          onBlur={onFlush}
        />
      </div>
    );
  };

  const questionInput = (question: Question): JSX.Element => {
    const value = evaluation.states[question.name]?.value;
    const disabled = evaluation.states[question.name]?.enabled === false || evaluation.states[question.name]?.computed === true;

    if (question.type === 'note') return <p className="muted">{label(question)}</p>;

    if (question.type === 'calculate') {
      return <output className="computed">{String(value ?? '')}</output>;
    }

    if (UPLOAD_TYPES.has(question.type)) {
      // A file is the one answer this component cannot write itself: it is
      // authorised, uploaded straight to the store and verified by the server, and
      // that sequence belongs to the collection page. What belongs here is the truth
      // about whether the control can work at all — the same property that makes the
      // geolocation button say "Location unavailable" rather than ignore a click.
      const capability = attachments;
      const upload = uploads[question.name];

      if (!capability || capability.enabled !== true || !onAttachFile) {
        // Three different reasons, and none of them is allowed to read as a working
        // control that does nothing: the console's preview, which has no response to
        // attach a file to; a deployment whose policy will not take a file it cannot
        // check and has nothing to check it with; and a deployment with no bucket at
        // all. The pre-existing wording is kept for that last one, because it is what
        // the public page promises a respondent sees and a test holds it to the text.
        // It must not be shown for the middle one: there the storage is configured and
        // sound, so telling a respondent there is none would be a plain falsehood.
        return (
          <>
            <input type="file" disabled />
            {capability?.enabled === true ? (
              <p className="muted small">
                Not uploaded from the preview: a file is chosen and sent on the collection page this form is
                published to, and there is no response here for one to belong to.
              </p>
            ) : capability?.unscanned === 'refused' ? (
              <p className="muted small">
                Not collected here: this deployment only accepts a file it can check for viruses, and there is no
                checker available, so the question is shown and left unanswered rather than offering an upload that
                would be refused.
              </p>
            ) : (
              <p className="muted small">
                Not collected yet: this deployment has no file storage, so the question is shown and left
                unanswered rather than skipped without saying so.
              </p>
            )}
          </>
        );
      }

      const accepted = capability.mime[question.type as keyof AttachmentCapability['mime']] ?? [];

      const startUpload = async (file: File): Promise<void> => {
        // Refused before it is sent, because a request that is certain to be refused
        // spends the respondent's connection and tells them nothing.
        if (file.size > capability.maxBytes) {
          setUploads((previous) => ({
            ...previous,
            [question.name]: {
              name: file.name,
              busy: false,
              error: `That file is ${readableLimit(file.size)}, over the ${readableLimit(capability.maxBytes)} this survey accepts.`,
            },
          }));
          return;
        }
        setUploads((previous) => ({ ...previous, [question.name]: { name: file.name, busy: true } }));
        try {
          await onAttachFile(question.name, file);
          setUploads((previous) => ({ ...previous, [question.name]: { name: file.name, busy: false } }));
        } catch (error) {
          setUploads((previous) => ({
            ...previous,
            [question.name]: {
              name: file.name,
              busy: false,
              error:
                error instanceof Error && error.message
                  ? error.message
                  : 'That file could not be sent. Please try again.',
            },
          }));
        }
      };

      return (
        <>
          <input
            type="file"
            accept={accepted.length > 0 ? accepted.join(',') : undefined}
            disabled={disabled || upload?.busy === true}
            onChange={(event) => {
              const file = event.target.files?.[0];
              // `void`, because the control reports its own outcome: an unhandled
              // rejection here would be a promise nobody is listening to.
              if (file) void startUpload(file);
            }}
            onBlur={onFlush}
          />
          {upload ? (
            <p className={upload.error ? 'error small' : 'muted small'}>
              {upload.error ??
                (upload.busy ? `Sending ${upload.name}…` : `Attached: ${upload.name}`)}
            </p>
          ) : typeof value === 'string' && value !== '' ? (
            <p className="muted small">A file is already attached to this answer.</p>
          ) : (
            <p className="muted small">
              {`Up to ${readableLimit(capability.maxBytes)}. `}
              {capability.scan === 'on'
                ? 'The file is checked before the answer is accepted, and an answer whose file was refused is not submitted.'
                : 'This deployment does not run a scan, so nothing looks at what arrives.'}
            </p>
          )}
        </>
      );
    }

    if (GEO_TYPES.has(question.type)) {
      // A device without the geolocation API gets a button that says so instead of a
      // button that quietly does nothing when it is pressed.
      const canLocate = typeof navigator !== 'undefined' && typeof navigator.geolocation?.getCurrentPosition === 'function';
      return (
        <div className="row">
          <input
            placeholder="latitude longitude"
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(question.name, e.target.value)}
            onBlur={onFlush}
          />
          <button
            type="button"
            className="ghost"
            disabled={!canLocate}
            title={canLocate ? undefined : 'This browser does not offer location'}
            onClick={() => {
              if (!canLocate) return;
              navigator.geolocation.getCurrentPosition((pos) =>
                onChange(question.name, `${pos.coords.latitude} ${pos.coords.longitude}`),
              );
            }}
          >
            {canLocate ? 'Use my location' : 'Location unavailable'}
          </button>
        </div>
      );
    }

    if (question.type === 'enumerator') {
      const table = datasets?.find((candidate) => candidate.kind === 'enumerators');
      const rows = table?.rows ?? [];
      return (
        <select
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          onChange={(e) => onChange(question.name, e.target.value)}
          onBlur={onFlush}
        >
          <option value="">- choose -</option>
          {rows.map((row) => {
            const id = String(row[table?.uniqueField ?? 'id'] ?? '');
            const label = String(row['name'] ?? row['label'] ?? row['code'] ?? id);
            return <option key={id} value={id}>{label}</option>;
          })}
        </select>
      );
    }

    if (question.type === 'select_one' || question.type === 'yesno') {
      const options =
        question.type === 'yesno'
          ? [{ value: 'yes', label: { en: 'Yes' } }, { value: 'no', label: { en: 'No' } }]
          : filterChoices(form, question, answers, { datasets: datasetSnapshot }).map((c) => ({ value: c.value, label: c.label }));
      return (
        <>
          <select
            value={typeof value === 'string' ? value : ''}
            disabled={disabled}
            onChange={(e) => onChange(question.name, e.target.value)}
            onBlur={onFlush}
          >
            <option value="">- choose -</option>
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label?.[definition.defaultLanguage] ?? Object.values(option.label ?? {})[0] ?? option.value}
              </option>
            ))}
          </select>
          {otherSpecify(question, value)}
        </>
      );
    }

    if (question.type === 'select_multiple' || question.type === 'rank') {
      const options = filterChoices(form, question, answers, { datasets: datasetSnapshot });
      const selected = Array.isArray(value) ? value.map(String) : [];
      return (
        <>
          <div className="choices">
            {options.map((option) => (
              <label key={option.value} className="choice">
                <input
                  type="checkbox"
                  checked={selected.includes(option.value)}
                  onChange={(e) =>
                    onChange(
                      question.name,
                      e.target.checked ? [...selected, option.value] : selected.filter((v) => v !== option.value),
                    )
                  }
                  onBlur={onFlush}
                />
                {option.label?.[definition.defaultLanguage] ?? Object.values(option.label ?? {})[0] ?? option.value}
              </label>
            ))}
          </div>
          {otherSpecify(question, value)}
        </>
      );
    }

    const numeric = question.type === 'integer' || question.type === 'decimal';
    const isDate = question.type === 'date' || question.type === 'datetime' || question.type === 'time';
    return (
      <input
        type={numeric ? 'number' : isDate ? (question.type === 'time' ? 'time' : question.type === 'date' ? 'date' : 'datetime-local') : 'text'}
        value={value === null || value === undefined ? '' : String(value)}
        disabled={disabled}
        onChange={(e) => onChange(question.name, numeric ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)}
        onBlur={onFlush}
      />
    );
  };

  const sections: Array<{ key: string; title: string; questions: Question[] }> = [];
  for (const group of form.groups ?? []) {
    const questions = form.questions.filter((q) => q.groupId === group.id && rendered(q));
    if (questions.length === 0) continue;
    sections.push({ key: group.id, title: group.label?.[definition.defaultLanguage] ?? group.name, questions });
  }
  const topLevel = form.questions.filter((q) => !q.groupId && rendered(q));
  if (topLevel.length > 0) sections.push({ key: 'ungrouped', title: definition.title, questions: topLevel });

  return (
    <div className="collect">
      <header className="screen-head">
        <div>
          <span className="eyebrow">Survey</span>
          <h1>{definition.title}</h1>
          {subtitle ? <p className="muted small">{subtitle}</p> : null}
        </div>
        {status ? <div className="stack tight">{status}</div> : null}
      </header>

      {sections.map((section) => (
        <section key={section.key} className="card">
          {form.groups.length > 0 && <h2>{section.title}</h2>}
          {section.questions.map((question) => (
            <div key={question.id} className="field">
              <label>
                {label(question)}
                {question.required === true && <span className="req"> *</span>}
              </label>
              {question.hint && <p className="muted small">{question.hint[definition.defaultLanguage]}</p>}
              {questionInput(question)}
              {problems?.missing.includes(question.name) && <p className="error small">This answer is required.</p>}
              {problems?.invalid.includes(question.name) && (
                <p className="error small">
                  {question.validation?.message?.[definition.defaultLanguage] ?? 'This answer is not valid.'}
                </p>
              )}
            </div>
          ))}
        </section>
      ))}

      {notice}

      {submit && (
        <div className="card row wrap">
          <button type="button" onClick={submit.onClick} disabled={submit.busy === true || submit.disabled === true}>
            {submit.label}
          </button>
          {footer}
        </div>
      )}
    </div>
  );
}
