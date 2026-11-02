/**
 * The visual grammar of the compiler's workbook.
 *
 * A workbook is read by people before it is read by a machine. The fills here are
 * not decoration: they mark the cells that decide whether an upload is accepted,
 * and the rows that change control flow. Four rules, deliberately few:
 *
 *   yellow  `name`, `constraint_message`, `relevant`/`relevance`, `choice_filter`
 *   peach   `begin_group`, `end_group`, `begin_repeat`, `end_repeat`
 *   green   `select_one` and `select_multiple` rows
 *   navy    header rows
 *
 * Everything else is plain. A fifth colour would make the first four mean less.
 *
 * This module holds no knowledge of forms: it takes finished sheets and returns
 * them with styles, widths and frozen panes. That keeps the importer/exporter free
 * of presentation and lets the studio viewer render exactly what is in the file.
 */
import type { CellValue, OutSheet, StyleBook } from './xlsx.js';

/** Yellow: the parser reads these columns when it judges an upload. */
const YELLOW = 'FFFFFF00';
const YELLOW_HEADER = 'FFFFE699';
/** Peach: a row that opens or closes a group or repeat. */
const PEACH = 'FFFDE9D9';
/** Green: a row whose answer comes from a choice list. */
const GREEN = 'FFE2EFDA';
const NAVY = 'FF1F2A37';
const WHITE = 'FFFFFFFF';
const INK = 'FF111827';

export const XLSFORM_STYLES: StyleBook = {
  header: { bold: true, fill: NAVY, color: WHITE, border: true, vertical: 'center' },
  keyHeader: { bold: true, fill: YELLOW_HEADER, color: INK, border: true, vertical: 'center' },
  key: { fill: YELLOW, border: true, vertical: 'top' },
  group: { fill: PEACH, border: true, vertical: 'top' },
  choice: { fill: GREEN, border: true, vertical: 'top' },
  body: { border: true, vertical: 'top', wrap: true },
  helpTitle: { bold: true, size: 16, color: INK, vertical: 'center' },
  helpSection: { bold: true, fill: PEACH, color: INK, border: true },
  helpHeader: { bold: true, fill: NAVY, color: WHITE, border: true },
  helpBody: { border: true, wrap: true, vertical: 'top' },
  helpCode: { bold: true, color: INK, border: true, vertical: 'top' },
};

const KEY_BASES = new Set([
  'name', 'constraint_message', 'constraint message', 'relevant', 'relevance', 'choice_filter',
]);
const KEY_HEADERS = new Set(KEY_BASES);

function baseOf(header: string): string {
  const raw = header.trim().toLowerCase();
  const at = raw.indexOf('::');
  if (at !== -1) return raw.slice(0, at).trim();
  const colon = raw.lastIndexOf(':');
  if (colon > 0 && !raw.startsWith('media:')) return raw.slice(0, colon).trim();
  return raw;
}

function isKeyColumn(header: string): boolean {
  return KEY_BASES.has(baseOf(header));
}

function rowType(row: CellValue[]): string {
  return String(row[0] ?? '').trim().toLowerCase();
}

/** The columns whose width depends on what a writer put in them. */
function surveyWidths(headers: string[]): number[] {
  return headers.map((header) => {
    const base = baseOf(header);
    if (base === 'type') return 20;
    if (base === 'name') return 24;
    if (base === 'label' || base === 'hint') return 44;
    if (base === 'constraint_message' || base === 'constraint message' || base === 'required_message' || base === 'required message') return 38;
    if (base === 'constraint' || base === 'relevant' || base === 'relevance') return 32;
    if (base === 'calculation' || base === 'choice_filter') return 30;
    if (base === 'repeat_count' || base === 'appearance' || base === 'default') return 18;
    if (base.startsWith('media:')) return 22;
    return 20;
  });
}

