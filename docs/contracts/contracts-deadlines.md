# Contract — Employment contracts and deadlines

Binding contract between `apps/api` (new modules `contracts` and `deadlines`, small additions to Employment,
Recruitment, Workflow, Notifications, the worker) and `apps/web` (an employee « Contrats » tab, the contract block of
the create/hire forms, a deadlines board, a dashboard tile, the contract-decision task). Owner decision 2026-10-19
(`docs/HANDOFF.md`): payroll stays in **PC-PAIE** (DLG); next slice is **contracts & deadlines** — record the contract
of every employment (type, dates, probation, renewals) and warn HR before the dates that cost money when missed.

Built by four builders in parallel (API ×2, web ×2, ownership below), then verified. No new infrastructure, no new
environment variable, no ADR: the worker and the workflow engine already exist (ADR 006).

## ⚠ Assumptions to confirm with the owner

| # | Assumption | Default in this contract | Where it lives |
|---|---|---|---|
| 1 | Contract types | `cdi`, `cdd`, `pre_emploi` (DAIP/CTA), `apprentissage`, `stage` — the recruitment list (`recruitment.md` assumption 4). All but `cdi` are **fixed-term** (an end date is required) | check constraint |
| 2 | Existing employees | Migration creates **no** contract for existing employments: each open one shows as « contrat non renseigné » on the board until HR records it (the real type is unknown) | board kind `contract_missing` |
| 3 | Probation | Optional end date on a contract; at most **12 months** after its start (Law 90-11 art. 18: 6 months, 12 for highly qualified posts — to confirm) | validation |
| 4 | A fixed-term contract that ends while the person keeps working | Shown as **overdue, critical** (« CDD échu sans suite ») from the day after its end until a following contract, a decision or the end of employment is recorded — a fixed-term contract continued past its term risks being treated as a CDI (Law 90-11 art. 14 — to confirm) | board kind `contract_end` |
| 5 | Decision before a fixed-term contract ends | **45 days** before the end, the daily job opens a **contract decision** task: the unit head proposes *renew* (new end date), *convert to CDI* or *end*; HR approves and the decision is applied. No unit head with an account → HR only (as leave) | `deadline_policy.decision_notice_days` (0 = off) |
| 6 | Notice periods | Probation **15 days**, contract end **30 days**, document expiry **30 days**, retirement **6 months** before | `deadline_policy` |
| 7 | Retirement | At **60** for everyone (Law 83-12 as amended in 2016; women may leave at 55 on request — not computed). Needs a birth date | `deadline_policy.retirement_age` |
| 8 | Documents that expire | Employee-file documents with an expiry date (`employee_file.expires_on`), not deleted or purged; **medical** files only for viewers holding `employee.medical.read` | board kind `document_expiry` |
| 9 | Who is warned | HR holding `deadline.read` over the employee's unit (central + regional HR); unit heads only through the contract-decision task. One **daily digest** notification per person when new items enter their notice window (no message per item), e-mail per preference | notifications |
| 10 | Handling | HR can mark an item **« Traité »** with an optional note (e.g. probation confirmed); it disappears from the to-do views and stays listable. A changed date (a new contract) is a new item | `deadline_ack` |
| 11 | No automatic changes | Nothing is changed in an employment without a person approving it: the job only lists, notifies and opens decision tasks | — |

## Data (migration 0023, owned by API builder 1)

All tenant tables: `company_id` + RLS/FORCE + standard policy, composite `(company_id, …)` FKs, audit trigger (no
exemptions). Users referenced without FK (like `role_grant.user_id`).

