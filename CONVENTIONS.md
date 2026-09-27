# HRForce Next — engineering conventions (Phase 1 contract)

This file is the contract between the modules. The CI guardrails in `tools/guardrails/` enforce it.
Source plan: "HRForce Next — Phase 1 Plan" (M1 thin vertical slice).

## Repo layout

```
apps/api      NestJS HTTP API + background worker (src/worker.ts) → workspace "@hrforce/api"
apps/web      Angular SPA                                     → workspace "@hrforce/web"
docs/adr      Architecture decision records (001–005)
tools/        Repo scripts; tools/guardrails = CI checks
.github/workflows/ci.yml
```

- npm 11 everywhere (root `packageManager`), no per-app `packageManager` / npm pins.
- Node 22. TypeScript `strict` everywhere. One Vitest major across apps (5.x).
- oxlint at root with `typescript/no-explicit-any: error`. No `console.*` — use the logger.

## API (apps/api)

### Module layout and boundaries
```
src/
  main.ts                 bootstrap only: const app = await NestFactory.create(AppModule, …); configureApp(app); listen
  app.module.ts
  configure-app.ts        configureApp(app): global prefix "api", pipes, filters, interceptors, cookie parser, shutdown hooks.
                          main.ts AND every e2e test call it — tests therefore hit /api/...
  platform/               cross-cutting infra. May be imported by anything. Imports nothing from modules/.
    config/               env schema (zod) validated at boot; fail fast
    db/                   Kysely instance, DB types (src/platform/db/schema.ts), transaction helper
    logging/              pino with redaction
    http/                 problem+json exception filter, request-id
    context/              RequestContext (AsyncLocalStorage): requestId, userId, companyId, tx
    authz/                @RequirePermission()/@Public() + global deny-by-default PermissionGuard (evaluator lands with Authorization module)
  modules/<name>/         feature modules (organization, identity, authorization, audit, employment…)
    <name>.module.ts
    api/                  controllers + DTOs (HTTP layer)
    application/          use cases
    domain/               pure types/rules, no Nest, no Kysely
    infra/                repositories (Kysely)
    index.ts              the ONLY file other modules may import from
```
Boundary rules (dependency-cruiser):
1. `platform/**` must not import `modules/**`.
2. A module may import another module only via `modules/<other>/index.ts`.
3. `domain/**` must not import `@nestjs/*`, `kysely`, `infra/**`, `api/**`.
4. No circular dependencies.

### Routes
- Every controller handler has exactly one of `@RequirePermission('<resource>.<action>')`, `@Authenticated()`
  (signed-in caller, no permission — e.g. `GET /api/me`) or `@Public()`. A method's decorator overrides its controller's.
  Guardrail `route-scan` fails otherwise. Two-step sign-in is enforced for every non-public route in the platform permission check; `@AllowWithoutMfa()` (on `@Authenticated()` routes only, each listed with a reason in `tools/guardrails/mfa-exempt.json`) keeps a route reachable before a required factor is enrolled (docs/contracts/mfa.md).
  Permission codes: lowercase `resource.action` (or `resource.field.action` for field-level permissions), e.g. `employee.read`, `employee.salary.update`.
- Every unsafe method (`POST`/`PUT`/`PATCH`/`DELETE`) under `/api` needs a valid signed `X-XSRF-TOKEN` (ADR 004, contracts/identity.md).
- Out-of-scope ids return **404**, not 403 (ADR 002).
- Errors are RFC 9457 `application/problem+json`: `{type, title, status, detail?, instance, requestId, errors?: [{field, code, message}]}`.
  Validation errors → 422 with `errors[]` (the web maps `field` to form controls).

