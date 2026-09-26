# 7. Forms

See also: [04-dependency-injection.md](./04-dependency-injection.md) for how
`NG_VALUE_ACCESSOR` gets resolved, [06-http-and-errors.md](./06-http-and-errors.md) for
`ApiProblem`/`ApiProblemError`.

## Typed reactive forms

Angular has two form APIs: template-driven (`[(ngModel)]`) and reactive
(`FormGroup`/`FormControl`, built and typed in the component class). This codebase uses
**only reactive forms** — nothing here uses `ngModel`.

```ts
// src/app/features/organization/create-unit-form.ts
protected readonly form = this.fb.group({
  // '' = nothing chosen yet (only when several kinds are possible); `required` rejects it.
  kind: ['', Validators.required],
  code: ['', [Validators.required, Validators.pattern(ORG_CODE_PATTERN)]],
  name: ['', [Validators.required, notBlank, Validators.maxLength(ORG_NAME_MAX)]],
  // The generic widens the type to `string | null`: null = inherit the parent's site (the default).
  siteId: this.fb.control<string | null>(null),
  validFrom: ['', [Validators.required, isoDate]],
});
```

`this.fb` is a `NonNullableFormBuilder` (`inject(NonNullableFormBuilder)`), not the
plain `FormBuilder`. The difference matters for both types and behavior:

- **Types.** `fb.group({...})`'s return type is inferred from the initial values:
  `form.controls.code` is a `FormControl<string>` (not `string | null`), and
  `form.getRawValue()` returns `{ kind: string; code: string; name: string; siteId:
  string | null; validFrom: string }` — a fully typed object, checked by the compiler
  everywhere it's used (e.g. `this.api.create({ kind: value.kind, code:
  value.code.trim(), ... })`).
- **Behavior.** "Non-nullable" means `form.reset()` puts each control back to its
  *initial value*, not `null` — with the plain `FormBuilder`, `reset()` on a
  `FormControl<string>` would actually reset to `null`, which is both surprising and
  untypeable without widening the type to `string | null`.

`siteId: this.fb.control<string | null>(null)` shows the explicit-generic form: from
the initial value `null` alone TypeScript would infer `FormControl<null>`, so the
generic states the real type. (Kinds used to be a TypeScript union pinned the same way;
since contract v2 they are data from `GET /org/kinds`, so `kind` is a plain `string`.)

## Dependent select options

The kind `<select>` of the create form offers only the kinds allowed under the chosen
parent — a department offers region and service, an agency only service. The options
are a `computed()` over the `parent` input and the kind catalogue:

```ts
// src/app/features/organization/create-unit-form.ts
protected readonly kindOptions = computed(() => this.kindCatalog.allowedChildKinds(this.parent().kind));

ngOnInit(): void {
  const options = this.kindOptions();
  // One possible kind: preselect it. Several: make the user choose (no silent default).
  this.form.patchValue({ kind: options.length === 1 ? options[0] : '', validFrom: this.defaultValidFrom() });
}
```

```html
<!-- create-unit-form.html -->
<select id="create-unit-kind" formControlName="kind" required ...>
  @if (kindOptions().length > 1) {
    <option value="" disabled>{{ t('org.form.kindPlaceholder') }}</option>
  }
  @for (option of kindOptions(); track option) {
    <option [value]="option">{{ kindCatalog.labelOf(option) }}</option>
  }
</select>
```

- Options come from data, so no kind name is written in the component.
- With several options the control starts at `''` and `Validators.required` refuses to
  submit until a kind is chosen — a silent default would create the wrong kind of unit
  when the user does not look at the field.
- The page decides whether the form can open at all: "Add a sub-unit" needs the server's
  `create_child` action **and** a non-empty `allowedChildKinds(unit.kind)`
  (`organization.page.ts`'s `canCreateUnder`).
- The move picker applies the same idea on the other side:
  `[kinds]="parentKinds()"` with `parentKinds = computed(() =>
  this.kindCatalog.allowedParentKinds(this.unit().kind))` in `change-unit-form.ts`.

## A `null` option in a typed form: "inherit"

A unit's own site is optional: `null` means "inherit the parent's site". The DOM can
only store strings in `<option value>`, so binding `[value]="null"` would put the
**string** `"null"` in the model. `[ngValue]` keeps the real value:

```html
<!-- create-unit-form.html -->
<select id="create-unit-site" formControlName="siteId" ...>
  <option [ngValue]="null">
    {{ t('org.form.siteInherit') }}{{ parentSite ? ' — ' + parentSite.name : '' }}
  </option>
  @for (option of sites(); track option.id) {
    <option [ngValue]="option.id">{{ option.name }} ({{ option.code }})</option>
  }
