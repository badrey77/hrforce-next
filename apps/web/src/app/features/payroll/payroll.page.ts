/**
 * /payroll — the month's payroll variables (`payroll.read`, docs/contracts/payroll-variables.md › Web builder 1): the
 * month bar (12 months of a year with their status, `?month=`), the period header (status, cut-off, totals, flags,
 * close / reopen / export / control report), the variables table with its filter bar (all in the URL, paged; cards
 * below 700 px) and the employee panel (`?employee=`).
 */
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, linkedSignal, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { debounceTime, filter, Subject } from 'rxjs';
import { algiersToday } from '../../core/attendance/attendance.models';
import { Session } from '../../core/auth/session';
import { isApiProblemError, PROBLEM_TYPE_NETWORK } from '../../core/http/api-problem';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { PayrollApi } from '../../core/payroll/payroll-api';
import {
  DEFAULT_VARIABLES_QUERY,
  type EmployeeVariables,
  monthKey,
  type PayrollLine,
  type RubriqueView,
  VARIABLES_FILTERS,
  type VariablesQuery,
} from '../../core/payroll/payroll.models';
import { CanDirective } from '../../shared/can/can.directive';
import { DisplayNamePipe } from '../../shared/display-name/display-name.pipe';
import { FilterBar } from '../../shared/filter-bar/filter-bar.directive';
import { OrgUnitPicker } from '../../shared/org-unit-picker/org-unit-picker';
import { PayrollEmployeePanel } from './employee-panel';
import { PayrollPeriodHeader } from './period-header';
import {
  defaultMonth,
  formatValue,
  monthsOfYear,
  type PayrollChange,
  periodLabel,
  resolvePayrollQuery,
  toPayrollQueryParams,
  unitKey,
  VARIABLES_PAGE_SIZES,
} from './payroll-state';

export const PAYROLL_SEARCH_DEBOUNCE_MS = 300;

/** Translation key of a failed read (the month list, the period, the variables). */
export function loadErrorKey(error: unknown, fallback: string): string {
  if (isApiProblemError(error)) {
    if (error.problem.type === PROBLEM_TYPE_NETWORK) return 'errors.network';
    if (error.status === 403) return 'errors.forbidden';
  }
  return fallback;
}

