// Screenshot every rendered page (render/page-*.html) with Playwright.
//
//   node scripts/screenshot-render.mjs                       # ORACURA render output
//   node scripts/screenshot-render.mjs reports/power-bi/acme  # a scaffolded report
//
// Chromium needs Ubuntu libs and fonts that sandbox images lack; if it fails to launch
// with "error while loading shared libraries" (or renders every glyph blank, which is
// what a fontless host does), fetch them locally - no root needed:
//
//   mkdir -p .apt-state/lists/partial .chromelibs
//   apt-get update -o Dir::State=$PWD/.apt-state -o Dir::Cache=$PWD/.apt-cache
//   for p in libnspr4 libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 libatspi2.0-0t64 \
//            libcups2t64 libdrm2 libgbm1 libxkbcommon0 libpango-1.0-0 libcairo2 \
//            libasound2t64 libxdamage1 libxfixes3 libxrandr2 libxcomposite1 libx11-xcb1 \
//            libxcursor1 libxext6 libxss1 libxrender1 libxi6 libxtst6 libpangocairo-1.0-0 \
//            libharfbuzz0b libfribidi0 libgraphite2-3 libglib2.0-0t64 libffi8 \
//            libpixman-1-0 libfreetype6 libfontconfig1 libuuid1 libexpat1 libx11-6 \
//            libxcb1 libxau6 libxdmcp6 libbsd0 libmd0 libavahi-common3 libavahi-client3 \
//            libdbus-1-3 libxcb-render0 libxcb-shm0 libxcb-xfixes0 libxcb-dri3-0 \
//            libxcb-present0 libxcb-sync1 libxcb-randr0 libthai0 libdatrie1 libepoxy0 \
//            libegl1 libgl1 libglvnd0 libglx0 libxshmfence1 libpng16-16t64 libtiff6 \
//            fonts-dejavu-core fonts-liberation fontconfig-config; do
//     apt-get download -o Dir::State=$PWD/.apt-state -o Dir::Cache=$PWD/.apt-cache "$p"
//   done
//   for f in *.deb; do dpkg-deb -x "$f" .chromelibs/; done; rm -f *.deb
//
// Then alias the report's fonts onto the ones just installed and run:
//
//   FONTCONFIG_FILE=$PWD/.fonts.conf \
//   LD_LIBRARY_PATH=$PWD/.chromelibs/usr/lib/x86_64-linux-gnu \
//   node scripts/screenshot-render.mjs
//
// where .fonts.conf is a two-entry fontconfig that maps 'Segoe UI' -> 'Liberation Sans'
// and 'Georgia' -> 'Liberation Serif' and points <dir> at .chromelibs/usr/share/fonts.
import { chromium } from 'playwright';
import { mkdirSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2]
  ? join(resolve(process.argv[2]), 'render')
  : join(root, 'reports/power-bi/oracura-render');
const shots = join(out, 'shots');
mkdirSync(shots, { recursive: true });

const pages = readdirSync(out).filter((f) => f.startsWith('page-') && f.endsWith('.html')).sort();
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  for (const f of pages) {
    const name = f.replace(/^page-/, '').replace(/\.html$/, '.png');
    await page.goto(`file://${join(out, f)}`);
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(shots, name) });
    console.log('shot', name);
  }
} finally {
  await browser.close();
}
console.log('done');
