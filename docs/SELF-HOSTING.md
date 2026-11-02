# Self-hosting Inicio

This is the operational path for running the API, PostgreSQL, and object storage on infrastructure you control. The console is a static Vite build and can be served by any web server.

## What you need

- Node.js 22 or newer and pnpm 9.15.
- PostgreSQL 16. The schema relies on row-level security, `SECURITY DEFINER` functions, and a non-superuser application role.
- An S3-compatible bucket for attachment uploads. This is optional, but attachment questions refuse to collect without it.
- A reverse proxy that terminates TLS and forwards to the API on port 3000.
- Optional: a ClamAV daemon for attachment scanning, and the `services/pyreadstat` worker for SPSS and Stata exports.

## Two database roles

Migrations need an owner connection. The request process must not use it. Create a least-privilege role named `app_role` before the first migration:

```bash
psql "$DATABASE_URL" -c "CREATE ROLE app_role LOGIN PASSWORD 'change-me'"
```

`docker/postgres-init/00-app-role.sh` does this for the local Compose stack. In production, run the equivalent once, or let your managed PostgreSQL provider create the role.

Set both URLs:

```bash
export DATABASE_URL='postgres://owner:password@db.example.org/inicio'
export APP_DATABASE_URL='postgres://app_role:password@db.example.org/inicio'
```

`APP_DATABASE_URL` wins on the request path. `MIGRATION_DATABASE_URL` can override the owner URL for the migration command only.

## Required environment

At minimum:

```bash
NODE_ENV=production
PORT=3000
APP_ORIGIN=https://survey.example.org
DATABASE_URL=postgres://owner:password@db/inicio
APP_DATABASE_URL=postgres://app_role:password@db/inicio
DATABASE_SSL=true
COOKIE_SECURE=true
OTP_PEPPER='at least sixteen random characters'
```

Mail is required for sign-in codes. Either SMTP:

```bash
SMTP_HOST=smtp.example.org
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=...
SMTP_PASS=...
MAIL_FROM='Your Survey <no-reply@example.org>'
```

or an HTTPS mail relay:

```bash
RESEND_API_KEY=re_...
MAIL_FROM='Your Survey <no-reply@example.org>'
```

Attachments use the standard AWS names, so most S3 tools work without translation:

```bash
S3_BUCKET=inicio-attachments
S3_ENDPOINT=https://s3.example.org
S3_REGION=us-east-1
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
```

Optional services:

```bash
CLAMD_HOST=clamav
CLAMD_PORT=3310
ATTACHMENT_SCAN_POLICY=require
PYREADSTAT_WORKER_URL=http://pyreadstat:8000
```

With no scanner, the attachment row says `skipped` rather than `clean`. With no pyreadstat URL, `.sav` and `.dta` exports answer `501` and name the missing variable.

## Build and migrate

```bash
pnpm install --frozen-lockfile
pnpm build:engine
pnpm db:migrate
pnpm --filter @inicio/api build
pnpm --filter @inicio/web build
```

The web build is written to `apps/web/dist`. Serve it at `APP_ORIGIN` and proxy `/api`, `/auth`, and `/health` to the API. The session cookie is host-only and the console and API must share an origin.

Start the API with:

```bash
node apps/api/dist/server.js
```

## Background work

Webhook delivery is queued in PostgreSQL. Run the drain on a timer, for example every minute:

```bash
pnpm --filter @inicio/api webhooks:drain
```

The command is idempotent. A failed delivery retries with a growing delay and disables an endpoint after repeated failures, with the state visible in the console.

## Object storage

The API signs uploads and reads, so the browser talks to the bucket directly. The bucket needs:

- CORS allowing `PUT` and `GET` from `APP_ORIGIN`.
- A private ACL. The API returns short-lived signed URLs, never public objects.
- Lifecycle rules appropriate for your retention policy.

## Statistical exports

Run the worker from `services/pyreadstat` in its own container:

```bash
cd services/pyreadstat
pip install -r requirements.txt
uvicorn worker:app --host 0.0.0.0 --port 8000
```

Point `PYREADSTAT_WORKER_URL` at it. The API sends a JSON dataset and receives the file bytes, so the worker does not need database access.

## Upgrades

1. Take a database backup.
2. Pull the new release.
3. Run `pnpm db:migrate` as the owner.
4. Rebuild the API and web bundles.
5. Restart the API and the web server.
6. Run `pnpm drift` against a checkout to confirm the migration ledger matches the SQL files.

Migration `0015_review_and_enumerators.sql` adds review state, enumerator datasets, and the statistical flag kinds. It is safe to run after `0014_dataset_publish.sql`.

## Health and limits

- `GET /health` returns liveness and database state.
- `GET /api/v1/public/summary` returns version, uptime, migration count, and measured query latency, with no tenant data.
- Per-address and per-link rate limits are enforced in PostgreSQL, so they hold across API processes.
- The API has no Redis dependency. `REDIS_URL` is reserved and currently unused.