| Table | Columns | Rules |
|---|---|---|
| `employment_contract` | `id`, `company_id`, `employment_id`, `seq int` (1, 2, … per employment), `kind` (`initial` / `renewal` / `conversion` / `amendment`), `contract_type` (5 codes), `start_date date`, `end_date date null` (**last day**, inclusive), `probation_end date null` (last day of probation), `reference text null` (≤ 40, the paper contract number), `reason text null` (≤ 300, e.g. the CDD motive), `note text null` (≤ 500), `decision_id uuid null` (the contract decision that created it), `created_by`, `created_at` | unique (`company_id`, `employment_id`, `seq`); `end_date` null ⇔ `contract_type = 'cdi'`; `end_date >= start_date`; `probation_end` between `start_date` and `start_date + 12 months`; **no overlap** per employment (exclusion constraint on `daterange(start_date, end_date, '[]')`, needs `btree_gist` — create the extension in the migration if missing); `seq = 1` ⇔ `kind = 'initial'`; no DELETE for `hrforce_app` |
| `contract_decision` | `id`, `company_id`, `employment_id`, `contract_id` (the fixed-term contract ending), `status` (`pending` / `approved` / `rejected` / `cancelled`), `proposal` (`renew` / `convert_cdi` / `end`, null until proposed), `proposed_end_date date null` (renew only), `proposed_start_date date null` (default: the day after the contract end), `comment text null` (≤ 500), `proposed_by uuid null`, `proposed_at null`, `workflow_instance_id`, `result_contract_id uuid null`, `opened_by` (`system` or a user id, text), `created_at` | at most one `pending` per `contract_id` (partial unique index); `proposed_end_date` not null ⇔ `proposal = 'renew'`; no DELETE |
| `deadline_ack` | `id`, `company_id`, `kind` (`probation_end` / `contract_end` / `document_expiry` / `retirement` / `contract_missing`), `subject_id uuid` (contract id, employee-file id or employment id), `due_date date`, `note text null` (≤ 300), `acked_by`, `acked_at` | unique (`company_id`, `kind`, `subject_id`, `due_date`); DELETE allowed (undo) |
| `deadline_policy` (pk `company_id`) | `probation_notice_days` 15 (1–90), `contract_notice_days` 30 (1–180), `decision_notice_days` 45 (0–180, 0 = no automatic decision task), `document_notice_days` 30 (1–180), `retirement_age` 60 (50–70), `retirement_notice_months` 6 (1–24), `digest_enabled bool` true, `updated_at` | a company without a row uses these defaults |

Also: `workflow_instance.subject_type` check gains `contract_decision`; workflow definition **`contract.decision`**
seeded per company (migration for existing companies, `bootstrap` + seed helpers for new ones) =
`[{key: 'manager', kind: 'manager', labels: {fr: 'Responsable', ar: 'المسؤول', en: 'Manager'}}, {key: 'hr', kind:
'permission', permission: 'employee.contract.manage', labels: {fr: 'RH', ar: 'الموارد البشرية', en: 'HR'}}]` (the
manager step resolves and escalates exactly as for leave).

**Permissions** (catalogue, labels fr/ar/en, group `employees` for the first, new group `deadlines` for the others):

| Code | fr | ar | Granted to |
|---|---|---|---|
| `employee.contract.manage` | Gérer les contrats de travail | تسيير عقود العمل | `admin_rh_central`, `rh_regional` |
| `deadline.read` | Consulter les échéances | الاطلاع على الآجال | `admin_rh_central`, `rh_regional` |
| `deadline.handle` | Traiter les échéances | معالجة الآجال | `admin_rh_central`, `rh_regional` |
| `deadline.configure` | Paramétrer les échéances | إعداد الآجال | `admin_rh_central` |

Reading contracts needs `employee.read` (contract data is not sensitive). None is in the two-step list.

## Contracts (module `contracts`, API builder 1)

Rules (pure domain, unit-tested):
- A contract belongs to an employment; contracts never overlap; `seq` increases with `start_date`.
- `initial`: starts on the hire date (422 `startDate` `must_equal_hire_date` otherwise). One per employment.
- `renewal`: same fixed-term type family (`cdd` → `cdd`, `pre_emploi` → `pre_emploi`, …) starting the day after the
  previous contract's end (422 `startDate` `must_follow_previous`); `conversion`: to `cdi` (or another type), starting
  after the previous one; `amendment`: a new version for a change of terms (type may stay), starting after the previous
  start — the previous contract's `end_date` is then set to the day before (only when it was later or null).
- Writes on an employment whose end date has passed → 409 `employment-ended`; a contract starting after the employment
  end date → 422 `startDate` `after_employment_end`.
