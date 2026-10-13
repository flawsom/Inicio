import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { apiUrl } from './api';
import { navigate } from './router';
import './landing.css';

/**
 * The landing page.
 *
 * Two rules govern everything here.
 *
 * 1. Nothing on it is invented. Every number in the live band is read from
 *    `/api/v1/public/summary` in this request, and the panel prints the time it
 *    was read so a reader can tell a live figure from a decorative one. There are
 *    no testimonials, no customer logos and no metric we have not measured,
 *    because a landing page that opens with a number the product cannot produce is
 *    the first place trust is lost. Where a claim needs evidence it links to the
 *    file that contains it.
 *
 * 2. The scene is decoration and behaves like it. It is `aria-hidden`, it stops
 *    entirely when the tab is hidden or the stage has scrolled past, it drops to a
 *    cheaper tier on a small screen, and under `prefers-reduced-motion` it draws
 *    one frame and never starts a loop. The page is complete and readable with no
 *    WebGL at all.
 */

interface DatabaseFacts {
  latencyMs: number;
  serverTime: string;
  version: string;
  startedAt: string;
  migrationsApplied: number;
  latestMigration: string | null;
  listening: boolean;
}

interface TemplateSummary {
  id: string;
  title: string;
  description: string;
  questionCount: number;
  groupCount: number;
  languages: string[];
  questionTypes: string[];
}

interface Summary {
  generatedAt: string;
  database: DatabaseFacts;
  templates: TemplateSummary[];
  engine: {
    questionTypesInUse: string[];
    templateQuestions: number;
    templateGroups: number;
  };
}

const REPOSITORY = 'https://github.com/flawsom/Inicio';

/** Split an element's text into per-character spans once, so they can be animated. */
function splitChars(element: HTMLElement): void {
  const walk = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.textContent ?? '';
        if (!text.trim()) continue;
        const fragment = document.createDocumentFragment();
        for (const character of text) {
          const span = document.createElement('span');
          span.className = 'lchar';
          span.textContent = character;
          fragment.appendChild(span);
        }
        child.replaceWith(fragment);
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        walk(child);
      }
    }
  };
  walk(element);
  element.querySelectorAll<HTMLElement>('.lchar').forEach((span, index) => {
    span.style.setProperty('--i', String(index));
  });
}

/**
 * Reveal on first sight, then stop caring.
 *
 * The hidden state is applied by a class this hook adds, not by the stylesheet on
 * its own. That ordering is deliberate: if the script never runs, `l-anim` is never
 * added and every word is on the page from the first paint, rather than an empty
 * page waiting for an animation that is not coming.
 */
function useReveal<T extends HTMLElement>(): RefObject<T> {
  const ref = useRef<T>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const splittable = Array.from(root.querySelectorAll<HTMLElement>('[data-split]'));
    splittable.forEach((target) => splitChars(target));
    root.classList.add('l-anim');

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add('in');
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.15 },
    );
    // Both selectors: a split headline animates per character, a plain reveal
    // animates as one block, and an element that is both needs one observation.
    for (const target of root.querySelectorAll('[data-reveal], [data-split]')) observer.observe(target);
    return () => observer.disconnect();
  }, []);
  return ref;
}

/** A few pixels of pull toward the pointer. Cheap, and only where there is a pointer. */
function useMagnetic<T extends HTMLElement>(strength = 0.22): RefObject<T> {
  const ref = useRef<T>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (!window.matchMedia('(hover: hover)').matches) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let frame = 0;
    let targetX = 0;
    let targetY = 0;
    let currentX = 0;
    let currentY = 0;
    let running = false;

    const tick = (): void => {
      currentX += (targetX - currentX) * 0.18;
      currentY += (targetY - currentY) * 0.18;
      element.style.transform = `translate3d(${currentX.toFixed(2)}px, ${currentY.toFixed(2)}px, 0)`;
      if (Math.abs(targetX - currentX) < 0.05 && Math.abs(targetY - currentY) < 0.05) {
        running = false;
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    const start = (): void => {
      if (running) return;
      running = true;
      frame = requestAnimationFrame(tick);
    };
    const onMove = (event: PointerEvent): void => {
      const rect = element.getBoundingClientRect();
      const centreX = rect.left + rect.width / 2;
      const centreY = rect.top + rect.height / 2;
      const within = Math.abs(event.clientX - centreX) < rect.width * 0.9 + 40 && Math.abs(event.clientY - centreY) < rect.height + 30;
      targetX = within ? (event.clientX - centreX) * strength : 0;
      targetY = within ? (event.clientY - centreY) * strength : 0;
      start();
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      cancelAnimationFrame(frame);
    };
  }, [strength]);
  return ref;
}

