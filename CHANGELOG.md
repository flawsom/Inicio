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
  timed request. `pnpm test` is the suite these entries describe; it stood at 169 tests when the push
  channel shipped and is 253 now: 55 engine, 103 API, 95 web.
- **One visual world, for the whole product.** The signed-in surfaces were restyled onto a single design
  system: the pearl and ink palette with the two accents, a spacing scale used for every margin, padding
  and gap, a type scale with real line heights, and one glass pane (`.card`) at four sizes. The console
  gained a fixed application bar, chapter headings with a hairline eyebrow, metric figures set in tabular
  display type, and a left accent bar on the active form. Collection, administration and the legal
  surfaces were restructured onto the same components without a single behavioural change.
- **An ambient light field behind the app** (`apps/web/src/immersive/ambient.ts`). The landing page's
  sculpture redrawn as a light field on a 2D canvas: the same node-and-filament structure, hand-projected
  with a perspective divide, using the theme's own custom properties as its palette. It costs no
  dependency and about 9 kB, draws one path and five fills per frame, stops entirely when the tab is
  hidden, and assembles as the page is scrolled. With no 2D context, no JavaScript, or under
  `prefers-reduced-motion` it draws one frame or none and the page is complete. A film grain and vignette
  sit above it in CSS.
- **API keys, and a machine surface that denies by default.** An `api_key` row is bound to a *user* as
  well as to an organisation, and that is the whole design: every policy in `0003` authorises through
  `membership`, so a key that carried only an organisation would need a parallel policy branch — a
  second place to get tenancy wrong — or would have to bypass RLS. Bound to its creator, a key
  inherits exactly the boundary a browser session has, and removing that person from the team kills
  the key on the next request, so revocation is not a separate mechanism that can drift. The secret is
  `ik_` + 32 random bytes, returned once and stored only as `sha256(secret)`; the prefix is what an
  operator can see afterwards. `requireActor` is deny-by-default: a key reaches a route only when that
  route *declares* the capability it needs, so a key on a scope-less route is `403 key_not_permitted`,
  a key missing a declared scope is `403 insufficient_scope` **naming the missing scope**, and a key
  pointed at another organisation is `403 key_org_mismatch` even when its creator belongs to both.
  `GET /api-scopes` says which scopes a route actually declares, and the console refuses to offer one
  it cannot grant, because a key granted only vocabulary is a key that can call nothing.
- **Webhooks, enqueued in the transaction that produced the event.** A delivery row is written with the
  event it describes, which is what makes an event exactly-once with the data: a publish that
  committed has delivery rows and a publish that rolled back has none. Delivery itself is
  at-least-once against a stable delivery id and an `idempotency_key` of `(event, endpoint)`. Each
  request carries `X-Inicio-Timestamp`, and `X-Inicio-Signature` is an HMAC-SHA256 over
  the timestamp and a dot and the raw body, signed with the endpoint's own secret — the timestamp is inside the signed material, so a captured
  request cannot be replayed. Failures are retried with backoff, five consecutive failures disable the
  endpoint and record *why* in words, and `POST …/test` sends a synthetic event now and reports the
  receiver's real answer, including its failure status. The signing secret and an API key's secret are
  returned by their create calls and by nothing else, because nothing else exists to return.
- **Quality flags and a queue somebody can work.** Speeding and straight-lining are detected in the
  respondent's own transaction, where the duration, the answers and the timestamp are all in one place;
  exact duplicates need the whole form, so they are an organiser's `POST …/flags/scan` rather than
  something a public link could be taught to see. Every flag carries the evidence the detector
  recorded — the duration against the threshold, the value that repeated, the response it duplicates —
  and closing one records the decision, the person and the note. A unique index on
  `(response_id, kind, coalesce(question_id, ''))` means a re-run or a sync retry cannot produce a
  second copy of the same finding, so the scan can be idempotent rather than merely careful.
- **The two console screens these needed.** An integration screen that shows each secret exactly once
  in a panel that says so (with the prefix kept, so a key can still be matched to an audit row later),
  the scope vocabulary read from the server rather than hard-coded, a delivery history with the
  receiver's own status and a retry that reports what happened, and a webhook self-disable that
  explains itself. Plus a Quality tab per form: status filters, the evidence rendered as named facts
  rather than raw JSON, a note required at the moment of the decision, and a scan button that says what
  it does.
