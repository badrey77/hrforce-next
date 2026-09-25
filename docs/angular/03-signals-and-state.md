# 3. Signals and state

See also: [01-mental-model.md](./01-mental-model.md) for why zoneless change detection
needs signals at all, [06-http-and-errors.md](./06-http-and-errors.md) for
`httpResource()` in its HTTP context, [07-forms.md](./07-forms.md) for `toSignal()`
with reactive forms.

## `signal()`

A signal is a box holding one value, read by calling it as a function and written with
`.set()` or `.update()`:

```ts
// src/app/features/organization/organization.page.ts
protected readonly selectedId = signal<string | null>(null);
```

```ts
// src/app/features/organization/org-tree.ts
toggle(id: string): void {
  this.collapsed.update((ids) => {
    const next = new Set(ids);
    if (!next.delete(id)) next.add(id);
    return next;
  });
}
```

Note the comment right above that in `org-tree.ts`: **signals compare by reference.**
`.update()` must produce a *new* `Set`/array/object; mutating the old one in place and
calling `.set()` with the same reference would not notify anyone, because nothing
appears to have changed. This is the same rule React's `useState` has for objects/arrays
— it is not an Angular-specific quirk, it is what "reactive by reference" means anywhere.

## `computed()`

A signal derived from other signals, recalculated only when one of the signals it read
last time actually changed value:

```ts
// organization.page.ts
protected readonly effectiveAsOf = computed(() => {
  const asOf = this.asOf();
  return isIsoDate(asOf) ? asOf : todayIso();
});

protected readonly root = computed(() => (this.tree.hasValue() ? this.tree.value().root : null));
```

Compare to a plain method (`protected effectiveAsOf() { ... }`) called from the
template: that would re-run on every check of the component, even if `asOf()` hadn't
changed. `computed()` memoizes — cheap to call repeatedly, evaluated lazily (only when
read), and itself trackable by whoever reads it (a template, another `computed`, an
`effect`).

`unit-detail.ts`'s `lookup` computed is a good second example: it merges the tree's
`names` map with the currently open unit's own path, and only redoes that merge when
`unit` or `names` changes — not on every render of the surrounding page.

## `effect()` — and why this codebase avoids it for state

