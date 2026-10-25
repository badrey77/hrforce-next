/**
 * `<app-profile-change-panel [subject]="task.subject" />` — the body of a profile change task in « Mes tâches »
 * (docs/contracts/profile-changes.md › Self-service requests): the employee, the section, and — read from
 * `GET /profile/requests/:id` (task candidates may read it) — the section's values before → after per changed field,
 * the « modifié depuis la demande » warning, the employee's comment and the supporting files. The RIB of a bank
 * request comes masked from the API unless the approver holds `employee.bank.read`. Approve / Reject stay the page's.
 */
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';
import { isApiProblemError, PROBLEM_TYPE_NETWORK } from '../../core/http/api-problem';
import { problemSlug } from '../../core/http/problem-form';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { ProfileApi } from '../../core/profile/profile-api';
import type { ProfileChangeTaskSubject } from '../../core/tasks/tasks.models';
import { DisplayNamePipe } from '../../shared/display-name/display-name.pipe';
import { ProfileRequestDiff } from '../../shared/profile/profile-request-diff';

/**
 * Approving a profile change APPLIES it through the Employment use cases in the same transaction: their refusals fail
 * the approval. `undefined` = not specific to profile changes (the page's general mapping applies).
 */
export function profileApprovalErrorKey(error: unknown): string | undefined {
  if (!isApiProblemError(error)) return undefined;
  const slug = problemSlug(error.problem.type);
  if (slug === 'employment-ended') return 'personal.problems.employmentEnded';
  if (slug === 'validation-error' || error.status === 422) return 'personal.problems.applyFailed';
  return undefined;
}

@Component({
  selector: 'app-profile-change-panel',
  imports: [TranslocoDirective, DatePipe, DisplayNamePipe, ProfileRequestDiff],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-container *transloco="let t">
      @let s = subject();
      <dl class="facts" data-panel="profile-change">
        <dt>{{ t('documents.fields.employee') }}</dt>
        <dd data-field="employee"><bdi>{{ s.employee.person | displayName: lang() }}</bdi> <span class="code" dir="ltr">({{ s.employee.matricule }})</span></dd>
        @if (s.employee.unit; as unit) {
          <dt>{{ t('documents.fields.unit') }}</dt>
          <dd><bdi>{{ unit | displayName: lang() }}</bdi></dd>
        }
        <dt>{{ t('personal.requests.columns.section') }}</dt>
        <dd data-field="section">{{ t('personal.sections.' + s.section) }}</dd>
        @if (detail(); as r) {
          <dt>{{ t('personal.diff.requestedAt') }}</dt>
          <dd data-field="requestedAt">{{ r.requestedAt | date: 'medium' : undefined : locale() }}</dd>
        }
      </dl>
      @if (request.error()) {
        <div class="form-error" role="alert">
          <p>{{ t(errorKey()) }}</p>
          <button class="btn secondary" type="button" data-action="retry-request" (click)="request.reload()">{{ t('common.retry') }}</button>
        </div>
      } @else if (detail(); as r) {
        <app-profile-request-diff [request]="r" />
      } @else {
        <p class="muted">{{ t('common.loading') }}</p>
      }
      <p class="field-hint" data-field="approve-hint">{{ t(hintKey()) }}</p>
    </ng-container>
  `,
})
export class ProfileChangePanel {
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));

  readonly subject = input.required<ProfileChangeTaskSubject>();

  /** Keyed on the id string: a refresh of the task list (new subject objects) does not read the request again. */
  private readonly requestId = computed(() => this.subject().id);
  protected readonly request = inject(ProfileApi).requestResource(this.requestId);
  /** The loaded request, only while it is the one of the current subject. */
  protected readonly detail = computed(() => {
    const value = this.request.hasValue() ? this.request.value() : undefined;
    return value?.id === this.requestId() ? value : undefined;
  });
  protected readonly errorKey = computed(() => {
    const error = this.request.error();
    return isApiProblemError(error) && error.problem.type === PROBLEM_TYPE_NETWORK ? 'errors.network' : 'personal.requests.detailError';
  });
  protected readonly hintKey = computed(() => {
    const section = this.subject().section;
    if (section === 'identity_note') return 'personal.task.approveHintNote';
    if (section === 'bank') return 'personal.task.approveHintBank';
    return 'personal.task.approveHint';
  });
}