- **The isolation proof now enumerates every tenant table.** `apps/api/test/sql/platform-rls.sql`
  already forged `app.org_id` as the non-superuser `app_role` and asserted zero rows across the nine
  `0003` tables; the list now carries all fourteen — including `response_conflict`, `response_flag`,
  `api_key`, `webhook` and `webhook_delivery` — so a table whose isolation is claimed rather than
  proved fails the suite instead of being forgotten.

- **The read API is open to keys, scope by scope.** The machine surface was the quality queue
  alone, which made four of the six scopes in the vocabulary promises nothing could keep. The reads
  now declare one: `forms:read` (the list, one form, a version's definition, the XLSForm export),
  `responses:read`, `analytics:read`, `responses:export`. The writes stay session-only — an API key
  still cannot publish a form or move a distribution link — and so does `/flag-kinds` and every
  console route, which is why a key there is `403 key_not_permitted` rather than a silent 200. A key
  reads one organisation and only that one: `GET /forms` is narrowed in SQL rather than filtered
  afterwards, and a read whose organisation is only known from the loaded row calls
  `assertActorOrg` once it is, so a key for A is `403 key_org_mismatch` against B's form *even when
  its creator is a member of both*. `GET /api-scopes` marks each scope as enforced, and a test
  asserts the catalogue never runs ahead of the routes.
- **Findings raised by hand, from the screen where the responses are.** The responses table grew a
  `Flag` action on each row: severity, and a note that is required before the button works, because
  a finding without a reason is not actionable. The two possible answers are shown as two different
  things — recorded, or *already in the queue, so nothing new was written* — because reporting a
  dropped finding as a recorded one is the same class of lie as "sent" for a mail that never left.
- **`specs/openapi.yaml` describes the API that exists.** The previous revision documented a
  questionnaire/`admin` surface that is no longer mounted anywhere: a contract that reads as
  verified while describing routes nobody can call is worse than no contract. The new one enumerates
  every mounted path (health, the Phase-1 `/auth` block marked `deprecated`, and the whole `/api/v1`
  surface), names the three credentials and which operations each one reaches, documents the scope
  table and the stable error vocabulary, and prefers `type: object` to a precise wrong schema where a
  handler assembles its response inline. It is now **held to the code**: `apps/api/test/openapi.test.ts`
  parses the file and compares its operations, both ways, with the routes the source actually registers,
  so a route without an entry fails the suite and so does an entry whose route is gone. It caught two
  immediately — the invitation routes were documented at `/api/v1/invite/…` while they are mounted at
  `/api/v1/auth/invite/…`. The same test pins the eleven operations a key may call, names the scope each
  needs, and asserts the unauthenticated surface as an explicit list rather than a count.

- **The studio: one definition, three live views.** The Builder tab used to be a textarea of JSON with
  a save button, and the analyser only ran when you pressed it. It is now three panels over one parsed
  definition — the JSON the API stores, the XLSForm sheets that `Download .xlsx` writes, and the form a
  respondent opens from a distribution link — repainted on every keystroke because there is nothing to
  wait for that is not already in the browser. Three claims are held by tests rather than by the copy:
  the sheet viewer shows the rows `xlsFormSheets` builds, which is the function `exportXlsForm` zips
  (asserted row by row against the file, trailing blank cells aside); the preview is rendered by
  `apps/web/src/respondent.tsx`, the component the collection page renders, and the test asserts
  *field-for-field identical markup* between the two; and typing in the preview sends nothing and stores
  nothing, because a preview that can write a response is not a preview.
- **`xlsFormSheets(def)` in the engine.** The sheet builder was the body of `exportXlsForm`, so viewing
  a workbook in the browser meant importing the zip writer to draw a table. It is now a function of its
  own that `exportXlsForm` wraps, which is why the viewer and the download cannot disagree and why the
  console's critical path never sees `fflate`.
- **The analyser runs while you type.** `validateForm` was called on save and its report rendered after
  the fact; it now runs per keystroke in the studio, which is the only moment a publish-blocking mistake
  is cheap to fix. Half-typed JSON says what it is ("not valid JSON", "`questions` is not an array")
  instead of blanking the panels or showing the definition it used to be.

- **A build check that fails when the bundle grows.** `scripts/check-budgets.mjs` (`pnpm budgets`)
  gzips every asset the build emits, reads the files `index.html` actually references, and holds four
  numbers: 80 kB of JavaScript and 7 kB of CSS on the critical path, 8 kB and 6 kB for the landing page's
  own chunk, and a 150 kB ceiling on any single chunk. It asserts the split rather than trusting it — no
  critical chunk may contain `WebGLRenderer` or `createInstrument`, so a static import of the scene
  anywhere in the app shell fails the build instead of quietly moving 135 kB of three.js onto everyone
  who was only going to read a table. The table prints whether the check passes or fails, because the
  numbers are useful when it is green too.
- **Accessibility and contrast, measured rather than intended.** The landing page and the terms gate are
  mounted in jsdom and audited with `axe-core`, with one rule switched off for a stated reason:
  `color-contrast` cannot resolve the effective background behind a glyph without a renderer, so it
  reports "incomplete" and passes whatever the colours are. It is covered by the stronger check instead —
  `contrast.test.ts` parses both stylesheets' token blocks, follows `var()` aliases across the file (the
  shared palette is declared once and either theme refers to it by name), composites translucent colours
  over the ground they sit on, and asserts 23 real pairs at 4.5:1 for text and 3:1 for control boundaries
  and the live dot, across the dark theme, the light theme and the landing palette.
