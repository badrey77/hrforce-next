# Contract — Document templates: designer, custom document types, versions

Binding contract between `apps/api` (module `documents`: template versions, custom types, a layout resolver, one new
fixed Typst file) and `apps/web` (a template designer, a « Modèles » tab in the document settings, custom fields on
the issue form). Owner decisions 2026-10-09 (`docs/HANDOFF.md`):

- templates are made in a **built-in designer only** (no Word upload);
- the designer can **override the three existing types** and **create new document types**;
- `[signature]` prints the signatory's **name and title**, the paper is still **signed and stamped by hand** (decision
  2026-09-28 unchanged: no signature or stamp image);
- templates are edited by **central HR** (`admin_rh_central`), company-wide, with two-step sign-in, **versioned**
  (draft → preview → publish), every change audited; documents already issued keep their stored PDF.

ADR 008 is amended (Decision 3, 2026-10-09): a designed template is **data**, never Typst code. One fixed, reviewed
Typst file (`designed.typ`) lays out a list of already-resolved blocks; the API resolves placeholders in TypeScript.
Nothing a user types is evaluated as markup, so the injection and denial-of-service reasons that kept templates in code
still hold. Everything in `documents.md` stays valid unless this file changes it.

Out of scope (this slice): Word/PDF import, images other than the company logo (no signature/stamp images, no free
images), salary/RIB/NSS placeholders, conditional logic beyond « print only when known », headers/footers per page
other than the company footer, multi-employee (bulk) issuing, templates per unit or region, e-mails.

## ⚠ Assumptions to confirm with the owner

