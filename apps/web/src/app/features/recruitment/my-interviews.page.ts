import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { RecruitmentApi } from '../../core/recruitment/recruitment-api';
import { MY_INTERVIEW_FILTERS, type MyInterviewFilter } from '../../core/recruitment/recruitment.models';
import { DisplayNamePipe } from '../../shared/display-name/display-name.pipe';
import { loadErrorKey } from './recruitment-view';

/** « Mes entretiens »: the interviews the caller must evaluate, and those already evaluated. No permission needed. */
@Component({
  selector: 'app-my-interviews-page',
  imports: [TranslocoDirective, RouterLink, DatePipe, DisplayNamePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './recruitment.css',
  template: `
    <ng-container *transloco="let t">
      <header class="page-header">
        <h1>{{ t('recruitment.myInterviews.title') }}</h1>
      </header>
      <div class="tabs" role="tablist" [attr.aria-label]="t('recruitment.myInterviews.title')">
        @for (name of filters; track name) {
          <button type="button" role="tab" [id]="'my-interviews-tab-' + name" [attr.data-tab]="name" [attr.aria-selected]="active() === name" aria-controls="my-interviews-panel" (click)="select(name)">
            {{ t('recruitment.myInterviews.filter.' + name) }}
          </button>
        }
      </div>
      <div id="my-interviews-panel" role="tabpanel" [attr.aria-labelledby]="'my-interviews-tab-' + active()">
        @if (list.hasValue()) {
          <ul class="card-list" data-panel="my-interviews">
            @for (i of list.value().items; track i.id) {
              <li [attr.data-interview]="i.id">
                <p class="inline-actions">
                  <a [routerLink]="['/me/interviews', i.id]">
                    <strong>{{ i.date | date: 'fullDate' : undefined : locale() }}, <span dir="ltr">{{ i.time }}</span></strong>
                  </a>
                  @if (i.evaluation.submittedAt) {
                    <span class="badge" data-status="approved" data-state="submitted">{{ t('recruitment.myInterviews.submitted') }}</span>
                  } @else {
                    <span class="badge" data-status="pending" data-state="todo">{{ t('recruitment.myInterviews.todo') }}</span>
                  }
                </p>
                <p>
                  <strong><bdi>{{ i.candidate | displayName: lang() }}</bdi></strong>
                  — <bdi>{{ i.opening.title }}</bdi>&ngsp;<span class="code muted nowrap" dir="ltr">{{ i.opening.reference }}</span>
                </p>
                <p class="muted">
                  @if (i.label) {
                    <bdi>{{ i.label }}</bdi> ·
                  }
                  {{ t('recruitment.interviews.modes.' + i.mode) }} · {{ t('recruitment.interviews.minutes', { count: i.durationMinutes }) }}
                  @if (i.location) {
                    · <bdi>{{ i.location }}</bdi>
                  }
                </p>
              </li>
            } @empty {
              <li class="muted" data-state="no-interviews">{{ t('recruitment.myInterviews.empty.' + active()) }}</li>
            }
          </ul>
        } @else if (list.error()) {
          <div class="form-error" role="alert">
            <p>{{ t(errorKey()) }}</p>
            <button class="btn secondary" type="button" (click)="list.reload()">{{ t('common.retry') }}</button>
          </div>
        } @else {
          <p class="muted">{{ t('common.loading') }}</p>
        }
      </div>
    </ng-container>
  `,
})
export class MyInterviewsPage {
  private readonly router = inject(Router);
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));

  /** `?filter=done`: the evaluated ones; anything else is « À évaluer ». */
  readonly filter = input<string>();
  protected readonly filters = MY_INTERVIEW_FILTERS;
  protected readonly active = computed<MyInterviewFilter>(() => (this.filter() === 'done' ? 'done' : 'todo'));
  protected readonly list = inject(RecruitmentApi).myInterviewsResource(this.active);
  protected readonly errorKey = computed(() => loadErrorKey(this.list.error(), 'recruitment.myInterviews.loadError'));

  protected select(filter: MyInterviewFilter): void {
    void this.router.navigate([], { queryParams: { filter: filter === 'todo' ? null : filter }, queryParamsHandling: 'merge' });
  }
}
