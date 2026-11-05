# Live monitoring and the Power BI handoff

This document records the reporting surface, the standards it follows, and the boundary
between what this repository can generate and what Microsoft requires a desktop or a
Fabric tenant to generate. If the requirement is a **free-forever licence with no
Microsoft tenant**, the self-hosted Superset path is documented separately in
[`FREE-BI.md`](./FREE-BI.md); it is the alternative that does not need a Power BI
licence, and it makes the snapshot-versus-live trade-off explicit.

## What is live

Each form has a **Live monitor** tab. It reads `GET /api/v1/forms/:formId/analytics`,
which computes every count from the live tables on every request and sends
`cache-control: private, no-store`. The browser subscribes to the form's server-sent
event stream and refetches only the `analytics` aggregate when it moves. While that
stream is live, the fallback timer is not armed. When the stream drops, the screen says
so and refreshes every 30 seconds until it returns.

The monitor does not keep a report snapshot, a materialised aggregate or a separate
reporting table. A submitted answer is visible on the next revision tick, which is
1.5 seconds.

Every answerable question is shown, including one with no answers yet. For every
question chart, the base is the number of submitted responses. A missing count is a
submitted response with no value for that field. The API reports answered responses as `count(DISTINCT
response_id)`, never as `sum(tally)`: a tally is a value, and a multi-select's array is
one value holding several mentions. The respondent count is the only safe denominator,
and it is what makes a missing count a fact rather than an inference. A note, a
calculated field and a hidden audit field are not answerable and are counted as omitted
rather than silently dropped.

The chart type is chosen from the question type:

| Question family | Monitor visual | The rule it follows |
|---|---|---|
| Single select, yes/no, enumerator | Horizontal bars | Bars compare categories; no pie or donut |
| Multi select, rank | Horizontal bars | Each share is the percentage of respondents who selected that option; totals can exceed 100% and the screen says so |
| Integer, decimal, percentage, currency | Histogram, mean, median, min and max | Distribution before a single average |
| Date, datetime | Daily line | One point per day; the table retains every day |
| Geopoint, geotrace, geoshape | Latitude and longitude plot | No basemap is implied; overlapping points keep a count |
| Text, textarea | Top-value bars plus a distinct count | Long free text is not treated as a category without saying so |
| File, image, audio, video | Count | A media answer is a presence, not a scale |
| Barcode | Horizontal bars | The scanned code is a value, so it is charted, not counted as a file |

## The Power BI report plan

The monitor downloads a deterministic `power-bi-plan.json`. It contains:

- the form title and language;
- the live endpoint and the SSE revision tick;
- a 1280 x 720 canvas on an 8 px grid;
- the brand theme values, including the four primary text classes;
- DAX measures for started, submitted, completion, open, median completion and conflicts;
- one visual per answerable question, with its field, visual type and query roles;
- the exact limitations, so the file cannot be mistaken for a PBIX.

The plan follows the parts of Microsoft's guidance that are testable: top-left is the
highest-level number, there is one dominant accent, KPI cards carry context, there are
no 3D or circular charts, the canvas has no scrollbars at 1280 x 720, chart colour is
never the only signal, and a measure returns BLANK rather than a fabricated zero when
there is no meaningful value.

## The PBIX boundary

The repository does **not** generate a `.pbix`. That is not an omission in the code.
Microsoft states that converting between PBIX and PBIP is a Power BI Desktop operation,
not a programmatic one. Generating a model-bearing PBIX on Linux would mean
reimplementing the proprietary report and VertiPaq container formats.

The evidence:

