import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Contrast, computed from the stylesheets rather than eyeballed in a browser.
 *
 * `axe` cannot check contrast in jsdom: the rule needs a real renderer to resolve
 * the effective background behind a glyph, so it reports the check as incomplete
 * and passes. That leaves the most common accessibility defect in a themed interface
 * untested, which is the wrong thing to leave untested.
 *
 * So the palette is measured directly: read the tokens out of the two stylesheets,
 * composite the translucent ones over the ground they sit on, pair each foreground
 * with the background it is actually used against, and assert the WCAG AA ratio.
 * This runs everywhere, needs no browser, covers both of the workspace's materials
 * and both of the landing page's, and fails when somebody nudges a token from a
 * value that was chosen to one that is merely pleasant. A just-over-the-line ratio
 * is printed, not hidden, so a slow drift towards the boundary is visible in the log
 * before it becomes a failure.
 *
 * The two stylesheets hold one palette between them, and that is asserted here as
 * values rather than trusted as a convention: the landing page and the workspace may
 * not drift into two oranges that were once the same orange.
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
 * palette lives in a flat block, and each material is one such block.
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
 * the base palette (`--primary`, `--paper`, `--surface`) is declared once and
 * referred to from every material: `--text` is `var(--ink)` on the paper and
 * `var(--text-on-surface)` on the surface. The block under test still wins, so a
 * material can override a token without the reader resolving the other one's.
 */
