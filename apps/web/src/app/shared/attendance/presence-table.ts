/**
 * `<app-presence-table [items]="days" [linkEmployees]="true" />` — the presence of many employees on ONE day: the HR
 * board and "Mon équipe" (docs/contracts/attendance.md › Web). Columns: employee, unit, schedule, arrival,
 * departure, late, worked, status, flags.
 *
 * One markup for every width: a real `<table>` on a desktop; under 640 px each row becomes a card (CSS turns the
 * rows and cells into blocks, and each cell shows its column name from a `data-label` attribute through
 * `::before { content: attr(data-label) }`). Screen readers keep the table semantics at every width because the
 * roles are set explicitly (`role="table"`/`"row"`/`"cell"`): changing `display` on table elements can otherwise
 * make browsers drop them from the accessibility tree.
 *
 * Angular concepts:
 * - **`[routerLink]` + `[queryParams]`**: a board row links to the employee's Présence tab AT THAT DATE
 *   (`/employees/<id>?tab=attendance&date=2026-09-28`); the router builds and encodes the query string. The link is
 *   only rendered with `linkEmployees` (a unit head may not read employee files).
 * - **`<bdi>`** around names and entrance labels: a Latin name inside an Arabic sentence (or the reverse) keeps its
 *   own direction without reordering its neighbours.
 */
import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import type { AttendanceDayView } from '../../core/attendance/attendance.models';
import { LanguageService } from '../../core/i18n/language.service';
import { pickLabel } from '../../core/leave/leave-catalog';
import { DisplayNamePipe } from '../display-name/display-name.pipe';
import { DayFlags, DayStatusBadge } from './day-badges';
import { MinutesPipe } from './minutes.pipe';

@Component({
  selector: 'app-presence-table',
  imports: [TranslocoDirective, RouterLink, DisplayNamePipe, MinutesPipe, DayStatusBadge, DayFlags],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './presence-table.html',
  styleUrl: './presence-table.css',
})
export class PresenceTable {
  protected readonly lang = inject(LanguageService).current;

  readonly items = input.required<readonly AttendanceDayView[]>();
  /** Rows link to the employee's Présence tab (needs employee.read — the HR board). */
  readonly linkEmployees = input(false);

  protected label(labels: Parameters<typeof pickLabel>[0]): string {
    return pickLabel(labels, this.lang());
  }
}
