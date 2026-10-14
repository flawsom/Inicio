# Decision log

Decisions taken while building Phase 1. Where a decision changes `specs/`, the spec is
updated rather than the code diverging silently (BUILD.md §14, AGENTS.md §4).

## D1 — Email transport: SMTP via nodemailer, Resend recommended

**Chosen:** `nodemailer` over plain SMTP with a pluggable transport. Dev = Mailpit (offline,
nothing leaves the machine); production = whatever relay is configured via `SMTP_*`.

**Why not a provider SDK:** BUILD.md §4/§10 rule out vendor lock-in, and there are only three
templates. An SMTP client keeps the provider a single env var. Resend (`smtp.resend.com:465`,
user `resend`, password = API key) is the recommended relay; Brevo is a drop-in alternative.

**Volume caveat (verified):** Resend's free tier is **3,000 emails/month and 100/day**. Three
emails per school × ~800 schools ≈ 2,400, so a single field month fits, but resends during a burst
can cross the 100/day line. Brevo's free tier is 300/day. Because the transport is SMTP, switching
is one env var and no code change. Resend's free tier also requires a **verified sending domain**
before it will deliver to anyone other than the account owner's own address.

## D2 — Admin bootstrap: env-driven CLI, argon2id, no default

**Chosen:** `pnpm admin:create` reads `ADMIN_EMAIL` + `ADMIN_PASSWORD` (>= 12 chars), hashes with
argon2id at OWASP parameters (19 MiB, 2 iterations, p=1), upserts, and writes an audit row.
Re-running without `--force` refuses. No default or seeded password exists anywhere in the repo.

**Why `hash-wasm`:** it is a pure-WASM argon2id, so the same code runs on Vercel/Netlify without a
native build step (native `argon2` needs node-gyp). Admin TOTP stays optional per BUILD.md §4.

## D3 — DPDP consent + erasure: agreed, but *not* naive deletes (Phase 8)

`specs/schema.sql` has no consent or erasure-request table, and §6 says to use the schema
verbatim. Agreed to add these in **migration 0003 during Phase 8** (0001 stays byte-identical).

Refinement over the original proposal — a naive `DELETE` on an erasure request is the wrong
answer here, because the audit trail and retention obligations conflict with it:

- `consent_record` — append-only, keyed to a **hashed privacy-notice version**, with purpose,
  granted/withdrawn timestamps, actor and evidence. Consent is only defensible if you can show
  *which wording* was agreed to.
- `data_principal_request` — one table covering access / correction / erasure / grievance with a
  status workflow and an SLA clock, rather than a narrow `erasure_request`.
- Erasure is implemented as **pseudonymisation with a retention/legal-hold flag**, not a hard
  delete, so a retained audit trail stays intact. This is the standard reconciliation of the
  DPDP right to erasure with statutory retention.
- A breach/incident log supports the DPDP notification duty.

## D4 — Export scope: contract kept, `501` for unbuilt formats

`openapi.yaml`'s `export_format` enum allows `csv, xlsx, json, xml, sav, do, kml, geojson, pdf`,
but BUILD.md §3 defers `sav/do/kml/geojson` to v1.5. The published contract is **not** narrowed;
v1 implements `csv` (default) `/ json / xlsx / pdf` and returns **`501 Not Implemented`** for the
rest, so no client sees a contract that silently lies.

**`sav` (SPSS) needs an explicit decision.** The client asked for it in v1, which contradicts §3.
It is also the one format with no usable free Node writer: there is no maintained OSS N-API/WASM
`.sav` writer (the one commercial JS option is a paid product, which §4 forbids). Realistic routes
are (a) an async export worker running Python `pyreadstat` / R `haven`, which means a container —
not a serverless function — or (b) keep `sav` in v1.5. **Awaiting a call before implementing.**

## D5 — Hosting: dual-target, no rewrite

The SPA must be deployable to Vercel/Netlify (client requirement) while BUILD.md §4 pins
Docker + Caddy. Both are satisfied by a dual-target build rather than a rewrite:

- `apps/web` is a static Vite SPA — deployable as-is to Vercel or Netlify.
- `apps/api` builds from one `buildApp()` factory; `src/server.ts` listens, `src/serverless.ts`
  is the serverless entry.

On serverless the managed stack is Neon (Postgres) + Upstash (Redis); MinIO and ClamAV cannot run
in a function, so uploads use presigned direct-to-storage URLs and scanning runs on a worker (Phase 4).
The self-hosted profile in `docker/` remains the only one that runs the full spec stack.

## D6 — Added endpoint `/auth/me`

Not in `openapi.yaml` v1. Added so the SPA can render signed-in state without a server round-trip
guess. `specs/openapi.yaml` has been updated to document it.

## Phase 1 verification evidence

Against a real PostgreSQL 16.2:

| check | result |
|---|---|
| `pnpm lint` | clean |
| `pnpm typecheck` | clean (api + web) |
| `pnpm build` | clean (api dist + web dist) |
| `pnpm test` | **16/16 pass** — RLS (7), OTP lifecycle (7), email logging (2) |
| RLS headline invariant | school A reads 0 of school B's rows across `response_set`/`answer`/`attachment`; PK lookup, UPDATE and DELETE all affect 0; spoofed INSERT rejected by `WITH CHECK` |
| migrations | `0001` byte-identical to `specs/schema.sql`; re-running is a no-op |
| HTTP end-to-end | `health` 200 · unknown email 404 · known email 200 **with SMTP down** · wrong code 401 · correct code 200 + `sid` cookie · `/auth/me` 200 · CORS preflight returns the SPA origin with credentials · logout 204 → `/auth/me` 401 |
| audit trail | `otp.requested`, `otp.rejected`, `otp.verified`, `session.issued`, `session.revoked` all present |
| email log | `queued`/`failed` rows written; API responses unaffected by SMTP failure |

---

# Phase 2 — the pivot to a general platform

Triggered by the client correcting the brief: the product is a **general-purpose, multi-tenant
survey/data-collection platform**, not an invite-only school tool. "Login ONLY via registered email"
(§7.1) was the *intended* behaviour of the old brief — that is why a normal Gmail address was
rejected. Research is in `docs/MARKET-RESEARCH.md`; the design it produced is `specs/PLATFORM.md`.

## D7 — Serve all three segments; school survey becomes a template

Client's call: serve teams who need real logic/exports, researchers, *and* the India/field segment.
The school ranking survey is retained as the platform's first **template**, not as the application.

## D8 — Canonical model + adapters, not XLSForm-as-the-model

XLSForm is a *spreadsheet authoring convention*, not one universal format: `dateTime` vs `datetime`
casing, `read_only` vs `readonly`, and platform-only types all differ between ODK, Kobo, SurveyCTO
and Survey123. So the platform owns a canonical JSON definition and treats XLSForm, LimeSurvey TSV,
and SurveyJS JSON as adapters. Contract: `import(x) -> export -> import(y)` yields `y ≡ x`, and the
importer **reports what it dropped**.

## D9 — `.sav`/`.dta` stay `501` until the worker exists

There is **no maintained free pure-JS `.sav` writer** (the one JS option is a paid product, excluded
by the no-paid-services rule). We will not ship KoboToolbox's trick of calling label syntax an
"SPSS export". `.sav`/`.dta` are produced by a Python `pyreadstat` worker; until it is deployed those
formats return `501`.

## D10 — Trust through transparency: non-negotiable principles

`specs/PLATFORM.md` §0. Notably: **nothing mock or stale** (every figure is a live query or a live
subscription), **transparent limits** (we show real usage against real capacity), and **no
user-authored JavaScript** anywhere in the logic engine.

## D11 — Free-tier reality (stated plainly, not hidden)

"Everything free, no caps" is true of **our product's** limits — we do not meter responses. It is not
true of the free infrastructure underneath: Supabase pauses an idle project and takes no backups;
Resend caps at 100/day; Workers allows 100k requests/day. The stack is therefore kept portable
(one `DATABASE_URL` moves it), usage is shown against each real ceiling, and **we never delete
customer data to stay under a quota**.

## Phase-2 verification evidence

Against real PostgreSQL 16.2, and with `pnpm lint && pnpm typecheck && pnpm test && pnpm build` clean:

| check | result |
|---|---|
| migrations 0001+0002+0003 | apply cleanly to a fresh database |
| platform RLS | **all invariants pass** (`apps/api/test/sql/platform-rls.sql`, run as `app_role`) |
| cross-org read | a non-member sees 0 rows in all 9 tenant tables, **even when forging `app.org_id`** |
| cross-org write | INSERT rejected by `WITH CHECK`; UPDATE/DELETE match 0 rows |
| role boundary | a `member` can author but cannot manage the roster or escalate |
| identity bootstrap | org creator becomes `owner`; other users are not members |
| publish invariants | exactly one published version per form; drafts coexist; restore ⇒ new version |
| collector scope | an anonymous respondent can read/write exactly one `response_id`, nothing else |
| logic engine | 24/24 tests — precedence, refs, `selected()`, short-circuiting, constraint-on-non-blank, hidden-and-nulled, group visibility, chained calculations |
| totals | **41/41 tests** (24 engine + 17 api) |

---

# Decision log — platform build (D12 onward)

## D12 — The school ranking survey is a template, not the application

**Chosen:** `TEMPLATES` in `apps/api/src/platform/templates.ts` carries the 2026 school
ranking instrument (cascading district select, repeat contacts, on-site geopoint, computed
composite score) alongside a service-feedback and a field-inspection template. A form is
created from a template, then edited like any other form.

**Why:** the original brief made the survey the product ("login ONLY via registered email + OTP",
800 named schools). That is why a normal Gmail address could not sign in — it was specified, not
broken. Turning the instrument into content keeps the work and removes the constraint.

**Verified:** creating a form from `school-ranking-2026` publishes cleanly, survives
export→re-import through XLSForm with its `state` choice attribute intact, and a submitted
response has the hidden fee question stored as `null` and `composite_score` computed
server-side as 70 for teacher quality 4 + infrastructure 3.

## D13 — A bare identifier is legal *only* inside `choice_filter`

**Chosen:** the expression parser now accepts a bare name as an AST node instead of throwing.
`validateForm` rejects it in every field except `choiceFilter`, where it resolves against the
current choice's `extra` attributes (XLSForm writes cascading selects as `state = ${state}`:
bare `state` is a choices-sheet column, `${state}` is the answered question).

**Why:** our first XLSForm fixture failed the publish-time analyser on a *correct* XLSForm
expression. The alternative — rewriting the expression on import — would have made a
round-tripped form behave differently from the file the author has.

**Honest edge:** XPath says `'' = ''`, so an option that lacks the attribute column still
matches an unanswered question. That is real XLSForm behaviour, it is asserted in a test, and
it is the reason a cascading select needs every option to carry the column.

## D14 — Export missingness is a first-class fact, not a blank

