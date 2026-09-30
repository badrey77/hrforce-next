/**
 * The employee page's **Présence** tab (`attendance.read`, docs/contracts/attendance.md › Web › Employee detail): a
 * month navigator; the schedules that applied and WHY ("Horaire agence — via le site CNE"); the month's totals; the day
 * list with every punch (source, entrance or reason, void struck through with its reason); "Ajouter un pointage" when
 * `EmployeeDaysView.canManage`, and "Annuler" on a punch whose `_actions` allow it — both with a required reason that
 * goes into the audit trail. `<app-employee-attendance-tab [employee]="e" [date]="'2026-09-28'" />`.
 *
 * Angular concepts:
 * - **An input as the START of local state**: `date` (from the board's link, `?tab=attendance&date=…`) sets the
 *   month shown at first; `month` is a `linkedSignal` of it, so the ‹ › buttons can move away and a new link (a new
 *   input value) moves it back. The day of the link is also opened in the list (`[openDate]`).
 * - **Two resources on one key** (days and schedule segments share `range`): one month change, two requests in
 *   parallel, no orchestration code.
 * - **Server-decided permissions, twice**: `canManage` (the whole view: scope + "not your own employment") shows the
 *   add button; each punch's `_actions` shows its void button. `Session.can()` is not consulted: holding
 *   `attendance.manage` somewhere says nothing about THIS employee (chapter 12).
 * - **Native `<dialog>`s with typed reactive forms** (the file tab's pattern, chapter 19) and problem slugs mapped to
 *   fields or to the banner (`attendanceProblemToForm`, shared/attendance/attendance-forms.ts).
 */
import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  type ElementRef,
  inject,
  input,
  linkedSignal,
  signal,
  viewChild,
} from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import { AttendanceApi } from '../../core/attendance/attendance-api';
import {
  addMonths,
  algiersToday,
  isMonth,
  monthRange,
  type PunchDirection,
  type PunchView,
} from '../../core/attendance/attendance.models';
import { Session } from '../../core/auth/session';
import { isIsoDate } from '../../core/date/iso-date';
import type { EmployeeDetail } from '../../core/employees/employees.models';
import { isApiProblemError, PROBLEM_TYPE_NETWORK } from '../../core/http/api-problem';
import { type FormMessage, problemSlug } from '../../core/http/problem-form';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { pickLabel } from '../../core/leave/leave-catalog';
import { OrgApi } from '../../core/org/org-api';
import { attendanceProblemToForm, reasonErrorKey, reasonValidator } from '../../shared/attendance/attendance-forms';
import { ControlError } from '../../shared/attendance/control-error';
import { DayList } from '../../shared/attendance/day-list';
import { MinutesPipe } from '../../shared/attendance/minutes.pipe';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export const MANUAL_SLUGS = {
  'attendance-not-employed': { key: 'attendance.manual.notEmployed' },
  'attendance-self-manage': { key: 'attendance.manual.selfManage' },
  'attendance-punch-exists': { key: 'attendance.manual.exists', field: 'time' },
  'forbidden-scope': { key: 'errors.forbidden' },
} as const;

export const MANUAL_CODES = {
  'time:future': 'attendance.manual.future',
  'date:future': 'attendance.manual.future',
  'date:too_old': 'attendance.manual.tooOld',
  'siteId:not_found': 'attendance.manual.siteNotFound',
} as const;

export const VOID_SLUGS = {
  'attendance-punch-void': { key: 'attendance.void.already' },
  'attendance-self-manage': { key: 'attendance.manual.selfManage' },
  'forbidden-scope': { key: 'errors.forbidden' },
} as const;

