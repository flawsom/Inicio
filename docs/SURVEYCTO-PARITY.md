# SurveyCTO parity and the Inicio program layer

**Status:** active design and implementation record.
**Last reviewed:** 2026-11-01.
**Scope:** the operational features that make SurveyCTO a field-research platform, not only a form renderer.

This document is the elephant. It holds the research, the decisions, the gaps against Inicio, and the build order. The implementation is deliberately smaller than the whole document: shipping one complete loop is worth more than ten half-features.

## 1. The answer to "is that all SurveyCTO does?"

No. SurveyCTO is an XLSForm platform with an operational layer around the form:

1. **Authoring:** the standard `survey`, `choices` and `settings` sheets, plus proprietary field types, appearances, expressions and field plug-ins.
2. **Data on the device:** preloaded CSV files and server datasets, `pulldata()`, `search()` choice lists, calculated defaults, case lists and offline case updates.
3. **Collection:** Android Collect and web forms, enumerator identity, device metadata, text audit, audio audit, speed limits, sensor metadata, call metadata, and offline finalisation.
4. **Monitoring:** Data Explorer summaries, drill-down, text-audit overlays, audio playback, automated quality checks, review and correction, and a correction log.
5. **Data out:** CSV, XLSX, SPSS `.sav`, Stata `.do` templates, server datasets, Google Sheets, Zapier, webhooks and a REST API.

The form editor is the visible part. The paid part is the repeatable loop:

```
preloaded case or sample
        -> instrument with calculations and constraints
        -> offline or online interview
        -> timing and quality evidence
        -> review queue
        -> correction with an audit trail
        -> approved data published to a dataset or downstream system
```

Inicio already has the spine: multi-tenant RLS, XLSForm round trips, shared client/server logic, offline drafts, audits, quality flags, exports, webhooks and API keys. It does not yet have the program layer that connects cases and server datasets to that spine. That is the first build.

## 2. Evidence used

Primary SurveyCTO documentation read directly:

- Expressions and functions: https://docs.surveycto.com/02-designing-forms/01-core-concepts/09.expressions.html
- Preloading and `pulldata()`: https://docs.surveycto.com/02-designing-forms/03-advanced-topics/03.preloading.html
- `search()` dynamic choice lists: https://docs.surveycto.com/02-designing-forms/03-advanced-topics/04.search-and-select.html
- Server datasets: https://docs.surveycto.com/05-exporting-and-publishing-data/04-advanced-publishing-with-datasets/01.datasets-intro.html
- Forms publishing into datasets: https://docs.surveycto.com/05-exporting-and-publishing-data/04-advanced-publishing-with-datasets/02.forms-to-datasets.html
- Case management: https://docs.surveycto.com/03-collecting-data/03-data-collection-workflow/02.case-management.html
- Review and correction: https://docs.surveycto.com/04-monitoring-and-management/01-the-basics/04.reviewing-and-correcting.html
- Automated quality checks: https://docs.surveycto.com/04-monitoring-and-management/02-managing-for-quality/02.monitoring-quality.html
- Audits and speed limits: https://docs.surveycto.com/04-monitoring-and-management/02-managing-for-quality/01.collecting-high-quality-data.html
- Exports: https://docs.surveycto.com/01-getting-started/01-overview/08.accessing-data.html

Market comparisons read directly:

- SurveyCTO plans: https://www.surveycto.com/plans/
- SurveyCTO case management: https://www.surveycto.com/product/case-management-data-collection/
- ODK: https://getodk.org/ and https://docs.getodk.org/central-submissions/
- KoboToolbox: https://www.kobotoolbox.org/pricing/ and https://support.kobotoolbox.org/viewing_validating_data.html
- CommCare: https://commcare.dimagi.com/pricing/
- Ona: https://ona.io/home/products/ona-data/pricing/
- LimeSurvey: https://www.limesurvey.org/pricing
- Qualtrics offline: https://www.qualtrics.com/support/survey-platform/distributions-module/mobile-distributions/offline-app/setting-up-the-offline-app/

Research caveat: G2, Capterra, TrustRadius and some support-center pages block automated reading, and YouTube transcripts were not retrievable. Complaint themes are therefore directional. Vendor documentation is treated as the solid source, and vendor-authored comparisons are marked as advocacy, not evidence.

## 3. Competitive position

