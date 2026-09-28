-- 0014: generated HR documents — letterhead, signatories, document types and gap-free numbering, the register and
-- its stored PDFs, self-service requests (docs/contracts/documents.md › Phase A, ADR 008).
--   company_profile        per company: legal names, address, "Fait à" city, identifiers, footer, logo (fr / ar)
--   document_signatory     who signs (name and title fr / ar), company-wide or for a unit and its sub-units
--   document_type          per company: the three fixed codes, number format, languages, self-service, default signatory
--   document_sequence      one gap-free counter per company × type × year (NOT a SEQUENCE: nextval() never rolls back)
--   issued_document        the register: number, snapshot (the exact template input), hashes, versions, void
--   issued_document_file   the stored PDF bytes (insert-only; integrity through issued_document.content_sha256)
--   document_request       an employee's self-service request (attestation), approved through the workflow engine
-- Also: workflow subject type `document_request`, notification subject types `issued_document` / `document_request`,
-- the `documents` permission group and codes with their system-role grants, and per existing company the three
-- document types and the workflow definition `document.hr_only`.
--
-- Every new table: company_id + RLS/FORCE + the standard tenant policy, composite (company_id, …) foreign keys, the
-- audit trigger except document_sequence and issued_document_file (tools/guardrails/audit-exempt.json). Users are
-- referenced without FK (hrforce_app has no privilege on auth.*), like role_grant.user_id.
-- Race-free rules live here: one number per (company, type, year, seq) and per (company, number), one register row
-- per client request id, counters that only move by +1, a register row that only changes by being voided, PDF bytes
-- that never change, one pending self-service request per employment and type.

-- ---------------------------------------------------------------------------------------------------------
create table public.company_profile (
  company_id uuid primary key references public.company (id),
  legal_name_fr text,
  legal_name_ar text,
  address_fr text,
  address_ar text,
  -- "Fait à <city>" / "حرر في <city>"
  city_fr text,
  city_ar text,
  phone text,
  email text,
  nif text,
  nis text,
  rc text,
  -- article d'imposition
  ai text,
  footer_fr text,
  footer_ar text,
  logo bytea,
  logo_mime text,
  logo_sha256 bytea,
  updated_at timestamptz not null default now(),
  constraint company_profile_names_ck check (
    (legal_name_fr is null or (legal_name_fr = btrim(legal_name_fr) and char_length(legal_name_fr) between 1 and 200))
    and (legal_name_ar is null or (legal_name_ar = btrim(legal_name_ar) and char_length(legal_name_ar) between 1 and 200))
    and (city_fr is null or (city_fr = btrim(city_fr) and char_length(city_fr) between 1 and 200))
    and (city_ar is null or (city_ar = btrim(city_ar) and char_length(city_ar) between 1 and 200))
    and (phone is null or (phone = btrim(phone) and char_length(phone) between 1 and 40))
    and (email is null or (email = btrim(email) and char_length(email) between 3 and 200))
  ),
  constraint company_profile_address_ck check (
    (address_fr is null or (address_fr = btrim(address_fr) and char_length(address_fr) between 1 and 300))
    and (address_ar is null or (address_ar = btrim(address_ar) and char_length(address_ar) between 1 and 300))
  ),
  constraint company_profile_footer_ck check (
    (footer_fr is null or (footer_fr = btrim(footer_fr) and char_length(footer_fr) between 1 and 300))
    and (footer_ar is null or (footer_ar = btrim(footer_ar) and char_length(footer_ar) between 1 and 300))
  ),
  constraint company_profile_ids_ck check (
    (nif is null or nif ~ '^[0-9A-Z /-]{1,30}$') and (nis is null or nis ~ '^[0-9A-Z /-]{1,30}$')
    and (rc is null or rc ~ '^[0-9A-Z /-]{1,30}$') and (ai is null or ai ~ '^[0-9A-Z /-]{1,30}$')
  ),
  -- the logo: PNG or JPEG (type sniffed from the bytes by the API), at most 256 KB, with its SHA-256
  constraint company_profile_logo_ck check (
    (logo is null and logo_mime is null and logo_sha256 is null)
    or (logo is not null and octet_length(logo) between 1 and 262144 and logo_mime in ('image/png', 'image/jpeg')
        and octet_length(logo_sha256) = 32)
  )
);

