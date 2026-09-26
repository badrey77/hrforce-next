-- 0008: authorization (docs/contracts/authorization.md, ADR 002).
--   permission       global catalogue of permission codes (labels fr/ar/en, group, sensitive flag); SELECT-only
--   role             tenant: a named bundle of permissions (system roles are seeded per company by seed:dev/user:invite)
--   role_permission  tenant: role → permission codes
--   role_grant       tenant: a role granted to a user on an org unit (optionally its sub-units) over a date range
--   auth.company_members(company_id)  SECURITY DEFINER: the members of the CURRENT tenant only
--
-- Grants are never deleted: ending one lowers `valid_to` (history kept). `valid` = daterange(valid_from, valid_to,
-- '[)') is a generated column — the range is the truth for "effective today" (`valid @> today`); valid_from/valid_to
-- are kept separately so that a grant ended on its first day (an empty range) still records when it started.

-- ---------------------------------------------------------------------------------------------------------
-- Permission catalogue: reference data shared by every tenant (exempt from company_id, see
-- tools/guardrails/company-id-exempt.json). Seeded here; the app only reads it.
create table public.permission (
  code text primary key,
  label_fr text not null,
  label_ar text not null,
  label_en text not null,
  group_code text not null,
  sensitive boolean not null default false,
  sort_order integer not null,
  constraint permission_code_ck check (code ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,2}$'),
  constraint permission_group_ck check (group_code in ('organization', 'access', 'employee', 'sensitive')),
  -- the sensitive fields (salary, bank, NSS, medical) are exactly the `sensitive` group
  constraint permission_sensitive_ck check (sensitive = (group_code = 'sensitive')),
  constraint permission_sort_order_uk unique (sort_order),
  constraint permission_labels_ck check (
    label_fr = btrim(label_fr) and label_fr <> ''
    and label_ar = btrim(label_ar) and label_ar <> ''
    and label_en = btrim(label_en) and label_en <> ''
  )
);

revoke all on table public.permission from hrforce_app;
grant select on table public.permission to hrforce_app;

-- sort_order is global and increases group by group (organization, access, employee, sensitive), so ordering by
-- sort_order alone yields "by group, then by sortOrder".
-- Arabic: الاطلاع على (consult), إنشاء (create), تعديل (edit), منح (grant), إدارة (manage); الهيكل التنظيمي (organisation),
-- الوحدات التنظيمية (org units), المواقع (sites), الصلاحيات (access rights), الأدوار (roles), الموظفين (employees),
-- الأجور (salaries), الحساب البنكي (bank account/RIB), رقم الضمان الاجتماعي (NSS), الوثائق الطبية (medical documents).
insert into public.permission (code, label_fr, label_ar, label_en, group_code, sensitive, sort_order) values
  ('org_unit.read', 'Consulter l''organisation', 'الاطلاع على الهيكل التنظيمي', 'View the organisation', 'organization', false, 110),
  ('org_unit.create', 'Créer des unités', 'إنشاء وحدات تنظيمية', 'Create org units', 'organization', false, 120),
  ('org_unit.update', 'Modifier des unités', 'تعديل الوحدات التنظيمية', 'Edit org units', 'organization', false, 130),
  ('site.read', 'Consulter les sites', 'الاطلاع على المواقع', 'View sites', 'organization', false, 140),
  ('site.create', 'Créer des sites', 'إنشاء مواقع', 'Create sites', 'organization', false, 150),
  ('access.read', 'Consulter les accès', 'الاطلاع على الصلاحيات', 'View access rights', 'access', false, 210),
  ('access.grant', 'Attribuer des accès', 'منح الصلاحيات', 'Grant access', 'access', false, 220),
  ('access.manage_roles', 'Gérer les rôles', 'إدارة الأدوار', 'Manage roles', 'access', false, 230),
  ('employee.read', 'Consulter les employés', 'الاطلاع على ملفات الموظفين', 'View employees', 'employee', false, 310),
  ('employee.create', 'Créer des employés', 'إضافة موظفين', 'Create employees', 'employee', false, 320),
  ('employee.update', 'Modifier des employés', 'تعديل ملفات الموظفين', 'Edit employees', 'employee', false, 330),
  ('employee.salary.read', 'Voir les salaires', 'الاطلاع على الأجور', 'View salaries', 'sensitive', true, 410),
  ('employee.bank.read', 'Voir les coordonnées bancaires (RIB)', 'الاطلاع على الحساب البنكي (RIB)', 'View bank details (RIB)', 'sensitive', true, 420),
  ('employee.nss.read', 'Voir le numéro de sécurité sociale (NSS)', 'الاطلاع على رقم الضمان الاجتماعي', 'View the social security number (NSS)', 'sensitive', true, 430),
  ('employee.medical.read', 'Voir les documents médicaux', 'الاطلاع على الوثائق الطبية', 'View medical documents', 'sensitive', true, 440);

-- ---------------------------------------------------------------------------------------------------------
create table public.role (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company (id),
  code text not null,
  name_fr text not null,
  name_ar text not null,
  name_en text not null,
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  -- unit-code alphabet, both cases (system role codes are lower snake_case, e.g. admin_rh_central)
  constraint role_code_ck check (code ~ '^[A-Za-z0-9][A-Za-z0-9_-]{1,31}$'),
  constraint role_names_ck check (
    name_fr = btrim(name_fr) and char_length(name_fr) between 1 and 120
    and name_ar = btrim(name_ar) and char_length(name_ar) between 1 and 120
    and name_en = btrim(name_en) and char_length(name_en) between 1 and 120
  ),
  -- target of the composite (company_id, role_id) foreign keys below
  constraint role_company_id_id_uk unique (company_id, id)
);

