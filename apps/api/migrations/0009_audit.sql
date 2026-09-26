-- 0009: audit (docs/contracts/audit.md, ADR 005).
--   audit.change_log     one row per row-level change of a tenant table, written ONLY by the trigger audit.capture()
--   audit.event          application events that are not a row change (logins, grants…), via audit.record_event()
--   audit.masked_column  columns whose values are replaced by "***" in change_log.before/after
--
-- Both log tables are partitioned by month on `at` (RANGE), with a DEFAULT partition as a safety net;
-- audit.ensure_partitions(months_ahead) creates the monthly partitions (called below for the current month + 12;
-- the M2 worker will call it monthly — apps/api/README.md › Audit).
--
-- Append-only: hrforce_app only has SELECT on the two parents (RLS + FORCE, standard company_id policy) and nothing
-- on the partitions; writes go through the SECURITY DEFINER functions (owner: the migrator, pinned search_path).
-- A BEFORE UPDATE OR DELETE trigger refuses any change, even by the owner, unless `audit.allow_purge` is set to
-- `on` (for the future retention job); TRUNCATE is refused the same way.
--
-- Session settings read (missing/empty → null, e.g. migrations, seeds, psql): app.company_id (events only; the nil
-- UUID means "no tenant"), app.user_id (actor), app.request_id.
--
-- Coverage: every tenant table of `public` gets audit.capture() (AFTER INSERT OR UPDATE OR DELETE, FOR EACH ROW)
-- except those in tools/guardrails/audit-exempt.json (org_unit_closure: derived from the versions and rebuilt
-- wholesale). The guardrail `guard:db` checks it. Writes of this and later migrations and of the seeds are audited
-- too, with actor null.

create schema audit;
revoke all on schema audit from public;
grant usage on schema audit to hrforce_app;

-- ---------------------------------------------------------------------------------------------------------
-- Tables

create table audit.change_log (
  id bigint generated always as identity,
  company_id uuid not null,
  at timestamptz not null default now(),
  table_name text not null,
  row_id uuid,
  op text not null,
  actor_user_id uuid,
  request_id text,
  before jsonb,
  after jsonb,
  changed text[] not null,
  constraint change_log_pk primary key (id, at),
  constraint change_log_op_ck check (op in ('insert', 'update', 'delete')),
  constraint change_log_images_ck check (
    (op = 'insert' and before is null and after is not null)
    or (op = 'update' and before is not null and after is not null)
    or (op = 'delete' and before is not null and after is null)
  )
) partition by range (at);