- Fixed-term without `endDate` / `cdi` with one → 422 `endDate` `required` / `not_allowed`; `probationEnd` out of range
  → 422 `probationEnd` `out_of_range`; overlap → 409 `contract-overlap`.
- **Current contract** on a date = the one whose range covers it; none → `null`.

| Method + path | Guard | Request → response |
|---|---|---|
| `GET /employees/:id/contracts` | `employee.read` (scope) | `{items: ContractView[] (newest first), currentId: string \| null}` |
| `POST /employees/:id/contracts` | `employee.contract.manage` (scope) | `{kind, contractType, startDate, endDate?, probationEnd?, reference?, reason?, note?}` → 201 `ContractView` |
| `PATCH /employees/:id/contracts/:contractId` | `employee.contract.manage` | correct `reference`, `reason`, `note`, `probationEnd`, and `endDate` of the **latest** contract only (409 `contract-not-latest` otherwise; shortening below a later decision's start → 409) → 200 |
| `POST /employees` (existing) | as before | optional block `contract: {contractType, endDate?, probationEnd?, reference?, reason?}` → creates the `initial` contract on the hire date in the same transaction (same 422s, field paths `contract.endDate` …) |
| recruitment hire (existing `POST …/hire`) | as before | the offer's `contractType` creates the `initial` contract; the body gains `contractEndDate?` (required for fixed-term → 422 `contractEndDate` `required`) and `probationEnd?`; rehire too |
| `GET /employees` (existing) | as before | items gain `contract: {type, endDate, probationEnd} \| null` (current, as of `asOf`/today); new filter `contractType=` (`cdi`…, or `none`) |
| `GET /employees/:id` (existing) | as before | detail gains the same `contract` summary and `_actions` gains `manage_contract` |

```ts
type ContractType = 'cdi' | 'cdd' | 'pre_emploi' | 'apprentissage' | 'stage';
interface ContractView { id: string; seq: number; kind: 'initial' | 'renewal' | 'conversion' | 'amendment';
  contractType: ContractType; startDate: string; endDate: string | null; probationEnd: string | null;
  reference: string | null; reason: string | null; note: string | null;
  decision: { id: string } | null; createdAt: string; createdBy: { id: string; displayName: string } | null;
  current: boolean; _actions: ('edit')[] }
```

### Contract decisions (module `contracts`, API builder 1)

- Opened by the daily job (`decision_notice_days` before a fixed-term contract's end, for an open employment, when no
  later contract and no pending/approved decision exist for it), or by HR: `POST /employees/:id/contracts/:contractId/decision`
  (`employee.contract.manage`) → 201; already pending → 409 `contract-decision-pending`; not fixed-term → 409
  `contract-not-fixed-term`.
- The current step's assignee records the proposal: `PUT /contract-decisions/:id/proposal` `{proposal, proposedEndDate?,
  proposedStartDate?, comment?}` → 200 (the manager at the manager step, HR at the HR step may change it). Rules:
  `renew` needs `proposedEndDate` > start; start defaults to the day after the contract end.
- Approve/reject through the existing `POST /tasks/:id/approve|reject`. Approving the **manager** step without a
  proposal → 409 `contract-decision-no-proposal`. Approving the **HR** step applies it **in the same transaction**:
  `renew` → a `renewal` contract (same type, proposed dates); `convert_cdi` → a `conversion` contract `cdi` from the
  proposed start; `end` → the employment end is recorded at the contract end date with reason « Fin de contrat »
  through the Employment use case (all its rules apply; a 409 there fails the approval). Reject → status `rejected`,
  nothing applied (HR acts manually). Self-approval rules as leave (`workflow-self-approval`).
- `GET /contract-decisions/:id` (`employee.read` in scope, or the task's assignee) → `ContractDecisionView`.
- Task summary: `{type: 'contract_decision', employee: {id, matricule, person, unit}, contract: {contractType,
  startDate, endDate}, proposal, proposedEndDate, proposedStartDate, comment}`.

```ts
interface ContractDecisionView { id: string; status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  employee: { id: string; matricule: string; person: NamePair; unit: UnitRef };
  contract: ContractView; proposal: 'renew' | 'convert_cdi' | 'end' | null;
  proposedStartDate: string | null; proposedEndDate: string | null; comment: string | null;
  proposedBy: { id: string; displayName: string } | null; proposedAt: string | null;
  workflow: { instanceId: string; status: string; currentStep: number; steps: WorkflowStepView[] };
  resultContractId: string | null; openedBy: 'system' | 'user'; _actions: ('propose')[] }
