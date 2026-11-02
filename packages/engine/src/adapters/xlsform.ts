/**
 * XLSForm ⇄ canonical model.
 *
 * XLSForm is the one genuinely portable authoring format in field data collection
 * (ODK, KoboToolbox, SurveyCTO, Survey123 all read it), so it is our flagship
 * adapter. It is *not* the model: this module translates both ways and reports
 * everything it could not carry, rather than silently discarding it.
 *
 * Round-trip guarantee: `import(export(import(x)))` equals `import(x)` on the
 * canonical model. Anything the model genuinely cannot represent is either
 * preserved in `source` (adapter-specific passthrough) or reported as a note.
 */
import {
  type AuditKind,
  type Choice,
  type FormDefinition,
  type Group,
  type LocalizedText,
  type PreservedSource,
  type Question,
  type QuestionType,
} from '../types.js';
import { readWorkbook, writeWorkbook, type CellValue, type OutSheet, type Sheet, type StyleBook } from './xlsx.js';
import { applyXlsFormStyles } from './xlsform-book.js';

export interface AdapterNote {
  kind: 'dropped' | 'normalised' | 'unsupported' | 'lossy' | 'preserved';
  message: string;
  where?: string;
}

export interface XlsFormImport {
  definition: FormDefinition;
  notes: AdapterNote[];
  /** Sheet names actually read, for display/diagnostics. */
  sheets: string[];
}

export interface XlsFormExport {
  bytes: Uint8Array;
  notes: AdapterNote[];
}

/** The styled book before it becomes a file: what the studio viewer renders. */
export interface XlsFormBook {
  sheets: OutSheet[];
  styles: StyleBook;
  notes: AdapterNote[];
}

interface XlsFormSettings {
  formId?: string;
  version?: string;
  instanceName?: string;
  publicKey?: string;
  submissionUrl?: string;
  extra?: Record<string, string>;
}

/**
 * The version cell is a formula on purpose: a scripter who edits a workbook and
 * presses Save gets a new YYMMDDHHmm revision without remembering to bump it, and
 * the server's monotonic guard then has something honest to compare. The cached
 * value written beside it is what a reader that does not evaluate formulas (ours,
 * and every importer) sees.
 */
export const XLSFORM_VERSION_FORMULA =
  'RIGHT(YEAR(NOW()),2)&TEXT(MONTH(NOW()),"00")&TEXT(DAY(NOW()),"00")&TEXT(HOUR(NOW()),"00")&TEXT(MINUTE(NOW()),"00")';

/** Local time, because that is what Excel's NOW() returns in the file's timezone. */
export function versionStamp(now: Date): string {
  const two = (n: number): string => String(n).padStart(2, '0');
  return (
    two(now.getFullYear() % 100) +
    two(now.getMonth() + 1) +
    two(now.getDate()) +
    two(now.getHours()) +
    two(now.getMinutes())
  );
}

/* ------------------------------------------------------------ type mapping */

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Types that exist identically on both sides. */
const DIRECT: Record<string, QuestionType> = {
  text: 'text', string: 'text', string2: 'text', textarea: 'textarea', multiline: 'textarea',
  integer: 'integer', int: 'integer', long: 'integer',
  decimal: 'decimal', float: 'decimal', number: 'decimal',
  date: 'date', time: 'time', datetime: 'datetime', dateTime: 'datetime', date_time: 'datetime',
  image: 'image', photo: 'image', audio: 'audio', video: 'video', file: 'file',
  barcode: 'barcode',
  geopoint: 'geopoint', geotrace: 'geotrace', geoshape: 'geoshape',
  note: 'note', calculate: 'calculate',
};

/** ODK/Enketo metadata types: no user input, often device-supplied. */
const METADATA: Record<string, string | null> = {
  start: 'now()', end: 'now()', today: 'today()',
  deviceid: null, username: null, phonenumber: null, simserial: null, subscriberid: null,
  caseid: null,
  audit: null, 'background-audio': null, 'background-geopoint': null, 'start-geopoint': null,
};

/**
 * The invisible audit types, keyed by the phrase a workbook writes.
 *
 * Matched against the *whole* type cell before the head is split on whitespace,
 * because `text audit` would otherwise read as the ordinary `text` type and the
 * field would arrive on the device as a visible question.
 */
const AUDIT_PHRASES: Record<string, AuditKind> = {
  'text audit': 'text_audit',
  'audio audit': 'audio_audit',
  'speed violations': 'speed_violations',
  'speed violations count': 'speed_violations_count',
  'speed violations list': 'speed_violations_list',
  'sensor_stream': 'sensor_stream',
  'sensor_stream conversation': 'sensor_stream',
  'sensor_statistic': 'sensor_statistic',
};

/** The reverse map, so an audit field built in code still writes its own phrase. */
const AUDIT_TYPE_PHRASE: Record<AuditKind, string> = {
  text_audit: 'text audit',
  audio_audit: 'audio audit',
  speed_violations: 'speed violations',
  speed_violations_count: 'speed violations count',
  speed_violations_list: 'speed violations list',
  sensor_stream: 'sensor_stream',
  sensor_statistic: 'sensor_statistic',
};

const ALIAS_NOTES: Record<string, string> = {
  string: 'type "string" is an alias for "text"',
  string2: 'type "string2" is an alias for "text"',
  int: 'type "int" is an alias for "integer"',
  long: 'type "long" normalised to "integer"',
  float: 'type "float" normalised to "decimal"',
  number: 'type "number" normalised to "decimal"',
  dateTime: 'type "dateTime" normalised to "datetime" (XLSForm casing differs between platforms)',
  date_time: 'type "date_time" normalised to "datetime"',
  multiline: 'type "multiline" normalised to "textarea"',
  photo: 'type "photo" normalised to "image"',
};

const YESNO_LIST = 'yesno';

/* --------------------------------------------------------------- utilities */

