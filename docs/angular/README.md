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
    folder boundaries and step-by-step recipes for adding a page, an API call, a form,
    a translation key, a reusable control.

Once you have skimmed the whole guide, use recipe 10 whenever you build a new screen
(the Employees module is next).

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
| RxJS `debounceTime`/`switchMap` | 03, 07 | `src/app/shared/org-unit-picker/org-unit-picker.ts` |
| Zoneless change detection | 01, 03 | `src/app/app.config.ts` (`provideBrowserGlobalErrorListeners`, no zone.js) |
| `inject()`, `providedIn: 'root'` | 04 | `src/app/core/org/org-api.ts` |
| Hierarchical injectors (component-tree DI) | 04 | `src/app/features/organization/org-tree.ts` |
| `InjectionToken`, multi-provider (`NG_VALUE_ACCESSOR`) | 04, 07 | `src/app/shared/org-unit-picker/org-unit-picker.ts` |
| Routes, `loadComponent`, `loadChildren` | 05 | `src/app/app.routes.ts`, `src/app/features/organization/organization.routes.ts` |
| `withComponentInputBinding()` | 05 | `src/app/app.config.ts`, `src/app/features/organization/organization.page.ts` |
| `provideHttpClient`, interceptors | 06 | `src/app/app.config.ts`, `src/app/core/http/api-problem.interceptor.ts` |
| `ApiProblem`, RFC 9457 errors | 06 | `src/app/core/http/api-problem.ts` |
| Dev proxy, dev identity headers | 06 | `apps/web/proxy.conf.json` |
| Typed reactive forms, `NonNullableFormBuilder` | 07 | `src/app/features/organization/create-unit-form.ts` |
| `applyServerErrors()` | 06, 07 | `src/app/core/http/apply-server-errors.ts` |
| `ControlValueAccessor` | 07 | `src/app/shared/org-unit-picker/org-unit-picker.ts` |
| Transloco, `LanguageService`, RTL | 08 | `src/app/core/i18n/language.service.ts` |
| `TestBed`, `TestBed.tick()` | 09 | `src/app/core/org/org-api.spec.ts` |
| `HttpTestingController` | 09 | `src/app/core/http/api-problem.interceptor.spec.ts` |
| `RouterTestingHarness` | 09 | `src/app/features/organization/organization.page.spec.ts` |
| Feature/core/shared boundaries | 10 | `.dependency-cruiser.cjs`, `CONVENTIONS.md` |

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
  a directive with a template.
- **Pipe** — a template function that transforms a displayed value, `{{ value | pipe }}`.
  Not used much in this codebase (Transloco's `t()` function largely replaces the
  translate pipe); see chapter 08.
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
- **Lazy loading** — code for a route is fetched only when the user navigates there
  (`loadComponent`/`loadChildren`), splitting the JS bundle. See chapter 05.
- **`TestBed`** — Angular's test harness: configures a mini application (providers,
  imports) for a test and creates component instances (`fixtures`) inside it. See
  chapter 09.

Concepts not yet in this codebase (guards, `NgModule`, zone-based apps, `@ViewChild`,
content projection with `<ng-content>`) are intentionally left out — this guide only
teaches what the code actually uses, and grows as the code does (see `CLAUDE.md`).
