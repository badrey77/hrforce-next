-- 0023: Employment contracts and deadlines (docs/contracts/contracts-deadlines.md).
--   employment_contract   the contracts of an employment: type, dates (inclusive end), probation, renewals; never
--                         overlapping, numbered per employment; no delete
--   contract_decision     renew / convert to CDI / end, proposed by the unit head and approved by HR (workflow
--                         `contract.decision`) before a fixed-term contract ends; at most one pending per contract
--   deadline_ack          a deadline marked as handled (kind + subject + due date); deletable (undo)
--   deadline_policy       notice periods per company (a company without a row uses the column defaults)
-- Also: permission group `deadlines`, four permissions and their system-role grants, the workflow subject type
-- `contract_decision`, notification subject types `contract_decision` and `deadline_digest`, the workflow definition
-- `contract.decision` for every existing company, and the writes of the daily job (hrforce_worker): it opens
-- decision workflows and sends the deadline digest.

-- ---------------------------------------------------------------------------------------------------------
-- Permissions and their system-role grants (none is in the two-step sign-in list).
alter table public.permission drop constraint permission_group_ck;
alter table public.permission
  add constraint permission_group_ck check (group_code in ('organization', 'access', 'employee', 'leave', 'documents', 'attendance', 'sso', 'recruitment', 'settings', 'deadlines', 'sensitive'));

insert into public.permission (code, label_fr, label_ar, label_en, group_code, sensitive, sort_order) values
  ('employee.contract.manage', 'Gérer les contrats de travail', 'تسيير عقود العمل', 'Manage employment contracts', 'employee', false, 340),
  ('deadline.read', 'Consulter les échéances', 'الاطلاع على الآجال', 'View deadlines', 'deadlines', false, 1110),
  ('deadline.handle', 'Traiter les échéances', 'معالجة الآجال', 'Handle deadlines', 'deadlines', false, 1120),
  ('deadline.configure', 'Paramétrer les échéances', 'إعداد الآجال', 'Configure deadlines', 'deadlines', false, 1130);

insert into public.role_permission (company_id, role_id, permission_code)
select r.company_id, r.id, p.code
  from public.role r
  cross join (values ('employee.contract.manage'), ('deadline.read'), ('deadline.handle')) as p (code)
 where r.is_system and r.code in ('admin_rh_central', 'rh_regional')
on conflict (role_id, permission_code) do nothing;

insert into public.role_permission (company_id, role_id, permission_code)
select r.company_id, r.id, 'deadline.configure'
  from public.role r
 where r.is_system and r.code = 'admin_rh_central'
on conflict (role_id, permission_code) do nothing;

-- ---------------------------------------------------------------------------------------------------------
create table public.employment_contract (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company (id),
  employment_id uuid not null,
  seq integer not null,
  kind text not null,
  contract_type text not null,
  start_date date not null,
  -- the LAST day of the contract (inclusive); null only for a CDI
  end_date date,
  -- the last day of the probation period
  probation_end date,
  -- the paper contract's number
  reference text,
  -- e.g. the motive of a fixed-term contract
  reason text,
  note text,
  -- the contract decision that created it (renewal / conversion), set by the decision's approval
  decision_id uuid,
  -- auth.user_account id, without FK (hrforce_app has no privilege on auth.*); null = created by the system
  created_by uuid,
  created_at timestamptz not null default now(),
  constraint employment_contract_company_id_id_uk unique (company_id, id),
  constraint employment_contract_employment_id_uk unique (company_id, employment_id, id),
  constraint employment_contract_seq_uk unique (company_id, employment_id, seq),
  constraint employment_contract_employment_fk foreign key (company_id, employment_id) references public.employment (company_id, id),
  constraint employment_contract_seq_ck check (seq >= 1 and (seq = 1) = (kind = 'initial')),
  constraint employment_contract_kind_ck check (kind in ('initial', 'renewal', 'conversion', 'amendment')),
  constraint employment_contract_type_ck check (contract_type in ('cdi', 'cdd', 'pre_emploi', 'apprentissage', 'stage')),
  -- every type but CDI is fixed-term (an end is required); a CDI is entered without an end and only gets one when a
  -- later amendment / conversion supersedes it (the day before the new contract; the API refuses one on input)
  constraint employment_contract_end_ck check (end_date is not null or contract_type = 'cdi'),
  constraint employment_contract_dates_ck check (end_date is null or end_date >= start_date),
  constraint employment_contract_probation_ck check (
    probation_end is null
    or (probation_end >= start_date and probation_end < (start_date + interval '12 months')::date
        and (end_date is null or probation_end <= end_date))
  ),
  constraint employment_contract_reference_ck check (reference is null or (reference = btrim(reference) and char_length(reference) between 1 and 40)),
  constraint employment_contract_reason_ck check (reason is null or (reason = btrim(reason) and char_length(reason) between 1 and 300)),
  constraint employment_contract_note_ck check (note is null or (note = btrim(note) and char_length(note) between 1 and 500)),
  -- the contracts of an employment never overlap (inclusive end)
  constraint employment_contract_no_overlap_ex exclude using gist (
    company_id with =, employment_id with =, daterange(start_date, end_date, '[]') with &&
  )
);

