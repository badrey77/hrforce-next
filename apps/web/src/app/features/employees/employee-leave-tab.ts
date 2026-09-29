/**
 * The employee page's **Leave** tab (`leave.read`): balances, the ledger (every accrual, taken day, adjustment and
 * reversal), an adjustment form (`leave.adjust`) and "request on behalf" (`leave.request`).
 * `<app-employee-leave-tab [employee]="e" />`.
 *
 * Angular concepts:
 * - **Reusing shared UI across features.** The balance cards and the request form (with its live preview) live in
 *   shared/leave/: My leave uses them for the signed-in user, this tab for any employee in scope. The form only
 *   gets an `[employmentId]`, which switches it to `POST /employees/:id/leave/requests` and adds `employmentId` to
 *   the preview body. A feature never imports another feature (chapter 10), so shared/ is where such pieces go.
 * - **Resources keyed on an input**: balances and ledger are `httpResource`s of `employee().id`. Created in field
 *   initialisers; `input.required()` is readable inside the request functions because those run later (reactively),
 *   not during construction.
 * - **`*appCan`** for the two page-level write permissions (held anywhere) — the API still checks the scope of THIS
 *   employee and answers 403/404 otherwise.
 * - **A signed number input**: an adjustment may remove days (`-2`). `type="number"` + `step="0.5"` + a custom
 *   non-zero validator; the API accepts one decimal.
 */
import { DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import {
  type AbstractControl,
  NonNullableFormBuilder,
  ReactiveFormsModule,
  type ValidationErrors,
  Validators,
} from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import type { EmployeeDetail } from '../../core/employees/employees.models';
import { type FormMessage, problemToForm } from '../../core/http/problem-form';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { LeaveApi } from '../../core/leave/leave-api';
import { LeaveCatalog } from '../../core/leave/leave-catalog';
import type { LedgerEntry } from '../../core/leave/leave.models';
import { CanDirective } from '../../shared/can/can.directive';
import { BalanceCards } from '../../shared/leave/balance-cards';
import { isoDate, leaveErrorKey, referenceYearLabel } from '../../shared/leave/leave-forms';
import { LeaveRequestForm } from '../../shared/leave/leave-request-form';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';

/** Non-zero, at most one decimal (numeric(5,1)). Empty → left to `required`. */
export function adjustmentDays(control: AbstractControl): ValidationErrors | null {
  const value: unknown = control.value;
  if (value === null || value === '') return null;
  if (typeof value !== 'number' || value === 0 || Math.abs(value) > 366) return { number: true };
  return Math.abs(Math.round(value * 10) - value * 10) < 1e-9 ? null : { number: true };
}

type Panel = 'adjust' | 'request' | null;

@Component({
  selector: 'app-employee-leave-tab',
  imports: [RevealAlert, TranslocoDirective, ReactiveFormsModule, DatePipe, DecimalPipe, CanDirective, BalanceCards, LeaveRequestForm],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './employee-leave-tab.html',
})
export class EmployeeLeaveTab {
  private readonly api = inject(LeaveApi);
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly catalog = inject(LeaveCatalog);
  private readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));

  readonly employee = input.required<EmployeeDetail>();

  protected readonly balances = this.api.employeeBalancesResource(() => this.employee().id);
  protected readonly ledger = this.api.employeeLedgerResource(() => this.employee().id);
  protected readonly balanceItems = computed(() => (this.balances.hasValue() ? this.balances.value().items : []));
  protected readonly ledgerItems = computed<readonly LedgerEntry[]>(() => (this.ledger.hasValue() ? this.ledger.value().items : []));
  /** Types an adjustment makes sense for (they keep a balance). */
  protected readonly balanceTypes = computed(() => this.catalog.types().filter((type) => type.hasBalance));
  /** Reference years already known from the balances (the adjustment's `periodStart`). */
  protected readonly periods = computed(() => [...new Set(this.balanceItems().map((b) => b.periodStart))].toSorted());

  protected readonly panel = signal<Panel>(null);
  protected readonly feedback = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly formError = signal<FormMessage | null>(null);
  protected readonly errorKey = leaveErrorKey;
  protected readonly yearLabel = referenceYearLabel;

  protected readonly adjustForm = this.fb.group({
    leaveTypeId: ['', Validators.required],
    periodStart: ['', [Validators.required, isoDate]],
    days: this.fb.control<number | null>(null, [Validators.required, adjustmentDays]),
    note: ['', [Validators.required, Validators.maxLength(500), Validators.pattern(/\S/)]],
  });

  protected open(panel: Panel): void {
    this.feedback.set(null);
    this.formError.set(null);
    if (panel === 'adjust') {
      this.adjustForm.reset({ leaveTypeId: this.balanceTypes()[0]?.id ?? '', periodStart: this.periods().at(-1) ?? '', days: null, note: '' });
    }
    this.panel.set(panel);
  }

  protected submitAdjustment(): void {
    this.formError.set(null);
    if (this.adjustForm.invalid) {
      this.adjustForm.markAllAsTouched();
      return;
    }
    const v = this.adjustForm.getRawValue();
    this.saving.set(true);
    this.api
      .adjust(this.employee().id, { leaveTypeId: v.leaveTypeId, periodStart: v.periodStart, days: v.days ?? 0, note: v.note.trim() })
      .subscribe({
        next: () => this.done('leave.feedback.adjusted'),
        error: (error: unknown) => {
          this.saving.set(false);
          this.formError.set(problemToForm(this.adjustForm, error, {}));
        },
      });
  }

  protected onRequested(): void {
    this.done('leave.feedback.requestedOnBehalf');
  }

  private done(key: string): void {
    this.saving.set(false);
    this.panel.set(null);
    this.feedback.set(key);
    this.balances.reload();
    this.ledger.reload();
  }
}
