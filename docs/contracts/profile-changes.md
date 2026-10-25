# Contract — Personal details and self-service profile changes

Binding contract between `apps/api` (Employment: new personal-details tables and HR endpoints; new module `profile`
for the employees' change requests; small additions to Workflow, Notifications, Documents' file importer, the worker)
and `apps/web` (« Mon profil » for employees, a « Coordonnées et famille » tab for HR, the request panel in « Mes
tâches », settings). Owner decision 2026-10-24 (`docs/HANDOFF.md`).

HRForce holds identity, employment and bank details but **no contact or family data** yet. This slice adds them, lets
HR keep them, and lets employees ask for changes to their own data from the web app (phones first); changes that need
proof go to HR for approval with a supporting document, which joins the employee file when approved.

Built by four builders in parallel (API ×2, web ×2, ownership below), then verified. No new infrastructure, no new
environment variable, no ADR.

## ⚠ Assumptions to confirm with the owner

| # | Assumption | Default in this contract | Where it lives |
|---|---|---|---|
| 1 | Data kept | **Contact**: personal mobile, other phone, personal e-mail, address (line, commune, wilaya, postal code). **Emergency contact**: name, relationship, phone (one person). **Family**: marital status (`single` / `married` / `divorced` / `widowed`), date of that status, spouse employed (yes/no/unknown), **dependent children** (first name, birth date, sex — for family allowances). **Bank**: RIB + bank name (existing) | tables below |
| 2 | Who sees them | HR with the new `employee.personal.read` (central + regional HR in scope). The `lecture` role does **not** see them (Law 18-07: only who needs them). Bank stays `employee.bank.read` (central HR) | permissions |
| 3 | Which changes need approval | **Contact** and **emergency contact**: applied at once (audited, HR can see the history). **Family**: HR approval with a supporting document (livret de famille, acte de mariage, extrait de naissance). **Bank**: central-HR approval with a RIB document, and an e-mail to the employee's account when approved (security notice) | `profile_policy` (per section: `immediate` / `approval`; bank is always `approval`) |
| 4 | One section per request | A request changes one section (contact, emergency, family or bank). At most one pending request per employee and section | — |
| 5 | Identity | Names, birth date, NIN, NSS are **not** self-service (HR changes them from official papers); the profile page shows them read-only with « Signaler une erreur » = a free-text note to HR (a request of section `identity_note`, nothing applied) | section `identity_note` |
| 6 | Own RIB | The employee sees their RIB **masked** (last 4 digits) and the bank name | `/me/profile` |
| 7 | Supporting files | 1–3 files per request (PDF/JPEG/PNG, the employee-file size limit). Approved → copied into the employee file under the system category « Pièces justificatives » (new, standard class); rejected or cancelled → the bytes are erased **30 days** after the decision by the worker | `profile_policy.file_retention_days` |
| 8 | Who approves | Family / identity note: HR holding `employee.personal.update` over the employee (central + regional HR). Bank: `employee.bank.update` (central HR). Nobody approves their own request | workflow definitions |
| 9 | Self-service access | Any user linked to an employment (the existing `employe` role gets the new `profile.request_self`), also after the employment ended? **No**: only while the employment is open | permission + rule |

## Wording (fr / ar / en, gender-neutral Arabic — owner rule 2026-09-29)

| Idea | fr | ar | en |
|---|---|---|---|
| My profile | Mon profil | ملفي الشخصي | My profile |
| Contact details | Coordonnées | معلومات الاتصال | Contact details |
| Emergency contact | Personne à prévenir | الشخص الواجب إبلاغه | Emergency contact |
| Family situation | Situation familiale | الوضعية العائلية | Family situation |
| Dependent children | Enfants à charge | الأطفال المتكفَّل بهم | Dependent children |
| Bank details | Coordonnées bancaires | المعلومات البنكية | Bank details |
| Change request | Demande de modification | طلب تعديل | Change request |
| Supporting document | Pièce justificative | وثيقة ثبوتية | Supporting document |
| Report an error | Signaler une erreur | الإبلاغ عن خطأ | Report an error |
| Marital status values | Célibataire / Marié(e) / Divorcé(e) / Veuf(ve) | أعزب·عزباء / متزوج·ة / مطلق·ة / أرمل·ة — use neutral nouns: « عزوبة / زواج / طلاق / ترمّل » as the status | Single / Married / Divorced / Widowed |

## Data (migration 0025, owned by API builder 1, written **first**)

All tenant tables: `company_id` + RLS/FORCE + standard policy, composite FKs, audit trigger (no exemptions);
personal columns registered in `audit.masked_column` (as `person_sensitive`) — **every column below except ids,
dates of the record and enums** is masked in the audit log (phones, e-mail, address, names of contacts and children,
birth dates of children, comments, request payloads). Users referenced without FK.

