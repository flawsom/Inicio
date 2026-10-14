/**
 * The statistical export, end to end, with a real Python worker.
 *
 * Three pieces of this export are each covered somewhere, and none of them is covered
 * *together*: `packages/engine` computes the dataset and the payload
 * (`statisticalPayload`), `apps/api` POSTs that payload and reads the worker's headers
 * back (`writeStatisticalFile`), and `services/pyreadstat` writes the binary. The
 * engine's tests stop at the JSON, the API's suite stubs the worker over HTTP — which
 * is what makes it a fast suite and also what makes it blind to the bytes — and the
 * worker's own `test_roundtrip.py` reads real files back but builds its payload by hand.
 *
 * So this harness runs the chain the way a deployment does: the school-ranking template
 * (a repeat group, two languages, a cascading select, a geopoint, a computed score) is
 * turned into a dataset, the *real* `statisticalPayload` and `writeStatisticalFile` are
 * used to write it through a worker started on a local port, and the files that come out
 * are handed to `test_roundtrip.py`, which reads them back with `pyreadstat` and checks
 * the labels, the blanks, the value labels and the case counts. A body mangled on the way
 * out, or a worker answer parsed wrongly on the way back, fails here and nowhere else.
 *
 *   pnpm --filter @inicio/api roundtrip:statistical
 *   pnpm --filter @inicio/api roundtrip:statistical --out /tmp/statistical
 *
 * It is deliberately **not** part of CI: it needs a Python process with `pyreadstat`,
 * which the repository's Node-only build image does not have — the same reason the
 * worker itself is deployed separately. No Python at all is an environment answer
 * (exit 2), not a failed export.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDataset, statisticalPayload, type ExportResponse, type ExportDataset } from '@inicio/engine';
import { findTemplate } from '../src/platform/templates.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const WORKER = 'services/pyreadstat/worker.py';
const ROUNDTRIP = 'services/pyreadstat/test_roundtrip.py';
const TEMPLATE = 'school-ranking-2026';
const FORMATS = ['sav', 'dta'] as const;

/** A port nothing is listening on, so the worker and this script agree where to meet. */
async function freePort(): Promise<number> {
  return new Promise((settle, fail) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        fail(new Error('could not reserve a local port'));
        return;
      }
      const { port } = address;
      probe.close(() => settle(port));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((settle) => setTimeout(settle, ms));
}

/**
 * The four responses that make an export interesting.
 *
 * Between them they cover what a real instrument produces and what an export gets wrong:
 * a complete submission, a partially collected one whose blanks must arrive blank rather
 * than as zero, a refusal (a real answer of "refused", which is a missing *code* and not
 * an empty cell), a screened-out response, a decimal (so the numeric handling is not all
 * integers), an expanded select_multiple, and a question the logic hid.
 */
function responses(): ExportResponse[] {
  return [
    {
      id: '11111111-1111-4111-8111-111111111111',
      status: 'submitted',
      startedAt: '2026-10-13T09:00:00.000Z',
      submittedAt: '2026-10-13T09:22:00.000Z',
      answers: {
        school_name: 'Govt Higher Primary School, Hubli',
        school_type: 'govt',
        state: 'ka',
        district: 'dharwad',
        enrolment: 412,
        location: '15.3647 75.1240 640 12',
        teacher_quality: 4,
        infrastructure: 3,
        facilities: ['library', 'toilets'],
        composite_score: 70,
        contact_name: 'R. Kulkarni',
        contact_phone: '9845012345',
      },
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      status: 'in_progress',
      startedAt: '2026-10-13T11:30:00.000Z',
      submittedAt: null,
      // Collected an hour into a visit and never finished: everything else is blank, and
      // the harness is here to check that blank survives the two languages and the formats.
      answers: { school_name: 'Zilla Parishad High School, Gadag', state: 'ka' },
      notAsked: ['district'],
    },
    {
      id: '33333333-3333-4333-8333-333333333333',
      status: 'submitted',
      startedAt: '2026-10-13T13:00:00.000Z',
      submittedAt: '2026-10-13T13:41:00.000Z',
      answers: {
        school_name: 'St. Xavier Private School',
        school_type: 'private',
        state: 'mh',
        district: 'pune',
        enrolment: 866,
        location: '18.5204 73.8567 560 6',
        teacher_quality: 5,
        infrastructure: 5,
        facilities: ['library'],
        fee_annual: 12000.5,
        composite_score: 100,
        // Only the name was given: the phone number is a refusal, which is a fact and not
        // an empty cell, and the export has one code for it.
        contact_name: 'S. Deshpande',
      },
      special: { contact_phone: 'refused' },
    },
    {
      id: '44444444-4444-4444-8444-444444444444',
      status: 'screened_out',
      startedAt: '2026-10-13T14:10:00.000Z',
      submittedAt: null,
      answers: { school_name: 'Closed school', state: 'ka', school_type: 'govt' },
    },
  ];
}

function dataset(): ExportDataset {
  const definition = findTemplate(TEMPLATE);
  if (!definition) throw new Error(`the "${TEMPLATE}" template is gone: ${REPO_ROOT}`);
  // `slots` would be a second valid expansion of a select_multiple; the API's own default
  // is dichotomous, so that is what this harness writes.
  return buildDataset(definition, responses(), { multiSelect: 'dichotomous' });
}

