import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { Session } from '../../core/auth/session';
import { MyRecruitment, RECRUITMENT_READ } from '../../core/recruitment/my-recruitment';
import { RecruitmentApi } from '../../core/recruitment/recruitment-api';
import { ACTIVE_STAGES } from '../../core/recruitment/recruitment.models';

@Component({
  selector: 'app-home-page',
  imports: [TranslocoDirective, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-container *transloco="let t">
      <h1>{{ t('home.title') }}</h1>
      <p>{{ t('home.intro') }}</p>

      <!-- Recruitment counts: scoped by the API to what the caller may read; each one opens the filtered list. -->
      @if (summary.hasValue()) {
        @let s = summary.value();
        <section class="panel" aria-labelledby="home-recruitment-title" data-card="recruitment">
          <h2 id="home-recruitment-title">{{ t('nav.recruitment') }}</h2>
          <ul class="counts">
            <li>
              <a routerLink="/recruitment" [queryParams]="{ status: 'pending' }" data-count="pending"><strong>{{ s.openings.pending }}</strong> {{ t('recruitment.status.pending') }}</a>
            </li>
            <li>
              <a routerLink="/recruitment" [queryParams]="{ status: 'open' }" data-count="open"><strong>{{ s.openings.open }}</strong> {{ t('recruitment.home.open') }}</a>
            </li>
            @for (stage of stages; track stage) {
              <li>
                <a routerLink="/recruitment/candidates" [queryParams]="{ stage: stage }" [attr.data-count]="stage"><strong>{{ s.applications[stage] }}</strong> {{ t('recruitment.home.stage.' + stage) }}</a>
              </li>
            }
            <li data-count="interviews-next"><strong>{{ s.interviewsNext7Days }}</strong> {{ t('recruitment.home.interviewsNext7Days') }}</li>
            <li>
              <a routerLink="/recruitment/candidates" [queryParams]="{ stage: 'offer' }" data-count="offers-pending"><strong>{{ s.offersPending }}</strong> {{ t('recruitment.home.offersPending') }}</a>
            </li>
          </ul>
        </section>
      }
      @if (mine.showNav()) {
        <p class="panel" data-card="my-recruitment">
          <a routerLink="/me/recruitment">{{ t('nav.myRecruitment') }}</a> —
          {{ t('recruitment.home.minePending', { count: pending() }) }}
        </p>
      }
      @if (mine.showInterviewsNav()) {
        <p class="panel" data-card="my-interviews">
          <a routerLink="/me/interviews">{{ t('recruitment.home.interviewsTodo', { count: mine.evaluationsTodo() }) }}</a>
        </p>
      }
    </ng-container>
  `,
  styles: `
    .counts { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-4); margin: 0; padding: 0; list-style: none; }
    .counts strong { font-size: 1.25rem; }
  `,
})
export class HomePage {
  private readonly session = inject(Session);
  protected readonly mine = inject(MyRecruitment);
  protected readonly summary = inject(RecruitmentApi).summaryResource(() => this.session.can(RECRUITMENT_READ));
  protected readonly pending = computed(() => this.mine.summary()?.pendingOpenings ?? 0);
  protected readonly stages = ACTIVE_STAGES;
}