**Chosen:** a blank data cell means "no value"; *which* kind of missing it is lives in the
`missing` table and the codebook — `system` (asked, nothing recorded), `not_asked` (response
ended, or the version changed), `skipped` (logic hid it), `refused`, `dont_know`. Statistical
codes (−96…−99, `system` = blank) are documented for the `.sav`/`.dta` phase.

**Why:** collapsing those five into one blank is the single most common way a survey export
quietly misleads an analyst. In multi-selects, `0` (not selected) is likewise kept distinct
from blank (not asked).

## D15 — CSV injection: keep the data, add a sanitised view

**Chosen:** `data.csv` is written exactly as captured; a separate `spreadsheet-view.csv`
tab-prefixes formula-looking cells. A plain negative number (`-5`) is left alone; `-2+3|cmd`
is not. XLSX needs no such treatment because a text cell is a shared string, never a formula.

**Why:** silently corrupting the data column to defend against Excel is not a fix. The
bundle explains in `meta.json` which file is which, and the difference is asserted in tests.

## D16 — Public collection is authorised by a token and confined by a policy, not a route check

**Chosen:** `app_resolve_dist_link` (SECURITY DEFINER) turns a token hash into one link row;
everything after that runs with `app.collector='on'`, `app.org_id` from that row and
`app.response_id` for the single response in play. `form_version` gained a narrow
`form_version_collect` policy: the *published* version, in that organisation, nothing else.

**Why:** without that policy a respondent could not read the survey they were answering — the
first version of this shipped as a 409 "not published" on every submission, which the tests
caught. Also fixed by the same reasoning: `dist_link.token_hash` only — the token is a bearer
credential and is shown once.

## D17 — Two infrastructure bugs worth remembering

- **Fastify child contexts inherit the error handler that was current when they were
  registered.** Our handler was installed after the route plugins, so every route silently used
  the default serialiser and a row-level-security refusal looked like a 500. It is now installed
  first, and `42501`/`23505` map to 403/409.
- **The per-IP rate limit (120/min) is a real production limit and a test hazard.** It is now
  `RATE_LIMIT_MAX` (default 120) so a test run from one address does not get throttled into
  failures that look like feature bugs.

## D18 — "Sent" must mean sent

**Problem:** the login screen said nothing was wrong while `[mail] delivery failed (otp):
connect ECONNREFUSED ::1:1025` filled the log. The OTP request returned `{status:'sent'}`, the code
was never emailed, and the only way to find out was an empty inbox.

**Chosen:** `GET /api/v1/auth/mail-status` verifies the SMTP transport (cached 60 s, 2 s connect
timeout, never on the request path) and reports `{reachable, host, port, detail}`. `otp/request`
answers `not_delivered` with that reason instead of `sent`, and the login screen renders the code
in a copyable block whenever email is not actually usable.

**Why it matters beyond this bug:** an auth system that reports success it did not achieve is
indistinguishable from a broken one. The same reasoning produced D9 (`.sav` returns 501 rather
than a plausible file) and the importer's "what we dropped" report.

## D19 — Mail that can actually leave the building

**Problem:** with real credentials in place, delivery still failed —
`cannot reach smtp.resend.com:465 — Connection timeout`. The cause was not the
provider or the key: this network refuses **every** SMTP port (25, 465 and 587 all
time out to `smtp.resend.com`, and smtp.gmail.com:465 too) while HTTPS on 443 is
open. No SMTP configuration of any kind could ever have delivered from here, and
the failure mode — a relay that resolves, connects nowhere, and reports nothing —
is indistinguishable from a wrong password.

**Chosen:** a second transport. `MAIL_TRANSPORT=resend` posts to the provider's
HTTPS API (`POST https://api.resend.com/emails`, 10 s hard timeout, `fetch`), and
the default is inferred: an API key selects HTTPS, no key means SMTP as before.
A login code now waits for that call, so the response carries the provider's own
verdict — `delivery: {ok, id, detail}` — instead of a probe. When the relay
refuses, its message is what the operator sees ("domain is not verified", "you
can only send testing emails to your own email address"), because those two
sentences name the fix and a generic 502 does not.

**Why delivery did not simply move to the request path everywhere:** SMTP is not
waited for. A dead SMTP relay costs seconds of connect timeout, and its verdict
comes from `verify()` rather than a reply, so that path keeps its background send
and its cached probe (D18).

**Consequence, stated plainly:** `mail-status` reports `basis: 'last-send'` for
HTTPS, because a sending-only API key can read nothing back from the provider.
With `basis: 'none'` the honest answer is "unproven", not "broken" — and the login
screen says so rather than raising a false alarm.

## D20 - Access belongs to the owner, and the terms gate is real

**Problem:** the product let anyone with an address sign up, and the login screen
offered the code on screen, so an inbox was optional. Neither is acceptable in
something that holds other people's survey data.

**Chosen, in four parts.**

1. **Invite only.** `INVITE_ONLY` defaults to true. An unknown address gets the
   same `404 not_invited` whether or not an account exists, and no row is created.
   The first owner of a deployment comes from `pnpm --filter @inicio/api
   bootstrap:owner --email ... --org ...`, because somebody has to be first and it
   should not be a public endpoint.

2. **Single use invitation links.** An owner or admin creates one. 32 random
   bytes, URL safe, and only the SHA-256 is stored, so a database or backup
   disclosure hands nobody a usable link. Bound to the invited address, carrying
   the role the inviter chose, expiring in 1 to 30 days. Redemption is one atomic
   UPDATE that succeeds only while the row is pending, so two racing clicks give
   exactly one membership. The link is shown once, at creation, and is absent from
   the listing afterwards.

3. **Reading a link is not spending it.** The URL in the email opens a page that
   only previews the invitation; joining is a POST. Mail scanners, proxies and
   link previews fetch URLs before the person sees them, and an invitation eaten by
   a robot is indistinguishable from a broken one.

4. **The terms gate.** Terms and privacy policy versions are constants whose hash
   is computed from the same text the API serves and the browser renders, so an
   acceptance can be checked against a retrievable document rather than trusted.
   The checkbox starts unchecked, the button stays disabled, `accepted` must be
   literally true, and a stale version is refused with 409. An account that has not
   accepted can authenticate and can reach `/me` and the acceptance route, and
   nothing else: every other authenticated route answers 403 `terms_required`.
   Acceptance is an append-only event carrying the user, the time, both versions
   and hashes, the checkbox wording, IP and user agent. There is no UPDATE or
   DELETE policy on it.

**Roles, and who can do what:** owner and admin manage the roster and issue
invitations; member uses the product and cannot invite or see the roster controls;
viewer reads and exports. The same rule is enforced in SQL through
`app_has_org_role`, in the route guard through `withOrg({ roles })`, and only then
in the menu. Removing someone takes effect on their next request rather than at
their next sign in, because membership is re-read every time.

**Also in this change:** the public `mail-status` no longer reports the relay, the
transport or the provider's error text. A visitor learns whether a code can be
sent; the detail moved to the admin console, where somebody can act on it.

**A bug worth recording:** `app_redeem_invite` named its `RETURNS TABLE` columns
`user_id`, `org_id`, `role`. Inside a PL/pgSQL body those names are variables, so
the `INSERT INTO membership (org_id, user_id, role)` was an ambiguous column
reference and redemption failed with a 500 on first use. 0008 renames them. The
test suite caught it because invitations are exercised end to end, not just
created.

## D21 - Tests no longer share a database with development

**Problem:** every test file dropped and recreated `public` in the configured
database. That is the same database the application runs against, so running the
suite deleted whatever the operator had just created, including their own account.
It happened twice during this work.

**Chosen:** the suite derives its connection string from the configured one by
appending `_test`, creating that database on first use, and leaving the configured
one alone. Two names, two databases, no cleanup discipline required.

## D22 - The collect link must never be a dead end, and the builder must not lie

**Problem:** a form created from a template starts life as a *draft*, and the
Distribute tab handed out a link for it anyway. Opening that link showed a
respondent "this survey is not accepting responses yet" with no way forward, which
is indistinguishable from a broken product. Two further things compounded it: the
JSON preview in the builder loaded once, keyed on the version id, so an XLSForm
import that rewrote the *same* draft left the preview showing the definition that
no longer existed; and an import into a published form created a new draft that
the UI never selected, so a successful import looked like nothing happened. The
same staleness made exports look wrong, because exports descend from the
*published* version.

**Chosen, on the API side:** the refusal a respondent sees is written for a
person, not for a developer. `not_published` now says "This survey is not open
yet. Please try again later, or contact the person who shared this link." and the
expired / closed / already-used / invalid cases each get their own sentence. The
machine-readable `code` is unchanged, so the browser can still branch on it, and
no authoring concept (publish, version, draft) reaches the person holding a link.
An unknown token stays a 404 and stays friendly. The export refusal says to
publish in the Builder tab, and the export's `meta.publishedAt` is finally real:
it was hardcoded null, which made "published" and "never published" identical in
the metadata a researcher downloads.

**Chosen, on the console side:** the Distribute tab refuses to create a link until
something is published and says why, because handing out a link that opens to a
dead end is worse than a moment of friction. The Responses tab disables the
export buttons and explains that responses are collected against a published
version. The builder's JSON preview re-reads whenever the stored definition
changes (an explicit revision counter for an in-place import, plus the version's
question count), and it never clobbers unsaved keystrokes. Saving the editor
redraws the preview from the server's canonicalised definition, so what the
preview shows is what the database holds. An import selects the version that was
actually written, and a published version is shown as immutable rather than
offering a Save button that can only fail.

**The invariant:** a count, a preview or a link on screen must be a fact about
the server's current state, or the interface must say that it is not yet.

## D23 - Nothing on screen is a fixture, and nothing on screen is stale

**The problem.** The workspace still contained the residue of earlier test runs:
mock accounts (`a@example.org`, `b@example.org`), two throwaway organisations and
their forms, sitting beside the real account. Separately, two code paths could
still produce data that was not a fact about the product: a Phase-1 dev echo that
would return the login code in the API response, and a Phase-1 self-signup bridge
that would create an account for any address that asked.

**Chosen.** The dev echo and the self-signup bridge are gone from the source, from
the environment schema and from the built output. There is now no code path
anywhere that hands a code to the browser or creates an account outside an
invitation; the only thing that reaches a client on `otp/request` is
`{status: "sent"}`, and an unknown address is uniformly `not_invited`. The live
database was cleaned of the mock accounts and organisations (backed up to a local
file first, not committed) so the workspace contains only the real account, its
organisation and its own form.

**Chosen, for freshness.** Polling alone is not enough: browsers throttle or
freeze timers in a background tab, so the first thing a returning reader saw could
be a snapshot from minutes earlier. Every polled view now also refreshes on
`visibilitychange` and on window `focus`, and the administration console does the
same. The Responses tab surfaces the server's live analytics (per-answer tallies
and a daily timeline, recomputed on every request) with the server clock time the
numbers were read, so "realtime" is visible rather than asserted. `/auth/me`
now returns the same `form_count` / `member_count` the client type already
declared, so the contract and the payload agree.

