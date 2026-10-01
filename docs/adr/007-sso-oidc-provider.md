# ADR 007: SSO — HRForce as an OpenID Connect provider (`oidc-provider` in the API, Postgres only)

**Status:** Accepted (owner, 2026-09-30), including RP-initiated logout ending the HRForce session and per-company clients.

## Context

HRForce's sign-in (ADR 004: `httpOnly` cookies, signed XSRF, refresh rotation, Postgres throttling; `mfa.md`: TOTP) should
also let people into other apps of the group, so they have one account, one password and one second factor. Which real
apps will use it is still open. The owner asked for a first step that is **enough for a demo**:

- an admin registers a client app (confidential client, authorization code + PKCE, exact redirect URIs);
- sign-in goes through HRForce's own sign-in page and two-step verification, with no consent screen for first-party
  apps;
- the apps' **roles are managed in HRForce**: an admin defines an app's roles (e.g. `operator`, `supervisor`) and
  assigns them to users of the company, and the ID token carries the user's roles **for that app only**;
- RP-initiated logout; token signing keys encrypted in Postgres; **no Redis** (ADR 005);
- a tiny sister app (`apps/sso-demo`) that shows the result.

Constraints that shaped the design:

- ADR 005: Postgres is the only stateful dependency.
- ADR 004: the HRForce cookies are `SameSite=Strict`, `hrf_at` has `Path=/api` and `hrf_rt` has `Path=/api/auth`, so
  they are **never sent to a path outside `/api`**, and not sent on a navigation that comes from another site.
- The web app is a same-origin Angular SPA behind Caddy. Caddy sets a strict CSP (`script-src 'self'`, no inline
  script) and `frame-ancestors 'none'`.
- The API is an ESM NestJS 12 app on Express 5, Node 22, TypeScript 7.

## Decision

### 1. Library: `oidc-provider` inside the API process

`oidc-provider` (panva), a certified OpenID Provider library, is mounted as Express middleware in the existing API
process. It gets a Postgres adapter, and its state goes in a new schema `oidc`. There is no new service or container,
and no Redis. The relying-party library for the demo app and the tests is `openid-client` (panva).

### 2. Issuer and routing

- **Issuer = `${WEB_BASE_URL}/oidc`**: `http://localhost:4200/oidc` in dev, `https://<domain>/oidc` on staging.
  Discovery is at `${issuer}/.well-known/openid-configuration`. The endpoints are the library defaults under the
  issuer: `/auth`, `/auth/:uid` (resume), `/token`, `/me` (userinfo), `/jwks`, `/session/end`,
  `/session/end/confirm` and `/session/end/success`.
- The provider is mounted with `app.use('/oidc', provider.callback())` in `configureApp()`. This is outside Nest's
  global `api` prefix and **before Nest's body parsers**: Nest registers its parsers in `init()`, and `app.use()`
  takes effect at once, as checked in `@nestjs/core` 12.1.0. Nest's guards (XSRF, permission), interceptors and
  pipes never run for `/oidc`.
- Routing in the three environments:
  - **Caddy:** `/oidc` and `/oidc/*` go to `api:3000`.
  - **Dev proxy:** `apps/web/proxy.conf.json` gains a `/oidc` entry. This was verified with Angular 22.2
    `ng serve`: top-level HTML navigations are forwarded and `Host` is preserved.
  - **Behind Caddy:** `provider.proxy = true` so that `X-Forwarded-Proto` makes the issuer URLs `https`.
- The provider builds its URLs from the request's `Host`. A middleware answers 400 to any `/oidc` request whose origin
  is not the issuer's origin.

### 3. Interaction handoff: the Angular sign-in page stays the only sign-in page

The provider's interaction URL is an **API** path, `/api/sso/interactions/<uid>`. The library sets its interaction
cookie with `Path=` equal to that URL's path (see `interactions.js`). So the cookie that binds the interaction to the
browser is sent to `/api/sso/interactions/<uid>/*` XHRs, and those XHRs also carry `hrf_at` (`Path=/api`). The flow:

1. The RP redirects to `/oidc/auth?…`. The provider creates the interaction and sets `hrf_op_interaction`
   (`Path=/api/sso/interactions/<uid>`) and `hrf_op_resume` (`Path=/oidc/auth/<uid>`), then answers 303 to
   `/api/sso/interactions/<uid>`.
2. That API route answers 303 to the Angular page `/sso/<uid>`. The route exists only because of the cookie path.
3. Angular calls `GET /api/sso/interactions/<uid>/details`, which is public and bound to the interaction cookie. On
   this page the Strict HRForce cookies **are** sent with same-origin XHRs, even though the chain of navigations
   started on another site.
   - Signed out: Angular goes to the existing `/login?returnUrl=/sso/<uid>`, which handles the password, the second
     factor and lockout.
   - Two-step enrollment required: the existing guard/interceptor handles it.
   - Signed in: Angular goes straight on (silent SSO).
4. `POST /api/sso/interactions/<uid>/complete` needs a signed-in caller, the signed XSRF token and the interaction
   cookie. It checks:
   - that the HRForce refresh session behind `hrf_at` is **live** (a definer function, because the access token alone
     is stateless);
   - that the account is active;
   - that the user is a member of the **client's company**;
   - that the client is active;
   - fresh-login needs (`prompt=login`, `max_age`).

   Then it calls `provider.interactionResult()` with
   `{login: {accountId: userId, ts: <HRForce login instant>, amr, remember: false}}` and answers
   `{redirectTo: <issuer>/auth/<uid>}`. The browser navigates there, and the provider redirects to the RP with the
   code.

A browser without the interaction cookie cannot read or complete another browser's interaction. The prototype checked
this, and it closes the "complete someone else's interaction" login-CSRF.

**HRForce's session is the SSO session.** An extra check in the `login` prompt (`hrforce_session`) asks for the
interaction on **every** authorization request that has no interaction result yet. The provider's own session never
grants a sign-in by itself. This has three effects:

- Signing out of HRForce, or an expired or revoked HRForce session, means the next app sign-in asks for the password.
- `prompt=none` always answers `login_required`. Silent iframe re-authentication is not offered, and
  `frame-ancestors 'none'` forbids it anyway.
- A disabled user, or a revoked session whose access token is still valid, is refused at `complete`.

### 4. Cookies, XSRF and CSP

- The provider's cookies are renamed `hrf_op_session`, `hrf_op_interaction` and `hrf_op_resume`, each with a `.sig`
  companion. They are `HttpOnly` and `SameSite=Lax`, because the RP → `/oidc/auth` and RP → `/oidc/session/end`
  navigations are cross-site in production. They get `Secure` when `COOKIE_SECURE`.
- `hrf_op_session` has `Path=/oidc` and is a browser-session cookie (`remember: false`, so it is gone when the browser
  closes: shared PCs).
- They are signed with a key derived from `OIDC_KEY`.
- HRForce's cookies are never sent to `/oidc`, and the provider's cookies are only sent to `/oidc/*` and to one
  interaction's `/api/sso/interactions/<uid>*`.
- `/oidc/*` has no HRForce XSRF check, because it never reads HRForce credentials. The provider protects its own flows
  with state, PKCE, nonce and the logout form's `xsrf`.
- The only bridge, `complete`, is a normal Nest POST under `/api` with the signed XSRF check, a Strict session cookie
  and the interaction-cookie binding.
- **The API sets the CSP of `/oidc` responses itself, and Caddy does not overwrite it there.** The library renders
  inline auto-submit scripts in a few places: form_post, the account-switch step of resume, and logout without a
  session. It adds each script's `sha256-` hash to an existing `Content-Security-Policy` header (`script_src_sha.js`),
  so the header must exist before rendering. Chrome also applies `form-action` to the redirect that follows a form
  submission, so the logout page's policy adds the origin of the requested `post_logout_redirect_uri`.
  `frame-ancestors 'none'` and `X-Frame-Options: DENY` (Caddy, global) stop clickjacking of every `/oidc` page and of
  the Angular interaction page.
- Only the `query` response mode is allowed (client metadata `response_modes: ['query']`, checked: form_post → 400).

### 5. Keys and secrets

