/**
 * A small TMDL parser and schema checker.
 *
 * Why this exists: the validator used to inspect TMDL with regular expressions, so it
 * checked *content* (measure names, DAX bodies) but not *grammar*. Power BI Desktop
 * twice rejected a package that passed those checks - an indented `ref table` and a
 * flush-left DAX continuation line - because in TMDL **indentation is parentage**.
 * A regex cannot see that; a parser can.
 *
 * Scope: the subset of TMDL this project emits and reads (model, tables, columns,
 * measures, partitions, relationships, cultures, annotations, refs). It is deliberately
 * strict: an unknown object type or property is a finding, because Desktop treats it as
 * a load failure rather than a warning.
 *
 * `parseTmdl` builds a tree where every node records the line it started on, its
 * properties, its expression (for objects declared with `=`) and its doc comment.
 * `validateTmdlTree` checks the tree against the schema below.
 */

/** Object types that may appear as a declaration (a line that starts an object). */
export const OBJECT_TYPES = new Set([
  'model', 'database', 'table', 'relationship', 'cultureInfo', 'expression',
  'perspective', 'role', 'function', 'dataSource', 'ref',
  'column', 'measure', 'partition', 'hierarchy', 'level', 'kpi', 'variation',
  'annotation', 'dataAccessOptions', 'calculationGroup', 'calculationItem',
]);

/** Properties that are booleans written as a bare keyword (`isHidden`). */
export const FLAG_PROPERTIES = new Set([
  'isHidden', 'isKey', 'isUnique', 'isNullable', 'isActive', 'isDefault',
  'isDefaultLabel', 'isDefaultImage', 'isPrivate', 'isLogical', 'isNameInferred',
  'isDataTypeInferred', 'relyOnReferentialIntegrity', 'legacyRedirects',
  'returnErrorValuesAsNull', 'discourageImplicitMeasures', 'isHiddenInView',
  'showAsVariationsOnly', 'keepUniqueRows', 'isSimpleMeasure',
]);

/** Legal child object types per parent. */
export const CHILDREN = {
  // Root-level `annotation` and `ref` in model.tmdl are implicitly model children: that
  // is why `ref table X` sits at column 0 yet still belongs to the model.
  document: new Set(['model', 'database', 'table', 'relationship', 'cultureInfo', 'expression', 'perspective', 'role', 'function', 'dataSource', 'annotation', 'ref']),
  model: new Set(['table', 'relationship', 'cultureInfo', 'expression', 'perspective', 'role', 'function', 'dataSource', 'annotation', 'ref', 'dataAccessOptions']),
  database: new Set(['annotation']),
  table: new Set(['column', 'measure', 'partition', 'hierarchy', 'annotation', 'calculationGroup']),
  column: new Set(['annotation']),
  measure: new Set(['annotation', 'kpi']),
  partition: new Set(['annotation']),
  hierarchy: new Set(['level', 'annotation']),
  level: new Set(['annotation']),
  kpi: new Set(['annotation']),
  calculationGroup: new Set(['calculationItem', 'annotation']),
  calculationItem: new Set(['annotation']),
  relationship: new Set(['annotation']),
  annotation: new Set([]),
  ref: new Set([]),
  cultureInfo: new Set(['linguisticMetadata']),
  dataAccessOptions: new Set([]),
  expression: new Set(['annotation']),
  role: new Set(['annotation', 'tablePermission']),
  tablePermission: new Set(['annotation']),
  function: new Set(['annotation']),
  dataSource: new Set(['annotation']),
  variation: new Set(['annotation']),
  perspective: new Set(['annotation']),
};

/**
 * Properties each object type accepts. `annotation` is handled separately (it is an
 * object with a name and an expression, not a property).
 */
