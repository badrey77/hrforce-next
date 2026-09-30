-- 0017: attendance, Phase B (docs/contracts/attendance.md › Phase B): punch corrections requested by the employee and
-- approved through the workflow engine (subject type `attendance_correction`), and the policy switches of that chain.
--   attendance_correction        one request: the employee, the work day, the reason, its status (mirrors the workflow)
--   attendance_correction_item   its 1–4 changes: `add` a punch (direction + instant) or `void` a live punch of that day
-- Also: attendance_punch gains the source `correction` (correction_id) and void_correction_id (a void decided by an
-- approved correction); attendance_policy gains correction_max_age_days and correction_workflow_code; the workflow and
-- notification subject type checks gain `attendance_correction`; the workflow definitions attendance.manager_then_hr and
-- attendance.hr_only of every existing company (new companies: seedAttendanceDefaults); the worker may delete both new
-- tables (retention).
--
-- AUDIT (owner decision 2026-09-29, as for punches): a correction holds the attendance record itself (the employee, the
-- day, the requested instants, a free-text reason), so it is audited as EVENTS WITHOUT the personal payload — trigger
-- function audit.capture_correction_event() writes one audit.event per write, subject `attendance_correction:<id>`:
--   correction insert                 attendance.correction_requested  {}
--   correction status change          attendance.correction_approved | _rejected | _cancelled  {}
--   item insert                       attendance.correction_item_added {position, action, direction}
--   item update (result_punch_id)     none (the punch it created has its own attendance.punch_recorded event)
--   delete by hrforce_worker          none (the retention purge records one attendance.purged event per run)
--   delete by anyone else             attendance.correction_deleted {} / attendance.correction_item_deleted {position}
-- No employment, day, instant or reason reaches the audit log, so the retention purge erases corrections fully.

-- ---------------------------------------------------------------------------------------------------------
-- Policy: how far back a correction may go, and which chain approves it (applies to new requests).
alter table public.attendance_policy
  add column correction_max_age_days integer not null default 30,
  add column correction_workflow_code text not null default 'attendance.manager_then_hr',
  add constraint attendance_policy_correction_age_ck check (correction_max_age_days between 1 and 90),
  add constraint attendance_policy_correction_workflow_ck check (correction_workflow_code in ('attendance.manager_then_hr', 'attendance.hr_only'));

-- ---------------------------------------------------------------------------------------------------------
create table public.attendance_correction (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  employment_id uuid not null,
  -- the employee's scope unit when requested: the HR step's scope
  org_unit_id uuid not null,
  work_date date not null,
  reason text not null,
  status text not null default 'pending',
  requested_by uuid not null,
  requested_at timestamptz not null default now(),
  workflow_instance_id uuid,
  constraint attendance_correction_company_id_id_uk unique (company_id, id),
  constraint attendance_correction_employment_fk foreign key (company_id, employment_id) references public.employment (company_id, id),
  constraint attendance_correction_unit_fk foreign key (company_id, org_unit_id) references public.org_unit (company_id, id),
  constraint attendance_correction_instance_fk foreign key (company_id, workflow_instance_id) references public.workflow_instance (company_id, id),
  constraint attendance_correction_status_ck check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  constraint attendance_correction_reason_ck check (reason = btrim(reason) and char_length(reason) between 3 and 500)
);

-- one pending request per employee and day
create unique index attendance_correction_one_pending_uk on public.attendance_correction (employment_id, work_date) where status = 'pending';
create index attendance_correction_company_employment_idx on public.attendance_correction (company_id, employment_id, requested_at desc);
create index attendance_correction_company_date_idx on public.attendance_correction (company_id, work_date);

alter table public.attendance_correction enable row level security;
alter table public.attendance_correction force row level security;
create policy attendance_correction_tenant_isolation on public.attendance_correction
  using (company_id = current_setting('app.company_id', true)::uuid);

-- What was asked is immutable; the status leaves `pending` once (mirrored from the workflow); the instance is linked once.
create function public.attendance_correction_guard() returns trigger
  language plpgsql
as $$
begin
  if new.id is distinct from old.id or new.company_id is distinct from old.company_id or new.employment_id is distinct from old.employment_id
     or new.org_unit_id is distinct from old.org_unit_id or new.work_date is distinct from old.work_date
     or new.reason is distinct from old.reason or new.requested_by is distinct from old.requested_by
     or new.requested_at is distinct from old.requested_at
     or (old.workflow_instance_id is not null and new.workflow_instance_id is distinct from old.workflow_instance_id) then
    raise exception 'attendance_correction %: only status and workflow_instance_id may change', old.id
      using errcode = 'check_violation', constraint = 'attendance_correction_immutable';
  end if;
  if old.status <> 'pending' and new.status is distinct from old.status then
    raise exception 'attendance_correction %: a % request is final', old.id, old.status
      using errcode = 'check_violation', constraint = 'attendance_correction_final';
  end if;
  return new;