| Platform | Strongest at | What it does not solve well | Inicio's opening |
|---|---|---|---|
| SurveyCTO | Review and correction, server datasets, case management, enumerator quality, statistical exports, managed support | Closed source, no self-hosting, $225 to $630 per month, advanced offline case transfer only on the top tier, QC cannot run on repeats or encrypted fields, reviewed corrections have no validation, published corrections have no claw-back | The same loop with transparent limits, self-hosting, versioned data and a correction history that can be inspected |
| ODK Central | Reference XLSForm implementation, open source, Entities and a clean API | Paid Entities and API on Cloud, no statistical QC engine, no QC-triggered review queue, no native webhooks | Standards compatibility plus quality and review in the base product |
| KoboToolbox | Free for nonprofits, approachable builder, validation states | No true case assignment or case workflow, no audio audits, no statistical QC engine, no native SPSS | A program layer and statistical exports without the nonprofit-only price model |
| CommCare | Longitudinal cases, child cases, case sharing, frontline service delivery | Not a general research instrument, per-mobile-user economics, no SurveyCTO-style review queue | Research-grade instruments with a case model that does not require a different product |
| Ona | Managed in-country instances, ODK lineage, dashboards | Thin public documentation on review and audit, small submission caps | Transparent feature evidence and self-hostable deployment |
| Qualtrics / SurveyMonkey | Enterprise research, panels, analysis breadth | Offline is an add-on or absent, no XLSForm, no case workflow, opaque pricing | Field-first collection with serious scripting and real statistical files |
| LimeSurvey | Open-source survey breadth, SPSS and Stata | No offline collection app, no XLSForm, no case management | Offline and XLSForm together, with the same statistical output |
| Fulcrum / Survey123 | GIS field operations and Esri integration | Proprietary forms or partial XLSForm, API gated or ecosystem-locked, no SPSS or Stata | A standards-first instrument that still exports analysis-ready data |

**Do not claim a competitor's existing feature as a differentiator.** SPSS export, offline collection, audits and quality flags are now prerequisites. The differentiator is the combination: a case and dataset loop that is inspectable, portable, self-hostable and priced without a response cliff.

## 4. What SurveyCTO does that Inicio does not yet do

Status legend: **shipped** is in this repository now, **building** is this change, **next** is designed and ordered, **later** is real but not scheduled.

| Capability | SurveyCTO behaviour | Inicio today | Plan |
|---|---|---|---|
| Server datasets | Three dataset types (data, cases, enumerators), attach to forms, replace/append/merge, unique IDs, offline updates | No dataset model | **Shipped:** organisation datasets, CSV rows, version attachment, case preload, submission write-back |
| `pulldata()` | `pulldata('dataset','column','lookup',key)`, with indexed `_key` lookup columns | Imported and noted, never evaluated | **Shipped:** pure engine function with a dataset context, identical on client and server |
| Scripting functions | `choice-label`, `selected-at`, `join`, `count-if`, `sum-if`, `format-date-time`, `once`, `indexed-repeat`, `rank-index`, geo and phone functions | Core XPath only | **Shipped:** pure string, list, select, numeric, date and dataset functions. `once`, repeat aggregates and phone/geo functions are **next** |
| Dynamic choice lists | `search()` appearance over a dataset with contains, starts-with, matches and filters | Static choices and `choice_filter` | **Next:** dataset-backed choices with the same client/server resolver |
| Cases | `id`, `label`, `formids`, `users`, `roles`, `enumerators`, `sortby`, offline case transfers | `response.caseid` column only | **Shipped:** case dataset, case link, case id on the response, preload and write-back. Assignment, offline transfer and role filters are **next** |
| Review and correction | Hold all, some or none; QC-triggered; classify GOOD/OKAY/POOR/FAKE; correct with comments; approve or reject; correction log | Review fields and append-only log exist in migration 0012; no API or console | **Next:** review queue, corrections with validation, full audit trail |
| Automated QC | 9 statistical checks, nightly report, critical flags, group comparisons | Speeding, straight-lining, duplicate and manual flags | **Next:** outlier, too-frequent and group-difference checks with evidence |
| Exports | XLSX, CSV, SAV, Stata templates, attachments, correction log | CSV bundle, XLSX, JSON, SAV, DTA, codebook | **Shipped**, with a different correction-log design |
| Enumerator management | Enumerator dataset, `enumerator` field type, identity, auto-publish | No enumerator identity | **Next** |
| Field plug-ins | Attached zip, `custom-*` appearance, expression parameters | XLSForm appearance preserved, no plug-in runtime | **Later** |
| CATI and telephony | Call management, phone-call log functions, WhatsApp plug-in | No telephony | **Later** |
| AI transcription and translation | Paid AI features over audio | No AI features | **Later**, and only with evidence-linked output |
| Encryption | Encrypted forms, publishable fields, private-key export | TLS and RLS, no client-side form encryption | **Later** |

## 5. The first build: program data and cases

### Problem

A field team needs to interview a known sample, preload what is already known about each case, and update that case after the interview. Today an Inicio form can collect an answer called `caseid`, but nothing reads the case, and nothing updates it. A supervisor has to join CSVs by hand after every sync.

### User outcome

