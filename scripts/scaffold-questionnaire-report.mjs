#!/usr/bin/env node
/**
 * Scaffold a Power BI PBIP report from any questionnaire-shaped CSV.
 *
 *   node scripts/scaffold-questionnaire-report.mjs \
 *     --csv path/to/responses.csv --code ACME --title "ACME Pulse Q3" \
 *     [--out reports/power-bi/acme] [--id RespId]
 *
 * It profiles the file, decides what is an identifier, a dimension, a numeric
 * measure and a free-text verbatim, then emits a five-page report:
 *
 *   00 Cover · 01 Overview · 02 Profile · 03 Measures · 04 Responses
 *
 * The pages use the same visual families as the ORACURA report - horizontal bars,
 * donuts, a treemap, a scatter and a line - chosen from what the profile can support
 * (a scatter only when two numerics exist, a treemap only when two dimensions do).
 *
 * All values are embedded in the model with M #table, so the generated project
 * opens with no file path, no refresh and no gateway. The script validates its own
 * output (references resolve, positions in bounds, TMDL clean) and writes
 * profile.json recording every inference, so a human can see what it decided.
 *
 * This is the generic on-ramp. A study that deserves bespoke analysis (like
 * ORACURA) should still be built by hand on top of the same primitives; this gets
 * the other questionnaires to a defensible first report in one command.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, dirname, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VISUAL_SCHEMA = 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualContainer/2.12.0/schema.json';
const PAGE_SCHEMA = 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/page/2.1.0/schema.json';

// ---------- args ----------
const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const CSV = arg('csv');
if (!CSV) {
  console.error('usage: node scripts/scaffold-questionnaire-report.mjs --csv <file.csv|xlsx> --code CODE --title "Title" [--out dir] [--id column] [--sheet name]');
  process.exit(1);
}
const CODE = (arg('code') || basename(CSV).replace(/\.[^.]+$/, '')).toUpperCase().replace(/[^A-Z0-9]/g, '');
const TITLE = arg('title', `${CODE} questionnaire report`);
const OUT = resolve(arg('out', join(ROOT, 'reports/power-bi', CODE.toLowerCase())));

// ---------- csv ----------
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
  const matrix = rows.slice(1).filter((r) => r.some((c) => c.trim() !== '')).map((r) => head.map((_, i) => (r[i] ?? '').trim()));
  return { head, matrix };
}
// Excel is accepted directly: the profiler only needs rows, and asking a client to
// convert their workbook to CSV first is exactly the kind of step that produces a
// wrong report. openpyxl is used when present; the error says how to install it.
// openpyxl is looked for in a portable order rather than a hardcoded /tmp path:
// an explicit OPENPYXL_PATH, then whatever PYTHONPATH already says, then this
// workspace's scratch install, then the interpreter's own site-packages. The first
// candidate that can `import openpyxl` wins, and the result is cached for the run.
let openpyxlPath;
function resolveOpenpyxl() {
  if (openpyxlPath !== undefined) return openpyxlPath;
  const candidates = [
    process.env.OPENPYXL_PATH,
    ...(process.env.PYTHONPATH ? process.env.PYTHONPATH.split(process.platform === 'win32' ? ';' : ':') : []),
    '/tmp/xlsxlibs',
    '',
  ].filter((c) => c !== undefined);
  for (const candidate of candidates) {
    try {
      execFileSync('python3', ['-c', 'import openpyxl'], {
        stdio: 'ignore',
        env: { ...process.env, PYTHONPATH: candidate ?? '' },
      });
      openpyxlPath = candidate;
      return openpyxlPath;
    } catch { /* try the next candidate */ }
  }
  openpyxlPath = null;
  return openpyxlPath;
}

function readWorkbook(path, sheetName) {
  const pyPath = resolveOpenpyxl();
  if (pyPath === null) {
    console.error(`Reading ${basename(path)} needs openpyxl, which python3 on PATH cannot import.`);
    console.error('Any of these fixes it:');
    console.error('  pip install openpyxl');
    console.error('  pip install --target /tmp/xlsxlibs openpyxl');
    console.error('  OPENPYXL_PATH=/path/to/libs node scripts/scaffold-questionnaire-report.mjs ...');
    console.error('Or export the sheet to CSV and pass that with --csv.');
    process.exit(1);
  }
  const script = `
import sys, csv
import openpyxl
wb = openpyxl.load_workbook(sys.argv[1], data_only=True, read_only=True)
name = sys.argv[2] if len(sys.argv) > 2 else None
if name and name in wb.sheetnames:
    ws = wb[name]
else:
    ws = max(wb.worksheets, key=lambda s: s.max_row or 0)
w = csv.writer(sys.stdout, lineterminator='\\n')
for row in ws.iter_rows(values_only=True):
    if row is None: continue
    cells = ['' if v is None else str(v) for v in row]
    if any(c.strip() for c in cells): w.writerow(cells)
`;
  try {
    return execFileSync('python3', ['-c', script, path, sheetName ?? ''], {
      encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, PYTHONPATH: pyPath },
    });
  } catch (e) {
    const detail = String(e.stderr ?? e.message).trim().split('\n').pop();
    console.error(`Could not read ${basename(path)} as a workbook: ${detail}`);
    console.error('Check the file opens in Excel, or try --sheet <name> to pick a worksheet explicitly.');
    process.exit(1);
  }
}

