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
  | 'or' | 'and' | '=' | '!=' | '<' | '<=' | '>' | '>=' | '+' | '-' | '*' | '/' | '%';

export interface EvalContext {
  /** Answer values keyed by question name. */
  answers?: Record<string, unknown>;
  /** Embedded data / respondent variables. */
  variables?: Record<string, unknown>;
  /** The value being validated, bound to `.` inside a constraint. */
  current?: unknown;
  /**
   * Attributes of the choice currently being filtered, bound to bare names.
   * XLSForm's `choice_filter` is written `province = ${province}`: the bare name is a
   * column on the `choices` sheet, the `${…}` is an answered question. This is the only
   * place a bare identifier is meaningful, and `validateForm` enforces that.
   */
  attributes?: Record<string, unknown>;
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
    // `count-selected(...)` lexes as `count - selected`.
    const hyphenated = /^(count-selected)(?=\s*\()/.exec(input.slice(i));
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
      if (low === 'and' || low === 'or' || low === 'not') tokens.push({ t: 'op', v: low });
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
          // clear error — during authoring, not mid-interview.
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
        default: throw new ExpressionError(`Unsupported operator ${expr.op}`);
      }
    }
    case 'call': return callFunction(expr.name, expr.args, ctx);
    default: throw new ExpressionError('Unsupported expression');
  }
}

function callFunction(name: string, args: Expr[], ctx: EvalContext): unknown {
  const arg = (n: number): unknown => (args[n] ? evaluate(args[n]!, ctx) : null);

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
    case 'length': return String(arg(0) ?? '').length;
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
      const list = asList(arg(0));
      const needle = arg(1);
      return list.some((v) => looseEquals(v, needle));
    }
    case 'count-selected': {
      requireArgs(name, args, 1);
      return asList(arg(0)).length;
    }
    case 'today': { const d = new Date(); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`; }
    case 'now': return new Date().toISOString();
    default: throw new ExpressionError(`Unknown function ${name}()`);
  }
}

/** Parse + evaluate in one step. Throws ExpressionError on bad syntax. */
export function runExpression(source: string, ctx: EvalContext = {}): unknown {
  return evaluate(parse(source), ctx);
}

/** All question names referenced by `${name}` in an expression. */
/** Bare identifiers in an expression — choice-attribute names in a `choice_filter`. */
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