**The invariant this round rests on:** every number, list and link the interface
shows is read from the server at that moment, and the only path to an account is
an invitation.

## D24 - Hosting: one origin, and the entry point is a translator

**The problem.** The product is a Fastify API plus a Vite SPA, and every frontend request assumes
one origin: `api.ts` calls `/api/v1` relatively, and the session cookie is host-only. Deploying
the SPA and the API to two different domains would have looked fine until login, because a
host-only cookie set by `api.example.com` is simply not sent by a page on `app.example.com`.

**Chosen.** A single Vercel project serves both, so the browser only ever talks to one origin.
`vercel.json` builds the SPA and routes `/api/*`, `/auth/*` and `/health` to a serverless
function; Netlify, if it is used, is a mirror of the SPA that proxies those same prefixes back to
the Vercel deployment, which makes it a second front door to one origin rather than a second
backend.

**The wrinkle worth writing down.** Vercel only discovers functions in the project's root `api/`
directory, and it replaces the request path when it routes a rewrite to a function, and its
catch-all file convention (`api/[...path].ts`) produced a single-segment route rather than a
catch-all in this configuration. Rather than restructure the application around a platform
quirk, `api/ingest.ts` is a translator: the rewrite carries the original prefix and tail as
platform bookkeeping parameters, the entry point rebuilds the URL, strips both parameters, and
hands the request to the same `buildApp()` that the long-running server uses. One copy of the
routes, one copy of the tenancy rules.

