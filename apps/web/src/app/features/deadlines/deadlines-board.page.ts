/**
 * /deadlines — the deadlines board (`deadline.read`, docs/contracts/contracts-deadlines.md › Deadlines): what is
 * overdue, due in the next 30 days and later, in the caller's scope. Filters live in the URL (the documents register
 * pattern); the page's rows are grouped Overdue / Next 30 days / Later (and Handled when asked for).
 * Actions follow each item's `_actions`: « Traiter » (an ack with an optional note), « Annuler » (undo the ack),
 * « Lancer la décision » (HR opens the contract decision of a fixed-term contract).
 */
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, type ElementRef, inject, input, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { debounceTime, filter, type Observable, Subject } from 'rxjs';
import { Session } from '../../core/auth/session';
import { DeadlinesApi } from '../../core/deadlines/deadlines-api';
import { DeadlinesBadge } from '../../core/deadlines/deadlines-badge';
import {
  ACK_NOTE_MAX,
  ackSubjectId,
  DEADLINE_KINDS,
  DEADLINE_PAGE_SIZES,
  DEADLINE_STATUS_FILTERS,
  DEADLINE_WITHIN_OPTIONS,
  DEFAULT_DEADLINE_QUERY,
  type DeadlineItem,
  type DeadlineQuery,
  groupItems,
} from '../../core/deadlines/deadlines.models';
import { isApiProblemError, PROBLEM_TYPE_NETWORK } from '../../core/http/api-problem';
import { problemSlug } from '../../core/http/problem-form';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { CanDirective } from '../../shared/can/can.directive';
import { DisplayNamePipe } from '../../shared/display-name/display-name.pipe';
import { OrgUnitPicker } from '../../shared/org-unit-picker/org-unit-picker';
import { type BoardQueryKey, resolveBoardQuery, toBoardQueryParams } from './board-state';

export const BOARD_SEARCH_DEBOUNCE_MS = 300;

/** Translation key for a failed board action. */
export function actionErrorKey(error: unknown): string {
  if (!isApiProblemError(error)) return 'errors.generic';
  switch (problemSlug(error.problem.type)) {
    case 'deadline-already-handled':
      return 'deadlines.problems.alreadyHandled';
    case 'contract-decision-pending':
      return 'deadlines.problems.decisionPending';
    case 'contract-not-fixed-term':
      return 'deadlines.problems.notFixedTerm';
    case 'employment-ended':
      return 'deadlines.problems.employmentEnded';
    default:
      if (error.problem.type === PROBLEM_TYPE_NETWORK) return 'errors.network';
      if (error.status === 422 || error.status === 404) return 'deadlines.problems.changed';
      if (error.status === 403) return 'errors.forbidden';
      return 'errors.generic';
  }
}

