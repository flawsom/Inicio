import * as THREE from 'three';
import {
  BEAT_COUNT,
  beatIndexAt,
  cameraAt,
  conflictAt,
  invitationAt,
  presenceAt,
  programAt,
  syncAt,
  tenantsAt,
} from './choreography.js';

/**
 * The flight: six beats of the product, in one continuous camera move.
 *
 * This is the production version of the immersive concept, and the rule it inherits
 * is that every object in it depicts something the product actually does. There is no
 * abstract sculpture here. The beats, in order:
 *
 *   1. the questionnaire as a program: twenty four slabs rising into a staggered arc,
 *      joined by the three kinds of logic filament (relevance, constraints,
 *      calculations)
 *   2. offline collection: three device clusters streaming to a hub, with one device
 *      losing signal, keeping what it collects while it glows, and handing it over in
 *      a burst when it returns
 *   3. conflict retention: server and device orbs orbiting one centre, permanently
 *      apart, each reaching toward the other and stopping
 *   4. a fly-through: a corridor of form slabs, no text at all, camera banking
 *   5. tenant isolation: three sealed realms, each ringed by a boundary membrane, with
 *      nothing crossing between them
 *   6. the invitation: the seal opening at the end of the flight
 *
 * The choreography (where the camera is, how far through each beat a reader has
 * scrolled, when the disconnected device comes back) lives in `choreography.ts` as
 * arithmetic, so it can be tested without a GPU and so this file is only about
 * drawing. What is left here obeys four constraints:
 *
 *   Cost. Two quality tiers, a capped pixel ratio, no post-processing (there is no
 *   bloom pass to pay for, because the materials are flat and matte and the accents
 *   are emissive), a single scene with plain meshes rather than one scene per beat,
 *   and the whole thing is imported dynamically so a signed in reader never downloads
 *   it at all. The loop stops when the tab is hidden or the canvas is off screen.
 *
 *   It has to survive not existing. WebGL context creation is the one thing that
 *   genuinely fails on real devices, so `createInstrument` returns null rather than
 *   throwing and the page renders without it.
 *
 *   It has to respect the reader. Under `prefers-reduced-motion` a frame is drawn per
 *   scroll position and no loop is ever started, which is a complete path rather than
 *   a degraded one: the beats and the camera poses are the same, only the idle motion
 *   is absent. The canvas is decoration, so it is `aria-hidden` and every claim on the
 *   page is real text beside it.
 *
 *   It stays out of the critical path, asserted by `scripts/check-budgets.mjs`: this
 *   chunk is only ever reached by a dynamic import from the landing page.
 */

export type Quality = 'high' | 'low';

export interface InstrumentOptions {
  quality: Quality;
  /** True when the reader asked for reduced motion: draw one frame per change and stop. */
  reducedMotion: boolean;
}

export interface Instrument {
  /** 0 to 1 across the journey: which beat is on screen and how far through it. */
  setProgress(progress: number): void;
  /** Pointer position in -1..1, used only for a few units of parallax. */
  setPointer(x: number, y: number): void;
  /** Stop drawing (off screen or tab hidden) without tearing anything down. */
  setActive(active: boolean): void;
  resize(): void;
  dispose(): void;
}

const TAU = Math.PI * 2;

/**
 * The palette, and nothing outside it.
 *
 * The stage is the page's dark surface, so the light on it is the brand's own: the
 * primary orange, the peach accent, and a small set of greys between the surface and
 * paper for the forms themselves. A scene lit in a colour the interface does not use
 * is the fastest way to make one product look assembled out of two, so there is no
 * blue in this file and every value below is either a token or a grey of the surface.
 */
const PRIMARY = 0xea580c;
const ACCENT = 0xfdba74;
const SURFACE = 0x191c21;
const SLAB = 0x2b313b;
const SLAB_LIT = 0x39414d;
const DEVICE = 0x454e5d;
const ORB_SERVER = 0xf3d9c2;
const ORB_DEVICE = 0xfdba74;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const rangeOf = (value: number, from: number, to: number): number =>
  clamp01((value - from) / (to - from === 0 ? 1 : to - from));
const smooth = (t: number): number => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

