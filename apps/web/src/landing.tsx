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

/**
 * Split an element's text into per-character spans once, so they can be animated.
 *
 * The characters have to be their own boxes for the reveal to stagger, and a box
 * is exactly what ruins the sentence: the browser will end a line after any
 * atomic inline, and a box holding a bare space collapses to no width at all —
 * which is how a headline rendered as "Startfromarealinstrument" with the words
 * broken mid-letter (`instrumen` / `t`). So the split is word-first: a word is one
 * `.lword` (inline-block, `nowrap`) holding a `.lchar` per character, and the
 * spaces between words are `.lchar.lspace` pieces that keep their width and stay
 * breakable. The rendered sentence is then the sentence: spaced words that wrap
 * only between themselves.
 */
function splitChars(element: HTMLElement): void {
  // Splitting is not idempotent, and the effect that calls it runs twice in
  // development (StrictMode mounts, unmounts and mounts again). A second pass
  // over already-split markup wraps every existing character box in a word and
  // a box of its own — nested, doubled characters that measure as nonsense
  // (a 16-character sentence reporting 17 "words") and animate out of step. A
  // marker on the element makes the second pass a no-op.
  if (element.dataset.splitDone === 'true') return;
  element.dataset.splitDone = 'true';

  const walk = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.textContent ?? '';
        // A whitespace-only node is the layout of the JSX around an element,
        // not text a reader sees.
        if (!text.trim()) continue;
        const fragment = document.createDocumentFragment();
        // One piece per character in the source, so the stagger index and the
        // text itself keep step with the original string.
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

    /**
     * Split and observe everything in `scope`, and `scope` itself.
     *
     * Both selectors: a split headline animates per character, a plain reveal
     * animates as one block, and an element that is both needs one observation.
     * Splitting is gated on `data-split` — a plain reveal block must keep its text
     * whole — and both `splitChars` and `observe` are idempotent, so adopting the
     * same subtree twice changes nothing.
     */
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

    // The template cards are rendered from the API response, which arrives after
    // this effect has run — and an observer built here sees only what exists now.
    // They therefore kept the hidden state the reveal class applies: measured on
    // the deployment, three `opacity: 0` cards that no amount of scrolling
    // revealed, because nothing had ever observed them. Watching the subtree is
    // what makes "reveal on first sight" true for fetched content rather than
    // only for the markup that happened to mount with the page.
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

/**
 * The pointer trail, and never the only way to see something.
 *
 * A fixed, full-viewport canvas the trail is drawn into. It is decoration: it takes
 * no pointer events, so every control underneath still receives its click, and it is
 * hidden outright where there is no pointer to follow or motion is unwelcome. The
 * effect itself lives in `landing-cursor.ts` and is imported on demand, for the same
 * reason the scene is: nobody should download a decoration they will not see.
 *
 * The type below is structural rather than imported, which is the pattern this file
 * already uses for the scene's handle — a type-only import would be erased anyway,
 * and this keeps the dependency one-way.
 */
function CursorTrail(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let handle: { dispose(): void } | null = null;
    let disposed = false;

    void import('./landing-cursor')
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

  return <canvas ref={canvasRef} className="lcursor" aria-hidden="true" />;
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

/**
 * What is finished, and how a reader can see it for themselves.
 *
 * The `check` line was a path into the source once. It is an instruction now, and
 * that is the better half of the same promise: "this is deployed, and here is the
 * two-tap way to watch it work" needs no repository to be true, and a reader who
 * cannot see the code can still see the product.
 */
const CAPABILITIES: Array<{ title: string; body: string; check: string }> = [
  {
    title: 'One expression engine, two runtimes',
    body:
      'Relevance, constraints, calculations and choice filters are parsed, validated and evaluated by a single implementation. A question the server hides is hidden on the device, and a calculation is never trusted from the client.',
    check: 'Write a relevance rule in the studio and the preview hides the question as you type.',
  },
  {
    title: 'Collection that works with no signal',
    body:
      'The device owns its response: a client-generated UUID is the response id, every keystroke lands in IndexedDB before anything is sent, and a durable outbox syncs when the network returns. A retried submission never becomes a second response.',
    check: 'Open a collection link, put the device in flight mode, answer, then reconnect.',
  },
  {
    title: 'Conflicts kept, not resolved away',
    body:
      'Every sync sends the last server state the device saw, so the merge is decided per question. When two devices disagree, the server value is stored, the device value is retained beside it, and the disagreement is recorded as a row.',
    check: 'Answer the same question from two devices and the response lists the disagreement.',
  },
  {
    title: 'Tenancy the database enforces',
    body:
      'Fourteen tenant tables carry ENABLE and FORCE row level security, and the organisation is a parameter of the transaction. The API refuses to start in production on a connection that can bypass it.',
    check: 'Sign in as two organisations and neither can reach the other, not even by id.',
  },
  {
    title: 'Exports built from the version that collected the data',
    body:
      'CSV bundle with a codebook, value labels and the missing-code table, plus XLSX and JSON. They are generated from the published definition the responses actually answered, not from the current draft.',
    check: 'Open any submitted response and download it in each format you have configured.',
  },
  {
    title: 'Pushed, not polled',
    body:
      'Open a form and the server tells the browser which aggregate changed, coalesced per tick, over one server-sent event stream per form. The screens refetch only what moved, and a quiet form costs nothing.',
    check: 'Leave the console open on a form and submit from another tab.',
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
      <CursorTrail />

      <header className="lnav">
        <span className="lbrand">
          <i aria-hidden="true" />
          Inicio
        </span>
        <nav>
          <a href="#live">Live</a>
          <a href="#capabilities">Capabilities</a>
          <a href="#templates">Templates</a>
          <a href="#honest">Also true</a>
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
            Six things that are finished, and not on a roadmap
          </h2>
          <p data-reveal>
            Nothing on this page is a plan. Every one of these is in the deployment you are using, and each card ends
            with the two taps that let you watch it work for yourself.
          </p>
        </header>
        <div className="lcards">
          {CAPABILITIES.map((capability) => (
            <article key={capability.title} data-reveal>
              <h3>{capability.title}</h3>
              <p>{capability.body}</p>
              <p className="lwhere">
                <span>Where to check it</span>
                {capability.check}
              </p>
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
            canonical definition, not a spreadsheet: it is validated before it is published, and it goes through the
            same analyser as anything an author writes by hand.
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

      <section className="lhonest" id="honest">
        <header>
          <span className="leyebrow">Also true</span>
          <h2 data-split data-reveal>
            What is deliberately not here
          </h2>
        </header>
        <ul>
          <li>
            <strong>No analytics or trackers.</strong> Every number on this page is read from this deployment, in the
            request that rendered it, and loads a font. There is no third-party script in the path.
          </li>
          <li>
            <strong>No invented SPSS export.</strong> A <code>.sav</code> or <code>.dta</code> file comes from a
            dedicated export worker. Where a deployment has none, the request answers <code>501</code> and names the
            setting that would change it, because a file that fails inside SPSS is worse than an honest refusal.
          </li>
          <li>
            <strong>No half-built uploads.</strong> An <code>image</code>, <code>audio</code>, <code>video</code> or{' '}
            <code>file</code> question is collected from the browser against a URL the API presigns and checks. Where a
            deployment has no object storage, the question says so rather than silently skipping the answer.
          </li>
          <li>
            <strong>No mock data anywhere.</strong> The console runs live queries, the collection app shows what is on
            the device, and this page shows numbers the API computed while it rendered.
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
            There is no open signup path on purpose. If you already have an account, sign in with a one-time code. If
            your organisation has not added you yet, an owner or an admin can invite you from the members list.
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
