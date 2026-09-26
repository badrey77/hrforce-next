# 14. Big forms and URL state

The Employees screens ([`docs/contracts/employment.md`](../contracts/employment.md) › Web)
are the first "real HR" pages: a list people filter all day, a create form with a dozen
fields in five sections, and a detail page with tabs and several small write forms. That
makes them the place to learn:

| Question | Tool | File |
|---|---|---|
| Keep a list's filters, sort and page shareable and back-button friendly | the URL's query string as the only state; signal inputs; `router.navigate` with `merge` / `replaceUrl` | `features/employees/employees.page.ts`, `employee-list-state.ts` |
| Model a form with sections | nested typed `FormGroup`s, `formGroupName` | `features/employees/employee-create.page.ts` / `.html` |
| One rule for many fields (NIN 18 digits, RIB 20, NSS 10–15) | a **validator factory** | `features/employees/employee-forms.ts` (`digits`) |
| A rule that spans two sections | a validator on the **root** group | `employee-forms.ts` (`birthBeforeHire`) |
| Sections only some users may fill | disabled groups, toggled by an `effect()` | `employee-create.page.ts` |
| Error text for ~25 fields without 25 copies of the markup | a child component fed by `control.events` | `features/employees/field-error.ts` |
| Map server errors onto nested controls | a field → path table | `employee-forms.ts` (`employeeProblemToForm`) |
| Tabs on a detail page | a local `linkedSignal`, not child routes | `features/employees/employee-detail.page.ts` |
| Show the Arabic name when there is one | a pure pipe with the language as argument | `shared/display-name/display-name.pipe.ts` |

Paths are under `apps/web/src/app/`.

## 1. URL as state

### The loop

The employee list has ten pieces of state: `q`, `unitId`, `includeSubUnits`, `siteId`,
`status`, `asOf`, `sort`, `dir`, `page`, `pageSize`. **All of them live in the query
string**, and nowhere else:

```
URL ──router──▶ signal inputs ──computed──▶ query ──httpResource──▶ list
 ▲                                                                   │
 └──────────── router.navigate({ queryParams, merge }) ◀── user clicks┘
```

Reading: with `withComponentInputBinding()` (chapter 05) each query param arrives as a
signal input of the same name, and one `computed()` turns the raw strings into a validated
query:

```ts
// features/employees/employees.page.ts
readonly q = input<string>();
readonly unitId = input<string>();
// … one input per param …

protected readonly query = computed<EmployeeQuery>(() =>
  resolveQuery({ q: this.q(), unitId: this.unitId(), /* … */ page: this.page(), pageSize: this.pageSize() }),
);

protected readonly list = inject(EmployeesApi).listResource(this.query);
```

`resolveQuery()` ([`employee-list-state.ts`](../../apps/web/src/app/features/employees/employee-list-state.ts))
is plain TypeScript: a URL is user input, so `?page=-3&sort=salary` falls back to the
defaults instead of throwing. The resource
([`core/employees/employees-api.ts`](../../apps/web/src/app/core/employees/employees-api.ts))
re-runs whenever `query` changes and cancels a request still in flight.

Writing: every widget only **navigates**.

```ts
// features/employees/employees.page.ts
protected update(change: Partial<EmployeeQuery>, options: { replaceUrl?: boolean } = {}): void {
  void this.router.navigate([], {
    relativeTo: this.route,
    queryParams: toQueryParams({ page: 1, ...change }),
    queryParamsHandling: 'merge',
    replaceUrl: options.replaceUrl ?? false,
  });
}
```

- `queryParamsHandling: 'merge'` keeps the other filters.
- `toQueryParams()` writes `null` for a default value, which **removes** the param: the
  plain list stays `/employees`, and a shared link carries only what was chosen.
- `page: 1` first, so any filter or sort change goes back to page 1 (page 7 of the old
  result means nothing for the new one). Paging passes its own `page`.

There is no `filters` signal, no `loadList()` method, no "sync the URL" effect. The
component cannot disagree with the URL because it keeps no copy of it. The widgets
display the URL (`[value]="current.q"`, `<option [selected]="status === current.status">`).

### Back and forward

Each navigation pushes a history entry. Back restores the previous URL; the router
re-binds the inputs of the **same component instance** (the route did not change, only
its query), `query` recomputes, the resource fetches. Nothing special was written for
it. The test "follows the URL when it changes from outside" in
`employees.page.spec.ts` navigates to a new URL, which is exactly what Back does, and
checks that the search box and the status select follow.

This is also why the widgets must read the URL rather than keep their own state: after
Back, a search box that owned its text would show the newer search over the older list.

### Why `replaceUrl` for keystrokes

