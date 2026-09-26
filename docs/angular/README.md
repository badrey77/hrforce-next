# Angular, taught through HRForce Next

This guide explains Angular by walking through `apps/web`'s real code. It does not
repeat what the code comments already say (read those — they explain the first use of
each concept, right where it happens). This guide goes wider: it connects concepts
across files, compares Angular to React and to NestJS (`apps/api`), and gives you a
map to come back to.

It assumes you know TypeScript/JavaScript and general web development, but not
Angular. If you know React, the comparison table in
[01-mental-model.md](./01-mental-model.md) is the fastest way in.

## How to read this

Read in order the first time. After that, use it as reference — each chapter links to
the files it discusses, so you can jump straight to the source.

1. [01-mental-model.md](./01-mental-model.md) — what Angular is, and how one request
   becomes pixels on screen.
2. [02-components-and-templates.md](./02-components-and-templates.md) — components,
   template syntax, inputs/outputs.
3. [03-signals-and-state.md](./03-signals-and-state.md) — signals, computed, effects,
   resources, zoneless change detection.
4. [04-dependency-injection.md](./04-dependency-injection.md) — `inject()`, providers,
   the injector tree, tokens.
5. [05-routing.md](./05-routing.md) — routes, lazy loading, the router ↔ component
   input bridge.
6. [06-http-and-errors.md](./06-http-and-errors.md) — `HttpClient`, interceptors,
   `httpResource`, the dev proxy.
7. [07-forms.md](./07-forms.md) — typed reactive forms, validators, server-error
   mapping, `ControlValueAccessor`.
8. [08-i18n-and-rtl.md](./08-i18n-and-rtl.md) — Transloco, language switching, RTL,
   the guardrails that keep them correct.
9. [09-testing.md](./09-testing.md) — Vitest + `TestBed`, `HttpTestingController`,
   `RouterTestingHarness`, fake timers.
10. [10-project-structure-and-recipes.md](./10-project-structure-and-recipes.md) —
    folder boundaries and step-by-step recipes for adding a page, protecting a route,
    an API call, a form, a translation key, a reusable control.
11. [11-app-initializers-and-auth-flow.md](./11-app-initializers-and-auth-flow.md) —
    `provideAppInitializer`, and the sign-in flow end to end (session, guards, refresh,
    password pages).
12. [12-permission-aware-ui.md](./12-permission-aware-ui.md) — permissions in the
    session, attribute vs structural directives (`*appCan`, `TemplateRef`,
    `ViewContainerRef`, the `*` microsyntax), permission guards with route `data`, and
    why the server's `_actions` stay the authority.

13. [13-pipes-defer-and-lists.md](./13-pipes-defer-and-lists.md) — custom pure pipes
    and `DatePipe`, locale data (`registerLocaleData`, why not `LOCALE_ID`), cursor
    pagination with "load more", content projection, and `@defer` (triggers, prefetch,
    sub-blocks, separate chunks, testing it).
14. [14-big-forms-and-url-state.md](./14-big-forms-and-url-state.md) — the Employees
    screens: URL as state (query params → signal inputs → resource, `merge`,
    `replaceUrl` for keystrokes, back/forward), nested typed `FormGroup`s, validator
    factories, cross-section rules, optional sections as disabled groups,
    `control.events`, the list/detail pattern, tabs as a local signal.

15. [15-workflows-in-the-ui.md](./15-workflows-in-the-ui.md) — Leave and "My tasks": a live
    preview (a POST modelled as a read: debounced signal → `httpResource`), one root store
    behind a nav badge and a page, polling vs events (`NavigationEnd`, `visibilitychange`),
    optimistic updates with rollback, a stepper over a pure function (RTL), the second
    ControlValueAccessor.

Once you have skimmed the whole guide, use recipe 10 whenever you build a new screen
(contracts and documents, M2, are next).

## Concept → chapter → file index

