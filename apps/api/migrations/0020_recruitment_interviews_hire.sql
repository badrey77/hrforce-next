-- 0020: recruitment, Phase B (docs/contracts/recruitment.md › Phase B): evaluation criteria, interviews and the
-- interviewers' evaluations, offers — what the comparison view and the hire need.
--   recruitment_criterion            the company's evaluation criteria (deactivated instead of deleted; 5 seeded)
--   recruitment_opening_criterion    the criteria of one opening, in order (copied when it opens, adjustable until the
--                                    first evaluation)
--   recruitment_interview            an interview of an application: when, how, where; `cancelled` is final
--   recruitment_interviewer          a user who must evaluate it, with their recommendation and comment once submitted
--   recruitment_evaluation_score     their score (1–5) per criterion
--   recruitment_offer                an offer recorded for an application (the proposed salary lives in
--                                    recruitment_application_salary, behind recruitment.salary.*)
-- Also: the stage cause `interview_scheduled`; the notification subject type `recruitment_interview`, and the
-- interview notifications leave the once-per-subject rule (an interview may be rescheduled, an interviewer removed
-- and added again); the five criteria of every company and their copy to the openings that are not pending; the
-- worker's purge privileges on the four personal tables.
--
-- AUDIT. Criteria and opening criteria: the standard audit.capture() (settings and posts, no candidate data). The four
-- personal tables carry the standard trigger name `audit_capture_tg` executing audit.capture_recruitment_event() — the
-- Phase A pattern: no audit.change_log row, events without personal payload on `recruitment_application:<id>`:
--   interview insert / update / cancel / delete   recruitment.interview_scheduled / _updated {fields} / _cancelled / _deleted
--   interviewer insert / delete                   recruitment.interviewer_added / _removed {interviewId, userId}
--   interviewer update (a submission)             recruitment.evaluation_submitted {interviewId} (one per submission)
--   score insert / update / delete                none (the submission event covers them)
--   offer insert / update / status / delete       recruitment.offer_made / _updated {fields} / _declined / _cancelled /
--                                                 _accepted / _reopened (a hire undone) / _deleted
-- No name, time, place, score, recommendation, comment or amount ever reaches the audit log; `userId` is an HRForce
-- user (as `moved_by` of the stage history). Writes by hrforce_worker produce no per-row event (the purge).

