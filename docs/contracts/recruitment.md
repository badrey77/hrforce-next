# Contract — Recruitment: job openings, candidate pipeline, interviews, hire

Binding contract between `apps/api` (new module `recruitment`; small additions to Employment, Documents, Staffing,
Workflow, Notifications, Audit, the worker and the deploy pack) and `apps/web` (Recrutement, Mes recrutements, Mes
entretiens, the hire form, settings, home counts). Owner decision (2026-10-07): **internal tracking only** — HR enters
candidates and uploads their CV; **no public careers page, no anonymous access**; first slice = openings approved
through the workflow engine, a candidate pipeline per opening, interviews with interviewers' scores, and **hire creates
the employee**; data of unsuccessful candidates is erased 12 months after the decision by the worker.

Two phases, one contract. **Phase A** (build now): openings and their approval, candidates and applications, the
pipeline board (stages up to *interview*, rejection, withdrawal, reopening), candidate files, notes, settings
(rejection reasons, policy), retention purge and erasure on request, the head's restricted view, home counts.
**Phase B** (after A is verified): evaluation criteria, interviews and evaluations, *Mes entretiens*, the comparison
view, offers, hire and its undo. Phase B adds tables and endpoints; it changes nothing Phase A defines except the
columns, check constraints and view fields it lists.

All four owner-requested features are covered: openings + approval (A), pipeline (A; the *offer* and *hired* stages
become reachable in B), interviews (B), hire (B).

**No ADR is needed.** Every structural choice applies an accepted one: files in Postgres `bytea` behind a content
table (ADR 005, ADR 008, the employee file of `documents.md` Phase B); approval through the existing engine (ADR 006);
scope by org unit with 404 outside it (ADR 002); the hire is **one request transaction** in one database (ADR 001/005:
one transaction per request — no saga, no compensation); the audit of personal tables as events without payload is the
attendance pattern (owner decision 2026-09-29). The two real choices — a parallel file table instead of sharing
`employee_file`, and candidate identity separate from the application — are local to this module and argued below.

## ⚠ Assumptions to confirm with the owner

| # | Assumption | Default in this contract | Where it lives |
|---|---|---|---|
| 1 | Approval chain | **Manager → HR**, the leave chain: the manager step goes to the head of the opening's unit, or — when the requester **is** that head, the usual case — to the nearest head above; no head with an account → escalated to HR. `recruitment.hr_only` available as a policy switch | `recruitment_policy.opening_workflow_code` |
| 2 | Who may request an opening | The **head of the unit** (or of a unit above it), without any permission, and HR holding `recruitment.manage` over the unit. Other employees cannot | use-case rule |
| 3 | HR approval step | `admin_rh_central` and `rh_regional` (in their region) both approve openings (`recruitment.approve_opening`), like leave. A user never approves their own request | seed (Permissions) |
| 4 | Contract types | `cdi`, `cdd`, `pre_emploi` (DAIP/CTA), `apprentissage`, `stage` — a fixed list in code | check constraint |
| 5 | Posts | 1–99 per opening. After approval the number can only be **lowered** (more posts = a new request, so the approval is not bypassed). An opening is **filled** automatically when hires = posts | `recruitment_opening` |
| 6 | Stages | `received → shortlisted → interview → offer → hired`, plus `rejected` and `withdrawn` (the person gave up or declined the offer). Fixed in code, not configurable | check constraint |
| 7 | Rejection reasons | A company list (seeded, editable); a reason is **required** to reject, a comment is optional | `recruitment_rejection_reason` |
| 8 | When an opening is filled or closed | The applications still in progress are closed automatically (`rejected`, system reason « Poste pourvu » / « Recrutement clôturé »); that date is their decision date for retention. Undoing the hire or reopening the opening restores them | stage rules |
| 9 | Who sees candidates | `admin_rh_central` everything; `rh_regional` in its region (read, manage, hire); **`lecture` and `admin_acces`: nothing**; **heads** of the opening's unit (or of a unit above) see their openings' candidates in a restricted view (name, stage, files, Phase B scores — never NIN, birth data, contact details, salary or HR notes) without a grant; **interviewers** see only the candidates they must evaluate, while the application is in progress | seed + use-case rules |
| 10 | Salary | The expected salary and the proposed salary are sensitive: read `recruitment.salary.read`, write `recruitment.salary.update`, held by **`admin_rh_central` only** (as employee salaries). Regional HR runs the pipeline without seeing them | seed (Permissions) |
| 11 | Retention | **12 months** after the decision (rejection, withdrawal, automatic closing), editable 1–60. Erased: identity, contact details, files, notes, interview comments and scores, offer, salary, free-text comments. Kept: an anonymous application row (opening, source, final stage, reason code, dates) for counts | `recruitment_policy.retention_months` |
| 12 | Hired candidates | The recruitment-side data of a **hired** person (notes, evaluations, the candidate record) is erased by the same job 12 months after the hire; what lives on is the employee record, the CV copied into the employee file and the link opening ↔ employment | retention rule |
| 13 | Applications never decided | An application left in progress on an opening that stays open is **not** erased (no decision date). HR closes stale openings; the candidates list has a « sans mouvement depuis 6 mois » filter | — |
| 14 | Evaluation (Phase B) | Scores **1–5** (whole numbers) per criterion + a recommendation (`strong_yes`/`yes`/`no`/`strong_no`) + a comment. Criteria are a **company list** (5 seeded), copied to each opening when it opens and adjustable per opening until the first evaluation | `recruitment_criterion`, `recruitment_opening_criterion` |
| 15 | Interviewers (Phase B) | 1–5 HRForce users per interview, chosen by HR; an interviewer sees neither the other evaluations nor HR notes | use-case rule |
| 16 | Offers (Phase B) | Recorded in HRForce only (job title, unit, site, contract type, start date, salary); **no offer letter is generated** and nothing is sent. Offers in progress + hires never exceed the posts | `recruitment_offer` |
| 17 | Internal mobility | Out of scope: a person with an **open** employment cannot be hired through an opening (it is a new assignment, done on the employee). A **former** employee is linked to the existing person and the hire is a rehire | hire rule |
| 18 | Files | PDF, JPEG, PNG by content, the employee-file size limit (`EMPLOYEE_FILE_MAX_BYTES`, 10 MB), no antivirus (as `documents.md` assumptions 12–13). Kinds: CV, lettre de motivation, diplôme, pièce d'identité, autre | code |
| 19 | CV into the employee file | At hire, the chosen candidate files (the CV by default) are copied into a new system category of the employee file, **« Recrutement »** | `employee_file_category` `recruitment` |
| 20 | ANEM | An opening can carry an ANEM offer reference and an application the source `anem` (employers recruit through the agency — Law 04-19); both optional, informative | `anem_reference`, `source` |
| 21 | Information notice (Law 18-07) | A printable fr/ar notice (text in *Web*) that HR hands to candidates; HR may record the date it was given. The owner checks whether an ANPDP declaration and a consent form are needed | web, `informed_on` |
| 22 | No messages to candidates | HRForce sends **nothing** to candidates in this slice (no e-mail, no SMS). Notifications to users never contain a candidate's name | notifications |

**Questions for the owner (not assumptions):** (a) should HR (not only the head) be told when an opening they did not
request is approved in their region? (not built); (b) candidates' right of access: an export of one candidate's data
is not built — HR prints the candidate page; (c) backups keep erased data up to `BACKUP_RETENTION_DAYS` (as the
employee file).

**Extension points (not built).** *Public application page*: a candidate is already a record of its own with contact
details and files, and an application has a `source`; a public page would add the source `careers_page`, an unguarded
`POST` creating `candidate` + `application` in stage `received` with `created_by` null (both columns are nullable for
that reason), a captcha/rate limit and a consent record. *Messages to candidates*: `recruitment_candidate.email` and
the notification job are the hook. *Offer letter*: a document type of `documents.md` fed by `recruitment_offer`.

> **Owner decisions 2026-10-07:** assumptions **1, 9, 10 and 12 confirmed**. (1) Approval is manager → HR; a unit head's own request goes to the head above, then HR (nobody approves their own request). (9) Unit heads see the candidates of their units' openings in the restricted view; interviewers see only the candidates they evaluate while the application is active; `lecture` sees nothing. (10) Expected and proposed salaries are visible to `admin_rh_central` only. (12) A hired person's recruitment-side data (notes, interview scores and comments) is erased 12 months after the hire; the employee record, the CV copy and the link to the opening remain. The other assumptions stay defaults to confirm.

## Wording (fr / ar, gender-neutral Arabic — owner rule 2026-09-29)

Arabic names the **application** (« الترشح »), never the person, and uses verbal nouns for stages, so no word depends
on the candidate's or the user's sex. To be checked by an Algerian HR reader with the other Arabic wording.

| Key idea | fr | ar |
|---|---|---|
| module / nav (HR) | Recrutement | التوظيف |
| nav (heads) | Mes recrutements | طلبات التوظيف |
| nav (interviewers, B) | Mes entretiens | مقابلاتي |
| opening | Poste à pourvoir | منصب شاغر |
| request an opening | Demander une ouverture de poste | طلب فتح منصب |
| opening statuses | En attente d'approbation, Ouvert, Pourvu, Clôturé, Refusé, Annulé | في انتظار الموافقة، مفتوح، تم شغله، مغلق، مرفوض، ملغى |
| candidates (list) | Candidatures | الترشحات |
| stages | Reçue, Présélection, Entretien, Offre, Embauche, Refus, Désistement | الاستلام، الانتقاء الأولي، المقابلة، عرض التوظيف، التوظيف، الرفض، الانسحاب |
| move | Déplacer vers… | نقل إلى… |
| system reasons | Poste pourvu / Recrutement clôturé | تم شغل المنصب / تم إغلاق عملية التوظيف |
| interviewers (B) | Personnes chargées de l'entretien | أعضاء لجنة المقابلة |
| evaluation (B) | Évaluation à saisir | تقييم في انتظار الإدخال |
| hire (B) | Embaucher | إتمام التوظيف |
| former employee | Déjà employé(e) dans l'entreprise | سبق العمل في المؤسسة |
| stage changed meanwhile | Cette candidature a été modifiée entre-temps. Veuillez actualiser. | تم تعديل هذا الترشح في الأثناء. يرجى التحديث. |

---

## Phase A — openings, approval, candidates, pipeline, files, notes, retention

### Data (migration 0019)

All tenant tables: `company_id` + RLS/FORCE + the standard policy, composite `(company_id, …)` FKs, a trigger named
`audit_capture_tg` on every table except the content table (see *Audit*). Users are referenced without FK. Instants
are `timestamptz`; "today" is the date in `Africa/Algiers` (provider `RecruitmentClock`, pinned by tests).

