/**
 * `<app-mfa-enroll-wizard (finished)="…" (cancelled)="…" [cancellable]="…" />` — setting up two-step sign-in
 * (docs/contracts/mfa.md › Web): intro → 1 · scan the QR code (or type the key) → 2 · enter a code →
 * 3 · recovery codes (shown once; "I have saved them" required) → finished.
 *
 * Angular concepts (chapter 17 of docs/angular):
 * - **A wizard is a small state machine.** The whole wizard is ONE signal, `state`, holding a discriminated union:
 *   each step carries exactly the data that step needs (`scan` and `confirm` carry the enrollment returned by the API;
 *   `codes` carries the recovery codes). "On the codes step but no codes" or "on the scan step without a QR" cannot be
 *   represented, so the template never has to handle them. Transitions are methods (`start`, `toConfirm`, `back`,
 *   `confirm`, `finish`) that call `go(next)`; nothing else writes `state`. Compare with a pile of booleans
 *   (`scanning`, `confirming`, `showCodes`…) where two can be true at once.
 * - **`@switch (state().step)` with one `@case` per step.** Only the active step's DOM exists. The step's payload is
 *   read through small `computed()`s (`enrollment`, `codes`) that return `null` / `[]` outside their steps, so the
 *   template stays type-safe without casts.
 * - **Focus management between steps.** After every transition `go()` schedules `afterNextRender()`: once Angular has
 *   rendered the new step it focuses the step's heading (`tabindex="-1"`, so it can take focus without entering the tab
 *   order) — or the code field on step 2. Screen readers then announce the new step, and keyboard users continue from
 *   there instead of from the top of the page.
 * - **`[src]` with a data URL.** The QR code arrives as `data:image/png;base64,…`. Angular sanitizes every URL bound
 *   into `[src]`/`[href]`; image data URLs are allowed by its URL sanitizer (only script-capable schemes such as
 *   `javascript:` are neutralised), so no `DomSanitizer.bypassSecurityTrust…` is needed — and none should be: bypass
 *   is for values you have proven safe yourself. `qrSrc` additionally renders the image only when the value really
 *   is a PNG data URL (defence in depth: the page never loads an arbitrary URL the API might send).
 * - **The secret in groups of four** (`groupSecret`) for typing by hand, `dir="ltr"` so it never mirrors in Arabic.
 */
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  type ElementRef,
  Injector,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import { MfaApi } from '../../core/auth/mfa-api';
import type { MfaEnrollment } from '../../core/auth/mfa.models';
import { normalizeTotp, totpCode } from '../../core/auth/one-time-code';
import { copyText } from '../../core/browser/clipboard';
import { type FormMessage, problemToForm } from '../../core/http/problem-form';
import { RecoveryCodes } from './recovery-codes';
import { MFA_CODE_SLUGS } from './security-forms';

/** The wizard's states. Each step carries the data it needs — nothing more. */
export type WizardState =
  | { readonly step: 'intro' }
  | { readonly step: 'scan'; readonly enrollment: MfaEnrollment }
  | { readonly step: 'confirm'; readonly enrollment: MfaEnrollment }
  | { readonly step: 'codes'; readonly codes: readonly string[] };

export type WizardStep = WizardState['step'];

/** The numbered steps shown in the progress list (intro is not numbered). */
export const NUMBERED_STEPS: readonly WizardStep[] = ['scan', 'confirm', 'codes'];

/** `JBSWY3DPEHPK3PXP` → `JBSW Y3DP EHPK 3PXP`. */
export function groupSecret(secret: string): string {
  return secret.match(/.{1,4}/g)?.join(' ') ?? secret;
}

const PNG_DATA_URL = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;

@Component({
  selector: 'app-mfa-enroll-wizard',
  imports: [TranslocoDirective, ReactiveFormsModule, RecoveryCodes],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './mfa-enroll-wizard.html',
  styleUrl: './security.css',
})
export class MfaEnrollWizard {
  private readonly api = inject(MfaApi);
  private readonly injector = inject(Injector);

