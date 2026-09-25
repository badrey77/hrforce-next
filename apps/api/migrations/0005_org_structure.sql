-- 0005: organisation structure (docs/contracts/organization.md, ADR 002).
--   org_unit          identity of a unit: kind, axis, immutable code
--   org_unit_version  date-effective name + parent, non-overlapping `valid` [from, to) ranges per unit
--   org_unit_closure  ancestor/descendant pairs (incl. depth-0 self rows) of the tree AS OF TODAY
-- Every table carries company_id; references include company_id (composite FKs) so a row can never point at
-- another tenant's unit, even for a role that bypasses RLS.

-- 0003 created org_unit without kind / versions and no code path ever wrote to it outside tests; refuse to
-- guess a kind/parent for pre-existing rows rather than invent data.
do $$
begin
  if exists (select 1 from public.org_unit) then
    raise exception 'org_unit already has rows: migrate them to kind + org_unit_version by hand before 0005';
  end if;
end
$$;

-- ---------------------------------------------------------------------------------------------------------
-- org_unit: name moves to org_unit_version (it is date-effective).
alter table public.org_unit drop column name;
alter table public.org_unit
  add column kind text not null,
  add column axis text not null default 'geo',
  add constraint org_unit_kind_ck check (kind in ('company', 'region', 'site')),
  add constraint org_unit_axis_ck check (axis in ('geo')),
  add constraint org_unit_code_ck check (code ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'),
  -- target of the composite (company_id, id) foreign keys below
  add constraint org_unit_company_id_id_uk unique (company_id, id);

-- Exactly one root: at most one company-kind unit per company (the app creates it with the company).
create unique index org_unit_one_company_root_uk on public.org_unit (company_id) where kind = 'company';

-- code, kind, axis and company_id are immutable once created.
create function public.org_unit_immutable_columns() returns trigger
  language plpgsql
as $$
begin
  if new.code is distinct from old.code then
    raise exception 'org_unit.code is immutable' using errcode = 'check_violation', constraint = 'org_unit_code_immutable';
  end if;
  if new.kind is distinct from old.kind or new.axis is distinct from old.axis or new.company_id is distinct from old.company_id then
    raise exception 'org_unit.kind, axis and company_id are immutable' using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger org_unit_immutable_columns_tg
  before update on public.org_unit
  for each row execute function public.org_unit_immutable_columns();

-- ---------------------------------------------------------------------------------------------------------
-- Accent/case-insensitive search key. unaccent is not a trusted extension, so a fixed translate() of the Latin
-- accented letters used in French (+ common neighbours) followed by lower(). IMMUTABLE so it can back a
-- generated column; the app applies the same function to the query text.
create function public.search_normalize(value text) returns text
  language sql
  immutable
  strict
  parallel safe
return lower(translate(value,
  'ÀÁÂÃÄÅàáâãäåÇçÈÉÊËèéêëÌÍÎÏìíîïÑñÒÓÔÕÖØòóôõöøÙÚÛÜùúûüÝýÿ',
  'AAAAAAaaaaaaCcEEEEeeeeIIIIiiiiNnOOOOOOooooooUUUUuuuuYyy'));

-- ---------------------------------------------------------------------------------------------------------
create table public.org_unit_version (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  org_unit_id uuid not null,
  name text not null,
  parent_id uuid,
  valid daterange not null,
  name_search text generated always as (public.search_normalize(name)) stored,
  created_at timestamptz not null default now(),
  constraint org_unit_version_unit_fk foreign key (company_id, org_unit_id) references public.org_unit (company_id, id),
  constraint org_unit_version_parent_fk foreign key (company_id, parent_id) references public.org_unit (company_id, id),
  constraint org_unit_version_name_ck check (name = btrim(name) and char_length(name) between 1 and 120),
  constraint org_unit_version_not_own_parent_ck check (parent_id is null or parent_id <> org_unit_id),
  -- [from, to): a real start date, exclusive (or open) end, never empty
  constraint org_unit_version_valid_ck check (
    not isempty(valid) and lower(valid) is not null and lower_inc(valid) and not upper_inc(valid)
  ),
  constraint org_unit_version_no_overlap_ex exclude using gist (org_unit_id with =, valid with &&)
);

create index org_unit_version_unit_idx on public.org_unit_version (company_id, org_unit_id);
create index org_unit_version_parent_idx on public.org_unit_version (company_id, parent_id) where parent_id is not null;
create index org_unit_version_valid_idx on public.org_unit_version using gist (company_id, valid);

alter table public.org_unit_version enable row level security;
alter table public.org_unit_version force row level security;
create policy org_unit_version_tenant_isolation on public.org_unit_version
  using (company_id = current_setting('app.company_id', true)::uuid);

-- ---------------------------------------------------------------------------------------------------------
create table public.org_unit_closure (
  company_id uuid not null,
  ancestor_id uuid not null,
  descendant_id uuid not null,
  depth integer not null,
  constraint org_unit_closure_pk primary key (ancestor_id, descendant_id),
  constraint org_unit_closure_ancestor_fk foreign key (company_id, ancestor_id) references public.org_unit (company_id, id),
  constraint org_unit_closure_descendant_fk foreign key (company_id, descendant_id) references public.org_unit (company_id, id),
  constraint org_unit_closure_depth_ck check (depth >= 0 and ((depth = 0) = (ancestor_id = descendant_id)))
);

create index org_unit_closure_ancestor_idx on public.org_unit_closure (company_id, ancestor_id);
create index org_unit_closure_descendant_idx on public.org_unit_closure (company_id, descendant_id);

alter table public.org_unit_closure enable row level security;
alter table public.org_unit_closure force row level security;
create policy org_unit_closure_tenant_isolation on public.org_unit_closure
  using (company_id = current_setting('app.company_id', true)::uuid);