end
$$;

create trigger attendance_correction_guard_tg
  before update on public.attendance_correction
  for each row execute function public.attendance_correction_guard();

-- ---------------------------------------------------------------------------------------------------------
-- Punches: a third source (a punch added by an approved correction) and the correction that voided a punch.
alter table public.attendance_punch
  add column correction_id uuid,
  add column void_correction_id uuid,
  add constraint attendance_punch_correction_fk foreign key (company_id, correction_id) references public.attendance_correction (company_id, id),
  add constraint attendance_punch_void_correction_fk foreign key (company_id, void_correction_id) references public.attendance_correction (company_id, id);

alter table public.attendance_punch drop constraint attendance_punch_source_ck;
alter table public.attendance_punch
  add constraint attendance_punch_source_ck check (source in ('qr', 'manual', 'correction')),
  add constraint attendance_punch_correction_ck check (
    (source = 'correction') = (correction_id is not null)
    and (source <> 'correction' or (device_id is null and qr_window is null and device_ref is null and reason is null))
  ),
  add constraint attendance_punch_void_correction_ck check (void_correction_id is null or status = 'void');

create index attendance_punch_correction_idx on public.attendance_punch (company_id, correction_id) where correction_id is not null;
create index attendance_punch_void_correction_idx on public.attendance_punch (company_id, void_correction_id) where void_correction_id is not null;

-- A punch is a record: the only change is live → void, once (with its void columns, void_correction_id included).
create or replace function public.attendance_punch_guard() returns trigger
  language plpgsql
as $$
begin
  if new.id is distinct from old.id or new.company_id is distinct from old.company_id or new.employment_id is distinct from old.employment_id
     or new.direction is distinct from old.direction or new.occurred_at is distinct from old.occurred_at
     or new.received_at is distinct from old.received_at or new.source is distinct from old.source
     or new.device_id is distinct from old.device_id or new.qr_window is distinct from old.qr_window
     or new.site_id is distinct from old.site_id or new.device_ref is distinct from old.device_ref
     or new.reason is distinct from old.reason or new.created_by is distinct from old.created_by
     or new.correction_id is distinct from old.correction_id
     or old.status <> 'live' or new.status <> 'void' then
    raise exception 'attendance_punch %: a punch is immutable except one live → void transition', old.id
      using errcode = 'check_violation', constraint = 'attendance_punch_immutable';
  end if;
  return new;
end
$$;

-- ---------------------------------------------------------------------------------------------------------
create table public.attendance_correction_item (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  correction_id uuid not null,
  position integer not null,
  action text not null,
  direction text,
  occurred_at timestamptz,
  -- the live punch a `void` targets
  punch_id uuid,
  -- the punch an approved `add` created
  result_punch_id uuid,
  constraint attendance_correction_item_company_id_id_uk unique (company_id, id),
  constraint attendance_correction_item_position_uk unique (correction_id, position),
  constraint attendance_correction_item_correction_fk foreign key (company_id, correction_id) references public.attendance_correction (company_id, id),
  constraint attendance_correction_item_punch_fk foreign key (company_id, punch_id) references public.attendance_punch (company_id, id),
  constraint attendance_correction_item_result_fk foreign key (company_id, result_punch_id) references public.attendance_punch (company_id, id),
  constraint attendance_correction_item_position_ck check (position between 0 and 3),
  constraint attendance_correction_item_action_ck check (
    (action = 'add' and direction in ('in', 'out') and occurred_at is not null and punch_id is null)
    or (action = 'void' and punch_id is not null and direction is null and occurred_at is null and result_punch_id is null)
  )
);

create index attendance_correction_item_punch_idx on public.attendance_correction_item (company_id, punch_id) where punch_id is not null;

alter table public.attendance_correction_item enable row level security;
alter table public.attendance_correction_item force row level security;
create policy attendance_correction_item_tenant_isolation on public.attendance_correction_item
  using (company_id = current_setting('app.company_id', true)::uuid);

-- Immutable except result_punch_id, set once (by the approval).
create function public.attendance_correction_item_guard() returns trigger
  language plpgsql
as $$
begin
  if new.id is distinct from old.id or new.company_id is distinct from old.company_id or new.correction_id is distinct from old.correction_id
     or new.position is distinct from old.position or new.action is distinct from old.action or new.direction is distinct from old.direction
     or new.occurred_at is distinct from old.occurred_at or new.punch_id is distinct from old.punch_id
     or old.result_punch_id is not null then
    raise exception 'attendance_correction_item %: an item is immutable except result_punch_id, set once', old.id
      using errcode = 'check_violation', constraint = 'attendance_correction_item_immutable';
  end if;
  return new;
