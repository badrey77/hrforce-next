/**
 * `<app-payroll-employee-panel [month] [employeeId] [status] [rubriques] (closed) (changed) />` — the employee's
 * variables for the month in a side dialog (`?employee=` on the page): every line with its computed value, HR's value
 * and note (line-editor.ts), a rubrique typed by hand added from the active manual rubriques (amount ones only with
 * `employee.salary.update`), the payroll matricule, entry/exit dates, links to the employee and their attendance
 * month. Read-only when the month is closed, without `payroll.prepare`, or without `edit` in `_actions`.
 */
import { DatePipe } from '@angular/common';
import { afterNextRender, ChangeDetectionStrategy, Component, computed, effect, type ElementRef, inject, input, output, signal, viewChild } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { Session } from '../../core/auth/session';
import { isApiProblemError, PROBLEM_TYPE_NETWORK } from '../../core/http/api-problem';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { PayrollApi } from '../../core/payroll/payroll-api';
import { type EmployeeVariables, monthKey, PAYROLL_CODE_PATTERN, type PeriodStatus, type RubriqueView } from '../../core/payroll/payroll.models';
import { DisplayNamePipe } from '../../shared/display-name/display-name.pipe';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';
import { PayrollLineEditor, payrollValue } from './line-editor';
import { NOTE_MAX, PAYROLL_CODE_MAX, parseValue, unitKey } from './payroll-state';
import { codeProblem, lineProblemKey } from './payroll-problems';

function editableView(view: EmployeeVariables | undefined): boolean {
  // oxlint-disable-next-line no-underscore-dangle -- contract field name
  return !!view?._actions.includes('edit');
}

/** The manual rubriques HR may add for `month`: active, amounts only with salary update, not already on a line. */
export function addableRubriques(
  rubriques: readonly RubriqueView[],
  view: EmployeeVariables | undefined,
  month: string,
  canAmount: boolean,
): RubriqueView[] {
  const present = new Set((view?.lines ?? []).filter((l) => monthKey(l.originMonth) === month).map((l) => l.rubriqueId));
  return rubriques.filter((r) => r.source === 'manual' && r.active && (r.unit !== 'amount' || canAmount) && !present.has(r.id));
}

