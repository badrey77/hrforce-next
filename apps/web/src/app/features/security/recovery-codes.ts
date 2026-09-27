/**
 * `<app-recovery-codes [codes]="…" [(saved)]="…" />` — a freshly issued set of recovery codes, shown ONCE (the API
 * stores only their hashes): the list, "Copy all", "Download .txt", and the "I have saved them" checkbox that the
 * parent requires before it lets the user leave. Used by the enrollment wizard's last step and by "Generate new codes".
 *
 * Angular concepts:
 * - **`model()` — a two-way bindable signal.** `saved = model(false)` is an input AND an output in one: the parent
 *   writes `[(saved)]="codesSaved"` (the "banana in a box"), Angular passes the parent's signal value in and, when this
 *   component calls `saved.set(true)`, emits `savedChange` so the parent's signal is updated too. The parent can then
 *   `[disabled]="!codesSaved()"` its Finish button without an extra `(change)` handler. Use `model()` when parent and
 *   child genuinely share one piece of state; prefer `input()` + `output()` when the child only reports events.
 * - **Browser APIs from a component.** Copy uses the async Clipboard API (core/browser/clipboard.ts); Download builds a
 *   `Blob` and clicks a temporary anchor (core/browser/download.ts explains why that is safe here). `DOCUMENT` is
 *   injected rather than using the `document` global so the component does not assume a browser and tests can swap it.
 * - **`dir="ltr"` on the code list**: codes are Latin letters and digits; in the Arabic UI the list stays left-to-right
 *   while the surrounding text flows right-to-left. `translate="no"` keeps browser translation from "fixing" them.
 * - **`role="status"`** on the copy result: announced politely by screen readers without moving focus.
 */
import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, model, signal } from '@angular/core';
import { TranslocoDirective, TranslocoService } from '@jsverse/transloco';
import { copyText } from '../../core/browser/clipboard';
import { downloadText } from '../../core/browser/download';

export const RECOVERY_CODES_FILE = 'hrforce-recovery-codes.txt';

@Component({
  selector: 'app-recovery-codes',
  imports: [TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-container *transloco="let t">
      <p>{{ t('security.codes.intro') }}</p>
      <ol class="codes" dir="ltr" translate="no" data-codes>
        @for (code of codes(); track code) {
          <li><code>{{ code }}</code></li>
        }
      </ol>
      <div class="actions">
        <button type="button" class="btn secondary" data-action="copy-codes" (click)="copy()">
          {{ t('security.codes.copyAll') }}
        </button>
        <button type="button" class="btn secondary" data-action="download-codes" (click)="download()">
          {{ t('security.codes.download') }}
        </button>
        <span role="status" class="copy-status">
          @switch (copyState()) {
            @case ('copied') { {{ t('security.codes.copied') }} }
            @case ('failed') { {{ t('security.codes.copyFailed') }} }
          }
        </span>
      </div>
      <div class="check">
        <input
          type="checkbox"
          [id]="idPrefix() + '-saved'"
          [checked]="saved()"
          (change)="toggleSaved($event)"
          [attr.aria-describedby]="idPrefix() + '-saved-hint'"
        />
        <label [for]="idPrefix() + '-saved'">{{ t('security.codes.savedCheck') }}</label>
      </div>
      <p class="field-hint" [id]="idPrefix() + '-saved-hint'">{{ t('security.codes.savedHint') }}</p>
    </ng-container>
  `,
  styles: `
    .codes {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
      gap: var(--space-1) var(--space-4);
      margin-block: var(--space-3);
      padding-block: var(--space-3);
      padding-inline: var(--space-6);
      background: var(--color-surface-alt);
      border: 1px solid var(--color-border);
      border-radius: var(--radius);
    }
    code {
      font-family: var(--font-mono);
      font-size: 1.0625rem;
      letter-spacing: 0.05em;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2);
      margin-block-end: var(--space-3);
    }
    .copy-status {
      color: var(--color-text-muted);
    }
    .check {
      display: flex;
      align-items: center;
      gap: var(--space-2);
    }
  `,
})
export class RecoveryCodes {
  private readonly document = inject(DOCUMENT);
  private readonly transloco = inject(TranslocoService);

  readonly codes = input.required<readonly string[]>();
  /** Two-way: the "I have saved them" checkbox. */
  readonly saved = model(false);
  readonly idPrefix = input('recovery');

  protected readonly copyState = signal<'idle' | 'copied' | 'failed'>('idle');
  private readonly asText = computed(() => this.codes().join('\n'));

  protected toggleSaved(event: Event): void {
    this.saved.set(event.target instanceof HTMLInputElement && event.target.checked);
  }

  protected async copy(): Promise<void> {
    this.copyState.set((await copyText(this.asText())) ? 'copied' : 'failed');
  }

  protected download(): void {
    const header = this.transloco.translate('security.codes.fileHeader');
    downloadText(this.document, RECOVERY_CODES_FILE, `${header}\n\n${this.asText()}\n`);
  }
}
