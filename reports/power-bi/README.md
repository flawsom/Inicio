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

1. **00 Cover** — study identity, instrument scale and the evidence boundary.
2. **01 Executive read** — four headline measures, section volume, question mix, analyst read.
3. **02 Instrument architecture** — section table, question volume and planning burden.
4. **03 Routing & quality** — logic references, anchors, rule-load hotspots and constraints.
5. **04 Analysis blueprint** — method families and a question-level analytical contract.
6. **05 Question atlas** — the full instrument, its types, required state and routing.
7. **06 Fieldwork readiness** — data contract, response/answer status and fieldwork notes.

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

## Limits

- No `.pbix` is written. Microsoft does not support creating a model-bearing PBIX outside
  Power BI Desktop; see [`docs/POWER-BI.md`](../../docs/POWER-BI.md).
- The planning burden is a heuristic derived from question type, choice load and routing,
  not a measured interview length.
- The report is a design dossier. It is not a claim about respondents, and it does not
  replace fieldwork, weighting or significance testing.
