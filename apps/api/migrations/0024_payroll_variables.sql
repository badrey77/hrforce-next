-- 0024: Payroll variables — monthly closing and export to the payroll software (docs/contracts/payroll-variables.md).
--   payroll_policy          the closing calendar and the export file format per company (a company without a row uses
--                           the column defaults); never deleted (a reset writes the defaults)
--   payroll_rubrique        the pay items: one per computed source (one per leave type for `leave`) plus the items HR
--                           types by hand (`manual`); every code is data (placeholders until the PC-PAIE codes are known);
--                           deactivated, never deleted
--   payroll_employee_code   the « matricule paie » of an employment when it differs from the HRForce matricule
--   payroll_period          a month (first day) and its status; created on first write or close
--   payroll_adjustment      HR's value for one line of an open month (employee × rubrique × origin month); for a manual
--                           rubrique the adjustment IS the value; refused by the database while the month is closed
--   payroll_closing         one closing of a month (version 1, 2, … after reopenings); only the reopen columns change
--   payroll_line            the snapshot written at close: append-only, zero values not stored (but HR's 0 over a
--                           computed value)
-- Also: permission group `payroll`, five permissions and their system-role grants, `payroll.close` in the two-step
-- sign-in defaults and appended once to every existing policy, and the computed rubriques of every existing company
-- (new companies: seedPayrollDefaults, called by bootstrap and seed:dev).

-- ---------------------------------------------------------------------------------------------------------
-- Permissions and their system-role grants; closing needs two-step sign-in (as document.design).
alter table public.permission drop constraint permission_group_ck;
alter table public.permission
  add constraint permission_group_ck check (group_code in ('organization', 'access', 'employee', 'leave', 'documents', 'attendance', 'sso', 'recruitment', 'settings', 'deadlines', 'payroll', 'sensitive'));

insert into public.permission (code, label_fr, label_ar, label_en, group_code, sensitive, sort_order) values
  ('payroll.read', 'Consulter les variables de paie', 'الاطلاع على متغيرات الأجر', 'View payroll variables', 'payroll', false, 1210),
  ('payroll.prepare', 'Préparer les variables de paie', 'إعداد متغيرات الأجر', 'Prepare payroll variables', 'payroll', false, 1220),
  ('payroll.export', 'Exporter le fichier de paie', 'تصدير ملف الأجور', 'Export the payroll file', 'payroll', false, 1230),
  ('payroll.close', 'Clôturer la paie', 'إقفال الأجور', 'Close payroll', 'payroll', false, 1240),
  ('payroll.configure', 'Paramétrer la paie', 'إعداد الأجور', 'Configure payroll', 'payroll', false, 1250);

insert into public.role_permission (company_id, role_id, permission_code)
select r.company_id, r.id, p.code
  from public.role r
  cross join (values ('payroll.read'), ('payroll.prepare'), ('payroll.export')) as p (code)
 where r.is_system and r.code in ('admin_rh_central', 'rh_regional')
on conflict (role_id, permission_code) do nothing;

insert into public.role_permission (company_id, role_id, permission_code)
select r.company_id, r.id, p.code
  from public.role r
  cross join (values ('payroll.close'), ('payroll.configure')) as p (code)
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
                    'settings.branding', 'document.design', 'payroll.close')
$$;

update public.security_policy
   set mfa_required_permissions = array_append(mfa_required_permissions, 'payroll.close')
 where not ('payroll.close' = any (mfa_required_permissions));

