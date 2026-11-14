#!/usr/bin/env node
/**
 * One validator for a PBIP package: structure, model, data and slicer behaviour.
 *
 *   node scripts/validate-pbip.mjs <folder|zip>
 *   node scripts/validate-pbip.mjs reports/power-bi/oracura \
 *     --data reports/power-bi/oracura/data/evaluations.csv \
 *     --dimensions City,Age,Gender,Family \
 *     --manifest reports/power-bi/oracura/report-manifest.json
 *
 * Replaces the two earlier scripts (validate-oracura-pbip.mjs for model and data
 * rules, verify-pbip-package.mjs for packaging). They shared the TMDL parser and the
 * visual walk, so a report was only correct if you remembered to run both; now one
 * command covers everything and a package is never half-checked.
 *
 * Layers, all optional except the first:
 *   1. PACKAGE  (always)  .pbip -> report -> model resolve, page registry matches
 *                         folders, every visual parses, sits inside the canvas, has a
 *                         Desktop-proven schema, no null selector, no forbidden keys,
 *                         and every field/measure it references exists in the TMDL.
 *   2. MODEL    (always)  TMDL has no BOM and no `//`, every measure carries a /// doc,
 *                         no two measures repeat the same DAX, every rate divides by a
 *                         shared base, every sortByColumn target exists.
 *   3. MODEL    (--strict-relationship)
 *                         exactly one relationship, and each --dimensions column lives
 *                         in a single table (no duplicated filter path).
 *   4. DATA     (--data)  embedded row counts match --manifest, and a --dimensions
 *                         column is never also a fact column.
 *   5. SLICER   (--data + --dimensions)
 *                         simulates each slicer against the CSV: the filtered base must
 *                         be non-blank, so a slicer cannot produce empty visuals.
 *   6. PORTABILITY  no absolute paths anywhere in the package, so a zip built on this
 *                   machine opens on the client's.
 *
 * It cannot execute DAX or render. Those still need Power BI Desktop.
 */
import { readFileSync, readdirSync, existsSync, statSync, mkdtempSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { checkTmdl } from './powerbi/tmdl-parse.mjs';

// ---------- args ----------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const target = argv.find((a, i) => !a.startsWith('--') && !(argv[i - 1] ?? '').startsWith('--'));
if (!target) {
  console.error('usage: node scripts/validate-pbip.mjs <folder|zip> [--data csv] [--dimensions A,B] [--manifest json] [--strict-relationship]');
  process.exit(1);
}

const errors = [];
const ok = (cond, msg) => { if (!cond) errors.push(msg); };
const read = (p) => readFileSync(p, 'utf8');
const json = (p) => JSON.parse(read(p));

// ---------- open the package ----------
let root = resolve(target);
let scratch = null;
if (statSync(root).isFile()) {
  scratch = mkdtempSync(join(tmpdir(), 'pbip-validate-'));
  try {
    execFileSync('unzip', ['-q', root, '-d', scratch]);
  } catch (e) {
    console.error(`FAIL\n- ${basename(root)} is not a readable zip: ${String(e.stderr ?? e.message).split('\n')[0]}`);
    process.exit(1);
  }
  root = scratch;
}
const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__MACOSX') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out); else out.push(full);
  }
  return out;
};
const files = walk(root);
const rel = (p) => p.slice(root.length + 1);