```

## Deadlines (module `deadlines`, API builder 2)

Computed at read time from contracts, employments, employee files and the policy (no stored deadline rows except
acks). Only **open** employments (no end date, or an end date in the future: items up to that end date). Scope = the
employee's unit (employment rule).

| Kind | Due date | Shown from | Status |
|---|---|---|---|
| `probation_end` | the current contract's `probation_end` | due − `probation_notice_days` | `due` until the date, then `overdue` for 30 days, then hidden |
| `contract_end` | a fixed-term contract's `end_date` with no following contract | due − `contract_notice_days` | `due`; **`overdue` (severity `critical`) from the next day while the employment is open** (assumption 4) |
| `document_expiry` | `employee_file.expires_on` | due − `document_notice_days` | `due`, then `overdue` |
| `retirement` | birth date + `retirement_age` years | due − `retirement_notice_months` | `due`, then `overdue` |
| `contract_missing` | the hire date (or today for a contract gap) | always | `overdue` (severity `warning`): an open employment with no contract covering today |

An acked item (`deadline_ack` on kind + subject + due date) has status `handled` and is excluded unless asked for.
Each item: `severity` = `critical` (contract_end overdue), `warning` (other overdue, contract_missing), `info` (due).

| Method + path | Guard | Request → response |
|---|---|---|
| `GET /deadlines?kind=&status=open\|handled\|all&unitId=&includeSubUnits=&within=&q=&page=&pageSize=` | `deadline.read` | `{items: DeadlineItem[], total, page, pageSize}`, overdue first then by due date; `within` days ahead (default 90, max 730); `status=open` (default) = due + overdue |
| `GET /deadlines/summary` | `deadline.read` | `{overdue: number, critical: number, next30: number, byKind: Record<kind, {overdue, due}>}` in the caller's scope |
| `POST /deadlines/acks` | `deadline.handle` (scope of the employee) | `{kind, subjectId, dueDate, note?}` → 201 `DeadlineItem` (status `handled`); the item must exist today with that due date (else 422 `subjectId` `not_found`); already acked → 409 `deadline-already-handled` |
| `DELETE /deadlines/acks/:id` | `deadline.handle` | 204 |
| `GET /deadlines/settings` | `deadline.configure` | `DeadlinePolicyView` (defaults when no row) |
| `PUT /deadlines/settings` | `deadline.configure` (company-wide) | the policy fields → 200; ranges → 422 |

```ts
interface DeadlineItem { key: string;            // `${kind}:${subjectId}:${dueDate}`
  kind: 'probation_end' | 'contract_end' | 'document_expiry' | 'retirement' | 'contract_missing';
  dueDate: string; daysLeft: number; status: 'due' | 'overdue' | 'handled'; severity: 'critical' | 'warning' | 'info';
  employee: { id: string; matricule: string; person: NamePair; unit: UnitRef; jobTitle: string };
  contract: { id: string; contractType: ContractType; startDate: string; endDate: string | null } | null;
  file: { id: string; title: string; category: { code: string; names: { fr: string; ar: string; en: string } } } | null;
  decision: { id: string; status: string } | null;   // contract_end: the pending/approved decision, if any
  ack: { id: string; note: string | null; at: string; by: { id: string; displayName: string } | null } | null;
  _actions: ('ack' | 'unack' | 'open_decision')[] }
interface DeadlinePolicyView { probationNoticeDays: number; contractNoticeDays: number; decisionNoticeDays: number;
  documentNoticeDays: number; retirementAge: number; retirementNoticeMonths: number; digestEnabled: boolean }