function slug(input: string): string {
  const s = input.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return s.length > 0 ? s : 'form';
}

function sanitizeName(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(?=\d)/, '_');
}

/** `label::English (en)` → `en`; `label::English` → `English`; bare `label` → fallback. */
function langCode(suffix: string | undefined, fallback: string): string {
  if (!suffix || suffix.trim() === '') return fallback;
  const paren = /\(([^)]+)\)\s*$/.exec(suffix);
  if (paren?.[1]) return paren[1].trim();
  return suffix.trim();
}

interface ColumnSpec {
  /** Header text as written, e.g. `label::English (en)`. */
  raw: string;
  /** Lower-cased base name before `::`. */
  base: string;
  /** Language code when the header carries a `::` suffix. */
  lang?: string;
}

function parseHeader(row: string[]): ColumnSpec[] {
  return row.map((cell) => {
    const raw = cell.trim();
    const at = raw.indexOf('::');
    if (at === -1) return { raw, base: raw.toLowerCase() };
    const base = raw.slice(0, at).trim().toLowerCase();
    const suffix = raw.slice(at + 2);
    return { raw, base, lang: langCode(suffix, suffix.trim()) };
  });
}

function cellAt(row: string[], index: number | undefined): string {
  if (index === undefined || index < 0) return '';
  return (row[index] ?? '').trim();
}

function truthy(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  return v === 'yes' || v === 'true' || v === '1' || v === 'y';
}

function parseDefaultValue(raw: string): unknown {
  const v = raw.trim();
  if (v === '') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.startsWith('{') || v.startsWith('[')) {
    try {
      return JSON.parse(v) as unknown;
    } catch {
      return v;
    }
  }
  return v;
}

function stringifyDefaultValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function localized(
  row: string[],
  columns: Array<{ spec: ColumnSpec; index: number }>,
  base: string,
  defaultLanguage: string,
): LocalizedText | undefined {
  const out: LocalizedText = {};
  let seen = false;
  for (const { spec, index } of columns) {
    if (spec.base !== base) continue;
    const value = (row[index] ?? '').trim();
    if (value === '') continue;
    out[spec.lang ?? defaultLanguage] = value;
    seen = true;
  }
  return seen ? out : undefined;
}

/* --------------------------------------------------------------------- read */

function findSheet(wb: Sheet[], name: string): Sheet | undefined {
  const lower = name.toLowerCase();
  return wb.find((s) => s.name.trim().toLowerCase() === lower);
}

function parseTypeCell(raw: string): {
  kind: 'group' | 'repeat' | 'end_group' | 'end_repeat' | 'question';
  type?: string;
  listName?: string;
  fromFile?: boolean;
  aliasNote?: string;
  audit?: AuditKind;
} {
  const trimmed = raw.trim();
  const phrase = trimmed.toLowerCase().replace(/\s+/g, ' ');
  const audit = AUDIT_PHRASES[phrase];
  if (audit) return { kind: 'question', type: 'calculate', audit };

  const space = trimmed.search(/\s/);
  const head = space === -1 ? trimmed : trimmed.slice(0, space);
  const rest = space === -1 ? '' : trimmed.slice(space + 1).trim();

  if (head === 'begin_group') return { kind: 'group' };
  if (head === 'end_group') return { kind: 'end_group' };
  if (head === 'begin_repeat') return { kind: 'repeat' };
  if (head === 'end_repeat') return { kind: 'end_repeat' };

  if (head === 'select_one_from_file' || head === 'select_multiple_from_file') {
    const file = rest.split(/[/\\]/).pop() ?? rest;
    return {
      kind: 'question',
      type: head === 'select_one_from_file' ? 'select_one' : 'select_multiple',
      listName: file.replace(/\.(csv|xlsx?|xml)$/i, ''),
      fromFile: true,
    };
  }
  if (head === 'select_one' || head === 'select_multiple' || head === 'rank') {
    return { kind: 'question', type: head, listName: rest };
  }
  if (head in METADATA) return { kind: 'question', type: 'calculate' };
  const direct = DIRECT[head];
  if (direct) return { kind: 'question', type: direct, aliasNote: ALIAS_NOTES[head] };
  return { kind: 'question', type: 'text' };
}