alter table public.company_profile enable row level security;
alter table public.company_profile force row level security;
create policy company_profile_tenant_isolation on public.company_profile
  using (company_id = current_setting('app.company_id', true)::uuid);

-- the logo's bytes are not diffed in the audit trail (its SHA-256 is)
insert into audit.masked_column (table_name, column_name) values ('company_profile', 'logo')
on conflict do nothing;

-- ---------------------------------------------------------------------------------------------------------
create table public.document_signatory (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company (id),
  -- null = company-wide; else signs for the employees of this unit and its sub-units
  org_unit_id uuid,
  name_fr text not null,
  name_ar text not null,
  title_fr text not null,
  title_ar text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint document_signatory_company_id_id_uk unique (company_id, id),
  constraint document_signatory_unit_fk foreign key (company_id, org_unit_id) references public.org_unit (company_id, id),
  constraint document_signatory_names_ck check (
    name_fr = btrim(name_fr) and char_length(name_fr) between 1 and 120
    and name_ar = btrim(name_ar) and char_length(name_ar) between 1 and 120
    and title_fr = btrim(title_fr) and char_length(title_fr) between 1 and 120
    and title_ar = btrim(title_ar) and char_length(title_ar) between 1 and 120
  )
);

create index document_signatory_company_unit_idx on public.document_signatory (company_id, org_unit_id);

alter table public.document_signatory enable row level security;
alter table public.document_signatory force row level security;
create policy document_signatory_tenant_isolation on public.document_signatory
  using (company_id = current_setting('app.company_id', true)::uuid);

-- ---------------------------------------------------------------------------------------------------------
create table public.document_type (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company (id),
  code text not null,
  name_fr text not null,
  name_ar text not null,
  name_en text not null,
  -- literals [A-Z0-9/_.-] and tokens {YYYY} {YY} {SEQ} {SEQ:n}; validated by the API (docs/contracts/documents.md › Numbering)
  number_format text not null,
  languages text[] not null default '{fr,ar}',
  self_service boolean not null default false,
  default_signatory_id uuid,
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  constraint document_type_company_id_id_uk unique (company_id, id),
  constraint document_type_company_code_uk unique (company_id, code),
  constraint document_type_company_format_uk unique (company_id, number_format),
  constraint document_type_signatory_fk foreign key (company_id, default_signatory_id) references public.document_signatory (company_id, id),
  constraint document_type_code_ck check (code in ('attestation_travail', 'certificat_travail', 'titre_conge')),
  constraint document_type_names_ck check (
    name_fr = btrim(name_fr) and char_length(name_fr) between 1 and 120
    and name_ar = btrim(name_ar) and char_length(name_ar) between 1 and 120
    and name_en = btrim(name_en) and char_length(name_en) between 1 and 120
  ),
  constraint document_type_format_ck check (char_length(number_format) between 1 and 60 and number_format ~ '\{SEQ(:[1-9])?\}'),
  constraint document_type_languages_ck check (
    cardinality(languages) between 1 and 2 and languages <@ '{fr,ar}'::text[] and array_position(languages, null) is null
  ),
  -- self-service requests exist for the attestation only (docs/contracts/documents.md › Assumptions 6)
  constraint document_type_self_service_ck check (not self_service or code = 'attestation_travail')
);

alter table public.document_type enable row level security;
alter table public.document_type force row level security;
create policy document_type_tenant_isolation on public.document_type
  using (company_id = current_setting('app.company_id', true)::uuid);

