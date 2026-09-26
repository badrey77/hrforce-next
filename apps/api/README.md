# @hrforce/api

NestJS HTTP API for HRForce Next. Phase 1 "platform skeleton": config, logging, problem+json errors,
request context + one transaction per request, Postgres RLS, migrations and deny-by-default route guard.
The binding contract is [`CONVENTIONS.md`](../../CONVENTIONS.md).

Stack: Node 22, NestJS 12 (ESM, Express 5), TypeScript 7 (legacy decorators + `emitDecoratorMetadata`),
Kysely 0.29 + `pg`, zod 4, nestjs-pino / pino 10, Vitest 5 (SWC via `unplugin-swc` for decorator metadata).

## Quick start

```bash
# 1. Postgres with the two roles (hrforce_migrator, hrforce_app) and an `hrforce` database, + Mailpit
cd apps/api && docker compose up -d          # or run scripts/create-roles.sql against your own cluster
cp .env.example .env                          # then load it: set -a; . ./.env; set +a

# 2. Migrate (as hrforce_migrator), seed the demo organisation + demo users, run
npm run migrate -w @hrforce/api
npm run seed:dev -w @hrforce/api              # idempotent; demo company, org units, 3 users, roles + grants (see below)
npm run build -w @hrforce/api && npm start -w @hrforce/api
curl localhost:3000/api/health                # {"status":"ok","db":"ok"}

# 3. Sign in with a cookie jar (the XSRF token is read from the XSRF-TOKEN cookie and echoed as X-XSRF-TOKEN)
curl -s -c jar -b jar localhost:3000/api/auth/csrf
curl -s -c jar -b jar -H "X-XSRF-TOKEN: $(awk '$6=="XSRF-TOKEN"{print $7}' jar)" -H 'Content-Type: application/json' \
     -d '{"email":"rh.admin@demo.dz","password":"demo-password-2026"}' localhost:3000/api/auth/login
curl -s -b jar localhost:3000/api/me
curl -s -b jar localhost:3000/api/org/tree    # real grants: rh.admin sees everything, rh.est only Région Est
```

Mailpit (docker compose) catches every mail: web UI on http://localhost:8025, SMTP on `localhost:1025`
(`SMTP_URL=smtp://localhost:1025`). Without Docker, use `MAIL_TRANSPORT=log` (development/test only): mails,
links included, are written to the log at `info`.

The API does not load `.env` files itself; export the variables (or use `--env-file` with Docker).
`docker compose --profile api up -d` also runs the API image against these services.

## Environment

Validated at boot by `src/platform/config/env.schema.ts`; the process exits with a list of the invalid
variables (values are never printed).

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | yes | | `hrforce_app` role — DML only, subject to RLS |
| `MIGRATOR_DATABASE_URL` | for `migrate` | | `hrforce_migrator` role — owns the schema |
| `COOKIE_SECRET` | yes | | ≥ 32 chars, cookie-parser secret |
| `AUTH_ACCESS_SECRET` | yes | | ≥ 32 chars, HS256 key of the access token (`hrf_at`) |
| `AUTH_XSRF_SECRET` | yes | | ≥ 32 chars, HMAC key of the XSRF token; must differ from `AUTH_ACCESS_SECRET` |
| `WEB_BASE_URL` | yes | | `http(s)://…` of the web app (trailing `/` dropped); mailed links are `${WEB_BASE_URL}/password/setup?token=…` |
| `COOKIE_SECURE` | | `true` | `Secure` on every cookie. **Boot fails** if `false` and `NODE_ENV` is not `development`/`test` |
| `MAIL_TRANSPORT` | | `smtp` | `smtp` \| `log`. `log` only in `development`/`test` |
| `SMTP_URL` | with `smtp` | | `smtp://` or `smtps://` (nodemailer URL), e.g. `smtp://localhost:1025` (Mailpit) |
| `MAIL_FROM` | | `HRForce <no-reply@hrforce.invalid>` | From header |
| `NODE_ENV` | | `production` (fail-safe) | `development` \| `test` \| `production` |
| `PORT` | | `3000` | |
| `LOG_LEVEL` | | `info` | pino level or `silent` |
| `DB_POOL_MAX` | | `10` | |
| `TRUST_PROXY_HOPS` | | `0` | Express `trust proxy` |
| `MIGRATIONS_DIR` | | `apps/api/migrations` | migrate only |
| `DEV_AUTH` | | `false` | `true`/`false`. Development header identity (below). **Boot fails** if `true` and `NODE_ENV` is not `development`/`test` |
| `DEV_PERMISSIONS` | | unset | `allow_all`: every **authenticated** caller holds every permission and every scope is the whole company (overrides the real grants). **Boot fails** if set and `NODE_ENV` is not `development`/`test` |