-- ---------------------------------------------------------------------------------------------------------
create table public.payroll_policy (
  company_id uuid primary key references public.company (id),
  -- the day of the month from which the month may be closed
  cutoff_day integer not null default 20,
  regularization_months integer not null default 3,
  overtime_min_minutes integer not null default 30,
  layout text not null default 'per_line',
  separator text not null default 'semicolon',
  decimal_separator text not null default 'comma',
  encoding text not null default 'windows1252',
  header_row boolean not null default true,
  -- the file's columns in order (per_employee: the identity columns; the rubrique columns follow)
  columns text[] not null default '{matricule,rubrique,value,period}',
  period_format text not null default 'mm_yyyy',
  file_extension text not null default 'csv',
  updated_at timestamptz not null default now(),
  constraint payroll_policy_ranges_ck check (
    cutoff_day between 1 and 28
    and regularization_months between 0 and 12
    and overtime_min_minutes between 0 and 240
  ),
  constraint payroll_policy_layout_ck check (layout in ('per_line', 'per_employee')),
  constraint payroll_policy_separator_ck check (separator in ('semicolon', 'comma', 'tab', 'pipe')),
  constraint payroll_policy_decimal_ck check (decimal_separator in ('comma', 'dot')),
  constraint payroll_policy_encoding_ck check (encoding in ('windows1252', 'utf8', 'utf8_bom')),
  constraint payroll_policy_period_format_ck check (period_format in ('mm_yyyy', 'yyyymm', 'yyyy_mm')),
  constraint payroll_policy_extension_ck check (file_extension in ('csv', 'txt')),
  -- distinct columns are checked by the API (a check constraint cannot compare array elements)
  constraint payroll_policy_columns_ck check (
    cardinality(columns) between 1 and 10
    and array_position(columns, null) is null
    and 'matricule' = any (columns)
    and case layout
          when 'per_line' then columns <@ array['matricule', 'last_name', 'first_name', 'rubrique', 'label', 'value', 'unit', 'period', 'origin_period', 'unit_code']
                               and 'rubrique' = any (columns) and 'value' = any (columns)
          else columns <@ array['matricule', 'last_name', 'first_name', 'unit_code', 'period', 'origin_period']
        end
  )
);

alter table public.payroll_policy enable row level security;
alter table public.payroll_policy force row level security;
create policy payroll_policy_tenant_isolation on public.payroll_policy
  using (company_id = current_setting('app.company_id', true)::uuid);

-- ---------------------------------------------------------------------------------------------------------
create table public.payroll_rubrique (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company (id),
  source text not null,
  -- source `leave` only: the leave type whose approved days this rubrique counts
  leave_type_id uuid,
  export_code text not null,
  name_fr text not null,
  name_ar text not null,
  name_en text not null,
  unit text not null,
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  constraint payroll_rubrique_company_id_id_uk unique (company_id, id),
  constraint payroll_rubrique_leave_type_uk unique (company_id, leave_type_id),
  constraint payroll_rubrique_leave_type_fk foreign key (company_id, leave_type_id) references public.leave_type (company_id, id),
  constraint payroll_rubrique_source_ck check (source in ('leave', 'absence', 'late', 'overtime_normal', 'overtime_rest_day', 'overtime_holiday', 'service_days', 'manual')),
  constraint payroll_rubrique_leave_ck check ((source = 'leave') = (leave_type_id is not null)),
  constraint payroll_rubrique_code_ck check (char_length(export_code) between 1 and 20 and export_code ~ '^[A-Za-z0-9_.\-]+$'),
  constraint payroll_rubrique_names_ck check (
    name_fr = btrim(name_fr) and char_length(name_fr) between 1 and 80
    and name_ar = btrim(name_ar) and char_length(name_ar) between 1 and 80
    and name_en = btrim(name_en) and char_length(name_en) between 1 and 80
  ),
  constraint payroll_rubrique_unit_ck check (unit in ('days', 'hours', 'amount')),
  -- computed sources have a fixed unit; amounts are typed by hand only
  constraint payroll_rubrique_source_unit_ck check (
    source = 'manual'
    or (source in ('leave', 'absence', 'service_days') and unit = 'days')
    or (source in ('late', 'overtime_normal', 'overtime_rest_day', 'overtime_holiday') and unit = 'hours')
  ),
  constraint payroll_rubrique_sort_ck check (sort_order between 0 and 100000)
);

