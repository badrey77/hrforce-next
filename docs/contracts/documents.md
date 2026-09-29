# Contract — Documents: generated HR documents, numbering, register, employee file (M3, step 1)

Binding contract between `apps/api` (new module `documents`, platform port `pdf`, small additions to Leave, Workflow,
Notifications, Audit) and `apps/web` (Documents register, issuing, settings, My documents, employee Documents and File
tabs). Owner decision (2026-09-28): M3 starts with documents and numbering, **generated documents first**.
Engine, fonts, template and storage decisions: **ADR 008** (Proposed) — Typst via
`@myriaddreamin/typst-ts-node-compiler`, PDF/A-2b, stored PDF bytes + snapshot, gap-free counters in Postgres.

Two phases, one contract. **Phase A** (build now): letterhead and signatories, document types and numbering, issuing
and the register, void, self-service attestation requests through the workflow engine. **Phase B** (after A is
verified): the employee file (uploaded attachments). Phase B does not change anything Phase A defines.

## ⚠ Assumptions to confirm with the owner

| # | Assumption | Default in this contract | Where it lives |
|---|---|---|---|
| 1 | Document types of Phase A | `attestation_travail` (active employment), `certificat_travail` (ended employment, at or after the end date), `titre_conge` (approved leave request). Attestation de salaire, ATS (CNAS) and others later | `document_type` (codes fixed in code) |
| 2 | Languages | **fr** and **ar** for every type; no English documents | `document_type.languages` |
| 3 | Number format and reset | `ATT-{YYYY}-{SEQ:5}`, `CT-{YYYY}-{SEQ:5}`, `TC-{YYYY}-{SEQ:5}` (e.g. `ATT-2026-00042`); one counter per company × type × **calendar year of the issue date** (server local date, TZ `Africa/Algiers`) | `document_type.number_format`, `document_sequence` |
| 4 | Wording | Fixed legal wording per type and language, in code (below). The attestation **does not print the salary**; the certificat **does not print the end reason** | templates (ADR 008) |
| 5 | Who issues **(confirmed 2026-09-28)** | `admin_rh_central` and `rh_regional` issue within their scope; **only `admin_rh_central` voids**; `lecture` and `admin_acces` see no documents | seed (Permissions) |
| 6 | Self-service **(confirmed 2026-09-28)** | Employees (role `employe`) may **request an attestation de travail** for themselves; one HR approval step (`document.issue` over the employee) — approving issues the document with the default signatory; the employee downloads it from *My documents*. Certificat and titre de congé are HR-only | `document_type.self_service`, workflow `document.hr_only` |
| 7 | Signature **(confirmed 2026-09-28)** | No scanned signature or stamp image in the PDF: the printed document is signed and stamped by hand. The signatory's name and title are printed | `document_signatory` |
| 8 | Signatory choice | Company-wide signatories, or signatories attached to a unit (they sign for employees of that unit and its sub-units); default = the type's default signatory, else the nearest signatory up the employee's unit tree | `document_signatory.org_unit_id` |
| 9 | Titre de congé after cancellation | Cancelling an approved leave does **not** void its titre automatically; the register flags it (`warnings: ['leave-cancelled']`) and HR voids it | view rule |
| 10 | Reprint | A reprint is the **same file** (same bytes, no "DUPLICATA" stamp, no new number); every download is audited | storage (ADR 008) |
| 11 | Job title in Arabic documents | Printed as recorded (Latin); `assignment.job_title` has no Arabic variant yet | snapshot rule |
| 12 | Employee file — accepted formats | **PDF, JPEG, PNG** only (checked by content, not by name), **10 MB** per file; no Office files, no HEIC | env + code |
| 13 | Employee file — antivirus | **No antivirus scanning** in Phase B (offline sites cannot update signatures; ClamAV would be a new service against ADR 005). Mitigations below; a `scan_status` column is reserved | Phase B |
| 14 | Employee file — medical | Category `medical` needs `employee.medical.read` to see and `employee.medical.update` (new) to add; **no system role holds either** (as today): the medical category stays unused until the owner creates a role (e.g. "Médecine du travail") | seed |
| 15 | Employee file — retention | No automatic deletion by default (`retention_years_after_end` = null for every category) until the owner gives durations; the purge job exists and is tested | `employee_file_category` |
| 16 | Employee file — self-service | Employees do **not** see their own file in Phase B | — |

## Phase A — generated documents, numbering, register

### Data (migration 0014)

All tenant tables: `company_id` + RLS/FORCE + the standard policy, composite `(company_id, …)` FKs, the audit trigger
unless listed as exempt (with the reason in `tools/guardrails/audit-exempt.json`). Users referenced without FK (like
`role_grant.user_id`).