**Also found while deploying, and fixed.** The first hosted deployment connected as the database
*owner*, not `app_role`: the provider's database integration claims `DATABASE_URL` for the owner
connection, and on Neon that role holds `BYPASSRLS`, which switches row level security off
entirely. Every HTTP test still passed, because the tests had never connected that way. The fix
has three parts: `APP_DATABASE_URL` names the application's connection explicitly and wins when
set, so the owner URL a platform injects stays what migrations need and never becomes what the
server uses; the role is checked on every cold start; and in production a connection that is a
superuser or holds `BYPASSRLS` stops the process with a message naming the fix. Proved both ways
against the live database, then proved live isolation with two organisations: the second account
got 404 on the first account's form, responses, analytics, export and member list, and a 403
(the database's own refusal) when it tried to create a form inside the first account's
organisation. The CORS allow-list includes the deployment's own `VERCEL_URL` so preview builds work
without opening it to every origin. Invitation links are returned as a *path* as well as an
absolute URL, and the console prefixes its own origin: the same deployment can then be reachable
on more than one hostname without either one handing out a link that points at the other.

**Verified.** The full consumer journey ran against the live deployment with the managed
database: invitation-only gate, publish, three real respondent submissions, live reads, every
export format and its contents, single-use link enforcement, and an XLSForm import round trip.
35 of 35 checks passed.

## D25 - Offline collection: the device owns the response, and a disagreement is data

**The problem.** Collection assumed the server was reachable. A respondent with no signal could not
open a survey (the definition came from the network), could not start a response (the server minted
its id), and a save that failed existed only on screen: the interface said "saved" when nothing had
been sent. For the field teams this product targets, that is the single largest source of lost work,
and the master prompt's invariant is explicit — **NO SILENT DATA LOSS**, ever, anywhere.

**Chosen, and why each part.**

1. **The device owns the response UUID.** A client-generated UUID *is* the response id, and
   `POST /collect/:token/responses` resolves it idempotently: the first call creates, a retry
   returns the existing row with `created: false`. Server-assigned ids cannot be known while
   offline, and without a stable identity a retried start after a dropped connection creates a
   second response — the duplicate this phase exists to prevent. A client UUID presented against a
   different survey is refused (`409 client_id_conflict`) rather than silently adopted. The unique
   index is `(org_id, client_uuid)`, so tenancy still bounds it.

2. **The published definition is cached on the device.** A respondent can therefore open a survey
   they have visited once with no network, and the renderer evaluates the *same* engine the server
   does. With no cached copy and no connection the page says so plainly instead of showing a
   spinner forever.

3. **Every keystroke lands in IndexedDB first.** Persistence never depends on a timer or a socket.
   The queue that follows is deliberately not a log of keystrokes: a save supersedes the previous
   save (each carries the whole answer set) and a submit supersedes a pending save, so the queue
   stays one entry deep no matter how long the connection is gone.

4. **The device sends `base` — the last server state it saw.** This is what makes a merge possible
   at all. Without it the server cannot tell "the device is re-sending what I already hold" (a
   no-op) from "the device changed this field while I also changed it" (a real conflict, and data
   loss if overwritten). With it, `planSync` decides per question: only the device moved ⇒ the
   device wins; only the server moved ⇒ the server wins; both moved the same way ⇒ converged;
   **both moved differently ⇒ the server's value is stored, the device's value is preserved in
   `response_answer.device_value`, and the disagreement is recorded in `response_conflict`.** A
   calculated value the device reports that disagrees with the server's own computation is flagged
   the same way (§13.4), and hidden questions are stored as `null` (§13.2.1) rather than keeping a
   stale value.

   The `PATCH` response returns the canonical stored answers, and the device adopts them as its new
   `base`. The next comparison is then against what the database actually holds, not against the
   device's belief about it.

5. **A refused submission keeps the answers.** A `422 incomplete` demotes the submit intent to an
   ordinary save and reports the missing/invalid questions, because retrying cannot fix a missing
   answer and the answers must still reach the server. A retried submit after a *successful* one is
   `409 already_submitted`, which the client treats as success.

6. **The service worker caches the shell and nothing else.** `/api`, `/auth` and `/health` are
   passed straight to the network, so no cached body can ever be served as live data. What is
   precached is the document and the hashed bundles it references — the thing that makes the app
   openable at all with no signal. It is registered in **production builds only**; in the Vite dev
   server a worker would sit between the browser and hot module replacement and cache the very
   files that are supposed to change on every save.

7. **Autosave is belt and braces.** On change (debounced), on field blur, on `visibilitychange` and
   `pagehide`, on `online`, on window focus, and on a 2-minute timer — because a respondent who
   types one answer and then thinks for ten minutes should still have it on the server.

**What the respondent sees.** One line, in their words, never a developer's: "No connection. Your
answers are saved on this device and will be sent automatically", plus "Saved on this device at
…" and "The server has everything up to …", plus a **Send now** button when anything is waiting.
The distinction between *queued* and *confirmed* is stated rather than implied.

**Verified.** 131 automated tests (54 engine, 58 API, 19 web) with `lint`, `typecheck` and `build`
clean. The 6 new API tests drive a real PostgreSQL as `app_role` and assert idempotent start,
two-device merge, that the loser's value is *retained* rather than dropped, hidden⇒null, a
calculated-value mismatch, an idempotent retried submit, and that an invalid submit still writes
nothing. The 19 web tests cover the queue/backoff/resume rules with an injected clock and store,
and execute `public/sw.js` inside a VM to prove the routing — including that a `/api` request is
never intercepted and is never even fetched by the worker. Through the preview origin (port 3000,
the path the browser takes) `.run/e2e-offline.mjs` runs **24 of 24** checks over a real database
and deletes the organisation it created; the pre-existing consumer harness still passes **33 of
33**.

**Honest limits.** The offline queue is verified by unit tests and over HTTP, not by a scripted
browser — this environment has no browser automation, so a person should confirm installing the app
and filling a form in airplane mode on a real device. Offline *submission* is acknowledged only
when the server answers, so the confirmation screen appears after the connection returns, by
design. `response_conflict` is surfaced in the Responses tab (a per-response count and a plain
explanation) but is not yet a research-data column in the export bundle; that belongs with the
quality-flag queue (P12) and the codebook.

## D26 - A root static file must be named in the SPA catch-all's exclusions

**What happened.** The offline app worked locally and not in production. On Vercel a `rewrites` entry
takes precedence over the static filesystem, so the SPA catch-all answered `/sw.js` and
`/manifest.webmanifest` with `index.html` and a **200**. The service worker therefore never
installed (`index.html` is not valid JavaScript) and the manifest was never parsed — and every
check that asked "is it 200?" said yes, because the fallback returns 200 for everything.

**How it was actually found.** By asserting the *content*: the fix was verified with
`content-type: application/javascript` for the worker, `application/manifest+json` for the
manifest, `image/png` for the icons, and `text/html` for a real app route still falling back to the
shell. A status-code check on the deployed origin cannot distinguish a served file from the
fallback, and this is the second time in this project that a plausible-looking 200 hid the real
behaviour.

**The rule.** Every root static file is named in the catch-all's negative lookahead
(`api/`, `assets/`, `sw.js`, `manifest.webmanifest`, the icons, `favicon.ico`), and a new root asset
must be added there too. The same trap does not exist on Netlify, whose `/*` → `/index.html`
`status = 200` redirect is a *fallback* that real files shadow — but the deployed check is by
content type regardless of host.

**Also confirmed on the live host.** `sw.js` is served `cache-control: max-age=0, must-revalidate`,
which is what a worker needs so an update is picked up on the next navigation rather than being
pinned for a year by an immutable cache header.

**Verified live (production, 2026-10-12).** Migration `0009` applied before the code that needs it;
`main` at `7ec8be2` deployed by the connected Vercel project. `.run/e2e-offline.mjs` — 28/28 through
`https://inicio-six-psi.vercel.app`: a throwaway account that accepts its own terms and is deleted
afterwards, organisation and form creation, publish, a device-owned UUID start, a retried start,
two-device conflict with the device value read back from the production database, a doubled submit,
live analytics and conflict counts, JSON and CSV exports carrying the submitted answer, and the
manifest/worker as the browser fetches them. Separately, the RLS criterion was re-proved against
production: the deployed API connects as `app_role` (not superuser, no `BYPASSRLS`), and a forged
`app.org_id` read **0 rows from all 9 tenant tables**. Production afterwards holds exactly one
account, one organisation, no forms, no responses, no conflicts — the harness removed everything it
created, and the owner's own terms acceptance is still pending because accepting legal terms is the
owner's action, not a script's.

## D27 - Integrations and quality control: a key is a narrow session, and a flag is a queue

**What shipped.** `0010_api_keys_webhooks_flags.sql` — API keys with a scope vocabulary, webhook
endpoints with a durable delivery queue, and `response_flag` with a small explicit rule set. Two of
those tables (`api_key`, `webhook`, `webhook_delivery`) already existed as **stubs** in `0001`: they
had a `label`, a `key_hash`, a `url`, a `secret`, and no organisation, so nothing in them could be
authorised. They are *extended* rather than duplicated, because two tables called "api key" is
precisely how a schema ends up with two answers to "who may act as this tenant".

**Why a key is bound to a person, not to an organisation.** Every policy in `0003` authorises through
`membership`; a key that carried only an organisation id would need either a parallel policy branch —
a second place to get tenancy wrong — or a way around RLS. Bound to its creator, a key inherits exactly
the boundary a browser session has (same policies, same 404s for foreign rows), and removing that
person from the team kills the key on the next request. Revocation is therefore not a second mechanism
that can drift; it is the membership check that already exists. What an operator can inspect
afterwards is the prefix (`ik_` + 11 characters), never the secret: only `sha256(secret)` exists.

**Why the machine surface is deny-by-default.** `requireActor` refuses a key at any route that does
not *declare* a scope, and the three refusals are deliberately different sentences: `key_not_permitted`
("this route is not part of the machine API"), `insufficient_scope` naming the missing scope ("your
key is real and too narrow"), and `key_org_mismatch` ("this key belongs to another organisation",
including when its creator happens to be a member of both). "Your key cannot call this" and "your key
is wrong" are different problems, and conflating them makes an integration undebuggable from outside.
A consequence worth stating: a key can never mint another key and can never change where an
organisation's data is sent, because those routes name no scope.

**The scope vocabulary is wider than the surface, and that is now visible rather than implied.** A
scope is a promise about a capability, not about a route that exists this week — but the console's own
default was `forms:read` + `responses:read`, which **no route declares**, so the product's own UI was
minting keys that could call nothing. `GET /api-scopes` now marks each scope with whether a route
declares it (`ENFORCED_SCOPES`), the console disables the rest *with the reason printed*, and
`api-keys.test.ts` asserts both the marking and that a key granted only `forms:read` still cannot call
`/forms`. The gap is documented by a control, not by a sentence in a README that the next person
edits away.

**Why a delivery is written inside the event's own transaction.** A publish that committed has a
delivery row per subscribed endpoint; a publish that rolled back has none. That is what makes an event
exactly-once *with the data*, and it is a property no amount of retry logic can add afterwards.
Delivery itself is at-least-once against a stable delivery id and an `idempotency_key` of
`(event, endpoint)`, which is the only honest promise an HTTP client can make. `X-Inicio-Signature` is
an HMAC over the timestamp and the raw body, so a captured request cannot be replayed, and the test
verifies it with an **independent HMAC** plus a counter-assertion that a signature over the body alone
does not match. Five consecutive failures disable the endpoint and record why in words: an endpoint
that has failed two dozen times is usually a deleted receiver, and retrying it forever is how a queue
turns into a backlog nobody looks at. HTTPS is a database constraint rather than a route's opinion,
because the second route that creates an endpoint should not have to remember it.

**Why a flag is a queue and not a score.** A score cannot be argued with, dismissed, or handed to
somebody. The rule set is small and explicit (`speeding`, `straight_lining`, `duplicate`, `manual`),
every row carries the evidence the detector recorded — the duration against the threshold, the value
that repeated, the response it duplicates — and closing one records the decision, the person and the
note. Dismissing is a distinct outcome from resolving, because "I looked and it is fine" is an answer
that deserves to be recorded as itself. Speeding and straight-lining are decided in the respondent's
own transaction, where the duration, the answers and the timestamp are all in one place; duplicates
need the whole form, which a respondent's transaction may **not** see — the collector policies exist
precisely to stop a public link reading other responses — so exact-duplicate detection is an organiser's
`POST …/flags/scan`. A unique index on `(response_id, kind, coalesce(question_id, ''))` makes that
scan idempotent rather than merely careful.

**A small lie removed while testing it.** The manual-flag route answered `201 { queued: true }` even
when the unique index refused the insert, so a second identical complaint was answered as if it had
been recorded. It now returns the row count and answers `200 { queued: false, reason:
'already_recorded' }`, with the audit row written only when something was actually written. This is the
same shape as **D18** ("sent" must mean sent): the response said more than the write did, and no test
was asserting the difference until one was written to.

**The machine surface grew to the read API, which is what it was for.** The first cut of this feature
wired `flags:*` and nothing else, so four scopes in the vocabulary were promises no route kept: an
integrator could grant `responses:read` and find the key could not read a response. That is fixed by
declaring a scope on the routes that already existed — `forms:read` for the form list, one form, a
version's definition and the XLSForm export; `responses:read`; `analytics:read`; `responses:export` —
and *not* on the writes. Publishing a form, moving a distribution link, minting another key or
changing where data is sent all stay session-only, because a machine credential that can publish is a
different risk from one that can read, and `requireActor` makes that difference a property of the
route table rather than a habit. Two details are worth keeping: `GET /forms` is narrowed to the key's
organisation **in SQL** rather than filtered after the read, and the reads whose organisation is only
known once the row is loaded call `assertActorOrg` then — so a key issued for A is `403
key_org_mismatch` against B's form even when its creator is a member of both. `GET /api-scopes` reports
which scopes are live, the console refuses to grant one that is not, and the suite asserts the
catalogue never runs ahead of the routes: the invariant is that a scope a person can select always
names a route that checks it.

**And the contract was rewritten, because a stale contract is an unearned claim.** `specs/openapi.yaml`
described a questionnaire and `admin` surface that has not been mounted since Phase 1 — paths nobody
can call, documented as though they were verified, and referenced from the README as "the contract".
It now enumerates the routes `app.ts` actually registers, marks the Phase-1 `/auth` block
`deprecated`, names the three credentials (session cookie, bearer key, distribution token) and exactly
which operations each reaches, and states the error vocabulary. Where a handler assembles its response
inline it says `type: object` rather than inventing fields, on the same principle as `.sav` returning
`501`: an honest loose schema beats a precise wrong one. **And it is held to the code rather than to a
memory of the code:** `apps/api/test/openapi.test.ts` reads the file (`yaml`, a dev dependency of the
API), pulls the `app.<method>('<path>')` registrations out of the route sources with the prefixes
`app.ts` and `platform/index.ts` actually mount, and compares the two sets *both ways* — a route added
without an entry fails, and so does an entry kept after its route is gone. It caught two on the first
run: the invitation routes were documented at `/api/v1/invite/…` while they are mounted at
`/api/v1/auth/invite/…`. The same test pins the machine surface to the eleven operations a key may
call, requires the scope each one needs to be *named in its description*, asserts the unauthenticated
surface as an explicit list rather than a count, and refuses any scope-shaped token that `API_SCOPES`
does not define. That is what makes "the contract" a claim the suite can lose rather than a document
that ages quietly; deriving the schemas from Fastify's types would be the next step, and is not done.

**The isolation proof now enumerates every tenant table.** `apps/api/test/sql/platform-rls.sql` forged
`app.org_id` as the non-superuser `app_role` and asserted zero rows across the nine `0003` tables. The
list now carries all **fourteen** — `response_conflict`, `response_flag`, `api_key`, `webhook`,
`webhook_delivery` included — so a table whose isolation is claimed but not enumerated fails the suite
instead of being forgotten. (The "9 tenant tables" figures in the phase-2 verification records above
are historical and are left as they were measured.)

## D28 - The studio: one definition, three readers, and the class name that broke a form

**What shipped.** The Builder tab's definition editor was a textarea and a save button: the analyser ran
when you pressed it, the XLSForm file was a download you could not read, and the form a respondent would
open was not on the screen at all. It is now `apps/web/src/studio.tsx`, three panels over one definition —
the JSON the API stores, the XLSForm sheets `Download .xlsx` writes, and the form a respondent opens from
a distribution link — repainted on every keystroke, in a chunk of its own (5.5 kB gzipped).

**Why the three panels are three readers of one object rather than three screens.** A JSON panel, a
workbook viewer and a preview are only useful together at the moment they can disagree, and the thing that
makes them disagree is a copy. So they are not copies: the text in the first panel is parsed once per
keystroke and the other two read that value through the engine the API also runs (`xlsFormSheets` for the
sheets, `validateForm` for the findings, `evaluateForm` for the form). The test asserts the property that
follows from it — after editing the JSON, the request log contains **no request that is not a read** — which
is a stronger statement than "the panels updated", because it is the statement that they updated without
asking anybody. The analyser moved into that loop for the same reason: `validateForm` used to run on save,
and a publish-blocking mistake is cheapest to fix at the keystroke that made it, not at the button that
found it. Half-typed JSON is a normal state of a textarea, so the panels say what it is ("not valid JSON",
"`questions` is not an array") and stay standing rather than blanking or, worse, showing the definition
they used to have.

**Why the preview is the respondent's component and not a picture of it.** The claim a preview makes is
"this is what they will see". A second renderer that approximates the first is the most expensive way to
be wrong, because it is checked against the wrong thing by the person best placed to catch the mistake. So
the form was extracted from `collect.tsx` into `apps/web/src/respondent.tsx`, the collection page renders
it, and the studio renders it — the only differences are props: the collection page passes the connection
pill, the device's own saved-at line and a submit button that writes a response; the studio passes a
`preview` pill and a submit button that is present and `disabled`, because a preview that can write a
response is not a preview. `studio.test.tsx` mounts both ways and asserts the question blocks are
**character-for-character identical**, so the day somebody adds a field to the preview and not to the form
(or the reverse) the suite says so. That test is deliberately about markup rather than about a screenshot:
markup is what the two call sites actually share.

**Why the workbook viewer is the export minus the zip.** `exportXlsForm` built its three sheets inline and
then zipped them, so showing a workbook in the browser meant importing the zip writer to draw a table.
The body moved into `xlsFormSheets(def)` and `exportXlsForm` became a zip around it. Two consequences, both
wanted: the panel and the file are the same rows by construction rather than by agreement (asserted against
the written file in `xlsform.test.ts`, modulo the trailing blank cells a spreadsheet cannot store), and the
console's critical path never sees `fflate` — which is why the studio is 5.5 kB gzipped and the budgets
check can assert that no critical chunk contains `list_name`, `constraint_message` or `begin_repeat`.

**And a class name broke the whole respondent form, which no existing test could see.** The ambient light
field behind the signed-in app is a fixed, full-viewport, `z-index: -1`, `pointer-events: none` layer. A
question in a form is a block inside a card. Both were called `.field`. Every question on every collection
page was therefore `position: fixed; inset: 0; z-index: -1; pointer-events: none` — stacked at the origin,
painted behind the card it belonged to, and unable to receive a click. The markup was correct, the API
answered correctly, the API-level tests and both HTTP harnesses passed: the form a respondent opened was
simply unusable, and the studios' preview would have shown exactly the same nothing. The lesson is that a
thin global namespace (a bare class name) is a shared mutable resource between two components that have
nothing to do with each other, and that a jsdom test cannot catch it because jsdom applies no stylesheet.
The host is `.ambient` now, and `apps/web/test/shell.test.ts` asserts the *properties* rather than the names:
the fixed layer keeps its `position: fixed`, and the class a question block wears may set nothing but
margin — so a future rename on either side cannot put the two back together. It also asserts that the form
still uses `.field`, because a guard that can be satisfied by renaming the form's class away is not a guard.

## D29 - The application's connection is a role, and the tests' connection is a host

**What was wired.** A Neon project was attached to this repository: ten migrations applied to it
(`0001`–`0010`, latest `0010_api_keys_webhooks_flags.sql`), S3-compatible object storage and the
OpenAI-compatible AI gateway reachable with the credentials the project hands out, and the application
pointed at it. The interesting part was not the URL, it was that **the credential set Neon gives you cannot
run this application**, and the reason is the one the project already documents: the role is what enforces
tenancy.

**Why `DATABASE_URL_POOLED` is not "the app connection".** Neon's two names describe *pooling*, not
privilege: `DATABASE_URL` is the direct endpoint and `DATABASE_URL_POOLED` the pooled one, and both belong to
the owner. On this database that owner carries `BYPASSRLS` (verified with `pg_roles`, not assumed), which is
exactly the connection `assertTenancyEnforced()` was written to refuse in production. So the names were not
mapped onto `APP_DATABASE_URL`/`MIGRATION_DATABASE_URL` by shape — a reading that would have quietly put the
whole platform on a role with no tenant boundary in development and refused to boot in production. What was
done instead: migration `0002` had already created `app_role` (non-superuser, no `BYPASSRLS`, `SELECT` on all
32 tables), it had simply never been given a password, because "no secrets in migrations" and the out-of-band
step is the operator's. One `ALTER ROLE app_role WITH LOGIN PASSWORD …` closes both gaps at once, and each
connection then takes the endpoint its workload needs: the API over the **pooler** as `app_role` (serverless
invocations are short and many), migrations over the **direct** endpoint as the owner (DDL behind a
transaction pooler is a mistake waiting to happen). The API does not merely claim this: `pg_stat_activity`
shows the running process connected as `app_role`, which is the check that distinguishes "the URL was set"
from "the URL is in use".

**Why the tests then had to be stopped from following it.** `src/env.ts` prefers `APP_DATABASE_URL`, and the
workspace's environment file is also what the suite reads, so wiring the app to a deployment pointed the
suite at it too: a test run would have created `inicio_test` on that cluster, dropped its schema, and run
103 tests against somebody's production project — the tenancy-is-a-convention failure this codebase keeps
arguing against, arriving through a config file rather than through SQL. `test/setup.ts` now resolves both
connections and refuses a host that is not this machine, naming the variable to change instead of guessing,
which is the same posture as `assertTenancyEnforced`: the run stops loudly rather than doing something
surprising one database over from the real data. Verified both ways — the deployed URLs stop the run with
`MIGRATION_DATABASE_URL points at ep-…neon.tech`, and against the local cluster all 14 files and 103 tests
pass.

**Honest limits.** Object storage and the AI gateway are configured and were probed successfully with real
calls, but no feature consumed them yet: file uploads were deliberately unbuilt when this was written, and were
built afterwards in two halves (D30 below), this
platform's identity is its own invitation-only OTP flow rather than Neon Auth, and nothing calls a model.
Credentials that exist are not integration, so none of the three is claimed as integrated here; the
object-storage path (attachments) is the one that has a designed feature waiting for it.

## D30 - Attachments are signed by hand, and `clean` is a verdict rather than a hope

**What was wired.** Uploads, end to end. An `image`, `audio`, `video` or `file` question on a public
link can be authorised, uploaded and verified — and now from the product's own interface: the control in
`apps/web/src/respondent.tsx`, wired by `collect.tsx`, authorises the upload, PUTs the bytes and calls
`complete`, then stores the attachment id the server returns as that question's answer.
The path the browser takes is the one the tests also drive headlessly: a PUT of the bytes to S3-compatible
object storage against a URL this API presigns, so a video is not a video-sized response body from a
serverless function and the store's credentials never leave the server. The first thing worth noticing is what did *not* have to happen: `response_attachment` was
already in `0003_platform.sql` with `storage_key`, `sha256`, `scan_status` (`pending`, `clean`, `infected`,
`error`, `skipped`), `status`, `FORCE ROW LEVEL SECURITY` and the collector policies, and `app_role`
already held the grants — **so this shipped with no migration at all**. The schema was written for this
feature and the feature caught up with it. D29 recorded object storage as configured but unconsumed; this is
the feature that consumes it, so the "credentials that exist are not integration" caveat no longer applies
to storage.

**Why SigV4 is written out rather than imported.** `@aws-sdk/client-s3` is the obvious dependency and it was
not taken. Every operation this product needs is a *presigned* request — the upload the browser makes, and
the API's own HEAD, GET and DELETE — so a single signing implementation covers all four, whereas the library
route means signing a query string for the browser and signing headers for our own calls: two code paths
that can disagree about what "the same request" is. It is also a large dependency inside a serverless
function whose only job here is to sign a string, in a repository that hand-writes the XLSX reader and
writer it depends on for exactly this reason. What made that safe rather than brave is that this algorithm
is provable: the test that covers it stands up a stub store which **recomputes the signature from the
incoming request and refuses anything that does not match**, so the suite does not assert that a URL looks
plausible — it asserts that an independent implementation of the store's own verification accepts it. The
content type travels inside the signature, which is what makes a handed-out URL able to upload one object of
one type rather than "anything to this key".

**Why `error` and `skipped` are statuses, and `clean` is not a default.** A deployment with no scanner is
the normal case for a self-hosted instance, and the honest record of that is `skipped` with a reason — not
`clean`, which asserts that a scanner read the bytes and found nothing. `error` covers the third case that a
boolean cannot express: a scanner *was* configured and did not answer, which is a different fact from a
clean file and from no scanner at all. The consequence is deliberate and is the point of the vocabulary:
**there is no code path that reports a file clean without a scanner saying so**, an infected object is
deleted from the store before the row records why (a row is not a reason to keep bytes), and the verdict
travels with the file — the author-facing route returns `scan_status` and refuses to serve an infected row at
all, so a reader who would otherwise not be told cannot be misled.

**And acceptance is a policy, not an accident of the environment.** The vocabulary above records what
happened to a file; it said nothing about whether an *unscanned* file may become an answer, and that was
decided by whether `CLAMD_HOST` happened to be set — which cannot be told apart from somebody forgetting to
set it. `ATTACHMENT_SCAN_POLICY` now names the stance. Its default, `allow_unscanned`, accepts a file whose
scan was `skipped` **or** `error`, because this product collects data where connectivity is a hope: a field
team whose scanner host is unreachable must not lose every upload, and refusing everything while a scanner is
down was the behaviour before — the failure mode the product exists to avoid. The two statuses are not merged
to buy that. The row keeps whichever it was, so the data still distinguishes "no scanner here" from "a
scanner that did not answer", and the capability block reports the policy (`unscanned: accepted | refused`)
beside `scan: on | off`, so the client states the stance instead of assuming it. `ATTACHMENT_SCAN_POLICY=require`
buys the other posture for a deployment that wants it, and with no scanner configured it refuses at
authorisation — before a URL is signed — rather than letting a respondent transfer a file that would only be
rejected at the end. What a deployment gives up by choosing acceptance is worth saying plainly: an unscanned
file is a file from the internet that nobody looked at, and the only things standing between it and a
researcher's disk are the per-question type allowlist and the size ceiling.

**Why the store's answer beats the client's.** The device declares a size and a type so that the URL can be
scoped to them, and neither declaration is believed. A row becomes `uploaded` only after a HEAD has reported
what actually arrived; a file over the ceiling, or of a type that was not signed, is deleted from the store
and the attempt recorded as refused. Submission adds the last check, because a row can exist while its bytes
do not: an answer naming an attachment the server has not accepted is refused with `attachment_not_ready`
rather than committed with a reference that leads nowhere.

**Honest limits.** The console has no screen that lists or downloads an attachment: the author route exists
(`GET /orgs/:orgId/attachments/:attachmentId`) and nothing in the browser calls it. The offline promise
covers answers, not attachments, so the control says it needs a connection rather than pretending to
queue a file, and that gap is named in `docs/ROADMAP.md` rather than glossed over. The studio's preview
receives no upload function, because there is no response for a file to belong to, and it says that
instead of offering a control that would fail on use. A deployment with no
bucket configured answers `501 storage_not_configured` and goes on saying that these questions are not
collected here, which is a supported state for an instance with nowhere to put a file — not a broken one.

**The continuation, and why the same reasoning produced a separate service for `.sav` and `.dta`.** Two
things were left when this decision was written, and both are now built.

The respondent's control exists, and it takes its limits from the server rather than from the bundle: the
public link read carries a capability block (`enabled`, `maxBytes`, the scan state, and the per-type MIME
allowlist) and `respondent.tsx` renders the input from it, so the browser cannot offer a file the API would
refuse and cannot be wrong about the ceiling when an operator changes it. The control renders in one place
and degrades in two — no bucket, and the studio's preview, where there is no response for a file to belong
to — because the alternative, a control that looks live and fails on use, is the same class of lie as a
`sent` for a mail that never left.

`.sav` and `.dta` are the same principle applied to a binary format, and the answer is a service rather than
a dependency here. This process cannot verify that the bytes it wrote are a valid SPSS or Stata file, and
**a `.sav` this process cannot verify must not be invented** — that was D9's whole point and it did not
change. What changed is where the writer lives: `pyreadstat` is Python, and writing it out in TypeScript
would mean hand-rolling two more binary formats this repository could not check either. So
`services/pyreadstat/` does that one job, the API sends it the engine's dataset as JSON, and the split is
deliberate in both directions — the worker never touches the database, and this process never assembles a
statistical file. A deployment without `PYREADSTAT_WORKER_URL` keeps D9's answer exactly, down to naming the
variable, and a worker that is unreachable or answers with zero bytes is a refusal rather than an empty
download. The presign route exists for the mirror-image reason: a file path with no server in it is what
keeps a video from becoming a video-sized response body, and it is why the same content type has to travel
inside the signature.

## D31 — The landing page carries the brand palette, on two materials (superseded in part by D34)

**Context.** The public page was built in the product's dark theme: near-black ground, pearl type, blue and
violet accents — the same palette as the console, applied to a marketing page. The brand palette is not
that. It is an orange primary on a white ground, with one near-black surface for the things that should
read as a different material.

**Decision.** The landing page is anchored on the brand values and is one page made of two materials. The
ground is `#ffffff` with ink type (`#111827`); the surface is `#191c21`, and it is what the stage and the
footer are made of; the primary is `#ea580c`; the accent is `#fdba74`. Type on the ground cannot be type on
the surface, and vice versa — those are four distinct roles rather than one palette with a tint applied —
and a border is a hairline of whichever material it is drawn on. The console was deliberately **not**
rethemed in this change: it is a dark room with glass in it, it is a working surface rather than a marketing
one, and a palette is not a reason to redesign the thing people do their job in. That last sentence was
wrong on the evidence and is reversed by **D34**, which found that the cost of leaving the workspace behind
was a person crossing from an orange page on white into a different product's blue.

**Why the primary is two tokens.** `#ea580c` as a glyph on `#ffffff` measures 3.6:1 — under the 4.5:1 that
text needs, and this was measured rather than assumed. So the primary is `--l-primary` wherever it is a
fill (a button, a dot, a hairline) and `--l-primary-text` (`#c2410c`, 5.18:1) wherever it is type. Two
consequences follow and both are deliberate: the primary action's label is the type colour rather than
white, because white on `#ea580c` is 3.6:1 and `#111827` on it is 4.98:1; and the hero's display gradient
stops at the brand value, because a 150px line is held to the 3:1 that large text is allowed rather than
the 4.5:1 a paragraph needs, which is exactly why that treatment belongs to the two headlines and nowhere
else. The peach accent appears only on the surface, where it is 10:1 — on white it is 1.9:1.

**Why the palette is now measured rather than reviewed.** A palette is the easiest thing in a codebase to
drift, because every individual nudge looks fine. `apps/web/test/contrast.test.ts` reads the tokens out of
the stylesheets, composites the translucent ones over the ground they sit on and asserts the WCAG AA ratio
for 25 pairs across the console's two themes and the landing page's two materials. It also asserts the
brand anchors by value, and that no blue, violet or cyan survives on the landing page as a token **or as a
literal** — a leftover `rgba(42, 91, 255, 0.42)` on a hover border is the realistic way a palette change
leaves a mess, and a test that only checks tokens would miss it.

**What the browser found that no stylesheet review would.** Measuring computed colour at five viewports
(320, 390, 768, 1280, 1440) turned up a defect that predates this change: `styles.css` styles
`h1, h2, h3, h4` globally with `color: var(--text)`, and the console's `--text` is `--ink` — near-black —
for anyone whose operating system is in light mode. Every headline on the landing page had therefore been
near-black on a near-black ground for half of all visitors, and the screenshots could not show it because
headless browsers ask for a light colour scheme while rendering a dark page for real. The landing page now
declares the colour of its own headings. The lesson is not "add a colour"; it is that a page assembled from
two stylesheets has to be measured as rendered, in a browser, at the widths people actually use.

## D32 — An email is a surface, the code never travels in the subject, and a verified domain is not an inbox

**Context.** Four messages leave this product: the sign-in code, the welcome a new member gets when an
invitation is redeemed, the notice that a sign-in finished, and the receipt a submission can send. All four
were a heading, a paragraph and a `<p>` around a value — the shape every project starts with, and the one
piece of this product that had never been designed at all. They are also the first thing most people ever
see from it, which is the worst possible place to look unfinished: nobody gives a second chance to a mail
that looks like spam, and the reader who has already decided that is not going to open the next one.

**Decision: one layout, four messages, five rules.** `apps/api/src/mail/templates.ts` builds them from a
single card. (1) **Nothing is fetched** — no image, no pixel, no web font, no linked stylesheet: an email
that loads a file from a server is a read receipt with a design, and a product that does not track its
readers does not get to track them because the medium made it convenient. Every mark is text or a border,
so the message is complete with images off, which is how most of them will be read. (2) **Tables and inline
styles**, because Outlook renders with Word's engine: the one `<style>` block that survives carries only
what inline styles cannot express — the dark palette and hiding the preheader — and a client that strips it
still gets the whole light design. (3) **The code is never in the subject.** A subject is drawn by the
operating system on a locked screen, quoted back inside every reply, and written into every mail log and
gateway on the way out; a one-time code in it is a code published to places the reader cannot see. (4) **The
palette is the product's own and the arithmetic is the same one**: `#ea580c` as a fill, `#c2410c` as type,
the ink label on the primary button, `#191c21` and `#fdba74` for the dark scheme — including the reason the
label is ink, because white on `#ea580c` is 3.6:1 (D31). (5) **The plain-text part is written, not
derived.** The clients that ask for `text/plain` are watches, terminals and screen readers; the HTML with
the tags stripped is unreadable in all three.

**A card, not a rule, for what the reader needs.** The OTP email gives the code the only treatment nothing
else gets — a monospaced block on the tinted panel, sized to be read off a phone held at arm's length while
typing it into a laptop — and its one button is deliberately the quiet outline rather than the primary
orange, because the code is the action and two competing calls to action is how a person clicks the wrong
one. It states the lifetime from `OTP_TTL_MINUTES` instead of a hardcoded ten minutes, so the sentence and
the server cannot disagree. The welcome answers the three questions a new member actually has (what this
is, what I can do, what my role means — the role sentences match the guards in `platform/orgs.ts`), and it
says out loud that accounts here are invitation-only, because a reader who does not know that will spend
their first afternoon looking for a sign-up page. The sign-in notice records the instant in UTC and the
address it came from, and its advice is about the inbox rather than a password, because an inbox is the
only credential this product has.

**Why escaping happens at the layout boundary, and the bug that proved it.** `layout` escapes the title,
the heading and the preheader itself; the rows are composed by builders that escape the values they are
handed. The first version escaped at the call sites instead, which is exactly the arrangement that fails
quietly: a template's preheader interpolated the organisation name raw, so an organisation called
`St Mary's <b>School</b>` put a live `<b>` inside the hidden div of a live email. No test we had would have
caught it — the escaping *looked* consistent — and `mail-templates.test.ts` now asserts the property rather
than the habit: a hostile address, organisation, role and submission id cannot carry a tag into any field
of any template.

**Why `MAIL_REPLY_TO` is its own variable.** `MAIL_FROM` is a claim about *sending*: the relay has verified
the domain and will accept the message. A reply target is a claim about *receiving*, and the two are not
the same address — a sender does not need an inbox, and this deployment's does not have one. So the reply
target is configuration rather than an assumption, and the welcome's invitation to reply is printed only
when it is set: with no mailbox named it offers an owner or an admin instead, because an instruction that
bounces is worse than no instruction, in that the reader believes they asked.

**What the browser found that the suite could not.** The string tests cannot see whether a media query applies,
and the first pass through a real layout engine found one that did not: the phone rule that steps the code down
to 30px targeted `.e-code-inner`, and the span it was written for had no class, so a rule that looked
considered did nothing at all. That is now `apps/api/src/mail/templates.ts`'s only class-selector-dependent
typographic rule, and it wears the class. The same pass measured what a string cannot: the dark ground really
is `#191c21`, the dark card separates from it, the label really is ink on `#ea580c`, the preheader is really
`display: none`, and nothing overflows a 390px phone (`39/39`).

**What the live relay answered.** Sending was verified against Resend rather than reasoned about: all four
templates left `inicio@unifies.codes` and arrived in a real mailbox with their links, both alternatives and
their palette intact — 4/4 reported `delivered` and 26/26 content checks passed. Sending *to* that address is
another story, and it is the one worth writing down: it bounced with `554 5.1.1 … User unknown`, because the
domain has three mail providers claiming it at the same priorities (Zoho, Namecheap and ImprovMX) and no
mailbox called `inicio` at any of them. The same lookup explains why mail still leaves correctly: Resend's
own records are `send.unifies.codes` (its SPF) and `resend._domainkey` (its DKIM), which is what makes the
domain verifiable for sending while the root MX stays ambiguous. Two consequences for whoever runs this
deployment: the root domain carries **three** `v=spf1` records, which by RFC 7208 is not a policy at all but
a permanent error, so they should be collapsed into one; and either a mailbox (or a catch-all) for
`inicio@unifies.codes` should exist — at which point `MAIL_REPLY_TO` can be set and the invitation to reply
comes back — or replies should be pointed at an address somebody reads. Production must carry the same
identity in its own environment: a workspace and a deployment have different environments, and mail identity
is not the one place to assume otherwise.

## D33 - A private deployment's public page does not name its source, and its copy carries no typographic dashes

**Context.** The landing page was written as the front page of a public repository. Every capability card
linked to the file that implemented it, the navigation offered `Source`, the footer carried the repository
URL beside the licence, and the honesty section ended with "Read the honest status document" pointing at
`docs/ROADMAP.md` on GitHub. The deployment is one organisation's private application, and its readers are
people who are about to type real school data into it. A link to a private repository is a dead end for a
visitor and a disclosure for everyone else: it names the location, the host and the owner of the source, on
the one page whose whole argument is that nothing is being hidden from you.

**Decision: a claim is proven inside the product or it is not made.** The evidence chip became a **Where to
check it** line, written as something a reader can actually do in two taps: write a relevance rule and watch
the preview hide the question, put a device in flight mode and answer anyway, sign in as two organisations
and try to reach the other one. That is the stronger half of the same promise, because it needs no
repository to be true and the person reading it can see it work. The status button opens this deployment's
own `GET /api/v1/public/summary`, which is the honest status the section was pointing at all along. The
footer names the host it is served from rather than the host the code is stored on.

**Why the rule is a test and not a review note.** A link added to a card or a status link pasted into a
footer reads as harmless in a diff, and the people who would notice it are the ones who already know the
repository's address. So `apps/web/test/landing.test.tsx` resolves every anchor the rendered page produces
and fails if any of them leaves the deployment's origin or names a source host, and it asserts the words
that give it away even without a link (`github`, `repository`, `open source`, `apache`). A browser pass over
the live page then checks the same thing against the served HTML, because the component and the document are
not the same artifact.

**No em dash, and no en dash, in anything a reader sees.** The dashes were worth removing for the reason
they were noticed: an em dash is the punctuation a generated paragraph reaches for, and a product whose copy
leans on it reads as written by something that does not care who reads it. The sweep covered everything that
renders, which is wider than the marketing page: the four emails, the studio's panel copy, the XLSForm
importer's twelve notes, the analyser's validation messages, the export's missing-code labels, the console's
placeholder for "no conflicts" (now `0`, which is the fact rather than a dash standing in for one) and the
shipped questionnaire's section titles. It is held by tests: the landing page's rendered text is asserted to
contain no `U+2014` or `U+2013`, and `mail-templates.test.ts` and the queue and studio suites assert the
strings they always did, which is what makes the change safe to make at all.

**The boundary is "what a browser can be served", and it is drawn tight.** The stylesheets' comments went
too, which reads as excessive until you watch a dev server inline a stylesheet into a document with its
comments intact: a comment in CSS is text a browser really is handed, and the check asserts the served
document rather than the rendered text. So `apps/web/index.html`, `apps/web/public/sw.js` and both
stylesheets are clean as well. The JavaScript and TypeScript comments did not go, and the difference is
measured rather than assumed: esbuild strips them, so the built bundle contains zero of either dash, and a
recursive scan of the whole build output finds neither dash and no source reference in any file it ships.
The markdown still carries 488 of them (`README.md` 181, `DECISIONS.md` 121, `CHANGELOG.md` 72,
`docs/ROADMAP.md` 58, `specs/PLATFORM.md` 26, `docs/MARKET-RESEARCH.md` 20, `specs/BUILD.md` 9,
`specs/AGENTS.md` 1) and the JavaScript comments hold 242 more. They are repository documents rather than
served ones, and rewriting that much prose would produce a diff large enough to hide a real change inside
it. If they should be clean as well, that is its own sweep and its own commit.

**And one measurement the string tests could not make.** The honesty list's bullet was a `12px` by `1px`
rule in `::before`, which is a hyphen drawn rather than typed and read as a list of corrections beside
statements that are proud of themselves. It is the brand's dot now (6px, radius 3px, `#ea580c`), the same
mark the wordmark wears. jsdom applies no stylesheet, so the only way to say that is a browser: the live
page was measured for the dot's computed box, for the six **Where to check it** labels, for a dash scan over
the served document rather than over the rendered text, and for a response log with nothing third-party in
it but the font (`12/12`).

## D34 — One palette for the whole product, and the dark material as a class

**Context.** D31 stopped at the landing page: the workspace kept the theme the brand replaced. That was
defensible while the two were read by different people and stopped being defensible the moment they were
not. A visitor reads an orange page on white, presses the one button on it, and arrives at a near-black
console with a blue primary and a violet highlight — the same product, two visual languages, and the second
one is the one they will spend their working day in. It is also the version with the defect that matters:
looking at both stylesheets side by side is when you notice that the workspace's own `--accent` (a link, a
focus ring, a live indicator) and the brand's primary were never the same colour, so "the primary action"
meant two different things in two places.

