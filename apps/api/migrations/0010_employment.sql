-- 0010: employment (docs/contracts/employment.md).
--   person              identity of a person (Latin names required, Arabic names optional, NIN unique per company)
--   person_sensitive    NSS, RIB, bank name — a separate table so that field permissions are a join, not column games
--   employment          a person's employment (matricule, hire / end date); several over time (rehire), at most one open
--   assignment          date-effective unit + site + job title of an employment (no overlap per employment)
--   employment_salary   date-effective base salary (numeric(12,2), DZD; no overlap per employment)
-- Also: org_unit_version.name_ar (optional Arabic unit name, date-effective like `name`), Arabic-aware
-- search_normalize(), trigram indexes for the employee search, the permissions employee.{salary,bank,nss}.update
-- (granted to admin_rh_central of every company) and the masked audit columns.
--
-- Every new table: company_id + RLS/FORCE + the standard tenant policy, composite (company_id, …) foreign keys, the
-- audit trigger (audit.capture(); person_sensitive is keyed on person_id). The app never deletes these rows (history):
-- DELETE is revoked from hrforce_app.
--
-- Date ranges are `[from, to)` like org_unit_version (`to` null = open). An employment's end_date is INCLUSIVE (the
-- last day worked): its assignment / salary ranges then end at end_date + 1.
-- Rules enforced here (cheap, race-free): the exclusion constraints (assignment and salary validity per employment,
-- employment periods per person), one open employment per person, NIN / matricule uniqueness and formats, NSS / RIB
-- formats, and — as a DEFERRED constraint trigger checked at commit — "the first assignment starts on the hire date,
-- assignments and salaries stay inside the employment". The API checks the same rules first and answers with 409
-- problems; the database is the backstop.

-- ---------------------------------------------------------------------------------------------------------
-- Trigram indexes for "contains" searches (LIKE '%…%'). pg_trgm is a TRUSTED extension (PG13+): the migrator, as
-- database owner, can install it without superuser. Available on PG16 and PG18 alike.
create extension if not exists pg_trgm with schema public;

-- ---------------------------------------------------------------------------------------------------------
-- search_normalize(): accent/case-insensitive Latin (0005) + Arabic normalisation, applied to the stored search
-- columns AND to the query text (same function on both sides):
--   * strip the tashkeel (harakat U+064B–U+0652: fathatan … sukun), the superscript alef U+0670 and the tatweel U+0640;
--   * unify the alef forms أ إ آ ٱ → ا; alef maqsura ى → ي; teh marbuta ة → ه; hamza carriers ؤ → و, ئ → ي
--     (the usual spelling variants of Algerian names: "فاطمة" / "فاطمه", "مصطفى" / "مصطفي", "أحمد" / "احمد").
-- org_unit_version.name_search depends on it: drop it first, then re-add it (also covering name_ar).
alter table public.org_unit_version drop column name_search;

create or replace function public.search_normalize(value text) returns text
  language sql
  immutable
  strict
  parallel safe
return lower(translate(value,
  'ÀÁÂÃÄÅàáâãäåÇçÈÉÊËèéêëÌÍÎÏìíîïÑñÒÓÔÕÖØòóôõöøÙÚÛÜùúûüÝýÿ'
    || U&'\0623\0625\0622\0671\0649\0629\0624\0626'
    || U&'\064B\064C\064D\064E\064F\0650\0651\0652\0670\0640',
  'AAAAAAaaaaaaCcEEEEeeeeIIIIiiiiNnOOOOOOooooooUUUUuuuuYyy'
    || U&'\0627\0627\0627\0627\064A\0647\0648\064A'));

-- ---------------------------------------------------------------------------------------------------------
-- org_unit_version.name_ar: optional Arabic name of the version (date-effective with `name`).
alter table public.org_unit_version
  add column name_ar text,
  add constraint org_unit_version_name_ar_ck check (name_ar is null or (name_ar = btrim(name_ar) and char_length(name_ar) between 1 and 120)),
  add column name_search text generated always as (public.search_normalize(name || ' ' || coalesce(name_ar, ''))) stored;