const isWorkbook = /\.(xlsx|xlsm)$/i.test(CSV);
const rawText = isWorkbook ? readWorkbook(resolve(CSV), arg('sheet')) : readFileSync(CSV, 'utf8');
const parsed = parseCsv(rawText);
// Duplicate headers are common in exported questionnaires; colliding keys would silently
// drop a column, so they are disambiguated instead.
const dupeCount = new Map();
const head = parsed.head.map((h) => {
  const base = h.trim() || 'Column';
  const n = (dupeCount.get(base) ?? 0) + 1;
  dupeCount.set(base, n);
  return n === 1 ? base : `${base}_${n}`;
});
const rows = parsed.matrix.map((cells) => Object.fromEntries(head.map((h, i) => [h, cells[i] ?? ''])));
if (!rows.length) { console.error('no data rows in', CSV); process.exit(1); }

// ---------- profile ----------
const safeName = (name, taken) => {
  let s = String(name).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'Column';
  if (!/^[A-Za-z]/.test(s)) s = `C_${s}`;
  let candidate = s; let n = 2;
  while (taken.has(candidate)) candidate = `${s}_${n++}`;
  taken.add(candidate);
  return candidate;
};
const taken = new Set();
const profile = head.map((name) => {
  const values = rows.map((r) => r[name]).filter((v) => v !== '');
  const distinct = new Set(values);
  const numeric = values.filter((v) => Number.isFinite(Number(v)) && v.trim() !== '');
  const avgLen = values.length ? values.reduce((s, v) => s + v.length, 0) / values.length : 0;
  const isNumeric = values.length > 0 && numeric.length / values.length >= 0.9;
  return {
    name,
    mName: safeName(name, taken),
    filled: values.length,
    distinct: distinct.size,
    numericRatio: values.length ? numeric.length / values.length : 0,
    avgLen: Number(avgLen.toFixed(1)),
  };
});

const idExplicit = arg('id');
const idCol = profile.find((p) => p.name === idExplicit) || profile.find((p) => /^(resp|respondent|record|id|sl\.?no)/i.test(p.name)) || profile[0];
const numericCols = profile.filter((p) => p !== idCol && p.numericRatio >= 0.9 && p.distinct > 2);
const textCols = profile.filter((p) => p !== idCol && !numericCols.includes(p));
// A free-text column often has very few distinct answers ("What went well": 8 values),
// so cardinality alone cannot separate it from a dimension. The header wording can.
const VERBATIM_HINT = /verbatim|comment|reason|why|feedback|text|note|open|what |describe|explain|improve|suggest/i;
const verbatimCols = textCols
  .filter((p) => VERBATIM_HINT.test(p.name) && p.distinct >= 4 && p.avgLen > 6)
  .sort((a, b) => b.avgLen - a.avgLen)
  .slice(0, 3);
const dimCols = textCols
  .filter((p) => !verbatimCols.includes(p) && p.distinct >= 2 && p.distinct <= 20 && p.avgLen <= 30)
  .slice(0, 6);

// ---------- model ----------
const isInt = (name) => rows.every((r) => r[name] === '' || /^-?\d+$/.test(r[name]));
const typeOf = (p) => (numericCols.includes(p) ? (isInt(p.name) ? 'int64' : 'double') : 'string');
const mType = { int64: 'Int64.Type', double: 'number', string: 'text' };
const mValue = (p, v) => {
  if (v === '' || v === undefined || v === null) return 'null';
  if (typeOf(p) === 'string') return `"${String(v).replace(/\r?\n/g, ' ').replace(/"/g, '""')}"`;
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : 'null';
};

// A display name containing [ ] " or ' would break every DAX reference to it, so those
// columns keep the sanitised name as their display name too.
const DISPLAY_SAFE = /^[^[\]"']+$/;
for (const p of profile) if (!DISPLAY_SAFE.test(p.name)) p.name = p.mName;

const tmdlColumn = (p) => {
  const t = typeOf(p);
  const lines = [`\tcolumn ${/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.name) ? p.name : `'${p.name.replace(/'/g, "''")}'`}`];
  lines.push(`\t\tdataType: ${t === 'int64' ? 'int64' : t === 'double' ? 'double' : 'string'}`);
  lines.push('\t\tsummarizeBy: none');
  if (p.mName !== p.name) lines.push(`\t\tsourceColumn: ${p.mName}`);
  return lines.join('\n');
};
const mRows = rows.map((r) => `                {${profile.map((p) => mValue(p, r[p.name])).join(', ')}}`).join(',\n');
const dataPartition = `\tpartition Data = m
\t\tmode: import
\t\tsource =
\t\t\t\tlet
\t\t\t\t    Source = #table(
\t\t\t\t        type table [${profile.map((p) => `${p.mName} = ${mType[typeOf(p)]}`).join(', ')}],
\t\t\t\t        {
${mRows}
\t\t\t\t        }
\t\t\t\t    )
\t\t\t\tin
\t\t\t\t    Source`;

