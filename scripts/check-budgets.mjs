#!/usr/bin/env node
/**
 * What the browser is asked to download, checked against a budget.
 *
 * A size table in a README is a measurement somebody took once. This is the same
 * measurement, run against the build that is about to ship, failing the build when
 * it moves. Three things are worth failing a build over, and they are the three
 * reasons this file exists:
 *
 *   1. The critical path. Everything `index.html` points at is downloaded and
 *      executed before the app paints, by everyone, on the worst connection the
 *      product is meant to work on. That is the number a user actually pays.
 *   2. The renderer staying out of it. The landing page's WebGL scene is in its own
 *      lazily imported chunk precisely so that a person reading a table of responses
 *      never pays 135 kB for it. A single static import of the scene would silently
 *      move three.js into the entry chunk and nobody would notice until a phone on
 *      a train did, so the split is asserted rather than assumed. The definition
 *      studio and the pointer trail are held to the same rule, and the trail is the
 *      one most easily broken by hand: it is mounted on every route, so `import`
 *      instead of `import()` looks harmless and is exactly the mistake this catches.
 *   3. A ceiling on any chunk at all, so a dependency added for one screen cannot
 *      quietly arrive as half a megabyte.
 *
 * Run after `pnpm build`. Exits non-zero and names the overage; prints the table
 * either way, because the numbers are useful when a build is green too.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const DIST = 'apps/web/dist';
const ASSETS = join(DIST, 'assets');

/** gzip, because that is what crosses the wire. */
const gzipped = (file) => gzipSync(readFileSync(file)).length;
const kb = (bytes) => `${(bytes / 1024).toFixed(1)} kB`;

const budgets = {
  // The sign-in screen, the console, collection and the legal pages, together.
  criticalJs: 80 * 1024,
  criticalCss: 7 * 1024,
  // The landing page's own code, loaded after first paint.
  landingJs: 8 * 1024,
  landingCss: 6 * 1024,
  // The renderer, which only the landing page ever asks for.
  instrumentJs: 150 * 1024,
  // The definition studio: the JSON panel, the XLSForm sheet viewer and the
  // respondent preview, loaded when somebody opens a form. It is the authoring
  // tool, so it is allowed to be bigger than a landing page and is still held to
  // a third of the single-chunk ceiling.
  studioJs: 40 * 1024,
  // The pointer trail. Twenty springs of fifty beads and the curve through them, on
  // every route but only after a pointer has moved — it is the smallest lazy chunk in
  // the build, and it is the one that must never be *imported* statically, because it
  // is decoration and nobody should wait for it before the first paint.
  cursorJs: 4 * 1024,
};

let failed = 0;
const fail = (message) => {
  failed += 1;
  console.error(`  ✗ ${message}`);
};

// ----------------------------------------------------------------- the build

let html;
try {
  html = readFileSync(join(DIST, 'index.html'), 'utf8');
} catch {
  console.error(`No ${DIST}/index.html. Run \`pnpm build\` first.`);
  process.exit(2);
}

const referenced = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]);
if (referenced.length === 0) {
  console.error('index.html references no built assets, which means this check is not looking at the app.');
  process.exit(2);
}

const files = readdirSync(ASSETS).filter((name) => /\.(js|css)$/.test(name));
const entries = files.map((name) => {
  const path = join(ASSETS, name);
  return {
    name,
    bytes: statSync(path).size,
    gzip: gzipped(path),
    critical: referenced.includes(`/assets/${name}`),
  };
});