-- one rubrique per computed non-leave source
create unique index payroll_rubrique_source_uk on public.payroll_rubrique (company_id, source) where source not in ('leave', 'manual');
-- export codes are unique (case-insensitive) among the active rubriques
create unique index payroll_rubrique_code_uk on public.payroll_rubrique (company_id, upper(export_code)) where active;

alter table public.payroll_rubrique enable row level security;
alter table public.payroll_rubrique force row level security;
create policy payroll_rubrique_tenant_isolation on public.payroll_rubrique
  using (company_id = current_setting('app.company_id', true)::uuid);

-- what a rubrique counts never changes (codes, names, unit of a manual rubrique, active and order do)
create function public.payroll_rubrique_guard() returns trigger
  language plpgsql
as $$
begin
  if new.id is distinct from old.id or new.company_id is distinct from old.company_id
     or new.source is distinct from old.source or new.leave_type_id is distinct from old.leave_type_id
     or new.created_at is distinct from old.created_at then
    raise exception 'payroll_rubrique %: identity columns never change', old.id
      using errcode = 'check_violation', constraint = 'payroll_rubrique_immutable';
  end if;
  return new;
end
$$;

create trigger payroll_rubrique_guard_tg
  before update on public.payroll_rubrique
  for each row execute function public.payroll_rubrique_guard();

-- ---------------------------------------------------------------------------------------------------------
create table public.payroll_employee_code (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company (id),
  employment_id uuid not null,
  code text not null,
  -- auth.user_account id, without FK (hrforce_app has no privilege on auth.*)
  updated_by uuid not null,
  updated_at timestamptz not null default now(),
  constraint payroll_employee_code_company_id_id_uk unique (company_id, id),
  constraint payroll_employee_code_employment_uk unique (company_id, employment_id),
  constraint payroll_employee_code_employment_fk foreign key (company_id, employment_id) references public.employment (company_id, id),
  constraint payroll_employee_code_code_ck check (char_length(code) between 1 and 20 and code ~ '^[A-Za-z0-9_.\-]+$')
);

create unique index payroll_employee_code_code_uk on public.payroll_employee_code (company_id, upper(code));

alter table public.payroll_employee_code enable row level security;
alter table public.payroll_employee_code force row level security;
create policy payroll_employee_code_tenant_isolation on public.payroll_employee_code
  using (company_id = current_setting('app.company_id', true)::uuid);

-- ---------------------------------------------------------------------------------------------------------
create table public.payroll_period (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company (id),
  month date not null,
  status text not null default 'open',
  created_at timestamptz not null default now(),
  constraint payroll_period_company_id_id_uk unique (company_id, id),
  constraint payroll_period_month_uk unique (company_id, month),
  constraint payroll_period_month_ck check (extract(day from month) = 1),
  constraint payroll_period_status_ck check (status in ('open', 'closed'))
);

alter table public.payroll_period enable row level security;
alter table public.payroll_period force row level security;
create policy payroll_period_tenant_isolation on public.payroll_period
  using (company_id = current_setting('app.company_id', true)::uuid);

create function public.payroll_period_guard() returns trigger
  language plpgsql
as $$
begin
  if new.id is distinct from old.id or new.company_id is distinct from old.company_id
     or new.month is distinct from old.month or new.created_at is distinct from old.created_at then
    raise exception 'payroll_period %: identity columns never change', old.id
      using errcode = 'check_violation', constraint = 'payroll_period_immutable';
  end if;
  return new;
end
$$;

create trigger payroll_period_guard_tg
  before update on public.payroll_period
  for each row execute function public.payroll_period_guard();

