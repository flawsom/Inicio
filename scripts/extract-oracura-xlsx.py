#!/usr/bin/env python3
"""Extract ORACURA Module 1 data DIRECTLY from the original XLSX files.

This is the authoritative extraction path - no hand transcription. The current
evaluations.csv in reports/power-bi/oracura-data/ was originally transcribed from
the extracted-text rendering of the attachments (the XLSX binaries were not
present in the workspace); in November 2026 it was verified field by field
against the full extracted text of both attached workbooks (204/204 respondents,
220/220 evaluations, all KPI-driving fields) - see
reports/power-bi/oracura-data/RECONCILIATION.md. When the binaries are placed
here, this script regenerates the CSV (full product names + full
CF9/CF12/CF13/CF15/CF16 verbatims) and a diff report against the baseline.

Usage:
  PYTHONPATH=/tmp/xlsxlibs python3 scripts/extract-oracura-xlsx.py \
      reports/power-bi/oracura-data/MODULE_1_CUSTOMER_FEEDBACK_Live_Rawdata204N.xlsx \
      [reports/power-bi/oracura-data/MODULE_1_CUSTOMER_FEEDBACK_Live_Rawdata204N_Coded.xlsx]

The coded file's "Codelist" sheet is only used to sanity-check value labels;
all respondent data comes from the raw-data sheet ("204 data").

Wide layout handled: S1-S3 + CF2 Product 1..5/Others, then CF3..CF16 blocks
repeated per product slot (later blocks may omit CF3/CF4 in the header -
missing cells become blank, never guessed).

Family derivation and Like/Improve theme coding are keyword rules below,
applied identically to every verbatim so the coding is reproducible and
auditable. Full verbatims are always kept alongside the coded themes.
"""
import csv, hashlib, pathlib, re, sys
from collections import Counter

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "reports/power-bi/oracura-data"

# Order matters and was verified against the shipped evaluations.csv: every one
# of the 220 product names classifies exactly as the CSV's Family column
# (see the agreement test in RECONCILIATION.md). The rules encode the CSV's
# logic - classify by the product itself, not by separators in the name:
#   * "combo"/"duo" words are bundles. A bare "|" or "&" is not: accessory
#     names carry compatibility lines ("Cable | Compatible with OC150...")
#     and multi-colour variants ("SB300 | SB300 | SB300").
#   * "&" joining a device to toothpaste IS a bundle ("SB300 & Natural
#     Toothpaste"); "|" with toothpaste first is a toothpaste purchase with
#     a brush add-on, and stays Toothpaste.
#   * Accessory patterns name the part (tips/heads/cable/tank/case/rubber),
#     never the "(8 Nozzle Tips)" boilerplate inside a flosser's own name.
# Model codes are the fallback when the product name is a short label:
#   OC* = water flosser, SB*/OB*/KSB*/KB* = electric toothbrush, MB* = manual brush.
# Any device code or word - the Combo guard below requires one of these, so a
# single toothpaste whose name contains "&" is a paste, not a bundle.
_DEVICE = r"(?:oc|sb|ksb|ob|kb)\d|sonic|floss|toothbrush"
# (family, pattern, needs_device). The third element is the hard guard on the
# "& toothpaste" Combo rule: pairing by "&" is only a bundle when a device is
# also named. ("Toothpaste: X & Remineralisation Y" is one paste.) A rule that
# moves or gets reworded does not silently lose the guard, because the guard
# travels with the rule instead of being sniffed out of the pattern text.
FAMILY_RULES = [
    ("Warranty", r"warranty", False),
    ("Combo", r"combo|duo", False),
    ("Combo", r"&.*toothpaste|toothpaste.*&", True),  # device & toothpaste bundle
    ("ManualBrush", r"manual|\bmb\d", False),
    ("Toothpaste", r"toothpaste", False),
    ("Accessory", r"^nozzle tips|nozzle tips for|pack of \d+ nozzle|nozzle tip with|standard tip|brush ?heads?|heads? for (?:ksb|sb|oc)|refill|cable|water tank|tank for|protective case|\bcase\b|rubber|handle|charging point|pocket tip", False),
    ("Flosser", r"floss|\boc\d", False),
    ("Toothbrush", r"toothbrush|sonic|oscillating|\b(?:ksb|sb|ob|kb)\d", False),
]

def family(product: str) -> str:
    p = (product or "").lower()
    for name, pat, needs_device in FAMILY_RULES:
        if not re.search(pat, p):
            continue
        if needs_device and not re.search(_DEVICE, p):
            continue
        return name
    return "Other"

