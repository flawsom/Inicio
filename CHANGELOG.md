# Changelog

All notable changes to this project are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Because the product is deployed as a
service as well as published as source, dates matter more than version numbers — every entry says
what changed and why.

## [Unreleased]

### Added

- **The rate limiter is durable, so a ceiling means something on a serverless deployment.** `@fastify/rate-limit`
  was registered with its default store, a per-process LRU map, which is the one thing a limit must not be here:
  the API runs as a function whose process is recycled between requests, so each instance counted from zero and
  a 121st request was refused only where the 120 before it had happened to land. The counter is now a row
  (`rate_limit_counter`, migration `0011`) and one atomic upsert per request increments a live window, takes
  over an expired one and returns the count with the time left, which is what makes the ceiling survive a
  second instance, a rolling restart and the next cold start. Three properties are decisions rather than
  details: the table holds a **salted hash** of each bucket's subject and never an address or a token, so it
  cannot be read back as a log of who was throttled; a limiter that **cannot reach the database fails open**,
  with one line a minute naming the namespace, because a throttle that turns a database hiccup into an outage
  is worse than the flood it prevents (and the plugin swallows that error silently, so the store is the only
  visibility there is); and public collection carries a **second, independent ceiling keyed on the distribution
  link** on top of the per-address one, since a link is what a flood targets and what a field team shares, so a
  flooded link cannot lock out another team on the same form. Held by eight new tests, including two app
  instances over one database where the second refuses what the first filled while having counted nothing
  itself — the thing the store this replaced could not do. **Deploying this needs `pnpm db:migrate` in the same
  window:** until `0011` is applied where the new build serves, the limiter fails open (the designed behaviour,
  and the log says so) and `pnpm drift` reports the checkout one migration ahead.
- **An API key can be rotated, and rotation cannot do more than it says.** The machine surface had issue and
  revoke and nothing in between: changing a key's secret meant revoking it and minting a replacement, which
  produces a new row, a new creator, a new expiry and a window in which the integration has no working
  credential. `POST /orgs/:orgId/api-keys/:keyId/rotate` revokes the key and issues its successor in one
  transaction, returning the new secret once. Three properties are load-bearing rather than incidental. The
  **successor keeps the original creator, the same scopes and the same expiry**: rotation changes the secret
  and nothing else, so an admin rotating a member's key cannot move that credential's authority onto
  themselves, and rotating cannot quietly keep a lapsed grant alive. The **old secret is refused on its very
  next request** rather than after a grace window, which is what an integration rotating a key expects and is
  strictly stronger than the "within 60 seconds" the requirement asks for; an overlap window would be a second
  live credential nobody is watching. And a key **whose creator has left the organisation is refused** with
  `409 creator_not_a_member` naming the action to take instead, thrown inside the transaction so the refusal
  rolls back the revocation it had already made: the membership check is what authorises every policy in this
  schema, so the successor would have authenticated and then reached nothing, and a `201` handing over a dead
  key is worse than a refusal that explains itself. Held by three tests — the rotation end to end (successor's
  `user_id`, scopes and expiry equal to the previous key's, its hash on disk and not its secret, the audit row
  naming both prefixes and neither secret), a member refused and an already-revoked key `404` with no third row
  minted, and the left-creator refusal asserted to change nothing — plus the console control: a Rotate button on
  each row whose confirmation names the prefix about to stop working, and a secret panel rewritten in place.
- **A refusal by a named actor is now written down.** The requirement on a scoped key is that a refused write
  leaves a `403` *and* an audit entry, and only the `403` existed: a key missing a scope, a key pointed at
  another organisation, a member attempting an owner action and a viewer attempting a write were all answered
  and then forgotten. `HttpError` now carries an optional `RefusedActor`, the code that has just resolved* who
  the caller is* attaches it at the moment it refuses (`requireActor` for the three key refusals, `withOrg` for
  the two role refusals), and the error handler writes one `access.denied` row with the code, the method, the
  path, the organisation, the role and the scopes involved. Two deliberate exclusions: an anonymous `401`
  attaches nothing, because there is no actor to attribute it to and a row per anonymous guess is a growth
  vector rather than a record, and the write is best-effort, because a bookkeeping failure must not turn a
  refusal into a `500` the caller cannot act on. Held by a test that asserts the row for both a key and a
  session and asserts the *absence* of one for an unresolved credential.
- **Three documented measurements brought back to what the tree actually does.** Rotating a key changed the
  console bundle, so `pnpm build` + `pnpm budgets` were run rather than assumed, and the numbers they printed
  are now the ones the README carries: the app chunk is **252.3 kB raw / 78.7 kB over the wire**, not the
  239.9 / 75.1 the table and the performance footnote still claimed (the integration and quality screens, the
  version history and this rotation had all landed since that reading), with the landing and instrument rows
  corrected in the same pass. `docs/ROADMAP.md` said `pnpm test` was 388 tests; it is 461 (engine 87, api 167,
  web 207) and the api/web rows and the "what the tests cover" entry now say what the rotation tests hold.
  Worth flagging rather than burying: the app chunk has **1.3 kB of headroom** under its 80 kB gzip ceiling,
  so the next feature that adds to the console is the one that trips it, and the honest fix there is a
  decision about what leaves the critical path rather than a raised ceiling.
- **The deployment now answers which build it is, and the Phase 0 ledger was read against the code and
the live service instead of against the document.** `GET /health` returned `{status, dbTime}`: that the
process was up and the database answered, and nothing about the release serving the request, which is the
first question of any incident. It now carries `version` (`apps/api/src/version.ts`, a literal that
`version.test.ts` holds equal to `package.json`, because the serverless bundle's `rootDir` makes a JSON
import either inlined-and-drifting or a runtime failure), and a database that does not answer is a
**`503`** carrying the version *and* the driver's reason. That last part is a deliberate correction to the
first draft of this change: the version must not depend on the database that just died, but a health check
that answers `200` with bad news in the body is one no probe can fail on, so the honest pair is "still tell
them the build" and "fail the check". Three tests, including one that makes the round trip reject and
asserts both the status code and that `reason` is a sentence.
- **Five documented inconsistencies resolved against the code, one of them already closed.** (1) The test
  count: the suite runs **461** (engine 87, web 207, api 167, the web test being the Netlify
  canonical-host guard D44 added), and no stale count remains. (2) The migration
  ledger, which was the interesting one: the audit note said production was at 9 migrations with `0010`
  unapplied and therefore API keys, webhooks and flags not live. `pnpm drift` says otherwise today — the
  deployment reports 10 applied including `0010_api_keys_webhooks_flags.sql` and is in step with this
  checkout — and the routes that migration makes possible answer `401` signed out rather than `404`, which
  is what a mounted authenticated route does. It was applied at some point after that reading was taken;
  the drift job is what keeps the difference between "documented" and "deployed" visible. (3) `.sav`/
  `.dta`: the error table still said those formats were "deliberately not implemented" and the FAQ still
  asked why they `501`, when the truth is that they are refused only where no worker is deployed — both
  now say so, and name `&codebook=1` and the round-trip script that reads the worker's output back. (4)
  The design description: there is no "dark console" claim left to contradict, because `styles.css` has one
  palette with two materials (`--surface` for the marketing surface, `--paper` for work) and the README
  describes exactly that. (5) The deployment host: documentation, badges, examples, `scripts/screenshots.mjs`'s
  default and `scripts/check-drift.mjs`'s usage line all name `https://inicio.unifies.codes` now, with the
  platform hostnames recorded once as the same project's other names rather than as alternative addresses.
  The assumption that find-and-replace rested on was measured rather than assumed: all three hostnames
  answered, and their public summaries carried the same compute start time to the millisecond, so they are
  one deployment under three names. Two leftovers also got fixed: `netlify.toml` was still proxying
  `/api/*`, `/auth/*` and `/health` to `inicio-six-psi.vercel.app` (it now names the canonical host, and
  `apps/web/test/sitemap.test.ts` asserts every URL-valued `to =` target is on it), and the README's
  "what the live deployment is right now" sentence had been rewritten by the replace into a self-
  contradiction that named the same hostname twice. Recorded as D44.
