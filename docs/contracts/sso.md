# Contract — SSO: HRForce as an OpenID Connect provider, app roles, demo sister app

Binding contract between:
- `apps/api`: a new module `sso`, plus small additions to Identity, Staffing, Authorization, platform
  security/logging/config and the worker;
- `apps/web`: the sign-in handoff page `/sso/:uid`, Access → Applications, the user detail's app roles, and a guide
  chapter;
- the new workspace `apps/sso-demo` (`@hrforce/sso-demo`), a tiny relying party.

Design, library facts and threat reasoning: **ADR 007** (Proposed).

Owner decision (2026-09-30):
- HRForce becomes an **OpenID Connect provider** inside the API, using `oidc-provider`, with Postgres only.
- **Roles of connected apps are managed in HRForce** and travel in the ID token, for that app only.
- The scope is "enough for a demo":
  - client registration by an admin;
  - sign-in through HRForce's own sign-in page and two-step verification;
  - no consent screen;
  - an ID token with the identity and the app roles;
  - logout;
  - `apps/sso-demo`, a Node app using `openid-client`, authorization code + PKCE.

Versions (verified in a prototype, ADR 007):
- `oidc-provider@9.12.2` (API dependency);
- `@types/oidc-provider@9.12.1` (API dev dependency);
- `openid-client@6.8.8` (dependency of `apps/sso-demo`, and dev dependency of `apps/api` for the e2e round trip).

Pin exact versions, as the rest of the repo does.

One phase: everything below is built together. The *Out of scope* section at the end lists what comes later.

## ⚠ Assumptions to confirm with the owner

| # | Assumption | Default in this contract | Where it lives |
|---|---|---|---|
| 1 | Client ownership | A client app belongs to **one company** (the one of the admin who registers it). Only **members of that company** may sign in to it. The claims (company, employee, roles) are computed in that company, whatever company the HRForce session is using. A group-wide app is registered once per company | `sso_client.company_id` |
| 2 | Subject | `sub` = the HRForce **user id** (a random UUID): stable, meaningless, the **same for every app** (useful for the later outbox integration). Not pairwise | provider config |
| 3 | Logout | An app's "Se déconnecter" (RP-initiated logout with the user's ID token) **also signs the user out of HRForce in that browser** (shared workstations: otherwise the next person gets signed in silently). It does not sign the user out of other apps (no back-channel logout yet). Signing out inside HRForce does not sign anyone out of the apps | ADR 007 §6 |
| 4 | Who manages apps and assignments | `admin_acces` and `admin_rh_central`, **company-wide only** (a regional access admin can read but not change). Both writing permissions require two-step sign-in (security policy) | seed, `security_policy` |
| 5 | Assignments | An app role is assigned to a user for the **whole company** (no org-unit scope, no validity period). A user may hold several roles of one app | `sso_role_assignment` |
| 6 | No role, no refusal | A company member with **no role** in an app still signs in: `roles: []`, and the app decides what to show (the demo shows "no role in this app") | claims |
| 7 | Secret rotation | Rotating an app's secret **replaces it at once** (no overlap): the app's configuration must be updated right away | `POST /sso/clients/:id/rotate-secret` |
| 8 | Lifetimes | Authorization code 60 s, ID token 5 min, access token (userinfo only) 5 min, **no refresh tokens**, sign-in handoff (interaction) 15 min | provider config |
| 9 | Redirect URIs | Exact match; `https://` anywhere, `http://` only for loopback hosts (`localhost`, `127.0.0.1`, `[::1]`, any port) in every environment (the demo and developer laptops) | validation |
| 10 | Client ids | Chosen by the admin (`^[a-z][a-z0-9-]{2,39}$`), **unique across the group** (an id taken by another company is refused with a message that says so) | `sso_client.client_id` |
| 11 | Employee claim | Filled when the user is linked to an employment in the app's company (`user_employment`): matricule and the unit of today's assignment (Algiers date) | claims |

**Questions for the owner (not assumptions):**
- (a) Which real apps will connect, and on what stack (OIDC library available? `client_secret_basic` or `_post`?). This
  decides whether `private_key_jwt` or SAML (through a separate IdP) is needed later.
- (b) Should the demo app also run on staging (a second domain name and a compose profile; see *Out of scope*)?

> **Owner decisions 2026-09-30:** ADR 007 accepted. Logout from a connected app **also ends the HRForce session** in that browser (as designed). Clients are **per company**: only that company's members sign in; apps and role assignments are managed company-wide by `admin_acces` and `admin_rh_central` with two-step sign-in; nobody assigns roles to themselves; a user with no role in the app still signs in and the app receives `roles: []`. Other assumptions in the table above stay defaults to confirm.

## Wording (fr / ar, gender-neutral Arabic — owner rule 2026-09-29)

| Key idea | fr | ar |
|---|---|---|
| module (Access tab) | Applications connectées | التطبيقات المرتبطة |
| app role(s) | Rôle d'application / Rôles d'application | دور التطبيق / أدوار التطبيق |
| handoff in progress | Connexion à « {app} »… | جارٍ تسجيل الدخول إلى «{app}»… |
| login banner (returnUrl `/sso/…`) | Connectez-vous pour continuer vers l'application. | يرجى تسجيل الدخول للمتابعة نحو التطبيق. |
| handoff expired / unknown | Cette demande de connexion a expiré. Veuillez recommencer depuis l'application. | انتهت صلاحية طلب تسجيل الدخول. يرجى إعادة المحاولة من التطبيق. |
| not a member | Ce compte n'a pas accès à « {app} ». | لا يملك هذا الحساب صلاحية الوصول إلى «{app}». |
| app unavailable | Cette application est désactivée ou inconnue. | هذا التطبيق معطّل أو غير معروف. |
| fresh login | L'application demande une nouvelle connexion. | يطلب التطبيق تسجيل الدخول من جديد. |
| back to the app | Retourner à l'application | العودة إلى التطبيق |
| switch account | Changer de compte | تغيير الحساب |
| secret shown once | Ce secret ne sera plus jamais affiché. Copiez-le maintenant dans la configuration de l'application. | لن يُعرض هذا الرمز السري مرة أخرى. يرجى نسخه الآن في إعدادات التطبيق. |
| logout page (auto) | Déconnexion en cours… | جارٍ تسجيل الخروج… |
| logout page (confirm) | Se déconnecter de HRForce et de « {app} » ? | تسجيل الخروج من HRForce ومن «{app}»؟ |
| signed out | Vous êtes déconnecté(e). | تم تسجيل الخروج. |

Arabic never uses a masculine imperative: « يرجى + masdar », verbal nouns, passive.

---

## Data (migration 0018)

### Tenant tables (`public`)

All three follow the house rules:
- `company_id`, RLS + FORCE + the standard policy;
- composite `(company_id, …)` FKs;
- the audit trigger `audit_capture_tg`;
- users referenced without FK (as `role_grant.user_id`).

| Table | Columns | Rules |
|---|---|---|
| `sso_client` | `id uuid pk default gen_random_uuid()`, `company_id`, `client_id text`, `name text` (1–80, trimmed), `name_ar text null` (1–80), `status text` (`active`/`disabled`), `secret_enc bytea` (AES-256-GCM: nonce 12 ‖ ciphertext ‖ tag 16, key = the `aead` subkey of `OIDC_KEY`, AAD = `client_id`), `credential_set_at timestamptz`, `client_auth_method text` (`client_secret_basic`/`client_secret_post`, default basic), `redirect_uris text[]` (1–10), `post_logout_redirect_uris text[]` (0–10, default `'{}'`), `created_by uuid null`, `created_at`, `disabled_at null`, `disabled_by null`, `disabled_reason null` (3–500) | **Global** `unique (client_id)` (the provider looks clients up before any tenant is known). Check on the `client_id` pattern. `status = 'disabled'` ⇔ the three `disabled_*` columns are set. `client_id` is immutable (BEFORE UPDATE trigger). No DELETE for `hrforce_app` (disable instead). Unique (`company_id`, `id`) for the composite FKs. **Masked** in the audit diff: `secret_enc` |
| `sso_app_role` | `id`, `company_id`, `sso_client_id` (FK → `sso_client`), `code text` (`^[a-z][a-z0-9_]{1,39}$`, immutable), `name_fr`, `name_ar`, `name_en` (1–80), `created_at` | unique (`sso_client_id`, `code`); DELETE allowed (the FK from assignments is `on delete restrict`) |
| `sso_role_assignment` | `id`, `company_id`, `sso_app_role_id` (FK, `on delete restrict`), `user_id uuid`, `assigned_by uuid null`, `assigned_at timestamptz default now()` | unique (`sso_app_role_id`, `user_id`); `check (assigned_by is null or assigned_by <> user_id)` (separation of duties, as `user_employment`); index (`company_id`, `user_id`); DELETE allowed = removal (captured by the trigger) |

**Global client lookup** (the pattern of `attendance_pairing_lookup`):
- `public.sso_client_by_client_id(p_client_id text)` returns `(id, company_id, client_id, name, name_ar,
  secret_enc, client_auth_method, redirect_uris, post_logout_redirect_uris)`, **active clients only**.
- It is `SECURITY DEFINER`, owned by the migrator (BYPASSRLS), with `set search_path = pg_catalog, public`.
- `EXECUTE` goes to `hrforce_app` only.

`permission_group_ck` gains `sso`.

### Provider state (schema `oidc`, global)