| # | Assumption | Default in this contract | Where it lives |
|---|---|---|---|
| 1 | Built-in templates stay | A system type (attestation, certificat, titre) uses its **built-in template** (code, `…@2`) until a company publishes its own; « Revenir au modèle intégré » goes back. The designer can start from a **copy of the built-in wording** (a designer version of each built-in) | `document_type.template_mode` |
| 2 | What a new type is about | A custom type is issued **for one employee** (`subject = employment`, rule: any / active only / ended only) or **for one approved leave request** (`subject = leave_request`) | `document_type.subject`, `employment_rule` |
| 3 | Fields typed at issue time | A template may declare up to **10 fields** HR fills in when issuing (text ≤ 500, long text ≤ 2 000, date, number, choice among ≤ 20 options), each required or optional, labels fr/ar. Values are printed as typed (dates formatted per language) and kept in the register | `document_template_version.fields` |
| 4 | Self-service for new types | A custom type may be **self-service** only when its published template has **no required field** (the employee cannot fill HR's fields) | API rule |
| 5 | No sensitive placeholders | No placeholder for salary, RIB, NSS, NIN, medical data, address or phone of the employee. An « attestation de salaire » waits for a later slice with its own permission | variable catalogue (code) |
| 6 | One template, both languages | A template version holds one layout **per language of the type** (fr and/or ar). The two layouts are edited separately (Arabic is written, not translated automatically); publishing needs every language of the type complete | `document_template_version.layouts` |
| 7 | Limits | Per layout: ≤ 150 blocks, ≤ 20 000 characters of text, tables ≤ 6 columns × 40 rows; the whole version ≤ 256 KB of JSON. A document must fit in **≤ 5 pages** (else 422 at preview/publish) | domain validation |
| 8 | Phones | The designer needs a screen ≥ 900 px wide. On a phone the « Modèles » tab lists templates and opens their PDF preview, without editing | web |
| 9 | Placeholder look | In the designer, placeholders show as chips with a bracketed name in the editing language: `[nom]`, `[matricule]`, `[signature]` / `[الاسم]`, `[رقم التسجيل]`. Typing `[` opens the placeholder list | web |
| 10 | Who issues | Unchanged: `admin_rh_central` and `rh_regional` issue every active type in their scope (custom types included); only central HR voids | seed |

## Concepts

- **Document type** (existing table): gains `kind` (`system` for the three seeded types, `custom` for new ones),
  `subject`, `employment_rule` and `template_mode`.
- **Template version**: an immutable layout once published. A type has at most **one draft** and at most **one
  published** version; publishing a draft archives the previous published version. Version numbers count per type
  (1, 2, 3…), never reused.
- **Template mode** of a type: `builtin` (system types only: the code template) or `designed` (the published version).
  A custom type is always `designed` and cannot be issued before its first publish.
- **Layout**: a JSON document of blocks (below) for one language.
- **Variables** (placeholders): a fixed catalogue in code, keyed by dotted names (`employee.fullName`). Their values
  come from the existing snapshot (`documents.md` › Snapshot), every value formatted by the API.

## Layout model (shared, final)

```ts
type Lang = 'fr' | 'ar';

interface TemplateLayout {                     // one per language
  v: 1;
  page: {
    letterhead: boolean;                       // the company block + document number at the top (as the built-ins)
    footer: boolean;                           // the company footer at the bottom of every page
    fontSize: 'small' | 'normal' | 'large';    // 10.5 / 11.5 / 12.5 pt
    margins: 'narrow' | 'normal' | 'wide';     // 1.6 / 2.2 / 2.8 cm left and right
  };
  blocks: Block[];
}

type Block =
  | { id: string; type: 'title'; align: Align; content: Inline[] }                  // the document title, 17 pt bold
  | { id: string; type: 'heading'; align: Align; content: Inline[] }                // 13 pt bold
  | { id: string; type: 'paragraph'; align: Align; content: Inline[]; when?: VarKey } // `when`: printed only when that variable has a value
  | { id: string; type: 'list'; ordered: boolean; items: Inline[][] }               // ≤ 30 items
  | { id: string; type: 'table'; widths: number[]; headerRow: boolean; borders: boolean; rows: Inline[][][] } // widths: 2–6 relative weights 1–10
  | { id: string; type: 'positions' }          // the certificat's list « <job> du <from> au <to> » (employment subject only)
  | { id: string; type: 'signature'; align: 'start' | 'center' | 'end' }            // « Fait à <city>, le <date> », signatory title, name, space to sign by hand
  | { id: string; type: 'spacer'; size: 'small' | 'medium' | 'large' }              // 0.6 / 1.5 / 3 em
  | { id: string; type: 'divider' }
  | { id: string; type: 'pageBreak' };

type Align = 'start' | 'center' | 'end' | 'justify';   // start/end follow the language direction

type Inline =
  | { t: 'text'; text: string; bold?: true; italic?: true; underline?: true }
  | { t: 'var'; key: VarKey; bold?: true; italic?: true; underline?: true }
  | { t: 'gender'; m: string; f: string; x: string }   // e.g. né / née / né(e), يعمل / تعمل / يعمل(ة): chosen from the employee's sex
  | { t: 'optional'; key: VarKey; content: Inline[] }  // content printed only when `key` has a value (no nesting of `optional`)
  | { t: 'break' };                                    // line break inside a block

type VarKey = string;   // a key of the variable catalogue, or `field.<key>` for a field of the template
```

Validation (pure domain, zod; 422 `errors[]` with a JSON-pointer-like `field`, e.g. `layouts.ar.blocks.3.content.2`):
block ids unique per layout (`^[a-z0-9]{1,16}$`); text runs ≤ 2 000 characters, no control characters except line
breaks (bidi controls removed as in the snapshot); a `var`/`optional`/`when` key must exist in the catalogue **for the
type's subject** (`unknown_variable`) or be a declared field (`unknown_field`); `positions` only for an employment
subject; table rows have exactly `widths.length` cells; limits of assumption 7 (`too_many_blocks`, `text_too_long`,
`table_too_large`, `layout_too_large`). An empty paragraph is allowed (vertical space).

## Variables (catalogue in code, `domain/template-variables.ts`)

Each entry: key, labels fr/ar/en (the chip name, e.g. `nom` / `الاسم` / `name`), group, the subjects it exists for,
and a sample value per language (designer and sample preview). All values are strings already formatted by the API in
the document's language (`documents.md` › Snapshot rules); `null` = unknown (prints nothing, fails `when`/`optional`).

| Group | Keys |
|---|---|
| Document | `document.number`, `document.issueDate` (« 9 octobre 2026 » / « 9 أكتوبر 2026 »), `document.city` (« Fait à » city) |
| Company | `company.legalName`, `company.address`, `company.phone`, `company.email`, `company.nif`, `company.nis`, `company.rc`, `company.ai` |
| Employee (both subjects) | `employee.civility` (M. / Mme / M./Mme; السيد / السيدة / السيد(ة)), `employee.fullName`, `employee.firstName`, `employee.lastName`, `employee.matricule`, `employee.birthDate`, `employee.birthPlace`, `employee.jobTitle`, `employee.unit`, `employee.hireDate`, `employee.endDate` |
| Leave (`leave_request` subject) | `leave.type`, `leave.start` (with « (après-midi) » for a half day), `leave.end`, `leave.days` (« 15 »), `leave.daysText` (« 15 jours » / « 15 يومًا », with the Arabic agreement of `titre_conge@2`), `leave.resumption` |
| Signatory | `signatory.name`, `signatory.title` |
| Fields | `field.<key>` for each field of the template |

`[signature]` is the `signature` block, not a variable: it prints « Fait à … le … », the title (bold), the name and
3.2 em of empty space, as the built-ins do.

Snapshot (`documents.md`) for a designed document: `v: 2`, the existing keys (`type` widens to the type code), plus
`fields: Record<string, string | null>` (formatted values) and `vars: Record<VarKey, string | null>` (every variable
the layout uses, exactly as printed). Built-in documents keep `v: 1` unchanged.

## Data (migration 0022)

| Change | Rules |
|---|---|
| `document_type.code` check | the three system codes **or** custom codes `^[a-z][a-z0-9_]{2,39}$`; a custom code is unique per company like the others and is never one of the system codes |
| `document_type` new columns | `kind text not null default 'system'` (`system`/`custom`), `subject text not null default 'employment'` (`employment`/`leave_request`), `employment_rule text not null default 'any'` (`any`/`active`/`ended`), `template_mode text not null default 'builtin'` (`builtin`/`designed`), `published_template_id uuid null` (FK to the version, composite with `company_id`) | system rows backfilled: attestation `employment/active`, certificat `employment/ended`, titre `leave_request/any`; `kind`, `subject`, `employment_rule` immutable for system types; `template_mode = 'builtin'` only for `kind = 'system'`; `template_mode = 'designed'` ⇔ `published_template_id` not null |
| new `document_template_version` (tenant, audited) | `id`, `company_id`, `document_type_id`, `version int` (≥ 1), `status` (`draft`/`published`/`archived`), `layouts jsonb` (`{fr?: TemplateLayout, ar?: TemplateLayout}`), `fields jsonb` (`TemplateField[]`), `based_on text null` (`builtin:<code>@2` or a version id, informative), `revision int` (optimistic lock, +1 per save), `created_by`, `created_at`, `updated_by`, `updated_at`, `published_by` null, `published_at` null, `note text null` (≤ 300, what changed) | unique (`company_id`, `document_type_id`, `version`); at most one `draft` and one `published` per type (partial unique indexes); **immutable once not `draft`** except `published → archived` (BEFORE UPDATE trigger); no DELETE except of a `draft` (discard) |
| `issued_document` | new `template_version_id uuid null` (FK, composite): set for designed documents; `template_version` text = `<code>.designed@<version>` (e.g. `ordre_mission.designed@3`); the `titre_conge ⇔ leave_request_id` check becomes `subject = leave_request ⇔ leave_request_id not null` via a new `subject text` column backfilled from the type (keeps the check row-local) |
| `issued_document` field values | in `snapshot.fields` (no new column) |
| `document_request` | unchanged (self-service request of any self-service type) |
| Catalogue | permission `document.design` (group `documents`, sort 665) — fr « Concevoir les modèles de documents », ar « تصميم نماذج الوثائق », en « Design document templates »; granted to `admin_rh_central`; added to `security_policy.mfa_required_permissions` of every company that lists `document.configure`, and to the default (two-step sign-in required) |

```ts
interface TemplateField {
  key: string;                         // ^[a-z][a-z0-9_]{0,29}$, unique in the version
  kind: 'text' | 'longText' | 'date' | 'number' | 'choice';
  labels: { fr: string; ar: string };  // 1–80
  required: boolean;
  options?: { value: string; labels: { fr: string; ar: string } }[];  // choice only, 1–20, value ^[a-z0-9_]{1,30}$
}
```

## Rendering

- New fixed file `apps/api/assets/pdf/templates/designed.typ` (imports `letterhead.typ`, reuses `document-page`,
  `letterhead`, `signature`, the long-token rule, fonts, direction and the SPÉCIMEN watermark). It reads a third JSON
  input `sys.inputs.layout`: the **resolved** layout — the same blocks with every inline already turned into
  `{text, bold, italic, underline}` runs (no `var`, `gender`, `optional`, `when` left). It only lays out; it has no
  loops over user-controlled counts other than the blocks/rows/runs (bounded by validation), and no `eval`.
- `resolveLayout(layout, vars, sex) → ResolvedLayout` (pure domain, unit-tested fr/ar): replaces variables by their
  value, picks the gender form, drops `optional` runs and `when` blocks whose variable is null, expands `positions`
  into lines, removes bidi controls. The `PdfRenderer` port gains an optional `layout` input passed as
  `sys.inputs.layout` (template name `designed`); built-in renders are byte-identical to today.
- Page count: after rendering, a document over **5 pages** fails with 422 `document-template-too-long` (preview,
  publish check, issue). The existing 15 s timeout and memory ceiling stay the outer limit (→ 503).
- Determinism and storage unchanged: issued PDFs are stored bytes; a reprint is the same file.

## Issuing (changes to `documents.md` › Issuing rules)

| Subject | Body | Preconditions |
|---|---|---|
| `employment` | `employmentId` | `employment_rule`: `active` → as the attestation (`document-employment-ended`), `ended` → as the certificat (`document-employment-not-ended`), `any` → none |
| `leave_request` | `leaveRequestId` | approved (`document-leave-not-approved`) |

- A type with `template_mode = 'designed'` renders its published version; `builtin` renders the code template as
  today. A custom type without a published version → 409 `document-template-missing`.
- `IssueBody` gains `fields?: Record<string, string>`: unknown keys → 422 `unknown_field`; a missing required field →
  422 `required` on `fields.<key>`; date `YYYY-MM-DD`, number `^-?\d{1,12}([.,]\d{1,4})?$`, choice one of the option
  values, text ≤ 500 / long text ≤ 2 000 (control characters refused) → 422 `invalid_value`. `clientRequestId` replay
  compares the fields too.
- The register (`IssuedDocumentView`) gains `templateVersion: string` and `template: {id, version} | null`; `GET
  /documents/:id` returns the snapshot with `fields`.
- Self-service (`POST /me/documents/requests`) accepts any active `selfService` type; a custom type is self-service
  only when its published version has no required field (assumption 4; `PUT /documents/types/:id` → 422
  `selfService` `required_fields`; publishing a version with a required field on a self-service type → 409
  `document-template-self-service`).

## Endpoints (under `/api`, problem+json)

| Method + path | Guard | Request → response |
|---|---|---|
| `POST /documents/types` | `document.configure` (company) | `{code, names:{fr,ar,en}, subject, employmentRule?, numberFormat, languages, sortOrder?}` → 201 `DocumentTypeView` (`kind: 'custom'`, `active: false` until a version is published, then the admin activates it); 409 `document-type-code-taken`, `document-format-taken` |
| `PUT /documents/types/:id` (existing) | `document.configure` (company) | + `names?` (custom types only), `employmentRule?` (custom only); `active: true` on a custom type without a published version → 409 `document-template-missing` |
| `GET /documents/template-variables?subject=` | `document.design` | `{items: {key, labels, group, sample: {fr, ar}}[]}` for that subject |
| `GET /documents/types/:id/templates` | `document.design` | `{mode, builtin: {version, available: boolean} \| null, items: TemplateVersionSummary[]}` newest first |
| `GET /documents/templates/:id` | `document.design` | `TemplateVersionView` (with `layouts`, `fields`, `revision`) |
| `GET /documents/types/:id/builtin-layout?lang=` | `document.design` | the designer copy of the built-in wording (`TemplateLayout`), system types only, else 404 |
| `POST /documents/types/:id/templates` | `document.design` (company) | `{from: 'blank' \| 'builtin' \| 'published' \| <versionId>}` → 201 new **draft**; 409 `document-template-draft-exists` (one draft per type) |
| `PUT /documents/templates/:id` | `document.design` (company) | `{revision, layouts, fields, note?}` → 200; not a draft → 409 `document-template-not-draft`; stale `revision` → 409 `document-template-changed` (the body has the current `revision` and `updatedBy`); 422 validation |
| `DELETE /documents/templates/:id` | `document.design` (company) | discard a **draft** → 204; else 409 `document-template-not-draft` |
| `POST /documents/templates/:id/preview` | `document.design` | `{lang, sample: true} \| {lang, employmentId \| leaveRequestId, fields?}` → 200 `application/pdf` with the SPÉCIMEN watermark and a specimen number; works on drafts and older versions; a real subject needs `document.issue` over it (else 404). Sample data: a fictitious employee « Amine Benali » / « أمين بن علي » (M), leave of 15 days, field samples from their kind, the company's own letterhead (incomplete letterhead → 409 `document-profile-incomplete` as issuing) |
| `POST /documents/templates/:id/publish` | `document.design` (company) | `{revision}` → 200 `TemplateVersionView`: draft → `published`, the previous published → `archived`, type `template_mode = 'designed'`, `published_template_id` set. Checks: every language of the type has a layout (422 `layouts.<lang>` `required`), the layout renders with sample data within 5 pages (422 `document-template-too-long`, 503 on render failure), self-service rule above |
| `POST /documents/types/:id/templates/builtin` | `document.design` (company) | system types only: `template_mode = 'builtin'`, `published_template_id = null`, the published version → `archived` → 200; custom type → 409 `document-template-no-builtin` |
| `POST /documents/preview`, `POST /documents` (existing) | as before | + `fields`; custom type codes accepted |

```ts
interface TemplateVersionSummary { id: string; version: number; status: 'draft' | 'published' | 'archived';
  languages: ('fr' | 'ar')[]; fieldCount: number; note: string | null;
  updatedAt: string; updatedBy: { id: string; displayName: string } | null;
  publishedAt: string | null; publishedBy: { id: string; displayName: string } | null;
  issuedCount: number }                                       // documents issued with this version
interface TemplateVersionView extends TemplateVersionSummary { typeId: string; typeCode: string;
  layouts: { fr?: TemplateLayout; ar?: TemplateLayout }; fields: TemplateField[]; revision: number; basedOn: string | null;
  _actions: ('edit' | 'publish' | 'discard' | 'duplicate')[] }
// DocumentTypeView gains: kind: 'system' | 'custom'; subject: 'employment' | 'leave_request';
//   employmentRule: 'any' | 'active' | 'ended'; templateMode: 'builtin' | 'designed';
//   template: { id: string; version: number; fields: TemplateField[] } | null   // the published version (fields for the issue form)
```

Scope: every `document.design` write needs the permission over the **whole company** (root unit), else 403
`forbidden-scope`; reads need it anywhere (as `document.configure`). Another company's ids → 404.

## Audit

- Row triggers on `document_template_version` (the diff shows `layouts` and `fields`; nothing is masked) and on the new
  `document_type` columns (existing trigger).
- Events: `document.template_published` `{typeCode, version, previousVersion}`, `document.template_reverted`
  `{typeCode, toBuiltin: true}`. Saving a draft is a row change only.
- Timeline: the template history is the versions list (`GET /documents/types/:id/templates`); no new timeline subject.

## Web

All screens fr/ar/en (`documents.templates.*`, fr/ar parity), RTL. Lazy route; the designer code loads only on its
route.

- **Settings** `/documents/settings`: new tab **Modèles** (with `document.design`): one row per type (system and
  custom): name, kind badge, mode (« Modèle intégré » / « Version n publiée »), a draft badge, actions « Concevoir »,
  « Aperçu » (PDF of the current template with sample data), « Revenir au modèle intégré » (system, designed, confirm
  dialog). « Nouveau type de document » (with `document.configure`): code, names fr/ar/en, subject, employment rule,
  number format (live preview as on the Types tab), languages → then opens the designer. The **Types** tab lists
  custom types too (activate once published).
- **Designer** `/documents/settings/templates/:typeId` (≥ 900 px; narrower → the versions list and previews only, with
  a message):
  - Top bar: type name, version and status, language switch **FR | AR** (the canvas follows the language direction:
    Arabic canvas `dir="rtl"`, Cairo), « Aperçu PDF » (sample or a chosen employee/leave request when the user holds
    `document.issue`), « Enregistrer » (also autosaved 3 s after the last change; shows « Enregistré » / conflict
    banner on 409 with « Recharger »), « Publier » (dialog: optional note; lists what will change), « Abandonner le
    brouillon ». A published or archived version opens read-only with « Créer un brouillon à partir de cette
    version ».
  - Left: **blocks** palette (title, heading, paragraph, list, table, positions, signature, spacer, divider, page
    break), click or drag to insert after the selection; and **page** settings (letterhead, footer, font size,
    margins).
  - Centre: an A4-proportioned **canvas** showing the letterhead and footer as fixed, greyed areas and the blocks in
    order; each block is selectable, movable (drag handle and « Monter / Descendre » buttons, `Alt+↑/↓`), duplicable,
    deletable (`Suppr` with undo). Paragraph-like blocks are edited inline (bold, italic, underline, alignment;
    `Ctrl+B/I/U`); placeholders are non-editable **chips** inserted from the right panel or by typing `[` (filtered
    list, `↑/↓/Entrée`). A chip can be clicked to change its formatting or, for `optional`, its content. The canvas is
    an approximation; the PDF preview is the truth.
  - Right: **Placeholders** (grouped as the catalogue, with the sample value on hover; a search box), **Fields**
    (add/edit/reorder the fields HR fills in: key, kind, labels fr/ar, required, options), and the **selected block**
    properties (alignment, table columns and widths, header row, borders, list kind, `when` condition, gender forms).
  - Undo/redo (`Ctrl+Z` / `Ctrl+Shift+Z`, 100 steps, in memory). Leaving with unsaved changes asks for confirmation.
  - Validation errors from the API (422 `errors[].field`) highlight the block concerned and list the problems in a
    panel.
- **Versions** (drawer in the designer): versions with status, note, who/when, issued count; open read-only,
  duplicate into a new draft, preview.
- **Issue form** `/documents/new`: custom types in the type select; employee or approved-leave picker by `subject`;
  the published template's **fields** rendered as inputs (labels in the UI language, date picker, number, select,
  textarea), mapped from 422 `fields.<key>`.
