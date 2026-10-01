/**
 * `/login` — email + password against `POST /api/auth/login`, then, when the account has two-step sign-in, a code
 * against `POST /api/auth/mfa/verify` (docs/contracts/identity.md › Web, docs/contracts/mfa.md › Login flow / Web).
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
 *
 * Two-step sign-in (chapter 17 of docs/angular):
 * - **UI steps as STATE, not routes.** `step` is a `signal<'password' | 'code'>` and the template shows one step with
 *   `@switch (step())`. A `/login/code` route would be bookmarkable and reachable by Back/Forward — but the code step
 *   is meaningless on its own: it only works while the 5-minute `hrf_mfa` cookie from THIS password step exists, a
 *   reload must start over, and Back should leave the login page, not re-show a dead step. A route would also have
 *   to carry the email across in the URL or a service. As state, both steps share one component (the email is still
 *   in the form), and "start over" is `step.set('password')`. Rule of thumb: a route for places a user may return to;
 *   a signal for phases of one task.
 * - **Focus follows the step.** When the step changes the old inputs are destroyed; focus would fall to `<body>` and
 *   a screen-reader user would not know anything happened. `afterNextRender()` runs once, after Angular has updated
 *   the DOM for the new step, and focuses its first field (it needs the component's `Injector` because it is called
 *   outside the constructor).
 * - **Auto-submit with `valueChanges` + `filter`.** The code control's `valueChanges` Observable emits on every
 *   change — typing, pasting, and the browser's one-time-code autofill (`autocomplete="one-time-code"`, SMS/app
 *   suggestions), which fire `input` but no keyboard events. `filter()` lets through only a complete 6-digit value,
 *   and `takeUntilDestroyed()` ends the subscription with the component. A template event such as `(keyup)` would
 *   miss paste-by-menu and autofill, and `(input)` would re-implement "is it complete?" in the template; the form
 *   control is the single source of the value, so the rule lives on it.
 * - **One-time-code input attributes**: `inputmode="numeric"` (digit keypad on phones without `type=number`'s
 *   spinners and number parsing), `autocomplete="one-time-code"`, `pattern="[0-9]*"`, `maxlength`, and `dir="ltr"`
 *   so digits never mirror in the Arabic UI.
 */
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  type ElementRef,
  Injector,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { filter, firstValueFrom } from 'rxjs';
import { AuthApi } from '../../core/auth/auth-api';
import { AUTH_PROBLEM, type MfaVerification, RECOVERY_CODE_PATTERN } from '../../core/auth/auth.models';
import { isCompleteTotp, normalizeTotp, totpCode } from '../../core/auth/one-time-code';
import { safeReturnUrl } from '../../core/auth/return-url';
import { Session } from '../../core/auth/session';
import { type ApiProblemError, isApiProblemError, PROBLEM_TYPE_NETWORK, retryAfterSeconds } from '../../core/http/api-problem';
import { applyServerErrors } from '../../core/http/apply-server-errors';
import { LanguageService } from '../../core/i18n/language.service';

/** Used when a 423/429 arrives without a usable Retry-After: the contract's 15-minute throttle window. */
const DEFAULT_LOCK_MINUTES = 15;

type FormError = { readonly key: string; readonly params?: Record<string, unknown> } | { readonly text: string };

