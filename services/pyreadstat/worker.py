#!/usr/bin/env python3
"""
The statistical export worker: a dataset as JSON in, a real `.sav` or `.dta` out.

Why this is a separate service
------------------------------
`.sav` and `.dta` are binary formats with real specifications, and the only
maintained free writer for either is `pyreadstat` — Python. This repository's
install and build steps are deliberately Node-only (a hosting builder that has no
Python in it must not be given one to find out), so the API does not grow a Python
toolchain: it POSTs the dataset it has already computed and returns the bytes this
worker hands back. The API is the only client, and it never returns a file from
anywhere else.

What it refuses to do
---------------------
Three things, all of which are the reason this is trustworthy rather than merely
convenient:

  * **It never invents data.** A blank cell stays missing (never `0`). The missing
    *codes* (-99 not asked, -98 skipped by logic, -97 refused, -96 don't know) are
    declared as missing values in a `.sav`, so SPSS knows what those numbers mean
    without any of them being written into a respondent's answer. A `.dta` cannot
    carry that declaration: Stata's own equivalent is the extended missing values
    (`.a`…`.z`), which pyreadstat does not write, so for Stata the codes live in the
    codebook that is exported beside the file and are named in `x-inicio-notes`.
  * **It reports every change it had to make.** SPSS and Stata have their own cap
    on name length, their own reserved words and their own limit on label length,
    and a variable silently renamed is a codebook that no longer matches the data.
    Every rename, truncation and dropped value label comes back in `x-inicio-notes`.
  * **It does not guess.** A format it does not write, or a payload with no
    columns, is a 422 with a reason — never an empty file that a researcher
    discovers is broken at the import step.

Endpoints
---------
    GET  /health    {"ok": true, "pyreadstat": ..., "pandas": ...}

    POST /write     body: JSON (see README.md)
                    200: the file itself, as the response body
                         x-inicio-format     sav | dta
                         x-inicio-variables  the number of columns written
                         x-inicio-cases      the number of rows written
                         x-inicio-notes      JSON array of what was changed
                    400: the body was not JSON
                    422: the body was JSON but not a dataset
                    500: the writer failed (the reason is in the body, never hidden)

Run it:
    pip install -r requirements.txt
    PORT=8099 python3 worker.py
"""

from __future__ import annotations

import json
import os
import re
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    import pandas as pd
    import pyreadstat
except ImportError as exc:  # pragma: no cover - a deployment problem, not a code path
    print(f"[pyreadstat-worker] pandas/pyreadstat are not installed: {exc}", file=sys.stderr)
    sys.exit(2)

# Both formats cap what a name and a label may be. Exceeding a cap is silently
# fatal downstream — SPSS truncates, Stata errors — so the worker decides here and
# says what it decided.
LIMITS = {"sav": {"name": 64, "label": 256}, "dta": {"name": 32, "label": 80}}

# SPSS reserved words, plus its system variable. A file with a variable called `to`
# or `_all_` is a file SPSS refuses to open, and the failure looks like corruption
# rather than like a name collision.
RESERVED = {"all", "and", "by", "eq", "ge", "gt", "le", "lt", "ne", "not", "or", "to", "with", "_all_"}

# A response header has a practical size limit; the notes are a summary, and the
# API logs the full list.
MAX_NOTES = 40

# Arguments that only some pyreadstat releases accept under the name this worker
# uses. They are dropped one at a time, and each one is named in the notes: a file
# that quietly lost its value labels *and* its missing-value declaration would be
# discovered at the import step, which is the failure this worker exists to avoid.
OPTIONAL_ARGUMENTS = ("missing_ranges", "file_label")


def _dropped_note(argument: str) -> str:
    if argument == "missing_ranges":
        return "this pyreadstat build does not accept declared missing ranges; the file carries values only"
    if argument == "file_label":
        return "this pyreadstat build does not accept a file label; the file carries values only"
    return f"this pyreadstat build does not accept {argument}; the file carries values only"


def _missing_declaration(codes: list[object]) -> tuple[list[dict[str, object]], str | None]:
    """SPSS's declaration of which numbers mean "missing", and what it could not take.

    SPSS accepts at most **three discrete values** per variable, or one range. The
    engine's codes (-99, -98, -97, -96) are contiguous integers, so one range states
    them exactly and nothing is dropped — and a range is what a reader sees in the
    missing-values dialog, which is the point of declaring them at all. A set that is
    neither small enough nor contiguous is truncated to three values and the omission
    is reported, because a missing code that silently stops being missing is a
    respondent's non-answer arriving in the analysis as a value.
    """
    numeric = sorted(code for code in codes if isinstance(code, (int, float)))
    if not numeric:
        return [], None
    if len(numeric) <= 3:
        return [{"lo": code, "hi": code} for code in numeric], None
    contiguous = all(float(later) - float(earlier) == 1 for earlier, later in zip(numeric, numeric[1:]))
    if contiguous:
        return [{"lo": numeric[0], "hi": numeric[-1]}], None
    kept, dropped = numeric[:3], numeric[3:]
    omission = (
        "SPSS accepts at most three discrete missing values per variable, so only "
        + ", ".join(str(code) for code in kept)
        + " are declared missing in the .sav; "
        + ", ".join(str(code) for code in dropped)
        + " are documented in the codebook but not declared in the file"
    )
    return [{"lo": code, "hi": code} for code in kept], omission