-- code unique per company, case-insensitively
create unique index role_company_code_uk on public.role (company_id, lower(code));

alter table public.role enable row level security;
alter table public.role force row level security;
create policy role_tenant_isolation on public.role
  using (company_id = current_setting('app.company_id', true)::uuid);

create function public.role_immutable_columns() returns trigger
  language plpgsql
as $$
begin
  if new.code is distinct from old.code or new.company_id is distinct from old.company_id or new.is_system is distinct from old.is_system then
    raise exception 'role.code, company_id and is_system are immutable' using errcode = 'check_violation', constraint = 'role_immutable';
  end if;
  return new;
end
$$;

create trigger role_immutable_columns_tg
  before update on public.role
  for each row execute function public.role_immutable_columns();

-- ---------------------------------------------------------------------------------------------------------
create table public.role_permission (
  company_id uuid not null,
  role_id uuid not null,
  permission_code text not null references public.permission (code),
  constraint role_permission_pk primary key (role_id, permission_code),
  constraint role_permission_role_fk foreign key (company_id, role_id) references public.role (company_id, id) on delete cascade
);

create index role_permission_company_role_idx on public.role_permission (company_id, role_id);
create index role_permission_code_idx on public.role_permission (permission_code);

alter table public.role_permission enable row level security;
alter table public.role_permission force row level security;
create policy role_permission_tenant_isolation on public.role_permission
  using (company_id = current_setting('app.company_id', true)::uuid);

-- ---------------------------------------------------------------------------------------------------------
create table public.role_grant (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company (id),
  -- no FK into auth (hrforce_app has no privilege there); membership is checked by the use case
  user_id uuid not null,
  role_id uuid not null,
  org_unit_id uuid not null,
  include_descendants boolean not null default true,
  valid_from date not null,
  valid_to date,
  valid daterange generated always as (daterange(valid_from, valid_to, '[)')) stored,
  granted_by uuid,
  granted_at timestamptz not null default now(),
  ended_by uuid,
  ended_at timestamptz,
  constraint role_grant_role_fk foreign key (company_id, role_id) references public.role (company_id, id),
  constraint role_grant_unit_fk foreign key (company_id, org_unit_id) references public.org_unit (company_id, id),
  -- [from, to): to may equal from (a grant ended on its first day: never effective), never before it
  constraint role_grant_dates_ck check (valid_to is null or valid_to >= valid_from),
  -- separation of duties, also at the database level: nobody grants to / ends grants of themselves
  constraint role_grant_not_self_granted_ck check (granted_by is null or granted_by <> user_id),
  constraint role_grant_not_self_ended_ck check (ended_by is null or ended_by <> user_id),
  constraint role_grant_ended_ck check (ended_by is null or ended_at is not null),
  -- the same role on the same unit for the same user never overlaps in time (a duplicate grant adds nothing)
  constraint role_grant_no_overlap_ex exclude using gist (
    company_id with =, user_id with =, role_id with =, org_unit_id with =, valid with &&
  )
);

create index role_grant_company_user_idx on public.role_grant (company_id, user_id);
create index role_grant_org_unit_idx on public.role_grant (org_unit_id);
create index role_grant_company_role_idx on public.role_grant (company_id, role_id);
create index role_grant_company_unit_idx on public.role_grant (company_id, org_unit_id);

alter table public.role_grant enable row level security;
alter table public.role_grant force row level security;
create policy role_grant_tenant_isolation on public.role_grant
  using (company_id = current_setting('app.company_id', true)::uuid);

-- A grant's identity and start are immutable; ending it may only move valid_to earlier (or close an open grant).
create function public.role_grant_guard() returns trigger
  language plpgsql
as $$
begin
  if new.company_id is distinct from old.company_id or new.user_id is distinct from old.user_id
     or new.role_id is distinct from old.role_id or new.org_unit_id is distinct from old.org_unit_id
     or new.include_descendants is distinct from old.include_descendants or new.valid_from is distinct from old.valid_from
     or new.granted_by is distinct from old.granted_by or new.granted_at is distinct from old.granted_at then
    raise exception 'role_grant: only valid_to, ended_by and ended_at may change' using errcode = 'check_violation', constraint = 'role_grant_immutable';
  end if;
  if old.valid_to is not null and (new.valid_to is null or new.valid_to > old.valid_to) then
    raise exception 'role_grant: a grant can only be shortened' using errcode = 'check_violation', constraint = 'role_grant_only_shortened';
  end if;
  return new;
end
$$;

create trigger role_grant_guard_tg
  before update on public.role_grant
  for each row execute function public.role_grant_guard();

-- Roles and grants are never deleted by the app (grants end; roles stay referenced by their grants' history).
revoke delete on table public.role, public.role_grant from hrforce_app;

-- ---------------------------------------------------------------------------------------------------------
-- Members of ONE company, for the access screens. The caller passes the tenant it runs under; any other value is
-- refused (the function bypasses RLS as its owner, so it re-checks the tenant itself).
create function auth.company_members(p_company_id uuid)
  returns table (user_id uuid, email text, display_name text, locale text, status text)
  language plpgsql
  stable
  security definer
  set search_path = pg_catalog, auth
as $$
#variable_conflict use_column
begin
  if p_company_id is null
     or p_company_id is distinct from nullif(current_setting('app.company_id', true), '')::uuid then
    raise exception 'auth.company_members: % is not the current tenant', p_company_id using errcode = 'insufficient_privilege';
  end if;
  return query
    select u.id, u.email, u.display_name, u.locale, u.status
      from auth.user_account u
      join auth.user_company m on m.user_id = u.id
     where m.company_id = p_company_id
     order by u.display_name, u.email;
end
$$;

revoke all on function auth.company_members(uuid) from public;
grant execute on function auth.company_members(uuid) to hrforce_app;
