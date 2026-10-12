#!/bin/sh
# Runs once on first container start, before migrations.
# Sets the login password for the least-privilege app role created by
# migration 0002. RLS is only enforced for non-superuser roles, so the API
# must connect as app_role — never as the postgres superuser.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_role') THEN
    CREATE ROLE app_role LOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END \$\$;
ALTER ROLE app_role WITH PASSWORD '${APP_DB_PASSWORD:-app_dev_password}';
SQL
