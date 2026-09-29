/**
 * The three sensitive write forms of the detail page — "New salary" (Pay tab), bank details and NSS (Bank & NSS tab):
 *   <app-salary-form [employee]="e" (saved)="…" (cancelled)="…" />
 *   <app-bank-form [employee]="e" … />   <app-nss-form [employee]="e" … />
 *
 * Angular concepts:
 * - **Small single-purpose form components** rather than one big form: each has its own `FormGroup`, its own
 *   submitting/error signals and its own endpoint, so an error in the bank form cannot mark the salary invalid.
 *   The page decides WHEN each is shown (from `_actions`); the form only knows how to write.
 * - **The validator factory again**: `digits(20)` (RIB), `digits(10, 15)` (NSS) — the same functions as the create
 *   page, so client rules cannot drift between create and edit.
 * - **Sensitive values never leave the form in a log or a message**: errors show translated keys; 403
 *   `forbidden-field` (the permission was removed meanwhile) lands on the field.
 */
import { ChangeDetectionStrategy, Component, inject, input, type OnInit, output, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import { todayIso } from '../../core/date/iso-date';
import { EmployeesApi } from '../../core/employees/employees-api';
import type { EmployeeDetail } from '../../core/employees/employees.models';
import type { FormMessage } from '../../core/http/problem-form';
import {
  bothOrNeither,
  digits,
  digitsOnly,
  employeeProblemToForm,
  isoDate,
  money,
  NAME_MAX,
  normaliseMoney,
  notBefore,
  SALARY_SLUGS,
  SENSITIVE_SLUGS,
} from './employee-forms';
import { FieldError } from './field-error';
import { nextDay } from './assignment-form';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';

const ACTIONS = `
  <div class="form-actions">
    <button class="btn" type="submit" [disabled]="submitting()">
      {{ submitting() ? t('employees.form.saving') : t('common.save') }}
    </button>
    <button class="btn secondary" type="button" (click)="cancelled.emit()">{{ t('common.cancel') }}</button>
  </div>
`;

const FORM_ERROR = `
  @if (formError(); as error) {
    <p class="form-error" role="alert" [appRevealAlert]="error">{{ 'key' in error ? t(error.key) : error.text }}</p>
  }
`;

@Component({
  selector: 'app-salary-form',
  imports: [RevealAlert, ReactiveFormsModule, TranslocoDirective, FieldError],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form *transloco="let t" class="panel" [formGroup]="form" (ngSubmit)="submit()" aria-labelledby="salary-title" novalidate>
      <h3 id="salary-title">{{ t('employees.pay.newTitle') }}</h3>
      ${FORM_ERROR}
      @let c = form.controls;
      <div class="grid">
        <div class="field">
          <label for="salary-amount">{{ t('employees.fields.baseSalary') }}</label>
          <input id="salary-amount" type="text" inputmode="decimal" formControlName="baseSalary" required
            [attr.aria-invalid]="c.baseSalary.invalid && c.baseSalary.touched" aria-describedby="salary-amount-hint salary-amount-error" />
          <p class="field-hint" id="salary-amount-hint">{{ t('employees.hints.salary') }}</p>
          <app-field-error [control]="c.baseSalary" errorId="salary-amount-error" />
        </div>
        <div class="field">
          <label for="salary-valid-from">{{ t('employees.fields.validFrom') }}</label>
          <input id="salary-valid-from" type="date" formControlName="validFrom" required
            [attr.aria-invalid]="c.validFrom.invalid && c.validFrom.touched" aria-describedby="salary-valid-from-error" />
          <app-field-error [control]="c.validFrom" errorId="salary-valid-from-error" />
        </div>
      </div>
      ${ACTIONS}
    </form>
  `,
  styleUrl: './employees.css',
})
export class SalaryForm implements OnInit {
  private readonly api = inject(EmployeesApi);
  readonly employee = input.required<EmployeeDetail>();
  readonly saved = output<void>();
  readonly cancelled = output<void>();

  /** After the current salary's start (contract `salary-date`); read by the validator when it runs. */
  private minDate(): string | null {
    const current = this.employee().salary?.current;
    return current ? nextDay(current.validFrom) : this.employee().hireDate;
  }

  protected readonly form = inject(NonNullableFormBuilder).group({
    baseSalary: ['', [Validators.required, money]],
    // Empty until ngOnInit: the validator reads the `employee` input, not set during field initialisation.
    validFrom: ['', [Validators.required, isoDate, notBefore(() => this.minDate())]],
  });
  protected readonly submitting = signal(false);
  protected readonly formError = signal<FormMessage | null>(null);

  ngOnInit(): void {
    const today = todayIso();
    const min = this.minDate() ?? today;
    this.form.controls.validFrom.setValue(today > min ? today : min);
  }

  protected submit(): void {
    this.formError.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const v = this.form.getRawValue();
    this.submitting.set(true);
    this.api.setSalary(this.employee().id, { baseSalary: normaliseMoney(v.baseSalary), validFrom: v.validFrom }).subscribe({
      next: () => {
        this.submitting.set(false);
        this.saved.emit();
      },
      error: (error: unknown) => {
        this.formError.set(employeeProblemToForm(this.form, error, SALARY_SLUGS));
        this.submitting.set(false);
      },
    });
  }
}

@Component({
  selector: 'app-bank-form',
  imports: [RevealAlert, ReactiveFormsModule, TranslocoDirective, FieldError],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form *transloco="let t" class="panel" [formGroup]="form" (ngSubmit)="submit()" aria-labelledby="bank-title" novalidate>
      <h3 id="bank-title">{{ t('employees.bank.editTitle') }}</h3>
      ${FORM_ERROR}
      @let c = form.controls;
      <div class="grid">
        <div class="field">
          <label for="bank-rib">{{ t('employees.fields.rib') }}</label>
          <input id="bank-rib" type="text" inputmode="numeric" formControlName="rib"
            [attr.aria-invalid]="c.rib.invalid && c.rib.touched" aria-describedby="bank-rib-hint bank-rib-error" />
          <p class="field-hint" id="bank-rib-hint">{{ t('employees.hints.rib') }}</p>
          <app-field-error [control]="c.rib" errorId="bank-rib-error" />
        </div>
        <div class="field">
          <label for="bank-name">{{ t('employees.fields.bankName') }}</label>
          <input id="bank-name" type="text" formControlName="bankName" dir="auto"
            [attr.aria-invalid]="c.bankName.invalid && c.bankName.touched" aria-describedby="bank-name-error" />
          <app-field-error [control]="c.bankName" errorId="bank-name-error" />
        </div>
      </div>
      @if (form.hasError('incomplete') && (c.rib.touched || c.bankName.touched)) {
        <p class="field-error" data-error="bankIncomplete">{{ t('employees.form.errors.bankIncomplete') }}</p>
      }
      ${ACTIONS}
    </form>
  `,
  styleUrl: './employees.css',
})
export class BankForm implements OnInit {
  private readonly api = inject(EmployeesApi);
  readonly employee = input.required<EmployeeDetail>();
  readonly saved = output<void>();
  readonly cancelled = output<void>();

  protected readonly form = inject(NonNullableFormBuilder).group(
    { rib: ['', digits(20)], bankName: ['', Validators.maxLength(NAME_MAX)] },
    { validators: bothOrNeither('rib', 'bankName') },
  );
  protected readonly submitting = signal(false);
  protected readonly formError = signal<FormMessage | null>(null);

  ngOnInit(): void {
    const bank = this.employee().bank;
    this.form.reset({ rib: bank?.rib ?? '', bankName: bank?.bankName ?? '' });
  }

  protected submit(): void {
    this.formError.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const v = this.form.getRawValue();
    this.submitting.set(true);
    this.api.setBank(this.employee().id, { rib: digitsOnly(v.rib) || null, bankName: v.bankName.trim() || null }).subscribe({
      next: () => {
        this.submitting.set(false);
        this.saved.emit();
      },
      error: (error: unknown) => {
        this.formError.set(employeeProblemToForm(this.form, error, SENSITIVE_SLUGS));
        this.submitting.set(false);
      },
    });
  }
}

@Component({
  selector: 'app-nss-form',
  imports: [RevealAlert, ReactiveFormsModule, TranslocoDirective, FieldError],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form *transloco="let t" class="panel" [formGroup]="form" (ngSubmit)="submit()" aria-labelledby="nss-title" novalidate>
      <h3 id="nss-title">{{ t('employees.nss.editTitle') }}</h3>
      ${FORM_ERROR}
      @let c = form.controls;
      <div class="field">
        <label for="nss-number">{{ t('employees.fields.nss') }}</label>
        <input id="nss-number" type="text" inputmode="numeric" formControlName="nss"
          [attr.aria-invalid]="c.nss.invalid && c.nss.touched" aria-describedby="nss-number-hint nss-number-error" />
        <p class="field-hint" id="nss-number-hint">{{ t('employees.hints.nss') }}</p>
        <app-field-error [control]="c.nss" errorId="nss-number-error" />
      </div>
      ${ACTIONS}
    </form>
  `,
  styleUrl: './employees.css',
})
export class NssForm implements OnInit {
  private readonly api = inject(EmployeesApi);
  readonly employee = input.required<EmployeeDetail>();
  readonly saved = output<void>();
  readonly cancelled = output<void>();

  protected readonly form = inject(NonNullableFormBuilder).group({ nss: ['', digits(10, 15)] });
  protected readonly submitting = signal(false);
  protected readonly formError = signal<FormMessage | null>(null);

  ngOnInit(): void {
    this.form.reset({ nss: this.employee().nss?.nss ?? '' });
  }

  protected submit(): void {
    this.formError.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.submitting.set(true);
    this.api.setNss(this.employee().id, { nss: digitsOnly(this.form.getRawValue().nss) || null }).subscribe({
      next: () => {
        this.submitting.set(false);
        this.saved.emit();
      },
      error: (error: unknown) => {
        this.formError.set(employeeProblemToForm(this.form, error, SENSITIVE_SLUGS));
        this.submitting.set(false);
      },
    });
  }
}
