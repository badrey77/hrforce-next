# HRForce Next

Rewrite of HRForce on a new database: NestJS API + Angular web + Postgres only.
Current state: **Phase 1 foundations** (ADRs, platform skeleton, CI guardrails). Business modules come next.

- Contract between modules: [CONVENTIONS.md](CONVENTIONS.md)
- Decisions: [docs/adr](docs/adr/README.md) (003 needs approval)
- API: [apps/api/README.md](apps/api/README.md) · Web: [apps/web/README.md](apps/web/README.md)

## Run it locally

```sh
./scripts/dev-up.sh          # Docker Postgres + Mailpit, migrate, seed, API :3000, web :4200
./scripts/dev-up.sh --reset  # same, starting from an empty database
```

Windows PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\dev-up.ps1          # API and web open in two new windows
powershell -ExecutionPolicy Bypass -File .\scripts\dev-up.ps1 -Reset
```

Then open http://localhost:4200 (demo users in apps/api/README.md, password `demo-password-2026`).

## Quick start
Requires Node >= 22.22.3 (Angular 22) and npm 11.

```sh
npm ci
npm run lint && npm run typecheck && npm run guard
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm test
TEST_DATABASE_URL=... npm run guard:db
npm run build
```

## Known follow-ups before the Authorization module
- The permission guard runs before the per-request transaction opens, so a DB-backed permission check needs its own tenant-scoped query (or the guard moves inside the transaction).
- Register the guard as `APP_GUARD` so an app bootstrapped without `configureApp()` is still deny-by-default.
- Tenant (company) creation needs a privileged path; the app role can only insert its own tenant.
- Non-`/api` paths return Express's HTML 404; malformed-JSON 400s aren't request-logged.
