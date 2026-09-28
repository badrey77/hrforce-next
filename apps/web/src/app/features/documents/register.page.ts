/**
 * /documents — the register of issued documents (`document.read`): type, status, search (number, name, matricule),
 * unit (+ sub-units), issue-date range, server paging. The API returns only documents of employees in the caller's
 * scope (docs/contracts/documents.md › Scope).
 *
 * Angular concepts: the "URL as state" pattern of the employee and leave lists, reused as is (features/leave/
 * leave-list.page.ts and chapter 14 explain each step): query params → signal inputs → `computed()` query →
 * `httpResource`; widgets READ the URL and WRITE only through `router.navigate(…, { queryParamsHandling: 'merge' })`;
 * keystrokes use `replaceUrl`; any filter change resets `page`. The type filter lists the types of the root
 * `DocumentCatalog` (labels in the active language); the URL keeps the type CODE, so a language switch does not touch
 * it. The rows are the shared `<app-document-table>`.
 */
import { ChangeDetectionStrategy, Component, computed, effect, inject, input } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { debounceTime, filter, Subject } from 'rxjs';
import { Session } from '../../core/auth/session';
import { DocumentCatalog } from '../../core/documents/document-catalog';
import { DocumentsApi } from '../../core/documents/documents-api';
import {
  DEFAULT_DOCUMENT_QUERY,
  DOCUMENT_PAGE_SIZES,
  DOCUMENT_STATUS_FILTERS,
  type DocumentQuery,
  type IssuedDocumentView,
} from '../../core/documents/documents.models';
import { isApiProblemError, PROBLEM_TYPE_NETWORK } from '../../core/http/api-problem';
import { CanDirective } from '../../shared/can/can.directive';
import { DocumentTable } from '../../shared/documents/document-table';
import { OrgUnitPicker } from '../../shared/org-unit-picker/org-unit-picker';
import { type RegisterQueryKey, resolveRegisterQuery, toRegisterQueryParams } from './register-state';

export const REGISTER_SEARCH_DEBOUNCE_MS = 300;

@Component({
  selector: 'app-documents-register-page',
  imports: [TranslocoDirective, RouterLink, ReactiveFormsModule, CanDirective, OrgUnitPicker, DocumentTable],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './register.page.html',
})
export class RegisterPage {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  protected readonly catalog = inject(DocumentCatalog);

  // Query params (names = URL param names), bound by the router.
  readonly q = input<string>();
  readonly typeCode = input<string>();
  readonly status = input<string>();
  readonly unitId = input<string>();
  readonly includeSubUnits = input<string>();
  readonly from = input<string>();
  readonly to = input<string>();
  readonly page = input<string>();
  readonly pageSize = input<string>();

  protected readonly query = computed<DocumentQuery>(() =>
    resolveRegisterQuery({
      q: this.q(),
      typeCode: this.typeCode(),
      status: this.status(),
      unitId: this.unitId(),
      includeSubUnits: this.includeSubUnits(),
      from: this.from(),
      to: this.to(),
      page: this.page(),
      pageSize: this.pageSize(),
    }),
  );

  protected readonly list = inject(DocumentsApi).listResource(this.query);
  protected readonly items = computed<readonly IssuedDocumentView[]>(() => (this.list.hasValue() ? this.list.value().items : []));
  protected readonly total = computed(() => (this.list.hasValue() ? this.list.value().total : 0));
  protected readonly pageCount = computed(() => Math.max(1, Math.ceil(this.total() / this.query().pageSize)));
  protected readonly filtered = computed(() => {
    const { q, typeCode, status, unitId, from, to } = this.query();
    return q.trim() !== '' || !!typeCode || status !== DEFAULT_DOCUMENT_QUERY.status || !!unitId || !!from || !!to;
  });
  protected readonly errorKey = computed(() => {
    const error = this.list.error();
    if (isApiProblemError(error)) {
      if (error.problem.type === PROBLEM_TYPE_NETWORK) return 'errors.network';
      if (error.status === 403) return 'errors.forbidden';
    }
    return 'documents.list.loadError';
  });

  protected readonly canUnits = inject(Session).allows('org_unit.read');
  protected readonly statuses = DOCUMENT_STATUS_FILTERS;
  protected readonly pageSizes = DOCUMENT_PAGE_SIZES;
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
        debounceTime(REGISTER_SEARCH_DEBOUNCE_MS),
        filter((q) => q !== this.query().q),
        takeUntilDestroyed(),
      )
      .subscribe((q) => this.update({ q }, true));
  }

  protected update(change: Partial<Pick<DocumentQuery, RegisterQueryKey>>, replaceUrl = false): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: toRegisterQueryParams({ page: 1, ...change }),
      queryParamsHandling: 'merge',
      replaceUrl,
    });
  }

  protected onSearchInput(event: Event): void {
    this.searches.next(event.target instanceof HTMLInputElement ? event.target.value : '');
  }

  protected onField(key: 'status' | 'typeCode' | 'from' | 'to' | 'pageSize', event: Event): void {
    const target = event.target;
    const value = target instanceof HTMLSelectElement || target instanceof HTMLInputElement ? target.value : '';
    if (key === 'pageSize') this.update({ pageSize: Number(value) });
    else if (key === 'status') this.update({ status: resolveRegisterQuery({ status: value }).status });
    else this.update({ [key]: value || null });
  }

  protected onIncludeSubUnits(event: Event): void {
    this.update({ includeSubUnits: event.target instanceof HTMLInputElement && event.target.checked });
  }

  protected goToPage(page: number): void {
    this.update({ page: Math.min(Math.max(1, page), this.pageCount()) });
  }

  protected clearFilters(): void {
    this.update({ q: '', typeCode: null, status: DEFAULT_DOCUMENT_QUERY.status, unitId: null, includeSubUnits: true, from: null, to: null });
  }
}
