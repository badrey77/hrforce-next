-- 0019: recruitment, Phase A (docs/contracts/recruitment.md): job openings approved through the workflow engine
-- (subject type `recruitment_opening`), candidates and their applications, the stage history, the salary side table,
-- notes, candidate files, the company settings.
--   recruitment_policy                   one row per company: retention of candidate data, the opening approval chain
--   recruitment_opening_sequence         the per-company, per-year counter of opening references (REC-YYYY-NNNN)
--   recruitment_opening                  a post to fill: what was asked is immutable, the status follows the workflow
--   recruitment_rejection_reason         the company's reasons (deactivated instead of deleted; two automatic ones)
--   recruitment_candidate                a person who applied: identity (the columns of `person`), contact details
--   recruitment_application              one candidate on one opening: stage, decision date; anonymous once purged
--   recruitment_application_stage        the stage history (append-only; a purge only blanks the comments)
--   recruitment_application_salary       expected / proposed salary, behind recruitment.salary.read / .update
--   recruitment_note                     HR notes on an application (immutable, deletable)
--   recruitment_candidate_file           an uploaded file's metadata (hard delete: nothing outlives the erasure)
--   recruitment_candidate_file_content   its bytes (audit-exempt, tools/guardrails/audit-exempt.json)
-- Also: the permissions recruitment.* (group recruitment) and the two sensitive salary codes with their system-role
-- grants; the workflow and notification subject type `recruitment_opening`; per company the two approval chains, the
-- policy, the rejection reasons and the system employee-file category `recruitment`; the worker's purge privileges.
--
-- Every new table: company_id + RLS/FORCE + the standard tenant policy, composite (company_id, …) foreign keys. Users
-- are referenced without FK (hrforce_app has no privilege on auth.*), like role_grant.user_id.
--
-- AUDIT. The policy, the sequence, openings and rejection reasons use the standard audit.capture() (an opening holds
-- no candidate data). CANDIDATE DATA IS AUDITED AS EVENTS WITHOUT PERSONAL PAYLOAD (the attendance pattern, owner
-- decision 2026-09-29), so the retention purge and the erasure on request really erase: the six personal tables carry
-- the standard trigger name `audit_capture_tg` executing audit.capture_recruitment_event() — no audit.change_log row,
-- one audit.event per write:
--   candidate insert / update / delete   recruitment.candidate_created / _updated {fields} / _deleted
--   application insert / update          recruitment.application_created {openingId, source} / _updated {fields}
--                                        (an update of stage, stage_since, decided_at only: none — the stage row does)
--   stage row insert                     recruitment.stage_changed {from, to, reasonCode, autoCause}
--   salary insert / update / delete      recruitment.salary_changed {fields}
--   note insert / delete                 recruitment.note_added / _deleted {}
--   file insert / delete                 recruitment.file_added / _deleted {kind}
-- `fields` holds column NAMES only. No name, NIN, contact detail, amount, comment, note text, file name or hash ever
-- reaches the audit log. Writes by hrforce_worker produce no per-row event (its only writes are the purge, which
-- records one recruitment.purged per company run).

-- ---------------------------------------------------------------------------------------------------------
-- Permissions (group recruitment, 910–960; the two salary codes in `sensitive`, 446–447) and system-role grants.
alter table public.permission drop constraint permission_group_ck;
alter table public.permission
  add constraint permission_group_ck check (group_code in ('organization', 'access', 'employee', 'leave', 'documents', 'attendance', 'sso', 'recruitment', 'sensitive'));

insert into public.permission (code, label_fr, label_ar, label_en, group_code, sensitive, sort_order) values
  ('recruitment.salary.read', 'Consulter les salaires demandés et proposés', 'الاطلاع على الأجور المطلوبة والمقترحة', 'View expected and proposed salaries', 'sensitive', true, 446),
  ('recruitment.salary.update', 'Saisir les salaires demandés et proposés', 'إدخال الأجور المطلوبة والمقترحة', 'Enter expected and proposed salaries', 'sensitive', true, 447),
  ('recruitment.read', 'Consulter les recrutements et les candidatures', 'الاطلاع على عمليات التوظيف والترشحات', 'View openings and applications', 'recruitment', false, 910),
  ('recruitment.manage', 'Gérer les candidatures (saisie, étapes, pièces, notes, entretiens)', 'تسيير الترشحات (الإدخال، المراحل، الوثائق، الملاحظات، المقابلات)', 'Manage applications (entry, stages, files, notes, interviews)', 'recruitment', false, 920),
  ('recruitment.approve_opening', 'Approuver les ouvertures de poste (étape RH)', 'الموافقة على فتح المناصب (مرحلة الموارد البشرية)', 'Approve openings (HR step)', 'recruitment', false, 930),
  ('recruitment.hire', 'Proposer une offre et embaucher', 'تقديم عرض التوظيف وإتمام التوظيف', 'Make offers and hire', 'recruitment', false, 940),
  ('recruitment.erase', 'Effacer les données d''une candidature', 'حذف بيانات الترشح', 'Erase a candidate''s data', 'recruitment', false, 950),
  ('recruitment.configure', 'Paramétrer le recrutement', 'إعداد التوظيف', 'Configure recruitment', 'recruitment', false, 960);

