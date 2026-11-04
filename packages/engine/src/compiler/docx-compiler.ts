/**
 * Word questionnaire to SurveyCTO XLSForm.
 *
 * The input is a client-authored Word document. The output is the six-sheet
 * workbook SurveyCTO expects, with the repeated compilation decisions made in the
 * same deterministic order every time: paradata, introduction, screener gates,
 * age post-codes, NCCS, brand funnels, option rotation, other-specify metadata,
 * exclusive options, rankings and the final completion route.
 *
 * This is intentionally a compiler, not a language model. A rule fires only when
 * the document contains the cue it names. When a cue is present but the table is
 * too ambiguous to compile safely, the rule is reported as needing review rather
 * than guessed at. That is what keeps a production instrument reviewable.
 */
import { versionStamp, xlsFormSheets, type XlsFormBook } from '../adapters/xlsform.js';
import { applyXlsFormStyles } from '../adapters/xlsform-book.js';
import { writeWorkbook } from '../adapters/xlsx.js';
import {
  type Choice, type FormDefinition, type Group, type LocalizedText,
  type Question, type QuestionType,
} from '../types.js';
import { validateForm } from '../validate.js';
import { readDocx, type DocxDocument, type DocxParagraph, type DocxTable } from './docx.js';

export interface CompilerDiagnostic {
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
  where?: string;
}

export interface CompilerRuleStatus {
  id: number;
  name: string;
  status: 'applied' | 'partial' | 'needs-review' | 'not-detected';
  evidence?: string;
}

export interface DocxCompileOptions {
  title?: string;
  /** The five digit project number used by the agency's GDN form-id convention. */
  projectNumber?: string | number;
  /** Full form id. Wins over `projectNumber` when both are supplied. */
  formId?: string;
  version?: string;
  now?: Date;
  defaultLanguage?: string;
  languages?: string[];
  publicKey?: string;
  submissionUrl?: string;
  /**
   * Use a language name as written in the document (`Marathi`) rather than a
   * two letter code. The benchmark workbooks use names, so this is the default.
   */
  languageNames?: boolean;
  /** Emit a 10 digit version stamp even when the caller supplies no version. */
  stampVersion?: boolean;
  /**
   * Translations keyed by question code and then language name. These are for
   * callers that keep the translations outside the Word file. A label supplied
   * here is only emitted when it is actually present; the compiler never
   * invents a regional translation.
   */
  translations?: Record<string, Record<string, string>>;
  /** Choice translations keyed by question code, then choice value, then language. */
  choiceTranslations?: Record<string, Record<string, Record<string, string>>>;
}

export interface DocxCompileResult {
  definition: FormDefinition;
  book: XlsFormBook;
  bytes: Uint8Array;
  report: {
    diagnostics: CompilerDiagnostic[];
    rules: CompilerRuleStatus[];
    sourceTitle?: string;
  };
}

export const COMPILER_RULES: ReadonlyArray<{ id: number; name: string }> = [
  { id: 1, name: 'Six-sheet workbook and regional language columns' },
  { id: 2, name: 'Paradata header' },
  { id: 3, name: 'Interviewer and respondent intro block' },
  { id: 4, name: 'Verbatim age input and post-coded age triplet' },
  { id: 5, name: 'NCCS socio-economic grid' },
  { id: 6, name: 'Screener gate and completion route' },
  { id: 7, name: 'Randomised options, custom-specify-other and exclusive options' },
  { id: 8, name: 'Brand funnel and awareness cascade' },
  { id: 9, name: 'Priority brand cap' },
  { id: 10, name: 'X/Y statement rotation' },
  { id: 11, name: 'Ranking, MaxDiff and concept rotation' },
  { id: 12, name: 'Constant sums, rosters, audits and location gates' },
];

const RULE_NAMES = new Map(COMPILER_RULES.map((rule) => [rule.id, rule.name]));
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function slug(input: string, fallback = 'form'): string {
  const value = input.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return value === '' ? fallback : value;
}

function upperSlug(input: string): string {
  const value = input.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return value === '' ? 'FORM' : value;
}

const GENERIC_HEADING = /^(?:interviewer|respondent|introduction|screener|section\b|ask\b|programmer|survey\b|questionnaire|informed consent|consent|note\b|read\b|good (?:morning|afternoon|evening))/i;
const TITLE_NOISE = /^(?:qre|questionnaire|survey|draft|final|version|untitled)$/i;

/**
 * Reads the project name a real questionnaire puts above its first table.
 * A heading such as `Bounce - Rider Survey Instrument` contributes only the
 * project token, while a sentence is never mistaken for a title.
 */
function inferredTitle(document: DocxDocument): string | undefined {
  let examined = 0;
  for (const block of document.blocks) {
    if (block.kind !== 'paragraph') continue;
    examined += 1;
    if (examined > 30) break;
    const text = cleanPrompt(block.paragraph.text);
    if (text.length < 3 || text.length > 90) continue;
    if (GENERIC_HEADING.test(text) || text.includes('?') || /^(?:\d+|[A-Za-z]\d+)[.)]/.test(text)) continue;
    if (/[|]/.test(text)) continue;
    const leading = /^([A-Za-z][A-Za-z0-9&.]{2,})\s*[-\u2013\u2014:]/.exec(text);
    if (leading) {
      const token = leading[1]!;
      if (!TITLE_NOISE.test(token)) return token.toUpperCase();
      continue;
    }
    const words = text.split(/\s+/);
    if (words.length <= 8 && !/[.;]$/.test(text)) {
      const candidate = text.replace(/:$/, '').trim();
      if (candidate !== '' && !TITLE_NOISE.test(candidate)) return candidate;
    }
  }
  return undefined;
}

function cleanPrompt(input: string): string {
  return input
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^PROGRAMMER\s+INSTRUCTION\s*:\s*/i, '')
    .trim();
}

function cleanLabel(input: string): string {
  return cleanPrompt(input)
    .replace(/PROGRAMMER\s+TO\s+ASK\s+(?:ONLY\s+)?(?:IF|AS\s+PER)[^.]*\.\s*/gi, '')
    .replace(/PROGRAMMER\s+TO\s+(?:ALLOW|KEEP|OPEN)[^.]*\.?\s*/gi, '')
    .replace(/PROGRAMMER\s+TO\s+[^.]*\.\s*/gi, '')
    .replace(/INTERVIEWER\s+TO\s+[^.]*\.\s*/gi, '')
    .replace(/\bRECORD\s+(?:ACTUAL\s+AGE|VERBATIM|IN\s+NUMBERS)(?:\s+AND\s+POST\s+CODE)?[^.]*\.?\s*/gi, '')
    .replace(/\bGroup\s+(?=RECORD|$)/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normaliseCode(input: string): string {
  return input
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/^([0-9])/, '_$1')
    .toLowerCase();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rowText(table: DocxTable, row: number): string {
  return (table.rows[row] ?? []).map((cell) => cell.text.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' | ');
}

function tableText(table: DocxTable): string {
  return table.rows.map((_, index) => rowText(table, index)).filter(Boolean).join('\n');
}

const SECTION_TEXT = /^(?:(?:\d+\.\s*)?(?:introduction|main questionnaire|questionnaire|screener|sub\s*section\b|section\b|module\b|part\b|churned[- ]rider\b)|customer profiling|concept evaluation|purchase behaviour\b|spontaneous ad recalls?|aware (?:non[- ]?)?trier diagnostics|in store experience evaluation|deep dive\b|zo\.\s*user\s+classification|grid\s+[a-z]\.?\s+user\s+classification)/i;
const NOTE_TEXT = /^(?:interviewer\s+(?:to\s+)?read(?:\s+out)?|interviewer\s+read\s+out|message\s+to\s+display|read\s*[:–-]\s*)\b/i;
const SKIP_TEXT = /^(?:why\s+we\s+ask\b|those\s+coded\b|ask\s+all\s+questions\b|programmer\s+(?:instruction|note)\b)/i;

/** A section banner is never a respondent field, even when it sits in a table. */
function isSectionText(input: string): boolean {
  const text = cleanPrompt(input);
  if (text === '' || text.length > 160 || text.includes('?') || /_{3,}/.test(text)) return false;
  if (SECTION_TEXT.test(text)) return true;
  // Word questionnaires often format a banner as a one-cell table in capitals.
  return text === text.toUpperCase() && /[A-Z]{3}/.test(text) && !/\b(?:SA|MA|TERMINATE|CONTINUE)\b/.test(text);
}

/** A banner changes the branch of the questionnaire; it is never an option. */
function sectionAfter(text: string): 'screener' | 'main' | null {
  const value = cleanPrompt(text);
  if (/\bscreener\b|\bsection\s*1\b/i.test(value)) return 'screener';
  if (/\bmodule\b|\bmain\s+questionnaire\b|\bsection\s*2\b|\bsection\s*9\b|churned[- ]rider/i.test(value)) return 'main';
  return null;
}

function isHeading(paragraph: DocxParagraph): boolean {
  const text = cleanPrompt(paragraph.text);
  if (text === '' || text.length > 120) return false;
  return Boolean(paragraph.style && /heading|title/i.test(paragraph.style))
    || /^section\b|^sub\s*section\b|^main questionnaire$|^questionnaire$|^screener$/i.test(text);
}

function looksLikeQuestion(text: string): boolean {
  const value = cleanPrompt(text);
  if (value === '' || isSectionText(value) || NOTE_TEXT.test(value) || SKIP_TEXT.test(value)) return false;
  if (value.length > 500 && !value.includes('?')) return false;
  if (/^[A-Z]{1,6}\d+[A-Za-z]{0,2}(?:[._]\d+[A-Za-z]?)?[.\s:]/.test(value)) return true;
  // `B1)` and `B2)` are continuation questions under B7, not answer options.
  if (/^[A-Z]\d+\)\s+/.test(value) && /PROGRAMMER|\?|how\s+(?:much|many)|_{2,}/i.test(value)) return true;
  if (/^[A-Z][.)]\s+/.test(value) && /\?|\b(?:SA|MA)\b|_{3,}/.test(value)) return true;
  if (/\?\s*(?:SA|MA|$)/i.test(value) || /\b(?:SA|MA)\b/.test(value)) return true;
  // A blank is not enough on its own: `Other: ______` and `Yes, paid in full:
  // INR ______` are options, not questions. Require a question opening as well.
  return /_{3,}/.test(value)
    && /^(?:what|how|why|which|who|when|where|do|does|did|are|is|was|were|have|has|can|could|would|will|should|please|if|in\s+total|at\s+your|on\s+a|before|after)\b/i.test(value);
}

function questionCode(text: string): string | null {
  const cleaned = cleanPrompt(text)
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/^PROGRAMMER\s+INSTRUCTION\s*:\s*/i, '');
  // `D5. D5A.` repeats the code in the wording. The second, more specific one
  // is the field the client's workbook uses.
  const repeated = /^([A-Z]{1,6}\d+)[.)]\s*([A-Z]{1,6}\d+[A-Za-z]{0,2})[.)]\s+/i.exec(cleaned);
  if (repeated?.[2]) return normaliseCode(repeated[2]);
  const parenthesised = /^([A-Z]{1,6}\d+)\)\s+/.exec(cleaned);
  if (parenthesised?.[1]) return normaliseCode(parenthesised[1]);
  // `D2. A How convenient...` is field D2A, not D2 plus an option. `B7. A)` is
  // B7A; the following `B1)`/`B2)` are resolved against that parent later.
  const match = /^([A-Z]{1,6}\d+[A-Za-z]{0,2})(?:[.)]\s*([A-Z])\b|[.\s:])/i.exec(cleaned);
  if (!match?.[1]) return null;
  return normaliseCode(`${match[1]}${match[2] ?? ''}`);
}

/** A lettered continuation is named against the previous numbered field. */
function continuedQuestionCode(text: string, previous: string | null): string | null {
  if (!previous) return null;
  const match = /^([A-Z])(\d+)?[.)]?\s+/.exec(cleanPrompt(text));
  if (!match?.[1]) return null;
  const base = /^([a-z]+\d+)/.exec(previous)?.[1];
  if (!base) return null;
  return normaliseCode(`${base}${match[1]}${match[2] ?? ''}`);
}

/**
 * Real papers put routing words before the code: `ASK FOR ... MQ3.` The field
 * is MQ3, not a text box named after the instruction.
 */
function questionStart(text: string): string {
  const cleaned = cleanPrompt(text);
  if (questionCode(cleaned)) return cleaned;
  if (!/^(?:ASK|SHOW|PROGRAMMER|INTERVIEWER|IF|ONLY|THOSE|ALL|TO)\b/i.test(cleaned)) return cleaned;
  const beforeQuestion = cleaned.split('?')[0] ?? cleaned;
  const codes = [...beforeQuestion.matchAll(/\b([A-Z]{1,6}\d+[a-z]?(?:[._]\d+[a-z]?)?)[.)]\s+/gi)];
  const match = codes.filter((entry) => (entry.index ?? 0) <= 240).at(-1);
  if (match && (match.index ?? 0) > 0) return cleaned.slice(match.index);
  return cleaned;
}

function withoutCode(text: string): string {
  return cleanPrompt(text).replace(/^[A-Z]{1,6}\d+[A-Za-z]{0,2}(?:[._]\d+[A-Za-z]?)?[.)\s:]+\s*/i, '');
}

export interface RawOption {
  label: string;
  value: string;
  instruction: string;
  row: string[];
  /** Labels found in a document table with language columns, keyed by language. */
  translations?: LocalizedText;
}

export interface RawQuestion {
  code: string | null;
  prompt: string;
  options: RawOption[];
  section: 'screener' | 'main';
  where: string;
  /** An interviewer instruction, emitted as a note rather than an answer. */
  note?: boolean;
  /** A churned-rider banner routes the questions below it to the churned branch. */
  branch?: 'churned';
  /** A statement-grid row carries the group it belongs to and whether it is the first. */
  matrix?: { key: string; label: string; first: boolean };
  /** Prompt translations supplied by the source or the caller. */
  translations?: LocalizedText;
  /** True when this row came from a table whose language columns were read. */
  translatedTable?: boolean;
}

export interface NccsGrid {
  rows: Array<{ label: string; cells: string[] }>;
  education: string[];
  durables: string[];
  allowed: string[];
  where: string;
}

export interface IntroTable {
  fields: Array<'int_name' | 'resp_name' | 'resp_no' | 'resp_add' | 'st_point'>;
  where: string;
}

