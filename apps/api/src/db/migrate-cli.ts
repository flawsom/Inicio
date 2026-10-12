import { env } from '../env.js';
import { runMigrations } from './migrate.js';

const url = env.MIGRATION_DATABASE_URL ?? env.DATABASE_URL;
console.log(`migrating ${url.replace(/:[^:@/]+@/, ':***@')}`);
await runMigrations(url, { log: (m) => console.log(`  ${m}`) });
console.log('migrations complete');
