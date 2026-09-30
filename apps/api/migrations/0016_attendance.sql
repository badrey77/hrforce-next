-- 0016: attendance, Phase A (docs/contracts/attendance.md, ADR 009): entrance kiosks and their pairing, punches (QR
-- check-in and manual), work schedules with versions, date-bounded overrides and assignments, the company policy.
--   attendance_policy               one row per company: retention of punches, minimum gap between two scans
--   attendance_device               an entrance kiosk (`qr_kiosk`): site, labels, pairing code / credential (SHA-256)
--   attendance_device_heartbeat     last seen / IP / user agent of a kiosk (audit-exempt: overwritten every minute)
--   attendance_schedule             a named schedule (code immutable, deactivated instead of deleted)
--   attendance_schedule_version     the schedule's week over a date range (appended; only an open range may be closed)
--   attendance_schedule_override    a date-bounded week (Ramadan…) of one schedule or of every schedule
--   attendance_schedule_assignment  which schedule applies to the company / a site / a unit / an employment, and when
--   attendance_punch                one arrival or departure (immutable except one live → void transition)
-- Also: the permissions attendance.* (group attendance) and their system-role grants, attendance.configure in the
-- two-step sign-in defaults and every existing policy, the per-company defaults (policy, `standard` schedule and its
-- company assignment), the pairing lookup function, the worker's retention privileges.
--
-- Every new table: company_id + RLS/FORCE + the standard tenant policy, composite (company_id, …) foreign keys. Users
-- are referenced without FK (hrforce_app has no privilege on auth.*), like role_grant.user_id.
--
-- AUDIT. Every table has an `audit%` AFTER INSERT/UPDATE/DELETE row trigger (guard:db audit-per-write) except the
-- heartbeat (tools/guardrails/audit-exempt.json). attendance_punch is special (owner decision 2026-09-29): punch rows
-- are immutable and carry who and when themselves, so the audit log records punch EVENTS WITHOUT the personal payload
-- — trigger function audit.capture_punch_event() writes one audit.event per write (`attendance.punch_recorded`,
-- `attendance.punch_voided`, `attendance.punch_deleted`) holding only the punch id (subject), its source and direction;
-- never the employment, the instant, the device, the device reference or a reason. A QR punch is recorded with actor
-- null (its actor would be the employee and the event time the punch time: the attendance record itself). The worker's
-- retention purge writes no per-row event (one `attendance.purged {punches, before}` per run instead), so the purge
-- erases punches fully. audit.capture() itself is unchanged.

-- ---------------------------------------------------------------------------------------------------------
-- Permissions (group attendance, 710–740) and their system-role grants.
alter table public.permission drop constraint permission_group_ck;
alter table public.permission
  add constraint permission_group_ck check (group_code in ('organization', 'access', 'employee', 'leave', 'documents', 'attendance', 'sensitive'));

insert into public.permission (code, label_fr, label_ar, label_en, group_code, sensitive, sort_order) values
  ('attendance.punch_self', 'Pointer et consulter son pointage', 'تسجيل الحضور والاطلاع على السجل الشخصي', 'Clock in and view own attendance', 'attendance', false, 710),
  ('attendance.read', 'Consulter la présence', 'الاطلاع على الحضور', 'View attendance', 'attendance', false, 720),
  ('attendance.manage', 'Gérer les pointages (saisie manuelle, annulation, validation RH des corrections)', 'تسيير تسجيلات الحضور (الإدخال اليدوي، الإلغاء، مصادقة الموارد البشرية على التصحيحات)', 'Manage punches (manual entry, void, HR approval of corrections)', 'attendance', false, 730),
  ('attendance.configure', 'Paramétrer le pointage (horaires, bornes)', 'إعداد نظام الحضور (المواقيت، شاشات المداخل)', 'Configure attendance (schedules, kiosks)', 'attendance', false, 740);

insert into public.role_permission (company_id, role_id, permission_code)
select r.company_id, r.id, p.code
  from public.role r
  join (values
          ('admin_rh_central', 'attendance.punch_self'), ('admin_rh_central', 'attendance.read'),
          ('admin_rh_central', 'attendance.manage'), ('admin_rh_central', 'attendance.configure'),
          ('rh_regional', 'attendance.read'), ('rh_regional', 'attendance.manage'),
          ('lecture', 'attendance.read'),
          ('employe', 'attendance.punch_self')
       ) as p (role_code, code) on p.role_code = r.code
 where r.is_system
