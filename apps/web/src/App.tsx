import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiError,
  api,
  download,
  type FormSummary,
  type MailDelivery,
  type PublicMailStatus,
  type Organisation,
  type TermsStatus,
  type VersionSummary,
} from './api';
import { Collect } from './collect';
import { AdminView } from './admin';
import { InvitePage, LegalPage, TermsGate } from './legal';

/**
 * The workspace shell: sign in, pick an organisation, author a form, publish it,
 * collect responses, watch the numbers arrive, export.
 *
 * Every count on this screen comes from a live query or a short poll against the
 * server. There is no cached snapshot and no seed data: if it says 3 responses,
 * three responses exist.
 */

interface Me {
  user: { id: string; email: string; displayName: string | null };
  organisations: Organisation[];
}

function usePoll<T>(load: () => Promise<T>, ms: number, deps: unknown[]): { data: T | null; error: string | null; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let cancelled = false;
    const run = async (): Promise<void> => {
      try {
        const result = await loadRef.current();
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'request failed');
      }
    };
    void run();
    const timer = window.setInterval(() => void run(), ms);
    // A background tab has its timers throttled (or frozen), so the first thing a
    // returning reader saw could be a snapshot from minutes ago. Refresh the
    // moment the tab becomes visible again, and again if the window is refocused:
    // the numbers on screen are then always the server's current ones.
    const refreshIfVisible = (): void => {
      if (document.visibilityState === 'visible') void run();
    };
    document.addEventListener('visibilitychange', refreshIfVisible);
    window.addEventListener('focus', refreshIfVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshIfVisible);
      window.removeEventListener('focus', refreshIfVisible);
    };
    // The caller passes the identity of what it polled; `tick` is the manual refresh.
  }, [...deps, tick]);

  return { data, error, reload: () => setTick((n) => n + 1) };
}

const CODE_LENGTH = 6;

/**
 * Six separate boxes, one digit each.
 *
 * Why not a single field: autofill treats a lone input as fair game: password
 * managers, browser heuristics and the previous dev echo all "typed" it for the
 * user. Separate read-only-ish single-char inputs with `autoComplete="one-time-code"`
 * make that impossible and match what users see on every major platform; paste
 * of a full code is still handled, because it is the user who pastes.
 */
function OtpInput({
  code,
  onCode,
  onSubmit,
  disabled,
}: {
  code: string;
  onCode: (v: string) => void;
  onSubmit: () => void;
  disabled: boolean;
}): JSX.Element {
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  const digits = Array.from({ length: CODE_LENGTH }, (_, i) => code[i] ?? '');

  const focusAt = (i: number): void => {
    const next = Math.max(0, Math.min(CODE_LENGTH - 1, i));
    refs.current[next]?.focus();
    refs.current[next]?.select();
  };

  const write = (i: number, raw: string): void => {
    const chars = raw.replace(/\D/g, '');
    if (!chars) return;
    const arr = [...digits];
    // Typing one digit advances; pasting/typing a run fills from this box.
    chars.split('').forEach((c, k) => {
      if (i + k < CODE_LENGTH) arr[i + k] = c;
    });
    onCode(arr.join(''));
    focusAt(i + chars.length);
  };

  return (
    <div className="otprow" role="group" aria-label="Six digit verification code">
      {digits.map((d, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          className="otpbox mono"
          value={d}
          // Length is reported by the browser as 1 for the caret box; a paste
          // may arrive longer, which write() handles by filling forward.
          onBeforeInput={(e) => {
            // React models this as FormEvent; whatever arrives, a multi-char
            // input is only ever a paste, which onPaste already handles.
            const target = e.target as HTMLInputElement;
            const data = 'data' in e ? String((e as unknown as { data: string }).data) : target.value;
            if (data && data.length > 1) e.preventDefault();
          }}
          onChange={(e) => write(i, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Backspace') {
              e.preventDefault();
              const arr = [...digits];
              if (arr[i]) {
                arr[i] = '';
                onCode(arr.join(''));
                focusAt(i);
              } else if (i > 0) {
                arr[i - 1] = '';
                onCode(arr.join(''));
                focusAt(i - 1);
              }
            } else if (e.key === 'ArrowLeft') focusAt(i - 1);
            else if (e.key === 'ArrowRight') focusAt(i + 1);
            else if (e.key === 'Enter' && code.length === CODE_LENGTH) onSubmit();
          }}
          onPaste={(e) => {
            const text = e.clipboardData.getData('text').replace(/\D/g, '');
            if (text.length > 1) {
              e.preventDefault();
              write(0, text.slice(0, CODE_LENGTH));
            }
          }}
          onFocus={(e) => e.currentTarget.select()}
          disabled={disabled}
          inputMode="numeric"
          autoComplete="one-time-code"
          // Not a password and not user-specific: keep browser autofill away
          // entirely, since this value must come from the e-mail.
          name="otp"
          maxLength={1}
          pattern="[0-9]"
          placeholder="•"
        />
      ))}
    </div>
  );
}

