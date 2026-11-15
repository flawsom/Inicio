#!/usr/bin/env node
/**
 * Render the ORACURA PBIP to HTML for visual review.
 *
 * This is NOT Power BI's renderer. It reads the report definition on disk
 * (page.json background, every visual.json position and query) and the embedded
 * CSV, computes each measure with the same filter semantics as the DAX, and lays
 * the result out at the report's real 1280x720 geometry. It exists so layout,
 * overlap, label truncation and blank-visual problems are caught by eye instead of
 * being assumed from JSON validity - the same reason Agentic-PBIP-Template uses a
 * Desktop screenshot loop. Anything a lens other than Power BI applies (chart
 * internals, slicing, smart titles) is approximated.
 *
 * Usage: node scripts/render-oracura-report.mjs [path/to/<CODE> project dir]
 * Output: reports/power-bi/oracura-render/*.html
 *
 * With no argument it renders the ORACURA report. Pointing it at a folder produced by
 * scripts/scaffold-questionnaire-report.mjs renders that one instead, which is how the
 * scaffolder's donut/treemap/scatter/line layouts get looked at rather than assumed.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROJ = resolve(process.argv[2] ?? join(ROOT, 'reports/power-bi/oracura'));
const REPORT_NAME = readdirSync(PROJ).find((d) => d.endsWith('.Report'));
if (!REPORT_NAME) throw new Error(`no *.Report folder in ${PROJ}`);
const REPORT = join(PROJ, REPORT_NAME, 'definition');
const DATA_DIR = join(PROJ, 'data');
const OUT = PROJ.endsWith('oracura') || PROJ.endsWith('oracura/')
  ? join(ROOT, 'reports/power-bi/oracura-render')
  : join(PROJ, 'render');
mkdirSync(OUT, { recursive: true });
// The renderer owns these files: a page that was renamed or removed since the last run
// must not linger, or the screenshots and contact sheet quietly show pages that no
// longer exist in the report.
for (const stale of readdirSync(OUT)) {
  if (/^page-.*\.html$/.test(stale)) rmSync(join(OUT, stale));
}

// ---------- data ----------
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
const CSV_FILE = existsSync(DATA_DIR) ? readdirSync(DATA_DIR).find((f) => f.endsWith('.csv')) : null;
if (!CSV_FILE) throw new Error(`no CSV in ${DATA_DIR} - the renderer needs the rows the model embeds`);
const data = parseCsv(readFileSync(join(DATA_DIR, CSV_FILE), 'utf8'));
// The model carries derived band columns; the CSV carries the raw scores.
// Same labels the semantic model uses, so the render does not invent its own wording.
const satBand = (n) => ({ 5: '5 Very satisfied', 4: '4 Satisfied', 3: '3 Neutral', 2: '2 Dissatisfied', 1: '1 Very dissatisfied' })[n] ?? '\u2014';
const recBand = (n) => (n >= 9 ? 'Promoter (9-10)' : n >= 7 ? 'Passive (7-8)' : 'Detractor (0-6)');
const ORDER = {
  Age: ['18-24', '25-34', '35-44', '45-54', '55+'],
  Timing: ['<3 months', '3-6 months', '6-12 months', '12-24 months', 'Do not remember'],
  Frequency: ['Daily', 'Several times a week', 'Once a week', 'A few times a month', 'Less often', 'Rarely', 'Never'],
  Expectation: ['Better than expected', 'About as expected', 'Worse than expected'],
  UsageChange: ['More frequent', 'About the same', 'Less frequent', 'Stopped'],
  Situation: ['Current', 'Occasionally', 'Stopped', 'Never used'],
  Household: ['Only me', 'Me and my partner', 'Whole family', 'Children'],
};
const rankOf = (col, row) => {
  const base = col.replace(/ order$/i, '');
  if (['Satisfaction', 'Recommend'].includes(base)) return Number(row[base]);
  const list = ORDER[base];
  if (!list) return 0;
  const i = list.findIndex((o) => String(row[base] ?? '').toLowerCase().startsWith(o.toLowerCase()));
  return i === -1 ? 99 : i + 1;
};
// Model column names -> CSV field names. Without this the tables look blank even
// though the model is correct.
const ALIAS = {
  RespId: 'Resp',
  'CF13 improve one': 'CF13_ImproveOne',
  'CF12 liked most': 'CF12_LikeMost',
  'CF9 reason change': 'CF9_ReasonChange',
  'CF15 score reason': 'CF15_RecommendReason',
  'CF16 anything else': 'CF16_AnythingElse',
  'Like theme': 'LikeTheme',
  'Improve theme': 'ImproveTheme',
};
for (const r of data) {
  for (const [model, csv] of Object.entries(ALIAS)) r[model] = r[csv] ?? '';
  r['Satisfaction band'] = satBand(Number(r.Satisfaction));
  r['Recommend band'] = recBand(Number(r.Recommend));
}

// ---------- measure engine (mirrors the TMDL definitions) ----------
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '-');
// Base counts first, rates derived from them - the same shape as the DAX, so the
// render cannot disagree with the model about how a number is built.
const COUNT = {
  Respondents: (r) => new Set(r.map((x) => x.Resp)).size,
  Evaluations: (r) => r.length,
  Promoters: (r) => r.filter((x) => Number(x.Recommend) >= 9).length,
  Detractors: (r) => r.filter((x) => Number(x.Recommend) <= 6).length,
  'Top-2 evaluations': (r) => r.filter((x) => Number(x.Satisfaction) >= 4).length,
  'Better than expected': (r) => r.filter((x) => x.Expectation === 'Better than expected').length,
  'About as expected': (r) => r.filter((x) => x.Expectation === 'About as expected').length,
  'Worse than expected': (r) => r.filter((x) => x.Expectation === 'Worse than expected').length,
  'Daily users': (r) => r.filter((x) => x.Frequency === 'Daily').length,
  'Current users': (r) => r.filter((x) => x.Situation === 'Current').length,
  Stopped: (r) => r.filter((x) => x.UsageChange === 'Stopped').length,
  Commented: (r) => r.filter((x) => x.CF13_ImproveOne).length,
  Verbatims: (r) => r.filter((x) => x.CF12_LikeMost || x.CF13_ImproveOne).length,
  'Detractor verbatims': (r) => r.filter((x) => Number(x.Recommend) <= 6 && x.CF13_ImproveOne).length,
  'Service mentions': (r) => r.filter((x) => /service/i.test(x.CF13_ImproveOne) || /care/i.test(x.CF13_ImproveOne)).length,
};
const rate = (base) => (r) => pct(COUNT[base](r), r.length);
const MEASURES = {
  ...Object.fromEntries(Object.entries(COUNT).map(([k, fn]) => [k, (r) => (k === 'Respondents' ? fn(r) : fn(r)).toLocaleString('en-US')])),
  'Avg satisfaction (1-5)': (r) => (r.length ? (r.reduce((s, x) => s + Number(x.Satisfaction), 0) / r.length).toFixed(2) : '-'),
  'Avg recommend (0-10)': (r) => (r.length ? (r.reduce((s, x) => s + Number(x.Recommend), 0) / r.length).toFixed(2) : '-'),
  'Top-2 satisfaction %': rate('Top-2 evaluations'),
  'Promoter %': rate('Promoters'),
  'Detractor %': rate('Detractors'),
  'Better than expected %': rate('Better than expected'),
  'Daily use %': rate('Daily users'),
  'Still using %': rate('Current users'),
  NPS: (r) => (r.length ? String(Math.round(((COUNT.Promoters(r) - COUNT.Detractors(r)) / r.length) * 100)) : '-'),
  // TOPN(1, VALUES(theme), [Evaluations], DESC) in DAX.
  'Top complaint': (r) => {
    const counts = new Map();
    for (const x of r) {
      const k = x.ImproveTheme ?? '(Blank)';
      if (k === 'No issue') continue;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '-';
  },
};
// The scaffolder's measures are Records and `Avg <column>`; anything unrecognised is
// shown as ?name so a missing definition is visible in the render, not silently zero.
const avgOf = (column, rows) => {
  const nums = rows.map((r) => Number(r[column])).filter((n) => Number.isFinite(n));
  return nums.length ? (nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(2) : '\u2014';
};
const evalMeasure = (name, rows) => {
  if (MEASURES[name]) return MEASURES[name](rows);
  if (name === 'Records') return rows.length.toLocaleString('en-US');
  if (name === 'Scale max 100') return '100';
  if (name === 'Scale min -100') return '-100';
  // The scaffolder's other card: how many rows filled a free-text field. It does not
  // record which column, so any verbatim-looking column counts as a comment here.
  if (name === 'With comment') {
    const keys = Object.keys(rows[0] ?? {}).filter((k) => /comment|verbatim|reason|why|feedback|improve|suggest/i.test(k));
    return rows.filter((r) => keys.some((k) => String(r[k] ?? '').trim() !== '')).length.toLocaleString('en-US');
  }
  const avg = /^Avg (.+)$/.exec(name);
  if (avg) return avgOf(avg[1], rows);
  return `?${name}`;
};

// ---------- pbir reading ----------
const lit = (v) => {
  if (!v || typeof v !== 'object') return v;
  if ('expr' in v) return lit(v.expr);
  if ('Literal' in v) {
    const raw = String(v.Literal.Value);
    if (/^'.*'$/.test(raw)) return raw.slice(1, -1);
    if (/^-?[\d.]+[DL]?$/.test(raw)) return Number(raw.replace(/[DL]$/, ''));
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return raw;
  }
  return undefined;
};
const prop = (objects, group, key) => lit(objects?.[group]?.[0]?.properties?.[key]);
const solid = (v) => lit(v?.solid?.color) ?? lit(v);

function agg(rows, catProp, valProp, isMeasure) {
  const buckets = new Map();
  for (const r of rows) {
    const k = r[catProp] === undefined || r[catProp] === '' ? '(Blank)' : r[catProp];
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(r);
  }
  const out = [...buckets.entries()].map(([k, rs]) => {
    const label = isMeasure ? evalMeasure(valProp, rs) : String(rs.length);
    return { key: k, label, rows: rs, n: Number(String(label).replace(/[%,\s]/g, '')) || 0 };
  });
  return out.sort((a, b) => b.n - a.n);
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const px = (pt) => `${(Number(String(pt).replace('pt', '')) * 1.34).toFixed(1)}px`;

const pages = JSON.parse(readFileSync(join(REPORT, 'pages/pages.json'), 'utf8')).pageOrder;

function renderPage(pageId, filter) {
  const page = JSON.parse(readFileSync(join(REPORT, 'pages', pageId, 'page.json'), 'utf8'));
  const bg = lit(page.objects?.background?.[0]?.properties?.color) ?? '#FFFFFF';
  const rows = filter ? data.filter((r) => r[filter.col] === filter.val) : data;
  const vdir = join(REPORT, 'pages', pageId, 'visuals');
  const visuals = existsSync(vdir) ? readdirSync(vdir).map((d) => JSON.parse(readFileSync(join(vdir, d, 'visual.json'), 'utf8'))) : [];
  visuals.sort((a, b) => (a.position.z ?? 0) - (b.position.z ?? 0) || (a.position.tabOrder ?? 0) - (b.position.tabOrder ?? 0));

  const parts = [];
  for (const v of visuals) {
    const p = v.position; const o = v.visual.objects ?? {}; const co = v.visual.visualContainerObjects ?? {};
    const box = `position:absolute;left:${p.x}px;top:${p.y}px;width:${p.width}px;height:${p.height}px;box-sizing:border-box;`;
    const fill = prop(co, 'background', 'show') === true ? solid(co.background[0].properties.color) : null;
    const border = prop(co, 'border', 'show') === true ? solid(co.border[0].properties.color) : null;
    const radius = Number(prop(co, 'border', 'radius') ?? 0);
    const shell = `background:${fill ?? 'transparent'};${border ? `border:1px solid ${border};` : ''}border-radius:${Math.min(radius, 12)}px;overflow:hidden;`;
    const vt = v.visual.visualType;

    if (vt === 'shape') {
      const c = solid(o.fill?.[0]?.properties?.fillColor);
      parts.push(`<div style="${box}background:${c ?? 'transparent'};"></div>`);
      continue;
    }
    if (vt === 'textbox') {
      const paras = o.general?.[0]?.properties?.paragraphs ?? [];
      const inner = paras.map((para) => {
        const run = para.textRuns?.[0] ?? {};
        const st = run.textStyle ?? {};
        const weight = /600|bold/i.test(String(st.fontWeight)) ? 600 : 400;
        return `<div style="font-family:'${st.fontFamily ?? 'Segoe UI'}',system-ui,sans-serif;font-size:${px(st.fontSize ?? '10pt')};color:${st.color ?? '#111'};font-weight:${weight};line-height:1.22;white-space:pre-wrap;">${esc(run.value) || '&nbsp;'}</div>`;
      }).join('');
      parts.push(`<div style="${box}${shell}padding:${fill ? '0' : '0'};">${inner}</div>`);
      continue;
    }
    if (vt === 'cardVisual') {
      const m = v.visual.query.queryState.Data.projections[0];
      const name = m.field.Measure.Property;
      const size = prop(o, 'value', 'fontSize') ?? 24;
      const labelSize = prop(o, 'label', 'fontSize') ?? 9;
      parts.push(`<div style="${box}${shell}padding:10px 12px;display:flex;flex-direction:column;justify-content:center;">
        <div style="font-family:'Segoe UI Semibold',Segoe UI,system-ui,sans-serif;font-size:${px(`${size}pt`)};font-weight:600;color:${solid(o.value?.[0]?.properties?.fontColor) ?? '#111'};line-height:1.05;">${esc(evalMeasure(name, rows))}</div>
        <div style="font-family:Segoe UI,system-ui,sans-serif;font-size:${px(`${labelSize}pt`)};color:${solid(o.label?.[0]?.properties?.fontColor) ?? '#666'};margin-top:4px;">${esc(name)}</div></div>`);
      continue;
    }
    if (vt === 'actionButton') {
      // The link target is opaque in the render; only the chrome is approximated.
      // Desktop stores a button's styling in the selectored (`id: 'default'`) entry and
      // only `show` in the unselectored first one. Reading entry 0, as this renderer
      // used to, drew every button as an empty pill, so the screenshots could not prove
      // the one thing asked for: that each button carries visible text.
      const styled = (bag, key) => (Array.isArray(bag) ? bag : []).find((e) => e.selector?.id === 'default')?.properties?.[key];
      const label = lit(styled(o.text, 'text')) ?? '';
      const color = solid(styled(o.text, 'fontColor')) ?? '#5A5148';
      const size = px(`${lit(styled(o.text, 'fontSize')) ?? 7.5}pt`);
      const bgc = lit(o.fill?.[0]?.properties?.show) === true ? (solid(styled(o.fill, 'fillColor')) ?? 'transparent') : 'transparent';
      parts.push(`<div style="${box}display:flex;align-items:center;justify-content:center;background:${bgc};border:1px solid #D8CEC2;border-radius:4px;font:${size} 'Segoe UI';color:${color};letter-spacing:.02em;white-space:nowrap;overflow:hidden;">${esc(label)}</div>`);
      continue;
    }
    if (vt === 'slicer') {
      const f = v.visual.query.queryState.Values.projections[0].field.Column;
      const chosen = filter && filter.col === f.Property ? filter.val : 'All';
      parts.push(`<div style="${box}${shell}padding:8px 12px;display:flex;flex-direction:column;justify-content:center;">
        <div style="font:600 ${px('9pt')} Segoe UI;color:#5A5148;">${esc(f.Property)}</div>
        <div style="margin-top:5px;display:flex;justify-content:space-between;align-items:center;border:1px solid #D8CEC2;border-radius:4px;padding:3px 7px;font:${px('9pt')} Segoe UI;color:#27221C;background:#fff;"><span>${esc(chosen)}</span><span style="color:#9A8E80;font-size:8px;">&#9660;</span></div>
        <div style="font:${px('8pt')} Segoe UI;color:#9A8E80;margin-top:3px;">${chosen === 'All' ? 'All values' : 'Filtered'}</div></div>`);
      continue;
    }
    if (vt === 'columnChart') {
      const qs = v.visual.query.queryState;
      const cat = qs.Category.projections[0].field.Column;
      const valP = qs.Y.projections[0].field;
      const isM = !!valP.Measure;
      const vName = (valP.Measure ?? valP.Column).Property;
      let series = agg(rows, cat.Property, vName, isM);
      const sortSpec = v.visual.query.sortDefinition?.sort?.[0];
      const sortCol = sortSpec?.field?.Column?.Property;
      if (sortCol && sortSpec.direction === 'Ascending') series.sort((a, b) => rankOf(sortCol, a.rows[0]) - rankOf(sortCol, b.rows[0]));
      const max = Math.max(...series.map((s) => s.n), 1);
      const color = solid(o.dataPoint?.[0]?.properties?.fill) ?? '#B4652F';
      const w = p.width / Math.max(series.length, 1);
      const body = series.map((s) => {
        const h = Math.max(2, (s.n / max) * 70);
        return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;gap:3px;">
          <div style="font:${px('7.5pt')} Segoe UI;color:#27221C;">${esc(s.label)}</div>
          <div style="width:${Math.min(34, w * 0.6)}px;height:${h}%;min-height:3px;background:${color};border-radius:2px 2px 0 0;"></div>
          <div style="font:${px('7pt')} Segoe UI;color:#5A5148;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;">${esc(s.key)}</div></div>`;
      }).join('');
      parts.push(`<div style="${box}${shell}padding:8px 8px 4px 8px;"><div style="display:flex;height:100%;gap:2px;">${body}</div></div>`);
      continue;
    }
    if (vt === 'clusteredBarChart') {
      const cat = v.visual.query.queryState.Category.projections[0].field.Column;
      const valP = v.visual.query.queryState.Y.projections[0].field;
      const isM = !!valP.Measure;
      const vName = (valP.Measure ?? valP.Column).Property;
      const series = agg(rows, cat.Property, vName, isM);
      const sortSpec = v.visual.query.sortDefinition?.sort?.[0];
      const sortCol = sortSpec?.field?.Column?.Property;
      if (sortCol && sortSpec.direction === 'Ascending') {
        // Ordinal axis: follow the model's sortByColumn, not the bar length.
        series.sort((a, b) => rankOf(sortCol, a.rows[0]) - rankOf(sortCol, b.rows[0]));
      }
      const max = Math.max(...series.map((s) => s.n), 1);
      const color = solid(o.dataPoint?.[0]?.properties?.fill) ?? '#B4652F';
      // Fit every category inside the plot area instead of overflowing the card.
      const rowH = (p.height - 18) / Math.max(series.length, 1);
      const barH = Math.max(4, Math.min(18, rowH - 6));
      const labSize = rowH < 15 ? '8pt' : '9pt';
      const body = series.map((s) => `<div style="display:flex;align-items:center;gap:6px;height:${rowH.toFixed(1)}px;">
          <div style="width:34%;font:${px(labSize)} Segoe UI;color:#27221C;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${esc(s.key)}">${esc(s.key)}</div>
          <div style="flex:1;background:#F2EBE1;border-radius:2px;height:${barH}px;position:relative;">
            <div style="position:absolute;inset:0 auto 0 0;width:${Math.max(2, (s.n / max) * 100)}%;background:${color};border-radius:2px;"></div>
          </div>
          <div style="width:44px;text-align:right;font:${px(labSize)} Segoe UI;color:#27221C;">${esc(s.label)}</div></div>`).join('');
      parts.push(`<div style="${box}${shell}padding:8px 10px;overflow:hidden;">${body}</div>`);
      continue;
    }
    if (vt === 'tableEx') {
      const projs = v.visual.query.queryState.Values.projections;
      const sort = v.visual.query.sortDefinition?.sort?.[0];
      let list = rows.slice();
      if (sort) {
        const f = sort.field.Measure ?? sort.field.Column;
        const isM = !!sort.field.Measure;
        const dir = sort.direction === 'Descending' ? -1 : 1;
        const val = (row) => (isM ? Number(evalMeasure(f.Property, [row])) : row[f.Property]);
        // Numeric columns must compare as numbers: '10' < '2' as strings, which put
        // score 10 above score 2 in the escalation queue.
        list.sort((a, b) => {
          const x = val(a), y = val(b);
          const nx = Number(String(x).replace(/[%,\s]/g, '')), ny = Number(String(y).replace(/[%,\s]/g, ''));
          const numeric = String(x).trim() !== '' && String(y).trim() !== '' && Number.isFinite(nx) && Number.isFinite(ny);
          const cmp = numeric ? nx - ny : String(x).localeCompare(String(y));
          return dir * (cmp || (a.RespId ?? 0) - (b.RespId ?? 0));
        });
      }
      const head = projs.map((pr) => (pr.field.Measure ?? pr.field.Column).Property);
      // A table visual groups by its column projections; showing raw rows here would
      // make the scoreboard look like unaggregated detail.
      const groupCols = projs.filter((pr) => pr.field.Column).map((pr) => pr.field.Column.Property);
      let grouped = list;
      if (groupCols.length) {
        const map = new Map();
        for (const r of list) {
          const key = groupCols.map((c) => r[c] ?? '(Blank)').join('\u0000');
          if (!map.has(key)) map.set(key, []);
          map.get(key).push(r);
        }
        grouped = [...map.entries()].map(([key, rs]) => ({ ...rs[0], __key: key, __rows: rs }));
        if (sort?.field.Measure) {
          const m = sort.field.Measure.Property;
          const dir = sort.direction === 'Descending' ? -1 : 1;
          grouped.sort((a, b) => dir * (Number(evalMeasure(m, a.__rows)) - Number(evalMeasure(m, b.__rows))));
        }
      }
      const valueFor = (pr, row) => (pr.field.Measure
        ? evalMeasure(pr.field.Measure.Property, row.__rows ?? [row])
        : row[pr.field.Column.Property]);
      const shown = grouped.slice(0, Math.max(3, Math.floor((p.height - 26) / 20)));
      const cell = (s, w) => `<div style="width:${w}%;padding:2px 5px;font:${px('8.5pt')} Segoe UI;color:#27221C;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(s)}">${esc(s)}</div>`;
      // Text columns get the room; identifiers and scores get a fixed slice.
      const weights = head.map((h) => (/CF1[236]|CF9/.test(h) ? 3.4 : 1));
      const total = weights.reduce((a, b) => a + b, 0);
      const widths = weights.map((w) => (w / total) * 100);
      const table = `<div style="display:flex;background:#EFE4D5;border-bottom:1px solid #D8CEC2;">${head.map((h, i) => `<div style="width:${widths[i]}%;padding:3px 5px;font:600 ${px('8pt')} Segoe UI;color:#5A5148;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${esc(h)}">${esc(h)}</div>`).join('')}</div>`
        + shown.map((r) => `<div style="display:flex;border-bottom:1px solid #F1EAE0;">${projs.map((pr, i) => cell(valueFor(pr, r), widths[i])).join('')}</div>`).join('');
      parts.push(`<div style="${box}${shell}padding:0;overflow:hidden;">${table}</div>`);
      continue;
    }
    if (vt === 'donutChart' || vt === 'pieChart') {
      const cat = v.visual.query.queryState.Category.projections[0].field.Column;
      const vName = v.visual.query.queryState.Y.projections[0].field.Measure.Property;
      const series = agg(rows, cat.Property, vName, true);
      const total = series.reduce((s, x) => s + x.n, 0) || 1;
      const palette = ['#B4431D','#0E6B63','#395B70','#70465F','#B27A1E','#66704A','#C07A3A','#7B8E6E'];
      let angle = 0;
      const stops = series.map((s, i) => { const share = (s.n / total) * 360; const from = angle; angle += share; return `${palette[i % palette.length]} ${from}deg ${angle}deg`; });
      const r = 46;
      const ring = vt === 'donutChart'
        ? `<div style="width:${r*2}px;height:${r*2}px;border-radius:50%;background:conic-gradient(${stops.join(',')});position:relative;flex:none;"><div style="position:absolute;inset:15px;background:#FFFDF9;border-radius:50%;display:flex;align-items:center;justify-content:center;font:600 ${px('9pt')} Segoe UI;color:#27221C;">${total}</div></div>`
        : `<div style="width:${r*2}px;height:${r*2}px;border-radius:50%;background:conic-gradient(${stops.join(',')});flex:none;"></div>`;
      const legend = series.map((s, i) => `<div style="display:flex;align-items:center;gap:6px;height:16px;"><span style="width:8px;height:8px;border-radius:2px;background:${palette[i % palette.length]};"></span><span style="font:${px('8.5pt')} Segoe UI;color:#27221C;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(s.key)}</span><span style="font:${px('8.5pt')} Segoe UI;color:#27221C;">${((s.n/total)*100).toFixed(1)}%</span></div>`).join('');
      parts.push(`<div style="${box}${shell}padding:10px;display:flex;align-items:center;gap:14px;">${ring}<div style="flex:1;min-width:0;">${legend}</div></div>`);
      continue;
    }
    if (vt === 'funnel') {
      const stages = [['Evaluations', COUNT.Evaluations(rows)], ['Current users', COUNT['Current users'](rows)], ['Daily users', COUNT['Daily users'](rows)], ['Promoters', COUNT.Promoters(rows)]];
      const max = Math.max(...stages.map((s) => s[1]), 1);
      const palette = ['#395B70','#0E6B63','#B27A1E','#B4431D'];
      const body = stages.map(([name, value], i) => {
        const w = Math.max(8, (value / max) * 100);
        const inset = (100 - w) / 2;
        const next = stages[i + 1] ? Math.max(8, (stages[i + 1][1] / max) * 100) : w;
        const clip = `polygon(${inset}% 0, ${100 - inset}% 0, ${100 - (100 - next) / 2}% 100%, ${(100 - next) / 2}% 100%)`;
        return `<div style="height:38px;display:flex;align-items:center;gap:8px;"><div style="flex:1;height:30px;position:relative;"><div style="position:absolute;inset:0;background:${palette[i]};clip-path:${clip};opacity:0.92;"></div><div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:600 ${px('8.5pt')} Segoe UI;color:#FFFDF9;">${esc(name)} · ${value}</div></div></div>`;
      }).join('');
      parts.push(`<div style="${box}${shell}padding:8px 12px;">${body}</div>`);
      continue;
    }
    if (vt === 'scatterChart') {
      const qs = v.visual.query.queryState;
      const cat = qs.Category.projections[0].field.Column;
      // Read the axis measures from the visual itself; guessing score columns would
      // draw a plausible-looking map that is not the one in the report.
      const xName = (qs.X?.projections?.[0]?.field?.Measure ?? {}).Property;
      const yName = (qs.Y?.projections?.[0]?.field?.Measure ?? {}).Property;
      const sizeName = (qs.Size?.projections?.[0]?.field?.Measure ?? {}).Property;
      const keys = [...new Set(rows.map((r) => r[cat.Property] ?? '(Blank)'))];
      const points = keys.map((k) => {
        const rs = rows.filter((r) => (r[cat.Property] ?? '(Blank)') === k);
        return { key: k, x: Number(evalMeasure(xName, rs)), y: Number(evalMeasure(yName, rs)), n: sizeName ? Number(evalMeasure(sizeName, rs)) : rs.length };
      }).filter((pt) => Number.isFinite(pt.x) && Number.isFinite(pt.y));
      const xAll = points.map((pt) => pt.x);
      const yAll = points.map((pt) => pt.y);
      const xPad = (Math.max(...xAll) - Math.min(...xAll)) * 0.15 || 0.5;
      const yPad = (Math.max(...yAll) - Math.min(...yAll)) * 0.15 || 0.5;
      const xMin = Math.min(...xAll) - xPad, xMax = Math.max(...xAll) + xPad;
      const yMin = Math.min(...yAll) - yPad, yMax = Math.max(...yAll) + yPad;
      const maxN = Math.max(...points.map((pt) => pt.n), 1);
      const dots = points.map((pt, i) => {
        const lx = 8 + ((pt.x - xMin) / (xMax - xMin || 1)) * 84;
        const ly = 88 - ((pt.y - yMin) / (yMax - yMin || 1)) * 76;
        const d = 8 + (pt.n / maxN) * 14;
        // Alternating the label above/below the bubble keeps two nearly identical
        // points (Combo and Flosser sit within 0.02 of each other) readable.
        const labelY = i % 2 ? `calc(${ly}% - ${d / 2 + 12}px)` : `calc(${ly}% + ${d / 2 + 2}px)`;
        return `<div style="position:absolute;left:${lx}%;top:${ly}%;width:${d}px;height:${d}px;margin:-${d / 2}px 0 0 -${d / 2}px;background:rgba(180,67,29,.82);border-radius:50%;" title="${esc(pt.key)} ${xName} ${pt.x.toFixed(2)} ${yName} ${pt.y.toFixed(2)} n=${pt.n}"></div><div style="position:absolute;left:${lx}%;top:${labelY};transform:translateX(-50%);font:${px('7.5pt')} Segoe UI;color:#5A5148;white-space:nowrap;">${esc(pt.key)}</div>`;
      }).join('');
      const fmt = (n) => (Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(1));
      parts.push(`<div style="${box}${shell}padding:6px 8px 4px 8px;"><div style="position:relative;height:86%;">${dots}</div><div style="display:flex;justify-content:space-between;font:${px('7pt')} Segoe UI;color:#A79B8D;"><span>${esc(xName)} ${fmt(xMin)}</span><span>${fmt(xMax)}</span></div><div style="position:absolute;left:0;top:0;height:100%;display:flex;align-items:center;"><span style="writing-mode:vertical-rl;transform:rotate(180deg);font:${px('7pt')} Segoe UI;color:#A79B8D;">${esc(yName)}</span></div></div>`);
      continue;
    }
    if (vt === 'treemap') {
      const g = v.visual.query.queryState.Group.projections[0].field.Column;
      // Details is optional in the schema; without it the treemap draws one level.
      const d = v.visual.query.queryState.Details?.projections?.[0]?.field?.Column ?? null;
      const cities = agg(rows, g.Property, 'Evaluations', true);
      const total = cities.reduce((s, x) => s + x.n, 0) || 1;
      const palette = ['#B4431D','#0E6B63','#395B70','#70465F','#B27A1E','#66704A'];
      if (!d) {
        // One level: a treemap fills the rectangle, it does not line tiles up in columns.
        // Recursive halving by area keeps the aspect ratios close to square, which is
        // what makes the real visual readable at this size.
        const tiles = [];
        const place = (items, x, y, w, h) => {
          if (!items.length) return;
          if (items.length === 1) { tiles.push({ item: items[0], x, y, w, h }); return; }
          const sum = items.reduce((s, it) => s + it.n, 0) || 1;
          let acc = 0, split = 1;
          for (let i = 0; i < items.length - 1; i += 1) { acc += items[i].n; if (acc >= sum / 2) { split = i + 1; break; } }
          const head = items.slice(0, split), tail = items.slice(split);
          const share = head.reduce((s, it) => s + it.n, 0) / sum;
          if (w >= h) { place(head, x, y, w * share, h); place(tail, x + w * share, y, w * (1 - share), h); }
          else { place(head, x, y, w, h * share); place(tail, x, y + h * share, w, h * (1 - share)); }
        };
        place([...cities].sort((a, b) => b.n - a.n), 0, 0, 100, 100);
        const cells = tiles.map(({ item, x, y, w, h }, i) => `<div style="position:absolute;left:${x}%;top:${y}%;width:${w}%;height:${h}%;box-sizing:border-box;border:1px solid #FFFDF9;background:${palette[i % palette.length]};display:flex;flex-direction:column;justify-content:center;padding:0 5px;overflow:hidden;"><div style="font:600 ${px('8.5pt')} Segoe UI;color:#FFFDF9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(item.key)}</div><div style="font:${px('7.5pt')} Segoe UI;color:rgba(255,253,249,.85);">${esc(item.label)}</div></div>`).join('');
        parts.push(`<div style="${box}${shell}padding:0;"><div style="position:relative;height:100%;">${cells}</div></div>`);
        continue;
      }
      const body = cities.map((c) => {
        const w = Math.max(6, (c.n / total) * 100);
        const subs = agg(c.rows, d.Property, 'Evaluations', true);
        const subTotal = subs.reduce((s, x) => s + x.n, 0) || 1;
        const tiles = subs.map((s2, i) => `<div style="height:${(s2.n / subTotal) * 100}%;min-height:8px;background:${palette[i % palette.length]};opacity:${0.85 - i * 0.06};display:flex;align-items:center;padding:0 4px;font:${px('7pt')} Segoe UI;color:#FFFDF9;overflow:hidden;white-space:nowrap;">${esc(s2.key)}</div>`).join('');
        return `<div style="width:${w}%;height:100%;border:0.5px solid #FFFDF9;display:flex;flex-direction:column;overflow:hidden;"><div style="font:600 ${px('8pt')} Segoe UI;color:#27221C;padding:2px 3px;background:rgba(255,253,249,.8);">${esc(c.key)}</div>${tiles}</div>`;
      }).join('');
      parts.push(`<div style="${box}${shell}padding:0;"><div style="display:flex;height:100%;gap:0;">${body}</div></div>`);
      continue;
    }
    if (vt === 'lineChart') {
      const ax = v.visual.query.queryState.Axis.projections[0].field.Column;
      const vName = v.visual.query.queryState.Values.projections[0].field.Measure.Property;
      let series = agg(rows, ax.Property, vName, true).map((s) => ({ key: s.key, y: s.n == 0 ? 0 : Number(evalMeasure(vName, s.rows)), rows: s.rows }));
      const sortSpec = v.visual.query.sortDefinition?.sort?.[0];
      const sortCol = sortSpec?.field?.Column?.Property;
      if (sortCol) series.sort((a, b) => rankOf(sortCol, a.rows[0]) - rankOf(sortCol, b.rows[0]));
      const maxY = Math.max(...series.map((s) => s.y), 0.01);
      const W = 560, H = 100;
      const points = series.map((s, i) => ({ x: 30 + (i * (W - 40)) / Math.max(series.length - 1, 1), y: H - 18 - (s.y / maxY) * (H - 30), label: s.key, value: s.y }));
      const path = points.map((pt, i) => `${i ? 'L' : 'M'}${pt.x},${pt.y}`).join(' ');
      const markers = points.map((pt) => `<circle cx="${pt.x}" cy="${pt.y}" r="3" fill="#B4431D"/><text x="${pt.x}" y="${pt.y - 7}" text-anchor="middle" font-size="8" fill="#27221C" font-family="Segoe UI">${esc(pt.value.toFixed(1))}</text><text x="${pt.x}" y="${H - 4}" text-anchor="middle" font-size="7" fill="#5A5148" font-family="Segoe UI">${esc(pt.label.slice(0, 12))}</text>`).join('');
      parts.push(`<div style="${box}${shell}padding:6px 8px;"><svg width="100%" height="100%" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><path d="${path}" fill="none" stroke="#B4431D" stroke-width="2"/>${markers}</svg></div>`);
      continue;
    }
    if (vt === 'columnChart' && v.visual.query.queryState.Y.projections.length > 1) {
      const cat = v.visual.query.queryState.Category.projections[0].field.Column;
      const vals = v.visual.query.queryState.Y.projections.map((pr) => pr.field.Measure.Property);
      const cats = agg(rows, cat.Property, vals[0], true);
      const palette = ['#0E6B63','#B4431D','#395B70'];
      const totals = cats.map((c) => vals.reduce((s, v) => s + Number(evalMeasure(v, c.rows)), 0));
      const max = Math.max(...totals, 1);
      const body = cats.map((c) => {
        let bottom = 0;
        const segs = vals.map((v, vi) => { const n = Number(evalMeasure(v, c.rows)); const h = (n / max) * 100; const seg = `<div style="position:absolute;left:30%;right:30%;bottom:${bottom}%;height:${h}%;background:${palette[vi % palette.length]};"></div>`; bottom += h; return seg; }).join('');
        return `<div style="flex:1;position:relative;height:100%;"><div style="position:absolute;inset:0 0 14px 0;">${segs}</div><div style="position:absolute;bottom:0;left:0;right:0;text-align:center;font:${px('7.5pt')} Segoe UI;color:#27221C;white-space:nowrap;overflow:hidden;">${esc(c.key)}</div></div>`;
      }).join('');
      parts.push(`<div style="${box}${shell}padding:8px 6px 6px 6px;"><div style="display:flex;height:100%;gap:4px;">${body}</div><div style="display:flex;gap:8px;font:${px('7.5pt')} Segoe UI;color:#5A5148;">${vals.map((v, i) => `<span style="color:${palette[i]};">\u25a0</span> ${esc(v)}`).join('')}</div></div>`);
      continue;
    }
    if (vt === 'gauge') {
      const qs = v.visual.query.queryState;
      const num = (s) => Number(String(s).replace(/[%,\s]/g, ''));
      const val = (role, fallback) => {
        const p = qs[role]?.projections?.[0]?.field;
        return p ? num(evalMeasure(p.Measure.Property, rows)) : fallback;
      };
      const value = val('Y', 0);
      const min = val('MinValue', 0);
      const max = val('MaxValue', Math.max(value, min + 1));
      const target = Number.isFinite(val('TargetValue', NaN)) ? val('TargetValue', NaN) : null;
      const W = 200, H = 120;
      // Gauge scale: value relative position across min..max, drawn as a semicircle.
      const frac = Math.min(1, Math.max(0, (value - min) / (max - min || 1)));
      const arc = (f, r) => `M ${W / 2 - r} ${H - 12} A ${r} ${r} 0 0 1 ${W / 2 + r} ${H - 12}`;
      const progLen = Math.ceil(frac * 100);
      const tick = (f, len) => {
        const a = Math.PI * (1 - f);
        const r = 78;
        return `<line x1="${W / 2 + Math.cos(a) * (r - len)}" y1="${H - 12 - Math.sin(a) * (r - len)}" x2="${W / 2 + Math.cos(a) * r}" y2="${H - 12 - Math.sin(a) * r}" stroke="#756A5E" stroke-width="1"/>`;
      };
      const dot = (f, r) => {
        const a = Math.PI * (1 - f);
        return `<circle cx="${W / 2 + Math.cos(a) * r}" cy="${H - 12 - Math.sin(a) * r}" r="3.5" fill="#B4431D"/>`;
      };
      const color = solid(o.dataPoint?.[0]?.properties?.fill) ?? '#B4431D';
      // End-cap knob at the current value, like the reference's quarter-arc gauges.
      const knobA = Math.PI * (1 - frac);
      const knob = `<circle cx="${W / 2 + Math.cos(knobA) * 78}" cy="${H - 12 - Math.sin(knobA) * 78}" r="5" fill="${color}" stroke="#FFFDF9" stroke-width="1.5"/>`;
      parts.push(`<div style="${box}${shell}padding:4px 8px 4px 8px;">
        <svg viewBox="0 0 ${W} ${H}" width="100%" height="100%" style="display:block;">
          <path d="${arc(1, 78)}" fill="none" stroke="#EFE4D5" stroke-width="10" stroke-linecap="round"/>
          <path d="${arc(1, 78)}" fill="none" stroke="${color}" stroke-width="10" stroke-linecap="round" stroke-dasharray="${progLen} 100" pathLength="100"/>
          ${target !== null ? dot(Math.min(1, Math.max(0, (target - min) / (max - min || 1))), 78) : ''}
          ${knob}
          ${tick(0, 6)}${tick(1, 6)}
          <text x="${W / 2}" y="${H - 22}" text-anchor="middle" font-size="16" font-weight="600" fill="#1C1917" font-family="Segoe UI Semibold">${Number.isInteger(value) ? value : value.toFixed(1)}</text>
          <text x="8" y="${H - 4}" font-size="8" fill="#A79B8D" font-family="Segoe UI">${min}</text>
          <text x="${W - 8}" y="${H - 4}" text-anchor="end" font-size="8" fill="#A79B8D" font-family="Segoe UI">${max}</text>
        </svg></div>`);
      continue;
    }
    if (vt === 'lineStackedColumnComboChart') {
      const qs = v.visual.query.queryState;
      const cat = qs.Category.projections[0].field.Column;
      const yName = qs.Y.projections[0].field.Measure.Property;
      const y2Name = qs.Y2.projections[0].field.Measure.Property;
      const cats = agg(rows, cat.Property, yName, true).sort((a, b) => a.key.localeCompare(b.key));
      const yMax = Math.max(...cats.map((c) => Number(evalMeasure(yName, c.rows))), 1);
      const y2Vals = cats.map((c) => Number(evalMeasure(y2Name, c.rows)));
      const y2Min = Math.min(...y2Vals), y2Max = Math.max(...y2Vals);
      const W = 560, H = 150;
      const bandH = H - 26;
      const bw = (W - 60) / Math.max(cats.length, 1);
      const cols = cats.map((c, i) => {
        const n = Number(evalMeasure(yName, c.rows));
        const x = 30 + i * bw + bw * 0.18, cw = bw * 0.64;
        const hgt = (n / yMax) * (bandH - 22);
        return `<rect x="${x}" y="${H - 18 - hgt}" width="${cw}" height="${hgt}" rx="2" fill="#B4652F"/><text x="${x + cw / 2}" y="${H - 4}" text-anchor="middle" font-size="8" fill="#5A5148" font-family="Segoe UI">${esc(c.key.slice(0, 12))}</text>`;
      }).join('');
      const pts = cats.map((c, i) => {
        const y2 = Number(evalMeasure(y2Name, c.rows));
        const x = 30 + i * bw + bw / 2;
        const yy = y2Max === y2Min ? bandH / 2 + 6 : (bandH - 22) - ((y2 - y2Min) / (y2Max - y2Min)) * (bandH - 30) + 6;
        return `${x.toFixed(1)},${(H - 18 - yy).toFixed(1)}`;
      }).join(' ');
      const line = `<polyline points="${pts}" fill="none" stroke="#0E6B63" stroke-width="2"/>`;
      parts.push(`<div style="${box}${shell}padding:6px 8px;"><svg width="100%" height="100%" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${cols}${line}</svg><div style="display:flex;gap:12px;font:${px('7.5pt')} Segoe UI;color:#5A5148;"><span style="color:#B4652F;">\u25a0</span> ${esc(yName)}<span style="color:#0E6B63;">\u25cf</span> ${esc(y2Name)}</div></div>`);
      continue;
    }
    if (vt === 'areaChart' || vt === 'stackedAreaChart') {
      const qs = v.visual.query.queryState;
      const cat = qs.Category.projections[0].field.Column;
      const vName = qs.Y.projections[0].field.Measure.Property;
      let series = agg(rows, cat.Property, vName, true).map((s) => ({ key: s.key, y: Number(evalMeasure(vName, s.rows)), rows: s.rows }));
      const sortSpec = v.visual.query.sortDefinition?.sort?.[0];
      const sortCol = sortSpec?.field?.Column?.Property;
      if (sortCol) series.sort((a, b) => rankOf(sortCol, a.rows[0]) - rankOf(sortCol, b.rows[0]));
      const maxY = Math.max(...series.map((s) => s.y), 0.01);
      const W = 560, H = 150;
      const pts = series.map((s, i) => ({ x: 30 + (i * (W - 60)) / Math.max(series.length - 1, 1), y: H - 22 - (s.y / maxY) * (H - 46), label: s.key, value: s.y }));
      const line = pts.map((pt, i) => `${i ? 'L' : 'M'}${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).join(' ');
      const area = pts.length ? `M${pts[0].x},${H - 22} ${line.slice(1)} L${pts[pts.length - 1].x},${H - 22} Z` : '';
      const markers = pts.map((pt) => `<text x="${pt.x}" y="${pt.y - 6}" text-anchor="middle" font-size="8" fill="#27221C" font-family="Segoe UI">${esc(String(pt.value.toFixed(2)).replace(/\.?0+$/, ''))}</text><text x="${pt.x}" y="${H - 6}" text-anchor="middle" font-size="7" fill="#5A5148" font-family="Segoe UI">${esc(pt.label.slice(0, 14))}</text>`).join('');
      parts.push(`<div style="${box}${shell}padding:6px 8px;"><svg width="100%" height="100%" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><path d="${area}" fill="#B4431D" opacity="0.25"/><path d="${line}" fill="none" stroke="#B4431D" stroke-width="2"/>${markers}</svg></div>`);
      continue;
    }
    if (vt === 'waterfallChart') {
      const qs = v.visual.query.queryState;
      const cat = qs.Category.projections[0].field.Column;
      const vName = qs.Y.projections[0].field.Measure.Property;
      const series = agg(rows, cat.Property, vName, true);
      const vals = series.map((s) => Number(evalMeasure(vName, s.rows)));
      const total = vals.reduce((a, b) => a + b, 0) || 1;
      const maxCum = series.reduce((a, _, i) => Math.max(a, vals.slice(0, i + 1).reduce((x, y) => x + y, 0)), 0) || total;
      const W = 560, H = 190;
      const bandH = H - 40;
      let cum = 0;
      const bw = (W - 60) / Math.max(series.length, 1);
      const blocks = series.map((s, i) => {
        const n = vals[i];
        const prev = cum; cum += n;
        const x = 30 + i * bw + bw * 0.15, cw = bw * 0.7;
        const y1 = H - 24 - (cum / maxCum) * bandH;
        const y2 = H - 24 - (prev / maxCum) * bandH;
        const connector = i === 0 ? '' : `<line x1="${x - bw * 0.3}" y1="${y2}" x2="${x}" y2="${y2}" stroke="#A79B8D" stroke-dasharray="3 3"/>`;
        return `${connector}<rect x="${x}" y="${y1}" width="${cw}" height="${Math.max(2, y2 - y1)}" rx="2" fill="${i % 2 ? '#0E6B63' : '#B4431D'}"/><text x="${x + cw / 2}" y="${y1 - 5}" text-anchor="middle" font-size="8" fill="#27221C" font-family="Segoe UI">${n}</text><text x="${x + cw / 2}" y="${H - 8}" text-anchor="middle" font-size="7" fill="#5A5148" font-family="Segoe UI">${esc(s.key.slice(0, 14))}</text>`;
      }).join('');
      parts.push(`<div style="${box}${shell}padding:6px 8px;"><svg width="100%" height="100%" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${blocks}</svg></div>`);
      continue;
    }
    if (vt === 'pivotTable') {
      // Matrix heatmap: distinct row/col keys, per-cell measure over the intersection.
      const qs = v.visual.query.queryState;
      const rowP = qs.Rows.projections[0].field.Column.Property;
      const colP = qs.Columns.projections[0].field.Column.Property;
      const vName = qs.Values.projections[0].field.Measure.Property;
      const rowKeys = [...new Set(rows.map((r) => r[rowP] ?? '(Blank)'))].sort();
      const colKeys = [...new Set(rows.map((r) => r[colP] ?? '(Blank)'))].sort();
      const cells = colKeys.map((c) => rowKeys.map((r) => {
        const sub = rows.filter((x) => (x[rowP] ?? '(Blank)') === r && (x[colP] ?? '(Blank)') === c);
        return sub.length ? Number(String(evalMeasure(vName, sub)).replace(/[%,\s]/g, '')) || 0 : 0;
      }));
      const maxV = Math.max(...cells.flat(), 1);
      const shade = (n) => {
        const t = Math.min(1, n / maxV);
        const r = Math.round(247 + (180 - 247) * t), g = Math.round(243 + (67 - 243) * t), b = Math.round(236 + (29 - 236) * t);
        return `rgb(${r},${g},${b})`;
      };
      const head = `<div style="display:flex;"><div style="width:92px;flex:none;"></div>${colKeys.map((c) => `<div style="flex:1;font:${px('6.5pt')} Segoe UI;color:#5A5148;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:2px 0;" title="${esc(c)}">${esc(c.slice(0, 6))}</div>`).join('')}</div>`;
      const body = rowKeys.map((r, ri) => `<div style="display:flex;align-items:stretch;"><div style="width:92px;flex:none;font:${px('7.5pt')} Segoe UI;color:#27221C;display:flex;align-items:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-right:4px;" title="${esc(r)}">${esc(r)}</div>${colKeys.map((c, ci) => { const n = cells[ci][ri]; return `<div style="flex:1;background:${shade(n)};border:1px solid #FBF6EE;height:24px;display:flex;align-items:center;justify-content:center;font:${px('7.5pt')} Segoe UI;color:${n / maxV > 0.55 ? '#FBF6EE' : '#27221C'};">${n ? n : ''}</div>`; }).join('')}</div>`).join('');
      parts.push(`<div style="${box}${shell}padding:8px 8px 6px 8px;overflow:hidden;">${head}${body}</div>`);
      continue;
    }
    if (vt === 'keyDriversVisual') {
      // Approximation for review: per-dimension group value of the analyzed measure,
      // ranked; Desktop's Key Influencers does this with a model influence score.
      const qs = v.visual.query.queryState;
      const projection = qs.Analyze?.projections?.[0] ?? qs.Y?.projections?.[0];
      const yName = projection?.field?.Measure?.Property;
      if (!yName) continue;
      const legend = (qs.ExplainBy?.projections ?? qs.Legend?.projections ?? []).map((pr) => pr.field.Column.Property);
      const num = (s) => Number(String(s).replace(/[%,\s]/g, ''));
      // evalMeasure over a subset already returns the group value (NPS), so no divide.
      const rank = (dim) => agg(rows, dim, yName, true).map((s) => ({ key: s.key, mean: num(evalMeasure(yName, s.rows)) }));
      const blocks = legend.map((dim) => {
        const list = rank(dim).sort((a, b) => b.mean - a.mean);
        const maxM = Math.max(...list.map((x) => Math.abs(x.mean)), 1);
        const rowsHtml = list.map((x) => `<div style="display:flex;align-items:center;gap:4px;height:14px;">
          <div style="width:36%;font:${px('7pt')} Segoe UI;color:#27221C;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(x.key)}</div>
          <div style="flex:1;background:#F2EBE1;border-radius:2px;height:8px;"><div style="height:8px;width:${Math.max(2, (Math.abs(x.mean) / maxM) * 100)}%;background:${x.mean >= 0 ? '#0E6B63' : '#B4431D'};border-radius:2px;"></div></div>
          <div style="width:34px;text-align:right;font:${px('7pt')} Segoe UI;color:#27221C;">${x.mean.toFixed(1)}</div></div>`).join('');
        return `<div style="flex:1;"><div style="font:${px('8pt')} Segoe UI Semibold;color:#5A5148;margin-bottom:4px;">${esc(dim)} - top/bottom mean ${esc(yName)}</div>${rowsHtml}</div>`;
      }).join('');
      parts.push(`<div style="${box}${shell}padding:8px 10px;overflow:hidden;"><div style="display:flex;gap:12px;height:100%;">${blocks}</div></div>`);
      continue;
    }
    parts.push(`<div style="${box}${shell}outline:1px dashed #C00;"><span style="font:10px Segoe UI;color:#C00;">unrendered ${esc(vt)}</span></div>`);
  }

  const note = filter ? `<div style="position:absolute;right:6px;bottom:2px;font:8px Segoe UI;color:#9A8E80;">render check · filtered ${filter.col}=${filter.val}</div>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:#2A2521;}
  .page{position:relative;width:1280px;height:720px;background:${bg};overflow:hidden;font-family:Segoe UI,system-ui,sans-serif;}
  </style></head><body><div class="page">${parts.join('')}${note}</div></body></html>`;
}

// pageOrder holds page ids; the display name lives in each page.json.
const pageMeta = pages.map((id) => ({ id, displayName: JSON.parse(readFileSync(join(REPORT, 'pages', id, 'page.json'), 'utf8')).displayName }));
const slug = (s) => s.replace(/\s+/g, '-').replace(/[^a-z0-9-]/gi, '').toLowerCase();
const written = [];
for (const { id, displayName } of pageMeta) {
  const file = `page-${slug(displayName)}.html`;
  writeFileSync(join(OUT, file), renderPage(id), 'utf8');
  written.push([displayName, file]);
}
// Filtered state: proves the slicers actually cut the numbers, not just the chrome.
// Only for columns this file actually has - a filter on a missing column renders empty
// charts, which would look like a broken report rather than a skipped check.
const hasColumn = (col) => data.some((r) => r[col] !== undefined);
for (const [pageName, suffix, filter] of [['00 Overview', 'filtered-female', { col: 'Gender', val: 'Female' }], ['03 Who bought what', 'filtered-family-flosser', { col: 'Family', val: 'Flosser' }]]) {
  if (!hasColumn(filter.col)) continue;
  const meta = pageMeta.find((m) => m.displayName === pageName) ?? pageMeta[1];
  const file = `page-${slug(meta.displayName)}--${suffix}.html`;
  writeFileSync(join(OUT, file), renderPage(meta.id, filter), 'utf8');
  written.push([`${meta.displayName} (${suffix})`, file]);
}
// Single-entry harness: the preview proxy only routes the root path, so all pages
// are inlined here and selected with ?p=<index>.
const inline = written.map(([name, file], i) => `<div class="frame" id="p${i}" data-name="${esc(name)}">${readFileSync(join(OUT, file), 'utf8').replace(/^[\s\S]*?<body>/, '').replace(/<\/body>[\s\S]*$/, '')}</div>`).join('\n');
const index = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:#2A2521;} .frame{display:none;} .frame.on{display:block;}
</style></head><body>${inline}
<script>const i=Math.max(0,Math.min(${written.length - 1},Number(new URLSearchParams(location.search).get('p')||0)));document.getElementById('p'+i).classList.add('on');</script>
</body></html>`;
writeFileSync(join(OUT, 'index.html'), index, 'utf8');
console.log(`rendered ${written.length} pages -> ${OUT}`);
