/**
 * End-to-end consumer walk-through against the running dev stack, through the
 * same origin the browser uses (the Vite server on :3000, which proxies /api/v1).
 *
 * Everything here is real: a real session is minted for the real owner account,
 * a real organisation, form, published version and link are created, and real
 * unauthenticated respondent submissions are made. Nothing is stubbed.
 */
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { Client } = require('pg');

const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:3000';
const API = `${BASE}/api/v1`;
const OWNER_EMAIL = process.env.E2E_OWNER;
if (!OWNER_EMAIL) {
  console.error('E2E_OWNER must be set to the email of an existing platform account (the harness drives the invitation gate as that account).');
  process.exit(2);
}
const SUPER = process.env.MIGRATION_DATABASE_URL;
if (!SUPER) {
  console.error('MIGRATION_DATABASE_URL must be set to the owner connection for the database under test.');
  process.exit(2);
}

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(`${name} :: ${detail}`); console.log(`  FAIL  ${name}  ${detail}`); }
}
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

class Session {
  constructor() { this.cookie = null; }
  async bytes(path) {
    const res = await fetch(`${API}${path}`, { headers: this.cookie ? { cookie: this.cookie } : {} });
    return { status: res.status, buffer: Buffer.from(await res.arrayBuffer()), headers: res.headers };
  }
  async req(method, path, body, extraHeaders = {}) {
    const url = path.startsWith('http') ? path : `${API}${path}`;
    const headers = { ...extraHeaders };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.cookie) headers.cookie = this.cookie;
    const res = await fetch(url, {
      method, headers, redirect: 'manual',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of (res.headers.getSetCookie?.() ?? [])) {
      const pair = c.split(';')[0];
      if (pair.split('=')[0] === 'sid') this.cookie = pair;
    }
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* bytes */ }
    return { status: res.status, json, text, headers: res.headers, bytes: Buffer.from(text, 'binary') };
  }
}
async function raw(path, init) { return fetch(path.startsWith('http') ? path : `${BASE}${path}`, init); }

const superClient = new Client({ connectionString: SUPER });