export function importXlsForm(bytes: Uint8Array): XlsFormImport {
  const notes: AdapterNote[] = [];
  const wb = readWorkbook(bytes);
  const sheetNames = wb.sheets.map((s) => s.name);

  const surveySheet = findSheet(wb.sheets, 'survey');
  if (!surveySheet) {
    throw new Error(
      `xlsform: no "survey" sheet found (workbook has: ${sheetNames.join(', ') || 'none'}). ` +
        'An XLSForm needs a `survey` sheet; `choices` and `settings` are optional.',
    );
  }
  const choicesSheet = findSheet(wb.sheets, 'choices');
  const settingsSheet = findSheet(wb.sheets, 'settings');
  if (!choicesSheet) {
    notes.push({ kind: 'normalised', message: 'no `choices` sheet : options must be inline or added later' });
  }

/**
 * Read a settings sheet in either of the two layouts in the wild.
 *
 * SurveyCTO writes a header row (`form_title`, `form_id`, ...) with the values on
 * row 2. ODK's older templates and every workbook written before this build use a
 * two-column key/value list. Accepting both costs four lines and means an existing
 * form's file does not become unreadable because the writer changed.
 */
function readSettings(sheet: Sheet | undefined): Record<string, string> {
  const raw: Record<string, string> = {};
  const rows = sheet?.rows ?? [];
  if (rows.length === 0) return raw;
  const head = (rows[0] ?? []).map((cell) => cell.trim().toLowerCase());
  // Two recognised keys side by side means a header row. One means a key/value
  // list whose first row happens to start with `form_title` and whose second cell
  // is the title. Counting avoids mistaking that first value for a column name.
  const known = ['form_title', 'form_id', 'version', 'default_language', 'instance_name', 'public_key', 'submission_url'];
  const headerRow = head.filter((cell) => known.includes(cell));
  if (headerRow.length >= 2) {
    const values = rows[1] ?? [];
    head.forEach((key, i) => {
      if (key !== '') raw[key] = (values[i] ?? '').trim();
    });
    return raw;
  }
  rows.forEach((row, i) => {
    const key = (row[0] ?? '').trim().toLowerCase();
    if (key === '' || (i === 0 && (key === 'key' || key === 'setting'))) return;
    raw[key] = (row[1] ?? '').trim();
  });
  return raw;
}

  const settingsRaw: Record<string, string> = readSettings(settingsSheet);
  if (!settingsSheet) {
    notes.push({ kind: 'normalised', message: 'no `settings` sheet : title and form id cannot be recovered from the file' });
  }

  const surveyRows = surveySheet.rows;
  const header = parseHeader(surveyRows[0] ?? []);
  const index: Record<string, number | undefined> = {};
  const labelColumns: Array<{ spec: ColumnSpec; index: number }> = [];
  header.forEach((col, i) => {
    if (['label', 'hint', 'required_message', 'constraint_message', 'guidance_hint'].includes(col.base)) {
      labelColumns.push({ spec: col, index: i });
    }
    if (index[col.base] === undefined) index[col.base] = i;
  });

  const known = new Set([
    'type', 'name', 'label', 'hint', 'required', 'required_message', 'relevant', 'constraint',
    'constraint_message', 'calculation', 'choice_filter', 'appearance', 'default', 'read_only',
    'read only', 'readonly', 'repeat_count', 'guidance_hint',
  ]);
  // XLSForm's own header is `read only` with a space; `read_only` is the alias
  // most writers use. Both mean the same thing, so both are read.
  if (index['read_only'] === undefined && index['read only'] !== undefined) {
    index['read_only'] = index['read only'];
  }
  const unknownColumns = header
    .map((col, i) => ({ col, i }))
    .filter(({ col }) => !known.has(col.base));

  interface Row {
    typeCell: string;
    row: string[];
    rowNumber: number;
    name: string;
  }
  const rows: Row[] = [];
  for (let r = 1; r < surveyRows.length; r++) {
    const row = surveyRows[r] ?? [];
    const typeCell = cellAt(row, index['type']);
    const name = cellAt(row, index['name']);
    if (typeCell === '' && name === '') continue;
    if (typeCell === '') {
      notes.push({ kind: 'dropped', message: `row ${r + 1} has a name but no type, so it was skipped`, where: name });
      continue;
    }
    rows.push({ typeCell, row, rowNumber: r + 1, name });
  }

  // Language codes actually present, in encounter order.
  const declaredLanguages: string[] = [];
  for (const row of rows) {
    for (const { spec, index: i } of labelColumns) {
      if ((row.row[i] ?? '').trim() === '') continue;
      const code = spec.lang ?? settingsRaw['default_language'] ?? 'en';
      if (!declaredLanguages.includes(code)) declaredLanguages.push(code);
    }
  }
  const defaultLanguage = settingsRaw['default_language'] ?? declaredLanguages[0] ?? 'en';
  const languages = declaredLanguages.filter((l) => l !== defaultLanguage);
  languages.unshift(defaultLanguage);

  /* -- choices -- */
  const choiceLists: Record<string, Choice[]> = {};
  if (choicesSheet) {
    const choiceHeader = parseHeader(choicesSheet.rows[0] ?? []);
    const listIdx = choiceHeader.findIndex((c) => c.base === 'list_name');
    const nameIdx = choiceHeader.findIndex((c) => c.base === 'name');
    const labelCols = choiceHeader.map((c, i) => ({ spec: c, index: i })).filter(({ spec }) => spec.base === 'label');
    const extraCols = choiceHeader
      .map((c, i) => ({ spec: c, index: i }))
      .filter(({ spec }) => !['list_name', 'name', 'label'].includes(spec.base));

    if (listIdx < 0 || nameIdx < 0) {
      notes.push({ kind: 'unsupported', message: '`choices` sheet needs `list_name` and `name` columns, so the sheet was ignored' });
    } else {
      for (let r = 1; r < choicesSheet.rows.length; r++) {
        const row = choicesSheet.rows[r] ?? [];
        const listName = cellAt(row, listIdx);
        const value = cellAt(row, nameIdx);
        if (listName === '' || value === '') continue;
        const label: LocalizedText = {};
        for (const { spec, index: i } of labelCols) {
          const v = (row[i] ?? '').trim();
          if (v !== '') label[spec.lang ?? defaultLanguage] = v;
        }
        const extra: Record<string, string> = {};
        for (const { spec, index: i } of extraCols) {
          const v = (row[i] ?? '').trim();
          if (v !== '') extra[spec.base] = v;
        }
        const bucket = choiceLists[listName] ?? (choiceLists[listName] = []);
        bucket.push(Object.keys(extra).length > 0 ? { value, label, extra } : { value, label });
      }
    }
  }

  /* -- survey -- */
  const groups: Group[] = [];
  const questions: Question[] = [];
  const stack: Group[] = [];
  let generated = 0;
  let yesnoNeeded = false;

  for (const row of rows) {
    const parsed = parseTypeCell(row.typeCell);
    const where = row.name || `row ${row.rowNumber}`;

    if (parsed.kind === 'end_group' || parsed.kind === 'end_repeat') {
      const wantsRepeat = parsed.kind === 'end_repeat';
      const top = stack.pop();
      if (!top) {
        notes.push({ kind: 'dropped', message: `row ${row.rowNumber}: ${row.typeCell} with no matching begin, so it was ignored` });
      } else if (Boolean(top.repeat) !== wantsRepeat) {
        notes.push({
          kind: 'normalised',
          message: `row ${row.rowNumber}: ${row.typeCell} closes "${top.name}", opened as ${top.repeat ? 'begin_repeat' : 'begin_group'}`,
          where: top.name,
        });
      }
      continue;
    }

    const sourceColumns: Record<string, string> = {};
    for (const { col, i } of unknownColumns) {
      const v = (row.row[i] ?? '').trim();
      if (v !== '') sourceColumns[col.raw] = v;
    }

    const label = localized(row.row, labelColumns, 'label', defaultLanguage) ?? {};
    const hint = localized(row.row, labelColumns, 'hint', defaultLanguage);
    const requiredMessage = localized(row.row, labelColumns, 'required_message', defaultLanguage);
    const constraintMessage = localized(row.row, labelColumns, 'constraint_message', defaultLanguage);
    const guidance = localized(row.row, labelColumns, 'guidance_hint', defaultLanguage);

    const source: PreservedSource = { adapter: 'xlsform', type: row.typeCell.trim() };
    if (Object.keys(sourceColumns).length > 0) source.columns = sourceColumns;
    if (guidance) {
      notes.push({ kind: 'lossy', message: 'guidance_hint has no canonical field: it is preserved in the source passthrough so it survives export', where });
      const cols = source.columns ?? {};
      for (const [lang, text] of Object.entries(guidance)) cols[`guidance_hint::${lang}`] = text;
      source.columns = cols;
    }

    if (parsed.kind === 'group' || parsed.kind === 'repeat') {
      let name = row.name;
      if (name === '') {
        generated += 1;
        name = `group_${generated}`;
        notes.push({ kind: 'normalised', message: `row ${row.rowNumber}: group without a name: named "${name}"` });
      }
      if (!NAME_RE.test(name)) {
        const fixed = sanitizeName(name);
        notes.push({ kind: 'normalised', message: `group name "${name}" is not a valid identifier: renamed "${fixed}"`, where: name });
        name = fixed;
      }
      const group: Group = {
        id: `g_${name}`,
        name,
        label,
        repeat: parsed.kind === 'repeat',
        repeatCount: cellAt(row.row, index['repeat_count']) || null,
        source,
      };
      const appearance = cellAt(row.row, index['appearance']);
      if (appearance !== '') group.appearance = appearance;
      const relevant = cellAt(row.row, index['relevant']);
      if (relevant !== '') group.rules = { visibleIf: relevant };
      groups.push(group);
      stack.push(group);
      continue;
    }

    let name = row.name;
    if (name === '') {
      generated += 1;
      name = `question_${generated}`;
      notes.push({ kind: 'normalised', message: `row ${row.rowNumber}: question without a name: named "${name}"`, where: `row ${row.rowNumber}` });
    }
    if (!NAME_RE.test(name)) {
      const fixed = sanitizeName(name);
      notes.push({ kind: 'normalised', message: `question name "${name}" is not a valid identifier: renamed "${fixed}"`, where: name });
      name = fixed;
    }

    if (parsed.aliasNote) notes.push({ kind: 'normalised', message: parsed.aliasNote, where });

    const head = row.typeCell.trim().split(/\s+/)[0] ?? '';
    const recognised =
      Boolean(parsed.audit) || head in DIRECT || head in METADATA || head === 'select_one' ||
      head === 'select_multiple' || head === 'rank' ||
      head === 'select_one_from_file' || head === 'select_multiple_from_file';

    let type = (parsed.type ?? 'text') as QuestionType;
    let listName = parsed.listName;
    let calculate: string | null = null;

    if (parsed.audit) {
      notes.push({
        kind: 'preserved',
        message: `type "${row.typeCell.trim()}" is an invisible audit field: it is collected here and exported verbatim, and the runner evaluates it`,
        where,
      });
    } else if (head in METADATA) {
      const mapped = METADATA[head] ?? null;
      calculate = mapped;
      notes.push({
        kind: 'preserved',
        message:
          `type "${head}" is an ODK metadata field. Preserved verbatim for round-trip; ` +
          (mapped ? `collected as calculate(${mapped}).` : 'our runtime does not compute it unless the device supplies a value, so it will be blank.'),
        where,
      });
    } else if (!recognised) {
      notes.push({ kind: 'unsupported', message: `unknown question type "${head}": treated as "text" (original type preserved on export)`, where });
    }
    if (sourceColumns['parameters']) {
      notes.push({
        kind: 'lossy',
        message: `XLSForm "parameters" (${sourceColumns['parameters']}) is preserved verbatim but not interpreted by our runtime`,
        where,
      });
    }
    if (parsed.fromFile) {
      notes.push({
        kind: 'lossy',
        message: `external choice list "${listName}" (…_from_file) is not embedded in the workbook, so upload it as a dataset to keep the options`,
        where,
      });
    }

    if (type === 'select_one' && listName === YESNO_LIST) {
      type = 'yesno';
      yesnoNeeded = true;
      notes.push({ kind: 'normalised', message: `select_one "${YESNO_LIST}" mapped to the canonical yesno type`, where });
    }
    if ((type === 'select_one' || type === 'select_multiple' || type === 'rank') && !listName) {
      notes.push({ kind: 'unsupported', message: `${type} without a list name: a choices list is required`, where });
      type = 'text';
      listName = undefined;
    }

    const calculationCell = cellAt(row.row, index['calculation']);
    if (calculationCell !== '') {
      if (calculate && calculate !== calculationCell) {
        notes.push({ kind: 'normalised', message: `metadata calculation replaced by the workbook's own calculation "${calculationCell}"`, where });
      }
      calculate = calculationCell;
      if (/\bpulldata\s*\(/.test(calculationCell)) {
        notes.push({
          kind: 'lossy',
          message: 'pulldata() reads an attached dataset, not the workbook. Attach the dataset to the form version; the runtime evaluates the calculation.',
          where,
        });
      }
    }

    const requiredCell = cellAt(row.row, index['required']);
    let required: boolean | string = false;
    if (requiredCell !== '') {
      if (truthy(requiredCell)) required = true;
      else if (['no', 'false', '0'].includes(requiredCell.toLowerCase())) required = false;
      else {
        required = requiredCell;
        notes.push({ kind: 'normalised', message: `conditional relevance-in-required "${requiredCell}" kept as an expression`, where });
      }
    }

    const constraint = cellAt(row.row, index['constraint']);
    const choiceFilter = cellAt(row.row, index['choice_filter']);
    const relevant = cellAt(row.row, index['relevant']);
    const appearance = cellAt(row.row, index['appearance']);
    const readOnly = truthy(cellAt(row.row, index['read_only']));
    const defaultRaw = cellAt(row.row, index['default']);

    const question: Question = {
      id: `q_${name}`,
      groupId: stack.length > 0 ? stack[stack.length - 1]!.id : null,
      name,
      type,
      label,
      required,
      source,
    };
    if (hint) question.hint = hint;
    if (requiredMessage) question.requiredMessage = requiredMessage;
    if (listName) question.choices = { listName };
    if (constraint !== '' || constraintMessage) {
      question.validation = { constraint: constraint === '' ? null : constraint, message: constraintMessage };
    }
    const rules: NonNullable<Question['rules']> = {};
    if (relevant !== '') rules.visibleIf = relevant;
    if (readOnly) rules.enableIf = 'false';
    if (calculate) rules.calculate = calculate;
    if (choiceFilter !== '') rules.choiceFilter = choiceFilter;
    if (Object.keys(rules).length > 0) question.rules = rules;
    if (appearance !== '') question.appearance = appearance;
    if (defaultRaw !== '') question.defaultValue = parseDefaultValue(defaultRaw);
    if (parsed.audit) question.audit = { kind: parsed.audit, spec: appearance };

    questions.push(question);
  }

  for (const g of stack) {
    notes.push({ kind: 'normalised', message: `group "${g.name}" was never closed: it was closed at the end of the sheet`, where: g.name });
  }

  if (yesnoNeeded && !choiceLists[YESNO_LIST]) {
    choiceLists[YESNO_LIST] = [
      { value: 'yes', label: { [defaultLanguage]: 'Yes' } },
      { value: 'no', label: { [defaultLanguage]: 'No' } },
    ];
  }

  const settings: XlsFormSettings = {};
  if (settingsRaw['form_id']) settings.formId = settingsRaw['form_id'];
  if (settingsRaw['version']) settings.version = settingsRaw['version'];
  if (settingsRaw['instance_name']) settings.instanceName = settingsRaw['instance_name'];
  if (settingsRaw['public_key']) settings.publicKey = settingsRaw['public_key'];
  if (settingsRaw['submission_url']) settings.submissionUrl = settingsRaw['submission_url'];
  const extra: Record<string, string> = {};
  for (const [key, value] of Object.entries(settingsRaw)) {
    if (!['form_title', 'form_id', 'version', 'default_language', 'instance_name', 'public_key', 'submission_url'].includes(key)) {
      extra[key] = value;
    }
  }
  if (Object.keys(extra).length > 0) settings.extra = extra;

  if (!settingsRaw['form_title']) {
    notes.push({ kind: 'normalised', message: 'settings.form_title is missing, so this form needs a title before it can be published' });
  }
  const title = settingsRaw['form_title'] ?? settingsRaw['form_id'] ?? 'Untitled form';
  if (Object.keys(extra).length > 0) {
    notes.push({ kind: 'preserved', message: `unrecognised settings keys preserved: ${Object.keys(extra).join(', ')}` });
  }

  const definition: FormDefinition = {
    title,
    defaultLanguage,
    languages,
    groups,
    questions,
    choiceLists,
    settings: { xlsform: settings },
  };

  return { definition, notes, sheets: sheetNames };
}

/* -------------------------------------------------------------------- write */

interface OutColumn {
  base: string;
  lang?: string;
}

function columnLabel(col: OutColumn): string {
  return col.lang ? `${col.base}::${col.lang}` : col.base;
}

export interface XlsFormSheets {
  sheets: OutSheet[];
  notes: AdapterNote[];
}

export interface XlsFormBookOptions {
  /**
   * The instant the version formula's cached value is rendered for. Tests pass a
   * fixed date; a download leaves it out and gets the minute it was written.
   */
  now?: Date;
  /** Write the live version formula into `settings` C2 (default: true). */
  versionFormula?: boolean;
}

/**
 * The offline documentation tabs.
 *
 * These are not decoration. A scripter working in Excel away from any network is
 * the person who needs the column rules most, and a workbook that carries its own
 * reference is a workbook that can be handed to a new team member. The text is a
 * constant rather than generated from the model because it documents the format,
 * not this particular form.
 */
const SURVEY_HELP: Record<string, [what: string, rule: string, example: string]> = {
  type: ['What this row is.', 'begin_group, end_group, begin_repeat, end_repeat, or a question type. select_one and select_multiple name a list from the choices sheet.', 'select_one cities'],
  name: ['The variable name.', 'Letters, digits and underscore, starting with a letter or underscore. Unique in the form. This is the name `${...}` refers to.', 'household_size'],
  label: ['The question text.', 'Plain text. `label::<language>` holds another language.', 'How many people live here?'],
  hint: ['Guidance under the question.', 'Optional. `hint::<language>` for another language.', 'Include everyone who slept here last night.'],
  default: ['A starting answer.', 'A literal or an expression. A default is a suggestion, not a validation.', '0'],
  appearance: ['How the control renders.', 'A space separated list, for example `minimal`, `field-list`, `quick`, `horizontal`.', 'minimal'],
  constraint: ['A validity rule.', 'An XPath expression; `.` is the answer being checked. A failing answer blocks submission and is reported against this question.', '. > 0 and . < 60'],
  constraint_message: ['What to say when the constraint fails.', 'Plain language that names the question and the fix. `constraint_message::<language>` for another language.', 'Enter a number between 1 and 59.'],
  relevant: ['When the question is asked.', 'An XPath expression. When it is false the question is hidden and its answer is stored as null, not as the last value typed.', '${has_children} = 1'],
  disabled: ['Marks a field as not collected.', 'Preserved through import and export. It is not interpreted as visibility here; use `relevant` for that.', 'yes'],
  required: ['Whether an answer is needed.', '`yes`, `no`, or an expression for a conditional requirement.', 'yes'],
  required_message: ['What to say when a required answer is missing.', 'Name the question and the next action. Localise with required_message::<language>.', 'Enter the household size before continuing.'],
  'read only': ['Shows the answer without allowing an edit.', '`yes` or `no`. A calculated field is read only by nature; this is for a value the enumerator must see.', 'yes'],
  calculation: ['A value computed from other answers.', 'XPath. Re-evaluated whenever a dependency changes, on the device and again on the server.', '${price} * ${quantity}'],
  repeat_count: ['How many times a repeat repeats.', 'A number or an expression. Only meaningful on begin_repeat.', '${household_size}'],
  'media:image': ['An image shown with the question.', 'A filename inside the form media zip. Preserved through import and export.', 'consent.png'],
  'media:audio': ['Audio played with the question.', 'A filename inside the form media zip.', 'prompt.mp3'],
  'media:video': ['Video shown with the question.', 'A filename inside the form media zip.', 'howto.mp4'],
  choice_filter: ['Narrows the options of a select.', 'An XPath expression evaluated per choice; a bare name reads that column on the choices sheet.', 'district = ${state}'],
  note: ['A note for the person reading the spreadsheet.', 'Never sent to a device and never interpreted.', 'Client approved 2026-10-01.'],
};

const CHOICES_HELP: Record<string, [what: string, rule: string, example: string]> = {
  list_name: ['The list this option belongs to.', 'Referenced by select_one and select_multiple in the survey sheet.', 'cities'],
  name: ['The value that is stored.', 'Not the label: this is what lands in the dataset and what a constraint compares against. Unique within the list.', 'blr'],
  label: ['What the respondent sees.', '`label::<language>` for another language.', 'Bengaluru'],
  filter_column: ['A column used by choice_filter.', 'Any extra column on this sheet is readable by name inside a choice_filter expression.', 'state'],
};

const SETTINGS_HELP: Record<string, [what: string, rule: string, example: string]> = {
  form_title: ['The name a respondent sees.', 'Required before publish. Plain text.', 'Household Health Survey 2026'],
  form_id: ['The instrument identity.', 'Unique inside the organisation. Uploading a new form with an existing form_id is refused; upload a new version of that form instead.', 'household_health_2026'],
  version: ['The revision.', 'The cell contains a live formula that writes YYMMDDHHmm when the workbook is saved. An upload must be greater than the deployed version.', '=RIGHT(YEAR(NOW()),2)&TEXT(MONTH(NOW()),"00")'],
  public_key: ['An RSA public key.', 'When present, submissions are encrypted on the device and can only be decrypted with the matching private key at export.', '(optional)'],
  submission_url: ['Where this workbook was collected from.', 'Informational; the platform uses its own distribution links.', '(optional)'],
  default_language: ['The language of the plain `label` column.', 'Other languages use `label::<code>`.', 'en'],
};

function helpSheet(
  sheet: 'survey' | 'choices' | 'settings',
  what: string,
  columns: string[],
  docs: Record<string, [what: string, rule: string, example: string]>,
  highlights: string,
): OutSheet {
  const rows: string[][] = [
    [`Inicio XLSForm reference · ${sheet}`, '', '', ''],
    ['Format', 'XLSForm (ODK, SurveyCTO and Kobo all read this workbook)', '', ''],
    ['What it is', what, '', ''],
    [],
    ['Column', 'What it does', 'Rule', 'Example'],
  ];
  for (const column of columns) {
    const doc = docs[column] ?? docs[column.split('::')[0] ?? ''] ?? [
      'A preserved column.',
      'Not interpreted by this platform. Its values are carried through import and export unchanged.',
      '',
    ];
    rows.push([column, doc[0], doc[1], doc[2]]);
  }
  rows.push([]);
  rows.push(['Highlighted cells', highlights, '', '']);
  return { name: `help-${sheet}`, rows };
}

/**
 * The three sheets the export writes, before they are zipped.
 *
 * `exportXlsForm` is a zip around this function, and that is the whole point: the
 * console's XLSForm viewer reads the rows from here, so what somebody is looking at
 * and what `Download .xlsx` hands them are the same rows by construction rather than
 * by agreement. It is also why the browser does not import `writeWorkbook` to draw a
 * table — a viewer should not drag a zip implementation onto a screen that never
 * writes a byte.
 */
export function xlsFormSheets(def: FormDefinition, options: XlsFormBookOptions = {}): XlsFormSheets {
  const notes: AdapterNote[] = [];
  const defaultLanguage = def.defaultLanguage || 'en';
  const languages: string[] = [];
  const addLang = (l: string): void => {
    if (l && !languages.includes(l)) languages.push(l);
  };
  addLang(defaultLanguage);
  for (const l of def.languages ?? []) addLang(l);
  for (const q of def.questions) {
    for (const map of [q.label, q.hint, q.requiredMessage, q.validation?.message]) {
      for (const l of Object.keys(map ?? {})) addLang(l);
    }
  }
  for (const g of def.groups) for (const l of Object.keys(g.label ?? {})) addLang(l);
  for (const list of Object.values(def.choiceLists)) {
    for (const c of list) for (const l of Object.keys(c.label ?? {})) addLang(l);
  }
  const others = languages.filter((l) => l !== defaultLanguage);

  const labelFamily: OutColumn[] = [{ base: 'label' }, { base: 'hint' }];
  for (const l of others) labelFamily.push({ base: 'label', lang: l }, { base: 'hint', lang: l });
  labelFamily.push({ base: 'required_message' });
  for (const l of others) labelFamily.push({ base: 'required_message', lang: l });
  labelFamily.push({ base: 'constraint_message' });
  for (const l of others) labelFamily.push({ base: 'constraint_message', lang: l });

  // Preserved passthrough columns are re-emitted, so import → export → import does
  // not quietly lose author data the canonical model has no field for.
  const passthrough: string[] = [];
  const collect = (source: PreservedSource | null | undefined): void => {
    for (const key of Object.keys(source?.columns ?? {})) {
      if (!passthrough.includes(key)) passthrough.push(key);
    }
  };
  for (const q of def.questions) collect(q.source);
  for (const g of def.groups) collect(g.source);

  // The twenty columns a SurveyCTO style workbook always has, in the order a
  // scripter reads them. A few are inert here (`disabled`, `media:*`, `note`) and
  // exist so a workbook this platform writes opens in that ecosystem with the
  // shape its authors expect; values for them survive through `source.columns`.
  const standardBase = new Set([
    'type', 'name', 'label', 'hint', 'default', 'appearance', 'constraint', 'constraint_message',
    'relevant', 'disabled', 'required', 'required_message', 'read only', 'calculation',
    'repeat_count', 'media:image', 'media:audio', 'media:video', 'choice_filter', 'note',
  ]);
  const columns: OutColumn[] = [
    { base: 'type' },
    { base: 'name' },
    ...labelFamily,
    { base: 'default' },
    { base: 'appearance' },
    { base: 'constraint' },
    { base: 'relevant' },
    { base: 'disabled' },
    { base: 'required' },
    { base: 'read only' },
    { base: 'calculation' },
    { base: 'repeat_count' },
    { base: 'media:image' },
    { base: 'media:audio' },
    { base: 'media:video' },
    { base: 'choice_filter' },
    { base: 'note' },
    ...passthrough.filter((base) => !standardBase.has(base)).map((base) => ({ base })),
  ];

  const surveyRows: string[][] = [columns.map(columnLabel)];
  const pushRow = (values: Record<string, string>): void => {
    surveyRows.push(columns.map((col) => values[columnLabel(col)] ?? ''));
  };
  const setLocalized = (values: Record<string, string>, base: string, map: LocalizedText | undefined): void => {
    for (const [lang, text] of Object.entries(map ?? {})) {
      if (text === '') continue;
      values[lang === defaultLanguage ? base : `${base}::${lang}`] = text;
    }
  };

  const inlineLists: Record<string, Choice[]> = {};
  const listForQuestion = (q: Question): string | null => {
    if (q.choices?.listName) return q.choices.listName;
    if (q.choices?.inline && q.choices.inline.length > 0) {
      const name = `${q.name}_choices`;
      inlineLists[name] = q.choices.inline;
      notes.push({ kind: 'normalised', message: `inline choices for "${q.name}" written to the choices sheet as list "${name}"`, where: q.name });
      return name;
    }
    return null;
  };

  const byGroup = new Map<string, Question[]>();
  for (const q of def.questions) {
    const key = q.groupId ?? '';
    const bucket = byGroup.get(key) ?? [];
    bucket.push(q);
    byGroup.set(key, bucket);
  }

  const emitQuestion = (q: Question): void => {
    const values: Record<string, string> = {};
    const preserved = q.source?.adapter === 'xlsform' ? q.source.type : undefined;
    const auditPhrase = q.audit ? AUDIT_TYPE_PHRASE[q.audit.kind] : undefined;
    if (preserved) {
      values['type'] = preserved;
    } else if (auditPhrase) {
      values['type'] = auditPhrase;
    } else if (q.type === 'yesno') {
      values['type'] = `select_one ${listForQuestion(q) ?? YESNO_LIST}`;
    } else if (q.type === 'select_one' || q.type === 'select_multiple' || q.type === 'rank') {
      const listName = listForQuestion(q);
      if (!listName) {
        notes.push({ kind: 'dropped', message: `"${q.name}" is a ${q.type} with no choices, so it was exported as text`, where: q.name });
        values['type'] = 'text';
      } else {
        values['type'] = `${q.type} ${listName}`;
      }
    } else {
      values['type'] = q.type;
    }

    values['name'] = q.name;
    setLocalized(values, 'label', q.label);
    setLocalized(values, 'hint', q.hint);
    setLocalized(values, 'required_message', q.requiredMessage);
    setLocalized(values, 'constraint_message', q.validation?.message);
    if (q.required === true) values['required'] = 'yes';
    else if (typeof q.required === 'string') values['required'] = q.required;
    if (q.rules?.visibleIf) values['relevant'] = q.rules.visibleIf;
    if (q.validation?.constraint) values['constraint'] = q.validation.constraint;
    if (q.rules?.calculate) values['calculation'] = q.rules.calculate;
    if (q.rules?.choiceFilter) values['choice_filter'] = q.rules.choiceFilter;
    // The audit parameters live in `appearance`, which is where every XLSForm
    // tool that understands these types reads them.
    const appearance = q.audit?.spec ? q.audit.spec : q.appearance;
    if (appearance) values['appearance'] = appearance;
    if (q.defaultValue !== undefined && q.defaultValue !== null) values['default'] = stringifyDefaultValue(q.defaultValue);
    if (q.rules?.enableIf === 'false') values['read only'] = 'yes';
    for (const [key, value] of Object.entries(q.source?.columns ?? {})) values[key] = value;
    pushRow(values);
  };

  for (const group of def.groups) {
    const gvalues: Record<string, string> = { type: group.repeat ? 'begin_repeat' : 'begin_group', name: group.name };
    setLocalized(gvalues, 'label', group.label);
    if (group.appearance) gvalues['appearance'] = group.appearance;
    if (group.repeat && group.repeatCount) gvalues['repeat_count'] = group.repeatCount;
    for (const [key, value] of Object.entries(group.source?.columns ?? {})) gvalues[key] = value;
    pushRow(gvalues);
    for (const q of byGroup.get(group.id) ?? []) emitQuestion(q);
    pushRow({ type: group.repeat ? 'end_repeat' : 'end_group' });
  }
  for (const q of byGroup.get('') ?? []) emitQuestion(q);
  for (const key of byGroup.keys()) {
    if (key !== '' && !def.groups.some((g) => g.id === key)) {
      notes.push({ kind: 'dropped', message: `questions referencing unknown group "${key}" were written as top-level questions` });
      for (const q of byGroup.get(key) ?? []) emitQuestion(q);
    }
  }

  /* -- choices sheet -- */
  const allLists: Record<string, Choice[]> = { ...def.choiceLists, ...inlineLists };
  const extraKeys: string[] = [];
  for (const list of Object.values(allLists)) {
    for (const c of list) for (const key of Object.keys(c.extra ?? {})) if (!extraKeys.includes(key)) extraKeys.push(key);
  }

  const choiceColumns: OutColumn[] = [{ base: 'list_name' }, { base: 'name' }, { base: 'label' }];
  for (const l of others) choiceColumns.push({ base: 'label', lang: l });
  for (const key of extraKeys) choiceColumns.push({ base: key });

  const choiceRows: string[][] = [choiceColumns.map(columnLabel)];
  for (const listName of Object.keys(allLists).sort()) {
    for (const choice of allLists[listName] ?? []) {
      if (choice.value === '') {
        notes.push({ kind: 'dropped', message: `choice with an empty value in list "${listName}" was skipped (XLSForm has no representation for it)` });
        continue;
      }
      const values: Record<string, string> = { list_name: listName, name: choice.value };
      for (const [lang, text] of Object.entries(choice.label ?? {})) {
        values[lang === defaultLanguage ? 'label' : `label::${lang}`] = text;
      }
      for (const [key, value] of Object.entries(choice.extra ?? {})) values[key] = value;
      choiceRows.push(choiceColumns.map((col) => values[columnLabel(col)] ?? ''));
    }
  }

  /* -- settings sheet -- */
  // One header row and one value row, which is the shape SurveyCTO writes and the
  // shape a person reading the sheet expects. The alternative (a key/value list)
  // makes the file easy to parse and hard to scan, and this is the one sheet a
  // scripter edits by hand.
  const xf = (def.settings?.['xlsform'] ?? {}) as XlsFormSettings;
  const settingsColumns = ['form_title', 'form_id', 'version', 'public_key', 'submission_url', 'default_language'];
  const settingsValues: CellValue[] = [
    def.title,
    xf.formId ?? slug(def.title),
    // The cached value is what every non-Excel reader sees. It is the existing
    // version when the form has one; when it does not, it is empty, so importing
    // a workbook the platform just exported does not invent a version. Excel
    // evaluates the formula when the file is opened or saved, which is exactly
    // when a new stamp should appear.
    options.versionFormula === false
      ? (xf.version ?? '')
      : { formula: XLSFORM_VERSION_FORMULA, cached: xf.version ?? '' },
    xf.publicKey ?? xf.extra?.['public_key'] ?? '',
    xf.submissionUrl ?? xf.extra?.['submission_url'] ?? '',
    defaultLanguage,
  ];
  if (xf.instanceName) {
    settingsColumns.push('instance_name');
    settingsValues.push(xf.instanceName);
  }
  for (const [key, value] of Object.entries(xf.extra ?? {})) {
    if (['public_key', 'submission_url', 'instance_name'].includes(key)) continue;
    settingsColumns.push(key);
    settingsValues.push(value);
  }
  const settingsRows: CellValue[][] = [settingsColumns, settingsValues];

  if (passthrough.length > 0) {
    notes.push({
      kind: 'preserved',
      message: `re-emitted ${passthrough.length} column(s) preserved from the original workbook: ${passthrough.join(', ')}`,
    });
  }

  return {
    sheets: [
      { name: 'survey', rows: surveyRows },
      { name: 'choices', rows: choiceRows },
      { name: 'settings', rows: settingsRows },
      helpSheet(
        'survey',
        'One row per question, group, repeat or note. Rows are read top to bottom; a group or repeat is a begin/end pair and everything between them belongs to it.',
        columns.map(columnLabel),
        SURVEY_HELP,
        'name, constraint_message, relevant and choice_filter. They are the columns an upload is judged by, so they are filled in yellow.',
      ),
      helpSheet(
        'choices',
        'One row per option. A list is the set of rows sharing a list_name, and the order of the rows is the order the respondent sees unless the question rotates them.',
        choiceColumns.map(columnLabel),
        CHOICES_HELP,
        'list_name and name. Together they are the identity of an option, and a duplicate is a refused upload.',
      ),
      helpSheet(
        'settings',
        'One header row, one value row. These cells describe the instrument as a whole rather than any question in it.',
        settingsColumns,
        SETTINGS_HELP,
        'form_id and version. The upload guard reads them: a duplicate form_id is refused, and a version that is not newer than the deployed one is refused.',
      ),
    ],
    notes,
  };
}

/**
 * The workbook with its visual grammar applied: the same data, plus the fills,
 * widths and frozen panes the studio viewer and the downloaded file share.
 */
export function xlsFormWorkbook(def: FormDefinition, options: XlsFormBookOptions = {}): XlsFormBook {
  const { sheets, notes } = xlsFormSheets(def, options);
  const styled = applyXlsFormStyles(sheets);
  return { sheets: styled.sheets, styles: styled.styles, notes };
}

/** The workbook as a file: the same sheets, zipped. */
export function exportXlsForm(def: FormDefinition, options: XlsFormBookOptions = {}): XlsFormExport {
  const book = xlsFormWorkbook(def, options);
  return { bytes: writeWorkbook({ sheets: book.sheets, styles: book.styles }), notes: book.notes };
}
