/**
 * /me/attendance — « Pointage », the employee's own attendance (docs/contracts/attendance.md › Web › Pointage):
 * today's card (status, arrival, departure, worked so far, the day's schedule), "how to punch", my month (a month
 * navigator and one row per day, tapping a row shows its punches) and the Law 18-07 information notice (what is
 * recorded, how long it is kept).
 *
 * Needs `attendance.punch_self` (route guard) AND a linked employment (the root `MyEmployment`, as My leave). Without
 * the link the page explains it instead of showing empty cards.
 *
 * Angular concepts:
 * - **Two resources of the same endpoint with different keys.** `today` asks `GET /me/attendance/days` with NO dates
 *   (the API's default is today in Algiers — the web never guesses the server's date for "today"); `month` asks for
 *   the month on screen. Moving to last month changes only `month`'s key: today's card neither reloads nor flickers.
 * - **A month navigator as a plain signal** (`month`, `YYYY-MM`) and a `computed()` range cut at today (the API
 *   refuses future days: 422 `future`). ‹ and › only `update()` the signal; the resource does the rest.
 * - **Refresh when the person comes back** (`PageActivity.shown$`, core/browser/page-activity.ts): a phone that
 *   punched at the door and then opens this page from the home screen shows the new punch without a pull-to-refresh.
 *   Subscribed with `takeUntilDestroyed()`: the subscription lives exactly as long as the page.
 * - **Losing the link while open** (409 `attendance-not-linked` from either resource): a `computed()` over both
 *   errors flips the page to the "not linked" explanation, as My leave does after a failed submit.
 *
 * Phase B — corrections (docs/contracts/attendance.md › Web (Phase B) › Pointage):
 * - **A child component's method called through a view query.** `viewChild(CorrectionForm)` gives the page the
 *   dialog component INSTANCE; the day list's `(requestCorrection)` output calls `open(day)` on it. A query by CLASS
 *   (not by `#ref`) is enough when the template holds one instance.
 * - **Which days get the button** is a `computed()` over three sources: the month's days, the API's
 *   `correctionWindow` (sent with the days: employees cannot read the policy), and my pending requests (one pending
 *   request per day). It is a new `Set` only when one of them changed, so the day list re-renders only then.
 * - **My requests**: a resource of `GET /me/attendance/corrections`, the workflow stepper (`shared/workflow-stepper`)
 *   on each, Cancel through a confirm dialog when `_actions` allows it (the server decides), and `?correction=<id>`
 *   (the notification link) scrolls to and focuses that request with `afterRenderEffect()` — My leave's pattern.
 * - **Live refresh**: an `attendance.correction_*` notification (approved/rejected while I look) reloads the
 *   requests and the days, through the `NotificationEvents` bus (chapter 16).
 */
import { DatePipe } from '@angular/common';
import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { AttendanceApi } from '../../core/attendance/attendance-api';
import {
  addMonths,
  algiersToday,
  type AttendanceDayView,
  correctableDates,
  daysBetween,
  type CorrectionView,
  monthRange,
  retentionPeriod,
} from '../../core/attendance/attendance.models';
import { PageActivity } from '../../core/browser/page-activity';
import { isApiProblemError } from '../../core/http/api-problem';
import { problemSlug } from '../../core/http/problem-form';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { pickLabel } from '../../core/leave/leave-catalog';
import { MyEmployment } from '../../core/leave/my-employment';
import { NotificationEvents } from '../../core/notifications/notification-events';
import { CorrectionChanges } from '../../shared/attendance/correction-changes';
import { DayFlags, DayStatusBadge } from '../../shared/attendance/day-badges';
import { DayList } from '../../shared/attendance/day-list';
import { MinutesPipe } from '../../shared/attendance/minutes.pipe';
import { DisplayNamePipe } from '../../shared/display-name/display-name.pipe';
import { WorkflowStepper } from '../../shared/workflow-stepper/workflow-stepper';
import { CorrectionForm } from './correction-form';

function notLinked(error: unknown): boolean {
  return isApiProblemError(error) && problemSlug(error.problem.type) === 'attendance-not-linked';
}