-- ---------------------------------------------------------------------------------------------------------
-- Gap-free counters (ADR 008 §6). The issue use case upserts the row (+1) AFTER every check and holds its row lock until
-- commit: a failed issue rolls the counter back with the register row and the file. Invariant (tested): for every
-- company, type and year, last_value = the number of issued_document rows and their seq are exactly 1..last_value.
create table public.document_sequence (
  company_id uuid not null references public.company (id),
  document_type_id uuid not null,
  year integer not null,
  last_value integer not null,
  constraint document_sequence_pk primary key (company_id, document_type_id, year),
  constraint document_sequence_type_fk foreign key (company_id, document_type_id) references public.document_type (company_id, id),
  constraint document_sequence_year_ck check (year between 2000 and 2999),
  constraint document_sequence_value_ck check (last_value >= 1)
);

alter table public.document_sequence enable row level security;
alter table public.document_sequence force row level security;
create policy document_sequence_tenant_isolation on public.document_sequence
  using (company_id = current_setting('app.company_id', true)::uuid);

-- A counter only moves forward by one (numbers are never reused, a rollback undoes the increment).
create function public.document_sequence_guard() returns trigger
  language plpgsql
as $$
begin
  if new.company_id is distinct from old.company_id or new.document_type_id is distinct from old.document_type_id
     or new.year is distinct from old.year or new.last_value <> old.last_value + 1 then
    raise exception 'document_sequence: a counter only moves forward by one'
      using errcode = 'check_violation', constraint = 'document_sequence_forward';
  end if;
  return new;
end
$$;

create trigger document_sequence_guard_tg
  before update on public.document_sequence
  for each row execute function public.document_sequence_guard();

-- ---------------------------------------------------------------------------------------------------------
create table public.document_request (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  employment_id uuid not null,
  document_type_id uuid not null,
  language text not null,
  -- shown to HR, printed nowhere, never mailed
  purpose text,
  status text not null default 'pending',
  requested_by uuid not null,
  requested_at timestamptz not null default now(),
  workflow_instance_id uuid,
  issued_document_id uuid,
  constraint document_request_company_id_id_uk unique (company_id, id),
  constraint document_request_employment_fk foreign key (company_id, employment_id) references public.employment (company_id, id),
  constraint document_request_type_fk foreign key (company_id, document_type_id) references public.document_type (company_id, id),
  constraint document_request_instance_fk foreign key (company_id, workflow_instance_id) references public.workflow_instance (company_id, id),
  constraint document_request_language_ck check (language in ('fr', 'ar')),
  constraint document_request_purpose_ck check (purpose is null or (purpose = btrim(purpose) and char_length(purpose) between 1 and 200)),
  constraint document_request_status_ck check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  constraint document_request_issued_ck check ((status = 'approved') = (issued_document_id is not null))
);

-- at most one pending request per employee and type
create unique index document_request_one_pending_uk on public.document_request (employment_id, document_type_id) where status = 'pending';
create index document_request_company_employment_idx on public.document_request (company_id, employment_id, requested_at desc);

alter table public.document_request enable row level security;
alter table public.document_request force row level security;
create policy document_request_tenant_isolation on public.document_request
  using (company_id = current_setting('app.company_id', true)::uuid);

-- What was asked is immutable; the status leaves `pending` once (mirrored from the workflow), the instance and the
-- issued document are linked once.
create function public.document_request_guard() returns trigger
  language plpgsql
as $$
begin
  if new.company_id is distinct from old.company_id or new.employment_id is distinct from old.employment_id
     or new.document_type_id is distinct from old.document_type_id or new.language is distinct from old.language
     or new.purpose is distinct from old.purpose or new.requested_by is distinct from old.requested_by
     or new.requested_at is distinct from old.requested_at
     or (old.workflow_instance_id is not null and new.workflow_instance_id is distinct from old.workflow_instance_id)
     or (old.issued_document_id is not null and new.issued_document_id is distinct from old.issued_document_id) then
    raise exception 'document_request %: only status, workflow_instance_id and issued_document_id may change', old.id
      using errcode = 'check_violation', constraint = 'document_request_immutable';
  end if;
  if old.status <> 'pending' and new.status is distinct from old.status then
    raise exception 'document_request %: a % request is final', old.id, old.status
      using errcode = 'check_violation', constraint = 'document_request_final';
  end if;
  return new;
