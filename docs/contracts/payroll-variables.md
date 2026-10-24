# Contract — Payroll variables: monthly closing and export to the payroll software

Binding contract between `apps/api` (new module `payroll`, read-only use of Leave, Attendance, Employment) and
`apps/web` (a « Paie » screen with the month's variables, its settings, a dashboard tile). Owner decision 2026-10-24
(`docs/HANDOFF.md`): payroll stays in **PC-PAIE** (DLG, Windows); the PC-PAIE import format is unknown, so HRForce
builds the **standard** closing: it computes each employee's variables for the month from what it already records
(leave, attendance, hires and exits), HR checks and adjusts them, adds the variable items typed by hand (bonuses,
advances), **closes** the month, and exports a **configurable** text file. Every code, unit and column is data, so
matching PC-PAIE later is a settings change, not code.

Built by four builders in parallel (API ×2, web ×2, ownership below), then verified. No new infrastructure, no new
environment variable, no ADR.

## ⚠ Assumptions to confirm with the owner

| # | Assumption | Default in this contract | Where it lives |
|---|---|---|---|
| 1 | Period | The **calendar month**. A cut-off day (default **20**) is the date from which the month may be closed; anything that changes a closed month afterwards (a late leave approval, an absence after the cut-off) comes back as a **régularisation** line in the next open month | `payroll_policy.cutoff_day` |
| 2 | Import format | A delimited text file, **one line per employee × rubrique** (« matricule;rubrique;valeur;période »), `;` separator, `,` decimals, **Windows-1252** (PC-PAIE is a Windows program), CRLF, header row. Also a « one line per employee, one column per rubrique » layout. Columns, order, separator, decimals, encoding, header and period format are settings | `payroll_policy` (format fields) |
| 3 | Rubrique codes | Placeholder codes (`ABS_NJ`, `CG_ANNUEL`, …) to replace with the real PC-PAIE codes in the settings | `payroll_rubrique.export_code` |
| 4 | Matricule | The HRForce matricule, unless a « matricule paie » is set for the employee | `payroll_employee_code` |
| 5 | Leave | One rubrique **per leave type**, in **days** counted as the type counts them (calendar or working days, half days 0.5), only the days inside the month; approved requests only | source `leave` |
| 6 | Unjustified absence | Attendance days with status `absent` (final days) on a working day **only where attendance is in use**: the employee's effective site that day had an active kiosk (paired on or before that day, not revoked before it). Elsewhere, HR types absences by hand. `incomplete` days are not counted; they are flagged for HR | source `absence` |
| 7 | Overtime | Computed but the rubriques are **inactive by default** (overtime needs prior authorisation, Law 90-11 art. 31): worked minus scheduled minutes on a working day when ≥ 30 min; all worked minutes on a rest day; on a public holiday — in hours, two decimals | sources `overtime_*`, `payroll_policy.overtime_min_minutes` |
| 8 | Lateness | Total late minutes in hours; **inactive by default** | source `late` |
| 9 | Entries and exits | « Jours de présence » (calendar days employed in the month) exported **only** for a month with a hire or an exit (the payroll prorates) | source `service_days` |
| 10 | Amounts | Rubriques typed by hand may be in days, hours or **amounts (DZD)**; amount lines are seen and typed only by holders of `employee.salary.read` / `employee.salary.update` (central HR) | source `manual`, unit `amount` |
| 11 | Who | Central and regional HR check and adjust their scope; **central HR closes and reopens** (company-wide, two-step sign-in); one file per company, or per unit when exported with a unit filter (e.g. one per CNAS centre / region) | permissions |
| 12 | Régularisations | Recomputed for the **3** closed months before the open one; a line HR adjusted in the closed month is not recomputed (HR's value wins) | `payroll_policy.regularization_months` |
| 13 | Nothing sent | The file is downloaded and imported into PC-PAIE by hand; no salary is computed in HRForce | — |

## Wording (fr / ar / en, gender-neutral Arabic — owner rule 2026-09-29)

| Key idea | fr | ar | en |
|---|---|---|---|
| Module | Paie | الأجور | Payroll |
| Payroll variables | Variables de paie | متغيرات الأجر | Payroll variables |
| Closing | Clôture | إقفال | Closing |
| Close the month | Clôturer le mois | إقفال الشهر | Close the month |
| Reopen | Rouvrir | إعادة فتح | Reopen |
| Rubrique | Rubrique | بند | Pay item |
| Régularisation | Régularisation | تسوية | Adjustment from a closed month |
| Export | Exporter le fichier de paie | تصدير ملف الأجور | Export the payroll file |
| Control report | État de contrôle | كشف المراقبة | Control report |
| Adjusted | Ajusté | معدَّل | Adjusted |
| Payroll matricule | Matricule paie | رقم التسجيل في الأجور | Payroll ID |
| Cut-off date | Date limite | تاريخ الإقفال المحدد | Cut-off date |

## Data (migration 0024, owned by API builder 1, written **first**)

All tenant tables: `company_id` + RLS/FORCE + standard policy, composite `(company_id, …)` FKs, audit trigger (no
exemptions). Users referenced without FK (like `role_grant.user_id`). Months stored as `date` = the first day
(check `extract(day from month) = 1`).

| Table | Columns | Rules |
|---|---|---|
| `payroll_policy` (pk `company_id`) | `cutoff_day` 20 (1–28), `regularization_months` 3 (0–12), `overtime_min_minutes` 30 (0–240), `layout` (`per_line` / `per_employee`) `per_line`, `separator` (`semicolon` / `comma` / `tab` / `pipe`) `semicolon`, `decimal_separator` (`comma` / `dot`) `comma`, `encoding` (`windows1252` / `utf8` / `utf8_bom`) `windows1252`, `header_row bool` true, `columns text[]` (`per_line`: allowed `matricule`, `last_name`, `first_name`, `rubrique`, `label`, `value`, `unit`, `period`, `origin_period`, `unit_code`; default `{matricule,rubrique,value,period}`; `per_employee`: the rubrique columns are added after the listed identity columns, allowed `matricule`, `last_name`, `first_name`, `unit_code`, `period`, `origin_period`), `period_format` (`mm_yyyy` → `10/2026`, `yyyymm` → `202610`, `yyyy_mm` → `2026-10`) `mm_yyyy`, `file_extension` (`csv` / `txt`) `csv`, `updated_at` | a company without a row uses these defaults; `columns` 1–10 distinct, must contain `matricule` and (`per_line`) `rubrique` and `value` (422 `columns` `invalid`) |
| `payroll_rubrique` | `id`, `company_id`, `source` (`leave` / `absence` / `late` / `overtime_normal` / `overtime_rest_day` / `overtime_holiday` / `service_days` / `manual`), `leave_type_id uuid null` (source `leave` only), `export_code text` (1–20, `^[A-Za-z0-9_.\-]+$`), `name_fr/ar/en` (1–80), `unit` (`days` / `hours` / `amount`; `amount` for `manual` only; computed sources have a fixed unit: leave/absence/service_days `days`, late/overtime `hours`), `active bool`, `sort_order int`, `created_at` | unique (`company_id`, `source`) for the six computed non-leave sources (partial index); unique (`company_id`, `leave_type_id`); unique (`company_id`, upper(`export_code`)) among active rows (409 `payroll-code-taken`); no DELETE for `hrforce_app` (deactivate) |
| `payroll_employee_code` | `id`, `company_id`, `employment_id`, `code text` (1–20, same pattern), `updated_by`, `updated_at` | unique (`company_id`, `employment_id`); unique (`company_id`, upper(`code`)) (409 `payroll-matricule-taken`); DELETE allowed (back to the matricule) |
| `payroll_period` | `id`, `company_id`, `month date`, `status` (`open` / `closed`), `created_at` | unique (`company_id`, `month`); created on first write or close (a month with no row is `open`) |
| `payroll_adjustment` | `id`, `company_id`, `month date`, `origin_month date` (= `month`, or an earlier month for a régularisation line), `employment_id`, `rubrique_id`, `value numeric(12,2)`, `note text null` (≤ 300), `updated_by`, `updated_at` | unique (`company_id`, `month`, `origin_month`, `employment_id`, `rubrique_id`); `origin_month <= month`; value −999 999 999.99 … 999 999 999.99; for a `manual` rubrique the adjustment **is** the value (no computed value); DELETE allowed while the period is open |
| `payroll_closing` | `id`, `company_id`, `period_id`, `version int` (1, 2, … per period), `closed_by`, `closed_at`, `reopened_by null`, `reopened_at null`, `reopen_reason text null` (5–300), `lines int`, `employees int` | unique (`company_id`, `period_id`, `version`); at most one not reopened per period (partial unique); no DELETE |
| `payroll_line` | `id`, `company_id`, `closing_id`, `employment_id`, `rubrique_id`, `origin_month date`, `computed_value numeric(12,2) null` (null for `manual`), `value numeric(12,2)`, `adjusted bool`, `note text null`, `export_code`, `unit`, `matricule` (the export matricule at close), `last_name`, `first_name`, `unit_code` | snapshot written at close, **append-only** (no UPDATE/DELETE for `hrforce_app`); zero values are not stored |

**Permissions** (catalogue, labels fr/ar/en, new group `payroll`, sort after `deadlines`):

| Code | fr | ar | Granted to |
|---|---|---|---|
| `payroll.read` | Consulter les variables de paie | الاطلاع على متغيرات الأجر | `admin_rh_central`, `rh_regional` |
| `payroll.prepare` | Préparer les variables de paie | إعداد متغيرات الأجر | `admin_rh_central`, `rh_regional` |
| `payroll.export` | Exporter le fichier de paie | تصدير ملف الأجور | `admin_rh_central`, `rh_regional` |
| `payroll.close` | Clôturer la paie | إقفال الأجور | `admin_rh_central` (in every company's **two-step list**, as `document.design`) |
| `payroll.configure` | Paramétrer la paie | إعداد الأجور | `admin_rh_central` |

Scope: `read` / `prepare` / `export` follow the employee's assignment unit on the month's last employed day (as the
attendance monthly report); `close` and `configure` need a **company-wide** grant (a regional grant → 403
`forbidden-scope`).

## Computation (module `payroll`, API builder 2 — pure domain code, unit-tested)

For month `M` and an employment active on at least one day of `M`: **employed days** = max(1st, hire date) →
min(last day, employment end, *nothing after today*). Computed in `Africa/Algiers` (`PayrollClock`, pinned by tests).

| Source | Value |
|---|---|
| `leave` (per type) | Σ over **approved** requests of that type: the days of the request that fall in `M` and in the employed days, counted with the type's `count_mode` (calendar, or working days without weekend and public holidays), a half day 0.5. Use Leave's own day counting (`LeaveFacts` / an exported helper), never a copy. Future approved days of `M` count. |
| `absence` | Number of final days of `M` (≤ yesterday) whose attendance status is `absent`, where attendance is in use that day (assumption 6). Use the Attendance module's exported day computation (export what is needed from `attendance/index.ts`, no copy). |
| `late` | Σ `lateMinutes` of final days ÷ 60, 2 decimals, where attendance is in use. |
| `overtime_normal` | Σ over final working days (status `present` / `late`) of (`workedMinutes` − `scheduledMinutes`) when ≥ `overtime_min_minutes`, ÷ 60. |
| `overtime_rest_day` / `overtime_holiday` | Σ `workedMinutes` of final days with status `rest_day` / `holiday` ÷ 60. |
| `service_days` | Calendar days employed in `M` (ignoring "nothing after today": a known end date counts), emitted **only** when the employment starts or ends inside `M`. |
| `manual` | No computed value: only HR's typed values. |

- Only **active** rubriques produce lines; a value 0 produces no line (a manual or adjusted 0 produces none either).
- A line's `value` = the adjustment's value if any, else the computed value; `adjusted` = an adjustment exists.
- **Régularisations** (assumption 12): while computing open month `M`, for each closed month `P` with
  `M − regularization_months ≤ P < M` (its current closing), for every computed source: `delta` = (value recomputed
  now for `P`) − (`computed_value` in `P`'s closing) − (Σ régularisation lines with `origin_month = P` in the current
  closings of the months after `P` and before `M`). A line of `P` that was `adjusted` is skipped. A non-zero delta is
  a line of `M` with `origin_month = P`; HR may adjust it like any line (adjustment keyed by `origin_month`).
- Flags per employee (shown, not exported): `incomplete_days` (count), `pending_leave` (pending requests touching
  `M`), `entry` / `exit` (date), `no_attendance` (attendance not in use on any employed day — absences must be typed).

## Endpoints (under `/api`, problem+json)

| Method + path | Guard | Request → response |
|---|---|---|
| `GET /payroll/periods?year=` | `payroll.read` | `{items: PeriodSummary[]}` for the 12 months of `year` (default: this year), months after the current one omitted |
| `GET /payroll/periods/:month` | `payroll.read` | `month` = `YYYY-MM` (422 `month` `invalid` / `future`) → `PeriodView` (totals over the caller's scope) |
| `GET /payroll/periods/:month/variables?unitId=&includeSubUnits=&q=&rubriqueId=&filter=adjusted\|regularization\|flagged&page=&pageSize=` | `payroll.read` (scope) | open → computed live; closed → the current closing's lines → `{items: EmployeeVariables[], total, page, pageSize}`, sort name then matricule (`lang=ar` → Arabic names) |
| `GET /payroll/periods/:month/variables/:employeeId` | `payroll.read` (scope; else 404) | → `EmployeeVariables` |
| `PUT /payroll/periods/:month/variables/:employeeId/lines` | `payroll.prepare` (scope) | `{rubriqueId, originMonth?, value, note?}` → 200 `EmployeeVariables`; closed → 409 `payroll-period-closed`; inactive rubrique → 422 `rubriqueId` `inactive`; régularisation line for a month that has none → 422 `originMonth` `invalid`; an `amount` rubrique needs `employee.salary.update` over the employee (else 403); the employee not employed in `M` → 422 `employeeId` `not_employed` |
| `DELETE /payroll/periods/:month/variables/:employeeId/lines/:rubriqueId?originMonth=` | `payroll.prepare` (scope) | removes the adjustment (back to computed, or nothing for manual) → 200 `EmployeeVariables`; closed → 409 |
| `PUT /payroll/employee-codes/:employeeId` | `payroll.prepare` (scope) | `{code: string \| null}` → 200 `{employeeId, code}` |
| `POST /payroll/periods/:month/close` | `payroll.close` (company) | `{}` → 200 `PeriodView`. 409 `payroll-before-cutoff` (today < the month's cut-off date, i.e. `M`-`cutoff_day`), `payroll-period-closed`, `payroll-previous-open` (an earlier month has a closing that was reopened and not closed again, or the previous month is open while an older month is closed). One transaction under a lock on the period row: every employee of the company, every line, `payroll_closing` + `payroll_line`. Two concurrent closes → one wins (the other 409 `payroll-period-closed`) |
| `POST /payroll/periods/:month/reopen` | `payroll.close` (company) | `{reason}` (5–300) → 200; only the **latest** closed month (409 `payroll-period-not-latest`); open → 409 `payroll-period-open` |
| `GET /payroll/periods/:month/export?unitId=&includeSubUnits=&draft=true` | `payroll.export` (scope) | the file (below). Closed → from the current closing, **identical bytes** on every download for the same filter; open → 409 `payroll-period-open` unless `draft=true` (live values, filename `-brouillon`). Rows limited to the caller's scope. `Content-Disposition: attachment; filename="variables-paie-YYYY-MM[-<unit code>][-brouillon].<ext>"`, `Cache-Control: no-store`, `Content-Type: text/csv; charset=windows-1252` (or `utf-8`). Audit `payroll.exported {month, unitId, draft, lines, version}` |
| `GET /payroll/periods/:month/control.csv?unitId=&includeSubUnits=&lang=fr\|ar` | `payroll.read` (scope) | the control report: the attendance CSV conventions (`toCsv`: `;`, UTF-8 BOM, CRLF, formula-injection guard), header in `lang`: matricule, matricule paie, nom, prénom, unité, rubrique (code), libellé, période d'origine, valeur calculée, valeur, ajusté, note — amount lines only for `employee.salary.read` holders |
| `GET /payroll/settings` / `PUT /payroll/settings` | `payroll.configure` (company) | `PayrollSettings` (policy + format) |
| `GET /payroll/rubriques` | `payroll.read` | `{items: RubriqueView[]}` (all, active first then `sort_order`) |
| `POST /payroll/rubriques` | `payroll.configure` | `{exportCode, names, unit}` → 201 (source `manual`) |
| `PUT /payroll/rubriques/:id` | `payroll.configure` | `{exportCode?, names?, unit? (manual only), active?, sortOrder?}` → 200 |
| `GET /payroll/settings/preview` | `payroll.configure` | → `{filename, encoding, sample: string}` the first 5 lines a file would have with the current settings (draft data of the current month in the caller's scope, or invented lines when there are none) |

```ts
type PayrollSource = 'leave' | 'absence' | 'late' | 'overtime_normal' | 'overtime_rest_day' | 'overtime_holiday' | 'service_days' | 'manual';
interface PeriodSummary { month: string; status: 'open' | 'closed'; cutoffDate: string; version: number | null;
  closedAt: string | null; closedBy: UserRef | null }
interface PeriodView extends PeriodSummary { employees: number; lines: number;
  totals: { rubriqueId: string; exportCode: string; names: Labels; unit: 'days' | 'hours' | 'amount'; employees: number; total: number }[];
  regularizations: number; flags: { incompleteDays: number; pendingLeave: number; noAttendance: number };
  closings: { version: number; closedAt: string; closedBy: UserRef | null; reopenedAt: string | null; reopenedBy: UserRef | null; reopenReason: string | null }[];
  _actions: ('close' | 'reopen' | 'export' | 'export_draft')[] }
interface PayrollLine { rubriqueId: string; exportCode: string; names: Labels; unit: 'days' | 'hours' | 'amount';
  source: PayrollSource; originMonth: string; computed: number | null; value: number; adjusted: boolean; note: string | null }
interface EmployeeVariables { employee: EmployeeRef;          // as the attendance monthly report
  payrollCode: string | null; entry: string | null; exit: string | null;
  flags: ('incomplete_days' | 'pending_leave' | 'no_attendance')[]; incompleteDays: number;
  lines: PayrollLine[];                                        // amount lines omitted without employee.salary.read
  _actions: ('edit')[] }
interface RubriqueView { id: string; source: PayrollSource; leaveType: { id: string; code: string; labels: Labels } | null;
  exportCode: string; names: Labels; unit: 'days' | 'hours' | 'amount'; active: boolean; sortOrder: number }
interface PayrollSettings { cutoffDay: number; regularizationMonths: number; overtimeMinMinutes: number;
  layout: 'per_line' | 'per_employee'; separator: 'semicolon' | 'comma' | 'tab' | 'pipe'; decimalSeparator: 'comma' | 'dot';
  encoding: 'windows1252' | 'utf8' | 'utf8_bom'; headerRow: boolean; columns: string[];
  periodFormat: 'mm_yyyy' | 'yyyymm' | 'yyyy_mm'; fileExtension: 'csv' | 'txt' }
```

## Export file (API builder 1 — pure domain, unit-tested)

- `per_line`: one row per line (employee × rubrique × origin month), sorted matricule, then rubrique `sort_order`,
  then origin month. `per_employee`: one row per (employee, origin month), one column per **active** rubrique in
  `sort_order` (header = export code), empty cell for no value.
- Values: two decimals trimmed (`2`, `2,5`, `12,25`), the decimal separator setting, no thousands separator, a minus
  sign for negatives. `period` = the closed month, `origin_period` = the line's origin month (same format). `unit` =
  `J` / `H` / `DA`. Header row (when on) = the column keys in French (`matricule`, `nom`, `prenom`, `rubrique`,
  `libelle`, `valeur`, `unite`, `periode`, `periode_origine`, `code_unite`); names and labels in Latin script.
- Cells: a cell containing the separator, `"`, CR or LF is quoted with `"` doubled; a text cell starting with `=`,
  `+`, `-`, `@`, TAB or CR gets a leading `'` (numbers are never prefixed). CRLF after every row.
- **Windows-1252**: encode with an explicit table (Node's `latin1` is ISO-8859-1, not 1252: `€`, `œ`, `’`, `…` differ);
  a character it cannot encode becomes `?`. UTF-8 with or without BOM.

## Audit

Row triggers on every table. Events: `payroll.closed {month, version, lines, employees}`, `payroll.reopened {month,
version, reason}`, `payroll.exported {…}`, `payroll.control_exported {month, unitId}`. Adjustments, codes, rubriques,
settings are audited by their row triggers (before/after); the History of an employee shows « Variable de paie
ajustée » events for `payroll_adjustment` and `payroll_employee_code`.

## Web

Every screen fr/ar/en, RTL, 390 px. i18n keys under `payroll.*`.

**Web builder 1 — the month (`/payroll`, `payroll.read`; nav « Paie » after « Échéances », icon)**
- Month bar: the 12 months of the year (status chip « Ouvert » / « Clôturé v2 »), year switcher, `?month=YYYY-MM` in
  the URL (default: the latest open month ≤ today).
- Period header: status, cut-off date (« Clôture possible à partir du 20/10/2026 »), totals per rubrique (compact
  tiles: code, label, total + unit, employees), flags (« 3 congés en attente », « 12 jours incomplets »), actions by
  `_actions`: Clôturer (dialog: summary of employees/lines/régularisations, the flags as warnings, confirm),
  Rouvrir (reason required), Exporter le fichier / Export brouillon (download), État de contrôle (fr/ar CSV).
- Variables table (filter bar `appFilterBar`: unit + sub-units, search, rubrique, filter adjusted / régularisation /
  flagged; URL state; paging): matricule (+ matricule paie), name, unit, the lines as compact chips (« CG_ANNUEL 3 j »,
  « Régul. 09/2026 ABS_NJ −1 j »; adjusted chips marked), flags. Below 700 px: cards.
- Employee panel (row click; `?employee=` in the URL): every line with computed value, value input, note, « Revenir
  au calcul » (DELETE), add a manual rubrique (picker of active manual rubriques; `amount` ones only with salary
  update), the payroll matricule field, entry/exit dates, links to the employee and the attendance month. Read-only
  when closed or without `payroll.prepare`.

**Web builder 2 — settings, dashboard, shared pieces**
- `/payroll/settings` (`payroll.configure`; tab bar): **Rubriques** (table: source label, leave type, export code,
  names fr/ar/en, unit, active, order; « Nouvelle rubrique saisie » dialog), **Format d'export** (layout, separator,
  decimals, encoding, header, columns as an ordered pick list with up/down buttons, period format, extension; a live
  preview from `GET /payroll/settings/preview` in a monospace box, refreshed after save), **Calendrier** (cut-off day,
  régularisation months, overtime minimum).
- Dashboard tile (`payroll.close` or `payroll.read`): « Paie d'octobre : ouverte — clôture à partir du 20/10 » /
  « clôturée le … », link to `/payroll`.
- Notification/timeline labels for the payroll audit events; `core/payroll` (models + API service, shared with
  web builder 1 — builder 2 writes it **first**).

## Seed (`seed:dev`, DEMO; TEST DATA)

API builder 1: policy defaults (`windows1252`, `per_line`), rubriques: one per leave type (active: annual, unpaid,
sick, maternity, special leaves; `recovery` inactive), `absence` `ABS_NJ`, `service_days` `JRS_PRES`, `late`
`RETARD` (inactive), `overtime_*` `HS50` / `HS75` / `HS100` (inactive), manual `PRIME_REND` (amount), `AVANCE`
(amount), `IND_PANIER_J` (days). API builder 2: the **previous month closed** (v1, with one adjustment and one
`PRIME_REND`), then a leave request approved **after** that closing touching the previous month (so the current
month shows a régularisation), a payroll matricule for two employees; the current month open. Relative to today.

## Authorization matrix rows (expected)

| Route | Rows |
|---|---|
| `GET /payroll/periods*`, `GET …/variables*`, `GET …/control.csv`, `GET /payroll/rubriques` | admin ✓, est ✓ (Est only), lecture 403, acces 403, agent 403 |
| `PUT/DELETE …/lines`, `PUT /payroll/employee-codes/:id` | admin ✓, est ✓ in Est (Ouest employee → 404), lecture/acces/agent 403 |
| `GET …/export` | admin ✓, est ✓ (Est rows only), others 403 |
| `POST …/close`, `POST …/reopen` | admin ✓ (MFA when enforced), est 403 `forbidden-scope`, others 403 |
| `GET/PUT /payroll/settings`, `GET /payroll/settings/preview`, `POST/PUT /payroll/rubriques*` | admin ✓, est 403, others 403 |
| anonymous | 401 everywhere |

## Tests the build must add

- Domain: every source with a pinned clock (leave across two months, half days, working-day types, hire/exit inside
  the month, attendance not in use, final days only, overtime threshold), régularisation deltas (late approval, a
  second régularisation not doubled, adjusted lines skipped, window), export encoding (Windows-1252 table, `?`
  fallback, decimals, quoting, formula guard, both layouts, byte-identical re-export).
- E2E: live variables, adjust / revert / manual line, closed month refuses writes, close (cut-off, previous-open,
  concurrency → one wins), reopen (latest only), export (scope rows, draft, identical bytes, audit), control CSV,
  amount lines hidden from regional HR, settings and rubriques (code taken), audit exit criterion for every new
  write, matrix rows, inventory tests (audited tables, permissions, MFA list).
- Web: unit tests for every new screen and form (HttpTestingController), fr/ar parity.

## Build ownership (to avoid conflicts)

- **API builder 1:** migration 0024 (all tables, permissions, two-step list, grants — written **first**), `schema.ts`,
  catalogue + `SYSTEM_ROLES`, module skeleton `payroll` (module, `index.ts`, `PayrollClock`), settings, rubriques,
  employee codes, the export file encoder and the export/control endpoints (reading lines through builder 2's
  service), seed of policy/rubriques, matrix rows and audit coverage for its routes.
- **API builder 2:** the computation (domain + `PayrollEngine` reading Leave/Attendance/Employment through their
  `index.ts`, adding the exports it needs there), variables endpoints, adjustments, close/reopen, régularisations,
  seed of periods/closings/the late leave, matrix rows and audit coverage for its routes. It waits for migration 0024
  before running DB tests.
- **Web builder 1:** `/payroll` (above). **Web builder 2:** `core/payroll` (first), settings, dashboard tile, nav
  entry, routes, timeline/audit labels.
- Shared files (`catalogue.ts`, `app.module.ts`, `authorization-matrix.e2e-spec.ts`, `audit.e2e-spec.ts`,
  `app.routes.ts`, `app.ts`, `fr/ar/en.json`, `seed-dev.ts`, the module's own `payroll.module.ts` / `index.ts`):
  **re-read just before each edit, make small targeted edits, never rewrite the whole file**, keep your keys in your
  own section.

## Out of scope (later)

Computing salaries; a direct link to PC-PAIE; one file per CNAS centre in one click (use the unit filter); variables
typed by unit heads; importing PC-PAIE codes from a file; overtime authorisation requests.

## Settled by the build (web)

- Web builder 2: `/payroll/settings` tabs follow `?tab=rubriques|format|calendar` (default « Rubriques »); a
  rubrique is edited inline (code, names, order, activation; unit only for `manual`), a new one in a dialog. The
  « Nouvelle rubrique saisie » dialog defaults to the `amount` unit.
- Web builder 2: the Format and Calendar tabs each PUT the **whole** `PayrollSettings` (their fields over the stored
  ones). Changing the layout keeps the allowed columns in order and adds the required ones (`matricule`; `rubrique`
  and `value` for `per_line`); required columns cannot be removed; the client mirrors the `columns` rule and a 422
  `columns` shows under the pick list. The preview shows the SAVED settings (reloaded after save, « Actualiser »).
- Web builder 2: the dashboard tile (`payroll.read`) shows the previous month while it is still open, else the
  current month (« ouverte — clôture à partir du 20/10 » before the cut-off, « clôture possible depuis le … » after,
  « clôturée le … »), linking to `/payroll?month=YYYY-MM`. Nav: « Paie » (`payroll.read`); a holder of
  `payroll.configure` without `payroll.read` gets « Paramètres de la paie » instead.
- Web builder 2: History lines of `payroll_adjustment` name the rubrique (« CODE · libellé ») from
  `GET /payroll/rubriques` when the viewer has `payroll.read`, else « nom non disponible »; `employment_id` and
  `updated_at` lines are hidden. Audit event sentences `audit.events.payroll.{closed,reopened,exported,control_exported}`.
- Web builder 1: the month bar's year switcher only changes the year shown (`GET /payroll/periods?year=`); the
  month on screen changes when a month is clicked (`?month=` written; future months disabled). Without `?month=` the
  default (latest open month ≤ today in the current year) is fixed once on load, so it does not move after a close.
- Web builder 1: « Clôturer le mois » is shown by `_actions` but disabled before `cutoffDate` (Algiers day), with
  « La clôture sera possible à partir du … »; the API stays the judge (409 slugs are translated in the dialog).
- Web builder 1: the payroll file, its draft and the control report follow the unit filter on screen (unit +
  sub-units, not the search/rubrique/flag filters); the file name comes from `Content-Disposition`. The control
  report has two buttons, French and Arabic, whatever the UI language.
- Web builder 1: values show up to two decimals in the UI locale with a real minus sign (« −1 j »; units « j / h /
  DA », « يوم / سا / دج », « d / h / DZD »); value inputs accept `,` or `.`, spaces, `-`/`−`, two decimals at most,
  within ±999 999 999.99 (checked before sending). A note is sent as `null` when empty.
- Web builder 1: the employee panel is a modal dialog docked at the inline end (full width on phones); closing it
  removes `?employee=` (replace, no history entry). A line of a rubrique in `amount` is read-only without
  `employee.salary.update`; manual rubriques already on a line of the month are not offered again (the line itself is
  edited instead); a manual line's « Revenir au calcul » reads « Retirer la ligne ».
- Web builder 1: the payroll matricule stays editable in a **closed** month (with `payroll.prepare` and `edit`): it is
  not a value of the month and the closed snapshot keeps the matricule exported at close. Empty → `{code: null}`.

## Settled by the build (API)

API builder 1 (settings, rubriques, payroll matricules, export file, control report, migration 0024):

- **Seeded rubriques**: computed ones for every company (migration 0024 for existing companies, `seedPayrollDefaults` in `bootstrap`); one per leave type with placeholder codes `CG_ANNUEL`, `CG_RECUP` (inactive), `CG_MALADIE`, `CG_MATERNITE`, `CG_MARIAGE`, `CG_NAISSANCE`, `CG_MARIAGE_ENF`, `CG_DECES`, `CG_CIRCONCISION`, `CG_HADJ`, `CG_SANS_SOLDE` (another type: `CG_` + its code); the leave rubrique takes the type's names and order. A leave type created later gets no rubrique (HR has no way to add a `leave` rubrique yet). Manual rubriques (`PRIME_REND`, `AVANCE`, `IND_PANIER_J`) only in `seed:dev`.
- **Database backstops**: an adjustment of a month whose period row is `closed` is refused by a trigger (`payroll_adjustment_period_closed`); a closing only gets its reopen columns, once; periods and rubriques keep their identity (`source`, `leave_type_id`, `month`); no DELETE for the app role on policy, rubriques, periods, closings; no UPDATE/DELETE on lines. Distinct columns are checked by the API (the check constraint checks allowed keys, `matricule`, `rubrique` + `value`).
- **Settings**: `PUT /payroll/settings` is partial (fields sent replace, others kept); the column rule is checked on the result, so changing `layout` may need `columns` in the same request (422 `columns` `invalid`). `GET /payroll/settings` and the preview also need a company-wide grant (403 `forbidden-scope`), like the writes.
- **Preview**: the first 5 rows (header included) of a draft file of the current month company-wide; amount lines follow the caller's salary scope; invented lines (EMP-0001, EMP-0002, one régularisation) when there are none. Filename shown as `-brouillon`.
- **Rubriques**: new manual rubriques go after the last `sort_order` (+10); `PUT` on a computed rubrique with a different `unit` → 422 `unit` `fixed`; reactivating a rubrique whose code an active one now uses → 409 `payroll-code-taken`; an inactive rubrique's code may be reused.
- **Payroll matricule**: the employee's scope unit is today's (an ended employment: its last unit); outside `payroll.read` → 404, read without prepare → 403 `forbidden-scope`; `code: null` or `""` removes it; codes keep their case, uniqueness ignores it. A code equal to another employee's HRForce matricule is not refused.
- **Export**: `draft=true` on a closed month answers the closing file (no `-brouillon`); the unit filter must be a unit in the caller's `payroll.export` scope (else 404); **amount lines are left out for callers without `employee.salary.read` over the employee** (regional HR's file has no amounts), as in the variables view; the content type is `text/csv` whatever the extension. Byte-identical re-export holds while the settings and the rubriques' order are unchanged (rows are sorted by matricule, rubrique `sort_order`, export code, origin month). `per_employee` columns: active rubriques plus any rubrique that has a line. Text is NFC-normalised before encoding.
- **Control report**: lines with a value (or adjusted) of the closing / live month in the `payroll.read` scope; values with a decimal comma (`;` separator, so never quoted); « Ajusté » `Oui`/`Non` (`نعم`/`لا`); origin period in the configured period format; unit = its name (Arabic name with `lang=ar`); filename `etat-controle-paie-YYYY-MM[-<unit code>].csv`.
- Audit: ~~no column of the payroll tables is masked~~ — superseded by the verification below (the values are masked).

API builder 2 (computation, variables, adjustments, closings, régularisations, seed of the closing):

- **Days**: leave counts the request's days inside [max(1st, hire), min(last day, end)] — future approved days of the month count, "nothing after today" applies to the attendance sources only; a half day counts only on the request's own first / last day (Leave's `leaveDaysWithin`, exported with `LeaveFacts.payrollInputs`). Attendance sources read final days (< today) of the employed days ≤ today; lateness is counted only where attendance is in use, overtime wherever there are punches (manual punches included). A kiosk is in use at its site from its pairing day to its revocation day inclusive (a pending kiosk never). `no_attendance` needs at least one employed day so far. Attendance's `PresenceEngine` is exported (plus `kioskSpans()` and an optional instant for `load()`), computed per chunk of 200 employees.
- **Scope unit**: the assignment on min(month end, employment end, today) (never before the hire date) — the attendance report's rule. An employee no longer employed in the month still appears when a régularisation line of an earlier month brings them in (unit: their last day).
- **Zero lines**: a line with value 0 is dropped, **except HR's 0 over a non-zero computed value**: it shows (adjusted, so HR can revert it), is stored in the closing (`payroll_line_value_ck` relaxed to `value <> 0 or computed_value <> 0`) so the régularisation skips it, and is left out of the lines port (export / control report) and of the totals.
- **Régularisations**: the later closings' lines are subtracted by their **computed** value (HR changing a régularisation does not make it come back). An adjustment of an origin month whose delta is now 0 stays as a line (computed 0) until HR removes it. Activating a computed rubrique produces régularisations for the closed months of the window (the closings held no value for it). Line order: rubrique order, then the month's own line, then older origins.
- **Writes**: out of `payroll.read` scope → 404, readable without `payroll.prepare` → 403 `forbidden-scope`; an amount rubrique without `employee.salary.update` over the employee → 403 `forbidden-field` (PUT and DELETE); unknown rubrique → 422 `rubriqueId` `invalid` (DELETE: 404); a value with more than two decimals → 422; `originMonth` after the month or (régularisation) without a line for it → 422 `originMonth` `invalid`; a manual rubrique takes no `originMonth`. DELETE of an absent adjustment → 200 (idempotent). Writes take a share lock on the period row (created open when missing), so they never land in a month being closed.
- **Reads**: `GET …/variables/:employeeId` of an employee employed in the month but without lines (or absent from a closed month's snapshot) → an empty view; never employed in the window → 404. A closed month is read from its snapshot (export code and unit of the snapshot, current names), without flags. `employees` / `lines` / `totals` of a `PeriodView` count the lines with a value ≠ 0 the caller sees (amount lines only with `employee.salary.read`); `flags` count days (`incompleteDays`) and employees (`pendingLeave`, `noAttendance`). `closings` oldest version first. `_actions`: `close` only when the close would be accepted now (cut-off, previous-open rule) and the caller holds `payroll.close` company-wide; `reopen` on the latest closed month; `export` (closed) / `export_draft` (open) with any `payroll.export` scope.
- **Close / reopen**: `payroll.close` held only on a region → 403 `forbidden-scope` (a caller without it → 403 `forbidden`, the guard). The first closing ever needs no earlier month closed. `payroll_closing.lines` / `employees` count the lines with a value ≠ 0. Events `payroll.closed {month: 'YYYY-MM', version, lines, employees}` and `payroll.reopened {month, version, reason}` with no subject.
- **History**: the employee's History lists `payroll_adjustment` and `payroll_employee_code` rows (found through their insert, as they can be deleted) **except adjustments of amount rubriques** (bonuses, advances: salary data).
- **Seed** (`seedDemoPayrollClosing`, idempotent): payroll matricules `P-0001` (EMP-0001) and `P-0027` (EMP-0027); the previous month closed v1 by rh.admin with the real engine, a `PRIME_REND` of 15 000 for EMP-0029 and one computed line adjusted by −1 (else 20 `IND_PANIER_J`); then a sick leave of EMP-0005 on the 10th–11th of that month approved after the closing → `CG_MALADIE` +2 régularisation in the current month.

## Settled by the verification (gate and security, 2026-10-24)

Probes: `apps/api/test/payroll-security.e2e-spec.ts` (18 tests).

- **Scope:** for regional HR, `GET …/variables` with `unitId` of another region or company, or `q` matching an Ouest
  matricule, answers 200 with nothing (open and closed months); one Ouest or BETA employee → 404; PUT / DELETE of a
  line and `PUT /payroll/employee-codes/:id` on them → 404 and nothing written. The export, the draft and the control
  report with an Ouest or BETA `unitId` → 404; without a filter they hold the caller's rows only. Another company's
  rubrique id: PUT line → 422 `rubriqueId`, DELETE line → 404, `PUT /payroll/rubriques/:id` → 404.
- **Amounts:** without `employee.salary.read`, no amount line, code or value reaches the caller in the variables
  (list, one employee, the `rubriqueId` / `adjusted` filters), the period totals, the file, the draft, the control
  report (fr and ar).
- **Audit masking (decided by the verification):** `audit.capture()` masks per column, not per row, so
  `payroll_adjustment.value`, `payroll_line.value` and `payroll_line.computed_value` are in `audit.masked_column`
  (migration 0024): every value of these two tables is stored `***` in `audit.change_log`, days and hours too. The
  employee History (readable with `audit.read`, e.g. `admin_acces`) still names the rubrique and the note but shows
  the value masked; the payroll screen and the control report show the values. Amount adjustments stay out of the
  History (as built).
- **Closed month in a list:** a closed month lists the employees of its snapshot whose lines the caller can see; an
  employee whose only lines are amounts is left out for a caller without salary read (listing them told that they
  had a bonus or an advance). Fixed in `VariablesService.variables`.
- **Close / reopen:** `payroll.close` on a region only → 403 `forbidden-scope`; with two-step sign-in enforced, a
  company-wide holder without a factor → 403 `mfa-enrollment-required` and nothing closed;
  `security_policy_default_permissions()` lists `payroll.close`.
- **Closed months, down to the database (as `hrforce_app`):** insert, update, delete of an adjustment of a closed
  month, or moving one into it → refused by the trigger. **New backstop:** `payroll_line_guard` refuses a line
  unless its closing is current and was created in the same transaction (`closed_at = now()`), so a closed snapshot
  (and its file) never gains a line. No UPDATE / DELETE / TRUNCATE on lines, no DELETE on closings, periods,
  rubriques, policy; closings keep their counts. The worker writes nothing.
- **`payroll_line_value_ck` tightened** to `value <> 0 or (adjusted and coalesce(computed_value, 0) <> 0)`: a zero
  line is stored only as HR's 0 over a non-zero computed value (the relaxed form also accepted an unadjusted 0).
- **A close racing adjustments:** PUTs sent with a close each answer 200 (and are in the snapshot) or 409; every
  adjustment of the month equals its snapshot line (share lock on the period row).
- **Files:** a closed month's file is byte-identical across downloads (central and regional); `=…` names get `'`,
  names with `;` or `"` are quoted with `"` doubled, `Œ ’ €` are `0x8C 0x92 0x80`, Arabic-only names print `?`
  (spaces kept), no BOM; the control report (UTF-8 BOM) guards names and notes (`'=1+1`) and keeps Arabic names.
- **XSRF / anonymous / inputs:** every payroll write without the XSRF token → 403; every read anonymous → 401;
  malformed months (`2026-9`, `2026-13`, `202609`, `9999-12`, …) → 422 on every route; values beyond ±999 999 999.99,
  three decimals, strings, booleans, `null`, notes > 300, reasons > 300, extra body keys, codes outside
  `^[A-Za-z0-9_.\-]{1,20}$`, names > 80, unknown units, duplicate / unknown columns, out-of-range calendar settings,
  `year`, `page`, `pageSize`, `q` > 100, malformed `unitId` / `rubriqueId`, unknown `filter` / `lang` → 422.
- Test fix: `payroll.e2e` ordered the audit events by `at`, which the Windows Docker clock can move backwards (one
  failure in the first gate run); it now orders by `id`.
- **Dev databases** that applied 0024 before this change need `scripts/dev-up.* -Reset` (the migration's checksum
  changed).

## Settled by the verification (functional, 2026-10-24)

Driven in Chromium (fr and ar, 1280 and 390 px) on the dev stack with `seed:dev` (today 24/10, after the cut-off):
nav « Paie » for `rh.admin` / `rh.est` only (`lecture.ouest`, `agent.annaba`: no entry, 403 on the API); the month
bar (default October, September « Clôturé v1 », November–December disabled), header counts and flags, totals, the
EMP-0005 « Régul. 09/2026 CG_MALADIE 2 j » line; filters (rubrique, adjusted / régularisation / flagged, search,
unit + sub-units with the files hint) kept in the URL through reload and Back; cards at 390 px with no horizontal
overflow; the employee panel (adjust with a note, `1,234` refused, revert, manual line, `12 500,50` accepted,
`PRIME_REND` / `AVANCE` offered to `rh.admin` only, `rh.est` sees no amount line nor amount total, matricule paie
taken case-insensitively → translated 409), Escape closes it and focus returns to the row; close (keyboard, Escape
returns focus to the button) → v1, export twice byte-identical, reopen (short reason refused) → open, again in Arabic
→ v2; the draft file and the closed file (Windows-1252, no BOM, `;`, CRLF, `12500,5`, header, placeholder codes), the
control report fr / ar (UTF-8 BOM, translated header, Arabic names); settings: rubriques (duplicate code on create and
edit → « Ce code est déjà utilisé… », new rubrique appended), format (per employee + pipe, per line + label + origin
period: preview follows after save), calendar (cut-off 29 refused); the dashboard tile; the History.
**Values cross-checked by hand** against the Attendance and Leave screens for EMP-0029, EMP-0026, EMP-0035, EMP-0037:
`ABS_NJ` = absent working days from the kiosks' pairing day (4/10) to yesterday (attendance shows 1/10 absent too, not
counted: no kiosk yet — assumption 6); `CG_ANNUEL` 5 = 11–15/10 (Sun–Thu); the sick-leave régularisation 10–11/09 = 2
calendar days. Rechecked after the gate verifier's 0024 change (fresh database): close / reopen, History values
masked, `rh.est`'s closed list.

- **Payroll matricule in a closed month:** the variables view answered `_actions: []` for a closed month, so the
  field the web build settled as editable there was read-only. `_actions: ['edit']` now means `payroll.prepare` over
  the employee whatever the status (the month's lines still answer 409 and the web reads the status). e2e updated.
- **The matricule field** no longer shows capitals (`text-transform`) while keeping the typed case: `p-0029` looked
  like `P-0029` and was exported lower-case.
- **History:** `month` / `origin_month` of an adjustment print « octobre 2026 » (were « 1 oct. 2026 »); new timeline
  value kind `month` (unit test).
- **RTL year switch:** `‹ ›` are bidi-mirrored characters, so the extra `scaleX(-1)` pointed them backwards in Arabic.
- **Wording:** the format example names the real header (`periode`, not `période`; Arabic example isolated LTR); the
  Arabic column name of the matricule is « الرقم التعريفي » as on every other screen; the reopen sentence is isolated
  from the reason (`<bdi>`).
- Left as is (owner): units after a number print « 5 يوم » (abbreviation style, not « 5 أيام »); the default file
  has no `periode_origine`, so a régularisation line looks like a line of the month in the file; the close dialog
  focuses « Clôturer le mois » first; the header's « Salariés : 17 » (with lines) differs from the table's
  « Salariés : 38 » (employed); the seeded `IND_PANIER_J` name repeats its unit (« (jours) (j) »).

## Settled by the lead (2026-10-24)

- The close dialog opens with the focus on « Annuler » (closing is the consequential action).
- The period header's count reads « Salariés avec variables » (employees with at least one line); the table counts every employee employed in the month.
- The seeded manual rubrique `IND_PANIER_J` is named « Indemnité de panier » (its unit already says days).
- Kept as built, for the owner: the default export columns carry no `origin_period` (a régularisation is booked in the closing month, as most payroll imports expect); Arabic units without number agreement, as elsewhere in the app.