</select>
```

`[ngValue]` (from `ReactiveFormsModule`) lets the select accessor map any value —
`null`, a number, an object — to a generated DOM value and back. Rule of thumb: plain
strings → `[value]` is fine (the kind select); anything else → `[ngValue]`.

Two consequences in the component code:

- **Comparing, not testing truthiness.** In `change-unit-form.ts`, choosing "inherit" is
  a real change that must be sent as `siteId: null`:
  `if (value.siteId !== this.currentSiteId()) body.siteId = value.siteId;` — an
  `if (value.siteId)` would silently drop it.
- **What "unchanged" means.** The detail's `site` is the *effective* site; the form
  presets the unit's *own* site: `siteInherited ? null : site.id`.

## Validators that depend on inputs

The root unit cannot move and must keep a site. Which control is `required` therefore
depends on the `unit` input, which is only available from `ngOnInit`:

```ts
// src/app/features/organization/change-unit-form.ts
ngOnInit(): void {
  const { controls } = this.form;
  (this.isRoot() ? controls.siteId : controls.parentId).addValidators(Validators.required);
  this.form.reset({ ... });
}
```

`addValidators()` adds to the control's existing validators; the following `reset()`
re-runs them. The template hides the picker and the "inherit" option for the root. The
server enforces the same rules (`org-unit-root-immutable`,
`org-unit-root-site-required`); the client-side rule only saves a round trip.

## Connecting the template

```html
<!-- create-unit-form.html -->
<form [formGroup]="form" (ngSubmit)="submit()" novalidate>
  ...
  <input id="create-unit-code" type="text" formControlName="code" ... />
```

- `[formGroup]="form"` binds the `<form>` element to the whole `FormGroup`.
- `formControlName="code"` binds one `<input>` to `form.controls.code` — value,
  validity, `touched`/`dirty`, and `disabled` state all stay in sync both ways,
  automatically.
- `(ngSubmit)="submit()"` fires on submit (Enter in a field, or a submit button) and
  suppresses the browser's native full-page-reload form submission.
- `novalidate` turns off the *browser's* native validation bubbles (the red "please
  fill this field" tooltip) — Angular's own validators and this app's own error
  messages take over instead. `required` is still present on the inputs for
  accessibility semantics, just not relied upon for validation.

## Validators: built-in and custom

`Validators.required`, `.maxLength(n)`, `.pattern(re)` are built-in. Two custom ones
live in `org-forms.ts`, because the API contract needs checks Angular doesn't ship:

```ts
// src/app/features/organization/org-forms.ts
/** Fails with `{ required: true }` for a whitespace-only string. */
export const notBlank: ValidatorFn = (control: AbstractControl): ValidationErrors | null =>
  typeof control.value === 'string' && control.value.trim() === '' ? { required: true } : null;

/** Fails with `{ isoDate: true }` unless the value is empty (left to `required`) or a real `YYYY-MM-DD` date. */
export const isoDate: ValidatorFn = (control: AbstractControl): ValidationErrors | null =>
  !control.value || isIsoDate(control.value) ? null : { isoDate: true };
```

A `ValidatorFn` is just `(control) => ValidationErrors | null` — Angular calls it on
every value change and merges the object it returns into `control.errors`. `notBlank`
exists because `Validators.required` treats `"   "` as a non-empty (valid) string; the
contract requires names to be 1–120 chars *once trimmed*. `isoDate` defers to
`required` for emptiness (returns `null`, i.e. "no *this* error", for an empty value)
and only checks *format* — separation of concerns between "is something there" and "is
what's there valid".

## Cross-field validators (FormGroup-level)

A validator on a **control** sees only that control's value. "Confirm must equal
password" needs two values, so the validator goes on the **group**:

```ts
// src/app/features/auth/password-rules.ts
export const passwordsMatch: ValidatorFn = (group: AbstractControl): ValidationErrors | null => {
  const password: unknown = group.get('password')?.value;
  const confirm: unknown = group.get('confirm')?.value;
  if (!confirm) {
    return null; // left to `required` on the confirm control
  }
  return password === confirm ? null : { passwordMismatch: true };
};

