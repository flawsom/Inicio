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

## 1. Verified now (162 automated tests, plus end-to-end over HTTP)

| Area | State | Evidence |
|---|---|---|
| Multi-tenant schema + RLS | built+verified | `0003_platform.sql`; `apps/api/test/platform-rls.test.sql` runs as the non-superuser `app_role`: a non-member reads **0 rows** across all 9 tenant tables *even when forging `app.org_id`*; forged INSERT is refused by `WITH CHECK`; UPDATE/DELETE match 0 rows |
| Platform identity (open signup, OTP, sessions) | built+verified | `0004_platform_auth.sql`, `platform/auth.ts`; tests sign up an unknown email, reject a wrong code, and refuse a `school:` session on platform routes |
| Organisations, roles, roster | built+verified | `platform/orgs.ts`; tests cover owner-by-creation, invite by email (SECURITY DEFINER, because a non-teammate is invisible under `app_user`'s own policy), viewer cannot edit, last-owner removal refused |
| Authoring + publishing | built+verified | `platform/forms.ts`; a definition that references an unknown question **is saved** (a half-built form is normal) but **cannot be published** (422) |
| Versioning | built+verified | one draft per form, one published per form; published versions immutable (409); restore creates a *new* version |
| XLSForm adapter | built+verified | `packages/engine/src/adapters/xlsform.*`; hand-written XLSX reader/writer; round-trip is a **fixpoint** test; unknown types/columns/ODK metadata are preserved or reported, never dropped silently |
| Logic engine | built+verified | visibility, branching, validation, calculation, cascading selects; blank≠zero; hidden ⇒ null |
| Export bundle | built+verified | data + codebook + value labels + missing table + metadata as CSV (zip), XLSX (5 sheets), JSON; multi-select dichotomous or slots; injection-safe view |
| Distribution + collection | built+verified | anonymous / single-use / multiple / panel links; token shown once; partial save and resume; required + constraint enforcement **server-side**; `.sav`/`.dta` refused with 501 |
| Templates | built+verified | the school ranking survey publishes, round-trips through a spreadsheet and collects a real response with a server-computed score |
| Web app | built+verified (API-level) | login, organisations, forms, JSON builder with live analyser feedback, live counts pushed over the change stream, export buttons, copy-once link, and a collection renderer that shares the engine with the server |
| Push channel for the console | built+verified | `apps/api/src/platform/events.ts`; one server-sent event stream per form, behind the session cookie and the terms gate, reading the per-aggregate revision vector inside the tenant transaction. An unchanged revision writes **no event at all**, which is what makes the poll removable; a write produces exactly one `change` naming the aggregate that moved. `apps/api/test/realtime.test.ts` opens a real stream over a real socket: `ready` first, silence across three ticks, then one coalesced event after a real collection write, and **404 with no stream** for a form the caller cannot see. `apps/web/src/realtime.ts` coalesces a burst into one notification and gives up to `offline` after repeated failures, both asserted in jsdom. `console-live.test.tsx` proves the console's own live read: a push naming its aggregate refetches the screen, a push naming another one does not, two pushes inside a frame cost one read, and **a minute of clock passes while the stream is live without a single timed request** |
| Public summary | built+verified | `apps/api/src/platform/public.ts`, the one unauthenticated route: server version and uptime, the round trip of the query that produced the response, the migration ledger, and the template library summarised by walking the real definitions. `public-summary.test.ts` asserts the response is read live (the figure changes between two calls, the database clock is within a minute of now), that the engine facts equal the sum over the templates rather than a declared list, and the **exact key set**, so no form, response or organisation can appear on it by accident |
| Immersive public page | built+verified (component-level) | `apps/web/src/landing.tsx`, `apps/web/src/immersive/instrument.ts`; every figure is read in that request, the WebGL scene is a separate dynamically imported chunk, `aria-hidden`, and stops when the tab is hidden or the stage is off screen. `landing.test.tsx` mounts it in jsdom: the figures come from the API, the page is complete and readable when the scene returns nothing (the WebGL-unavailable path), and it prints no figure at all rather than an old one when the API does not answer. **Not measured:** frame rate and GPU cost on real hardware |
| Offline collection | built+verified | `apps/web/src/offline`; the published definition is cached and every answer is written to IndexedDB before anything is sent; a durable one-deep queue syncs on change, on blur, on tab hide, on reconnect and on a 2-minute timer; the device owns a stable response UUID so a retried start is idempotent; `collect-sync.test.ts` proves two-device merges keep the losing value in `response_answer.device_value` and record it in `response_conflict`; `.run/e2e-offline.mjs` runs 24 checks over a real database through the preview origin |
| Installable PWA | built+verified | `apps/web/public/{sw.js,manifest.webmanifest,icon-*.png}`; the worker precaches the shell and its hashed assets and **never** intercepts `/api`, `/auth` or `/health`, so no cached body can be served as live data; `service-worker.test.ts` executes the worker in a VM and asserts both; registration is production-only so it cannot shadow hot module replacement |

## 2. Not built (and deliberately not faked)

| Area | State | What it needs |
|---|---|---|
| `.sav` / `.dta` export | not built | a Python `pyreadstat` worker (Cloud Run free tier); until then the API returns **501 with a reason** rather than the label-syntax-only "SPSS export" that some tools ship |
| File uploads (image/audio/video) | not built | object storage (R2/S3) with presigned URLs and a virus-scan step; the renderer marks those inputs as not yet collected rather than silently skipping them |
| AI authoring / grounded analysis | not built | Workers AI or an LLM API; the **guardrails** are already specified (draft-only, analyser-validated, evidence-linked) in `specs/PLATFORM.md` §7 |
| SSO/SAML/passkeys, SCIM, WCAG 2.2 AA audit, backups | not built | hardening phase |
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

Done since this list was written: **offline collection + the installable PWA** (moved to §1), the
sync conflicts it produces are surfaced in the Responses tab, the console's 5 s poll is replaced by
the push channel in §1, and the landing page and the realtime client now have component tests.

## 5. What a reviewer should check first

- `pnpm test` — 90 tests; the RLS suites are the ones that matter most.
- `apps/api/test/platform-api.test.ts` — the whole product over HTTP as two accounts, including
  cross-tenant 404/403 behaviour and a full collection lifecycle.
- `packages/engine/test/xlsform.test.ts` — the fixpoint round-trip and what the importer reports.
- `packages/engine/test/export.test.ts` — 0 vs blank, five kinds of missing, CSV injection.
