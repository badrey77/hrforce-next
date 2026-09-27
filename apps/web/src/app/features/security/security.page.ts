/**
 * `/me/security` — the signed-in user's two-step sign-in (docs/contracts/mfa.md › Web): status, the enrollment wizard,
 * new recovery codes, and turning it off (hidden when the company requires it). The enforcement guard and the 403
 * interceptor (core/auth/mfa-enrollment.ts) send people here with `?enroll=1&returnUrl=…`.
 *
 * Angular concepts:
 * - **Query params as inputs** (`enroll`, `returnUrl`), like the login page; `returnUrl` goes through
 *   `safeReturnUrl()` before use.
 * - **`linkedSignal()` for "open unless the user closed it".** `wizardOpen` is DERIVED (open when the link said
 *   `enroll=1` or the policy requires enrollment, and MFA is not on yet) but also WRITABLE (Set up / Cancel). When
 *   its source changes — the session is reloaded after enrollment and `enabled` becomes true — it recomputes to
 *   `false` by itself.
 * - **After enrollment: reload, then continue.** `onEnrolled()` awaits `Session.load()` so `mfaEnrollmentRequired()`
 *   is false BEFORE navigating (otherwise `mfaEnrollmentGuard` would send the user straight back here), then goes to
 *   the original `returnUrl`.
 * - **Child component events**: `(finished)` / `(cancelled)` are `output()`s of the wizard; the page owns what
 *   happens next (session, navigation), the wizard owns only its own steps.
 * - **Two tiny forms** (regenerate, disable) each with one code control; their slug table maps `mfa-invalid` onto the
 *   field and `mfa-required-by-policy` to a form-level message (security-forms.ts).
 */
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, linkedSignal, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { MfaApi } from '../../core/auth/mfa-api';
import { normalizeTotp, totpCode } from '../../core/auth/one-time-code';
import { safeReturnUrl } from '../../core/auth/return-url';
import { Session } from '../../core/auth/session';
import { type FormMessage, problemToForm } from '../../core/http/problem-form';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { MfaEnrollWizard } from './mfa-enroll-wizard';
import { RecoveryCodes } from './recovery-codes';
import { MFA_CODE_SLUGS } from './security-forms';

/** Warn when this few recovery codes are left. */
export const LOW_RECOVERY_CODES = 3;

@Component({
  selector: 'app-security-page',
  imports: [TranslocoDirective, ReactiveFormsModule, DatePipe, MfaEnrollWizard, RecoveryCodes],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './security.page.html',
  styleUrl: './security.css',
})
export class SecurityPage {
  private readonly api = inject(MfaApi);
  private readonly router = inject(Router);
  private readonly fb = inject(NonNullableFormBuilder);
  private readonly language = inject(LanguageService);
  protected readonly session = inject(Session);

  /** `?enroll=1` — sent here by the enforcement guard / interceptor. */
  readonly enroll = input<string>();
  /** `?returnUrl=` — where to continue after enrolling. */
  readonly returnUrl = input<string>();

  protected readonly status = this.api.statusResource();
  protected readonly locale = computed(() => dateLocaleOf(this.language.current()));

  /** Enabled per the page's own status read, falling back to the session. */
  protected readonly enabled = computed(() =>
    this.status.hasValue() ? this.status.value().enabled : (this.session.mfa()?.enabled ?? false),
  );
  protected readonly required = computed(() =>
    this.status.hasValue() ? this.status.value().required : (this.session.mfa()?.required ?? false),
  );
  protected readonly lowCodes = computed(() => {
    const left = this.status.hasValue() ? this.status.value().recoveryCodesLeft : null;
    return left !== null && left <= LOW_RECOVERY_CODES;
  });

  protected readonly wizardOpen = linkedSignal(
    () => !this.enabled() && (this.enroll() === '1' || this.session.mfaEnrollmentRequired()),
  );

  protected readonly feedback = signal<string | null>(null);

  // --- Regenerate recovery codes ---------------------------------------------------------------------------
  protected readonly regenerateForm = this.fb.group({ code: ['', [Validators.required, totpCode]] });
  protected readonly regenerating = signal(false);
  protected readonly regenerateError = signal<FormMessage | null>(null);
  protected readonly newCodes = signal<readonly string[] | null>(null);
  protected readonly newCodesSaved = signal(false);

  // --- Disable ------------------------------------------------------------------------------------------------
  protected readonly disableForm = this.fb.group({ code: ['', [Validators.required, totpCode]] });
  protected readonly disabling = signal(false);
  protected readonly disableError = signal<FormMessage | null>(null);

  protected openWizard(): void {
    this.feedback.set(null);
    this.wizardOpen.set(true);
  }

  /** The wizard finished: reload the session (the guard reads it), then continue where the user was going. */
  protected async onEnrolled(): Promise<void> {
    await this.session.load();
    this.status.reload();
    this.wizardOpen.set(false);
    this.feedback.set('security.feedback.enabled');
    const target = safeReturnUrl(this.returnUrl(), '');
    if (target && !target.startsWith('/me/security')) {
      await this.router.navigateByUrl(target);
    } else if (this.enroll() !== undefined || this.returnUrl() !== undefined) {
      // Drop ?enroll=1 so a reload does not re-open the wizard; replaceUrl keeps Back sensible.
      await this.router.navigate([], { queryParams: {}, replaceUrl: true });
    }
  }

  protected regenerate(): void {
    this.regenerateError.set(null);
    this.feedback.set(null);
    if (this.regenerateForm.invalid) {
      this.regenerateForm.markAllAsTouched();
      return;
    }
    this.regenerating.set(true);
    this.api.regenerateRecoveryCodes(normalizeTotp(this.regenerateForm.getRawValue().code)).subscribe({
      next: ({ recoveryCodes }) => {
        this.regenerating.set(false);
        this.regenerateForm.reset();
        this.newCodesSaved.set(false);
        this.newCodes.set(recoveryCodes);
      },
      error: (error: unknown) => {
        this.regenerating.set(false);
        this.regenerateForm.controls.code.setValue('');
        this.regenerateError.set(problemToForm(this.regenerateForm, error, MFA_CODE_SLUGS));
      },
    });
  }

  /** "Done" after new codes: only once they are saved. */
  protected closeNewCodes(): void {
    if (!this.newCodesSaved()) return;
    this.newCodes.set(null);
    this.feedback.set('security.feedback.regenerated');
    this.status.reload();
    void this.session.load();
  }

  protected disable(): void {
    this.disableError.set(null);
    this.feedback.set(null);
    if (this.disableForm.invalid) {
      this.disableForm.markAllAsTouched();
      return;
    }
    this.disabling.set(true);
    this.api.disable(normalizeTotp(this.disableForm.getRawValue().code)).subscribe({
      next: () => {
        this.disabling.set(false);
        this.disableForm.reset();
        this.feedback.set('security.feedback.disabled');
        this.status.reload();
        void this.session.load();
      },
      error: (error: unknown) => {
        this.disabling.set(false);
        this.disableForm.controls.code.setValue('');
        this.disableError.set(problemToForm(this.disableForm, error, MFA_CODE_SLUGS));
      },
    });
  }
}