end
$$;

create trigger document_request_guard_tg
  before update on public.document_request
  for each row execute function public.document_request_guard();

-- ---------------------------------------------------------------------------------------------------------
create table public.issued_document (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  document_type_id uuid not null,
  type_code text not null,
  year integer not null,
  seq integer not null,
  number text not null,
  language text not null,
  employment_id uuid not null,
  leave_request_id uuid,
  document_request_id uuid,
  -- the employee's unit at issue (informative; visibility follows the employee's scope unit at read time)
  org_unit_id uuid not null,
  signatory_id uuid not null,
  -- the exact template input (every printed value), kept for audit and search
  snapshot jsonb not null,
  template_version text not null,
  renderer text not null,
  content_sha256 bytea not null,
  size_bytes integer not null,
  issue_date date not null,
  issued_by uuid not null,
  issued_at timestamptz not null default now(),
  client_request_id uuid,
  status text not null default 'issued',
  voided_by uuid,
  voided_at timestamptz,
  void_reason text,
  constraint issued_document_company_id_id_uk unique (company_id, id),
  constraint issued_document_number_uk unique (company_id, number),
  constraint issued_document_seq_uk unique (company_id, document_type_id, year, seq),
  constraint issued_document_type_fk foreign key (company_id, document_type_id) references public.document_type (company_id, id),
  constraint issued_document_employment_fk foreign key (company_id, employment_id) references public.employment (company_id, id),
  constraint issued_document_leave_fk foreign key (company_id, leave_request_id) references public.leave_request (company_id, id),
  constraint issued_document_request_fk foreign key (company_id, document_request_id) references public.document_request (company_id, id),
  constraint issued_document_unit_fk foreign key (company_id, org_unit_id) references public.org_unit (company_id, id),
  constraint issued_document_signatory_fk foreign key (company_id, signatory_id) references public.document_signatory (company_id, id),
  constraint issued_document_type_code_ck check (type_code in ('attestation_travail', 'certificat_travail', 'titre_conge')),
  constraint issued_document_titre_ck check ((type_code = 'titre_conge') = (leave_request_id is not null)),
  constraint issued_document_year_ck check (year between 2000 and 2999 and year = extract(year from issue_date)),
  constraint issued_document_seq_ck check (seq >= 1),
  constraint issued_document_number_ck check (number = btrim(number) and char_length(number) between 1 and 40),
  constraint issued_document_language_ck check (language in ('fr', 'ar')),
  constraint issued_document_snapshot_ck check (jsonb_typeof(snapshot) = 'object'),
  constraint issued_document_sha_ck check (octet_length(content_sha256) = 32),
  constraint issued_document_size_ck check (size_bytes > 0),
  constraint issued_document_versions_ck check (char_length(template_version) between 1 and 60 and char_length(renderer) between 1 and 120),
  constraint issued_document_status_ck check (status in ('issued', 'void')),
  constraint issued_document_void_ck check (
    (status = 'issued' and voided_by is null and voided_at is null and void_reason is null)
    or (status = 'void' and voided_by is not null and voided_at is not null and void_reason is not null)
  ),
  constraint issued_document_void_reason_ck check (void_reason is null or (void_reason = btrim(void_reason) and char_length(void_reason) between 3 and 500))
);

create unique index issued_document_client_request_uk on public.issued_document (company_id, client_request_id) where client_request_id is not null;
create index issued_document_company_employment_idx on public.issued_document (company_id, employment_id, issued_at desc);
create index issued_document_company_issue_date_idx on public.issued_document (company_id, issue_date desc, issued_at desc);
create index issued_document_company_leave_idx on public.issued_document (company_id, leave_request_id) where leave_request_id is not null;

alter table public.issued_document enable row level security;
alter table public.issued_document force row level security;
create policy issued_document_tenant_isolation on public.issued_document
  using (company_id = current_setting('app.company_id', true)::uuid);