const measures = [
  { name: 'Records', expression: 'COUNTROWS(Data)', formatString: '#,##0', description: 'Rows in the response file.' },
  ...numericCols.slice(0, 3).map((p) => ({
    name: `Avg ${p.name}`,
    expression: `AVERAGE(Data[${p.name}])`,
    formatString: isInt(p.name) ? '0' : '0.00',
    description: `Mean of ${p.name} across the filtered responses.`,
  })),
  ...(verbatimCols.length ? [{
    name: 'With comment',
    expression: `CALCULATE([Records], NOT ISBLANK(Data[${verbatimCols[0].name}]))`,
    formatString: '#,##0',
    description: `Responses that filled in ${verbatimCols[0].name}.`,
  }] : []),
];
// TMDL descriptions are /// doc comments directly above the object. There is no
// `description` property; emitting one makes Desktop reject the model.
const measureTmdl = measures.map((m) => `\t/// ${m.description.replace(/\s+/g, ' ')}
\tmeasure ${/^[A-Za-z_][A-Za-z0-9_]*$/.test(m.name) ? m.name : `'${m.name}'`} = ${m.expression}
\t\tformatString: ${m.formatString}
`).join('\n');

const dataTable = `table Data
${profile.map(tmdlColumn).join('\n')}

${dataPartition}
`;
const measuresTable = `table _Measures

\tcolumn Dummy
\t\tdataType: string
\t\tisHidden
\t\tsummarizeBy: none
\t\tsourceColumn: [Dummy]

${measureTmdl}

\tpartition _Measures = calculated
\t\tmode: import
\t\tsource = ROW("Dummy", BLANK())
`;

// ---------- report ----------
const stableId = (label) => {
  const hex = createHash('sha1').update(String(label)).digest('hex').slice(0, 20).split('');
  return hex.join('');
};
// Single source of truth for the page sequence used by the nav buttons.
const PAGE_ORDER = { '00 Cover': 'INDEX', '01 Overview': 'OVERVIEW', '02 Profile': 'PROFILE', '03 Measures': 'MEASURES', '04 Responses': 'RESPONSES' };
const pageIdOf = (name) => stableId(`${CODE}:page:${name}`);
const navLabelOf = (name) => { if (!(name in PAGE_ORDER)) throw new Error(`nav target not in PAGE_ORDER: ${name}`); return PAGE_ORDER[name]; };

const lit = (v) => ({ expr: { Literal: { Value: v } } });
const bool = (v) => lit(v ? 'true' : 'false');
const numL = (v) => lit(`${v}D`);
const textL = (v) => lit(`'${String(v).replace(/'/g, "''").replace(/[\r\n]+/g, ' ')}'`);
const colorL = (v) => ({ solid: { color: textL(v) } });
const C = { paper: '#FBF7F1', ink: '#211C17', muted: '#6C6156', faint: '#9C9082', accent: '#B4652F', card: '#FFFFFF', hairline: '#E4D9CB', teal: '#2F6B63', plum: '#6B4A66', slate: '#3F5068' };

const pages = [];
const colProj = (p) => ({ field: { Column: { Expression: { SourceRef: { Entity: 'Data' } }, Property: p } }, queryRef: `Data.${p}`, nativeQueryRef: p });
const measProj = (p) => ({ field: { Measure: { Expression: { SourceRef: { Entity: '_Measures' } }, Property: p } }, queryRef: `_Measures.${p}`, nativeQueryRef: p });
const container = ({ fill = null, border = null, radius = 8 } = {}) => ({
  title: [{ properties: { show: bool(false) } }],
  background: [{ properties: fill ? { show: bool(true), color: colorL(fill), transparency: numL(0) } : { show: bool(false) } }],
  border: [{ properties: border ? { show: bool(true), color: colorL(border), radius: numL(radius), width: numL(1) } : { show: bool(false) } }],
  dropShadow: [{ properties: { show: bool(false) } }],
});