-- ---------------------------------------------------------------------------------------------------------
create table public.payroll_adjustment (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company (id),
  month date not null,
  -- = month, or an earlier closed month for a régularisation line
  origin_month date not null,
  employment_id uuid not null,
  rubrique_id uuid not null,
  value numeric(12, 2) not null,
  note text,
  updated_by uuid not null,
  updated_at timestamptz not null default now(),
  constraint payroll_adjustment_company_id_id_uk unique (company_id, id),
  constraint payroll_adjustment_line_uk unique (company_id, month, origin_month, employment_id, rubrique_id),
  constraint payroll_adjustment_employment_fk foreign key (company_id, employment_id) references public.employment (company_id, id),
  constraint payroll_adjustment_rubrique_fk foreign key (company_id, rubrique_id) references public.payroll_rubrique (company_id, id),
  constraint payroll_adjustment_month_ck check (extract(day from month) = 1 and extract(day from origin_month) = 1 and origin_month <= month),
  constraint payroll_adjustment_value_ck check (value between -999999999.99 and 999999999.99),
  constraint payroll_adjustment_note_ck check (note is null or (note = btrim(note) and char_length(note) between 1 and 300))
);

create index payroll_adjustment_employment_idx on public.payroll_adjustment (company_id, employment_id, month);

alter table public.payroll_adjustment enable row level security;
alter table public.payroll_adjustment force row level security;
create policy payroll_adjustment_tenant_isolation on public.payroll_adjustment
  using (company_id = current_setting('app.company_id', true)::uuid);

-- the adjustments of a closed month never change (the API answers 409 payroll-period-closed first; this is the
-- race-free backstop: closing updates the period row, which this trigger reads)
create function public.payroll_adjustment_guard() returns trigger
  language plpgsql
as $$
begin
  if tg_op <> 'INSERT' and exists (select 1 from public.payroll_period p
              where p.company_id = old.company_id and p.month = old.month and p.status = 'closed') then
    raise exception 'payroll_adjustment: month % is closed', old.month
      using errcode = 'check_violation', constraint = 'payroll_adjustment_period_closed';
  end if;
  if tg_op <> 'DELETE' and exists (select 1 from public.payroll_period p
              where p.company_id = new.company_id and p.month = new.month and p.status = 'closed') then
    raise exception 'payroll_adjustment: month % is closed', new.month
      using errcode = 'check_violation', constraint = 'payroll_adjustment_period_closed';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$$;

create trigger payroll_adjustment_guard_tg
  before insert or update or delete on public.payroll_adjustment
  for each row execute function public.payroll_adjustment_guard();

-- ---------------------------------------------------------------------------------------------------------
create table public.payroll_closing (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company (id),
  period_id uuid not null,
  version integer not null,
  closed_by uuid not null,
  closed_at timestamptz not null default now(),
  reopened_by uuid,
  reopened_at timestamptz,
  reopen_reason text,
  lines integer not null,
  employees integer not null,
  constraint payroll_closing_company_id_id_uk unique (company_id, id),
  constraint payroll_closing_version_uk unique (company_id, period_id, version),
  constraint payroll_closing_period_fk foreign key (company_id, period_id) references public.payroll_period (company_id, id),
  constraint payroll_closing_version_ck check (version >= 1),
  constraint payroll_closing_counts_ck check (lines >= 0 and employees >= 0),
  constraint payroll_closing_reopen_ck check (
    (reopened_at is null and reopened_by is null and reopen_reason is null)
    or (reopened_at is not null and reopened_by is not null and reopen_reason is not null
        and reopen_reason = btrim(reopen_reason) and char_length(reopen_reason) between 5 and 300)
  )
);

-- at most one current (not reopened) closing per month
create unique index payroll_closing_current_uk on public.payroll_closing (company_id, period_id) where reopened_at is null;

alter table public.payroll_closing enable row level security;
alter table public.payroll_closing force row level security;
create policy payroll_closing_tenant_isolation on public.payroll_closing
  using (company_id = current_setting('app.company_id', true)::uuid);

-- a closing is a record: only a reopening (once) may be added to it
create function public.payroll_closing_guard() returns trigger
  language plpgsql
as $$
begin
  if new.id is distinct from old.id or new.company_id is distinct from old.company_id
     or new.period_id is distinct from old.period_id or new.version is distinct from old.version
     or new.closed_by is distinct from old.closed_by or new.closed_at is distinct from old.closed_at
     or new.lines is distinct from old.lines or new.employees is distinct from old.employees
     or old.reopened_at is not null then
    raise exception 'payroll_closing %: only a reopening may be recorded, once', old.id
      using errcode = 'check_violation', constraint = 'payroll_closing_immutable';
  end if;
  return new;
