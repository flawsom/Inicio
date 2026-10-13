# Changelog

All notable changes to this project are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Because the product is deployed as a
service as well as published as source, dates matter more than version numbers — every entry says
what changed and why.

## [Unreleased]

### Added

- **Offline-first collection and the installable app.** The device owns its response: a
  client-generated UUID *is* the response id, so a start that is retried after a dropped connection
  resumes the same response instead of creating a second one. Answers are written to IndexedDB before
  anything is sent, the outbox is one deep and durable, and autosave fires on change, on blur, on tab
  hide, on page close, on reconnect and on a 2-minute timer.
- **Conflict retention.** Each sync sends `base` — the last server state the device saw — and the
  merge is decided per question. A field edited differently on two devices keeps the server's value in
  `response_answer.value`, retains the device's value beside it in `device_value`, and records the
  disagreement in `response_conflict` as `device_server_mismatch` or `calculation_mismatch`. Hidden
  questions are stored as `null` rather than keeping a stale value.
- **A service worker and web manifest**, with the API, `/auth` and `/health` explicitly excluded from
  every cache.
- **Conflict counts in the console**, per response and in aggregate.
- `pnpm coverage` (Vitest + v8) in the engine, API and web packages, plus the matching `coverage`
  scripts at the workspace root.
- **A push channel, so the console stops polling.** `GET /api/v1/forms/:formId/events` is one
  server-sent event stream per form. The server sends *which aggregate changed* rather than the data,
  so a screen refetches exactly the one thing that moved with the query it already had. Events are
  coalesced per tick, and a revision that has not moved writes **no event at all**, so a quiet form
  costs nothing and twenty responses in a second produce one event instead of twenty. The change
  signal is a per-aggregate revision vector read inside the tenant transaction (row counts, newest
  edit times, link usage, publish times), which is what catches an edit that changes no count at all.
  SSE rather than WebSockets because the traffic is one-directional, already behind the session
  cookie, and `EventSource` reconnects on its own. The stream deliberately ends itself at 50 seconds
  (under the hosting function's 60-second cap) and tells the client, so the reconnect happens on a
  clean boundary rather than mid-write. It is closed with a 404, and no stream at all, for a form the
  caller cannot see.
- **The browser half of it.** `apps/web/src/realtime.ts` keeps one stream per form shared by every
  component that wants it, coalesces a burst inside a single frame into one notification, drops an
  aggregate name this build does not know rather than forwarding it, backs off exponentially, and
  after repeated failures says `offline` so the caller's fallback timer takes over. The console header
  shows that state, because "live" is a claim about the connection and not a style.
- **`GET /api/v1/public/summary`**, the one unauthenticated route: server version and uptime, the
  measured round trip of the query that produced the response, the migration ledger, and the template
  library summarised by walking the real definitions. No form, response, organisation or count of any
  of them, asserted key by key in `public-summary.test.ts`.
- **An immersive public page at `/`.** A WebGL scene built for this product's own data model (a
  sequence of nodes wired by filaments, rearranged by scroll), loaded as its own dynamically imported
  chunk so a signed-in user never downloads it, `aria-hidden`, stopping entirely when the tab is
  hidden or the stage has scrolled past, with a cheaper tier on small screens and one drawn frame
  under `prefers-reduced-motion`. Every figure on the page is read from the API in that request and
  the panel prints the time it was read, so a live number cannot be mistaken for a decorative one.
  Where a claim needs evidence it links to the file that implements it.
- **Component tests for the web surfaces.** The landing page runs in jsdom (its figures come from the
  API, it stays complete when the scene returns nothing, it shows no figure rather than an old one
  when the API does not answer, and its call to action reaches `/login`), and so does the realtime
  client. The console's own live read is covered too, and it is the assertion that matters most here:
  a push naming its aggregate refetches the screen, a push naming another one does not, two pushes
  inside a frame cost one read, and a minute of clock passes while the stream is live without a single
  timed request. `pnpm test` is 162 tests: 54 engine, 70 API, 38 web.

### Changed

- **The console no longer polls.** The responses table polled every 5 seconds, analytics every 10, the
  forms list every 10 and the link table every 15. Four screens open on one form meant four timers per
  browser and a query per timer whether or not anything had changed, and a number that could still be
  fifteen seconds stale. There is now one stream per form, and the screens refetch on its signal. The
  fallback timer only starts when the stream has been reported `offline`.

### Security

- **Tenancy: the API refuses to serve on a connection that cannot enforce row-level security.** The
  application connects as the least-privilege `app_role`; a superuser or `BYPASSRLS` role is detected
  on boot and, in production, stops the process with a message naming the fix. `APP_DATABASE_URL` now
  names the application's connection explicitly and takes precedence over a hosting platform's
  default, which is normally the owner's connection.

### Fixed

- **Static assets on Vercel.** The SPA catch-all answered `/sw.js` and `/manifest.webmanifest` with
  `index.html` **and a 200**, so the service worker never installed and the manifest was never
  parsed. Each root static file is now excluded from the catch-all, and verification checks static
  assets by content type rather than by status code.

## [0.1.0] — 2026-10-12

The first public release: the platform, deployed and verified end to end.

### Added

- **Multi-tenant foundation.** Organisations, membership and roles (owner, admin, member, viewer),
  `ENABLE` + `FORCE` row-level security on nine tenant tables, tenant context set transaction-locally
  with `set_config`, and an append-only audit trail. Membership-based policies mean a forged
  organisation id still returns nothing.
- **Invitation-only identity.** One-time codes hashed with a server-side pepper, sessions that are
  `httpOnly`, `Secure` and `SameSite=Lax` with idle and absolute expiry, single-use invitation links,
  and an explicit `bootstrap:owner` path for the very first account.
- **Authoring.** Schema or JSON definitions, a live analyser, and publication that validates first and
  freezes the result.
- **An expression engine** for relevance, constraints, calculations and choice filters, shared by the
  server and the client (`packages/engine`).
- **XLSForm import and export**, with a round-trip fixpoint test and a report of anything the
  canonical model could not carry.
- **Versioning.** One draft and one published version per form, immutable published versions, and
  restore-as-a-new-draft.
- **Distribution links** — anonymous, single-use, multiple and panel — whose tokens are returned once
  and stored only as hashes.
- **Exports** as a CSV bundle (data, codebook, value labels, missing-code table), XLSX (five sheets)
  and JSON. `.sav` and `.dta` return `501` with a reason rather than emitting a file that would be
  quietly wrong.
- **Live analytics and response reads**, recomputed inside the tenant-scoped transaction on every
  request — no snapshot table and no cache to go stale.
- **Consent with evidence**: policy version, text hash, timestamp, IP address and user agent.
- **The school ranking survey as template #1**, imported and round-tripped through a spreadsheet.
- **A verified deployment**: one Vercel project serving the SPA and the API on one origin, with Neon
  PostgreSQL, migrations `0001`–`0009` applied, and tenant isolation re-proved against production.
- **Two live harnesses** — 33 end-to-end consumer checks and 28 offline-sync checks — which run
  against a real database through the same origin the browser uses and delete what they create.

### Notes

- 131 automated tests: 54 engine, 58 API, 19 web.
- Exports refuse to invent an SPSS or Stata file; file uploads are deliberately unbuilt rather than
  half-built. Both are tracked in [docs/ROADMAP.md](docs/ROADMAP.md).

[Unreleased]: https://github.com/flawsom/Inicio/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/flawsom/Inicio/releases/tag/v0.1.0
