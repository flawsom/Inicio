#!/usr/bin/env python3
"""
Round-trip proof for the statistical export worker.

`worker.py` turns a computed dataset into `.sav`/`.dta` bytes and reports every
change it had to make. What nothing in this repository checked until now is the
other half of that promise: that a reader opens the file and finds what the
dataset said. `pyreadstat-export.test.ts` stubs this worker over HTTP, so the
binary output, the labels inside it and the missing codes it declares were never
read back by anything.

This script reads them back. It builds a representative payload — a repeat group's
contact, a two-language instrument, value labels on both a numeric and a string
variable, the four declared missing codes, a blank numeric cell, a blank string
cell, a short row, and variable names that need sanitising — writes both formats
through the worker's own `build()`, reads the bytes with `pyreadstat.read_sav` /
`read_dta`, and prints one line per property.

Three things it refuses to do, because each would make a green run worthless:

  * **Weaken a check to fit what came back.** A property the worker claims and the
    file does not carry is printed as `FAIL`, with the raw evidence, and the exit
    status is non-zero.
  * **Count an unreadable property as a pass.** When pyreadstat's own API cannot
    show a property — rather than the file not having it — that is
    `not verifiable`, and it is printed loudly. It is never `ok`.
  * **Ask the code under test what to expect.** The expected names, labels and
    limits are written out here from the formats' published rules. A test that
    imports the sanitiser it is checking agrees with a bug.

Run it:

    python3 services/pyreadstat/test_roundtrip.py
    python3 services/pyreadstat/test_roundtrip.py --payload body.json --sav out.sav --dta out.dta

The second form checks files a deployed worker really produced: `--payload` is the
exact JSON body the API POSTs to `/write`.

Exit status: 0 when nothing failed, 1 when something did, 2 when the environment
cannot run it at all.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

try:
    import pandas as pd
    import pyreadstat
except ImportError as exc:  # pragma: no cover - a deployment problem, not a code path
    print(f"[roundtrip] pandas/pyreadstat are not installed, so no file can be read back: {exc}")
    raise SystemExit(2)

try:
    import worker  # the module the service itself runs
except ImportError as exc:
    print(f"[roundtrip] worker.py could not be imported: {exc}")
    raise SystemExit(2)
except SystemExit as exc:  # worker.py exits 2 when its own imports are missing
    print(f"[roundtrip] worker.py could not start (exit {exc.code}); install requirements.txt first")
    raise SystemExit(2)


# --------------------------------------------------------------------------- #
# What the two formats allow.
#
# Restated here rather than imported from `worker.LIMITS`/`worker.RESERVED`: these
# are the formats' rules, and a check that reads them from the code it is checking
# cannot see a wrong limit.
# --------------------------------------------------------------------------- #

LIMITS = {"sav": {"name": 64, "label": 256}, "dta": {"name": 32, "label": 80}}
RESERVED = {"_all_", "all", "and", "by", "eq", "ge", "gt", "le", "lt", "ne", "not", "or", "to", "with"}
ALLOWED_NAME = set("0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_")

# Two languages: the instrument is collected in English and Hindi, so a label that
# comes back as mojibake is a respondent reading the wrong question.
HINDI_SCHOOL_LABEL = "विद्यालय का नाम"
HINDI_MAYBE = "हो सकता है"

# The engine's own missing-code table (`packages/engine/src/export/dataset.ts`).
# `system` has no numeric code, so four ranges are expected, not five.
MISSING_CODES = [
    {"code": "system", "numeric": None, "label": "System missing: the question was asked and no answer was recorded"},
    {"code": "not_asked", "numeric": -99, "label": "Not asked: the response ended (or the version changed) before this question"},
    {"code": "skipped", "numeric": -98, "label": "Skipped by logic: the question was not shown to this respondent"},
    {"code": "refused", "numeric": -97, "label": "Refused: the respondent declined to answer"},
    {"code": "dont_know", "numeric": -96, "label": "Don't know: the respondent answered that they do not know"},
]

# The names the writer must arrive at, per format, written out by hand:
#   `school.name`, `contact.phone`   punctuation SPSS and Stata both reject
#   `contact_primary_alternate_mobile_number`  39 characters — past Stata's 32
#   `to`                            an SPSS reserved word
#   `1st_language`                  leading digit
EXPECTED_NAMES = {
    "sav": [
        "response_id",
        "status",
        "school_name",
        "contact_phone",
        "contact_primary_alternate_mobile_number",
        "to_",
        "v_1st_language",
        "school_type",
        "enrolment_total",
        "ranking_score",
        "has_electricity",
        "gps_latitude",
    ],
    "dta": [
        "response_id",
        "status",
        "school_name",
        "contact_phone",
        "contact_primary_alternate_mobile",
        "to_",
        "v_1st_language",
        "school_type",
        "enrolment_total",
        "ranking_score",
        "has_electricity",
        "gps_latitude",
    ],
}


def instrument(fmt, string_labels=True):
    """A representative payload, in exactly the shape `apps/api/.../pyreadstat.ts` posts.

    `string_labels=False` drops every value label that hangs off a string variable.
    That is the fallback the script uses when a writer refuses the representative
    payload, so the rest of the claims can still be checked rather than all of them
    going down with the one that broke.
    """
    columns = [
        {"variable": "response_id", "label": "Response identifier", "numeric": False},
        {"variable": "status", "label": "Response status", "numeric": False},
        {"variable": "school.name", "label": HINDI_SCHOOL_LABEL, "numeric": False},
        {"variable": "contact.phone", "label": "Contact phone (repeat group: contacts)", "numeric": False},
        {"variable": "contact_primary_alternate_mobile_number", "label": "Alternate mobile", "numeric": False},
        {"variable": "to", "label": "Referred to", "numeric": False},
        {"variable": "1st_language", "label": "First language of instruction", "numeric": False},
        {"variable": "school_type", "label": "School type", "numeric": True},
        {"variable": "enrolment_total", "label": "Total enrolment", "numeric": True},
        {"variable": "ranking_score", "label": "Composite ranking score", "numeric": True},
        {"variable": "has_electricity", "label": "Electricity available", "numeric": False},
        {"variable": "gps_latitude", "label": "Site latitude", "numeric": True},
    ]
    rows = [
        ["r-1", "submitted", "School A", "+91 98765 43210", "N/A", "no", "hi", 1, 320, 71.5, "yes", 26.9124],
        # Case 2 is the one that matters: every numeric cell blank (never 0), every
        # string cell empty (never the text "nan"), and a status that is in progress.
        ["r-2", "in_progress", "", "", "", "no", "", None, None, None, "no", None],
        # Case 3 is short. A short row is an old response or a column added later,
        # which is a missing value and not a reason to fail the export.
        ["r-3", "submitted", "School C"],
    ]
    numeric_labels = [
        {"variable": "school_type", "code": "1", "label": "Primary"},
        {"variable": "school_type", "code": "2", "label": "Secondary"},
        {"variable": "school_type", "code": "3", "label": "Senior secondary"},
    ]
    # A yes/no question and the response status: both are string variables whose
    # answers carry labels, which is what almost every real instrument contains.
    labels_on_strings = [
        {"variable": "has_electricity", "code": "yes", "label": "Yes"},
        {"variable": "has_electricity", "code": "no", "label": "No"},
        {"variable": "has_electricity", "code": "maybe", "label": HINDI_MAYBE},
        {"variable": "status", "code": "submitted", "label": "Submitted"},
        {"variable": "status", "code": "in_progress", "label": "In progress"},
    ]
    return {
        "format": fmt,
        "fileLabel": "Inicio statistical export round trip",
        "columns": columns,
        "rows": rows,
        "valueLabels": numeric_labels + (labels_on_strings if string_labels else []),
        "missingCodes": MISSING_CODES,
        "notes": [
            'Blank data cells mean "no value". The kind of missingness is in the missing table, not in the data cell.',
            "Multi-select questions are expanded dichotomously (one 0/1 column per option).",
        ],
    }


# --------------------------------------------------------------------------- #
# The report
# --------------------------------------------------------------------------- #

STATUS_WIDTH = 16


class Report:
    """One line per property, and the count of the ones that failed."""

    def __init__(self):
        self.lines = []

    def ok(self, what, detail=""):
        self._add("ok", what, detail)

    def fail(self, what, detail=""):
        self._add("FAIL", what, detail)

    def na(self, what, detail=""):
        self._add("not verifiable", what, detail)

    def _add(self, status, what, detail):
        self.lines.append((status, what))
        print(f"  {status:<{STATUS_WIDTH}}{what}")
        if detail:
            print(f"  {'':<{STATUS_WIDTH}}{detail}")

    @property
    def failures(self):
        return sum(1 for status, _ in self.lines if status == "FAIL")

    @property
    def count(self):
        return len(self.lines)


# --------------------------------------------------------------------------- #
# Small readers, so the checks below read as sentences
# --------------------------------------------------------------------------- #


def is_blank(cell):
    return cell is None or (isinstance(cell, str) and cell.strip() == "")


def same_value(cell, actual, numeric):
    if numeric:
        try:
            expected = float(cell)
        except (TypeError, ValueError):
            return False
        if pd.isna(actual):
            return False
        return abs(float(actual) - expected) < 1e-9
    return str(actual) == str(cell)


def index_of(columns, variable):
    for index, column in enumerate(columns):
        if str(column.get("variable")) == variable:
            return index
    return None


def labels_on(meta, name):
    table = getattr(meta, "variable_value_labels", None) or {}
    value = table.get(name)
    return value if isinstance(value, dict) else {}


def normalise_labels(table):
    """pyreadstat hands numeric label keys back as floats; the payload sends strings."""
    out = {}
    for key, value in table.items():
        if isinstance(key, float) and key.is_integer():
            key = int(key)
        out[str(key)] = str(value)
    return out


def declared_missing_codes(payload):
    codes = set()
    for entry in payload.get("missingCodes") or []:
        if not isinstance(entry, dict):
            continue
        value = entry.get("numeric")
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            codes.add(int(value) if float(value).is_integer() else float(value))
    return sorted(codes)


# --------------------------------------------------------------------------- #
# The checks
# --------------------------------------------------------------------------- #


def declaration_byte_delta(fmt, payload):
    """How many bytes the declared missing codes add to the file, or None if that failed.

    pyreadstat's reader does not report declared missing ranges — not even for a file
    it wrote itself — so a read-back alone cannot tell a declaration that was written
    from one that was silently dropped. Writing the same payload with and without the
    codes can: bytes that differ are a declaration that reached the file. It is still
    not a *semantic* proof, and this script is careful to say which it has.
    """
    try:
        _fmt, with_codes, _notes, _variables, _cases = worker.build(dict(payload))
        without = dict(payload)
        without["missingCodes"] = []
        _fmt, bare, _notes, _variables, _cases = worker.build(without)
    except Exception:  # noqa: BLE001 - the caller reports this as unverifiable, not as a pass
        return None
    return len(with_codes) - len(bare)


def verify(fmt, path, payload, report, expected_names=None, notes=None, string_labels=True):
    """Read one file back and hold it to everything the payload said."""
    limits = LIMITS[fmt]
    reader = pyreadstat.read_sav if fmt == "sav" else pyreadstat.read_dta
    try:
        frame, meta = reader(path)
    except Exception as exc:  # noqa: BLE001 - a file that will not open is the finding
        report.fail("the file reads back through pyreadstat", f"{type(exc).__name__}: {exc}")
        return

    report.ok(
        "the file reads back through pyreadstat",
        f"{os.path.getsize(path)} bytes, {meta.number_rows} case(s), {meta.number_columns} variable(s)",
    )

    names = [str(name) for name in frame.columns]
    columns = payload["columns"]
    rows = payload["rows"]

    # -- shape ------------------------------------------------------------- #
    if meta.number_rows == len(rows) and len(frame) == len(rows):
        report.ok("the case count", f"{len(rows)} cases")
    else:
        report.fail(
            "the case count",
            f"the payload has {len(rows)} rows; the file reports {meta.number_rows} ({len(frame)} in the frame)",
        )

    if meta.number_columns == len(columns) and len(names) == len(columns):
        report.ok("the variable count", f"{len(columns)} variables")
    else:
        report.fail(
            "the variable count",
            f"the payload has {len(columns)} columns; the file reports {meta.number_columns} ({len(names)} in the frame)",
        )

    # -- names ------------------------------------------------------------- #
    if expected_names is not None:
        if names == expected_names:
            report.ok("the variable names", ", ".join(names))
        else:
            report.fail("the variable names", f"expected {expected_names}; the file holds {names}")

    problems = []
    seen = set()
    for name in names:
        if not name:
            problems.append("a variable name is empty")
            continue
        if len(name) > limits["name"]:
            problems.append(f'"{name}" is {len(name)} characters, past the {limits["name"]} the format allows')
        if name.lower() in RESERVED:
            problems.append(f'"{name}" is a reserved word')
        if name[0].isdigit():
            problems.append(f'"{name}" starts with a digit')
        rejected = sorted({character for character in name if character not in ALLOWED_NAME})
        if rejected:
            problems.append(f'"{name}" holds {rejected}')
        if name.lower() in seen:
            problems.append(f'"{name}" is used twice')
        seen.add(name.lower())
    if problems:
        report.fail("every name is legal for the format", "; ".join(problems))
    elif names:
        report.ok(
            "every name is legal for the format",
            f"longest {max(len(name) for name in names)} of {limits['name']} characters allowed",
        )

    # -- labels ------------------------------------------------------------ #
    actual_labels = ["" if label is None else str(label) for label in (meta.column_labels or [])]
    expected_labels = [
        str(column.get("label") or column.get("variable") or "")[: limits["label"]] for column in columns
    ]
    if actual_labels == expected_labels:
        report.ok("the column labels", f"{len(expected_labels)} label(s) carried")
    else:
        wrong = [
            f"column {index}: sent {expected!r}, read {actual!r}"
            for index, (expected, actual) in enumerate(zip(expected_labels, actual_labels))
            if expected != actual
        ]
        if len(actual_labels) != len(expected_labels):
            wrong.append(f"the file holds {len(actual_labels)} labels for {len(expected_labels)} columns")
        report.fail("the column labels", "; ".join(wrong[:6]))

    non_ascii = [label for label in expected_labels if any(ord(character) > 127 for character in label)]
    if not non_ascii:
        report.na(
            "a non-ASCII label comes back byte-identical",
            "this payload carries no label outside ASCII, so the encoding claim was not exercised",
        )
    else:
        wrong = [
            f"column {index}: sent {expected!r}, read {actual!r}"
            for index, (expected, actual) in enumerate(zip(expected_labels, actual_labels))
            if any(ord(character) > 127 for character in expected) and expected != actual
        ]
        if wrong:
            report.fail("a non-ASCII label comes back byte-identical", "; ".join(wrong[:4]))
        else:
            report.ok("a non-ASCII label comes back byte-identical", "; ".join(non_ascii[:3]))

    # -- a blank cell stays blank ------------------------------------------ #
    blank_cells = 0
    blank_wrong = []
    # Only the rows that exist on both sides: a file with a different case count has
    # already failed above, and reading past the end of it would crash instead of report.
    for row_index in range(min(len(rows), len(frame))):
        row = rows[row_index]
        if not isinstance(row, list):
            continue
        for column_index, column in enumerate(columns):
            if column_index >= len(names):
                continue
            cell = row[column_index] if column_index < len(row) else None
            if not is_blank(cell):
                continue
            blank_cells += 1
            actual = frame.iloc[row_index, column_index]
            if column.get("numeric"):
                if not pd.isna(actual):
                    blank_wrong.append(
                        f'"{names[column_index]}" case {row_index + 1} is blank in the payload and reads back as '
                        f"{actual!r} — 0 is the mistake this checks for"
                    )
            elif str(actual) != "":
                blank_wrong.append(
                    f'"{names[column_index]}" case {row_index + 1} is blank in the payload and reads back as {actual!r}'
                )
    if blank_wrong:
        report.fail('a blank cell reads back as missing, never as 0 or "nan"', "; ".join(blank_wrong[:6]))
    elif blank_cells == 0:
        report.na('a blank cell reads back as missing, never as 0 or "nan"', "this payload has no blank cell")
    else:
        report.ok(
            'a blank cell reads back as missing, never as 0 or "nan"',
            f"{blank_cells} blank cell(s), including the cells of a short row",
        )

    # -- the answers themselves -------------------------------------------- #
    value_cells = 0
    value_wrong = []
    for row_index in range(min(len(rows), len(frame))):
        row = rows[row_index]
        if not isinstance(row, list):
            continue
        for column_index, column in enumerate(columns):
            if column_index >= len(names):
                continue
            cell = row[column_index] if column_index < len(row) else None
            if is_blank(cell):
                continue
            value_cells += 1
            actual = frame.iloc[row_index, column_index]
            if not same_value(cell, actual, bool(column.get("numeric"))):
                value_wrong.append(
                    f'"{names[column_index]}" case {row_index + 1}: sent {cell!r}, read {actual!r}'
                )
    if value_wrong:
        report.fail("every answer that was collected is still that answer", "; ".join(value_wrong[:6]))
    else:
        report.ok(
            "every answer that was collected is still that answer",
            f"{value_cells} non-blank cell(s) compared",
        )

    # -- value labels ------------------------------------------------------ #
    if string_labels is False:
        report.na(
            "value labels on a string variable",
            "not checked: this run used a payload without them, because the writer refused the representative one",
        )
    labels_sent = {}
    for entry in payload.get("valueLabels") or []:
        if not isinstance(entry, dict):
            continue
        labels_sent.setdefault(str(entry.get("variable")), []).append(
            (str(entry.get("code")), str(entry.get("label")))
        )
    if not labels_sent:
        report.na("value labels survive and stay attached", "this payload carries no value labels")
    for variable, pairs in labels_sent.items():
        index = index_of(columns, variable)
        if index is None or index >= len(names):
            report.fail(f'value labels for "{variable}"', "the column is not in the file")
            continue
        name = names[index]
        actual = normalise_labels(labels_on(meta, name))
        numeric_column = bool(columns[index].get("numeric"))
        if not actual:
            if not numeric_column and fmt == "dta":
                # Stata attaches value labels to numbers, so the honest file omits them —
                # and the notes must say so, naming the variable. Absent and unmentioned is
                # the same silent loss as present and attached to the wrong value.
                if notes is None:
                    report.na(
                        f'value labels on the string variable "{name}"',
                        f"the file carries none ({len(pairs)} were sent), which is what Stata requires; whether "
                        "the writer said so is not checkable here, where there is no x-inicio-notes to read",
                    )
                elif any(name in note for note in notes):
                    report.ok(
                        f'value labels on the string variable "{name}"',
                        f"{len(pairs)} omitted by the format and named in the notes, as Stata requires",
                    )
                else:
                    report.fail(
                        f'value labels on the string variable "{name}"',
                        f"the worker sent {len(pairs)} and the file carries none, and no note names the variable: "
                        f"nobody reading this export can learn the labels exist (evidence: {actual!r})",
                    )
            else:
                report.fail(
                    f'value labels for "{name}"',
                    f"the worker sent {len(pairs)} and the file carries none (evidence: {actual!r})",
                )
            continue
        absent = [(code, label) for code, label in pairs if actual.get(code) != label]
        if absent:
            report.fail(
                f'value labels for "{name}"',
                f"absent or different: {absent}; the file holds {actual!r}",
            )
        else:
            report.ok(f'value labels for "{name}"', f"{len(pairs)} label(s) attached")

    # -- the declared missing codes ---------------------------------------- #
    expected_codes = declared_missing_codes(payload)
    evidence = getattr(meta, "missing_ranges", None)
    if not expected_codes:
        report.na(
            "the declared missing codes travel as missing ranges",
            "this payload declares no numeric missing code",
        )
    elif fmt == "dta":
        # There is no declaration to look for: `pyreadstat.write_dta` takes no
        # `missing_ranges` at all, and Stata's own equivalent is the extended missing
        # values (.a…​.z), which the writer does not produce. What is checkable, and what
        # matters, is that the export says so: a Stata file that is silent about this is
        # a researcher who imports it and finds -99 in a mean.
        if notes is None:
            report.na(
                "the writer says a .dta carries no declared missing ranges",
                "a Stata file has nowhere to declare them and the format is silent about it by construction; "
                "whether the writer said so is not checkable here, where there is no x-inicio-notes to read",
            )
        elif any("missing code" in note for note in notes):
            report.ok(
                "the writer says a .dta carries no declared missing ranges",
                f"{expected_codes} documented in the codebook instead of declared, and the notes say why",
            )
        else:
            report.fail(
                "the writer says a .dta carries no declared missing ranges",
                f"no note mentions the missing codes, so nothing tells a reader that {expected_codes} are not in "
                f"the file (notes: {notes!r})",
            )
    elif notes is not None and any("does not accept" in note and "missing ranges" in note for note in notes):
        report.na(
            "the declared missing codes travel as missing ranges",
            f"the installed pyreadstat does not take the argument and the worker said so in its notes: {expected_codes}",
        )
    elif not evidence and (delta := declaration_byte_delta(fmt, payload)) not in (None, 0):
        # Measured, not assumed: the declaration changes the bytes, and pyreadstat's reader
        # still reports nothing — it reports nothing for any file, including one it wrote
        # itself. So the file carries the declaration and the *reader* cannot show it; the
        # claim that SPSS treats those codes as missing rests on pyreadstat's documented
        # contract, which is why this is stated as unverified rather than counted as a pass.
        report.na(
            "the declared missing codes travel as missing ranges",
            f"the declaration adds {delta} byte(s) to the file, so it was written, but pyreadstat's reader "
            f"reports {evidence!r} for a file it wrote itself: reading the declaration back is not something "
            "this reader can do",
        )
    elif evidence is None:
        attributes = sorted(name for name in dir(meta) if "miss" in name.lower())
        report.na(
            "the declared missing codes travel as missing ranges",
            f"pyreadstat exposes no missing ranges for this read; attributes mentioning 'miss': {attributes}",
        )
    else:
        text = repr(evidence)
        absent = [code for code in expected_codes if str(code) not in text]
        if absent:
            report.fail(
                "the declared missing codes travel as missing ranges",
                f"{absent} are not in the file, which reports {text[:300]}",
            )
        else:
            report.ok(
                "the declared missing codes travel as missing ranges",
                f"{expected_codes} present: {text[:200]}",
            )

    # -- the bytes --------------------------------------------------------- #
    size = os.path.getsize(path)
    with open(path, "rb") as handle:
        head = handle.read(1)
    if size > 0 and head != b"{":
        report.ok("the bytes are a real file, not an empty body or an error", f"{size} bytes")
    else:
        report.fail(
            "the bytes are a real file, not an empty body or an error",
            f"{size} bytes, first byte {head!r}",
        )

    # -- the notes --------------------------------------------------------- #
    if notes is None:
        report.na(
            "the writer reported what it had to change",
            "not checked: only files were supplied, so no notes travelled with them",
        )
        return

    if expected_names is not None:
        renames = [
            (str(column.get("variable")), expected_names[index])
            for index, column in enumerate(columns)
            if index < len(expected_names) and str(column.get("variable")) != expected_names[index]
        ]
    else:
        renames = []
    unreported = [
        (original, written)
        for original, written in renames
        if not any(original in note and written in note for note in notes)
    ]
    if not notes and renames:
        report.fail(
            "the writer reported what it had to change",
            f"it renamed {len(renames)} variable(s) and reported nothing",
        )
    elif not notes:
        report.na("the writer reported what it had to change", "it reported no change and this payload needed none")
    elif unreported:
        report.fail("the writer reported what it had to change", f"no note names {unreported}")
    else:
        report.ok(
            "the writer reported what it had to change",
            f"{len(notes)} note(s)"
            + (f", every one of the {len(renames)} rename(s) named" if renames else ""),
        )

    weak = [note for note in notes if len(note.strip()) < 12 or " " not in note.strip()]
    if weak:
        report.fail("every note is a real sentence", f"these are not: {[note[:60] for note in weak]}")
    elif notes:
        report.ok("every note is a real sentence", f"{len(notes)} note(s)")
    for note in notes:
        print(f"       note: {note}")


# --------------------------------------------------------------------------- #
# The two modes
# --------------------------------------------------------------------------- #


def build_file(payload, path, report, label):
    """Write one format through the worker's own `build()`. Returns (notes, bytes)."""
    try:
        _fmt, body, notes, variables, cases = worker.build(payload)
    except Exception as exc:  # noqa: BLE001 - a refused payload is the finding
        report.fail(label, f"worker.build raised {type(exc).__name__}: {exc}")
        return None, None
    with open(path, "wb") as handle:
        handle.write(body)
    report.ok(label, f"{len(body)} bytes, {variables} variable(s), {cases} case(s), {len(notes)} note(s)")
    return notes, body


