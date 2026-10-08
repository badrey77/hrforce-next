import { DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { BlobFiles } from '../../core/browser/blob-files';
import { downloadFileName, fileBadge } from '../../core/employee-files/employee-files.models';
import type { FormMessage } from '../../core/http/problem-form';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { pickLabel } from '../../core/leave/leave-catalog';
import type { Labels } from '../../core/leave/leave.models';
import { MyRecruitment } from '../../core/recruitment/my-recruitment';
import { RecruitmentApi } from '../../core/recruitment/recruitment-api';
import {
  type CandidateFileView,
  completeScores,
  EVALUATION_COMMENT_MAX,
  type MyInterviewView,
  type Recommendation,
  RECOMMENDATIONS,
  SCORES,
} from '../../core/recruitment/recruitment.models';
import { ControlError } from '../../shared/attendance/control-error';
import { DisplayNamePipe } from '../../shared/display-name/display-name.pipe';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';
import { ERROR_KEYS, recruitmentProblemToForm, text } from './recruitment-forms';
import { downloadErrorKey, isNotFound, loadErrorKey, slugOf } from './recruitment-view';

/** Answers that close the form for good: what is on screen is out of date. */
const CLOSED_SLUGS: ReadonlySet<string> = new Set(['recruitment-evaluation-closed', 'recruitment-interview-not-held']);

function canEvaluate(view: MyInterviewView): boolean {
  // oxlint-disable-next-line no-underscore-dangle -- `_actions` is the contract's field name
  return view._actions.includes('evaluate');
}

/**
 * One interview as its interviewer sees it: when and where, the candidate's name and files, and the evaluation form.
 * Nothing else about the candidate is shown here, and nothing of the other interviewers' evaluations.
 */
@Component({
  selector: 'app-my-interview-page',
  imports: [TranslocoDirective, ReactiveFormsModule, RouterLink, DatePipe, DecimalPipe, DisplayNamePipe, ControlError, RevealAlert],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [BlobFiles],
  templateUrl: './my-interview.page.html',
  styleUrls: ['./recruitment.css', './my-interview.page.css'],
})
export class MyInterviewPage {
  private readonly api = inject(RecruitmentApi);
  private readonly blobs = inject(BlobFiles);
  private readonly mine = inject(MyRecruitment);
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));

  readonly id = input.required<string>();

  protected readonly interview = this.api.myInterviewResource(this.id);
  protected readonly notFound = computed(() => isNotFound(this.interview.error()));
  protected readonly errorKey = computed(() => loadErrorKey(this.interview.error(), 'recruitment.myInterviews.loadError'));

  protected readonly scoreValues = SCORES;
  protected readonly recommendations = RECOMMENDATIONS;
  protected readonly errorKeys = ERROR_KEYS;
  protected readonly badge = fileBadge;

  /** Criterion id → the score chosen (null until one is). Radios, so a plain signal rather than form controls. */
  protected readonly scores = signal<Readonly<Record<string, number | null>>>({});
  protected readonly scoresMissing = signal(false);
  protected readonly form = this.fb.group({
    recommendation: this.fb.control<Recommendation | ''>('', Validators.required),
    comment: ['', text(1, EVALUATION_COMMENT_MAX, false)],
  });
  protected readonly saving = signal(false);
  protected readonly saved = signal(false);
  protected readonly formError = signal<FormMessage | null>(null);
  protected readonly downloading = signal<string | null>(null);
  protected readonly fileError = signal<{ readonly id: string; readonly key: string } | null>(null);

  /** Why the form is read-only: the interview has not taken place yet, or evaluations are closed. */
  protected readonly lockedKey = computed(() => {
    if (!this.interview.hasValue()) return null;
    const view = this.interview.value();
    if (canEvaluate(view)) return null;
    return Date.parse(view.scheduledAt) > Date.now() ? 'recruitment.evaluation.notYet' : 'recruitment.evaluation.closed';
  });

  constructor() {
    // The stored evaluation fills the form each time the interview is (re)loaded, never while the user is typing.
    effect(() => {
      if (!this.interview.hasValue()) return;
      const view = this.interview.value();
      const { evaluation } = view;
      const stored = new Map(evaluation.scores.map((s) => [s.criterionId, s.score]));
      this.scores.set(Object.fromEntries(view.criteria.map((c) => [c.id, stored.get(c.id) ?? null])));
      this.scoresMissing.set(false);
      this.form.reset({ recommendation: evaluation.recommendation ?? '', comment: evaluation.comment ?? '' });
      if (canEvaluate(view)) this.form.enable();
      else this.form.disable();
    });
  }

  protected label(labels: Labels): string {
    return pickLabel(labels, this.lang());
  }

  protected setScore(criterionId: string, score: number): void {
    this.scores.update((all) => ({ ...all, [criterionId]: score }));
    this.saved.set(false);
  }

  protected submit(view: MyInterviewView): void {
    this.formError.set(null);
    this.saved.set(false);
    const scores = completeScores(view.criteria, this.scores());
    const { recommendation, comment } = this.form.controls;
    this.scoresMissing.set(scores === null);
    if (scores === null || this.form.invalid) {
      this.form.markAllAsTouched();
      this.formError.set({ key: 'recruitment.evaluation.incomplete' });
      return;
    }
    const note = comment.value.trim();
    this.saving.set(true);
    this.api.submitEvaluation(view.id, { scores, recommendation: recommendation.value as Recommendation, ...(note ? { comment: note } : {}) }).subscribe({
      next: () => {
        this.saving.set(false);
        this.saved.set(true);
        this.interview.reload();
        this.mine.reload(); // the « à évaluer » count of the nav
      },
      error: (error: unknown) => {
        this.saving.set(false);
        this.formError.set(recruitmentProblemToForm(this.form, error, {}, 'recruitment.myInterviews.gone'));
        const slug = slugOf(error);
        if ((slug !== undefined && CLOSED_SLUGS.has(slug)) || isNotFound(error)) this.interview.reload();
      },
    });
  }

  protected download(view: MyInterviewView, file: CandidateFileView): void {
    this.fileError.set(null);
    this.downloading.set(file.id);
    this.blobs.save(this.api.myFileContent(view.applicationId, file.id), downloadFileName(file.originalFilename, file.mime)).subscribe({
      next: () => this.downloading.set(null),
      error: (error: unknown) => {
        this.downloading.set(null);
        this.fileError.set({ id: file.id, key: downloadErrorKey(error) });
        if (isNotFound(error)) this.interview.reload();
      },
    });
  }
}