**Decision: one palette, two materials, chosen per region rather than per visitor.** The palette is declared
once at its brand values and both stylesheets read it. The dark material is `.surface`, a class that
re-binds every colour role for its subtree, and every screen is explicitly one of the two:

- **the surface** — the first paint (which is the moment before the workspace knows who is signed in), the
  sign-in sheet, the consent gate, the invitation, the policy documents, and the studio's source panel;
- **the paper** — the workspace, its tables and panels, the quality queue, the integration screens, the
  respondent's form, the studio's preview, and the landing page's reading sections.

**Why code is ink rather than paper.** The studio's source panel holds a JSON definition, and the material a
text is set in is part of what it says: code on a dark panel reads as code, the same text on the same white
as the prose around it reads as a paragraph. It is also the panel's own logic, since it is the region the
reader edits rather than the region they read. The preview beside it stays paper, deliberately: it is a
preview of the respondent's page, and a preview that does not match the page it previews is a lie with a
frame around it.

**Why a class rather than a second stylesheet or a media query.** Two reasons, one of which is a defect
this repository has already shipped. The first: re-binding tokens on a subtree means the material stays
correct as the subtree grows — a card, a field, a table row or a heading added inside a surface region
arrives in that material without anybody remembering to add a rule, and the roles cannot be half-applied.
The second: the earlier leak was `styles.css` styling `h1, h2, h3, h4` globally with `color: var(--text)`, which
put near-black headlines on a near-black ground for anyone whose operating system was in light mode. A
`.surface` region is exactly where that class of bug lives, so `contrast.test.ts` now asserts that the
material re-binds **every** colour role a rule in the file can read, and fails if one is added without an
answer. As for `prefers-color-scheme`: a product with two materials is not a product with two themes, and a
console that changed colour under a visitor nobody can see was one more state to get wrong.

