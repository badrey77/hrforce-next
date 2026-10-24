/**
 * `<app-payroll-line-editor [month] [employeeId] [line] [editable] (saved)="…" />` — one line of the employee panel:
 * rubrique, origin month of a régularisation, computed value, HR's value and note, « Enregistrer » and « Revenir au
 * calcul » (or « Retirer la ligne » for a rubrique typed by hand). Read-only when `editable` is false.
 */
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { type AbstractControl, NonNullableFormBuilder, ReactiveFormsModule, type ValidationErrors, Validators } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import type { Observable } from 'rxjs';
import { isApiProblemError } from '../../core/http/api-problem';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { PayrollApi } from '../../core/payroll/payroll-api';
import { type EmployeeVariables, type LineInput, monthKey, type PayrollLine } from '../../core/payroll/payroll.models';
import { formatValue, NOTE_MAX, parseValue, periodLabel, unitKey, valueInputText } from './payroll-state';
import { lineProblemKey } from './payroll-problems';

/** A value input: a number with at most two decimals within the column's bounds. */
export function payrollValue(control: AbstractControl<string>): ValidationErrors | null {
  if (control.value.trim() === '') return null;
  return parseValue(control.value) === null ? { value: true } : null;
}

@Component({
  selector: 'app-payroll-line-editor',
  imports: [TranslocoDirective, ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './line-editor.html',
  styleUrl: './employee-panel.css',
})
export class PayrollLineEditor {
  private readonly api = inject(PayrollApi);
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));

  readonly month = input.required<string>();
  readonly employeeId = input.required<string>();
  readonly line = input.required<PayrollLine>();
  readonly editable = input(false);
  readonly saved = output<EmployeeVariables>();

  protected readonly noteMax = NOTE_MAX;
  protected readonly unitKey = unitKey;
  protected readonly regularization = computed(() => monthKey(this.line().originMonth) !== this.month());
  protected readonly originLabel = computed(() => periodLabel(this.line().originMonth));
  protected readonly manual = computed(() => this.line().source === 'manual');
  protected readonly id = computed(() => `pl-${this.line().rubriqueId}-${monthKey(this.line().originMonth)}`);

  protected readonly form = inject(NonNullableFormBuilder).group({
    value: ['', [Validators.required, payrollValue]],
    note: ['', Validators.maxLength(NOTE_MAX)],
  });
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    // A saved line comes back as a new object: the form shows what the server kept.
    effect(() => {
      const line = this.line();
      this.form.reset({ value: valueInputText(line.value, this.lang()), note: line.note ?? '' });
      if (this.editable()) this.form.enable();
      else this.form.disable();
    });
  }

  protected format(value: number): string {
    return formatValue(value, this.locale());
  }

  protected name(): string {
    const names = this.line().names;
    return names[this.lang()] || names.fr;
  }

  protected save(): void {
    this.error.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const v = this.form.getRawValue();
    const value = parseValue(v.value);
    if (value === null) return;
    const line = this.line();
    const note = v.note.trim();
    const body: LineInput = {
      rubriqueId: line.rubriqueId,
      ...(this.regularization() ? { originMonth: line.originMonth } : {}),
      value,
      note: note || null,
    };
    this.run(this.api.putLine(this.month(), this.employeeId(), body));
  }

  protected revert(): void {
    const line = this.line();
    this.error.set(null);
    this.run(this.api.deleteLine(this.month(), this.employeeId(), line.rubriqueId, this.regularization() ? line.originMonth : null));
  }

  private run(request$: Observable<EmployeeVariables>): void {
    this.busy.set(true);
    request$.subscribe({
      next: (view) => {
        this.busy.set(false);
        this.saved.emit(view);
      },
      error: (error: unknown) => {
        this.busy.set(false);
        if (isApiProblemError(error) && error.status === 422) {
          const fields = error.problem.errors?.map((e) => e.field) ?? [];
          if (fields.includes('value')) {
            this.form.controls.value.setErrors({ value: true });
            this.form.controls.value.markAsTouched();
            return;
          }
          if (fields.includes('note')) {
            this.form.controls.note.setErrors({ maxlength: true });
            this.form.controls.note.markAsTouched();
            return;
          }
        }
        this.error.set(lineProblemKey(error));
      },
    });
  }
}
