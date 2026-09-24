-- Fixture: audit-per-write.
create function public.audit_row_change() returns trigger language plpgsql as $$
begin
  return coalesce(new, old);
end
$$;

create table public.audited_ok ( -- @audited
  company_id uuid not null
);
alter table public.audited_ok enable row level security;
alter table public.audited_ok force row level security;
create policy audited_ok_isolation on public.audited_ok using (company_id = current_setting('app.company_id', true)::uuid);
create trigger audited_ok_audit after insert or update or delete on public.audited_ok
  for each row execute function public.audit_row_change();

CREATE TABLE audited_missing (company_id uuid NOT NULL); -- @audited
alter table public.audited_missing enable row level security;
alter table public.audited_missing force row level security;
create policy audited_missing_isolation on public.audited_missing using (company_id = current_setting('app.company_id', true)::uuid);

-- a marker that is not on a CREATE TABLE line: -- @audited
