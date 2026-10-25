/**
 * /employees/profile-requests — the HR list of the employees' profile change requests (`employee.personal.read`,
 * docs/contracts/profile-changes.md › Web builder 1): status, section, employee, date, changed fields, and per row the
 * before → after. Filters live in the URL (search, status — pending by default —, section, unit). Requests waiting
 * for a decision are handled in « Mes tâches »; bank requests are listed only for `employee.bank.read` holders (API).
 * Rows become cards below 640 px.
 */
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { debounceTime, filter, Subject } from 'rxjs';
import { Session } from '../../core/auth/session';
import { isApiProblemError, PROBLEM_TYPE_NETWORK } from '../../core/http/api-problem';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { ProfileApi } from '../../core/profile/profile-api';
import {
  DEFAULT_PROFILE_REQUEST_QUERY,
  PROFILE_REQUEST_STATUSES,
  PROFILE_SECTIONS,
  type ProfileRequestQuery,
  type ProfileRequestView,
} from '../../core/profile/profile.models';
import { DisplayNamePipe } from '../../shared/display-name/display-name.pipe';
import { FilterBar } from '../../shared/filter-bar/filter-bar.directive';
import { OrgUnitPicker } from '../../shared/org-unit-picker/org-unit-picker';
import { ProfileRequestDiff } from '../../shared/profile/profile-request-diff';
import { ALL_STATUSES, PROFILE_REQUEST_PAGE_SIZES, resolveRequestQuery, toRequestQueryParams } from './profile-requests-state';

export const REQUEST_SEARCH_DEBOUNCE_MS = 300;

@Component({
  selector: 'app-profile-requests-page',
  imports: [TranslocoDirective, RouterLink, ReactiveFormsModule, DatePipe, DisplayNamePipe, OrgUnitPicker, FilterBar, ProfileRequestDiff],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './profile-requests.page.html',
  styleUrls: ['./employees.css', './personal.css'],
})
export class ProfileRequestsPage {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(ProfileApi);
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));
  protected readonly canUnits = inject(Session).allows('org_unit.read');
  protected readonly canBank = inject(Session).allows('employee.bank.read');

  // Query params, bound by the router.
  readonly q = input<string>();
  readonly status = input<string>();
  readonly section = input<string>();
  readonly unitId = input<string>();
  readonly includeSubUnits = input<string>();
  readonly page = input<string>();
  readonly pageSize = input<string>();

  protected readonly query = computed<ProfileRequestQuery>(() =>
    resolveRequestQuery({
      q: this.q(),
      status: this.status(),
      section: this.section(),
      unitId: this.unitId(),
      includeSubUnits: this.includeSubUnits(),
      page: this.page(),
      pageSize: this.pageSize(),
    }),
  );
  protected readonly list = this.api.requestsResource(this.query);
  protected readonly items = computed<readonly ProfileRequestView[]>(() => (this.list.hasValue() ? this.list.value().items : []));
  protected readonly total = computed(() => (this.list.hasValue() ? this.list.value().total : 0));
  protected readonly pageCount = computed(() => Math.max(1, Math.ceil(this.total() / this.query().pageSize)));
  protected readonly filtered = computed(() => {
    const { q, status, section, unitId } = this.query();
    return q.trim() !== '' || status !== DEFAULT_PROFILE_REQUEST_QUERY.status || section !== '' || !!unitId;
  });
  protected readonly errorKey = computed(() => {
    const error = this.list.error();
    if (isApiProblemError(error)) {
      if (error.problem.type === PROBLEM_TYPE_NETWORK) return 'errors.network';
      if (error.status === 403) return 'errors.forbidden';
    }
    return 'personal.loadError';
  });

  /** Bank requests are only listed for bank-details readers; the section filter offers what can match. */
  protected readonly sections = computed(() => PROFILE_SECTIONS.filter((s) => s !== 'bank' || this.canBank()));
  protected readonly statuses = PROFILE_REQUEST_STATUSES;
  protected readonly allStatuses = ALL_STATUSES;
  protected readonly pageSizes = PROFILE_REQUEST_PAGE_SIZES;
  protected readonly unitControl = new FormControl<string | null>(null);
  private readonly searches = new Subject<string>();
  protected readonly expanded = signal<string | null>(null);

  constructor() {
    effect(() => {
      const unitId = this.query().unitId;
      if (this.unitControl.value !== unitId) this.unitControl.setValue(unitId, { emitEvent: false });
    });
    this.unitControl.valueChanges.pipe(takeUntilDestroyed()).subscribe((unitId) => this.update({ unitId }));
    this.searches
      .pipe(
        debounceTime(REQUEST_SEARCH_DEBOUNCE_MS),
        filter((q) => q !== this.query().q),
        takeUntilDestroyed(),
      )
      .subscribe((q) => this.update({ q }, true));
  }

  protected update(change: Partial<ProfileRequestQuery>, replaceUrl = false): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: toRequestQueryParams({ page: 1, ...change }),
      queryParamsHandling: 'merge',
      replaceUrl,
    });
  }

  protected onSearchInput(event: Event): void {
    this.searches.next(event.target instanceof HTMLInputElement ? event.target.value : '');
  }

  protected onField(key: 'status' | 'section' | 'pageSize', event: Event): void {
    const value = event.target instanceof HTMLSelectElement ? event.target.value : '';
    if (key === 'pageSize') this.update({ pageSize: Number(value) });
    else if (key === 'status') this.update({ status: resolveRequestQuery({ status: value }).status });
    else this.update({ section: resolveRequestQuery({ section: value }).section });
  }

  protected onIncludeSubUnits(event: Event): void {
    this.update({ includeSubUnits: event.target instanceof HTMLInputElement && event.target.checked });
  }

  protected goToPage(page: number): void {
    this.update({ page: Math.min(Math.max(1, page), this.pageCount()) });
  }

  protected clearFilters(): void {
    const d = DEFAULT_PROFILE_REQUEST_QUERY;
    this.update({ q: '', status: d.status, section: '', unitId: null, includeSubUnits: true });
  }

  protected toggle(request: ProfileRequestView): void {
    this.expanded.update((id) => (id === request.id ? null : request.id));
  }
}