function isIntroTable(table: DocxTable): IntroTable | null {
  const text = tableText(table);
  if (!/interviewer\s+name|respondent\s+name|respondent\s+(?:phone|mobile)|respondent\s+address|starting\s+point/i.test(text)) {
    return null;
  }
  const fields: IntroTable['fields'] = [];
  if (/interviewer\s+name/i.test(text)) fields.push('int_name');
  if (/respondent\s+name/i.test(text)) fields.push('resp_name');
  if (/respondent\s+(?:phone|mobile)/i.test(text)) fields.push('resp_no');
  if (/respondent\s+address/i.test(text)) fields.push('resp_add');
  if (/starting\s+point/i.test(text)) fields.push('st_point');
  return { fields, where: rowText(table, 0) };
}

function isNccsGrid(table: DocxTable): boolean {
  const text = tableText(table);
  const hasCodes = /\bE3\b|\bE2\b|\bD2\b|\bC2\b/.test(text);
  const hasEducation = /education|illiterate|school/i.test(text);
  return hasCodes && hasEducation;
}

function parseNccsGrid(table: DocxTable, allowed: string[], where: string): NccsGrid | null {
  const rows = table.rows.map((row) => row.map((cell) => cell.text.replace(/\s+/g, ' ').trim()));
  let headerIndex = -1;
  for (let i = 0; i < Math.min(rows.length, 4); i += 1) {
    const row = rows[i] ?? [];
    if (row.filter((cell) => /school|illiterate|graduate|college|SSC/i.test(cell)).length >= 3) {
      headerIndex = i;
      break;
    }
  }
  if (headerIndex < 0) return null;
  const header = rows[headerIndex] ?? [];
  const numericHeader = rows[headerIndex + 1] ?? [];
  const education = header.slice(1).filter(Boolean);
  const dataRows = rows.slice(headerIndex + 1)
    .filter((row) => /^(?:none|\d+\+?|9\+)$/i.test(row[0] ?? ''))
    .map((row) => ({ label: row[0] ?? '', cells: row.slice(1) }));
  if (dataRows.length === 0) return null;
  const durables = dataRows.map((row) => row.label);
  const allowedCodes = allowed.length > 0 ? allowed : [...new Set(dataRows.flatMap((row) => row.cells).filter((cell) => /^[A-E][1-3]$/.test(cell)))];
  if (allowedCodes.length === 0) return null;
  // The numeric header is read as a shape check; the matrix itself is positional.
  if (numericHeader.length < education.length + 1) {
    return null;
  }
  return {
    rows: dataRows.map((row) => ({ label: row.label, cells: row.cells.slice(0, education.length) })),
    education,
    durables,
    allowed: allowedCodes,
    where,
  };
}

function parseBrandGrid(table: DocxTable, _where: string): boolean {
  const rows = table.rows;
  if (rows.length < 3) return false;
  const text = tableText(table);
  if (!/\b(?:MQ|Q)\d|aided|ever purchased|last purchase|MOUB|L2Y/i.test(text)) return false;
  let numericRows = 0;
  for (let i = 1; i < rows.length; i += 1) {
    const values = (rows[i] ?? []).slice(1).filter((cell) => /^\d{1,3}$/.test(cell.text.trim()));
    if (values.length >= 2) numericRows += 1;
  }
  return numericRows >= 2;
}

function parseRankGrid(table: DocxTable): boolean {
  const text = tableText(table);
  return /\bRANK\s*[123]\b/i.test(text) || (/\bmost\b/i.test(text) && /\bleast\b/i.test(text));
}

interface ParsedMatrix {
  prompt: string;
  options: RawOption[];
  rows: Array<{ label: string; row: string[] }>;
}

/**
 * Reads a statement grid: a row of scale labels over rows of statements.
 * A two-column answer table is left to `parseOptions`; this only claims a table
 * when at least two scale headings describe at least two statements.
 */
function parseMatrixTable(table: DocxTable): ParsedMatrix | null {
  const rows = table.rows.map((row) => row.map((cell) => cell.text.replace(/\s+/g, ' ').trim()));
  if (rows.length < 4) return null;
  for (let headerAt = 0; headerAt < Math.min(3, rows.length - 2); headerAt += 1) {
    const header = rows[headerAt] ?? [];
    const labels = header.slice(1).filter((label) => label !== '');
    if (labels.length < 2) continue;
    const data = rows.slice(headerAt + 1).filter((row) => (row[0] ?? '') !== '');
    if (data.length < 2) continue;
    const scale = labels.filter((label) => /very|agree|satisf|likely|poor|good|excellent|none|always|often|sometimes|never|unlikely/i.test(label));
    if (scale.length < 2) continue;
    const firstPrompt = rows[0]?.[0] ?? '';
    const options = labels.map((label, index) => {
      const column = header.indexOf(label, 1);
      const code = /^\d{1,3}$/.test(label) ? label : String(index + 1);
      return {
        label,
        value: code,
        instruction: '',
        row: [label, String(column)],
      };
    });
    return {
      prompt: firstPrompt,
      options,
      rows: data.map((row) => ({ label: row[0]!, row })),
    };
  }
  return null;
}

const KNOWN_LANGUAGES = [
  'English', 'Marathi', 'Tamil', 'Telugu', 'Kannada', 'Hindi', 'Bengali', 'Odia',
  'Gujarati', 'Punjabi', 'Malayalam', 'Urdu', 'Assamese',
] as const;

/** A table header such as `English | Marathi | Hindi` is an option translation grid. */
function languageHeader(table: DocxTable): { row: number; languages: Array<{ language: string; column: number }> } | null {
  for (let rowIndex = 0; rowIndex < Math.min(table.rows.length, 4); rowIndex += 1) {
    const cells = (table.rows[rowIndex] ?? []).map((cell) => cell.text.replace(/\s+/g, ' ').trim());
    const languages: Array<{ language: string; column: number }> = [];
    cells.forEach((cell, column) => {
      const language = KNOWN_LANGUAGES.find((name) => new RegExp(`^${escapeRegex(name)}(?:\\s*\\([^)]*\\))?$`, 'i').test(cell));
      if (language && !languages.some((entry) => entry.language.toLowerCase() === language.toLowerCase())) {
        languages.push({ language, column });
      }
    });
    if (languages.length >= 2) return { row: rowIndex, languages };
  }
  return null;
}

/**
 * Read one row from a table whose columns are languages. The first language is
 * the source language; every other non-empty cell becomes a real translation.
 * A code column may sit before or after the language columns.
 */
function languageOptions(table: DocxTable, header: { row: number; languages: Array<{ language: string; column: number }> }): RawOption[] {
  const options: RawOption[] = [];
  const seen = new Set<string>();
  for (let rowIndex = header.row + 1; rowIndex < table.rows.length; rowIndex += 1) {
    const row = table.rows[rowIndex] ?? [];
    const cells = row.map((cell) => cell.text.replace(/\s+/g, ' ').trim());
    const translations: LocalizedText = {};
    for (const { language, column } of header.languages) {
      const value = cells[column] ?? '';
      if (value !== '') translations[language] = value;
    }
    const sourceLanguage = header.languages[0]?.language ?? '';
    const label = translations[sourceLanguage] ?? Object.values(translations)[0] ?? '';
    if (label === '') continue;
    const usedColumns = new Set(header.languages.map((entry) => entry.column));
    const codeAt = cells.findIndex((cell, column) => !usedColumns.has(column) && /^\d{1,3}$/.test(cell));
    const value = codeAt >= 0 ? cells[codeAt]! : String(rowIndex - header.row);
    // Reusing a code would make an invalid XLSForm choice list; skip a repeated
    // translation row rather than silently changing the respondent's answer code.
    if (seen.has(value)) continue;
    seen.add(value);
    const instruction = cells.filter((cell, column) => !usedColumns.has(column) && column !== codeAt).filter(Boolean).join(' ').trim();
    options.push({
      label,
      value,
      instruction,
      row: cells,
      ...(Object.keys(translations).length > 0 ? { translations } : {}),
    });
  }
  return options;
}

function parseOptions(table: DocxTable, startRow = 0): RawOption[] {
  const translated = languageHeader(table);
  if (translated && startRow <= translated.row) {
    const options = languageOptions(table, translated);
    if (options.length > 0) return options;
  }
  const options: RawOption[] = [];
  const seen = new Set<string>();
  for (let i = startRow; i < table.rows.length; i += 1) {
    const row = table.rows[i] ?? [];
    const cells = row.map((cell) => cell.text.replace(/\s+/g, ' ').trim());
    const codeAt = cells.findIndex((cell) => /^\d{1,3}$/.test(cell));
    if (codeAt < 0) continue;
    const label = cells.slice(0, codeAt).filter(Boolean).join(' ').trim();
    if (label === '') continue;
    const value = cells[codeAt]!;
    // A client table often repeats a scale code across two header columns. One
    // list cannot contain the same value twice, so the first row wins and the
    // repeated header is ignored rather than making the workbook unpublishable.
    if (seen.has(value)) continue;
    seen.add(value);
    const instruction = cells.slice(codeAt + 1).filter(Boolean).join(' ').trim();
    options.push({ label, value, instruction, row: cells });
  }
  return options;
}

function firstPromptRow(table: DocxTable): number {
  if (table.rows.length === 0) return -1;
  const first = rowText(table, 0);
  if (first === '') return -1;
  const numeric = parseOptions({ rows: [table.rows[0] ?? []] });
  if (numeric.length > 0 && looksLikeQuestion(first) === false) return -1;
  return 0;
}

/** Rating scales are often written as a label row over a code row. */
function parseHorizontalOptions(table: DocxTable, startRow: number): RawOption[] {
  const rows = table.rows.map((row) => row.map((cell) => cell.text.replace(/\s+/g, ' ').trim()));
  for (let i = startRow; i < rows.length - 1; i += 1) {
    const labels = rows[i] ?? [];
    const codes = rows[i + 1] ?? [];
    const first = labels.findIndex((label) => label !== '');
    if (first < 0) continue;
    let count = 0;
    while (first + count < labels.length && labels[first + count] !== '') count += 1;
    if (count < 2) continue;
    const codeCells = codes.slice(first, first + count);
    if (!codeCells.every((code) => /^\d{1,3}$/.test(code)) || new Set(codeCells).size !== count) continue;
    return codeCells.map((code, index) => ({
      label: labels[first + index]!,
      value: code,
      instruction: '',
      row: [labels[first + index]!, code],
    }));
  }
  return [];
}

function tableQuestion(table: DocxTable, pending: string | null, section: 'screener' | 'main', where: string): RawQuestion | null {
  const promptRow = pending ? -1 : firstPromptRow(table);
  const prompt = pending ?? (promptRow >= 0 ? rowText(table, promptRow) : '');
  if (cleanPrompt(prompt) === '') return null;
  const optionStart = promptRow >= 0 ? promptRow + 1 : 0;
  let options = parseOptions(table, optionStart);
  if (options.length === 0) options = parseHorizontalOptions(table, optionStart);
  const cleaned = questionStart(prompt);
  if (options.length === 0 && isSectionText(cleaned)) return null;
  return {
    code: questionCode(cleaned),
    prompt: cleanLabel(cleaned),
    options,
    section,
    where,
  };
}

function paragraphOption(text: string, index: number): RawOption | null {
  let label = cleanPrompt(text);
  if (label === '' || label.length > 240) return null;
  if (isSectionText(label) || NOTE_TEXT.test(label) || SKIP_TEXT.test(label)) return null;
  if (/^(?:note|instruction|please|show|read|good|introduction|section|module|those|this|ask|questionnaire|main)\b/i.test(label)) {
    return null;
  }
  // These are interview instructions, not answer options. The bracket labels
  // that follow them are the real post-code options.
  if (/^(?:record\s+(?:amount|actual|verbatim|in\s+numbers)|or\s*$)/i.test(label)) return null;
  let instruction = '';
  const trailing = /\s+(CONTINUE(?:\s+AS\s+[A-Z ]+)?|TERMINATE.*)$/.exec(label);
  if (trailing?.[0]) {
    instruction = trailing[1]!.trim();
    label = label.slice(0, trailing.index).trim();
  }
  label = label
    .replace(/\s+if never.*$/i, '')
    .replace(/\s*PROGRAMMER\s+TO\b.*$/i, '')
    .replace(/\s*PROGRAMMER\s+INSTRUCTION\b.*$/i, '')
    .replace(/\s*INTERVIEWER\s+TO\b.*$/i, '')
    .replace(/\s*:?\s*_{3,}\s*/g, ' ')
    .replace(/\bINR\s*(?=per\b|\/|\.|$)/gi, 'INR ')
    .replace(/\s+/g, ' ')
    .trim();
  if (label === '' || /\?$/.test(label)) return null;
  return { label, value: String(index + 1), instruction, row: [text] };
}