function useLiveSummary(): { summary: Summary | null; readAt: Date | null; failed: boolean } {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [readAt, setReadAt] = useState<Date | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const response = await fetch(apiUrl('/public/summary'), { credentials: 'omit' });
        if (!response.ok) throw new Error(String(response.status));
        const body = (await response.json()) as Summary;
        if (cancelled) return;
        setSummary(body);
        setReadAt(new Date());
        setFailed(false);
      } catch {
        if (!cancelled) setFailed(true);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 20_000);
    const refreshIfVisible = (): void => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', refreshIfVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshIfVisible);
    };
  }, []);

  return { summary, readAt, failed };
}

function InstrumentStage({ quality }: { quality: 'high' | 'low' }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<'idle' | 'ready' | 'unavailable'>('idle');

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    let instrument: { setProgress(n: number): void; setPointer(x: number, y: number): void; setActive(a: boolean): void; resize(): void; dispose(): void } | null = null;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // The scene is a separate chunk: a reader who is signed in and heading for the
    // console never downloads three.js, because this component is not rendered for
    // them.
    void import('./immersive/instrument')
      .then((module) => module.createInstrument(canvas, { quality, reducedMotion }))
      .then((created) => {
        if (disposed) {
          created?.dispose();
          return;
        }
        instrument = created;
        setStatus(created ? 'ready' : 'unavailable');
      })
      .catch(() => {
        if (!disposed) setStatus('unavailable');
      });

    const stage = document.getElementById('landing-stage');

    const readScroll = (): void => {
      const height = Math.max(1, (stage?.offsetHeight ?? window.innerHeight) - window.innerHeight);
      const progress = Math.min(1, Math.max(0, window.scrollY / height));
      instrument?.setProgress(progress);
      // Past the stage there is nothing to look at, so stop drawing rather than
      // burning a core on an off-screen animation.
      instrument?.setActive(progress < 1 && document.visibilityState === 'visible');
    };

    let scrollFrame = 0;
    const onScroll = (): void => {
      if (scrollFrame) return;
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = 0;
        readScroll();
      });
    };

    const onPointerMove = (event: PointerEvent): void => {
      instrument?.setPointer(
        (event.clientX / window.innerWidth) * 2 - 1,
        -((event.clientY / window.innerHeight) * 2 - 1),
      );
    };

    const onVisibility = (): void => {
      const hidden = document.visibilityState !== 'visible';
      instrument?.setActive(!hidden && window.scrollY < (stage?.offsetHeight ?? window.innerHeight));
    };

    const onResize = (): void => instrument?.resize();

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('resize', onResize, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      disposed = true;
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      if (scrollFrame) cancelAnimationFrame(scrollFrame);
      instrument?.dispose();
    };
  }, [quality]);

  return (
    <>
      <canvas
        ref={canvasRef}
        className={status === 'ready' ? 'linstrument ready' : 'linstrument'}
        aria-hidden="true"
      />
      {status === 'unavailable' && <div className="lfallback" aria-hidden="true" />}
    </>
  );
}

