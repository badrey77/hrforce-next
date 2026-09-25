/**
 * Form to rename and/or move a unit from an effective date: `<app-change-unit-form [unit]="…" (saved)="…" />`.
 * The API records it as a new version (`PATCH /org/units/:id`); only the fields that changed are sent.
 *
 * Angular concepts (see create-unit-form.ts for typed reactive forms, `output()` and `ngOnInit`):
 * - **Custom form control in a reactive form**: the parent unit is chosen with `<app-org-unit-picker
 *   formControlName="parentId">`. Because the picker implements ControlValueAccessor, the form treats it exactly
 *   like an `<input>`: its value is the chosen unit id, `required` applies, `applyServerErrors` can flag it.
 * - **`toSignal()`** (from `@angular/core/rxjs-interop`) turns an Observable into a signal. The effective date
 *   control's `valueChanges` becomes `validFrom()`, which feeds the picker's `[asOf]` so it only offers parents that
 *   exist on that date. `toSignal` subscribes immediately and unsubscribes when the component is destroyed.
 */
import { ChangeDetectionStrategy, Component, computed, inject, input, type OnInit, output, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import { OrgApi } from '../../core/org/org-api';
import { type ChangeOrgUnit, type OrgUnitDetail, parentKindsOf } from '../../core/org/org.models';
import { OrgUnitPicker } from '../../shared/org-unit-picker/org-unit-picker';
import { fieldErrorKey, type FormError, isoDate, notBlank, ORG_NAME_MAX, orgWriteError } from './org-forms';

@Component({
  selector: 'app-change-unit-form',
  imports: [ReactiveFormsModule, TranslocoDirective, OrgUnitPicker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './change-unit-form.html',
})
export class ChangeUnitForm implements OnInit {
  private readonly api = inject(OrgApi);
  private readonly fb = inject(NonNullableFormBuilder);

  readonly unit = input.required<OrgUnitDetail>();
  readonly defaultValidFrom = input.required<string>();
  readonly saved = output<OrgUnitDetail>();
  readonly cancelled = output<void>();

  protected readonly form = this.fb.group({
    name: ['', [Validators.required, notBlank, Validators.maxLength(ORG_NAME_MAX)]],
    // `string | null`: "no parent chosen" is null, which is what the picker writes.
    parentId: this.fb.control<string | null>(null),
    validFrom: ['', [Validators.required, isoDate]],
  });

  protected readonly validFrom = toSignal(this.form.controls.validFrom.valueChanges, { initialValue: '' });
  /** Kinds the unit may move under; empty for the company root, which cannot move. */
  protected readonly parentKinds = computed(() => parentKindsOf(this.unit().kind));
  protected readonly canMove = computed(() => this.parentKinds().length > 0);
  private readonly currentParentId = computed(() => this.unit().path.at(-1)?.id ?? null);

  protected readonly submitting = signal(false);
  protected readonly formError = signal<FormError | null>(null);
  protected readonly fieldErrorKey = fieldErrorKey;

  ngOnInit(): void {
    if (this.canMove()) {
      this.form.controls.parentId.addValidators(Validators.required);
    }
    this.form.reset({ name: this.unit().name, parentId: this.currentParentId(), validFrom: this.defaultValidFrom() });
  }

  protected submit(): void {
    this.formError.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const value = this.form.getRawValue();
    const name = value.name.trim();
    const body: { -readonly [K in keyof ChangeOrgUnit]: ChangeOrgUnit[K] } = { validFrom: value.validFrom };
    if (name !== this.unit().name) body.name = name;
    if (this.canMove() && value.parentId && value.parentId !== this.currentParentId()) body.parentId = value.parentId;
    if (body.name === undefined && body.parentId === undefined) {
      this.formError.set({ key: 'org.form.errors.nothingChanged' });
      return;
    }

    this.submitting.set(true);
    this.api.change(this.unit().id, body).subscribe({
      next: (unit) => {
        this.submitting.set(false);
        this.saved.emit(unit);
      },
      error: (error: unknown) => {
        this.formError.set(orgWriteError(this.form, error));
        this.submitting.set(false);
      },
    });
  }
}