def run_direct(root):
    """Build both formats here and read them back."""
    reports = []
    for fmt in ("sav", "dta"):
        print(f"\n--- {fmt} ---")
        report = Report()
        payload = instrument(fmt)
        path = os.path.join(root, f"round-trip.{fmt}")
        print(
            f"  {'':<{STATUS_WIDTH}}{len(payload['columns'])} variables x {len(payload['rows'])} cases, "
            f"{len(payload['valueLabels'])} value labels, {len(declared_missing_codes(payload))} missing codes"
        )
        notes, body = build_file(payload, path, report, "the writer produces a file")
        string_labels = True
        if body is None:
            # The writer refused the representative payload. Verify what is left on a
            # payload without the value labels that hang off string variables, and say
            # which claim took the rest of the checks with it.
            string_labels = False
            payload = instrument(fmt, string_labels=False)
            report.na(
                "the representative payload",
                "the writer refused it, so the checks below ran on the same instrument with the value labels that "
                "hang off string variables removed",
            )
            notes, body = build_file(payload, path, report, "the reduced payload is written")
        if body is None:
            reports.append(report)
            continue
        verify(fmt, path, payload, report, expected_names=EXPECTED_NAMES[fmt], notes=notes, string_labels=string_labels)
        reports.append(report)
    return reports


