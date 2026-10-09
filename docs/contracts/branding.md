# Contract — Branding settings: app title, welcome text, logos, brand colour, sign-in message, footer

Binding contract between `apps/api` (new module `branding`, one addition to `GET /api/me`) and `apps/web` (root
`BrandingService`, shell, sign-in page, dashboard, a new settings section). Owner decision 2026-10-08
(`docs/HANDOFF.md`): a separate settings section; **per company, plus an installation-wide default** used before
sign-in, set by central admins of the owning company; permission `settings.branding` (`admin_rh_central` only,
company-wide writes, two-step sign-in, every change audited).

The API and the web are built in parallel from this file. Everything under **API** is the API builder's; everything
under **Web** is the web builder's; the shapes in **Views** are shared and final. No ADR: the slice adds no
infrastructure, no dependency, no environment variable, and leaves the CSP and the proxy configuration untouched; it
reuses decisions already recorded (ADR 004 cookies/XSRF/CSP, ADR 005 Postgres only, ADR 008 logo limits). The one new
notion, the *owning company*, is data in one table and is described here.

Out of scope (unchanged in this slice): the favicon, the installable-app icons and `manifest.webmanifest` (static
files: name stays « HRForce »), the PDF letterhead and its logo (`company_profile`, `documents.md`), e-mails (still
signed « HRForce »), the OpenID Connect provider's own HTML pages under `/oidc`, `apps/sso-demo`, dark mode.

## ⚠ Assumptions to confirm with the owner

| # | Assumption | Default in this contract | Where it lives |
|---|---|---|---|
| 1 | Two levels with inheritance | The **installation default** holds: app title, app logo, brand colour, sign-in message, footer. A **company** holds: app title, app logo, brand colour, footer, welcome title, welcome message, company logo. A company field left empty **inherits** the installation default, then the built-in value. With one company, the admin fills the installation tab and the company follows | `installation_branding`, `company_branding` |
| 2 | Owning company | The company that owns the single `installation_branding` row: the **oldest company** at migration time, else the first one created by `bootstrap` / `seed:dev`. Moved only by an operator (`branding:owner` CLI). No environment variable | `installation_branding.company_id` |
| 3 | One rule for which branding shows | **Signed in → the session's company (with inheritance); not signed in → the installation default.** So `/login`, the password pages, `/punch` and `/kiosk` without a session and the SSO handoff before sign-in show the default; the SSO handoff of an already signed-in user shows that user's company | web `BrandingService` |
| 4 | Kiosk | The entrance kiosk only follows the default **brand colour**; no logo, no footer, no layout change (the device has no user session; per-company kiosk branding later if wanted) | web |
| 5 | Palette | Ten named colours (below), **no red** (red stays the colour of errors and destructive buttons). A bordeaux `#7d1f3f` (9.81:1) can be added on request | code + `styles.css` |
| 6 | Plain text, no links | Every text is shown as plain text. E-mail addresses and phone numbers in the footer or the sign-in message are **not** turned into links | web |
| 7 | Lengths | App title 40, welcome title 80, welcome message 500, sign-in message 500, footer 200 characters. French is required as soon as a field has any language | API validation + DB checks |
| 8 | No variables | Welcome texts are fixed (no « Bienvenue, {prénom} ») | — |
| 9 | Logos | PNG or JPEG, ≤ 256 KB, ≤ 4 000 px per side and ≤ 16 MP (same as the letterhead logo). **SVG, GIF, WebP, ICO refused.** Stored and served as uploaded (no re-encoding: an image keeps its metadata) | API |
| 10 | Letterhead logo stays separate | Two one-click copies in the branding page for users who also hold `document.configure`: « reprendre le logo de l'en-tête » and « utiliser ce logo pour l'en-tête des documents » (done by the browser through the existing endpoints) | web |
| 11 | Logos are not secret | The default app logo is public (sign-in page). A company's logos need a session of that company | API |
| 12 | Browser tab, installed app | The tab title follows the app title. The installed-app name, its icons and the favicon stay « HRForce » | web |
| 13 | No history screen | Changes are in the audit trail (who, when, before/after, logos masked) but the branding page has no History tab, like the letterhead | — |
| 14 | Demo data | DEMO owns the installation default: a sample footer and sign-in message, colour unchanged, no app logo; DEMO's dashboard shows a sample welcome message and the generated demo logo as company logo | `seed:dev` |

## Palette (final)

Contrast ratios are WCAG 2.x relative-luminance ratios, computed from the hex values. Every colour is used both as a
background under white text (header, primary buttons) and as text / border colour on the app's three light surfaces.
`--color-on-primary` is `#ffffff` for all of them. Required: ≥ 4.5:1 in all four columns.

| Code | fr | ar | en | Hex | White text on it | On `#ffffff` | On `#f6f8fa` (surface-alt) | On `#eaeef2` (hover) |
|---|---|---|---|---|---|---|---|---|
| `blue` (default) | Bleu HRForce | أزرق | Blue | `#1f4e79` | 8.66 | 8.66 | 8.14 | 7.43 |
| `navy` | Bleu marine | أزرق داكن | Navy | `#1b3358` | 12.64 | 12.64 | 11.88 | 10.84 |
| `azure` | Bleu azur | أزرق سماوي | Azure | `#0f5fa8` | 6.52 | 6.52 | 6.12 | 5.59 |
| `teal` | Bleu canard | أزرق مخضر | Teal | `#0b6470` | 6.84 | 6.84 | 6.42 | 5.86 |
| `green` | Vert | أخضر | Green | `#1e6b3a` | 6.52 | 6.52 | 6.13 | 5.59 |
| `olive` | Olive | زيتوني | Olive | `#55610f` | 6.77 | 6.77 | 6.36 | 5.80 |
| `brown` | Brun | بني | Brown | `#7a4a12` | 7.46 | 7.46 | 7.01 | 6.40 |
| `plum` | Prune | أرجواني | Plum | `#6d2c6b` | 9.45 | 9.45 | 8.87 | 8.10 |
| `indigo` | Indigo | نيلي | Indigo | `#453c9c` | 8.83 | 8.83 | 8.29 | 7.57 |
| `slate` | Ardoise | رمادي أردوازي | Slate | `#3f4b5c` | 8.85 | 8.85 | 8.32 | 7.59 |

