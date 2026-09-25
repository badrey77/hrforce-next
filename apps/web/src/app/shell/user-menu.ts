/**
 * Header widget: the signed-in user's display name, the active company, and "Sign out".
 *
 * Angular concepts:
 * - **Reading a root signal store from a component.** `session.user()` / `session.company()` are signals of the
 *   root `Session` service. Reading them in the template subscribes this OnPush component to them: when the
 *   session changes (login, logout, failed refresh) exactly this view re-renders. No inputs, no event bus.
 * - **`@if (x(); as user)`** — narrows a nullable signal value to a local template variable, so the rest of
 *   the block can use `user.displayName` without `?.` (strictTemplates knows it is non-null there).
 * - **`(click)`** — an event binding; `signOut()` runs on click.
 */
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { AuthApi } from '../core/auth/auth-api';
import { Session } from '../core/auth/session';

@Component({
  selector: 'app-user-menu',
  imports: [TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-container *transloco="let t">
      @if (session.user(); as user) {
        <div class="user-menu">
          <span class="identity">
            <span class="name">{{ user.displayName }}</span>
            @if (session.company(); as company) {
              <span class="company">{{ company.name }}</span>
            }
          </span>
          <button type="button" class="btn secondary" [disabled]="signingOut()" (click)="signOut()">
            {{ t('auth.session.signOut') }}
          </button>
        </div>
      }
    </ng-container>
  `,
  styles: `
    .user-menu {
      display: inline-flex;
      align-items: center;
      gap: var(--space-3);
    }
    .identity {
      display: flex;
      flex-direction: column;
      line-height: 1.2;
    }
    .name {
      font-weight: 600;
    }
    .company {
      font-size: 0.8125rem;
      opacity: 0.85;
    }
  `,
})
export class UserMenu {
  protected readonly session = inject(Session);
  private readonly auth = inject(AuthApi);
  private readonly router = inject(Router);

  protected readonly signingOut = signal(false);

  /** `POST /api/auth/logout`, then signed out locally and on `/login` — even if the call failed. */
  protected async signOut(): Promise<void> {
    this.signingOut.set(true);
    try {
      await firstValueFrom(this.auth.logout());
    } catch {
      // Offline or already expired: the local sign-out below is what the user asked for.
    } finally {
      this.session.clear();
      this.signingOut.set(false);
      await this.router.navigateByUrl('/login');
    }
  }
}
