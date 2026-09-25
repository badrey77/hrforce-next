/**
 * Form to create a region or site under a given parent: `<app-create-unit-form [parent]="…" (saved)="…" />`.
 *
 * Angular concepts:
 * - **Typed reactive forms.** `NonNullableFormBuilder.group({...})` builds a `FormGroup` whose type is inferred
 *   from the initial values: `form.controls.code` is a `FormControl<string>`, `getRawValue()` returns
 *   `{ kind: CreatableOrgUnitKind; code: string; … }`. "Non-nullable" means `reset()` goes back to the initial value
 *   instead of `null`. The template connects with `[formGroup]` on `<form>` and `formControlName` on each input.
 * - **`output()`** declares an event the parent listens to with `(saved)="…"`; `this.saved.emit(value)` fires it.
 * - **`OnInit` / `ngOnInit()`**: a lifecycle hook that runs once, after the first input values are set. Inputs are
 *   NOT available in field initializers or the constructor, so presetting the form from `parent()` happens here.
 * - **`(ngSubmit)`** fires on submit (Enter or the submit button) and suppresses the browser's page reload.
 *   `novalidate` turns off native browser validation bubbles: Angular validators and our messages take over.
 *
 * Server errors: `orgWriteError()` maps 422/409 `errors[]` onto controls (e.g. a taken code → the `code` field) and
 * returns a form-level message for problems not tied to a field.
 */
import { ChangeDetectionStrategy, Component, computed, inject, input, type OnInit, output, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import { OrgApi } from '../../core/org/org-api';
import { childKindsOf, type CreatableOrgUnitKind, type OrgUnitDetail } from '../../core/org/org.models';
import {
  fieldErrorKey,
  type FormError,
  isoDate,
  notBlank,
  ORG_CODE_PATTERN,
  ORG_NAME_MAX,
  orgWriteError,
} from './org-forms';

@Component({
  selector: 'app-create-unit-form',
  imports: [ReactiveFormsModule, TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './create-unit-form.html',
})
export class CreateUnitForm implements OnInit {
  private readonly api = inject(OrgApi);
  private readonly fb = inject(NonNullableFormBuilder);

  readonly parent = input.required<OrgUnitDetail>();
  /** Preset of the "effective date" field (the page's as-of date). */
  readonly defaultValidFrom = input.required<string>();
  readonly saved = output<OrgUnitDetail>();
  readonly cancelled = output<void>();

  protected readonly form = this.fb.group({
    // The generic pins the control's type to the union; the initial value is replaced in ngOnInit.
    kind: this.fb.control<CreatableOrgUnitKind>('region', Validators.required),
    code: ['', [Validators.required, Validators.pattern(ORG_CODE_PATTERN)]],
    name: ['', [Validators.required, notBlank, Validators.maxLength(ORG_NAME_MAX)]],
    validFrom: ['', [Validators.required, isoDate]],
  });

  protected readonly kinds = computed(() => childKindsOf(this.parent().kind));
  protected readonly submitting = signal(false);
  protected readonly formError = signal<FormError | null>(null);
  protected readonly fieldErrorKey = fieldErrorKey;

  ngOnInit(): void {
    this.form.patchValue({ kind: this.kinds()[0] ?? 'region', validFrom: this.defaultValidFrom() });
  }

  protected submit(): void {
    this.formError.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const value = this.form.getRawValue();
    this.submitting.set(true);
    this.api
      .create({
        kind: value.kind,
        code: value.code.trim(),
        name: value.name.trim(),
        parentId: this.parent().id,
        validFrom: value.validFrom,
      })
      .subscribe({
        next: (unit) => {
          this.submitting.set(false);
          this.saved.emit(unit);
        },
        error: (error: unknown) => {
          // Setting a signal the template reads is what re-renders this OnPush view with the new control errors.
          this.formError.set(orgWriteError(this.form, error));
          this.submitting.set(false);
        },
      });
  }
}
