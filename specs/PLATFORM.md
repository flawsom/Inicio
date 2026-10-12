# PLATFORM.md — canonical design for the survey platform

Supersedes the school-specific framing in `BUILD.md`. `BUILD.md` still governs process
(one phase per session, tests+lint+build must pass, on ambiguity stop and ask).
Derived from six research passes; see `docs/MARKET-RESEARCH.md` for the market view and
the "Research basis" notes inline below.

---

## 0. Non-negotiable principles

1. **One canonical model, many adapters.** The platform owns an internal form model. XLSForm,
   LimeSurvey TSV, Qualtrics TXT and our own JSON are *adapters* over it — never the model itself.
2. **Nothing is ever mock or stale.** Every number in the UI comes from a live query or a live
   subscription. Imports/exports run against real data. Seed/demo data is labelled as such.
3. **Definition and data are separate.** A response never depends on mutating the form it answered.
4. **Publication is immutable.** Publishing freezes a version; restoring creates a *new* version.
5. **Tenant isolation is enforced by the database**, not by UI filters.
6. **Transparent limits.** We show real usage against real capacity — including the free-tier
   capacity of our own infrastructure. We never promise "unlimited" and then throttle silently.

---

## 1. Domain model

Five concerns stay distinct. (Research basis: SurveyJS/Form.io/Qualtrics/LimeSurvey all separate
definition, rules, runtime state and publication; Form.io's revisions and Qualtrics' draft-vs-published
both show why.)

```
IDENTITY       app_user ─┬─ membership ── org
                         └─ (a user may belong to many orgs, with a different role in each)

DEFINITION     org ── project ── form ── form_version (immutable once published)
                                          └─ definition jsonb  (groups, questions, choices, rules)

RUNTIME        form_version ── response ── answer          (status: in_progress | submitted |
                                                                      screened_out | quota_full)
                                    └──── attachment

DISTRIBUTION   form ── dist_link (anonymous | single_use | panel)
                    └─ dist_invite (email, reminders)
                    └─ quota (target, condition, action)

OPS            audit_log · email_log · export_job · webhook_delivery   (all org-scoped)
```

### 1.1 `form_version.definition` — the canonical JSON

```jsonc
{
  "title": "School Ranking Survey 2026",
  "defaultLanguage": "en",
  "languages": ["en","hi"],
  "settings": { "allowPartialSave": true, "pagination": "section" },

  "groups": [{
    "id": "g_admin", "name": "admin", "label": { "en": "Administration" },
    "repeat": false, "repeatCount": null
  }],

  "questions": [{
    "id": "q_school_type",
    "groupId": "g_admin",
    "name": "school_type",              // export column name; stable forever
    "type": "select_one",
    "label": { "en": "School type" },
    "hint":   { "en": "Choose one" },
    "required": true,
    "choices": { "listName": "school_types" },   // or inline: [{value,label}]
    "validation": { "constraint": ". != ''", "message": { "en": "Required" } },
    "rules": {
      "visibleIf": null,
      "enableIf":  null,
      "calculate": null,
      "choiceFilter": null
    },
    "appearance": "dropdown",
    "upload": null
  }],

  "choiceLists": {
    "school_types": [
      { "value": "govt", "label": { "en": "Government" }, "extra": { "region": "all" } }
    ]
  },

  "variables": [],                // embedded data / respondent metadata definitions
  "triggers":  []                 // { type: "skip"|"complete"|"setvalue", when, target }
}
```

**Why this shape.** SurveyJS proves a JSON definition with `visibleIf`/expressions is workable and
portable; Form.io proves a `components` tree maps cleanly onto stored submissions; LimeSurvey proves
relevance expressions on both groups and questions; Qualtrics proves that *flow* (branching between
blocks) is a different concept from *display logic* on a question. We therefore keep four rule kinds
**separate** rather than collapsing them into one `condition` field:

| Rule | Meaning | Imported from |
|---|---|---|
| `visibleIf` | show/hide (skipped ⇒ answer nulled) | XLSForm `relevant`, SurveyJS `visibleIf`, LS `relevance` |
| `enableIf` | visible but read-only | SurveyJS `enableIf`, Form.io disabled |
| `calculate` | derived value, recomputed on dependency change | XLSForm `calculation`, Form.io `calculateValue` |
| `choiceFilter` | dynamic option filtering (cascading selects) | XLSForm `choice_filter`, SurveyJS `choicesVisibleIf` |

`triggers` carry navigation: **branch/skip** (Survey Flow-equivalent) and **complete** (end-of-survey,
which is also how screening and quota-full are expressed).

