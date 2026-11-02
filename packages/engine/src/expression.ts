/**
 * The platform expression language (specs/PLATFORM.md §2).
 *
 * One language, evaluated in three places (browser for live UX, server for
 * authority, importer for translation) so they cannot disagree. There is
 * deliberately NO user-authored JavaScript anywhere in the engine.
 *
 * Syntax is XLSForm/XPath-compatible where it matters, because that is what
 * imported forms contain:
 *   ${question_name}   .   and or not   = != < <= > >=   + - * / %
 *   if() coalesce() length() upper() lower() trim() number() int() round()
 *   abs() min() max() sum() today() now() selected() count-selected()
 */
import { lookupDataset } from './datasets.js';

export type Expr =
  | { kind: 'num'; value: number }
  | { kind: 'str'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'ref'; name: string }
  /** Bare identifier: a choice attribute inside a `choice_filter`. */
  | { kind: 'bare'; name: string }
  | { kind: 'current' }
  | { kind: 'unary'; op: 'not' | '-'; operand: Expr }
  | { kind: 'binary'; op: BinaryOp; left: Expr; right: Expr }
  | { kind: 'call'; name: string; args: Expr[] };

export type BinaryOp =
  | 'or' | 'and' | '=' | '!=' | '<' | '<=' | '>' | '>=' | '+' | '-' | '*' | '/' | '%' | 'div' | 'mod';

export interface DynamicChoiceColumns {
  /** The dataset column whose value the answer stores. */
  valueColumn: string;
  /** Columns whose values form the visible label, in order. */
  labelColumns: string[];
  /** Optional dataset column holding an image filename. */
  imageColumn?: string | null;
}

export interface EvalContext {
  /** Answer values keyed by question name. */
  answers?: Record<string, unknown>;
  /** Embedded data / respondent variables. */
  variables?: Record<string, unknown>;
  /**
   * Attached server datasets, keyed by normalised code. `pulldata()` reads only
   * this snapshot, so a calculation is identical in the browser and on the server.
   */
  datasets?: import('./datasets.js').DatasetContext;
  /** Labels for static choices, keyed by question name and then choice value. */
  choiceLabels?: Record<string, Record<string, string>>;
  /** The columns a dynamic `search()` list takes its value and label from. */
  dynamicChoice?: DynamicChoiceColumns;
  /** The value being validated, bound to `.` inside a constraint. */
  current?: unknown;
  /**
   * Attributes of the choice currently being filtered, bound to bare names.
   * XLSForm's `choice_filter` is written `province = ${province}`: the bare name is a
   * column on the `choices` sheet, the `${…}` is an answered question. This is the only
   * place a bare identifier is meaningful, and `validateForm` enforces that.
   */
  attributes?: Record<string, unknown>;
  /**
   * SurveyCTO plug-in metadata, keyed by field name. `custom-specify-other`
   * stores `code|verbatim` here; `plug-in-metadata(${field})` reads it without
   * overloading the field's own answer value.
   */
  pluginMetadata?: Record<string, string>;
  /** Device metadata supplied by the runtime, returned by `device-info()`. */
  deviceInfo?: Record<string, unknown> | string;
  /** The instant the interview started, used by `duration()`. */
  startedAt?: Date | string | number;
  /** Clock override for deterministic tests and server re-evaluation. */
  now?: Date | string | number;
  /** Per-response values already drawn for top-level `once()` calculations. */
  onceValues?: Record<string, unknown>;
  /** Duration in seconds, when the runtime has already measured it. */
  durationSeconds?: number;
}

export class ExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExpressionError';
  }
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------
type Token =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'ref'; v: string }
  | { t: 'ident'; v: string }
  | { t: 'op'; v: string }
  | { t: 'punc'; v: '(' | ')' | ',' }
  | { t: 'eof' };