class Page {
  constructor(name) { this.displayName = name; this.id = stableId(`${CODE}:page:${name}`); this.visuals = []; this.n = 0; }
  add(label, position, visual) {
    this.n += 1;
    const name = stableId(`${CODE}:${this.displayName}:${label}:${this.n}`);
    this.visuals.push({ name, json: { $schema: VISUAL_SCHEMA, name, position, visual } });
  }
  text(label, x, y, w, h, text, o = {}) {
    const style = { fontFamily: o.font ?? 'Segoe UI', fontSize: `${o.size ?? 10}pt`, color: o.color ?? C.ink, fontWeight: o.weight ?? 'normal' };
    const paragraphsValue = String(text).split('\n').map((line) => ({ textRuns: [{ value: line || ' ', textStyle: style }] }));
    this.add(label, { x, y, z: o.z ?? 20, height: h, width: w, tabOrder: o.z ?? 20 }, {
      visualType: 'textbox',
      objects: { general: [{ properties: { paragraphs: paragraphsValue } }] },
      visualContainerObjects: container({ fill: o.fill ?? null, border: o.border ?? null, radius: o.radius ?? 8 }),
      drillFilterOtherVisuals: false,
    });
  }
  panel(label, x, y, w, h, o = {}) { this.text(label, x, y, w, h, ' ', { size: 1, fill: o.fill ?? C.card, border: o.border ?? C.hairline, radius: o.radius ?? 8, z: o.z ?? 0, color: o.fill ?? C.card }); }
  line(label, x, y, w, h, o = {}) {
    this.add(label, { x, y, z: 0, height: h, width: w, tabOrder: -1 }, {
      visualType: 'shape',
      objects: { fill: [{ properties: { show: bool(true), fillColor: colorL(o.fill ?? C.hairline) } }], outline: [{ properties: { show: bool(false) } }], shape: [{ properties: { tileShape: textL('rectangle') } }] },
      visualContainerObjects: container({}), drillFilterOtherVisuals: false,
    });
  }
  header(num, title, subtitle) {
    this.panel('bg', 0, 0, 1280, 720, { fill: C.paper, border: null, radius: 0, z: 0 });
    this.text('brand', 48, 24, 700, 18, `${CODE}  /  QUESTIONNAIRE REPORT`, { size: 8, color: C.accent, weight: '600', z: 200 });
    this.text('pageno', 1170, 24, 62, 18, String(num), { size: 9, color: C.muted, weight: '600', z: 200 });
    this.text('title', 48, 46, 1100, 42, title, { size: title.length > 52 ? 23 : 26, z: 200 });
    if (subtitle) this.text('sub', 48, 90, 1120, 22, subtitle, { size: 9.5, color: C.muted, z: 200 });
    this.line('rule', 48, 122, 1184, 1, { z: 190 });
    this.text('footer', 48, 692, 1000, 15, `${CODE}  ·  ${rows.length} RESPONSES  ·  ${dimCols.length} DIMENSIONS  ·  ${numericCols.length} MEASURES  ·  EMBEDDED DATA`, { size: 7, color: C.faint, z: 200 });
  }
  // Same schema-verified shape as the ORACURA report: visualLink accepts only the
  // declaration's keys (show/type/navigationSection here), so nothing stray is emitted.
  navButton(label, x, y, w, h, targetPageId, o = {}) {
    this.add(label, { x, y, z: 300, height: h, width: w, tabOrder: 300 }, {
      visualType: 'actionButton',
      objects: {
        text: [{
          properties: {
            show: bool(true),
            text: textL(o.text ?? ''),
            fontFamily: textL('Segoe UI'),
            fontSize: numL(o.size ?? 8),
            fontColor: colorL(o.color ?? C.muted),
            horizontalAlignment: textL('center'),
          },
        }],
        fill: [{ properties: { show: bool(!!o.fill), fillColor: colorL(o.fill ?? C.card), transparency: numL(o.fill ? 0 : 100) } }],
        // Desktop writes an `icon` member on every actionButton (usually show:false).
        icon: [{ properties: { show: bool(false) } }],
        outline: [{ properties: { show: bool(false) } }],
      },
      visualContainerObjects: {
        title: [{ properties: { show: bool(false) } }],
        background: [{ properties: { show: bool(false) } }],
        border: [{ properties: { show: bool(false) } }],
        dropShadow: [{ properties: { show: bool(false) } }],
        visualLink: [{
          properties: {
            show: bool(true),
            type: textL('PageNavigation'),
            navigationSection: textL(targetPageId),
          },
        }],
      },
      drillFilterOtherVisuals: false,
    });
  }
  nav(prevName, nextName, dark = false) {
    const base = { color: dark ? '#E8D9C6' : C.muted, fill: dark ? '#2E2620' : C.card };
    if (prevName) this.navButton('navprev', 996, 684, 106, 22, pageIdOf(prevName), { ...base, size: 7.5, text: `\u2039  ${navLabelOf(prevName)}` });
    if (nextName) this.navButton('navnext', 1110, 684, 122, 22, pageIdOf(nextName), { ...base, size: 7.5, color: dark ? '#E0A277' : C.accent, text: `${navLabelOf(nextName)}  \u203a` });
  }
  heading(x, y, t, s = '', w = 560) {
    this.text('h', x, y, w, 18, t.toUpperCase(), { size: 8.5, color: C.muted, weight: '600', z: 200 });
    if (s) this.text('hs', x, y + 19, w, 16, s, { size: 8, color: C.faint, z: 200 });
  }
  card(label, x, y, w, h, measure, o = {}) {
    this.add(label, { x, y, z: 20, height: h, width: w, tabOrder: 20 }, {
      visualType: 'cardVisual',
      query: { queryState: { Data: { projections: [measProj(measure)] } } },
      objects: {
        value: [{ properties: { fontSize: numL(o.valueSize ?? 24), fontFamily: textL('Segoe UI Semibold'), fontColor: colorL(C.ink) }, selector: { id: 'default' } }],
        label: [{ properties: { fontSize: numL(9), fontFamily: textL('Segoe UI'), fontColor: colorL(C.muted), show: bool(true) }, selector: { id: 'default' } }],
        padding: [{ properties: { paddingSelection: textL('Custom'), leftMargin: numL(8), topMargin: numL(8), bottomMargin: numL(8), rightMargin: numL(8) }, selector: { id: 'default' } }],
      },
      visualContainerObjects: container({ fill: C.card, border: C.hairline, radius: 9 }),
      drillFilterOtherVisuals: true,
    });
  }
  bar(label, x, y, w, h, catP, valP, fill) {
    this.add(label, { x, y, z: 20, height: h, width: w, tabOrder: 20 }, {
      visualType: 'clusteredBarChart',
      query: {
        sortDefinition: { sort: [{ field: { Measure: { Expression: { SourceRef: { Entity: '_Measures' } }, Property: valP } }, direction: 'Descending' }], isDefaultSort: false },
        queryState: { Category: { projections: [colProj(catP)] }, Y: { projections: [measProj(valP)] } },
      },
      objects: {
        dataPoint: [{ properties: { fill: colorL(fill) } }],
        labels: [{ properties: { show: bool(true), fontSize: numL(9), fontFamily: textL('Segoe UI'), color: colorL(C.ink), labelPrecision: textL('0L'), labelDisplayUnits: numL(1), enableValueDataLabel: bool(true) } }],
        legend: [{ properties: { show: bool(false) } }],
        categoryAxis: [{ properties: { show: bool(true), showAxisTitle: bool(false), fontFamily: textL('Segoe UI'), fontSize: numL(9), labelColor: colorL(C.ink), maxMarginFactor: numL(35) } }],
        valueAxis: [{ properties: { show: bool(false), showAxisTitle: bool(false) } }],
      },
      visualContainerObjects: container({ fill: C.card, border: C.hairline }),
      drillFilterOtherVisuals: true,
    });
  }
  // Same visual types the ORACURA report uses, so every questionnaire gets the
  // variety instead of only horizontal bars. Each helper takes column names and
  // resolves them through colProj / measProj against the Data / _Measures tables.
  donut(label, x, y, w, h, catP, valP = 'Records') {
    this.add(label, { x, y, z: 20, height: h, width: w, tabOrder: 20 }, {
      visualType: 'donutChart',
      query: { queryState: { Category: { projections: [colProj(catP)] }, Y: { projections: [measProj(valP)] } } },
      objects: {
        legend: [{ properties: { show: bool(true), position: textL('Right'), fontSize: numL(8), fontFamily: textL('Segoe UI') } }],
        labels: [{ properties: { show: bool(true), fontSize: numL(8), fontFamily: textL('Segoe UI'), color: colorL(C.ink), labelDisplayUnits: numL(0) } }],
      },
      visualContainerObjects: container({ fill: C.card, border: C.hairline }),
      drillFilterOtherVisuals: true,
    });
  }
  // Tiles group by one dimension and split by another - good when two categorical
  // columns both matter and the matrix is too wide for a table.
  // Details is optional: one level of tiles stays readable at this size, while a
  // second level is only worth it when the caller knows the split is informative.
  treemap(label, x, y, w, h, groupP, detailsP = null, valP = 'Records') {
    const queryState = { Group: { projections: [colProj(groupP)] }, Values: { projections: [measProj(valP)] } };
    if (detailsP) queryState.Details = { projections: [colProj(detailsP)] };
    this.add(label, { x, y, z: 20, height: h, width: w, tabOrder: 20 }, {
      visualType: 'treemap',
      query: { queryState },
      objects: {
        labels: [{ properties: { show: bool(true), fontSize: numL(8), fontFamily: textL('Segoe UI'), color: colorL('#FFFDF9') } }],
        legend: [{ properties: { show: bool(true), fontSize: numL(8), fontFamily: textL('Segoe UI') } }],
      },
      visualContainerObjects: container({ fill: C.card, border: C.hairline }),
      drillFilterOtherVisuals: true,
    });
  }
  // One bubble per category: X/Y are two averaged measures, size is the count.
  // No Series projection: a single series of category bubbles. Splitting Series by the
  // same column as Category would duplicate the legend for no information, and the
  // point labels are what make a small multi-bubble chart readable.
  scatter(label, x, y, w, h, catP, xP, yP, sizeP = 'Records') {
    this.add(label, { x, y, z: 20, height: h, width: w, tabOrder: 20 }, {
      visualType: 'scatterChart',
      query: {
        queryState: {
          Category: { projections: [colProj(catP)] },
          X: { projections: [measProj(xP)] },
          Y: { projections: [measProj(yP)] },
          Size: { projections: [measProj(sizeP)] },
        },
      },
      objects: {
        xAxis: [{ properties: { show: bool(true), showAxisTitle: bool(true), fontFamily: textL('Segoe UI'), fontSize: numL(8), labelColor: colorL(C.ink), titleText: textL(xP) } }],
        yAxis: [{ properties: { show: bool(true), showAxisTitle: bool(true), fontFamily: textL('Segoe UI'), fontSize: numL(8), labelColor: colorL(C.ink), titleText: textL(yP) } }],
        legend: [{ properties: { show: bool(false) } }],
        bubbles: [{ properties: { transparency: numL(15), displayValue: bool(true) } }],
      },
      visualContainerObjects: container({ fill: C.card, border: C.hairline }),
      drillFilterOtherVisuals: true,
    });
  }
  // One average traced across the values of a low-cardinality dimension - the
  // profiler only passes dimensions with 2-20 distinct values, so axes stay readable.
  lineChart(label, x, y, w, h, axisP, valP) {
    this.add(label, { x, y, z: 20, height: h, width: w, tabOrder: 20 }, {
      visualType: 'lineChart',
      query: { queryState: { Axis: { projections: [colProj(axisP)] }, Values: { projections: [measProj(valP)] } } },
      objects: {
        categoryAxis: [{ properties: { show: bool(true), showAxisTitle: bool(false), fontFamily: textL('Segoe UI'), fontSize: numL(8), labelColor: colorL(C.ink) } }],
        valueAxis: [{ properties: { show: bool(true), showAxisTitle: bool(false), fontFamily: textL('Segoe UI'), fontSize: numL(8), labelColor: colorL(C.ink) } }],
        line: [{ properties: { transparency: numL(0) } }],
      },
      visualContainerObjects: container({ fill: C.card, border: C.hairline }),
      drillFilterOtherVisuals: true,
    });
  }
  table(label, x, y, w, h, projections) {
    this.add(label, { x, y, z: 20, height: h, width: w, tabOrder: 20 }, {
      visualType: 'tableEx',
      query: { queryState: { Values: { projections } } },
      objects: {},
      visualContainerObjects: container({ fill: C.card, border: C.hairline }),
      drillFilterOtherVisuals: true,
    });
  }
  json() {
    return { $schema: PAGE_SCHEMA, name: this.id, displayName: this.displayName, displayOption: 'FitToPage', width: 1280, height: 720, objects: { background: [{ properties: { color: colorL(C.paper), transparency: numL(0) } }] } };
  }
}

