-- 0015: the employee file — uploaded attachments (docs/contracts/documents.md › Phase B).
--   employee_file_category   per company: code, names fr/ar/en, access class (standard / medical), retention after the end
--   employee_file            one uploaded file's metadata (title, sniffed type, size, SHA-256, dates, tombstone, purge)
--   employee_file_content    the file's bytes (bytea, one row per file; deleted with the tombstone or by the purge)
-- Also: the permissions employee_file.read / upload / delete (group documents) and employee.medical.update (sensitive),
-- their system-role grants, the five system categories of every existing company, the worker's purge privileges.
--
-- Every new table: company_id + RLS/FORCE + the standard tenant policy, composite (company_id, …) foreign keys, the
-- audit trigger except employee_file_content (tools/guardrails/audit-exempt.json: bytes; the hash is audited on
-- employee_file). Users are referenced without FK (hrforce_app has no privilege on auth.*), like role_grant.user_id.
-- Race-free rules live here: one live copy of a file (same SHA-256) per employment, a category's code and access
-- class never change, a file's metadata never changes except by being deleted (tombstone) or purged — once, and the
-- bytes are only removed together with (after) one of those two marks.

-- ---------------------------------------------------------------------------------------------------------
create table public.employee_file_category (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company (id),
  code text not null,
  name_fr text not null,
  name_ar text not null,
  name_en text not null,
  -- medical: seeing needs employee.medical.read, adding (and deleting) employee.medical.update
  access_class text not null default 'standard',
  -- null = keep; else the purge job removes the bytes N years after the person's last employment ended
  retention_years_after_end integer,
  active boolean not null default true,
  sort_order integer not null default 0,
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  constraint employee_file_category_company_id_id_uk unique (company_id, id),
  constraint employee_file_category_company_code_uk unique (company_id, code),
  constraint employee_file_category_code_ck check (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  constraint employee_file_category_names_ck check (
    name_fr = btrim(name_fr) and char_length(name_fr) between 1 and 120
    and name_ar = btrim(name_ar) and char_length(name_ar) between 1 and 120
    and name_en = btrim(name_en) and char_length(name_en) between 1 and 120
  ),
  constraint employee_file_category_class_ck check (access_class in ('standard', 'medical')),
  -- only the seeded system category is medical: the API creates standard categories only
  constraint employee_file_category_medical_system_ck check (access_class = 'standard' or is_system),
  constraint employee_file_category_retention_ck check (retention_years_after_end is null or retention_years_after_end between 1 and 100)
);

alter table public.employee_file_category enable row level security;
alter table public.employee_file_category force row level security;
create policy employee_file_category_tenant_isolation on public.employee_file_category
  using (company_id = current_setting('app.company_id', true)::uuid);

-- A category's identity never changes: turning `medical` into `standard` would expose medical files.
create function public.employee_file_category_guard() returns trigger
  language plpgsql
as $$
begin
  if new.id is distinct from old.id or new.company_id is distinct from old.company_id or new.code is distinct from old.code
     or new.access_class is distinct from old.access_class or new.is_system is distinct from old.is_system
     or new.created_at is distinct from old.created_at then
    raise exception 'employee_file_category %: code, access class and system flag are immutable', old.id
      using errcode = 'check_violation', constraint = 'employee_file_category_immutable';
  end if;
  return new;
end
$$;

create trigger employee_file_category_guard_tg
  before update on public.employee_file_category
  for each row execute function public.employee_file_category_guard();

-- ---------------------------------------------------------------------------------------------------------
create table public.employee_file (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  employment_id uuid not null,
  category_id uuid not null,
  title text not null,
  -- as sent by the browser, without path parts, control and bidi-override characters (display only)
  original_filename text not null,
  -- sniffed from the bytes (the declared type and the extension are ignored)
  mime text not null,
  size_bytes integer not null,
  sha256 bytea not null,
  document_date date,
  -- e.g. an identity card's end of validity
  expires_on date,
  -- reserved for a future antivirus job (docs/contracts/documents.md › Assumptions 13)
  scan_status text not null default 'not_scanned',
  uploaded_by uuid not null,
  uploaded_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text,
  purged_at timestamptz,
  constraint employee_file_company_id_id_uk unique (company_id, id),
  constraint employee_file_employment_fk foreign key (company_id, employment_id) references public.employment (company_id, id),
  constraint employee_file_category_fk foreign key (company_id, category_id) references public.employee_file_category (company_id, id),
  constraint employee_file_title_ck check (title = btrim(title) and char_length(title) between 1 and 120),
  constraint employee_file_filename_ck check (char_length(original_filename) between 1 and 200 and original_filename !~ '[\x01-\x1f\x7f/\\]'),
  constraint employee_file_mime_ck check (mime in ('application/pdf', 'image/jpeg', 'image/png')),
  -- EMPLOYEE_FILE_MAX_BYTES is at most 20 MB
  constraint employee_file_size_ck check (size_bytes between 1 and 20971520),
  constraint employee_file_sha_ck check (octet_length(sha256) = 32),
  constraint employee_file_scan_ck check (scan_status in ('not_scanned', 'clean', 'infected', 'failed')),
  constraint employee_file_deleted_ck check (
    (deleted_at is null and deleted_by is null and delete_reason is null)
    or (deleted_at is not null and deleted_by is not null and delete_reason is not null)
  ),
  constraint employee_file_reason_ck check (delete_reason is null or (delete_reason = btrim(delete_reason) and char_length(delete_reason) between 3 and 500))
);

create index employee_file_company_employment_idx on public.employee_file (company_id, employment_id, uploaded_at desc);
create index employee_file_company_category_idx on public.employee_file (company_id, category_id);
-- duplicate detection: one live copy of the same bytes per employment (409 employee-file-duplicate)
create unique index employee_file_live_sha_uk on public.employee_file (company_id, employment_id, sha256)
  where deleted_at is null and purged_at is null;

alter table public.employee_file enable row level security;
alter table public.employee_file force row level security;
create policy employee_file_tenant_isolation on public.employee_file
  using (company_id = current_setting('app.company_id', true)::uuid);

-- The metadata is a record: it only changes by being deleted (the tombstone, once) or purged (purged_at, once).
create function public.employee_file_guard() returns trigger
  language plpgsql
as $$
begin
  if new.id is distinct from old.id or new.company_id is distinct from old.company_id
     or new.employment_id is distinct from old.employment_id or new.category_id is distinct from old.category_id
     or new.title is distinct from old.title or new.original_filename is distinct from old.original_filename
     or new.mime is distinct from old.mime or new.size_bytes is distinct from old.size_bytes
     or new.sha256 is distinct from old.sha256 or new.document_date is distinct from old.document_date
     or new.expires_on is distinct from old.expires_on or new.uploaded_by is distinct from old.uploaded_by
     or new.uploaded_at is distinct from old.uploaded_at
     or (old.deleted_at is not null and (new.deleted_at is distinct from old.deleted_at
         or new.deleted_by is distinct from old.deleted_by or new.delete_reason is distinct from old.delete_reason))
     or (old.purged_at is not null and new.purged_at is distinct from old.purged_at) then
    raise exception 'employee_file %: only the tombstone and purged_at may be set, once', old.id
      using errcode = 'check_violation', constraint = 'employee_file_immutable';
  end if;
  return new;
end
$$;

create trigger employee_file_guard_tg
  before update on public.employee_file
  for each row execute function public.employee_file_guard();

-- ---------------------------------------------------------------------------------------------------------
create table public.employee_file_content (
  file_id uuid primary key,
  company_id uuid not null,
  content bytea not null,
  constraint employee_file_content_file_fk foreign key (company_id, file_id) references public.employee_file (company_id, id),
  constraint employee_file_content_size_ck check (octet_length(content) between 1 and 20971520)
);

-- PDF, JPEG and PNG are already compressed: store out of line without trying to compress again.
alter table public.employee_file_content alter column content set storage external;

alter table public.employee_file_content enable row level security;
alter table public.employee_file_content force row level security;
create policy employee_file_content_tenant_isolation on public.employee_file_content
  using (company_id = current_setting('app.company_id', true)::uuid);

-- Bytes leave only with their file's tombstone or purge mark, set first in the same transaction.
create function public.employee_file_content_delete_guard() returns trigger
  language plpgsql
as $$
begin
  if not exists (
    select 1 from public.employee_file f
     where f.company_id = old.company_id and f.id = old.file_id and (f.deleted_at is not null or f.purged_at is not null)
  ) then
    raise exception 'employee_file_content %: delete the file (tombstone) or purge it before removing its bytes', old.file_id
      using errcode = 'check_violation', constraint = 'employee_file_content_delete';
  end if;
  return old;
end
$$;

create trigger employee_file_content_delete_guard_tg
  before delete on public.employee_file_content
  for each row execute function public.employee_file_content_delete_guard();

-- ---------------------------------------------------------------------------------------------------------
-- Privileges. hrforce_app: no DELETE of metadata or categories (tombstones, deactivation), bytes are insert + delete
-- only. hrforce_worker (the retention purge): SELECT by 0012's default privileges, UPDATE (purged_at) on the file,
-- DELETE of the bytes, and the audit event of a run.
revoke delete on table public.employee_file_category, public.employee_file from hrforce_app;
revoke update on table public.employee_file_content from hrforce_app;
revoke all on function public.employee_file_category_guard(), public.employee_file_guard(), public.employee_file_content_delete_guard() from public;
grant update (purged_at) on table public.employee_file to hrforce_worker;
grant delete on table public.employee_file_content to hrforce_worker;
grant execute on function audit.record_event(text, text, uuid, jsonb) to hrforce_worker;

-- ---------------------------------------------------------------------------------------------------------
-- Audit (guard:db audit-per-write): the categories and the metadata; the bytes are exempt (audit-exempt.json).
create trigger audit_capture_tg after insert or update or delete on public.employee_file_category
  for each row execute function audit.capture();
create trigger audit_capture_tg after insert or update or delete on public.employee_file
  for each row execute function audit.capture();

-- ---------------------------------------------------------------------------------------------------------
-- Permissions: employee_file.* (group documents, 670–690) and employee.medical.update (sensitive, next to
-- employee.medical.read). admin_rh_central: the three employee_file codes; rh_regional: read + upload. No system role
-- holds employee.medical.read or employee.medical.update (docs/contracts/documents.md › Assumptions 14).
insert into public.permission (code, label_fr, label_ar, label_en, group_code, sensitive, sort_order) values
  ('employee.medical.update', 'Ajouter des pièces médicales', 'إضافة وثائق طبية', 'Add medical documents', 'sensitive', true, 445),
  ('employee_file.read', 'Consulter le dossier de l''employé', 'الاطلاع على ملف الموظف', 'View the employee file', 'documents', false, 670),
  ('employee_file.upload', 'Ajouter des pièces au dossier', 'إضافة وثائق إلى الملف', 'Add documents to the employee file', 'documents', false, 680),
  ('employee_file.delete', 'Supprimer des pièces du dossier', 'حذف وثائق من الملف', 'Delete documents from the employee file', 'documents', false, 690);

insert into public.role_permission (company_id, role_id, permission_code)
select r.company_id, r.id, p.code
  from public.role r
  join (values
          ('admin_rh_central', 'employee_file.read'), ('admin_rh_central', 'employee_file.upload'), ('admin_rh_central', 'employee_file.delete'),
          ('rh_regional', 'employee_file.read'), ('rh_regional', 'employee_file.upload')
       ) as p (role_code, code) on p.role_code = r.code
 where r.is_system
on conflict (role_id, permission_code) do nothing;

-- The new sensitive permission joins the two-step sign-in list of the policies that require its read counterpart
-- (new policies get it from security_policy_default_permissions(), which lists every sensitive permission).
update public.security_policy
   set mfa_required_permissions = array_append(mfa_required_permissions, 'employee.medical.update')
 where 'employee.medical.read' = any (mfa_required_permissions)
   and not ('employee.medical.update' = any (mfa_required_permissions));

-- ---------------------------------------------------------------------------------------------------------
-- The five system categories of every existing company (new ones: seedDocumentDefaults, called by bootstrap and
-- seed:dev). No retention by default (docs/contracts/documents.md › Assumptions 15).
insert into public.employee_file_category (company_id, code, name_fr, name_ar, name_en, access_class, sort_order, is_system)
select c.id, k.code, k.name_fr, k.name_ar, k.name_en, k.access_class, k.sort_order, true
  from public.company c
  cross join (values
          ('diploma', 'Diplômes', 'الشهادات', 'Diplomas', 'standard', 10),
          ('contract', 'Contrats et avenants', 'العقود والملاحق', 'Contracts and amendments', 'standard', 20),
          ('id_document', 'Pièces d''identité', 'وثائق الهوية', 'Identity documents', 'standard', 30),
          ('medical', 'Médical', 'طبي', 'Medical', 'medical', 40),
          ('other', 'Autres', 'أخرى', 'Other', 'standard', 50)
       ) as k (code, name_fr, name_ar, name_en, access_class, sort_order)
on conflict (company_id, code) do nothing;