def run_files(payload_path, sav, dta, notes_path=None):
    """Check files a real worker produced, against the body the API posted.

    `--notes` carries the worker's own `x-inicio-notes` for those files, as
    `{"sav": [...], "dta": [...]}` — what the API read off the response headers. Several
    properties are only checkable against them: a value label Stata cannot carry is
    correct **because the writer said so**, and "absent and unmentioned" is the same
    silent loss as "present and wrong". Without the file those checks report
    `not verifiable` rather than passing on a technicality.
    """
    with open(payload_path, "r", encoding="utf-8") as handle:
        payload = json.load(handle)
    by_format: dict = {}
    if notes_path:
        with open(notes_path, "r", encoding="utf-8") as handle:
            loaded = json.load(handle)
        if not isinstance(loaded, dict):
            print("[roundtrip] --notes must be a JSON object keyed by format")
            return []
        by_format = loaded
    reports = []
    for fmt, path in (("sav", sav), ("dta", dta)):
        if not path:
            continue
        print(f"\n--- {fmt}: {path} ---")
        report = Report()
        if not os.path.exists(path):
            report.fail("the file exists", path)
            reports.append(report)
            continue
        notes = by_format.get(fmt)
        notes = [str(note) for note in notes] if isinstance(notes, list) else None
        verify(fmt, path, payload, report, expected_names=None, notes=notes)
        reports.append(report)
    return reports


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Read the statistical export worker's .sav and .dta output back through pyreadstat."
    )
    parser.add_argument("--payload", help="a JSON body exactly as the API POSTs it to /write")
    parser.add_argument("--sav", help="a .sav file the deployed worker wrote for that payload")
    parser.add_argument("--dta", help="a .dta file the deployed worker wrote for that payload")
    parser.add_argument("--keep", help="where to write the files this script builds (default: a new temporary directory)")
    parser.add_argument(
        "--notes",
        help='JSON `{"sav": [...], "dta": [...]}`: the worker\'s own x-inicio-notes for those files',
    )
    args = parser.parse_args(argv)

    print("[roundtrip] the statistical export worker's output, read back")
    print(
        f"[roundtrip] python {sys.version.split()[0]}, "
        f"pyreadstat {getattr(pyreadstat, '__version__', 'unknown')}, pandas {pd.__version__}"
    )

    if (args.sav or args.dta) and not args.payload:
        print("[roundtrip] --sav/--dta need --payload: a file cannot be checked against a payload nobody gave")
        return 2

    if args.payload:
        reports = run_files(args.payload, args.sav, args.dta, args.notes)
        if not reports:
            print("[roundtrip] nothing to check: pass --sav and/or --dta with --payload")
            return 2
    else:
        root = args.keep or tempfile.mkdtemp(prefix="inicio-roundtrip-")
        os.makedirs(root, exist_ok=True)
        print(f"[roundtrip] the files it writes are kept in {root}")
        reports = run_direct(root)

    checks = sum(report.count for report in reports)
    failures = sum(report.failures for report in reports)
    print(f"\n{checks} checks, {failures} failures")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
