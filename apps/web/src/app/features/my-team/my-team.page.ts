/**
 * /me/team — « Mon équipe » (docs/contracts/attendance.md › Web): the presence board's layout for a UNIT HEAD, over
 * the units they head on that day and their sub-units (`GET /me/team/presence`). No permission: being the head of a
 * unit (`org_unit_head`, linked user) is the grant; to anyone else the API answers an empty team (`units: []`).
 * No unit or site pickers; date, status and search are in the URL as on the HR board.
 *
 * Angular concepts: the HR board's URL-as-state pattern with FEWER inputs — the page declares only `date`, `status`,
 * `q` and `page`, so `withComponentInputBinding()` ignores any other query parameter a hand-edited URL may carry
 * (an input that does not exist is simply not bound). The shared pieces (`resolvePresenceQuery`, the table, the
 * status chips) live in shared/attendance/, so this feature and the HR board never import each other.
 */
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { debounceTime, filter, interval, Subject } from 'rxjs';
import { AttendanceApi, type TeamQuery } from '../../core/attendance/attendance-api';
import { addDays, algiersToday, type BoardStatus, type PresenceQuery } from '../../core/attendance/attendance.models';
import { PageActivity } from '../../core/browser/page-activity';
import { isApiProblemError, PROBLEM_TYPE_NETWORK } from '../../core/http/api-problem';
import { LanguageService } from '../../core/i18n/language.service';
import { PresenceTable } from '../../shared/attendance/presence-table';
import { resolvePresenceQuery, toPresenceQueryParams } from '../../shared/attendance/presence-state';
import { StatusCounts } from '../../shared/attendance/status-counts';
import { DisplayNamePipe } from '../../shared/display-name/display-name.pipe';

export const TEAM_PAGE_SIZE = 50;
export const TEAM_REFRESH_MS = 60_000;

@Component({
  selector: 'app-my-team-page',
  imports: [TranslocoDirective, DisplayNamePipe, PresenceTable, StatusCounts],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './my-team.page.html',
  styles: `
    .day-nav { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); margin-block-end: var(--space-3); }
    .day-nav input { padding-block: var(--space-1); padding-inline: var(--space-2); border: 1px solid var(--color-border); border-radius: var(--radius); }
    .units { display: flex; flex-wrap: wrap; gap: var(--space-2); margin: 0; padding: 0; list-style: none; }
  `,
})
export class MyTeamPage {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly activity = inject(PageActivity);
  protected readonly lang = inject(LanguageService).current;
  protected readonly todayIso = algiersToday();

  readonly date = input<string>();
  readonly status = input<string>();
  readonly q = input<string>();
  readonly page = input<string>();

  protected readonly query = computed<TeamQuery>(() => {
    const resolved = resolvePresenceQuery({ date: this.date(), status: this.status(), q: this.q(), page: this.page() });
    return { date: resolved.date, status: resolved.status, q: resolved.q, page: resolved.page, pageSize: TEAM_PAGE_SIZE };
  });
  protected readonly team = inject(AttendanceApi).teamResource(this.query);
  protected readonly day = computed(() => this.query().date ?? this.todayIso);
  protected readonly pageCount = computed(() =>
    this.team.hasValue() ? Math.max(1, Math.ceil(this.team.value().total / TEAM_PAGE_SIZE)) : 1,
  );
  protected readonly errorKey = computed(() => {
    const error = this.team.error();
    if (isApiProblemError(error) && error.problem.type === PROBLEM_TYPE_NETWORK) return 'errors.network';
    return 'attendance.board.loadError';
  });
  private readonly searches = new Subject<string>();

  constructor() {
    this.searches
      .pipe(
        debounceTime(300),
        filter((q) => q !== this.query().q),
        takeUntilDestroyed(),
      )
      .subscribe((q) => this.update({ q }, true));
    interval(TEAM_REFRESH_MS)
      .pipe(takeUntilDestroyed())
      .subscribe(() => {
        if (this.activity.visible() && this.team.hasValue() && !this.team.value().final) this.team.reload();
      });
  }

  protected update(change: Partial<Pick<PresenceQuery, 'date' | 'status' | 'q' | 'page'>>, replaceUrl = false): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: toPresenceQueryParams({ page: 1, ...change }),
      queryParamsHandling: 'merge',
      replaceUrl,
    });
  }

  protected shiftDay(days: number): void {
    const next = addDays(this.day(), days);
    this.update({ date: next >= this.todayIso ? null : next });
  }

  protected onDate(event: Event): void {
    const value = event.target instanceof HTMLInputElement ? event.target.value : '';
    this.update({ date: value && value < this.todayIso ? value : null });
  }

  protected onSearchInput(event: Event): void {
    this.searches.next(event.target instanceof HTMLInputElement ? event.target.value : '');
  }

  protected onStatus(status: BoardStatus | null): void {
    this.update({ status });
  }

  protected goToPage(page: number): void {
    this.update({ page: Math.min(Math.max(1, page), this.pageCount()) });
  }
}
