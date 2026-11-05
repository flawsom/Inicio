# NAND — Power BI design dossier

Generated from **NAND.docx** on 2026-11-04.

This folder is a **Power BI Project (PBIP)**. Open `NAND.pbip` in Power BI Desktop. The report references `NAND.SemanticModel` by relative path.

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
| Questions | 242 | 30 columns |
| Sections | 3 | 13 columns, 2 measures |
| QuestionTypes | 7 | 10 columns, 1 measure |
| AnalysisFamilies | 8 | 8 columns, 1 measure |
| RoutingAnchors | 10 | 7 columns, 1 measure |
| RoutingHotspots | 10 | 8 columns |
| DataContract | 8 | 6 columns |
| Responses | 0 | 11 columns |
| Answers | 0 | 7 columns |
| _Measures | 0 | 1 columns, 20 measures |

All questionnaire rows are embedded with Power Query `#table`, so the report opens without a file path, gateway or refresh credential.

## Evidence boundary

Questionnaire intelligence only. Response tables are empty unless response rows were explicitly supplied; no synthetic respondents are created.

- 242 instrument rows across 3 sections
- 198 answerable questions; 226 routing rules
- 1 validation constraints; 663 choice options
- 87.9 minutes planning burden (a heuristic, not measured field time)
- 0 response rows; 0 answer rows

Do not describe an empty response base as a finding. The questionnaire-level pages are evidence about the instrument; they are not evidence about respondents.