| Table | Columns | Rules |
|---|---|---|
| `company_profile` (tenant, pk `company_id`, audited with `audit.capture('company_id')`) | `legal_name_fr`, `legal_name_ar` null, `address_fr`, `address_ar` null, `city_fr` ("Fait à"), `city_ar` null, `phone` null, `email` null, `nif` null, `nis` null, `rc` null, `ai` null (article d'imposition), `footer_fr` null, `footer_ar` null (≤ 300, printed at the page bottom), `logo bytea` null, `logo_mime` null (`image/png`/`image/jpeg`), `logo_sha256 bytea` null, `updated_at` | text fields trimmed, 1–200 (address 1–300); identifiers `^[0-9A-Z /-]{1,30}$`; logo ≤ **256 KB**, type sniffed from the bytes; `audit.masked_column('company_profile','logo')` (the diff shows `***`) |
| `document_signatory` | `id`, `company_id`, `org_unit_id` null (null = company-wide), `name_fr`, `name_ar`, `title_fr`, `title_ar` (all required, 1–120), `active bool default true`, `created_at` | never deleted (deactivate) |
| `document_type` | `id`, `company_id`, `code` (`attestation_travail` / `certificat_travail` / `titre_conge`, check), `name_fr/ar/en`, `number_format`, `languages text[]` (subset of `{fr,ar}`, non-empty), `self_service bool`, `default_signatory_id` null, `active bool`, `sort_order` | unique (`company_id`,`code`); unique (`company_id`,`number_format`); no delete |
| `document_sequence` (**audit-exempt**: a counter derived from the register — every value is also an `issued_document` row) | `company_id`, `document_type_id`, `year int`, `last_value int` (≥ 1) | pk (`company_id`,`document_type_id`,`year`); no delete, no direct update by anything but the issue use case |
| `issued_document` | `id`, `company_id`, `document_type_id`, `type_code`, `year`, `seq`, `number` (text), `language` (`fr`/`ar`), `employment_id`, `leave_request_id` null, `document_request_id` null, `org_unit_id` (the employee's unit at issue, informative), `signatory_id`, `snapshot jsonb`, `template_version` (e.g. `attestation_travail@1`), `renderer` (e.g. `typst 0.14.2 / typst-ts 0.7.0`), `content_sha256 bytea` (32 bytes), `size_bytes int`, `issue_date date`, `issued_by` uuid, `issued_at timestamptz`, `client_request_id uuid` null, `status` (`issued`/`void`), `voided_by` null, `voided_at` null, `void_reason` null | unique (`company_id`,`number`); unique (`company_id`,`document_type_id`,`year`,`seq`); unique (`company_id`,`client_request_id`) where not null; `titre_conge` ⇔ `leave_request_id` not null; void columns all null ⇔ `status = 'issued'`; `void_reason` 3–500; **immutable except the transition `issued → void`** (BEFORE UPDATE trigger); no DELETE for `hrforce_app` |
| `issued_document_file` (**audit-exempt**: immutable PDF bytes; integrity via the audited `content_sha256`) | `document_id` pk, `company_id`, `pdf bytea` | insert-only for `hrforce_app` (no UPDATE, no DELETE) |
| `document_request` (self-service) | `id`, `company_id`, `employment_id`, `document_type_id`, `language`, `purpose` null (≤ 200, printed nowhere, shown to HR), `status` (`pending`/`approved`/`rejected`/`cancelled`), `requested_by`, `requested_at`, `workflow_instance_id`, `issued_document_id` null | at most one `pending` per (`employment_id`,`document_type_id`) (partial unique index); no delete |

Also: `workflow_instance.subject_type` check becomes `in ('leave_request', 'document_request')`.
Seeded per company (migration for existing companies, `bootstrap` and `SYSTEM_*` helpers for new ones): the three
types (active, fr+ar, default formats, `self_service` true only for `attestation_travail`) and the workflow
definition `document.hr_only` = `[{key: 'hr', kind: 'permission', permission: 'document.issue', labels: {fr: 'RH',
ar: 'الموارد البشرية', en: 'HR'}}]`. No profile row is created: issuing needs one (`document-profile-incomplete`).

### Numbering

- `number_format`: literal characters `[A-Z0-9/_.-]` and tokens `{YYYY}`, `{YY}`, `{SEQ}` or `{SEQ:n}` (n = 1–9,
  zero-padded to at least n digits; larger numbers simply grow). Exactly one `{SEQ…}`, at least one year token, ≤ 40
  characters once rendered. Invalid → 422 `errors[{field: 'numberFormat', code: 'invalid_format'}]`; the same format
  as another type of the company → 409 `document-format-taken`.
- **Allocation** (ADR 008 §6), inside the request transaction, after every check and after building the snapshot:
  `set local lock_timeout = '5s'`; `insert into document_sequence … values (…, year, 1) on conflict (company_id,
  document_type_id, year) do update set last_value = document_sequence.last_value + 1 returning last_value`; format
  the number; render; insert `issued_document` + `issued_document_file`; audit event. Lock timeout → **503**
  `document-busy` (retryable). Render error or timeout (15 s) → **503** `document-render-failed`. Either way the
  transaction rolls back **with the counter**: no gap, no register row, no file.
- A format change applies to the next number; the counter of the year continues. Numbers are never reused (void keeps
  them).
- **Required tests** (API): 20 concurrent issues of one type with random injected render failures → the issued
  numbers are exactly `1..k` with k = successes and `last_value = k`; year rollover (31 Dec / 1 Jan with a pinned
  clock) restarts at 1; a unique-violation on `number` (format collision) rolls back and answers 409
  `document-number-taken`.

### Issuing rules

| Type | Subject | Preconditions (409 slug, `errors[].field` when relevant) |
|---|---|---|
| `attestation_travail` | `employmentId` | employment has no `end_date` or `end_date ≥ issue date` — else `document-employment-ended` |
| `certificat_travail` | `employmentId` | `end_date` recorded and `end_date ≤ issue date` — else `document-employment-not-ended` |
| `titre_conge` | `leaveRequestId` | request `status = approved` — else `document-leave-not-approved`; its employee gives the scope |

Common: the type is active (`document-type-inactive`), the language is in `languages` (422 on `language`), the
profile has every field printed in that language — `legal_name_*`, `address_*`, `city_*` (`document-profile-incomplete`,
`errors[]` lists the missing fields, e.g. `legalNameAr`), the signatory is active and covers the employee's unit
(company-wide, or its unit is an ancestor-or-self of the employee's current unit) — else 422 on `signatoryId`
(`invalid_signatory`); no signatory given and none found → 409 `document-no-signatory`.
`clientRequestId` (optional uuid, sent by the web per form submission): a repeat with the same id returns **200** with
the already issued document (no new number); the same id with a different body → 409 `document-client-request-reused`.

**Snapshot = template input.** Built by pure domain functions (unit-tested, fr and ar), all values already formatted:

```ts
interface DocumentSnapshot {
  v: 1; type: 'attestation_travail' | 'certificat_travail' | 'titre_conge'; lang: 'fr' | 'ar';
  number: string;                  // set just before rendering
  issueDate: string;               // ISO, also the PDF document date
  issueDateText: string;           // "28 septembre 2026" / "28 سبتمبر 2026" (Algerian months: جانفي فيفري مارس أفريل ماي جوان جويلية أوت سبتمبر أكتوبر نوفمبر ديسمبر)
  company: { legalName: string; address: string; city: string; phone: string | null; email: string | null;
             ids: { label: string; value: string }[]; footer: string | null; hasLogo: boolean };
  employee: { civility: string;    // fr: "M." / "Mme" / "M./Mme" (sex null); ar: "السيد" / "السيدة" / "السيد(ة)"
              fullName: string;    // ar: Arabic names when present (each part falls back to Latin); fr: Latin
              matricule: string; birthDateText: string | null; birthPlace: string | null;
              jobTitle: string; unitName: string; hireDateText: string; endDateText: string | null;
              positions?: { jobTitle: string; fromText: string; toText: string }[] };   // certificat: consecutive distinct job titles
  leave?: { typeLabel: string; startText: string; endText: string; days: string;        // "30" / "2,5" (fr) / "2.5" (ar)
            halfDayStart: boolean; halfDayEnd: boolean; resumptionText: string };
  signatory: { name: string; title: string };
  ref: { employmentId: string; leaveRequestId?: string; signatoryId: string };           // ids, not printed
}
```

Digits are Western (0–9) in both languages. `resumptionText` = the first date after `endDate` that is neither a
weekend day (leave policy) nor a public holiday (`leave-dates` rules; the Leave module exports this computation from
`modules/leave/index.ts`); a half day at the end prints "le <endDate> après-midi" / "<endDate> بعد الظهر".

**Wording (templates v1, fr / ar)** — layout: letterhead block (logo, legal name, address, identifiers) at the start
side, number at the end side, title centered, body justified, "Fait à <city>, le <date>" / "حرر في <city> بتاريخ
<date>" and the signatory at the end side, footer at the bottom. Civility and gender agreement from `sex` ("né/née",
"employé/employée"; ar "المولود/المولودة").
- Attestation: « Nous soussignés, <company>, attestons que <civ> <name>, né(e) le <birth> à <place>, matricule
  <matricule>, est employé(e) au sein de notre organisme depuis le <hire> en qualité de <job> (<unit>). La présente
  attestation est délivrée à l'intéressé(e), sur sa demande, pour servir et valoir ce que de droit. » /
  « تشهد <company> بأن <civ> <name>، المولود(ة) في <birth> بـ <place>، رقم التسجيل <matricule>، يعمل لدى مؤسستنا منذ
  <hire> بصفة <job> (<unit>). سلمت هذه الشهادة للمعني(ة) بطلب منه لاستعمالها في حدود ما يسمح به القانون. »
  (birth clause omitted when the birth date is unknown.)
- Certificat: « … certifions que <civ> <name> … a été employé(e) au sein de notre organisme du <hire> au <end> en
  qualité de : <positions> . <civ> <name> est libre de tout engagement envers notre organisme. Le présent certificat
  est délivré pour servir et valoir ce que de droit. » / « نشهد بأن … عمل لدى مؤسستنا من <hire> إلى <end> بصفة:
  <positions>. وهو حر من كل التزام تجاه مؤسستنا. سلمت هذه الشهادة لاستعمالها في حدود ما يسمح به القانون. »
- Titre de congé: title « Titre de congé » / « سند عطلة »; a two-column table: employee, matricule, unit, job, leave
  type, from, to, days, resumption; a sentence « <civ> <name> est autorisé(e) à bénéficier de … » / « يرخص لـ … ».
The builder may polish the wording within these facts; the verifier checks both languages in the browser PDF viewer.

### Permissions (catalogue additions, group `documents`, sort 610–660; labels fr/ar/en)

| Code | fr | ar | Granted to (system roles, migration + `SYSTEM_ROLES`) |
|---|---|---|---|
| `document.read` | Consulter le registre des documents | الاطلاع على سجل الوثائق | `admin_rh_central`, `rh_regional` |
| `document.issue` | Émettre des documents | إصدار الوثائق | `admin_rh_central`, `rh_regional` |
| `document.void` | Annuler un document émis | إلغاء وثيقة صادرة | `admin_rh_central` |
| `document.configure` | Paramétrer les documents (en-tête, signataires, numérotation) | إعداد الوثائق (الترويسة، الموقعون، الترقيم) | `admin_rh_central` |
| `document.request_self` | Demander ses attestations | طلب شهاداته | `employe` and `admin_rh_central` (as `leave.request_self`) |

`permission_group_ck` gains `documents`. `security_policy.mfa_required_permissions` defaults are unchanged (no
document permission is `sensitive`). The catalogue unit test (`PERMISSION_CODES`) is updated.

### Scope

- An issued document, a document request and every issuing check use the **employee's scope** (employment rule:
  assignment unit as of today; ended employment → its last assignment's unit), evaluated at read time — HR of the
  employee's current region sees the employee's whole document history.
- Out of scope / unknown / other company → **404**. In `document.read` scope but not in the scope of the permission
  the action needs (`document.issue`, `document.void`) → **403** `forbidden-scope`.
- `document.configure` writes need the permission over the **whole company** (the root unit), else 403
  `forbidden-scope` (as `PUT /access/security-policy`). Reads need it anywhere.
- Self-service: `/me/documents*` works only on the caller's linked employment (`document-not-linked` 409 otherwise);
  another person's id → 404.

### Endpoints (under `/api`, problem+json)

| Method + path | Guard | Request → response |
|---|---|---|
| `GET /documents/types` | `@Authenticated` | `{items: DocumentTypeView[]}` (reference data; `numberFormat`, `nextNumber` and `defaultSignatoryId` only when the caller holds `document.issue` or `document.configure` anywhere, else null) |
| `PUT /documents/types/:id` | `document.configure` (company) | `{numberFormat?, languages?, selfService?, defaultSignatoryId?: string \| null, active?}` → 200 `DocumentTypeView`; `selfService` only for `attestation_travail` (422 elsewhere) |
| `GET /documents/settings/profile` | `document.configure` | `CompanyProfileView` (404-free: all nulls when no row) |
| `PUT /documents/settings/profile` | `document.configure` (company) | profile fields (camelCase, no logo) → 200 |
| `PUT /documents/settings/profile/logo` | `document.configure` (company) | `multipart/form-data` field `file` (PNG/JPEG ≤ 256 KB, sniffed) → 200 profile; 422 `errors[{field:'file', code:'unsupported_type' \| 'too_large'}]` |
| `DELETE /documents/settings/profile/logo` | `document.configure` (company) | 204 |
| `GET /documents/settings/profile/logo` | `document.configure` | the image (`Cache-Control: no-store`), 404 when none |
| `GET /documents/settings/signatories` | `document.configure` | `{items: SignatoryView[]}` incl. inactive |
| `POST /documents/settings/signatories` | `document.configure` (company) | `{orgUnitId: string \| null, names:{fr,ar}, titles:{fr,ar}}` → 201 |
| `PATCH /documents/settings/signatories/:id` | `document.configure` (company) | `{orgUnitId?, names?, titles?, active?}` → 200 |
| `GET /documents/signatories?employmentId=` | `document.issue` | active signatories covering that employee (all active ones without the param), nearest first, `default: boolean` per type in `defaultFor: string[]` |
| `POST /documents/preview` | `document.issue` | `IssueBody` → **200 `application/pdf`**: same rendering with the number replaced by `<prefix>-…` and a diagonal "SPÉCIMEN" / "نموذج" watermark; no counter, no row, no audit; same 409/422 as issuing |
| `POST /documents` | `document.issue` | `IssueBody` → **201** `IssuedDocumentView` + `Location: /api/documents/:id` (200 on a `clientRequestId` replay) |
| `GET /documents?typeCode=&status=&employmentId=&leaveRequestId=&unitId=&includeSubUnits=&from=&to=&q=&page=&pageSize=` | `document.read` | register, scoped, newest first; `q` = number or employee name/matricule (as the employee list), `from`/`to` on `issue_date`; `pageSize` ≤ 100 → `{items: IssuedDocumentView[], total, page, pageSize}` |
| `GET /documents/:id` | `document.read` | `IssuedDocumentView` + `snapshot` (the printed values) |
| `GET /documents/:id/pdf?disposition=attachment\|inline` | `document.read` | the stored bytes (default `attachment`); audit event `document.downloaded` |
| `POST /documents/:id/void` | `document.void` | `{reason}` (3–500, 422 otherwise) → 200 view; already void → 409 `document-already-void` |
| `GET /me/documents` | `document.request_self` | `{documents: IssuedDocumentView[] (own, status issued), requests: DocumentRequestView[]}` |
| `POST /me/documents/requests` | `document.request_self` | `{typeCode, language, purpose?}` → 201 `DocumentRequestView`; 409 `document-not-linked`, `document-type-not-self-service`, `document-request-pending`, `document-employment-ended`, `document-type-inactive` |
| `POST /me/documents/requests/:id/cancel` | `document.request_self` | pending only (409 `document-request-not-cancellable`) → 200 |
| `GET /me/documents/:id/pdf?disposition=` | `document.request_self` | own **issued** (not void) document, else 404; audit `document.downloaded` `{via: 'self'}` |

`IssueBody = {typeCode, employmentId?, leaveRequestId?, language: 'fr' | 'ar', signatoryId?, clientRequestId?}` —
`employmentId` for attestation/certificat, `leaveRequestId` for titre (the other one → 422). Unknown/out-of-scope
employee or request → 404.

PDF responses: `Content-Type: application/pdf`, `Content-Disposition: <disposition>; filename="<number>.pdf"`,
`Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`, `ETag: "<sha256 hex>"`,
`X-Document-Status: issued | void`. A voided document stays downloadable through `/documents/:id/pdf` (it is the
record); never through `/me/…`.

Approval of a self-service request goes through the existing `POST /tasks/:id/approve|reject` (workflow engine):
the `document_request` subject's `onApproved` hook issues the document **in the approval transaction** (issued_by =
the approver, default signatory, the request's language) and links it; any issuing error (e.g.
`document-profile-incomplete`, `document-employment-ended`, 503s) fails the approval and rolls it back with the same
slug. `onRejected` / `onCancelled` set the request status. Separation of duties as for leave (the requester and the
employee's linked user cannot act: `workflow-self-approval`). `resolveManager` is never called (no manager step).
Task summaries: `{type: 'document_request', employee:{id, matricule, person, unit}, documentType:{code, labels},
language, purpose, requestedAt}`.

```ts
interface DocumentTypeView { id: string; code: string; labels: { fr: string; ar: string; en: string };
  languages: ('fr' | 'ar')[]; selfService: boolean; active: boolean; sortOrder: number;
  numberFormat: string | null; nextNumber: string | null; defaultSignatoryId: string | null }
interface SignatoryView { id: string; unit: { id: string; code: string; name: string; nameAr: string | null } | null;
  names: { fr: string; ar: string }; titles: { fr: string; ar: string }; active: boolean; defaultFor: string[] }
interface CompanyProfileView { legalNameFr: string | null; legalNameAr: string | null; addressFr: string | null;
  addressAr: string | null; cityFr: string | null; cityAr: string | null; phone: string | null; email: string | null;
  nif: string | null; nis: string | null; rc: string | null; ai: string | null; footerFr: string | null;
  footerAr: string | null; hasLogo: boolean; complete: { fr: boolean; ar: boolean } }
interface IssuedDocumentView {
  id: string; number: string; type: { code: string; labels: { fr: string; ar: string; en: string } };
  language: 'fr' | 'ar'; status: 'issued' | 'void'; issueDate: string; issuedAt: string;
  issuedBy: { id: string; displayName: string } | null;
  employee: { id: string; matricule: string; person: NamePair; unit: UnitRef };          // as in employment.md
  leaveRequestId: string | null; documentRequestId: string | null;
  signatory: { id: string; names: { fr: string; ar: string } };
  sizeBytes: number; sha256: string;                                                        // hex
  void: { at: string; by: { id: string; displayName: string } | null; reason: string } | null;
  warnings: ('leave-cancelled')[];
  _actions: ('void')[];
}
interface DocumentRequestView { id: string; type: { code: string; labels: { fr: string; ar: string; en: string } }; language: 'fr' | 'ar';
  purpose: string | null; status: 'pending' | 'approved' | 'rejected' | 'cancelled'; requestedAt: string;
  workflow: { instanceId: string; status: string; currentStep: number; steps: { key: string; kind: string; permission?: string; labels: { fr: string; ar: string; en: string }; state: string }[] }; // as leave list items
  document: { id: string; number: string } | null; rejectionComment: string | null; _actions: ('cancel')[] }
```

### Audit

- Row triggers on every Phase A table except the two exempt ones. `issued_document.snapshot` is visible in the diff
  (it holds nothing masked: no salary, NSS, RIB).
- Application events (`AuditEvents` port): `document.issued` `{number, typeCode, language, employmentId, sha256,
  via: 'hr' | 'self_service'}`, `document.downloaded` `{number, disposition, via: 'hr' | 'self'}`,
  `document.voided` `{number, reason}`, `document.settings_changed` is **not** needed (row triggers).
- Timeline: new subject type `issued_document:<id>` (its row, file-less; its events), visible like `GET
  /documents/:id` (`document.read` in scope, 404 otherwise — the `leave_request` precedent, no `audit.read` needed);
  the `employee:<id>` timeline also includes the employee's `issued_document` rows and `document.*` events, and
  `document_request` rows. Labels for the web: `audit.fields.issued_document.*`, `audit.events.document.*`.

### Notifications

| Type | When | Recipients | Email default | Link |
|---|---|---|---|---|
| `task.assigned` (existing) | a `document_request` HR task opens | holders of `document.issue` over the employee's unit, minus the requester | on | `/tasks?task=<id>` |
| `document.ready` | a self-service request is approved (document issued) | the employee's linked user | on | `/me/documents?document=<id>` |
| `document.rejected` | a self-service request is rejected | the employee's linked user | on | `/me/documents?request=<id>` |

`task.assigned` `data` gains `subjectType` (`leave_request` \| `document_request`) and, for documents,
`documentType` (code); in-app and e-mail wording by subject type ("Demande d'attestation de travail à traiter :
<Name>" / "طلب شهادة عمل للمعالجة: <Name>"). `NotificationView.subject.type` gains `document_request` and
`issued_document`. Mails never include the document itself or the purpose.

### Worker

No job in Phase A (rendering is synchronous in the API request; ADR 008).

### Deploy and platform

- `apps/api/assets/pdf/{fonts,templates}` (ADR 008) are copied into the image: `COPY --from=build
  /repo/apps/api/assets ./assets` in `apps/api/Dockerfile`; the platform resolves them relative to the package root
  (env `PDF_ASSETS_DIR` overrides, for tests).
- Env: `PDF_RENDER_TIMEOUT_MS` (default 15000), `PDF_RENDER_CONCURRENCY` (threads, default 1, max 4).
- `GET /api/health` is unchanged; a unit test renders every template in both languages from a fixture snapshot and
  checks the PDF parses and contains the number (text extraction).
- Caddy: no change for Phase A (PDF responses are small; the web opens them as blobs, below).

### Web (Phase A)

Every screen: fr/ar/en keys under `documents.*` (fr/ar parity), RTL, usable at 390 px (tables in `.table-scroll`,
forms single-column). PDFs are fetched with `HttpClient` as a **Blob** (so the refresh interceptor works and problem
bodies can be parsed: an error Blob must be read as JSON before mapping the slug), then opened with
`URL.createObjectURL` in a new tab ("Ouvrir") or saved with a temporary `<a download="<number>.pdf">` ("Télécharger");
revoke the URL afterwards.

- **Nav**: "Documents" (`/documents`, `document.read`); "Mes documents" (`/me/documents`, visible when
  `document.request_self` and a linked employment, like My leave).
- **Register** `/documents` (`document.read`): filters type, status, search, unit picker + sub-units, date range —
  **all in the URL query** (as `/employees`); columns number, type, employee, language, issue date, status (void rows
  muted, a "leave cancelled" badge from `warnings`); row → detail. "Émettre un document" button with
  `document.issue`.
- **Detail** `/documents/:id`: facts, signatory, hash (short), Open / Download, **Void** (`_actions`, dialog with a
  required reason), History tab (timeline `issued_document:<id>`).
- **Issue** `/documents/new?type=&employee=&leaveRequest=` (`document.issue`, `canMatch`): type select (active
  types), employee picker (reuse), for `titre_conge` a select of the employee's **approved** leave requests, language
  radio (default: `ar` when the UI is Arabic, else `fr`), signatory select (preselected default), "Aperçu" (preview
  PDF in a new tab) and "Émettre" (sends a fresh `clientRequestId` per form; the button is disabled while pending);
  success → the detail page with an "Ouvrir le PDF" call to action. 409/422 slugs mapped to fields or a banner
  (`document-profile-incomplete` links to settings when the user holds `document.configure`).
- **Employee detail**: a **Documents** tab (with `document.read`) = register rows of this employee + "Émettre" with
  the employee preselected.
- **Leave request detail** `/leave/requests/:id`: when `approved` and `session.can('document.issue')`, "Titre de
  congé" → `/documents/new?type=titre_conge&leaveRequest=<id>&employee=<employmentId>`; titles already issued for the
  request listed (`GET /documents?leaveRequestId=`).
- **Settings** `/documents/settings` (`document.configure`): tabs **En-tête** (profile form fr/ar side by side on
  desktop, stacked on phones; Arabic inputs `dir="rtl"`, identifiers `dir="ltr"`; logo upload with preview and
  remove; completeness badges fr/ar), **Signataires** (table + create/edit form: unit picker or "toute l'entreprise",
  names/titles fr/ar, active), **Types** (per type: number format with live preview of the next number computed
  client-side from the format, languages, self-service toggle for the attestation, default signatory, active).
- **My documents** `/me/documents` (`document.request_self`): "Demander une attestation" form (self-service types,
  language, purpose), my requests with workflow progress and cancel, my documents with Open/Download.
  `?document=` / `?request=` highlight the item (notification links).
- **My tasks**: `document_request` tasks render their summary (employee, document type, language, purpose); approve
  / reject as for leave; an approval error slug shows in the task panel.
- Angular guide: a chapter on **binary downloads and blobs** (HttpClient `responseType: 'blob'`, object URLs, error
  Blobs), and on file inputs + `FormData` (Phase B / logo upload).

### Seed (`seed:dev`)

DEMO: a complete profile (fictitious: "Entreprise Démo HRForce" / "مؤسسة هرفورس التجريبية", Alger / الجزائر, fake
NIF/NIS/RC marked as test data, a small generated PNG logo); signatories: HR director company-wide and the Région Est
director (Souad Cherif / سعاد شريف) on `REG-EST`; issued documents: attestations for two Est and one Ouest employee (fr
and ar), a certificat for an ended employee, a titre for an approved leave request, one void attestation; one pending
self-service request from `agent.annaba@demo.dz`. BETA (test fixture): a profile and one issued document.

### Authorization matrix rows (expected)

Actors and targets as in `authorization-matrix.e2e-spec.ts`. Targets: `est` = EMP-0027 / its documents, `ouest` =
EMP-0036 / its documents, `other` = BETA's. The fixture seeds profiles, signatories, one issued document per target
and an approved leave request per target.

| Route | Rows |
|---|---|
| `GET /documents/types` | READERS (200 for everyone signed in, incl. agent/chef) |
| `PUT /documents/types/:id`, `PUT/DELETE /documents/settings/profile/logo`, `PUT /documents/settings/profile`, `POST /documents/settings/signatories`, `PATCH /documents/settings/signatories/:id` | CONFIG_ROWS on the caller's own company (admin and beta ✓ — 200, 201 or 204 as the route answers; est, ouest, acces 403); plus one row: beta on company A's signatory/type id → 404 |
| `GET /documents/settings/profile`, `GET /documents/settings/signatories`, `GET /documents/settings/profile/logo` | CONFIG_ROWS(200) |
| `GET /documents/signatories` | admin 200, est 200, ouest 403, acces 403, beta 200, agent 403 |
| `POST /documents/preview`, `POST /documents` | HR_ROWS with 200 / 201: admin est/ouest ✓, other 404; est est ✓, est ouest 404; ouest (lecture) 403; acces 403; beta est 404, beta other ✓; agent 403 |
| `GET /documents` | admin 200, est 200 (only Est rows — asserted), ouest 403, acces 403, beta 200, agent 403 |
| `GET /documents/:id`, `GET /documents/:id/pdf` | DOC_READ: admin est/ouest 200, other 404; est est 200, est ouest 404; ouest 403; acces 403; beta est 404, beta other 200; agent est 403 |
| `POST /documents/:id/void` | admin est/ouest 200, other 404; **est est 403** (no `document.void`); ouest 403; acces 403; beta est 404, beta other 200 (each ✓ row on its own document) |
| `GET /me/documents`, `POST /me/documents/requests` | SELF: agent 200/201, est 200/201 (linked, holds `employe`), admin 409, beta 409 (`document-not-linked`), ouest 403, acces 403 |
| `POST /me/documents/requests/:id/cancel` | agent (own) 200; est on agent's request 404; ouest 403 |
| `GET /me/documents/:id/pdf` | agent own 200; agent on EMP-0027's document 404; est own 200; ouest 403 |
| anonymous | 401 on every route above |

Plus e2e (not matrix): approving a document task issues the document (number consumed only on approval), rejecting
issues nothing; the requester cannot approve (`workflow-self-approval`); gap-free concurrency test; void keeps the
number; replay with `clientRequestId`.

### Settled by the build (Phase A API, 2026-09-28)

**Shape changes the web must know (everything else is as written above):**

1. **`DocumentSnapshot.employee.sex: 'M' | 'F' | null`** is added (the templates' gender agreement: né/née,
   employé/employée, المولود/المولودة, يعمل/تعمل). It is part of `GET /documents/:id` → `snapshot`.
2. **Letterhead columns are nullable in the database** (`company_profile.legal_name_fr`, `address_fr`, `city_fr`
   included), so a logo can be uploaded before the text exists (the upload creates an empty row).
   `PUT /documents/settings/profile` still **requires `legalNameFr`, `addressFr`, `cityFr`** (1–200 / 1–300); the 11
   other fields are optional, `null` or `""` → `null`. Identifiers (NIF, NIS, RC, AI) are upper-cased before the
   `^[0-9A-Z /-]{1,30}$` check; `phone` `^[0-9+ ().-]{1,40}$`; `email` must be an e-mail address. The web's reading
   (all 14 text fields sent, empty as null) matches.
3. `POST /documents` and `/documents/preview` with the wrong subject field: 422 `errors[{field: 'employmentId' |
   'leaveRequestId', code: 'required' | 'not_allowed'}]`.

**Numbering and issuing**
- Issue date = today in `Africa/Algiers` (provider `DocumentsClock`, pinned by the tests); the number's year is its
  calendar year. A format may be up to 60 characters as typed; "≤ 40 characters once rendered" is checked with a
  5-digit sequence number.
- Allocation exactly as ADR 008 §6 (`set local lock_timeout = '5s'` around the upsert, reset after). A database guard
  (`document_sequence_guard`) only lets a counter move forward by one. 503 answers carry `Retry-After` (5 s for
  `document-render-failed`, 2 s for `document-busy`). `document-number-taken` carries
  `errors[{field: 'numberFormat', code: 'number_taken'}]`; the counter increment is rolled back with it.
- `clientRequestId`: replays are serialised by a transaction-scoped advisory lock on (company, id); a replay is the
  same document when `typeCode`, the employee, `leaveRequestId`, `language` and (if sent) `signatoryId` match — else
  409 `document-client-request-reused`. The 200 replay also sets `Location`.
- Preview: `200 application/pdf`, `Content-Disposition: inline; filename="specimen-<typeCode>.pdf"`, no `ETag`; the
  number is the format with the sequence replaced by `…` (e.g. `ATT-2026-…`).
- Signatory: the one sent (active and covering the employee, else 422 `signatoryId` `invalid_signatory`); else the
  type's default **when it covers the employee**; else the nearest covering one (unit distance in today's tree),
  company-wide last. `GET /documents/signatories?employmentId=` needs `document.issue` over that employee (404 / 403
  `forbidden-scope` like issuing) and lists covering signatories nearest first; without the parameter every active one.
- Errors raised while preparing (in this order): unknown/out-of-scope employee or leave request 404, readable but
  outside `document.issue` 403 `forbidden-scope`, `document-type-inactive`, language (422), `document-leave-not-approved`,
  `document-employment-ended` / `-not-ended`, `document-profile-incomplete` (`errors[]` = missing fields in the
  requested language), signatory (422 / 409 `document-no-signatory`).
- Stored per document: `template_version` `<type>@1`, `renderer` `typst 0.14.2 / typst-ts 0.7.0`. The same snapshot
  renders byte-identical PDFs on Windows (win32-x64) and in the production image (linux-x64-musl) — verified
  (SHA-256 `06898e28…f723` for the same test snapshot on both).

**Register, scope, views**
- Visibility uses the employee's scope unit **today**; the register's `unitId`/`includeSubUnits` filter also applies to
  that current scope unit (not to `issued_document.org_unit_id`, which stays informative). `q` matches the number
  (case-insensitive), the person's name or the matricule. Order: `issued_at` desc.
- `POST /documents/:id/void`: rh_regional (no `document.void`) → 403 at the guard; a holder of `document.void`
  elsewhere who can read the document → 403 `forbidden-scope`; unknown/out of scope → 404.
- `IssuedDocumentView.issuedBy` / `void.by` show the user id as `displayName` for a former member.
- `_actions: ['void']` only for an issued document whose employee is in the caller's `document.void` scope;
  `warnings: ['leave-cancelled']` only while the titre is still issued.
- `GET /me/documents` → `documents` = every **issued** (not void) document of the linked employment, whatever its type
  (HR-issued certificats and titres included), newest first, `_actions` always `[]`; `requests` newest first.
  `DocumentRequestView.rejectionComment` = the rejecting task's comment.
- PDF downloads: `Content-Disposition: <disposition>; filename="<number>.pdf"`, plus `Content-Length`. The logo:
  `GET …/logo` answers with its sniffed type, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`.
- Logo upload: multipart field `file`; no file / empty → 422 `{field: 'file', code: 'required'}`; over 256 KB → 422
  `too_large` (never 413); not PNG/JPEG by content → 422 `unsupported_type`. `DELETE` is 204 also when there is no logo.
- `PUT /documents/types/:id`: `defaultSignatoryId` must be an active signatory (422 `not_found`); `selfService: true`
  on another type → 422 `{field: 'selfService', code: 'not_allowed'}`. `GET /documents/types`: `numberFormat`,
  `nextNumber` (current Algiers year) and `defaultSignatoryId` are non-null for holders of `document.issue` or
  `document.configure` anywhere.

**Self-service and workflow**
- Request checks, in order: `document-not-linked`, typeCode unknown (422), `document-type-not-self-service`,
  `document-type-inactive`, language (422), `document-employment-ended`, `document-request-pending` (also the partial
  unique index). The HR task's `scope_unit_id` = the employee's scope unit when requested.
- Cancelling: only `pending` (else 409 `document-request-not-cancellable`, also from the engine); no notification.
- Approval issues in the approval transaction (issued_by = approver, `via: 'self_service'`, `document_request_id`
  set, default/nearest signatory, the request's language). Any issuing error (e.g. `document-profile-incomplete`, the
  503s) fails the approval with that slug and leaves the task open (tested).
- My tasks `subject` for a document request = `{type: 'document_request', id, employee: {id, matricule, person, unit},
  documentType: {code, labels}, language, purpose, requestedAt}` (built like leave subjects; the web's reading matches).
- Notification `data` (the web reads `documentType` and `subjectType`; types names come from its i18n):
  `task.assigned` `{requestId, employeeName, employeeNameAr, documentType, language, subjectType: 'document_request',
  stepKey, taskId, actorName}` (leave tasks now also carry `subjectType: 'leave_request'`); `document.ready` (subject
  `issued_document`) `{requestId, employeeName, employeeNameAr, documentType, language, documentId, number, actorName}`;
  `document.rejected` (subject `document_request`) `{…same without documentId/number…}`. The purpose is never in a
  notification or an e-mail. Mail wording in `modules/notifications/domain/mail-templates.ts` (fr/ar/en), with the
  document type's label from `document_type` in the recipient's language.
- Titre de congé picker: **no `employmentId` filter was added to `GET /leave/requests`**; the web's approach
  (`status=approved&q=<matricule>` then client-side filtering) stands.

**Leave, audit, timeline**
- Leave exports `LeaveFacts` (request facts + resumption) and `resumptionOf`: the first day after the end that is not a
  policy weekend day nor a public holiday; a leave ending at noon resumes "<end date> après-midi" / "… بعد الظهر";
  a leave starting at noon prints "<start> (après-midi)".
- Timeline subject `issued_document:<id>`: its row and its `document.*` events, visible with `document.read` over the
  employee (no `audit.read`), else 404. The employee timeline adds `issued_document` and `document_request` rows and the
  events about them (`document.*`, `workflow.*` of document requests). Workflow events of a document request have
  subject type `document_request`.
- Audit: row triggers on `company_profile` (keyed on `company_id`, `logo` masked), `document_signatory`,
  `document_type`, `issued_document`, `document_request`; `document_sequence` and `issued_document_file` are exempt
  (`tools/guardrails/audit-exempt.json`). Events `document.issued`, `document.downloaded`, `document.voided` as written.

**Wording and templates (to confirm by the verifier/owner)**
- Arabic titles: attestation « شهادة عمل », certificat « شهادة نهاية العمل » (owner, 2026-09-29; was « شهادة العمل »), titre « سند عطلة ». Identifier labels in Arabic
  documents: رقم التعريف الجبائي (NIF), رقم التعريف الإحصائي (NIS), السجل التجاري (RC), رقم المادة الجبائية (AI).
  Birth place and job title are printed as recorded (Latin) in Arabic documents.
- Templates use only the vendored fonts (`fallback: false`): a character outside Cairo / Source Sans 3 prints as a
  missing glyph rather than a host font (same bytes everywhere).

**Platform, deploy, seed**
- Env: `PDF_RENDER_TIMEOUT_MS` (1000–120000, default 15000), `PDF_RENDER_CONCURRENCY` (1–4, default 1),
  `PDF_ASSETS_DIR`. The render threads start at the first render, get no inherited CLI flags, and a thread that times
  out is terminated and replaced.
- Image: `apps/api/Dockerfile` copies `apps/api/assets`; measured `node_modules` 82.6 → 132.7 MB (+50 MB, the
  linux-x64-musl binding only), assets 1.1 MB; `docker image ls` 344 → 422 MB, compressed content 77.5 → 101.9 MB.
  A render inside the image (read-only root, `cap_drop: ALL`, user `node`) takes ~85 ms cold, RSS ~115 MB.
- Seed: DEMO letterhead (test data, generated PNG logo), signatories `…8020-000000000001` (Farid Belkacem, DRH,
  company-wide) and `…8020-000000000002` (Souad Cherif, REG-EST); issued ATT (EMP-0027 fr, EMP-0031 ar, EMP-0036 fr,
  EMP-0028 ar voided), CT (EMP-0025), TC (agent.annaba's approved leave), and agent.annaba's pending Arabic attestation
  request. `bootstrap` creates the three types and `document.hr_only` (no letterhead). The e2e fixture option
  `documents: true` seeds DEMO's settings, BETA's French-only letterhead and a BETA signatory.

### Settled by the verification (Phase A, 2026-09-29)

- **Bidi controls are removed from printed values.** `buildSnapshot` strips U+202A–U+202E and U+2066–U+2069 from
  every string of the snapshot (letterhead, names, titles, unit, job, leave labels); LRM/RLM are kept. The stored
  snapshot is therefore exactly what is printed. Reason: an unterminated RLO/LRO in any value (e.g. pasted into a name)
  mirrored the rest of the legal sentence in both languages. Other data (Typst markup, `#read(…)`, `#panic()`, quotes,
  brackets, 200/300-character values) prints literally; a single unbroken 200-character token overflows the margin
  (cosmetic, accepted).
- **PDF viewer under the production CSP.** Opening a PDF as a `blob:` URL in a new tab works in Chrome and Edge with
  `deploy/Caddyfile`'s CSP (`object-src 'none'` included; the `blob:` document inherits the CSP). No Caddy change.
  Logo previews use `data:` URLs (`img-src 'self' data:`), no violation.
- **Number formats are upper-cased by the web** (the input only displays capitals); the API does not upper-case
  formats and answers 422 `invalid_format` to lower-case tokens.
- **Immutability in the database:** `hrforce_app` has no UPDATE/DELETE privilege on `issued_document_file` and no
  DELETE on `issued_document` ("permission denied"); `issued_document_guard` refuses every UPDATE except
  issued → void; `document_sequence_guard` refuses any counter move other than +1 (so a direct `+1` by the app role
  would still create a gap — the app-role trust question of HANDOFF open question 3).
- **Idempotency in practice:** three concurrent POSTs with the same `clientRequestId` → one document (201 once, 200
  twice); ten concurrent issues with distinct ids → ten consecutive numbers, `last_value = count(issued_document)`.
- **Web:** `/documents` for a signed-in user without `document.read` renders an empty page rather than the 404 page
  (same as `/leave`: a lazy parent whose empty-path child is guarded).
- **Known wording/label points for the owner** (not changed): the web i18n calls the certificat
  « شهادة نهاية العمل » (`documents.typeNames.certificat_travail`, error messages) while the database type name and the PDF title are
  « شهادة العمل »; the Arabic titre sentence has no day count (the table has it); the timeline shows the signatory as
  an id and `content_sha256` as `\x…` hex.

## Phase B — employee file (attachments)

> **Built 2026-09-29 (API).** Shape additions and decisions the web must know: *Settled by the build (Phase B API,
> 2026-09-29)* at the end of this file (additions only; nothing below was removed or renamed).

### Storage decision

Files live in Postgres **`bytea`** in a separate content table (ADR 005; ADR 008's reasons against large objects: no
RLS on `pg_largeobject`, separate privileges, orphans). 10 MB per file is read fully into memory on upload and
download; that is acceptable at this size (`bytea` itself allows 1 GB). Metadata and content are split so listing
never reads content.

### Data (migration 0015)

| Table | Columns | Rules |
|---|---|---|
| `employee_file_category` | `id`, `company_id`, `code`, `name_fr/ar/en`, `access_class` (`standard`/`medical`), `retention_years_after_end int` null (null = keep), `active`, `sort_order`, `is_system` | unique (`company_id`,`code`); seeded: `diploma` (Diplômes / الشهادات), `contract` (Contrats et avenants / العقود والملاحق), `id_document` (Pièces d'identité / وثائق الهوية), `medical` (Médical / طبي, `medical`), `other` (Autres / أخرى); only `standard` categories may be created through the API |
| `employee_file` | `id`, `company_id`, `employment_id`, `category_id`, `title` (1–120), `original_filename` (≤ 200, path parts and control characters removed), `mime` (sniffed), `size_bytes`, `sha256 bytea`, `document_date` null, `expires_on` null (e.g. an ID card), `scan_status` (`not_scanned`, reserved), `uploaded_by`, `uploaded_at`, `deleted_at` null, `deleted_by` null, `delete_reason` null, `purged_at` null | audited (who sees these rows in a timeline: see Audit below); no DELETE for the app (tombstones); only the tombstone and `purged_at` columns may change |
| `employee_file_content` (**audit-exempt**: bytes; hash audited on `employee_file`) | `file_id` pk, `company_id`, `content bytea` | app: INSERT and DELETE only (DELETE only together with setting `deleted_at`/`purged_at`); worker: DELETE for the purge |

### Upload validation

- `multipart/form-data`: `file` (exactly one), `categoryId`, `title`, `documentDate?`, `expiresOn?`. Multer memory
  storage with `limits: {fileSize: EMPLOYEE_FILE_MAX_BYTES (default 10 MB, max 20 MB), files: 1, fields: 10}`;
  over the limit → 422 `too_large` (never a 500). Caddy: `request_body max_size 25MB` on `/api/employees/*/files`.
- **Type by content** (magic bytes), the declared `Content-Type` and extension are ignored: `%PDF-` → `application/pdf`
  (and `%%EOF` within the last 1 KB); `FF D8 FF` → `image/jpeg`; `89 50 4E 47 0D 0A 1A 0A` → `image/png`. Anything
  else → 422 `unsupported_type`. Empty file → 422 `empty`.
- **Antivirus stance** (assumption 13): none. Mitigations: allowlist of three passive formats; files are never parsed,
  thumbnailed or executed by the server; always served as `attachment` with the sniffed type, `X-Content-Type-Options:
  nosniff`, `Content-Security-Policy: sandbox; default-src 'none'`, `Cache-Control: private, no-store`; only
  authenticated HR can upload. `scan_status` lets a future ClamAV worker job (if the owner accepts a clamd service)
  flag files without a schema change.
- Duplicate detection: same `sha256` already on this employment (not deleted) → 409 `employee-file-duplicate`
  (field `file`).

### Permissions (group `documents`, sort 670–690; `employee.medical.update` in `sensitive`)

| Code | fr | ar | System roles |
|---|---|---|---|
| `employee_file.read` | Consulter le dossier de l'employé | الاطلاع على ملف الموظف | `admin_rh_central`, `rh_regional` |
| `employee_file.upload` | Ajouter des pièces au dossier | إضافة وثائق إلى الملف | `admin_rh_central`, `rh_regional` |
| `employee_file.delete` | Supprimer des pièces du dossier | حذف وثائق من الملف | `admin_rh_central` |
| `employee.medical.update` (sensitive) | Ajouter des pièces médicales | إضافة وثائق طبية | **none** (like `employee.medical.read`) |

`SYSTEM_ROLES.admin_rh_central` becomes "everything except `employee.medical.read` **and `employee.medical.update`**".
Access by class: `standard` — read `employee_file.read`, add `employee_file.upload`, delete `employee_file.delete`;
`medical` — read `employee_file.read` **and** `employee.medical.read`, add `employee_file.upload` **and**
`employee.medical.update`, delete `employee_file.delete` **and** `employee.medical.update`; all over the employee's
unit. Medical files a caller cannot read are **absent** from lists (and `_redacted: ['medical']` is set), their ids
answer 404; uploading into `medical` without the permission → 403 `forbidden-field` (`errors[{field:'categoryId'}]`).

### Endpoints

| Method + path | Guard | Request → response |
|---|---|---|
| `GET /employee-files/categories` | `@Authenticated` | `{items: [{id, code, labels, accessClass, retentionYearsAfterEnd, active, isSystem}]}` |
| `POST /employee-files/categories` | `document.configure` (company) | `{code, labels, retentionYearsAfterEnd?}` (standard only) → 201; 409 `category-code-taken` |
| `PUT /employee-files/categories/:id` | `document.configure` (company) | `{labels?, retentionYearsAfterEnd?, active?}` → 200 |
| `GET /employees/:id/files?categoryId=&includeDeleted=` | `employee_file.read` | files of **every employment of the person** (a rehired person keeps their diplomas), newest first → `{items: EmployeeFileView[], _redacted: ('medical')[], _actions: ('upload' \| 'upload_medical')[]}`; `includeDeleted` needs `employee_file.delete` (ignored otherwise) |
| `POST /employees/:id/files` | `employee_file.upload` | multipart (above) → 201 `EmployeeFileView`; ended employment is **allowed** (archiving after departure) |
| `GET /employees/:id/files/:fileId/content` | `employee_file.read` | bytes as `attachment; filename*=UTF-8''<original>`; audit event `employee_file.downloaded`; deleted/purged → 404 |
| `POST /employees/:id/files/:fileId/delete` | `employee_file.delete` | `{reason}` (3–500) → 204: tombstone + content row deleted in the same transaction; already deleted → 409 `employee-file-deleted` |

```ts
interface EmployeeFileView { id: string; employmentId: string; category: { id: string; code: string; labels: { fr: string; ar: string; en: string };
  accessClass: 'standard' | 'medical' }; title: string; originalFilename: string; mime: string; sizeBytes: number;
  sha256: string; documentDate: string | null; expiresOn: string | null; uploadedAt: string;
  uploadedBy: { id: string; displayName: string } | null;
  deleted: { at: string; by: { id: string; displayName: string } | null; reason: string } | null; purgedAt: string | null; _actions: ('delete')[] }
```

### Audit, retention, worker

- Events: `employee_file.downloaded` `{fileId, categoryCode, accessClass}` — **every** download (all employee files are
  personal data; medical ones are the required minimum), `employee_file.deleted` `{fileId, reason}`,
  `employee_file.purged` `{count}` per company per run.
- Timeline (`employee:<id>`): includes `employee_file` rows and events; rows and events of **medical** files are
  omitted unless the caller holds `employee.medical.read` over the employee's unit (titles like "Aptitude…" are
  medical data).
- Worker cron `employee_files.retention` (monthly, day 1 02:00, company by company as `hrforce_worker`): for files of
  ended employments whose category has `retention_years_after_end = N` and `end_date + N years < today`: delete the
  content row, set `purged_at` (metadata kept). Needs `hrforce_worker` privileges `SELECT` on the three tables,
  `UPDATE (purged_at)` on `employee_file`, `DELETE` on `employee_file_content`.
- Backups: file bytes are in the nightly `pg_dump`; a deleted file survives in dumps up to `BACKUP_RETENTION_DAYS`
  (document in `deploy/README.md`).

### Web (Phase B)

- Employee detail: a **Dossier** tab (with `employee_file.read`): files grouped by category (collapsible), each with
  title, date, size, type icon, uploader, "Télécharger" (Blob download), "Supprimer" (`_actions`, reason dialog);
  "Ajouter une pièce" (with `upload`): file input (`accept="application/pdf,image/jpeg,image/png"`, client-side size
  check as a courtesy — the API decides), category (medical only listed with `upload_medical`), title (prefilled from
  the file name), dates; progress bar via `HttpClient` `reportProgress`. A note "medical files hidden" when
  `_redacted` contains `medical`. Phones: one card per file.
- `/documents/settings` gains a **Catégories du dossier** tab (labels, retention, active).

### Authorization matrix rows (Phase B)

| Route | Rows |
|---|---|
| `GET /employee-files/categories` | READERS |
| `POST /employee-files/categories`, `PUT /employee-files/categories/:id` | CONFIG_ROWS |
| `GET /employees/:id/files`, `GET …/:fileId/content` | admin est/ouest 200, other 404; est est 200, est ouest 404; ouest 403; acces 403; beta est 404, beta other 200; agent 403 |
| `POST /employees/:id/files` | same with 201 |
| `POST …/:fileId/delete` | admin est/ouest 204, other 404; est est 403; ouest 403; acces 403; beta est 404, beta other 204 |
| medical file (seeded by SQL in the fixture) | admin: listed? **no** (`_redacted`), content 404; a custom role with `employee.medical.read` on REG-EST: 200 |

### Settled by the build (Phase B API, 2026-09-29)

**Shape additions and answers for the web (everything else is as written above):**

1. `GET /employee-files/categories` items also carry **`sortOrder`** (list order: `sortOrder`, then `code`). A category
   created through the API gets `sortOrder` = the company's highest + 10 and is always `accessClass: 'standard'`,
   `isSystem: false` (an `accessClass` key in the body is ignored).
2. **File set of a URL.** `/employees/:id/files*` with `:id` = an employment shows the files of that employment **and of
   the person's earlier employments** (`hire_date` before this one's) — a rehired person keeps their diplomas. Content
   and delete accept a file of that set through the page's employment id (the web's reading is right). The reverse is
   refused: through an older employment's URL, a later employment's files are absent (404).
   `EmployeeFileView.employmentId` tells which employment a file was attached to. Uploads always attach to `:id` (an
   ended employment is allowed).
