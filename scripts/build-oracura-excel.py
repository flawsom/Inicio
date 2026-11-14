#!/usr/bin/env python3
"""Build ORACURA_Module1_Data.xlsx from reports/power-bi/oracura-data/evaluations.csv.
Requires openpyxl (pip install openpyxl). Run:
  PYTHONPATH=/tmp/xlsxlibs python3 scripts/build-oracura-excel.py
Output: reports/power-bi/oracura/ORACURA_Module1_Data.xlsx
"""
import csv, pathlib, collections, statistics
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.chart import BarChart, Reference
from openpyxl.utils import get_column_letter

ROOT = pathlib.Path(__file__).resolve().parent.parent
CSV = ROOT / "reports/power-bi/oracura-data/evaluations.csv"
OUT = ROOT / "reports/power-bi/oracura/ORACURA_Module1_Data.xlsx"

rows = list(csv.DictReader(open(CSV)))
for r in rows:
    r["Satisfaction"] = int(r["Satisfaction"]); r["Recommend"] = int(r["Recommend"]); r["Resp"] = int(r["Resp"]); r["Slot"] = int(r["Slot"])

respondents = {}
for r in rows:
    respondents.setdefault(r["Resp"], {"Resp": r["Resp"], "Age": r["Age"], "Gender": r["Gender"], "City": r["City"]})

def summary(key, extra=None):
    groups = collections.defaultdict(list)
    for r in rows:
        groups[r[key]].append(r)
    out = []
    for k in sorted(groups):
        g = groups[k]
        out.append([k, len(g), round(len(g)/len(rows), 4),
                    round(statistics.mean(x["Satisfaction"] for x in g), 2),
                    round(statistics.mean(x["Recommend"] for x in g), 2),
                    sum(1 for x in g if x["Recommend"] >= 9), sum(1 for x in g if x["Recommend"] <= 6)])
    return out

wb = Workbook()
hdr_fill = PatternFill("solid", fgColor="B4431D"); hdr_font = Font(bold=True, color="FFFFFF")
def style_header(ws, ncols):
    for c in range(1, ncols+1):
        cell = ws.cell(row=1, column=c); cell.fill = hdr_fill; cell.font = hdr_font; cell.alignment = Alignment(horizontal="center")
    ws.freeze_panes = "A2"
def write_table(ws, header, data):
    ws.append(header); style_header(ws, len(header))
    for row in data: ws.append(row)
    for col in ws.columns:
        ws.column_dimensions[get_column_letter(col[0].column)].width = min(42, max(12, max(len(str(c.value or "")) for c in col) + 2))

# Cover
ws = wb.active; ws.title = "Cover"
cover = [
    ["ORACURA - Module 1 Customer Feedback"], ["Data workbook (companion to ORACURA.pbip)"],
    [], ["Respondents", len(respondents)], ["Product evaluations", len(rows)],
    ["Avg satisfaction (1-5)", round(statistics.mean(r["Satisfaction"] for r in rows), 2)],
    ["Top-2 satisfaction %", round(100*sum(1 for r in rows if r["Satisfaction"]>=4)/len(rows),1)],
    ["Avg recommend (0-10)", round(statistics.mean(r["Recommend"] for r in rows), 2)],
    ["NPS", round(100*(sum(1 for r in rows if r["Recommend"]>=9)-sum(1 for r in rows if r["Recommend"]<=6))/len(rows))],
    ["Better than expected %", round(100*sum(1 for r in rows if r["Expectation"]=="Better than expected")/len(rows),1)],
    [], ["Sheets: Evaluations (grain: respondent x product slot, CF2-CF16) · Respondents (S1-S3) · Summary_* (counts + means) · Charts (native Excel bar charts)"],
    ["Source: MODULE 1 CUSTOMER FEEDBACK_Live_Rawdata204N.xlsx / _Coded.xlsx (core fields transcribed to evaluations.csv; Like/Improve are coded themes from CF12/CF13 verbatims)."],
]
for row in cover: ws.append(row)
ws["A1"].font = Font(size=16, bold=True, color="B4431D"); ws.column_dimensions["A"].width = 34; ws.column_dimensions["B"].width = 90

# Evaluations
ws = wb.create_sheet("Evaluations")
header = list(rows[0].keys())
write_table(ws, header, [[r[h] for h in header] for r in rows])
ws.auto_filter.ref = ws.dimensions

# Respondents
ws = wb.create_sheet("Respondents")
write_table(ws, ["Resp", "Age", "Gender", "City"], [[v["Resp"], v["Age"], v["Gender"], v["City"]] for v in sorted(respondents.values(), key=lambda x: x["Resp"])])

# Summaries
summaries = {
    "Summary_Family": ("Family", summary("Family")),
    "Summary_City": ("City", summary("City")),
    "Summary_Age": ("Age", summary("Age")),
    "Summary_Frequency": ("Frequency", summary("Frequency")),
    "Summary_Expectation": ("Expectation", summary("Expectation")),
    "Summary_BuyReason": ("BuyReason", summary("BuyReason")),
    "Summary_Timing": ("Timing", summary("Timing")),
    "Summary_Situation": ("Situation", summary("Situation")),
}
for name, (key, data) in summaries.items():
    ws = wb.create_sheet(name)
    write_table(ws, [key, "Evaluations", "Share", "AvgSatisfaction", "AvgRecommend", "Promoters", "Detractors"], data)

# Charts sheet referencing summary tables
ws = wb.create_sheet("Charts")
ws["A1"] = "Native Excel charts (live from Summary_* sheets). For the full interactive report open ORACURA.pbip in Power BI Desktop."
ws["A1"].font = Font(italic=True, color="756A5E")
def add_chart(sheet, title, row):
    ch = BarChart(); ch.type = "bar"; ch.title = title; ch.style = 10; ch.legend = None
    data = Reference(wb[sheet], min_col=2, min_row=1, max_row=1+len(summaries[sheet][1]))
    cats = Reference(wb[sheet], min_col=1, min_row=2, max_row=1+len(summaries[sheet][1]))
    ch.add_data(data, titles_from_data=True); ch.set_categories(cats); ch.height = 7; ch.width = 14
    ws.add_chart(ch, f"A{row}")
add_chart("Summary_Family", "Evaluations by family", 3)
add_chart("Summary_City", "Evaluations by city", 20)
add_chart("Summary_Frequency", "Usage frequency", 37)
add_chart("Summary_Expectation", "Expectation gap", 54)

OUT.parent.mkdir(parents=True, exist_ok=True)
wb.save(OUT)
print(f"Wrote {OUT} ({len(rows)} evaluations, {len(respondents)} respondents)")
