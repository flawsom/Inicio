import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The shell's fixed layers and the form's question blocks must not share a class name.
 *
 * This is a regression guard for a real breakage that no other test in this suite
 * could see. The ambient light field behind the signed-in app is a fixed, full
 * viewport, `z-index: -1`, `pointer-events: none` layer. A question in a form is a
 * block inside a card. Both were called `.field`, so on every collection page each
 * question inherited the ambient layer's box: a full-viewport, invisible, unclickable
 * element stacked at the origin. The markup was correct, the API answered correctly,
 * the harnesses drove the API directly — and the form a respondent opened was
 * unusable. Nothing in a jsdom test can observe that, because jsdom does not apply a
 * stylesheet, so the rule is asserted here, against the stylesheet itself.
 *
 * The assertions are deliberately about the *properties* rather than about one class
 * name, so the guard keeps working if either side is renamed: what must never be true
 * is that the class a question block wears is also a fixed layer behind the page.
 */

const SRC = join(__dirname, '..', 'src');
const css = readFileSync(join(SRC, 'styles.css'), 'utf8');
const app = readFileSync(join(SRC, 'App.tsx'), 'utf8');
const respondent = readFileSync(join(SRC, 'respondent.tsx'), 'utf8');

/**
 * Every declaration block whose selector list uses `selector`, either on its own or
 * qualified — `.field`, `.field:hover`, `.ambient canvas`, `.ambient.ready canvas`.
 */
function rules(selector: string): string[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const found: string[] = [];
  for (const match of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const parts = (match[1] ?? '').split(',').map((part) => part.trim());
    if (parts.some((part) => part === selector || part.startsWith(`${selector} `) || part.startsWith(`${selector}.`) || part.startsWith(`${selector}:`))) {
      found.push(match[2] ?? '');
    }
  }
  return found;
}

describe('the shell layers and the form', () => {
  it('keeps the ambient layer out of the flow, and the question block in it', () => {
    // The ambient host is the layer the canvas is mounted into, and it is the one
    // thing on the page allowed to be fixed behind everything.
    expect(app).toContain('className="ambient"');
    const ambient = rules('.ambient').join(' ');
    expect(ambient).toContain('position: fixed');
    expect(ambient).toContain('pointer-events: none');

    // A question block is a block: it may have margin and nothing else that could
    // take it out of the card it belongs to.
    const field = rules('.field').join(' ');
    expect(field).toContain('margin-bottom');
    for (const property of ['position', 'inset', 'z-index', 'pointer-events', 'opacity']) {
      expect(field, `.field must not set ${property}`).not.toContain(property);
    }
  });

  it('keeps the pointer trail a fixed, click-through layer on every route', () => {
    /*
     * The trail is mounted by the shell for every route, so its rule has to live in the
     * stylesheet every route loads rather than in `landing.css`, which arrives with the
     * marketing chunk. A canvas with no rule is not invisible — it is an unstyled 300x150
     * box in the flow of whatever page it lands on — so this is the difference between a
     * decoration and a defect on five of the six routes.
     */
    expect(app).toContain('<CursorTrail />');
    expect(app).not.toContain('cursor-ring');
    const trail = rules('.cursor-trail').join(' ');
    expect(trail).toContain('position: fixed');
    expect(trail).toContain('pointer-events: none');
    expect(trail).toContain('z-index');
    // Hidden outright for a reader who asked for less motion, so a chunk that has not
    // loaded cannot leave it painted.
    expect(css).toContain('.cursor-trail { display: none; }');
    // And not in the landing stylesheet, where it used to be: that stylesheet is only
    // fetched by one route, and it no longer names the layer at all.
    expect(readFileSync(join(SRC, 'landing.css'), 'utf8')).not.toContain('lcursor');
  });

  it('still uses that class for the question the respondent answers', () => {
    // The guard above is only meaningful while the form really does use `.field`:
    // renaming the form's class away would otherwise let both assertions pass while
    // the two names met again somewhere else.
    expect(respondent).toContain('className="field"');
    expect(respondent).toContain("className=\"choices\"");
  });
});