create table audit.event (
  id bigint generated always as identity,
  company_id uuid,
  at timestamptz not null default now(),
  actor_user_id uuid,
  request_id text,
  type text not null,
  subject_type text,
  subject_id uuid,
  data jsonb not null default '{}',
  constraint event_pk primary key (id, at),
  constraint event_type_ck check (type ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  constraint event_subject_ck check ((subject_type is null) = (subject_id is null)),
  constraint event_subject_type_ck check (subject_type is null or subject_type ~ '^[a-z][a-z0-9_]*$'),
  constraint event_data_ck check (jsonb_typeof(data) = 'object')
) partition by range (at);

create table audit.change_log_default partition of audit.change_log default;
create table audit.event_default partition of audit.event default;

create index change_log_row_idx on audit.change_log (company_id, table_name, row_id, at desc);
create index event_subject_idx on audit.event (company_id, subject_type, subject_id, at desc);

create table audit.masked_column (
  table_name text not null,
  column_name text not null,
  constraint masked_column_pk primary key (table_name, column_name)
);

-- ---------------------------------------------------------------------------------------------------------
-- Session settings → uuid (missing, empty, malformed or the nil UUID → null). Never raises: an audit row must not
-- make a legitimate write fail.
create function audit.setting_uuid(p_name text) returns uuid
  language plpgsql
  stable
  set search_path = pg_catalog
as $$
declare
  v text := nullif(current_setting(p_name, true), '');
begin
  if v is null or v !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return null;
  end if;
  return nullif(v::uuid, '00000000-0000-0000-0000-000000000000'::uuid);
end
$$;

-- ---------------------------------------------------------------------------------------------------------
-- Row-change capture. Trigger argument 0 (optional) names the column holding the row id (default `id`), e.g.
-- role_permission has no id and is keyed on its role (`role_id`). company_id comes from the row (`id` for the
-- company table itself). Generated columns (derived: org_unit_version.name_search, role_grant.valid) are left out.
--   insert → after = every column, changed = every column
--   update → before/after = the changed columns + the row-id column; changed = the changed columns;
--            nothing changed → no row
--   delete → before = every column, changed = every column
-- Masked columns (audit.masked_column) hold "***" instead of a non-null value but stay listed in `changed`.
create function audit.capture() returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, audit
as $$
declare
  v_key text := coalesce(tg_argv[0], 'id');
  v_old jsonb;
  v_new jsonb;
  v_row jsonb;
  v_cols text[];
  v_masked text[];
  v_changed text[] := '{}';
  v_before jsonb;
  v_after jsonb;
  v_col text;
  v_op text := lower(tg_op);
begin
  if tg_op in ('UPDATE', 'DELETE') then v_old := to_jsonb(old); end if;
  if tg_op in ('UPDATE', 'INSERT') then v_new := to_jsonb(new); end if;
  v_row := coalesce(v_new, v_old);

  select array_agg(a.attname::text order by a.attnum) into v_cols
    from pg_catalog.pg_attribute a
   where a.attrelid = tg_relid and a.attnum > 0 and not a.attisdropped and a.attgenerated = '';

  if tg_op = 'UPDATE' then
    foreach v_col in array v_cols loop
      if (v_old -> v_col) is distinct from (v_new -> v_col) then
        v_changed := v_changed || v_col;
      end if;
    end loop;
    if cardinality(v_changed) = 0 then
      return null;
    end if;
  else
    v_changed := v_cols;
  end if;

  select coalesce(array_agg(m.column_name), '{}') into v_masked
    from audit.masked_column m
   where m.table_name = tg_table_name;

  -- images: the changed columns (+ the row id on update), masked where needed
  if v_old is not null then
    select jsonb_object_agg(c, case when c = any (v_masked) and v_old -> c <> 'null'::jsonb then '"***"'::jsonb else v_old -> c end)
      into v_before
      from unnest(case when tg_op = 'UPDATE' then array_prepend(v_key, v_changed) else v_cols end) as c
     where v_old ? c;
  end if;
  if v_new is not null then
    select jsonb_object_agg(c, case when c = any (v_masked) and v_new -> c <> 'null'::jsonb then '"***"'::jsonb else v_new -> c end)
      into v_after
      from unnest(case when tg_op = 'UPDATE' then array_prepend(v_key, v_changed) else v_cols end) as c
     where v_new ? c;
  end if;

  insert into audit.change_log (company_id, table_name, row_id, op, actor_user_id, request_id, before, after, changed)
  values (
    coalesce((v_row ->> 'company_id')::uuid, case when tg_table_name = 'company' then (v_row ->> 'id')::uuid end),
    tg_table_name,
    (v_row ->> v_key)::uuid,
    v_op,
    audit.setting_uuid('app.user_id'),
    nullif(current_setting('app.request_id', true), ''),
    v_before,
    v_after,
    v_changed
  );
  return null;
end
$$;

-- ---------------------------------------------------------------------------------------------------------
-- Application events. company_id, actor and request id come from the session settings, never from arguments.
create function audit.record_event(p_type text, p_subject_type text, p_subject_id uuid, p_data jsonb default '{}')
  returns void
  language sql
  security definer
  set search_path = pg_catalog, audit
as $$
  insert into audit.event (company_id, actor_user_id, request_id, type, subject_type, subject_id, data)
  values (
    audit.setting_uuid('app.company_id'),
    audit.setting_uuid('app.user_id'),
    nullif(current_setting('app.request_id', true), ''),
    p_type,
    p_subject_type,
    p_subject_id,
    coalesce(p_data, '{}'::jsonb)
  )
$$;

-- ---------------------------------------------------------------------------------------------------------
-- Append-only: refuses UPDATE/DELETE (row triggers, cloned onto every partition) and TRUNCATE (statement trigger on
-- the parent) unless `audit.allow_purge` = on in the session/transaction (retention job only).
create function audit.forbid_change() returns trigger
  language plpgsql
  set search_path = pg_catalog
as $$
begin
  if coalesce(current_setting('audit.allow_purge', true), '') = 'on' then
    return case when tg_level = 'ROW' then old else null end;
  end if;
  raise exception 'audit.% is append-only', tg_table_name using errcode = 'insufficient_privilege';
end
$$;

create trigger change_log_append_only_tg before update or delete on audit.change_log
  for each row execute function audit.forbid_change();
create trigger change_log_no_truncate_tg before truncate on audit.change_log
  for each statement execute function audit.forbid_change();
create trigger event_append_only_tg before update or delete on audit.event
  for each row execute function audit.forbid_change();
create trigger event_no_truncate_tg before truncate on audit.event
  for each statement execute function audit.forbid_change();

-- ---------------------------------------------------------------------------------------------------------
-- Monthly partitions (UTC months): audit.<table>_yYYYYmMM for the current month and the next `months_ahead`.
-- Idempotent; returns the number of partitions created. Refuses (clear error) when the DEFAULT partition already
-- holds rows of a month to create — move them by hand (with audit.allow_purge) before retrying.
create function audit.ensure_partitions(months_ahead int default 12) returns int
  language plpgsql
  security definer
  set search_path = pg_catalog, audit
as $$
declare
  v_first timestamp := date_trunc('month', now() at time zone 'UTC');
  v_from timestamptz;
  v_to timestamptz;
  v_table text;
  v_name text;
  v_created int := 0;
  v_busy boolean;
begin
  if months_ahead is null or months_ahead < 0 or months_ahead > 120 then
    raise exception 'audit.ensure_partitions: months_ahead must be between 0 and 120';
  end if;
  foreach v_table in array array['change_log', 'event'] loop
    for i in 0 .. months_ahead loop
      v_from := (v_first + make_interval(months => i)) at time zone 'UTC';
      v_to := (v_first + make_interval(months => i + 1)) at time zone 'UTC';
      v_name := format('%s_y%sm%s', v_table, to_char(v_from at time zone 'UTC', 'YYYY'), to_char(v_from at time zone 'UTC', 'MM'));
      continue when to_regclass(format('audit.%I', v_name)) is not null;
      execute format('select exists (select 1 from audit.%I where at >= $1 and at < $2)', v_table || '_default')
        into v_busy using v_from, v_to;
      if v_busy then
        raise exception 'audit.ensure_partitions: audit.%_default holds rows for [%, %): move them before creating %',
          v_table, v_from, v_to, v_name;
      end if;
      execute format('create table audit.%I partition of audit.%I for values from (%L) to (%L)', v_name, v_table, v_from, v_to);
      v_created := v_created + 1;
    end loop;
  end loop;
  return v_created;
end
$$;

select audit.ensure_partitions(12);

-- ---------------------------------------------------------------------------------------------------------
-- Reads: the app sees its tenant's rows of the two parents (events without company are invisible to it).
alter table audit.change_log enable row level security;
alter table audit.change_log force row level security;
create policy change_log_tenant_isolation on audit.change_log
  using (company_id = current_setting('app.company_id', true)::uuid);

alter table audit.event enable row level security;
alter table audit.event force row level security;
create policy event_tenant_isolation on audit.event
  using (company_id = current_setting('app.company_id', true)::uuid);

-- Privileges: SELECT on the parents (and the masking list) only; nothing on partitions, sequences or functions
-- except record_event. EXECUTE is granted to PUBLIC by default on new functions: revoke it explicitly.
revoke all on all tables in schema audit from public, hrforce_app;
revoke all on all sequences in schema audit from public, hrforce_app;
revoke all on all functions in schema audit from public, hrforce_app;
grant select on table audit.change_log, audit.event, audit.masked_column to hrforce_app;
grant execute on function audit.record_event(text, text, uuid, jsonb) to hrforce_app;

-- ---------------------------------------------------------------------------------------------------------
-- Coverage: every tenant table of public except org_unit_closure (tools/guardrails/audit-exempt.json).
create trigger audit_capture_tg after insert or update or delete on public.company
  for each row execute function audit.capture();
create trigger audit_capture_tg after insert or update or delete on public.org_unit
  for each row execute function audit.capture();
create trigger audit_capture_tg after insert or update or delete on public.org_unit_version
  for each row execute function audit.capture();
create trigger audit_capture_tg after insert or update or delete on public.site
  for each row execute function audit.capture();
create trigger audit_capture_tg after insert or update or delete on public.role
  for each row execute function audit.capture();
create trigger audit_capture_tg after insert or update or delete on public.role_permission
  for each row execute function audit.capture('role_id');
create trigger audit_capture_tg after insert or update or delete on public.role_grant
  for each row execute function audit.capture();

-- ---------------------------------------------------------------------------------------------------------
-- Permission audit.read (group access), held by the system roles admin_rh_central and admin_acces of every company
-- (new companies: SYSTEM_ROLES in modules/authorization/domain/catalogue.ts). Audited with actor null.
-- Arabic: الاطلاع على سجل التغييرات (consult the change history).
insert into public.permission (code, label_fr, label_ar, label_en, group_code, sensitive, sort_order) values
  ('audit.read', 'Consulter l''historique', 'الاطلاع على سجل التغييرات', 'View history', 'access', false, 240);

insert into public.role_permission (company_id, role_id, permission_code)
select r.company_id, r.id, 'audit.read'
  from public.role r
 where r.is_system and r.code in ('admin_rh_central', 'admin_acces')
on conflict (role_id, permission_code) do nothing;

-- ---------------------------------------------------------------------------------------------------------
-- Identity helpers for the auth events (docs/contracts/audit.md › Application events): the events of
-- /api/auth/* are written in their own transaction under the user's company.
--   auth.session_owner(token_hash) → (user_id, company_id, family_id) of a refresh token's session (logout without an
--                                    access cookie; the family of a detected refresh-token reuse)
--   auth.default_company(user_id)  → the user's default membership, else the lowest company code (like create_session)
create function auth.session_owner(p_token_hash bytea)
  returns table (user_id uuid, company_id uuid, family_id uuid)
  language sql
  stable
  security definer
  set search_path = pg_catalog, auth
as $$
  select s.user_id, s.company_id, s.family_id from auth.refresh_session s where s.token_hash = p_token_hash
$$;

create function auth.default_company(p_user_id uuid)
  returns uuid
  language sql
  stable
  security definer
  set search_path = pg_catalog, auth
as $$
  select m.company_id
    from auth.user_company m
    join public.company c on c.id = m.company_id
   where m.user_id = p_user_id
   order by m.is_default desc, c.code
   limit 1
$$;

revoke all on function auth.session_owner(bytea), auth.default_company(uuid) from public;
grant execute on function auth.session_owner(bytea), auth.default_company(uuid) to hrforce_app;