@Component({
  selector: 'app-my-attendance-page',
  imports: [
    TranslocoDirective,
    RouterLink,
    DatePipe,
    DisplayNamePipe,
    MinutesPipe,
    DayStatusBadge,
    DayFlags,
    DayList,
    CorrectionForm,
    CorrectionChanges,
    WorkflowStepper,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './my-attendance.page.html',
  styles: `
    .today { display: grid; gap: var(--space-2); }
    .today .facts { margin-block-end: 0; }
    .big { font-size: 1.5rem; font-weight: 600; font-variant-numeric: tabular-nums; }
    .month-nav { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
    .month-nav h2 { margin: 0; min-inline-size: 10rem; text-align: center; font-size: 1.125rem; }
    .totals { display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-4); margin-block: var(--space-3); padding: 0; list-style: none; }
    .notice { font-size: 0.875rem; }
    .requests { display: grid; gap: var(--space-3); margin: 0; padding: 0; list-style: none; }
    .requests > li { padding: var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius); }
    .requests > li.highlight { border-color: var(--color-primary); border-inline-start-width: 4px; background: var(--color-surface-alt); }
    .requests > li:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
    .head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: var(--space-2); }
    .head p { margin: 0; }
  `,
})
export class MyAttendancePage {
  private readonly api = inject(AttendanceApi);
  protected readonly me = inject(MyEmployment);
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));
  protected readonly todayIso = algiersToday();

  protected readonly month = signal(this.todayIso.slice(0, 7));
  protected readonly isCurrentMonth = computed(() => this.month() >= this.todayIso.slice(0, 7));

  private readonly linkedAccount = computed(() => this.me.linked() === true);
  protected readonly today = this.api.myDaysResource(() => (this.linkedAccount() ? {} : undefined));
  protected readonly monthDays = this.api.myDaysResource(() =>
    this.linkedAccount() ? (monthRange(this.month(), this.todayIso) ?? undefined) : undefined,
  );

  /** The API said the account is not linked (any more). */
  private readonly lostLink = computed(() => notLinked(this.today.error()) || notLinked(this.monthDays.error()));
  protected readonly linked = computed(() => this.linkedAccount() && !this.lostLink());

  protected readonly todayDay = computed(() => (this.today.hasValue() ? (this.today.value().items.at(-1) ?? null) : null));
  protected readonly retention = computed(() => {
    const view = this.monthDays.hasValue() ? this.monthDays.value() : this.today.hasValue() ? this.today.value() : null;
    return view ? retentionPeriod(view.retentionMonths) : null;
  });

  // --- Corrections (Phase B) -------------------------------------------------------------------------------------

  protected readonly corrections = this.api.myCorrectionsResource(() => this.linked());
  protected readonly correctionItems = computed<readonly CorrectionView[]>(() =>
    this.corrections.hasValue() ? this.corrections.value().items : [],
  );
  /** Today's correction window, as the API computed it (`null` = no correction possible now). */
  protected readonly correctionWindow = computed(() => {
    const view = this.today.hasValue() ? this.today.value() : this.monthDays.hasValue() ? this.monthDays.value() : null;
    return view?.correctionWindow ?? null;
  });
  /** Its length in days, for the rules sentence. */
  protected readonly windowDays = computed(() => {
    const window = this.correctionWindow();
    return window ? daysBetween(window.from, window.to) : 0;
  });
  protected readonly pendingDates = computed<ReadonlySet<string>>(
    () => new Set(this.correctionItems().filter((c) => c.status === 'pending').map((c) => c.date)),
  );
  protected readonly correctable = computed<ReadonlySet<string>>(() =>
    this.monthDays.hasValue() && this.corrections.hasValue()
      ? correctableDates(this.monthDays.value().items, this.correctionWindow(), this.pendingDates())
      : new Set<string>(),
  );
  private readonly correctionForm = viewChild(CorrectionForm);
  protected readonly feedback = signal<string | null>(null);

  /** `?correction=<id>` (notification link), bound by the router. */
  readonly correction = input<string | undefined>();
  protected readonly highlighted = computed(() => {
    const id = this.correction();
    return id && this.correctionItems().some((c) => c.id === id) ? id : null;
  });
  protected readonly linkedCorrectionMissing = computed(
    () => !!this.correction() && this.corrections.hasValue() && this.highlighted() === null,
  );
  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);
  private scrolledTo: string | null = null;

  constructor() {
    inject(PageActivity)
      .shown$.pipe(takeUntilDestroyed())
      .subscribe(() => this.refresh());
    inject(NotificationEvents)
      .of((type) => type.startsWith('attendance.'))
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.refresh());
    afterRenderEffect(() => {
      const id = this.highlighted();
      if (!id || id === this.scrolledTo) return;
      const row = [...this.host.nativeElement.querySelectorAll<HTMLElement>('[data-correction]')].find(
        (el) => el.dataset['correction'] === id,
      );
      if (!row) return;
      this.scrolledTo = id;
      row.scrollIntoView?.({ block: 'center' });
      row.focus({ preventScroll: true });
    });
  }

  protected refresh(): void {
    if (!this.linked()) return;
    this.today.reload();
    this.monthDays.reload();
    this.corrections.reload();
  }

  protected openCorrection(day: AttendanceDayView): void {
    this.feedback.set(null);
    this.correctionForm()?.open(day);
  }

  protected onCorrectionSaved(): void {
    this.feedback.set('attendance.corrections.feedback.requested');
    this.corrections.reload();
  }

  protected onNotLinked(): void {
    this.me.reload();
  }

  // --- Cancel dialog ----------------------------------------------------------------------------------------------

  private readonly cancelDialog = viewChild.required<ElementRef<HTMLDialogElement>>('cancelDialog');
  protected readonly cancelling = signal<CorrectionView | null>(null);
  protected readonly cancelSubmitting = signal(false);
  protected readonly cancelError = signal<string | null>(null);

  protected openCancel(correction: CorrectionView): void {
    this.feedback.set(null);
    this.cancelError.set(null);
    this.cancelling.set(correction);
    this.cancelDialog().nativeElement.showModal();
  }

  protected closeCancel(): void {
    this.cancelDialog().nativeElement.close();
  }

  protected onCancelClosed(): void {
    this.cancelling.set(null);
    this.cancelSubmitting.set(false);
  }

  protected confirmCancel(): void {
    const correction = this.cancelling();
    if (!correction) return;
    this.cancelSubmitting.set(true);
    this.api.cancelMyCorrection(correction.id).subscribe({
      next: () => {
        this.closeCancel();
        this.feedback.set('attendance.corrections.feedback.cancelled');
        this.corrections.reload();
      },
      error: (error: unknown) => {
        this.cancelSubmitting.set(false);
        const slug = isApiProblemError(error) ? problemSlug(error.problem.type) : undefined;
        const stale = slug === 'attendance-correction-not-cancellable';
        this.cancelError.set(stale ? 'attendance.corrections.problems.notCancellable' : 'errors.generic');
        if (stale) this.corrections.reload();
      },
    });
  }

  protected shiftMonth(delta: number): void {
    this.month.update((month) => addMonths(month, delta));
  }

  protected label(labels: Parameters<typeof pickLabel>[0]): string {
    return pickLabel(labels, this.lang());
  }
}