| Table | Columns | Rules |
|---|---|---|
| `person_contact` (pk `person_id`) | `company_id`, `mobile_phone`, `other_phone`, `personal_email`, `address_line` (≤ 200), `commune` (≤ 80), `wilaya_code` (`01`–`58`), `postal_code` (5 digits), `updated_at`, `updated_by` | all nullable; phones `^\+?[0-9 ]{8,20}$` stored normalised (`+213…` or as typed digits, builder decides and records it); e-mail ≤ 254, simple pattern |
| `person_emergency_contact` (pk `person_id`) | `company_id`, `full_name` (1–120), `relationship` (`spouse` / `parent` / `child` / `sibling` / `other`), `phone`, `updated_at`, `updated_by` | row absent = none |
| `person_family` (pk `person_id`) | `company_id`, `marital_status` (4 values) null, `marital_status_since date` null, `spouse_employed` (`yes` / `no` / `unknown`) null, `updated_at`, `updated_by` | — |
| `person_child` | `id`, `company_id`, `person_id`, `first_name` (1–80), `birth_date`, `sex` (`M`/`F`) null, `dependent bool` true, `created_at`, `updated_at` | ≤ 15 per person; birth date not in the future; DELETE allowed for the app role (a child removed by an approved change or by HR) |
| `profile_policy` (pk `company_id`) | `contact_mode` `immediate`, `emergency_mode` `immediate`, `family_mode` `approval` (`immediate` / `approval` each), `file_retention_days` 30 (7–365), `updated_at` | bank and identity note are always `approval` |
| `profile_change_request` | `id`, `company_id`, `employment_id`, `person_id`, `section` (`contact` / `emergency` / `family` / `bank` / `identity_note`), `status` (`pending` / `approved` / `rejected` / `cancelled` / `applied` — `applied` = an immediate change), `payload jsonb` (the new values of the section, shape per section below; for `identity_note` `{note}`), `before jsonb` (the section's values when submitted), `employee_comment` (≤ 500) null, `workflow_instance_id` null, `requested_by`, `requested_at`, `decided_at` null, `files_purged_at` null | partial unique: one `pending` per (`employment_id`, `section`); no DELETE for the app role |
| `profile_change_file` | `id`, `company_id`, `request_id`, `original_filename`, `mime`, `size_bytes`, `sha256`, `content bytea`, `employee_file_id` null (set when copied on approval), `created_at` | ≤ 3 per request; `content` set to an empty marker / row content nulled when purged (builder picks, records it); bytes never returned to anyone but HR candidates of the task, the requester while pending, and holders of `employee_file.read` |

`workflow_instance.subject_type` and `notification.subject_type` checks gain `profile_change_request`. Workflow
definitions per company (migration for existing companies, `bootstrap` + seed helpers for new ones):
`profile.hr` = `[{key: 'hr', kind: 'permission', permission: 'employee.personal.update', labels: {fr: 'RH', ar:
'الموارد البشرية', en: 'HR'}}]`; `profile.bank` = same with `employee.bank.update`. New system file category
`supporting_document` « Pièces justificatives » / « الوثائق الثبوتية » / « Supporting documents » (standard, keep).

**Permissions** (catalogue, labels fr/ar/en):

| Code | fr | ar | Granted to | Group |
|---|---|---|---|---|
| `employee.personal.read` | Consulter les coordonnées et la situation familiale | الاطلاع على معلومات الاتصال والوضعية العائلية | `admin_rh_central`, `rh_regional` | `employees` |
| `employee.personal.update` | Modifier les coordonnées et la situation familiale | تعديل معلومات الاتصال والوضعية العائلية | `admin_rh_central`, `rh_regional` | `employees` |
| `profile.request_self` | Demander la modification de son profil | طلب تعديل الملف الشخصي | `employe` | `self_service` (or the group the other `*_self` use) |
| `profile.configure` | Paramétrer les demandes de modification | إعداد طلبات التعديل | `admin_rh_central` | `employees` |

## Employment additions (API builder 1)

| Method + path | Guard | Request → response |
|---|---|---|
| `GET /employees/:id` (existing) | as before | detail gains `personal?: PersonalView` (omitted + `'personal'` in `_redacted` without `employee.personal.read` over the employee) and `_actions` gains `update_personal` |
| `PUT /employees/:id/contact` | `employee.personal.update` | `ContactInput` → 200 `PersonalView` |
| `PUT /employees/:id/emergency-contact` | `employee.personal.update` | `EmergencyInput \| null` → 200 |
| `PUT /employees/:id/family` | `employee.personal.update` | `FamilyInput` (incl. the full `children` list: items with `id` are updated, without `id` created, missing ones deleted) → 200 |
| `GET /employees` (existing) | as before | **no** personal data in list items |

HR writes on an ended employment → 409 `employment-ended` (as other writes). Validation → 422 with field paths
(`children.2.birthDate` …). The use cases that apply a section (`applyContact`, `applyEmergency`, `applyFamily`,
`applyBank` — bank through the existing bank use case) are exported from `employment/index.ts` for the `profile`
module; they take the actor and run in the caller's transaction.

```ts
interface PersonalView {
  contact: { mobilePhone: string | null; otherPhone: string | null; personalEmail: string | null; addressLine: string | null;
             commune: string | null; wilayaCode: string | null; postalCode: string | null; updatedAt: string | null };
  emergencyContact: { fullName: string; relationship: 'spouse' | 'parent' | 'child' | 'sibling' | 'other'; phone: string } | null;
  family: { maritalStatus: 'single' | 'married' | 'divorced' | 'widowed' | null; maritalStatusSince: string | null;
            spouseEmployed: 'yes' | 'no' | 'unknown' | null;
            children: { id: string; firstName: string; birthDate: string; sex: 'M' | 'F' | null; dependent: boolean }[] };
}
type ContactInput = Omit<PersonalView['contact'], 'updatedAt'>;
type EmergencyInput = NonNullable<PersonalView['emergencyContact']>;
type FamilyInput = Omit<PersonalView['family'], 'children'> & { children: ({ id?: string } & Omit<PersonalView['family']['children'][number], 'id'>)[] };
interface BankInput { rib: string; bankName: string }
```

## Self-service requests (module `profile`, API builder 2)

| Method + path | Guard | Request → response |
|---|---|---|
| `GET /me/profile` | `profile.request_self` | linked open employment (409 `profile-not-linked` otherwise) → `MyProfileView` |
| `POST /me/profile/requests` | `profile.request_self` | `multipart/form-data`: field `data` (JSON `{section, payload, comment?}`) + `files[]` (0–3) → 201 `ProfileRequestView`. Immediate section → applied in the same transaction, status `applied`, 201. Approval section → pending + workflow instance; a section that needs proof without a file → 422 `files` `required` (family: when the marital status or the children change; bank: always); pending exists → 409 `profile-request-pending`; payload equal to the current values → 422 `payload` `unchanged`; validation as the HR endpoints (field paths `payload.…`) |
| `GET /me/profile/requests?status=` | `profile.request_self` | own requests, newest first |
| `POST /me/profile/requests/:id/cancel` | `profile.request_self` | own pending → 200; else 409 `profile-not-cancellable`; another person's → 404 |
| `GET /me/profile/requests/:id/files/:fileId` | `profile.request_self` | own request's file while it exists (download, sandbox CSP as employee files) |
| `GET /profile/requests?status=&section=&unitId=&includeSubUnits=&q=&page=&pageSize=` | `employee.personal.read` | HR list in scope (bank requests only for `employee.bank.read` holders) |
| `GET /profile/requests/:id` | candidate of the open task, or `employee.personal.read` in scope (bank: `employee.bank.read`) | → `ProfileRequestView` + `history[]`; else 404 |
| `GET /profile/requests/:id/files/:fileId` | same as the detail | download |
| `GET /profile/settings` / `PUT /profile/settings` | `profile.configure` (company) | `ProfileSettings` |

Approve / reject through the existing `POST /tasks/:id/approve|reject` (reject needs a comment). **Approval applies
the payload in the same transaction** through the Employment use cases, as of now; if the section changed since the
request was made (current values ≠ `before`), approval still applies the request's values but the task panel shows
the difference (« modifié depuis la demande »). Files are copied into the employee file (`EmployeeFileImporter`,
category `supporting_document`, title « <Section> — demande du <date> »). `identity_note` approval = « traité »
(nothing applied). Self-approval → 409 `workflow-self-approval` (HR's own request goes to another HR). Task summary:
`{type: 'profile_change', employee, section, changedFields: string[]}` — **no values** in task lists or notifications.

```ts
type ProfileSection = 'contact' | 'emergency' | 'family' | 'bank' | 'identity_note';
interface MyProfileView { employee: { id: string; matricule: string; person: NamePair; unit: UnitRef; jobTitle: string; hireDate: string };
  identity: { birthDate: string | null; birthPlace: string | null; nationality: string; ninMasked: string | null };   // NIN: last 4 digits
  personal: PersonalView; bank: { ribMasked: string | null; bankName: string | null };                                 // "•••• •••• 1234"
  modes: Record<'contact' | 'emergency' | 'family', 'immediate' | 'approval'>;
  pending: { id: string; section: ProfileSection; requestedAt: string }[] }
interface ProfileRequestView { id: string; section: ProfileSection; status: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'applied';
  employee: { id: string; matricule: string; person: NamePair; unit: UnitRef };
  payload: unknown; before: unknown;          // bank: RIB masked except for employee.bank.read holders; the requester sees its own values
  changedFields: string[]; changedSince: boolean; comment: string | null;
  files: { id: string; filename: string; mime: string; sizeBytes: number; purged: boolean }[];
  requestedAt: string; decidedAt: string | null; workflow: WorkflowProgressView | null; rejectionComment: string | null;
  _actions: ('cancel')[] }
interface ProfileSettings { contactMode: 'immediate' | 'approval'; emergencyMode: 'immediate' | 'approval'; familyMode: 'immediate' | 'approval'; fileRetentionDays: number }
```

**Notifications** (types, in-app + e-mail per preference, neutral Arabic, no personal values in texts):
`profile.change_approved`, `profile.change_rejected` (to the requester), `profile.bank_changed` (to the employee's
linked user when a bank change is applied — e-mail **always**, whatever the preference), and the existing task
notifications for HR candidates. **Worker**: the daily cleanup purges files of rejected/cancelled requests older
than `file_retention_days` (and of approved ones once copied — the employee file holds the copy).

## Audit and History

Row triggers everywhere (personal columns masked). Events `profile.requested {section}`, `profile.applied
{section}`, `profile.cancelled`, `workflow.*` as usual. The employee History shows « Coordonnées modifiées »,
« Situation familiale modifiée » … with the actor (employee or HR) and field names, values masked.

## Web

Every screen fr/ar/en, RTL, **390 px first** (employees use phones). i18n keys: web builder 1 under `personal.*`,
web builder 2 under `profile.*`.

**Web builder 1 — HR side**
- Employee detail: new tab « Coordonnées et famille » (when `personal` is present): contact, emergency contact,
  family with the children list (age shown, dependent flag), edit forms with `update_personal`; the wilaya as a
  select of the 58 wilayas (code + name fr/ar); a « Demandes de modification » list of the employee's requests.
- Task panel in « Mes tâches » for `profile_change` tasks: the section's before → after per changed field (bank RIB
  shown in full only to `employee.bank.read`), « modifié depuis la demande » warning, the files (open in a new tab),
  approve / reject with comment.
- HR list `/employees/profile-requests` (or a tab on `/employees`, builder's choice; `employee.personal.read`): status,
  section, employee, date; filter bar.

**Web builder 2 — employee side, settings, shared**
- `core/profile` (models + API service, multipart upload with progress) — written **first**, shared with web builder 1.
- **« Mon profil »** `/me/profile` (nav for `profile.request_self`, icon): identity read-only with « Signaler une
  erreur »; cards per section with « Modifier »; each form says whether the change is immediate or goes to HR for
  approval, asks for files when needed (camera capture on phones: `accept="image/*,application/pdf"` +
  `capture` hint), shows a pending request (« En attente de validation RH », cancel) instead of the form; the bank
  card shows the masked RIB; « Mes demandes » list with statuses and rejection comments.
- Settings: `/settings/profile` tab (`profile.configure`): the three modes and the retention days.
- Notification and timeline labels for the new types/events; dashboard « Mon espace » link to « Mon profil ».

## Seed (`seed:dev`, DEMO; TEST DATA)

API builder 1: contact, emergency and family data for most demo employees (fictitious phones `+213 555 …`, addresses
in their unit's wilaya, children for some), policy defaults, the category. API builder 2: for `agent.annaba` (linked
employee) one **pending** family request (a new child, with a fake PDF), one applied contact change, one rejected bank
request; for `chef.annaba` nothing pending.

## Authorization matrix rows (expected)

| Route | Rows |
|---|---|
| `PUT /employees/:id/{contact,emergency-contact,family}` | admin ✓, est ✓ in Est (Ouest → 404), lecture 403, acces 403, agent 403 |
| `GET /employees/:id` personal block | admin and est present, lecture `_redacted` contains `personal` |
| `/me/profile*` | agent ✓ (own only), chef ✓, rh.admin 403 unless linked, lecture 403, acces 403 |
| `GET /profile/requests*` | admin ✓, est ✓ (Est only, no bank requests), lecture 403, acces 403, agent 403 |
| `GET/PUT /profile/settings` | admin ✓, est 403, others 403 |
| anonymous | 401 everywhere |

## Tests the build must add

- Domain: validation of every field (phones, e-mail, wilaya, postal code, children ≤ 15, birth dates), section diffs
  (`changedFields`, `unchanged`), the « files required » rule, masking (RIB, NIN).
- E2E: HR edits (contact, emergency, family with children add/update/delete), redaction for `lecture`; self-service:
  immediate contact change, family request with file → HR approval applies it and copies the file into the employee
  file, reject, cancel, one pending per section, changed-since, bank request approved only by central HR + the bank
  e-mail, identity note, ended employment, not linked; HR list scope; files download rights; purge job; audit
  masking (no phone/e-mail/name/RIB value in `audit.change_log` for these tables); audit exit criterion; matrix rows;
  inventory tests.
- Web: unit tests for every screen and form (HttpTestingController), fr/ar parity.

## Build ownership (to avoid conflicts)

- **API builder 1:** migration 0025 (all tables, masked columns, permissions, workflow definitions, file category,
  check constraints — written **first**; create `…\scratchpad\profile\migration-ready.txt` when it and `schema.ts`
  compile), catalogue + `SYSTEM_ROLES`, Employment additions (detail block, HR endpoints, exported apply use cases),
  seed of personal data / policy / category, matrix rows and audit coverage for its routes, inventory tests.
- **API builder 2:** module `profile` (requests, files, workflow subject and hooks, HR list/detail, settings, the
  purge in the worker's daily cleanup), notification types + mail templates, seed of requests, matrix rows and audit
  coverage for its routes. Waits for migration 0025 before DB tests.
- **Web builder 1:** HR side (above). **Web builder 2:** `core/profile` (first), « Mon profil », settings tab, nav,
  routes, notification/timeline labels, dashboard link.
- Shared files (`catalogue.ts`, `app.module.ts`, `employment/index.ts`, `authorization-matrix.e2e-spec.ts`,
  `audit.e2e-spec.ts`, `seed-dev.ts`, `notifier.ts`, `mail-templates.ts`, `tasks.page.*`, `app.routes.ts`, `app.ts`,
  `fr/ar/en.json`, `employee-detail.page.*`): **re-read just before each edit, small targeted edits, never rewrite
  the whole file**, keep your keys in your own section.

## Out of scope (later)

Identity changes by the employee (names, NIN); several emergency contacts; a spouse's details; documents expiring
(identity card) from the profile; changes typed by unit heads; mobile push notifications.

## Settled by the build (API)

- **Phones** are stored without spaces: `00…` → `+…`, an Algerian national number (`0` + 9 digits) → `+213` + the 9
  digits, anything else as typed digits (with its `+`); stored form `^\+?[0-9]{8,20}$`. Personal e-mails are stored
  lower case; a one-digit wilaya (`9`) is stored `09`. Blank optional fields become `null`.
- **Validation codes** (422 `errors[].code`): `invalid_phone`, `invalid_email`, `invalid_wilaya`,
  `invalid_postal_code`, `too_big` (lengths), and for the family `status_required` (a date without a status),
  `future_date` (child birth date or status date after today), `too_many` (on `children`, > 15), `not_found`
  (`children.N.id` not one of the person's children, or repeated).
- `PUT …/emergency-contact` takes the JSON body `null` to remove the contact (that route's JSON parser is non-strict);
  removing an absent contact is a no-op. Clearing the contact keeps its row with nulls (no DELETE for the app role).
- A PUT whose values equal the stored ones writes nothing (no audit row, `updatedAt` kept). The children of a family
  PUT are diffed: unchanged children are not touched, missing ones deleted first, then updates, then inserts.
  Children are listed by birth date.
- `GET /employees/:id`: `personal` and `update_personal` follow `employee.personal.read` / `.update` over the
  employee's scope unit; `'personal'` is appended last to `_redacted`, `update_personal` last to `_actions` (none on an
  ended employment). HR writes: unreadable → 404, readable without `employee.personal.update` → 403
  `forbidden-scope`, ended → 409 `employment-ended`.
- The four permissions are in group `employee` (sort 350–380, not sensitive, no two-step sign-in change);
  `admin_rh_central` also holds `profile.request_self` (it holds every non-medical code; unlinked → the profile
  module's 409).
- Migration 0025: `profile_change_file.content` **null = purged** (metadata kept); guards keep requests and files
  immutable (decision once from `pending`, `workflow_instance_id` and `files_purged_at` set once, file `content` may
  only become null, `employee_file_id` set once), ≤ 3 files per request and ≤ 15 children per person as triggers;
  `decided_at` is set exactly when the status is not `pending` (an `applied` request has it). hrforce_worker gets
  `update (content)` on the files and `update (files_purged_at)` on the requests. Also masked: `person_family.marital_status_since`,
  file names and bytes; enums (`relationship`, `marital_status`, `spouse_employed`, child `sex`, `dependent`) stay
  readable in the log.
- The employee History includes the person's contact, emergency, family and children rows (values masked).
- Seed: every seventh demo employee has no personal data; children only for some married employees (domain
  `exemple.test`, phones `+213 555 …`, TEST DATA).

**Module `profile` (API builder 2)**
- **Open employment** for self-service = no end date (the rehire / `assertOpen` rule): an employment with an end date,
  even a future one, answers 409 `profile-not-linked` on every `/me/profile*` route.
- **Upload**: multipart field `data` (JSON) + 0–3 parts named `files` (each ≤ EMPLOYEE_FILE_MAX_BYTES). Errors 422:
  `data` `invalid_json` / `required`, `section` `invalid_value`, `payload.…` (the HR schemas; family rules too),
  `payload` `unchanged`, `files` `too_large` / `too_many` / `invalid_multipart` / `required` / `not_accepted` (files on
  an immediate section), `files.N` `empty` / `unsupported_type` (sniffed). Emergency `payload: null` removes the
  contact. `identity_note` payload `{note}` 1–500 characters (`changedFields` = `['note']`, `before` = null).
  Caddy allows 65 MB on `POST /api/me/profile/requests`; the download routes get the sandbox CSP there too.
- One pending request per section is checked for **every** section (also an immediate one: 409
  `profile-request-pending` when one is still waiting after a policy change).
- `changedFields` per section: contact / emergency field names (adding or removing the emergency contact lists all
  three), family `maritalStatus` / `maritalStatusSince` / `spouseEmployed` / `children`, bank `rib` / `bankName`.
  Files are required for family when `maritalStatus`, `maritalStatusSince` or `children` change. `changedSince` is
  computed for pending requests only (decided ones: false).
- **Approval** applies the stored payload through the Employment use cases with the approver as actor; a child id of
  the request that HR removed meanwhile is applied as a new child. Every file still holding bytes is copied (all
  sections, identity notes included) with `EmployeeFileImporter.copyEach(…, 'supporting_document')`, title
  « <Section> — demande du JJ/MM/AAAA »; a file already live in the employee file is linked, not duplicated.
- **Notifications**: an approved bank request sends `profile.bank_changed` only (not `change_approved`); its e-mail
  ignores the preference (`EMAIL_ALWAYS_TYPES`), the preferences list shows it `email: true` and refuses `false`
  (422 `email_always`). Data: `requestId`, `employmentId`, names, `section`, `actorName`. Link
  `/me/profile?request=<id>`. Task summary: `{type: 'profile_change', employee, section, changedFields, changedSince,
  files (count), requestedAt}` (the engine sets `subject.type` to `profile_change_request`).
- **Reading**: HR detail / file routes are `@Authenticated` (a task candidate may lack `employee.personal.read`); no
  reader → 404. Bank requests: listed / readable only inside `employee.bank.read` scope; elsewhere (task candidates
  without bank.read) the RIB is masked. HR downloads: task candidates, or readers holding `employee_file.read` over the
  employee. The requester downloads its files **while the request is pending** only. HR list extra filter
  `employmentId` (the employee's requests); `pageSize` ≤ 200, default 50.
- `/profile/settings` needs `profile.configure` over the whole company (else 403 `forbidden-scope`).
- **Purge**: worker task `profile.files_purge`, daily 03:45 UTC: bytes of rejected / cancelled requests decided ≥
  `file_retention_days` ago, and of approved ones once every file is linked to the employee file (else after the
  retention too) → `content = null`, `files_purged_at` set, one `profile.files_purged {requests, files}` event per company.
- **Audit events**: `profile.requested {section, employmentId, fields, files}`, `profile.applied {section,
  employmentId, via: immediate|approval, fields, files?}`, `profile.cancelled`, `profile.file_downloaded {fileId, via}`
  (subject `profile_change_request`, shown on the employee History); no values.
- Seed (agent.annaba, EMP-0030): pending family request (child « Nour », `livret-de-famille.pdf`), applied contact
  change, rejected bank request (with a file and a rejection comment by rh.admin).

## Settled by the build (web)

- HR side (web builder 1): tab « Coordonnées et famille » (`?tab=personal`, right after « Identité ») shown when the
  detail carries `personal`; edit buttons need `update_personal` and an employment not ended. Three forms (contact,
  emergency contact, family with all children in one `FormArray`, ≤ 15, birth date ≤ today); 422 field paths such as
  `children.2.birthDate` land on the child row. Clearing the emergency contact (or saving the three fields empty)
  sends `PUT …/emergency-contact` with body `null`.
- The tab's « Demandes de modification » reads `GET /profile/requests?employmentId=<id>&pageSize=100` (all statuses:
  no `status` sent) — `employmentId` is the API's extra filter, not in the table above.
- HR list at **`/employees/profile-requests`** (`canMatch employee.personal.read`, else the 404 page; link « Demandes
  de modification » in the employees list header). Pending by default; « all statuses » is `status=all` in the URL
  (sent without `status`). The bank section is offered in the filter only to `employee.bank.read` holders. Each row
  expands to the before → after; rows become cards below 640 px.
- « Mes tâches »: the subject type is **`profile_change_request`** (the workflow engine sets `subject.type` to the
  subject type, so the summary's `profile_change` never reaches the web). Rows show the section and changed field
  names only. Approval errors `employment-ended` and 422 are explained as « cannot be applied ».
- Before → after (`shared/profile/profile-request-diff`): children matched by `id` (added / removed / changed / same);
  a RIB containing non-digits is treated as masked and says so; files open in a new tab as plain links
  (`/api/profile/requests/:id/files/:fileId`, or `/api/me/profile/…` for the requester); purged files are named only.
- Employee side (web builder 2): « Mon profil » at **`/me/profile`** (`canMatch profile.request_self`; nav entry and a
  « Mon espace » link only while `/me/employment` answers, as the other self-service pages). A 409 `profile-not-linked`
  (or 404) on `GET /me/profile` shows an explanation, no cards. One form open at a time, inline in its card; each
  form names its mode (immediate / HR approval / central HR for the RIB / identity note). Approval sections offer a
  comment (≤ 500) and the files; immediate ones send neither.
- Multipart: field **`data`** (the JSON `{section, payload, comment?}`) first, then one **`files`** part per file
  (the API's `FilesInterceptor('files', 3)`). Files: « Prendre une photo » (`accept="image/*" capture="environment"`),
  « Choisir un fichier » (`accept="image/*,application/pdf"`, multiple) and a drop zone; extra files beyond 3 are left
  out with a message; type/size/empty are checked as for the employee file (the API decides).
- Courtesy checks before sending: a family change asks for a file when the status, its date or the children change
  (the API rule, plus the date); a bank change always; « nothing changed » is said without a request. The RIB is sent
  without spaces. `payload` `unchanged` → the form's message; `files…` errors (and a proxy 413) → the files field;
  `payload.…` paths → the field.
- « Ne plus avoir de personne à prévenir » sends `payload: null` (section `emergency`). HR's
  `ProfileApi.updateEmergencyContact(id, null)` writes the JSON text `null` with `Content-Type: application/json`
  (Angular's HttpClient drops a `null` body).
- « Mes demandes »: statuses, changed field names, decision date, rejection comment, own files downloadable while not
  purged, stepper while pending, cancel (confirm dialog; a 409/404 says « already handled » and reloads).
  `?request=<id>` highlights and focuses a request (for notification links); `profile.*` notifications reload the page.
- `/settings/profile` tab « Demandes de modification » (`profile.configure`): three radio pairs and the retention
  (whole number 7–365, checked before sending).
- Notifications: `profile.change_approved`, `profile.change_rejected`, `profile.bank_changed` (no values in the
  texts); a `task.assigned` whose `subjectType` is `profile_change_request` reads « Demande de modification du profil
  à traiter : <name> ». Timeline: `profile.requested|applied|cancelled` are worded per `section`
  (`audit.events.profile.applied.contact` « Coordonnées modifiées » …); link columns of the new tables are hidden;
  enums named with the `profile.*` labels.

## Settled by the verification (gate and security, 2026-10-24)

Probes in `apps/api/test/profile-security.e2e-spec.ts` (20 tests; an Ouest employee is linked to a test user there).
- **Own bank request**: the requester's views (`POST` / `GET /me/profile/requests`) show the RIB it typed in `payload`
  but `before` **masked** (`•••• •••• 1234`), as « Mon profil » — the full RIB on record was returned there before.
  Central HR (`employee.bank.read`) still sees both in full.
- **hrforce_worker** reads only `id`, `company_id`, `request_id`, `employee_file_id` of `profile_change_file`
  (migration 0025: table SELECT revoked, column SELECT granted) and nulls `content` without reading it; the purge no
  longer filters on `content`.
- Checked and kept: other people's request / file ids → 404 on `/me/*` and HR routes; `employmentId` / `personId` in
  `data` or `payload` are dropped (the caller's own employment is used); every `/me/profile*` route → 409
  `profile-not-linked` for an ended or future-ended employment; an approval on an ended employment → 409
  `employment-ended`, nothing applied; regional HR gets no bank request through any filter, detail, file, task or
  notification, and no access to the History (403); `lecture` gets `personal` redacted; a failing file copy rolls the
  applied values back (one transaction); two simultaneous approvals → 200 + 409, applied once; six simultaneous
  requests for one section → one 201; sniffing refuses a renamed `.exe`, HTML, SVG and empty files; a part outside
  `files` → 422; file names lose path parts and bidi overrides (a control character makes the multipart body unreadable:
  422 `invalid_multipart`, nothing stored); downloads: `attachment`, `nosniff`, `sandbox` CSP, `no-store`, an HTML name
  saved as `.pdf`; XSRF → 403 on every write, anonymous → 401; 16 children, a wrong section, non-object `data` /
  `payload`, over-long note / comment, a 250 KB `data` field → 422; a `__proto__` / `constructor` key is neither applied
  nor stored. The emergency route's non-strict parser takes an object or `null` only (string, number, boolean, array
  → 422), keeps the 100 KB limit (413) and applies to that path only (other routes still refuse a top-level `null`).
  No phone, e-mail, address, contact or child name, RIB, comment or file name in notifications, their e-mails, workflow
  tasks, `audit.change_log` (these tables, `person_sensitive`, workflow, notifications) or `audit.event`.
- Caddy's 65 MB on `POST /api/me/profile/requests` fits 3 files at the 20 MB hard cap plus the `data` field (≤ 200 KB)
  and the multipart framing.
- Left as is: the copy's original file name is in clear in the `employee_file` audit rows (as every employee-file
  upload); a 3-file upload is held in memory (≤ 60 MB per request, as multer does for employee files).

## Settled by the verification (functional, 2026-10-25)

Driven in Chromium (fr and ar, 390 px first, then 1280 px) on the dev stack with `seed:dev`, rechecked after the gate
verifier's 0025 change on a fresh `hrforce` database: « Mon profil » for `agent.annaba` (identity read-only, NIN and
RIB masked, « Signaler une erreur » → « Signalement d’erreur traité »), contact change applied at once and visible on
the HR tab, emergency contact removed and added, field errors under their field (e-mail, postal code, phone), family
request with a child added (camera input `image/*` + `capture`, file picker PDF, progress bar, « files required »),
pending state, cancel dialog; bank request needs a file, then the own view shows `before` masked; « Mes demandes »
with the seeded rejected request and its comment. HR: the tab for `rh.admin` and `rh.est` (`lecture.ouest`: no tab,
`personal` redacted, 403 on `/profile/requests`, list page → 404), the 58-wilaya select, children add / edit / remove
with a future birth date refused on its row; « Mes tâches » for `rh.est`: before → after, files open (sandbox CSP),
« modifié depuis la demande » after editing the family meanwhile, approve → values applied and the file in the
employee file under « Pièces justificatives », e-mail to the employee; reject with comment → e-mail; the bank request
only for `rh.admin`, « coordonnées bancaires modifiées » e-mail; the HR list (bank section offered to `rh.admin` only,
`?status=all`, rows expanded); `/settings/profile` (retention 3 refused; contact switched to approval → the employee's
form says « envoyée aux RH » and creates a pending request, no file asked); History with masked values; `chef.annaba`
nothing pending. No horizontal overflow at 390 px on any of these screens.

- **Seeded family request**: its `before` / `payload` dates were a day early (`toISOString()` of a local-midnight
  `date` east of UTC); `profile-seed.ts` now uses `toIsoDate`.
- **Own decided requests** offered « Télécharger » for files the API refuses (requester downloads only while pending
  → 404); the button is shown only for pending requests (spec updated).
- **Before → after at phone width**: the « Après » column was scrolled out of view in the task panel; below 520 px of
  panel width each field is one block with « Avant : » / « Après : » (container query). A child's line is now isolated
  part by part (`<bdi>`): a Latin first name next to an Arabic date reordered the date's digits.
- **Keyboard**: opening a form (employee and HR) moved the focus to `<body>`; it now goes to the form's first field, and
  back to « Modifier » on cancel / save (HR tab).
- **Wording**: field lists use « ، » in Arabic; the settings mode reads « Validation par les RH » (contact / emergency
  under approval ask no file); History labels for `profile.file_downloaded` and `profile.files_purged` (were raw keys);
  the security e-mail `profile.bank_changed` no longer points to the e-mail preferences it ignores (own footer).
- Left as is: the task panel's « modifié depuis la demande » warns but does not show the current values; an Algerian
  landline typed `038 86 12 34` is stored `038861234` while mobiles become `+213…`; the History shows the step key
  « hr » (known issue); the supporting-document title « demande du JJ/MM/AAAA » uses the UTC date (a request between
  00:00 and 01:00 Algiers time is titled the day before); the task e-mail mentions « pièces justificatives » for a
  contact request without files; notification e-mails took ~2 min each to reach Mailpit on this Windows host
  (SMTP connection, all types, not this slice).
