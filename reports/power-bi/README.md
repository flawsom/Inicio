# Power BI questionnaire dossiers

This folder contains five generated examples, not a fixed catalogue. The command in
[`scripts/build-powerbi-report.mjs`](../../scripts/build-powerbi-report.mjs) compiles **any**
questionnaire into the same seven-page design dossier, with an embedded semantic model and
no per-study code.

| Study | Questions | Answerable | Sections | Routed | Constraints | Method families | Planning minutes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| [HEER](./heer) | 75 | 50 | 6 | 48 | 3 | 7 | 20.4 |
| [MEHAK](./mehak) | 60 | 42 | 5 | 43 | 4 | 7 | 19.6 |
| [BOUNCE](./bounce) | 116 | 80 | 9 | 88 | 28 | 6 | 34.0 |
| [PRISM](./prism) | 47 | 26 | 5 | 29 | 4 | 6 | 9.7 |
| [NAND](./nand) | 242 | 198 | 3 | 226 | 1 | 8 | 87.9 |

Each project contains a `.pbip` shortcut, a `.Report` folder (PBIR) and a
`.SemanticModel` folder (TMDL). Open the `.pbip` in Power BI Desktop; the report references
its semantic model by relative path. The model is embedded with Power Query `#table`, so it
opens without a gateway or refresh credential.

## Generate another questionnaire

From the repository root:

```bash
# A Word questionnaire. The DOCX compiler fills the canonical FormDefinition.
pnpm powerbi:report -- --docx ./questionnaire.docx --code ACME --project-number 1612

# A questionnaire that is already a canonical FormDefinition JSON file.
pnpm powerbi:report -- --definition ./form.json --code ACME

# Every .docx directly inside a folder.
pnpm powerbi:report -- --all ./questionnaires --out ./reports/power-bi

# A manifest of studies, when several need one deterministic build.
pnpm powerbi:report -- --manifest ./studies.json
```

`--generated-at 2026-11-04T00:00:00.000Z` makes the output reproducible. The default
timestamp is the current time.

## Responses are opt-in, never invented

The questionnaire pages are evidence about the instrument. They do not claim respondent
findings. `Responses` and `Answers` are written with their schema and **zero rows** unless
real CSVs are supplied:

```bash
pnpm powerbi:report -- \
  --docx ./questionnaire.docx \
  --code ACME \
  --responses ./responses.csv \
  --answers ./answers.csv
```

Expected columns are the model's own: `ResponseId`, `Status`, `StartedAt`, `SubmittedAt`,
`DurationMinutes`, `DeviceId`, `Interviewer`, `SectionReached`, `CompletionPct`,
`ConflictCount`, `FlagCount` for responses; `ResponseId`, `QuestionKey`, `AnswerText`,
`AnswerNumber`, `AnsweredAt`, `DurationSeconds`, `IsFlagged` for answers. Rows are
normalised, not fabricated. An empty response table is stated on the cover and in the
`Fieldwork readiness` page.

## What the report contains

1. **00 Cover** - study identity, instrument scale and the evidence boundary.
2. **01 Executive read** - four headline measures, section volume, question mix, analyst read.
3. **02 Instrument architecture** - section table, question volume and planning burden.
4. **03 Routing & quality** - logic references, anchors, rule-load hotspots and constraints.
5. **04 Analysis blueprint** - method families and a question-level analytical contract.
6. **05 Question atlas** - the full instrument, its types, required state and routing.
7. **06 Fieldwork readiness** - data contract, response/answer status and fieldwork notes.

All pages use one editorial theme: warm paper, a dark cover, Georgia display type and a
burnt-sienna / teal / ochre / plum palette. The page canvas is fixed at 1280 × 720, so the
report never scrolls sideways; a long table may scroll inside its own visual.

## Verification

```bash
pnpm powerbi:test
```

The suite proves the analysis is questionnaire-derived, the TMDL is indented and has a
valid star schema, the report package has unique in-bounds pages and resolvable fields, and
the writer leaves the response layer empty by default. The five projects in this folder
also pass the Microsoft PBIR validator with **0 errors and 0 warnings**, and all 65 TMDL
files parse without unknown nodes.

The data-driven report has its own gate, because it is built from data rather than from a
questionnaire:

```bash
node scripts/check-syntax.mjs
python3 scripts/test-oracura-extractor.py          # family rules vs the committed CSV
node scripts/build-oracura-powerbi.mjs
node scripts/validate-pbip.mjs reports/power-bi/oracura \
  --data reports/power-bi/oracura/data/evaluations.csv \
  --dimensions City,Age,Gender,Family \
  --manifest reports/power-bi/oracura/report-manifest.json --strict-relationship
node scripts/verify-drillthrough.mjs
```

With `--manifest`, the validator also performs the **count check**: page ids, page count
and visual count must equal the manifest that the build wrote, and no two pages may share a
display name. That is what catches a zip that was updated in place, where an earlier
build's random page ids survive beside the new ones (a 477-visual build once validated as
557 visuals for exactly this reason). `.github/workflows/powerbi.yml` runs the whole
sequence, including packaging and validating the zip, on every push and pull request that
touches `scripts/` or `reports/power-bi/`.

## Limits

- No `.pbix` is written. Microsoft does not support creating a model-bearing PBIX outside
  Power BI Desktop; see [`docs/POWER-BI.md`](../../docs/POWER-BI.md).
- The planning burden is a heuristic derived from question type, choice load and routing,
  not a measured interview length.
- The report is a design dossier. It is not a claim about respondents, and it does not
  replace fieldwork, weighting or significance testing.

## ORACURA Module 1 - the data-driven report

[ORACURA](./oracura) is different from the five dossiers above: it embeds real
respondent data (204 respondents, 220 product evaluations from the supplied
Module 1 Customer Feedback workbooks) and therefore has live charts, KPI cards,
slicers and tables on thirteen pages (00 Cover · 01 Findings · 02 Executive ·
03 Who bought what · 04 Usage & retention · 05 Experience & satisfaction ·
06 Recommendation & voice · 07 Voice of customer · 08 Where to act ·
09 Journey & heat · 10 Family deep-dive (drillthrough) · 11 Deck reconciliation) -
477 visuals, 34 KPI cards, 30 navigation buttons, 28 DAX measures.
Rebuild it with:

```bash
node scripts/check-syntax.mjs                                    # syntax gate (all scripts)
node scripts/build-oracura-powerbi.mjs
PYTHONPATH=/tmp/xlsxlibs python3 scripts/build-oracura-excel.py  # Excel companion, needs openpyxl
```

