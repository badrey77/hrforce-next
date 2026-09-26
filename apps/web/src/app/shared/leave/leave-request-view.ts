/**
 * `<app-leave-request-view [request]="detail" />` — one leave request, read-only: employee, type, dates, days, status,
 * reason and document, the approval stepper, and the step history (who approved/rejected, when, with which comment).
 * Shown by the task panel (/tasks) and the HR request page (/leave/requests/:id).
 *
 * Angular concepts:
 * - **Composition of presentational components**: this view embeds `<app-workflow-stepper>` and passes it the
 *   request's `workflow` and `history`. Neither fetches anything; the page that owns the resource decides loading
 *   and error states. That is what lets the SAME view serve two pages with different data sources.
 * - **`DatePipe` for timestamps** (`actedAt | date: 'short' : undefined : locale()`) and dates (`'mediumDate'`) with
 *   the locale as an argument; ISO strings are accepted by the pipe as they are.
 * - **`@if (x; as y)`** narrows a nullable value and names it for the block (the workflow may be null for a request
 *   created before the engine existed).
 */
import { DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { LeaveCatalog } from '../../core/leave/leave-catalog';
import type { LeaveRequestDetail } from '../../core/leave/leave.models';
import { DisplayNamePipe } from '../display-name/display-name.pipe';
import { WorkflowStepper } from '../workflow-stepper/workflow-stepper';

@Component({
  selector: 'app-leave-request-view',
  imports: [TranslocoDirective, DatePipe, DecimalPipe, DisplayNamePipe, WorkflowStepper],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-container *transloco="let t">
      @let r = request();
      <dl class="facts" data-panel="request">
        <dt>{{ t('leave.fields.employee') }}</dt>
        <dd data-field="employee">{{ r.employee.person | displayName: lang() }} <span class="code">({{ r.employee.matricule }})</span></dd>
        <dt>{{ t('leave.fields.type') }}</dt>
        <dd data-field="type">{{ catalog.nameOf(r.leaveTypeId) }}</dd>
        <dt>{{ t('leave.fields.dates') }}</dt>
        <dd data-field="dates">
          {{ t('leave.fields.range', { from: (r.startDate | date: 'mediumDate' : undefined : locale()), to: (r.endDate | date: 'mediumDate' : undefined : locale()) }) }}
          @if (r.halfDayStart || r.halfDayEnd) {
            <span class="muted">({{ t('leave.fields.halfDaysNote') }})</span>
          }
        </dd>
        <dt>{{ t('leave.fields.days') }}</dt>
        <dd data-field="days">{{ r.days | number: '1.0-1' : locale() }}</dd>
        <dt>{{ t('leave.fields.status') }}</dt>
        <dd><span class="badge" [attr.data-status]="r.status" data-field="status">{{ t('leave.status.' + r.status) }}</span></dd>
        @if (r.reason) {
          <dt>{{ t('leave.fields.reason') }}</dt>
          <dd dir="auto">{{ r.reason }}</dd>
        }
        @if (r.documentRef) {
          <dt>{{ t('leave.fields.documentRef') }}</dt>
          <dd dir="auto">{{ r.documentRef }}</dd>
        }
        @if (r.requestedBy) {
          <dt>{{ t('leave.fields.requestedBy') }}</dt>
          <dd>{{ r.requestedBy.displayName }}, {{ r.requestedAt | date: 'short' : undefined : locale() }}</dd>
        }
      </dl>

      @if (r.workflow; as workflow) {
        <h4>{{ t('workflow.title') }}</h4>
        <app-workflow-stepper [progress]="workflow" [history]="r.history" />
      }

      @if (r.history.length) {
        <h4>{{ t('workflow.history.title') }}</h4>
        <div class="table-scroll">
          <table class="data" data-table="history">
            <thead>
              <tr>
                <th scope="col">{{ t('workflow.history.step') }}</th>
                <th scope="col">{{ t('workflow.history.outcome') }}</th>
                <th scope="col">{{ t('workflow.history.by') }}</th>
                <th scope="col">{{ t('workflow.history.at') }}</th>
                <th scope="col">{{ t('workflow.history.comment') }}</th>
              </tr>
            </thead>
            <tbody>
              @for (task of r.history; track task.id) {
                <tr>
                  <td>{{ stepName(task.stepIndex) }}</td>
                  <td>{{ t('workflow.outcome.' + (task.outcome ?? task.status)) }}</td>
                  <td>{{ task.actedBy?.displayName ?? '—' }}</td>
                  <td class="nowrap">{{ task.actedAt ? (task.actedAt | date: 'short' : undefined : locale()) : '—' }}</td>
                  <td dir="auto">{{ task.comment ?? '' }}</td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </ng-container>
  `,
  styles: `
    h4 { margin-block: var(--space-4) var(--space-2); font-size: 1rem; }
  `,
})
export class LeaveRequestView {
  protected readonly catalog = inject(LeaveCatalog);
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));

  readonly request = input.required<LeaveRequestDetail>();

  /** A history row's step name from the definition (the history carries only the index/key). */
  protected stepName(index: number): string {
    const step = this.request().workflow?.steps[index];
    return step ? this.catalog.labelOf(step.labels) : String(index + 1);
  }
}
