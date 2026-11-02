import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, api, type ReviewCorrection, type ReviewDetail, type ReviewQueue } from './api';

/**
 * Review and correction, as the supervisor sees it.
 *
 * The queue is separate from the flag queue on purpose. A flag is a detector's
 * claim about one response; a review is a person's decision about the whole
 * interview. A response can need review without a flag, and a severe flag can send
 * one into this queue. The two views share a response id, not a state machine.
 */

type QueueState = 'pending' | 'approved' | 'rejected' | 'none' | 'all';

function stateClass(state: string): string {
  if (state === 'approved') return 'pill ok';
  if (state === 'rejected') return 'pill error';
  if (state === 'pending') return 'pill';
  return 'pill';
}

function answerText(value: unknown): string {
  if (value === null || value === undefined) return '(blank)';
  if (Array.isArray(value)) return value.map(String).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function draftValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(String).join(', ');
  return String(value);
}

function isEditable(type: string, hasCalculate: boolean): boolean {
  return type !== 'note' && !hasCalculate;
}

function coerce(type: string, draft: string): unknown {
  if (draft.trim() === '') return null;
  if (type === 'integer') return Number.parseInt(draft, 10);
  if (type === 'decimal' || type === 'percentage' || type === 'currency') return Number(draft);
  if (type === 'select_multiple' || type === 'rank') {
    return draft.split(',').map((item) => item.trim()).filter(Boolean);
  }
  return draft;
}

