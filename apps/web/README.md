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
    shared/                    reusable UI used by several features (may import core/, never features/)
      org-unit-picker/         <app-org-unit-picker>: search-as-you-type combobox, a ControlValueAccessor (value = unit id)
    features/<name>/           pages (auth/login, home, organization, not-found, placeholder)
    shell/                     shell widgets (language switcher)
  testing/                     test-only helpers (translocoTesting()), excluded from the app build
public/i18n/{fr,ar,en}.json    translations, nested keys
```

## Organization feature (`/organization`)

Built against `docs/contracts/organization.md`.

- **Page** (`features/organization/organization.page.ts`): the org tree as of a date. The date lives in the URL
  (`/organization?asOf=2025-01-31`, default today) and reaches the page as a signal input via
  `withComponentInputBinding()`. Selecting a node loads its detail (`GET /org/units/:id`) with the version history.
- **Create / change**: "Add a sub-unit" shows when the node's `_actions` has `create_child`, "Change" when it has
  `update`. The create form posts kind/code/name/effective date under the selected parent; the change form sends
  only what changed (name and/or parent, chosen with the org-unit picker restricted to valid parent kinds). 422 and
  409 `errors[]` land on the matching field; 409s without a field show as a form-level message. A successful write
  reloads the tree and the detail.
- **Picker** (`shared/org-unit-picker/`): use it in any reactive form:
  `<app-org-unit-picker formControlName="unitId" inputId="unit" [kinds]="['region']" [asOf]="date" />`.
  Debounced search on `GET /org/units`, stale requests cancelled, ARIA combobox keyboard support.

### Running it against the API (development only)

Until the Identity module exists, the API accepts a development identity:

1. Start Postgres and migrate (`npm run migrate -w @hrforce/api`, see `apps/api/README.md`), then seed the demo company:
   `npm run seed:dev -w @hrforce/api` (company `GROUPE` Groupe Démo with 3 regions and 6 sites, fixed ids).
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
