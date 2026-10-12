# Inicio — multi-tenant survey & data-collection platform

Multi-tenant platform for building forms with real logic, circulating them, and exporting
analysis-ready data. Accounts are **invitation only**: an owner or administrator adds a person,
the person opens a single-use link, and they are in. The 2026 school ranking survey this
repository originally specified is now a *template* inside the product, not the product
(`docs/ROADMAP.md`, DECISIONS D12).

## Status

| | |
|---|---|
| Verified | 131 automated tests (54 engine, 58 API, 19 web), `lint` + `typecheck` + `build` clean |
| Works now | invitation-only onboarding, organisations + roles (owner/admin/member/viewer), forms/versions/publish, XLSForm import & export, logic engine, distribution links (anonymous, single-use, multiple, panel), **offline-first collection** (cached definition, IndexedDB drafts, a durable sync queue, conflict retention), an **installable PWA**, live analytics, exports (CSV bundle / XLSX / JSON), templates, terms acceptance with recorded evidence, web app |
| Refused on purpose | `.sav` / `.dta` return **501 with a reason** until the pyreadstat worker exists (see D9) |
| Not built | file uploads, AI authoring/analysis, SSO/SCIM, scheduled backups — see `docs/ROADMAP.md` §2 |

## Layout

```
apps/api                  Fastify API — /api/v1 (platform) and the Phase-1 /auth (legacy)
apps/web                  React + Vite web app: workspace shell + collection renderer
apps/web/src/offline      device-side draft store, sync queue and conflict rules
apps/web/public           installable-app assets: service worker, web manifest, icons
packages/engine           canonical form model, expression engine, XLSForm adapter, export pipeline
api/ingest.ts             Vercel serverless entry point (translator, not a second router)
vercel.json               single-project deployment: SPA + API on one origin
netlify.toml              Netlify mirror of the SPA, proxying the API to the same origin
apps/api/src/db/migrations
  0001..0002              Phase 1 (school schema, least-privilege role)
  0003_platform.sql       org/form/version/response model, org-scoped RLS
  0004_platform_auth.sql  platform sign-in, roster invites, public-link resolution
  0005..0008              one live code per user, invitations, terms, invite preview
docker/                   the self-hosted profile: Postgres, Caddy, Mailpit and friends
docs/ROADMAP.md           verified status, what is missing, honest free-tier ceiling
specs/PLATFORM.md         canonical design (supersedes BUILD.md's school framing)
DECISIONS.md              why each significant choice was made
```

## Quick start

```bash
corepack enable                      # pnpm 9.15, pinned in package.json
pnpm install
cp .env.example .env                 # DATABASE_URL, MIGRATION_DATABASE_URL, OTP_PEPPER

pnpm db:migrate                      # applies every migration in order
pnpm --filter @inicio/api bootstrap:owner --email you@example.com --org "Your org"
pnpm dev:api                         # http://localhost:3001
pnpm dev:web                         # http://localhost:3000
```

Signup is closed, so the first account cannot be invited by anybody: `bootstrap:owner` creates
it deliberately, once, over the migration (owner) connection. Everything after that is an
invitation from inside the app.

A freshly created account can reach `/auth/me` and the acceptance route and nothing else until
it has ticked the terms box. Acceptance is stored as an append-only event with the document
versions and hashes.

### Email

Login codes are sent by mail, and there is no debug echo anywhere in the codebase: the only
thing a code request can answer with is `{status: "sent"}`. When the relay cannot be reached the
login page says so in plain language and tells the person to contact their administrator; the
relay, the transport, the sender address and the provider's own error text are administrator-only
details.

Two transports are supported, chosen with `MAIL_TRANSPORT`:

```bash
# HTTPS relay (works where SMTP ports are blocked, which is most PaaS)
MAIL_TRANSPORT=resend
RESEND_API_KEY=...               # untracked env file or your host's secret store
MAIL_FROM="Inicio <no-reply@your-verified-domain>"

# Or SMTP
SMTP_HOST=smtp.example.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=...
SMTP_PASS=...
```

A sending-only relay key can only deliver to its own account address until you verify a sending
domain. Verify the domain before inviting anybody.

## Deployment

**One Vercel project serves both the app and the API, on one origin.** That single origin is the
point: the session cookie is host-only and the browser must be able to send it back, which it
cannot do across two unrelated domains.

- `vercel.json` builds the SPA to `apps/web/dist` and routes `/api/*`, `/auth/*` and `/health`
  to `api/ingest.ts`. Build the app and the API in one deploy, so a version never goes live
  against mismatched code.
- Vercel replaces the path when it routes a rewrite to a function, so the entry point restores
  the original URL before Fastify sees it. Everything after that is the same application that
  runs locally and in Docker.
- The database is a marketplace Postgres (Neon, through the Vercel integration), connected to
  the project so `DATABASE_URL` is injected. The API connects as the least-privilege `app_role`
  created by migration 0002, never as the database owner: RLS is only enforced for a
  non-superuser role, so connecting as the owner would quietly turn tenancy off.
- Required environment variables: `OTP_PEPPER`, `APP_ORIGIN`, `COOKIE_SECURE=true`,
  `INVITE_ONLY=true`, `DATABASE_SSL=true`, plus the mail transport above.
