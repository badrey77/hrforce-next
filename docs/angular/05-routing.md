# 5. Routing

See also: [01-mental-model.md](./01-mental-model.md) for where the router sits in the
bootstrap sequence, [09-testing.md](./09-testing.md) for `RouterTestingHarness`.

## The routes file

```ts
// src/app/app.routes.ts (abridged)
export const routes: Routes = [
  { path: 'login', canMatch: [guestGuard], loadComponent: () => import('./features/auth/login.page').then((m) => m.LoginPage) },
  { path: 'password/setup', loadComponent: () => import('./features/auth/password-setup.page').then((m) => m.PasswordSetupPage) },
  { path: 'password/forgot', loadComponent: () => import('./features/auth/password-forgot.page').then((m) => m.PasswordForgotPage) },
  { path: '', pathMatch: 'full', canMatch: [authGuard], loadComponent: () => import('./features/home/home.page').then((m) => m.HomePage) },
  { path: 'employees', canMatch: [authGuard], loadComponent: () => ..., data: { titleKey: 'nav.employees' } },
  {
    path: 'organization',
    canMatch: [authGuard],
    loadChildren: () => import('./features/organization/organization.routes').then((m) => m.ORGANIZATION_ROUTES),
  },
  { path: 'settings', canMatch: [authGuard], loadComponent: () => ..., data: { titleKey: 'nav.settings' } },
  NOT_FOUND_ROUTE, // { path: '**', loadComponent: () => import('./not-found.page')… } — see "The not-found route"
];
```

`provideRouter(routes, withComponentInputBinding())` in `app.config.ts` wires this
array in as the app's routing table. Each entry maps a URL path to what to render.

## `loadComponent` vs `loadChildren`

Both are **lazy**: the referenced module is a separate build output (a "chunk"),
fetched over the network only the first time the user navigates to a matching route —
not included in the initial bundle. The dynamic `import()` syntax is what makes this
possible; it's ordinary JS, and Angular's builder (`@angular/build:application` in
`angular.json`) splits the chunk automatically.

- **`loadComponent`** lazy-loads **one component** for **one path**: `/login`,
  `/employees`, `/settings`, `**`. Use it when a route is a single page with no
  sub-routes of its own.
- **`loadChildren`** lazy-loads a **whole `Routes` array**, so the target feature
  decides its own sub-paths without the app-level file knowing about them:

  ```ts
  // src/app/features/organization/organization.routes.ts
  export const ORGANIZATION_ROUTES: Routes = [
    { path: '', component: OrganizationPage },
    { path: 'sites', loadComponent: () => import('./sites.page').then((m) => m.SitesPage) },
  ];
  ```

  Mounted at `/organization` by the parent config's `loadChildren`, this defines
  `/organization` (the tree) and `/organization/sites` (the sites list, added with
  contract v2) — and adding the second one touched only `organization.routes.ts`, never
  `app.routes.ts`. `loadChildren` was picked *because* this feature was expected to grow; a feature with a single, fixed page
  and no plans to add sub-routes would just use `loadComponent` instead, as
  `employees`/`settings` currently do (they're placeholders today, but will likely
  switch to `loadChildren` once the Employees module needs sub-routes).

  Notice `organization.routes.ts` imports `OrganizationPage` with a **static** `import`,
  not another dynamic one — that's correct, not an oversight: this file is *already*
  inside the lazy chunk that `loadChildren` fetches, and the tree is the feature's
  landing page. The sites page, on the other hand, uses `loadComponent` **inside** the
  lazy feature: a second, smaller chunk (`sites-page` in the `ng build` output) fetched
  only when someone opens the sites section. Lazy loading nests.

  Why sites got a sub-route rather than a panel on the tree page (see `org-nav.ts`'s
  header): a site is a place, not a tree node, and its list/search/create shares
  nothing with the tree's date and selection; a route gives it a linkable URL
  (`/organization/sites?q=oran`, the search text bound to the `q` input exactly like
  `asOf`).

### Section links: `routerLinkActive` options

`org-nav.ts` renders the two section links. `/organization` must not look active on
`/organization/sites`, but must stay active on `/organization?asOf=…`:

```ts
// src/app/features/organization/org-nav.ts
protected readonly exactPath: IsActiveMatchOptions = {
  paths: 'exact',
  queryParams: 'ignored',
  matrixParams: 'ignored',
  fragment: 'ignored',
};
```

`[routerLinkActiveOptions]="{ exact: true }"` is shorthand for exact paths **and** exact
query params, which would switch the link off as soon as a date is picked;
`IsActiveMatchOptions` controls each part separately. `ariaCurrentWhenActive="page"`
adds `aria-current="page"` to the active link.