on conflict (role_id, permission_code) do nothing;

-- A kiosk credential produces valid codes and pairing is access management: attendance.configure needs the second
-- factor by default (new policies: the function; existing ones: appended once).
create or replace function public.security_policy_default_permissions()
  returns text[]
  language sql
  stable
  set search_path = pg_catalog, public
as $$
  select coalesce(array_agg(p.code order by p.sort_order), '{}')
    from public.permission p
   where p.sensitive or p.code in ('access.grant', 'access.manage_roles', 'leave.configure', 'attendance.configure')
$$;

update public.security_policy
   set mfa_required_permissions = array_append(mfa_required_permissions, 'attendance.configure')
 where not ('attendance.configure' = any (mfa_required_permissions));

-- ---------------------------------------------------------------------------------------------------------
create table public.attendance_policy (
  company_id uuid primary key references public.company (id),
  retention_months integer not null default 60,
  min_punch_gap_seconds integer not null default 120,
  updated_at timestamptz not null default now(),
  constraint attendance_policy_retention_ck check (retention_months between 12 and 120),
  constraint attendance_policy_gap_ck check (min_punch_gap_seconds between 0 and 600)
);

alter table public.attendance_policy enable row level security;
alter table public.attendance_policy force row level security;
create policy attendance_policy_tenant_isolation on public.attendance_policy
  using (company_id = current_setting('app.company_id', true)::uuid);

-- ---------------------------------------------------------------------------------------------------------
create table public.attendance_device (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company (id),
  -- badge_terminal is reserved (ADR 009 §6)
  kind text not null default 'qr_kiosk',
  site_id uuid not null,
  name_fr text not null,
  name_ar text not null,
  status text not null default 'pending',
  -- SHA-256 of the 32-byte device secret (cookie hrf_kiosk)
  credential_hash bytea,
  paired_at timestamptz,
  -- SHA-256 of the 8 normalised characters of the one-time pairing code
  pairing_code_hash bytea,
  pairing_expires_at timestamptz,
  allowed_networks cidr[] not null default '{}',
  -- null: created by a seed / bootstrap
  created_by uuid,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid,
  revoke_reason text,
  constraint attendance_device_company_id_id_uk unique (company_id, id),
  constraint attendance_device_site_fk foreign key (company_id, site_id) references public.site (company_id, id),
  constraint attendance_device_kind_ck check (kind in ('qr_kiosk')),
  constraint attendance_device_status_ck check (status in ('pending', 'active', 'revoked')),
  constraint attendance_device_names_ck check (
    name_fr = btrim(name_fr) and char_length(name_fr) between 1 and 120
    and name_ar = btrim(name_ar) and char_length(name_ar) between 1 and 120
  ),
  constraint attendance_device_credential_len_ck check (credential_hash is null or octet_length(credential_hash) = 32),
  constraint attendance_device_pairing_len_ck check (pairing_code_hash is null or octet_length(pairing_code_hash) = 32),
  constraint attendance_device_pairing_ck check ((pairing_code_hash is null) = (pairing_expires_at is null)),
  constraint attendance_device_state_ck check (
    (status = 'pending' and credential_hash is null and paired_at is null)
    or (status = 'active' and credential_hash is not null and paired_at is not null)
    or (status = 'revoked' and credential_hash is null and pairing_code_hash is null)
  ),
  constraint attendance_device_revoked_ck check (
    (status = 'revoked') = (revoked_at is not null and revoked_by is not null and revoke_reason is not null)
    and (status = 'revoked' or (revoked_at is null and revoked_by is null and revoke_reason is null))
  ),
  constraint attendance_device_reason_ck check (revoke_reason is null or (revoke_reason = btrim(revoke_reason) and char_length(revoke_reason) between 3 and 500)),
  constraint attendance_device_networks_ck check (cardinality(allowed_networks) <= 10 and array_position(allowed_networks, null) is null)
);

create index attendance_device_company_idx on public.attendance_device (company_id, created_at desc);
-- global: the pairing lookup runs before the company is known (attendance_pairing_lookup below)
create unique index attendance_device_pairing_code_uk on public.attendance_device (pairing_code_hash) where pairing_code_hash is not null;