The search box is debounced (300 ms, a `Subject` + `debounceTime`, as in the org-unit
picker, chapter 07) and then navigates with `replaceUrl: true`:

```ts
// features/employees/employees.page.ts
this.searches
  .pipe(
    debounceTime(EMPLOYEE_SEARCH_DEBOUNCE_MS),
    filter((q) => q !== this.query().q),
    takeUntilDestroyed(),
  )
  .subscribe((q) => this.update({ q }, { replaceUrl: true }));
```

`replaceUrl` **replaces** the current history entry instead of adding one. Typing
"benali" with two pauses would otherwise leave `?q=ben`, `?q=bena`, `?q=benali` in the
history, and Back would step through half-typed searches instead of leaving the search.
Choices that are deliberate (a status, a sort click, a page) push an entry, because going
back to them is useful.

The `filter` compares with the URL, not with the previous keystroke
(`distinctUntilChanged` would): after Back restored an older search, typing the newer
text again must still navigate.

### A custom control in the filter bar

The unit filter is the org-unit picker, a `ControlValueAccessor` (chapter 07). Without a
form around it, a standalone `FormControl` plugs it in: `[formControl]="unitControl"`.
Two small bridges connect it to the URL:

```ts
// features/employees/employees.page.ts
effect(() => {
  const unitId = this.query().unitId;
  if (this.unitControl.value !== unitId) this.unitControl.setValue(unitId, { emitEvent: false });
});
this.unitControl.valueChanges.pipe(takeUntilDestroyed()).subscribe((unitId) => this.update({ unitId }));
```

`emitEvent: false` matters: writing the URL's value into the control is not a user
choice, so it must not come back as `valueChanges` and navigate again.

### Sortable headers

The sorted column's `<th>` gets `aria-sort="ascending"`/`"descending"` (only that one);
the header text is a `<button>` so it works from the keyboard. Same column → flip the
direction; another column → sort by it ascending. The server sorts (`sort`/`dir`), so
the order spans all pages.

### When not to put state in the URL

State worth sharing, bookmarking or going back to belongs in the URL: filters, sort,
page, the org chart's `asOf`. State that is a view of data already loaded does not: which
tab of an employee is open, whether an edit form is shown (§4).

## 2. Nested typed forms

### Sections as groups

```ts
// features/employees/employee-create.page.ts
protected readonly form = this.fb.group(
  {
    identity: this.fb.group({
      lastName: ['', [Validators.required, notBlank, Validators.maxLength(NAME_MAX)]],
      // …
      sex: this.fb.control<Sex | null>(null),
      nin: ['', digits(18)],
    }),
    employment: this.fb.group({
      matricule: ['', [Validators.required, Validators.pattern(MATRICULE_PATTERN)]],
      hireDate: [todayIso(), [Validators.required, isoDate]],
    }),
    assignment: this.fb.group({ orgUnitId: this.fb.control<string | null>(null, Validators.required), /* … */ }),
    salary: this.fb.group({ baseSalary: ['', money] }),
    bank: this.fb.group(
      { rib: ['', digits(20)], bankName: ['', Validators.maxLength(NAME_MAX)] },
      { validators: bothOrNeither('rib', 'bankName') },
    ),
    nss: this.fb.group({ nss: ['', digits(10, 15)] }),
  },
  { validators: birthBeforeHire },
);
```

TypeScript infers the whole tree: `form.controls.identity.controls.nin` is a
`FormControl<string>`, `form.getRawValue().assignment.orgUnitId` is `string | null`.
Each group has its own `valid`, `touched`, `disabled`. Dotted paths work wherever a path
is accepted: `form.get('identity.nin')`.

In the template, `formGroupName` scopes the `formControlName`s inside it, so the markup
mirrors the model:

```html
<!-- features/employees/employee-create.page.html -->
<fieldset class="section" formGroupName="identity" data-section="identity">
  …
  <input id="new-nin" type="text" inputmode="numeric" formControlName="nin" … />
```

**The form's shape is not the wire format.** The API reads a flat body (person and
first-assignment fields at the top level, sensitive blocks nested). The submit flattens:
`body()` in `employee-create.page.ts` builds it from `getRawValue()`, trimming, turning
blanks into `null`, stripping spaces from digit fields and normalising money. Sections
are a UI decision; they should not leak into the API, and the API's shape should not
dictate the screen.

### Validator factories

`Validators.pattern(/^\d{18}$/)` works for one field. The contract has three digit-only
identifiers with different lengths and wants one kind of message for all of them. A
**factory** returns a `ValidatorFn` that closes over its parameters:

