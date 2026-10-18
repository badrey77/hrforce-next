-- 0022: Document templates — designer, custom document types, versions (docs/contracts/document-templates.md,
-- ADR 008 amendment 2026-10-09).
--   document_type               gains kind (system | custom), subject (employment | leave_request), employment_rule
--                               (any | active | ended), template_mode (builtin | designed) and the published version;
--                               custom codes are allowed next to the three system ones
--   document_template_version   a designed template of a type: one layout per language and the fields typed at issue
--                               time (JSON, validated by the API), draft → published → archived; immutable once
--                               published (only published → archived), only a draft may be deleted (discarded)
--   issued_document             gains subject (row-local check with leave_request_id) and template_version_id
-- Also: permission document.design (group documents, 665) for admin_rh_central, in the two-step sign-in defaults and
-- appended once to every existing policy.
--
-- A designed template is DATA, never Typst code: the API resolves it and one fixed file (designed.typ) lays it out.
-- Race-free rules live here: at most one draft and one published version per type, version numbers unique per type,
-- the published version belongs to its type, a published version never changes.

-- ---------------------------------------------------------------------------------------------------------
-- Permission and its system-role grant; two-step sign-in required (owner decision 2026-10-09).
insert into public.permission (code, label_fr, label_ar, label_en, group_code, sensitive, sort_order) values
  ('document.design', 'Concevoir les modèles de documents', 'تصميم نماذج الوثائق', 'Design document templates', 'documents', false, 665);

insert into public.role_permission (company_id, role_id, permission_code)
select r.company_id, r.id, 'document.design'
  from public.role r
 where r.is_system and r.code = 'admin_rh_central'
on conflict (role_id, permission_code) do nothing;

create or replace function public.security_policy_default_permissions()
  returns text[]
  language sql
  stable
  set search_path = pg_catalog, public
as $$
  select coalesce(array_agg(p.code order by p.sort_order), '{}')
    from public.permission p
   where p.sensitive
      or p.code in ('access.grant', 'access.manage_roles', 'leave.configure', 'attendance.configure', 'sso.manage_apps', 'sso.assign',
                    'settings.branding', 'document.design')
$$;

update public.security_policy
   set mfa_required_permissions = array_append(mfa_required_permissions, 'document.design')
 where not ('document.design' = any (mfa_required_permissions));

-- ---------------------------------------------------------------------------------------------------------
-- Document types: custom codes, kind, subject, employment rule, template mode.
alter table public.document_type drop constraint document_type_code_ck;
alter table public.document_type drop constraint document_type_self_service_ck;

alter table public.document_type
  add column kind text not null default 'system',
  add column subject text not null default 'employment',
  add column employment_rule text not null default 'any',
  add column template_mode text not null default 'builtin',
  add column published_template_id uuid;

update public.document_type set subject = 'employment', employment_rule = 'active' where code = 'attestation_travail';
update public.document_type set subject = 'employment', employment_rule = 'ended' where code = 'certificat_travail';
update public.document_type set subject = 'leave_request', employment_rule = 'any' where code = 'titre_conge';

alter table public.document_type
  -- system types keep their three codes; a custom code is never one of them
  add constraint document_type_code_ck check (
    code ~ '^[a-z][a-z0-9_]{2,39}$'
    and (kind = 'system') = (code in ('attestation_travail', 'certificat_travail', 'titre_conge'))
  ),
  add constraint document_type_kind_ck check (kind in ('system', 'custom')),
  add constraint document_type_subject_ck check (subject in ('employment', 'leave_request')),
  add constraint document_type_employment_rule_ck check (employment_rule in ('any', 'active', 'ended')),
  -- the employment rule of a leave document is that of its leave request (none)
  add constraint document_type_leave_rule_ck check (subject = 'employment' or employment_rule = 'any'),
  -- builtin: a system type on its code template (no published version). designed: the published version; a custom
  -- type is always designed and has no version until its first publish (it cannot be activated or issued before)
  add constraint document_type_template_mode_ck check (
    template_mode in ('builtin', 'designed')
    and (template_mode = 'designed' or (kind = 'system' and published_template_id is null))
    and (template_mode = 'builtin' or published_template_id is not null or kind = 'custom')
  ),
  -- self-service requests: the attestation, or a custom type (the API refuses one whose template has a required field)
  add constraint document_type_self_service_ck check (not self_service or code = 'attestation_travail' or kind = 'custom');

-- code, kind and subject never change; the employment rule of a system type neither
create function public.document_type_guard() returns trigger
  language plpgsql
as $$
begin
  if new.code is distinct from old.code or new.kind is distinct from old.kind or new.subject is distinct from old.subject
     or (old.kind = 'system' and new.employment_rule is distinct from old.employment_rule) then
    raise exception 'document_type %: code, kind and subject are fixed (and a system type''s employment rule)', old.id
      using errcode = 'check_violation', constraint = 'document_type_fixed';
  end if;
  return new;
end
$$;

create trigger document_type_guard_tg
  before update on public.document_type
  for each row execute function public.document_type_guard();

