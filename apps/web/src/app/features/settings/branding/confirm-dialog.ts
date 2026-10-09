/** A modal yes/no question for the branding page (reset, logo copies): `ask()` resolves with the answer. */
import { ChangeDetectionStrategy, Component, type ElementRef, signal, viewChild } from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';

export interface ConfirmQuestion {
  readonly titleKey: string;
  readonly messageKey: string;
  readonly confirmKey: string;
  /** A destructive action: the confirm button is drawn as such. */
  readonly danger?: boolean;
}

let nextId = 0;

@Component({
  selector: 'app-branding-confirm',
  imports: [TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <dialog #dialog class="modal" [attr.aria-labelledby]="titleId" (close)="settle(false)">
      <ng-container *transloco="let t">
        @if (question(); as q) {
          <h2 [id]="titleId">{{ t(q.titleKey) }}</h2>
          <p>{{ t(q.messageKey) }}</p>
          <div class="form-actions">
            <button class="btn" [class.danger]="q.danger" type="button" data-action="confirm" (click)="settle(true)">{{ t(q.confirmKey) }}</button>
            <button class="btn secondary" type="button" data-action="cancel" (click)="settle(false)">{{ t('common.cancel') }}</button>
          </div>
        }
      </ng-container>
    </dialog>
  `,
  styles: `
    h2 { margin-block: 0 var(--space-3); font-size: 1.125rem; }
  `,
})
export class ConfirmDialog {
  protected readonly titleId = `branding-confirm-${nextId++}`;
  protected readonly question = signal<ConfirmQuestion | null>(null);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private answer: ((value: boolean) => void) | null = null;

  ask(question: ConfirmQuestion): Promise<boolean> {
    this.settle(false);
    this.question.set(question);
    this.dialog().nativeElement.showModal();
    return new Promise((resolve) => (this.answer = resolve));
  }

  /** Also runs on Escape (the dialog's `close` event): that is a "no". */
  protected settle(value: boolean): void {
    const answer = this.answer;
    this.answer = null;
    if (!answer) return;
    answer(value);
    this.dialog().nativeElement.close();
  }
}
