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
    employees/   EmployeesApi + Employment contract types (money as a decimal string)
    leave/       LeaveApi (preview = POST httpResource) + Leave contract types + LeaveCatalog + MyEmployment
    tasks/       TasksApi + TasksBadge (root store: nav count and /tasks list, optimistic hide/show)
    http/        ApiProblem + apiProblemInterceptor + applyServerErrors() + problemToForm() + retryAfterSeconds() + XSRF names
    i18n/        languages, LanguageService, TranslocoHttpLoader
    org/         OrgApi + Organization contract types + KindCatalog (kind catalogue, once per app)
  shared/        reusable UI used by more than one feature
    can/         *appCan structural directive (show a template only with a permission)
    org-unit-picker/
    employee-picker/  the second ControlValueAccessor (value = employment id)
    workflow-stepper/ approval steps, RTL-safe
    leave/       balance cards, request form with live preview, read-only request view, leave rules
    display-name/ displayName pipe (Arabic name in the Arabic UI, else Latin) — people and units
    timeline/    audit timeline + <app-history-tabs>
    not-found/   the 404 page + NOT_FOUND_ROUTE (app-level `**`, and the end of guarded feature tables)
    reveal-alert/ [appRevealAlert]: scroll + focus a form's error banner when a new message appears
    file-size/   fileSize pipe (Intl units and plurals)
  features/<name>/  one page/flow per feature: access, auth, employees, home, leave, my-leave, organization, tasks,
                 placeholder
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

Using the Employees screens as the example (`features/employees/`, mounted with
`loadChildren` in `app.routes.ts`; they started as a `PlaceholderPage` entry).

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

A feature whose pages need **different** permissions: put the list of codes on the parent
(`data: { permission: ['x.read', 'x.configure'] }` = any of them), a
`canMatch: [permissionGuard('…')]` on each child, `{ ...NOT_FOUND_ROUTE, path: 'new' }`
right after each guarded static path that sits before a `:id`, and `NOT_FOUND_ROUTE` last
in the child table (chapter 05, "The not-found route", for why). Then add the URLs to
`app.routes.spec.ts` with a user who lacks the permission.

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
   `user`; `docs/contracts/audit.md` › Endpoint; `employee` from
   `docs/contracts/employment.md` › Audit) plus the record's id. A new subject type needs
   the API first, then `AuditSubjectType` in `core/audit/audit.models.ts`. A page that
   already has its own tab bar (the employee detail) puts `<app-timeline>` in a `@defer`
   block in its own History tab instead of using `<app-history-tabs>`.
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
   grants). Keep it a field, not an inline arrow. Do not fetch just for names: an unknown
   id shows as stored. Exception: an id that means nothing to a reader (a signatory or file
   category UUID, `OPAQUE_REFS` in `timeline-view.ts`) shows "name not available" when
   unnamed; the employee page names them with small reference reads that exist only while
   its History tab is shown (chapter 13, "Passing data down").
5. **New tables or events?** Add `audit.fields.<table>.<column>`, `audit.tables.<table>`
   and `audit.events.<type>` keys to `fr.json` and `ar.json` (same placeholders; the
   i18n guardrail checks both). Unknown columns fall back to the column name, unknown
   events to `audit.events.unknown`. Columns that are pure noise (tenant id, generated
   columns) go in `HIDDEN_FIELDS` in `shared/timeline/timeline-view.ts`; id-like columns
   go in `REFERENCE_FIELDS` so the resolver is asked.
6. **Test** the tab like `user-detail.page.spec.ts`: hidden with
   `meWith(...without 'audit.read')`; with it, click `[data-tab="history"]`,
   `installIntersectionObserver()`, then
   `await untilDeferredRequest(http, r => r.url === '/api/audit/timeline', settle)` to play
   the `@defer` block through (it polls: a fixed number of ticks is flaky under a full run),
   and check the `subject` param and a resolved name.

## Recipe: add a list page with filters in the URL

`features/employees/employees.page.ts` is the worked example; chapter 14 §1 explains it.

1. **List the state** the list needs (filters, sort, direction, page, page size) and give
   each a URL name. Write two pure functions in `<feature>-list-state.ts`: `resolveQuery(params)`
   (raw strings → a typed query with defaults; never throws on garbage) and
   `toQueryParams(change)` (`null` for defaults, so they leave the URL). Unit-test both.
2. **One signal `input()` per query param**, same name (`withComponentInputBinding()`),
   and one `query = computed(() => resolveQuery({...}))`. Do not keep a second copy of any
   filter in a signal.
3. **An `httpResource` keyed on `query`** in `core/<domain>/<domain>-api.ts`, with its
   params built by an exported pure function (`employeeListParams`) that always sends sort
   and paging and leaves empty filters out.