## `withComponentInputBinding()` and query params as inputs

```ts
// app.config.ts
provideRouter(routes, withComponentInputBinding()),
```

With this feature enabled, the router copies route params, query params and route
`data` onto a routed component's inputs **of the same name** — no `ActivatedRoute`
subscription needed for the common case. Two examples in this codebase:

```ts
// src/app/features/organization/organization.page.ts
/** `?asOf=YYYY-MM-DD`, bound by the router (withComponentInputBinding). Absent → undefined. */
readonly asOf = input<string>();
```

Navigating to `/organization?asOf=2025-01-31` sets `asOf()` to `'2025-01-31'`
automatically; navigating back to `/organization` (no query param) sets it back to
`undefined`. Because `asOf` is a signal input, everything derived from it
(`effectiveAsOf`, and through it the `tree` resource) updates on its own — see chapter
03.

```ts
// src/app/features/placeholder/placeholder.page.ts
/** Bound from route `data.titleKey` (withComponentInputBinding). */
readonly titleKey = input('app.title');
```

Here it's not a query/route param but the static `data: { titleKey: 'nav.employees' }`
from `app.routes.ts` — same binding mechanism, different source.

## Route params, `redirectTo` and path order (the Access feature)

```ts
// src/app/features/access/access.routes.ts
export const ACCESS_ROUTES: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'users' },
  { path: 'users', component: UsersPage },
  { path: 'users/:id', loadComponent: () => import('./user-detail.page').then((m) => m.UserDetailPage) },
  { path: 'roles', component: RolesPage },
  {
    path: 'roles/new',
    canMatch: [permissionGuard('access.manage_roles')],
    loadComponent: () => import('./role-editor.page').then((m) => m.RoleEditorPage),
  },
  { path: 'roles/:id', loadComponent: () => import('./role-editor.page').then((m) => m.RoleEditorPage) },
];
```

- **`redirectTo` + `pathMatch: 'full'`**: `/access` goes to `/access/users`. Without
  `'full'`, the empty path would prefix-match every child URL and redirect them all.
- **`:id` is a route param.** With `withComponentInputBinding()` it arrives as the input
  `id = input.required<string>()` (`user-detail.page.ts`), exactly like query params do.
- **Order matters.** `roles/new` must come before `roles/:id`, or `:id` would swallow the
  word "new". The same component serves both paths: with no `:id`, its `id` input stays
  `undefined`, so the editor is in "create" mode.
- `[routerLink]="['/access/users', user.id]"` builds the URL from **segments**, and the
  router encodes each one.

## Navigating and updating just the query string

```ts
// organization.page.ts
protected onAsOfChange(event: Event): void {
  const value = event.target instanceof HTMLInputElement ? event.target.value : '';
  this.feedback.set(null);
  void this.router.navigate([], {
    relativeTo: this.route,
    queryParams: { asOf: isIsoDate(value) ? value : null },
    queryParamsHandling: 'merge',
  });
}
```

- `router.navigate([], { relativeTo: this.route, ... })` — an empty path array plus
  `relativeTo` means "stay on the current route, just change what's asked below."
- `queryParamsHandling: 'merge'` keeps any *other* query params already on the URL and
  only overwrites `asOf` — important once this page has more than one query param.
- Setting a query param to `null` **removes** it from the URL (used here to go back to
  "no `asOf`", i.e. "today").

This is the standard pattern any date/filter-in-the-URL page in this codebase should
follow: it makes the state shareable (paste the URL, get the same view) and makes the
browser back/forward buttons work for free, since `asOf` is just re-read as an input
each time the URL changes.

With many params (the employee list has ten), add two options: page resets on every
filter change, and **`replaceUrl: true`** for debounced keystrokes so typing does not
fill the browser history. Chapter 14 §1 ("URL as state") walks through it with
`features/employees/employees.page.ts`.

## The not-found route

```ts
// apps/web/src/app/shared/not-found/not-found.route.ts
export const NOT_FOUND_ROUTE: Route = {
  path: '**',
  loadComponent: () => import('./not-found.page').then((m) => m.NotFoundPage),
};
```

`**` is the wildcard path — it matches anything not matched by an earlier entry, so it
must be **last** in the array (route matching is first-match-wins, top to bottom).
`not-found.page.ts` renders a 404 message and a link home; nothing more is needed for a
purely client-side "page not found" (the server always returns `index.html` for unknown
paths in an SPA deployment — that's a hosting concern, not something this route
controls).

