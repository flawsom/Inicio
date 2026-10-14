/**
 * Minimal XLSX reader/writer.
 *
 * Why not a spreadsheet library: the adapter set needs *round-trip control*, not
 * features. Everything in XLSForm is a string cell in a three-sheet workbook, and
 * the failure mode we care about is silently mangled values (shared vs inline
 * strings, sparse rows, type coercion to numbers). Owning ~200 lines of SpreadsheetML
 * is cheaper than owning a dependency we cannot verify against openpyxl/ODK.
 *
 * Scope: shared strings (read+write), inline strings (read), numbers, booleans,
 * sparse rows, multiple sheets, sheet-order preservation. No styles beyond a
 * minimal stub, no formulas, no formatting.
 */
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

export interface Sheet {
  name: string;
  /** Row-major cell values as text. Trailing empty cells are trimmed. */
  rows: string[][];
}

/**
 * What a cell may be when writing. Numbers and booleans are written as real typed
 * cells (not text), so a data export does not arrive full of "number stored as text"
 * warnings — and so `SUM()` works.
 */
export type CellValue = string | number | boolean | null;

export interface OutSheet {
  name: string;
  rows: CellValue[][];
}

export interface Workbook {
  sheets: Sheet[];
}

/* ------------------------------------------------------------------ helpers */

export function colName(index: number): string {
  let s = '';
  let n = index;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

export function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c >= 65 && c <= 90) n = n * 26 + (c - 64);
    else if (c >= 97 && c <= 122) n = n * 26 + (c - 96);
    else break;
  }
  return n - 1;
}

/** XML 1.0 forbids most control characters outright — strip rather than corrupt. */
export function stripInvalidXmlChars(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '');
}

export function escapeXml(s: string): string {
  return stripInvalidXmlChars(s).replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&apos;';
    }
  });
}

export function decodeXml(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (whole, g: string) => {
    switch (g) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      default: {
        const hex = g.startsWith('#x') || g.startsWith('#X');
        const code = Number.parseInt(g.slice(hex ? 2 : 1), hex ? 16 : 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
      }
    }
  });
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag)) !== null) {
    const key = m[1];
    const value = m[2];
    if (key !== undefined && value !== undefined) out[key] = decodeXml(value);
  }
  return out;
}

function textOf(bytes: Uint8Array | undefined): string | undefined {
  return bytes ? strFromU8(bytes) : undefined;
}

/* -------------------------------------------------------------------- read */

function parseRels(xml: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of xml.matchAll(/<Relationship\b[^>]*>/g)) {
    const a = attrs(m[0]);
    if (a['Id'] && a['Target']) out[a['Id']] = a['Target'];
  }
  return out;
}

function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  const siRe = /<si\b[^>]*\/>|<si\b[^>]*>([\s\S]*?)<\/si>/g;
  for (const m of xml.matchAll(siRe)) {
    const body = m[1] ?? '';
    let s = '';
    for (const t of body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g)) {
      s += decodeXml(t[1] ?? '');
    }
    out.push(s);
  }
  return out;
}

function normaliseRow(cells: Array<string | undefined>): string[] {
  const out: string[] = [];
  for (let i = 0; i < cells.length; i++) out.push(cells[i] ?? '');
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
}

function parseSheet(xml: string, shared: string[]): string[][] {
  const sparse: Array<string[] | undefined> = [];
  const rowRe = /<row\b([^>]*)\/>|<row\b([^>]*)>([\s\S]*?)<\/row>/g;
  for (const rowMatch of xml.matchAll(rowRe)) {
    const rowAttrs = attrs(rowMatch[1] ?? rowMatch[2] ?? '');
    const body = rowMatch[3] ?? '';
    const cells: Array<string | undefined> = [];
    let cursor = 0;
    const cellRe = /<c\b([^>]*)\/>|<c\b([^>]*)>([\s\S]*?)<\/c>/g;
    for (const cellMatch of body.matchAll(cellRe)) {
      const a = attrs(cellMatch[1] ?? cellMatch[2] ?? '');
      const inner = cellMatch[3] ?? '';
      const idx = a['r'] ? colIndex(a['r']) : cursor;
      cursor = idx + 1;
      const t = a['t'] ?? 'n';
      let value = '';
      if (t === 'inlineStr') {
        for (const tt of inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g)) {
          value += decodeXml(tt[1] ?? '');
        }
      } else {
        const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
        const raw = v ? decodeXml(v[1] ?? '') : '';
        if (t === 's') value = shared[Number.parseInt(raw, 10)] ?? '';
        else if (t === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
        else if (t === 'e') value = '';
        else value = raw;
      }
      cells[idx] = value;
    }
    const at = rowAttrs['r'] ? Number.parseInt(rowAttrs['r'], 10) - 1 : sparse.length;
    sparse[at >= 0 ? at : sparse.length] = normaliseRow(cells);
  }
  const rows: string[][] = [];
  for (let i = 0; i < sparse.length; i++) rows.push(sparse[i] ?? []);
  return rows;
}

