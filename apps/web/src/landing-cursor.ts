/**
 * The pointer trail.
 *
 * Twenty springs of beads, each bead dragging the one behind it, drawn as a curve
 * through their midpoints. The colour walks a slow sine around the brand orange, so
 * the trail drifts between a deep tangerine and a warm amber without ever being
 * repainted by hand.
 *
 * It is a module of its own, imported on demand by `landing.tsx`, because it is
 * decoration: a reader who never moves a pointer over this page should not
 * download it, and the landing chunk has a budget measured in kilobytes.
 *
 * What this deliberately does *not* do, each of which is a defect in the snippet
 * it descends from:
 *
 *   - no module-level state. `ctx`, `pos`, `lines` and the phase all live inside
 *     `mountCursorTrail`, so two mounts cannot share a trail and a StrictMode
 *     double mount cannot leave a second one drawing into a canvas nobody owns;
 *   - no listener removed by a freshly built handler. `removeEventListener` only
 *     matches the exact function that was added, so every handler here is a named
 *     closure that teardown reuses;
 *   - no loop while the pointer is still. The frame is re-armed only while beads
 *     are actually moving, and the trail comes to rest instead of holding a core
 *     awake on an idle page;
 *   - no `window.innerWidth - 20`. The backing store is sized from the canvas's
 *     own box at the device pixel ratio, so it is correct on a phone, on a retina
 *     laptop and after a rotation.
 */

/** How many springs. More is a wider fan; the cost is linear in trails × beads. */
const TRAILS = 20;
/** Beads per spring. The head follows the pointer, the tail follows the head. */
const BEADS = 50;
/** How much of a pull the beads behind the head inherit from the one in front. */
const DAMPENING = 0.25;
/** How much of the spring's pull survives each bead down the chain. */
const TENSION = 0.98;
const BASE_FRICTION = 0.5;
/** Below this summed speed, every bead is treated as at rest. */
const RESTING_SPEED = 0.05;
/** A device pixel ratio above this is not worth the fill rate for a hairline. */
const MAX_PIXEL_RATIO = 2;

export interface CursorTrailHandle {
  /** Stop drawing and remove everything this added. Safe to call twice. */
  dispose(): void;
}

interface Bead {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface Trail {
  spring: number;
  friction: number;
  beads: Bead[];
}

/**
 * Whether this device should get a trail at all.
 *
 * `any-pointer: fine` rather than `hover: hover`: a stylus on a tablet reports a
 * fine pointer while `hover` is telling us about fingers, and a trail under a
 * stylus is exactly the case worth keeping. Reduced motion wins over everything —
 * the trail is the most kinetic thing on the page.
 */
export function shouldDrawCursorTrail(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  return window.matchMedia('(any-pointer: fine)').matches;
}

/**
 * Start trailing the pointer across `canvas`.
 *
 * Returns a handle whatever happens: a device that should not draw — reduced
 * motion, no fine pointer, or a canvas with no 2D context, which is what a browser
 * without canvas support and jsdom both look like — gets a handle that does
 * nothing, so the caller never has to branch.
 */
export function mountCursorTrail(canvas: HTMLCanvasElement): CursorTrailHandle {
  const context = shouldDrawCursorTrail() ? canvas.getContext('2d') : null;
  if (!context) return { dispose: () => undefined };

  const pointer = { x: 0, y: 0, seen: false, interactive: false, moved: false };
  /** The canvas's own box in CSS pixels, refreshed on resize and used every frame. */
  const view = { left: 0, top: 0, width: 0, height: 0 };
  let trails: Trail[] = [];
  let phase = Math.random() * Math.PI * 2;
  let frame = 0;
  let running = false;
  let disposed = false;

  /**
   * Size the backing store to the canvas's own box.
   *
   * `rect` is in CSS pixels and the transform maps them onto the backing store, so
   * the beads can be simulated in the units the pointer arrives in and a resize
   * never has to move them.
   */
  const resize = (): void => {
    const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    const rect = canvas.getBoundingClientRect();
    // Cached, not re-read per frame: a layout read in the draw loop is a synchronous
    // style flush sixty times a second for a number that only changes on a resize.
    view.left = rect.left;
    view.top = rect.top;
    view.width = rect.width;
    view.height = rect.height;
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (canvas.width === width && canvas.height === height) return;
    canvas.width = width;
    canvas.height = height;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, view.width, view.height);
  };

