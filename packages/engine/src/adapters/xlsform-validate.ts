/**
 * Workbook validation, with addresses.
 *
 * `importXlsForm` answers "can this become a form?". This module answers "what is
 * wrong with this spreadsheet, and where?". It reads the raw sheets rather than the
 * canonical model, so it still works when the file is too broken to import, and
 * every diagnostic names the sheet, the row and the column a person can click.
 *
 * The row numbers are 1-based and include the header, matching what Excel shows.
 * That is the one place where a zero would cost somebody ten minutes of counting.
 */
import { ExpressionError, collectBareNames, collectRefs, parse } from '../expression.js';
import { parseAuditSpec, parseSpeedSpec } from '../audit.js';
import { colName, type Sheet } from './xlsx.js';

export type DiagnosticSeverity = 'error' | 'warning';

export interface Diagnostic {
  code: string;
  severity: DiagnosticSeverity;
  sheet: string;
  /** 1-based row as Excel displays it. */
  row: number;
  /** Header text of the column, when the problem belongs to one. */
  column?: string;
  /** A1 address, when the problem belongs to a cell. */
  cell?: string;
  message: string;
}

export interface WorkbookValidationReport {
  diagnostics: Diagnostic[];
  errors: number;
  warnings: number;
  valid: boolean;
  sheetNames: string[];
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Field plug-ins are not executed here. This is the allowlist of custom appearances
 * whose behaviour is implemented by the base renderer. It is empty on purpose: an
 * unknown `custom-*` appearance is preserved through a round trip and rendered as
 * the underlying control, and no third-party code is fetched or executed.
 */
export const CUSTOM_APPEARANCE_ALLOWLIST: readonly string[] = ['custom-specify-other'];

/** Types the platform renders, plus metadata and audit phrases it preserves. */
const KNOWN_TYPES = new Set<string>([
  'text', 'textarea', 'integer', 'decimal', 'percentage', 'currency', 'date', 'datetime', 'time',
  'yesno', 'select one', 'select multiple', 'rank', 'geopoint', 'geotrace', 'geoshape', 'calculate here',
  'image', 'audio', 'video', 'file', 'barcode', 'note', 'calculate',
  'start', 'end', 'today', 'deviceid', 'username', 'simserial', 'subscriberid', 'phonenumber',
  'caseid', 'audit', 'background audio', 'background geopoint', 'start geopoint',
  'email', 'url', 'hidden', 'acknowledge', 'range',
  'text audit', 'audio audit', 'speed violations', 'speed violations count', 'speed violations list',
  'sensor stream', 'sensor statistic', 'xml external', 'select one from file',
  'select multiple from file', 'image label',
].map((type) => type.replace(/_/g, ' ')));

/** A type that arrives from another platform but must not silently pass as known. */
function normaliseType(raw: string): string {
  // Normalise the type keyword only. A list name such as `brand_awareness`
  // keeps its underscores, because that is the name the choices sheet uses.
  const value = raw.trim();
  const head = /^[A-Za-z_]+/.exec(value)?.[0] ?? '';
  return `${head.toLowerCase().replace(/_/g, ' ')}${value.slice(head.length)}`;
}

function headerBase(cell: string): string {
  const raw = cell.trim().toLowerCase();
  const double = raw.indexOf('::');
  if (double !== -1) return raw.slice(0, double).trim();
  const single = raw.lastIndexOf(':');
  if (single > 0 && !raw.startsWith('media:')) return raw.slice(0, single).trim();
  return raw.replace(/\s+/g, ' ');
}

function headerIndex(header: string[]): Map<string, number> {
  const index = new Map<string, number>();
  header.forEach((cell, i) => {
    const base = headerBase(cell);
    if (base !== '' && !index.has(base)) index.set(base, i);
  });
  return index;
}

function sheetNamed(sheets: Sheet[], name: string): Sheet | undefined {
  const wanted = name.toLowerCase();
  return sheets.find((sheet) => sheet.name.trim().toLowerCase() === wanted);
}

function cell(sheet: Sheet, row: string[], index: Map<string, number>, base: string): { value: string; column?: number; header?: string } {
  const i = index.get(base) ?? index.get(base.replace(/_/g, ' '));
  if (i === undefined) return { value: '' };
  return { value: (row[i] ?? '').trim(), column: i, header: (sheet.rows[0]?.[i] ?? base).trim() };
}

class Report {
  readonly diagnostics: Diagnostic[] = [];

