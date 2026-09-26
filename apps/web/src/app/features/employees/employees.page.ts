/**
 * /employees — the employee list: filter bar (search, org unit + sub-units, site, status), sortable columns, server
 * paging. **All list state lives in the URL query string** (employment contract › Web), so a filtered view is a
 * link you can share, reload or bookmark, and the browser's back/forward buttons walk through your filters.
 *
 * Angular concepts:
 * - **URL as state.** Every query param is a signal `input()` of the same name (router `withComponentInputBinding()`,
 *   app.config.ts). `query` is a `computed()` that turns those raw strings into a validated `EmployeeQuery`
 *   (employee-list-state.ts), and `list` is an `httpResource` keyed on `query` (core/employees/employees-api.ts).
 *   The page therefore never "loads" anything by hand and holds NO copy of the filters: a click only NAVIGATES —
 *   `router.navigate([], { relativeTo, queryParams, queryParamsHandling: 'merge' })` — and the new URL flows back
 *   through the inputs, the computed and the resource. One direction, one source of truth.
 * - **Back/forward for free.** A navigation pushes a history entry; Back restores the previous URL, the router
 *   re-binds the inputs, and the resource re-fetches (or the browser shows the cached answer). The component is
 *   reused — only its inputs change — so the filter widgets must READ the URL (`[value]="query().q"`), never keep
 *   their own state that would drift from it.
 * - **`replaceUrl: true` for keystrokes.** Search is debounced (RxJS `debounceTime` on a `Subject` of input events)
 *   and then navigates with `replaceUrl`, which REPLACES the current history entry instead of pushing one. Without
 *   it, typing "benali" in pauses would leave "b", "ben", "bena"… in the history, and Back would step through
 *   half-typed searches instead of leaving the search. Deliberate choices (a sort click, a status, a page) push.
 * - **Page resets to 1** when a filter or the sort changes (`null` removes `page` from the URL): page 7 of the old
 *   result has nothing to do with the new one.
 * - **A standalone `FormControl` for one custom control.** The org-unit picker is a ControlValueAccessor
 *   (shared/org-unit-picker); `[formControl]="unitControl"` plugs it in without a form group. URL → control goes
 *   through an `effect()` with `{ emitEvent: false }` (so writing the URL's value does not echo back as a user
 *   change); control → URL goes through `valueChanges`.
 * - **`aria-sort`** on the sorted column header (`ascending`/`descending`); the header's button says what a click
 *   will do. Sorting is the server's (`sort`/`dir` params), so it spans every page.
 * - **Names in the UI language**: `person | displayName: lang()` and `unit | displayName: lang()` (shared pipe).
 * - **Permission-aware filters**: the site select needs `site.read` and the unit picker `org_unit.read`
 *   (`Session.allows`, a `computed()` per code kept in a field); without them the filter is simply not offered and
 *   nothing is requested. "New employee" is page-level (`*appCan="'employee.create'"`).
 */
import { ChangeDetectionStrategy, Component, computed, effect, inject, input } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { debounceTime, filter, Subject } from 'rxjs';
import { Session } from '../../core/auth/session';
import { EmployeesApi } from '../../core/employees/employees-api';
import {
  DEFAULT_EMPLOYEE_QUERY,
  EMPLOYEE_PAGE_SIZES,
  type EmployeeListItem,
  type EmployeeQuery,
  type EmployeeSort,
  STATUS_FILTERS,
} from '../../core/employees/employees.models';
import { isApiProblemError, PROBLEM_TYPE_NETWORK } from '../../core/http/api-problem';
import { LanguageService } from '../../core/i18n/language.service';
import { OrgApi } from '../../core/org/org-api';
import type { Site } from '../../core/org/org.models';
import { CanDirective } from '../../shared/can/can.directive';
import { DisplayNamePipe } from '../../shared/display-name/display-name.pipe';
import { OrgUnitPicker } from '../../shared/org-unit-picker/org-unit-picker';
import { resolveQuery, toQueryParams } from './employee-list-state';

/** How long typing must pause before the search reaches the URL (and the API). */
export const EMPLOYEE_SEARCH_DEBOUNCE_MS = 300;