// src/app/features/auth/password-setup.page.ts
protected readonly form = inject(NonNullableFormBuilder).group(
  {
    password: ['', [Validators.required, Validators.minLength(PASSWORD_MIN_LENGTH), Validators.maxLength(PASSWORD_MAX_LENGTH)]],
    confirm: ['', [Validators.required]],
  },
  // Second argument of group(): options for the GROUP itself, here its cross-field validator.
  { validators: [passwordsMatch] },
);
```

- **Where the error lands.** On `form.errors` (`{ passwordMismatch: true }`), **not** on
  `form.controls.confirm.errors`. The group is invalid, but the confirm control on its
  own is valid.
- **When it runs.** Whenever any child's value changes: a change bubbles up and the
  group re-validates. Editing the *password* after a matching confirm therefore brings
  the mismatch back. `password-setup.page.spec.ts` › "re-runs when either field changes"
  checks this.
- **Showing it next to a field.** The template combines both sources. `aria-invalid` has
  to be set by hand, because the control itself is valid:

  ```html
  <!-- password-setup.page.html -->
  @let confirm = form.controls.confirm;
  @let confirmInvalid = confirm.touched && (confirm.invalid || form.hasError('passwordMismatch'));
  <input id="setup-confirm" ... [attr.aria-invalid]="confirmInvalid" />
  ```

- **Why not `confirm.setErrors(...)` inside the validator?** Validators should be pure:
  value in, errors out. The confirm control re-runs its own validators on its next
  keystroke and replaces `.errors`, which would wipe an error written there from
  outside. It also makes behaviour depend on the order in which validators run.
- **Returning `null` for an empty confirm** leaves "empty" to `Validators.required`, so
  the user sees one message at a time ("confirm the password", then "does not match").
  `isoDate` makes the same "don't duplicate required" choice.

The server has rules the browser cannot check: "not the email's local part" and "not a
common password". It returns them as 422 `errors[{field: 'password', code}]`. The page
translates the **code** (`contains_email` →
`auth.passwordSetup.serverErrors.containsEmail`, via `PASSWORD_SERVER_ERROR_KEYS`) and
falls back to the server's `message` for a code it does not know yet. `applyServerErrors()`
(below) keeps only the message, so this page sets
`{ server: message, serverCode: code }` itself.

## `(ngSubmit)` and showing errors

```html
<!-- login.page.html -->
@let email = form.controls.email;
<input id="login-email" type="email" formControlName="email" ... [attr.aria-invalid]="email.invalid && email.touched" />
@if (email.invalid && email.touched) {
  <p class="field-error" id="login-email-error">
    @if (email.hasError('required')) { {{ t('auth.login.errors.emailRequired') }} }
    @else if (email.hasError('server')) { {{ email.getError('server') }} }
    @else { {{ t('auth.login.errors.emailInvalid') }} }
  </p>
}
```

The consistent pattern across every form in this app: show an error only when a control
is **both** `invalid` **and** `touched` — so a user isn't scolded for an empty required
field before they've even reached it. `touched` becomes `true` on blur, or (in
`submit()`) explicitly via `this.form.markAllAsTouched()` if the user tries to submit an
invalid form without having visited every field:

```ts
// create-unit-form.ts
protected submit(): void {
  this.formError.set(null);
  if (this.form.invalid) {
    this.form.markAllAsTouched();
    return;
  }
  ...
}
```

`org-forms.ts`'s `fieldErrorKey(control)` centralizes "which translation key for which
client-side error" (`required` → `org.form.errors.required`, `pattern` →
`org.form.errors.codePattern`, etc.) so every form's template calls the same helper
instead of repeating the `@if` chain.

## `applyServerErrors()` — mapping server validation onto controls

```ts
// src/app/core/http/apply-server-errors.ts
export function applyServerErrors(form: FormGroup, problem: ApiProblem): ApiFieldError[] {
  const unmatched: ApiFieldError[] = [];
  for (const error of problem.errors ?? []) {
    const control = form.get(error.field);
    if (!control) {
      unmatched.push(error);
      continue;
    }
    control.setErrors({ ...control.errors, server: error.message });
    control.markAsTouched();
  }
  return unmatched;
}
```

This is a plain function, not Angular-specific API, but it's the glue between chapter
6's `ApiProblem.errors[]` (`{field, code, message}` from a 422/409) and the Forms API:
`form.get('address.city')` resolves a **dotted path** through nested `FormGroup`s (so a
server error on a nested field lands on the right nested control), and
`control.setErrors({...control.errors, server: message})` adds a `server` key
*alongside* whatever client-side errors already exist, rather than replacing them —
`apply-server-errors.spec.ts`'s "keeps existing client-side errors" test locks this in.
Any error whose `field` matches no control in the form comes back in the returned
array, for the caller to show as a form-level message.

Note the last spec in that file: `control.setValue(...)` clears the `server` error
automatically — that's not special code, it's just how `setErrors` interacts with
Angular's normal revalidation: any value change re-runs the control's validators and
replaces `.errors` with their combined result, dropping the manually-added `server` key
unless it's re-added.

`org-forms.ts`'s `orgWriteError()` builds on top of this for the organization forms
specifically: it distinguishes 422 (field validation), 409 (business rule, may or may
not be tied to a field, `type: urn:hrforce:problem:<slug>` mapped to a translation key
via `SLUG_KEYS`; the site slugs `org-unit-root-site-required` / `site-not-found` →
`siteId` and `site-code-taken` → `code` land on their field even when the server sends
no `errors[]`, via `SLUG_FIELDS`), 403, 404, and everything else, always ending with either `null`
(all errors matched a control — no form-level message needed) or a `FormError` to show
above the form. `login.page.ts`'s `handleError()` shows the same shape at smaller scale
for a form with no nested groups.

## `ControlValueAccessor` in depth: the org-unit picker

A reactive form's controls normally wrap native elements (`<input>`, `<select>`).
`ControlValueAccessor` (CVA) is the interface that lets a **custom component** — here,
`<app-org-unit-picker>` — plug into `formControlName` exactly like a native input would.
`change-unit-form.html` treats it identically to any other field:

```html
<app-org-unit-picker
  formControlName="parentId"
  inputId="change-unit-parent"
  [kinds]="parentKinds()"
  [asOf]="validFrom() || undefined"
  [invalid]="parent.invalid && parent.touched"
  [describedBy]="parent.invalid && parent.touched ? 'change-unit-parent-error' : null"
