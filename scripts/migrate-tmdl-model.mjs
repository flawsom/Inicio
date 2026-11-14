#!/usr/bin/env node
/**
 * Bring an already-emitted semantic model up to the current TMDL grammar.
 *
 * Why this exists: five questionnaire dossiers (bounce, heer, mehak, nand, prism) were
 * generated before the TMDL grammar rules in this repo were understood, so their
 * `model.tmdl` indents `ref table`, which Power BI Desktop rejects with
 * "Unexpected line type: ReferenceObject!". Their source .docx files are not in the
 * repository, so they cannot be re-emitted by scripts/build-powerbi-report.mjs. This
 * script repairs the model *documents* in place - parse, rewrite the model file, add the
 * culture file, fix expression indentation - and leaves tables, columns and DAX alone.
 *
 * It is idempotent and only touches files that need it.
 *
 * Usage:
 *   node scripts/migrate-tmdl-model.mjs reports/power-bi/bounce [more project folders]
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { checkTmdl, parseTmdl } from './powerbi/tmdl-parse.mjs';
import { MEASURE_DOCS } from './powerbi/tmdl.mjs';

const unquote = (name) => name.trim().replace(/^'(.*)'$/, '$1');
/** TMDL requires single quotes around names that are not plain identifiers. */
const quoteName = (name) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`);

function canonicalModel({ props, annotations, refTables, refCultures }) {
  const lines = ['model Model'];
  const ordered = ['culture', 'defaultPowerBIDataSourceVersion', 'sourceQueryCulture'];
  const otherProps = [...props.keys()].filter((k) => !ordered.includes(k));
  for (const key of [...ordered, ...otherProps]) {
    if (!props.has(key)) continue;
    const value = props.get(key);
    lines.push(`\t${key}: ${value}`);
  }
  for (const [name, value] of annotations) {
    lines.push('', `annotation ${name} = ${value}`);
  }
  if (refTables.length) {
    lines.push('');
    lines.push(`annotation PBI_QueryOrder = [${refTables.map((t) => JSON.stringify(unquote(t))).join(',')}]`);
    lines.push('');
    for (const table of refTables) lines.push(`ref table ${quoteName(unquote(table))}`);
  }
  if (refCultures.length) {
    lines.push('');
    for (const culture of refCultures) lines.push(`ref cultureInfo ${culture}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Add the `///` doc line above measures that were emitted without one. */
function addMissingDocs(text) {
  const lines = text.split('\n');
  const out = [];
  let changed = false;
  for (const line of lines) {
    const match = line.match(/^\tmeasure (.+?)(?: =| =$)/);
    if (match) {
      const name = match[1].replace(/^'|'$/g, '');
      const previous = out[out.length - 1] ?? '';
      if (MEASURE_DOCS[name] && !previous.startsWith('\t/// ')) {
        out.push(`\t/// ${MEASURE_DOCS[name]}`);
        changed = true;
      }
    }
    out.push(line);
  }
  return { text: out.join('\n'), changed };
}

/** Re-indent a measure whose expression was emitted flush left or at property depth. */
function fixExpressionIndent(text) {
  const lines = text.split('\n');
  const out = [];
  let changed = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    out.push(line);
    if (!/^\tmeasure .+ =$/.test(line)) continue;
    const headerIndent = 1;
    const desired = headerIndent + 2;
    let j = i + 1;
    const block = [];
    while (j < lines.length) {
      const next = lines[j];
      if (next.trim() === '') break;
      const indent = (next.match(/^[\t ]*/) ?? [''])[0].length;
      if (indent <= headerIndent + 1) break;
      // Is this a property of the measure (`formatString: ...`, `lineageTag: ...`)?
      if (indent === headerIndent + 1 && /^\t\t[A-Za-z_][A-Za-z0-9_]*:/.test(next)) break;
      block.push(next);
      j += 1;
    }
    if (!block.length) continue;
    const currentIndent = (block[0].match(/^[\t ]*/) ?? [''])[0].length;
    if (currentIndent !== desired) {
      for (const bodyLine of block) {
        const stripped = bodyLine.replace(/^[\t ]{0,}/, '');
        const depth = (bodyLine.match(/^[\t ]*/) ?? [''])[0].length - currentIndent;
        out.push(`${'\t'.repeat(desired)}${' '.repeat(Math.max(0, depth))}${stripped}`);
      }
      i = j - 1;
      changed = true;
    }
  }
  return { text: out.join('\n'), changed };
}