- **The version history is a graph, and it now says what changed.** A published version is frozen and
  restoring one forks a new draft rather than rewriting anything — that part was already true — but the
  console listed versions as `v3 · draft · 12 question(s)`, so "what did this version change, and who made
  it?" had no answer anywhere in the product. Three things close that. `packages/engine/src/diff.ts`
  (`diffDefinitions(from, to)`) compares two definitions and returns **sentences** — `Added question
  "gps_accuracy" (decimal).`, `"school" label in hi changed from "स्कूल" to "विद्यालय".`, `"age" choices:
  added "dont_know"; removed "refused".` — matched by question *name*, per language, with anything it
  cannot describe in words pushed into `notes` rather than left silent; 23 tests, including the case where
  a question's options move from one shared list to another, where the option sets are deliberately **not**
  diffed against each other because that compares one instrument's options with another's. `GET
  /forms/:formId/versions/:versionId/diff` (plus `?against=`) computes that comparison from the two
  *stored* definitions — never from anything the browser holds — and answers with the version the graph
  says this one descends from (`based_on`) rather than the version numbered before it, because a restore
  forks from wherever it was taken. A first version answers `diff: null`, not an empty list, so the console
  can say "this is where the form started" instead of "nothing changed". And the Builder tab's flat list is
  replaced by `VersionHistory`: every version with the person who created it (an email from the
  organisation's roster, and `a former member` when they have left, because a history naming `user-1`
  tells nobody anything), when it was created and published, which version it was forked from, an expandable
  comparison showing the server's own sentences, and **Restore as draft** — offered only where it means
  something (a draft is edited, not restored), asking first because it replaces the current draft, and
  reporting both numbers (`Restored v1 as draft v4. Nothing was rewritten.`). The export refusals and
  restores report the server's words on failure rather than "something went wrong". **Not measured:** a
  browser pass. The five new tests in `apps/web/test/version-history.test.tsx` mount the component in jsdom
  against a fake API; no real deployment was walked, so the layout of a version row at 320 px is unmeasured.
  The history lands in the console's own chunk, so `pnpm budgets` reads 78.5 kB of the critical path's 80 kB
  ceiling (from 77.3 kB) — within it, and tight enough to say out loud rather than discover on the next
  feature.
- **The statistical export is read back, and reading it back found two real defects.** `.sav` and `.dta` are
  written by `services/pyreadstat`, deployed separately, and the repository's own runner is Node — so until
  now nothing checked the bytes that service produces. `services/pyreadstat/test_roundtrip.py` does: it
  builds a representative payload (a repeat group's contact, English and Hindi labels, value labels on a
  numeric **and** a string variable, the engine's four missing codes, a blank numeric cell, a blank string
  cell, a short row, and names needing sanitising, truncating and un-reserving), writes both formats through
  the worker's own `build()`, reads them back with `pyreadstat.read_sav`/`read_dta`, and prints one line per
  property as `ok`, `FAIL` or `not verifiable` — 34 checks. Two of them failed against a real worker, both
  in `worker.py`, and both are the class of failure this project exists to refuse: a file that is quietly
  wrong. The **declared missing codes never reached a `.sav`**: `pyreadstat` wants `missing_ranges` as a
  per-variable dict, the worker passed a flat list of `{value, label}` dicts, and the `TypeError` fallback
  then dropped the missing ranges *and* the file label together while its note blamed "this pyreadstat
  build". They are now declared as one contiguous range per numeric variable (`-99`…`-96`, which is also
  what SPSS's own cap of three discrete values per variable allows), the fallback drops only the argument
  the writer names, and a `.dta` — which has no such argument at all, Stata's equivalent being extended
  missing values that pyreadstat does not write — says so in its notes instead of staying quiet. The second
  is worse: **a `.dta` attached the value labels of every string variable to the value `0`**, silently and
  with no note, so each option of every select question arrived as "the label of 0" and nothing said which
  option was which. Stata attaches value labels to numbers, so they are now dropped, counted and named per
  variable — and the codebook that ships beside the file is where a Stata reader finds them. What could not
  be verified is stated rather than counted as a pass: the missing-range declaration does reach the file (it
  changes the bytes by 64) but `pyreadstat`'s reader reports `{}` even for a file it wrote itself, so that
  line is `not verifiable` with its evidence attached.
- **The codebook now ships beside the statistical file, and the body the worker receives has one
  definition.** `statisticalPayload(format, dataset, fileLabel)` moved from the API into
  `packages/engine/src/export/statistical.ts`, so the body a deployment is asked to write, the body the
  API's own tests describe, and the body the end-to-end harness sends are one function rather than three
  copies that agree until one is edited. `GET …/responses/export?format=sav&codebook=1` then returns the
  data file **and** the codebook quartet the CSV bundle already carries (codebook, value labels, missing
  table, metadata) in one archive — the bare file stays the default, because a researcher downloading a
  `.sav` wants to double-click it, and the console offers the pair as a checkbox beside the export buttons.
  `apps/api/scripts/roundtrip-statistical.ts` is the harness that closes the remaining seam: the real school
  ranking template → `buildDataset` → `statisticalPayload` → `writeStatisticalFile` → a pyreadstat process
  it starts itself → the bytes → `test_roundtrip.py` reading them back. The export buttons also stop lying:
  `.sav`/`.dta` were rendered as a permanently disabled `Export .sav (unavailable)`, which was true before
  the worker existed and has been false since — whether a deployment can write one is the deployment's
  business, and the API answers for itself with a `501` naming `PYREADSTAT_WORKER_URL` or a `502` saying the
  worker did not answer.
- **The device can now show, and carry away, what it has not sent.** Keeping answers safe and saying
  whether the server had them was the whole of what the collection page could do about a bad connection,
  and that left three holes, each of which is a way field data is really lost. A failure was one sentence
  with no attempt count and no next attempt, so "is my work safe" was answerable only as "not yet". There
  was no way to take answers *off* a device about to be wiped, replaced or uninstalled. And a photo whose
  upload was cut off by a dead zone had to be picked again from the question it belonged to, by somebody
  standing on a hilltop. `deviceState()` now turns the draft into a structured answer about its own queue,
  what is waiting, whether the server holds the rest, how many times the last send was tried, what it
  said, and the instant the next try is due, rendered beside the connection pill as "Tried 3 times, next
  try at 14:07". `offline/backup.ts` writes the whole draft, queue included, to plain JSON through the
  browser's own download (**Save a copy**) and reads one back (**Restore a saved copy**) with no session,
  no server and no network: the copy names the survey and the version it came from, restoring it onto a
  *different* link is refused by name, a copy written by a newer app is refused rather than half-read, and
  a copy older than the answers already on the device never overwrites them. The restored draft keeps the
  device's UUID, so the work continues on the response it had already created instead of starting again.
  `attachmentOutcome()` keeps the two ways a file can fail apart: a file the *network* ate is held in
  memory and sent by itself once the connection returns, while a file the *server* refused is not
  remembered at all, because sending it again unchanged would fail in exactly the same way. And the room a
  device has left is reported at the top of the form before it costs anything, from
  `navigator.storage.estimate()`, with "the browser will not say" as a real answer rather than a guess at
  zero. 22 tests in `apps/web`: the queue's shape and the storage verdicts without a browser; a copy that
  restores onto a device with nothing and carries on sending; a copy of another link, or from a newer app,
  or older than what is already there; and, mounted as the page itself, an upload interrupted by the
  network that lands after a reconnect, a refusal that is not retried, a warning before a full disk costs
  anything, and the answers still there when the page is opened a second time. **Not measured:** a browser
  pass over any of it. The deployment has no collection link to walk, and making one means writing a
  throwaway organisation into the production database and real bytes into its bucket, so what a page-level
  test cannot reach is stated as unmeasured rather than assumed: the file a real browser writes from
  `Save a copy`, and the estimate a real browser reports for its own storage.