| Concept | Chapter | Real file to look at |
|---|---|---|
| `bootstrapApplication`, `ApplicationConfig` | 01 | `src/main.ts`, `src/app/app.config.ts` |
| Standalone component, `@Component` | 02 | `src/app/app.ts` |
| Template syntax (`@if`, `@for`, `@switch`, `@let`, bindings) | 02 | `src/app/features/organization/organization.page.html` |
| `input()`, `input.required()`, `model()`, `output()` | 02 | `src/app/features/organization/org-tree.ts` |
| `OnPush` change detection | 02, 03 | any `@Component` (all use it) |
| `signal()`, `computed()` | 03 | `src/app/features/organization/organization.page.ts` |
| `linkedSignal()` | 03 | `src/app/features/organization/organization.page.ts` (`mode`) |
| `toSignal()` | 03 | `src/app/features/organization/change-unit-form.ts` |
| `httpResource()` | 03, 06 | `src/app/core/org/org-api.ts` |
| App-wide cache (`httpResource` in a root service) + language signal | 03, 06 | `src/app/core/org/kind-catalog.ts` |
| `HttpParams` with repeated values | 06 | `src/app/core/org/org-api.ts` (`search`) |
| RxJS `debounceTime`/`switchMap` | 03, 07 | `src/app/shared/org-unit-picker/org-unit-picker.ts` |
| Zoneless change detection | 01, 03 | `src/app/app.config.ts` (`provideBrowserGlobalErrorListeners`, no zone.js) |
| `inject()`, `providedIn: 'root'` | 04 | `src/app/core/org/org-api.ts` |
| Hierarchical injectors (component-tree DI) | 04 | `src/app/features/organization/org-tree.ts` |
| `InjectionToken`, multi-provider (`NG_VALUE_ACCESSOR`) | 04, 07 | `src/app/shared/org-unit-picker/org-unit-picker.ts` |
| Routes, `loadComponent`, `loadChildren` | 05 | `src/app/app.routes.ts`, `src/app/features/organization/organization.routes.ts` |
| `routerLinkActive` + `IsActiveMatchOptions` | 05 | `src/app/features/organization/org-nav.ts` |
| Template reference variable (`#ref`) | 02 | `src/app/features/organization/sites.page.html` |
| `withComponentInputBinding()` | 05 | `src/app/app.config.ts`, `src/app/features/organization/organization.page.ts` |
| `provideHttpClient`, interceptors | 06 | `src/app/app.config.ts`, `src/app/core/http/api-problem.interceptor.ts` |
| `ApiProblem`, RFC 9457 errors | 06 | `src/app/core/http/api-problem.ts` |
| Dev proxy (same-origin `/api`) | 06 | `apps/web/proxy.conf.json` |
| `provideAppInitializer`, startup order (csrf → me) | 11 | `src/app/core/auth/session-init.ts`, `src/app/app.config.ts` |
| Root signal store (`Session`) | 03 | `src/app/core/auth/session.ts` |
| Functional guards, `canMatch` vs `canActivate`, `UrlTree` | 05 | `src/app/core/auth/auth.guards.ts`, `src/app/app.routes.ts` |
| Open-redirect-safe `returnUrl` | 05 | `src/app/core/auth/return-url.ts` |
| Interceptor order, retry once, single flight (`share()`) | 06 | `src/app/core/auth/auth-refresh.interceptor.ts` |
| XSRF rules, re-stamping a retried request | 06 | `src/app/core/auth/auth-refresh.interceptor.ts`, `src/app/core/http/xsrf.ts` |
| `HttpContextToken` | 06 | `src/app/core/auth/auth-api.ts` (`SKIP_LOGIN_REDIRECT`) |
| Cross-field (FormGroup) validator | 07 | `src/app/features/auth/password-rules.ts`, `password-setup.page.ts` |
| Device language vs account locale | 08 | `src/app/core/i18n/language.service.ts` |
| Typed reactive forms, `NonNullableFormBuilder` | 07 | `src/app/features/organization/create-unit-form.ts` |
| `applyServerErrors()` | 06, 07 | `src/app/core/http/apply-server-errors.ts` |
| Dependent select options, `[ngValue]` / `null` "inherit" | 07 | `src/app/features/organization/create-unit-form.ts` |
| Validators added from inputs (`addValidators`) | 07 | `src/app/features/organization/change-unit-form.ts` |
| Data labels (API) vs i18n keys | 03, 08 | `src/app/core/org/kind-catalog.ts` |
| `ControlValueAccessor` | 07 | `src/app/shared/org-unit-picker/org-unit-picker.ts` |
| Transloco, `LanguageService`, RTL | 08 | `src/app/core/i18n/language.service.ts` |
| `TestBed`, `TestBed.tick()` | 09 | `src/app/core/org/org-api.spec.ts` |
| `HttpTestingController` | 09 | `src/app/core/http/api-problem.interceptor.spec.ts` |
| `RouterTestingHarness` | 09 | `src/app/features/organization/organization.page.spec.ts` |
| Feature/core/shared boundaries | 10 | `.dependency-cruiser.cjs`, `CONVENTIONS.md` |
| `can()` (function reading a signal) vs `allows()` (per-code `computed`) | 03, 12 | `src/app/core/auth/session.ts` |
| Structural directive, `TemplateRef`, `ViewContainerRef`, `*` microsyntax, `else` input | 02, 12 | `src/app/shared/can/can.directive.ts` |
| `effect()` pushing signals into the DOM / into a reactive form | 03, 12 | `src/app/shared/can/can.directive.ts`, `src/app/features/access/role-editor.page.ts` |
| Guard factory, route `data`, several `canMatch` guards, `false` → `**` | 05, 12 | `src/app/core/auth/permission.guard.ts`, `src/app/app.routes.ts` |
| `redirectTo`, route params as inputs, static before `:id` | 05 | `src/app/features/access/access.routes.ts` |
| Native `<dialog>` + `viewChild.required()` signal query | 02 | `src/app/features/access/user-detail.page.ts` |
| `FormControl<string[]>` + CVA vs `FormArray`; nested `FormGroup`; checkbox control | 07 | `src/app/features/access/permission-checklist.ts`, `role-editor.page.ts`, `grant-form.ts` |
| Validator reading a signal; 409 slug table → fields (`problemToForm`) | 07 | `src/app/features/access/access-forms.ts`, `src/app/core/http/problem-form.ts` |
| Resources that wait for a permission / a company id | 12 | `src/app/core/access/access-catalog.ts` |
| Custom pure pipe (`@Pipe`, `pure`, arguments) | 13 | `src/app/shared/timeline/day-heading.pipe.ts` |
| `DatePipe` with an explicit locale; `registerLocaleData`; `LOCALE_ID` vs the UI language | 13 | `src/app/shared/timeline/timeline.html`, `src/app/core/i18n/date-locale.ts` |
| Cursor pagination: resource keyed on a cursor + accumulating `linkedSignal` | 13 | `src/app/shared/timeline/timeline.ts`, `src/app/core/audit/audit-api.ts` |
| `@defer` (triggers, `prefetch`, `@placeholder`/`@loading`/`@error`, lazy chunk) | 13 | `src/app/shared/timeline/history-tabs.ts` |
| Content projection (`<ng-content />`), `[hidden]` vs `@if` | 13 | `src/app/shared/timeline/history-tabs.ts` |
| Inputs vs DI for a callback the host supplies (`resolver`) | 13 | `src/app/shared/timeline/timeline.ts`, `src/app/features/organization/organization.page.ts` |
| URL as state: query params → signal inputs → `computed` query → resource; `merge`, `replaceUrl` | 14, 05 | `src/app/features/employees/employees.page.ts`, `employee-list-state.ts` |
| Sortable headers (`aria-sort`), server paging | 14 | `src/app/features/employees/employees.page.html` |
| Standalone `FormControl` for a CVA outside a form; `setValue(…, { emitEvent: false })` | 14 | `src/app/features/employees/employees.page.ts` |
| Nested typed `FormGroup`s, `formGroupName`, flattening to the API body | 14, 07 | `src/app/features/employees/employee-create.page.ts` / `.html` |
| Validator factory (`digits(min, max)`), error parameters in messages | 14, 07 | `src/app/features/employees/employee-forms.ts` |
| Root-group (cross-section) validator | 14 | `src/app/features/employees/employee-forms.ts` (`birthBeforeHire`) |
| Optional sections as disabled groups toggled by an `effect()` | 14 | `src/app/features/employees/employee-create.page.ts` |
| `AbstractControl.events` + `toObservable`/`switchMap`/`toSignal` in a child | 14 | `src/app/features/employees/field-error.ts` |
| Tabs as a `linkedSignal` vs child routes; reload after writes | 14 | `src/app/features/employees/employee-detail.page.ts` |
| `DecimalPipe` with an explicit locale (money as a string) | 14, 13 | `src/app/features/employees/employee-detail.page.html` |
| Language-aware name pipe (`displayName`) | 14, 13 | `src/app/shared/display-name/display-name.pipe.ts` |
| Live preview: `toSignal(valueChanges.pipe(debounceTime…))` → POST `httpResource` | 15 | `src/app/shared/leave/leave-request-form.ts`, `src/app/core/leave/leave-api.ts` |
| Root store shared by a nav badge and a page; `aria-live` count | 15 | `src/app/core/tasks/tasks-badge.ts`, `src/app/app.html` |
| Refresh on `NavigationEnd` / `visibilitychange` (vs polling with `interval`) | 15 | `src/app/core/tasks/tasks-badge.ts` |
| Optimistic update + rollback (derived list = truth minus hidden ids) | 15 | `src/app/core/tasks/tasks-badge.ts`, `src/app/features/tasks/tasks.page.ts` |
| `computed()` as an equality gate before a resource | 15, 03 | `src/app/features/tasks/tasks.page.ts` (`selectedRequestId`) |
| `afterNextRender` to move focus after a DOM change | 15 | `src/app/features/tasks/tasks.page.ts` |
| Stepper: pure state function + presentational component, RTL via logical properties | 15 | `src/app/shared/workflow-stepper/workflow-stepper.ts` |
| Second ControlValueAccessor (employee picker) | 15, 07 | `src/app/shared/employee-picker/employee-picker.ts` |
| Resources gated on a permission / on another resource | 15, 12 | `src/app/core/leave/my-employment.ts`, `src/app/features/my-leave/my-leave.page.ts` |
| Per-child permission guards under one lazy route | 05, 15 | `src/app/features/leave/leave.routes.ts` |
| Inline edit with one FormGroup; number inputs → `number \| null` | 15, 07 | `src/app/features/leave/leave-types-settings.ts` |
| Day/month names from locale data (`DatePipe` 'EEEE'/'LLLL') | 13 | `src/app/features/leave/policy-settings.ts` |
| `DeferBlockBehavior.Manual`/`Playthrough`, faked `IntersectionObserver` | 09, 13 | `src/app/shared/timeline/history-tabs.spec.ts`, `src/testing/intersection-observer.ts` |

