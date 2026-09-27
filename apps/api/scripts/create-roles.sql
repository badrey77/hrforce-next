-- Creates the cluster-level roles HRForce needs. Run as a superuser, once per cluster, e.g.:
--   psql "$SUPERUSER_URL" -v migrator_password="'…'" -v app_password="'…'" -v worker_password="'…'" -v db=hrforce \
--        -f apps/api/scripts/create-roles.sql
-- Idempotent: existing roles are left in place (their passwords are updated). Re-run it after an upgrade that adds a
-- role (0012 needs hrforce_worker).
--   hrforce_migrator  owns the schema, runs migrations (BYPASSRLS)
--   hrforce_app       the API's runtime role: DML only, subject to RLS
--   hrforce_worker    the background worker's role (node dist/worker.js): subject to RLS, grants from migration 0012
select 'create role hrforce_migrator login bypassrls'
  where not exists (select from pg_roles where rolname = 'hrforce_migrator') \gexec
select 'create role hrforce_app login nosuperuser nocreatedb nocreaterole nobypassrls'
  where not exists (select from pg_roles where rolname = 'hrforce_app') \gexec
select 'create role hrforce_worker login nosuperuser nocreatedb nocreaterole nobypassrls'
  where not exists (select from pg_roles where rolname = 'hrforce_worker') \gexec

alter role hrforce_migrator with password :migrator_password;
alter role hrforce_app with password :app_password;
alter role hrforce_worker with password :worker_password;

select format('create database %I owner hrforce_migrator', :'db')
  where not exists (select from pg_database where datname = :'db') \gexec