function Login({ onSignedIn }: { onSignedIn: () => void }): JSX.Element {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'email' | 'code'>('email');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mail, setMail] = useState<PublicMailStatus | null>(null);
  const [delivery, setDelivery] = useState<MailDelivery | null>(null);

  // Ask whether email works *before* anyone waits for an inbox. An environment
  // with no relay used to answer "sent" and deliver nothing.
  useEffect(() => {
    let cancelled = false;
    void api
      .mailStatus()
      .then((status) => {
        if (!cancelled) setMail(status);
      })
      .catch(() => {
        if (!cancelled) setMail(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const request = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.requestOtp(email);
      setStage('code');
      setDelivery(res.delivery);
      if (res.delivery.ok) {
        setNotice(`We sent a 6 digit code to ${email}. It expires in 10 minutes.`);
      } else {
        setNotice(null);
        // No provider text and no echo here: the login page is public, and the
        // detail belongs to whoever runs the deployment, not to a visitor.
        setError('We could not send a code to that address. Check the address and try again.');
      }
    } catch (err) {
      setError(err instanceof ApiError ? (err.message ?? err.code) : 'could not send the code');
    } finally {
      setBusy(false);
    }
  };

  const verify = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.verifyOtp(email, code);
      onSignedIn();
    } catch (err) {
      setError(err instanceof ApiError ? 'That code did not work.' : 'could not sign in');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth card">
      <h1>Inicio</h1>
      <p className="muted">Multi-tenant survey and data-collection platform. Any email works.</p>
      {mail && !mail.reachable && mail.basis !== 'none' && (
        <p className="warn small">
          {/* Production wording. The relay, the transport and the reason are
              operational detail: the administrator sees them in the admin
              console, an anonymous visitor is told only what they can act on. */}
          <strong>Sign in codes cannot be sent right now.</strong> Please try again shortly. If it keeps failing,
          contact your organisation administrator.
        </p>
      )}

      {stage === 'email' ? (
        <>
          <label>Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          <button type="button" onClick={() => void request()} disabled={busy || email.length < 3}>
            {busy ? 'Sending…' : 'Send me a code'}
          </button>
        </>
      ) : (
        <>
          <label>{delivery?.ok ? `Six-digit code sent to ${email}` : `Code for ${email}`}</label>
          <OtpInput code={code} onCode={(v) => setCode(v)} onSubmit={() => void verify()} disabled={busy} />
          <button type="button" onClick={() => void verify()} disabled={busy || code.length !== 6}>
            {busy ? 'Checking…' : 'Sign in'}
          </button>
        </>
      )}
      {notice && <p className="muted small">{notice}</p>}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

function DefinitionEditor({
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
  const [report, setReport] = useState<{ errors: string[]; warnings: string[] } | null>(null);
  const [loadedVersion, setLoadedVersion] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Unsaved keystrokes must never be clobbered by a background refresh.
  const dirty = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.version(formId, version.id);
        if (cancelled || dirty.current) return;
        setText(JSON.stringify(res.version.definition, null, 2));
        setReport(null);
        setLoadedVersion(version.id);
      } catch {
        // The parent surfaces the error; the editor keeps whatever it has.
      }
    })();
    return () => {
      cancelled = true;
    };
    // `revision` and the question count are what change when an import rewrites
    // this same version in place. Without them the JSON below went stale while
    // the stored definition had already moved on.
  }, [formId, version.id, version.question_count, revision]);

  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const parsed: unknown = JSON.parse(text);
      const res = await api.saveVersion(formId, version.id, parsed);
      // Show exactly what was stored (the server canonicalises), so the preview
      // is a fact about the database rather than a fact about the textarea.
      if (res.version?.definition) setText(JSON.stringify(res.version.definition, null, 2));
      dirty.current = false;
      setReport({ errors: res.errors, warnings: res.warnings });
    } catch (err) {
      setReport({ errors: [err instanceof ApiError ? (err.message ?? 'could not save') : 'That is not valid JSON.'], warnings: [] });
    } finally {
      setBusy(false);
    }
  };

  const immutable = version.status === 'published';

  return (
    <div className="stack">
      <p className="muted small">
        The form definition is JSON: the same model the XLSForm importer produces, so a spreadsheet and this editor
        are two views of one thing. Publishing runs the analyser below.
      </p>
      {immutable && (
        <p className="warn small">
          This version is published and cannot be edited: responses already record it. Use{' '}
          <strong>New draft from published</strong> to make changes.
        </p>
      )}
      {loadedVersion !== version.id && <p className="muted">Loading...</p>}
      <textarea
        value={text}
        onChange={(e) => {
          dirty.current = true;
          setText(e.target.value);
        }}
        spellCheck={false}
        rows={22}
      />
      <div className="row">
        <button type="button" onClick={() => void save()} disabled={busy || immutable}>
          {busy ? 'Saving…' : immutable ? 'Published (immutable)' : 'Save draft'}
        </button>
        <button type="button" className="ghost" onClick={() => void download(`/forms/${formId}/xlsform?versionId=${version.id}`, 'form.xlsx')}>
          Download .xlsx
        </button>
      </div>
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
  );
}

