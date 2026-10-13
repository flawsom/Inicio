import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Contrast, computed from the stylesheets rather than eyeballed in a browser.
 *
 * `axe` cannot check contrast in jsdom: the rule needs a real renderer to resolve
 * the effective background behind a glyph, so it reports the check as incomplete
 * and passes. That leaves the most common accessibility defect in a dark interface
 * untested, which is the wrong thing to leave untested.
 *
 * So the palette is measured directly: read the tokens out of the two stylesheets,
 * composite the translucent ones over the ground they sit on, pair each foreground
 * with the background it is actually used against, and assert the WCAG AA ratio.
 * This runs everywhere, needs no browser, covers both themes, and fails when
 * somebody nudges a token from a value that was chosen to one that is merely
 * pleasant. A just-over-the-line ratio is printed, not hidden, so a slow drift
 * towards the boundary is visible in the log before it becomes a failure.
 */

const SRC = join(__dirname, '..', 'src');
const appCss = readFileSync(join(SRC, 'styles.css'), 'utf8');
const landingCss = readFileSync(join(SRC, 'landing.css'), 'utf8');

type Tokens = Record<string, string>;
type Rgb = [number, number, number];
interface Colour {
  rgb: Rgb;
  alpha: number;
}

/**
 * Every `{ … }` in a stylesheet that declares custom properties.
 *
 * Bodies are matched without descending into nested ones, which is enough here: a
 * palette lives in a flat block, and the light theme is one such block inside a
 * `prefers-color-scheme` query.
 */
function tokenBlocks(css: string): Tokens[] {
  const blocks: Tokens[] = [];
  for (const match of css.matchAll(/\{([^{}]*)\}/g)) {
    const body = match[1];
    if (!body.includes('--')) continue;
    const tokens: Tokens = {};
    for (const declaration of body.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
      tokens[declaration[1]] = declaration[2].trim();
    }
    if (Object.keys(tokens).length > 0) blocks.push(tokens);
  }
  return blocks;
}

function parseColour(value: string): Colour | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (hex) {
    const digits = hex[1];
    const full = digits.length === 3 ? digits.replace(/./g, (digit) => digit + digit) : digits;
    return {
      rgb: [
        Number.parseInt(full.slice(0, 2), 16),
        Number.parseInt(full.slice(2, 4), 16),
        Number.parseInt(full.slice(4, 6), 16),
      ],
      alpha: 1,
    };
  }
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)$/i.exec(value.trim());
  if (!rgb) return null;
  return {
    rgb: [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])],
    alpha: rgb[4] === undefined ? 1 : Number(rgb[4]),
  };
}

/** What a translucent colour looks like once it is over a solid one. */
const over = (top: Colour, base: Rgb): Rgb =>
  top.rgb.map((channel, index) => channel * top.alpha + base[index] * (1 - top.alpha)) as Rgb;

/**
 * A colour reader for one stylesheet.
 *
 * Aliases are followed across the file rather than inside a single block, because
 * the base palette (`--pearl`, `--ink`, `--blue`) is declared once and referred to
 * from both themes: `--text` is `var(--pearl)` in one and `var(--ink)` in the other.
 * The block under test still wins, so a theme can override a token.
 */
function makeReader(blocks: Tokens[]): (block: Tokens, name: string) => Colour {
  const definitions: Tokens = Object.assign({}, ...blocks);
  return (block, name) => {
    // The block first, then the file: the shared palette is declared once, above
    // the themes, and either theme may refer to it by name.
    let value: string | undefined = block[name] ?? definitions[name];
    for (let hop = 0; hop < 4; hop += 1) {
      // Annotated, not inferred: `value` is reassigned from `definitions[alias[1]]`
      // below, so an inferred `alias` is circular as far as TypeScript is concerned
      // (TS7022) and the whole reader decays to `any`.
      const alias: RegExpExecArray | null =
        value === undefined ? null : /^var\(--([a-z0-9-]+)\)$/i.exec(value.trim());
      if (!alias) break;
      value = definitions[alias[1]];
    }
    const parsed = value === undefined ? null : parseColour(value);
    if (!parsed) {
      throw new Error(`token --${name} resolves to ${String(value)}, which is not a colour this test can measure`);
    }
    return parsed;
  };
}

