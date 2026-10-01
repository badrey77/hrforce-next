# SSO demo — a fictitious sister app signing in through HRForce

`@hrforce/sso-demo` is a deliberately small **OpenID Connect relying party**. It shows what a sister app does with
HRForce single sign-on (ADR 007, contract `docs/contracts/sso.md` › *Demo sister app*):

1. The home page offers « Se connecter avec HRForce ».
2. The browser goes to HRForce's sign-in page, including the two-step code when the account has one.
3. HRForce sends it back to `/callback`. The demo exchanges the code and checks the ID token.
4. The welcome page shows:
   - who signed in: name, e-mail, company, employee number and unit;
   - **the user's roles in this app**, managed in HRForce (Access → Applications): `operator` → « Opérateur » /
     « التشغيل », `supervisor` → « Superviseur » / « الإشراف ». With no role, a clear notice appears instead;
   - a « Données reçues » panel listing the ID-token claims. The raw token is never shown.
5. « Se déconnecter » ends the demo's session and HRForce's session in that browser (RP-initiated logout), then comes
   back to `/signed-out`.

The pages exist in French and Arabic (right-to-left), with a language link on every page.

## Run it

The easiest way is `./scripts/dev-up.sh` or `scripts\dev-up.ps1` from the repo root. It:
- creates `apps/sso-demo/.env` from `.env.example`;
- builds the demo;
- starts it with the API, the worker and the web app, in a fourth process or window, « HRForce SSO demo ».

Then open <http://localhost:4300>. The password of every demo user is `demo-password-2026`.

