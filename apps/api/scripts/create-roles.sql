-- Creates the two cluster-level roles HRForce needs. Run as a superuser, once per cluster, e.g.:
--   psql "$SUPERUSER_URL" -v migrator_password="'…'" -v app_password="'…'" -v db=hrforce -f apps/api/scripts/create-roles.sql
-- Idempotent: existing roles are left in place (their passwords are updated).
select 'create role hrforce_migrator login bypassrls'
  where not exists (select from pg_roles where rolname = 'hrforce_migrator') \gexec
select 'create role hrforce_app login nosuperuser nocreatedb nocreaterole nobypassrls'
  where not exists (select from pg_roles where rolname = 'hrforce_app') \gexec

alter role hrforce_migrator with password :migrator_password;
alter role hrforce_app with password :app_password;

select format('create database %I owner hrforce_migrator', :'db')
  where not exists (select from pg_database where datname = :'db') \gexec