- **A scheduled drift check, because the one failure a green build cannot see is a production database that
  never ran a migration.** A migration merged to `main` either runs against production or it does not, and
  when it does not the application is deployed and *reachable* — the health check, the landing page and
  every older screen keep answering `200` — while the tables its newest screen reads do not exist there.
  That is how this deployment once spent a day nine migrations deep with nothing red to show for it.
  `scripts/check-drift.mjs` (`pnpm drift`) reads `GET /api/v1/public/summary`, which reports the
  `schema_migrations` ledger the running service has just read **on the connection the application uses**,
  and compares it with the migration files in the checkout: no credentials, no cluster access, nothing
  about tenants. `.github/workflows/drift.yml` runs it every six hours and, on a disagreement, opens or
  appends to one issue carrying the report and the command that closes it. The exit codes are the design:
  `0` in step, `1` drift, `2` unreadable — a deployment nobody can reach is an outage rather than a schema
  problem, so it fails the run and opens nothing. Verified in all three states, because a check that has
  only ever passed is a check nobody has seen work: in step against the live deployment, drifting by adding
  a real `0011_*.sql` to the checkout for one run (which named the missing file), and unreadable through a
  closed port.
- **The pointer trail is on every route, and the app has one pointer treatment instead of two.** The trail
  was mounted by the landing page alone, so a visitor following the sign-in link watched the cursor change
  behaviour halfway through arriving — and the signed-in app wore a labelled ring that followed the same
  pointer with a different idea of what hovering means. The shell now mounts the trail for the whole
  product: `/`, `/login`, `/console`, `/terms`, `/privacy`, an invitation and a collection link. The ring
  and its stylesheet rules are gone; `landing-cursor.ts` became `cursor-trail.ts` and `.lcursor` became
  `.cursor-trail` because the old names had stopped being true; and the canvas rule moved out of
  `landing.css` into `styles.css`, since a canvas styled by a stylesheet only one route loads is an
  unstyled box in the flow of every other route. It stays decoration: imported on demand **and only by a
  device that will draw it** — the gate is ahead of the `import()`, so a finger, a reader who asked for less
  motion and a browser that cannot answer the question fetch nothing — with its own **4 kB** budget and an
  assertion that no critical chunk contains it; hidden under reduced motion by both the script and the
  stylesheet; and `pointer-events: none`, so every control underneath still receives its click. `cursor-trail-everywhere.test.tsx` mounts the app at
  each route and requires **exactly one** trail, mounted once even under StrictMode's double mount, disposed
  by reference when the route goes.
- **The four public pages are listed in a sitemap, with `robots.txt` closing everything else.** The console,
  an invitation and a collection link are deliberately absent: they are behind a session or a single-use
  token, and `/console` renders the sign-in sheet to a stranger, so listing it would advertise a page whose
  only content is "sign in". Neither file carries a `lastmod` — a build timestamp is not the date a page's
  content changed, and a sitemap that says "changed today" on every deploy is one a crawler learns to
  ignore. Both are served as themselves rather than as the app shell: they were added to Vercel's catch-all
  exclusions in the same pass that wrote them, and `apps/web/test/sitemap.test.ts` holds the negative
  lookahead, Netlify's `force` flags (which would otherwise override the filesystem) and the set of routes
  in the sitemap. The guard was broken on purpose once — one name removed from the exclusion list — to
  confirm it fails with the file named.

- **The app icons are generated from the palette, and every committed colour is checked.** A stylesheet is
  edited; a PNG is not, which is why the tab icon and the home-screen icon were the last things still
  wearing the palette before this one — measured at **92 % blue-dominant pixels** against a product that had
  been orange for two palette changes. `scripts/make-icons.mjs` (`pnpm icons`) now draws them: the same
  rounded tile with three bars the product's own header draws, in `--surface`, `--on-primary`'s white and
  `--primary`, supersampled at 4× per axis and encoded with `node:zlib`, so the output is byte-stable on any
  machine and needs no image library. `apps/web/test/brand-assets.test.ts` then reads what is committed: the
  three PNGs are **decoded pixel by pixel** and held to the palette's own ground, required to carry the
  primary, required to contain **zero** blue-dominant pixels and required to contain none of the three
  colours the previous icon was drawn from; the README's nine drawings are held to the same palette by value
  and to no saturated blue-violet accent; and every badge colour on the repository page is checked, with
  every label ground required to be the one surface tone. The check was verified by breaking it — a single
  `#38bdf8` put back into a drawing fails the suite with the file and the colour named, which is the only
  evidence that a guard is a guard.
- **The four emails are a designed surface, not a template with a heading on it.** The sign-in code, the
  welcome a new member gets when an invitation is redeemed, the notice that a sign-in finished and the
  submission receipt are now one card, built by `apps/api/src/mail/templates.ts`: a table layout that holds
  together in Word's renderer, a dark scheme for the client that switches, a written plain-text
  alternative, and **nothing remote anywhere** — no image, no pixel, no web font, no `url()` — because an
  email that loads a file from a server is a read receipt with a design. The code gets the one treatment
  nothing else in the message gets, and is deliberately **never in the subject**: a subject line is drawn on
  a locked screen, quoted back in every reply and written into every mail log and gateway on the way, so a
  one-time code in it is a code published where the reader cannot see it. The lifetime it promises is read
  from `OTP_TTL_MINUTES` rather than typed a second time in prose. `mail-templates.test.ts` pins the rules
  as properties rather than habits — a hostile address, organisation, role or submission id cannot carry a
  tag into any field of any template, no template fetches anything, every colour pair it uses measures
  4.5:1 in both schemes, and the message stays far inside the size at which clients clip it. The suite found
  a real defect on its first run: an organisation called `St Mary's <b>School</b>` put a live `<b>` inside
  the hidden preheader, because escaping was done at the call sites rather than at the layout.
- **A welcome email when an invitation is redeemed.** The platform had no message for the moment somebody
  stopped being a name on a list. The redemption now sends one that names the organisation and the role,
  describes what that role can actually do in the words the authorisation guards already enforce, and gives
  the three things to try first — plus the fact that accounts here are invitation-only, because a reader
  who does not know that will spend their first afternoon looking for a sign-up page.
- **A sign-in notice on every platform sign-in.** The legacy school route sent one; the platform route,
  which is the one the console signs in through, sent none — so most readers never learned that a code had
  been used on their address. It now goes out on both, off the response path, with the instant in UTC and
  the address the sign-in came from, and with advice about the inbox rather than a password, because an
  inbox is the only credential this product has.
