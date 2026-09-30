# @hrforce/api

NestJS HTTP API for HRForce Next. Phase 1 "platform skeleton": config, logging, problem+json errors,
request context + one transaction per request, Postgres RLS, migrations and deny-by-default route guard.
The binding contract is [`CONVENTIONS.md`](../../CONVENTIONS.md).

Stack: Node 22, NestJS 12 (ESM, Express 5), TypeScript 7 (legacy decorators + `emitDecoratorMetadata`),
Kysely 0.29 + `pg`, zod 4, nestjs-pino / pino 10, Vitest 5 (SWC via `unplugin-swc` for decorator metadata).

## Quick start

```bash
# 1. Postgres with the three roles (hrforce_migrator, hrforce_app, hrforce_worker) and an `hrforce` database, + Mailpit
cd apps/api && docker compose up -d          # or run scripts/create-roles.sql against your own cluster
cp .env.example .env                          # then load it: set -a; . ./.env; set +a

# 2. Migrate (as hrforce_migrator), seed the demo organisation + demo users, run
npm run migrate -w @hrforce/api
npm run seed:dev -w @hrforce/api              # idempotent; demo company, org units, 3 users, roles + grants (see below)
npm run build -w @hrforce/api && npm start -w @hrforce/api
npm run start:worker -w @hrforce/api          # other terminal: background jobs (notification e-mails, cron)
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
`docker compose --profile api up -d` also runs the API and worker images against these services.
`scripts/dev-up.sh` / `scripts/dev-up.ps1` (repo root) do all of this, API + worker + web, in one command.

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
| `AUTH_MFA_KEY` | in production | public dev key (dev/test only, **insecure**) | base64 of exactly 32 bytes (`openssl rand -base64 32`): AES-256-GCM key of the TOTP secrets. Production refuses to boot without it (or with the dev key) |
| `ATTENDANCE_KEY` | in production | public dev key (dev/test only, **insecure**) | base64 of exactly 32 bytes (`openssl rand -base64 32`): HMAC key of the attendance QR codes, scan receipts and device references (docs/contracts/attendance.md). Production refuses to boot without it (or with the dev key); rotating it only invalidates live codes (≤ 2 min) and receipts (≤ 5 min) |
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

**Worker** (`node dist/worker.js`; schema `workerEnvSchema`, same file): `WORKER_DATABASE_URL` (**required**,
`hrforce_worker` role), `WORKER_CONCURRENCY` (1–32, default `4`), `WORKER_HEARTBEAT_FILE` (default
`/tmp/hrforce-worker.alive`, read by `dist/worker-health.js`), and the API's `WEB_BASE_URL`, `MAIL_TRANSPORT`,
`SMTP_URL`, `MAIL_FROM`, `NODE_ENV`, `LOG_LEVEL` (same rules: `log` transport only in development/test). The API
ignores the `WORKER_*` variables; the worker never needs the API's secrets.

## Database

### Roles (cluster-level, created outside migrations)

Roles are cluster-wide and need `CREATEROLE`/superuser, so migrations only *grant* to them; they are
created by `scripts/create-roles.sql` (psql; used by `docker-compose.yml` via `scripts/docker-init-roles.sh`)
and by the test harness.

- `hrforce_migrator` — `LOGIN BYPASSRLS`, owner of the database and therefore of `public` (PG15+). Runs DDL and data migrations.
- `hrforce_app` — `LOGIN NOSUPERUSER NOBYPASSRLS`, owns nothing. Gets `select, insert, update, delete` on
  every table the migrator creates through `ALTER DEFAULT PRIVILEGES` (migration 0001).
- `hrforce_worker` — `LOGIN NOSUPERUSER NOBYPASSRLS`, the background worker (migration 0012): `SELECT` on `public`
  (RLS applies — every job sets `app.company_id` first), `INSERT` on `leave_ledger`, `DELETE` on `notification`,
  `EXECUTE` on `public.job_company_ids()`, `auth.notification_recipient()`, `auth.cleanup_login_events()`,
  `auth.cleanup_password_tokens()`, `audit.ensure_partitions()`, and everything in the `graphile_worker` schema.
  **An existing cluster** (created before 0012): run `create-roles.sql` again (idempotent) — migration 0012 stops with
  a clear message while the role is missing.

```bash
psql "$SUPERUSER_URL" -v migrator_password="'…'" -v app_password="'…'" -v worker_password="'…'" -v db=hrforce \
     -f apps/api/scripts/create-roles.sql