- Migrations are a deploy step, not a request-time action:
  `MIGRATION_DATABASE_URL=... pnpm db:migrate`, then `bootstrap:owner` once.
- `netlify.toml` publishes the same SPA on Netlify and proxies `/api/*`, `/auth/*` and
  `/health` to the Vercel deployment, so both hosts are the same origin to a browser.

## Using it

1. **Sign in** with an address you have been invited as. A one-time code is emailed to it.
2. **Create an organisation** (you become its owner), then invite people as `admin`, `member`
   or `viewer` from **People and invitations**. The invitation link is shown once and is
   single-use.
3. **Create a form** — blank, from a template (including *School Ranking Survey 2026*), or by
   uploading an existing **XLSForm `.xlsx`**. The importer reports anything it could not carry.
4. **Edit and publish.** The definition is JSON — the same model the importer produces. Saving
   a half-built form is allowed and shows the analyser's findings; **publishing** refuses an
   unanalysable form, because the alternative is a respondent staring at a broken survey.
5. **Distribute.** Create a link (anonymous, single-use, multiple-completes or panel). The token
   is shown exactly once — only its hash is stored.
6. **Watch and export.** Counts and answer tallies refresh from live queries, and again whenever
   the tab regains focus. Export as a CSV bundle (data + codebook + value labels + missing table
   + metadata, plus an Excel-safe copy), XLSX or JSON.

## Offline collection

A respondent can open a survey once and then fill it in with no connection at all.

- The published definition is cached on the device, so the form renders, evaluates logic and
  validates offline using the **same engine the server uses**.
- Every answer is written to IndexedDB as it is typed, and queued. The header states whether the
  server has the answers or only this device does, with the time of each, and offers **Send now**.
- The device owns a stable UUID for its response, so a start retried after a dropped connection
  resumes the same response instead of creating a second one. Syncing twice never duplicates.
- Each sync sends the last server state the device saw (`base`). If a device and the server changed
  the same field, the server's value is kept, the device's value is preserved beside it, and the
  disagreement is recorded and shown in the Responses tab. Nothing is overwritten or dropped.
- Autosave runs on change, on field blur, on tab hide and page close, on reconnect and on a
  2-minute timer.
- The service worker caches the app shell only. `/api`, `/auth` and `/health` always go to the
  network, so no cached body can be mistaken for live data. It is registered in production builds
  only, so it never interferes with the dev server.

## Verification

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Database-backed tests need PostgreSQL reachable at the URLs in `.env`; the suite creates and
uses its own `${database}_test` database, so running the tests never touches development data.

The tests that carry the most weight:

- `apps/api/test/platform-api.test.ts` — the whole product over HTTP as two accounts: cross-tenant
  **404** on read, **403** on a forged `org_id`, viewer cannot edit, publish blocked on an
  unanalysable definition, immutable published versions, a full collection lifecycle, quota and
  screening behaviour, export contents, single-use link enforcement.
- `apps/api/test/admin-invites.test.ts` — the terms gate, the invitation lifecycle, the last
  owner cannot be removed, a member never reaches the admin surface.
- `apps/api/test/platform-rls.test.ts` — RLS invariants against real PostgreSQL as `app_role`.
- `apps/api/test/collect-sync.test.ts` — a device-owned UUID makes a start idempotent; two devices
  editing one response merge, and the losing value is **retained** rather than dropped; hidden⇒null;
  a calculated value the device got wrong is flagged; a retried submit counts once.
- `apps/web/test/offline.test.ts` — the queue, backoff and resume rules, with an injected clock,
  store and transport.
- `apps/web/test/service-worker.test.ts` — runs `public/sw.js` in a VM and proves an `/api` request
  is never intercepted and never even fetched by the worker.
- `packages/engine/test/xlsform.test.ts` — `import(export(import(x))) ≡ import(x)` (fixpoint),
  plus the "what we dropped" report.
- `packages/engine/test/export.test.ts` — `0` vs blank, five kinds of missing, CSV injection,
  typed XLSX numbers, codebook/value-label content.

`.run/e2e-consumer.mjs` (untracked) walks the whole consumer journey against any base URL:
invite-only gate, publish, three real respondent submissions through a distribution link, live
reads, every export format, single-use enforcement, XLSForm import round trip. `.run/e2e-offline.mjs`
does the same for the offline contract — a device UUID, a retried start, a two-device conflict whose
device value is preserved in the database, a doubled submit — plus the manifest and service worker
as the browser fetches them (24 checks).

## Known limitations

- `.sav` / `.dta` exports are refused with a reason rather than faked; they need the pyreadstat
  worker.
- File upload questions are recognised and preserved, but not yet collected (no object storage).
- A sync conflict is stored per answer (`device_value`) and per response (`response_conflict`), and
  shown in the console, but it is not yet a column in the export bundle; that belongs with the
  quality-flag queue and the codebook.
- The rate limiter is in-process, so it is per-instance until Redis is wired in.
- Invitations are not emailed automatically; the administrator copies the link and sends it.
- No scheduled backups yet: the managed Postgres provider's own snapshot window is what exists.