1. An organiser creates a `cases` dataset from a CSV, with `id` as the unique field.
2. The organiser attaches it to a form version and maps a key question. Columns with the same name as questions are mapped automatically.
3. The organiser opens a case link, or appends `?caseid=...` to an existing link.
4. The form opens with the case id in the response and `pulldata()` can read the row.
5. On submission, the mapped answers update the case row, inside the same transaction as the response.
6. The case table shows the updated value, and the response remains the evidence of who changed it and when.

### Non-goals for this build

- No offline device-to-device case transfer.
- No role or enumerator assignment rules.
- No dynamic `search()` lists yet.
- No review and correction yet.
- No field plug-ins, CATI, encryption or AI.

These are not forgotten. They are ordered in section 7.

## 6. Design

### 6.1 Data model

```sql
server_dataset
  id, org_id, code, name, kind, unique_field, columns, created_by, timestamps

server_dataset_row
  id, org_id, dataset_id, row_key, data jsonb, timestamps
  unique (dataset_id, row_key)

form_dataset
  id, org_id, form_id, form_version_id, dataset_id
  key_question, mapping jsonb, publish boolean
  unique (form_version_id, dataset_id)
```

Decisions:

- **Rows are JSON, not one column per dataset.** A dataset is imported after the form is designed. A wide table cannot express that without a migration per upload. The JSON object preserves the CSV header order in `columns`, and `row_key` is the unique lookup value.
- **Attachment is per form version.** A published form is immutable, and the data it reads must be knowable months later. Attaching to `form` alone would let a new dataset change an old instrument's behaviour.
- **RLS is on every table.** A dataset id from another organisation resolves to no row, not to another tenant's data. The public collector reads only datasets attached to the exact published version through a narrow `SECURITY DEFINER` function.
- **The write-back mapping is data, not code.** `mapping` is `{ datasetColumn: questionName }`. It is computed at attach time and can be overridden. No user-authored SQL or JavaScript is executed.
- **The response and the case update commit together.** A submission that rolls back must not leave a case updated, and a case update that fails must not leave a response claiming success.

### 6.2 Scripting

The engine gets a dataset context:

```ts
interface DatasetTable {
  code: string;
  uniqueField: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
}
```

`pulldata('cases', 'head_name', 'id', ${caseid})` is pure: it reads only the supplied table, returns `null` for a blank key or no match, and treats values as text in the same way SurveyCTO does. The same function runs in the browser and on the server because both call the same `evaluate()`.

Also added because they are pure and commonly used in XLSForm calculations:

- `string`, `concat`, `substr`, `string-length`, `linebreak`
- `selected-at`, `choice-label`, `join`
- `empty`, `count-items`, `item-at`, `item-index`, `item-present`, `de-duplicate`, `rank-value`
- `pow`, `sqrt`, `log10`, `exp`, `pi`, `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`
- `div`, `mod`, `short-geopoint`
- `date-time`, `date`, `format-date-time`, `decimal-date-time`, `decimal-time` with the documented `%Y`, `%m`, `%d`, `%H`, `%M`, `%S` subset

`once`, `indexed-repeat`, repeat-aware `count-if` and `sum-if`, `rank-index` and the phone/geo functions that need a device context are not faked. They need repeat or platform state that the canonical model does not yet carry, and they are the next scripting tranche.

### 6.3 Collection flow

```
GET /collect/:token
  -> published version
  -> attached datasets snapshot

POST /collect/:token/responses
  -> optional caseid
  -> verify the case exists in an attached cases dataset
  -> store caseid on response
  -> seed the caseid answer when the form defines one
  -> evaluate with the dataset context

PATCH /collect/:token/responses/:id
  -> evaluate with the same dataset context
  -> store answers and timings

POST /collect/:token/responses/:id/submit
  -> same evaluation
  -> response status, quotas, flags
  -> apply dataset write-back rules
  -> emit response.submitted
```

The device receives the dataset snapshot with the form and caches it with the definition, so an offline interview can still run `pulldata()`. The server re-evaluates from its own snapshot. If the dataset changed between the device's cache and the submission, the normal calculation-conflict path records the disagreement rather than silently choosing one.

### 6.4 API surface

Session routes:

```
GET    /api/v1/orgs/:orgId/datasets
POST   /api/v1/orgs/:orgId/datasets
GET    /api/v1/orgs/:orgId/datasets/:datasetId
PUT    /api/v1/orgs/:orgId/datasets/:datasetId/rows
DELETE /api/v1/orgs/:orgId/datasets/:datasetId
GET    /api/v1/orgs/:orgId/forms/:formId/versions/:versionId/datasets
POST   /api/v1/orgs/:orgId/forms/:formId/versions/:versionId/datasets
DELETE /api/v1/orgs/:orgId/forms/:formId/versions/:versionId/datasets/:attachmentId
```

