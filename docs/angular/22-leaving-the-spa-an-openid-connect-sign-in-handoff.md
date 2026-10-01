# 22. Leaving the SPA: an OpenID Connect sign-in handoff

See also: [05-routing.md](./05-routing.md) (guards, `NOT_FOUND_ROUTE`),
[11-app-initializers-and-auth-flow.md](./11-app-initializers-and-auth-flow.md) (the session, `returnUrl`),
[12-permission-aware-ui.md](./12-permission-aware-ui.md) (permission guards, `_actions`),
[17-multi-step-ui-wizards-and-two-step-sign-in.md](./17-multi-step-ui-wizards-and-two-step-sign-in.md) (two-step
sign-in, the enforcement guard and interceptor),
[20-kiosks-timers-canvas-and-the-punch-flow.md](./20-kiosks-timers-canvas-and-the-punch-flow.md) (a route without
the app chrome, a flow that survives a sign-in redirect).

The SSO slice (docs/contracts/sso.md, ADR 007) makes HRForce an **OpenID Connect provider**: other apps of the group
(the demo is `apps/sso-demo`) send their users to HRForce to sign in, and get back who the person is and which roles
they hold *in that app*. On the web side that means one unusual page — a page whose whole job is to hand the browser
over to somebody else — plus ordinary admin screens (Access → Applications). The Angular pieces:

