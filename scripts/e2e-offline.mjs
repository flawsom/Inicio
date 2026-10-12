/**
 * Offline-first collection, end to end, against the running stack and through
 * the same origin the browser uses (:3000, which proxies /api/v1).
 *
 * Nothing is stubbed: a real organisation, form, published version and link are
 * created, and the respondent flow is driven exactly as the offline queue in the
 * browser drives it — a stable device UUID, a `base` describing the last server
 * state, retries, and a submission that happens twice.
 *
 * The temporary organisation is deleted at the end, so the live database is left
 * exactly as it was found.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const { Client } = require('pg');
const { unzipSync } = require('fflate');

const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:3000';
const API = `${BASE}/api/v1`;
const SUPER = process.env.MIGRATION_DATABASE_URL;
if (!SUPER) {
  console.error('MIGRATION_DATABASE_URL must be set to the owner connection for the database under test.');
  process.exit(2);
}

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}  ${detail}`);
  }
};
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

const definition = {
  title: 'Offline sync check',
  defaultLanguage: 'en',
  languages: ['en'],
  groups: [],
  questions: [
    { id: 'q_name', name: 'name', type: 'text', label: { en: 'Name' } },
    { id: 'q_score', name: 'score', type: 'integer', label: { en: 'Score' }, required: true },
    { id: 'q_reason', name: 'reason', type: 'text', label: { en: 'Reason' }, rules: { visibleIf: '${score} > 10' } },
  ],
  choiceLists: {},
};

const db = new Client({ connectionString: SUPER });

async function api(token, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(token ? { cookie: token } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text };
}

async function main() {
  await db.connect();

  // A throwaway account of the harness's own. It accepts its own terms, creates
  // its own organisation, and is removed at the end — so the real owner's
  // account, organisation and (legal) terms state are never touched.
  const email = `offline-e2e-${randomUUID()}@example.invalid`;
  const user = (
    await db.query(`INSERT INTO app_user (email, display_name) VALUES ($1, 'E2E offline') RETURNING id`, [email])
  ).rows[0];
  const sessionToken = `offline-e2e-${randomUUID()}`;
  await db.query(`INSERT INTO session (subject, token_hash, expires_at) VALUES ($1,$2, now() + interval '1 hour')`, [
    `user:${user.id}`,
    sha256(sessionToken),
  ]);
  const cookie = `sid=${sessionToken}`;

  console.log('\n== setup: a real account, organisation, form, published version and link ==');
  const terms = await (await fetch(`${API}/legal/terms`)).json();
  const privacy = await (await fetch(`${API}/legal/privacy`)).json();
  const accepted = await api(cookie, 'POST', '/auth/terms/accept', {
    termsVersion: terms.document.version,
    privacyVersion: privacy.document.version,
    accepted: true,
  });
  check('the harness account accepts the current terms', accepted.status === 200, JSON.stringify(accepted.json));

  const org = await api(cookie, 'POST', '/orgs', { name: `Offline e2e ${Date.now()}` });
  check('creates an organisation', org.status === 201, JSON.stringify(org.json));
  const orgId = org.json?.organisation?.id;

  let formId;
  let token;
  let versionId;
  try {
    const form = await api(cookie, 'POST', '/forms', { orgId, name: 'Offline sync check', definition });
    check('creates a form from a real definition', form.status === 201, JSON.stringify(form.json));
    formId = form.json?.form?.id;

    const detail = await api(cookie, 'GET', `/forms/${formId}`);
    versionId = detail.json?.versions?.[0]?.id;
    const publish = await api(cookie, 'POST', `/forms/${formId}/versions/${versionId}/publish`);
    check('publishes it', publish.status === 200, JSON.stringify(publish.json));

    const link = await api(cookie, 'POST', `/forms/${formId}/links`, { kind: 'anonymous' });
    check('mints an anonymous link', link.status === 201, JSON.stringify(link.json));
    token = link.json?.token;

    console.log('\n== a device that was offline ==');
    const clientId = randomUUID();
    const start = await api(null, 'POST', `/collect/${token}/responses`, { clientId });
    check('start is created with the device UUID', start.status === 201 && start.json?.responseId === clientId, JSON.stringify(start.json));
    const retry = await api(null, 'POST', `/collect/${token}/responses`, { clientId });
    check('a retried start returns the same response, not a second one', retry.status === 200 && retry.json?.created === false && retry.json?.responseId === clientId, JSON.stringify(retry.json));

    const save0 = await api(null, 'PATCH', `/collect/${token}/responses/${clientId}`, {
      answers: { name: 'A', score: 3, reason: 'x' },
      base: {},
    });
    check('first sync stores the answers', save0.status === 200 && save0.json?.answers?.score === 3, JSON.stringify(save0.json));
    check('an irrelevant answer is stored as null, not kept', save0.json?.answers?.reason === null, JSON.stringify(save0.json?.answers));

    const canonical = save0.json.answers;
    const save1 = await api(null, 'PATCH', `/collect/${token}/responses/${clientId}`, {
      answers: { ...canonical, name: 'A', score: 20, reason: 'x' },
      base: canonical,
    });
    check('one device edits the score', save1.status === 200 && save1.json?.answers?.score === 20 && save1.json?.conflicts === 0, JSON.stringify(save1.json));
    check('the newly relevant question keeps its value', save1.json?.answers?.reason === 'x', JSON.stringify(save1.json?.answers));

    const save2 = await api(null, 'PATCH', `/collect/${token}/responses/${clientId}`, {
      answers: { ...canonical, name: 'A', score: 9, reason: 'x' },
      base: canonical,
    });
    check('a second device syncing the same field is a conflict, not an overwrite', save2.status === 200 && save2.json?.conflicts === 1, JSON.stringify(save2.json));
    check('the server keeps its value', save2.json?.answers?.score === 20, JSON.stringify(save2.json?.answers));

    const answerRows = await db.query(
      `SELECT value, device_value FROM response_answer WHERE response_id = $1 AND question_id = 'score'`,
      [clientId],
    );
    check('the device value is preserved beside it', answerRows.rows[0]?.value === 20 && answerRows.rows[0]?.device_value === 9, JSON.stringify(answerRows.rows[0]));
    const conflictRows = await db.query(`SELECT kind FROM response_conflict WHERE response_id = $1`, [clientId]);
    check('the disagreement is recorded', conflictRows.rows[0]?.kind === 'device_server_mismatch', JSON.stringify(conflictRows.rows));

    console.log('\n== submitting, twice, as a flaky connection would ==');
    const submitted = await api(null, 'POST', `/collect/${token}/responses/${clientId}/submit`, {
      answers: { name: 'A', score: 20, reason: 'x' },
      base: canonical,
    });
    check('submits', submitted.status === 200 && submitted.json?.status === 'submitted', JSON.stringify(submitted.json));
    const again = await api(null, 'POST', `/collect/${token}/responses/${clientId}/submit`, {
      answers: { name: 'A', score: 20, reason: 'x' },
      base: canonical,
    });
    check('a retried submit is refused as already submitted', again.status === 409 && again.json?.error === 'already_submitted', JSON.stringify(again.json));
    const count = await db.query(`SELECT count(*)::int AS n FROM response WHERE form_id = $1`, [formId]);
    check('there is exactly one response', count.rows[0]?.n === 1, JSON.stringify(count.rows[0]));

    console.log('\n== what the organiser sees ==');
    const analytics = await api(cookie, 'GET', `/forms/${formId}/analytics`);
    check('live analytics count the conflict', analytics.status === 200 && analytics.json?.conflicts >= 1, JSON.stringify(analytics.json));
    check('the submitted response is counted', (analytics.json?.byStatus ?? []).some((r) => r.status === 'submitted' && r.count === 1), JSON.stringify(analytics.json?.byStatus));
    const listed = await api(cookie, 'GET', `/forms/${formId}/responses`);
    check('the response list flags it per response', (listed.json?.responses ?? []).some((r) => r.conflict_count >= 1), JSON.stringify(listed.json?.responses?.[0]));

    console.log('\n== the export still carries the live data ==');
    const json = await fetch(`${API}/forms/${formId}/responses/export?format=json`, { headers: { cookie } });
    const jsonBody = json.status === 200 ? await json.json() : null;
    check(
      'a JSON export contains the submitted answer',
      json.status === 200 && JSON.stringify(jsonBody?.data ?? jsonBody).includes('20'),
      JSON.stringify(jsonBody)?.slice(0, 200),
    );
    const csv = await fetch(`${API}/forms/${formId}/responses/export?format=csv`, { headers: { cookie } });
    const csvBytes = Buffer.from(await csv.arrayBuffer());
    const isZip = csvBytes[0] === 0x50 && csvBytes[1] === 0x4b;
    let entries = [];
    if (isZip) entries = Object.keys(unzipSync(new Uint8Array(csvBytes)));
    check('a CSV export is a real bundle', csv.status === 200 && isZip && entries.some((e) => /data\.csv$/.test(e)), entries.join(','));

    console.log('\n== the installable app, from the same origin ==');
    const manifest = await fetch(`${BASE}/manifest.webmanifest`);
    const manifestJson = await manifest.json();
    check('the web manifest is served as JSON with icons', manifest.status === 200 && (manifestJson.icons ?? []).length >= 2, JSON.stringify(manifestJson));
    const sw = await fetch(`${BASE}/sw.js`);
    const swText = await sw.text();
    check('the service worker is served', sw.status === 200 && swText.includes("addEventListener('fetch'"), sw.status);
    const bypassed = ['/api', '/auth', '/health'].filter((prefix) => !swText.includes(`'${prefix}'`));
    check('and it refuses to cache API responses', bypassed.length === 0, `missing: ${bypassed.join(',')}`);
    const html = await (await fetch(`${BASE}/`)).text();
    check('the page links the manifest', html.includes('rel="manifest"'), html.slice(0, 200));
  } finally {
    // Remove everything this run created. Cascade takes the form, its versions,
    // the link, the response, its answers and its conflicts with it.
    if (orgId) await db.query('DELETE FROM org WHERE id = $1', [orgId]);
    await db.query('DELETE FROM session WHERE token_hash = $1', [sha256(sessionToken)]);
    // Deleting the account cascades its membership and its terms acceptance.
    if (user?.id) await db.query('DELETE FROM app_user WHERE id = $1', [user.id]);
    const residue = await db.query('SELECT count(*)::int AS n FROM app_user WHERE email = $1::citext', [email]);
    check('the harness account is gone', residue.rows[0].n === 0, JSON.stringify(residue.rows[0]));
    await db.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

await main();
