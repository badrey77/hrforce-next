import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { BlobFiles } from '../../core/browser/blob-files';
import { downloadFileName, fileBadge } from '../../core/employee-files/employee-files.models';
import { LanguageService } from '../../core/i18n/language.service';
import { MyRecruitment } from '../../core/recruitment/my-recruitment';
import { RecruitmentApi } from '../../core/recruitment/recruitment-api';
import {
  type CandidateFileView,
  daysSince,
  type HeadApplicationView,
  type MyOpeningDetailView,
  type Stage,
  STAGES,
} from '../../core/recruitment/recruitment.models';
import { DisplayNamePipe } from '../../shared/display-name/display-name.pipe';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';
import { WorkflowStepper } from '../../shared/workflow-stepper/workflow-stepper';
import { OpeningFacts } from './opening-facts';
import { actionErrorKey, downloadErrorKey, isNotFound, loadErrorKey } from './recruitment-view';

export interface StageGroup {
  readonly stage: Stage;
  readonly applications: readonly HeadApplicationView[];
}

/** The head's applications by stage, in pipeline order; empty stages are left out. */
export function groupByStage(applications: readonly HeadApplicationView[]): StageGroup[] {
  return STAGES.map((stage) => ({ stage, applications: applications.filter((a) => a.stage === stage) })).filter((g) => g.applications.length > 0);
}

/**
 * The requester's / head's view of one opening: the request and its approval, and — for a head — who applied, at
 * which stage, with their files. Nothing here moves a candidate or shows identity details (contract › Scope).
 */
@Component({
  selector: 'app-my-opening-detail-page',
  imports: [TranslocoDirective, RouterLink, DisplayNamePipe, WorkflowStepper, OpeningFacts, RevealAlert],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [BlobFiles],
  templateUrl: './my-opening-detail.page.html',
  styleUrl: './recruitment.css',
})
export class MyOpeningDetailPage {
  private readonly api = inject(RecruitmentApi);
  private readonly blobs = inject(BlobFiles);
  private readonly mine = inject(MyRecruitment);
  protected readonly lang = inject(LanguageService).current;

  readonly id = input.required<string>();
  readonly created = input<string>();

  protected readonly opening = this.api.myOpeningResource(this.id);
  protected readonly notFound = computed(() => isNotFound(this.opening.error()));
  protected readonly errorKey = computed(() => loadErrorKey(this.opening.error(), 'recruitment.opening.loadError'));
  protected readonly groups = computed<readonly StageGroup[] | null>(() => {
    const applications = this.opening.hasValue() ? this.opening.value().applications : null;
    return applications ? groupByStage(applications) : null;
  });

  protected readonly days = daysSince;
  protected readonly badge = fileBadge;
  protected readonly busy = signal(false);
  protected readonly feedback = signal<string | null>(null);
  protected readonly actionError = signal<string | null>(null);
  protected readonly downloading = signal<string | null>(null);
  protected readonly fileError = signal<{ readonly id: string; readonly key: string } | null>(null);

  protected cancel(opening: MyOpeningDetailView): void {
    this.feedback.set(null);
    this.actionError.set(null);
    this.busy.set(true);
    this.api.cancelMyOpening(opening.id).subscribe({
      next: () => {
        this.busy.set(false);
        this.feedback.set('recruitment.mine.cancelled');
        this.opening.reload();
        this.mine.reload();
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.actionError.set(actionErrorKey(error));
        this.opening.reload();
      },
    });
  }

  protected download(application: HeadApplicationView, file: CandidateFileView): void {
    this.fileError.set(null);
    this.downloading.set(file.id);
    this.blobs.save(this.api.myFileContent(application.id, file.id), downloadFileName(file.originalFilename, file.mime)).subscribe({
      next: () => this.downloading.set(null),
      error: (error: unknown) => {
        this.downloading.set(null);
        this.fileError.set({ id: file.id, key: downloadErrorKey(error) });
        // 404: the application reached a final stage meanwhile, so its files are no longer the head's to read.
        if (isNotFound(error)) this.opening.reload();
      },
    });
  }
}
