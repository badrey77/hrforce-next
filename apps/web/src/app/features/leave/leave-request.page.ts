/**
 * /leave/requests/:id — one leave request for HR: the request, its approval steps and history (the shared
 * `<app-leave-request-view>`), and a link to the employee's page.
 *
 * Angular concepts: route param → `input.required()` → `httpResource` keyed on it (as the employee detail page);
 * a 404 reads "not found" without a retry — out-of-scope ids are 404 by design (ADR 002).
 */
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { isApiProblemError } from '../../core/http/api-problem';
import { LeaveApi } from '../../core/leave/leave-api';
import { CanDirective } from '../../shared/can/can.directive';
import { LeaveRequestView } from '../../shared/leave/leave-request-view';

@Component({
  selector: 'app-leave-request-page',
  imports: [TranslocoDirective, RouterLink, CanDirective, LeaveRequestView],
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
  readonly id = input.required<string>();
  protected readonly request = inject(LeaveApi).requestResource(this.id);
  protected readonly notFound = computed(() => {
    const error = this.request.error();
    return isApiProblemError(error) && error.status === 404;
  });
}
