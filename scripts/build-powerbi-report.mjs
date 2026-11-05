#!/usr/bin/env node
/**
 * Build a deployable Power BI project (PBIP/PBIR + TMDL semantic model) from any
 * questionnaire Word document or canonical JSON definition.
 *
 * Usage:
 *   node scripts/build-powerbi-report.mjs --docx path/to/questionnaire.docx
 *   node scripts/build-powerbi-report.mjs --definition path/to/form.json --code STUDY
 *   node scripts/build-powerbi-report.mjs --manifest reports/power-bi/examples.json
 *
 * The output is a folder per study containing the .pbip shortcut, the report and
 * the semantic model. Open the .pbip in Power BI Desktop; no PBIX is written,
 * because Microsoft does not support generating a model-bearing PBIX outside
 * Desktop. See docs/POWER-BI.md for the boundary and deployment path.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileDocx } from '../packages/engine/dist/index.js';
import {
  analyzeDefinition,
  normalizeAnswers,
  normalizeResponses,
  parseCsv,
  studyCodeFrom,
} from './powerbi/study.mjs';
import {
  buildSemanticModel,
  semanticModelFiles,
  validateSemanticModel,
} from './powerbi/tmdl.mjs';
import {
  BASE_THEME_NAME,
  buildReportPackage,
  THEME_NAME,
  validateReportPackage,
} from './powerbi/pbir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, '..');

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeText(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, 'utf8');
}

function slugFor(code) {
  return studyCodeFrom(code).toLowerCase().replace(/-+/g, '-');
}

export function writeStudyProject(study, options = {}) {
  const outputBase = resolve(options.out ?? join(PROJECT_ROOT, 'reports', 'power-bi'));
  const projectDir = join(outputBase, slugFor(study.code));
  const model = buildSemanticModel(study);
  const modelErrors = validateSemanticModel(model);
  if (modelErrors.length) throw new Error(`Invalid semantic model for ${study.code}: ${modelErrors.join('; ')}`);
  const pkg = buildReportPackage(study);
  const reportErrors = validateReportPackage(pkg, model);
  if (reportErrors.length) throw new Error(`Invalid report for ${study.code}: ${reportErrors.join('; ')}`);

  // Only the generated study folder is replaced. The output base can contain
  // other studies or hand-written notes and is never cleaned wholesale.
  rmSync(projectDir, { recursive: true, force: true });
  mkdirSync(projectDir, { recursive: true });

  const reportDir = join(projectDir, `${study.code}.Report`);
  const modelDir = join(projectDir, `${study.code}.SemanticModel`);
  writeJson(join(projectDir, `${study.code}.pbip`), pkg.pbip);
  writeText(join(reportDir, '.platform'), `${JSON.stringify(pkg.reportPlatform, null, 2)}\n`);
  writeJson(join(reportDir, 'definition.pbir'), pkg.definitionPbir);
  writeJson(join(reportDir, 'definition', 'version.json'), pkg.versionJson);
  writeJson(join(reportDir, 'definition', 'report.json'), pkg.reportJson);
  writeJson(join(reportDir, 'definition', 'pages', 'pages.json'), pkg.pagesJson);
  for (const page of pkg.pages) {
    writeJson(join(reportDir, 'definition', 'pages', page.id, 'page.json'), page.json);
    for (const visual of page.visuals) {
      writeJson(join(reportDir, 'definition', 'pages', page.id, 'visuals', visual.name, 'visual.json'), visual.json);
    }
  }
  writeText(
    join(reportDir, 'StaticResources', 'SharedResources', 'BaseThemes', `${BASE_THEME_NAME}.json`),
    readFileSync(join(HERE, 'powerbi', 'assets', `${BASE_THEME_NAME}.json`), 'utf8'),
  );
  writeJson(join(reportDir, 'StaticResources', 'RegisteredResources', `${THEME_NAME}.json`), pkg.themeJson);

  const files = semanticModelFiles(study, model);
  writeText(join(modelDir, '.platform'), `${JSON.stringify(pkg.modelPlatform, null, 2)}\n`);
  writeJson(join(modelDir, 'definition.pbism'), pkg.pbism);
  writeText(join(modelDir, 'definition', 'database.tmdl'), files.database);
  writeText(join(modelDir, 'definition', 'model.tmdl'), files.model);
  writeText(join(modelDir, 'definition', 'relationships.tmdl'), files.relationships);
  for (const [name, contents] of Object.entries(files.tables)) {
    writeText(join(modelDir, 'definition', 'tables', name), contents);
  }

  const manifest = {
    schemaVersion: 1,
    code: study.code,
    source: study.sourceLabel,
    sourceTitle: study.sourceTitle,
    generatedAt: study.generatedAt,
    boundary: 'Questionnaire intelligence only. Response tables are empty unless response rows were explicitly supplied; no synthetic respondents are created.',
    counts: study.counts,
    pages: pkg.pages.map((page) => ({
      name: page.displayName,
      id: page.id,
      visuals: page.visuals.length,
    })),
    visualCount: pkg.pages.reduce((sum, page) => sum + page.visuals.length, 0),
    semanticModel: {
      compatibilityLevel: 1567,
      tables: model.tables.map((table) => ({
        name: table.name,
        columns: table.columns.length,
        rows: table.rows.length,
        measures: (table.measures ?? []).length,
      })),
      relationships: model.relationships.length,
    },
    paths: {
      project: `${study.code}.pbip`,
      report: `${study.code}.Report`,
      semanticModel: `${study.code}.SemanticModel`,
    },
    evidence: {
      respondentData: study.counts.responses > 0 ? 'supplied' : 'none',
      responseRows: study.counts.responses,
      answerRows: study.counts.answers,
    },
  };
  writeJson(join(projectDir, 'report-manifest.json'), manifest);
  writeText(join(projectDir, 'README.md'), projectReadme(study, manifest));

  return { projectDir, reportDir, modelDir, manifest, model, pkg };
}

function projectReadme(study, manifest) {
  return `# ${study.code} — Power BI design dossier

Generated from **${study.sourceLabel}** on ${study.generatedAt.slice(0, 10)}.

This folder is a **Power BI Project (PBIP)**. Open \`${study.code}.pbip\` in Power BI Desktop. The report references \`${study.code}.SemanticModel\` by relative path.

## What is in the report

${manifest.pages.map((page, index) => `${index + 1}. **${page.name}** — ${page.visuals} visual${page.visuals === 1 ? '' : 's'}`).join('\n')}

## What the model contains

| Table | Rows | Grain |
| --- | ---: | --- |
${manifest.semanticModel.tables.map((table) => `| ${table.name} | ${table.rows} | ${table.columns} columns${table.measures ? `, ${table.measures} measure${table.measures === 1 ? '' : 's'}` : ''} |`).join('\n')}

All questionnaire rows are embedded with Power Query \`#table\`, so the report opens without a file path, gateway or refresh credential.

## Evidence boundary

${manifest.boundary}

- ${study.counts.questions} instrument rows across ${study.counts.sections} sections
- ${study.counts.answerable} answerable questions; ${study.counts.routed} routing rules
- ${study.counts.constraints} validation constraints; ${study.counts.choiceOptions} choice options
- ${study.counts.estimatedMinutes.toFixed(1)} minutes planning burden (a heuristic, not measured field time)
- ${study.counts.responses} response rows; ${study.counts.answers} answer rows

Do not describe an empty response base as a finding. The questionnaire-level pages are evidence about the instrument; they are not evidence about respondents.
`;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    if (key === 'help' || key === 'h') {
      args.help = true;
      continue;
    }
    const following = argv[index + 1];
    if (following === undefined || following.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = following;
    index += 1;
  }
  return args;
}

function usage() {
  return `Build a Power BI report for any questionnaire.

Options:
  --docx <file>            Compile a .docx with the Inicio DOCX compiler.
  --definition <file>      Read a canonical FormDefinition JSON file.
  --manifest <file>        Build every study in a JSON manifest.
  --all <dir>              Compile every .docx directly inside a directory.
  --code <name>            Study code / output name (default: source stem or title).
  --project-number <n>     Project number passed to the DOCX compiler.
  --out <dir>              Output base (default: reports/power-bi).
  --generated-at <iso>     Reproducible build timestamp.
  --responses <csv>        Optional response rows to embed in Responses.
  --answers <csv>          Optional answer rows to embed in Answers.
  --help                   Show this help.

Examples:
  node scripts/build-powerbi-report.mjs --docx ./questionnaire.docx --code ACME
  node scripts/build-powerbi-report.mjs --definition ./form.json --code ACME
  node scripts/build-powerbi-report.mjs --manifest ./studies.json

No PBIX is written. Microsoft does not support generating a model-bearing PBIX
outside Power BI Desktop; the PBIP/PBIR + TMDL path is the supported project format.
`;
}

function definitionFromFile(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  return parsed.definition ?? parsed;
}

function csvRows(path) {
  if (!path) return [];
  return parseCsv(readFileSync(path, 'utf8'));
}

function buildOne(entry, shared = {}) {
  const generatedAt = shared.generatedAt ?? new Date().toISOString();
  const code = studyCodeFrom(entry.code || entry.name || (entry.docx ? basename(entry.docx, extname(entry.docx)) : entry.definition ? basename(entry.definition, extname(entry.definition)) : 'INSTRUMENT'));
  const sourcePath = entry.docx ?? entry.definition;
  const sourceLabel = sourcePath ? basename(sourcePath) : code;
  const responses = normalizeResponses(csvRows(entry.responses));
  const answers = normalizeAnswers(csvRows(entry.answers));

  let definition;
  if (entry.docx) {
    const path = resolve(entry.docx);
    if (!existsSync(path)) throw new Error(`DOCX not found: ${path}`);
    const result = compileDocx(new Uint8Array(readFileSync(path)), {
      projectNumber: entry.projectNumber,
      now: new Date(generatedAt),
      title: entry.title,
      formId: entry.formId,
    });
    definition = result.definition;
    if (result.report?.diagnostics?.some((diagnostic) => diagnostic.severity === 'error')) {
      const errors = result.report.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
      throw new Error(`DOCX compiler reported ${errors.length} error(s) for ${sourcePath}: ${errors.slice(0, 3).map((error) => error.message).join('; ')}`);
    }
  } else if (entry.definition) {
    const path = resolve(entry.definition);
    if (!existsSync(path)) throw new Error(`Definition not found: ${path}`);
    definition = definitionFromFile(path);
  } else {
    throw new Error('A study needs either a docx or definition path.');
  }

  const study = analyzeDefinition(definition, {
    code,
    sourceLabel,
    generatedAt,
    responses,
    answers,
  });
  return writeStudyProject(study, { out: shared.out ?? entry.out });
}

function manifestEntries(path) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const base = dirname(resolve(path));
  const entries = Array.isArray(parsed) ? parsed : parsed.studies ?? parsed.entries ?? [];
  return entries.map((entry) => {
    const resolveRelative = (value) => (value && !value.startsWith('/') ? join(base, value) : value);
    return {
      ...entry,
      docx: resolveRelative(entry.docx),
      definition: resolveRelative(entry.definition),
      responses: resolveRelative(entry.responses),
      answers: resolveRelative(entry.answers),
      out: resolveRelative(entry.out),
    };
  });
}

function allDocx(dir) {
  const base = resolve(dir);
  return readdirSync(base)
    .filter((name) => name.toLowerCase().endsWith('.docx') && !name.startsWith('~$'))
    .sort()
    .map((name) => ({ docx: join(base, name), code: studyCodeFrom(basename(name, '.docx')) }));
}

export function buildFromArgs(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(usage());
    return [];
  }
  if (!args.docx && !args.definition && !args.manifest && !args.all) {
    throw new Error('Provide --docx, --definition, --manifest or --all. Use --help for details.');
  }
  const shared = { generatedAt: args['generated-at'], out: args.out };
  const entries = args.manifest
    ? manifestEntries(args.manifest)
    : args.all
      ? allDocx(args.all)
      : [{
        docx: args.docx,
        definition: args.definition,
        code: args.code,
        title: args.title,
        projectNumber: args['project-number'],
        formId: args['form-id'],
        responses: args.responses,
        answers: args.answers,
        out: args.out,
      }];
  const results = entries.map((entry) => buildOne(entry, shared));
  for (const result of results) {
    const pageCount = result.manifest.pages.length;
    const visualCount = result.manifest.visualCount;
    process.stdout.write(`${result.manifest.code}: ${pageCount} pages, ${visualCount} visuals, ${result.manifest.counts.questions} questions, ${result.manifest.counts.sections} sections → ${result.projectDir}\n`);
  }
  return results;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  try {
    buildFromArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