async function waitForHealth(port: number, child: ChildProcess, errors: string[]): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the worker exited with ${child.exitCode}\n${errors.join('')}`);
    try {
      const health = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_000) });
      if (health.ok) {
        const body = (await health.json()) as { pyreadstat?: string; pandas?: string };
        console.log(`[roundtrip] worker ready on :${port} — pyreadstat ${body.pyreadstat}, pandas ${body.pandas}`);
        return;
      }
    } catch {
      /* not listening yet; the loop is the retry */
    }
    await sleep(150);
  }
  throw new Error(`the worker did not answer /health within 15 s\n${errors.join('')}`);
}

function outDir(argv: string[]): string {
  const index = argv.indexOf('--out');
  const chosen = index === -1 ? undefined : argv[index + 1];
  if (index !== -1 && !chosen) throw new Error('--out needs a directory');
  return chosen ? resolve(chosen) : join(tmpdir(), `inicio-statistical-${Date.now()}`);
}

async function main(): Promise<number> {
  const out = outDir(process.argv.slice(2));
  mkdirSync(out, { recursive: true });
  console.log(`[roundtrip] files are kept in ${out}`);

  // Python first: a machine without it cannot run this at all, and that is a fact about
  // the environment rather than a defect in the export.
  const python = spawnSync('python3', ['-c', 'import pyreadstat, pandas'], { encoding: 'utf8' });
  if (python.error) {
    console.log('[roundtrip] python3 is not on PATH, so no .sav/.dta can be written or read back here');
    return 2;
  }
  if (python.status !== 0) {
    const why = (python.stderr || '').trim().split('\n').pop() ?? '';
    console.log(`[roundtrip] python3 cannot import pyreadstat/pandas: ${why}`);
    console.log('[roundtrip] install them with: pip install -r services/pyreadstat/requirements.txt');
    return 2;
  }

  const data = dataset();
  console.log(
    `[roundtrip] dataset from "${TEMPLATE}": ${data.meta.columnCount} columns x ${data.meta.responseCount} cases, ` +
      `${data.valueLabels.length} value labels, ${data.meta.missingCount} missing cells to the missing table`,
  );

  const port = await freePort();
  const errors: string[] = [];
  const child = spawn('python3', [WORKER], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => errors.push(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => errors.push(chunk.toString()));

  let failed = 0;
  try {
    await waitForHealth(port, child, errors);

    // Set before the module that reads it is loaded: `env.ts` reads the process
    // environment once, and this is the only value this script touches. Everything else
    // the API needs comes from the workspace environment, which is not ours to print.
    process.env.PYREADSTAT_WORKER_URL = `http://127.0.0.1:${port}`;
    const { writeStatisticalFile } = await import('../src/platform/pyreadstat.js');

    for (const format of FORMATS) {
      const payload = statisticalPayload(format, data, data.meta.title);
      const file = await writeStatisticalFile(format, data, data.meta.title);
      const path = join(out, `sample.${format}`);
      writeFileSync(path, file.bytes);
      writeFileSync(join(out, `body-${format}.json`), JSON.stringify(payload, null, 2));
      // The worker's own notes, as the API read them off `x-inicio-notes`. Several claims
      // are only checkable against them — a value label Stata cannot carry is correct
      // *because the writer said so* — so they travel with the files rather than being
      // left behind in this process.
      const notesPath = join(out, `notes-${format}.json`);
      writeFileSync(notesPath, JSON.stringify({ [format]: file.notes }, null, 2));

      const problems: string[] = [];
      if (file.bytes.byteLength === 0) problems.push('the worker returned no bytes');
      if (file.bytes[0] === 0x7b) problems.push('the body starts with "{" — that is an error document, not a file');
      if (file.variables !== data.meta.columnCount) {
        problems.push(`the worker wrote ${file.variables} variables, the dataset has ${data.meta.columnCount}`);
      }
      if (file.cases !== data.meta.responseCount) {
        problems.push(`the worker wrote ${file.cases} cases, the dataset has ${data.meta.responseCount}`);
      }
      if (problems.length > 0) {
        failed += problems.length;
        for (const problem of problems) console.log(`  FAIL  ${format}: ${problem}`);
        continue;
      }

      console.log(
        `  ok    ${format}: ${path} (${file.bytes.byteLength} bytes, ${file.variables} variables, ${file.cases} cases)`,
      );
      for (const note of file.notes) console.log(`         note: ${note}`);

      // The reader-back is the whole point: `test_roundtrip.py` opens the bytes this
      // worker wrote and checks them against the body the API sent.
      const verdict = spawnSync(
        'python3',
        [ROUNDTRIP, '--payload', join(out, `body-${format}.json`), `--${format}`, path, '--notes', notesPath],
        { cwd: REPO_ROOT, stdio: 'inherit' },
      );
      if (verdict.status !== 0) {
        failed += 1;
        console.log(`  FAIL  ${format}: test_roundtrip.py exited ${verdict.status ?? 'by signal'}`);
      }
    }
  } catch (err) {
    console.log(`[roundtrip] ${err instanceof Error ? err.message : String(err)}`);
    failed += 1;
  } finally {
    // Never leave the worker behind, whatever happened above.
    if (child.exitCode === null) child.kill('SIGTERM');
  }

  console.log(failed === 0 ? '\n[roundtrip] the whole chain agrees' : `\n[roundtrip] ${failed} failure(s)`);
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(`[roundtrip] ${(err as Error).message}`);
    process.exitCode = 1;
  });
