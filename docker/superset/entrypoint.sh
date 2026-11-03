#!/bin/sh
set -eu

# The image ships the Superset CLI and /usr/bin/run-server.sh. Migrations and
# role/permission setup are idempotent; the bootstrap script checks for the
# admin and the BI connection before creating either.
superset db upgrade
superset init
python /app/pythonpath/bootstrap.py

exec /usr/bin/run-server.sh