**One subtlety worth writing down.** `.surface.surface` appears in the stylesheet and is not a typo. `.card`
and `.studio-panel` fill a pane that sits *on* a material, their rules come later in the file than this one,
and on an element that is both — the front door is a card, the source panel is a panel — the pane's fill won
the tie on source order and left the region a six per cent white film with the surface's white type on top of
it: white on white, invisible, and a browser was the only thing that caught it. Repeating the class wins the
tie by specificity instead of by position, so the rule keeps working wherever it sits and whatever component
is built out of it next.

**What the browser settled that the stylesheets could not.** Every route and every workspace view, at five
viewports (320, 390, 768, 1280, 1440), measured for the computed colour of each role, for anything sticking
out sideways, for the size and reachability of every control on screen, and for a clean console log: **502
checks, 0 failures**. Three defects existed only at 320px and none of them was visible in a diff — a code row
wider than the sheet that holds it, a `<select>` that cannot shrink below its longest option and so pushed
its row past the panel clipping it, and a builder row whose label was squeezed to 54px of single words. Two
more were skin deep and equally real: a navigation link 2px under the minimum target size, and metadata set
at 11.5px. And the pass found a genuine bug unrelated to colour, which is the argument for walking a product
rather than reading it: `test/offline/store.ts` passed a key to a store declared with a keyPath, so
**every offline draft write threw** and only the memory fallback — the one the unit tests use — worked.

