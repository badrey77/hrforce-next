/**
 * /attendance/reports — the monthly attendance report (`attendance.read`, docs/contracts/attendance.md › Web
 * (Phase B) › HR): a month picker (‹ month ›, never after the current month), unit (+ sub-units), site, search and
 * paging — ALL in the URL — a table of totals per employee (present, late, minutes late, absent, incomplete, leave,
 * holidays, hours worked / scheduled, absence dates) that becomes cards at 390 px, and « Exporter CSV ».
 *
 * Angular concepts:
 * - **URL as state** (chapter 14) with a month instead of a date: `?month=` is absent for the current month (a
 *   bookmarked "this month" stays "this month"), `resolveReportQuery()` drops a malformed or future month.
 * - **A download driven by the same query as the page.** « Exporter CSV » calls `AttendanceApi.monthlyReportCsv()`
 *   (`responseType: 'blob'`) with the filters on screen — no search (the contract's CSV has none) and no paging
 *   (all rows) — and `lang` = the UI language, so the header row is in Arabic for an Arabic UI. The Blob goes to
 *   `BlobFiles.save()` (`<a download="presence-<month>.csv">`, chapter 18), a service provided by THIS component
 *   (`providers: [BlobFiles]`), so its object URLs are cleaned up with it.
 * - **A busy flag instead of a disabled form**: `exporting` disables only the button (the table stays usable), and a
 *   `role="alert"` line explains a failure — e.g. 422 when more than 5 000 rows would be exported.
 * - Minutes are shown with the attendance `minutes` pipe; the API's `h:mm` format is the CSV's business.
 */
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { debounceTime, filter, Subject } from 'rxjs';
import { AttendanceApi } from '../../core/attendance/attendance-api';
import {
  addMonths,
  algiersToday,
  DEFAULT_REPORT_QUERY,
  REPORT_PAGE_SIZES,
  reportFileName,
  type ReportQuery,
} from '../../core/attendance/attendance.models';
import { Session } from '../../core/auth/session';
import { BlobFiles } from '../../core/browser/blob-files';
import { isApiProblemError, PROBLEM_TYPE_NETWORK } from '../../core/http/api-problem';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { OrgApi } from '../../core/org/org-api';
import { MinutesPipe } from '../../shared/attendance/minutes.pipe';
import { DisplayNamePipe } from '../../shared/display-name/display-name.pipe';
import { OrgUnitPicker } from '../../shared/org-unit-picker/org-unit-picker';
import { resolveReportQuery, toReportQueryParams } from './hr-list-state';

export const REPORT_SEARCH_DEBOUNCE_MS = 300;

/** Translation key for a failed report (page or CSV). */
export function reportErrorKey(error: unknown, fallback: string): string {
  if (!isApiProblemError(error)) return fallback;
  if (error.problem.type === PROBLEM_TYPE_NETWORK) return 'errors.network';
  if (error.status === 403) return 'errors.forbidden';
  if (error.status === 422) return 'attendance.reports.tooMany';
  return fallback;
}