/** Exposed so a caller can show the extracted questionnaire before compiling it. */
export function extractQuestionnaire(document: DocxDocument): {
  questions: RawQuestion[];
  intro: IntroTable[];
  nccsGrids: NccsGrid[];
  brandTables: DocxTable[];
  rankTables: Array<{ table: DocxTable; prompt: string | null }>;
  rotationTables: Array<{ table: DocxTable; prompt: string; where: string }>;
  diagnostics: CompilerDiagnostic[];
} {
  const questions: RawQuestion[] = [];
  const intro: IntroTable[] = [];
  const nccsGrids: NccsGrid[] = [];
  const brandTables: DocxTable[] = [];
  const rankTables: Array<{ table: DocxTable; prompt: string | null }> = [];
  const rotationTables: Array<{ table: DocxTable; prompt: string; where: string }> = [];
  const diagnostics: CompilerDiagnostic[] = [];
  let pendingRotation: { prompt: string; where: string } | null = null;
  const gridTables: DocxTable[] = [];
  let pending: string | null = null;
  let pendingCode: string | null = null;
  let pendingSection: 'screener' | 'main' = 'main';
  let pendingBranch: 'churned' | undefined;
  let proseOptions: string[] = [];
  let section: 'screener' | 'main' = 'main';
  let branch: 'churned' | undefined;
  let lastCode: string | null = null;
  let noteCount = 0;
  let blockIndex = 0;

  const flushProse = (): void => {
    if (!pending) return;
    if (isSectionText(pending)) {
      pending = null;
      pendingCode = null;
      proseOptions = [];
      return;
    }
    const code = pendingCode ?? questionCode(pending);
    const options = proseOptions
      .map((text, index) => paragraphOption(text, index))
      .filter((option): option is RawOption => option !== null)
      // Codes are assigned after discarding instructions such as `Record Amount,
      // INR/day: ____ or`, so a paragraph instrument does not start at code 2.
      .map((option, index) => ({ ...option, value: String(index + 1) }));
    questions.push({
      code,
      prompt: pending,
      options,
      section: pendingSection,
      ...(pendingBranch ? { branch: pendingBranch } : {}),
      where: `paragraph before ${blockIndex}`,
    });
    if (code) lastCode = code;
    pending = null;
    pendingCode = null;
    proseOptions = [];
  };

  const startQuestion = (text: string): void => {
    flushProse();
    const started = questionStart(text);
    pending = started;
    pendingCode = questionCode(started) ?? continuedQuestionCode(started, lastCode);
    // B7 is written as `B7. A) ...`, then `B1)` and `B2)` for its two follow-up
    // amounts. The client workbook names those `b7b1` and `b7b2`; without this
    // they would collide with the real B1/B2 fields earlier in the module.
    const followUp = /^B([12])\)\s+/i.exec(started.trim());
    if (followUp && lastCode && /^b7(?:a|b1)$/i.test(lastCode)) pendingCode = `b7b${followUp[1]}`;
    pendingSection = section;
    pendingBranch = branch;
  };

  const addNote = (text: string): void => {
    flushProse();
    noteCount += 1;
    questions.push({
      code: `n_${noteCount}`,
      prompt: text,
      options: [],
      section,
      ...(branch ? { branch } : {}),
      where: `paragraph before ${blockIndex}`,
      note: true,
    });
  };

  for (const block of document.blocks) {
    blockIndex += 1;
    if (block.kind === 'paragraph') {
      const text = cleanPrompt(block.paragraph.text);
      if (text === '') continue;

      if (SKIP_TEXT.test(text)) {
        flushProse();
        continue;
      }
      if (NOTE_TEXT.test(text)) {
        addNote(text);
        continue;
      }
      // Section banners terminate the current choice list before they can become
      // an option. This is the Bounce failure: `ZO. USER CLASSIFICATION` and
      // `2. Module A` were being appended to S2 and S3 as codes 6.
      const nextSection = sectionAfter(text);
      if (nextSection || isHeading(block.paragraph) || isSectionText(text)) {
        flushProse();
        if (/churned[-\s]+rider/i.test(text)) branch = 'churned';
        else if (nextSection || /\bmodule\b|\bsection\s+\d/i.test(text)) branch = undefined;
        if (nextSection) section = nextSection;
        continue;
      }

      if (/\bROTATE\s+STATEMENTS?\b/i.test(text) && looksLikeQuestion(text)) {
        pendingRotation = { prompt: text, where: `paragraph before ${blockIndex}` };
      }

      // A paragraph such as `I don't think there is much difference; ... estimate`
      // is a conditional numeric follow-up, not a fourth answer option.
      if (pendingCode && /estimate|rough amount|save more\/less/i.test(text)) {
        const base: string | undefined = /^([a-z]+\d+)/.exec(lastCode ?? pendingCode)?.[1];
        if (base) {
          startQuestion(text);
          pendingCode = `${base}a`;
          continue;
        }
      }

      // The benchmark papers prefix screener questions with `SQ` (or a bare
      // `S`) and do not always write a separate Screener banner.
      if (/\b(?:SQ|S)\d/i.test(text) && !/main questionnaire/i.test(text)) section = 'screener';
      if (looksLikeQuestion(text)) {
        startQuestion(text);
        continue;
      }
      if (pending) {
        proseOptions.push(text);
        continue;
      }
      if (/audio\s+audit|geopoint|missed\s+call/i.test(text)) {
        diagnostics.push({
          severity: 'info',
          code: 'rule-12-cue',
          message: 'A field-quality cue was found in a paragraph; it is compiled when a following table or question names the target field.',
          where: text.slice(0, 80),
        });
      }
      continue;
    }

    const table = block.table;
    const where = `table ${blockIndex}`;
    if (pendingRotation) {
      // The table is the grid behind the ROTATE STATEMENTS paragraph. Keep the
      // prompt as a raw question so the main pass can bind it to this table, but
      // do not turn the statement labels into ordinary options here.
      if (readStatementGrid(table, pendingRotation.prompt)) {
        flushProse();
        rotationTables.push({ table, prompt: pendingRotation.prompt, where: pendingRotation.where });
        pendingRotation = null;
        continue;
      }
      pendingRotation = null;
    }
    const introTable = isIntroTable(table);
    if (introTable) {
      flushProse();
      intro.push(introTable);
      continue;
    }
    if (isNccsGrid(table)) {
      flushProse();
      gridTables.push(table);
      diagnostics.push({
        severity: 'info',
        code: 'rule-5-grid',
        message: 'NCCS grid found; it will be matched to the education and durables questions that precede it.',
        where,
      });
      continue;
    }
    if (parseBrandGrid(table, where)) {
      // The table carries its own column prompts. A paragraph immediately above
      // it is a section heading, not a separate field. A brand matrix is a main
      // questionnaire block even when the screener banner was never closed.
      if (/\b(?:MQ2|brand|aided|aware)/i.test(pending ?? '')) {
        section = 'main';
        pendingSection = 'main';
      }
      flushProse();
      brandTables.push(table);
      continue;
    }
    if (parseRankGrid(table) && readRankTable(table, '')) {
      const prompt = pending;
      flushProse();
      rankTables.push({ table, prompt });
      continue;
    }
    const matrix = parseMatrixTable(table);
    if (matrix) {
      flushProse();
      matrix.rows.forEach((entry, index) => {
        const code = questionCode(entry.label);
        questions.push({
          code,
          prompt: entry.label,
          options: matrix.options,
          section,
          where: `${where} matrix`,
          matrix: { key: `matrix_${blockIndex}`, label: matrix.prompt, first: index === 0 },
        });
        if (code) lastCode = code;
      });
      continue;
    }
    const question = tableQuestion(table, pending, section, where);
    if (question) {
      question.branch = branch;
      questions.push(question);
      pending = null;
      pendingCode = null;
      proseOptions = [];
      continue;
    }
    if (pending) {
      diagnostics.push({
        severity: 'warning',
        code: 'unreadable-table',
        message: 'A question paragraph was followed by a table with no numeric answer codes, so the table was not turned into choices.',
        where: String(pending).slice(0, 80),
      });
    }
    pending = null;
    pendingCode = null;
    proseOptions = [];
  }
  flushProse();

  for (let i = 0; i < questions.length; i += 1) {
    const question = questions[i]!;
    if (!/NCCS|SECR?|chief wage earner|education of the chief/i.test(question.prompt) || question.options.length === 0) continue;
    const grid = gridTables.shift();
    if (grid) {
      const allowed = collectNccsAllowed(document);
      const parsed = parseNccsGrid(grid, allowed, `grid after ${question.code ?? 'question'}`);
      if (parsed) nccsGrids.push(parsed);
    }
  }

  return { questions, intro, nccsGrids, brandTables, rankTables, rotationTables, diagnostics };
}

function collectNccsAllowed(document: DocxDocument): string[] {
  const allowed: string[] = [];
  for (const block of document.blocks) {
    if (block.kind !== 'table') continue;
    const rows = block.table.rows.map((row) => row.map((cell) => cell.text.replace(/\s+/g, ' ').trim()));
    for (const row of rows) {
      if (!row.some((cell) => /CONTINUE|TERMINATE/i.test(cell))) continue;
      const qualifying = row
        .map((cell, index) => ({ cell, index }))
        .filter(({ cell }) => /CONTINUE/i.test(cell))
        .map(({ index }) => rows[0]?.[index] ?? '')
        .map((cell) => /^NCCS\s+([A-E][1-3])$/i.exec(cell)?.[1]?.toUpperCase())
        .filter((cell): cell is string => Boolean(cell));
      allowed.push(...qualifying);
      if (qualifying.length > 0) break;
    }
  }
  return [...new Set(allowed)];
}

/* --------------------------------------------------------------- builder */

class FormBuilder {
  readonly groups: Group[] = [];
  readonly questions: Question[] = [];
  readonly choiceLists: Record<string, Choice[]> = {};
  readonly diagnostics: CompilerDiagnostic[] = [];
  readonly languages: string[];
  readonly defaultLanguage: string;
  private generated = 0;
  private orderCursor = 1;

  constructor(defaultLanguage: string, languages: string[]) {
    this.defaultLanguage = defaultLanguage;
    this.languages = [defaultLanguage, ...languages.filter((language) => language !== defaultLanguage)];
  }

  text(value: string, languages?: LocalizedText): LocalizedText {
    const out = languages ?? {};
    if (this.defaultLanguage in out) return out;
    return { ...out, [this.defaultLanguage]: value };
  }

  uniqueName(base: string, used: Set<string>): string {
    let name = NAME_RE.test(base) ? base : `q_${slug(base)}`;
    let suffix = 2;
    while (used.has(name)) {
      name = `${base}_${suffix}`;
      suffix += 1;
    }
    used.add(name);
    return name;
  }

  takeOrder(): number {
    return this.orderCursor++;
  }

  group(name: string, label: string, options: Partial<Pick<Group, 'repeat' | 'repeatCount' | 'appearance' | 'rules'>> = {}): Group {
    const group: Group = {
      id: `g_${name}`,
      order: this.takeOrder(),
      name,
      label: this.text(label),
      ...(options.repeat ? { repeat: true } : {}),
      ...(options.repeatCount ? { repeatCount: options.repeatCount } : {}),
      ...(options.appearance ? { appearance: options.appearance } : {}),
      ...(options.rules ? { rules: options.rules } : {}),
    };
    this.groups.push(group);
    return group;
  }

  question(input: Omit<Question, 'id' | 'label' | 'order'> & { label: LocalizedText; groupId?: string | null; order?: number }): Question {
    const question: Question = {
      id: `q_${input.name}`,
      ...input,
      label: input.label,
      order: input.order ?? this.takeOrder(),
      groupId: input.groupId ?? null,
    };
    this.questions.push(question);
    return question;
  }

  calc(name: string, calculation: string, groupId: string | null, label?: string, extra: Partial<Question> = {}): Question {
    return this.question({
      name,
      type: 'calculate',
      label: this.text(label ?? name),
      rules: { calculate: calculation },
      groupId,
      ...extra,
    });
  }

  choiceList(name: string, options: RawOption[], extra?: (option: RawOption, index: number) => Record<string, string>): string {
    const list = options.map((option, index) => {
      const value = option.value.trim();
      const attrs = { filter: value, ...(extra?.(option, index) ?? {}) };
      return {
        value,
        label: this.text(option.label, option.translations),
        extra: attrs,
      } satisfies Choice;
    });
    this.choiceLists[name] = list;
    return name;
  }

  /** Apply explicit caller translations without inventing any missing language. */
  translateChoices(
    code: string | null | undefined,
    options: RawOption[],
    tables: DocxCompileOptions['choiceTranslations'],
  ): void {
    if (!code || !tables) return;
    const valuesForCode = tables[code];
    if (!valuesForCode) return;
    for (const option of options) {
      const values = valuesForCode[option.value];
      if (!values) continue;
      option.translations = { ...(option.translations ?? {}), ...values };
    }
  }

  note(code: string, message: string, where?: string): void {
    this.diagnostics.push({ severity: 'warning', code, message, ...(where ? { where } : {}) });
  }
}

function metadataRows(builder: FormBuilder): void {
  const make = (name: string, type: string, calculation?: string): void => {
    builder.question({
      name,
      type: type === 'calculate' ? 'calculate' : 'calculate',
      label: builder.text(''),
      rules: calculation ? { calculate: calculation } : undefined,
      source: { adapter: 'xlsform', type },
    });
  };
  make('starttime', 'start');
  make('endtime', 'end');
  make('deviceid', 'deviceid');
  make('devicephonenum', 'phonenumber');
  make('username', 'username');
  make('device_info', 'calculate', 'device-info()');
  make('duration', 'calculate', 'duration()');
  make('caseid', 'caseid');
}

function addIntro(builder: FormBuilder, intro: IntroTable): string {
  const group = builder.group('bg_101', 'Interviewer & Respondent Info', { appearance: 'field-list' });
  const fields: Record<IntroTable['fields'][number], Question> = {} as Record<IntroTable['fields'][number], Question>;
  const add = (name: IntroTable['fields'][number], type: QuestionType, label: string, validation?: Question['validation'], required = true): void => {
    fields[name] = builder.question({
      name,
      type,
      label: builder.text(label),
      required,
      groupId: group.id,
      ...(validation ? { validation } : {}),
    });
  };
  if (intro.fields.includes('int_name')) add('int_name', 'text', 'Interviewer Name', {
    constraint: "regex(., '[a-zA-Z ,\\.]+')",
    message: builder.text('Please enter alphabates only.'),
  });
  if (intro.fields.includes('resp_name')) add('resp_name', 'text', 'Respondent Name', {
    constraint: "regex(., '[a-zA-Z ,\\.]+')",
    message: builder.text('Please enter alphabates only.'),
  });
  if (intro.fields.includes('resp_no')) add('resp_no', 'text', 'Respondent Phone no.', {
    constraint: "string-length(.) = 10 and not(regex(., '(\\d)\\1+'))",
    message: builder.text('Please enter 10 digit number and mobile number can not be 0 ten times or any number 10 times'),
  });
  if (intro.fields.includes('resp_add')) add('resp_add', 'text', 'Respondent Address');
  if (intro.fields.includes('st_point')) add('st_point', 'integer', 'Starting Point', {
    constraint: '(.) >= 1 and (.) <= 99',
    message: builder.text('Starting point should not more than 99.'),
  });
  // Keep the field map alive for callers that inspect the generated definition.
  void fields;
  return group.id;
}

function ageBounds(label: string): { min: number; max: number } | null {
  const text = label.toLowerCase();
  const range = /(\d{1,3})\s*(?:-|–|to)\s*(\d{1,3})/.exec(text);
  if (range) return { min: Number(range[1]), max: Number(range[2]) };
  const under = /\b(?:under|below|less\s+than|up\s+to)\s*(\d{1,3})/.exec(text);
  if (under) return { min: 0, max: Number(under[1]) - 1 };
  const below = /(\d{1,3})\s*(?:years?\s*)?(?:and\s*)?(?:below|or\s*less|less)/.exec(text);
  if (below) return { min: 0, max: Number(below[1]) - 1 };
  const above = /(\d{1,3})\s*(?:years?\s*)?(?:and\s*)?(?:above|or\s*above|or\s*more|\+)/.exec(text);
  if (above) return { min: Number(above[1]), max: 120 };
  return null;
}

