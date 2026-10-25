-- 0025: Personal details and self-service profile changes (docs/contracts/profile-changes.md).
--   person_contact             a person's contact details (phones, personal e-mail, address); one row per person
--   person_emergency_contact   the person to warn (one); row absent = none, deleted when cleared
--   person_family              marital status (+ since when) and whether the spouse works; one row per person
--   person_child               dependent children (first name, birth date, sex, dependent flag); ≤ 15 per person;
--                              deletable (a child removed by HR or by an approved change)
--   profile_policy             per company: which sections apply at once and which need HR approval, the retention of
--                              the files of refused requests (a company without a row uses the column defaults)
--   profile_change_request     an employee's change of one section (or a note about an identity error); at most one
--                              pending per employment and section; never deleted
--   profile_change_file        the supporting files of a request (1–3); the bytes are nulled by the worker's purge
-- Also: four permissions and their system-role grants, the workflow subject type and notification subject type
-- `profile_change_request`, the workflow definitions `profile.hr` / `profile.bank` and the system employee-file
-- category `supporting_document` of every existing company (new ones: seedProfileDefaults / seedDocumentDefaults,
-- called by bootstrap and seed:dev), the masked audit columns and the worker's purge privileges.
--
-- Every new table: company_id + RLS/FORCE + the standard tenant policy, composite (company_id, …) foreign keys, the
-- audit trigger (no exemption). Users are referenced without FK (hrforce_app has no privilege on auth.*). Personal
-- values (phones, e-mail, address, names and birth dates, comments, request payloads, file names and bytes) are masked
-- in the audit log; enums, ids and the records' own dates are not.
-- Phones are stored normalised by the API: no spaces, a leading `00` written `+`, an Algerian national number
-- (0 + 9 digits) written `+213…`; anything else as typed digits (with its `+`).

-- ---------------------------------------------------------------------------------------------------------
-- Permissions (group employee, after employee.contract.manage) and their system-role grants. None is sensitive (the
-- two-step sign-in defaults are unchanged); admin_rh_central holds every non-medical code.
insert into public.permission (code, label_fr, label_ar, label_en, group_code, sensitive, sort_order) values
  ('employee.personal.read', 'Consulter les coordonnées et la situation familiale', 'الاطلاع على معلومات الاتصال والوضعية العائلية', 'View contact details and family situation', 'employee', false, 350),
  ('employee.personal.update', 'Modifier les coordonnées et la situation familiale', 'تعديل معلومات الاتصال والوضعية العائلية', 'Edit contact details and family situation', 'employee', false, 360),
  ('profile.request_self', 'Demander la modification de son profil', 'طلب تعديل الملف الشخصي', 'Request changes to one''s own profile', 'employee', false, 370),
  ('profile.configure', 'Paramétrer les demandes de modification', 'إعداد طلبات التعديل', 'Configure change requests', 'employee', false, 380);

insert into public.role_permission (company_id, role_id, permission_code)
select r.company_id, r.id, p.code
  from public.role r
  join (values
          ('admin_rh_central', 'employee.personal.read'), ('admin_rh_central', 'employee.personal.update'),
          ('admin_rh_central', 'profile.request_self'), ('admin_rh_central', 'profile.configure'),
          ('rh_regional', 'employee.personal.read'), ('rh_regional', 'employee.personal.update'),
          ('employe', 'profile.request_self')
       ) as p (role_code, code) on p.role_code = r.code
 where r.is_system
on conflict (role_id, permission_code) do nothing;