insert into public.role_permission (company_id, role_id, permission_code)
select r.company_id, r.id, p.code
  from public.role r
  join (values
          ('admin_rh_central', 'recruitment.read'), ('admin_rh_central', 'recruitment.manage'),
          ('admin_rh_central', 'recruitment.approve_opening'), ('admin_rh_central', 'recruitment.hire'),
          ('admin_rh_central', 'recruitment.erase'), ('admin_rh_central', 'recruitment.configure'),
          ('admin_rh_central', 'recruitment.salary.read'), ('admin_rh_central', 'recruitment.salary.update'),
          ('rh_regional', 'recruitment.read'), ('rh_regional', 'recruitment.manage'),
          ('rh_regional', 'recruitment.approve_opening'), ('rh_regional', 'recruitment.hire')
       ) as p (role_code, code) on p.role_code = r.code
 where r.is_system
on conflict (role_id, permission_code) do nothing;

-- The two sensitive codes join the two-step sign-in list: new policies get them from
-- security_policy_default_permissions() (it lists every sensitive permission); existing policies that require the
-- employee salary get them appended once.
update public.security_policy
   set mfa_required_permissions = array_append(mfa_required_permissions, 'recruitment.salary.read')
 where 'employee.salary.read' = any (mfa_required_permissions)
   and not ('recruitment.salary.read' = any (mfa_required_permissions));
update public.security_policy
   set mfa_required_permissions = array_append(mfa_required_permissions, 'recruitment.salary.update')
 where 'employee.salary.read' = any (mfa_required_permissions)
   and not ('recruitment.salary.update' = any (mfa_required_permissions));

-- ---------------------------------------------------------------------------------------------------------
create table public.recruitment_policy (
  company_id uuid primary key references public.company (id),
  -- candidate data is erased this many months after the decision (rejection, withdrawal, automatic closing, hire)
  retention_months integer not null default 12,
  -- the chain new opening requests follow
  opening_workflow_code text not null default 'recruitment.manager_then_hr',
  updated_at timestamptz not null default now(),
  constraint recruitment_policy_retention_ck check (retention_months between 1 and 60),
  constraint recruitment_policy_workflow_ck check (opening_workflow_code in ('recruitment.manager_then_hr', 'recruitment.hr_only'))
);

alter table public.recruitment_policy enable row level security;
alter table public.recruitment_policy force row level security;
create policy recruitment_policy_tenant_isolation on public.recruitment_policy
  using (company_id = current_setting('app.company_id', true)::uuid);

-- ---------------------------------------------------------------------------------------------------------
-- The counter of opening references: the row is locked when a reference is taken (insert … on conflict do update).
create table public.recruitment_opening_sequence (
  company_id uuid not null references public.company (id),
  year integer not null,
  last_value integer not null,
  constraint recruitment_opening_sequence_pk primary key (company_id, year),
  constraint recruitment_opening_sequence_year_ck check (year between 2000 and 2999),
  constraint recruitment_opening_sequence_value_ck check (last_value >= 1)
);

alter table public.recruitment_opening_sequence enable row level security;
alter table public.recruitment_opening_sequence force row level security;
create policy recruitment_opening_sequence_tenant_isolation on public.recruitment_opening_sequence
  using (company_id = current_setting('app.company_id', true)::uuid);

-- ---------------------------------------------------------------------------------------------------------
create table public.recruitment_opening (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  -- REC-{YYYY}-{SEQ:4}: the year of the request in Africa/Algiers
  reference text not null,
  -- the job title
  title text not null,
  org_unit_id uuid not null,
  -- null = the unit's effective site
  site_id uuid,
  contract_type text not null,
  posts integer not null,
  hired_count integer not null default 0,
  justification text not null,
  target_date date not null,
  anem_reference text,
  status text not null default 'pending',
  requested_by uuid not null,
  requested_at timestamptz not null default now(),
  workflow_instance_id uuid,
  opened_at timestamptz,
  closed_at timestamptz,
  closed_by uuid,
  close_reason text,
  constraint recruitment_opening_company_id_id_uk unique (company_id, id),
  constraint recruitment_opening_company_reference_uk unique (company_id, reference),
  constraint recruitment_opening_unit_fk foreign key (company_id, org_unit_id) references public.org_unit (company_id, id),
  constraint recruitment_opening_site_fk foreign key (company_id, site_id) references public.site (company_id, id),
  constraint recruitment_opening_instance_fk foreign key (company_id, workflow_instance_id) references public.workflow_instance (company_id, id),
  constraint recruitment_opening_reference_ck check (reference ~ '^REC-[0-9]{4}-[0-9]{4,}$'),
  constraint recruitment_opening_title_ck check (title = btrim(title) and char_length(title) between 1 and 120),
  constraint recruitment_opening_contract_ck check (contract_type in ('cdi', 'cdd', 'pre_emploi', 'apprentissage', 'stage')),
  constraint recruitment_opening_posts_ck check (posts between 1 and 99),
  constraint recruitment_opening_hired_ck check (hired_count between 0 and posts),
  constraint recruitment_opening_justification_ck check (justification = btrim(justification) and char_length(justification) between 3 and 2000),
  constraint recruitment_opening_anem_ck check (anem_reference is null or (anem_reference = btrim(anem_reference) and char_length(anem_reference) between 1 and 40)),
  constraint recruitment_opening_status_ck check (status in ('pending', 'open', 'filled', 'closed', 'rejected', 'cancelled')),
  constraint recruitment_opening_filled_ck check (status <> 'filled' or hired_count = posts),
  constraint recruitment_opening_opened_ck check ((status in ('pending', 'rejected', 'cancelled')) = (opened_at is null)),
  -- closed: who, when and why; filled: when only; anything else: none of the three
  constraint recruitment_opening_closed_ck check (
    (status = 'closed' and closed_at is not null and closed_by is not null and close_reason is not null)
    or (status = 'filled' and closed_at is not null and closed_by is null and close_reason is null)
    or (status not in ('closed', 'filled') and closed_at is null and closed_by is null and close_reason is null)
  ),
  constraint recruitment_opening_close_reason_ck check (close_reason is null or (close_reason = btrim(close_reason) and char_length(close_reason) between 3 and 500))
);

