import { Logger as GraphileLogger, runMigrations as runGraphileMigrations } from 'graphile-worker';
import { Client } from 'pg';
import type { MigrationLogger } from './migrator.js';

/**
 * Installs / upgrades the job queue schema (Graphile Worker, ADR 005, docs/contracts/notifications.md › Worker) as the
 * MIGRATOR, right after the SQL migrations (migration 0012 created the empty schema `graphile_worker` and its default
 * privileges). Never done at API or worker start: the worker role cannot run DDL and fails fast on a stale schema.
 *
 * Then (re)applies the privileges, idempotently, after every install/upgrade — Graphile's own migrations may drop and
 * recreate functions:
 *   - hrforce_worker: DML on every table (+ an allow-all RLS policy where Graphile enabled RLS), sequences, EXECUTE on
 *                     every function of the schema;
 *   - hrforce_app:    EXECUTE on graphile_worker.add_job ONLY (each overload), which is made SECURITY DEFINER (owner:
 *                     the migrator, pinned search_path) — the app enqueues inside its own transaction (rollback = no
 *                     job) without any privilege on the queue tables.
 */
export const WORKER_SCHEMA_GRANTS = `
revoke all on all tables in schema graphile_worker from public, hrforce_app;
revoke all on all sequences in schema graphile_worker from public, hrforce_app;
revoke all on all functions in schema graphile_worker from public, hrforce_app;
grant usage on schema graphile_worker to hrforce_app, hrforce_worker;
grant select, insert, update, delete on all tables in schema graphile_worker to hrforce_worker;
grant usage, select on all sequences in schema graphile_worker to hrforce_worker;
grant execute on all functions in schema graphile_worker to hrforce_worker;
do $$
declare
  f regprocedure;
begin
  for f in
    select p.oid::regprocedure from pg_catalog.pg_proc p
     where p.pronamespace = 'graphile_worker'::regnamespace and p.proname = 'add_job'
  loop
    execute format('alter function %s security definer set search_path = pg_catalog, graphile_worker', f);
    execute format('grant execute on function %s to hrforce_app', f);
  end loop;
  if f is null then
    raise exception 'graphile_worker.add_job not found after the job queue migration';
  end if;
end
$$;
-- Graphile enables row-level security (without policies) on its private tables so that only their owner reaches
-- them; the worker role gets an allow-all policy on each (the queue is not tenant data), nobody else any.
do $$
declare
  t regclass;
begin
  for t in
    select c.oid::regclass from pg_catalog.pg_class c
     where c.relnamespace = 'graphile_worker'::regnamespace and c.relkind in ('r', 'p') and c.relrowsecurity
  loop
    execute format('drop policy if exists hrforce_worker_all on %s', t);
    execute format('create policy hrforce_worker_all on %s for all to hrforce_worker using (true) with check (true)', t);
  end loop;
end
$$;
`;

const silentGraphileLogger = new GraphileLogger(() => () => undefined);

export interface WorkerSchemaOptions {
  connectionString: string;
  logger?: MigrationLogger;
}

export async function installWorkerSchema(options: WorkerSchemaOptions): Promise<void> {
  await runGraphileMigrations({
    connectionString: options.connectionString,
    // Graphile's own console logger is noisy; errors surface as the rejected promise.
    logger: silentGraphileLogger,
  });
  const client = new Client({ connectionString: options.connectionString, application_name: 'hrforce-migrator' });
  await client.connect();
  try {
    await client.query(WORKER_SCHEMA_GRANTS);
  } finally {
    await client.end();
  }
  options.logger?.info({ schema: 'graphile_worker' }, 'job queue schema up to date');
}

