import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { apiUrl } from './api';
import { navigate } from './router';
import { BEAT_IDS, beatIndexAt, type BeatId } from './immersive/choreography';
import './landing.css';

/**
 * The landing page.
 *
 * It is built as one continuous flight through the product, in the order the product
 * actually works: a questionnaire is a program, it is filled in where there is no
 * signal, two devices disagree and both answers are kept, the forms go past, the
 * tenants stay sealed, and the last thing is the way in. The scene is the product
 * itself rather than a sculpture beside it, so a reader who watches the page has
 * already seen what the software does.
 *
 * Three rules govern everything here.
 *
 * 1. Nothing on it is invented. Every number in the evidence band is read from
 *    `/api/v1/public/summary` in this request, and the panel prints when it was read,
 *    so a live figure cannot be mistaken for a decorative one. There are no
 *    testimonials, no customer logos and no metric this product cannot produce.
 *
 * 2. The scene is decoration and behaves like it. It is `aria-hidden`, it fades in
 *    only after the typography has had the first screen to itself, it stops entirely
 *    when the tab is hidden or the journey has been scrolled past, it drops to a
 *    cheaper tier on a small screen, and under `prefers-reduced-motion` it draws one
 *    frame per scroll position and never starts a loop. The page is complete and
 *    readable with no WebGL at all.
 *
 * 3. Text is interface. The copy names the thing it is about and the next action, and
 *    every beat ends with the two taps that let a reader watch that claim work.
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

/**
 * Split an element's text into per-character spans once, so they can be animated.
 *
 * The characters have to be their own boxes for the reveal to stagger, and a box is
 * exactly what ruins the sentence: the browser will end a line after any atomic
 * inline, and a box holding a bare space collapses to no width at all, which is how a
 * headline once rendered as "Startfromarealinstrument" with the words broken
 * mid-letter. So the split is word-first: a word is one `.lword` (inline-block,
 * `nowrap`) holding a `.lchar` per character, and the spaces between words are
 * `.lchar.lspace` pieces that keep their width and stay breakable.
 */
function splitChars(element: HTMLElement): void {
  // Splitting is not idempotent, and the effect that calls it runs twice in
  // development (StrictMode mounts, unmounts and mounts again). A marker makes the
  // second pass a no-op instead of nesting every character in a word of its own.
  if (element.dataset.splitDone === 'true') return;
  element.dataset.splitDone = 'true';

  const walk = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.textContent ?? '';
        // A whitespace-only node is the layout of the JSX around an element, not text
        // a reader sees.
        if (!text.trim()) continue;
        const fragment = document.createDocumentFragment();
        for (const run of text.match(/\s+|\S+/g) ?? []) {
          if (/^\s+$/.test(run)) {
            for (let i = 0; i < run.length; i += 1) {
              const space = document.createElement('span');
              space.className = 'lchar lspace';
              space.textContent = ' ';
              fragment.appendChild(space);
            }
            continue;
          }
          const word = document.createElement('span');
          word.className = 'lword';
          for (const character of run) {
            const span = document.createElement('span');
            span.className = 'lchar';
            span.textContent = character;
            word.appendChild(span);
          }
          fragment.appendChild(word);
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
 * The hidden state is applied by a class this hook adds rather than by the stylesheet
 * on its own, so if the script never runs every word is on the page from the first
 * paint instead of waiting for an animation that is not coming.
 */
function useReveal<T extends HTMLElement>(): RefObject<T> {
  const ref = useRef<T>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
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

    const adopt = (scope: HTMLElement): void => {
      const targets = [
        ...(scope.matches('[data-reveal], [data-split]') ? [scope] : []),
        ...Array.from(scope.querySelectorAll<HTMLElement>('[data-reveal], [data-split]')),
      ];
      for (const target of targets) {
        if (target.hasAttribute('data-split')) splitChars(target);
        observer.observe(target);
      }
    };

    adopt(root);

    // The template list is rendered from the API response, which arrives after this
    // effect has run, and an observer built here sees only what exists now. Watching
    // the subtree is what makes "reveal on first sight" true for fetched content as
    // well as for the markup that mounted with the page.
    const mutations = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          if (node instanceof HTMLElement) adopt(node);
        }
      }
    });
    mutations.observe(root, { childList: true, subtree: true });

    return () => {
      mutations.disconnect();
      observer.disconnect();
    };
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
      const within =
        Math.abs(event.clientX - centreX) < rect.width * 0.9 + 40 &&
        Math.abs(event.clientY - centreY) < rect.height + 30;
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