The provider state lives before and outside any tenant: interactions exist before sign-in, and tokens are looked up
by value. The rules:
- No `company_id` and no RLS.
- Add the tables to `tools/guardrails/company-id-exempt.json` with the reason "global OIDC provider state, keyed by
  hashed ids; reachable only by the SSO module".
- They are not audited (operational, high churn, no business data; sign-ins are audited as events).

| Table | Columns | Privileges |
|---|---|---|
| `oidc.model_store` | `model text`, `id_hash bytea` (sha-256 of the id), `payload jsonb`, `grant_id text null`, `uid_hash bytea null`, `expires_at timestamptz null`, `consumed_at timestamptz null`; pk (`model`, `id_hash`); indexes (`grant_id`) where not null, (`model`, `uid_hash`) where not null, (`expires_at`) | `hrforce_app`: SELECT, INSERT, UPDATE, DELETE. `hrforce_worker`: SELECT, DELETE |
| `oidc.signing_key` | `kid text pk`, `alg text` (`RS256`), `status text` (`next`/`current`/`retired`), `jwk_enc bytea` (AES-256-GCM, AAD = `kid`), `created_at`, `activated_at null`, `retired_at null`; partial unique index: at most one `current`, at most one `next` | `hrforce_app`: SELECT, INSERT (first key at boot only). Rotation runs as the migrator (CLI) |
| `oidc.client_auth_failure` | `id bigserial`, `at timestamptz default now()`, `ip inet null`, `client_id text` (≤ 64, truncated); index (`ip`, `at`) | `hrforce_app`: SELECT, INSERT. `hrforce_worker`: SELECT, DELETE |

- **Adapter (`modules/sso/infra/oidc-adapter.ts`).** It implements the library's `Adapter` for every model except
  `Client`, over `oidc.model_store`:
  - `upsert` stores `sha256(id)`. It removes from the payload every top-level field whose value equals the id (`jti`,
    and `uid` for `Interaction`), keeps their names in `payload.__idFields`, and restores them on `find`.
  - `grantId` → `grant_id`; `payload.uid` → `uid_hash`; `expiresIn` → `expires_at`.
  - `find` ignores expired rows. `consume` sets `consumed_at`, and `find` returns `consumed` (epoch seconds) from it.
  - `revokeByGrantId` deletes by `grant_id`. `findByUid` looks up by `uid_hash`. `findByUserCode` returns `undefined`
    (no device flow).
  - `Client` is served by `sso_client_by_client_id` → the metadata below.
  - It runs on the root pool (no request context); these are not tenant tables.
- **Client metadata returned for an active client:**
  - `client_id`, `client_secret` (decrypted; a decryption failure logs an error with the `client_id` and returns
    `undefined`, i.e. `invalid_client`), `client_name` = `name`;
  - `redirect_uris`, `post_logout_redirect_uris`;
  - `grant_types: ['authorization_code']`, `response_types: ['code']`, `response_modes: ['query']`;
  - `token_endpoint_auth_method`, `id_token_signed_response_alg: 'RS256'`, `require_auth_time: true`,
    `scope: 'openid profile email hrforce'`;
  - `hrforce_company_id` (extra metadata, `extraClientMetadata.properties`).

### Identity additions (schema `auth`, definer functions only, as before)

- `auth.refresh_session` gains `amr text[] not null default '{pwd}'`.
  - `auth.create_session` gains a parameter `p_amr text[] default '{pwd}'`. The MFA verify path passes
    `{pwd,otp,mfa}` (TOTP or recovery code).
  - `auth.rotate_session` copies `amr` to the new row.
- New `auth.sso_session(p_sid uuid, p_user_id uuid)` returns
  `(live boolean, auth_time timestamptz, amr text[], account_status text)`:
  - `live` is true when the refresh session `p_sid` of `p_user_id` exists and the idle and absolute limits are not
    reached;
  - `auth_time` = the `created_at` of the **first** row of its family (the login instant);
  - `account_status` = the user's status;
  - it returns no row for an unknown `sid`.

  The session is live only if **neither the row itself nor any row of its family** is revoked: a revoked family (the
  logout, reuse detection, an MFA reset or a password setup revoke the whole family) is not live, even when the
  access token's own row was never revoked.
- Membership and profile come from the existing `auth.me(p_user_id, p_company_id)` (active member only).

### Security policy

`security_policy.mfa_required_permissions`: the column default **and every existing row** gain `sso.manage_apps` and
`sso.assign`.

## Keys, secrets, environment

- **`OIDC_KEY`** (API env): base64 of exactly 32 bytes (`openssl rand -base64 32`), validated like `AUTH_MFA_KEY`.
  - Required in production; development/test fall back to a public `DEV_OIDC_KEY` (insecure, warned at boot).
  - Production refuses the dev key, and a value equal to `AUTH_MFA_KEY` or `ATTENDANCE_KEY`.
  - Subkeys via HKDF-SHA256 (empty salt):
    - info `hrforce/oidc/aead`: the AES-256-GCM key of `secret_enc` and `jwk_enc`;
    - info `hrforce/oidc/cookies`: the provider's cookie-signing key (`cookies.keys`, one entry).
- **Client secret:** 32 random bytes, base64url (43 characters). It is returned once, by create and by rotate
  (`clientSecret`), and never readable again.
- **Signing keys:**
  - RSA 2048, generated with `node:crypto` (`generateKeyPairSync('rsa')`, exported with `format: 'jwk'`), `alg:
    'RS256'`, `use: 'sig'`, `kid = 'k-' + <yyyymmdd> + '-' + <8 random hex>`.
  - At boot the SSO module loads every non-pruned key and orders them `current`, `next`, `retired` (the provider signs
    with the first RS256 key).
  - If no `current` key exists, it creates one inside a transaction holding `pg_advisory_xact_lock(hashtext('oidc.signing_key'))`.
  - If a key cannot be decrypted (a wrong or changed `OIDC_KEY`), the API still starts, `/oidc/*` answers **503**
    `{"error":"temporarily_unavailable"}`, and an `error` log says what to do. The rest of HRForce is unaffected.
- **Rotation CLI** (as the migrator, like `bootstrap`): `npm run oidc:keys -w @hrforce/api -- <command>`. Restart the
  API after each command (`docker compose restart api`, or the next deploy).
  - `status` lists the keys.
  - `stage` creates a `next` key (published in the JWKS, not signing).
  - `promote` (only after the `next` key has been published ≥ 24 h, unless `--now`) makes `next` → `current` and the
    old `current` → `retired`.
  - `prune` deletes `retired` keys retired more than 7 days ago (`--now`: all retired).
  - `reset` retires every key that cannot be decrypted and creates a fresh `current` (after a lost `OIDC_KEY`). The
    clients' secrets must then be rotated, since they are unreadable too.
- **Emergency** (suspected key leak): `stage` + `promote --now` + `prune --now` + restart. Apps refetch the JWKS on an
  unknown `kid`.
- `OIDC_KEY` itself has no rotation in this slice (as `AUTH_MFA_KEY`; README note).

## Provider configuration (exact)

Built by `modules/sso/infra/oidc-provider.factory.ts` (an async Nest provider, resolved at `NestFactory.create`).
It is mounted in `configureApp()` right after the request-id and cookie-parser middleware:
```ts
app.use('/oidc', oidcAccessLog, oidcHostCheck, app.get(OIDC_HTTP_HANDLER))
```
This is before Nest's body parsers, and outside the `api` prefix.

