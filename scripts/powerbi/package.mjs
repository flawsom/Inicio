// Deterministic zip packaging for a Power BI project folder.
//
// A zip is not a function of file contents alone. Entry mtimes, the timezone used to
// encode them, each entry's Unix mode and zip's own extra fields all vary by host, so an
// identical PBIP can produce a different archive on every machine. A deliverable that
// changes bytes when nothing changed is not reproducible, so all four are normalised:
//
//   * every file and folder gets one fixed timestamp;
//   * every entry gets one fixed mode (644 files, 755 folders), because a setgid
//     directory inherited from the host would otherwise change the archive;
//   * zip runs with TZ=UTC, because DOS time is encoded from local time;
//   * `zip -X` drops the extra fields (uid/gid, platform attributes) that vary by host.
//
// The epoch defaults to SOURCE_DATE_EPOCH (whole seconds, the reproducible-builds
// convention) and falls back to the report's own fixed build date. An invalid value is an
// error rather than a silent 1970 build. Callers delete the target first, because `zip`
// updates an existing archive in place: a re-zip without the delete keeps pages from an
// earlier build, which is the stale-page failure the validator's count check exists for.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';

// 2026-11-13T00:00:00Z, the ORACURA build date; the earliest date zip can encode is 1980.
export const FALLBACK_EPOCH = Math.floor(Date.parse('2026-11-13T00:00:00Z') / 1000);

export function resolveEpoch(value = process.env.SOURCE_DATE_EPOCH) {
  if (value === undefined || value === '') return FALLBACK_EPOCH;
  if (!/^\d+$/.test(String(value))) {
    throw new Error(`SOURCE_DATE_EPOCH must be whole seconds, got ${JSON.stringify(value)}`);
  }
  const epoch = Number(value);
  if (!Number.isSafeInteger(epoch) || epoch < 315532800) {
    throw new Error(`SOURCE_DATE_EPOCH is before 1980 (${value}); zip cannot encode it`);
  }
  return epoch;
}

const normalise = (dir, epoch, files = []) => {
  chmodSync(dir, 0o755);
  utimesSync(dir, epoch, epoch);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) normalise(full, epoch, files);
    else {
      chmodSync(full, 0o644);
      utimesSync(full, epoch, epoch);
      files.push(full);
    }
  }
  return files;
};

// The archive's entry order is part of its bytes, and `zip -r` walks directories in
// readdir order, which differs between a developer's ext4 volume and a CI checkout.
// Listing every path ourselves, sorted, makes the order a property of the project
// rather than of the filesystem.
const orderedEntries = (projectDir, entries) => {
  const paths = [];
  const collect = (rel) => {
    const full = join(projectDir, rel);
    if (!statSync(full).isDirectory()) {
      paths.push(rel);
      return;
    }
    paths.push(`${rel.replace(/\/$/, '')}/`);
    for (const name of readdirSync(full).sort()) collect(`${rel.replace(/\/$/, '')}/${name}`);
  };
  for (const entry of entries) collect(entry);
  return paths;
};

export function packagePbip({ projectDir, zipPath, epoch = resolveEpoch(), entries = readdirSync(projectDir).sort() }) {
  if (!existsSync(projectDir)) throw new Error(`no project folder at ${projectDir}`);
  if (!entries.some((name) => name.endsWith('.pbip'))) {
    throw new Error(`no .pbip entry point in ${projectDir}`);
  }
  const files = normalise(projectDir, epoch);
  const paths = orderedEntries(projectDir, entries);
  rmSync(zipPath, { force: true });
  // `-@` takes the entry list from stdin, so zip stores exactly this order. No `-r`:
  // every directory and file is already listed, and letting zip recurse would put the
  // filesystem back in charge of the order.
  execFileSync('zip', ['-X', '-q', '-@', zipPath], {
    cwd: projectDir,
    input: `${paths.join('\n')}\n`,
    env: { ...process.env, TZ: 'UTC' },
  });
  // A zip that cannot be read back is worse than one that fails here.
  execFileSync('unzip', ['-tq', zipPath], { stdio: 'pipe' });
  const bytes = readFileSync(zipPath);
  return { files: files.length, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
