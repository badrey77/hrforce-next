/**
 * /access/apps/new — register a connected app (`POST /sso/clients`), then show its client secret ONCE
 * (docs/contracts/sso.md › Web › New).
 *
 * Angular concepts:
 * - **Two phases in one page, as state**: `secret()` is `null` while the form is shown; the 201 answer sets it and
 *   the template swaps the form for `<app-sso-secret-panel>`. « Terminer » clears it and goes to the app's page.
 * - **The show-once secret stays in THIS component** (see features/access/secret-panel.ts): a signal cleared on
 *   « Terminer » and in `DestroyRef.onDestroy`, never in a service, storage or the URL. Only the non-secret parts of the
 *   answer (id, client id) are kept for the next step.
 * - **`canDeactivate`**: the route lists `secretLeaveGuard`; this page implements `SecretHolder.holdsSecret()`, so
 *   leaving while the secret is still on screen (a nav link, Back) asks for confirmation first. « Terminer » clears the
 *   secret BEFORE navigating, so the guard lets that one through without a question.
 */
import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import type { SsoClientCreatedView } from '../../core/sso/sso.models';
import { AccessNav } from './access-nav';
import { SsoAppForm } from './app-settings-form';
import { type SecretHolder, SsoSecretPanel } from './secret-panel';

@Component({
  selector: 'app-access-app-new-page',
  imports: [TranslocoDirective, RouterLink, AccessNav, SsoAppForm, SsoSecretPanel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './access.css',
  template: `
    <ng-container *transloco="let t">
      <app-access-nav />
      <p><a routerLink="/access/apps">{{ t('sso.apps.back') }}</a></p>
      <h2>{{ t('sso.apps.createTitle') }}</h2>
      @if (secret(); as value) {
        <p class="feedback" role="status">{{ t('sso.apps.created') }}</p>
        <app-sso-secret-panel [secret]="value" [clientId]="created()?.clientId ?? ''" (done)="finish()" />
      } @else {
        <app-sso-app-form (created)="onCreated($event)" (cancelled)="cancel()" />
      }
    </ng-container>
  `,
})
export class AppNewPage implements SecretHolder {
  private readonly router = inject(Router);

  /** The one-time secret; `null` once « Terminer » is clicked or the page is left. */
  protected readonly secret = signal<string | null>(null);
  /** The non-secret identity of the new app, for the next navigation. */
  protected readonly created = signal<{ readonly id: string; readonly clientId: string } | null>(null);

  constructor() {
    inject(DestroyRef).onDestroy(() => this.secret.set(null));
  }

  holdsSecret(): boolean {
    return this.secret() !== null;
  }

  protected onCreated(view: SsoClientCreatedView): void {
    this.created.set({ id: view.id, clientId: view.clientId });
    this.secret.set(view.clientSecret);
  }

  protected finish(): void {
    const created = this.created();
    this.secret.set(null);
    void this.router.navigate(created ? ['/access/apps', created.id] : ['/access/apps']);
  }

  protected cancel(): void {
    void this.router.navigate(['/access/apps']);
  }
}