// ---------- 0. OPC part names ----------
// A package is an Open Packaging Conventions zip, so every part name is a URI path.
// Desktop refuses to publish, and names the offending pack URI, when a segment holds a
// raw space or other character outside the pchar set. The custom theme was registered
// as "Inicio Research Intelligence.json" and broke publish with exactly that error.
// Percent-encoding is not an option here: PBIR resolves these names literally.
const opcIllegal = /[^A-Za-z0-9._~!$&'()*+,;=:@/-]/;
for (const file of files) {
  const name = rel(file);
  const bad = name.split('/').filter((seg) => opcIllegal.test(seg));
  ok(bad.length === 0, `part name is a valid OPC URI: ${name}${bad.length ? ` (illegal: ${bad.join(', ')})` : ''}`);
}

// ---------- 1. package ----------
const pbip = files.find((f) => f.endsWith('.pbip'));
if (!pbip) {
  console.error(`FAIL\n- no .pbip found under ${basename(root)}`);
  process.exit(1);
}
const pbipDir = dirname(pbip);
const reportRel = json(pbip).artifacts?.find((a) => a.report)?.report?.path;
ok(!!reportRel, '.pbip declares a report artifact');
const reportDir = join(pbipDir, reportRel ?? '');
ok(existsSync(reportDir), `report folder resolves: ${reportRel}`);

const pbir = join(reportDir, 'definition.pbir');
ok(existsSync(pbir), 'definition.pbir exists');
let modelDir = null;
if (existsSync(pbir)) {
  const ds = json(pbir).datasetReference?.byPath?.path;
  ok(!!ds, 'definition.pbir declares a dataset path');
  modelDir = resolve(reportDir, ds ?? '');
  ok(existsSync(modelDir), `semantic model resolves: ${ds}`);
  ok(existsSync(join(modelDir, 'definition/model.tmdl')), 'model.tmdl exists');
  ok(existsSync(join(modelDir, 'definition.pbism')), 'definition.pbism exists');
}

const defDir = join(reportDir, 'definition');
const pagesJsonPath = join(defDir, 'pages/pages.json');
ok(existsSync(pagesJsonPath), 'pages.json exists');
let pageIds = [];
const pageTitles = new Map(); // id -> displayName, for error messages that name the page
if (existsSync(pagesJsonPath)) {
  const pages = json(pagesJsonPath);
  pageIds = pages.pageOrder ?? [];
  const dirs = readdirSync(join(defDir, 'pages')).filter((d) => d !== 'pages.json');
  ok(pageIds.length === new Set(pageIds).size, 'page ids are unique');
  ok(JSON.stringify([...pageIds].sort()) === JSON.stringify([...dirs].sort()), 'pages.json lists exactly the page folders');
  ok(pageIds.includes(pages.activePageName), 'activePageName is a real page');
  for (const id of pageIds) {
    const pageFile = join(defDir, 'pages', id, 'page.json');
    ok(existsSync(pageFile), `page.json exists for ${id}`);
    ok(existsSync(join(defDir, 'pages', id, 'visuals')), `visuals folder exists for ${id}`);
    if (existsSync(pageFile)) pageTitles.set(id, json(pageFile).displayName ?? '');
  }
  // Two pages with one name is never a design choice here; it is the fingerprint of
  // a package that was updated in place instead of rebuilt (see the count check below).
  // It also matters at runtime: the drillthrough and navigation targets are picked by
  // name in the builder, so a duplicate name is ambiguous to the next reader.
  const titles = [...pageTitles.values()].filter(Boolean);
  const duplicates = [...new Set(titles.filter((t, i) => titles.indexOf(t) !== i))];
  ok(duplicates.length === 0, `page names are unique${duplicates.length ? ` (duplicate: ${duplicates.join(', ')})` : ''}`);
  ok(pageTitles.size === pageIds.length, `every page declares a displayName (${pageTitles.size}/${pageIds.length})`);
}

// ---------- 2. model ----------
function parseTmdl(tablesDir) {
  const tables = new Map();
  const relationships = [];
  for (const f of readdirSync(tablesDir)) {
    const buf = readFileSync(join(tablesDir, f));
    ok(!(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf), `${f}: no BOM`);
    const text = buf.toString('utf8');
    ok(!/(?<!\/)\/\/(?!\/)/.test(text), `${f}: no // comments`);
    // A VAR is not a value: ISBLANK(VAR x) is invalid DAX and blanks the visual.
    ok(!/ISBLANK\(\s*VAR\s/i.test(text), `${f}: no VAR passed to a function`);
    const name = f.replace(/\.tmdl$/, '').replace(/^'|'$/g, '');
    const columns = [...text.matchAll(/^\tcolumn (.+)$/gm)].map((m) => m[1].replace(/^'|'$/g, ''));
    const measures = [];
    const expression = {};
    const sortRefs = [];
    const lines = text.split('\n');
    let currentColumn = null;
    for (let i = 0; i < lines.length; i += 1) {
      const col = lines[i].match(/^\tcolumn (.+)$/);
      if (col) { currentColumn = col[1].replace(/^'|'$/g, ''); continue; }
      const by = lines[i].match(/^\t\tsortByColumn: (.+)$/);
      if (by && currentColumn) sortRefs.push({ column: currentColumn, by: by[1].replace(/^'|'$/g, '').trim() });
      // `measure X = EXPR` on one line, or `measure X =` with the expression indented
      // below it (how Desktop serialises multi-line DAX). Continuation lines are
      // everything one tab deeper that is not a property (`formatString: ...`).
      const m = lines[i].match(/^\tmeasure (.+?) =(?: (.*))?$/);
      if (m) {
        const name2 = m[1].replace(/^'|'$/g, '');
        let body = m[2] ?? '';
        if (body === '') {
          const continuation = [];
          for (let j = i + 1; j < lines.length; j += 1) {
            if (lines[j] === '' || !lines[j].startsWith('\t\t') || /^\t\t[A-Za-z_]+:/.test(lines[j])) break;
            continuation.push(lines[j].trim());
          }
          body = continuation.join(' ');
        }
        measures.push(name2);
        expression[name2] = body;
        ok((lines[i - 1] ?? '').startsWith('\t/// '), `measure documented: ${name2}`);
      }
    }
    // embedded rows: a data line starts with {number and closes with }, or }
    const rows = lines.filter((l) => /^\s*\{[\d"-]/.test(l) && /[},]\s*$/.test(l)).length;
    for (const ref of sortRefs) ok(columns.includes(ref.by), `${name}[${ref.column}] sorts by existing column ${ref.by}`);
    tables.set(name, { columns, measures, rows, expression });
  }
  const relPath = join(dirname(tablesDir), 'relationships.tmdl');
  if (existsSync(relPath)) {
    for (const m of read(relPath).matchAll(/relationship (.+)\n\tfromColumn: (.+)\n\ttoColumn: (.+)/g)) {
      relationships.push({ name: m[1], from: m[2], to: m[3] });
    }
  }
  return { tables, relationships };
}
const { tables, relationships } = modelDir && existsSync(join(modelDir, 'definition/tables'))
  ? parseTmdl(join(modelDir, 'definition/tables'))
  : { tables: new Map(), relationships: [] };
ok(tables.size > 0, 'at least one table is defined');

// ---------- 2b. TMDL grammar ----------
// The checks above are about model *content*. These are about the parser: Power BI
// Desktop rejected a package this validator had passed because `ref table` was
// indented ("Unexpected line type: ReferenceObject!"). Indentation is parentage in
// TMDL, so the rules below encode what the parser will and will not accept.
const unq = (name) => name.trim().replace(/^'(.*)'$/, '$1');
const defRoot = modelDir ? join(modelDir, 'definition') : null;
const tmdlFiles = defRoot && existsSync(defRoot) ? walk(defRoot).filter((f) => f.endsWith('.tmdl')) : [];

if (defRoot) {
  // Grammar is checked by scripts/powerbi/tmdl-parse.mjs, an indentation-aware parser
  // with a schema of legal objects and properties - the equivalent of what the Desktop
  // TMDL reader does, and the reason this validator no longer passes files Desktop
  // rejects (an indented `ref`, a flush-left DAX line, a `description` property).
  const findings = tmdlFiles.flatMap((file) => {
    const label = file.slice(defRoot.length + 1).replace(/\\/g, '/');
    return checkTmdl(read(file), { file: label }).findings.map((f) => `${f.message}`);
  });
  ok(findings.length === 0, `TMDL grammar${findings.length ? `: ${findings.slice(0, 4).join(' | ')}${findings.length > 4 ? ` (+${findings.length - 4} more)` : ''}` : ': every .tmdl file parses against the schema'}`);

  const modelPath = join(defRoot, 'model.tmdl');
  const modelText = existsSync(modelPath) ? read(modelPath) : '';
  const modelLines = modelText.split('\n');

  // Every table file must be referenced, and every ref must resolve to a file.
  const refTables = modelLines.filter((l) => l.startsWith('ref table ')).map((l) => unq(l.slice('ref table '.length)));
  const tableFiles = existsSync(join(defRoot, 'tables'))
    ? readdirSync(join(defRoot, 'tables')).filter((f) => f.endsWith('.tmdl')).map((f) => unq(f.replace(/\.tmdl$/, '')))
    : [];
  for (const name of tableFiles) ok(refTables.includes(name), `model.tmdl refs table ${name}`);
  for (const name of refTables) ok(tableFiles.includes(name), `model.tmdl ref ${name} has a table file`);

  // A culture ref without its file, or the reverse, is a load error.
  const refCultures = modelLines.filter((l) => l.startsWith('ref cultureInfo ')).map((l) => l.slice('ref cultureInfo '.length).trim());
  for (const culture of refCultures) {
    const culturePath = join(defRoot, 'cultures', `${culture}.tmdl`);
    ok(existsSync(culturePath), `culture file exists for ${culture}`);
    if (existsSync(culturePath)) ok(read(culturePath).trim() === `cultureInfo ${culture}`, `${culture}.tmdl declares cultureInfo ${culture}`);
  }
}

// no duplicated measure logic
const seenBodies = new Map();
for (const [tableName, t] of tables) {
  for (const [name, body] of Object.entries(t.expression)) {
    const normalised = body.replace(/\s+/g, ' ').trim().toLowerCase();
    const prior = seenBodies.get(normalised);
    if (prior) errors.push(`duplicate measure logic: ${tableName}[${name}] has the same DAX as ${prior}`);
    else seenBodies.set(normalised, `${tableName}[${name}]`);
  }
}
// every rate divides by a shared base measure
for (const [, t] of tables) {
  for (const [name, body] of Object.entries(t.expression)) {
    if (/%$/.test(name)) ok(/DIVIDE\(\[[^\]]+\], \[[^\]]+\]\)/.test(body), `rate measure divides by a base measure: ${name}`);
  }
}

// ---------- 3. visuals ----------
// Whitelists taken from the published schemas, not from memory:
//   visualContainer/2.7.0 -> visual = $ref visualConfiguration/2.3.0 (additionalProperties:false)
//   visualConfiguration/2.3.0 -> VisualContainerFormattingObjects.additionalProperties:false
//   visualConfiguration/2.3.0 -> VisualLink.additionalProperties:false
// A key outside these sets is the classic "report has issues that could not be
// resolved" fault, where Desktop silently drops the offending visual.
const VISUAL_KEYS = new Set(['visualType', 'autoSelectVisualType', 'query', 'expansionStates', 'objects', 'visualContainerObjects', 'syncGroup', 'drillFilterOtherVisuals']);
const CONTAINER_OBJECT_KEYS = new Set(['title', 'subTitle', 'divider', 'spacing', 'background', 'padding', 'lockAspect', 'general', 'border', 'dropShadow', 'visualLink', 'visualTooltip', 'stylePreset', 'visualHeader', 'visualHeaderTooltip']);
const VISUAL_LINK_KEYS = new Set(['show', 'type', 'bookmark', 'disabledTooltip', 'drillthroughSection', 'enabledTooltip', 'qna', 'suppressDefaultTooltip', 'showDefaultTooltip', 'navigationSection', 'tooltip', 'tooltipPlaceholderText', 'webUrl', 'dataFunction']);

let visualCount = 0;
const pageVisuals = new Map(); // page id -> visuals found, compared with the manifest
const charts = { clusteredBarChart: 0, clusteredColumnChart: 0, columnChart: 0, stackedColumnChart: 0, donutChart: 0, pieChart: 0, funnel: 0, scatterChart: 0, treemap: 0, lineChart: 0, areaChart: 0, stackedAreaChart: 0, waterfallChart: 0, gauge: 0, lineStackedColumnComboChart: 0, pivotTable: 0, keyDriversVisual: 0, cardVisual: 0, slicer: 0, tableEx: 0, actionButton: 0 };
const slicerColumns = [];
for (const id of pageIds) {
  const vdir = join(defDir, 'pages', id, 'visuals');
  if (!existsSync(vdir)) { pageVisuals.set(id, 0); continue; }
  let pageVisualCount = 0;
  for (const v of readdirSync(vdir)) {
    const vp = join(vdir, v, 'visual.json');
    if (!existsSync(vp)) { errors.push(`missing visual.json in ${v}`); continue; }
    visualCount += 1;
    pageVisualCount += 1;
    const raw = read(vp);
    let doc;
    try { doc = JSON.parse(raw); } catch (e) { errors.push(`visual.json does not parse: ${v} (${e.message})`); continue; }
    // 2.7/2.9 validate against visualConfiguration/2.3.0; 2.12 against 2.7.0, which is a
    // strict superset (it only adds tooltip options), so every payload emitted here is
    // legal under both. Anything outside this set is an unverified schema.
    ok(!/visualContainer\/(?!2\.(6|7|9|12)\.0)/.test(raw), `${v}: container schema is a Desktop-proven version`);
    ok(!/"selector"\s*:\s*null/.test(raw), `${v}: no null selector`);
    ok(!('filters' in doc) && !('drillFilterOtherVisuals' in doc), `${v}: no forbidden top-level properties`);
    const p = doc.position;
    ok(p && p.x >= 0 && p.y >= 0 && p.width > 0 && p.height > 0 && p.x + p.width <= 1280.01 && p.y + p.height <= 720.01, `${v}: position inside the canvas`);
    const vt = doc.visual?.visualType;
    if (vt in charts) charts[vt] += 1;
    if (vt === 'slicer') {
      const f = doc.visual?.query?.queryState?.Values?.projections?.[0]?.field?.Column;
      if (f) slicerColumns.push(f.Property);
    }
    const strayVisualKeys = Object.keys(doc.visual ?? {}).filter((k) => !VISUAL_KEYS.has(k));
    ok(strayVisualKeys.length === 0, `${v}: visual keys are schema-declared${strayVisualKeys.length ? ` (stray: ${strayVisualKeys.join(', ')})` : ''}`);
    const co = doc.visual?.visualContainerObjects ?? {};
    const strayContainerKeys = Object.keys(co).filter((k) => !CONTAINER_OBJECT_KEYS.has(k));
    ok(strayContainerKeys.length === 0, `${v}: container objects are schema-declared${strayContainerKeys.length ? ` (stray: ${strayContainerKeys.join(', ')})` : ''}`);
    // visualLink is an array of property bags; anything else is malformed and would
    // throw rather than report, so shape is checked before it is walked.
    const links = co.visualLink;
    ok(links === undefined || Array.isArray(links), `${v}: visualLink is an array`);
    for (const link of Array.isArray(links) ? links : []) {
      const bag = link?.properties ?? {};
      const strayLinkKeys = Object.keys(bag).filter((k) => !VISUAL_LINK_KEYS.has(k));
      ok(strayLinkKeys.length === 0, `${v}: visualLink keys are schema-declared${strayLinkKeys.length ? ` (stray: ${strayLinkKeys.join(', ')})` : ''}`);
    }

    // A navigation button that points at a missing page is a dead link in the deck.
    if (vt === 'actionButton') {
      const linkArray = doc.visual?.visualContainerObjects?.visualLink;
      const link = Array.isArray(linkArray) ? linkArray[0]?.properties : undefined;
      if (link?.type) {
        const t = link.type?.expr?.Literal?.Value;
        ok(t === "'PageNavigation'" || t === "'Drillthrough'" || t === "'Back'", `${v}: navigation button is a page link, drillthrough or back`);
        // The companion key depends on the action: navigationSection for
        // page navigation, drillthroughSection for drillthrough, none for Back.
        const target = String((link.navigationSection ?? link.drillthroughSection)?.expr?.Literal?.Value ?? '').replace(/^'|'$/g, '');
        if (t === "'Back'") ok(true, `${v}: Back button has no target`);
        else ok(pageIds.includes(target), `${v}: navigation target exists (${target.slice(0, 8)})`);
        if (t === "'Drillthrough'") {
          // A drillthrough target must carry the matching pageBinding + howCreated.
          const pageJson = JSON.parse(read(join(reportDir, 'definition/pages', target, 'page.json')));
          ok(pageJson.type === 'Drillthrough', `${v}: drillthrough target page is marked as Drillthrough`);
          const fb = pageJson.pageBinding?.parameters?.[0]?.boundFilter;
          ok(pageJson.filterConfig?.filters?.some((f) => f.name === fb && f.howCreated === 'Drillthrough'), `${v}: drillthrough pageBinding and filter agree`);
        }
      }
    }
    for (const state of Object.values(doc.visual?.query?.queryState ?? {})) {
      for (const pr of state.projections ?? []) {
        const field = pr.field?.Measure ?? pr.field?.Column;
        const entity = field?.Expression?.SourceRef?.Entity;
        const table = tables.get(entity);
        if (!table) { errors.push(`${v}: unknown table ${entity}`); continue; }
        ok((pr.field.Measure ? table.measures : table.columns).includes(field.Property),
          `${v}: ${pr.field.Measure ? 'measure' : 'column'} ${entity}[${field.Property}] resolves`);
      }
    }
  }
  pageVisuals.set(id, pageVisualCount);
}
ok(visualCount > 0, 'at least one visual exists');

// ---------- theme + resources ----------
const reportJsonPath = join(defDir, 'report.json');
if (existsSync(reportJsonPath)) {
  const rj = json(reportJsonPath);
  for (const pkg of rj.resourcePackages ?? []) {
    const pkgDir = join(reportDir, 'StaticResources', pkg.name ?? pkg.type ?? '');
    for (const item of pkg.items ?? []) ok(existsSync(join(pkgDir, item.path)), `resource exists: ${pkg.name}/${item.path}`);
  }
  const resDir = join(reportDir, 'StaticResources/RegisteredResources');
  for (const f of existsSync(resDir) ? readdirSync(resDir).filter((n) => n.endsWith('.json')) : []) {
    const theme = json(join(resDir, f));
    // `good`/`neutral`/`bad` are the KPI colours and are importable; the previous
    // whitelist omitted them while its own message listed them, so a valid theme failed.
    const allowed = new Set([
      'name', 'dataColors', 'background', 'backgroundLight', 'backgroundNeutral',
      'foreground', 'foregroundNeutral', 'tableAccent', 'good', 'neutral', 'bad',
      'maximum', 'minimum', 'null', 'hyperlink', 'visitedHyperlink',
      'textClasses', 'visualStyles', 'images',
    ]);
    const bad = Object.keys(theme).filter((k) => !allowed.has(k));
    ok(bad.length === 0, `theme ${f}: only importable root keys (${bad.join(', ') || 'clean'})`);
  }
}

// ---------- 4. data layer ----------
const dataPath = opt('data');
const dims = (opt('dimensions') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
if (dataPath) {
  const csv = parseCsv(read(dataPath));
  const manifestPath = opt('manifest');
  if (manifestPath) {
    const manifest = json(manifestPath);
    for (const t of manifest.semanticModel?.tables ?? []) {
      const actual = tables.get(t.name)?.rows ?? -1;
      ok(actual === t.rows, `manifest rows for ${t.name}: ${t.rows} == TMDL ${actual}`);
    }
  }
  // dimensions must not be duplicated into the fact table
  for (const d of dims) {
    const owners = [...tables.entries()].filter(([, t]) => t.columns.includes(d)).map(([n]) => n);
    if (flag('strict-relationship')) ok(owners.length === 1, `${d} lives in exactly one table (${owners.join(', ') || 'none'})`);
  }
  if (flag('strict-relationship')) {
    ok(relationships.length === 1, `exactly one relationship in the model (${relationships.length})`);
  }
  if (slicerColumns.length) {
    const respKey = Object.keys(csv[0] ?? {}).find((k) => /^(Resp|Respondent|ResponseId|Id)$/i.test(k));
    const byResp = new Map();
    if (respKey) for (const r of csv) if (!byResp.has(r[respKey])) byResp.set(r[respKey], r);
    for (const col of [...new Set(slicerColumns)]) {
      const values = [...new Set(csv.map((r) => r[col]).filter((v) => v !== ''))].slice(0, 3);
      ok(values.length > 0, `slicer ${col}: has values in the data`);
      for (const value of values) {
        const filtered = csv.filter((r) => r[col] === value);
        ok(filtered.length > 0, `slicer ${col} = "${value}" -> ${filtered.length} rows (non-blank)`);
      }
    }
  }
}

// ---------- 4b. count check ----------
// The manifest is written by the build that produced this package, so it is the one
// description of what the package is *supposed* to contain. This matters most for a
// zip: `zip -qr` updates an existing archive in place and page ids are random per
// build, so re-zipping without deleting leaves an earlier build's pages inside under
// new ids. The counts then exceed the build, and every stale page has a duplicate
// displayName - which is exactly the 477 -> 557 regression this check exists for.
// Runs on the folder too: a hand-edited page is just as wrong as a stale zip.
const manifestPath = opt('manifest');
if (manifestPath) {
  const manifest = json(manifestPath);
  const builtPages = manifest.pages ?? [];
  ok(builtPages.length === pageIds.length,
    `page count matches the build manifest (${builtPages.length} built, ${pageIds.length} in package)`);
  ok(manifest.visualCount === visualCount,
    `visual count matches the build manifest (${manifest.visualCount} built, ${visualCount} in package)`);
  const builtIds = new Set(builtPages.map((p) => p.id));
  const unknown = pageIds.filter((id) => !builtIds.has(id));
  ok(unknown.length === 0,
    `no page in the package is absent from the build manifest${unknown.length ? ` (stale: ${unknown.map((id) => `${pageTitles.get(id) || 'untitled'} ${id}`).join(', ')})` : ''}`);
  for (const p of builtPages) {
    const actual = pageVisuals.get(p.id);
    ok(actual === p.visuals, `page "${p.name}": manifest says ${p.visuals} visuals, package has ${actual ?? 'no such page'}`);
  }
}

// ---------- 5. portability ----------
for (const f of files.filter((n) => /\.(json|tmdl|pbir|pbism|pbip)$/.test(n))) {
  const text = read(f);
  ok(!/(^|[^A-Za-z])[A-Za-z]:[\\/]/.test(text), `${rel(f)}: no Windows absolute path`);
  ok(!/\/(Users|workspace|tmp|home)\//.test(text), `${rel(f)}: no machine absolute path`);
}

// ---------- report ----------
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i += 1; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); cell = ''; rows.push(row); row = []; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  const head = rows[0].map((h) => h.trim());
  return rows.slice(1).filter((r) => r.some((c) => c !== '')).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

const label = basename(resolve(target));
const shape = Object.entries(charts).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ');
if (errors.length) {
  console.error(`FAIL (${errors.length}) - ${label}\n- ${errors.join('\n- ')}`);
  process.exit(1);
}
console.log(`PASS - ${label}`);
console.log(`      ${pageIds.length} pages · ${visualCount} visuals${shape ? ` (${shape})` : ''} · ${tables.size} tables · ${[...tables.values()].reduce((s, t) => s + t.measures.length, 0)} measures`);
console.log(`      package: entry point, model path, page registry, field references, theme resources, portability`);
console.log(`      model: TMDL hygiene, measure docs, no duplicate DAX, sortByColumn targets${dataPath ? ', manifest row counts' : ''}`);
if (manifestPath) console.log(`      counts: page ids, page count and visual count match ${basename(manifestPath)} (no stale pages)`);
if (slicerColumns.length && dataPath) console.log(`      slicers: ${[...new Set(slicerColumns)].join(', ')} simulated against ${basename(dataPath)} - no blank bases`);
