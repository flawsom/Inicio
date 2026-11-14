# Data reconciliation - evaluations.csv vs the client workbooks

Date: November 2026. Source files (attached to the project chat):

- `MODULE 1 CUSTOMER FEEDBACK_Live_Rawdata204N (1).xlsx` - raw workbook, sheet `204 data`
- `MODULE 1 CUSTOMER FEEDBACK_Live_Rawdata204N_Coded.xlsx` - coded workbook (`204 data` + `Codelist`)
- `MODULE_1_QNR_CUST_FEEDBACK_V1.4.docx` - questionnaire (CF1-CF16 instrument)
- `Oracura Customer Satisfaction Study_141026CL.pdf` - client findings deck (October 2026)

The XLSX binaries were not present in the workspace, so the workbooks were audited
through their extracted text (full `204 data` table, 120k characters). Every
respondent row (204) and every evaluation slot (220) was compared field by field
against `evaluations.csv` for all KPI- and chart-driving fields: Resp, Age, Gender,
City, product slot, CF3 situation, CF7 frequency, CF8 usage change, CF10
satisfaction, CF11 expectation and CF14 recommendation, plus product-to-family
assignment on all 220 rows. BuyReason, Timing and Household were verified in
aggregate against the client deck (below). Result: **no KPI-affecting divergence
was found** - the CSV is a faithful extraction of the raw workbook, and the PBIP
numbers below are the workbook numbers.

## Counts

| Item | Workbook | CSV | PDF deck |
| --- | ---: | ---: | ---: |
| Respondents | 204 | 204 | 204 |
| Product evaluations | 220 | 220 | - |
| Respondents with 2 products | 16 | 16 | - |
| City distribution (9 cities) | - | exact match | exact match |
| Gender split | - | 56% M / 44% F | 56% / 44% |
| Age under 35 | - | 63.7% | 64% |

## KPI reconciliation

Evaluation grain (220, as the report computes it):

| KPI | Report / XLSX | Client deck (respondent grain) |
| --- | ---: | ---: |
| Avg satisfaction (CF10, 1-5) | 4.15 | 4.1 |
| Top-2 satisfaction | 88.2% (194/220) | 90% |
| Avg recommend (CF14, 0-10) | 8.35 | - |
| NPS | +44 (117 promoters, 21 detractors) | +6 |
| Better than expected (CF11) | 59.5% | ~66% |
| Daily use (CF7) | 52.7% (116) | - |
| Still using (CF3) | 90.9% (200) | 91% |

Respondent grain recomputed from the same CSV (204, first evaluation per
respondent): mean satisfaction 4.12, top-2 87.3%, NPS +41 (105/21), better than
expected 59.3%, current users 90.7% (185), lapsed 8.8% (18).

## Known divergences from the client deck (methodology, not transcription)

1. **NPS +44 (workbook) vs +6 (deck).** The deck's promoter/passive/detractor
   split (21/64/15) cannot be reproduced from CF14 in the workbook at either
   grain (respondent-level promoters are 51.5%, not 21%). The deck therefore
   rests on a different recommendation cut than the CF14 product scores in the
   raw data. The report uses the workbook values and shows the deck number in
   the KPI delta line so the gap is visible, not hidden.
2. **Better than expected 59.5% vs ~66%, top-2 88% vs 90%.** Small gaps in the
   same direction at both grains; consistent with the deck using a
   respondent-level "overall product" answer (the questionnaire repeats
   CF7-CF16 per product, CF3/CF4 once) rather than the per-product scores.
3. **CF12/CF13 themes** are our reproducible keyword coding of the open-ended
   verbatims (documented in `scripts/extract-oracura-xlsx.py`); the full
   verbatims are kept in `CF12_LikeMost` / `CF13_ImproveOne`.
4. **Family** is derived from the CF2 product name (device families, bundles,
   accessories, warranty, toothpaste, manual brush). Items joined with `|` or
   `&` in the product name (e.g. a cable listed with its compatibility line) are
   classified by the product itself, not as bundles. The extractor's
   `FAMILY_RULES` now encode that logic (combo/duo words and device & toothpaste
   bundles only; part names for accessories, never the \"(8 Nozzle Tips)\" boilerplate
   inside a flosser's own name). Agreement test 2026-11-14: rule-based
   `family()` matches the CSV's `Family` column on 220/220 product strings.

## Refresh path

When the XLSX binaries are available, regenerate the CSV with the authoritative
extractor (no transcription) and rebuild:

```bash
PYTHONPATH=/tmp/xlsxlibs python3 scripts/extract-oracura-xlsx.py \
  reports/power-bi/oracura-data/MODULE_1_CUSTOMER_FEEDBACK_Live_Rawdata204N.xlsx \
  reports/power-bi/oracura-data/MODULE_1_CUSTOMER_FEEDBACK_Live_Rawdata204N_Coded.xlsx
node scripts/build-oracura-powerbi.mjs
node scripts/validate-pbip.mjs reports/power-bi/oracura \
  --data reports/power-bi/oracura/data/evaluations.csv \
  --dimensions City,Age,Gender,Family \
  --manifest reports/power-bi/oracura/report-manifest.json --strict-relationship
```

The extractor prints a drift report against `evaluations.baseline.csv`; a clean
run plus a rebuild is the definition of "matches the source".