create index employment_contract_end_idx on public.employment_contract (company_id, end_date) where end_date is not null;
create index employment_contract_probation_idx on public.employment_contract (company_id, probation_end) where probation_end is not null;

alter table public.employment_contract enable row level security;
alter table public.employment_contract force row level security;
create policy employment_contract_tenant_isolation on public.employment_contract
  using (company_id = current_setting('app.company_id', true)::uuid);

-- identity columns never change (corrections touch dates and texts only)
create function public.employment_contract_guard() returns trigger
  language plpgsql
as $$
begin
  if new.id is distinct from old.id or new.company_id is distinct from old.company_id
     or new.employment_id is distinct from old.employment_id or new.seq is distinct from old.seq
     or new.kind is distinct from old.kind or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'employment_contract %: identity columns never change', old.id
      using errcode = 'check_violation', constraint = 'employment_contract_immutable';
  end if;
  return new;
end
$$;

create trigger employment_contract_guard_tg
  before update on public.employment_contract
  for each row execute function public.employment_contract_guard();

-- ---------------------------------------------------------------------------------------------------------
create table public.contract_decision (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company (id),
  employment_id uuid not null,
  -- the fixed-term contract that ends
  contract_id uuid not null,
  status text not null default 'pending',
  proposal text,
  proposed_start_date date,
  proposed_end_date date,
  comment text,
  proposed_by uuid,
  proposed_at timestamptz,
  workflow_instance_id uuid,
  result_contract_id uuid,
  -- 'system' (the daily job) or the id of the user who opened it
  opened_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint contract_decision_company_id_id_uk unique (company_id, id),
  constraint contract_decision_contract_fk foreign key (company_id, employment_id, contract_id)
    references public.employment_contract (company_id, employment_id, id),
  constraint contract_decision_result_fk foreign key (company_id, employment_id, result_contract_id)
    references public.employment_contract (company_id, employment_id, id),
  constraint contract_decision_workflow_fk foreign key (company_id, workflow_instance_id) references public.workflow_instance (company_id, id),
  constraint contract_decision_status_ck check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  constraint contract_decision_proposal_ck check (proposal is null or proposal in ('renew', 'convert_cdi', 'end')),
  -- a renewal needs its end date, nothing else has one
  constraint contract_decision_end_ck check ((proposed_end_date is not null) = (proposal is not distinct from 'renew')),
  constraint contract_decision_dates_ck check (proposed_end_date is null or proposed_start_date is null or proposed_end_date >= proposed_start_date),
  constraint contract_decision_proposed_ck check ((proposal is null) = (proposed_at is null)),
  constraint contract_decision_comment_ck check (comment is null or (comment = btrim(comment) and char_length(comment) between 1 and 500)),
  constraint contract_decision_opened_by_ck check (opened_by = 'system' or opened_by ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
);

-- at most one pending decision per contract
create unique index contract_decision_one_pending_uk on public.contract_decision (company_id, contract_id) where status = 'pending';
create index contract_decision_employment_idx on public.contract_decision (company_id, employment_id);

alter table public.contract_decision enable row level security;
alter table public.contract_decision force row level security;
create policy contract_decision_tenant_isolation on public.contract_decision
  using (company_id = current_setting('app.company_id', true)::uuid);

alter table public.employment_contract
  add constraint employment_contract_decision_fk foreign key (company_id, decision_id) references public.contract_decision (company_id, id);

-- ---------------------------------------------------------------------------------------------------------
create table public.deadline_ack (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company (id),
  kind text not null,
  -- contract id (probation_end, contract_end), employee_file id (document_expiry) or employment id (retirement,
  -- contract_missing); no FK: the subject's table depends on the kind
  subject_id uuid not null,
  due_date date not null,
  note text,
  acked_by uuid not null,
  acked_at timestamptz not null default now(),
  constraint deadline_ack_company_id_id_uk unique (company_id, id),
  constraint deadline_ack_once_uk unique (company_id, kind, subject_id, due_date),
  constraint deadline_ack_kind_ck check (kind in ('probation_end', 'contract_end', 'document_expiry', 'retirement', 'contract_missing')),
  constraint deadline_ack_note_ck check (note is null or (note = btrim(note) and char_length(note) between 1 and 300))
);

alter table public.deadline_ack enable row level security;
alter table public.deadline_ack force row level security;
create policy deadline_ack_tenant_isolation on public.deadline_ack
  using (company_id = current_setting('app.company_id', true)::uuid);

-- ---------------------------------------------------------------------------------------------------------
create table public.deadline_policy (
  company_id uuid primary key references public.company (id),
  probation_notice_days integer not null default 15,
  contract_notice_days integer not null default 30,
  decision_notice_days integer not null default 45,
  document_notice_days integer not null default 30,
  retirement_age integer not null default 60,
  retirement_notice_months integer not null default 6,
  digest_enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  constraint deadline_policy_ranges_ck check (
    probation_notice_days between 1 and 90
    and contract_notice_days between 1 and 180
    and decision_notice_days between 0 and 180
    and document_notice_days between 1 and 180
    and retirement_age between 50 and 70
    and retirement_notice_months between 1 and 24
  )
);

alter table public.deadline_policy enable row level security;
alter table public.deadline_policy force row level security;
create policy deadline_policy_tenant_isolation on public.deadline_policy
  using (company_id = current_setting('app.company_id', true)::uuid);

-- ---------------------------------------------------------------------------------------------------------
-- Privileges. hrforce_app: DML by 0001's default privileges; contracts and decisions are never deleted, a policy row
-- neither (a reset writes the defaults). hrforce_worker (the daily job, SELECT by 0012's default privileges): opens a
-- decision (its row + the workflow instance and first task + the task notification) and sends the digest.
revoke delete on table public.employment_contract, public.contract_decision, public.deadline_policy from hrforce_app;
revoke all on function public.employment_contract_guard() from public;

grant insert, update (workflow_instance_id) on table public.contract_decision to hrforce_worker;
grant insert, update (current_step) on table public.workflow_instance to hrforce_worker;
grant insert on table public.workflow_task to hrforce_worker;
grant insert on table public.notification to hrforce_worker;

-- ---------------------------------------------------------------------------------------------------------
-- Audit: row triggers on the four tables (no exemption).
create trigger audit_capture_tg after insert or update or delete on public.employment_contract
  for each row execute function audit.capture();
create trigger audit_capture_tg after insert or update or delete on public.contract_decision
  for each row execute function audit.capture();
create trigger audit_capture_tg after insert or update or delete on public.deadline_ack
  for each row execute function audit.capture();
create trigger audit_capture_tg after insert or update or delete on public.deadline_policy
  for each row execute function audit.capture('company_id');

-- ---------------------------------------------------------------------------------------------------------
-- Cross-module: the workflow engine's fifth subject type; notifications about a decision and the daily digest.
alter table public.workflow_instance drop constraint workflow_instance_subject_type_ck;
alter table public.workflow_instance
  add constraint workflow_instance_subject_type_ck check (subject_type in ('leave_request', 'document_request', 'attendance_correction', 'recruitment_opening', 'contract_decision'));

alter table public.notification drop constraint notification_subject_type_ck;
alter table public.notification
  add constraint notification_subject_type_ck check (subject_type in ('workflow_task', 'leave_request', 'document_request', 'issued_document', 'attendance_correction', 'recruitment_opening', 'recruitment_interview', 'contract_decision', 'deadline_digest'));

-- The decision chain of every existing company (new ones: seedContractDefaults, called by bootstrap and seed:dev):
-- the employee's manager (escalated to HR when there is none, as for leave) then HR holding employee.contract.manage.
insert into public.workflow_definition (company_id, code, name_fr, name_ar, name_en, steps, is_system)
select c.id, 'contract.decision', 'Décision de fin de contrat', 'قرار بشأن نهاية العقد', 'End-of-contract decision',
       '[{"key": "manager", "kind": "manager", "labels": {"fr": "Responsable", "ar": "المسؤول", "en": "Manager"}},
         {"key": "hr", "kind": "permission", "permission": "employee.contract.manage", "labels": {"fr": "RH", "ar": "الموارد البشرية", "en": "HR"}}]'::jsonb,
       true
  from public.company c
on conflict (company_id, code) do nothing;