end
$$;

create trigger payroll_closing_guard_tg
  before update on public.payroll_closing
  for each row execute function public.payroll_closing_guard();

-- ---------------------------------------------------------------------------------------------------------
create table public.payroll_line (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company (id),
  closing_id uuid not null,
  employment_id uuid not null,
  rubrique_id uuid not null,
  origin_month date not null,
  -- null for a manual rubrique
  computed_value numeric(12, 2),
  value numeric(12, 2) not null,
  adjusted boolean not null,
  note text,
  -- snapshot at close: what the file prints
  export_code text not null,
  unit text not null,
  matricule text not null,
  last_name text not null,
  first_name text not null,
  unit_code text,
  constraint payroll_line_company_id_id_uk unique (company_id, id),
  constraint payroll_line_uk unique (company_id, closing_id, employment_id, rubrique_id, origin_month),
  constraint payroll_line_closing_fk foreign key (company_id, closing_id) references public.payroll_closing (company_id, id),
  constraint payroll_line_employment_fk foreign key (company_id, employment_id) references public.employment (company_id, id),
  constraint payroll_line_rubrique_fk foreign key (company_id, rubrique_id) references public.payroll_rubrique (company_id, id),
  constraint payroll_line_month_ck check (extract(day from origin_month) = 1),
  -- zero values are not stored, except HR's 0 over a non-zero computed value (régularisations must know HR overrode it;
  -- the file and the views leave such a line out)
  constraint payroll_line_value_ck check ((value <> 0 or (adjusted and coalesce(computed_value, 0) <> 0)) and value between -999999999.99 and 999999999.99),
  constraint payroll_line_unit_ck check (unit in ('days', 'hours', 'amount'))
);

create index payroll_line_closing_idx on public.payroll_line (company_id, closing_id, employment_id);

-- a closing's lines are written with it, in the same transaction (closed_at defaults to now(), the transaction start):
-- a closed month's snapshot (and so its file) never gains a line afterwards
create function public.payroll_line_guard() returns trigger
  language plpgsql
as $$
begin
  if not exists (select 1 from public.payroll_closing c
                  where c.company_id = new.company_id and c.id = new.closing_id
                    and c.reopened_at is null and c.closed_at = now()) then
    raise exception 'payroll_line: closing % is not being written in this transaction', new.closing_id
      using errcode = 'check_violation', constraint = 'payroll_line_closed';
  end if;
  return new;
end
$$;

create trigger payroll_line_guard_tg
  before insert on public.payroll_line
  for each row execute function public.payroll_line_guard();

alter table public.payroll_line enable row level security;
alter table public.payroll_line force row level security;
create policy payroll_line_tenant_isolation on public.payroll_line
  using (company_id = current_setting('app.company_id', true)::uuid);

