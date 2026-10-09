import { DatePipe, DecimalPipe, DOCUMENT, NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, linkedSignal, output, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { isApiProblemError } from '../../core/http/api-problem';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { pickLabel } from '../../core/leave/leave-catalog';
import { RecruitmentApi } from '../../core/recruitment/recruitment-api';
import {
  ACTIVE_STAGES,
  type BoardCard,
  type BoardColumn,
  type BoardView,
  daysSince,
  FINAL_STAGES,
  isActiveStage,
  type Stage,
  STAGES,
} from '../../core/recruitment/recruitment.models';
import { DisplayNamePipe, displayNameOf } from '../../shared/display-name/display-name.pipe';
import { AddApplication, type AddedApplication } from './add-application';
import { InterviewDialog, type InterviewOutcome } from './interview-dialog';
import { OfferDialog, type OfferOutcome } from './offer-dialog';
import { loadErrorKey } from './recruitment-view';
import { ApplicationMove, type MenuExtra, type MoveFailure, type MoveOutcome, StageMenu } from './stage-move';

const MENU_EXTRAS: readonly MenuExtra[] = ['schedule_interview', 'make_offer'];

interface Feedback {
  readonly key: string;
  readonly params: Record<string, string>;
  readonly kind: 'ok' | 'warning';
  readonly candidateId?: string;
  readonly applicationId?: string;
}

/** The pipeline of one opening: a column per stage, cards moved with « Déplacer vers… » (and by drag on a desktop). */
@Component({
  selector: 'app-pipeline-board',
  imports: [TranslocoDirective, RouterLink, NgTemplateOutlet, DatePipe, DecimalPipe, DisplayNamePipe, StageMenu, ApplicationMove, AddApplication, InterviewDialog, OfferDialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './pipeline-board.html',
  styleUrl: './pipeline-board.css',
})
export class PipelineBoard {
  private readonly api = inject(RecruitmentApi);
  private readonly view = inject(DOCUMENT).defaultView;
  protected readonly lang = inject(LanguageService).current;

  readonly openingId = input.required<string>();
  readonly canAdd = input(false);
  /** Something changed that the opening's header shows too (counts, status). */
  readonly changed = output<void>();

  protected readonly showFinal = signal(false);
  protected readonly selected = signal<Stage>('received');
  protected readonly adding = signal(false);
  protected readonly feedback = signal<Feedback | null>(null);
  protected readonly board = this.api.boardResource(this.openingId, this.showFinal);
  protected readonly mover = viewChild.required(ApplicationMove);

  /**
   * The board on screen. Opening « Terminées » changes the request (`includeFinal`), which empties the resource while
   * it loads: the previous answer of the same opening stays visible meanwhile instead of a flash of "loading".
   */
  protected readonly data = linkedSignal<BoardView | undefined, BoardView | undefined>({
    source: () => (this.board.hasValue() ? this.board.value() : undefined),
    computation: (value, previous) => value ?? (previous?.value?.opening.id === this.openingId() ? previous.value : undefined),
  });

  private readonly columns = computed<readonly BoardColumn[]>(() => this.data()?.columns ?? []);
  protected readonly activeColumns = computed(() => this.columns().filter((column) => isActiveStage(column.stage)));
  protected readonly finalColumns = computed(() => this.columns().filter((column) => !isActiveStage(column.stage)));
  protected readonly finalCount = computed(() => this.finalColumns().reduce((sum, column) => sum + column.count, 0));
  protected readonly counts = computed(() => new Map(this.columns().map((column) => [column.stage, column.count])));
  protected readonly errorKey = computed(() => {
    const error = this.board.error();
    if (isApiProblemError(error) && error.problem.errors?.some((e) => e.code === 'too_many')) return 'recruitment.board.tooMany';
    return loadErrorKey(error, 'recruitment.board.loadError');
  });

  protected readonly stages = STAGES;
  protected readonly activeStages = ACTIVE_STAGES;
  protected readonly days = daysSince;

  reload(): void {
    this.board.reload();
  }

  protected selectStage(stage: Stage): void {
    this.selected.set(stage);
    if (FINAL_STAGES.includes(stage)) this.showFinal.set(true);
  }

  protected nameOf(card: BoardCard): string {
    return displayNameOf(card.candidate, this.lang());
  }

  protected reasonOf(card: BoardCard): string {
    return card.rejectionReason ? pickLabel(card.rejectionReason.labels, this.lang()) : '';
  }

  protected move(card: BoardCard, target: Stage): void {
    this.feedback.set(null);
    this.mover().move({ id: card.id, stage: card.stage, name: this.nameOf(card) }, target);
  }

  protected reopen(card: BoardCard): void {
    this.feedback.set(null);
    this.mover().reopen({ id: card.id, stage: card.stage, name: this.nameOf(card) });
  }

  protected onMoved(outcome: MoveOutcome): void {
    this.feedback.set({ key: `recruitment.move.done.${outcome.application.stage}`, params: { name: outcome.name }, kind: 'ok' });
    this.refresh();
  }

  protected onFailed(failure: MoveFailure): void {
    this.feedback.set({ key: failure.key, params: {}, kind: 'warning' });
    // Someone else moved the card (or the opening closed): show what is true now.
    if (failure.reload) this.refresh();
  }

  // --- Phase B entries of the move menu: they open their own dialog, then the board is reloaded like after a move ---

  protected readonly locale = computed(() => dateLocaleOf(this.lang()));
  private readonly interviewDialog = viewChild.required(InterviewDialog);
  private readonly offerDialog = viewChild.required(OfferDialog);

  protected extrasOf(card: BoardCard): readonly MenuExtra[] {
    // oxlint-disable-next-line no-underscore-dangle -- `_actions` is the contract's field name
    return MENU_EXTRAS.filter((extra) => card._actions.includes(extra));
  }

  protected openExtra(card: BoardCard, extra: MenuExtra): void {
    this.feedback.set(null);
    const name = this.nameOf(card);
    if (extra === 'schedule_interview') {
      this.interviewDialog().schedule({ applicationId: card.id, name });
      return;
    }
    const opening = this.data()?.opening;
    this.offerDialog().make({ applicationId: card.id, stage: card.stage, name, openingId: this.openingId(), ...(opening ? { opening } : {}) });
  }

  protected onInterview(outcome: InterviewOutcome): void {
    this.feedback.set({ key: `recruitment.interviews.done.${outcome.kind}`, params: { name: outcome.name }, kind: 'ok' });
    this.refresh();
  }

  protected onOffer(outcome: OfferOutcome): void {
    this.feedback.set({ key: `recruitment.offer.done.${outcome.kind}`, params: { name: outcome.name }, kind: 'ok' });
    this.refresh();
  }

  protected onAdded(added: AddedApplication): void {
    this.adding.set(false);
    this.feedback.set({
      key: added.uploadFailed ? 'recruitment.add.createdWithoutCv' : 'recruitment.add.created',
      params: { name: displayNameOf(added.application.candidate.person, this.lang()) },
      kind: added.uploadFailed ? 'warning' : 'ok',
      candidateId: added.application.candidate.id,
      applicationId: added.application.id,
    });
    this.refresh();
  }

  private refresh(): void {
    this.board.reload();
    this.changed.emit();
  }

  // --- Drag and drop: an extra for a desktop pointer; it calls the same move as the button. ---

  protected readonly canDrag = !!this.view?.matchMedia?.('(pointer: fine)').matches;
  private readonly dragged = signal<BoardCard | null>(null);
  protected readonly dropStage = signal<Stage | null>(null);

  protected onDragStart(event: DragEvent, card: BoardCard): void {
    this.dragged.set(card);
    event.dataTransfer?.setData('text/plain', card.id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  protected onDragEnd(): void {
    this.dragged.set(null);
    this.dropStage.set(null);
  }

  private accepts(stage: Stage): boolean {
    const card = this.dragged();
    return !!card && card.stage !== stage && card.moveTargets.includes(stage);
  }

  protected onDragOver(event: DragEvent, stage: Stage): void {
    if (!this.accepts(stage)) return;
    event.preventDefault(); // allow the drop
    this.dropStage.set(stage);
  }

  protected onDrop(event: DragEvent, stage: Stage): void {
    const card = this.dragged();
    this.onDragEnd();
    if (!card || card.stage === stage || !card.moveTargets.includes(stage)) return;
    event.preventDefault();
    this.move(card, stage);
  }
}
