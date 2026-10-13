# Platform roadmap and verified status

Where the product is, what has been proven, what is explicitly not done, and what the free
infrastructure underneath really allows.

Legend: **built+verified** · **built, partially verified** · **not built**

---

## 0. Access control and legal standing (added after the first review)

- **Invite only.** `INVITE_ONLY=true` by default. Unknown addresses get a uniform
  `not_invited`, and no account is created. The first owner comes from
  `bootstrap:owner`, never from a public endpoint.
- **Single use invitation links** issued by an owner or admin only: 32 random
  bytes, hash at rest, bound to one address, one role, 1 to 30 day expiry, one
  atomic redemption. Members and viewers cannot invite, list invitations, or read
  the mail diagnostics; verified over HTTP, not only in the UI.
- **Preview then confirm.** Opening the emailed link does not spend it; joining is
  a POST. Mail scanners fetch links before people do.
- **Terms and privacy gate.** Versioned documents whose hash is computed from the
  text the API serves. Acceptance is an append-only event with both versions,
  both hashes, the checkbox wording, IP and user agent. Everything except `/me`
  and the acceptance route answers 403 until it is accepted.
- **Operational detail is admin-only.** The public mail status says whether codes
  can be sent, not which relay refused or why.

## 1. Verified now (253 automated tests, plus end-to-end over HTTP)

