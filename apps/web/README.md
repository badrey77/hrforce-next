# @hrforce/web

Angular SPA for HRForce Next. It uses standalone components, signals, zoneless change detection, strict mode with `strictTemplates`, Transloco for i18n and Vitest for unit tests.

## Requirements

- Node **≥ 22.22.3** (Angular 22 engine requirement; `.npmrc` has `engine-strict=true`), npm 11.
- Install from the repo root: `npm install`.

## Scripts (run from the repo root)

| Command | What it does |
| --- | --- |
| `npm start -w @hrforce/web` | `ng serve` on http://localhost:4200. `proxy.conf.json` forwards `/api` to the API at http://localhost:3000 (same origin for the browser, so the httpOnly session cookies just work). |
| `npm run build -w @hrforce/web` | Production build to `apps/web/dist/web/browser`. |
| `npm test -w @hrforce/web` | Runs the Vitest unit tests once, headless (jsdom, via `@angular/build:unit-test`). |
| `npm run typecheck -w @hrforce/web` | `ngc` for the app (type-checks templates too), `tsc` for the specs. |
| `npm run lint` (root) | oxlint across the repo. |

## Layout

```
src/
  main.ts, index.html          index.html ships lang="fr" dir="ltr"; the language service updates both at runtime
  styles.css                   design tokens + form/button basics (CSS logical properties only)
  app/
    app.config.ts              router, HttpClient (fetch, XSRF, interceptors), Transloco, app initializers (language, session)
    app.routes.ts              lazy routes; canMatch authGuard on app pages, guestGuard on /login, open password pages
    app.ts|html|css            shell: header (title, user menu, language switcher), side nav (signed in only), <main>
    core/auth/                 Identity: AuthApi, Session (root signal store), authGuard/guestGuard, refresh interceptor
                               (single-flight), initializeSession() (csrf → /api/me), safeReturnUrl()
    core/i18n/                 languages, LanguageService (device choice vs account locale), Transloco HTTP loader
    core/http/                 ApiProblem + parser + retryAfterSeconds(), apiProblemInterceptor, applyServerErrors(), XSRF names
    core/date/                 todayIso(), isIsoDate() — dates are `YYYY-MM-DD` strings end to end
    core/org/                  Organization contract types + OrgApi (httpResource reads, Observable writes/search)
                               + KindCatalog (kind catalogue from GET /org/kinds, once per app, labels in the active language)
    shared/                    reusable UI used by several features (may import core/, never features/)
      org-unit-picker/         <app-org-unit-picker>: search-as-you-type combobox, a ControlValueAccessor (value = unit id)
    features/<name>/           pages (auth: login, password setup/forgot; home, organization, not-found, placeholder)
    shell/                     shell widgets (language switcher, user menu with "Sign out")
  testing/                     test-only helpers (translocoTesting(), org and auth fixtures), excluded from the app build
public/i18n/{fr,ar,en}.json    translations, nested keys
```

## Organization feature (`/organization`)

Built against `docs/contracts/organization.md` **v2**: one management tree (Direction générale → départements →
régions → agences, services under a department, a region or an agency) and sites as places that host units.

- **Kinds are data.** `KindCatalog` (`core/org/kind-catalog.ts`) loads `GET /org/kinds` once per app and serves
  `kinds()`, `labelOf(code)` (in the active language, follows language switches), `allowedChildKinds(parentKind)`
  and `allowedParentKinds(kind)`. The web has no kind union, no parent-rule table and no `org.kind.*` i18n keys.
- **Tree page** (`features/organization/organization.page.ts`): the org tree as of a date. The date lives in the URL
  (`/organization?asOf=2025-01-31`, default today) and reaches the page as a signal input via
  `withComponentInputBinding()`. Rows show the kind label from the catalogue and the effective site where it
  differs from the parent's; children keep the API order. Selecting a node loads its detail (`GET /org/units/:id`):
  effective site (with "inherited" when `siteInherited`) and the version history with a site column.
- **Create / change**: "Add a sub-unit" shows when the node's `_actions` has `create_child` **and** the catalogue
  allows at least one child kind; "Change" when it has `update`. The create form offers only the allowed child kinds
  (preselected when there is one) and a site select defaulting to "inherit from parent" (`siteId: null`). The
  change form sends only what changed: name, parent (org-unit picker restricted to the allowed parent kinds, sent as
  repeated `kind=` params) and/or site ("inherit" = `siteId: null`). The root cannot move and must keep a site
  (no "inherit" option). 422 and 409 `errors[]` land on the matching field; `org-unit-root-site-required` and
  `site-not-found` land on the site field and `site-code-taken` on the code field even without `errors[]`; other
  409s without a field show as a form-level message. A successful write reloads the tree and the detail.
- **Sites** (`/organization/sites`, `features/organization/sites.page.ts`): a sub-route of the feature, linked from
  both pages by `<app-org-nav>`, lazy-loaded as its own chunk. Lists sites (code, name, wilaya, address) with a
  search kept in the URL (`?q=`), and a create form (code, name, wilaya, optional address). **Wilaya is free text
  for now**; a wilaya reference list (and a select) can come later without changing the API shape.