The delivered zip is built by deleting it first (`zip -qr` updates an archive in place, and
page ids are random per build, so a re-zip without the delete keeps an earlier build's
pages). It is then validated from the inside with the same command as the folder; see
[Verification](#verification) for the count check that makes a stale zip fail.

Source data lives in `oracura-data/evaluations.csv` (kept outside the generated
folder so a rebuild cannot delete it); the generator copies it into
`oracura/data/` in the delivered project.

### One dimension path

`City`, `Age` and `Gender` exist **only** in `Respondents` (S1-S3). `Evaluations`
(CF2-CF16) reaches them through the single `Evaluations[RespId] → Respondents[RespId]`
relationship, so the page 02 slicers cross-filter every chart and table instead of
filtering on a duplicated column that would blank visuals. The validator fails the
build if any visual references `Evaluations[City|Age|Gender]`.

### Refresh from the original workbooks

```bash
# 1. Put the client's raw-data workbook here, then extract (no hand transcription):
PYTHONPATH=/tmp/xlsxlibs python3 scripts/extract-oracura-xlsx.py reports/power-bi/oracura-data/<raw>.xlsx
# 2. Rebuild + validate + Excel
node scripts/check-syntax.mjs
node scripts/build-oracura-powerbi.mjs
node scripts/validate-pbip.mjs reports/power-bi/oracura \
  --data reports/power-bi/oracura/data/evaluations.csv \
  --dimensions City,Age,Gender,Family \
  --manifest reports/power-bi/oracura/report-manifest.json --strict-relationship
# 3. Package the deliverable zip - delete first, always. `zip -qr` on an
# existing zip UPDATES it in place, so pages from a previous build (random
# page GUIDs every build) survive as stale duplicates inside the zip and the
# validator counts more visuals than the build produced. Run from inside the
# oracura/ folder so the zip top level is the project contents:
rm -f reports/power-bi/ORACURA_Module1_PBIP.zip
(cd reports/power-bi/oracura && zip -qr ../ORACURA_Module1_PBIP.zip ORACURA.pbip ORACURA.Report ORACURA.SemanticModel data report-manifest.json README.md)
# 4. Validate the zip itself - page/visual counts must match the directory build:
node scripts/validate-pbip.mjs reports/power-bi/ORACURA_Module1_PBIP.zip \
  --data reports/power-bi/oracura/data/evaluations.csv \
  --dimensions City,Age,Gender,Family \
  --manifest reports/power-bi/oracura/report-manifest.json --strict-relationship
PYTHONPATH=/tmp/xlsxlibs python3 scripts/build-oracura-excel.py
```

The extractor reads the wide `204 data` sheet (S1-S3, the CF2 product group, then the
repeated CF4-CF16 blocks), normalises answer labels to the analysis vocabulary, derives
product family from the bundle/device/part naming, codes CF12/CF13 themes and keeps the
full verbatims. It prints a drift report against `evaluations.baseline.csv`.

### 01 Findings is the answer, not the evidence

Page 01 states five claims with the number that supports each, so an executive can stop
there. The claims are computed at build time from the same CSV the model embeds, which
is how a wrong claim gets caught: the first draft of finding 2 asserted that service
drove the detractor tail, and the data said only 3 of 21 detractors mention service. The
text was rewritten rather than shipped. If the data changes, rebuild - the numbers move
with it.

### The measure layer is de-duplicated

Every fact is counted once. `Promoters`, `Detractors`, `Top-2 evaluations`, `Better
than expected`, `Daily users`, `Current users`, `Stopped`, `Commented` are the only
measures containing a filter predicate; the rates are `DIVIDE(<base>, [Evaluations])`
and `NPS` reuses `[Promoters]` and `[Detractors]` instead of recounting them.

This replaced six percentage measures that each carried their own copy of the same
`CALCULATE(...)/COUNTROWS(...)` skeleton, an `NPS` that rebuilt both counts inline, a
`Service mentions` that added two `CALCULATE`s (double-counting a comment that named
both words), and three `... plotted` aliases that duplicated real measures verbatim.
25 measures became 22 distinct ones. The validator now fails the build if any two
measures share the same normalised DAX, or if a rate does not divide by `[Evaluations]`,
so the copy-paste pattern cannot come back.

### Verbatims

`CF9` (reason for change), `CF12` (liked most), `CF13` (improve one thing), `CF15`
(why that score) and `CF16` (anything else) are columns on `Evaluations` and are
surfaced on page 06: an escalation queue sorted by lowest recommendation score and an
advocacy table sorted by highest. Every one of the 220 evaluations carries text; the
`Verbatims`, `Detractor verbatims` and `Service mentions` cards quantify coverage.
Long quotes are attributed to their `RespId`, so a quote can be traced back to a row.
The extractor fills these columns from the workbook; nothing is invented.

### TMDL grammar - what Desktop actually enforces

A package that passed every earlier check was rejected by Desktop 2.156:

```
TMDL Format Error: Parsing error type - InvalidLineType
Detailed error - Unexpected line type: ReferenceObject!
Document - './model'   Line 5   Line - '\tref table Evaluations'
```

Root cause: **indentation is parentage in TMDL**. `ref table` must be a root-level
statement, but it was emitted with a leading tab, making it a child of `model` - a
child that `ReferenceObject` cannot be. The vendor template and Microsoft's own TMDL
guidance both show refs at column 0 under the model's properties and annotations.

Three other grammar rules were wrong or missing, all now encoded in the validator
(folder and zip alike), each proven with a negative control:

| Rule | Why it breaks | Check |
| --- | --- | --- |
| `ref table` at column 0, one per table file | indented → `InvalidLineType` | both directions: every file is referenced, every ref resolves |
| No `description:` property | it is a TMSL property, not TMDL → "Property 'description' is unknown" | `///` only, immediately above the object |
| No `///` above a `relationship` | TMDL parses it as the relationship's description, which relationships forbid | pattern check per file |
| `ref cultureInfo en-US` needs `cultures/en-US.tmdl` | dangling culture reference | file exists and declares the same culture |
| Multi-line DAX indented **one level deeper than the measure's properties** | flush-left → "Unsupported object type - VAR is not a supported property in the current context!"; at property level → read as a property | measure line ending in `=` must be followed by a 3-tab line |

The depth is the subtle part: measure at 1 tab, its properties (`formatString`, `lineageTag`) at 2, the expression at 3. A Desktop-authored partition in `vendor/repos` uses exactly this step (partition 1, `mode`/`source` 2, the M body 4), which is why the generated partitions were already correct and only the multi-line measure was not.

`ref` ordering is also written: `annotation PBI_QueryOrder` lists the tables, then the
`ref table` block, then `ref cultureInfo`, matching the layout of the Desktop-authored
projects in `vendor/repos` (120 TMDL files, and `description:` appears zero times across
them - that absence is why it is now banned rather than tolerated).

#### Checked by a parser, not a regex

Both Desktop failures above were invisible to the regex checks that preceded them, so
the grammar is now enforced by `scripts/powerbi/tmdl-parse.mjs`: an indentation-aware
TMDL parser plus a schema of legal object types, legal children per parent, and legal
properties per type. It reports the node and line, e.g.

```
model.tmdl: ref must be at column 0, not inside model (line 5)
tables/_Measures.tmdl: "description" is not a measure property
tables/_Measures.tmdl: unknown object type "VAR" (line 88)
```

The schema is calibrated against Desktop itself rather than against my reading of the
docs: **all 21 TMDL files in `vendor/repos` parse with zero findings**, and the suite
asserts that. The two real load failures are pinned as regression tests, including the
subtler variant - an expression at property depth, which fails the same way as one at
column 0:

```bash
pnpm powerbi:test     # 11 parser tests + the questionnaire builder tests
```

### Report layer - audited against a Desktop-authored report

The PBIR layer was diffed, file by file, against `vendor/repos/sift-table`, which was
written by Desktop rather than by this generator:

| File | Result |
| --- | --- |
| `definition.pbir` | identical: `definitionProperties/2.0.0`, `version 4.0`, `datasetReference.byPath` |
| `definition/version.json` | identical: `versionMetadata/1.0.0`, `version 2.0.0` |
| `definition/report.json` | same keys; vendor also carries optional `objects` (report-level formatting), which this build omits deliberately |
| `pages/pages.json`, `page.json` | same schema versions (`pagesMetadata/1.1.0`, `page/2.1.0`) and same key sets |
| `visual.json` | same top-level keys; container schema **was** 2.7.0 while vendor uses 2.12.0 |
| `.platform` | same `platformProperties/2.0.0` metadata keys, `type: Report` |

One real finding, now fixed. The three generators disagreed with each other -
`build-powerbi-report.mjs` emitted `visualContainer/2.9.0`, the other two emitted
`2.7.0` - and the validator accepted only 2.6/2.7, so a package built by the shared
builder would have failed its own check. All three now emit `2.12.0`, the version the
Desktop-authored reference uses. That upgrade is verified by schema diff, not assumed:
2.12.0 validates `visual` against `visualConfiguration/2.7.0`, whose `Visual`,
`VisualLink` and `VisualContainerFormattingObjects` definitions are byte-identical to
the 2.3.0 definitions the old version used, with only five extra tooltip properties
added. The validator accepts 2.6/2.7/2.9/2.12 so previously built packages stay valid.

### Older dossiers - migrated, and what still blocks them

The five pre-existing dossiers (`bounce`, `heer`, `mehak`, `nand`, `prism`) were
generated before any of this was understood. Their source `.docx` files were imported
once and never committed, so `build-powerbi-report.mjs` cannot re-emit them; instead
`scripts/migrate-tmdl-model.mjs` repairs the model documents in place and is idempotent:

```bash
pnpm powerbi:migrate reports/power-bi/bounce reports/power-bi/heer \
  reports/power-bi/mehak reports/power-bi/nand reports/power-bi/prism
```

It moves `ref` lines to column 0, writes `annotation PBI_QueryOrder`, adds
`ref cultureInfo en-US` plus `cultures/en-US.tmdl`, fixes measure-expression depth, and
adds `///` descriptions from the shared `MEASURE_DOCS` map in `scripts/powerbi/tmdl.mjs`.

All five now pass the full validator: 7 pages, 142 visuals, 10 tables, 25 measures each.
Two of the failures they carried were mine, not theirs, and the audit is worth recording:

- **142 visuals per dossier failed the container check** because the validator accepted
  only 2.6/2.7 while `build-powerbi-report.mjs` emits 2.9.0 - the validator rejected
  packages from its own builder. Fixed by accepting 2.6/2.7/2.9/2.12.
- **The theme check contradicted itself**: its message named `good, neutral, bad` as
  importable while the whitelist omitted them, so every KPI-coloured theme failed. Fixed.
- **25 measures per dossier had no description** because the generator never emitted one.
  The docs now live once, in `MEASURE_DOCS`, and both the builder and the migration use them.

### Validation - one command

```bash
node scripts/validate-pbip.mjs reports/power-bi/oracura
node scripts/validate-pbip.mjs reports/power-bi/ORACURA_Module1_PBIP.zip
```

This is the merged replacement for the previous `validate-oracura-pbip.mjs` (model and
data rules) and `verify-pbip-package.mjs` (packaging). They shared the TMDL parser and
the visual walk, and a report was only fully checked if you remembered to run both; now
one command runs every layer and takes a folder or a zip.

Always: `.pbip` → report → `definition.pbir` → semantic model resolve, `pages.json`
matches the page folders, every visual parses, sits inside the canvas, uses a
Desktop-proven container schema, has no null selector or forbidden key, and every field
or measure it references exists in the TMDL. Model side: no BOM, no `//`, every measure
documented, no two measures sharing the same DAX, every rate dividing by a base measure,
every `sortByColumn` target present, every navigation button pointing at a real page,
theme keys importable, resources present, and no absolute paths anywhere in the package.

Optional layers: `--data` adds manifest row counts and a slicer simulation (each slicer
value must return a non-blank base), `--dimensions` plus `--strict-relationship` asserts
that each dimension lives in exactly one table, so a duplicated filter path fails the
build instead of silently blanking visuals.

These follow the rules in
[`vendor/repos/Agentic-PBIP-Template`](../vendor/repos/Agentic-PBIP-Template).

### Visual review (not Power BI's renderer)

```bash
node scripts/render-oracura-report.mjs                    # -> oracura-render/*.html
node scripts/screenshot-render.mjs                        # -> oracura-render/shots/*.png
python3 scripts/contact-sheet.py                          # -> oracura-render/contact-sheet.png

# any scaffolded report renders the same way:
node scripts/render-oracura-report.mjs reports/power-bi/acme
node scripts/screenshot-render.mjs reports/power-bi/acme
python3 scripts/contact-sheet.py reports/power-bi/acme
```

The renderer takes an optional project path, reads whichever `<CODE>.Report` folder it
finds and the CSV in that project's `data/`, and evaluates `Records` / `Avg <column>` as
well as the ORACURA measures. It clears `page-*.html` before writing, so a renamed page
cannot linger in the screenshots. With a path it writes to `<project>/render/`, without
one to `oracura-render/`.

That script reads the generated `page.json`/`visual.json` files and the embedded CSV,
computes each measure with the same filter semantics as the DAX, and lays the result out
at the report's real 1280×720 geometry. It exists because valid PBIR still renders wrong
(overlaps, clipped labels, blank visuals) and Power BI Desktop is not available here, so
layout has to be looked at rather than assumed. Screenshots of all thirteen pages plus two
filtered states are in `oracura-render/shots/`, tiled in `oracura-render/contact-sheet.png`
(regenerate with the three commands above; they need Playwright and, on this sandbox, the
local lib/fontcfg workaround recorded in `scripts/screenshot-render.mjs`).

**Visual variety.** Not everything is a bar chart any more, and no two pages share the
same chart set:

- **00 Overview** - the single-page dashboard, modelled on an operations-style reference:
  pill tabs (real nav buttons), four slicers, three KPI cards (icon chip, honest delta
  line, big number) each paired with a flat **gauge** (top-2 %, NPS on a −100…+100
  scale, daily use %), a dark status card in the reference's idiom (ALL badge, huge
  90.9% on-use, five mini progress bars, label/value rows), the journey **funnel** as
  the bold right-illustration, then a bottom band with a **combo** (evaluations columns
  + NPS line by family), an **area chart** (mean CF10 by age) and the family scoreboard.
  The satisfaction-mix donut lives on 02 Executive.