function styleSurvey(sheet: OutSheet): OutSheet {
  const headers = (sheet.rows[0] ?? []).map((cell) => String(cell ?? ''));
  const keyColumns = new Set(headers.flatMap((header, index) => (isKeyColumn(header) ? [index] : [])));
  const headerStyles = headers.map((header) => (isKeyColumn(header) ? 'keyHeader' : 'header'));

  const styles: Array<Array<string | null>> = [headerStyles];
  for (const row of sheet.rows.slice(1)) {
    const type = rowType(row);
    const group = type.startsWith('begin_') || type.startsWith('end_');
    const choice = type === 'select_one' || type === 'select_multiple' || type.startsWith('select_one ') || type.startsWith('select_multiple ');
    styles.push(
      headers.map((header, index) => {
        if (index === 0 && group) return 'group';
        if (keyColumns.has(index)) return 'key';
        if (group) return 'group';
        if (choice) return 'choice';
        return header === '' ? null : 'body';
      }),
    );
  }

  return {
    ...sheet,
    styles,
    widths: surveyWidths(headers),
    freeze: { rows: 1, columns: 2 },
  };
}

function styleChoices(sheet: OutSheet): OutSheet {
  const headers = (sheet.rows[0] ?? []).map((cell) => String(cell ?? ''));
  const keyHeaders = new Set(['list_name', 'value', 'name', 'filter', 'filter2', 'filter3', 'filter4', 'filter5']);
  const styles = sheet.rows.map((row, index) =>
    row.map((cell, column) => {
      const key = keyHeaders.has(headers[column] ?? '');
      if (index === 0) return key ? 'keyHeader' : 'header';
      if (key) return 'key';
      if (cell === '' || cell === null) return null;
      return 'body';
    }),
  );
  return { ...sheet, styles, widths: headers.map((header) => header.startsWith('label') ? 40 : 22), freeze: { rows: 1, columns: 2 } };
}

function styleSettings(sheet: OutSheet): OutSheet {
  const headers = (sheet.rows[0] ?? []).map((cell) => String(cell ?? ''));
  const guarded = new Set(['form_id', 'version']);
  const styles = sheet.rows.map((row, index) =>
    row.map((_, column) => {
      if (index === 0) return guarded.has(headers[column] ?? '') ? 'keyHeader' : 'header';
      return guarded.has(headers[column] ?? '') ? 'key' : 'body';
    }),
  );
  return {
    ...sheet,
    styles,
    widths: headers.map((header) => (header === 'version' ? 22 : header === 'form_title' ? 40 : 28)),
    freeze: { rows: 1 },
  };
}

function styleHelp(sheet: OutSheet): OutSheet {
  const styles: Array<Array<string | null>> = [];
  sheet.rows.forEach((row, index) => {
    if (index === 0) {
      styles.push(row.map(() => 'helpTitle'));
      return;
    }
    if (index === 4) {
      styles.push(row.map(() => 'helpHeader'));
      return;
    }
    if (String(row[0] ?? '') === 'Highlighted cells') {
      styles.push(row.map(() => 'helpSection'));
      return;
    }
    styles.push(
      row.map((cell, column) => {
        if (cell === '' || cell === null) return null;
        return column === 0 ? 'helpCode' : 'helpBody';
      }),
    );
  });
  return { ...sheet, styles, widths: [28, 34, 56, 34] };
}

export interface StyledBook {
  sheets: OutSheet[];
  styles: StyleBook;
}

/**
 * Apply the workbook grammar. Unknown sheets are passed through untouched, so a
 * future tab does not silently lose its author's formatting.
 */
export function applyXlsFormStyles(sheets: OutSheet[]): StyledBook {
  return {
    styles: XLSFORM_STYLES,
    sheets: sheets.map((sheet) => {
      if (sheet.name === 'survey') return styleSurvey(sheet);
      if (sheet.name === 'choices') return styleChoices(sheet);
      if (sheet.name === 'settings') return styleSettings(sheet);
      if (sheet.name.startsWith('help-')) return styleHelp(sheet);
      return sheet;
    }),
  };
}

/** Exposed for the validator, which reports colours by name in diagnostics. */
export function isKeyColumnHeader(header: string): boolean {
  return KEY_HEADERS.has(baseOf(header));
}