@Component({
  selector: 'app-payroll-employee-panel',
  imports: [TranslocoDirective, ReactiveFormsModule, RouterLink, DatePipe, DisplayNamePipe, RevealAlert, PayrollLineEditor],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './employee-panel.html',
  styleUrl: './employee-panel.css',
})
export class PayrollEmployeePanel {
  private readonly api = inject(PayrollApi);
  private readonly session = inject(Session);
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));

  readonly month = input.required<string>();
  readonly employeeId = input.required<string>();
  /** The month's status (`null` while the period is loading → read-only). */
  readonly status = input<PeriodStatus | null>(null);
  readonly rubriques = input<readonly RubriqueView[]>([]);
  readonly closed = output<void>();
  readonly changed = output<void>();

  protected readonly detail = this.api.employeeVariablesResource(this.month, this.employeeId);
  private readonly canPrepare = this.session.allows('payroll.prepare');
  protected readonly canAmount = this.session.allows('employee.salary.update');
  protected readonly view = computed(() => (this.detail.hasValue() ? this.detail.value() : undefined));
  protected readonly editable = computed(() => {
    const view = this.view();
    return this.status() === 'open' && this.canPrepare() && editableView(view);
  });
  /** Matricule paie: a prepare right over the employee, open or closed month (it is not a month's value). */
  protected readonly codeEditable = computed(() => this.canPrepare() && editableView(this.view()));
  protected readonly addable = computed(() => addableRubriques(this.rubriques(), this.view(), this.month(), this.canAmount()));
  protected readonly loadErrorKey = computed(() => {
    const error = this.detail.error();
    if (isApiProblemError(error)) {
      if (error.problem.type === PROBLEM_TYPE_NETWORK) return 'errors.network';
      if (error.status === 404) return 'payroll.month.problems.notFound';
      if (error.status === 403) return 'errors.forbidden';
    }
    return 'payroll.month.panel.loadError';
  });
  protected readonly unitKey = unitKey;
  protected readonly noteMax = NOTE_MAX;
  protected readonly codeMax = PAYROLL_CODE_MAX;
  protected readonly feedback = signal<string | null>(null);

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  constructor() {
    afterNextRender(() => {
      const dialog = this.dialog().nativeElement;
      if (!dialog.open) dialog.showModal();
    });
    // Only a new code resets the field (a saved line must not wipe what is being typed there).
    const code = computed(() => this.view()?.payrollCode ?? '');
    effect(() => this.codeForm.reset({ code: code() }));
  }

  protected close(): void {
    this.dialog().nativeElement.close();
  }

  /** The dialog closed (button, Escape): the page removes `?employee=`. */
  protected onClosed(): void {
    this.closed.emit();
  }

  protected applied(view: EmployeeVariables, feedbackKey = 'payroll.month.feedback.lineSaved'): void {
    this.detail.set(view);
    this.feedback.set(feedbackKey);
    this.changed.emit();
  }

  protected attendanceParams(): Record<string, string> {
    return { tab: 'attendance', date: `${this.month()}-01` };
  }

  // --- Add a manual rubrique ------------------------------------------------------------------------------------

  protected readonly addForm = this.fb.group({
    rubriqueId: ['', Validators.required],
    value: ['', [Validators.required, payrollValue]],
    note: ['', Validators.maxLength(NOTE_MAX)],
  });
  protected readonly adding = signal(false);
  protected readonly addError = signal<{ key: string } | null>(null);
  protected readonly addUnit = signal<string | null>(null);

  protected onAddRubrique(): void {
    const rubrique = this.addable().find((r) => r.id === this.addForm.controls.rubriqueId.value);
    this.addUnit.set(rubrique ? unitKey(rubrique.unit) : null);
  }

  protected rubriqueName(r: RubriqueView): string {
    return r.names[this.lang()] || r.names.fr;
  }

  protected submitAdd(): void {
    this.addError.set(null);
    this.feedback.set(null);
    if (this.addForm.invalid) {
      this.addForm.markAllAsTouched();
      return;
    }
    const v = this.addForm.getRawValue();
    const value = parseValue(v.value);
    if (value === null) return;
    const note = v.note.trim();
    this.adding.set(true);
    this.api.putLine(this.month(), this.employeeId(), { rubriqueId: v.rubriqueId, value, note: note || null }).subscribe({
      next: (view) => {
        this.adding.set(false);
        this.addForm.reset({ rubriqueId: '', value: '', note: '' });
        this.addUnit.set(null);
        this.applied(view, 'payroll.month.feedback.lineAdded');
      },
      error: (error: unknown) => {
        this.adding.set(false);
        this.addError.set({ key: lineProblemKey(error) });
      },
    });
  }

  // --- Payroll matricule ----------------------------------------------------------------------------------------

  protected readonly codeForm = this.fb.group({
    code: ['', [Validators.maxLength(PAYROLL_CODE_MAX), Validators.pattern(PAYROLL_CODE_PATTERN)]],
  });
  protected readonly savingCode = signal(false);
  protected readonly codeError = signal<{ key: string } | null>(null);

  protected submitCode(): void {
    this.codeError.set(null);
    this.feedback.set(null);
    if (this.codeForm.invalid) {
      this.codeForm.markAllAsTouched();
      return;
    }
    const code = this.codeForm.getRawValue().code.trim() || null;
    this.savingCode.set(true);
    this.api.setEmployeeCode(this.employeeId(), code).subscribe({
      next: (saved) => {
        this.savingCode.set(false);
        this.detail.update((view) => (view ? { ...view, payrollCode: saved.code } : view));
        this.feedback.set(saved.code ? 'payroll.month.feedback.codeSaved' : 'payroll.month.feedback.codeCleared');
        this.changed.emit();
      },
      error: (error: unknown) => {
        this.savingCode.set(false);
        const problem = codeProblem(error);
        if (problem.field) {
          this.codeForm.controls.code.setErrors({ serverKey: problem.key });
          this.codeForm.controls.code.markAsTouched();
        } else {
          this.codeError.set({ key: problem.key });
        }
      },
    });
  }

  protected codeErrorKey(): string {
    const control = this.codeForm.controls.code;
    const server: unknown = control.getError('serverKey');
    if (typeof server === 'string') return server;
    return 'payroll.month.panel.codeInvalid';
  }
}
