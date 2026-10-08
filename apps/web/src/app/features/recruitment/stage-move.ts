import { ChangeDetectionStrategy, Component, computed, type ElementRef, inject, input, output, signal, viewChild } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import type { Observable } from 'rxjs';
import type { FormMessage } from '../../core/http/problem-form';
import { LanguageService } from '../../core/i18n/language.service';
import { pickLabel } from '../../core/leave/leave-catalog';
import { RecruitmentApi } from '../../core/recruitment/recruitment-api';
import { type ApplicationDetailView, COMMENT_MAX, type ReasonView, type Stage } from '../../core/recruitment/recruitment.models';
import { ControlError } from '../../shared/attendance/control-error';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';
import { ERROR_KEYS, recruitmentProblemToForm, text } from './recruitment-forms';
import { actionErrorKey, slugOf } from './recruitment-view';

/** What a move needs to know about the application the user is looking at. */
export interface MoveSubject {
  readonly id: string;
  /** The stage on screen: sent as `expectedStage`, so a concurrent change answers 409 instead of being overwritten. */
  readonly stage: Stage;
  readonly name: string;
}

export interface MoveOutcome {
  readonly application: ApplicationDetailView;
  readonly name: string;
}

/** A failed move. `reload`: what is on screen is out of date (someone else moved the card, the opening closed…). */
export interface MoveFailure {
  readonly key: string;
  readonly reload: boolean;
}

const STALE_SLUGS: ReadonlySet<string> = new Set(['recruitment-stage-changed', 'recruitment-opening-not-open']);

export function moveFailure(error: unknown): MoveFailure {
  const slug = slugOf(error);
  return { key: actionErrorKey(error), reload: slug !== undefined && STALE_SLUGS.has(slug) };
}

/**
 * « Déplacer vers… »: a button that discloses the stages the API accepts now. A plain disclosure (button +
 * list of buttons) so it works the same with a keyboard, a mouse and a finger; Escape or leaving it closes it.
 */