// 00 Cover
{
  const p = new Page('00 Cover');
  p.panel('bg', 0, 0, 1280, 720, { fill: '#221C17', border: null, radius: 0, z: 0 });
  p.line('accent', 0, 0, 13, 720, { fill: C.accent, z: 5 });
  p.text('k', 64, 54, 700, 18, `${CODE}  /  ANALYTICAL REPORT`, { size: 8.5, color: '#E0A277', weight: '600', z: 100 });
  p.text('t', 64, 120, 860, 110, TITLE, { size: 44, color: '#F6EDE2', z: 100 });
  p.text('s', 64, 250, 720, 70, `${rows.length} responses · ${profile.length} columns ingested\nAuto-generated from ${basename(CSV)} - every visual is live over the embedded data.`, { size: 11, color: '#B9A897', z: 100 });
  p.panel('meta', 880, 130, 340, 300, { fill: '#2E2620', border: '#463A30', radius: 6, z: 120 });
  [['RESPONSES', String(rows.length)], ['DIMENSIONS', String(dimCols.length)], ['NUMERIC FIELDS', String(numericCols.length)], ['TEXT FIELDS', String(verbatimCols.length)]].forEach(([l, v], i) => {
    p.text('ml', 908, 154 + i * 62, 300, 14, l, { size: 7.5, color: '#988675', weight: '600', z: 160 });
    p.text('mv', 908, 173 + i * 62, 310, 26, v, { size: 18, color: '#F6EDE2', z: 160 });
  });
  p.text('f', 64, 600, 1120, 60, 'Pages: 01 Overview · 02 Profile · 03 Measures · 04 Responses.\nGenerated by scripts/scaffold-questionnaire-report.mjs - bars, rings, treemaps, scatter and line over the embedded data. Edit profile.json, re-run, or build a bespoke report on the same model.', { size: 9, color: '#B9A897', z: 100 });
  p.nav(null, '01 Overview', true);
  pages.push(p);
}