**Honest limits.** The palette is measured to the 4.5:1 floor for text and 3:1 for boundaries, and the two
stylesheets are held to each other's values; what is *not* measured is whether the surfaces look good, which
is a judgement and not a test. Repository documents (this file, `README.md`, `CHANGELOG.md`, `specs/`) still
carry their em dashes by D33's reasoning, which is unchanged by this work.

**And the photographs were re-taken, because a stale one is the kind of claim this repository measures
rather than makes.** The README calls its first two tables photographs of the running product, and the front
door in them was the old one: `scripts/screenshots.mjs` was run against the deployment that carries this
change (`https://inicio.unifies.codes`), all five of its assertions passed, and the report it writes records
the URL and the time. The result is checkable in the images themselves: the desktop sign-in capture is warm
grey with 361,691 warm pixels against 906 cool ones, where the previous version of that screen was blue, and
the landing page's three captures carry no cool pixels at all.

## D35 — The artifacts a stylesheet cannot reach are generated, and then read

**Context.** D34 moved the palette into the two stylesheets and measured it there. A stylesheet is edited; a
PNG is not. So the artifacts that live outside CSS went on wearing the theme the brand replaced, and each
one was found the same way — by looking at the thing rather than at the repository: nine of the README's ten
drawings (navy grounds, a light blue accent, a violet second hue, cool blue-grey type), every badge on the
repository page, and the three app icons, which had been generated once before the palette existed and
measured **92 % blue-dominant pixels** after two palette changes. The icons are the worst of the three
because they are the most seen: they are the tab, the bookmarked app, and the home-screen tile on a
respondent's phone, where the product's first impression is a colour it stopped being.

**Decision: nothing that carries the brand is hand-edited if it can be generated, and nothing is trusted to
have been generated.** The icons are drawn by `scripts/make-icons.mjs` from the palette's own values —
`--surface`, white and `--primary`, on the tile the product's header already draws — and encoded with
`node:zlib` rather than an image library, so `pnpm icons` is reproducible on any machine and the diff of a
palette change is a diff of a script. The drawings are hand-made art and stay hand-made; they were rewritten
**by role** instead of by find-and-replace, which is the difference between preserving the relationships the
art depends on (ground darkest, panel lighter, two accents that remain two) and turning nine drawings into
five hues of orange.

**Then the artifacts are read, because a claim about a picture needs a picture.** The drawings are checked by
value (no colour from the palette this replaced, no saturated blue-violet accent) and, when the check was
written, were rasterised in Chromium and measured: **zero** saturated blue-violet pixels across all nine,
against 2.4 % to 17.1 % before. The icons are decoded pixel by pixel in the suite — which is why there is a
sixty-line PNG reader in `apps/web/test/png.ts` instead of a dependency — and required to be the palette's
ground, to carry the primary, to contain no blue-dominant pixel and none of the three colours the previous
icon was drawn from. A guard nobody has seen fail is a guard nobody knows works, so it was broken on purpose
once: one `#38bdf8` returned to `rule.svg` failed the suite naming the file and the colour.

**Honest limits.** The check draws a boundary, not a picture: it can say a drawing is not the old palette, it
cannot say it looks right, and the recolouring is a judgement made by a script and reviewed as a rendering.
The icons have the same limit — three values and a shape are asserted, not taste. And the threshold between
"a neutral the palette keeps" and "a cool accent" is stated in the test as the two sets that actually exist
(near-black grounds carry six to twelve units of chroma to the cool side, the accents this replaced carry
twenty-four or more, with saturation above 0.35), so a reviewer can disagree with the line rather than guess
at it.

## D36 — A workspace cannot migrate a database it has no credential for, and says so

**Context.** The published summary reported nine migrations where this workspace's production connection had
ten, which reads as "the deployment is one migration behind". Reading both sides showed something else: they
are different Postgres endpoints — `18.6 (c021049)` against `18.6 (653b019)`, compute start times two hours
and nineteen minutes apart, and migration `0010`'s four tables and four functions present on one side and
absent on the other. So the migration is applied where this repository's own API, console and harnesses run,
and the endpoint the deployment dials is the one still behind.

**Decision: state which database is behind, name the command, and do not invent a connection string.** The
deployment's credentials exist only in the hosting project's environment. A workspace has three wrong options
here — guess a host, write the migration into a startup path so the *runtime* role does DDL, or quietly
report "production is migrated" on the evidence of a different database — and one right one: measure both
sides, put the readings in the README's deployment section next to the command that closes the gap, and let
the person who holds the credential run it. A migration is not a code change, and a gap that cannot be closed
from here is a sentence to write down rather than a silence to keep.

