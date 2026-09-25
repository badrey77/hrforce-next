# 5. Routing

See also: [01-mental-model.md](./01-mental-model.md) for where the router sits in the
bootstrap sequence, [09-testing.md](./09-testing.md) for `RouterTestingHarness`.

## The routes file

```ts
// src/app/app.routes.ts
export const routes: Routes = [
  { path: 'login', loadComponent: () => import('./features/auth/login.page').then((m) => m.LoginPage) },
  { path: '', pathMatch: 'full', loadComponent: () => import('./features/home/home.page').then((m) => m.HomePage) },
  { path: 'employees', loadComponent: () => import('./features/placeholder/placeholder.page').then((m) => m.PlaceholderPage), data: { titleKey: 'nav.employees' } },
  {
    path: 'organization',
    loadChildren: () => import('./features/organization/organization.routes').then((m) => m.ORGANIZATION_ROUTES),
  },
  { path: 'settings', loadComponent: () => ..., data: { titleKey: 'nav.settings' } },
  { path: '**', loadComponent: () => import('./features/not-found/not-found.page').then((m) => m.NotFoundPage) },
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

## The not-found route

```ts
{ path: '**', loadComponent: () => import('./features/not-found/not-found.page').then((m) => m.NotFoundPage) },
```

`**` is the wildcard path — it matches anything not matched by an earlier entry, so it
must be **last** in the array (route matching is first-match-wins, top to bottom).
`not-found.page.ts` renders a 404 message and a link home; nothing more is needed for a
purely client-side "page not found" (the server always returns `index.html` for unknown
paths in an SPA deployment — that's a hosting concern, not something this route
controls).

## Where guards will go

There are no route guards yet (`CanActivate`/`CanMatch` functions, or `authGuard`-style
functional guards) — `AuthService.login()` in
`src/app/features/auth/auth.service.ts` is explicitly a stub: "Stub until the Identity
module lands: the API sets httpOnly session cookies, so the body is not used by the
client yet." Once identity/session state exists on the client, the natural place for an
auth guard is a functional `CanActivateFn` (the modern style, replacing class-based
guards) added to the routes that need it in `app.routes.ts`, likely checking a
signal-backed "is logged in" state the same way `OrganizationPage` checks
`tree.hasValue()`. This guide will grow a routing-guards example once that lands (per
`CLAUDE.md`'s "update the guide" rule) — for now, don't invent one speculatively.

## Next

[06-http-and-errors.md](./06-http-and-errors.md) — how `OrgApi` actually talks to the
API, and what happens when a request fails.
