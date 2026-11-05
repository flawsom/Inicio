# BOUNCE — Power BI design dossier

Generated from **BOUNCE.docx** on 2026-11-04.

This folder is a **Power BI Project (PBIP)**. Open `BOUNCE.pbip` in Power BI Desktop. The report references `BOUNCE.SemanticModel` by relative path.

## What is in the report

1. **00 Cover** — 28 visuals
2. **01 Executive read** — 21 visuals
3. **02 Instrument architecture** — 21 visuals
4. **03 Routing & quality** — 21 visuals
5. **04 Analysis blueprint** — 17 visuals
6. **05 Question atlas** — 15 visuals
7. **06 Fieldwork readiness** — 19 visuals

## What the model contains

| Table | Rows | Grain |
| --- | ---: | --- |
| Questions | 116 | 30 columns |
| Sections | 9 | 13 columns, 2 measures |
| QuestionTypes | 6 | 10 columns, 1 measure |
| AnalysisFamilies | 6 | 8 columns, 1 measure |
| RoutingAnchors | 10 | 7 columns, 1 measure |
| RoutingHotspots | 10 | 8 columns |
| DataContract | 8 | 6 columns |
| Responses | 0 | 11 columns |
| Answers | 0 | 7 columns |
| _Measures | 0 | 1 columns, 20 measures |

All questionnaire rows are embedded with Power Query `#table`, so the report opens without a file path, gateway or refresh credential.

## Evidence boundary

Questionnaire intelligence only. Response tables are empty unless response rows were explicitly supplied; no synthetic respondents are created.

- 116 instrument rows across 9 sections
- 80 answerable questions; 88 routing rules
- 28 validation constraints; 220 choice options
- 34.0 minutes planning burden (a heuristic, not measured field time)
- 0 response rows; 0 answer rows

Do not describe an empty response base as a finding. The questionnaire-level pages are evidence about the instrument; they are not evidence about respondents.
