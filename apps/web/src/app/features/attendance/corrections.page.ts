/**
 * /attendance/corrections — HR's scoped list of punch correction requests (`attendance.read`, docs/contracts/
 * attendance.md › Web (Phase B) › HR): status (pending by default), unit (+ sub-units), work-date range, search,
 * server paging — all in the URL, as the leave list. Each row links to the detail with its history.
 *
 * Angular concepts: the URL-as-state pattern of chapter 14, reused as is (features/leave/leave-list.page.ts):
 * query params → signal inputs → a `computed()` query (`resolveCorrectionQuery`, pure) → `httpResource`; widgets
 * READ the URL and WRITE only through `router.navigate(…, { queryParamsHandling: 'merge' })`; keystrokes use
 * `replaceUrl`; any filter change resets `page`. New here: **a default that is not "everything"** — the list opens
 * on `pending`, so "every status" needs its own URL value (`?status=all`, hr-list-state.ts).
 */
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { debounceTime, filter, Subject } from 'rxjs';
import { AttendanceApi } from '../../core/attendance/attendance-api';
import {
  CORRECTION_PAGE_SIZES,
  CORRECTION_STATUSES,
  type CorrectionQuery,
  type CorrectionView,
  DEFAULT_CORRECTION_QUERY,
} from '../../core/attendance/attendance.models';
import { Session } from '../../core/auth/session';
import { isApiProblemError, PROBLEM_TYPE_NETWORK } from '../../core/http/api-problem';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { LeaveCatalog } from '../../core/leave/leave-catalog';
import { CorrectionChanges } from '../../shared/attendance/correction-changes';
import { DisplayNamePipe } from '../../shared/display-name/display-name.pipe';
import { OrgUnitPicker } from '../../shared/org-unit-picker/org-unit-picker';
import { ALL_STATUSES, resolveCorrectionQuery, toCorrectionQueryParams } from './hr-list-state';

export const CORRECTIONS_SEARCH_DEBOUNCE_MS = 300;

@Component({
  selector: 'app-corrections-page',
  imports: [TranslocoDirective, RouterLink, ReactiveFormsModule, DatePipe, DisplayNamePipe, OrgUnitPicker, CorrectionChanges],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './corrections.page.html',
  styleUrl: './attendance.css',
})
export class CorrectionsPage {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly catalog = inject(LeaveCatalog);
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));

  // Query params (names = URL param names), bound by the router.
  readonly status = input<string>();
  readonly unitId = input<string>();
  readonly includeSubUnits = input<string>();
  readonly from = input<string>();
  readonly to = input<string>();
  readonly q = input<string>();
  readonly page = input<string>();
  readonly pageSize = input<string>();

  protected readonly query = computed<CorrectionQuery>(() =>
    resolveCorrectionQuery({
      status: this.status(),
      unitId: this.unitId(),
      includeSubUnits: this.includeSubUnits(),
      from: this.from(),
      to: this.to(),
      q: this.q(),
      page: this.page(),
      pageSize: this.pageSize(),
    }),
  );
  protected readonly list = inject(AttendanceApi).correctionsResource(this.query);
  protected readonly items = computed<readonly CorrectionView[]>(() => (this.list.hasValue() ? this.list.value().items : []));
  protected readonly pageCount = computed(() =>
    this.list.hasValue() ? Math.max(1, Math.ceil(this.list.value().total / this.query().pageSize)) : 1,
  );
  protected readonly filtered = computed(() => {
    const { status, unitId, from, to, q } = this.query();
    return status !== DEFAULT_CORRECTION_QUERY.status || !!unitId || !!from || !!to || q.trim() !== '';
  });
  protected readonly errorKey = computed(() => {
    const error = this.list.error();
    if (isApiProblemError(error)) {
      if (error.problem.type === PROBLEM_TYPE_NETWORK) return 'errors.network';
      if (error.status === 403) return 'errors.forbidden';
    }
    return 'attendance.corrections.loadError';
  });

  protected readonly canUnits = inject(Session).allows('org_unit.read');
  protected readonly statuses = CORRECTION_STATUSES;
  protected readonly all = ALL_STATUSES;
  protected readonly pageSizes = CORRECTION_PAGE_SIZES;
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
        debounceTime(CORRECTIONS_SEARCH_DEBOUNCE_MS),
        filter((q) => q !== this.query().q),
        takeUntilDestroyed(),
      )
      .subscribe((q) => this.update({ q }, true));
  }

  protected update(change: Partial<CorrectionQuery>, replaceUrl = false): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: toCorrectionQueryParams({ page: 1, ...change }),
      queryParamsHandling: 'merge',
      replaceUrl,
    });
  }

  protected onSearchInput(event: Event): void {
    this.searches.next(event.target instanceof HTMLInputElement ? event.target.value : '');
  }

  protected onField(key: 'status' | 'from' | 'to' | 'pageSize', event: Event): void {
    const target = event.target;
    const value = target instanceof HTMLSelectElement || target instanceof HTMLInputElement ? target.value : '';
    if (key === 'pageSize') this.update({ pageSize: Number(value) });
    else if (key === 'status') this.update({ status: resolveCorrectionQuery({ status: value }).status });
    else this.update({ [key]: value || null });
  }

  protected onIncludeSubUnits(event: Event): void {
    this.update({ includeSubUnits: event.target instanceof HTMLInputElement && event.target.checked });
  }

  protected goToPage(page: number): void {
    this.update({ page: Math.min(Math.max(1, page), this.pageCount()) });
  }

  protected clearFilters(): void {
    const d = DEFAULT_CORRECTION_QUERY;
    this.update({ status: d.status, unitId: null, includeSubUnits: true, from: null, to: null, q: '' });
  }

  /** The current step's label, for pending requests. */
  protected currentStep(c: CorrectionView): string {
    const w = c.workflow;
    if (c.status !== 'pending' || !w || w.currentStep === null) return '';
    const step = w.steps[w.currentStep];
    return step ? this.catalog.labelOf(step.labels) : '';
  }
}
