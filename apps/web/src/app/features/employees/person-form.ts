/**
 * Edit the person behind an employment (Identity tab): `<app-person-form [employee]="e" (saved)="…" (cancelled)="…" />`.
 * `PATCH /employees/:id/person` with ONLY the fields that changed.
 *
 * Angular concepts:
 * - **Presetting a form from an input in `ngOnInit`** (inputs are not set yet in field initializers) — the same
 *   pattern as features/organization/change-unit-form.ts. `reset(value)` (not `setValue`) also clears
 *   touched/dirty, so no field starts out red.
 * - **The same validators as the create page** (employee-forms.ts), on a FLAT group this time: one rule, many forms.
 * - **`output()`** tells the page "saved" so it can reload its detail resource — the form does not know the page.
 */
import { ChangeDetectionStrategy, Component, inject, input, type OnInit, output, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import { EmployeesApi } from '../../core/employees/employees-api';
import type { EmployeeDetail, PersonInput, Sex } from '../../core/employees/employees.models';
import type { FormMessage } from '../../core/http/problem-form';
import {
  digits,
  digitsOnly,
  employeeProblemToForm,
  isoDate,
  NAME_MAX,
  NATIONALITY_PATTERN,
  notBlank,
  PERSON_SLUGS,
} from './employee-forms';
import { FieldError } from './field-error';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

@Component({
  selector: 'app-person-form',
  imports: [RevealAlert, ReactiveFormsModule, TranslocoDirective, FieldError],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form *transloco="let t" class="panel" [formGroup]="form" (ngSubmit)="submit()" aria-labelledby="person-form-title" novalidate>
      <h3 id="person-form-title">{{ t('employees.identity.editTitle') }}</h3>
      @if (formError(); as error) {
        <p class="form-error" role="alert" [appRevealAlert]="error">{{ 'key' in error ? t(error.key) : error.text }}</p>
      }
      @let c = form.controls;
      <div class="grid">
        <div class="field">
          <label for="person-last-name">{{ t('employees.fields.lastName') }}</label>
          <input id="person-last-name" type="text" formControlName="lastName" required
            [attr.aria-invalid]="c.lastName.invalid && c.lastName.touched" aria-describedby="person-last-name-error" />
          <app-field-error [control]="c.lastName" errorId="person-last-name-error" />
        </div>
        <div class="field">
          <label for="person-first-name">{{ t('employees.fields.firstName') }}</label>
          <input id="person-first-name" type="text" formControlName="firstName" required
            [attr.aria-invalid]="c.firstName.invalid && c.firstName.touched" aria-describedby="person-first-name-error" />
          <app-field-error [control]="c.firstName" errorId="person-first-name-error" />
        </div>
        <div class="field">
          <label for="person-last-name-ar">{{ t('employees.fields.lastNameAr') }}</label>
          <input id="person-last-name-ar" type="text" formControlName="lastNameAr" dir="rtl" lang="ar" />
        </div>
        <div class="field">
          <label for="person-first-name-ar">{{ t('employees.fields.firstNameAr') }}</label>
          <input id="person-first-name-ar" type="text" formControlName="firstNameAr" dir="rtl" lang="ar" />
        </div>
        <div class="field">
          <label for="person-birth-date">{{ t('employees.fields.birthDate') }}</label>
          <input id="person-birth-date" type="date" formControlName="birthDate"
            [attr.aria-invalid]="c.birthDate.invalid && c.birthDate.touched" aria-describedby="person-birth-date-error" />
          <app-field-error [control]="c.birthDate" errorId="person-birth-date-error" />
        </div>
        <div class="field">
          <label for="person-birth-place">{{ t('employees.fields.birthPlace') }}</label>
          <input id="person-birth-place" type="text" formControlName="birthPlace" dir="auto" />
        </div>
        <div class="field">
          <label for="person-sex">{{ t('employees.fields.sex') }}</label>
          <select id="person-sex" formControlName="sex">
            <option [ngValue]="null">{{ t('employees.sex.unknown') }}</option>
            <option [ngValue]="'F'">{{ t('employees.sex.F') }}</option>
            <option [ngValue]="'M'">{{ t('employees.sex.M') }}</option>
          </select>
        </div>
        <div class="field">
          <label for="person-nationality">{{ t('employees.fields.nationality') }}</label>
          <input id="person-nationality" type="text" formControlName="nationality" maxlength="2" required
            [attr.aria-invalid]="c.nationality.invalid && c.nationality.touched" aria-describedby="person-nationality-error" />
          <app-field-error [control]="c.nationality" errorId="person-nationality-error" />
        </div>
        <div class="field">
          <label for="person-nin">{{ t('employees.fields.nin') }}</label>
          <input id="person-nin" type="text" inputmode="numeric" formControlName="nin"
            [attr.aria-invalid]="c.nin.invalid && c.nin.touched" aria-describedby="person-nin-hint person-nin-error" />
          <p class="field-hint" id="person-nin-hint">{{ t('employees.hints.nin') }}</p>
          <app-field-error [control]="c.nin" errorId="person-nin-error" />
        </div>
      </div>
      <div class="form-actions">
        <button class="btn" type="submit" [disabled]="submitting()">
          {{ submitting() ? t('employees.form.saving') : t('common.save') }}
        </button>
        <button class="btn secondary" type="button" (click)="cancelled.emit()">{{ t('common.cancel') }}</button>
      </div>
    </form>
  `,
  styleUrl: './employees.css',
})
export class PersonForm implements OnInit {
  private readonly api = inject(EmployeesApi);

  readonly employee = input.required<EmployeeDetail>();
  readonly saved = output<void>();
  readonly cancelled = output<void>();

  protected readonly form = inject(NonNullableFormBuilder).group({
    lastName: ['', [Validators.required, notBlank, Validators.maxLength(NAME_MAX)]],
    firstName: ['', [Validators.required, notBlank, Validators.maxLength(NAME_MAX)]],
    lastNameAr: ['', Validators.maxLength(NAME_MAX)],
    firstNameAr: ['', Validators.maxLength(NAME_MAX)],
    birthDate: ['', isoDate],
    birthPlace: ['', Validators.maxLength(NAME_MAX)],
    sex: inject(NonNullableFormBuilder).control<Sex | null>(null),
    nationality: ['DZ', [Validators.required, Validators.pattern(NATIONALITY_PATTERN)]],
    nin: ['', digits(18)],
  });

  protected readonly submitting = signal(false);
  protected readonly formError = signal<FormMessage | null>(null);

  ngOnInit(): void {
    const p = this.employee().person;
    this.form.reset({
      lastName: p.lastName,
      firstName: p.firstName,
      lastNameAr: p.lastNameAr ?? '',
      firstNameAr: p.firstNameAr ?? '',
      birthDate: p.birthDate ?? '',
      birthPlace: p.birthPlace ?? '',
      sex: p.sex,
      nationality: p.nationality,
      nin: p.nin ?? '',
    });
  }

  protected submit(): void {
    this.formError.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const v = this.form.getRawValue();
    const next: PersonInput = {
      lastName: v.lastName.trim(),
      firstName: v.firstName.trim(),
      lastNameAr: v.lastNameAr.trim() || null,
      firstNameAr: v.firstNameAr.trim() || null,
      birthDate: v.birthDate || null,
      birthPlace: v.birthPlace.trim() || null,
      sex: v.sex,
      nationality: v.nationality,
      nin: digitsOnly(v.nin) || null,
    };
    const current = this.employee().person;
    const body: Mutable<Partial<PersonInput>> = {};
    for (const key of Object.keys(next) as (keyof PersonInput)[]) {
      if (next[key] !== current[key]) Object.assign(body, { [key]: next[key] });
    }
    if (Object.keys(body).length === 0) {
      this.formError.set({ key: 'employees.form.errors.nothingChanged' });
      return;
    }
    this.submitting.set(true);
    this.api.updatePerson(this.employee().id, body).subscribe({
      next: () => {
        this.submitting.set(false);
        this.saved.emit();
      },
      error: (error: unknown) => {
        this.formError.set(employeeProblemToForm(this.form, error, PERSON_SLUGS));
        this.submitting.set(false);
      },
    });
  }
}