```

### Migrations

- Plain SQL, forward-only: `migrations/NNNN_description.sql` (4 digits, contiguous from 0001, lowercase snake_case).
- `npm run migrate -w @hrforce/api` compiles and runs `dist/platform/db/migrate.js` with `MIGRATOR_DATABASE_URL`.
  In the Docker image: `node dist/platform/db/migrate.js`. After the SQL files it installs / upgrades the **job queue
  schema** (Graphile Worker's own migrations into `graphile_worker`, as the migrator) and re-applies its grants
  (`src/platform/db/worker-schema.ts`: the worker gets everything there; `hrforce_app` only `EXECUTE` on
  `graphile_worker.add_job`, made `SECURITY DEFINER`). Neither the API nor the worker ever runs DDL.
- Runner (`src/platform/db/migrator.ts`): session advisory lock, `public.schema_migrations(version, name, checksum, applied_at)`
  with the file's sha256, each migration in its own transaction. It refuses to run on malformed names, gaps,
  applied migrations missing on disk, or a checksum change of an applied migration — never edit an applied file.
- Tenant tables: `company_id uuid not null` + `enable` **and** `force row level security` + policy
  `using (company_id = current_setting('app.company_id', true)::uuid)`. Tables exempt from `company_id`
  (`schema_migrations`, `company`, the `org_unit_kind*` and `permission` catalogues) are listed in `tools/guardrails/company-id-exempt.json`.
  Global reference catalogues are `SELECT`-only for `hrforce_app` (revoke the default DML grants in the migration).

### `schema.ts` (Kysely types)

`src/platform/db/schema.ts` is generated by `kysely-codegen` (config: `.kysely-codegenrc.json`, reads
`MIGRATOR_DATABASE_URL`, excludes `schema_migrations`, the `auth` and `graphile_worker` schemas and the monthly `audit.*_y…`/`*_default`
partitions — the audit parents `audit.change_log`, `audit.event`, `audit.masked_column` are typed). After adding a migration:

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
**Retention**: `login_event` rows are kept 180 days and used/expired `password_token` rows 30 days — the worker's
daily `auth.cleanup` job (definer functions `auth.cleanup_login_events()` / `auth.cleanup_password_tokens()`).

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

## Two-step sign-in (`src/modules/identity` MFA, contract `docs/contracts/mfa.md`, migration 0013)

**Flow.** `POST /api/auth/login` checks the password as before. With an **active** factor it answers
`200 {mfaRequired: true}` and sets only `hrf_mfa` (`HttpOnly; SameSite=Strict; Path=/api/auth/mfa; Max-Age=300`), a
signed JWT `{sub, cid, mfa: <challenge id>, pur: 'mfa'}`. `POST /api/auth/mfa/verify` (`@Public` + XSRF, anon token
accepted) takes `{code}` (TOTP: HMAC-SHA1, 6 digits, 30 s, current step ±1, a step ≤ the last used one is a replay)
or `{recoveryCode}` and issues the usual session cookies. Access tokens now carry `pur: 'access'`; each verifier
accepts only its own purpose, so the pending token is never an access token and vice versa. A wrong code → `401
mfa-invalid` + `login_event` `mfa_failed` (counts toward the per-e-mail lock: 5 failures in 15 min, wrong passwords
and wrong codes together → 423); 5 failures on one challenge kill it (`401 mfa-challenge-expired`, start over).

**Enrollment** (`/api/me/mfa*`, `@Authenticated` + `@AllowWithoutMfa`): `enroll/start` → `{secret (base32),
otpauthUri (issuer HRForce, label HRForce:<email>), qrPng (PNG data URL, server-side `qrcode`; the CSP allows
img-src data:)}`; `enroll/confirm {code}` → 10 recovery codes shown once; `recovery-codes {code}` → a new set;
`disable {code}` (409 `mfa-required-by-policy` when required). Wrong codes there: 422 `mfa-invalid` (and they count
toward the lock). `GET /api/me` has `mfa: {enabled, required, recoveryCodesLeft}`.

**Recovery codes.** 10 per set, 10 characters of `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, shown as `XXXXX-XXXXX`; case,
spaces and hyphens are ignored; stored as sha-256; single use (row lock); each use mails the user ("N left") and
records `auth.mfa_recovery_used`. Regenerating voids the whole previous set.