-- ---------------------------------------------------------------------------------------------------------
create table public.person (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company (id),
  last_name text not null,
  first_name text not null,
  last_name_ar text,
  first_name_ar text,
  birth_date date,
  birth_place text,
  sex text,
  nationality text not null default 'DZ',
  nin text,
  -- "contains" search key: both name orders (so "Amina Benali" and "Benali Amina" match), Latin and Arabic, and the NIN
  search_text text generated always as (public.search_normalize(
    last_name || ' ' || first_name || ' ' || last_name || ' '
    || coalesce(last_name_ar || ' ', '') || coalesce(first_name_ar || ' ', '') || coalesce(last_name_ar || ' ', '')
    || coalesce(nin, ''))) stored,
  -- accent/case-insensitive sort key (Latin names)
  sort_name text generated always as (public.search_normalize(last_name || ' ' || first_name)) stored,
  created_at timestamptz not null default now(),
  constraint person_company_id_id_uk unique (company_id, id),
  -- NULLs are distinct: any number of persons without NIN
  constraint person_company_nin_uk unique (company_id, nin),
  constraint person_last_name_ck check (last_name = btrim(last_name) and char_length(last_name) between 1 and 80),
  constraint person_first_name_ck check (first_name = btrim(first_name) and char_length(first_name) between 1 and 80),
  constraint person_last_name_ar_ck check (last_name_ar is null or (last_name_ar = btrim(last_name_ar) and char_length(last_name_ar) between 1 and 80)),
  constraint person_first_name_ar_ck check (first_name_ar is null or (first_name_ar = btrim(first_name_ar) and char_length(first_name_ar) between 1 and 80)),
  constraint person_birth_place_ck check (birth_place is null or (birth_place = btrim(birth_place) and char_length(birth_place) between 1 and 120)),
  constraint person_sex_ck check (sex is null or sex in ('M', 'F')),
  constraint person_nationality_ck check (nationality ~ '^[A-Z]{2}$'),
  -- Numéro d'Identification National: 18 digits
  constraint person_nin_ck check (nin is null or nin ~ '^[0-9]{18}$')
);

create index person_search_trgm_idx on public.person using gin (search_text gin_trgm_ops);
create index person_company_sort_idx on public.person (company_id, sort_name);

alter table public.person enable row level security;
alter table public.person force row level security;
create policy person_tenant_isolation on public.person
  using (company_id = current_setting('app.company_id', true)::uuid);

-- ---------------------------------------------------------------------------------------------------------
create table public.person_sensitive (
  person_id uuid primary key,
  company_id uuid not null,
  nss text,
  rib text,
  bank_name text,
  updated_at timestamptz not null default now(),
  constraint person_sensitive_person_fk foreign key (company_id, person_id) references public.person (company_id, id),
  -- Numéro de Sécurité Sociale: digits only, 10–15
  constraint person_sensitive_nss_ck check (nss is null or nss ~ '^[0-9]{10,15}$'),
  -- Relevé d'Identité Bancaire (Algeria): exactly 20 digits
  constraint person_sensitive_rib_ck check (rib is null or rib ~ '^[0-9]{20}$'),
  constraint person_sensitive_bank_name_ck check (bank_name is null or (bank_name = btrim(bank_name) and char_length(bank_name) between 1 and 120))
);

create index person_sensitive_company_idx on public.person_sensitive (company_id);

alter table public.person_sensitive enable row level security;
alter table public.person_sensitive force row level security;
create policy person_sensitive_tenant_isolation on public.person_sensitive
  using (company_id = current_setting('app.company_id', true)::uuid);

-- ---------------------------------------------------------------------------------------------------------
create table public.employment (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.company (id),
  person_id uuid not null,
  matricule text not null,
  hire_date date not null,
  end_date date,
  end_reason text,
  matricule_search text generated always as (public.search_normalize(matricule)) stored,
  created_at timestamptz not null default now(),
  constraint employment_person_fk foreign key (company_id, person_id) references public.person (company_id, id),
  constraint employment_company_id_id_uk unique (company_id, id),
  constraint employment_company_matricule_uk unique (company_id, matricule),
  constraint employment_matricule_ck check (matricule ~ '^[A-Z0-9][A-Z0-9-]{0,19}$'),
  constraint employment_end_reason_ck check (
    end_reason is null or end_reason in ('resignation', 'retirement', 'dismissal', 'end_of_contract', 'death', 'other')
  ),
  constraint employment_end_ck check ((end_date is null) = (end_reason is null)),
  constraint employment_end_after_hire_ck check (end_date is null or end_date >= hire_date),
  -- a person's employments never overlap (inclusive end); with the partial unique index below: at most one open
  constraint employment_no_overlap_ex exclude using gist (person_id with =, daterange(hire_date, end_date, '[]') with &&)
);

create unique index employment_one_open_uk on public.employment (company_id, person_id) where end_date is null;
create index employment_company_person_idx on public.employment (company_id, person_id);
create index employment_company_hire_idx on public.employment (company_id, hire_date);
create index employment_company_end_idx on public.employment (company_id, end_date);
create index employment_matricule_trgm_idx on public.employment using gin (matricule_search gin_trgm_ops);

