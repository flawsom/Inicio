/**
 * The ambient field.
 *
 * The landing page's sculpture is real glass in a real 3D scene, and it costs a
 * three.js chunk to draw. The signed-in app gets the same idea for a couple of
 * kilobytes: the same nodes wired by the same filaments, projected by hand and drawn
 * as a light field on a 2D canvas. A reader who signs in should recognise the world
 * they just walked through, and an author reading a table of live responses should
 * not pay a hundred kilobytes of compressed shader code to be reminded of it.
 *
 * Everything here is therefore hand-rolled: no imports, no dependencies, nothing to
 * download. The geometry is built once and only projected per frame.
 *
 * Three constraints, the same three the scene obeys:
 *
 *   - It is decoration, so it is never in the way. It registers no global listeners
 *     of its own: the caller drives resize, visibility and progress, which is why
 *     here there is no `window`, no `document` and no visibility check to get wrong.
 *   - It can always fail. A missing 2D context returns null rather than throwing,
 *     and the gradient underneath it in the stylesheet is a complete backdrop on its
 *     own.
 *   - It respects the reader. Under `prefers-reduced-motion` one frame is drawn and
 *     no loop is ever started, and `dispose` stops it dead.
 *
 * The colours are read from the stylesheet's custom properties rather than declared
 * here, so the light theme and the dark one each get a field in their own palette
 * without a second code path.
 */

export type AmbientQuality = 'high' | 'low';

export interface AmbientOptions {
  quality: AmbientQuality;
  reducedMotion: boolean;
}

export interface AmbientField {
  /** 0 to 1 through the document: the structure assembles as the page is read. */
  setProgress(progress: number): void;
  /** Pointer position in -1..1, used only for parallax. */
  setPointer(x: number, y: number): void;
  /** Stop drawing (tab hidden, or the field scrolled out of the story) without tearing down. */
  setActive(active: boolean): void;
  resize(): void;
  dispose(): void;
}

const TAU = Math.PI * 2;
/** Camera distance and lens. Fixed, because an ambient wash has no reason to dolly. */
const CAMERA_Z = 6;
const FOCAL = 4.8;
const NEAR = 2.6;
const FAR = 9.6;
/** Depth is drawn in this many steps: enough to read as depth, few enough to batch. */
const BUCKETS = 5;
/** How fast the field turns when nothing is driving it. */
const DRIFT = 0.045;

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const smooth = (t: number): number => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

