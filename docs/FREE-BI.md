# A free-forever BI path: Apache Superset

**Status:** implemented, unit-tested against a mock Superset, not yet exercised against a live
Superset container in this workspace (there is no Docker daemon here).

This document is the research record behind the free reporting path. It answers a narrower
question than "which BI tool is good": which BI tool can Inicio use **without a licence, a seat
count, a report cap or a paid security feature**, and what does it honestly cost to run?

## The short answer

Use **Apache Superset 6.1.0**, self-hosted.

- The software is **Apache-2.0**. There is no seat licence, no report limit, no per-viewer
  charge and no paid row-level-security gate.
- Row-level security, embedding, CSV upload and the REST API are in the open-source build.
- It runs on a single Docker host and has images for `linux/amd64` and `linux/arm64`.
- The repository now ships a pinned compose stack in [`docker/superset`](../docker/superset)
  and an idempotent provisioning command, `pnpm superset:provision`, that uploads the monitor
  CSV and creates the charts and dashboard through Superset's API.

The honest qualification: **the licence is free forever; the server is not included.** A
self-hosted Superset needs a machine, storage, backups and somebody to apply upgrades. If you
already have a server, the cash cost is zero. If you rent one, that is an operating cost no
open-source licence can remove. The rest of this document separates those two numbers instead
of calling the whole thing free.

## What "free forever" was taken to mean

A platform passed only if all of these were true:

1. **No licence that can expire.** A perpetual open-source licence, or a free tier with no
   ending date, not a trial.
2. **No mandatory paid tier for the thing Inicio needs.** A free product whose row-level
   security, embedding, scheduled delivery or API is paid does not pass, because the first
   tenant that needs that feature is the end of "free".
3. **No seat or report cap that a real survey programme will hit.** "Two users and 10,000
   rows" is a demo, not a reporting platform.
4. **Data can stay private.** A free product that makes every dashboard public is not usable
   for survey responses.
5. **A machine can create the report.** The work has to be reproducible from the repository,
   not a sequence of screenshots in a vendor UI.
6. **The total cost is understood.** Software cost and hosting cost are reported separately.

The first four are licence questions. The last two are engineering questions, and they are
where several "free" tools failed.

## Research plan

The research was run in this order, against primary sources rather than listicles:

1. **Build the shortlist.** Start from open-source BI projects with a current release and a
   real dashboard product, then add the free managed tiers that people actually recommend.
2. **Read the licence and the pricing page together.** A repository's `LICENSE` answers what
   the code is; the vendor's pricing and feature pages answer what the hosted or "Pro" product
   puts behind a paywall. Both matter.
3. **Check the four capabilities that decide the answer:** row-level security, embedding,
   scheduled delivery/export, and a report-creation API.
4. **Check the deployment shape.** Does it need Kubernetes, dbt, a JVM, a separate worker, or
   simply a container and a Postgres? What is the smallest credible host?
5. **Check the host, not just the software.** A free trial that expires, a database that is
   deleted after 30 days, or a free instance that is reclaimed when idle is not a free-forever
   reporting platform.
6. **Fit it to Inicio's actual data path.** The monitor already produces a tidy CSV of every
   plotted value. Prefer a path that consumes that file over one that needs a new database
   role, a production credential or a bypass of the tenant RLS boundary.
7. **Implement and test the narrowest real path.** Upload the CSV, create the dataset, create
   the dashboard, re-run it without duplicating anything, and unit-test the HTTP contract.
8. **State what could not be verified.** This workspace has no Docker daemon and no Superset
   instance, so the live-container claim is not made.

## The shortlist

Prices and licences were checked on 3 November 2026. A vendor can change a price; the licence
and the architecture are the parts that decide whether a path is durable.