```ts
// features/employees/employee-forms.ts
export function digits(min: number, max: number = min): ValidatorFn {
  const pattern = new RegExp(`^\\d{${min},${max}}$`);
  return (control: AbstractControl): ValidationErrors | null => {
    const value: unknown = control.value;
    if (typeof value !== 'string' || value.trim() === '') return null;
    return pattern.test(digitsOnly(value)) ? null : { digits: { min, max } };
  };
}
```

Three habits worth copying:

- **Empty is not an error.** "Required" is `Validators.required`'s job. An optional NIN
  is optional because nobody added `required`.
- **The error carries its parameters** (`{ digits: { min: 10, max: 15 } }`), like
  Angular's own `maxlength` error. One translation with a placeholder,
  `"{{count}} chiffres attendus."`, serves NIN, RIB and NSS (`fieldErrorParams()`).
- **Normalise in one place.** RIBs are typed in groups of four. The validator ignores
  spaces and the submit strips them with the same `digitsOnly()`, so the rule and the
  payload agree on what the value is. `money` + `normaliseMoney` do the same for `85000,5`
  → `"85000.50"` (money is a decimal **string**, never a float; see
  `core/employees/employees.models.ts`).

The same functions guard the detail page's edit forms (`person-form.ts`,
`sensitive-forms.ts`), so create and edit cannot drift.

### Cross-field and cross-section rules

A rule about two controls sits on their closest common ancestor (chapter 07 has the
single-group case). `bothOrNeither('rib', 'bankName')` sits on the bank group: leave the
optional section empty, or fill both. "Hired after birth" reads two **sections**, so it
sits on the root:

```ts
// features/employees/employee-forms.ts
export const birthBeforeHire: ValidatorFn = (root) => {
  const birth: unknown = root.get('identity.birthDate')?.value;
  const hire: unknown = root.get('employment.hireDate')?.value;
  if (!isIsoDate(birth) || !isIsoDate(hire)) return null;
  return birth < hire ? null : { birthAfterHire: true };
};
```

The error is on the root (`form.hasError('birthAfterHire')`), and the template shows it
next to the field the user is likely to fix, the hire date.

A validator can also read a **signal or an input** through a getter:
`notBefore(() => this.minDate())` in `assignment-form.ts`. It is read each time
validation runs, so one validator serves every employee. One trap, met here: validators
run when the control is **created** (field initialisation), before inputs are set, and
reading a required input then throws `NG0950`. `notBefore` therefore checks the value
first (empty → no rule) and the form sets its default date in `ngOnInit`.

### Optional sections: disabled groups

Salary, bank and NSS appear only for users who may write them
(`employee.salary.update`, …). They exist in the model for everyone; an `effect()`
disables the ones not allowed:

```ts
// features/employees/employee-create.page.ts
effect(() => {
  toggle(salary, this.canSalary());
  toggle(bank, this.canBank());
  toggle(nss, this.canNss());
});
```

A disabled control is left out of its parent's validity and of `form.value`, so a hidden
section can never block the submit. (`getRawValue()` includes disabled controls; the
submit therefore checks `controls.salary.enabled` before sending the block.) Adding and
removing controls (`addControl`/`removeControl`) would work too but makes the form's type
optional everywhere.

This is **comfort**. The server stays the authority and answers 403 `forbidden-field`
(below). And "may write somewhere" is not "may write for this unit": on the detail page,
buttons come from the record's `_actions` (chapter 12).

### Error text in a child component: `control.events`

Each field needs "invalid and touched → show the right message". Written inline that is
five lines per field. `<app-field-error [control]="c" errorId="…" />` does it once, but a
child component has a zoneless OnPush problem: it re-renders only when an input changes
or a signal it reads changes, and the `control` input is the **same object** before and
after a blur or a server error. So it listens to the control:

```ts
// features/employees/field-error.ts
protected readonly error = toSignal(
  toObservable(this.control).pipe(
    switchMap((control) => control.events.pipe(startWith(null), map(() => viewOf(control)))),
  ),
  { initialValue: null },
);
```

`AbstractControl.events` emits on every value, status, touched, pristine and submit
change. The page's own template still binds `aria-invalid` on the `<input>` (it
re-renders on the input's DOM events).

### Server errors onto nested controls

The API names body properties (`matricule`, `nin`, `rib`, or a block: `salary`); the form
nests them (`employment.matricule`). A path table translates:

```ts
// features/employees/employee-forms.ts
export const CREATE_FIELD_PATHS: FieldPaths = {
  nin: 'identity.nin',
  matricule: 'employment.matricule',
  orgUnitId: 'assignment.orgUnitId',
  salary: 'salary.baseSalary',
  rib: 'bank.rib',
  // …
};
```