/** Deterministic per-index noise, so the field is the same on every load. */
function hash(index: number): number {
  const s = Math.sin(index * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
}

function token(style: CSSStyleDeclaration, name: string, fallback: string): string {
  const value = style.getPropertyValue(name).trim();
  return value.length > 0 ? value : fallback;
}

/**
 * `#rgb`, `#rrggbb` or an `rgb()`/`rgba()` string to components.
 *
 * A theme token this cannot read falls back rather than throwing, which is the only
 * behaviour an ornament should have when the stylesheet changes shape.
 */
function toRgb(colour: string, fallback: [number, number, number]): [number, number, number] {
  const text = colour.trim();
  const hex = text.replace(/^#/, '');
  const byte = (pair: string): number => parseInt(pair, 16);

  if (/^[0-9a-f]{3}$/i.test(hex)) {
    const [r, g, b] = [hex.charAt(0), hex.charAt(1), hex.charAt(2)];
    return [byte(r + r), byte(g + g), byte(b + b)];
  }
  if (/^[0-9a-f]{6}$/i.test(hex)) {
    return [byte(hex.slice(0, 2)), byte(hex.slice(2, 4)), byte(hex.slice(4, 6))];
  }
  if (/^rgba?\(/i.test(text)) {
    const parts = text.match(/[\d.]+/g);
    if (parts && parts.length >= 3) return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
  }
  return fallback;
}

const rgba = (colour: [number, number, number], alpha: number): string =>
  `rgba(${colour[0]}, ${colour[1]}, ${colour[2]}, ${alpha})`;

export function createAmbientField(canvas: HTMLCanvasElement, options: AmbientOptions): AmbientField | null {
  const twoD = canvas.getContext('2d');
  // No 2D context: what is under this canvas in the stylesheet is the whole
  // backdrop, and the page is complete without it. This is the contract, not a
  // failure, which is why it is a null return rather than a thrown error.
  if (!twoD) return null;
  // Bound to an annotated constant so the drawing closures below hold a real
  // context rather than a value the compiler would keep re-checking.
  const context: CanvasRenderingContext2D = twoD;

  const low = options.quality === 'low';
  // Roughly 90 nodes on the cheap tier and 220 on the full one. Both are invisible
  // as a count; the difference is what a five year old phone can hold at 60.
  const strands = low ? 6 : 11;
  const perStrand = low ? 15 : 20;
  const count = strands * perStrand;

  const style = getComputedStyle(canvas);
  const accent = toRgb(token(style, '--accent', '#6f95ff'), [111, 149, 255]);
  const accent2 = toRgb(token(style, '--accent-2', '#7b4dff'), [123, 77, 255]);
  const live = toRgb(token(style, '--live', '#1cc7d0'), [28, 199, 208]);

  // Three arrangements of one set of nodes, blended by progress: a folded knot, a
  // spine, and the wide lattice the structure takes when it is working. This is the
  // landing sculpture's own idea, drawn without a scene graph.
  const folded = new Float32Array(count * 3);
  const spine = new Float32Array(count * 3);
  const lattice = new Float32Array(count * 3);
  const phase = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    const k = i % strands;
    const along = (i - k) / strands;
    const s = along / (perStrand - 1);
    const i3 = i * 3;
    phase[i] = hash(i * 7 + 3) * TAU;

    const knotAngle = s * TAU * 1.35 + k * 0.62;
    const knotRadius = 1.5 + 0.55 * Math.sin(knotAngle * 1.7);
    folded[i3] = knotRadius * Math.cos(knotAngle * 2) + (hash(i * 3) - 0.5) * 0.3;
    folded[i3 + 1] = Math.sin(knotAngle * 3 + k) * 1.05;
    folded[i3 + 2] = knotRadius * Math.sin(knotAngle * 2) + (hash(i * 5) - 0.5) * 0.3;

    const helixAngle = s * TAU + k * (TAU / strands);
    const helixRadius = 1.05 + s * 0.25;
    spine[i3] = Math.cos(helixAngle) * helixRadius;
    spine[i3 + 1] = (s - 0.5) * 4.6;
    spine[i3 + 2] = Math.sin(helixAngle) * helixRadius;

    const spokeAngle = k * (TAU / strands);
    const spokeRadius = 1.1 + s * 3.2;
    lattice[i3] = Math.cos(spokeAngle) * spokeRadius;
    lattice[i3 + 1] = (s - 0.5) * 2.4 + 0.28 * Math.sin(k * 2.1);
    lattice[i3 + 2] = Math.sin(spokeAngle) * spokeRadius;
  }

  // Projected once per frame into these, so the loop allocates nothing.
  const screenX = new Float32Array(count);
  const screenY = new Float32Array(count);
  const depth = new Float32Array(count);

  let width = 1;
  let height = 1;
  let ready = false;
  let disposed = false;
  let active = true;
  let frame = 0;
  let previous = 0;
  let elapsed = 0;
  let progress = 0;
  let targetProgress = 0;
  let pointerX = 0;
  let pointerY = 0;
  let smoothX = 0;
  let smoothY = 0;
  let glow: CanvasGradient | null = null;

  function draw(dt: number): void {
    if (disposed) return;
    elapsed += dt;
    progress = dt <= 0 ? targetProgress : lerp(progress, targetProgress, 1 - Math.exp(-5 * dt));
    smoothX = dt <= 0 ? pointerX : lerp(smoothX, pointerX, 1 - Math.exp(-3 * dt));
    smoothY = dt <= 0 ? pointerY : lerp(smoothY, pointerY, 1 - Math.exp(-3 * dt));

    const toSpine = smooth((progress - 0.1) / 0.45);
    const toLattice = smooth((progress - 0.55) / 0.42);
    const yaw = elapsed * DRIFT + smoothX * 0.4;
    const pitch = smoothY * 0.22;
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    const cosP = Math.cos(pitch);
    const sinP = Math.sin(pitch);
    const scale = Math.min(width, height) * 0.4;
    const centreX = width / 2;
    const centreY = height / 2;

    context.clearRect(0, 0, width, height);

    // One soft pool of light behind the structure, so the field has a centre of
    // gravity instead of being evenly sprinkled across the screen.
    if (!glow) {
      const radius = Math.max(width, height) * 0.72;
      glow = context.createRadialGradient(centreX, centreY * 0.86, 0, centreX, centreY * 0.86, radius);
      glow.addColorStop(0, rgba(accent, 0.14));
      glow.addColorStop(0.45, rgba(accent2, 0.06));
      glow.addColorStop(1, rgba(accent2, 0));
    }
    context.fillStyle = glow;
    context.fillRect(0, 0, width, height);

    for (let i = 0; i < count; i += 1) {
      const i3 = i * 3;
      const breathe = Math.sin(elapsed * 0.35 + phase[i]);
      const x = lerp(lerp(folded[i3], spine[i3], toSpine), lattice[i3], toLattice) * (1 + 0.04 * breathe);
      const y = lerp(lerp(folded[i3 + 1], spine[i3 + 1], toSpine), lattice[i3 + 1], toLattice) + 0.16 * breathe;
      const z = lerp(lerp(folded[i3 + 2], spine[i3 + 2], toSpine), lattice[i3 + 2], toLattice) + 0.14 * Math.cos(elapsed * 0.29 + phase[i]);

      const x1 = x * cosY + z * sinY;
      const z1 = -x * sinY + z * cosY;
      const y1 = y * cosP - z1 * sinP;
      const z2 = y * sinP + z1 * cosP;
      const distance = CAMERA_Z + z2;
      const lens = FOCAL / Math.max(0.8, distance);

      screenX[i] = centreX + x1 * lens * scale;
      screenY[i] = centreY - y1 * lens * scale;
      depth[i] = 1 - clamp01((distance - NEAR) / (FAR - NEAR));
    }

    // The filaments: the rules between the questions, one path per strand. A single
    // stroke per strand rather than one per segment is what keeps a full lattice
    // inside a frame on a laptop that is also rendering the page.
    context.lineWidth = 1;
    for (let k = 0; k < strands; k += 1) {
      const colour = k % 3 === 0 ? live : k % 2 === 0 ? accent2 : accent;
      context.strokeStyle = rgba(colour, 0.13);
      context.beginPath();
      for (let j = 0; j < perStrand; j += 1) {
        const i = k + j * strands;
        if (j === 0) context.moveTo(screenX[i], screenY[i]);
        else context.lineTo(screenX[i], screenY[i]);
      }
      context.stroke();
    }

    // The nodes, batched by depth: five fills for the whole field, and the nearest
    // ones brighter, larger and cooler than the ones drifting behind them.
    for (let bucket = 0; bucket < BUCKETS; bucket += 1) {
      const t = bucket / (BUCKETS - 1);
      const colour = bucket === BUCKETS - 1 ? live : bucket >= 3 ? accent : accent2;
      context.fillStyle = rgba(colour, 0.14 + 0.5 * t);
      context.beginPath();
      for (let i = 0; i < count; i += 1) {
        if (Math.min(BUCKETS - 1, Math.floor(depth[i] * BUCKETS)) !== bucket) continue;
        const radius = 0.6 + 1.15 * t;
        context.moveTo(screenX[i] + radius, screenY[i]);
        context.arc(screenX[i], screenY[i], radius, 0, TAU);
      }
      context.fill();
    }
  }

  function schedule(): void {
    if (disposed || !active || options.reducedMotion) return;
    frame = requestAnimationFrame(tick);
  }

  function tick(now: number): void {
    if (disposed) return;
    const dt = previous === 0 ? 1 / 60 : Math.min(0.05, (now - previous) / 1000);
    previous = now;
    draw(dt);
    schedule();
  }

  function resize(): void {
    // A resize can arrive after dispose, because the caller's own listener may still
    // be attached for the rest of the tick. Once disposed, this touches nothing.
    if (disposed) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    width = Math.max(1, canvas.clientWidth);
    height = Math.max(1, canvas.clientHeight);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    // The pool of light is measured in CSS pixels, so it has to be built again.
    glow = null;
    // A stopped field still has to look right after a resize, which is the one place
    // an unanimated canvas needs a nudge.
    if (ready && options.reducedMotion) draw(0);
  }

  resize();
  draw(0);
  ready = true;
  schedule();

  return {
    setProgress(next: number) {
      targetProgress = clamp01(next);
      if (options.reducedMotion) {
        progress = targetProgress;
        draw(0);
      }
    },
    setPointer(x: number, y: number) {
      pointerX = Math.max(-1, Math.min(1, x));
      pointerY = Math.max(-1, Math.min(1, y));
    },
    setActive(next: boolean) {
      if (active === next) return;
      active = next;
      if (!active) {
        if (frame !== 0) cancelAnimationFrame(frame);
        frame = 0;
        return;
      }
      // Reset the clock, so returning to the tab does not arrive with one enormous
      // delta time and a visible jump.
      previous = 0;
      schedule();
    },
    resize,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (frame !== 0) cancelAnimationFrame(frame);
      frame = 0;
    },
  };
}
