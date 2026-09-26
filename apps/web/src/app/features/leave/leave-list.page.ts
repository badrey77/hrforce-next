/**
 * /leave — HR's scoped list of leave requests (`leave.read`): search, status, type, unit (+ sub-units), date range,
 * server paging. The API returns only requests of employees in the caller's `leave.read` scope.
 *
 * Angular concepts: the employee list's "URL as state" pattern, reused as is (features/employees/employees.page.ts
 * explains each step): query params → signal inputs → `computed()` query → `httpResource`; widgets READ the URL and
 * WRITE only through `router.navigate(…, { queryParamsHandling: 'merge' })`; keystrokes use `replaceUrl`; any filter
 * change resets `page`. What this page adds:
 * - **Reference data in a filter**: the type select lists `LeaveCatalog.types()` with names in the active language;
 *   switching the language re-labels the options, the URL (type id) does not change.
 * - **Two date inputs as a range** (`from`/`to`): `(change)` (not `(input)`) so a half-typed date never reaches the
 *   URL; an invalid value is simply dropped by `resolveLeaveQuery()`.
 */
import { DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { debounceTime, filter, Subject } from 'rxjs';
import { Session } from '../../core/auth/session';
import { isApiProblemError, PROBLEM_TYPE_NETWORK } from '../../core/http/api-problem';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { LeaveApi } from '../../core/leave/leave-api';
import { LeaveCatalog } from '../../core/leave/leave-catalog';
import {
  DEFAULT_LEAVE_QUERY,
  LEAVE_PAGE_SIZES,
  LEAVE_STATUS_FILTERS,
  type LeaveQuery,
  type LeaveRequestSummary,
} from '../../core/leave/leave.models';
import { CanDirective } from '../../shared/can/can.directive';
import { DisplayNamePipe } from '../../shared/display-name/display-name.pipe';
import { OrgUnitPicker } from '../../shared/org-unit-picker/org-unit-picker';
import { resolveLeaveQuery, toLeaveQueryParams } from './leave-list-state';

export const LEAVE_SEARCH_DEBOUNCE_MS = 300;

@Component({
  selector: 'app-leave-list-page',
  imports: [TranslocoDirective, RouterLink, ReactiveFormsModule, DatePipe, DecimalPipe, DisplayNamePipe, OrgUnitPicker, CanDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './leave-list.page.html',
})
export class LeaveListPage {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  protected readonly catalog = inject(LeaveCatalog);
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));

  // Query params (names = URL param names), bound by the router.
  readonly q = input<string>();
  readonly status = input<string>();
  readonly unitId = input<string>();
  readonly includeSubUnits = input<string>();
  readonly typeId = input<string>();
  readonly from = input<string>();
  readonly to = input<string>();
  readonly page = input<string>();
  readonly pageSize = input<string>();

  protected readonly query = computed<LeaveQuery>(() =>
    resolveLeaveQuery({
      q: this.q(),
      status: this.status(),
      unitId: this.unitId(),
      includeSubUnits: this.includeSubUnits(),
      typeId: this.typeId(),
      from: this.from(),
      to: this.to(),
      page: this.page(),
      pageSize: this.pageSize(),
    }),
  );

  protected readonly list = inject(LeaveApi).listResource(this.query);
  protected readonly items = computed<readonly LeaveRequestSummary[]>(() => (this.list.hasValue() ? this.list.value().items : []));
  protected readonly total = computed(() => (this.list.hasValue() ? this.list.value().total : 0));
  protected readonly pageCount = computed(() => Math.max(1, Math.ceil(this.total() / this.query().pageSize)));
  protected readonly filtered = computed(() => {
    const { q, status, unitId, typeId, from, to } = this.query();
    return q.trim() !== '' || status !== DEFAULT_LEAVE_QUERY.status || !!unitId || !!typeId || !!from || !!to;
  });
  protected readonly errorKey = computed(() => {
    const error = this.list.error();
    if (isApiProblemError(error)) {
      if (error.problem.type === PROBLEM_TYPE_NETWORK) return 'errors.network';
      if (error.status === 403) return 'errors.forbidden';
    }
    return 'leave.list.loadError';
  });

  protected readonly canUnits = inject(Session).allows('org_unit.read');
  protected readonly statuses = LEAVE_STATUS_FILTERS;
  protected readonly pageSizes = LEAVE_PAGE_SIZES;
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
        debounceTime(LEAVE_SEARCH_DEBOUNCE_MS),
        filter((q) => q !== this.query().q),
        takeUntilDestroyed(),
      )
      .subscribe((q) => this.update({ q }, true));
  }

  protected update(change: Partial<LeaveQuery>, replaceUrl = false): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: toLeaveQueryParams({ page: 1, ...change }),
      queryParamsHandling: 'merge',
      replaceUrl,
    });
  }

  protected onSearchInput(event: Event): void {
    this.searches.next(event.target instanceof HTMLInputElement ? event.target.value : '');
  }

  protected onField(key: 'status' | 'typeId' | 'from' | 'to' | 'pageSize', event: Event): void {
    const target = event.target;
    const value = target instanceof HTMLSelectElement || target instanceof HTMLInputElement ? target.value : '';
    if (key === 'pageSize') this.update({ pageSize: Number(value) });
    else if (key === 'status') this.update({ status: resolveLeaveQuery({ status: value }).status });
    else this.update({ [key]: value || null });
  }

  protected onIncludeSubUnits(event: Event): void {
    this.update({ includeSubUnits: event.target instanceof HTMLInputElement && event.target.checked });
  }

  protected goToPage(page: number): void {
    this.update({ page: Math.min(Math.max(1, page), this.pageCount()) });
  }

  protected clearFilters(): void {
    this.update({ q: '', status: DEFAULT_LEAVE_QUERY.status, unitId: null, includeSubUnits: true, typeId: null, from: null, to: null });
  }

  /** The current step's label, for pending requests. */
  protected currentStep(request: LeaveRequestSummary): string {
    const workflow = request.workflow;
    if (!workflow || workflow.currentStep === null || request.status !== 'pending') return '';
    const step = workflow.steps[workflow.currentStep];
    return step ? this.catalog.labelOf(step.labels) : '';
  }
}