alter table public.employment enable row level security;
alter table public.employment force row level security;
create policy employment_tenant_isolation on public.employment
  using (company_id = current_setting('app.company_id', true)::uuid);

-- matricule (entered by HR), person and company are immutable.
create function public.employment_immutable_columns() returns trigger
  language plpgsql
as $$
begin
  if new.matricule is distinct from old.matricule or new.person_id is distinct from old.person_id
     or new.company_id is distinct from old.company_id then
    raise exception 'employment.matricule, person_id and company_id are immutable'
      using errcode = 'check_violation', constraint = 'employment_immutable';
  end if;
  return new;
end
$$;

create trigger employment_immutable_columns_tg
  before update on public.employment
  for each row execute function public.employment_immutable_columns();

-- ---------------------------------------------------------------------------------------------------------
create table public.assignment (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  employment_id uuid not null,
  org_unit_id uuid not null,
  -- null = the unit's effective site (own, else the nearest ancestor's)
  site_id uuid,
  job_title text not null,
  valid daterange not null,
  created_at timestamptz not null default now(),
  constraint assignment_employment_fk foreign key (company_id, employment_id) references public.employment (company_id, id),
  constraint assignment_unit_fk foreign key (company_id, org_unit_id) references public.org_unit (company_id, id),
  constraint assignment_site_fk foreign key (company_id, site_id) references public.site (company_id, id),
  constraint assignment_job_title_ck check (job_title = btrim(job_title) and char_length(job_title) between 1 and 120),
  constraint assignment_valid_ck check (
    not isempty(valid) and lower(valid) is not null and lower_inc(valid) and not upper_inc(valid)
  ),
  constraint assignment_no_overlap_ex exclude using gist (employment_id with =, valid with &&)
);

create index assignment_company_employment_idx on public.assignment (company_id, employment_id);
create index assignment_company_unit_idx on public.assignment (company_id, org_unit_id);
create index assignment_company_site_idx on public.assignment (company_id, site_id) where site_id is not null;
create index assignment_valid_idx on public.assignment using gist (company_id, valid);

alter table public.assignment enable row level security;
alter table public.assignment force row level security;
create policy assignment_tenant_isolation on public.assignment
  using (company_id = current_setting('app.company_id', true)::uuid);

-- ---------------------------------------------------------------------------------------------------------
create table public.employment_salary (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  employment_id uuid not null,
  base_salary numeric(12, 2) not null,
  currency text not null default 'DZD',
  valid daterange not null,
  created_at timestamptz not null default now(),
  constraint employment_salary_employment_fk foreign key (company_id, employment_id) references public.employment (company_id, id),
  constraint employment_salary_amount_ck check (base_salary > 0),
  constraint employment_salary_currency_ck check (currency = 'DZD'),
  constraint employment_salary_valid_ck check (
    not isempty(valid) and lower(valid) is not null and lower_inc(valid) and not upper_inc(valid)
  ),
  constraint employment_salary_no_overlap_ex exclude using gist (employment_id with =, valid with &&)
);

create index employment_salary_company_employment_idx on public.employment_salary (company_id, employment_id);

alter table public.employment_salary enable row level security;
alter table public.employment_salary force row level security;
create policy employment_salary_tenant_isolation on public.employment_salary
  using (company_id = current_setting('app.company_id', true)::uuid);

