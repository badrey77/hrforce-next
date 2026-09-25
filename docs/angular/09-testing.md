# 9. Testing

See also: every chapter's "real file" references have a matching `.spec.ts` — this
chapter explains the testing machinery those specs use.

## Vitest + jsdom via the Angular builder

```json
// apps/web/angular.json
"test": {
  "builder": "@angular/build:unit-test",
  "options": { "runner": "vitest", "tsConfig": "tsconfig.spec.json" }
}
```

Tests run through Angular's own `@angular/build:unit-test` builder, configured to use
**Vitest** as the runner (not Jasmine/Karma — Angular's older default) against a
**jsdom** environment (a simulated DOM in Node, no real browser). `npm test -w
@hrforce/web` (from the repo root) runs `ng test --watch=false`, which invokes this
builder — it compiles the app (respecting `tsconfig.spec.json`, which includes
`*.spec.ts` and excludes them from the app's own `tsconfig.app.json` build) and runs
every `*.spec.ts` file once, headlessly.

## `TestBed`: building a mini application per test

```ts
// src/app/features/auth/login.page.spec.ts
beforeEach(async () => {
  await TestBed.configureTestingModule({
    imports: [LoginPage, translocoTesting()],
    providers: [
      provideRouter([]),
      provideHttpClient(withInterceptors([apiProblemInterceptor])),
      provideHttpClientTesting(),
    ],
  }).compileComponents();
  fixture = TestBed.createComponent(LoginPage);
  ...
});
```

`TestBed.configureTestingModule({...})` builds an isolated injector (chapter 04) for
the test, with exactly the providers/imports it declares — nothing from the real
`app.config.ts` leaks in automatically. This is deliberate: a component test only gets
the router, HTTP client, and translations it explicitly asks for, so what a test
depends on is visible in the test itself. Standalone components (chapter 02) are listed
directly in `imports` — `LoginPage` here — the same way they'd be imported into another
component's `imports` array.

`translocoTesting()` (`src/testing/transloco-testing.ts`) wraps
`TranslocoTestingModule.forRoot({ langs: { fr, ar, en }, ... })`, loading the **real**
translation JSON files synchronously (`preloadLangs: true`) instead of the HTTP loader
— so component specs render real French/Arabic text (and assertions like
`expect(el.querySelector('.brand')?.textContent).toContain('HRForce')` in
`app.spec.ts` check against it) without a fake `HttpClient` round trip just to get
labels.

`TestBed.createComponent(LoginPage)` then creates one instance inside that injector and
returns a `ComponentFixture` — `fixture.nativeElement` is the real (jsdom) DOM node,
`fixture.componentInstance` is the component instance itself.

## `TestBed.tick()`

Zoneless Angular (chapter 01, chapter 03) has no automatic "something changed, please
check" trigger from zone.js — in tests this means signal changes don't render
synchronously either, unless something asks the framework to check. `TestBed.tick()`
performs one synchronous change-detection pass across the whole test application, used
wherever a test needs to force a render after changing a signal or flushing an async
task, without waiting for a promise:

```ts
// src/app/core/org/org-api.spec.ts
const asOf = signal<string | undefined>(undefined);
const tree = TestBed.runInInjectionContext(() => api.treeResource(asOf));

TestBed.tick();
http.expectNone((r) => r.url === '/api/org/tree');
expect(tree.status()).toBe('idle');

asOf.set('2025-06-30');
TestBed.tick();
const req = http.expectOne((r) => r.url === '/api/org/tree');
```

`TestBed.runInInjectionContext(fn)` is needed here because `api.treeResource(asOf)`
internally calls `httpResource()`, which itself calls `inject()` — chapter 04's
"injection context" rule applies inside test code too, so a bare call outside a
component or this helper would throw.

`organization.page.spec.ts` wraps this in its own `settle()` helper:

```ts
async function settle(): Promise<void> {
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
}
```

with a comment explaining why it's not just `fixture.whenStable()`: `whenStable()` also
waits for in-flight `httpResource` requests to settle, but they only resolve once the
test itself flushes them through `HttpTestingController` — so a test needs a `tick()`
to trigger the resource's request, a real macrotask turn (`setTimeout`) to let the
resource's internal async machinery progress, and a second `tick()` to render the
result, all *before* the test can call `http.expectOne(...)` and `.flush(...)`.

## `HttpTestingController`

```ts
// src/app/core/http/api-problem.interceptor.spec.ts
providers: [provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting()],
...
const req = http.expectOne((r) => r.url === '/api/org/tree');
expect(req.request.urlWithParams).toBe('/api/org/tree?asOf=2025-06-30');
req.flush({ ... });
```

`provideHttpClientTesting()` replaces the real HTTP backend with a fake one; every
request made through the real `HttpClient` (interceptors still run — note
`apiProblemInterceptor` is registered here too, so tests exercise the same error
mapping production code gets) is captured instead of sent over the network.
`HttpTestingController` (`TestBed.inject(HttpTestingController)`) lets a test assert on
and respond to those captured requests:

- **`expectOne(matcher)`** — asserts exactly one matching request exists and returns
  its `TestRequest`, so the test can inspect `.request.method`, `.request.body`,
  `.request.urlWithParams`, `.request.params`.
- **`.flush(body, options?)`** — completes the request as if the server responded,
  with the given body/status/headers, letting the code under test's `.subscribe()` or
  `httpResource` continue.
- **`.error(...)`** — simulates a network-level failure (used for the `status === 0`
  case in `api-problem.interceptor.spec.ts`).
- **`.cancelled`** — a boolean on `TestRequest` set when the request was aborted (e.g.
  by an RxJS `switchMap` unsubscribing, or an `httpResource` superseding it).
  `org-unit-picker.spec.ts`'s "cancels a stale search" test checks
  `expect(stale.cancelled).toBe(true)` directly — see chapter 06's cancellation section.
- **`afterEach(() => http.verify())`** — asserts no requests were made that the test
  never checked/flushed; every spec file using `HttpTestingController` in this codebase
  calls `verify()` in `afterEach`, catching an accidentally-unhandled request.

### Reference data a component pulls in

Components that inject `KindCatalog` (the tree, the picker, the forms) make the root
service send its one `GET /api/org/kinds` as soon as effects run. Because every test
calls `http.verify()`, each spec must answer it. `src/testing/org-fixtures.ts` holds the
contract's seed catalogue (`ORG_KINDS`), some sites, and `flushKinds(http)`:

```ts
// src/app/shared/org-unit-picker/org-unit-picker.spec.ts
fixture.detectChanges();
// The picker injects KindCatalog (option badges): answer its one catalogue request.
TestBed.tick();
flushKinds(http);
```

Each test gets a fresh `TestBed`, hence a fresh root injector and a fresh catalogue —
"once per app" means once per test. `kind-catalog.spec.ts` asserts that a second
`inject(KindCatalog)` sends nothing (`http.expectNone('/api/org/kinds')`).

To test language-dependent data labels, switch through the real service —
`TestBed.inject(LanguageService).use('ar')` — then `TestBed.tick()` and read the DOM
(see "switches kind labels with the language" in `organization.page.spec.ts`).

### Driving a `<select>`

Options bound with `[ngValue]` have generated DOM values (`"0: null"`), so tests pick an
option by its text: set `select.selectedIndex` and dispatch a `change` event, which is
what the select accessor listens to (`choose()` in `organization.page.spec.ts`).

## `RouterTestingHarness`

For a routed page — one that reads route/query params and relies on navigation —
`organization.page.spec.ts` uses the router-specific harness instead of
`TestBed.createComponent` directly:

```ts
providers: [
  provideRouter([{ path: 'organization', children: ORGANIZATION_ROUTES }], withComponentInputBinding()),
  ...
],
...
harness = await RouterTestingHarness.create();
...
await harness.navigateByUrl('/organization?asOf=2025-03-31');
```

`RouterTestingHarness.create()` sets up a real root component with a `<router-outlet>`
and a real `Router` (configured with the routes passed to `provideRouter`, including
`withComponentInputBinding()` — so this exercises the exact router-to-input wiring
chapter 05 describes, not a mock of it). `harness.navigateByUrl(url)` performs an
actual navigation, activating whatever component the routes resolve to;
`harness.routeNativeElement` is that activated route's rendered DOM, used throughout the
spec's `el()` helper. This is preferred over hand-constructing the page component
directly whenever the behavior under test depends on the router (query-param-as-input
binding, `router.navigate(...)` calls, or — as here — testing through nested lazy
routes without actually triggering a dynamic `import()`).

## Fake timers for debounce

```ts
// src/app/shared/org-unit-picker/org-unit-picker.spec.ts
beforeEach(async () => {
  vi.useFakeTimers();
  ...
});
afterEach(() => {
  http.verify();
  vi.useRealTimers();
});

it('debounces typing into one request ...', () => {
  type('c');
  type('ce');
  vi.advanceTimersByTime(ORG_UNIT_PICKER_DEBOUNCE_MS - 1);
  http.expectNone(isSearch);

  vi.advanceTimersByTime(1);
  const req = http.expectOne(isSearch);
  ...
});
```

Since the picker's search pipeline uses RxJS `debounceTime(250)` (chapter 03, chapter
6), a real test would need to actually wait 250ms — slow, and flaky under load. Vitest's
fake timers (`vi.useFakeTimers()`) replace the underlying timer functions `debounceTime`
relies on; `vi.advanceTimersByTime(ms)` moves fake time forward synchronously, letting
the test assert "not yet debounced" at 249ms and "now it fired" at 250ms precisely,
deterministically, with no real delay. `ORG_UNIT_PICKER_DEBOUNCE_MS` is exported from
`org-unit-picker.ts` specifically so the test doesn't hardcode the magic number
separately from the implementation.

## Testing the Identity pieces

A few patterns the auth specs introduced:

- **Concurrency with `HttpTestingController`.** Requests stay pending until you
  `flush()` them, so "three requests fail at the same time" is just three `http.get()`
  calls followed by three 401 flushes. `expectOne('/api/auth/refresh')` then asserts
  the single flight: it fails if there were zero or several refresh requests
  (`auth-refresh.interceptor.spec.ts`).
- **Order of requests.** `const csrf = http.expectOne('/api/auth/csrf');
  http.expectNone('/api/me'); csrf.flush(...)` proves that `/api/me` waits for csrf
  (`session-init.spec.ts`). `expectOne` *takes* the request out of the pending list,
  so keep the returned `TestRequest` if you need to flush it later. A second
  `expectOne` for the same URL would find nothing.
- **Running a function that uses `inject()`** (an app initializer, a guard):
  `TestBed.runInInjectionContext(() => initializeSession())`.
- **`async` component handlers.** `submit()` in the login and password pages `await`s
  HTTP calls, and the code after an `await` runs in a later microtask.
  `fixture.whenStable()` alone can resolve before that. The specs use a `settle()`
  helper, `await new Promise((r) => setTimeout(r)); await fixture.whenStable();`, which
  lets the promise chain finish and then lets the view catch up.
- **Guards through the real router.** `RouterTestingHarness` with a stub component per
  route and a `vi.fn()` as `loadChildren`. The spy proves that `canMatch` stopped the
  navigation before the lazy chunk was requested (`auth.guards.spec.ts`).
- **Headers on a flushed error.** `flush(body, { status: 423, headers: { 'Retry-After': '540' } })`
  exercises the "try again in 9 min" path (`login.page.spec.ts`).
- **XSRF in jsdom.** `document.cookie = 'XSRF-TOKEN=before; path=/'` is enough for
  Angular's real XSRF interceptor to add the header in a test. Change the cookie
  between the 401 and the retry to prove the retry is re-stamped.
- **Router navigation as an outcome.** `vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true)`
  when the test only needs to know *where* the page wants to go, not to render it.

## Running a single test

From the repo root: `npm test -w @hrforce/web` runs everything. To run one file or
narrow to a name pattern, pass the underlying Vitest flags through the `ng test`
invocation, e.g. from `apps/web`:

```
npx ng test --watch=false -- src/app/shared/org-unit-picker/org-unit-picker.spec.ts
npx ng test --watch=false -- -t "debounces typing"
npx ng test --watch=false --include 'src/app/core/auth/*.spec.ts'
```

(Consult `ng test --help` / the installed `@angular/build:unit-test` version for the
exact current flag names if these don't match — the builder wraps Vitest, so its CLI
surface can shift between Angular releases.)

## What to test at which level

Looking at the existing specs, the pattern in this codebase is:

- **Pure functions** (`iso-date.spec.ts`, `apply-server-errors.spec.ts`,
  `parseApiProblem` cases in `api-problem.interceptor.spec.ts`) — plain unit tests, no
  `TestBed` at all.
- **A service with DI dependencies** (`org-api.spec.ts`, `language.service.spec.ts`) —
  `TestBed.configureTestingModule` with just the providers the service needs
  (`provideHttpClient`/`provideHttpClientTesting`, or `translocoTesting()`), then
  `TestBed.inject(TheService)`.
- **A presentational or form component** (`login.page.spec.ts`,
  `org-unit-picker.spec.ts` — the latter through a small `Host` test component that
  wraps the picker in a real `FormControl`, since a CVA is only meaningfully testable
  bound to an actual form) — `TestBed.createComponent`, drive it via real DOM events
  (`dispatchEvent(new Event('input'))`), assert on rendered DOM and/or the bound
  `FormControl`'s value.
- **A routed page composing several components and services**
  (`organization.page.spec.ts`) — `RouterTestingHarness`, asserting end-to-end behavior
  through real navigation and real (test-controlled) HTTP.

## Next

[10-project-structure-and-recipes.md](./10-project-structure-and-recipes.md) — the
folder boundaries these tests and files all respect, and step-by-step recipes for
adding new screens.
