# 6. HTTP and errors

See also: [03-signals-and-state.md](./03-signals-and-state.md) for `httpResource()`
mechanics, [07-forms.md](./07-forms.md) for turning a failed write into form errors,
[09-testing.md](./09-testing.md) for `HttpTestingController`.

## Configuring `HttpClient`

```ts
// src/app/app.config.ts
provideHttpClient(
  withFetch(),
  withXsrfConfiguration({ cookieName: XSRF_COOKIE_NAME, headerName: XSRF_HEADER_NAME }),
  // Order = nesting: the FIRST is the outermost. apiProblemInterceptor wraps the refresh logic, so callers
  // always get an ApiProblemError, retry or not (see core/auth/auth-refresh.interceptor.ts).
  withInterceptors([apiProblemInterceptor, authRefreshInterceptor]),
),
```

`provideHttpClient(...)` builds the one `HttpClient` every `inject(HttpClient)` in the
app receives (see chapter 04 — it's a root-level provider). Each argument is a
"feature" that layers behavior on:

- **`withFetch()`** — use the browser's `fetch()` API as the transport, instead of
  `XMLHttpRequest` (the older default). Mentioned here because it changes nothing about
  how you call `HttpClient`, but it's why the network tab shows `fetch` requests.
- **`withXsrfConfiguration({ cookieName: 'XSRF-TOKEN', headerName: 'X-XSRF-TOKEN' })`**
  (names in [`core/http/xsrf.ts`](../../apps/web/src/app/core/http/xsrf.ts)) implements
  the double-submit CSRF pattern from [ADR 004](../adr/004-browser-auth.md). The API sets
  a non-`httpOnly` `XSRF-TOKEN` cookie; `HttpClient` reads it and echoes it back as the
  `X-XSRF-TOKEN` header. The rules, from Angular's `xsrfInterceptorFn`
  (`node_modules/@angular/common/fesm2022/_module-chunk.mjs`):
  - **GET and HEAD never get the header.** Only state-changing methods do.
  - **Same origin only.** The request URL is resolved against the page's origin, and the
    header is added only if the origins match. Relative `/api/...` URLs always match. An
    absolute URL to another origin never gets it, so the token cannot leak to a third
    party.
  - **Only if the cookie exists.** Angular never asks the server for a token. That is why
    the app fetches `GET /api/auth/csrf` at startup, before any POST ([chapter 11](./11-app-initializers-and-auth-flow.md)).
  - **It never overwrites** a header the request already carries.
- **`withInterceptors([apiProblemInterceptor, authRefreshInterceptor])`** registers the
  app's two functional interceptors, in that order. The order matters (see "Interceptor
  order" below).

## Functional interceptors

```ts
// src/app/core/http/api-problem.interceptor.ts
export const apiProblemInterceptor: HttpInterceptorFn = (req, next) =>
  next(req).pipe(
    catchError((error: unknown) => {
      if (!(error instanceof HttpErrorResponse)) {
        return throwError(() => error);
      }
      const problem = parseApiProblem(error.error, error.status, error.statusText);
      return throwError(() => new ApiProblemError(problem, { cause: error }));
    }),
  );
```

An `HttpInterceptorFn` is a plain function `(req, next) => Observable<HttpEvent<...>>`
— the modern replacement for the older class-based `HttpInterceptor` interface
(`intercept(req, next): Observable<...>`). `withInterceptors([...])` registers a chain
of these; each calls `next(req)` to continue to the next interceptor (or the real HTTP
call) and can transform the request going in or the response/error coming back.

The first of the app's interceptors has a narrow but important job: **every**
`HttpClient` failure, anywhere in the app, comes back to the caller as an
`ApiProblemError` rather than a raw `HttpErrorResponse`. That's a single, predictable
error shape every feature can rely on without re-parsing response bodies itself.

## Interceptor order

`withInterceptors([a, b])` nests: **the first is the outermost**. A request goes
a → b → server, and the response or error comes back server → b → a. Angular builds the
chain with `reduceRight` over the registered functions. One more interceptor sits
outside yours: `provideHttpClient()` registers Angular's own XSRF interceptor **before**
any `withInterceptors(...)` feature, so it is always the outermost:

```
request  →  xsrfInterceptorFn  →  apiProblemInterceptor  →  authRefreshInterceptor  →  backend
                (Angular)             (core/http)                 (core/auth)
error    ←  ApiProblemError    ←  converts here            ←  sees raw HttpErrorResponse 401
```

Why `[apiProblemInterceptor, authRefreshInterceptor]` and not the reverse:

- The refresh logic sits **closer to the server**, so it sees the raw
  `HttpErrorResponse` and its `status`.
- Whatever it finally lets through (the retry's result, the retry's own error, or the
  original 401 when the refresh failed) passes back through `apiProblemInterceptor`.
  Callers therefore get the **same error type (`ApiProblemError`)** whether or not a
  refresh happened in between. "Normalise at the edge, recover inside."
- The reverse order would also work, but the refresh interceptor would then have to
  understand `ApiProblemError` for no gain.

One consequence of the XSRF interceptor being outermost: it stamps the header on the
**original** request only. A retry made with `next(...)` inside a later interceptor does
not pass through it again. The refresh re-issues the `XSRF-TOKEN` cookie (it is bound to
the new session id), so the retried POST would carry a stale header and fail with 403
`xsrf`. `authRefreshInterceptor` therefore re-stamps it:

```ts
// src/app/core/auth/auth-refresh.interceptor.ts
function withCurrentXsrfToken<T>(req: HttpRequest<T>, token: string | null): HttpRequest<T> {
  if (token === null || !req.headers.has(XSRF_HEADER_NAME)) {
    return req;
  }
  return req.clone({ headers: req.headers.set(XSRF_HEADER_NAME, token) });
}
```

The token comes from `inject(HttpXsrfTokenExtractor).getToken()`, the same public
service Angular's interceptor uses. The spec "re-stamps a retried POST with the XSRF
token the refresh re-issued" covers this.

## Refresh on 401: retry once, one refresh for everyone

The access cookie lives 15 minutes (contract). When it has expired, the next API call
comes back 401. [`auth-refresh.interceptor.ts`](../../apps/web/src/app/core/auth/auth-refresh.interceptor.ts)
then calls `POST /api/auth/refresh` and re-sends the original request:

```ts
// src/app/core/auth/auth-refresh.interceptor.ts
export const authRefreshInterceptor: HttpInterceptorFn = (req, next) => {
  if (!isRefreshable(req.url)) {
    return next(req);
  }
  const refresher = inject(TokenRefresher);
  const router = inject(Router);
  const xsrf = inject(HttpXsrfTokenExtractor);

  return next(req).pipe(
    catchError((error: unknown) => {
      if (!(error instanceof HttpErrorResponse) || error.status !== 401) {
        return throwError(() => error);
      }
      return refresher.refresh().pipe(
        catchError(() => {
          if (!req.context.get(SKIP_LOGIN_REDIRECT)) {
            redirectToLogin(router);
          }
          return throwError(() => error);
        }),
        switchMap(() => next(withCurrentXsrfToken(req, xsrf.getToken()))),
      );
    }),
  );
};
```

- **Not for `/api/auth/*`.** A 401 from `POST /api/auth/login` means "wrong
  password", not "expired token". Refreshing there would make no sense, and for
  `/api/auth/refresh` itself it would loop forever.
- **`inject()` only at the top.** The interceptor body is an injection context, but only
  while it runs synchronously. A `catchError` callback runs later, outside it, so every
  `inject()` sits before the `pipe`.
- **Retry once, no loop.** The retry calls `next(...)`, which covers only the
  interceptors *after* this one plus the backend. This interceptor is not re-entered, so
  a second 401 simply reaches the caller.
- **409 `refresh-race`** (two tabs refreshed within 10 s; the other tab won and the
  cookies are already new) counts as success, so the request is retried.
- **Refresh failed:** the session is cleared (in `TokenRefresher`, once per refresh) and
  the user is sent to `/login?returnUrl=<current page>`. The caller still gets the
  original 401 as an `ApiProblemError`.

### Single flight with `share()`

A page often fires several requests at once. If all of them get a 401, the app must not
send three refreshes: refresh tokens rotate, so the second and third would present an
already-rotated token. The server tolerates that for 10 seconds (409), but the cleaner
fix is not to do it. `TokenRefresher` caches the Observable of the refresh in progress:

```ts
// src/app/core/auth/auth-refresh.interceptor.ts
refresh(): Observable<void> {
  this.inFlight ??= this.api.refresh().pipe(
    map(() => undefined),
    catchError((error: unknown) => {
      if (statusOf(error) === 409) {
        return of(undefined);
      }
      this.session.clear();
      return throwError(() => error);
    }),
    finalize(() => {
      this.inFlight = null;
    }),
    share({ resetOnRefCountZero: false }),
  );
  return this.inFlight;
}
```

- `HttpClient` Observables are **cold**: every `subscribe()` sends the request again.
  `share()` makes them **hot** for as long as the request runs. The first subscriber
  starts the one POST, later subscribers join it, and they all receive the same result.
- `inFlight` holds on to that shared Observable so the second and third 401s find it.
  `finalize()` drops it when the refresh completes or fails, so a 401 an hour later
  starts a fresh one.
- `resetOnRefCountZero: false`: normally `share()` unsubscribes from its source (here it
  would **abort the POST**) as soon as nobody is listening, for example when the user
  navigates away and the waiting requests are cancelled. An aborted refresh is
  dangerous: the server may already have rotated the token while the browser drops the
  `Set-Cookie`. The next refresh would then present the old token, and reuse detection
  would revoke the whole session. Once started, the refresh always finishes.
- A cached **Promise** would give the same single flight. The Observable fits better
  here because the retry is composed with `switchMap`.

`auth-refresh.interceptor.spec.ts` › "refreshes ONCE for three concurrent 401s" fires
three GETs, answers all three with 401, and then calls `expectOne('/api/auth/refresh')`.
That call fails if zero or two refreshes were sent.

## `HttpContext`: per-request flags for interceptors

Some requests need different treatment. At startup, `Session.load()` calls
`GET /api/me`, and a failure there just means "signed out". It must not redirect to
/login, because the visitor may be opening an emailed `/password/setup` link. The
request carries a flag that only interceptors read (it is never sent to the server):

```ts
// src/app/core/auth/auth-api.ts
export const SKIP_LOGIN_REDIRECT = new HttpContextToken<boolean>(() => false);

me(): Observable<Me> {
  return this.http.get<Me>(ME_URL, { context: new HttpContext().set(SKIP_LOGIN_REDIRECT, true) });
}
```

`HttpContextToken` is a typed key with a default value, so requests that do not set it
read `false`. The interceptor reads it with `req.context.get(SKIP_LOGIN_REDIRECT)`. Use
this instead of URL checks or custom headers whenever an interceptor needs a per-call
exception.

## `ApiProblem` and `ApiProblemError`

```ts
// src/app/core/http/api-problem.ts
export interface ApiProblem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail?: string;
  readonly instance?: string;
  readonly requestId?: string;
  readonly errors?: readonly ApiFieldError[];
}

export class ApiProblemError extends Error {
  override readonly name = 'ApiProblemError';
  constructor(readonly problem: ApiProblem, options?: { cause?: unknown }) { ... }
  get status(): number { return this.problem.status; }
}
```

`ApiProblem` mirrors RFC 9457 ("problem+json") — the shape `apps/api` returns for every
error, per `CONVENTIONS.md`'s API section: `{type, title, status, detail?, instance,
requestId, errors?: [{field, code, message}]}`. `parseApiProblem()` degrades gracefully:
a non-JSON body, an unrecognized shape, or a `status: 0` (network failure — offline,
DNS, CORS, or an aborted request) all become a *minimal but still typed* `ApiProblem`,
with `status === 0` specifically tagged `PROBLEM_TYPE_NETWORK` so callers can show "you
appear to be offline" instead of a generic error. Callers narrow an unknown caught error
with `isApiProblemError(err)` and then read `err.problem` — see it used in
`login.page.ts`'s `handleError()` and `org-forms.ts`'s `orgWriteError()`.

This is also a case where NestJS and Angular line up deliberately: the API's
problem+json filter (`apps/api/src/platform/http/`, per `CONVENTIONS.md`) produces
exactly the shape `parseApiProblem()` expects — one contract, enforced on both ends.

## `httpResource()` vs `HttpClient.get()`

Both eventually issue a GET through the same configured `HttpClient` (interceptor and
all), but for different situations — see chapter 03 for the general signals-vs-RxJS
rule. The HTTP-specific version:

```ts
// src/app/core/org/org-api.ts
treeResource(asOf: () => string | undefined): HttpResourceRef<OrgTree | undefined> {
  return httpResource<OrgTree>(() => {
    const date = asOf();
    return date === undefined ? undefined : { url: `${ORG_API_BASE}/tree`, params: { asOf: date } };
  });
}

