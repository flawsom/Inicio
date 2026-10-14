/**
 * The application's own version, in one place, and checked by a test.
 *
 * `/health` answered `{ "status": "ok", "dbTime": … }` for a long time. That tells an
 * operator the process is up and the database answered, and nothing about **which
 * build** answered, which is the first question of any incident ("is the fix deployed?")
 * and the one question a deployment cannot answer about itself. The migration ledger in
 * `/api/v1/public/summary` is a different fact: a database can be in step with the
 * checkout while the code serving requests is a release behind, and that is exactly the
 * shape of the day this repository spent nine migrations deep with nothing red.
 *
 * Why a literal rather than a read of `package.json`: this file is bundled on its own by
 * the serverless build, whose `rootDir` is `src`, so a JSON import is either inlined
 * (silently drifting from the version npm actually publishes) or a runtime failure in
 * production. So the number is written here, and `version.test.ts` fails the moment
 * `package.json` disagrees with it. A duplicated constant with a test that reads the
 * other copy is not elegance, it is the only version of this that cannot lie.
 */
export const APP_VERSION = '0.1.0';