| Platform | Licence / free offer | What the free path actually gives you | Why it did or did not win |
|---|---|---|---|
| **Apache Superset** | Apache-2.0; software free | No seat/report cap; row-level security, embedding, CSV upload and REST API in the open-source build | **Chosen.** The only candidate that met every mandatory requirement without a paid feature gate |
| Metabase OSS | AGPL-3.0; open-source edition free | Unlimited users and a very usable question/dashboard builder; row-level permissions and data sandboxing are Pro/Enterprise; interactive embedding is paid | Strong second. The security feature a multi-tenant product needs is the paid one |
| Lightdash | MIT core; self-host free | BI on top of a dbt project; embedding and scheduled delivery are paid; self-host documentation is Kubernetes/Helm-shaped | Rejected: adds dbt and Kubernetes to the operating cost before the first dashboard |
| Grafana OSS | AGPL-3.0; self-host free | Excellent metrics and logs dashboards; no row-level security in the open-source build; scheduled PDF reports are Enterprise | Rejected: designed for time series, not survey tables, and the tenant boundary is missing |
| Redash | BSD-2-Clause; self-host free | Query and dashboard tool with a long history; no row-level security; a long security-advisory history | Rejected: no tenant boundary and too much security upkeep for a reporting copy |
| Evidence | MIT core; self-host free | Code-first, static BI reports; self-host has no built-in authentication or row-level security; embedding is a paid Studio feature | Rejected: beautiful reports, but no safe multi-tenant serving story in the free build |
| Looker Studio | Proprietary; free tier | Free private reports and a familiar Google front end; Pro is a per-user, per-project subscription; no API for creating reports | Rejected: not open source, not automatable, and the free tier is a product decision Google can change |
| Tableau Public | Proprietary; free | A free Tableau workbook, but every workbook is public, capped at 15 million rows, and extract-only | Rejected outright: survey data cannot be public |
| Zoho Analytics | Proprietary; free plan | 2 users, 5 workspaces and 10,000 rows on the free plan | Rejected: the caps are below a real programme, and the free plan is not a licence to self-host |
| Power BI / Fabric | Proprietary | 60-day trial; publishing private reports needs Pro or PPU; viewing without a per-user licence needs F64 capacity | Rejected: there is no free-forever publish path for private reports |

### The capability table

`Yes` means the capability is in the free/open-source build, not merely in a screenshot of the
paid product.

| | No seat/report cap | Row-level security | Embedding | Automatable report API | Self-host without Kubernetes | Verdict |
|---|:---:|:---:|:---:|:---:|:---:|---|
| Apache Superset | Yes | Yes | Yes | Yes | Yes (Docker) | **Chosen** |
| Metabase OSS | Yes | No (Pro) | No (interactive is Pro) | Yes (where the feature is free) | Yes (JVM) | Close second |
| Lightdash | Yes | Depends on the dbt model | No (paid) | Yes | No (Helm/K8s documented) | Too much platform |
| Grafana OSS | Yes | No | Partial | Partial | Yes | Wrong data shape |
| Redash | Yes | No | Partial | Yes | Yes | Security risk |
| Evidence | Yes | No | No (paid) | Static build | Yes | No auth in self-host |
| Looker Studio | Free tier | No true RLS | Limited | **No report-creation API** | n/a (SaaS) | Not automatable |
| Tableau Public | Public only | n/a | Public only | No | n/a (SaaS) | Confidentiality fails |
| Zoho Analytics | 2 users / 10k rows | Paid tiers | Paid tiers | API, within caps | n/a (SaaS) | Caps fail |
| Power BI / Fabric | No free publish path | Yes (model) | Capacity required | Fabric APIs, capacity required | n/a (SaaS) | No free-forever path |

"Partial" means the capability exists but not in the form this product needs, or only through a
paid add-on; it is not a recommendation.

## Why Superset, specifically

The decision is not "Superset is the best BI product". It is "Superset is the best fit for the
constraint the request set".

1. **The licence cannot end.** Apache-2.0 is perpetual and irrevocable for the code you have.
   There is no "free for 14 days", no "free up to five users", and no feature that becomes paid
   after the data is already in it.
2. **The tenant feature is not paywalled.** Superset's row-level security is part of the
   Apache build. Metabase's equivalent is a Pro/Enterprise feature, which is the difference
   between a free path and a free trial of the path.
3. **The API is real.** Superset exposes the database, dataset, chart and dashboard endpoints
   used by `scripts/superset-provision.mjs`. Looker Studio, by contrast, has no API for
   creating a report, so "automate it" would mean driving a browser.
4. **It consumes a file, not a production credential.** The command uploads the monitor CSV to
   a separate `inicio_bi` database. It does not connect Superset to the application's primary
   database, does not create a BI role that can bypass RLS, and does not put an application
   credential in a second service.
5. **It fits on a small host.** The pinned images are available for `linux/amd64` and
   `linux/arm64`, which matters because Oracle's Always Free Ampere shape is ARM. There is no
   Kafka, no Kubernetes and no dbt project in the path.
6. **The escape hatch is real.** SQL Lab and the REST API mean the data is not trapped behind
   a proprietary file format; the metadata lives in Postgres, and the CSV remains exportable.

### What is still not free

The software is free. These are the costs that remain:

