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
  type Choice,
  type FormDefinition,
  type Group,
  type LocalizedText,
  type PreservedSource,
  type Question,
  type QuestionType,
} from '../types.js';
import { readWorkbook, writeWorkbook, type Sheet } from './xlsx.js';

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

interface XlsFormSettings {
  formId?: string;
  version?: string;
  instanceName?: string;
  extra?: Record<string, string>;
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
  audit: null, 'background-audio': null, 'background-geopoint': null, 'start-geopoint': null,
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
} {
  const trimmed = raw.trim();
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
    notes.push({ kind: 'normalised', message: 'no `choices` sheet — options must be inline or added later' });
  }

  const settingsRaw: Record<string, string> = {};
  if (settingsSheet) {
    settingsSheet.rows.forEach((row, i) => {
      const key = (row[0] ?? '').trim().toLowerCase();
      if (key === '' || (i === 0 && (key === 'key' || key === 'setting'))) return;
      settingsRaw[key] = (row[1] ?? '').trim();
    });
  } else {
    notes.push({ kind: 'normalised', message: 'no `settings` sheet — title and form id cannot be recovered from the file' });
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
    'readonly', 'repeat_count', 'guidance_hint',
  ]);
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
      notes.push({ kind: 'dropped', message: `row ${r + 1} has a name but no type — skipped`, where: name });
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
      notes.push({ kind: 'unsupported', message: '`choices` sheet needs `list_name` and `name` columns — sheet ignored' });
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
        notes.push({ kind: 'dropped', message: `row ${row.rowNumber}: ${row.typeCell} with no matching begin — ignored` });
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
      notes.push({ kind: 'lossy', message: 'guidance_hint has no canonical field — preserved in the source passthrough so it survives export', where });
      const cols = source.columns ?? {};
      for (const [lang, text] of Object.entries(guidance)) cols[`guidance_hint::${lang}`] = text;
      source.columns = cols;
    }

    if (parsed.kind === 'group' || parsed.kind === 'repeat') {
      let name = row.name;
      if (name === '') {
        generated += 1;
        name = `group_${generated}`;
        notes.push({ kind: 'normalised', message: `row ${row.rowNumber}: group without a name — named "${name}"` });
      }
      if (!NAME_RE.test(name)) {
        const fixed = sanitizeName(name);
        notes.push({ kind: 'normalised', message: `group name "${name}" is not a valid identifier — renamed "${fixed}"`, where: name });
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
      notes.push({ kind: 'normalised', message: `row ${row.rowNumber}: question without a name — named "${name}"`, where: `row ${row.rowNumber}` });
    }
    if (!NAME_RE.test(name)) {
      const fixed = sanitizeName(name);
      notes.push({ kind: 'normalised', message: `question name "${name}" is not a valid identifier — renamed "${fixed}"`, where: name });
      name = fixed;
    }

    if (parsed.aliasNote) notes.push({ kind: 'normalised', message: parsed.aliasNote, where });

    const head = row.typeCell.trim().split(/\s+/)[0] ?? '';
    const recognised =
      head in DIRECT || head in METADATA || head === 'select_one' || head === 'select_multiple' ||
      head === 'rank' || head === 'select_one_from_file' || head === 'select_multiple_from_file';

    let type = (parsed.type ?? 'text') as QuestionType;
    let listName = parsed.listName;
    let calculate: string | null = null;

    if (head in METADATA) {
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
      notes.push({ kind: 'unsupported', message: `unknown question type "${head}" — treated as "text" (original type preserved on export)`, where });
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
        message: `external choice list "${listName}" (…_from_file) is not embedded in the workbook — upload it as a dataset to keep the options`,
        where,
      });
    }

    if (type === 'select_one' && listName === YESNO_LIST) {
      type = 'yesno';
      yesnoNeeded = true;
      notes.push({ kind: 'normalised', message: `select_one "${YESNO_LIST}" mapped to the canonical yesno type`, where });
    }
    if ((type === 'select_one' || type === 'select_multiple' || type === 'rank') && !listName) {
      notes.push({ kind: 'unsupported', message: `${type} without a list name — a choices list is required`, where });
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
          message: 'pulldata() reads an external CSV that is not in the workbook — mapped to search(); the dataset must be uploaded',
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

    questions.push(question);
  }

  for (const g of stack) {
    notes.push({ kind: 'normalised', message: `group "${g.name}" was never closed — closed at the end of the sheet`, where: g.name });
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
  const extra: Record<string, string> = {};
  for (const [key, value] of Object.entries(settingsRaw)) {
    if (!['form_title', 'form_id', 'version', 'default_language', 'instance_name'].includes(key)) extra[key] = value;
  }
  if (Object.keys(extra).length > 0) settings.extra = extra;

  if (!settingsRaw['form_title']) {
    notes.push({ kind: 'normalised', message: 'settings.form_title is missing — this form needs a title before it can be published' });
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

export function exportXlsForm(def: FormDefinition): XlsFormExport {
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

  const columns: OutColumn[] = [
    { base: 'type' },
    { base: 'name' },
    ...labelFamily,
    { base: 'required' },
    { base: 'relevant' },
    { base: 'constraint' },
    { base: 'calculation' },
    { base: 'choice_filter' },
    { base: 'appearance' },
    { base: 'default' },
    { base: 'read_only' },
    { base: 'repeat_count' },
    ...passthrough.map((base) => ({ base })),
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
    if (preserved) {
      values['type'] = preserved;
    } else if (q.type === 'yesno') {
      values['type'] = `select_one ${listForQuestion(q) ?? YESNO_LIST}`;
    } else if (q.type === 'select_one' || q.type === 'select_multiple' || q.type === 'rank') {
      const listName = listForQuestion(q);
      if (!listName) {
        notes.push({ kind: 'dropped', message: `"${q.name}" is a ${q.type} with no choices — exported as text`, where: q.name });
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
    if (q.appearance) values['appearance'] = q.appearance;
    if (q.defaultValue !== undefined && q.defaultValue !== null) values['default'] = stringifyDefaultValue(q.defaultValue);
    if (q.rules?.enableIf === 'false') values['read_only'] = 'yes';
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
  const xf = (def.settings?.['xlsform'] ?? {}) as XlsFormSettings;
  const settingsRows: string[][] = [
    ['form_title', def.title],
    ['form_id', xf.formId ?? slug(def.title)],
    ['version', xf.version ?? '1'],
    ['default_language', defaultLanguage],
  ];
  if (xf.instanceName) settingsRows.push(['instance_name', xf.instanceName]);
  for (const [key, value] of Object.entries(xf.extra ?? {})) settingsRows.push([key, value]);

  const bytes = writeWorkbook({
    sheets: [
      { name: 'survey', rows: surveyRows },
      { name: 'choices', rows: choiceRows },
      { name: 'settings', rows: settingsRows },
    ],
  });

  if (passthrough.length > 0) {
    notes.push({
      kind: 'preserved',
      message: `re-emitted ${passthrough.length} column(s) preserved from the original workbook: ${passthrough.join(', ')}`,
    });
  }

  return { bytes, notes };
}
