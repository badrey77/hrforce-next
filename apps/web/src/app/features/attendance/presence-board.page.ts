/**
 * /attendance — the HR presence board (`attendance.read`, docs/contracts/attendance.md › Web › Presence board): who
 * is present, late, absent… on one day, for the employees in the caller's scope. Date picker with ‹ › day buttons,
 * unit (+ sub-units), site, status chips with their counts, search, sort, server paging — ALL in the URL query
 * (share a link to "Région Est, absent, yesterday"), as /employees.
 *
 * Angular concepts (the URL-as-state pattern of chapter 14, reused as is — features/employees/employees.page.ts
 * explains each step): query params → signal inputs → a `computed()` query → `httpResource`; widgets READ the URL
 * and WRITE only through `router.navigate(…, { queryParamsHandling: 'merge' })`; keystrokes use `replaceUrl`; any
 * filter change resets `page`. What this page adds:
 * - **`date` absent = today.** The URL carries a date only for another day; ‹ › compute the neighbour day with plain
 *   calendar arithmetic and write `null` back when they land on today, so "today" links stay "today" tomorrow.
 * - **A periodic refresh that respects visibility.** Today's board changes as people arrive: an RxJS `interval()`
 *   ticks every 60 s and reloads the resource only when the tab is visible (`PageActivity.visible()`, a signal read
 *   at tick time) and the day is not final. A hidden tab costs nothing; `takeUntilDestroyed()` stops the interval
 *   with the page. `reload()` keeps the current rows on screen while the new answer comes (status `reloading`).
 * - **A select bound to reference data that may be absent**: sites need `site.read`; without it the resource stays
 *   idle (its `enabled` function) and the select is not rendered.
 */
import { ChangeDetectionStrategy, Component, computed, effect, inject, input } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { debounceTime, filter, interval, Subject } from 'rxjs';
import { AttendanceApi } from '../../core/attendance/attendance-api';
import {
  addDays,
  algiersToday,
  type BoardStatus,
  DEFAULT_PRESENCE_QUERY,
  PRESENCE_PAGE_SIZES,
  PRESENCE_SORTS,
  type PresenceQuery,
} from '../../core/attendance/attendance.models';
import { Session } from '../../core/auth/session';
import { PageActivity } from '../../core/browser/page-activity';
import { isApiProblemError, PROBLEM_TYPE_NETWORK } from '../../core/http/api-problem';
import { LanguageService } from '../../core/i18n/language.service';
import { OrgApi } from '../../core/org/org-api';
import { PresenceTable } from '../../shared/attendance/presence-table';
import { resolvePresenceQuery, toPresenceQueryParams } from '../../shared/attendance/presence-state';
import { StatusCounts } from '../../shared/attendance/status-counts';
import { CanDirective } from '../../shared/can/can.directive';
import { OrgUnitPicker } from '../../shared/org-unit-picker/org-unit-picker';

export const PRESENCE_SEARCH_DEBOUNCE_MS = 300;
export const PRESENCE_REFRESH_MS = 60_000;

@Component({
  selector: 'app-presence-board-page',
  imports: [TranslocoDirective, RouterLink, ReactiveFormsModule, CanDirective, OrgUnitPicker, PresenceTable, StatusCounts],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './presence-board.page.html',
  styleUrl: './attendance.css',
})
export class PresenceBoardPage {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly session = inject(Session);
  private readonly activity = inject(PageActivity);
  protected readonly lang = inject(LanguageService).current;
  protected readonly todayIso = algiersToday();

  // Query params (names = URL param names), bound by the router.
  readonly date = input<string>();
  readonly unitId = input<string>();
  readonly includeSubUnits = input<string>();
  readonly siteId = input<string>();
  readonly status = input<string>();
  readonly q = input<string>();
  /** `?sort=` — aliased: a field called `sort` reads like `Array#sort()` to the linter and to people. */
  readonly sortParam = input<string | undefined>(undefined, { alias: 'sort' });
  readonly page = input<string>();
  readonly pageSize = input<string>();

