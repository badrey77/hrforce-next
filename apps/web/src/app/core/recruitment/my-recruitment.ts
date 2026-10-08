import { computed, Injectable, inject } from '@angular/core';
import { Session } from '../auth/session';
import { RecruitmentApi } from './recruitment-api';
import type { MySummaryView } from './recruitment.models';

export const RECRUITMENT_READ = 'recruitment.read';

/**
 * `GET /me/recruitment/summary`, fetched once per sign-in: it decides the « Mes recrutements » nav entry and the home
 * line of unit heads (who hold no recruitment permission). Call `reload()` after a request is created or cancelled.
 */
@Injectable({ providedIn: 'root' })
export class MyRecruitment {
  private readonly session = inject(Session);
  private readonly resource = inject(RecruitmentApi).mySummaryResource(() => this.session.isAuthenticated());

  readonly summary = computed<MySummaryView | undefined>(() => (this.resource.hasValue() ? this.resource.value() : undefined));
  /** The caller has something under « Mes recrutements » (may request, or already requested / heads an opening). */
  readonly relevant = computed(() => {
    const summary = this.summary();
    return !!summary && (summary.canRequestOpening || summary.openings > 0);
  });
  /** HR uses « Recrutement »: the personal entry is for everyone else. */
  readonly showNav = computed(() => this.relevant() && !this.session.can(RECRUITMENT_READ));

  reload(): void {
    if (this.session.isAuthenticated()) this.resource.reload();
  }
}