search(query: OrgUnitSearch): Observable<OrgUnitSearchResult> {
  let params = new HttpParams();
  ...
  return this.http.get<OrgUnitSearchResult>(`${ORG_API_BASE}/units`, { params });
}
```

`treeResource` is called once per component (`organization.page.ts`:
`protected readonly tree = this.api.treeResource(this.effectiveAsOf);`) and then lives
as long as that component, re-fetching whenever `effectiveAsOf()` changes value.
`search()` is called fresh on every keystroke pipeline tick in the picker — a plain
Observable per call, composed with `switchMap` there because the *timing* (debounce,
cancel-on-new-keystroke) needs RxJS operators a resource doesn't give you directly.

## `HttpParams` with repeated values

The contract's search accepts several kinds as a **repeated** query parameter:
`GET /org/units?kind=region&kind=agency`. A plain params object
(`{ kind: 'region' }`) holds one value per name, so `OrgApi.search()` builds an
`HttpParams`:

```ts
// src/app/core/org/org-api.ts
search(query: OrgUnitSearch): Observable<OrgUnitSearchResult> {
  let params = new HttpParams();
  // HttpParams is immutable: re-assign the result of each append.
  if (query.q?.trim()) params = params.append('q', query.q.trim());
  if (query.kinds?.length) params = params.appendAll({ kind: query.kinds });
  if (query.asOf) params = params.append('asOf', query.asOf);
  return this.http.get<OrgUnitSearchResult>(`${ORG_API_BASE}/units`, { params });
}
```

- `HttpParams` is **immutable**: `append()`/`appendAll()`/`set()` return a *new*
  instance. `params.append('q', x);` on its own line does nothing — you must re-assign.
- `append(name, value)` adds one more value for `name`; `set()` would replace them all.
  `appendAll({ kind: ['region', 'agency'] })` appends each array item as its own
  `kind=` pair.
- In a test, `req.request.params.getAll('kind')` returns `['region', 'agency']`
  (`get('kind')` would return only the first) — see `org-api.spec.ts` and the
  "move picker" test in `organization.page.spec.ts`.
- On the API side, Express parses repeated keys into an array; the DTO accepts a string
  or an array (`apps/api/src/modules/organization/api/org.dto.ts`).

## Reference data: fetch once per app

`GET /org/kinds` is reference data: small, identical for every screen, changes only
with a migration. It should be requested **once per app**, not once per page visit.
Three ways to do that in Angular:

| Option | What you get | Why not / why |
|---|---|---|
| `http.get(url).pipe(shareReplay(1))` stored in a root service | One request, the last value replayed to every later subscriber | Still an `Observable`: every consumer subscribes (or wraps it in `toSignal`). A failed request is replayed as a failure to everyone unless you add retry/reset logic yourself. |
| `httpResource()` in each component | Signals, loading/error state | One request **per component instance**: every visit to `/organization` would re-fetch. |
| **`httpResource()` held by a root service** (chosen) | One request for the app's lifetime, exposed as signals (`value()`, `error()`, `hasValue()`), with `reload()` for a retry | — |

```ts
// src/app/core/org/org-api.ts
kindsResource(): HttpResourceRef<OrgKindList | undefined> {
  return httpResource<OrgKindList>(() => `${ORG_API_BASE}/kinds`);
}

