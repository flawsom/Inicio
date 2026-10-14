/**
 * The journey's choreography, as arithmetic.
 *
 * The landing page's scene walks a reader through six beats of the product itself:
 * the questionnaire as a program, offline collection syncing to a hub, two devices
 * disagreeing over one answer, a silent fly-through, three tenants sealed apart, and
 * the invitation. Where the camera is, how far through a beat the reader has
 * scrolled, and when the disconnected device comes back are all decided here rather
 * than inside the renderer, for two reasons.
 *
 *   1. It can be tested. A scene needs a GPU; a camera path does not, and "the
 *      fly-through banks and levels out", "the offline device never drops what it
 *      collected" and "the camera holds still while there is text to read" are the
 *      claims worth holding, so they are expressed as numbers this suite can read.
 *   2. It is not three.js. Nothing here imports the renderer, so the page can import
 *      the beat list for its own copy without pulling WebGL, a canvas or a scene into
 *      anything that renders text.
 *
 * Progress is one number in 0..1 for the whole journey, and every function below is
 * a pure function of it (plus, where a beat has a life of its own, that beat's own
 * local progress).
 */

/** The six beats, in the order the camera visits them. */
export const BEAT_IDS = ['program', 'sync', 'conflict', 'flythrough', 'tenants', 'invitation'] as const;

export type BeatId = (typeof BEAT_IDS)[number];

/**
 * How much of a beat is spent standing still before the camera moves on.
 *
 * The hold is what makes the text readable: a reader scrolling a beat sees the scene
 * settle, and the travel happens after the words have scrolled away, which is the
 * breathing room between two scenes. It is also what makes the fly-through a
 * fly-through: the one beat that is *about* the travel is silent, so there is nothing
 * to read while the corridor goes past.
 */
export const HOLD = 0.45;

export const BEAT_COUNT = BEAT_IDS.length;

/** The one beat that is entirely a camera move. Named so the bank is not a magic 3. */
export const FLYTHROUGH_INDEX = BEAT_IDS.indexOf('flythrough');

export const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** A 0..1 ramp for `value` across `[from, to]`, so nothing ever pops. */
export const range = (value: number, from: number, to: number): number =>
  clamp01((value - from) / (to - from === 0 ? 1 : to - from));

/** Smoothstep: no visible corner at either end of a ramp. */
export const smooth = (t: number): number => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

export const mix = (a: number, b: number, t: number): number => a + (b - a) * t;

export interface Pose {
  x: number;
  y: number;
  z: number;
  lookX: number;
  lookY: number;
  lookZ: number;
}

/**
 * Where the camera stands for each beat, and what it is looking at.
 *
 * The beats are laid out along -Z, roughly seventy units apart, because the whole
 * point is that this is one continuous journey rather than six separate scenes: the
 * camera arrives somewhere, the thing that lives there assembles, and then it moves
 * on, with the next beat already faint in the fog.
 *
 * The index is the beat, so `STATIONS[3]` is where the fly-through starts: at the
 * mouth of the corridor, with the corridor running away from it toward the tenants.
 */
export const STATIONS: readonly Pose[] = [
  // program: the arc of question slabs, seen from just outside it
  { x: 0, y: 0.6, z: 11.6, lookX: 0, lookY: 0.1, lookZ: 0 },
  // sync: above and behind the hub, so the streams read as going somewhere
  { x: 0, y: 2.3, z: -54.5, lookX: 0, lookY: -0.2, lookZ: -70 },
  // conflict: level with the pairs, close enough to see the gap between them
  { x: 0, y: 0.3, z: -126.5, lookX: 0, lookY: 0, lookZ: -140 },
  // flythrough: at the corridor mouth, looking straight down it
  { x: 0, y: 0, z: -191, lookX: 0, lookY: 0, lookZ: -232 },
  // tenants: in front of the three sealed realms
  { x: 0, y: 1.4, z: -305, lookX: 0, lookY: 0, lookZ: -320 },
  // invitation: the seal, at the end of the flight
  { x: 0, y: 0.4, z: -377, lookX: 0, lookY: 0, lookZ: -392 },
];

/**
 * The camera's own visibility ramp.
 *
 * The hero is pure typography with no 3D object in it, so the scene draws nothing at
 * the top of the page and fades in as the hero scrolls away. Without this the first
 * beat's slabs would be standing behind the headline, which is exactly the abstract
 * thing in front of the words that this design replaced.
 */
export function presenceAt(progress: number): number {
  return smooth(range(progress, 0.012, 0.07));
}

/** Which beat the reader is in: 0..5, clamped rather than undefined at either end. */
export function beatIndexAt(progress: number): number {
  return Math.min(BEAT_COUNT - 1, Math.floor(clamp01(progress) * BEAT_COUNT));
}

/** How far through that beat: 0 at its first pixel, 1 at its last. */
export function beatLocalAt(progress: number): number {
  return clamp01(progress) * BEAT_COUNT - beatIndexAt(progress);
}

/**
 * How far through the travel out of a beat the reader is.
 *
 * Zero for the whole hold, then a smooth step to one. Everything a beat does with its
 * own geometry uses the beat's local progress; this is only the camera leaving.
 */
export function travelAt(local: number): number {
  return smooth(range(local, HOLD, 1));
}

export interface CameraPose extends Pose {
  /** Banking, in radians. Non-zero only where the camera is flying. */
  roll: number;
}