export const PROPERTIES = {
  document: new Set([]),
  model: new Set(['culture', 'defaultPowerBIDataSourceVersion', 'sourceQueryCulture', 'discourageImplicitMeasures', 'dataAccessOptions']),
  database: new Set(['id', 'compatibilityLevel', 'compatibilityMode', 'language', 'name']),
  table: new Set(['lineageTag', 'dataCategory', 'isHidden', 'defaultDetailRowsDefinition', 'calculationGroup']),
  column: new Set([
    'dataType', 'datatype', 'formatString', 'summarizeBy', 'sourceColumn', 'sortByColumn',
    'isHidden', 'isKey', 'isUnique', 'isNullable', 'displayFolder', 'lineageTag',
    'dataCategory', 'encodingHint', 'expressionSource', 'isDefaultLabel', 'isDefaultImage',
    'isNameInferred', 'isDataTypeInferred', 'isLogical', 'summarizeByColumn',
  ]),
  measure: new Set([
    'formatString', 'displayFolder', 'isHidden', 'lineageTag', 'dataType', 'encodingHint',
    'expressionSource', 'isSimpleMeasure', 'detailRowsDefinition', 'formatStringDefinition',
  ]),
  partition: new Set(['mode', 'source', 'queryGroup', 'dataView']),
  relationship: new Set([
    'fromColumn', 'toColumn', 'fromCardinality', 'toCardinality', 'crossFilteringBehavior',
    'securityFilteringBehavior', 'isActive', 'joinOnDateBehavior', 'relyOnReferentialIntegrity',
    'fromName', 'toName',
  ]),
  hierarchy: new Set(['lineageTag', 'isHidden', 'displayFolder', 'dataCategory']),
  level: new Set(['ordinal', 'lineageTag', 'column']),
  kpi: new Set(['targetExpression', 'statusExpression', 'trendExpression', 'statusGraphic']),
  calculationGroup: new Set(['precedence', 'lineageTag']),
  calculationItem: new Set(['expression', 'formatString', 'ordinal', 'lineageTag']),
  annotation: new Set([]),
  ref: new Set([]),
  cultureInfo: new Set(['linguisticMetadata']),
  dataAccessOptions: new Set(['legacyRedirects', 'returnErrorValuesAsNull', 'fastCombine']),
  expression: new Set(['kind', 'lineageTag', 'isHidden']),
  role: new Set(['modelPermission', 'lineageTag']),
  tablePermission: new Set(['filterExpression', 'lineageTag']),
  function: new Set(['lineageTag', 'isHidden']),
  dataSource: new Set(['type', 'lineageTag']),
  variation: new Set(['relationship', 'defaultHierarchy', 'isDefault']),
  perspective: new Set([]),
};

const QUOTED = /^'(?:[^']|'')*'/;

function indentOf(line) {
  let n = 0;
  for (const ch of line) {
    if (ch === '\t' || ch === ' ') n += 1;
    else break;
  }
  return n;
}

function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replace(/''/g, "'");
  return trimmed;
}

/** Split `type name = expression` while respecting quoted names. */
function declaration(content) {
  const head = content.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
  if (!head) return null;
  const type = head[1];
  let rest = content.slice(type.length).trimStart();
  let name = '';
  if (rest.startsWith("'")) {
    const q = rest.match(QUOTED);
    name = unquote(q[0]);
    rest = rest.slice(q[0].length).trimStart();
  } else if (rest && !rest.startsWith('=')) {
    const token = rest.match(/^[^\s=]+/);
    name = token ? token[0] : '';
    rest = rest.slice(token ? token[0].length : 0).trimStart();
  }
  let expression = null;
  let inline = false;
  if (rest.startsWith('=')) {
    const body = rest.slice(1);
    expression = body.trim();
    inline = expression !== '';
  }
  return { type, name, expression, inline, hadEquals: rest.startsWith('=') };
}

/**
 * Collect the indented block below line `i` - the value of a property or object whose
 * declaration ended with `=`. Text is dedented by the block's own first line so relative
 * indentation inside M/DAX survives, and trailing blank lines are dropped.
 */
function captureBody(lines, i, indent, { limit = indent } = {}) {
  const body = [];
  let base = null;
  let j = i + 1;
  while (j < lines.length) {
    const next = lines[j];
    if (next.trim() === '') { body.push(''); j += 1; continue; }
    const nextIndent = indentOf(next);
    if (nextIndent <= limit) break;
    if (base === null) base = nextIndent;
    body.push(next.slice(Math.min(nextIndent, base)));
    j += 1;
  }
  while (body.length && body[body.length - 1] === '') body.pop();
  return { text: body.join('\n'), lastIndex: j - 1 };
}

/** Index of the last line belonging to the block under line `i`. */
function skipBody(lines, i, indent, options) {
  return captureBody(lines, i, indent, options).lastIndex;
}

/**
 * Parse TMDL text into a tree.
 * @returns {{ tree: object, errors: Array<{line:number,message:string}> }}
 */
