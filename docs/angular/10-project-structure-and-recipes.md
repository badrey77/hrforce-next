# 10. Project structure and recipes

See also: [04-dependency-injection.md](./04-dependency-injection.md) for how
`core`/`shared` services get shared, [05-routing.md](./05-routing.md) for
`loadComponent`/`loadChildren`.

## Folders

```
src/
  main.ts, app.config.ts, app.routes.ts, app.ts|html|css   the app shell and bootstrap
  core/          app-wide infrastructure: services, models, http plumbing, i18n plumbing
    access/      AccessApi + Authorization contract types + AccessCatalog (permissions, roles; labels in the active language)
    auth/        Identity: AuthApi, Session (root signal store, permissions), guards (auth, guest, permission), refresh interceptor, session initializer
    date/        todayIso(), isIsoDate() — plain TS, no Angular
    http/        ApiProblem + apiProblemInterceptor + applyServerErrors() + problemToForm() + retryAfterSeconds() + XSRF names
    i18n/        languages, LanguageService, TranslocoHttpLoader
    org/         OrgApi + Organization contract types + KindCatalog (kind catalogue, once per app)
  shared/        reusable UI used by more than one feature
    can/         *appCan structural directive (show a template only with a permission)
    org-unit-picker/
  features/<name>/  one page/flow per feature: access, auth, home, organization, not-found, placeholder
  shell/         app-chrome widgets (language switcher, user menu) — not a route, not shared feature UI
  testing/       test-only helpers (translocoTesting, org fixtures), excluded from the app build
```

(`apps/web/README.md`'s "Layout" section has the same map with per-file notes — this
guide explains the *rules* behind it.)

## The boundary rules

`CONVENTIONS.md` states them; `.dependency-cruiser.cjs` enforces them in CI
(`npm run guard:boundaries`, tested by `tools/guardrails/boundaries/boundaries.spec.ts`):

| Rule | Enforced as |
|---|---|
| `features/<a>` never imports `features/<b>` | `web-feature-isolation` |
| `core/` never imports `features/` | `web-core-not-to-features` |
| `shared/` never imports `features/` | `web-shared-not-to-features` |
| No circular imports anywhere in `apps/web/src` | `no-circular` |

