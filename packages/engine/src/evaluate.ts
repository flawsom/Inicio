import { ExpressionError, collectRefs, evaluate, parse, runExpression, truthy } from './expression.js';
import { DISPLAY_TYPES, MULTI_TYPES, type AnswerMap, type Choice, type FormDefinition, type Question } from './types.js';

export interface QuestionState {
  name: string;
  visible: boolean;
  enabled: boolean;
  required: boolean;
  /** Effective value: null when hidden or when a calculate() owns the question. */
  value: unknown;
  computed: boolean;
  error: string | null;
}

export interface FormEvaluation {
  states: Record<string, QuestionState>;
  visibleNames: string[];
  /** Names of visible questions that block submission. */
  missing: string[];
  invalid: string[];
}

export interface EvaluateOptions {
  variables?: Record<string, unknown>;
  /** A snapshot of the datasets attached to this form version. */
  datasets?: import('./datasets.js').DatasetContext;
  /** Optional override for `choice-label()`, mostly useful in tests. */
  choiceLabels?: Record<string, Record<string, string>>;
  /**
   * Per-response values already computed by a top-level `once()` calculation.
   * The caller seeds this from stored answers and keeps the map across saves, so
   * `once(random())` is drawn once rather than on every evaluation.
   */
  onceValues?: Record<string, unknown>;
}

/** Build the static label map `choice-label()` reads, once per evaluation. */
function choiceLabelsFor(def: FormDefinition): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const question of def.questions) {
    const list = question.choices?.listName
      ? def.choiceLists[question.choices.listName]
      : question.choices?.inline;
    if (!list) continue;
    const labels: Record<string, string> = {};
    for (const choice of list) {
      labels[choice.value] = choice.label?.[def.defaultLanguage] ?? Object.values(choice.label ?? {})[0] ?? choice.value;
    }
    out[question.name] = labels;
  }
  return out;
}

function safeEval(source: string, ctx: Parameters<typeof evaluate>[1], fallback: unknown): unknown {
  try {
    return runExpression(source, ctx);
  } catch (err) {
    if (err instanceof ExpressionError) return fallback;
    throw err;
  }
}

/** The expression inside a top-level `once(...)`, or null for any other source. */
function onceExpression(source: string): import('./expression.js').Expr | null {
  try {
    const parsed = parse(source);
    return parsed.kind === 'call' && parsed.name === 'once' && parsed.args.length === 1
      ? parsed.args[0]!
      : null;
  } catch {
    return null;
  }
}

/**
 * Evaluates a whole form against a set of answers.
 *
 * Semantics follow XLSForm deliberately, because imported forms rely on them:
 *  - a question whose visibleIf is false is hidden AND its answer is treated as null
 *  - a hidden GROUP hides everything inside it
 *  - constraint is only evaluated for a non-blank answer; blank rejection is `required`'s job
 *  - empty numeric answers are not zero
 *  - calculations are re-evaluated until stable, so one can depend on another
 */
export function evaluateForm(
  def: FormDefinition,
  answers: AnswerMap = {},
  options: EvaluateOptions = {},
): FormEvaluation {
  const hiddenGroups = new Set<string>();
  const effective: Record<string, unknown> = { ...answers };
  const choiceLabels = options.choiceLabels ?? choiceLabelsFor(def);

  const ctx = (current?: unknown) => ({
    answers: effective,
    variables: options.variables,
    datasets: options.datasets,
    choiceLabels,
    current,
  });

  // Resolve calculations and visibility together, to a fixed point.
  const maxPasses = Math.min(def.questions.length + 2, 12);
  for (let pass = 0; pass < maxPasses; pass += 1) {
    let changed = false;

    for (const group of def.groups) {
      const src = group.rules?.visibleIf;
      const visible = src ? truthy(safeEval(src, ctx(), true)) : true;
      const isHidden = hiddenGroups.has(group.id);
      if (!visible && !isHidden) { hiddenGroups.add(group.id); changed = true; }
      if (visible && isHidden) { hiddenGroups.delete(group.id); changed = true; }
    }

    for (const q of def.questions) {
      const groupHidden = Boolean(q.groupId && hiddenGroups.has(q.groupId));
      const visibleSrc = q.rules?.visibleIf;
      const visible = !groupHidden && (visibleSrc ? truthy(safeEval(visibleSrc, ctx(), true)) : true);

      if (!visible) {
        if (effective[q.name] !== null) { effective[q.name] = null; changed = true; }
        continue;
      }

      const calcSrc = q.rules?.calculate;
      if (calcSrc) {
        const once = onceExpression(calcSrc);
        const stored = options.onceValues && Object.prototype.hasOwnProperty.call(options.onceValues, q.name)
          ? options.onceValues[q.name]
          : undefined;
        const next = once
          ? options.onceValues
            ? stored !== undefined
              ? stored
              : (options.onceValues[q.name] = evaluate(once, ctx()))
            : evaluate(once, ctx())
          : safeEval(calcSrc, ctx(), null);
        if (JSON.stringify(next) !== JSON.stringify(effective[q.name])) {
          effective[q.name] = next;
          changed = true;
        }
      }
    }
    if (!changed && pass > 0) break;
  }

  // Final pass: derive the reported state from the settled values.
  const states: Record<string, QuestionState> = {};
  const visibleNames: string[] = [];

  for (const q of def.questions) {
    const groupHidden = Boolean(q.groupId && hiddenGroups.has(q.groupId));
    const visibleSrc = q.rules?.visibleIf;
    const visible = !groupHidden && (visibleSrc ? truthy(safeEval(visibleSrc, ctx(), true)) : true);

    const enableSrc = q.rules?.enableIf;
    const enabled = visible && (enableSrc ? truthy(safeEval(enableSrc, ctx(), true)) : true);

    let required = false;
    if (visible && !DISPLAY_TYPES.has(q.type)) {
      if (typeof q.required === 'string') required = truthy(safeEval(q.required, ctx(), false));
      else required = Boolean(q.required);
    }

    const value = visible ? effective[q.name] : null;
    let error: string | null = null;

    if (visible && q.validation?.constraint) {
      const blank = value === null || value === undefined || value === '' ||
        (MULTI_TYPES.has(q.type) && Array.isArray(value) && value.length === 0);
      // A constraint never rejects a blank answer.
      if (!blank) {
        let ok: unknown = true;
        try {
          ok = evaluate(parse(q.validation.constraint), ctx(value));
        } catch {
          ok = false;
        }
        if (!truthy(ok)) error = q.validation.message?.[def.defaultLanguage] ?? 'Invalid value';
      } else if (required) {
        error = q.requiredMessage?.[def.defaultLanguage] ?? 'This question is required';
      }
    } else if (visible && required) {
      const blank = value === null || value === undefined || value === '' ||
        (MULTI_TYPES.has(q.type) && Array.isArray(value) && value.length === 0);
      if (blank) error = q.requiredMessage?.[def.defaultLanguage] ?? 'This question is required';
    }

    states[q.name] = { name: q.name, visible, enabled, required, value, computed: Boolean(q.rules?.calculate), error };
    if (visible) visibleNames.push(q.name);
  }

  const missing = visibleNames.filter((n) => {
    const s = states[n]!;
    return s.required && (s.value === null || s.value === undefined || s.value === '' ||
      (Array.isArray(s.value) && s.value.length === 0));
  });
  const invalid = visibleNames.filter((n) => states[n]!.error !== null);

  return { states, visibleNames, missing, invalid };
}