- **Register / detail**: the template version shown on the detail page; custom field values listed with their labels.
- **My documents**: custom self-service types offered like the attestation.

**Designer package** (owner decision 2026-10-09: in-app, but separable). The editor lives in
`apps/web/src/lib/document-designer/` with one public entry `index.ts`. It knows the layout model, not HRForce: inputs
`layout`, `fields`, `variables` (catalogue items), `lang`, `subject`, `readonly`; outputs `layoutChange`,
`fieldsChange`, `previewRequested`. It imports nothing from `apps/web/src/app/**` (no API client, session, Transloco
service: its texts come in through an `labels` input or a small injection token with fr/ar/en defaults), so it can move
to its own app later. A unit test fails on any import from `app/`. The HRForce page
(`features/documents/templates/…`) loads and saves versions, handles 409/422 and hosts the component.

Rich-text editing inside blocks: the builder may use **ProseMirror** (`prosemirror-model`, `-state`, `-view`,
`-commands`, `-keymap`, `-history`; MIT; bundled, no CDN) with a schema limited to the inline model above (marks bold /
italic / underline; atom nodes for `var`, `gender`, `optional`; hard break). Any other dependency needs the lead's
agreement. The editor must work in RTL (caret, selection, chips) — verified in the browser in Arabic.

## Seed (`seed:dev`)