const appBlocks = tokenBlocks(appCss);
const landingBlocks = tokenBlocks(landingCss);

const dark = appBlocks.find((block) => block['bg'] !== undefined);
const light = [...appBlocks].reverse().find((block) => block['bg'] !== undefined);
const landing = landingBlocks.find((block) => block['l-ink'] !== undefined);
if (!dark || !light || !landing) throw new Error('could not find the palettes in the stylesheets');

/** A foreground has to be opaque: a translucent one has no single ratio. */
const solid = (colour: Colour, name: string): Rgb => {
  if (colour.alpha !== 1) throw new Error(`--${name} is translucent, so it cannot be measured as text`);
  return colour.rgb;
};

/**
 * The live pill tints its own background with its own colour, so the text on it is
 * measured against that tint rather than against the bare ground: a tint of the
 * same hue is exactly where a contrast ratio goes to die.
 */
const tint = (colour: Colour, alpha: number, base: Rgb): Rgb => over({ rgb: colour.rgb, alpha }, base);

const appColour = makeReader(appBlocks);
const landingColour = makeReader(landingBlocks);

const darkGround = appColour(dark, 'bg').rgb;
const lightGround = appColour(light, 'bg').rgb;
const inkGround = landingColour(landing, 'l-ink').rgb;

const onDarkSurface = (name: string): Rgb => over(appColour(dark, name), darkGround);
const onDarkText = (name: string): Rgb => solid(appColour(dark, name), name);
const onLightSurface = (name: string): Rgb => over(appColour(light, name), lightGround);
const onLightText = (name: string): Rgb => solid(appColour(light, name), name);
const onInkText = (name: string): Rgb => solid(landingColour(landing, name), name);
const onInkSurface = (name: string): Rgb => over(landingColour(landing, name), inkGround);

