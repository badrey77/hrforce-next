-- 0006: organisation model v2 (docs/contracts/organization.md v2, confirmed by the business).
--   org_unit_kind         global catalogue of unit kinds (labels fr/ar/en, sort order, root flag)
--   org_unit_kind_parent  which kind may sit under which kind
--   site                  tenant table: places that host units (not nodes of the tree)
--   org_unit              kind → FK to the catalogue; axis 'geo' → 'management'; one root unit per company
--   org_unit_version      + site_id (date-effective, null = inherited from the nearest ancestor)
--
-- The v1 kinds (company / region / site) cannot be mapped onto the v2 tree (a v1 "site" is now a place, not a
-- unit; departments do not exist in v1). The project is pre-production: refuse to run on a database that holds
-- org units and ask for a fresh database instead of inventing data.
do $$
begin
  if exists (select 1 from public.org_unit) then
    raise exception 'org_unit holds v1 organisation rows (kinds company/region/site) that cannot be mapped to the v2 model. '
      'Pre-production: drop and recreate the database, then run `npm run migrate` and `npm run seed:dev` (-w @hrforce/api); '
      'see apps/api/README.md.';
  end if;
end
$$;

-- ---------------------------------------------------------------------------------------------------------
-- Kind catalogue: reference data shared by every tenant (exempt from company_id, see
-- tools/guardrails/company-id-exempt.json). Seeded here; the app only reads it.
create table public.org_unit_kind (
  code text primary key,
  label_fr text not null,
  label_ar text not null,
  label_en text not null,
  sort_order integer not null,
  is_root boolean not null default false,
  constraint org_unit_kind_code_ck check (code ~ '^[a-z][a-z0-9_]{1,31}$'),
  constraint org_unit_kind_sort_order_uk unique (sort_order),
  -- target of org_unit's (kind, is_root) foreign key
  constraint org_unit_kind_code_is_root_uk unique (code, is_root),
  constraint org_unit_kind_labels_ck check (
    label_fr = btrim(label_fr) and label_fr <> ''
    and label_ar = btrim(label_ar) and label_ar <> ''
    and label_en = btrim(label_en) and label_en <> ''
  )
);

-- Exactly one root kind in the catalogue.
create unique index org_unit_kind_one_root_uk on public.org_unit_kind ((true)) where is_root;

create table public.org_unit_kind_parent (
  kind text not null references public.org_unit_kind (code),
  parent_kind text not null references public.org_unit_kind (code),
  constraint org_unit_kind_parent_pk primary key (kind, parent_kind),
  constraint org_unit_kind_parent_not_self_ck check (kind <> parent_kind)
);

-- Reference data: read-only for the app (0001's default privileges granted it DML on new tables).
revoke all on table public.org_unit_kind, public.org_unit_kind_parent from hrforce_app;
grant select on table public.org_unit_kind, public.org_unit_kind_parent to hrforce_app;

-- Arabic labels follow the usual Algerian administrative/corporate usage:
--   المديرية العامة (Direction Générale), دائرة (Département, e.g. دائرة الموارد البشرية),
--   منطقة (Région), وكالة (Agence), مصلحة (Service).
insert into public.org_unit_kind (code, label_fr, label_ar, label_en, sort_order, is_root) values
  ('direction_generale', 'Direction Générale', 'المديرية العامة', 'General Management', 10, true),
  ('department', 'Département', 'دائرة', 'Department', 20, false),
  ('region', 'Région', 'منطقة', 'Region', 30, false),
  ('agency', 'Agence', 'وكالة', 'Agency', 40, false),
  ('service', 'Service', 'مصلحة', 'Service', 50, false);

insert into public.org_unit_kind_parent (kind, parent_kind) values
  ('department', 'direction_generale'),
  ('region', 'department'),
  ('agency', 'region'),
  ('service', 'department'),
  ('service', 'region'),
  ('service', 'agency');

-- ---------------------------------------------------------------------------------------------------------
-- Sites: places (tenant data). code is unique per company and immutable.
create table public.site (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company (id),
  code text not null,
  name text not null,
  wilaya text not null,
  address text,
  created_at timestamptz not null default now(),
  constraint site_company_code_uk unique (company_id, code),
  -- target of the composite (company_id, site_id) foreign key of org_unit_version
  constraint site_company_id_id_uk unique (company_id, id),
  constraint site_code_ck check (code ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'),
  constraint site_name_ck check (name = btrim(name) and char_length(name) between 1 and 120),
  constraint site_wilaya_ck check (wilaya = btrim(wilaya) and char_length(wilaya) between 1 and 60),
  constraint site_address_ck check (address is null or (address = btrim(address) and char_length(address) between 1 and 300))
);

alter table public.site enable row level security;
alter table public.site force row level security;
create policy site_tenant_isolation on public.site
  using (company_id = current_setting('app.company_id', true)::uuid);

create function public.site_immutable_columns() returns trigger
  language plpgsql
as $$
begin
  if new.code is distinct from old.code or new.company_id is distinct from old.company_id then
    raise exception 'site.code and company_id are immutable' using errcode = 'check_violation', constraint = 'site_code_immutable';
  end if;
  return new;
end
$$;

create trigger site_immutable_columns_tg
  before update on public.site
  for each row execute function public.site_immutable_columns();

-- ---------------------------------------------------------------------------------------------------------
-- org_unit: kind is a catalogue code; one root unit per company, keyed on the catalogue's root kind.
-- The table is empty (checked above), so no data has to be rewritten and the immutability trigger of 0005
-- (update-only) is not involved.
drop index public.org_unit_one_company_root_uk;
alter table public.org_unit
  drop constraint org_unit_kind_ck,
  drop constraint org_unit_axis_ck;
alter table public.org_unit
  alter column axis set default 'management',
  add constraint org_unit_axis_ck check (axis in ('management')),
  -- Copy of org_unit_kind.is_root, kept honest by the composite FK (filled by the trigger below) so that the
  -- "one root per company" rule is a plain partial unique index — race-free, no cross-table trigger logic.
  add column is_root boolean not null default false,
  add constraint org_unit_kind_fk foreign key (kind, is_root) references public.org_unit_kind (code, is_root);

create unique index org_unit_one_root_uk on public.org_unit (company_id) where is_root;

create function public.org_unit_fill_is_root() returns trigger
  language plpgsql
as $$
begin
  new.is_root := coalesce((select k.is_root from public.org_unit_kind k where k.code = new.kind), false);
  return new;
end
$$;

create trigger org_unit_fill_is_root_tg
  before insert on public.org_unit
  for each row execute function public.org_unit_fill_is_root();

-- ---------------------------------------------------------------------------------------------------------
-- org_unit_version: own site of the version (null = inherited from the nearest ancestor). The composite FK keeps
-- it inside the unit's company.
alter table public.org_unit_version
  add column site_id uuid,
  add constraint org_unit_version_site_fk foreign key (company_id, site_id) references public.site (company_id, id);

create index org_unit_version_site_idx on public.org_unit_version (company_id, site_id) where site_id is not null;
