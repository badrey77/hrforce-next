# 11. App initializers and the sign-in flow

See also: [03-signals-and-state.md](./03-signals-and-state.md) for the `Session` store,
[05-routing.md](./05-routing.md) for the guards, [06-http-and-errors.md](./06-http-and-errors.md)
for the refresh interceptor, [07-forms.md](./07-forms.md) for the password form.

This chapter follows one person through the Identity slice
([`docs/contracts/identity.md`](../contracts/identity.md) › Web), from first load to sign
out, and names the Angular feature at each step. It starts with the one concept not
covered elsewhere: **app initializers**.

## `provideAppInitializer()`

```ts
// src/app/app.config.ts
// App initializers run in parallel and bootstrap waits for all of them (see core/auth/session-init.ts).
provideAppInitializer(() => inject(LanguageService).init()),
// csrf THEN /api/me, before the first navigation, so the guards know who is signed in.
provideAppInitializer(initializeSession),
```

`provideAppInitializer(fn)` (from `@angular/core`, the functional replacement for the
old `APP_INITIALIZER` multi-provider token) registers a function that Angular runs while
bootstrapping:

- **It runs in an injection context**, so `inject()` works inside it (chapter 04).
- **If it returns a Promise or an Observable, bootstrap waits.** The root component is
  not created and the router's initial navigation does not start until every initializer
  has settled.
- **Initializers run in parallel.** Angular calls each registered function in turn
  without waiting, then waits for all of them together. There is no "run after the other
  one". The language initializer and the session initializer therefore run side by side,
  and an ordering that matters (csrf **then** me) must live *inside* one initializer.
- **A rejected initializer fails the whole bootstrap**: a blank page. Both initializers
  here swallow their errors on purpose (a missing translation file falls back to `fr`,
  an unreachable API means "signed out").

### The session initializer

```ts
// src/app/core/auth/session-init.ts
export async function initializeSession(): Promise<void> {
  const api = inject(AuthApi);
  const session = inject(Session);
  const language = inject(LanguageService);

  try {
    await firstValueFrom(api.csrf());
  } catch {
    // Unreachable API: carry on signed out; /api/me will fail the same way.
  }
  await session.load();

  const user = session.user();
  if (user) {
    language.applyAccountLocale(user.locale);
  }
}
```

- **Every `inject()` comes before the first `await`.** The injection context lasts only
  for the synchronous part of the function. After an `await`, the code runs in a later
  microtask and `inject()` would throw `NG0203`. The same rule applies to interceptors
  (chapter 06) and guards.
- **Why csrf first.** Angular's XSRF support only *copies* an existing `XSRF-TOKEN`
  cookie into the `X-XSRF-TOKEN` header, on same-origin non-GET requests (chapter 06).
  It never asks the server for one. On a first visit there is no cookie, so the login
  POST would go out without the header and the API would answer 403 `xsrf`.
  `GET /api/auth/csrf` is a GET, so it needs no token itself, and it makes the API set
  the cookie.
- **Why before the first navigation.** The guards read `Session.isAuthenticated()`
  synchronously. Without the initializer, a reload of `/organization` would be judged
  "signed out" before `/api/me` answered, and the user would bounce to /login.
- **`firstValueFrom()`** turns the one-shot HTTP Observable into a Promise for `await`.

`session-init.spec.ts` checks the order: `expectOne('/api/auth/csrf')`, then
`expectNone('/api/me')` while csrf is pending, then flush, then `expectOne('/api/me')`.

## The flow, step by step

| Step | What happens | Angular feature | File |
|---|---|---|---|
| 1. First load | `GET /api/auth/csrf` → `XSRF-TOKEN` cookie; `GET /api/me` → 401 → refresh → 401 → signed out (no redirect: `SKIP_LOGIN_REDIRECT`) | app initializer, `HttpContextToken` | `core/auth/session-init.ts`, `core/auth/auth-api.ts` |
| 2. Visit `/organization` | `authGuard` → `UrlTree` `/login?returnUrl=%2Forganization`; the Organization chunk is **not** downloaded | `CanMatchFn`, `UrlTree` | `core/auth/auth.guards.ts` |
| 3. Sign in | `POST /api/auth/login` (with `X-XSRF-TOKEN`) → 204 + cookies; `GET /api/me` → `Session.set`; account locale applied unless chosen on this device; `navigateByUrl(safeReturnUrl(returnUrl))` | reactive form, signal input from query param, `async` handler | `features/auth/login.page.ts`, `core/auth/return-url.ts` |
| 4. Shell updates | Nav appears; header shows "Amina Benali · Groupe Démo" and "Sign out" | root signal store read in templates | `app.html`, `shell/user-menu.ts` |
| 5. 15 min later | Three calls → 401 ×3 → **one** `POST /api/auth/refresh` → each retried once (XSRF re-stamped) | interceptor order, `share()`, `HttpXsrfTokenExtractor` | `core/auth/auth-refresh.interceptor.ts` |
| 6. Refresh expired | refresh → 401 → `Session.clear()` → `/login?returnUrl=<page>` | `Router.navigate` from an interceptor | same |
| 7. Sign out | `POST /api/auth/logout` → `clear()` → `/login` | `(click)` handler | `shell/user-menu.ts` |
| 8. Emailed link | `/password/setup?token=…` (no guard); group validator for confirm; 422 codes translated; 410 → link to `/password/forgot` | FormGroup validator, `@switch` | `features/auth/password-setup.page.ts` |

Error messages at step 3 come from the problem `status`. 401 means invalid credentials.
423 (email throttle) and 429 (IP throttle) show "try again in {{minutes}} min", with the
minutes rounded up from the `Retry-After` header, which `retryAfterSeconds()` reads from
the `HttpErrorResponse` kept as the error's `cause`. 403 means account disabled, unless
the problem type is `xsrf`.

## What the web deliberately does not do

- **Read any token.** Both tokens are httpOnly cookies (ADR 004). The web knows only
  "signed in or not", from `/api/me`.
- **Decide expiry.** It never guesses when the access token expires. It reacts to the
  401.
- **Refresh proactively on a timer.** Refreshing on demand is enough, and it avoids
  extra rotations from tabs left open in the background.

## Next

[10-project-structure-and-recipes.md](./10-project-structure-and-recipes.md) ›
"Recipe: protect a route" and "Recipe: an API call that must not redirect to login".

Then [12-permission-aware-ui.md](./12-permission-aware-ui.md): what the session's
`permissions` and `scopes` from `/api/me` drive once the user is signed in.

## Two-step sign-in

Since the MFA slice, `POST /auth/login` may answer 200 `{mfaRequired: true}` instead of 204; the login page then
shows a code step and calls `POST /auth/mfa/verify` before `Session.load()`. `/api/me` gained `mfa: {enabled,
required, recoveryCodesLeft}`, read by `Session.mfa()` / `Session.mfaEnrollmentRequired()`. See
[chapter 17](./17-multi-step-ui-wizards-and-two-step-sign-in.md).