### 1.2 Choices: value ≠ label, always

Every stored answer is the **value**; every displayed option is the **label**. XLSForm's `choices`
sheet (name/label) and SurveyJS's `{value,text}` both enforce this, and it is what makes exports
analysis-ready instead of label-strings.

---

## 2. Logic & expression language

Replaces `expression-grammar.md`. One expression language, evaluated in three places (browser for
live UX, server for authority, importer for translation) so they can never disagree.

**Authority rule:** the server is the source of truth. Client evaluation is an optimisation only.

```
literals     'text'  123  12.5  true  false  null
refs         ${question_name}          -> value of an answered question
             ${variable_name}          -> embedded/respondent variable
current      .                          -> the value being validated (constraint context)
operators    and or not   && || !      = != < <= > >=   + - * / %
functions    if(c,a,b)  coalesce(a,b,...)  length(x)  upper(x)  lower(x)  trim(x)
             number(x)  int(x)  round(x,n)  abs(x)  min(...)  max(...)  sum(...)
             today()  now()  age(date)  dateDiff(a,b,'days')  dateAdd(d,n)
             selected(multi, value)  count-selected(multi)
             search(list, 'value', 'result')   // external CSV lookup
repeats      ${repeat_name}[position() = n]/field
             sum(${people}[age < 18]/count)
```

**Deliberate omissions.** No user-authored JavaScript (Form.io supports it; it makes logic
non-portable and enables XSS). No arbitrary server-side execution anywhere in the engine.

**Validation semantics** (from XLSForm, kept identical so imports behave as authors expect):
- `constraint` is only evaluated for a **non-blank** answer; blank rejection is `required`'s job.
- A question whose `visibleIf` is false is **skipped and its answer set to null**.
- Empty numeric answers are **not** zero in calculations.
- Multi-selects are sets: test with `selected()`, never string equality.

**Static analysis at publish time:** unknown `${ref}`, duplicate `name`, unresolved choice list,
unmatched group/repeat pair, unreachable question, contradictory conditions, cycles, and
required-question dead ends. (Kobo's troubleshooting list is the canonical set of authoring errors;
we fail the *publish* rather than failing the respondent.)

---

## 3. Import / export adapters

**XLSForm is the flagship import** because it is the one genuinely portable authoring format in the
field: ODK, KoboToolbox, SurveyCTO and Survey123 all consume it, and Kobo explicitly supports
downloading a visually-built form back to XLSForm.

### 3.1 XLSForm ⇄ canonical

| XLSForm | Canonical |
|---|---|
| `survey.type` | `question.type` (+ `structural: group/repeat` from `begin_group`/`begin_repeat`) |
| `survey.name` | `question.name` (validated: must be unique, start with letter/underscore) |
| `survey.label` / `label::xx` | `question.label.{lang}` |
| `survey.hint`, `required`, `required_message` | `hint`, `required`, `validation.message` |
| `survey.relevant` | `rules.visibleIf` |
| `survey.constraint`, `constraint_message` | `validation.constraint`, `validation.message` |
| `survey.calculation` | `rules.calculate` |
| `survey.choice_filter` | `rules.choiceFilter` |
| `survey.appearance`, `default`, `read_only`, `repeat_count` | `appearance`, `default`, `enableIf:false`, `group.repeatCount` |
| `choices.list_name/name/label` + attribute columns | `choiceLists[name] = [{value,label,extra}]` |
| `settings.form_title` / `form_id` / `version` / `default_language` | `title` / `form.slug` / `form_version.version` / `defaultLanguage` |

`${q}` → `${q}`; `selected(${m},'x')` → identical; `pulldata()` and `select_one_from_file` map to
`search()` against an org-scoped dataset (Phase 5).

**Format quirks we normalise and warn about** (all documented differences between platforms):
`dateTime` vs `datetime` casing, `read_only` vs `readonly`, `select_one list` vs `select_one_from_file`,
and platform-only types (`background-audio`, `start-geopoint`, `username2`).

### 3.2 Other adapters

| Adapter | Direction | Notes |
|---|---|---|
| Our JSON | both | lossless, the reference format |
| XLSForm `.xlsx` | **both** | flagship; round-trip tested |
| CSV/Excel (structure) | both | flattens to one row per question; accepts a plain spreadsheet |
| LimeSurvey TSV `.txt` | import | `G`/`Q`/`SQ`/`A` entity rows |
| Qualtrics TXT/QSF | import (best-effort) | QSF internals are undocumented; TXT only |
| SurveyJS JSON | both | near-identical model; fast win |