-- ---------------------------------------------------------------------------------------------------------
-- Privileges. hrforce_app: DML by 0001's default privileges, minus: no delete on the policy (a reset writes the
-- defaults), rubriques (deactivated), periods and closings (records); the lines are append-only. hrforce_worker:
-- SELECT only (0012's default privileges); no payroll job.
revoke delete on table public.payroll_policy, public.payroll_rubrique, public.payroll_period, public.payroll_closing from hrforce_app;
revoke update, delete on table public.payroll_line from hrforce_app;
revoke all on function public.payroll_rubrique_guard() from public;
revoke all on function public.payroll_period_guard() from public;
revoke all on function public.payroll_adjustment_guard() from public;
revoke all on function public.payroll_closing_guard() from public;
revoke all on function public.payroll_line_guard() from public;

-- ---------------------------------------------------------------------------------------------------------
-- Audit: row triggers on the seven tables (no exemption).
create trigger audit_capture_tg after insert or update or delete on public.payroll_policy
  for each row execute function audit.capture('company_id');
create trigger audit_capture_tg after insert or update or delete on public.payroll_rubrique
  for each row execute function audit.capture();
create trigger audit_capture_tg after insert or update or delete on public.payroll_employee_code
  for each row execute function audit.capture();
create trigger audit_capture_tg after insert or update or delete on public.payroll_period
  for each row execute function audit.capture();
create trigger audit_capture_tg after insert or update or delete on public.payroll_adjustment
  for each row execute function audit.capture();
create trigger audit_capture_tg after insert or update or delete on public.payroll_closing
  for each row execute function audit.capture();
create trigger audit_capture_tg after insert or update or delete on public.payroll_line
  for each row execute function audit.capture();

-- The values are masked in the row images: a manual rubrique in `amount` (bonus, advance) is salary data, readable in
-- the payroll screen with employee.salary.read only, while the audit log is readable with audit.read (e.g.
-- admin_acces). audit.capture() masks per column, not per row, so every value of these tables is masked (days and
-- hours too); the payroll screen and the control report show them, and the History still says which rubrique changed.
insert into audit.masked_column (table_name, column_name) values
  ('payroll_adjustment', 'value'),
  ('payroll_line', 'value'),
  ('payroll_line', 'computed_value');

-- ---------------------------------------------------------------------------------------------------------
-- The computed rubriques of every existing company (placeholder codes, to replace with the PC-PAIE ones; the same
-- list as seedPayrollDefaults in src/modules/payroll/infra/payroll-seed.ts): one per leave type (recovery inactive),
-- unjustified absence, presence days, lateness and overtime (inactive: Law 90-11 art. 31 needs prior authorisation).
insert into public.payroll_rubrique (company_id, source, leave_type_id, export_code, name_fr, name_ar, name_en, unit, active, sort_order)
select lt.company_id, 'leave', lt.id,
       case lt.code
         when 'annual' then 'CG_ANNUEL'
         when 'recovery' then 'CG_RECUP'
         when 'sick' then 'CG_MALADIE'
         when 'maternity' then 'CG_MATERNITE'
         when 'marriage' then 'CG_MARIAGE'
         when 'birth' then 'CG_NAISSANCE'
         when 'child_marriage' then 'CG_MARIAGE_ENF'
         when 'bereavement' then 'CG_DECES'
         when 'circumcision' then 'CG_CIRCONCISION'
         when 'pilgrimage' then 'CG_HADJ'
         when 'unpaid' then 'CG_SANS_SOLDE'
         else 'CG_' || upper(left(lt.code, 17))
       end,
       left(lt.name_fr, 80), left(lt.name_ar, 80), left(lt.name_en, 80), 'days', lt.code <> 'recovery', lt.sort_order
  from public.leave_type lt
on conflict do nothing;

insert into public.payroll_rubrique (company_id, source, export_code, name_fr, name_ar, name_en, unit, active, sort_order)
select c.id, d.source, d.code, d.fr, d.ar, d.en, d.unit, d.active, d.sort_order
  from public.company c
  cross join (values
    ('absence', 'ABS_NJ', 'Absence non justifiée', 'غياب غير مبرر', 'Unjustified absence', 'days', true, 500),
    ('service_days', 'JRS_PRES', 'Jours de présence', 'أيام الحضور', 'Days employed', 'days', true, 510),
    ('late', 'RETARD', 'Retards', 'التأخرات', 'Lateness', 'hours', false, 520),
    ('overtime_normal', 'HS50', 'Heures supplémentaires', 'الساعات الإضافية', 'Overtime', 'hours', false, 530),
    ('overtime_rest_day', 'HS75', 'Heures supplémentaires — repos', 'الساعات الإضافية — يوم الراحة', 'Overtime — rest day', 'hours', false, 540),
    ('overtime_holiday', 'HS100', 'Heures supplémentaires — jour férié', 'الساعات الإضافية — يوم عطلة رسمية', 'Overtime — public holiday', 'hours', false, 550)
  ) as d (source, code, fr, ar, en, unit, active, sort_order)
on conflict do nothing;