-- The register is a record: a row never changes, except once, by being voided (it keeps its number).
create function public.issued_document_guard() returns trigger
  language plpgsql
as $$
begin
  if new.id is distinct from old.id or new.company_id is distinct from old.company_id
     or new.document_type_id is distinct from old.document_type_id or new.type_code is distinct from old.type_code
     or new.year is distinct from old.year or new.seq is distinct from old.seq or new.number is distinct from old.number
     or new.language is distinct from old.language or new.employment_id is distinct from old.employment_id
     or new.leave_request_id is distinct from old.leave_request_id or new.document_request_id is distinct from old.document_request_id
     or new.org_unit_id is distinct from old.org_unit_id or new.signatory_id is distinct from old.signatory_id
     or new.snapshot is distinct from old.snapshot or new.template_version is distinct from old.template_version
     or new.renderer is distinct from old.renderer or new.content_sha256 is distinct from old.content_sha256
     or new.size_bytes is distinct from old.size_bytes or new.issue_date is distinct from old.issue_date
     or new.issued_by is distinct from old.issued_by or new.issued_at is distinct from old.issued_at
     or new.client_request_id is distinct from old.client_request_id then
    raise exception 'issued_document %: an issued document is immutable (only voiding is allowed)', old.id
      using errcode = 'check_violation', constraint = 'issued_document_immutable';
  end if;
  if not (old.status = 'issued' and new.status = 'void') then
    raise exception 'issued_document %: the only change is issued → void', old.id
      using errcode = 'check_violation', constraint = 'issued_document_void_once';
  end if;
  return new;
end
$$;

create trigger issued_document_guard_tg
  before update on public.issued_document
  for each row execute function public.issued_document_guard();

alter table public.document_request
  add constraint document_request_issued_fk foreign key (company_id, issued_document_id) references public.issued_document (company_id, id);

-- ---------------------------------------------------------------------------------------------------------
create table public.issued_document_file (
  document_id uuid primary key,
  company_id uuid not null,
  pdf bytea not null,
  constraint issued_document_file_document_fk foreign key (company_id, document_id) references public.issued_document (company_id, id),
  constraint issued_document_file_pdf_ck check (octet_length(pdf) > 0)
);

alter table public.issued_document_file enable row level security;
alter table public.issued_document_file force row level security;
create policy issued_document_file_tenant_isolation on public.issued_document_file
  using (company_id = current_setting('app.company_id', true)::uuid);

-- ---------------------------------------------------------------------------------------------------------
-- Privileges: nothing of this slice is deleted by the app; the stored PDF is insert-only.
revoke delete on table public.company_profile, public.document_signatory, public.document_type, public.document_sequence,
  public.document_request, public.issued_document, public.issued_document_file
  from hrforce_app;
revoke update on table public.issued_document_file from hrforce_app;
revoke all on function public.document_sequence_guard(), public.document_request_guard(), public.issued_document_guard() from public;

-- ---------------------------------------------------------------------------------------------------------
-- Audit (guard:db audit-per-write): every new tenant table except the counter and the PDF bytes (audit-exempt.json).
create trigger audit_capture_tg after insert or update or delete on public.company_profile
  for each row execute function audit.capture('company_id');
create trigger audit_capture_tg after insert or update or delete on public.document_signatory
  for each row execute function audit.capture();
create trigger audit_capture_tg after insert or update or delete on public.document_type
  for each row execute function audit.capture();
create trigger audit_capture_tg after insert or update or delete on public.document_request
  for each row execute function audit.capture();
create trigger audit_capture_tg after insert or update or delete on public.issued_document
  for each row execute function audit.capture();

-- ---------------------------------------------------------------------------------------------------------
-- Cross-module: the workflow engine gets its second subject type; notifications can be about documents.
alter table public.workflow_instance drop constraint workflow_instance_subject_type_ck;
alter table public.workflow_instance
  add constraint workflow_instance_subject_type_ck check (subject_type in ('leave_request', 'document_request'));