function migrate(projectDir) {
  const entries = readdirSync(projectDir, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.endsWith('.SemanticModel'));
  if (!entries.length) return { project: projectDir, changed: [], findings: [{ message: 'no .SemanticModel folder' }] };
  const modelDir = join(projectDir, entries[0].name);
  const defDir = join(modelDir, 'definition');
  const modelPath = join(defDir, 'model.tmdl');
  const changed = [];
  const findings = [];

  if (!existsSync(modelPath)) return { project: projectDir, changed, findings: [{ message: 'no model.tmdl' }] };
  const before = checkTmdl(readFileSync(modelPath, 'utf8'), { file: 'model.tmdl' });
  const refFinding = before.findings.some((f) => /ref must be at column 0/.test(f.message));

  if (refFinding) {
    const { tree } = parseTmdl(readFileSync(modelPath, 'utf8'), { file: 'model.tmdl' });
    const model = tree.children.find((c) => c.type === 'model');
    const props = new Map(model?.props ?? []);
    const annotations = tree.children.filter((c) => c.type === 'annotation').map((c) => [c.name, c.expression ?? '']);
    const refs = [...tree.children, ...(model?.children ?? [])].filter((c) => c.type === 'ref');
    const refTables = refs.filter((r) => r.refKind === 'table').map((r) => r.name);
    let refCultures = refs.filter((r) => r.refKind === 'cultureInfo').map((r) => r.name);
    if (!refCultures.length && existsSync(join(defDir, 'cultures'))) {
      refCultures = readdirSync(join(defDir, 'cultures')).filter((f) => f.endsWith('.tmdl')).map((f) => f.replace(/\.tmdl$/, ''));
    }
    if (!refCultures.length) refCultures = ['en-US'];
    writeFileSync(modelPath, canonicalModel({ props, annotations, refTables, refCultures }), 'utf8');
    changed.push('model.tmdl: refs moved to column 0, annotation + culture ref written');
  }

  // Culture file required by `ref cultureInfo`.
  const cultureDir = join(defDir, 'cultures');
  const culturePath = join(cultureDir, 'en-US.tmdl');
  if (!existsSync(culturePath)) {
    mkdirSync(cultureDir, { recursive: true });
    writeFileSync(culturePath, 'cultureInfo en-US\n', 'utf8');
    changed.push('cultures/en-US.tmdl: added');
  }

  // Table documents: measure expressions must sit one level below the properties.
  const tablesDir = join(defDir, 'tables');
  if (existsSync(tablesDir)) {
    for (const file of readdirSync(tablesDir).filter((f) => f.endsWith('.tmdl'))) {
      const path = join(tablesDir, file);
      const text = readFileSync(path, 'utf8');
      const indented = fixExpressionIndent(text);
      const documented = addMissingDocs(indented.text);
      if (indented.changed || documented.changed) {
        writeFileSync(path, documented.text, 'utf8');
        if (indented.changed) changed.push(`tables/${file}: expression indentation`);
        if (documented.changed) changed.push(`tables/${file}: measure descriptions`);
      }
    }
  }

  // Report what grammar says now.
  const after = checkTmdl(readFileSync(modelPath, 'utf8'), { file: 'model.tmdl' });
  findings.push(...after.findings.map((f) => ({ message: f.message })));
  return { project: projectDir, changed, findings };
}

const targets = process.argv.slice(2).filter((a) => !a.startsWith('-'));
if (!targets.length) {
  console.error('usage: node scripts/migrate-tmdl-model.mjs <projectDir> [projectDir...]');
  process.exit(2);
}
let failed = 0;
for (const dir of targets) {
  const name = basename(dir);
  if (!existsSync(dir)) { console.log(`SKIP ${name} (not found)`); failed += 1; continue; }
  const result = migrate(dir);
  if (result.findings.length) failed += 1;
  const status = result.findings.length ? 'FAIL' : 'OK';
  console.log(`${status} ${name}${result.changed.length ? ` - ${result.changed.join('; ')}` : ' - already current'}`);
  for (const f of result.findings.slice(0, 3)) console.log(`     ${f.message}`);
}
process.exit(failed ? 1 : 0);
