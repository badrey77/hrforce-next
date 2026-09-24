-- Fixture: every other way to get tenancy wrong.
create table if not exists nullable_company (company_id uuid);

create table public.text_company (company_id text not null);
alter table public.text_company enable row level security;
alter table public.text_company force row level security;
create policy text_company_isolation on public.text_company using (company_id = current_setting('app.company_id', true));

create table public.not_forced (company_id uuid not null);
alter table public.not_forced enable row level security;
create policy not_forced_isolation on public.not_forced using (company_id = current_setting('app.company_id', true)::uuid);

create table public.wrong_policy (company_id uuid not null);
alter table public.wrong_policy enable row level security;
alter table public.wrong_policy force row level security;
create policy wrong_policy_all on public.wrong_policy using (true);
