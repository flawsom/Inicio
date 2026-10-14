import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hueOf, readPng, saturationOf } from './png';

/**
 * The brand, in the artifacts that are neither components nor stylesheets.
 *
 * `contrast.test.ts` holds the palette in the two stylesheets. This holds it everywhere
 * else a colour is committed, and each of those places failed the same way once: the
 * README's pictures were drawn in the previous palette, the badge colours were the
 * previous palette, and the app icons — the one asset seen in every browser tab and on
 * every home screen — were generated once, before the palette existed, and then left
 * alone through two palette changes. A stylesheet is edited; a PNG is not.
 *
 * So the drawings, the badges and the icons are read here as what they are: text, and
 * pixels. The drawings and badges are checked by value; the icons are decoded and
 * checked by hue, because "still the old blue" is a claim about a picture.
 */

const ROOT = join(__dirname, '..', '..', '..');
const DRAWINGS = join(ROOT, 'docs', 'assets');
const PUBLIC = join(ROOT, 'apps', 'web', 'public');

/**
 * The palette this replaced, as it was actually written in the drawings and the badges.
 * Kept as literals rather than derived: the point is that these exact strings must not
 * come back, and a value that has to be computed is a value that can be computed wrong.
 */
const PRE_BRAND = [
  '#04060c',
  '#05070d',
  '#06080f',
  '#0a0e18',
  '#0a1020',
  '#0b1120',
  '#0c1322',
  '#0f172a',
  '#38bdf8',
  '#7dd3fc',
  '#22d3ee',
  '#0074d9',
  '#a78bfa',
  '#c4b5fd',
  '#7b4dff',
  '#93a1b8',
  '#6b7c95',
  '#b6c4d8',
  '#a9b8cd',
  '#8394ad',
  '#dbe6f5',
  '#e8eef9',
  '#eef4fd',
  '#c3d0e2',
  '#d7e3f2',
  '#bcd2ea',
  '#c21f39',
  '#f9cd0b',
];

const hexesIn = (text: string): string[] =>
  [...text.matchAll(/#([0-9a-fA-F]{6})\b/g)].map((match) => match[1].toLowerCase());

const toRgb = (hex: string): [number, number, number] => [
  Number.parseInt(hex.slice(0, 2), 16),
  Number.parseInt(hex.slice(2, 4), 16),
  Number.parseInt(hex.slice(4, 6), 16),
];

describe('the brand in everything that is not a stylesheet', () => {
  const drawings = readdirSync(DRAWINGS).filter((file) => file.endsWith('.svg'));

  it('ships the drawings it is checking', () => {
    // A test that reads a directory is a test that passes when the directory empties.
    expect(drawings.length).toBeGreaterThanOrEqual(8);
  });

  it.each(drawings)('%s is drawn in the brand palette, not the one before it', (file) => {
    const source = readFileSync(join(DRAWINGS, file), 'utf8');
    const colours = hexesIn(source);
    expect(colours.length).toBeGreaterThan(3);

    for (const hex of colours) {
      expect(PRE_BRAND, `${file} still carries #${hex}, which is the previous palette`).not.toContain(`#${hex}`);
    }

    // And no blue or violet *accent* may come back, which is the thing a viewer
    // actually notices. Measured by hue with real chroma rather than by channel order,
    // because a channel comparison calls the interface's own greens and greys cool, and
    // a ratio comparison calls its near-black grounds cool: #101216 is six units of blue
    // over red on a value of twenty-two, which is 27 % chroma by ratio and nothing at
    // all to the eye. The accents this replaced are saturated (0.44 to 1.00) and carry
    // real chroma (96 to 217 units) in the 185°-285° arc; the grounds carry 6 to 12.
    for (const hex of colours) {
      const [r, g, b] = toRgb(hex);
      const hue = hueOf(r, g, b);
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      const cool = hue !== null && hue >= 185 && hue <= 285 && saturationOf(r, g, b) >= 0.35 && chroma >= 24;
      expect(cool, `${file} draws #${hex}, a blue-violet accent`).toBe(false);
    }

    // And each drawing shows the product, so each one carries at least one of the warm
    // accents the product is built from rather than a palette of greys.
    const accents = ['#ea580c', '#c2410c', '#fdba74', '#fed7aa', '#fbbf24', '#fcd34d'];
    expect(
      colours.some((hex) => accents.includes(`#${hex}`)),
      `${file} carries none of the brand's accents`,
    ).toBe(true);
  });

  it('wears the brand on the repository page', () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    const badges = [...readme.matchAll(/img\.shields\.io\/[^)\s"]+/g)].map((match) => match[0]);
    expect(badges.length).toBeGreaterThan(20);

    for (const badge of badges) {
      for (const hex of PRE_BRAND) {
        expect(badge.toLowerCase(), `a badge is still ${hex}`).not.toContain(hex);
      }
    }

    // Every badge's label ground is the product's own dark surface, so the row reads as
    // one object rather than as a stack of shields defaults. Vendor colours live in
    // `color=`, which is not asserted: those are other people's brands.
    const labels = [...readme.matchAll(/labelColor=([0-9a-fA-F]{6})/g)].map((match) => match[1].toLowerCase());
    expect(labels.length).toBeGreaterThan(20);
    for (const label of labels) {
      expect(label, 'a badge label is not the surface colour').toBe('191c21');
    }
  });

  it('generates the app icons from the palette, and they still look like it', () => {
    for (const [file, size] of [
      ['icon-192.png', 192],
      ['icon-512.png', 512],
      ['apple-touch-icon.png', 180],
    ] as const) {
      const { width, height, pixels } = readPng(readFileSync(join(PUBLIC, file)));
      expect(`${file} ${width}x${height}`).toBe(`${file} ${size}x${size}`);

      const counts = new Map<string, number>();
      let blue = 0;
      let opaque = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        const [r, g, b, a] = [pixels[index], pixels[index + 1], pixels[index + 2], pixels[index + 3]];
        if (a < 32) continue;
        opaque += 1;
        const key = `${r},${g},${b}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        const hue = hueOf(r, g, b);
        // The old icon was a navy ground under a light blue mark: 92 % of its pixels had
        // a blue that led its red by more than thirty. A neutral ground has eight.
        if (b - r >= 24 && saturationOf(r, g, b) >= 0.35 && hue !== null && hue >= 185 && hue <= 285) {
          blue += 1;
        }
      }

      expect(opaque).toBeGreaterThan(width * height * 0.3);
      const ground = [...counts.entries()].sort((one, two) => two[1] - one[1])[0][0];
      expect(`#${ground.split(',').map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`).toBe('#191c21');
      expect(counts.has('234,88,12'), `${file} does not carry the primary`).toBe(true);
      expect(blue, `${file} still has blue-dominant pixels`).toBe(0);
      // The three colours the previous icon was made of, absent by value rather than by hue.
      for (const gone of ['15,23,42', '56,189,248', '248,250,252']) {
        expect(counts.has(gone), `${file} still contains rgb(${gone})`).toBe(false);
      }
    }
  });
});
