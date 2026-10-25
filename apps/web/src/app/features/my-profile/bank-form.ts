import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import { blankToNull, type MyProfileView, normaliseRib, PROFILE_LIMITS, type ProfileRequestView } from '../../core/profile/profile.models';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';
import { ProfileFieldError } from './profile-field-error';
import { acceptedFiles, notBlank, RequestSubmission, rib } from './profile-forms';
import { RequestFooter } from './request-footer';

/** A new RIB: always central-HR approval with a RIB document (contract assumption 3). */
@Component({
  selector: 'app-profile-bank-form',
  imports: [TranslocoDirective, ReactiveFormsModule, RevealAlert, ProfileFieldError, RequestFooter],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form *transloco="let t" [formGroup]="form" (ngSubmit)="submit()" novalidate data-form="bank" [attr.aria-label]="t('profile.sections.bank')">
      <p class="mode-note" data-field="mode">{{ t('profile.mode.bankApproval') }}</p>
      @if (submission.formError(); as error) {
        <p class="form-error" role="alert" data-error="form" [appRevealAlert]="error">{{ 'key' in error ? t(error.key) : error.text }}</p>
      }
      @let p = form.controls.payload.controls;
      <div class="field">
        <label for="bank-rib">{{ t('profile.fields.rib') }}</label>
        <input id="bank-rib" type="text" inputmode="numeric" autocomplete="off" dir="ltr" required [formControl]="p.rib" maxlength="29"
          [attr.aria-invalid]="p.rib.invalid && p.rib.touched" aria-describedby="bank-rib-hint bank-rib-error" />
        <p class="field-hint" id="bank-rib-hint">{{ t('profile.form.ribHint') }}</p>
        <app-profile-field-error [control]="p.rib" errorId="bank-rib-error" />
      </div>
      <div class="field">
        <label for="bank-name">{{ t('profile.fields.bankName') }}</label>
        <input id="bank-name" type="text" dir="auto" required [formControl]="p.bankName" [attr.maxlength]="limits.bankName"
          [attr.aria-invalid]="p.bankName.invalid && p.bankName.touched" aria-describedby="bank-name-error" />
        <app-profile-field-error [control]="p.bankName" errorId="bank-name-error" />
      </div>
      <app-request-footer [submission]="submission" mode="approval" idPrefix="bank" [comment]="form.controls.comment" [files]="form.controls.files"
        [filesRequired]="true" filesHintKey="profile.files.hintBank" (closed)="closed.emit()" />
    </form>
  `,
  styles: `
    .mode-note { margin-block: 0 var(--space-3); padding: var(--space-2) var(--space-3); border-radius: var(--radius); background: var(--color-surface-alt); }
  `,
})
export class ProfileBankForm {
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly submission = new RequestSubmission();
  protected readonly limits = PROFILE_LIMITS;

  readonly profile = input.required<MyProfileView>();
  readonly done = output<ProfileRequestView>();
  readonly closed = output<void>();

  protected readonly form = this.fb.group({
    payload: this.fb.group({
      rib: ['', [notBlank, rib]],
      bankName: ['', [notBlank, Validators.maxLength(PROFILE_LIMITS.bankName)]],
    }),
    comment: ['', Validators.maxLength(PROFILE_LIMITS.comment)],
    files: this.fb.control<File[]>([], acceptedFiles),
  });

  protected submit(): void {
    const files = this.form.controls.files;
    if (files.value.length === 0) {
      files.setErrors({ filesRequired: true });
      files.markAsTouched();
    }
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const v = this.form.controls.payload.getRawValue();
    const comment = blankToNull(this.form.controls.comment.value);
    this.submission.submit(
      this.form,
      { section: 'bank', payload: { rib: normaliseRib(v.rib), bankName: v.bankName.trim() }, ...(comment ? { comment } : {}) },
      files.value,
      (r) => this.done.emit(r),
    );
  }
}