3. **Multipart order does not matter** (the body is read completely, bounded, before the handler runs): the web's order
   (`categoryId`, `title`, optional dates, `file` last; empty dates omitted or `""`) works. Text fields: `categoryId`
   uuid, `title` 1–120 after trimming, `documentDate` / `expiresOn` real calendar dates `YYYY-MM-DD`, or empty → null.
   Extra 422 codes: `file` — `required`, `empty`, `too_large`, `unsupported_type`, **`one_file_only`** (a second file
   part, or a file under another field name), **`invalid_multipart`** (unreadable body); `categoryId` — `not_found`,
   **`inactive`**; **`expiresOn` `before_document_date`**. Field (DTO) errors come before the scope check (as issuing).
4. Order of the upload checks: DTO 422 → employee 404 / 403 `forbidden-scope` (readable with `employee_file.read` but
   outside `employee_file.upload`) → `file` and `categoryId` 422 together → medical 403 `forbidden-field`
   (`errors[{field: 'categoryId', code: 'forbidden'}]`) → 409 `employee-file-duplicate`.
5. **Categories:** code `^[a-z][a-z0-9_]{1,39}$` (422 on `code`), labels `fr`/`ar`/`en` each 1–120 after trimming,
   `retentionYearsAfterEnd` `null` or an integer 1–100; the code, the access class and the system flag never change (a
   database guard; `PUT` accepts only `labels`, `retentionYearsAfterEnd`, `active`). System categories may be edited
   (labels, retention, active) like the others. `PUT` on another company's id → 404 (the matrix uses the
   `DOC_CONFIG_ROWS` shape for it). The web's rules match.