@Component({
  selector: 'app-deadlines-board-page',
  imports: [TranslocoDirective, RouterLink, ReactiveFormsModule, DatePipe, CanDirective, OrgUnitPicker, DisplayNamePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './deadlines-board.page.html',
  styleUrl: './deadlines.css',
})
export class DeadlinesBoardPage {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(DeadlinesApi);
  protected readonly badge = inject(DeadlinesBadge);
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));

  // Query params, bound by the router.
  readonly q = input<string>();
  readonly kind = input<string>();
  readonly status = input<string>();
  readonly unitId = input<string>();
  readonly includeSubUnits = input<string>();
  readonly within = input<string>();
  readonly page = input<string>();
  readonly pageSize = input<string>();

  protected readonly query = computed<DeadlineQuery>(() =>
    resolveBoardQuery({
      q: this.q(),
      kind: this.kind(),
      status: this.status(),
      unitId: this.unitId(),
      includeSubUnits: this.includeSubUnits(),
      within: this.within(),
      page: this.page(),
      pageSize: this.pageSize(),
    }),
  );

  protected readonly list = this.api.listResource(this.query);
  protected readonly items = computed<readonly DeadlineItem[]>(() => (this.list.hasValue() ? this.list.value().items : []));
  protected readonly groups = computed(() => groupItems(this.items()));
  protected readonly total = computed(() => (this.list.hasValue() ? this.list.value().total : 0));
  protected readonly pageCount = computed(() => Math.max(1, Math.ceil(this.total() / this.query().pageSize)));
  protected readonly filtered = computed(() => {
    const { q, kind, status, unitId, within } = this.query();
    const d = DEFAULT_DEADLINE_QUERY;
    return q.trim() !== '' || !!kind || status !== d.status || !!unitId || within !== d.within;
  });
  protected readonly errorKey = computed(() => {
    const error = this.list.error();
    if (isApiProblemError(error)) {
      if (error.problem.type === PROBLEM_TYPE_NETWORK) return 'errors.network';
      if (error.status === 403) return 'errors.forbidden';
    }
    return 'deadlines.loadError';
  });

  protected readonly canUnits = inject(Session).allows('org_unit.read');
  protected readonly kinds = DEADLINE_KINDS;
  protected readonly statuses = DEADLINE_STATUS_FILTERS;
  protected readonly withinOptions = DEADLINE_WITHIN_OPTIONS;
  protected readonly pageSizes = DEADLINE_PAGE_SIZES;
  protected readonly unitControl = new FormControl<string | null>(null);
  private readonly searches = new Subject<string>();

  /** The outcome of the last action, shown above the list. */
  protected readonly feedback = signal<{ readonly key: string; readonly kind: 'ok' | 'error' } | null>(null);
  /** Keys of the items an action is running on (their buttons are disabled meanwhile). */
  protected readonly busy = signal<ReadonlySet<string>>(new Set());

  constructor() {
    effect(() => {
      const unitId = this.query().unitId;
      if (this.unitControl.value !== unitId) this.unitControl.setValue(unitId, { emitEvent: false });
    });
    this.unitControl.valueChanges.pipe(takeUntilDestroyed()).subscribe((unitId) => this.update({ unitId }));
    this.searches
      .pipe(
        debounceTime(BOARD_SEARCH_DEBOUNCE_MS),
        filter((q) => q !== this.query().q),
        takeUntilDestroyed(),
      )
      .subscribe((q) => this.update({ q }, true));
    // The badge follows what the board shows: opening the board refreshes it.
    this.badge.refresh();
  }

  protected update(change: Partial<Pick<DeadlineQuery, BoardQueryKey>>, replaceUrl = false): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: toBoardQueryParams({ page: 1, ...change }),
      queryParamsHandling: 'merge',
      replaceUrl,
    });
  }

  protected onSearchInput(event: Event): void {
    this.searches.next(event.target instanceof HTMLInputElement ? event.target.value : '');
  }

  protected onField(key: 'kind' | 'status' | 'within' | 'pageSize', event: Event): void {
    const value = event.target instanceof HTMLSelectElement ? event.target.value : '';
    if (key === 'pageSize') this.update({ pageSize: Number(value) });
    else if (key === 'within') this.update({ within: Number(value) });
    else if (key === 'status') this.update({ status: resolveBoardQuery({ status: value }).status });
    else this.update({ kind: resolveBoardQuery({ kind: value }).kind });
  }

  protected onIncludeSubUnits(event: Event): void {
    this.update({ includeSubUnits: event.target instanceof HTMLInputElement && event.target.checked });
  }

  protected goToPage(page: number): void {
    this.update({ page: Math.min(Math.max(1, page), this.pageCount()) });
  }

  protected clearFilters(): void {
    const d = DEFAULT_DEADLINE_QUERY;
    this.update({ q: '', kind: null, status: d.status, unitId: null, includeSubUnits: true, within: d.within });
  }

  /** The employee tab where the item is dealt with: the document in the file, the contracts otherwise. */
  protected employeeTab(item: DeadlineItem): string | null {
    if (item.kind === 'document_expiry') return 'file';
    if (item.kind === 'retirement') return null;
    return 'contracts';
  }

  protected isBusy(item: DeadlineItem): boolean {
    return this.busy().has(item.key);
  }

  // --- Ack dialog -------------------------------------------------------------------------------------------------

  private readonly ackDialog = viewChild.required<ElementRef<HTMLDialogElement>>('ackDialog');
  protected readonly acking = signal<DeadlineItem | null>(null);
  protected readonly noteMax = ACK_NOTE_MAX;
  protected readonly ackForm = inject(NonNullableFormBuilder).group({ note: ['', [Validators.maxLength(ACK_NOTE_MAX)]] });

  protected openAck(item: DeadlineItem): void {
    this.acking.set(item);
    this.ackForm.reset({ note: '' });
    this.ackDialog().nativeElement.showModal();
  }

  protected closeAck(): void {
    this.ackDialog().nativeElement.close();
  }

  protected onAckClosed(): void {
    this.acking.set(null);
  }

  protected submitAck(): void {
    const item = this.acking();
    if (!item) return;
    if (this.ackForm.invalid) {
      this.ackForm.markAllAsTouched();
      return;
    }
    const note = this.ackForm.getRawValue().note.trim();
    this.closeAck();
    this.run(item, this.api.ack({ kind: item.kind, subjectId: ackSubjectId(item), dueDate: item.dueDate, ...(note ? { note } : {}) }), 'deadlines.feedback.handled');
  }

  protected unack(item: DeadlineItem): void {
    if (!item.ack) return;
    this.run(item, this.api.unack(item.ack.id), 'deadlines.feedback.reopened');
  }

  protected openDecision(item: DeadlineItem): void {
    if (!item.contract) return;
    this.run(item, this.api.openDecision(item.employee.id, item.contract.id), 'deadlines.feedback.decisionOpened');
  }

  private run(item: DeadlineItem, request$: Observable<unknown>, okKey: string): void {
    this.feedback.set(null);
    this.busy.update((keys) => new Set(keys).add(item.key));
    const done = () =>
      this.busy.update((keys) => {
        const next = new Set(keys);
        next.delete(item.key);
        return next;
      });
    request$.subscribe({
      next: () => {
        done();
        this.feedback.set({ key: okKey, kind: 'ok' });
        this.list.reload();
        this.badge.refresh();
      },
      error: (error: unknown) => {
        done();
        this.feedback.set({ key: actionErrorKey(error), kind: 'error' });
        this.list.reload();
      },
    });
  }
}
