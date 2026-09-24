-- 0002: the tenant table. Exempt from company_id (it IS the tenant); see tools/guardrails/company-id-exempt.json.
create table public.company (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  name text not null,
  created_at timestamptz not null default now(),
  constraint company_code_uk unique (code),
  -- the nil UUID is the "no tenant" value of app.company_id and must never identify a company
  constraint company_id_not_nil_ck check (id <> '00000000-0000-0000-0000-000000000000'::uuid)
);

-- A tenant session can only see its own company row.
alter table public.company enable row level security;
alter table public.company force row level security;
create policy company_tenant_isolation on public.company
  using (id = current_setting('app.company_id', true)::uuid);