DEMO: a custom type **« Ordre de mission » / « أمر بمهمة »** (`ordre_mission`, employment/active, `OM-{YYYY}-{SEQ:4}`,
fr+ar) with a published version 1 (fields: destination (text, required), objet (long text, required), date de départ
and date de retour (date, required), moyen de transport (choice: véhicule de service, transport public, avion)); the
attestation de travail with a published designed version 1 (a copy of the built-in with a changed closing sentence)
and a draft version 2; the certificat and titre stay built-in. BETA: nothing.

## Authorization matrix rows (expected)

| Route | Rows |
|---|---|
| `GET /documents/template-variables`, `GET /documents/types/:id/templates`, `GET /documents/templates/:id`, `GET /documents/types/:id/builtin-layout` | CONFIG_ROWS(200) with `document.design` (admin, beta ✓; est, ouest, acces, agent 403); beta on company A's ids → 404 |
| `POST /documents/types/:id/templates`, `PUT/DELETE /documents/templates/:id`, `POST /documents/templates/:id/publish`, `POST /documents/types/:id/templates/builtin`, `POST /documents/types` | CONFIG_ROWS on the caller's own company (201/200/204); est, ouest, acces, agent 403; beta on A's ids 404 |
| `POST /documents/templates/:id/preview` | admin 200 (sample and est/ouest subjects), beta 200 on its own, est 403, agent 403; admin with BETA's employee → 404 |
| anonymous | 401 on every route above |