## Database

### Roles (cluster-level, created outside migrations)

Roles are cluster-wide and need `CREATEROLE`/superuser, so migrations only *grant* to them; they are
created by `scripts/create-roles.sql` (psql; used by `docker-compose.yml` via `scripts/docker-init-roles.sh`)
and by the test harness.

- `hrforce_migrator` — `LOGIN BYPASSRLS`, owner of the database and therefore of `public` (PG15+). Runs DDL and data migrations.
- `hrforce_app` — `LOGIN NOSUPERUSER NOBYPASSRLS`, owns nothing. Gets `select, insert, update, delete` on
  every table the migrator creates through `ALTER DEFAULT PRIVILEGES` (migration 0001).

```bash
psql "$SUPERUSER_URL" -v migrator_password="'…'" -v app_password="'…'" -v db=hrforce -f apps/api/scripts/create-roles.sql
```

### Migrations

- Plain SQL, forward-only: `migrations/NNNN_description.sql` (4 digits, contiguous from 0001, lowercase snake_case).
- `npm run migrate -w @hrforce/api` compiles and runs `dist/platform/db/migrate.js` with `MIGRATOR_DATABASE_URL`.
  In the Docker image: `node dist/platform/db/migrate.js`.
- Runner (`src/platform/db/migrator.ts`): session advisory lock, `public.schema_migrations(version, name, checksum, applied_at)`
  with the file's sha256, each migration in its own transaction. It refuses to run on malformed names, gaps,
  applied migrations missing on disk, or a checksum change of an applied migration — never edit an applied file.
- Tenant tables: `company_id uuid not null` + `enable` **and** `force row level security` + policy
  `using (company_id = current_setting('app.company_id', true)::uuid)`. Tables exempt from `company_id`
  (`schema_migrations`, `company`, the `org_unit_kind*` and `permission` catalogues) are listed in `tools/guardrails/company-id-exempt.json`.
  Global reference catalogues are `SELECT`-only for `hrforce_app` (revoke the default DML grants in the migration).

### `schema.ts` (Kysely types)

`src/platform/db/schema.ts` is generated by `kysely-codegen` (config: `.kysely-codegenrc.json`, reads
`MIGRATOR_DATABASE_URL`, excludes `schema_migrations`). After adding a migration:

```bash
npm run migrate -w @hrforce/api && npm run db:codegen -w @hrforce/api
npm run db:codegen:verify -w @hrforce/api     # drift check: fails if schema.ts is stale
```

## Request pipeline

`PlatformModule` registers `PermissionGuard` as `APP_GUARD` and `RequestContextInterceptor` as `APP_INTERCEPTOR`,
so every bootstrap of `AppModule` is deny-by-default and transactional, even without `configureApp`.
`configureApp(app)` (used by `main.ts` and every e2e test) installs, in order: X-Request-Id middleware,
cookie-parser, global prefix `api`, `ProblemDetailsFilter`, `ZodValidationPipe`, shutdown hooks.

Per request: middleware → **guard** (decorator present? authenticated?) → **interceptor** (open transaction,
`set_config` tenant/audit settings, **then** the permission decision, then the handler) → pipes → handler.

- **Errors**: RFC 9457 `application/problem+json` `{type, title, status, detail?, instance, requestId, errors?}`.
  `type` is `urn:hrforce:problem:<slug>` (`not-found`, `validation-error`, `forbidden`, `unauthenticated`,
  `internal-error`, …; throw `ProblemException(status, slug, detail)` for domain errors). 5xx never include `detail`.
- **Validation**: DTOs are zod-backed classes — `class CreateX extends createZodDto(z.object({...})) {}` — used as the
  type of `@Body()` / `@Query()` / `@Param()`. Failures → 422 with `errors: [{field, code, message}]`
  (`field` is the dotted path, `code` the zod issue code).
