# ORACURA - Module 1 Customer Feedback (Power BI)

Open `ORACURA.pbip` in Power BI Desktop. This is a **data-driven** PBIP: the semantic
model embeds 204 respondents and 220 product evaluations
from the Module 1 raw data, so every visual renders immediately - there are no empty charts.

## Pages (477 visuals)

1. **00 Cover** - 27 visuals
2. **01 Findings** - 38 visuals
3. **00 Overview** - 88 visuals
4. **02 Executive** - 25 visuals
5. **03 Who bought what** - 26 visuals
6. **04 Usage & retention** - 28 visuals
7. **05 Experience & satisfaction** - 22 visuals
8. **06 Recommendation & voice** - 25 visuals
9. **07 Voice of customer** - 21 visuals
10. **08 Where to act** - 26 visuals
11. **09 Journey & heat** - 28 visuals
12. **10 Family deep-dive** - 21 visuals
13. **11 Deck reconciliation** - 102 visuals

## Model

| Table | Rows | Grain |
| --- | ---: | --- |
| `Evaluations` | 220 | one row per respondent × product slot (CF2-CF16) |
| `Respondents` | 204 | one row per respondent (S1-S3: Age, Gender, City) |
| `_Measures` | 0 | 28 DAX measures |

**Single dimension path.** `City`, `Age` and `Gender` exist only in `Respondents`.
`Evaluations` joins on `RespId`, so the page 02 slicers cross-filter every chart and
table through that one relationship. Duplicating those columns into `Evaluations` would
create two filter paths, which is what makes slicers blank or double-count.

## KPI snapshot

204 respondents · 220 evaluations · avg satisfaction
**4.15/5** (88.2% top-2) · avg recommend **8.35/10** ·
**NPS +44** · 59.5% better than expected ·
52.7% daily use · 90.9% still using.

## Rebuild

```bash
node scripts/check-syntax.mjs                                    # syntax gate (all scripts)
node scripts/build-oracura-powerbi.mjs                             # PBIP
# package + model + data + slicers, one command:
node scripts/validate-pbip.mjs reports/power-bi/oracura --data reports/power-bi/oracura/data/evaluations.csv --dimensions City,Age,Gender,Family --manifest reports/power-bi/oracura/report-manifest.json --strict-relationship
node scripts/package-oracura.mjs                                   # reproducible zip: fixed mtimes, -X, delete-first
node scripts/validate-pbip.mjs reports/power-bi/ORACURA_Module1_PBIP.zip --data reports/power-bi/oracura/data/evaluations.csv --dimensions City,Age,Gender,Family --manifest reports/power-bi/oracura/report-manifest.json --strict-relationship
PYTHONPATH=/tmp/xlsxlibs python3 scripts/build-oracura-excel.py   # Excel companion
```

To refresh from the client's original workbook:

```bash
PYTHONPATH=/tmp/xlsxlibs python3 scripts/extract-oracura-xlsx.py path/to/raw-data.xlsx
```

The extractor parses the wide `204 data` sheet directly (S1-S3, the CF2 product group,
then the repeated CF4-CF16 blocks - including the third block's reordered
`CF5…CF10, CF4, CF11…CF16`), normalises answer labels, derives product family, codes
CF12/CF13 themes and keeps full verbatims. It prints a drift report against
`data/evaluations.baseline.csv`.

## Excel companion

`ORACURA_Module1_Data.xlsx` - Cover KPIs, `Evaluations`, `Respondents`, eight
`Summary_*` tables and a `Charts` sheet with native Excel bar charts.

## Boundary

No `.pbix` is generated: Microsoft does not support creating a model-bearing PBIX outside
Power BI Desktop. In Desktop, use **File → Save as → Power BI Desktop (.pbix)**.
