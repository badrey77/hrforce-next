# 20. Kiosks, timers, canvas and a flow that survives sign-in

See also: [05-routing.md](./05-routing.md) (routes, guards, `data`),
[13-pipes-defer-and-lists.md](./13-pipes-defer-and-lists.md) (`@defer`, pipes),
[14-big-forms-and-url-state.md](./14-big-forms-and-url-state.md) (URL as state),
[16-live-data-sse-and-signals.md](./16-live-data-sse-and-signals.md) (browser callbacks, `DestroyRef`),
[17-multi-step-ui-wizards-and-two-step-sign-in.md](./17-multi-step-ui-wizards-and-two-step-sign-in.md) (state machines).

The Attendance module (docs/contracts/attendance.md, ADR 009) brings screens unlike the rest of the app. A
**tablet at the entrance** shows a QR code that changes every 30 seconds and must run for days without anyone
touching it. An employee's **phone** opens a link from that code, often with an expired session, and must end with a
punch recorded at the time of the scan. This chapter walks through the Angular pieces that make this work:

1. [A route without the app chrome](#1-a-route-without-the-app-chrome) — route `data` read by the root component.
2. [Timers owned by a component](#2-timers-owned-by-a-component) — `setInterval`/`setTimeout`, signals, `DestroyRef`.
3. [A clock corrected against the server](#3-a-clock-corrected-against-the-server) — pure functions, `computed()`.
4. [Drawing on a canvas](#4-drawing-on-a-canvas) — `viewChild` + `afterRenderEffect`.
5. [Browser APIs behind services](#5-browser-apis-behind-services) — visibility, online, Wake Lock, Fullscreen.
6. [Two languages on one screen](#6-two-languages-on-one-screen) — `*transloco="let fr; lang: 'fr'"`.
7. [Reading and clearing the URL fragment](#7-reading-and-clearing-the-url-fragment) — the `fragment` observable, `replaceUrl`.
8. [A flow that survives a sign-in redirect](#8-a-flow-that-survives-a-sign-in-redirect) — state on the server, the way back in the URL.
9. [The rest of the module](#9-the-rest-of-the-module) — boards, team view, settings, the employee tab.
10. [The web app manifest](#10-the-web-app-manifest) — installable, no service worker.
11. [Testing time](#11-testing-time) — fake timers, `KIOSK_RELOAD`, canvas in jsdom.

## 1. A route without the app chrome

Every page of the app lives inside the shell of `src/app/app.html`: header, side nav, skip link. The kiosk must own
the whole screen. The route says so with **static route data**
([`src/app/app.routes.ts`](../../apps/web/src/app/app.routes.ts)):

```ts
{ path: 'kiosk', data: { chrome: false }, loadComponent: () => import('./features/kiosk/kiosk.page')… }
```

`data` is a bag of values attached to a route config. Guards read it (`permissionGuard()` reads `data.permission`,
chapter 12); components inside the route read it through `ActivatedRoute.data`. The **root** component is not inside
any route, so it listens to the router instead ([`src/app/app.ts`](../../apps/web/src/app/app.ts)):

```ts
protected readonly chrome = toSignal(
  this.router.events.pipe(
    filter((event) => event instanceof NavigationEnd),
    map(() => chromeOf(this.router.routerState.snapshot.root)),
  ),
  { initialValue: true },
);
```

`chromeOf()` walks from the root route down `firstChild` links (the active branch of the route tree) and returns
`false` if any level has `chrome: false`. The template wraps the header and the nav in `@if (chrome())`.

Why not a "layout route" (a parent component holding the chrome, every page nested under it)? It is the classic
answer, and the right one when several layouts exist. Here there is ONE exception; moving thirty routes one level down
for it would cost more than a flag.

The route has **no guard** at all: the tablet is a paired *device*, never a signed-in user. Its credential is an
`httpOnly` cookie scoped to `/api/kiosk`, so the refresh interceptor must not treat a `/api/kiosk/*` 401 as an expired
session ([`core/auth/auth-refresh.interceptor.ts`](../../apps/web/src/app/core/auth/auth-refresh.interceptor.ts),
`isRefreshable`). A 401 there means "not paired", and the kiosk shows its pairing form.

## 2. Timers owned by a component

[`features/kiosk/kiosk.page.ts`](../../apps/web/src/app/features/kiosk/kiosk.page.ts) runs four timers:

| Timer | Kind | Why |
|---|---|---|
| tick | `setInterval(500 ms)` | writes `now` — the clock, the countdown, the window choice all derive from it |
| next fetch | `setTimeout`, re-armed after each answer | at the start of the next 30 s window + 1–3 s random jitter |
| retry | `setTimeout(5 s / 30 s)` | while the server is unreachable / the network is refused |
| renew | `setInterval(24 h)` | `GET /api/kiosk/session` renews the 400-day device cookie |

Two rules keep this safe on a page that runs for days:

- **One place to clean up.** Every id is kept in a field and ONE `inject(DestroyRef).onDestroy(() => …)` clears them
  all. `DestroyRef` is the component's "I am being destroyed" hook as an injectable object; unlike `ngOnDestroy` it can
  be registered from anywhere in the constructor, next to the code that needs it.
- **HTTP answers die with the page too.** `this.api.qr().pipe(takeUntilDestroyed(this.destroyRef))`: a response that
  arrives after the page is gone would otherwise call `setTimeout` again and bring a timer back to life. (The unit
  test that destroys and re-creates the page caught exactly that.)

The tick only **writes a signal**. Everything visible is `computed()` from it:

```ts
private readonly now = signal(Date.now());
protected readonly corrected = computed(() => this.now() + this.offset());
protected readonly current = computed(() => activeWindow(this.windows(), this.corrected()));
protected readonly clock = computed(() => algiersClock(this.corrected()));
```

Zoneless change detection re-renders what reads those signals twice a second — the clock text and a thin bar. The QR
canvas reads `current().qr`, which changes only every 30 s, so it is not redrawn on each tick (section 4).

Why plain timers and not RxJS `interval()`/`timer()`? Both work (the presence board uses `interval(60_000)` with
`takeUntilDestroyed()`). The kiosk's schedule changes after every answer; "clear the old timeout, set a new one" reads
more plainly than a re-subscribed Observable chain. Pick whichever makes the schedule obvious.

## 3. A clock corrected against the server

The tablet's own clock may be minutes off, and it decides nothing: the server signs the codes and says when each one
is valid. The kiosk measures the difference on every answer, like NTP:

```ts
offset = serverTime − (t_send + t_receive) / 2
```

and shows the window whose `[showFrom, showUntil)` contains `Date.now() + offset`. The arithmetic lives in
[`features/kiosk/kiosk-clock.ts`](../../apps/web/src/app/features/kiosk/kiosk-clock.ts) as **pure functions**
(`measureOffset`, `activeWindow`, `nextFetchDelay`, `algiersClock`, `inReloadSlot`), tested with fixed numbers in
`kiosk-clock.spec.ts`. The component only wires them to signals and timers. This split — decisions in plain
TypeScript, Angular only for state and rendering — is what makes a time-driven screen testable.

The clock is shown in Algiers time (UTC+1, no daylight saving) by adding one hour to the corrected UTC instant, not with
the tablet's time zone setting. When the held windows run out (the network was down for two minutes), `current()`
becomes `null` and the page shows the offline message instead of a code that would fail.

## 4. Drawing on a canvas

[`features/kiosk/qr-canvas.ts`](../../apps/web/src/app/features/kiosk/qr-canvas.ts):

```ts
private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

constructor() {
  afterRenderEffect(() => {
    this.resized();                         // bumped by (window:resize)
    const text = this.text();               // the input: a new URL every 30 s
    const element = this.canvas().nativeElement;
    … element.width = pixels; drawQr(element.getContext('2d'), qrMatrix(text), pixels);
  });
}
```

- **`viewChild.required('canvas')`** is a signal query for `<canvas #canvas>` in the template.
- **`afterRenderEffect()`** runs after Angular has written the DOM, so the element exists and has its CSS size
  (`clientWidth`) — a plain `effect()` might run before. Like `effect()`, it re-runs only when a signal it read
  changes: the text or the resize counter. It is the canvas equivalent of "useLayoutEffect with dependencies".
- **`host: { '(window:resize)': 'resized.update((n) => n + 1)' }`** listens on a global target and is removed with the
  component.
- The drawing itself (`drawQr`) is a pure function over a 2D context; the encoder (`qrcode-generator`, MIT, plain JS —
  the CSP allows no `eval` and no WebAssembly) only gives the module matrix. Each module is a whole number of device
  pixels, black on white whatever the theme, inside a 4-module white quiet zone.

The encoder is imported only by the kiosk, so the build puts it in the kiosk's lazy chunk (`kiosk-page`, ~37 kB):
nobody else downloads it.

## 5. Browser APIs behind services

Two small services wrap the browser APIs this module needs:

- [`core/browser/page-activity.ts`](../../apps/web/src/app/core/browser/page-activity.ts) (root) turns
  `visibilitychange` and `online`/`offline` into **state** (`visible()`, `online()` signals) and **events**
  (`shown$`, `reconnected$` Observables). State is for "is it true now?" — the board refreshes only while
  `visible()`. Events are for "it just happened" — Pointage and the kiosk reload when the tab comes back. An `effect()`
  on `visible()` would also fire once at creation and need a "previous value" to see the transition; the stream says
  exactly what happened (chapter 16 made the same split for notifications).
- [`core/browser/screen-wake.ts`](../../apps/web/src/app/core/browser/screen-wake.ts) (component-scoped:
  `providers: [ScreenWake]` on the kiosk) keeps the screen on. Browser rules shape it: `requestFullscreen()` needs a
  **user gesture**, so `start()` runs from the "Plein écran" button's `(click)`; the wake lock is **released whenever
  the page is hidden**, so the service asks again on `shown$`; every API is feature-detected and every failure
  swallowed — an old tablet without Wake Lock still shows codes. Provided on the component, its `DestroyRef` is the
  component's: leaving the kiosk page releases the lock.

Neither API needs a CSP or `Permissions-Policy` change (they default to `self`); the camera and geolocation stay
forbidden for the whole app (ADR 009 explains why the phone uses its native camera instead).

## 6. Two languages on one screen

The entrance serves everyone, whatever the UI language: the instruction and the offline message appear in French AND
Arabic ([`kiosk.page.html`](../../apps/web/src/app/features/kiosk/kiosk.page.html)):

```html
<p *transloco="let fr; lang: 'fr'" lang="fr" dir="ltr">{{ fr('attendance.kiosk.instruction') }}</p>
<p *transloco="let ar; lang: 'ar'" lang="ar" dir="rtl">{{ ar('attendance.kiosk.instruction') }}</p>
```

The `lang` input of the Transloco structural directive binds that template's translate function to one language (the
file is loaded if needed), independently of `LanguageService`. Each block also sets `lang` and `dir`, so the browser
shapes Arabic correctly and aligns each block on its own side, and the stylesheet picks each script's font. The
offline block appears in two branches of the `@switch`, so it is an `<ng-template #offline>` stamped with
`*ngTemplateOutlet`.

## 7. Reading and clearing the URL fragment

The QR code encodes `https://<domain>/punch#<token>`. The token sits in the **fragment** on purpose: browsers never send
it to the server, so it appears in no access log and no Referer. The router parses it anyway
([`features/punch/punch.page.ts`](../../apps/web/src/app/features/punch/punch.page.ts)):

```ts
let landing = true;
this.route.fragment.pipe(takeUntilDestroyed()).subscribe((fragment) => {   // "<token>" or null
  if (landing || fragment) void this.start(fragment);
  landing = false;
});
// in start(): drop the token
await this.router.navigate([], { relativeTo: this.route, replaceUrl: true });
```

The navigation to "this route, without a fragment" rewrites the address bar with `history.replaceState` (no new
history entry: Back does not return to the token) **and** updates `router.url`. Calling `history.replaceState`
yourself would leave the router believing the URL is still `/punch#<token>` — and the refresh interceptor builds its
`returnUrl` from `router.url`, which would put a used token back in the address bar after sign-in. Same route config,
same component: the router reuses the instance and the constructor does not run twice.

That reuse is why the page **subscribes** to `route.fragment` instead of reading `route.snapshot.fragment` once. When
the phone opens the next code (the evening departure) while the app is still showing `/punch`, only the fragment
changes: the browser does a same-document navigation, nothing reloads, and a snapshot read in the constructor would
never see the new token — the page would keep showing the morning's arrival and record nothing. `route.fragment` emits
the current value at once and then every change; the `null` it emits after the token is dropped is ignored.
(Found by the verification: a same-page second scan did nothing before this change.)

## 8. A flow that survives a sign-in redirect

The phone's session has usually expired overnight. The flow is:

1. `POST /api/attendance/scan {token}` — public; the server answers with the entrance's name and sets a **scan
   receipt** cookie (`httpOnly`: the page never sees it), valid 2 minutes since the 2026-09-30 mitigation (5 before);
2. no session? `router.navigate(['/login'], { queryParams: { returnUrl: '/punch' } })` — the login page says why
   (`auth.login.forPunch`) and, after the password and the TOTP code, navigates to the validated `returnUrl`;
3. back on `/punch`, **without a token**: `GET /api/me/attendance/receipt` tells what redeeming would record
   (entrance, time, arrival or departure, already recorded?) without redeeming it, and the page ASKS « Enregistrer mon
   arrivée à <entrée> ? » with one large button (see
   [chapter 21 §1](./21-corrections-reports-and-a-one-tap-confirmation.md#1-a-one-tap-confirmation));
4. only that tap sends `POST /api/me/attendance/punches`, which redeems the receipt; the punch's time is the scan's
   time.

Nothing is held in the browser between 1 and 3: the server holds the state (the receipt), the URL holds the way back,
and the receipt route gives the page everything the question needs after the round trip. A component signal or a
root service would not survive a full page load (a password manager, an iPhone switching apps); a cookie, a query
parameter and a read-only endpoint do. The route has **no guard** — a guard would send the phone to `/login` before
step 1 and lose the scan time. The steps depend on each other, so the page uses `async`/`await` with
`firstValueFrom()` and publishes one `state` signal (a discriminated union: working / confirm / done / problem) that the
template `@switch`es on (chapter 17): working → confirm → working → done, or problem.

## 9. The rest of the module

Everything else reuses patterns from earlier chapters:

| Screen | File | Patterns |
|---|---|---|
| Pointage (`/me/attendance`) | `features/my-attendance/my-attendance.page.ts` | two resources of one endpoint with different keys (today = API default, the month = a range); a month navigator as a signal; refresh on `shown$` |
| Presence board (`/attendance`) | `features/attendance/presence-board.page.ts` | URL as state (chapter 14); `interval()` + `visible()` for a 60 s refresh; `?date` absent = today; an input aliased (`alias: 'sort'`) |
| Mon équipe (`/me/team`) | `features/my-team/my-team.page.ts` | the same layout with fewer inputs — `withComponentInputBinding()` ignores query params the page does not declare |
| Shared table | `shared/attendance/presence-table.ts` | one markup: a table on desktop, cards under 640 px (`data-label` + `::before`), explicit ARIA roles; `[routerLink]` + `[queryParams]` to `/employees/<id>?tab=attendance&date=…` |
| Employee Présence tab | `features/employees/employee-attendance-tab.ts` | an input as the start of local state (`linkedSignal` of `date`); dialogs with a required reason; server `canManage` / `_actions` |
| Settings | `features/attendance/settings.page.ts` and sections | tabs as a `linkedSignal`; a `FormArray` week passed to a child editor (`week-form.ts`, `week-editor.ts`); one control shared by three pickers (`assignments-settings.ts`); a countdown signal for the pairing code (`kiosks-settings.ts`) |
| Field errors | `shared/attendance/attendance-forms.ts` | 422 field codes → translated keys, with a control alias (`target.id` → `targetId`) |

The employee detail page now accepts `?tab=` and `?date=`: its `tab` input is declared as
`input(undefined, { alias: 'tab' })` because `tab` already names the local tab signal —
`withComponentInputBinding()` binds by the public (aliased) name.

## 10. The web app manifest

Employees add HRForce to their phone's home screen, and the entrance code opens it. That needs a **web app manifest**
([`public/manifest.webmanifest`](../../apps/web/public/manifest.webmanifest)), linked from `src/index.html` with a
`theme-color` and an `apple-touch-icon`. The icons live in `public/icons/` (192, 512 and a maskable 512 whose drawing
stays inside the central 80 % safe zone, so round or squircle launcher masks never cut it).

There is deliberately **no service worker**: nothing authenticated must be cached on shared or lost phones, and a
stale cached release is a support problem we do not need. Current Chrome on Android installs from the manifest alone.
Angular's `@angular/service-worker` would be the tool if offline pages were ever wanted — the contract says they are
not.

## 11. Testing time

- **Fake timers** (`vi.useFakeTimers({ now, toFake: ['setTimeout', 'setInterval', 'Date', …] })`) make the kiosk
  deterministic: `vi.advanceTimersByTime(15_000)` moves to the next window; `Math.random` is stubbed so the jitter is
  1 s. See [`kiosk.page.spec.ts`](../../apps/web/src/app/features/kiosk/kiosk.page.spec.ts).
- **An `InjectionToken` with a default factory** (`KIOSK_RELOAD`) replaces `location.reload()` with a spy — the daily
  03:00 reload is tested without reloading the test runner.
- **jsdom has no 2D canvas**: the page spec stubs `getContext` to `null`, and the drawing is tested on a recording
  context in `qr-canvas.spec.ts` (white square, whole-pixel modules, quiet zone, version 7 for a 112-character URL).
- **The fragment flow** runs through `RouterTestingHarness`: `navigateByUrl('/punch#tok')`, then
  `expect(router.url).toBe('/punch')` before the scan request is answered, then `http.expectNone(…/punches)` — the
  link alone records nothing — and a click on the confirmation button before `expectOne(…/punches)`
  ([`punch.page.spec.ts`](../../apps/web/src/app/features/punch/punch.page.spec.ts)). The verifier's "new fragment
  while `/punch` is open" test now expects a second question (focused) and a second tap.