| User | What the demo shows |
|---|---|
| `agent.annaba@demo.dz` | « Opérateur », matricule EMP-0030, Agence Annaba |
| `chef.annaba@demo.dz` | « Superviseur » |
| `rh.est@demo.dz` | the "no role" notice, in Arabic (the account's language) |
| `rh.admin@demo.dz` | no employee block (the account is not linked to an employee) |

To run it by hand, HRForce (API + web on port 4200, with the `seed:dev` data) must be running first:

```bash
cp apps/sso-demo/.env.example apps/sso-demo/.env    # once
npm run build -w @hrforce/sso-demo
npm start -w @hrforce/sso-demo                       # node --env-file-if-exists=.env dist/main.js
```

At start-up the demo fetches HRForce's discovery document
(`http://localhost:4200/oidc/.well-known/openid-configuration`, through the web dev server's `/oidc` proxy). It
retries every 2 s for 60 s, then exits with code 1.

### Configuration (`.env`, validated at boot)

| Variable | Development value | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `production` enforces the rules marked below |
| `SSO_DEMO_PORT` | `4300` | the demo ignores `PORT` (the API's) |
| `SSO_DEMO_BASE_URL` | `http://localhost:4300` | redirect URI `${base}/callback`, post-logout URI `${base}/signed-out`; both must be registered in HRForce exactly |
| `SSO_DEMO_ISSUER` | `http://localhost:4200/oidc` | `https://` in production |
| `SSO_DEMO_CLIENT_ID` | `sso-demo` | |
| `SSO_DEMO_CLIENT_SECRET` | the seed's **public, development-only** secret | ≥ 32 characters. The development value (it contains `INSECURE`) is refused in production |
| `SSO_DEMO_COOKIE_SECURE` | `false` | `true` in production |
| `LOG_LEVEL` | `info` | |

The development secret only works with the development `OIDC_KEY` of the API: the seed stores it encrypted with that
key. If the demo gets `invalid_client`, the secret no longer matches. In that case:
1. rotate the secret in HRForce (Access → Applications → « Démo SSO » → « Régénérer le secret »);
2. paste the new secret into `apps/sso-demo/.env`;
3. restart the demo.

## How it is built

- TypeScript (ESM, strict), Express 5, `openid-client` 6.8.8, `pino`, `zod` for the environment. Built with `tsc` to
  `dist/`.
- **No client-side JavaScript and no template engine.** Pages come from small functions (`src/pages.ts`). Every
  value goes through the `html` tagged template (`src/html.ts`), which escapes it.
- Sessions live in memory (`src/session.ts`), so a restart signs everyone out.

| File | Role |
|---|---|
| `src/main.ts` | validates the environment, runs discovery with retry, listens |
| `src/app.ts` | the routes |
| `src/oidc.ts` | the `openid-client` calls (authorization URL, code exchange, end-session URL) |
| `src/pages.ts`, `src/i18n.ts`, `src/html.ts`, `src/styles.ts` | pages, fr/ar wording and role labels, escaping, stylesheet |
| `src/claims.ts` | reads the ID-token claims defensively |
| `src/security.ts` | response headers (CSP) and cookie parsing |

### Routes

| Route | Behaviour |
|---|---|
| `GET /` | the home page, or 303 `/welcome` when signed in |
| `GET /login` | creates the PKCE verifier, `state` and `nonce`, then 303 to HRForce `/oidc/auth` |
| `GET /callback` | exchanges the code, regenerates the session id, then 303 `/welcome`. A cancellation (`access_denied`) shows « Connexion annulée. »; any other failure shows the error page with the OAuth error code only |
| `GET /welcome` | the identity and the app roles (303 `/` when signed out) |
| `POST /logout` | drops the local session, then 303 to HRForce `end_session` with `id_token_hint` and `post_logout_redirect_uri` |
| `GET /signed-out` | the "signed out" page |
| `GET /lang/fr`, `GET /lang/ar` | switches the language, then goes back to `?next=` (a demo page) or `/` |
| `GET /assets/demo.css` | the stylesheet |

### Security choices, even for a demo

- **Protocol:** authorization code + PKCE (S256) + `state` + `nonce`, with client authentication
  `client_secret_basic`. `openid-client` checks everything:
  - `state` and the response's `iss` (mix-up protection);
  - the ID token's signature (RS256, via the JWKS), `aud`, `exp` and `nonce`.
- **One attempt per sign-in:** the pending verifier is dropped before the code exchange, so a replayed or failed
  callback cannot reuse it.
- **Callback URL:** it is rebuilt from `SSO_DEMO_BASE_URL`, never from the `Host` header.
- **Session cookie `sso_demo_sid`:**
  - 256 random bits, `HttpOnly; SameSite=Lax; Path=/`, and `Secure` in production;
  - the id is **regenerated after sign-in** (fixation);
  - it expires after 8 h idle, and a pending sign-in after 10 min.
- **Sign-out:** it is a POST form. `SameSite=Lax` keeps cross-site POSTs out, and a foreign `Origin` header is also
  refused.
- **Headers on every response:**
  - `Content-Security-Policy: default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self' <issuer origin>;
    frame-ancestors 'none'; base-uri 'none'`. No script can run. The issuer origin is in `form-action` because the
    sign-out POST is answered by a redirect to HRForce;
  - `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`,
    `Cache-Control: no-store`.
- **Logs:** one line per request (method, path without the query string, status, duration). Codes, tokens, the
  client secret and claims are never logged, and pino redaction paths add a safety net.
- **Roles:** `roles` is the only authorization claim. `company`, `employee` and `unit` are display data.

## Tests

```bash
npm test -w @hrforce/sso-demo
```

- **Unit tests:**
  - page building in fr and ar: `dir`, escaping of a `<script>` name, role labels, the no-role notice, a null
    employee;
  - the environment rules, the session expiry, the CSP header and the discovery retry.
- **Integration test (`src/app.spec.ts`):** the real `openid-client` against a fake provider
  (`src/test-support/fake-provider.ts`: discovery, JWKS, token endpoint, RS256 ID tokens). It covers:
  - the whole sign-in, with the session id regenerated, then sign-out;
  - a wrong `state`, a wrong `iss`, a wrong `nonce`, a replayed callback, `access_denied` and `invalid_grant`;
  - the language switch.

The real round trip through HRForce is covered by `apps/api/test/sso.e2e-spec.ts` and by the browser verification.