// 01 Overview
{
  const p = new Page('01 Overview');
  p.header(1, 'Overview', 'Headline counts and the first dimension - the shape of the file before any analysis.');
  p.card('k0', 48, 150, 282, 100, 'Records');
  numericCols.slice(0, 3).forEach((c, i) => p.card(`k${i + 1}`, 348 + i * 300, 150, 282, 100, `Avg ${c.name}`, { valueSize: 22 }));
  if (dimCols.length) {
    p.heading(48, 280, `${dimCols[0].name}`, 'Record count by value, ranked', 780);
    p.bar('b0', 48, 316, 780, 340, dimCols[0].name, 'Records', C.accent);
    p.heading(848, 280, `${dimCols[0].name} share`, 'Same counts as a part-to-whole ring', 384);
    p.donut('d0', 848, 316, 384, 340, dimCols[0].name);
  }
  p.nav('00 Cover', '02 Profile');
  pages.push(p);
}

// 02 Profile
{
  const p = new Page('02 Profile');
  p.header(2, 'Profile', 'Every dimension the profiler detected, as a distribution. Low-cardinality fields only.');
  const dims = dimCols.slice(0, 4);
  dims.forEach((d, i) => {
    const x = i % 2 === 0 ? 48 : 660;
    const y = i < 2 ? 150 : 400;
    p.heading(x, y, d.name, `${d.distinct} distinct values`, 560);
    // The first two dimensions keep bars (exact comparison at a glance); the last two
    // use a treemap and a ring so the page is not four copies of the same chart.
    if (i === 2) p.treemap(`d${i}`, x, y + 34, 572, 196, d.name);
    else if (i === 3) p.donut(`d${i}`, x, y + 34, 572, 196, d.name);
    else p.bar(`d${i}`, x, y + 34, 572, 196, d.name, 'Records', [C.accent, C.teal, C.plum, C.slate][i % 4]);
  });
  if (!dims.length) p.text('none', 48, 150, 1100, 40, 'No low-cardinality dimension columns were detected in this file.', { size: 11, color: C.muted });
  p.nav('01 Overview', '03 Measures');
  pages.push(p);
}

