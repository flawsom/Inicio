/**
 * The dataset as the statistical worker's contract.
 *
 * `services/pyreadstat` runs Python in a separate deployment: it receives this JSON and
 * writes `.sav`/`.dta` bytes. That makes this mapping the seam between the two halves of
 * the export, and puts it in the awkward position of being easy to get quietly wrong —
 * a label dropped here is a label the worker never had, and a code lost here is a
 * missing value that arrives in an analysis as a number.
 *
 * So it lives in the engine, as a pure function of the dataset, and the API calls it
 * rather than assembling the body inline. Two things follow: the API's own suite can
 * assert the payload it sends without a worker, and the end-to-end harness
 * (`apps/api/scripts/roundtrip-statistical.ts`) can build the *same* body from the
 * engine's build output and hand it to a real worker — so what a deployed worker is
 * asked to write is the body the tests describe, not a second implementation of it.
 */
import type { Cell, ExportDataset, MissingCode } from './dataset.js';

export interface StatisticalColumn {
  variable: string;
  /** The column's label: the question's prompt, in the export's language. */
  label: string;
  numeric: boolean;
}

export interface StatisticalValueLabel {
  variable: string;
  code: string;
  label: string;
}

export interface StatisticalMissingCode {
  code: MissingCode;
  numeric: number | null;
  label: string;
}

export interface StatisticalPayload {
  format: 'sav' | 'dta';
  fileLabel: string;
  columns: StatisticalColumn[];
  rows: Cell[][];
  valueLabels: StatisticalValueLabel[];
  missingCodes: StatisticalMissingCode[];
  /** The dataset's own notes, carried through to the worker's `x-inicio-notes`. */
  notes: string[];
}

/**
 * The missing-code table is global in the engine — one table per export, the same in
 * every column's codebook entry — so the worker is given it once, from the dataset
 * rather than from a column. A column is only a carrier for it.
 */
export function missingCodeTable(dataset: ExportDataset): StatisticalMissingCode[] {
  return dataset.codebook[0]?.missingCodes ?? [];
}

export function statisticalPayload(
  format: 'sav' | 'dta',
  dataset: ExportDataset,
  fileLabel: string,
): StatisticalPayload {
  return {
    format,
    fileLabel,
    // The dataset's own shape, sent as it is: the worker sanitises names for the format
    // it is writing and reports what it changed, which is work that depends on the
    // format and therefore does not belong here.
    columns: dataset.columns.map((column) => ({
      variable: column.variable,
      label: column.prompt,
      numeric: column.numeric,
    })),
    rows: dataset.rows,
    // The worker maps these back by variable name, so a column the format forced it to
    // rename still gets its labels.
    valueLabels: dataset.valueLabels.map((label) => ({
      variable: label.variable,
      code: label.code,
      label: label.label,
    })),
    missingCodes: missingCodeTable(dataset),
    notes: dataset.meta.notes,
  };
}
