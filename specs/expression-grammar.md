# Expression Grammar & Function Reference

The logic engine evaluates expressions for `condition` (relevance), `constraint`,
`calculation`, `default`, and `choice_filter`. Same grammar runs on device (UX) and
server (authoritative). Server re-validates every device claim.

## 1. Grammar (EBNF)

    expression   = or_expr ;
    or_expr      = and_expr { ("or" | "||") and_expr } ;
    and_expr     = not_expr { ("and" | "&&") not_expr } ;
    not_expr     = [ "not" | "!" ] comparison ;
    comparison   = additive { ("=" | "!=" | ">" | ">=" | "<" | "<=") additive } ;
    additive     = multiplicative { ("+" | "-") multiplicative } ;
    multiplicative = unary { ("*" | "div" | "mod") unary } ;
    unary        = [ "-" | "+" ] primary ;
    primary      = number | string | boolean | var_ref | func_call | "(" expression ")" ;
    var_ref      = "${" identifier "}" | "." ;
    func_call    = identifier "(" [ expression { "," expression } ] ")" ;
    identifier   = letter { letter | digit | "_" } ;
    number       = digit { digit } [ "." digit { digit } ] ;
    string       = "'" { any-char } "'" | '"' { any-char } '"' ;
    boolean      = "true()" | "false()" ;

## 2. Semantics (normative)

1. `condition` false → question hidden AND its answer set to NULL in DB.
2. `constraint` false → block advance; show `constraintMessage`.
3. `calculation` recomputes whenever any referenced value changes; `trigger` forces it.
4. Empty value = empty string, NEVER auto-zero. Use `coalesce(x, 0)` to coerce.
5. Relational operators (`> >= < <=`) operate on numbers only.
6. Comparison of mixed types: numeric if both parse as numbers, else string compare.
7. Division by zero → NaN (rendered blank). Guard with `if()`.
8. Evaluation order is operator precedence: unary > mult > add > compare > and > or.
9. `selected(${multi}, 'x')` true if 'x' among selected choices.
10. Cascading: if any referenced variable is irrelevant, dependent expression is false
    UNLESS the reference is wrapped in `coalesce()`/`if()`.

## 3. Operators

| Group | Operators |
|---|---|
| Math | `+ - * div mod` |
| Comparison | `= != > >= < <=` |
| Boolean | `and && or \|\| not !` |
| Path | `.` (current), `..` (parent) |

## 4. Functions (v1 set)

| Category | Functions |
|---|---|
| Control | `if(test,then[,else])`, `once(expr)` |
| Select | `selected(arr,s)`, `selected-at(arr,n)`, `count-selected(q)`, `jr:choice-name(c,'q')` |
| Repeat/agg | `count(ns)`, `count-non-empty(ns)`, `sum(ns)`, `min(ns)`, `max(ns)`, `indexed-repeat(...)` |
| String | `concat(...)`, `join(sep,ns)`, `substr(s,a[,b])`, `contains(s,sub)`, `starts-with(s,sub)`, `ends-with(s,sub)`, `regex(s,re)`, `translate(s,f,t)`, `string-length(s)`, `normalize-space(s)`, `string(x)`, `number(x)` |
| Math | `round(n,p)`, `int(n)`, `abs(n)`, `pow(b,e)`, `sqrt(n)`, `log(n)`, `log10(n)`, `pi()` |
| Date | `today()`, `now()`, `format-date(d,f)`, `format-date-time(d,f)`, `decimal-date-time(d)`, `date(n)` |
| Geo | `distance(a[,b...])`, `geofence(pt,shape)`, `area(shape)`, `intersects(trace)` |
| Utility | `uuid()`, `random()`, `randomize(ns)`, `coalesce(a,b)`, `boolean(x)`, `not(x)`, `true()`, `false()`, `checklist(min,max,...)` |

## 5. Errors

| Error | Behavior |
|---|---|
| Undefined variable | Compile error with line ref; question flagged |
| Unknown function | Compile error |
| Arity mismatch | Compile error |
| Type mismatch in `>`/`<` | Runtime → NaN → blank |
| Unbalanced parens | Compile error |

## 6. Security

- No `eval`. Parser produces an AST; AST evaluated by a pure function.
- No side effects except via `calculation` writing to its own question.
- Regex uses a bounded engine (ReDoS-safe) with a length cap.

## 7. Examples

    ${b6} == 'yes'                                  -- relevance
    . >= 0 and . <= 100                             -- constraint
    round(${b3} / 12, 2)                            -- calculation
    coalesce(${b7}, 0)                              -- null-safe
    selected(${c6}, 'sports')                       -- multi-select test
    if(${c1} >= 90, 'A', if(${c1} >= 75, 'B', 'C')) -- nested