- **CI on every push.** `.github/workflows/ci.yml` runs on a push to `main` and on every pull request.
  `verify` installs from the lockfile and runs lint, typecheck, the whole suite against a real PostgreSQL
  16 service, the build and the budgets. `harnesses` then migrates a database, bootstraps an owner, starts
  the API and the web server, waits for both to answer, and drives the 35-check consumer and 28-check
  offline harnesses over the same origin a browser uses. Each harness prints the count it actually ran,
  because a number in a document is a claim and the harness's own line is evidence. The first run of the typecheck step found a
  `TS7022` in a test file that the working tree's own build does not compile, which is the argument for
  having this in one command rather than in a habit.

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

- **The first real CI run failed, on a clean checkout, for a reason no local run could see.**
  `@inicio/engine` is consumed by the API and the web app through its own `dist`, and the working tree
  here had one because it had been built; the runner had none, so every `@inicio/engine` import in
  `apps/api` failed to resolve and the seven `TS7006` errors that followed were only the shadow of that.
  `pnpm typecheck`, `pnpm test` and `pnpm coverage` now build the engine first — in the script rather
  than in the workflow, so a developer's clean clone behaves the way the runner does.
- **Every database-backed API test ran against an un-migrated database in CI.** `test/setup.ts`
  created and migrated `postgres_test` and pinned `DATABASE_URL` to it — but `src/env.ts` prefers
  `APP_DATABASE_URL`, which the workflow also sets, to the *owner's* database. The application pool
  therefore connected somewhere else, no table existed there, and thirteen of the fourteen API test
  files failed on `relation "school" does not exist` while the migrations had applied cleanly to a
  database nobody queried. Both names now point at the suite's own database. It is not a CI-only class
  of bug: pointing `APP_DATABASE_URL` at a fresh database reproduces it locally word for word, which is
  how this was found.
- **The end-to-end job could not load the application's configuration at all.** `pnpm db:migrate`
  stopped inside `env.ts` with `DATABASE_URL: Required`, because the job named only
  `MIGRATION_DATABASE_URL` and `APP_DATABASE_URL`. `APP_DATABASE_URL` *decides* which connection the
  application uses; `DATABASE_URL` must still exist, exactly as the environment table says. The job now
  sets both, so the migration, the owner bootstrap, the stack and the two harnesses all run.
- **Every visit to the deployed page carried a 404, and the tab had no icon.** `apps/web/index.html`
  declared an Apple touch icon and a manifest but no `rel="icon"`, so each browser asked for
  `/favicon.ico` on its own — a file this project does not ship, and which `vercel.json` excludes from
  the SPA catch-all — and was answered `404`. Neither the test suite nor the first browser pass could
  see it: the request is made by the browser rather than by the page, so it never appears as a page
  response. The icons the build already ships are declared for the tab now, and `scripts/screenshots.mjs`
  reads the network through the protocol instead, failing on any `4xx` other than the `401` an
  anonymous visitor always gets — so the check that found this keeps it from coming back.