1. [OpenID Connect in two paragraphs](#1-openid-connect-in-two-paragraphs-for-an-angular-developer)
2. [The handoff page](#2-the-handoff-page-a-route-with-no-guard-and-no-chrome)
3. [`returnUrl` across sign-in, second factor and enrollment](#3-returnurl-across-sign-in-the-second-factor-and-enrollment)
4. [Leaving the SPA: `location.assign` vs the router](#4-leaving-the-spa-locationassign-vs-the-router)
5. [A show-once secret](#5-a-show-once-secret)
6. [Repeatable form rows with a `FormArray`](#6-repeatable-form-rows-with-a-formarray)
7. [A parent route guarded by any of two permissions](#7-a-parent-route-guarded-by-any-of-two-permissions)
8. [The rest](#8-the-rest) — tabs, a resource passed to a child, `toSignal(valueChanges)`, timeline labels, tests.

## 1. OpenID Connect in two paragraphs (for an Angular developer)

OpenID Connect (OIDC) is a small layer on OAuth 2.0. A *relying party* (the sister app) redirects the browser to the
*provider*'s `/authorize` URL with its `client_id`, the exact `redirect_uri` it registered, a random `state`, a `nonce`
and a PKCE challenge. The provider signs the person in however it likes, then redirects back to that `redirect_uri`
with a one-time **code**. The app's *server* swaps the code (plus its client secret and the PKCE verifier) for an **ID
token**: a JWT signed by the provider that says who the person is (`sub`, `name`, `email`…). Here it also carries
`roles`, the codes of the person's roles in that app, managed in Access → Applications.

What matters for us: **the Angular app is not the OIDC client and never sees a token.** The provider runs inside the
API (`oidc-provider`, mounted at `/oidc`), and everything protocol-shaped happens in redirects between browser, API and
the sister app's server. Angular only owns the moment in the middle — "is somebody signed in to HRForce, and may they
go to that app?" — because HRForce's own sign-in page, second factor, lockout and language switcher already live here.
The provider asks for that moment by redirecting to `/sso/<uid>` (the *interaction*), and gets the answer back through
two API calls: `GET /api/sso/interactions/<uid>/details` and `POST …/complete`.

## 2. The handoff page: a route with no guard and no chrome

[`features/sso/sso-handoff.page.ts`](../../apps/web/src/app/features/sso/sso-handoff.page.ts), route in
[`app.routes.ts`](../../apps/web/src/app/app.routes.ts):

```ts
{ path: 'sso/:uid', data: { chrome: false }, loadComponent: () => import('./features/sso/sso-handoff.page')… }
```

- **No guard.** A visitor coming from a sister app is often signed out. `authGuard` would bounce them to `/login`
  before the page could even say *which* app is asking — so, like `/punch` (chapter 20), the page decides itself.
- **No chrome** (`data: { chrome: false }`, read by `app.ts`, chapter 20): a centred card. The language switcher
  normally lives in the header, so the page imports `LanguageSwitcher` from `shell/` itself.
- **One `effect()` keyed on the route param.** `uid = input.required<string>()` arrives through
  `withComponentInputBinding()`. The constructor runs `effect(() => { const uid = this.uid(); untracked(() =>
  void this.start(uid)); })`: the effect depends on `uid()` only (`untracked` keeps the session and state signals the
  flow reads out of its dependencies), so a reused component with a new uid restarts, and nothing else does. A run
  counter drops answers from a stale run.
- **The session is read once, after the details.** The app initializer loaded the session before the first navigation
  (chapter 11), and the login page reloads it before navigating back here. So `session.isAuthenticated()` read after
  `details` IS the answer. Watching the session with an `effect()` or `toObservable()` would be wrong here: a sign-out
  in another tab must not re-run a sign-in. Reach for those when a page must *follow* the session (the notification
  stream in chapter 16 does); read once when the page *acts* once.
- **The steps are ordered**, so they are `async`/`await` over `firstValueFrom()`, and the result is one signal of a
  discriminated union (`working` / `completing` / `problem`) that the template `@switch`es on — the punch page's
  recipe.

The states (contract › States the web must handle): details 404 → "expired" with a link home (the app is unknown, so
no "back"); 409 → "app unavailable"; `complete` 403 `sso-not-member` → the app name, « Retourner à l'application »
(`POST …/abort`, the app receives `access_denied`) and « Changer de compte »; 403 `account-disabled` → the login
page's wording; a fresh sign-in requested → sign out and sign in again, automatically.

The app's name is the only data shown, and it comes from the API (`details.client`), never from the URL. Inside a
translated sentence it is wrapped in Unicode isolates (U+2068/U+2069), so an Arabic name in a French sentence keeps
its direction (chapter 21 §1). The uid is never rendered.

## 3. `returnUrl` across sign-in, the second factor and enrollment

Nothing new had to be built for the sign-in itself — that is the point of reusing the login page:

- **Signed out** → `router.navigate(['/login'], { queryParams: { returnUrl: '/sso/<uid>' }, replaceUrl: true })`. The
  login page validates `returnUrl` with `safeReturnUrl()` (a relative path is accepted), handles the password, the
  TOTP step and lockout, reloads the session and navigates back. `replaceUrl` keeps the handoff page out of the
  history: Back from the login page leaves the flow instead of bouncing to `/login` again.
- **The banner.** [`login.page.ts`](../../apps/web/src/app/features/auth/login.page.ts) shows « Connectez-vous pour
  continuer vers l'application. » when `returnUrl` starts with `/sso/` — *without* the app's name: the URL is
  attacker-controlled, and only the handoff page knows the real name.
- **The interceptors keep doing their jobs.** A 401 from `complete` (the 15-minute access cookie expired) goes through
  the refresh interceptor: refresh once and retry, or — the session is dead — `/login?returnUrl=<router.url>`, which is
  this page. A 403 `mfa-enrollment-required` the session did not predict goes through `mfaEnrollmentInterceptor`
  (chapter 17), which opens the enrollment wizard with the same `returnUrl`.
- **One gap, filled by the page.** When the session *already* says "must enrol", that interceptor deliberately does
  nothing: on every other route `mfaEnrollmentGuard` is in charge. This route has no guard, so the page calls the same
  `enrollmentUrlTree()` itself before `complete`. Reading the code you lean on, rather than assuming it covers you,
  is what found this.
- **A loop guard in the URL.** "The app wants a fresh sign-in" means sign out, then the login round trip with
  `returnUrl=/sso/<uid>?fresh=1`. If the answer is still "not fresh enough" after that, the page sees `fresh=1` (a
  query-param input) and stops with a message. The state that prevents the loop travels in the URL, not in storage.

## 4. Leaving the SPA: `location.assign` vs the router

When `complete` answers `{redirectTo: "<issuer>/auth/<uid>"}`, the browser must load that URL *from the server*: the
provider then redirects to the sister app. The router cannot do that. `router.navigate()` only moves between the
app's own routes with `history.pushState` — no request leaves the browser — and an unknown path ends on the `**`
route, the 404 page. A **full navigation** is needed: `location.assign(url)`.

[`core/browser/page-location.ts`](../../apps/web/src/app/core/browser/page-location.ts) wraps it in an
`InjectionToken` with a factory (chapter 04):

```ts
export const PAGE_LOCATION = new InjectionToken<PageLocation>('PAGE_LOCATION', {
  providedIn: 'root',
  factory: () => { const document = inject(DOCUMENT); return { assign: (url) => document.defaultView?.location.assign(url) }; },
});
```

Two reasons for the token rather than calling `window.location.assign` directly: the component never touches a
global (Angular's `DOCUMENT` token), and a test provides `{ provide: PAGE_LOCATION, useValue: { assign: spy } }` and
asserts the URL — assigning `location` in jsdom would try to navigate the test runner. Before handing the browser
over, the page checks `redirectTo` is an `http(s)` URL under `/oidc/` (`isProviderUrl`): the API asserts the same,
but a page that sends the browser somewhere checks where.

Rule of thumb: **router for this app's pages** (even "Aller à l'accueil de HRForce" is a `routerLink`), **a full
navigation for anything the server must answer** — another site, a server-rendered page, a file download URL.

## 5. A show-once secret

Registering an app (`POST /sso/clients`) or rotating its secret answers with `clientSecret` — once. The API stores it
encrypted and will never show it again. [`features/access/secret-panel.ts`](../../apps/web/src/app/features/access/secret-panel.ts)
and the two pages that use it ([`app-new.page.ts`](../../apps/web/src/app/features/access/app-new.page.ts),
[`app-detail.page.ts`](../../apps/web/src/app/features/access/app-detail.page.ts)) follow four rules:

- **It lives in a component signal, nowhere else.** `secret = signal<string | null>(null)` in the *page*; the panel
  only receives it as an input. Not in `SsoApi` or any root service (they live as long as the tab and any component can
  inject them), not in `localStorage`/`sessionStorage` (any script of the origin reads them, and they reach the
  disk), never in the URL (history, logs, Referer). `SsoApi.createClient()` returns a cold Observable and keeps
  nothing (no `shareReplay`).
- **It is dropped as soon as possible.** « Terminer » sets it to `null`; `inject(DestroyRef).onDestroy(() =>
  this.secret.set(null))` covers every other way out. Only the non-secret part of the answer (id, client id) is kept
  for the next navigation.
- **Copying.** `copyText()` uses the async Clipboard API from the click; if the browser refuses, the panel selects the
  text of the read-only field (`viewChild` → `HTMLInputElement.select()`) and says "copy it with Ctrl+C". A checkbox
  « J'ai copié le secret » (one signal) gates « Terminer ».
- **Leaving asks first.** `secretLeaveGuard` is a `CanDeactivateFn<SecretHolder>`: the router calls it *before
  leaving* the route, passing the page component, and the page answers `holdsSecret()`. While it is true, the guard
  asks the browser's `confirm()` (a synchronous yes/no is exactly what a guard needs). The route table lists it:

  ```ts
  { path: 'apps/new', canMatch: [...], canDeactivate: [secretLeaveGuard], loadComponent: … }
  ```

  The router never sees a tab being closed, so the panel also has `host: { '(window:beforeunload)': … }` — a host
  listener on a global target; `preventDefault()` makes the browser ask its own "Leave site?" question.

## 6. Repeatable form rows with a `FormArray`

Redirect URIs are a list of 1–10 exact URLs. In
[`app-settings-form.ts`](../../apps/web/src/app/features/access/app-settings-form.ts) they are a
`FormArray<FormControl<string>>`:

```ts
redirectUris: this.fb.array([this.uriControl()], [listSize(1, URI_LIST_MAX), noDuplicates]),
```

- Each **row** has its validators (`required`, `redirectUri`: absolute http(s), no `#`, no `*`, no credentials,
  `http://` only for loopback hosts); the **array** has validators about the list (`listSize`, `noDuplicates`,
  [`sso-forms.ts`](../../apps/web/src/app/features/access/sso-forms.ts)) whose errors sit on the array and are shown
  under it.
- The template walks `@for (row of rows.controls; track row)` — track the control *object*, so removing row 1 keeps
  row 2's DOM, focus and text — and binds each input with `[formControl]="row"` (rows have no names).
- `push()` adds a row, `removeAt(i)` removes one; loading a view into the form first rebuilds the arrays to the right
  length, then `reset()`s (the role editor's `effect()` + `untracked()` pattern).
- The API's 422 errors name rows by index (`redirectUris.2` / `insecure_uri`), and `form.get('redirectUris.2')` finds
  that control. `ssoProblemToForm()` puts the *translated* message for a known contract code there instead of the
  API's English text.
- Every URI input is `dir="ltr"`: a URL stays left-to-right in the Arabic UI.

## 7. A parent route guarded by any of two permissions

`/access` used to need `access.read`. Applications needs `sso.read`, which a user may hold alone. So
([`access.routes.ts`](../../apps/web/src/app/features/access/access.routes.ts)):

- the parent in `app.routes.ts` asks for ANY of the two (`data: { permission: ['access.read', 'sso.read'] }`,
  chapter 12);
- every child carries its own `canMatch` (`users*`/`roles*` → `access.read`, `apps*` → `sso.read`, `apps/new` → also
  `sso.manage_apps`), and the table ends with `NOT_FOUND_ROUTE` so a refused child shows the 404 page instead of an
  empty outlet (chapter 05);
- `/access` itself redirects with a **redirect function** — `redirectTo: () => (inject(Session).can('access.read') ?
  'users' : 'apps')` — evaluated at navigation time in an injection context;
- the nav link (`app.ts`) uses a `visible` predicate (either permission) and `AccessNav` shows each tab with `*appCan`.

## 8. The rest

- **Tabs as a local signal** on the app page: `tab = linkedSignal({ source: this.id, computation: () => 'settings' })`
  — back to « Paramètres » when another app opens. Each panel exists only while selected (`@switch`), so the Users
  tab's request goes out the first time it is opened; the history panel is a `@defer (on viewport)` block around
  `<app-timeline [subject]="'sso_client:' + id">` (chapter 13).
- **Buttons from `_actions`**: rotate / disable / enable on the app, update / delete on each role, remove on each
  assignment. A role that is still assigned shows a *disabled* delete button with the reason as a tooltip on a
  wrapper (a disabled button gets no mouse events) and as screen-reader text.
- **A resource passed to a child**: the user page creates `GET /sso/assignments?userId=` and hands the
  `HttpResourceRef` to [`user-apps-section.ts`](../../apps/web/src/app/features/access/user-apps-section.ts), which
  reads `.value()` and calls `.reload()` after a write — while the page's history resolver uses the same answer to
  name app roles. One request, two readers.
- **`toSignal(control.valueChanges)`** in the same section: the role `<select>` is a `computed()` of "the app chosen in
  the other select", and the app list is a resource that only exists while the form is open
  (`clientsResource(this.adding)`).
- **Separation of duties in the UI**: nobody assigns an app role to themselves. The assign form lists your own row
  without a radio button; the user page hides « Attribuer »/« Retirer » on your own page. The API refuses anyway
  (409 `sso-assign-self`).
- **Timeline labels**: `sso_client:<id>` is a new audit subject; `audit.tables.sso_*`, `audit.fields.sso_client.*`
  (`secret_enc` → « Secret (masqué) ») and `audit.events.sso.*` name the rows and events, `assigned_by` /
  `disabled_by` are users, and an app role id is an opaque reference named by its code when the page knows it
  ([`timeline-view.ts`](../../apps/web/src/app/shared/timeline/timeline-view.ts)).
- **Tests**: [`sso-handoff.page.spec.ts`](../../apps/web/src/app/features/sso/sso-handoff.page.spec.ts) drives every
  state with `RouterTestingHarness` + `HttpTestingController` and a `PAGE_LOCATION` spy;
  [`apps.spec.ts`](../../apps/web/src/app/features/access/apps.spec.ts) covers the list, the secret panel (copy,
  checkbox gate, `canDeactivate` with a spied `window.confirm`), `_actions` and the tabs; `app.routes.spec.ts` checks
  that `/access/apps` opens for an `sso.read`-only user, every other refused URL is a 404, and `/sso/:uid` opens signed
  out.
