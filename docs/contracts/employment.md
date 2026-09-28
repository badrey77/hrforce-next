# Contract — Employment slice (M1, step 6 — last M1 step)

Binding contract between `apps/api` (Employment module + small Organization/Authorization/Audit additions) and `apps/web` (employee screens).
Plan: "Person, employment and a date-effective assignment (unit, site, job title); list with filters, sorting and paging; create and edit; field-level permissions on sensitive data." Contracts, positions, documents and numbering stay out of scope (M2/M3).

**Defaults confirmed with the business owner by silence (change later by role edit or data):** optional Arabic names for people and org units; only `admin_rh_central` reads and edits salary, RIB and NSS; nobody holds `employee.medical.read`.

## Data (migration 0010)

| Table | Columns | Notes |
|---|---|---|
| `person` | `id`, `company_id`, `last_name`, `first_name` (Latin, required), `last_name_ar`, `first_name_ar` (optional), `birth_date` null, `birth_place` null, `sex` (`M`/`F`) null, `nationality` (ISO-2, default `DZ`), `nin` null (18 digits, unique per company when set), `created_at` | |
| `person_sensitive` | `person_id` pk, `company_id`, `nss` null (digits, 10–15), `rib` null (exactly 20 digits), `bank_name` null, `updated_at` | separate table so field permissions are a join, not column games |
| `employment` | `id`, `company_id`, `person_id`, `matricule` (unique per company, `^[A-Z0-9][A-Z0-9-]{0,19}$`, entered by HR, immutable), `hire_date`, `end_date` null, `end_reason` null (`resignation`/`retirement`/`dismissal`/`end_of_contract`/`death`/`other`), `created_at` | one person may have several employments over time (rehire), at most one open |
| `assignment` | `id`, `company_id`, `employment_id`, `org_unit_id`, `site_id` null (null = the unit's effective site), `job_title` (1–120), `valid` daterange | no overlap per employment (exclusion constraint); first assignment starts at `hire_date`; none after `end_date` |
| `employment_salary` | `id`, `company_id`, `employment_id`, `base_salary numeric(12,2)` (> 0), `currency` (`DZD`), `valid` daterange | no overlap per employment |

All: RLS + FORCE + standard policy, composite FKs with `company_id`, audit trigger (automatic via the guardrail), indexes for the list filters. Register masked columns in `audit.masked_column`: `person_sensitive.nss`, `person_sensitive.rib`, `person_sensitive.bank_name`, `employment_salary.base_salary`.
Also: `org_unit_version.name_ar` (optional) — Arabic unit name, date-effective like `name`.

## Permissions (catalogue additions)

`employee.salary.update`, `employee.bank.update`, `employee.nss.update` (group `sensitive`), granted by the migration to `admin_rh_central` in every company (and the seeding helper). Existing: `employee.read`, `employee.create`, `employee.update`, `employee.salary.read`, `employee.bank.read`, `employee.nss.read`, `employee.medical.read`.

## Scope

- An employment is in scope for permission P if its **assignment unit as of `asOf`** (default today) is in P's scope; for an ended employment, its **last** assignment's unit.
- Field blocks: `salary` needs `employee.salary.read` over the employee's unit; `bank` (rib + bank name) `employee.bank.read`; `nss` `employee.nss.read`. Missing → the block is **omitted** and its name listed in `_redacted`.
- Writes: `employee.update` over the current unit; a new assignment also needs `employee.update` (or `employee.create`) over the **new** unit; sensitive writes need the matching `.update` permission. Out-of-scope id → 404; readable but not writable → 403 `forbidden-scope`; a sensitive field without permission → 403 `forbidden-field` with `errors[{field}]`.

## Endpoints (under `/api`, problem+json)

| Method + path | Permission | Purpose |
|---|---|---|
| `GET /employees` | `employee.read` | list — query: `q` (name Latin/Arabic, matricule, NIN; accent/case-insensitive), `unitId` + `includeSubUnits` (default true), `siteId`, `status` (`active` default / `ended` / `all`), `asOf`, `sort` (`name` default / `matricule` / `hireDate` / `unit`), `dir` (`asc`/`desc`), `lang` (`fr` default / `ar`: the UI language; with `sort=name`, `ar` orders by the Arabic last name then first name, each falling back to the Latin one when missing, collation ICU `ar-x-icu`, then matricule; no effect on other sort keys; any other value → 422, `errors[].field = lang`), `page` (1-based), `pageSize` (default 25, max 100) → `{items: EmployeeListItem[], total, page, pageSize}` |
| `GET /employees/:id` | `employee.read` | detail (`:id` = employment id) |
| `POST /employees` | `employee.create` over the first unit | create person (or reuse `personId` for a rehire) + employment + first assignment (+ optional `salary`, `bank`, `nss` blocks if permitted) → 201 detail + Location |
| `PATCH /employees/:id/person` | `employee.update` | person fields (names, birth, sex, nationality, nin) |
| `POST /employees/:id/assignments` | `employee.update` (both units) | `{orgUnitId, siteId?, jobTitle, validFrom}` → closes the current assignment the day before, opens the new one |
| `POST /employees/:id/end` | `employee.update` | `{endDate, reason}` → closes the open assignment and salary at `endDate` (inclusive end → range upper = endDate + 1) |
| `PUT /employees/:id/salary` | `employee.salary.update` | `{baseSalary, validFrom}` → new salary version |
| `PUT /employees/:id/bank` | `employee.bank.update` | `{rib, bankName}` |
| `PUT /employees/:id/nss` | `employee.nss.update` | `{nss}` |

409 slugs: `matricule-taken` (matricule), `nin-taken` (nin), `employment-open` (personId: already has an open employment), `employment-ended` (form: writes on an ended employment), `assignment-date` (validFrom: must be after the current assignment's start and within the employment), `salary-date` (validFrom), `end-date` (endDate: ≥ current assignment start, ≥ hire date).

**Settled by the build (the contract left these open):**
- `hire-date` (409, field `hireDate`): a rehire's hire date must be after the end of the person's previous employment (also the backstop for the per-person no-overlap constraint).
- `POST /employees` body is **flat** for person and first-assignment fields — `{personId? | lastName, firstName, lastNameAr?, firstNameAr?, birthDate?, birthPlace?, sex?, nationality?, nin?}, matricule, hireDate, orgUnitId, siteId?, jobTitle` — with the sensitive blocks **nested** as in the detail: `salary: {baseSalary}`, `bank: {rib, bankName}`, `nss: {nss}`. With `personId` the person fields are refused (422). The first assignment and the first salary start at `hireDate`. The matricule is trimmed and upper-cased by the API; the web accepts lower case too (create and rehire forms show it in capitals, upper-case the value on blur and before sending).
- `forbidden-field` is checked against the `.update` permission over the first unit; `errors[].field` is the block name (`salary`/`bank`/`nss`). Nothing is written when it fires. A `PUT /employees/:id/{salary,bank,nss}` by a caller who holds that `.update` permission nowhere is a plain 403 `forbidden` from the guard (before the id is looked up, so it reveals nothing).
- Money in request bodies must be a JSON **string** (`"85000"`, `"85000.5"`, `"85000.50"`; > 0, at most 10 digits before the point and 2 after); a JSON number is a 422. Responses always carry two decimals.
- Once `endDate` is recorded (even a future one) the employment is closed for writes: every write answers `employment-ended` and `_actions` is empty. `status` stays `active` until the end date has passed.
- `assignments[].unit.path` items also carry `nameAr` (`{id, name, nameAr}`).
- An unknown `orgUnitId` / `siteId` in a body is a 422 `not_found` on that field (a unit of another company counts as unknown).
- **Arabic name order (hardening, 2026-09-28).** `GET /employees?sort=name&lang=ar` sorts by
  `coalesce(last_name_ar, last_name)`, then `coalesce(first_name_ar, first_name)` (a blank Arabic name counts as
  missing), then `matricule`, all in `dir`, with `id` ascending as the final tiebreak — collation **`ar-x-icu`** (ICU
  Arabic, predefined by initdb in every ICU-enabled build, incl. the official `postgres:16`/`postgres:18` Debian and
  Alpine images; the database default libc collation orders Arabic by code point, e.g. آ < أ < إ, and musl/Alpine has
  no Arabic collation at all). ICU Arabic follows the Arabic alphabet, treats the alef forms (ا أ إ آ) as one base
  letter, and puts Latin fallbacks after every Arabic name when ascending. `lang=fr` (default) keeps the Latin order
  (`sort_name`: accent/case-folded last + first name). The web sends `lang=ar` only when the UI is Arabic —
  employee list and employee picker — and never puts it in the page URL; switching the UI to or from Arabic re-fetches
  the list (fr ↔ en sends the same request, so it does not).
- **Rehire (web, hardening 2026-09-28).** Route `/employees/:id/rehire` (`employee.create`; without it the route does
  not match and the app shows "not found"), reached from the "Rehire" action of an employee whose employment has an
  end date (`:id` = that ended employment). The person's identity is shown read-only; the form sends
  `POST /employees` with `personId` + matricule, hire date, first assignment and optional salary — person fields are
  **never sent**. On the API side the flat person fields next to `personId` are a 422 on each field, and unknown
  keys (e.g. a nested `person` object) are stripped and ignored. A person outside the caller's `employee.create`
  scope is a 422 `not_found` on `personId`; a person rehired since (another open employment) is a 409
  `employment-open`, shown above the form.

```ts
interface NamePair { lastName: string; firstName: string; lastNameAr: string | null; firstNameAr: string | null }
interface UnitRef { id: string; code: string; name: string; nameAr: string | null; kind: string }
interface EmployeeListItem {
  id: string; matricule: string; person: NamePair & { id: string };
  unit: UnitRef; site: { id: string; code: string; name: string } | null;   // effective site
  jobTitle: string; hireDate: string; endDate: string | null; status: 'active' | 'ended' | 'future';
}
interface EmployeeDetail extends EmployeeListItem {
  person: EmployeeListItem['person'] & { birthDate: string | null; birthPlace: string | null; sex: 'M' | 'F' | null; nationality: string; nin: string | null };
  endReason: string | null;
  assignments: { id: string; unit: UnitRef & { path: { id: string; name: string }[] }; site: { id: string; code: string; name: string } | null; siteInherited: boolean; jobTitle: string; validFrom: string; validTo: string | null }[]; // newest first
  salary?: { current: { baseSalary: string; currency: 'DZD'; validFrom: string } | null; history: { baseSalary: string; validFrom: string; validTo: string | null }[] };
  bank?: { rib: string | null; bankName: string | null };
  nss?: { nss: string | null };
  _redacted: ('salary' | 'bank' | 'nss')[];
  _actions: ('update' | 'assign' | 'end' | 'update_salary' | 'update_bank' | 'update_nss')[];
}
```
Money is a decimal **string** (`"85000.00"`) to avoid float rounding. `OrgTreeNode`, `OrgUnitSummary`, `OrgUnitDetail` and versions gain `nameAr: string | null`; create/change bodies accept `nameAr`.

## Audit

Timeline subject type `employee:<employment id>` = rows of `employment`, its `assignment`s and `employment_salary` rows, and its person's `person` and `person_sensitive` rows; scope = the employee's scope for `audit.read`. Sensitive values appear as masked.

## Seed

~40 **fictitious** employees across the demo units (Algerian first/last names in Latin and Arabic, fake NIN/NSS/RIB clearly marked as test data in the seed file), including 2 ended employments, 3 with an assignment history (moves between agencies), salaries for all active ones.

## Web

- `/employees` (nav "Employés", `employee.read`): filter bar (search, org-unit picker + "include sub-units", site, status), sortable columns, server paging; **all list state in the URL query params** so a filtered view is shareable and back/forward works. Names shown in Arabic when the UI is Arabic and an Arabic name exists (else Latin); same for unit names.
- `/employees/new` (`employee.create`): sections Identity, Employment (matricule, hire date), First assignment (unit picker, site, job title), and — only if permitted — Salary, Bank, NSS.
- `/employees/:id`: header (name, matricule, unit, status), tabs Identity · Assignments (history + "New assignment") · Pay (salary history + "New salary", only if not redacted) · Bank & NSS (only if not redacted) · History (`audit.read`). "End employment" action with a confirm dialog. Buttons from `_actions`.
- Org screens: `nameAr` field in unit create/change forms, Arabic name shown in Arabic UI.
- Polish: dates and codes don't wrap in table cells.
