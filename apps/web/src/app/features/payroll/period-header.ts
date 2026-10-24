/**
 * `<app-payroll-period-header [period]="p" [filter]="f" (changed)="…" />` — the head of the « Paie » month: status,
 * cut-off date, totals per rubrique, flags, the closings history, and the actions the period's `_actions` allow:
 * « Clôturer le mois » (a dialog with the summary and the flags as warnings), « Rouvrir » (a dialog with a required
 * reason), the payroll file (closed) or its draft (open), and the control report in French or Arabic. The files
 * follow the unit filter on screen (`filter`). `changed` asks the page to read the month again.
 */
import { DatePipe, DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, type ElementRef, inject, input, output, signal, viewChild } from '@angular/core';
import { type AbstractControl, NonNullableFormBuilder, ReactiveFormsModule, type ValidationErrors, Validators } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import type { Observable } from 'rxjs';
import { algiersToday } from '../../core/attendance/attendance.models';
import { saveBlob } from '../../core/browser/download';
import { isApiProblemError, PROBLEM_TYPE_NETWORK } from '../../core/http/api-problem';
import { problemSlug } from '../../core/http/problem-form';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { PayrollApi } from '../../core/payroll/payroll-api';
import type { DownloadedFile, ExportFilter, PeriodAction, PeriodTotal, PeriodView } from '../../core/payroll/payroll.models';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';
import { formatValue, REASON_MAX, REASON_MIN, unitKey } from './payroll-state';

type Download = 'export' | 'draft' | 'control-fr' | 'control-ar';

/** Translation key of a refused close or reopen. */
export function periodActionErrorKey(error: unknown): string {
  if (!isApiProblemError(error)) return 'errors.generic';
  switch (problemSlug(error.problem.type)) {
    case 'payroll-before-cutoff':
      return 'payroll.month.problems.beforeCutoff';
    case 'payroll-period-closed':
      return 'payroll.month.problems.periodClosed';
    case 'payroll-previous-open':
      return 'payroll.month.problems.previousOpen';
    case 'payroll-period-not-latest':
      return 'payroll.month.problems.notLatest';
    case 'payroll-period-open':
      return 'payroll.month.problems.periodOpen';
    case 'forbidden-scope':
      return 'payroll.month.problems.companyWide';
    default:
      if (error.problem.type === PROBLEM_TYPE_NETWORK) return 'errors.network';
      if (error.status === 403) return 'errors.forbidden';
      return 'errors.generic';
  }
}

/** Translation key of a failed download. */
export function downloadErrorKey(error: unknown): string {
  if (!isApiProblemError(error)) return 'payroll.month.files.error';
  if (problemSlug(error.problem.type) === 'payroll-period-open') return 'payroll.month.problems.periodOpen';
  if (error.problem.type === PROBLEM_TYPE_NETWORK) return 'errors.network';
  if (error.status === 403) return 'errors.forbidden';
  return 'payroll.month.files.error';
}

/** The reason of a reopening, trimmed: 5–300 characters. */
function reasonLength(control: AbstractControl<string>): ValidationErrors | null {
  const length = control.value.trim().length;
  if (length === 0) return { required: true };
  return length < REASON_MIN ? { minlength: true } : null;
}