- 02 Executive: bars + donut + **pie** (NPS bands as a whole).
- 03 Who bought: bars + donut + **line** (respondents by age as a curve) + **area** (when purchased).
- 04 Usage: **area** (frequency), bars, **column chart** (current situation), **pie** (household).
- 05 Experience: **column chart** (avg satisfaction by family) + stacked columns + scoreboard.
- 06 Recommendation: **column chart** (likes) + **treemap** (improve-one themes).
- 08 Where to act: a **matrix heatmap** (family × improve theme, a FillRule gradient on
  cell backgrounds - cream is none, deep orange is the pile-up) + **Key Drivers**
  (`keyDriversVisual`, roles `Analyze` + `ExplainBy`, NPS explained by Family +
  Improve theme - the AI-family names, verified against the PBIR visual-type
  references; `Y`/`Legend` would land nowhere and render empty) + the **waterfall**
  (how the 21 detractors accumulate, restore note below) + a **Drillthrough** button.
  Select a family on the heat grid and the button opens the deep-dive; right-clicking
  any family data point works the same way.

**Waterfall note.** The detractor waterfall originally sat on page 08 at 596×300 next to
the old priority table. When the heat grid and Key Influencers arrived it moved to the
bottom band (48, 522, 580×158) so all three detractor views live on the action page.
- **10 Family deep-dive** - the drillthrough target, configured per the Microsoft
  authoring guide: page.json carries `"type": "Drillthrough"`, a `filterConfig` entry
  with `"howCreated": "Drillthrough"`, and a `pageBinding` parameter whose
  `boundFilter` matches that filter (field = `Evaluations.Family`). Its cards,
  theme/city charts and casework queue all follow the drillthrough filter at runtime.
  The validator verifies button ↔ pageBinding ↔ filter agreement.