  /** False when the company requires two-step sign-in: there is nothing to go back to. */
  readonly cancellable = input(true);
  /** Enrollment confirmed and the codes saved. */
  readonly finished = output<void>();
  readonly cancelled = output<void>();

  protected readonly state = signal<WizardState>({ step: 'intro' });
  protected readonly busy = signal(false);
  protected readonly error = signal<FormMessage | null>(null);
  protected readonly secretCopied = signal<boolean | null>(null);
  protected readonly codesSaved = signal(false);
  protected readonly numberedSteps = NUMBERED_STEPS;

  /** Payload of the scan/confirm steps. */
  protected readonly enrollment = computed(() => {
    const state = this.state();
    return state.step === 'scan' || state.step === 'confirm' ? state.enrollment : null;
  });
  protected readonly codes = computed(() => {
    const state = this.state();
    return state.step === 'codes' ? state.codes : [];
  });
  protected readonly qrSrc = computed(() => {
    const qr = this.enrollment()?.qrPng;
    return qr && PNG_DATA_URL.test(qr) ? qr : null;
  });
  protected readonly groupedSecret = computed(() => groupSecret(this.enrollment()?.secret ?? ''));
  /** 1-based position among the numbered steps (0 on intro). */
  protected readonly stepNumber = computed(() => NUMBERED_STEPS.indexOf(this.state().step) + 1);

  protected readonly form = inject(NonNullableFormBuilder).group({
    code: ['', [Validators.required, totpCode]],
  });

  private readonly stepHeading = viewChild<ElementRef<HTMLElement>>('stepHeading');
  private readonly codeInput = viewChild<ElementRef<HTMLInputElement>>('codeInput');

  /** intro → scan: `POST /me/mfa/enroll/start` (a new pending secret each time). */
  protected start(): void {
    this.error.set(null);
    this.busy.set(true);
    this.api.startEnrollment().subscribe({
      next: (enrollment) => {
        this.busy.set(false);
        this.go({ step: 'scan', enrollment });
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.error.set(problemToForm(this.form, error, MFA_CODE_SLUGS));
      },
    });
  }

  /** scan → confirm. */
  protected toConfirm(): void {
    const enrollment = this.enrollment();
    if (!enrollment) return;
    this.form.reset();
    this.go({ step: 'confirm', enrollment });
  }

  /** confirm → scan (the same secret: nothing to re-fetch). */
  protected back(): void {
    const enrollment = this.enrollment();
    if (!enrollment) return;
    this.go({ step: 'scan', enrollment });
  }

  /** confirm → codes: `POST /me/mfa/enroll/confirm {code}`. */
  protected confirm(): void {
    this.error.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.busy.set(true);
    this.api.confirmEnrollment(normalizeTotp(this.form.getRawValue().code)).subscribe({
      next: ({ recoveryCodes }) => {
        this.busy.set(false);
        this.codesSaved.set(false);
        this.go({ step: 'codes', codes: recoveryCodes });
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.form.controls.code.setValue('');
        this.error.set(problemToForm(this.form, error, MFA_CODE_SLUGS));
        this.focusAfterRender(() => this.codeInput());
      },
    });
  }

  /** codes → done. The button is disabled until "I have saved them" is ticked; this re-checks. */
  protected finish(): void {
    if (this.state().step !== 'codes' || !this.codesSaved()) return;
    this.finished.emit();
  }

  protected async copySecret(): Promise<void> {
    const secret = this.enrollment()?.secret;
    if (!secret) return;
    this.secretCopied.set(await copyText(secret));
  }

  private go(next: WizardState): void {
    this.error.set(null);
    this.secretCopied.set(null);
    this.state.set(next);
    this.focusAfterRender(() => (next.step === 'confirm' ? this.codeInput() : this.stepHeading()));
  }

  private focusAfterRender(target: () => ElementRef<HTMLElement> | undefined): void {
    afterNextRender(() => target()?.nativeElement.focus(), { injector: this.injector });
  }
}
