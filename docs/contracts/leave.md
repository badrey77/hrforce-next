# Contract — Leave, approval workflow and "My tasks" (M2, step 1)

Binding contract between `apps/api` (Workflow, Leave, self-service link, unit heads) and `apps/web` (My leave, My tasks, HR leave screens).
Decisions (owner, 2026-09-26): **Algerian defaults** for leave rules, kept as editable data and listed below for confirmation; default approval chain **unit head (manager) → regional HR**, configurable per leave type.

## ⚠ Assumptions to confirm (Law 90-11 of 21 April 1990 and common practice)

| Rule | Default | Where it lives |
|---|---|---|
| Annual leave accrual | 2.5 days per month of actual work, max **30 calendar days** per year of work (art. 41) | `leave_type.accrual_days_per_month`, `max_days_per_year` |
| Reference period | 1 July → 30 June; entitlement earned in period N is taken from 1 July N | `leave_policy.reference_start_month` = 7 |
| Southern regions supplement | ≥ 10 extra days/year for sites in the South (art. 42); **off by default**, a per-site flag | `site.south_supplement_days` (default 0) |
| Counting | annual leave counted in **calendar days**; other types as listed | `leave_type.count_mode` (`calendar` / `working`) |
| Weekend (for `working` mode) | Friday + Saturday | `leave_policy.weekend_days` |
| Public holidays (for `working` mode) | table per company; seed 2026–2027 fixed-date holidays (1 Jan, 12 Jan Yennayer, 1 May, 5 Jul, 1 Nov) and the lunar ones marked `approximate` (Eid al-Fitr, Eid al-Adha, Awal Muharram, Ashura, Mawlid) — HR must confirm dates each year | `public_holiday` |
| Special paid leave (art. 54) | marriage of the worker 3 days, birth of a child 3 days, marriage of a child 3 days, death of spouse/ascendant/descendant/sibling 3 days, circumcision of a child 3 days, pilgrimage 30 days once per career | `leave_type` rows, `max_days_per_request`, `once_per_career` |
| Maternity | 98 days (14 weeks), paid by social security | `leave_type` `maternity` |
| Sick leave | recorded with a medical certificate reference; no balance | `leave_type` `sick`, `requires_document=true` |
| Unpaid leave | allowed, no balance, HR-only approval chain | `leave_type` `unpaid` |
| Recovery (récupération) | balance fed by HR adjustments only | `leave_type` `recovery` |

Every number above is **data**, editable by users with `leave.configure`; nothing is hard-coded in the engine.

## Links added to M1 data (migration 0011)

- `user_employment` (tenant): `company_id`, `user_id`, `employment_id`, unique per (`company_id`,`user_id`) and per `employment_id`. Managed in Access → user detail ("Linked employee"), permission `access.grant`. Self-service needs this link.
- `org_unit_head` (tenant): `company_id`, `org_unit_id`, `employment_id`, `valid` daterange, no overlap per unit. Managed in Organization → unit detail ("Head of unit"), permission `org_unit.update`.
- **Manager of an employee** on date D = head of their assignment unit on D; if there is none, or the employee **is** that head, walk up the tree to the nearest ancestor with a head who is not the employee. The approving **user** = the user linked to that head's employment. No linked user → the step is **escalated** to the HR step (recorded on the task).

## Workflow engine (module `workflow`, ADR 006)

Generic, Postgres-only, synchronous state machine (no BPMN, no queue).