- **Access**: every handler needs exactly one of `@RequirePermission('resource.action')`, `@Authenticated()` (signed-in
  caller, no permission — e.g. `GET /api/me`) or `@Public()` (`src/platform/authz/decorators.ts`); the handler's own
  declaration wins over the controller's.
  `PermissionGuard` denies undecorated routes (403) and answers 401 for anonymous callers of protected routes. It does
  **not** decide the permission: guards run before interceptors, i.e. before the request transaction exists. The decision
  is made by `PermissionCheck` (`src/platform/authz/permission-check.ts`), which `RequestContextInterceptor` calls right
  after opening the transaction; it asks the `PermissionEvaluator` seam (provided by the Authorization module: the
  permission's scope is non-empty today), which queries grants with `currentTx()` under the caller's tenant and RLS.
  A denial is a 403 and rolls the transaction back. `PermissionCheck` also fails closed on its own (undecorated → 403,
  anonymous → 401), so the decision never depends on the guard alone.
- **Identity seam**: `RequestIdentityResolver` (`src/platform/context/request-identity.ts`) returns
  `{userId, companyId, sessionId?}`. Default: `CookieIdentityResolver` (valid `hrf_at` access token → `sub`/`cid`/`sid`,
  verified statelessly; missing/invalid/expired → anonymous).
- **XSRF**: `XsrfGuard` (`src/platform/security/xsrf.guard.ts`, APP_GUARD registered before `PermissionGuard`) — every
  `POST`/`PUT`/`PATCH`/`DELETE` needs header `X-XSRF-TOKEN` equal to the `XSRF-TOKEN` cookie and signed for the caller's
  session (`sid` of the access cookie) or `anon` without one; otherwise 403 `urn:hrforce:problem:xsrf`. Header-only
  identities (DEV_AUTH, tests) have no session: get an anon token from `GET /api/auth/csrf` (the e2e helper
  `test/support/xsrf.ts` does exactly that).
- **Request context / transaction**: `RequestContextInterceptor` opens ONE transaction per request and runs
  `set_config('app.company_id'|'app.user_id'|'app.request_id', …, true)`; commit on success, rollback on error.
  Repositories call `currentTx()` from `src/platform/context` — never the root `KYSELY` instance.
  `@SkipTransaction()` opts a route out (health). Workers can use `runInRequestTransaction(db, scope, fn)`.
  Pool sessions start with `app.company_id` = nil UUID, so outside a request (or with no tenant) RLS matches nothing.
- **Development identity** (`DEV_AUTH=true`, development/test only): `DevHeaderIdentityResolver` also accepts
  `X-Dev-User-Id` / `X-Dev-Company-Id` (both must be UUIDs, otherwise the request is anonymous); a valid session cookie
  wins when both are present. It no longer grants permissions by itself: combine with `DEV_PERMISSIONS=allow_all`
  (`DevAllowAllPermissionEvaluator`, authenticated callers only). Wiring in `src/platform/authz/dev-auth.ts`; a loud
  warning is logged at boot for each flag. The web uses the real login (its dev proxy no longer injects headers).
- **Logging**: nestjs-pino with the redaction paths from CONVENTIONS (`src/platform/logging/redaction.ts`).

## Identity module (`src/modules/identity`)

Contract: [`docs/contracts/identity.md`](../../docs/contracts/identity.md); design: ADR 004. Layers: `domain/` (password
policy + bundled common-password list, throttle math, mail templates fr/ar/en), `infra/` (`IdentityRepository` over the
`auth.*` functions, argon2id hasher, cookie writer, mail adapters, invite/seed), `application/` (`AuthService`,
`PasswordService`, `MeService`), `api/` (controllers, zod DTOs, `@AuthXsrf()`).

| Endpoint | Access | Result |
|---|---|---|
| `GET /api/auth/csrf` | public | 204; sets `XSRF-TOKEN` if missing or not valid for the caller (session-bound when signed in) |
| `POST /api/auth/login` `{email, password}` | public + XSRF | 204 + `hrf_at`, `hrf_rt`, new `XSRF-TOKEN` · 401 `invalid-credentials` · 423 `account-locked` + `Retry-After` · 429 `too-many-attempts` + `Retry-After` · 403 `account-disabled` (only with the right password) · 422 missing fields |
| `POST /api/auth/refresh` | public + XSRF | 204 rotated cookies · 401 `session-expired` (cookies cleared, anon XSRF) · 409 `refresh-race` (nothing changed) |
| `POST /api/auth/logout` | public + XSRF | 204; revokes the session family, deletes `hrf_at`/`hrf_rt`, anon `XSRF-TOKEN` |
| `POST /api/auth/password/forgot` `{email}` | public + XSRF | 202 always; mails a 1 h reset link to an **active** account, ≤ 3 per account per hour |
| `POST /api/auth/password/setup` `{token, password}` | public + XSRF | 204 · 410 `token-invalid` · 422 `errors[{field:'password', code: too_short\|too_long\|contains_email\|common}]` |
| `GET /api/me` | `@Authenticated()` | `{user:{id,email,displayName,locale}, company:{id,code,name}, companies:[…], permissions: string[], scopes: {code: [{unitId, includeDescendants}]}}` (permissions/scopes from the Authorization module) |

**Flows.**
- *Login*: IP throttle (30 failures / 15 min → 429) → e-mail lock (5 failures / 15 min → 423 until 15 min after the 5th)
  → argon2id verify (`m=19456,t=2,p=1`; unknown e-mails and password-less accounts verify against a dummy hash) →
  invited = 401 (same body) → disabled = 403 → session in the user's default company (else the lowest company code).
  Every attempt writes `auth.login_event` (`success`/`bad_credentials`/`locked`/`disabled`/`throttled_ip`) with IP and
  user agent. `Retry-After` is an integer number of seconds. The client IP is `req.ip` (set `TRUST_PROXY_HOPS`).
- *Tokens*: `hrf_at` = HS256 JWT `{sub, cid, sid, iat, exp=+15 min}` (`HttpOnly; SameSite=Strict; Path=/api; Max-Age=900`);
  `hrf_rt` = 32 random bytes base64url, stored as sha-256 (`HttpOnly; SameSite=Strict; Path=/api/auth;
  Max-Age=<remaining of 7 days>`); `XSRF-TOKEN` = `<random>.<HMAC(random.'.'.(sid|anon))>` (`SameSite=Strict; Path=/`).
  `Secure` on all three when `COOKIE_SECURE=true`.
- *Refresh*: `auth.rotate_session` locks the presented row (`FOR UPDATE`) and decides atomically: live → rotate (row
  `rotated_at`, new row in the family, idle expiry `min(now+12 h, family start+7 d)`); rotated ≤ 10 s ago → `race` (409,
  nothing changed); revoked, or rotated > 10 s ago → `reuse` (whole family revoked, 401); expired → family revoked, 401;
  account no longer active/member → family revoked, 401.
- *XSRF on `/api/auth/*` POSTs*: after 15 min the access cookie is gone, so these routes (`@AuthXsrf()`) accept a token
  signed for `anon`, for the access cookie's `sid`, or for the session of the refresh cookie (looked up by hash).
  Every other unsafe route requires the access cookie's `sid` (or `anon` when not signed in).
- *Passwords*: 12–128 code points, must not contain the e-mail's local part (case-insensitive; local parts < 3 chars
  are not checked), not in the bundled ~1 000-entry common list (`domain/common-passwords.ts`). Setup links live 72 h,
  reset links 1 h, both `${WEB_BASE_URL}/password/setup?token=…`, single use; consuming one sets the password,
  `invited → active`, marks every pending token of the user used and **revokes all the user's sessions**.