@Component({
  selector: 'app-payroll-page',
  imports: [TranslocoDirective, ReactiveFormsModule, RouterLink, CanDirective, DatePipe, DisplayNamePipe, OrgUnitPicker, FilterBar, PayrollPeriodHeader, PayrollEmployeePanel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './payroll.page.html',
  styleUrl: './payroll-month.css',
})
export class PayrollPage {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(PayrollApi);
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));
  protected readonly currentMonth = algiersToday().slice(0, 7);
  protected readonly currentYear = Number(this.currentMonth.slice(0, 4));

  // Query params, bound by the router.
  readonly month = input<string>();
  readonly unitId = input<string>();
  readonly includeSubUnits = input<string>();
  readonly q = input<string>();
  readonly rubriqueId = input<string>();
  readonly filter = input<string>();
  readonly page = input<string>();
  readonly pageSize = input<string>();
  readonly employee = input<string>();

  protected readonly query = computed(() =>
    resolvePayrollQuery(
      {
        month: this.month(),
        unitId: this.unitId(),
        includeSubUnits: this.includeSubUnits(),
        q: this.q(),
        rubriqueId: this.rubriqueId(),
        filter: this.filter(),
        page: this.page(),
        pageSize: this.pageSize(),
        employee: this.employee(),
      },
      this.currentMonth,
    ),
  );
  protected readonly variablesQuery = computed<VariablesQuery>(() => this.query().variables, { equal: sameQuery });

  /** The year the month bar shows: the shown month's, until the year switcher moves it. */
  protected readonly year = linkedSignal(() => Number((this.query().month ?? this.currentMonth).slice(0, 4)));
  protected readonly periods = this.api.periodsResource(() => this.year());
  /** The default month, fixed once the current year's months are known (so it does not move after a close). */
  private readonly fallbackMonth = signal<string | null>(null);
  protected readonly shownMonth = computed<string | null>(() => this.query().month ?? this.fallbackMonth());

  protected readonly months = computed(() => monthsOfYear(this.year(), this.periods.hasValue() ? this.periods.value().items : [], this.currentMonth));
  protected readonly period = this.api.periodResource(this.shownMonth);
  protected readonly variables = this.api.variablesResource(this.shownMonth, this.variablesQuery, this.lang);
  protected readonly items = computed<readonly EmployeeVariables[]>(() => (this.variables.hasValue() ? this.variables.value().items : []));
  protected readonly total = computed(() => (this.variables.hasValue() ? this.variables.value().total : 0));
  protected readonly pageCount = computed(() => Math.max(1, Math.ceil(this.total() / this.variablesQuery().pageSize)));
  protected readonly rubriques = this.api.rubriquesResource();
  protected readonly rubriqueItems = computed<readonly RubriqueView[]>(() => (this.rubriques.hasValue() ? this.rubriques.value().items : []));

  protected readonly filtered = computed(() => {
    const { q, unitId, rubriqueId, filter: f } = this.variablesQuery();
    return q.trim() !== '' || !!unitId || !!rubriqueId || !!f;
  });
  protected readonly periodsErrorKey = computed(() => loadErrorKey(this.periods.error(), 'payroll.month.loadError'));
  protected readonly periodErrorKey = computed(() => loadErrorKey(this.period.error(), 'payroll.month.loadError'));
  protected readonly variablesErrorKey = computed(() => loadErrorKey(this.variables.error(), 'payroll.month.variables.loadError'));
  /** The export and the control report follow the unit filter on screen. */
  protected readonly exportFilter = computed(() => {
    const { unitId, includeSubUnits } = this.variablesQuery();
    return { unitId, includeSubUnits };
  });

  protected readonly canUnits = inject(Session).allows('org_unit.read');
  protected readonly filters = VARIABLES_FILTERS;
  protected readonly pageSizes = VARIABLES_PAGE_SIZES;
  protected readonly unitControl = new FormControl<string | null>(null);
  private readonly searches = new Subject<string>();

  protected readonly periodLabel = periodLabel;
  protected readonly unitKey = unitKey;

  constructor() {
    effect(() => {
      if (this.query().month || this.fallbackMonth()) return;
      if (this.year() !== this.currentYear) return;
      if (this.periods.hasValue()) this.fallbackMonth.set(defaultMonth(this.periods.value().items, this.currentMonth));
      else if (this.periods.error()) this.fallbackMonth.set(this.currentMonth);
    });
    effect(() => {
      const unitId = this.variablesQuery().unitId;
      if (this.unitControl.value !== unitId) this.unitControl.setValue(unitId, { emitEvent: false });
    });
    this.unitControl.valueChanges.pipe(takeUntilDestroyed()).subscribe((unitId) => this.update({ unitId }));
    this.searches
      .pipe(
        debounceTime(PAYROLL_SEARCH_DEBOUNCE_MS),
        filter((q) => q !== this.variablesQuery().q),
        takeUntilDestroyed(),
      )
      .subscribe((q) => this.update({ q }, true));
  }

  protected update(change: PayrollChange, replaceUrl = false): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: toPayrollQueryParams({ page: 1, ...change }),
      queryParamsHandling: 'merge',
      replaceUrl,
    });
  }

  /** A month of the bar; the month param stays in the URL so the choice survives a reload. */
  protected selectMonth(month: string): void {
    if (month > this.currentMonth || month === this.shownMonth()) return;
    this.update({ month, employee: null });
  }

  protected shiftYear(delta: number): void {
    const next = this.year() + delta;
    if (next > this.currentYear) return;
    this.year.set(next);
  }

  protected onSearchInput(event: Event): void {
    this.searches.next(event.target instanceof HTMLInputElement ? event.target.value : '');
  }

  protected onSelect(key: 'rubriqueId' | 'filter' | 'pageSize', event: Event): void {
    const value = event.target instanceof HTMLSelectElement ? event.target.value : '';
    if (key === 'pageSize') this.update({ pageSize: Number(value) });
    else if (key === 'filter') this.update({ filter: resolvePayrollQuery({ filter: value }, this.currentMonth).variables.filter });
    else this.update({ rubriqueId: value || null });
  }

  protected onIncludeSubUnits(event: Event): void {
    this.update({ includeSubUnits: event.target instanceof HTMLInputElement && event.target.checked });
  }

  protected goToPage(page: number): void {
    this.update({ page: Math.min(Math.max(1, page), this.pageCount()) });
  }

  protected clearFilters(): void {
    const d = DEFAULT_VARIABLES_QUERY;
    this.update({ q: '', unitId: null, includeSubUnits: d.includeSubUnits, rubriqueId: null, filter: null });
  }

  protected openEmployee(id: string): void {
    // Keep the current page: opening a panel is not a new search.
    void this.router.navigate([], { relativeTo: this.route, queryParams: { employee: id }, queryParamsHandling: 'merge' });
  }

  protected closeEmployee(): void {
    void this.router.navigate([], { relativeTo: this.route, queryParams: { employee: null }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  /** Something changed the month (a line, a close, a reopen): every view of it is read again. */
  protected reloadAll(): void {
    this.periods.reload();
    this.period.reload();
    this.variables.reload();
  }

  protected chipValue(line: PayrollLine): string {
    return formatValue(line.value, this.locale());
  }

  protected isRegularization(line: PayrollLine, month: string): boolean {
    return monthKey(line.originMonth) !== month;
  }

  protected rubriqueName(r: RubriqueView): string {
    return r.names[this.lang()] || r.names.fr;
  }
}

function sameQuery(a: VariablesQuery, b: VariablesQuery): boolean {
  return (
    a.unitId === b.unitId &&
    a.includeSubUnits === b.includeSubUnits &&
    a.q === b.q &&
    a.rubriqueId === b.rubriqueId &&
    a.filter === b.filter &&
    a.page === b.page &&
    a.pageSize === b.pageSize
  );
}