-- ---------------------------------------------------------------------------------------------------------
create table public.document_template_version (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company (id),
  document_type_id uuid not null,
  version integer not null,
  status text not null default 'draft',
  -- {fr?: TemplateLayout, ar?: TemplateLayout} (document-templates.md › Layout model), validated by the API
  layouts jsonb not null default '{}'::jsonb,
  -- TemplateField[]
  fields jsonb not null default '[]'::jsonb,
  -- informative: `builtin:<code>@2`, `blank`, or the version id it was copied from
  based_on text,
  -- optimistic lock of the draft: +1 per save
  revision integer not null default 1,
  -- auth.user_account ids, without FK (hrforce_app has no privilege on auth.*), like role_grant.user_id
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_by uuid not null,
  updated_at timestamptz not null default now(),
  published_by uuid,
  published_at timestamptz,
  note text,
  constraint document_template_version_company_id_id_uk unique (company_id, id),
  constraint document_template_version_type_id_uk unique (company_id, document_type_id, id),
  constraint document_template_version_number_uk unique (company_id, document_type_id, version),
  constraint document_template_version_type_fk foreign key (company_id, document_type_id) references public.document_type (company_id, id),
  constraint document_template_version_version_ck check (version >= 1 and revision >= 1),
  constraint document_template_version_status_ck check (status in ('draft', 'published', 'archived')),
  -- a draft was never published; a published or archived version was, by someone, at some time
  constraint document_template_version_published_ck check (
    (status = 'draft') = (published_at is null) and (published_at is null) = (published_by is null)
  ),
  constraint document_template_version_json_ck check (
    jsonb_typeof(layouts) = 'object' and jsonb_typeof(fields) = 'array'
    and octet_length(layouts::text) + octet_length(fields::text) <= 524288
  ),
  constraint document_template_version_based_on_ck check (based_on is null or char_length(based_on) between 1 and 80),
  constraint document_template_version_note_ck check (note is null or (note = btrim(note) and char_length(note) between 1 and 300))
);

-- one draft and one published version per type at a time
create unique index document_template_version_one_draft_uk on public.document_template_version (company_id, document_type_id) where status = 'draft';
create unique index document_template_version_one_published_uk on public.document_template_version (company_id, document_type_id) where status = 'published';

alter table public.document_template_version enable row level security;
alter table public.document_template_version force row level security;
create policy document_template_version_tenant_isolation on public.document_template_version
  using (company_id = current_setting('app.company_id', true)::uuid);

-- A draft is edited, published or discarded; a published version is only archived; an archived one never changes.
create function public.document_template_version_guard() returns trigger
  language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'document_template_version %: only a draft can be discarded', old.id
        using errcode = 'check_violation', constraint = 'document_template_version_discard_draft';
    end if;
    return old;
  end if;
  if new.id is distinct from old.id or new.company_id is distinct from old.company_id
     or new.document_type_id is distinct from old.document_type_id or new.version is distinct from old.version
     or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at
     or new.based_on is distinct from old.based_on then
    raise exception 'document_template_version %: identity columns never change', old.id
      using errcode = 'check_violation', constraint = 'document_template_version_immutable';
  end if;
  if old.status = 'draft' then
    if new.status not in ('draft', 'published') then
      raise exception 'document_template_version %: a draft is published or discarded', old.id
        using errcode = 'check_violation', constraint = 'document_template_version_transition';
    end if;
    return new;
  end if;
  if old.status = 'published' and new.status = 'archived'
     and new.layouts = old.layouts and new.fields = old.fields and new.revision = old.revision
     and new.updated_by is not distinct from old.updated_by and new.updated_at is not distinct from old.updated_at
     and new.published_by is not distinct from old.published_by and new.published_at is not distinct from old.published_at
     and new.note is not distinct from old.note then
    return new;
  end if;
  raise exception 'document_template_version %: a published version is immutable (only published → archived)', old.id
    using errcode = 'check_violation', constraint = 'document_template_version_immutable';
end
$$;

create trigger document_template_version_guard_tg
  before update or delete on public.document_template_version
  for each row execute function public.document_template_version_guard();

-- the published version of a type belongs to that type
alter table public.document_type
  add constraint document_type_published_fk foreign key (company_id, id, published_template_id)
    references public.document_template_version (company_id, document_type_id, id);

-- ---------------------------------------------------------------------------------------------------------
-- The register: custom type codes, the subject (row-local check with the leave request), the version used.
alter table public.issued_document drop constraint issued_document_type_code_ck;
alter table public.issued_document drop constraint issued_document_titre_ck;
alter table public.issued_document
  add column subject text,
  add column template_version_id uuid;

-- backfill (the register is immutable through the guard: it is suspended for this one update, with the audit trigger:
-- the new column is derived from the type code, not a change of the record)
alter table public.issued_document disable trigger issued_document_guard_tg;
alter table public.issued_document disable trigger audit_capture_tg;
update public.issued_document set subject = case when type_code = 'titre_conge' then 'leave_request' else 'employment' end;
alter table public.issued_document enable trigger issued_document_guard_tg;
alter table public.issued_document enable trigger audit_capture_tg;

alter table public.issued_document
  alter column subject set not null,
  add constraint issued_document_type_code_ck check (type_code ~ '^[a-z][a-z0-9_]{2,39}$'),
  add constraint issued_document_subject_ck check (subject in ('employment', 'leave_request') and (subject = 'leave_request') = (leave_request_id is not null)),
  add constraint issued_document_template_fk foreign key (company_id, document_type_id, template_version_id)
    references public.document_template_version (company_id, document_type_id, id);

create or replace function public.issued_document_guard() returns trigger
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
     or new.client_request_id is distinct from old.client_request_id or new.subject is distinct from old.subject
     or new.template_version_id is distinct from old.template_version_id then
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

create index issued_document_company_template_idx on public.issued_document (company_id, template_version_id) where template_version_id is not null;

-- ---------------------------------------------------------------------------------------------------------
-- Privileges: hrforce_app keeps 0001's DML on the new table; deleting is limited to drafts by the guard.
revoke all on function public.document_type_guard(), public.document_template_version_guard() from public;

-- Audit (guard:db audit-per-write).
create trigger audit_capture_tg after insert or update or delete on public.document_template_version
  for each row execute function audit.capture();
