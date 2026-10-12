import type { FormDefinition } from '../types.js';
import { buildDataset, type BuildOptions, type ExportDataset, type ExportResponse } from './dataset.js';
import { csvBundle, jsonBundle, xlsxBundle, type BundleFile } from './writers.js';

export * from './dataset.js';
export { toCsv, toJsonExport, sanitizeSpreadsheetCell, csvBundle, xlsxBundle, jsonBundle, zipFiles, type BundleFile, type JsonExport } from './writers.js';

export type ExportFormat = 'csv' | 'xlsx' | 'json';

export interface ExportBundle {
  dataset: ExportDataset;
  files: BundleFile[];
  /** Formats that are recognised but not yet produced, and why. */
  unavailable: Array<{ format: string; reason: string }>;
}

/**
 * Statistical formats are deliberately absent rather than faked.
 *
 * There is no maintained, free, pure-JS `.sav` writer, and KoboToolbox's "SPSS export"
 * is merely label syntax — not a `.sav` file. Until the pyreadstat worker exists, we
 * return a clear 501-style refusal instead of a file that a researcher would only
 * discover was broken after a failed import.
 */
export const UNAVAILABLE_FORMATS: Array<{ format: string; reason: string }> = [
  { format: 'sav', reason: 'SPSS .sav requires the pyreadstat export worker; CSV/XLSX/JSON are available now' },
  { format: 'dta', reason: 'Stata .dta requires the pyreadstat export worker; CSV/XLSX/JSON are available now' },
];

export function buildExportBundle(
  def: FormDefinition,
  responses: ExportResponse[],
  options: BuildOptions & { formats?: ExportFormat[] } = {},
): ExportBundle {
  const dataset = buildDataset(def, responses, options);
  const formats = options.formats ?? ['csv'];
  const files: BundleFile[] = [];
  if (formats.includes('csv')) files.push(...csvBundle(dataset));
  if (formats.includes('xlsx')) files.push(...xlsxBundle(dataset));
  if (formats.includes('json')) files.push(...jsonBundle(dataset));
  return { dataset, files, unavailable: UNAVAILABLE_FORMATS };
}