async function main() {
  await superClient.connect();

  const owner = (await superClient.query('SELECT id, email FROM app_user WHERE email = $1::citext', [OWNER_EMAIL])).rows[0];
  check('owner account exists in the live database', Boolean(owner), OWNER_EMAIL);
  if (!owner) return;

  // Mint a session the way the login route would, so the harness authenticates
  // as the real owner without mailing a code.
  const token = `e2e-${randomUUID()}`;
  await superClient.query(
    `INSERT INTO session (subject, token_hash, expires_at) VALUES ($1,$2, now() + interval '1 hour')`,
    [`user:${owner.id}`, sha256(token)],
  );

  const s = new Session();
  s.cookie = `sid=${token}`;

  console.log('\n== identity and tenancy ==');
  const me = await s.req('GET', '/auth/me');
  check('GET /auth/me is the owner', me.status === 200 && me.json?.user?.email === OWNER_EMAIL, JSON.stringify(me.json));
  // The terms gate is part of the consumer journey: a fresh account can reach
  // /me and the acceptance route and nothing else until it ticks the box. The
  // harness ticks it the way the page does, then re-reads the status.
  let terms = await s.req('GET', '/auth/terms/status');
  if (terms.json?.required) {
    // Until the box is ticked, an authenticated account can reach /me and the
    // acceptance route and nothing else. Prove that, then accept.
    const blocked = await s.req('GET', '/forms');
    check('an account that has not accepted is refused at the data routes', blocked.status === 403, `status ${blocked.status}`);
    const accepted = await s.req('POST', '/auth/terms/accept', {
      termsVersion: terms.json.terms.version,
      privacyVersion: terms.json.privacy.version,
      accepted: true,
    });
    check('accepting the terms opens the account', accepted.status === 200 && accepted.json?.accepted === true, JSON.stringify(accepted.json));
    terms = await s.req('GET', '/auth/terms/status');
  }
  check('the current terms are accepted', terms.status === 200 && terms.json?.required === false, JSON.stringify(terms.json));

  const stamp = Date.now().toString(36);
  const orgName = `E2E Consumer ${stamp}`;
  const orgRes = await s.req('POST', '/orgs', { name: orgName });
  const orgId = orgRes.json?.organisation?.id;
  check('created a real organisation', orgRes.status === 201 && Boolean(orgId), JSON.stringify(orgRes.json));

  console.log('\n== authoring ==');
  const templates = await s.req('GET', '/templates');
  const tpl = (templates.json?.templates ?? []).find((t) => t.id === 'service-feedback');
  check('template catalogue has a real question count', tpl?.questionCount === 3, JSON.stringify(tpl));

  const createForm = await s.req('POST', '/forms', { orgId, name: `Feedback ${stamp}`, templateId: 'service-feedback' });
  const formId = createForm.json?.form?.id;
  let versionId = createForm.json?.version?.id;
  check('created a form from a template', createForm.status === 201 && Boolean(formId), JSON.stringify(createForm.json));

  const beforePublish = await s.req('POST', `/forms/${formId}/links`, { kind: 'anonymous' });
  const beforeToken = beforePublish.json?.token;
  const beforeCollect = await raw(`${API}/collect/${beforeToken}`);
  const beforeBody = await beforeCollect.json().catch(() => null);
  check('unpublished form: respondent sees a plain "not open yet"', beforeCollect.status === 409 && /not open yet/i.test(beforeBody?.message ?? ''), JSON.stringify(beforeBody));

  const publish = await s.req('POST', `/forms/${formId}/versions/${versionId}/publish`);
  check('published the version', publish.status === 200 && publish.json?.version?.status === 'published', JSON.stringify(publish.json));

  console.log('\n== distribution and real respondent submissions ==');
  const linkRes = await s.req('POST', `/forms/${formId}/links`, { kind: 'anonymous', label: 'e2e' });
  const anonToken = linkRes.json?.token;
  check('created a public link (token shown once)', linkRes.status === 201 && typeof anonToken === 'string' && anonToken.length >= 32, JSON.stringify(linkRes.json));

  const collect = await raw(`${API}/collect/${anonToken}`);
  const collectBody = await collect.json();
  check('respondent loads the live definition', collect.status === 200 && collectBody?.form?.version >= 1, JSON.stringify(collectBody).slice(0, 200));

  const html = await raw(`${BASE}/collect/${anonToken}`);
  const htmlText = await html.text();
  check('collect page is served to a browser', html.status === 200 && /<div id="root"/.test(htmlText), `status ${html.status}`);

  const submissions = [
    { rating: 'good', nps: 9, comment: 'Faster load times please.' },
    { rating: 'poor', nps: 3, comment: 'The export download stalled once.' },
    { rating: 'excellent', nps: 10, comment: 'ignored because rating is excellent' },
  ];
  const ids = [];
  for (const [i, answers] of submissions.entries()) {
    const start = await raw(`${API}/collect/${anonToken}/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    const responseId = (await start.json())?.responseId;
    const submit = await raw(`${API}/collect/${anonToken}/responses/${responseId}/submit`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answers }),
    });
    const ok = submit.status === 200 && (await submit.json())?.status === 'submitted';
    ids.push(responseId);
    check(`respondent ${i + 1} submitted a real response`, ok, `status ${submit.status}`);
  }

  console.log('\n== live reads (no caching) ==');
  const responses = await s.req('GET', `/forms/${formId}/responses?limit=200`);
  const submitted = responses.json?.counts?.find((c) => c.status === 'submitted')?.count ?? 0;
  check('organiser immediately sees all 3 responses', submitted === 3, JSON.stringify(responses.json?.counts));
  check('responses are returned uncached', /no-store/.test(responses.headers.get('cache-control') ?? ''), responses.headers.get('cache-control'));
  const first = (responses.json?.responses ?? []).find((r) => r.id === ids[0]);
  check('stored answers match what was submitted', first?.answers?.rating === 'good' && first?.answers?.nps === 9 && first?.answers?.comment === 'Faster load times please.', JSON.stringify(first?.answers));
  const third = (responses.json?.responses ?? []).find((r) => r.id === ids[2]);
  check('hidden question is stored as null, not a stale value', third?.answers?.comment === null, JSON.stringify(third?.answers));

  const analytics = await s.req('GET', `/forms/${formId}/analytics`);
  const tally = (analytics.json?.tallies ?? []).find((t) => t.question_id === 'rating' && t.value === 'good');
  check('analytics tally reflects live answers', tally?.count === 1, JSON.stringify(analytics.json?.tallies));
  check('analytics has a timeline with today', (analytics.json?.timeline ?? []).some((t) => t.submitted === 3), JSON.stringify(analytics.json?.timeline));

  console.log('\n== exports ==');
  const dir = mkdtempSync(join(tmpdir(), 'e2e-'));
  const jsonExport = await s.bytes(`/forms/${formId}/responses/export?format=json`);
  const jsonBody = JSON.parse(jsonExport.buffer.toString('utf8'));
  check('json export is real and complete', jsonExport.status === 200 && Array.isArray(jsonBody.data) && jsonBody.data.length === 3, `status ${jsonExport.status} rows ${jsonBody.data?.length}`);
  check('json export carries the real answers', jsonBody.data?.some((r) => r.comment === 'Faster load times please.'), JSON.stringify(jsonBody.data?.[0] ?? {}));
  check('json export names the published version and time', jsonBody.meta?.formVersion >= 1 && Boolean(jsonBody.meta?.publishedAt), JSON.stringify(jsonBody.meta));

  const xlsx = await s.bytes(`/forms/${formId}/responses/export?format=xlsx`);
  const xlsxPath = join(dir, 'export.xlsx');
  writeFileSync(xlsxPath, xlsx.buffer);
  let xlsxSheets = [];
  try { xlsxSheets = execFileSync('unzip', ['-l', xlsxPath]).toString().split('\n').filter((l) => /xl\/worksheets|xl\/workbook/.test(l)).map((l) => l.trim().split(/\s+/).pop()); } catch { /* */ }
  check('xlsx export opens as a real workbook', xlsx.status === 200 && xlsxSheets.length > 0, `status ${xlsx.status} ${xlsxSheets.join(',')}`);

  const csv = await s.bytes(`/forms/${formId}/responses/export?format=csv`);
  const zipPath = join(dir, 'export.zip');
  writeFileSync(zipPath, csv.buffer);
  let entries = [];
  try { entries = execFileSync('unzip', ['-Z1', zipPath]).toString().trim().split('\n'); } catch { /* */ }
  check('csv export is a bundle with data + codebook', csv.status === 200 && entries.some((e) => /data\.csv$/.test(e)) && entries.some((e) => /codebook/.test(e)), entries.join(','));
  const dataCsv = entries.find((e) => /data\.csv$/.test(e));
  if (dataCsv) {
    const body = execFileSync('unzip', ['-p', zipPath, dataCsv]).toString();
    check('csv data contains the submitted answers', /Faster load times please\./.test(body) && /good/.test(body), body.split('\n').slice(0, 2).join(' | ').slice(0, 160));
  }

  console.log('\n== single-use link ==');
  const single = await s.req('POST', `/forms/${formId}/links`, { kind: 'single_use' });
  const singleToken = single.json?.token;
  const s1 = await raw(`${API}/collect/${singleToken}/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const s1Id = (await s1.json())?.responseId;
  await raw(`${API}/collect/${singleToken}/responses/${s1Id}/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answers: { rating: 'good', nps: 5, comment: 'ok' } }) });
  const reuse = await raw(`${API}/collect/${singleToken}/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const reuseBody = await reuse.json().catch(() => null);
  check('a single-use link refuses a second start', reuse.status === 410 && /already been used/i.test(reuseBody?.message ?? ''), `status ${reuse.status} ${JSON.stringify(reuseBody)}`);
  const stillThreePlusOne = await s.req('GET', `/forms/${formId}/responses?limit=200`);
  check('the second attempt created no response', (stillThreePlusOne.json?.counts?.find((c) => c.status === 'submitted')?.count ?? 0) === 4, JSON.stringify(stillThreePlusOne.json?.counts));

  console.log('\n== invite-only gate (as a consumer would meet it) ==');
  const stranger = await fetch(`${API}/auth/otp/request`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `stranger-${stamp}@example.org` }),
  });
  const strangerBody = await stranger.json().catch(() => null);
  check('an unknown address cannot sign up', stranger.status === 404 && strangerBody?.error === 'not_invited', `status ${stranger.status} ${JSON.stringify(strangerBody)}`);
  check('no code is ever echoed to the browser', !('devCode' in (strangerBody ?? {})) && !/devCode/.test(JSON.stringify(strangerBody)), JSON.stringify(strangerBody));

  console.log('\n== import round trip ==');
  const xlsformRes = await fetch(`${API}/forms/${formId}/xlsform`, { headers: { cookie: s.cookie } });
  const xlsBytes = Buffer.from(await xlsformRes.arrayBuffer());
  check('exported the form as a real XLSForm workbook', xlsformRes.status === 200 && xlsBytes.length > 1000, `status ${xlsformRes.status} ${xlsBytes.length}b`);
  const importForm = await s.req('POST', '/forms', { orgId, name: `Imported ${stamp}` });
  const importFormId = importForm.json?.form?.id;
  const importRes = await s.req('POST', `/forms/${importFormId}/import`, { xlsformBase64: xlsBytes.toString('base64'), versionId: null });
  const importedQuestions = importRes.json?.definition?.questions?.length ?? 0;
  check('re-importing the workbook reproduces the questions', importRes.status === 201 && importedQuestions === 3, `status ${importRes.status} questions ${importedQuestions} ${JSON.stringify(importRes.json?.notes)}`);

  console.log('\n== cleanup ==');
  await cleanupOrg(orgId);
  const leftover = (await superClient.query('SELECT count(*)::int AS n FROM org WHERE name = $1', [orgName])).rows[0].n;
  check('throwaway organisation removed', leftover === 0, `leftover ${leftover}`);
  await superClient.query('DELETE FROM session WHERE token_hash = $1', [sha256(token)]);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) console.log('failures:\n - ' + failures.join('\n - '));
}

async function cleanupOrg(orgId) {
  const order = ['response_answer', 'response', 'dist_invite', 'dist_link', 'form_version', 'form', 'project', 'quota', 'member_invite', 'membership', 'api_key', 'webhook', 'export_job'];
  for (const table of order) {
    try { await superClient.query(`DELETE FROM ${table} WHERE org_id = $1`, [orgId]); } catch { /* table may not carry org_id */ }
  }
  await superClient.query('DELETE FROM org WHERE id = $1', [orgId]);
}

main()
  .catch((err) => { console.error('HARNESS ERROR', err); process.exitCode = 1; })
  .finally(async () => { await superClient.end().catch(() => {}); });