/** How far through the journey the reader is, as one number, without re-rendering on every pixel. */
function useJourneyProgress(): number {
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    const journey = document.getElementById('landing-journey');
    if (!journey) return;
    let frame = 0;
    const read = (): void => {
      frame = 0;
      const top = journey.offsetTop;
      const span = Math.max(1, journey.offsetHeight - window.innerHeight);
      const next = Math.min(1, Math.max(0, (window.scrollY - top) / span));
      setProgress((current) => (Math.abs(current - next) > 0.004 ? next : current));
    };
    const onScroll = (): void => {
      if (frame) return;
      frame = requestAnimationFrame(read);
    };
    read();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
  return progress;
}

function InstrumentStage({ quality }: { quality: 'high' | 'low' }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<'idle' | 'ready' | 'unavailable'>('idle');

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    let instrument: {
      setProgress(n: number): void;
      setPointer(x: number, y: number): void;
      setActive(a: boolean): void;
      resize(): void;
      dispose(): void;
    } | null = null;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // The scene is a separate chunk: a reader who is signed in and heading for the
    // console never downloads it, because this component is not rendered for them.
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

    const journey = document.getElementById('landing-journey');

    const readScroll = (): void => {
      const top = journey?.offsetTop ?? 0;
      const span = Math.max(1, (journey?.offsetHeight ?? window.innerHeight) - window.innerHeight);
      const progress = Math.min(1, Math.max(0, (window.scrollY - top) / span));
      instrument?.setProgress(progress);
      // Past the journey there is nothing to look at, so stop drawing rather than
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
      const top = journey?.offsetTop ?? 0;
      instrument?.setActive(!hidden && window.scrollY - top < (journey?.offsetHeight ?? window.innerHeight));
    };

    const onResize = (): void => instrument?.resize();

    readScroll();
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

interface Beat {
  id: BeatId;
  chapter: string;
  label: string;
  eyebrow?: string;
  title?: string;
  body?: string;
  check?: string;
  /** The fly-through has no text at all: it is the breathing room. */
  silent?: boolean;
}

/**
 * The six beats, in the order the scene visits them.
 *
 * The chapters are numbered so the rail and the foot of each panel agree, and the
 * silent one is still a beat with a target of its own: a reader who clicks chapter four
 * lands on the corridor, which is the point of it being there.
 */
const JOURNEY: Beat[] = [
  {
    id: 'program',
    chapter: '01',
    label: 'A questionnaire is a program',
    eyebrow: 'The questionnaire as a program',
    title: 'One engine, two runtimes',
    body:
      'Relevance, constraints, calculations and choice filters are parsed, validated and evaluated once, and that implementation runs on the server and on the device. A question the server hides is hidden on the phone, a calculated value is never taken from the client, and a rule behaves the same way wherever it runs.',
    check: 'Open the studio and type a relevance rule: the preview hides the question as you type.',
  },
  {
    id: 'sync',
    chapter: '02',
    label: 'Collection with no signal',
    eyebrow: 'Offline collection',
    title: 'The network is a transport, not a dependency',
    body:
      'Every keystroke is durable on the device before anything is sent. A client-generated UUID is the response id, so a retried submission resumes the response it started instead of creating a second one, and a device that spends the afternoon with no bars hands over everything it collected the moment it is back.',
    check: 'Open a collection link, put the phone in flight mode, answer it, then reconnect.',
  },
  {
    id: 'conflict',
    chapter: '03',
    label: 'Disagreements are kept',
    eyebrow: 'Conflict retention',
    title: 'Two versions of one answer, never merged',
    body:
      'Every sync carries the last server state the device saw, so the merge is decided question by question. When two devices disagree, the server value stays canonical, the device value is retained beside it, and the disagreement is stored as a row with both timestamps, both devices and a resolution that a person makes later.',
    check: 'Answer the same question from two devices: the response lists the disagreement.',
  },
  {
    id: 'flythrough',
    chapter: '04',
    label: 'The forms, at speed',
    silent: true,
  },
  {
    id: 'tenants',
    chapter: '05',
    label: 'Tenants, sealed',
    eyebrow: 'Tenant isolation',
    title: 'Three realms, sealed by the database',
    body:
      'Fourteen tenant tables carry ENABLE and FORCE row level security, and the organisation is a parameter of the transaction rather than a filter written into each query. The API refuses to start in production on a connection that could bypass it, so the boundary holds even when the SQL above it is wrong.',
    check: 'Sign in as two organisations: neither can reach the other, not even by id.',
  },
  {
    id: 'invitation',
    chapter: '06',
    label: 'The way in',
    eyebrow: 'The invitation',
    title: 'Invitations are issued by an organisation owner',
    body:
      'There is no open signup path on purpose. If you already have an account, sign in with a one-time code. If your organisation has not added you yet, an owner or an admin can invite you from the members list.',
    check: 'Ask an owner or an admin of your organisation for an invitation link.',
  },
];

function JourneyRail({ progress }: { progress: number }): JSX.Element {
  const active = beatIndexAt(progress);
  return (
    <nav className="lrail" aria-label="The journey">
      <a className="lrail-top" href="#top">
        <span className="lsr-only">Back to the top</span>
        <i aria-hidden="true" />
      </a>
      <ol>
        {JOURNEY.map((beat, index) => (
          <li key={beat.id}>
            <a
              href={`#${beat.id}`}
              className={index === active ? 'lrail-dot in' : 'lrail-dot'}
              aria-current={index === active ? 'true' : undefined}
            >
              <span className="lsr-only">
                {beat.chapter} {beat.label}
              </span>
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

function EvidenceBand({
  summary,
  readAt,
  failed,
}: {
  summary: Summary | null;
  readAt: Date | null;
  failed: boolean;
}): JSX.Element {
  const figures = useMemo(() => {
    if (!summary) return [];
    return [
      { value: `${summary.database.latencyMs.toFixed(1)} ms`, label: 'database round trip, measured by this read' },
      {
        value: String(summary.database.migrationsApplied),
        label: `migrations applied, latest ${summary.database.latestMigration ?? 'none'}`,
      },
      {
        value: String(summary.engine.questionTypesInUse.length),
        label: 'question types the shipped templates actually use',
      },
      {
        value: String(summary.templates.length),
        label: `templates, ${summary.engine.templateQuestions} questions between them`,
      },
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
      <dl className="llive-figures">
        {figures.map((figure) => (
          <div key={figure.label}>
            <dt>{figure.value}</dt>
            <dd>{figure.label}</dd>
          </div>
        ))}
      </dl>
      <p className="llive-note">
        These come from <code>GET /api/v1/public/summary</code>, which reports how the software is doing and
        nothing about who is using it. There is no analytics script on this page, and the one third-party request
        is the font.
      </p>
      <p className="lwhere">
        <span>Where to check it</span>
        The same summary is open in a browser tab: it is public on purpose, and it carries no tenant data.
      </p>
    </section>
  );
}

export function Landing(): JSX.Element {
  const root = useReveal<HTMLDivElement>();
  const primaryCta = useMagnetic<HTMLButtonElement>(0.18);
  const { summary, readAt, failed } = useLiveSummary();
  const progress = useJourneyProgress();

  const quality = useMemo<'high' | 'low'>(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return 'low';
    const small = window.matchMedia('(max-width: 860px)').matches;
    const weak = (navigator.hardwareConcurrency || 8) <= 4;
    return small || weak ? 'low' : 'high';
  }, []);

  const signIn = useCallback(() => navigate('/login'), []);

  return (
    <div className="landing" ref={root} id="top">
      <InstrumentStage quality={quality} />

      <header className="lnav">
        <span className="lbrand">
          <i aria-hidden="true" />
          Inicio
        </span>
        <nav>
          <button type="button" className="lcta small" onClick={signIn} data-cursor="Sign in">
            Sign in
          </button>
        </nav>
      </header>

      <JourneyRail progress={progress} />

      {/*
        The hero is pure typography on the empty surface, with no 3D object in it: the
        scene fades in as this scrolls away, so the first thing a reader meets is a
        sentence rather than a render. The three lines are one heading whose accessible
        name is the whole sentence, because the per-character boxes the reveal needs
        would otherwise leave a screen reader reading the words with no spaces.
      */}
      <section className="lhero">
        <span className="leyebrow lhero-eyebrow" data-reveal>
          {BEAT_IDS.length} beats, one flight through the product
        </span>
        <h1 className="lhero-title" aria-label="Real logic. Offline collection. Analysis-ready data.">
          <span className="lhero-line" data-split data-reveal aria-hidden="true">
            {'Real logic. '}
          </span>
          <span className="lhero-line" data-split data-reveal aria-hidden="true">
            {'Offline collection. '}
          </span>
          <span className="lhero-line lhero-line-accent" data-split data-reveal aria-hidden="true">
            {'Analysis-ready data.'}
          </span>
        </h1>
        <p className="lhero-sub" data-reveal>
          Multi-tenant survey and data-collection software for work that happens outside the office. Build a
          questionnaire with real skipping, validation and calculation, circulate it, collect it where there is
          no signal, and export data that is ready for analysis rather than merely downloaded.
        </p>
        <div className="lhero-actions" data-reveal>
          <button ref={primaryCta} type="button" className="lcta" onClick={signIn} data-cursor="Open">
            Sign in with a one-time code
          </button>
          <a className="lghost" href="#program">
            Watch the flight
          </a>
        </div>
        <p className="lhero-foot" data-reveal>
          Accounts are invitation only. Every organisation sees its own data and nothing else, and that boundary
          is enforced by PostgreSQL rather than by the application.
        </p>
        <span className="lscroll" aria-hidden="true">
          <i />
          Scroll
        </span>
      </section>

      {/*
        The journey. Each beat is one panel of text over the fixed scene, and the scene
        is driven by how far the reader has scrolled. The corridor beat carries no words
        at all: it is the breathing room between two scenes, and the only thing asked of
        a reader there is to watch the product go past.
      */}
      <div id="landing-journey" className="ljourney">
        {JOURNEY.map((beat) =>
          beat.silent ? (
            <div key={beat.id} id={beat.id} className="lbeat lbeat-silent" aria-hidden="true" />
          ) : (
            <section key={beat.id} id={beat.id} className="lbeat">
              <span className="lchapter" aria-hidden="true">
                {beat.chapter}
              </span>
              <span className="leyebrow">{beat.eyebrow}</span>
              <h2 data-split data-reveal>
                {beat.title}
              </h2>
              <p className="lbeat-body" data-reveal>
                {beat.body}
              </p>
              <p className="lwhere" data-reveal>
                <span>Where to check it</span>
                {beat.check}
              </p>
              {beat.id === 'invitation' && (
                <div className="lbeat-actions" data-reveal>
                  <button type="button" className="lcta" onClick={signIn} data-cursor="Open">
                    Sign in with a one-time code
                  </button>
                </div>
              )}
            </section>
          ),
        )}
      </div>

      <EvidenceBand summary={summary} readAt={readAt} failed={failed} />

      <section className="ltemplates" id="templates">
        <header>
          <span className="leyebrow">Templates</span>
          <h2 data-split data-reveal>
            Start from a real instrument
          </h2>
          <p data-reveal>
            These load from the API, which reads them from the database this deployment runs on. A template is a
            canonical definition rather than a spreadsheet: it is validated before it is published, and it goes
            through the same analyser as anything an author writes by hand.
          </p>
        </header>
        <ul className="ltemplate-list">
          {(summary?.templates ?? []).map((template) => (
            <li key={template.id} data-reveal>
              <h3>
                {template.title}
                <span className="lpill">{template.id}</span>
              </h3>
              <p>{template.description}</p>
              <p className="ltemplate-facts">
                {template.questionCount} questions, {template.groupCount} groups,{' '}
                {template.languages.length === 1 ? '1 language' : `${template.languages.length} languages`},{' '}
                {template.questionTypes.length} question types
              </p>
              <p className="ltypes">{template.questionTypes.join(' ')}</p>
            </li>
          ))}
          {!summary && (
            <li className="lquiet">
              {failed
                ? 'The template library could not be read from the API, so it is not being guessed at.'
                : 'Reading the template library from the API.'}
            </li>
          )}
        </ul>
      </section>

      <section className="lhonest" id="honest">
        <header>
          <span className="leyebrow">Also true</span>
          <h2 data-split data-reveal>
            What is deliberately not here
          </h2>
        </header>
        <ul>
          <li>
            <strong>No analytics or trackers.</strong> Every number on this page is read from this deployment, in
            the request that rendered it, and loads a font. There is no third-party script in the path.
          </li>
          <li>
            <strong>No invented SPSS export.</strong> A <code>.sav</code> or <code>.dta</code> file comes from a
            dedicated export worker. Where a deployment has none, the request answers <code>501</code> and names
            the setting that would change it, because a file that fails inside SPSS is worse than an honest
            refusal.
          </li>
          <li>
            <strong>No half-built uploads.</strong> An <code>image</code>, <code>audio</code>, <code>video</code>{' '}
            or <code>file</code> question is collected from the browser against a URL the API presigns and checks.
            Where a deployment has no object storage, the question says so rather than silently skipping the
            answer.
          </li>
          <li>
            <strong>No mock data anywhere.</strong> The console runs live queries, the collection app shows what is
            on the device, and this page shows numbers the API computed while it rendered.
          </li>
        </ul>
        <a className="lghost" href="/api/v1/public/summary" target="_blank" rel="noreferrer">
          Open the live summary
        </a>
      </section>

      <footer className="lfooter">
        <div>
          <span className="leyebrow">Get in</span>
          <h2 data-split data-reveal>
            Invitations are issued by an organisation owner
          </h2>
          <p>
            There is no open signup path on purpose. If you already have an account, sign in with a one-time code.
            If your organisation has not added you yet, an owner or an admin can invite you from the members list.
          </p>
        </div>
        <div className="lfooter-actions">
          <button type="button" className="lcta" onClick={signIn}>
            Sign in
          </button>
          <a className="lghost" href="#templates">
            Start from a real instrument
          </a>
        </div>
        <div className="lfooter-legal">
          <span>Inicio</span>
          <span>Private deployment on {window.location.host}</span>
        </div>
      </footer>
    </div>
  );
}