**Round-trip guarantee we commit to:** import(x) → export → import(y) must yield `y ≡ x` on the
canonical model, and the importer **reports what it dropped** rather than silently discarding.

---

## 4. Data export pipeline

A response export is not just a value grid. (Research basis: CESSDA/IBM/pyreadstat/Stata docs.)

Every export bundle contains, together:
1. **Data** — one row per response, columns = question `name`.
2. **Codebook** — variable name, full question text, type, valid codes + labels, missing codes.
3. **Value labels** — `variable, code, label` (normalised, so it round-trips into any package).
4. **Metadata** — form version, collection dates, response status definitions.

Formats: `csv` (default, UTF-8, plus a ZIP bundle with codebook) · `xlsx` (sheets: `data`,
`codebook`, `value_labels`, `meta`) · `json` · `pdf` · **`sav`** · `dta` · `kml` / `geojson`.

**Multi-select handling is explicit and chosen per export:** *dichotomous* (one 0/1 column per
option — `0` means "not selected", distinct from "not asked") or *categorical slots* (`q_1..q_n`).
Never a packed delimiter string as the only form.

**Missing-data discipline:** `system missing` ≠ `not asked` ≠ `skipped by logic` ≠ `refused` ≠
`don't know`. Each is a distinguishable code, documented in the codebook.

**CSV injection is a real vulnerability**, not a nicety: any respondent text beginning `= + - @`
(also tab/CR and full-width variants) is a formula in Excel. We keep the canonical data export
untouched and emit a **separate, sanitised spreadsheet-view** copy with dangerous cells
tab-prefixed — we do not silently corrupt the data column.

**`.sav` reality (important):** there is **no maintained, free, pure-JS/Node `.sav` writer**. Our own
research confirmed the only JS option is a paid product (excluded by the no-paid-services rule).
Therefore `.sav`/`.dta` are produced by a small **export worker** running Python `pyreadstat`
(write_sav supports file label, variable/value labels, missing ranges, measures, formats) deployed on
Google Cloud Run's free tier. Until that worker exists, `sav`/`dta` return **`501`** rather than a
broken file. We will *not* repeat KoboToolbox's "SPSS export" that is merely label syntax.

**Verification requirement:** every statistical export is reopened in `pyreadstat` (and PSPP where
available) in tests, checking rows, labels, value labels, missing codes, non-ASCII text and
>255-character strings.

---

## 5. Distribution & collection

(Research basis: Qualtrics distribution/privacy/partial-quota docs, scaled to a multi-tenant model.)