const REF_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}/;

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (/\s/.test(ch)) { i += 1; continue; }

    if (input.startsWith('${', i)) {
      const m = REF_RE.exec(input.slice(i));
      if (!m) throw new ExpressionError(`Malformed reference at position ${i}`);
      tokens.push({ t: 'ref', v: m[1]! });
      i += m[0].length;
      continue;
    }

    if (ch === '.' && !/[0-9]/.test(input[i + 1] ?? '')) {
      tokens.push({ t: 'op', v: '.' });
      i += 1;
      continue;
    }

    if (/[0-9]/.test(ch)) {
      const m = /^[0-9]+(\.[0-9]+)?/.exec(input.slice(i))!;
      tokens.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }

    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== quote) { out += input[j]; j += 1; }
      if (j >= input.length) throw new ExpressionError('Unterminated string literal');
      tokens.push({ t: 'str', v: out });
      i = j + 1;
      continue;
    }

    // Hyphenated function names must be matched before identifiers, otherwise
    // `count-selected(...)` lexes as `count - selected`. The pattern is general
    // because XLSForm has a family of them: `choice-label`, `selected-at`,
    // `string-length`, `format-date-time`, `count-if`, and so on.
    const hyphenated = /^([A-Za-z_][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)+)(?=\s*\()/.exec(input.slice(i));
    if (hyphenated) {
      tokens.push({ t: 'ident', v: hyphenated[1]! });
      i += hyphenated[1]!.length;
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      // XLSForm identifiers exclude hyphens, so `a-b` is unambiguously subtraction.
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(input.slice(i))!;
      const word = m[0];
      const low = word.toLowerCase();
      if (low === 'and' || low === 'or' || low === 'not' || low === 'div' || low === 'mod') tokens.push({ t: 'op', v: low });
      else tokens.push({ t: 'ident', v: word });
      i += word.length;
      continue;
    }

    if ('()'.includes(ch) || ch === ',') { tokens.push({ t: 'punc', v: ch as '(' | ')' | ',' }); i += 1; continue; }

    const two = input.slice(i, i + 2);
    if (['!=', '<=', '>=', '==', '&&', '||'].includes(two)) { tokens.push({ t: 'op', v: two }); i += 2; continue; }
    if ('=<>+-*/%!'.includes(ch)) { tokens.push({ t: 'op', v: ch }); i += 1; continue; }

    throw new ExpressionError(`Unexpected character '${ch}' at position ${i}`);
  }
  tokens.push({ t: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser (precedence climbing)
// ---------------------------------------------------------------------------
export function parse(input: string): Expr {
  const tokens = tokenize(input);
  let pos = 0;
  const peek = (): Token => tokens[pos]!;
  const next = (): Token => tokens[pos++]!;
  const isOp = (v: string): boolean => { const tk = peek(); return tk.t === 'op' && tk.v === v; };
  const eatOp = (v: string): boolean => { if (isOp(v)) { pos += 1; return true; } return false; };

  function expression(): Expr { return orExpr(); }

  function orExpr(): Expr {
    let left = andExpr();
    while (isOp('or') || isOp('||')) { next(); left = { kind: 'binary', op: 'or', left, right: andExpr() }; }
    return left;
  }
  function andExpr(): Expr {
    let left = equality();
    while (isOp('and') || isOp('&&')) { next(); left = { kind: 'binary', op: 'and', left, right: equality() }; }
    return left;
  }
  function equality(): Expr {
    let left = comparison();
    for (;;) {
      if (eatOp('=') || eatOp('==')) left = { kind: 'binary', op: '=', left, right: comparison() };
      else if (eatOp('!=')) left = { kind: 'binary', op: '!=', left, right: comparison() };
      else return left;
    }
  }
  function comparison(): Expr {
    let left = additive();
    for (;;) {
      if (eatOp('<=')) left = { kind: 'binary', op: '<=', left, right: additive() };
      else if (eatOp('>=')) left = { kind: 'binary', op: '>=', left, right: additive() };
      else if (eatOp('<')) left = { kind: 'binary', op: '<', left, right: additive() };
      else if (eatOp('>')) left = { kind: 'binary', op: '>', left, right: additive() };
      else return left;
    }
  }
  function additive(): Expr {
    let left = multiplicative();
    for (;;) {
      if (eatOp('+')) left = { kind: 'binary', op: '+', left, right: multiplicative() };
      else if (eatOp('-')) left = { kind: 'binary', op: '-', left, right: multiplicative() };
      else return left;
    }
  }
  function multiplicative(): Expr {
    let left = unary();
    for (;;) {
      if (eatOp('*')) left = { kind: 'binary', op: '*', left, right: unary() };
      else if (eatOp('/')) left = { kind: 'binary', op: '/', left, right: unary() };
      else if (eatOp('%')) left = { kind: 'binary', op: '%', left, right: unary() };
      else if (eatOp('div')) left = { kind: 'binary', op: 'div', left, right: unary() };
      else if (eatOp('mod')) left = { kind: 'binary', op: 'mod', left, right: unary() };
      else return left;
    }
  }
  function unary(): Expr {
    if (eatOp('not') || eatOp('!')) return { kind: 'unary', op: 'not', operand: unary() };
    if (eatOp('-')) return { kind: 'unary', op: '-', operand: unary() };
    return primary();
  }
  function primary(): Expr {
    const tk = next();
    switch (tk.t) {
      case 'num': return { kind: 'num', value: tk.v };
      case 'str': return { kind: 'str', value: tk.v };
      case 'ref': return { kind: 'ref', name: tk.v };
      case 'op':
        if (tk.v === '.') return { kind: 'current' };
        throw new ExpressionError(`Unexpected operator '${tk.v}'`);
      case 'ident': {
        const low = tk.v.toLowerCase();
        if (low === 'true') return { kind: 'bool', value: true };
        if (low === 'false') return { kind: 'bool', value: false };
        if (low === 'null') return { kind: 'null' };
        const open = peek();
        if (open.t !== 'punc' || open.v !== '(') {
          // A bare identifier is only legal as a `choice_filter` attribute name; the
          // publish-time analyser rejects it everywhere else, so authors still get a
          // clear error - during authoring, not mid-interview.
          return { kind: 'bare', name: tk.v };
        }
        next(); // consume the '('
        const args: Expr[] = [];
        const first = peek();
        if (!(first.t === 'punc' && first.v === ')')) {
          for (;;) {
            args.push(expression());
            if (peek().t === 'punc' && (peek() as { v: string }).v === ',') { next(); continue; }
            break;
          }
        }
        const close = next();
        if (close.t !== 'punc' || close.v !== ')') throw new ExpressionError(`Expected ')' after ${tk.v}(`);
        return { kind: 'call', name: low, args };
      }
      case 'punc':
        if (tk.v === '(') { const e = expression(); const c = next(); if (c.t !== 'punc' || c.v !== ')') throw new ExpressionError("Expected ')'"); return e; }
        throw new ExpressionError(`Unexpected '${tk.v}'`);
      case 'eof':
      default:
        throw new ExpressionError('Unexpected end of expression');
    }
  }

  const ast = expression();
  const tail = peek();
  if (tail.t !== 'eof') throw new ExpressionError('Unexpected trailing input');
  return ast;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------
function isBlank(v: unknown): boolean {
  return v === null || v === undefined || v === '';
}

/** XLSForm semantics: a multi-select is a set, and `selected()` tests membership. */
function asList(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (isBlank(v)) return [];
  if (typeof v === 'string') return v.split(/\s+/).filter(Boolean);
  return [v];
}

function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (isBlank(v)) return Number.NaN;   // empty numeric answers are NOT zero
  return Number(v);
}

function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (isBlank(a) && isBlank(b)) return true;
  const na = toNumber(a);
  const nb = toNumber(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na === nb;
  return String(a) === String(b);
}

function compare(a: unknown, b: unknown): number {
  const na = toNumber(a);
  const nb = toNumber(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na < nb ? -1 : na > nb ? 1 : 0;
  const sa = String(a ?? '');
  const sb = String(b ?? '');
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

export function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'string') return v.trim() !== '' && v !== '0' && v.toLowerCase() !== 'false';
  return Boolean(v);
}

type Arg = Expr;

function requireArgs(name: string, args: Arg[], min: number): void {
  if (args.length < min) throw new ExpressionError(`${name}() expects at least ${min} argument(s)`);
}

export function evaluate(expr: Expr, ctx: EvalContext = {}): unknown {
  switch (expr.kind) {
    case 'num': return expr.value;
    case 'str': return expr.value;
    case 'bool': return expr.value;
    case 'null': return null;
    case 'current': return ctx.current ?? null;
    case 'bare': return ctx.attributes?.[expr.name] ?? null;
    case 'ref': {
      if (ctx.answers && expr.name in ctx.answers) return ctx.answers[expr.name];
      if (ctx.variables && expr.name in ctx.variables) return ctx.variables[expr.name];
      return null;
    }
    case 'unary': {
      const v = evaluate(expr.operand, ctx);
      return expr.op === 'not' ? !truthy(v) : -toNumber(v);
    }
    case 'binary': {
      // short-circuit boolean operators, XPath-style
      if (expr.op === 'and') return truthy(evaluate(expr.left, ctx)) && truthy(evaluate(expr.right, ctx));
      if (expr.op === 'or') return truthy(evaluate(expr.left, ctx)) || truthy(evaluate(expr.right, ctx));
      const a = evaluate(expr.left, ctx);
      const b = evaluate(expr.right, ctx);
      switch (expr.op) {
        case '=': return looseEquals(a, b);
        case '!=': return !looseEquals(a, b);
        case '<': return compare(a, b) < 0;
        case '<=': return compare(a, b) <= 0;
        case '>': return compare(a, b) > 0;
        case '>=': return compare(a, b) >= 0;
        case '+': return toNumber(a) + toNumber(b);
        case '-': return toNumber(a) - toNumber(b);
        case '*': return toNumber(a) * toNumber(b);
        case '/': return toNumber(a) / toNumber(b);
        case '%': return toNumber(a) % toNumber(b);
        case 'div': return Math.trunc(toNumber(a) / toNumber(b));
        case 'mod': return toNumber(a) % toNumber(b);
        default: throw new ExpressionError(`Unsupported operator ${expr.op}`);
      }
    }
    case 'call': return callFunction(expr.name, expr.args, ctx);
    default: throw new ExpressionError('Unsupported expression');
  }
}

/** A date-time, an ISO string, or a SurveyCTO decimal day count. */
function toDate(value: unknown): Date | null {
  const date = typeof value === 'number'
    ? new Date(value * 86_400_000)
    : value instanceof Date
      ? value
      : new Date(String(value ?? ''));
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDateTime(value: unknown, pattern: string): string {
  const date = toDate(value);
  if (!date) return '';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return pattern.replace(/%([YymndHhMSba%e3])/g, (_whole, token: string) => {
    switch (token) {
      case 'Y': return String(date.getUTCFullYear());
      case 'y': return String(date.getUTCFullYear()).slice(-2);
      case 'm': return pad(date.getUTCMonth() + 1);
      case 'n': return String(date.getUTCMonth() + 1);
      case 'd': return pad(date.getUTCDate());
      case 'e': return String(date.getUTCDate());
      case 'H': return pad(date.getUTCHours());
      case 'h': return String(date.getUTCHours());
      case 'M': return pad(date.getUTCMinutes());
      case 'S': return pad(date.getUTCSeconds());
      case 'b': return months[date.getUTCMonth()]!;
      case 'a': return days[date.getUTCDay()]!;
      case '3': return pad(date.getUTCMilliseconds(), 3);
      default: return `%${token}`;
    }
  });
}

function callFunction(name: string, args: Expr[], ctx: EvalContext): unknown {
  const arg = (n: number): unknown => (args[n] ? evaluate(args[n]!, ctx) : null);
  const list = (n: number): unknown[] => asList(arg(n));
  const itemTest = (item: unknown, expr: Expr): boolean =>
    truthy(evaluate(expr, { ...ctx, current: item }));

  switch (name) {
    // if() must not evaluate both branches eagerly.
    case 'if': {
      requireArgs(name, args, 3);
      return truthy(evaluate(args[0]!, ctx)) ? evaluate(args[1]!, ctx) : evaluate(args[2]!, ctx);
    }
    case 'coalesce': {
      requireArgs(name, args, 1);
      for (const a of args) { const v = evaluate(a, ctx); if (!isBlank(v)) return v; }
      return null;
    }
    case 'length':
    case 'string-length': return String(arg(0) ?? '').length;
    case 'string': {
      const value = arg(0);
      if (Array.isArray(value)) return value.map(String).join(' ');
      return isBlank(value) ? '' : String(value);
    }
    case 'concat': return args.map((a) => {
      const v = evaluate(a, ctx);
      return Array.isArray(v) ? v.map(String).join(' ') : isBlank(v) ? '' : String(v);
    }).join('');
    case 'substr': {
      const source = String(arg(0) ?? '');
      const start = Math.max(0, Math.trunc(toNumber(arg(1))));
      const end = args.length >= 3 ? Math.max(start, Math.trunc(toNumber(arg(2)))) : source.length;
      return source.slice(start, end);
    }
    case 'linebreak': return '\n';
    case 'upper': return String(arg(0) ?? '').toUpperCase();
    case 'lower': return String(arg(0) ?? '').toLowerCase();
    case 'trim': return String(arg(0) ?? '').trim();
    case 'number': { const n = toNumber(arg(0)); return Number.isNaN(n) ? null : n; }
    case 'int': { const n = toNumber(arg(0)); return Number.isNaN(n) ? null : Math.trunc(n); }
    case 'round': { const n = toNumber(arg(0)); const d = args[1] ? toNumber(arg(1)) : 0; const f = 10 ** d; return Math.round(n * f) / f; }
    case 'abs': return Math.abs(toNumber(arg(0)));
    case 'min': return Math.min(...args.map((a) => toNumber(evaluate(a, ctx))));
    case 'max': return Math.max(...args.map((a) => toNumber(evaluate(a, ctx))));
    case 'sum': {
      requireArgs(name, args, 1);
      // sum(${multi_select}) over a list of numeric codes, or sum(a,b,c)
      const flat = args.length === 1 ? asList(evaluate(args[0]!, ctx)) : args.map((a) => evaluate(a, ctx));
      return flat.reduce<number>((acc, v) => acc + (Number.isNaN(toNumber(v)) ? 0 : toNumber(v)), 0);
    }
    case 'selected': {
      requireArgs(name, args, 2);
      const values = list(0);
      const needle = arg(1);
      return values.some((v) => looseEquals(v, needle));
    }
    case 'selected-at': {
      requireArgs(name, args, 2);
      const values = list(0);
      const index = Math.trunc(toNumber(arg(1)));
      return index >= 0 && index < values.length ? values[index] : null;
    }
    case 'choice-label': {
      requireArgs(name, args, 2);
      const first = args[0];
      const fieldName = first?.kind === 'ref' ? first.name : isBlank(arg(0)) ? '' : String(arg(0));
      const labels = fieldName ? ctx.choiceLabels?.[fieldName] : undefined;
      const key = String(arg(1) ?? '');
      return labels?.[key] ?? null;
    }
    case 'plug-in-metadata': {
      requireArgs(name, args, 1);
      const first = args[0];
      const fieldName = first?.kind === 'ref' ? first.name : isBlank(arg(0)) ? '' : String(arg(0));
      if (fieldName === '') return '';
      return ctx.pluginMetadata?.[fieldName] ?? '';
    }
    case 'regex': {
      requireArgs(name, args, 2);
      const value = String(arg(0) ?? '');
      const pattern = String(arg(1) ?? '');
      if (pattern === '') return false;
      try {
        return new RegExp(pattern).test(value);
      } catch {
        throw new ExpressionError(`regex(): invalid pattern ${pattern}`);
      }
    }
    case 'device-info': {
      const value = ctx.deviceInfo;
      if (value === undefined || value === null) return '';
      return typeof value === 'string' ? value : JSON.stringify(value);
    }
    case 'duration': {
      if (typeof ctx.durationSeconds === 'number' && Number.isFinite(ctx.durationSeconds)) {
        return Math.max(0, Math.trunc(ctx.durationSeconds));
      }
      const end = toDate(ctx.now ?? new Date());
      const startValue = ctx.startedAt
        ?? (ctx.answers?.['starttime'] as unknown)
        ?? (ctx.answers?.['start'] as unknown);
      const start = toDate(startValue);
      if (!start || !end) return 0;
      return Math.max(0, Math.trunc((end.getTime() - start.getTime()) / 1000));
    }
    case 'once': {
      requireArgs(name, args, 1);
      return evaluate(args[0]!, ctx);
    }
    case 'count-selected': {
      requireArgs(name, args, 1);
      return list(0).length;
    }
    case 'join': {
      requireArgs(name, args, 2);
      const separator = String(arg(0) ?? '');
      const parts: string[] = [];
      for (const a of args.slice(1)) {
        const value = evaluate(a, ctx);
        if (Array.isArray(value)) parts.push(...value.map(String));
        else if (!isBlank(value)) parts.push(String(value));
      }
      return parts.join(separator);
    }
    case 'join-if': {
      requireArgs(name, args, 3);
      const separator = String(arg(0) ?? '');
      const values = list(1);
      const condition = args[2]!;
      return values.filter((value) => itemTest(value, condition)).map(String).join(separator);
    }
    case 'count': {
      requireArgs(name, args, 1);
      return list(0).length;
    }
    case 'count-if': {
      requireArgs(name, args, 2);
      const values = list(0);
      const condition = args[1]!;
      return values.filter((value) => itemTest(value, condition)).length;
    }
    case 'sum-if': {
      requireArgs(name, args, 2);
      return list(0)
        .filter((value) => itemTest(value, args[1]!))
        .reduce<number>((total, value) => total + (Number.isNaN(toNumber(value)) ? 0 : toNumber(value)), 0);
    }
    case 'min-if': {
      requireArgs(name, args, 2);
      const values = list(0)
        .filter((value) => itemTest(value, args[1]!))
        .map((value) => toNumber(value))
        .filter((value) => !Number.isNaN(value));
      return values.length === 0 ? null : Math.min(...values);
    }
    case 'max-if': {
      requireArgs(name, args, 2);
      const values = list(0)
        .filter((value) => itemTest(value, args[1]!))
        .map((value) => toNumber(value))
        .filter((value) => !Number.isNaN(value));
      return values.length === 0 ? null : Math.max(...values);
    }
    case 'empty': {
      requireArgs(name, args, 1);
      const value = arg(0);
      return isBlank(value) || (Array.isArray(value) && value.length === 0);
    }
    case 'search': {
      // `search()` is an appearance expression, not a normal calculation. It
      // returns the rows the choice list should show, and the caller supplies the
      // one placeholder choice that names the value and label columns.
      const source = String(arg(0) ?? '').trim().toLowerCase();
      const table = ctx.datasets?.[source];
      const columns = ctx.dynamicChoice;
      if (!table || !columns?.valueColumn) return [];
      let rows = table.rows.slice();

      if (args.length >= 4) {
        const kind = String(arg(1) ?? '').trim().toLowerCase();
        const fields = String(arg(2) ?? '').split(',').map((field) => field.trim()).filter(Boolean);
        const needle = String(arg(3) ?? '').toLowerCase();
        rows = rows.filter((row) =>
          fields.some((field) => {
            const cell = String(row[field] ?? '').toLowerCase();
            if (kind === 'contains') return cell.includes(needle);
            if (kind === 'startswith') return cell.startsWith(needle);
            if (kind === 'endswith') return cell.endsWith(needle);
            if (kind === 'matches') return cell === needle;
            return true;
          }),
        );
      }

      if (args.length >= 6) {
        const filterColumn = String(arg(4) ?? '').trim();
        const filterText = String(arg(5) ?? '');
        if (filterColumn !== '') {
          rows = rows.filter((row) => String(row[filterColumn] ?? '') === filterText);
        }
      }

      rows.sort((left, right) => {
        const a = Number(left['sortby']);
        const b = Number(right['sortby']);
        if (Number.isNaN(a) || Number.isNaN(b)) return 0;
        return a - b;
      });

      const seen = new Set<string>();
      const choices: Array<{ value: string; label: string; image?: string }> = [];
      for (const row of rows) {
        const value = String(row[columns.valueColumn] ?? '').trim();
        if (value === '' || seen.has(value)) continue;
        seen.add(value);
        const label = columns.labelColumns
          .map((column) => String(row[column] ?? '').trim())
          .filter(Boolean)
          .join(' ');
        const image = columns.imageColumn ? String(row[columns.imageColumn] ?? '').trim() : '';
        choices.push({ value, label: label || value, ...(image ? { image } : {}) });
      }
      return choices;
    }
    case 'pulldata': {
      requireArgs(name, args, 4);
      return lookupDataset(ctx.datasets, arg(0), arg(1), arg(2), arg(3));
    }
    case 'pow': return Math.pow(toNumber(arg(0)), toNumber(arg(1)));
    case 'sqrt': return Math.sqrt(toNumber(arg(0)));
    case 'log10': return Math.log10(toNumber(arg(0)));
    case 'exp': return Math.exp(toNumber(arg(0)));
    case 'pi': return Math.PI;
    case 'sin': return Math.sin(toNumber(arg(0)));
    case 'cos': return Math.cos(toNumber(arg(0)));
    case 'tan': return Math.tan(toNumber(arg(0)));
    case 'atan2': return Math.atan2(toNumber(arg(0)), toNumber(arg(1)));
    case 'floor': return Math.floor(toNumber(arg(0)));
    case 'ceiling': return Math.ceil(toNumber(arg(0)));
    case 'random': return Math.random();
    case 'today': { const d = new Date(); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`; }
    case 'now': return new Date().toISOString();
    case 'date': {
      const date = toDate(arg(0));
      return date ? date.toISOString().slice(0, 10) : '';
    }
    case 'date-time': {
      const date = toDate(arg(0));
      return date ? date.toISOString() : null;
    }
    case 'format-date-time': return formatDateTime(arg(0), String(arg(1) ?? ''));
    case 'decimal-date-time': {
      const date = toDate(arg(0));
      return date ? date.getTime() / 86_400_000 : null;
    }
    case 'decimal-time': {
      const date = toDate(arg(0));
      if (!date) return null;
      return (date.getUTCHours() * 3600 + date.getUTCMinutes() * 60 + date.getUTCSeconds()) / 86_400;
    }
    case 'asin': return Math.asin(toNumber(arg(0)));
    case 'acos': return Math.acos(toNumber(arg(0)));
    case 'atan': return Math.atan(toNumber(arg(0)));
    case 'count-items': {
      const separator = String(arg(0) ?? '');
      const value = String(arg(1) ?? '');
      if (separator === '' || value === '') return 0;
      return value.split(separator).length;
    }
    case 'item-at': {
      const separator = String(arg(0) ?? '');
      const value = String(arg(1) ?? '');
      const index = Math.trunc(toNumber(arg(2)));
      if (separator === '' || index < 0) return null;
      const items = value === '' ? [] : value.split(separator);
      return index < items.length ? items[index] : null;
    }
    case 'item-index': {
      const separator = String(arg(0) ?? '');
      const value = String(arg(1) ?? '');
      const needle = String(arg(2) ?? '');
      if (separator === '') return -1;
      return (value === '' ? [] : value.split(separator)).findIndex((item) => item === needle);
    }
    case 'item-present': {
      const separator = String(arg(0) ?? '');
      const value = String(arg(1) ?? '');
      const needle = String(arg(2) ?? '');
      if (separator === '') return false;
      return (value === '' ? [] : value.split(separator)).some((item) => item === needle);
    }
    case 'de-duplicate': {
      const separator = String(arg(0) ?? '');
      const value = String(arg(1) ?? '');
      if (separator === '' || value === '') return value;
      return [...new Set(value.split(separator))].join(separator);
    }
    case 'rank-value': {
      const target = toNumber(arg(0));
      const values = list(1).map(toNumber).filter((value) => !Number.isNaN(value)).sort((a, b) => b - a);
      const rank = values.indexOf(target);
      return rank < 0 ? null : rank + 1;
    }
    case 'short-geopoint': {
      const point = arg(0);
      const parts = Array.isArray(point) ? point.map(String) : String(point ?? '').split(/[ ,]+/).filter(Boolean);
      return parts.length >= 2 ? `${parts[1]} ${parts[0]}` : null;
    }
    default: throw new ExpressionError(`Unknown function ${name}()`);
  }
}

/** Parse + evaluate in one step. Throws ExpressionError on bad syntax. */
export function runExpression(source: string, ctx: EvalContext = {}): unknown {
  return evaluate(parse(source), ctx);
}

/** All question names referenced by `${name}` in an expression. */
/** Bare identifiers in an expression - choice-attribute names in a `choice_filter`. */
export function collectBareNames(expr: Expr): string[] {
  const out = new Set<string>();
  const walk = (e: Expr): void => {
    switch (e.kind) {
      case 'bare': out.add(e.name); return;
      case 'unary': walk(e.operand); return;
      case 'binary': walk(e.left); walk(e.right); return;
      case 'call': e.args.forEach(walk); return;
      default: return;
    }
  };
  walk(expr);
  return [...out];
}

export function collectRefs(expr: Expr): string[] {
  const out = new Set<string>();
  const walk = (e: Expr): void => {
    switch (e.kind) {
      case 'ref': out.add(e.name); return;
      case 'unary': walk(e.operand); return;
      case 'binary': walk(e.left); walk(e.right); return;
      case 'call': e.args.forEach(walk); return;
      default: return;
    }
  };
  walk(expr);
  return [...out];
}
