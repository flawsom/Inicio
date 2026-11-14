#!/usr/bin/env python3
"""Prove the extractor's family rules reproduce the shipped evaluations.csv.

`family()` is a keyword classifier over the CF2 product name, and the delivered
report's Family slicer, family mix and drillthrough all read its output. That
makes the rules a data contract: a "helpful" reorder can move 30 evaluations to
another family without any error, and every number downstream silently changes.

This test closes that loop without the XLSX binaries (which are not in the
repository): it runs the rules over the product names of the committed CSV and
requires every one to land in the family the CSV already records. It also holds
the two guard cases the CSV cannot demonstrate, because they are about product
names that do not exist yet:

  * "Toothpaste & Remineralisation" is one paste, not a bundle;
  * "SB300 & Natural Toothpaste" is a device-and-paste bundle.

Run: python3 scripts/test-oracura-extractor.py
Exit: 0 agreement, 1 disagreement.
"""
import csv
import importlib.util
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
CSV_PATH = ROOT / "reports/power-bi/oracura-data/evaluations.csv"
EXTRACTOR = ROOT / "scripts/extract-oracura-xlsx.py"

# Product names that exercise a rule no committed row happens to hit. Each one is
# a real pattern in the workbook or a combination the next wave can produce.
GUARD_CASES = [
    ("Natural Toothpaste & Remineralisation", "Toothpaste"),
    ("Toothpaste: Herbal & Sensitive", "Toothpaste"),
    ("SB300 & Natural Toothpaste", "Combo"),
    ("OC150 & KSB200 Duo Pack", "Combo"),
    ("Nozzle Tips Pack 4", "Accessory"),
    ("Oracura Water Flosser OC150 (8 Nozzle Tips)", "Flosser"),
    ("Cable | Compatible with OC150 / OC200", "Accessory"),
]


def load_extractor():
    # The openpyxl import lives inside extract(), so importing the module needs no
    # third-party Python packages - which is what lets this run in CI.
    spec = importlib.util.spec_from_file_location("extract_oracura_xlsx", EXTRACTOR)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    if not CSV_PATH.exists():
        print(f"missing {CSV_PATH}", file=sys.stderr)
        return 2
    extractor = load_extractor()
    rows = list(csv.DictReader(CSV_PATH.open(newline="")))
    bad = [
        (row["Resp"], row["Family"], extractor.family(row["Product"]), row["Product"])
        for row in rows
        if extractor.family(row["Product"]) != row["Family"]
    ]
    for resp, want, got, product in bad:
        print(f"resp {resp}: CSV says {want}, rules say {got}: {product}", file=sys.stderr)

    guards = [
        (product, want, extractor.family(product))
        for product, want in GUARD_CASES
        if extractor.family(product) != want
    ]
    for product, want, got in guards:
        print(f"guard: {product!r} -> {got}, expected {want}", file=sys.stderr)

    print(f"family rules: {len(rows) - len(bad)}/{len(rows)} committed product names match the CSV")
    print(f"family guards: {len(GUARD_CASES) - len(guards)}/{len(GUARD_CASES)} synthetic cases hold")
    return 1 if bad or guards else 0


if __name__ == "__main__":
    sys.exit(main())