LIKE_RULES = [
    ("Cleaning", r"clean|plaque|debris|residue|particles|whiten"),
    ("Freshness", r"fresh|gum|mouth feel|refresh"),
    ("Ease use", r"easy|convenient|handy|carry|travel|flexible|handle"),
    ("Battery", r"battery|charging|charge|long.?lasting"),
    ("Design colours", r"colour|color|design|look|style|light|timer|mode|settings|feature"),
    ("Taste", r"taste|flavour|flavor|spicy|creamy"),
    ("Claims met", r"claim|as advertised|promise"),
    ("Good use", r"^good|works fine|effective|useful|satisfied|everything"),
    ("Price", r"price|affordable|value|money|cost"),
    ("Service", r"service|support|replac|warranty|available|stock|deliver"),
    ("Leakage", r"leak"),
    ("No issue", r"no improvement|nothing|no issue|all good|perfect|no reason"),
]
IMPROVE_RULES = [
    ("No issue", r"no improvement|nothing|no issue|all good|perfect|satisfied|no problems|not able to say"),
    ("Battery", r"battery|charging|charge"),
    ("Leakage", r"leak|water.*(remain|inside|drain)|tank.*(small|drain|remain)"),
    ("Pressure speed", r"pressure|speed|jet|force|gentle|strong|soft"),
    ("Service", r"service|support|care|contact|response|deliver|available|stock|guidance|instructions"),
    ("Price", r"price|cost|expensive|cheap|offer"),
    ("Quality reliability", r"quality|durab|stopped working|not working|motor|broken|broke|reliab"),
    ("Size portability", r"size|big|large|small|compact|portable|weight|width|diameter|handle"),
    ("Charger Type-C", r"type-?c|charger|cable|pin"),
    ("Nozzle head", r"nozzle|tip|head|bristle|brush head"),
    ("Taste flavour", r"taste|flavour|flavor|spicy|fragrance"),
    ("Water capacity", r"water capacity|tank|capacity|holds"),
    ("Modes settings", r"mode|setting|option|speed option"),
    ("Colours design", r"colour|color|design|look|style"),
]
# Normalise the questionnaire's answer labels to the analysis vocabulary the
# semantic model uses, so an XLSX refresh cannot silently rename a category
# (which would empty a slicer or split a bar).
AGE_MAP = {"18 - 24 years": "18-24", "25 - 34 years": "25-34", "35 - 44 years": "35-44",
           "45 - 54 years": "45-54", "55 years or above": "55+"}
TIMING_MAP = {"<3 months": "<3 months", "3-6 months": "3-6 months", "6-12 months": "6-12 months",
              "12-24 months": "12-24 months", "Don't remember": "Do not remember", "Don’t remember": "Do not remember"}
SITUATION_MAP = {"I currently use this product": "Current",
                 "I used it earlier but no longer use it": "Used earlier",
                 "The product has hardly been used": "Hardly used"}
HOUSEHOLD_MAP = {"Only me": "Only me", "Me and one additional family member": "Me plus one",
                 "Me and more than one family member": "Multi-family", "Someone else": "Someone else"}
USAGE_MAP = {"More frequent": "More frequent", "About the same": "About the same",
             "Less frequent": "Less frequent", "I have stopped using it": "Stopped"}
FREQ_MAP = {"Daily": "Daily", "Several times a week": "Several times a week", "Weekly": "Weekly",
            "Occasionally": "Occasionally", "No longer used": "No longer used"}

def normalize_ws_dashes(value):
    # Excel/Word frequently store en/em dashes and non-breaking spaces in
    # labels; answer maps are keyed on plain hyphens, so normalise before any
    # lookup (a mismatch here silently renames a whole category).
    v = str(value or "")
    for dash in ("\u2010", "\u2011", "\u2012", "\u2013", "\u2014", "\u2212"):
        v = v.replace(dash, "-")
    return " ".join(v.split()).replace("\xa0", " ")

def norm(value, mapping):
    v = normalize_ws_dashes(value)
    if v in mapping:
        return mapping[v]
    # Some labels spell the range with spaces ("18 - 24 years"), others without
    # ("18-24 years"); try the spaced form before giving up.
    return mapping.get(re.sub(r"\s*-\s*", " - ", v), v)