end
$$;

create trigger attendance_correction_item_guard_tg
  before update on public.attendance_correction_item
  for each row execute function public.attendance_correction_item_guard();

-- ---------------------------------------------------------------------------------------------------------
-- The correction audit: events without the personal payload (header of this file). SECURITY DEFINER like
-- audit.capture(); the company comes from the row, the actor and request id from the transaction's settings.
create function audit.capture_correction_event() returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, audit
as $$
declare
  v_company uuid;
  v_subject uuid;
  v_type text;
  v_data jsonb := '{}'::jsonb;
begin
  if tg_op = 'DELETE' and session_user = 'hrforce_worker' then
    return null;
  end if;
  if tg_table_name = 'attendance_correction' then
    if tg_op = 'INSERT' then
      v_company := new.company_id; v_subject := new.id; v_type := 'attendance.correction_requested';
    elsif tg_op = 'UPDATE' then
      if new.status is not distinct from old.status then
        return null;
      end if;
      v_company := new.company_id; v_subject := new.id; v_type := 'attendance.correction_' || new.status;
    else
      v_company := old.company_id; v_subject := old.id; v_type := 'attendance.correction_deleted';
    end if;
  else
    if tg_op = 'INSERT' then
      v_company := new.company_id; v_subject := new.correction_id; v_type := 'attendance.correction_item_added';
      v_data := jsonb_build_object('position', new.position, 'action', new.action, 'direction', new.direction);
    elsif tg_op = 'UPDATE' then
      return null;
    else
      v_company := old.company_id; v_subject := old.correction_id; v_type := 'attendance.correction_item_deleted';
      v_data := jsonb_build_object('position', old.position);
    end if;
  end if;
  insert into audit.event (company_id, actor_user_id, request_id, type, subject_type, subject_id, data)
  values (v_company, audit.setting_uuid('app.user_id'), nullif(current_setting('app.request_id', true), ''), v_type,
          'attendance_correction', v_subject, v_data);
  return null;
end
$$;

revoke all on function audit.capture_correction_event() from public;

create trigger audit_capture_tg after insert or update or delete on public.attendance_correction
  for each row execute function audit.capture_correction_event();
create trigger audit_capture_tg after insert or update or delete on public.attendance_correction_item
  for each row execute function audit.capture_correction_event();

-- ---------------------------------------------------------------------------------------------------------
-- Privileges: nothing of this slice is deleted by the app; the worker deletes both tables (retention).
revoke delete on table public.attendance_correction, public.attendance_correction_item from hrforce_app;
revoke all on function public.attendance_correction_guard(), public.attendance_correction_item_guard() from public;
grant delete on table public.attendance_correction, public.attendance_correction_item to hrforce_worker;

-- ---------------------------------------------------------------------------------------------------------
-- Cross-module: the workflow engine gets its third subject type; notifications can be about a correction.
alter table public.workflow_instance drop constraint workflow_instance_subject_type_ck;
alter table public.workflow_instance
  add constraint workflow_instance_subject_type_ck check (subject_type in ('leave_request', 'document_request', 'attendance_correction'));

alter table public.notification drop constraint notification_subject_type_ck;
alter table public.notification
  add constraint notification_subject_type_ck check (subject_type in ('workflow_task', 'leave_request', 'document_request', 'issued_document', 'attendance_correction'));

-- The two correction chains of every existing company (new companies: seedAttendanceDefaults): unit head (manager)
-- then HR holding attendance.manage over the employee's unit; or the HR step alone.
insert into public.workflow_definition (company_id, code, name_fr, name_ar, name_en, steps, is_system)
select c.id, d.code, d.name_fr, d.name_ar, d.name_en, d.steps::jsonb, true
  from public.company c
  cross join (values
          ('attendance.manager_then_hr', 'Responsable puis RH', 'المسؤول المباشر ثم الموارد البشرية', 'Manager then HR',
           '[{"key": "manager", "kind": "manager", "labels": {"fr": "Responsable", "ar": "المسؤول المباشر", "en": "Manager"}},
             {"key": "hr", "kind": "permission", "permission": "attendance.manage", "labels": {"fr": "RH", "ar": "الموارد البشرية", "en": "HR"}}]'),
          ('attendance.hr_only', 'RH uniquement', 'الموارد البشرية فقط', 'HR only',
           '[{"key": "hr", "kind": "permission", "permission": "attendance.manage", "labels": {"fr": "RH", "ar": "الموارد البشرية", "en": "HR"}}]')
       ) as d (code, name_fr, name_ar, name_en, steps)
on conflict (company_id, code) do nothing;