The codes are the stored values (`BrandColor`). The hex values live **only** in `apps/web/src/styles.css`; the API
never sends a hex value and the web never builds a colour from server data.

## Views (shared, final)

```ts
type BrandColor = 'blue' | 'navy' | 'azure' | 'teal' | 'green' | 'olive' | 'brown' | 'plum' | 'indigo' | 'slate';
/** One text in three languages. Rule: `fr` is non-null whenever `ar` or `en` is. All null = "not set". */
interface Lang3 { fr: string | null; ar: string | null; en: string | null }
/** `url` is same-origin, starts with `/api/branding/`, and changes whenever the image changes. */
interface LogoRef { url: string; width: number; height: number }
interface LogoView extends LogoRef { mime: 'image/png' | 'image/jpeg'; sizeBytes: number }

/** GET /api/branding/default (public): the installation default, raw. All null + 'blue' when nothing is set. */
interface PublicBranding { appTitle: Lang3; signInMessage: Lang3; footer: Lang3; color: BrandColor; appLogo: LogoRef | null }

/** GET /api/me → `branding`: the caller's company AFTER inheritance (levels resolved by the API, language by the web). */
interface EffectiveBranding {
  appTitle: Lang3; welcomeTitle: Lang3; welcomeMessage: Lang3; footer: Lang3;
  color: BrandColor; appLogo: LogoRef | null; companyLogo: LogoRef | null;
}

/** Admin: what is stored for the company (null = inherit / built-in). */
interface CompanyBrandingView {
  appTitle: Lang3; welcomeTitle: Lang3; welcomeMessage: Lang3; footer: Lang3;
  color: BrandColor | null; appLogo: LogoView | null; companyLogo: LogoView | null; updatedAt: string | null;
}
/** Admin: the installation default as stored. */
interface InstallationBrandingView {
  appTitle: Lang3; signInMessage: Lang3; footer: Lang3; color: BrandColor; appLogo: LogoView | null; updatedAt: string | null;
}
interface BrandingSettingsView {
  company: CompanyBrandingView;
  /** null when the caller's company is not the owning company (the web then hides the installation tab). */
  installation: InstallationBrandingView | null;
  /** What an empty company field falls back to (= the installation default; the web shows it as "Par défaut : …"). */
  inherited: { appTitle: Lang3; footer: Lang3; color: BrandColor; appLogo: LogoRef | null };
  palette: BrandColor[];                               // the ten codes, in the order of the table above
  limits: { appTitle: 40; welcomeTitle: 80; welcomeMessage: 500; signInMessage: 500; footer: 200; logoMaxBytes: 262144 };
}
```

No key of any view matches `/(password|hash|token|secret)/i` (guardrail): the image digest only appears inside `url`.

**Inheritance (API, one pure domain function, unit-tested).** For `appTitle` and `footer`: the company's `Lang3` when
its `fr` is non-null, else the installation's `Lang3` (whole triple, never mixed per language). `color`: company, else
installation. `appLogo`: company, else installation. `welcomeTitle`, `welcomeMessage`, `companyLogo`: the company's
only. `signInMessage`: installation only (it is never shown after sign-in).

**Language and built-in fallback (web, one pure function, unit-tested).** `resolve(lang3, activeLang)` → the active
language's text, else `fr`, else `null`; on `null` the web uses its own i18n text: `app.title` (« HRForce »),
`home.title`, `home.intro`; no footer and no sign-in message are shown when `null`. The function also returns which
language the text is in (for the `lang` attribute).

## API

### Data (migration `0021_branding.sql`)

Both tables are tenant tables: `company_id` + RLS/FORCE + the standard policy, the audit trigger
`audit.capture('company_id')`, logo bytes masked (`audit.masked_column`). No guardrail exemption is needed.

| Table | Columns | Rules |
|---|---|---|
| `company_branding` (pk `company_id` → `company`) | `app_title_fr/ar/en`, `welcome_title_fr/ar/en`, `welcome_message_fr/ar/en`, `footer_fr/ar/en` (text null), `color text` null, `app_logo bytea` null, `app_logo_mime`, `app_logo_sha256 bytea`, `app_logo_width int`, `app_logo_height int`, `company_logo bytea` null, `company_logo_mime`, `company_logo_sha256`, `company_logo_width`, `company_logo_height`, `updated_at timestamptz not null default now()`, `updated_by uuid` null | created on the first write (upsert); `hrforce_app`: select, insert, update, **no delete** (reset = nulls) |
| `installation_branding` (pk `singleton boolean default true check (singleton)`; `company_id uuid not null unique` → `company` = **the owning company**) | `app_title_fr/ar/en`, `sign_in_message_fr/ar/en`, `footer_fr/ar/en`, `color text not null default 'blue'`, `app_logo`, `app_logo_mime`, `app_logo_sha256`, `app_logo_width`, `app_logo_height`, `updated_at`, `updated_by` | at most one row in the database. `hrforce_app`: **select and update only** (revoke insert/delete; column-level `grant update` on every column except `singleton` and `company_id`), so the app can neither create the row nor move ownership |

Checks on both tables:
- lengths by `char_length`: title ≤ 40, welcome title ≤ 80, welcome / sign-in message ≤ 500, footer ≤ 200; no empty
  string (`<> ''`); `fr` not null when `ar` or `en` is not null (one check per field);
- `color in ('blue','navy','azure','teal','green','olive','brown','plum','indigo','slate')` (or null on
  `company_branding`);
- per logo: the five columns are all null or all set; `octet_length(logo) between 1 and 262144`;
  `mime in ('image/png','image/jpeg')`; `octet_length(sha256) = 32`; width and height between 1 and 4000 and
  `width::bigint * height <= 16000000`.

`audit.masked_column`: (`company_branding`,`app_logo`), (`company_branding`,`company_logo`),
(`installation_branding`,`app_logo`). The digests, MIME types and sizes stay readable in the diff.

**Reads before a tenant is known** — two `SECURITY DEFINER` functions owned by the migrator (pinned
`search_path = pg_catalog, public`, `revoke all … from public`, `grant execute … to hrforce_app`), modelled on
`attendance_pairing_lookup`:
- `public.branding_installation_default()` → 0 or 1 row: the nine text columns, `color`, `app_logo_mime`,
  `app_logo_sha256`, `app_logo_width`, `app_logo_height`. **Not** `company_id`, not the bytes, not `updated_by`.