4. **Widgets display the URL and navigate.** `[value]="query().q"`, `<option
   [selected]>`; on change call one `update(change)` that does
   `router.navigate([], { relativeTo, queryParams: toQueryParams({ page: 1, ...change }),
   queryParamsHandling: 'merge' })`. Reset the page on every filter/sort change.
5. **Keystrokes**: a `Subject` + `debounceTime` + `filter(q => q !== query().q)`, then
   `update({ q }, { replaceUrl: true })` so typing does not flood the history.
6. **Custom controls** (the org-unit picker): a standalone `FormControl`; URL → control in
   an `effect()` with `{ emitEvent: false }`, control → URL through `valueChanges`.
7. **Sortable headers**: a `<button>` in the `<th>`, `aria-sort` on the sorted column
   only. **Paging**: previous/next disabled at the ends, "page X of Y", a page-size select.
8. **States**: error with retry; the table kept during a reload (`aria-busy`); loading;
   "no match" (a filter is set, offer "clear filters") vs "empty".
9. **Filters that need another permission** (sites need `site.read`): keep a
   `session.allows(...)` field, hide the filter, and keep its resource idle
   (`OrgApi.sitesResource(q, enabled)`).
10. **Tests** with `RouterTestingHarness` (see `employees.page.spec.ts`): URL → request
    params and widgets; clicks → `router.url` query params; `replaceUrl` via
    `vi.spyOn(router, 'navigate')`; navigating to a new URL (what Back does) updates the
    widgets.

## Recipe: add a sensitive section

A block of data some users may not read or write (salary, bank, NSS; later medical). The
API omits a block the caller may not read and lists it in `_redacted`, and answers 403
`forbidden-field` for a write without the `.update` permission
(`docs/contracts/employment.md` › Scope).

1. **Types**: make the block optional in the detail type (`salary?: …`) and read it through
   a helper that also treats a missing block as redacted (`isRedacted()` in
   `core/employees/employees.models.ts`). Never show a placeholder value for a redacted block;
   hide the tab or section.
2. **Reading** (detail page): compute the visible tabs from `_redacted`
   (`employee-detail.page.ts`, `tabs`), and fall back to a visible tab if a reload
   redacts the current one.
3. **Writing on a record**: the button comes from `_actions` (`update_salary`…), never from
   `Session.can()`: the permission must cover this employee's unit.
4. **Writing on a create form**: the section exists in the form for everyone, and an
   `effect()` disables it unless `session.allows('<block>.update')`; the template shows it
   `@if` allowed. Disabled groups do not count for validity; check `.enabled` before
   putting the block in the body (`getRawValue()` includes disabled controls).
5. **Validation**: reuse the validator factories (`digits(20)`, `money`) so create and
   edit agree; normalise (strip spaces, 2-decimal money string) in the same helper the
   validator uses.
6. **403 `forbidden-field`**: map `errors[].field` (a block name or a field) onto the
   control through the form's path table (`CREATE_FIELD_PATHS`), with a translated message.
7. **Audit**: the API masks the values; add `audit.tables.<table>` and
   `audit.fields.<table>.<column>` keys and hide pure link columns in `HIDDEN_FIELDS`
   (`shared/timeline/timeline-view.ts`).
8. **Styling**: `class="section sensitive"` marks the fieldset; keep sensitive values out
   of `title` attributes, logs and error texts.
9. **Tests**: `meWith([...])` with and without the `.update` permission (sections shown or
   not), a detail with `_redacted: ['salary']` (tab hidden), and a 403 `forbidden-field`
   response landing on the field.

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
   `formError` signal for anything not matched to a field. Show it at the top of the form
   with `role="alert" [appRevealAlert]="error"` (import `RevealAlert`), so it is scrolled
   into view and focused on a phone (chapter 07).
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
reference — `shared/employee-picker/` is a second example built from it (chapter 15 §6):

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

## Recipe: add an approval step UI

For a new kind of request that goes through the workflow engine (docs/contracts/leave.md ›
Workflow engine) — say a training request. Chapter 15 explains the patterns.

1. **Types and API in `core/<subject>/`**: list items carry `workflow: WorkflowProgress`
   (reuse the type from `core/leave/leave.models.ts`), the detail adds `history`.
2. **Show progress** with `<app-workflow-stepper [progress]="item.workflow" [history]="detail.history" />`
   (shared/workflow-stepper). Step labels come from the definition; nothing to translate.
3. **"My tasks" needs nothing new** if the subject registers a summary in the API: the
   tasks page lists every open task. Add a branch on `task.subject.type` in
   `features/tasks/tasks.page.html` for the new subject's line and detail view.
4. **Decisions**: call `TasksApi.approve/reject` through the page's `decide()` so the
   optimistic hide / rollback and the badge stay consistent. Map new 409 slugs in
   `decisionErrorKey()`.
