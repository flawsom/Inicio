import type { ExportDataset } from '@inicio/engine';
import { env } from '../env.js';

/**
 * The API's side of the pyreadstat export worker (`services/pyreadstat`).
 *
 * The dataset is computed here, by the engine, and travels as JSON: this module
 * never assembles a binary statistical file itself. That is the whole point of the
 * split — a `.sav` written by anything other than a writer that knows the format
 * is a file a researcher discovers is broken at the import step, and this project
 * would rather refuse than do that.
 *
 * The two failure modes are kept apart on purpose. No worker configured is a
 * refusal the caller can fix by configuring one (`format_not_available`, a 501);
 * a worker that is configured and does not answer is a fault (`502`). Neither
 * ever produces a file.
 */
export function pyreadstatWorkerUrl(): string | null {
  return env.PYREADSTAT_WORKER_URL ?? null;
}

export class ExportWorkerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportWorkerError';
  }
}

export interface StatisticalFile {
  bytes: Buffer;
  /** Everything the writer had to change to satisfy SPSS or Stata. */
  notes: string[];
  variables: number;
  cases: number;
}

function baseUrl(): string {
  return (pyreadstatWorkerUrl() ?? '').replace(/\/+$/, '');
}

/** Parse the worker's `x-inicio-notes` header, which is ASCII-only JSON by design. */
function notesFrom(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : [];
  } catch {
    // A malformed header must not fail an export that produced a real file, but it
    // is a fact about the deployment worth keeping rather than swallowing.
    return ['the export worker reported notes this client could not read'];
  }
}

/**
 * Ask the worker for one file. Throws `ExportWorkerError` for anything that is not
 * a file — a refused request, a timeout, a connection that never opened.
 */
export async function writeStatisticalFile(
  format: 'sav' | 'dta',
  dataset: ExportDataset,
  fileLabel: string,
): Promise<StatisticalFile> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl()}/write`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        format,
        fileLabel,
        // The dataset's own shape, sent as it is: the worker sanitises names for
        // the format it is writing and reports what it changed, which is work that
        // depends on the format and therefore does not belong here.
        columns: dataset.columns.map((column) => ({
          variable: column.variable,
          label: column.prompt,
          numeric: column.numeric,
        })),
        rows: dataset.rows,
        // The worker maps these back by variable name, so a column the format
        // forced it to rename still gets its labels.
        valueLabels: dataset.valueLabels.map((label) => ({
          variable: label.variable,
          code: label.code,
          label: label.label,
        })),
        missingCodes: dataset.codebook[0]?.missingCodes ?? [],
        notes: dataset.meta.notes,
      }),
      signal: AbortSignal.timeout(env.PYREADSTAT_TIMEOUT_MS),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ExportWorkerError(`the export worker could not be reached: ${reason}`);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new ExportWorkerError(
      `the export worker refused the dataset (${response.status}): ${detail.slice(0, 300)}`,
    );
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength === 0) {
    // A 200 with nothing in it would become an empty download. An export that
    // silently hands back a zero-byte file is the exact failure this whole split
    // exists to prevent, so it is an error here.
    throw new ExportWorkerError('the export worker returned no bytes');
  }

  return {
    bytes,
    notes: notesFrom(response.headers.get('x-inicio-notes')),
    variables: Number(response.headers.get('x-inicio-variables') ?? 0),
    cases: Number(response.headers.get('x-inicio-cases') ?? 0),
  };
}