| Area | State | Evidence |
|---|---|---|
| Multi-tenant schema + RLS | built+verified | `0003_platform.sql`; `apps/api/test/platform-rls.test.sql` runs as the non-superuser `app_role`: a non-member reads **0 rows** across all 14 tenant tables *even when forging `app.org_id`*; forged INSERT is refused by `WITH CHECK`; UPDATE/DELETE match 0 rows |
| Platform identity (open signup, OTP, sessions) | built+verified | `0004_platform_auth.sql`, `platform/auth.ts`; tests sign up an unknown email, reject a wrong code, and refuse a `school:` session on platform routes |
| Organisations, roles, roster | built+verified | `platform/orgs.ts`; tests cover owner-by-creation, invite by email (SECURITY DEFINER, because a non-teammate is invisible under `app_user`'s own policy), viewer cannot edit, last-owner removal refused |
| Authoring + publishing | built+verified | `platform/forms.ts`; a definition that references an unknown question **is saved** (a half-built form is normal) but **cannot be published** (422) |
| Versioning | built+verified | one draft per form, one published per form; published versions immutable (409); restore creates a *new* version |
| XLSForm adapter | built+verified | `packages/engine/src/adapters/xlsform.*`; hand-written XLSX reader/writer; round-trip is a **fixpoint** test; unknown types/columns/ODK metadata are preserved or reported, never dropped silently |
| Logic engine | built+verified | visibility, branching, validation, calculation, cascading selects; blank≠zero; hidden ⇒ null |
| Export bundle | built+verified | data + codebook + value labels + missing table + metadata as CSV (zip), XLSX (5 sheets), JSON; multi-select dichotomous or slots; injection-safe view |
| Distribution + collection | built+verified | anonymous / single-use / multiple / panel links; token shown once; partial save and resume; required + constraint enforcement **server-side**; `.sav`/`.dta` refused with 501 |
| Templates | built+verified | the school ranking survey publishes, round-trips through a spreadsheet and collects a real response with a server-computed score |
| Web app | built+verified (API-level) | login, organisations, forms, and a **three-panel studio** — the JSON definition, the XLSForm sheets the download writes, and the respondent's form as a live preview, all three from one parsed definition, with the analyser running per keystroke — live counts pushed over the change stream, export buttons, copy-once link, a collection renderer that shares the engine with the server, an integration screen (API keys with the scope catalogue read from the server, webhook endpoints with delivery history, a real "send test" round trip and a retry) a per-form **Quality** tab whose evidence rendering and decision-carrying write are asserted in jsdom; and a `Flag` action on a response row that requires a reason and reports "already in the queue, so nothing new was written" differently from "recorded", because a dropped finding reported as a recorded one is the same class of lie as a `sent` that never left the building; the integration screen's own promises are asserted too — the `enforced` flag genuinely disables a scope no route declares, a secret is shown once in a read-only field, `http://` cannot be submitted at all, and "send test" reports the receiver's real `500` |
| Push channel for the console | built+verified | `apps/api/src/platform/events.ts`; one server-sent event stream per form, behind the session cookie and the terms gate, reading the per-aggregate revision vector inside the tenant transaction. An unchanged revision writes **no event at all**, which is what makes the poll removable; a write produces exactly one `change` naming the aggregate that moved. `apps/api/test/realtime.test.ts` opens a real stream over a real socket: `ready` first, silence across three ticks, then one coalesced event after a real collection write, and **404 with no stream** for a form the caller cannot see. `apps/web/src/realtime.ts` coalesces a burst into one notification and gives up to `offline` after repeated failures, both asserted in jsdom. `console-live.test.tsx` proves the console's own live read: a push naming its aggregate refetches the screen, a push naming another one does not, two pushes inside a frame cost one read, and **a minute of clock passes while the stream is live without a single timed request** |
| API keys and scopes | built+verified | The machine surface is the **read** API plus the quality queue: `forms:read`, `responses:read`, `analytics:read`, `responses:export` and `flags:read`/`flags:write`, each declared by the routes it names, with every write and every console route session-only. `0001`'s `api_key` stub **extended** in `0010` rather than duplicated, because two tables called "api key" is how a schema ends up with two answers to "who may act as this tenant". Bound to its creator, so a key inherits the membership boundary the database already enforces and dies with that membership; secret shown once, stored as `sha256(secret)`. `requireActor` is deny-by-default and the tests hold the whole shape: a key with `flags:read` reaches the queue and one without it is `403 insufficient_scope` **naming the missing scope**; a key on a scope-less route is `403 key_not_permitted` while a route written before keys existed is `401`; a key for org A is `403 key_org_mismatch` on org B's path *even though its creator is a member of both*; revocation stops the next request and a second revoke is `404`; an expired key is `401` without being revoked; a member can read keys but not mint or revoke one; `GET /api-scopes` marks which scopes a route declares and the suite asserts that mark is true rather than decorative; a key granted `forms:read` reaches `GET /forms` and sees **only its own organisation's forms** (narrowed in SQL) while the same key is `403 key_org_mismatch` on another organisation's form; and reading responses does not imply downloading them, because `responses:export` is its own scope |
| Webhooks | built+verified | `webhook` and `webhook_delivery` (also `0001` stubs) extended in `0010`; a delivery is written **in the same transaction as the event it describes**, which is what makes an event exactly-once with the data. HTTPS is a database constraint, not a route's opinion. `webhooks.test.ts` replaces `fetch` for the file and asserts the rest against real PostgreSQL: publishing enqueues exactly one `form.published` per subscribed endpoint and none for a bystander; a real respondent submission over a public link enqueues `response.submitted` with the device id; the signature is verified against an **independent HMAC in the test**, with a counter-assertion that a signature over the body alone does *not* match (that is what the timestamp prevents); an unreachable receiver records `error` with no status and a 500 records the status, both scheduling a future retry; five attempts end `failed` and the queue stops picking it up; the test button reports the receiver's real status including `404`; a member reads endpoints and history but cannot patch or delete one |
| Quality flags and a queue | built+verified | `response_flag` with a small explicit vocabulary (`speeding`, `straight_lining`, `duplicate`, `manual`) and a **queue** rather than a score: the decision, the person and the note are recorded, and dismissing is a distinct outcome from resolving. Speeding and straight-lining are decided in the respondent's own transaction; duplicates need the whole form and are an organiser's idempotent `POST …/flags/scan`. `flags.test.ts` holds the boundaries rather than the middle: 5 s is `severe` with the threshold stated, 15 s is `warn`, ten minutes raises **nothing**; 4/4 identical fires and 3/4 — exactly 75 % — does not; three identical answers do not fire because the minimum is four; a second scan reports `flagged: 0` because a unique index refuses the repeat; a missing note is `400`; a foreign organisation's queue is `404` rather than empty; and the scope boundary is exercised both ways |
| Public summary | built+verified | `apps/api/src/platform/public.ts`, the one unauthenticated route: server version and uptime, the round trip of the query that produced the response, the migration ledger, and the template library summarised by walking the real definitions. `public-summary.test.ts` asserts the response is read live (the figure changes between two calls, the database clock is within a minute of now), that the engine facts equal the sum over the templates rather than a declared list, and the **exact key set**, so no form, response or organisation can appear on it by accident |
| One visual system across the product | built+verified (component-level) | one stylesheet defines the palette (pearl and ink, blue `#2a5bff`, violet `#7b4dff`, cyan for live only), the spacing scale and one glass pane reused by the console, collection, administration and the legal surfaces; the light theme is a token block rather than a second stylesheet. The signed-in shell carries a fixed application bar, chapter headings, tabular metric figures and an ambient light field (`apps/web/src/immersive/ambient.ts`) that draws the landing sculpture's own node-and-filament structure on a 2D canvas at no dependency cost, stops when the tab is hidden, and is absent-without-breaking under `prefers-reduced-motion` or with no canvas. `ambient.test.ts` asserts with a recording context that a frame is painted, that scrolling rearranges the structure, that an inactive field stops drawing and that a disposed one touches nothing. The field also caused the one defect in this table that a stylesheet-level test was needed for: its host element and a form's question block were both called `.field`, so every question on a collection page was `position: fixed; inset: 0; z-index: -1; pointer-events: none` — invisible, unclickable, and invisible to every jsdom test because jsdom applies no stylesheet. The host is `.ambient` now and `shell.test.ts` asserts the properties rather than the names. **Not measured:** the light theme and the field have not been seen rendered on real hardware |
| Immersive public page | built+verified (component-level) | `apps/web/src/landing.tsx`, `apps/web/src/immersive/instrument.ts`; every figure is read in that request, the WebGL scene is a separate dynamically imported chunk, `aria-hidden`, and stops when the tab is hidden or the stage is off screen. `landing.test.tsx` mounts it in jsdom: the figures come from the API, the page is complete and readable when the scene returns nothing (the WebGL-unavailable path), and it prints no figure at all rather than an old one when the API does not answer. **Not measured:** frame rate and GPU cost on real hardware |
| Offline collection | built+verified | `apps/web/src/offline`; the published definition is cached and every answer is written to IndexedDB before anything is sent; a durable one-deep queue syncs on change, on blur, on tab hide, on reconnect and on a 2-minute timer; the device owns a stable response UUID so a retried start is idempotent; `collect-sync.test.ts` proves two-device merges keep the losing value in `response_answer.device_value` and record it in `response_conflict`; `.run/e2e-offline.mjs` runs 24 checks over a real database through the preview origin |
| CI on every push | built (not yet executed by a runner) | `.github/workflows/ci.yml`: `verify` installs from the lockfile and runs lint, typecheck, the whole suite against a PostgreSQL 16 service, the build and `pnpm budgets`; `harnesses` migrates a database, bootstraps an owner, starts the API and the web server, waits for both, and runs the 33-check consumer and 28-check offline harnesses over the browser's own origin. Its first typecheck run caught a `TS7022` in a test file that the working tree's own build never compiles, which is the case for having this in one command rather than in a habit. **Not verified:** GitHub has not run it yet — the workflow is committed, and a runner is the only thing that can prove the two serverless-shaped jobs actually start |
| The definition studio | built+verified (component-level) | `apps/web/src/studio.tsx`, loaded as its own 5.5 kB chunk. Three panels over one parsed definition: the JSON the API stores, the XLSForm sheets that `Download .xlsx` writes, and the form a respondent opens. `studio.test.tsx` holds the coupling rather than the layout — editing the JSON repaints both other panels **with no request at all** (all three read one object, asserted by asserting the request log is reads only), the sheet panel's rows are `xlsFormSheets`' rows and the tab count is the sheet's own row count, the preview hides a question whose relevance rule says so and renders the two inline choices, the submit button is present and `disabled`, typing in it sends and stores nothing, an analyser finding appears before anything is saved, half-typed JSON leaves three panels standing with a sentence saying what it is, and the preview's `.field` markup is **character-for-character identical** to the same component mounted the way the collection page mounts it. `xlsform.test.ts` proves the sheet viewer and the file cannot drift: `readWorkbook(exportXlsForm(def).bytes).sheets` equals `xlsFormSheets(def).sheets`, trailing blank cells aside (a spreadsheet cannot store one). **Not measured:** the three-panel layout on real hardware at each breakpoint |
| The API contract | built+verified | `specs/openapi.yaml` enumerates every mounted path — `/health`, the Phase-1 `/auth` block marked `deprecated`, and the whole `/api/v1` surface — with the credentials, the scope table and the stable error vocabulary. It replaced a revision that documented a questionnaire/`admin` surface no longer mounted anywhere. It is now **held to the code rather than to a memory of the code**: `apps/api/test/openapi.test.ts` parses the file, extracts the routes out of the source with the prefixes `app.ts`/`platform/index.ts` actually mount, and compares them both ways — a route added without its entry fails, and so does an entry kept after its route is gone (it caught two: the invitation routes were documented at `/api/v1/invite/...` when they are mounted at `/api/v1/auth/invite/...`). The same test pins the machine surface to the eleven operations a key may call, requires the scope each needs to be *named in its description*, asserts the unauthenticated surface as an explicit list rather than a count, and checks that no scope-shaped token appears that `API_SCOPES` does not define |
| Bundle budgets | built+verified | `scripts/check-budgets.mjs` (`pnpm budgets`) measures the gzipped build: 80 kB of JavaScript and 7 kB of CSS on the critical path, 8 kB and 6 kB for the landing chunk, 150 kB for any chunk, and it *asserts the split* rather than trusting it — a critical chunk containing `WebGLRenderer` or `createInstrument` fails the build, which is what a static import of the scene would do. This build: 73.4 kB JS and 4.9 kB CSS critical, 5.4 kB landing, 5.5 kB studio, 132.6 kB renderer |
| Contrast and accessibility rules | built+verified | `contrast.test.ts` measures 23 pairs taken from the stylesheets themselves (aliases followed across the file, translucent colours composited over the ground they sit on): text at 4.5:1, control boundaries and the live dot at 3:1, in both themes and the landing palette. `a11y.test.tsx` mounts the landing page and the terms gate in jsdom and runs `axe-core`, with `color-contrast` disabled for a stated reason and covered by the measurement instead. Two real defects came out of it: interactive boundaries at ~1.6:1 (`--line` at 13 %, now `--line-control` at 50 %) and the light theme's live colour under 4.5:1. **Not verified:** a full WCAG 2.2 AA audit; this is a rule engine and a palette measurement, not a person with a screen reader |
| Installable PWA | built+verified | `apps/web/public/{sw.js,manifest.webmanifest,icon-*.png}`; the worker precaches the shell and its hashed assets and **never** intercepts `/api`, `/auth` or `/health`, so no cached body can be served as live data; `service-worker.test.ts` executes the worker in a VM and asserts both; registration is production-only so it cannot shadow hot module replacement |

## 2. Not built (and deliberately not faked)

| Area | State | What it needs |
|---|---|---|
| `.sav` / `.dta` export | not built | a Python `pyreadstat` worker (Cloud Run free tier); until then the API returns **501 with a reason** rather than the label-syntax-only "SPSS export" that some tools ship |
| File uploads (image/audio/video) | not built | object storage (R2/S3) with presigned URLs and a virus-scan step; the renderer marks those inputs as not yet collected rather than silently skipping them |
| AI authoring / grounded analysis | not built | Workers AI or an LLM API; the **guardrails** are already specified (draft-only, analyser-validated, evidence-linked) in `specs/PLATFORM.md` §7 |
| SSO/SAML/passkeys, SCIM, backups | not built | hardening phase. (Automated accessibility rules and measured colour contrast landed in §1; a WCAG 2.2 AA audit — a person, a screen reader, a keyboard-only pass over every signed-in screen — has not) |
| Realtime fan-out across instances | not built | the push channel re-reads the revision vector once per tick (1.5 s) per open stream, which is correct and is one round trip inside the tenant transaction, but it is per-instance work. A broker (Valkey or `pg-boss`) is the upgrade that makes fan-out free across several instances. It is deliberately not `postgres_changes`: the API runs as a serverless function, where a `LISTEN` connection does not survive between invocations, so a `NOTIFY` fired by one instance would reach nobody |
| Redis-backed rate limiting / queue | not built | in-process limiter only; fine for one instance, not for several |

## 3. Honest infrastructure ceiling (free tiers, as of 2026)

The product's own limits are generous and unmetered on purpose: **we do not cap responses.** The
constraint is the free tier underneath us, and pretending otherwise would be a lie of omission.

| Layer | Service | Free allowance | Breaks first |
|---|---|---|---|
| Postgres + RLS | Supabase | 500 MB DB, 500 MB RAM, 5 GB egress, 2 projects, **pauses after 7 days idle**, **no backups** | DB size, then the idle pause |
| Object storage | Cloudflare R2 | 10 GB, 1M Class A / 10M Class B ops | storage, then reads |
| API | Cloudflare Workers | 100,000 requests/day, 10 ms CPU/invocation | CPU on heavy report queries |
| Realtime | Supabase Realtime | 200 concurrent connections, 2M messages/month | connection count |
| Queue | `pg-boss` on our Postgres | free (no extra service) | DB I/O |
| AI | Cloudflare Workers AI | 10,000 Neurons/day | the daily budget |
| Email | Resend | 3,000/month, **100/day**, verified domain required | the 100/day cap during an OTP burst |
| `.sav`/`.dta` worker | Google Cloud Run | 2M requests, 180k vCPU-s/month | cold start latency |
| SPA | Cloudflare Pages | free | Vercel Hobby is **non-commercial use only** — do not ship there |

Three consequences we state rather than hide:

1. **"Free and uncapped" describes our product, not the hosting.** A viral survey will hit a
   provider ceiling. We therefore show live usage against each ceiling and keep the stack
   portable — one `DATABASE_URL` moves Postgres to a paid host with no code change.
2. **No backups on a free Supabase project.** Anything a real customer collects needs either a
   paid plan or a scheduled `pg_dump` to object storage. This is a phase-9 task and it is
   currently *not* done.
3. **Abuse controls are the cost of "free".** Open signup plus unmetered responses is an
   attractive spam target. Today: email-verified signup, per-email OTP cooldown, a per-IP rate
   limit, per-org fair-use visibility. Not yet: CAPTCHA, disposable-domain screening, and a
   budget alarm per organisation.

## 4. Next, in order

1. **Object storage + uploads** — R2 with presigned URLs, size/type limits, scan status already
   modelled in `response_attachment`. Unblocks the honest `image`/`file` question types.
2. **The `.sav`/`.dta` worker** — unblocks SPSS/Stata exports and the missing-code numeric
   mapping already documented in the codebook.
3. **AI authoring + grounded analysis** — draft-only generation, validated by the same analyser;
   analysis must render the response ids it was derived from.
4. **A broker for realtime fan-out** — the push channel works on one instance (see §2); a Valkey or
   `pg-boss` hop is what makes it cheap on several.
5. **Hardening** — passkeys/SSO, SCIM, per-org budgets, backups/restore drills, WCAG 2.2 AA.

Done since this list was written: **API keys with scopes, and webhooks** and **quality flags and a flag
queue** (both moved to §1), **offline collection + the installable PWA** (moved to §1), the
sync conflicts it produces are surfaced in the Responses tab, the console's 5 s poll is replaced by
the push channel in §1, the landing page and the realtime client now have component tests, and the two
items that guard everything after them — **CI on every push** and the **accessibility and performance
budgets it enforces** — are in §1. What is left of this list needs infrastructure rather than code:
object storage credentials, a Python worker host, and a broker.

## 5. What a reviewer should check first

- `pnpm test` — 253 tests; the RLS suites are the ones that matter most. `pnpm budgets` after `pnpm build`
  shows what the browser is asked to download, and `.github/workflows/ci.yml` is the same two in order.
- `apps/api/test/platform-api.test.ts` — the whole product over HTTP as two accounts, including
  cross-tenant 404/403 behaviour and a full collection lifecycle.
- `packages/engine/test/xlsform.test.ts` — the fixpoint round-trip and what the importer reports.
- `packages/engine/test/export.test.ts` — 0 vs blank, five kinds of missing, CSV injection.
