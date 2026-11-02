/**
 * Server dataset lookups.
 *
 * A dataset is an organisation table that travels with a published form: a case
 * list, a sample frame, a price list. It is deliberately just rows and columns.
 * The engine never fetches one, never knows an id, and never trusts a row to be
 * complete. It receives a snapshot in `EvalContext.datasets` and `pulldata()`
 * reads it purely, which is what keeps the browser and the server agreeing about
 * the same calculation.
 *
 * The shape mirrors the JSON written by `app_collect_datasets`, but nothing here
 * imports the API. A test can construct one by hand.
 */
export interface DatasetRow {
  [column: string]: unknown;
}

export interface DatasetTable {
  /** Stable id, present when it came from the API; not used by expressions. */
  datasetId?: string;
  /** The name `pulldata('code', ...)` uses. Case-insensitive on lookup. */
  code: string;
  name?: string;
  kind?: 'data' | 'cases' | 'enumerators';
  uniqueField: string;
  columns: string[];
  rows: DatasetRow[];
}

export type DatasetContext = Record<string, DatasetTable>;

/**
 * Build the lookup map the expression evaluator expects.
 *
 * The code is normalised to lower case, because an XLSForm author should not
 * have to remember whether the dataset was created as `Cases` or `cases`.
 */
export function datasetContext(tables: readonly DatasetTable[]): DatasetContext {
  const out: DatasetContext = {};
  for (const table of tables) {
    const code = table.code.trim().toLowerCase();
    if (code === '') continue;
    out[code] = {
      ...table,
      code,
      columns: Array.isArray(table.columns) ? table.columns.map(String) : [],
      rows: Array.isArray(table.rows) ? table.rows : [],
    };
  }
  return out;
}

/** A blank key is not a lookup, and a dataset with no matching row is not an error. */
export function lookupDataset(
  datasets: DatasetContext | undefined,
  code: unknown,
  valueColumn: unknown,
  lookupColumn: unknown,
  key: unknown,
): unknown {
  if (!datasets) return null;
  const source = String(code ?? '').trim().toLowerCase();
  const valueField = String(valueColumn ?? '').trim();
  const lookupField = String(lookupColumn ?? '').trim();
  if (source === '' || valueField === '' || lookupField === '') return null;
  if (key === null || key === undefined || String(key).trim() === '') return null;

  const table = datasets[source];
  if (!table) return null;
  const wanted = String(key).trim();
  // A string comparison is what SurveyCTO documents for a lookup key, and it
  // avoids `1` and `'1'` being treated as different keys in one CSV.
  for (const row of table.rows) {
    const candidate = row[lookupField];
    if (candidate === null || candidate === undefined) continue;
    if (String(candidate).trim() === wanted) {
      return row[valueField] === undefined ? null : row[valueField];
    }
  }
  return null;
}

/** The enumerator row an id or code names, or null. */
export function findEnumerator(
  datasets: DatasetContext | undefined,
  enumeratorId: string,
): { table: DatasetTable; row: DatasetRow } | null {
  if (!datasets) return null;
  const wanted = enumeratorId.trim().toLowerCase();
  if (wanted === '') return null;
  for (const table of Object.values(datasets)) {
    if (table.kind !== 'enumerators') continue;
    const row = table.rows.find((candidate) =>
      [candidate[table.uniqueField], candidate['name'], candidate['code']]
        .some((value) => String(value ?? '').trim().toLowerCase() === wanted),
    );
    if (row) return { table, row };
  }
  return null;
}

/** The case row a case id names, or null. Used by the collection start route. */
export function findCase(
  datasets: DatasetContext | undefined,
  caseId: string,
): { table: DatasetTable; row: DatasetRow } | null {
  if (!datasets) return null;
  const wanted = caseId.trim();
  if (wanted === '') return null;
  for (const table of Object.values(datasets)) {
    if (table.kind !== 'cases') continue;
    const row = table.rows.find((candidate) => String(candidate[table.uniqueField] ?? '').trim() === wanted);
    if (row) return { table, row };
  }
  return null;
}