/** The two phases of signing in. */
export type LoginStep = 'password' | 'code';
/** Which second factor the code step asks for. */
export type CodeKind = 'totp' | 'recovery';

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
    .otp {
      font-family: var(--font-mono);
      font-size: 1.5rem;
      letter-spacing: 0.3em;
      max-inline-size: 12rem;
    }
    .link-button {
      padding: 0;
      border: 0;
      background: none;
      color: var(--color-primary);
      text-decoration: underline;
      cursor: pointer;
    }
    .code-links {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-4);
      margin-block-start: var(--space-4);
    }
  `,
})
export class LoginPage {
  private readonly auth = inject(AuthApi);
  private readonly session = inject(Session);
  private readonly language = inject(LanguageService);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly fb = inject(NonNullableFormBuilder);

  /** `?returnUrl=` (bound by the router). Validated before use. */
  readonly returnUrl = input<string>();
  /** Coming from an attendance scan (`returnUrl=/punch`): the page says the punch waits for this sign-in. */
  protected readonly forPunch = computed(() => this.returnUrl() === '/punch');
  /**
   * Coming from the SSO handoff page (`returnUrl=/sso/<uid>`, docs/contracts/sso.md › Web): a connected app is waiting
   * for this sign-in. The banner does NOT name the app: the URL is attacker-controlled, and only the handoff page may
   * say which app is asking (it reads the name from the API). `safeReturnUrl()` accepts the path as it is.
   */
  protected readonly forSso = computed(() => this.returnUrl()?.startsWith('/sso/') ?? false);

  protected readonly form = this.fb.group({
    email: ['', [Validators.required, Validators.email, Validators.maxLength(254)]],
    password: ['', [Validators.required, Validators.maxLength(1024)]],
  });

  /** Second step. Two controls, one per kind; only the active one is validated and sent. */
  protected readonly codeForm = this.fb.group({
    code: ['', [Validators.required, totpCode]],
    recoveryCode: ['', [Validators.required, Validators.pattern(RECOVERY_CODE_PATTERN)]],
  });

  protected readonly step = signal<LoginStep>('password');
  protected readonly codeKind = signal<CodeKind>('totp');
  protected readonly submitting = signal(false);
  /** Translation key (with params) of a form-level error, or a raw server message. */
  protected readonly formError = signal<FormError | null>(null);

  private readonly emailInput = viewChild<ElementRef<HTMLInputElement>>('emailInput');
  private readonly passwordInput = viewChild<ElementRef<HTMLInputElement>>('passwordInput');
  private readonly codeInput = viewChild<ElementRef<HTMLInputElement>>('codeInput');

  constructor() {
    // Auto-submit: a complete 6-digit code (typed, pasted or autofilled) is sent without pressing Enter.
    this.codeForm.controls.code.valueChanges
      .pipe(
        filter(isCompleteTotp),
        takeUntilDestroyed(inject(DestroyRef)),
      )
      .subscribe(() => {
        if (this.step() === 'code' && this.codeKind() === 'totp' && !this.submitting()) {
          void this.verify();
        }
      });
  }

  protected async submit(): Promise<void> {
    this.formError.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.submitting.set(true);
    try {
      const { email, password } = this.form.getRawValue();
      const outcome = await firstValueFrom(this.auth.login({ email: email.trim(), password }));
      if (outcome === 'mfa-required') {
        this.showCodeStep();
        return;
      }
      await this.finishSignIn();
    } catch (error: unknown) {
      this.handleError(error);
    } finally {
      this.submitting.set(false);
    }
  }

  /** Second step: `POST /auth/mfa/verify` with the active kind of code. */
  protected async verify(): Promise<void> {
    this.formError.set(null);
    const kind = this.codeKind();
    const control = kind === 'totp' ? this.codeForm.controls.code : this.codeForm.controls.recoveryCode;
    if (control.invalid) {
      control.markAsTouched();
      return;
    }
    const body: MfaVerification =
      kind === 'totp' ? { code: normalizeTotp(control.value) } : { recoveryCode: control.value.trim().toUpperCase() };
    this.submitting.set(true);
    try {
      await firstValueFrom(this.auth.verifyMfa(body));
      await this.finishSignIn();
    } catch (error: unknown) {
      this.handleVerifyError(error);
    } finally {
      this.submitting.set(false);
    }
  }

  /** "Use a recovery code" ⇄ "Use the code from my app". */
  protected toggleCodeKind(): void {
    this.formError.set(null);
    this.codeKind.update((kind) => (kind === 'totp' ? 'recovery' : 'totp'));
    this.codeForm.reset();
    this.focusAfterRender(() => this.codeInput());
  }

  /** Back to the password step (a new password step creates a new challenge). */
  protected backToPassword(error: FormError | null = null): void {
    this.step.set('password');
    this.codeKind.set('totp');
    this.codeForm.reset();
    this.form.controls.password.reset();
    this.formError.set(error);
    this.focusAfterRender(() => this.passwordInput() ?? this.emailInput());
  }

  private showCodeStep(): void {
    // The password has done its job; do not keep it in memory longer than needed.
    this.form.controls.password.reset();
    this.codeForm.reset();
    this.codeKind.set('totp');
    this.step.set('code');
    this.focusAfterRender(() => this.codeInput());
  }

  private async finishSignIn(): Promise<void> {
    await this.session.load();
    const user = this.session.user();
    if (!user) {
      // Logged in but /api/me failed: staying here beats bouncing between the guard and this page.
      this.formError.set({ key: 'errors.generic' });
      return;
    }
    this.language.applyAccountLocale(user.locale);
    // A user who must enroll first is sent to the wizard by mfaEnrollmentGuard, with this URL as its returnUrl.
    await this.router.navigateByUrl(safeReturnUrl(this.returnUrl()));
  }

  private focusAfterRender(target: () => ElementRef<HTMLElement> | undefined): void {
    afterNextRender(() => target()?.nativeElement.focus(), { injector: this.injector });
  }

  private lockMessage(error: ApiProblemError): FormError | null {
    const seconds = retryAfterSeconds(error);
    const minutes = seconds === null ? DEFAULT_LOCK_MINUTES : Math.max(1, Math.ceil(seconds / 60));
    if (error.status === 423) return { key: 'auth.login.errors.locked', params: { minutes } };
    if (error.status === 429) return { key: 'auth.login.errors.tooManyAttempts', params: { minutes } };
    return null;
  }

  private handleVerifyError(error: unknown): void {
    if (!isApiProblemError(error)) {
      this.formError.set({ key: 'errors.generic' });
      return;
    }
    const { problem } = error;
    const lock = this.lockMessage(error);
    if (lock) {
      // The account is locked for minutes; the 5-minute challenge will be dead by then: start over later.
      this.backToPassword(lock);
      return;
    }
    if (problem.type === AUTH_PROBLEM.mfaChallengeExpired) {
      this.backToPassword({ key: 'auth.login.mfa.expired' });
      return;
    }
    if (problem.status === 401 || problem.type === AUTH_PROBLEM.mfaInvalid) {
      const control = this.codeKind() === 'totp' ? this.codeForm.controls.code : this.codeForm.controls.recoveryCode;
      // Clear the wrong code (emitEvent: false — do not auto-submit the empty value), then flag the field.
      control.setValue('', { emitEvent: false });
      control.setErrors({ mfaInvalid: true });
      control.markAsTouched();
      this.focusAfterRender(() => this.codeInput());
      return;
    }
    this.formError.set({ key: problem.type === PROBLEM_TYPE_NETWORK ? 'errors.network' : 'errors.generic' });
  }

  private handleError(error: unknown): void {
    if (!isApiProblemError(error)) {
      this.formError.set({ key: 'errors.generic' });
      return;
    }
    const { problem } = error;
    const lock = this.lockMessage(error);
    if (lock) {
      this.formError.set(lock);
      return;
    }
    switch (problem.status) {
      case 401:
        this.formError.set({ key: 'auth.login.errors.invalidCredentials' });
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