- **`MAIL_REPLY_TO`**, the reply target as its own configuration, carried by both transports (an SMTP
  `Reply-To:` header and Resend's `reply_to`, sent only when it is set). The welcome invites a reply when it
  is set and offers an owner or an admin when it is not: a sender does not need an inbox, and an instruction
  that bounces is worse than no instruction because the reader believes they asked.
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
- **The public page is one flight through the product, and the product is the content.** The page at `/`
  was rebuilt as a six beat camera journey in the order the software actually works: a typographic hero
  with **no 3D object in it** at all (the scene fades in as the headline scrolls away, so the first thing
  a reader meets is a sentence rather than a render), then the questionnaire as a program — twenty four
  question slabs rising into a staggered arc and wired by the three kinds of logic filament the engine
  really has (relevance, constraints, calculations) — offline collection (three device clusters streaming
  particles to a hub, one of them losing signal, keeping collecting while it glows, and handing everything
  over in a burst when it returns), conflict retention (server and device orbs orbiting one centre that
  never merge, because the gap between them is the point), a **fly-through with no text at all** through a
  corridor of form slabs with the camera banking through the move and level by the end of it, tenant
  isolation (three sealed realms ringed by boundary membranes nothing crosses), and the invitation. Every
  object in the scene depicts something the product does, which is what removed the abstract sculpture and
  the film grain; the copy inside the flight is set as type rather than as panels of tiles, and there is no
  card and no stat grid on the page, because the product is the content. Two properties are load bearing
  rather than decorative. The choreography is **arithmetic**: where the camera stands at any progress, how
  much of the arc is assembled, when each beat hands over to the next, when the disconnected device comes
  back, and the rule that the share of everything collected that has reached the hub **never decreases**
  live in `apps/web/src/immersive/choreography.ts`, which imports no renderer at all, so they are unit
  tested without a GPU — and the same module is what the page reads for its own beat list. And
  `prefers-reduced-motion` draws **one frame per scroll position and never starts a loop**, with the same
  beats and the same camera poses and only the idle motion absent, so it is a complete path rather than a
  degraded one. The scene stays a dynamically imported chunk (122.2 kB gzipped, ceiling 150 kB) that a
  signed in reader never downloads, is `aria-hidden`, drops to a cheaper tier under 860 px or on a device
  reporting four cores, and `createInstrument` returns null rather than throwing when a context cannot be
  created, which is the one thing that genuinely fails on real devices. Each figure on the page is still
  read from `/api/v1/public/summary` in the request that renders it, with the time it was read printed
  beside it, and each beat ends by naming the two taps that show that claim working rather than by
  linking at a file.
- **The flight, driven in a real browser rather than described.** The component tests hold the markup and
  the arithmetic; they cannot hold whether a WebGL context is created at all, so the page was walked
  through a headless Chromium with software GL and the numbers recorded: a live `WebGL 2.0` context on
  `canvas.linstrument`, 621 draw calls across the flight at 1440×1000 and 824 at 390×844 (each beat
  drawing again on every scroll step), the active chapter advancing `#program` → `#sync` → `#conflict` →
  `#flythrough` → `#tenants` → `#invitation`, **0 px of sideways overflow at 1440 and at 360**, no console
  error beyond the two signed-out `401`s this deployment always answers, and — the one that matters under
  the readability rule — the reduced-motion run drawing **nothing at rest** and one frame per scroll
  position, 186 calls for the whole page against 621 with the loop running. Two things that had been
  assumed were wrong and are now checked in the script: the no-WebGL path is reached on this machine's
  Chromium unless the flags are `--use-gl=angle --use-angle=swiftshader --disable-gpu-sandbox`, and
  `querySelector('canvas')` finds the **cursor trail's** 2D context now that a trail is mounted on every
  route, so a scene that was drawing perfectly reported as not drawing until the canvas was named. The
  captures are of **this build** and not of the deployment: production still serves the page the flight
  replaces, and `docs/assets/screenshots/capture-report.json` records the address each image came from so
  that difference is visible in the repository rather than implied by a caption.
- **Component tests for the web surfaces.** The landing page runs in jsdom (its figures come from the
  API, it stays complete when the scene returns nothing, it shows no figure rather than an old one
  when the API does not answer, and its call to action reaches `/login`), and so does the realtime
  client. The console's own live read is covered too, and it is the assertion that matters most here:
  a push naming its aggregate refetches the screen, a push naming another one does not, two pushes
  inside a frame cost one read, and a minute of clock passes while the stream is live without a single
  timed request. `pnpm test` is the suite these entries describe; it stood at 169 tests when the push
  channel shipped, and it is 461 now: 87 engine, 167 API, 207 web — the web figure having grown with the
  flight's own suite (the choreography as arithmetic, the hero carrying no 3D object, the six beats in
  order with the fly-through panel empty, every other beat naming where to check its claim, no anchor
  leaving this deployment, and the scene falling back without a canvas).
- **File uploads: presigned, bounded, scanned, and picked from the browser.** An `image`, `audio`,
  `video` or `file` question can be authorised, uploaded around the server and verified — and now from
  the product's own interface, which was the half that was missing. A respondent gets a real file input,
  which appears only when the deployment actually has storage and takes its accepted types and its size
  ceiling from the server's own capability block rather than from a constant in the bundle; the two states
  where it cannot work — no bucket configured, and the studio's preview, where there is no response for a
  file to belong to — each say so rather than offering a control that would fail on use. The page then
  authorises the upload, sends the bytes and calls `complete`, and stores the attachment id the server
  returns as that question's answer, through the same draft-and-outbox path as any other answer. The file
  travels as a PUT straight from the browser to S3-compatible
  object storage against a URL the API presigns, so a video is not a video-sized response body from a
  serverless function and the store's credentials never leave the server. SigV4 presigning is written out
  (`apps/api/src/storage/presign.ts`) rather than imported, so one signing path covers the upload and the
  API's own HEAD, GET and DELETE, and the content type is bound into the signature — a URL that has been
  handed out uploads one object, of one type. The limits are enforced twice for that reason: an explicit
  per-question-type MIME allowlist and `UPLOAD_MAX_BYTES` (10 MB by default) are checked when the upload
  is authorised, and the size and type **the store reports** are checked again before the row is called
  `uploaded`, because the answer that counts comes from the thing that received the bytes. `sha256` is
  computed server-side from those bytes. The scan step is a clamd INSTREAM client with four honest
  outcomes: `clean` (a scanner read it), `infected` (a scanner named it, and the object is deleted),
  `error` (a scanner was configured and did not answer) and `skipped` (this deployment has no scanner) —
  there is deliberately no path that reports `clean` without a scanner saying so. Whether an unscanned file
  may be *accepted* is now a named policy rather than a side effect of an unset variable:
  `ATTACHMENT_SCAN_POLICY` defaults to `allow_unscanned`, which accepts both `skipped` and `error`, because a
  field team whose scanner host is unreachable must not lose every upload — while the row keeps the two apart,
  so the data still distinguishes "no scanner here" from "a scanner that did not answer", and the capability
  block reports the policy so the client states it instead of assuming it. `ATTACHMENT_SCAN_POLICY=require`
  makes a scanner's verdict mandatory and refuses at authorisation, before a URL is signed, rather than letting
  a respondent transfer a file that would only be rejected at the end. Submission
  cross-checks as well: an answer naming an attachment the server has not accepted is refused with
  `attachment_not_ready` instead of submitted with a link that leads nowhere. **No migration was
  needed**: `response_attachment` already carried `storage_key`, `sha256`, `scan_status` and `status`
  under `FORCE` row-level security in `0003_platform.sql`, and `app_role` already held the grants, so
  the schema written for this feature was the schema it shipped on. Authors read a file back through
  `GET /orgs/:orgId/attachments/:attachmentId` — session-only, and `409` for a row the scanner named
  infected. **Not built:** a console screen that lists or downloads an attachment — the author route exists and
  nothing in the browser calls it. A file is also not choosable while the device is offline, because the
  offline promise covers answers rather than attachments; the control says it needs a connection rather
  than pretending to queue one.
