import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiError,
  api,
  download,
  type ApiScope,
  type FormSummary,
  type MailDelivery,
  type PublicMailStatus,
  type Organisation,
  type TermsStatus,
  type VersionComparison,
  type VersionSummary,
  type WebhookDelivery,
} from './api';
import { Collect } from './collect';
import { AdminView } from './admin';
import { InvitePage, LegalPage, TermsGate } from './legal';
import { useFormStream, type Aggregate, type StreamStatus } from './realtime';
import { createAmbientField, type AmbientField, type AmbientQuality } from './immersive/ambient';
import { navigate } from './router';

/**
 * The marketing page, in its own chunk.
 *
 * It carries the WebGL scene with it, so a reader who is opening the console never
 * pays for either. `React.lazy` is the whole reason that is possible without a
 * second entry point.
 */
const Landing = lazy(() => import('./landing').then((module) => ({ default: module.Landing })));

/**
 * The definition studio, in its own chunk.
 *
 * It is three live panels over one definition — the JSON source, the XLSForm sheets
 * that `Download .xlsx` zips, and the form a respondent opens — and it carries the
 * XLSForm writer with it. Nobody reading a table of responses should pay for an
 * authoring tool, so it arrives when somebody opens a form instead.
 */
const Studio = lazy(() => import('./studio').then((module) => ({ default: module.DefinitionStudio })));

/**
 * The workspace shell: sign in, pick an organisation, author a form, publish it,
 * collect responses, watch the numbers arrive, export.
 *
 * Every count on this screen comes from a live query against the server. There is
 * no cached snapshot and no seed data: if it says 3 responses, three responses
 * exist.
 *
 * The reads are driven by the push channel (`./realtime`), not by timers. While the
 * stream for the open form is up, the server says which aggregate moved and the
 * screen refetches only that one; a timer runs only as a fallback while the stream
 * is down, and each screen that reads on a signal renders the pill that says which of
 * the two is happening (`DataTab`, `DistributeTab`, `QualityTab`, `IntegrationsView`)
 * — the form header itself only reports whether the form is collecting.
 */

interface Me {
  user: { id: string; email: string; displayName: string | null };
  organisations: Organisation[];
}

interface LiveOptions {
  /**
   * The form whose stream drives this read. When the value is null the read has
   * no push channel (the workspace list spans every form, so no single stream
   * describes it) and the fallback timer is the only mechanism.
   */
  formId?: string | null;
  /** Which aggregate on that stream invalidates this read. */
  aggregate?: Aggregate;
  /**
   * Interval used *only* while the push channel is not live for this aggregate.
   * It is a safety net, not the mechanism: the point of the channel is that this
   * timer does not run at all when the stream is up.
   */
  fallbackMs: number;
  deps: unknown[];
}

interface LiveResult<T> {
  data: T | null;
  error: string | null;
  reload: () => void;
  status: StreamStatus;
  /** True when the server is pushing this aggregate, so nothing is being timed. */
  live: boolean;
}

/**
 * A live read: the server pushes, the timer is the fallback.
 *
 * The distinction is the whole point of the change. Previously every one of these
 * reads had an interval, so a screen that had not changed in an hour still cost a
 * query every five seconds, and the number on screen could still be fifteen seconds
 * old. Here the interval is only armed once the stream has actually failed.
 */
export function useLive<T>(load: () => Promise<T>, options: LiveOptions): LiveResult<T> {
  const { formId = null, aggregate, fallbackMs, deps } = options;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  const run = useCallback(async (): Promise<void> => {
    try {
      const result = await loadRef.current();
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'request failed');
    }
  }, []);

  // The first read, every deps change, and a manual refresh. Always exactly one
  // request per reason, never a loop.
  useEffect(() => {
    void run();
    // The caller passes the identity of what it read; `tick` is the manual refresh.
  }, [run, tick, ...deps]);

  // The push channel. Only subscribed when this read names an aggregate: a read
  // with no aggregate has no event that invalidates it.
  const onStreamEvent = useCallback(
    (changed: Aggregate[]) => {
      if (aggregate && changed.includes(aggregate)) void run();
    },
    [aggregate, run],
  );
  const status = useFormStream(aggregate ? formId : null, onStreamEvent);

  const live = Boolean(aggregate && formId && status === 'live');

  useEffect(() => {
    if (live) return;
    const timer = window.setInterval(() => void run(), fallbackMs);
    // A background tab has its timers throttled (or frozen), so the first thing a
    // returning reader saw could be a snapshot from minutes ago. Refresh the
    // moment the tab becomes visible again, and again if the window is refocused.
    const refreshIfVisible = (): void => {
      if (document.visibilityState === 'visible') void run();
    };
    document.addEventListener('visibilitychange', refreshIfVisible);
    window.addEventListener('focus', refreshIfVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshIfVisible);
      window.removeEventListener('focus', refreshIfVisible);
    };
  }, [live, fallbackMs, run]);

  return { data, error, reload: () => setTick((n) => n + 1), status, live };
}

/** The one line the header shows about the connection, in plain words. */
export function liveLabel(status: StreamStatus, live: boolean, fallbackMs: number): string {
  if (live) return 'live: pushed by the server the moment it changes';
  if (status === 'connecting') return `live: connecting, refreshing every ${Math.round(fallbackMs / 1000)}s until it opens`;
  return `live: stream down, refreshing every ${Math.round(fallbackMs / 1000)}s`;
}

/**
 * The pointer trail, on every route rather than only on the landing page.
 *
 * A fixed, full-viewport canvas the trail is drawn into, mounted once by the shell below
 * so that the sign-in sheet, the console, the documents, an invitation and a collection
 * link all carry the same mark as the front door: the product is one room, and a visitor
 * who follows a link into it should not watch the cursor stop behaving like the one on
 * the page that sent them there.
 *
 * The canvas is decoration and behaves like it: no pointer events, so every control
 * underneath still receives its click; hidden outright under reduced motion, both here
 * and in the effect, because a reader who asked for less motion should not depend on a
 * chunk having loaded; and the effect itself is imported on demand, so a device with no
 * fine pointer — which is also the device least able to afford the frames — never
 * downloads it.
 *
 * The canvas is mounted by the shell rather than by each route for the reason the
 * ambient field is: a layer that appears and disappears with navigation reads as a
 * glitch, and a per-route mount would also mean a per-route chance to forget one.
 */
export function CursorTrail(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Asked before the chunk is fetched, not after it is evaluated: see
    // `wantsCursorTrail`. A phone has no fine pointer, and the module can only tell it
    // so by being downloaded first.
    if (!wantsCursorTrail()) return;
    let handle: { dispose(): void } | null = null;
    let disposed = false;

    void import('./cursor-trail')
      .then((module) => {
        // The mount can lose the race with an unmount, which is normal under
        // StrictMode's double mount: a trail created after teardown would draw into
        // a canvas nobody is watching, forever.
        if (disposed) return;
        handle = module.mountCursorTrail(canvas);
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      handle?.dispose();
    };
  }, []);

  return <canvas ref={canvasRef} className="cursor-trail" aria-hidden="true" />;
}