5. **Requester side**: a list with the stepper and a Cancel from `_actions` (or the
   contract's rule, see `canCancel()` in shared/leave/leave-forms.ts), reloading the list
   after the write.
6. **Test** the optimistic flow: assert between click and flush, then a 409 rollback
   (`features/tasks/tasks.page.spec.ts`).

## Recipe: add a live preview

When a form should show a server-computed consequence before submit (days of leave, a
salary simulation…):

1. In the `*Api`, expose the endpoint as a **resource** even if it is a POST, as long as it
   writes nothing: `httpResource(() => body() ? { url, method: 'POST', body: body() } : undefined)`
   (`LeaveApi.previewResource`).
2. In the form, build the body signal with
   `toSignal(form.valueChanges.pipe(startWith(null), debounceTime(…), map(toBodyOrUndefined), distinctUntilChanged(sameJson)), { initialValue: undefined })`.
   Return `undefined` while the form cannot be counted (missing or inconsistent fields).
3. Render `preview.isLoading()` / `error()` / `value()` in a `role="status"` region; map
   problem slugs to the same messages as the submit's.
4. Keep the real submit an explicit `subscribe()` in the click handler.
5. Test with fake timers: `await vi.advanceTimersByTimeAsync(debounce)`, `TestBed.tick()`,
   assert one request, change the input, assert `firstRequest.cancelled`.

## Recipe: react to a server event

When a screen should update the moment something happens elsewhere (a new task, a request
decided by someone else) — chapter 16 explains the mechanics.

1. **Is it already on the stream?** The API pushes `notification` events (`{id, type, …}`) over
   `GET /api/me/notifications/stream`; `NotificationCenter` (core/notifications) owns that
   connection. Do **not** open a second EventSource. A new kind of event is an API change:
   add the type to the contract, to `NOTIFICATION_TYPES` and to the `notifications.types.*` /
   `notifications.typeLabels.*` keys in fr/ar/en (the settings page lists it automatically).
2. **Listen on the bus, not the center**: inject `NotificationEvents` (it opens nothing) and
   filter by type:
   ```ts
   inject(NotificationEvents).of((type) => type.startsWith('leave.'))
     .pipe(takeUntilDestroyed())
     .subscribe(() => this.requests.reload());
   ```
   In a page this lives exactly as long as the page; in a root store, for the whole app.
3. **Reload, don't patch.** React by calling `reload()` on the resources that show the
   affected data; the event says *that* something changed, the API says *what* it is now.
4. **Keep the non-live path working.** The stream can be down (`center.status() ===
   'fallback'`); keep a refresh on navigation / `visibilitychange` where the data matters
   (TasksBadge does both).
5. **State from the stream is a signal in the center** (like `unreadCount`); only add one
   there if several screens need the same live value.
6. **Links**: if the event should open a page on a specific record, make the page accept a
   query param as an input (`?task=`, `?request=` + `withComponentInputBinding()`), a
   `linkedSignal` for the selection, and `afterRenderEffect()` for scroll/focus.
7. **Test** by emitting on the bus (`TestBed.inject(NotificationEvents).emit({ id, type })`)
   and asserting the reload request (`features/my-leave/my-leave.page.spec.ts`); for the
   connection itself use `EVENT_SOURCE_FACTORY` + `src/testing/fake-event-source.ts`.

These recipes are what the next screens (contracts, documents — M2) should follow; if a
new situation doesn't fit one of them cleanly, extend this chapter (and the concept
chapters it links to) rather than improvising a one-off pattern — per `CLAUDE.md`, this
guide grows with the code.

## Recipe: add a multi-step flow (wizard)

Example: `features/security/mfa-enroll-wizard.ts` (full story in [chapter 17](./17-multi-step-ui-wizards-and-two-step-sign-in.md)).

1. **Decide: routes or state.** Steps a user may bookmark or come back to → routes. Phases of one task that make no
   sense alone (a code step, a confirmation) → one component and a signal.
2. **Write the state as a discriminated union**, one member per step carrying that step's data, and keep it in ONE
   `signal<State>()`. Add small `computed()`s for each step's payload.
3. **Write transitions as methods** that call one private `go(next)`; nothing else writes the signal. API calls happen
   in the transition and move on only on success.
4. **Template: `@switch (state().step)`** with one `@case` per step; a progress `<ol>` with `aria-current="step"`.
5. **Focus**: in `go()`, `afterNextRender(() => heading.focus(), { injector })`; give each step heading `#stepHeading`
   and `tabindex="-1"`, or focus the step's first field.
6. **Shared state with a child** (a "I have saved them" checkbox) → `model()` + `[(x)]="signal"`; re-check it in the
   final transition.
7. **Codes and secrets**: `dir="ltr"`, monospace, `translate="no"`; one-time codes use `inputmode="numeric"` and
   `autocomplete="one-time-code"`.
8. **Tests**: click through every step with `HttpTestingController`, assert the state tag (`data-state`), focus, and
   that no request is sent from an invalid step.