**How it closed.** The credential existed in the one place it had to exist — the hosting project's own
environment — and that project's provider CLI reads it without a dashboard. The read named a Neon project
this workspace had no key for at all (`cold-leaf-32411407` at `ep-winter-frost-b3ke8cyz`, database
`neondb`, region `ap-southeast-1`; this workspace's is `proud-field-04065571` in `us-east-2`), and its
owner connection took `0010` while skipping the nine already in its ledger. Verification ran from both
ends rather than from the command's exit code: the deployment's own summary now reports the ledger
(`"migrationsApplied": 10`) *and* its compute start time, which is what identifies the database —
`2026-10-14T05:29:45.273Z` on both hosts against `03:10:46Z` for this workspace's; the database shows the
four tables with row level security enabled **and forced**, the four functions, and the `app_role` grants;
the six routes `0010` is what makes possible were asked live (each `401` signed out, `200` to a session
that exists only in that database); and the console itself was walked signed in on the deployment —
**92/92 checks** at 1440×900 and 320×568 across all four of a form's views, with the Quality queue and the
Integrations view opened by name and the four reads behind them answering `200`. That session was minted
the way the server mints one and revoked afterwards.

**What the decision still buys.** Nothing above was available from this workspace when D36 was written, and
the entry is kept in that shape on purpose: it records why "measure both sides and write down which one is
behind" was the right answer for as long as the credential was absent, and what changed when it arrived.
The rule stands — a workspace still does not guess a host, and the migration is still not run from a
startup path — and the gap it described is closed, so the README says so with the command that closed it
to hand instead of a warning to read.

## D37 — One database, and it is the deployment's

**Context.** Two Neon projects held the same schema. This workspace's `DATABASE_URL` named
`proud-field-04065571` (`us-east-2`, database `inicio`); the deployment answered from `cold-leaf-32411407`
(`ap-southeast-1`, database `neondb`). Both were migrated, both were real, and the only reason the
disagreement in D36 lasted as long as it did is that each looked complete from where it was being read.
D36 closed the gap by migrating the second one; this decides which one survives the pair.

**Decision: unify on the deployment's database, and move this repository's variables to it.** Three
reasons, in the order they decided it. The live accounts are there — one organisation, two active people,
none of it a fixture — so unifying on that side keeps production's data rather than copying it into a
second project and repointing the environment that production runs from, which is a larger change to the
thing that is live. It is in the region nearest the people using it, and this product's own landing page
advertises its database round trip, so `ap-southeast-1` against `us-east-2` is a figure on a page and not
an abstraction. And the hosting project's environment is managed by a provider integration that claims
`DATABASE_URL` for the owner connection, so leaving it alone means not fighting that integration on every
future deploy — the repository's variables are ours to set, that environment is not.

**What had to be true first.** Unification is only safe if it loses nothing, so both sides were counted
before anything moved: one account and one organisation on the workspace's side against two accounts and
one organisation on the deployment's, and **zero responses on both** — the same near-empty development
state, which is why this was a decision about plumbing rather than about a migration of records. Every
account on the retired side also exists on the surviving one; the one thing that exists nowhere else is an
organisation called `Unifies` with a single empty form, and the retired project is left in place, read-only,
holding it. Nothing was deleted, and nothing will write there again — a project that is an archive is
cheaper than a project that is a surprise.

**What it costs, stated plainly.** A workspace wired to production points the API suite at production, and
`apps/api/test/setup.ts` refuses to run against a host that is not this machine — which was already true of
this workspace and is exactly why the unification is safe rather than reckless: the guard turns "I ran the
tests" into "I ran the tests somewhere they could not touch the live database". Rotating `app_role`'s
password is now a production act; `pnpm db:migrate` at the workspace root is now a production act; both are
supposed to feel like that. And the retired project still exists, so the two databases are one only for as
long as somebody remembers which one is which — which is why the README names it, names the region, names
the retired project, and says what it holds.

**Verified.** `pnpm db:migrate` against the unified connection skipped all ten migrations rather than
applying any: the workspace is now migrating the same database the deployment answers from, and the
ledger it reports (`"migrationsApplied": 10`) is the one both live hosts publish about themselves.

## D38 — The drift alert is a schedule, and "unreadable" is not "drift"

**Context.** D36's gap was not a broken build or a failed request. The application was deployed and
reachable the whole time, its health check answered, its landing page answered, and its older screens
worked — because the tables only a *new* screen reads simply were not there. Everything green, and a
screen that could not load. No push-triggered CI can see that: `ci.yml` proves the code and its migrations
agree *with each other*, against a database the job creates itself.

**Decision: ask the deployment about its own schema, on a clock, and treat the three answers differently.**
`scripts/check-drift.mjs` (`pnpm drift`) reads `GET /api/v1/public/summary` and compares the ledger the
running service reports with the migration files in the checkout. `.github/workflows/drift.yml` runs it
every six hours and, on a disagreement, opens or appends to **one** issue carrying the report and the
command that closes it.

The source is the deployment's own public summary rather than the database, and that is deliberate: CI has
no business holding production database credentials, the endpoint is public by design and reports nothing
about tenants, and it is the strongest available evidence — the number is read by the same process, on the
same connection, that serves the routes. The exit codes are the design rather than an implementation
detail: `0` in step, `1` drift, `2` unreadable. A deployment nobody can reach is an outage, not a schema
problem, and an alert that files it as drift is an alert people learn to scroll past — so `2` fails the run
and opens nothing. One issue, commented on rather than duplicated, for the same reason: an alert that
leaves a trail of issues is an alert nobody reads twice.

**Verified in all three states, because a check that has only ever passed is a check nobody has seen
work:** in step against the live deployment; drift by adding a real `0011_*.sql` to the checkout's
migrations for the length of one run, which named the missing file; and unreadable with `DRIFT_URL` pointed
at a closed port, which exited `2` without claiming anything about the schema.

## D39 — One pointer treatment, mounted by the shell

**Context.** The product had two. The landing page drew a trail of twenty springs from an on-demand module
(`landing-cursor.ts`); the signed-in app drew a labelled ring around the pointer from `ImmersiveChrome`.
Both followed the same pointer, with different ideas of what hovering means, and the landing page's own
comment already recorded the direction of travel — "the label the ring used to render is gone with the
ring" — while the ring was still being rendered on every other route.

**Decision: the trail is the product's one pointer mark, and the shell mounts it, once, for every route.**
The ring and its stylesheet rules are gone. The canvas rule moved from `landing.css` into `styles.css`,
because a canvas styled by a stylesheet that only one route loads is an unstyled box in the flow of every
other route; the module was renamed from `landing-cursor.ts` to `cursor-trail.ts` because the old name had
stopped being true, which is the same reason the class is `cursor-trail` and no longer `lcursor`.

**Why the shell rather than each page.** A layer that appears and disappears with navigation reads as a
glitch, and — the actual failure here — a per-page mount is a per-page chance to forget one. It was
mounted by exactly one page because that was the page it was written on, and nothing about the routing
would have told anybody. So the mount lives where the routing does, and the test counts:
`cursor-trail-everywhere.test.tsx` mounts the app at each route the router resolves and requires **exactly one** trail,
mounted exactly once per route even under StrictMode's double mount, disposed by reference when the route
goes. The decoration's other three properties are held elsewhere: it stays off the critical path
(`check-budgets.mjs` fails if a critical chunk contains `quadraticCurveTo` or `hsla(`, and the
chunk has its own 4 kB budget), it stays hidden under reduced motion (both the script and the stylesheet,
asserted in `shell.test.ts`), and it takes no pointer events, so every control underneath still gets its
click.

**Where the lazy gate lives is part of the decision, not an implementation detail.** The first revision
asked the question inside the chunk — `mountCursorTrail` returns a no-op handle when there is no fine
pointer or motion is reduced — which is correct about what is *drawn* and wrong about what is *paid*: the
`import()` is what costs, and it ran on every device that rendered the canvas. A finger therefore
downloaded and evaluated twenty springs of physics to be told there is no trail. The question is now asked
twice: `shouldDrawCursorTrail` inside the chunk, as the authority for what may be drawn, and
`wantsCursorTrail` in `App.tsx` ahead of the fetch, which is the only copy that can save the request.
Importing the predicate instead of repeating it would put the chunk on the critical path — the exact thing
the split exists to prevent — so the two are held together by direction rather than by the compiler: the
second can only ever be *more* conservative than the first in the sense that matters, and if it is not, the
cost is a fetch nobody used, because the module still refuses to draw. `cursor-trail-lazy.test.tsx` is what
makes that a measurement: it counts the mocked module's evaluation and requires none on a coarse pointer,
under reduced motion, or with no `matchMedia`, and one where a mouse is present.

## D40 — A copy of a device's answers is a file, and the three ways a send can fail are three failures

**Context.** Everything in `apps/web/src/offline` protects answers from the *network*: the draft is
written to IndexedDB before anything is sent, a save supersedes the save before it, the queue retries with
backoff, and a disagreement about a value is kept twice rather than resolved away. None of that survives
the protection failing for a reason that is not the network. Clearing a browser's storage, reinstalling the
PWA, moving to a replacement phone and a tablet reclaiming its own disk all take the draft with them, and
any answer that had not reached the server is gone with no second copy anywhere. In the field this is the
second most expensive failure in the category, after a delete-after-send default: the device is the only
copy, and nothing in the product could produce a second one.

The other half is that the page could describe its state only as one sentence. "Your answers are saved on
this device" does not answer the question somebody actually has after twenty minutes of failed sending,
which is *how many times has it tried, what did it say, and when will it try again* — so the queue was
durable and invisible at the same time. And a file whose upload was cut off had one treatment for two
completely different events: the bytes never arriving was reported with the same words as the server
refusing them, and the only recovery offered was to pick the file again.

**Decision: the device's own state is a structure, its copy is a file, and the three failures stay three.**

`deviceState(draft, { online, syncing, now })` returns what the device knows about its own queue — phase,
whether the server holds everything, what is waiting, the attempt count, the last failure and the instant
the next try is due — computed from the draft rather than remembered in state, because the draft is the
one thing the next flush will read. `retryText()` turns the last of those into a time, and nothing else
claims a schedule: a wait that is already over has no instant to name, because the next attempt happens on
the next trigger. The page renders both beside the connection pill.

`offline/backup.ts` builds the copy, validates it and restores it, with no DOM in the module so the rules
are tested as rules rather than through a screen. The file carries a format marker, a version, the link's
token, the survey and version it came from, and the whole draft with its queue intact. Three refusals are
decided here rather than at a call site: a file that is not ours, a file written by a **newer** app (read
halfway is worse than not read, because the draft it produces looks valid), and a copy that is **older**
than the answers already on the device, which is the one case where restoring would destroy work instead of
recovering it. Restoring a copy onto a *different* link is refused by name, because a response full of
questions the form does not ask is a submission the server can only reject, with nothing the person holding
the phone could have done about it. A restored draft keeps its `clientId` and `responseId`, so the queue
resumes the response it had already created rather than making a second one — the same idempotency the
retry path depends on, reused for the case where the device is new.

`attachmentOutcome(err)` splits a file's failure by whether the server answered at all. A status is a
verdict, and re-sending it unchanged would fail identically, so it is not remembered. No status means the
bytes never arrived, which is a fact about the connection, so the `File` is kept in memory — the one thing
about a picked file that cannot be reconstructed from the draft — and the retry pass sends it, one at a
time, when the connection returns, stopping at the first failure because a connection that has just failed
twice has no bandwidth to spare. The answer is written only after the server has accepted the file: a
reference to something nobody verified must never become an answer.

`storageHealth(estimate)` is the fourth piece, and it is deliberately a warning rather than a gate.
`navigator.storage.estimate()` is the only way to learn what room is left, and enough browsers do not answer
that "unknown" is a real verdict rather than a zero — a browser reporting a quota of `0` must not become a
reported fraction of infinity. At 80 % the page says so at the top of the form, before it costs anything;
at 95 % it says what is at risk; under both it keeps collecting, because a full disk is a reason to tell
somebody, never a reason to refuse the answer in front of them.

**What holds it.** `offline.test.ts` covers the queue's shape, the storage verdicts (including the two
refusals to divide by a quantity nobody gave), the file-versus-network distinction, and the copy's three
refusals, then proves the recovery end to end: a copy taken from a store with an unsent submission restores
into an **empty** store, and the submission then goes out once, on the original response id.
`collect-offline.test.tsx` mounts the real collection page over a stubbed wire — the real client, queue and
renderer, with only `fetch` replaced — and holds the three claims a unit test cannot: an upload interrupted
by the network is held, retried by itself after a reconnect and recorded only once the server accepts it; a
refusal is not retried at all; and a full device is told before it costs anything. It also closes the page
and opens it again, and requires the answers back from the device rather than from the server.

**What this does not prove.** The download a real browser writes and the estimate a real browser reports
are not measured here: the deployment has no collection link to walk, and creating one means writing a
throwaway organisation into the production database and real bytes into its bucket. Both are stated as
unmeasured in the changelog rather than assumed, which is the same standard the roadmap holds the frame
rate of two canvases to.