-- ---------------------------------------------------------------------------------------------------------
create table public.person_contact (
  person_id uuid primary key,
  company_id uuid not null,
  mobile_phone text,
  other_phone text,
  personal_email text,
  address_line text,
  commune text,
  wilaya_code text,
  postal_code text,
  updated_at timestamptz not null default now(),
  -- auth.user_account id, without FK; null = written by a script (seed)
  updated_by uuid,
  constraint person_contact_person_fk foreign key (company_id, person_id) references public.person (company_id, id),
  constraint person_contact_mobile_ck check (mobile_phone is null or mobile_phone ~ '^\+?[0-9]{8,20}$'),
  constraint person_contact_other_ck check (other_phone is null or other_phone ~ '^\+?[0-9]{8,20}$'),
  constraint person_contact_email_ck check (
    personal_email is null or (char_length(personal_email) <= 254 and personal_email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$')
  ),
  constraint person_contact_address_ck check (address_line is null or (address_line = btrim(address_line) and char_length(address_line) between 1 and 200)),
  constraint person_contact_commune_ck check (commune is null or (commune = btrim(commune) and char_length(commune) between 1 and 80)),
  constraint person_contact_wilaya_ck check (wilaya_code is null or wilaya_code ~ '^(0[1-9]|[1-4][0-9]|5[0-8])$'),
  constraint person_contact_postal_ck check (postal_code is null or postal_code ~ '^[0-9]{5}$')
);

create index person_contact_company_idx on public.person_contact (company_id);

alter table public.person_contact enable row level security;
alter table public.person_contact force row level security;
create policy person_contact_tenant_isolation on public.person_contact
  using (company_id = current_setting('app.company_id', true)::uuid);

-- ---------------------------------------------------------------------------------------------------------
create table public.person_emergency_contact (
  person_id uuid primary key,
  company_id uuid not null,
  full_name text not null,
  relationship text not null,
  phone text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint person_emergency_contact_person_fk foreign key (company_id, person_id) references public.person (company_id, id),
  constraint person_emergency_contact_name_ck check (full_name = btrim(full_name) and char_length(full_name) between 1 and 120),
  constraint person_emergency_contact_relationship_ck check (relationship in ('spouse', 'parent', 'child', 'sibling', 'other')),
  constraint person_emergency_contact_phone_ck check (phone ~ '^\+?[0-9]{8,20}$')
);

create index person_emergency_contact_company_idx on public.person_emergency_contact (company_id);

alter table public.person_emergency_contact enable row level security;
alter table public.person_emergency_contact force row level security;
create policy person_emergency_contact_tenant_isolation on public.person_emergency_contact
  using (company_id = current_setting('app.company_id', true)::uuid);

-- ---------------------------------------------------------------------------------------------------------
create table public.person_family (
  person_id uuid primary key,
  company_id uuid not null,
  marital_status text,
  marital_status_since date,
  spouse_employed text,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint person_family_person_fk foreign key (company_id, person_id) references public.person (company_id, id),
  constraint person_family_status_ck check (marital_status is null or marital_status in ('single', 'married', 'divorced', 'widowed')),
  -- "since" belongs to a status (the API also refuses a future date)
  constraint person_family_since_ck check (marital_status_since is null or (marital_status is not null and marital_status_since >= date '1900-01-01')),
  constraint person_family_spouse_ck check (spouse_employed is null or spouse_employed in ('yes', 'no', 'unknown'))
);

create index person_family_company_idx on public.person_family (company_id);

alter table public.person_family enable row level security;
alter table public.person_family force row level security;
create policy person_family_tenant_isolation on public.person_family
  using (company_id = current_setting('app.company_id', true)::uuid);

-- ---------------------------------------------------------------------------------------------------------
create table public.person_child (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  person_id uuid not null,
  first_name text not null,
  birth_date date not null,
  sex text,
  dependent boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint person_child_company_id_id_uk unique (company_id, id),
  constraint person_child_person_fk foreign key (company_id, person_id) references public.person (company_id, id),
  constraint person_child_first_name_ck check (first_name = btrim(first_name) and char_length(first_name) between 1 and 80),
  -- the API also refuses a future birth date
  constraint person_child_birth_ck check (birth_date >= date '1900-01-01'),
  constraint person_child_sex_ck check (sex is null or sex in ('M', 'F'))
);

create index person_child_person_idx on public.person_child (company_id, person_id);

alter table public.person_child enable row level security;
alter table public.person_child force row level security;
create policy person_child_tenant_isolation on public.person_child
  using (company_id = current_setting('app.company_id', true)::uuid);

-- At most 15 children per person (the API checks first and answers 422; this is the backstop). A child never moves to
-- another person.
create function public.person_child_guard() returns trigger
  language plpgsql
as $$
begin
  if tg_op = 'UPDATE' and (new.person_id is distinct from old.person_id or new.company_id is distinct from old.company_id
     or new.created_at is distinct from old.created_at) then
    raise exception 'person_child %: person and company are immutable', old.id
      using errcode = 'check_violation', constraint = 'person_child_immutable';
  end if;
  if tg_op = 'INSERT' and (select count(*) from public.person_child c
                            where c.company_id = new.company_id and c.person_id = new.person_id) >= 15 then
    raise exception 'person %: at most 15 children', new.person_id
      using errcode = 'check_violation', constraint = 'person_child_max_ck';
  end if;
  return new;
end
$$;

create trigger person_child_guard_tg
  before insert or update on public.person_child
  for each row execute function public.person_child_guard();

-- ---------------------------------------------------------------------------------------------------------
create table public.profile_policy (
  company_id uuid primary key references public.company (id),
  contact_mode text not null default 'immediate',
  emergency_mode text not null default 'immediate',
  family_mode text not null default 'approval',
  -- the bytes of a refused / cancelled request's files are erased this many days after the decision
  file_retention_days integer not null default 30,
  updated_at timestamptz not null default now(),
  constraint profile_policy_modes_ck check (
    contact_mode in ('immediate', 'approval') and emergency_mode in ('immediate', 'approval') and family_mode in ('immediate', 'approval')
  ),
  constraint profile_policy_retention_ck check (file_retention_days between 7 and 365)
);

alter table public.profile_policy enable row level security;
alter table public.profile_policy force row level security;
create policy profile_policy_tenant_isolation on public.profile_policy
  using (company_id = current_setting('app.company_id', true)::uuid);

-- ---------------------------------------------------------------------------------------------------------
create table public.profile_change_request (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company (id),
  employment_id uuid not null,
  person_id uuid not null,
  section text not null,
  -- pending → approved / rejected / cancelled; `applied` = an immediate change (recorded as applied at once)
  status text not null default 'pending',
  -- the section's new values (identity_note: {note})
  payload jsonb not null,
  -- the section's values when the request was made (null for identity_note)
  before jsonb,
  employee_comment text,
  workflow_instance_id uuid,
  -- auth.user_account id, without FK
  requested_by uuid not null,
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  files_purged_at timestamptz,
  constraint profile_change_request_company_id_id_uk unique (company_id, id),
  constraint profile_change_request_employment_fk foreign key (company_id, employment_id) references public.employment (company_id, id),
  constraint profile_change_request_person_fk foreign key (company_id, person_id) references public.person (company_id, id),
  constraint profile_change_request_workflow_fk foreign key (company_id, workflow_instance_id) references public.workflow_instance (company_id, id),
  constraint profile_change_request_section_ck check (section in ('contact', 'emergency', 'family', 'bank', 'identity_note')),
  constraint profile_change_request_status_ck check (status in ('pending', 'approved', 'rejected', 'cancelled', 'applied')),
  constraint profile_change_request_payload_ck check (jsonb_typeof(payload) = 'object'),
  constraint profile_change_request_decided_ck check ((status = 'pending') = (decided_at is null)),
  constraint profile_change_request_comment_ck check (
    employee_comment is null or (employee_comment = btrim(employee_comment) and char_length(employee_comment) between 1 and 500)
  )
);

-- at most one pending request per employment and section
create unique index profile_change_request_one_pending_uk on public.profile_change_request (company_id, employment_id, section)
  where status = 'pending';
create index profile_change_request_status_idx on public.profile_change_request (company_id, status, requested_at desc);
create index profile_change_request_employment_idx on public.profile_change_request (company_id, employment_id, requested_at desc);
create index profile_change_request_purge_idx on public.profile_change_request (company_id, decided_at)
  where files_purged_at is null and status in ('approved', 'rejected', 'cancelled');

alter table public.profile_change_request enable row level security;
alter table public.profile_change_request force row level security;
create policy profile_change_request_tenant_isolation on public.profile_change_request
  using (company_id = current_setting('app.company_id', true)::uuid);

-- A request is a record: what was asked never changes; the status leaves `pending` once; files_purged_at is set once.
create function public.profile_change_request_guard() returns trigger
  language plpgsql
as $$
begin
  if new.id is distinct from old.id or new.company_id is distinct from old.company_id
     or new.employment_id is distinct from old.employment_id or new.person_id is distinct from old.person_id
     or new.section is distinct from old.section or new.payload is distinct from old.payload
     or new.before is distinct from old.before or new.employee_comment is distinct from old.employee_comment
     or new.requested_by is distinct from old.requested_by or new.requested_at is distinct from old.requested_at
     or (old.workflow_instance_id is not null and new.workflow_instance_id is distinct from old.workflow_instance_id)
     or (old.status <> 'pending' and (new.status is distinct from old.status or new.decided_at is distinct from old.decided_at))
     or (old.files_purged_at is not null and new.files_purged_at is distinct from old.files_purged_at) then
    raise exception 'profile_change_request %: only the decision (once) and the purge mark (once) may change', old.id
      using errcode = 'check_violation', constraint = 'profile_change_request_immutable';
  end if;
  return new;
end
$$;

create trigger profile_change_request_guard_tg
  before update on public.profile_change_request
  for each row execute function public.profile_change_request_guard();

-- ---------------------------------------------------------------------------------------------------------
create table public.profile_change_file (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  request_id uuid not null,
  -- as sent by the browser, without path parts, control and bidi-override characters (display only)
  original_filename text not null,
  -- sniffed from the bytes
  mime text not null,
  size_bytes integer not null,
  sha256 bytea not null,
  -- null = purged (the metadata stays; the request's files_purged_at says when)
  content bytea,
  -- the employee-file copy made by the approval
  employee_file_id uuid,
  created_at timestamptz not null default now(),
  constraint profile_change_file_company_id_id_uk unique (company_id, id),
  constraint profile_change_file_request_fk foreign key (company_id, request_id) references public.profile_change_request (company_id, id),
  constraint profile_change_file_employee_file_fk foreign key (company_id, employee_file_id) references public.employee_file (company_id, id),
  constraint profile_change_file_filename_ck check (char_length(original_filename) between 1 and 200 and original_filename !~ '[\x01-\x1f\x7f/\\]'),
  constraint profile_change_file_mime_ck check (mime in ('application/pdf', 'image/jpeg', 'image/png')),
  -- EMPLOYEE_FILE_MAX_BYTES is at most 20 MB
  constraint profile_change_file_size_ck check (size_bytes between 1 and 20971520),
  constraint profile_change_file_sha_ck check (octet_length(sha256) = 32),
  constraint profile_change_file_content_ck check (content is null or octet_length(content) = size_bytes)
);

-- PDF, JPEG and PNG are already compressed
alter table public.profile_change_file alter column content set storage external;

create index profile_change_file_request_idx on public.profile_change_file (company_id, request_id);

alter table public.profile_change_file enable row level security;
alter table public.profile_change_file force row level security;
create policy profile_change_file_tenant_isolation on public.profile_change_file
  using (company_id = current_setting('app.company_id', true)::uuid);

-- At most 3 files per request; the metadata never changes; the bytes only go (to null, once); the employee-file copy
-- is recorded once.
create function public.profile_change_file_guard() returns trigger
  language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if (select count(*) from public.profile_change_file f
         where f.company_id = new.company_id and f.request_id = new.request_id) >= 3 then
      raise exception 'profile_change_request %: at most 3 files', new.request_id
        using errcode = 'check_violation', constraint = 'profile_change_file_max_ck';
    end if;
    return new;
  end if;
  if new.id is distinct from old.id or new.company_id is distinct from old.company_id
     or new.request_id is distinct from old.request_id or new.original_filename is distinct from old.original_filename
     or new.mime is distinct from old.mime or new.size_bytes is distinct from old.size_bytes
     or new.sha256 is distinct from old.sha256 or new.created_at is distinct from old.created_at
     or (new.content is not null and new.content is distinct from old.content)
     or (old.employee_file_id is not null and new.employee_file_id is distinct from old.employee_file_id) then
    raise exception 'profile_change_file %: only the purge (content to null) and the employee-file copy may change', old.id
      using errcode = 'check_violation', constraint = 'profile_change_file_immutable';
  end if;
  return new;
end
$$;

create trigger profile_change_file_guard_tg
  before insert or update on public.profile_change_file
  for each row execute function public.profile_change_file_guard();

-- ---------------------------------------------------------------------------------------------------------
-- Privileges. hrforce_app: DML by 0001's default privileges; contact and family rows are cleared, never deleted;
-- the emergency contact and children may be deleted; requests, their files and the policy are never deleted.
-- hrforce_worker (the daily purge; SELECT by 0012's default privileges, audit.record_event by 0015): nulls the bytes
-- and marks the request.
revoke delete on table public.person_contact, public.person_family, public.profile_policy,
  public.profile_change_request, public.profile_change_file from hrforce_app;
revoke all on function public.person_child_guard(), public.profile_change_request_guard(), public.profile_change_file_guard() from public;

-- the worker never reads the bytes (nor the file names): its SELECT is narrowed to what the purge filters on
revoke select on table public.profile_change_file from hrforce_worker;
grant select (id, company_id, request_id, employee_file_id) on table public.profile_change_file to hrforce_worker;
grant update (content) on table public.profile_change_file to hrforce_worker;
grant update (files_purged_at) on table public.profile_change_request to hrforce_worker;

-- ---------------------------------------------------------------------------------------------------------
-- Audit: row triggers on the seven tables (no exemption); the one-row-per-person tables are keyed on their person.
create trigger audit_capture_tg after insert or update or delete on public.person_contact
  for each row execute function audit.capture('person_id');
create trigger audit_capture_tg after insert or update or delete on public.person_emergency_contact
  for each row execute function audit.capture('person_id');
create trigger audit_capture_tg after insert or update or delete on public.person_family
  for each row execute function audit.capture('person_id');
create trigger audit_capture_tg after insert or update or delete on public.person_child
  for each row execute function audit.capture();
create trigger audit_capture_tg after insert or update or delete on public.profile_policy
  for each row execute function audit.capture('company_id');
create trigger audit_capture_tg after insert or update or delete on public.profile_change_request
  for each row execute function audit.capture();
create trigger audit_capture_tg after insert or update or delete on public.profile_change_file
  for each row execute function audit.capture();

insert into audit.masked_column (table_name, column_name) values
  ('person_contact', 'mobile_phone'),
  ('person_contact', 'other_phone'),
  ('person_contact', 'personal_email'),
  ('person_contact', 'address_line'),
  ('person_contact', 'commune'),
  ('person_contact', 'wilaya_code'),
  ('person_contact', 'postal_code'),
  ('person_emergency_contact', 'full_name'),
  ('person_emergency_contact', 'phone'),
  ('person_family', 'marital_status_since'),
  ('person_child', 'first_name'),
  ('person_child', 'birth_date'),
  ('profile_change_request', 'payload'),
  ('profile_change_request', 'before'),
  ('profile_change_request', 'employee_comment'),
  ('profile_change_file', 'original_filename'),
  ('profile_change_file', 'content');

-- ---------------------------------------------------------------------------------------------------------
-- Cross-module: the workflow engine's sixth subject type; notifications about a request.
alter table public.workflow_instance drop constraint workflow_instance_subject_type_ck;
alter table public.workflow_instance
  add constraint workflow_instance_subject_type_ck check (subject_type in ('leave_request', 'document_request', 'attendance_correction', 'recruitment_opening', 'contract_decision', 'profile_change_request'));

alter table public.notification drop constraint notification_subject_type_ck;
alter table public.notification
  add constraint notification_subject_type_ck check (subject_type in ('workflow_task', 'leave_request', 'document_request', 'issued_document', 'attendance_correction', 'recruitment_opening', 'recruitment_interview', 'contract_decision', 'deadline_digest', 'profile_change_request'));

-- The approval chains of every existing company (new ones: seedProfileDefaults, called by bootstrap and seed:dev).
insert into public.workflow_definition (company_id, code, name_fr, name_ar, name_en, steps, is_system)
select c.id, d.code, d.name_fr, d.name_ar, d.name_en, d.steps, true
  from public.company c
  cross join (values
          ('profile.hr', 'Modification du profil (RH)', 'تعديل الملف الشخصي (الموارد البشرية)', 'Profile change (HR)',
           '[{"key": "hr", "kind": "permission", "permission": "employee.personal.update", "labels": {"fr": "RH", "ar": "الموارد البشرية", "en": "HR"}}]'::jsonb),
          ('profile.bank', 'Modification des coordonnées bancaires', 'تعديل المعلومات البنكية', 'Bank details change',
           '[{"key": "hr", "kind": "permission", "permission": "employee.bank.update", "labels": {"fr": "RH", "ar": "الموارد البشرية", "en": "HR"}}]'::jsonb)
       ) as d (code, name_fr, name_ar, name_en, steps)
on conflict (company_id, code) do nothing;

-- The system employee-file category the approved requests' files are copied into (SYSTEM_FILE_CATEGORIES).
insert into public.employee_file_category (company_id, code, name_fr, name_ar, name_en, access_class, sort_order, is_system)
select c.id, 'supporting_document', 'Pièces justificatives', 'الوثائق الثبوتية', 'Supporting documents', 'standard', 70, true
  from public.company c
on conflict (company_id, code) do nothing;
