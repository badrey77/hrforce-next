-- 0003: minimal organisation unit; the reference example of a tenant-scoped business table.
create table public.org_unit (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company (id),
  code text not null,
  name text not null,
  created_at timestamptz not null default now(),
  constraint org_unit_company_code_uk unique (company_id, code)
);

create index org_unit_company_id_idx on public.org_unit (company_id);

alter table public.org_unit enable row level security;
alter table public.org_unit force row level security;
create policy org_unit_tenant_isolation on public.org_unit
  using (company_id = current_setting('app.company_id', true)::uuid);