Row upload accepts:

```json
{
  "mode": "replace | append | merge",
  "rows": [{ "id": "HH-001", "head_name": "Amina" }]
}
```

`replace` is a full refresh, `append` refuses an existing key, and `merge` upserts. The CSV parser lives in the browser, because a CSV is the operator's file and the API should accept the already-parsed rows. The API still validates every row and infers columns server-side.

### 6.5 Console

A new **Cases & data** tab on the form workspace:

- create a dataset, choose data or cases
- import a CSV with a header row
- attach a dataset to the selected form version
- show which questions map to which columns
- list case rows and open one in a collection link
- show row count, unique field and attachment state

No separate admin app. The console is already where forms, responses and quality live.

## 7. Ordered implementation plan

### Phase A: program data and cases (this change)

- [x] Research and gap matrix
- [x] Migration 0013 with server datasets, rows, attachments and RLS
- [x] Dataset CRUD and row import API
- [x] Version attachment API with automatic mapping
- [x] `pulldata()` and pure scripting functions in the engine
- [x] Collect route reads attached datasets
- [x] Case id is accepted, verified and stored
- [x] Submission write-back runs in the response transaction
- [x] Console **Cases & data** tab
- [x] Engine and API tests, typecheck, lint

### Phase B: review and correction

- [ ] `GET /orgs/:orgId/forms/:formId/review` queue with state, age and flags
- [ ] `POST .../responses/:responseId/review` for claim, comment, approve, reject, reopen
- [ ] Correction endpoint that records `{ questionId, from, to }` and appends `review_log`
- [ ] Validate corrections against the published definition instead of writing raw values
- [ ] Decide whether corrections apply before or after export, and make the choice visible
- [ ] Quality tab review queue, correction diff and append-only history
- [ ] Tests for illegal transitions, stale corrections and cross-tenant review access

### Phase C: dynamic data and scripting depth

- [ ] `search()` appearance with contains, starts-with, ends-with and matches
- [ ] Dataset-backed choice lists, client and server
- [ ] `once()` with a persisted per-response value
- [ ] Repeat-aware `count-if`, `sum-if`, `indexed-repeat`, `rank-index`
- [ ] `calculate_here` segment timing
- [ ] External CSV attachments as a first-class dataset import
- [ ] Enumerator dataset and `enumerator` field type

### Phase D: statistical quality

- [ ] Outlier check with an explicit IQR multiple and exclusion values
- [ ] Too-frequent and too-infrequent checks with a stated share
- [ ] Mean and group-mean checks with the test and p-value recorded
- [ ] Group-distribution check with a chi-squared result
- [ ] QC report as a dataset, with a stable warning id
- [ ] Critical flags route submissions into the review queue

### Phase E: interoperability and delivery

- [ ] Dataset REST API with append, merge and clear modes
- [ ] Webhook events for dataset changes
- [ ] Publish to Google Sheets or an HTTPS endpoint
- [ ] Correction log in CSV, XLSX, SAV and DTA exports
- [ ] Field plug-in packaging and a safe `custom-*` allowlist
- [ ] Self-host documentation for the API, database and object store

## 8. Security and correctness rules

1. **The server is the authority.** A case id, a dataset row, a calculation and a write-back are all checked inside the tenant transaction. A device can supply a claim, never a result.
2. **Attachment is per version.** An old published instrument cannot start reading a newly uploaded dataset by accident.
3. **The collector sees one version's data.** The database function returns only rows attached to the resolved published version, and the collector still cannot read another response.
4. **No user SQL.** Mappings are JSON objects, keys are question names, and every query is parameterised.
5. **No silent loss.** A duplicate key is a refusal with a count. A merge is an upsert. A write-back with no key value is skipped and reported, not written to a blank row.
6. **The audit trail is append-only.** Case changes are evidenced by the response that produced them. The review log remains append-only when Phase B lands.
7. **Every claim has a test.** A capability is not listed as shipped until an automated test exercises it.

## 9. Verification for this change

- Engine tests for `pulldata`, missing rows, blank keys, type coercion and each new pure function.
- API tests for tenant isolation, replace/append/merge semantics, unique keys, version attachment, case lookup, `pulldata` evaluation and write-back.
- Web tests for CSV parsing, dataset rendering and the case link.
- `pnpm typecheck`, `pnpm lint`, and the focused suites.
- A XLSForm round trip with a `pulldata()` calculation still exports the original phrase.

## 10. What "done" means

A field team can hand a case list to Inicio, open a case, see preloaded data in the instrument, submit, and find the case updated without a manual join. That loop is the first honest claim of SurveyCTO parity. Review and correction, dynamic choice lists and statistical QC follow in that order, because that is the order in which the loop becomes trustworthy.
