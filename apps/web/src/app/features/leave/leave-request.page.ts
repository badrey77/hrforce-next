/**
 * /leave/requests/:id — one leave request for HR: the request, its approval steps and history (the shared
 * `<app-leave-request-view>`), a link to the employee's page, and its **History** (the audit timeline of
 * `leave_request:<id>`: the request's row changes, its workflow tasks and the `workflow.*` events; notifications
 * contract › Audit gap). The History needs NO `audit.read`: the API shows a leave_request timeline to whoever may read
 * the request itself (leave.read over the unit, the requester, a candidate — contract › Settled), which is anyone who
 * got this far (e.g. `rh_regional`, which has no `audit.read`).
 *
 * Angular concepts: route param → `input.required()` → `httpResource` keyed on it (as the employee detail page);
 * a 404 reads "not found" without a retry — out-of-scope ids are 404 by design (ADR 002).
 * History: `@defer (on viewport; prefetch on idle)` keeps
 * the timeline's code out of this page's chunk until the section scrolls into view (chapter 13). The `resolver`
 * names what the page already knows: leave types (LeaveCatalog), the request's workflow step keys (its definition's
 * labels), and the employee's unit. It reads signals, so names appear as soon as that data arrives.
 */
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { isApiProblemError } from '../../core/http/api-problem';
import { LanguageService } from '../../core/i18n/language.service';
import { LeaveApi } from '../../core/leave/leave-api';
import { LeaveCatalog } from '../../core/leave/leave-catalog';
import { CanDirective } from '../../shared/can/can.directive';
import { displayNameOf } from '../../shared/display-name/display-name.pipe';
import { LeaveRequestView } from '../../shared/leave/leave-request-view';
import { Timeline } from '../../shared/timeline/timeline';
import type { AuditNameResolver } from '../../shared/timeline/timeline-view';

@Component({
  selector: 'app-leave-request-page',
  imports: [TranslocoDirective, RouterLink, CanDirective, LeaveRequestView, Timeline],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-container *transloco="let t">
      <p><a routerLink="/leave">{{ t('leave.detail.back') }}</a></p>
      @if (request.hasValue()) {
        @let r = request.value();
        <header class="page-header">
          <h1>{{ t('leave.detail.title') }}</h1>
          <a *appCan="'employee.read'" class="btn secondary" [routerLink]="['/employees', r.employee.id]" data-action="employee">
            {{ t('leave.detail.employee') }}
          </a>
        </header>
        <app-leave-request-view [request]="r" />

        <section class="panel" aria-labelledby="leave-history-title" data-section="history">
          <h2 id="leave-history-title">{{ t('leave.detail.history') }}</h2>
          @defer (on viewport; prefetch on idle) {
            <app-timeline [subject]="'leave_request:' + r.id" [resolver]="auditNames" />
          } @placeholder {
            <p class="muted" data-defer="placeholder">{{ t('audit.loading') }}</p>
          } @loading (after 100ms; minimum 300ms) {
            <p class="muted">{{ t('audit.loading') }}</p>
          } @error {
            <p class="form-error" role="alert">{{ t('audit.chunkError') }}</p>
          }
        </section>
      } @else if (request.error()) {
        <div class="form-error" role="alert">
          <p>{{ t(notFound() ? 'leave.detail.notFound' : 'leave.detail.loadError') }}</p>
          @if (!notFound()) {
            <button class="btn secondary" type="button" (click)="request.reload()">{{ t('common.retry') }}</button>
          }
        </div>
      } @else {
        <p class="muted">{{ t('common.loading') }}</p>
      }
    </ng-container>
  `,
})
export class LeaveRequestPage {
  private readonly catalog = inject(LeaveCatalog);
  private readonly lang = inject(LanguageService).current;

  readonly id = input.required<string>();
  protected readonly request = inject(LeaveApi).requestResource(this.id);
  protected readonly notFound = computed(() => {
    const error = this.request.error();
    return isApiProblemError(error) && error.status === 404;
  });

  /** Names for the History (see header). A class field: a stable function, called inside the timeline's computed. */
  protected readonly auditNames: AuditNameResolver = (kind, value) => {
    if (kind === 'leaveType') return this.catalog.type(value) ? this.catalog.nameOf(value) : undefined;
    const r = this.request.hasValue() ? this.request.value() : undefined;
    if (!r) return undefined;
    if (kind === 'step') {
      const step = r.workflow?.steps.find((s) => s.key === value);
      return step ? this.catalog.labelOf(step.labels) : undefined;
    }
    if (kind === 'unit' && r.employee.unit?.id === value) return displayNameOf(r.employee.unit, this.lang());
    return undefined;
  };
}