/** The value the platform should persist for a question after evaluation. */
export function effectiveValue(state: QuestionState | undefined): unknown {
  if (!state || !state.visible) return null;
  return state.value ?? null;
}

/** Question names an expression depends on, for dependency ordering in the builder. */
export function dependencies(question: Question): string[] {
  const sources = [
    question.rules?.visibleIf, question.rules?.enableIf,
    question.rules?.calculate, question.rules?.choiceFilter,
    question.validation?.constraint,
    typeof question.required === 'string' ? question.required : null,
  ].filter((v): v is string => typeof v === 'string' && v.length > 0);

  const out = new Set<string>();
  for (const src of sources) {
    try { collectRefs(parse(src)).forEach((r) => out.add(r)); } catch { /* reported by validate() */ }
  }
  return [...out];
}

/**
 * The full `search(...)` call inside an appearance string, parentheses balanced.
 * `quick search('people')` is legal, so the whole appearance cannot be parsed as
 * an expression. This extracts the call and leaves the visual styles alone.
 */
function dynamicSearchSource(question: Question): string | null {
  const appearance = question.appearance ?? '';
  const start = appearance.search(/\bsearch\s*\(/);
  if (start < 0) return null;
  const open = appearance.indexOf('(', start);
  let depth = 0;
  for (let i = open; i < appearance.length; i += 1) {
    if (appearance[i] === '(') depth += 1;
    else if (appearance[i] === ')') {
      depth -= 1;
      if (depth === 0) return appearance.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * The options a respondent may actually pick, after applying `choice_filter`
 * (XLSForm cascading selects: `state = ${state}`, where the bare name is a column on
 * the choices sheet) or a dynamic `search()` over an attached dataset.
 *
 * On a malformed filter we show *all* options rather than none: a collection tool that
 * silently hides every choice is worse than one that shows too many.
 */
export function filterChoices(
  def: FormDefinition,
  q: Question,
  answers: AnswerMap = {},
  options: EvaluateOptions = {},
): Choice[] {
  const list = q.choices?.listName ? def.choiceLists[q.choices.listName] : q.choices?.inline;
  if (!list) return [];

  const evaluated = evaluateForm(def, answers, options);
  const effective: Record<string, unknown> = {};
  for (const [name, state] of Object.entries(evaluated.states)) effective[name] = state.value;

  const searchSource = dynamicSearchSource(q);
  if (searchSource) {
    const prompt = list[0];
    const labelColumns = String(
      prompt?.label?.[def.defaultLanguage] ?? Object.values(prompt?.label ?? {})[0] ?? '',
    )
      .split(',')
      .map((column) => column.trim())
      .filter(Boolean);
    const imageColumns = String(prompt?.extra?.['image'] ?? '').trim();
    const rows = safeEval(
      searchSource,
      {
        answers: effective,
        variables: options.variables,
        datasets: options.datasets,
        dynamicChoice: {
          valueColumn: prompt?.value ?? '',
          labelColumns,
          imageColumn: imageColumns || null,
        },
      },
      [],
    );
    if (Array.isArray(rows)) {
      const dynamic: Choice[] = rows.map((row) => {
        const source = row as { value?: unknown; label?: unknown; image?: unknown };
        return {
          value: String(source.value ?? ''),
          label: { [def.defaultLanguage]: String(source.label ?? source.value ?? '') },
          ...(source.image ? { image: String(source.image) } : {}),
        };
      });
      const staticChoices = list.filter((choice) => /^\d+$/.test(choice.value));
      return [...dynamic, ...staticChoices];
    }
  }

  const source = q.rules?.choiceFilter;
  if (!source) return list;

  return list.filter((choice) =>
    truthy(
      safeEval(
        source,
        {
          answers: effective,
          variables: options.variables,
          datasets: options.datasets,
          attributes: choice.extra ?? {},
        },
        true,
      ),
    ),
  );
}