`employeeProblemToForm(form, error, CREATE_SLUGS, CREATE_FIELD_PATHS)` then applies the
slug table (chapter 07): `matricule-taken` → "Ce matricule est déjà utilisé." on the
matricule; `forbidden-field` with `errors[{field: 'rib'}]` → "Vous n'avez pas le droit de
renseigner ce champ." on the RIB; `forbidden-scope` → on the unit picker;
`employment-open` (no field) above the form. After 201, the page navigates to
`['/employees', created.id]`.

## 3. The list/detail pattern

| | List (`/employees`) | Detail (`/employees/:id`) |
|---|---|---|
| Input | ten query params | the `:id` route param |
| Resource | `listResource(query)` | `detailResource(id)` |
| State in the URL | everything | only the id |
| Writes | none (links to detail and create) | small forms, each emitting `saved` |
| After a write | — | `employee.reload()` |

**Reload after writes.** Every form on the detail page emits `saved`; the page calls
`employee.reload()`. The resource keeps showing the current value while it reloads (status
`reloading`), then the server's answer replaces it: the closed previous assignment, the
new `_actions`, a status that became `ended`. The page never patches the detail from what
it sent, because the derived fields (the previous assignment's end date, the effective
site) are computed by the server.

## 4. Tabs: a local signal, not child routes

```ts
// features/employees/employee-detail.page.ts
protected readonly tabs = computed<readonly EmployeeTab[]>(() => {
  const e = this.detail();
  const tabs: EmployeeTab[] = ['identity', 'assignments'];
  if (e && !isRedacted(e, 'salary')) tabs.push('pay');
  if (e && (!isRedacted(e, 'bank') || !isRedacted(e, 'nss'))) tabs.push('bank');
  if (this.canAudit()) tabs.push('history');
  return tabs;
});
protected readonly tab = linkedSignal<string, EmployeeTab>({ source: this.id, computation: () => 'identity' });
protected readonly activeTab = computed<EmployeeTab>(() => (this.tabs().includes(this.tab()) ? this.tab() : 'identity'));
```

Child routes (`/employees/:id/pay`) would give each tab its own URL. Here every tab is a
view of the **same** loaded detail, so child routes would need that detail shared (a
service or a resolver), and a redacted tab would need a guard. A `linkedSignal` of the id
is enough: it goes back to Identity when another employee opens, and `activeTab` falls
back to Identity if a reload redacts the tab being shown. Choose child routes when tabs
load different data, or when a link to one tab is worth sharing.

The History tab reuses chapter 13's pieces directly (`@defer (on viewport; prefetch on
idle)` around `<app-timeline [subject]="'employee:' + e.id">`), because the page already
has its own tab bar and does not need `<app-history-tabs>`.

## 5. Names in the UI language

Employees and units may have an Arabic name. The `displayName` pipe picks it in the
Arabic UI and falls back to the Latin name:

```html
<!-- features/employees/employees.page.html -->
<a [routerLink]="['/employees', item.id]">{{ item.person | displayName: lang() }}</a>
<td>{{ item.unit | displayName: lang() }}</td>
```

It follows chapter 13's rule: the language is an **argument**, so a language switch
re-runs the pure pipe. The pipe's body is the exported function `displayNameOf()`, used
where a template cannot help: the organization page's id → name map (a `computed()` that
reads the language), and the org-unit picker's input text (an `effect()` rewrites it on
a language switch, because an input's value is state, not an expression).

## 6. Testing

- **URL state** (`employees.page.spec.ts`, `RouterTestingHarness` with
  `withComponentInputBinding()`): navigate to a URL with query params and assert the API
  params and the widgets; click a header and assert `router.url`'s query params and
  `aria-sort`; `vi.spyOn(router, 'navigate')` to check `replaceUrl: true` for the
  debounced search (real timers: wait `EMPLOYEE_SEARCH_DEBOUNCE_MS`) and `false` for a
  select.
- **Forms** (`employee-create.page.spec.ts`): `Session.set(meWith([...]))` to show or hide
  sections; drive `input`/`blur`/`submit` events; assert the flattened body and the
  field messages for 403/409 problems. A control flagged by the server stays invalid
  until its value changes, so re-submitting requires changing the value first.
- **Pure parts** without TestBed: validators, `employeeProblemToForm`, `resolveQuery` /
  `toQueryParams` (`employee-forms.spec.ts`), the pipe (`display-name.pipe.spec.ts`).
- **Lazy navigation**: after a create, the router loads the detail chunk before
  `router.url` changes; the spec waits in a short polling loop.

## Next

Chapter 10 has two recipes built on this chapter: **"add a list page with filters in the
URL"** and **"add a sensitive section"**.