/>
```

For this to work, `OrgUnitPicker` implements four CVA methods
(`src/app/shared/org-unit-picker/org-unit-picker.ts`):

```ts
writeValue(value: string | null | undefined): void {
  if (!value) {
    this.selected.set(null);
    this.query.set('');
    return;
  }
  if (this.selected()?.id !== value) {
    this.lookups.next(value);
  }
}

registerOnChange(fn: (value: string | null) => void): void {
  this.onChange = fn;
}

registerOnTouched(fn: () => void): void {
  this.onTouched = fn;
}

setDisabledState(isDisabled: boolean): void {
  this.disabled.set(isDisabled);
  if (isDisabled) this.close();
}
```

- **`writeValue(value)`** — called by the Forms API whenever the *model* changes from
  outside the widget: `setValue()`, `patchValue()`, `reset()`, or (as
  `change-unit-form.ts` does in `ngOnInit`) `form.reset({ parentId:
  this.currentParentId(), ... })`. The picker's own value is a unit **id**
  (`string | null`), but a bare id has no label to show in the text box — so
  `writeValue` triggers `this.lookups.next(value)`, an RxJS pipeline (see chapter 03)
  that fetches the unit (`OrgApi.get(id)`) and, once it resolves, sets `selected` and
  `query` to show its label. `writeValue` must **not** call `onChange` itself — it's the
  form telling the control what to display, not the control reporting a user choice.
- **`registerOnChange(fn)` / `registerOnTouched(fn)`** — the Forms API hands the
  picker two callbacks once, at setup. The picker stores them (`private onChange = ...`,
  `private onTouched = ...`) and calls them **itself**, only in response to genuine user
  action: `choose(unit)` calls `this.onChange(unit.id)` when the user picks an option;
  `onFocusOut()` calls `this.onTouched()` when focus truly leaves the whole widget (not
  just moves from the text input to a listbox option inside it — see that method's
  comment on checking `event.relatedTarget`).
- **`setDisabledState(isDisabled)`** — called when the bound `FormControl` is
  `.disable()`d/`.enable()`d; the picker mirrors that into its own `disabled` signal
  (which the template binds to the native `<input>`'s `[disabled]`) and closes any open
  listbox.

Everything else in the picker — `[kinds]`, `[asOf]`, `[invalid]`, `[describedBy]` — are
ordinary signal `input()`s, unrelated to CVA; they configure the search (which kinds,
as-of date) and let the *surrounding form* forward its own validity state
(`[invalid]="parent.invalid && parent.touched"`) onto the picker's `aria-invalid`,
because — as the code comments note — "the CVA cannot see the control itself." A CVA
only receives value/disabled/touched-registration calls, not the `FormControl` object,
so anything else the form wants to communicate has to be an explicit input.

### The combobox itself: ARIA, not a new pattern

The picker is a WAI-ARIA "combobox with list autocomplete": `role="combobox"` on the
text `<input>`, `aria-expanded`, `aria-controls` pointing at the listbox's id,
`aria-activedescendant` pointing at the highlighted `role="option"` element, and a
`aria-live="polite"` status region announcing search progress. Keyboard handling
(`onKeydown`) implements ArrowDown/ArrowUp to move the highlighted option,
Home/End to jump to the first/last (only once the list is open — otherwise the keys are
left alone so the caret still moves inside the text), Enter to choose the highlighted
option (or fall through to submit the surrounding `<form>` if the list isn't open),
and Escape to close the list, then clear typed text, then (if there's nothing left to
do) fall through to a surrounding dialog's own Escape handling. None of this is Angular
API — it's plain DOM event handling — but it's included here because it's the reference
implementation to copy for any future custom form control that needs a
picker/autocomplete UI (see chapter 10's "add a reusable form control" recipe).

## An array value: `FormControl<string[]>` or `FormArray`?

A role's permissions form a **list of codes**. Reactive forms offer two shapes for that.
The role editor uses the second.

| | `FormArray<FormControl<boolean>>` | `FormControl<string[]>` (chosen) |
|---|---|---|
| Template | one checkbox per control: `formArrayName` + `[formControlName]="i"` | a custom control (CVA) bound once: `formControlName="permissions"` |
| Value | `[true, false, true, …]`, which must be converted to/from codes | `['employee.read', 'employee.salary.read']`, the API's own shape |
| Order coupling | index `i` must match the catalogue order, which loads async and can grow | none, the CVA keeps catalogue order when emitting |
| Validation | per item, plus an array-level validator | one validator on one control (`atLeastOne`) |
| Server error for "the whole list" (`role-escalation`) | on the array | on the control, shown above the checklist |
| Good for | rows with their own state: add/remove phone numbers, each with a `pattern` | a set of choices from a catalogue |

```ts
// src/app/features/access/role-editor.page.ts
protected readonly form = this.fb.group({
  code: ['', [Validators.required, Validators.pattern(ROLE_CODE_PATTERN), Validators.maxLength(32)]],
  names: this.fb.group({
    fr: ['', [Validators.required, notBlank, Validators.maxLength(ROLE_NAME_MAX)]],
    ar: ['', [Validators.required, notBlank, Validators.maxLength(ROLE_NAME_MAX)]],
    en: ['', [Validators.required, notBlank, Validators.maxLength(ROLE_NAME_MAX)]],
  }),
  permissions: this.fb.control<string[]>([], atLeastOne),
});
```

```html
<!-- src/app/features/access/role-editor.page.html -->
<app-permission-checklist
  formControlName="permissions"
  idPrefix="role-perm"
  [invalid]="permissions.invalid && permissions.touched"
  [describedBy]="permissions.invalid && permissions.touched ? 'role-permissions-error' : null"
