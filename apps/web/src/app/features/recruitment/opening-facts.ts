import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { LeaveCatalog } from '../../core/leave/leave-catalog';
import type { WorkflowTaskHistory } from '../../core/leave/leave.models';
import type { CriterionRef, MyOpeningView, OpeningView } from '../../core/recruitment/recruitment.models';
import { DisplayNamePipe } from '../../shared/display-name/display-name.pipe';
import { statusTone } from './recruitment-view';

/** Every field of an opening and its approval history — the HR « Détails » tab and the requester / head view. */
@Component({
  selector: 'app-opening-facts',
  imports: [TranslocoDirective, DatePipe, DisplayNamePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-container *transloco="let t">
      @let o = opening();
      <dl class="facts" data-panel="opening">
        <dt>{{ t('recruitment.fields.reference') }}</dt>
        <dd data-field="reference"><span class="code" dir="ltr">{{ o.reference }}</span></dd>
        <dt>{{ t('recruitment.fields.title') }}</dt>
        <dd><bdi>{{ o.title }}</bdi></dd>
        <dt>{{ t('recruitment.fields.unit') }}</dt>
        <dd><bdi>{{ o.unit | displayName: lang() }}</bdi> <span class="code">({{ o.unit.code }})</span></dd>
        <dt>{{ t('recruitment.fields.site') }}</dt>
        <dd data-field="site">
          @if (o.site; as site) {
            <bdi>{{ site.name }}</bdi>
            @if (o.siteInherited) {
              <span class="muted"> — {{ t('recruitment.fields.siteOfUnit') }}</span>
            }
          } @else {
            —
          }
        </dd>
        <dt>{{ t('recruitment.fields.contractType') }}</dt>
        <dd>{{ t('recruitment.contractType.' + o.contractType) }}</dd>
        <dt>{{ t('recruitment.fields.posts') }}</dt>
        <dd data-field="posts">{{ t('recruitment.openings.hiredOf', { hired: o.hiredCount, posts: o.posts }) }}</dd>
        <dt>{{ t('recruitment.fields.targetDate') }}</dt>
        <dd>{{ o.targetDate | date: 'mediumDate' : undefined : locale() }}</dd>
        <dt>{{ t('recruitment.fields.status') }}</dt>
        <dd><span class="badge" [attr.data-status]="tone(o.status)">{{ t('recruitment.status.' + o.status) }}</span></dd>
        <dt>{{ t('recruitment.fields.justification') }}</dt>
        <dd class="prose" data-field="justification"><bdi>{{ o.justification }}</bdi></dd>
        <dt>{{ t('recruitment.fields.anemReference') }}</dt>
        <dd data-field="anem"><span dir="ltr">{{ o.anemReference ?? '—' }}</span></dd>
        <dt>{{ t('recruitment.fields.requestedBy') }}</dt>
        <dd>
          @if (o.requestedBy; as by) {
            <bdi>{{ by.displayName }}</bdi> —
          }
          {{ o.requestedAt | date: 'medium' : undefined : locale() }}
        </dd>
        @if (o.openedAt) {
          <dt>{{ t('recruitment.fields.openedAt') }}</dt>
          <dd>{{ o.openedAt | date: 'medium' : undefined : locale() }}</dd>
        }
        @if (o.closed; as closed) {
          <dt>{{ t(o.status === 'filled' ? 'recruitment.fields.filledAt' : 'recruitment.fields.closedAt') }}</dt>
          <dd data-field="closed">
            {{ closed.at | date: 'medium' : undefined : locale() }}
            @if (closed.by; as by) {
              — <bdi>{{ by.displayName }}</bdi>
            }
          </dd>
          @if (closed.reason) {
            <dt>{{ t('recruitment.fields.closeReason') }}</dt>
            <dd class="prose" data-field="close-reason"><bdi>{{ closed.reason }}</bdi></dd>
          }
        }
        @if (o.rejectionComment) {
          <dt>{{ t('recruitment.fields.rejectionComment') }}</dt>
          <dd class="prose" data-field="rejection-comment"><bdi>{{ o.rejectionComment }}</bdi></dd>
        }
      </dl>

      @if (o.criteria.length || canEditCriteria()) {
        <div class="toolbar">
          <h3 id="opening-criteria-title">{{ t('recruitment.criteria.title') }}</h3>
          @if (canEditCriteria()) {
            <button class="btn secondary" type="button" data-action="edit-criteria" (click)="editCriteria.emit()">{{ t('recruitment.criteria.edit') }}</button>
          }
        </div>
        <ol data-panel="criteria" aria-labelledby="opening-criteria-title">
          @for (criterion of o.criteria; track criterion.id) {
            <li><bdi>{{ criterionLabel(criterion) }}</bdi></li>
          }
        </ol>
      }

      @if (history().length) {
        <h3>{{ t('workflow.history.title') }}</h3>
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
              @for (task of history(); track task.id) {
                <tr>
                  <td>{{ stepName(task.stepIndex) }}</td>
                  <td>{{ t('workflow.outcome.' + (task.outcome ?? task.status)) }}</td>
                  <td><bdi>{{ task.actedBy?.displayName ?? '—' }}</bdi></td>
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
    .prose { white-space: pre-wrap; overflow-wrap: anywhere; }
  `,
})
export class OpeningFacts {
  private readonly catalog = inject(LeaveCatalog);
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));
  protected readonly tone = statusTone;

  readonly opening = input.required<OpeningView | MyOpeningView>();
  readonly history = input<readonly WorkflowTaskHistory[]>([]);
  /** « Modifier » next to the criteria (the opening's `set_criteria` action). */
  readonly canEditCriteria = input(false);
  readonly editCriteria = output<void>();

  protected criterionLabel(criterion: CriterionRef): string {
    return this.catalog.labelOf(criterion.labels);
  }

  protected stepName(index: number): string {
    const step = this.opening().workflow?.steps[index];
    return step ? this.catalog.labelOf(step.labels) : '';
  }
}