**Database (`auth` schema, migration 0007).** `user_account`, `user_credential`, `user_company`, `refresh_session`,
`password_token`, `login_event` (append-only). `hrforce_app` has **no** privilege on these tables; the API calls
`SECURITY DEFINER` functions only (list and abuse notes in the migration header). They are excluded from `schema.ts`
(`.kysely-codegenrc.json`); the function results are typed by hand in `infra/identity.repository.ts`. The `/api/auth`
routes run without a request transaction (`@SkipTransaction()`), so a failed login is still recorded and a detected
reuse still revokes the family although the response is an error.
**Retention**: `login_event` rows are kept 180 days; the cleanup job comes with the worker (not yet implemented —
until then `delete from auth.login_event where at < now() - interval '180 days'` as the migrator).

**CLI** — the only way to create users until the admin UI (runs as the migrator; needs `MIGRATOR_DATABASE_URL`,
`WEB_BASE_URL`, `MAIL_TRANSPORT` and, for smtp, `SMTP_URL`):

```bash
npm run user:invite -w @hrforce/api -- --email salima@demo.dz --name "Salima Ould" --company DEMO [--locale ar]
```

Creates an **invited** account + membership (default company if it has none) and mails a 72 h setup link. Re-inviting
an invited account sends a new link; an active account only gets the membership; a disabled one is refused.

**Dev users** (`seed:dev`, company `DEMO`, password **`demo-password-2026`**, printed by the seed; never in production):