-- ---------------------------------------------------------------------------------------------------------
create table public.recruitment_criterion (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company (id),
  code text not null,
  name_fr text not null,
  name_ar text not null,
  name_en text not null,
  active boolean not null default true,
  sort_order integer not null default 0,
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  constraint recruitment_criterion_company_id_id_uk unique (company_id, id),
  constraint recruitment_criterion_company_code_uk unique (company_id, code),
  constraint recruitment_criterion_code_ck check (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  constraint recruitment_criterion_names_ck check (
    name_fr = btrim(name_fr) and char_length(name_fr) between 1 and 120
    and name_ar = btrim(name_ar) and char_length(name_ar) between 1 and 120
    and name_en = btrim(name_en) and char_length(name_en) between 1 and 120
  )
);

alter table public.recruitment_criterion enable row level security;
alter table public.recruitment_criterion force row level security;
create policy recruitment_criterion_tenant_isolation on public.recruitment_criterion
  using (company_id = current_setting('app.company_id', true)::uuid);

create function public.recruitment_criterion_guard() returns trigger
  language plpgsql
as $$
begin
  if new.id is distinct from old.id or new.company_id is distinct from old.company_id or new.code is distinct from old.code
     or new.is_system is distinct from old.is_system or new.created_at is distinct from old.created_at then
    raise exception 'recruitment_criterion %: code and system flag are immutable', old.id
      using errcode = 'check_violation', constraint = 'recruitment_criterion_immutable';
  end if;
  return new;
end
$$;

create trigger recruitment_criterion_guard_tg
  before update on public.recruitment_criterion
  for each row execute function public.recruitment_criterion_guard();

-- ---------------------------------------------------------------------------------------------------------
-- The criteria of one opening (1–8, the application's rule), in order.
create table public.recruitment_opening_criterion (
  company_id uuid not null,
  opening_id uuid not null,
  criterion_id uuid not null,
  position integer not null,
  constraint recruitment_opening_criterion_pk primary key (opening_id, criterion_id),
  constraint recruitment_opening_criterion_opening_fk foreign key (company_id, opening_id) references public.recruitment_opening (company_id, id),
  constraint recruitment_opening_criterion_criterion_fk foreign key (company_id, criterion_id) references public.recruitment_criterion (company_id, id),
  constraint recruitment_opening_criterion_position_ck check (position between 1 and 8)
);

create index recruitment_opening_criterion_opening_idx on public.recruitment_opening_criterion (company_id, opening_id, position);

alter table public.recruitment_opening_criterion enable row level security;
alter table public.recruitment_opening_criterion force row level security;
create policy recruitment_opening_criterion_tenant_isolation on public.recruitment_opening_criterion
  using (company_id = current_setting('app.company_id', true)::uuid);

-- ---------------------------------------------------------------------------------------------------------
create table public.recruitment_interview (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  application_id uuid not null,
  -- e.g. « Entretien technique »
  label text,
  scheduled_at timestamptz not null,
  duration_minutes integer not null default 60,
  mode text not null,
  -- a room or a link
  location text,
  status text not null default 'scheduled',
  cancel_reason text,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  constraint recruitment_interview_company_id_id_uk unique (company_id, id),
  constraint recruitment_interview_application_fk foreign key (company_id, application_id) references public.recruitment_application (company_id, id),
  constraint recruitment_interview_label_ck check (label is null or (label = btrim(label) and char_length(label) between 1 and 120)),
  constraint recruitment_interview_duration_ck check (duration_minutes between 15 and 480),
  constraint recruitment_interview_mode_ck check (mode in ('on_site', 'video', 'phone')),
  constraint recruitment_interview_location_ck check (location is null or (location = btrim(location) and char_length(location) between 1 and 200)),
  constraint recruitment_interview_status_ck check (status in ('scheduled', 'cancelled')),
  -- a cancelled interview says why
  constraint recruitment_interview_cancel_ck check ((status = 'cancelled') = (cancel_reason is not null)),
  constraint recruitment_interview_cancel_reason_ck check (cancel_reason is null or (cancel_reason = btrim(cancel_reason) and char_length(cancel_reason) between 3 and 500))
);

create index recruitment_interview_application_idx on public.recruitment_interview (company_id, application_id, scheduled_at);
create index recruitment_interview_scheduled_idx on public.recruitment_interview (company_id, scheduled_at) where status = 'scheduled';

alter table public.recruitment_interview enable row level security;
alter table public.recruitment_interview force row level security;
create policy recruitment_interview_tenant_isolation on public.recruitment_interview
  using (company_id = current_setting('app.company_id', true)::uuid);

-- `cancelled` is final; the application and the creation columns are immutable.
create function public.recruitment_interview_guard() returns trigger
  language plpgsql
as $$
begin
  if old.status = 'cancelled' then
    raise exception 'recruitment_interview %: a cancelled interview never changes', old.id
      using errcode = 'check_violation', constraint = 'recruitment_interview_cancelled';
  end if;
  if new.id is distinct from old.id or new.company_id is distinct from old.company_id or new.application_id is distinct from old.application_id
     or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
    raise exception 'recruitment_interview %: id, company, application and creation columns are immutable', old.id
      using errcode = 'check_violation', constraint = 'recruitment_interview_immutable';
  end if;
  return new;
end
$$;

create trigger recruitment_interview_guard_tg
  before update on public.recruitment_interview
  for each row execute function public.recruitment_interview_guard();

-- ---------------------------------------------------------------------------------------------------------
-- An interviewer (1–5 per interview, the application's rule) and — once submitted — their evaluation.
create table public.recruitment_interviewer (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  interview_id uuid not null,
  user_id uuid not null,
  recommendation text,
  comment text,
  submitted_at timestamptz,
  constraint recruitment_interviewer_company_id_id_uk unique (company_id, id),
  constraint recruitment_interviewer_interview_fk foreign key (company_id, interview_id) references public.recruitment_interview (company_id, id),
  constraint recruitment_interviewer_once_uk unique (interview_id, user_id),
  constraint recruitment_interviewer_recommendation_ck check (recommendation is null or recommendation in ('strong_yes', 'yes', 'no', 'strong_no')),
  constraint recruitment_interviewer_submitted_ck check ((recommendation is not null) = (submitted_at is not null)),
  constraint recruitment_interviewer_comment_ck check (comment is null or (submitted_at is not null and comment = btrim(comment) and char_length(comment) between 1 and 4000))
);

create index recruitment_interviewer_user_idx on public.recruitment_interviewer (company_id, user_id);

alter table public.recruitment_interviewer enable row level security;
alter table public.recruitment_interviewer force row level security;
create policy recruitment_interviewer_tenant_isolation on public.recruitment_interviewer
  using (company_id = current_setting('app.company_id', true)::uuid);

create function public.recruitment_interviewer_guard() returns trigger
  language plpgsql
as $$
begin
  if new.id is distinct from old.id or new.company_id is distinct from old.company_id or new.interview_id is distinct from old.interview_id
     or new.user_id is distinct from old.user_id then
    raise exception 'recruitment_interviewer %: id, company, interview and user are immutable', old.id
      using errcode = 'check_violation', constraint = 'recruitment_interviewer_immutable';
  end if;
  return new;
end
$$;

create trigger recruitment_interviewer_guard_tg
  before update on public.recruitment_interviewer
  for each row execute function public.recruitment_interviewer_guard();

-- ---------------------------------------------------------------------------------------------------------
create table public.recruitment_evaluation_score (
  company_id uuid not null,
  interviewer_id uuid not null,
  criterion_id uuid not null,
  score smallint not null,
  constraint recruitment_evaluation_score_pk primary key (interviewer_id, criterion_id),
  constraint recruitment_evaluation_score_interviewer_fk foreign key (company_id, interviewer_id) references public.recruitment_interviewer (company_id, id),
  constraint recruitment_evaluation_score_criterion_fk foreign key (company_id, criterion_id) references public.recruitment_criterion (company_id, id),
  constraint recruitment_evaluation_score_score_ck check (score between 1 and 5)
);

create index recruitment_evaluation_score_company_idx on public.recruitment_evaluation_score (company_id, criterion_id);

alter table public.recruitment_evaluation_score enable row level security;
alter table public.recruitment_evaluation_score force row level security;
create policy recruitment_evaluation_score_tenant_isolation on public.recruitment_evaluation_score
  using (company_id = current_setting('app.company_id', true)::uuid);

-- ---------------------------------------------------------------------------------------------------------
-- An offer, recorded only (no letter is generated, nothing is sent). The hire accepts it.
create table public.recruitment_offer (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  application_id uuid not null,
  job_title text not null,
  org_unit_id uuid not null,
  site_id uuid,
  contract_type text not null,
  start_date date not null,
  note text,
  status text not null default 'proposed',
  decided_at timestamptz,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  constraint recruitment_offer_company_id_id_uk unique (company_id, id),
  constraint recruitment_offer_application_fk foreign key (company_id, application_id) references public.recruitment_application (company_id, id),
  constraint recruitment_offer_unit_fk foreign key (company_id, org_unit_id) references public.org_unit (company_id, id),
  constraint recruitment_offer_site_fk foreign key (company_id, site_id) references public.site (company_id, id),
  constraint recruitment_offer_job_title_ck check (job_title = btrim(job_title) and char_length(job_title) between 1 and 120),
  constraint recruitment_offer_contract_ck check (contract_type in ('cdi', 'cdd', 'pre_emploi', 'apprentissage', 'stage')),
  constraint recruitment_offer_note_ck check (note is null or (note = btrim(note) and char_length(note) between 1 and 1000)),
  constraint recruitment_offer_status_ck check (status in ('proposed', 'accepted', 'declined', 'cancelled')),
  constraint recruitment_offer_decided_ck check ((status = 'proposed') = (decided_at is null))
);

-- at most one offer in progress per application
create unique index recruitment_offer_proposed_uk on public.recruitment_offer (company_id, application_id) where status = 'proposed';
create index recruitment_offer_application_idx on public.recruitment_offer (company_id, application_id, created_at desc);

alter table public.recruitment_offer enable row level security;
alter table public.recruitment_offer force row level security;
create policy recruitment_offer_tenant_isolation on public.recruitment_offer
  using (company_id = current_setting('app.company_id', true)::uuid);

create function public.recruitment_offer_guard() returns trigger
  language plpgsql
as $$
begin
  if new.id is distinct from old.id or new.company_id is distinct from old.company_id or new.application_id is distinct from old.application_id
     or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
    raise exception 'recruitment_offer %: id, company, application and creation columns are immutable', old.id
      using errcode = 'check_violation', constraint = 'recruitment_offer_immutable';
  end if;
  return new;
end
$$;

create trigger recruitment_offer_guard_tg
  before update on public.recruitment_offer
  for each row execute function public.recruitment_offer_guard();

-- ---------------------------------------------------------------------------------------------------------
-- The candidate-data audit, extended to the four personal tables of Phase B (header of this file; the Phase A part is
-- unchanged from migration 0019).
create or replace function audit.capture_recruitment_event() returns trigger
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
  elsif tg_table_name = 'recruitment_interview' then
    v_subject_type := 'recruitment_application';
    if tg_op = 'INSERT' then
      v_company := new.company_id; v_subject := new.application_id; v_type := 'recruitment.interview_scheduled';
      v_data := jsonb_build_object('interviewId', new.id);
    elsif tg_op = 'UPDATE' then
      if cardinality(v_fields) = 0 then return null; end if;
      v_company := new.company_id; v_subject := new.application_id;
      if new.status = 'cancelled' and old.status <> 'cancelled' then
        v_type := 'recruitment.interview_cancelled';
        v_data := jsonb_build_object('interviewId', new.id);
      else
        v_type := 'recruitment.interview_updated';
        v_data := jsonb_build_object('interviewId', new.id, 'fields', to_jsonb(v_fields));
      end if;
    else
      v_company := old.company_id; v_subject := old.application_id; v_type := 'recruitment.interview_deleted';
      v_data := jsonb_build_object('interviewId', old.id);
    end if;
  elsif tg_table_name = 'recruitment_interviewer' then
    v_subject_type := 'recruitment_application';
    if tg_op = 'INSERT' then
      v_company := new.company_id; v_type := 'recruitment.interviewer_added';
      v_data := jsonb_build_object('interviewId', new.interview_id, 'userId', new.user_id);
      select i.application_id into v_subject from public.recruitment_interview i where i.company_id = new.company_id and i.id = new.interview_id;
    elsif tg_op = 'UPDATE' then
      -- one event per submission (the first one and every re-submission), never the recommendation or the comment
      if new.submitted_at is null or new.submitted_at is not distinct from old.submitted_at then return null; end if;
      v_company := new.company_id; v_type := 'recruitment.evaluation_submitted';
      v_data := jsonb_build_object('interviewId', new.interview_id);
      select i.application_id into v_subject from public.recruitment_interview i where i.company_id = new.company_id and i.id = new.interview_id;
    else
      v_company := old.company_id; v_type := 'recruitment.interviewer_removed';
      v_data := jsonb_build_object('interviewId', old.interview_id, 'userId', old.user_id);
      select i.application_id into v_subject from public.recruitment_interview i where i.company_id = old.company_id and i.id = old.interview_id;
    end if;
    if v_subject is null then return null; end if;
  elsif tg_table_name = 'recruitment_offer' then
    v_subject_type := 'recruitment_application';
    if tg_op = 'INSERT' then
      v_company := new.company_id; v_subject := new.application_id; v_type := 'recruitment.offer_made';
    elsif tg_op = 'UPDATE' then
      if cardinality(v_fields) = 0 then return null; end if;
      v_company := new.company_id; v_subject := new.application_id;
      if new.status is distinct from old.status then
        v_type := case new.status
          when 'accepted' then 'recruitment.offer_accepted'
          when 'declined' then 'recruitment.offer_declined'
          when 'cancelled' then 'recruitment.offer_cancelled'
          else 'recruitment.offer_reopened' end;
      else
        v_type := 'recruitment.offer_updated';
        v_data := jsonb_build_object('fields', to_jsonb(v_fields));
      end if;
    else
      v_company := old.company_id; v_subject := old.application_id; v_type := 'recruitment.offer_deleted';
    end if;
  else
    -- recruitment_evaluation_score: the submission event of its interviewer row covers it
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
-- Audit (guard:db audit-per-write).
create trigger audit_capture_tg after insert or update or delete on public.recruitment_criterion
  for each row execute function audit.capture();
create trigger audit_capture_tg after insert or update or delete on public.recruitment_opening_criterion
  for each row execute function audit.capture('opening_id');
create trigger audit_capture_tg after insert or update or delete on public.recruitment_interview
  for each row execute function audit.capture_recruitment_event();
create trigger audit_capture_tg after insert or update or delete on public.recruitment_interviewer
  for each row execute function audit.capture_recruitment_event();
create trigger audit_capture_tg after insert or update or delete on public.recruitment_evaluation_score
  for each row execute function audit.capture_recruitment_event();
create trigger audit_capture_tg after insert or update or delete on public.recruitment_offer
  for each row execute function audit.capture_recruitment_event();

-- ---------------------------------------------------------------------------------------------------------
-- Privileges. hrforce_app: a criterion is never deleted (deactivated); everything else is plain DML (the erasure on
-- request deletes the four personal tables' rows). hrforce_worker (the retention purge): SELECT by 0012's default
-- privileges, and DELETE on the four personal tables.
revoke delete on table public.recruitment_criterion from hrforce_app;
revoke all on function public.recruitment_criterion_guard(), public.recruitment_interview_guard(), public.recruitment_interviewer_guard(),
  public.recruitment_offer_guard() from public;
grant delete on table public.recruitment_evaluation_score, public.recruitment_interviewer, public.recruitment_interview,
  public.recruitment_offer to hrforce_worker;

-- ---------------------------------------------------------------------------------------------------------
-- Cross-module.
-- scheduling an interview moves a received / shortlisted application to `interview`
alter table public.recruitment_application_stage drop constraint recruitment_application_stage_cause_ck;
alter table public.recruitment_application_stage
  add constraint recruitment_application_stage_cause_ck check (auto_cause is null or auto_cause in ('opening_filled', 'opening_closed', 'hire_undone', 'opening_reopened', 'interview_scheduled'));

-- notifications can be about an interview …
alter table public.notification drop constraint notification_subject_type_ck;
alter table public.notification
  add constraint notification_subject_type_ck check (subject_type in ('workflow_task', 'leave_request', 'document_request', 'issued_document', 'attendance_correction', 'recruitment_opening', 'recruitment_interview'));

-- … and an interviewer may be told several times about one interview (assigned, then rescheduled; removed, added
-- again, cancelled): these two types leave the once-per-recipient-type-subject rule, which stays for every other type.
alter table public.notification drop constraint notification_once_uk;
create unique index notification_once_uk on public.notification (company_id, user_id, type, subject_type, subject_id)
  where type not in ('recruitment.interview_assigned', 'recruitment.interview_cancelled');

-- ---------------------------------------------------------------------------------------------------------
-- Defaults of every existing company (new ones: seedRecruitmentDefaults, called by bootstrap and seed:dev).
insert into public.recruitment_criterion (company_id, code, name_fr, name_ar, name_en, sort_order, is_system)
select c.id, k.code, k.name_fr, k.name_ar, k.name_en, k.sort_order, true
  from public.company c
  cross join (values
          ('skills', 'Compétences techniques', 'الكفاءات التقنية', 'Technical skills', 10),
          ('experience', 'Expérience', 'الخبرة المهنية', 'Experience', 20),
          ('communication', 'Communication', 'التواصل', 'Communication', 30),
          ('motivation', 'Motivation', 'الحافز', 'Motivation', 40),
          ('fit', 'Adéquation au poste', 'الملاءمة للمنصب', 'Fit for the position', 50)
       ) as k (code, name_fr, name_ar, name_en, sort_order)
on conflict (company_id, code) do nothing;

-- The openings that are not pending get the active criteria (a pending one gets them when it opens).
insert into public.recruitment_opening_criterion (company_id, opening_id, criterion_id, position)
select o.company_id, o.id, k.id, row_number() over (partition by o.id order by k.sort_order, k.code)
  from public.recruitment_opening o
  join public.recruitment_criterion k on k.company_id = o.company_id and k.active
 where o.status <> 'pending'
on conflict do nothing;
