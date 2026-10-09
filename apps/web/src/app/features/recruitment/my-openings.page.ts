import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { MyRecruitment } from '../../core/recruitment/my-recruitment';
import { RecruitmentApi } from '../../core/recruitment/recruitment-api';
import { ACTIVE_STAGES, type MyOpeningView } from '../../core/recruitment/recruitment.models';
import { DisplayNamePipe } from '../../shared/display-name/display-name.pipe';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';
import { WorkflowStepper } from '../../shared/workflow-stepper/workflow-stepper';
import { actionErrorKey, loadErrorKey, statusTone } from './recruitment-view';

/** « Mes recrutements »: the openings the caller requested or heads (no recruitment permission needed). */
@Component({
  selector: 'app-my-openings-page',
  imports: [TranslocoDirective, RouterLink, DatePipe, DisplayNamePipe, WorkflowStepper, RevealAlert],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './my-openings.page.html',
  styleUrl: './recruitment.css',
})
export class MyOpeningsPage {
  private readonly api = inject(RecruitmentApi);
  protected readonly mine = inject(MyRecruitment);
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));

  protected readonly list = this.api.myOpeningsResource();
  protected readonly items = computed<readonly MyOpeningView[]>(() => (this.list.hasValue() ? this.list.value().items : []));
  protected readonly errorKey = computed(() => loadErrorKey(this.list.error(), 'recruitment.mine.loadError'));
  /** Shown until the summary says otherwise: the API decides who may request anyway. */
  protected readonly canRequest = computed(() => this.mine.summary()?.canRequestOpening !== false);

  protected readonly activeStages = ACTIVE_STAGES;
  protected readonly tone = statusTone;
  protected readonly busy = signal<string | null>(null);
  protected readonly feedback = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);

  protected cancel(opening: MyOpeningView): void {
    this.feedback.set(null);
    this.actionError.set(null);
    this.busy.set(opening.id);
    this.api.cancelMyOpening(opening.id).subscribe({
      next: () => {
        this.busy.set(null);
        this.feedback.set('recruitment.mine.cancelled');
        this.list.reload();
        this.mine.reload();
      },
      error: (error: unknown) => {
        this.busy.set(null);
        this.actionError.set(actionErrorKey(error));
        // Not cancellable any more: it was approved or rejected meanwhile.
        this.list.reload();
      },
    });
  }
}