| id | e-mail | name | locale |
|---|---|---|---|
| `0190a5d0-0000-7000-8000-0000000000aa` | `rh.admin@demo.dz` | Amina Benali | fr |
| `0190a5d0-0000-7000-8000-0000000000ab` | `rh.est@demo.dz` | Karim Haddad | ar |
| `0190a5d0-0000-7000-8000-0000000000ac` | `lecture.ouest@demo.dz` | Samir Belkacem | fr |

`rh.admin` keeps the historical dev user id, so `X-Dev-User-Id: …aa` (DEV_AUTH) and a real login are the same person.
Their roles and scopes: see the Authorization module (seeded grants).

## Authorization module (`src/modules/authorization`)

Contract: [`docs/contracts/authorization.md`](../../docs/contracts/authorization.md); design: ADR 002 (permission
catalogue, roles, **grants scoped to an org unit — optionally its sub-units — over a date range**). Layers: `domain/`
(catalogue codes, system roles, separation-of-duties and date rules — unit-tested), `infra/` (`GrantScopeService`,
`GrantPermissionEvaluator`, `AccessRepository`, seeding), `application/` (`RolesService`, `GrantsService`), `api/`.

**Three layers, one job each.** The guard only checks that the permission is held *somewhere*
(`PermissionEvaluator` → "its scope is non-empty today"); repositories and use cases filter by *where*
(`ScopeService`); use cases enforce separation of duties. RLS on `company_id` stays the backstop.

**How scope is evaluated** (`infra/grant-scope.service.ts`):
- *effective grants* of the caller = `role_grant` rows of the caller in the caller's company with `valid @> today`
  (`AccessClock`, server local date); `ended_at` is irrelevant, the range is the truth;