@Component({
  selector: 'app-stage-menu',
  imports: [TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(focusout)': 'onFocusOut($event)', '(keydown.escape)': 'close($event)' },
  template: `
    <ng-container *transloco="let t">
      @if (targets().length) {
        <button #toggle type="button" class="btn secondary" data-action="move" [disabled]="disabled()" [attr.aria-expanded]="open()"
          [attr.aria-label]="t('recruitment.move.toFor', { name: name() })" (click)="open.set(!open())">
          {{ t('recruitment.move.to') }}
        </button>
        @if (open()) {
          <ul class="targets" [attr.aria-label]="t('recruitment.move.toFor', { name: name() })">
            @for (target of targets(); track target) {
              <li><button type="button" [attr.data-target]="target" (click)="choose(target)">{{ t('recruitment.stage.' + target) }}</button></li>
            }
          </ul>
        }
      } @else if (canReopen()) {
        <button type="button" class="btn secondary" data-action="reopen-application" [disabled]="disabled()"
          [attr.aria-label]="t('recruitment.move.reopenFor', { name: name() })" (click)="reopen.emit()">
          {{ t('recruitment.move.reopen') }}
        </button>
      }
    </ng-container>
  `,
  styles: `
    :host { display: block; }
    .targets { display: grid; gap: var(--space-1); margin: var(--space-2) 0 0; padding: 0; list-style: none; }
    .targets button {
      inline-size: 100%;
      padding-block: var(--space-2);
      padding-inline: var(--space-3);
      border: 1px solid var(--color-border);
      border-radius: var(--radius);
      background: var(--color-surface);
      color: inherit;
      font: inherit;
      text-align: start;
      cursor: pointer;
    }
    .targets button:hover { background: var(--color-hover); }
  `,
})
export class StageMenu {
  readonly targets = input.required<readonly Stage[]>();
  readonly canReopen = input(false);
  readonly name = input.required<string>();
  readonly disabled = input(false);
  readonly pick = output<Stage>();
  readonly reopen = output<void>();

  protected readonly open = signal(false);
  private readonly toggle = viewChild<ElementRef<HTMLButtonElement>>('toggle');

  protected choose(target: Stage): void {
    this.open.set(false);
    this.toggle()?.nativeElement.focus();
    this.pick.emit(target);
  }

  protected close(event: Event): void {
    if (!this.open()) return;
    event.stopPropagation(); // Escape closes the menu, not a dialog around it
    this.open.set(false);
    this.toggle()?.nativeElement.focus();
  }

  protected onFocusOut(event: FocusEvent): void {
    const host = event.currentTarget;
    if (host instanceof Element && event.relatedTarget instanceof Node && host.contains(event.relatedTarget)) return;
    this.open.set(false);
  }
}

/**
 * Runs the moves of one screen (the board, the candidate page): a move between active stages is sent at once;
 * « Refus » asks for the reason and « Désistement » for an optional comment in a dialog first.
 */
@Component({
  selector: 'app-application-move',
  imports: [TranslocoDirective, ReactiveFormsModule, ControlError, RevealAlert],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dialog class="modal" *transloco="let t" aria-labelledby="move-title" (close)="pending.set(null)">
      @if (pending(); as p) {
        @let c = form.controls;
        <form [formGroup]="form" (ngSubmit)="confirm()" novalidate data-form="move">
          <h2 id="move-title">{{ t(p.target === 'rejected' ? 'recruitment.move.rejectTitle' : 'recruitment.move.withdrawTitle') }}</h2>
          <p><bdi>{{ p.subject.name }}</bdi></p>
          @if (formError(); as error) {
            <p class="form-error" role="alert" [appRevealAlert]="error">{{ 'key' in error ? t(error.key) : error.text }}</p>
          }
          @if (p.target === 'rejected') {
            <div class="field">
              <label for="move-reason">{{ t('recruitment.move.reason') }}</label>
              <select id="move-reason" formControlName="rejectionReasonId" required
                [attr.aria-invalid]="c.rejectionReasonId.invalid && c.rejectionReasonId.touched" aria-describedby="move-reason-error">
                <option value="" disabled>{{ t('recruitment.move.reasonPlaceholder') }}</option>
                @for (reason of reasons(); track reason.id) {
                  <option [value]="reason.id">{{ label(reason) }}</option>
                }
              </select>
              @if (reasonList.error()) {
                <p class="field-error">{{ t('recruitment.move.reasonsError') }}</p>
              }
              <app-control-error [control]="c.rejectionReasonId" errorId="move-reason-error" [keys]="errorKeys" />
            </div>
          }
          <div class="field">
            <label for="move-comment">{{ t('recruitment.move.comment') }}</label>
            <textarea id="move-comment" formControlName="comment" rows="3" dir="auto"
              [attr.aria-invalid]="c.comment.invalid && c.comment.touched" aria-describedby="move-comment-hint move-comment-error"></textarea>
            <p class="field-hint" id="move-comment-hint">{{ t('recruitment.move.commentHint') }}</p>
            <app-control-error [control]="c.comment" errorId="move-comment-error" [keys]="errorKeys" />
          </div>
          <div class="form-actions">
            <button class="btn" type="submit" data-action="confirm-move" [disabled]="busy()">
              {{ t(p.target === 'rejected' ? 'recruitment.move.confirmReject' : 'recruitment.move.confirmWithdraw') }}
            </button>
            <button class="btn secondary" type="button" (click)="dialog.close()">{{ t('common.cancel') }}</button>
          </div>
        </form>
      }
    </dialog>
  `,
})
export class ApplicationMove {
  private readonly api = inject(RecruitmentApi);
  private readonly lang = inject(LanguageService).current;

  readonly moved = output<MoveOutcome>();
  readonly failed = output<MoveFailure>();

  /** True while a request is in flight: hosts disable their move buttons. */
  readonly busy = signal(false);
  protected readonly pending = signal<{ readonly subject: MoveSubject; readonly target: Stage } | null>(null);
  protected readonly formError = signal<FormMessage | null>(null);
  protected readonly errorKeys = ERROR_KEYS;

  // The reasons are only needed by the rejection dialog: loaded the first time it opens.
  private readonly needReasons = signal(false);
  protected readonly reasonList = this.api.reasonsResource(this.needReasons);
  protected readonly reasons = computed<readonly ReasonView[]>(() =>
    this.reasonList.hasValue() ? this.reasonList.value().items.filter((reason) => reason.active && !reason.autoOnly) : [],
  );

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  protected readonly form = inject(NonNullableFormBuilder).group({
    rejectionReasonId: [''],
    comment: ['', text(1, COMMENT_MAX, false)],
  });

  protected label(reason: ReasonView): string {
    return pickLabel(reason.labels, this.lang());
  }

  move(subject: MoveSubject, target: Stage): void {
    if (target !== 'rejected' && target !== 'withdrawn') {
      this.run(subject, this.api.move(subject.id, { toStage: target, expectedStage: subject.stage }), false);
      return;
    }
    if (target === 'rejected') this.needReasons.set(true);
    this.formError.set(null);
    this.form.reset({ rejectionReasonId: '', comment: '' });
    this.pending.set({ subject, target });
    this.dialog().nativeElement.showModal();
  }

  reopen(subject: MoveSubject): void {
    this.run(subject, this.api.reopenApplication(subject.id, subject.stage), false);
  }

  protected confirm(): void {
    const p = this.pending();
    if (!p) return;
    const { rejectionReasonId, comment } = this.form.controls;
    if (p.target === 'rejected' && !rejectionReasonId.value) {
      rejectionReasonId.setErrors({ required: true });
      rejectionReasonId.markAsTouched();
      return;
    }
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const note = comment.value.trim();
    this.run(
      p.subject,
      this.api.move(p.subject.id, {
        toStage: p.target,
        expectedStage: p.subject.stage,
        ...(p.target === 'rejected' ? { rejectionReasonId: rejectionReasonId.value } : {}),
        ...(note ? { comment: note } : {}),
      }),
      true,
    );
  }

  private run(subject: MoveSubject, request$: Observable<ApplicationDetailView>, fromDialog: boolean): void {
    this.formError.set(null);
    this.busy.set(true);
    request$.subscribe({
      next: (application) => {
        this.busy.set(false);
        if (fromDialog) this.dialog().nativeElement.close();
        this.moved.emit({ application, name: subject.name });
      },
      error: (error: unknown) => {
        this.busy.set(false);
        const failure = moveFailure(error);
        // A field error (the reason was deactivated meanwhile…) stays in the dialog; anything else goes to the host.
        if (fromDialog && !failure.reload) {
          const message = recruitmentProblemToForm(this.form, error);
          this.formError.set(message);
          if (this.form.invalid || message) return;
        }
        if (fromDialog) this.dialog().nativeElement.close();
        this.failed.emit(failure);
      },
    });
  }
}
