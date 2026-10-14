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
- **A dropped value label.** Value labels are numeric in both formats, so a
  non-numeric code on a numeric variable cannot be carried; it is reported instead
  of being attached to the wrong number.
- **A missing-range omission**, if the installed `pyreadstat` does not accept the
  argument.

## What it does not do

- **It does not invent missing values.** A blank cell is written as missing
  (system-missing for a numeric column — never `0`), and the missing *codes*
  travel as declared missing ranges rather than being written into the data. The
  kind of missingness per cell is in the CSV bundle's missing table; the `.sav`
  and `.dta` carry the definitions so a statistics package shows them correctly.
- **It does not write labels into the data.** Values stay as stored codes;
  the value-label dictionary is what maps them.
- **It does not verify the file it produced.** Round-tripping the bytes back
  through `pyreadstat.read_sav` belongs in this service's own test suite, which is
  not yet written — see the note below.
- **It has no authentication.** It is meant to sit on a private network or behind
  the platform's own ingress. It holds no data at rest and writes to a temporary
  directory that is removed before the response is sent.

## Status

The API-side wiring and both branches (the honest `501` with no worker, a real
file with one) are covered by `apps/api/test/pyreadstat-export.test.ts`, which
stubs this worker over a local HTTP server. The worker's own Python logic —
name sanitisation, label truncation, value-label attachment, the missing ranges —
is **not yet exercised by a test**, because this repository's test runner is Node
and the worker is deliberately a separate service. That is the first thing to add
here (`pytest` + a round-trip through `pyreadstat.read_sav`).
