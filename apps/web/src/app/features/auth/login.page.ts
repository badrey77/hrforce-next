import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { isApiProblemError, PROBLEM_TYPE_NETWORK } from '../../core/http/api-problem';
import { applyServerErrors } from '../../core/http/apply-server-errors';
import { AuthService } from './auth.service';

@Component({
  selector: 'app-login-page',
  imports: [ReactiveFormsModule, TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './login.page.html',
  styles: `
    :host {
      display: block;
      max-inline-size: 24rem;
    }
  `,
})
export class LoginPage {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  protected readonly form = inject(NonNullableFormBuilder).group({
    username: ['', [Validators.required, Validators.maxLength(200)]],
    password: ['', [Validators.required, Validators.maxLength(1024)]],
  });

  protected readonly submitting = signal(false);
  /** Translation key of a form-level error, or a raw server message. */
  protected readonly formError = signal<{ key: string } | { text: string } | null>(null);

  protected submit(): void {
    this.formError.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.submitting.set(true);
    this.auth.login(this.form.getRawValue()).subscribe({
      next: () => {
        this.submitting.set(false);
        void this.router.navigateByUrl('/');
      },
      error: (error: unknown) => {
        this.submitting.set(false);
        this.handleError(error);
      },
    });
  }

  private handleError(error: unknown): void {
    if (!isApiProblemError(error)) {
      this.formError.set({ key: 'errors.generic' });
      return;
    }
    const { problem } = error;
    switch (problem.status) {
      case 401:
        this.formError.set({ key: 'auth.login.errors.invalidCredentials' });
        return;
      case 423:
        this.formError.set({ key: 'auth.login.errors.locked' });
        return;
      case 400:
      case 422: {
        const unmatched = applyServerErrors(this.form, problem);
        const first = unmatched[0];
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
