import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { debounceTime, filter, Subject } from 'rxjs';
import { Session } from '../../core/auth/session';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { RecruitmentApi } from '../../core/recruitment/recruitment-api';
import {
  activeCount,
  CONTRACT_TYPES,
  DEFAULT_OPENING_QUERY,
  OPENING_STATUS_FILTERS,
  type OpeningQuery,
  type OpeningSort,
  type OpeningStatusFilter,
  type OpeningView,
  PAGE_SIZES,
  type SummaryView,
} from '../../core/recruitment/recruitment.models';
import { CanDirective } from '../../shared/can/can.directive';
import { DisplayNamePipe } from '../../shared/display-name/display-name.pipe';
import { OrgUnitPicker } from '../../shared/org-unit-picker/org-unit-picker';
import { defaultDir, resolveOpeningQuery, toQueryParams } from './list-state';
import { loadErrorKey, statusTone } from './recruitment-view';

export const OPENINGS_SEARCH_DEBOUNCE_MS = 300;

/** The count shown on a status chip; null until the summary arrives. */
export function chipCount(summary: SummaryView | undefined, status: OpeningStatusFilter): number | null {
  if (!summary) return null;
  const counts = summary.openings;
  if (status === 'active') return counts.pending + counts.open;
  if (status === 'all') return Object.values(counts).reduce((sum, n) => sum + n, 0);
  return counts[status];
}

@Component({
  selector: 'app-recruitment-openings-page',
  imports: [TranslocoDirective, RouterLink, ReactiveFormsModule, DatePipe, DisplayNamePipe, OrgUnitPicker, CanDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './openings.page.html',
  styleUrl: './recruitment.css',
})
export class OpeningsPage {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(RecruitmentApi);
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));

  readonly status = input<string>();
  readonly unitId = input<string>();
  readonly includeSubUnits = input<string>();
  readonly contractType = input<string>();
  readonly q = input<string>();
  readonly sort = input<string>();
  readonly dir = input<string>();
  readonly page = input<string>();
  readonly pageSize = input<string>();

  protected readonly query = computed<OpeningQuery>(() =>
    resolveOpeningQuery({
      status: this.status(),
      unitId: this.unitId(),
      includeSubUnits: this.includeSubUnits(),
      contractType: this.contractType(),
      q: this.q(),
      // oxlint-disable-next-line unicorn/no-array-sort -- a signal input named after the `sort` query param, not Array#sort
      sort: this.sort(),
      dir: this.dir(),
      page: this.page(),
      pageSize: this.pageSize(),
    }),
  );
  protected readonly list = this.api.openingsResource(this.query);
  private readonly summary = this.api.summaryResource(() => true);
  protected readonly items = computed<readonly OpeningView[]>(() => (this.list.hasValue() ? this.list.value().items : []));
  protected readonly pageCount = computed(() =>
    this.list.hasValue() ? Math.max(1, Math.ceil(this.list.value().total / this.query().pageSize)) : 1,
  );
  protected readonly filtered = computed(() => {
    const { status, unitId, contractType, q } = this.query();
    return status !== DEFAULT_OPENING_QUERY.status || !!unitId || !!contractType || q.trim() !== '';
  });
  protected readonly errorKey = computed(() => loadErrorKey(this.list.error(), 'recruitment.openings.loadError'));
  protected readonly chips = computed(() => {
    const summary = this.summary.hasValue() ? this.summary.value() : undefined;
    return OPENING_STATUS_FILTERS.map((status) => ({ status, count: chipCount(summary, status) }));
  });

  protected readonly canUnits = inject(Session).allows('org_unit.read');
  protected readonly contractTypes = CONTRACT_TYPES;
  protected readonly pageSizes = PAGE_SIZES;
  protected readonly tone = statusTone;
  protected readonly inProgress = activeCount;
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
        debounceTime(OPENINGS_SEARCH_DEBOUNCE_MS),
        filter((q) => q !== this.query().q),
        takeUntilDestroyed(),
      )
      .subscribe((q) => this.update({ q }, true));
  }

  protected update(change: Partial<OpeningQuery>, replaceUrl = false): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: toQueryParams({ page: 1, ...change }, DEFAULT_OPENING_QUERY),
      queryParamsHandling: 'merge',
      replaceUrl,
    });
  }

  protected onSearchInput(event: Event): void {
    this.searches.next(event.target instanceof HTMLInputElement ? event.target.value : '');
  }

  protected onContractType(event: Event): void {
    const value = event.target instanceof HTMLSelectElement ? event.target.value : '';
    this.update({ contractType: resolveOpeningQuery({ contractType: value }).contractType });
  }

  protected onPageSize(event: Event): void {
    if (event.target instanceof HTMLSelectElement) this.update({ pageSize: Number(event.target.value) });
  }

  protected onIncludeSubUnits(event: Event): void {
    this.update({ includeSubUnits: event.target instanceof HTMLInputElement && event.target.checked });
  }

  protected sortBy(sort: OpeningSort): void {
    const current = this.query();
    const dir = current.sort === sort ? (current.dir === 'asc' ? 'desc' : 'asc') : defaultDir(sort);
    this.update({ sort, dir });
  }

  protected ariaSort(sort: OpeningSort): 'ascending' | 'descending' | null {
    const current = this.query();
    if (current.sort !== sort) return null;
    return current.dir === 'asc' ? 'ascending' : 'descending';
  }

  protected goToPage(page: number): void {
    this.update({ page: Math.min(Math.max(1, page), this.pageCount()) });
  }

  protected clearFilters(): void {
    this.update({ status: DEFAULT_OPENING_QUERY.status, unitId: null, includeSubUnits: true, contractType: null, q: '' });
  }
}
