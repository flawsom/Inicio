// tsc only emits .js; the SQL migrations and their assets must ship alongside.
import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('dist/db', { recursive: true });
cpSync('src/db/migrations', 'dist/db/migrations', { recursive: true });
console.log('copied db/migrations -> dist/db/migrations');