alter table public.attendance_device enable row level security;
alter table public.attendance_device force row level security;
create policy attendance_device_tenant_isolation on public.attendance_device
  using (company_id = current_setting('app.company_id', true)::uuid);

-- Identity never changes; `revoked` is final.
create function public.attendance_device_guard() returns trigger
  language plpgsql
as $$
begin
  if new.id is distinct from old.id or new.company_id is distinct from old.company_id or new.kind is distinct from old.kind
     or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
    raise exception 'attendance_device %: id, company, kind and creation are immutable', old.id
      using errcode = 'check_violation', constraint = 'attendance_device_immutable';
  end if;
  if old.status = 'revoked' then
    raise exception 'attendance_device %: a revoked device is final', old.id
      using errcode = 'check_violation', constraint = 'attendance_device_revoked_final';
  end if;
  return new;
end
$$;

create trigger attendance_device_guard_tg
  before update on public.attendance_device
  for each row execute function public.attendance_device_guard();

-- The pairing lookup (POST /api/kiosk/pair) runs before the company is known: by the code's hash, through this
-- SECURITY DEFINER function owned by the migrator (pinned search_path). It returns only the two ids, and only for a
-- non-expired code of a non-revoked device; the use case then works in a transaction bound to that company.
create function public.attendance_pairing_lookup(p_code_hash bytea)
  returns table (company_id uuid, device_id uuid)
  language sql
  stable
  security definer
  set search_path = pg_catalog, public
as $$
  select d.company_id, d.id
    from public.attendance_device d
   where d.pairing_code_hash = p_code_hash
     and d.pairing_expires_at > pg_catalog.now()
     and d.status <> 'revoked'
$$;

-- ---------------------------------------------------------------------------------------------------------
create table public.attendance_device_heartbeat (
  device_id uuid primary key,
  company_id uuid not null,
  last_seen_at timestamptz not null default now(),
  last_ip inet,
  last_user_agent text,
  constraint attendance_device_heartbeat_device_fk foreign key (company_id, device_id) references public.attendance_device (company_id, id),
  constraint attendance_device_heartbeat_ua_ck check (last_user_agent is null or char_length(last_user_agent) <= 300)
);

alter table public.attendance_device_heartbeat enable row level security;
alter table public.attendance_device_heartbeat force row level security;
create policy attendance_device_heartbeat_tenant_isolation on public.attendance_device_heartbeat
  using (company_id = current_setting('app.company_id', true)::uuid);