| Cost | What it means in practice |
|---|---|
| **Compute** | The full stack is comfortable on roughly 4 vCPU / 8 GB; a small single-host install can run in 2 vCPU / 8 GB, but the first dashboard build and a metadata upgrade are the moments it will feel tight |
| **Storage and backups** | Postgres holds both the Superset metadata and the `inicio_bi` snapshot. It needs a volume and a backup routine; a Docker volume is not a backup |
| **TLS and a proxy** | The compose stack listens on HTTP. Exposing it beyond localhost without a TLS reverse proxy would put an admin password and session cookies on the wire |
| **Operator time** | Upgrades, image pinning, Postgres backups, password rotation and monitoring are real work. This is the cost that "free" reports usually omit |
| **A durable host** | Home hardware or an existing server is the genuinely $0 option. Rented always-free compute has conditions (see below) |

#### The Oracle Always Free caveat

Oracle's [Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
include the first 1,500 OCPU-hours and 9,000 GB-hours per month of `VM.Standard.A1.Flex`, which
for an Always Free tenancy is **2 OCPUs and 12 GB of memory**, plus 200 GB of block storage.
That is enough for this stack if the snapshot is modest. Two things must be said in the same
breath:

- The instances must be created in the tenancy's **home region**, and "out of host capacity"
  is a normal error when the free shapes are full.
- **Oracle may reclaim an idle Always Free instance.** Its published test is CPU utilisation
  below 20%, network utilisation below 20%, and (for A1) memory utilisation below 20% over a
  seven-day period. A reporting dashboard that nobody opens for a week can meet that test. A
  reclaimed host is not a data-loss bug in Superset, but it is not a "free forever, always
  available" promise either.

So the accurate statement is: **Superset is free forever; Oracle's free host is free with an
idle-reclamation condition.** If that condition is unacceptable, use a server you control, or
pay for a small VPS. No amount of licence research changes the hosting bill.

Other free tiers checked and rejected for a durable deployment: Render's free Postgres is
time-limited (30 days), Fly.io no longer has a general free tier, Railway's free allowance is a
small monthly credit rather than a free service, and Koyeb's free path requires a card and is
not sized for a Postgres + Redis + Superset stack. GitHub Pages and Cloudflare Pages are static
hosts and cannot run Superset.

## What was built

```text
                       ┌──────────────────────────────┐
                       │  Inicio · Live monitor       │
                       │  Export every table (.csv)   │
                       └──────────────┬───────────────┘
                                      │ tidy CSV (one row per plotted value)
                                      ▼
                       ┌──────────────────────────────┐
                       │  pnpm superset:provision     │
                       │  login → CSRF → upload →     │
                       │  dataset → charts → dashboard│
                       └──────────────┬───────────────┘
                                      │ Superset REST API
                                      ▼
┌─────────────────────────────────────────────────────────────────┐
│  docker/superset                                                │
│                                                                 │
│  Superset 6.1.0 ── Redis (cache)                                │
│       │                                                         │
│       └── PostgreSQL 16                                         │
│             ├── superset     (metadata: users, charts, dashboards)│
│             └── inicio_bi    (CSV snapshot table)               │
└─────────────────────────────────────────────────────────────────┘
```

### Files

| File | Role |
|---|---|
| `docker/superset/docker-compose.yml` | Pins `apache/superset:6.1.0`, Postgres 16 and Redis 7; waits for healthy dependencies |
| `docker/superset/superset_config.py` | Metadata URI, Redis caches, CSRF, proxy fix, no paid feature flags |
| `docker/superset/bootstrap.py` | Idempotently creates the admin and the **Inicio BI** database connection with uploads enabled |
| `docker/superset/entrypoint.sh` | Runs `superset db upgrade`, `superset init`, the bootstrap, then the server |
| `docker/superset/init/01-bi-db.sql` | Creates the separate `inicio_bi` database on first boot |
| `docker/superset/env.example` | The values to put in the gitignored `.env` |
| `scripts/superset-provision.mjs` | CSV validation, stable slugs/UUIDs, REST login/CSRF/upload/chart/dashboard upsert |
| `scripts/superset-provision.test.mjs` | 10 tests: CSV parsing, plan determinism, layout, API bodies, multipart auth, second-run idempotency, secret redaction |

### Start the stack

```bash
cd docker/superset
cp env.example .env
openssl rand -hex 32        # paste into SUPERSET_SECRET_KEY
# edit .env: set SUPERSET_DB_PASSWORD and SUPERSET_ADMIN_PASSWORD
docker compose up -d
docker compose ps
```

The first start runs the Superset migrations and can take a couple of minutes. Open
`http://localhost:8088` and sign in with `SUPERSET_ADMIN_USER` / `SUPERSET_ADMIN_PASSWORD`.
The connection named **Inicio BI** is already there, with file uploads enabled.

