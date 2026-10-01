/**
 * `<app-sso-secret-panel [secret]="secret()" [clientId]="…" (done)="finish()" />` — shows a connected app's client
 * secret ONCE, right after `POST /sso/clients` or `POST /sso/clients/:id/rotate-secret` (docs/contracts/sso.md › Web).
 * Plus `secretLeaveGuard`, the `canDeactivate` guard of the two routes that show it.
 *
 * Angular concepts:
 * - **Where a show-once secret lives.** The API returns it once and can never show it again. The PAGE that asked for
 *   it keeps it in a component signal (`secret = signal<string | null>(null)`), passes it here as an input, and sets
 *   it back to `null` as soon as the person clicks « Terminer » — and in `DestroyRef.onDestroy`, so leaving the page
 *   drops it too. Not in a root service (which lives as long as the tab and is reachable from every component), not
 *   in `localStorage`/`sessionStorage` (readable by any script of the origin, and written to disk), never in the URL
 *   (history, logs, Referer). This panel holds nothing itself: it is a pure view of its input.
 * - **The Clipboard API** (`copyText()`, core/browser/clipboard.ts): `navigator.clipboard.writeText()` from a click. It
 *   can refuse (permissions, an old browser); the fallback SELECTS the text in the read-only field
 *   (`HTMLInputElement.select()` through `viewChild`) so Ctrl+C / "Copy" works, and says so.
 * - **A gate made of one signal**: the « J'ai copié le secret » checkbox writes `acknowledged`; « Terminer » is
 *   `[disabled]="!acknowledged()"`. No form needed for one boolean.
 * - **`host: { '(window:beforeunload)': … }`** — a host listener on a GLOBAL target: while the panel is on screen,
 *   closing or reloading the tab asks the browser's own "Leave site?" question (`preventDefault()` is how a page asks
 *   for it; browsers show their own text). The router does not see a tab being closed; this does.
 * - **`canDeactivate`** (`secretLeaveGuard`) — the router asks it before LEAVING a route: the person clicked a nav
 *   link, the Back button, a breadcrumb… It receives the page component and returns `true` (leave) or `false` (stay).
 *   The route table lists it (`canDeactivate: [secretLeaveGuard]`, access.routes.ts); the component only has to say
 *   whether it still holds a secret (`SecretHolder`). The confirmation uses the browser's `confirm()`: a synchronous
 *   yes/no is exactly what a guard needs, and it cannot be styled away by mistake.
 */
import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, type ElementRef, inject, input, output, signal, viewChild } from '@angular/core';
import type { CanDeactivateFn } from '@angular/router';
import { TranslocoDirective, TranslocoService } from '@jsverse/transloco';
import { copyText } from '../../core/browser/clipboard';

/** A page that may be showing a secret nobody can see again. */
export interface SecretHolder {
  holdsSecret(): boolean;
}

/** Leaving a page that still shows a secret asks for confirmation first. */
export const secretLeaveGuard: CanDeactivateFn<SecretHolder> = (component) => {
  if (!component.holdsSecret()) return true;
  const message = inject(TranslocoService).translate('sso.secret.leaveConfirm');
  const view = inject(DOCUMENT).defaultView;
  return view ? view.confirm(message) : true;
};

@Component({
  selector: 'app-sso-secret-panel',
  imports: [TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(window:beforeunload)': 'onBeforeUnload($event)' },
  template: `
    <section *transloco="let t" class="panel secret-panel" aria-labelledby="secret-title" data-section="secret">
      <h3 id="secret-title">{{ t('sso.secret.title') }}</h3>
      <p class="warning" role="alert" data-note="shown-once">{{ t('sso.secret.warning') }}</p>
      <dl class="facts">
        <dt>{{ t('sso.apps.clientId') }}</dt>
        <dd><span class="code" dir="ltr">{{ clientId() }}</span></dd>
      </dl>
      <div class="field">
        <label for="sso-secret">{{ t('sso.secret.label') }}</label>
        <!-- readonly (not disabled): the text stays selectable and focusable; dir="ltr" so it never mirrors. -->
        <input #secretInput id="sso-secret" class="secret" type="text" readonly dir="ltr" autocomplete="off" spellcheck="false"
          [value]="secret()" data-field="secret" />
      </div>
      <div class="form-actions">
        <button class="btn secondary" type="button" data-action="copy-secret" (click)="copy()">{{ t('sso.secret.copy') }}</button>
      </div>
      <p class="field-hint" role="status" data-state="copy">
        @if (copied() === true) { {{ t('sso.secret.copied') }} }
        @else if (copied() === false) { {{ t('sso.secret.copyFailed') }} }
      </p>
      <div class="check">
        <input id="sso-secret-ack" type="checkbox" [checked]="acknowledged()" (change)="onAck($event)" />
        <label for="sso-secret-ack">{{ t('sso.secret.confirm') }}</label>
      </div>
      <button class="btn" type="button" data-action="finish" [disabled]="!acknowledged()" (click)="done.emit()">{{ t('sso.secret.done') }}</button>
    </section>
  `,
  styles: `
    .secret-panel { border-color: var(--color-primary); }
    .secret { font-family: var(--font-mono); inline-size: 100%; }
  `,
})
export class SsoSecretPanel {
  /** The secret to show. The PAGE owns it (see the header). */
  readonly secret = input.required<string>();
  readonly clientId = input.required<string>();
  /** « Terminer »: the page forgets the secret. */
  readonly done = output<void>();

  protected readonly acknowledged = signal(false);
  /** `true` copied, `false` refused (fallback: the text is selected), `null` not tried yet. */
  protected readonly copied = signal<boolean | null>(null);
  private readonly secretInput = viewChild.required<ElementRef<HTMLInputElement>>('secretInput');

  protected async copy(): Promise<void> {
    const ok = await copyText(this.secret());
    if (!ok) this.secretInput().nativeElement.select();
    this.copied.set(ok);
  }

  protected onAck(event: Event): void {
    this.acknowledged.set(event.target instanceof HTMLInputElement && event.target.checked);
  }

  protected onBeforeUnload(event: BeforeUnloadEvent): void {
    event.preventDefault();
  }
}