The direction that **is** allowed: `features/*` → `shared/*` → `core/*`, and
`features/*` → `core/*` directly. Data/services **two or more features will need** —
`OrgApi`, the Organization types — live in `core/org/`, *not* in
`features/organization/`, specifically so a future `features/employees/` can import
them without violating feature isolation (the `org.models.ts` header comment says this
explicitly: "other features — employees, permissions — will need the org types and the
picker too, and a feature must never import another feature"). The same reasoning put
`OrgUnitPicker` in `shared/`, not `features/organization/`.

`shell/` holds widgets that are part of the **application chrome** (`app.html`'s header
and nav) but aren't a route and aren't reusable business UI — `LanguageSwitcher` is
here, not in `shared/`, because nothing outside the shell composes it.

## Recipe: add a new page

Using the Employees screen as a running example (the routes/placeholder already exist
— `app.routes.ts`'s `'employees'` entry currently points at `PlaceholderPage`).

1. **Decide `loadComponent` vs `loadChildren`.** One page, no sub-routes planned yet →
   `loadComponent` (see `PlaceholderPage`'s current wiring). Expect sub-routes soon (a
   detail page, a history view) → give the feature its own `<feature>.routes.ts` and
   switch the parent entry to `loadChildren`, following
   `features/organization/organization.routes.ts` exactly.
2. **Create `features/employees/employees.page.ts`** (+ `.html`/`.css` if non-trivial).
   Standalone component, `selector: 'app-employees-page'`,
   `changeDetection: ChangeDetectionStrategy.OnPush` (always — `CONVENTIONS.md`).
   Start the class with a comment block naming the Angular concepts it introduces, per
   `CLAUDE.md`.
3. **Wire route params/query params it needs** as signal `input()`s, and enable
   `withComponentInputBinding()` reads them automatically — see chapter 05, and
   `organization.page.ts`'s `asOf` input for the pattern (validate/default with a
   `computed()`, don't trust the raw string).
4. **Update `app.routes.ts`** (swap the placeholder entry to point at the real page, or
   the feature's own routes file for `loadChildren`).
   Keep (or add) `canMatch: [authGuard]` on the entry; see "Recipe: protect a route".
5. **Add nav** — `app.ts`'s `navLinks` already has an `/employees` entry; if adding a
   *new* top-level route, add one there too, with a translation key (see the i18n
   recipe below).
6. **Test it** — a `RouterTestingHarness` spec if the page reads route state, following
   `organization.page.spec.ts`'s shape (see chapter 09).

## Recipe: protect a route

Every app page must be signed-in only (contract), so a new page needs its guard:

1. Add `canMatch: [authGuard]` to its entry in `app.routes.ts`, next to `path`. For a
   `loadChildren` feature, put it on the **parent** entry. Everything under it is then
   covered, and the chunk is never downloaded for signed-out visitors (chapter 05).
2. Do **not** use `canActivate` for this. It runs after a `loadChildren` chunk has
   already been fetched.
3. A page that must also work signed out (like an emailed link) gets **no** guard, and
   its API calls must not assume a session.
4. Test it in `auth.guards.spec.ts` style: signed out → `router.url` is
   `/login?returnUrl=…`; `Session.set(ME_FIXTURE)` → the page renders.

Needs a permission too? Add `permissionGuard()` **after** `authGuard` and put the code in
the route's `data`: `canMatch: [authGuard, permissionGuard()], data: { permission: 'employee.read' }`.
Without the permission the route does not match and the visitor lands on the 404 page
(deliberately `false`, not a `UrlTree`; see chapter 12). Order matters: `authGuard` first,
so signed-out visitors are still sent to /login.

## Recipe: hide a button by permission

1. **Is the button about one record?** (edit this unit, end this grant.) Then use the
   record's `_actions` from the API, not a permission. `@if (grant._actions.includes('end'))`
   in spirit. See `canEnd()` in `features/access/user-detail.page.ts`. A permission held
   *somewhere* does not mean it applies to *this* record.
2. **Is it page-level?** (add, create, a tab.) Import `CanDirective` from
   `shared/can/can.directive.ts` into the component and write

   ```html
   <button *appCan="'access.grant'" class="btn" type="button" (click)="startAdd()">…</button>
   ```

   Add `; else otherTemplate` plus an `<ng-template #otherTemplate>` to show something
   instead (`features/access/roles.page.ts`).
3. **Is the condition more than one permission?** Write `@if (session.can('a') && other())`
   with `protected readonly session = inject(Session)`. For a boolean used in class code,
   keep `session.allows('a')` in a field (chapter 12, §1).
4. **Never rely on it.** The API must refuse anyway. Map its 409/403 in the form
   (`problemToForm`, chapter 07).
5. **Test** with `Session.set(meWith([...]))` for both cases, then change the session
   and `await fixture.whenStable()` to prove it re-renders.

## Recipe: add an admin page

The Access feature (`features/access/`) is the worked example.

1. **Contract types + API** in `core/<domain>/` (recipe "add an API call"). Reference data
   the business names in three languages (roles, permission labels) goes in a root
   catalogue service with a `labelOf`/`roleName` that reads `LanguageService.current()`
   (recipe "add reference data"). If the endpoints need a permission, make the
   resources wait for it, as `AccessCatalog` does with `session.allows('access.read')`,
   so nothing is requested (and nothing 403s) for other users.
2. **Routes file** `features/<name>/<name>.routes.ts` with the landing page(s) imported
   statically, detail/editor pages as `loadComponent`, `redirectTo` for the bare path,
   static paths before `:id` paths (chapter 05).
3. **Mount it** in `app.routes.ts` with `canMatch: [authGuard, permissionGuard()]` and
   `data: { permission: '<resource>.read' }`.
4. **Nav**: add a `NavLink` with `permission: '<resource>.read'` to `app.ts`. The
   `visibleLinks` computed hides it from users without the permission.
5. **Section tabs** inside the feature: a small nav component like
   `features/access/access-nav.ts` (`routerLink` + `routerLinkActive`).
6. **Lists**: a query param (`?q=`) → signal input → `httpResource` (`users.page.ts`).
   **Details**: a route param → input → a resource **keyed on that input**, e.g.
   `member = api.userResource(this.id)` in `user-detail.page.ts` (`GET /access/users/:id`).
   A first version loaded the whole list and picked the member by id. Don't do that: it
   downloads every member to show one, and it can't tell "not visible" from "not loaded
   yet". The detail endpoint answers **404**, and the page shows "not found" (no retry
   button, since retrying can't help). **Forms**: typed reactive forms, a
   `SlugTable` for the 409s, `problemToForm` on error. **Confirmations with input**: a
   native `<dialog>` reached through `viewChild.required` (chapter 02).
7. **Write actions** behind `*appCan` (page level) or `_actions` (record level); **read-only
   modes** with `form.disable()` from an `effect()` (`role-editor.page.ts`).
8. **i18n**: every new text in `fr`, `ar` and `en`, with the same placeholders. Use logical
   CSS, `text-align: start` in tables, and `dir="auto"` on inputs that take text in
   another script.
9. **Tests**: `RouterTestingHarness` on `{ path: '<name>', children: ROUTES }`, a session
   fixture, `HttpTestingController` flushes for each resource (including catalogues), and
   the 409 mapping per slug.

## Recipe: add a History tab to a page

The audit timeline is one shared component; a page only wraps its detail view
(chapter 13 explains every piece).

1. **Pick the subject.** One of the contract's types (`org_unit`, `site`, `role`,
   `user`; `docs/contracts/audit.md` › Endpoint) plus the record's id. A new subject
   type (e.g. `employee`) needs the API first.
2. **Wrap the detail content** in `<app-history-tabs>` (import `HistoryTabs` from
   `shared/timeline/history-tabs.ts`):

   ```html
   <app-history-tabs [subject]="'role:' + role.id" [resolver]="auditNames">
     …what the page showed before (form, tables)…
   </app-history-tabs>
   ```

   The content is projected into the "Details" tab (hidden, never destroyed, so forms
   keep their state). Pass `null` as the subject when there is nothing to show yet
   (`roles/new` in `features/access/role-editor.page.html`): no tabs at all. Leave page-level
   UI such as a `<dialog>` outside the wrapper.
3. **Nothing to do for the permission.** The wrapper shows the tabs only with
   `audit.read` (`Session.allows`, chapter 12). The API still answers 403/404.
4. **Name the ids you already have.** Add a `resolver` field, `(kind, value) => name |
   undefined`, reading data the page holds (`organization.page.ts` uses the tree and
   the sites; `features/access/audit-names.ts` uses the role catalogue and the page's
   grants). Keep it a field, not an inline arrow. Never fetch just for names: an unknown
   id shows as stored.
5. **New tables or events?** Add `audit.fields.<table>.<column>`, `audit.tables.<table>`
   and `audit.events.<type>` keys to `fr.json` and `ar.json` (same placeholders; the
   i18n guardrail checks both). Unknown columns fall back to the column name, unknown
   events to `audit.events.unknown`. Columns that are pure noise (tenant id, generated
   columns) go in `HIDDEN_FIELDS` in `shared/timeline/timeline-view.ts`; id-like columns
   go in `REFERENCE_FIELDS` so the resolver is asked.
6. **Test** the tab like `user-detail.page.spec.ts`: hidden with
   `meWith(...without 'audit.read')`; with it, click `[data-tab="history"]`,
   `installIntersectionObserver()` + `enterViewport()` to play the `@defer` block through,
   then `http.expectOne(r => r.url === '/api/audit/timeline')` and check the `subject`
   param and a resolved name.

## Recipe: an API call that must not redirect to login

The refresh interceptor sends the user to `/login` when a refresh fails. For a call
where "not signed in" is a normal answer (the startup `/api/me`, a public page probing
the session), pass the `SKIP_LOGIN_REDIRECT` context flag, as `AuthApi.me()` does:
`this.http.get<T>(url, { context: new HttpContext().set(SKIP_LOGIN_REDIRECT, true) })`
(chapter 06). Calls under `/api/auth/*` never trigger a refresh at all.

## Recipe: add an API call

1. **Add the types** to the right `core/<domain>/` models file (or create one), copied
   from the binding contract in `docs/contracts/`. Keep field names and unions exactly
   matching the contract text — `org.models.ts`'s header comment says why: "the API
   builds against the same text."
2. **Add the method to the domain's `core/<domain>/<domain>-api.ts` service**
   (`@Injectable({ providedIn: 'root' })`, `inject(HttpClient)`):
   - **A page-level read that should refetch when some signal changes** → a resource
     method returning `HttpResourceRef<T | undefined>`, built with `httpResource()`,
     following `OrgApi.treeResource()`/`unitResource()` — the request-building function
     takes `() => …` signal-reading functions as parameters and returns `undefined` for
     "no request yet."
   - **A write, or a search/list driven by something other than plain signal
     dependencies** → a method returning `Observable<T>` via `this.http.get/post/patch`,
     following `OrgApi.search()`/`.create()`/`.change()`.
3. **Let errors flow through unhandled** at this layer — the interceptor
   (`apiProblemInterceptor`, chapter 06) already turns every failure into
   `ApiProblemError`; `core/<domain>-api.ts` methods never `catchError` themselves
   except where cancellation semantics need it (the picker's `catchError(() => of(null))`
   inside its own component, not in `OrgApi`).
4. **Test with `HttpTestingController`** (chapter 09), asserting the exact URL/params/
   body the contract specifies, following `org-api.spec.ts`.

## Recipe: add reference data (a catalogue from the API)

Following `core/org/kind-catalog.ts` (chapter 03 for the signals, chapter 06 for the
caching choice):

1. Add the list type and a `…Resource()` method whose request function reads no signal
   to the domain's `core/<domain>/<domain>-api.ts`.
2. Create a root service (`@Injectable({ providedIn: 'root' })`) that creates the
   resource in a field initializer and exposes `computed()` views of it (the list,
   lookups, rules) plus `error()` and `reload()`.
3. If the items have per-language labels, build the code → label map in a `computed()`
   that also reads `LanguageService.current()`, and expose `labelOf(code)`. Do **not**
   add i18n keys per code.
4. Show a load error somewhere with a retry calling `reload()`; make `labelOf` fall back
   to the code so screens still render while it loads.
5. Tests: add the fixture to `src/testing/`, flush the request in every spec whose
   components inject the service, and test the label switch with
   `LanguageService.use()`.

## Recipe: add a form with server errors

Follow `create-unit-form.ts`/`.html` end to end for a fresh form, or
`change-unit-form.ts`/`.html` if it needs a custom control (the org-unit picker) or only
sends the fields that actually changed.

1. **Build the form** with `inject(NonNullableFormBuilder).group({...})` (chapter 07)
   — one control per field, built-in `Validators` plus any custom `ValidatorFn`s the
   contract needs (put shared ones in a `<feature>-forms.ts` helper file like
   `org-forms.ts` if more than one form in the feature needs them).
2. **Template**: `[formGroup]="form"`, `(ngSubmit)="submit()"`, `novalidate`; for each
   field, `@let field = form.controls.x;`, `formControlName="x"`,
   `[attr.aria-invalid]`/`[attr.aria-describedby]` tied to `field.invalid &&
   field.touched`, and an error block showing `field.hasError('server') ?
   field.getError('server') : t(fieldErrorKey(field))`.
3. **On submit**: guard with `if (this.form.invalid) { this.form.markAllAsTouched();
   return; }`, then call the API method, and on error call your feature's
   `orgWriteError`-style helper (or write a one-off `applyServerErrors(this.form,
   error.problem)` call for a simple form like `login.page.ts`'s), setting a
   `formError` signal for anything not matched to a field.
4. **Test**: drive real `input`/`submit` DOM events, flush an `HttpTestingController`
   response with a `422`/`409` body, assert the right `#field-error` element shows the
   right text — see `login.page.spec.ts` or `organization.page.spec.ts`'s "maps a 409
   errors[] on code to the code field" test.

## Recipe: add a translation key

1. Add the key to **`public/i18n/fr.json`** (the source of truth) with real French text
   — nested under a sensible namespace matching the feature (`org.form.…`,
   `auth.login.…`).
2. Add the **same key path** to **`public/i18n/ar.json`** with the Arabic translation.
   `fr`/`ar` parity is enforced (guardrail + `translations.spec.ts`, chapter 08) — a
   missing `ar` key fails the build, not just a warning.
3. Optionally add it to **`public/i18n/en.json`** — `en` is allowed to lag, but adding
   it keeps English usable.
4. If the string takes a value, use `{{name}}`-style placeholders and keep the **same
   placeholder names** in every language file you touch (a mismatch is a guardrail
   error).
5. Use it in a template inside `*transloco="let t"` as `t('your.new.key')`, or with
   values as `t('your.new.key', { name: someValue })`.
6. Run `npm test -w @hrforce/web` (covers `translations.spec.ts`) before committing.

## Recipe: add a reusable form control

Follow `org-unit-picker.ts`/`.html`/`.css` (chapter 07 walks through it) as the
reference:

1. Put it in **`shared/<name>/`** (it must not know about any specific feature).
2. Implement `ControlValueAccessor`: `writeValue`, `registerOnChange`,
   `registerOnTouched`, `setDisabledState`.
3. Register it: `providers: [{ provide: NG_VALUE_ACCESSOR, useExisting:
   forwardRef(() => YourControl), multi: true }]` (chapter 04).
4. Store the callbacks from `registerOnChange`/`registerOnTouched` and call them
   **only** in response to genuine user action; call `writeValue`'s effects only to
   *display* what the form told you, never call `onChange` from inside `writeValue`.
5. Expose an `[invalid]` (and, if useful, `[describedBy]`) signal `input()` so a
   surrounding form can forward its own validity state — the control cannot see its own
   bound `FormControl`.
6. If the control needs its own async data (a lookup, a search), keep it internal to
   the component (signals + RxJS as needed, chapter 03) — the form only ever sees the
   control's plain value type through the CVA contract.
7. Test it bound to a real `FormControl` inside a small test-only host component, per
   `org-unit-picker.spec.ts` (chapter 09) — a CVA in isolation, with no form around it,
   doesn't exercise the actual integration.

These recipes are what the next screens (starting with Employees) should follow; if a
new situation doesn't fit one of them cleanly, extend this chapter (and the concept
chapters it links to) rather than improvising a one-off pattern — per `CLAUDE.md`, this
guide grows with the code.
