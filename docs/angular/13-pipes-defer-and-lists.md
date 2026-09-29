# 13. Pipes, `@defer` and lists

The Audit slice ([`docs/contracts/audit.md`](../contracts/audit.md)) adds a **History** tab
to three pages: the unit detail panel, the user detail page and the role editor. Behind the
tab is one reusable timeline: a long, paginated, date-heavy list that most visitors never
open. That makes it a good place to learn four things:

| Question | Tool | File |
|---|---|---|
| Format a value in a template, cheaply | a **pure pipe** (`dayHeading`), Angular's `DatePipe` | `shared/timeline/day-heading.pipe.ts`, `shared/timeline/timeline.html` |
| Format dates in French and Algerian Arabic | `registerLocaleData()`, the pipe's `locale` argument | `core/i18n/date-locale.ts` |
| Show "page 1 + page 2 + …" with a cursor | a resource keyed on the cursor + a `linkedSignal` that accumulates | `shared/timeline/timeline.ts`, `core/audit/audit-api.ts` |
| Download and render the timeline only when needed | `@defer (on viewport; prefetch on idle)` | `shared/timeline/history-tabs.ts` |
| Wrap a page's own content in tabs | content projection, `<ng-content />` | `shared/timeline/history-tabs.ts` |

## 1. Pipes

A pipe transforms a value **for display**. In a template, `value | name: arg1 : arg2`
calls the pipe's `transform(value, arg1, arg2)`. Our own pipe is a class with `@Pipe` and a
`transform()` method, listed in the component's `imports` like a component:

```ts
// apps/web/src/app/shared/timeline/day-heading.pipe.ts
@Pipe({ name: 'dayHeading', pure: true })
export class DayHeadingPipe implements PipeTransform {
  transform(day: string, lang: AppLanguage): string {
    return formatDate(day, 'fullDate', dateLocaleOf(lang));
  }
}
```

```html
<!-- apps/web/src/app/shared/timeline/timeline.html -->
{{ group.day | dayHeading: lang() }}
```

### Pure pipes, and when they re-run

`pure: true` is the default (written out in this file to teach it). Angular calls a pure
pipe's `transform()` **only when the value or one of the arguments changes**, compared by
reference (`===`). Otherwise it reuses the previous result for that binding.

Two consequences:

- **Everything the output depends on must be an argument.** The heading depends on the
  language, so the language is passed in (`dayHeading: lang()`). When the user switches to
  Arabic, `lang()` changes, the argument changes, and every heading is formatted again. A
  pure pipe that read the language *inside* `transform()` would keep returning its cached
  French text.
- **Mutating an array or object does not re-run it.** `items | myPipe` after
  `items.push(x)` gets the old result, because the reference is the same. Signals push you
  towards new references anyway (`pages` in the timeline is always a new array).

An **impure** pipe (`pure: false`) runs on every change detection of its template. You
need one only when the output depends on something that is not an argument. Angular's
`async` pipe is the classic example. This codebase has none.

### Why not call a method in the template?

`{{ heading(group.day) }}` works, but Angular cannot know whether `heading()` would return
something new, so it calls it **every time the view is checked**. For one value that is
nothing. For every row of a 200-entry history, on every check, it adds up. A pure pipe is
memoised per binding, and a `computed()` is memoised per component (see below). The
templates in this repo avoid calling functions that do real work. Cheap lookups such as
`t(...)` or `kinds.labelOf(code)` are the accepted exception: they read signals, which
also makes them reactive (chapter 03).

### Built-in pipes: `DatePipe`

Angular ships pipes in `@angular/common`: `DatePipe`, `DecimalPipe`, `CurrencyPipe`,
`PercentPipe`, `JsonPipe`, `AsyncPipe`, and a few more. Import the one you use (`imports:
[DatePipe]`). Arguments follow `:`:

```html
<!-- apps/web/src/app/shared/timeline/timeline.html -->
<time [attr.datetime]="entry.at" [title]="entry.at | date: 'medium' : undefined : locale()">{{
  entry.at | date: 'shortTime' : undefined : locale()
}}</time>
```