Plus e2e: one draft per type (concurrent creates → one 201, one 409); stale revision → 409; publish archives the
previous version and later issues use the new one, earlier documents keep their bytes and `template_version`; revert
to built-in; a custom type is not issuable before publish; required/invalid fields; gap-free numbering for a custom
type; self-service rule; a layout that would exceed 5 pages → 422; the audit exit criterion covers the new writes;
a template whose texts contain Typst markup (`#panic("x")`, `$x$`, `*b*`, `#read("/etc/passwd")`) prints literally.

## Tests the build must add

- Domain: layout validation (every rule and limit), `resolveLayout` (variables, gender, optional, when, positions,
  bidi controls, fr/ar), field value validation and formatting, Arabic `leave.daysText`.
- Renderer: `designed.typ` renders a layout using every block type in fr and ar; a designer copy of each built-in,
  rendered with the same snapshot, prints the **same text** as the built-in (pdf.js text extraction; layout may differ
  slightly); long tokens stay within the margins (as `document-templates.spec.ts`).
- Web: designer unit tests (block operations, undo/redo, chip insertion, serialisation round trip to the layout model,
  409 conflict banner, 422 highlighting), issue form fields; browser check fr and ar at 1280 px (designer) and 390 px
  (lists, issue form with fields).

## Settled by the build (2026-10-09)