console.log('\nBundle budgets (gzip, what crosses the wire)\n');
console.log('  asset                              raw       gzip      budget    where');
for (const entry of entries.sort((a, b) => b.gzip - a.gzip)) {
  const kind = entry.name.endsWith('.css') ? 'css' : 'js';
  const isInstrument = entry.name.startsWith('instrument-');
  const isLanding = entry.name.startsWith('landing-');
  const isStudio = entry.name.startsWith('studio-');
  const isCursor = entry.name.startsWith('cursor-trail-');
  const budget = entry.critical
    ? kind === 'css'
      ? budgets.criticalCss
      : budgets.criticalJs
    : isInstrument
      ? budgets.instrumentJs
      : isLanding
        ? kind === 'css'
          ? budgets.landingCss
          : budgets.landingJs
        : isStudio
          ? budgets.studioJs
          : isCursor
            ? budgets.cursorJs
            : budgets.instrumentJs;
  // Named honestly. A lazy chunk used to be labelled "landing, lazy" whether or not
  // it was the landing page, which made the table describe the build inaccurately at
  // exactly the moment somebody was reading it to find out what grew.
  const where = entry.critical
    ? 'critical path'
    : isInstrument
      ? 'landing, lazy'
      : isLanding
        ? 'landing, lazy'
        : isStudio
          ? 'studio, lazy'
          : isCursor
            ? 'cursor, lazy'
            : 'lazy, unnamed';
  const over = entry.gzip > budget;
  if (over) fail(`${entry.name} is ${kb(entry.gzip)} gzipped, over its ${kb(budget)} budget (${where})`);
  console.log(
    `  ${entry.name.padEnd(34)} ${kb(entry.bytes).padStart(9)} ${kb(entry.gzip).padStart(9)} ${
      over ? '  OVER  ' : kb(budget).padStart(9)
    }   ${where}`,
  );
}

// --------------------------------------------------- the split, asserted

const instrument = entries.find((entry) => entry.name.startsWith('instrument-'));
if (!instrument) {
  fail('no instrument-*.js chunk in the build: the renderer is no longer split out of the app');
} else {
  const critical = entries.filter((entry) => entry.critical && entry.name.endsWith('.js'));
  for (const entry of critical) {
    const source = readFileSync(join(ASSETS, entry.name), 'utf8');
    // The renderer's own symbols, and the class names three.js keeps in its
    // source for error messages: if any of these appear in a critical chunk, the
    // scene has been pulled into the path everybody pays for.
    for (const marker of ['WebGLRenderer', 'createInstrument', 'linstrument']) {
      if (source.includes(marker)) {
        fail(`${entry.name} contains "${marker}": the WebGL scene has leaked into the critical path`);
      }
    }
    // The studio's workbook writer, the same argument: the XLSForm sheets are an
    // authoring tool, and a static import of `./studio` would put them on the path
    // every respondent and every reader of a table pays for.
    for (const marker of ['list_name', 'constraint_message', 'begin_repeat']) {
      if (source.includes(marker)) {
        fail(`${entry.name} contains "${marker}": the definition studio has leaked into the critical path`);
      }
    }
    /*
     * And the trail, on the same argument: a decoration on every route is exactly the thing
     * somebody is tempted to import statically because "it is only a canvas".
     *
     * The markers are the curve call and the media query the effect asks for, both of which
     * exist nowhere else in the app and both of which survive minification (a canvas method
     * is a property name, and a media query is a string). `mountCursorTrail` deliberately
     * is *not* a marker: the call site — `module.mountCursorTrail(canvas)` — is in the entry
     * chunk by definition, because the property being called on a dynamically imported
     * module cannot be renamed. That is the call, not the code.
     */
    for (const marker of ['quadraticCurveTo', 'any-pointer: fine']) {
      if (source.includes(marker)) {
        fail(`${entry.name} contains "${marker}": the pointer trail has leaked into the critical path`);
      }
    }
  }

  const cursor = entries.find((entry) => entry.name.startsWith('cursor-trail-'));
  if (!cursor) {
    fail('no cursor-trail-*.js chunk in the build: the pointer trail is no longer split out of the app');
  }

  const studio = entries.find((entry) => entry.name.startsWith('studio-'));
  if (!studio) {
    fail('no studio-*.js chunk in the build: the definition studio is no longer split out of the app');
  }
}

console.log('');
if (failed > 0) {
  console.error(`${failed} budget${failed === 1 ? '' : 's'} exceeded.\n`);
  process.exit(1);
}
console.log('All within budget.\n');
