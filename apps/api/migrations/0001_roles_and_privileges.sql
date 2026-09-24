-- 0001: baseline privileges.
-- Prerequisites (cluster-level, NOT done here because roles are cluster-wide and need CREATEROLE):
--   * role hrforce_migrator (LOGIN, BYPASSRLS) owns the database / public schema and runs migrations;
--   * role hrforce_app (LOGIN, NOSUPERUSER, NOBYPASSRLS) is used by the API at runtime.
-- See apps/api/scripts/create-roles.sql and apps/api/README.md.

-- Nobody but the schema owner (migrator) may create objects in public.
revoke create on schema public from public;
grant usage on schema public to hrforce_app;

-- The runner's bookkeeping table is not for the app.
revoke all on table public.schema_migrations from hrforce_app;

-- Every table / sequence the migrator creates from now on is usable (DML only) by hrforce_app.
-- RLS policies still apply; hrforce_app never owns objects and cannot bypass RLS.
alter default privileges in schema public grant select, insert, update, delete on tables to hrforce_app;
alter default privileges in schema public grant usage, select on sequences to hrforce_app;
alter default privileges in schema public grant execute on functions to hrforce_app;