export function parseTmdl(text, { file = 'tmdl' } = {}) {
  const lines = String(text).replace(/^\uFEFF/, '').split('\n').map((l) => l.replace(/\r$/, ''));
  const root = { type: 'document', name: file, line: 0, indent: -1, props: new Map(), children: [], expression: null, doc: [] };
  const stack = [root];
  const errors = [];
  let doc = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const indent = indentOf(line);
    const content = line.slice(indent);
    if (content.startsWith('///')) { doc.push(content.slice(3).trim()); continue; }

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1];

    const property = content.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (property) {
      let value = property[2];
      if (value.trim() === '') value = captureBody(lines, i, indent).text;
      parent.props.set(property[1], value);
      i = skipBody(lines, i, indent);
      continue;
    }

    // Property written as `key = value` or `key =` plus an indented block - the shape
    // partitions use (`source = #table(...)` or `source =` then M). A two-token
    // declaration such as `partition Orders = m` does not match, because the `=` does not
    // follow the first token directly.
    const equalsProperty = content.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (equalsProperty && !OBJECT_TYPES.has(equalsProperty[1])) {
      const [, key, inlineValue] = equalsProperty;
      if (inlineValue.trim() !== '') parent.props.set(key, inlineValue.trim());
      else {
        parent.props.set(key, captureBody(lines, i, indent).text);
        i = skipBody(lines, i, indent);
      }
      continue;
    }

    const flag = content.match(/^([A-Za-z_][A-Za-z0-9_]*)$/);
    if (flag && FLAG_PROPERTIES.has(flag[1])) {
      parent.props.set(flag[1], true);
      continue;
    }

    const decl = declaration(content);
    if (!decl || !OBJECT_TYPES.has(decl.type)) {
      errors.push({ line: i + 1, message: `unknown object type "${(decl?.type ?? content.split(/\s/)[0])}"` });
      continue;
    }

    // `ref table X` / `ref cultureInfo en-US`: the second token is the kind.
    let { name } = decl;
    let refKind = null;
    if (decl.type === 'ref') {
      const [kind, ...rest] = `${decl.name} ${content.split(/\s+/).slice(2).join(' ')}`.trim().split(/\s+/);
      refKind = kind;
      name = unquote(rest.join(' '));
    }

    const node = {
      type: decl.type,
      name,
      refKind,
      line: i + 1,
      indent,
      props: new Map(),
      children: [],
      expression: decl.expression,
      declaredWithEquals: decl.hadEquals,
      doc,
    };
    doc = [];

    // A declaration ending in `=` continues on the following, deeper-indented lines.
    // Anything at the same or a shallower indent is a sibling, not part of the value.
    // An object's expression sits one level below the object's *properties*, so the block
    // only owns lines deeper than indent + 1. A line at property depth ends it - which is
    // how a flush-left or property-level expression becomes a finding instead of silently
    // absorbing `formatString:` into the DAX.
    if (decl.hadEquals && decl.expression === '') {
      const body = captureBody(lines, i, indent, { limit: indent + 1 });
      node.expression = body.text === '' ? null : body.text;
      node.expressionIndentDelta = body.text === '' ? null : 1;
      i = body.lastIndex;
    }

    parent.children.push(node);
    stack.push(node);
  }

  return { tree: root, errors };
}

/**
 * Check a parsed tree against the schema. Findings are load failures in Desktop, so
 * every one of them matters.
 */
export function validateTmdlTree(tree, { file = 'tmdl' } = {}) {
  const findings = [];
  const label = file;

  for (const node of walkTree(tree)) {
    const allowedChildren = CHILDREN[node.type];
    const allowedProps = PROPERTIES[node.type];
    if (!allowedChildren) {
      findings.push({ line: node.line, message: `${label}: unsupported object type ${node.type}` });
      continue;
    }
    if (!allowedProps) {
      findings.push({ line: node.line, message: `${label}: no property schema for ${node.type}` });
      continue;
    }
    const parent = node.parent;
    if (parent) {
      const parentAllowed = CHILDREN[parent.type];
      if (parentAllowed && !parentAllowed.has(node.type)) {
        findings.push({ line: node.line, message: `${label}: ${node.type} is not allowed inside ${parent.type}` });
      }
    }
    for (const child of node.children) {
      if (!allowedChildren.has(child.type)) {
        findings.push({ line: child.line, message: `${label}: ${child.type} is not allowed inside ${node.type}` });
      }
    }
    // `ref` is a *root* statement in model.tmdl (implicitly a model child). Indented under
    // model it becomes a ReferenceObject where the parser allows none - the first real
    // Desktop failure this project hit.
    if (node.type === 'ref' && parent && parent.type !== 'document') {
      findings.push({ line: node.line, message: `${label}: ref must be at column 0, not inside ${parent.type} (line ${node.line})` });
    }
    // A /// block above a relationship is parsed as the relationship's description, which
    // SingleColumnRelationship does not allow.
    if (node.type === 'relationship' && node.doc.length) {
      findings.push({ line: node.line, message: `${label}: /// above a relationship is not allowed (line ${node.line})` });
    }
    for (const [key, value] of node.props) {
      const legal = allowedProps.has(key);
      if (!legal) findings.push({ line: node.line, message: `${label}: "${key}" is not a ${node.type} property (line ${node.line})` });
      if (typeof value === 'string' && value.trim() === '' && !['source', 'expression'].includes(key)) {
        findings.push({ line: node.line, message: `${label}: "${key}" has no value` });
      }
    }
    // A declaration that ends in `=` must be followed by an indented expression.
    if (node.declaredWithEquals && !node.expression) {
      findings.push({ line: node.line, message: `${label}: ${node.type} "${node.name}" declares = but has no expression` });
    }
  }
  return findings;
}

function* walkTree(node, parent = null) {
  node.parent = parent;
  yield node;
  for (const child of node.children) yield* walkTree(child, node);
}

/** Convenience: parse then validate. */
export function checkTmdl(text, options = {}) {
  const { tree, errors } = parseTmdl(text, options);
  const findings = errors.map((e) => ({ ...e, message: `${options.file ?? 'tmdl'}: ${e.message} (line ${e.line})` }));
  findings.push(...validateTmdlTree(tree, options));
  return { tree, findings };
}