  add(
    severity: DiagnosticSeverity,
    code: string,
    sheet: string,
    row: number,
    message: string,
    at?: { column?: number; header?: string },
  ): void {
    this.diagnostics.push({
      code,
      severity,
      sheet,
      row,
      ...(at?.header ? { column: at.header } : {}),
      ...(at?.column !== undefined ? { cell: `${colName(at.column)}${row}` } : {}),
      message,
    });
  }

  error(code: string, sheet: string, row: number, message: string, at?: { column?: number; header?: string }): void {
    this.add('error', code, sheet, row, message, at);
  }

  warning(code: string, sheet: string, row: number, message: string, at?: { column?: number; header?: string }): void {
    this.add('warning', code, sheet, row, message, at);
  }
}

interface Settings {
  values: Record<string, string>;
  rows: Record<string, number>;
}

function readSettings(sheet: Sheet | undefined): Settings {
  const values: Record<string, string> = {};
  const rows: Record<string, number> = {};
  if (!sheet) return { values, rows };
  const first = (sheet.rows[0] ?? []).map((value) => value.trim().toLowerCase());
  const known = ['form_title', 'form_id', 'version', 'default_language', 'instance_name', 'public_key', 'submission_url'];
  if (first.filter((value) => known.includes(value)).length >= 2) {
    const data = sheet.rows[1] ?? [];
    first.forEach((key, i) => {
      if (key === '') return;
      values[key] = (data[i] ?? '').trim();
      rows[key] = 1;
    });
    return { values, rows };
  }
  sheet.rows.forEach((row, i) => {
    const key = (row[0] ?? '').trim().toLowerCase();
    if (key === '' || (i === 0 && (key === 'key' || key === 'setting'))) return;
    values[key] = (row[1] ?? '').trim();
    rows[key] = i + 1;
  });
  return { values, rows };
}

interface ChoiceRow {
  name: string;
  rowNumber: number;
  extra: Set<string>;
}

function readChoiceLists(sheet: Sheet | undefined): Map<string, ChoiceRow[]> {
  const lists = new Map<string, ChoiceRow[]>();
  if (!sheet) return lists;
  const index = headerIndex(sheet.rows[0] ?? []);
  const listAt = index.get('list_name');
  const nameAt = index.get('name') ?? index.get('value');
  if (listAt === undefined || nameAt === undefined) return lists;
  const extraKeys = new Set(
    [...index.keys()].filter((key) => !['list_name', 'name', 'value', 'label', 'image'].includes(key)
      && !key.startsWith('label:')
      && !key.startsWith('image:')),
  );
  sheet.rows.slice(1).forEach((row, i) => {
    const listName = (row[listAt] ?? '').trim();
    const name = (row[nameAt] ?? '').trim();
    if (listName === '') return;
    if (name === '') return;
    const rowNumber = i + 2;
    const extra = new Set([...extraKeys].filter((key) => (row[index.get(key) ?? -1] ?? '').trim() !== ''));
    const entries = lists.get(listName) ?? [];
    entries.push({ name, rowNumber, extra });
    lists.set(listName, entries);
  });
  return lists;
}

/**
 * Validate sheets that have already been read.
 *
 * The parser never throws on bad input; it collects. A caller that wants to stop
 * looks at `valid`, and a caller that wants to show a spreadsheet-shaped problem
 * list renders `diagnostics` in order.
 */
export function validateXlsFormSheets(sheets: Sheet[]): WorkbookValidationReport {
  const report = new Report();
  const seenNames = new Set<string>();

  for (const sheet of sheets) {
    if (seenNames.has(sheet.name)) {
      report.error('duplicate-sheet', sheet.name, 1, `Two sheets are named "${sheet.name}"; the second one is never read.`);
    }
    seenNames.add(sheet.name);
  }

  const survey = sheetNamed(sheets, 'survey');
  if (!survey) {
    report.error('missing-survey', 'workbook', 1, 'The workbook has no `survey` sheet. An XLSForm cannot be compiled without one.');
    return finish(report, sheets);
  }

  const surveyHeader = survey.rows[0] ?? [];
  const surveyIndex = headerIndex(surveyHeader);
  if (surveyIndex.size === 0) {
    report.error('missing-header', 'survey', 1, 'The survey sheet has no header row, so no column can be read.');
    return finish(report, sheets);
  }
  if (!surveyIndex.has('type')) {
    report.error('missing-type-column', 'survey', 1, 'The survey sheet has no `type` column.');
  }
  if (!surveyIndex.has('name')) {
    report.error('missing-name-column', 'survey', 1, 'The survey sheet has no `name` column.');
  }

  const choices = sheetNamed(sheets, 'choices');
  const choiceLists = readChoiceLists(choices);
  if (choices) {
    const choiceHeader = choices.rows[0] ?? [];
    const choiceIndex = headerIndex(choiceHeader);
    if (!choiceIndex.has('list_name')) {
      report.error('choices-missing-column', 'choices', 1, 'The choices sheet has no `list_name` column.');
    }
    if (!choiceIndex.has('name') && !choiceIndex.has('value')) {
      report.error('choices-missing-column', 'choices', 1, 'The choices sheet has no `name` or `value` column.');
    }
    const choiceValueAt = choiceIndex.get('name') ?? choiceIndex.get('value') ?? -1;
    const seen = new Map<string, number>();
    choices.rows.slice(1).forEach((row, i) => {
      const rowNumber = i + 2;
      const listName = (row[choiceIndex.get('list_name') ?? -1] ?? '').trim();
      const name = (row[choiceValueAt] ?? '').trim();
      if (listName === '' && name === '') return;
      if (listName === '') {
        report.error('choice-without-list', 'choices', rowNumber, `Choice "${name}" has no list_name, so no question can select it.`, {
          column: choiceIndex.get('list_name'),
          header: 'list_name',
        });
      }
      if (name === '') {
        report.error('choice-without-name', 'choices', rowNumber, `A choice in list "${listName}" has no name or value, so its stored value would be blank.`, {
          column: choiceValueAt,
          header: choiceIndex.has('name') ? 'name' : 'value',
        });
      }
      if (listName && name) {
        const key = `${listName}\u0000${name}`;
        const previous = seen.get(key);
        if (previous !== undefined) {
          report.error('duplicate-choice', 'choices', rowNumber, `List "${listName}" already has a choice named "${name}" (row ${previous}).`, {
            column: choiceValueAt,
            header: choiceIndex.has('name') ? 'name' : 'value',
          });
        } else {
          seen.set(key, rowNumber);
        }
      }
    });
  }

  const settingsSheet = sheetNamed(sheets, 'settings');
  const settings = readSettings(settingsSheet);
  if (!settingsSheet) {
    report.warning('missing-settings', 'workbook', 1, 'No `settings` sheet: the title, form id and version cannot be read from the file.');
  } else {
    if (!settings.values['form_title']) {
      report.error('missing-form-title', 'settings', 1, 'settings.form_title is empty. A form cannot be published without a title.', {
        column: 0,
        header: 'form_title',
      });
    }
    if (!settings.values['form_id']) {
      report.warning('missing-form-id', 'settings', 1, 'settings.form_id is empty. The compiler will derive one from the title, but an explicit id is what keeps versions of one instrument together.', {
        column: 0,
        header: 'form_id',
      });
    }
    const version = settings.values['version'] ?? '';
    if (version === '') {
      report.warning('missing-version', 'settings', settings.rows['version'] ?? 1, 'settings.version is empty. The version formula fills it when the workbook is opened in Excel; an upload needs a value first.', {
        column: 0,
        header: 'version',
      });
    } else if (!/^\d{10}$/.test(version)) {
      report.warning('version-format', 'settings', settings.rows['version'] ?? 1, `settings.version is "${version}", not a YYMMDDHHmm stamp. Version comparison still works, but the formula convention is a ten digit stamp.`, {
        column: 0,
        header: 'version',
      });
    }
  }

  /* -------- declared names, so a reference can be checked before its target row */
  const declared = new Set<string>();
  survey.rows.slice(1).forEach((row) => {
    const name = (row[surveyIndex.get('name') ?? -1] ?? '').trim();
    if (name !== '') declared.add(name);
  });

  interface OpenGroup {
    name: string;
    kind: 'group' | 'repeat';
    rowNumber: number;
  }
  const stack: OpenGroup[] = [];
  const questionNames = new Map<string, number>();

  survey.rows.slice(1).forEach((row, i) => {
    const rowNumber = i + 2;
    const typeCell = cell(survey, row, surveyIndex, 'type');
    const nameCell = cell(survey, row, surveyIndex, 'name');
    const rowIsEmpty = row.every((value) => (value ?? '').trim() === '');
    if (rowIsEmpty) return;

    const type = normaliseType(typeCell.value);
    const name = nameCell.value;
    const at = (base: string) => {
      const found = cell(survey, row, surveyIndex, base);
      return found.column === undefined ? undefined : { column: found.column, header: found.header };
    };

    if (type === '') {
      report.error('missing-type', 'survey', rowNumber, 'This row has values but no type, so it cannot be read.', at('type'));
      return;
    }

    if (type === 'begin group' || type === 'begin repeat') {
      const kind = type === 'begin group' ? 'group' : 'repeat';
      if (name === '') {
        report.warning('unnamed-group', 'survey', rowNumber, `This ${kind} has no name; the compiler will generate one.`, at('name'));
      } else if (!NAME_RE.test(name)) {
        report.error('invalid-name', 'survey', rowNumber, `"${name}" is not a valid ${kind} name. Use letters, digits and underscores, starting with a letter or underscore.`, at('name'));
      }
      stack.push({ name: name || `(unnamed ${kind})`, kind, rowNumber });
      const relevant = cell(survey, row, surveyIndex, 'relevant');
      if (relevant.value !== '') {
        try {
          for (const ref of collectRefs(parse(relevant.value))) {
            if (!declared.has(ref)) {
              report.error('unknown-reference', 'survey', rowNumber, `The group's relevant expression refers to \${${ref}}, which is not a question or group in this workbook.`, at('relevant'));
            }
          }
        } catch (err) {
          report.error('expression', 'survey', rowNumber, `relevant: ${(err as ExpressionError).message}`, at('relevant'));
        }
      }
      if (kind === 'repeat') {
        const repeatCount = cell(survey, row, surveyIndex, 'repeat_count');
        if (repeatCount.value !== '' && !/^\d+$/.test(repeatCount.value)) {
          try {
            parse(repeatCount.value);
          } catch (err) {
            report.error('expression', 'survey', rowNumber, `repeat_count: ${(err as ExpressionError).message}`, at('repeat_count'));
          }
        }
      }
      return;
    }

    if (type === 'end group' || type === 'end repeat') {
      const wantRepeat = type === 'end repeat';
      const top = stack.pop();
      if (!top) {
        report.error('unbalanced-end', 'survey', rowNumber, `This ${type} closes nothing: no group or repeat is open.`, at('type'));
        return;
      }
      if (top.kind !== (wantRepeat ? 'repeat' : 'group')) {
        report.error('mismatched-end', 'survey', rowNumber, `This ${type} closes "${top.name}", which was opened as begin_${top.kind} on row ${top.rowNumber}.`, at('type'));
      }
      return;
    }

    /* ---------------------------------------------------------- a real field */
    if (type === 'note' || type === 'calculate') {
      // A note may be nameless and label-only; a calculate needs a name to be referenced.
      if (type === 'calculate' && name === '') {
        report.error('missing-name', 'survey', rowNumber, 'A calculate field needs a name, otherwise nothing can refer to its value.', at('name'));
      }
    } else if (name === '') {
      report.error('missing-name', 'survey', rowNumber, 'This question has no name, so its answer has no column to live in.', at('name'));
    }

    if (name !== '') {
      if (!NAME_RE.test(name)) {
        report.error('invalid-name', 'survey', rowNumber, `"${name}" is not a valid question name. Use letters, digits and underscores, starting with a letter or underscore.`, at('name'));
      }
      const previous = questionNames.get(name);
      if (previous !== undefined) {
        report.error('duplicate-name', 'survey', rowNumber, `Question name "${name}" is already used on row ${previous}. Names must be unique; exports would collide.`, at('name'));
      } else {
        questionNames.set(name, rowNumber);
      }
    }

    if (!KNOWN_TYPES.has(type) && !/^(?:select (one|multiple)|rank) /.test(type)) {
      report.warning('unknown-type', 'survey', rowNumber, `"${type}" is not a type this platform renders. The row is preserved on export, but it will not be collected.`, at('type'));
    }

    const selectMatch = /^(?:select (one|multiple)|rank)\s+(.+)$/.exec(type);
    if (type === 'select one' || type === 'select multiple' || type === 'rank') {
      report.error('select-without-list', 'survey', rowNumber, `This ${type} names no choice list. Write "${type} <list_name>".`, at('type'));
    } else if (selectMatch) {
      const listName = (selectMatch[2] ?? '').trim();
      if (listName.startsWith('from file')) {
        // select_one_from_file: the list is an external CSV, not a sheet row.
      } else if (!choiceLists.has(listName)) {
        report.error('unknown-choice-list', 'survey', rowNumber, `This question selects from list "${listName}", but the choices sheet has no list with that name.`, at('type'));
      } else if ((choiceLists.get(listName) ?? []).length === 0) {
        report.warning('empty-choice-list', 'survey', rowNumber, `Choice list "${listName}" is empty, so every option is hidden.`, at('type'));
      }
    }

    const invisible = type === 'note' || type === 'calculate' || type === 'text audit' || type === 'audio audit'
      || type.startsWith('speed violations') || type.startsWith('sensor ')
      || ['start', 'end', 'deviceid', 'phonenumber', 'username', 'simserial', 'subscriberid', 'caseid', 'today'].includes(type);
    if (!invisible) {
      const label = cell(survey, row, surveyIndex, 'label');
      if (label.value === '') {
        report.warning('missing-label', 'survey', rowNumber, 'This field has no label, so a respondent would see an unlabelled control.', at('label'));
      }
    }

    const required = cell(survey, row, surveyIndex, 'required');
    const requiredValue = required.value.toLowerCase();
    if (requiredValue !== '' && !['yes', 'no', 'true', 'false', '1', '0'].includes(requiredValue)) {
      try {
        parse(required.value);
      } catch (err) {
        report.error('expression', 'survey', rowNumber, `required: ${(err as ExpressionError).message}`, at('required'));
      }
    }

    const expressions: Array<[base: string, columns: string[]]> = [
      ['relevant', ['relevant', 'relevance']],
      ['constraint', ['constraint']],
      ['calculation', ['calculation']],
      ['choice_filter', ['choice_filter']],
    ];
    for (const [label, columns] of expressions) {
      const found = columns.map((base) => cell(survey, row, surveyIndex, base)).find((entry) => entry.value !== '');
      if (!found || found.value === '') continue;
      try {
        const ast = parse(found.value);
        for (const ref of collectRefs(ast)) {
          if (!declared.has(ref)) {
            report.error('unknown-reference', 'survey', rowNumber, `${label}: \${${ref}} is not a question or group in this workbook.`, {
              column: found.column,
              header: found.header,
            });
          }
          if (ref === name && name !== '') {
            report.error('self-reference', 'survey', rowNumber, `${label}: the field refers to itself, so it can never resolve.`, {
              column: found.column,
              header: found.header,
            });
          }
        }
        if (label === 'choice_filter') {
          const listName = selectMatch?.[2]?.trim() ?? '';
          const list = choiceLists.get(listName) ?? [];
          const attributes = new Set(list.flatMap((entry) => [...entry.extra]));
          for (const bare of collectBareNames(ast)) {
            if (list.length > 0 && !attributes.has(bare)) {
              report.warning('unknown-filter-column', 'survey', rowNumber, `choice_filter uses "${bare}", but no choice in "${listName}" fills that column, so every option would be filtered out.`, {
                column: found.column,
                header: found.header,
              });
            }
          }
        } else {
          for (const bare of collectBareNames(ast)) {
            report.error('bare-name', 'survey', rowNumber, `${label}: "${bare}" is not a reference. Write \${${bare}} if you mean a question.`, {
              column: found.column,
              header: found.header,
            });
          }
        }
      } catch (err) {
        report.error('expression', 'survey', rowNumber, `${label}: ${(err as ExpressionError).message}`, {
          column: found.column,
          header: found.header,
        });
      }
    }

    const constraint = cell(survey, row, surveyIndex, 'constraint');
    const constraintMessage = cell(survey, row, surveyIndex, 'constraint_message');
    if (constraint.value !== '' && constraintMessage.value === '') {
      report.warning('constraint-without-message', 'survey', rowNumber, 'This question has a constraint but no constraint_message, so a respondent is blocked without being told what to change.', at('constraint_message'));
    }
    if (constraint.value === '' && constraintMessage.value !== '') {
      report.warning('message-without-constraint', 'survey', rowNumber, 'This question has a constraint_message but no constraint, so the message can never appear.', at('constraint_message'));
    }

    if (type === 'text audit' || type === 'audio audit') {
      const appearance = cell(survey, row, surveyIndex, 'appearance');
      const spec = parseAuditSpec(type === 'text audit' ? 'text_audit' : 'audio_audit', appearance.value);
      if ('error' in spec) {
        report.error('audit-spec', 'survey', rowNumber, `${type}: ${spec.error}`, at('appearance'));
      }
    }
    if (type === 'speed violations' || type === 'speed violations count' || type === 'speed violations list') {
      const appearance = cell(survey, row, surveyIndex, 'appearance');
      const spec = parseSpeedSpec(appearance.value);
      if ('error' in spec) {
        report.error('speed-spec', 'survey', rowNumber, `${type}: ${spec.error}`, at('appearance'));
      }
    }

    const appearance = cell(survey, row, surveyIndex, 'appearance');
    const custom = appearance.value.split(/\s+/).find((token) => token.startsWith('custom-'));
    const customName = custom?.split('(')[0] ?? '';
    if (custom && !CUSTOM_APPEARANCE_ALLOWLIST.includes(customName)) {
      report.warning(
        'field-plugin-not-supported',
        'survey',
        rowNumber,
        `${custom} is preserved in the workbook, but this deployment does not load field plug-in code. The base control will render instead.`,
        at('appearance'),
      );
    }
  });

  for (const open of stack.reverse()) {
    report.error(
      'unclosed-group',
      'survey',
      open.rowNumber,
      `This ${open.kind} "${open.name}" is never closed. Add an end_${open.kind} row after its last field.`,
    );
  }

  return finish(report, sheets);
}

function finish(report: Report, sheets: Sheet[]): WorkbookValidationReport {
  const errors = report.diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;
  const warnings = report.diagnostics.length - errors;
  return {
    diagnostics: report.diagnostics,
    errors,
    warnings,
    valid: errors === 0,
    sheetNames: sheets.map((sheet) => sheet.name),
  };
}

/* --------------------------------------------------------- upload guards */

export interface UploadGuardInput {
  /** The form id declared in the workbook's settings sheet. */
  formId?: string | null;
  /** The version declared in the workbook's settings sheet. */
  version?: string | null;
  /**
   * The id of a *different* form in the same organisation that already owns
   * `formId`. Uploading another version of the same form is not a conflict and
   * the caller must pass null for it.
   */
  conflictingFormId?: string | null;
  /** The version currently deployed for the form being uploaded, if any. */
  currentVersion?: string | null;
  /**
   * Refuse a blank version (default true). A first import has no version to be
   * newer than, so creation passes false and lets the form start unversioned.
   */
  requireVersion?: boolean;
}

export interface UploadGuardResult {
  ok: boolean;
  errors: string[];
}

/** Compare YYMMDDHHmm style stamps without floating point. */
export function compareVersions(a: string, b: string): number {
  const left = a.trim();
  const right = b.trim();
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    const l = left.replace(/^0+/, '');
    const r = right.replace(/^0+/, '');
    if (l.length !== r.length) return l.length < r.length ? -1 : 1;
    return l < r ? -1 : l > r ? 1 : 0;
  }
  return left.localeCompare(right, 'en', { numeric: true, sensitivity: 'base' });
}

/**
 * The two refusals an upload can earn, with the exact sentences the product
 * promises. Kept in the engine rather than the HTTP layer so the same rules run
 * in a test, in the API and in any future import surface.
 */
export function checkUpload(input: UploadGuardInput): UploadGuardResult {
  const errors: string[] = [];
  const formId = (input.formId ?? '').trim();
  const version = (input.version ?? '').trim();

  if (formId !== '' && formId === (input.conflictingFormId ?? '').trim()) {
    errors.push(
      `Your form definition specifies a form ID (${formId}) that already exists. ` +
        `If you would like to update that existing form, please use the 'Upload' option for that form.`,
    );
  }

  if (formId === '') {
    errors.push('Your form definition has no form ID. Add settings.form_id and resubmit.');
  }

  if (version === '' && input.requireVersion !== false) {
    errors.push('Your form definition has no version. Open the workbook in Excel so the version formula fills in, then resubmit.');
  } else if (version !== '' && input.currentVersion && compareVersions(version, input.currentVersion) <= 0) {
    errors.push(
      `Your uploaded form version (${version}) is not newer than existing form version (${input.currentVersion}). ` +
        'Update the form version and resubmit.',
    );
  }

  return { ok: errors.length === 0, errors };
}
