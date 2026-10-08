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
import { pickLabel } from '../../core/leave/leave-catalog';
import { RecruitmentApi } from '../../core/recruitment/recruitment-api';
import {
  APPLICATION_STATES,
  type ApplicationListItem,
  type CandidateQuery,
  type CandidateSort,
  daysSince,
  DEFAULT_CANDIDATE_QUERY,
  DEFAULT_OPENING_QUERY,
  IDLE_MONTHS,
  type OpeningView,
  PAGE_SIZES,
  STAGES,
} from '../../core/recruitment/recruitment.models';
import { DisplayNamePipe } from '../../shared/display-name/display-name.pipe';
import { OrgUnitPicker } from '../../shared/org-unit-picker/org-unit-picker';
import { defaultDir, resolveCandidateQuery, toQueryParams } from './list-state';
import { loadErrorKey, stageTone } from './recruitment-view';

export const CANDIDATES_SEARCH_DEBOUNCE_MS = 300;

/** One row per application the caller can see (a person who applied twice appears twice). */
@Component({
  selector: 'app-recruitment-candidates-page',
  imports: [TranslocoDirective, RouterLink, ReactiveFormsModule, DatePipe, DisplayNamePipe, OrgUnitPicker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './candidates.page.html',
  styleUrl: './recruitment.css',
})
export class CandidatesPage {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(RecruitmentApi);
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));

  readonly q = input<string>();
  readonly openingId = input<string>();
  readonly stage = input<string>();
  readonly state = input<string>();
  readonly idle = input<string>();
  readonly unitId = input<string>();
  readonly includeSubUnits = input<string>();
  readonly sort = input<string>();
  readonly dir = input<string>();
  readonly page = input<string>();
  readonly pageSize = input<string>();
  /** `?erased=1` after an erasure on request. */
  readonly erased = input<string>();

  protected readonly query = computed<CandidateQuery>(() =>
    resolveCandidateQuery({
      q: this.q(),
      openingId: this.openingId(),
      stage: this.stage(),
      state: this.state(),
      idle: this.idle(),
      unitId: this.unitId(),
      includeSubUnits: this.includeSubUnits(),
      // oxlint-disable-next-line unicorn/no-array-sort -- a signal input named after the `sort` query param, not Array#sort
      sort: this.sort(),
      dir: this.dir(),
      page: this.page(),
      pageSize: this.pageSize(),
    }),
  );
  protected readonly list = this.api.candidatesResource(this.query, this.lang);
  /** The openings of the filter: every status, the most recent hundred. */
  private readonly openingList = this.api.openingsResource(() => ({ ...DEFAULT_OPENING_QUERY, status: 'all', pageSize: 100 }));
  protected readonly openings = computed<readonly OpeningView[]>(() => (this.openingList.hasValue() ? this.openingList.value().items : []));
  protected readonly items = computed<readonly ApplicationListItem[]>(() => (this.list.hasValue() ? this.list.value().items : []));
  protected readonly pageCount = computed(() =>
    this.list.hasValue() ? Math.max(1, Math.ceil(this.list.value().total / this.query().pageSize)) : 1,
  );
  protected readonly filtered = computed(() => {
    const { q, openingId, stage, state, idle, unitId } = this.query();
    return q.trim() !== '' || !!openingId || !!stage || state !== DEFAULT_CANDIDATE_QUERY.state || idle || !!unitId;
  });
  protected readonly errorKey = computed(() => loadErrorKey(this.list.error(), 'recruitment.candidates.loadError'));

  protected readonly canUnits = inject(Session).allows('org_unit.read');
  protected readonly stages = STAGES;
  protected readonly states = APPLICATION_STATES;
  protected readonly pageSizes = PAGE_SIZES;
  protected readonly idleMonths = IDLE_MONTHS;
  protected readonly tone = stageTone;
  protected readonly days = daysSince;
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
        debounceTime(CANDIDATES_SEARCH_DEBOUNCE_MS),
        filter((q) => q !== this.query().q),
        takeUntilDestroyed(),
      )
      .subscribe((q) => this.update({ q }, true));
  }

  protected reasonOf(item: ApplicationListItem): string {
    return item.rejectionReason ? pickLabel(item.rejectionReason.labels, this.lang()) : '';
  }

  protected update(change: Partial<CandidateQuery>, replaceUrl = false): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { ...toQueryParams({ page: 1, ...change }, DEFAULT_CANDIDATE_QUERY), erased: null },
      queryParamsHandling: 'merge',
      replaceUrl,
    });
  }

  protected onSearchInput(event: Event): void {
    this.searches.next(event.target instanceof HTMLInputElement ? event.target.value : '');
  }

  protected onSelect(key: 'openingId' | 'stage' | 'state' | 'pageSize', event: Event): void {
    const value = event.target instanceof HTMLSelectElement ? event.target.value : '';
    if (key === 'pageSize') this.update({ pageSize: Number(value) });
    else if (key === 'openingId') this.update({ openingId: value || null });
    else if (key === 'stage') this.update({ stage: resolveCandidateQuery({ stage: value }).stage });
    else this.update({ state: resolveCandidateQuery({ state: value }).state });
  }

  protected onCheck(key: 'idle' | 'includeSubUnits', event: Event): void {
    this.update({ [key]: event.target instanceof HTMLInputElement && event.target.checked });
  }

  protected sortBy(sort: CandidateSort): void {
    const current = this.query();
    const dir = current.sort === sort ? (current.dir === 'asc' ? 'desc' : 'asc') : defaultDir(sort);
    this.update({ sort, dir });
  }

  protected ariaSort(sort: CandidateSort): 'ascending' | 'descending' | null {
    const current = this.query();
    if (current.sort !== sort) return null;
    return current.dir === 'asc' ? 'ascending' : 'descending';
  }

  protected goToPage(page: number): void {
    this.update({ page: Math.min(Math.max(1, page), this.pageCount()) });
  }

  protected clearFilters(): void {
    this.update({ q: '', openingId: null, stage: null, state: DEFAULT_CANDIDATE_QUERY.state, idle: false, unitId: null, includeSubUnits: true });
  }
}