@Component({
  selector: 'app-payroll-period-header',
  imports: [TranslocoDirective, ReactiveFormsModule, DatePipe, RevealAlert],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './period-header.html',
  styleUrl: './period-header.css',
})
export class PayrollPeriodHeader {
  private readonly api = inject(PayrollApi);
  private readonly document = inject(DOCUMENT);
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));

  readonly period = input.required<PeriodView>();
  readonly filter = input<ExportFilter | null>(null);
  readonly changed = output<void>();

  protected readonly month = computed(() => this.period().month.slice(0, 7));
  protected can(action: PeriodAction): boolean {
    // oxlint-disable-next-line no-underscore-dangle -- contract field name
    return this.period()._actions.includes(action);
  }
  /** Today is before the cut-off date: closing is refused (409 `payroll-before-cutoff`). */
  protected readonly beforeCutoff = computed(() => algiersToday() < this.period().cutoffDate);
  protected readonly warnings = computed(() => {
    const { flags } = this.period();
    const list: { key: string; count: number; flag: string }[] = [];
    if (flags.pendingLeave) list.push({ key: 'payroll.month.flags.pendingLeaveCount', count: flags.pendingLeave, flag: 'pending_leave' });
    if (flags.incompleteDays) list.push({ key: 'payroll.month.flags.incompleteDaysCount', count: flags.incompleteDays, flag: 'incomplete_days' });
    if (flags.noAttendance) list.push({ key: 'payroll.month.flags.noAttendanceCount', count: flags.noAttendance, flag: 'no_attendance' });
    return list;
  });
  /** Earlier closings (reopened ones), newest first. */
  protected readonly history = computed(() => this.period().closings.toSorted((a, b) => b.version - a.version));

  protected readonly feedback = signal<string | null>(null);
  protected readonly downloading = signal<Download | null>(null);
  protected readonly downloadError = signal<{ key: string } | null>(null);
  protected readonly unitKey = unitKey;

  protected totalText(total: PeriodTotal): string {
    return formatValue(total.total, this.locale());
  }

  protected totalName(total: PeriodTotal): string {
    return total.names[this.lang()] || total.names.fr;
  }

  // --- Close ----------------------------------------------------------------------------------------------------

  private readonly closeDialog = viewChild.required<ElementRef<HTMLDialogElement>>('closeDialog');
  protected readonly closing = signal(false);
  protected readonly closeError = signal<{ key: string } | null>(null);

  protected openClose(): void {
    this.closeError.set(null);
    this.feedback.set(null);
    this.closeDialog().nativeElement.showModal();
  }

  protected cancelClose(): void {
    this.closeDialog().nativeElement.close();
  }

  protected confirmClose(): void {
    this.closing.set(true);
    this.closeError.set(null);
    this.api.close(this.month()).subscribe({
      next: () => {
        this.closing.set(false);
        this.closeDialog().nativeElement.close();
        this.feedback.set('payroll.month.feedback.closed');
        this.changed.emit();
      },
      error: (error: unknown) => {
        this.closing.set(false);
        this.closeError.set({ key: periodActionErrorKey(error) });
      },
    });
  }

  // --- Reopen ---------------------------------------------------------------------------------------------------

  private readonly reopenDialog = viewChild.required<ElementRef<HTMLDialogElement>>('reopenDialog');
  protected readonly reopening = signal(false);
  protected readonly reopenError = signal<{ key: string } | null>(null);
  protected readonly reasonMax = REASON_MAX;
  protected readonly reasonMin = REASON_MIN;
  protected readonly reopenForm = inject(NonNullableFormBuilder).group({
    reason: ['', [reasonLength, Validators.maxLength(REASON_MAX)]],
  });

  protected openReopen(): void {
    this.reopenError.set(null);
    this.feedback.set(null);
    this.reopenForm.reset({ reason: '' });
    this.reopenDialog().nativeElement.showModal();
  }

  protected cancelReopen(): void {
    this.reopenDialog().nativeElement.close();
  }

  protected submitReopen(): void {
    if (this.reopenForm.invalid) {
      this.reopenForm.markAllAsTouched();
      return;
    }
    this.reopening.set(true);
    this.reopenError.set(null);
    this.api.reopen(this.month(), this.reopenForm.getRawValue().reason.trim()).subscribe({
      next: () => {
        this.reopening.set(false);
        this.reopenDialog().nativeElement.close();
        this.feedback.set('payroll.month.feedback.reopened');
        this.changed.emit();
      },
      error: (error: unknown) => {
        this.reopening.set(false);
        if (isApiProblemError(error) && error.status === 422) {
          this.reopenForm.controls.reason.setErrors({ server: true });
          this.reopenForm.controls.reason.markAsTouched();
          return;
        }
        this.reopenError.set({ key: periodActionErrorKey(error) });
      },
    });
  }

  // --- Files ----------------------------------------------------------------------------------------------------

  protected download(kind: Download): void {
    const month = this.month();
    const filter = this.filter();
    const source: Observable<DownloadedFile> =
      kind === 'export'
        ? this.api.exportFile(month, filter)
        : kind === 'draft'
          ? this.api.exportFile(month, filter, true)
          : this.api.controlReport(month, kind === 'control-ar' ? 'ar' : 'fr', filter);
    this.downloading.set(kind);
    this.downloadError.set(null);
    source.subscribe({
      next: (file) => {
        this.downloading.set(null);
        saveBlob(this.document, file.filename, file.blob);
      },
      error: (error: unknown) => {
        this.downloading.set(null);
        this.downloadError.set({ key: downloadErrorKey(error) });
      },
    });
  }
}
