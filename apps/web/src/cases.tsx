import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from 'react';
import {
  ApiError,
  api,
  type DatasetAttachment,
  type DatasetRowRecord,
  type DatasetSummary,
  type VersionSummary,
} from './api';

/**
 * Cases and data: the organisation tables a form version reads and writes.
 *
 * The screen is deliberately one workspace rather than a second product. An
 * operator can create a case list, import the CSV they already have, attach it to
 * a version, see the mapping the server inferred, and open a case in a link that
 * carries its id. The server owns the row keys, the mapping and the write-back;
 * this screen owns the file and the sentence that says what happened.
 */

interface ParsedCsv {
  columns: string[];
  rows: Array<Record<string, unknown>>;
}

/**
 * A small RFC 4180 reader.
 *
 * It handles quoted fields, escaped quotes, CRLF and a trailing newline, because
 * the files people actually export from Excel do all four. It is not a general
 * CSV dialect engine: a delimiter other than a comma is not guessed at, and a
 * ragged row is refused by name rather than padded silently.
 */
export function parseCsv(text: string): ParsedCsv {
  const source = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < source.length; i += 1) {
    const character = source[i]!;
    if (quoted) {
      if (character === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (character === '\n' || character === '\r') {
      if (character === '\r' && source[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.some((value) => value.trim() !== '')) rows.push(row);
      row = [];
      continue;
    }
    field += character;
  }
  if (quoted) throw new Error('A quoted value is not closed. Fix the CSV and import it again.');
  row.push(field);
  if (row.some((value) => value.trim() !== '')) rows.push(row);

  const header = (rows.shift() ?? []).map((value) => value.trim());
  if (header.length === 0 || header.every((value) => value === '')) {
    throw new Error('The CSV has no header row. The first row must name the columns.');
  }
  if (new Set(header).size !== header.length) {
    throw new Error('The CSV has two columns with the same name. Give each column a unique header.');
  }
  const seen = new Set<string>();
  for (const name of header) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`"${name}" is not a usable column name. Use letters, numbers and underscores, starting with a letter or underscore.`);
    }
    if (seen.has(name)) throw new Error(`The column "${name}" appears twice.`);
    seen.add(name);
  }

  const out: Array<Record<string, unknown>> = [];
  for (const [index, values] of rows.entries()) {
    if (values.length !== header.length) {
      throw new Error(
        `Row ${index + 2} has ${values.length} value(s) but the header has ${header.length}. Every row needs the same number of columns.`,
      );
    }
    out.push(Object.fromEntries(header.map((name, column) => [name, values[column] ?? ''])));
  }
  if (out.length === 0) throw new Error('The CSV has a header but no data rows.');
  return { columns: header, rows: out };
}

function label(row: DatasetRowRecord, column: string): string {
  const value = row.data[column];
  if (value === null || value === undefined || value === '') return '(blank)';
  return String(value);
}

