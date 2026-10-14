import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import {
  ApiError,
  api,
  authoriseAttachment,
  completeAttachment,
  uploadAttachment,
  type AttachmentCapability,
  type Definition,
} from './api';
import { RespondentForm } from './respondent';
import { attachmentOutcome, deviceState, resolveResume, retryText, storageHealth, timeOf, type StorageHealth } from './offline/core';
import { buildBackup, fileNameFor, restoreBackup } from './offline/backup';
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
 * The form itself is rendered by `./respondent`, the same component the console's
 * studio preview uses — so "what the respondent gets" is not a description that can
 * drift, it is one component. What lives here is everything around it: the definition
 * cache, the draft in IndexedDB, the durable outbox, and the header that says whether
 * the server has the answers or only this device does.
 *
 * Every answer is written to IndexedDB the moment it is typed, and a small durable
 * queue sends it on. With no network the form still renders (the published
 * definition was cached on the last visit), still evaluates logic, still validates,
 * and still saves — and the header says plainly whether the server has the answers
 * or only this device does. Nothing is ever dropped silently.
 */

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

/** What an upload is doing, in the respondent's language rather than the wire's. */
const UPLOAD_PHASE_LABELS: Record<'authorising' | 'uploading' | 'checking', string> = {
  authorising: 'getting permission to send it',
  uploading: 'sending it',
  checking: 'checking that it arrived',
};

/**
 * Why an attachment did not become an answer.
 *
 * Every server refusal is a different fact, and a respondent told "please try
 * again" when it was the *kind* of file that was refused will simply fail again
 * with the same file. So each sentence names what actually happened: too big,
 * wrong kind, refused by the scan, never arrived. A failure carrying no code is
 * not the server's answer at all — the bytes never got there — and that is the
 * one case where trying again, unchanged, is the right thing to do.
 */
