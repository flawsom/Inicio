#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Ephemeral-sandbox bootstrap (user-space only).
#
# This VM has no root, an empty apt cache and a /tmp that is wiped between
# sessions, so `apt install postgresql` and `docker compose up` are both out.
# What works:
#
#   * pnpm@9.15.0 via corepack — matches packageManager in package.json
#   * PostgreSQL 16.2 from the upstream embedded binary build (zonky
#     embedded-postgres-binaries, the same artifact the `embedded-postgres`
#     npm/pip packages wrap). Unlike the `pgserver` wheel this one ships
#     contrib, so citext/pgcrypto are real and migrations run byte-for-byte
#     exactly as they do against the docker postgres:16 image.
#       -> 127.0.0.1:55432, trust auth
#   * the server binaries are server-only (no psql); use node + `pg` or the
#     API's own tooling for admin queries.
#
# Re-runnable and idempotent: a running server on $PGPORT is left alone.
# ---------------------------------------------------------------------------
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/bin:$PATH"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

PGPORT="${PGPORT:-55432}"
PGDATA="${PGDATA:-/tmp/pgdata}"
PGHOME="${PGHOME:-$HOME/.pg16}"
JAR_URL="https://repo1.maven.org/maven2/io/zonky/test/postgres/embedded-postgres-binaries-linux-amd64/16.2.0/embedded-postgres-binaries-linux-amd64-16.2.0.jar"
JAR="$HOME/.cache/pg16-binaries.jar"

port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$PGPORT") 2>/dev/null && exec 3<&- 3>&-; }

echo "== pnpm =="
# The shim goes somewhere a plain shell already looks: `$HOME/.local/bin` is on
# PATH in this image, while `$HOME/bin` is not, and `corepack enable` cannot
# write to the Node install directory (no root). Without this, `pnpm typecheck`
# and `pnpm test` fail from the workspace scripts, which shell out to `pnpm`.
if ! command -v pnpm >/dev/null 2>&1; then
  for dir in "$HOME/.local/bin" "$HOME/bin"; do
    mkdir -p "$dir"
    printf '#!/bin/sh\nexec corepack pnpm "$@"\n' > "$dir/pnpm"
    chmod +x "$dir/pnpm"
  done
fi
corepack prepare pnpm@9.15.0 --activate >/dev/null
echo "pnpm $(pnpm --version)"

echo "== dependencies =="
cd "$ROOT"
[ -d node_modules ] || pnpm install --frozen-lockfile

echo "== postgres 16.2 =="
if port_open; then
  echo "already accepting connections on $PGPORT"
else
  if [ ! -x "$PGHOME/bin/postgres" ]; then
    mkdir -p "$(dirname "$JAR")" "$PGHOME"
    [ -f "$JAR" ] || curl -sSfL -o "$JAR" "$JAR_URL"
    rm -rf "$PGHOME.tmp" && mkdir -p "$PGHOME.tmp"
    python3 -c "import zipfile,sys;zipfile.ZipFile('$JAR').extract('postgres-linux-x86_64.txz','$PGHOME.tmp')"
    tar -xJf "$PGHOME.tmp/postgres-linux-x86_64.txz" -C "$PGHOME"
    rm -rf "$PGHOME.tmp"
  fi
  export LD_LIBRARY_PATH="$PGHOME/lib"
  "$PGHOME/bin/postgres" --version
  [ -d "$PGDATA/base" ] || {
    rm -rf "$PGDATA"; mkdir -p "$PGDATA"
    "$PGHOME/bin/initdb" -D "$PGDATA" -U postgres --auth=trust >/tmp/initdb.log 2>&1
  }
  "$PGHOME/bin/pg_ctl" -D "$PGDATA" \
    -o "-p $PGPORT -k /tmp -c listen_addresses=127.0.0.1" \
    -l /tmp/pg.log start
  for _ in $(seq 1 30); do port_open && break; sleep 1; done
  port_open && echo "listening on 127.0.0.1:$PGPORT"
fi

echo "== migrations =="
set -a; . "$ROOT/.run/api.env"; set +a
pnpm db:migrate

echo "== ready =="