// src/app/core/org/kind-catalog.ts
@Injectable({ providedIn: 'root' })
export class KindCatalog {
  private readonly resource = inject(OrgApi).kindsResource();
  ...
  reload(): void {
    this.resource.reload();
  }
}
```

Why it fetches once: a resource re-runs its request function only when a signal it
read changes, and this one reads none. The service is created by the root injector on
the first `inject(KindCatalog)` (the tree, the forms, the picker, the page all inject
the *same* instance), and a root service's field initializer is an injection context,
so `httpResource()` can be created there. The resource lives as long as the app.
`organization.page.html` shows the catalogue's `error()` with a retry button calling
`kindCatalog.reload()`.

Compare the **sites list**: tenant data that users change (the Sites page creates
sites). The tree page loads it once *per page* (`OrganizationPage.sitesResource`) and
passes it down to the forms and the detail as an input; the Sites page has its own
`sitesResource(this.q)` driven by the `?q=` query param. Caching it app-wide would
serve stale lists after a create.

## Cancellation

Both paths cancel superseded requests, by different mechanisms:

- `httpResource()` cancels the in-flight request itself when its dependency signals
  change before the previous one resolved (built into the resource).
- `switchMap` in the picker's pipeline unsubscribes from the previous inner Observable
  when a new value arrives from `searches`; for an `HttpClient` Observable,
  unsubscribing **aborts the underlying request** — this is exactly why the header
  comment in `org-api.ts` says writes/search use Observables "where RxJS operators do
  the heavy lifting": cancellation is a first-class RxJS behavior, not something you'd
  have to build by hand.

`org-unit-picker.spec.ts`'s "cancels a stale search when the user keeps typing" test
asserts this directly: `expect(stale.cancelled).toBe(true)` after a second keystroke
supersedes the first request. See chapter 09.

## Same-origin cookies and the dev proxy

Per [ADR 004](../adr/004-browser-auth.md), both the access and refresh tokens live in
same-origin, `httpOnly`, `SameSite=Strict` cookies — never readable from JavaScript, and
never handled by this app's code at all. `apps/web`'s only cookie-related code is the
XSRF configuration above; the browser sends the session cookies automatically because
every API call is same-origin (`/api/...`).

In development, `apps/web/proxy.conf.json` forwards `/api` to `http://localhost:3000`:

```json
{
  "/api": {
    "target": "http://localhost:3000",
    "secure": false,
    "changeOrigin": false,
    "logLevel": "warn"
  }
}
```

To the browser, the API therefore has the same origin as the app (`localhost:4200`). The
`SameSite=Strict` session cookies are sent, and the XSRF interceptor adds its header to
`/api` POSTs. Until the Identity slice, this proxy also injected `X-Dev-User-Id` /
`X-Dev-Company-Id` headers (the API's `DEV_AUTH` identity). Those headers are gone now:
the web signs in for real, and `DEV_AUTH` remains only for API tests and curl. No
browser code had to change to remove them, because the proxy had been the only place
that knew about them. `ng serve` is the only place this proxy runs; a production build
has no proxy config at all.

## Next

[07-forms.md](./07-forms.md) — typed reactive forms, and how a `422`/`409` from this
error pipeline becomes a message next to the right field.
