# 16. Live data: Server-Sent Events and signals

See also: [03-signals-and-state.md](./03-signals-and-state.md) (signals, `effect()`, zoneless),
[06-http-and-errors.md](./06-http-and-errors.md) (interceptors, the refresh flow),
[11-app-initializers-and-auth-flow.md](./11-app-initializers-and-auth-flow.md) (the session),
[15-workflows-in-the-ui.md](./15-workflows-in-the-ui.md) (polling vs events for the task badge).

Chapter 15 ended with: "If approvals become second-critical, the answer is a server push, not a
faster poll." The notifications slice (docs/contracts/notifications.md) is that push. The API
streams events over **Server-Sent Events** (fed by Postgres `LISTEN/NOTIFY`), and the web keeps a
header bell, the task badge and the My leave page up to date without the user clicking.

This chapter follows one event from the socket to the pixels:

1. [Choosing the channel](#1-choosing-the-channel-eventsource-vs-websocket-vs-polling) — EventSource vs WebSocket vs polling.
2. [A root service that owns a connection](#2-a-root-service-that-owns-a-connection) — `effect()` on the session, `DestroyRef`.
3. [Browser callbacks, zoneless](#3-browser-callbacks-in-a-zoneless-app) — why setting a signal is all it takes.
4. [Auth: the stream the interceptors never see](#4-auth-the-stream-the-interceptors-never-see) — renew, then reconnect.
5. [Backoff and fallback](#5-backoff-and-fallback) — being a good citizen when the server is down.
6. [Events vs state: a Subject next to the signals](#6-events-vs-state-a-subject-next-to-the-signals) — who reacts to what.
7. [The bell](#7-the-bell-a-disclosure-with-deferred-content) — disclosure vs `popover`, focus, `UrlTree` links, `@defer (when …)`.
8. [Links into pages](#8-links-into-pages-query-params-as-entry-points) — `?task=`, `?request=`, `afterRenderEffect`.
9. [Testing a live connection](#9-testing-a-live-connection) — `InjectionToken` + a fake EventSource.

## 1. Choosing the channel: EventSource vs WebSocket vs polling

| | Polling (`interval` + GET) | WebSocket | **Server-Sent Events (chosen)** |
|---|---|---|---|
| Direction | client asks | both ways | server → client |
| Latency | up to one period | instant | instant |
| Idle cost | one request per tab per period | one open socket | one open HTTP response |
| Infra | nothing new | upgrade handshake, own framing, proxy config | plain HTTP `text/event-stream`; proxy must not buffer |
| Auth | cookies + interceptors | cookies at the handshake | cookies (same origin), **no interceptors** (§4) |
| Reconnect | n/a | write it yourself | built in (we take it over, §5) |

The web never needs to *send* on this channel — marking as read is an ordinary `POST` — so
a WebSocket's second direction would be unused complexity. SSE is plain HTTP, served by the
API from Postgres alone (ADR 005: no broker). The browser API is tiny:

```ts
const source = new EventSource('/api/me/notifications/stream');
source.addEventListener('unread', (e) => console.log(JSON.parse(e.data).count));
source.addEventListener('error', () => { /* network, 401, server restart… */ });
source.close();
```

The server writes `event: unread\ndata: {"count":3}\n\n`; each named event reaches the
listener registered for that name.

## 2. A root service that owns a connection

`core/notifications/notification-center.ts` is a root signal store like `Session` or
`TasksBadge`: private writable signals, public read-only views.

```ts
private readonly unread = signal<number | null>(null);
readonly unreadCount = computed(() => this.unread() ?? 0);
readonly latest = this.items.asReadonly();
readonly status = this.state.asReadonly();   // 'off' | 'connecting' | 'live' | 'retrying' | 'fallback'
```

**The connection exists only while signed in.** Instead of asking the login page and the
logout button to start and stop it, the service *reacts to the session*:

```ts
private readonly sessionKey = computed(() => {
  const user = this.session.user();
  const company = this.session.company();
  return user && company ? `${user.id}@${company.id}` : null;
});

constructor() {
  effect(() => {
    const key = this.sessionKey();
    untracked(() => {
      this.stop();
      if (key) this.start();
    });
  });
  inject(DestroyRef).onDestroy(() => this.stop());
}
```

- **Why an `effect()` here** when chapter 03 says "don't use effects for state"? Because this
  is not state: it is a *side effect outside the signal graph* — a network connection.
  Sign-in, sign-out, a failed token refresh that clears the session, a company switch: every
  path goes through the Session signal, so every path opens or closes the stream.
- **`untracked()`**: `start()` reads other signals (the session again, the state). Without
  `untracked`, those reads would become dependencies of the effect and could restart the
  connection for the wrong reasons. Only `sessionKey` drives it — and because it is a
  `computed()` of a *string*, a `/api/me` reload with the same user does not reconnect
  (equal strings do not notify).
- **`DestroyRef`**: root services live as long as the app, but tests create and destroy app
  injectors constantly. `onDestroy` closes the EventSource and clears the retry timer. The
  effect and `takeUntilDestroyed()` subscriptions clean themselves up the same way.
- **A generation counter** protects against late callbacks: every `start()`/`stop()` bumps it,
  and an HTTP answer or timer from an older generation is ignored instead of resurrecting the
  previous user's data after a sign-out.

## 3. Browser callbacks in a zoneless app

EventSource listeners and `setTimeout` callbacks run outside anything Angular started. In a
zone.js app, Angular found out about them by monkey-patching every async browser API, and
code sometimes had to call `NgZone.run()` to "re-enter the zone" so the view would update.

This app has no zone.js (chapter 01). A component re-renders because **its template read a
signal that was later set**. So this is all there is:

```ts
source.addEventListener('unread', (event) => {
  const body = parseData(event) as { count?: unknown } | undefined;
  if (typeof body?.count === 'number') this.unread.set(body.count);   // the bell re-renders
});
```

No `NgZone`, no `ChangeDetectorRef.markForCheck()`. The rule generalises: **update state
through signals, and it does not matter which callback you are in** — a WebSocket message, a
`BroadcastChannel`, a `ResizeObserver`, a third-party SDK's callback.

## 4. Auth: the stream the interceptors never see

`new EventSource(url)` is a browser API: the browser opens (and re-opens) the connection
itself. Angular's `HttpClient` never sees it, so **none of our interceptors run** — no XSRF
header (fine: it is a GET), no problem parsing, and crucially no *401 → refresh → retry*
(core/auth/auth-refresh.interceptor.ts). The session cookie is still sent (same origin), but
when the 15-minute access cookie expires the server ends the stream, and the browser's own
retry would present the same expired cookie forever.

So on `error` the center closes the EventSource itself and, before reconnecting, makes one
**ordinary** request through `HttpClient`:

```ts
private renewThenConnect(generation: number): void {
  this.api.unreadCount().subscribe({          // GET /me/notifications/unread-count
    next: (body) => {
      if (generation !== this.generation) return;
      this.unread.set(body.count);            // also catches up on what we missed
      this.connect();                         // the new EventSource carries the renewed cookie
    },
    error: () => { /* refresh failed → session cleared → the effect stops us; else retry later */ },
  });
}
```

If the cookie had expired, that GET gets a 401, the refresh interceptor renews the session
(single-flight, shared with any other request in flight), retries, and succeeds. The test
`on error: closes, backs off, renews the session…` in
`core/notifications/notification-center.spec.ts` plays exactly this: 401 → `POST
/api/auth/refresh` → retried count → *then* a new EventSource.

(`EventSource` also cannot send custom headers. If a future API needed a bearer token, the
options would be a cookie, a short-lived ticket in the URL, or a `fetch()`-based SSE reader —
which *would* go through `HttpClient`'s interceptors if built on it.)

## 5. Backoff and fallback

When the API restarts, every open tab loses its stream at the same moment. Reconnecting
immediately would hammer it just as it comes back. The center waits longer after each
consecutive failure — `STREAM_BACKOFF_MS = [1 s, 2 s, 5 s, 15 s, 30 s]`, capped — and an
`open` event resets the ladder.

After `MAX_STREAM_FAILURES` (5) failures in a row, it stops trying and switches to
`status() === 'fallback'`: the same **refresh-on-visibility** that TasksBadge uses (chapter
15 §3) — when the tab becomes visible again, re-read the count and the list over HTTP, and try
the stream once more. A browser without `EventSource` (and jsdom, in unit tests) starts in
that mode. The bell and the page show a short "live updates unavailable" note while in it.

| State | What happens | How it ends |
|---|---|---|
| `connecting` | first EventSource open | `open` → `live`, `error` → `retrying` |
| `live` | events update signals | `error` → `retrying` |
| `retrying` | timer (backoff), then renew + reconnect | `open` → `live`; 5th failure → `fallback` |
| `fallback` | refresh on `visibilitychange` + one attempt | `open` → `live` |
| `off` | signed out | sign-in → `connecting` |

## 6. Events vs state: a Subject next to the signals

Two things arrive on the stream:

- **State**: "you have 3 unread" — a signal (`unreadCount`). Whoever reads it later sees the
  current value; two quick updates collapse into the last one, which is exactly right.
- **Events**: "a task was assigned", then "a leave was approved" 2 ms later. The task badge
  must refresh on the first, My leave on the second. A signal would lose one of them (two
  writes before the readers run → only the last is observed) and would hand a stale event to
  anyone who reads it later. An RxJS **`Subject`** delivers *every* `next()` to every
  subscriber, in order, and replays nothing.

So `core/notifications/notification-events.ts` is a tiny bus:

```ts
@Injectable({ providedIn: 'root' })
export class NotificationEvents {
  private readonly subject = new Subject<NotificationEvent>();
  readonly events$ = this.subject.asObservable();
  of(accept: (type: string) => boolean) { return this.events$.pipe(filter((e) => accept(e.type))); }
  emit(event: NotificationEvent) { this.subject.next(event); }
}
```

It is a **separate service** on purpose: injecting `NotificationCenter` *creates* it, and
creating it opens the stream. `TasksBadge` must not open a connection just by being injected
(its own tests would suddenly need a fake EventSource), and core/tasks must not import the
center. With the bus, the dependencies point one way: center → bus ← listeners.

Listeners subscribe in their injection context with `takeUntilDestroyed()`:

```ts
// core/tasks/tasks-badge.ts — for the life of the app
inject(NotificationEvents).of((t) => t.startsWith('task.') || t === 'leave.cancelled')
  .pipe(takeUntilDestroyed()).subscribe(() => this.refresh());

// features/my-leave/my-leave.page.ts — only while the page is open
inject(NotificationEvents).of((t) => t.startsWith('leave.'))
  .pipe(takeUntilDestroyed()).subscribe(() => { this.balances.reload(); this.requests.reload(); });
```

"Reload My leave *if it is open*" needs no `if`: the page's subscription only exists while the
page does.

## 7. The bell: a disclosure with deferred content

`shell/notification-bell.ts`:

- **Disclosure, not `popover` (yet).** The native `popover` attribute gives top-layer rendering
  and light-dismiss for free. Placing it under the bell, though, needs CSS anchor positioning,
  which not all our users' browsers have, and jsdom supports neither. A disclosure — a
  `<button aria-expanded aria-controls>` and a panel shown by `@if` — works everywhere and is
  keyboard-accessible by default. Its placement is `position: absolute; inset-inline-end: 0`:
  the panel hangs from the bell's *end* edge, which is the right edge in French and the left
  edge in Arabic, with no RTL rule. We add what `popover` would have given: `(keydown.escape)`
  closes and returns focus to the bell; `(document:click)` and `(focusout)` outside close it.
- **Accessible count**: the number is `aria-hidden`; the button's name says "Notifications, 3
  non lue(s)"; an always-present `aria-live="polite"` paragraph announces changes (chapter 15
  §2 explains why it must exist before its text).
- **Links with query strings**: a notification's `link` is `/tasks?task=…`. A string given to
  `routerLink` is split into *path segments* (the `?` would be encoded into the path), so each
  link is parsed once with `router.parseUrl()` into a **`UrlTree`**, which `routerLink` accepts
  as is, inside a `computed()` (a new tree per change detection would re-set the link every
  time). `safeAppLink()` first rejects anything that is not an in-app path (`//host`,
  `https:`, `javascript:`).
- **`@defer (when open(); prefetch on idle)`** wraps the `@if (open())` panel. The sentence
  component, the relative-time pipe and the fr/ar-DZ locale data are not in the main bundle:
  `prefetch on idle` downloads them when the browser is idle; `when open()` renders the block
  the first time the dropdown opens (a `when` trigger fires once). The `@defer` must be
  *outside* the `@if`: inside it, the block would not exist before the first opening and
  could not prefetch — the compiler says so (NG8021).
- **Focus into a panel that appears later**: `afterNextRender` runs after exactly one render,
  but the first time the panel appears only once the deferred chunk has loaded, several
  renders later. An **`afterRenderEffect()`** that reads the `panelTitle` view query re-runs
  when the query starts returning the element, and focuses it once.
- **Relative time** (`shared/relative-time/relative-time.pipe.ts`) is a *pure* pipe that
  takes `now` as an argument; the bell sets `now` when it opens. The text is as fresh as the
  host decides, without a timer per row or an impure pipe. It uses `Intl.RelativeTimeFormat`
  (Angular locale data has no relative-time patterns) with the same locale ids as `DatePipe`.
- **Sentences** are `notifications.types.<type>` keys filled from `data`
  (`shared/notifications/notification-message.ts`, a pure function): the leave type *code* is
  named by `LeaveCatalog.nameOfCode()`, dates and day counts are formatted in the UI language,
  missing data shows "…", and an unknown type falls back to a generic sentence.

## 8. Links into pages: query params as entry points

Notifications and emails link to `/tasks?task=<id>` and `/me/leave?request=<id>`. With
`withComponentInputBinding()` (chapter 05), a query param arrives as an input:

```ts
// features/tasks/tasks.page.ts
readonly task = input<string | undefined>();
protected readonly selectedId = linkedSignal<string | undefined, string | null>({
  source: this.task,
  computation: (id) => id ?? null,
});
```

`linkedSignal` follows the link (also when a second notification is clicked while the page is
open — same component, new input) while clicks on other rows still override it. The URL is
not rewritten on every click: the param says where to *start*. When the linked task is no
longer open, the page says so.

My leave highlights and scrolls to the request. Scrolling needs the row to exist in the DOM,
so it runs in **`afterRenderEffect()`** — an effect that runs *after* Angular has rendered:

```ts
afterRenderEffect(() => {
  const id = this.highlighted();                 // computed: the id once it is in the loaded list
  if (!id || id === this.scrolledTo) return;
  const row = /* find [data-request=id] */;
  if (!row) return;
  this.scrolledTo = id;                          // a later reload does not yank the page back
  row.scrollIntoView?.({ block: 'center' });
  row.focus({ preventScroll: true });            // tabindex="-1" on the highlighted row
});
```

A plain `effect()` could run before the `@for` has created the row.

## 9. Testing a live connection

The center never calls `new EventSource()`. It injects a factory:

```ts
// core/notifications/event-source.ts
export const EVENT_SOURCE_FACTORY = new InjectionToken<EventSourceFactory>('EVENT_SOURCE_FACTORY', {
  providedIn: 'root',
  factory: () => (url) => (typeof EventSource === 'undefined' ? null : new EventSource(url)),
});
```

- An **`InjectionToken`** gives a DI identity to something that is not a class (a function
  type has no runtime identity). `providedIn: 'root'` + `factory` is the default provider, so
  app.config.ts registers nothing.
- The spec swaps it: `{ provide: EVENT_SOURCE_FACTORY, useValue: fake.factory }`
  (`src/testing/fake-event-source.ts`). The test plays the server — `open()`, `send('unread',
  {count: 5})`, `fail()` — synchronously, and `vi.useFakeTimers()` steps through the backoff.
- The center depends on `EventSourceLike` (`addEventListener`, `close`), not the full DOM
  type, so the fake is 30 lines.

What `notification-center.spec.ts` checks, one test each: no connection while signed out;
count and list on sign-in; `unread` and `notification` events update the signals and reach the
bus; error → close → backoff → renew via HttpClient (401 → refresh → retry) → reconnect; the
ladder resets on `open`; fallback after 5 failures and the visibility refresh; closing and
forgetting on sign-out; optimistic mark-read with re-read on failure.

Components that render the bell use the same fake (`shell/notification-bell.spec.ts`: count,
`aria-label`, live region, Escape and focus return, click → `POST …/read` + navigation, mark
all). The shell spec runs without a fake and checks that jsdom's missing `EventSource` lands
in `fallback`.
