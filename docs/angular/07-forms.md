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
  kind: this.fb.control<CreatableOrgUnitKind>('region', Validators.required),
  code: ['', [Validators.required, Validators.pattern(ORG_CODE_PATTERN)]],
  name: ['', [Validators.required, notBlank, Validators.maxLength(ORG_NAME_MAX)]],
  validFrom: ['', [Validators.required, isoDate]],
});
```

`this.fb` is a `NonNullableFormBuilder` (`inject(NonNullableFormBuilder)`), not the
plain `FormBuilder`. The difference matters for both types and behavior:

- **Types.** `fb.group({...})`'s return type is inferred from the initial values:
  `form.controls.code` is a `FormControl<string>` (not `string | null`), and
  `form.getRawValue()` returns `{ kind: CreatableOrgUnitKind; code: string; name:
  string; validFrom: string }` — a fully typed object, checked by the compiler
  everywhere it's used (e.g. `this.api.create({ kind: value.kind, code:
  value.code.trim(), ... })`).
- **Behavior.** "Non-nullable" means `form.reset()` puts each control back to its
  *initial value*, not `null` — with the plain `FormBuilder`, `reset()` on a
  `FormControl<string>` would actually reset to `null`, which is both surprising and
  untypeable without widening the type to `string | null`.

`change-unit-form.ts`'s `kind: this.fb.control<CreatableOrgUnitKind>('region', ...)`
shows the explicit-generic form: pinning a control's type to a union narrower than what
TypeScript would infer from just the string literal `'region'`.

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

## `(ngSubmit)` and showing errors

```html
<!-- login.page.html -->
@let username = form.controls.username;
<input id="login-username" formControlName="username" ... [attr.aria-invalid]="username.invalid && username.touched" />
@if (username.invalid && username.touched) {
  <p class="field-error" id="login-username-error">
    @if (username.hasError('required')) { {{ t('auth.login.errors.usernameRequired') }} }
    @else if (username.hasError('server')) { {{ username.getError('server') }} }
    @else { {{ t('errors.generic') }} }
  }
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
via `SLUG_KEYS`), 403, 404, and everything else, always ending with either `null`
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

## Next

[08-i18n-and-rtl.md](./08-i18n-and-rtl.md) — Transloco, and the RTL rules `org-forms`
and every template here follow.