-- ---------------------------------------------------------------------------------------------------------
-- Date rules of an employment, checked at COMMIT (deferred constraint triggers), so a use case may write the
-- employment, its assignments and salaries in any order inside its transaction:
--   * it has assignments and the first one starts on hire_date;
--   * no assignment / salary starts before hire_date;
--   * when ended: no assignment / salary runs past end_date (range upper ≤ end_date + 1, never open).
-- Runs as the caller (RLS applies: the rows belong to the caller's tenant; the migrator bypasses RLS).
create function public.employment_check_dates(p_employment_id uuid) returns void
  language plpgsql
as $$
declare
  v_hire date;
  v_end date;
  v_first date;
begin
  select e.hire_date, e.end_date into v_hire, v_end from public.employment e where e.id = p_employment_id;
  if not found then
    return; -- deleted in the same transaction
  end if;
  select min(lower(a.valid)) into v_first from public.assignment a where a.employment_id = p_employment_id;
  if v_first is distinct from v_hire then
    raise exception 'employment %: the first assignment must start on the hire date %', p_employment_id, v_hire
      using errcode = 'check_violation', constraint = 'employment_first_assignment_ck';
  end if;
  if exists (select 1 from public.employment_salary s where s.employment_id = p_employment_id and lower(s.valid) < v_hire) then
    raise exception 'employment %: a salary starts before the hire date', p_employment_id
      using errcode = 'check_violation', constraint = 'employment_salary_dates_ck';
  end if;
  if v_end is not null then
    if exists (select 1 from public.assignment a where a.employment_id = p_employment_id
                and (upper(a.valid) is null or upper(a.valid) > v_end + 1)) then
      raise exception 'employment %: an assignment runs past the end date %', p_employment_id, v_end
        using errcode = 'check_violation', constraint = 'employment_assignment_dates_ck';
    end if;
    if exists (select 1 from public.employment_salary s where s.employment_id = p_employment_id
                and (upper(s.valid) is null or upper(s.valid) > v_end + 1)) then
      raise exception 'employment %: a salary runs past the end date %', p_employment_id, v_end
        using errcode = 'check_violation', constraint = 'employment_salary_dates_ck';
    end if;
  end if;
end
$$;

create function public.employment_check_dates_tg() returns trigger
  language plpgsql
as $$
begin
  if tg_table_name = 'employment' then
    if tg_op = 'DELETE' then
      return null;
    end if;
    perform public.employment_check_dates(new.id);
  elsif tg_op = 'DELETE' then
    perform public.employment_check_dates(old.employment_id);
  else
    perform public.employment_check_dates(new.employment_id);
  end if;
  return null;
end
$$;

create constraint trigger employment_dates_ctg
  after insert or update on public.employment
  deferrable initially deferred
  for each row execute function public.employment_check_dates_tg();
create constraint trigger assignment_dates_ctg
  after insert or update or delete on public.assignment
  deferrable initially deferred
  for each row execute function public.employment_check_dates_tg();
create constraint trigger employment_salary_dates_ctg
  after insert or update or delete on public.employment_salary
  deferrable initially deferred
  for each row execute function public.employment_check_dates_tg();

-- ---------------------------------------------------------------------------------------------------------
-- History is kept: the app never deletes persons, employments, assignments, salaries or sensitive rows.
revoke delete on table public.person, public.person_sensitive, public.employment, public.assignment, public.employment_salary
  from hrforce_app;

-- ---------------------------------------------------------------------------------------------------------
-- Audit: every new tenant table (guard:db audit-per-write); person_sensitive has no `id` and is keyed on its person.
create trigger audit_capture_tg after insert or update or delete on public.person
  for each row execute function audit.capture();
create trigger audit_capture_tg after insert or update or delete on public.person_sensitive
  for each row execute function audit.capture('person_id');
create trigger audit_capture_tg after insert or update or delete on public.employment
  for each row execute function audit.capture();
create trigger audit_capture_tg after insert or update or delete on public.assignment
  for each row execute function audit.capture();
create trigger audit_capture_tg after insert or update or delete on public.employment_salary
  for each row execute function audit.capture();

insert into audit.masked_column (table_name, column_name) values
  ('person_sensitive', 'nss'),
  ('person_sensitive', 'rib'),
  ('person_sensitive', 'bank_name'),
  ('employment_salary', 'base_salary');

-- ---------------------------------------------------------------------------------------------------------
-- Permissions employee.{salary,bank,nss}.update (group sensitive), each right after its `.read` in the catalogue
-- order; held by the system role admin_rh_central of every company (new companies: SYSTEM_ROLES in
-- modules/authorization/domain/catalogue.ts). Arabic: تعديل (edit) + الأجور / الحساب البنكي / رقم الضمان الاجتماعي.
insert into public.permission (code, label_fr, label_ar, label_en, group_code, sensitive, sort_order) values
  ('employee.salary.update', 'Modifier les salaires', 'تعديل الأجور', 'Edit salaries', 'sensitive', true, 415),
  ('employee.bank.update', 'Modifier les coordonnées bancaires (RIB)', 'تعديل الحساب البنكي (RIB)', 'Edit bank details (RIB)', 'sensitive', true, 425),
  ('employee.nss.update', 'Modifier le numéro de sécurité sociale (NSS)', 'تعديل رقم الضمان الاجتماعي', 'Edit the social security number (NSS)', 'sensitive', true, 435);

insert into public.role_permission (company_id, role_id, permission_code)
select r.company_id, r.id, p.code
  from public.role r
 cross join (values ('employee.salary.update'), ('employee.bank.update'), ('employee.nss.update')) as p (code)
 where r.is_system and r.code = 'admin_rh_central'
on conflict (role_id, permission_code) do nothing;
