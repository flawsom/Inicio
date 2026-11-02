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

const SECTION_TEXT = /^(?:introduction|main questionnaire|questionnaire|screener|sub\s*section\b|section\b|module\b|part\b|customer profiling|concept evaluation|purchase behaviour\b|spontaneous ad recalls?|aware (?:non[- ]?)?trier diagnostics|in store experience evaluation|deep dive\b)/i;

/** A section banner is never a respondent field, even when it sits in a table. */
function isSectionText(input: string): boolean {
  const text = cleanPrompt(input);
  if (text === '' || text.length > 140 || text.includes('?') || /_{3,}/.test(text)) return false;
  if (SECTION_TEXT.test(text)) return true;
  // Word questionnaires often format a banner as a one-cell table in capitals.
  return text === text.toUpperCase() && /[A-Z]{3}/.test(text) && !/\b(?:SA|MA|TERMINATE|CONTINUE)\b/.test(text);
}

function isHeading(paragraph: DocxParagraph): boolean {
  const text = cleanPrompt(paragraph.text);
  if (text === '' || text.length > 120) return false;
  return Boolean(paragraph.style && /heading|title/i.test(paragraph.style))
    || /^section\b|^sub\s*section\b|^main questionnaire$|^questionnaire$|^screener$/i.test(text);
}

function looksLikeQuestion(text: string): boolean {
  const value = cleanPrompt(text);
  if (value === '') return false;
  if (value.length > 500 && !value.includes('?')) return false;
  return /^[A-Z]{1,6}\d+[a-z]?(?:[._]\d+[a-z]?)?[.)\s:]/i.test(value)
    || /\?\s*(?:SA|MA|$)/i.test(value)
    || /_{3,}/.test(value)
    || /\b(?:SA|MA)\b/.test(value);
}

function questionCode(text: string): string | null {
  const cleaned = cleanPrompt(text)
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/^PROGRAMMER\s+INSTRUCTION\s*:\s*/i, '');
  const match = /^([A-Z]{1,6}\d+[a-z]?(?:[._]\d+[a-z]?)?)[.)\s:]/i.exec(cleaned);
  return match?.[1] ? normaliseCode(match[1]) : null;
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
  return cleanPrompt(text).replace(/^[A-Z]{1,6}\d+[a-z]?(?:[._]\d+[a-z]?)?[.)\s:]+\s*/i, '');
}

export interface RawOption {
  label: string;
  value: string;
  instruction: string;
  row: string[];
}

export interface RawQuestion {
  code: string | null;
  prompt: string;
  options: RawOption[];
  section: 'screener' | 'main';
  where: string;
  /** A statement-grid row carries the group it belongs to and whether it is the first. */
  matrix?: { key: string; label: string; first: boolean };
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

function parseOptions(table: DocxTable, startRow = 0): RawOption[] {
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
    prompt: cleaned,
    options,
    section,
    where,
  };
}

function paragraphOption(text: string, index: number): RawOption | null {
  let label = cleanPrompt(text);
  if (label === '' || label.length > 240) return null;
  if (/^(?:why we ask|note|instruction|interviewer|programmer|please|show|read|good|introduction|section|module|those|this|ask|questionnaire|main)\b/i.test(label)) {
    return null;
  }
  let instruction = '';
  const trailing = /\s+(CONTINUE(?:\s+AS\s+[A-Z ]+)?|TERMINATE.*)$/i.exec(label);
  if (trailing?.[0]) {
    instruction = trailing[1]!.trim();
    label = label.slice(0, trailing.index).trim();
  }
  label = label.replace(/\s+if never.*$/i, '').trim();
  if (label === '' || /\?$/.test(label)) return null;
  return { label, value: String(index + 1), instruction, row: [text] };
}