The entry is a shared constant (in `shared/`, because features may not import each
other) since it is used in **three kinds of places**:

1. **Last in `app.routes.ts`** — the classic catch-all.
2. **Last in a feature's child table** whose landing page has its own permission
   ([`features/leave/leave.routes.ts`](../../apps/web/src/app/features/leave/leave.routes.ts),
   [`features/documents/documents.routes.ts`](../../apps/web/src/app/features/documents/documents.routes.ts)).
   The router matches segment by segment. `/leave` is consumed entirely by the parent
   `path: 'leave'`, so the children must match **zero** segments. When none does — the
   `''` child's `canMatch` said no — the recogniser does **not** back out and try the
   app's next routes: "no segments left" counts as a successful match, and the parent is
   kept with an **empty outlet**. The user saw a blank page under the menu. A URL with
   segments left over (`/leave/settings` refused) is different: the leftover makes the
   parent fail, and the app-level `**` answers. A `**` child catches both inside the
   feature.
3. **With another `path`, right after a guarded static path**:
   `{ ...NOT_FOUND_ROUTE, path: 'new' }` (an object spread: the same entry, one property
   replaced). Without it, a refused `new` would fall through to `:id` and the detail page
   would ask the API for a record called "new".

[`app.routes.spec.ts`](../../apps/web/src/app/app.routes.spec.ts) loads the **real**
route table and opens every guarded URL as users who lack the permission; each must show
the `404` heading. It is the test to extend when you add a guarded route.

## Guards: who may use a route

A **guard** is a function the router calls while it decides whether a route may be used.
This app has two, both in
[`src/app/core/auth/auth.guards.ts`](../../apps/web/src/app/core/auth/auth.guards.ts):

```ts
// src/app/core/auth/auth.guards.ts
export const authGuard: CanMatchFn = (_route, segments: UrlSegment[]) => {
  if (inject(Session).isAuthenticated()) {
    return true;
  }
  const router = inject(Router);
  const attempted = router.currentNavigation()?.extractedUrl;
  const returnUrl = attempted ? router.serializeUrl(attempted) : `/${segments.map((s) => s.path).join('/')}`;
  return router.createUrlTree(['/login'], { queryParams: { returnUrl } });
};

export const guestGuard: CanMatchFn = () =>
  inject(Session).isAuthenticated() ? inject(Router).createUrlTree(['/']) : true;
```

- **Functional guards.** A guard is a plain function typed `CanMatchFn` /
  `CanActivateFn`. The router calls it inside an injection context, so `inject()` works
  (chapter 04). Class-based guards (`implements CanActivate`) are the older style.
- **They read a signal.** `Session.isAuthenticated()` is a `computed()` in a root
  service (chapter 03). The guard does not wait for anything: the app initializer
  already loaded the session before the first navigation ([chapter 11](./11-app-initializers-and-auth-flow.md)).

### `canMatch` vs `canActivate`: when does the lazy chunk load?

The router handles a navigation in phases
(`node_modules/@angular/router/fesm2022/_router-chunk.mjs`: `recognize` →
`checkGuards` → `resolveData` → `loadComponents`):

| Phase | What happens | `loadChildren` chunk | `loadComponent` chunk |
|---|---|---|---|
| 1. match (recognize) | URL matched against the config; **`canMatch` guards run here** | downloaded here, *after* that route's `canMatch` passed (the router needs the child routes to keep matching) | — |
| 2. guards | **`canActivate`** / `canActivateChild` / `canDeactivate` run | already downloaded | — |
| 3. resolve | resolvers | | |
| 4. activate | components loaded and created | | downloaded here |

So `canActivate` on `/organization` (a `loadChildren` route) would run only **after** the
Organization chunk had been downloaded for a signed-out visitor. `canMatch` runs before
it, so signed-out visitors never download feature code. That is why the app uses
`canMatch` everywhere. `auth.guards.spec.ts` checks this with a `loadChildren` spy that
is never called when the visitor is signed out.

Two more differences:

- **The meaning of `false`.** `canActivate` returning `false` cancels the navigation.
  `canMatch` returning `false` means "this route does not match, **try the next one**":
  the router carries on down the array and ends up on `**`, the 404 page. So these
  guards never return `false`. They return a `UrlTree`.
- **What they receive.** `canActivate` gets the full `RouterStateSnapshot` (and so
  `state.url`). `canMatch` gets only the `Route` and the URL segments at that level. The
  full target URL comes from `router.currentNavigation()?.extractedUrl`.
  `currentNavigation` is a signal (Angular ≥ 20.2); it replaces the deprecated
  `getCurrentNavigation()`.

