-- Fixture: audit-per-write (every tenant table has an audit% trigger AFTER INSERT OR UPDATE OR DELETE FOR EACH ROW).
create function public.audit_row_change() returns trigger language plpgsql as $$
begin
  return null;
end
$$;

create table public.audited_ok (
  company_id uuid not null
);
alter table public.audited_ok enable row level security;
alter table public.audited_ok force row level security;
create policy audited_ok_isolation on public.audited_ok using (company_id = current_setting('app.company_id', true)::uuid);
create trigger audit_capture_tg after insert or update or delete on public.audited_ok
  for each row execute function public.audit_row_change();

-- violation: only a non-audit trigger
CREATE TABLE audited_missing (company_id uuid NOT NULL);
alter table public.audited_missing enable row level security;
alter table public.audited_missing force row level security;
create policy audited_missing_isolation on public.audited_missing using (company_id = current_setting('app.company_id', true)::uuid);
create trigger touch_tg after update on public.audited_missing
  for each row execute function public.audit_row_change();

-- violation: an audit% trigger that misses UPDATE/DELETE
create table public.audited_partial (company_id uuid not null);
alter table public.audited_partial enable row level security;
alter table public.audited_partial force row level security;
create policy audited_partial_isolation on public.audited_partial using (company_id = current_setting('app.company_id', true)::uuid);
create trigger audit_partial_tg after insert on public.audited_partial
  for each row execute function public.audit_row_change();

-- exempt (derived data) in the spec's exemption list
create table public.derived (company_id uuid not null);
alter table public.derived enable row level security;
alter table public.derived force row level security;
create policy derived_isolation on public.derived using (company_id = current_setting('app.company_id', true)::uuid);