/**
 * Whether this device is going to be shown a trail — asked *before* the chunk is fetched.
 *
 * `shouldDrawCursorTrail`, inside that chunk, asks the same two questions before it
 * mounts, and the difference between the two call sites is the whole cost of getting it
 * wrong: `import()` runs wherever the canvas is rendered, so a device that would never
 * draw a trail still downloaded the module and evaluated twenty springs of physics to be
 * told so. Reduced motion and no fine pointer now fetch nothing at all.
 *
 * The two queries are written out here rather than imported, because importing the
 * predicate would put the chunk on the critical path — the one thing the split exists to
 * prevent. If the two ever disagree, the price is a fetch that bought nothing: the module
 * refuses to draw on its own, and the stylesheet hides the canvas there. The reverse
 * cannot happen, because nothing fetches it on a device this says no to.
 */
export function wantsCursorTrail(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  return window.matchMedia('(any-pointer: fine)').matches;
}

/**
 * The chrome that puts the signed-in app in the same world as the landing page.
 *
 * Three fixed layers, none of them interactive and none of them load-bearing: the
 * ambient field (the same node-and-filament structure as the landing page's
 * sculpture, drawn as a light field on a 2D canvas, so the console does not grow by
 * a renderer to look like the product), film grain over it, and a vignette that
 * stops a wide table from floating in the middle of nowhere. With no canvas, with
 * JavaScript off, or under reduced motion, the page is complete: the layers simply
 * do not appear.
 *
 * It is mounted once for the session rather than per screen, so moving between
 * forms does not rebuild it, and it stops when the tab is hidden, because an
 * animation nobody is watching is a battery cost with no reader.
 */
function ImmersiveChrome(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    const quality: AmbientQuality =
      reducedMotion || window.innerWidth < 860 || (navigator.hardwareConcurrency || 8) <= 4 ? 'low' : 'high';

    const field: AmbientField | null = createAmbientField(canvas, { quality, reducedMotion });
    if (field) {
      field.resize();
      host.classList.add('ready');
    }

    let frame = 0;
    const onScroll = (): void => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const scrollable = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
        field?.setProgress(window.scrollY / scrollable);
      });
    };

    const onResize = (): void => field?.resize();

    /*
     * The field leans towards the pointer. Nothing here moves the pointer itself and
     * nothing draws a second cursor: the trail the shell mounts is the only mark that
     * follows it, and the ring that used to sit around it is gone — two decorations
     * chasing one pointer, each with its own idea of what hovering means, is how a tool
     * ends up looking like two products.
     */
    const onPointer = (event: PointerEvent): void => {
      field?.setPointer(
        (event.clientX / window.innerWidth) * 2 - 1,
        -((event.clientY / window.innerHeight) * 2 - 1),
      );
    };

    const onVisibility = (): void => {
      field?.setActive(document.visibilityState === 'visible');
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    if (fine && !reducedMotion) window.addEventListener('pointermove', onPointer, { passive: true });
    onScroll();

    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pointermove', onPointer);
      if (frame) cancelAnimationFrame(frame);
      host.classList.remove('ready');
      field?.dispose();
    };
  }, []);

  return (
    <>
      <div className="ambient" aria-hidden="true">
        <canvas ref={canvasRef} />
      </div>
      <div className="vignette" aria-hidden="true" />
      <div className="grain" aria-hidden="true" />
    </>
  );
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

/** Exported for `signin-copy.test.tsx`: the copy on this card states facts the
 *  server owns, and the test is what keeps them coming from the server. */
