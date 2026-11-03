import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, describe, it } from 'node:test';
import {
  buildChartBody,
  buildDashboardBody,
  buildDashboardPosition,
  buildProvisionPlan,
  parseCsvRows,
  parseMonitorCsv,
  slugify,
  stableUuid,
  SupersetClient,
  SupersetError,
} from './superset-provision.mjs';

/**
 * These tests are deliberately split in two.
 *
 * The plan tests are pure: the CSV parser, the stable identifiers and the
 * dashboard layout can be checked without a server. The client tests run a real
 * HTTP server on localhost and assert the requests Superset would receive: the
 * upload is multipart with the documented fields, POSTs carry the bearer token
 * and CSRF token, and a second run updates the same charts and dashboard instead
 * of creating duplicates. They cannot prove a live Superset renders the result;
 * they prove this command sends the contract Superset documents.
 */

const CSV = `\uFEFFquestion_id,question_name,question_label,question_type,chart,group,answered,missing,submitted,table,row,value,count,share_percent\r
q1,q1,"Which cushion, shape?",select_one,bar,Reactions,4,0,4,option,Orthopedic,1,3,75.0\r
q1,q1,"Which cushion, shape?",select_one,bar,Reactions,4,0,4,option,Plush,2,1,25.0\r
q2,q2,"Features ""plus""",select_multiple,bar,Reactions,4,0,4,option,Washable cover,a,3,75.0\r
q2,q2,"Features ""plus""",select_multiple,bar,Reactions,4,0,4,option,Chew-proof edge,b,3,75.0\r
`;

const PLAN_OPTIONS = { title: 'Dog cushion field test', slug: 'dog-cushion' };

function plan() {
  return buildProvisionPlan(CSV, PLAN_OPTIONS);
}

function parseJson(value) {
  return JSON.parse(value);
}

describe('the Superset provisioning plan', () => {
  it('parses quoted commas, escaped quotes and a trailing newline', () => {
    const rows = parseCsvRows('a,b\r\n"one, two","he said ""hi"""\r\n');
    assert.deepEqual(rows, [
      ['a', 'b'],
      ['one, two', 'he said "hi"'],
    ]);
    const monitor = parseMonitorCsv(CSV);
    assert.equal(monitor.rows.length, 4);
    assert.equal(monitor.rows[0].question_label, 'Which cushion, shape?');
    assert.equal(monitor.rows[2].question_label, 'Features "plus"');
  });

  it('refuses a CSV that is not a monitor export', () => {
    assert.throws(() => parseMonitorCsv('question_name,count\r\nq1,2\r\n'), SupersetError);
  });

  it('builds a deterministic dashboard plan from the monitor rows', () => {
    const first = plan();
    const second = plan();
    assert.deepEqual(first, second);
    assert.equal(first.tableName, 'inicio_monitor_dog_cushion_field_test');
    assert.equal(first.dashboardSlug, 'inicio-dog-cushion');
    assert.equal(first.rowCount, 4);
    assert.equal(first.questionCount, 2);
    assert.equal(first.submitted, 4);
    assert.equal(first.charts.length, 3);
    assert.equal(first.charts[2].params.all_columns.length, 14);
    assert.equal(first.charts[2].params.all_columns.includes('question_label'), true);
  });

  it('uses valid, stable UUIDs for repeated imports', () => {
    const uuid = stableUuid('inicio-dog-cushion:submitted');
    assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(uuid, stableUuid('inicio-dog-cushion:submitted'));
    assert.notEqual(uuid, stableUuid('inicio-dog-cushion:questions'));
  });

  it('puts every chart on the dashboard grid', () => {
    const charts = [
      { key: 'submitted', id: 11, uuid: stableUuid('submitted'), sliceName: 'Submitted' },
      { key: 'questions', id: 12, uuid: stableUuid('questions'), sliceName: 'Questions' },
      { key: 'table', id: 13, uuid: stableUuid('table'), sliceName: 'Table' },
    ];
    const position = buildDashboardPosition(plan(), charts);
    assert.deepEqual(position.ROOT_ID.children, ['GRID_ID']);
    assert.deepEqual(position.GRID_ID.children, ['ROW-KPI', 'ROW-TABLE']);
    assert.deepEqual(position['ROW-KPI'].children, ['CHART-11', 'CHART-12']);
    assert.deepEqual(position['ROW-TABLE'].children, ['CHART-13']);
    assert.equal(position['CHART-13'].meta.chartId, 13);
    assert.equal(position['CHART-13'].meta.width, 12);
  });

  it('sends the dataset uid Superset expects in chart params', () => {
    const chart = plan().charts[2];
    const body = buildChartBody(chart, 7, stableUuid('table'));
    assert.equal(body.datasource_id, 7);
    assert.equal(body.datasource_type, 'table');
    assert.equal(parseJson(body.params).datasource, '7__table');
    assert.equal(parseJson(body.params).query_mode, 'raw');
  });

  it('keeps the dashboard metadata a string, as the API schema requires', () => {
    const body = buildDashboardBody(plan(), [
      { key: 'submitted', id: 11, uuid: stableUuid('submitted'), sliceName: 'Submitted' },
    ]);
    assert.equal(typeof body.position_json, 'string');
    assert.equal(typeof body.json_metadata, 'string');
    assert.equal(parseJson(body.json_metadata).version, '1.0.0');
    assert.equal(parseJson(body.position_json).DASHBOARD_VERSION_KEY, 'v2');
  });

  it('slugifies titles without leaving a leading or trailing dash', () => {
    assert.equal(slugify('  Café / Dog cushion  '), 'cafe-dog-cushion');
    assert.equal(slugify('///'), 'monitor');
  });
});