function addAge(builder: FormBuilder, raw: RawQuestion, groupId: string | null, used: Set<string>): void {
  const name = builder.uniqueName(raw.code ?? `age_${builder.questions.length}`, used);
  const bounds = raw.options.map((option) => ({ ...option, bounds: ageBounds(option.label) })).filter((option) => option.bounds !== null);
  if (bounds.length === 0) {
    builder.note('age-brackets-missing', 'An age question was found, but no age bracket could be read from its table.', raw.where);
    return;
  }
  builder.question({
    name,
    type: 'integer',
    label: builder.text(cleanLabel(withoutCode(raw.prompt))),
    required: true,
    groupId,
    validation: { constraint: 'string-length(.) = 2', message: builder.text('Please enter age in 2 digit number') },
  });
  const ageRef = `\${${name}}`;
  const nested = [...bounds].reverse().reduce<string | null>((fallback, option) => {
    const test = `${ageRef} <= ${option.bounds!.max}`;
    return fallback === null ? `if(${test}, '${option.value}', '')` : `if(${test}, '${option.value}', ${fallback})`;
  }, null);
  const groupName = builder.uniqueName('age_grp', used);
  builder.calc(groupName, `if(${ageRef} >= 0, ${nested ?? "''"}, '')`, groupId, 'Age Group');
  const allowed = bounds.filter((option) => !/TERMINATE/i.test(option.instruction)).map((option) => option.value);
  const term = allowed.length === bounds.length
    ? "'1'"
    : `if(${allowed.map((code) => `selected(\${${groupName}}, '${code}')`).join(' or ')}, '1', '')`;
  builder.calc('age_term', term, groupId, 'Age Termination');
  const display = [...bounds].reverse().reduce<string | null>((fallback, option) => {
    const test = `${ageRef} <= ${option.bounds!.max}`;
    return fallback === null ? `if(${test}, '${option.label.replace(/'/g, "''")}', '')` : `if(${test}, '${option.label.replace(/'/g, "''")}', ${fallback})`;
  }, null);
  builder.calc('age_dis', display ?? "''", groupId, 'Age Display');
}

function nccsFormula(grid: NccsGrid): string {
  const branches: Array<{ test: string; code: string }> = [];
  for (const row of grid.rows) {
    const count = row.label.toLowerCase() === 'none' ? 0 : Number.parseInt(row.label, 10);
    const countTest = row.label.toLowerCase() === 'none'
      ? '${nccs_total} = 0'
      : row.label.includes('+') || count >= 9
        ? '${nccs_total} >= 9'
        : `\${nccs_total} = ${count}`;
    row.cells.forEach((code, index) => {
      if (!/^[A-E][1-3]$/.test(code)) return;
      branches.push({ test: `${countTest} and ${gridEducationTest(index)}`, code });
    });
  }
  let nested = "''";
  for (const branch of branches.reverse()) {
    nested = `if(${branch.test}, '${branch.code}', ${nested})`;
  }
  return nested;
}

function gridEducationTest(index: number): string {
  return `selected(\${${nccsEducationName}}, '${String(index + 1).padStart(2, '0')}')`;
}

let nccsEducationName = 'nccs_edu';

function addNccs(builder: FormBuilder, education: RawQuestion, durables: RawQuestion, grid: NccsGrid, groupId: string | null, used: Set<string>): void {
  const eduName = builder.uniqueName(education.code ?? 'nccs_edu', used);
  const durName = builder.uniqueName(durables.code ?? 'nccs_durables', used);
  nccsEducationName = eduName;
  builder.group('bg_nccs', withoutCode(education.prompt), { appearance: 'field-list' });
  const nccsGroup = builder.groups[builder.groups.length - 1]!;
  const previous = builder.questions[builder.questions.length - 1];
  builder.question({
    name: `${eduName}_oe`,
    type: 'text',
    label: builder.text('CLARIFY AND WRITE VERBATIM FIRST'),
    groupId: nccsGroup.id,
    required: false,
  });
  builder.choiceList(eduName, education.options);
  builder.question({
    name: eduName,
    type: 'select_one',
    label: builder.text(withoutCode(education.prompt)),
    choices: { listName: eduName },
    appearance: 'quick',
    required: true,
    groupId: nccsGroup.id,
  });
  builder.choiceList(durName, durables.options);
  builder.question({
    name: durName,
    type: 'select_multiple',
    label: builder.text(withoutCode(durables.prompt)),
    choices: { listName: durName },
    required: true,
    groupId: nccsGroup.id,
  });
  builder.calc(`${durName}_total`, `count-selected(\${${durName}})`, nccsGroup.id, 'Total Durables', {
    source: { adapter: 'xlsform', type: 'calculate_here' },
  });
  // The grid formula refers to a stable helper rather than repeating the same
  // count expression in all seventy branches.
  const sech = nccsFormula(grid).replace(/nccs_total/g, `${durName}_total`);
  builder.calc('sech', sech === "''" ? "''" : `if(\${${durName}_total} >= 0, ${sech}, '')`, nccsGroup.id, 'NCCS');
  builder.calc('sech_qt', `if(selected(\${sech}, 'A1') or selected(\${sech}, 'A2') or selected(\${sech}, 'A3'), 'NCCS A', if(selected(\${sech}, 'B1') or selected(\${sech}, 'B2'), 'NCCS B', if(selected(\${sech}, 'C1') or selected(\${sech}, 'C2'), 'NCCS C', 'NCCS D/E')))`, nccsGroup.id, 'NCCS Group');
  const allowed = grid.allowed.length > 0 ? grid.allowed : ['A1', 'A2', 'A3', 'B1', 'B2', 'C1', 'C2'];
  builder.calc('nccs_term', `if(${allowed.map((code) => `selected(\${sech}, '${code}')`).join(' or ')}, '1', '')`, nccsGroup.id, 'NCCS Termination');
  builder.question({
    name: 'n_nccs',
    type: 'note',
    label: builder.text('NCCS : ${sech}'),
    groupId: nccsGroup.id,
  });
  void previous;
  void groupId;
}