alter table public.notification drop constraint notification_subject_type_ck;
alter table public.notification
  add constraint notification_subject_type_ck check (subject_type in ('workflow_task', 'leave_request', 'document_request', 'issued_document'));

-- ---------------------------------------------------------------------------------------------------------
-- Permissions: group `documents` (sort 610–650). Held by the system roles of every company (new companies:
-- SYSTEM_ROLES in modules/authorization/domain/catalogue.ts): admin_rh_central all; rh_regional read + issue;
-- employe request_self. No document permission is sensitive (the MFA policy defaults are unchanged).
alter table public.permission drop constraint permission_group_ck;
alter table public.permission
  add constraint permission_group_ck check (group_code in ('organization', 'access', 'employee', 'leave', 'documents', 'sensitive'));

insert into public.permission (code, label_fr, label_ar, label_en, group_code, sensitive, sort_order) values
  ('document.read', 'Consulter le registre des documents', 'الاطلاع على سجل الوثائق', 'View the document register', 'documents', false, 610),
  ('document.issue', 'Émettre des documents', 'إصدار الوثائق', 'Issue documents', 'documents', false, 620),
  ('document.void', 'Annuler un document émis', 'إلغاء وثيقة صادرة', 'Void an issued document', 'documents', false, 630),
  ('document.configure', 'Paramétrer les documents (en-tête, signataires, numérotation)', 'إعداد الوثائق (الترويسة، الموقعون، الترقيم)', 'Configure documents (letterhead, signatories, numbering)', 'documents', false, 640),
  ('document.request_self', 'Demander ses attestations', 'طلب شهاداته', 'Request own certificates', 'documents', false, 650);

insert into public.role_permission (company_id, role_id, permission_code)
select r.company_id, r.id, p.code
  from public.role r
  join (values
          ('admin_rh_central', 'document.read'), ('admin_rh_central', 'document.issue'), ('admin_rh_central', 'document.void'),
          ('admin_rh_central', 'document.configure'), ('admin_rh_central', 'document.request_self'),
          ('rh_regional', 'document.read'), ('rh_regional', 'document.issue'),
          ('employe', 'document.request_self')
       ) as p (role_code, code) on p.role_code = r.code
 where r.is_system
on conflict (role_id, permission_code) do nothing;

-- ---------------------------------------------------------------------------------------------------------
-- Defaults of every existing company (new ones: seedDocumentDefaults, called by bootstrap and seed:dev):
-- the three types (active, fr + ar, default formats, self-service only for the attestation) and the one-step HR
-- workflow of self-service requests. No company_profile row: issuing needs one (document-profile-incomplete).
insert into public.document_type (company_id, code, name_fr, name_ar, name_en, number_format, languages, self_service, sort_order)
select c.id, t.code, t.name_fr, t.name_ar, t.name_en, t.number_format, '{fr,ar}', t.self_service, t.sort_order
  from public.company c
  cross join (values
          ('attestation_travail', 'Attestation de travail', 'شهادة عمل', 'Employment certificate', 'ATT-{YYYY}-{SEQ:5}', true, 10),
          ('certificat_travail', 'Certificat de travail', 'شهادة نهاية العمل', 'Certificate of employment (end of contract)', 'CT-{YYYY}-{SEQ:5}', false, 20),
          ('titre_conge', 'Titre de congé', 'سند عطلة', 'Leave certificate', 'TC-{YYYY}-{SEQ:5}', false, 30)
       ) as t (code, name_fr, name_ar, name_en, number_format, self_service, sort_order)
on conflict (company_id, code) do nothing;

insert into public.workflow_definition (company_id, code, name_fr, name_ar, name_en, steps, is_system)
select c.id, 'document.hr_only', 'RH uniquement', 'الموارد البشرية فقط', 'HR only',
       '[{"key": "hr", "kind": "permission", "permission": "document.issue", "labels": {"fr": "RH", "ar": "الموارد البشرية", "en": "HR"}}]'::jsonb,
       true
  from public.company c
on conflict (company_id, code) do nothing;
