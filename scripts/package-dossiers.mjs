#!/usr/bin/env node
// Package the five questionnaire dossiers with the same deterministic zip as ORACURA.
//
// These dossiers have no source definition in this repository (the questionnaires arrived
// as Word documents and the compiled FormDefinition was not committed), so this script
// cannot rebuild them. What it can do is turn the delivered folders into byte-stable
// archives, so a reviewer can verify a dossier with one sha256 instead of diffing 175
// files, and CI can prove that the committed archive really is the committed folder.
//
// Run: node scripts/package-dossiers.mjs
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packagePbip } from './powerbi/package.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOSSIERS = [
  ['bounce', 'BOUNCE'],
  ['heer', 'HEER'],
  ['mehak', 'MEHAK'],
  ['nand', 'NAND'],
  ['prism', 'PRISM'],
];

for (const [folder, code] of DOSSIERS) {
  const result = packagePbip({
    projectDir: join(ROOT, 'reports/power-bi', folder),
    zipPath: join(ROOT, 'reports/power-bi', `${code}_PBIP.zip`),
  });
  console.log(`${code.padEnd(7)} ${result.sha256}  ${(result.bytes / 1024).toFixed(0)}K  ${result.files} files`);
}
