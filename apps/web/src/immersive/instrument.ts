import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/**
 * The instrument.
 *
 * A live scene, not a video and not a picture: a structure of glass blades on
 * chrome spines that assembles as the page is read. It is the product's own idea
 * rendered literally. A form is a sequence of questions wired together by rules,
 * so the object is a sequence of nodes wired together by filaments; each scroll
 * chapter changes how the same nodes are arranged, because that is exactly what
 * happens to a questionnaire as it grows from a handful of questions into a
 * branching instrument.
 *
 * Three constraints shape every line below.
 *
 * Cost. Everything on the landing page has to stay honest about what it costs a
 * reader, so there are two quality tiers, the pixel ratio is capped, the loop
 * stops when the tab is hidden or the canvas is off screen, and the whole scene is
 * imported dynamically: a signed in user opening the console never downloads it.
 *
 * It has to survive not existing. WebGL context creation is the one thing that
 * genuinely fails on real devices, so `createInstrument` returns null rather than
 * throwing, and the page renders without it.
 *
 * It has to respect the reader. Under `prefers-reduced-motion` the scene draws one
 * frame and stops. It is also purely decorative, so it is exposed to assistive
 * technology as nothing at all: the canvas is `aria-hidden` and every claim on the
 * page is real text.
 */

export type Quality = 'high' | 'low';

export interface InstrumentOptions {
  quality: Quality;
  /** True when the reader asked for reduced motion: draw one frame and stop. */
  reducedMotion: boolean;
}

export interface Instrument {
  /** 0 to 1 across the pinned stage: the assembly's own progress. */
  setProgress(progress: number): void;
  /** Pointer position in -1..1, used only for parallax. */
  setPointer(x: number, y: number): void;
  /** Stop drawing (stage off screen or tab hidden) without tearing anything down. */
  setActive(active: boolean): void;
  resize(): void;
  dispose(): void;
}

const TAU = Math.PI * 2;

/**
 * The brand accents, so the glass refracts the same two colours as the interface.
 *
 * The stage is the page's dark surface, so the light that falls on it is the
 * palette's own: the primary orange, and the peach accent, which is only ever seen
 * on a dark surface because it is 1.9:1 on white. Nothing blue survives here — a
 * scene lit in a colour the interface does not use is the quickest way to make one
 * product look assembled out of two.
 */
