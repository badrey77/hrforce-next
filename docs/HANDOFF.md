# HRForce Next — project state and decisions (handoff)

Last updated: 2026-09-29. This file carries what was decided in conversation and is not obvious from the code.
Keep it current: when a decision is made or an open question is answered, update this file in the same commit.

## Where we are

**M1 (Phase 1 thin vertical slice) is built.** Steps, in order: Foundations → Organization → Identity → Authorization → Audit → Employment (+ typography). All five exit criteria of the Phase 1 plan pass locally on Postgres 16:

| Exit criterion | Evidence |
|---|---|
| Authorization matrix (roles × self / same scope / other site / other company) | `apps/api/test/authorization-matrix.e2e-spec.ts` — 265 rows, built from route-scan, fails on any new unlisted route |
| A regional user cannot read another region | employment + organization e2e tests, matrix rows, browser-verified |
| Every write produces an audit row with before/after | audit exit-criterion test over all write routes |
| CI guardrails green | `npm run guard`, `npm run guard:db` |
| Postgres only at runtime | no Redis/broker/object storage; SMTP relay for mail (Mailpit in dev only) |

**Not yet done for M1:** a real GitHub Actions run (on PG18) and the actual staging deploy. The **staging deploy pack is ready** (`deploy/`, `.github/workflows/deploy-staging.yml`, `deploy/README.md`): any Ubuntu server with Docker, Caddy with automatic HTTPS, nightly backups, `bootstrap` CLI for the first company and admin. It needs the server + DNS + 4 repository secrets.

## How we work (keep doing this)

1. Write a contract in `docs/contracts/<slice>.md` first (shapes, endpoints, status codes, problem slugs, scope rules).
2. Build backend (`apps/api`) and web (`apps/web` + `docs/angular`) in parallel against it.
3. An independent verifier runs the full gate from clean, drives the app in a real browser (fr + ar, desktop + 390 px), probes security, and fixes small defects. Record behaviour the build settled in the contract.
4. The web is a **teaching codebase**: see CLAUDE.md (explain Angular in code, update the guide, "Angular concepts used" in replies).

Full gate: `npm ci && npm run lint && npm run typecheck && TEST_DATABASE_URL=… npm test && npm run test:tools && npm run guard && TEST_DATABASE_URL=… npm run guard:db && npm run build`.

## Decisions made by the owner (with date)

| Date | Decision |
|---|---|
| 2026-09-24 | Start from scratch (no legacy scaffold); build foundations first with multiple agents |
| 2026-09-25 | Stay on **Angular** (React/Vite and Django were considered and rejected); explain Angular extensively throughout |
| 2026-09-25 | **Org model** (plan open question answered): one management tree — Direction Générale → departments → Département RX (DG level only) → regions → agencies; services under a department, region or agency. A region only groups agencies and has no departments. Sites are places hosting units, not tree levels. Unit kinds and parent rules are data (`org_unit_kind`, `org_unit_kind_parent`) |
| 2026-09-25 | ADR 003 (vertical slices, org before permissions) **accepted** |
| 2026-09-26 | Fonts: **Cairo** for Arabic, **Source Sans 3** for French/English, self-hosted (no Google Fonts CDN — offline sites, Law 18-07) |
| 2026-09-26 | Local start scripts: `scripts/dev-up.sh` (bash) and `scripts/dev-up.ps1` (PowerShell) |
| 2026-09-26 | M2 starts with **Leave** using **Algerian defaults** (Law 90-11) as editable data, to be confirmed; default approval chain **unit head → regional HR**. In parallel: a **staging deploy pack** for any Docker Linux host (target still to choose). Workflow engine = ADR 006; SSO moves to ADR 007 |
| 2026-09-28 | M2 is complete. Next: a **hardening pass** over the known small issues (before M3 documents/numbering). Items that wait on a product decision (role trust, MFA reset visibility, access-admin edge cases) stay open |
| 2026-09-28 | **M3 starts with documents and numbering, generated documents first**: numbered HR documents (attestation/certificat de travail, titre de congé) from fr/ar templates as API-generated PDFs with a register of issued documents, gap-free per-company sequences; then an employee file (attachments stored in Postgres, per ADR 005). Outbox and sister-app integration come later in M3 |
| 2026-09-28 | **ADR 008 accepted**: PDFs rendered with Typst embedded in the API (`@myriaddreamin/typst-ts-node-compiler`), stored PDF bytes, gap-free counters in Postgres (≈ +51 MB image, +50 MB RAM per API process). Documents assumptions 5–7 confirmed: regional HR issues in scope, only central HR voids, employees self-request an attestation via a one-step HR workflow, documents hand-signed (no scanned signature/stamp) |
| 2026-09-29 | Certificat de travail in Arabic is **« شهادة نهاية العمل »** (was « شهادة العمل », too close to the attestation « شهادة عمل »). Documents Phase A committed; Phase B (employee file) starts |
| 2026-09-29 | Documents Phase B committed. The Typst logo-memory crash risk is fixed next (pixel-size limit on logos). HR users seeing/uploading to their own employee file: **left as is for now** (product decision pending) |
| 2026-09-29 | Staging server not ready yet. While waiting for the owner's answers (SSO/sister app, documents wording, leave assumptions), a **cleanup round** over the known small issues that need no product decision |
| 2026-09-29 | Arabic wording rule: **gender-neutral everywhere** (UI, e-mails, documents where the sex is unknown): masdar/passive forms such as « يرجى إعادة المحاولة » instead of masculine imperatives |