function makeReader(blocks: Tokens[]): (block: Tokens, name: string) => Colour {
  const definitions: Tokens = Object.assign({}, ...blocks);
  return (block, name) => {
    // The block first, then the file: the shared palette is declared once, above
    // the materials, and either material may refer to it by name.
    let value: string | undefined = block[name] ?? definitions[name];
    for (let hop = 0; hop < 5; hop += 1) {
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

/**
 * The four palettes.
 *
 * The workspace is made of two materials, so it has two: the paper and the surface.
 * Each is found by what it says its own background is — the block whose `--bg` is
 * `var(--paper)` is the ground, and the one whose `--bg` is `var(--surface)` is the
 * other material — rather than by position in the file, so moving either of them
 * around is not a test failure.
 */
const palette = appBlocks.find((block) => block['primary'] !== undefined);
const ground = appBlocks.find((block) => block['bg'] === 'var(--paper)');
const surface = appBlocks.find((block) => block['bg'] === 'var(--surface)');
const landing = landingBlocks.find((block) => block['l-bg'] !== undefined);
if (!palette || !ground || !surface || !landing) {
  throw new Error('could not find the palettes in the stylesheets');
}

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

const groundBase = appColour(ground, 'bg').rgb;
const surfaceBase = appColour(surface, 'bg').rgb;
/**
 * The landing page is made of the same two materials, and each pair below says which
 * one it is measured on: the light ground (`--l-bg`, the sheets a reader reads) and
 * the dark surface (`--l-surface`, the stage and the footer). Measuring a token
 * against the wrong one is how a palette passes here and fails in a browser.
 */
const landingGround = landingColour(landing, 'l-bg').rgb;
const landingSurface = landingColour(landing, 'l-surface').rgb;

/** Paper roles. */
const onGround = (name: string): Rgb => over(appColour(ground, name), groundBase);
const groundText = (name: string): Rgb => solid(appColour(ground, name), name);
/** Surface roles, which are the surface material's own values. */
const onSurface = (name: string): Rgb => over(appColour(surface, name), surfaceBase);
const surfaceText = (name: string): Rgb => solid(appColour(surface, name), name);
/** The landing page's two materials. */
const landingText = (name: string): Rgb => solid(landingColour(landing, name), name);
const onLandingGround = (name: string): Rgb => over(landingColour(landing, name), landingGround);
const onLandingSurface = (name: string): Rgb => over(landingColour(landing, name), landingSurface);

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
/** Display type — 150px headlines — which WCAG measures against the smaller floor. */
const AA_LARGE = 3;

const pairs: Array<{ what: string; fg: Rgb; bg: Rgb; min: number }> = [
  { what: 'paper: body text on the ground', fg: groundText('text'), bg: groundBase, min: AA_TEXT },
  { what: 'paper: muted support copy', fg: groundText('muted'), bg: groundBase, min: AA_TEXT },
  { what: 'paper: links and field focus', fg: groundText('accent'), bg: groundBase, min: AA_TEXT },
  {
    what: 'paper: the live indicator in words',
    fg: groundText('live'),
    bg: tint(appColour(ground, 'live'), 0.09, groundBase),
    min: AA_TEXT,
  },
  { what: 'paper: error copy', fg: groundText('bad'), bg: groundBase, min: AA_TEXT },
  { what: 'paper: the warning banner', fg: groundText('warn-fg'), bg: onGround('warn-bg'), min: AA_TEXT },
  {
    what: 'paper: the primary action label',
    fg: groundText('on-accent'),
    bg: over(appColour(ground, 'accent-solid'), groundBase),
    min: AA_TEXT,
  },
  // The boundary of a control, which is the one boundary WCAG asks to be visible.
  { what: 'paper: a control boundary', fg: onGround('line-control'), bg: groundBase, min: AA_UI },

  { what: 'surface: body text on the material', fg: surfaceText('text'), bg: surfaceBase, min: AA_TEXT },
  { what: 'surface: muted support copy', fg: surfaceText('muted'), bg: surfaceBase, min: AA_TEXT },
  { what: 'surface: links and field focus', fg: surfaceText('accent'), bg: surfaceBase, min: AA_TEXT },
  {
    what: 'surface: the live indicator in words',
    fg: surfaceText('live'),
    bg: tint(appColour(surface, 'live'), 0.09, surfaceBase),
    min: AA_TEXT,
  },
  { what: 'surface: error copy', fg: surfaceText('bad'), bg: surfaceBase, min: AA_TEXT },
  { what: 'surface: success copy', fg: surfaceText('ok'), bg: surfaceBase, min: AA_TEXT },
  { what: 'surface: the warning banner', fg: surfaceText('warn-fg'), bg: onSurface('warn-bg'), min: AA_TEXT },
  { what: 'surface: a control boundary', fg: onSurface('line-control'), bg: surfaceBase, min: AA_UI },

  { what: 'landing: body text on the ground', fg: landingText('l-text'), bg: landingGround, min: AA_TEXT },
  { what: 'landing: muted copy on the ground', fg: landingText('l-muted'), bg: landingGround, min: AA_TEXT },
  { what: 'landing: the primary as type', fg: landingText('l-primary-text'), bg: landingGround, min: AA_TEXT },
  {
    what: 'landing: the primary action label',
    fg: landingText('l-on-primary'),
    bg: landingText('l-primary'),
    min: AA_TEXT,
  },
  // The hero's two 150px lines run from ink to the primary, so this is the lightest
  // stop of that gradient: display type, held to the large-text floor rather than to
  // the paragraph one, which is exactly why the treatment stops at the headlines.
  { what: 'landing: the display headline, at its lightest stop', fg: landingText('l-primary'), bg: landingGround, min: AA_LARGE },
  { what: 'landing: a control boundary on the ground', fg: onLandingGround('l-line-control'), bg: landingGround, min: AA_UI },

  { what: 'landing: type on the surface', fg: landingText('l-on-surface'), bg: landingSurface, min: AA_TEXT },
  { what: 'landing: muted type on the surface', fg: landingText('l-muted-on-surface'), bg: landingSurface, min: AA_TEXT },
  { what: 'landing: the live dot on the surface', fg: landingText('l-accent'), bg: landingSurface, min: AA_UI },
  { what: 'landing: a control boundary on the surface', fg: onLandingSurface('l-line-control-on-surface'), bg: landingSurface, min: AA_UI },
];

describe('the palettes, measured', () => {
  for (const pair of pairs) {
    it(`${pair.what} reaches ${pair.min}:1`, () => {
      const measured = contrast(pair.fg, pair.bg);
      console.log(`  ${measured.toFixed(2)}:1  ${pair.what}`);
      expect(measured).toBeGreaterThanOrEqual(pair.min);
    });
  }

  it('anchors the brand values rather than ones that drifted', () => {
    // The palette is the requirement: primary #ea580c, secondary #ffffff, accent
    // #fdba74, background #ffffff, surface #191c21, type #111827. Compared as values,
    // so a nudge towards a colour that merely looked pleasant fails here instead of
    // shipping.
    expect(palette['primary']).toBe('#ea580c');
    expect(palette['peach']).toBe('#fdba74');
    expect(palette['paper']).toBe('#ffffff');
    expect(palette['surface']).toBe('#191c21');
    expect(palette['ink']).toBe('#111827');
    expect(palette['on-primary']).toBe('#111827');
    // And the roles are the palette's values rather than a second set of literals:
    // a primary that is not the brand value is the defect this catches.
    expect(ground['bg']).toBe('var(--paper)');
    expect(ground['accent-solid']).toBe('var(--primary)');
    expect(ground['on-accent']).toBe('var(--on-primary)');
    expect(surface['bg']).toBe('var(--surface)');
    expect(surface['text']).toBe('var(--text-on-surface)');
  });

  it('carries one palette across the landing page and the workspace', () => {
    // The realistic defect when a palette changes is a stale colour left behind in a
    // token or, worse, in a rule: a hover border still painted in the old blue. The
    // landing page is a separate stylesheet on purpose (its scene and its type are
    // another chunk), so the two are compared value by value rather than assumed to
    // agree, and nothing from the palette this replaced may survive in either file.
    expect(landing['l-primary']).toBe(palette['primary']);
    expect(landing['l-accent']).toBe(palette['peach']);
    expect(landing['l-bg']).toBe(palette['paper']);
    expect(landing['l-surface']).toBe(palette['surface']);
    expect(landing['l-text']).toBe(palette['ink']);
    expect(landing['l-on-primary']).toBe(palette['on-primary']);
    for (const stray of ['#2a5bff', '#6f95ff', '#7b4dff', '#1cc7d0', '42, 91, 255', '123, 77, 255', '28, 199, 208', '#8e8e96', '#f3f2ee', '#07070a', '#cfe0ff', '#bed1ff']) {
      expect(appCss.toLowerCase(), `styles.css still carries ${stray}`).not.toContain(stray);
      expect(landingCss.toLowerCase(), `landing.css still carries ${stray}`).not.toContain(stray);
    }
  });

  it('re-binds every role the surface borrows, so nothing inside it reads the ground', () => {
    // This is the defect this codebase has already shipped once: `styles.css` styles
    // `h1, h2, h3, h4` globally with `color: var(--text)`, and a heading inside a dark
    // region that never re-bound `--text` came out near-black on near-black. Every
    // colour role a rule in this file can read is therefore listed here, and the dark
    // material has to answer for all of them.
    const roles = [
      'bg',
      'bg-deep',
      'panel',
      'panel-2',
      'panel-solid',
      'line',
      'line-strong',
      'line-control',
      'text',
      'muted',
      'accent',
      'accent-solid',
      'live',
      'ok',
      'bad',
      'warn-fg',
      'warn-bg',
      'warn-line',
      'sheen',
      'scrim',
      'shadow',
      'glow',
    ];
    for (const role of roles) {
      expect(surface[role], `.surface does not re-bind --${role}`).toBeDefined();
    }
    // The primary's label is the one role that is the same on both materials, because
    // it is a label on the orange rather than a colour of the material.
    expect(surface['accent-solid']).toBe('var(--primary)');
  });

  it('makes the landing page say what colour its own headings are', () => {
    // A leak, not a typo, and the reason this assertion is here rather than in the
    // landing page's own test: `styles.css` styles `h1, h2, h3, h4` globally with
    // `color: var(--text)`, which is ink on a near-black ground for any heading the
    // landing page does not answer for itself.
    expect(appCss).toMatch(/h1,\s*h2,\s*h3,\s*h4\s*\{[^}]*color:\s*var\(--text\)/);
    expect(landingCss).toMatch(/\.landing h1,\s*\.landing h2,\s*\.landing h3\s*\{\s*color:\s*inherit;/);
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