| Mechanism | Behaviour |
|---|---|
| **Anonymous link** | stable URL, reusable, no identity. Optional server-side de-dup by cookie + IP hash for non-anonymous surveys. |
| **Single-use link** | per-recipient opaque token (32 bytes), **single use by default**, optional expiry; the token is the bearer credential, so we never put PII in the URL. |
| **Multiple-completes link** | respondent-specific but reusable (Qualtrics' own distinction), and therefore incompatible with reminder tracking. |
| **Panel link** | captures opaque `pid`/`ticket` from the query string into embedded data, with **separate exit redirects for complete / screen-out / quota-full / quality-check**. |
| **Invites + reminders** | org-scoped list, scheduled send, reminder targets non-finishers and re-uses the same link so progress resumes. |
| **Prefill** | query-string → embedded data (not answers, by default). `Q_PopulateResponse`-style answer prefill only for explicitly resumable links. |
| **Quotas** | counted **on submission** (not reserved at entry) — we surface that openly, because the upstream docs show concurrent respondents can exceed a target. |
| **Partial responses** | saved at every page/section transition *and* on field blur via the API, so abandonment is recoverable. `in_progress` responses are first-class, countable and exportable. |
| **Offline** | PWA + local queue; sync on reconnect; conflicts resolved server-wins with the device value retained (`device_value` already exists in the Phase-1 schema). |

---

## 6. Real-time (nothing stale)

Three distinct needs, three mechanisms — chosen deliberately rather than "websockets everywhere":

| Need | Mechanism | Why |
|---|---|---|
| Live counts / completion / quota on a dashboard | **Postgres change subscription** (Supabase Realtime `postgres_changes`) scoped to the org | Data is already in Postgres; no second source of truth |
| Live per-response streaming to one respondent | normal HTTP POST on change | Round-trip is already the requirement |
| Long-running export notifications | **queue + polling/push on `export_job.status`** | Exports outlive a request; Postgres holds the state |

**Honest limits we will display rather than hide:** Supabase Free gives **200 concurrent realtime
connections** and **2M messages/month**. We therefore coalesce dashboard updates (one message per
aggregate, not one per row) and never use a subscription where a query is cheaper.

---

## 7. AI

(Research basis: SurveyMonkey/Qualtrics/Jotform docs plus the NORC randomised experiment.)

1. **Generation is constrained, never free-text.** Prompt/document/spreadsheet →
   *candidate questions in the canonical JSON* → validated by the same static analyser as manual
   authoring → **draft only**. AI never publishes.
2. **Logic is proposed, then compiled by our engine.** Natural language is never executed.
3. **Analysis must expose its evidence.** Every theme, sentiment label and summary stores the
   `response_id`s it was derived from and renders them inline. (SurveyMonkey exposes respondent IDs
   and tags; Qualtrics shows example comments but samples them — we do not hide the sampling.)
4. **Conversational probing is opt-in and mobile-tested.** NORC found richer answers but *worse
   respondent experience and higher attrition, worst on mobile* — so it is off by default and
   instrumented for completion/attrition by device.
5. **Provider:** Cloudflare Workers AI free allowance (10,000 Neurons/day) plus a rate-limited
   fallback. Free-tier data-use terms differ from paid — we surface that before anything sensitive
   is sent.

---

## 8. Multi-tenancy & security

- Every tenant table carries `org_id` and has **`FORCE ROW LEVEL SECURITY`**.
- The API connects as the **non-superuser `app_role`** (already proven in Phase 1 — superusers and
  `BYPASSRLS` roles silently ignore RLS).
- Per request: `set_config('app.user_id', …, true)` **and** `set_config('app.org_id', …, true)`
  inside the transaction. `app.org_id` is set **only after verifying membership**.
- Policies use the membership check, not the request parameter alone, so a forged `app.org_id`
  still cannot read another org's rows.
- Roles: `owner` (billing, delete org) · `admin` (forms, members) · `member` (author, collect) ·
  `viewer` (read/export only).

---

## 9. Free-tier deployment (and its honest ceiling)

| Layer | Service | Free allowance | Breaks first |
|---|---|---|---|
| Postgres (+RLS) | **Supabase** | 500 MB DB, 500 MB RAM, 5 GB egress, 2 projects, **pauses after 7 days idle**, **no backups** | DB size, then the idle pause |
| Object storage | **Cloudflare R2** | 10 GB, 1M Class A / 10M Class B ops, presigned URLs 1 s–7 days | storage, then reads |
| API | **Cloudflare Workers** | 100,000 requests/day, 10 ms CPU/invocation | CPU on heavy report queries |
| Realtime | **Supabase Realtime** | 200 concurrent, 2M msgs/month | connection count |
| Queue | **pg-boss** on our own Postgres | free (no extra service) | DB IO |
| AI | **Cloudflare Workers AI** | 10,000 Neurons/day | daily neuron budget |
| Email | **Resend** | 3,000/month, **100/day**, verified domain required | the 100/day cap during OTP bursts |
| `.sav`/`.dta` worker | **Google Cloud Run** | 2M requests, 180k vCPU-s, 360k GiB-s per month | cold start |
| SPA | **Cloudflare Pages / Vercel Hobby** | free | Vercel Hobby is **non-commercial use only** |

**The one thing we cannot honestly promise:** the user's own free tiers impose hard caps, and
Supabase pauses an idle project and takes no backups. So "everything free, no caps" is true of **our
product's** limits (we will not meter responses) but **not** of the infrastructure underneath it.
We therefore (a) show live usage against each provider's real ceiling, (b) keep the whole stack
portable so one `DATABASE_URL` moves it to a paid host later, and (c) never delete customer data to
stay under a quota.

---

## 10. Build order

1. **Foundation** — platform schema + org-scoped RLS + identity/membership + open signup. *(reuses Phase 1)*
2. **Definition** — canonical model, static analyser, form/version CRUD, publish.
3. **Engine** — expression language, visibility/branching/validation, calculation.
4. **Authoring UI** — visual builder + logic editor + preview.
5. **Adapters** — XLSForm import/export round-trip (flagship), CSV/Excel, survey JSON.
6. **Collection** — renderer, partial save/resume, offline queue, distribution links, invites, quotas.
7. **Exports** — codebook bundle, XLSX/CSV/JSON/PDF, then the `.sav`/`.dta` worker.
8. **Realtime + analytics** — live dashboards, cross-tab, grounded AI analysis.
9. **AI authoring** — prompt/document/spreadsheet → draft.
10. **Hardening** — SSO/passkeys, audit/SCIM, backups/restore, WCAG 2.2 AA, handover.
