-- 0012: notifications, the background worker's role and its jobs' database side (docs/contracts/notifications.md,
-- ADR 005).
--   notification             one in-app notification for ONE recipient (user_id); read_at null = unread
--   notification_preference  per user and type: send an email or not (no row = the type's default)
--   hrforce_worker           the worker process's role (created by apps/api/scripts/create-roles.sql): RLS applies,
--                            each job sets app.company_id itself; SELECT on public, a few writes, cleanup functions
--   graphile_worker          schema of the job queue. Created here (owner: the migrator); its tables and functions
--                            are installed by the migrate step right after the SQL migrations
--                            (src/platform/db/worker-schema.ts), which also grants them (the worker: everything;
--                            hrforce_app: EXECUTE on graphile_worker.add_job only, made SECURITY DEFINER).
--
-- Row-level security of the two new tables = the standard tenant policy PLUS a RESTRICTIVE policy for hrforce_app on
-- SELECT/UPDATE/DELETE: `user_id = app.user_id` — a user only ever reads or marks their own rows, even inside their
-- company. INSERT is only tenant-bound (the actor creates notifications for others; no RETURNING, which would need
-- the SELECT policy). The restrictive policies target hrforce_app only: the worker (system actor, app.user_id empty)
-- reads a notification to mail it and deletes old read ones, still bound to its company by the tenant policy.
--
-- Audit: notification_preference has the audit trigger (keyed on user_id); notification is exempt
-- (tools/guardrails/audit-exempt.json: high volume, derived from audited workflow/leave events).
-- Live updates: an AFTER INSERT trigger sends NOTIFY hrforce_notifications with {companyId, userId, id} — in the
-- inserting transaction, so it is delivered on commit only.

do $$
begin
  if not exists (select from pg_catalog.pg_roles where rolname = 'hrforce_worker') then
    raise exception 'role hrforce_worker is missing: create it with apps/api/scripts/create-roles.sql (apps/api/README.md › Roles) before migrating';
  end if;
end
$$;

-- ---------------------------------------------------------------------------------------------------------
create table public.notification (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company (id),
  user_id uuid not null,
  type text not null,
  subject_type text not null,
  subject_id uuid not null,
  -- names / dates / codes needed to render it; never balances, reasons or other sensitive values
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  read_at timestamptz,
  constraint notification_company_id_id_uk unique (company_id, id),
  -- one notification per recipient, type and subject: a repeated hook is a no-op (insert … on conflict do nothing)
  constraint notification_once_uk unique (company_id, user_id, type, subject_type, subject_id),
  constraint notification_type_ck check (type ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$' and char_length(type) <= 64),
  constraint notification_subject_type_ck check (subject_type in ('workflow_task', 'leave_request')),
  constraint notification_data_ck check (jsonb_typeof(data) = 'object')
);

create index notification_inbox_idx on public.notification (company_id, user_id, created_at desc, id desc);
create index notification_unread_idx on public.notification (company_id, user_id) where read_at is null;
create index notification_read_at_idx on public.notification (company_id, read_at) where read_at is not null;

alter table public.notification enable row level security;
alter table public.notification force row level security;
create policy notification_tenant_isolation on public.notification
  using (company_id = current_setting('app.company_id', true)::uuid);
create policy notification_own_select on public.notification as restrictive for select to hrforce_app
  using (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
create policy notification_own_update on public.notification as restrictive for update to hrforce_app
  using (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
create policy notification_own_delete on public.notification as restrictive for delete to hrforce_app
  using (user_id = nullif(current_setting('app.user_id', true), '')::uuid);

-- Only read_at moves, and only from null to a time (marking read is final).
create function public.notification_guard() returns trigger
  language plpgsql
as $$
begin
  if new.id is distinct from old.id or new.company_id is distinct from old.company_id or new.user_id is distinct from old.user_id
     or new.type is distinct from old.type or new.subject_type is distinct from old.subject_type
     or new.subject_id is distinct from old.subject_id or new.data is distinct from old.data
     or new.created_at is distinct from old.created_at then
    raise exception 'notification: only read_at may change' using errcode = 'check_violation', constraint = 'notification_immutable';
  end if;
  if old.read_at is not null and new.read_at is distinct from old.read_at then
    raise exception 'notification: already read' using errcode = 'check_violation', constraint = 'notification_read_final';
  end if;
  return new;
end
$$;

create trigger notification_guard_tg
  before update on public.notification
  for each row execute function public.notification_guard();

-- Fan-out for the SSE stream (one LISTEN connection per API process): the payload names the row only; the API
-- re-reads it under RLS as the recipient before sending anything.
create function public.notification_notify() returns trigger
  language plpgsql
as $$
begin
  perform pg_catalog.pg_notify('hrforce_notifications',
    pg_catalog.json_build_object('companyId', new.company_id, 'userId', new.user_id, 'id', new.id)::text);
  return null;
end
$$;

create trigger notification_notify_tg
  after insert on public.notification
  for each row execute function public.notification_notify();

-- ---------------------------------------------------------------------------------------------------------
create table public.notification_preference (
  company_id uuid not null references public.company (id),
  user_id uuid not null,
  type text not null,
  email boolean not null,
  updated_at timestamptz not null default now(),
  constraint notification_preference_pk primary key (company_id, user_id, type),
  constraint notification_preference_type_ck check (type ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$' and char_length(type) <= 64)
);

alter table public.notification_preference enable row level security;
alter table public.notification_preference force row level security;
create policy notification_preference_tenant_isolation on public.notification_preference
  using (company_id = current_setting('app.company_id', true)::uuid);
create policy notification_preference_own_select on public.notification_preference as restrictive for select to hrforce_app
  using (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
create policy notification_preference_own_update on public.notification_preference as restrictive for update to hrforce_app
  using (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
create policy notification_preference_own_delete on public.notification_preference as restrictive for delete to hrforce_app
  using (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
-- a preference is written by its owner only (the upsert of PUT /me/notification-preferences)
create policy notification_preference_own_insert on public.notification_preference as restrictive for insert to hrforce_app
  with check (user_id = nullif(current_setting('app.user_id', true), '')::uuid);

create trigger audit_capture_tg after insert or update or delete on public.notification_preference
  for each row execute function audit.capture('user_id');

-- Nobody deletes through the app (a preference is switched, a notification is marked read; old read ones are
-- removed by the worker's cleanup job).
revoke delete on table public.notification, public.notification_preference from hrforce_app;

-- ---------------------------------------------------------------------------------------------------------
-- hrforce_worker: SELECT on the tenant tables (RLS applies: a job sets app.company_id first), the writes of its
-- jobs (accrual rows; deleting old read notifications), nothing on the migration bookkeeping.
grant usage on schema public to hrforce_worker;
grant select on all tables in schema public to hrforce_worker;
revoke all on table public.schema_migrations from hrforce_worker;
alter default privileges in schema public grant select on tables to hrforce_worker;
grant insert on table public.leave_ledger to hrforce_worker;
grant delete on table public.notification to hrforce_worker;

-- The company loop of the cron jobs: every company id. `company` is behind RLS (id = app.company_id), so the worker
-- lists the tenants through this SECURITY DEFINER function (ids only).
create function public.job_company_ids()
  returns setof uuid
  language sql
  stable
  security definer
  set search_path = pg_catalog, public
as $$
  select c.id from public.company c order by c.code
$$;

-- ---------------------------------------------------------------------------------------------------------
-- Identity data the jobs need (hrforce_worker has no privilege on auth tables either).
--   auth.notification_recipient(user_id)  mail address, name, locale and status of a member of the CURRENT tenant
--   auth.cleanup_login_events()           deletes login events older than 180 days → count
--   auth.cleanup_password_tokens()        deletes used or expired setup/reset tokens older than 30 days → count
-- Retention periods are fixed here (docs/contracts/identity.md): the caller cannot shorten them.
create function auth.notification_recipient(p_user_id uuid)
  returns table (email text, display_name text, locale text, status text)
  language sql
  stable
  security definer
  set search_path = pg_catalog, auth
as $$
  select u.email, u.display_name, u.locale, u.status
    from auth.user_account u
    join auth.user_company m on m.user_id = u.id
   where u.id = p_user_id
     and m.company_id = nullif(pg_catalog.current_setting('app.company_id', true), '')::uuid
$$;

create function auth.cleanup_login_events()
  returns int
  language plpgsql
  security definer
  set search_path = pg_catalog, auth
as $$
declare
  v_count int;
begin
  delete from auth.login_event where at < now() - interval '180 days';
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

create function auth.cleanup_password_tokens()
  returns int
  language plpgsql
  security definer
  set search_path = pg_catalog, auth
as $$
declare
  v_count int;
begin
  delete from auth.password_token
   where (used_at is not null or expires_at < now())
     and created_at < now() - interval '30 days';
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

-- EXECUTE is granted to PUBLIC by default on new functions (and to hrforce_app by 0001's default privileges in
-- public): revoke both explicitly, then grant the worker what it runs.
revoke all on function public.job_company_ids(), auth.notification_recipient(uuid), auth.cleanup_login_events(),
  auth.cleanup_password_tokens() from public, hrforce_app;
revoke all on function public.notification_guard(), public.notification_notify() from public;
grant usage on schema auth, audit to hrforce_worker;
grant execute on function public.job_company_ids(), auth.notification_recipient(uuid), auth.cleanup_login_events(),
  auth.cleanup_password_tokens(), audit.ensure_partitions(int) to hrforce_worker;

-- ---------------------------------------------------------------------------------------------------------
-- Job queue schema (Graphile Worker). Its objects are created by the migrate step as the migrator; the defaults
-- below give the worker DML on them as they appear; src/platform/db/worker-schema.ts re-applies the exact grants
-- after every install/upgrade (idempotent).
create schema if not exists graphile_worker;
revoke all on schema graphile_worker from public;
grant usage on schema graphile_worker to hrforce_app, hrforce_worker;
alter default privileges in schema graphile_worker grant select, insert, update, delete on tables to hrforce_worker;
alter default privileges in schema graphile_worker grant usage, select on sequences to hrforce_worker;
alter default privileges in schema graphile_worker grant execute on functions to hrforce_worker;
