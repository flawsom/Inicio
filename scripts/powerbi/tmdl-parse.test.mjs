import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkTmdl, parseTmdl } from './tmdl-parse.mjs';

const ROOT = new URL('../..', import.meta.url).pathname;

const findingsOf = (text, file = 'tmdl') => checkTmdl(text, { file }).findings.map((f) => f.message);
const has = (findings, pattern) => findings.some((m) => pattern.test(m));

test('accepts a model whose refs are root-level', () => {
  const text = [
    'model Model',
    '\tculture: en-US',
    '\tdefaultPowerBIDataSourceVersion: powerBI_V3',
    '',
    'annotation PBI_QueryOrder = ["Sales"]',
    '',
    'ref table Sales',
    '',
    'ref cultureInfo en-US',
    '',
  ].join('\n');
  assert.deepEqual(findingsOf(text), []);
});

test('rejects an indented ref - the first Desktop load failure', () => {
  // Desktop: "Unexpected line type: ReferenceObject!"
  const text = ['model Model', '\tculture: en-US', '\tref table Evaluations', ''].join('\n');
  assert.ok(has(findingsOf(text), /ref must be at column 0, not inside model/));
});

test('rejects a flush-left DAX continuation - the second Desktop load failure', () => {
  // Desktop: "Unsupported object type - VAR is not a supported property in the current context!"
  const text = [
    'table _Measures',
    "\tmeasure 'Top complaint' =",
    '\t\t\tVAR _ranked = ADDCOLUMNS(_themes, "@n", CALCULATE([Evaluations]))',
    '\t\t\tRETURN ...',
    '',
  ].join('\n');
  // Correct depth parses; now the same text with the body pulled flush left:
  const broken = text.replace(/^\t{3}/gm, '');
  assert.deepEqual(findingsOf(text), []);
  assert.ok(has(findingsOf(broken), /unknown object type "VAR"/));
});

test('rejects an expression at property level, not just at column 0', () => {
  const text = ['table M', '\tmeasure X =', '\t\tVAR a = 1', '\t\tRETURN a', '\t\tformatString: 0', ''].join('\n');
  const findings = findingsOf(text);
  assert.ok(has(findings, /unknown object type "VAR"/), 'a property-level body is not an expression');
  assert.ok(has(findings, /declares = but has no expression/));
});

test('rejects the non-TMDL description property', () => {
  const text = ['table M', "\tmeasure X = 1", '\t\tdescription: not a TMDL property', ''].join('\n');
  assert.ok(has(findingsOf(text), /"description" is not a measure property/));
});

test('rejects a /// doc block above a relationship', () => {
  const text = ['/// many-to-one', 'relationship R', '\tfromColumn: A.Id', '\ttoColumn: B.Id', ''].join('\n');
  assert.ok(has(findingsOf(text), /\/\/\/ above a relationship is not allowed/));
});

test('rejects an unknown property and an unknown child object', () => {
  assert.ok(has(findingsOf(['table M', '\tcolumn C', '\t\tcolour: red', ''].join('\n')), /"colour" is not a column property/));
  // A known object in the wrong parent, and a token that is not an object at all.
  assert.ok(has(findingsOf(['table M', '\tlevel L', ''].join('\n')), /level is not allowed inside table/));
  assert.ok(has(findingsOf(['table M', '\twidget W', ''].join('\n')), /unknown object type "widget"/));
});

test('captures multi-line expressions without swallowing properties', () => {
  const text = [
    'table _Measures',
    "\tmeasure 'X' =",
    '\t\t\tVAR a = 1',
    '\t\t\tRETURN a',
    '\t\tformatString: #,0',
    '',
  ].join('\n');
  const { tree, errors } = parseTmdl(text, { file: 'm' });
  assert.deepEqual(errors, []);
  const measure = tree.children[0].children[0];
  assert.match(measure.expression, /VAR a = 1/);
  assert.doesNotMatch(measure.expression, /formatString/, 'properties must not be absorbed into the expression');
  assert.equal(measure.props.get('formatString'), '#,0');
});

test('captures a partition M body', () => {
  const text = [
    'table T',
    '\tpartition T = m',
    '\t\tmode: import',
    '\t\tsource =',
    '\t\t\t\tlet',
    '\t\t\t\t    Source = #table(type table [A = text], {{"x"}})',
    '\t\t\t\tin',
    '\t\t\t\t    Source',
    '',
  ].join('\n');
  const { tree } = parseTmdl(text, { file: 't' });
  const partition = tree.children[0].children[0];
  assert.match(partition.props.get('source'), /let/);
  assert.equal(partition.props.get('mode'), 'import');
});

test('every Desktop-authored TMDL file in vendor/repos parses clean', () => {
  const dir = join(ROOT, 'vendor/repos');
  if (!existsSync(dir)) return; // vendored repos are optional
  const files = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (p.endsWith('.tmdl')) files.push(p);
    }
  };
  walk(dir);
  assert.ok(files.length > 0, 'expected vendored TMDL files to test against');
  const bad = files.flatMap((f) => checkTmdl(readFileSync(f, 'utf8'), { file: f }).findings);
  assert.deepEqual(bad.map((b) => b.message), [], 'the schema must accept everything Desktop writes');
});

test('the shipped ORACURA model parses clean', () => {
  const file = join(ROOT, 'reports/power-bi/oracura/ORACURA.SemanticModel/definition/model.tmdl');
  if (!existsSync(file)) return;
  assert.deepEqual(findingsOf(readFileSync(file, 'utf8'), file), []);
});
