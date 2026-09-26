# 15. Workflows in the UI

See also: [03-signals-and-state.md](./03-signals-and-state.md) (signals, resources),
[06-http-and-errors.md](./06-http-and-errors.md) (`httpResource`, cancellation),
[07-forms.md](./07-forms.md) (ControlValueAccessor), [14-big-forms-and-url-state.md](./14-big-forms-and-url-state.md)
(URL state, reused by the HR leave list).

M2's first slice — leave requests with an approval chain (docs/contracts/leave.md) — adds
screens where the UI is not just "load, show, save": a request **moves** through steps
owned by different people, a number in the navigation **changes** while you work, a form
**answers back** before you submit. This chapter covers the five patterns that make that
work:

1. [Live previews](#1-live-previews-a-post-that-is-a-read) — a debounced signal feeding an `httpResource`.
2. [One store, two views](#2-one-store-two-views-the-task-badge) — the task badge and the task list share state.
3. [Polling vs events](#3-polling-vs-events-when-to-refresh) — when a count refreshes, and why not on a timer.
4. [Optimistic updates](#4-optimistic-updates-with-signals) — remove first, confirm later, roll back cleanly.
5. [Steppers](#5-steppers-derived-view-state-rtl-for-free) — a presentational component over a pure function.
6. [ControlValueAccessor, second time](#6-controlvalueaccessor-second-time-the-employee-picker) — what to copy, what to share.

## 1. Live previews: a POST that is a read

`shared/leave/leave-request-form.ts` shows, beside the form, how many days the request
will cost — weekend days and public holidays removed, half days counted, balance after.
The server computes it (`POST /api/leave/preview`): the rules (count mode, weekend,
holidays, oldest year first) live in one place, the API.

### Why a POST can be modelled as a read

HTTP verbs describe *what the server does*; for the UI what matters is *how the answer
behaves*:

| | Preview (`POST /leave/preview`) | Submit (`POST /me/leave/requests`) |
|---|---|---|
| Writes anything? | no | yes |
| Depends only on its input? | yes | no (creates a row once) |
| Safe to send twice / cancel? | yes | no |
| A newer input makes the old answer… | useless | irrelevant (there is one click) |

So the preview is **data derived from the form** — exactly what a resource is — and the
submit is an **action**. `LeaveApi.previewResource()` (core/leave/leave-api.ts) is an
`httpResource` like any GET, with a method and a body:

```ts
previewResource(body: () => LeavePreviewRequest | undefined) {
  return httpResource<LeavePreview>(() => {
    const value = body();
    return value ? { url: `${LEAVE_API_BASE}/preview`, method: 'POST', body: value } : undefined;
  });
}
```

It goes through `HttpClient`, so the XSRF header and the problem interceptor apply as for
any POST. When `body()` changes, the resource **cancels the request in flight** and sends
the new one; `value()` only ever answers the latest body. `undefined` = idle, no request.

### Debounce: RxJS for time, signals for state

A date input fires on every digit. The form therefore turns its changes into a signal
only once the user pauses:

```ts
// shared/leave/leave-request-form.ts
private readonly previewBody: Signal<LeavePreviewRequest | undefined> = toSignal(
  this.form.valueChanges.pipe(
    startWith(null),
    debounceTime(LEAVE_PREVIEW_DEBOUNCE_MS),                    // wait for a pause
    map((): LeavePreviewRequest | undefined => this.previewRequest()), // undefined while incomplete
    distinctUntilChanged((a, b) => JSON.stringify(a) === JSON.stringify(b)), // reason/document edits: no request
  ),
  { initialValue: undefined },
);
protected readonly preview = this.api.previewResource(this.previewBody);
```

RxJS does what it is good at (time, de-duplication), `toSignal()` crosses into the signal
world, and the resource does the HTTP part (cancellation, loading/error state). Compare
with the pickers (chapter 07), where the *whole* pipeline is RxJS (`debounceTime` →
`switchMap`) because the result is pushed into local signals by hand. Both are fine; the
resource version needs no `subscribe`, no `catchError`-inside-`switchMap` trick and gives
`isLoading()`/`error()` for free. Angular 22 also ships an experimental `debounced()`
signal helper; we stay on RxJS until it is stable.

The template treats the preview as a **`role="status"` live region**: when the count
arrives, a screen reader announces it without the focus leaving the date field.

The server also returns `warnings` — the 409 slugs a submit would hit. The form shows
them with the **same** messages as the submit's errors (`LEAVE_REQUEST_SLUGS`), so the
preview warns in exactly the words the submit would use.

## 2. One store, two views: the task badge

"My tasks" appears twice: as a count in the side nav (always on screen) and as the list
on `/tasks`. Two separate requests could disagree ("3" in the nav, 2 rows on the page).
`core/tasks/tasks-badge.ts` is a **root signal store** (same idea as `Session`, chapter
03) owning ONE `httpResource` of `GET /api/tasks?status=open`:

```ts
readonly items = computed(() => /* server list minus optimistically hidden ids */);
readonly count = computed(() => this.items().length);
```

The shell reads `count()`, the page reads `items()`. The resource's request function
reads `Session.isAuthenticated()`, so it is idle while signed out and fires on sign-in.

**Accessibility of a count badge** (app.html): the number inside the link is
`aria-hidden`, and the link gets a full name ("Mes tâches, 3 en attente") — a screen
reader never reads a bare "3". A separate `aria-live="polite"` paragraph announces
changes; it is **always rendered** (a live region inserted together with its text is often
not announced) and empty until the count is known.

## 3. Polling vs events: when to refresh

Without a push channel (no WebSocket/SSE server — Postgres-only stack), the browser has
to ask. The two options:

| | Polling (`interval(60_000)` + `takeUntilDestroyed()`) | Events (chosen) |
|---|---|---|
| Trigger | a timer | `NavigationEnd`, `visibilitychange` → visible, after approve/reject |
| Cost when idle | one request per open tab per minute, forever | zero |
| Freshness | ≤ 1 minute | on the next click or tab switch |
| Server cost | `GET /tasks` evaluates candidate scopes at read time | same query, far less often |

```ts
// core/tasks/tasks-badge.ts
inject(Router).events.pipe(filter((e) => e instanceof NavigationEnd), takeUntilDestroyed())
  .subscribe(() => this.refresh());
fromEvent(this.document, 'visibilitychange')
  .pipe(filter(() => this.document.visibilityState === 'visible'), takeUntilDestroyed())
  .subscribe(() => this.refresh());
```

Approvals are not second-critical, so events win. `takeUntilDestroyed()` matters even in
a root service: tests create and destroy an app injector per test, and a listener left on
`document` would outlive it. If freshness ever matters more, the answer is a server push,
not a faster timer (and a poll should at least skip hidden tabs:
`filter(() => document.visibilityState === 'visible')`).

`refresh()` is `resource.reload()`: the current list stays on screen (status
`reloading`) while the new one loads — no flash of "loading…".

## 4. Optimistic updates with signals

Clicking **Approve** on `/tasks` removes the row and decrements the badge *before* the
server answers (features/tasks/tasks.page.ts). An approver working through ten requests
should not wait ten round trips — and the server almost always agrees, because the list
only contains tasks the user may act on.

The trick is to **never mutate the server's data**. The store keeps two signals:

```
resource.value().items   — the truth, as last received
hidden: Set<taskId>      — changes we assume will succeed
items = computed(truth minus hidden)
```

```ts
private decide(task, decision, request$) {
  this.store.hide(task.id);                 // row + badge update in this render
  this.selectedId.set(next?.id ?? null);    // move on to the next task
  request$.subscribe({
    next: () => this.store.refresh(),       // the server list confirms the removal
    error: (error) => {
      this.store.show(task.id);             // rollback: the row is back WHERE IT WAS
      this.feedback.set({ key: decisionErrorKey(error), … });
      if (slug === 'workflow-task-closed') this.store.refresh(); // someone else acted: fetch the truth
    },
  });
}
```

Because the visible list is *derived*, rollback is one line and needs no copy of the row
or its index. `409 workflow-task-closed` (a colleague approved first) is the interesting
case: we roll back and explain, then refresh — after which the task disappears for good,
because it *is* closed. The user sees a coherent story instead of a silent vanish.

When **not** to be optimistic: when the server often refuses, or when the user must see
the result before continuing (a payment, a signature). Rejecting here still asks for a
comment first (a dialog with `Validators.required`), then goes optimistic.

A related detail in the same page: the detail panel is an `httpResource` keyed on the
selected task. A list refresh builds new task objects, so keying it on
`selected()?.subject.id` would re-fetch the detail on every refresh. Keying it on a
**`computed()` returning the id string** fixes that: a computed compares its new value
with `Object.is`, and an unchanged string does not notify.

## 5. Steppers: derived view state, RTL for free

`shared/workflow-stepper/workflow-stepper.ts` draws "Manager ✓ — Regional HR (waiting)".

- **Rules in a pure function** (`stepStates(progress, history)`): done / current /
  rejected / cancelled / upcoming, including the case where the API sends
  `currentStep: null` for a finished instance (the history says where it stopped). Unit
  tested without TestBed; the component only maps states to markup in a `computed()`.
- **Labels are data**: the steps' `labels` come from the workflow *definition*, picked in
  the active language by `LeaveCatalog.labelOf()` (a function that reads the language
  signal). State words ("waiting") are UI text from Transloco.
- **Accessibility**: `<ol>` (order matters), `aria-current="step"` on the open step, the
  state written as text under each name (the tick is `aria-hidden`).
- **RTL**: a flex row along the *inline* axis, the connector drawn with
  `inset-inline-start` and `border-block-start`. In Arabic the first step is on the right
  and the line runs right-to-left with no `[dir=rtl]` rule; no arrow glyph that would
  need mirroring.

## 6. ControlValueAccessor, second time: the employee picker

`shared/employee-picker/employee-picker.ts` picks an employee for "Head of unit"
(features/organization/unit-head.ts) and "Linked employee"
(features/access/linked-employee.ts). It is the org-unit picker's twin (chapter 07):

| CVA piece | What it does here |
|---|---|
| `writeValue(id)` | display only: fetch `GET /employees/:id` to show "NAME First (MATRICULE)"; never call `onChange` |
| `registerOnChange(fn)` | called when the user picks from the list, or clears by typing |
| `registerOnTouched(fn)` | called when focus leaves the whole component (`focusout` with `relatedTarget` outside) |
| `setDisabledState` | disables the input, closes the list |
| `NG_VALUE_ACCESSOR` + `useExisting` + `forwardRef` + `multi` | how `formControlName` finds the instance |

The form sees a plain `string | null`, so `Validators.required`, `touched`, `reset()` and
server errors (`employment-linked` lands on the picker's control via `problemToForm`)
work unchanged. A picker also emits `(picked)` with the whole item for callers that need
more than the id.

**Copy or share?** The two pickers share their stylesheet but not their code. A generic
"entity picker" base would save ~60 lines and cost readability; the rule of three says
extract the combobox mechanics (keyboard, ARIA, focus) when a third picker appears.

## Testing these patterns

- **Debounce + resource with fake timers** (`leave-request-form.spec.ts`): resources
  resolve through promises, so advance with `await vi.advanceTimersByTimeAsync(ms)` (not
  the sync `advanceTimersByTime`), then `TestBed.tick()` to let the resource send.
  Cancellation is asserted with `firstRequest.cancelled`.
- **Optimistic flows** (`tasks.page.spec.ts`): assert the DOM *between* the click and the
  flush (row gone, badge down), then flush a 409 and assert the rollback.
- **Root stores in the shell** (`app.spec.ts`): pending resource requests keep the app
  "unstable", so `whenStable()` would wait forever — answer them first (`settle()`).
- **Visibility events** (`tasks-badge.spec.ts`): spy on `document.visibilityState` and
  dispatch `visibilitychange`.

## Next

Notifications (M2) will be the first push channel candidate; when it lands, the task
badge's `refresh()` becomes a subscriber of it and the event list in §3 shrinks.