create index recruitment_opening_company_status_idx on public.recruitment_opening (company_id, status, requested_at desc);
create index recruitment_opening_company_unit_idx on public.recruitment_opening (company_id, org_unit_id);
create index recruitment_opening_company_requester_idx on public.recruitment_opening (company_id, requested_by);

alter table public.recruitment_opening enable row level security;
alter table public.recruitment_opening force row level security;
create policy recruitment_opening_tenant_isolation on public.recruitment_opening
  using (company_id = current_setting('app.company_id', true)::uuid);

-- What was asked is immutable (more posts = a new request, so the approval is never bypassed: the application also
-- refuses raising `posts`); the workflow instance is linked once; the status only follows the contract's transitions.
create function public.recruitment_opening_guard() returns trigger
  language plpgsql
as $$
begin
  if new.id is distinct from old.id or new.company_id is distinct from old.company_id or new.reference is distinct from old.reference
     or new.title is distinct from old.title or new.org_unit_id is distinct from old.org_unit_id
     or new.contract_type is distinct from old.contract_type or new.justification is distinct from old.justification
     or new.requested_by is distinct from old.requested_by or new.requested_at is distinct from old.requested_at
     or (old.workflow_instance_id is not null and new.workflow_instance_id is distinct from old.workflow_instance_id) then
    raise exception 'recruitment_opening %: reference, title, unit, contract type, justification and requester are immutable', old.id
      using errcode = 'check_violation', constraint = 'recruitment_opening_immutable';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'pending' and new.status in ('open', 'rejected', 'cancelled'))
       or (old.status = 'open' and new.status in ('filled', 'closed'))
       or (old.status in ('filled', 'closed') and new.status = 'open')
     ) then
    raise exception 'recruitment_opening %: status cannot go from % to %', old.id, old.status, new.status
      using errcode = 'check_violation', constraint = 'recruitment_opening_transition';
  end if;
  return new;
end
$$;

create trigger recruitment_opening_guard_tg
  before update on public.recruitment_opening
  for each row execute function public.recruitment_opening_guard();