- **ID token signing:**
  - Algorithm and key: RS256 (RSA 2048). OIDC Core requires OPs to support RS256, and the sister apps are unknown,
    possibly PHP or Java.
  - Storage: private JWKs in `oidc.signing_key`, encrypted with AES-256-GCM under a subkey of **`OIDC_KEY`** (env,
    base64 of 32 bytes, required in production), with the `kid` as additional data.
  - Boot: the API loads the `current`, `next` and `retired` keys; the first key is the signing key. It creates the
    first key when none exists (under an advisory lock).
  - **Rotation** is a two-step CLI run as the migrator: `stage` publishes a `next` key; after ≥ 24 h `promote` makes
    it `current` and retires the old one, which stays published; `prune` drops retired keys after 7 days. The API is
    restarted after each step, because the provider's keystore is fixed at construction.
  - Emergency rotation: stage + promote + prune at once. Clients refetch the JWKS on an unknown `kid`; `openid-client`
    does.
- **Client secrets:** 32 random bytes, shown **once**, stored **encrypted** (AES-256-GCM, `OIDC_KEY` subkey, AAD =
  `client_id`), not hashed. The library compares the presented `client_secret` with the stored value, so it needs the
  secret in clear. The only hash-friendly alternatives are `client_secret_jwt` and `private_key_jwt`, and those push
  JWT client authentication onto sister apps whose stack is unknown. Rotation replaces the secret at once.
- **Model storage without bearer values at rest:** the adapter stores `sha256(id)` as the key and drops from the
  payload every field equal to the id (`jti`, `uid`). Authorization codes, access tokens and session ids are therefore
  not usable from a database dump or backup. The prototype checked that no stored payload contains a `jti` value.
- `OIDC_KEY` is never rotated in place in this slice (as `AUTH_MFA_KEY`). If it is lost, every client secret and
  signing key becomes unreadable: `/oidc` answers 503 and the rest of HRForce keeps working. The recovery is
  `oidc:keys reset` plus a secret rotation for each client.

### 6. Logout: RP-initiated logout also ends the HRForce session

`/oidc/session/end` always renders HRForce's own small bilingual (fr + ar) logout page. There are two cases:

- **The request carries a valid `id_token_hint`:** the page runs at once. A same-origin script calls
  `POST /api/auth/logout {expectedUserId: <hint sub>}`, which is the existing endpoint, now with an optional guard.
  That call revokes the browser's HRForce session family only when it belongs to that user, and is audited
  `auth.logout`. The script then submits the provider's confirm form (`logout=yes`), and the provider ends its session,
  revokes the grant's access tokens and redirects to the registered `post_logout_redirect_uri`.
- **The request has no hint:** the page asks for confirmation first.

Why end HRForce too:

- HRForce's session *is* the SSO session (§3). Keeping it would make the app's "Se déconnecter" useless: the next
  "Se connecter avec HRForce" would sign the same person in silently.
- Agencies share workstations, and the user expects to be signed out.

The cost: other HRForce tabs are signed out, and other connected apps keep their own local sessions until they expire
(no back-channel logout in this slice). Signing out *inside HRForce* does not sign anyone out of the apps. This is the
same limit, and it is listed as later work.

### 7. App roles and claims

- Clients, their roles and the role assignments are **tenant data** (`sso_client`, `sso_app_role`,
  `sso_role_assignment`: `company_id`, RLS, audited).
- A client belongs to one company. The provider finds it by its globally unique `client_id` through one
  `SECURITY DEFINER` lookup, before any tenant is known, as the kiosk pairing lookup does.
- Claims are computed in the **client's company**, and the user must be a member of it.
- Scopes and claims:

  | Scope | Claims |
  |---|---|
  | `openid` | `sub` = the HRForce user id: a random UUID, stable, meaningless, the same for every app |
  | `profile` | `name`, `preferred_username` (the e-mail), `locale` |
  | `email` | `email`, `email_verified: true` |
  | `hrforce` | `company` `{id, code, name}`, `employee` `{matricule, unit}` or `null`, and `roles`: the codes of the user's roles **in that client**, `[]` when none |