## M2 progress

- **Leave + workflow + My tasks: built and independently verified 2026-09-27** (browser fr/ar, security probes, 4 small web fixes). Gap: the employee History tab has no leave subject type yet.
  Contract `docs/contracts/leave.md`, ADR 006. Build decisions to confirm: accrued annual days become usable 12 months after the reference year starts (reading of "taken from 1 July N"); special paid leaves count working days; a user cannot link their own account to an employee; `rh.est` also holds `employe` so Karim can request leave; the Région Est director linked to Karim in the seed is the fictitious "Souad Cherif".

- **Notifications + worker + live updates: built and independently verified 2026-09-27** (live bell < 0.2 s, links open for every recipient, SSE isolation, worker role least-privilege; 3 small web fixes) (contract `docs/contracts/notifications.md`): in-app bell (SSE over Postgres LISTEN/NOTIFY), emails per preference via Graphile Worker jobs, monthly/daily cron (audit partitions, leave accruals, cleanups), leave events on History.
- **MFA (TOTP + recovery codes): built and independently verified 2026-09-27** (browser fr/ar, brute force / replay / token-swap / enforcement-bypass probes, CSP through Caddy; 3 small web fixes) (contract `docs/contracts/mfa.md`, see its "Settled by the build"). Default policy: enforced for holders of sensitive and access-management permissions; the DEMO company has enforcement off.
- **Hardening pass: built and independently verified 2026-09-28** (full gate green on Windows, browser fr/ar/en at 1280 and 390 px, security probes). Leave/escalation notifications carry an `audience` and name the employee to anyone but the employee (in-app and e-mail); `GET /employees?lang=ar` sorts by Arabic name (collation `ar-x-icu`); rehire screen `/employees/:id/rehire`; lower-case matricule accepted; breadcrumb mirrored in RTL; `public/lang-boot.js` sets lang/dir before first paint. Tooling: guardrails now run on Windows (`tools/guardrails/lib/node-bin.ts`); `dev-up` scripts pin the web port to 4200 (the API's `PORT=3000` leaked into `ng serve`).

## M3 progress

- **Documents Phase A (generated documents + numbering + register): built and independently verified 2026-09-29** (contract `docs/contracts/documents.md`, ADR 008). Typst PDFs in fr/ar checked visually (shaping, bidi, gender agreement), gap-free numbering under concurrency, identical reprints, void keeps the number, self-service attestation via workflow `document.hr_only`, titre de congé from approved leave. Verifier fixes: bidi control characters stripped from printed data (an RTL override mirrored the legal sentence), `<bdi>` on the Arabic detail page, lower-case number formats. Chrome/Edge PDF viewer works under the production CSP. API image 344 → 422 MB.
- **Documents Phase B (employee file): built and independently verified 2026-09-29.** Dossier tab (upload with XHR progress, drag-and-drop, download, delete with reason), file categories settings, content sniffing (PDF/JPEG/PNG), attachment downloads with sandbox CSP through Caddy, audited downloads, medical category hidden, monthly retention purge. Verifier fixes: UTF-8 upload filenames (multer read them as latin1), download name follows the real type, client expiry-date check, 413 message, medical note wording, and an 8 GB allocation in the Typst spec's own test template (the Windows 0xC0000409 crash).
- **Cleanup round: built and independently verified 2026-09-29.** Refused routes show 404 (and don't load their code); top-of-form errors scrolled into view and focused (`RevealAlertDirective`); rehire link hidden when the person has an open employment (`person.hasOpenEmployment`); timeline fingerprints/names/scan status; PDF long tokens wrap (templates @2); Arabic titre day count with number agreement; neutral Arabic e-mails; login throttle fix for backward DB clock jumps (the cause of the Windows test flakes).

## Assumptions in force (not yet confirmed — change by role edit/data, not code)

- **Sensitive fields:** only `admin_rh_central` reads/edits salary, RIB, NSS; **no role** holds `employee.medical.read`.
- **Arabic names:** optional Arabic names for people and org units (shown when the UI is Arabic).
- **Access-admin edge cases (by design, product decision pending):** a regional `access.manage_roles` holder can remove permissions from company-wide custom roles; ending a grant needs only `access.grant` over the unit.

## Open questions for the owner

0. **Confirm the leave assumptions** listed at the top of `docs/contracts/leave.md` (accrual, reference period, special leaves, holidays, southern supplement).

1. **SSO:** HRForce login should authorize other apps. Which apps, and what are they built with (OIDC-capable web apps / legacy PHP-Java / SAML-only products)? Recommendation: HRForce as the OIDC provider (`oidc-provider` in the API, Postgres only) unless SAML or directory integration is needed (then Keycloak/Zitadel). Record as **ADR 007** once answered. SSO was out of P1 scope.
2. **Staging server**: provide an Ubuntu 24.04 host with Docker, a DNS name, and the repository secrets `STAGING_HOST`, `STAGING_USER`, `STAGING_SSH_KEY`, `STAGING_DOMAIN` (see `deploy/README.md`).
3. **App-role trust** (ADR 004 note): accept that a compromised `hrforce_app` DB role could mint sessions / forge audit events, or plan a separate credential service before go-live.
4. Team size and target date (plan open question).
5. **Documents** (`docs/contracts/documents.md`): confirm the remaining assumptions (1–4, 8–16); have an Algerian HR/legal reader check the fr/ar legal wording, including the new Arabic titre day-count sentence (`titre_conge@2`, contract "Settled by the cleanup") and the neutral Arabic e-mail wording (`notifications.md`); retention periods per employee-file category; should a "Médecine du travail" role exist (medical files stay unused until then).

## Operations notes

- New DB role **`hrforce_worker`** (Graphile Worker jobs + cron). Existing staging installs: add `HRFORCE_WORKER_PASSWORD` to `deploy/.env` before the next deploy (`deploy.sh` re-applies `create-roles.sql`). Local: `scripts/dev-up.*` creates the role on old volumes.
- The worker runs cron in UTC: audit partitions monthly, leave accruals monthly (previous month), auth and notification cleanups daily.

- **`AUTH_MFA_KEY`** (32 bytes, base64) is required in production: existing staging installs must add it to `deploy/.env` before the next deploy (`init-env.sh` generates it for new installs). Losing it makes every enrolled factor unusable (users would need an admin reset).
- A company without a `security_policy` row is treated as MFA-enforced (safe default). DEMO has enforcement off; `bootstrap` creates companies with it on.
- **Employee file (Documents Phase B):** `EMPLOYEE_FILE_MAX_BYTES` (default 10 MB, max 20 MB; the web's `EMPLOYEE_FILE_MAX_BYTES` in `core/employee-files/employee-files.models.ts` must match). Caddy caps uploads to `/api/employees/*/files` at 25 MB. Deleted/purged files survive in backups for `BACKUP_RETENTION_DAYS`.
- A "Médecine du travail" role cannot be created through the API (role creation refuses permissions no one holds): if the owner wants it, an operator inserts it by SQL with `employee.medical.read` + `employee.medical.update`.

## Known small issues (not fixed)

- The worker role can SELECT every public table (salary included); the app role can enqueue any job type (same trust question as open question 3).

- MFA admin reset follows the `GET /access/users/:id` visibility rule: a regional `access.grant` holder can reset the factor of a user who has one grant in their region even if that user also holds company-wide rights (reset only weakens a factor; the password is still needed). Product decision pending, like the access-admin edge cases above.
- Refresh/access tokens: the access token stays valid ≤ 15 min after logout/reset (stateless by contract).
- A first visit with no stored language whose account locale is Arabic still starts in French (and may load one Latin font file) until sign-in applies the account language.
- Timeline still shows raw ids for `leave_request_id` / `document_request_id` on an issued document and `issued_document_id` on a document request.
- `hasOpenEmployment` is true for an employment ending in the future, so the rehire link stays hidden until that date although the API would accept a rehire dated after it.
- **Typst runs in the API process** (ADR 008): an out-of-memory in the native renderer would abort the whole API, and `worker.terminate()` cannot stop a native render. The logo trigger is fixed (2026-09-29: logos limited to 4000 px per side and 16 MP, read from the PNG/JPEG header at upload and again at render; an oversized stored logo is left out; render input capped at 2 MB). A logo within the limits can still cost ~128 MB per render thread. The full fix for any other trigger is rendering in a child process (ADR 008 fallback option).
- Employee file: HR users can see and upload to their own file when it is in their scope (e.g. rh.est linked to EMP-0022): product decision. The app role can set `purged_at` (trust question 3).

## Environment facts

- GitHub remote: `https://github.com/badrey77/hrforce-next` (the owner pushes; the cloud session that built M1 had no push access).
- Node ≥ 22.22.3, npm 11, Docker for local Postgres 18 + Mailpit. Demo users (password `demo-password-2026`): `rh.admin@demo.dz`, `rh.est@demo.dz`, `lecture.ouest@demo.dz`.

## Next steps (proposed order)

1. ~~Push and get the first green GitHub Actions run on PG18.~~ Done: CI green on PG18 (first on `cd7ccae`, 2026-09-27; again on `ee98d47`, 2026-09-29). The deploy workflow builds and pushes images and skips the deploy until `STAGING_HOST` is set.
2. Staging deploy (needs the target — open question 2).
3. M3 (ADR 003): documents and numbering, the outbox pattern, sister-app integration. SSO (ADR 007) once open question 1 is answered.
