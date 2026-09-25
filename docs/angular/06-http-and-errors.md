# 6. HTTP and errors

See also: [03-signals-and-state.md](./03-signals-and-state.md) for `httpResource()`
mechanics, [07-forms.md](./07-forms.md) for turning a failed write into form errors,
[09-testing.md](./09-testing.md) for `HttpTestingController`.

## Configuring `HttpClient`

```ts
// src/app/app.config.ts
provideHttpClient(
  withFetch(),
  withXsrfConfiguration({ cookieName: 'XSRF-TOKEN', headerName: 'X-XSRF-TOKEN' }),
  withInterceptors([apiProblemInterceptor]),
),
```

`provideHttpClient(...)` builds the one `HttpClient` every `inject(HttpClient)` in the
app receives (see chapter 04 — it's a root-level provider). Each argument is a
"feature" that layers behavior on:

- **`withFetch()`** — use the browser's `fetch()` API as the transport, instead of
  `XMLHttpRequest` (the older default). Mentioned here because it changes nothing about
  how you call `HttpClient`, but it's why the network tab shows `fetch` requests.
- **`withXsrfConfiguration({ cookieName: 'XSRF-TOKEN', headerName: 'X-XSRF-TOKEN' })`**
  — implements the double-submit CSRF pattern from
  [ADR 004](../adr/004-browser-auth.md): the API sets a non-`httpOnly` `XSRF-TOKEN`
  cookie; `HttpClient` reads it and echoes it back as the `X-XSRF-TOKEN` header on
  state-changing requests automatically. No code in this app ever touches that cookie or
  header directly — that's the point of using Angular's built-in support instead of a
  custom interceptor.
- **`withInterceptors([apiProblemInterceptor])`** — registers the app's one functional
  interceptor, covered next.

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

This app has exactly one interceptor, and its job is narrow but important: **every**
`HttpClient` failure, anywhere in the app, comes back to the caller as an
`ApiProblemError` rather than a raw `HttpErrorResponse`. That's a single, predictable
error shape every feature can rely on without re-parsing response bodies itself.

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

In development, `apps/web/proxy.conf.json` forwards `/api` to `http://localhost:3000`
and injects two headers on every proxied request:

```json
{
  "/api": {
    "target": "http://localhost:3000",
    "headers": {
      "X-Dev-User-Id": "0190a5d0-0000-7000-8000-0000000000aa",
      "X-Dev-Company-Id": "0190a5d0-0000-7000-8000-000000000001"
    }
  }
}
```

This exists only because the Identity module doesn't exist yet
(`docs/contracts/organization.md`'s "Development identity" section): the API accepts
`DEV_AUTH=true` only when `NODE_ENV` is `development`/`test`, and with it on, reads
these two headers as the caller's identity instead of a real session. The **proxy**
injects them — `apps/web`'s own TypeScript never constructs or sends these headers, so
there is nothing to remove from the browser code once real login lands; only
`proxy.conf.json` and the API's dev-auth path go away. `ng serve` is the only place this
proxy runs; a production build has no proxy config at all.

## Next

[07-forms.md](./07-forms.md) — typed reactive forms, and how a `422`/`409` from this
error pipeline becomes a message next to the right field.