def _write(writer, frame, path: str, kwargs: dict, notes: list[str]) -> None:
    """Write the file, dropping and naming only the argument the writer refuses.

    A `TypeError` is the only signal an optional argument is unsupported, and the
    message names the argument in every pyreadstat release that has one, so the
    argument it names is the argument that goes — not all of them. A `TypeError`
    that names none of them is re-raised: at that point the worker does not know
    what it is dropping, and guessing is how a file becomes quietly wrong.
    """
    try:
        writer(frame, path, **kwargs)
        return
    except TypeError as exc:
        named = next((key for key in OPTIONAL_ARGUMENTS if key in kwargs and key in str(exc)), None)
        if named is None:
            raise
        kwargs.pop(named)
        notes.append(_dropped_note(named))
        _write(writer, frame, path, kwargs, notes)


def _variable_name(raw: str, limit: int, taken: set[str]) -> tuple[str, list[str]]:
    """A legal, unique variable name, plus what had to change to get there."""
    original = str(raw or "")
    name = re.sub(r"[^0-9A-Za-z_]+", "_", original)
    name = re.sub(r"_+", "_", name).strip("_")
    notes: list[str] = []

    if not name:
        name = "v"
        notes.append(f'variable "{original}" had no characters a statistical package accepts and is written as "v"')
    if name[0].isdigit():
        name = f"v_{name}"
    if name.lower() in RESERVED:
        name = f"{name}_"
    if len(name) > limit:
        name = name[:limit]

    candidate = name
    suffix = 1
    # SPSS is case-insensitive, so uniqueness is decided case-insensitively. The
    # case itself is preserved: lowercasing a variable is a different change than
    # renaming one, and it is not this worker's to make.
    while candidate.lower() in taken:
        suffix += 1
        tail = f"_{suffix}"
        candidate = f"{name[: limit - len(tail)]}{tail}"

    taken.add(candidate.lower())
    if candidate != original:
        notes.append(f'variable "{original}" is written as "{candidate}"')
    return candidate, notes


