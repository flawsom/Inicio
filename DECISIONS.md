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
