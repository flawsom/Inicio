#!/usr/bin/env node
// Deterministic packaging for the ORACURA Power BI deliverable.
//
// `zip -qr` alone is not reproducible. Every entry stores its file's mtime, the archive
// encodes that mtime as local time, and `zip` adds machine-specific extra fields, so two
// runs over an identical build produce two different byte streams. The build itself is
// already deterministic (GENERATED_AT in build-oracura-powerbi.mjs is a fixed constant),
// so the remaining non-determinism lives here and is removed in four ways:
//
//   1. every file and folder gets one fixed timestamp (SOURCE_DATE_EPOCH, or the build's
//      own date), so stored mtimes are identical run to run;
//   2. every entry gets one fixed mode (644 files, 755 folders), because zip stores the
//      Unix mode and a setgid directory inherited from the host would otherwise change
//      the archive without changing the build;
//   3. the archive is written with TZ=UTC, because zip encodes DOS time from local time;
//   4. `zip -X` drops the extra fields (uid/gid, platform attributes) that vary by host;
//   5. the target is deleted first, because `zip` updates an existing archive in place
//      and page ids are random per build. That is the stale-page failure the validator's
//      count check exists for: a re-zip without the delete keeps an earlier build's pages.
//
// Two runs of `node scripts/build-oracura-powerbi.mjs && node scripts/package-oracura.mjs`
// therefore produce the same sha256, which is what CI asserts on every push.
//
// Run: node scripts/package-oracura.mjs
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, readFileSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = join(ROOT, 'reports/power-bi/oracura');
const ZIP = join(ROOT, 'reports/power-bi/ORACURA_Module1_PBIP.zip');
// 2026-11-13T00:00:00Z is the report's GENERATED_AT; SOURCE_DATE_EPOCH (seconds) wins
// when a packager wants its own date, the convention reproducible-builds tools expect.
const EPOCH = Number(process.env.SOURCE_DATE_EPOCH ?? Math.floor(Date.parse('2026-11-13T00:00:00Z') / 1000));

const walk = (dir, out = []) => {
  chmodSync(dir, 0o755);
  utimesSync(dir, EPOCH, EPOCH);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else {
      chmodSync(full, 0o644);
      utimesSync(full, EPOCH, EPOCH);
      out.push(full);
    }
  }
  return out;
};

const files = walk(PROJECT);
rmSync(ZIP, { force: true });
execFileSync('zip', ['-X', '-qr', ZIP, 'ORACURA.pbip', 'ORACURA.Report', 'ORACURA.SemanticModel', 'data', 'report-manifest.json', 'README.md'], {
  cwd: PROJECT,
  env: { ...process.env, TZ: 'UTC' },
});
const bytes = readFileSync(ZIP);
console.log(`${files.length} files -> ${ZIP}`);
console.log(`sha256 ${createHash('sha256').update(bytes).digest('hex')}  ${(bytes.length / 1024).toFixed(0)}K`);