def build(payload: dict) -> tuple[str, bytes, list[str], int, int]:
    """Return (format, file bytes, notes, variable count, case count)."""
    fmt = str(payload.get("format", "")).lower()
    if fmt not in LIMITS:
        raise ValueError(f"format must be sav or dta, not {fmt!r}")
    limits = LIMITS[fmt]

    columns = payload.get("columns")
    if not isinstance(columns, list) or not columns:
        raise ValueError("columns must be a non-empty list")
    rows = payload.get("rows") or []
    if not isinstance(rows, list):
        raise ValueError("rows must be a list")

    notes: list[str] = [str(n) for n in (payload.get("notes") or []) if isinstance(n, (str, int, float))]

    names: list[str] = []
    original_of: dict[str, str] = {}
    labels: list[str] = []
    is_numeric: list[bool] = []
    taken: set[str] = set()

    for column in columns:
        variable = str(column.get("variable") or "")
        name, added = _variable_name(variable, limits["name"], taken)
        notes.extend(added)

        label = str(column.get("label") or variable)
        if len(label) > limits["label"]:
            label = label[: limits["label"]]
            notes.append(f'the label for "{name}" is longer than {limits["label"]} characters and is truncated')

        names.append(name)
        original_of[name] = variable
        labels.append(label)
        is_numeric.append(bool(column.get("numeric")))

    # A row may be short (an old response, a column added later). A short row is a
    # missing value, which is what the dataset already says — not a reason to fail.
    frame_data: dict[str, object] = {}
    for index, name in enumerate(names):
        values = [row[index] if isinstance(row, list) and index < len(row) else None for row in rows]
        series = pd.Series(values, dtype="object")
        if is_numeric[index]:
            # Blank becomes NaN (system-missing) rather than 0: a numeric column
            # where an unanswered question reads as zero is the single most
            # expensive mistake an export can make.
            frame_data[name] = pd.to_numeric(series, errors="coerce")
        else:
            frame_data[name] = series.where(series.notna(), "").astype(str)

    frame = pd.DataFrame(frame_data, columns=names)

    index_of = {name: index for index, name in enumerate(names)}

    value_labels: dict[str, dict[object, str]] = {}
    dropped_string_labels: dict[str, int] = {}
    for entry in payload.get("valueLabels") or []:
        variable = str(entry.get("variable") or "")
        name = next((candidate for candidate, original in original_of.items() if original == variable), None)
        if name is None:
            # A label for a column that is not in this export. Nothing to attach it to.
            continue
        code = entry.get("code")
        label = str(entry.get("label") or "")
        if not is_numeric[index_of[name]] and fmt == "dta":
            # Stata attaches value labels to numbers, and pyreadstat does not refuse a
            # label for a string variable: it writes it against the value 0, so every
            # option of every select question would arrive as "the label of 0" with
            # nothing to say which option was which. Dropped, counted, and named.
            dropped_string_labels[name] = dropped_string_labels.get(name, 0) + 1
            continue
        if is_numeric[index_of[name]]:
            try:
                numeric_code = float(code)
            except (TypeError, ValueError):
                notes.append(
                    f'value label "{label}" could not be attached to the numeric variable "{name}": '
                    f"its code {code!r} is not a number"
                )
                continue
            code = int(numeric_code) if numeric_code.is_integer() else numeric_code
        else:
            code = "" if code is None else str(code)
        value_labels.setdefault(name, {})[code] = label

    # The engine's missing-code table is global, so the codes apply to every numeric
    # column. SPSS takes them per variable, as a list of discrete values.
    missing_codes: list[object] = []
    for entry in payload.get("missingCodes") or []:
        value = entry.get("numeric")
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            missing_codes.append(int(value) if float(value).is_integer() else float(value))
    missing_ranges: dict[str, list[dict[str, object]]] = {}
    declaration, omission = _missing_declaration(missing_codes)
    if fmt == "sav" and declaration:
        for index, name in enumerate(names):
            if is_numeric[index]:
                missing_ranges[name] = declaration
    if omission:
        notes.append(omission)

    for name, count in dropped_string_labels.items():
        notes.append(
            f'Stata attaches value labels to numbers, so the {count} label(s) of the string variable "{name}" '
            "are not in the .dta; the codebook exported with it has them"
        )

    if fmt == "dta" and missing_codes:
        notes.append(
            "a .dta carries no declared missing ranges (pyreadstat writes no extended missing values), "
            "so the missing codes are documented in the codebook rather than declared in the file"
        )

    file_label = str(payload.get("fileLabel") or "Inicio export")[: limits["label"]]
    writer = pyreadstat.write_sav if fmt == "sav" else pyreadstat.write_dta
    kwargs: dict[str, object] = {
        "column_labels": labels,
        "variable_value_labels": value_labels,
        "file_label": file_label,
    }
    if missing_ranges:
        kwargs["missing_ranges"] = missing_ranges
    if fmt == "dta":
        # 14 is readable by Stata 14 and everything after it; the default is fine
        # too, but naming it means a reader knows what they got.
        kwargs["version"] = 14

    with tempfile.TemporaryDirectory() as directory:
        path = os.path.join(directory, f"export.{fmt}")
        _write(writer, frame, path, kwargs, notes)
        with open(path, "rb") as handle:
            body = handle.read()

    return fmt, body, notes[:MAX_NOTES], len(names), len(rows)


class Handler(BaseHTTPRequestHandler):
    server_version = "inicio-pyreadstat/1.0"

    def _send(self, status: int, body: bytes, content_type: str, extra: dict[str, str] | None = None) -> None:
        self.send_response(status)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(body)))
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, payload: dict) -> None:
        self._send(status, json.dumps(payload).encode("utf-8"), "application/json")

    def do_GET(self) -> None:  # noqa: N802 - the stdlib's spelling
        if self.path.split("?")[0] != "/health":
            self._json(404, {"error": "not_found"})
            return
        self._json(
            200,
            {
                "ok": True,
                "pyreadstat": getattr(pyreadstat, "__version__", "unknown"),
                "pandas": pd.__version__,
            },
        )

    def do_POST(self) -> None:  # noqa: N802
        if self.path.split("?")[0] != "/write":
            self._json(404, {"error": "not_found"})
            return

        length = int(self.headers.get("content-length") or 0)
        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError as exc:
            self._json(400, {"error": "invalid_json", "detail": str(exc)})
            return
        if not isinstance(payload, dict):
            self._json(422, {"error": "invalid_request", "detail": "the body must be a JSON object"})
            return

        try:
            fmt, body, notes, variables, cases = build(payload)
        except ValueError as exc:
            self._json(422, {"error": "invalid_request", "detail": str(exc)})
            return
        except Exception as exc:  # noqa: BLE001 - a writer failure is reported, never hidden
            self._json(500, {"error": "write_failed", "detail": str(exc)})
            return

        self._send(
            200,
            body,
            "application/octet-stream",
            {
                "x-inicio-format": fmt,
                "x-inicio-variables": str(variables),
                "x-inicio-cases": str(cases),
                # ASCII-only JSON: an HTTP header is latin-1, so a label with an
                # accented character in it would otherwise break the response.
                "x-inicio-notes": json.dumps(notes, ensure_ascii=True),
            },
        )

    def log_message(self, fmt: str, *args: object) -> None:
        sys.stderr.write("[pyreadstat-worker] " + (fmt % args) + "\n")


def main() -> None:
    port = int(os.environ.get("PORT", "8099"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(
        f"[pyreadstat-worker] listening on 0.0.0.0:{port} "
        f"(pyreadstat {getattr(pyreadstat, '__version__', 'unknown')})",
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