- *scope(code)* = ∪ over effective grants whose role holds `code`: the grant's unit, plus its descendants in
  `org_unit_closure` (today's tree) when `include_descendants`;
- everything runs in the request transaction and is **memoised per request** (`requestMemo`, `platform/context`).

**Platform seam** (`src/platform/authz/scope-service.ts`), usable by any module without importing this one:
`ScopeService.scopeOf(code)` → Kysely sub-query of unit ids (`.where('u.id', 'in', await scopes.scopeOf(code))`),
`inScope(code, unitId)`, `unitIds(code)` (materialised set), `covers(code, unitId, withDescendants)` (whole subtree),
`coversCompany(code)`, `summary()` (for `/api/me`). The module is `@Global()` and provides both `PermissionEvaluator`
and `ScopeService`; with `DEV_PERMISSIONS=allow_all` (or a test evaluator) `ScopeService` is the platform's
`CompanyWideScopeService`: a held permission covers every unit of the company. Repositories **must** filter by it;
the matrix test below proves it for every route.

| Endpoint | Permission | Result |
|---|---|---|
| `GET /api/access/permissions` | `access.read` | `{items:[{code, group, sensitive, labels:{fr,ar,en}}]}` by group, then sort order |
| `GET /api/access/roles` | `access.read` | `{items:[{id, code, names:{fr,ar,en}, isSystem, permissions}]}` (system first) |
| `POST /api/access/roles` | `access.manage_roles` | `{code, names, permissions}` → 201 · 409 `role-code-taken` (case-insensitive) · 409 `role-escalation` · 422 unknown permission |
| `PATCH /api/access/roles/:id` | `access.manage_roles` | `{names?, permissions?}` · 409 `role-system-immutable` · 409 `role-escalation` (added permissions only) |
| `GET /api/access/users?q=` | `access.read` | members (via `auth.company_members`) with ≥ 1 current/future grant in the caller's `access.read` scope, or none at all; `grants` = those in scope; max 200 |
| `GET /api/access/grants?userId=&unitId=&includeEnded=` | `access.read` | `GrantView[]` whose unit is in the caller's `access.read` scope (`unitId` = grants on that exact unit) |
| `POST /api/access/grants` | `access.grant` | → 201 `GrantView` |
| `POST /api/access/grants/:id/end` | `access.grant` | `{validTo}` → 200 `GrantView`; out-of-scope id → 404 |

Separation of duties (409 problems): `grant-self` (grant to / end one's own), `grant-out-of-scope` (unit — and whole
subtree with `includeDescendants` — inside the caller's `access.grant` scope; unknown units too), `grant-escalation`
(caller holds every permission of the role over the unit/subtree), `grant-user-not-member`, `grant-dates` (new:
`validTo > validFrom`; end: `validFrom ≤ validTo ≤ current end`), `grant-duplicate` (same user + role + unit
overlapping in time — exclusion constraint), `role-*` above. Unknown role → 422 on `roleId`. `GrantView._actions`
has `end` when the caller could end it (not their own, not ended, `access.grant` over its unit/subtree).

**Organization scoping**: tree = units in `org_unit.read` scope plus their ancestors as context (`inScope: false`,
`_actions: []`); search/detail filtered (out of scope → 404, same body as an unknown id); create needs
`org_unit.create` on the parent (unreadable/unknown parent → 404, readable-only → 403 `forbidden-scope` with
`errors[{field:'parentId'}]`); update needs `org_unit.update` on the unit (readable-only → 403 `forbidden-scope`)
and, for a move, on the new parent (unreadable → 409 `org-unit-invalid-parent`/`not_found`, readable-only → 403
`forbidden-scope` on `parentId`); `_actions` come from the real scopes. A unit not in today's tree (future/ended)
follows its parent's scope. Sites stay company-wide.

**Database (migration 0008).** `permission` (global catalogue, 15 codes with fr/ar/en labels, SELECT-only, exempt
from `company_id`), `role` (code unique per company case-insensitively; code/company/is_system immutable),
`role_permission`, `role_grant` (`valid_from`, `valid_to`, generated `valid daterange [from, to)`; composite FKs with
`company_id` to `role` and `org_unit`; checks `granted_by ≠ user_id`, `ended_by ≠ user_id`; exclusion constraint
against overlapping identical grants; a trigger lets only `valid_to` move earlier; `DELETE` revoked from the app —
grants are never deleted). All tenant tables: FORCE RLS on `app.company_id`. `auth.company_members(company_id)` is a
SECURITY DEFINER function that refuses any company other than `current_setting('app.company_id')`.

**System roles** (seeded per company by `seed:dev`, and by `user:invite` when the company has none; permissions defined
in `domain/catalogue.ts`, synced by the seed, immutable through the API):

| Role | Permissions |
|---|---|
| `admin_rh_central` | everything except `employee.medical.read` |
| `rh_regional` | `org_unit.read`, `site.read`, `employee.read`, `employee.create`, `employee.update` |
| `lecture` | `org_unit.read`, `site.read`, `employee.read` |
| `admin_acces` | `org_unit.read`, `site.read`, `access.read`, `access.grant`, `access.manage_roles` |

No seeded role holds `employee.medical.read` (and therefore nobody can put it in a role or grant it through the API).

**Dev grants** (`seed:dev`, valid from 2026-01-01, with sub-units, ids `…000000000301–303`):
`rh.admin@demo.dz` → `admin_rh_central` on `DG`; `rh.est@demo.dz` → `rh_regional` on `REG-EST`;
`lecture.ouest@demo.dz` → `lecture` on `REG-OUEST`. So in dev, without `DEV_PERMISSIONS`, rh.est sees
DG → Département RX → Région Est (+ its agencies/services) and gets 404 on any Région Ouest unit.

## Organization module (`src/modules/organization`)

Contract: [`docs/contracts/organization.md`](../../docs/contracts/organization.md) (**v2**: one management tree —
Direction Générale → départements → (Département RX →) régions → agences, with services under a department, a region
or an agency; sites are places that host units). Layers: `domain/` (pure rules: kind catalogue + parent rules,
code/name, root rules, cycles, version splitting, tree building, effective site — unit-tested), `infra/` (Kysely
repositories via `currentTx()`, closure maintenance, demo seed), `application/` (use cases + `_actions`), `api/`
(controller, zod DTOs).

| Endpoint | Permission |
|---|---|
| `GET /api/org/kinds` | `org_unit.read` — kind catalogue (fr/ar/en labels, `allowedParents`), sorted by `sortOrder` |
| `GET /api/org/tree?asOf=` | `org_unit.read` (404 if no root unit exists on `asOf`) |
| `GET /api/org/units?q=&kind=&kind=&asOf=` | `org_unit.read` (max 50, ordered by code; `kind` repeats; unknown kind → 422) |
| `GET /api/org/units/:id` | `org_unit.read` |
| `POST /api/org/units` | `org_unit.create` → 201 + `Location` (any non-root kind; root/unknown kind → 422 on `kind`) |
| `PATCH /api/org/units/:id` | `org_unit.update` (name / parentId / siteId — `siteId: null` = inherit) |
| `GET /api/org/sites?q=` | `site.read` (max 200, ordered by code; q matches code, name or wilaya) |
| `POST /api/org/sites` | `site.create` → 201 `Site` (blank `address` → null) |

- **Kinds are data** (migration 0006): `org_unit_kind(code, label_fr, label_ar, label_en, sort_order, is_root)` and
  `org_unit_kind_parent(kind, parent_kind)` are a global reference catalogue (no `company_id`, exempt in
  `tools/guardrails/company-id-exempt.json`, `SELECT` only for `hrforce_app`). Seeded: `direction_generale` (root, 10),
  `department` (20), `region` (30), `agency` (40), `service` (50); parents `department→direction_generale`,
  `region→department`, `agency→region`, `service→department|region|agency`. Arabic labels use the usual Algerian
  administrative terms: المديرية العامة, دائرة, منطقة, وكالة, مصلحة. The API caches the catalogue per process
  (`OrgKindRepository`, first read through the request transaction) — adding a kind is a migration + restart.
- **Tables**: `org_unit` (`kind` → FK to the catalogue, axis `management`, immutable code — trigger; `is_root` is a
  copy of the kind's flag, filled by trigger and checked by the composite FK `(kind, is_root)`, so "one root unit per
  company" is the partial unique index `org_unit_one_root_uk`), `org_unit_version` (name + parent + `site_id` over a
  `valid daterange` `[from, to)`, no overlap per unit via a `btree_gist` exclusion constraint), `org_unit_closure`
  (ancestor/descendant/depth incl. self rows), `site` (code unique per company, name, wilaya, address). Composite FKs
  `(company_id, id)` make cross-tenant references impossible; every tenant table has FORCE RLS on `app.company_id`.
- **Sites / effective site**: a version's `site_id` is its own site (null = inherited). The effective site is the own
  site, else the nearest ancestor's, as of the requested date (`site` in tree/search/detail; `siteInherited` in the
  detail). The root must always have a site (409 `org-unit-root-site-required`); the root can be renamed and change
  site but never moved (409 `org-unit-root-immutable`). A `siteId` that does not exist in the caller's company → 409
  `site-not-found` on field `siteId`.
- **Versions**: `PATCH` closes the latest version at `validFrom` and opens a new one (name, parent and/or site);
  `validFrom` must be strictly after the latest version's start (else 409 `org-unit-version-overlap`). Defaults to
  today (server local date — set `TZ`).
- **Closure = tree as of today**: updated in the same transaction by create/move when the change takes effect on or
  before today. Future-dated changes are visible in `GET /org/tree?asOf=…` immediately but enter the closure only
  when rebuilt (`rebuildClosure(companyId, today)`; the daily job arrives with the worker; `seed:dev` rebuilds).
- **Search**: accent/case-insensitive through `search_normalize(text)` (SQL, `lower(translate(…))` of accented Latin
  letters) backing the generated column `org_unit_version.name_search`; the query text goes through the same function.
  `unaccent` is not used because it is not a trusted extension.
- **Errors**: 409 slugs `org-unit-code-taken` (field `code`), `org-unit-invalid-parent` (field `parentId`; codes
  `invalid_parent_kind`, `not_found`, `parent_not_effective`), `org-unit-cycle`, `org-unit-version-overlap` (field
  `validFrom`), `org-unit-root-immutable`, `org-unit-root-site-required` (field `siteId`), `site-code-taken` (field
  `code`), `site-not-found` (field `siteId`). Malformed or unknown/other-tenant path ids → 404.

### Upgrading a v1 database (org model v2)

Migration `0006_org_model_v2.sql` cannot map v1 units (kinds `company`/`region`/`site`) onto the v2 model and **fails
on purpose** if `org_unit` holds any row. The project is pre-production: recreate the database, then migrate and seed.

```bash
psql "$SUPERUSER_URL" -c 'drop database hrforce_dev with (force)' -c 'create database hrforce_dev owner hrforce_migrator'
npm run migrate -w @hrforce/api && npm run seed:dev -w @hrforce/api
```

### Demo seed

`npm run seed:dev -w @hrforce/api` (as `MIGRATOR_DATABASE_URL`, refuses `NODE_ENV=production`, idempotent) creates the
company `0190a5d0-0000-7000-8000-000000000001` (`DEMO`, Groupe Démo), its sites and units, valid from 2026-01-01, with
fixed ids `0190a5d0-0000-7000-8000-000000000<nnn>` (source: `src/modules/organization/infra/demo-seed.ts`).
Dev users: see the Identity module (`…-0000000000aa` = `rh.admin@demo.dz`).

| nnn | Sites (code — name, wilaya) |
|---|---|
| 201–207 | `ALG-HQ` Alger – Siège (Alger), `ALG-CTR` Alger Centre (Alger), `BLIDA`, `CNE` Constantine, `ANNABA`, `ORAN`, `TLEMCEN` |

| nnn | Units (code, own site; others inherit) |
|---|---|
| 101 | `DG` Direction Générale @ALG-HQ |
| 111–113 | `DEP-RH`, `DEP-FIN`, `DEP-RX` |
| 121–123 | `REG-CTR` @BLIDA, `REG-EST` @CNE, `REG-OUEST` @ORAN (under `DEP-RX`) |
| 131–136 | `AG-ALG` @ALG-CTR, `AG-BLIDA` @BLIDA (REG-CTR); `AG-CNE` @CNE, `AG-ANNABA` @ANNABA (REG-EST); `AG-ORAN` @ORAN, `AG-TLEMCEN` @TLEMCEN (REG-OUEST) |
| 141–145 | `SRV-PAIE`, `SRV-FORM` (DEP-RH); `SRV-COMPTA` (DEP-FIN); `SRV-ADM-EST` (REG-EST); `SRV-CLI-ANB` (AG-ANNABA) |

## Tests

```bash
npm test -w @hrforce/api                      # unit + e2e
npm run test:unit -w @hrforce/api
npm run test:e2e -w @hrforce/api
npm run typecheck -w @hrforce/api
```

- Unit tests: `src/**/*.spec.ts`. E2E / DB tests: `test/**/*.e2e-spec.ts`, built through `configureApp()` and hitting `/api/...`.
- Each e2e file gets a fresh, migrated database (`test/support/test-database.ts`):
  - `TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres` (superuser) → creates roles if missing
    and a throwaway `hrforce_test_*` database, dropped afterwards;
  - unset → starts `postgres:18-alpine` with Testcontainers (Docker required).
  - If the roles already exist on that cluster with other passwords, set `TEST_MIGRATOR_PASSWORD` / `TEST_APP_PASSWORD`.
- `test/support/test-app.ts` adds test-only routes and header-driven identity (`X-Test-User`, `X-Test-Company`);
  `createTestApp(db, { devAuth: true })` uses the real wiring instead (session cookie, else `X-Dev-*` headers, and
  `DEV_PERMISSIONS=allow_all` unless `devPermissions: false`), `evaluator` swaps the PermissionEvaluator, `mailSender`
  the MailSender (`RecordingMailSender`), `env` overrides variables, `configure: false` skips `configureApp`.
- Unsafe requests need an XSRF token: `fetchXsrf(app)` + `withXsrf(req, xsrf)` (`test/support/xsrf.ts`); the
  `Browser` helper (`test/support/cookie-jar.ts`) is a cookie jar honouring `Path` that echoes the XSRF header.
- `assertNoSecrets(body)` (`test/support/assert-no-secrets.ts`) fails on any key matching `/(password|hash|token|secret)/i`.
- **Authorization matrix** (`test/authorization-matrix.e2e-spec.ts`): one table, rows = route × actor × target →
  expected status, run against the real grants (`createTestApp(db, { devAuth: true, devPermissions: false })`, fixture
  `test/support/access-fixture.ts`: admin_rh_central on DG, rh_regional on REG-EST, lecture on REG-OUEST, admin_acces
  on REG-EST, and an admin of a second company; targets in REG-EST, in REG-OUEST, in the other company). The route
  list comes from `node tools/guardrails/route-scan/route-scan.ts --json`: **adding a route without a matrix entry (or
  changing its permission) fails the suite**; anonymous → 401 is derived for every non-public route. When you add an
  endpoint, add its row block there.
- `test/authorization.e2e-spec.ts`: tree/search/detail scoping, forbidden-scope, each SoD slug, escalation attempts,
  date-effective grants (`AccessClock` pinned to tomorrow via `createTestApp(..., { overrides })`), RLS/privileges on
  the new tables, `auth.company_members`, `/api/me`.

## Docker

```bash
docker build -f apps/api/Dockerfile -t hrforce-api .   # from the repo root
```

Multi-stage `node:22-alpine`, runs as the non-root `node` user, `HEALTHCHECK` on `/api/health`.
