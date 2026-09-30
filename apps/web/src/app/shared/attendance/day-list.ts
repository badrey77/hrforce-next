/**
 * `<app-day-list [days]="view.items" (voidPunch)="openVoid($event)" />` — one employee's days, newest first, each
 * a disclosure row: date, status, arrival–departure, late, worked, flags; opened, the day's schedule and every punch
 * (source, entrance or reason, who recorded it, void struck through with its reason). Used by the employee's own
 * Pointage page and by the employee file's Présence tab (docs/contracts/attendance.md › Web).
 *
 * Angular concepts:
 * - **`<details>`/`<summary>` rows** (chapter 19): "tapping a row shows its punches" with native keyboard and
 *   screen-reader support and no component state. `@for … track day.date` keeps each `<details>` element across a
 *   reload (a visibility refresh), so the rows the user opened stay open.
 * - **Server-decided actions**: a punch shows "Annuler" only when its `_actions` contains `void` — the API decided
 *   that for THIS caller and THIS punch (scope, separation of duties). The list only emits `voidPunch`; the page
 *   owns the dialog and the request.
 * - **`DatePipe` with a pattern** (`'EEE d MMM'`) and the locale of the UI language: "lun. 28 sept." /
 *   "الإثنين 28 سبتمبر" — day and month names from Angular's locale data, not from translation files (chapter 13).
 * - **Optional features as inputs with defaults** (Phase B): `[correctableDates]` (a `ReadonlySet` of dates computed
 *   by the page) shows "Demander une correction" in those days, `[pendingDates]` a "correction en cours" chip. The
 *   employee's Présence tab passes neither and gets the Phase A list unchanged. A Set input compares by reference:
 *   the page builds it in a `computed()`, so it is a new object only when its inputs changed.
 * - `reversed` is a `computed()` of the input: the API sends days oldest first, a person reads the latest first.
 */
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';
import { type AttendanceDayView, kioskLabel, type PunchView } from '../../core/attendance/attendance.models';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { pickLabel } from '../../core/leave/leave-catalog';
import { DayFlags, DayStatusBadge } from './day-badges';
import { MinutesPipe } from './minutes.pipe';

@Component({
  selector: 'app-day-list',
  imports: [TranslocoDirective, DatePipe, MinutesPipe, DayStatusBadge, DayFlags],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './day-list.html',
  styleUrl: './day-list.css',
})
export class DayList {
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));

  readonly days = input.required<readonly AttendanceDayView[]>();
  /** Open this day's row at first (`YYYY-MM-DD`, e.g. the date a board row linked to). */
  readonly openDate = input<string | null>(null);
  readonly voidPunch = output<PunchView>();
  /** Days that may get a correction request (Pointage only). */
  readonly correctableDates = input<ReadonlySet<string>>(new Set());
  /** Days with a pending correction request. */
  readonly pendingDates = input<ReadonlySet<string>>(new Set());
  readonly requestCorrection = output<AttendanceDayView>();

  protected readonly reversed = computed(() => this.days().toReversed());

  protected label(labels: Parameters<typeof pickLabel>[0]): string {
    return pickLabel(labels, this.lang());
  }

  protected kiosk(punch: PunchView): string {
    return punch.kiosk ? kioskLabel(punch.kiosk.labels, this.lang()) : '';
  }
}