**API**
- `POST /documents/templates/:id/publish` takes `{revision, note?}`; the note is stored on the version.
- `POST /documents/types/:id/templates/builtin` answers 200 with the updated `DocumentTypeView`; a second call changes
  nothing and records no event. `document.template_reverted` also carries `previousVersion`. Both events use the audit
  subject type `document_template_version`.
- `POST /documents/types`: `employmentRule` defaults to `any` (a leave type with another rule → 422 `not_allowed`);
  a system code → 409 `document-type-code-taken`; `sortOrder` defaults to the highest existing value + 10.
- `PUT /documents/types/:id`: `selfService` for the attestation and custom employment types only; adding a language the
  published version has no layout for → 422 `languages` `template_language_missing`; `names` / `employmentRule` on a
  system type → 422 `not_allowed`.
- Unknown `typeCode` at issue, preview or self-service request → 422 `typeCode` `not_found`. `fields` sent to a
  built-in type → 422 `fields.<key>` `unknown_field`. A language without a layout → 409 `document-template-missing`
  at preview and issue.
- Snapshot `v: 2` also stores `fieldValues` (the values as typed, cleaned), which the `clientRequestId` replay compares.
  A number typed with a comma is stored with a dot and printed with a comma in French; a choice prints its label; long
  text keeps its line breaks.
