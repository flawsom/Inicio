#!/usr/bin/env node
// Package the ORACURA report deterministically.
//
// All of the normalisation lives in scripts/powerbi/package.mjs (fixed mtimes and modes,
// TZ=UTC, zip -X, delete-first). This wrapper exists because the project's entry list is
// part of the deliverable: the five top-level items are explicit so a stray file left in
// the folder can never leak into the client zip.
//
// Run: node scripts/package-oracura.mjs
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packagePbip } from './powerbi/package.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const result = packagePbip({
  projectDir: join(ROOT, 'reports/power-bi/oracura'),
  zipPath: join(ROOT, 'reports/power-bi/ORACURA_Module1_PBIP.zip'),
  entries: ['ORACURA.pbip', 'ORACURA.Report', 'ORACURA.SemanticModel', 'data', 'report-manifest.json', 'README.md'],
});
console.log(`ORACURA   ${result.sha256}  ${(result.bytes / 1024).toFixed(0)}K  ${result.files} files`);