const channel = (value: number): number => {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

const luminance = ([r, g, b]: Rgb): number => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

const contrast = (a: Rgb, b: Rgb): number => {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

const AA_TEXT = 4.5;
/** Icons, borders that carry meaning, and other non-text indicators. */
const AA_UI = 3;

/** The primary action's label sits on a gradient: measured at its darkest stop. */
const BUTTON_LABEL: Rgb = [0x05, 0x07, 0x0f];
const BUTTON_DARKEST_STOP: Rgb = [0xbe, 0xd1, 0xff];

const pairs: Array<{ what: string; fg: Rgb; bg: Rgb; min: number }> = [
  { what: 'dark: body text on the ground', fg: onDarkText('text'), bg: darkGround, min: AA_TEXT },
  { what: 'dark: muted support copy', fg: onDarkText('muted'), bg: darkGround, min: AA_TEXT },
  { what: 'dark: links and field focus', fg: onDarkText('accent'), bg: darkGround, min: AA_TEXT },
  {
    what: 'dark: the live indicator in words',
    fg: onDarkText('live'),
    bg: tint(appColour(dark, 'live'), 0.09, darkGround),
    min: AA_TEXT,
  },
  { what: 'dark: error copy', fg: onDarkText('bad'), bg: darkGround, min: AA_TEXT },
  { what: 'dark: the warning banner', fg: onDarkText('warn-fg'), bg: onDarkSurface('warn-bg'), min: AA_TEXT },
  { what: 'dark: the primary action label', fg: BUTTON_LABEL, bg: BUTTON_DARKEST_STOP, min: AA_TEXT },
  // The boundary of a control, which is the one boundary WCAG asks to be visible.
  { what: 'dark: a control boundary', fg: onDarkSurface('line-control'), bg: darkGround, min: AA_UI },

  { what: 'light: body text on pearl', fg: onLightText('text'), bg: lightGround, min: AA_TEXT },
  { what: 'light: muted support copy', fg: onLightText('muted'), bg: lightGround, min: AA_TEXT },
  { what: 'light: links and field focus', fg: onLightText('accent'), bg: lightGround, min: AA_TEXT },
  {
    what: 'light: the live indicator in words',
    fg: onLightText('live'),
    bg: tint(appColour(light, 'live'), 0.09, lightGround),
    min: AA_TEXT,
  },
  { what: 'light: error copy', fg: onLightText('bad'), bg: lightGround, min: AA_TEXT },
  { what: 'light: the warning banner', fg: onLightText('warn-fg'), bg: onLightSurface('warn-bg'), min: AA_TEXT },
  { what: 'light: a control boundary', fg: onLightSurface('line-control'), bg: lightGround, min: AA_UI },

  { what: 'landing: body text', fg: onInkText('l-text'), bg: inkGround, min: AA_TEXT },
  { what: 'landing: muted copy', fg: onInkText('l-muted'), bg: inkGround, min: AA_TEXT },
  { what: 'landing: blue as text', fg: onInkText('l-blue-text'), bg: inkGround, min: AA_TEXT },
  { what: 'landing: violet as text', fg: onInkText('l-violet-text'), bg: inkGround, min: AA_TEXT },
  { what: 'landing: the live dot', fg: onInkSurface('l-cyan'), bg: inkGround, min: AA_UI },
];

describe('the palettes, measured', () => {
  for (const pair of pairs) {
    it(`${pair.what} reaches ${pair.min}:1`, () => {
      const measured = contrast(pair.fg, pair.bg);
      console.log(`  ${measured.toFixed(2)}:1  ${pair.what}`);
      expect(measured).toBeGreaterThanOrEqual(pair.min);
    });
  }

  it('keeps the literals this test measures inside the stylesheet', () => {
    // That pair is written as literals because it comes from a gradient rather than
    // a token. If the gradient changes, this test is measuring something that is no
    // longer there, so it has to fail loudly instead of passing on a stale fact.
    expect(appCss).toContain('#bed1ff');
    expect(appCss).toContain('#05070f');
  });

  it('uses one palette across the two stylesheets rather than two that drifted', () => {
    // The landing page has its own file, so its accents can silently diverge from
    // the app's. They are the same product: the blue and the violet have to be the
    // same blue and violet, compared as values rather than as token names. The named
    // palette lives in its own block, above the themes that use it.
    const palette = appBlocks.find((block) => block['blue'] !== undefined);
    expect(palette).toBeDefined();
    expect(landing['l-blue']).toBe(palette?.['blue']);
    expect(landing['l-violet']).toBe(palette?.['violet']);
    // And the app's own two blues are one colour: one for text, one for fills.
    expect(appColour(dark, 'accent-solid').rgb).toEqual(appColour(dark, 'blue').rgb);
  });

  it('defines every custom property each stylesheet uses', () => {
    // A renamed or misspelled token is not a compile error: it is a property that
    // silently resolves to nothing, which is how the ambient wash behind the console
    // spent its whole life invisible. Each file is checked, and the landing's `l-`
    // scope means a reference to the app's tokens is caught rather than excused.
    const scopes: Array<[string, string, string]> = [
      ['styles.css', appCss, ''],
      ['landing.css', landingCss, 'l-'],
    ];
    for (const [name, css, prefix] of scopes) {
      const defined = new Set([...css.matchAll(/--([a-z0-9-]+)\s*:/gi)].map((match) => match[1]));
      const orphans = [...css.matchAll(/var\(--([a-z0-9-]+)/gi)]
        .map((match) => match[1])
        .filter((token) => token.startsWith(prefix) && !defined.has(token));
      expect(orphans, `${name} uses custom properties it never defines`).toEqual([]);
    }
  });
});
