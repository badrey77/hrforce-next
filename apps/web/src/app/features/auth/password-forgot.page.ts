/**
 * `/password/forgot` — ask for a reset link (`POST /api/auth/password/forgot`, always 202).
 *
 * The page shows the SAME confirmation whatever happens server-side ("if the address exists, a link was sent"):
 * a different message for unknown addresses would let anyone test which emails have an account (account
 * enumeration). That includes HTTP errors (a 429 or 422 would also leak something); only a network failure,
 * where no server answered at all, shows its own message so the user knows to retry.
 *
 * Angular concepts: nothing new beyond login.page.ts — a typed reactive form, `async` submit, signals for the
 * view state, and `@if` / `@else` to swap the form for the confirmation.
 */
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { AuthApi } from '../../core/auth/auth-api';
import { isApiProblemError, PROBLEM_TYPE_NETWORK } from '../../core/http/api-problem';

@Component({
  selector: 'app-password-forgot-page',
  imports: [ReactiveFormsModule, TranslocoDirective, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-container *transloco="let t">
      <h1 id="forgot-title">{{ t('auth.passwordForgot.title') }}</h1>
      @if (sent()) {
        <p role="status">{{ t('auth.passwordForgot.sent') }}</p>
      } @else {
        <p>{{ t('auth.passwordForgot.intro') }}</p>
        <form [formGroup]="form" (ngSubmit)="submit()" aria-labelledby="forgot-title" novalidate>
          @if (networkError()) {
            <p class="form-error" role="alert">{{ t('errors.network') }}</p>
          }
          @let email = form.controls.email;
          <div class="field">
            <label for="forgot-email">{{ t('auth.passwordForgot.email') }}</label>
            <input
              id="forgot-email"
              type="email"
              formControlName="email"
              autocomplete="email"
              inputmode="email"
              dir="ltr"
              required
              [attr.aria-invalid]="email.invalid && email.touched"
              [attr.aria-describedby]="email.invalid && email.touched ? 'forgot-email-error' : null"
            />
            @if (email.invalid && email.touched) {
              <p class="field-error" id="forgot-email-error">
                {{
                  email.hasError('required')
                    ? t('auth.login.errors.emailRequired')
                    : t('auth.login.errors.emailInvalid')
                }}
              </p>
            }
          </div>
          <button class="btn" type="submit" [disabled]="submitting()">
            {{ submitting() ? t('auth.passwordForgot.submitting') : t('auth.passwordForgot.submit') }}
          </button>
        </form>
      }
      <p class="aside"><a routerLink="/login">{{ t('auth.passwordForgot.backToLogin') }}</a></p>
    </ng-container>
  `,
  styles: `
    :host {
      display: block;
      max-inline-size: 28rem;
    }
    .aside {
      margin-block-start: var(--space-4);
    }
  `,
})
export class PasswordForgotPage {
  private readonly auth = inject(AuthApi);

  protected readonly form = inject(NonNullableFormBuilder).group({
    email: ['', [Validators.required, Validators.email, Validators.maxLength(254)]],
  });
  protected readonly submitting = signal(false);
  protected readonly sent = signal(false);
  protected readonly networkError = signal(false);

  protected async submit(): Promise<void> {
    this.networkError.set(false);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.submitting.set(true);
    try {
      await firstValueFrom(this.auth.forgotPassword(this.form.controls.email.value.trim()));
      this.sent.set(true);
    } catch (error: unknown) {
      if (isApiProblemError(error) && error.problem.type === PROBLEM_TYPE_NETWORK) {
        this.networkError.set(true);
      } else {
        this.sent.set(true);
      }
    } finally {
      this.submitting.set(false);
    }
  }
}