@Component({
  selector: 'app-employee-attendance-tab',
  imports: [TranslocoDirective, ReactiveFormsModule, DatePipe, MinutesPipe, DayList, ControlError, RevealAlert],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './employee-attendance-tab.html',
  styles: `
    .month-nav { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
    .month-nav h2 { margin: 0; min-inline-size: 10rem; text-align: center; font-size: 1.125rem; }
    .segments, .totals { margin-block: var(--space-2); padding-inline-start: var(--space-4); }
    .totals { display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-4); padding: 0; list-style: none; }
  `,
})
export class EmployeeAttendanceTab {
  private readonly api = inject(AttendanceApi);
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));
  protected readonly todayIso = algiersToday();

  readonly employee = input.required<EmployeeDetail>();
  /** A day to show first (`YYYY-MM-DD`), e.g. from the presence board's link. */
  readonly date = input<string | null | undefined>(null);

  protected readonly month = linkedSignal(() => {
    const date = this.date();
    return isIsoDate(date) && isMonth(date.slice(0, 7)) && date <= this.todayIso ? date.slice(0, 7) : this.todayIso.slice(0, 7);
  });
  protected readonly isCurrentMonth = computed(() => this.month() >= this.todayIso.slice(0, 7));
  private readonly range = computed(() => monthRange(this.month(), this.todayIso) ?? undefined);

  protected readonly days = this.api.employeeDaysResource(() => this.employee().id, this.range);
  protected readonly segments = this.api.employeeScheduleResource(() => this.employee().id, this.range);
  protected readonly canManage = computed(() => this.days.hasValue() && this.days.value().canManage);
  protected readonly openDate = computed(() => {
    const date = this.date();
    return isIsoDate(date) && date.slice(0, 7) === this.month() ? date : null;
  });
  protected readonly errorKey = computed(() => {
    const error = this.days.error();
    if (isApiProblemError(error) && error.problem.type === PROBLEM_TYPE_NETWORK) return 'errors.network';
    if (isApiProblemError(error) && error.status === 403) return 'errors.forbidden';
    return 'attendance.mine.loadError';
  });

  private readonly canSites = inject(Session).allows('site.read');
  private readonly sitesList = inject(OrgApi).sitesResource(() => undefined, () => this.canSites() && this.canManage());
  protected readonly sites = computed(() => (this.sitesList.hasValue() ? this.sitesList.value().items : []));

  protected readonly feedback = signal<string | null>(null);

  protected shiftMonth(delta: number): void {
    this.month.update((month) => addMonths(month, delta));
  }

  protected label(labels: Parameters<typeof pickLabel>[0]): string {
    return pickLabel(labels, this.lang());
  }

  private reloadAll(): void {
    this.days.reload();
    this.segments.reload();
  }

  // --- Manual punch -------------------------------------------------------------------------------------------------

  private readonly addDialog = viewChild.required<ElementRef<HTMLDialogElement>>('addDialog');
  protected readonly adding = signal(false);
  protected readonly addError = signal<FormMessage | null>(null);
  protected readonly addForm = this.fb.group({
    direction: this.fb.control<PunchDirection>('in'),
    date: [this.todayIso, Validators.required],
    time: ['', [Validators.required, Validators.pattern(TIME)]],
    siteId: [''],
    reason: ['', reasonValidator()],
  });
  protected readonly reasonErrorKey = reasonErrorKey;

  protected openAdd(): void {
    this.feedback.set(null);
    this.addError.set(null);
    this.addForm.reset({ direction: 'in', date: this.openDate() ?? this.todayIso, time: '', siteId: '', reason: '' });
    this.addDialog().nativeElement.showModal();
  }

  protected closeAdd(): void {
    this.addDialog().nativeElement.close();
  }

  protected onAddClosed(): void {
    this.adding.set(false);
  }

  protected submitAdd(): void {
    this.addError.set(null);
    if (this.addForm.invalid) {
      this.addForm.markAllAsTouched();
      return;
    }
    const v = this.addForm.getRawValue();
    this.adding.set(true);
    this.api
      .addPunch(this.employee().id, {
        direction: v.direction,
        date: v.date,
        time: v.time,
        reason: v.reason.trim(),
        ...(v.siteId ? { siteId: v.siteId } : {}),
      })
      .subscribe({
        next: (punch) => {
          this.closeAdd();
          this.feedback.set('attendance.manual.done');
          if (punch.workDate.slice(0, 7) !== this.month()) this.month.set(punch.workDate.slice(0, 7));
          this.reloadAll();
        },
        error: (error: unknown) => {
          this.adding.set(false);
          this.addError.set(attendanceProblemToForm(this.addForm, error, MANUAL_SLUGS, MANUAL_CODES));
        },
      });
  }

  // --- Void -----------------------------------------------------------------------------------------------------------

  private readonly voidDialog = viewChild.required<ElementRef<HTMLDialogElement>>('voidDialog');
  protected readonly voiding = signal<PunchView | null>(null);
  protected readonly voidSubmitting = signal(false);
  protected readonly voidError = signal<FormMessage | null>(null);
  protected readonly voidForm = this.fb.group({ reason: ['', reasonValidator()] });

  protected openVoid(punch: PunchView): void {
    this.feedback.set(null);
    this.voidError.set(null);
    this.voidForm.reset({ reason: '' });
    this.voiding.set(punch);
    this.voidDialog().nativeElement.showModal();
  }

  protected closeVoid(): void {
    this.voidDialog().nativeElement.close();
  }

  protected onVoidClosed(): void {
    this.voiding.set(null);
    this.voidSubmitting.set(false);
  }

  protected submitVoid(): void {
    const punch = this.voiding();
    this.voidError.set(null);
    if (!punch) return;
    if (this.voidForm.invalid) {
      this.voidForm.markAllAsTouched();
      return;
    }
    this.voidSubmitting.set(true);
    this.api.voidPunch(punch.id, this.voidForm.getRawValue().reason.trim()).subscribe({
      next: () => {
        this.closeVoid();
        this.feedback.set('attendance.void.done');
        this.reloadAll();
      },
      error: (error: unknown) => {
        this.voidSubmitting.set(false);
        this.voidError.set(attendanceProblemToForm(this.voidForm, error, VOID_SLUGS));
        // Voided meanwhile by someone else: refresh the list behind the dialog.
        if (isApiProblemError(error) && problemSlug(error.problem.type) === 'attendance-punch-void') this.reloadAll();
      },
    });
  }
}