| Setting | Value |
|---|---|
| issuer | `${WEB_BASE_URL}/oidc` (no separate env variable) |
| `provider.proxy` | `TRUST_PROXY_HOPS > 0`; Koa `maxIpsCount` = `TRUST_PROXY_HOPS` |
| `adapter` | the Postgres adapter above |
| `jwks` | the decrypted keys (private JWKs) |
| `features` | `devInteractions`, `pushedAuthorizationRequests`, `dPoP`, `resourceIndicators`, `introspection`, `revocation`, `registration`, `clientCredentials`, `backchannelLogout`, `deviceFlow`, `ciba`, `jwtResponseModes`, `webMessageResponseMode`: **disabled**. `userinfo`: enabled. `rpInitiatedLogout`: enabled, with `logoutSource` and `postLogoutSuccessSource` = HRForce pages (below) |
| `scopes` | `['openid', 'profile', 'email', 'hrforce']` (no `offline_access`) |
| `claims` | `openid: ['sub', 'amr', 'auth_time']` (without them the ID token carries neither; checked in the prototype), `profile: ['name', 'preferred_username', 'locale']`, `email: ['email', 'email_verified']`, `hrforce: ['company', 'employee', 'roles']` |
| `conformIdTokenClaims` | `false` (the scope claims go in the ID token) |
| `pkce` | `required: () => true`; methods `['S256']` |
| `responseTypes` | `['code']` |
| `clientAuthMethods` | `['client_secret_basic', 'client_secret_post']` |
| `enabledJWA.idTokenSigningAlgValues` | `['RS256']` |
| `clientBasedCORS` | `() => false` (the apps call `/oidc/token` and `/oidc/me` from their servers) |
| `ttl` | `AuthorizationCode: 60`, `IdToken: 300`, `AccessToken: 300`, `Interaction: 900`, `Session: 43200`, `Grant: 43200` |
| `cookies.names` | `session: 'hrf_op_session'`, `interaction: 'hrf_op_interaction'`, `resume: 'hrf_op_resume'` |
| `cookies.long` | `{ httpOnly: true, sameSite: 'lax', path: '/oidc', secure: COOKIE_SECURE }` |
| `cookies.short` | `{ httpOnly: true, sameSite: 'lax', secure: COOKIE_SECURE }` (the library sets each short cookie's path) |
| `cookies.keys` | `[<cookies subkey, base64url>]` |
| `interactions.url` | `(ctx, i) => '/api/sso/interactions/' + i.uid` |
| `interactions.policy` | `interactionPolicy.base()` + on the `login` prompt a first check `new Check('hrforce_session', 'End-User authentication is required', 'login_required', ctx => !ctx.oidc.result?.login)` |
| `loadExistingGrant` | reuse `ctx.oidc.result?.consent?.grantId ?? ctx.oidc.session.grantIdFor(clientId)` when it exists; otherwise a new `Grant` for the client and account with `addOIDCScope('openid profile email hrforce')`, saved (first-party: no consent) |
| `findAccount` | below (*Claims*) |
| `extraClientMetadata.properties` | `['hrforce_company_id']` |
| `renderError` | HRForce error page (below) |
| `discovery` | override `response_modes_supported` with `['query']` if the library honours it (else leave it, see ADR 007 gotcha 13) |

Koa middleware (`provider.use`), in this order:

1. **CSP.** Before `next()`, set on every response:
   ```
   Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'<extra>
   ```
   `<extra>` is set only on `GET/POST /oidc/session/end`: ` <origin>` of the `post_logout_redirect_uri` parameter when
   it parses as an absolute `http(s)` URL. This is harmless: the provider only ever redirects to a *registered* one.
   The library then appends `sha256-` hashes of its own inline scripts.
2. **Host check.** A request whose `ctx.origin` differs from the issuer's origin → **400** (plain text), before
   anything else.
3. **Token-endpoint throttle.** For `POST /oidc/token`: if the caller's IP has **≥ 20** rows in
   `oidc.client_auth_failure` in the last 15 minutes → **429**,
   `Retry-After: <seconds until the oldest counted row is 15 min old>`, body
   `{"error":"temporarily_unavailable","error_description":"too many failed client authentications"}`. After `next()`,
   a `401 invalid_client` answer inserts one row (`ip`, `client_id` from the Basic header or body, truncated).
4. **Logout page for sessionless logout.** After `next()` on `GET/POST /oidc/session/end` with a 200 answer and no
   `ctx.oidc.session.accountId` (the library rendered its own auto-submitting form), replace the body with the HRForce
   logout page in *auto* mode, built with `ctx.oidc.session.state.secret`.

Provider events → logger (never tokens, codes, secrets or hints):
- `server_error` → `error` with `err`;
- `authorization.error`, `grant.error`, `end_session.error` → `warn` with `{event, error: err.error, clientId}`.

**Access log for `/oidc`:** `oidcAccessLog` writes one `info` line per request (`method`, path **without the query
string**, `status`, `ms`, `requestId`). `nestjs-pino`'s HTTP logger never sees these requests (ADR 007 gotcha 12).
No headers and no bodies are logged.

## Claims

`findAccount(ctx, sub)`:
1. Take `companyId = ctx.oidc.client['hrforce_company_id']` (extra metadata keeps its snake_case name on the client
   instance; checked in the prototype). `auth.me(sub, companyId)`: no row → `undefined` (the user is
   no longer an active member, and the provider answers with an error).
2. Otherwise return `{accountId: sub, claims()}`. `claims()` runs one `runInRequestTransaction(db, {companyId,
   userId: sub, requestId: <new uuid>})` and returns:

```ts
interface HrforceClaims {
  sub: string;                      // HRForce user id (uuid)
  name: string;                     // display name
  preferred_username: string;       // e-mail (lower-case)
  locale: 'fr' | 'ar' | 'en';
  email: string;
  email_verified: true;             // accounts are activated through an e-mailed link
  company: { id: string; code: string; name: string };
  employee: {
    matricule: string;              // e.g. "EMP-0030"
    active: boolean;                // the employment is open today (Algiers date)
    unit: { id: string; code: string; name: string; nameAr: string | null } | null;  // today's assignment unit; null when none
  } | null;                         // null: the user is not linked to an employment in this company
  roles: string[];                  // codes of the user's roles in THIS client, sorted; [] when none
}
```

- The scopes filter what is returned: `profile`, `email` and `hrforce` are optional for the client to ask for, and
  `openid` is required. `conformIdTokenClaims: false` puts them in the ID token, and userinfo returns the same claims
  for the same scopes.
- Standard claims added by the library: `iss`, `aud`, `exp`, `iat`, `nonce`, plus `auth_time` (the HRForce login
  instant) and `amr` (`["pwd"]`, or `["pwd","otp","mfa"]` after two-step sign-in) from the login result, because
  `openid` lists them and clients have `require_auth_time`. No `sid` claim (no front- or back-channel logout).
- Claim names are fixed by this contract. **`roles` is the only authorization claim.** An app must not derive rights
  from `company`, `employee` or `unit`; they are display data.

## Sign-in flow (interaction handoff), step by step

```
RP ──302──▶ /oidc/auth?client_id&redirect_uri&scope&state&nonce&code_challenge(S256)&response_type=code
     provider: client + redirect_uri + PKCE checks → Interaction (uid) → cookies
       hrf_op_interaction (Path=/api/sso/interactions/<uid>) + hrf_op_resume (Path=/oidc/auth/<uid>)
     ──303──▶ /api/sso/interactions/<uid>                 (API, @Public: format check only)
     ──303──▶ /sso/<uid>                                   (Angular, no guard)
Angular: GET /api/sso/interactions/<uid>/details          (@Public, needs hrf_op_interaction)
  ├─ signed out ───────▶ /login?returnUrl=/sso/<uid>  (password → second factor → back to /sso/<uid>)
  ├─ must enroll MFA ──▶ (complete answers 403 mfa-enrollment-required) → /me/security?enroll=1&returnUrl=/sso/<uid>
  ├─ freshLoginRequired ▶ POST /api/auth/logout → /login?returnUrl=/sso/<uid>
  └─ signed in ────────▶ POST /api/sso/interactions/<uid>/complete   (@Authenticated + XSRF + hrf_op_interaction)
                           ◀── 200 {redirectTo: "<issuer>/auth/<uid>"}
                         location.assign(redirectTo)
/oidc/auth/<uid> (resume, needs hrf_op_resume) ──303──▶ RP redirect_uri?code&state&iss
RP (server) ──POST /oidc/token (Basic auth, code, redirect_uri, code_verifier)──▶ {id_token, access_token, expires_in: 300}
```

**`GET /api/sso/interactions/:uid` (the entry).**
- `@Public`, `@SkipTransaction`.
- `uid` must match `^[A-Za-z0-9_-]{21,64}$`, else **404** problem `sso-interaction-not-found`.
- Otherwise **303** `Location: /sso/<uid>` with `Cache-Control: no-store`. It does not read the database.

**`GET /api/sso/interactions/:uid/details`.**
- `@Public`, `@SkipTransaction`.
- `provider.interactionDetails(req, res)`. If it fails (no or foreign cookie, expired, unknown), or its `uid` differs
  from the path → **404** `sso-interaction-not-found`.
- The client (by `params.client_id`) must still be active, else **409** `sso-client-unavailable`.
- Returns `SsoInteractionView`:

```ts
interface SsoInteractionView {
  uid: string;
  client: { clientId: string; name: string; nameAr: string | null };
  /** true when the request asks for a fresh sign-in (prompt=login, or max_age older than the caller's HRForce login
   *  instant) AND the caller is signed in with a session that does not satisfy it; false when signed out */
  freshLoginRequired: boolean;
}
```

**`POST /api/sso/interactions/:uid/complete`.**
- `@Authenticated()` (the platform checks sign-in → 401 and two-step enforcement → 403 `mfa-enrollment-required`
  before the handler), with the normal signed XSRF.
- `@SkipTransaction()`: it works in the **client's** company, not the session's.
- Checks, in this order:
  1. The interaction, as in *details* → 404 `sso-interaction-not-found`.
  2. The client is active → 409 `sso-client-unavailable`.
  3. `auth.sso_session(identity.sessionId, identity.userId)`:
     - no row or `live = false` → **401** `session-expired`. The web's refresh interceptor then refreshes once. If
       the family is dead, the user lands on `/login?returnUrl=/sso/<uid>`.
     - `account_status <> 'active'` → **403** `account-disabled`.
     - Identities without `sessionId` (DEV_AUTH headers) → 401 `session-expired`: SSO needs a real session.
  4. `auth.me(userId, client.companyId)` → no row → **403** `sso-not-member`.
  5. Fresh login:
     - `prompt` contains `login` and `auth_time` < the interaction's creation time, **or**
     - `max_age` is set and `now − auth_time > max_age`
     - → **409** `sso-fresh-login-required`.
  6. `provider.interactionResult(req, res, {login: {accountId: userId, ts: epoch(auth_time), amr, remember: false}},
     {mergeWithLastSubmission: false})`.
  7. Audit `sso.sign_in` (below) in the client's company.
  8. **200** `{redirectTo}`. `redirectTo` is the library's return URL, `<issuer>/auth/<uid>`; the handler asserts it
     starts with `<issuer>/auth/`.
- `Cache-Control: no-store` on every answer.

**`POST /api/sso/interactions/:uid/abort`.**
- `@Public` with the normal XSRF (anon or session-bound token), `@SkipTransaction`.
- The interaction check as above → 404.
- `interactionResult(…, {error: 'access_denied', error_description: 'The user cancelled the sign-in.'})` → **200**
  `{redirectTo}`. The RP then receives `error=access_denied`.

**States the web must handle on `/sso/:uid`:**

| Situation | API answer | Page |
|---|---|---|
| details 404 | `sso-interaction-not-found` | "expired" message, no button (the app is unknown); link "Aller à l'accueil de HRForce" |
| details/complete 409 `sso-client-unavailable` | | "app unavailable" message |
| signed out (session signal null after the app initializer's refresh) | — | `router.navigate(['/login'], {queryParams: {returnUrl: '/sso/<uid>'}})` |
| complete 403 `sso-not-member` | | message with the app name; buttons « Retourner à l'application » (abort → `location.assign`) and « Changer de compte » (`POST /api/auth/logout` → `/login?returnUrl=/sso/<uid>`) |
| complete 403 `account-disabled` | | the login page's disabled wording; « Retourner à l'application » |
| complete 403 `mfa-enrollment-required` | | handled by the existing `mfaEnrollmentInterceptor` (returnUrl kept) |
| `freshLoginRequired` or complete 409 `sso-fresh-login-required` | | « L'application demande une nouvelle connexion. » then logout + login (automatic, no click) |
| complete 200 | `{redirectTo}` | "Connexion à « {app} »…" and `location.assign(redirectTo)` (a full navigation: the router cannot leave the SPA) |

The interaction lives 15 minutes. After that the resume answers the library's error page (`invalid_request`,
"authorization request has expired"), and the user starts again from the app.

## Logout flow (RP-initiated)

```
RP ──302──▶ /oidc/session/end?id_token_hint=…&post_logout_redirect_uri=…&state=…
   provider: hint validated (signature; expiry ignored), post_logout_redirect_uri must be registered for the hint's client
   ──200──▶ HRForce logout page (server-rendered, fr + ar side by side, CSP above; <extra> = the RP origin)
page script (/oidc/assets/end-session.js, same origin):
   1. if no XSRF-TOKEN cookie: GET /api/auth/csrf
   2. POST /api/auth/logout  {expectedUserId: <hint sub>}   (header X-XSRF-TOKEN)   — any outcome is ignored
   3. submit the provider's form: POST /oidc/session/end/confirm  xsrf=<state secret>&logout=yes
provider: ends its session, revokes the grants' access tokens ──303──▶ post_logout_redirect_uri?state=…
```

- **Page modes.**
  - *auto*: a valid `id_token_hint`, or the sessionless case of middleware 4. The script runs at load and the page
    shows « Déconnexion en cours… ».
  - *confirm*: no hint. The page shows « Se déconnecter de HRForce ? » and a button « Se déconnecter » / « تسجيل
    الخروج ». The button runs steps 1–3, and step 2 is sent **without** `expectedUserId`. There is also a link
    « Retour à HRForce » / « العودة إلى HRForce » → `${WEB_BASE_URL}/`.
  - `<noscript>`: the confirm button submits the form only, with the text « JavaScript est désactivé : seule la
    session de connexion unique sera fermée. Pour vous déconnecter de HRForce, utilisez le menu de HRForce. » /
    « JavaScript معطّل: سيتم إغلاق جلسة الدخول الموحد فقط. لتسجيل الخروج من HRForce، يرجى استعمال قائمة HRForce. »
- **The page's HTML:**
  - `<html lang="fr">`, no external fonts, styles inline (`style-src 'unsafe-inline'`);
  - the French block `dir="ltr"` and the Arabic block `dir="rtl" lang="ar"` side by side (stacked below 480 px);
  - the app name from `client_name` (and `name_ar` in the Arabic block), HTML-escaped.
- **The script** `end-session.js` is a static file served by the API at `GET /oidc/assets/end-session.js`. It is
  registered **before** the provider mount, with `Content-Type: text/javascript`, `Cache-Control: no-cache`, and
  `X-Content-Type-Options: nosniff` (Caddy's global header block adds it too). It reads `data-mode`, `data-sub` and
  `data-form` attributes from the page and uses `fetch` with `credentials: 'same-origin'`. No inline script.
- **`POST /api/auth/logout` (Identity, changed).**
  - It accepts an optional JSON body `{expectedUserId?: uuid}` (anything else → 422 `validation-error`).
  - When `expectedUserId` is present and the owner of the presented session (access-token user, else refresh-token
    owner) is **another** user, or there is no session → **204**, nothing revoked, **cookies untouched**, no audit.
  - Otherwise it behaves exactly as today (revoke the family, audit `auth.logout`, clear the cookies).
  - The existing web call (no body) is unchanged.
- **`postLogoutSuccessSource`** (no `post_logout_redirect_uri`): the same bilingual layout, « Vous êtes
  déconnecté(e). » / « تم تسجيل الخروج. », and a link « Retour à HRForce » → `${WEB_BASE_URL}/`.
- **`renderError`:** the same layout.
  - Title « Connexion impossible » / « تعذّر تسجيل الدخول ».
  - Text « L'application n'est pas reconnue ou la demande est invalide. » / « التطبيق غير معروف أو الطلب غير
    صالح. », then the OAuth `error` code in a `<code>` element.
  - **Never** the `error_description` of a server error, and no stack.
  - Status as the library decides.
- **When HRForce's own session ends** (sign-out in HRForce, expiry, reset): the apps keep their local sessions, and
  nothing is pushed to them. Their next "Se connecter avec HRForce" asks for the password. HRForce's sign-in and
  sign-out do **not** touch the `hrf_op_*` cookies: the provider session is a thin record, and every authorization
  goes through `complete` anyway.

## Permissions (catalogue additions, group `sso`, sort 810–830; labels fr/ar/en)

| Code | fr | ar | en | Granted to |
|---|---|---|---|---|
| `sso.read` | Consulter les applications connectées | الاطلاع على التطبيقات المرتبطة | View connected apps | `admin_rh_central`, `admin_acces` |
| `sso.manage_apps` | Gérer les applications connectées (inscription, secrets, rôles) | تسيير التطبيقات المرتبطة (التسجيل، الرموز السرية، الأدوار) | Manage connected apps (registration, secrets, roles) | `admin_rh_central`, `admin_acces` |
| `sso.assign` | Attribuer les rôles d'application | إسناد أدوار التطبيقات | Assign app roles | `admin_rh_central`, `admin_acces` |

- `PERMISSION_CODES`, `SYSTEM_ROLES` and the catalogue unit test are updated. The migration grants the codes to the
  existing system roles of every company.
- The web's permission group label: `access.groups.sso` = « Applications connectées » / « التطبيقات المرتبطة » /
  "Connected apps".

## Scope rules

- **Reads** (`GET /sso/clients*`, `GET /sso/assignments`): `sso.read` **anywhere** in the company. An id of another
  company, or an unknown one → **404** (RLS).
- **Writes**:
  - on clients and roles: `sso.manage_apps`;
  - on assignments: `sso.assign`.

  Each must be held over the **whole company** (the root unit, as `document.configure`), else **403**
  `forbidden-scope`.
- `_actions` on views follow the same rule. For example `acces` (admin_acces on REG-EST) sees everything with
  `_actions: []`.
- **Separation of duties:** nobody assigns a role to, or removes a role from, **themselves** → 409 `sso-assign-self`.
  Admins may register apps they use themselves.
- **User picker:** the web uses the existing `GET /access/users?q=` (both seeded roles hold `access.read`). The API
  checks membership itself (`auth.company_members`).

## Endpoints (under `/api`, problem+json)

### Standard OIDC endpoints (under the issuer; library behaviour, not Nest routes)

| Method + path | Result |
|---|---|
| `GET /oidc/.well-known/openid-configuration` | 200 discovery (issuer, endpoints, `scopes_supported`, `claims_supported`, `code_challenge_methods_supported: ["S256"]`, `grant_types_supported: ["authorization_code"]`, `response_types_supported: ["code"]`, `id_token_signing_alg_values_supported: ["RS256"]`, `token_endpoint_auth_methods_supported: ["client_secret_basic","client_secret_post"]`, `end_session_endpoint`, `authorization_response_iss_parameter_supported: true`) |
| `GET /oidc/jwks` | 200 public keys (`current`, `next`, `retired`) |
| `GET /oidc/auth` | 303 → the interaction entry. Unknown/disabled client, or an unregistered `redirect_uri` → **400 HTML error page, never a redirect**. After the redirect URI is validated, errors go back to it as `?error=…&state=…&iss=…`: no PKCE / not S256 → `invalid_request`; unknown scope → `invalid_scope` (or the scope is dropped, library rule); `response_type` ≠ code → `unsupported_response_type`; `response_mode` ≠ query → 400 page; `prompt=none` → `login_required` |
| `GET /oidc/auth/:uid` | resume: 303 → `redirect_uri?code&state&iss`, or `?error=access_denied` after abort. No `hrf_op_resume` cookie / unknown uid → 400 page |
| `POST /oidc/token` | `grant_type=authorization_code`, `code`, `redirect_uri`, `code_verifier` + client authentication → 200 `{access_token, token_type: "Bearer", expires_in: 300, id_token, scope}`. Bad client → 401 `invalid_client`; bad/used/expired code, wrong redirect_uri or verifier → 400 `invalid_grant` (a replayed code also revokes the tokens issued from it — library rule); other grant types → 400 `unsupported_grant_type`; throttled → 429 |
| `GET/POST /oidc/me` | userinfo with `Authorization: Bearer` → 200 claims; 401 `invalid_token` |
| `GET/POST /oidc/session/end` | 200 HRForce logout page; bad hint / unregistered `post_logout_redirect_uri` → 400 page |
| `POST /oidc/session/end/confirm` | 303 → `post_logout_redirect_uri` (+ `state`) or `/oidc/session/end/success`; bad `xsrf` → 400 page |
| `GET /oidc/session/end/success` | 200 "signed out" page |
| `GET /oidc/assets/end-session.js` | 200 script (served by the API, before the mount) |
| anything else under `/oidc` | 404 (registration, introspection, revocation, PAR, device: disabled) |

### Sign-in handoff (module `sso`, controller `sso/interactions`)

| Method + path | Guard | Result |
|---|---|---|
| `GET /sso/interactions/:uid` | `@Public` | 303 `/sso/:uid`; 404 `sso-interaction-not-found` (malformed uid) |
| `GET /sso/interactions/:uid/details` | `@Public` | 200 `SsoInteractionView`; 404 `sso-interaction-not-found`; 409 `sso-client-unavailable` |
| `POST /sso/interactions/:uid/complete` | `@Authenticated` | 200 `{redirectTo}`; 401; 401 `session-expired`; 403 `mfa-enrollment-required` / `account-disabled` / `sso-not-member`; 404 `sso-interaction-not-found`; 409 `sso-client-unavailable` / `sso-fresh-login-required` |
| `POST /sso/interactions/:uid/abort` | `@Public` | 200 `{redirectTo}`; 404 |

### Administration (module `sso`)

| Method + path | Permission | Request → response |
|---|---|---|
| `GET /sso/clients` | `sso.read` | → 200 `{items: SsoClientView[]}` sorted by name |
| `GET /sso/clients/:id` | `sso.read` | → 200 `SsoClientView`; 404 |
| `POST /sso/clients` | `sso.manage_apps` (company-wide) | `{clientId, name, nameAr?, redirectUris, postLogoutRedirectUris?, clientAuthMethod?}` → **201** `SsoClientCreatedView`; 409 `sso-client-id-taken` (`errors[{field:'clientId', code:'taken'}]`); 422 |
| `PATCH /sso/clients/:id` | `sso.manage_apps` | `{name?, nameAr?, redirectUris?, postLogoutRedirectUris?, clientAuthMethod?}` → 200 `SsoClientView`; `clientId` in the body → 422 `errors[{field:'clientId', code:'immutable'}]`; 404 |
| `POST /sso/clients/:id/rotate-secret` | `sso.manage_apps` | no body → 200 `SsoClientCreatedView` (a new `clientSecret`; the old one stops working at once); 404 |
| `POST /sso/clients/:id/disable` | `sso.manage_apps` | `{reason}` (3–500) → 200; already disabled → 409 `sso-client-disabled` |
| `POST /sso/clients/:id/enable` | `sso.manage_apps` | → 200; already active → 409 `sso-client-active` |
| `POST /sso/clients/:id/roles` | `sso.manage_apps` | `{code, names: {fr, ar, en}}` → 201 `SsoAppRoleView`; 409 `sso-role-code-taken` (field `code`); 422 |
| `PATCH /sso/roles/:roleId` | `sso.manage_apps` | `{names}` → 200 `SsoAppRoleView`; `code` → 422 `immutable`; 404 |
| `DELETE /sso/roles/:roleId` | `sso.manage_apps` | → 204; 409 `sso-role-in-use` (it has assignments); 404 |
| `GET /sso/assignments?clientId=&userId=&roleId=` | `sso.read` | → 200 `{items: SsoAssignmentView[]}` (filters optional, AND-ed; at most 1000 items, sorted by app name, role code, user name); malformed ids → 422 |
| `POST /sso/assignments` | `sso.assign` (company-wide) | `{userId, roleId}` → 201 `SsoAssignmentView`; 409 `sso-assign-self`, `sso-assignment-duplicate` (field `roleId`); 422 `userId` `not_member`, `roleId` `unknown` (also another company's role) |
| `DELETE /sso/assignments/:id` | `sso.assign` (company-wide) | → 204; 409 `sso-assign-self` (removing one's own); 404 |

```ts
interface SsoClientView {
  id: string;
  clientId: string;
  name: string;
  nameAr: string | null;
  status: 'active' | 'disabled';
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  clientAuthMethod: 'client_secret_basic' | 'client_secret_post';
  credentialSetAt: string;                     // ISO instant the current secret was issued
  issuer: string;                              // `${WEB_BASE_URL}/oidc`, for the "how to connect" panel
  createdAt: string;
  createdBy: { id: string; displayName: string } | null;
  disabledAt: string | null;
  disabledReason: string | null;
  roles: SsoAppRoleView[];                     // sorted by code
  assignmentCount: number;                     // users with at least one role of this app
  _actions: ('update' | 'rotate_secret' | 'disable' | 'enable' | 'add_role')[];
}
interface SsoAppRoleView {
  id: string;
  code: string;
  names: { fr: string; ar: string; en: string };
  assignmentCount: number;
  _actions: ('update' | 'delete')[];           // delete only when assignmentCount = 0
}
/** Create and rotate-secret only. `clientSecret` is the ONE response field allowed by this contract to carry a
 *  secret (tools/guardrails/secret-fields-allow.json → contract docs/contracts/sso.md; e2e `assertNoSecrets(body, ['clientSecret'])`). */
interface SsoClientCreatedView extends SsoClientView {
  clientSecret: string;
}
interface SsoAssignmentView {
  id: string;
  user: { id: string; email: string; displayName: string };
  client: { id: string; clientId: string; name: string; nameAr: string | null };
  role: { id: string; code: string; names: { fr: string; ar: string; en: string } };
  assignedBy: { id: string; displayName: string } | null;
  assignedAt: string;
  _actions: ('remove')[];
}
```

**Validation (422 `validation-error`, `errors[{field, code}]`):**
- `clientId`: `required`, `invalid` (pattern).
- `name`: `required`, `too_long`. `nameAr`: `too_long`.
- `redirectUris`: `required` (empty), `too_many` (> 10). Each `redirectUris.<i>`:
  - `invalid_uri`: not absolute `http(s)`, has a fragment or user-info, > 2000 characters, or has a `*`;
  - `insecure_uri`: `http` on a non-loopback host;
  - `duplicate`.
- `postLogoutRedirectUris.<i>`: the same codes (`too_many` > 10).
- `clientAuthMethod`: `invalid`.
- `names.fr|ar|en`: `required`, `too_long`. `code`: `required`, `invalid`.
- `reason`: `required`, `too_short`, `too_long`.
- Trimmed strings; URIs are stored exactly as given (no normalisation: exact matching).

**Problem slugs (new):** `sso-interaction-not-found`, `sso-client-unavailable`, `sso-not-member`,
`sso-fresh-login-required`, `sso-client-id-taken`, `sso-client-disabled`, `sso-client-active`, `sso-role-code-taken`,
`sso-role-in-use`, `sso-assign-self`, `sso-assignment-duplicate`. Reused: `session-expired`, `account-disabled`,
`mfa-enrollment-required`, `forbidden-scope`, `validation-error`.

**Log redaction** (`REDACT_PATHS`, extend): `*.clientSecret`, `*.client_secret`, `*.code_verifier`, `*.id_token`,
`*.id_token_hint`, `*.access_token`, `res.headers.location` (a resume redirect carries the code). Query strings are
already logged by parameter names only.

## Module boundaries

- **`modules/sso`** (new):
  - `api/`: the interaction and admin controllers, DTOs.
  - `application/`: the admin use cases, the handoff use case, the claims builder.
  - `domain/`: pure rules, unit-tested: URI validation, code patterns, fresh-login rule, logout page model.
  - `infra/`: the provider factory, adapter, key store, cipher, repositories, the logout/error page renderer and
    `end-session.js`, the seed.
  - `index.ts` exports `SsoModule`, `OIDC_HTTP_HANDLER`, `oidcAccessLog`, `oidcHostCheck`, `seedSso`, the CLI
    entry used by `scripts/oidc-keys.ts`, and the test helpers.
  - `configure-app.ts` imports from `modules/sso/index.ts` (the root file may import module entry points).
- **Identity** exports `IdentitySessions` (new, `application/`):
  - `ssoSession(sid, userId)` → `{live, authTime, amr, accountStatus} | null`;
  - `member(userId, companyId)` → `MeRecord | null` (wraps `auth.me`).

  It also exports the `expectedUserId` behaviour of `POST /auth/logout` (internal), `create_session` with `amr`, and
  the MFA path passing `{pwd,otp,mfa}`.
- **Staffing** exports `StaffingService.employeeClaim(userId, date)` →
  `{matricule, active, unit: UnitRef-lite | null} | null`, read inside the current transaction (the claims
  transaction).
- **Platform:**
  - `config` gains `OIDC_KEY` and `DEV_OIDC_KEY`;
  - `security/cookies.ts` gains the `hrf_op_*` names (documentation constants; the library sets them);
  - `logging/redaction.ts` gains the paths above.

## Audit and timeline

- **Row triggers** on `sso_client` (masked `secret_enc`), `sso_app_role` and `sso_role_assignment`. `oidc.*` is not
  audited.
- **Application events.** None carries a token, a code, a secret, a hint or an IP beyond `sso.sign_in`'s:

| Type | Written by | Company | Actor | Subject | Data |
|---|---|---|---|---|---|
| `sso.sign_in` | `complete` | the client's | the user | `user` | `{clientId, clientName, amr, ip, userAgent}` |
| `sso.client_secret_rotated` | rotate-secret | request | admin | `sso_client` | `{clientId}` |
| `sso.role_assigned` / `sso.role_removed` | assignments (in addition to the row trigger) | request | admin | `user` (the assignee) | `{clientId, roleCode, assignmentId}` |

  `sso.sign_in` is written in its own short transaction (`AuditEvents.recordFor`) under the client's company.
- **Timeline subjects:**
  - New `sso_client:<id>`: the client's rows, its roles' rows, its assignments' rows and its events. Visible with
    `sso.read` **and** `audit.read` anywhere, else 404.
  - `user:<id>` (existing rule) adds the user's `sso_role_assignment` rows and the `sso.*` events about them.
  - Labels: `audit.tables.sso_*`, `audit.fields.sso_client.*` (`secret_enc` → « Secret (masqué) » / « الرمز السري
    (مخفي) »), `audit.events.sso.*`.

## Worker

- A daily cron **`oidc.cleanup`** at `15 3 * * *` (UTC; backfill 12 h; idempotent; not per company), as
  `hrforce_worker`:
  - delete `oidc.model_store` rows with `expires_at < now() - interval '1 day'`;
  - delete `oidc.client_auth_failure` rows older than 1 day.
  - Log the counts at `info`.

## Web (apps/web)

All strings are under `sso.*` (fr/ar parity, en may lag), RTL, and usable at 390 px.

- **Dev proxy:** `proxy.conf.json` gains
  `"/oidc": {"target": "http://localhost:3000", "secure": false, "changeOrigin": false, "logLevel": "warn"}`.
  `changeOrigin: false` keeps `Host: localhost:4200`, and the host check depends on it.
- **`/sso/:uid`** (`features/sso/sso-handoff.page.ts`, lazy):
  - The route has **no guard** (it works signed out, like `/punch`) and `data: { chrome: false }`: a centred card,
    no navigation, the language switcher kept.
  - On init: `GET details`, then act on the session signal as in the states table.
  - The card shows the app name in the UI language: `nameAr` when the language is ar and it exists, else `name`.
  - « Connexion à « {app} »… » with a progress indicator while completing.
  - A **full navigation** (`location.assign`) to `redirectTo` or to an abort URL. Never `router.navigate` for these.
  - The page never renders the uid.
- **Login page:** when `returnUrl` starts with `/sso/`, show the banner « Connectez-vous pour continuer vers
  l'application. » (no app name: the URL is attacker-controlled). `safeReturnUrl` already accepts the relative path.
  On success → `returnUrl`, as today; the MFA step is unchanged.
- **Access → Applications** (`/access/apps`, `/access/apps/new`, `/access/apps/:id`; nav tab « Applications »):
  - The `/access` parent now asks for ANY of `access.read`, `sso.read`. Each existing child keeps `access.read`
    (`permissionGuard`, followed by the 404 entry), and the apps children need `sso.read`. `/access` redirects to
    `users` when `access.read`, else to `apps`.
  - **List:** name (+ Arabic name), client id (monospace, `dir="ltr"`), status chip, roles count, users count,
    `credentialSetAt` (relative). "Nouvelle application" with `sso.manage_apps` (`_actions`-driven on detail pages).
  - **New:**
    - The form: client id, name, Arabic name, redirect URIs (repeatable rows), post-logout URIs, authentication
      method (radio, default Basic), all URI inputs `dir="ltr"`. Errors are mapped from `errors[]`.
    - On 201 → the **secret panel**: the secret in a read-only monospace field, a "Copier" button (Clipboard API,
      with a fallback that selects the text), and the "shown once" warning. A checkbox « J'ai copié le secret » /
      « تم نسخ الرمز السري » enables "Terminer", which goes to the detail page. Leaving the panel by any other route
      asks for confirmation (`canDeactivate`).
    - The secret is kept only in a component signal and cleared on destroy; never in a service, storage or the URL.
  - **Detail tabs:**
    - *Paramètres*: the form above (clientId read-only), plus a « Comment connecter l'application » panel. It shows
      the issuer URL, the discovery URL, the client id, the redirect URIs, and the scopes to ask for
      (`openid profile email hrforce`), each with a copy button.
    - *Rôles*: a table (code, names) with create, edit names, and delete (disabled with a tooltip when used).
    - *Utilisateurs*: the assignments of this app (user, role, assigned by, date), "Attribuer un rôle" (user picker =
      existing search, role select), and "Retirer" (confirm).
    - *Historique* (`audit.read`): the `sso_client:<id>` timeline.
  - **Header actions** (from `_actions`): « Régénérer le secret » opens a confirm dialog that warns the old secret
    stops working at once, then the same secret panel. « Désactiver » asks for a reason; « Réactiver ».
- **Access → user detail:** a new section « Applications » (`sso.read`) with `GET /sso/assignments?userId=`: app,
  role, since. « Attribuer » and « Retirer » with `sso.assign` (hidden for one's own user; the API also refuses).
- **Permission checklist:** the new group `sso` appears with its label.
- **Angular guide:** a new chapter **22 — "Leaving the SPA: an OpenID Connect sign-in handoff"**. It covers:
  - full-page navigation (`location.assign`) vs the router, and why a handoff page must use it;
  - a route without guards that works signed in or out, and reacts to the session signal with `effect()` /
    `toObservable`;
  - route `data` to hide the chrome (link to ch. 20);
  - reusing the login page through `returnUrl` and the interceptors (links to ch. 05/17);
  - show-once secrets: component-local signals, the Clipboard API, `canDeactivate` guards;
  - repeatable form rows (`FormArray`) for URI lists;
  - a parent route guarded by ANY of two permissions, with per-child guards.

## Demo sister app (`apps/sso-demo`, workspace `@hrforce/sso-demo`)

A deliberately small **relying party** that shows what a sister app does with HRForce SSO.

### Stack

- TypeScript (ESM, NodeNext, `strict`), built with `tsc` to `dist/`.
- Dependencies: `express` (the version already in the lockfile, 5.x), `openid-client@6.8.8`, `pino` (the repo's
  version).
- No template engine: pages are built by small functions that HTML-escape every value.
- No client-side JavaScript at all.
- Scripts: `build`, `start` (`node dist/main.js`), `typecheck`, `test` (Vitest).
- Lint rules as the repo (no `console.*`, no `any`), and CSS logical properties.

### Environment (`apps/sso-demo/.env.example`, validated at boot with zod; a missing value = exit 1)

| Variable | Dev value | Rule |
|---|---|---|
| `NODE_ENV` | `development` | |
| `SSO_DEMO_PORT` | `4300` | |
| `SSO_DEMO_BASE_URL` | `http://localhost:4300` | the redirect URI is `${base}/callback`, the post-logout URI `${base}/signed-out` |
| `SSO_DEMO_ISSUER` | `http://localhost:4200/oidc` | `http://` only when `NODE_ENV` ≠ production (then `allowInsecureRequests`) |
| `SSO_DEMO_CLIENT_ID` | `sso-demo` | |
| `SSO_DEMO_CLIENT_SECRET` | the seed's dev secret (below) | ≥ 32 characters |
| `SSO_DEMO_COOKIE_SECURE` | `false` | `false` only outside production |
| `LOG_LEVEL` | `info` | |

- Discovery runs at boot:
  `client.discovery(new URL(issuer), clientId, undefined, client.ClientSecretBasic(secret), {execute:
  [allowInsecureRequests] in dev})`.
- If HRForce is not up yet, discovery is retried every 2 s for 60 s, then the process exits 1.

### Session

- An in-memory `Map` (fine for a demo; a restart signs everyone out).
- Cookie `sso_demo_sid`: 32 random bytes base64url, `HttpOnly; SameSite=Lax; Path=/`, `Secure` per env, no
  `Max-Age` (browser session). The server-side entry expires after 8 h idle.
- An entry holds `{pending?: {codeVerifier, state, nonce, createdAt}, user?: {claims, idToken}, lang}`. A pending
  sign-in expires after 10 minutes.
- The id is regenerated after a successful callback (fixation).

### Routes

| Route | Behaviour |
|---|---|
| `GET /` | signed in → 303 `/welcome`; else the home page |
| `GET /login` | new PKCE verifier, `state` and `nonce` (openid-client helpers) in the session; 303 → `buildAuthorizationUrl(config, {redirect_uri, scope: 'openid profile email hrforce', code_challenge, code_challenge_method: 'S256', state, nonce, ui_locales: <lang>})` |
| `GET /callback` | `authorizationCodeGrant(config, currentUrl, {pkceCodeVerifier, expectedState, expectedNonce, idTokenExpected: true})` → store `tokens.claims()` and the `id_token` → 303 `/welcome`. `error=access_denied` → home with « Connexion annulée. »; any other error or check failure (state, nonce, `iss`) → the error page with the OAuth error code only |
| `GET /welcome` | signed out → 303 `/` |
| `POST /logout` | a form button (`SameSite=Lax` keeps cross-site POSTs out); drops the local session; 303 → `buildEndSessionUrl(config, {id_token_hint, post_logout_redirect_uri: base + '/signed-out'})` |
| `GET /signed-out` | the "signed out" page |
| `GET /lang/:lang` | `fr` or `ar` → sets the session's language (or a `sso_demo_lang` cookie when there is no session) → 303 to `Referer` path if same-origin, else `/` |
| `GET /assets/demo.css` | the stylesheet |

### Response headers (every page)

- `Content-Security-Policy: default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self' <issuer origin>; frame-ancestors 'none'; base-uri 'none'`.
  The issuer origin is needed because the logout form's redirect goes there, and Chrome checks `form-action` on
  redirects.
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` on pages.

### Pages

Each page has `<html lang dir>` (ar → `rtl`), a language link, and the product line « Démo SSO — application sœur
fictive » / « تطبيق تجريبي — تطبيق شقيق افتراضي ».

- **Home:** the title « Démo SSO » / « تطبيق تجريبي للدخول الموحد », the text « Application de démonstration
  connectée à HRForce. » / « تطبيق تجريبي مرتبط بـ HRForce. », and a primary button link « Se connecter avec
  HRForce » / « تسجيل الدخول عبر HRForce » → `/login`.
- **Welcome:**
  - « Bienvenue, {name} » / « مرحبا، {name} ».
  - A definition list: « Adresse e-mail » / « البريد الإلكتروني »; « Entreprise » / « المؤسسة » ({company.name});
    « Matricule » / « الرقم التعريفي » ({employee.matricule}); « Unité » / « الوحدة » ({unit.nameAr} in ar when set,
    else {unit.name}).
  - When `employee` is null: « Aucun dossier salarié n'est rattaché à ce compte. » / « لا يوجد ملف وظيفي مرتبط بهذا
    الحساب. »
  - « Rôle dans cette application » / « الدور في هذا التطبيق » (plural « Rôles… » / « الأدوار… » when several):
    - `operator` → « Opérateur » / « التشغيل »;
    - `supervisor` → « Superviseur » / « الإشراف »;
    - an unknown code is shown as the code;
    - with `roles: []`, a notice box instead: « Aucun rôle ne vous est attribué dans cette application. Demandez à
      l'administrateur des accès de HRForce. » / « لم يُسند أي دور لهذا الحساب في هذا التطبيق. يرجى التواصل مع مسؤول
      الصلاحيات في HRForce. »
  - A `<details>` « Données reçues (jeton d'identité) » / « البيانات المستلمة (رمز الهوية) » with the claims as
    pretty JSON (escaped; `dir="ltr"`).
  - The button « Se déconnecter » / « تسجيل الخروج ».
- **Signed out:** « Vous êtes déconnecté(e) de la démo et de HRForce. » / « تم تسجيل الخروج من التطبيق التجريبي ومن
  HRForce. », and a link « Se connecter avec HRForce ».
- **Error:** « La connexion a échoué ({error}). Veuillez réessayer. » / « تعذّر تسجيل الدخول ({error}). يرجى إعادة
  المحاولة. », and a link to the home page.
- **Language:** the session's choice, else the `sso_demo_lang` cookie, else `fr`. After sign-in, if the user has not
  chosen, the claim `locale` (`ar` → ar, else fr).

### Logs and tests

- **Logs:** one line per request (method, path without query, status). Never codes, tokens, the secret or claims.
- **Tests** (Vitest, in the workspace):
  - the page builders (fr/ar, `dir`, escaping of a `<script>` name, role labels, no-role notice, null employee);
  - the env schema;
  - the session store expiry;
  - the CSP header.

  The protocol round trip is tested in the API's e2e suite (below) and by the verifier in a browser.

## Seed, dev and deploy wiring

- **`seed:dev` (DEMO), skipped when the client exists:**
  - Client `sso-demo`: « Démo SSO » / « تطبيق تجريبي للدخول الموحد », `redirect_uris ['http://localhost:4300/callback']`,
    `post_logout_redirect_uris ['http://localhost:4300/signed-out']`, `client_secret_basic`, fixed dev secret
    **`sso-demo-dev-secret-INSECURE-2026-0123456789`** (encrypted with the dev `OIDC_KEY`; printed by the seed; also
    in `apps/sso-demo/.env.example`). If a developer sets their own `OIDC_KEY` later, `invalid_client` follows:
    rotate the secret in Access → Applications.
  - Roles: `operator` (« Opérateur » / « التشغيل » / "Operator") and `supervisor` (« Superviseur » / « الإشراف » /
    "Supervisor").
  - Assignments (assigned by `rh.admin`):
    - `agent.annaba@demo.dz` → `operator` (linked to EMP-0030, Agence Annaba);
    - `chef.annaba@demo.dz` → `supervisor`.
  - Nobody else: `rh.est@demo.dz` (Arabic UI, linked to EMP-0022) shows "no role" in Arabic, and `rh.admin@demo.dz`
    (not linked) shows no employee block.
- **Test fixture (BETA):** a client `beta-app` with a role `viewer` and one assignment, a known secret, for the
  matrix.
- **`bootstrap`:** nothing. A new company starts without apps, and the first boot of the API creates the signing key.
- **`scripts/dev-up.sh` / `.ps1`:**
  1. Create `apps/sso-demo/.env` from `.env.example` when missing.
  2. Build the demo (`npm run build -w @hrforce/sso-demo`).
  3. Start it with the others (`npm start -w @hrforce/sso-demo &`, with `PORT` unset, since the demo reads
     `SSO_DEMO_PORT`).
  4. Add to the printed help:
     `SSO demo: http://localhost:4300 — agent.annaba@demo.dz (Opérateur), chef.annaba@demo.dz (Superviseur), rh.est@demo.dz (aucun rôle, arabe)`.
- **`apps/api/.env.example`:** `# OIDC_KEY=` with a comment like `AUTH_MFA_KEY` (dev falls back to the public dev key).
- **Deploy:**
  - `deploy/.env.staging.example` and `init-env.sh` gain `OIDC_KEY=$(openssl rand -base64 32)`.
  - `compose.staging.yml` passes `OIDC_KEY: ${OIDC_KEY:?}` to `api`.
  - **Ops note (HANDOFF):** existing staging installs must add `OIDC_KEY` to `deploy/.env` before the deploy that
    ships SSO.
  - The key CLI runs with the migrator service (`docker compose run --rm migrate node dist/scripts/oidc-keys.js
    status`); it needs `OIDC_KEY` in that service's environment too.
- **`deploy/Caddyfile`:**
  - A handle `@oidc path /oidc /oidc/*` → `reverse_proxy api:3000`, with the dev headers stripped as for `/api`.
  - `@notEmployeeFileContent` also excludes `/oidc /oidc/*`: the API's CSP must reach the browser untouched, while the
    other global headers (`X-Frame-Options: DENY`, HSTS, nosniff, `Referrer-Policy: no-referrer`) still apply.
  - The access-log filter also deletes the query fields `id_token_hint`, `login_hint`, `code` and `state`.
  - `deploy/web/Caddyfile` is unchanged (it never sees `/oidc`).
- **`deploy/smoke.sh`:** `GET /oidc/.well-known/openid-configuration` → 200 and `issuer` = `https://$STAGING_DOMAIN/oidc`.

## Authorization matrix rows (expected)

Actors as in `authorization-matrix.e2e-spec.ts`. Targets:
- `est`: a company-A resource (the DEMO `sso-demo` client, its `operator` role, agent.annaba's assignment);
- `other`: BETA's (`beta-app`, its role and assignment).

`✓` = the route's success status. Company-wide writers: `admin` (A) and `beta` (B). `acces` holds the permissions on
REG-EST only.

| Route | Rows |
|---|---|
| `GET /sso/clients`, `GET /sso/assignments` | admin 200, acces 200, beta 200 (only BETA items — asserted), est 403, ouest 403, agent 403, chef 403 |
| `GET /sso/clients/:id` | admin est 200, admin other 404; acces est 200; beta other 200, beta est 404; est est 403; agent est 403 |
| `POST /sso/clients` | admin 201, beta 201 (own company; fresh client ids per row), acces 403 (`forbidden-scope`), est 403, ouest 403, agent 403 |
| `PATCH /sso/clients/:id`, `POST …/rotate-secret`, `POST …/disable` (then `…/enable`), `POST …/roles`, `PATCH /sso/roles/:roleId`, `DELETE /sso/roles/:roleId` (an unused fixture role per row) | admin est ✓, admin other 404; beta other ✓, beta est 404; acces est 403; est est 403; agent est 403 |
| `POST /sso/assignments` | admin est 201 (a fixture user of A), admin other 422 (`roleId` unknown); beta other 201; acces est 403; est est 403; agent est 403; admin assigning to themselves 409 |
| `DELETE /sso/assignments/:id` | admin est 204, admin other 404; beta other 204; acces est 403; est 403; agent 403 |
| `GET /sso/interactions/:uid` | anon (malformed uid) 404; anon (well-formed) 303 |
| `GET /sso/interactions/:uid/details`, `POST …/abort` | anon without the interaction cookie 404 |
| `POST /sso/interactions/:uid/complete` | anon 401; admin without the interaction cookie 404 |
| `POST /auth/logout` (existing row) | unchanged (204) |
| anonymous | 401 on every non-public route above |

The `/oidc/*` endpoints are not Nest routes. They are outside the route-scan and the matrix, and `sso.e2e-spec.ts`
covers them.

## Test scenarios

**API e2e (`apps/api/test/sso.e2e-spec.ts`).** The app listens on a real ephemeral port: pick a free port, set
`WEB_BASE_URL=http://127.0.0.1:<port>` before `createTestApp`, then `app.listen(port)`. `openid-client@6.8.8` is used
with `allowInsecureRequests` and a small cookie-jar HTTP client (redirect: manual; the jar honours `Path`). The
"browser" stops at `/sso/<uid>` (no Angular in e2e) and calls the `/api/sso/interactions/<uid>/*` routes itself with
the XSRF helper.

1. **Full round trip with two-step sign-in.**
   - A test user with an active TOTP factor, a member of DEMO, assigned `operator` on the fixture client.
   - Steps: `/oidc/auth` → entry 303 → details 200 (client name) → complete 401 (signed out) → `POST /auth/login`
     200 `{mfaRequired}` → `POST /auth/mfa/verify` (a computed code) 204 → complete 200 → resume 303 to the
     redirect URI with `code`, `state`, `iss` → `authorizationCodeGrant` succeeds.
   - Assert on the ID token: `sub` = user id, `roles` = `['operator']`, `company.code` = `DEMO`, `employee.matricule`,
     `amr` contains `otp`, `auth_time` = the login instant, `aud`, `nonce`.
   - Userinfo returns the same claims. `assertNoSecrets` holds on the HRForce responses.
2. Silent SSO: a second authorization in the same jar completes without login. A user with no assignment gets
   `roles: []`. A user not linked gets `employee: null`.
3. `prompt=none` → the redirect carries `error=login_required`. Abort → `error=access_denied`.
4. **Binding:**
   - another jar (a signed-in user, no `hrf_op_interaction`) → details and complete 404;
   - the right jar with a tampered `hrf_op_interaction.sig` → 404;
   - resume without `hrf_op_resume` → 400 page;
   - a uid of an expired interaction (TTL override) → 404.
5. **Session checks:**
   - an access token whose family was revoked (logout in another jar with the same refresh cookie, or MFA reset) →
     complete 401 `session-expired`;
   - a disabled account (set by SQL) → 403 `account-disabled`;
   - a user who is not a member of the client's company (BETA's client, a DEMO-only user) → 403 `sso-not-member`;
   - an MFA-required, not-enrolled user (policy enforced) → 403 `mfa-enrollment-required`;
   - DEV_AUTH header identity → 401 `session-expired`.
6. **Fresh login:**
   - `prompt=login` with an existing session → details `freshLoginRequired: true`, complete 409; after a new login
     → 200;
   - `max_age=60` with a login 2 minutes old (clock helper) → 409.
7. **Protocol refusals:**
   - an unregistered `redirect_uri` → 400 page, no `Location`;
   - no `code_challenge` → `invalid_request` redirect;
   - `code_challenge_method=plain` → `invalid_request`;
   - `response_mode=form_post` → 400 page;
   - a disabled client → 400 page;
   - a code replay → `invalid_grant`;
   - a wrong `code_verifier` → `invalid_grant`;
   - a wrong `redirect_uri` at `/token` → `invalid_grant`;
   - a wrong secret → 401 `invalid_client`;
   - after `rotate-secret` the old secret → 401 and the new one works;
   - `grant_type=refresh_token` / `client_credentials` → `unsupported_grant_type`;
   - `/oidc/reg`, `/oidc/token/introspection` → 404;
   - a request with `Host: evil.example` → 400.
8. **Throttle:** 20 bad client authentications from one IP → the 21st `/oidc/token` call answers 429 with
   `Retry-After`; a good secret from that IP is also refused until the window passes; rows are written only for
   `invalid_client`.
9. **Logout:**
   - `GET /oidc/session/end?id_token_hint&post_logout_redirect_uri` → 200 page in *auto* mode, CSP `form-action`
     containing the RP origin, no inline `<script>` without a hash;
   - then `POST /api/auth/logout {expectedUserId: sub}` → the refresh family is revoked and `auth.logout` audited;
   - `POST /oidc/session/end/confirm` → 303 to the registered URI with `state`, and the access token no longer works
     at `/oidc/me`;
   - `POST /api/auth/logout {expectedUserId: <another id>}` → 204, session still live, cookies not cleared;
   - an unregistered `post_logout_redirect_uri` → 400 page;
   - an expired `id_token_hint` is still accepted.
10. **CSP:** every `/oidc` HTML response has the policy above. The resume account-switch page (user A's provider
    session, user B completing) runs: its inline script's hash is in the header.
11. **Storage:**
    - no row of `oidc.model_store` contains a `jti`, the code or the access token string;
    - `sso_client.secret_enc` never equals the secret, and decrypting it with another client id as AAD fails;
    - the `audit.change_log` diff of a rotation shows `secret_enc` masked;
    - no `audit.*` row, and no captured log line (the `mfa-logs` pattern), contains the code, the ID token, the
      access token, the client secret or the `code_verifier`.
12. **Keys:**
    - the first boot creates exactly one `current` key (two apps booting concurrently on one database → one key);
    - `/oidc/jwks` publishes it without private members (`d`, `p`, `q`, `dp`, `dq`, `qi`);
    - stage/promote/prune (the CLI functions) change the published set and the signing `kid`;
    - a wrong `OIDC_KEY` → `/oidc/*` 503 while `/api/health` is 200.
13. **Admin:**
    - the validation codes above;
    - `sso-client-id-taken` also across companies;
    - `sso-role-in-use`, `sso-assign-self` (assign and remove), `sso-assignment-duplicate`;
    - `clientSecret` only on create and rotate (`assertNoSecrets(body, ['clientSecret'])` there, plain
      `assertNoSecrets` everywhere else);
    - the audit events and the `sso_client:<id>` timeline.
14. **Worker:** `oidc.cleanup` deletes expired rows and old failures (pinned clock).

**Unit (API):**
- the adapter's id stripping and restore;
- the URI validator (loopback rules, fragments, `*`, user-info);
- the fresh-login rule;
- the HKDF subkeys differ per info;
- the AES-GCM helpers (wrong AAD fails);
- the logout page renderer (escaping, both languages, modes, no inline script);
- the env schema (`OIDC_KEY` rules).

**Web (Vitest):**
- the handoff page for each state of the table (mocked API), including that a success calls `location.assign` via an
  injectable `WINDOW`/`Location` wrapper;
- the login banner;
- the apps list/detail with `_actions`;
- the secret panel (copy, checkbox gate, `canDeactivate`, cleared on destroy);
- the user-detail section;
- the route guards (`/access/apps` for an `sso.read`-only user; 404 for others);
- fr/ar parity.

**Verifier (browser, fr + ar, 1280 + 390 px):**
- `./scripts/dev-up.sh`, open `http://localhost:4300`:
  - agent.annaba → HRForce login → welcome with « Opérateur », matricule EMP-0030, Agence Annaba;
  - sign out → back on the demo, and HRForce `/` asks for sign-in;
  - rh.est in Arabic → RTL welcome with the "no role" notice;
  - a user with TOTP → the code step in the middle of the handoff;
  - silent SSO when already signed in to HRForce in another tab.
- Security probes:
  - a crafted `redirect_uri`;
  - framing `/sso/<uid>` and `/oidc/session/end` (blocked);
  - replaying a callback URL;
  - completing another browser's uid;
  - the logout page with a foreign `id_token_hint`;
  - the token endpoint throttle through Caddy.

## Security threats and mitigations (summary; reasoning in ADR 007)

| Threat | Mitigation |
|---|---|
| Open redirect / code theft via `redirect_uri` | exact-match registered URIs (no wildcards, no normalisation); `https` except loopback; unregistered URI → error page, never a redirect; `iss` in the response (mix-up) |
| Authorization-code interception | PKCE S256 required for every client, confidential clients, 60 s single-use codes (replay revokes) |
| Login CSRF / completing someone else's interaction | `complete` needs the browser-bound `hrf_op_interaction` cookie, the Strict session cookie and the signed XSRF header; state + nonce at the RP |
| CSRF on the provider endpoints | they never read HRForce credentials; the logout confirm has its own `xsrf`; the HRForce logout call needs the XSRF header and `expectedUserId` |
| Clickjacking | `frame-ancestors 'none'` (API CSP on `/oidc`, Caddy CSP elsewhere) + `X-Frame-Options: DENY` |
| XSS on provider pages | server-rendered pages escape every value; `script-src 'self'` + hashes only for the library's own inline scripts; the demo has no JavaScript |
| Token/secret leakage in logs, audit, backups | redaction paths, `/oidc` access log without query or bodies, Caddy log filter, ids stored as sha-256, secrets and keys AES-GCM encrypted, audit masking, no token in events |
| Client-secret brute force / abuse | 256-bit secrets; IP throttle on failed client authentication |
| Host-header poisoning of discovery | the host check against the issuer origin |
| Stale provider session outliving HRForce sign-out | every authorization goes through `complete`, which checks the live HRForce session |
| Key compromise | two-step rotation, emergency procedure, key encrypted at rest with `OIDC_KEY` (not in the database) |
| Interaction-table flooding by anonymous `/oidc/auth` calls | 15 min TTL + daily cleanup; a throttle is left for later |

## Out of scope (later)

- Back-channel logout, and HRForce sign-out propagating to the apps.
- Refresh tokens.
- Consent for third-party apps.
- Per-unit delegation of role assignment; roles with validity periods.
- Secret rotation with an overlap window; `private_key_jwt`.
- ES256; pairwise subjects.
- SAML (through a separate IdP); `OIDC_KEY` re-keying.
- A throttle on `/oidc/auth`.
- Running the demo on staging: a compose profile `sso-demo` with its own image and a second Caddy site
  `{$SSO_DEMO_DOMAIN}`; needs owner question (b).
