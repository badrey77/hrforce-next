-- 0011: self-service links, unit heads, the workflow engine and leave (docs/contracts/leave.md, ADR 006).
--   user_employment      a user ↔ the employment they are (self-service); one per user, one per employment
--   org_unit_head        date-effective head of a unit (an employment), no overlap per unit
--   workflow_definition  ordered approval steps (manager / permission), per company
--   workflow_instance    one run of a definition for a subject (a leave request)
--   workflow_task        one step of an instance: who may act, and what was done (history, append-only)
--   leave_policy         per company: reference-year start month, weekend days, entitlement delay
--   leave_type           per company: counting mode, balance / accrual rules, workflow
--   public_holiday       per company, per date (lunar ones flagged `approximate`)
--   leave_request        a request for leave (days computed by the API, mirrored status of its workflow)
--   leave_ledger         append-only movements of leave balances (accrual / taken / adjustment / reversal)
--   site.south_supplement_days  extra annual days for southern sites (Law 90-11 art. 42), 0 = off (default)
-- Plus the `leave` permission group and codes, their system-role grants and the new system role `employe`.
--
-- Every new table: company_id + RLS/FORCE + the standard tenant policy, composite (company_id, …) foreign keys, the
-- audit trigger (leave_policy is keyed on company_id). Users are referenced without FK (hrforce_app has no privilege
-- on auth.*), like role_grant.user_id; membership is checked by the use cases.
-- Race-free rules live here: one link per user / employment, head validity per unit (exclusion), no overlapping
-- pending/approved leave requests per employment (partial exclusion), one open task per workflow instance,
-- one accrual row per employment / type / month, append-only ledger, task history immutable once closed, and
-- separation of duties on tasks (nobody closes a task of an instance they started or are the subject of).

-- ---------------------------------------------------------------------------------------------------------
-- Southern supplement: per site, whole days per reference year (0 = none).
alter table public.site
  add column south_supplement_days integer not null default 0,
  add constraint site_south_supplement_days_ck check (south_supplement_days between 0 and 60);

-- ---------------------------------------------------------------------------------------------------------
create table public.user_employment (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company (id),
  user_id uuid not null,
  employment_id uuid not null,
  linked_by uuid,
  linked_at timestamptz not null default now(),
  constraint user_employment_employment_fk foreign key (company_id, employment_id) references public.employment (company_id, id),
  constraint user_employment_user_uk unique (company_id, user_id),
  constraint user_employment_employment_uk unique (employment_id),
  -- separation of duties: nobody links themselves to an employment (that would make them a manager / requester)
  constraint user_employment_not_self_ck check (linked_by is null or linked_by <> user_id)
);

alter table public.user_employment enable row level security;
alter table public.user_employment force row level security;
create policy user_employment_tenant_isolation on public.user_employment
  using (company_id = current_setting('app.company_id', true)::uuid);

-- ---------------------------------------------------------------------------------------------------------
create table public.org_unit_head (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  org_unit_id uuid not null,
  employment_id uuid not null,
  valid daterange not null,
  created_at timestamptz not null default now(),
  constraint org_unit_head_unit_fk foreign key (company_id, org_unit_id) references public.org_unit (company_id, id),
  constraint org_unit_head_employment_fk foreign key (company_id, employment_id) references public.employment (company_id, id),
  constraint org_unit_head_valid_ck check (
    not isempty(valid) and lower(valid) is not null and lower_inc(valid) and not upper_inc(valid)
  ),
  constraint org_unit_head_no_overlap_ex exclude using gist (org_unit_id with =, valid with &&)
);

create index org_unit_head_company_unit_idx on public.org_unit_head (company_id, org_unit_id);
create index org_unit_head_company_employment_idx on public.org_unit_head (company_id, employment_id);

alter table public.org_unit_head enable row level security;
alter table public.org_unit_head force row level security;
create policy org_unit_head_tenant_isolation on public.org_unit_head
  using (company_id = current_setting('app.company_id', true)::uuid);