const PRIMARY = new THREE.Color('#ea580c');
const ACCENT_WARM = new THREE.Color('#fdba74');
/** The stage's ground: the same value as the stylesheet's `--l-surface`. */
const SURFACE = new THREE.Color('#191c21');

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const range = (v: number, a: number, b: number): number => clamp01((v - a) / (b - a));
const smooth = (t: number): number => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};
/** Deterministic per-index noise, so instance variation is stable across frames. */
function hash(i: number): number {
  const s = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * The studio the glass reflects.
 *
 * Rendered once into a PMREM texture and used as the environment map, so every
 * highlight on every surface comes from this one description of the room rather
 * than from painted textures. Window high left, accent lobes in the product
 * colours, dark floor.
 */
function buildEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const scene = new THREE.Scene();
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec3 vPosition;
      void main() {
        vPosition = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vPosition;
      void main() {
        vec3 dir = normalize(vPosition);
        float u = atan(dir.z, dir.x);
        float v = dir.y;

        // Base: a dark floor rising into a warm ceiling.
        vec3 colour = mix(vec3(0.02, 0.02, 0.025), vec3(0.92, 0.90, 0.88), smoothstep(-0.7, 0.9, v));

        // The key light: a broad window high and to the left.
        colour += vec3(1.0, 0.97, 0.94) * 2.1 * exp(-pow((v - 0.66) / 0.10, 2.0));
        // A second, warmer strip lower down so the chrome has something to catch.
        colour += vec3(1.0, 0.86, 0.74) * 0.7 * exp(-pow((v - 0.10) / 0.05, 2.0));

        // The brand accents at the edges: the primary orange and the peach.
        colour += vec3(0.92, 0.35, 0.05) * 1.15 * exp(-pow((u - 1.75) / 0.62, 2.0)) * exp(-pow((v - 0.02) / 0.42, 2.0));
        colour += vec3(1.0, 0.73, 0.45) * 0.85 * exp(-pow((u + 1.65) / 0.62, 2.0)) * exp(-pow((v + 0.06) / 0.42, 2.0));
        colour += vec3(1.0, 0.50, 0.20) * 0.35 * exp(-pow((u + 0.15) / 0.5, 2.0)) * exp(-pow((v + 0.55) / 0.3, 2.0));

        gl_FragColor = vec4(colour, 1.0);
      }
    `,
  });
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(60, 64, 32), material));

  const generator = new THREE.PMREMGenerator(renderer);
  const target = generator.fromScene(scene, 0.02);
  generator.dispose();
  material.dispose();
  return target.texture;
}

/**
 * One blade: a rounded slab, thick enough to show refraction, with a slight curve
 * so a strand of them reads as a continuous ribbon rather than a row of bricks.
 */
function bladeGeometry(): THREE.BufferGeometry {
  const width = 1.0;
  const height = 0.26;
  const radius = 0.06;
  const shape = new THREE.Shape();
  const x = -width / 2;
  const y = -height / 2;
  shape.moveTo(x + radius, y);
  shape.lineTo(x + width - radius, y);
  shape.absarc(x + width - radius, y + radius, radius, -Math.PI / 2, 0);
  shape.lineTo(x + width, y + height - radius);
  shape.absarc(x + width - radius, y + height - radius, radius, 0, Math.PI / 2);
  shape.lineTo(x + radius, y + height);
  shape.absarc(x + radius, y + height - radius, radius, Math.PI / 2, Math.PI);
  shape.lineTo(x, y + radius);
  shape.absarc(x + radius, y + radius, radius, Math.PI, Math.PI * 1.5);

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 0.04,
    bevelEnabled: true,
    bevelThickness: 0.014,
    bevelSize: 0.012,
    bevelSegments: 2,
    curveSegments: 5,
  });
  geometry.center();
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Where node `index` sits, for a given assembly phase.
 *
 * Three arrangements of the same nodes, blended by `phase` so the object never
 * jumps between states:
 *   0.0  a knot: everything folded in on itself, the shape of an unopened idea
 *   0.5  a spine: the questions in order, one after another, a questionnaire
 *   1.0  a lattice: the same nodes spread wide, the shape of a live instrument
 */
function nodePosition(
  index: number,
  count: number,
  strands: number,
  phase: number,
  time: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  const strand = index % strands;
  const along = Math.floor(index / strands);
  const perStrand = Math.max(1, Math.ceil(count / strands));
  const s = along / perStrand;
  const drift = time * 0.12;

  // Knot: a torus knot, folded and dense.
  const ku = s * TAU;
  const knotRadius = 2.35 + 0.5 * Math.sin(ku * 3 + strand * 0.4 + drift);
  const knot = new THREE.Vector3(
    knotRadius * Math.cos(ku * 2 + strand * 0.18),
    (0.62 * Math.sin(ku * 3 + strand * 0.5)) * 2.4,
    knotRadius * Math.sin(ku * 2 + strand * 0.18),
  );

  // Spine: a tall helix. This is the arrangement that reads as "questions".
  const spine = new THREE.Vector3(
    Math.cos(ku + strand * (TAU / strands) + drift * 0.4) * 1.35,
    (s - 0.5) * 9.5,
    Math.sin(ku + strand * (TAU / strands) + drift * 0.4) * 1.35,
  );

  // Lattice: spokes of a wheel, the shape the structure takes when it is working.
  const spokeAngle = strand * (TAU / strands) + drift * 0.25;
  const spokeRadius = 1.1 + s * 3.3;
  const lattice = new THREE.Vector3(
    Math.cos(spokeAngle) * spokeRadius,
    (s - 0.5) * 5.4 + 0.55 * Math.sin(ku * 2 + strand),
    Math.sin(spokeAngle) * spokeRadius,
  );

  const toSpine = smooth(range(phase, 0.18, 0.55));
  const toLattice = smooth(range(phase, 0.55, 0.95));
  out.copy(knot).lerp(spine, toSpine).lerp(lattice, toLattice);
  return out;
}

export async function createInstrument(
  canvas: HTMLCanvasElement,
  options: InstrumentOptions,
): Promise<Instrument | null> {
  const low = options.quality === 'low';
  const strands = low ? 6 : 9;
  const perStrand = low ? 16 : 24;
  const count = strands * perStrand;
  const chromeEvery = 5;

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: !low,
      alpha: false,
      powerPreference: 'high-performance',
    });
  } catch {
    // No WebGL: the page is designed to stand without it.
    return null;
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, low ? 1 : 1.75));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.06;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  if ('transmissionResolutionScale' in renderer) {
    // Transmission renders the scene a second time; at half resolution it is
    // indistinguishable behind the bloom and costs a quarter as much.
    (renderer as unknown as { transmissionResolutionScale: number }).transmissionResolutionScale = 0.5;
  }

  const scene = new THREE.Scene();
  scene.background = SURFACE.clone();
  const environment = buildEnvironment(renderer);
  scene.environment = environment;

  const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 200);
  camera.position.set(0, 0.4, 13);

  const key = new THREE.DirectionalLight(0xffffff, 1.5);
  key.position.set(5, 9, 7);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xffb27a, 0.9);
  rim.position.set(-8, 2, -6);
  scene.add(rim);
  const accent = new THREE.PointLight(PRIMARY.getHex(), 0, 40, 1.8);
  accent.position.set(2.5, 1.5, 5);
  scene.add(accent);

  const glass = new THREE.MeshPhysicalMaterial({
    color: 0xffe9d6,
    metalness: 0,
    roughness: 0.06,
    transmission: low ? 0 : 1,
    thickness: 0.42,
    ior: 1.45,
    clearcoat: 1,
    clearcoatRoughness: 0.04,
    iridescence: 0.8,
    iridescenceIOR: 1.3,
    iridescenceThicknessRange: [120, 540],
    attenuationColor: PRIMARY.clone().lerp(new THREE.Color('#ffffff'), 0.35),
    attenuationDistance: 1.4,
    envMapIntensity: 1.25,
    transparent: low,
    opacity: low ? 0.82 : 1,
    emissive: ACCENT_WARM.clone(),
    emissiveIntensity: 0,
  });

  const chrome = new THREE.MeshPhysicalMaterial({
    color: 0xeef2fa,
    metalness: 1,
    roughness: 0.08,
    envMapIntensity: 1.4,
    clearcoat: 0.5,
    clearcoatRoughness: 0.05,
    emissive: PRIMARY.clone(),
    emissiveIntensity: 0,
  });

  const blade = bladeGeometry();
  const glassCount = count - Math.floor(count / chromeEvery);
  const chromeCount = Math.floor(count / chromeEvery);
  const blades = new THREE.InstancedMesh(blade, glass, Math.max(1, glassCount));
  const ribs = new THREE.InstancedMesh(blade, chrome, Math.max(1, chromeCount));
  blades.frustumCulled = false;
  ribs.frustumCulled = false;
  scene.add(blades, ribs);

  // Per-node variation, generated once from a stable hash so nothing shimmers.
  const stagger = new Float32Array(count);
  const twist = new Float32Array(count);
  const scaleJitter = new Float32Array(count);
  const tint = new THREE.Color();
  let glassIndex = 0;
  let ribIndex = 0;
  const slot = new Int32Array(count);
  for (let i = 0; i < count; i += 1) {
    stagger[i] = hash(i + 1);
    twist[i] = hash(i * 7 + 3) - 0.5;
    scaleJitter[i] = 0.82 + hash(i * 13 + 5) * 0.36;
    if (i % chromeEvery === 0) {
      slot[i] = ribIndex;
      ribIndex += 1;
    } else {
      slot[i] = glassIndex;
      // Glass keeps a trace of colour, taken from the product accents, so the
      // structure reads as belonging to this interface and not to a demo.
      tint.copy(PRIMARY).lerp(ACCENT_WARM, hash(i * 17 + 9)).lerp(new THREE.Color('#ffffff'), 0.72);
      blades.setColorAt(glassIndex, tint);
      glassIndex += 1;
    }
  }
  if (blades.instanceColor) blades.instanceColor.needsUpdate = true;

  // The filaments: the rules between the questions, drawn as lines between
  // consecutive nodes of a strand.
  const segments = Math.max(1, count - strands);
  const filamentPositions = new Float32Array(segments * 2 * 3);
  const filamentGeometry = new THREE.BufferGeometry();
  const filamentAttribute = new THREE.BufferAttribute(filamentPositions, 3);
  filamentAttribute.setUsage(THREE.DynamicDrawUsage);
  filamentGeometry.setAttribute('position', filamentAttribute);
  const filamentMaterial = new THREE.LineBasicMaterial({
    color: 0xfdba74,
    transparent: true,
    opacity: 0.24,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const filaments = new THREE.LineSegments(filamentGeometry, filamentMaterial);
  filaments.frustumCulled = false;
  scene.add(filaments);

  // Dust, so the void behind the structure has depth rather than being a flat fill.
  const dustCount = low ? 300 : 700;
  const dustPositions = new Float32Array(dustCount * 3);
  for (let i = 0; i < dustCount; i += 1) {
    dustPositions[i * 3] = (hash(i * 3 + 1) - 0.5) * 34;
    dustPositions[i * 3 + 1] = (hash(i * 5 + 2) - 0.5) * 22;
    dustPositions[i * 3 + 2] = (hash(i * 7 + 3) - 0.5) * 22 - 6;
  }
  const dustGeometry = new THREE.BufferGeometry();
  dustGeometry.setAttribute('position', new THREE.BufferAttribute(dustPositions, 3));
  const dustMaterial = new THREE.PointsMaterial({
    color: 0xfdba74,
    size: 0.05,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const dust = new THREE.Points(dustGeometry, dustMaterial);
  scene.add(dust);

  let composer: EffectComposer | null = null;
  let bloom: UnrealBloomPass | null = null;
  if (!low) {
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.5, 0.7, 0.86);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());
  }

  const dummy = new THREE.Object3D();
  const position = new THREE.Vector3();
  const ahead = new THREE.Vector3();
  const behind = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const binormal = new THREE.Vector3();
  const basis = new THREE.Matrix4();
  const orientation = new THREE.Quaternion();
  const spin = new THREE.Quaternion();
  const axisX = new THREE.Vector3(1, 0, 0);
  const axisY = new THREE.Vector3(0, 1, 0);

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

  function resize(): void {
    const width = canvas.clientWidth || window.innerWidth;
    const height = canvas.clientHeight || window.innerHeight;
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(1, height);
    // A portrait phone needs a wider lens or the structure is cropped in half.
    camera.fov = Math.min(64, 36 * Math.pow(Math.max(1, 1.35 / camera.aspect), 0.6));
    camera.updateProjectionMatrix();
    if (composer && bloom) {
      composer.setSize(width, height);
      bloom.setSize(width, height);
    }
  }

  function draw(): void {
    const dt = Math.min(0.05, (last ? (performance.now() - last) / 1000 : 1 / 60));
    last = performance.now();
    elapsed += dt;

    progress = lerp(progress, targetProgress, 1 - Math.exp(-6 * dt));
    smoothPointerX = lerp(smoothPointerX, pointerX, 1 - Math.exp(-3 * dt));
    smoothPointerY = lerp(smoothPointerY, pointerY, 1 - Math.exp(-3 * dt));

    const phase = progress;
    const presence = smooth(range(progress, 0, 0.12));

    for (let i = 0; i < count; i += 1) {
      nodePosition(i, count, strands, phase, elapsed, position);
      // Tangent from a neighbouring sample gives the ribbon its direction.
      nodePosition(Math.min(count - 1, i + 1), count, strands, phase, elapsed, ahead);
      nodePosition(Math.max(0, i - 1), count, strands, phase, elapsed, behind);
      tangent.subVectors(ahead, behind);
      if (tangent.lengthSq() < 1e-8) tangent.set(0, 1, 0);
      tangent.normalize();
      binormal.crossVectors(tangent, axisY);
      if (binormal.lengthSq() < 1e-8) binormal.set(1, 0, 0);
      binormal.normalize();
      normal.crossVectors(binormal, tangent).normalize();
      basis.makeBasis(binormal, tangent, normal);
      orientation.setFromRotationMatrix(basis);
      // Each blade leans a little, and the lean increases as the structure opens.
      spin.setFromAxisAngle(axisX, (0.35 + phase * 0.5) * Math.sin(elapsed * 0.5 + i * 0.4));
      orientation.multiply(spin);
      spin.setFromAxisAngle(axisY, twist[i] * (0.4 + phase * 1.1));
      orientation.multiply(spin);

      const reveal = smooth(range(phase * 1.15, stagger[i] * 0.5, stagger[i] * 0.5 + 0.35));
      const scale = scaleJitter[i] * lerp(0.55, 1.05, Math.max(reveal, presence));
      dummy.position.copy(position);
      dummy.position.y += (1 - presence) * -2.2;
      dummy.quaternion.copy(orientation);
      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      if (i % chromeEvery === 0) ribs.setMatrixAt(slot[i], dummy.matrix);
      else blades.setMatrixAt(slot[i], dummy.matrix);
    }
    blades.instanceMatrix.needsUpdate = true;
    ribs.instanceMatrix.needsUpdate = true;

    // Rebuild the filament positions from the same node positions.
    let cursor = 0;
    for (let i = 0; i < count; i += 1) {
      if (i % strands === 0) continue;
      const previous = i - 1;
      nodePosition(previous, count, strands, phase, elapsed, position);
      filamentPositions[cursor++] = position.x;
      filamentPositions[cursor++] = position.y;
      filamentPositions[cursor++] = position.z;
      nodePosition(i, count, strands, phase, elapsed, position);
      filamentPositions[cursor++] = position.x;
      filamentPositions[cursor++] = position.y;
      filamentPositions[cursor++] = position.z;
    }
    filamentAttribute.needsUpdate = true;
    filamentMaterial.opacity = 0.08 + 0.24 * smooth(range(progress, 0.1, 0.6));

    // The interface colours move through the structure as it opens.
    accent.color.copy(PRIMARY).lerp(ACCENT_WARM, smooth(range(progress, 0.5, 1)));
    accent.position.set(Math.cos(elapsed * 0.3) * 4, Math.sin(elapsed * 0.22) * 2.4, 4);
    accent.intensity = 8 * presence;

    const glow = smooth(range(progress, 0.45, 1));
    glass.emissiveIntensity = glow * 0.14;
    chrome.emissiveIntensity = glow * 0.32;

    dust.rotation.y = elapsed * 0.012;
    dustMaterial.opacity = 0.2 + 0.4 * presence;

    // Camera: a slow drift plus pointer parallax, tighter as the structure opens.
    const pull = lerp(13, 10.5, smooth(range(progress, 0, 1)));
    camera.position.x = lerp(camera.position.x, smoothPointerX * 1.5, 1 - Math.exp(-4 * dt));
    camera.position.y = lerp(camera.position.y, 0.4 + smoothPointerY * 0.9, 1 - Math.exp(-4 * dt));
    camera.position.z = lerp(camera.position.z, pull, 1 - Math.exp(-3 * dt));
    camera.lookAt(0, -0.4 + smoothPointerY * 0.3, 0);

    if (bloom) bloom.strength = 0.28 + 0.5 * glow;

    if (composer) composer.render();
    else renderer.render(scene, camera);
  }

  function loop(): void {
    if (disposed) return;
    frame = requestAnimationFrame(loop);
    if (!active) return;
    draw();
  }

  resize();
  // One synchronous frame means the very first paint is the structure, not a
  // black rectangle that fills in a moment later.
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
      // Reset the clock so returning to the page does not produce one enormous
      // delta time and a visible jump.
      last = performance.now();
      if (active && options.reducedMotion) draw();
    },
    resize,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(frame);
      blade.dispose();
      blades.dispose();
      ribs.dispose();
      glass.dispose();
      chrome.dispose();
      filamentGeometry.dispose();
      filamentMaterial.dispose();
      dustGeometry.dispose();
      dustMaterial.dispose();
      environment.dispose();
      composer?.dispose();
      renderer.dispose();
    },
  };
}