```

**Worker** (API builder 2 owns the job; it calls the contracts module's exported « open decision » use case): daily
cron `deadlines.daily` at 05:00 UTC (≈ 06:00 Algiers): (1) opens contract-decision tasks (assumption 5), (2) sends
each holder of `deadline.read` a `deadline.digest` notification when items **entered** their notice window or became
overdue since the previous run (`{newCount, overdueCount, criticalCount}`, link `/deadlines`), once per user per day
(notification_once on user + date). Runs per company with `app.company_id` set, idempotent on re-run.

**Notifications:** new type `deadline.digest` (in-app + e-mail on by default; neutral Arabic: « آجال جديدة للمعالجة:
n »). The decision tasks use the existing `task.assigned` with `subjectType: 'contract_decision'` (wording « Décision
de fin de contrat à prendre : <Name> » / « قرار بشأن نهاية العقد: <Name> »).

## Audit

Row triggers on the four tables. Events: `contract.decision_opened` `{contractId, by: 'system' | 'user'}`,
`contract.decision_applied` `{proposal, resultContractId}`. The `employee:<id>` timeline includes contracts and
decisions (labels `audit.fields.employment_contract.*`, `audit.fields.contract_decision.*`).

## Web

Every screen fr/ar/en, RTL, 390 px. i18n keys: web builder 1 under `contracts.*`, web builder 2 under `deadlines.*`
(and the few `tasks.*`, `notifications.*`, `audit.*` keys it needs).

**Web builder 1 — contracts**
- Employee detail: a **Contrats** tab (`employee.read`): the contracts table (type, kind, start, end, probation,
  reference, current badge), « Nouveau contrat » (renewal / conversion / amendment form with sensible defaults: start =
  day after the current end), « Corriger » on the latest one, pending decision link. The header shows the current
  contract (« CDD jusqu’au 30 juin 2027 ») and a warning when none.
- Employee create form and rehire form: a « Contrat » block (type, end date for fixed-term, probation end, reference,
  reason), required in the web.
- Recruitment hire form: end date (fixed-term) and probation end.
- Employees list: a contract type filter and a column « Contrat » (type + end date).

**Web builder 2 — deadlines and decisions**
- Board **`/deadlines`** (`deadline.read`, nav item « Échéances » with a count badge from `/deadlines/summary`):
  filters in the URL (kind, status, unit + sub-units, within, search); rows grouped Overdue / Next 30 days / Later;
  severity shown by a pill (critical, warning, info) and text, not colour alone; actions « Traiter » (dialog with
  note), « Annuler », « Ouvrir la décision », link to the employee (and to the file for documents); `.table-scroll` on
  phones.
- Dashboard tile « Échéances » (overdue, critical, next 30 days) for `deadline.read`.
- Settings **`/deadlines/settings`** (`deadline.configure`; or a tab in `/settings`, builder's choice): the policy form.
- My tasks: `contract_decision` tasks render the summary, a proposal form (renew with end date / convert to CDI / end,
  comment) saved with `PUT …/proposal`, then approve/reject; the HR step shows the proposal and can change it.
- Notification and timeline labels for the new types.

## Seed (`seed:dev`, API builder 1 for contracts and decisions, API builder 2 for policy/acks)

DEMO: contracts for most employees (a mix of CDI, CDD and one pré-emploi), including: a CDD ending in 20 days (in the
contract-end window), a CDD ended 3 days ago with the person still employed (critical), a probation ending in 10
days, an employee without a contract, an employee-file document expiring in 2 weeks, an employee reaching 60 within 6
months; one pending contract decision at the manager step for an Est employee whose head is `chef.annaba`; one acked
item. BETA: nothing.

## Authorization matrix rows (expected)

| Route | Rows |
|---|---|
| `GET /employees/:id/contracts` | as `GET /employees/:id` |
| `POST /employees/:id/contracts`, `PATCH …/:contractId`, `POST …/decision` | admin est/ouest ✓, other 404; est est ✓, est ouest 404; ouest (lecture) 403; acces 403; beta est 404; agent 403 |
| `PUT /contract-decisions/:id/proposal`, `GET /contract-decisions/:id` | the step's assignee ✓ (chef on its decision), est (HR step or read) as described, others 404/403 |
| `GET /deadlines`, `GET /deadlines/summary` | admin 200, est 200 (Est items only — asserted), ouest 403, acces 403, beta 200 (own), agent 403 |
| `POST /deadlines/acks`, `DELETE /deadlines/acks/:id` | admin ✓, est est ✓, est ouest 404, ouest 403, acces 403, beta on A 404, agent 403 |
| `GET/PUT /deadlines/settings` | CONFIG_ROWS (admin, beta ✓; est 403 on PUT, 403 on GET; acces, agent 403) |
| anonymous | 401 everywhere |

## Tests the build must add

- Domain: contract rules (every 422/409 above, overlap, renewal/conversion/amendment sequencing), current contract,
  deadline computation per kind with a pinned clock (window entry, overdue, hidden after 30 days, handled, ended
  employment, future end date, missing contract, medical files hidden), digest delta.
- E2E: create with contract, hire with contract, renew/convert/amend, decision opened by the job (once, idempotent),
  manager proposal → HR approval applies each proposal (renew/convert/end) atomically, reject, self-approval, board
  scope (est sees Est only), acks, policy, the job's digest once per user per day, audit exit criterion for every new
  write, matrix rows.
- Web: unit tests for every new screen and form (HttpTestingController), fr/ar parity.

## Build ownership (to avoid conflicts)

- **API builder 1:** migration 0023 (all four tables, permissions, workflow definition — written **first**),
  `schema.ts`, catalogue + `SYSTEM_ROLES`, module `contracts` (contracts, decisions, workflow subject), the Employment
  and Recruitment changes, seed of contracts/decisions, matrix rows and audit coverage for its routes.
- **API builder 2:** module `deadlines` (computation, board, summary, acks, policy endpoints), the daily job and
  cron entry, `deadline.digest` notification type and mail template, seed of policy/acks, matrix rows and audit
  coverage for its routes. It waits for migration 0023 before running DB tests (domain and unit tests first).
- **Web builder 1:** contracts screens (above). **Web builder 2:** deadlines, decisions, dashboard, nav, routes for
  `/deadlines`.
- Shared files (`catalogue.ts`, `notifier.ts`, `authorization-matrix.e2e-spec.ts`, `audit.e2e-spec.ts`,
  `app.routes.ts`, `fr/ar/en.json`, `seed-dev.ts`): **re-read just before each edit, make small targeted edits, never
  rewrite the whole file**, keep your keys in your own section.

## Settled by the verification (gate and security, 2026-10-19)

Probes: `apps/api/test/contracts-deadlines-security.e2e-spec.ts` (14 tests).

- **Board filters stay in scope:** `GET /deadlines` with `unitId` of another region or company, or `q` matching an
  Ouest matricule, answers 200 with nothing for regional HR (no 404, nothing to learn); `within` > 730 or a malformed
  `unitId` → 422. The employee list's `contractType` filter is applied on top of the read scope.
- **Medical files:** hidden from the board, the acks and the digest without `employee.medical.read` over the unit
  (no role holds it today); a holder sees and handles them in its scope only. An ack on a medical file by someone
  without the permission → 422 `subjectId` `not_found` (as any item that does not exist for the caller).
- **Acks:** a subject of another region, of another company, or an id under the wrong kind → 404; a wrong due date →
  422. `DELETE` of an ack of another company or region → 404.
- **Settings:** `GET` needs `deadline.configure` anywhere; `PUT` with a regional grant only → 403 `forbidden-scope`.
- **Decisions:** the manual open starts the workflow as the system actor, so the HR user who opened it may approve the
  HR step (the manager step stands between); the employee's linked user is excluded at every step (`workflow-self-
  approval`, and 403 `contract-decision-not-assignee` on the proposal); the employee cannot read their decision (404).
  The daily job never reopens a contract whose decision was **rejected** (HR acts by hand) but does reopen one whose
  decision was cancelled; it opens nothing for a contract already ended.
- **Atomic approval:** when the proposal no longer fits at the HR approval (e.g. a renewal recorded by hand meanwhile)
  the approval fails (4xx) and nothing persists: task open, decision and instance `pending`, no contract, no audit
  event. Two concurrent manual opens → one 201, one 409; two concurrent HR approvals → one 200, applied once.
- **Daily job:** each company in its own transaction and context (decision, instance, tasks and notifications carry
  that company); a second run the same day writes nothing. The digest data is counts only (`newCount`,
  `overdueCount`, `criticalCount`, `date`, plus the notifier's `audience`).
- **Fixed by the verification:** an escalated manager step of an instance started by the system (no manager with an
  account, e.g. a decision about a region head) wrote a `task.escalated` notification for the non-existent user
  `00000000-…` (`SYSTEM_ACTOR_ID`); the engine now tells no requester when the system started the instance.

## Settled by the verification (functional, 2026-10-19)

Driven in Chromium (fr and ar, 1280 and 390 px) on the dev stack with `seed:dev`: the Contrats tab, the create /
rehire / recruitment-hire contract block, the employees list column and filter, the board as `rh.admin` and `rh.est`
(Est only), « Traiter » / « Annuler », « Lancer la décision », the decision flow (`chef.annaba` proposes, `rh.est`
changes and approves; renew, convert_cdi, end, reject), the daily job (once; digest once per user and day, bell and
Mailpit e-mail in fr and ar), the settings, the dashboard tile and nav badge (equal to the board summary), History.

- **A CDI may get an end date when a later contract supersedes it.** An amendment (or a conversion) after a CDI cuts
  the CDI to the day before the new contract; the check constraint refused that (500). `employment_contract_end_ck`
  is now `end_date is not null or contract_type = 'cdi'` (fixed-term needs an end; the API still refuses an end date
  on a CDI typed by a user, 422 `endDate` `not_allowed`). e2e: `contracts.e2e-spec.ts` (amendment of a CDI).
- **Recording the initial contract on the Contrats tab:** an employment without any contract (every employment that
  existed before migration 0023, assumption 2) offers « Contrat initial » only, starting on the hire date (read-only);
  after a CDI « Renouvellement » is not offered (only a fixed-term contract is renewed); a conversion after a CDI
  leaves the new type to choose.
- **Translated rule messages:** the tab shows the 422 codes `must_follow_previous`, `must_match_previous`,
  `must_equal_hire_date`, `after_employment_end`, `out_of_range`, `before_start`, `not_allowed` and the 409 slugs
  `contract-not-fixed-term`, `contract-initial-exists`, `contract-initial-missing`, `contract-changed` (and
  `contract-not-latest` on a decision) in the UI language (the API's `message` is English).
- **Probation bound:** the last allowed probation end is the day **before** start + 12 months, and never after the
  contract's end (the API's and the database's rule); the web said start + 12 months.
- **Dates:** the board, the decision panel and the task list print ISO days as that day in every time zone (they used
  the date pipe's `'UTC'` zone, which printed the day before east of UTC).
- **Employee header:** names the probation only while it runs; no « Contrat non renseigné » warning for a future
  hire (its contract starts on the hire date; the list shows nothing either). An **approved** decision no longer shows
  the « Décision en cours » badge on the contract it decided.
- **E-mails of a contract-decision task:** `task.assigned` / `task.escalated` with `subjectType: 'contract_decision'`
  were worded as a leave request with empty dates; now « HRForce — décision de fin de contrat à prendre : <Nom> » /
  « HRForce — قرار بشأن نهاية العقد: <الاسم> » with the contract end date.
- **History:** the end reason of an employment reads « Fin de contrat » (was `end_of_contract`); the decision's
  `updated_at` line is hidden.
- **Board horizon:** `within` adds due items up to that many days ahead, but an item whose notice window has started
  always shows (a retirement six months ahead stays on a 30-day board) — as built.
- **After a rejection** the daily job does not reopen a decision for that contract (HR acts by hand); the board item
  then shows no decision.
- **Seed:** `seed:dev` adds an Est passport expiring in 14 days (open on the board) and an Ouest driving licence
  expiring in 5 days (the seed's handled item).

## Settled by the lead (2026-10-20)

- The worker role's new UPDATE rights are column grants: `contract_decision (workflow_instance_id)` and `workflow_instance (current_step)` (migration 0023; the daily job needs nothing more). A database migrated with an earlier draft of 0023 must be recreated (checksum).
