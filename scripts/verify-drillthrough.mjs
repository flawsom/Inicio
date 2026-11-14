#!/usr/bin/env node
/**
 * Verify the drillthrough wiring of the built PBIP, beyond what the validator checks:
 *  1. every Drillthrough button points at a page marked type Drillthrough;
 *  2. that page's pageBinding parameter's boundFilter matches a filter whose
 *     howCreated is "Drillthrough", and both name the SAME field as the binding;
 *  3. on the page that carries the button, at least one visual projects that field
 *     (otherwise the button can never enable - a selection must carry the field);
 *  4. the drillthrough field exists in the semantic model.
 *
 * Usage: node scripts/verify-drillthrough.mjs [project]   (default reports/power-bi/oracura)
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const projectDir = resolve(ROOT, process.argv[2] ?? 'reports/power-bi/oracura');
const REPORT = join(projectDir, 'ORACURA.Report', 'definition', 'pages');
const TABLES = join(projectDir, 'ORACURA.SemanticModel', 'definition', 'tables');

const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const pages = read(join(REPORT, 'pages.json'));
const pageDir = (id) => join(REPORT, id);
const readPage = (id) => read(join(pageDir(id), 'page.json'));
const visualsOf = (id) => {
  const dir = join(pageDir(id), 'visuals');
  const out = [];
  if (!existsSync(dir)) return out;
  for (const v of require_readdir(dir)) out.push(read(join(dir, v, 'visual.json')));
  return out;
};
import { readdirSync } from 'node:fs';
const require_readdir = (d) => readdirSync(d);

let failures = 0;
const fail = (m) => { failures += 1; console.error(`FAIL - ${m}`); };
const pass = (m) => console.log(`ok   - ${m}`);

// The semantic model's columns (Property names), for check 4.
const modelProps = new Set();
if (existsSync(TABLES)) {
  for (const f of readdirSync(TABLES)) {
    const t = readFileSync(join(TABLES, f), 'utf8');
    for (const m of t.matchAll(/^\t(column|measure)\s+(?:'([^']+)'|(\S+))/gm)) modelProps.add(m[2] ?? m[3]);
  }
}

// Drillthrough pages and their declared field.
const dtPages = new Map();
for (const id of pages.pageOrder ?? []) {
  const pj = readPage(id);
  if (pj.type !== 'Drillthrough') continue;
  const field = pj.pageBinding?.parameters?.[0]?.fieldExpr?.Column?.Property;
  const filter = pj.filterConfig?.filters?.find((f) => f.howCreated === 'Drillthrough');
  if (!filter) { fail(`${pj.displayName}: pageBinding/filterConfig mismatch - no howCreated Drillthrough filter`); continue; }
  if (pj.pageBinding.parameters[0].boundFilter !== filter.name) { fail(`${pj.displayName}: boundFilter does not reference the drillthrough filter`); continue; }
  if (filter.field?.Column?.Property !== field) { fail(`${pj.displayName}: filter field and binding field disagree`); continue; }
  if (modelProps.size && !modelProps.has(field)) { fail(`${pj.displayName}: drillthrough field ${field} not in the model`); continue; }
  dtPages.set(id, { name: pj.displayName, field });
  pass(`${pj.displayName}: drillthrough binding intact (field ${field}, filter ${filter.name})`);
}
if (!dtPages.size) fail('no drillthrough page found at all');

// Every Drillthrough button: target is a drillthrough page, and the button's own
// page projects the field (else the button can never enable).
for (const id of pages.pageOrder ?? []) {
  const pj = readPage(id);
  for (const v of visualsOf(id)) {
    const link = v.visual?.visualContainerObjects?.visualLink?.[0]?.properties;
    if (!link) continue;
    const type = String(link.type?.expr?.Literal?.Value ?? '').replace(/^'|'$/g, '');
    if (type !== 'Drillthrough') continue;
    // Companion key per action type: `drillthroughSection` for Drillthrough
    // (Microsoft spec), `navigationSection` for page navigation.
    const target = String((link.drillthroughSection ?? link.navigationSection)?.expr?.Literal?.Value ?? '').replace(/^'|'$/g, '');
    const dt = dtPages.get(target);
    if (!dt) { fail(`${pj.displayName}: drillthrough button targets ${target.slice(0, 8)}… which is not a drillthrough page`); continue; }
    pass(`${pj.displayName}: drillthrough button targets ${dt.name}`);
    const state = v.visual?.query?.queryState ?? {};
    const carries = Object.values(state).some((role) => (role.projections ?? []).some((pr) => pr.field?.Column?.Property === dt.field));
    if (pj.name && !carries) {
      // The button enables from a selection on THIS page, so one of this page's
      // visuals must project the field. Check the whole page, not just the button.
      const pageCarries = visualsOf(id).some((vv) => Object.values(vv.visual?.query?.queryState ?? {}).some((role) => (role.projections ?? []).some((pr) => pr.field?.Column?.Property === dt.field)));
      if (!pageCarries) fail(`${pj.displayName}: NO visual on the page projects ${dt.field} - the drillthrough button can never enable`);
      else pass(`${pj.displayName}: page projects ${dt.field} (button enables from that visual's selection)`);
    }
  }
}

console.log(failures ? `\n${failures} drillthrough binding problem(s)` : '\nall drillthrough bindings verified');
process.exit(failures ? 1 : 0);