describe('the Superset client contract', () => {
  let server;
  let baseUrl;
  const requests = [];
  const charts = new Map();
  let dashboard = null;
  let dataset = null;

  function send(response, status, body) {
    response.statusCode = status;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(body));
  }

  before(async () => {
    server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString('utf8');
      const url = request.url ?? '/';
      requests.push({ method: request.method, path: url, headers: request.headers, body });

      if (url === '/api/v1/security/login' && request.method === 'POST') {
        response.setHeader('set-cookie', 'session=abc123; Path=/; HttpOnly');
        return send(response, 200, { access_token: 'token-abc' });
      }
      if (url === '/api/v1/security/csrf_token/' && request.method === 'GET') {
        return send(response, 200, { result: 'csrf-abc' });
      }
      if (url.startsWith('/api/v1/database/?q=') && request.method === 'GET') {
        return send(response, 200, {
          result: [{ id: 1, database_name: 'Inicio BI', allow_file_upload: false }],
        });
      }
      if (url === '/api/v1/database/1' && request.method === 'PUT') {
        return send(response, 200, { id: 1, result: { allow_file_upload: true } });
      }
      if (url === '/api/v1/database/1/upload/' && request.method === 'POST') {
        const table = /name="table_name"\r\n\r\n([^\r\n]+)/.exec(body)?.[1] ?? 'inicio_monitor_test';
        dataset = { id: 7, table_name: table, schema: 'public' };
        return send(response, 201, { message: 'OK' });
      }
      if (url.startsWith('/api/v1/dataset/?q=') && request.method === 'GET') {
        return send(response, 200, { result: dataset ? [dataset] : [] });
      }
      if (url.startsWith('/api/v1/chart/?q=') && request.method === 'GET') {
        return send(response, 200, { result: [...charts.values()] });
      }
      if (url === '/api/v1/chart/' && request.method === 'POST') {
        const payload = JSON.parse(body);
        const id = 10 + charts.size + 1;
        charts.set(id, { id, slice_name: payload.slice_name, uuid: payload.uuid });
        return send(response, 201, { id, result: { uuid: payload.uuid } });
      }
      if (/^\/api\/v1\/chart\/\d+$/.test(url) && request.method === 'PUT') {
        const id = Number(url.split('/').at(-1));
        const payload = JSON.parse(body);
        charts.set(id, { id, slice_name: payload.slice_name, uuid: payload.uuid });
        return send(response, 200, { id, result: { uuid: payload.uuid } });
      }
      if (url.startsWith('/api/v1/dashboard/?q=') && request.method === 'GET') {
        return send(response, 200, { result: dashboard ? [dashboard] : [] });
      }
      if (url === '/api/v1/dashboard/' && request.method === 'POST') {
        const payload = JSON.parse(body);
        dashboard = { id: 5, slug: payload.slug, dashboard_title: payload.dashboard_title };
        return send(response, 201, { id: 5, result: dashboard });
      }
      if (url === '/api/v1/dashboard/5' && request.method === 'PUT') {
        const payload = JSON.parse(body);
        dashboard = { id: 5, slug: payload.slug, dashboard_title: payload.dashboard_title };
        return send(response, 200, { id: 5, result: dashboard });
      }
      return send(response, 404, { message: `no route for ${request.method} ${url}` });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('uploads multipart CSV, creates the dashboard once and updates it on a second run', async () => {
    const client = new SupersetClient({
      baseUrl,
      username: 'admin',
      password: 'super-secret',
      fetchImpl: fetch,
    });
    const first = await client.login().then(() =>
      client.provision({
        csv: CSV,
        plan: plan(),
        databaseUri: 'postgresql+psycopg2://superset:secret@db:5432/inicio_bi',
        schema: 'public',
      }),
    );

    assert.equal(first.databaseId, 1);
    assert.equal(first.datasetId, 7);
    assert.equal(first.dashboardId, 5);
    assert.equal(first.charts.length, 3);
    assert.match(first.dashboardUrl, /\/superset\/dashboard\/inicio-dog-cushion\/$/);

    const upload = requests.find((entry) => entry.path === '/api/v1/database/1/upload/');
    assert.ok(upload);
    assert.equal(upload.headers.authorization, 'Bearer token-abc');
    assert.equal(upload.headers['x-csrftoken'], 'csrf-abc');
    assert.match(String(upload.headers['content-type']), /^multipart\/form-data; boundary=/);
    assert.match(upload.body, /name="table_name"\r\n\r\ninicio_monitor_dog_cushion_field_test/);
    assert.match(upload.body, /name="already_exists"\r\n\r\nreplace/);
    assert.match(upload.body, /name="type"\r\n\r\ncsv/);

    assert.equal(requests.filter((entry) => entry.method === 'POST' && entry.path === '/api/v1/chart/').length, 3);
    assert.equal(requests.filter((entry) => entry.method === 'POST' && entry.path === '/api/v1/dashboard/').length, 1);

    const second = await client.provision({
      csv: CSV,
      plan: plan(),
      databaseId: 1,
      schema: 'public',
    });
    assert.equal(second.dashboardId, 5);
    assert.equal(requests.filter((entry) => entry.method === 'POST' && entry.path === '/api/v1/chart/').length, 3);
    assert.equal(requests.filter((entry) => entry.method === 'PUT' && /^\/api\/v1\/chart\/\d+$/.test(entry.path)).length, 3);
    assert.equal(requests.filter((entry) => entry.method === 'PUT' && entry.path === '/api/v1/dashboard/5').length, 1);
  });

  it('does not leak the Superset password in an error message', async () => {
    const failingFetch = async () => ({
      ok: false,
      status: 401,
      headers: { get: () => null, getSetCookie: () => [] },
      text: async () => JSON.stringify({ message: 'bad password super-secret' }),
    });
    const client = new SupersetClient({
      baseUrl: 'http://superset.invalid',
      username: 'admin',
      password: 'super-secret',
      fetchImpl: failingFetch,
    });
    await assert.rejects(client.login(), (error) => {
      assert.ok(error instanceof SupersetError);
      assert.equal(error.message.includes('super-secret'), false);
      assert.match(error.message, /\[redacted\]/);
      return true;
    });
  });
});