- Validation codes beyond those named above: `invalid`, `invalid_id`, `duplicate_id`, `invalid_text`, `empty_gender`,
  `too_many_items`, `invalid_width`, `invalid_row`, `positions_not_allowed`, `not_allowed` (a layout for a language
  the type does not have), `too_many_fields`, `invalid_key`, `duplicate_key`, `invalid_label`, `invalid_options`,
  `duplicate_value`. The 256 KB limit is measured on `JSON.stringify({layouts, fields})` → 422 `layouts`
  `layout_too_large`. Bidi control characters are removed from template text on save.
- `basedOn` is `blank`, `builtin:<code>@2` or a version id. `_actions` are empty without company-wide
  `document.design`; `duplicate` only when the type has no draft.
- Preview: fields left out take sample values; the sample signatory is fictitious (« Farid Belkacem »); a subject the
  caller cannot read → 404, readable without `document.issue` → 403 `forbidden-scope`. The publish check uses a sample
  letterhead when the company's is incomplete (the preview still answers 409 `document-profile-incomplete`).
- Variable groups are exactly `document`, `company`, `employee`, `leave`, `signatory`.
- The render worker reports Typst diagnostics on a failed compile (it compiles once more to read them).
- The designer copy of the titre uses a 40/60 table (the built-in is 38/62).

**Web**
- Five ProseMirror packages (no `prosemirror-history`): the designer keeps one undo stack for the whole layout.
- The designer package's own texts are its fr/ar/en defaults (`labels` input / `DESIGNER_LABELS` token), not Transloco
  keys.
- `/documents/settings` opens with `document.configure` or `document.design`; « Modèles » needs `document.design`, the
  other tabs `document.configure`.
- « Aperçu » on the Modèles tab exists for a designed template only (no sample preview of a built-in).
- A draft language without a layout offers « Page vierge » and, for system types, « Texte du modèle intégré ».
- Below 900 px a mounted designer is hidden, not destroyed (a window resize keeps the undo history); a phone never
  loads it.