-- ---------------------------------------------------------------------------------------------------------
create table public.recruitment_rejection_reason (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company (id),
  code text not null,
  name_fr text not null,
  name_ar text not null,
  name_en text not null,
  active boolean not null default true,
  sort_order integer not null default 0,
  is_system boolean not null default false,
  -- set by the system only (an opening filled or closed): never chosen by a user, never deactivated
  auto_only boolean not null default false,
  created_at timestamptz not null default now(),
  constraint recruitment_rejection_reason_company_id_id_uk unique (company_id, id),
  constraint recruitment_rejection_reason_company_code_uk unique (company_id, code),
  constraint recruitment_rejection_reason_code_ck check (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  constraint recruitment_rejection_reason_names_ck check (
    name_fr = btrim(name_fr) and char_length(name_fr) between 1 and 120
    and name_ar = btrim(name_ar) and char_length(name_ar) between 1 and 120
    and name_en = btrim(name_en) and char_length(name_en) between 1 and 120
  ),
  constraint recruitment_rejection_reason_auto_ck check (not auto_only or (is_system and active))
);

alter table public.recruitment_rejection_reason enable row level security;
alter table public.recruitment_rejection_reason force row level security;
create policy recruitment_rejection_reason_tenant_isolation on public.recruitment_rejection_reason
  using (company_id = current_setting('app.company_id', true)::uuid);

create function public.recruitment_rejection_reason_guard() returns trigger
  language plpgsql
as $$
begin
  if new.id is distinct from old.id or new.company_id is distinct from old.company_id or new.code is distinct from old.code
     or new.is_system is distinct from old.is_system or new.auto_only is distinct from old.auto_only
     or new.created_at is distinct from old.created_at then
    raise exception 'recruitment_rejection_reason %: code and system flags are immutable', old.id
      using errcode = 'check_violation', constraint = 'recruitment_rejection_reason_immutable';
  end if;
  return new;
end
$$;

create trigger recruitment_rejection_reason_guard_tg
  before update on public.recruitment_rejection_reason
  for each row execute function public.recruitment_rejection_reason_guard();

-- ---------------------------------------------------------------------------------------------------------
-- A candidate: the identity columns are exactly `person`'s (the hire copies them 1:1). NO unique index on nin: the
-- duplicate check is limited to what the caller can see (two regions may each hold a record of the same person).
create table public.recruitment_candidate (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company (id),
  last_name text not null,
  first_name text not null,
  last_name_ar text,
  first_name_ar text,
  birth_date date,
  birth_place text,
  sex text,
  nationality text not null default 'DZ',
  nin text,
  -- stored lower-case
  email text,
  phone text,
  -- the digits of `phone` without a leading 00213, 213 or 0 (set by the application): the duplicate key
  phone_key text,
  -- a former employee, confirmed by HR: the hire is then a rehire
  person_id uuid,
  -- the day the information notice (Law 18-07) was handed over
  informed_on date,
  -- null: reserved for a future public application page
  created_by uuid,
  created_at timestamptz not null default now(),
  search_text text generated always as (public.search_normalize(
    last_name || ' ' || first_name || ' ' || last_name || ' '
    || coalesce(last_name_ar || ' ', '') || coalesce(first_name_ar || ' ', '') || coalesce(last_name_ar || ' ', '')
    || coalesce(nin, ''))) stored,
  sort_name text generated always as (public.search_normalize(last_name || ' ' || first_name)) stored,
  constraint recruitment_candidate_company_id_id_uk unique (company_id, id),
  constraint recruitment_candidate_person_fk foreign key (company_id, person_id) references public.person (company_id, id),
  constraint recruitment_candidate_last_name_ck check (last_name = btrim(last_name) and char_length(last_name) between 1 and 80),
  constraint recruitment_candidate_first_name_ck check (first_name = btrim(first_name) and char_length(first_name) between 1 and 80),
  constraint recruitment_candidate_last_name_ar_ck check (last_name_ar is null or (last_name_ar = btrim(last_name_ar) and char_length(last_name_ar) between 1 and 80)),
  constraint recruitment_candidate_first_name_ar_ck check (first_name_ar is null or (first_name_ar = btrim(first_name_ar) and char_length(first_name_ar) between 1 and 80)),
  constraint recruitment_candidate_birth_place_ck check (birth_place is null or (birth_place = btrim(birth_place) and char_length(birth_place) between 1 and 120)),
  constraint recruitment_candidate_sex_ck check (sex is null or sex in ('M', 'F')),
  constraint recruitment_candidate_nationality_ck check (nationality ~ '^[A-Z]{2}$'),
  constraint recruitment_candidate_nin_ck check (nin is null or nin ~ '^[0-9]{18}$'),
  constraint recruitment_candidate_email_ck check (email is null or (email = lower(btrim(email)) and char_length(email) between 3 and 254 and email ~ '^[^@[:space:]]+@[^@[:space:]]+$')),
  constraint recruitment_candidate_phone_ck check (phone is null or (phone = btrim(phone) and char_length(phone) between 1 and 30)),
  constraint recruitment_candidate_phone_key_ck check (phone_key is null or (phone is not null and phone_key ~ '^[0-9]{1,30}$'))
);

create index recruitment_candidate_company_nin_idx on public.recruitment_candidate (company_id, nin);
create index recruitment_candidate_company_email_idx on public.recruitment_candidate (company_id, email);
create index recruitment_candidate_company_phone_idx on public.recruitment_candidate (company_id, phone_key);
create index recruitment_candidate_company_sort_idx on public.recruitment_candidate (company_id, sort_name);
create index recruitment_candidate_search_trgm_idx on public.recruitment_candidate using gin (search_text gin_trgm_ops);
create index recruitment_candidate_company_person_idx on public.recruitment_candidate (company_id, person_id) where person_id is not null;

alter table public.recruitment_candidate enable row level security;
alter table public.recruitment_candidate force row level security;
create policy recruitment_candidate_tenant_isolation on public.recruitment_candidate
  using (company_id = current_setting('app.company_id', true)::uuid);

create function public.recruitment_candidate_guard() returns trigger
  language plpgsql
as $$
begin
  if new.id is distinct from old.id or new.company_id is distinct from old.company_id
     or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
    raise exception 'recruitment_candidate %: id, company and creation columns are immutable', old.id
      using errcode = 'check_violation', constraint = 'recruitment_candidate_immutable';
  end if;
  return new;
end
$$;

create trigger recruitment_candidate_guard_tg
  before update on public.recruitment_candidate
  for each row execute function public.recruitment_candidate_guard();

-- ---------------------------------------------------------------------------------------------------------
-- One candidate on one opening. NEVER DELETED: once purged (candidate_id null, purged_at set) the row is the
-- anonymous count — opening, source, final stage, dates, employment (hired).
create table public.recruitment_application (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  opening_id uuid not null,
  candidate_id uuid,
  source text not null,
  stage text not null default 'received',
  stage_since timestamptz not null default now(),
  -- when the application reached a final stage: the start of the retention period
  decided_at timestamptz,
  -- the employment the hire created (Phase B)
  employment_id uuid,
  -- null: reserved for a future public application page
  created_by uuid,
  created_at timestamptz not null default now(),
  purged_at timestamptz,
  constraint recruitment_application_company_id_id_uk unique (company_id, id),
  constraint recruitment_application_opening_fk foreign key (company_id, opening_id) references public.recruitment_opening (company_id, id),
  -- restrict: a candidate is deleted only when no application references it
  constraint recruitment_application_candidate_fk foreign key (company_id, candidate_id) references public.recruitment_candidate (company_id, id),
  constraint recruitment_application_employment_fk foreign key (company_id, employment_id) references public.employment (company_id, id),
  constraint recruitment_application_source_ck check (source in ('anem', 'spontaneous', 'referral', 'job_board', 'social', 'internal', 'other')),
  constraint recruitment_application_stage_ck check (stage in ('received', 'shortlisted', 'interview', 'offer', 'hired', 'rejected', 'withdrawn')),
  constraint recruitment_application_purged_ck check ((candidate_id is null) = (purged_at is not null)),
  constraint recruitment_application_decided_ck check ((decided_at is not null) = (stage in ('hired', 'rejected', 'withdrawn'))),
  constraint recruitment_application_employment_ck check (employment_id is null or stage = 'hired')
);

-- a candidate applies once per opening (409 recruitment-already-applied)
create unique index recruitment_application_once_uk on public.recruitment_application (company_id, opening_id, candidate_id) where candidate_id is not null;
create index recruitment_application_opening_stage_idx on public.recruitment_application (company_id, opening_id, stage);
create index recruitment_application_candidate_idx on public.recruitment_application (company_id, candidate_id) where candidate_id is not null;
-- the retention job's scan
create index recruitment_application_decided_idx on public.recruitment_application (company_id, decided_at) where purged_at is null and decided_at is not null;

alter table public.recruitment_application enable row level security;
alter table public.recruitment_application force row level security;
create policy recruitment_application_tenant_isolation on public.recruitment_application
  using (company_id = current_setting('app.company_id', true)::uuid);

-- A purged application never changes again; the candidate only leaves it by the purge (candidate_id → null together
-- with purged_at, on a decided application); the opening and the creation columns are immutable.
create function public.recruitment_application_guard() returns trigger
  language plpgsql
as $$
begin
  if old.purged_at is not null then
    raise exception 'recruitment_application %: a purged application never changes', old.id
      using errcode = 'check_violation', constraint = 'recruitment_application_purged';
  end if;
  if new.id is distinct from old.id or new.company_id is distinct from old.company_id or new.opening_id is distinct from old.opening_id
     or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
    raise exception 'recruitment_application %: id, company, opening and creation columns are immutable', old.id
      using errcode = 'check_violation', constraint = 'recruitment_application_immutable';
  end if;
  if new.candidate_id is distinct from old.candidate_id and (new.candidate_id is not null or new.purged_at is null) then
    raise exception 'recruitment_application %: the candidate only leaves an application by its purge', old.id
      using errcode = 'check_violation', constraint = 'recruitment_application_candidate';
  end if;
  if new.purged_at is not null and (new.decided_at is null or new.stage is distinct from old.stage) then
    raise exception 'recruitment_application %: only a decided application is purged, and the purge keeps its stage', old.id
      using errcode = 'check_violation', constraint = 'recruitment_application_purge_decided';
  end if;
  return new;
end
$$;

create trigger recruitment_application_guard_tg
  before update on public.recruitment_application
  for each row execute function public.recruitment_application_guard();

-- ---------------------------------------------------------------------------------------------------------
-- The stage history: one row per move (from_stage null = creation). `seq` orders the rows of one application (two
-- moves of one transaction share moved_at).
create table public.recruitment_application_stage (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  company_id uuid not null,
  application_id uuid not null,
  from_stage text,
  to_stage text not null,
  rejection_reason_id uuid,
  comment text,
  -- an automatic move and its cause; Phase B adds `interview_scheduled`
  auto_cause text,
  moved_by uuid,
  moved_at timestamptz not null default now(),
  constraint recruitment_application_stage_company_id_id_uk unique (company_id, id),
  constraint recruitment_application_stage_application_fk foreign key (company_id, application_id) references public.recruitment_application (company_id, id),
  constraint recruitment_application_stage_reason_fk foreign key (company_id, rejection_reason_id) references public.recruitment_rejection_reason (company_id, id),
  constraint recruitment_application_stage_from_ck check (from_stage is null or from_stage in ('received', 'shortlisted', 'interview', 'offer', 'hired', 'rejected', 'withdrawn')),
  constraint recruitment_application_stage_to_ck check (to_stage in ('received', 'shortlisted', 'interview', 'offer', 'hired', 'rejected', 'withdrawn')),
  constraint recruitment_application_stage_move_ck check (from_stage is distinct from to_stage),
  constraint recruitment_application_stage_reason_ck check ((rejection_reason_id is not null) = (to_stage = 'rejected')),
  constraint recruitment_application_stage_comment_ck check (comment is null or (comment = btrim(comment) and char_length(comment) between 1 and 1000)),
  constraint recruitment_application_stage_cause_ck check (auto_cause is null or auto_cause in ('opening_filled', 'opening_closed', 'hire_undone', 'opening_reopened'))
);

create index recruitment_application_stage_application_idx on public.recruitment_application_stage (company_id, application_id, seq);

alter table public.recruitment_application_stage enable row level security;
alter table public.recruitment_application_stage force row level security;
create policy recruitment_application_stage_tenant_isolation on public.recruitment_application_stage
  using (company_id = current_setting('app.company_id', true)::uuid);

-- The history is never edited: the only update is the purge blanking a comment.
create function public.recruitment_application_stage_guard() returns trigger
  language plpgsql
as $$
begin
  if new.id is distinct from old.id or new.seq is distinct from old.seq or new.company_id is distinct from old.company_id
     or new.application_id is distinct from old.application_id or new.from_stage is distinct from old.from_stage
     or new.to_stage is distinct from old.to_stage or new.rejection_reason_id is distinct from old.rejection_reason_id
     or new.auto_cause is distinct from old.auto_cause or new.moved_by is distinct from old.moved_by
     or new.moved_at is distinct from old.moved_at or new.comment is not null then
    raise exception 'recruitment_application_stage %: the history is immutable (a purge may only blank the comment)', old.id
      using errcode = 'check_violation', constraint = 'recruitment_application_stage_immutable';
  end if;
  return new;
end
$$;

create trigger recruitment_application_stage_guard_tg
  before update on public.recruitment_application_stage
  for each row execute function public.recruitment_application_stage_guard();

-- ---------------------------------------------------------------------------------------------------------
-- A separate table so the field permission is a join (as person_sensitive).
create table public.recruitment_application_salary (
  application_id uuid primary key,
  company_id uuid not null,
  expected_salary numeric(12, 2),
  -- Phase B (the offer)
  proposed_salary numeric(12, 2),
  constraint recruitment_application_salary_application_fk foreign key (company_id, application_id) references public.recruitment_application (company_id, id),
  constraint recruitment_application_salary_expected_ck check (expected_salary is null or expected_salary > 0),
  constraint recruitment_application_salary_proposed_ck check (proposed_salary is null or proposed_salary > 0)
);

create index recruitment_application_salary_company_idx on public.recruitment_application_salary (company_id);

alter table public.recruitment_application_salary enable row level security;
alter table public.recruitment_application_salary force row level security;
create policy recruitment_application_salary_tenant_isolation on public.recruitment_application_salary
  using (company_id = current_setting('app.company_id', true)::uuid);

-- ---------------------------------------------------------------------------------------------------------
create table public.recruitment_note (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  application_id uuid not null,
  body text not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  constraint recruitment_note_company_id_id_uk unique (company_id, id),
  constraint recruitment_note_application_fk foreign key (company_id, application_id) references public.recruitment_application (company_id, id),
  constraint recruitment_note_body_ck check (body = btrim(body) and char_length(body) between 1 and 4000)
);

create index recruitment_note_application_idx on public.recruitment_note (company_id, application_id, created_at desc);

alter table public.recruitment_note enable row level security;
alter table public.recruitment_note force row level security;
create policy recruitment_note_tenant_isolation on public.recruitment_note
  using (company_id = current_setting('app.company_id', true)::uuid);

-- ---------------------------------------------------------------------------------------------------------
-- Candidate files: a parallel table, not employee_file (no employment, no tombstone, erased on another clock).
create table public.recruitment_candidate_file (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  candidate_id uuid not null,
  kind text not null,
  title text not null,
  -- as sent by the browser, without path parts, control and bidi-override characters (display only)
  original_filename text not null,
  -- sniffed from the bytes (the declared type and the extension are ignored)
  mime text not null,
  size_bytes integer not null,
  sha256 bytea not null,
  -- null: created by a seed
  uploaded_by uuid,
  uploaded_at timestamptz not null default now(),
  constraint recruitment_candidate_file_company_id_id_uk unique (company_id, id),
  constraint recruitment_candidate_file_candidate_fk foreign key (company_id, candidate_id) references public.recruitment_candidate (company_id, id),
  -- the same bytes once per candidate (409 recruitment-file-duplicate)
  constraint recruitment_candidate_file_sha_uk unique (company_id, candidate_id, sha256),
  constraint recruitment_candidate_file_kind_ck check (kind in ('cv', 'cover_letter', 'diploma', 'id_document', 'other')),
  constraint recruitment_candidate_file_title_ck check (title = btrim(title) and char_length(title) between 1 and 120),
  constraint recruitment_candidate_file_filename_ck check (char_length(original_filename) between 1 and 200 and original_filename !~ '[\x01-\x1f\x7f/\\]'),
  constraint recruitment_candidate_file_mime_ck check (mime in ('application/pdf', 'image/jpeg', 'image/png')),
  constraint recruitment_candidate_file_size_ck check (size_bytes between 1 and 20971520),
  constraint recruitment_candidate_file_sha_ck check (octet_length(sha256) = 32)
);

create index recruitment_candidate_file_candidate_idx on public.recruitment_candidate_file (company_id, candidate_id, uploaded_at desc);

alter table public.recruitment_candidate_file enable row level security;
alter table public.recruitment_candidate_file force row level security;
create policy recruitment_candidate_file_tenant_isolation on public.recruitment_candidate_file
  using (company_id = current_setting('app.company_id', true)::uuid);

create table public.recruitment_candidate_file_content (
  file_id uuid primary key,
  company_id uuid not null,
  content bytea not null,
  constraint recruitment_candidate_file_content_file_fk foreign key (company_id, file_id)
    references public.recruitment_candidate_file (company_id, id) on delete cascade,
  constraint recruitment_candidate_file_content_size_ck check (octet_length(content) between 1 and 20971520)
);

-- PDF, JPEG and PNG are already compressed: store out of line without trying to compress again.
alter table public.recruitment_candidate_file_content alter column content set storage external;

alter table public.recruitment_candidate_file_content enable row level security;
alter table public.recruitment_candidate_file_content force row level security;
create policy recruitment_candidate_file_content_tenant_isolation on public.recruitment_candidate_file_content
  using (company_id = current_setting('app.company_id', true)::uuid);

-- ---------------------------------------------------------------------------------------------------------
-- The candidate-data audit: events without personal payload (header of this file). SECURITY DEFINER like
-- audit.capture(); the company comes from the row, the actor and request id from the transaction's settings.
create function audit.capture_recruitment_event() returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, audit
as $$
declare
  v_company uuid;
  v_subject_type text;
  v_subject uuid;
  v_type text;
  v_data jsonb := '{}'::jsonb;
  v_old jsonb;
  v_new jsonb;
  v_fields text[];
begin
  -- the worker only writes these tables to purge them: one recruitment.purged event per run instead
  if session_user = 'hrforce_worker' then
    return null;
  end if;
  if tg_op in ('UPDATE', 'DELETE') then v_old := to_jsonb(old); end if;
  if tg_op in ('UPDATE', 'INSERT') then v_new := to_jsonb(new); end if;
  if tg_op = 'UPDATE' then
    select coalesce(array_agg(k order by k), '{}') into v_fields
      from jsonb_object_keys(v_new) as k
     where (v_new -> k) is distinct from (v_old -> k) and k not in ('search_text', 'sort_name');
  end if;

  if tg_table_name = 'recruitment_candidate' then
    v_subject_type := 'recruitment_candidate';
    if tg_op = 'INSERT' then
      v_company := new.company_id; v_subject := new.id; v_type := 'recruitment.candidate_created';
    elsif tg_op = 'UPDATE' then
      if cardinality(v_fields) = 0 then return null; end if;
      v_company := new.company_id; v_subject := new.id; v_type := 'recruitment.candidate_updated';
      v_data := jsonb_build_object('fields', to_jsonb(v_fields));
    else
      v_company := old.company_id; v_subject := old.id; v_type := 'recruitment.candidate_deleted';
    end if;
  elsif tg_table_name = 'recruitment_application' then
    v_subject_type := 'recruitment_application';
    if tg_op = 'INSERT' then
      v_company := new.company_id; v_subject := new.id; v_type := 'recruitment.application_created';
      v_data := jsonb_build_object('openingId', new.opening_id, 'source', new.source);
    elsif tg_op = 'UPDATE' then
      -- a stage change is recorded by its stage row
      select coalesce(array_agg(f order by f), '{}') into v_fields
        from unnest(v_fields) as f where f not in ('stage', 'stage_since', 'decided_at');
      if cardinality(v_fields) = 0 then return null; end if;
      v_company := new.company_id; v_subject := new.id; v_type := 'recruitment.application_updated';
      v_data := jsonb_build_object('fields', to_jsonb(v_fields));
    else
      v_company := old.company_id; v_subject := old.id; v_type := 'recruitment.application_deleted';
    end if;
  elsif tg_table_name = 'recruitment_application_stage' then
    -- the only update is the purge blanking a comment; rows are never deleted by the application
    if tg_op <> 'INSERT' then return null; end if;
    v_subject_type := 'recruitment_application';
    v_company := new.company_id; v_subject := new.application_id; v_type := 'recruitment.stage_changed';
    v_data := jsonb_build_object(
      'from', new.from_stage, 'to', new.to_stage,
      'reasonCode', (select r.code from public.recruitment_rejection_reason r where r.company_id = new.company_id and r.id = new.rejection_reason_id),
      'autoCause', new.auto_cause);
  elsif tg_table_name = 'recruitment_application_salary' then
    v_subject_type := 'recruitment_application';
    v_type := 'recruitment.salary_changed';
    if tg_op = 'UPDATE' then
      if cardinality(v_fields) = 0 then return null; end if;
      v_company := new.company_id; v_subject := new.application_id;
    else
      select coalesce(array_agg(k order by k), '{}') into v_fields
        from jsonb_each(coalesce(v_new, v_old)) as j (k, v)
       where k in ('expected_salary', 'proposed_salary') and v <> 'null'::jsonb;
      v_company := (coalesce(v_new, v_old) ->> 'company_id')::uuid; v_subject := (coalesce(v_new, v_old) ->> 'application_id')::uuid;
    end if;
    v_data := jsonb_build_object('fields', to_jsonb(v_fields));
  elsif tg_table_name = 'recruitment_note' then
    v_subject_type := 'recruitment_application';
    if tg_op = 'INSERT' then
      v_company := new.company_id; v_subject := new.application_id; v_type := 'recruitment.note_added';
    elsif tg_op = 'DELETE' then
      v_company := old.company_id; v_subject := old.application_id; v_type := 'recruitment.note_deleted';
    else
      return null;
    end if;
  elsif tg_table_name = 'recruitment_candidate_file' then
    v_subject_type := 'recruitment_candidate';
    if tg_op = 'INSERT' then
      v_company := new.company_id; v_subject := new.candidate_id; v_type := 'recruitment.file_added';
      v_data := jsonb_build_object('kind', new.kind);
    elsif tg_op = 'DELETE' then
      v_company := old.company_id; v_subject := old.candidate_id; v_type := 'recruitment.file_deleted';
      v_data := jsonb_build_object('kind', old.kind);
    else
      return null;
    end if;
  else
    return null;
  end if;

  insert into audit.event (company_id, actor_user_id, request_id, type, subject_type, subject_id, data)
  values (v_company, audit.setting_uuid('app.user_id'), nullif(current_setting('app.request_id', true), ''), v_type,
          v_subject_type, v_subject, v_data);
  return null;
end
$$;

revoke all on function audit.capture_recruitment_event() from public;

-- ---------------------------------------------------------------------------------------------------------
-- Audit (guard:db audit-per-write): row diffs for the settings and openings; events without payload for the six
-- personal tables; the bytes are exempt (audit-exempt.json).
create trigger audit_capture_tg after insert or update or delete on public.recruitment_policy
  for each row execute function audit.capture('company_id');
create trigger audit_capture_tg after insert or update or delete on public.recruitment_opening_sequence
  for each row execute function audit.capture('company_id');
create trigger audit_capture_tg after insert or update or delete on public.recruitment_opening
  for each row execute function audit.capture();
create trigger audit_capture_tg after insert or update or delete on public.recruitment_rejection_reason
  for each row execute function audit.capture();
create trigger audit_capture_tg after insert or update or delete on public.recruitment_candidate
  for each row execute function audit.capture_recruitment_event();
create trigger audit_capture_tg after insert or update or delete on public.recruitment_application
  for each row execute function audit.capture_recruitment_event();
create trigger audit_capture_tg after insert or update or delete on public.recruitment_application_stage
  for each row execute function audit.capture_recruitment_event();
create trigger audit_capture_tg after insert or update or delete on public.recruitment_application_salary
  for each row execute function audit.capture_recruitment_event();
create trigger audit_capture_tg after insert or update or delete on public.recruitment_note
  for each row execute function audit.capture_recruitment_event();
create trigger audit_capture_tg after insert or update or delete on public.recruitment_candidate_file
  for each row execute function audit.capture_recruitment_event();

-- ---------------------------------------------------------------------------------------------------------
-- Privileges.
-- hrforce_app: nothing of the settings, openings and applications is deleted; the history is insert-only except the
-- comment the erasure on request blanks (the guard only lets it go to null); notes, files and bytes are insert +
-- delete; the salary row is insert / update / delete; candidates are deleted when unreferenced (the erasure).
-- hrforce_worker (the retention purge): SELECT by 0012's default privileges, and exactly the purge's writes.
revoke delete on table public.recruitment_policy, public.recruitment_opening_sequence, public.recruitment_opening,
  public.recruitment_rejection_reason, public.recruitment_application, public.recruitment_application_stage from hrforce_app;
revoke update on table public.recruitment_application_stage, public.recruitment_note, public.recruitment_candidate_file,
  public.recruitment_candidate_file_content from hrforce_app;
grant update (comment) on table public.recruitment_application_stage to hrforce_app, hrforce_worker;
revoke all on function public.recruitment_opening_guard(), public.recruitment_rejection_reason_guard(), public.recruitment_candidate_guard(),
  public.recruitment_application_guard(), public.recruitment_application_stage_guard() from public;
grant delete on table public.recruitment_note, public.recruitment_application_salary, public.recruitment_candidate_file,
  public.recruitment_candidate_file_content, public.recruitment_candidate to hrforce_worker;
grant update (candidate_id, purged_at) on table public.recruitment_application to hrforce_worker;
grant execute on function audit.record_event(text, text, uuid, jsonb) to hrforce_worker;

-- ---------------------------------------------------------------------------------------------------------
-- Cross-module: the workflow engine gets its fourth subject type; notifications can be about an opening.
alter table public.workflow_instance drop constraint workflow_instance_subject_type_ck;
alter table public.workflow_instance
  add constraint workflow_instance_subject_type_ck check (subject_type in ('leave_request', 'document_request', 'attendance_correction', 'recruitment_opening'));

alter table public.notification drop constraint notification_subject_type_ck;
alter table public.notification
  add constraint notification_subject_type_ck check (subject_type in ('workflow_task', 'leave_request', 'document_request', 'issued_document', 'attendance_correction', 'recruitment_opening'));

-- ---------------------------------------------------------------------------------------------------------
-- Defaults of every existing company (new ones: seedRecruitmentDefaults / seedDocumentDefaults, called by bootstrap
-- and seed:dev).
-- The two approval chains: the head of the opening's unit (the head above when the requester is that head) then HR
-- holding recruitment.approve_opening over the unit; or the HR step alone.
insert into public.workflow_definition (company_id, code, name_fr, name_ar, name_en, steps, is_system)
select c.id, d.code, d.name_fr, d.name_ar, d.name_en, d.steps::jsonb, true
  from public.company c
  cross join (values
          ('recruitment.manager_then_hr', 'Responsable puis RH', 'المسؤول المباشر ثم الموارد البشرية', 'Manager then HR',
           '[{"key": "manager", "kind": "manager", "labels": {"fr": "Responsable", "ar": "المسؤول المباشر", "en": "Manager"}},
             {"key": "hr", "kind": "permission", "permission": "recruitment.approve_opening", "labels": {"fr": "RH", "ar": "الموارد البشرية", "en": "HR"}}]'),
          ('recruitment.hr_only', 'RH uniquement', 'الموارد البشرية فقط', 'HR only',
           '[{"key": "hr", "kind": "permission", "permission": "recruitment.approve_opening", "labels": {"fr": "RH", "ar": "الموارد البشرية", "en": "HR"}}]')
       ) as d (code, name_fr, name_ar, name_en, steps)
on conflict (company_id, code) do nothing;

insert into public.recruitment_policy (company_id) select c.id from public.company c on conflict do nothing;

insert into public.recruitment_rejection_reason (company_id, code, name_fr, name_ar, name_en, sort_order, is_system, auto_only)
select c.id, r.code, r.name_fr, r.name_ar, r.name_en, r.sort_order, true, r.auto_only
  from public.company c
  cross join (values
          ('profile_mismatch', 'Profil ne correspondant pas au poste', 'عدم توافق المؤهلات مع المنصب', 'Profile does not match the position', 10, false),
          ('experience', 'Expérience insuffisante', 'خبرة غير كافية', 'Insufficient experience', 20, false),
          ('qualification', 'Diplôme ou qualification requis non détenu', 'عدم حيازة الشهادة أو التأهيل المطلوب', 'Required degree or qualification not held', 30, false),
          ('salary', 'Prétentions salariales', 'المطالب المتعلقة بالأجر', 'Salary expectations', 40, false),
          ('other_selected', 'Autre candidature retenue', 'تم اختيار ترشح آخر', 'Another application selected', 50, false),
          ('no_show', 'Absence à l''entretien', 'الغياب عن المقابلة', 'Did not attend the interview', 60, false),
          ('incomplete', 'Dossier incomplet', 'ملف ناقص', 'Incomplete file', 70, false),
          ('other', 'Autre', 'سبب آخر', 'Other', 80, false),
          ('position_filled', 'Poste pourvu', 'تم شغل المنصب', 'Position filled', 900, true),
          ('opening_closed', 'Recrutement clôturé', 'تم إغلاق عملية التوظيف', 'Recruitment closed', 910, true)
       ) as r (code, name_fr, name_ar, name_en, sort_order, auto_only)
on conflict (company_id, code) do nothing;

-- The system employee-file category the hire copies candidate files into (Phase B).
insert into public.employee_file_category (company_id, code, name_fr, name_ar, name_en, access_class, sort_order, is_system)
select c.id, 'recruitment', 'Recrutement', 'التوظيف', 'Recruitment', 'standard', 60, true
  from public.company c
on conflict (company_id, code) do nothing;