-- ---------------------------------------------------------------------------------------------------------
create table public.attendance_schedule (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company (id),
  code text not null,
  name_fr text not null,
  name_ar text not null,
  name_en text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint attendance_schedule_company_id_id_uk unique (company_id, id),
  constraint attendance_schedule_company_code_uk unique (company_id, code),
  constraint attendance_schedule_code_ck check (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  constraint attendance_schedule_names_ck check (
    name_fr = btrim(name_fr) and char_length(name_fr) between 1 and 120
    and name_ar = btrim(name_ar) and char_length(name_ar) between 1 and 120
    and name_en = btrim(name_en) and char_length(name_en) between 1 and 120
  )
);

alter table public.attendance_schedule enable row level security;
alter table public.attendance_schedule force row level security;
create policy attendance_schedule_tenant_isolation on public.attendance_schedule
  using (company_id = current_setting('app.company_id', true)::uuid);

create function public.attendance_schedule_guard() returns trigger
  language plpgsql
as $$
begin
  if new.id is distinct from old.id or new.company_id is distinct from old.company_id or new.code is distinct from old.code
     or new.created_at is distinct from old.created_at then
    raise exception 'attendance_schedule %: the code is immutable', old.id
      using errcode = 'check_violation', constraint = 'attendance_schedule_immutable';
  end if;
  return new;
end
$$;

create trigger attendance_schedule_guard_tg
  before update on public.attendance_schedule
  for each row execute function public.attendance_schedule_guard();

-- ---------------------------------------------------------------------------------------------------------
-- `week`: 7 entries (ISO days 1..7), validated by the application (docs/contracts/attendance.md › Week document).
create table public.attendance_schedule_version (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  schedule_id uuid not null,
  valid daterange not null,
  week jsonb not null,
  tolerance_minutes integer not null,
  constraint attendance_schedule_version_company_id_id_uk unique (company_id, id),
  constraint attendance_schedule_version_schedule_fk foreign key (company_id, schedule_id) references public.attendance_schedule (company_id, id),
  constraint attendance_schedule_version_valid_ck check (not isempty(valid) and not lower_inf(valid) and lower_inc(valid) and not upper_inc(valid)),
  constraint attendance_schedule_version_week_ck check (jsonb_typeof(week) = 'array' and jsonb_array_length(week) = 7),
  constraint attendance_schedule_version_tolerance_ck check (tolerance_minutes between 0 and 60),
  constraint attendance_schedule_version_no_overlap_ex exclude using gist (company_id with =, schedule_id with =, valid with &&)
);

alter table public.attendance_schedule_version enable row level security;
alter table public.attendance_schedule_version force row level security;
create policy attendance_schedule_version_tenant_isolation on public.attendance_schedule_version
  using (company_id = current_setting('app.company_id', true)::uuid);

-- Versions are appended, never edited: the only change is closing an OPEN range (upper bound set once).
create function public.attendance_schedule_version_guard() returns trigger
  language plpgsql
as $$
begin
  if new.id is distinct from old.id or new.company_id is distinct from old.company_id or new.schedule_id is distinct from old.schedule_id
     or new.week is distinct from old.week or new.tolerance_minutes is distinct from old.tolerance_minutes
     or lower(new.valid) is distinct from lower(old.valid) or not upper_inf(old.valid) or upper_inf(new.valid) then
    raise exception 'attendance_schedule_version %: only an open range may be closed', old.id
      using errcode = 'check_violation', constraint = 'attendance_schedule_version_append_only';
  end if;
  return new;
end
$$;

create trigger attendance_schedule_version_guard_tg
  before update on public.attendance_schedule_version
  for each row execute function public.attendance_schedule_version_guard();

-- ---------------------------------------------------------------------------------------------------------
create table public.attendance_schedule_override (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  -- null: every schedule of the company
  schedule_id uuid,
  name_fr text not null,
  name_ar text not null,
  name_en text not null,
  -- [from, to + 1)
  dates daterange not null,
  week jsonb not null,
  tolerance_minutes integer not null,
  approximate boolean not null default false,
  created_at timestamptz not null default now(),
  constraint attendance_schedule_override_company_id_id_uk unique (company_id, id),
  constraint attendance_schedule_override_schedule_fk foreign key (company_id, schedule_id) references public.attendance_schedule (company_id, id),
  constraint attendance_schedule_override_names_ck check (
    name_fr = btrim(name_fr) and char_length(name_fr) between 1 and 120
    and name_ar = btrim(name_ar) and char_length(name_ar) between 1 and 120
    and name_en = btrim(name_en) and char_length(name_en) between 1 and 120
  ),
  constraint attendance_schedule_override_dates_ck check (
    not isempty(dates) and not lower_inf(dates) and not upper_inf(dates) and lower_inc(dates) and not upper_inc(dates)
    and upper(dates) - lower(dates) <= 60
  ),
  constraint attendance_schedule_override_week_ck check (jsonb_typeof(week) = 'array' and jsonb_array_length(week) = 7),
  constraint attendance_schedule_override_tolerance_ck check (tolerance_minutes between 0 and 60),
  constraint attendance_schedule_override_no_overlap_ex exclude using gist (
    company_id with =,
    (coalesce(schedule_id, '00000000-0000-0000-0000-000000000000'::uuid)) with =,
    dates with &&
  )
);

alter table public.attendance_schedule_override enable row level security;
alter table public.attendance_schedule_override force row level security;
create policy attendance_schedule_override_tenant_isolation on public.attendance_schedule_override
  using (company_id = current_setting('app.company_id', true)::uuid);

-- ---------------------------------------------------------------------------------------------------------
create table public.attendance_schedule_assignment (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  schedule_id uuid not null,
  target_kind text not null,
  site_id uuid,
  org_unit_id uuid,
  employment_id uuid,
  valid daterange not null,
  created_at timestamptz not null default now(),
  constraint attendance_schedule_assignment_company_id_id_uk unique (company_id, id),
  constraint attendance_schedule_assignment_schedule_fk foreign key (company_id, schedule_id) references public.attendance_schedule (company_id, id),
  constraint attendance_schedule_assignment_site_fk foreign key (company_id, site_id) references public.site (company_id, id),
  constraint attendance_schedule_assignment_unit_fk foreign key (company_id, org_unit_id) references public.org_unit (company_id, id),
  constraint attendance_schedule_assignment_employment_fk foreign key (company_id, employment_id) references public.employment (company_id, id),
  constraint attendance_schedule_assignment_kind_ck check (target_kind in ('company', 'site', 'unit', 'employment')),
  constraint attendance_schedule_assignment_target_ck check (
    (target_kind = 'company' and site_id is null and org_unit_id is null and employment_id is null)
    or (target_kind = 'site' and site_id is not null and org_unit_id is null and employment_id is null)
    or (target_kind = 'unit' and site_id is null and org_unit_id is not null and employment_id is null)
    or (target_kind = 'employment' and site_id is null and org_unit_id is null and employment_id is not null)
  ),
  constraint attendance_schedule_assignment_valid_ck check (not isempty(valid) and not lower_inf(valid) and lower_inc(valid) and not upper_inc(valid)),
  constraint attendance_schedule_assignment_no_overlap_ex exclude using gist (
    company_id with =,
    target_kind with =,
    (coalesce(site_id, org_unit_id, employment_id, '00000000-0000-0000-0000-000000000000'::uuid)) with =,
    valid with &&
  )
);

create index attendance_schedule_assignment_schedule_idx on public.attendance_schedule_assignment (company_id, schedule_id);

alter table public.attendance_schedule_assignment enable row level security;
alter table public.attendance_schedule_assignment force row level security;
create policy attendance_schedule_assignment_tenant_isolation on public.attendance_schedule_assignment
  using (company_id = current_setting('app.company_id', true)::uuid);

-- Only the date range moves (ending, re-opening the predecessor of a deleted future assignment).
create function public.attendance_schedule_assignment_guard() returns trigger
  language plpgsql
as $$
begin
  if new.id is distinct from old.id or new.company_id is distinct from old.company_id or new.schedule_id is distinct from old.schedule_id
     or new.target_kind is distinct from old.target_kind or new.site_id is distinct from old.site_id
     or new.org_unit_id is distinct from old.org_unit_id or new.employment_id is distinct from old.employment_id
     or new.created_at is distinct from old.created_at or lower(new.valid) is distinct from lower(old.valid) then
    raise exception 'attendance_schedule_assignment %: only the end of the range may change', old.id
      using errcode = 'check_violation', constraint = 'attendance_schedule_assignment_immutable';
  end if;
  return new;
end
$$;

create trigger attendance_schedule_assignment_guard_tg
  before update on public.attendance_schedule_assignment
  for each row execute function public.attendance_schedule_assignment_guard();

-- ---------------------------------------------------------------------------------------------------------
create table public.attendance_punch (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  employment_id uuid not null,
  direction text not null,
  -- the instant that counts (the scan's arrival at the API for a QR punch)
  occurred_at timestamptz not null,
  -- the Algerian calendar day of that instant (Africa/Algiers, UTC+1, no daylight saving)
  work_date date generated always as ((occurred_at at time zone 'Africa/Algiers')::date) stored,
  received_at timestamptz not null default now(),
  -- Phase B adds `correction`; `badge` is reserved (ADR 009 §6)
  source text not null,
  device_id uuid,
  qr_window bigint,
  site_id uuid,
  -- keyed hash of a per-browser random identifier (32 lower-case hex), QR punches only
  device_ref text,
  reason text,
  -- the employee's user for `qr`, the HR user for `manual`; null for seeded rows
  created_by uuid,
  status text not null default 'live',
  voided_at timestamptz,
  voided_by uuid,
  void_reason text,
  constraint attendance_punch_company_id_id_uk unique (company_id, id),
  constraint attendance_punch_employment_fk foreign key (company_id, employment_id) references public.employment (company_id, id),
  constraint attendance_punch_device_fk foreign key (company_id, device_id) references public.attendance_device (company_id, id),
  constraint attendance_punch_site_fk foreign key (company_id, site_id) references public.site (company_id, id),
  constraint attendance_punch_direction_ck check (direction in ('in', 'out')),
  constraint attendance_punch_source_ck check (source in ('qr', 'manual')),
  constraint attendance_punch_status_ck check (status in ('live', 'void')),
  constraint attendance_punch_qr_ck check (
    (source = 'qr') = (device_id is not null and qr_window is not null and site_id is not null and reason is null)
  ),
  constraint attendance_punch_manual_ck check (
    source <> 'manual' or (reason is not null and device_id is null and qr_window is null and device_ref is null)
  ),
  constraint attendance_punch_device_ref_ck check (device_ref is null or device_ref ~ '^[0-9a-f]{32}$'),
  constraint attendance_punch_reason_ck check (reason is null or (reason = btrim(reason) and char_length(reason) between 3 and 500)),
  constraint attendance_punch_void_ck check (
    (status = 'void') = (voided_at is not null and voided_by is not null and void_reason is not null)
    and (status = 'void' or (voided_at is null and voided_by is null and void_reason is null))
  ),
  constraint attendance_punch_void_reason_ck check (void_reason is null or (void_reason = btrim(void_reason) and char_length(void_reason) between 3 and 500))
);

-- one QR punch per employee per (kiosk, 30-second window): replays and double taps (ADR 009 §5)
create unique index attendance_punch_qr_window_uk on public.attendance_punch (company_id, employment_id, device_id, qr_window) where source = 'qr';
create index attendance_punch_day_idx on public.attendance_punch (company_id, work_date, employment_id);
create index attendance_punch_employment_idx on public.attendance_punch (company_id, employment_id, occurred_at);

alter table public.attendance_punch enable row level security;
alter table public.attendance_punch force row level security;
create policy attendance_punch_tenant_isolation on public.attendance_punch
  using (company_id = current_setting('app.company_id', true)::uuid);

-- A punch is a record: the only change is live → void, once (with its three void columns).
create function public.attendance_punch_guard() returns trigger
  language plpgsql
as $$
begin
  if new.id is distinct from old.id or new.company_id is distinct from old.company_id or new.employment_id is distinct from old.employment_id
     or new.direction is distinct from old.direction or new.occurred_at is distinct from old.occurred_at
     or new.received_at is distinct from old.received_at or new.source is distinct from old.source
     or new.device_id is distinct from old.device_id or new.qr_window is distinct from old.qr_window
     or new.site_id is distinct from old.site_id or new.device_ref is distinct from old.device_ref
     or new.reason is distinct from old.reason or new.created_by is distinct from old.created_by
     or old.status <> 'live' or new.status <> 'void' then
    raise exception 'attendance_punch %: a punch is immutable except one live → void transition', old.id
      using errcode = 'check_violation', constraint = 'attendance_punch_immutable';
  end if;
  return new;
end
$$;

create trigger attendance_punch_guard_tg
  before update on public.attendance_punch
  for each row execute function public.attendance_punch_guard();

-- ---------------------------------------------------------------------------------------------------------
-- The punch audit: events without the personal payload (header of this file). SECURITY DEFINER like audit.capture();
-- the company comes from the row, the actor and request id from the transaction's settings.
--   insert  attendance.punch_recorded {source, direction}   actor: app.user_id, or null for a QR punch
--   update  attendance.punch_voided   {source}              (the guard allows no other update)
--   delete  attendance.punch_deleted  {source}              none when the session is the worker (its only delete is
--                                                           the retention purge, which records attendance.purged)
create function audit.capture_punch_event() returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, audit
as $$
declare
  v_row public.attendance_punch;
  v_type text;
  v_data jsonb;
  v_actor uuid := audit.setting_uuid('app.user_id');
begin
  if tg_op = 'DELETE' then
    if session_user = 'hrforce_worker' then
      return null;
    end if;
    v_row := old;
    v_type := 'attendance.punch_deleted';
    v_data := jsonb_build_object('source', old.source);
  elsif tg_op = 'UPDATE' then
    v_row := new;
    v_type := 'attendance.punch_voided';
    v_data := jsonb_build_object('source', new.source);
  else
    v_row := new;
    v_type := 'attendance.punch_recorded';
    v_data := jsonb_build_object('source', new.source, 'direction', new.direction);
    if new.source = 'qr' then
      v_actor := null;
    end if;
  end if;
  insert into audit.event (company_id, actor_user_id, request_id, type, subject_type, subject_id, data)
  values (v_row.company_id, v_actor, nullif(current_setting('app.request_id', true), ''), v_type, 'attendance_punch', v_row.id, v_data);
  return null;
end
$$;

revoke all on function audit.capture_punch_event() from public;

-- ---------------------------------------------------------------------------------------------------------
-- Audit (guard:db audit-per-write): row triggers on every table but the heartbeat (audit-exempt.json); the punch
-- events above on attendance_punch. Masked in the stored diffs: the credential and pairing-code hashes.
create trigger audit_capture_tg after insert or update or delete on public.attendance_policy
  for each row execute function audit.capture('company_id');
create trigger audit_capture_tg after insert or update or delete on public.attendance_device
  for each row execute function audit.capture();
create trigger audit_capture_tg after insert or update or delete on public.attendance_schedule
  for each row execute function audit.capture();
create trigger audit_capture_tg after insert or update or delete on public.attendance_schedule_version
  for each row execute function audit.capture();
create trigger audit_capture_tg after insert or update or delete on public.attendance_schedule_override
  for each row execute function audit.capture();
create trigger audit_capture_tg after insert or update or delete on public.attendance_schedule_assignment
  for each row execute function audit.capture();
create trigger audit_capture_tg after insert or update or delete on public.attendance_punch
  for each row execute function audit.capture_punch_event();

insert into audit.masked_column (table_name, column_name) values
  ('attendance_device', 'credential_hash'),
  ('attendance_device', 'pairing_code_hash');

-- ---------------------------------------------------------------------------------------------------------
-- Privileges. hrforce_app: no DELETE except overrides and (future) assignments; the heartbeat is upsert only.
-- hrforce_worker: SELECT by 0012's default privileges, DELETE of punches (retention), the audit event of a run.
revoke delete on table public.attendance_policy, public.attendance_device, public.attendance_device_heartbeat,
  public.attendance_schedule, public.attendance_schedule_version, public.attendance_punch from hrforce_app;
revoke all on function public.attendance_device_guard(), public.attendance_schedule_guard(), public.attendance_schedule_version_guard(),
  public.attendance_schedule_assignment_guard(), public.attendance_punch_guard() from public;
revoke all on function public.attendance_pairing_lookup(bytea) from public;
grant execute on function public.attendance_pairing_lookup(bytea) to hrforce_app;
grant delete on table public.attendance_punch to hrforce_worker;
grant execute on function audit.record_event(text, text, uuid, jsonb) to hrforce_worker;

-- ---------------------------------------------------------------------------------------------------------
-- Defaults of every existing company (new ones: seedAttendanceDefaults, called by bootstrap and seed:dev): the policy,
-- schedule `standard` (Sunday–Thursday 08:00–16:30, break 12:00–12:30, tolerance 10; Friday + Saturday rest) with one
-- open version from 2000-01-01, and its company assignment from 2000-01-01, open.
insert into public.attendance_policy (company_id) select c.id from public.company c on conflict do nothing;

insert into public.attendance_schedule (company_id, code, name_fr, name_ar, name_en)
select c.id, 'standard', 'Horaire standard', 'التوقيت العادي', 'Standard hours' from public.company c
on conflict (company_id, code) do nothing;

insert into public.attendance_schedule_version (company_id, schedule_id, valid, week, tolerance_minutes)
select s.company_id, s.id, daterange('2000-01-01', null, '[)'),
       '[{"day":1,"start":"08:00","end":"16:30","breakStart":"12:00","breakEnd":"12:30"},
         {"day":2,"start":"08:00","end":"16:30","breakStart":"12:00","breakEnd":"12:30"},
         {"day":3,"start":"08:00","end":"16:30","breakStart":"12:00","breakEnd":"12:30"},
         {"day":4,"start":"08:00","end":"16:30","breakStart":"12:00","breakEnd":"12:30"},
         {"day":5,"rest":true},
         {"day":6,"rest":true},
         {"day":7,"start":"08:00","end":"16:30","breakStart":"12:00","breakEnd":"12:30"}]'::jsonb,
       10
  from public.attendance_schedule s
 where s.code = 'standard'
   and not exists (select 1 from public.attendance_schedule_version v where v.company_id = s.company_id and v.schedule_id = s.id);

insert into public.attendance_schedule_assignment (company_id, schedule_id, target_kind, valid)
select s.company_id, s.id, 'company', daterange('2000-01-01', null, '[)')
  from public.attendance_schedule s
 where s.code = 'standard'
   and not exists (select 1 from public.attendance_schedule_assignment a where a.company_id = s.company_id and a.target_kind = 'company');
