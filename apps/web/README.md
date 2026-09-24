# @hrforce/web

Angular SPA for HRForce Next. It uses standalone components, signals, zoneless change detection, strict mode with `strictTemplates`, Transloco for i18n and Vitest for unit tests.

## Requirements

- Node **≥ 22.22.3** (Angular 22 engine requirement; `.npmrc` has `engine-strict=true`), npm 11.
- Install from the repo root: `npm install`.

## Scripts (run from the repo root)

| Command | What it does |
| --- | --- |
| `npm start -w @hrforce/web` | `ng serve` on http://localhost:4200. `proxy.conf.json` forwards `/api` to the API at http://localhost:3000. |
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
    app.routes.ts              lazy routes: '', /login, placeholders, ** → not found
    app.ts|html|css            shell: header (title + language switcher), side nav, <main>
    core/i18n/                 languages, LanguageService, Transloco HTTP loader
    core/http/                 ApiProblem + parser, apiProblemInterceptor, applyServerErrors()
    features/<name>/           pages (auth/login, home, not-found, placeholder)
    shell/                     shell widgets (language switcher)
  testing/                     test-only helpers (translocoTesting()), excluded from the app build
public/i18n/{fr,ar,en}.json    translations, nested keys
```

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
