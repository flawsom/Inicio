#!/usr/bin/env node
// Syntax gate: parse every .mjs under scripts/ (including scripts/powerbi/)
// with `node --check` before any build/validate step runs. A missing quote or
// stray token in a generator is invisible to every downstream check (build,
// validator, Desktop) and costs a full debug cycle when the file is later
// executed - this gate makes it fail in one second, at the source.
//
// Usage: node scripts/check-syntax.mjs
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const collect = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) collect(full, out);
    else if (name.endsWith('.mjs')) out.push(full);
  }
  return out;
};

const files = collect(join(ROOT, 'scripts')).sort();
let failures = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(`ok   - ${relative(ROOT, file)}`);
  } catch (e) {
    failures += 1;
    console.error(`FAIL - ${relative(ROOT, file)}`);
    console.error(String(e.stderr ?? e.stdout ?? e.message).trim());
  }
}
console.log(failures ? `\n${failures} file(s) with syntax errors` : `\nall ${files.length} scripts parse`);
process.exit(failures ? 1 : 0);