/>
```

Plain checkboxes cannot bind to a `string[]` control with `formControlName`, so
[`features/access/permission-checklist.ts`](../../apps/web/src/app/features/access/permission-checklist.ts)
is a small `ControlValueAccessor` (the picker below is the full introduction). Its
`writeValue(codes)` fills a signal. Each `(change)` builds a **new** array in catalogue
order and calls `onChange(list)`. `setDisabledState` disables every checkbox when the
editor calls `form.disable()` for a system role.

Two more things in that form:

- **A nested group.** `names` is a `FormGroup` inside the form. The template wraps its
  inputs in `<div formGroupName="names">`, and inside it `[formControlName]="lang"`
  resolves against `names`. The value is `{ fr, ar, en }`, the contract's shape, and a 422
  `errors[].field` of `names.fr` finds its control through `form.get('names.fr')`
  (`applyServerErrors` follows dotted paths).
- **`getRawValue()` vs `value`.** In edit mode the code control is `disable()`d, because
  codes are immutable. `form.value` **omits** disabled controls, while `getRawValue()`
  includes them. Use `getRawValue()` when building a request body.

## A checkbox control

`<input type="checkbox" formControlName="includeDescendants">` binds a
`FormControl<boolean>`. Angular chooses the checkbox value accessor from the input type,
so the control follows `checked`, not `value`
([`features/access/grant-form.html`](../../apps/web/src/app/features/access/grant-form.html),
default `true` per the contract).

## Dates: a cross-field rule and a validator that reads a signal

The add-grant form's "to > from" is a **group** validator, like `passwordsMatch` above:

```ts
// src/app/features/access/access-forms.ts
export const validToAfterFrom: ValidatorFn = (group: AbstractControl): ValidationErrors | null => {
  const from: unknown = group.get('validFrom')?.value;
  const to: unknown = group.get('validTo')?.value;
  if (!isIsoDate(from) || !isIsoDate(to)) return null; // empty/invalid: left to the controls' own validators
  return to > from ? null : { dateOrder: true }; // [from, to): to = from is never effective
};
```

The end-grant dialog's limits depend on **which** grant is being ended. Instead of
calling `setValidators()` on every open, its validator receives a getter over a signal:

```ts
// src/app/features/access/user-detail.page.ts
dateWithin(() => {
  const grant = this.ending();
  return grant ? { min: grant.validFrom, max: grant.validTo } : null;
}),
```

A validator is **not** a reactive context. It runs on value changes, not on signal
changes. So `openEnd()` sets `ending` first and *then* `endForm.reset({ validTo: … })`,
which re-runs validation against the new grant.

## Business-rule slugs → fields: `problemToForm()`

The Authorization API reports separation-of-duties rules as 409 slugs. Where each one is
best explained is a **UI decision**, so each form declares a table
([`core/http/problem-form.ts`](../../apps/web/src/app/core/http/problem-form.ts)):

```ts
// src/app/features/access/access-forms.ts
export const GRANT_SLUGS: SlugTable = {
  'grant-self': { key: 'access.problems.grantSelf' },
  'grant-out-of-scope': { key: 'access.problems.grantOutOfScope', field: 'orgUnitId' },
  'grant-escalation': { key: 'access.problems.grantEscalation', field: 'roleId' },
  'grant-user-not-member': { key: 'access.problems.grantUserNotMember' },
  'grant-dates': { key: 'access.problems.grantDates', field: 'validTo' },
};
```

`problemToForm(form, error, GRANT_SLUGS)` puts `{ serverKey: key }` on the named control
(translated, since the API speaks English only), or returns `{ key }` for a form-level
message when the rule has no field, or its field has no control in this form. That is
the case for `grant-user-not-member`, whose `userId` the user cannot edit. Other
problems, typically 422s, fall back to `applyServerErrors()`.

A server error on a control **blocks re-submitting until that field is edited**. The
control is invalid, and any value change re-runs its validators, which replaces
`errors`. That is the behaviour we want: the user must change something before trying
again. `org-forms.ts` predates the helper and keeps its own copy of the idea.

## Next

[08-i18n-and-rtl.md](./08-i18n-and-rtl.md) — Transloco, and the RTL rules `org-forms`
and every template here follow.
