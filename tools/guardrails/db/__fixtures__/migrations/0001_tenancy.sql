-- Fixture for tools/guardrails/db/catalog.spec.ts — NOT a real migration.
create table public.company (id uuid primary key default gen_random_uuid());
alter table public.company enable row level security;
alter table public.company force row level security;
create policy company_isolation on public.company using (id = current_setting('app.company_id', true)::uuid);

-- compliant tenant table
create table public.good_tenant (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company (id)
);
alter table public.good_tenant enable row level security;
alter table public.good_tenant force row level security;
create policy good_tenant_isolation on public.good_tenant using (company_id = current_setting('app.company_id', true)::uuid);

-- violation: no company_id (and no RLS)
create table public.no_company (id int primary key);