| Table | Columns | Rules |
|---|---|---|
| `recruitment_policy` (pk `company_id`, `audit.capture('company_id')`) | `retention_months int` (12), `opening_workflow_code text` (`recruitment.manager_then_hr`), `updated_at` | 1 ≤ retention ≤ 60; code ∈ (`recruitment.manager_then_hr`, `recruitment.hr_only`). Created per company by the migration, `bootstrap` and the `SYSTEM_*` helpers; a missing row = the defaults |
| `recruitment_opening_sequence` (pk `company_id`, `year`; `audit.capture('company_id')`) | `last_value int` | row locked when a reference is taken; references may have gaps (a rolled-back request) |
| `recruitment_opening` | `id`, `company_id`, `reference text` (`REC-{YYYY}-{SEQ:4}`, year of the request in Algiers, unique per company, immutable), `title` (1–120, trimmed; the job title), `org_unit_id`, `site_id` null (null = the unit's effective site), `contract_type` (assumption 4), `posts int` (1–99), `hired_count int` default 0, `justification` (3–2000), `target_date date`, `anem_reference` null (1–40), `status` (`pending`/`open`/`filled`/`closed`/`rejected`/`cancelled`), `requested_by uuid`, `requested_at`, `workflow_instance_id` null, `opened_at` null, `closed_at` null, `closed_by` null, `close_reason` null (3–500) | `0 ≤ hired_count ≤ posts`; `status='filled'` ⇒ `hired_count = posts`; `closed` ⇔ the three close columns set (`filled`: `closed_at` only); `title`, `org_unit_id`, `contract_type`, `justification`, `requested_by`, `reference` immutable (BEFORE UPDATE trigger); status transitions limited to `pending→open/rejected/cancelled`, `open→filled/closed`, `filled→open`, `closed→open` (same trigger); no DELETE for `hrforce_app`. Audited normally (`audit.capture()`): an opening holds no candidate data |
| `recruitment_rejection_reason` | `id`, `company_id`, `code` (`^[a-z][a-z0-9_]{1,39}$`, immutable), `name_fr/ar/en` (1–120), `active bool`, `sort_order int`, `is_system bool`, `auto_only bool` | unique (`company_id`,`code`); no delete (deactivate); `auto_only` ⇒ `is_system`. Audited normally |
| `recruitment_candidate` | `id`, `company_id`, `last_name`, `first_name` (1–80), `last_name_ar`, `first_name_ar` null, `birth_date` null, `birth_place` null (≤ 120), `sex` (`M`/`F`) null, `nationality` (ISO-2, default `DZ`), `nin` null (18 digits), `email` null (≤ 254, stored lower-case), `phone` null (≤ 30), `phone_key` null (digits of `phone` with a leading `00213`, `213` or `0` removed; set by the application), `person_id` null (FK `person`), `informed_on date` null, `created_by uuid` null, `created_at` | the identity columns are exactly `person`'s, so the hire copies them 1:1. **No unique index on `nin`** (see *Duplicates*). Indexes (`company_id`,`nin`), (`company_id`,`email`), (`company_id`,`phone_key`), and the accent/case-folded name as `person`. DELETE allowed only when no application references it (FK `restrict`) |
| `recruitment_application` | `id`, `company_id`, `opening_id`, `candidate_id` null, `source` (`anem`/`spontaneous`/`referral`/`job_board`/`social`/`internal`/`other`), `stage` (assumption 6), `stage_since timestamptz`, `decided_at` null, `employment_id` null (FK `employment`), `created_by uuid` null, `created_at`, `purged_at` null | `candidate_id` null ⇔ `purged_at` not null; `decided_at` not null ⇔ `stage` ∈ (`hired`,`rejected`,`withdrawn`); `employment_id` not null ⇒ `stage='hired'`; unique (`company_id`,`opening_id`,`candidate_id`) where `candidate_id` is not null; index (`company_id`,`opening_id`,`stage`); **never deleted** (no DELETE for `hrforce_app` nor `hrforce_worker`): the purged row is the anonymous count |
| `recruitment_application_stage` | `id`, `company_id`, `application_id`, `from_stage` null (null = creation), `to_stage`, `rejection_reason_id` null, `comment` null (1–1000), `auto_cause` null (`opening_filled`/`opening_closed`/`hire_undone`/`opening_reopened`; Phase B adds `interview_scheduled`), `moved_by uuid` null, `moved_at` | `rejection_reason_id` not null ⇔ `to_stage='rejected'`; **immutable** (no UPDATE/DELETE for `hrforce_app`; `hrforce_worker`: `UPDATE (comment)` only, and only to null — trigger) |
| `recruitment_application_salary` | `application_id` pk, `company_id`, `expected_salary numeric(12,2)` null (> 0), `proposed_salary numeric(12,2)` null (> 0; Phase B) | a separate table so the field permission is a join (as `person_sensitive`); app: INSERT, UPDATE, DELETE |
| `recruitment_note` | `id`, `company_id`, `application_id`, `body` (1–4000), `created_by uuid`, `created_at` | immutable; app: INSERT, DELETE |
| `recruitment_candidate_file` | `id`, `company_id`, `candidate_id`, `kind` (`cv`/`cover_letter`/`diploma`/`id_document`/`other`), `title` (1–120), `original_filename` (≤ 200, sanitised as the employee file), `mime` (sniffed), `size_bytes` (≤ 20 MB), `sha256 bytea`, `uploaded_by uuid` null, `uploaded_at` | immutable; unique (`company_id`,`candidate_id`,`sha256`); app: INSERT, DELETE (**hard delete — no tombstone**: nothing about a candidate may outlive the erasure) |
| `recruitment_candidate_file_content` (**audit-exempt**: bytes; listed in `tools/guardrails/audit-exempt.json`) | `file_id` pk (FK file, `on delete cascade`), `company_id`, `content bytea` (`STORAGE EXTERNAL`) | app: INSERT, DELETE; no UPDATE |

Also in 0019: `permission_group_ck` gains `recruitment`; `workflow_instance_subject_type_ck` and
`notification_subject_type_ck` gain `recruitment_opening`; the workflow definitions `recruitment.manager_then_hr` =
`[{key: 'manager', kind: 'manager'}, {key: 'hr', kind: 'permission', permission: 'recruitment.approve_opening'}]` and
`recruitment.hr_only` = the `hr` step alone (step labels as attendance: « Responsable » / « المسؤول المباشر » /
"Manager", « RH » / « الموارد البشرية » / "HR"), seeded per company; the system employee-file category **`recruitment`**
(« Recrutement » / « التوظيف » / "Recruitment", `standard`, retention null) for every company and in
`SYSTEM_FILE_CATEGORIES`; worker grants (see *Retention*).

**Seeded per company** (migration for existing companies, `bootstrap` and `SYSTEM_*` for new ones): the policy row and
the rejection reasons — `profile_mismatch` (Profil ne correspondant pas au poste / عدم توافق المؤهلات مع المنصب),
`experience` (Expérience insuffisante / خبرة غير كافية), `qualification` (Diplôme ou qualification requis non détenu /
عدم حيازة الشهادة أو التأهيل المطلوب), `salary` (Prétentions salariales / المطالب المتعلقة بالأجر), `other_selected`
(Autre candidature retenue / تم اختيار ترشح آخر), `no_show` (Absence à l'entretien / الغياب عن المقابلة),
`incomplete` (Dossier incomplet / ملف ناقص), `other` (Autre / سبب آخر); and the two `auto_only` ones:
`position_filled` (Poste pourvu / تم شغل المنصب), `opening_closed` (Recrutement clôturé / تم إغلاق عملية التوظيف).

**Why a candidate and an application are two records.** A person may apply to several openings over time: the
identity, the contact details and the CV are entered once (`recruitment_candidate`), and each opening gets its own
application with its own stage, history, notes, interviews and offer. It is also what a public page would need later.
The cost is the erasure rule: an application is purged on its own decision date, and the candidate record goes when
its last application is purged (*Retention*).

**Why candidate files are a parallel table and not `employee_file`.** `employee_file` belongs to an employment
(`employment_id` not null), is classified by HR categories with an access class, keeps a tombstone and its metadata
after deletion and is purged N years after the employment ends. A candidate has no employment, must leave **no**
metadata behind, and is erased on another clock. Sharing the table would mean nullable owners and two lifecycles in
one guard trigger. What is shared is the **code**: Documents exports its sniffing, file-name, download-header and
bounded-multipart pieces (*Module boundaries*), so the validation and the response headers are identical.

### Openings

- **Request** (`POST /recruitment/openings`). Checks in order: DTO (422) → unknown `orgUnitId` (422 `not_found`) → the
  caller may request for the unit (assumption 2: their linked employment heads the unit or one of its ancestors today,
  or they hold `recruitment.manage` over it), else **403** `forbidden-scope` (`errors[{field: 'orgUnitId'}]`) → unknown
  `siteId` (422 `not_found`) → `targetDate` before today (422 `targetDate` `past`). Then: the reference is taken, the
  row is inserted `pending`, and the workflow starts with the policy's definition, `scopeUnitId` = the opening's unit,
  `subjectUserId` = null.
- **Manager step** (`resolveManager`): the head (on today's date) of the opening's unit, else of its nearest ancestor
  that has one, **skipping the requester's own employment**; the approving user is the one linked to that head.
  Escalation reasons as leave: `no-manager`, `manager-not-linked`. The engine's separation of duties applies
  (`workflow-self-approval`): an HR user who files a request never approves it.
- `onApproved` → `open`, `opened_at`; `onRejected` → `rejected`; `onCancelled` → `cancelled`. Cancel: the requester,
  `pending` only (else 409 `recruitment-opening-not-cancellable`).
- **While open** (`recruitment.manage` over the unit): `PATCH` of `targetDate`, `siteId`, `anemReference`, and `posts`
  **downwards only** (422 `posts`: `increase` when above the current value, `below_hired` when below
  `max(1, hired_count)`); lowering `posts` to `hired_count` (> 0) fills the opening (below). Any write on an opening
  that is not `open` → 409 `recruitment-opening-not-open`.
- **Close** (`open → closed`, reason required) and **fill** (`open → filled`, automatic when `hired_count = posts`),
  in the same transaction: every application in an active stage (`received`, `shortlisted`, `interview`, `offer`) moves
  to `rejected` with the reason `opening_closed` / `position_filled`, `auto_cause` `opening_closed` / `opening_filled`,
  `moved_by` = the acting user, `decided_at = now()` (Phase B: their proposed offers are cancelled and their future
  interviews cancelled, interviewers told).
- **Reopen** (`closed → open`, `recruitment.manage`; 409 `recruitment-opening-not-closed`; 409
  `recruitment-no-post-left` when `hired_count = posts`) and the automatic `filled → open` of a hire undo (Phase B):
  every unpurged application of the opening whose **latest** transition has `auto_cause` `opening_closed`
  (respectively `opening_filled`) returns to that transition's `from_stage` (`auto_cause` `opening_reopened` /
  `hire_undone`, `decided_at` null; Phase B: an application coming back from `offer` lands in `interview`, its offer
  stays cancelled).

### Candidates, duplicates, known persons

- A candidate is always created **with** an application (`POST /recruitment/openings/:id/applications`), either new
  (`candidate: {…}`) or existing (`candidateId`). A candidate applies once per opening (409
  `recruitment-already-applied`); the opening must be `open` (409 `recruitment-opening-not-open`).
- **Duplicates** are looked for among the candidates **the caller can see** (*Scope*) — never company-wide, so the
  answer reveals nothing about another region: same `nin`; same `email` (case-insensitive); same `phone_key`; same
  folded last + first name **and** birth date. `POST /recruitment/candidates/match` returns them (and writes nothing).
  Creating or editing a candidate that matches a visible one on `nin` → 409 `recruitment-candidate-duplicate`
  (`errors[{field: 'nin', code: 'duplicate'}]`, never overridable: use the existing candidate); on `email` / `phone` →
  the same 409 on those fields unless the body carries `allowDuplicate: true` (relatives share a phone). Name + birth
  date matches are advisory only. Consequence, accepted: two regions can each hold a record of the same person until
  central HR adds the existing candidate to the second opening; the NIN is checked for real at hire (`nin-taken`).
- **Known person** (former employee): `KnownPersonView` is returned when the candidate's `person_id` is set, else when
  a `person` of the company has the candidate's `nin` — in both cases **only if the caller can read that person's
  latest employment with `employee.read`** (the rehire visibility rule of `employment.md`), else null. HR confirms the
  link with `PUT /recruitment/candidates/:id/person {personId}` (422 `personId` `not_found` when invisible; `null`
  unlinks). The candidate keeps its own identity fields; the link only decides that the hire is a **rehire**.
- Candidate identity edits (`PATCH`) need `recruitment.manage` over the unit of at least one of its applications'
  openings; they are refused once every application is purged (the row no longer exists → 404).

### Stage rules

Active stages in order: `received` < `shortlisted` < `interview` < `offer`. Final stages: `hired`, `rejected`,
`withdrawn`.

| Move | Who | Needs | Phase |
|---|---|---|---|
| between `received`, `shortlisted`, `interview` (any direction, skipping allowed) | `recruitment.manage` | `comment` optional | A |
| any active stage → `rejected` | `recruitment.manage` | `rejectionReasonId` (active, not `auto_only`; else 422 `rejectionReasonId` `required` / `not_found` / `inactive`), `comment` optional | A |
| any active stage → `withdrawn` | `recruitment.manage` | `comment` optional | A |
| `rejected` / `withdrawn` → the stage it had before (**reopen**) | `recruitment.manage` | the opening is `open` (409 `recruitment-opening-not-open`), the application is not purged; lands in the latest transition's `from_stage` (`interview` when that was `offer`) | A |
| active stage before `offer` → `offer` | `recruitment.hire` | through the offer endpoint only (offer data) | B |
| `offer` → `interview` (offer cancelled), `offer` → `withdrawn` (offer declined) | `recruitment.hire` | through the offer endpoints | B |
| `offer` → `hired` | `recruitment.hire` (+ `employee.create` over the hire unit) | through the hire endpoint only | B |
| `hired` → `offer` | `recruitment.hire` | through undo-hire only | B |

- `POST …/move` with `toStage` ∈ (`offer`, `hired`) or from `hired` → 422 `toStage` `not_allowed` (use the dedicated
  endpoint); `toStage` = the current stage → 422 `toStage` `same`.
- **Concurrency.** Every stage-changing call carries `expectedStage` (the stage the user was looking at). The use case
  locks the application row (`SELECT … FOR UPDATE`; hire, close and fill lock the opening row **first**, then the
  applications in id order) and answers **409 `recruitment-stage-changed`** when the stored stage differs — the second
  of two HR users acting on one card always gets it, and the web reloads the board.
- Each move inserts one `recruitment_application_stage` row and updates `stage`, `stage_since`, `decided_at`. The
  history is never edited; a mistake is corrected by another move.
- Moves on an application of an opening that is not `open` → 409 `recruitment-opening-not-open` (its applications are
  all final by then).

### Permissions (catalogue additions; group `recruitment`, sort 910–960; the two salary codes in `sensitive`, 446–447)

| Code | fr | ar | en | Granted to |
|---|---|---|---|---|
| `recruitment.read` | Consulter les recrutements et les candidatures | الاطلاع على عمليات التوظيف والترشحات | View openings and applications | `admin_rh_central`, `rh_regional` |
| `recruitment.manage` | Gérer les candidatures (saisie, étapes, pièces, notes, entretiens) | تسيير الترشحات (الإدخال، المراحل، الوثائق، الملاحظات، المقابلات) | Manage applications (entry, stages, files, notes, interviews) | `admin_rh_central`, `rh_regional` |
| `recruitment.approve_opening` | Approuver les ouvertures de poste (étape RH) | الموافقة على فتح المناصب (مرحلة الموارد البشرية) | Approve openings (HR step) | `admin_rh_central`, `rh_regional` |
| `recruitment.hire` | Proposer une offre et embaucher | تقديم عرض التوظيف وإتمام التوظيف | Make offers and hire | `admin_rh_central`, `rh_regional` |
| `recruitment.erase` | Effacer les données d'une candidature | حذف بيانات الترشح | Erase a candidate's data | `admin_rh_central` |
| `recruitment.configure` | Paramétrer le recrutement | إعداد التوظيف | Configure recruitment | `admin_rh_central` |
| `recruitment.salary.read` (sensitive) | Consulter les salaires demandés et proposés | الاطلاع على الأجور المطلوبة والمقترحة | View expected and proposed salaries | `admin_rh_central` |
| `recruitment.salary.update` (sensitive) | Saisir les salaires demandés et proposés | إدخال الأجور المطلوبة والمقترحة | Enter expected and proposed salaries | `admin_rh_central` |

`PERMISSION_CODES`, `SYSTEM_ROLES` and the catalogue unit test are updated; the migration grants them to the existing
system roles of every company. The two sensitive codes join the MFA list through
`security_policy_default_permissions()` and are appended to every existing policy that lists `employee.salary.read`.
`lecture`, `admin_acces` and `employe` get nothing. Heads and interviewers need **no permission** (as the leave manager
step and the attendance team view).

### Scope

- **Opening**: its `org_unit_id` against the caller's scope for the route's permission (today's tree). Unknown / other
  company / outside `recruitment.read` scope → **404**; readable but outside the scope of the write permission →
  **403** `forbidden-scope`.
- **Application**: its opening's unit. **Candidate**: visible when at least one of its applications is visible; the
  views then list **only the visible applications** (the others are absent, with no count).
- **Salary block** (`expected`, Phase B `proposed`): `recruitment.salary.read` over the opening's unit, else the block
  is omitted and `_redacted: ['salary']` is set (whether or not a value exists). Writing it without
  `recruitment.salary.update` → 403 `forbidden-field` (`errors[{field: 'expectedSalary'}]`), nothing written.
- **Configuration** (`recruitment.configure`): writes need the permission over the whole company (the root unit), else
  403 `forbidden-scope` (as `attendance.configure`).
- **Head view** (no grant): the caller's linked employment heads, today, the opening's unit or one of its ancestors
  (`StaffingService.unitsHeadedBy` + sub-units). It gives `/me/recruitment/openings*` with the applications in
  `HeadApplicationView` (below) and their files. **Requester view**: the requester who is not (or no longer) a head
  sees the opening, its workflow and its counts — `applications: null`.
- **Erasure** (`recruitment.erase`): over the units of **all** the candidate's applications' openings (else 403
  `forbidden-scope`).

### Endpoints (under `/api`, problem+json)

**Openings**

| Method + path | Guard | Request → response |
|---|---|---|
| `POST /recruitment/openings` | `@Authenticated` | `{title, orgUnitId, siteId?: string \| null, contractType, posts, justification, targetDate}` → **201** `OpeningDetailView` + `Location`; rules in *Openings* |
| `GET /recruitment/openings?status=&unitId=&includeSubUnits=&contractType=&q=&sort=&dir=&page=&pageSize=` | `recruitment.read` | `status` one value or `active` (= `pending` + `open`, the default) or `all`; `q` on title and reference; `sort` = `requestedAt` (default, desc) \| `targetDate` \| `title` \| `unit`; `pageSize` ≤ 100 (default 25) → `{items: OpeningView[], total, page, pageSize}` |
| `GET /recruitment/openings/:id` | `recruitment.read` | → `OpeningDetailView` |
| `PATCH /recruitment/openings/:id` | `recruitment.manage` | `{targetDate?, siteId?, anemReference?, posts?}` → 200 `OpeningDetailView` |
| `POST /recruitment/openings/:id/close` | `recruitment.manage` | `{reason}` (3–500) → 200 `OpeningDetailView` |
| `POST /recruitment/openings/:id/reopen` | `recruitment.manage` | no body → 200 `OpeningDetailView` |
| `GET /recruitment/summary` | `recruitment.read` | → `SummaryView` (scoped counts) |
| `GET /me/recruitment/summary` | `@Authenticated` | → `MySummaryView` (never 404; zeros and `false` for a user with nothing) |
| `GET /me/recruitment/openings` | `@Authenticated` | openings the caller requested or heads (head view rule), newest first, ≤ 200 → `{items: MyOpeningView[]}` |
| `GET /me/recruitment/openings/:id` | `@Authenticated` | requester or head, else 404 → `MyOpeningDetailView` |
| `POST /me/recruitment/openings/:id/cancel` | `@Authenticated` | the requester, `pending` → 200 `MyOpeningDetailView`; someone else's → 404; 409 `recruitment-opening-not-cancellable` |

Approval and rejection go through the existing `POST /tasks/:id/approve|reject`.

**Candidates and applications**

| Method + path | Guard | Request → response |
|---|---|---|
| `POST /recruitment/candidates/match` | `recruitment.manage` | `{nin?, email?, phone?, lastName?, firstName?, birthDate?, excludeCandidateId?}` (at least one of nin / email / phone / the name pair, else 422) → 200 `{candidates: CandidateMatchView[] (≤ 10), person: KnownPersonView \| null}`; writes nothing; `Cache-Control: no-store` |
| `GET /recruitment/candidates?q=&openingId=&stage=&state=&idleMonths=&unitId=&includeSubUnits=&sort=&dir=&lang=&page=&pageSize=` | `recruitment.read` | one item per visible **application**; `q` = name (Latin/Arabic), e-mail, phone digits, NIN; `state` = `active` (default) \| `final` \| `all`; `idleMonths` = active applications whose `stage_since` is older; `sort` = `name` (default; `lang` as `/employees`) \| `stageSince` \| `createdAt` → `{items: ApplicationListItem[], total, page, pageSize}` |
| `GET /recruitment/candidates/:id` | `recruitment.read` | → `CandidateView` |
| `PATCH /recruitment/candidates/:id` | `recruitment.manage` | any of the identity / contact fields, `informedOn`, `allowDuplicate?` → 200 `CandidateView`; 409 `recruitment-candidate-duplicate` |
| `PUT /recruitment/candidates/:id/person` | `recruitment.manage` | `{personId: string \| null}` → 200 `CandidateView`; 422 `personId` `not_found` |
| `POST /recruitment/candidates/:id/erase` | `recruitment.erase` | no body → **204**; 409 `recruitment-application-active` when an application is in an active stage (reject or withdraw it first) |
| `POST /recruitment/openings/:id/applications` | `recruitment.manage` | `{candidateId} \| {candidate: CandidateInput, allowDuplicate?}`, `source`, `expectedSalary?: string`, `comment?` → **201** `ApplicationDetailView`; both or neither of `candidateId` / `candidate` → 422; unknown or invisible `candidateId` → 422 `candidateId` `not_found`; 409 `recruitment-opening-not-open`, `recruitment-already-applied`, `recruitment-candidate-duplicate`; 403 `forbidden-field` (salary) |
| `GET /recruitment/openings/:id/board?includeFinal=` | `recruitment.read` | → `BoardView`; `includeFinal` (default false) adds the cards of the final stages; counts always cover every stage. More than 1 000 unpurged applications → 422 `errors[{field: 'id', code: 'too_many'}]` |
| `GET /recruitment/applications/:id` | `recruitment.read` | → `ApplicationDetailView` (a purged application → 404) |
| `PATCH /recruitment/applications/:id` | `recruitment.manage` | `{source?, expectedSalary?: string \| null}` → 200 |
| `POST /recruitment/applications/:id/move` | `recruitment.manage` | `{toStage, expectedStage, rejectionReasonId?, comment?}` → 200 `ApplicationDetailView`; 409 `recruitment-stage-changed`, `recruitment-opening-not-open` |
| `POST /recruitment/applications/:id/reopen` | `recruitment.manage` | `{expectedStage}` → 200; `expectedStage` not final → 422 |
| `POST /recruitment/applications/:id/notes` | `recruitment.manage` | `{body}` (1–4000) → 201 `NoteView` |
| `DELETE /recruitment/applications/:id/notes/:noteId` | `recruitment.manage` | the author, or a holder of `recruitment.erase` over the unit (else 403 `forbidden`) → 204 |

**Candidate files** (validation, limits and response headers exactly as `documents.md` › Phase B *Upload validation* and
its *Settled by the build*: bounded multipart outside the request transaction, type by content, UTF-8 file names,
`attachment`, `nosniff`, `sandbox; default-src 'none'`, `private, no-store`, extension following the sniffed type)

| Method + path | Guard | Request → response |
|---|---|---|
| `POST /recruitment/candidates/:id/files` | `recruitment.manage` | multipart `file`, `kind`, `title` → 201 `CandidateFileView`; 422 `file` (`required`, `empty`, `too_large`, `unsupported_type`, `one_file_only`, `invalid_multipart`), `kind`; 409 `recruitment-file-duplicate` (same bytes already on this candidate; field `file`); at most 20 files per candidate (409 `recruitment-file-limit`) |
| `GET /recruitment/candidates/:id/files/:fileId/content` | `recruitment.read` | the bytes; event `recruitment.file_downloaded` |
| `DELETE /recruitment/candidates/:id/files/:fileId` | `recruitment.manage` | → 204 (row and bytes gone) |
| `GET /me/recruitment/applications/:id/files/:fileId/content` | `@Authenticated` | head of the opening (Phase B: or an interviewer of the application, *Interviews*), the application in an **active** stage, the file belonging to its candidate; else 404. Same headers and event |

**Settings**

| Method + path | Guard | Request → response |
|---|---|---|
| `GET /recruitment/policy` | `recruitment.read` | → `PolicyView` |
| `PUT /recruitment/policy` | `recruitment.configure` (company) | `{retentionMonths?, openingWorkflowCode?}` → 200 (the workflow applies to new requests) |
| `GET /recruitment/rejection-reasons` | `recruitment.read` | → `{items: ReasonView[]}` (inactive and `auto_only` included; `sortOrder`, then `code`) |
| `POST /recruitment/rejection-reasons` | `recruitment.configure` (company) | `{code, labels}` → 201; 409 `recruitment-reason-code-taken` |
| `PUT /recruitment/rejection-reasons/:id` | `recruitment.configure` (company) | `{labels?, active?, sortOrder?}` → 200; `active` on an `auto_only` reason → 422 |

Check order everywhere: DTO 422 → 404 / 403 scope → field permission 403 → business 409. Money is a decimal **string**
(as `employment.md`). Response bodies pass `assertNoSecrets`.

```ts
type OpeningStatus = 'pending' | 'open' | 'filled' | 'closed' | 'rejected' | 'cancelled';
type ContractType = 'cdi' | 'cdd' | 'pre_emploi' | 'apprentissage' | 'stage';
type Stage = 'received' | 'shortlisted' | 'interview' | 'offer' | 'hired' | 'rejected' | 'withdrawn';
type Source = 'anem' | 'spontaneous' | 'referral' | 'job_board' | 'social' | 'internal' | 'other';
type FileKind = 'cv' | 'cover_letter' | 'diploma' | 'id_document' | 'other';
type Labels = { fr: string; ar: string; en: string };
interface UserRef { id: string; displayName: string }                    // displayName = id for a former member
interface SiteRef { id: string; code: string; name: string }
// NamePair, UnitRef: employment.md. WorkflowProgressView, TaskHistoryView: leave.md / attendance.md.
type StageCounts = Record<Stage, number> & { total: number };            // every application, purged ones included

interface OpeningView {
  id: string; reference: string; title: string; unit: UnitRef; site: SiteRef | null; siteInherited: boolean;
  contractType: ContractType; posts: number; hiredCount: number; justification: string; targetDate: string;
  anemReference: string | null; status: OpeningStatus; requestedAt: string; requestedBy: UserRef | null;
  openedAt: string | null; closed: { at: string; by: UserRef | null; reason: string | null } | null;   // filled: reason null
  workflow: WorkflowProgressView | null; rejectionComment: string | null;
  counts: StageCounts;
  _actions: ('update' | 'close' | 'reopen' | 'add_application')[];       // Phase B adds 'set_criteria'
}
interface OpeningDetailView extends OpeningView { history: TaskHistoryView[] }
interface MyOpeningView extends Omit<OpeningView, 'counts' | '_actions'> {
  roles: ('requester' | 'head')[]; counts: StageCounts | null;           // null without the head role
  _actions: ('cancel')[];
}
interface MyOpeningDetailView extends MyOpeningView { history: TaskHistoryView[];
  applications: HeadApplicationView[] | null }                           // null without the head role; purged ones absent
interface HeadApplicationView { id: string; candidate: NamePair; stage: Stage; stageSince: string;
  files: CandidateFileView[] }                                           // [] once the stage is final. Phase B adds fields
interface SummaryView { openings: Record<OpeningStatus, number>;
  applications: Record<'received' | 'shortlisted' | 'interview' | 'offer', number> }   // of open openings; Phase B adds fields
interface MySummaryView { canRequestOpening: boolean; openings: number; pendingOpenings: number }  // Phase B adds fields

interface CandidateInput { lastName: string; firstName: string; lastNameAr?: string | null; firstNameAr?: string | null;
  birthDate?: string | null; birthPlace?: string | null; sex?: 'M' | 'F' | null; nationality?: string; nin?: string | null;
  email?: string | null; phone?: string | null; informedOn?: string | null }
interface KnownPersonView { personId: string; person: NamePair; linked: boolean;      // linked = stored on the candidate
  hasOpenEmployment: boolean;
  latestEmployment: { id: string; matricule: string; hireDate: string; endDate: string | null; unit: UnitRef } }
interface CandidateMatchView { id: string; person: NamePair; birthDate: string | null;
  matchedOn: ('nin' | 'email' | 'phone' | 'name_birth')[];
  applications: { id: string; opening: OpeningRef; stage: Stage }[] }    // visible ones
interface OpeningRef { id: string; reference: string; title: string; unit: UnitRef; status: OpeningStatus }
interface CandidateFileView { id: string; kind: FileKind; title: string; originalFilename: string; mime: string;
  sizeBytes: number; uploadedAt: string; uploadedBy: UserRef | null; _actions: ('delete')[] }
interface CandidateView {
  id: string; person: NamePair; birthDate: string | null; birthPlace: string | null; sex: 'M' | 'F' | null;
  nationality: string; nin: string | null; email: string | null; phone: string | null; informedOn: string | null;
  createdAt: string; createdBy: UserRef | null; knownPerson: KnownPersonView | null;
  files: CandidateFileView[];                                            // newest first
  applications: ApplicationSummary[];                                    // visible ones, newest first
  _actions: ('update' | 'upload' | 'link_person' | 'erase')[];
}
interface ApplicationSummary { id: string; opening: OpeningRef; stage: Stage; stageSince: string; source: Source;
  createdAt: string; decidedAt: string | null; rejectionReason: { code: string; labels: Labels } | null }
interface ApplicationListItem extends ApplicationSummary { candidate: NamePair & { id: string }; hasCv: boolean }
interface StageEntry { id: string; from: Stage | null; to: Stage; at: string; by: UserRef | null;
  rejectionReason: { code: string; labels: Labels } | null; comment: string | null;
  autoCause: 'opening_filled' | 'opening_closed' | 'hire_undone' | 'opening_reopened' | 'interview_scheduled' | null }
interface NoteView { id: string; body: string; createdAt: string; createdBy: UserRef; _actions: ('delete')[] }
interface ApplicationDetailView extends ApplicationSummary {
  candidate: CandidateView;
  stages: StageEntry[];                                                  // oldest first
  notes: NoteView[];                                                     // newest first
  salary?: { expected: string | null };                                  // Phase B adds `proposed`
  _redacted: ('salary')[];
  moveTargets: Stage[];                                                  // what POST …/move accepts now ([] when final or not manageable)
  _actions: ('move' | 'reopen' | 'add_note' | 'update' | 'update_salary')[];   // Phase B adds interview / offer / hire actions
}
interface BoardCard { id: string; candidate: NamePair & { id: string }; stage: Stage; stageSince: string; source: Source;
  hasCv: boolean; notes: number; formerEmployee: boolean;                // formerEmployee: knownPerson would be non-null
  rejectionReason: { code: string; labels: Labels } | null;
  moveTargets: Stage[]; _actions: ('move' | 'reopen')[] }                // Phase B adds fields
interface BoardView { opening: OpeningView;
  columns: { stage: Stage; count: number; cards: BoardCard[] }[];        // the 7 stages in order; cards oldest stageSince first
  purged: number }                                                       // applications already anonymised (in the counts)
interface PolicyView { retentionMonths: number; openingWorkflowCode: 'recruitment.manager_then_hr' | 'recruitment.hr_only';
  company: { nameFr: string; nameAr: string | null } }                   // for the notice: company_profile legal names, else company.name
interface ReasonView { id: string; code: string; labels: Labels; active: boolean; sortOrder: number;
  isSystem: boolean; autoOnly: boolean }
```

### Module boundaries

- **Employment** (`modules/employment/index.ts`): `EmployeesService.create` is used as is by the hire (Phase B). New
  read-only `EmployeesService.knownPerson({personId} | {nin})` → the data of `KnownPersonView` or null, applying the
  rehire visibility rule (`employee.read` over the latest employment).
- **Documents** exports from `modules/documents/index.ts`: `sniffFileType`, `sanitizeFilename`, `downloadFilename`,
  `attachmentDisposition`, the bounded multipart reader used by the employee-file upload, the size limit, and (Phase
  B) `EmployeeFileImporter` (*Hire*). No copy of that code in the recruitment module.
- **Staffing**: `unitsHeadedBy`, `linkedEmploymentOf` as today; new `StaffingService.headAtOrAbove(unitId, date,
  excludeEmploymentId | null)` → the employment heading the unit or its nearest headed ancestor (the walk of
  `managerOf`), with its linked user id or null.
- **Workflow**: subject type `recruitment_opening` registered by the module (`resolveManager`, the three hooks,
  `summaries`, `notificationData`). **Nothing about a candidate ever goes through the workflow engine**, so its
  append-only history holds no candidate data.
- **Notifications**: the types below; `linkOf` gains the `recruitment_opening` rule.
- **Audit port**: `AuditSubjectType` gains `recruitment_opening`, `recruitment_candidate`, `recruitment_application`.

### Workflow, My tasks, notifications

Task summary (`summaries`) of a `recruitment_opening`: `{type: 'recruitment_opening', id, reference, title, unit:
UnitRef, site: SiteRef | null, contractType, posts, justification, targetDate, requestedBy: UserRef}` — everything an
approver needs, so approvers (a head above, with no permission) need no other route.

| Type | When | Recipients | Email default | Link |
|---|---|---|---|---|
| `task.assigned` (existing) | an opening task opens | its candidates minus the requester | on | `/tasks?task=<id>` |
| `task.escalated` (existing) | the manager step is skipped | the requester | off | `/me/recruitment/openings/<id>` |
| `recruitment.opening_approved` | final approval | the requester | on | `/me/recruitment/openings/<id>` |
| `recruitment.opening_rejected` | rejection | the requester | on | `/me/recruitment/openings/<id>` |

`data`: `{openingId, reference, title, unitName, unitNameAr, posts, actorName}`; `task.assigned` data gains
`subjectType: 'recruitment_opening'`. The requester always reaches the link (requester view), HR requesters included.
Wording — fr: « Ouverture de poste à approuver : <titre> (<référence>, <unité>) », « Votre demande d'ouverture de
poste <titre> (<référence>) a été approuvée / refusée par <acteur> »; ar: « طلب فتح منصب في انتظار الموافقة: <العنوان>
(<المرجع>، <الوحدة>) », « تمت الموافقة على طلب فتح المنصب <العنوان> (<المرجع>) من طرف <الفاعل> » / « تم رفض طلب فتح
المنصب <العنوان> (<المرجع>) من طرف <الفاعل> »; en likewise. E-mails follow the same sentences (fr/ar/en, passive in
Arabic) and never include the justification or the rejection comment. **No notification or e-mail of this module ever
contains a candidate's name** (a notification row would outlive the erasure), and nothing is sent to candidates.

### Audit and timeline

- `recruitment_policy`, `recruitment_opening_sequence`, `recruitment_opening`, `recruitment_rejection_reason`: the
  standard `audit.capture()` (row diffs).
- **Candidate data is audited as events without personal payload** (the attendance pattern, so the erasure really
  erases). `recruitment_candidate`, `recruitment_application`, `recruitment_application_stage`,
  `recruitment_application_salary`, `recruitment_note`, `recruitment_candidate_file` carry the standard trigger name
  `audit_capture_tg` (so `guard:db` covers them without exemption) executing **`audit.capture_recruitment_event()`**
  (SECURITY DEFINER, pinned `search_path`): no `audit.change_log` row, one `audit.event` per write, company from the
  row, actor and request id from the transaction settings:

  | Write | Event | Subject | `data` |
  |---|---|---|---|
  | candidate insert / update / delete | `recruitment.candidate_created` / `_updated` / `_deleted` | `recruitment_candidate:<id>` | update: `{fields: string[]}` — the **names** of the changed columns, never values |
  | application insert / update | `recruitment.application_created` / `_updated` | `recruitment_application:<id>` | `{openingId, source}` / `{fields}` (an update that only changes `stage`, `stage_since`, `decided_at` writes nothing: the stage row does) |
  | stage row insert | `recruitment.stage_changed` | `recruitment_application:<application id>` | `{from, to, reasonCode, autoCause}` |
  | salary insert / update / delete | `recruitment.salary_changed` | `recruitment_application:<application id>` | `{fields}` |
  | note insert / delete | `recruitment.note_added` / `_deleted` | `recruitment_application:<application id>` | `{}` |
  | file insert / delete | `recruitment.file_added` / `_deleted` | `recruitment_candidate:<candidate id>` | `{kind}` |

  No name, NIN, contact detail, amount, comment, note text, file name or hash ever reaches the audit log. **Writes by
  `hrforce_worker` produce no per-row event** (its only writes are the purge, which records one `recruitment.purged`
  per company run).
- Application events (through `AuditEvents`): `recruitment.file_downloaded {kind, via: 'hr' | 'head' | 'interviewer'}`
  (subject `recruitment_candidate`), `recruitment.candidate_erased {applications, files}` (subject
  `recruitment_candidate`), `recruitment.purged {applications, candidates, files, before}` (worker, subject null, only
  when something was purged), and the workflow's own `workflow.*` events on the opening.
- Timeline subjects: `recruitment_opening:<id>` (its rows, workflow rows and events) and
  `recruitment_application:<id>` (its events and those of its candidate) — both visible with `recruitment.read` over
  the opening's unit, **without** `audit.read` (as `attendance_correction`), else 404. Labels:
  `audit.fields.recruitment_opening.*`, `audit.events.recruitment.*`.

### Retention, erasure and worker

- Cron **`recruitment.retention`** at `45 2 1 * *` (UTC, like the others; backfill 7 days; `maxAttempts` 10;
  idempotent), company by company as `hrforce_worker`; `payload.today` (`YYYY-MM-DD`) overrides the Algiers date.
- **Due**: an application with `purged_at` null, a final stage, and `(decided_at at time zone
  'Africa/Algiers')::date + retention_months` **before** today. Hired applications included (assumption 12).
- **Purge of one application**, in this order: its notes deleted; its salary row deleted; (Phase B) its evaluation
  scores, interviewers, interviews and offers deleted; the `comment` of its stage rows set to null; then
  `purged_at = now()` and `candidate_id = null`. Then every candidate left with **no** application: its file contents
  and file rows deleted, then the candidate row. What remains of the application: `opening_id`, `source`, final
  `stage`, `created_at`, `decided_at`, `purged_at`, `employment_id` (hired) and its stage rows (stages, reason code,
  instants, the HR user who moved it) — the anonymous counts.
- **Erasure on request** (`POST /recruitment/candidates/:id/erase`) runs the same purge at once for every application
  of the candidate, in the request transaction, and writes `recruitment.candidate_erased`.
- Database guards (tested as `hrforce_app` and `hrforce_worker`): an application is never deleted; `candidate_id` may
  only go to null together with `purged_at`; a purged application never changes again; a candidate is deleted only
  when unreferenced. Worker privileges: `SELECT` (0012 defaults); `DELETE` on `recruitment_note`,
  `recruitment_application_salary`, `recruitment_candidate_file`, `recruitment_candidate_file_content`,
  `recruitment_candidate`; `UPDATE (candidate_id, purged_at)` on `recruitment_application`; `UPDATE (comment)` on
  `recruitment_application_stage`; `EXECUTE` on `audit.record_event`. The app role holds the same writes (it runs the
  erasure on request) — the app-role trust question of HANDOFF applies.
- Not covered, stated for the owner: notifications never held candidate data; the workflow history holds none;
  backups keep erased rows up to `BACKUP_RETENTION_DAYS`; an opening's `justification` and `title` are kept for good
  (they describe a post, not a person — HR must not name a person in them; the form says so).

### Deploy and platform

- No new environment variable (`EMPLOYEE_FILE_MAX_BYTES` is reused; the web's constant stays the single client value).
- `deploy/Caddyfile`: the upload matcher (`request_body max_size 25MB`) also covers `POST
  /api/recruitment/candidates/*/files`; the sandbox-CSP matcher also covers
  `/api/recruitment/candidates/*/files/*/content` and `/api/me/recruitment/applications/*/files/*/content`.
- CSP and Permissions-Policy unchanged. No new npm dependency in either app (drag and drop, if built, uses the
  browser's own API).

### Web (Phase A)

Every screen: fr/ar/en keys under `recruitment.*` (fr/ar parity), RTL with logical properties, usable at 390 px. Names
follow the UI language (Arabic name when it exists). No Angular teaching comments, no `docs/angular` change (owner
decision 2026-10-01). Dates through the existing date pipe; money as the employee pages.

- **Routes.** `/recruitment` (`recruitment.read` or `recruitment.configure`; nav « Recrutement ») with children:
  `` (openings list), `openings/new`, `openings/:id` (tabs *Pipeline* · *Détails* · *Historique*), `candidates`,
  `candidates/:id` (`?application=<id>` selects an application), `settings` (`recruitment.configure`), `notice`.
  `/me/recruitment` (signed in), `/me/recruitment/new`, `/me/recruitment/openings/:id`. Refused routes show "not found"
  (existing rule).
- **Nav.** « Mes recrutements » appears when `GET /me/recruitment/summary` says `canRequestOpening` or `openings > 0`
  **and** the user lacks `recruitment.read` (HR uses « Recrutement »). The summary is fetched once after sign-in and
  after a request is created or cancelled.
- **Openings list** `/recruitment`: status chips with counts (click = filter), unit picker + sub-units, contract type,
  search — **all in the URL query** (as `/employees`); desktop table (reference, title, unit, contract, posts
  `hired/posts`, target date, status, candidates in progress), phone cards; « Demander une ouverture de poste ».
- **Request form** (`/recruitment/openings/new` and `/me/recruitment/new`, one component): title, unit (the org-unit
  picker; for a head without `recruitment.read`, a select of the units they head and their sub-units — from `GET
  /me/employment` `headOf` + the org tree they can read; the API decides), site (optional, « site de l'unité » by
  default), contract type, posts, target date, justification with the hint « Décrivez le besoin, sans nommer de
  personne. » 403 `forbidden-scope` on the unit and the 422 codes map to fields; top-of-form errors use
  `RevealAlertDirective`.
- **Opening detail** `/recruitment/openings/:id`: header (reference, title, unit, status chip, `hired/posts`, target
  date), the workflow stepper (`shared/workflow-stepper`) while pending or rejected, actions from `_actions` (edit
  dialog, close with reason, reopen with a confirmation that names how many applications come back).
  - *Pipeline* (the default tab once open): **the board**. Desktop: one column per active stage (`received`,
    `shortlisted`, `interview`, `offer`) with its count, plus a collapsed « Terminées » group (hired, rejected,
    withdrawn) loaded with `includeFinal=true` when expanded. Phone (≤ 640 px): one stage at a time behind a stage
    selector (tabs with counts), cards stacked. A card shows the name, time in stage (« depuis 4 j »), source, a CV
    icon, the notes count and « Déjà employé(e) » when `formerEmployee`. **Moving is a button first**: every card has
    « Déplacer vers… » (a menu of `moveTargets`, reachable by keyboard and touch; « Refus » opens a dialog with the
    reason select and a comment; « Désistement » a comment). Drag and drop between columns is **optional**, desktop
    pointer only, and must call the same action; it never replaces the button. A 409 `recruitment-stage-changed`
    shows the message of the wording table and reloads the board. « Ajouter une candidature » opens the add flow.
    A line « {n} candidatures anonymisées » when `purged > 0`.
  - *Détails*: every field, justification, ANEM reference, requester, approval history (`history`).
  - *Historique*: timeline `recruitment_opening:<id>`.
- **Add an application** (dialog or page from the board): step 1 identity (last/first name, Arabic names, birth
  date, NIN, e-mail, phone) — on leaving NIN / e-mail / phone (and before saving) the page calls `POST
  /recruitment/candidates/match` and lists the matches (« Candidature existante : … — utiliser cette fiche ») and the
  known person (« Déjà employé(e) dans l'entreprise : matricule …, parti(e) le … »); choosing an existing candidate
  sends `candidateId`. Step 2: source, expected salary (only with `recruitment.salary.update`), CV upload (the file is
  posted to the candidate after the application is created; a failed upload leaves the application and says so), the
  date the information notice was given, with a link to the printable notice. A 409 duplicate on e-mail / phone offers
  « Enregistrer quand même » (`allowDuplicate`).
- **Candidate page** `/recruitment/candidates/:id`: identity card (edit with `update`), known-person banner with
  « Lier à cette personne » / « Délier », files (upload with XHR progress and drag-and-drop, download as a Blob under
  the API's name rule, delete with confirmation — reuse the employee-file upload pieces), the applications as tabs or
  a select; for the selected application: stage chip + « Déplacer vers… », the **stage history** as a vertical list
  (who, when, reason, comment, automatic causes worded « Poste pourvu », « Recrutement clôturé », « Embauche
  annulée », « Recrutement rouvert »), notes (add; delete from `_actions`), the salary block or « Salaire masqué »
  when `_redacted`. « Effacer les données » (`erase`) with a confirmation that states it cannot be undone.
- **Candidates list** `/recruitment/candidates`: search, stage, state, opening, unit, « sans mouvement depuis 6 mois »
  (`idleMonths=6`), URL state; rows link to the candidate page with `?application=`.
- **Mes recrutements** `/me/recruitment`: the caller's openings as cards (status, stepper while pending, `hired/posts`,
  counts when present), « Demander une ouverture de poste », cancel while pending. Detail: the opening, its history,
  and — for a head — the applications grouped by stage (name, time in stage, file downloads through the `/me` content
  route). No move action, no notes, no identity details.
- **My tasks**: `recruitment_opening` tasks show reference, title, unit, site, contract type, posts, target date,
  justification and requester; approve / reject (comment required) as for leave.
- **Settings** `/recruitment/settings`, tabs: *Motifs de refus* (labels fr/ar/en, order, active; system reasons marked;
  the two automatic ones read-only), *Politique* (retention in months with the allowed range shown, approval chain
  radio « Responsable puis RH » / « RH uniquement »). Phase B adds *Critères d'évaluation*.
- **Information notice** `/recruitment/notice`: a print-friendly page (print stylesheet, no app chrome when printed)
  with the French and the Arabic text one under the other and a « Imprimer » button. `{company}` and `{months}` from
  `GET /recruitment/policy`.
  fr: « Les informations de votre candidature (identité, coordonnées, CV et pièces jointes, appréciations des
  entretiens) sont enregistrées par {company} pour la gestion de ce recrutement. Elles ne sont consultées que par le
  service des ressources humaines et les personnes chargées des entretiens. Si la candidature n'est pas retenue, elles
  sont effacées {months} mois après la décision. En cas d'embauche, elles sont versées au dossier du personnel. Vous
  pouvez demander à les consulter, à les faire rectifier ou effacer auprès du service des ressources humaines (loi
  n° 18-07 du 10 juin 2018). »
  ar: « تُسجَّل معلومات ملف الترشح (الهوية، بيانات الاتصال، السيرة الذاتية والوثائق المرفقة، تقييمات المقابلات) من طرف
  {company} لغرض تسيير عملية التوظيف هذه. لا يطّلع عليها إلا مصلحة الموارد البشرية وأعضاء لجنة المقابلة. في حال عدم
  قبول الترشح، تُحذف هذه المعلومات بعد {months} شهرا من تاريخ القرار. وفي حال التوظيف، تُحفظ ضمن ملف المستخدَمين. يمكن
  طلب الاطلاع عليها أو تصحيحها أو حذفها لدى مصلحة الموارد البشرية (القانون رقم 18-07 المؤرخ في 10 يونيو 2018). »
- **Home**: a « Recrutement » card with `GET /recruitment/summary` (openings pending / open, applications per active
  stage, each a link to the filtered list) for holders of `recruitment.read`; a « Mes recrutements » line (pending
  requests) from `MySummaryView` for heads.

### Seed (`seed:dev`, DEMO; TEST DATA — fictitious people, fixed ids, re-running adds nothing)

- Policy and reasons as seeded for every company.
- Openings (dates relative to the seed run):
  - `REC-2026-0001` « Chargé(e) de clientèle », `AG-ANNABA`, `cdi`, 2 posts, **open** — requested by `chef.annaba`,
    manager step approved by `rh.est` (linked to the Région Est director), HR step by `rh.admin`. Six applications:
    2 `received`, 1 `shortlisted`, 2 `interview`, 1 `rejected` (`experience`, with a comment), plus 1 `withdrawn`;
    notes on three of them; each candidate has a small generated CV PDF (`demoPdf('TEST DATA - CV …')`), one also a
    diploma PNG. One candidate is linked to the **person of an ended, not rehired demo employment** (`formerEmployee`),
    one has a NIN equal to no person, one carries an expected salary.
  - `REC-2026-0002` « Agent d'accueil », `SRV-CLI-ANB`, `cdd`, 1 post, **pending** at the manager step — requested by
    `chef.annaba`, so `rh.est` finds it in My tasks.
  - `REC-2026-0003` « Technicien réseau », `AG-CNE`, `cdi`, 1 post, **filled**: one `hired` application linked
    (`employment_id`) to a seeded active employee of `AG-CNE`, two closed by `position_filled`.
  - `REC-2026-0004` « Assistant(e) administratif(ve) », `AG-ORAN`, `cdd`, 1 post, **closed** (« Budget reporté ») with
    two applications closed by `opening_closed`; one of its candidates also applied to `REC-2026-0006`.
  - `REC-2026-0005` « Chauffeur », `AG-ANNABA`, `cdd`, 1 post, **rejected** at the HR step (comment « Poste non
    budgétisé cette année »).
  - `REC-2026-0006` « Conseiller(ère) commercial(e) », `AG-ORAN`, `cdi`, 1 post, **open**, 3 applications (so central
    HR sees two regions and `rh.est` sees none of it).
  - `REC-2025-0001` « Agent commercial », `AG-TLEMCEN`, `cdi`, 1 post, **closed** 14 months ago with three
    **already purged** applications (anonymous rows, no candidate) — the counts after erasure.
- BETA (test fixture): policy, reasons, one open opening on `BETA-RH` with one application and one CV. The e2e fixture
  option `recruitment: true` seeds the above for DEMO plus, per matrix target (`est` = `AG-CNE`, `ouest` = `AG-ORAN`,
  `other` = BETA), an open opening with enough applications, notes and files for every consuming row.

### Authorization matrix rows (expected, Phase A)

Actors and targets as in `authorization-matrix.e2e-spec.ts` (`est` = an opening of `AG-CNE` and its application /
candidate / file, `ouest` = of `AG-ORAN`, `other` = BETA's). `✓` = the route's success status. Row sets:
**REC_READ** = admin est/ouest ✓, other 404; est est ✓, est ouest 404; ouest ouest 403; acces est 403; beta est 404,
beta other ✓; agent est 403; chef est 403. **REC_MANAGE(✓)** = the same shape (lecture, acces, agent, chef 403 from
the guard). **REC_ADMIN(✓)** (`recruitment.erase`) = admin est/ouest ✓, other 404; est est 403; ouest 403; acces 403;
beta est 404, beta other ✓. **REC_CONFIG(✓)** = `CONFIG_ROWS` on the caller's company (+ beta on company A's id → 404
for `:id` routes).

| Route | Rows |
|---|---|
| `POST /recruitment/openings` (body's unit = the target's) | admin est/ouest 201; est est 201, est ouest 403; ouest ouest 403; acces est 403; agent est 403; chef est 403, **chef on `AG-ANNABA` 201** and on `SRV-CLI-ANB` 201 (own fixture rows); beta est 422 (unknown unit), beta other 201 |
| `GET /recruitment/openings`, `GET /recruitment/summary` | admin 200, est 200 (Est only — asserted), ouest 403, acces 403, beta 200, agent 403, chef 403 |
| `GET /recruitment/openings/:id`, `GET …/board` | REC_READ |
| `PATCH /recruitment/openings/:id`, `POST …/close`, `POST …/reopen` | REC_MANAGE(200), each ✓ row on its own fixture opening |
| `GET /me/recruitment/summary`, `GET /me/recruitment/openings` | every actor 200 (chef: `canRequestOpening` true and its openings — asserted; agent: false and empty) |
| `GET /me/recruitment/openings/:id` (chef's `AG-ANNABA` opening) | chef 200 (with applications), est 200 (Karim heads `REG-EST`: head role — asserted), admin 404, ouest 404, acces 404, agent 404, beta 404 |
| `POST /me/recruitment/openings/:id/cancel` (chef's pending one) | est 404, admin 404, agent 404; chef 200 last |
| `POST /recruitment/candidates/match` | admin 200, est 200 (an Ouest-only candidate's NIN returns no match — asserted), ouest 403, acces 403, beta 200, agent 403 |
| `GET /recruitment/candidates` | as `GET /recruitment/openings` |
| `GET /recruitment/candidates/:id`, `GET /recruitment/applications/:id`, `GET /recruitment/candidates/:id/files/:fileId/content` | REC_READ |
| `PATCH /recruitment/candidates/:id`, `PUT …/person`, `POST /recruitment/openings/:id/applications` (201), `PATCH /recruitment/applications/:id`, `POST …/move`, `POST …/reopen`, `POST …/notes` (201), `DELETE …/notes/:noteId` (204), `POST /recruitment/candidates/:id/files` (201), `DELETE …/files/:fileId` (204) | REC_MANAGE(✓), consuming rows on their own fixture rows |
| `POST /recruitment/candidates/:id/erase` | REC_ADMIN(204) |
| `GET /me/recruitment/applications/:id/files/:fileId/content` (an application of chef's opening) | chef 200, est 200 (head above), admin 404, agent 404, ouest 404, beta 404 |
| `GET /recruitment/policy`, `GET /recruitment/rejection-reasons` | admin 200, est 200, ouest 403, acces 403, beta 200, agent 403 |
| `PUT /recruitment/policy`, `POST /recruitment/rejection-reasons`, `PUT /recruitment/rejection-reasons/:id` | REC_CONFIG(✓) |
| `POST /tasks/:id/approve`, `/reject` on an opening task | covered by the existing task rows plus e2e below |
| anonymous | 401 on every route above |

Plus e2e (not matrix): the chain (chef requests for `AG-ANNABA` → manager task for `rh.est` as head of `REG-EST` →
HR task → `open`, requester notified, e-mail queued); a request by the regional head escalates past a missing head;
`hr_only` switch; the requester cannot approve (`workflow-self-approval`), HR who filed it cannot take the HR step;
rejection and cancel; `posts` raise refused, lowering to `hired_count` fills; close auto-rejects the active
applications with `opening_closed` and reopen restores exactly those; two parallel moves of one application → one 200
and one 409 `recruitment-stage-changed`; reject without a reason 422, with an `auto_only` reason 422; reopen lands in
the previous stage; duplicate rules (NIN never overridable, e-mail / phone with `allowDuplicate`, an out-of-scope
duplicate invisible); known person visible only with `employee.read` over the latest employment; salary redaction and
`forbidden-field`; upload sniffing / limits / headers as the employee-file tests, hard delete leaves no row; head view
fields (no NIN, contact, notes, salary in the body — asserted by key); the head loses file access once the stage is
final; the retention job (worker role, pinned `today`): a 13-month-old rejected application is purged, a 11-month-old
one is not, a candidate with one purged and one active application keeps its record and files, the last purge deletes
the candidate and its bytes, counts unchanged, no per-row audit events, one `recruitment.purged`; erasure on request;
after a purge **no personal value remains** in `public` or `audit` (search the dump for the candidate's name, NIN,
e-mail, phone, a note word and the file hash); database guards as `hrforce_app` (application DELETE, stage UPDATE,
un-purging refused); `assertNoSecrets` on every response.

---

## Phase B — criteria, interviews, evaluations, comparison, offers, hire

### Data (migration 0020)

| Table | Columns | Rules |
|---|---|---|
| `recruitment_criterion` | `id`, `company_id`, `code` (as reasons), `name_fr/ar/en` (1–120), `active`, `sort_order`, `is_system` | unique (`company_id`,`code`); no delete; audited normally. Seeded: `skills` (Compétences techniques / الكفاءات التقنية), `experience` (Expérience / الخبرة المهنية), `communication` (Communication / التواصل), `motivation` (Motivation / الحافز), `fit` (Adéquation au poste / الملاءمة للمنصب) |
| `recruitment_opening_criterion` | `company_id`, `opening_id`, `criterion_id`, `position int` | pk (`opening_id`,`criterion_id`); 1–8 per opening; audited normally (`audit.capture('opening_id')`). Filled with the active criteria when an opening becomes `open` (the migration backfills the openings that are not `pending`) |
| `recruitment_interview` | `id`, `company_id`, `application_id`, `label` null (1–120, e.g. « Entretien technique »), `scheduled_at timestamptz`, `duration_minutes int` (15–480, default 60), `mode` (`on_site`/`video`/`phone`), `location` null (1–200: a room or a link), `status` (`scheduled`/`cancelled`), `cancel_reason` null (3–500), `created_by uuid`, `created_at` | `cancelled` is final and needs the reason; app: INSERT, UPDATE, DELETE; worker DELETE |
| `recruitment_interviewer` | `id`, `company_id`, `interview_id`, `user_id uuid`, `recommendation` null (`strong_yes`/`yes`/`no`/`strong_no`), `comment` null (1–4000), `submitted_at` null | unique (`interview_id`,`user_id`); 1–5 per interview (application rule); `recommendation` not null ⇔ `submitted_at` not null; worker DELETE |
| `recruitment_evaluation_score` | `company_id`, `interviewer_id`, `criterion_id`, `score smallint` (1–5) | pk (`interviewer_id`,`criterion_id`); worker DELETE |
| `recruitment_offer` | `id`, `company_id`, `application_id`, `job_title` (1–120), `org_unit_id`, `site_id` null, `contract_type`, `start_date date`, `note` null (1–1000), `status` (`proposed`/`accepted`/`declined`/`cancelled`), `decided_at` null, `created_by uuid`, `created_at` | at most one `proposed` per application (partial unique index); the proposed salary is `recruitment_application_salary.proposed_salary`; worker DELETE |

All four personal tables (`interview`, `interviewer`, `evaluation_score`, `offer`) use
`audit.capture_recruitment_event()`: `recruitment.interview_scheduled` / `_updated {fields}` / `_cancelled`,
`recruitment.evaluation_submitted` (one per submission, not per score), `recruitment.offer_made` / `_updated {fields}`
/ `_declined` / `_cancelled` / `_accepted` — subject `recruitment_application:<id>`, no names, times, scores, comments
or amounts in `data`. Also: `recruitment_application_stage.auto_cause` check gains `interview_scheduled`;
`notification_subject_type_ck` gains `recruitment_interview`; the purge order of Phase A now includes these tables
(scores → interviewers → interviews → offers, before the stage comments).

### Criteria and evaluations

- Scores are whole numbers **1–5** for **every** criterion of the opening (422 `scores` `incomplete` / `unknown`),
  plus a recommendation (required) and a comment (optional). An evaluator's **overall** = the mean of their scores;
  an application's **average** = the mean of the submitted evaluators' overalls over its non-cancelled interviews;
  both rounded to one decimal (half up), null when nothing is submitted.
- `PUT /recruitment/openings/:id/criteria {criterionIds}` (1–8 active criteria, order = position) while the opening is
  `open` and **no evaluation of the opening is submitted**, else 409 `recruitment-criteria-locked`.
- An evaluation may be submitted and re-submitted while the interview is `scheduled` and the application is in the
  stage `interview` (else 409 `recruitment-evaluation-closed`); before `scheduled_at` → 409
  `recruitment-interview-not-held`.

### Interviews

- **Schedule** (`recruitment.manage`): `{date, time, durationMinutes?, mode, location?, label?, interviewerIds}` (Algiers
  local date and `HH:MM`; a past date is allowed — recording an interview already held). The application must be in
  `received`, `shortlisted` or `interview` (else 409 `recruitment-interview-stage`) and its opening `open`; an
  application in `received` / `shortlisted` moves to `interview` in the same
  transaction (`auto_cause` `interview_scheduled`). `interviewerIds`: 1–5 distinct **active users of the company**
  (422 `interviewerIds.<i>` `not_found`, `duplicate`); a user whose linked employment belongs to the candidate's
  linked person → 422 `self`.
- **Change** (`PATCH`): date, time, duration, mode, location, label, `interviewerIds`. Removing an interviewer who
  already submitted → 409 `recruitment-evaluation-exists`. **Cancel**: reason required; cancelled interviews leave the
  averages.
- **Interviewer access** (no grant): while the interview is `scheduled` **and** the application is in an active stage,
  an interviewer reads `MyInterviewView` (the candidate's name, the opening, the interview, the candidate's files,
  the criteria, their own evaluation) and downloads the files through the `/me` content route. Never: NIN, birth
  data, contact details, salary, notes, stage history, the other evaluations. Once the application is final or the
  interview cancelled, the interview disappears from their lists (404).
- The picker `GET /recruitment/interviewers?q=` (`recruitment.manage`; `q` ≥ 2 characters; ≤ 20) returns active users
  of the company: `{id, displayName, employee: {matricule, unit: UnitRef} | null}`.

### Offers

- **Make** (`POST …/offer`, `recruitment.hire`): `{expectedStage, jobTitle, orgUnitId, siteId?, contractType,
  startDate, note?, proposedSalary?: string}` (defaults proposed by the web from the opening). From `received`,
  `shortlisted` or `interview` → stage `offer`. `orgUnitId` must be the opening's unit or one of its sub-units (422
  `orgUnitId` `outside_opening`). **409 `recruitment-no-post-left`** when `hired_count` + the opening's `proposed`
  offers ≥ `posts`. `proposedSalary` needs `recruitment.salary.update` (403 `forbidden-field`).
- **Edit** (`PUT …/offer`) while `proposed`. **Decline** (`POST …/offer/decline {expectedStage, comment?}`): offer
  `declined`, stage `withdrawn`. **Cancel** (`POST …/offer/cancel {expectedStage, comment?}`): offer `cancelled`,
  stage `interview`. Acceptance is not a separate step: **the hire accepts the offer**.

### Hire

`GET /recruitment/applications/:id/hire-prefill` → `HirePrefillView`; `POST /recruitment/applications/:id/hire`
(`recruitment.hire`) with the **body of `POST /employees`** (`employment.md`: `personId` | flat person fields,
`matricule`, `hireDate`, `orgUnitId`, `siteId?`, `jobTitle`, `salary?`, `bank?`, `nss?`) plus `expectedStage: 'offer'`
and `copyFileIds: string[]` (0–5 files of the candidate; unknown id → 422 `copyFileIds.<i>` `not_found`).

**One request transaction** (everything below commits or nothing does — no compensation to write):
1. lock the opening, then the application; `expectedStage` / stored stage must be `offer` with a `proposed` offer
   (409 `recruitment-stage-changed`); the opening `open` (409 `recruitment-opening-not-open`) with `hired_count <
   posts` (409 `recruitment-no-post-left`);
2. the person: when the candidate has a **linked** person (`person_id`), the body must carry that `personId` and no
   person fields (422 `personId` `required`); a linked person with an open employment → 409
   `recruitment-person-employed` (assumption 17); without a link the body carries the person fields (a `personId` →
   422 `personId` `not_linked`);
3. `EmployeesService.create(body)` — **unchanged**, so every rule and problem of `POST /employees` applies with the
   same status, slug and field: `employee.create` over `orgUnitId` (403 `forbidden-scope`), sensitive blocks (403
   `forbidden-field`), 422 field errors, 409 `matricule-taken`, `nin-taken`, `employment-open`, `hire-date`. Any of
   them rolls the whole hire back: the application is still in `offer`, the form shows the error on the field and the
   user corrects and resubmits;
4. `EmployeeFileImporter.copy(employmentId, files)` (Documents): one `employee_file` + content row per chosen
   candidate file, category `recruitment`, same title / file name / type / bytes, `uploaded_by` = the caller; a file
   whose bytes are already in that employee's file is skipped. No `employee_file.upload` permission is asked (the hire
   permission covers the copy);
5. application → `hired` (stage row, `decided_at`, `employment_id`); offer → `accepted`; candidate `person_id` = the
   person; opening `hired_count + 1`, and when it reaches `posts` the opening is **filled** (Phase A rule: the other
   active applications are closed with `position_filled`, their proposed offers cancelled, their future interviews
   cancelled and the interviewers told);
6. event `recruitment.hired {openingId, applicationId}` with subject `employee:<employment id>` (the employee's
   History shows « Recruté(e) via <référence> »).

→ **201** `{employee: EmployeeDetail, application: ApplicationDetailView, opening: OpeningView}` + `Location:
/api/employees/<id>`. The web's existing `POST /employees` and its page are untouched.

**Undo** (`POST /recruitment/applications/:id/undo-hire {reason}` (3–500), `recruitment.hire`) — for an employment
created by mistake or a person who never started. Employments are never deleted, so HR first **ends** the employment
on the employee page (existing action); the undo then requires the linked employment to have an end date (409
`recruitment-employment-open`) and an unpurged application. Effects, one transaction: application `hired → offer`
(`auto_cause` `hire_undone`, the reason as its comment), `employment_id` null, the offer back to `proposed`,
`hired_count − 1`, a `filled` opening back to `open` with the applications closed by that fill restored (Phase A
rule); event `recruitment.hire_undone {openingId, applicationId}` on `employee:<id>`. The files copied into the
employee file stay there (HR deletes them there if needed). From `offer`, HR hires again (a rehire of the now-linked
person), declines or cancels.

### Endpoints (Phase B)

| Method + path | Guard | Request → response |
|---|---|---|
| `GET /recruitment/criteria` | `recruitment.read` | → `{items: CriterionView[]}` |
| `POST /recruitment/criteria`, `PUT /recruitment/criteria/:id` | `recruitment.configure` (company) | `{code, labels}` / `{labels?, active?, sortOrder?}` → 201 / 200; 409 `recruitment-criterion-code-taken` |
| `PUT /recruitment/openings/:id/criteria` | `recruitment.manage` | `{criterionIds}` → 200 `OpeningDetailView` |
| `GET /recruitment/interviewers?q=` | `recruitment.manage` | above |
| `POST /recruitment/applications/:id/interviews` | `recruitment.manage` | above → **201** `InterviewView` |
| `PATCH /recruitment/interviews/:id` | `recruitment.manage` | → 200 `InterviewView`; cancelled → 409 `recruitment-interview-cancelled` |
| `POST /recruitment/interviews/:id/cancel` | `recruitment.manage` | `{reason}` → 200 `InterviewView` |
| `GET /recruitment/openings/:id/comparison` | `recruitment.read` | → `ComparisonView` |
| `GET /me/recruitment/openings/:id/comparison` | `@Authenticated` | head of the opening, else 404 → `ComparisonView` |
| `GET /me/recruitment/interviews?filter=` | `@Authenticated` | `filter` = `todo` (default: my evaluation not submitted) \| `done` → `{items: MyInterviewView[]}` soonest first |
| `GET /me/recruitment/interviews/:id` | `@Authenticated` | an interviewer (access rule), else 404 → `MyInterviewView` |
| `PUT /me/recruitment/interviews/:id/evaluation` | `@Authenticated` | `{scores: {criterionId, score}[], recommendation, comment?}` → 200 `MyInterviewView` |
| `POST /recruitment/applications/:id/offer`, `PUT …/offer`, `POST …/offer/decline`, `POST …/offer/cancel` | `recruitment.hire` | above → 201 / 200 `ApplicationDetailView`; no proposed offer → 409 `recruitment-no-offer` |
| `GET /recruitment/applications/:id/hire-prefill` | `recruitment.hire` | → `HirePrefillView`; not in `offer` → 409 `recruitment-stage-changed` |
| `POST /recruitment/applications/:id/hire` | `recruitment.hire` | above → 201 |
| `POST /recruitment/applications/:id/undo-hire` | `recruitment.hire` | above → 200 `ApplicationDetailView` |

```ts
type Recommendation = 'strong_yes' | 'yes' | 'no' | 'strong_no';
interface CriterionView { id: string; code: string; labels: Labels; active: boolean; sortOrder: number; isSystem: boolean }
interface EvaluationView { interviewer: UserRef; submittedAt: string | null;
  scores: { criterionId: string; score: number }[]; overall: number | null;
  recommendation: Recommendation | null; comment: string | null }
interface InterviewView { id: string; applicationId: string; label: string | null; scheduledAt: string;
  date: string; time: string;                                            // Algiers
  durationMinutes: number; mode: 'on_site' | 'video' | 'phone'; location: string | null;
  status: 'scheduled' | 'cancelled'; state: 'upcoming' | 'awaiting_evaluations' | 'complete' | 'cancelled';
  cancelReason: string | null; createdBy: UserRef | null;
  evaluations: EvaluationView[];                                         // one per interviewer, submitted or not
  average: number | null; _actions: ('update' | 'cancel')[] }
interface MyInterviewView { id: string; label: string | null; scheduledAt: string; date: string; time: string;
  durationMinutes: number; mode: 'on_site' | 'video' | 'phone'; location: string | null;
  opening: { id: string; reference: string; title: string; unit: UnitRef };
  applicationId: string; candidate: NamePair; files: CandidateFileView[]; // _actions always []
  criteria: { id: string; labels: Labels }[];
  evaluation: Omit<EvaluationView, 'interviewer'>; _actions: ('evaluate')[] }
interface OfferView { id: string; jobTitle: string; unit: UnitRef; site: SiteRef | null; contractType: ContractType;
  startDate: string; note: string | null; status: 'proposed' | 'accepted' | 'declined' | 'cancelled';
  decidedAt: string | null; createdAt: string; createdBy: UserRef | null }
interface ComparisonView { opening: OpeningRef; criteria: { id: string; labels: Labels }[];
  rows: { applicationId: string; candidate: NamePair & { id: string }; stage: Stage;
          interviews: number; evaluations: { submitted: number; expected: number };
          criteria: { criterionId: string; average: number | null }[]; average: number | null;
          recommendations: Record<Recommendation, number>;
          comments: { interviewer: UserRef; interviewLabel: string | null; recommendation: Recommendation; comment: string | null }[] }[] }
          // applications that have at least one non-cancelled interview, best average first (null last), then name
interface HirePrefillView {
  person: { personId: string | null } & CandidateInput;                 // personId set = rehire: show identity read-only, send only personId
  knownPerson: KnownPersonView | null;
  orgUnitId: string; siteId: string | null; jobTitle: string; hireDate: string;   // from the proposed offer
  salary?: { baseSalary: string | null };                               // only with recruitment.salary.read AND employee.salary.update over the unit
  files: CandidateFileView[]; defaultCopyFileIds: string[];             // the cv files
  opening: OpeningRef; expectedStage: 'offer' }
```
Additions to Phase A views: `ApplicationDetailView` gains `interviews: InterviewView[]` (soonest last), `offer:
OfferView | null` (the latest), `average: number | null`, `employment: {id, matricule} | null` (hired; only when the
caller can read it with `employee.read`), `salary.proposed`, and `_actions` `schedule_interview`, `make_offer`,
`update_offer`, `decline_offer`, `cancel_offer`, `hire`, `undo_hire`; `BoardCard` gains `nextInterviewAt: string |
null`, `average: number | null`, `pendingEvaluations: number`; `HeadApplicationView` gains `average`, `interviews:
number`; `OpeningView` gains `criteria: {id, labels}[]` and the action `set_criteria`; `SummaryView` gains
`interviewsNext7Days`, `offersPending`; `MySummaryView` gains `interviews` (visible to me) and `evaluationsTodo`.

### Notifications (Phase B)

| Type | When | Recipients | Email default | Link |
|---|---|---|---|---|
| `recruitment.interview_assigned` | an interview is scheduled, an interviewer is added, or its date / time / place changes (`data.rescheduled` = 1) | the interviewers concerned, minus the actor | on | `/me/interviews/<interview id>` |
| `recruitment.interview_cancelled` | an interview is cancelled (by HR, or by an opening being filled / closed) or an interviewer is removed | the interviewers concerned, minus the actor | on | `/me/interviews` |
| `recruitment.evaluations_complete` | the last expected evaluation of an interview is submitted | the user who scheduled it (`created_by`), unless they are the actor | off | `/recruitment/candidates/<candidate id>?application=<id>` |

Subject `recruitment_interview`. `data`: `{interviewId, openingId, reference, title, date, time, mode, actorName}` —
**no candidate name** (the evaluations-complete link carries ids only). Wording — fr: « Entretien à mener le <date> à
<heure> — <titre> (<référence>) », « Entretien du <date> annulé — <titre> (<référence>) », « Toutes les évaluations
de l'entretien du <date> sont saisies — <titre> (<référence>) »; ar: « مقابلة مبرمجة يوم <التاريخ> على الساعة <الوقت> —
<العنوان> (<المرجع>) », « تم إلغاء مقابلة يوم <التاريخ> — <العنوان> (<المرجع>) », « تم إدخال جميع تقييمات مقابلة يوم
<التاريخ> — <العنوان> (<المرجع>) ». E-mails likewise (fr/ar/en), with the link and never a name.

### Web (Phase B)

- **Candidate page**: an *Entretiens* section per application — schedule dialog (date, time, duration, mode, place,
  label, interviewer picker with chips, 1–5), each interview with its state, the evaluations (scores per criterion,
  overall, recommendation, comment; « en attente » for the missing ones), edit / cancel; an *Offre* section (make,
  edit, « Offre déclinée », « Annuler l'offre », and **« Embaucher »**); after the hire a link to the employee and
  « Annuler l'embauche » (explains that the employment must be ended first).
- **Board**: cards show the next interview date, the average and « n évaluation(s) attendue(s) »; the move menu gains
  « Planifier un entretien » and « Proposer une offre » where `_actions` allow; the *offer* column is live.
- **Comparison** tab of the opening (and of the head's opening page): a table, one row per application, columns =
  criteria averages, overall average, recommendations as counted chips, evaluations `submitted/expected`; a row
  expands to the comments. Phone: one card per application with the criteria as a list. Sortable by average.
- **Mes entretiens** `/me/interviews` (signed in; nav when `MySummaryView.interviews > 0`, with a badge of
  `evaluationsTodo`): « À évaluer » / « Évalués »; `/me/interviews/:id`: the interview, the candidate's name and files,
  and the **evaluation form** — one row per criterion with five radio buttons (labelled 1–5, « Insuffisant » …
  « Excellent » / « غير كاف » … « ممتاز »; keyboard and touch friendly, 44 px targets), the recommendation, the
  comment; disabled with the reason before the interview time or once closed.
- **Hire** `/recruitment/applications/:id/hire` (`recruitment.hire` **and** `employee.create`, else not found): the
  **existing create-employee form** (`employee-create.page` / `employee-forms` / `person-form`, reused, not copied) in
  hire mode — prefilled from `hire-prefill`; with `person.personId` the identity is read-only as on the rehire page
  and only `personId` is sent; matricule and hire date as usual; a « Pièces à verser au dossier » checklist
  (`defaultCopyFileIds` ticked); a banner « Embauche pour <référence> — <titre> ». Submit → `POST …/hire`; the
  employee problems map to the same fields as on `/employees/new`; the recruitment 409s show above the form with a
  link back to the candidate. Success → the new employee's page.
- **Settings**: *Critères d'évaluation* tab; the opening's *Détails* tab lists its criteria with « Modifier » while
  allowed.
- **Home**: the Recrutement card adds interviews in the next 7 days and offers in progress; « Mes entretiens à
  évaluer (n) » for interviewers.

### Seed (Phase B additions)

Criteria as seeded for every company and copied to the non-pending openings. `REC-2026-0001`: the two `interview`
applications get interviews — one held three days ago with `rh.est` and `chef.annaba`, both evaluations submitted
(comparison has data); one in two days with `chef.annaba` and `rh.admin`, nothing submitted (chef's « À évaluer »);
the `shortlisted` application becomes an `offer` (proposed, start date next month, a proposed salary). The hired
application of `REC-2026-0003` gets an accepted offer and one evaluated interview. The e2e fixture adds, per matrix
target, an application in `offer` (hire rows), a hired one whose employment is ended (undo rows) and an interview
with `chef` as interviewer.

### Authorization matrix rows (Phase B)

**REC_HIRE(✓)** has the shape of REC_MANAGE (admin and `rh_regional` hold `recruitment.hire`).

| Route | Rows |
|---|---|
| `GET /recruitment/criteria` | as `GET /recruitment/policy` |
| `POST /recruitment/criteria`, `PUT /recruitment/criteria/:id` | REC_CONFIG(✓) |
| `PUT /recruitment/openings/:id/criteria`, `POST /recruitment/applications/:id/interviews` (201), `PATCH /recruitment/interviews/:id`, `POST …/cancel` | REC_MANAGE(✓) |
| `GET /recruitment/interviewers` | admin 200, est 200, ouest 403, acces 403, beta 200 (BETA users only — asserted), agent 403 |
| `GET /recruitment/openings/:id/comparison` | REC_READ |
| `GET /me/recruitment/openings/:id/comparison` | as `GET /me/recruitment/openings/:id` |
| `GET /me/recruitment/interviews` | every actor 200 (chef: its interview — asserted; agent: empty) |
| `GET /me/recruitment/interviews/:id`, `PUT …/evaluation` (chef's interview) | chef 200; est 404, admin 404 (HR are not interviewers of it), agent 404, ouest 404, beta 404 |
| `GET /me/recruitment/applications/:id/files/:fileId/content` (an `AG-CNE` application where chef is only an interviewer) | chef 200, agent 404 |
| `POST /recruitment/applications/:id/offer` (201), `PUT …/offer`, `POST …/offer/decline`, `POST …/offer/cancel`, `GET …/hire-prefill`, `POST …/undo-hire` | REC_HIRE(✓) |
| `POST /recruitment/applications/:id/hire` | REC_HIRE(201); plus a custom role holding `recruitment.hire` without `employee.create` → 403 `forbidden-scope` |

Plus e2e: scheduling moves a shortlisted application to `interview`; interviewer isolation (no other evaluation, no
NIN / contact / note / salary keys in `MyInterviewView`); evaluation before the interview time 409, incomplete scores
422, re-submission, closed after the stage leaves `interview`; averages and rounding; `evaluations_complete` only after
the last one; notifications contain no candidate name (asserted against the seeded names); criteria locked after the
first evaluation; offers never exceed the posts; the hire end to end (employee created with the form's values,
application `hired`, offer `accepted`, CV in the employee file under `recruitment` with identical bytes, opening
count, `recruitment.hired` on the employee timeline); the hire of the last post fills the opening and closes the
others, cancels their interviews; **atomicity** — a taken matricule, a taken NIN and an out-of-scope unit each leave
the application in `offer`, no person / employment / file row and the opening count unchanged; two parallel hires on
the last post → one 201 and one 409; rehire through a linked person (`personId`), linked person still employed 409;
undo refused while the employment is open, then restores the opening and the auto-closed applications; the purge
erases interviews, scores, comments, offers and the salary row of a decided application and of a hired one after the
period, and the employee, the employee file copy and `employment_id` remain.

## Settled by the build

*(to be filled by the builders: fixture ids, the demo employee linked to the hired application, check-order details,
anything this contract left open)*

### Settled by the build (Phase A API)

**Shape changes and additions the web must know (everything else is as specified above).**

- **No view shape differs from the contract.** `CandidateFileView` carries no hash (the `ETag` of a download is the
  only place the SHA-256 appears).
- Problem codes the contract left open:
  - `POST /recruitment/openings/:id/applications` with both or neither of `candidateId` / `candidate` → 422
    `errors[{field: 'candidate', code: 'one_of'}]`; a new candidate's field errors are `candidate.<field>`
    (`candidate.nin`, `candidate.email`, …), while the 409 `recruitment-candidate-duplicate` names the bare fields
    `nin` / `email` / `phone` (as the contract says). 409 `recruitment-already-applied` carries
    `errors[{field: 'candidateId', code: 'already_applied'}]`.
  - `POST …/move`: a rejection reason that is unknown, of another company **or `auto_only`** → 422
    `rejectionReasonId` `not_found`; inactive → `inactive`; missing → `required`; a `rejectionReasonId` sent with a
    `toStage` other than `rejected` → 422 `rejectionReasonId` `not_allowed`. `toStage` not reachable from
    `expectedStage` (from a final stage, from `hired`) → 422 `toStage` `not_allowed`. These static checks run before
    the 404 / 403 (they never depend on the stored row).
  - `POST …/reopen` with an `expectedStage` that is not `rejected` / `withdrawn` → 422 `expectedStage` `not_final`
    (`not_allowed` for `hired`).
  - `POST /recruitment/candidates/match` with nothing to match on → 422 `errors[{field: 'nin', code: 'required'}]`.
    Name + birth date matching needs all three of `lastName`, `firstName`, `birthDate`; the names alone are accepted
    and match nothing.
  - `PUT /recruitment/rejection-reasons/:id` `active` on an `auto_only` reason → 422 `active` `auto_only`;
    `sortOrder` is 0–899 (the automatic reasons sit at 900 / 910); a new reason gets the last user position + 10.
  - `DELETE …/notes/:noteId` by someone who is neither the author nor an eraser → 403 `forbidden` (no `errors`).
  - 403 `forbidden-scope` of `POST /recruitment/openings` carries `errors[{field: 'orgUnitId', code: 'forbidden_scope'}]`.
- `PATCH /recruitment/openings/:id`: `targetDate` is refused when it **changes** to a past date (422 `past`); `posts`
  below 1 is the DTO's 422 (`too_small`), `below_hired` only applies above that. Order: 404 / 403 → 409
  `recruitment-opening-not-open` → these 422s.
- `PATCH /recruitment/candidates/:id` checks duplicates only on the values that **change**, so a record saved with
  `allowDuplicate` stays editable without resending the flag.
- `ApplicationDetailView._actions`: `move` (manageable, opening open, active stage), `reopen` (manageable, opening
  open, `rejected` / `withdrawn`), `add_note` and `update` (manageable, whatever the stage), `update_salary`
  (manageable + `recruitment.salary.update`). `NoteView._actions` holds `delete` for the author and for holders of
  `recruitment.erase` over the unit. `CandidateView._actions`: `update`, `upload`, `link_person` with
  `recruitment.manage` over one visible application's unit; `erase` with `recruitment.erase` over **all** its
  applications' units (visible or not).
- `OpeningView._actions`: `['update', 'close', 'add_application']` while open, `['reopen']` while closed **and**
  `hiredCount < posts`, else `[]`. `MyOpeningView.counts` is null without the head role; `_actions` is `['cancel']`
  for the requester while pending.
- `moveTargets` from `offer` is `['rejected']` only (Phase B's offer endpoints do the rest).
- Lists default direction: `sort=requestedAt` desc, the others asc (`dir` overrides); candidates `sort=name` asc,
  `stageSince` / `createdAt` desc. `idleMonths` is 1–60. `q` on candidates also matches the e-mail and — from three
  digits on — the phone, whatever the way it is written.
- The 201 of `POST /recruitment/openings` is an `OpeningDetailView` for every requester (a head without
  `recruitment.read` gets `_actions: []` and should continue on `/me/recruitment/openings/<id>`).
- `task.assigned` / `task.escalated` data of an opening: `{openingId, reference, title, unitName, unitNameAr, posts,
  actorName, subjectType: 'recruitment_opening', stepKey, taskId | escalationReason}`; the subject of
  `task.escalated`, `recruitment.opening_approved` and `_rejected` is `recruitment_opening:<id>` (link
  `/me/recruitment/openings/<id>`).

**Data (migration `0019_recruitment.sql`).**

- `recruitment_application_stage` has a technical column `seq bigint generated always as identity`: the order of an
  application's transitions ("latest transition" = highest `seq`; two moves of one transaction share `moved_at`).
- `hrforce_app` holds `UPDATE (comment)` on `recruitment_application_stage` (the erasure on request blanks the
  comments); a guard trigger only lets a comment go to null, for the app and the worker alike. Every other column of
  the history is unwritable for both.
- The application guard also refuses purging an application that is not decided, and any change of a purged row.
- `recruitment_opening_sequence` is audited with `audit.capture('company_id')` as specified.
- Erasure on request writes, besides `recruitment.candidate_erased {applications, files}`, the per-row events of the
  app's own deletes (`recruitment.note_deleted`, `recruitment.salary_changed`, `recruitment.file_deleted`,
  `recruitment.application_updated {fields: ['candidate_id', 'purged_at']}`, `recruitment.candidate_deleted`) — names
  and kinds only. The worker's purge writes none of them (one `recruitment.purged` per company run).
- The DTO checks a phone number holds a digit; `phone_key` falls back to the bare digits when stripping the prefix
  would leave nothing.

**Seed and fixtures.**

- DEMO (`seedDemoRecruitment`, ids `0190a5d0-0000-7000-9b0k-…`): the seven openings of *Seed*. REC-2026-0001 holds
  **seven** applications (2 received, 1 shortlisted, 2 interview, 1 rejected, 1 withdrawn). The former employee is
  candidate 4, linked to the person of **EMP-0025** (Agence Constantine, resigned 2026-06-30); the hired application
  of REC-2026-0003 is linked to **EMP-0028** (active, Agence Constantine). The three Région Ouest openings
  (REC-2026-0004, -0006, REC-2025-0001) are recorded **without an approval history** (`workflow: null`, empty
  `history`): rh.admin is the only HR of that region and nobody approves their own request. The opening counter is
  set to the highest seeded number of each year.
- `seedRecruitmentDefaults(db, companyId)` (policy, the two chains, the ten reasons) is called by `bootstrap`, by
  `seed:dev` and by the e2e access fixture for both companies; the system file category `recruitment` comes with
  `seedDocumentDefaults` (`SYSTEM_FILE_CATEGORIES`, sort order 60 — a category created through the API now starts
  at 70).
- e2e fixture `recruitment: true` (`test/support/recruitment-fixture.ts`, needs `leave: true`): the DEMO data plus,
  per matrix target, a main open opening (`REC-2020-…` references, which never collide with the API's numbers), its
  main application / candidate / CV / note and pools of 12 rows per consuming route.
- Matrix: `POST /recruitment/openings` has the chef row on `AG-ANNABA` (201); the `SRV-CLI-ANB` case is the seeded
  REC-2026-0002 and the head-view tests (a head's units include their sub-units).

**Not in Phase A (as planned):** offer, hire, undo-hire, criteria, interviews, evaluations, comparison,
`EmployeeFileImporter`. The model is ready for them (`offer` / `hired` stages, `employment_id`, `proposed_salary`,
`hire_undone` / `opening_filled` causes, `OpeningsService.fill` and `.restore`).

### Settled by the verification (Phase A, 2026-10-08)

Behaviour observed by the independent verification (full gate, browser fr/ar/en at 1280 and 390 px, security probes)
that the text above did not state.

- **Approval chain.** The manager task goes to **one** user (the head at or above, never the requester); the HR task
  to every holder of `recruitment.approve_opening` over the unit, **including the user who took the manager step**:
  when the head above is also regional HR (rh.est in the demo), that one person may approve both steps. Only the
  requester is kept out (`workflow-self-approval`); the notification of the HR step skips the actor of the manager
  step. A task that is not the caller's answers 404. An HR request whose head above is missing is escalated
  (`manager` step `escalated`) and waits for another HR user.
- **Who a head may request for in the web.** A head without `org_unit.read` is offered only the units of
  `GET /me/employment` `headOf` (the sub-units are not listed, although the API accepts them).
- **Guard before scope.** A caller without the route's permission anywhere gets **403** whatever the id (e.g.
  `rh_regional` on `POST /recruitment/candidates/:id/erase`, known id or not): the 404 rule applies among holders of
  the permission. `recruitment_candidate` is not a timeline subject (422 with `audit.read`, 403 without).
- **Application timeline and salary.** `recruitment.salary_changed` events are returned only to callers holding
  `recruitment.salary.read` over the opening's unit; for the others the application timeline holds no salary entry at
  all (their existence would say a salary was entered, which `_redacted` hides).
- **Stage check before the opening's status.** A move or reopen on an application of an opening closed meanwhile
  answers 409 `recruitment-stage-changed` when the card on screen is stale (the closing changed its stage), else 409
  `recruitment-opening-not-open`; the web reloads the board in both cases.
- **Close / reopen and time in stage.** Restored applications get a new `stage_since` (the reopening), so « depuis … »
  restarts; an application rejected by hand before the closing stays rejected.
- **Retention boundary.** An application decided on day D (Algiers) with N months is purged by a run whose `today` is
  **after** D + N months (a run on that very day keeps it). A run that purges nothing writes no event; a second run
  on the same date is a no-op. A candidate with one purged and one active application keeps its record and files.
- **Files.** A PDF must be complete (header at byte 0 and its end marker): a truncated or padded PDF is
  `unsupported_type`. The stored `originalFilename` keeps the sanitised name as sent (`poly.html`, `image.pdf`); the
  download name follows the sniffed type (`poly.html.pdf`, `image.pdf.png`). Through the deploy Caddyfile: both
  content routes keep `sandbox; default-src 'none'`, 26 MB is refused with 413 by the proxy, 12 MB with 422
  `too_large` by the API.
- **Duplicates.** `PATCH /recruitment/candidates/:id` to the NIN, e-mail or phone of a candidate outside the caller's
  scope succeeds (nothing is revealed), as does creating one; central HR then sees two matches.
- **Money input (web).** As on the employee pages: digits with an optional `,` or `.` and at most two decimals, no
  thousands separator (« 85 000,50 » is refused in the form).
- **Future birth date.** Refused by the web form only; the API accepts it (as `POST /employees`).