The arguments are format, timezone (`undefined` means the browser's) and **locale**. The
locale is the important one here, see §2.

### Pipe or `computed()`?

The timeline groups entries by day. That could be a pure pipe (`entries | groupByDay`), but
it is a `computed()`:

```ts
// apps/web/src/app/shared/timeline/timeline.ts
protected readonly groups = computed(() => {
  const locale = this.locale();
  return buildTimeline(this.entries(), this.resolver(), new Date(), (day) => formatDate(day, 'mediumDate', locale));
});
```

`formatDate()` is the function behind `DatePipe`, for code outside a template: here it formats
the dates inside event sentences (`validFrom`…). Reading `this.locale()` inside the `computed()`
makes a language switch re-build the sentences.

| Use a **pipe** when… | Use a **`computed()`** when… |
|---|---|
| the same formatting is wanted in many templates (a date, a label) | the derivation belongs to one component's view model |
| the inputs are plain values passed in the template | the inputs are already signals, possibly several (pages, the page's name data, the language) |
| | other derived state builds on the result |

`buildTimeline()` itself is plain TypeScript
([`timeline-view.ts`](../../apps/web/src/app/shared/timeline/timeline-view.ts)), so it is
tested without `TestBed` (`timeline-view.spec.ts`).

## 2. Dates per locale: `registerLocaleData`, `LOCALE_ID` and the active language

Angular's date and number formatting does **not** use the browser's `Intl` tables. It reads
Angular's own CLDR **locale data**: month names, day names, and patterns such as
`fullDate`. Only `en-US` is built in. Any other locale must be registered once, before a
pipe uses it:

```ts
// apps/web/src/app/core/i18n/date-locale.ts
registerLocaleData(localeFr, 'fr');
registerLocaleData(localeArDz, 'ar-DZ');

/** App language → Angular locale id used to format dates (`en` → the built-in `en-US`). */
export const DATE_LOCALES: Readonly<Record<AppLanguage, string>> = { fr: 'fr', ar: 'ar-DZ', en: 'en-US' };
```

Why `ar-DZ` and not `ar`? Algeria writes Latin digits and uses the Maghreb month names
(جانفي، فيفري…). Generic `ar` would print Arabic-Indic digits and other month names.

**`LOCALE_ID` vs the Transloco language.** `LOCALE_ID` is a DI token, `'en-US'` by default.
`DatePipe` reads it **once**, when the pipe instance is created. Providing it
(`{ provide: LOCALE_ID, useValue: 'fr' }`) fixes it for the life of the application. There
is no supported way to change it while the app runs: you would have to re-bootstrap or
reload. Our UI language, in contrast, switches at runtime (`LanguageService.use()`,
chapter 08). So this repo leaves `LOCALE_ID` at its default and passes the locale
**explicitly**:

- `DatePipe`'s 4th argument (`date: 'shortTime' : undefined : locale()`), where
  `locale = computed(() => dateLocaleOf(this.language.current()))`;
- `formatDate(value, format, locale)`'s 3rd argument, in the `dayHeading` pipe.

Both are pure, so a new locale argument re-formats everything on a language switch.
`timeline.spec.ts` checks the French headings ("samedi 26 septembre 2026") and the Arabic
switch.

The alternative, `Intl.DateTimeFormat(lang)`, needs no registration but formats with the
browser's own tables, which differ between browsers and versions. Angular's data gives the
same output everywhere, tests included.

**Where the locale data ends up.** The locale files are small ES modules (~2.5 kB each)
imported by `date-locale.ts`. Only the timeline imports that file, and the timeline is
`@defer`red (§4), so the French and Algerian locale data is downloaded with the History
tab, not with the app. The `ar-DZ` month names can be found in the timeline's lazy chunk
after `ng build`.

## 3. Lists: cursor pagination and "load more"

`GET /api/audit/timeline?subject=…&before=<cursor>&limit=50` returns
`{ items, nextCursor }`, newest first. `nextCursor: null` means there are no older entries.
The first request sends **no** `before` at all:

```ts
// apps/web/src/app/core/audit/audit-api.ts
export function timelineParams(request: TimelineRequest): Record<string, string> {
  const params: Record<string, string> = {
    subject: request.subject,
    limit: String(request.limit ?? TIMELINE_PAGE_SIZE),
  };
  if (request.cursor) params['before'] = request.cursor;
  return params;
}
```

### Accumulating pages with signals

An `httpResource` holds **one** response, but "load more" needs every page loaded so far.
The timeline chains three signals:

```ts
// apps/web/src/app/shared/timeline/timeline.ts
private readonly cursor = linkedSignal<AuditSubject, string | null>({ source: this.subject, computation: () => null });
protected readonly page = this.api.timelineResource(() => ({ subject: this.subject(), cursor: this.cursor() }));

/** Every page received for the current subject, oldest request first. */
private readonly pages = linkedSignal<PageSource, readonly TimelinePage[]>({
  source: () => ({ subject: this.subject(), page: this.page.hasValue() ? this.page.value() : undefined }),
  computation: (source, previous) => {
    const kept = previous && previous.source.subject === source.subject ? previous.value : [];
    if (!source.page || kept.includes(source.page)) return kept;
    return [...kept, source.page];
  },
});
```

1. `cursor` is a `linkedSignal` of the subject. "Load more" sets it to the last page's
   `nextCursor`, and a new subject (another user opened) resets it to `null` by itself.
2. `page` is a resource keyed on `{ subject, cursor }`. A new cursor sends the next request
   and cancels one still in flight.
3. `pages` is a `linkedSignal` whose `computation(source, previous)` receives **its own
   previous value**. That is what makes it an accumulator: append the newly arrived page,
   or start again from `[]` when the subject changed. While the next page loads, `page`
   has no value, and `pages` keeps what it had, so earlier rows stay on screen.

`entries`, `groups` and `nextCursor` are plain `computed()`s of `pages`. The "load more"
button shows while `nextCursor()` is not `null`. A failed page leaves the earlier pages
visible with a retry, and `page.reload()` re-sends the same cursor.

**Alternatives, and why not here:**

- **`scan()` over a `Subject`** (`cursor$.pipe(concatMap(api.timeline), scan(append))` +
  `toSignal`) is the classic RxJS answer and works well. But loading and error flags, and
  "reset when the subject changes", must then be built by hand (`startWith`,
  `catchError`, a `switchMap` on the subject). The result is converted to a signal for the
  template anyway.
- **An imperative `loadMore()`** that subscribes and does `pages.update(p => [...p, page])`
  is the shortest, but every state flag is again yours to maintain, and so is ignoring a
  late response after the subject changed.

**"Load more" vs infinite scroll.** An audit trail is consulted, not browsed. A button keeps
the user in control. It leaves the page footer reachable, works with a keyboard and a screen
reader without extra effort, and never sends requests the user did not ask for. Infinite
scroll would only change what calls `cursor.set()`: an `IntersectionObserver` on the last
row, or a `@defer (on viewport)` sentinel. The accumulation would stay the same.

### `@for` over appended pages

`@for (entry of group.entries; track entry.id)` tracks by the API id (`c:41`, `e:7`, unique
across changes and events). When a page is appended, Angular matches the existing rows by
id and creates DOM only for the new ones. Days are tracked by their key (`2026-09-26`), and
`buildTimeline()` guarantees one group per day, because duplicate track keys would confuse
the list diffing.

## 4. `@defer`: lazy rendering and lazy code

The History tab renders the timeline inside a `@defer` block:

```html
<!-- apps/web/src/app/shared/timeline/history-tabs.ts (template) -->
@if (showTabs() && tab() === 'history') {
  @if (subject(); as current) {
    <div data-panel="history">
      @defer (on viewport; prefetch on idle) {
        <app-timeline [subject]="current" [resolver]="resolver()" />
      } @placeholder {
        <p class="muted" data-defer="placeholder">{{ t('audit.loading') }}</p>
      } @loading (after 100ms; minimum 300ms) {
        <p class="muted" data-defer="loading">{{ t('audit.loading') }}</p>
      } @error {
        <p class="form-error" role="alert">{{ t('audit.chunkError') }}</p>
      }
    </div>
  }
}
```

### A separate chunk

The compiler moves every **standalone** component, directive and pipe that is used *only*
inside a `@defer` block into its own JavaScript chunk, loaded with a dynamic `import()` when
the block triggers. Here that covers `Timeline` and, through it, the pipes, `TimelineValue`,
the view model and the locale data. `ng build` shows it:

```
Lazy chunk files    | Names                |  Raw size | Estimated transfer size
…
chunk-….js          | timeline             |  13.50 kB |                 4.49 kB
```

The condition "only inside the block" is strict. If `Timeline` were also used outside the
block in the same template, or referenced in the class body, it would be bundled eagerly
and the block would only delay *rendering*. Listing it in `imports` is fine.

### Triggers

`on …` says when to load and render:

| Trigger | Fires when… |
|---|---|
| `on idle` (default) | the browser is idle (`requestIdleCallback`) |
| `on viewport` | the placeholder (or `on viewport(ref)`'s element) scrolls into view (`IntersectionObserver`) |
| `on interaction` / `on hover` | the user clicks/focuses or hovers the placeholder (or a `#ref`) |
| `on immediate` | right after the surrounding template renders, without waiting for idle |
| `on timer(2s)` | after a delay |
| `when expr` | `expr` becomes truthy (once; the block never goes back) |

`prefetch on …` takes the same triggers but only **downloads** the chunk. Here,
`prefetch on idle` fetches the timeline's code while the browser has nothing to do, so
opening History later renders at once. `on viewport` then renders it when the placeholder
appears, which here means as soon as the tab is opened.

### Sub-blocks

- `@placeholder` shows until the trigger fires. For `on viewport`/`on interaction` without
  a reference, it is the element being watched, so it must be **one** root element.
  `@placeholder (minimum 500ms)` would keep it up for at least that long.
- `@loading (after 100ms; minimum 300ms)` shows while the chunk downloads, but only if the
  download takes more than 100 ms, and then for at least 300 ms. That avoids a flash of
  "loading" on a fast network.
- `@error` shows if the chunk fails to download (offline, a new deployment that removed the
  old chunk).

### Why inside `@if`?

A loaded `@defer` block stays loaded for as long as its view exists. This block sits inside
`@if (tab() === 'history')`. Leaving the tab destroys the timeline, and coming back creates
a new one: the **history is re-fetched each time it is opened** (fresh after an edit on the
Details tab), while the **code is downloaded only once**. If the block were always present
and hidden with CSS, it would keep a stale history and keep fetching for a hidden tab when
the subject changed.

## 5. Content projection: `<ng-content />`

`<app-history-tabs>` is used by three pages with three different "Details" contents:

```html
<!-- apps/web/src/app/features/organization/organization.page.html -->
<app-history-tabs [subject]="'org_unit:' + unit.id" [resolver]="auditNames">
  @if (canCreateUnder(unit) || can('update')) { … }
  <app-unit-detail [unit]="unit" [names]="names()" [siteNames]="siteNames()" />
</app-history-tabs>
```

Whatever is written between the tags is **created by the page** (its bindings, its
components, its form state) and only *inserted* where the wrapper puts `<ng-content />`.
React users know this as `children`.

Projected content is always instantiated, even when not displayed. So the wrapper hides the
Details panel with `[hidden]` instead of putting `<ng-content />` inside `@if`. Angular's
docs advise against conditional `<ng-content>`: the content exists anyway, and toggling it
only moves DOM around. A useful side effect: an unsaved role form survives a trip to the
History tab and back (`history-tabs.spec.ts` checks this with an `<input>`).

### Passing data down: inputs vs DI

The timeline shows ids (parent unit, site, role, permission code). It names them with a
**`resolver` input**, a function the page supplies from data it already has:

```ts
// apps/web/src/app/features/organization/organization.page.ts
protected readonly auditNames: AuditNameResolver = (kind, value) => {
  if (kind === 'unit') return this.names().get(value);
  if (kind === 'site') return this.siteNames().get(value);
  return undefined;
};
```

The resolver reads signals. Because it is called inside the timeline's `groups`
`computed()`, the names appear once the tree or the role catalogue arrives. It is a class
**field** (one stable function); an arrow written in the template would be a new function
on every check. The DI alternative is an `InjectionToken<AuditNameResolver>` that the page
provides in its `providers` (chapter 04). It pays off when the consumer sits several levels
below, with no inputs to thread through, but the contract is then less visible at the call
site. Here the timeline is one level down, so an input is simpler and trivial to fake in
tests.

#### Values that are not names: fingerprints, codes, opaque ids

`timeline-view.ts` turns each stored value into a `DisplayValue` (a discriminated union
the small `<app-timeline-value>` component renders with `@switch`). Besides dates and
names, three cases came with the Documents tables:

- **`hash`**: `sha256`/`content_sha256`/`logo_sha256` are `bytea` columns, stored in the
  diff as `\x` + 64 hex digits. They show as the first 12 digits followed by "…", with the
  full value in a `[title]` tooltip — the document detail page's convention.
- **`key`** for `employee_file.scan_status` (`ENUM_FIELDS`): a code from a fixed list shown
  through `audit.values.employee_file.scan_status.<code>`.
- **`unnamed`**: a signatory or file category **UUID** tells a reader nothing (unlike a role
  code). When the resolver cannot name one, the line says "nom non disponible" rather
  than printing the id (`OPAQUE_REFS`).

The employee page names them from **resources that exist only while the History tab is
shown**
([`features/employees/employee-detail.page.ts`](../../apps/web/src/app/features/employees/employee-detail.page.ts)):

```ts
private readonly historyShown = computed(() => this.activeTab() === 'history');
private readonly fileCategories = inject(EmployeeFilesApi).categoriesResource(this.historyShown);
private readonly historyDocuments = inject(DocumentsApi).listResource(() =>
  this.historyShown() && this.canDocuments()
    ? { ...DEFAULT_DOCUMENT_QUERY, employmentId: this.id(), pageSize: DOCUMENTS_FOR_NAMES }
    : undefined,
);
```

An `httpResource` whose request function returns `undefined` sends nothing, so opening an
employee costs no extra call; opening History costs one (two with `document.read`: each
issued document carries its signatory's names). The resolver reads `value()` of these
resources — a signal read inside the timeline's `computed()` — so the names replace
"nom non disponible" as soon as the answers arrive. The document detail page needs no
extra call: its detail already names the signatory.

## 6. Testing pipes, lists and `@defer`

- **A pure view model** (`buildTimeline`) is tested as plain functions: groups,
  today/yesterday, hidden columns, masking and name resolution
  (`timeline-view.spec.ts`).
- **The component** (`timeline.spec.ts`): `TestBed.createComponent(Timeline)` +
  `fixture.componentRef.setInput('subject', …)`, `HttpTestingController` for each page, then
  asserts on the DOM: French headings, "masqué"/"مخفي", the event sentence, "load more"
  sending `before=cur-2` and **appending**, the button gone when `nextCursor` is `null`,
  first-page and next-page errors with retry. Note that `fixture.whenStable()` would hang
  here: an open request (a loading resource) keeps the app "unstable" until it is flushed.
  The specs tick and yield instead (`TestBed.tick()` + `setTimeout(0)`).
- **`@defer` in tests** (`history-tabs.spec.ts`). `TestBed.configureTestingModule({
  deferBlockBehavior })` has two modes:
  - `DeferBlockBehavior.Playthrough` (the default) behaves like a browser: triggers fire,
    the chunk loads, then the content renders. jsdom has no `IntersectionObserver`, so
    `on viewport` needs the fake in
    [`src/testing/intersection-observer.ts`](../../apps/web/src/testing/intersection-observer.ts).
    `enterViewport()` says "the placeholder was seen". Do not wait a fixed number of ticks
    for what follows: the chunk arrives through a dynamic `import()`, which is slower when the
    whole suite runs in parallel workers (a fixed count made these specs flaky). Use
    `untilDeferredRequest(http, match, settle)` from the same file: it re-fires the viewport
    and polls against a time budget until the block's request is out, then returns it.
  - `DeferBlockBehavior.Manual` ignores triggers. The block stays on `@placeholder` until
    the test renders a state explicitly:

    ```ts
    // apps/web/src/app/shared/timeline/history-tabs.spec.ts
    const [block] = await fixture.getDeferBlocks();
    await block?.render(DeferBlockState.Loading);
    expect(el().querySelector('[data-defer="loading"]')).not.toBeNull();

    await block?.render(DeferBlockState.Complete);
    ```

    Use Manual to test each sub-block (placeholder, loading, error) deterministically, and
    Playthrough for "the page works end to end" (the page specs
    `organization.page.spec.ts` and `user-detail.page.spec.ts` open the History tab that
    way).

## Next

Chapter 10 has the recipe **"add a History tab to a page"**, which applies all of this to a
new screen (Employees will need one).