- A notification about a custom type names it « Document ». The timeline shows a custom type's code, not its name.
- Bundle: initial 425.63 → 425.81 kB; the designer is one lazy chunk of 314 kB (80 kB transferred).

## Settled by the verification (2026-10-09)

Independent verification: full gate, the app driven in Chromium (fr and ar, 1280 px and 390 px), security probes
through the API. Behaviour it settled or changed:

- **Publishing needs content in every language.** A blank draft starts with an empty layout per language; a language
  whose layout has no block is refused at publish with 422 `layouts.<lang>` `empty` (a missing layout stays
  `required`). Before, the Arabic side of a type could be published empty and issued as a numbered blank page.
- **Positions of someone still employed.** In a designed layout the `positions` block of an employee without an end
  date closes the position held today at the **date of the document** (« Chargé de clientèle du 1er avril 2022 au
  9 octobre 2026 »). It printed the start date twice. The certificat is unchanged (always issued after the end date).
  Wording to confirm with the owner (« depuis le … » may read better).
- **Field keys are own keys.** A field called `constructor` can be left empty (the value lookup read the inherited
  object property and answered 422 `invalid_value`).
- **Validation messages follow the UI language.** The designer's problems panel shows a message per `errors[].code`
  (`documents.templates.codes.*`, fr/ar/en); an unknown code keeps the API's English text. The path
  (`layouts.fr.blocks.3…`) is still shown as is.
- **Self-service is offered for custom employee documents only** (web): the API refuses it for a custom leave
  document (`selfService` `not_allowed`), and a custom type with a required field does not show the switch at all.
- **Document page:** field values are listed in the order of the template's fields (the snapshot has its own key
  order), a long text keeps its line breaks, and the template code (`ordre_mission.designed@1`) wraps at 390 px.
- **Settled as built (checked, not changed):**
  - a custom type is `template_mode = 'designed'` from its creation, with no published version until the first
    publish (the Data table's « designed ⇔ published version » holds for system types);
  - `document.design` was appended to the two-step list of **every** existing company policy, not only those listing
    `document.configure` (which the default list never contained);
  - the 409 `document-template-changed` body carries `revision`, `updatedBy` (a user id) and `updatedAt` as RFC 9457
    extension members;
  - request bodies up to 600 KB are accepted under `/api/documents/templates/*` only (100 KB everywhere else, 413);
  - the 5-page cap is a panic of `designed.typ` after layout, mapped to 422 `document-template-too-long` at preview,
    publish and issue (an issue refused this way uses no number);
  - italic text prints with Source Sans 3 Italic / Bold Italic (two vendored font files); Cairo has no italic, so
    italic Arabic prints upright;
  - built-in templates render byte-identical to the commit before the slice (the six seeded documents, as issued
    and as specimen, rendered with both trees: same SHA-256);
  - undo groups typing in one text into one step until a pause of 1 s; fields are not part of the undo history;
  - after « Recharger » on a conflict the editing language returns to the UI language.
- **Known gaps left open:**
  - the employee picker lists active employees only: the designer's « un employé » preview cannot use someone whose
    employment has ended (certificat, custom « ended » types; the API accepts it), and such documents are issued from
    the employee's Documents tab as before; a leave-request subject has no real-data preview in the designer;
  - the document page labels field values with the type's **current** published fields: a field renamed or removed
    by a later version shows its key on older documents;
  - on a phone the « Modèles » list still names its link « Concevoir » (it opens the versions and previews with the
    900 px message) and offers « Revenir au modèle intégré » and « Nouveau type de document »;
  - the toolbar of a selected block overlaps the block above by a pixel; an `optional` chip's content is edited in
    the side panel; the canvas justifies short lines around chips more loosely than the PDF.

## Settled by cleanup round 3 (2026-10-18)

- The designer's « un employé » preview searches ended employments too (`GET /employees?status=`), and a leave-subject type previews with one of the chosen employee's **approved** leave requests (`leaveRequestId`); changing the employee clears the chosen request. `/documents/new` lists ended employments unless the type's employment rule is `active`.
- Below 900 px the « Modèles » tab names its link « Versions et aperçus » and hides « Nouveau type de document »; « Revenir au modèle intégré » stays (it works on phones).
- The timeline names custom document types (the web resolves `type_code` from the type list) and hides the bare `subject` and `template_version_id` columns of `issued_document`.