-- A head's unit, employment and start are immutable; only the end moves (earlier, or closing an open range).
create function public.org_unit_head_guard() returns trigger
  language plpgsql
as $$
begin
  if new.company_id is distinct from old.company_id or new.org_unit_id is distinct from old.org_unit_id
     or new.employment_id is distinct from old.employment_id or lower(new.valid) is distinct from lower(old.valid) then
    raise exception 'org_unit_head: only the end of the range may change' using errcode = 'check_violation', constraint = 'org_unit_head_immutable';
  end if;
  if upper(old.valid) is not null and (upper(new.valid) is null or upper(new.valid) > upper(old.valid)) then
    raise exception 'org_unit_head: a range can only be shortened' using errcode = 'check_violation', constraint = 'org_unit_head_only_shortened';
  end if;
  return new;
end
$$;

create trigger org_unit_head_guard_tg
  before update on public.org_unit_head
  for each row execute function public.org_unit_head_guard();

-- ---------------------------------------------------------------------------------------------------------
-- Workflow engine (ADR 006).
create table public.workflow_definition (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company (id),
  code text not null,
  name_fr text not null,
  name_ar text not null,
  name_en text not null,
  -- ordered [{key, kind: 'manager' | 'permission', permission?, labels: {fr, ar, en}}]; validated by the app
  steps jsonb not null,
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  constraint workflow_definition_company_id_id_uk unique (company_id, id),
  constraint workflow_definition_company_code_uk unique (company_id, code),
  constraint workflow_definition_code_ck check (code ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$' and char_length(code) <= 64),
  constraint workflow_definition_names_ck check (
    name_fr = btrim(name_fr) and char_length(name_fr) between 1 and 120
    and name_ar = btrim(name_ar) and char_length(name_ar) between 1 and 120
    and name_en = btrim(name_en) and char_length(name_en) between 1 and 120
  ),
  constraint workflow_definition_steps_ck check (jsonb_typeof(steps) = 'array' and jsonb_array_length(steps) between 1 and 10)
);

alter table public.workflow_definition enable row level security;
alter table public.workflow_definition force row level security;
create policy workflow_definition_tenant_isolation on public.workflow_definition
  using (company_id = current_setting('app.company_id', true)::uuid);

create table public.workflow_instance (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  definition_id uuid not null,
  subject_type text not null,
  subject_id uuid not null,
  status text not null default 'pending',
  current_step integer not null default 0,
  started_by uuid not null,
  -- the user the subject is about (a leave request's employee's linked user), excluded from acting like started_by
  subject_user_id uuid,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint workflow_instance_definition_fk foreign key (company_id, definition_id) references public.workflow_definition (company_id, id),
  constraint workflow_instance_company_id_id_uk unique (company_id, id),
  constraint workflow_instance_subject_uk unique (company_id, subject_type, subject_id),
  constraint workflow_instance_subject_type_ck check (subject_type in ('leave_request')),
  constraint workflow_instance_status_ck check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  constraint workflow_instance_finished_ck check ((status = 'pending') = (finished_at is null)),
  constraint workflow_instance_current_step_ck check (current_step >= 0)
);

create index workflow_instance_company_status_idx on public.workflow_instance (company_id, status);

alter table public.workflow_instance enable row level security;
alter table public.workflow_instance force row level security;
create policy workflow_instance_tenant_isolation on public.workflow_instance
  using (company_id = current_setting('app.company_id', true)::uuid);

create table public.workflow_task (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  instance_id uuid not null,
  step_key text not null,
  step_index integer not null,
  assignee_kind text not null,
  assignee_user_id uuid,
  permission text references public.permission (code),
  -- the unit the permission must cover (the subject employee's unit)
  scope_unit_id uuid not null,
  status text not null default 'open',
  outcome text,
  acted_by uuid,
  acted_at timestamptz,
  comment text,
  created_at timestamptz not null default now(),
  constraint workflow_task_instance_fk foreign key (company_id, instance_id) references public.workflow_instance (company_id, id),
  constraint workflow_task_unit_fk foreign key (company_id, scope_unit_id) references public.org_unit (company_id, id),
  constraint workflow_task_step_ck check (step_index >= 0 and step_key ~ '^[a-z][a-z0-9_]{0,31}$'),
  constraint workflow_task_assignee_ck check (
    (assignee_kind = 'user' and assignee_user_id is not null and permission is null)
    or (assignee_kind = 'permission' and permission is not null and assignee_user_id is null)
    or (assignee_kind = 'none' and assignee_user_id is null and permission is null)
  ),
  constraint workflow_task_status_ck check (status in ('open', 'done', 'skipped', 'cancelled')),
  constraint workflow_task_outcome_ck check (
    (status = 'open' and outcome is null and acted_by is null and acted_at is null)
    or (status = 'done' and outcome in ('approve', 'reject') and acted_by is not null and acted_at is not null)
    or (status = 'skipped' and outcome = 'escalated' and acted_by is null)
    or (status = 'cancelled' and outcome is null)
  ),
  constraint workflow_task_reject_comment_ck check (outcome is distinct from 'reject' or (comment is not null and btrim(comment) <> '')),
  constraint workflow_task_comment_ck check (comment is null or char_length(comment) <= 1000)
);

-- at most one open task per instance (the engine is sequential)
create unique index workflow_task_one_open_uk on public.workflow_task (instance_id) where status = 'open';
create index workflow_task_company_instance_idx on public.workflow_task (company_id, instance_id);
create index workflow_task_open_user_idx on public.workflow_task (company_id, assignee_user_id) where status = 'open';
create index workflow_task_open_permission_idx on public.workflow_task (company_id, permission, scope_unit_id) where status = 'open';

alter table public.workflow_task enable row level security;
alter table public.workflow_task force row level security;
create policy workflow_task_tenant_isolation on public.workflow_task
  using (company_id = current_setting('app.company_id', true)::uuid);

-- History: a closed task never changes; an open task may only be closed (status, outcome, actor, time, comment), and
-- — separation of duties — never by the user who started its instance or whom the instance is about.
create function public.workflow_task_guard() returns trigger
  language plpgsql
as $$
declare
  v_started_by uuid;
  v_subject_user uuid;
begin
  if old.status <> 'open' then
    raise exception 'workflow_task %: a closed task is history and cannot change', old.id
      using errcode = 'check_violation', constraint = 'workflow_task_history';
  end if;
  if new.company_id is distinct from old.company_id or new.instance_id is distinct from old.instance_id
     or new.step_key is distinct from old.step_key or new.step_index is distinct from old.step_index
     or new.assignee_kind is distinct from old.assignee_kind or new.assignee_user_id is distinct from old.assignee_user_id
     or new.permission is distinct from old.permission or new.scope_unit_id is distinct from old.scope_unit_id
     or new.created_at is distinct from old.created_at then
    raise exception 'workflow_task %: only status, outcome, acted_by, acted_at and comment may change', old.id
      using errcode = 'check_violation', constraint = 'workflow_task_immutable';
  end if;
  if new.acted_by is not null then
    select i.started_by, i.subject_user_id into v_started_by, v_subject_user
      from public.workflow_instance i where i.id = new.instance_id;
    if new.acted_by = v_started_by or new.acted_by = v_subject_user then
      raise exception 'workflow_task %: nobody acts on a task of their own request', old.id
        using errcode = 'check_violation', constraint = 'workflow_task_self_approval';
    end if;
  end if;
  return new;
end
$$;

create trigger workflow_task_guard_tg
  before update on public.workflow_task
  for each row execute function public.workflow_task_guard();

-- ---------------------------------------------------------------------------------------------------------
-- Leave configuration.
create table public.leave_policy (
  company_id uuid primary key references public.company (id),
  -- first month of the reference year (Law 90-11: 1 July → 30 June)
  reference_start_month integer not null default 7,
  -- ISO day numbers (1 = Monday … 7 = Sunday); {5,6} = Friday + Saturday
  weekend_days integer[] not null default '{5,6}',
  -- accrued entitlement of a reference year becomes usable this many months after the year starts (12: the days
  -- earned from 1 July N-1 to 30 June N are taken from 1 July N)
  entitlement_delay_months integer not null default 12,
  updated_at timestamptz not null default now(),
  constraint leave_policy_start_month_ck check (reference_start_month between 1 and 12),
  constraint leave_policy_weekend_ck check (weekend_days <@ '{1,2,3,4,5,6,7}'::integer[] and cardinality(weekend_days) <= 3),
  constraint leave_policy_delay_ck check (entitlement_delay_months between 0 and 24)
);

alter table public.leave_policy enable row level security;
alter table public.leave_policy force row level security;
create policy leave_policy_tenant_isolation on public.leave_policy
  using (company_id = current_setting('app.company_id', true)::uuid);

create table public.leave_type (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company (id),
  code text not null,
  name_fr text not null,
  name_ar text not null,
  name_en text not null,
  count_mode text not null,
  has_balance boolean not null default false,
  accrual_days_per_month numeric(4, 2),
  max_days_per_year numeric(5, 1),
  max_days_per_request numeric(5, 1),
  once_per_career boolean not null default false,
  requires_document boolean not null default false,
  workflow_definition_id uuid not null,
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  constraint leave_type_company_id_id_uk unique (company_id, id),
  constraint leave_type_company_code_uk unique (company_id, code),
  constraint leave_type_workflow_fk foreign key (company_id, workflow_definition_id) references public.workflow_definition (company_id, id),
  constraint leave_type_code_ck check (code ~ '^[a-z][a-z0-9_]{1,31}$'),
  constraint leave_type_names_ck check (
    name_fr = btrim(name_fr) and char_length(name_fr) between 1 and 120
    and name_ar = btrim(name_ar) and char_length(name_ar) between 1 and 120
    and name_en = btrim(name_en) and char_length(name_en) between 1 and 120
  ),
  constraint leave_type_count_mode_ck check (count_mode in ('calendar', 'working')),
  constraint leave_type_accrual_ck check (accrual_days_per_month is null or (has_balance and accrual_days_per_month > 0 and accrual_days_per_month <= 31)),
  constraint leave_type_max_year_ck check (max_days_per_year is null or max_days_per_year > 0),
  constraint leave_type_max_request_ck check (max_days_per_request is null or max_days_per_request > 0)
);

alter table public.leave_type enable row level security;
alter table public.leave_type force row level security;
create policy leave_type_tenant_isolation on public.leave_type
  using (company_id = current_setting('app.company_id', true)::uuid);

create table public.public_holiday (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company (id),
  date date not null,
  name_fr text not null,
  name_ar text not null,
  name_en text not null,
  approximate boolean not null default false,
  created_at timestamptz not null default now(),
  constraint public_holiday_company_date_uk unique (company_id, date),
  constraint public_holiday_names_ck check (
    name_fr = btrim(name_fr) and char_length(name_fr) between 1 and 120
    and name_ar = btrim(name_ar) and char_length(name_ar) between 1 and 120
    and name_en = btrim(name_en) and char_length(name_en) between 1 and 120
  )
);

alter table public.public_holiday enable row level security;
alter table public.public_holiday force row level security;
create policy public_holiday_tenant_isolation on public.public_holiday
  using (company_id = current_setting('app.company_id', true)::uuid);

-- ---------------------------------------------------------------------------------------------------------
-- Leave requests.
create table public.leave_request (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  employment_id uuid not null,
  leave_type_id uuid not null,
  -- the employee's unit when the request was made: decides who may read it (leave.read scope) and the HR step
  org_unit_id uuid not null,
  start_date date not null,
  end_date date not null,
  days numeric(5, 1) not null,
  half_day_start boolean not null default false,
  half_day_end boolean not null default false,
  reason text,
  document_ref text,
  status text not null default 'pending',
  requested_by uuid not null,
  requested_at timestamptz not null default now(),
  workflow_instance_id uuid,
  constraint leave_request_company_id_id_uk unique (company_id, id),
  constraint leave_request_employment_fk foreign key (company_id, employment_id) references public.employment (company_id, id),
  constraint leave_request_type_fk foreign key (company_id, leave_type_id) references public.leave_type (company_id, id),
  constraint leave_request_unit_fk foreign key (company_id, org_unit_id) references public.org_unit (company_id, id),
  constraint leave_request_instance_fk foreign key (company_id, workflow_instance_id) references public.workflow_instance (company_id, id),
  constraint leave_request_dates_ck check (end_date >= start_date),
  constraint leave_request_days_ck check (days > 0 and days * 2 = trunc(days * 2)),
  constraint leave_request_half_days_ck check (start_date < end_date or not (half_day_start and half_day_end)),
  constraint leave_request_status_ck check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  constraint leave_request_reason_ck check (reason is null or (reason = btrim(reason) and char_length(reason) between 1 and 500)),
  constraint leave_request_document_ck check (document_ref is null or (document_ref = btrim(document_ref) and char_length(document_ref) between 1 and 200)),
  -- no two live (pending / approved) requests of an employment intersect (inclusive dates)
  constraint leave_request_no_overlap_ex exclude using gist (
    employment_id with =, daterange(start_date, end_date, '[]') with &&
  ) where (status in ('pending', 'approved'))
);

create index leave_request_company_employment_idx on public.leave_request (company_id, employment_id, start_date desc);
create index leave_request_company_unit_idx on public.leave_request (company_id, org_unit_id);
create index leave_request_company_status_idx on public.leave_request (company_id, status, start_date);

alter table public.leave_request enable row level security;
alter table public.leave_request force row level security;
create policy leave_request_tenant_isolation on public.leave_request
  using (company_id = current_setting('app.company_id', true)::uuid);

-- What was asked is immutable; only the status (mirrored from the workflow) and the instance link change.
create function public.leave_request_guard() returns trigger
  language plpgsql
as $$
begin
  if new.company_id is distinct from old.company_id or new.employment_id is distinct from old.employment_id
     or new.leave_type_id is distinct from old.leave_type_id or new.org_unit_id is distinct from old.org_unit_id
     or new.start_date is distinct from old.start_date or new.end_date is distinct from old.end_date
     or new.days is distinct from old.days or new.half_day_start is distinct from old.half_day_start
     or new.half_day_end is distinct from old.half_day_end or new.reason is distinct from old.reason
     or new.document_ref is distinct from old.document_ref or new.requested_by is distinct from old.requested_by
     or new.requested_at is distinct from old.requested_at
     or (old.workflow_instance_id is not null and new.workflow_instance_id is distinct from old.workflow_instance_id) then
    raise exception 'leave_request %: only status and workflow_instance_id may change', old.id
      using errcode = 'check_violation', constraint = 'leave_request_immutable';
  end if;
  if old.status in ('rejected', 'cancelled') and new.status is distinct from old.status then
    raise exception 'leave_request %: a % request is final', old.id, old.status
      using errcode = 'check_violation', constraint = 'leave_request_final';
  end if;
  return new;
end
$$;

create trigger leave_request_guard_tg
  before update on public.leave_request
  for each row execute function public.leave_request_guard();

-- ---------------------------------------------------------------------------------------------------------
-- Ledger: append-only movements; balance of (employment, type, reference year) = sum(days).
create table public.leave_ledger (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  employment_id uuid not null,
  leave_type_id uuid not null,
  -- first day of the reference year the movement belongs to
  period_start date not null,
  kind text not null,
  days numeric(5, 1) not null,
  -- accrual rows: the month accrued (first day), the idempotency key of the accrual run
  accrual_month date,
  request_id uuid,
  note text,
  created_by uuid,
  created_at timestamptz not null default now(),
  constraint leave_ledger_employment_fk foreign key (company_id, employment_id) references public.employment (company_id, id),
  constraint leave_ledger_type_fk foreign key (company_id, leave_type_id) references public.leave_type (company_id, id),
  constraint leave_ledger_request_fk foreign key (company_id, request_id) references public.leave_request (company_id, id),
  constraint leave_ledger_period_ck check (extract(day from period_start) = 1),
  constraint leave_ledger_kind_ck check (kind in ('accrual', 'taken', 'adjustment', 'reversal')),
  constraint leave_ledger_days_ck check (
    (kind in ('accrual', 'reversal') and days > 0)
    or (kind = 'taken' and days < 0)
    or (kind = 'adjustment' and days <> 0)
  ),
  constraint leave_ledger_accrual_ck check ((kind = 'accrual') = (accrual_month is not null)),
  constraint leave_ledger_accrual_month_ck check (accrual_month is null or extract(day from accrual_month) = 1),
  constraint leave_ledger_request_ck check ((kind in ('taken', 'reversal')) = (request_id is not null)),
  constraint leave_ledger_note_ck check (note is null or (note = btrim(note) and char_length(note) between 1 and 500))
);

create unique index leave_ledger_accrual_uk on public.leave_ledger (employment_id, leave_type_id, accrual_month) where kind = 'accrual';
create index leave_ledger_company_employment_idx on public.leave_ledger (company_id, employment_id, leave_type_id, period_start);
create index leave_ledger_company_request_idx on public.leave_ledger (company_id, request_id) where request_id is not null;

alter table public.leave_ledger enable row level security;
alter table public.leave_ledger force row level security;
create policy leave_ledger_tenant_isolation on public.leave_ledger
  using (company_id = current_setting('app.company_id', true)::uuid);

-- ---------------------------------------------------------------------------------------------------------
-- Privileges: history is kept. The app never deletes heads, workflow rows, requests, types, definitions or ledger
-- rows, and never updates the ledger (append-only; corrections are new `adjustment` rows). Holidays and links may
-- be deleted (their history is in the audit log). The ledger is refused for everyone except with
-- `leave.allow_purge` = on (future retention job), like audit.*.
revoke delete on table public.org_unit_head, public.workflow_definition, public.workflow_instance, public.workflow_task,
  public.leave_policy, public.leave_type, public.leave_request, public.leave_ledger
  from hrforce_app;
revoke update on table public.leave_ledger from hrforce_app;

create function public.leave_ledger_append_only() returns trigger
  language plpgsql
as $$
begin
  if coalesce(current_setting('leave.allow_purge', true), '') <> 'on' then
    raise exception 'leave_ledger is append-only (% refused)', tg_op using errcode = 'insufficient_privilege';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$$;

create trigger leave_ledger_append_only_tg
  before update or delete on public.leave_ledger
  for each row execute function public.leave_ledger_append_only();

-- ---------------------------------------------------------------------------------------------------------
-- Audit: every new tenant table (guard:db audit-per-write); leave_policy is keyed on its company.
create trigger audit_capture_tg after insert or update or delete on public.user_employment
  for each row execute function audit.capture();
create trigger audit_capture_tg after insert or update or delete on public.org_unit_head
  for each row execute function audit.capture();
create trigger audit_capture_tg after insert or update or delete on public.workflow_definition
  for each row execute function audit.capture();
create trigger audit_capture_tg after insert or update or delete on public.workflow_instance
  for each row execute function audit.capture();
create trigger audit_capture_tg after insert or update or delete on public.workflow_task
  for each row execute function audit.capture();
create trigger audit_capture_tg after insert or update or delete on public.leave_policy
  for each row execute function audit.capture('company_id');
create trigger audit_capture_tg after insert or update or delete on public.leave_type
  for each row execute function audit.capture();
create trigger audit_capture_tg after insert or update or delete on public.public_holiday
  for each row execute function audit.capture();
create trigger audit_capture_tg after insert or update or delete on public.leave_request
  for each row execute function audit.capture();
create trigger audit_capture_tg after insert or update or delete on public.leave_ledger
  for each row execute function audit.capture();

-- ---------------------------------------------------------------------------------------------------------
-- Permissions: group `leave` (sort 510–560). Held by the system roles of every company (new companies:
-- SYSTEM_ROLES in modules/authorization/domain/catalogue.ts): admin_rh_central all; rh_regional read, request,
-- approve_hr, adjust; the new role `employe` request_self. The manager step needs no permission.
-- Arabic: العطل (leave), طلب عطلة لنفسه (request leave for oneself), الاطلاع على طلبات العطل (view leave requests),
-- طلب عطلة نيابة عن موظف (request on behalf), الموافقة على العطل (الموارد البشرية) (approve, HR step),
-- تسوية أرصدة العطل (adjust balances), إعداد العطل (configure leave).
alter table public.permission drop constraint permission_group_ck;
alter table public.permission
  add constraint permission_group_ck check (group_code in ('organization', 'access', 'employee', 'leave', 'sensitive'));

-- sort_order stays "by group": leave (5xx) sits after sensitive (4xx) in sort order, the web orders groups itself.
insert into public.permission (code, label_fr, label_ar, label_en, group_code, sensitive, sort_order) values
  ('leave.request_self', 'Demander ses congés', 'طلب عطلة لنفسه', 'Request own leave', 'leave', false, 510),
  ('leave.read', 'Consulter les congés', 'الاطلاع على طلبات العطل', 'View leave', 'leave', false, 520),
  ('leave.request', 'Demander un congé pour un employé', 'طلب عطلة نيابة عن موظف', 'Request leave on behalf of an employee', 'leave', false, 530),
  ('leave.approve_hr', 'Valider les congés (RH)', 'الموافقة على العطل (الموارد البشرية)', 'Approve leave (HR)', 'leave', false, 540),
  ('leave.adjust', 'Ajuster les soldes de congés', 'تسوية أرصدة العطل', 'Adjust leave balances', 'leave', false, 550),
  ('leave.configure', 'Paramétrer les congés', 'إعداد العطل', 'Configure leave', 'leave', false, 560);

insert into public.role_permission (company_id, role_id, permission_code)
select r.company_id, r.id, p.code
  from public.role r
  join (values
          ('admin_rh_central', 'leave.request_self'), ('admin_rh_central', 'leave.read'), ('admin_rh_central', 'leave.request'),
          ('admin_rh_central', 'leave.approve_hr'), ('admin_rh_central', 'leave.adjust'), ('admin_rh_central', 'leave.configure'),
          ('rh_regional', 'leave.read'), ('rh_regional', 'leave.request'), ('rh_regional', 'leave.approve_hr'), ('rh_regional', 'leave.adjust')
       ) as p (role_code, code) on p.role_code = r.code
 where r.is_system
on conflict (role_id, permission_code) do nothing;

-- The self-service system role, for every company that has system roles.
insert into public.role (company_id, code, name_fr, name_ar, name_en, is_system)
select distinct r.company_id, 'employe', 'Employé (libre-service)', 'موظف (الخدمة الذاتية)', 'Employee (self-service)', true
  from public.role r
 where r.is_system
on conflict (company_id, lower(code)) do nothing;

insert into public.role_permission (company_id, role_id, permission_code)
select r.company_id, r.id, 'leave.request_self'
  from public.role r
 where r.is_system and r.code = 'employe'
on conflict (role_id, permission_code) do nothing;
