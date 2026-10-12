import { ExpressionError, collectBareNames, collectRefs, parse } from './expression.js';
import { DISPLAY_TYPES, MULTI_TYPES, type FormDefinition, type Question } from './types.js';

export interface ValidationReport {
  errors: string[];
  warnings: string[];
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function expressionSources(q: Question): Array<[string, string]> {
  const out: Array<[string, string | null | undefined]> = [
    ['visibleIf', q.rules?.visibleIf],
    ['enableIf', q.rules?.enableIf],
    ['calculate', q.rules?.calculate],
    ['choiceFilter', q.rules?.choiceFilter],
    ['constraint', q.validation?.constraint],
    ['required', typeof q.required === 'string' ? q.required : null],
  ];
  return out.filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].length > 0);
}

/**
 * Static analysis run before publish. Kobo's published troubleshooting list is
 * the canonical set of authoring failures; we fail the *publish* rather than
 * fail the respondent mid-interview.
 */
export function validateForm(def: FormDefinition): ValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!def.title || def.title.trim() === '') errors.push('Form has no title');

  const names = new Set<string>();
  const groupIds = new Set(def.groups.map((g) => g.id));

  for (const q of def.questions) {
    if (!q.name || !NAME_RE.test(q.name)) {
      errors.push(`Question ${q.id}: name "${q.name}" must start with a letter or underscore and contain only letters, digits and underscores`);
    }
    if (names.has(q.name)) errors.push(`Duplicate question name "${q.name}" — export columns would collide`);
    names.add(q.name);
    if (q.groupId && !groupIds.has(q.groupId)) {
      errors.push(`Question "${q.name}" references unknown group "${q.groupId}"`);
    }
    if (!q.label || Object.keys(q.label).length === 0) warnings.push(`Question "${q.name}" has no label`);
    if (DISPLAY_TYPES.has(q.type) && q.required) {
      errors.push(`Question "${q.name}" is a note and cannot be required`);
    }
    if ((q.type === 'select_one' || q.type === 'select_multiple' || q.type === 'rank')) {
      const inline = q.choices?.inline;
      const listName = q.choices?.listName;
      if (!inline && !listName) errors.push(`Question "${q.name}" is a ${q.type} but has no choices`);
      if (listName && !(listName in def.choiceLists)) {
        errors.push(`Question "${q.name}" references undefined choice list "${listName}"`);
      }
    }
    if (q.rules?.calculate && MULTI_TYPES.has(q.type)) {
      warnings.push(`Question "${q.name}" is a multi-select with a calculation — rare and easy to get wrong`);
    }
  }

  const variableNames = new Set((def.variables ?? []).map((v) => v.name));
  for (const q of def.questions) {
    for (const [field, src] of expressionSources(q)) {
      let refs: string[];
      let bareNames: string[];
      try {
        const ast = parse(src);
        refs = collectRefs(ast);
        bareNames = collectBareNames(ast);
      } catch (err) {
        errors.push(`Question "${q.name}" ${field}: ${(err as ExpressionError).message}`);
        continue;
      }

      // A bare name is a choice attribute column, which only exists inside a
      // choice_filter. Anywhere else it is a typo, and we say so at publish time.
      if (field === 'choiceFilter') {
        const list = q.choices?.listName ? def.choiceLists[q.choices.listName] : q.choices?.inline;
        const declared = new Set((list ?? []).flatMap((c) => Object.keys(c.extra ?? {})));
        if (list && list.length > 0) {
          for (const bare of bareNames) {
            if (!declared.has(bare)) {
              warnings.push(
                `Question "${q.name}" choiceFilter uses "${bare}", which is not an attribute column on ${q.choices?.listName ? `list "${q.choices.listName}"` : 'its choices'} — every option will be filtered out`,
              );
            }
          }
        }
      } else {
        for (const bare of bareNames) {
          errors.push(`Question "${q.name}" ${field}: unknown bare name "${bare}" — did you mean \${${bare}}?`);
        }
      }
      for (const ref of refs) {
        if (!names.has(ref) && !variableNames.has(ref)) {
          errors.push(`Question "${q.name}" ${field}: references unknown question or variable "\${${ref}}"`);
        }
      }
      // A question must not depend on itself.
      if (refs.includes(q.name)) errors.push(`Question "${q.name}" ${field}: refers to itself`);
    }
  }

  for (const g of def.groups) {
    if (g.rules?.visibleIf) {
      try {
        for (const ref of collectRefs(parse(g.rules.visibleIf))) {
          if (!names.has(ref) && !variableNames.has(ref)) {
            errors.push(`Group "${g.name}" visibleIf references unknown "\${${ref}}"`);
          }
        }
      } catch (err) {
        errors.push(`Group "${g.name}" visibleIf: ${(err as ExpressionError).message}`);
      }
    }
  }

  for (const [listName, choices] of Object.entries(def.choiceLists)) {
    const seen = new Set<string>();
    for (const c of choices) {
      if (seen.has(c.value)) errors.push(`Choice list "${listName}" has duplicate value "${c.value}"`);
      seen.add(c.value);
    }
  }

  return { errors, warnings };
}

/** True when the form is safe to publish. */
export function isPublishable(def: FormDefinition): boolean {
  return validateForm(def).errors.length === 0;
}