/** Stable per-index noise, so instance variation does not shimmer between frames. */
function hash(index: number): number {
  const s = Math.sin(index * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
}

interface Beat {
  group: THREE.Group;
  /** Draw this beat at this point in its own timeline. */
  update(local: number, elapsed: number): void;
}

interface Built {
  beat: Beat;
  dispose(): void;
}

/** Everything a beat made, so `dispose` is one call per beat rather than a list. */
class Bin {
  private readonly items: Array<{ dispose(): void }> = [];

  keep<T extends { dispose(): void }>(item: T): T {
    this.items.push(item);
    return item;
  }

  line(geometry: THREE.BufferGeometry, material: THREE.Material): THREE.LineSegments {
    this.keep(geometry);
    this.keep(material);
    return new THREE.LineSegments(geometry, material);
  }

  points(geometry: THREE.BufferGeometry, material: THREE.PointsMaterial): THREE.Points {
    this.keep(geometry);
    this.keep(material);
    return new THREE.Points(geometry, material);
  }

  dispose(): void {
    for (const item of this.items) item.dispose();
    this.items.length = 0;
  }
}

/* --------------------------------------------------------------- beat 1: logic */

const PROGRAM_SLABS = 24;
const PROGRAM_STRANDS = 3;

/**
 * The questionnaire as a program.
 *
 * Twenty four slabs rise into an arc in a staggered order, and only then are they
 * wired: a rule joining two questions cannot exist before both questions do. The
 * filaments come in the three kinds the engine actually has, colour-coded, so the arc
 * reads as a form with logic rather than as a row of dominoes.
 */
function buildProgram(quality: Quality): Built {
  const group = new THREE.Group();
  const bin = new Bin();
  const slabs = quality === 'low' ? 16 : PROGRAM_SLABS;

  const geometry = bin.keep(new THREE.BoxGeometry(1.16, 0.34, 0.07));
  const material = bin.keep(
    new THREE.MeshLambertMaterial({ color: SLAB, emissive: PRIMARY, emissiveIntensity: 0 }),
  );
  const litMaterial = bin.keep(
    new THREE.MeshLambertMaterial({ color: SLAB_LIT, emissive: ACCENT, emissiveIntensity: 0.05 }),
  );

  const meshes: THREE.Mesh[] = [];
  for (let i = 0; i < slabs; i += 1) {
    const mesh = new THREE.Mesh(geometry, i % 4 === 0 ? litMaterial : material);
    group.add(mesh);
    meshes.push(mesh);
  }

  /** The three kinds of rule, each a strand through every third slab. */
  const strandColours = [PRIMARY, ACCENT, 0xe8e3dc];
  const strands: Array<{ line: THREE.LineSegments; positions: THREE.BufferAttribute; material: THREE.LineBasicMaterial }> = [];
  for (let s = 0; s < PROGRAM_STRANDS; s += 1) {
    const segments = Math.max(1, Math.floor(slabs / PROGRAM_STRANDS) - 1);
    const positions = new THREE.BufferAttribute(new Float32Array(segments * 2 * 3), 3);
    positions.setUsage(THREE.DynamicDrawUsage);
    const buffer = new THREE.BufferGeometry();
    buffer.setAttribute('position', positions);
    const material2 = new THREE.LineBasicMaterial({
      color: strandColours[s] ?? ACCENT,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const line = bin.line(buffer, material2) as THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
    line.frustumCulled = false;
    group.add(line);
    strands.push({ line, positions, material: material2 });
  }

  const place = (index: number, assembled: number, out: THREE.Vector3, outScale: { value: number }): void => {
    const t = index / (slabs - 1);
    const angle = (t - 0.5) * 2.15;
    const radius = 4.7;
    const reveal = smooth(rangeOf(assembled, hash(index + 1) * 0.42, hash(index + 1) * 0.42 + 0.5));
    out.set(
      Math.sin(angle) * radius,
      -2.55 + t * 5.0 + (1 - reveal) * -0.85,
      (Math.cos(angle) - 1) * radius * 0.42 + (hash(index * 7 + 3) - 0.5) * 0.5,
    );
    outScale.value = reveal;
  };

  const position = new THREE.Vector3();
  const scale = { value: 0 };

  return {
    beat: {
      group,
      update(local) {
        const { assembled, wired } = programAt(local);
        for (let i = 0; i < meshes.length; i += 1) {
          const mesh = meshes[i]!;
          place(i, assembled, position, scale);
          mesh.position.copy(position);
          mesh.rotation.set(0, -Math.atan2(position.x, 4.4) * 0.7, (hash(i * 5 + 2) - 0.5) * 0.06);
          mesh.scale.setScalar(Math.max(0.001, scale.value));
          mesh.visible = scale.value > 0.01;
        }
        material.emissiveIntensity = 0.12 * assembled;
        litMaterial.emissiveIntensity = 0.05 + 0.3 * assembled;

        // The filaments follow the slabs they join, so a rule is always drawn between
        // two questions that are actually on screen.
        for (let s = 0; s < PROGRAM_STRANDS; s += 1) {
          const strand = strands[s]!;
          const stride = PROGRAM_STRANDS;
          const segments = Math.max(1, Math.floor(slabs / stride) - 1);
          let cursor = 0;
          for (let seg = 0; seg < segments; seg += 1) {
            const from = seg * stride + s;
            const to = (seg + 1) * stride + s;
            if (from >= meshes.length || to >= meshes.length) break;
            const a = meshes[from]!;
            const b = meshes[to]!;
            const lift = (s - 1) * 0.16;
            strand.positions.setXYZ(cursor, a.position.x, a.position.y + lift, a.position.z + 0.06);
            strand.positions.setXYZ(cursor + 1, b.position.x, b.position.y + lift, b.position.z + 0.06);
            cursor += 2;
          }
          strand.positions.needsUpdate = true;
          const drawn = Math.round(wired * Math.max(0, cursor / 2));
          strand.line.geometry.setDrawRange(0, drawn * 2);
          strand.material.opacity = 0.1 + 0.7 * wired;
        }
      },
    },
    dispose: () => bin.dispose(),
  };
}

/* ---------------------------------------------------------------- beat 2: sync */

const SYNC_CLUSTERS = 3;
const SYNC_HUB_Z = -70;

/**
 * Offline collection.
 *
 * Three device clusters stream particles to a hub. The middle one drops off: its link
 * dims, its particles stop arriving and start looping inside the cluster instead (the
 * answer landing on the device), and the devices glow while it holds them. When the
 * link returns, everything it held is handed over in one burst, and the hub's ring
 * flares. One cluster stream can be interrupted; the count that reaches the hub never
 * goes down, which is the whole product in one sentence.
 */
function buildSync(quality: Quality): Built {
  const group = new THREE.Group();
  group.position.set(0, 0, SYNC_HUB_Z);
  const bin = new Bin();
  const low = quality === 'low';
  const OFFLINE = 1;

  // The hub: a faceted core with a ring, the thing everything is trying to reach.
  const core = new THREE.Mesh(
    bin.keep(new THREE.OctahedronGeometry(1.45, 0)),
    bin.keep(new THREE.MeshLambertMaterial({ color: 0xf2e4d6, emissive: ACCENT, emissiveIntensity: 0.25 })),
  );
  group.add(core);
  const hubRing = new THREE.Mesh(
    bin.keep(new THREE.TorusGeometry(2.25, 0.045, 6, low ? 48 : 72)),
    bin.keep(new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.5 })),
  );
  hubRing.rotation.x = Math.PI / 2.4;
  group.add(hubRing);

  // Three clusters of devices, one of which is about to lose signal.
  const clusterAngles = [-1.24, 0.42, Math.PI];
  const deviceGeometry = bin.keep(new THREE.BoxGeometry(0.5, 0.82, 0.09));
  const deviceMaterials: THREE.MeshLambertMaterial[] = [];
  const clusters: THREE.Group[] = [];
  const clusterPositions: THREE.Vector3[] = [];
  for (let c = 0; c < SYNC_CLUSTERS; c += 1) {
    const cluster = new THREE.Group();
    const angle = clusterAngles[c] ?? 0;
    const radius = 7.4;
    cluster.position.set(Math.cos(angle) * radius, Math.sin(angle * 1.7) * 0.9, Math.sin(angle) * radius * 0.7);
    clusterPositions.push(cluster.position.clone());
    const material = bin.keep(
      new THREE.MeshLambertMaterial({ color: DEVICE, emissive: ACCENT, emissiveIntensity: 0.08 }),
    );
    deviceMaterials.push(material);
    const devices = low ? 3 : 4;
    for (let d = 0; d < devices; d += 1) {
      const mesh = new THREE.Mesh(deviceGeometry, material);
      const spread = (d - (devices - 1) / 2) * 0.62;
      mesh.position.set(spread, Math.abs(spread) * -0.12, (hash(d * 5 + c) - 0.5) * 0.35);
      mesh.rotation.y = -angle * 0.4 + spread * 0.12;
      cluster.add(mesh);
    }
    const plinth = new THREE.Mesh(
      bin.keep(new THREE.TorusGeometry(1.05, 0.02, 5, low ? 24 : 40)),
      bin.keep(new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.22 })),
    );
    plinth.rotation.x = Math.PI / 2;
    plinth.position.y = -0.75;
    cluster.add(plinth);
    group.add(cluster);
    clusters.push(cluster);
  }

  // The links. One per cluster so the offline one can dim on its own.
  const linkMaterials: THREE.LineBasicMaterial[] = [];
  for (let c = 0; c < SYNC_CLUSTERS; c += 1) {
    const positions = new THREE.BufferAttribute(
      new Float32Array([clusterPositions[c]!.x, clusterPositions[c]!.y, clusterPositions[c]!.z, 0, 0, 0]),
      3,
    );
    const buffer = new THREE.BufferGeometry();
    buffer.setAttribute('position', positions);
    const material = new THREE.LineBasicMaterial({
      color: c === OFFLINE ? PRIMARY : ACCENT,
      transparent: true,
      opacity: 0.45,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    bin.line(buffer, material);
    linkMaterials.push(material);
    group.add(new THREE.LineSegments(buffer, material));
  }

  // The streams: one particle cloud for every cluster, so a cluster can hold its
  // answers on the device without disturbing the other two.
  const perStream = low ? 34 : 70;
  const total = perStream * SYNC_CLUSTERS;
  const streamPositions = new Float32Array(total * 3);
  const streamSeeds = new Float32Array(total * 2);
  for (let i = 0; i < total; i += 1) {
    streamSeeds[i * 2] = hash(i * 3 + 1);
    streamSeeds[i * 2 + 1] = hash(i * 7 + 5);
  }
  const streamGeometry = new THREE.BufferGeometry();
  const streamAttribute = new THREE.BufferAttribute(streamPositions, 3);
  streamAttribute.setUsage(THREE.DynamicDrawUsage);
  streamGeometry.setAttribute('position', streamAttribute);
  const streamMaterial = new THREE.PointsMaterial({
    color: ACCENT,
    size: low ? 0.11 : 0.085,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const stream = bin.points(streamGeometry, streamMaterial);
  stream.frustumCulled = false;
  group.add(stream);

  // The handover: a burst cloud around the reconnecting cluster.
  const burstCount = low ? 40 : 90;
  const burstPositions = new Float32Array(burstCount * 3);
  const burstSeeds = new Float32Array(burstCount * 3);
  for (let i = 0; i < burstCount; i += 1) {
    burstSeeds[i * 3] = hash(i * 11 + 1) - 0.5;
    burstSeeds[i * 3 + 1] = hash(i * 13 + 2) - 0.5;
    burstSeeds[i * 3 + 2] = hash(i * 17 + 3) - 0.5;
  }
  const burstGeometry = new THREE.BufferGeometry();
  const burstAttribute = new THREE.BufferAttribute(burstPositions, 3);
  burstAttribute.setUsage(THREE.DynamicDrawUsage);
  burstGeometry.setAttribute('position', burstAttribute);
  const burstMaterial = new THREE.PointsMaterial({
    color: 0xfff1e2,
    size: low ? 0.24 : 0.18,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const burstPoints = bin.points(burstGeometry, burstMaterial);
  burstPoints.frustumCulled = false;
  group.add(burstPoints);

  return {
    beat: {
      group,
      update(local, elapsed) {
        const sync = syncAt(local);

        core.rotation.y = elapsed * 0.3;
        core.rotation.x = elapsed * 0.12;
        core.material.emissiveIntensity = 0.18 + 0.5 * sync.burst + 0.12 * sync.link;
        hubRing.rotation.z = elapsed * 0.24;
        hubRing.scale.setScalar(1 + 0.08 * sync.burst);
        hubRing.material.opacity = 0.32 + 0.5 * sync.link;

        for (let c = 0; c < SYNC_CLUSTERS; c += 1) {
          const cluster = clusters[c]!;
          const offline = c === OFFLINE;
          cluster.rotation.y = elapsed * (offline && sync.phase === 'offline' ? 0.5 : 0.12);
          // While the device is on its own it glows: this is the answer sitting on the
          // device, not lost and not sent.
          deviceMaterials[c]!.emissiveIntensity = offline ? 0.08 + 1.05 * sync.held : 0.08 + 0.1 * sync.link;
          linkMaterials[c]!.opacity = offline ? 0.12 + 0.6 * sync.link : 0.4;
        }

        for (let i = 0; i < total; i += 1) {
          const c = Math.floor(i / perStream);
          const seed = streamSeeds[i * 2] ?? 0;
          const jitter = streamSeeds[i * 2 + 1] ?? 0;
          const from = clusterPositions[c]!;
          const offline = c === OFFLINE;
          // A particle's own clock, offset by its seed so the stream is a stream rather
          // than a pulse, and stopped when its device cannot send.
          const speed = offline && sync.phase === 'offline' ? 0.22 : 0.34;
          const t = (elapsed * speed + seed) % 1;
          const reach = offline ? sync.link : 1;
          const eased = offline && sync.phase === 'offline' ? 0.12 + 0.5 * (t % 0.5) : t;
          const x = from.x * (1 - eased * reach);
          const y = from.y * (1 - eased * reach) + Math.sin(t * TAU + jitter * 6) * 0.22;
          const z = from.z * (1 - eased * reach) + Math.cos(t * TAU + jitter * 5) * 0.22;
          streamPositions[i * 3] = x;
          streamPositions[i * 3 + 1] = y;
          streamPositions[i * 3 + 2] = z;
        }
        streamAttribute.needsUpdate = true;
        streamMaterial.opacity = 0.35 + 0.5 * sync.link;

        const burstFrom = clusterPositions[OFFLINE]!;
        for (let i = 0; i < burstCount; i += 1) {
          const spread = 1 + 2.6 * (1 - sync.burst) + (burstSeeds[i * 3] ?? 0) * 0.6;
          const swirl = elapsed * 1.6 + i * 0.4;
          burstPositions[i * 3] = burstFrom.x + (burstSeeds[i * 3] ?? 0) * spread;
          burstPositions[i * 3 + 1] = burstFrom.y + (burstSeeds[i * 3 + 1] ?? 0) * spread * 0.7 + Math.sin(swirl) * 0.3;
          burstPositions[i * 3 + 2] = burstFrom.z + (burstSeeds[i * 3 + 2] ?? 0) * spread;
        }
        burstAttribute.needsUpdate = true;
        burstMaterial.opacity = 0.9 * sync.burst;
        burstPoints.visible = sync.burst > 0.01;
      },
    },
    dispose: () => bin.dispose(),
  };
}

/* ------------------------------------------------------------ beat 3: conflict */

const CONFLICT_PAIRS = 6;

/**
 * Conflict retention.
 *
 * Pairs of orbs, one server value and one device value, orbiting a shared centre. They
 * never merge, at any point in the beat: the distance between the two is constant and
 * `conflictAt` returns the gap rather than a meeting. Each orb reaches toward the
 * centre with a stub of filament that stops short, so the disagreement is visible as
 * two versions of one answer with a space between them, which is what the product
 * stores.
 */
function buildConflict(quality: Quality): Built {
  const group = new THREE.Group();
  group.position.set(0, 0, -140);
  const bin = new Bin();
  const low = quality === 'low';

  const serverGeometry = bin.keep(new THREE.SphereGeometry(0.5, low ? 14 : 22, low ? 10 : 16));
  const deviceGeometry = bin.keep(new THREE.SphereGeometry(0.4, low ? 14 : 22, low ? 10 : 16));
  const serverMaterial = bin.keep(
    new THREE.MeshLambertMaterial({ color: ORB_SERVER, emissive: ACCENT, emissiveIntensity: 0.14 }),
  );
  const deviceMaterial = bin.keep(
    new THREE.MeshLambertMaterial({ color: ORB_DEVICE, emissive: PRIMARY, emissiveIntensity: 0.2 }),
  );
  const ringGeometry = bin.keep(new THREE.TorusGeometry(1, 0.012, 4, low ? 32 : 56));
  const ringMaterial = bin.keep(
    new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.16 }),
  );
  const stubGeometry = bin.keep(new THREE.BufferGeometry());
  const stubPositions = new THREE.BufferAttribute(new Float32Array(CONFLICT_PAIRS * 2 * 2 * 3), 3);
  stubPositions.setUsage(THREE.DynamicDrawUsage);
  stubGeometry.setAttribute('position', stubPositions);
  const stubMaterial = bin.keep(
    new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.22,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  const stubs = bin.line(stubGeometry, stubMaterial);
  stubs.frustumCulled = false;
  group.add(stubs);

  const pairs: Array<{ server: THREE.Mesh; device: THREE.Mesh; centre: THREE.Vector3 }> = [];
  for (let i = 0; i < CONFLICT_PAIRS; i += 1) {
    const column = i % 3;
    const row = Math.floor(i / 3);
    const centre = new THREE.Vector3((column - 1) * 5.4, (row - 0.5) * 3.6, (hash(i * 3) - 0.5) * 1.6);
    const server = new THREE.Mesh(serverGeometry, serverMaterial);
    const device = new THREE.Mesh(deviceGeometry, deviceMaterial);
    const ring = new THREE.Mesh(ringGeometry, ringMaterial);
    ring.position.copy(centre);
    ring.rotation.x = Math.PI / 2;
    group.add(ring, server, device);
    pairs.push({ server, device, centre });
  }

  const server = new THREE.Vector3();
  const device = new THREE.Vector3();

  return {
    beat: {
      group,
      update(local, elapsed) {
        const { orbit, gap, tension } = conflictAt(local);
        serverMaterial.emissiveIntensity = 0.1 + 0.28 * tension;
        deviceMaterial.emissiveIntensity = 0.16 + 0.42 * tension;
        stubMaterial.opacity = 0.1 + 0.3 * tension;

        for (let i = 0; i < pairs.length; i += 1) {
          const pair = pairs[i]!;
          const angle = orbit + i * 0.62 + elapsed * 0.1;
          // Half the distance, on both sides, from a separation that only ever breathes
          // by a few centimetres: the two values never occupy the same place.
          const half = (1 + gap) * 0.5;
          const tilt = 0.35 * Math.sin(angle * 0.5 + i);
          server.set(
            pair.centre.x + Math.cos(angle) * half,
            pair.centre.y + Math.sin(angle) * half * (1 - 0.25 * tilt),
            pair.centre.z,
          );
          device.set(
            pair.centre.x - Math.cos(angle) * half,
            pair.centre.y - Math.sin(angle) * half * (1 - 0.25 * tilt),
            pair.centre.z,
          );
          pair.server.position.copy(server);
          pair.device.position.copy(device);
          pair.server.rotation.y = angle;
          pair.device.rotation.y = -angle;

          // Each reaches for the other and stops: two stubs, never a join. Two
          // segments per pair, which is four vertices, so the pair's slot is i * 4.
          const from = i * 4;
          stubPositions.setXYZ(from, server.x, server.y, server.z);
          stubPositions.setXYZ(
            from + 1,
            server.x + (pair.centre.x - server.x) * 0.45,
            server.y + (pair.centre.y - server.y) * 0.45,
            pair.centre.z,
          );
          stubPositions.setXYZ(from + 2, device.x, device.y, device.z);
          stubPositions.setXYZ(
            from + 3,
            device.x + (pair.centre.x - device.x) * 0.45,
            device.y + (pair.centre.y - device.y) * 0.45,
            pair.centre.z,
          );
        }
        stubPositions.needsUpdate = true;
      },
    },
    dispose: () => bin.dispose(),
  };
}

/* ---------------------------------------------------------- beat 4: flythrough */

const CORRIDOR_FROM = -196;
const CORRIDOR_TO = -300;
const CORRIDOR_SLABS = 9;

/**
 * The fly-through.
 *
 * A corridor of form slabs with the camera banking down it. This beat has no text at
 * all: it is the breathing room between the scenes, and the only thing a reader is
 * asked to do is watch the product go past. The slabs alternate height and lean so the
 * corridor reads as forms stacked on both sides rather than as two walls, and the two
 * accent rails give the speed an edge to run along.
 */
function buildCorridor(quality: Quality): Built {
  const group = new THREE.Group();
  const bin = new Bin();
  const low = quality === 'low';
  const slabs = low ? 5 : CORRIDOR_SLABS;

  const slabGeometry = bin.keep(new THREE.BoxGeometry(0.12, 2.6, 1.7));
  const slabMaterial = bin.keep(new THREE.MeshLambertMaterial({ color: SLAB, emissive: PRIMARY, emissiveIntensity: 0.05 }));
  const edgeGeometry = bin.keep(new THREE.BoxGeometry(0.05, 0.05, 1.6));
  const edgeMaterial = bin.keep(new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.4 }));
  const floorGeometry = bin.keep(new THREE.BoxGeometry(7.4, 0.08, CORRIDOR_FROM - CORRIDOR_TO + 12));
  const floorMaterial = bin.keep(new THREE.MeshLambertMaterial({ color: 0x14171c }));

  const bodies: Array<{ mesh: THREE.Mesh; side: number; index: number }> = [];
  const span = (CORRIDOR_FROM - CORRIDOR_TO) / Math.max(1, slabs - 1);
  for (let side = -1; side <= 1; side += 2) {
    for (let i = 0; i < slabs; i += 1) {
      const mesh = new THREE.Mesh(slabGeometry, slabMaterial);
      mesh.position.set(side * 3.5, 0, CORRIDOR_FROM - i * span);
      mesh.rotation.z = side * 0.05;
      mesh.rotation.y = side * 0.07;
      const edge = new THREE.Mesh(edgeGeometry, edgeMaterial);
      edge.position.set(side * 3.42, 1.34, 0);
      mesh.add(edge);
      group.add(mesh);
      bodies.push({ mesh, side, index: i });
    }
  }

  const floor = new THREE.Mesh(floorGeometry, floorMaterial);
  floor.position.set(0, -1.42, (CORRIDOR_FROM + CORRIDOR_TO) / 2);
  group.add(floor);

  return {
    beat: {
      group,
      update(_local, elapsed) {
        for (const body of bodies) {
          const wobble = Math.sin(elapsed * 0.6 + body.index * 0.7 + body.side) * 0.06;
          body.mesh.position.y = wobble;
          body.mesh.rotation.x = wobble * 0.4;
        }
        edgeMaterial.opacity = 0.28 + 0.18 * Math.sin(elapsed * 1.4) ** 2;
      },
    },
    dispose: () => bin.dispose(),
  };
}

/* ------------------------------------------------------------- beat 5: tenants */

const REALMS = 3;

/**
 * Tenant isolation.
 *
 * Three realms, each with its own form inside it, each ringed by a membrane that
 * thickens as the beat plays, and each holding its own particles. Nothing crosses:
 * there is no exchange to animate, which is the claim. The membranes are two rings
 * rather than one because a single ring reads as decoration and two read as a
 * boundary.
 */
function buildTenants(quality: Quality): Built {
  const group = new THREE.Group();
  group.position.set(0, 0, -320);
  const bin = new Bin();
  const low = quality === 'low';

  const shellGeometry = bin.keep(new THREE.SphereGeometry(2.85, low ? 16 : 26, low ? 12 : 18));
  const shellMaterials: THREE.MeshLambertMaterial[] = [];
  const ringGeometry = bin.keep(new THREE.TorusGeometry(3.15, 0.03, 5, low ? 40 : 72));
  const membraneMaterials: THREE.MeshBasicMaterial[] = [];
  const innerGeometry = bin.keep(new THREE.BoxGeometry(1.05, 0.3, 0.06));
  const innerMaterial = bin.keep(new THREE.MeshLambertMaterial({ color: SLAB_LIT, emissive: ACCENT, emissiveIntensity: 0.12 }));

  const realms: Array<{ inner: THREE.Group; rings: THREE.Mesh[] }> = [];
  const perRealm = low ? 12 : 24;
  const particlePositions = new Float32Array(REALMS * perRealm * 3);
  for (let r = 0; r < REALMS; r += 1) {
    const centre = new THREE.Vector3((r - 1) * 7.4, 0, 0);
    const material = bin.keep(
      new THREE.MeshLambertMaterial({
        color: SLAB,
        emissive: PRIMARY,
        emissiveIntensity: 0.05,
        transparent: true,
        opacity: 0.16,
      }),
    );
    shellMaterials.push(material);
    const shell = new THREE.Mesh(shellGeometry, material);
    shell.position.copy(centre);
    group.add(shell);

    const rings: THREE.Mesh[] = [];
    for (let k = 0; k < 2; k += 1) {
      const ringMaterial = bin.keep(
        new THREE.MeshBasicMaterial({ color: k === 0 ? ACCENT : PRIMARY, transparent: true, opacity: 0.3 }),
      );
      membraneMaterials.push(ringMaterial);
      const ring = new THREE.Mesh(ringGeometry, ringMaterial);
      ring.position.copy(centre);
      ring.rotation.x = k === 0 ? Math.PI / 2 : 0;
      ring.rotation.y = k === 0 ? 0 : Math.PI / 2.2;
      group.add(ring);
      rings.push(ring);
    }

    const inner = new THREE.Group();
    inner.position.copy(centre);
    for (let q = 0; q < 5; q += 1) {
      const mesh = new THREE.Mesh(innerGeometry, innerMaterial);
      mesh.position.set(0, -0.9 + q * 0.45, 0);
      mesh.rotation.y = (hash(q * 3 + r) - 0.5) * 0.5;
      inner.add(mesh);
    }
    group.add(inner);
    realms.push({ inner, rings });
  }

  const particleGeometry = new THREE.BufferGeometry();
  const particleAttribute = new THREE.BufferAttribute(particlePositions, 3);
  particleAttribute.setUsage(THREE.DynamicDrawUsage);
  particleGeometry.setAttribute('position', particleAttribute);
  const particleMaterial = new THREE.PointsMaterial({
    color: ACCENT,
    size: low ? 0.09 : 0.07,
    transparent: true,
    opacity: 0.6,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const trapped = bin.points(particleGeometry, particleMaterial);
  trapped.frustumCulled = false;
  group.add(trapped);

  return {
    beat: {
      group,
      update(local, elapsed) {
        const { sealed, membrane } = tenantsAt(local);
        for (let r = 0; r < REALMS; r += 1) {
          const centreX = (r - 1) * 7.4;
          shellMaterials[r]!.opacity = 0.08 + 0.2 * sealed;
          shellMaterials[r]!.emissiveIntensity = 0.04 + 0.16 * sealed;
          const realm = realms[r]!;
          realm.rings[0]!.rotation.z = elapsed * (0.3 + r * 0.08);
          realm.rings[1]!.rotation.z = -elapsed * (0.24 + r * 0.06);
          for (const ring of realm.rings) ring.scale.setScalar(0.96 + 0.06 * membrane);
          realm.inner.rotation.y = elapsed * 0.16 + r;
          realm.inner.scale.setScalar(0.6 + 0.4 * sealed);

          // Each realm's own particles, orbiting inside its own membrane and nowhere
          // else: the distance from the realm's centre is capped below the boundary.
          for (let i = 0; i < perRealm; i += 1) {
            const slot = (r * perRealm + i) * 3;
            const seedA = hash(r * 31 + i);
            const seedB = hash(r * 17 + i * 3);
            const angle = elapsed * (0.5 + seedA * 0.6) + seedA * TAU;
            const radius = 0.9 + seedB * 1.4;
            particlePositions[slot] = centreX + Math.cos(angle) * radius;
            particlePositions[slot + 1] = Math.sin(elapsed * 0.7 + seedB * TAU) * 1.3;
            particlePositions[slot + 2] = Math.sin(angle) * radius;
          }
        }
        particleAttribute.needsUpdate = true;
        particleMaterial.opacity = 0.25 + 0.45 * sealed;
        for (const material of membraneMaterials) material.opacity = 0.12 + 0.5 * membrane;
      },
    },
    dispose: () => bin.dispose(),
  };
}

/* ---------------------------------------------------------- beat 6: invitation */

/**
 * The invitation.
 *
 * The last beat: a slab with a ring opening around it and a circle of particles coming
 * up to meet it. It is the only beat whose object is not a mechanism, because the thing
 * being depicted at the end of the flight is the way in.
 */
function buildInvitation(quality: Quality): Built {
  const group = new THREE.Group();
  group.position.set(0, 0, -392);
  const bin = new Bin();
  const low = quality === 'low';

  const slab = new THREE.Mesh(
    bin.keep(new THREE.BoxGeometry(1.7, 2.3, 0.09)),
    bin.keep(new THREE.MeshLambertMaterial({ color: SLAB_LIT, emissive: ACCENT, emissiveIntensity: 0.2 })),
  );
  group.add(slab);

  const ringMaterial = bin.keep(new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0 }));
  const ring = new THREE.Mesh(bin.keep(new THREE.TorusGeometry(2.5, 0.05, 6, low ? 48 : 96)), ringMaterial);
  group.add(ring);

  const haloMaterial = bin.keep(new THREE.MeshBasicMaterial({ color: PRIMARY, transparent: true, opacity: 0 }));
  const halo = new THREE.Mesh(bin.keep(new THREE.TorusGeometry(3.4, 0.02, 5, low ? 40 : 80)), haloMaterial);
  halo.rotation.x = Math.PI / 2;
  group.add(halo);

  const count = low ? 60 : 120;
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  for (let i = 0; i < count; i += 1) seeds[i] = hash(i * 5 + 2);
  const geometry = new THREE.BufferGeometry();
  const attribute = new THREE.BufferAttribute(positions, 3);
  attribute.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', attribute);
  const material = new THREE.PointsMaterial({
    color: 0xfff1e2,
    size: low ? 0.12 : 0.09,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const points = bin.points(geometry, material);
  points.frustumCulled = false;
  group.add(points);

  return {
    beat: {
      group,
      update(local, elapsed) {
        const { seal, widen } = invitationAt(local);
        slab.rotation.y = Math.sin(elapsed * 0.4) * 0.12;
        slab.material.emissiveIntensity = 0.14 + 0.6 * seal;
        ring.scale.setScalar(0.7 + 0.55 * widen);
        ring.rotation.z = elapsed * 0.3;
        ringMaterial.opacity = 0.1 + 0.7 * seal;
        halo.scale.setScalar(0.8 + 0.4 * widen);
        halo.rotation.z = -elapsed * 0.2;
        haloMaterial.opacity = 0.08 + 0.35 * seal;

        for (let i = 0; i < count; i += 1) {
          const seed = seeds[i] ?? 0;
          const angle = (i / count) * TAU + elapsed * 0.1;
          const radius = 2.2 + seed * 1.6 + widen * 0.5;
          positions[i * 3] = Math.cos(angle) * radius * (0.7 + 0.3 * seal);
          positions[i * 3 + 1] = (seed - 0.5) * 2.6 + Math.sin(elapsed * 0.6 + seed * 6) * 0.25;
          positions[i * 3 + 2] = Math.sin(angle) * radius * 0.45;
        }
        attribute.needsUpdate = true;
        material.opacity = 0.7 * seal;
      },
    },
    dispose: () => bin.dispose(),
  };
}

/* ------------------------------------------------------------- the instrument */

export async function createInstrument(
  canvas: HTMLCanvasElement,
  options: InstrumentOptions,
): Promise<Instrument | null> {
  const low = options.quality === 'low';

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: !low, alpha: false, powerPreference: 'high-performance' });
  } catch {
    // No WebGL on this device: the page is built to stand without the scene.
    return null;
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, low ? 1 : 1.6));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(SURFACE);
  // Fog is what makes this a journey rather than a set of rooms: the beat after next is
  // a suggestion, and the one behind has gone.
  scene.fog = new THREE.Fog(SURFACE, 42, 250);

  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 420);

  scene.add(new THREE.AmbientLight(0xffffff, low ? 0.75 : 0.55));
  const key = new THREE.DirectionalLight(0xffffff, low ? 0.75 : 1.0);
  key.position.set(6, 10, 8);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffb27a, 0.45);
  rim.position.set(-9, 3, -5);
  scene.add(rim);
  /** Follows the beat the reader is in, so each one has its own light. */
  const lamp = new THREE.PointLight(PRIMARY, 0, 60, 1.6);
  scene.add(lamp);

  const built: Built[] = [
    buildProgram(options.quality),
    buildSync(options.quality),
    buildConflict(options.quality),
    buildCorridor(options.quality),
    buildTenants(options.quality),
    buildInvitation(options.quality),
  ];
  for (const item of built) scene.add(item.beat.group);

  let progress = 0;
  let targetProgress = 0;
  let pointerX = 0;
  let pointerY = 0;
  let smoothPointerX = 0;
  let smoothPointerY = 0;
  let active = true;
  let disposed = false;
  let frame = 0;
  let last = performance.now();
  let elapsed = 0;

  /** The point the camera is looking at, rebuilt every frame. */
  const lookAt = { x: 0, y: 0, z: 0 };

  function resize(): void {
    const width = canvas.clientWidth || window.innerWidth;
    const height = canvas.clientHeight || window.innerHeight;
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(1, height);
    // A portrait phone needs a wider lens or a beat is cropped in half.
    camera.fov = Math.min(66, 38 * Math.pow(Math.max(1, 1.3 / camera.aspect), 0.55));
    camera.updateProjectionMatrix();
  }

  function draw(): void {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000 || 1 / 60);
    last = now;
    elapsed += dt;

    progress += (targetProgress - progress) * (options.reducedMotion ? 1 : 1 - Math.exp(-7 * dt));
    smoothPointerX += (pointerX - smoothPointerX) * (1 - Math.exp(-3 * dt));
    smoothPointerY += (pointerY - smoothPointerY) * (1 - Math.exp(-3 * dt));

    const presence = presenceAt(progress);
    const index = beatIndexAt(progress);
    const local = progress * BEAT_COUNT - index;

    for (let i = 0; i < built.length; i += 1) {
      // The current beat and its neighbours exist; anything further is off in the fog
      // and not worth a draw call.
      const shown = presence > 0.02 && Math.abs(i - index) <= 1;
      const item = built[i]!;
      item.beat.group.visible = shown;
      if (shown) item.beat.update(i === index ? local : i < index ? 1 : 0, elapsed);
    }

    const pose = cameraAt(progress);
    const parallax = low ? 0.5 : 0.9;
    camera.position.set(
      pose.x + smoothPointerX * parallax,
      pose.y + smoothPointerY * parallax * 0.5,
      pose.z,
    );
    lookAt.x = pose.lookX + smoothPointerX * 1.4;
    lookAt.y = pose.lookY + smoothPointerY * 0.7;
    lookAt.z = pose.lookZ;
    // Banking is the camera's own up vector, which is what makes the fly-through lean
    // and level out instead of merely turning.
    camera.up.set(Math.sin(pose.roll), Math.cos(pose.roll), 0);
    camera.lookAt(lookAt.x, lookAt.y, lookAt.z);

    lamp.position.set(pose.x + 3.5, pose.y + 3.2, pose.z - 5);
    lamp.intensity = 9 * presence;

    renderer.render(scene, camera);
  }

  function loop(): void {
    if (disposed) return;
    frame = requestAnimationFrame(loop);
    if (!active) return;
    draw();
  }

  // One synchronous frame, so the first paint is the scene rather than a black
  // rectangle that fills in a moment later. At progress 0 this is the empty surface
  // the hero's typography sits on, which is what the hero is for.
  resize();
  draw();
  if (!options.reducedMotion) frame = requestAnimationFrame(loop);

  return {
    setProgress(next: number) {
      targetProgress = clamp01(next);
      if (options.reducedMotion) {
        progress = targetProgress;
        draw();
      }
    },
    setPointer(x: number, y: number) {
      pointerX = Math.max(-1, Math.min(1, x));
      pointerY = Math.max(-1, Math.min(1, y));
    },
    setActive(next: boolean) {
      if (active === next) return;
      active = next;
      // The clock restarts, so coming back to the tab is not one enormous delta time.
      last = performance.now();
      if (active && options.reducedMotion) draw();
    },
    resize,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(frame);
      for (const item of built) item.dispose();
      scene.clear();
      renderer.dispose();
    },
  };
}
