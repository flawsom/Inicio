# `services/pyreadstat` — the statistical export worker

Writes the two export formats the Node API cannot: SPSS `.sav` and Stata `.dta`
(via [`pyreadstat`](https://pypi.org/project/pyreadstat/)). It is the only thing in
the repository that runs Python, and it is **deployed separately**.

## Why it is a separate service

`.sav` and `.dta` are binary formats with real specifications, and there is no
maintained, free, pure-JavaScript writer for either. There is therefore a choice
between a refused export and a Python process, and the refusal is only honest if
the alternative is real — so the worker is real, and the API is its only client.

What the worker is *not* is a second application. The API has already computed the
dataset (columns, rows, value labels, missing codes, codebook) in
`packages/engine/src/export/dataset.ts`; the worker receives that as JSON and turns
it into bytes. It owns no database connection, no tenant context and no policy.
That is deliberate: the tenant boundary is enforced where the responses are read,
not where a file is written.

## Deployment

This repository's install and build steps are Node-only, and that is a rule the
hosting builder depends on: nothing in `package.json`, `vercel.json` or
`netlify.toml` runs `pip`, `uv` or `python`. The worker is deployed on its own, onto
anything that gives it a Python process:

```bash
cd services/pyreadstat
pip install -r requirements.txt
PORT=8099 python3 worker.py            # or: docker run … / uvicorn-style hosting
```

Then point the API at it:

```
PYREADSTAT_WORKER_URL=https://<wherever-the-worker-lives>
PYREADSTAT_TIMEOUT_MS=20000            # optional, this is the default
```

This is the whole integration. **With `PYREADSTAT_WORKER_URL` unset the API keeps
its honest `501`** — `format_not_available`, naming the missing variable — and
`?format=sav` / `?format=dta` stay refused rather than half-produced. With it set,
an unreachable worker is a `502 export_worker_unavailable`, never a file.

A container is the easiest deployment:

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY worker.py .
EXPOSE 8099
CMD ["python3", "worker.py"]
```

It binds `0.0.0.0` and reads `PORT` from the environment, so it fits any host that
injects a port.

## API

### `GET /health`

```json
{ "ok": true, "pyreadstat": "1.3.2", "pandas": "2.2.3" }
```

Use it as a readiness probe, and to tell "the worker is not deployed" apart from
"the worker is deployed and something is wrong" before blaming the export code.

### `POST /write`

Request (this is exactly what the API sends):

```json
{
  "format": "sav",
  "fileLabel": "Clinic visit",
  "columns": [
    { "variable": "response_id", "label": "Response identifier", "numeric": false },
    { "variable": "score", "label": "Score", "numeric": true }
  ],
  "rows": [["9f0…", 7], ["1c4…", null]],
  "valueLabels": [{ "variable": "consent", "code": "yes", "label": "Yes" }],
  "missingCodes": [
    { "code": "not_asked", "numeric": -99, "label": "Not asked — the response ended before this question" },
    { "code": "skipped", "numeric": -98, "label": "Skipped by logic" }
  ],
  "notes": ["the dataset's own notes, carried through to the codebook"]
}
```

Response `200`: the file as the body (`application/octet-stream`), with

| header | meaning |
|---|---|
| `x-inicio-format` | `sav` or `dta` |
| `x-inicio-variables` | how many columns were written |
| `x-inicio-cases` | how many rows were written |
| `x-inicio-notes` | JSON array of every change the writer had to make |

Errors: `400 invalid_json`, `422 invalid_request` (with the reason), `500
write_failed` (with the writer's own message).

## What it reports rather than hides

Every one of these comes back in `x-inicio-notes`:

- **A renamed variable.** SPSS caps names at 64 characters, Stata at 32, both
  forbid most punctuation, and SPSS reserves `all`, `by`, `to`, `with` and
  friends. A name that has to change is reported with both the old and new
  spelling, because a codebook that names a variable the data does not contain is
  worse than a longer name.
- **A truncated label.** 256 characters for `.sav`, 80 for `.dta`.
- **A dropped value label.** Two ways, both reported: a non-numeric code on a
  numeric variable cannot be carried, and a label for a **string variable in a
  `.dta`** cannot either — Stata attaches value labels to numbers, and pyreadstat
  does not refuse such a label, it writes it against the value `0`. So every option
  of every select question in a Stata export would arrive as "the label of 0", with
  nothing to say which option was which. The worker drops them, names the variable
  and counts them, and the codebook that ships beside the file is where they are
  documented.
- **A missing-range omission.** A `.sav` carries the declared missing values
  (`-99`…`-96`) per numeric variable as **one contiguous range**. That is exact for
  four adjacent integer codes, and it is what the format allows: SPSS takes at most
  three *discrete* values per variable, so four separate codes would be refused
  outright — which is what happened before this was checked. A set SPSS cannot express
  in one range is truncated to three codes and the omission is named. See below for how
  far this can be verified, which is not all the way. A `.dta` receives no declaration at all, because
  `pyreadstat.write_dta` has no argument for one: Stata's equivalent is the extended
  missing values (`.a`…`.z`), which the writer does not produce. That is reported in
  the notes of every Stata export rather than left for a reader to discover.

## What it does not do

- **It does not invent missing values.** A blank cell is written as missing
  (system-missing for a numeric column — never `0`). The missing *codes* are
  declared in a `.sav` as discrete missing values on every numeric variable, so
  SPSS reports them as missing rather than as a value somebody answered; a `.dta`
  cannot carry that declaration, and the notes say so. The kind of missingness per
  cell is in the CSV bundle's missing table either way, and the codebook export
  names each code and what it means — which is what a `.dta` reader has to go by.
- **It does not write labels into the data.** Values stay as stored codes;
  the value-label dictionary is what maps them.
- **It does not verify the file it produced.** The worker returns the bytes;
  reading them back through `pyreadstat.read_sav` / `read_dta` is
  `test_roundtrip.py` beside it, which holds every property `build()` claims — the
  names, the column labels, the value labels, a blank cell staying blank, every
  collected answer — to a real read-back. Two of the claims **cannot** be checked
  that way, and the script says so instead of counting them as passes: pyreadstat's
  reader never reports declared missing ranges (even for a file it wrote itself), and
  a `.dta` has none to report.
- **It has no authentication.** It is meant to sit on a private network or behind
  the platform's own ingress. It holds no data at rest and writes to a temporary
  directory that is removed before the response is sent.

## Status

The API-side wiring and both branches (the honest `501` with no worker, a real
file with one) are covered by `apps/api/test/pyreadstat-export.test.ts`, which
stubs this worker over a local HTTP server. The worker's own Python logic —
name sanitisation, label truncation, value-label attachment, the missing ranges —
is exercised by `test_roundtrip.py` (see *Round-trip test* below), which writes
both formats through `build()` and reads them back through `pyreadstat`. It is a
script rather than a CI job for the same reason the worker is a separate service:
this repository's test runner is Node, and the build image has no Python in it.

## Round-trip test

`test_roundtrip.py` is the other half of the promise `worker.py` makes: that a
reader opens the file and finds what the dataset said. It builds a representative
payload — a repeat group's contact, two languages in the labels, value labels on
a numeric *and* on a string variable, the four declared missing codes, a blank
numeric cell, a blank string cell, a short row, and names that need sanitising —
writes both formats through the worker's own `build()`, reads the bytes back with
`pyreadstat.read_sav` / `read_dta`, and prints one line per property:

```
$ python3 services/pyreadstat/test_roundtrip.py
[roundtrip] the statistical export worker's output, read back
[roundtrip] python <version>, pyreadstat <version>, pandas <version>
[roundtrip] the files it writes are kept in /tmp/inicio-roundtrip-xxxxxx

--- sav ---
  12 variables x 3 cases, 8 value labels, 4 missing codes
  ok              the writer produces a file              <n> bytes, 12 variable(s), 3 case(s), <n> note(s)
  ok              the file reads back through pyreadstat  <n> bytes, 3 case(s), 12 variable(s)
  ...

<checks> checks, <failures> failures
```

The versions, the byte sizes and the totals are the only things this example does
not state, because they are what a run decides. Everything else — the instrument,
the counters and the sentence on each line — is what the script prints, and
nothing here records a run that has not happened.

Against files a deployed worker really produced, for a payload the API built:

```
python3 services/pyreadstat/test_roundtrip.py --payload body.json --sav export.sav --dta export.dta \
    --notes notes.json
```

`--notes` carries the worker's own `x-inicio-notes` for those files, as
`{"sav": [...], "dta": [...]}` — what the API read off the response headers. Without
it a few checks report `not verifiable` for a reason that has nothing to do with the
file: a value label Stata cannot carry is correct **because the writer said so**, and
"absent and unmentioned" is the same silent loss as "present and wrong".
`apps/api/scripts/roundtrip-statistical.ts` (`pnpm --filter @inicio/api
roundtrip:statistical`) is what writes all three files: it starts the worker itself,
composes the body with the API's own `statisticalPayload`, and hands the files and the
notes to this script — the whole chain, from the school-ranking template to a
read-back.

Each line is one of three things, and the difference between the last two is the
point of the script:

- `ok` — the property was checked and holds.
- `FAIL` — the worker claims it and the file does not carry it. The raw evidence is
  printed (`what the file holds`), and the exit status becomes 1. Nothing here is
  weakened to make a run green: a `.sav` whose labels are lost is a file a
  researcher discovers is broken at the import step.
- `not verifiable` — pyreadstat's own API cannot show the property, or this
  payload does not exercise it. It is printed as loudly as a failure and is **not**
  counted as a pass, so a claim cannot become true by being unreadable.

The exit status is 1 when anything failed, 2 when `pyreadstat` or `pandas` is not
installed, and the temporary directory holding the files it wrote is printed so
the bytes can be opened in SPSS or Stata by hand afterwards.

`requirements.txt` pins `pyreadstat==1.3.2` and `pandas==2.2.3`; the script prints
the versions it actually ran against, so a run under a different pair says so
rather than implying it checked the pinned ones.
