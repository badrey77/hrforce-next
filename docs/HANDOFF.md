# HRForce Next — project state and decisions (handoff)

Last updated: 2026-09-26. This file carries what was decided in conversation and is not obvious from the code.
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

## M2 progress

- **Leave + workflow + My tasks: built and independently verified 2026-09-27** (browser fr/ar, security probes, 4 small web fixes). Gap: the employee History tab has no leave subject type yet.
  Contract `docs/contracts/leave.md`, ADR 006. Build decisions to confirm: accrued annual days become usable 12 months after the reference year starts (reading of "taken from 1 July N"); special paid leaves count working days; a user cannot link their own account to an employee; `rh.est` also holds `employe` so Karim can request leave; the Région Est director linked to Karim in the seed is the fictitious "Souad Cherif".

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

## Known small issues (not fixed)

- Arabic employee list sorts by the Latin name; breadcrumb "›" not mirrored in Arabic.
- Web rejects a lower-case matricule (the API would upper-case it).
- No rehire screen (API supports `personId`).
- An Arabic session also downloads one Latin font file (index.html starts as `lang="fr"`).
- Refresh/access tokens: the access token stays valid ≤ 15 min after logout/reset (stateless by contract).

## Environment facts

- GitHub remote: `https://github.com/badrey77/hrforce-next` (the owner pushes; the cloud session that built M1 had no push access).
- Node ≥ 22.22.3, npm 11, Docker for local Postgres 18 + Mailpit. Demo users (password `demo-password-2026`): `rh.admin@demo.dz`, `rh.est@demo.dz`, `lecture.ouest@demo.dz`.

## Next steps (proposed order)

1. Push and get the first green GitHub Actions run on PG18.
2. Staging deploy (needs the target — open question 2).
3. M2: leave, workflow engine + "My tasks", notifications, MFA; SSO (ADR 006) once open question 1 is answered.
