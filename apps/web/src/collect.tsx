import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { evaluateForm, filterChoices, type FormDefinition, type Question } from '@inicio/engine';
import { ApiError, api, type Definition } from './api';
import { pendingCount, resolveResume, syncLabel, timeOf } from './offline/core';
import { openStore, type OfflineStore } from './offline/store';
import {
  CollectorSync,
  adoptDefinition,
  defaultContext,
  ensureDraft,
  recordAnswers,
  requestSubmit,
  type Transport,
} from './offline/sync';
import type { StoredDraft, SyncOutcome } from './offline/types';

/**
 * The collection renderer, offline-first.
 *
 * Logic is evaluated with the *same* engine the server uses, so what a respondent
 * sees here and what the server stores cannot disagree: hidden questions disappear,
 * cascading selects filter, required questions block submission. The server still
 * re-checks all of it on submit: this is the ergonomics, not the authority.
 *
 * Every answer is written to IndexedDB the moment it is typed, and a small durable
 * queue sends it on. With no network the form still renders (the published
 * definition was cached on the last visit), still evaluates logic, still validates,
 * and still saves — and the header says plainly whether the server has the answers
 * or only this device does. Nothing is ever dropped silently.
 */

const UPLOAD_TYPES = new Set(['image', 'audio', 'video', 'file']);
const GEO_TYPES = new Set(['geopoint', 'geotrace', 'geoshape']);
const AUTOSAVE_MS = 120_000;

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