- `public.branding_installation_logo(p_sha256 bytea)` → 0 or 1 row (`bytes bytea`, `mime text`), only when
  `p_sha256` equals the stored digest.

Every read of the installation level other than the admin view goes through the first function (a non-owning
company's session cannot see the row through RLS). "Is the caller's company the owner?" = the row is visible under
RLS in the request transaction.

**Owning company.**
- Migration: `insert into installation_branding (company_id) select id from company order by created_at, code limit 1`
  (no row on an empty database).
- New helper `seedBrandingDefaults(tx, companyId)` exported from `modules/branding/index.ts`, called by
  `bootstrapCompany` and `seed:dev` (and the test fixtures) after the company exists: inserts the installation row
  for that company **only when none exists**. So the first company created is the owner.
- No row at all (should not happen after bootstrap): the public endpoint answers the built-in default, nobody sees
  the installation tab.
- Operator CLI: `npm run branding:owner -w @hrforce/api -- --company <code>` (migrator role, like `bootstrap`):
  creates the row for that company or moves the existing row (its content is kept) and prints the previous and the
  new owner. Unknown code → non-zero exit.

**Permission** (migration + `PERMISSION_CODES` + `SYSTEM_ROLES`): the group check gains `'settings'`.

| Code | fr | ar | en | Group, sort | Granted to |
|---|---|---|---|---|---|
| `settings.branding` | Personnaliser l'identité visuelle (titre, logos, couleur, messages) | تخصيص الهوية البصرية (العنوان، الشعارات، اللون، الرسائل) | Customise branding (title, logos, colour, messages) | `settings`, 1010, not sensitive | `admin_rh_central` only (existing companies by the migration; new ones through `SYSTEM_ROLES`) |

Two-step sign-in: `security_policy_default_permissions()` is replaced with `'settings.branding'` added to its list,
and existing `security_policy` rows get it appended once (as `sso.manage_apps` in 0018). DEMO keeps enforcement off.

### Text rules (pure domain function `cleanBrandingText`, applied before validation and storage)

1. Unicode NFC. `\r\n` and `\r` → `\n`; tab → space.
2. Removed: C0 and C1 control characters and DEL (except `\n` in the two multi-line fields), U+200B, U+FEFF, the
   bidi marks and controls U+200E, U+200F, U+061C, U+202A–U+202E, U+2066–U+2069. U+200C / U+200D are kept (Arabic
   script shaping).
3. Single-line fields (app title, welcome title, footer): `\n` → space. Multi-line fields (welcome message, sign-in
   message): three or more `\n` → two; at most 6 lines.
4. Runs of spaces → one; trim; empty → `null`.
5. Length in Unicode code points, after the steps above.

Characters such as `<`, `>`, `&`, `"` are **kept and stored as typed**: nothing is HTML-escaped at rest and nothing is
ever interpreted as HTML or Markdown (the web renders by interpolation only).

Validation errors → 422 `errors[{field, code}]` with `field` = `<name>.<lang>` (e.g. `appTitle.ar`) or `color`:
`too_long`, `too_many_lines`, `fr_required` (on `<name>.fr`), `invalid_color`, plus the validator's own codes for a
wrong type or a missing key. Bodies are strict: unknown keys → 422.

### Endpoints (under `/api`, controller `branding`, problem+json)

| Method + path | Guard | Body → result |
|---|---|---|
| `GET /branding/default` | `@Public` | → 200 `PublicBranding`. `Cache-Control: no-cache`, strong `ETag` over the body; `If-None-Match` → 304. Sets no cookie, writes nothing |
| `GET /branding/default/logo/:digest` | `@Public` | the installation app logo when `:digest` (64 lower-case hex) equals its SHA-256, else **404**. Image headers below, `Cache-Control: public, max-age=31536000, immutable` |
| `GET /branding/logos/:kind/:digest` | `@Authenticated` + `@AllowWithoutMfa` | `kind` = `app` \| `company`: that logo **of the caller's company** when the digest matches, else **404** (also for another company's digest). `Cache-Control: private, max-age=31536000, immutable` |
| `GET /branding/settings` | `settings.branding` | → 200 `BrandingSettingsView` |
| `PUT /branding/company` | `settings.branding` (company-wide) | `{appTitle, welcomeTitle, welcomeMessage, footer: Lang3, color: BrandColor \| null}` (all five keys required; full replacement) → 200 `BrandingSettingsView` |
| `DELETE /branding/company` | same | reset: every text, the colour and both logos → null. **204** (also when nothing was set) |
| `PUT /branding/company/logos/:kind` | same | `multipart/form-data`, field `file` → 200 `BrandingSettingsView`; 422 on `file`: `required`, `too_large`, `unsupported_type`, `dimensions_too_large` |
| `DELETE /branding/company/logos/:kind` | same | **204** (also when there is none) |
| `PUT /branding/installation` | `settings.branding` (company-wide) **and** owning company | `{appTitle, signInMessage, footer: Lang3, color: BrandColor}` → 200 `BrandingSettingsView` |
| `DELETE /branding/installation` | same | reset: texts and logo → null, colour → `blue`; the row and its owner stay. **204** |
| `PUT /branding/installation/logo` | same | as the company logo upload → 200 |
| `DELETE /branding/installation/logo` | same | **204** |
| `GET /me` (Identity) | unchanged | gains `branding: EffectiveBranding` (always present) |

Order of checks on the writes: permission held anywhere (else **403**, guard) → held over the whole company
(`ScopeService.coversCompany`, else **403** `forbidden-scope`, as `PUT /documents/settings/profile`) → for the
`installation` routes, the caller's company is the owner (else **404**; a non-owner learns nothing about who owns
it) → validation (422). Unknown `:kind` → 404. Malformed `:digest` → 404. All unsafe methods need the session-bound
XSRF token (platform rule). Last write wins (no version check).