@Component({
  selector: 'app-monthly-report-page',
  imports: [TranslocoDirective, RouterLink, ReactiveFormsModule, DatePipe, DisplayNamePipe, MinutesPipe, OrgUnitPicker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [BlobFiles],
  templateUrl: './monthly-report.page.html',
  styleUrl: './attendance.css',
})
export class MonthlyReportPage {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(AttendanceApi);
  private readonly files = inject(BlobFiles);
  private readonly session = inject(Session);
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));
  protected readonly currentMonth = algiersToday().slice(0, 7);

  readonly month = input<string>();
  readonly unitId = input<string>();
  readonly includeSubUnits = input<string>();
  readonly siteId = input<string>();
  readonly q = input<string>();
  readonly page = input<string>();
  readonly pageSize = input<string>();

  protected readonly query = computed<ReportQuery>(() =>
    resolveReportQuery(
      {
        month: this.month(),
        unitId: this.unitId(),
        includeSubUnits: this.includeSubUnits(),
        siteId: this.siteId(),
        q: this.q(),
        page: this.page(),
        pageSize: this.pageSize(),
      },
      this.currentMonth,
    ),
  );
  /** The month on screen. */
  protected readonly shownMonth = computed(() => this.query().month ?? this.currentMonth);
  protected readonly report = this.api.monthlyReportResource(this.query, this.currentMonth);
  protected readonly pageCount = computed(() =>
    this.report.hasValue() ? Math.max(1, Math.ceil(this.report.value().total / this.query().pageSize)) : 1,
  );
  protected readonly filtered = computed(() => {
    const { unitId, siteId, q } = this.query();
    return !!unitId || !!siteId || q.trim() !== '';
  });
  protected readonly errorKey = computed(() => reportErrorKey(this.report.error(), 'attendance.reports.loadError'));

  protected readonly canUnits = this.session.allows('org_unit.read');
  protected readonly canSites = this.session.allows('site.read');
  protected readonly sites = inject(OrgApi).sitesResource(() => undefined, this.canSites);
  protected readonly siteItems = computed(() => (this.sites.hasValue() ? this.sites.value().items : []));

  protected readonly pageSizes = REPORT_PAGE_SIZES;
  protected readonly unitControl = new FormControl<string | null>(null);
  private readonly searches = new Subject<string>();

  protected readonly exporting = signal(false);
  protected readonly exportError = signal<string | null>(null);

  constructor() {
    effect(() => {
      const unitId = this.query().unitId;
      if (this.unitControl.value !== unitId) this.unitControl.setValue(unitId, { emitEvent: false });
    });
    this.unitControl.valueChanges.pipe(takeUntilDestroyed()).subscribe((unitId) => this.update({ unitId }));
    this.searches
      .pipe(
        debounceTime(REPORT_SEARCH_DEBOUNCE_MS),
        filter((q) => q !== this.query().q),
        takeUntilDestroyed(),
      )
      .subscribe((q) => this.update({ q }, true));
  }

  protected update(change: Partial<ReportQuery>, replaceUrl = false): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: toReportQueryParams({ page: 1, ...change }),
      queryParamsHandling: 'merge',
      replaceUrl,
    });
  }

  protected shiftMonth(delta: number): void {
    const next = addMonths(this.shownMonth(), delta);
    this.update({ month: next >= this.currentMonth ? null : next });
  }

  protected onMonth(event: Event): void {
    const value = event.target instanceof HTMLInputElement ? event.target.value : '';
    this.update({ month: resolveReportQuery({ month: value }, this.currentMonth).month });
  }

  protected onSearchInput(event: Event): void {
    this.searches.next(event.target instanceof HTMLInputElement ? event.target.value : '');
  }

  protected onSelect(key: 'siteId' | 'pageSize', event: Event): void {
    const value = event.target instanceof HTMLSelectElement ? event.target.value : '';
    if (key === 'pageSize') this.update({ pageSize: Number(value) });
    else this.update({ siteId: value || null });
  }

  protected onIncludeSubUnits(event: Event): void {
    this.update({ includeSubUnits: event.target instanceof HTMLInputElement && event.target.checked });
  }

  protected goToPage(page: number): void {
    this.update({ page: Math.min(Math.max(1, page), this.pageCount()) });
  }

  protected clearFilters(): void {
    const d = DEFAULT_REPORT_QUERY;
    this.update({ unitId: null, includeSubUnits: d.includeSubUnits, siteId: null, q: '' });
  }

  /** « Exporter CSV »: the filters on screen, every row, header row in the UI language. */
  protected exportCsv(): void {
    const month = this.shownMonth();
    this.exporting.set(true);
    this.exportError.set(null);
    this.files.save(this.api.monthlyReportCsv(this.query(), this.currentMonth, this.lang()), reportFileName(month)).subscribe({
      next: () => this.exporting.set(false),
      error: (error: unknown) => {
        this.exporting.set(false);
        this.exportError.set(reportErrorKey(error, 'attendance.reports.exportError'));
      },
    });
  }
}