function Offline({ hasDraft }: { hasDraft: boolean }): JSX.Element {
  return (
    <div className="collect">
      <div className="card">
        <h1>You are offline</h1>
        <p className="muted">
          {hasDraft
            ? 'Your answers are saved on this device. Open this page again once you have a connection and they will be sent automatically.'
            : 'This survey needs to be opened once with a connection before it can be filled in offline. Please try again when you have signal.'}
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
  const [draft, setDraft] = useState<StoredDraft | null>(null);
  const [status, setStatus] = useState<string>('in_progress');
  const [problems, setProblems] = useState<{ missing: string[]; invalid: string[] }>({ missing: [], invalid: [] });
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<{ code: string; message: string } | null>(null);
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  const [syncing, setSyncing] = useState(false);
  const [outcome, setOutcome] = useState<SyncOutcome | null>(null);
  const [busy, setBusy] = useState(false);

  const storeRef = useRef<OfflineStore | null>(null);
  const syncRef = useRef<CollectorSync | null>(null);
  const draftRef = useRef<StoredDraft | null>(null);
  const answersRef = useRef<Record<string, unknown>>({});
  const timer = useRef<number | null>(null);

  draftRef.current = draft;
  answersRef.current = answers;

  const transport = useMemo<Transport>(
    () => ({
      async start(t, clientId, payload) {
        const res = await api.startResponse(t, clientId, payload.answers, payload.base);
        setOnline(true);
        return { responseId: res.responseId, status: res.status as StoredDraft['status'] };
      },
      async save(t, responseId, payload) {
        const res = await api.saveResponse(t, responseId, payload.answers, payload.base);
        setOnline(true);
        return res;
      },
      async submit(t, responseId, payload) {
        const res = await api.submitResponse(t, responseId, payload.answers, payload.base);
        setOnline(true);
        return { status: res.status as StoredDraft['status'] };
      },
    }),
    [],
  );

  const ctx = useMemo(() => defaultContext(), []);

  /**
   * Pushes whatever is queued. Safe to call on every keystroke, focus and
   * reconnect: the runner is a no-op when nothing is due.
   */
  const flush = useCallback(async (): Promise<SyncOutcome | null> => {
    const store = storeRef.current;
    if (!store) return null;
    if (!syncRef.current) syncRef.current = new CollectorSync(store, token, transport, ctx);
    setSyncing(true);
    try {
      const result = await syncRef.current.flush();
      const latest = await store.getDraft(token);
      if (latest) {
        setDraft(latest);
        setStatus(latest.status);
      }
      setOutcome(result);
      if (result.missing.length > 0 || result.invalid.length > 0) {
        setProblems({ missing: result.missing, invalid: result.invalid });
      }
      return result;
    } finally {
      setSyncing(false);
    }
  }, [token, transport, ctx]);

  const scheduleFlush = useCallback(
    (delay: number) => {
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        void flush();
      }, delay);
    },
    [flush],
  );

  /* ----------------------------------------------------------------- lifecycle */

  useEffect(() => {
    let cancelled = false;

    const boot = async (): Promise<void> => {
      const store = await openStore();
      if (cancelled) return;
      storeRef.current = store;

      // A response id kept by an older build in localStorage is adopted, so an
      // upgrade mid-interview does not abandon work already in progress.
      const legacy = window.localStorage.getItem(storageKey(token));
      let local = await ensureDraft(store, token, legacy);
      if (cancelled) return;
      setDraft(local);
      setAnswers(local.answers);
      setStatus(local.status);

      // Paint from the cached definition first: it is what makes the form usable
      // before the network answers, and with no network at all.
      const cached = await store.getCachedForm(token);
      if (cached && !cancelled) setDefinition(cached.definition as Definition);

      try {
        const loaded = await api.collectForm(token);
        if (cancelled) return;
        setDefinition(loaded.form.definition);
        setOnline(true);
        await adoptDefinition(store, token, {
          title: loaded.form.title,
          version: loaded.form.version,
          definition: loaded.form.definition,
          linkKind: loaded.link?.kind ?? 'anonymous',
        });
        if (local.responseId) {
          const server = await api.resumeResponse(token, local.responseId);
          if (!cancelled && server.status) {
            local = resolveResume(local, { answers: server.answers ?? {}, status: server.status as StoredDraft['status'] });
            await store.putDraft(local);
            setDraft(local);
            setAnswers(local.answers);
            setStatus(local.status);
          }
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError) {
          // The server answered, so the answer is final: expired, closed, used,
          // or not published. Each one has a sentence a respondent understands.
          setUnavailable({ code: err.code, message: err.message ?? 'This survey cannot be opened right now.' });
          return;
        }
        // A network failure is not an answer. Fall back to the cached copy, and
        // if there is none, say so plainly rather than showing a spinner forever.
        setOnline(false);
      }

      void flush();
    };

    void boot();
    return () => {
      cancelled = true;
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [token, flush]);

  useEffect(() => {
    const onOnline = (): void => {
      setOnline(true);
      void flush();
    };
    const onOffline = (): void => setOnline(false);
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void flush();
    };
    const onHide = (): void => void flush();
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      window.removeEventListener('pagehide', onHide);
    };
  }, [flush]);

  // Autosave on a timer as well as on change, so a respondent who types one
  // answer and then thinks for ten minutes still has it on the server.
  useEffect(() => {
    const id = window.setInterval(() => void flush(), AUTOSAVE_MS);
    return () => window.clearInterval(id);
  }, [flush]);

  const form = definition as unknown as FormDefinition | null;
  const evaluation = useMemo(() => (form ? evaluateForm(form, answers) : null), [form, answers]);

  /* ------------------------------------------------------------------- writing */

  const update = (name: string, value: unknown): void => {
    const next = { ...answers, [name]: value };
    setAnswers(next);
    const store = storeRef.current;
    if (!store) return;
    // Persist before anything else: the device is the only copy until the server
    // acknowledges, and that must not depend on a timer or a network.
    void recordAnswers(store, token, next, [name]).then((saved) => {
      setDraft(saved);
    });
    scheduleFlush(1200);
  };

  const submit = async (): Promise<void> => {
    const store = storeRef.current;
    if (!store || status !== 'in_progress') return;
    setBusy(true);
    setError(null);
    setProblems({ missing: [], invalid: [] });
    try {
      await requestSubmit(store, token, answers, Object.keys(answers));
      const result = await flush();
      if (result && result.missing.length === 0 && result.invalid.length === 0) {
        setStatus(result.status);
      }
      if (result && result.status !== 'in_progress') {
        window.localStorage.removeItem(storageKey(token));
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'your answers could not be submitted just now: they are still on this device');
    } finally {
      setBusy(false);
    }
  };

  /* ----------------------------------------------------------------- rendering */

  if (unavailable) return <Unavailable code={unavailable.code} message={unavailable.message} />;
  if (!definition) {
    // With no cached copy and no connection there is nothing honest to render;
    // an offline notice is better than an endless spinner.
    if (!online) return <Offline hasDraft={Boolean(draft && Object.keys(draft.answers).length > 0)} />;
    return <div className="card">Loading…</div>;
  }
  if (!form || !evaluation) return <div className="card">Loading…</div>;

  if (status && status !== 'in_progress') {
    const labels: Record<string, string> = {
      submitted: 'Thank you: your response was recorded.',
      screened_out: 'Thank you. You are not eligible for the rest of this survey.',
      quota_full: 'Thank you. The quota for your group is now full.',
    };
    return (
      <div className="card">
        <h1>{labels[status] ?? 'Response recorded.'}</h1>
        <p className="muted">Reference: {draft?.responseId ?? draft?.clientId}</p>
        {outcome && outcome.conflicts > 0 && (
          <p className="muted small">Some answers were saved alongside a differing copy for review. Nothing was lost.</p>
        )}
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
      return <input type="file" disabled />;
    }

    if (GEO_TYPES.has(question.type)) {
      return (
        <div className="row">
          <input
            placeholder="latitude longitude"
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => update(question.name, e.target.value)}
            onBlur={() => void flush()}
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
        <select
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          onChange={(e) => update(question.name, e.target.value)}
          onBlur={() => void flush()}
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
                  update(
                    question.name,
                    e.target.checked ? [...selected, option.value] : selected.filter((v) => v !== option.value),
                  )
                }
                onBlur={() => void flush()}
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
        onBlur={() => void flush()}
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

  const waiting = draft ? pendingCount(draft.outbox) : 0;
  const savedAt = timeOf(draft?.updatedAt ?? null);
  const syncedAt = timeOf(draft?.syncedAt ?? null);

  return (
    <div className="collect">
      <header className="screen-head">
        <div>
          <span className="eyebrow">Survey</span>
          <h1>{definition.title}</h1>
          <p className="muted small">
            {savedAt && <>Saved on this device at {savedAt}. </>}
            {syncedAt ? <>The server has everything up to {syncedAt}.</> : <>Not sent to the server yet.</>}
          </p>
        </div>
        <div className="stack tight">
          <span className={online ? 'pill ok' : 'pill warn'} role="status" aria-live="polite">
            {draft ? syncLabel(draft, online, syncing) : 'Loading…'}
          </span>
          {(waiting > 0 || outcome?.phase === 'error') && (
            <button type="button" className="ghost" onClick={() => void flush()} disabled={!online}>
              {online ? 'Send now' : 'Waiting for a connection'}
            </button>
          )}
        </div>
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
      <div className="card row wrap">
        <button type="button" onClick={() => void submit()} disabled={busy}>
          {busy ? 'Submitting…' : 'Submit'}
        </button>
        {problems.missing.length > 0 && (
          <span className="stat">
            <strong>{problems.missing.length}</strong>
            {` required answer(s) still missing`}
          </span>
        )}
        {!online && <span className="muted">Your answers are safe on this device and will be sent automatically.</span>}
      </div>
    </div>
  );
}