Use `canActivate` when the check needs resolved route data or the whole router state,
or when the route should stay matchable for other reasons (e.g. a `canDeactivate`
partner). For "does this route exist for you?", use `canMatch`.

### Return a `UrlTree`, don't call `navigate()`

`router.createUrlTree(['/login'], { queryParams: { returnUrl } })` builds a parsed URL
without going anywhere. Returned from a guard, it tells the router to cancel this
navigation and go there instead, as one redirect. History, router events and the
`returnUrl` all stay consistent. If the guard called `router.navigate()` itself, it
would start a **second** navigation while the first one was still running, and it would
still have to return `false` for the first. (A guard may also return a
`RedirectCommand`, which wraps a `UrlTree` with navigation options such as
`skipLocationChange`. Not needed here.)

### Which routes carry which guard

From the contract (`docs/contracts/identity.md` › Web): `authGuard` on every route
except `/login`, `/password/setup`, `/password/forgot` and `**`. `/organization` and
`/access` also carry `permissionGuard()` (next section). `guestGuard` goes on
`/login`. The password pages have no guard, because an emailed link must work whether or
not someone is signed in on that browser. The guards are attached route by route rather
than through a componentless `path: ''` parent with `children`: a `canMatch` on a `''`
prefix parent would also catch unknown URLs and send signed-out visitors to /login
instead of the 404 page.

### Permission guards and route `data`

Since the Authorization step, some routes also need a **permission**. The guard is a
*factory* (`permissionGuard(code?)` returns a `CanMatchFn`), and the code can come from
the route's static `data`:

```ts
// src/app/app.routes.ts
{
  path: 'organization',
  canMatch: [authGuard, permissionGuard()],
  data: { permission: 'org_unit.read' },
  loadChildren: () =>
    import('./features/organization/organization.routes').then((m) => m.ORGANIZATION_ROUTES),
},
```

- `canMatch` receives the `Route` object, so the guard reads `route.data['permission']`.
  `permissionGuard('site.read')` passes the code as an argument instead
  (`features/organization/organization.routes.ts`).
- The router runs **all** `canMatch` guards of a route and takes the first non-`true`
  result **in array order**. `authGuard` first means signed-out visitors still get the
  /login redirect.
- Unlike `authGuard`, `permissionGuard` returns **`false`**. The route "does not match",
  the router falls through to `**`, and the user sees the 404 page: the route does not
  exist for them, as ADR 002 wants for out-of-scope data. The `loadChildren` chunk is
  never fetched.
- `data` of a componentless `loadChildren` parent is inherited by its children, and
  `withComponentInputBinding()` binds `data` keys to inputs **of the same name**. Do not
  give a page an input called `permission` by accident.

The full story (factory vs data, `false` vs `UrlTree`, the `roles/new` → `roles/:id`
fall-through) is in [chapter 12](./12-permission-aware-ui.md#3-route-guards-with-data-permissionguard).

### `returnUrl` and open redirects

The login page receives `?returnUrl=` as a signal input (`withComponentInputBinding()`,
above) and, after a successful sign-in, navigates there. Anyone can put anything in the
query string. A phishing mail linking to
`/login?returnUrl=https://evil.example/fake-hr` would log the user in on the real site
and then send them to a copy of it. This is an **open redirect**. So `safeReturnUrl()`
([`core/auth/return-url.ts`](../../apps/web/src/app/core/auth/return-url.ts)) accepts
only internal paths: they must start with a single `/`. It rejects `//host` and `/\host`
(browsers treat `\` like `/`), control characters and absolute URLs, and anything else
falls back to `/`:

```ts
// src/app/features/auth/login.page.ts
await this.router.navigateByUrl(safeReturnUrl(this.returnUrl()));
```

## Next

[06-http-and-errors.md](./06-http-and-errors.md) — how `OrgApi` actually talks to the
API, and what happens when a request fails.

## Two guards in one `canMatch` array: two-step sign-in enforcement

`app.routes.ts` now protects signed-in pages with `const signedIn = [authGuard, mfaEnrollmentGuard]` (spread into
each route) instead of `authGuard` alone; only `/me/security` keeps `[authGuard]`, since it is where
`mfaEnrollmentGuard` redirects (`/me/security?enroll=1&returnUrl=…`). Guards run in array order and the first
non-`true` result wins, so a signed-out visitor still lands on /login. Details, and the interceptor that covers
policy changes during a session: [chapter 17 §8](./17-multi-step-ui-wizards-and-two-step-sign-in.md#8-enforcement-a-guard-and-an-interceptor).