- **Statistical export: `.sav` and `.dta` are files now, or an honest refusal.** They used to be a
  `501` and nothing else. `services/pyreadstat/` is a small Python service (stdlib `http.server` plus
  pyreadstat, so there is no web framework here to keep patched) that takes the engine's dataset as JSON —
  columns with their prompts and their numeric-ness, the rows, the value labels and the declared missing
  codes — and writes an SPSS `.sav` or a Stata `.dta`, reporting every rename, name truncation,
  reserved-word collision and dropped label back rather than discarding them. `pyreadstat` is the reason
  this is a service and not a function: the format needs a writer that knows it, and this repository's
  build and install steps are Node-only, so nothing here installs Python. What the API does with it is the
  same posture as everywhere else — `PYREADSTAT_WORKER_URL` is what turns the refusal into a file, the
  `501` without it **names that variable**, and a worker that is unreachable, or that answers with zero
  bytes, is a `502` with a reason and never a download a researcher opens and finds empty. Five tests in
  `apps/api/test/pyreadstat-export.test.ts` stub the worker over a local HTTP server and pin both
  branches, including the zero-byte case. **Not covered:** the worker's own Python logic, because the
  runner here is Node, and its deployment, which is deliberately somebody else's.
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

- **The numbers in this document, and in the README, are this build's numbers.** Rebuilding the page changed
  what the suite covers and what the bundle weighs, so each figure quoted above and beside it was measured
  rather than carried forward: `pnpm test` is **461** (engine 87, API 167, web 207), `pnpm coverage` is
  engine **89.9 %** statements / 81.7 % branches / 94.3 % functions, API **84.3 / 79.1 / 92.3**, web
  **62.5 / 77.9 / 61.4** over the whole package and **88.6 %** over the offline core
  (`--coverage.include='src/offline/**'`), and `pnpm budgets` reports 78.7 kB of critical JavaScript, 5.1 kB
  of critical CSS, 6.6 kB for the landing chunk (3.6 kB of it stylesheet), 7.3 kB for the studio, 122.2 kB for
  the renderer and 1.4 kB for the cursor trail — all inside their ceilings, with 1.3 kB of headroom under the
  80 kB critical-JS budget, which is worth repeating rather than rediscovering. Note what moved and why: the
  web package's coverage was documented at 48.5 % and is 62.5 %, not because anything was covered that was
  not covered before but because the six beat flight arrived with tests for its own arithmetic (`choreography.ts`
  is at 100 % of statements) while `instrument.ts` stays at 7.9 %, which is what a WebGL renderer loop being
  executable only in a real browser looks like in a coverage table.
- **There is one database, and it is the one the deployment answers from.** This workspace's
  `DATABASE_URL` named one Neon project (`proud-field-04065571`, `us-east-2`, database `inicio`) while the
deployment answered from another (`cold-leaf-32411407`, `ap-southeast-1`, database `neondb`), so
`pnpm db:migrate` here migrated a database nothing served and the two disagreed about their ledger — the
state D36 recorded and D37 decided. The repository's three connection variables
(`DATABASE_URL`, `APP_DATABASE_URL`, `MIGRATION_DATABASE_URL`) now name the deployment's database, which
is the one with the live accounts in it and the one nearest those users; `pnpm db:migrate` at the root is
therefore a migration of production, and `pnpm drift` compares production's own ledger with `main`.
Confirmed by running it: all ten migrations were **skipped**, not applied. Both sides were counted first,
which is what makes this a decision about plumbing rather than about records — one account and one
organisation on the workspace's side against two accounts and one organisation on the deployment's, and
**zero responses on both**. Every account on the retired side also exists on the surviving one, so the
only thing left behind is an organisation called `Unifies` with a single empty form, and that project is
left in place and read-only rather than deleted. The guard in `apps/api/test/setup.ts` — the suite refuses
to run against a host that is not this machine — is what makes a workspace wired to production safe
rather than reckless, and it now matters more than it did: see D37.
- **The drawings and the badges caught up with the product, and the numbers stopped disagreeing.** Nine of
  the ten SVGs the README shows were still rendered in the previous palette — navy grounds, a light blue
  accent, a violet second hue and cool blue-grey type — because changing a stylesheet does not change a
  drawing, so the documentation went on showing a product that no longer existed. They are rewritten **by
  role** rather than by find-and-replace: the grounds keep their order from darkest to raised panel, the two
  accents stay two colours (the primary orange and the peach, the same pairing the interface uses for a fill
  and for type on the dark material), the muted type moves to the product's own muted-on-surface value, and
  the status colours move to the tokens the interface paints. Verified by rasterising every one of them in
  Chromium and reading the pixels back: **zero** saturated blue-violet pixels across all nine, against 2.4 %
  to 17.1 % before. The repository page's own badges move with them — the light blue and the violet become
  the deep end of the brand's warm ramp, which is what carries white text at 4.5:1, and every badge's label
  ground becomes `#191c21`; the Node, pnpm, TypeScript, React, Fastify and PostgreSQL badges keep their
  vendors' colours, because repainting those would be a claim about somebody else's brand. The counts were
  stale in the same pass and in three different ways: the suite said 332 in one document and 333 in another
  (366 now), and the contrast suite was described as **31** pairs in two places and **25** in a third when
  it measures **26**.
- **One palette and two materials, everywhere in the product, not only on the marketing page.** The
  workspace was the last surface still built in the theme the brand replaced: near-black ground, pearl type,
  one blue, one violet and a cyan reserved for "live". A person who clicked through from an orange page on
  white therefore arrived in a different product's colours — and the two stylesheets shared nothing but the
  type scale. The palette is now declared once, at its brand values (`#ea580c` primary, `#fdba74` accent,
  `#ffffff` ground, `#191c21` surface, `#111827` type), and the two stylesheets are asserted to hold the same
  values as each other rather than assumed to agree.
- **The dark material is a class rather than a second theme.** `.surface` re-binds every colour role for its
  subtree — type, support type, boundaries, control boundaries, panels, the sheen along a card's top edge, the
  scrim behind the sticky bar, the accent, all four status colours and the lift — so the material a region is
  made of is a fact about the region, not about the visiting operating system. Every screen is one of the two
  materials and the choice was made explicitly: **surface** for the first paint, the sign-in sheet, the
  consent gate, the invitation, the policy documents and the studio's source panel (code is ink here, not
  paper); **paper** for the workspace, the quality queue, the integration screens, the respondent's form and
  the landing page's reading sections. The `prefers-color-scheme` block is gone: a product with two materials
  is not a product with two themes, and a console that changed colour under a visitor it cannot see was one
  more state to get wrong.
- **The chrome follows the palette.** The primary action is the brand's own button in both stylesheets — the
  same fill, the same ink label, the same lift on hover — instead of a blue-to-pearl gradient; the ambient
  field behind the workspace draws its filaments and its pool of light from the brand's warm values rather
  than from a blue, a violet and a cyan; the vignette is a warm grey on paper and black on the surface;
  `index.html` declares `light` with a `#191c21` theme colour (the colour of the first frame on every route)
  and the manifest's splash and theme colours follow it; and the control radius, the card radius and the pill
  radius are now the landing page's own values, so the two files share one radius language.