## Glossary

- **Component** — a class with a `@Component` decorator pairing TypeScript logic to a
  template (HTML). The basic building block of the UI, similar to a React component.
- **Standalone component** — a component that lists the directives/components/pipes it
  uses directly in `imports: […]`, with no `NgModule` in between. All HRForce Next
  components are standalone; Angular 22 has no other kind.
- **Template** — the HTML (inline `template:` or a separate `.html` file via
  `templateUrl`) that renders a component, with Angular's extra syntax (`@if`, `[prop]`,
  `(event)`, pipes…) mixed in.
- **Directive** — a class that attaches behavior or DOM changes to an element without
  its own template. `RouterLink` and `TranslocoDirective` are directives; a component is
  a directive with a template. *Attribute* directives change their element;
  *structural* directives (`*appCan`, `*transloco`) decide whether a template is stamped
  into the DOM at all. See chapter 12.
- **`TemplateRef` / `ViewContainerRef`** — a template blueprint (an `<ng-template>`, or
  the element under a `*` directive), and the anchor where views made from it are
  inserted (`createEmbeddedView`) or removed (`clear`). See chapter 12.
- **View query (`viewChild()`)** — a signal that returns an element, directive or
  component found in the component's own template (e.g. `#endDialog`). See chapter 02.
- **Pipe** — a template function that transforms a displayed value, `{{ value | pipe:
  arg }}`. A *pure* pipe (the default) re-runs only when its value or an argument
  changes. Used for dates (`DatePipe`, our `dayHeading`); Transloco's `t()` function
  replaces the translate pipe. See chapters 13 and 08.