  /** New springs, all piled on the pointer. Only ever called once we know where it is. */
  const seed = (): void => {
    trails = [];
    for (let index = 0; index < TRAILS; index += 1) {
      const beads: Bead[] = [];
      for (let bead = 0; bead < BEADS; bead += 1) {
        beads.push({ x: pointer.x, y: pointer.y, vx: 0, vy: 0 });
      }
      trails.push({
        // The jitter is the point: identical springs draw one line, and twenty
        // slightly different ones draw a ribbon.
        spring: 0.4 + (index / TRAILS) * 0.025 + 0.1 * Math.random() - 0.02,
        friction: BASE_FRICTION + 0.01 * Math.random() - 0.002,
        beads,
      });
    }
  };

  /** One physics step. Returns true while any bead is still moving. */
  const step = (): boolean => {
    let moving = false;
    for (const trail of trails) {
      let pull = trail.spring;
      for (let index = 0; index < trail.beads.length; index += 1) {
        const bead = trail.beads[index]!;
        if (index === 0) {
          bead.vx += (pointer.x - bead.x) * pull;
          bead.vy += (pointer.y - bead.y) * pull;
        } else {
          const ahead = trail.beads[index - 1]!;
          bead.vx += (ahead.x - bead.x) * pull;
          bead.vy += (ahead.y - bead.y) * pull;
          bead.vx += ahead.vx * DAMPENING;
          bead.vy += ahead.vy * DAMPENING;
        }
        bead.vx *= trail.friction;
        bead.vy *= trail.friction;
        bead.x += bead.vx;
        bead.y += bead.vy;
        pull *= TENSION;
        if (Math.abs(bead.vx) + Math.abs(bead.vy) > RESTING_SPEED) moving = true;
      }
    }
    return moving;
  };

  const draw = (): void => {
    /**
     * Normal compositing, deliberately.
     *
     * This was additive (`lighter`) while the page was one dark material. It is two
     * now — the dark stage and the white sheets below it — and an additive stroke
     * over white is a white stroke, so the trail would simply have stopped existing
     * across most of the page. A warm stroke at normal alpha is legible on both.
     */
    context.globalCompositeOperation = 'source-over';
    context.clearRect(0, 0, view.width, view.height);
    phase += 0.0015;
    const intensity = pointer.interactive ? 0.5 : 0.34;
    context.strokeStyle = `hsla(${Math.round(28 + Math.sin(phase) * 14)}, 86%, ${pointer.interactive ? 52 : 57}%, ${intensity})`;
    // Over something interactive the ribbon thickens: the label the ring used to
    // render is gone with the ring, so the hover has to be legible as a change of
    // weight and colour rather than as a label.
    context.lineWidth = pointer.interactive ? 1.8 : 1;
    for (const trail of trails) {
      const beads = trail.beads;
      const head = beads[0]!;
      context.beginPath();
      context.moveTo(head.x, head.y);
      for (let index = 1; index < beads.length - 2; index += 1) {
        const bead = beads[index]!;
        const next = beads[index + 1]!;
        // Midpoints, so the curve is smooth across beads rather than kinked at each.
        context.quadraticCurveTo(bead.x, bead.y, (bead.x + next.x) / 2, (bead.y + next.y) / 2);
      }
      const secondLast = beads[beads.length - 2]!;
      const last = beads[beads.length - 1]!;
      context.quadraticCurveTo(secondLast.x, secondLast.y, last.x, last.y);
      context.stroke();
      context.closePath();
    }
  };

  const tick = (): void => {
    if (disposed) return;
    frame = 0;
    const pointerMoved = pointer.moved;
    pointer.moved = false;
    const moving = step();
    draw();
    // Rest, rather than spin: a still pointer is the normal state of a page being
    // read, and an animation frame per refresh for nothing is a battery cost.
    if (!moving && !pointerMoved) {
      running = false;
      return;
    }
    frame = requestAnimationFrame(tick);
  };

  const start = (): void => {
    if (running || disposed || document.visibilityState !== 'visible') return;
    running = true;
    frame = requestAnimationFrame(tick);
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
    pointer.x = event.clientX - view.left;
    pointer.y = event.clientY - view.top;
    pointer.moved = true;
    if (!pointer.seen) {
      // Springs can only be piled on a pointer we have actually seen. Seeding them
      // at the origin is how the original drew a burst in the top-left corner.
      pointer.seen = true;
      seed();
    }
    const target = event.target instanceof Element ? event.target.closest('a, button, [data-cursor]') : null;
    pointer.interactive = Boolean(target);
    start();
  };

  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') start();
  };

  const onResize = (): void => resize();

  // jsdom has no ResizeObserver, and a browser without one still gets a correct
  // first size plus the window resize listener below.
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(onResize) : null;

  resize();
  observer?.observe(canvas);
  window.addEventListener('pointermove', onPointerMove, { passive: true });
  window.addEventListener('resize', onResize, { passive: true });
  document.addEventListener('visibilitychange', onVisibilityChange);

  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      running = false;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      observer?.disconnect();
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    },
  };
}