// 03 Measures
{
  const p = new Page('03 Measures');
  p.header(3, 'Measures', 'Numeric fields, averaged within the first dimension - where the variance lives.');
  const cats = dimCols.slice(0, 2);
  if (numericCols.length && cats.length) {
    // The bar rows stay short enough that the two charts underneath still have room.
    numericCols.slice(0, 2).forEach((n, i) => {
      const cat = cats[Math.min(i, cats.length - 1)];
      p.heading(i === 0 ? 48 : 660, 150, `${n.name} by ${cat.name}`, 'Mean, not sum - averages do not add up', 560);
      p.bar(`m${i}`, i === 0 ? 48 : 660, 184, 572, 240, cat.name, `Avg ${n.name}`, [C.teal, C.plum][i]);
    });
    // A line needs more than two points to show a shape, so it takes the dimension with
    // the most values rather than whichever happens to be second.
    const widest = [...dimCols].sort((a, b) => b.distinct - a.distinct)[0];
    // A scatter needs two different measures on its axes; with only one numeric the
    // left half becomes a second trace instead of a meaningless diagonal.
    if (numericCols.length >= 2) {
      p.heading(48, 440, 'Relationship between the numeric fields', 'One bubble per category - where both measures move together', 560);
      p.scatter('sc', 48, 474, 572, 176, cats[0].name, `Avg ${numericCols[0].name}`, `Avg ${numericCols[1].name}`);
    } else {
      p.heading(48, 440, `${numericCols[0].name} across ${widest.name}`, 'The same average as a trace - read the shape, not the bars', 560);
      p.lineChart('lc2', 48, 474, 572, 176, widest.name, `Avg ${numericCols[0].name}`);
    }
    p.heading(660, 440, `${numericCols[0].name} across ${widest.name}`, 'The same average as a trace - read the shape, not the bars', 560);
    p.lineChart('lc', 660, 474, 572, 176, widest.name, `Avg ${numericCols[0].name}`);
  } else {
    p.text('none', 48, 150, 1100, 40, 'No numeric columns were detected, so there is nothing to average.', { size: 11, color: C.muted });
  }
  p.nav('02 Profile', '04 Responses');
  pages.push(p);
}

// 04 Responses
{
  const p = new Page('04 Responses');
  p.header(4, 'Responses', 'The rows themselves, with the free-text fields the profiler found. Filter here, then read the charts.');
  p.card('k0', 48, 150, 282, 100, 'Records');
  if (verbatimCols.length) p.card('k1', 348, 150, 282, 100, 'With comment');
  const cols = [idCol, ...dimCols.slice(0, 3), ...verbatimCols].slice(0, 6);
  p.table('t0', 48, 286, 1184, 374, cols.map((c) => colProj(c.name)));
  p.nav('03 Measures', '00 Cover');
  pages.push(p);
}