/** The pointer ring. Desktop only, and never the only way to see something. */
function PointerRing(): JSX.Element | null {
  const dotRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    setEnabled(true);

    let ringX = window.innerWidth / 2;
    let ringY = window.innerHeight / 2;
    let targetX = ringX;
    let targetY = ringY;
    let frame = 0;

    const tick = (): void => {
      ringX += (targetX - ringX) * 0.18;
      ringY += (targetY - ringY) * 0.18;
      if (ringRef.current) ringRef.current.style.transform = `translate3d(${ringX}px, ${ringY}px, 0)`;
      frame = requestAnimationFrame(tick);
    };
    const onMove = (event: PointerEvent): void => {
      targetX = event.clientX;
      targetY = event.clientY;
      if (dotRef.current) dotRef.current.style.transform = `translate3d(${event.clientX}px, ${event.clientY}px, 0)`;
      const target = event.target as HTMLElement | null;
      const interactive = target?.closest('a, button, [data-cursor]');
      if (ringRef.current) {
        ringRef.current.classList.toggle('on', Boolean(interactive));
        const label = interactive?.getAttribute('data-cursor');
        ringRef.current.dataset.label = label ?? '';
      }
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    frame = requestAnimationFrame(tick);
    return () => {
      window.removeEventListener('pointermove', onMove);
      cancelAnimationFrame(frame);
    };
  }, []);

  if (!enabled) return null;
  return (
    <>
      <div ref={dotRef} className="lcursor-dot" aria-hidden="true" />
      <div ref={ringRef} className="lcursor-ring" aria-hidden="true" />
    </>
  );
}

function LiveBand({ summary, readAt, failed }: { summary: Summary | null; readAt: Date | null; failed: boolean }): JSX.Element {
  const figures = useMemo(() => {
    if (!summary) return [];
    return [
      { value: `${summary.database.latencyMs.toFixed(1)} ms`, label: 'database round trip, measured by this read' },
      { value: String(summary.database.migrationsApplied), label: `migrations applied, latest ${summary.database.latestMigration ?? 'none'}` },
      { value: String(summary.engine.questionTypesInUse.length), label: 'question types the shipped templates actually use' },
      { value: String(summary.templates.length), label: `templates, ${summary.engine.templateQuestions} questions between them` },
    ];
  }, [summary]);

  return (
    <section className="llive" data-reveal id="live">
      <div className="llive-head">
        <span className="leyebrow">Read live from the database</span>
        <span className={failed ? 'llive-state bad' : 'llive-state'}>
          <i aria-hidden="true" />
          {failed
            ? 'the API did not answer; nothing is being shown rather than something old'
            : readAt
              ? `answered at ${readAt.toLocaleTimeString()}`
              : 'asking the API'}
        </span>
      </div>
      <dl className="llive-grid">
        {figures.map((figure) => (
          <div key={figure.label}>
            <dt>{figure.value}</dt>
            <dd>{figure.label}</dd>
          </div>
        ))}
      </dl>
      <p className="llive-note">
        These come from <code>GET /api/v1/public/summary</code>, which reports how the software is doing and
        nothing about who is using it. There is no analytics script on this page, and the one third-party
        request is the font.
      </p>
    </section>
  );
}

 const CAPABILITIES: Array<{ title: string; body: string; evidence: string; href: string }> = [
  {
    title: 'One expression engine, two runtimes',
    body:
      'Relevance, constraints, calculations and choice filters are parsed, validated and evaluated by a single implementation. A question the server hides is hidden on the device, and a calculation is never trusted from the client.',
    evidence: 'packages/engine',
    href: `${REPOSITORY}/tree/main/packages/engine`,
  },
  {
    title: 'Collection that works with no signal',
    body:
      'The device owns its response: a client-generated UUID is the response id, every keystroke lands in IndexedDB before anything is sent, and a durable outbox syncs when the network returns. A retried submission never becomes a second response.',
    evidence: 'apps/web/src/offline',
    href: `${REPOSITORY}/tree/main/apps/web/src/offline`,
  },
  {
    title: 'Conflicts kept, not resolved away',
    body:
      'Every sync sends the last server state the device saw, so the merge is decided per question. When two devices disagree, the server value is stored, the device value is retained beside it, and the disagreement is recorded as a row.',
    evidence: 'apps/api/test/collect-sync.test.ts',
    href: `${REPOSITORY}/blob/main/apps/api/test/collect-sync.test.ts`,
  },
  {
    title: 'Tenancy the database enforces',
    body:
      'Fourteen tenant tables carry ENABLE and FORCE row level security, and the organisation is a parameter of the transaction. The API refuses to start in production on a connection that can bypass it.',
    evidence: 'apps/api/src/db/pool.ts',
    href: `${REPOSITORY}/blob/main/apps/api/src/db/pool.ts`,
  },
  {
    title: 'Exports built from the version that collected the data',
    body:
      'CSV bundle with a codebook, value labels and the missing-code table, plus XLSX and JSON. They are generated from the published definition the responses actually answered, not from the current draft.',
    evidence: 'packages/engine/src/export',
    href: `${REPOSITORY}/tree/main/packages/engine/src/export`,
  },
  {
    title: 'Pushed, not polled',
    body:
      'Open a form and the server tells the browser which aggregate changed, coalesced per tick, over one server-sent event stream per form. The screens refetch only what moved, and a quiet form costs nothing.',
    evidence: 'apps/api/src/platform/events.ts',
    href: `${REPOSITORY}/blob/main/apps/api/src/platform/events.ts`,
  },
];

