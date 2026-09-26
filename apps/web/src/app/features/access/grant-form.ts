/**
 * "Add a grant" form: `<app-grant-form [userId]="…" (saved)="…" (cancelled)="…" />`.
 * A grant = a role, on an org unit (and by default its sub-units), from a date, optionally until a date.
 *
 * Angular concepts (typed reactive forms are introduced in features/organization/create-unit-form.ts):
 * - **A checkbox in a reactive form**: `formControlName` on `<input type="checkbox">` binds a `FormControl<boolean>`
 *   (Angular picks the checkbox value accessor from the input type). Default `true` here, per the contract.
 * - **A custom control in the form**: the unit is `<app-org-unit-picker formControlName="orgUnitId">` (a
 *   ControlValueAccessor, shared/org-unit-picker). Its `[asOf]` follows the "from" date through `toSignal()`, so it
 *   offers the units that exist when the grant starts.
 * - **Cross-field validation**: `validToNotBeforeFrom` sits on the group (access-forms.ts) and the template shows
 *   `form.hasError('dateOrder')` under the "to" field.
 * - **409 → the right field**: `problemToForm(form, error, GRANT_SLUGS)` (core/http/problem-form.ts) puts each
 *   separation-of-duties rule where it helps: escalation on the role, out-of-scope on the unit, dates on "to";
 *   "not yourself" and "not a member" above the form.
 * - The role options are the company's roles from `AccessCatalog` (names in the active language). The list is not
 *   filtered by what the caller may hand out: that rule depends on the unit chosen, and the server decides it.
 */
import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import { AccessApi } from '../../core/access/access-api';
import { AccessCatalog } from '../../core/access/access-catalog';
import type { GrantView } from '../../core/access/access.models';
import { todayIso } from '../../core/date/iso-date';
import { type FormMessage, problemToForm } from '../../core/http/problem-form';
import { OrgUnitPicker } from '../../shared/org-unit-picker/org-unit-picker';
import { fieldErrorKey, GRANT_SLUGS, isoDate, validToNotBeforeFrom } from './access-forms';

@Component({
  selector: 'app-grant-form',
  imports: [ReactiveFormsModule, TranslocoDirective, OrgUnitPicker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './grant-form.html',
  styleUrl: './access.css',
})
export class GrantForm {
  private readonly api = inject(AccessApi);
  protected readonly catalog = inject(AccessCatalog);

  readonly userId = input.required<string>();
  readonly saved = output<GrantView>();
  readonly cancelled = output<void>();

  protected readonly form = inject(NonNullableFormBuilder).group(
    {
      roleId: ['', Validators.required],
      orgUnitId: inject(NonNullableFormBuilder).control<string | null>(null, Validators.required),
      includeDescendants: [true],
      validFrom: [todayIso(), [Validators.required, isoDate]],
      // '' = open-ended (not sent).
      validTo: ['', isoDate],
    },
    { validators: [validToNotBeforeFrom] },
  );

  protected readonly validFrom = toSignal(this.form.controls.validFrom.valueChanges, {
    initialValue: this.form.controls.validFrom.value,
  });
  protected readonly submitting = signal(false);
  protected readonly formError = signal<FormMessage | null>(null);
  protected readonly fieldErrorKey = fieldErrorKey;

  protected submit(): void {
    this.formError.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const value = this.form.getRawValue();
    if (!value.orgUnitId) return; // unreachable: `required`; narrows the type for the body below
    this.submitting.set(true);
    this.api
      .createGrant({
        userId: this.userId(),
        roleId: value.roleId,
        orgUnitId: value.orgUnitId,
        includeDescendants: value.includeDescendants,
        validFrom: value.validFrom,
        ...(value.validTo ? { validTo: value.validTo } : {}),
      })
      .subscribe({
        next: (grant) => {
          this.submitting.set(false);
          this.saved.emit(grant);
        },
        error: (error: unknown) => {
          this.formError.set(problemToForm(this.form, error, GRANT_SLUGS));
          this.submitting.set(false);
        },
      });
  }
}
