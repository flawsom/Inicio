/**
 * A small, deterministic reader for WordprocessingML.
 *
 * The compiler needs the document's reading order, its tables, and the few
 * formatting signals clients use to mark instructions: bold, colour and paragraph
 * style. It does not need layout, revision tracking, comments, footnotes or
 * embedded objects, and it should not pull a full Office renderer into the
 * engine. This module therefore reads only `word/document.xml` (plus the style
 * part when present) from the OOXML zip.
 *
 * Every block carries its source paragraph or table text verbatim. Extraction
 * decisions belong to the compiler, not here: a reader that silently normalises
 * "RECORD VERBATIM" into something else has already lost the instruction.
 */
import { strFromU8, unzipSync } from 'fflate';

export interface DocxRun {
  text: string;
  bold: boolean;
  italic: boolean;
  color?: string;
}

export interface DocxParagraph {
  text: string;
  runs: DocxRun[];
  style?: string;
  bold: boolean;
  italic: boolean;
  color?: string;
  numbered: boolean;
}

export interface DocxCell {
  text: string;
  paragraphs: DocxParagraph[];
  bold: boolean;
  color?: string;
}

export interface DocxTable {
  rows: DocxCell[][];
  /** The style id on `<w:tbl>`, when Word wrote one. */
  style?: string;
}

export type DocxBlock =
  | { kind: 'paragraph'; paragraph: DocxParagraph }
  | { kind: 'table'; table: DocxTable };

export interface DocxDocument {
  blocks: DocxBlock[];
  partNames: string[];
  title?: string;
}

function decodeXml(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (whole, entity: string) => {
    switch (entity) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      default: {
        const hex = entity.startsWith('#x') || entity.startsWith('#X');
        const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
      }
    }
  });
}

function attr(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`).exec(tag);
  return match?.[1] === undefined ? undefined : decodeXml(match[1]);
}

function containsOn(xml: string, tag: string): boolean {
  return new RegExp(`<${tag}(?:\\s[^>]*)?>`).test(xml) && !new RegExp(`<${tag}[^>]*w:val\\s*=\\s*["'](?:0|false|off)["']`).test(xml);
}

function textOfRun(xml: string): string {
  let out = '';
  for (const match of xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:t(?:\s[^>]*)?\/>/g)) {
    out += decodeXml(match[1] ?? '');
  }
  const tabs = (xml.match(/<w:tab\b[^>]*\/>/g) ?? []).length;
  const breaks = (xml.match(/<w:br\b[^>]*\/>/g) ?? []).length;
  return `${out}${'\t'.repeat(tabs)}${'\n'.repeat(breaks)}`;
}

/** Parse one `<w:p>` element. Nested paragraphs do not exist in WordprocessingML. */
export function parseParagraph(xml: string): DocxParagraph {
  const style = /<w:pStyle\b[^>]*w:val\s*=\s*["']([^"']+)["']/.exec(xml)?.[1];
  const numbered = /<w:numPr\b/.test(xml);
  const runs: DocxRun[] = [];
  for (const match of xml.matchAll(/<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g)) {
    const body = match[1] ?? '';
    const text = textOfRun(body);
    if (text === '') continue;
    const bold = containsOn(body, 'w:b');
    const italic = containsOn(body, 'w:i');
    const color = /<w:color\b[^>]*w:val\s*=\s*["']([^"']+)["']/.exec(body)?.[1];
    runs.push({ text, bold, italic, ...(color ? { color } : {}) });
  }
  if (runs.length === 0) {
    const text = textOfRun(xml);
    if (text !== '') runs.push({ text, bold: false, italic: false });
  }
  const visible = runs.filter((run) => run.text.trim() !== '');
  return {
    text: runs.map((run) => run.text).join('').replace(/\r/g, '').trim(),
    runs,
    ...(style ? { style } : {}),
    bold: visible.length > 0 && visible.every((run) => run.bold),
    italic: visible.length > 0 && visible.every((run) => run.italic),
    ...(visible[0]?.color ? { color: visible[0].color } : {}),
    numbered,
  };
}

function parseCell(xml: string): DocxCell {
  const paragraphs: DocxParagraph[] = [];
  for (const match of xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)) {
    paragraphs.push(parseParagraph(match[0]));
  }
  const text = paragraphs.map((paragraph) => paragraph.text).filter(Boolean).join('\n').trim();
  return {
    text,
    paragraphs,
    bold: paragraphs.length > 0 && paragraphs.every((paragraph) => paragraph.bold),
    ...(paragraphs[0]?.color ? { color: paragraphs[0].color } : {}),
  };
}

/** Parse a `<w:tbl>` element, preserving row and cell order. */
export function parseTable(xml: string): DocxTable {
  const rows: DocxCell[][] = [];
  const open = /<w:tbl\b[^>]*>/.exec(xml)?.[0] ?? '';
  const style = attr(open, 'w:style');
  for (const rowMatch of xml.matchAll(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g)) {
    const cells: DocxCell[] = [];
    for (const cellMatch of (rowMatch[1] ?? '').matchAll(/<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g)) {
      cells.push(parseCell(cellMatch[1] ?? ''));
    }
    rows.push(cells);
  }
  return { rows, ...(style ? { style } : {}) };
}

function readText(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match ? decodeXml(match[1] ?? '').trim() : undefined;
}

/**
 * Read a .docx package.
 *
 * A document with no `word/document.xml` is not a Word file; the error names the
 * parts that were present so a caller can tell an encrypted or renamed file from
 * a broken one.
 */
export function readDocx(bytes: Uint8Array): DocxDocument {
  const parts = unzipSync(bytes);
  const names = Object.keys(parts).sort();
  const documentXml = parts['word/document.xml'];
  if (!documentXml) {
    throw new Error(`docx: word/document.xml missing (package has: ${names.slice(0, 12).join(', ') || 'no parts'})`);
  }
  const xml = strFromU8(documentXml);
  const body = /<w:body\b[^>]*>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? xml;
  const blocks: DocxBlock[] = [];

  // A non-greedy table match is safe here: Word tables do not nest, and a nested
  // table is already malformed for the authoring flows this compiler accepts.
  const blockRe = /<w:tbl\b[^>]*>[\s\S]*?<\/w:tbl>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
  for (const match of body.matchAll(blockRe)) {
    const fragment = match[0];
    if (fragment.startsWith('<w:tbl')) blocks.push({ kind: 'table', table: parseTable(fragment) });
    else blocks.push({ kind: 'paragraph', paragraph: parseParagraph(fragment) });
  }

  const core = parts['docProps/core.xml'];
  const title = core ? readText(strFromU8(core), 'dc:title') : undefined;
  return {
    blocks,
    partNames: names,
    ...(title ? { title } : {}),
  };
}

export function docxText(document: DocxDocument): string {
  const lines: string[] = [];
  for (const block of document.blocks) {
    if (block.kind === 'paragraph') {
      if (block.paragraph.text !== '') lines.push(block.paragraph.text);
      continue;
    }
    for (const row of block.table.rows) {
      lines.push(row.map((cell) => cell.text).join(' | '));
    }
  }
  return lines.join('\n');
}
