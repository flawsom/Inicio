#!/usr/bin/env node
/**
 * Publish the Inicio monitor tables to a self-hosted Apache Superset instance.
 *
 * Superset is Apache-2.0 software: there is no seat licence, report cap or
 * feature gate to pay for. What it needs is a server, and this command is the
 * bridge between Inicio's existing CSV export and that server.
 *
 * The command deliberately uploads the tidy monitor CSV rather than connecting
 * Superset to the application database. That keeps the reporting copy to the
 * aggregate rows the screen already shows, and it means this path needs no new
 * database role, no RLS bypass and no production credential in the BI service.
 * Re-running it replaces the snapshot table and updates the charts and dashboard
 * in place; it does not create a second dashboard every time.
 *
 * Usage:
 *   pnpm superset:provision -- --csv ./inicio-monitor.csv --dry-run
 *   pnpm superset:provision -- --csv ./inicio-monitor.csv
 *   pnpm superset:provision -- --csv ./inicio-monitor.csv \
 *     --database-uri 'postgresql+psycopg2://superset:superset@db:5432/inicio_bi'
 *
 * Environment:
 *   SUPERSET_URL              default http://localhost:8088
 *   SUPERSET_USERNAME         default admin
 *   SUPERSET_PASSWORD         required for a live run
 *   SUPERSET_DATABASE_ID      existing Superset database id (optional)
 *   SUPERSET_BI_DATABASE_URI  create/find the BI database by URI (optional)
 *   SUPERSET_SCHEMA           default public
 *   SUPERSET_DATABASE_NAME    default Inicio BI
 *
 * The command never prints the Superset password or a session token.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const DEFAULT_TIMEOUT_MS = 120_000;
const DASHBOARD_VERSION = '1.0.0';
const REQUIRED_COLUMNS = [
  'question_id',
  'question_name',
  'question_label',
  'question_type',
  'chart',
  'group',
  'answered',
  'missing',
  'submitted',
  'table',
  'row',
  'value',
  'count',
  'share_percent',
];
const TABLE_COLUMNS = [...REQUIRED_COLUMNS];

export class SupersetError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'SupersetError';
    this.status = status;
  }
}

/** A stable UUID so an import/refresh updates the same objects instead of duplicating them. */
export function stableUuid(seed) {
  const hash = createHash('sha256').update(seed).digest('hex');
  const variant = ((Number.parseInt(hash[16], 16) & 0x3) | 0x8).toString(16);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export function slugify(value) {
  const slug = String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'monitor';
}

function safeIdentifier(value) {
  const identifier = slugify(value).replaceAll('-', '_');
  return /^[a-z_]/.test(identifier) ? identifier : `monitor_${identifier}`;
}

function tableNameFor(value) {
  const identifier = `inicio_monitor_${safeIdentifier(value)}`;
  // PostgreSQL identifiers are limited to 63 bytes. A suffix keeps two long
  // question-set titles from becoming the same table.
  if (identifier.length <= 63) return identifier;
  const suffix = createHash('sha256').update(identifier).digest('hex').slice(0, 8);
  return `${identifier.slice(0, 54)}_${suffix}`;
}

/**
 * A small RFC 4180 reader. The monitor export quotes labels containing commas
 * and line breaks, so splitting on commas would turn one answer into two rows.
 */
export function parseCsvRows(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
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
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\r' || character === '\n') {
      if (character === '\r' && source[index + 1] === '\n') index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // A trailing newline produces one empty row; it is not data.
  return rows.filter((candidate) => candidate.some((cell) => cell !== ''));
}

export function parseMonitorCsv(text) {
  const rows = parseCsvRows(text);
  const header = rows.shift()?.map((column) => column.trim()) ?? [];
  const missing = REQUIRED_COLUMNS.filter((column) => !header.includes(column));
  if (missing.length > 0) {
    throw new SupersetError(`the monitor CSV is missing ${missing.join(', ')}`, 400);
  }
  const records = rows.map((values) => {
    const record = {};
    for (const [index, column] of header.entries()) record[column] = values[index] ?? '';
    return record;
  });
  return { header, rows: records };
}

function numeric(value) {
  const parsed = Number(String(value ?? '').replaceAll(',', '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function adhocMetric(expression, label, optionName) {
  return {
    expressionType: 'SQL',
    sqlExpression: expression,
    label,
    hasCustomLabel: true,
    optionName,
  };
}

export function buildProvisionPlan(csvText, options = {}) {
  const { header, rows } = parseMonitorCsv(csvText);
  const title = String(options.title ?? '').trim() || 'Inicio live monitor';
  const slug = slugify(options.slug || title);
  const tableName = options.table
    ? safeIdentifier(options.table).slice(0, 63)
    : tableNameFor(title);
  const submitted = rows.reduce((maximum, row) => Math.max(maximum, numeric(row.submitted)), 0);
  const questionNames = new Set(rows.map((row) => row.question_name).filter(Boolean));
  const chartColumns = TABLE_COLUMNS.filter((column) => header.includes(column));

  return {
    schemaVersion: 1,
    title,
    slug,
    tableName,
    datasetName: title,
    dashboardTitle: `${title} · Live monitor`,
    dashboardSlug: `inicio-${slug}`.slice(0, 255),
    rowCount: rows.length,
    questionCount: questionNames.size,
    submitted,
    chartColumns,
    charts: [
      {
        key: 'submitted',
        sliceName: `${title} · Submitted responses`,
        vizType: 'big_number_total',
        description: 'Submitted responses in the latest monitor snapshot.',
        params: {
          viz_type: 'big_number_total',
          metric: adhocMetric('MAX(submitted)', 'Submitted responses', 'metric_submitted'),
          adhoc_filters: [],
          time_range: 'No filter',
          subheader: 'Submitted responses',
          y_axis_format: 'SMART_NUMBER',
        },
      },
      {
        key: 'questions',
        sliceName: `${title} · Answerable questions`,
        vizType: 'big_number_total',
        description: 'Distinct answerable questions represented in this snapshot.',
        params: {
          viz_type: 'big_number_total',
          metric: adhocMetric('COUNT_DISTINCT(question_name)', 'Answerable questions', 'metric_questions'),
          adhoc_filters: [],
          time_range: 'No filter',
          subheader: 'Answerable questions',
          y_axis_format: 'SMART_NUMBER',
        },
      },
      {
        key: 'table',
        sliceName: `${title} · Monitor tables`,
        vizType: 'table',
        description: 'Every plotted value with its answered, missing and submitted base.',
        params: {
          viz_type: 'table',
          query_mode: 'raw',
          all_columns: chartColumns,
          order_by_cols: [],
          row_limit: 1000,
          include_search: true,
          table_filter: false,
          time_range: 'No filter',
          adhoc_filters: [],
        },
      },
    ],
  };
}

export function buildChartBody(chart, datasetId, uuid) {
  return {
    slice_name: chart.sliceName,
    description: chart.description ?? null,
    viz_type: chart.vizType,
    datasource_id: datasetId,
    datasource_type: 'table',
    params: JSON.stringify({ ...chart.params, datasource: `${datasetId}__table` }),
    uuid,
  };
}

export function buildDashboardPosition(plan, charts) {
  const rows = [
    { id: 'ROW-KPI', chartKeys: ['submitted', 'questions'], height: 22, width: 6 },
    { id: 'ROW-TABLE', chartKeys: ['table'], height: 46, width: 12 },
  ];
  const position = {
    DASHBOARD_VERSION_KEY: 'v2',
    ROOT_ID: { children: ['GRID_ID'], id: 'ROOT_ID', type: 'ROOT' },
    GRID_ID: { children: rows.map((row) => row.id), id: 'GRID_ID', parents: ['ROOT_ID'], type: 'GRID' },
    HEADER_ID: { id: 'HEADER_ID', meta: { text: plan.dashboardTitle }, type: 'HEADER' },
  };

  for (const row of rows) {
    const chartIds = [];
    for (const key of row.chartKeys) {
      const chart = charts.find((candidate) => candidate.key === key);
      if (!chart) continue;
      const positionId = `CHART-${chart.id}`;
      chartIds.push(positionId);
      position[positionId] = {
        children: [],
        id: positionId,
        meta: {
          chartId: chart.id,
          height: row.height,
          sliceName: chart.sliceName,
          uuid: chart.uuid,
          width: row.width,
        },
        type: 'CHART',
        parents: ['ROOT_ID', 'GRID_ID', row.id],
      };
    }
    position[row.id] = {
      children: chartIds,
      id: row.id,
      meta: { '0': 'ROOT_ID', background: 'BACKGROUND_TRANSPARENT' },
      type: 'ROW',
      parents: ['ROOT_ID', 'GRID_ID'],
    };
  }
  return position;
}

export function buildDashboardBody(plan, charts) {
  return {
    dashboard_title: plan.dashboardTitle,
    slug: plan.dashboardSlug,
    published: true,
    position_json: JSON.stringify(buildDashboardPosition(plan, charts)),
    json_metadata: JSON.stringify({
      timed_refresh_immune_slices: [],
      expanded_slices: {},
      refresh_frequency: 0,
      color_scheme: '',
      label_colors: {},
      shared_label_colors: [],
      version: DASHBOARD_VERSION,
    }),
    uuid: stableUuid(`${plan.dashboardSlug}:dashboard`),
  };
}

function cookieLines(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const combined = headers.get('set-cookie');
  return combined ? [combined] : [];
}

function redact(text, secrets) {
  let safe = String(text);
  for (const secret of secrets) {
    if (secret) safe = safe.split(secret).join('[redacted]');
  }
  return safe;
}

function responseMessage(data) {
  if (typeof data?.message === 'string' && data.message.trim()) return data.message;
  if (Array.isArray(data?.errors)) {
    const messages = data.errors
      .map((error) => (typeof error?.message === 'string' ? error.message : ''))
      .filter(Boolean);
    if (messages.length > 0) return messages.join('; ');
  }
  if (typeof data?.error === 'string' && data.error.trim()) return data.error;
  return '';
}

export class SupersetClient {
  constructor({ baseUrl, username, password, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.username = username;
    this.password = password;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.token = null;
    this.csrfToken = null;
    this.cookies = new Map();
  }

  absorbCookies(headers) {
    for (const line of cookieLines(headers)) {
      const pair = line.split(';', 1)[0];
      const equals = pair.indexOf('=');
      if (equals > 0) this.cookies.set(pair.slice(0, equals), pair.slice(equals + 1));
    }
  }

  cookieHeader() {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  async request(path, options = {}) {
    const method = options.method ?? 'GET';
    const headers = { accept: 'application/json', ...(options.headers ?? {}) };
    if (options.auth !== false && this.token) headers.authorization = `Bearer ${this.token}`;
    const cookie = this.cookieHeader();
    if (cookie) headers.cookie = cookie;
    if (options.csrf !== false && method !== 'GET' && this.csrfToken) headers['x-csrftoken'] = this.csrfToken;

    let body;
    if (options.form) {
      body = options.form;
    } else if (options.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.json);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body,
        signal: controller.signal,
        redirect: 'follow',
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new SupersetError(`Superset did not answer within ${this.timeoutMs}ms`, 0);
      }
      throw new SupersetError(redact(`could not reach Superset at ${this.baseUrl}: ${error?.message ?? error}`, [this.password]));
    } finally {
      clearTimeout(timer);
    }

    this.absorbCookies(response.headers);
    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    if (!response.ok) {
      const detail = responseMessage(data) || `Superset returned HTTP ${response.status}`;
      throw new SupersetError(redact(`Superset ${response.status}: ${detail}`, [this.password]), response.status);
    }
    return data;
  }

  async login() {
    const data = await this.request('/api/v1/security/login', {
      method: 'POST',
      auth: false,
      csrf: false,
      json: {
        username: this.username,
        password: this.password,
        provider: 'db',
        refresh: false,
      },
    });
    if (typeof data?.access_token !== 'string' || data.access_token.length === 0) {
      throw new SupersetError('Superset did not return an access token', 401);
    }
    this.token = data.access_token;
    const csrf = await this.request('/api/v1/security/csrf_token/');
    this.csrfToken = typeof csrf?.result === 'string' ? csrf.result : null;
    if (!this.csrfToken) throw new SupersetError('Superset did not return a CSRF token', 401);
    return this;
  }

  async list(path) {
    const data = await this.request(path);
    return Array.isArray(data?.result) ? data.result : [];
  }

  async ensureDatabase({ id, uri, name = 'Inicio BI', schema = 'public' }) {
    if (id) return Number(id);
    const databases = await this.list('/api/v1/database/?q=%28page_size%3A100%29');
    const existing = databases.find((database) => database.database_name === name);
    if (existing) {
      // A database created by hand may not allow uploads. Make the setting
      // explicit on every run rather than failing at the upload step.
      await this.request(`/api/v1/database/${existing.id}`, {
        method: 'PUT',
        json: {
          allow_file_upload: true,
          extra: JSON.stringify({ schemas_allowed_for_file_upload: [schema] }),
        },
      });
      return Number(existing.id);
    }
    if (!uri) {
      throw new SupersetError(
        `no Superset database named "${name}" exists; create one or pass --database-uri`,
        400,
      );
    }
    const data = await this.request('/api/v1/database/', {
      method: 'POST',
      json: {
        database_name: name,
        sqlalchemy_uri: uri,
        expose_in_sqllab: true,
        allow_file_upload: true,
        extra: JSON.stringify({ schemas_allowed_for_file_upload: [schema] }),
      },
    });
    const createdId = data?.id ?? data?.result?.id;
    if (!createdId) throw new SupersetError('Superset created a database but returned no id', 500);
    return Number(createdId);
  }

  async uploadCsv({ databaseId, tableName, schema, csv }) {
    const form = new FormData();
    form.append('file', new Blob([csv], { type: 'text/csv;charset=utf-8' }), `${tableName}.csv`);
    form.append('table_name', tableName);
    form.append('type', 'csv');
    form.append('already_exists', 'replace');
    form.append('schema', schema);
    await this.request(`/api/v1/database/${databaseId}/upload/`, { method: 'POST', form });
  }

  async ensureDataset({ databaseId, tableName, schema, name }) {
    const datasets = await this.list('/api/v1/dataset/?q=%28page_size%3A100%29');
    const existing = datasets.find(
      (dataset) => dataset.table_name === tableName && (dataset.schema ?? schema) === schema,
    );
    if (existing) return Number(existing.id);
    const data = await this.request('/api/v1/dataset/', {
      method: 'POST',
      json: {
        database: databaseId,
        table_name: tableName,
        schema,
      },
    });
    const createdId = data?.id ?? data?.result?.id;
    if (!createdId) throw new SupersetError(`Superset uploaded ${name} but returned no dataset id`, 500);
    return Number(createdId);
  }

  async upsertChart({ plan, chart, datasetId }) {
    const existingCharts = await this.list('/api/v1/chart/?q=%28page_size%3A200%29');
    const existing = existingCharts.find((candidate) => candidate.slice_name === chart.sliceName);
    const uuid = existing?.uuid ?? stableUuid(`${plan.dashboardSlug}:${chart.key}`);
    const body = buildChartBody(chart, datasetId, uuid);
    if (existing) {
      await this.request(`/api/v1/chart/${existing.id}`, { method: 'PUT', json: body });
      return { id: Number(existing.id), uuid };
    }
    const data = await this.request('/api/v1/chart/', { method: 'POST', json: body });
    const id = data?.id ?? data?.result?.id;
    if (!id) throw new SupersetError(`Superset did not return an id for "${chart.sliceName}"`, 500);
    return { id: Number(id), uuid: data?.result?.uuid ?? uuid };
  }

  async upsertDashboard({ plan, charts }) {
    const dashboards = await this.list('/api/v1/dashboard/?q=%28page_size%3A100%29');
    const existing = dashboards.find(
      (dashboard) => dashboard.slug === plan.dashboardSlug || dashboard.dashboard_title === plan.dashboardTitle,
    );
    const body = buildDashboardBody(plan, charts);
    if (existing) {
      await this.request(`/api/v1/dashboard/${existing.id}`, { method: 'PUT', json: body });
      return { id: Number(existing.id), slug: plan.dashboardSlug };
    }
    const data = await this.request('/api/v1/dashboard/', { method: 'POST', json: body });
    const id = data?.id ?? data?.result?.id;
    if (!id) throw new SupersetError('Superset created a dashboard but returned no id', 500);
    return { id: Number(id), slug: data?.result?.slug ?? plan.dashboardSlug };
  }

  async provision({ csv, plan, databaseId, databaseUri, databaseName, schema = 'public' }) {
    const id = await this.ensureDatabase({
      id: databaseId,
      uri: databaseUri,
      name: databaseName,
      schema,
    });
    await this.uploadCsv({ databaseId: id, tableName: plan.tableName, schema, csv });
    const datasetId = await this.ensureDataset({
      databaseId: id,
      tableName: plan.tableName,
      schema,
      name: plan.datasetName,
    });
    const charts = [];
    for (const chart of plan.charts) {
      const saved = await this.upsertChart({ plan, chart, datasetId });
      charts.push({ ...chart, ...saved });
    }
    const dashboard = await this.upsertDashboard({ plan, charts });
    return {
      databaseId: id,
      datasetId,
      dashboardId: dashboard.id,
      dashboardSlug: dashboard.slug,
      dashboardUrl: `${this.baseUrl}/superset/dashboard/${encodeURIComponent(dashboard.slug)}/`,
      charts: charts.map((chart) => ({ key: chart.key, id: chart.id, name: chart.sliceName })),
    };
  }
}

const HELP = `Publish the Inicio monitor CSV to Apache Superset.

Usage:
  pnpm superset:provision -- --csv <file.csv> [options]

Options:
  --csv <path>             the monitor CSV exported by Inicio (required)
  --title <title>          dashboard title (defaults to the CSV file name)
  --slug <slug>            stable slug/table prefix (defaults from the title)
  --table <name>           Superset table name (defaults from the title)
  --url <url>              Superset base URL (or SUPERSET_URL, default http://localhost:8088)
  --username <name>        Superset login (or SUPERSET_USERNAME, default admin)
  --database-id <id>       existing Superset database id (or SUPERSET_DATABASE_ID)
  --database-uri <uri>     create/find the BI database by URI (or SUPERSET_BI_DATABASE_URI)
  --database-name <name>   Superset database display name (default Inicio BI)
  --schema <name>          schema for the upload (default public)
  --dry-run                print the dashboard plan without contacting Superset
  --help                   print this text

Required for a live run:
  SUPERSET_PASSWORD

The command never prints the Superset password or the session token.
`;

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv.filter((argument) => argument !== '--'),
    options: {
      csv: { type: 'string' },
      title: { type: 'string' },
      slug: { type: 'string' },
      table: { type: 'string' },
      url: { type: 'string' },
      username: { type: 'string' },
      'database-id': { type: 'string' },
      'database-uri': { type: 'string' },
      'database-name': { type: 'string' },
      schema: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  if (!values.csv) throw new SupersetError('--csv is required', 400);

  const csv = await readFile(values.csv, 'utf8');
  const fallbackTitle = basename(values.csv, extname(values.csv));
  const plan = buildProvisionPlan(csv, {
    title: values.title ?? fallbackTitle,
    slug: values.slug,
    table: values.table,
  });

  if (values['dry-run']) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    process.stdout.write(
      `\nDry run: ${plan.charts.length} charts, ${plan.rowCount} rows, ${plan.questionCount} questions, ${plan.submitted} submitted.\n`,
    );
    return;
  }

  const password = process.env.SUPERSET_PASSWORD;
  if (!password) {
    throw new SupersetError('SUPERSET_PASSWORD is required for a live run', 400);
  }
  const baseUrl = values.url ?? process.env.SUPERSET_URL ?? 'http://localhost:8088';
  const username = values.username ?? process.env.SUPERSET_USERNAME ?? 'admin';
  const databaseId = values['database-id'] ?? process.env.SUPERSET_DATABASE_ID;
  const databaseUri = values['database-uri'] ?? process.env.SUPERSET_BI_DATABASE_URI;
  const databaseName = values['database-name'] ?? process.env.SUPERSET_DATABASE_NAME ?? 'Inicio BI';
  const schema = values.schema ?? process.env.SUPERSET_SCHEMA ?? 'public';

  const client = new SupersetClient({ baseUrl, username, password });
  await client.login();
  const result = await client.provision({
    csv,
    plan,
    databaseId: databaseId ? Number(databaseId) : undefined,
    databaseUri,
    databaseName,
    schema,
  });
  process.stdout.write(`Superset dashboard: ${result.dashboardUrl}\n`);
  process.stdout.write(
    `database ${result.databaseId} · dataset ${result.datasetId} · dashboard ${result.dashboardId} · ${result.charts.length} charts\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