/** Exposed so a caller can show the extracted questionnaire before compiling it. */
export function extractQuestionnaire(document: DocxDocument): {
  questions: RawQuestion[];
  intro: IntroTable[];
  nccsGrids: NccsGrid[];
  brandTables: DocxTable[];
  rankTables: DocxTable[];
  diagnostics: CompilerDiagnostic[];
} {
  const questions: RawQuestion[] = [];
  const intro: IntroTable[] = [];
  const nccsGrids: NccsGrid[] = [];
  const brandTables: DocxTable[] = [];
  const rankTables: DocxTable[] = [];
  const diagnostics: CompilerDiagnostic[] = [];
  const gridTables: DocxTable[] = [];
  let pending: string | null = null;
  let pendingSection: 'screener' | 'main' = 'main';
  let proseOptions: string[] = [];
  let section: 'screener' | 'main' = 'main';
  let blockIndex = 0;

  const flushProse = (): void => {
    if (!pending) return;
    if (isSectionText(pending)) {
      pending = null;
      proseOptions = [];
      return;
    }
    const options = proseOptions
      .map((text, index) => paragraphOption(text, index))
      .filter((option): option is RawOption => option !== null);
    questions.push({
      code: questionCode(pending),
      prompt: pending,
      options,
      section: pendingSection,
      where: `paragraph before ${blockIndex}`,
    });
    pending = null;
    proseOptions = [];
  };

  for (const block of document.blocks) {
    blockIndex += 1;
    if (block.kind === 'paragraph') {
      const text = cleanPrompt(block.paragraph.text);
      if (text === '') continue;
      if (isHeading(block.paragraph) || (!pending && isSectionText(text))) {
        flushProse();
        if (/screener|section\s*1/i.test(text)) section = 'screener';
        else if (/main questionnaire|section\s*2|questionnaire|module\s+[a-z0-9]/i.test(text)) section = 'main';
        continue;
      }
      if (/\b(?:SQ|S)\d/i.test(text) && !/main questionnaire/i.test(text)) section = 'screener';
      if (looksLikeQuestion(text)) {
        flushProse();
        pending = questionStart(text);
        pendingSection = section;
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
      // it is a section heading, not a separate field.
      pending = null;
      proseOptions = [];
      brandTables.push(table);
      continue;
    }
    if (parseRankGrid(table)) {
      pending = null;
      proseOptions = [];
      rankTables.push(table);
      continue;
    }
    const matrix = parseMatrixTable(table);
    if (matrix) {
      matrix.rows.forEach((entry, index) => {
        questions.push({
          code: questionCode(entry.label),
          prompt: entry.label,
          options: matrix.options,
          section,
          where: `${where} matrix`,
          matrix: { key: `matrix_${blockIndex}`, label: matrix.prompt, first: index === 0 },
        });
      });
      pending = null;
      proseOptions = [];
      continue;
    }
    const question = tableQuestion(table, pending, section, where);
    if (question) {
      questions.push(question);
      pending = null;
      proseOptions = [];
      continue;
    }
    if (pending) {
      diagnostics.push({
        severity: 'warning',
        code: 'unreadable-table',
        message: 'A question paragraph was followed by a table with no numeric answer codes, so the table was not turned into choices.',
        where: pending.slice(0, 80),
      });
    }
    pending = null;
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

  return { questions, intro, nccsGrids, brandTables, rankTables, diagnostics };
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
        label: this.text(option.label),
        extra: attrs,
      } satisfies Choice;
    });
    this.choiceLists[name] = list;
    return name;
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
  const below = /(\d{1,3})\s*(?:years?\s*)?(?:and\s*)?(?:below|or\s*less|less)/.exec(text);
  if (below) return { min: 0, max: Number(below[1]) };
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
    label: builder.text(withoutCode(raw.prompt)),
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
  return options.find((option) => /^(?:none|none of these|no one|don't know|not interested)$/i.test(option.label.trim()));
}

function addExclusive(builder: FormBuilder, question: Question, options: RawOption[]): void {
  if (question.type !== 'select_one' && question.type !== 'select_multiple') return;
  const exclusive = exclusiveOption(options);
  if (!exclusive) return;
  const code = exclusive.value.replace(/'/g, "''");
  question.validation = {
    constraint: `if (selected(.,${code}), count-selected(.) = 1, count-selected(.) >= 1)`,
    message: builder.text(`${exclusive.label} Can't be selected with other options`),
  };
}

function addOtherSpecify(builder: FormBuilder, question: Question, options: RawOption[], groupId: string | null): void {
  const other = options.find((option) => /other|specify/i.test(option.label) && !/none/i.test(option.label));
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

function addSimpleQuestion(builder: FormBuilder, raw: RawQuestion, groupId: string | null, used: Set<string>, mainRelevance?: string): void {
  const base = raw.code ?? slug(withoutCode(raw.prompt)).slice(0, 60);
  const name = builder.uniqueName(base, used);
  const options = raw.options;
  const prompt = withoutCode(raw.prompt);
  // A statement-grid row is one select per statement, even if the statement text
  // happens to contain a word the single-question heuristics look for.
  const isMulti = !raw.matrix && /\bMA\b|SELECT\s+(?:ALL|MULTIPLE)|MULTIPLE\s+RESPONSES/i.test(raw.prompt);
  const isRank = !raw.matrix && /\bRANK\b|ORDER\s+OF\s+PRIORITY/i.test(raw.prompt);
  let type: QuestionType = options.length > 0 ? (isRank ? 'rank' : isMulti ? 'select_multiple' : 'select_one') : 'text';
  if (options.length === 0 && /\b(?:age|years?)\b/i.test(prompt)) type = 'integer';
  if (type === 'text' && !looksLikeQuestion(raw.prompt) && prompt.length < 8) return;

  const relevance = mainRelevance;
  const q: Question = {
    id: `q_${name}`,
    order: builder.takeOrder(),
    name,
    type,
    label: builder.text(prompt),
    required: true,
    groupId,
    ...(relevance ? { rules: { visibleIf: relevance } } : {}),
  };
  if (options.length > 0) {
    const listName = builder.choiceList(name, options);
    q.choices = { listName };
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

function addSplitRotation(builder: FormBuilder, table: DocxTable, groupId: string | null, used: Set<string>, mainRelevance?: string): void {
  const rows = table.rows.map((row) => row.map((cell) => cell.text.trim()));
  const statements = rows.slice(1).map((row) => row[0] ?? '').filter((text) => text.length > 3);
  if (statements.length < 2) {
    builder.note('rotation-unreadable', 'A statement rotation table was found, but fewer than two statements could be read.', tableText(table).slice(0, 80));
    return;
  }
  const seed = builder.uniqueName('ad_num1', used);
  builder.calc(seed, 'once(random())', groupId, 'Rotation Draw');
  builder.calc('rot', `string(int(\${${seed}}*2)+1)`, groupId, 'Rotation');
  builder.diagnostics.push({
    severity: 'info',
    code: 'rotation-partial',
    message: 'X/Y statement rotation compiled as a rotation draw and a visible order flag. Per-statement reverse groups require a reviewed statement grid.',
  });
  void mainRelevance;
}

function addRankGrid(builder: FormBuilder, table: DocxTable, groupId: string | null, used: Set<string>, mainRelevance?: string): void {
  const rows = table.rows.map((row) => row.map((cell) => cell.text.trim()));
  const header = rows[0] ?? [];
  const rankColumns = header
    .map((cell, index) => ({ cell, index }))
    .filter(({ cell }) => /rank\s*[1-9]/i.test(cell) || /most|least/i.test(cell));
  const items = rows.slice(1).map((row) => row[0] ?? '').filter((text) => text.length > 2);
  if (rankColumns.length === 0 || items.length === 0) {
    builder.note('rank-unreadable', 'A ranking table was found, but its rank columns or items could not be read.', tableText(table).slice(0, 80));
    return;
  }
  const previous: string[] = [];
  rankColumns.forEach((column, index) => {
    const name = builder.uniqueName(`rank_${index + 1}`, used);
    const list = items.map((item, itemIndex) => ({
      value: String(itemIndex + 1),
      label: builder.text(item),
      extra: { filter: String(itemIndex + 1) },
    }));
    builder.choiceLists[name] = list;
    const constraints = previous.length > 0
      ? `if(${previous.map((prior) => `\${${prior}} != ''`).join(' and ')}, ${previous.map((prior) => `\${${name}} != \${${prior}}`).join(' and ')}, 1 = 1)`
      : undefined;
    builder.question({
      name,
      type: 'select_one',
      label: builder.text(column.cell || `Rank ${index + 1}`),
      choices: { listName: name },
      ...(constraints ? { validation: { constraint: constraints, message: builder.text('Duplicate Ranking not Possible') } } : {}),
      ...(mainRelevance ? { rules: { visibleIf: mainRelevance } } : {}),
      required: true,
      groupId,
    });
    previous.push(name);
  });
  builder.diagnostics.push({
    severity: 'info',
    code: 'rank-partial',
    message: 'Ranking columns were compiled as one select per rank with duplicate protection. A MaxDiff choice set needs a reviewed block design.',
  });
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

  if (extraction.intro.length > 0) {
    addIntro(builder, extraction.intro[0]!);
    mark(3, 'applied', extraction.intro[0]!.fields.join(', '));
  }

  const mainQuestions = extraction.questions.filter((question) => question.section === 'main');
  const screenerQuestions = extraction.questions.filter((question) => question.section === 'screener');
  const gateExpressions: string[] = [];
  let screenerGroup: Group | null = null;
  if (screenerQuestions.length > 0) {
    screenerGroup = builder.group('screener', 'Screener', { appearance: 'field-list' });
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
      && raw.options.some((option) => ageBounds(option.label) !== null)
      && /VERBATIM|RECORD\s+IN\s+NUMBERS|POST\s+CODE/i.test(raw.prompt);
    if (!isAge) return false;
    const before = builder.questions.length;
    addAge(builder, raw, groupId, used);
    if (builder.questions.length > before) {
      mark(4, 'applied', `${raw.code ?? 'age'} and ${builder.questions.length - before} derived rows`);
      gateExpressions.push('selected(${age_term}, \'1\')');
    }
    return true;
  };

  const addNccsIfPresent = (raw: RawQuestion, groupId: string | null): boolean => {
    if (!/chief wage earner|education of the chief wage/i.test(raw.prompt)) return false;
    nccs.education = raw;
    void groupId;
    return true;
  };

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
    const before = builder.questions.length;
    addSimpleQuestion(builder, raw, groupId, used);
    const created = builder.questions[before];
    if (!created) continue;
    if (raw.matrix) created.appearance = [raw.matrix.first ? 'label' : 'list-nolabel', created.appearance].filter(Boolean).join(' ');
    rawByName.set(created.name, raw);
    if (raw.options.length > 0) {
      const disallowed = raw.options.filter((option) => /TERMINATE/i.test(option.instruction));
      const allowed = raw.options.filter((option) => !/TERMINATE/i.test(option.instruction));
      if (disallowed.length > 0 && allowed.length > 0) {
        const expression = allowed.length === 1
          ? `selected(\${${created.name}}, '${allowed[0]!.value}')`
          : `(${allowed.map((option) => `selected(\${${created.name}}, '${option.value}')`).join(' or ')})`;
        gateExpressions.push(expression);
      }
    }
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
  if (gateExpressions.length > 0) {
    globName = addScreenerGate(builder, gateExpressions, screenerGroup?.id ?? null);
    mark(6, 'applied', `${gateExpressions.length} screener condition(s)`);
  }

  const mainGroup = mainQuestions.length > 0 ? builder.group('main_q', 'Main Questionnaire', {
    ...(globName ? { rules: { visibleIf: `selected(\${${globName}}, '1')` } } : {}),
  }) : null;
  const mainRelevance = globName ? `selected(\${${globName}}, '1')` : undefined;

  for (const raw of mainQuestions) {
    const groupId = groupFor(raw, mainGroup?.id ?? null, mainRelevance);
    if (addAgeIfPresent(raw, groupId)) continue;
    if (addNccsIfPresent(raw, groupId)) continue;
    if (/items do you have|durables/i.test(raw.prompt) && nccs.education) {
      nccs.durables = raw;
      if (extraction.nccsGrids[0]) {
        addNccs(builder, nccs.education, raw, extraction.nccsGrids[0], mainGroup?.id ?? null, used);
        mark(5, 'applied', 'NCCS pair found in the main section');
      }
      continue;
    }
    if (extraction.brandTables.length > 0 && raw.options.length > 3 && /\b(?:MQ2|brand|aided|aware)/i.test(raw.prompt)) {
      addBrandGrid(builder, extraction.brandTables.shift()!, mainGroup?.id ?? null, used, mainRelevance);
      mark(8, 'applied', raw.prompt.slice(0, 80));
      continue;
    }
    if (extraction.rankTables.length > 0 && /\b(?:RANK|most|least|MaxDiff)/i.test(raw.prompt)) {
      addRankGrid(builder, extraction.rankTables.shift()!, mainGroup?.id ?? null, used, mainRelevance);
      mark(11, 'applied', raw.prompt.slice(0, 80));
      continue;
    }
    if (/\b(?:sum|total|equal|100%|percentage)\b/i.test(raw.prompt) && raw.options.length === 0) {
      addConstantSum(builder, { rows: raw.options.map((option) => option.row.map((text) => ({ text, paragraphs: [], bold: false }))) }, mainGroup?.id ?? null, used, mainRelevance);
      continue;
    }
    const before = builder.questions.length;
    addSimpleQuestion(builder, raw, groupId, used, mainRelevance);
    const created = builder.questions[before];
    if (raw.matrix && created) {
      created.appearance = [raw.matrix.first ? 'label' : 'list-nolabel', created.appearance].filter(Boolean).join(' ');
    }
  }

  // A brand or ranking grid is a table-level pattern. It has no ordinary prompt
  // row for the main loop to consume, so it is emitted here in document order.
  for (const table of extraction.brandTables) {
    addBrandGrid(builder, table, mainGroup?.id ?? null, used, mainRelevance);
    mark(8, 'applied', 'brand grid emitted from its table');
  }
  for (const table of extraction.rankTables) {
    addRankGrid(builder, table, mainGroup?.id ?? null, used, mainRelevance);
    mark(11, 'applied', 'ranking grid emitted from its table');
  }

  // X/Y rotation is introduced by a paragraph and carried by the table that
  // follows it. The table itself usually has only statements, so searching the
  // table for the word ROTATE would miss every real questionnaire.
  let rotationTable: DocxTable | null = null;
  for (let i = 0; i < document.blocks.length; i += 1) {
    const block = document.blocks[i];
    if (block?.kind !== 'paragraph' || !/\bROTATE\b/i.test(block.paragraph.text)) continue;
    for (let j = i + 1; j < document.blocks.length; j += 1) {
      const next = document.blocks[j];
      if (next?.kind === 'table') {
        rotationTable = next.table;
        break;
      }
    }
    if (rotationTable) break;
  }
  if (rotationTable) {
    addSplitRotation(builder, rotationTable, mainGroup?.id ?? null, used, mainRelevance);
    mark(10, 'partial', 'Rotation draw compiled; statement page order needs review.');
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
  const text = document.blocks.map((block) => block.kind === 'paragraph' ? block.paragraph.text : tableText(block.table)).join('\n');
  const known = ['Marathi', 'Tamil', 'Telugu', 'Kannada', 'Hindi', 'Bengali', 'Odia'];
  return known.filter((language) => new RegExp(`\\b${escapeRegex(language)}\\b`, 'i').test(text));
}

export function compileDocx(bytes: Uint8Array, options: DocxCompileOptions = {}): DocxCompileResult {
  return compileDocxDocument(readDocx(bytes), options);
}

export function compilerRuleNames(): ReadonlyMap<number, string> {
  return RULE_NAMES;
}