- **`@defer`** — a template block whose content (and the code of the components used only
  inside it) is loaded and rendered later, on a trigger (`on viewport`, `on idle`,
  `when …`). See chapter 13.
- **Content projection** — `<ng-content />` in a component's template marks where the
  content written between its tags by the parent is inserted. See chapter 13.
- **Signal** — a reactive container for one value: `count()` reads it, `count.set(n)` /
  `count.update(fn)` writes it. Anything that reads a signal (a template, a `computed`,
  an `effect`) is automatically re-run when that signal changes. See chapter 03.
- **`computed()`** — a signal derived from other signals by a pure function; it
  recalculates only when an input signal it read actually changed, and caches otherwise.
- **`effect()`** — runs a function whenever the signals it reads change, for side
  effects outside of rendering (logging, syncing to `localStorage`…). Not for deriving
  state — use `computed()` for that. See chapter 03's "why not effects for state".
- **`linkedSignal()`** — a writable signal that resets to a computed value whenever a
  `source` signal changes, but can also be set directly in between. See chapter 03.
- **`resource()` / `httpResource()`** — wraps an async operation (typically an HTTP
  request) driven by signals: change a signal it reads, and it re-runs, cancelling any
  request still in flight. Exposes `value()`, `status()`, `isLoading()`, `error()`,
  `reload()`. See chapters 03 and 06.
