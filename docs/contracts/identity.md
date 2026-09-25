# Contract — Identity slice (M1, step 3)

Binding contract between `apps/api` (Identity module) and `apps/web` (login, session, guards, password pages).
Implements ADR 004 (cookies + XSRF, argon2id, refresh rotation with reuse detection, Postgres-backed throttling, login history, password-setup links).
Out of scope: permissions and scopes (Authorization, next step), SSO/OIDC, MFA (M2), a user-admin UI.

## Data (migration 0007)

Accounts are **global** (one login per person across the group's companies); membership is per company.
Login happens before any tenant is known, so the account tables cannot sit behind the tenant RLS policy. They live in schema **`auth`**, and **`hrforce_app` has no privileges on any `auth` table**. The API reaches them only through `SECURITY DEFINER` functions in `auth` (owned by the migrator, `SET search_path = pg_catalog, auth`, `EXECUTE` granted to `hrforce_app`), each returning the minimum it needs. The guardrail's company-id check covers `public` only; list the `auth` tables in the exemption file anyway with the reason "global identity, reachable only via auth.* SECURITY DEFINER functions".

| Table | Columns (all `not null` unless marked) |
|---|---|
| `auth.user_account` | `id uuid pk`, `email text` (stored lower-case, unique), `display_name text`, `locale text` (`fr`/`ar`/`en`, default `fr`), `status text` (`invited`/`active`/`disabled`), `created_at` |
| `auth.user_credential` | `user_id pk → user_account`, `password_hash text` (argon2id PHC string), `updated_at` |
| `auth.user_company` | `user_id`, `company_id → public.company`, `is_default bool`, pk (`user_id`,`company_id`); at most one default per user |
| `auth.refresh_session` | `id uuid pk` (= session id `sid`), `family_id uuid`, `user_id`, `company_id`, `token_hash bytea` (sha-256 of the refresh token), `created_at`, `expires_at`, `rotated_at` null, `revoked_at` null, `revoke_reason` null, `ip inet` null, `user_agent text` null |
| `auth.password_token` | `id uuid pk`, `user_id`, `token_hash bytea`, `purpose` (`setup`/`reset`), `expires_at`, `used_at` null, `created_at` |
| `auth.login_event` | `id bigserial`, `at timestamptz`, `email text`, `user_id` null, `ip inet` null, `user_agent` null, `outcome` (`success`/`bad_credentials`/`locked`/`disabled`/`throttled_ip`) — append-only; index (`email`,`at`), (`ip`,`at`) |

## Tokens and cookies

| Item | Value |
|---|---|
| Access token | Compact HS256 JWT signed with `AUTH_ACCESS_SECRET` (env, ≥ 32 chars). Claims `sub` (user id), `cid` (active company id), `sid` (refresh session id), `iat`, `exp` = +15 min. Verified statelessly per request. |
| Refresh token | 32 random bytes, base64url; stored only as sha-256. Lifetime 12 h idle / 7 days absolute from family start. |
| Rotation | Each refresh marks the current row `rotated_at` and inserts a new row in the same family. Presenting a revoked token, or a rotated one more than **10 s** after its rotation, **revokes the whole family** (`revoke_reason='reuse'`) and returns 401. A rotated token presented within those 10 s (two tabs refreshing at once) is not reuse: return **409** `urn:hrforce:problem:refresh-race` and change nothing; the losing tab already has the new cookies from the winner and simply retries its original request. |
| Cookie `hrf_at` | access token; `HttpOnly; SameSite=Strict; Path=/api; Max-Age=900` |
| Cookie `hrf_rt` | refresh token; `HttpOnly; SameSite=Strict; Path=/api/auth; Max-Age` = remaining absolute lifetime |
| Cookie `XSRF-TOKEN` | readable by JS; `SameSite=Strict; Path=/`; value = `<random>.<hmac>` where hmac = HMAC-SHA256(`AUTH_XSRF_SECRET`, random + '.' + (sid or 'anon')) — a **signed** double-submit token bound to the session; re-issued on login, refresh and logout |
| `Secure` flag | on every cookie when `COOKIE_SECURE=true` (default true; the env schema allows false only when `NODE_ENV` is development or test) |

XSRF check: every `POST`/`PUT`/`PATCH`/`DELETE` under `/api` needs header `X-XSRF-TOKEN` equal to the `XSRF-TOKEN` cookie and a valid signature for the caller's `sid` (or `anon` without a session). Failure → **403** `urn:hrforce:problem:xsrf`. `GET /api/auth/csrf` always passes and sets a fresh anon token when none is present.

## Identity resolution and permissions (platform seams)

- A new `CookieIdentityResolver` replaces the anonymous resolver: valid `hrf_at` → `{userId: sub, companyId: cid}`; expired/invalid → anonymous (the client then refreshes).
- `DEV_AUTH` (header identity, dev/test only) stays for API tests and curl; when both a valid cookie and dev headers are present, the cookie wins. The web dev proxy **stops** injecting dev headers — the web uses real login.
- Until the Authorization module exists, `DEV_PERMISSIONS=allow_all` (env, dev/test only, refused otherwise) makes the evaluator grant every permission to any **authenticated** caller. Without it every protected route stays 403, as today.

## Endpoints (under `/api`, problem+json errors)

| Method + path | Guard | Body → result |
|---|---|---|
| `GET /auth/csrf` | `@Public` | → 204, sets `XSRF-TOKEN` |
| `POST /auth/login` | `@Public` + XSRF | `{email, password}` → 204 + `hrf_at`, `hrf_rt`, new `XSRF-TOKEN`. Errors: **401** `invalid-credentials` (same body for unknown email, wrong password, invited/no password); **423** `account-locked` with `Retry-After` seconds (email throttle); **429** `too-many-attempts` with `Retry-After` (IP throttle); **403** `account-disabled` only after a correct password |
| `POST /auth/refresh` | `@Public` + XSRF | no body; uses `hrf_rt` → 204 rotated cookies; **401** `session-expired` (missing/invalid/expired/reused — clears cookies); **409** `refresh-race` |
| `POST /auth/logout` | `@Public` + XSRF | → 204; revokes the session family if any; clears `hrf_at`/`hrf_rt`; new anon `XSRF-TOKEN` |
| `GET /me` | authenticated, no permission (new decorator `@Authenticated()`; route-scan must accept it) | → `{ user: {id, email, displayName, locale}, company: {id, code, name}, companies: [{id, code, name}] }` — Authorization will add `permissions` and `scopes` later |
| `POST /auth/password/forgot` | `@Public` + XSRF | `{email}` → **202** always (no account enumeration); sends a reset link if the account is active; max 3 per email per hour |
| `POST /auth/password/setup` | `@Public` + XSRF | `{token, password}` → 204; sets the hash, marks token used, `invited`→`active`, **revokes all the user's sessions**; errors **410** `token-invalid` (unknown/expired/used), **422** `errors[{field:'password', code:'too_short'\|'too_long'\|'contains_email'\|'common'}]` |

Throttling (Postgres, from `auth.login_event`): **email**: 5 failures in 15 min → locked until 15 min after the 5th failure (423); **IP**: 30 failures in 15 min → 429. Unknown emails still run an argon2 verify against a fixed dummy hash (constant-ish timing). Old `login_event` rows: keep 180 days (cleanup job comes with the worker; note it in the README).

Passwords: 12–128 chars, must not contain the email's local part (case-insensitive), must not be in a small bundled common-password list (top 1 000 is enough). No composition rules (NIST 800-63B). argon2id `m=19456 KiB, t=2, p=1` (OWASP), via `@node-rs/argon2` (prebuilt binaries, no compiler).

Links: `${WEB_BASE_URL}/password/setup?token=…` for both setup and reset (the page's text differs by `purpose`, which the web doesn't know — keep one wording: "Choose your password"). Setup tokens live 72 h, reset tokens 1 h.

Mail: `MailSender` port with two adapters: `smtp` (nodemailer to `SMTP_URL`, Mailpit in dev via docker-compose) and `log` (writes the message incl. link to the logger at `info`, **dev/test only**). `MAIL_TRANSPORT=smtp|log`. Mails in the user's locale (fr/ar/en), plain text + simple HTML.

## CLI and seed

- `npm run user:invite -w @hrforce/api -- --email x@y --name "…" --company <code> [--locale fr]` creates an invited account + membership and sends a setup link (runs as migrator; it is the only way to create users until the admin UI).
- `seed:dev` adds two active users in Groupe Démo with password `demo-password-2026` (dev only, printed by the seed): `rh.admin@demo.dz` (Amina Benali, fr) and `rh.est@demo.dz` (Karim Haddad, ar). Fixed ids documented in the seed.

## Web

- `GET /api/auth/csrf` at startup (app initializer), then `GET /api/me` → a root `Session` service holding `user`/`company` signals (`null` = signed out).
- Functional guards: `authGuard` on every route except `/login`, `/password/setup`, `/password/forgot`, `**`; redirects to `/login?returnUrl=…`. `guestGuard` on `/login` sends signed-in users home.
- 401 handling interceptor: on a 401 from any `/api` call except `/api/auth/*`, call `POST /api/auth/refresh` **once for all concurrent requests** (single flight), then retry the original request once; if refresh fails, clear the session and navigate to `/login?returnUrl=`; on 409 `refresh-race` just retry.
- Login page: real call; 401 → "invalid credentials", 423/429 → locked message with the minutes from `Retry-After`; success → `returnUrl` or `/`. Language switches to `user.locale` after login unless the user already picked one on this device.
- `/password/setup?token=` page (password + confirm, strength hints matching the server rules, maps 422/410) and `/password/forgot` page (always shows "if the address exists, a link was sent").
- Shell header: user's display name + company name, and a "Sign out" button (POST logout, then `/login`).
