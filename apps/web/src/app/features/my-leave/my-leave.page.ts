/**
 * /me/leave — self-service leave (docs/contracts/leave.md › Web › My leave): balance cards per type and reference
 * year, a request form with a live preview, and "My requests" with each request's approval progress and a Cancel.
 *
 * Needs `leave.request_self` (route guard) AND a linked employment (`GET /api/me/employment`, the root
 * `MyEmployment` service). Without the link the page explains it instead of showing an unusable form.
 *
 * Angular concepts:
 * - **Resources gated on another resource.** The balances and requests resources read `myEmployment.linked()`: while
 *   the link is unknown or absent they send nothing (their request function returns `undefined`/`null`), and they
 *   fire as soon as `/me/employment` answers 200. No `ngOnInit`, no chained subscriptions: dependencies between
 *   requests are just signal reads.
 * - **Refresh after a write, again by `reload()`**: a new request changes the pending days (balances) and the list,
 *   so both resources reload; the new request's approver will see it in their tasks on their next navigation.
 * - **A child's output drives page state**: `(notLinked)` from the form (a 409 `leave-not-linked`, e.g. HR unlinked
 *   the account meanwhile) flips a local signal and re-asks `/me/employment`.
 * - **Native `<dialog>` + `viewChild.required()`** to confirm a cancellation (pattern of the Access user page).
 */
import { DatePipe, DecimalPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  type ElementRef,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';
import { todayIso } from '../../core/date/iso-date';
import { isApiProblemError } from '../../core/http/api-problem';
import { problemSlug } from '../../core/http/problem-form';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { LeaveApi } from '../../core/leave/leave-api';
import { LeaveCatalog } from '../../core/leave/leave-catalog';
import type { LeaveRequestSummary } from '../../core/leave/leave.models';
import { MyEmployment } from '../../core/leave/my-employment';
import { DisplayNamePipe } from '../../shared/display-name/display-name.pipe';
import { BalanceCards } from '../../shared/leave/balance-cards';
import { canCancel } from '../../shared/leave/leave-forms';
import { LeaveRequestForm } from '../../shared/leave/leave-request-form';
import { WorkflowStepper } from '../../shared/workflow-stepper/workflow-stepper';

@Component({
  selector: 'app-my-leave-page',
  imports: [TranslocoDirective, DatePipe, DecimalPipe, DisplayNamePipe, BalanceCards, LeaveRequestForm, WorkflowStepper],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './my-leave.page.html',
  styles: `
    .requests { display: grid; gap: var(--space-3); margin: 0; padding: 0; list-style: none; }
    .requests > li { padding: var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius); }
    .head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: var(--space-2); margin-block-end: var(--space-2); }
    .head p { margin: 0; }
  `,
})
export class MyLeavePage {
  private readonly api = inject(LeaveApi);
  protected readonly me = inject(MyEmployment);
  protected readonly catalog = inject(LeaveCatalog);
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));
  protected readonly today = todayIso();

  /** A submit answered `leave-not-linked` (the link disappeared since the page loaded). */
  protected readonly lostLink = signal(false);
  protected readonly linked = computed(() => this.me.linked() === true && !this.lostLink());

  protected readonly balances = this.api.myBalancesResource(() => this.linked());
  protected readonly requests = this.api.myRequestsResource(() => this.linked());
  protected readonly balanceItems = computed(() => (this.balances.hasValue() ? this.balances.value().items : []));
  protected readonly requestItems = computed<readonly LeaveRequestSummary[]>(() =>
    this.requests.hasValue() ? this.requests.value().items : [],
  );

  protected readonly feedback = signal<string | null>(null);
  protected readonly canCancel = canCancel;

  protected onSaved(): void {
    this.feedback.set('leave.feedback.requested');
    this.balances.reload();
    this.requests.reload();
  }

  protected onNotLinked(): void {
    this.lostLink.set(true);
    this.me.reload();
  }

  // --- Cancel dialog --------------------------------------------------------------------------------------------

  private readonly cancelDialog = viewChild.required<ElementRef<HTMLDialogElement>>('cancelDialog');
  protected readonly cancelling = signal<LeaveRequestSummary | null>(null);
  protected readonly cancelSubmitting = signal(false);
  protected readonly cancelError = signal<string | null>(null);

  protected openCancel(request: LeaveRequestSummary): void {
    this.feedback.set(null);
    this.cancelError.set(null);
    this.cancelling.set(request);
    this.cancelDialog().nativeElement.showModal();
  }

  protected closeCancel(): void {
    this.cancelDialog().nativeElement.close();
  }

  protected onCancelClosed(): void {
    this.cancelling.set(null);
    this.cancelSubmitting.set(false);
  }

  protected confirmCancel(): void {
    const request = this.cancelling();
    if (!request) return;
    this.cancelSubmitting.set(true);
    this.api.cancelMine(request.id).subscribe({
      next: () => {
        this.closeCancel();
        this.feedback.set('leave.feedback.cancelled');
        this.balances.reload();
        this.requests.reload();
      },
      error: (error: unknown) => {
        this.cancelSubmitting.set(false);
        const slug = isApiProblemError(error) ? problemSlug(error.problem.type) : undefined;
        this.cancelError.set(isApiProblemError(error) && error.status === 409 && slug !== undefined ? 'leave.problems.cannotCancel' : 'errors.generic');
      },
    });
  }
}