const poseAt = (index: number, t: number, roll: number): CameraPose => {
  const from = STATIONS[Math.max(0, Math.min(STATIONS.length - 1, index))];
  const to = STATIONS[Math.max(0, Math.min(STATIONS.length - 1, index + 1))];
  return {
    x: mix(from.x, to.x, t),
    y: mix(from.y, to.y, t),
    z: mix(from.z, to.z, t),
    lookX: mix(from.lookX, to.lookX, t),
    lookY: mix(from.lookY, to.lookY, t),
    lookZ: mix(from.lookZ, to.lookZ, t),
    roll,
  };
};

/**
 * The camera, for any progress at all.
 *
 * The last beat has nowhere to travel to, so it holds: the seal expands and the page's
 * own invitation takes over from there.
 */
export function cameraAt(progress: number): CameraPose {
  const index = beatIndexAt(progress);
  const local = beatLocalAt(progress);
  const travel = travelAt(local);

  if (index >= BEAT_COUNT - 1) {
    const last = STATIONS[STATIONS.length - 1];
    return { ...last, roll: 0 };
  }

  // The fly-through banks and levels out: one half turn of a sine across the travel
  // out of the corridor beat, which starts level, leans hardest halfway and is level
  // again by the time the realms arrive.
  const roll = index === FLYTHROUGH_INDEX ? Math.sin(Math.PI * travel) * 0.42 : 0;
  return poseAt(index, travel, roll);
}

/** The banking angle alone, for a test that only cares about the lean. */
export function rollAt(progress: number): number {
  return cameraAt(progress).roll;
}

/* --------------------------------------------------------------------- beats */

/**
 * The questionnaire as a program.
 *
 * Questions rise into an arc in a staggered order, and the filaments between them
 * draw afterwards, because a rule that joins two questions cannot exist before both
 * questions do. `assembled` is how much of the arc is up; `wired` is how much of the
 * logic is drawn.
 */
export function programAt(local: number): { assembled: number; wired: number } {
  return {
    assembled: smooth(range(local, 0.02, 0.62)),
    wired: smooth(range(local, 0.44, 0.96)),
  };
}

export type SyncPhase = 'streaming' | 'offline' | 'reconnected';

/**
 * One device loses signal and comes back.
 *
 * The moment this beat exists for is the middle of it: a device drops off, keeps
 * taking answers while there is nothing to send them to, and then hands over
 * everything it held in one burst. So the numbers are explicit rather than implied by
 * whatever the particle system happens to do.
 *
 *   `phase`      which of the three states the disconnected device is in
 *   `held`       how full its local buffer is (it fills while offline, then empties)
 *   `burst`      the handover, peaking just after the signal returns
 *   `link`       the strength of the path back to the hub: it dims, it does not die
 *   `delivered`  the share of everything collected that has reached the hub
 *
 * The property that matters, and the one the test holds, is that `delivered` never
 * decreases. A sync that loses an answer to a dropped connection is the failure this
 * whole product is about.
 */
export const SYNC_DROP = 0.38;
export const SYNC_RETURN = 0.72;

export function syncAt(local: number): {
  phase: SyncPhase;
  held: number;
  burst: number;
  link: number;
  delivered: number;
} {
  const phase: SyncPhase = local < SYNC_DROP ? 'streaming' : local < SYNC_RETURN ? 'offline' : 'reconnected';
  // The buffer fills while the device is off the network and empties once it is back.
  const filled = smooth(range(local, SYNC_DROP, SYNC_RETURN));
  const flushed = smooth(range(local, SYNC_RETURN, SYNC_RETURN + 0.14));
  const held = phase === 'reconnected' ? 1 - flushed : filled;
  const burst = phase === 'reconnected' ? Math.sin(Math.PI * clamp01((local - SYNC_RETURN) / 0.2)) : 0;
  const link =
    phase === 'streaming'
      ? 1
      : phase === 'offline'
        ? mix(1, 0.16, smooth(range(local, SYNC_DROP - 0.04, SYNC_DROP + 0.08)))
        : mix(0.16, 1, flushed);
  // Two thirds of the work streams while connected; the rest arrives in the burst.
  const streamed = 0.66 * smooth(range(local, 0.04, SYNC_DROP));
  const flushedShare = 0.34 * flushed;
  return { phase, held, burst, link, delivered: streamed + flushedShare };
}

/**
 * Two devices, one answer, both versions kept.
 *
 * The orbs orbit a shared centre forever and never touch: the gap between them is the
 * point, and `gap` is its width as a share of the pair's radius. `tension` is how
 * insistently they disagree (which is just the beat's own progress, used to drive the
 * glow), so the scene has something to animate that is not the merge it must not do.
 */
export function conflictAt(local: number): { orbit: number; gap: number; tension: number } {
  return {
    orbit: local * Math.PI * 2.4,
    gap: 0.34 + 0.06 * Math.sin(local * Math.PI * 2),
    tension: smooth(range(local, 0.06, 0.7)),
  };
}

/**
 * Three tenants, sealed.
 *
 * The membranes around the realms thicken as the beat plays, and `sealed` is how
 * settled the boundary is. There is no crossing to animate: the whole claim is that
 * nothing crosses.
 */
export function tenantsAt(local: number): { sealed: number; membrane: number } {
  const sealed = smooth(range(local, 0.04, 0.7));
  return { sealed, membrane: 0.25 + 0.6 * sealed + 0.05 * Math.sin(local * Math.PI * 6) };
}

/** The invitation: a ring opens around the last slab, and stays open. */
export function invitationAt(local: number): { seal: number; widen: number } {
  const seal = smooth(range(local, 0.05, 0.55));
  return { seal, widen: smooth(range(local, 0.45, 1)) };
}