6. `_redacted: ['medical']` is set whenever the caller lacks `employee.medical.read` over the employee's unit, **whether
   or not medical files exist** (no existence leak). List `_actions`: `upload` (`employee_file.upload`),
   `upload_medical` (+ `employee.medical.update`). Per file: `delete` when the file is live and the caller holds
   `employee_file.delete` (+ `employee.medical.update` for medical) over the unit.
7. **`includeDeleted=true`** (ignored without `employee_file.delete` over the unit) lists **deleted and purged** files
   (`deleted` / `purgedAt` set, `_actions: []`); without it both are absent. The web's switch rule matches.
8. Deleting: 404 unknown / outside the set / invisible medical; 403 `forbidden-scope` (readable, no delete scope); 403
   `forbidden-field` (medical without `employee.medical.update`); 409 `employee-file-deleted` (already deleted **or
   purged**); else 204 and the event `employee_file.deleted {fileId, reason}` besides the audited row change.

**Upload, storage, download**
- `POST /employees/:id/files` runs **without the request transaction** (`@SkipTransaction`): the permission check runs
  in its own short transaction, multer reads the body in memory **bounded at `EMPLOYEE_FILE_MAX_BYTES`** (default
  10 MB, 1 KiB–20 MB; `limits: {fileSize: max, files: 1, fields: 10, parts: 11}` — the reader stops at max + 1 byte and
  drains the rest without buffering), then the use case opens its own transaction with the request's tenant, user and
  request id (RLS and the audit trigger as usual; tested: the change-log actor is the uploader). No pooled connection is
  held while a slow upload streams in. Exactly the limit → 201; one byte more → 422 `too_large` (tested at 10 MB).