- **Picker** (`shared/org-unit-picker/`): use it in any reactive form:
  `<app-org-unit-picker formControlName="unitId" inputId="unit" [kinds]="['region', 'agency']" [asOf]="date" />`.
  Debounced search on `GET /org/units` (several kinds → `kind=region&kind=agency`, filtered by the server), stale
  requests cancelled, ARIA combobox keyboard support, kind badges from the catalogue.

### Running it against the API (development only)

1. Start Postgres and migrate (`npm run migrate -w @hrforce/api`, see `apps/api/README.md`), then seed:
   `npm run seed:dev -w @hrforce/api` (the Organization v2 demo company and two active users, below).
2. Start the API with `NODE_ENV=development DEV_PERMISSIONS=allow_all COOKIE_SECURE=false MAIL_TRANSPORT=log`
   (plus the API's usual env). `DEV_PERMISSIONS=allow_all` grants every permission to any signed-in user until the
   Authorization module exists; `COOKIE_SECURE=false` lets the browser keep the cookies over plain `http://localhost`;
   `MAIL_TRANSPORT=log` writes outgoing mail, **including password setup/reset links, to the API log**.
3. `npm start -w @hrforce/web`, open http://localhost:4200 and sign in.

| Dev user | Name | Locale | Password |
| --- | --- | --- | --- |
| `rh.admin@demo.dz` | Amina Benali | fr | `demo-password-2026` |
| `rh.est@demo.dz` | Karim Haddad | ar | `demo-password-2026` |

To try the password pages: `/password/forgot` with one of the addresses above, then open the
`http://localhost:4200/password/setup?token=…` link printed in the API log.

## Authentication (docs/contracts/identity.md, ADR 004)

- **Cookies only.** Access and refresh tokens are httpOnly cookies; the web never sees them. Angular's XSRF support
  copies the `XSRF-TOKEN` cookie into `X-XSRF-TOKEN` on same-origin POST/PUT/PATCH/DELETE.
- **Startup** (`core/auth/session-init.ts`, an app initializer): `GET /api/auth/csrf` so the XSRF cookie exists
  before the first POST, then `GET /api/me` → `Session` (`user`, `company`, `companies`, `isAuthenticated`).
  The router's first navigation waits for it.
- **Guards** (`core/auth/auth.guards.ts`): `canMatch: [authGuard]` on every page except `/login`, `/password/setup`,
  `/password/forgot` and `**` → `/login?returnUrl=…`; `canMatch: [guestGuard]` on `/login` → `/`.
- **Expired access token** (`core/auth/auth-refresh.interceptor.ts`): a 401 from `/api/*` (not `/api/auth/*`)
  triggers one shared `POST /api/auth/refresh`, then each failed request is retried once; 409 `refresh-race` →
  retry; refresh failure → signed out and `/login?returnUrl=<current page>`.
- **Login** (`features/auth/login.page.ts`): 401 / 423 / 429 (minutes from `Retry-After`) / 403 disabled messages;
  `returnUrl` must be an internal path (`core/auth/return-url.ts`), otherwise `/`. After login the account's
  `locale` is applied unless a language was picked on this device (it is not stored, so it never counts as a pick).
- **Password pages**: `/password/setup?token=` (12–128 chars and confirmation checked in the browser; the server's
  422 codes `too_short`/`too_long`/`contains_email`/`common` are translated; 410 → "link invalid or expired" with a
  link to `/password/forgot`) and `/password/forgot` (always the same confirmation, no account enumeration).
- **Sign out** (header): `POST /api/auth/logout`, then signed out locally and `/login`, even if the call failed.

## Conventions

- **i18n.** `fr` is the default and fallback language. `ar` is RTL. `en` may be missing some keys.
  - `fr.json` and `ar.json` must have identical key sets; `translations.spec.ts` checks this, and so does the repo guardrail.
  - Use `*transloco="let t"` in templates.
  - Switch languages only through `LanguageService.use(lang)`. It sets Transloco's active language and `<html lang dir>`, and stores the choice in `localStorage` (`hrforce.lang`).
- **RTL.** Use CSS logical properties only (`margin-inline-start`, `padding-inline`, `inset-inline-start`, `border-inline-end`, …). Never use `left`/`right`.
- **HTTP.** Call the API at same-origin `/api/...`.
  - Cookies are httpOnly. Angular sends the `X-XSRF-TOKEN` header from the `XSRF-TOKEN` cookie.
  - Every HTTP failure reaches callers as an `ApiProblemError`. Read `err.problem` (`type`, `title`, `status`, `detail?`, `requestId?`, `errors?[{field, code, message}]`) and narrow with `isApiProblemError(err)`.
  - A status of `0` means a network failure; its problem type is `urn:hrforce:problem:network`.
- **Server validation.** For 400/422 responses, call `applyServerErrors(form, problem)`. It sets `{ server: message }` on each control named by `errors[].field` (dotted paths reach nested groups) and returns the errors that matched no control.
- **Types.** No `any`. Components use `OnPush`.
- **Boundaries.** `features/<a>` never imports `features/<b>`; `core/` and `shared/` never import `features/`.
  Code used by several features goes in `core/` (services, models) or `shared/` (UI components).