- **Injector** — the runtime registry that resolves `inject(Something)` to an instance.
  Angular has a tree of injectors (root, then one per component that provides
  something); a request walks up the tree until a provider is found. See chapter 04.
- **Provider** — a recipe telling an injector how to produce a value for a token
  (`useClass`, `useValue`, `useExisting`, `useFactory`, or the `providedIn` shorthand on
  `@Injectable`). See chapter 04.
- **Standalone** — see "standalone component" above; also applies to directives, pipes
  and (as `bootstrapApplication`) the whole application.
- **Zoneless** — this app has no `zone.js`. Angular is not automatically told "something
  might have changed, please re-check the DOM" after every async callback; instead it
  re-renders a component when a signal that component's template reads changes value.
  See chapter 01.
- **Change detection** — the process of checking a component's bindings and updating the
  DOM to match. `ChangeDetectionStrategy.OnPush` (used on every component here) skips a
  component unless one of its inputs changed by reference or one of its signals changed.
- **CVA (`ControlValueAccessor`)** — the interface a component implements to act like a
  form control (`<input>`) inside Angular's Forms API, so `formControlName` works on it.
  See chapter 07 and `src/app/shared/org-unit-picker/org-unit-picker.ts`.
- **Interceptor** — a function that sits in front of every `HttpClient` request/response,
  functional style (`HttpInterceptorFn`), registered with `withInterceptors([...])`. See
  chapter 06.
- **Route** — a path → component/loader mapping in a `Routes` array. See chapter 05.
- **Guard** — a function (`CanMatchFn`, `CanActivateFn`, …) the router calls to decide
  whether a route may be used; returns `true` or a `UrlTree` to redirect. See chapter 05.
- **`UrlTree`** — a parsed URL object. Returned from a guard, it redirects the current
  navigation instead of starting a new one.
- **App initializer** — a function registered with `provideAppInitializer()` that runs
  during bootstrap; the app waits for its Promise/Observable. See chapter 11.
- **Lazy loading** — code for a route is fetched only when the user navigates there
  (`loadComponent`/`loadChildren`), splitting the JS bundle. See chapter 05.
- **`TestBed`** — Angular's test harness: configures a mini application (providers,
  imports) for a test and creates component instances (`fixtures`) inside it. See
  chapter 09.

Concepts not yet in this codebase (`NgModule`, zone-based apps, the `@ViewChild`
decorator (the signal `viewChild()` is used instead), multi-slot projection with
`<ng-content select="…">`) are intentionally left out — this guide only
teaches what the code actually uses, and grows as the code does (see `CLAUDE.md`).
