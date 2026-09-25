# @hrforce/web

Angular SPA for HRForce Next. It uses standalone components, signals, zoneless change detection, strict mode with `strictTemplates`, Transloco for i18n and Vitest for unit tests.

## Requirements

- Node **≥ 22.22.3** (Angular 22 engine requirement; `.npmrc` has `engine-strict=true`), npm 11.
- Install from the repo root: `npm install`.

## Scripts (run from the repo root)

| Command | What it does |
| --- | --- |
| `npm start -w @hrforce/web` | `ng serve` on http://localhost:4200. `proxy.conf.json` forwards `/api` to the API at http://localhost:3000 and adds the dev identity headers (see below). |
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
    app.config.ts              router, HttpClient (fetch, XSRF, interceptors), Transloco, language init
    app.routes.ts              lazy routes: '', /login, /organization (loadChildren), placeholders, ** → not found
    app.ts|html|css            shell: header (title + language switcher), side nav, <main>
    core/i18n/                 languages, LanguageService, Transloco HTTP loader
    core/http/                 ApiProblem + parser, apiProblemInterceptor, applyServerErrors()
    core/date/                 todayIso(), isIsoDate() — dates are `YYYY-MM-DD` strings end to end
    core/org/                  Organization contract types + OrgApi (httpResource reads, Observable writes/search)
                               + KindCatalog (kind catalogue from GET /org/kinds, once per app, labels in the active language)
    shared/                    reusable UI used by several features (may import core/, never features/)
      org-unit-picker/         <app-org-unit-picker>: search-as-you-type combobox, a ControlValueAccessor (value = unit id)
    features/<name>/           pages (auth/login, home, organization, not-found, placeholder)
    shell/                     shell widgets (language switcher)
  testing/                     test-only helpers (translocoTesting(), org fixtures: kind catalogue, sites), excluded from the app build
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

Until the Identity module exists, the API accepts a development identity:

1. Start Postgres and migrate (`npm run migrate -w @hrforce/api`, see `apps/api/README.md`), then seed the demo company:
   `npm run seed:dev -w @hrforce/api` (the contract's v2 seed: `DG` Direction Générale with departments, regions,
   agencies and services, and 7 sites; fixed ids).
2. Start the API with `DEV_AUTH=true` and `NODE_ENV=development` (the API refuses `DEV_AUTH` in any other environment).
3. `npm start -w @hrforce/web`, open http://localhost:4200/organization.

`proxy.conf.json` adds `X-Dev-User-Id: 0190a5d0-0000-7000-8000-0000000000aa` and
`X-Dev-Company-Id: 0190a5d0-0000-7000-8000-000000000001` to every proxied `/api` request, so the browser code never
knows about them. This exists **only in `ng serve`**: the production build has no proxy and sends no such headers,
and a production API rejects `DEV_AUTH`.

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