- **The public page no longer points at the source.** The landing page advertised this repository in four
  places: a `Source` item in the navigation, a link on every capability card naming the file that
  implements it, a "Read the honest status document" button aimed at `docs/ROADMAP.md` on GitHub, and a
  footer line with the repository URL beside the licence. This deployment is one organisation's private
  application, so a public page that publishes where its code lives is a leak with good intentions. Each
  capability card now ends with the two taps that show the claim working inside the product ("Where to
  check it"), the status button opens `GET /api/v1/public/summary` on this deployment instead, and the
  footer names the host it is served from. Enforced rather than promised: `landing.test.tsx` resolves
  every anchor the page renders and fails on an off-site or source host, and a browser pass over the live
  page checks the served HTML for the same thing. The repository itself is private, which makes the old
  links dead ends as well as signposts.
- **No em dash or en dash reaches a reader.** Punctuation on screen and in the inbox is now full stops,
  commas, colons and parentheses: the web app's copy, the four emails, the XLSForm importer's notes, the
  validation messages, the export's missing-code labels and the shipped questionnaire. The honesty
  list's bullet marker is the brand's dot rather than a 12px rule that read as a long hyphen, and the
  capability cards' evidence chip is an instruction rather than a path. The boundary is what a browser can
  be served rather than what is rendered: `index.html`, the service worker and both stylesheets are clean
  too, because a dev server inlines a stylesheet as text with its comments intact, while a built bundle is
  stripped, and a recursive scan of the build output finds neither dash in any file it ships. Developer
  documents (this file, `DECISIONS.md`, `specs/`) still carry theirs; the sweep covered everything that is
  served.
- **Mail leaves as `Inicio <inicio@unifies.codes>`, which is this deployment's identity for everything it
  sends.** Verified against the live relay rather than assumed: all four templates were sent through Resend
  and arrived in a real mailbox with their links, both alternatives and their palette intact — 4/4 reported
  `delivered`, 26/26 content checks passed. Sending *to* that address is a different question, and it
  bounced (`554 5.1.1 … User unknown`), which is exactly why the reply target is separate configuration
  (D32).
- **The landing page is the brand's palette now, and the console keeps its own.** The page is anchored on
  the brand values — primary `#ea580c`, accent `#fdba74`, background `#ffffff`, surface `#191c21`, type
  `#111827` — and it is one page made of **two materials** rather than one flat theme: the stage and the
  footer are the surface, and every section a reader actually reads is an opaque sheet of the light ground
  laid over it. Type on the ground is ink and type on the surface is white; a border is a hairline of
  whichever of the two it is drawn on; nothing borrows a colour from the other role. The signed-in console
  is deliberately untouched: it is a dark room with glass in it, and it stays that way.
- **The brand orange cannot be a glyph on white, so the primary is two tokens.** `#ea580c` measures 3.6:1
  on `#ffffff`, under the 4.5:1 text needs, so `--l-primary` is the brand value wherever it is a fill or a
  mark and `--l-primary-text` is a darker `#c2410c` (5.18:1) wherever it is type. The hero's display
  gradient stops at the brand value because a 150px line is held to 3:1 rather than 4.5:1, and the primary
  action's label is the type colour rather than white — `#111827` on `#ea580c` is 4.98:1, white is 3.6:1.
  The peach accent appears **only** on the dark surface, where it is 10:1; on white it is 1.9:1, so it
  never appears there. Every one of these is a measurement rather than a preference, printed by
  `apps/web/test/contrast.test.ts` on each run.
- **One radius language, and two grids that are one card.** The capability cards and the template cards
  now share the same radius token, the same hairline border and the same hover lift, because two card grids
  on one page are one card. The live figures, the footer and the section sheets each take a radius from the
  same three-value scale rather than a fourth value invented at the point of use.
- **The scene refracts the palette it sits in.** `immersive/instrument.ts` was lit blue and violet while
  the page was blue and violet; its environment, key light, dust, filaments, glass attenuation and chrome
  now carry the brand orange and the peach, and the stage's ground value is the surface token itself. The
  pointer trail changed with it, and for a structural reason: it was composited `lighter` (additive), which
  on a page that is now mostly white makes a white stroke — the trail simply did not exist below the stage.
  It paints normally, walks its hue inside the brand's band rather than through the spectrum, and both
  thickens and strengthens over something interactive.
- **The console no longer polls.** The responses table polled every 5 seconds, analytics every 10, the
  forms list every 10 and the link table every 15. Four screens open on one form meant four timers per
  browser and a query per timer whether or not anything had changed, and a number that could still be
  fifteen seconds stale. There is now one stream per form, and the screens refetch on its signal. The
  fallback timer only starts when the stream has been reported `offline`.

### Security

- **The test suite refuses to run against a deployment.** `src/env.ts` prefers `APP_DATABASE_URL`, so a
  workspace whose environment points the app at production — which is the normal way to wire one — pointed
  the suite there too: a test run would have created `inicio_test` on that cluster and dropped its schema
  one database over from the real data. `apps/api/test/setup.ts` now resolves both connections and stops
  the run when either host is not this machine, naming the variable to change instead of guessing. Verified
  in both directions: with the deployed URLs it refuses (`MIGRATION_DATABASE_URL points at ep-…neon.tech`),
  and against the local cluster the whole suite is green — 14 files, 103 tests. The production wiring that
  made this necessary is recorded in [DECISIONS.md](DECISIONS.md) D29.
- **Tenancy: the API refuses to serve on a connection that cannot enforce row-level security.** The
  application connects as the least-privilege `app_role`; a superuser or `BYPASSRLS` role is detected
  on boot and, in production, stops the process with a message naming the fix. `APP_DATABASE_URL` now
  names the application's connection explicitly and takes precedence over a hosting platform's
  default, which is normally the owner's connection.

### Fixed

- **The trail's chunk was downloaded by every device, including the ones that would never draw it.** The
  component's own comment — and the README's budget table — promised the decoration was fetched on demand
  "so a device with no fine pointer, which is also the device least able to afford the frames, never
  downloads it". A browser pass over the deployment found the promise false in the least visible way there
  is: `import()` ran wherever the canvas was rendered, the chunk came down and was evaluated, and only then
  did `mountCursorTrail` answer with a no-op handle, because the pointer is a finger. Nothing failed, no
  screen broke, and every phone paid for a trail it cannot see. The gate is now ahead of the fetch
  (`wantsCursorTrail` in `App.tsx`), asking the same two questions the module asks itself; the predicate is
  written twice on purpose, because importing it would put the chunk back on the critical path, and its
  failure mode is one-directional — if the two ever disagree the cost is a fetch that bought nothing, since
  the module still refuses to draw on its own. `apps/web/test/cursor-trail-lazy.test.tsx` counts the mocked
  module's own evaluation, which is the only honest way to ask "was it downloaded?" from jsdom: zero on a
  coarse pointer, zero under reduced motion, zero in a browser with no `matchMedia` at all, and exactly one
  evaluation with exactly one mount where a mouse is present.
  The same pass is how the other half of the claim was established, and how it had to be: headless Chromium
  reports `any-pointer: none`, so the first run "failed" every route by correctly refusing to draw. With the
  browser's own pointer emulation (`--blink-settings=…availablePointerTypes=4,primaryPointerType=4`), all
  seven routes — `/`, `/login`, `/console`, `/terms`, `/privacy` and both token routes — size the canvas to
  its own box (1440×900, not the 300×150 default) and **paint**, with the chunk answered `200`; under
  `prefers-reduced-motion` the canvas is hidden, and now not requested at all.
- **The deployment answered from a database in a different Neon project entirely, and migration `0010` is
  now applied there.** The published summary reported nine migrations where this workspace's production
  connection had ten, and the reason was not a missing migration but two databases: read from each side,
  `18.6 (c021049)` against `18.6 (653b019)`, compute start times two hours apart, and `0010`'s objects present
  on one side and absent on the other. This workspace's Neon project is `proud-field-04065571` (us-east-2);
  the deployment's environment names `cold-leaf-32411407` at `ep-winter-frost-b3ke8cyz` in **ap-southeast-1**,
  database `neondb` — a project this workspace had no key for, which is why the gap could not be closed here
  on evidence alone. Once the hosting project's environment was read through the provider's own CLI, its
  owner connection took `0010` (every earlier migration skipped, one applied), and the result is verified
  from both ends: the deployment's public summary now reports `"migrationsApplied": 10,
  "latestMigration": "0010_api_keys_webhooks_flags.sql"`, and the database itself shows four tables with row
  level security **enabled and forced** and two or three policies each, the four functions the API calls by
  name, sixteen `app_role` grants over `SELECT`/`INSERT`/`UPDATE`/`DELETE`, and the twelve columns and
  indexes the migration adds. Both hosts this repository answers on report the same reading —
  `"migrationsApplied": 10`, `"latestMigration": "0010_api_keys_webhooks_flags.sql"` and
  `"startedAt": "2026-10-14T05:29:45.273Z"`, which is the cold-leaf cluster's own compute start where this
  workspace's database started at `03:10:46Z`; that arithmetic is what makes "the deployment dials *that*
  database" a reading rather than a guess. The routes `0010` is what makes possible were then asked live,
  on both hosts: the scope catalogue with each scope's `enforced` flag, the flag kinds, the event
  catalogue, and an organisation's API keys, webhook endpoints and flag queue with its summary each answer
  `200` to a session minted **in the deployment's own database** and `401` without one — six routes, twelve
  requests. That session was deleted afterwards, and the role serving those routes is `app_role` rather than
  the owner connection, which is the deployment's own tenancy guard passing rather than a hopeful reading.
- **The deployment's console was walked signed in, and the two screens `0010` is what makes usable were
  opened by name.** The earlier walk measured every view at five viewports against the *workspace's* stack,
  and said in writing that the deployment's own screens had not been walked. They have now: a session minted
  in the deployment's database, `/console` measured at 1440×900 and 320×568 across the sidebar's form and
  all four of its views — Builder, Responses & exports, Quality, Distribute — plus the studio's source panel,
  **92/92 checks passed**, no console error, nothing under 12px, nothing overflowing. The Quality tab
  renders its live queue and the Integrations view renders "API keys and webhooks" with the four reads
  behind them answering `200` (`/orgs/:orgId/flags`, `/orgs/:orgId/api-keys`, `/orgs/:orgId/webhooks`,
  `/api/v1/webhook-events`). The harness needed one fix to do it honestly: a signed-in route now waits for
  the workspace to replace the boot screen instead of sleeping past it, because `load` fires while
  "Opening your workspace." is still on screen and the deployment's session and organisation reads put the
  real first paint later than any fixed sleep — twelve "failures" that were a stopwatch measuring a loading
  state. The session was revoked and its audit row removed; the database holds no row the probes added.
- **The live console was walked signed in, and the harness could not have done it.** The scratch browser
  harness set its session cookie with `domain: '127.0.0.1'` hard-coded, so against a deployment it set a
  cookie the deployment never received and every signed-in route quietly measured the *sign-in sheet* — which
  is exactly the kind of pass that reads as a pass. With the domain taken from the target origin, and with a
  wait for the workspace to decide who is there rather than a fixed delay, the walk ran against
  `https://inicio.unifies.codes` with a session minted in the production database: the sidebar lists the real
  form, the form opens on `Builder`, `Responses & exports`, `Quality` and `Distribute`, every per-view check
  holds — colours, overflow, control sizes, console log — and the tallies are **119 checks with 0 failures**
  at 1440 and **119 with 0 failures** at 320. The session was revoked through the deployment's own logout
  route at the end (`204`, then `401` on the next read), so the only trace left is the audit row.
- **The API suite could not run in this workspace at all, and ran anyway.** `test/setup.ts` refuses to run
  when the environment names a database that is not on this machine — a guard that exists so a test run
  cannot drop a schema one database over from real data, and which is doing its job when `APP_DATABASE_URL`
  names a deployment. The correct response is not to weaken it but to point the *three* variables at the
  local cluster for that run, which is what this pass did: 17 files, **150 tests**, green against the
  sandbox's own PostgreSQL 16.2, including the suites migration `0010` is what makes possible. The same run
  covered the rest: engine 55, web 140, lint and typecheck clean.
- **Offline drafts never persisted in a real browser, and the fallback hid it.** Both IndexedDB object
  stores are declared with `keyPath: 'token'`, and `putDraft`/`putCachedForm` also handed the key in as an
  argument. That is a `DataError` the browser raises **synchronously**, before the promise those methods
  return is even created, so every save threw past its caller: the collect page's own error log carried an
  uncaught exception on the first visit, and a respondent's answers survived a refresh only through the
  server. The unit suite could not see it, because it exercises the memory fallback — which implements the
  same interface perfectly — and jsdom has no `put`. Found by a browser pass over `/collect/:token`, fixed by
  dropping the key argument at both call sites, and re-checked there: the route now loads with no page error
  at all.
- **Three layout defects that only exist at 320px.** Measuring every route and every workspace view at five
  viewports (320, 390, 768, 1280, 1440) turned up: the six one-time-code boxes (6 × 46px plus gaps, 316px)
  inside a 272px sign-in sheet, so the code row pushed the sheet sideways on a small phone — each box is now
  a 46px basis that may shrink, with a smaller digit below 640px, and the row measures 206px inside 208px of
  available width; a `<select>` in a flex row cannot shrink below its longest option, because that is a form
  control's automatic minimum size, which made rows in the studio's builder and the console push past the
  panel that clips them — every field may now be narrower than it would like; and a builder question row
  shared one line with three buttons, squeezing its label into a column of single words, so below 640px the
  label takes its own line. Each was verified by measurement, not by eye: the label is 240px wide where it
  was 54px.
- **Two controls a finger could not hit.** The landing page's navigation links were 22px tall — two pixels
  under the 24px a target needs — and the same pass measured a text link to the sign-in page at 15px. The
  nav links keep their appearance and gain padding taken straight back off with a negative margin; the inline
  link inside a sentence is exempt by the standard's own wording and is now reported rather than failed. The
  template cards' metadata line was set at 11.5px and is 12px, which is the floor this product holds its
  copy to.
- **The README's roadmap listed CI as outstanding while the same document enforced it.** "CI on every push"
  and "Accessibility and performance budgets" sat unchecked under *Next, in order* — and the README's own
  *Enforced on every push* table, a few screens above, already runs lint, typecheck, the whole suite against
  a real PostgreSQL 16, the build, the byte budgets, the renderer-split assertion, 23 measured colour pairs
  and `axe-core` on every push, before both end-to-end harnesses. Two entries in a list of what is *next*
  were also simply done. The checklist now separates what is enforced today (moved up to *shipped*) from
  what genuinely is not: **backups and a rehearsed restore**, file uploads and `.sav`/`.dta` (both built
  since, and moved up), a WCAG 2.2 AA
  audit by a person with a screen reader, the Lighthouse budget that is still deliberately empty, and the
  drag-and-drop builder. The counts were stale in the same pass — 253 tests to 256, of which `apps/web`
  went from 95 to 98 when the reveal test for the template cards landed.
- **The template cards on the landing page were invisible.** The reveal is an `IntersectionObserver`
  built once when the page mounts, observing the markup that exists at that moment — and the three
  template cards are rendered from the `/api/v1/public/summary` response, which arrives after. Nothing
  ever observed them, so they kept the hidden state the reveal class applies: measured in a browser
  against the deployment, all three were `opacity: 0`, translated 26 px down, and un-revealed for every
  visitor, whatever they scrolled. The effect now watches its own subtree and adopts anything that
  appears later, so "reveal on first sight" is true for fetched content and not merely for the markup
  that happened to mount with the page. Held by `apps/web/test/landing.test.tsx`, whose observer stub
  now records what it was handed — the earlier stub revealed whatever it was given, which is exactly why
  it could not see a card nobody handed to it.
- **Every animated headline rendered as one long word.** The landing page's reveal gives
  each character its own box so the letters can stagger in, and a box is exactly what the
  sentence cannot survive: the browser will end a line after any atomic inline, and an
  inline-block holding a bare space collapses to no width — so "Start from a real instrument"
  was on screen as "Startfromarealinstrument" with the word broken as `instrumen` / `t`, and
  a comma began a line. The split is now word-first: a word is one unbreakable box holding a
  box per character, and the spaces between words are boxes that keep their width and stay
  breakable. A second defect was hiding behind it — the effect that splits runs twice in
  development (StrictMode), and a second pass over already-split markup wrapped every
  character box in a word and a box of its own, which measured as a 16-character sentence
  reporting 17 "words"; the split is now idempotent. Measured in a real browser at 1440 px
  and 390 px: adjacent words are 7.31 px and 4.19 px apart at those widths, no word straddles
  two lines, every headline reconstructs into its sentence, and there is no sideways scroll.
  Held by `apps/web/test/landing.test.tsx`, which asserts the structure, the two stylesheet
  declarations that keep the sentence laid out, and a StrictMode mount that must not nest.
- **The sign-in screen said codes could not be sent, and it was telling the truth about the relay.**
  The deployment was configured for SMTP at `localhost:1025` — a relay that is not there — so the
  honest verdict on the sign-in page was "cannot be sent right now". Mail now goes out over the
  provider's HTTPS API, which is the transport this project already preferred for exactly this
  reason, and the sentence is driven by evidence rather than by hope: `mailStatus()` reports a
  probe or a message the relay actually accepted, and the page stays quiet when there is nothing
  honest to say yet. Verified by driving `POST /api/v1/auth/otp/request` through the real relay
  (the provider returned a message id, `email_log` recorded `sent`, one live code was stored, and
  the code itself is never echoed to the client).
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
- **The liveness test for the public summary failed on CI, on a correct answer.** It asserted that the
  two reads reported *different* round trips, but `latencyMs` is deliberately rounded to 1/100 ms, and
  two quick reads can legitimately land on the same figure — they did, at 0.51 ms. A test that fails on
  the truth is worse than no test, because the honest response to it is to weaken it. The assertion now
  rests on the database's own clock instead: `now()` is read in the request that serves the answer, at
  millisecond resolution, so two reads 25 ms apart must report a later instant, and a remembered value
  cannot fake that. The latency is still asserted to be a real measurement; it just no longer carries an
  assertion it cannot hold. Re-run five times locally, green each time.
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
- **Every headline on the landing page was invisible to a light-mode visitor.** `styles.css` styles
  `h1, h2, h3, h4` globally with `color: var(--text)`, and the console's `--text` is `--ink` — near-black —
  whenever the operating system asks for a light colour scheme. The landing page's headings inherited it:
  near-black type on a near-black ground, for that half of visitors, and invisible in the screenshots taken
  in a light-scheme browser for exactly the same reason. The landing now declares the colour of its own
  headings and inherits from the material each one is printed on — white on the stage, ink on the sheets.
  Found by reading the *computed* colour in a real browser at five viewports, which is the only place it
  shows up, and now held by `contrast.test.ts`, which asserts both the leaking rule and the declaration
  that answers it.
- **The API suite could send real email, and asserted against whatever transport the machine had.** A
  workspace `.env` holds a live provider key, because that is how the deployment sends mail, and
  `selectTransport` prefers a key over SMTP — so the suite really did send login codes to the provider over
  `fetch`, and two tests failed on a machine with a key while passing in CI. The mail verdict reported
  `last-send` (the provider accepting a message) where the test was asserting the SMTP probe, and the
  webhook receiver's capture held the provider's own HTTP call as well as the delivery under test.
  `apps/api/test/setup.ts` pins `MAIL_TRANSPORT=smtp` for the whole suite, which makes both deterministic
  and makes a real send impossible; the provider path is tested where it belongs, by injecting a sender in
  `mail-https.test.ts`. Verified with the key present: 16 files, 126 tests, green — and the two failures
  were reproduced in both directions before and after the pin.
- **`pnpm lint` failed on a scratch directory.** The ignore pattern was `.run/**`, which matches the root
  only, so a throwaway browser harness written in `apps/api/.run/` was linted as if it were source and
  failed the run over `document` and `fetch`. It is `**/.run/**` now, which is what the comment above it
  already claimed. The two errors it had been hiding in real source are fixed with it: an unnecessary
  escape in `safeFilename`'s leading-dot strip, and an unused constant in the attachments suite.

### Not done

- **The rest of Phase 0 of the product requirements document.** The foundation work was read off the
  requirements document and the deployment rather than assumed, and what remains is listed here rather than
  implied by the entries above: **backups** (a 6-hour encrypted cadence and a rehearsed restore; nothing is
  configured and no restore has been rehearsed), a **public status page**, the **manual WCAG 2.2 AA audit**
  with a screen reader and a keyboard (axe-core runs in CI, which is not the same thing), the **Lighthouse
  budget** (`pnpm budgets` holds the shipped bundle to byte ceilings; nothing measures a real device's paint),
  and **CAPTCHA plus disposable-domain screening** on the public entry points. Backups and the status page need
  infrastructure and a provider decision rather than code, the audit and the budget need a person and a running
  deployment, and the last needs a provider chosen with the same care as the mail relay.
- **The N-deep outbox.** It was asked for alongside the two features above, and it is **not implemented**. The
  device's queue is still one deep, so a device collecting for a week still keeps one response in flight at a
  time, and a held file is still retried only while the page stays open. This release says so here rather
  than letting two finished features imply a third, and it says *why*, because that is worth more than a
  half-built queue in the one part of the product whose entire promise is that nothing typed is lost. The
  depth is a property of how a response is **keyed** on the device: `offline/types.ts` keys a `StoredDraft`
  by the distribution token, so one link holds one response, and the queue's operations (create, save,
  submit) belong to that one draft. Holding N pending responses therefore changes the store's shape, the
  migration of whatever is already on a respondent's device, the collect flow that drives it and `runSync`
  — and any one of those going wrong loses answers somebody watched being saved. It is the next item in
  [docs/ROADMAP.md](docs/ROADMAP.md) §5, with the same reasoning attached.

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