def code_theme(text, rules):
    t = (text or "").strip().lower()
    if not t or t in ("no", "none", "na", "n/a", "good"):
        return "No issue" if any(name == "No issue" for name, _ in rules) else "Other"
    for name, pat in rules:
        if re.search(pat, t):
            return name
    return "Other"

def parse_int(value):
    # Scores arrive as numbers, floats ("4.0") or text ("four"). Non-numeric
    # cells become blank instead of killing the whole extraction.
    v = normalize_ws_dashes(value)
    if not v:
        return ""
    try:
        return int(float(v))
    except ValueError:
        return ""

def norm_header(h):
    return normalize_ws_dashes(h)

def find_sheet(wb):
    for name in wb.sheetnames:
        if "204" in name or "data" in name.lower():
            return wb[name]
    return wb[wb.sheetnames[0]]

def extract(xlsx_path: pathlib.Path):
    from openpyxl import load_workbook
    wb = load_workbook(xlsx_path, data_only=True, read_only=True)
    ws = find_sheet(wb)
    rows = list(ws.iter_rows(values_only=True))
    header = [norm_header(h) for h in rows[0]]
    # Product columns: every CF2 column, in sheet order. Product 1..5 are slots
    # 1..5; "Others" is slot 6 (only used when populated).
    product_cols = []  # (slot_no, col_idx)
    for i, h in enumerate(header):
        if not h.startswith("CF2."):
            continue
        m = re.match(r".*\[Product (\d+)\]", h)
        if m:
            product_cols.append((int(m.group(1)), i))
        elif "Others" in h:
            product_cols.append((6, i))
    product_cols.sort(key=lambda s: s[1])
    if not product_cols:
        raise SystemExit(f"No CF2 product columns found in {xlsx_path} (sheet {ws.title}). Header: {header[:12]}")
    product_start = min(c for _, c in product_cols)
    product_end = max(c for _, c in product_cols)

    # The evaluation blocks follow the CF2 group. They are NOT delimited by CF2
    # columns; the questionnaire repeats CF4..CF16 once per product, and later
    # repetitions may drop or reorder questions (e.g. CF10 then CF4). Segment
    # them greedily: a new block starts when a CF code would repeat inside the
    # current block, so every CF code appears at most once per block.
    blocks = []
    current = []
    seen = set()
    for j in range(product_end + 1, len(header)):
        m = re.match(r"CF(\d+)\.", header[j])
        if not m:
            continue
        code = int(m.group(1))
        if code in seen:
            blocks.append(current)
            current, seen = [], set()
        current.append((j, code))
        seen.add(code)
    if current:
        blocks.append(current)
    if not blocks:
        raise SystemExit(f"No CF evaluation blocks found after the CF2 group in {header[:14]}")
    # Map each block to a product slot in sheet order (block 1 -> Product 1).
    blocks = [(product_cols[i][0] if i < len(product_cols) else 90 + i, product_cols[i][1], cols)
              for i, cols in enumerate(blocks)]
    print(f"  detector: {len(product_cols)} product columns, {len(blocks)} evaluation blocks, "
          f"sizes {[len(b[2]) for b in blocks]}", file=sys.stderr)
    def cf_value(block, code, row):
        for j, c in block[2]:
            if c == int(code.replace("CF", "")):
                return str(row[j]).strip() if row[j] is not None else ""
        return ""
    def cell(row, idx):
        v = row[idx]
        return str(v).strip() if v is not None else ""

    evaluations, respondents = [], {}
    for row in rows[1:]:
        if row[0] is None or str(row[0]).strip() == "":
            continue
        resp = parse_int(row[0])
        if resp == "":
            continue
        age = norm(cell(row, 1), AGE_MAP); gender = cell(row, 2); city = cell(row, 3)
        respondents.setdefault(resp, {"Resp": resp, "Age": age, "Gender": gender, "City": city})
        # CF3 (current situation) lives only in the first block.
        situation = norm(cf_value(blocks[0], "CF3", row) if blocks else "", SITUATION_MAP)
        for blk in blocks:
            slot_no, col_idx = blk[0], blk[1]
            product = cell(row, col_idx)
            if not product:
                continue
            buy = cf_value(blk, "CF4", row); timing = norm(cf_value(blk, "CF5", row), TIMING_MAP)
            household = norm(cf_value(blk, "CF6", row), HOUSEHOLD_MAP)
            freq = norm(cf_value(blk, "CF7", row), FREQ_MAP)
            usage = norm(cf_value(blk, "CF8", row), USAGE_MAP)
            sat = parse_int(cf_value(blk, "CF10", row)); exp = cf_value(blk, "CF11", row)
            rec = parse_int(cf_value(blk, "CF14", row))
            like = cf_value(blk, "CF12", row); improve = cf_value(blk, "CF13", row)
            evaluations.append({
                "Resp": resp, "Age": age, "Gender": gender, "City": city,
                "Family": family(product), "Product": product, "Slot": slot_no,
                "Situation": situation, "BuyReason": buy, "Timing": timing, "Household": household,
                "Frequency": freq, "UsageChange": usage,
                "Satisfaction": sat, "Expectation": exp,
                "Recommend": rec,
                "LikeTheme": code_theme(like, LIKE_RULES), "ImproveTheme": code_theme(improve, IMPROVE_RULES),
                "CF9_ReasonChange": cf_value(blk, "CF9", row), "CF12_LikeMost": like,
                "CF13_ImproveOne": improve, "CF15_RecommendReason": cf_value(blk, "CF15", row),
                "CF16_AnythingElse": cf_value(blk, "CF16", row),
            })
    return evaluations, list(respondents.values())