### Database
- Postgres (target 18; code must also run on 16 — do not use PG18-only features such as `uuidv7()`; generate UUIDv7 in the app or use `gen_random_uuid()`).
- Migrations: plain SQL, forward-only, `apps/api/migrations/NNNN_description.sql` (4-digit, contiguous). Applied by `npm run migrate -w @hrforce/api` using the **migrator** role. Tracked in `public.schema_migrations(version, name, checksum, applied_at)`; a changed checksum of an applied migration is an error.
- Two roles: `hrforce_migrator` (owns schema, DDL) and `hrforce_app` (DML only, subject to RLS; no BYPASSRLS, not owner).
- Every business table has `company_id uuid not null` + RLS policy
  `using (company_id = current_setting('app.company_id', true)::uuid)`, `FORCE ROW LEVEL SECURITY`.
  Tables exempt from `company_id` are listed, with a reason, in `tools/guardrails/company-id-exempt.json` (e.g. `schema_migrations`, `company`, global catalogues).
- One transaction per request: the request-context interceptor opens a transaction and runs
  `select set_config('app.company_id', $1, true), set_config('app.user_id', $2, true), set_config('app.request_id', $3, true)`.
  Repositories get the transaction from RequestContext — never the root pool.
- `sql.raw` is banned (lint/guardrail). Use Kysely builders or `sql` tagged templates.
- `src/platform/db/schema.ts` holds the Kysely `DB` interface; the drift check regenerates it from a migrated DB and diffs.

### Audit (docs/contracts/audit.md, migration 0009)
- Writes happen inside the request transaction so the DB trigger can read `app.user_id`/`app.request_id`.
- **Every tenant table is audited**: each table of `public` with a `company_id` column (and `company`) gets
  `create trigger audit_capture_tg after insert or update or delete on public.<t> for each row execute function audit.capture();`
  in the migration that creates it (pass the row-id column as argument when the table has no `id`, e.g. `audit.capture('role_id')`).
  Exceptions (derived data only, e.g. `org_unit_closure`) are listed with a reason in `tools/guardrails/audit-exempt.json`.
  `guard:db` (audit-per-write) fails on a tenant table without an `audit%` AFTER INSERT/UPDATE/DELETE row trigger and on stale exemptions.
  (The former `-- @audited` marker is retired.)
- Sensitive columns are masked in the stored diff: add a row to `audit.masked_column(table_name, column_name)` in the same migration.
- Use-case events that are not a row change go through the platform port `AuditEvents` (`platform/audit`), never by writing
  `audit.*` directly: `hrforce_app` only has SELECT there; the log is append-only.

### Security
- Pino redaction paths include: `req.headers.authorization`, `req.headers.cookie`, `res.headers["set-cookie"]`, `*.password`, `*.passwordHash`, `*.token`, `*.refreshToken`, `*.secret`.
- Response payloads never contain keys matching `/(password|hash|token|secret)/i` (guardrail + e2e helper `assertNoSecrets(body)`).

### Tests
- Vitest. Unit tests `*.spec.ts` beside code; e2e/integration `apps/api/test/**/*.e2e-spec.ts`.
- DB tests run on real Postgres: if `TEST_DATABASE_URL` (superuser URL) is set, the harness creates a throwaway database on it; otherwise it starts `postgres:18-alpine` via Testcontainers. Each test file gets a fresh migrated database.
- E2E tests build the app through the same `configureApp()` as `main.ts`.

## Web (apps/web)
- Angular (standalone, signals), `strict` + `strictTemplates`, Vitest.
- Transloco. Languages: `fr` (default), `ar` (RTL), `en` (may lag). Files `apps/web/public/i18n/{fr,ar,en}.json`, nested keys.
  Guardrail: `fr` and `ar` must have identical key sets; `en` missing keys are a warning only.
- `<html lang dir>` is set at runtime from the active language (`ar` → `rtl`); `index.html` ships `lang="fr" dir="ltr"`.
- Use CSS logical properties (`margin-inline-start`, not `margin-left`).
- API calls go to same-origin `/api` (dev proxy to the API); cookies `httpOnly`, XSRF via Angular's `HttpXsrfTokenExtractor` (cookie `XSRF-TOKEN`, header `X-XSRF-TOKEN`).
