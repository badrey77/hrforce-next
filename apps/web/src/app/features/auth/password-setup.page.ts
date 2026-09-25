/**
 * `/password/setup?token=…` — choose a password from an emailed link (new account or reset; the web cannot tell
 * which, so one wording: "Choose your password"). docs/contracts/identity.md › Web / `POST /auth/password/setup`.
 *
 * Angular concepts:
 * - **Cross-field validation** with a FormGroup-level validator (`passwordsMatch`, password-rules.ts): the
 *   group's `errors`, not a control's, carry `passwordMismatch`.
 * - **Server error CODES → translations.** A 422 carries `errors[{field:'password', code}]`. The code (stable,
 *   language-neutral) is translated here; the server's `message` is only a fallback for a code the web does not
 *   know yet.
 * - **A small state machine in one signal.** `state` is `'form' | 'invalid' | 'done'`; the template's `@switch`
 *   renders exactly one of them. `computed()` folds in "no token in the URL" so that case needs no request.
 */
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';
import { AuthApi } from '../../core/auth/auth-api';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../../core/auth/auth.models';
import { Session } from '../../core/auth/session';
import { isApiProblemError, PROBLEM_TYPE_NETWORK } from '../../core/http/api-problem';
import { PASSWORD_SERVER_ERROR_KEYS, passwordsMatch } from './password-rules';

type SetupState = 'form' | 'invalid' | 'done';

@Component({
  selector: 'app-password-setup-page',
  imports: [ReactiveFormsModule, TranslocoDirective, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './password-setup.page.html',
  styles: `
    :host {
      display: block;
      max-inline-size: 28rem;
    }
    .hints {
      margin-block: 0 var(--space-4);
      padding-inline-start: var(--space-6);
    }
  `,
})
export class PasswordSetupPage {
  private readonly auth = inject(AuthApi);
  private readonly session = inject(Session);

  /** `?token=` (bound by the router). */
  readonly token = input<string>();

  protected readonly minLength = PASSWORD_MIN_LENGTH;
  protected readonly maxLength = PASSWORD_MAX_LENGTH;

  protected readonly form = inject(NonNullableFormBuilder).group(
    {
      password: [
        '',
        [Validators.required, Validators.minLength(PASSWORD_MIN_LENGTH), Validators.maxLength(PASSWORD_MAX_LENGTH)],
      ],
      confirm: ['', [Validators.required]],
    },
    // Second argument of group(): options for the GROUP itself, here its cross-field validator.
    { validators: [passwordsMatch] },
  );

  private readonly outcome = signal<SetupState>('form');
  protected readonly state = computed<SetupState>(() => (this.token() ? this.outcome() : 'invalid'));
  protected readonly submitting = signal(false);
  protected readonly formError = signal<{ key: string } | { text: string } | null>(null);

  protected async submit(): Promise<void> {
    this.formError.set(null);
    const token = this.token();
    if (!token) {
      return;
    }
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.submitting.set(true);
    try {
      await firstValueFrom(this.auth.setupPassword({ token, password: this.form.controls.password.value }));
      // The server revoked every session of this user: whatever this tab believed is now stale.
      this.session.clear();
      this.outcome.set('done');
    } catch (error: unknown) {
      this.handleError(error);
    } finally {
      this.submitting.set(false);
    }
  }

  /** Translation key for a server code, or `null` to fall back to the server's message. */
  protected serverErrorKey(code: unknown): string | null {
    return typeof code === 'string' ? (PASSWORD_SERVER_ERROR_KEYS[code] ?? null) : null;
  }

  private handleError(error: unknown): void {
    if (!isApiProblemError(error)) {
      this.formError.set({ key: 'errors.generic' });
      return;
    }
    const { problem } = error;
    if (problem.status === 410) {
      this.outcome.set('invalid');
      return;
    }
    if (problem.status === 422 || problem.status === 400) {
      const password = this.form.controls.password;
      if (!problem.errors?.length) {
        this.formError.set({ key: 'errors.generic' });
      }
      for (const fieldError of problem.errors ?? []) {
        if (fieldError.field === 'password') {
          password.setErrors({ ...password.errors, server: fieldError.message, serverCode: fieldError.code });
          password.markAsTouched();
        } else if (!this.formError()) {
          this.formError.set({ text: fieldError.message });
        }
      }
      return;
    }
    this.formError.set({ key: problem.type === PROBLEM_TYPE_NETWORK ? 'errors.network' : 'errors.generic' });
  }
}