/** Resolve a stored question name to the label the author wrote. */
function questionLabel(
  definition: { defaultLanguage?: string; questions?: Array<{ name: string; label?: Record<string, string> }> } | null,
  name: string,
): string {
  const question = definition?.questions?.find((q) => q.name === name);
  const language = definition?.defaultLanguage ?? 'en';
  return question?.label?.[language] ?? question?.label?.en ?? name;
}

/** A tally value is whatever was stored: a scalar, a multi-select list, or nothing. */
function formatTally(value: unknown): string {
  if (value === null || value === undefined || value === '') return '(blank)';
  if (Array.isArray(value)) return value.length ? value.map((v) => String(v)).join(', ') : '(blank)';
  return String(value);
}

function DataTab({ formId, publishedVersion }: { formId: string; publishedVersion: number | null }): JSX.Element {
  const { data, error, reload } = usePoll(() => api.responses(formId), 5000, [formId]);
  // The same live tables, read a second way: status counts, per-answer tallies and
  // a daily timeline, recomputed by the server on every request. Kept on its own
  // poll so a slow export cannot hold up the numbers.
  const { data: analytics } = usePoll(() => api.analytics(formId), 10_000, [formId]);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  // An export descends from a published version, so there is nothing to export
  // until one exists. Saying why up front beats a failed download.
  const canExport = publishedVersion !== null;

  const tally = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of data?.counts ?? []) counts.set(row.status, row.count);
    return counts;
  }, [data]);

  const exportAs = async (format: string): Promise<void> => {
    setDownloadError(null);
    try {
      await download(`/forms/${formId}/responses/export?format=${format}`, `export.${format === 'csv' ? 'zip' : format}`);
    } catch (err) {
      setDownloadError(err instanceof ApiError ? (err.message ?? err.code) : 'export failed');
    }
  };

  return (
    <div className="stack">
      <div className="row wrap">
        {['submitted', 'in_progress', 'screened_out', 'quota_full'].map((status) => (
          <span key={status} className="stat">
            <strong>{tally.get(status) ?? 0}</strong> {status.replace('_', ' ')}
          </span>
        ))}
        <span className="muted small">live · refreshed every 5s</span>
        <button type="button" className="ghost" onClick={reload}>
          Refresh
        </button>
      </div>

      {!canExport && (
        <p className="warn small">
          <strong>Nothing to export yet.</strong> Responses are collected against a published version. Open the{' '}
          <strong>Builder</strong> tab and publish this form, then collect responses here.
        </p>
      )}

      <div className="row wrap">
        <button type="button" onClick={() => void exportAs('csv')} disabled={!canExport}>
          Export CSV bundle (.zip)
        </button>
        <button type="button" onClick={() => void exportAs('xlsx')} disabled={!canExport}>
          Export .xlsx
        </button>
        <button type="button" onClick={() => void exportAs('json')} disabled={!canExport}>
          Export .json
        </button>
        <button type="button" disabled title="SPSS .sav needs the pyreadstat export worker">
          Export .sav (unavailable)
        </button>
      </div>
      <p className="muted small">
        {canExport ? `Exports are built from the published version${publishedVersion ? ` v${publishedVersion}` : ''}. ` : ''}
        The CSV export is a bundle: data, codebook, value labels, the missing-code table and metadata: plus a
        spreadsheet-safe copy where formula-looking cells are neutralised. .sav/.dta are refused rather than faked.
      </p>
      {downloadError && <p className="error small">{downloadError}</p>}
      {error && <p className="error small">{error}</p>}

      <div className="card">
        <div className="row wrap">
          <strong>Live answers</strong>
          {analytics && (
            <span className="muted small">read from the database at {new Date(analytics.generatedAt).toLocaleTimeString()}</span>
          )}
        </div>
        {analytics && !analytics.publishedVersion && (
          <p className="muted small">Answers appear here once a version is published and responses arrive.</p>
        )}
        {analytics && analytics.publishedVersion !== null && analytics.tallies.length === 0 && (
          <p className="muted small">No submitted answers yet.</p>
        )}
        {analytics && analytics.tallies.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Question</th>
                <th>Answer</th>
                <th>Count</th>
              </tr>
            </thead>
            <tbody>
              {analytics.tallies.map((row) => (
                <tr key={`${row.question_id}:${String(row.value)}`}>
                  <td className="small">{questionLabel(analytics.definition, row.question_id)}</td>
                  <td className="small">{formatTally(row.value)}</td>
                  <td>{row.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {analytics && analytics.timeline.length > 0 && (
          <p className="muted small">
            Activity (submitted/started):{' '}
            {analytics.timeline.slice(-7).map((d) => `${d.day} ${d.submitted}/${d.started}`).join(' · ')}
          </p>
        )}
      </div>

      <table>
        <thead>
          <tr>
            <th>Response</th>
            <th>Status</th>
            <th>Version</th>
            <th>Started</th>
            <th>Answers</th>
          </tr>
        </thead>
        <tbody>
          {(data?.responses ?? []).map((row) => (
            <tr key={row.id}>
              <td className="mono small">{row.id.slice(0, 8)}</td>
              <td>{row.status}</td>
              <td>v{row.form_version}</td>
              <td className="small">{new Date(row.started_at).toLocaleString()}</td>
              <td className="small mono">{JSON.stringify(row.answers)}</td>
            </tr>
          ))}
          {(data?.responses ?? []).length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                {canExport
                  ? 'No responses yet. Create a link in the Distribute tab.'
                  : 'No responses yet, and none can arrive until this form is published.'}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function DistributeTab({ formId, publishedVersion }: { formId: string; publishedVersion: number | null }): JSX.Element {
  const { data, reload, error } = usePoll(() => api.links(formId), 15_000, [formId]);
  const [kind, setKind] = useState('anonymous');
  const [created, setCreated] = useState<{ url: string; warning: string } | null>(null);

  // A link to an unpublished form opens to "this survey is not open yet", which
  // is a dead end for whoever received it. Publishing is one click away, so the
  // honest thing is to say that here rather than hand out a broken link.
  const canDistribute = publishedVersion !== null;

  const create = async (): Promise<void> => {
    const res = await api.createLink(formId, kind);
    setCreated({ url: `${window.location.origin}${res.collectPath.replace('/api/v1', '')}`, warning: res.warning });
    reload();
  };

  return (
    <div className="stack">
      {!canDistribute && (
        <p className="warn small">
          <strong>Publish this form first.</strong> A link to an unpublished survey opens a page that says the survey is
          not open, so no responses can arrive. Open the <strong>Builder</strong> tab, publish a version, and come back
          here.
        </p>
      )}
      <div className="row wrap">
        <select value={kind} onChange={(e) => setKind(e.target.value)} disabled={!canDistribute}>
          <option value="anonymous">Anonymous: reusable public link</option>
          <option value="single_use">Single use: one response per link</option>
          <option value="multiple">Multiple completes: reusable, per respondent</option>
          <option value="panel">Panel: captures pid/ticket from the query string</option>
        </select>
        <button type="button" onClick={() => void create()} disabled={!canDistribute}>
          Create link
        </button>
        {canDistribute && <span className="muted small">Live against published v{publishedVersion}.</span>}
      </div>

      {created && (
        <div className="card ok">
          <p>{created.warning}</p>
          <div className="row">
            <input readOnly value={created.url} className="grow" onFocus={(e) => e.target.select()} />
            <button type="button" className="ghost" onClick={() => void navigator.clipboard?.writeText(created.url)}>
              Copy
            </button>
          </div>
          <p className="small muted">Only its hash is stored, so it cannot be shown again after you leave this screen.</p>
        </div>
      )}
      {error && <p className="error small">{error}</p>}

      <table>
        <thead>
          <tr>
            <th>Kind</th>
            <th>Label</th>
            <th>Uses</th>
            <th>Active</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(data?.links ?? []).map((link) => (
            <tr key={link.id}>
              <td>{link.kind}</td>
              <td>{link.label ?? '-'}</td>
              <td>
                {link.uses}
                {link.max_uses ? ` / ${link.max_uses}` : ''}
              </td>
              <td>{link.active ? 'yes' : 'no'}</td>
              <td>
                {link.active && (
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => void api.deactivateLink(formId, link.id).then(reload)}
                  >
                    Deactivate
                  </button>
                )}
              </td>
            </tr>
          ))}
          {(data?.links ?? []).length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                {canDistribute ? 'No links yet.' : 'No links yet, and none can be created until this form is published.'}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function FormView({ form, onBack }: { form: FormSummary; onBack: () => void }): JSX.Element {
  const { data, reload, error } = usePoll(() => api.form(form.id), 10_000, [form.id]);
  const [tab, setTab] = useState<'builder' | 'data' | 'distribute'>('builder');
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Bumped whenever the server rewrites the selected version in place, so the
  // JSON preview re-reads instead of showing a definition that no longer exists.
  const [editorRevision, setEditorRevision] = useState(0);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const versions = data?.versions ?? [];
  const selected = versions.find((v) => v.id === selectedVersionId) ?? versions.find((v) => v.status === 'draft') ?? versions[0];
  // What respondents actually answer. Null means the form cannot collect yet.
  const published = versions.find((v) => v.status === 'published') ?? null;

  const publish = async (): Promise<void> => {
    if (!selected) return;
    setNotice(null);
    try {
      const res = await api.publish(form.id, selected.id);
      setNotice(
        res.version
          ? `Published version ${res.version.version}. This form is now open: create a link in the Distribute tab.`
          : 'That version is already published.',
      );
      setEditorRevision((n) => n + 1);
      reload();
    } catch (err) {
      setNotice(err instanceof ApiError ? (err.message ?? 'publish failed') : 'publish failed');
    }
  };

  const newDraft = async (): Promise<void> => {
    const res = await api.newVersion(form.id);
    setSelectedVersionId(res.version.id);
    reload();
  };

  interface ImportResult {
    notes?: Array<{ kind: string; message: string }>;
    error?: string;
    versionId?: string;
    definition?: { questions?: unknown[] };
  }

  const importFile = async (file: File): Promise<void> => {
    setNotice(null);
    try {
      const buffer = await file.arrayBuffer();
      // btoa needs a binary string; chunk it so a large workbook cannot blow the stack.
      let binary = '';
      const bytes = new Uint8Array(buffer);
      for (let i = 0; i < bytes.length; i += 8192) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      }
      const res = await fetch(`/api/v1/forms/${form.id}/import`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ xlsformBase64: btoa(binary), versionId: selected?.status === 'draft' ? selected.id : null }),
      });
      const body = (await res.json().catch(() => null)) as ImportResult | null;
      if (!res.ok) {
        setNotice(body?.error ?? `Import failed (${res.status}).`);
        return;
      }
      const questions = body?.definition?.questions?.length ?? 0;
      const notes = body?.notes ?? [];
      // Land on the version that was actually written. An import into a published
      // form creates a new draft, and staying on the old selection made a
      // successful import look like nothing happened.
      if (body?.versionId) setSelectedVersionId(body.versionId);
      setEditorRevision((n) => n + 1);
      reload();

      if (questions === 0) {
        setNotice(
          'Imported, but the workbook produced no questions. Check that it has a `survey` sheet with `type` and `name` columns.',
        );
        return;
      }
      const summary = `Imported ${questions} question(s).`;
      setNotice(
        notes.length === 0
          ? `${summary} Nothing needed adjusting.`
          : `${summary} ${notes.length} note(s): ${notes.map((n) => `${n.kind}: ${n.message}`).join(' · ')}`,
      );
    } catch (err) {
      setNotice(err instanceof Error ? `Import failed: ${err.message}` : 'Import failed.');
    }
  };

  return (
    <div className="stack grow">
      <div className="row wrap">
        <button type="button" className="ghost" onClick={onBack}>
          ← Forms
        </button>
        <h2>{form.name}</h2>
        <span className="muted small">{form.organisation}</span>
        {published ? (
          <span className="pill ok">published v{published.version} · collecting</span>
        ) : (
          <span className="pill">draft only · not collecting yet</span>
        )}
      </div>

      <nav className="tabs">
        {(['builder', 'data', 'distribute'] as const).map((name) => (
          <button key={name} type="button" className={tab === name ? 'tab active' : 'tab'} onClick={() => setTab(name)}>
            {name === 'builder' ? 'Builder' : name === 'data' ? 'Responses & exports' : 'Distribute'}
          </button>
        ))}
      </nav>

      {error && <p className="error small">{error}</p>}
      {notice && <p className="small muted">{notice}</p>}

      {tab === 'builder' && (
        <div className="stack">
          {!published && (
            <p className="warn small">
              <strong>This form is not collecting yet.</strong> Nothing is published, so any survey link shows
              &ldquo;this survey is not open&rdquo;. Publish a version below to open it for responses.
            </p>
          )}
          <div className="row wrap">
            <button type="button" className="ghost" onClick={() => void newDraft()}>
              New draft from published
            </button>
            <button type="button" onClick={() => void publish()} disabled={!selected || selected.status === 'published'}>
              {selected?.status === 'published' ? 'Already published' : 'Publish this version'}
            </button>
            <button type="button" className="ghost" onClick={() => fileInput.current?.click()}>
              Import .xlsx (XLSForm)
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".xlsx"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void importFile(file);
                e.target.value = '';
              }}
            />
          </div>

          <ul className="versions">
            {versions.map((version) => (
              <li key={version.id}>
                <button
                  type="button"
                  className={version.id === selected?.id ? 'tab active' : 'tab'}
                  onClick={() => setSelectedVersionId(version.id)}
                >
                  v{version.version} · {version.status} · {version.question_count} question(s)
                </button>
              </li>
            ))}
          </ul>

          {selected && <DefinitionEditor formId={form.id} version={selected} revision={editorRevision} />}
        </div>
      )}

      {tab === 'data' && <DataTab formId={form.id} publishedVersion={published?.version ?? null} />}
      {tab === 'distribute' && <DistributeTab formId={form.id} publishedVersion={published?.version ?? null} />}
    </div>
  );
}

function Workspace({ me, onSignedOut }: { me: Me; onSignedOut: () => void }): JSX.Element {
  const [orgs, setOrgs] = useState<Organisation[]>(me.organisations);
  const [orgId, setOrgId] = useState<string | null>(me.organisations[0]?.id ?? null);
  const [formId, setFormId] = useState<string | null>(null);
  const [newOrgName, setNewOrgName] = useState('');
  const [newFormName, setNewFormName] = useState('');
  const [templateId, setTemplateId] = useState('school-ranking-2026');
  const [sideNotice, setSideNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const [showAdmin, setShowAdmin] = useState(false);
  const currentOrg = orgs.find((o) => o.id === orgId) ?? null;
  // The menu entry is hidden for members and viewers, and the server refuses the
  // same calls independently. Hiding a button is a courtesy, not a control.
  const canAdminister = currentOrg?.role === 'owner' || currentOrg?.role === 'admin';

  const { data: forms, reload: reloadForms } = usePoll(() => api.forms(), 10_000, [orgId]);
  const { data: templates } = usePoll(() => api.templates(), 300_000, []);
  const selectedForm: FormSummary | null = (forms?.forms ?? []).find((f) => f.id === formId) ?? null;
  const orgForms = (forms?.forms ?? []).filter((f) => !orgId || f.org_id === orgId);

  const createOrg = async (): Promise<void> => {
    const res = await api.createOrg(newOrgName);
    const refreshed = await api.me();
    setOrgs(refreshed.organisations);
    setOrgId(res.organisation.id);
    setNewOrgName('');
  };

  const createForm = async (): Promise<void> => {
    if (!orgId) return;
    setSideNotice(null);
    try {
      const res = await api.createForm({ orgId, name: newFormName, templateId: templateId || undefined });
      setNewFormName('');
      setFormId(res.form.id);
      setSideNotice({ kind: 'ok', text: `Created "${newFormName}". Publish it in the Builder to start collecting.` });
      reloadForms();
    } catch (err) {
      setSideNotice({ kind: 'error', text: err instanceof ApiError ? (err.message ?? 'could not create the form') : 'could not create the form' });
    }
  };

  const uploadForm = async (file: File): Promise<void> => {
    if (!orgId) return;
    setSideNotice(null);
    try {
      const buffer = await file.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(buffer);
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      const res = await api.createForm({ orgId, name: file.name.replace(/\.xlsx$/i, ''), xlsformBase64: btoa(binary) });
      setFormId(res.form.id);
      setSideNotice({ kind: 'ok', text: `Imported "${file.name}". Review it, then publish to start collecting.` });
      reloadForms();
    } catch (err) {
      setSideNotice({ kind: 'error', text: err instanceof ApiError ? (err.message ?? 'import failed') : 'import failed' });
    }
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">Inicio</div>
        <p className="muted small">{me.user.email}</p>
        <label className="small muted">Organisation</label>
        <select value={orgId ?? ''} onChange={(e) => { setOrgId(e.target.value); setFormId(null); }}>
          {orgs.map((org) => (
            <option key={org.id} value={org.id}>
              {org.name} ({org.role})
            </option>
          ))}
        </select>
        <div className="row">
          <input placeholder="New organisation" value={newOrgName} onChange={(e) => setNewOrgName(e.target.value)} />
          <button type="button" className="ghost" onClick={() => void createOrg()} disabled={newOrgName.length < 2}>
            Add
          </button>
        </div>

        <label className="small muted">Forms</label>
        <ul className="list">
          {orgForms.map((form) => (
            <li key={form.id}>
              <button
                type="button"
                className={form.id === formId && !showAdmin ? 'tab active' : 'tab'}
                onClick={() => {
                  setFormId(form.id);
                  setShowAdmin(false);
                }}
              >
                {form.name}
                <span className="muted small"> · {form.submitted_count} submitted</span>
              </button>
            </li>
          ))}
          {orgForms.length === 0 && <li className="muted small">No forms in this organisation yet.</li>}
        </ul>

        <label className="small muted">New form</label>
        <input placeholder="Form name" value={newFormName} onChange={(e) => setNewFormName(e.target.value)} />
        <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
          <option value="">Blank form</option>
          {(templates?.templates ?? []).map((template) => (
            <option key={template.id} value={template.id}>
              {template.title} ({template.questionCount} questions)
            </option>
          ))}
        </select>
        <button type="button" onClick={() => void createForm()} disabled={newFormName.length < 2 || !orgId}>
          Create form
        </button>
        <button type="button" className="ghost" onClick={() => fileInput.current?.click()} disabled={!orgId}>
          Create from .xlsx
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".xlsx"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void uploadForm(file);
            e.target.value = '';
          }}
        />
        {sideNotice && (
          <p className={sideNotice.kind === 'error' ? 'error small' : 'muted small'}>{sideNotice.text}</p>
        )}

        {canAdminister && (
          <button
            type="button"
            className={showAdmin ? 'tab active' : 'tab'}
            onClick={() => {
              setShowAdmin(true);
              setFormId(null);
            }}
          >
            People and invitations
          </button>
        )}

        <button type="button" className="ghost" onClick={onSignedOut}>
          Sign out
        </button>
      </aside>

      <main className="main">
        {showAdmin && orgId ? (
          <AdminView orgId={orgId} canAdminister={canAdminister} />
        ) : selectedForm ? (
          <FormView form={selectedForm} onBack={() => setFormId(null)} />
        ) : (
          <div className="card">
            <h1>Your work</h1>
            <p className="muted">
              Pick a form on the left, or create one: blank, from a template such as the School Ranking Survey 2026, or
              by uploading an XLSForm workbook. Logic, validation and calculations run in the same engine on the client
              and the server, and the server is the authority when a response is submitted.
            </p>
            <ul>
              <li>Publish a version and it becomes immutable: responses always record the version they answered.</li>
              <li>Quotas count on submission; partial responses are first-class and exportable.</li>
              <li>Exports are bundles: data, codebook, value labels and a missing-code table.</li>
            </ul>
          </div>
        )}
      </main>
    </div>
  );
}

export function App(): JSX.Element {
  const collectMatch = useMemo(() => /^\/collect\/(.+)$/.exec(window.location.pathname), []);
  const inviteMatch = useMemo(() => /^\/invite\/(.+)$/.exec(window.location.pathname), []);
  const legalMatch = useMemo(() => /^\/(terms|privacy)$/.exec(window.location.pathname), []);
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [terms, setTerms] = useState<TermsStatus | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      setMe(await api.me());
    } catch {
      setMe(null);
    }
  }, []);

  useEffect(() => {
    if (!collectMatch && !inviteMatch && !legalMatch) void load();
  }, [collectMatch, inviteMatch, legalMatch, load]);

  // Whether the current terms still need accepting is a server answer, asked
  // once per session rather than trusted from the client.
  useEffect(() => {
    if (!me) return;
    let cancelled = false;
    void api
      .termsStatus()
      .then((status) => {
        if (!cancelled) setTerms(status);
      })
      .catch(() => {
        if (!cancelled) setTerms(null);
      });
    return () => {
      cancelled = true;
    };
  }, [me]);

  if (inviteMatch?.[1]) return <InvitePage token={decodeURIComponent(inviteMatch[1])} />;
  if (legalMatch?.[1]) return <LegalPage id={legalMatch[1] as 'terms' | 'privacy'} />;
  if (collectMatch?.[1]) return <Collect token={decodeURIComponent(collectMatch[1])} />;
  if (me === undefined) return <div className="card">Loading...</div>;
  if (me === null) return <Login onSignedIn={() => void load()} />;
  if (terms?.required) {
    return <TermsGate status={terms} onAccepted={() => setTerms({ ...terms, required: false })} />;
  }
  return (
    <Workspace
      me={me}
      onSignedOut={() => {
        void api.logout().finally(() => setMe(null));
      }}
    />
  );
}