- **Every question in the respondent's form was an invisible, unclickable layer.** The ambient light
  field behind the signed-in app is a fixed, full-viewport, `z-index: -1`, `pointer-events: none` layer,
  and a question in a form is a block inside a card — and both were called `.field`. On every collection
  page each question block therefore inherited `position: fixed; inset: 0; z-index: -1;
  pointer-events: none`: stacked at the origin, painted behind the card, unable to receive a click. The
  markup was correct, the API answered correctly and both harnesses drove the API directly, so nothing
  failed — the form a respondent opened was simply unusable. The ambient host is now `.ambient`, and
  `apps/web/test/shell.test.ts` asserts the properties rather than the names, so the two classes cannot
  meet again: the fixed layer keeps its `position: fixed`, and `.field` may set nothing but margin.
- **The landing page counted nine tenant tables.** It says fourteen now, which is what the isolation
  proof enumerates and what `platform-rls.sql` forges `app.org_id` against.
- **The sign-in card said "Any email works".** Accounts are invitation only everywhere else; the card
  now says so, and tells the person which address to use.
- **An upload question rendered as a bare disabled file input.** The public page promises that `image`
  and `file` types "render as *not collected yet* rather than silently skipping the answer", and the
  caption that says it did not exist. A respondent now sees the phrase, next to the control.
- **A geolocation button on a device without geolocation did nothing at all.** It is disabled and
  labelled `Location unavailable` instead, because a control that silently ignores a click is the same
  class of lie as a `sent` for a mail that never left.
- **The Quality tab was called "the Queue tab"** in its own copy, and eight classes in the stylesheet
  (`gunit`, `frame`, `measure`, `metrics`, `metric`, `.unit`, `codebox`, `code`) were rendered by nothing.
  The dead rules are gone — including the metric grid the README described as being in use — and the
  card's `.gunit` alias with them, since a second name for the same object is how a stylesheet grows a
  surface nobody can find the component for.
- **A lazy chunk was labelled "landing, lazy" whether or not it was the landing page.** `pnpm budgets`
  now names the studio chunk and holds it to its own 40 kB, and the unnamed-chunk fallback is labelled
  as such instead of borrowing the landing page's name at the moment somebody is reading the table to
  find out what grew. It also asserts the studio stays lazy: no critical chunk may contain `list_name`,
  `constraint_message` or `begin_repeat`.
- **Control boundaries were below the 3:1 a control needs.** A field or a button is outlined with
  `--line`, a 13 % hairline chosen for looks: about 1.6:1 against the panel behind it, so the one thing
  WCAG 1.4.11 asks of a boundary was the one thing it failed. Interactive outlines now use
  `--line-control` at 50 % (4.86:1 in the dark theme, 3.62:1 in the light one), and hover sharpens to
  full-strength text rather than to a slightly less faint hairline. Measured by `contrast.test.ts`, so it
  stays measured.
- **The light theme's live colour failed the text minimum.** `--live` was `#0d8f9c`, which does not
  reach 4.5:1 as text on the light ground; it is now `#0a6a75`, measured at 4.96:1. The dark theme's live
  cyan was already fine and is unchanged.
- **`TS7022` in the contrast test's palette reader.** `alias` was inferred while `value` was reassigned
  from `definitions[alias[1]]`, so TypeScript saw a circular initialiser and decayed the whole reader to
  `any`. It is annotated.
- **Static assets on Vercel.** The SPA catch-all answered `/sw.js` and `/manifest.webmanifest` with
  `index.html` **and a 200**, so the service worker never installed and the manifest was never
  parsed. Each root static file is now excluded from the catch-all, and verification checks static
  assets by content type rather than by status code.
- **The ambient wash behind the console was invisible.** It was a fixed, negative-z-index layer behind an
  opaque `body` background, and a negative-z-index descendant paints before in-flow block backgrounds, so
  it could never be seen, which is the kind of flatness that reads as unfinished. The base colour now
  lives on `html` and the body is transparent. The new tests for the field are what stop "the background
  actually paints" from being something nobody checks.
- **A resize after dispose touched the canvas.** `resize` was handed out unguarded, so a window resize
  arriving in the same tick as teardown would keep sizing a canvas the field had already let go of.

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
