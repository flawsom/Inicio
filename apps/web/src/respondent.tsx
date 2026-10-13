import { useMemo, type ReactNode } from 'react';
import { evaluateForm, filterChoices, type FormDefinition, type Question } from '@inicio/engine';
import type { Definition } from './api';

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
  answers: Record<string, unknown>;
  /** Called on every edit. Whether that is persisted is the caller's business. */
  onChange: (name: string, value: unknown) => void;
  /** Called when a control loses focus: the collection app flushes its queue here. */
  onFlush?: () => void;
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
}

export function RespondentForm({
  definition,
  answers,
  onChange,
  onFlush,
  problems,
  subtitle,
  status,
  submit,
  notice,
  footer,
}: RespondentFormProps): JSX.Element {
  const form = definition as unknown as FormDefinition;
  const evaluation = useMemo(() => evaluateForm(form, answers), [form, answers]);

  const label = (question: Question): string =>
    question.label?.[definition.defaultLanguage] ?? Object.values(question.label ?? {})[0] ?? question.name;

  const questionInput = (question: Question): JSX.Element => {
    const value = evaluation.states[question.name]?.value;
    const disabled = evaluation.states[question.name]?.enabled === false || evaluation.states[question.name]?.computed === true;

    if (question.type === 'note') return <p className="muted">{label(question)}</p>;

    if (question.type === 'calculate') {
      return <output className="computed">{String(value ?? '')}</output>;
    }

    if (UPLOAD_TYPES.has(question.type)) {
      // There is no file storage in this build, and that is deliberate (see D9 in
      // DECISIONS.md). A disabled control with no caption reads as a bug; a disabled
      // control that says what it is not is the honest version — and it is exactly
      // what the public page promises a respondent will see.
      return (
        <>
          <input type="file" disabled />
          <p className="muted small">
            Not collected yet: this deployment has no file storage, so the question is shown and left unanswered
            rather than skipped without saying so.
          </p>
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

    if (question.type === 'select_one' || question.type === 'yesno') {
      const options =
        question.type === 'yesno'
          ? [{ value: 'yes', label: { en: 'Yes' } }, { value: 'no', label: { en: 'No' } }]
          : filterChoices(form, question, answers).map((c) => ({ value: c.value, label: c.label }));
      return (
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
      );
    }

    if (question.type === 'select_multiple' || question.type === 'rank') {
      const options = filterChoices(form, question, answers);
      const selected = Array.isArray(value) ? value.map(String) : [];
      return (
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
    const questions = form.questions.filter((q) => q.groupId === group.id && evaluation.states[q.name]?.visible);
    if (questions.length === 0) continue;
    sections.push({ key: group.id, title: group.label?.[definition.defaultLanguage] ?? group.name, questions });
  }
  const topLevel = form.questions.filter((q) => !q.groupId && evaluation.states[q.name]?.visible);
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
