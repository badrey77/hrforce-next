import { DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, output, viewChild } from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { pickLabel } from '../../core/leave/leave-catalog';
import { RecruitmentApi } from '../../core/recruitment/recruitment-api';
import type { ApplicationDetailView, InterviewState, InterviewView } from '../../core/recruitment/recruitment.models';
import { InterviewDialog, type InterviewOutcome } from './interview-dialog';
import type { MoveFailure } from './stage-move';

export function interviewTone(state: InterviewState): 'pending' | 'approved' | 'cancelled' {
  if (state === 'complete') return 'approved';
  return state === 'cancelled' ? 'cancelled' : 'pending';
}

/** The interviews of one application with their evaluations; schedule, change and cancel where `_actions` allow. */
@Component({
  selector: 'app-application-interviews',
  imports: [TranslocoDirective, DatePipe, DecimalPipe, InterviewDialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './application-interviews.html',
  styleUrl: './recruitment.css',
})
export class ApplicationInterviews {
  private readonly api = inject(RecruitmentApi);
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));

  readonly application = input.required<ApplicationDetailView>();
  readonly name = input.required<string>();
  readonly saved = output<InterviewOutcome>();
  readonly failed = output<MoveFailure>();

  protected readonly dialog = viewChild.required(InterviewDialog);
  protected readonly tone = interviewTone;

  // Scores name their criterion by id: the labels come from the company list, asked for once a score exists.
  private readonly hasScores = computed(() => this.application().interviews.some((i) => i.evaluations.some((e) => e.scores.length > 0)));
  private readonly criteria = this.api.criteriaResource(this.hasScores);
  private readonly labels = computed(() => new Map((this.criteria.hasValue() ? this.criteria.value().items : []).map((c) => [c.id, c.labels])));

  protected criterionLabel(id: string): string {
    const labels = this.labels().get(id);
    return labels ? pickLabel(labels, this.lang()) : '…';
  }

  protected schedule(): void {
    this.dialog().schedule({ applicationId: this.application().id, name: this.name() });
  }

  protected edit(interview: InterviewView): void {
    this.dialog().edit(interview, this.name());
  }

  protected cancel(interview: InterviewView): void {
    this.dialog().cancel(interview, this.name());
  }
}