The port is bound to `127.0.0.1` by default, so a cloud VM does not publish an HTTP admin
login to the internet on first boot. On a remote host, reach it through an SSH tunnel
(`ssh -L 8088:127.0.0.1:8088 user@host`) or put a TLS reverse proxy on the same host and
point it at `127.0.0.1:8088`. Set `SUPERSET_BIND_ADDRESS=0.0.0.0` only when a network-level
control already protects the port; changing that line without TLS is how a local demo
becomes somebody else's login page.

Use a URL-safe password (letters and digits are enough). Both the metadata URI and the BI URI
are assembled in `docker-compose.yml`, so a password containing `@`, `:`, `/` or `#` must be
percent-encoded. The simplest safe choice is a long alphanumeric value.

The stack runs one Superset web process. It does not start a Celery worker or beat process,
because alerts, scheduled reports and thumbnails are not enabled. That is intentional: those
are the features that make the upstream compose stack large, and none of them is needed for a
manually refreshed reporting snapshot.

### Provision the dashboard

1. Open the form's **Live monitor** tab.
2. Choose **Export every table (.csv)**.
3. From the repository root, point the command at that file:

```bash
SUPERSET_PASSWORD='the admin password' \
  pnpm superset:provision -- \
  --csv ./inicio-monitor.csv \
  --title 'Inicio live monitor' \
  --slug inicio-live-monitor \
  --table inicio_monitor_live
```

The stack's bootstrap has already created **Inicio BI**, so no database URI is needed. The
command finds the connection by name and enables CSV upload on it. If you are using an existing
Superset instead, pass `--database-uri` (or `SUPERSET_BI_DATABASE_URI`) and, if the connection
does not exist, it will be created.

Preview without making a request:

```bash
pnpm superset:provision -- --csv ./inicio-monitor.csv --dry-run
```

The dry run prints the table name, chart count, row count, question count and submitted total.
It does not contact Superset and does not need a password.

### What the first dashboard contains

The command creates three objects, all keyed by stable UUIDs and a stable slug:

- **Submitted responses** — a big-number card using `MAX(submitted)` (the snapshot's base).
- **Answerable questions** — a big-number card using `COUNT_DISTINCT(question_name)`.
- **Monitor tables** — every plotted value, with the question, the chart family, the answered
  and missing counts and the share denominator.

It is deliberately the stable core rather than a pile of generated chart payloads. Superset's
chart JSON is version-sensitive; the table, big-number and dashboard endpoints are the ones
this command can guarantee. The table is the complete monitor data, so additional visuals can
be added in Superset's UI without re-exporting anything, or the command can grow more chart
types as those payloads are verified against a live instance.

Re-running with the same `--title`, `--slug` and `--table` replaces the snapshot table and
updates the charts and dashboard in place. Changing the title without changing the slug creates
a second dashboard, which is why the example passes an explicit stable slug.

## Data and security boundaries

### What the snapshot contains

The CSV is the same tidy export the monitor's **Export every table** button writes. It has one
row per plotted value, with `question_id`, `question_name`, `question_label`, `question_type`,
`chart`, `group`, `answered`, `missing`, `submitted`, `table`, `row`, `value`, `count` and
`share_percent`.

It is an **aggregate snapshot**, not a raw response export. But "aggregate" is not a synonym for
"anonymous": for a text question, the `value` column can contain a frequently repeated free-text
answer. Treat the CSV and the `inicio_bi` database as sensitive. If a form collects identifying
free text, do not publish its Superset dashboard, and consider removing or redacting text rows
before provisioning. The monitor's small-cell disclosure rules are a separate topic; this
document does not claim that an aggregate is safe to publish.

### Why not connect Superset to the application database?

That path would be more "live", but it would require a new database role, a decision about
whether that role can see every tenant, and a way to apply the tenant context for each viewer.
A BI tool that reads the primary database directly must either bypass RLS or reproduce the
application's tenant model. The upload path avoids both: Superset holds a copy of the rows the
monitor already showed, and the application's RLS boundary is untouched.

The trade-off is freshness. **The Superset dashboard is a snapshot, not a live view.** The Inicio
monitor is live; reprogram the dashboard after exporting a new CSV. If live BI is required,
connect Superset to a read replica with a dedicated read-only role and implement RLS in
Superset, and treat that as a separate security review. Do not point it at the primary with the
owner role.

### Hardening before exposing it

The compose file is a single-host starter, not a production-hardened deployment. Superset's own
documentation says its compose constructs are not supported for production. Before putting it
on a network:

- Put a TLS reverse proxy in front of port 8088 and do not publish 8088 to the world.
- Set `SUPERSET_COOKIE_SECURE=true` and `SUPERSET_TALISMAN_ENABLED=true` (and configure the
  proxy's forwarded headers) once HTTPS is in place.
- Keep `SUPERSET_SECRET_KEY` stable and secret. Rotating it invalidates sessions; losing it
  breaks encrypted values in the metadata database.
- Back up the Postgres volume. At minimum:

  ```bash
  docker compose exec -T db pg_dump -U superset superset > superset-metadata.sql
  docker compose exec -T db pg_dump -U superset inicio_bi > inicio-bi.sql
  ```

  A Docker volume is not a backup. Store these somewhere else and test a restore.
- Pin the image by tag for now; for a stricter deployment, pin by digest and review Superset
  release notes before changing it.
- Keep the `.env` file out of Git. It is ignored by the repository; `env.example` is the only
  committed template.
- Do not reuse the application database password. The stack creates its own Postgres user and
  its own two databases.

## What was verified, and what was not

Verified here:

- `node --test scripts/superset-provision.test.mjs` — **10/10**. The tests parse quoted CSV,
  prove the plan is deterministic, check stable UUIDs and grid layout, build the chart and
  dashboard payloads, exercise multipart login/CSRF/upload against a local mock, prove a second
  run updates rather than duplicates, and prove the password is redacted from errors.
- `apache/superset:6.1.0` publishes both `linux/amd64` and `linux/arm64` manifests.
- The Superset API contracts used by the command were checked against the official
  documentation: CSV upload (`POST /api/v1/database/:pk/upload/` with `file`, `table_name`,
  `type=csv`, `already_exists=replace`, `schema`), chart creation, dashboard creation and the
  v2 dashboard position schema.

Not verified here:

- **A live Superset container.** This workspace has no Docker daemon (`command -v docker`
  returned nothing), so the compose stack was not started and the command was not run against
  a real Superset. The HTTP client is tested against a mock that follows the documented
  contracts, not against the pinned image.
- **A production host.** No Oracle account, domain or TLS certificate was used.
- **A real Power BI/Fabric tenant.** That is the separate, paid path documented in
  [`POWER-BI.md`](./POWER-BI.md); this document does not claim a Fabric deployment.

The first live run should be treated as a smoke test: start the stack, provision the CSV, open
the dashboard URL the command prints, and check that the three charts render. If an endpoint
rejects a payload, the command surfaces the service's own message; a payload that is accepted
but renders incorrectly would only be caught by that visual check, which is one reason the image
is pinned. The pinned version is the version to test against.

## Sources

Primary sources read for this decision:

- Apache Superset — [licence](https://github.com/apache/superset/blob/master/LICENSE.txt),
  [releases](https://github.com/apache/superset/releases),
  [Docker Compose installation](https://superset.apache.org/admin-docs/installation/docker-compose/),
  [security/RLS](https://superset.apache.org/admin-docs/6.1.0/security/),
  [CSV upload API](https://superset.apache.org/developer-docs/api/upload-a-file-to-a-database-table/),
  [import/export](https://superset.apache.org/admin-docs/configuration/importing-exporting-datasources/)
- Metabase — [licence](https://www.metabase.com/license),
  [paid features](https://www.metabase.com/paid-features),
  [pricing](https://www.metabase.com/pricing)
- Lightdash — [self-hosting](https://docs.lightdash.com/self-host/self-host-lightdash),
  [pricing](https://www.lightdash.com/pricing)
- Grafana — [licence](https://raw.githubusercontent.com/grafana/grafana/main/LICENSE)
- Redash — [repository](https://github.com/getredash/redash)
- Evidence — [self-hosting](https://docs.evidence.dev/self-host)
- Looker Studio — [free product](https://cloud.google.com/data-studio),
  [Pro subscription](https://docs.cloud.google.com/data-studio/pro-subscription-overview)
- Tableau Public — [FAQ](https://help.tableau.com/current/pro/desktop/en-us/public_faq.htm)
- Zoho Analytics — [pricing](https://www.zoho.com/analytics/pricing.html)
- Microsoft Fabric — [licensing](https://learn.microsoft.com/en-us/fabric/enterprise/licenses)
- Oracle Cloud — [Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)

## The one-line recommendation

If the requirement is **no payment and no licence that can expire**, self-host Apache Superset
on a machine you already have. If the requirement is **no payment and no server to operate**,
no platform in this research meets it without a cap, a public-data rule or an idle-reclamation
condition; choose the constraint you can actually live with.
