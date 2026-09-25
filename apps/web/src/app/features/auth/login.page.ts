/**
 * `/login` — email + password against `POST /api/auth/login` (docs/contracts/identity.md › Web).
 *
 * Angular concepts:
 * - **Query param as a signal input.** `returnUrl = input<string>()` is filled from `?returnUrl=` by the router
 *   (`withComponentInputBinding()` in app.config.ts). `authGuard` puts it there when it bounces a visitor.
 * - **Never trust `returnUrl`.** It is attacker-controllable; `safeReturnUrl()` (core/auth/return-url.ts)
 *   accepts internal paths only, otherwise `/` (open-redirect protection).
 * - **`async` event handler + signals.** `submit()` awaits the login POST, then `Session.load()` (`GET /api/me`),
 *   then navigates. The `submitting` / `formError` signals it writes are read by the OnPush template, so the
 *   view updates after each step without zone.js.
 * - **`t(key, params)`** — Transloco fills `{{minutes}}` placeholders from the params object.
 * - **`routerLink`** — the "forgot password" link navigates inside the SPA (no full page load).
 */
import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { AuthApi } from '../../core/auth/auth-api';
import { AUTH_PROBLEM } from '../../core/auth/auth.models';
import { safeReturnUrl } from '../../core/auth/return-url';
import { Session } from '../../core/auth/session';
import { isApiProblemError, PROBLEM_TYPE_NETWORK, retryAfterSeconds } from '../../core/http/api-problem';
import { applyServerErrors } from '../../core/http/apply-server-errors';
import { LanguageService } from '../../core/i18n/language.service';

/** Used when a 423/429 arrives without a usable Retry-After: the contract's 15-minute throttle window. */
const DEFAULT_LOCK_MINUTES = 15;

type FormError = { readonly key: string; readonly params?: Record<string, unknown> } | { readonly text: string };

@Component({
  selector: 'app-login-page',
  imports: [ReactiveFormsModule, TranslocoDirective, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './login.page.html',
  styles: `
    :host {
      display: block;
      max-inline-size: 24rem;
    }
    .aside {
      margin-block-start: var(--space-4);
    }
  `,
})
export class LoginPage {
  private readonly auth = inject(AuthApi);
  private readonly session = inject(Session);
  private readonly language = inject(LanguageService);
  private readonly router = inject(Router);

  /** `?returnUrl=` (bound by the router). Validated before use. */
  readonly returnUrl = input<string>();

  protected readonly form = inject(NonNullableFormBuilder).group({
    email: ['', [Validators.required, Validators.email, Validators.maxLength(254)]],
    password: ['', [Validators.required, Validators.maxLength(1024)]],
  });

  protected readonly submitting = signal(false);
  /** Translation key (with params) of a form-level error, or a raw server message. */
  protected readonly formError = signal<FormError | null>(null);

  protected async submit(): Promise<void> {
    this.formError.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.submitting.set(true);
    try {
      const { email, password } = this.form.getRawValue();
      await firstValueFrom(this.auth.login({ email: email.trim(), password }));
      await this.session.load();
      const user = this.session.user();
      if (!user) {
        // Logged in but /api/me failed: staying here beats bouncing between the guard and this page.
        this.formError.set({ key: 'errors.generic' });
        return;
      }
      this.language.applyAccountLocale(user.locale);
      await this.router.navigateByUrl(safeReturnUrl(this.returnUrl()));
    } catch (error: unknown) {
      this.handleError(error);
    } finally {
      this.submitting.set(false);
    }
  }

  private handleError(error: unknown): void {
    if (!isApiProblemError(error)) {
      this.formError.set({ key: 'errors.generic' });
      return;
    }
    const { problem } = error;
    const minutes = (): number => {
      const seconds = retryAfterSeconds(error);
      return seconds === null ? DEFAULT_LOCK_MINUTES : Math.max(1, Math.ceil(seconds / 60));
    };
    switch (problem.status) {
      case 401:
        this.formError.set({ key: 'auth.login.errors.invalidCredentials' });
        return;
      case 423:
        this.formError.set({ key: 'auth.login.errors.locked', params: { minutes: minutes() } });
        return;
      case 429:
        this.formError.set({ key: 'auth.login.errors.tooManyAttempts', params: { minutes: minutes() } });
        return;
      case 403:
        // 403 is also the XSRF failure (missing/stale cookie): not the user's account, so not "disabled".
        this.formError.set({
          key: problem.type === AUTH_PROBLEM.xsrf ? 'errors.generic' : 'auth.login.errors.disabled',
        });
        return;
      case 400:
      case 422: {
        const first = applyServerErrors(this.form, problem)[0];
        if (first) {
          this.formError.set({ text: first.message });
        }
        return;
      }
      default:
        this.formError.set({
          key: problem.type === PROBLEM_TYPE_NETWORK ? 'errors.network' : 'errors.generic',
        });
    }
  }
}
