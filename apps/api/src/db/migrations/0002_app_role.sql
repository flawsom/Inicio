-- 0002: least-privilege application role.
-- Un-comments and hardens the "App role (least privilege)" block that ships
-- commented-out at the bottom of specs/schema.sql.
--
-- Why this is load-bearing (verified, see BUILD.md §6): PostgreSQL row-level
-- security is BYPASSED for superusers and for any role holding BYPASSRLS, and
-- it is not applied to a table's owner unless FORCE ROW LEVEL SECURITY is on.
-- The API must therefore connect as a non-superuser role or multi-tenant
-- isolation is silently a no-op. specs/schema.sql already FORCEs RLS; this role
-- makes the enforcement apply to the API connection.
--
-- The role's login password is NOT set here (no secrets in migrations). Local
-- compose sets it via docker/postgres-init; production sets it out-of-band.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_role') THEN
    CREATE ROLE app_role LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO app_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_role;

-- Tables/sequences created by future migrations (e.g. 0003 DPDP) inherit these.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_role;