**Logo upload** (same rules and codes as `PUT /documents/settings/profile/logo`): multer in memory, one `file` field,
limit 256 KB + 1 byte turned into 422 `too_large`; empty or missing → `required`; type and pixel size from
`readImageHeader` / `withinImageLimits` (`platform/pdf/image-header.ts`, never decoded) → `unsupported_type` /
`dimensions_too_large`. The declared `Content-Type` and the file name are ignored. SVG, HTML, GIF, WebP, ICO and a
truncated PNG/JPEG are all `unsupported_type`. Stored: bytes, sniffed MIME, SHA-256, width, height.

**Logo URLs** (built by the API, the web never builds them): installation logo
`/api/branding/default/logo/<sha256 hex>`; company logos `/api/branding/logos/app/<hex>` and
`/api/branding/logos/company/<hex>`. An inherited app logo in `EffectiveBranding` / `inherited` carries the
`default` URL. After a replacement or a deletion the old URL answers 404.

**Image responses**: `Content-Type` = the stored (sniffed) MIME, `Content-Length`, `ETag: "<hex>"`,
`X-Content-Type-Options: nosniff`, `Content-Disposition: inline; filename="logo.png"` (or `.jpg`), the
`Cache-Control` of the table. They work in `<img src>` under the existing CSP (`img-src 'self' data:`) and
`Cross-Origin-Resource-Policy: same-origin`; the session cookie `hrf_at` (`Path=/api`) travels with same-origin image
requests.

**Public endpoints — what they give away and why there is no throttle.** `GET /branding/default` returns only what
the sign-in page prints: no company id, code or name (unless the admin typed one into a text), no user, no counts,
nothing about other companies, and the same answer for every caller. The logo route answers for exactly one digest.
Each request is one primary-key read through a definer function (a few kilobytes), conditional requests answer 304
and the image is cached for a year, so, as for `GET /auth/csrf`, no rate limit is added. Neither route opens the
attack surface of a write: no XSRF exemption, no cookie.

**`GET /me`.** `MeService` calls `BrandingService.effective()` (exported from `modules/branding/index.ts`; the
module imports only `platform/**`, so no cycle): one select of the company row **without the image bytes** plus
`branding_installation_default()`. The route stays in `mfa-exempt.json` as it is; add
`GET /api/branding/logos/:kind/:digest` to that file (reason: the shell shows the logos on the two-step enrolment
page).

### Audit

Row triggers only (no application event): every `PUT`/`DELETE` above that changes something writes a
`audit.change_log` row with the actor, the request id and the before/after of the changed columns; the image bytes
are `***`, the digest, MIME and dimensions are readable. A write that changes nothing (same values, deleting a logo
that is not there, resetting an empty row) writes no audit row and still answers 200 / 204; the audit exit-criterion
test must therefore arrange a real change for each of the eight write routes. `updated_at` / `updated_by` are set
only when another column changes.

### Seed (`seed:dev`)

DEMO is created first, so it owns the installation default. Installation: `footer` = « Groupe Démo — assistance :
support@demo.dz » / « مجموعة ديمو — الدعم: support@demo.dz » / "Groupe Démo — support: support@demo.dz";
`signInMessage` = « Environnement de démonstration : données fictives. » / « بيئة تجريبية: بيانات غير حقيقية. » /
"Demonstration environment: fictitious data."; title null, colour `blue`, no logo. DEMO company: `welcomeMessage` =
« Retrouvez ici vos tâches, vos congés et votre pointage. » / « تجدون هنا المهام والعطل وتسجيل الحضور. » / "Your
tasks, leave and attendance in one place."; `companyLogo` = the generated demo PNG already used for the letterhead.
BETA (test fixture): no branding row.

### Authorization matrix rows (expected)

Actors as in `authorization-matrix.e2e-spec.ts`; company A (DEMO fixture) is the owner, `beta` is the central admin
of the other company.