- `conformIdTokenClaims: false` puts these claims in the ID token, not only in userinfo.
- No refresh tokens: the only grant type is `authorization_code`, and `offline_access` is not offered. PKCE with
  S256 is required for every client. The code lives 60 s, the ID token and the (opaque, userinfo-only) access token
  5 min.

## Library facts (verified in a scratch prototype, 2026-09-30)

| Package | Version | Notes |
|---|---|---|
| `oidc-provider` | **9.12.2** (latest; MIT) | ESM only (`"type": "module"`, no `exports` map; `import Provider, { interactionPolicy } from 'oidc-provider'` works from the API's NodeNext ESM). Runtime deps: `koa@3.2.1`, `jose@6.2.12`, `debug`. ~0.9 MB + koa 0.5 MB + jose 0.4 MB. Ran on Node 22.22.3. |
| `@types/oidc-provider` | **9.12.1** (dev) | Type-checks with TypeScript **7.0.2** `strict`, `skipLibCheck: false` (Adapter, Configuration, `interactionPolicy.Check`, `KoaContextWithOIDC`). |
| `openid-client` | **6.8.8** (MIT) | ESM, ships its own types; deps `jose@6`, `oauth4webapi@3.8.8`. |

Prototype:
- Setup: Express 5 with the provider at `/oidc` and a Postgres 16 adapter storing `sha256(id)`. Clients were read
  from a table with an AES-GCM-encrypted secret, and an RS256 key was generated, encrypted, stored and loaded at boot.
  The interaction went through the `/api/sso/interactions/:uid` entry, `details`, `complete` and `abort`. The relying
  party was `openid-client`, driven by a scripted browser with a real cookie jar (`tough-cookie`).
- **19/20 checks passed.** The one failure was a wrong test expectation: form_post is refused with a 400 page, not a
  redirect. The rest:
  - discovery;
  - the full code + PKCE round trip with `roles` in the ID token, and the same claims at userinfo;
  - a second sign-in going through the interaction again;
  - `prompt=none` answering `login_required`;
  - abort answering `access_denied`;
  - a wrong client secret answering `401 invalid_client`;
  - an unregistered `redirect_uri` getting a 400 page with no redirect;
  - a missing PKCE answering `invalid_request`;
  - a browser without the interaction cookie being refused;
  - logout with `id_token_hint` rendering the custom page and, after confirmation, redirecting to the registered URI;
  - a disabled client answering `invalid_client`;
  - no `jti` at rest.

Gotchas (the build must handle each):
1. **`devInteractions` is enabled by default.** Disable it. Also disable `pushedAuthorizationRequests`, `dPoP`,
   `resourceIndicators` (enabled by default in 9.x), `introspection`, `revocation`, `registration` and
   `clientCredentials`. Set `clientBasedCORS` to refuse browser CORS: the clients are server-side.
2. **The interaction cookie's path is the pathname of the interaction URL.** That forces the `/api` entry hop (§3).
3. **The always-interact check must return "no need" when `ctx.oidc.result?.login` exists**, otherwise the resume step
   loops. It must carry the error `login_required`, otherwise `prompt=none` gets `interaction_required` with our
   description.
4. **`conformIdTokenClaims` defaults to `true`**, which puts the scope claims only in userinfo. Set it to `false`.
5. **`loadExistingGrant` must reuse `ctx.oidc.session.grantIdFor(clientId)`** (or the result's `consent.grantId`)
   before creating a Grant. Otherwise every call writes a Grant row (6 rows for 3 sign-ins in the first run).
6. Cookies are signed only when `cookies.keys` is set; each signed cookie has a `.sig` companion.
7. Koa needs `provider.proxy = true` behind Caddy, otherwise the URLs come out as `http` and a `Secure` cookie over
   "http" throws. Koa's `proxyIpHeader`/`maxIpsCount` follow `TRUST_PROXY_HOPS` for `ctx.ip`.
8. If a body parser ever ran before the provider, the library falls back to `req.body` with a warning. Mount it first.
9. Inline-script CSP hashes are pushed only into a CSP header set **before** rendering (§4). Chrome applies
   `form-action` to redirects after a form POST.
10. `id_token_hint` validation ignores the expiry (`ignoreExpiration: true` in `IdToken.validate`), so logout works
    with an old ID token.
11. `openid-client` 6 needs `allowInsecureRequests` for an `http://` issuer (dev only). Its default client
    authentication is `client_secret_post`, so pass `ClientSecretBasic` explicitly when the client is registered
    that way.
12. The `/oidc` requests are not seen by `nestjs-pino`'s HTTP logger (Nest middleware is registered after the mount):
    the module adds its own access-log line, with no query string and no bodies.
13. `amr` and `auth_time` appear in the ID token only when they are listed in the `openid` claims
    (`['sub', 'amr', 'auth_time']`, checked); clients also get `require_auth_time: true`. An extra client metadata
    property keeps its snake_case name on the client instance (`client['hrforce_company_id']`).
14. Discovery lists the provider-wide `response_modes_supported` (`form_post`, `fragment`, `query`) although each
    client allows `query` only. The build overrides the discovery value to `["query"]` if the library allows it,
    and otherwise lists it as known.

## Consequences

**Positive**
- One account, one password and one second factor for the group's apps, with HRForce's existing sign-in page, lockout,
  two-step policy and audit.
- No new infrastructure. The provider's state is a few Postgres tables, and a database dump holds no bearer value.
- App roles are managed next to the HRForce access rights by the same admins, with the same audit.
- Standard OIDC (discovery, code + PKCE, RS256, JWKS), so any OIDC-capable app or library can connect.

**Negative**
- An authentication library now runs inside the HR API process, and a bug or vulnerability in `oidc-provider` or Koa
  is a bug in HRForce. Mitigations: pinned versions, a minimal feature set (gotcha 1), and the verifier's probes.
- Every app sign-in makes a round trip through the Angular page, which means one extra SPA boot (~1 s). There is no
  `prompt=none` and no iframe silent renew.
- RP logout ends the HRForce session in that browser (a deliberate trade, §6). There is no single logout across apps
  yet.
- Client secrets are decryptable by the API: the trust question of `hrforce_app` (HANDOFF question 3) now also covers
  them.
- Key rotation needs an API restart per step.
- Global uniqueness of `client_id` tells an admin of one company that another company of the group uses an id.

## Alternatives considered

- **Keycloak or Zitadel next to HRForce:** full-featured (SAML, directories), but a second identity system with its
  own database, users and admin UI. HRForce's users, second factor and roles would then need syncing, which ADR 004
  retired `cats_queue` to avoid. It is still the answer if SAML-only products or directory federation come up
  (open question 1).
- **A hand-written minimal OIDC server:** less code in the tree, but none of the library's conformance testing.
  Rejected for security.
- **Interaction pages rendered by the API:** simpler cookies, but a second sign-in page, second-factor UI and i18n to
  keep in step with Angular. Rejected: the owner wants HRForce's own sign-in page.
- **Letting the provider's session grant silent SSO:** a second session with its own lifetime that outlives HRForce
  sign-out. Rejected (§3).
- **Hashed client secrets with `client_secret_jwt` / `private_key_jwt`:** better secret hygiene, but a harder
  integration for unknown legacy stacks. Later, per client.
- **ES256 signing:** smaller and faster, but not universally supported by older RP libraries. RS256 is chosen; ES256
  could be published next to it later.
- **Pairwise `sub`:** better privacy between apps, but it defeats correlation with HRForce for the planned outbox
  integration, and the apps are first-party. Not now.
- **Keeping the HRForce session on RP logout:** see §6.

## Later (not in this slice)

Back-channel logout (and HRForce sign-out propagating to the apps); refresh tokens (`offline_access`); consent for
third-party apps; per-unit delegation of app-role assignment; roles with validity periods; secret rotation with an
overlap window; `private_key_jwt`; SAML (only through a separate IdP, see alternatives); `OIDC_KEY` re-keying; staging
deployment of the demo app.

## Supersedes

The "SSO/OIDC is out of scope for P1" paragraph of ADR 004 (Decision and Negative consequences) for the parts
described here. ADR 004's cookies, XSRF and session design stay unchanged, and this ADR builds on them.
