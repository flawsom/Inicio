# Inicio — multi-tenant survey & data-collection platform

Open-signup, multi-tenant platform for building forms with real logic, circulating them, and
exporting analysis-ready data. **Cloud-hosted, free to use, no response cap.** The 2026 school
ranking survey this repository originally specified is now a *template* inside the product, not
the product (`docs/ROADMAP.md`, DECISIONS D12).

## Status

| | |
|---|---|
| Verified | 90 automated tests, `lint` + `typecheck` + `build` clean |
| Works now | open signup, organisations + roles, forms/versions/publish, XLSForm import & export, logic engine, distribution links, collection with partial save, exports (CSV bundle / XLSX / JSON), templates, web app |
| Refused on purpose | `.sav` / `.dta` return **501 with a reason** until the pyreadstat worker exists (see D9) |
| Not built | file uploads, offline queue, AI authoring/analysis, SSO/SCIM, backups — see `docs/ROADMAP.md` §2 |

## Layout

```
apps/api                  Fastify API — /api/v1 (platform) and the Phase-1 /auth (legacy)
apps/web                  React + Vite web app: workspace shell + collection renderer
packages/engine           canonical form model, expression engine, XLSForm adapter, export pipeline
apps/api/src/db/migrations
  0001..0002              Phase 1 (school schema, least-privilege role)
  0003_platform.sql       org/form/version/response model, org-scoped RLS
  0004_platform_auth.sql  platform sign-in, roster invites, public-link resolution
docs/ROADMAP.md           verified status, what is missing, honest free-tier ceiling
specs/PLATFORM.md         canonical design (supersedes BUILD.md's school framing)
DECISIONS.md              why each significant choice was made
```

## Quick start

```bash
corepack enable                      # pnpm 9.15, pinned in package.json
pnpm install
cp .env.example .env                 # DATABASE_URL, MIGRATION_DATABASE_URL, OTP_PEPPER

pnpm db:migrate                      # applies 0001..0004
pnpm dev:api                         # http://localhost:3001
pnpm dev:web                         # http://localhost:3000
```

Development affordances, both refused when `NODE_ENV=production`:

- `DEV_RETURN_OTP=true` — the API echoes the login code so the flow is testable without SMTP.
- `ALLOW_OPEN_SIGNUP=true` — the legacy `/auth` school flow also accepts unknown emails.

### Email

There is **no mail server by default**, and the API no longer pretends otherwise: the login
screen asks `GET /api/v1/auth/mail-status` first and, when the relay is unreachable, says so and
shows the code on screen. `POST /api/v1/auth/otp/request` answers `not_delivered` with the reason
instead of a reassuring `sent`.

To send real email, point the existing nodemailer transport at a relay (no code change):

```bash
SMTP_HOST=smtp.resend.com      # or any relay
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=resend               # provider-specific
SMTP_PASS=...                  # the provider API key — keep it out of git
MAIL_FROM="Inicio <no-reply@your-verified-domain>"
```

Put the secret in an untracked file (`.run/api.env` locally) or your host's secret store — never in
chat, in the repo, or in the built assets. Resend's free tier can only send to the account owner's
own address until you verify a domain, which is enough to test your own login.

## Using it

1. **Sign in** with any email address. In development the code is shown on screen.
2. **Create an organisation** (you become its owner), then invite teammates as `admin`,
   `member` or `viewer`.
3. **Create a form** — blank, from a template (including *School Ranking Survey 2026*), or by
   uploading an existing **XLSForm `.xlsx`**. The importer reports anything it could not carry.
4. **Edit and publish.** The definition is JSON — the same model the importer produces. Saving
   a half-built form is allowed and shows the analyser's findings; **publishing** refuses an
   unanalysable form, because the alternative is a respondent staring at a broken survey.
5. **Distribute.** Create a link (anonymous, single-use, multiple-completes or panel). The token
   is shown exactly once — only its hash is stored.
6. **Watch and export.** Counts refresh every 5 s from live queries. Export as a CSV bundle
   (data + codebook + value labels + missing table + metadata, plus an Excel-safe copy), XLSX or
   JSON.

## Verification

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Database-backed tests need PostgreSQL reachable at the URLs in `.env` (the test setup recreates
the schema and runs every migration; the sandbox's walk-in Postgres is detected automatically).

The tests that carry the most weight:

- `apps/api/test/platform-api.test.ts` — the whole product over HTTP as two accounts: cross-tenant
  **404** on read, **403** on a forged `org_id`, viewer cannot edit, publish blocked on an
  unanalysable definition, immutable published versions, a full collection lifecycle, quota and
  screening behaviour, export contents, single-use link enforcement.
- `apps/api/test/platform-rls.test.ts` — RLS invariants against real PostgreSQL as `app_role`.
- `packages/engine/test/xlsform.test.ts` — `import(export(import(x))) ≡ import(x)` (fixpoint),
  plus the "what we dropped" report.
- `packages/engine/test/export.test.ts` — `0` vs blank, five kinds of missing, CSV injection,
  typed XLSX numbers, codebook/value-label content.

## Known limitations

- No backups on a free Supabase project; the idle-pause and per-provider ceilings are tabulated
  honestly in `docs/ROADMAP.md` §3 rather than promised away.
- File upload questions are recognised and preserved, but not yet collected (no object storage).
- The dashboard polls; realtime subscriptions are phase 2 of the roadmap.
- The rate limiter is in-process, so it is per-instance until Redis is wired in.