| Route | Rows |
|---|---|
| `GET /branding/settings`, `PUT /branding/company`, `PUT /branding/company/logos/:kind` | `CONFIG_ROWS(200)` |
| `DELETE /branding/company`, `DELETE /branding/company/logos/:kind` | `CONFIG_ROWS(204)` |
| `PUT /branding/installation`, `PUT /branding/installation/logo` | admin 200; est, ouest, acces 403; **beta 404** |
| `DELETE /branding/installation`, `DELETE /branding/installation/logo` | admin 204; est, ouest, acces 403; **beta 404** |
| `GET /branding/logos/:kind/:digest` (digest of A's logo) | every signed-in actor of company A 200 (agent and chef included); beta 404; anonymous 401 |
| `GET /branding/default`, `GET /branding/default/logo/:digest` | public: listed the way the matrix lists `@Public` routes (200 for everyone, anonymous included) |

### API tests (required)

- Domain: `cleanBrandingText` (controls, bidi, NFC, newlines, limits in code points, Arabic text untouched,
  `<script>` kept verbatim); the inheritance function (every combination of company / installation / nothing).
- Public endpoint: on a database with two branded companies, the anonymous body equals exactly the `PublicBranding`
  of the installation row (deep equality on the key set: no extra key), contains no uuid and no company code or
  name; the same body with and without a session of either company; `ETag` + 304; no `Set-Cookie`; a non-owner
  company's digest on `/branding/default/logo/…` → 404; the public logo route never serves a company logo.
- Company isolation: beta with A's digest → 404; RLS: a session of B cannot read or update
  `installation_branding` or A's `company_branding` (direct SQL as `hrforce_app`); `hrforce_app` cannot insert or
  delete in `installation_branding` nor update its `company_id`.
- Uploads refused with the right code: an SVG (`<svg onload=…>`), an HTML file, a GIF, a PNG signature followed by
  garbage, a 257 KB PNG, a small PNG declaring 45 000 × 45 000 px, an SVG sent as `image/png` named `logo.png`.
  Accepted: PNG and JPEG within the limits; the response `Content-Type` is the sniffed one and `nosniff` is set.
- Text is data: `appTitle.fr = "<img src=x onerror=alert(1)>"` is stored and returned byte for byte in JSON
  (`application/json`), never in an HTML response; a title of 41 characters → 422 `too_long`; `ar` without `fr` →
  422 `fr_required`; a bidi override is stripped; an unknown colour → 422 `invalid_color`.
- Permissions: the matrix rows; a custom role holding `settings.branding` on a region reads the settings and gets
  403 `forbidden-scope` on every write; two-step sign-in is required for a holder when the policy is enforced
  (default list contains the code).
- `GET /me`: `branding` present for every actor; inheritance visible for BETA (the owner's installation title,
  colour and footer); no image bytes selected (the query does not touch the `bytea` columns).
- Inventories kept in sync (they failed after SSO, `HANDOFF.md`): permission count and `PERMISSION_CODES`, audited
  tables, write-route audit coverage, the matrix route scan, the definer-function list, `schema.ts` drift.
- CLI: `branding:owner` moves the row and keeps its content.

### Operations

No new environment variable, no new service, no proxy change (`deploy/Caddyfile` and `deploy/web/Caddyfile`
untouched; CSP unchanged). Logos add at most 3 × 256 KB per company to the database and to backups. After a deploy
on an existing installation the oldest company is the owner; `branding:owner` changes it. The API must still never
be published directly.

## Web

### State: root `BrandingService` (`core/branding/`)

- `Me` gains `branding?: EffectiveBranding` (optional so an older API still parses; absent = built-in).
- The service exposes signals: `effective` (signed in: `session`'s `branding`; signed out: the `PublicBranding`
  mapped to the same shape with null welcome texts and no company logo; nothing loaded: built-in), `signInMessage`,
  and the resolved, language-aware values `title()`, `welcomeTitle()`, `welcomeMessage()`, `footer()` (each
  `{text, lang} | null`, re-computed when the language changes), `color()`, `appLogo()`, `companyLogo()`.
- **Start-up** (`initializeSession`): after `session.load()`, when signed out, `GET /api/branding/default` is awaited
  with a 1.5 s limit (failure or timeout: the values cached on the device, else built-in). Nothing is painted before
  the initializer ends (`<app-root>` is empty), so there is no flash of the default brand. After sign-in
  (`session.load()`), sign-out and a failed refresh the service follows the session on its own; after sign-out it
  re-reads the public default.
- **Effects** (the only places that touch the document):
  1. `document.documentElement.setAttribute('data-brand', color)`;
  2. the browser tab title through Angular's `Title` service = the resolved app title (no per-page titles);
  3. `<meta name="theme-color">` through Angular's `Meta` service = the computed value of `--color-primary` read
     from `getComputedStyle(document.documentElement)` (no hex table in TypeScript);
  4. the device cache: `localStorage['hrforce.brand']` = the colour code, `localStorage['hrforce.title']` = the
     resolved title (try/catch: storage may be blocked).
- `public/lang-boot.js` (still the one blocking script; file name kept) also applies the cache before Angular
  starts: `hrforce.brand` when it matches `^[a-z]{3,12}$` → `data-brand`; `hrforce.title` when it is a string of
  1–40 characters → `document.title` (assignment as text). An unknown code matches no CSS rule and shows the default
  blue. `BrandingService` stays the authority. Update the file's header comment and the `lang-boot.js` sentence of
  `CONVENTIONS.md` (Web).

### Colour under the CSP

`styles.css` keeps `--color-primary: #1f4e79` on `:root` and adds one rule per palette code on **any element**:
`[data-brand='navy'] { --color-primary: #1b3358; }` … (the ten hex values of the table; `blue` included for
completeness). `<html data-brand>` themes the app; the same attribute on a swatch or on the preview panel themes
that subtree only. No `[style]` / `[ngStyle]` binding carries server data, no stylesheet is generated at runtime, no
hex value comes from the API: the policy (`script-src 'self'`, `style-src 'self' 'unsafe-inline'`,
`img-src 'self' data:`) is neither used more widely nor changed, and the approach survives a later removal of
`'unsafe-inline'`. Hard-coded uses of the brand colour outside `styles.css` (none today except `index.html`'s
initial `theme-color` and the static manifest) stay as they are.

Focus visibility: inside the coloured header the focus outline uses `var(--color-on-primary)` (white: ≥ 6.5:1 on
every palette colour; the global `--color-focus` blue reaches only 1.7–3.4:1 there).

### Where branding shows

| Place | Change |
|---|---|
| Shell header (`app.html`) | the `.brand` link shows the app logo when there is one, on a white rounded chip (`background: var(--color-surface)`, so any logo stays legible on any brand colour), max block-size 2 rem, max inline-size 10 rem, `object-fit: contain`, `width`/`height` attributes from `LogoRef` — followed by the title text. ≤ 640 px with a logo: the text is visually hidden (still the link's accessible name). The `<img>` has `alt=""` when the title text is next to it. No logo → the title text alone, as today. Long titles: one line, ellipsis |
| Shell footer (new) | `<footer class="app-footer">` under `.layout` when the chrome is shown and a footer text exists: small muted centred text, `dir="auto"`, hidden in print. Not on `/kiosk` nor on the SSO handoff card page (no chrome) |
| Sign-in page | the app logo above the `h1` when there is one (max block-size 4.5 rem, max inline-size 16 rem, `alt` = the app title); the sign-in message under the form in a `.note` block (`white-space: pre-line`, `dir="auto"`), on both steps. Password pages: header and footer only |
| Dashboard (`home.page.ts`) | `h1` = welcome title (fallback `home.title`), intro paragraph = welcome message (fallback `home.intro`, `white-space: pre-line`), the company logo at the start of the page header when there is one (max block-size 4 rem, `alt` = `session.company().name`). **Build on the working tree's version of `home.page.ts`** (uncommitted tiles work): change only the title, the intro and the logo |
| SSO handoff (`sso-handoff.page.html`) | its `.brand` line uses the service's title (and the app logo above it when there is one) instead of `t('app.title')` |
| `/punch` | nothing specific: it has the shell header and footer |
| `/kiosk` | nothing specific: its primary-coloured elements follow `data-brand` |

Every branded text is rendered with `{{ }}` interpolation (never `[innerHTML]`, never a translation parameter that is
rendered as HTML), inside an element with `dir="auto"` and, when the text's language differs from the UI language,
`[attr.lang]`. Logo `<img [src]>` values are the API's `url` strings as received.

### Settings section

- Routes: `settings` becomes a parent with children — `''` the existing notifications page (unchanged, every
  signed-in user) and `branding` (`canMatch: permissionGuard('settings.branding')`, followed by its own 404 entry so
  a refused user gets the 404 page and downloads no chunk of the feature, as `authorization.md` › cleanup). A small
  `settings-nav` tab bar (like `access-nav`) on both pages: « Notifications », and « Identité visuelle » only with
  the permission. The main nav entry « Paramètres » is unchanged.
- Page `/settings/branding` (`features/settings/branding/`): `GET /branding/settings`, then two tabs —
  **« Installation (avant la connexion) »** first, only when `installation` is not null, and **« Cette société »**.
  Intro line of the first: used on the sign-in page and by every company that has not set its own.
  - Text fields: three inputs per field (fr, ar with `dir="rtl" lang="ar"`, en), a character counter against
    `limits`, `textarea` for the two messages; on the company tab an empty field shows the inherited value as
    placeholder / helper text (« Par défaut : … »). Client validation mirrors the server (`fr` required when `ar`
    or `en` is filled, lengths); 422 `errors[]` mapped to the inputs by `field`.
  - Colour: a radio group (native radios drawn as swatches; each swatch is an element with `data-brand="<code>"`
    using `var(--color-primary)`), each with its visible name and a check mark when selected (never colour alone);
    the company tab has a first option « Par défaut (installation) » (= `null`).
  - Logos: file input `accept="image/png,image/jpeg"`, client pre-check of the type and of `logoMaxBytes` (the
    server is authoritative, pixel limits included), local preview through a `data:` URL (`FileReader`; `blob:` is
    not in `img-src`), buttons « Enregistrer le logo » / « Annuler » / « Supprimer le logo ». Upload errors by code:
    `unsupported_type` (« PNG ou JPEG uniquement ; le format SVG n'est pas accepté »), `too_large`,
    `dimensions_too_large`, `required`.
  - With `document.configure`: « Reprendre le logo de l'en-tête des documents » (GET
    `/api/documents/settings/profile/logo` as a Blob, then the company-logo upload) and « Utiliser ce logo pour
    l'en-tête des documents » (GET the company logo, then `PUT /api/documents/settings/profile/logo`), each with a
    confirmation; hidden without the permission.
  - **Preview before saving**: a panel (`[attr.data-brand]` = the draft colour, or the inherited one) showing a
    header strip (logo chip + title), a primary button, a dashboard tile with the welcome title and message, the
    sign-in message (installation tab) and the footer, from the draft values in the UI language, updated as the
    user types. It is a picture of the result, `aria-hidden="true"` with a visible caption.
  - « Enregistrer » sends the tab's `PUT`; « Réinitialiser » (confirmation dialog) sends the tab's `DELETE`. After
    any successful write: refresh the view and call `session.load()` so the shell, the tab title and the colour
    follow at once; success in a `role="status"` line, errors through `RevealAlertDirective`. 403 `forbidden-scope`
    → « Cette action demande le droit sur toute la société. »
- i18n: keys under `branding.*` and `settings.nav.*`, `access.groups.settings` (« Paramètres » / « الإعدادات » /
  "Settings"), the ten `branding.colors.<code>` names of the palette table; fr and ar key sets identical, en
  complete. Section name: « Identité visuelle » / « الهوية البصرية » / "Branding". Arabic wording gender-neutral
  (masdar / passive: « يرجى اختيار ملف », « تم الحفظ »).

### Accessibility

Contrast is guaranteed by the palette (table above) for white-on-brand and brand-on-surface; the header logo sits on
a white chip; the header focus ring is white. Logos never carry information alone: the app title is always the
brand link's accessible name; standalone logos have `alt` (app title, company name). The palette is a labelled
radio group operable by keyboard. Checked at 1280 and 390 px, fr and ar (RTL: logo and title order follow the
inline direction; logical properties only).

### Web tests (required)

- `resolve()`: active language, `fr` fallback, built-in fallback, the returned language.
- `BrandingService`: signed-out start-up uses the public default; failure and timeout fall back to the cache, then
  built-in; sign-in switches to `me.branding`, sign-out back to the default; the effects set `data-brand`, the tab
  title, `theme-color` and both storage keys; blocked storage does not throw.
- XSS: a title, a welcome message, a footer and a sign-in message containing `<img src=x onerror=…>` and
  `<script>` are present as text (`textContent`) and create no element (`querySelector('img[src="x"]')` is null) in
  the shell, the sign-in page, the dashboard and the preview.
- Shell: logo + title, title only, footer shown / absent; sign-in page: logo and message; dashboard: custom and
  built-in welcome texts, company logo `alt`.
- Settings: the nav tab and the route are absent without the permission (404 page, URL kept); the installation tab
  is absent when `installation` is null; 422 mapping; `fr` required; counters; upload error codes; the preview
  follows the draft colour (`data-brand` on the panel); a save calls `session.load()`.
- Palette guard (`npm run test:tools`, `tools/guardrails/css/`): `styles.css` has exactly one `[data-brand='<code>']`
  rule per code of the web's `BRAND_COLORS` list, with the hex value of this contract's table, and each hex value
  reaches ≥ 4.5:1 against `#ffffff`, `#f6f8fa` and `#eaeef2` (the test computes the ratios).

## Verification checklist (independent verifier)

Browser, fr + ar, 1280 + 390 px, direct and behind the staging Caddyfile: change every field on both tabs and see
it on `/login` (signed out, cold load and reload: no flash of blue or of « HRForce » in the tab after the first
visit), the header, the dashboard, the footer, `/punch`, the SSO handoff, the kiosk colour; a second company without
branding inherits; a second company with its own colour does not leak it to the sign-in page. No CSP violation in
the console (logos, previews, swatches). Probes: SVG / HTML / polyglot uploads; a logo URL of company A requested
with a session of company B and anonymously; the public endpoint's body and headers; `<script>` and bidi overrides
in every text; a 40-character Arabic title at 390 px; `est` and `acces` cannot open `/settings/branding`.

## Settled by the build

### Settled by the build (API)

**Shapes: no change.** `PublicBranding`, `EffectiveBranding`, `BrandingSettingsView` (and `LogoRef`, `LogoView`,
`Lang3`, `BrandColor`) are served exactly as written under **Views**; endpoints, status codes and error codes are the
table's. What the web should know beyond the shapes:

- **`GET /branding/settings` and scope.** The read needs the permission anywhere, so a holder on one region gets
  200 (with `installation` when the company is the owner) while every write answers 403 `forbidden-scope`.
- **`updatedAt`.** `company.updatedAt` is `null` until the company has a row; a reset keeps the row, so it is then a
  date with every field `null`. `installation.updatedAt` is never `null` for the owner (the row's creation time until
  the first change).
- **No installation row** (only after an operator deleted it): the public endpoint answers the built-in default,
  `installation` is `null` for everybody and the four installation routes answer 404 until `branding:owner` runs.
- **Validation runs in the use case**, after the scope and owner checks (the global pipe would answer 422 first):
  the bodies are plain JSON objects parsed strictly there. An over-size upload is likewise answered 422 `too_large`
  after those checks (the upload interceptor only marks the request). An unknown logo `:kind` is a 404 after the
  scope check.
- **Validator codes** besides the contract's four: `invalid_type` (wrong type, a missing key: `field` is the key,
  e.g. `appTitle` or `appTitle.ar`), `unrecognized_keys` (`field` is the parent object, `""` at the top level),
  `too_big` (a language text over 4 000 characters before cleaning, or a colour string over 40). The installation
  `color: null` is `invalid_type`; an unknown code is `invalid_color`.
- **Text cleaning, details the contract left open.** Half surrogate pairs are dropped. In the two multi-line fields
  the spaces next to a line break are dropped, then three or more line breaks become two, then leading and trailing
  breaks are trimmed; `too_many_lines` counts the lines that remain (empty ones included): more than 6. Lengths are
  measured after cleaning, so a padded or decomposed text within the limit is accepted and comes back cleaned: the
  web should show the returned values after a save.
- **Nothing changes, nothing is written.** Same values (also when they only differ by what cleaning removes), the
  same image, deleting a logo that is not there, resetting an empty level: 200 / 204, no audit row, `updatedAt`
  unchanged. A first save of an all-null body, a logo deletion or a reset on a company without a row creates no row.
- **`GET /branding/default`.** `ETag` is the base64url SHA-256 of the JSON body in quotes; `If-None-Match` is
  compared weakly (a list and `W/` are accepted) and the 304 has no body. The same content gives the same tag again.
- **Logo routes.** `:digest` must be 64 lower-case hex characters (upper case → 404). `kind` and digest must match:
  the company-logo digest on `/logos/app/…` is a 404, as is the installation logo's digest on `/logos/…` and any
  company digest on `/default/logo/…`. `sizeBytes` is the stored file's size.
- **Two-step sign-in.** With the policy enforced and the default list, every holder of `settings.branding` (a
  regional one too) gets 403 `mfa-enrollment-required` on the eight writes and on `GET /branding/settings`;
  `GET /me`, `GET /branding/logos/:kind/:digest` and the two public routes stay reachable.
- **Audit.** `installation_branding` rows carry the owning company as `company_id` and row id; `branding:owner`
  (migrator, no session) writes its move as a change row without an actor.
- **Seed.** `seedDemoBranding(tx, companyId, companyLogo)` (the script hands in `demoLogoPng()`, the module imports
  only `platform/**`): the installation texts are written only when the demo company owns the row and neither the
  footer nor the sign-in message is set; the company row is `on conflict do nothing`. Re-running `seed:dev` never
  overwrites what an admin changed.
- **Palette guard** (`tools/guardrails/css/brand-palette.ts` + `.spec.ts`, `npm run test:tools`): the hex values come
  from this contract's palette table (the single source of truth), the codes from the web's `BRAND_COLORS`
  (`apps/web/src/app/core/branding/branding.models.ts`), which must equal the API's
  (`apps/api/src/modules/branding/domain/types.ts`) and the table's, in order. `styles.css` must have exactly one
  plain `[data-brand='<code>'] { --color-primary: … }` rule per code with the table's value, none for another code
  and none under a compound selector; `:root` must still declare `--color-primary` = the first code's value,
  `--color-on-primary` / `--color-surface` `#ffffff`, `--color-surface-alt` `#f6f8fa` and `--color-hover` `#eaeef2`
  (the surfaces the 4.5:1 ratios are computed against). Changing a colour = the table and the rule together.

### Settled by the build (web)

Observed by the verifier in the running app (2026-10-09); nothing here changes a shape.

- **Start-up.** Nothing is painted before the initializer ends. A device without a cache paints its first frame with
  the public default already applied (measured ≈ 120 ms on a local server). When `GET /branding/default` takes longer
  than 1.5 s, the app paints at ≈ 1.6 s with the cached brand, else the built-in one (« HRForce », blue), and switches
  when the answer arrives. `lang-boot.js` sets `data-brand` and the tab title from the cache ≈ 10 ms after the
  document starts; until then the tab shows the static `<title>` of `index.html`.
- **Device cache.** `hrforce.title` holds the resolved title in the UI language (the built-in « HRForce » too),
  `hrforce.brand` the colour code; both follow every change at once (save, reset, sign-in, sign-out, language). The
  cache is only *shown* while nothing is loaded; a value that is not a known code / not 1–40 characters is ignored.
- **Colour.** `data-brand` on `<html>` drives the header, primary buttons, active tabs, tiles, links in lists, the
  sidebar badge, `theme-color` and the kiosk's buttons. `<p class="note" data-brand="sign-in-message">` on the sign-in
  page reuses the attribute name as a test hook only (no palette rule matches it).
- **Shell.** The header shows the logo chip then the title; in Arabic the order follows the inline direction. The
  footer is under the layout on every page with the chrome, signed in or not. `/punch` signed out redirects to
  `/login` (shell, default brand); `/kiosk` has no header, footer, logo or sign-in message, and its tab title follows
  the default title.
- **Sign-in page.** Logo above the `h1` (64 px high at most), message under the form with the admin's line breaks;
  the password pages have the header and footer only.
- **SSO handoff.** Before sign-in the card shows the default logo and title; after sign-in (while it completes) the
  user's company title and colour. Its `h1` (« Connexion via HRForce ») keeps the product name.
- **Settings page.** `/settings` has the tab bar on both pages. The owner sees « Installation (avant la connexion) »
  (selected first) and « Cette société »; both forms stay in the page, so a draft survives a tab switch. A company
  field left empty shows « Par défaut : … » under the field and the inherited text as placeholder per language; the
  first colour option is « Par défaut (installation) — <colour name> »; the app-logo box shows the inherited logo.
- **Counters and client checks.** Counters count code points of the text as the server will store it (spaces and
  line breaks normalised), so 40 Arabic letters or 40 emoji read « 40 / 40 »; over the limit the counter is marked
  and « Enregistrer » only shows « Corrigez les champs signalés… ». Control and bidi characters are removed by the
  server only: after a save the form shows the stored text.
- **Preview.** One panel per tab (sticky beside the form on a wide screen, under it on a phone), themed by its own
  `data-brand`; it follows the draft texts in the UI language, the draft colour and a chosen-but-unsaved app logo
  (`data:` URL) while the page itself keeps the saved brand.
- **Logos.** SVG, GIF and files over 256 KB are refused in the browser without a request; a renamed HTML or SVG file
  and oversized pixel dimensions come back from the server as 422 and are shown under the same input, the file is
  dropped. « Supprimer le logo » acts at once (no confirmation); « Réinitialiser » and the two letterhead copies ask.
  « Utiliser ce logo pour l'en-tête des documents » appears only when the company has a company logo.
- **Regional holder.** The tab and the page open (the Installation tab too, for the owning company); the first
  refused write (403 `forbidden-scope`) shows « Cette action demande le droit sur toute la société. », then a
  read-only notice, and disables every save, reset, logo and copy control on both tabs.
- **Without the permission.** No tab in `/settings`; `/settings/branding` shows the 404 page with the URL kept and
  the page's code is not downloaded.

### Settled by the verification (2026-10-09)

Full gate from clean on Windows with Postgres 18 (lint, typecheck, tests twice, tools, guards, build); browser run in
fr and ar at 1280 and 390 px, direct and behind `deploy/Caddyfile` with the production build; API probes.

Fixed by the verifier:

- **Duplicate ids on the logo inputs.** `<app-branding-logo id="…">` left the id on the host element as well as on
  the file input, so each `<label for>` pointed at the host and the input had no name. The component's input is now
  `inputId` (`branding-logo.ts`, `branding-form.html`; a test checks one element per id).
- **Phone header (≤ 640 px).** With a logo, the chip ran over the user's name; without one, a long title was cut
  after a few letters. The header now wraps: the brand takes its own line above the tools (`app.css`). A
  40-character title in French or Arabic fits one line at 390 px or ends in an ellipsis.
- **Cached title length.** `lang-boot.js` and `BrandingService` count the cached title in code points (as the API
  does), so a title of 40 emoji is applied on a returning device instead of being ignored.
- **`scripts/dev-up.*`.** On an empty volume `pg_isready` answered during the image's temporary init server; the
  scripts now wait for a real query over TCP to succeed twice, a second apart.

Confirmed, no change needed:

- **Public endpoints.** Same body and `ETag` anonymous and with a session of either company; exactly the five keys;
  no id, company code or name; no `Set-Cookie`; 304 on `If-None-Match`. A company digest on the public logo route,
  another company's digest, a digest under the wrong `kind`, upper case and path tricks: 404.
- **Non-owner company** (created with `bootstrap`): `installation: null`, 404 on the four installation writes (also
  with an invalid body), `GET /me` inherits the owner's default title, footer, colour and logo.
- **Refusals.** `lecture`, `rh_regional`, `employe` and a unit head: 403 on the settings read and the eight writes.
  A write without the XSRF token, or with another session's token, is refused 403; the XSRF check comes before
  authentication, so an anonymous write is 403 and an anonymous read 401.
- **Uploads.** SVG, GIF, HTML or SVG named `.png`, truncated PNG → `unsupported_type`; 300 KB → `too_large` (also
  through Caddy: the API's 422, no proxy 413); 5000 × 5000 and 4001 × 10 → `dimensions_too_large`; empty →
  `required`; 4000 × 4000 accepted. A PNG with an HTML tail and a JPEG with script text in its EXIF / comment
  segments, declared `text/html` and named `x.html`, are stored as images and served as `image/png` / `image/jpeg`
  with `nosniff`; opened directly in the browser they are image documents and nothing runs.
- **Text is data.** `<img src=x onerror=…>`, `</title><script>…</script>`, `<b>`, `javascript:` links and 200–500
  character unbroken strings in every field of both levels: shown as text in the header, the tab title, the footer,
  the sign-in and password pages, the dashboard and both previews, in fr and ar, without creating an element,
  running anything or widening the page. Tampered `hrforce.brand` / `hrforce.title` values: an unknown or malformed
  code leaves the default colour, a title of 1–40 characters is shown as literal text, anything else is ignored.
- **Database.** As `hrforce_app`: no insert, delete or truncate on `installation_branding`, no update of
  `company_id` or `singleton`, no delete on `company_branding`; another company's session sees and updates no row.
- **Behind Caddy.** No CSP violation and no console error on the settings page (swatches, previews, `data:` logo
  preview), the dashboard, the sign-in and password pages, `/kiosk` and `/punch`. Logo responses keep their
  `Cache-Control` (`private` / `public`, one year, `immutable`), `nosniff`, `ETag`, and gain
  `Cross-Origin-Resource-Policy: same-origin` and the CSP from the proxy; they are not compressed; a reload reads
  them from the browser cache; a replaced logo's URL answers 404.
- **Palette in the page.** For each of the ten codes the header, primary button, dashboard tile, swatch and
  `theme-color` take the table's value; measured ratios equal the table's (white on brand 6.52–12.64, brand on
  `#f6f8fa` 6.12–11.88); the focus ring inside the header is white, 2 px.

Left as is (for the owner or a later round):

- The SSO handoff heading and the e-mail subjects still say « HRForce » when a custom title is set (e-mails are out
  of scope above; the heading names the identity provider).
- A regional holder of `settings.branding` in the owning company can read the Installation tab (by the API rule
  above) and learns that writes need the whole company only after a first attempt.
- A session that ends without a sign-out leaves the company's colour and title in the device cache: they show in the
  tab title (and only there) until the app has started and read the public default.