// ---------- write ----------
const NAME = CODE;
const reportDir = join(OUT, `${NAME}.Report`);
const modelDir = join(OUT, `${NAME}.SemanticModel`);
rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(reportDir, 'definition/pages'), { recursive: true });
mkdirSync(join(modelDir, 'definition/tables'), { recursive: true });
mkdirSync(join(modelDir, 'definition/cultures'), { recursive: true });
mkdirSync(join(reportDir, 'StaticResources/RegisteredResources'), { recursive: true });
// Keep the exact rows the model embeds next to the project. It is the same text that
// was parsed, so the render harness (scripts/render-oracura-report.mjs <project>) can
// draw the report, and a reviewer can see the input without hunting for the source.
mkdirSync(join(OUT, 'data'), { recursive: true });
writeFileSync(join(OUT, 'data/responses.csv'), rawText, 'utf8');
const w = (path, obj) => writeFileSync(path, typeof obj === 'string' ? obj : `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
// Commands quoted in the generated README should be repo-relative when the project
// lives inside the repo, and the real path only when it was written elsewhere.
const OUT_REL = (() => { const r = relative(ROOT, OUT); return !r || r.startsWith('..') ? OUT : r; })();

w(join(OUT, `${NAME}.pbip`), {
  $schema: 'https://developer.microsoft.com/json-schemas/fabric/pbip/pbipProperties/1.0.0/schema.json',
  version: '1.0',
  artifacts: [{ report: { path: `${NAME}.Report` } }],
  settings: { enableAutoRecovery: true },
});
w(join(reportDir, 'definition.pbir'), {
  $schema: 'https://developer.microsoft.com/json-schemas/fabric/item/report/definitionProperties/2.0.0/schema.json',
  version: '4.0',
  datasetReference: { byPath: { path: `../${NAME}.SemanticModel` } },
});
w(join(reportDir, 'definition/version.json'), {
  $schema: 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/versionMetadata/1.0.0/schema.json',
  version: '2.0.0',
});
w(join(reportDir, 'definition/report.json'), {
  $schema: 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/report/3.3.0/schema.json',
  themeCollection: { baseTheme: { name: 'CY26SU02', reportVersionAtImport: { visual: '2.7.0', report: '3.3.0', page: '2.1.0' }, type: 'SharedResources' } },
  resourcePackages: [{ name: 'RegisteredResources', type: 'RegisteredResources', items: [] }],
  settings: { useStylableVisualContainerHeader: true },
});
w(join(reportDir, 'definition/pages/pages.json'), { $schema: 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/pagesMetadata/1.1.0/schema.json', pageOrder: pages.map((p) => p.id), activePageName: pages[0].id });
for (const p of pages) {
  mkdirSync(join(reportDir, 'definition/pages', p.id), { recursive: true });
  w(join(reportDir, 'definition/pages', p.id, 'page.json'), p.json());
  if (!p.visuals.length) continue;
  mkdirSync(join(reportDir, 'definition/pages', p.id, 'visuals'), { recursive: true });
  for (const v of p.visuals) {
    mkdirSync(join(reportDir, 'definition/pages', p.id, 'visuals', v.name), { recursive: true });
    w(join(reportDir, 'definition/pages', p.id, 'visuals', v.name, 'visual.json'), v.json);
  }
}
w(join(modelDir, 'definition.pbism'), {
  $schema: 'https://developer.microsoft.com/json-schemas/fabric/item/semanticModel/definitionProperties/1.0.0/schema.json',
  version: '4.0',
  settings: { qnaEnabled: false },
});
w(join(modelDir, 'definition/database.tmdl'), `database ${NAME}\n\tcompatibilityLevel: 1567\n\tcompatibilityMode: powerBI\n\tlanguage: 1033\n`);
// `ref` lines are root-level: indenting them makes them children of `model` and
// Desktop fails with "Unexpected line type: ReferenceObject!".
w(join(modelDir, 'definition/model.tmdl'), `model Model\n\tculture: en-US\n\tdefaultPowerBIDataSourceVersion: powerBI_V3\n\tsourceQueryCulture: en-US\n\nannotation PBI_QueryOrder = ["Data","_Measures"]\n\nref table Data\nref table _Measures\n\nref cultureInfo en-US\n`);
w(join(modelDir, 'definition/cultures/en-US.tmdl'), 'cultureInfo en-US\n');
w(join(modelDir, 'definition/tables/Data.tmdl'), dataTable);
w(join(modelDir, 'definition/tables/_Measures.tmdl'), measuresTable);
w(join(OUT, 'profile.json'), {
  generatedFrom: basename(CSV),
  code: CODE,
  title: TITLE,
  rows: rows.length,
  identifier: idCol.name,
  dimensions: dimCols.map((d) => ({ column: d.name, distinct: d.distinct })),
  numerics: numericCols.map((n) => ({ column: n.name, type: typeOf(n) })),
  verbatims: verbatimCols.map((v) => ({ column: v.name, avgLength: v.avgLen, filled: v.filled })),
  measures: measures.map((m) => ({ name: m.name, expression: m.expression })),
  allColumns: profile.map((p) => ({ column: p.name, mName: p.mName, filled: p.filled, distinct: p.distinct, numericRatio: Number(p.numericRatio.toFixed(2)), avgLength: p.avgLen })),
});
w(join(OUT, 'README.md'), `# ${TITLE}\n\nGenerated from \`${basename(CSV)}\` by \`scripts/scaffold-questionnaire-report.mjs\`.\n\n- ${rows.length} responses, ${profile.length} columns\n- identifier: \`${idCol.name}\`\n- dimensions: ${dimCols.map((d) => `\`${d.name}\``).join(', ') || 'none'}\n- numerics: ${numericCols.map((n) => `\`${n.name}\``).join(', ') || 'none'}\n- verbatims: ${verbatimCols.map((v) => `\`${v.name}\``).join(', ') || 'none'}\n\n\`profile.json\` records every inference. To change what was detected, edit the CSV\nheader or pass \`--id\`; to get analysis the profiler cannot infer (driver analysis,\ncoded themes, benchmarks), build a bespoke report on this model the way ORACURA is\nbuilt over its own.\n\nVisual types used: ranked bars, a donut (share of the first dimension), a treemap\n(page 02), and on page 03 a scatter of the two numeric fields plus a line across the\nwidest dimension. Slots the profile cannot support are skipped rather than left blank.\n\n\`data/responses.csv\` is the parsed input, kept so the report can be re-rendered:\n\n\`\`\`bash\nnode scripts/render-oracura-report.mjs ${OUT_REL}\nnode scripts/screenshot-render.mjs ${OUT_REL}\npython3 scripts/contact-sheet.py ${OUT_REL}\n\`\`\`\n`);

// ---------- self-validation ----------
const errors = [];
const cols = new Set(profile.map((p) => p.name));
for (const p of pages) {
  for (const v of p.visuals) {
    const pos = v.json.position;
    if (!(pos.x >= 0 && pos.y >= 0 && pos.x + pos.width <= 1280.01 && pos.y + pos.height <= 720.01)) errors.push(`out of bounds: ${v.name}`);
    const qs = v.json.visual.query?.queryState ?? {};
    for (const state of Object.values(qs)) {
      for (const pr of state.projections ?? []) {
        if (pr.field.Column && !cols.has(pr.field.Column.Property)) errors.push(`unknown column ${pr.field.Column.Property}`);
        if (pr.field.Measure && !measures.some((m) => m.name === pr.field.Measure.Property)) errors.push(`unknown measure ${pr.field.Measure.Property}`);
      }
    }
  }
}
// Navigation buttons must point at pages this run actually created.
const pageIdsCreated = new Set(pages.map((p) => p.id));
for (const p of pages) {
  for (const v of p.visuals) {
    const link = v.json.visual?.visualContainerObjects?.visualLink?.[0]?.properties;
    if (!link) continue;
    const target = String(link.navigationSection?.expr?.Literal?.Value ?? '').replace(/^'|'$/g, '');
    if (!pageIdsCreated.has(target)) errors.push(`navigation target does not exist: ${target}`);
  }
}

const allTmdl = [dataTable, measuresTable].join('\n');
if (/\uFEFF/.test(allTmdl)) errors.push('TMDL contains a BOM');
if (/(?<!\/)\/\/(?!\/)/.test(allTmdl)) errors.push('TMDL contains // comments');
if (errors.length) {
  console.error(`FAIL\n- ${errors.join('\n- ')}`);
  process.exit(1);
}
console.log(`PASS: ${pages.length} pages, ${pages.reduce((s, p) => s + p.visuals.length, 0)} visuals, ${rows.length} rows -> ${OUT}`);
console.log(`      identifier=${idCol.name} dims=${dimCols.length} numerics=${numericCols.length} verbatims=${verbatimCols.length}`);