function attachFailure(err: unknown, maxBytes: number): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'too_large':
        return `That file is larger than this survey accepts. The limit is ${Math.round(maxBytes / (1024 * 1024))} MB.`;
      case 'type_not_allowed':
      case 'type_mismatch':
        return (
          err.message ?? 'That kind of file cannot be attached to this question. Please choose another one.'
        );
      case 'attachment_infected':
        return err.message ?? 'That file was refused by the security scan and deleted. Please attach another one.';
      case 'attachment_rejected':
        return err.message ?? 'That file was not accepted, so this question is still unanswered. Please attach another one.';
      case 'upload_missing':
        return 'The file did not finish arriving. Please attach it again.';
      case 'storage_unavailable':
        return err.message ?? 'The place this survey keeps files did not answer. Please try again in a moment.';
      case 'storage_not_configured':
        return err.message ?? 'This survey is not collecting files at the moment, so this question is left unanswered.';
      case 'already_submitted':
        return 'This response has already been submitted, so nothing more can be attached to it.';
      case 'too_many_requests':
        return 'Too many files have been sent from this device just now. Please wait a moment and attach it again.';
      default:
        return err.message ?? 'That file could not be attached. Please try another one.';
    }
  }
  return 'The file did not reach the server. Check your connection and attach it again.';
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
  // What the deployment said about itself when the link was opened: whether it
  // takes files at all, the ceiling, and whether the bytes will be scanned.
  const [attachments, setAttachments] = useState<AttachmentCapability | null>(null);
  const [uploadPhase, setUploadPhase] = useState<{
    question: string;
    phase: 'authorising' | 'uploading' | 'checking';
  } | null>(null);
  const [attachmentError, setAttachmentError] = useState<{ question: string; message: string } | null>(null);
  // How much room this device has left, asked of the browser rather than assumed.
  const [storage, setStorage] = useState<StorageHealth | null>(null);
  // What the last save-a-copy or restore did, in the respondent's own words.
  const [copyNote, setCopyNote] = useState<string | null>(null);
  // Questions whose file never reached the server and is still held here.
  const [waitingFiles, setWaitingFiles] = useState<string[]>([]);
  // The form as this visit learned it, so a saved copy can say what it is a copy of.
  const [formMeta, setFormMeta] = useState<{ title: string | null; version: number | null }>({
    title: null,
    version: null,
  });

  const storeRef = useRef<OfflineStore | null>(null);
  const syncRef = useRef<CollectorSync | null>(null);
  const draftRef = useRef<StoredDraft | null>(null);
  const answersRef = useRef<Record<string, unknown>>({});
  const timer = useRef<number | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  /**
   * The files themselves, held in memory, for a question whose upload did not arrive.
   *
   * A `File` is a handle the person handed the page, and there is no way to get it back
   * from the draft: only its name, once the server has accepted it. So the one thing kept
   * here is the thing that cannot be reconstructed, and only until it has been sent.
   */
  const pendingAttachments = useRef<Map<string, File>>(new Map());
  const attachFileRef = useRef<((questionName: string, file: File) => Promise<void>) | null>(null);

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

  /**
   * Ask the browser how much room is left, and say so only when it answers.
   *
   * This is a warning, never a gate: the answers are already written to the draft, so a
   * device with no room left is something to tell somebody about before they collect
   * another fifty interviews, not a reason to refuse the one in front of them.
   */
  const refreshStorage = useCallback(async (): Promise<void> => {
    if (typeof navigator === 'undefined' || typeof navigator.storage?.estimate !== 'function') {
      setStorage(storageHealth(null));
      return;
    }
    try {
      setStorage(storageHealth(await navigator.storage.estimate()));
    } catch {
      setStorage(storageHealth(null));
    }
  }, []);

  /**
   * Send again the files that never arrived.
   *
   * A file that failed because there was no network is not a refused file, and the two
   * are the difference between an enumerator waiting and an enumerator losing a photo. So
   * the device keeps the file and tries it again by itself, one at a time, starting with
   * the first that failed. A retry that fails the same way stops the pass: trying the
   * next file against a connection that has just failed twice wastes the little bandwidth
   * there is.
   */
  const retryAttachments = useCallback(async (): Promise<void> => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    for (const [question, file] of [...pendingAttachments.current.entries()]) {
      if (pendingAttachments.current.get(question) !== file) continue;
      pendingAttachments.current.delete(question);
      setWaitingFiles([...pendingAttachments.current.keys()]);
      await attachFileRef.current?.(question, file);
      if (pendingAttachments.current.has(question)) return;
    }
  }, []);

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
      if (cached && !cancelled) {
        setDefinition(cached.definition as Definition);
        setFormMeta({ title: cached.title, version: cached.version });
      }

      try {
        const loaded = await api.collectForm(token);
        if (cancelled) return;
        setDefinition(loaded.form.definition);
        setAttachments(loaded.attachments ?? null);
        setFormMeta({ title: loaded.form.title, version: loaded.form.version });
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
      // The queue first, so the response exists on the server, and then anything a file
      // is waiting for: an attachment cannot be authorised before its response does.
      void flush().then(() => retryAttachments());
    };
    const onOffline = (): void => setOnline(false);
    const onVisible = (): void => {
      if (document.visibilityState !== 'visible') return;
      void flush();
      void refreshStorage();
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
  }, [flush, refreshStorage, retryAttachments]);

  // Autosave on a timer as well as on change, so a respondent who types one
  // answer and then thinks for ten minutes still has it on the server. The same
  // tick re-reads the storage estimate, because a device that filled up during
  // the day is exactly the case the warning exists for.
  useEffect(() => {
    void refreshStorage();
    const id = window.setInterval(() => {
      void flush();
      void refreshStorage();
    }, AUTOSAVE_MS);
    return () => window.clearInterval(id);
  }, [flush, refreshStorage]);

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

  /**
   * Send one file, in the order the API insists on: authorise it, put the bytes
   * straight into the store, then let the server look at what arrived.
   *
   * The answer does not exist until the third step answers: what is stored is the
   * `attachmentId` the server has *accepted* — HEADed, hashed and scanned — because
   * a reference to a file nobody verified must never be saved as an answer. The
   * question is identified by its **name**, which is the key answers are stored
   * under and the key the API matches the authorisation against.
   */
  const attachFile = useCallback(
    async (questionName: string, file: File): Promise<void> => {
      const responseId = draftRef.current?.responseId;
      setAttachmentError(null);

      if (!responseId) {
        setAttachmentError({
          question: questionName,
          message: 'A file needs a connection: this device has not started this response on the server yet.',
        });
        return;
      }

      const maxBytes = attachments?.maxBytes ?? 0;
      if (maxBytes > 0 && file.size > maxBytes) {
        setAttachmentError({
          question: questionName,
          message: `That file is ${Math.round(file.size / 1024)} kB, and this survey accepts up to ${Math.round(
            maxBytes / (1024 * 1024),
          )} MB.`,
        });
        return;
      }

      setUploadPhase({ question: questionName, phase: 'authorising' });
      try {
        const authorisation = await authoriseAttachment(token, responseId, {
          questionId: questionName,
          filename: file.name,
          mime: file.type || 'application/octet-stream',
          sizeBytes: file.size,
        });
        setUploadPhase({ question: questionName, phase: 'uploading' });
        await uploadAttachment(authorisation, file);
        setUploadPhase({ question: questionName, phase: 'checking' });
        const receipt = await completeAttachment(token, responseId, authorisation.attachmentId);
        setOnline(true);
        pendingAttachments.current.delete(questionName);
        setWaitingFiles([...pendingAttachments.current.keys()]);
        // Recorded through the same path every other answer takes, so the file's
        // reference is written to the draft and queued like an answer, not beside one.
        update(questionName, receipt.attachmentId);
      } catch (err) {
        // A refusal from the server is an answer; a failure with no code means the
        // bytes never reached the store, which is a connectivity fact, not a verdict.
        // The two are answered differently rather than alike: a refused file is one to
        // choose again, while a file that never arrived is held here and sent by itself
        // when the connection returns, because a person who has walked to a hilltop for
        // signal should not have to remember which question their photo belonged to.
        if (attachmentOutcome(err) === 'retry') {
          pendingAttachments.current.set(questionName, file);
          setWaitingFiles([...pendingAttachments.current.keys()]);
          setOnline(false);
          setAttachmentError({
            question: questionName,
            message:
              'That file did not reach the server, so it is still held on this device. It will be sent by itself when the connection comes back, and nothing else needs doing.',
          });
        } else {
          pendingAttachments.current.delete(questionName);
          setWaitingFiles([...pendingAttachments.current.keys()]);
          if (!(err instanceof ApiError)) setOnline(false);
          setAttachmentError({ question: questionName, message: attachFailure(err, maxBytes) });
        }
      } finally {
        setUploadPhase(null);
      }
    },
    [attachments, token, update],
  );
  // The retry pass reaches for the newest one, because a retry must run through exactly
  // the checks an attempt does: too big is still too big, and a refusal is still a refusal.
  attachFileRef.current = attachFile;

  /**
   * Write the device's own copy of its answers to a file.
   *
   * The whole point of this is that it needs nothing: no session, no server, no
   * connection. It is the answer to "the tablet is being replaced tomorrow and forty
   * interviews have not gone up yet", and to a browser clearing its own storage.
   */
  const saveCopy = (): void => {
    const latest = draftRef.current;
    if (!latest) return;
    const backup = buildBackup(latest, { title: formMeta.title, version: formMeta.version });
    const name = fileNameFor(backup);
    if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
      setCopyNote('This browser will not let the page write a file, so no copy was saved. Your answers are still on this device.');
      return;
    }
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(backup, null, 2)}\n`], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    setCopyNote(`Saved a copy of your answers as ${name}. Keep it somewhere other than this device.`);
  };

  /**
   * Read a copy back: the other half of "never loses an answer", and the half that works
   * when the device the answers were on is gone. No network is involved, which is what
   * makes it usable on the replacement phone that has not been set up yet.
   */
  const restoreFromFile = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0];
    // Cleared straight away, so choosing the same file twice raises the change event twice.
    event.target.value = '';
    const store = storeRef.current;
    if (!file || !store) return;
    setCopyNote(null);
    try {
      const result = await restoreBackup(store, await file.text(), token);
      if (!result.ok) {
        setCopyNote(result.reason);
        return;
      }
      setDraft(result.draft);
      setAnswers(result.draft.answers);
      setStatus(result.draft.status);
      setCopyNote('Restored the saved copy. Anything it was still holding will be sent now.');
      void flush().then(() => retryAttachments());
    } catch {
      setCopyNote('That file could not be read. It is not a copy of saved answers this app wrote.');
    }
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
      if (err instanceof ApiError && err.code === 'attachment_not_ready') {
        // The server refused the submission because an answer names a file it never
        // accepted. That is not a generic failure: the refusal names the question, and
        // the only thing that fixes it is attaching that file again.
        setError(
          `${err.message ?? 'A file this response names was never accepted.'} Attach the file again on the question it belongs to, then submit.`,
        );
        return;
      }
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

  // Everything the device can say about its own queue, computed from the draft rather
  // than remembered in state: there is one source of truth for "is my work safe", and it
  // is the record the next flush will read.
  const device = draft ? deviceState(draft, { online, syncing, now: Date.now() }) : null;
  const waiting = device?.waiting ?? 0;
  const retry = device ? retryText(device) : null;
  const savedAt = timeOf(draft?.updatedAt ?? null);
  const syncedAt = timeOf(draft?.syncedAt ?? null);
  // One notice box, in priority order: a file that was refused is the most useful
  // thing to say, then whatever went wrong submitting.
  const noticeText = attachmentError ? `“${attachmentError.question}”: ${attachmentError.message}` : error;
  const failed = device !== null && device.attempts > 0 && device.lastError !== null;

  return (
    <RespondentForm
      definition={definition}
      answers={answers}
      onChange={update}
      attachments={attachments ?? undefined}
      onAttachFile={attachFile}
      onFlush={() => void flush()}
      problems={problems}
      subtitle={
        <>
          {storage?.warning && <><strong>{storage.warning}</strong>{' '}</>}
          {savedAt && <>Saved on this device at {savedAt}. </>}
          {syncedAt ? <>The server has everything up to {syncedAt}.</> : <>Not sent to the server yet.</>}
        </>
      }
      status={
        <>
          <span className={online && !failed ? 'pill ok' : 'pill warn'} role="status" aria-live="polite">
            {device ? device.headline : 'Loading…'}
          </span>
          {failed && (
            <span className="muted small" role="status" aria-live="polite">
              {`Tried ${device.attempts} time${device.attempts === 1 ? '' : 's'}${retry ? `, ${retry}` : ''}.`}
            </span>
          )}
          {uploadPhase && (
            <span className="muted small" role="status" aria-live="polite">
              {`Attaching a file to “${uploadPhase.question}”: ${UPLOAD_PHASE_LABELS[uploadPhase.phase]}…`}
            </span>
          )}
          {waitingFiles.length > 0 && (
            <span className="muted small" role="status" aria-live="polite">
              {waitingFiles.length === 1
                ? 'One file is still on this device, waiting for a connection.'
                : `${waitingFiles.length} files are still on this device, waiting for a connection.`}
            </span>
          )}
          {(waiting > 0 || outcome?.phase === 'error') && (
            <button type="button" className="ghost" onClick={() => void flush()} disabled={!online}>
              {online ? 'Send now' : 'Waiting for a connection'}
            </button>
          )}
        </>
      }
      notice={
        <>
          {noticeText ? <div className="card error">{noticeText}</div> : null}
          {draft ? (
            <div className="card">
              <p className="muted small">
                <strong>Your answers on this device.</strong>{' '}
                {waiting > 0
                  ? `${waiting} change${waiting === 1 ? '' : 's'} waiting to be sent.`
                  : 'Everything typed here is saved here, whatever happens to the connection.'}{' '}
                {failed
                  ? `The last attempt did not go through and has been tried ${device.attempts} time${device.attempts === 1 ? '' : 's'}${retry ? `, ${retry}` : ''}. Nothing has been discarded.`
                  : ''}
              </p>
              <div className="row wrap">
                <button type="button" className="ghost" onClick={saveCopy}>
                  Save a copy
                </button>
                <button type="button" className="ghost" onClick={() => fileInput.current?.click()}>
                  Restore a saved copy
                </button>
                <input
                  ref={fileInput}
                  type="file"
                  accept="application/json,.json"
                  style={{ display: 'none' }}
                  onChange={(event) => void restoreFromFile(event)}
                />
              </div>
              <p className="muted small">
                A copy is a file on your own device. It needs no connection, and it is what brings your answers back if
                this device is wiped, replaced, or runs out of space.
              </p>
              {copyNote && <p className="muted small" role="status" aria-live="polite">{copyNote}</p>}
            </div>
          ) : null}
        </>
      }
      submit={{ label: busy ? 'Submitting…' : 'Submit', busy, onClick: () => void submit() }}
      footer={
        <>
          {problems.missing.length > 0 && (
            <span className="stat">
              <strong>{problems.missing.length}</strong>
              {` required answer(s) still missing`}
            </span>
          )}
          {!online && <span className="muted">Your answers are safe on this device and will be sent automatically.</span>}
        </>
      }
    />
  );
}