export function CasesTab({
  orgId,
  formId,
  versions,
  selectedVersionId,
  publishedVersionId,
}: {
  orgId: string;
  formId: string;
  versions: VersionSummary[];
  selectedVersionId: string | null;
  publishedVersionId: string | null;
}): JSX.Element {
  const [datasets, setDatasets] = useState<DatasetSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{
    dataset: DatasetSummary;
    rows: DatasetRowRecord[];
    total: number;
  } | null>(null);
  const [attachments, setAttachments] = useState<DatasetAttachment[]>([]);
  const [versionId, setVersionId] = useState<string | null>(
    publishedVersionId ?? selectedVersionId ?? versions[0]?.id ?? null,
  );
  const [newCode, setNewCode] = useState('');
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState<'data' | 'cases'>('cases');
  const [mode, setMode] = useState<'merge' | 'replace' | 'append'>('merge');
  const [keyQuestion, setKeyQuestion] = useState('caseid');
  const [publish, setPublish] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const selected = useMemo(
    () => datasets.find((dataset) => dataset.id === selectedId) ?? null,
    [datasets, selectedId],
  );
  const targetVersion = versions.find((version) => version.id === versionId) ?? null;

  const loadDatasets = useCallback(async (): Promise<void> => {
    try {
      const result = await api.datasets(orgId);
      setDatasets(result.datasets);
      setSelectedId((current) => current ?? result.datasets[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'the datasets could not be read');
    }
  }, [orgId]);

  const loadDetail = useCallback(
    async (datasetId: string): Promise<void> => {
      try {
        const result = await api.dataset(orgId, datasetId, { limit: 100 });
        setDetail({ dataset: result.dataset, rows: result.rows, total: result.total });
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'the rows could not be read');
      }
    },
    [orgId],
  );

  const loadAttachments = useCallback(
    async (target: string | null): Promise<void> => {
      if (!target) {
        setAttachments([]);
        return;
      }
      try {
        const result = await api.datasetAttachments(orgId, formId, target);
        setAttachments(result.datasets);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'the attachments could not be read');
      }
    },
    [orgId, formId],
  );

  useEffect(() => {
    void loadDatasets();
  }, [loadDatasets]);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
    else setDetail(null);
  }, [selectedId, loadDetail]);

  useEffect(() => {
    void loadAttachments(versionId);
  }, [loadAttachments, versionId]);

  useEffect(() => {
    // A published version is the one a case link will actually open; if it changes
    // while this screen is mounted, follow it rather than silently attaching to a
    // draft the respondent will never see.
    if (publishedVersionId) setVersionId(publishedVersionId);
  }, [publishedVersionId]);

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof ApiError ? (err.message ?? err.code) : err instanceof Error ? err.message : 'that did not work');
    } finally {
      setBusy(false);
    }
  };

  const create = (): Promise<void> =>
    run(async () => {
      const result = await api.createDataset(orgId, {
        code: newCode.trim(),
        name: newName.trim() || newCode.trim(),
        kind: newKind,
      });
      setNewCode('');
      setNewName('');
      await loadDatasets();
      setSelectedId(result.dataset.id);
      setNotice(`Created ${result.dataset.name}. Import a CSV to fill it.`);
    });

  const importFile = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !selectedId) return;
    void run(async () => {
      const parsed = parseCsv(await file.text());
      const result = await api.importDatasetRows(orgId, selectedId, { mode, rows: parsed.rows });
      await loadDatasets();
      await loadDetail(selectedId);
      setNotice(
        `Imported ${result.imported} row${result.imported === 1 ? '' : 's'} from ${file.name}. The dataset now holds ${result.total}.`,
      );
    });
  };

  const attach = (): Promise<void> =>
    run(async () => {
      if (!versionId || !selectedId) throw new Error('Choose a dataset and a version first.');
      const result = await api.attachDataset(orgId, formId, versionId, {
        datasetId: selectedId,
        keyQuestion: keyQuestion.trim() || null,
        publish,
      });
      await loadAttachments(versionId);
      const mapping = Object.keys(result.dataset.mapping).length;
      setNotice(
        `Attached ${result.dataset.name} to version ${targetVersion?.version ?? ''}. ` +
          (mapping > 0
            ? `${mapping} column${mapping === 1 ? '' : 's'} map to questions${publish ? ', and this form updates the matching case row on submit' : ''}.`
            : publish
              ? 'This form updates the matching case row on submit. No columns map to questions yet.'
              : 'No columns map to questions yet.'),
      );
    });

  const detach = (attachmentId: string): Promise<void> =>
    run(async () => {
      if (!versionId) return;
      await api.detachDataset(orgId, formId, versionId, attachmentId);
      await loadAttachments(versionId);
      setNotice('Detached. The dataset itself is unchanged.');
    });

  const openCase = (row: DatasetRowRecord): Promise<void> =>
    run(async () => {
      if (!publishedVersionId) {
        throw new Error('Publish this form before opening a case: a link to a draft would open a page that says the survey is not open.');
      }
      const link = await api.createLink(formId, 'anonymous');
      const path = link.collectPath.replace('/api/v1', '');
      const url = new URL(path, window.location.origin);
      url.searchParams.set('caseid', row.key);
      window.open(url.toString(), '_blank', 'noopener');
      setNotice(`Opened ${row.key} in a case link. The link was created now; its token is not stored.`);
    });

  return (
    <div className="stack grow">
      <div className="card">
        <div className="row wrap">
          <div className="grow">
            <span className="eyebrow">Program data</span>
            <h2>Cases and server datasets</h2>
            <p className="muted small">
              A dataset is an organisation table attached to a form version. The form can read it with{' '}
              <code>pulldata(&apos;cases&apos;, &apos;column&apos;, &apos;id&apos;, $&#123;caseid&#125;)</code> and,
              when write-back is on, update the matching row when a response is submitted.
            </p>
          </div>
          <label className="small muted">
            Version
            <select
              value={versionId ?? ''}
              onChange={(event) => setVersionId(event.target.value || null)}
            >
              {versions.map((version) => (
                <option key={version.id} value={version.id}>
                  v{version.version} {version.status}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {error && <p className="error small" role="alert">{error}</p>}
      {notice && <p className="small muted" role="status">{notice}</p>}

      <div className="card stack">
        <div className="row wrap">
          <label className="small muted grow">
            Dataset
            <select value={selectedId ?? ''} onChange={(event) => setSelectedId(event.target.value || null)}>
              <option value="">Choose a dataset</option>
              {datasets.map((dataset) => (
                <option key={dataset.id} value={dataset.id}>
                  {dataset.name} ({dataset.code}) · {dataset.kind} · {dataset.rowCount} row{dataset.rowCount === 1 ? '' : 's'}
                </option>
              ))}
            </select>
          </label>
          {selected && (
            <span className="pill">
              {selected.kind} · key {selected.uniqueField}
            </span>
          )}
        </div>

        <details>
          <summary className="small">Create a dataset</summary>
          <div className="row wrap">
            <label className="small muted grow">
              Code used in pulldata()
              <input
                value={newCode}
                onChange={(event) => setNewCode(event.target.value)}
                placeholder="cases"
              />
            </label>
            <label className="small muted grow">
              Display name
              <input
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                placeholder="Household cases"
              />
            </label>
            <label className="small muted">
              Kind
              <select value={newKind} onChange={(event) => setNewKind(event.target.value as 'data' | 'cases')}>
                <option value="cases">Cases</option>
                <option value="data">Data</option>
              </select>
            </label>
            <button type="button" onClick={() => void create()} disabled={busy || newCode.trim() === ''}>
              Create dataset
            </button>
          </div>
          <p className="muted small">The unique field is <code>id</code>. A CSV header named <code>id</code> is what case links use.</p>
        </details>

        <details open={Boolean(selected)}>
          <summary className="small">Import a CSV</summary>
          <div className="row wrap">
            <label className="small muted">
              On import
              <select value={mode} onChange={(event) => setMode(event.target.value as 'merge' | 'replace' | 'append')}>
                <option value="merge">Merge by key</option>
                <option value="replace">Replace every row</option>
                <option value="append">Append only new keys</option>
              </select>
            </label>
            <label className="small muted">
              CSV file
              <input type="file" accept=".csv,text/csv" onChange={importFile} disabled={!selectedId || busy} />
            </label>
          </div>
          <p className="muted small">
            The first row is the header. Values are stored as text, exactly as they appear in the file. A duplicate key
            in append mode is refused; merge updates it.
          </p>
        </details>

        <div className="row wrap">
          <label className="small muted grow">
            Key question (the answer that names a row)
            <input value={keyQuestion} onChange={(event) => setKeyQuestion(event.target.value)} placeholder="caseid" />
          </label>
          <label className="small muted">
            <input type="checkbox" checked={publish} onChange={(event) => setPublish(event.target.checked)} />{' '}
            Update this case on submit
          </label>
          <button type="button" onClick={() => void attach()} disabled={busy || !selectedId || !versionId}>
            Attach to version
          </button>
        </div>
        <p className="muted small">
          Columns whose names match question names are mapped automatically. The server returns the mapping it stored;
          nothing is mapped by guessing on the client.
        </p>

        {attachments.length > 0 && (
          <div className="stack tight">
            <strong className="small">Attached to {targetVersion ? `v${targetVersion.version}` : 'this version'}</strong>
            <table>
              <thead>
                <tr>
                  <th>Dataset</th>
                  <th>Key</th>
                  <th>Mapped</th>
                  <th>Write-back</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {attachments.map((attachment) => (
                  <tr key={attachment.id}>
                    <td className="small">
                      {attachment.name} <span className="muted">({attachment.code})</span>
                    </td>
                    <td className="small mono">{attachment.keyQuestion ?? '(case id)'}</td>
                    <td className="small">
                      {Object.keys(attachment.mapping).length > 0
                        ? Object.entries(attachment.mapping).map(([column, question]) => `${column} -> ${question}`).join(', ')
                        : '(none yet)'}
                    </td>
                    <td className="small">{attachment.publish ? 'on submit' : 'read only'}</td>
                    <td>
                      <button type="button" className="ghost" onClick={() => void detach(attachment.id)} disabled={busy}>
                        Detach
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="row wrap">
          <strong>{selected ? selected.name : 'Rows'}</strong>
          {detail && <span className="muted small">{detail.total} row{detail.total === 1 ? '' : 's'} in total, first {detail.rows.length} shown</span>}
        </div>
        {!selected && <p className="muted small">Create or choose a dataset to see its rows.</p>}
        {selected && detail && detail.rows.length === 0 && (
          <p className="muted small">No rows yet. Import a CSV above.</p>
        )}
        {detail && detail.rows.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Key</th>
                {detail.dataset.columns.slice(0, 5).map((column) => <th key={column}>{column}</th>)}
                {detail.dataset.kind === 'cases' && <th />}
              </tr>
            </thead>
            <tbody>
              {detail.rows.map((row) => (
                <tr key={row.key}>
                  <td className="mono small">{row.key}</td>
                  {detail.dataset.columns.slice(0, 5).map((column) => (
                    <td key={column} className="small">{label(row, column)}</td>
                  ))}
                  {detail.dataset.kind === 'cases' && (
                    <td>
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => void openCase(row)}
                        disabled={busy || !publishedVersionId}
                        title={publishedVersionId ? undefined : 'Publish the form first'}
                      >
                        Open case
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