export function ReviewPanel({
  orgId,
  formId,
  initialResponseId = null,
}: {
  orgId: string;
  formId: string;
  initialResponseId?: string | null;
}): JSX.Element {
  const [state, setState] = useState<QueueState>('pending');
  const [queue, setQueue] = useState<ReviewQueue | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(initialResponseId);
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadQueue = useCallback(async (): Promise<void> => {
    try {
      const next = await api.reviewQueue(orgId, formId, { state, limit: 100 });
      if (!next || !Array.isArray(next.responses)) return;
      setQueue(next);
      setSelectedId((current) => current ?? next.responses[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'the review queue could not be read');
    }
  }, [orgId, formId, state]);

  const loadDetail = useCallback(
    async (id: string): Promise<void> => {
      try {
        const next = await api.reviewResponse(orgId, formId, id);
        setDetail(next);
        setDrafts(
          Object.fromEntries(
            next.definition.questions
              .filter((question) => isEditable(question.type, Boolean(question.rules?.calculate)))
              .map((question) => [question.name, draftValue(next.answers[question.name])]),
          ),
        );
        setNote(next.response.reviewNote ?? '');
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'the response could not be opened');
      }
    },
    [orgId, formId],
  );

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
    else setDetail(null);
  }, [selectedId, loadDetail]);

  useEffect(() => {
    if (initialResponseId) setSelectedId(initialResponseId);
  }, [initialResponseId]);

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message ?? err.code
          : err instanceof Error
            ? err.message
            : 'that did not work',
      );
    } finally {
      setBusy(false);
    }
  };

  const act = (action: 'claim' | 'comment' | 'approve' | 'reject' | 'reopen'): Promise<void> =>
    run(async () => {
      if (!selectedId) return;
      const result = await api.reviewAction(orgId, formId, selectedId, {
        action,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      setNotice(`${action} recorded. This response is now ${result.response.reviewState}.`);
      await loadQueue();
      await loadDetail(selectedId);
    });

  const saveCorrections = (): Promise<void> =>
    run(async () => {
      if (!selectedId || !detail) return;
      const corrections: ReviewCorrection[] = [];
      for (const question of detail.definition.questions) {
        if (!isEditable(question.type, Boolean(question.rules?.calculate))) continue;
        const draft = drafts[question.name] ?? '';
        const before = draftValue(detail.answers[question.name]);
        if (draft === before) continue;
        corrections.push({
          questionId: question.name,
          from: detail.answers[question.name] ?? null,
          to: coerce(question.type, draft),
          ...(note.trim() ? { reason: note.trim() } : {}),
        });
      }
      if (corrections.length === 0) throw new Error('Nothing changed. Edit an answer before saving.');
      const result = await api.correctResponse(orgId, formId, selectedId, {
        corrections,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      setNotice(`${result.corrections.length} correction${result.corrections.length === 1 ? '' : 's'} recorded. The original values are in the log.`);
      await loadDetail(selectedId);
      await loadQueue();
    });

  const summaries = useMemo(() => Object.entries(queue?.summary ?? {}), [queue?.summary]);

  return (
    <div className="stack">
      <div className="row wrap">
        <div className="grow">
          <span className="eyebrow">Review</span>
          <h3>Response review and correction</h3>
          <p className="muted small">
            A claim is exclusive, a decision is append-only, and a correction keeps the value it replaced. Nothing here
            rewrites the interview without a row saying who changed it and why.
          </p>
        </div>
        <label className="small muted">
          Queue
          <select value={state} onChange={(event) => setState(event.target.value as QueueState)}>
            <option value="pending">Pending</option>
            <option value="none">Not started</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
            <option value="all">All</option>
          </select>
        </label>
      </div>

      {summaries.length > 0 && (
        <div className="row wrap">
          {summaries.map(([name, counts]) => (
            <span key={name} className="pill">
              {name}: {counts.total} total, {counts.unclaimed} unclaimed
            </span>
          ))}
        </div>
      )}

      {error && <p className="error small" role="alert">{error}</p>}
      {notice && <p className="small muted" role="status">{notice}</p>}

      <div className="review-grid">
        <div className="card stack">
          <strong className="small">Queue</strong>
          {queue?.responses.length === 0 && <p className="muted small">Nothing in this queue.</p>}
          {queue && queue.responses.length > 0 && (
            <div className="review-list">
              {queue.responses.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={selectedId === item.id ? 'review-item active' : 'review-item'}
                  onClick={() => setSelectedId(item.id)}
                >
                  <span className="mono small">{item.id.slice(0, 8)}</span>
                  <span className={stateClass(item.reviewState)}>{item.reviewState}</span>
                  <span className="small muted">
                    v{item.formVersion} · {item.flags.total} flag{item.flags.total === 1 ? '' : 's'}
                  </span>
                  <span className="small">
                    {item.submittedAt
                      ? new Date(item.submittedAt).toLocaleDateString()
                      : new Date(item.startedAt).toLocaleDateString()}
                    {item.durationSeconds !== null ? ` · ${Math.round(item.durationSeconds)}s` : ''}
                  </span>
                  {item.claimedBy && <span className="small muted">claimed by {item.claimedBy}</span>}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="card stack">
          {!detail && <p className="muted small">Choose a response to open its answers, flags and history.</p>}
          {detail && (
            <>
              <div className="row wrap">
                <div className="grow">
                  <strong className="mono small">{detail.response.id.slice(0, 8)}</strong>
                  <div className="row wrap">
                    <span className={stateClass(detail.response.reviewState)}>{detail.response.reviewState}</span>
                    <span className="pill">{detail.response.status}</span>
                    <span className="pill">v{detail.response.formVersion}</span>
                    {detail.response.claimedBy && <span className="pill">claimed: {detail.response.claimedBy}</span>}
                    {detail.response.flags.severe > 0 && (
                      <span className="pill error">{detail.response.flags.severe} severe flag(s)</span>
                    )}
                  </div>
                </div>
                <div className="row wrap">
                  <button type="button" className="ghost" disabled={busy} onClick={() => void act('claim')}>
                    Claim
                  </button>
                  <button type="button" disabled={busy} onClick={() => void act('approve')}>
                    Approve
                  </button>
                  <button type="button" className="ghost" disabled={busy} onClick={() => void act('reject')}>
                    Reject
                  </button>
                  <button type="button" className="ghost" disabled={busy} onClick={() => void act('reopen')}>
                    Reopen
                  </button>
                </div>
              </div>

              <label className="small muted">
                Reviewer note
                <textarea
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  rows={2}
                  placeholder="What did you decide, and why?"
                />
              </label>
              <div className="row wrap">
                <button type="button" className="ghost" disabled={busy || note.trim() === ''} onClick={() => void act('comment')}>
                  Add comment
                </button>
                <button type="button" disabled={busy} onClick={() => void saveCorrections()}>
                  Save corrections
                </button>
              </div>

              <h4 className="small">Answers</h4>
              <div className="stack tight">
                {detail.definition.questions.map((question) => {
                  const editable = isEditable(question.type, Boolean(question.rules?.calculate));
                  return (
                    <label key={question.name} className="review-answer">
                      <span className="small">
                        {question.label?.[detail.definition.defaultLanguage] ?? Object.values(question.label ?? {})[0] ?? question.name}
                        <span className="muted"> · {question.name}</span>
                      </span>
                      {editable ? (
                        <input
                          value={drafts[question.name] ?? ''}
                          onChange={(event) =>
                            setDrafts((current) => ({ ...current, [question.name]: event.target.value }))
                          }
                        />
                      ) : (
                        <span className="mono small">{answerText(detail.answers[question.name])}</span>
                      )}
                    </label>
                  );
                })}
              </div>

              <h4 className="small">Flags</h4>
              {detail.flags.length === 0 ? (
                <p className="muted small">No flags on this response.</p>
              ) : (
                <table>
                  <thead>
                    <tr><th>Kind</th><th>Severity</th><th>Status</th><th>Evidence</th></tr>
                  </thead>
                  <tbody>
                    {detail.flags.map((flag) => (
                      <tr key={flag.id}>
                        <td className="small">{flag.kind.replace('_', ' ')}</td>
                        <td className="small">{flag.severity}</td>
                        <td className="small">{flag.status}</td>
                        <td className="small mono">{JSON.stringify(flag.detail)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              <h4 className="small">History</h4>
              {detail.log.length === 0 ? (
                <p className="muted small">No review decisions yet.</p>
              ) : (
                <div className="stack tight">
                  {detail.log.map((entry) => (
                    <div key={entry.id} className="review-log">
                      <strong className="small">{entry.action}</strong>
                      <span className="muted small">
                        {entry.actor ?? 'system'} · {new Date(entry.created_at).toLocaleString()}
                        {entry.from_state || entry.to_state
                          ? ` · ${entry.from_state ?? 'none'} -> ${entry.to_state ?? 'none'}`
                          : ''}
                      </span>
                      {entry.note && <span className="small">{entry.note}</span>}
                      {entry.corrections.length > 0 && (
                        <span className="small mono">
                          {entry.corrections.map((change) => `${change.questionId}: ${answerText(change.from)} -> ${answerText(change.to)}`).join(' · ')}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <h4 className="small">Field timings</h4>
              {detail.timings.length === 0 ? (
                <p className="muted small">No field timings recorded for this response.</p>
              ) : (
                <table>
                  <thead><tr><th>Field</th><th>Seconds</th><th>First seen</th><th>Visits</th></tr></thead>
                  <tbody>
                    {detail.timings.map((timing) => (
                      <tr key={timing.field_name}>
                        <td className="small mono">{timing.field_name}</td>
                        <td className="small">{Number(timing.total_seconds).toFixed(1)}</td>
                        <td className="small">{timing.first_seen_seconds === null ? '' : Number(timing.first_seen_seconds).toFixed(1)}</td>
                        <td className="small">{timing.visits}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
