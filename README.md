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

## Deploy

Staging runs on any single Linux server with Docker: Caddy (HTTPS, headers, CSP) in front of the API and web images,
Postgres 18 on an internal network, a one-shot migration job and nightly backups. Every push to `main` that passes CI
is built into `ghcr.io/<owner>/hrforce-{api,web}:<sha>` and deployed over SSH by
[`.github/workflows/deploy-staging.yml`](.github/workflows/deploy-staging.yml). The deploy is skipped until the
`STAGING_*` secrets are set. Rollback means redeploying an older SHA.
Server setup, secrets, first admin, backups and restore: [deploy/README.md](deploy/README.md).

```sh
docker build -f apps/api/Dockerfile -t hrforce-api .   # from the repo root
docker build -f apps/web/Dockerfile -t hrforce-web .
deploy/smoke.sh https://staging.example.dz             # post-deploy checks
```

## Known follow-ups before the Authorization module
- The permission guard runs before the per-request transaction opens, so a DB-backed permission check needs its own tenant-scoped query (or the guard moves inside the transaction).
- Register the guard as `APP_GUARD` so an app bootstrapped without `configureApp()` is still deny-by-default.
- Tenant (company) creation needs a privileged path; the app role can only insert its own tenant.
- Non-`/api` paths return Express's HTML 404; malformed-JSON 400s aren't request-logged.