export function Login({ onSignedIn }: { onSignedIn: () => void }): JSX.Element {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'email' | 'code'>('email');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mail, setMail] = useState<PublicMailStatus | null>(null);
  // What the *request* answered, kept apart from the mount-time read on purpose.
  // The two arrive in whichever order the network chooses, and a slow read that
  // landed after a fast request used to be able to overwrite the fresher answer
  // — the card would then name a sender from before the code was asked for. The
  // answer that travelled with the code wins, and the other one only fills the
  // gap while there is one.
  const [answered, setAnswered] = useState<PublicMailStatus | null>(null);
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
      setAnswered(res.mail);
      if (res.delivery.ok) {
        // The sender and the lifetime are the server's own facts, reported by
        // `/auth/mail-status` and stated in the message itself. They are read
        // from *this* response rather than from the read that ran when the card
        // mounted, because this is the answer that belongs to this code — and
        // because a sentence nobody has the numbers for is better left unsaid
        // than filled in from the server's defaults.
        const sender = res.mail?.from;
        const ttl = res.mail?.otpTtlMinutes;
        setNotice(
          `We sent a 6 digit code to ${email}.` +
            (sender && Number.isFinite(ttl) ? ` It comes from ${sender} and expires in ${ttl} minutes.` : ''),
        );
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
    <div className="auth card surface">
      <h1>Inicio</h1>
      <p className="muted">
        Multi-tenant survey and data-collection platform. Accounts are invitation only: sign in with the address your
        invitation was sent to.
      </p>
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
          {/* Which message to open, on the screen where somebody is looking at a
              phone. The lifetime is already stated above; saying it twice on one
              screen is how a reader starts wondering which one is true. */}
          {delivery?.ok && answered?.from && <p className="muted small">Look for the message from {answered.from}.</p>}
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

/*
 * The definition editor used to live here as a textarea and a save button. It is
 * now `./studio`, loaded lazily above: three live panels over one definition — the
 * JSON source, the XLSForm sheets the download writes, and the form a respondent
 * opens — with the analyser running on every keystroke rather than on save.
 */

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

export function DataTab({
  formId,
  orgId,
  publishedVersion,
}: {
  formId: string;
  orgId: string;
  publishedVersion: number | null;
}): JSX.Element {
  const { data, error, reload, status, live } = useLive(() => api.responses(formId), {
    formId,
    aggregate: 'responses',
    fallbackMs: 30_000,
    deps: [formId],
  });
  // The same live tables, read a second way: status counts, per-answer tallies and
  // a daily timeline, recomputed by the server on every request. Its own stream
  // subscription, so a slow export cannot hold up the numbers.
  const { data: analytics } = useLive(() => api.analytics(formId), {
    formId,
    aggregate: 'analytics',
    fallbackMs: 30_000,
    deps: [formId],
  });
  const [downloadError, setDownloadError] = useState<string | null>(null);
  // An export descends from a published version, so there is nothing to export
  // until one exists. Saying why up front beats a failed download.
  const canExport = publishedVersion !== null;

  // Raising a finding by hand. The response id is the thing the API needs, so the
  // form opens on the row it belongs to rather than in a panel somebody has to
  // match up with a table elsewhere on the screen.
  const [flagging, setFlagging] = useState<string | null>(null);
  const [flagSeverity, setFlagSeverity] = useState<'info' | 'warn' | 'severe'>('warn');
  const [flagNote, setFlagNote] = useState('');
  const [flagBusy, setFlagBusy] = useState(false);
  const [flagError, setFlagError] = useState<string | null>(null);
  const [flagNotice, setFlagNotice] = useState<string | null>(null);

  const raiseFlag = async (responseId: string): Promise<void> => {
    setFlagBusy(true);
    setFlagError(null);
    setFlagNotice(null);
    try {
      const res = await api.raiseFlag(orgId, formId, responseId, {
        severity: flagSeverity,
        note: flagNote.trim(),
      });
      // Two honest outcomes, and they are not the same message. A unique index
      // refuses a second identical finding for the same response, and the API says
      // so (`queued: false, reason: 'already_recorded'`) — collapsing that into
      // "raised" would report a write that did not happen, and the person would
      // believe a complaint had been recorded when it was dropped.
      setFlagNotice(
        res.queued
          ? `Raised a ${flagSeverity} finding for ${responseId.slice(0, 8)}. It is in the Quality tab.`
          : `A finding raised by hand for ${responseId.slice(0, 8)} is already in the queue, so nothing new was recorded. The existing one keeps the note it was raised with.`,
      );
      setFlagging(null);
      setFlagNote('');
    } catch (err) {
      setFlagError(err instanceof ApiError ? (err.message ?? err.code) : 'the finding was not recorded');
    } finally {
      setFlagBusy(false);
    }
  };

  const tally = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of data?.counts ?? []) counts.set(row.status, row.count);
    return counts;
  }, [data]);

  const [withCodebook, setWithCodebook] = useState(false);

  const exportAs = async (format: string): Promise<void> => {
    setDownloadError(null);
    // A `.sav` is one file, so when the codebook is asked for it travels beside the data
    // in an archive — the codebook, the value labels, the missing table and the metadata
    // the CSV bundle carries, without the data that the statistical file already is.
    // This matters most for Stata: a `.dta` cannot hold the value labels of a string
    // variable at all, so the codebook is where an option's codes are written down.
    const codebook = withCodebook && (format === 'sav' || format === 'dta');
    try {
      await download(
        `/forms/${formId}/responses/export?format=${format}${codebook ? '&codebook=1' : ''}`,
        codebook ? `${format}-bundle.zip` : `export.${format === 'csv' ? 'zip' : format}`,
      );
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
        <span className={live ? 'live-pill on' : 'live-pill'} role="status">
          <i aria-hidden="true" />
          {liveLabel(status, live, 30_000)}
        </span>
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
        {/* Offered rather than greyed out: whether this deployment can write a statistical
            file is the deployment's business, and the API answers for itself — a 501 naming
            the variable to set, or a 502 saying the worker did not answer. A button that
            says "unavailable" on a deployment that has a worker is its own small lie. */}
        <button type="button" onClick={() => void exportAs('sav')} disabled={!canExport}>
          Export .sav
        </button>
        <button type="button" onClick={() => void exportAs('dta')} disabled={!canExport}>
          Export .dta
        </button>
        <label className="small muted">
          <input
            type="checkbox"
            checked={withCodebook}
            onChange={(event) => setWithCodebook(event.target.checked)}
          />{' '}
          ship the codebook beside .sav/.dta
        </label>
      </div>
      <p className="muted small">
        {canExport ? `Exports are built from the published version${publishedVersion ? ` v${publishedVersion}` : ''}. ` : ''}
        The CSV export is a bundle: data, codebook, value labels, the missing-code table and metadata: plus a
        spreadsheet-safe copy where formula-looking cells are neutralised. .sav and .dta are written by the
        pyreadstat worker, which is deployed separately: without one this deployment refuses the export and names
        the variable that would change that, rather than emitting a file that is quietly wrong.
      </p>
      {downloadError && <p className="error small">{downloadError}</p>}
      {error && <p className="error small">{error}</p>}
      {flagError && <p className="error small">{flagError}</p>}
      {flagNotice && (
        <p className="small muted" role="status">
          {flagNotice}
        </p>
      )}

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
        {analytics !== null && analytics !== undefined && analytics.conflicts > 0 && (
          <p className="muted small" role="status">
            {analytics.conflicts === 1 ? '1 answer was' : `${analytics.conflicts} answers were`} edited on two devices
            before syncing. The value the server held is kept, and the other copy is stored beside it. Nothing was
            overwritten.
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
            <th>Sync conflicts</th>
            <th>Flag</th>
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
              <td className="small">
                {row.conflict_count > 0 ? (
                  <span className="error">{row.conflict_count}</span>
                ) : (
                  <span className="muted">0</span>
                )}
              </td>
              <td>
                {flagging === row.id ? (
                  <div className="stack tight">
                    <div className="choices">
                      {(['info', 'warn', 'severe'] as const).map((level) => (
                        <label key={level} className="choice">
                          <input
                            type="radio"
                            name={`severity-${row.id}`}
                            checked={flagSeverity === level}
                            onChange={() => setFlagSeverity(level)}
                          />
                          <span className="small">{level}</span>
                        </label>
                      ))}
                    </div>
                    <input
                      placeholder="Why? kept with the finding"
                      value={flagNote}
                      onChange={(e) => setFlagNote(e.target.value)}
                    />
                    <div className="row">
                      <button
                        type="button"
                        onClick={() => void raiseFlag(row.id)}
                        // A note is what makes a raised finding worth anything
                        // later, and the API rejects an empty one — so the button
                        // waits for one rather than letting a 400 explain it.
                        disabled={flagBusy || flagNote.trim().length < 3}
                      >
                        Raise
                      </button>
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => {
                          setFlagging(null);
                          setFlagNote('');
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => {
                      setFlagging(row.id);
                      setFlagSeverity('warn');
                      setFlagNote('');
                      setFlagError(null);
                      setFlagNotice(null);
                    }}
                  >
                    Flag
                  </button>
                )}
              </td>
            </tr>
          ))}
          {(data?.responses ?? []).length === 0 && (
            <tr>
              <td colSpan={7} className="muted">
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
  const { data, reload, error, status, live } = useLive(() => api.links(formId), {
    formId,
    aggregate: 'links',
    fallbackMs: 60_000,
    deps: [formId],
  });
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

      <p className={live ? 'live-pill on' : 'live-pill'} role="status">
        <i aria-hidden="true" />
        {liveLabel(status, live, 60_000)}
      </p>

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
  const { data, reload, error } = useLive(() => api.form(form.id), {
    formId: form.id,
    aggregate: 'versions',
    fallbackMs: 60_000,
    deps: [form.id],
  });
  const [tab, setTab] = useState<'builder' | 'data' | 'quality' | 'distribute'>('builder');
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
      <div className="screen-head">
        <div>
          <span className="eyebrow">Form</span>
          <h1>{form.name}</h1>
          <p className="muted small">{form.organisation}</p>
        </div>
        <div className="appbar-right">
          {published ? (
            <span className="pill ok">published v{published.version} · collecting</span>
          ) : (
            <span className="pill">draft only · not collecting yet</span>
          )}
          <button type="button" className="ghost" onClick={onBack}>
            ← Forms
          </button>
        </div>
      </div>

      <nav className="tabs">
        {(['builder', 'data', 'quality', 'distribute'] as const).map((name) => (
          <button key={name} type="button" className={tab === name ? 'tab active' : 'tab'} onClick={() => setTab(name)}>
            {name === 'builder'
              ? 'Builder'
              : name === 'data'
                ? 'Responses & exports'
                : name === 'quality'
                  ? 'Quality'
                  : 'Distribute'}
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

          <VersionHistory
            formId={form.id}
            orgId={form.org_id}
            versions={versions}
            selectedId={selected?.id ?? null}
            onSelect={setSelectedVersionId}
            onChanged={() => {
              setEditorRevision((n) => n + 1);
              reload();
            }}
            onNotice={setNotice}
          />

          {selected && (
            <Suspense fallback={<p className="muted">Opening the studio…</p>}>
              <Studio formId={form.id} version={selected} revision={editorRevision} />
            </Suspense>
          )}
        </div>
      )}

      {tab === 'data' && (
        <DataTab formId={form.id} orgId={form.org_id} publishedVersion={published?.version ?? null} />
      )}
      {tab === 'quality' && <QualityTab formId={form.id} orgId={form.org_id} />}
      {tab === 'distribute' && <DistributeTab formId={form.id} publishedVersion={published?.version ?? null} />}
    </div>
  );
}

/**
 * The form's version history, as the graph it actually is.
 *
 * Each version records the one it was forked from (`based_on`), so a restore shows up
 * as a new version pointing back at the old one rather than as history rewritten. The
 * comparison the row expands is fetched from the API — the sentences are computed from
 * the two stored definitions in `diffDefinitions`, so what the console shows and what
 * the database holds cannot drift apart — and every non-draft version can be restored,
 * which forks a fresh draft.
 *
 * Who and when come from the version row and the organisation's members: a history that
 * says "v3 changed" and not who changed it or when is a timeline nobody can act on.
 */
export function VersionHistory({
  formId,
  orgId,
  versions,
  selectedId,
  onSelect,
  onChanged,
  onNotice,
}: {
  formId: string;
  orgId: string;
  versions: VersionSummary[];
  selectedId: string | null;
  onSelect: (versionId: string) => void;
  onChanged: () => void;
  onNotice: (notice: string | null) => void;
}): JSX.Element {
  const [people, setPeople] = useState<Record<string, string>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [comparisons, setComparisons] = useState<Record<string, VersionComparison | null>>({});
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void api
      .members(orgId)
      .then((result) => {
        if (live) setPeople(Object.fromEntries(result.members.map((member) => [member.user_id, member.email])));
      })
      // A history without names is still a history: the dates and the diffs are the part
      // that matters, so a members list this viewer may not read is not an error here.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [orgId]);

  const toggle = async (version: VersionSummary): Promise<void> => {
    if (open === version.id) {
      setOpen(null);
      return;
    }
    setOpen(version.id);
    if (version.id in comparisons) return;
    try {
      const comparison = await api.versionDiff(formId, version.id);
      setComparisons((current) => ({ ...current, [version.id]: comparison }));
    } catch (err) {
      setComparisons((current) => ({ ...current, [version.id]: null }));
      onNotice(err instanceof ApiError ? (err.message ?? 'could not load the comparison') : 'could not load the comparison');
    }
  };

  const restore = async (version: VersionSummary): Promise<void> => {
    if (!window.confirm(`Restore v${version.version} as a new draft? The published version keeps collecting until you publish the new one.`)) return;
    setBusy(version.id);
    onNotice(null);
    try {
      const result = await api.restoreVersion(formId, version.id);
      onSelect(result.version.id);
      setOpen(null);
      setComparisons({});
      onNotice(`Restored v${version.version} as draft v${result.version.version}, based on it. Nothing was rewritten.`);
      onChanged();
    } catch (err) {
      onNotice(err instanceof ApiError ? (err.message ?? 'could not restore that version') : 'could not restore that version');
    } finally {
      setBusy(null);
    }
  };

  if (versions.length === 0) return <p className="muted small">This form has no versions yet.</p>;

  return (
    <div className="stack">
      <p className="muted small">
        {versions.length} version(s). A published version is frozen and keeps the responses it collected;
        restoring one forks a new draft from it rather than rewriting it.
      </p>
      <ul className="versions">
        {versions.map((version) => {
          const parent = version.based_on ? versions.find((candidate) => candidate.id === version.based_on) : undefined;
          const comparison = comparisons[version.id];
          const expanded = open === version.id;
          const author = version.created_by ? (people[version.created_by] ?? 'a former member') : 'an unknown member';
          return (
            <li key={version.id} className="version">
              {/* The version itself stays the selectable row — it is what the studio edits —
                  and everything about where it came from hangs underneath it. */}
              <button
                type="button"
                className={version.id === selectedId ? 'tab active' : 'tab'}
                onClick={() => onSelect(version.id)}
              >
                v{version.version} · {version.status} · {version.question_count} question(s)
              </button>
              <div className="row wrap">
                <button type="button" className="ghost" onClick={() => void toggle(version)}>
                  {expanded ? 'Hide changes' : 'What changed'}
                </button>
                {version.status !== 'draft' && (
                  <button
                    type="button"
                    className="ghost"
                    disabled={busy === version.id}
                    onClick={() => void restore(version)}
                  >
                    {busy === version.id ? 'Restoring…' : 'Restore as draft'}
                  </button>
                )}
              </div>
              <p className="muted small">
                {author} · created {new Date(version.created_at).toLocaleString()}
                {version.published_at ? ` · published ${new Date(version.published_at).toLocaleString()}` : ''}
                {parent
                  ? ` · based on v${parent.version}`
                  : version.based_on
                    ? ' · based on a version this form no longer lists'
                    : ' · the first version of this form'}
              </p>
              {expanded && (
                <div className="stack">
                  {comparison === undefined && <p className="muted small">Comparing…</p>}
                  {comparison === null && <p className="warn small">The comparison could not be loaded.</p>}
                  {comparison && <VersionDiff comparison={comparison} />}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The server's own sentences, laid out. Nothing here is re-derived in the browser. */
function VersionDiff({ comparison }: { comparison: VersionComparison }): JSX.Element {
  const { from, to, diff } = comparison;
  if (!diff || !from) {
    return (
      <p className="muted small">
        v{to.version} is where this form started, so there is nothing to compare it with. Compare it with an
        earlier version above instead.
      </p>
    );
  }
  const { counts, changes, notes } = diff;
  return (
    <div className="stack">
      <p className="small">
        <strong>
          v{from.version} → v{to.version}:
        </strong>{' '}
        {diff.identical
          ? 'the definition is unchanged.'
          : `${counts.added} added, ${counts.removed} removed, ${counts.changed} changed.`}
      </p>
      {changes.length > 0 && (
        <ul className="small">
          {changes.map((change) => (
            <li key={change}>{change}</li>
          ))}
        </ul>
      )}
      {changes.length === 0 && !diff.identical && (
        <p className="warn small">
          The two definitions differ, but nothing this comparison describes: see the notes below.
        </p>
      )}
      {notes.length > 0 && (
        <ul className="small muted">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A flag's `detail` is evidence, so it is shown as named facts rather than as raw JSON. */
function formatDetail(detail: Record<string, unknown>): string[] {
  return Object.entries(detail).map(([key, value]) => {
    if (Array.isArray(value)) {
      return `${key}: ${value.length > 0 ? value.map((item) => String(item)).join(', ') : '(none)'}`;
    }
    if (value !== null && typeof value === 'object') return `${key}: ${JSON.stringify(value)}`;
    return `${key}: ${String(value)}`;
  });
}

/** Severity is the first thing a reviewer scans for, so it gets a real colour. */
function severityClass(severity: string): string {
  if (severity === 'severe') return 'pill bad';
  if (severity === 'warn') return 'pill warn';
  return 'pill';
}

/**
 * The quality queue: what a reviewer actually does with a finding.
 *
 * Two things make this different from a quality score in a dashboard. Every row
 * carries the evidence the detector recorded — the duration, the value that
 * repeated, the response it duplicates — so somebody can disagree with the rule on
 * the evidence instead of taking its word for it. And the decision is recorded:
 * who, when and why, with a note, because dismissing a finding is a legitimate
 * answer that still has to leave a trace.
 *
 * The duplicate scan lives here rather than at submission time on purpose. A
 * respondent's transaction may only see its own response — that is exactly what
 * stops a public link reading other people's data — so finding duplicates is an
 * organiser's act, and it is presented as one: a button that says what it does.
 */
export function QualityTab({ formId, orgId }: { formId: string; orgId: string }): JSX.Element {
  const [status, setStatus] = useState<'open' | 'resolved' | 'dismissed' | 'all'>('open');
  const queue = useLive(() => api.flags(orgId, { formId, status, limit: 100 }), {
    fallbackMs: 30_000,
    deps: [orgId, formId, status],
  });
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const flags = queue.data?.flags ?? [];
  const summary = queue.data?.summary ?? null;

  const decide = async (flagId: string, next: 'resolved' | 'dismissed'): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.resolveFlag(orgId, flagId, { status: next, ...(note.trim() ? { note: note.trim() } : {}) });
      setReviewing(null);
      setNote('');
      setNotice(`Recorded as ${next}, with your note.`);
      queue.reload();
    } catch (err) {
      setError(err instanceof ApiError ? (err.message ?? err.code) : 'that did not work');
    } finally {
      setBusy(false);
    }
  };

  const scan = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.scanFlags(orgId, formId);
      setNotice(
        res.flagged === 0
          ? 'No new duplicates. The scan is idempotent: a finding is recorded once, however often you look.'
          : `${res.flagged} duplicate response${res.flagged === 1 ? '' : 's'} flagged.`,
      );
      queue.reload();
    } catch (err) {
      setError(err instanceof ApiError ? (err.message ?? err.code) : 'the scan did not run');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack grow">
      <div className="row wrap">
        {(['open', 'resolved', 'dismissed', 'all'] as const).map((name) => (
          <button
            key={name}
            type="button"
            className={status === name ? 'tab active' : 'tab'}
            onClick={() => setStatus(name)}
          >
            {name}
          </button>
        ))}
        <span className="grow" />
        {summary && <span className="muted small">{summary.open} open</span>}
        <button type="button" className="ghost" onClick={() => void scan()} disabled={busy}>
          Scan for duplicates
        </button>
      </div>

      {error && <p className="error small">{error}</p>}
      {notice && <p className="small muted">{notice}</p>}

      <p className="muted small">
        Speeding and straight-lining are detected as a response is submitted; duplicates need the whole form, so they
        appear when you scan. Every threshold is stated: see the Quality tab&rsquo;s legend in the API
        (<code>GET /api/v1/flag-kinds</code>).
      </p>

      <div className="card">
        {flags.length === 0 ? (
          <p className="muted small">
            Nothing {status === 'all' ? 'recorded' : status} for this form yet.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Finding</th>
                <th>Evidence</th>
                <th>Response</th>
                <th>Decision</th>
              </tr>
            </thead>
            <tbody>
              {flags.map((flag) => (
                <tr key={flag.id}>
                  <td>
                    <span className={severityClass(flag.severity)}>{flag.severity}</span>
                    <div>
                      <strong>{flag.kind.replace('_', ' ')}</strong>
                    </div>
                    <div className="muted small">{flag.kindDetail}</div>
                    {flag.note && <div className="small">note: {flag.note}</div>}
                  </td>
                  <td>
                    <ul className="small muted">
                      {formatDetail(flag.detail).map((line) => (
                        <li key={line}>{line}</li>
                      ))}
                    </ul>
                  </td>
                  <td className="small muted">
                    <code>{flag.responseId.slice(0, 8)}</code>
                    <div>{new Date(flag.createdAt).toLocaleString()}</div>
                  </td>
                  <td>
                    {flag.status !== 'open' ? (
                      <span className="small muted">
                        {flag.status}
                        {flag.resolvedBy ? ` by ${flag.resolvedBy}` : ''}
                        {flag.resolvedAt ? ` \u00b7 ${new Date(flag.resolvedAt).toLocaleDateString()}` : ''}
                      </span>
                    ) : reviewing === flag.id ? (
                      <div className="stack tight">
                        <input
                          placeholder="Why? kept as the record"
                          value={note}
                          onChange={(e) => setNote(e.target.value)}
                        />
                        <div className="row">
                          <button type="button" onClick={() => void decide(flag.id, 'resolved')} disabled={busy}>
                            Resolve
                          </button>
                          <button
                            type="button"
                            className="ghost"
                            onClick={() => void decide(flag.id, 'dismissed')}
                            disabled={busy}
                          >
                            Dismiss
                          </button>
                          <button
                            type="button"
                            className="ghost"
                            onClick={() => {
                              setReviewing(null);
                              setNote('');
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => {
                          setReviewing(flag.id);
                          setNote('');
                        }}
                      >
                        Review
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/**
 * API keys and webhooks: the machine surface of one organisation.
 *
 * Two things here are deliberate. A secret is shown once, in a panel that says so,
 * because the server stores only a hash of an API key and never returns a signing
 * secret again: a screen that let someone come back for them later would be lying
 * about what the database holds. And every control that changes where an
 * organisation's data goes is hidden from a member who cannot use it, while the API
 * refuses the same calls independently: hiding a button is a courtesy, not a control.
 */
export function IntegrationsView({ orgId, canAdminister }: { orgId: string; canAdminister: boolean }): JSX.Element {
  const keys = useLive(() => api.apiKeys(orgId), { fallbackMs: 60_000, deps: [orgId] });
  const endpoints = useLive(() => api.webhooks(orgId), { fallbackMs: 60_000, deps: [orgId] });

  const [scopeCatalogue, setScopeCatalogue] = useState<ApiScope[]>([]);
  const [eventCatalogue, setEventCatalogue] = useState<Array<{ event: string; detail: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState<{ label: string; value: string; hint: string } | null>(null);

  const [keyName, setKeyName] = useState('');
  const [keyScopes, setKeyScopes] = useState<string[]>(['flags:read']);
  const [keyDays, setKeyDays] = useState('');

  const [hookUrl, setHookUrl] = useState('');
  const [hookEvents, setHookEvents] = useState<string[]>(['response.submitted']);
  const [hookNote, setHookNote] = useState('');

  const [openId, setOpenId] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[] | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);

  // The vocabularies come from the server, so the console cannot drift from what
  // the API will actually accept.
  useEffect(() => {
    let cancelled = false;
    void api
      .apiScopes()
      .then((res) => {
        if (!cancelled) setScopeCatalogue(res.scopes);
      })
      .catch(() => undefined);
    void api
      .webhookEvents()
      .then((res) => {
        if (!cancelled) setEventCatalogue(res.events);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const run = async (action: () => Promise<string | void>, after?: () => void): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const message = await action();
      if (typeof message === 'string') setNotice(message);
      after?.();
    } catch (err) {
      setError(err instanceof ApiError ? (err.message ?? err.code) : 'that did not work');
    } finally {
      setBusy(false);
    }
  };

  const createKey = async (): Promise<void> => {
    const days = Number(keyDays);
    await run(
      async () => {
        const res = await api.createApiKey(orgId, {
          name: keyName.trim(),
          scopes: keyScopes,
          ...(Number.isInteger(days) && days > 0 ? { expiresInDays: days } : {}),
        });
        setRevealed({
          label: `API key "${res.key.name}"`,
          value: res.secret,
          hint: `Send it as Authorization: Bearer <key>. Its prefix is ${res.key.prefix}; that is all you will see of it later.`,
        });
        setKeyName('');
        setKeyDays('');
        return `Created "${res.key.name}". Copy the secret now.`;
      },
      keys.reload,
    );
  };

  const toggleScope = (current: string[], scope: string, on: boolean): string[] =>
    on ? [...current, scope] : current.filter((item) => item !== scope);

  const loadDeliveries = async (endpointId: string): Promise<void> => {
    await run(async () => {
      const res = await api.webhookDeliveries(orgId, endpointId);
      setDeliveries(res.deliveries);
    });
  };

  const keyList = keys.data?.keys ?? [];
  const hookList = endpoints.data?.endpoints ?? [];

  return (
    <div className="stack grow">
      <div className="screen-head">
        <div>
          <span className="eyebrow">Integrations</span>
          <h1>API keys and webhooks</h1>
          <p>
            A key is a restricted session for its creator: it can only call the endpoints that declare one of its
            scopes, only inside this organisation, and it stops working the moment that person leaves the team.
          </p>
        </div>
      </div>

      {error && <p className="error small">{error}</p>}
      {notice && <p className="small muted">{notice}</p>}

      {revealed && (
        <div className="card ok">
          <strong>{revealed.label}: this is the only time it is shown.</strong>
          <div className="row" style={{ marginTop: 'var(--sp-3)' }}>
            <input readOnly value={revealed.value} className="grow" onFocus={(e) => e.target.select()} />
            <button type="button" className="ghost" onClick={() => void navigator.clipboard?.writeText(revealed.value)}>
              Copy
            </button>
            <button type="button" className="ghost" onClick={() => setRevealed(null)}>
              Done
            </button>
          </div>
          <p className="small muted">{revealed.hint}</p>
        </div>
      )}

      <div className="card">
        <div className="row wrap">
          <strong>API keys</strong>
          <span className="muted small">{keyList.filter((key) => key.active).length} active</span>
        </div>
        {canAdminister ? (
          <div className="stack" style={{ marginTop: 'var(--sp-4)' }}>
            <div className="row wrap">
              <input
                placeholder="Name, for example: nightly export"
                value={keyName}
                onChange={(e) => setKeyName(e.target.value)}
                className="grow"
              />
              <input
                placeholder="Expires in days (optional)"
                value={keyDays}
                onChange={(e) => setKeyDays(e.target.value.replace(/[^0-9]/g, ''))}
                style={{ width: '210px' }}
              />
            </div>
            <div className="choices">
              {scopeCatalogue.map((entry) => (
                <label key={entry.scope} className="choice">
                  <input
                    type="checkbox"
                    checked={keyScopes.includes(entry.scope)}
                    disabled={!entry.enforced}
                    onChange={(e) => setKeyScopes((current) => toggleScope(current, entry.scope, e.target.checked))}
                  />
                  <span>
                    <code>{entry.scope}</code>{' '}
                    <span className="muted small">
                      {entry.detail}
                      {entry.enforced ? null : ' No route declares this scope yet, so a key cannot be granted it.'}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            <div className="row wrap">
              <button type="button" onClick={() => void createKey()} disabled={busy || keyName.trim().length < 2}>
                Create key
              </button>
              <span className="muted small">A key with no scope can authenticate and do nothing.</span>
            </div>
          </div>
        ) : (
          <p className="muted small">Only an owner or an admin can issue, rotate or revoke a key.</p>
        )}

        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Prefix</th>
              <th>Scopes</th>
              <th>Created</th>
              <th>Last used</th>
              <th>Expires</th>
              <th>State</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {keyList.map((key) => (
              <tr key={key.id}>
                <td>{key.name}</td>
                <td className="mono small">{key.prefix}</td>
                <td className="small">
                  {key.scopes.length > 0 ? key.scopes.map((scope) => <code key={scope}>{scope}</code>) : <span className="muted">none</span>}
                </td>
                <td className="small">{new Date(key.createdAt).toLocaleDateString()}</td>
                <td className="small">{key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : 'never'}</td>
                <td className="small">{key.expiresAt ? new Date(key.expiresAt).toLocaleDateString() : 'no expiry'}</td>
                <td>
                  <span className={key.active ? 'pill ok' : 'pill'}>{key.active ? 'active' : 'revoked'}</span>
                </td>
                <td>
                  {canAdminister && key.active && (
                    <div className="row">
                      <button
                        type="button"
                        className="ghost"
                        disabled={busy}
                        title={`Issue a new secret for "${key.name}" with the same scopes and expiry. The current secret stops working on its next request.`}
                        onClick={() => {
                          if (
                            !window.confirm(
                              `Rotate "${key.name}"? The current secret (${key.prefix}) stops working on its very next request, so anything still using it breaks until it is given the new one. The new key keeps the same scopes and expiry.`,
                            )
                          )
                            return;
                          void run(async () => {
                            const res = await api.rotateApiKey(orgId, key.id);
                            setRevealed({
                              label: `rotated API key "${res.key.name}"`,
                              value: res.secret,
                              hint: `Send it as Authorization: Bearer <key>. Its prefix is ${res.key.prefix}; ${key.prefix} is revoked and will not be accepted again. The scopes and the expiry are unchanged.`,
                            });
                            return `Rotated "${res.key.name}". The previous secret is already refused.`;
                          }, keys.reload);
                        }}
                      >
                        Rotate
                      </button>
                      <button
                        type="button"
                        className="ghost"
                        disabled={busy}
                        onClick={() => {
                          if (!window.confirm(`Revoke "${key.name}"? Anything using it stops working immediately. This cannot be undone.`)) return;
                          void run(async () => {
                            await api.revokeApiKey(orgId, key.id);
                            return `Revoked "${key.name}".`;
                          }, keys.reload);
                        }}
                      >
                        Revoke
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {keyList.length === 0 && (
              <tr>
                <td colSpan={8} className="muted">
                  No API keys yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div className="row wrap">
          <strong>Webhooks</strong>
          <span className="muted small">
            Signed with HMAC-SHA256 over the timestamp and the body, so a receiver can prove the request is ours.
          </span>
        </div>

        {canAdminister && (
          <div className="stack" style={{ marginTop: 'var(--sp-4)' }}>
            <input
              placeholder="https://example.org/hooks/inicio"
              value={hookUrl}
              onChange={(e) => setHookUrl(e.target.value)}
            />
            <p className="muted small">
              HTTPS only: a signature sent over plaintext proves nothing. The URL is checked again by the database.
            </p>
            <div className="choices">
              {eventCatalogue.map((entry) => (
                <label key={entry.event} className="choice">
                  <input
                    type="checkbox"
                    checked={hookEvents.includes(entry.event)}
                    onChange={(e) => setHookEvents((current) => toggleScope(current, entry.event, e.target.checked))}
                  />
                  <span>
                    <code>{entry.event}</code> <span className="muted small">{entry.detail}</span>
                  </span>
                </label>
              ))}
            </div>
            <div className="row wrap">
              <input
                placeholder="Description (optional)"
                value={hookNote}
                onChange={(e) => setHookNote(e.target.value)}
                className="grow"
              />
              <button
                type="button"
                disabled={busy || !/^https:\/\/.+/.test(hookUrl) || hookEvents.length === 0}
                onClick={() =>
                  void run(
                    async () => {
                      const res = await api.createWebhook(orgId, {
                        url: hookUrl.trim(),
                        events: hookEvents,
                        ...(hookNote.trim() ? { description: hookNote.trim() } : {}),
                      });
                      setRevealed({
                        label: 'Signing secret',
                        value: res.secret,
                        hint: 'Every delivery carries X-Inicio-Signature: sha256=<HMAC of timestamp.body> with this secret. Store it on your receiver; we cannot show it again.',
                      });
                      setHookUrl('');
                      setHookNote('');
                      return 'Endpoint created. Copy the signing secret now.';
                    },
                    endpoints.reload,
                  )
                }
              >
                Add endpoint
              </button>
            </div>
          </div>
        )}

        {hookList.map((endpoint) => (
          <div key={endpoint.id} className="invitebox">
            <div className="row wrap">
              <span className={endpoint.active ? 'pill ok' : 'pill bad'}>{endpoint.active ? 'sending' : 'disabled'}</span>
              <span className="mono small grow">{endpoint.url}</span>
              <span className="muted small">
                {endpoint.pending ?? 0} pending, {endpoint.failed ?? 0} failed
              </span>
            </div>
            {endpoint.description && <p className="small muted">{endpoint.description}</p>}
            {endpoint.reason && <p className="warn small">{endpoint.reason}</p>}
            <p className="small muted">
              {endpoint.events.map((event) => (
                <code key={event}>{event}</code>
              ))}
            </p>
            <p className="small muted">
              Last success: {endpoint.lastSuccessAt ? new Date(endpoint.lastSuccessAt).toLocaleString() : 'never'}. Last
              failure: {endpoint.lastFailureAt ? new Date(endpoint.lastFailureAt).toLocaleString() : 'never'}.
            </p>
            <div className="row wrap">
              <button
                type="button"
                className="ghost"
                disabled={busy}
                onClick={() => {
                  setTestResult(null);
                  void run(async () => {
                    const res = await api.testWebhook(orgId, endpoint.id);
                    setTestResult(
                      res.delivered
                        ? `Test delivered. The receiver answered ${res.status ?? 200}${res.responseBody ? `: ${res.responseBody.slice(0, 200)}` : '.'}`
                        : `Test not delivered${res.status ? ` (HTTP ${res.status})` : ''}: ${res.error ?? 'no answer'}`,
                    );
                  }, endpoints.reload);
                }}
              >
                Send test
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  if (openId === endpoint.id) {
                    setOpenId(null);
                    setDeliveries(null);
                    return;
                  }
                  setOpenId(endpoint.id);
                  setDeliveries(null);
                  setTestResult(null);
                  void loadDeliveries(endpoint.id);
                }}
              >
                {openId === endpoint.id ? 'Hide deliveries' : 'Deliveries'}
              </button>
              {canAdminister && (
                <>
                  <button
                    type="button"
                    className="ghost"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await api.updateWebhook(orgId, endpoint.id, { active: !endpoint.active });
                        return endpoint.active ? 'Endpoint paused.' : 'Endpoint re-enabled.';
                      }, endpoints.reload)
                    }
                  >
                    {endpoint.active ? 'Pause' : 'Re-enable'}
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    disabled={busy}
                    onClick={() => {
                      if (!window.confirm(`Delete the endpoint ${endpoint.url} and its delivery history?`)) return;
                      void run(async () => {
                        await api.deleteWebhook(orgId, endpoint.id);
                        if (openId === endpoint.id) {
                          setOpenId(null);
                          setDeliveries(null);
                        }
                        return 'Endpoint deleted.';
                      }, endpoints.reload);
                    }}
                  >
                    Delete
                  </button>
                </>
              )}
            </div>

            {testResult && <p className="small">{testResult}</p>}

            {openId === endpoint.id && (
              <table>
                <thead>
                  <tr>
                    <th>Event</th>
                    <th>State</th>
                    <th>Tries</th>
                    <th>Receiver</th>
                    <th>When</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {(deliveries ?? []).map((delivery) => (
                    <tr key={delivery.id}>
                      <td className="mono small">{delivery.event}</td>
                      <td>
                        <span className={delivery.status === 'delivered' ? 'pill ok' : delivery.status === 'failed' ? 'pill bad' : 'pill warn'}>
                          {delivery.status}
                        </span>
                      </td>
                      <td>{delivery.attempts}</td>
                      <td className="small">
                        {delivery.response_status ?? '-'}
                        {delivery.error && <span className="error small"> {delivery.error}</span>}
                      </td>
                      <td className="small">{new Date(delivery.created_at).toLocaleString()}</td>
                      <td>
                        {canAdminister && delivery.status !== 'delivered' && (
                          <button
                            type="button"
                            className="ghost"
                            disabled={busy}
                            onClick={() =>
                              void run(async () => {
                                await api.retryWebhookDelivery(orgId, delivery.id);
                                const res = await api.webhookDeliveries(orgId, endpoint.id);
                                setDeliveries(res.deliveries);
                                return 'Retried.';
                              }, endpoints.reload)
                            }
                          >
                            Retry
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {deliveries !== null && deliveries.length === 0 && (
                    <tr>
                      <td colSpan={6} className="muted">
                        Nothing has been sent to this endpoint yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}
          </div>
        ))}

        {hookList.length === 0 && <p className="muted small">No endpoints yet.</p>}
      </div>
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
  // Integrations is readable by any member (the API allows it) and only writable by
  // an owner or admin, which the view enforces by hiding the controls it cannot use.
  const [showIntegrations, setShowIntegrations] = useState(false);
  const currentOrg = orgs.find((o) => o.id === orgId) ?? null;
  // The menu entry is hidden for members and viewers, and the server refuses the
  // same calls independently. Hiding a button is a courtesy, not a control.
  const canAdminister = currentOrg?.role === 'owner' || currentOrg?.role === 'admin';

  // The sidebar spans every form in the organisation, so no single form's stream
  // describes it. It stays a slow read, and it says so rather than pretending.
  const { data: forms, reload: reloadForms } = useLive(() => api.forms(), {
    fallbackMs: 20_000,
    deps: [orgId],
  });
  // Templates ship with the source and change on deploy, not while a page is open.
  const { data: templates } = useLive(() => api.templates(), { fallbackMs: 300_000, deps: [] });
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

  const activeOrg = orgs.find((org) => org.id === orgId) ?? null;

  return (
    <>
      <header className="appbar">
        <div className="row">
          <span className="brand">Inicio</span>
          <span className="muted small">{me.user.email}</span>
        </div>
        <div className="appbar-right">
          <span className="pill">{activeOrg ? `${activeOrg.name} \u00b7 ${activeOrg.role}` : 'No organisation yet'}</span>
          <span className="muted small">
            {orgForms.length} form{orgForms.length === 1 ? '' : 's'}
          </span>
          <button type="button" className="ghost" onClick={onSignedOut}>
            Sign out
          </button>
        </div>
      </header>

      <div className="shell">
        <aside className="sidebar">
          <span className="eyebrow">Workspace</span>
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
                className={form.id === formId && !showAdmin && !showIntegrations ? 'tab active' : 'tab'}
                onClick={() => {
                  setFormId(form.id);
                  setShowAdmin(false);
                  setShowIntegrations(false);
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
              setShowIntegrations(false);
              setFormId(null);
            }}
          >
            People and invitations
          </button>
        )}
        <button
          type="button"
          className={showIntegrations ? 'tab active' : 'tab'}
          onClick={() => {
            setShowIntegrations(true);
            setShowAdmin(false);
            setFormId(null);
          }}
        >
          API keys and webhooks
        </button>

      </aside>

      <main className="main">
        {showIntegrations && orgId ? (
          <IntegrationsView orgId={orgId} canAdminister={canAdminister} />
        ) : showAdmin && orgId ? (
          <AdminView orgId={orgId} canAdminister={canAdminister} />
        ) : selectedForm ? (
          <FormView form={selectedForm} onBack={() => setFormId(null)} />
        ) : (
          <section>
            <div className="screen-head">
              <div>
                <span className="eyebrow">Workspace</span>
                <h1>Your work</h1>
                <p className="muted">
                  Pick a form on the left, or create one: blank, from a template such as the School Ranking Survey
                  2026, or by uploading an XLSForm workbook. Logic, validation and calculations run in the same engine
                  on the client and the server, and the server is the authority when a response is submitted.
                </p>
              </div>
            </div>
            <div className="card">
              <ul>
              <li>Publish a version and it becomes immutable: responses always record the version they answered.</li>
              <li>Quotas count on submission; partial responses are first-class and exportable.</li>
              <li>Exports are bundles: data, codebook, value labels and a missing-code table.</li>
              </ul>
            </div>
          </section>
        )}
      </main>
      </div>
    </>
  );
}

/**
 * Routes.
 *
 *     /                       the landing page (signed out) or the console (signed in)
 *     /console                the console; a signed out visitor is sent to /login
 *     /login                  sign in with a one-time code
 *     /collect/:token         the respondent surface, no session at all
 *     /invite/:token          an invitation, no session yet
 *     /terms, /privacy        the policy text, public
 *
 * The router is deliberately the smallest thing that works: the URL is state, the
 * `popstate` event is the transition, and `navigate` is the only way to change it.
 * A routing library would be a dependency, a bundle and a concept for six paths.
 */
export function App(): JSX.Element {
  const [path, setPath] = useState(() => window.location.pathname);
  const collectMatch = useMemo(() => /^\/collect\/(.+)$/.exec(path), [path]);
  const inviteMatch = useMemo(() => /^\/invite\/(.+)$/.exec(path), [path]);
  const legalMatch = useMemo(() => /^\/(terms|privacy)$/.exec(path), [path]);
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [terms, setTerms] = useState<TermsStatus | null>(null);

  useEffect(() => {
    const onPopState = (): void => setPath(window.location.pathname);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const load = useCallback(async (): Promise<void> => {
    try {
      setMe(await api.me());
    } catch {
      setMe(null);
    }
  }, []);

  // The public surfaces never ask who is signed in: a respondent with no account
  // must not trigger a session lookup, and an invitation must open for a stranger.
  const isPublicSurface = Boolean(collectMatch || inviteMatch || legalMatch);
  useEffect(() => {
    if (!isPublicSurface) void load();
  }, [isPublicSurface, load]);

  const signedIn = me !== undefined && me !== null;
  const onMarketing = path === '/' || path === '';
  const onLogin = path === '/login';

  // Someone with a session who lands on the marketing page or the sign in page has
  // already done the thing those pages ask for, so they go to the console.
  useEffect(() => {
    if (!signedIn) return;
    if (onMarketing || onLogin) navigate('/console');
  }, [signedIn, onMarketing, onLogin]);

  const goToConsole = useCallback((): void => {
    void load();
    if (window.location.pathname !== '/console') navigate('/console');
  }, [load]);

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

  // The marketing page renders immediately rather than waiting on the session
  // check, because it does not depend on the answer: a visitor sees the product
  // present itself, and a signed in reader who asked for the bare domain is sent
  // on to the console by the effect above.
  //
  // Every route except the landing page is wrapped in the ambient chrome, which is
  // what makes signing in feel like walking further into the same room rather than
  // arriving at a different site. The landing page is the one exclusion: it carries
  // its own scene, and a second renderer behind it would be two worlds at once.
  const marketing = onMarketing && !signedIn;
  let page: JSX.Element;
  if (inviteMatch?.[1]) page = <InvitePage token={decodeURIComponent(inviteMatch[1])} />;
  else if (legalMatch?.[1]) page = <LegalPage id={legalMatch[1] as 'terms' | 'privacy'} />;
  else if (collectMatch?.[1]) page = <Collect token={decodeURIComponent(collectMatch[1])} />;
  else if (marketing) {
    page = (
      <Suspense
        fallback={
          <div className="boot surface" role="status">
            <span className="boot-bar" aria-hidden="true" />
            <p>Inicio</p>
          </div>
        }
      >
        <Landing />
      </Suspense>
    );
  } else if (onLogin && !signedIn) page = <Login onSignedIn={goToConsole} />;
  else if (me === undefined) {
    page = (
      <div className="boot surface" role="status">
        <span className="boot-bar" aria-hidden="true" />
        <p>Opening your workspace.</p>
      </div>
    );
  } else if (me === null) page = <Login onSignedIn={goToConsole} />;
  else if (terms?.required) {
    page = <TermsGate status={terms} onAccepted={() => setTerms({ ...terms, required: false })} />;
  } else {
    page = (
      <Workspace
        me={me}
        onSignedOut={() => {
          void api.logout().finally(() => setMe(null));
        }}
      />
    );
  }

  return (
    <>
      {/*
       * The trail is the one layer that is on *every* route, including the marketing
       * page — it is the page the trail was written for, and the only reason it used to
       * be mounted there alone was that nothing else had it yet. The ambient field stays
       * behind the signed-in app, because the landing page carries its own scene and two
       * renderers on one page is two worlds at once.
       */}
      <CursorTrail />
      {!marketing && <ImmersiveChrome />}
      {page}
    </>
  );
}