**Enforcement.** `public.security_policy` (tenant, RLS, audited): `mfa_enforced` (default true),
`mfa_required_permissions` (default: every `sensitive` permission + `access.grant`, `access.manage_roles`,
`leave.configure`; a company without a row has these defaults). A user holding any listed permission anywhere must
use MFA: until enrolled, every non-public route answers **403 `mfa-enrollment-required`** — decided once in
`PermissionCheck` (platform) through the `MfaRequirement` seam (Authorization module) — except routes marked
`@AllowWithoutMfa()`: `GET /me`, `/me/mfa*`, `GET /me/notifications/unread-count` (listed in
`tools/guardrails/mfa-exempt.json`; `/auth/*` is public). `GET/PUT /api/access/security-policy` needs
`access.manage_roles`; PUT needs it over the whole company (else 403 `forbidden-scope`). `seed:dev` turns enforcement
**off** for DEMO; `bootstrap` creates the row with the defaults (the first admin enrolls at first sign-in).

**Admin reset.** `POST /api/access/users/:id/mfa/reset` (`access.grant`, same visibility rule as
`GET /access/users/:id` on the access.grant scope; 404 outside, 409 `mfa-reset-self`): removes the factor and codes,
kills open challenges, revokes every refresh session of the user (`mfa_reset`; the access token lives ≤ 15 min), mails
them, audits `auth.mfa_reset`. The factor is per ACCOUNT (accounts are global): a reset applies in every company.
**Lost phone and no codes:** ask an admin with `access.grant` over you for this reset, then enroll again.