export function Landing(): JSX.Element {
  const root = useReveal<HTMLDivElement>();
  const primaryCta = useMagnetic<HTMLButtonElement>(0.18);
  const { summary, readAt, failed } = useLiveSummary();

  const quality = useMemo<'high' | 'low'>(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return 'low';
    const small = window.matchMedia('(max-width: 860px)').matches;
    const weak = (navigator.hardwareConcurrency || 8) <= 4;
    return small || weak ? 'low' : 'high';
  }, []);

  const signIn = useCallback(() => navigate('/login'), []);

  return (
    <div className="landing" ref={root}>
      <InstrumentStage quality={quality} />
      <PointerRing />

      <header className="lnav">
        <span className="lbrand">
          <i aria-hidden="true" />
          Inicio
        </span>
        <nav>
          <a href="#live">Live</a>
          <a href="#capabilities">Capabilities</a>
          <a href="#templates">Templates</a>
          <a href={REPOSITORY} rel="noreferrer noopener" target="_blank">
            Source
          </a>
          <button type="button" className="lcta small" onClick={signIn}>
            Sign in
          </button>
        </nav>
      </header>

      <div id="landing-stage" className="lstage">
        <section className="lhero">
          <span className="leyebrow lhero-eyebrow" data-reveal>
            Multi-tenant survey and data-collection platform
          </span>
          <h1 data-split data-reveal>
            Real logic.
          </h1>
          <h1 data-split data-reveal className="lhero-line2">
            Real collection.
          </h1>
          <p className="lhero-sub" data-reveal>
            Build a questionnaire with genuine skipping, validation and calculation. Circulate it to the people who
            have the answers. Collect it anywhere, including where there is no signal, and export data that is ready
            for analysis rather than merely downloaded.
          </p>
          <div className="lhero-actions" data-reveal>
            <button ref={primaryCta} type="button" className="lcta" onClick={signIn} data-cursor="Open">
              Sign in with a one-time code
            </button>
            <a className="lghost" href="#capabilities">
              See what is actually built
            </a>
          </div>
          <p className="lhero-foot" data-reveal>
            Accounts are invitation only. Every organisation sees its own data and nothing else, and that boundary is
            enforced by PostgreSQL rather than by the application.
          </p>
        </section>

        <section className="lclaim" data-reveal>
          <span className="leyebrow">Why it is shaped this way</span>
          <p className="lclaim-text" data-split>
            A survey tool is judged in the field, not in the demo.
          </p>
          <p className="lclaim-body">
            So this one is built around the three moments where the others fall over: the rule that has to mean the
            same thing on a phone as it does on the server, the interview that happens somewhere with no bars, and the
            export a researcher opens in an analysis tool the next morning. Everything below is either that, or it is
            not here yet.
          </p>
        </section>

        <LiveBand summary={summary} readAt={readAt} failed={failed} />
      </div>

      <section className="lcapabilities" id="capabilities">
        <header>
          <span className="leyebrow">Capabilities</span>
          <h2 data-split data-reveal>
            Six things that are finished, and where to check them
          </h2>
          <p data-reveal>
            Each one names the file that implements it. Nothing here is a plan: if it is on this page, it is in the
            repository that is deployed.
          </p>
        </header>
        <div className="lcards">
          {CAPABILITIES.map((capability) => (
            <article key={capability.title} data-reveal>
              <h3>{capability.title}</h3>
              <p>{capability.body}</p>
              <a href={capability.href} target="_blank" rel="noreferrer noopener" className="lcode">
                {capability.evidence}
              </a>
            </article>
          ))}
        </div>
      </section>

      <section className="ltemplates" id="templates">
        <header>
          <span className="leyebrow">Templates</span>
          <h2 data-split data-reveal>
            Start from a real instrument
          </h2>
          <p data-reveal>
            These load from the API, which reads them from the database the deployment is running on. A template is a
            canonical definition, not a spreadsheet: it is type-checked when the code is built and it goes through the
            same publish-time analyser as anything an author writes by hand.
          </p>
        </header>
        <div className="ltemplate-grid">
          {(summary?.templates ?? []).map((template) => (
            <article key={template.id} data-reveal>
              <span className="lpill">{template.id}</span>
              <h3>{template.title}</h3>
              <p>{template.description}</p>
              <dl>
                <div>
                  <dt>{template.questionCount}</dt>
                  <dd>questions</dd>
                </div>
                <div>
                  <dt>{template.groupCount}</dt>
                  <dd>groups</dd>
                </div>
                <div>
                  <dt>{template.languages.length}</dt>
                  <dd>languages</dd>
                </div>
                <div>
                  <dt>{template.questionTypes.length}</dt>
                  <dd>question types</dd>
                </div>
              </dl>
              <p className="ltypes">{template.questionTypes.join(' ')}</p>
            </article>
          ))}
          {!summary && (
            <p className="lquiet">
              {failed
                ? 'The template library could not be read from the API, so it is not being guessed at.'
                : 'Reading the template library from the API.'}
            </p>
          )}
        </div>
      </section>

      <section className="lhonest">
        <header>
          <span className="leyebrow">Also true</span>
          <h2 data-split data-reveal>
            What is deliberately not here
          </h2>
        </header>
        <ul>
          <li>
            <strong>No analytics or trackers.</strong> This page makes one request, to this deployment, and loads a
            font. There is no third-party script in the path.
          </li>
          <li>
            <strong>No fake SPSS export.</strong> A <code>.sav</code> or <code>.dta</code> request answers 501 with a
            reason, because the worker that would write a correct file does not exist yet. A file that fails inside
            SPSS is worse than an honest refusal.
          </li>
          <li>
            <strong>No half-built uploads.</strong> The <code>image</code> and <code>file</code> question types render
            as "not collected yet" rather than silently skipping the answer.
          </li>
          <li>
            <strong>No mock data anywhere.</strong> The console shows live queries, the collection app shows what is on
            the device, and this page shows numbers the API just computed.
          </li>
        </ul>
        <a className="lghost" href={`${REPOSITORY}/blob/main/docs/ROADMAP.md`} target="_blank" rel="noreferrer noopener">
          Read the honest status document
        </a>
      </section>

      <footer className="lfooter">
        <div>
          <span className="leyebrow">Get in</span>
          <h2 data-split data-reveal>
            Invitations are issued by an organisation owner
          </h2>
          <p>
            There is no open signup path on purpose. If you already have an account, sign in with a one-time code. If
            you want to run this yourself, the repository has a five minute local path with Docker or without it.
          </p>
        </div>
        <div className="lfooter-actions">
          <button type="button" className="lcta" onClick={signIn}>
            Sign in
          </button>
          <a className="lghost" href={`${REPOSITORY}#-quick-start`} target="_blank" rel="noreferrer noopener">
            Run it locally
          </a>
        </div>
        <div className="lfooter-legal">
          <span>Inicio</span>
          <span>
            Apache 2.0 ·{' '}
            <a href={REPOSITORY} target="_blank" rel="noreferrer noopener">
              github.com/flawsom/Inicio
            </a>
          </span>
        </div>
      </footer>
    </div>
  );
}