- 09 **Journey & heat**: funnel (Evaluations → Current users → Daily users → Promoters,
  driven by a disconnected `_Journey` stage table + `Journey value` SWITCH measure),
  scatter (family mean satisfaction vs mean recommendation, bubble = evaluations),
  treemap (evaluations by city - nine tiles stay readable at 356px, sixty-three city×family
  tiles did not) and a line (mean CF14 by age).

Every new visualType and its queryState roles were verified against the data-goblin PBIR
example catalog (`gauge` = Y + MinValue/MaxValue/TargetValue; combo =
`lineStackedColumnComboChart` = Category + Y + Y2; area/stacked area = Category + Y
(+ Series); waterfall = Category + Y). The gauge scale is pinned by two constant
measures (`Scale max 100`, `Scale min -100`) so cards don't auto-rescale.

**No custom visuals are used, so nothing needs importing.** The funnel is the
built-in `funnel` type (roles Category + Y) and the drivers panel is the built-in
`keyDriversVisual` (roles `Analyze` + `ExplainBy`). Earlier builds wrote
`funnelChart` and `keyInfluencersVisual` - neither is a real PBIR type, so Desktop
rendered them as grey "custom visual" placeholders, a white box and (for the
funnel) an empty spot on Overview. That is fixed: if you ever add a genuine custom
visual you want, download it free from [Microsoft AppSource](https://appsource.microsoft.com/en-us/marketplace/search?query=power+bi+custom+visuals)
and import it via [Import a custom visual](https://learn.microsoft.com/en-us/power-bi/developer/visuals/import-visual).

Page 07 ("Where to act") reads the same base through the detractor lens: detractor-only
theme counts, a family priority matrix ranked by detractor share, and a `Top complaint`
measure (`TOPN` over the theme dimension, excluding "No issue") that names the single fix
per family. Page 04's scoreboard gained per-family top-2 %, NPS and detractor %.

### Navigation

Every page carries two `actionButton` links in the footer (`‹ PREV`, `NEXT ›`, and
`INDEX ›` on the last page), wired through `visualContainerObjects.visualLink` with
`type = 'PageNavigation'` and a `navigationSection` equal to the target page id. The
validator asserts every target resolves, so a button cannot point at a deleted page.
The labels are intentional words (`VERBATIMS`, `ACTIONS`), not truncated page names.

The shape is not assumed - it was checked against the published schemas:

- `visualContainer/2.7.0` types `visual` as `$ref` to `visualConfiguration/2.3.0`,
  closed to eight keys (`visualType`, `query`, `objects`, `visualContainerObjects`,
  `expansionStates`, `syncGroup`, `autoSelectVisualType`, `drillFilterOtherVisuals`).
- `VisualContainerFormattingObjects` declares `visualLink` among its fifteen objects.
- `VisualLink` is closed to fourteen keys including `show`, `type` and
  `navigationSection` - exactly the three emitted here, and nothing else.

The validator now enforces all three whitelists per visual, so a stray key (the classic
"report has issues that could not be resolved" fault, where Desktop drops the visual)
fails the build. Proven with a negative control: injecting `filters` into `visual` and a
bogus container object produced two failures naming the file.

What remains unverified is behaviour, not schema: the geometry and link structure are
checked, the click is not. If Desktop reports an issue on a page, check these two
visuals first.

### Scaffolding the next questionnaire

```bash
node scripts/scaffold-questionnaire-report.mjs \
  --csv path/to/responses.xlsx --code ACME --title "ACME Pulse Q3" [--sheet Raw]
```

Accepts `.xlsx`/`.xlsm` directly (auto-selecting the sheet with the most rows unless
`--sheet` names one) as well as `.csv`. Duplicate headers are disambiguated rather than
silently dropped - exports with two `Comment` columns keep both.

Workbook reading uses `openpyxl` through a portable lookup rather than a hardcoded path:
`OPENPYXL_PATH`, then the inherited `PYTHONPATH`, then `/tmp/xlsxlibs`, then the
interpreter's own site-packages; the first that can `import openpyxl` wins. If none can,
the error names all three ways to fix it instead of failing on a stack trace. Verified
with `PYTHONPATH` unset, with an explicit `OPENPYXL_PATH`, and with the library removed.

Generated reports carry the same navigation as ORACURA: `‹ PREV` / `NEXT ›` on every
page, returning to `INDEX` from the last one, with each target checked before the files
are written.

Profiles the file, decides what is an identifier, a dimension, a numeric measure and a
free-text verbatim, embeds the rows with `#table`, and emits a five-page report
(00 Cover · 01 Overview · 02 Profile · 03 Measures · 04 Responses) plus `profile.json`
recording every inference. It validates its own output before writing the PASS line.
Tested on a support-ticket file with entirely different columns as well as on the
ORACURA export.

**Visual variety, not just bars.** The generated pages use the same visual families the
ORACURA report does, picked from what the profile can actually support:

| Page | Visuals |
| --- | --- |
| 01 Overview | ranked bars **+ a donut** of the same counts (part-to-whole) |
| 02 Profile | two bar panels, then **a treemap** and **a donut** for dimensions 3 and 4 |
| 03 Measures | two mean-by-dimension bar panels, then **a scatter** (two numerics, bubble = count) and **a line** across the widest dimension |
| 04 Responses | KPI cards + the row table |

Degenerate files stay honest instead of drawing empty chrome: with one numeric field the
scatter becomes a second line, with no numerics the whole lower half of page 03 is
skipped, and with fewer than three dimensions the treemap/donut slots are simply not
emitted. All three cases (two numerics, one numeric, dims-only) were generated and
validated; the output also carries `data/responses.csv` - the exact parsed rows - so the
render harness and a reviewer can both read the input.

What it cannot infer - coded themes, driver analysis, benchmarks, the findings page -
is exactly the layer that makes ORACURA worth reading, and stays hand-built. The
scaffolder gets a new questionnaire to a defensible first report in one command; it does
not replace the analysis.

**It is not a Power BI screenshot.** Chart internals, smart titles and font metrics are
approximated; the geometry, measure values and slicer filtering are real. Only Power BI
Desktop can confirm the final pixel output - open the `.pbip` and check page by page.