**Storage and key handling.** `auth.user_mfa.secret_enc` = AES-256-GCM(nonce ‖ ciphertext ‖ tag), key `AUTH_MFA_KEY`,
the user id as additional data (a value copied to another user does not decrypt). `hrforce_app` has no privilege on
the three MFA tables; the SECURITY DEFINER functions (0013's header lists what each returns) hand `secret_enc` out only
for the owner of a live login challenge, or for the transaction's own `app.user_id`. **Key rotation is out of scope**:
changing `AUTH_MFA_KEY` makes every stored secret undecryptable (every enrolled user must be reset). Keep the key
backed up separately from the database dumps. A future rotation would decrypt with the old key and re-encrypt with the
new one in one migration-time job (store a key id next to `secret_enc`).

Audit events: `auth.mfa_enrolled`, `auth.mfa_disabled`, `auth.mfa_recovery_regenerated`, `auth.mfa_reset`,
`auth.mfa_recovery_used`, and `auth.login` gains `data.mfa: 'totp'|'recovery'`. Log redaction: request-body `code` /
`recoveryCode`, `recoveryCodes`, `secret`, `otpauthUri`, `qrPng`, the `hrf_mfa` cookie. Tests: `test/mfa.e2e-spec.ts`,
`test/mfa-logs.e2e-spec.ts`, `src/modules/identity/domain/mfa.spec.ts` (RFC 6238 / 4226 vectors).

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
| `GET /api/access/users/:id` | `access.read` | one item of the list above (same shape, same visibility rule); otherwise, unknown, other-company or malformed id → 404 |
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

**Database (migration 0008).** `permission` (global catalogue, 15 codes with fr/ar/en labels — 16 with `audit.read` from 0009, SELECT-only, exempt
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
| `admin_acces` | `org_unit.read`, `site.read`, `access.read`, `access.grant`, `access.manage_roles`, `audit.read` (0009) |

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

## Audit module (`src/modules/audit`)

Contract: `docs/contracts/audit.md` (ADR 005). Migration `0009_audit.sql`, schema `audit`.

**Model — two sources, deliberately doubled:**

- **Row changes** (`audit.change_log`) are written **only by the trigger** `audit.capture()` (`SECURITY DEFINER`, owner
  migrator, `search_path` pinned), attached `AFTER INSERT OR UPDATE OR DELETE FOR EACH ROW` to every tenant table of
  `public` (`company`, `org_unit`, `org_unit_version`, `site`, `role`, `role_permission`, `role_grant`). Exempt:
  `org_unit_closure` (derived from the versions, rebuilt wholesale) — `tools/guardrails/audit-exempt.json`;
  `guard:db` fails on any tenant table without an `audit%` trigger (CONVENTIONS.md › Audit).
  One row = `company_id` (the row's; `id` for `company`), `table_name`, `row_id` (the `id` column, or the trigger
  argument: `role_permission` is keyed on `role_id`), `op`, `actor_user_id` / `request_id` (from `app.user_id` /
  `app.request_id`; **null** when unset — migrations, `seed:dev`, psql), `before`, `after`, `changed`:
  insert → `after` + every column; delete → `before` + every column; update → only the changed columns (+ the row
  id) and **no row at all** when nothing changed. Generated columns (`org_unit_version.name_search`,
  `role_grant.valid`) are left out (derived). Values are `to_jsonb` of the column: dates `"2027-01-01"`, ranges
  `"[2027-01-01,2027-07-01)"`, timestamps with offset.
- **Masking:** a row in `audit.masked_column(table_name, column_name)` makes the trigger store `"***"` for any
  non-null value of that column (it still appears in `changed`); the timeline also shows `"***"` and `masked: true`,
  including for rows captured before the column was masked. Employment adds its salary/bank/NSS/medical columns there.
- **Application events** (`audit.event`): `auth.login {ip, userAgent}`, `auth.logout {}`, `auth.password_set
  {purpose}`, `auth.session_reuse {familyId}` (actor null: detected by the system), `access.grant_created` /
  `access.grant_ended {grantId, roleCode, unitId, validFrom, validTo}` — subject = the user. Emitted through the
  platform port `AuditEvents` (`src/platform/audit`, implemented here, global): `record()` writes inside the request
  transaction (rolled back with it); `recordFor({companyId, actorUserId})` opens its own short transaction with
  `app.company_id` set — used by `/api/auth/*`, which has no request transaction (login: the session's company;
  logout/reuse: the refresh session's; password set: the user's default company, via `auth.session_owner()` /
  `auth.default_company()`). Both call `audit.record_event()` (definer), which takes company, actor and request id from
  the settings, never from arguments.
- **Append-only:** `hrforce_app` has `SELECT` on `audit.change_log`, `audit.event` and `audit.masked_column` only
  (RLS + FORCE, standard `company_id` policy: events without a company are invisible), nothing on the partitions, and
  `EXECUTE` on `audit.record_event` only. A `BEFORE UPDATE OR DELETE` row trigger (and a `BEFORE TRUNCATE` one) refuses
  any change **even for the owner** unless the transaction sets `set local audit.allow_purge = 'on'`.

**Partitions and retention.** Both log tables are `PARTITION BY RANGE (at)` per UTC month
(`audit.change_log_y2026m09`, …) with a `DEFAULT` partition as a safety net. `audit.ensure_partitions(months_ahead)`
(idempotent, definer, not granted to the app) creates the current month + `months_ahead`; the migration ran it with 12.
**The worker's cron job `audit.ensure_partitions` calls `audit.ensure_partitions(12)` on the 1st of every month**
(`EXECUTE` granted to `hrforce_worker`); without a running worker, re-run it by hand before the horizon ends, or rows
fall into the default partition (a month whose rows already sit in the default partition cannot be created until
they are moved — the function says so). Retention (e.g. dropping or detaching old
monthly partitions, or deleting with `audit.allow_purge`) is not implemented yet.

**Reading the history — `GET /api/audit/timeline?subject=<type>:<id>&before=<cursor>&limit=50`** (`@Authenticated`;
every subject type needs `audit.read` — held by the system roles `admin_rh_central` and `admin_acces`, 403 otherwise —
except `leave_request`, which follows the request's own visibility):

| subject | entries | visible when |
|---|---|---|
| `org_unit:<id>` | `org_unit` rows + all its `org_unit_version` rows (renames, moves, site changes) + events about it | the unit is in the caller's `audit.read` scope |
| `user:<id>` | `role_grant` rows of the user's grants **whose unit is in scope** + events about the user (auth.*, access.grant_*) | member of the company, and one of their grants is in scope or they have none |
| `role:<id>` | `role` + `role_permission` rows | `audit.read` anywhere (company-wide) |
| `site:<id>` | `site` rows | `audit.read` anywhere |
| `employee:<id>` (employment id) | employment, assignments, salaries, person, person_sensitive rows + its `leave_request` rows + the `workflow.*` events about its requests | the employee's scope unit is in the caller's `audit.read` scope |
| `leave_request:<id>` | the request, its `workflow_instance` and `workflow_task` rows + `workflow.*` events | **no audit.read needed**: `leave.read` over the request's unit, the requester, the employee's linked user, or a current candidate of its open task (else 404) |

Unknown, other-company, out-of-scope or malformed ids → **404**; unknown type → 422 (`subject`/`invalid_subject`), bad
cursor → 422 (`before`/`invalid_cursor`), `limit` 1–100 (default 50). Newest first by `(at, kind, id)` — all rows of
one request share `at`, and an event is listed before the row changes of the same instant; `nextCursor` (opaque) is
null on the last page. Each entry: `{id: "c:<n>"|"e:<n>", at, actor: {id, displayName}|null, requestId, kind,
table?, op?, changes?: [{field, before, after, masked}], event?: {type, data}}`; `changes` follow the stored column
order and use raw column names (`name`, `parent_id`, `site_id`, `valid`, `permission_code`, `valid_to`, `ended_by`…).
`actor.displayName` comes from `auth.company_members` (a former member shows their id); `actor: null` = system / seed
/ migration.

```bash
curl -s -b jar "http://localhost:3000/api/audit/timeline?subject=org_unit:0190a5d0-0000-7000-8000-000000000134&limit=20"
# more: append &before=<nextCursor>
# SQL (migrator/psql): select at, table_name, op, actor_user_id, changed, before, after from audit.change_log
#                       where table_name = 'org_unit_version' order by at desc, id desc limit 20;
```

## Employment module (`src/modules/employment`)

Contract: `docs/contracts/employment.md`. Migration `0010_employment.sql`.

**Data.** `person` (Latin names required, Arabic optional, NIN 18 digits unique per company), `person_sensitive`
(NSS, RIB, bank name — a separate table so field permissions are a join), `employment` (matricule
`^[A-Z0-9][A-Z0-9-]{0,19}$`, immutable; hire/end date, end date INCLUSIVE; at most one open per person, no overlap per
person), `assignment` and `employment_salary` (date-effective `[from, to)` ranges, exclusion constraint per employment;
salary is `numeric(12,2)`, DZD). A **deferred** constraint trigger checks at commit that the first assignment starts on
the hire date and that nothing starts before the hire date or runs past the end date (the API checks first and answers
409; the database is the backstop). DELETE is revoked from `hrforce_app` (history is kept). Masked in the audit log:
`person_sensitive.nss/rib/bank_name`, `employment_salary.base_salary`. `org_unit_version.name_ar` (optional Arabic
unit name, date-effective like `name`).

**Scope as of a date.** An employee's *scope assignment* on date D is the one valid on D, else the latest one started
before D (an ended employment → its last one), else its first one. The employee is in scope for P when that
assignment's unit is in the caller's P scope (grants, today's closure). The list does this in ONE SQL statement: a
recursive CTE builds the tree on D (each unit's version valid on D, else its earliest), its effective sites and — for
`unitId` — the sub-units on D; a `LATERAL` sub-select picks each employment's scope assignment; the page and `total`
(window count) come from the same filtered set. `status=active` (default) = not ended on `asOf` (future hires
included, `status: 'future'`), `ended` = ended before `asOf`, `all`.

**Field blocks.** `salary` / `bank` / `nss` need `employee.{salary,bank,nss}.read` over the employee's scope unit;
otherwise the key is omitted and listed in `_redacted`. Writes: `employee.update` over the current unit (a new
assignment also needs update or create over the new unit → else 403 `forbidden-scope` on `orgUnitId`); sensitive
blocks in `POST /employees` without `employee.<block>.update` → 403 `forbidden-field` (`errors[{field: 'salary'|'bank'|'nss'}]`).
Money is a decimal string both ways (`"85000.00"`; JSON numbers are refused).

**Search.** `search_normalize()` (0005, extended in 0010) = lower + Latin accents folded + Arabic normalisation:
tashkeel (U+064B–U+0652), superscript alef and tatweel stripped; أ إ آ ٱ → ا; ى → ي; ة → ه; ؤ → و; ئ → ي. Generated
columns `person.search_text` (both name orders, Latin + Arabic, NIN), `employment.matricule_search` and
`org_unit_version.name_search` (name + name_ar) use it, with `pg_trgm` GIN indexes for `LIKE '%…%'`; the query text
goes through the same function.

```bash
curl -s -b jar "http://localhost:3000/api/employees?q=%D8%B3%D8%A7%D8%B1%D9%87&sort=hireDate&dir=desc&pageSize=10"
curl -s -b jar "http://localhost:3000/api/employees/0190a5d0-0000-7000-8002-00000000001c"     # EMP-0028
```

**Demo seed** (`src/modules/employment/infra/demo-employees.ts`, run by `seed:dev`): 40 **fictitious** employees
(TEST DATA — invented names, NIN/NSS/RIB with test markers), deterministic ids `0190a5d0-0000-7000-8001-…` (persons),
`…-8002-…` (employments, `EMP-0001`…`EMP-0040` = …001…028 hex), `…-8003-…` (assignments), `…-8004-…` (salaries).
12 in Région Est (11 active), 7 in Région Ouest (6 active); ended: EMP-0025 (Constantine, 2026-06-30) and EMP-0040
(Tlemcen, 2026-03-31); moves: EMP-0015 (Blida → Alger Centre), EMP-0029 (Constantine → Annaba), EMP-0039 (Oran →
Tlemcen); salaries for all, with a raise on 2026-01-01 for every third one. Most units get an Arabic name.

## Leave & workflow (`src/modules/{staffing,workflow,leave}`)

Contract: `docs/contracts/leave.md`; engine design: `docs/adr/006-workflow-engine.md`; migration `0011_leave_workflow.sql`.

**Model.**
- *Staffing* — `user_employment` (a user IS an employee; self-service needs it; `PUT /access/users/:id/employment`,
  shown as `employment` on `GET /access/users/:id`) and `org_unit_head` (date-effective head per unit, no overlap;
  `PUT /org/units/:id/head` closes the previous head; today's head is `head` on `GET /org/units/:id`).
  **Manager** of an employee on D = head (on D) of their unit, else — or if they are that head — the nearest ancestor's
  head (tree as of D); the approving user is the head's linked user (`GET /me/employment` shows it as `manager`).
- *Workflow* — `workflow_definition` (ordered `manager` / `permission` steps), `workflow_instance`, `workflow_task`.
  Candidates of a permission task are computed at read time through `ScopeService`; the requester and the employee's
  linked user never act (409 `workflow-self-approval`, also a DB trigger); a manager step that nobody can take
  (no head, head not linked, head = requester) is recorded as a `skipped` task with outcome `escalated` and the HR
  step opens. Acting row-locks the task: a concurrent second approver gets 409 `workflow-task-closed`.
  Events `workflow.{start,approve,reject,escalate,cancel}` go to `audit.event`.
- *Leave* — `leave_policy` (reference year start month 7, weekend `{5,6}`, `entitlement_delay_months` 12),
  `leave_type` (Algerian defaults, all editable), `public_holiday`, `leave_request` (days computed by the API; no two
  pending/approved requests of an employment overlap — partial exclusion constraint), `leave_ledger` (append-only:
  `accrual` / `taken` / `adjustment` / `reversal`; balance = sum per employment, type, reference year).
- Days (`domain/days.ts`): `calendar` counts every day; `working` skips weekend days and holidays; half days are
  0.5 on the first / last day. A year's accrued days are usable from `period_start + entitlement_delay_months` (days
  earned July N-1 → June N are taken from 1 July N); non-accrued balance types (recovery) at once. On final approval
  `taken` rows go to the oldest usable year first (409 `leave-balance` if it no longer suffices); cancelling an approved
  request that has not started writes `reversal` rows.

**Accruals.** `POST /api/leave/accruals/run {"month":"YYYY-MM"}` (`leave.adjust`; months after the current one → 422)
writes one `accrual` row per employment × accrual type × month (unique index → idempotent, safe to re-run or run
concurrently) for the employees of the caller's `leave.adjust` scope. A month **counts when ≥ 15 of its days fall
inside the employment** (absences are not tracked yet); it earns `accrual_days_per_month` (2.5), capped at
`max_days_per_year` (30) per reference year, plus the site's `south_supplement_days` spread over the 12 months with
cumulative rounding. `seed:dev` runs July 2025 → September 2026.

```bash
curl -s -b jar -c jar -H "X-XSRF-TOKEN: $XSRF" -H 'Content-Type: application/json' \
  -d '{"month":"2026-09"}' http://localhost:3000/api/leave/accruals/run
# {"month":"2026-09","employees":40,"eligible":39,"created":0,"alreadyAccrued":39}
```

**The worker** (next section) runs the monthly accrual (1st of the month, previous month, every company). Still to
come on it: reminders / auto-escalation of tasks open for N days, re-assigning open manager tasks when a unit head
changes, the daily closure refresh for future-dated org changes.

**Demo** (`seed:dev`, password `demo-password-2026`): `agent.annaba@demo.dz` (EMP-0030, Agence Annaba, role
`employe`), `chef.annaba@demo.dz` (EMP-0029, head of Agence Annaba), `rh.est@demo.dz` linked to EMP-0022 (head of
Région Est: Karim is HR and a manager). Heads: DG, DEP-RH, REG-EST, AG-ANNABA (from 2026-04-01), AG-CNE (EMP-0025
until 2026-06-30, then EMP-0026 — not linked: requests there escalate to HR). Seven requests cover every status
(approved, cancelled, rejected, pending at manager, pending at HR, escalated, the chef's own request approved by Karim).

## Notifications, worker and live updates (`src/modules/notifications`, `src/worker*`)

Contract: `docs/contracts/notifications.md`; migration `0012_notifications_worker.sql`; ADR 005 (Postgres only).

**Notifications.** `notification` (one row per recipient; `read_at`) and `notification_preference` (e-mail on/off per
user and type; no row = the type's default). RLS = the tenant policy **plus a restrictive own-user policy for
`hrforce_app`** on SELECT/UPDATE/DELETE (`user_id = app.user_id`): a user never reads or marks another user's rows,
even in their company (an INSERT for someone else is allowed — without `RETURNING`, which would need their SELECT
policy; that is also why the insert uses `ON CONFLICT DO NOTHING` without a conflict target). `notification` is
audit-exempt (derived from audited workflow events; `tools/guardrails/audit-exempt.json`); preferences are audited.
Workflow and Leave create notifications through the platform port `Notifier` (`src/platform/notifications`), inside
the request transaction:

| Type | Created by | Recipients (never the actor) | Link |
|---|---|---|---|
| `task.assigned` | engine, when a task opens (incl. after escalation) | assignee, or every holder of the step permission over the unit today (`role_grant` + closure) — minus requester and employee | `/tasks?task=<task id>` |
| `task.escalated` | engine, manager step skipped | the requester — **even when they are the actor** (the engine decided, not them) | `/me/leave?request=…` (employee) |
| `leave.approved` / `leave.rejected` | leave hooks | requester + employee's linked user (deduplicated) | employee: `/me/leave?request=<id>`; requester filing for someone else: `/leave/requests/<id>` |
| `leave.cancelled` | leave hook | the candidates of the task that was open | `/tasks` |
| `leave.submitted_on_behalf` | leave, request filed by someone else | the employee's linked user | `/me/leave?request=<id>` |

`data`: `requestId, employeeName, employeeNameAr (null when none), leaveType (code), startDate, endDate, days,
actorName` (+ `taskId, stepKey` for task.assigned, `stepKey, escalationReason` for task.escalated) — never a reason,
comment or balance. One notification per (recipient, type, subject): a repeated hook is a no-op.

**Endpoints** (all `@Authenticated`, own rows only — someone else's id → 404): `GET /api/me/notifications?unreadOnly=&before=&limit=`
(newest first, `nextCursor`), `GET …/unread-count`, `POST …/:id/read` (204, idempotent), `POST …/read-all` (204),
`GET|PUT /api/me/notification-preferences` (`[{type, email, default}]` / body `[{type, email}]`, unknown or duplicate
type → 422), `GET /api/me/notifications/stream` (SSE).

**Live stream (SSE).** Events `unread` `{count}` (on open and on every change), `notification` (a `NotificationView`),
comment `: ping` every 25 s, `retry: 5000`. Fan-out: the insert trigger sends `NOTIFY hrforce_notifications
{companyId, userId, id}` (delivered on commit; mark-read routes send `id: null` = "count changed"); **one** `LISTEN`
connection per API process (`NotificationHub`, `application_name` `hrforce-api-listen`, reconnects while anyone
listens) dispatches to that user's open streams, which re-read the row **under RLS as the user** in a short
transaction (the stream itself holds no transaction: `@SkipTransaction`). The stream ends when the access token behind
it expires (≤ 15 min; DEV_AUTH identities: 15 min); the client refreshes through an ordinary call and reconnects.
Headers: `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no` (Nginx); Caddy flushes `text/event-stream`.

```bash
curl -N -b jar localhost:3000/api/me/notifications/stream     # event: unread / data: {"count":2} …
```

**Worker** (`src/worker.ts` → `node dist/worker.js`, same image as the API; `npm run worker -w @hrforce/api` builds
then runs, `npm run start:worker` runs the build). Graphile Worker 0.18 as `hrforce_worker`; `WORKER_CONCURRENCY` jobs
at a time; one JSON log line per job (`job done` / `job failed`: task, jobId, attempt, durationMs, result);
SIGTERM/SIGINT → no new jobs, running ones finish; container health = heartbeat file (`dist/worker-health.js`).
Jobs are enqueued by the API through the platform port `JobQueue` (`graphile_worker.add_job` in the request
transaction: rollback = no job).

| Job | When | What |
|---|---|---|
| `notifications.email` | one per new notification | re-checks the preference and the account (inactive → skipped), renders fr/ar/en (`domain/mail-templates.ts`) with `${WEB_BASE_URL}` + link, sends via `MAIL_TRANSPORT`; errors → retried (5 attempts) |
| `audit.ensure_partitions` | cron `10 0 1 * *` | `audit.ensure_partitions(12)` |
| `leave.accruals` | cron `0 1 1 * *` | `runAccruals` for the month before the tick, every company (payload `{"month":"YYYY-MM"}` for a manual run) |
| `auth.cleanup` | cron `0 3 * * *` | `auth.cleanup_login_events()` (> 180 days), `auth.cleanup_password_tokens()` (used/expired, > 30 days) |
| `notifications.cleanup` | cron `30 3 * * *` | notifications read > 90 days ago, every company |

Cron times are the worker's time zone (UTC in the containers); missed ticks are backfilled (7 days for the monthly
jobs, 12 h for the daily ones); every job is idempotent. Tenant jobs run **company by company**
(`public.job_company_ids()`), each in its own transaction with `app.company_id` set, `app.user_id` empty (audit actor =
system) and `app.request_id = job:<task>:<job id>`; one company failing does not stop the others (the job then fails
and is retried). Enqueue a job by hand (psql as the migrator):
`select graphile_worker.add_job('leave.accruals', '{"month":"2026-08"}');`

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
  - If the roles already exist on that cluster with other passwords, set `TEST_MIGRATOR_PASSWORD` / `TEST_APP_PASSWORD`
    / `TEST_WORKER_PASSWORD` (`hrforce_worker`, default `hrforce_worker_test`; `db.workerUrl` in the tests).
  - The harness also installs the job queue schema (like `npm run migrate`).
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
  endpoint, add its row block there. SSE routes set `stream: true` (the row checks the status and the
  `text/event-stream` type through `test/support/sse.ts`, then disconnects).
- `test/notifications.e2e-spec.ts` (recipients per type, outbox, restrictive RLS, endpoints, SSE) and
  `test/worker.e2e-spec.ts` (e-mail job with a fake mailer, the real Graphile runner as `hrforce_worker`, cron tasks,
  cleanups, the worker role's limits).
- `test/authorization.e2e-spec.ts`: tree/search/detail scoping, forbidden-scope, each SoD slug, escalation attempts,
  date-effective grants (`AccessClock` pinned to tomorrow via `createTestApp(..., { overrides })`), RLS/privileges on
  the new tables, `auth.company_members`, `/api/me`.

## Docker

```bash
docker build -f apps/api/Dockerfile -t hrforce-api .   # from the repo root
```

Multi-stage `node:22-alpine`, runs as the non-root `node` user, `HEALTHCHECK` on `/api/health`. The same image runs
the worker with `command: ["node", "dist/worker.js"]` (compose overrides the health check with
`node dist/worker-health.js`).

## First company on an empty database (`bootstrap`)

`npm run bootstrap -w @hrforce/api -- --company-code X --company-name "…" --root-code DG --root-name "…" [--root-name-ar "…"] --site-code HQ --site-name "…" --wilaya "…" --admin-email a@b --admin-name "…" [--locale fr]`
(as `MIGRATOR_DATABASE_URL`) creates the company, root unit + site, system roles, leave defaults and workflows, and the
first admin (invited, setup link mailed) with `admin_rh_central` on the whole company. Refuses an existing company code.
Logic in `src/scripts/bootstrap-company.ts`, tested in `test/bootstrap.e2e-spec.ts`.
