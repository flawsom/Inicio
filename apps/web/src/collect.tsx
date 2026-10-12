import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { evaluateForm, filterChoices, type FormDefinition, type Question } from '@inicio/engine';
import { ApiError, api, type Definition } from './api';

/**
 * The collection renderer.
 *
 * Logic is evaluated with the *same* engine the server uses, so what a respondent
 * sees here and what the server stores cannot disagree: hidden questions disappear,
 * cascading selects filter, required questions block submission. The server still
 * re-checks all of it on submit: this is the ergonomics, not the authority.
 *
 * Answers are saved as they are typed (debounced), so an abandoned interview is
 * recoverable, and the response id is kept in localStorage against the token.
 */

const UPLOAD_TYPES = new Set(['image', 'audio', 'video', 'file']);
const GEO_TYPES = new Set(['geopoint', 'geotrace', 'geoshape']);

/**
 * Why a respondent cannot open the survey, in their language.
 *
 * The API sends a machine-readable code and a sentence written for a person, so
 * the only job here is a heading that matches the code. No stack traces, no
 * "not_published", no hint that an authoring tool exists behind the link.
 */
const UNAVAILABLE_TITLES: Record<string, string> = {
  not_published: 'This survey is not open yet',
  link_not_found: 'This link is not valid',
  link_inactive: 'This link has been closed',
  link_expired: 'This link has expired',
  link_exhausted: 'This link has already been used',
  link_already_used: 'This link has already been used',
  forbidden: 'This survey is unavailable',
};

function Unavailable({ code, message }: { code: string; message: string }): JSX.Element {
  return (
    <div className="collect">
      <div className="card">
        <h1>{UNAVAILABLE_TITLES[code] ?? 'This survey is unavailable'}</h1>
        <p className="muted">{message}</p>
        <p className="muted small">
          If you believe this is a mistake, contact the person or organisation that shared this link with you.
        </p>
      </div>
    </div>
  );
}

function storageKey(token: string): string {
  return `inicio:collect:${token}`;
}

export function Collect({ token }: { token: string }): JSX.Element {
  const [definition, setDefinition] = useState<Definition | null>(null);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [responseId, setResponseId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [problems, setProblems] = useState<{ missing: string[]; invalid: string[] }>({ missing: [], invalid: [] });
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<{ code: string; message: string } | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const saveTimer = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const loaded = await api.collectForm(token);
        if (cancelled) return;
        setDefinition(loaded.form.definition);
        const existing = window.localStorage.getItem(storageKey(token));
        if (existing) {
          // Resume: the server has the answers already, this only restores the id.
          const resumed = await fetch(`/api/v1/collect/${token}/responses/${existing}`, { credentials: 'include' });
          if (resumed.ok) {
            const body = (await resumed.json()) as { answers: Record<string, unknown>; status: string };
            setResponseId(existing);
            setAnswers(body.answers ?? {});
            setStatus(body.status);
            return;
          }
          window.localStorage.removeItem(storageKey(token));
        }
        const started = await api.startResponse(token);
        window.localStorage.setItem(storageKey(token), started.responseId);
        setResponseId(started.responseId);
      } catch (err) {
        if (cancelled) return;
        setUnavailable(
          err instanceof ApiError
            ? { code: err.code, message: err.message ?? 'This survey cannot be opened right now.' }
            : { code: 'error', message: 'This survey cannot be opened right now. Please try again.' },
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const form = definition as unknown as FormDefinition | null;
  const evaluation = useMemo(() => (form ? evaluateForm(form, answers) : null), [form, answers]);

  const save = useCallback(
    (next: Record<string, unknown>) => {
      if (!responseId || status !== 'in_progress') return;
      void api
        .saveResponse(token, responseId, next)
        .then((res) => {
          setProblems({ missing: res.missing, invalid: res.invalid });
          setSavedAt(new Date().toLocaleTimeString());
        })
        .catch(() => setError('your answers could not be saved just now: they are still on screen'));
    },
    [responseId, status, token],
  );

  const update = (name: string, value: unknown): void => {
    const next = { ...answers, [name]: value };
    setAnswers(next);
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => save(next), 900);
  };

  const submit = async (): Promise<void> => {
    if (!responseId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.submitResponse(token, responseId, answers);
      setStatus(result.status);
      window.localStorage.removeItem(storageKey(token));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'incomplete' && err.message) {
        try {
          const detail = JSON.parse(err.message) as { missing: string[]; invalid: string[] };
          setProblems({ missing: detail.missing ?? [], invalid: detail.invalid ?? [] });
        } catch {
          setProblems({ missing: [], invalid: [] });
        }
      } else if (err instanceof ApiError && err.code === 'already_submitted') {
        setStatus('submitted');
      } else {
        setError(err instanceof ApiError ? err.message : 'submission failed');
      }
    } finally {
      setBusy(false);
    }
  };

  if (unavailable) return <Unavailable code={unavailable.code} message={unavailable.message} />;
  if (error && !definition) return <div className="card error">{error}</div>;
  if (!definition || !form || !evaluation) return <div className="card">Loading…</div>;

  if (status && status !== 'in_progress') {
    const labels: Record<string, string> = {
      submitted: 'Thank you: your response was recorded.',
      screened_out: 'Thank you. You are not eligible for the rest of this survey.',
      quota_full: 'Thank you. The quota for your group is now full.',
    };
    return (
      <div className="card">
        <h1>{labels[status] ?? 'Response recorded.'}</h1>
        <p className="muted">Reference: {responseId}</p>
      </div>
    );
  }

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
      return (
        <input type="file" disabled />
      );
    }

    if (GEO_TYPES.has(question.type)) {
      return (
        <div className="row">
          <input
            placeholder="latitude longitude"
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => update(question.name, e.target.value)}
          />
          <button
            type="button"
            className="ghost"
            onClick={() =>
              navigator.geolocation?.getCurrentPosition((pos) =>
                update(question.name, `${pos.coords.latitude} ${pos.coords.longitude}`),
              )
            }
          >
            Use my location
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
        <select value={typeof value === 'string' ? value : ''} disabled={disabled} onChange={(e) => update(question.name, e.target.value)}>
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
                  update(
                    question.name,
                    e.target.checked ? [...selected, option.value] : selected.filter((v) => v !== option.value),
                  )
                }
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
        onChange={(e) => update(question.name, numeric ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)}
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
      <header>
        <h1>{definition.title}</h1>
        <p className="muted">
          {savedAt ? `Saved at ${savedAt}` : 'Answers save as you go'} · version {definition.languages.join('/')}
        </p>
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
              {problems.missing.includes(question.name) && <p className="error small">This answer is required.</p>}
              {problems.invalid.includes(question.name) && (
                <p className="error small">
                  {question.validation?.message?.[definition.defaultLanguage] ?? 'This answer is not valid.'}
                </p>
              )}
            </div>
          ))}
        </section>
      ))}

      {error && <div className="card error">{error}</div>}
      <div className="card row">
        <button type="button" onClick={() => void submit()} disabled={busy}>
          {busy ? 'Submitting…' : 'Submit'}
        </button>
        {problems.missing.length > 0 && <span className="muted">{problems.missing.length} required answer(s) still missing</span>}
      </div>
    </div>
  );
}