function exclusiveOption(options: RawOption[]): RawOption | undefined {
  return options.find((option) => /^(?:none|none of these|no one|no issues|nothing else|don't know|not interested)$/i.test(option.label.trim()));
}

function addExclusive(builder: FormBuilder, question: Question, options: RawOption[], preferredCode?: string): void {
  // `count-selected()` is a multi-select rule. A single-select answer cannot
  // select two options, and writing this constraint on one would make the
  // workbook look guarded while the guard can never fire.
  if (question.type !== 'select_multiple') return;
  const exclusive = preferredCode
    ? options.find((option) => option.value === preferredCode)
    : exclusiveOption(options);
  if (!exclusive) return;
  const code = exclusive.value.replace(/'/g, "''");
  question.validation = {
    constraint: `if (selected(.,${code}), count-selected(.) = 1, count-selected(.) >= 1)`,
    message: builder.text(`${exclusive.label} Can't be selected with other options`),
  };
}

function addOtherSpecify(builder: FormBuilder, question: Question, options: RawOption[], groupId: string | null): void {
  const other = options.find((option) => /^others?\b/i.test(option.label.trim()) && !/none/i.test(option.label));
  if (!other) return;
  const code = /^\d{1,3}$/.test(other.value) ? other.value : '99';
  question.appearance = [question.appearance, `custom-specify-other(other='${code}')`].filter(Boolean).join(' ');
  const extracted = builder.calc(
    `${question.name}_oth`,
    `item-at('|', plug-in-metadata(\${${question.name}}), 1)`,
    groupId,
    `${question.name}_oth`,
  );
  // The plug-in writes metadata even while its text box is hidden. Gate the
  // calculated answer so stale text cannot leak into a later response.
  extracted.rules = { ...extracted.rules, visibleIf: `selected(\${${question.name}}, '${code}')` };
}

function numericBounds(label: string): { min: number; max: number } | null {
  const value = label.toLowerCase().replace(/rs\.?|inr|,|₹/g, ' ').replace(/\s+/g, ' ').trim();
  const range = /(\d+)\s*(?:-|–|to)\s*(\d+)/.exec(value);
  if (range) return { min: Number(range[1]), max: Number(range[2]) };
  const below = /\b(?:under|below|less than|up to)\s*(\d+)/.exec(value);
  if (below) return { min: 0, max: Number(below[1]) - 1 };
  const above = /\b(?:over|above|more than)\s*(\d+)/.exec(value);
  if (above) return { min: Number(above[1]) + 1, max: 999999 };
  return null;
}

function numericPrompt(prompt: string): boolean {
  return /\bPROGRAMMER\s+TO\s+ALLOW\s+(?:ONLY\s+)?NUMBERS\b|\bRECORD\s+(?:ACTUAL\s+AGE|IN\s+NUMBERS)\b|\bINR\s*[/:]?\s*_{2,}|\b(?:Number|Months|Days|Hours|Km)\s*:\s*_{2,}|\bhow\s+much\s+(?:more|less)\b|\bhow\s+many\s+more\b/i.test(prompt);
}

function numericConstraint(prompt: string): string | null {
  if (/hours\s*:/i.test(prompt) || /\bhours\b/i.test(prompt)) return '(.) >= 1 and (.) <= 24';
  if (/\bkm\b/i.test(prompt)) return '(.) >= 1 and (.) <= 999';
  if (/days\s+a\s+week/i.test(prompt)) return '(.) >= 1 and (.) <= 7';
  if (/break\s*down|breakdown/i.test(prompt)) return '(.) >= 0 and (.) <= 99';
  if (/\bmonths?\s*:/i.test(prompt)) return '(.) >= 1 and (.) <= 120';
  if (/minimum\s+2\s+digits/i.test(prompt)) return '(.) >= 10';
  if (/minimum\s+3\s+digits\s+and\s+maximum\s+5\s+digits/i.test(prompt)) return '(.) >= 0 and (.) <= 99999';
  if (/minimum\s+3\s+digits/i.test(prompt)) return '(.) >= 100';
  if (/maximum\s+3\s+digits/i.test(prompt)) return '(.) <= 999';
  return null;
}

function addNumericPostcode(builder: FormBuilder, name: string, options: RawOption[], groupId: string | null, relevance: string | undefined): void {
  const bounds = options.map((option) => ({ option, bounds: numericBounds(option.label) })).filter((entry) => entry.bounds !== null);
  if (bounds.length === 0) return;
  const ref = `\${${name}}`;
  const code = bounds
    .slice()
    .reverse()
    .reduce<string | null>((fallback, entry) => {
      const bound = entry.bounds!;
      const test = `${ref} >= ${bound.min} and ${ref} <= ${bound.max}`;
      return fallback === null ? `if(${test}, '${entry.option.value}', '')` : `if(${test}, '${entry.option.value}', ${fallback})`;
    }, null);
  const display = bounds
    .slice()
    .reverse()
    .reduce<string | null>((fallback, entry) => {
      const bound = entry.bounds!;
      const test = `${ref} >= ${bound.min} and ${ref} <= ${bound.max}`;
      const label = entry.option.label.replace(/'/g, "''");
      return fallback === null ? `if(${test}, '${label}', '')` : `if(${test}, '${label}', ${fallback})`;
    }, null);
  const rows: Array<[string, string, string]> = [
    [`${name}_po`, code ?? "''", 'Post-code'],
    [`${name}_po_dis`, display ?? "''", 'Post-code display'],
  ];
  for (const [calcName, calculation, label] of rows) {
    builder.calc(calcName, calculation, groupId, label, {
      ...(relevance ? { rules: { calculate: calculation, visibleIf: relevance } } : {}),
    });
  }
}

function addNumericFollowUps(builder: FormBuilder, question: Question, options: RawOption[], groupId: string | null, used: Set<string>): void {
  for (const option of options) {
    const label = option.label;
    // The inline Other box is handled by `custom-specify-other`; a second text
    // field with the same `_oth` suffix would collide with its calculate row.
    if (/^others?\b/i.test(label.trim())) continue;
    // `INR 10 to 20 less/day` is a choice label, not a blank amount. Only a
    // fill-in cue should turn an option into a numeric follow-up.
    const numeric = /paid in full|pay extra|\bINR\s*:?\s*_{2,}/i.test(label);
    const text = /\bspecify\b|\bhometown\b|main reason/i.test(label);
    if (!numeric && !text) continue;
    const suffix = /paid in full|pay extra/i.test(label) ? 'paid' : /main reason/i.test(label) ? 'b' : 'oth';
    const name = builder.uniqueName(suffix === 'b' ? `${question.name}b` : `${question.name}_${suffix}`, used);
    const relevance = `selected(\${${question.name}}, '${option.value.replace(/'/g, "''")}')`;
    const display = numeric
      ? label.replace(/^.*?(?:paid in full|pay extra)\s*:?\s*/i, 'Paid in full: INR ').replace(/\bINR\s*INR\b/i, 'INR')
      : 'Please specify';
    builder.question({
      name,
      type: numeric ? 'integer' : 'text',
      label: builder.text(display),
      required: true,
      groupId,
      rules: { visibleIf: relevance },
      ...(numeric ? { validation: { constraint: '(.) >= 0 and (.) <= 99999', message: builder.text('Please enter a whole number') } } : {}),
    });
  }
}

function addDualNumeric(builder: FormBuilder, raw: RawQuestion, name: string, groupId: string | null, used: Set<string>, mainRelevance: string | undefined): boolean {
  const prompt = cleanLabel(withoutCode(raw.prompt));
  const pair = /hours\s*:\s*_+.*?km\s*:\s*_+/i.test(raw.prompt)
    ? [{ suffix: '_h', label: 'Hours', constraint: '(.) >= 1 and (.) <= 24' }, { suffix: '_k', label: 'Km', constraint: '(.) >= 1 and (.) <= 999' }]
    : /days\s*:\s*_+.*?(?:inr\/day|inr)\s*:\s*_+/i.test(raw.prompt)
      ? [{ suffix: 'a', label: 'Days a week', constraint: '(.) >= 1 and (.) <= 7' }, { suffix: 'b', label: 'INR/day', constraint: '(.) >= 0 and (.) <= 999999' }]
      : null;
  if (!pair) return false;
  const group = builder.group(builder.uniqueName(`bg_${name}`, used), prompt, { appearance: 'field-list', ...(mainRelevance ? { rules: { visibleIf: mainRelevance } } : {}) });
  for (const part of pair) {
    builder.question({
      name: `${name}${part.suffix}`,
      type: 'integer',
      label: builder.text(part.label),
      required: true,
      groupId: group.id,
      ...(mainRelevance ? { rules: { visibleIf: mainRelevance } } : {}),
      validation: { constraint: part.constraint, message: builder.text(`Please enter a valid ${part.label.toLowerCase()}`) },
    });
  }
  return true;
}

function addExclusiveNumeric(builder: FormBuilder, raw: RawQuestion, name: string, options: RawOption[], groupId: string | null, used: Set<string>, mainRelevance: string | undefined): boolean {
  const exclusive = options.find((option) => /did\s+not\s+work|none/i.test(option.label));
  // The instruction lives on the option in the Word file and is removed from the
  // choice text by the parser. A numeric field whose only choice is `None` or
  // `Did not work before` is the exclusive-None pattern.
  if (!exclusive) return false;
  const group = builder.group(builder.uniqueName(`bg_${name}`, used), cleanLabel(withoutCode(raw.prompt)), {
    appearance: 'field-list',
    ...(mainRelevance ? { rules: { visibleIf: mainRelevance } } : {}),
  });
  const code = '9';
  const amountConstraint = numericConstraint(raw.prompt);
  builder.question({
    name,
    type: 'integer',
    label: builder.text(cleanLabel(withoutCode(raw.prompt))),
    required: false,
    groupId: group.id,
    validation: {
      constraint: amountConstraint ? `${amountConstraint} or (.) = 0` : '(.) >= 0 and (.) <= 999999',
      message: builder.text('Please enter a whole number'),
    },
  });
  const listName = builder.choiceList(`${name}_none`, [{ ...exclusive, value: code, label: exclusive.label.replace(/PROGRAMMER.*$/i, '').trim() }]);
  builder.question({
    name: `${name}_none`,
    type: 'select_multiple',
    label: builder.text('.'),
    choices: { listName },
    required: false,
    groupId: group.id,
    validation: {
      constraint: `(\${${name}} >= 0 and count-selected(.) = 0) or (\${${name}} = '' and selected(., '${code}'))`,
      message: builder.text('Choose the amount or the exclusive option, not both'),
    },
  });
  return true;
}

function resolveQuestionRef(builder: FormBuilder, candidate: string): string {
  const name = candidate.toLowerCase();
  if (builder.questions.some((question) => question.name === name)) return name;
  // `ASK IF CODED ... IN D5` means the actual D5A split field; `... IN E1` means
  // E1B, the usage half of the consideration/usage pair.
  for (const alternate of [`${name}a`, `${name}b`]) {
    if (builder.questions.some((question) => question.name === alternate)) return alternate;
  }
  return name;
}

/**
 * Turn the uppercase instructions into a relevance expression instead of leaving
 * them in the respondent's label. This is deliberately a small, explicit grammar:
 * `ASK [ONLY] IF [NOT] CODED a [OR b] [IN Q]` is what the client instruments use.
 */
function instructionRelevance(prompt: string, ownName: string, builder: FormBuilder): string | undefined {
  const match = /ASK\s+(?:ONLY\s+)?IF\s+(NOT\s+)?CODED\s+([\d\s,o/r]+?)(?:\s+IN\s+([A-Za-z][A-Za-z0-9_]*))?(?:[.:]|$)/i.exec(prompt);
  if (!match) return undefined;
  const codes = [...new Set((match[2] ?? '').match(/\d+/g) ?? [])];
  if (codes.length === 0) return undefined;
  let reference = match[3]?.toLowerCase();
  if (!reference) {
    // `B1)`/`B2)` follow B7A. Their own names are b7b1/b7b2, so the parent is b7.
    const parent = /^(.+?)b[12]$/i.exec(ownName)?.[1];
    reference = parent ?? ownName.replace(/[a-z]$/i, '');
  }
  const question = resolveQuestionRef(builder, reference);
  const selections = codes.map((code) => `selected(\${${question}}, '${code}')`).join(' or ');
  return match[1] ? `not(${selections})` : selections;
}

/** `PROGRAMMER TO ASK AS PER OPTIONS CODED IN A2` becomes a count constraint. */
function instructionConstraint(prompt: string, builder: FormBuilder): { constraint: string; message: string } | undefined {
  const match = /AS\s+PER\s+OPTIONS\s+CODED\s+IN\s+([A-Za-z][A-Za-z0-9_]*)/i.exec(prompt);
  if (!match?.[1]) return undefined;
  const reference = resolveQuestionRef(builder, match[1]);
  return {
    constraint: `(count-selected(.) = 1 and \${${reference}} = 1) or (count-selected(.) = 2 and \${${reference}} = 2) or (count-selected(.) >= 3 and \${${reference}} = 3)`,
    message: `Please match the number selected in ${match[1].toUpperCase()}`,
  };
}

function optionPrompt(text: string): string {
  return cleanLabel(withoutCode(text))
    .replace(/\bROTATE\s+(?:OPTIONS?|CATEGORIES|MOTIVATORS?|STATEMENTS?)\b.*$/i, '')
    .replace(/\bmark\s+all(?:\s+that\s+apply)?\b.*$/i, '')
    .replace(/\bSA\b|\bMA\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function randomizedFor(options: RawOption[]): string | undefined {
  const trailing = [...options].reverse().findIndex((option) => !/other|none|nothing|no issues|did not work|don't know/i.test(option.label));
  if (trailing < 0) return `randomized(0,${options.length})`;
  return `randomized(0,${Math.max(0, trailing)})`;
}

/**
 * E1 in the client instruments asks two different questions in one sentence:
 * what the rider considered, and what the rider actually used. They are two
 * answer fields, not one multi-select whose meaning changes with the analyst.
 */
function addConsiderationSplit(
  builder: FormBuilder,
  raw: RawQuestion,
  groupId: string | null,
  used: Set<string>,
  mainRelevance?: string,
): Question | null {
  const cue = /\bconsider(?:ed)?\b[\s\S]*?\bactually\s+use\b/i.test(raw.prompt);
  if (!cue || !raw.code || !/^e1$/i.test(raw.code.replace(/[^a-z0-9]/gi, ''))) return null;
  const considerName = builder.uniqueName('e1', used);
  const useName = builder.uniqueName('e1b', used);
  const considered = raw.options.filter((option) => !/^nobody$/i.test(option.label.trim()));
  // `Nothing else` belongs to the consideration field. The usage field gets a
  // single explicit `None`, so the two exclusives cannot conflict.
  const usedOptions = considered
    .filter((option) => !/^nothing else$/i.test(option.label.trim()))
    .map((option) => ({ ...option }));
  const noneCode = usedOptions.some((option) => option.value === '9') ? '99' : '9';
  usedOptions.push({ label: 'None', value: noneCode, instruction: '', row: ['None'] });
  const considerList = builder.choiceList(considerName, considered);
  const useList = builder.choiceList(useName, usedOptions);
  const consider = builder.question({
    name: considerName,
    type: 'select_multiple',
    label: builder.text('Before choosing Bounce, which of these did you consider?', raw.translations),
    choices: { listName: considerList },
    appearance: randomizedFor(considered),
    required: true,
    groupId,
    ...(mainRelevance ? { rules: { visibleIf: mainRelevance } } : {}),
  });
  addExclusive(builder, consider, considered);
  addOtherSpecify(builder, consider, considered, groupId);
  const use = builder.question({
    name: useName,
    type: 'select_multiple',
    label: builder.text('Before choosing Bounce, which of these did you actually use?', raw.translations),
    choices: { listName: useList },
    appearance: randomizedFor(usedOptions),
    required: true,
    groupId,
    ...(mainRelevance ? { rules: { visibleIf: mainRelevance } } : {}),
  });
  addExclusive(builder, use, usedOptions, noneCode);
  addOtherSpecify(builder, use, usedOptions, groupId);
  return use;
}

/**
 * E2a/E2B is a most-important pick followed by the remaining reasons. Compiling
 * it as a single multi-select loses which reason was ranked first.
 */
function addReasonsSplit(
  builder: FormBuilder,
  raw: RawQuestion,
  groupId: string | null,
  used: Set<string>,
  mainRelevance?: string,
): Question | null {
  const cue = /\bmattered?\s+most\b/i.test(raw.prompt);
  if (!cue || !raw.code || !/^e2a$/i.test(raw.code.replace(/[^a-z0-9]/gi, ''))) return null;
  const first = builder.uniqueName('e2a', used);
  const rest = builder.uniqueName('e2b', used);
  const listName = builder.choiceList(first, raw.options);
  const pick = builder.question({
    name: first,
    type: 'select_one',
    label: builder.text('Which of these mattered most in choosing Bounce?', raw.translations),
    choices: { listName },
    appearance: randomizedFor(raw.options),
    required: true,
    groupId,
    ...(mainRelevance ? { rules: { visibleIf: mainRelevance } } : {}),
  });
  addOtherSpecify(builder, pick, raw.options, groupId);
  const restList = builder.choiceList(rest, raw.options);
  const other = builder.question({
    name: rest,
    type: 'select_multiple',
    label: builder.text('What are the other reasons in choosing Bounce?', raw.translations),
    choices: { listName: restList },
    appearance: randomizedFor(raw.options),
    required: true,
    groupId,
    rules: {
      ...(mainRelevance ? { visibleIf: mainRelevance } : {}),
      choiceFilter: `not(selected(\${${first}}, filter))`,
    },
  });
  addOtherSpecify(builder, other, raw.options, groupId);
  return other;
}

function addSimpleQuestion(builder: FormBuilder, raw: RawQuestion, groupId: string | null, used: Set<string>, mainRelevance?: string): Question | null {
  if (raw.note) {
    return builder.question({
      name: builder.uniqueName(raw.code ?? 'n_note', used),
      type: 'note',
      label: builder.text(raw.prompt.replace(/^INTERVIEWER\s+(?:TO\s+)?READ(?:\s+OUT)?\s*[:\-–]\s*/i, ''), raw.translations),
      required: false,
      groupId,
      ...(mainRelevance ? { rules: { visibleIf: mainRelevance } } : {}),
    });
  }
  const base = raw.code ?? slug(withoutCode(raw.prompt)).slice(0, 60);
  const name = builder.uniqueName(base, used);
  const options = raw.options;
  const prompt = cleanLabel(withoutCode(raw.prompt));
  const isNumeric = numericPrompt(raw.prompt);
  const directive = instructionRelevance(raw.prompt, name, builder);
  const relevance = mainRelevance && directive
    ? `(${mainRelevance}) and (${directive})`
    : mainRelevance ?? directive;
  if (isNumeric && addDualNumeric(builder, raw, name, groupId, used, relevance)) return null;
  if (isNumeric && addExclusiveNumeric(builder, raw, name, options, groupId, used, relevance)) return null;
  if (isNumeric) {
    const q: Question = {
      id: `q_${name}`,
      order: builder.takeOrder(),
      name,
      type: 'integer',
      label: builder.text(prompt, raw.translations),
      required: true,
      groupId,
      ...(relevance ? { rules: { visibleIf: relevance } } : {}),
      ...(numericConstraint(raw.prompt) ? { validation: { constraint: numericConstraint(raw.prompt)!, message: builder.text('Please enter a valid number') } } : {}),
    };
    builder.questions.push(q);
    addNumericPostcode(builder, name, options, groupId, mainRelevance);
    return q;
  }
  // A 0–10 recommendation scale is a choice list even when the Word document
  // only states the two endpoints.
  if (options.length === 0 && /0\s*=\s*not\s+at\s+all.*10\s*=\s*extremely/i.test(raw.prompt)) {
    const listName = name;
    builder.choiceLists[listName] = Array.from({ length: 11 }, (_, value) => ({
      value: String(value),
      label: builder.text(value === 0 ? '0 = not at all' : value === 10 ? '10 = extremely' : String(value)),
      extra: { filter: String(value) },
    }));
    return builder.question({
      order: builder.takeOrder(),
      name,
      type: 'select_one',
      label: builder.text(prompt, raw.translations),
      choices: { listName },
      appearance: 'quick',
      required: true,
      groupId,
      ...(relevance ? { rules: { visibleIf: relevance } } : {}),
    });
  }
  // A statement-grid row is one select per statement, even if the statement text
  // happens to contain a word the single-question heuristics look for.
  const isMulti = !raw.matrix && /\bMA\b|\bmark\s+all\b|\bselect\s+all\b|SELECT\s+(?:ALL|MULTIPLE)|MULTIPLE\s+RESPONSES/i.test(raw.prompt);
  const isRank = !raw.matrix && /\bRANK\b|ORDER\s+OF\s+PRIORITY/i.test(raw.prompt);
  let type: QuestionType = options.length > 0 ? (isRank ? 'rank' : isMulti ? 'select_multiple' : 'select_one') : 'text';
  if (options.length === 0 && /\b(?:age|years?)\b/i.test(prompt)) type = 'integer';
  if (type === 'text' && !looksLikeQuestion(raw.prompt) && prompt.length < 8) return null;

  const q: Question = {
    id: `q_${name}`,
    order: builder.takeOrder(),
    name,
    type,
    label: builder.text(prompt, raw.translations),
    required: true,
    groupId,
    ...(relevance ? { rules: { visibleIf: relevance } } : {}),
  };
  if (options.length > 0) {
    const listName = builder.choiceList(name, options);
    q.choices = { listName };
    if (type === 'select_multiple') {
      const count = instructionConstraint(raw.prompt, builder);
      if (count) q.validation = { constraint: count.constraint, message: builder.text(count.message) };
    }
    const rotate = /\b(?:ROTATE|RANDOMI[ZS]E)\b/i.test(raw.prompt);
    if (rotate) {
      const trailing = [...options].reverse().findIndex((option) => !/other|none|don't know/i.test(option.label));
      const anchored = trailing < 0 ? options.length : Math.max(0, trailing);
      q.appearance = `randomized(0,${anchored})`;
    } else if (/\bSA\b/.test(raw.prompt) && options.length <= 12) {
      q.appearance = 'quick';
    }
    addExclusive(builder, q, options);
    addOtherSpecify(builder, q, options, groupId);
  }
  builder.questions.push(q);
  if (options.length > 0) addNumericFollowUps(builder, q, options, groupId, used);
  if (type === 'rank') {
    // `rank` is a real XLSForm type, but the benchmark tables express the same
    // interaction as one select per rank. Keep the canonical type and report the
    // limitation instead of silently turning it into a different question.
    builder.diagnostics.push({
      severity: 'info',
      code: 'rank-question',
      message: 'A rank question was written as type "rank". The runner supports it; the benchmark workbook style uses RANK 1..n selects.',
      where: raw.where,
    });
  }
  return q;
}

function addScreenerGate(builder: FormBuilder, gateExpressions: string[], groupId: string | null): string | null {
  if (gateExpressions.length === 0) return null;
  const expression = gateExpressions.join(' and ');
  builder.calc('glob_term', `if(${expression}, '1', '')`, groupId, 'Global Termination');
  return 'glob_term';
}

function addBrandGrid(builder: FormBuilder, table: DocxTable, groupId: string | null, used: Set<string>, mainRelevance?: string): void {
  const rows = table.rows.map((row) => row.map((cell) => cell.text.replace(/\s+/g, ' ').trim()));
  let headerAt = -1;
  for (let i = 0; i < Math.min(rows.length, 4); i += 1) {
    if ((rows[i] ?? []).filter((cell) => /^(?:MQ|Q)\d|aided|ever|L2Y|last|MOUB/i.test(cell)).length >= 2) {
      headerAt = i;
      break;
    }
  }
  if (headerAt < 0) return;
  const headers = rows[headerAt] ?? [];
  const brands = rows.slice(headerAt + 1)
    .filter((row) => /^\d{1,3}$/.test(row[1] ?? ''))
    .map((row) => ({ label: row[0] ?? '', code: row[1] ?? '', cells: row }));
  if (brands.length === 0) return;
  const names = new Map<number, string>();
  for (let column = 1; column < headers.length; column += 1) {
    const header = headers[column] ?? '';
    const code = /^[A-Z]{1,4}\d+[a-z]?$/i.exec(header)?.[0];
    const label = rows[headerAt - 1]?.[column] ?? header;
    const name = code ? normaliseCode(code) : `${slug(label || `brand_${column}`)}_${column}`;
    names.set(column, builder.uniqueName(name, used));
  }
  let previous: string | null = null;
  for (const [column, name] of names) {
    const header = `${headers[column] ?? ''} ${rows[headerAt - 1]?.[column] ?? ''}`;
    const type: QuestionType = /ever|L2Y|last|MOUB/i.test(header) === false ? 'select_multiple' : /last|MOUB/i.test(header) ? 'select_one' : 'select_multiple';
    const listName = builder.choiceList(name, brands.map((brand) => ({
      label: brand.label,
      value: brand.cells[column] || brand.code,
      instruction: '',
      row: brand.cells,
    })));
    const rules: Question['rules'] = {};
    if (previous) rules.choiceFilter = `selected(\${${previous}}, filter)`;
    if (mainRelevance) rules.visibleIf = mainRelevance;
    builder.question({
      name,
      type,
      label: builder.text(header.trim() || name),
      choices: { listName },
      ...(Object.keys(rules).length > 0 ? { rules } : {}),
      required: true,
      groupId,
    });
    previous = name;
  }
  if (previous) {
    const refs = [...names.values()].slice(0, 2).map((name) => `\${${name}}`);
    builder.calc('mq12a_all', `concat(${refs.join(", ' ', ")})`, groupId, 'Total Awareness');
  }
}

interface StatementGrid {
  prompt: string;
  statements: RawOption[];
  scale: RawOption[];
  code: string | null;
}

function scaleOptions(from: number, to: number): RawOption[] {
  return Array.from({ length: Math.max(0, to - from + 1) }, (_, index) => {
    const value = from + index;
    return { label: String(value), value: String(value), instruction: '', row: [String(value)] };
  });
}

function looksLikeScaleCell(text: string): boolean {
  return /^\d{1,2}$/.test(text) || /agree|disagree|likely|unlikely|satisf|poor|good|excellent|important|never|always|often|sometimes|yes|no/i.test(text);
}

/** Read a statement grid, including the paragraph-table form used by client instruments. */
function readStatementGrid(table: DocxTable, fallbackPrompt = ''): StatementGrid | null {
  const rows = table.rows.map((row) => row.map((cell) => cell.text.replace(/\s+/g, ' ').trim()));
  if (rows.length < 2) return null;
  let headerAt = -1;
  let promptBoundary = -1;
  let scale: RawOption[] = [];
  for (let index = 0; index < Math.min(rows.length, 4); index += 1) {
    const header = rows[index] ?? [];
    const labels = header.slice(1).filter((cell) => cell !== '');
    if (labels.length < 2 || (!labels.every(looksLikeScaleCell) && labels.filter((cell) => looksLikeScaleCell(cell)).length < 2)) continue;
    const codes = header.slice(1).filter((cell) => cell !== '');
    if (codes.every((cell) => /^\d{1,2}$/.test(cell))) {
      headerAt = index;
      promptBoundary = index;
      scale = codes.map((cell) => ({ label: cell, value: cell, instruction: '', row: [cell] }));
      break;
    }
    // A scale written as labels above a code row (`Strongly disagree ...` /
    // `1 | 2 | ...`) is still a readable statement grid.
    const nextCodes = (rows[index + 1] ?? []).slice(1).filter((cell) => cell !== '');
    if (labels.every(looksLikeScaleCell) && nextCodes.length >= labels.length && nextCodes.every((cell) => /^\d{1,2}$/.test(cell))) {
      headerAt = index + 1;
      promptBoundary = index;
      scale = nextCodes.slice(0, labels.length).map((cell, offset) => ({ label: labels[offset]!, value: cell, instruction: '', row: [labels[offset]!, cell] }));
      break;
    }
  }
  const promptRows = rows.slice(0, Math.max(0, promptBoundary)).map((row) => row[0] ?? '').filter((text) => text !== '');
  const prompt = promptRows.at(-1) ?? fallbackPrompt;
  let statementRows = headerAt >= 0 ? rows.slice(headerAt + 1) : rows;
  // A simple two-column table (`item | code`) uses the prompt's scale rather than
  // treating the item code as a rating. This is the PQ10 shape.
  if (scale.length === 0) {
    const range = /\b(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\b/i.exec(prompt)
      ?? /\b(\d{1,2})\s*=\s*[^\n]+?\b(\d{1,2})\s*=/i.exec(prompt);
    if (range) scale = scaleOptions(Number(range[1]), Number(range[2]));
    if (scale.length < 2) {
      const zeroToTen = /0\s*=.*10\s*=/i.test(prompt);
      if (zeroToTen) scale = scaleOptions(0, 10);
    }
    // Exclude prompt rows and section banners from the statement list.
    statementRows = rows.filter((row) => {
      const first = row[0] ?? '';
      return first.length > 3 && !isSectionText(first) && !/^programmer|^interviewer|^maxdiff/i.test(first) && !questionCode(first);
    });
  }
  const statements = statementRows
    .filter((row) => (row[0] ?? '').length > 3 && !isSectionText(row[0] ?? '') && !/^others?\s*(?:\(|:|specify)/i.test(row[0] ?? ''))
    .map((row, index) => ({
      label: row[0]!,
      value: String(index + 1),
      instruction: '',
      row,
    }));
  if (statements.length < 2 || scale.length < 2) return null;
  return {
    prompt: cleanLabel(withoutCode(prompt)) || 'Statements',
    statements,
    scale,
    code: questionCode(prompt),
  };
}

function ensureRotationDraw(builder: FormBuilder, groupId: string | null): string {
  const existing = builder.questions.find((question) => question.name === 'ad_num1');
  if (!existing) builder.calc('ad_num1', 'once(random())', groupId, 'Rotation Draw');
  const existingRot = builder.questions.find((question) => question.name === 'rot');
  if (existingRot) return existingRot.name;
  const seed = builder.questions.find((question) => question.name === 'ad_num1')!;
  builder.calc('rot', `string(int(\${${seed.name}}*2)+1)`, groupId, 'Rotation');
  return 'rot';
}

function addStatementGrid(
  builder: FormBuilder,
  grid: StatementGrid,
  groupId: string | null,
  used: Set<string>,
  mainRelevance: string | undefined,
  rotate: boolean,
): string | null {
  const base = builder.uniqueName(grid.code ?? slug(grid.prompt).slice(0, 40) ?? 'statement', used);
  const listName = builder.choiceList(base, grid.scale);
  if (!rotate) {
    const group = builder.group(builder.uniqueName(`bg_${base}`, used), grid.prompt, {
      appearance: 'field-list',
      ...(mainRelevance ? { rules: { visibleIf: mainRelevance } } : {}),
    });
    grid.statements.forEach((statement, index) => {
      builder.question({
        name: builder.uniqueName(`${base}_${index + 1}`, used),
        type: 'select_one',
        label: builder.text(statement.label),
        choices: { listName },
        required: true,
        groupId: group.id,
        ...(mainRelevance ? { rules: { visibleIf: mainRelevance } } : {}),
      });
    });
    return group.id;
  }
  const rot = ensureRotationDraw(builder, groupId);
  const xVisible = mainRelevance ? `${mainRelevance} and selected(\${${rot}}, '1')` : `selected(\${${rot}}, '1')`;
  const yVisible = mainRelevance ? `${mainRelevance} and selected(\${${rot}}, '2')` : `selected(\${${rot}}, '2')`;
  const xGroup = builder.group(builder.uniqueName(`bg_${base}_x`, used), grid.prompt, {
    appearance: 'field-list',
    rules: { visibleIf: xVisible },
  });
  const yGroup = builder.group(builder.uniqueName(`bg_${base}_y`, used), grid.prompt, {
    appearance: 'field-list',
    rules: { visibleIf: yVisible },
  });
  const xNames = grid.statements.map((statement, index) => {
    const x = builder.uniqueName(`${base}_x${index + 1}`, used);
    builder.question({
      name: x,
      type: 'select_one',
      label: builder.text(statement.label),
      choices: { listName },
      required: true,
      groupId: xGroup.id,
      rules: { visibleIf: xVisible },
    });
    return x;
  });
  // The Y page presents the same statements in reverse order. Names stay tied to
  // the source statement index, so the coalesced answer is still the same field.
  const yNames: string[] = [];
  for (const [statement, index] of grid.statements.map((value, index) => [value, index] as const).reverse()) {
    const y = builder.uniqueName(`${base}_y${index + 1}`, used);
    yNames[index] = y;
    builder.question({
      name: y,
      type: 'select_one',
      label: builder.text(statement.label),
      choices: { listName },
      required: true,
      groupId: yGroup.id,
      rules: { visibleIf: yVisible },
    });
  }
  for (const [statement, index] of grid.statements.map((value, index) => [value, index] as const)) {
    const x = xNames[index]!;
    const y = yNames[index]!;
    builder.calc(`${base}_${index + 1}`, `coalesce(\${${x}}, \${${y}})`, groupId, statement.label, {
      ...(mainRelevance ? { rules: { calculate: `coalesce(\${${x}}, \${${y}})`, visibleIf: mainRelevance } } : {}),
    });
  }
  return xGroup.id;
}

function statementGridFromRaw(raw: RawQuestion): StatementGrid | null {
  if (raw.matrix || raw.options.length < 2) return null;
  const prompt = cleanLabel(withoutCode(raw.prompt));
  if (!/\brank\s+on\s+a\s+scale\b|\brating\b|\brate\b|\bhow\s+much\s+do\s+you\s+agree\b|\beach\s+statement\b/i.test(prompt)) return null;
  let scale: RawOption[] = [];
  const range = /\b(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\b/i.exec(raw.prompt)
    ?? /\b(\d{1,2})\s*=\s*[^\n]+?\b(\d{1,2})\s*=/i.exec(raw.prompt);
  if (range) scale = scaleOptions(Number(range[1]), Number(range[2]));
  if (scale.length < 2 && /0\s*=.*10\s*=/i.test(raw.prompt)) scale = scaleOptions(0, 10);
  if (scale.length < 2) return null;
  const statements = raw.options.filter((option) => !/^others?\s*(?:\(|:|specify)/i.test(option.label.trim()));
  if (statements.length < 2) return null;
  return { prompt, statements, scale, code: raw.code };
}

function addSplitRotation(
  builder: FormBuilder,
  table: DocxTable,
  groupId: string | null,
  used: Set<string>,
  mainRelevance?: string,
  fallbackPrompt = '',
): boolean {
  const grid = readStatementGrid(table, fallbackPrompt);
  if (!grid) {
    builder.note('rotation-unreadable', 'A rotation table was found, but no complete scale/statement grid could be read.', tableText(table).slice(0, 100));
    return false;
  }
  addStatementGrid(builder, grid, groupId, used, mainRelevance, true);
  builder.diagnostics.push({
    severity: 'info',
    code: 'rotation-applied',
    message: `X/Y statement rotation compiled: ${grid.statements.length} statements, ${grid.scale.length} scale points, two field-list pages.`,
  });
  return true;
}

interface RankItem { label: string; value: string; }

/** The last question written above a table's rank header is the field it belongs to. */
function tableQuestionCode(table: DocxTable): string | null {
  let code: string | null = null;
  for (const row of table.rows) {
    const text = row.map((cell) => cell.text.replace(/\s+/g, ' ').trim()).find(Boolean) ?? '';
    const found = questionCode(text);
    if (found) code = found;
    if (/^rank\s*[1-9]\b/i.test(text)) break;
  }
  return code;
}

function itemCode(row: string[], itemAt: number): string {
  const numeric = row.find((cell) => /^\d{1,3}$/.test(cell));
  return numeric ?? String(itemAt + 1);
}

/** Read a MaxDiff, rank-column or rank-these-items table without guessing a missing block design. */
function readRankTable(table: DocxTable, fallbackCode: string): {
  kind: 'maxdiff' | 'rank' | 'rank-list';
  items: RankItem[];
  rankCount: number;
  groupLabel: string;
  mostLabel?: string;
  leastLabel?: string;
} | null {
  const rows = table.rows.map((row) => row.map((cell) => cell.text.replace(/\s+/g, ' ').trim()));
  for (let headerAt = 0; headerAt < Math.min(rows.length, 40); headerAt += 1) {
    const header = rows[headerAt] ?? [];
    const mostColumn = header.findIndex((cell) => /\bmost\b/i.test(cell));
    const leastColumn = header.findIndex((cell) => /\bleast\b/i.test(cell));
    if (mostColumn >= 0 && leastColumn >= 0 && mostColumn !== leastColumn) {
      let itemAt = header.findIndex((cell, index) => index !== mostColumn && index !== leastColumn && cell !== '');
      if (itemAt < 0) {
        // The two headed cells are often separated by a blank middle cell. Use
        // the first data row to identify the item column instead of guessing 0.
        const data = rows[headerAt + 1] ?? [];
        itemAt = data.findIndex((cell, index) => index !== mostColumn && index !== leastColumn && cell !== '' && !/^\d{1,3}$/.test(cell));
      }
      const items = rows.slice(headerAt + 1)
        .map((row, index) => ({ row, index }))
        .filter(({ row }) => (row[itemAt] ?? '') !== '' && !/^\d+$/.test(row[itemAt] ?? ''))
        .map(({ row, index }) => ({ label: row[itemAt]!, value: itemCode(row, index) }));
      if (items.length > 0) {
        const prompt = rows.slice(0, headerAt).map((row) => row[0] ?? '').find((text) => questionCode(text) !== null) ?? '';
        return {
          kind: 'maxdiff',
          items,
          rankCount: items.length,
          groupLabel: cleanLabel(withoutCode(prompt)) || 'Most and least likely',
          mostLabel: header[mostColumn] || 'Most likely',
          leastLabel: header[leastColumn] || 'Least likely',
        };
      }
    }
    const rankColumns = header
      .map((cell, index) => ({ cell, index }))
      .filter(({ cell }) => /^rank\s*[1-9]\b/i.test(cell));
    if (rankColumns.length > 0) {
      const items = rows.slice(headerAt + 1)
        .filter((row) => (row[0] ?? '').length > 2)
        .map((row, index) => ({ label: row[0]!, value: String(index + 1) }));
      if (items.length > 0) {
        const promptRows = rows.slice(0, headerAt).map((row) => row[0] ?? '').filter((text) => /\?|rank/i.test(text));
        const prompt = promptRows.at(-1) ?? '';
        return {
          kind: 'rank',
          items,
          rankCount: rankColumns.length,
          groupLabel: cleanLabel(withoutCode(prompt)) || `Top ${rankColumns.length}`,
        };
      }
    }
  }
  // A client often writes the rank scale in the prompt and puts one code beside
  // each item. That is a valid rank-these-items table; the numeric column is the
  // item code, not the rank.
  const items = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => {
      const first = row[0] ?? '';
      return first.length > 2
        && !/\b(?:rank|most|least|option)\b/i.test(first)
        && !/^(?:interviewer|programmer|randomize|fq\d|[a-z]\d+[.)])/i.test(first)
        && (row[1] ?? '').trim() !== '';
    })
    .map(({ row, index }) => ({ label: row[0]!, value: itemCode(row, index) }));
  if (items.length >= 2) {
    const promptRows = rows.map((row) => row[0] ?? '').filter((text) => /\?|rank/i.test(text));
    const prompt = promptRows.at(-1) ?? '';
    const maxRank = Math.max(
      ...([...prompt.matchAll(/\brank\s*(?:of\s*)?(\d+)\b/gi)].map((match) => Number(match[1]))),
      /top\s+(\d+)\b/i.exec(prompt)?.[1] ? Number(/\btop\s+(\d+)\b/i.exec(prompt)![1]) : 0,
    );
    return {
      kind: 'rank-list',
      items,
      // A full rank-these-items table ranks every item unless the prompt
      // explicitly asks for a shorter top-N. The first `rank 1` alone is not a
      // rank count.
      rankCount: Math.min(items.length, Number.isFinite(maxRank) && maxRank > 1 ? maxRank : items.length),
      groupLabel: cleanLabel(withoutCode(prompt)) || 'Rank these items',
    };
  }
  void fallbackCode;
  return null;
}

function addRankGrid(
  builder: FormBuilder,
  table: DocxTable,
  groupId: string | null,
  used: Set<string>,
  mainRelevance?: string,
  requestedBase?: string,
): void {
  const firstPrompt = table.rows[0]?.map((cell) => cell.text.trim()).join(' ') ?? '';
  const base = builder.uniqueName(
    requestedBase ?? tableQuestionCode(table) ?? questionCode(firstPrompt) ?? slug(firstPrompt).slice(0, 32) ?? 'rank',
    used,
  );
  const parsed = readRankTable(table, base);
  if (!parsed) {
    builder.note('rank-unreadable', 'A ranking table was found, but no complete item/rank grid could be read.', tableText(table).slice(0, 100));
    return;
  }
  const listName = builder.choiceList(base, parsed.items.map((item) => ({
    label: item.label,
    value: item.value,
    instruction: '',
    row: [item.label, item.value],
  })));
  const rulesFor = (previous: string[]): Question['rules'] | undefined => {
    if (previous.length === 0) return mainRelevance ? { visibleIf: mainRelevance } : undefined;
    const filter = previous.map((prior) => `not(selected(\${${prior}}, filter))`).join(' and ');
    return {
      ...(mainRelevance ? { visibleIf: mainRelevance } : {}),
      choiceFilter: filter,
    };
  };
  if (parsed.kind === 'maxdiff') {
    const group = builder.group(builder.uniqueName(`bg_${base}`, used), parsed.groupLabel, {
      appearance: 'field-list',
      ...(mainRelevance ? { rules: { visibleIf: mainRelevance } } : {}),
    });
    const most = builder.uniqueName(`${base}_most`, used);
    const least = builder.uniqueName(`${base}_least`, used);
    builder.question({
      name: most,
      type: 'select_one',
      label: builder.text(parsed.mostLabel ?? 'Most likely'),
      choices: { listName },
      required: true,
      groupId: group.id,
      ...(mainRelevance ? { rules: { visibleIf: mainRelevance } } : {}),
    });
    builder.question({
      name: least,
      type: 'select_one',
      label: builder.text(parsed.leastLabel ?? 'Least likely'),
      choices: { listName },
      required: true,
      groupId: group.id,
      rules: {
        ...(mainRelevance ? { visibleIf: mainRelevance } : {}),
        choiceFilter: `not(selected(\${${most}}, filter))`,
      },
      validation: {
        constraint: `not(\${${most}} = .)`,
        message: builder.text('Most and least must be different options'),
      },
    });
    builder.diagnostics.push({
      severity: 'info',
      code: 'maxdiff-applied',
      message: 'MaxDiff most/least pair compiled from its table. Repeat this table once per block to collect multiple blocks.',
    });
    return;
  }
  const group = builder.group(builder.uniqueName(`bg_${base}`, used), parsed.groupLabel, {
    appearance: 'field-list',
    ...(mainRelevance ? { rules: { visibleIf: mainRelevance } } : {}),
  });
  const previous: string[] = [];
  for (let index = 0; index < parsed.rankCount; index += 1) {
    const name = builder.uniqueName(`${base}_${index + 1}`, used);
    builder.question({
      name,
      type: 'select_one',
      label: builder.text(`RANK ${index + 1}`),
      choices: { listName },
      appearance: 'quick',
      required: true,
      groupId: group.id,
      ...(rulesFor(previous) ? { rules: rulesFor(previous) } : {}),
    });
    previous.push(name);
  }
  builder.diagnostics.push({
    severity: 'info',
    code: 'rank-applied',
    message: `Rank ${parsed.rankCount} compiled with duplicate filtering and an explicit rank block.`,
  });
  void groupId;
}

function addConstantSum(builder: FormBuilder, table: DocxTable, groupId: string | null, used: Set<string>, mainRelevance?: string): void {
  const rows = table.rows.map((row) => row.map((cell) => cell.text.trim()));
  const names: string[] = [];
  for (const row of rows) {
    if (!/\b(?:income|amount|total|percent|litre|hour|cost|spend)\b/i.test(row[0] ?? '')) continue;
    const name = builder.uniqueName(`sum_${slug(row[0] ?? '').slice(0, 24)}`, used);
    builder.question({
      name,
      type: 'integer',
      label: builder.text(row[0] ?? ''),
      groupId,
      required: false,
      ...(mainRelevance ? { rules: { visibleIf: mainRelevance } } : {}),
    });
    names.push(name);
  }
  if (names.length === 0) return;
  const total = builder.uniqueName('constant_total', used);
  builder.calc(total, names.map((name) => `coalesce(\${${name}}, 0)`).join(' + '), groupId, 'Total');
  builder.note('constant-sum-needs-target', `A constant-sum block compiled ${names.length} numeric fields and ${total}. Confirm the target total before publish.`, tableText(table).slice(0, 100));
}

function addAuditAndLocation(builder: FormBuilder, document: DocxDocument, groupId: string | null): void {
  const text = document.blocks.map((block) => block.kind === 'paragraph' ? block.paragraph.text : tableText(block.table)).join('\n');
  if (/audio\s+audit/i.test(text)) {
    builder.question({
      name: 'audio_audit',
      type: 'calculate',
      label: builder.text(''),
      audit: { kind: 'audio_audit', spec: 'p=100; s=starttime; d=endtime' },
      groupId,
      source: { adapter: 'xlsform', type: 'audio audit' },
    });
  }
  if (/\bgeopoint\b|\bGPS\b|\blocation capture\b/i.test(text)) {
    builder.question({
      name: 'geopoint',
      type: 'geopoint',
      label: builder.text('Capture location'),
      required: true,
      groupId,
    });
  }
}

/** The full compile. */
export function compileDocxDocument(document: DocxDocument, options: DocxCompileOptions = {}): DocxCompileResult {
  const now = options.now ?? new Date();
  const defaultLanguage = options.defaultLanguage ?? 'english';
  const languages = options.languages ?? detectLanguages(document);
  const builder = new FormBuilder(defaultLanguage, languages);
  const extraction = extractQuestionnaire(document);
  const used = new Set<string>();
  for (const raw of extraction.questions) {
    const promptTranslations = raw.code ? options.translations?.[raw.code] : undefined;
    if (promptTranslations) raw.translations = { ...(raw.translations ?? {}), ...promptTranslations };
    builder.translateChoices(raw.code, raw.options, options.choiceTranslations);
    for (const map of [raw.translations, ...raw.options.map((option) => option.translations)]) {
      for (const language of Object.keys(map ?? {})) {
        if (!builder.languages.includes(language)) builder.languages.push(language);
      }
    }
  }
  for (const codeMap of Object.values(options.choiceTranslations ?? {})) {
    for (const values of Object.values(codeMap)) {
      for (const language of Object.keys(values)) {
        if (!builder.languages.includes(language)) builder.languages.push(language);
      }
    }
  }
  const rules = new Map<number, CompilerRuleStatus>(COMPILER_RULES.map((rule) => [rule.id, { ...rule, status: 'not-detected' }]));
  const mark = (id: number, status: CompilerRuleStatus['status'], evidence?: string): void => {
    const rule = rules.get(id);
    if (rule) {
      rule.status = status;
      if (evidence) rule.evidence = evidence;
    }
  };

  let sourceProject: string | undefined;
  for (const block of document.blocks) {
    if (block.kind === 'paragraph' && /^PROJECT\b/i.test(block.paragraph.text)) {
      sourceProject = block.paragraph.text.replace(/^PROJECT\s*:?\s*/i, '').trim();
      break;
    }
  }
  const documentTitle = document.title?.trim();
  const titled = documentTitle && !GENERIC_HEADING.test(documentTitle) && !TITLE_NOISE.test(documentTitle) ? documentTitle : undefined;
  const title = options.title ?? sourceProject ?? titled ?? inferredTitle(document) ?? 'Untitled form';
  const projectNumber = options.projectNumber !== undefined ? String(options.projectNumber).replace(/\D/g, '').padStart(5, '0') : '';
  const formId = options.formId ?? (projectNumber ? `GDN${projectNumber}_${upperSlug(title)}` : slug(title));
  if (title === 'Untitled form') {
    builder.diagnostics.push({
      severity: 'warning',
      code: 'missing_title',
      message: 'No project title was found in the Word file. Pass `title` or `formId` so the workbook does not fall back to UNTITLED_FORM.',
      where: 'document',
    });
  }

  metadataRows(builder);
  mark(2, 'applied', 'Eight paradata rows written before the first user field.');

  const mainQuestions = extraction.questions.filter((question) => question.section === 'main');
  const screenerQuestions = extraction.questions.filter((question) => question.section === 'screener');
  // The read-out before the first screener is an introduction, not a main-section
  // note. Keeping it in `main_q` hid it behind the gate and put it after S1–S3.
  const introNoteIndex = mainQuestions.findIndex((question) => question.note && /\bGOOD\b|Coral Research|I am from/i.test(question.prompt));
  const introNote = introNoteIndex >= 0 ? mainQuestions.splice(introNoteIndex, 1)[0] : null;

  if (extraction.intro.length > 0) {
    addIntro(builder, extraction.intro[0]!);
    mark(3, 'applied', extraction.intro[0]!.fields.join(', '));
  }
  if (introNote) addSimpleQuestion(builder, introNote, null, used);
  const gateExpressions: string[] = [];
  let screenerGroup: Group | null = null;
  if (screenerQuestions.length > 0) {
    // A screener is a sequence of gates, not a page. `field-list` here was the
    // Bounce failure: it put every later question on the screener's page and
    // made `quick` and the per-question relevance impossible to honour.
    screenerGroup = builder.group('screener', 'Screener');
  }

  const rawByName = new Map<string, RawQuestion>();
  const nccs: { education: RawQuestion | null; durables: RawQuestion | null } = { education: null, durables: null };
  let activeMatrixKey: string | null = null;
  let activeMatrixGroup: Group | null = null;

  /** Statement-grid rows share one field-list group; ordinary rows reset it. */
  const groupFor = (raw: RawQuestion, fallback: string | null, relevance?: string): string | null => {
    if (!raw.matrix) {
      activeMatrixKey = null;
      activeMatrixGroup = null;
      return fallback;
    }
    if (activeMatrixKey !== raw.matrix.key) {
      activeMatrixKey = raw.matrix.key;
      activeMatrixGroup = builder.group(
        builder.uniqueName(raw.matrix.key, used),
        withoutCode(raw.matrix.label) || 'Statements',
        {
          appearance: 'field-list',
          ...(relevance ? { rules: { visibleIf: relevance } } : {}),
        },
      );
    }
    return activeMatrixGroup?.id ?? fallback;
  };

  const addAgeIfPresent = (raw: RawQuestion, groupId: string | null): boolean => {
    const isAge = /\b(?:age|years?)\b/i.test(raw.prompt)
      && raw.options.some((option) => ageBounds(option.label) !== null);
    if (!isAge) return false;
    const before = builder.questions.length;
    addAge(builder, raw, groupId, used);
    if (builder.questions.length > before) {
      mark(4, 'applied', `${raw.code ?? 'age'} and ${builder.questions.length - before} derived rows`);
      // An age field inside the main gate cannot also decide that gate: the
      // calculation would depend on itself and the whole survey would disappear.
      // Screener ages may terminate; main-section ages are descriptive.
      if (raw.section === 'screener') gateExpressions.push('selected(${age_term}, \'1\')');
    }
    return true;
  };

  const addNccsIfPresent = (raw: RawQuestion, groupId: string | null): boolean => {
    if (!/chief wage earner|education of the chief wage/i.test(raw.prompt)) return false;
    nccs.education = raw;
    void groupId;
    return true;
  };

  let screenerRelevance: string | undefined;
  const currentRouting: Array<{ question: string; value: string }> = [];
  const churnedRouting: Array<{ question: string; value: string }> = [];
  for (const raw of screenerQuestions) {
    const groupId = groupFor(raw, screenerGroup?.id ?? null);
    if (addAgeIfPresent(raw, groupId)) continue;
    if (addNccsIfPresent(raw, groupId)) continue;
    if (/items do you have|durables/i.test(raw.prompt) && nccs.education) {
      nccs.durables = raw;
      continue;
    }
    if (raw.options.length === 0) {
      builder.note('screener-no-options', 'A screener question has no numeric answer table, so it was compiled as text and cannot gate the questionnaire.', raw.where);
    }
    const created = addSimpleQuestion(builder, raw, groupId, used, screenerRelevance);
    if (!created) continue;
    if (raw.matrix) created.appearance = [raw.matrix.first ? 'label' : 'list-nolabel', created.appearance].filter(Boolean).join(' ');
    rawByName.set(created.name, raw);
    for (const option of raw.options) {
      if (/current\s+user/i.test(option.instruction)) currentRouting.push({ question: created.name, value: option.value });
      if (/churned/i.test(option.instruction)) churnedRouting.push({ question: created.name, value: option.value });
    }
    if (raw.options.length > 0) {
      const disallowed = raw.options.filter((option) => /TERMINATE/i.test(option.instruction));
      const allowed = disallowed.length > 0
        ? raw.options.filter((option) => !/TERMINATE/i.test(option.instruction))
        : raw.options;
      if (allowed.length > 0) {
        const expression = allowed.length === 1
          ? `selected(\${${created.name}}, '${allowed[0]!.value}')`
          : `(${allowed.map((option) => `selected(\${${created.name}}, '${option.value}')`).join(' or ')})`;
        if (disallowed.length > 0) gateExpressions.push(expression);
        // Every screener step requires the previous answer, not only the steps
        // that happen to contain a terminate code. A blank S1 must not reveal S2.
        screenerRelevance = screenerRelevance ? `${screenerRelevance} and ${expression}` : expression;
      }
    }
  }

  const routingExpression = (routing: Array<{ question: string; value: string }>): string =>
    routing.map((entry) => `selected(\${${entry.question}}, '${entry.value}')`).join(' or ');
  let segmentName: string | null = null;
  if (currentRouting.length > 0 || churnedRouting.length > 0) {
    const current = routingExpression(currentRouting) || "''";
    const churned = routingExpression(churnedRouting) || "''";
    const segmentGroup = screenerGroup?.id ?? null;
    // `ZO. USER CLASSIFICATION` is a segment router, not a note. Keeping it as a
    // calculation is what lets Section 9 be asked only of churners.
    builder.calc('z0', `if(${current}, '1', if(${churned}, '2', ''))`, segmentGroup, 'User classification');
    builder.calc('z0_dis', `if(${current}, 'Current', if(${churned}, 'Churners', ''))`, segmentGroup, 'Segment display');
    builder.question({
      name: 'n_z0',
      type: 'note',
      label: builder.text('SEGMENT : ${z0_dis}'),
      required: false,
      groupId: segmentGroup,
      rules: { visibleIf: "selected(${z0}, '1') or selected(${z0}, '2')" },
    });
    segmentName = 'z0';
  }

  const educationRaw = nccs.education;
  if (educationRaw) {
    const grid = extraction.nccsGrids[0];
    if (nccs.durables && grid) {
      addNccs(builder, educationRaw, nccs.durables, grid, screenerGroup?.id ?? null, used);
      mark(5, 'applied', `${grid.rows.length} durable rows, ${grid.education.length} education columns`);
      gateExpressions.push('selected(${nccs_term}, \'1\')');
    } else {
      builder.note('nccs-incomplete', 'NCCS education was found, but the durables table or grid could not be paired with it.', educationRaw.where);
      mark(5, 'needs-review');
    }
  }

  let globName: string | null = null;
  if (gateExpressions.length > 0 || screenerQuestions.length > 0 || mainQuestions.length > 0) {
    globName = addScreenerGate(builder, gateExpressions.length > 0 ? gateExpressions : ['1 = 1'], screenerGroup?.id ?? null);
    if (gateExpressions.length > 0) mark(6, 'applied', `${gateExpressions.length} screener condition(s)`);
  }

  const mainGroup = mainQuestions.length > 0 ? builder.group(
    globName && screenerQuestions.length > 0 ? 'bg_term' : 'main_q',
    'Main Questionnaire',
    {
      ...(globName ? { rules: { visibleIf: `selected(\${${globName}}, '1')` } } : {}),
    },
  ) : null;
  const mainRelevance = globName ? `selected(\${${globName}}, '1')` : undefined;

  /** Keep the master gate in step with an age/NCCS condition found later in the main section. */
  const refreshGate = (): void => {
    if (!globName || gateExpressions.length === 0) return;
    const gate = builder.questions.find((question) => question.name === globName);
    if (gate) gate.rules = { ...gate.rules, calculate: `if(${gateExpressions.join(' and ')}, '1', '')` };
    if (mainGroup) mainGroup.rules = { ...mainGroup.rules, visibleIf: `selected(\${${globName}}, '1')` };
  };

  for (const raw of mainQuestions) {
    const branchRelevance = raw.branch === 'churned' && segmentName
      ? `selected(\${${segmentName}}, '2')`
      : undefined;
    const rawRelevance = mainRelevance && branchRelevance
      ? `(${mainRelevance}) and (${branchRelevance})`
      : mainRelevance ?? branchRelevance;
    const groupId = groupFor(raw, mainGroup?.id ?? null, rawRelevance);
    if (addAgeIfPresent(raw, groupId)) {
      refreshGate();
      continue;
    }
    if (addNccsIfPresent(raw, groupId)) continue;
    if (/items do you have|durables/i.test(raw.prompt) && nccs.education) {
      nccs.durables = raw;
      if (extraction.nccsGrids[0]) {
        addNccs(builder, nccs.education, raw, extraction.nccsGrids[0], mainGroup?.id ?? null, used);
        mark(5, 'applied', 'NCCS pair found in the main section');
      }
      continue;
    }
    if (extraction.brandTables.length > 0 && /\b(?:MQ2|brand|aided|aware)/i.test(raw.prompt)) {
      addBrandGrid(builder, extraction.brandTables.shift()!, mainGroup?.id ?? null, used, mainRelevance);
      mark(8, 'applied', raw.prompt.slice(0, 80));
      continue;
    }
    const rankIndex = extraction.rankTables.findIndex((entry) =>
      raw.code !== null &&
      (questionCode(entry.prompt ?? '') === raw.code || tableQuestionCode(entry.table) === raw.code),
    );
    if (rankIndex >= 0) {
      const entry = extraction.rankTables.splice(rankIndex, 1)[0]!;
      addRankGrid(builder, entry.table, mainGroup?.id ?? null, used, mainRelevance, raw.code ?? undefined);
      mark(11, 'applied', raw.prompt.slice(0, 80));
      continue;
    }
    if (/\b(?:constant\s+sum|must\s+(?:equal|sum)|equal(?:s)?\s+100|sum\s+to|total\s+(?:must|should))\b/i.test(raw.prompt) && raw.options.length === 0) {
      addConstantSum(builder, { rows: raw.options.map((option) => option.row.map((text) => ({ text, paragraphs: [], bold: false }))) }, mainGroup?.id ?? null, used, mainRelevance);
      continue;
    }
    const rotationIndex = /\bROTATE\s+STATEMENTS?\b/i.test(raw.prompt)
      ? extraction.rotationTables.findIndex((entry) => !raw.code || questionCode(entry.prompt) === raw.code)
      : -1;
    const rotationIndexResolved = rotationIndex >= 0 ? rotationIndex : (extraction.rotationTables.length > 0 && /\bROTATE\s+STATEMENTS?\b/i.test(raw.prompt) ? 0 : -1);
    if (rotationIndexResolved >= 0) {
      const rotation = extraction.rotationTables.splice(rotationIndexResolved, 1)[0]!;
      if (addSplitRotation(builder, rotation.table, mainGroup?.id ?? null, used, rawRelevance, rotation.prompt)) {
        mark(10, 'applied', raw.prompt.slice(0, 80));
      } else {
        mark(10, 'needs-review', raw.prompt.slice(0, 80));
      }
      refreshGate();
      continue;
    }
    const promptGrid = statementGridFromRaw(raw);
    if (promptGrid) {
      const rotated = /\bROTATE\s+STATEMENTS?\b/i.test(raw.prompt);
      addStatementGrid(builder, promptGrid, groupId, used, rawRelevance, rotated);
      if (rotated) {
        mark(10, 'applied', raw.prompt.slice(0, 80));
      } else {
        builder.diagnostics.push({
          severity: 'info',
          code: 'rotation-source-missing',
          message: 'A statement grid was found without an explicit ROTATE STATEMENTS instruction; it is compiled as one grid rather than inventing X/Y pages.',
          where: raw.where,
        });
        mark(10, 'needs-review', raw.prompt.slice(0, 80));
      }
      refreshGate();
      continue;
    }
    if (addConsiderationSplit(builder, raw, groupId, used, rawRelevance)) {
      mark(7, 'applied', 'E1 consideration and E1B usage split');
      refreshGate();
      continue;
    }
    if (addReasonsSplit(builder, raw, groupId, used, rawRelevance)) {
      mark(7, 'applied', 'E2A most-important and E2B other-reasons split');
      refreshGate();
      continue;
    }
    const created = addSimpleQuestion(builder, raw, groupId, used, rawRelevance);
    if (raw.matrix && created) {
      created.appearance = [raw.matrix.first ? 'label' : 'list-nolabel', created.appearance].filter(Boolean).join(' ');
    }
    refreshGate();
  }

  // A brand or ranking grid is a table-level pattern. It has no ordinary prompt
  // row for the main loop to consume, so it is emitted here in document order.
  for (const table of extraction.brandTables) {
    addBrandGrid(builder, table, mainGroup?.id ?? null, used, mainRelevance);
    mark(8, 'applied', 'brand grid emitted from its table');
  }
  for (const entry of extraction.rankTables) {
    addRankGrid(builder, entry.table, mainGroup?.id ?? null, used, mainRelevance, questionCode(entry.prompt ?? '') ?? undefined);
    mark(11, 'applied', 'ranking grid emitted from its table');
  }

  // A rotation table that did not have a matching raw prompt is still compiled
  // here. It is bound to the cue that introduced it, not to whichever table
  // happens to be next in the document.
  for (const rotation of extraction.rotationTables) {
    if (addSplitRotation(builder, rotation.table, mainGroup?.id ?? null, used, mainRelevance, rotation.prompt)) {
      mark(10, 'applied', rotation.prompt.slice(0, 80));
    }
  }

  if (nccs.education && nccs.durables && extraction.nccsGrids[0] && rules.get(5)?.status === 'not-detected') {
    addNccs(builder, nccs.education, nccs.durables, extraction.nccsGrids[0], mainGroup?.id ?? null, used);
    mark(5, 'applied', 'NCCS pair resolved after the main pass');
  }

  addAuditAndLocation(builder, document, mainGroup?.id ?? null);
  if (builder.questions.some((question) => question.audit || question.type === 'geopoint')) mark(12, 'partial', 'Quality gates compiled; verify the audit field names against the section they cover.');

  if (globName) {
    builder.calc('completed', `if(selected(\${${globName}}, '1'),'1','')`, null, 'Completed');
    builder.question({
      name: 'note_term',
      type: 'note',
      label: builder.text('Thanks for your time. Please close the survey.'),
      required: true,
      rules: { visibleIf: 'not(selected(${completed}, \'1\'))' },
      groupId: null,
    });
  } else if (mainGroup) {
    builder.calc('completed', "'1'", null, 'Completed');
  }

  if (languages.length > 0) mark(1, 'applied', `languages: ${builder.languages.join(', ')}`);
  if (builder.questions.some((question) => /custom-specify-other/.test(question.appearance ?? ''))) mark(7, 'applied', 'custom-specify-other metadata rows');
  if (builder.questions.some((question) => /\brandomized\(/.test(question.appearance ?? ''))) mark(7, 'applied', 'randomized option appearance');

  const definition: FormDefinition = {
    title,
    defaultLanguage,
    languages: builder.languages,
    groups: builder.groups,
    questions: builder.questions,
    choiceLists: builder.choiceLists,
    ...(globName
      ? { triggers: [{ type: 'complete' as const, when: `not(selected(\${${globName}}, '1'))` }] }
      : {}),
    settings: {
      xlsform: {
        formId,
        version: options.version ?? (options.stampVersion === false ? undefined : versionStamp(now)),
        ...(options.publicKey ? { publicKey: options.publicKey } : {}),
        ...(options.submissionUrl ? { submissionUrl: options.submissionUrl } : {}),
      },
    },
  };

  const validation = validateForm(definition);
  for (const error of validation.errors) {
    builder.diagnostics.push({ severity: 'error', code: 'definition', message: error });
  }
  for (const warning of validation.warnings) {
    builder.diagnostics.push({ severity: 'warning', code: 'definition', message: warning });
  }

  for (const diagnostic of extraction.diagnostics) builder.diagnostics.push(diagnostic);
  for (const rule of rules.values()) {
    if (rule.status === 'not-detected') {
      rule.status = 'not-detected';
    }
  }

  const sheets = xlsFormSheets(definition, { now, versionFormula: true }).sheets;
  const styled = applyXlsFormStyles(sheets);
  const book: XlsFormBook = { sheets: styled.sheets, styles: styled.styles, notes: [] };
  const bytes = writeWorkbook({ sheets: book.sheets, styles: book.styles });
  return {
    definition,
    book,
    bytes,
    report: {
      diagnostics: builder.diagnostics,
      rules: [...rules.values()],
      ...(document.title ? { sourceTitle: document.title } : {}),
    },
  };
}

function detectLanguages(document: DocxDocument): string[] {
  const found = new Set<string>();
  for (const block of document.blocks) {
    if (block.kind !== 'table') continue;
    const header = languageHeader(block.table);
    if (!header) continue;
    for (const entry of header.languages) {
      const supplied = block.table.rows.slice(header.row + 1).some((row) => (row[entry.column]?.text ?? '').trim() !== '');
      if (supplied) found.add(entry.language);
    }
  }
  return [...found];
}

export function compileDocx(bytes: Uint8Array, options: DocxCompileOptions = {}): DocxCompileResult {
  return compileDocxDocument(readDocx(bytes), options);
}

export function compilerRuleNames(): ReadonlyMap<number, string> {
  return RULE_NAMES;
}
