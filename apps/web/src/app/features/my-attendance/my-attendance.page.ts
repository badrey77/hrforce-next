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
 */
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { AttendanceApi } from '../../core/attendance/attendance-api';
import { addMonths, algiersToday, monthRange, retentionPeriod } from '../../core/attendance/attendance.models';
import { PageActivity } from '../../core/browser/page-activity';
import { isApiProblemError } from '../../core/http/api-problem';
import { problemSlug } from '../../core/http/problem-form';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { pickLabel } from '../../core/leave/leave-catalog';
import { MyEmployment } from '../../core/leave/my-employment';
import { DayFlags, DayStatusBadge } from '../../shared/attendance/day-badges';
import { DayList } from '../../shared/attendance/day-list';
import { MinutesPipe } from '../../shared/attendance/minutes.pipe';
import { DisplayNamePipe } from '../../shared/display-name/display-name.pipe';

function notLinked(error: unknown): boolean {
  return isApiProblemError(error) && problemSlug(error.problem.type) === 'attendance-not-linked';
}

@Component({
  selector: 'app-my-attendance-page',
  imports: [TranslocoDirective, RouterLink, DatePipe, DisplayNamePipe, MinutesPipe, DayStatusBadge, DayFlags, DayList],
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

  constructor() {
    inject(PageActivity)
      .shown$.pipe(takeUntilDestroyed())
      .subscribe(() => this.refresh());
  }

  protected refresh(): void {
    if (!this.linked()) return;
    this.today.reload();
    this.monthDays.reload();
  }

  protected shiftMonth(delta: number): void {
    this.month.update((month) => addMonths(month, delta));
  }

  protected label(labels: Parameters<typeof pickLabel>[0]): string {
    return pickLabel(labels, this.lang());
  }
}