An `effect()` re-runs a function whenever the signals it reads change, for something
*outside* of rendering — logging, syncing to storage, imperative DOM work. HRForce Next
does not use `effect()` anywhere in `apps/web/src` (check: it isn't imported). That's a
deliberate absence, not an oversight: every case that *looks* like "run this when that
changes" here is actually one of:

- **Derived state** → `computed()` (pure, cached, no side effect).
- **A request driven by signals** → `httpResource()` — internally *implemented* with
  reactive primitives, but you never write the effect yourself; see below.
- **A DOM/imperative action the user triggered** → a plain event handler
  (`(click)="startMode('create')"`).

The trap `effect()` invites is using it to keep one signal "in sync" with another
(`effect(() => this.b.set(this.a() * 2))`), when a `computed()` says the same thing more
directly, is guaranteed side-effect-free, and can't accidentally create a feedback loop
or fire during change detection in a way that surprises you. Reach for `effect()` only
for genuine side effects (and prefer doing them in response to a user action or in a
resource, if you can) — not as a substitute for `computed()`.

## Combining an app-wide cache signal with the language signal

Kind labels ("Direction générale", "Agence"…) are **data**: the business maintains them
in the `org_unit_kind` catalogue, one label per language, and the API serves them from
`GET /org/kinds`. They cannot live in `public/i18n/*.json` (adding a kind must not need
a web release). So a label has to be picked from API data *according to the active
language* — and must change when the user switches language. Two signals from two
different worlds, combined in one `computed()`:

```ts
// src/app/core/org/kind-catalog.ts
@Injectable({ providedIn: 'root' })
export class KindCatalog {
  private readonly language = inject(LanguageService);
  private readonly resource = inject(OrgApi).kindsResource();

  readonly kinds = computed<readonly OrgKind[]>(() => (this.resource.hasValue() ? this.resource.value().items : []));

  private readonly labels = computed(() => {
    const lang = this.language.current();
    return new Map(this.kinds().map((kind) => [kind.code, kind.labels[lang]]));
  });

  labelOf(code: OrgUnitKind): string {
    return this.labels().get(code) || code;
  }
}
```

- `this.resource` is an app-wide cache: the service is a root singleton, so the
  catalogue is fetched once and shared (chapter 06 explains why an `httpResource` held
  by a root service, rather than `shareReplay`).
- `LanguageService.current()` is the signal `LanguageService.use(lang)` sets (chapter 08).
- `labels` read **both**, so it is rebuilt when the catalogue arrives *or* the language
  changes — and only then. `labelOf()` is a plain method, but it reads the `labels`
  signal, so a template that calls it (`{{ kindCatalog.labelOf(item.kind) }}` in
  `org-tree.ts`) depends on both signals too: switching to Arabic re-renders every kind
  badge, without the template knowing anything about languages.

The rule the codebase follows: **texts the team writes** (buttons, messages, headings)
come from the i18n files through `t()`; **labels of reference data the business
maintains** (kinds now, wilayas later) come from the API with one label per language
and are chosen with the language signal. `organization.page.spec.ts`'s "switches kind
labels with the language" test and `kind-catalog.spec.ts` check this.

## `linkedSignal()`

A writable signal that **resets itself** to a computed value whenever a separate
`source` signal changes, but that you can also `.set()` directly the rest of the time:

```ts
// organization.page.ts
protected readonly mode = linkedSignal<string | null, Mode>({
  source: this.selectedId,
  computation: () => 'view',
});
```

`mode` starts (and snaps back to) `'view'` every time `selectedId` changes — pick a
different unit in the tree, and any open create/change form is discarded automatically.
But between selections, `startMode('create')` calls `this.mode.set('create')` and it
stays `'create'` until either the user cancels (`mode.set('view')`) or `selectedId`
changes again. A plain `computed()` couldn't do this — it has no `.set()`. A plain
`signal()` couldn't do this either — nothing would reset it when the selection changes,
and you'd need a manual `effect()` watching `selectedId` to reset `mode`, exactly the
kind of side-effecting sync `linkedSignal()` exists to avoid.

## `toSignal()`

Bridges an RxJS `Observable` into a signal, for interop with the (still very much
RxJS-based) Forms API:

```ts
// src/app/features/organization/change-unit-form.ts
protected readonly validFrom = toSignal(this.form.controls.validFrom.valueChanges, { initialValue: '' });
```

`form.controls.validFrom.valueChanges` is an `Observable<string>` (reactive forms
predate signals and still expose their state that way). `toSignal()` subscribes
immediately, tracks the latest emitted value as a signal (`validFrom()`), supplies
`initialValue` for the moment before the first emission, and unsubscribes automatically
when the component is destroyed. The result, `validFrom()`, then feeds
`[asOf]="validFrom() || undefined"` on the org-unit picker — a signal input, so it needs
a signal, not an `Observable`.

## `resource()` / `httpResource()`

`httpResource()` turns a *signal-driven* HTTP GET into a resource — a signal-shaped
wrapper around an async value, with cancellation and status tracking built in:

```ts
// src/app/core/org/org-api.ts
treeResource(asOf: () => string | undefined): HttpResourceRef<OrgTree | undefined> {
  return httpResource<OrgTree>(() => {
    const date = asOf();
    return date === undefined ? undefined : { url: `${ORG_API_BASE}/tree`, params: { asOf: date } };
  });
}
```

Give it a function that reads signals and returns a request (or `undefined` for "no
request right now"). Angular re-runs that function whenever a signal it read changes,
cancels the previous request if one was still in flight, and exposes the result as
signals: `value()`, `status()` (`'idle' | 'loading' | 'reloading' | 'resolved' |
'error' | ...`), `isLoading()`, `error()`, `hasValue()` (a type guard: after it returns
`true`, `value()` is narrowed to not include `undefined`), and `reload()` to re-run the
same request on demand.

`organization.page.ts` uses two of them: `tree = this.api.treeResource(this.effectiveAsOf)`
and `detail = this.api.unitResource(this.selectedId)`. Both re-fetch purely because a
signal they depend on changed — no manual subscribe/unsubscribe, no loading-flag
bookkeeping. The template reads their state directly:

```html
<!-- organization.page.html -->
@if (tree.error()) {
  ...
  <button (click)="tree.reload()">{{ t('common.retry') }}</button>
} @else if (root(); as rootNode) {
  ...
}
```

`resource()` (used internally by `httpResource()`, and available directly for
non-HTTP async work) is the more general form; nothing in this app calls it directly —
`httpResource()` is enough for GETs. See chapter 06 for how it fits with `HttpClient`,
interceptors and cancellation.

## When to use RxJS instead

`httpResource()` is for *reads* triggered by state changes. For writes (POST/PATCH) and
for a search-as-you-type pipeline, this app deliberately keeps using RxJS
`Observable`s and `HttpClient` directly — see `OrgApi.create()`, `.change()`, `.search()`
in `org-api.ts`. The clearest example of "RxJS earns its keep" is the picker's search:

```ts
// src/app/shared/org-unit-picker/org-unit-picker.ts
this.searches
  .pipe(
    debounceTime(ORG_UNIT_PICKER_DEBOUNCE_MS),
    switchMap((request) => {
      this.state.set('loading');
      return this.api.search(request).pipe(
        map((result) => result.items),
        catchError(() => of(null)),
      );
    }),
    takeUntilDestroyed(),
  )
  .subscribe((items) => { ... });
```

- `debounceTime(250)` waits for a pause in typing before firing a request — a signal
  has no built-in notion of "wait a bit before reacting," but an RxJS operator does.
- `switchMap` cancels the previous inner Observable (and, for `HttpClient`, that
  cancels the actual in-flight request) the moment a new one starts — exactly the
  "newest wins" behavior `httpResource()` gives you for free on reads, but here applied
  to a `Subject` fed by keystrokes rather than a signal.
- `catchError` is placed *inside* the `switchMap`, not after the whole pipe — an error
  reaching the outer `.pipe()` would terminate the subscription for good; catching it
  inside lets the next keystroke still trigger a new search.

Rule of thumb used throughout this codebase: **read data driven purely by signals** →
`httpResource()`. **A write, or a stream with timing/combination logic (debounce,
cancel-on-new-input, combine multiple sources)** → RxJS `Observable` with `HttpClient`.

## Zoneless change detection, and why signals are the reason it works

Chapter 01 covered the "no zone.js" fact. Mechanically: an `OnPush` component's view is
only re-checked when Angular can prove something it depends on changed. Without
zone.js's blanket "something async happened, recheck everything," that proof has to
come from somewhere precise — and that's exactly what a signal read inside a template
gives the framework: an explicit, trackable dependency. Every `{{ }}`/`[ ]`/`@if`
expression that calls a signal registers itself as a subscriber; `.set()`/`.update()`
notifies exactly those subscribers. This is why `organization.page.ts` routes
everything — the date, the selection, the mode, the loaded tree — through signals, and
why `httpResource()`'s whole design is "value as a signal": in a zoneless app, if it
isn't a signal (or feeding one, like `toSignal()`), the view has no way to know it
should re-render.

## A root signal store: `Session`

Who is signed in is app-wide state. The shell header shows the name, the guards decide
routes with it, the login page fills it and the refresh interceptor empties it. It lives
in one root service,
[`src/app/core/auth/session.ts`](../../apps/web/src/app/core/auth/session.ts):

```ts
// src/app/core/auth/session.ts
@Injectable({ providedIn: 'root' })
export class Session {
  private readonly api = inject(AuthApi);

  /** `null` = signed out (the contract's "`null` = signed out"). */
  private readonly me = signal<Me | null>(null);

  readonly user = computed<SessionUser | null>(() => this.me()?.user ?? null);
  readonly company = computed<SessionCompany | null>(() => this.me()?.company ?? null);
  readonly companies = computed<readonly SessionCompany[]>(() => this.me()?.companies ?? []);
  readonly isAuthenticated = computed(() => this.me() !== null);

  async load(): Promise<void> { /* GET /api/me → me.set(body), or me.set(null) on any failure */ }
  set(me: Me): void { this.me.set(me); }
  clear(): void { this.me.set(null); }
}
```

This is the whole "store pattern" in Angular with signals: no library, no actions,
reducers or `BehaviorSubject`.

- **One source signal, private.** `me` is the only writable piece, and only three
  methods write to it. "Who signed this user out?" means searching for `.clear()`.
- **Public read-only views.** `computed()`s give readers exactly the slices they need,
  and a `computed()` cannot be `.set()` from outside. (`signal.asReadonly()` is the
  other way to expose a signal read-only; `LanguageService.current` uses it.)
- **One instance.** `providedIn: 'root'` means the root injector creates it once, and
  every `inject(Session)` gets the same object (chapter 04). The guard, the interceptor
  and `UserMenu` agree without passing anything around.
- **Readers re-render on their own.** `app.html` reads `session.isAuthenticated()` in
  an `@if` around the nav, and `shell/user-menu.ts` reads `session.user()`. After
  `clear()`, exactly those two views re-render (zoneless, below). Nothing subscribes or
  unsubscribes.
- **Async stays at the edges.** `load()` is a Promise because the app initializer awaits
  it ([chapter 11](./11-app-initializers-and-auth-flow.md)). The *state* stays synchronous: `isAuthenticated()` always has an
  answer, which is what a guard needs.

When a store grows (Authorization will add `permissions` and `scopes` to `/api/me`),
add more `computed()` views of the same `me` signal, e.g.
`hasPermission = (code) => this.me()?.permissions.includes(code)`. Do not add a second
writable signal that could drift out of sync.

## Pitfalls

- **Mutating instead of replacing.** Covered above — `.update()` must return a new
  reference for arrays/objects/`Set`/`Map`.
- **Calling a signal outside a reactive context expecting it to "subscribe".** Reading
  `signal()` inside a plain (non-computed, non-effect, non-template) function just reads
  the current value once — it does not create a subscription. `httpResource()`'s
  request function *is* a reactive context (the resource re-runs it), which is why
  `asOf()` inside it behaves like a dependency; a random helper method calling
  `this.selectedId()` would not.
- **Using `effect()` to derive state.** See the section above — prefer `computed()`.
- **Forgetting `hasValue()` before reading a resource's `value()`.** `tree.value()`
  throws if the resource has no value yet; `organization.page.ts` always checks
  `tree.hasValue()` (via the `root` computed) or narrows in the template with
  `@if (detail.hasValue())` first.
- **Reading a language-dependent value without the language signal.** A helper that
  did `kind.labels[transloco.getActiveLang()]` would read the language *once*: nothing
  would re-render on a switch. Read `LanguageService.current()` (a signal) instead, as
  `KindCatalog.labels` does.
- **`linkedSignal` vs `computed`.** If you never need to overwrite the derived value
  directly, use `computed()` — it's simpler and cannot get out of sync in ways you
  didn't intend. Reach for `linkedSignal()` only when you need "resets on X, but
  otherwise independently settable," as `mode` does here.

## Next

[04-dependency-injection.md](./04-dependency-injection.md) — how `OrgApi`, `HttpClient`
and the org-tree's ancestor injection actually get resolved.