| Table | Columns |
|---|---|
| `workflow_definition` | `id`, `company_id`, `code` (e.g. `leave.manager_then_hr`), `name_fr/ar/en`, `steps jsonb` = ordered `[{key, kind: 'manager' \| 'permission', permission?, labels}]`, `is_system` |
| `workflow_instance` | `id`, `company_id`, `definition_id`, `subject_type` (`leave_request`), `subject_id`, `status` (`pending`/`approved`/`rejected`/`cancelled`), `current_step`, `started_by` (user), `started_at`, `finished_at` |
| `workflow_task` | `id`, `company_id`, `instance_id`, `step_key`, `step_index`, `assignee_kind` (`user`/`permission`), `assignee_user_id` null, `permission` null, `scope_unit_id` (the employee's unit), `status` (`open`/`done`/`skipped`/`cancelled`), `outcome` (`approve`/`reject`/`escalated`) null, `acted_by` null, `acted_at` null, `comment` null, `created_at` |

Rules:
- **Candidates of an open task:** `assignee_kind=user` → that user; `permission` → every user holding `permission` with `scope_unit_id` in its scope (ScopeService, evaluated at read time, so grants added later apply).
- **Separation of duties:** nobody acts on a task for their own request (`workflow-self-approval` 409); the requester is excluded from candidate lists.
- `approve` moves to the next step (or finishes `approved`); `reject` finishes `rejected` (comment required); the requester may `cancel` while pending; every action writes an `audit.event` (`workflow.<action>`) plus the row triggers.
- Subject hooks: the Leave module registers callbacks `onApproved`, `onRejected`, `onCancelled` (e.g. to update balances); called in the same transaction.
- Concurrency: acting takes a row lock on the task; a second actor gets 409 `workflow-task-closed`.

## Leave (module `leave`)

| Table | Columns |
|---|---|
| `leave_policy` | `company_id` pk, `reference_start_month` (7), `weekend_days int[]` ({5,6} = Fri, Sat; ISO day numbers) |
| `leave_type` | `id`, `company_id`, `code`, `name_fr/ar/en`, `count_mode`, `has_balance`, `accrual_days_per_month` null, `max_days_per_year` null, `max_days_per_request` null, `once_per_career`, `requires_document`, `workflow_definition_id`, `active` |
| `public_holiday` | `id`, `company_id`, `date`, `name_fr/ar/en`, `approximate bool` |
| `leave_request` | `id`, `company_id`, `employment_id`, `leave_type_id`, `start_date`, `end_date` (inclusive), `days numeric(5,1)` (computed server-side), `half_day_start bool`, `half_day_end bool`, `reason` null, `document_ref` null, `status` (`pending`/`approved`/`rejected`/`cancelled`), `requested_by` (user), `requested_at`, `workflow_instance_id` |
| `leave_ledger` | `id`, `company_id`, `employment_id`, `leave_type_id`, `period_start date` (reference year start), `kind` (`accrual`/`taken`/`adjustment`/`reversal`), `days numeric(5,1)` (+/-), `request_id` null, `note` null, `created_by`, `created_at` — append-only |

- **Balance** for (employee, type, reference year) = sum of the ledger. Accrual rows are written by `POST /leave/accruals/run` (HR, idempotent per employee/month — the M2 worker will call it monthly) from months of service in the reference period (a month counts if ≥ 15 days worked; document it).
- Approved request with `has_balance` → a `taken` ledger row (negative) against the **oldest** reference year with remaining days first; cancelling an approved future request writes a `reversal`.
- Validation (409 slugs): `leave-overlap` (another pending/approved request intersects), `leave-balance` (days > available incl. pending), `leave-max-request`, `leave-once-per-career`, `leave-dates` (end < start, or outside the employment), `leave-document-required`, `leave-not-linked` (self-service without a linked employment).
- `days` is computed from `count_mode`, weekend, holidays and half days; the API returns the breakdown.

## Permissions (catalogue additions, labels fr/ar/en)

`leave.request_self` (everyone linked; given to a new system role `employe` = self-service), `leave.read` (see requests of employees in scope), `leave.request` (create on behalf of an employee in scope), `leave.approve_hr` (the HR step), `leave.adjust` (ledger adjustments, accrual run), `leave.configure` (types, holidays, policy, workflow definitions). System roles: `admin_rh_central` gets all leave permissions; `rh_regional` gets `leave.read`, `leave.request`, `leave.approve_hr`, `leave.adjust`; new role `employe` gets `leave.request_self`. The manager step needs **no permission**: being the unit head's linked user is enough.

## Endpoints (under `/api`)

| Method + path | Guard | Purpose |
|---|---|---|
| `GET /me/employment` | `@Authenticated` | linked employment summary or 404 |
| `GET /me/leave/balances?asOf=` | `leave.request_self` | balances per type and reference year |
| `GET /me/leave/requests` | `leave.request_self` | own requests, newest first |
| `POST /me/leave/requests` | `leave.request_self` | `{leaveTypeId, startDate, endDate, halfDayStart?, halfDayEnd?, reason?, documentRef?}` → 201 |
| `POST /me/leave/requests/:id/cancel` | `leave.request_self` | pending, or approved and not started |
| `POST /leave/preview` | `leave.request_self` or `leave.request` | `{employmentId?, leaveTypeId, startDate, endDate, halfDay…}` → `{days, breakdown:{calendarDays, weekendDays, holidays:[{date,name}]}, balanceAfter}` (no write) |
| `GET /leave/types`, `GET /leave/holidays?year=` | authenticated | reference data (labels in fr/ar/en) |
| `PUT /leave/types/:id`, `POST/PUT/DELETE /leave/holidays…`, `PUT /leave/policy` | `leave.configure` | configuration (holidays may be deleted; history via audit) |
| `GET /leave/requests?status=&unitId=&includeSubUnits=&from=&to=&typeId=&q=&page=&pageSize=` | `leave.read` | HR list, scoped |
| `GET /leave/requests/:id` | owner, a current candidate, or `leave.read` in scope | detail incl. workflow steps and task history |
| `POST /employees/:id/leave/requests` | `leave.request` | on behalf |
| `GET /employees/:id/leave/balances`, `…/ledger` | `leave.read` | per employee |
| `POST /employees/:id/leave/adjustments` | `leave.adjust` | `{leaveTypeId, periodStart, days, note}` |
| `POST /leave/accruals/run` | `leave.adjust` | `{month: 'YYYY-MM'}` → counts (idempotent) |
| `GET /tasks?status=open` | `@Authenticated` | **My tasks**: open tasks where the caller is a candidate, with subject summary (employee name, type, dates, days) |
| `POST /tasks/:id/approve` / `reject` | `@Authenticated` (+ candidate check) | `{comment?}` (reject requires comment) |
| `PUT /org/units/:id/head` | `org_unit.update` | `{employmentId, validFrom}` (closes the previous head) |
| `PUT /access/users/:id/employment` | `access.grant` | `{employmentId}` or `null` to unlink |

All new tables: tenant RLS, audit triggers (automatic via guardrail), composite FKs; `leave_ledger` and `workflow_task` history append-only for the app role (no DELETE; UPDATE only on open tasks' status columns).

## Seed additions

Leave policy, the types above with the defaults, 2026–2027 holidays (lunar ones `approximate`), the default workflow `leave.manager_then_hr` (+ `leave.hr_only` for unpaid), heads for DG, DEP-RH, REG-EST, AG-ANNABA, AG-CNE (employees from the seed), **links**: `rh.est@demo.dz` ↔ the Région Est director employment (so Karim is both HR and a manager), plus two new demo users linked to employees: `agent.annaba@demo.dz` (Agence Annaba employee, role `employe`) and `chef.annaba@demo.dz` (head of Agence Annaba, role `employe`). Accruals run for Jul–Sep 2026 and a few requests in each status.

## Web

- **My leave** (`/me/leave`, needs a linked employment): balances cards per type and year, request form (type, dates, half days, live preview of days with weekend/holiday breakdown via `POST /leave/preview`, balance after), list of my requests with status and workflow progress, cancel.
- **My tasks** (`/tasks`, visible to everyone authenticated; badge with the open count in the nav): list with employee, type, dates, days, step; detail panel showing the request, the employee's balance, the step history; Approve / Reject (reject needs a comment).
- **HR leave** (`/leave`, `leave.read`): filterable scoped list (URL state like employees), request detail with steps; on the employee detail page a **Leave** tab (balances, ledger, adjustments with `leave.adjust`, "request on behalf").
- **Configuration** (`/leave/settings`, `leave.configure`): leave types table (edit numbers/labels), holidays per year (approximate ones flagged), policy (weekend, reference month).
- Organization unit detail: "Head of unit" (employee picker, from date). Access user detail: "Linked employee" (employee picker).

## Settled by the build (verified 2026-09-27)

Behaviour the implementation settled where the contract above was silent; the API (`apps/api/src/modules/{leave,workflow,staffing}`) and the web (`apps/web/src/app/core/{leave,tasks}`) both follow it.

**Extra endpoints / fields**
- `GET /leave/policy` (authenticated) → `{referenceStartMonth, weekendDays, entitlementDelayMonths}`; `entitlementDelayMonths` (default 12, 0–24) = months after a reference year starts before its accrued days are usable (non-accrued balance types: at once). `PUT /leave/policy` accepts it (optional).
- `GET /leave/workflows` (`leave.configure`) → `{items: [{id, code, names:{fr,ar,en}, isSystem, steps}]}`.
- `PUT /leave/types/:id` also accepts `countMode`, `hasBalance`, `oncePerCareer`, `workflowDefinitionId`, `sortOrder` (all optional).
- Reference-data labels are `labels: {fr, ar, en}` (types, holidays, workflow steps).
- Balances: `{asOf, items: [{leaveTypeId, leaveTypeCode, periodStart, periodEnd, availableFrom, accrued, taken, adjusted, balance, pending, available}]}` (days = JSON numbers, one decimal).
- Preview: `breakdown.halfDays` and `warnings[]` (the 409 slugs a submit would hit; the preview itself answers 200); holiday `name` = labels.
- List items: `{id, employee:{id, matricule, person, unit}, leaveTypeId, leaveType:{code, labels}, startDate, endDate, days, halfDayStart, halfDayEnd, status, requestedAt, workflow:{instanceId, status, currentStep, steps:[{key, kind, permission?, labels, state}]}}`; step `state` ∈ `done|current|pending|escalated|rejected|cancelled|skipped` (skipped = not reached). Detail adds `reason`, `documentRef`, `requestedBy`, `history[]` (tasks oldest first: `assignee {kind: user|permission|none}`, status, outcome, actedBy, actedAt, comment), `balances` (the employee's, for the request type — the manager step's approver holds no `leave.read`) and `_actions` (`cancel`).
- `GET /tasks` items: `{id, instanceId, stepKey, stepIndex, stepLabels, escalated, createdAt, subject: <list item without workflow> + {type}}` — no salary/NSS/RIB/contact data.
- `GET /me/employment` also returns `manager` (today's manager card or null). `PUT /access/users/:id/employment` → `{userId, employment}`. `PUT /org/units/:id/head` accepts `employmentId: null` (ends the current head on `validFrom`), `validFrom` defaults to today, → `{unitId, head, heads[]}`; the current head is `head` on `GET /org/units/:id`.
- `POST /leave/accruals/run` → `{month, employees, eligible, created, alreadyAccrued}`; a future month → 422.

**Status codes and slugs**
- Extra 409 slugs: `leave-not-cancellable`, `leave-type-inactive`, `holiday-date-taken` (field `date`), staffing `head-date`, `employment-ended`, `employment-linked`, `link-self` (nobody links their own account).
- Reject without a comment → **422** (`errors[].field = comment`), not 409. A task the caller is not a candidate of (or unknown / other company) → **404**; the requester or the employee's linked user → 409 `workflow-self-approval`; already handled → 409 `workflow-task-closed`.
- `GET /leave/requests/:id` for anyone else (incl. a manager after acting) → 404. `POST /leave/preview` with another `employmentId` needs `leave.request` over them (404 otherwise; 403 `forbidden-scope` when only `leave.read` covers them).
- Manager-step escalation reasons (the skipped task's comment): `no-manager`, `manager-not-linked`, `manager-is-requester`. The same user may act on two successive steps (e.g. Karim as the chef's manager and as regional HR).