def baseline_diff(evaluations, baseline_path):
    """Compare an XLSX extraction with an existing CSV and report drift.
    Situation/CF3 is respondent-level, so it is compared per respondent.
    Returns the total drift count (field mismatches in both directions, plus
    unmatched rows either way); main() exits non-zero when it is not zero, so
    a refresh can never silently move the shipped numbers."""
    if not baseline_path.exists():
        return 0
    base = {(r["Resp"], r["Slot"]): r for r in csv.DictReader(open(baseline_path))}
    ext = {(str(e["Resp"]), str(e["Slot"])): e for e in evaluations}
    fields = ["Age", "Gender", "City", "Family", "Timing", "Household", "Frequency",
              "UsageChange", "Satisfaction", "Expectation", "Recommend"]
    drift = {f: 0 for f in fields}
    extra = sum(1 for k in ext if k not in base)    # extracted, absent from CSV
    dropped = sum(1 for k in base if k not in ext)  # in CSV, missing from extraction
    for k, e in ext.items():
        if k not in base:
            continue
        for f in fields:
            if str(base[k][f]) != str(e[f]):
                drift[f] += 1
    noisy = {f: n for f, n in drift.items() if n}
    print(f"Baseline diff: {len(ext)} extracted vs {len(base)} in CSV; "
          f"extra {extra}, dropped {dropped}")
    print("  field drift:", noisy or "none")
    return sum(noisy.values()) + extra + dropped


def main():
    paths = [pathlib.Path(a) for a in sys.argv[1:]]
    if not paths:
        candidates = sorted(OUT_DIR.glob("*.xlsx"))
        candidates = [c for c in candidates if "Module1_Data" not in c.name]
        paths = candidates[:1]
    if not paths or not paths[0].exists():
        raise SystemExit("Original XLSX not found. Place the raw-data XLSX at "
                         "reports/power-bi/oracura-data/ (or pass its path) and re-run. "
                         "The current PBIP was built from the extracted-text rendering "
                         "of the attachments because the XLSX binaries are not in this workspace.")
    evaluations, respondents = extract(paths[0])
    eval_path = OUT_DIR / "evaluations.csv"
    fields = list(evaluations[0].keys()) if evaluations else []
    with open(eval_path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields); w.writeheader(); w.writerows(evaluations)
    digest = hashlib.sha256(pathlib.Path(paths[0]).read_bytes()).hexdigest()[:16]
    print(f"Source: {paths[0].name} (sha256:{digest})")
    print(f"Respondents: {len(respondents)}  Evaluations: {len(evaluations)}")
    print("Family mix:", dict(Counter(e["Family"] for e in evaluations)))
    # Diff vs previous transcribed counts if present in git? Report KPIs for comparison.
    sats = [e["Satisfaction"] for e in evaluations if e["Satisfaction"] != ""]
    recs = [e["Recommend"] for e in evaluations if e["Recommend"] != ""]
    if sats: print(f"Avg satisfaction: {sum(sats)/len(sats):.2f}  (n={len(sats)})")
    if recs: print(f"Avg recommend: {sum(recs)/len(recs):.2f}  (n={len(recs)})")
    print(f"Wrote {eval_path}")
    drift_total = baseline_diff(evaluations, OUT_DIR / "evaluations.baseline.csv")
    if drift_total:
        print(f"DRIFT: {drift_total} mismatches vs baseline - review before rebuilding.", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    main()