  protected readonly query = computed<PresenceQuery>(() =>
    resolvePresenceQuery({
      date: this.date(),
      unitId: this.unitId(),
      includeSubUnits: this.includeSubUnits(),
      siteId: this.siteId(),
      status: this.status(),
      q: this.q(),
      sort: this.sortParam(),
      page: this.page(),
      pageSize: this.pageSize(),
    }),
  );
  /** `lang=ar` sorts names by their Arabic form (only matters with `sort=name`). */
  private readonly sortLanguage = computed(() => (this.lang() === 'ar' ? 'ar' : null));
  protected readonly board = inject(AttendanceApi).presenceResource(this.query, this.sortLanguage);

  protected readonly canUnits = this.session.allows('org_unit.read');
  protected readonly canSites = this.session.allows('site.read');
  protected readonly sites = inject(OrgApi).sitesResource(() => undefined, this.canSites);
  protected readonly siteItems = computed(() => (this.sites.hasValue() ? this.sites.value().items : []));

  /** The day on screen: the URL's, else today. */
  protected readonly day = computed(() => this.query().date ?? this.todayIso);
  protected readonly pageCount = computed(() =>
    this.board.hasValue() ? Math.max(1, Math.ceil(this.board.value().total / this.query().pageSize)) : 1,
  );
  protected readonly filtered = computed(() => {
    const { unitId, siteId, status, q } = this.query();
    return !!unitId || !!siteId || !!status || q.trim() !== '';
  });
  protected readonly errorKey = computed(() => {
    const error = this.board.error();
    if (isApiProblemError(error)) {
      if (error.problem.type === PROBLEM_TYPE_NETWORK) return 'errors.network';
      if (error.status === 403) return 'errors.forbidden';
      if (error.status === 422 && error.problem.errors?.some((e) => e.code === 'too_many')) return 'attendance.board.tooMany';
    }
    return 'attendance.board.loadError';
  });

  protected readonly sorts = PRESENCE_SORTS;
  protected readonly pageSizes = PRESENCE_PAGE_SIZES;
  protected readonly unitControl = new FormControl<string | null>(null);
  private readonly searches = new Subject<string>();

  constructor() {
    effect(() => {
      const unitId = this.query().unitId;
      if (this.unitControl.value !== unitId) this.unitControl.setValue(unitId, { emitEvent: false });
    });
    this.unitControl.valueChanges.pipe(takeUntilDestroyed()).subscribe((unitId) => this.update({ unitId }));
    this.searches
      .pipe(
        debounceTime(PRESENCE_SEARCH_DEBOUNCE_MS),
        filter((q) => q !== this.query().q),
        takeUntilDestroyed(),
      )
      .subscribe((q) => this.update({ q }, true));
    interval(PRESENCE_REFRESH_MS)
      .pipe(takeUntilDestroyed())
      .subscribe(() => {
        if (this.activity.visible() && this.board.hasValue() && !this.board.value().final) this.board.reload();
      });
  }

  protected update(change: Partial<PresenceQuery>, replaceUrl = false): void {
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

  protected onSelect(key: 'siteId' | 'sort' | 'pageSize', event: Event): void {
    const value = event.target instanceof HTMLSelectElement ? event.target.value : '';
    if (key === 'pageSize') this.update({ pageSize: Number(value) });
    else if (key === 'sort') this.update({ sort: resolvePresenceQuery({ sort: value }).sort });
    else this.update({ siteId: value || null });
  }

  protected onIncludeSubUnits(event: Event): void {
    this.update({ includeSubUnits: event.target instanceof HTMLInputElement && event.target.checked });
  }

  protected onStatus(status: BoardStatus | null): void {
    this.update({ status });
  }

  protected goToPage(page: number): void {
    this.update({ page: Math.min(Math.max(1, page), this.pageCount()) });
  }

  protected clearFilters(): void {
    const d = DEFAULT_PRESENCE_QUERY;
    this.update({ unitId: null, includeSubUnits: d.includeSubUnits, siteId: null, status: null, q: '' });
  }
}
