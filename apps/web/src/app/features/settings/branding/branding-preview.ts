/**
 * A picture of the result before saving (docs/contracts/branding.md › Preview before saving): a header strip, a
 * primary button, a dashboard tile, the sign-in message and the footer, from the draft values.
 *
 * `data-brand` on the frame themes this subtree only (styles.css maps the code to `--color-primary`): no inline
 * style carries the colour. Texts are interpolated, never markup. The frame is `aria-hidden`: it repeats what the
 * form fields already say; the caption stays visible and announced.
 */
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';
import type { BrandColor } from '../../../core/branding/branding.models';

@Component({
  selector: 'app-branding-preview',
  imports: [TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <figure class="preview" *transloco="let t">
      <figcaption>{{ t('branding.preview.caption') }}</figcaption>
      <div class="frame" aria-hidden="true" data-preview [attr.data-brand]="color()">
        <div class="strip">
          @if (logoUrl(); as url) {
            <span class="chip"><img [src]="url" alt="" /></span>
          }
          <span class="title" dir="auto" data-preview-text="title">{{ title() ?? t('app.title') }}</span>
        </div>
        <div class="body">
          <div class="tile">
            <strong dir="auto" data-preview-text="welcomeTitle">{{ welcomeTitle() ?? t('home.title') }}</strong>
            <span class="text" dir="auto" data-preview-text="welcomeMessage">{{ welcomeMessage() ?? t('home.intro') }}</span>
          </div>
          <span class="button">{{ t('branding.preview.button') }}</span>
          @if (signInMessage(); as message) {
            <span class="note" dir="auto" data-preview-text="signInMessage">{{ message }}</span>
          }
        </div>
        @if (footer(); as text) {
          <div class="foot" dir="auto" data-preview-text="footer">{{ text }}</div>
        }
      </div>
    </figure>
  `,
  styles: `
    .preview { margin: 0; }
    figcaption { margin-block-end: var(--space-2); color: var(--color-text-muted); font-size: 0.875rem; }
    .frame { border: 1px solid var(--color-border); border-radius: var(--radius); background: var(--color-surface); overflow: hidden; overflow-wrap: anywhere; }
    .strip { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-2) var(--space-3); background: var(--color-primary); color: var(--color-on-primary); font-weight: 600; }
    .chip { display: flex; flex: none; padding: var(--space-1); border-radius: var(--radius); background: var(--color-surface); }
    .chip img { display: block; max-block-size: 1.5rem; max-inline-size: 7rem; object-fit: contain; }
    .title { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .body { display: grid; gap: var(--space-3); justify-items: start; padding: var(--space-3); }
    .tile { display: grid; gap: var(--space-1); justify-self: stretch; padding: var(--space-3); border: 1px solid var(--color-border); border-inline-start: 3px solid var(--color-primary); border-radius: var(--radius); background: var(--color-surface-alt); }
    .tile strong { color: var(--color-primary); }
    .text, .note { white-space: pre-line; }
    .text { color: var(--color-text-muted); font-size: 0.875rem; }
    .button { padding: var(--space-1) var(--space-3); border-radius: var(--radius); background: var(--color-primary); color: var(--color-on-primary); }
    .note { justify-self: stretch; margin: 0; font-size: 0.875rem; }
    .foot { padding: var(--space-2); border-block-start: 1px solid var(--color-border); color: var(--color-text-muted); font-size: 0.75rem; text-align: center; }
  `,
})
export class BrandingPreview {
  readonly color = input.required<BrandColor>();
  /** A same-origin API URL or a local `data:` URL. */
  readonly logoUrl = input<string | null>(null);
  /** `null` = the app's built-in text. */
  readonly title = input<string | null>(null);
  readonly welcomeTitle = input<string | null>(null);
  readonly welcomeMessage = input<string | null>(null);
  /** `null` = not shown. */
  readonly signInMessage = input<string | null>(null);
  readonly footer = input<string | null>(null);
}