@Component({
  selector: 'app-employees-page',
  imports: [TranslocoDirective, RouterLink, ReactiveFormsModule, OrgUnitPicker, CanDirective, DisplayNamePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './employees.page.html',
  styleUrl: './employees.css',
})
export class EmployeesPage {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly session = inject(Session);
  protected readonly lang = inject(LanguageService).current;

  // --- Query params, bound by the router (names = URL param names) ----------------------------------------------
  readonly q = input<string>();
  readonly unitId = input<string>();
  readonly includeSubUnits = input<string>();
  readonly siteId = input<string>();
  readonly status = input<string>();
  readonly asOf = input<string>();
  readonly sort = input<string>();
  readonly dir = input<string>();
  readonly page = input<string>();
  readonly pageSize = input<string>();

  /** The validated state of the list, derived from the URL only. */
  protected readonly query = computed<EmployeeQuery>(() =>
    resolveQuery({
      q: this.q(),
      unitId: this.unitId(),
      includeSubUnits: this.includeSubUnits(),
      siteId: this.siteId(),
      status: this.status(),
      asOf: this.asOf(),
      // oxlint-disable-next-line unicorn/no-array-sort -- a signal input named after the `sort` query param, not Array#sort
      sort: this.sort(),
      dir: this.dir(),
      page: this.page(),
      pageSize: this.pageSize(),
    }),
  );

  protected readonly list = inject(EmployeesApi).listResource(this.query);
  protected readonly items = computed<readonly EmployeeListItem[]>(() => (this.list.hasValue() ? this.list.value().items : []));
  protected readonly total = computed(() => (this.list.hasValue() ? this.list.value().total : 0));
  protected readonly pageCount = computed(() => Math.max(1, Math.ceil(this.total() / this.query().pageSize)));
  /** Any filter away from its default (drives "no match" vs "no employee yet", and "clear filters"). */
  protected readonly filtered = computed(() => {
    const { q, unitId, siteId, status } = this.query();
    return q.trim() !== '' || unitId !== null || siteId !== null || status !== DEFAULT_EMPLOYEE_QUERY.status;
  });

  protected readonly canUnits = this.session.allows('org_unit.read');
  protected readonly canSites = this.session.allows('site.read');
  private readonly sitesResource = inject(OrgApi).sitesResource(() => '', this.canSites);
  protected readonly sites = computed<readonly Site[]>(() => (this.sitesResource.hasValue() ? this.sitesResource.value().items : []));

  protected readonly statuses = STATUS_FILTERS;
  protected readonly pageSizes = EMPLOYEE_PAGE_SIZES;
  protected readonly columns: readonly { key: EmployeeSort; labelKey: string }[] = [
    { key: 'matricule', labelKey: 'employees.list.matricule' },
    { key: 'name', labelKey: 'employees.list.name' },
    { key: 'unit', labelKey: 'employees.list.unit' },
  ];

  protected readonly unitControl = new FormControl<string | null>(null);
  private readonly searches = new Subject<string>();

  protected readonly errorKey = computed(() => {
    const error = this.list.error();
    if (isApiProblemError(error)) {
      if (error.problem.type === PROBLEM_TYPE_NETWORK) return 'errors.network';
      if (error.status === 403) return 'errors.forbidden';
    }
    return 'employees.list.loadError';
  });

  constructor() {
    // URL → picker. `emitEvent: false`: showing the URL's unit is not a user choice, so no navigation back.
    effect(() => {
      const unitId = this.query().unitId;
      if (this.unitControl.value !== unitId) this.unitControl.setValue(unitId, { emitEvent: false });
    });
    // Picker → URL (a deliberate choice: pushes a history entry).
    this.unitControl.valueChanges.pipe(takeUntilDestroyed()).subscribe((unitId) => this.update({ unitId }));
    // Keystrokes → URL, once typing pauses; REPLACE the history entry (see header). Skip "no change" (e.g. typing a
    // letter and deleting it within the debounce window).
    this.searches
      .pipe(
        debounceTime(EMPLOYEE_SEARCH_DEBOUNCE_MS),
        filter((q) => q !== this.query().q),
        takeUntilDestroyed(),
      )
      .subscribe((q) => this.update({ q }, { replaceUrl: true }));
  }

  /** Navigates to the same route with `change` merged into the query string; the page goes back to 1 unless given. */
  protected update(change: Partial<EmployeeQuery>, options: { replaceUrl?: boolean } = {}): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: toQueryParams({ page: 1, ...change }),
      queryParamsHandling: 'merge',
      replaceUrl: options.replaceUrl ?? false,
    });
  }

  protected onSearchInput(event: Event): void {
    this.searches.next(event.target instanceof HTMLInputElement ? event.target.value : '');
  }

  protected onSelect(key: 'siteId' | 'status' | 'pageSize', event: Event): void {
    const value = event.target instanceof HTMLSelectElement ? event.target.value : '';
    if (key === 'pageSize') this.update({ pageSize: Number(value) });
    else if (key === 'status') this.update({ status: resolveQuery({ status: value }).status });
    else this.update({ siteId: value || null });
  }

  protected onIncludeSubUnits(event: Event): void {
    this.update({ includeSubUnits: event.target instanceof HTMLInputElement && event.target.checked });
  }

  /** Same column → flip the direction; another column → sort by it, ascending. */
  protected sortBy(key: EmployeeSort): void {
    const { sort, dir } = this.query();
    this.update({ sort: key, dir: sort === key && dir === 'asc' ? 'desc' : 'asc' });
  }

  protected ariaSort(key: EmployeeSort): 'ascending' | 'descending' | null {
    const { sort, dir } = this.query();
    if (sort !== key) return null;
    return dir === 'asc' ? 'ascending' : 'descending';
  }

  protected goToPage(page: number): void {
    this.update({ page: Math.min(Math.max(1, page), this.pageCount()) });
  }

  protected clearFilters(): void {
    this.update({ q: '', unitId: null, includeSubUnits: true, siteId: null, status: DEFAULT_EMPLOYEE_QUERY.status });
  }
}
