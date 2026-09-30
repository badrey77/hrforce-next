# 21. Corrections, reports and a one-tap confirmation

See also: [07-forms.md](./07-forms.md) (typed reactive forms, server errors),
[14-big-forms-and-url-state.md](./14-big-forms-and-url-state.md) (URL as state),
[15-workflows-in-the-ui.md](./15-workflows-in-the-ui.md) (My tasks, the stepper),
[18-binary-files-blobs-and-uploads.md](./18-binary-files-blobs-and-uploads.md) (Blob downloads),
[20-kiosks-timers-canvas-and-the-punch-flow.md](./20-kiosks-timers-canvas-and-the-punch-flow.md) (the punch flow).

Attendance Phase B (docs/contracts/attendance.md › Phase B) lets an employee ask for a **correction** of a day (add a
missing punch, remove a wrong one) through the workflow engine, gives HR a **monthly report** with a CSV export, and —
an owner decision of 2026-09-30 — puts a **one-tap confirmation** on `/punch`, so a link opened from a message can
never punch silently. The Angular pieces:

1. [A one-tap confirmation](#1-a-one-tap-confirmation) — a new state fed by a read-only endpoint, focus with
   `viewChild` + `afterRenderEffect`, an expiry timer, Unicode isolates inside a translated sentence.
2. [A form made of two `FormArray`s](#2-a-form-made-of-two-formarrays) — checkboxes by index, rows added and removed,
   a group validator across arrays, a validator reading a signal, server errors on array rows.
3. [Calling a child component's method](#3-calling-a-child-components-method) — `viewChild(Class)`.
4. [A before/after view over a pure function](#4-a-beforeafter-view-over-a-pure-function) — `<del>`/`<ins>`.
5. [A third subject in My tasks](#5-a-third-subject-in-my-tasks) — a union variant without an employee.
6. [A CSV download driven by the page's query](#6-a-csv-download-driven-by-the-pages-query).
7. [The rest](#7-the-rest) — HR list, detail, notifications, timeline, the employee tab.

## 1. A one-tap confirmation

[`features/punch/punch.page.ts`](../../apps/web/src/app/features/punch/punch.page.ts) adds one member to its state
union:

```ts
| { readonly kind: 'confirm'; readonly receipt: ReceiptView }
```

After the scan (or back from sign-in), the page reads `GET /api/me/attendance/receipt` — what redeeming the receipt
WOULD record: entrance, time, `direction` (arrival or departure) and `duplicate`; it writes nothing — and sets
`confirm` instead of calling the punch endpoint. The template's `@case ('confirm')` shows « Enregistrer mon arrivée à
<entrée> ? » (or « mon départ », from `direction`) and ONE large button; a `duplicate` receipt shows « Déjà enregistré »
and no button. Only `(click)="confirm()"` sends `POST /api/me/attendance/punches`. That is the whole security fix on
the web side: a link can now at most show a question. Because the receipt route answers after the login round trip,
the page keeps nothing in the browser (no `sessionStorage`).

**Focus on the button.** The button carries a template reference, `#confirmButton`. In the class,

```ts
private readonly confirmButton = viewChild<ElementRef<HTMLButtonElement>>('confirmButton');
```

is a *signal* that holds the element while the `confirm` case is rendered and `undefined` otherwise. An
`afterRenderEffect()` reads it and calls `focus()` — it runs after Angular has updated the DOM, which is exactly when
the button exists (a plain `effect()` could run before). It remembers the element it focused, so a later render does
not steal focus again, but a NEW question (a second scan while the page is open) creates a new element and is focused
too. `autofocus` would not work: browsers honour it only on the page's first load, not on an element a single-page
app adds later.

**Expiry on a timer.** The receipt now lasts 2 minutes. `ask()` starts a `setTimeout` for the time left
(`receiptTimeLeft()`: counted from when THIS page got the scan's answer when it has one — no clock skew — else the
receipt's end against the device clock, capped at 2 minutes, and no timer at all when the device clock is clearly
ahead: the API then decides on the tap) and switches
the state to the `expired` problem (« Code expiré. Veuillez scanner à nouveau… ») if the person has not tapped by
then. The timer is cleared when the state leaves `confirm` and, through `inject(DestroyRef).onDestroy(…)`, when the
page is destroyed ([chapter 20 §2](./20-kiosks-timers-canvas-and-the-punch-flow.md#2-timers-owned-by-a-component)).
A tap that arrives late anyway gets the API's 409 `attendance-no-scan`, read as `expired` because the page knew of a
scan (`punchProblem(error, knewScan)`).

**A name inside a translated sentence.** `<bdi>` isolates a name in markup, but here the entrance is a *parameter* of
one translated string (`{{entrance}}`), where no element can go. The page wraps it in the Unicode isolates U+2068
(FIRST STRONG ISOLATE) and U+2069 (POP DIRECTIONAL ISOLATE) — the plain-text equivalent of `<bdi>` — so an Arabic
entrance in a French question (or the reverse) does not drag the question mark to the wrong side.

## 2. A form made of two `FormArray`s

[`features/my-attendance/correction-form.ts`](../../apps/web/src/app/features/my-attendance/correction-form.ts):

```ts
this.fb.group(
  {
    removals: new FormArray<FormControl<boolean>>([]),   // one checkbox per live punch of the day
    additions: new FormArray<AddRow>([]),                 // rows { direction, time } the person adds
    reason: ['', reasonValidator()],
  },
  { validators: changeCount() },                          // 1–4 changes in total
);
```

- **Checkboxes by index.** `formArrayName="removals"` on the `<fieldset>`, then `@for (punch of punches(); track
  punch.id; let i = $index)` with `[formControlName]="i"`: the i-th control belongs to the i-th punch. `open(day)`
  rebuilds the array (`clear()` then `push()`) for the chosen day.
- **Rows that come and go.** `additions.push(fb.group({...}))` / `additions.removeAt(j)`, with `[formGroupName]="j"`
  on each row. The `@for` tracks the `FormGroup` **object** (`track row`), not the index: removing row 1 of 3 keeps the
  DOM (and focus) of rows 0 and 2.
- **A rule across arrays is a group validator.** "1 to 4 changes" counts ticked removals plus added rows; no single
  control knows both, so `changeCount()` sits on the root group and its error (`noChange` / `tooManyChanges`) is shown
  once, above the reason.
- **The window comes from the API.** `MyDaysView.correctionWindow` (`{from, to} | null`) says which days may be
  corrected today (employees cannot read the policy); the page derives the buttons and the rules sentence from it.
- **A validator factory that reads a signal.** `notInFuture(() => this.date())` refuses a time later than "now in
  Algiers" only when the dialog's day is today. Reading the signal inside the validator keeps one validator per row;
  `updateValueAndValidity()` in `open()` re-runs it for the new day.
- **The form as a signal.** `toSignal(this.form.valueChanges, { initialValue: … })` and a `computed()` that maps it to
  the contract's `changes` feed the live preview (§4). No subscription to manage.
- **Server errors on array rows.** The API reports `changes.<i>.time` (`future`, `exists`, `duplicate`) and
  `changes.<i>.punchId` (`not_found`, `duplicate`) where `i` is the index in the body sent. At
  submit time the form builds a table `'changes.1.time:future' → { key, control: 'additions.0.time' }` for THAT body,
  and `attendanceProblemToForm()` (shared/attendance/attendance-forms.ts) puts the translated message on the right row.

## 3. Calling a child component's method

The day list emits `(requestCorrection)` with the day; the page must open the dialog that lives inside
`<app-correction-form>`. A view query by **class** gives the child instance:

```ts
private readonly correctionForm = viewChild(CorrectionForm);
protected openCorrection(day: AttendanceDayView): void { this.correctionForm()?.open(day); }
```

([`my-attendance.page.ts`](../../apps/web/src/app/features/my-attendance/my-attendance.page.ts)). An input would be
the alternative (`[day]="…"` plus an effect that opens the dialog), but "open now" is a command, not state: a method
says so. The child still reports back with outputs (`(saved)`, `(notLinked)`).

The page decides *which* days get the button with one `computed()` over three sources — the month's days, the
correction window (sent with the days, else 30) and the pending requests — and passes the resulting `ReadonlySet` to
the day list, whose new inputs have defaults (`input<ReadonlySet<string>>(new Set())`) so the employee's Présence tab
is unchanged.

## 4. A before/after view over a pure function

[`shared/attendance/correction-preview.ts`](../../apps/web/src/app/shared/attendance/correction-preview.ts) renders
BEFORE and AFTER columns from `correctionPreview(punches, changes)` (core/attendance/attendance.models.ts, unit
tested). The template uses the semantic elements `<del>` and `<ins>` for removed and added punches plus a visible word
("à retirer", "ajouté"): meaning never rests on colour alone. The columns are a CSS grid
`repeat(auto-fit, minmax(11rem, 1fr))`: side by side on a desktop, stacked at 390 px, mirrored in Arabic — without a
media query or a `[dir]` rule. The same component serves the employee's dialog (live preview), My tasks and the HR
detail.

## 5. A third subject in My tasks

`TaskSubject` ([`core/tasks/tasks.models.ts`](../../apps/web/src/app/core/tasks/tasks.models.ts)) gains two
variants with the same `type: 'attendance_correction'`: the summary, and `{ purged: true }` when the retention job
deleted the request. The second has **no employee**, so templates can no longer write `task.subject.employee`
everywhere: rows call `subjectPerson(task.subject)` (`'employee' in subject`), and inside
`@if (task.subject.type === 'attendance_correction')` a second test `@if (task.subject.purged)` narrows to one variant
— the template type-checker follows both tests like TypeScript does.

The panel asks `GET /attendance/corrections/:id` through a resource keyed on a `computed()` id (the equality gate of
chapter 15), so it fires only for correction tasks; until it answers, the preview is built from the summary's
arrival/departure (`punchesOfSummary`). A decision error that asks the approver to act differently —
`attendance-correction-stale`, "reject instead" — is shown in the panel of that task (`panelError`), not only in the
page-level banner.

## 6. A CSV download driven by the page's query

[`features/attendance/monthly-report.page.ts`](../../apps/web/src/app/features/attendance/monthly-report.page.ts):
the table and the export read the SAME `query()` computed from the URL (chapter 14). The export calls

```ts
this.files.save(this.api.monthlyReportCsv(this.query(), this.currentMonth, this.lang()), reportFileName(month))
```

where `monthlyReportCsv` asks for `responseType: 'blob'` with the filters, no paging and `lang` = the UI language
(`fr`/`ar`; English → `fr`), and `BlobFiles.save()` (chapter 18) clicks a temporary `<a download>`. `BlobFiles` is
provided by the page (`providers: [BlobFiles]`), so any object URL it creates is revoked with the page. A 422 (more
than 5 000 rows) comes back as an `ApiProblemError` even though the request asked for a Blob: the problem interceptor
reads the error Blob as JSON first. `?month=` stays out of the URL for the current month, like `?date=` on the board.

## 7. The rest

| Screen | File | Patterns |
|---|---|---|
| HR corrections list | `features/attendance/corrections.page.ts`, `hr-list-state.ts` | URL as state; a default that is not "everything" (`pending`), so "all" needs its own value (`?status=all`) |
| Correction detail | `features/attendance/correction-detail.page.ts` | route param → input → resource; the stepper with history; `@defer` timeline `attendance_correction:<id>` |
| Tables at 390 px | `features/attendance/attendance.css` (`table.cards`) | the presence table's `data-label` cards, reused by class |
| Employee Présence tab | `features/employees/employee-attendance-tab.ts` | a third resource on the month key (`employmentId=` + the month's dates) |
| My requests | `features/my-attendance/my-attendance.page.ts` | `?correction=` scrolled to with `afterRenderEffect` (My leave's pattern); live reload on `attendance.*` notifications |
| Notifications | `shared/notifications/notification-message.ts` | `task.assigned` / `task.escalated` about a correction pick `…_attendance` sentences (the escalation reads the notification's `subject.type`) |
| Timeline | `shared/timeline/timeline-view.ts` | new enum and hidden fields for `attendance_correction(_item)` |
| Policy | `features/attendance/attendance-policy-settings.ts` | two more controls; an answer without them (Phase A API) keeps the defaults |

**Testing.** [`punch.page.spec.ts`](../../apps/web/src/app/features/punch/punch.page.spec.ts) checks that the link
alone sends nothing (`http.expectNone`), that the receipt is read before the question, that
`document.activeElement` is the button, the duplicate case without a button, and the self-expiry with a 500 ms
receipt. [`my-attendance.page.spec.ts`](../../apps/web/src/app/features/my-attendance/my-attendance.page.spec.ts)
drives the dialog through the DOM (tick a checkbox, add a row, type a time) and checks the exact request body and the
before/after rows; the workflow stepper's leave-types request is flushed in `afterEach`.
[`phase-b-pages.spec.ts`](../../apps/web/src/app/features/attendance/phase-b-pages.spec.ts) stubs
`URL.createObjectURL` and `HTMLAnchorElement.prototype.click` to see the CSV's file name.