function resolveTarget(target: string): string {
  const t = target.replace(/^\//, '');
  return t.startsWith('xl/') ? t : `xl/${t}`;
}

export function readWorkbook(bytes: Uint8Array): Workbook {
  const files = unzipSync(bytes);
  const wbXml = textOf(files['xl/workbook.xml']);
  if (!wbXml) throw new Error('xlsx: xl/workbook.xml missing, so this is not a SpreadsheetML package');

  const rels = parseRels(textOf(files['xl/_rels/workbook.xml.rels']) ?? '');
  const shared = parseSharedStrings(textOf(files['xl/sharedStrings.xml']) ?? '');

  const sheets: Sheet[] = [];
  const sheetRe = /<sheet\b[^>]*\/>|<sheet\b[^>]*>/g;
  for (const m of wbXml.matchAll(sheetRe)) {
    const a = attrs(m[0]);
    const name = a['name'] ?? `Sheet${sheets.length + 1}`;
    const rid = a['r:id'] ?? a['id'];
    const target = rid ? rels[rid] : undefined;
    const path = resolveTarget(target ?? `worksheets/sheet${sheets.length + 1}.xml`);
    sheets.push({ name, rows: parseSheet(textOf(files[path]) ?? '', shared) });
  }
  return { sheets };
}

/* ------------------------------------------------------------------- write */

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

const MINIMAL_STYLES =
  `${XML_HEAD}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
  '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill>' +
  '<fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border/></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

function sheetToXml(sheet: OutSheet, intern: (s: string) => number): string {
  const rows: string[] = [];
  sheet.rows.forEach((row, r) => {
    if (row.every((c) => c === '' || c === null || c === undefined)) return;
    const cells: string[] = [];
    row.forEach((value, c) => {
      if (value === '' || value === null || value === undefined) return;
      const ref = `${colName(c)}${r + 1}`;
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) return;
        cells.push(`<c r="${ref}"><v>${value}</v></c>`);
        return;
      }
      if (typeof value === 'boolean') {
        cells.push(`<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`);
        return;
      }
      cells.push(`<c r="${ref}" t="s"><v>${intern(value)}</v></c>`);
    });
    if (cells.length === 0) return;
    rows.push(`<row r="${r + 1}">${cells.join('')}</row>`);
  });
  return (
    `${XML_HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${rows.join('')}</sheetData></worksheet>`
  );
}

export function writeWorkbook(wb: { sheets: OutSheet[] }): Uint8Array {
  const shared: string[] = [];
  const index = new Map<string, number>();
  const intern = (s: string): number => {
    const found = index.get(s);
    if (found !== undefined) return found;
    const at = shared.length;
    shared.push(s);
    index.set(s, at);
    return at;
  };

  const sheets = wb.sheets.length > 0 ? wb.sheets : [{ name: 'Sheet1', rows: [] }];
  const sheetXml = sheets.map((s) => sheetToXml(s, intern));

  const overrides = sheets
    .map(
      (_, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
    )
    .join('');

  const contentTypes =
    `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    overrides +
    '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '</Types>';

  const rootRels =
    `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';

  const sheetEntries = sheets
    .map((s, i) => `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join('');

  const workbook =
    `${XML_HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets>${sheetEntries}</sheets></workbook>`;

  const workbookRels =
    `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    sheets
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join('') +
    `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>` +
    `<Relationship Id="rId${sheets.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    '</Relationships>';

  const total = sheetXml.reduce((n, xml) => n + (xml.match(/<c r=/g)?.length ?? 0), 0);
  const sharedStrings =
    `${XML_HEAD}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `count="${total}" uniqueCount="${shared.length}">` +
    shared.map((s) => `<si><t xml:space="preserve">${escapeXml(s)}</t></si>`).join('') +
    '</sst>';

  const entries: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(rootRels),
    'xl/workbook.xml': strToU8(workbook),
    'xl/_rels/workbook.xml.rels': strToU8(workbookRels),
    'xl/sharedStrings.xml': strToU8(sharedStrings),
    'xl/styles.xml': strToU8(MINIMAL_STYLES),
  };
  sheetXml.forEach((xml, i) => {
    entries[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(xml);
  });

  // Fixed timestamp: byte-identical output for identical input, so tests can diff
  // archives. ZIP timestamps start at 1980, so 0 is not a legal value.
  return zipSync(entries, { level: 6, mtime: new Date('2020-01-01T00:00:00Z') });
}