- Sniffing (`modules/documents/domain/employee-files.ts`): PDF = `%PDF-<d>.<d>` at offset 0 **and** `%%EOF` in the
  last 1 KB; JPEG = `FF D8 FF` plus at least one byte; PNG = signature + `IHDR` chunk. A PDF-headed polyglot
  (`%PDF-1.4` + HTML + `%%EOF`) is accepted as a PDF (inherent to content sniffing); it is only ever served as an
  attachment (below), which the tests assert.
- `original_filename`: last path part (`/` and `\`), NFC, C0/C1 controls, DEL, LRM/RLM/ALM and bidi embeddings /
  overrides / isolates removed, trimmed, ≤ 200 code points, `fichier` when nothing is left. The database refuses
  control characters, `/` and `\` in it.
- Download: `Content-Type` = the sniffed type; `Content-Disposition: attachment; filename="<ASCII fallback>";
  filename*=UTF-8''<RFC 8187>` (fallback: every character outside `A-Za-z0-9._-` → `_`, ≤ 150); **the downloaded
  name's extension always matches the sniffed type** (`page.html` holding a PDF downloads as `page.html.pdf`; `.pdf`,
  `.jpg`/`.jpeg`, `.png` are kept); `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox; default-src
  'none'`, `Cache-Control: private, no-store`, `Content-Length`, `ETag: "<sha256 hex>"`. Every successful download
  writes `employee_file.downloaded {fileId, categoryCode, accessClass}` (subject `employee_file:<id>`); refused ones
  write nothing.
- Duplicates: checked before the insert and by a partial unique index (`company_id, employment_id, sha256` where
  live), so a concurrent duplicate also answers 409. The same bytes on another employee, or after deleting the first
  copy, are allowed.
- Storage: `employee_file_content.content` is `STORAGE EXTERNAL` (no recompression of compressed formats). No
  per-employee count or total-size limit (the contract sets none).

**Database rules (migration 0015)**
- `employee_file_guard`: only the tombstone (its three columns, once) and `purged_at` (once) may change.
  `employee_file_content_delete_guard`: bytes are deleted only when their file is already tombstoned or purged (same
  transaction, tombstone first). `employee_file_category_guard`: code, access class, system flag immutable; a `medical`
  category must be a system one (check). `hrforce_app`: no DELETE on `employee_file` / `employee_file_category`, no
  UPDATE on `employee_file_content`. `hrforce_worker`: SELECT (0012 defaults), `UPDATE (purged_at)` on
  `employee_file`, DELETE on `employee_file_content`, EXECUTE on `audit.record_event` (the purge event). All tested.
- `scan_status` check allows `not_scanned` (default), `clean`, `infected`, `failed`, so a future scanner needs no
  schema change. File size ≤ 20 MB in the database.
- Permissions: `employee_file.read` 670, `.upload` 680, `.delete` 690 (group `documents`), `employee.medical.update`
  445 (group `sensitive`, `sensitive = true`). Grants: `admin_rh_central` the three `employee_file.*`, `rh_regional`
  read + upload, nobody the medical ones (`SYSTEM_ROLES.admin_rh_central` = everything except `employee.medical.read`
  and `employee.medical.update`). Since nobody holds them, a role with them can only be created by SQL today
  (`role-escalation` through the API) — the owner's "Médecin du travail" role needs an operator. `employee.medical.update`
  joins the MFA list of every existing security policy that lists `employee.medical.read`; new policies get it from
  `security_policy_default_permissions()` (every sensitive permission).
- Seeded categories: migration 0015 for existing companies, `seedDocumentDefaults` (bootstrap, seed:dev, fixtures) for
  new ones. `seed:dev` adds demo files (ids `…8021-00000000000{1..4}`): EMP-0027 a diploma PDF, an ID card PNG
  (expires 2031-03-31) and a **medical** certificate no seeded role can see; EMP-0036 a contract PDF.

**Retention**
- Cron `employee_files.retention` at `0 2 1 * *` (UTC, like the other jobs), company by company as `hrforce_worker`;
  `payload.today` (`YYYY-MM-DD`) overrides the Algiers date (manual run, tests). A live file (not deleted, not purged) is
  purged when its category has `retentionYearsAfterEnd = N`, **every employment of its person has ended**, and the
  **latest** end date + N years is **before** today (a rehired person's files are kept while they work here). Purge =
  `purged_at` set (audited row change, system actor, request id `job:employee_files.retention:<job>`), then the bytes
  deleted. `employee_file.purged {count}` (subject null) is written per company **only when count > 0**. Idempotent;
  tested with the worker role.

**Timeline**
- `employee:<id>` includes the `employee_file` rows and `employee_file.*` events of the files attached to **that**
  employment; those of medical files only when the caller also holds `employee.medical.read` over the employee's unit
  (tested both ways). Audit subject type `employee_file` added to the platform port; there is no `employee_file:<id>`
  timeline subject.

**Deploy**
- `deploy/Caddyfile`: `request_body max_size 25MB` on `POST /api/employees/*/files` (verified with a stub upstream:
  26 MB → 413 from Caddy, 20 MB passes, other routes unchanged). The CSP is now set by two mutually exclusive matchers:
  employee-file downloads (`/api/employees/*/files/*/content`) get `sandbox; default-src 'none'` (Caddy's header block
  used to overwrite the API's value with the app CSP); every other response keeps the unchanged app CSP (verified).
- `deploy/compose.staging.yml`: `EMPLOYEE_FILE_MAX_BYTES` (default 10485760). `deploy/README.md › Backups`: deleted or
  purged files survive in dumps up to `BACKUP_RETENTION_DAYS`.

### Settled by the verification (Phase B, 2026-09-29)

**Fixed during the verification**
- **File names are read as UTF-8.** Browsers send `filename="…"` in a multipart body as raw UTF-8 bytes (no
  `filename*`); multer's default parameter charset (latin1) stored « عقد العمل.pdf » as `Ø¹ÙØ¯ Ø§ÙØ¹ÙÙ.pdf` and let a
  U+202E through as `â€®` (so the bidi stripping never saw it). The upload interceptor now sets
  `defParamCharset: 'utf8'`; e2e test "a browser-style filename=… in raw UTF-8". `filename*=UTF-8''…` works as before.
- **The web saves a download under the API's name rule** (`downloadFileName()`, `employee-files.models.ts`): a Blob
  saved through `<a download>` takes the name the app gives, not `Content-Disposition`, so `page.html` holding a PDF was
  saved as `page.html` (a PDF/HTML polyglot opened from the disk would render as HTML). It is now `page.html.pdf`, like
  the API's header.
- **Expiry before the document date is checked in the web** (`notBefore` on `expiresOn`, re-checked when the document
  date changes), with the translated message "La date doit être au plus tôt le {date}." The API's 422
  `before_document_date` stays the backstop (its message is English, like every server field message).
- **A 413 from the reverse proxy** (body over Caddy's cap) is shown as « Fichier trop volumineux. » on the file field
  instead of "unexpected error". Only reachable outside the page's own 10 MB pre-check (a larger API limit, or a
  smaller proxy cap); verified with a 1 MB Caddy cap.
- **Medical note wording**: `_redacted: ['medical']` is set whether or not medical files exist, so the note no longer
  says they exist: « Les pièces médicales éventuelles ne sont pas affichées : elles ne sont visibles qu'avec
  l'habilitation médicale. » (ar/en likewise).

**Verified as written** (browser fr + ar, 1280 + 390 px; API probes; `hrforce_app` in SQL)
- Upload of real PDF / JPEG / PNG (1.7–5.1 MB) with the progress bar moving 0 → 100 % under a 1 MB/s throttle, both
  direct and through `deploy/Caddyfile` in Docker (HTTP/2); drag and drop; client pre-checks (11 MB, `.docx`); server
  refusal of a GIF named `.png`; 409 duplicate; downloads byte-identical; delete with reason (empty reason refused),
  show-deleted switch (admin only); timeline rows and events; category create / edit / deactivate, code locked, taken
  code and retention bounds.
- Scope: `rh_regional` Est → Ouest employee: list, upload, content 404; delete 403 in and out of region
  (`employee_file.delete` missing — the permission check comes before the scope lookup); `lecture`, `employe` 403 on
  every route, including the employee's own file (assumption 16); `includeDeleted` ignored for `rh_regional`.
  IDOR: a file id through another employee's URL 404; medical id for `rh.admin` content/delete 404, absent from the list
  with `includeDeleted`; unknown id and non-uuid 404.
- Sniffing: GIF/SVG/HTML/EXE renamed, PDF without `%%EOF` in the last 1 KB, JPEG of 3 bytes, PNG without `IHDR` → 422
  `unsupported_type`; empty → `empty`; exactly 10 485 760 bytes → 201, one more → 422 `too_large`; two file parts or a
  file under another field → `one_file_only`; truncated body → `invalid_multipart`; JSON body → `file: required`.
  **Accepted by design** (content sniffing, no antivirus — assumption 13): a PNG with HTML appended (served
  `image/png`), a PDF with a `/JavaScript` OpenAction, a `%PDF`-headed HTML; all served as `attachment` with `nosniff`,
  `sandbox; default-src 'none'`, `private, no-store`, through Caddy too (the app CSP is not applied to them; no CSP
  violation on the app pages).
- File names: `../../../etc/passwd.pdf` → `passwd.pdf`, `..\..\windows\win.ini.pdf` → `win.ini.pdf`, `a/b/c.png` →
  `c.png`, 1 000 characters → 200, blank → `fichier`, `%2e%2e%2f` kept as text; a NUL byte → 422 `invalid_multipart`;
  a raw CR/LF inside the quoted name breaks the part header → 422 (browsers send `%0D%0A`); `Content-Disposition` is
  always ASCII-safe with the exact name in `filename*`.
- Database as `hrforce_app`: UPDATE of `employee_file_content`, DELETE of `employee_file` / `employee_file_category` →
  permission denied; bytes of a live file, any metadata column, a second tombstone → guard errors; code / access class /
  system flag → guard error; a non-system medical category → check violation; another tenant sees 0 rows.
- Memory: 5 concurrent 10 MB uploads → 201 each (~0.7 s), 5 concurrent 25 MB → 422, API RSS 165 → 188 MB, healthy.
- Caddy: `max_size 25MB` is **decimal** (25 000 000 bytes): 20 and 23 MiB reach the API (422 `too_large`), 24 MiB and
  more → 413 from Caddy. Any `EMPLOYEE_FILE_MAX_BYTES` up to its 20 MiB maximum still fits.

**Known points for the owner (not changed)**
- The app role may also set `purged_at` and delete the bytes of a live file (the purge path), bypassing retention —
  the app-role trust question (HANDOFF open question 3).
- An HR user sees and uploads to **their own** file when their own employment is in their scope (`rh.est` is linked to
  EMP-0022, Région Est). Assumption 16 only covers the `employe` role.
- The timeline shows the category of a created file as its id, `sha256` as `\x…` and `scan_status` as `not_scanned`
  (same family as the Phase A timeline points).
- **PDF engine (ADR 008), found while investigating a test crash:** a render thread shares the API process, so a Rust
  allocation failure inside Typst aborts the **whole API** (exit `0xC0000409` on Windows); and `worker.terminate()`
  does not interrupt native code — a timed-out render keeps its CPU and memory until Typst returns. With fixed templates
  and JSON data this needs a pathological input: a 246 KB, 45 000 × 45 000 px 1-bit PNG logo (under the 256 KB logo
  limit) took ~2 GB of memory in a direct Typst render (measured outside the API). Suggested hardening: refuse logos
  over e.g. 4 000 × 4 000 px at upload (PNG `IHDR` / JPEG `SOF` dimensions). The test crash itself came from the
  spec's own runaway template (`range(400000000)` builds an 8 GiB array); the spec now uses a bounded loop.
