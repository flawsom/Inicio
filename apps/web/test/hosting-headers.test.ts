import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The two front doors, held to one set of headers.
 *
 * Production is Vercel; `netlify.toml` is the prepared second front door. They are edited
 * separately, which is exactly how one host keeps a protection the other loses: the
 * audit that added these headers had to add them twice, and a later change can remove
 * one copy without any browser noticing until traffic moves.
 *
 * This compares the committed policies, not a live Netlify site. It cannot prove Netlify
 * applies the rules; it proves the rules say the same thing before a deploy can diverge.
 */

const ROOT = join(__dirname, '..', '..', '..');
const VERCEL = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8')) as {
  headers?: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
};
const NETLIFY = readFileSync(join(ROOT, 'netlify.toml'), 'utf8');

interface NetlifyRule {
  for: string;
  values: Record<string, string>;
}

/** The `[[headers]]` blocks, which are simple enough not to need a TOML dependency. */
function netlifyHeaderRules(text: string): NetlifyRule[] {
  const rules: NetlifyRule[] = [];
  let current: NetlifyRule | null = null;
  let inValues = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line === '[[headers]]') {
      current = { for: '', values: {} };
      rules.push(current);
      inValues = false;
      continue;
    }
    if (!current) continue;
    if (line === '[headers.values]') {
      inValues = true;
      continue;
    }
    if (line.startsWith('[')) {
      inValues = false;
      continue;
    }
    const pair = /^([A-Za-z-]+)\s*=\s*(.+)$/.exec(line);
    if (!pair) continue;
    let value: string;
    try {
      value = JSON.parse(pair[2]!);
    } catch {
      continue;
    }
    if (!inValues && pair[1] === 'for') current.for = value;
    else if (inValues) current.values[pair[1]!] = value;
  }
  return rules;
}

const vercelRules = VERCEL.headers ?? [];
const netlifyRules = netlifyHeaderRules(NETLIFY);

function vercelValues(source: string): Record<string, string> {
  const rule = vercelRules.find((entry) => entry.source === source);
  expect(rule, `vercel.json has no header rule for ${source}`).toBeDefined();
  return Object.fromEntries(rule!.headers.map((header) => [header.key.toLowerCase(), header.value]));
}

function netlifyValues(path: string): Record<string, string> {
  const rule = netlifyRules.find((entry) => entry.for === path);
  expect(rule, `netlify.toml has no header rule for ${path}`).toBeDefined();
  return Object.fromEntries(Object.entries(rule!.values).map(([key, value]) => [key.toLowerCase(), value]));
}

describe('the hosting header policies agree', () => {
  it('gives the document the same security headers on both hosts', () => {
    // Vercel's document rule is the negative lookahead that excludes API and static files.
    const vercelDocument = vercelRules.find((entry) => entry.source.startsWith('/((?!'));
    expect(vercelDocument, 'vercel.json no longer has a document header rule').toBeDefined();
    const vercel = Object.fromEntries(
      vercelDocument!.headers.map((header) => [header.key.toLowerCase(), header.value]),
    );
    const netlify = netlifyValues('/*');

    expect(vercel['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(vercel).toEqual(netlify);
  });

  it('caches hashed assets immutably on both hosts', () => {
    expect(vercelValues('/assets/(.*)')['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(netlifyValues('/assets/*')['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('lets the service worker replace itself on both hosts', () => {
    expect(vercelValues('/sw.js')['cache-control']).toBe('public, max-age=0, must-revalidate');
    expect(netlifyValues('/sw.js')['cache-control']).toBe('public, max-age=0, must-revalidate');
  });

  it('gives the manifest the same short cache on both hosts', () => {
    expect(vercelValues('/manifest.webmanifest')['cache-control']).toBe('public, max-age=3600');
    expect(netlifyValues('/manifest.webmanifest')['cache-control']).toBe('public, max-age=3600');
  });
});
