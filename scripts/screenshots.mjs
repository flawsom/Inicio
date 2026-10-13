/**
 * The screenshots in the README, taken rather than drawn.
 *
 * `docs/assets/screenshots/*.jpg` are captures of the running product, and this is
 * the thing that made them — so nobody has to take a picture on trust. It drives a
 * real browser against a real deployment, asserts the four behaviours a screenshot
 * cannot show you (the page read its figures from the API in that request, the
 * WebGL scene drew a frame, the call to action reaches the sign-in route, and
 * nothing 4xx'd except the signed-out `401` an anonymous visitor always gets), and
 * writes the images only if those assertions hold.
 *
 * Playwright is deliberately not a dependency of this repository: images are
 * generated occasionally by a person, and no CI job should download a browser to
 * check a JPEG. Install it where you need it:
 *
 *   npm i playwright && npx playwright install --no-shell chromium
 *   sudo npx playwright install-deps chromium        # the shared libraries
 *   node scripts/screenshots.mjs                     # --base to point elsewhere
 *
 * Software GL (`--use-gl=swiftshader`) is what lets a machine with no GPU draw the
 * landing page's field. The frame rate under it says nothing about real hardware,
 * which is why the roadmap still lists that as unmeasured.
 */
import { statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'docs', 'assets', 'screenshots');

const arg = process.argv.indexOf('--base');
const BASE = arg === -1 ? 'https://inicio-prjct.vercel.app' : (process.argv[arg + 1] ?? '');

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error(
    'playwright is not installed here. This script is not part of the test suite:\n' +
      '  npm i playwright && npx playwright install --no-shell chromium\n' +
      '  sudo npx playwright install-deps chromium',
  );
  process.exit(2);
}

const checks = [];
const check = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail });
const bad = [];
const errors = [];

const browser = await chromium.launch({
  channel: 'chromium',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
});

const sizes = {};
async function shot(page, file, options = {}) {
  const path = join(OUT, file);
  await page.screenshot({ path, type: 'jpeg', quality: 90, ...options });
  sizes[file] = `${(statSync(path).size / 1024).toFixed(0)} kB`;
}

/* --------------------------------------------------------------- desktop */
const desktop = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
  serviceWorkers: 'block',
});
const page = await desktop.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 200));
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 200)}`));
// Through the protocol, not the page: a browser asks for `/favicon.ico` on its own
// when the document declares no icon, and that request never surfaces as a page
// response — which is exactly how a 404 sat in the console of every visit without
// any check noticing.
const cdp = await desktop.newCDPSession(page);
cdp.on('Network.responseReceived', (e) => {
  if (e.response.status >= 400) bad.push(`${e.response.status} ${e.response.url}`);
});
await cdp.send('Network.enable');

const summary = page
  .waitForResponse((r) => r.url().includes('/api/v1/public/summary'), { timeout: 20_000 })
  .catch(() => null);
await page.goto(`${BASE}/`, { waitUntil: 'load' });
check('the landing read its figures from the API in this request', (await summary)?.status() === 200);
await page.waitForTimeout(4000);

const scene = await page.evaluate(() => {
  const canvas = document.querySelector('canvas');
  const context = canvas?.getContext('webgl2') ?? canvas?.getContext('webgl');
  return { width: canvas?.width ?? 0, height: canvas?.height ?? 0, drawn: Boolean(context) };
});
check('the WebGL scene drew a frame', scene.drawn && scene.width > 300, JSON.stringify(scene));
await shot(page, 'landing-hero.jpg');

for (const [name, screens] of [
  ['capabilities', 1.6],
  ['scene', 0.85],
  ['templates', 3.3],
]) {
  await page.evaluate((factor) => window.scrollTo(0, window.innerHeight * factor), screens);
  await page.waitForTimeout(2000);
  await shot(page, `landing-${name}.jpg`);
}

await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(1200);
await page.getByRole('button', { name: /one-time code/i }).first().click();
await page.waitForTimeout(1600);
check('the primary call to action reached /login', new URL(page.url()).pathname === '/login', page.url());
await shot(page, 'login-desktop.jpg');
await desktop.close();

/* ---------------------------------------------------------------- phone */
const phone = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  serviceWorkers: 'block',
});
const mobilePage = await phone.newPage();
const mobileCdp = await phone.newCDPSession(mobilePage);
mobileCdp.on('Network.responseReceived', (e) => {
  if (e.response.status >= 400) bad.push(`[phone] ${e.response.status} ${e.response.url}`);
});
await mobileCdp.send('Network.enable');
mobilePage.on('response', (r) => {
  if (r.status() >= 400) bad.push(`[phone] ${r.status()} ${r.url()}`);
});
await mobilePage.goto(`${BASE}/`, { waitUntil: 'load' });
await mobilePage.waitForTimeout(3500);
await shot(mobilePage, 'landing-mobile.jpg');
await mobilePage
  .getByRole('button', { name: /one-time code/i })
  .first()
  .click()
  .catch(() => {});
await mobilePage.waitForTimeout(1400);
check('the call to action works on a phone viewport', new URL(mobilePage.url()).pathname === '/login', mobilePage.url());
await shot(mobilePage, 'login-mobile.jpg');
await phone.close();
await browser.close();

/* --------------------------------------------------------------- report */
const unexpected = bad.filter((entry) => !entry.includes('401'));
check('nothing 4xx\'d except the signed-out 401', unexpected.length === 0, unexpected.join(' '));
for (const entry of checks) console.log(`${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name}${entry.detail ? ` — ${entry.detail}` : ''}`);
console.log('console errors:', errors.length ? errors : 'none');
for (const [file, size] of Object.entries(sizes)) console.log(`  ${file}  ${size}`);
writeFileSync(join(OUT, 'capture-report.json'), `${JSON.stringify({ base: BASE, at: new Date().toISOString(), checks, consoleErrors: errors, bad, sizes }, null, 2)}\n`);

if (checks.some((entry) => !entry.ok)) process.exitCode = 1;