- [Power BI Desktop projects overview](https://learn.microsoft.com/en-us/power-bi/developer/projects/projects-overview):
  "Can I convert PBIX into PBIP and vice-versa programmatically? No. You can only
  convert ... using Power BI Desktop's File > Save as."
- [pbi-tools feature matrix](https://pbi.tools/cli/feature-matrix.html): the Linux-capable
  Core edition compiles **report-only** PBIX and produces PBIT when the project carries
  a semantic model. It cannot produce a model-bearing PBIX.
- [Fabric report definition API](https://learn.microsoft.com/en-us/rest/api/fabric/articles/item-management/definitions/report-definition):
  PBIR report JSON can be deployed as an item definition, but that is a Fabric item
  deployment, not a local PBIX file.
- [Power BI embedded capacity](https://learn.microsoft.com/en-us/power-bi/developer/embedded/embedded-capacity):
  production embedding requires a capacity, a service principal, admin-enabled tenant
  settings and workspace membership.
- [Push dataset limits](https://learn.microsoft.com/en-us/power-bi/developer/embedded/push-datasets-limitations):
  a push model can receive live rows, but it has a 1,000,000 rows per hour ceiling, a
  200,000 row FIFO retention default, a 75-column limit and does not work with service
  principal profiles.
- [Real-time streaming in Power BI](https://learn.microsoft.com/en-us/power-bi/connect-data/service-real-time-streaming):
  streaming datasets do not store history and cannot be modelled. New streaming models
  are not being created after 31 October 2027. Fabric Real-Time Intelligence is the
  forward path.

The tenant, capacity, workspace and artifact requirements are in
[Deploying to Fabric](#deploying-to-fabric). Until those exist, a `.pbix` button would
either produce a stale snapshot or a file Power BI cannot open. The monitor and the
plan are the honest first delivery.

## The questionnaire-to-PBIP generator

The repository also ships a reusable generator, `scripts/build-powerbi-report.mjs`
(`pnpm powerbi:report`), so the five examples in `reports/power-bi` are not a fixed
catalogue. It accepts any questionnaire and writes a complete Power BI Project:

```bash
pnpm powerbi:report -- --docx ./questionnaire.docx --code ACME --project-number 1612
pnpm powerbi:report -- --definition ./form.json --code ACME
pnpm powerbi:report -- --all ./questionnaires --out ./reports/power-bi
pnpm powerbi:report -- --manifest ./studies.json
```

A `.docx` goes through the same DOCX compiler described in the root README and becomes the
canonical `FormDefinition`; a JSON input is used directly. `analyzeDefinition()` then derives
everything the report states from that definition: section volume, answerable and required
counts, routing anchors, validation constraints, choice load, a planning-burden heuristic,
question types and an analysis family for every question. There is no branch keyed on a
study name and no per-questionnaire page code. The same seven-page composition is rebuilt
for every input.

### What the project contains

- **`.pbip`** — the project shortcut that Power BI Desktop opens.
- **`.Report`** — PBIR report definition: seven pages, 142 visuals, page and visual schemas,
  the base Fluent2 theme, and the `Inicio Research Intelligence` custom theme.
- **`.SemanticModel`** — TMDL model with ten tables, seven relationships and twenty DAX
  measures. Questionnaire rows are embedded with Power Query `#table`; the model opens
  without a gateway, a file path parameter or a refresh credential.
- **`report-manifest.json`** — machine-readable counts, page ids, model summary and the
  evidence boundary.
- **`README.md`** — the study-specific opening instructions and the empty-response warning.

The pages are: `00 Cover`, `01 Executive read`, `02 Instrument architecture`,
`03 Routing & quality`, `04 Analysis blueprint`, `05 Question atlas` and
`06 Fieldwork readiness`. The visual grammar is deliberately editorial rather than the
Power BI default: warm paper, a dark cover, Georgia display type and a burnt-sienna, teal,
ocher and plum palette. The page canvas is fixed at 1280 × 720, so the report itself never
scrolls sideways; a long table may scroll inside its own visual.

### The response boundary

`Responses` and `Answers` always carry their schema. They carry **zero rows** unless real
CSV files are passed with `--responses` and `--answers`. The cover, the readiness page and
the manifest all state that no respondent data is present. This is what keeps a design
dossier from being mistaken for a fieldwork finding:

```bash
pnpm powerbi:report -- \
  --docx ./questionnaire.docx --code ACME \
  --responses ./responses.csv --answers ./answers.csv
```

The expected columns match the model: `ResponseId`, `Status`, `StartedAt`, `SubmittedAt`,
`DurationMinutes`, `DeviceId`, `Interviewer`, `SectionReached`, `CompletionPct`,
`ConflictCount`, `FlagCount`; and `ResponseId`, `QuestionKey`, `AnswerText`, `AnswerNumber`,
`AnsweredAt`, `DurationSeconds`, `IsFlagged`. The rows are normalised, not invented.

### Reproducibility and checks

The generator is deterministic: page ids and visual ids are hashes of the study code, page
name and visual label; `--generated-at` pins the timestamp. `pnpm powerbi:test` runs five
Node tests over a synthetic definition: questionnaire-derived counts, CSV quoting, indented
TMDL with a valid star schema, unique in-bounds pages with resolvable fields, and a writer
that leaves the response layer empty by default. The five generated examples additionally
pass the Microsoft PBIR validator (0 errors, 0 warnings) and all 65 TMDL files parse with
no unknown nodes.

That is structural and schema validation, not a visual render. Power BI Desktop is not
installed in this workspace, so the projects have not been opened and screenshotted here;
the `.pbip` is the artifact Desktop opens. The generator also does not write a `.pbix`,
for the reason documented above.

## Open-source and agent skills reviewed

The request asked for the strongest Power BI and Fabric skills on GitHub. The useful
ones fall into three groups, and none of them changes the PBIX boundary:

- [microsoft/skills-for-fabric](https://github.com/microsoft/skills-for-fabric) is the
  official agent skill collection. It bundles Power BI authoring guidance and the
  official modeling MCP. The skills are instructions for an agent, not a runtime that
  writes PBIX.
- [microsoft/fabric-cicd](https://github.com/microsoft/fabric-cicd) is Microsoft's
  supported CI/CD library for deploying Fabric item definitions.
- [pbi-tools](https://github.com/pbi-tools/pbi-tools) is the mature community CLI for
  extracting, converting and compiling PBIP/TMDL. Its Linux Core edition is the reason a
  report-only PBIX or PBIT can be produced in CI.
- [pbir.tools](https://github.com/maxanatsko/pbir.tools) edits and validates PBIR report
  folders and can publish to Fabric. It is in beta and does not write PBIX.
- [data-goblin/power-bi-agentic-development](https://github.com/data-goblin/power-bi-agentic-development)
  is the active community skill collection for PBIP, PBIR, TMDL and Tabular Editor.
  Its own README describes frequent restructuring.
- [pbix-mcp](https://github.com/d0nk3yhm/pbix-mcp) claims a pure-Python PBIX writer.
  It is a young, self-verified project, not a foundation for a release path.

The shipped code does not install an unreviewed agent plugin into the server. The
standards above are encoded in the monitor, the report plan and the questionnaire
generator, where they can be tested.

## Using the plan in Power BI Desktop

1. Open **Live monitor** for the form and download the report plan.
2. In the app, export the response data as `.xlsx` or the CSV bundle from **Responses &
   exports** for the first build, or connect Desktop to the organisation's PostgreSQL
   read replica for a refreshable model.
3. Create the six measures in the plan, or paste them into Tabular Editor.
4. Import the plan's theme values as a Power BI theme.
5. Place the visuals on the 1280 x 720 canvas at the coordinates in the plan.
6. Publish to a Fabric workspace. A model-bearing PBIX can now be saved from Desktop,
   because Desktop is the component that supports that conversion.
7. For live rows, choose Fabric Real-Time Intelligence or a push dataset. A scheduled
   import refresh is not real time and must not be described as such.

## Deploying to Fabric

The deployment command is `scripts/fabric-deploy.mjs`, run through
`pnpm fabric:deploy`. It has two real paths because Microsoft has two different
operations, and choosing the wrong one is how a deployment produces a report with no
model:

### A Desktop-made PBIX (the model-bearing path)

```bash
pnpm fabric:deploy -- --pbix ./inicio-monitor.pbix --workspace <workspace-id>
pnpm fabric:deploy -- --pbix ./inicio-monitor.pbix --workspace <workspace-id> --overwrite
```

This uses the Power BI **Imports** API:

1. `POST https://api.powerbi.com/v1.0/myorg/groups/{workspaceId}/imports` with the
   PBIX as multipart form data, `datasetDisplayName` naming the report without the
   `.pbix` extension, and `nameConflict=Abort` unless `--overwrite` is passed.
2. Poll `GET .../imports/{importId}` until the state is `Succeeded` or `Failed`.
3. Print the report names, ids and `webUrl` values the import returned.

The service principal needs the Power BI application permission
`Dataset.ReadWrite.All` with admin consent, a Contributor or Member role in the
workspace, and the tenant settings named below. My workspace is not supported.

The PBIX must already exist. This repository does not create one and cannot create
one; Desktop is the component that writes the model and the report together. Use the
report plan and `docs/POWER-BI.md` to build it, save it from Desktop, then run the
command above.

### A PBIR report folder (the report-definition path)

```bash
pnpm fabric:deploy -- \
  --pbir ./Inicio.Report \
  --workspace <workspace-id> \
  --semantic-model <semantic-model-id> \
  --update
```

This uses the Fabric **Create Report** API, or the item definition update API when
`--update` finds a report with the same display name:

1. Read the supported definition parts as `InlineBase64`: `definition.pbir`,
   `definition/`, `StaticResources/`, `semanticModelDiagramLayout.json`,
   `.platform`, and the top-level `report.json` for PBIR-Legacy. Local `.pbi` cache
   files, screenshots and unrelated files are not uploaded. A folder carrying both
   `definition/` and a top-level `report.json` is refused because Fabric does not
   allow both formats at once.
2. Rewrite `definition.pbir` from Desktop's sibling `byPath` reference to the
   documented `byConnection` form:
   `semanticmodelid=<semantic-model-id>`. With no `--semantic-model`, the existing
   byConnection reference is used and a missing one is refused. If Desktop saved the
   file without `$schema` (a known 2.158 save behaviour), restore the published
   `definitionProperties/2.0.0` schema before upload; Fabric rejects the shell file
   without it.
3. Keep an existing `.platform` and set its display name to the deployment name, or
   add `.platform` metadata when the folder has none, so the item has a report type,
   a display name and a logical id.
4. `POST /v1/workspaces/{workspaceId}/reports` to create, or
   `POST /v1/workspaces/{workspaceId}/items/{itemId}/updateDefinition` to update.
5. Follow the long-running operation and report the Fabric URL.

The Fabric surface needs the application permission `Report.ReadWrite.All` or
`Item.ReadWrite.All` with admin consent, a Contributor role in the workspace, and an
existing semantic model with the tables and measures the report queries. `--update`
also looks the report up by name through Fabric List Items, so grant
`Workspace.Read.All` or `Workspace.ReadWrite.All` for that path. A report definition
does not carry data.

### Configuration and preflight

Set these in the environment, never in a browser and never in a command line:

| Variable | Required | Purpose |
|---|:---:|---|
| `FABRIC_TENANT_ID` | yes | Microsoft Entra tenant id |
| `FABRIC_CLIENT_ID` | yes | Service principal application id |
| `FABRIC_CLIENT_SECRET` | yes | Service principal secret, read from the environment only |
| `FABRIC_WORKSPACE_ID` | optional | Fallback for `--workspace` |
| `FABRIC_SEMANTIC_MODEL_ID` | for PBIR | Fallback for `--semantic-model` |

Run the preflight before the first real deployment:

```bash
pnpm fabric:deploy -- --pbix ./inicio-monitor.pbix --workspace <id> --dry-run
pnpm fabric:deploy -- --pbir ./Inicio.Report --semantic-model <id> --dry-run
```

A dry run validates the artifact, its file type, the PBIR reference and the required
environment. It makes no network request and prints no secret. It fails if a key is
missing, because a preflight that always succeeds is not a preflight.

The command never prints the client secret or an access token. A refusal is reported
with the service's own error message or code and the action to take (workspace role,
tenant setting, missing semantic model) rather than being retried until it looks like
a network problem.

### What is still required outside this repository

A real Fabric connection still needs all of the following:

1. A Microsoft Entra application or service principal.
2. A Fabric or Power BI capacity, not shared Pro capacity, for the Fabric item APIs.
3. The tenant settings **Service principals can call Fabric public APIs**, **Embed
   content in apps** and **Allow service principals to use Power BI APIs** enabled for
   the security group.
4. The service principal added to the target workspace as Contributor or Member.
5. A semantic model in the workspace, for PBIR, or a Desktop-made PBIX with its model.
6. A decision on data freshness: a scheduled refresh, Fabric Real-Time Intelligence,
   or a push dataset. The monitor is live; a published Power BI report is not live
   until one of those is configured.

## What is verified, and what is not

Verified by unit tests:

- every answerable question becomes one monitor entry and one plan visual;
- omitted notes and calculated fields are counted rather than lost;
- missing, numeric, date, multi-select and coordinate aggregations;
- every plan coordinate is divisible by 8;
- the plan carries the PBIX limitation and the Desktop requirement;
- a live stream causes a refetch, and a minute of clock while the stream is live causes
  none;
- an unpublished form says there is nothing to monitor;
- every monitor table exports as CSV, including an answer that starts with a formula
  marker;
- the Fabric command refuses two artifacts, a missing secret and a PBIR definition
  with no semantic model; rewrites a Desktop `byPath` reference to `byConnection`;
  restores a missing `definition.pbir` `$schema`; packages only supported parts; and
  handles both PBIR and PBIR-Legacy without mixing them (`pnpm fabric:test`, 8 tests).

Not verified:

- a real call to a Fabric tenant, because this workspace has no service principal,
  capacity or workspace membership to call with;
- Power BI's own rendering of the plan's visuals, because the plan is a specification;
- map tiles, because the monitor draws coordinates without a basemap;
- frame rate on real hardware for the rest of the console.

The browser check ran the real monitor component in Chromium at 1200 and 390 CSS
pixels with a fixture API: eight question cards, fifteen bars, no horizontal overflow,
no clipped card header, no empty chart box, both CSV downloads present, and no console
or network errors. It did not test a customer database or a Power BI tenant.
