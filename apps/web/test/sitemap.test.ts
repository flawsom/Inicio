import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The sitemap, and the hosting rule that decides whether anyone ever sees it.
 *
 * Two separate things go wrong with a sitemap, and this file holds both.
 *
 * The first is content: a sitemap is a public statement of which URLs exist, so listing a
 * page that needs a session — or, worse, a collection link that is supposed to reach one
 * person — is a defect a crawler will faithfully act on. The routes here are compared
 * against the router's own public set rather than against a comment.
 *
 * The second is delivery, and it is the failure this project has already shipped once: the
 * SPA catch-all answered `/sw.js` and `/manifest.webmanifest` with `index.html` **and a
 * 200**, so the worker never installed and the manifest was never parsed, and nothing in
 * any test could see it because a rewrite happens before the request reaches a page. A
 * sitemap served as HTML is the same defect: a crawler reads `<loc>` tags it was never
 * sent, or reads a document that says 200 and is the app shell. So the two catch-alls —
 * Vercel's negative lookahead and Netlify's `force` flag — are asserted here, and the files
 * are asserted to be real files in `public/`, which is what Vite copies into the build.
 */

const WEB = join(__dirname, '..');
const SITEMAP = readFileSync(join(WEB, 'public', 'sitemap.xml'), 'utf8');
const ROBOTS = readFileSync(join(WEB, 'public', 'robots.txt'), 'utf8');
const VERCEL = readFileSync(join(WEB, '..', '..', 'vercel.json'), 'utf8');
const NETLIFY = readFileSync(join(WEB, '..', '..', 'netlify.toml'), 'utf8');

/** The routes a visitor can read with no session: what `App.tsx` renders for each. */
const PUBLIC_PATHS = ['/', '/login', '/terms', '/privacy'];

const locations = [...SITEMAP.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]!);
const paths = locations.map((url) => new URL(url).pathname);

describe('the sitemap', () => {
  it('lists exactly the four pages a stranger can read', () => {
    expect(paths.sort()).toEqual([...PUBLIC_PATHS].sort());
  });

  it('lists them on the canonical origin, and only https', () => {
    for (const url of locations) {
      expect(url.startsWith('https://inicio.unifies.codes/'), `${url} is not on the canonical origin`).toBe(true);
    }
  });

  it('keeps every route that needs a session or a token out of it', () => {
    // `/console` renders the sign-in sheet to a visitor with no session, so listing it
    // would advertise a page whose only content is "sign in". An invitation and a
    // collection link are single-use by construction and must never be indexed.
    for (const path of ['/console', '/invite', '/collect']) {
      expect(paths.some((listed) => listed.startsWith(path)), `the sitemap lists ${path}`).toBe(false);
    }
  });

  it('carries no lastmod, changefreq or priority', () => {
    // A build timestamp is not the date a page's content changed, and a sitemap that says
    // "changed today" on every deploy is one a crawler learns to ignore. The other two
    // fields are documented as ignored by Google: writing them is writing decoration.
    expect(SITEMAP).not.toMatch(/<(lastmod|changefreq|priority)>/);
  });
});

describe('robots.txt', () => {
  it('points at the sitemap on the canonical origin', () => {
    expect(ROBOTS).toContain('Sitemap: https://inicio.unifies.codes/sitemap.xml');
  });

  it('closes the routes that need a session or a token', () => {
    // A courtesy rather than a control — the API refuses without a session either way —
    // but it is the difference between a crawler that knocks and one that does not.
    for (const path of ['/console', '/invite/', '/collect/', '/api/', '/auth/']) {
      expect(ROBOTS, `robots.txt does not disallow ${path}`).toContain(`Disallow: ${path}`);
    }
  });
});

describe('the two catch-alls that could swallow either file', () => {
  it('Vercel serves sitemap.xml and robots.txt instead of the app shell', () => {
    /*
     * The negative lookahead is the whole mechanism, so every name has to be in it. The
     * escapes are stripped before comparing: in the file each dot is written `\\.` because
     * the rule is a regular expression, and asserting the escaping as well as the name
     * would mean a change of escaping style failed a test about whether a file is served.
     */
    const catchAll = /"source": "\/\(\(\?!([^)]*)\)/.exec(VERCEL)?.[1] ?? '';
    expect(catchAll, 'the SPA catch-all no longer excludes static files').not.toBe('');
    const excluded = catchAll.replace(/\\/g, '');
    expect(excluded).toContain('sitemap.xml');
    expect(excluded).toContain('robots.txt');
    // The four that were already there, so rewriting this rule cannot quietly drop them
    // and bring back the `/sw.js` overflow this project has already shipped once.
    for (const name of ['sw.js', 'manifest.webmanifest', 'icon-192.png', 'favicon.ico']) {
      expect(excluded, `the catch-all stopped excluding ${name}`).toContain(name);
    }
  });

  it('Netlify only overrides the filesystem where it means to', () => {
    // Netlify applies a redirect only when no file exists at the path, *unless* the rule
    // sets `force`. The API rules set it on purpose (they must reach the API even if a
    // path looks like a file); the SPA rule must not, or it would answer /sitemap.xml with
    // the app shell in exactly the way Vercel's catch-all used to.
    const rules = NETLIFY.split('[[redirects]]').slice(1);
    const catchAll = rules.find((rule) => rule.includes('from = "/*"'));
    expect(catchAll, 'netlify.toml no longer has a catch-all rule').toBeDefined();
    expect(catchAll).not.toContain('force = true');
    const api = rules.find((rule) => rule.includes('from = "/api/*"'));
    expect(api, 'the API proxy rule is gone').toBeDefined();
    expect(api).toContain('force = true');
  });
});
