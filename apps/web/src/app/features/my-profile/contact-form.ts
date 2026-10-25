import { ChangeDetectionStrategy, Component, computed, inject, input, type OnInit, output } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import { LanguageService } from '../../core/i18n/language.service';
import {
  blankToNull,
  changedKeys,
  type ContactInput,
  type MyProfileView,
  PROFILE_LIMITS,
  type ProfileRequestView,
  sectionMode,
} from '../../core/profile/profile.models';
import { WILAYAS, wilayaLabel } from '../../core/profile/wilayas';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';
import { ProfileFieldError } from './profile-field-error';
import { acceptedFiles, email, phone, postalCode, RequestSubmission } from './profile-forms';
import { RequestFooter } from './request-footer';

@Component({
  selector: 'app-profile-contact-form',
  imports: [TranslocoDirective, ReactiveFormsModule, RevealAlert, ProfileFieldError, RequestFooter],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form *transloco="let t" [formGroup]="form" (ngSubmit)="submit()" novalidate data-form="contact" [attr.aria-label]="t('profile.sections.contact')">
      <p class="mode-note" data-field="mode">{{ t('profile.mode.' + mode()) }}</p>
      @if (submission.formError(); as error) {
        <p class="form-error" role="alert" data-error="form" [appRevealAlert]="error">{{ 'key' in error ? t(error.key) : error.text }}</p>
      }
      @let p = form.controls.payload.controls;
      <div class="grid">
        <div class="field">
          <label for="contact-mobile">{{ t('profile.fields.mobilePhone') }}</label>
          <input id="contact-mobile" type="tel" inputmode="tel" autocomplete="tel" dir="ltr" [formControl]="p.mobilePhone"
            [attr.aria-invalid]="p.mobilePhone.invalid && p.mobilePhone.touched" aria-describedby="contact-phone-hint contact-mobile-error" />
          <app-profile-field-error [control]="p.mobilePhone" errorId="contact-mobile-error" />
        </div>
        <div class="field">
          <label for="contact-other">{{ t('profile.fields.otherPhone') }}</label>
          <input id="contact-other" type="tel" inputmode="tel" dir="ltr" [formControl]="p.otherPhone"
            [attr.aria-invalid]="p.otherPhone.invalid && p.otherPhone.touched" aria-describedby="contact-phone-hint contact-other-error" />
          <app-profile-field-error [control]="p.otherPhone" errorId="contact-other-error" />
        </div>
      </div>
      <p class="field-hint" id="contact-phone-hint">{{ t('profile.form.phoneHint') }}</p>
      <div class="field">
        <label for="contact-email">{{ t('profile.fields.personalEmail') }}</label>
        <input id="contact-email" type="email" inputmode="email" autocomplete="email" dir="ltr" [formControl]="p.personalEmail" [attr.maxlength]="limits.email"
          [attr.aria-invalid]="p.personalEmail.invalid && p.personalEmail.touched" aria-describedby="contact-email-error" />
        <app-profile-field-error [control]="p.personalEmail" errorId="contact-email-error" />
      </div>
      <div class="field">
        <label for="contact-address">{{ t('profile.fields.addressLine') }}</label>
        <input id="contact-address" type="text" autocomplete="street-address" dir="auto" [formControl]="p.addressLine" [attr.maxlength]="limits.addressLine"
          [attr.aria-invalid]="p.addressLine.invalid && p.addressLine.touched" aria-describedby="contact-address-error" />
        <app-profile-field-error [control]="p.addressLine" errorId="contact-address-error" />
      </div>
      <div class="grid">
        <div class="field">
          <label for="contact-commune">{{ t('profile.fields.commune') }}</label>
          <input id="contact-commune" type="text" autocomplete="address-level2" dir="auto" [formControl]="p.commune" [attr.maxlength]="limits.commune"
            [attr.aria-invalid]="p.commune.invalid && p.commune.touched" aria-describedby="contact-commune-error" />
          <app-profile-field-error [control]="p.commune" errorId="contact-commune-error" />
        </div>
        <div class="field">
          <label for="contact-wilaya">{{ t('profile.fields.wilayaCode') }}</label>
          <select id="contact-wilaya" [formControl]="p.wilayaCode" aria-describedby="contact-wilaya-error">
            <option value="">{{ t('profile.form.wilayaPlaceholder') }}</option>
            @for (w of wilayas; track w.code) {
              <option [value]="w.code">{{ wilayaName(w.code) }}</option>
            }
          </select>
          <app-profile-field-error [control]="p.wilayaCode" errorId="contact-wilaya-error" />
        </div>
        <div class="field">
          <label for="contact-postal">{{ t('profile.fields.postalCode') }}</label>
          <input id="contact-postal" type="text" inputmode="numeric" autocomplete="postal-code" dir="ltr" maxlength="5" [formControl]="p.postalCode"
            [attr.aria-invalid]="p.postalCode.invalid && p.postalCode.touched" aria-describedby="contact-postal-error" />
          <app-profile-field-error [control]="p.postalCode" errorId="contact-postal-error" />
        </div>
      </div>
      <app-request-footer [submission]="submission" [mode]="mode()" idPrefix="contact" [comment]="form.controls.comment" [files]="form.controls.files" (closed)="closed.emit()" />
    </form>
  `,
  styles: `
    .mode-note { margin-block: 0 var(--space-3); padding: var(--space-2) var(--space-3); border-radius: var(--radius); background: var(--color-surface-alt); }
  `,
})
export class ProfileContactForm implements OnInit {
  private readonly fb = inject(NonNullableFormBuilder);
  private readonly lang = inject(LanguageService).current;
  protected readonly submission = new RequestSubmission();
  protected readonly limits = PROFILE_LIMITS;
  protected readonly wilayas = WILAYAS;

  readonly profile = input.required<MyProfileView>();
  readonly done = output<ProfileRequestView>();
  readonly closed = output<void>();
  protected readonly mode = computed(() => sectionMode(this.profile().modes, 'contact'));

  protected readonly form = this.fb.group({
    payload: this.fb.group({
      mobilePhone: ['', phone],
      otherPhone: ['', phone],
      personalEmail: ['', email],
      addressLine: ['', Validators.maxLength(PROFILE_LIMITS.addressLine)],
      commune: ['', Validators.maxLength(PROFILE_LIMITS.commune)],
      wilayaCode: [''],
      postalCode: ['', postalCode],
    }),
    comment: ['', Validators.maxLength(PROFILE_LIMITS.comment)],
    files: this.fb.control<File[]>([], acceptedFiles),
  });

  ngOnInit(): void {
    const c = this.profile().personal.contact;
    this.form.controls.payload.setValue({
      mobilePhone: c.mobilePhone ?? '',
      otherPhone: c.otherPhone ?? '',
      personalEmail: c.personalEmail ?? '',
      addressLine: c.addressLine ?? '',
      commune: c.commune ?? '',
      wilayaCode: c.wilayaCode ?? '',
      postalCode: c.postalCode ?? '',
    });
  }

  protected wilayaName(code: string): string {
    return wilayaLabel(code, this.lang());
  }

  protected submit(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const v = this.form.controls.payload.getRawValue();
    const payload: ContactInput = {
      mobilePhone: blankToNull(v.mobilePhone),
      otherPhone: blankToNull(v.otherPhone),
      personalEmail: blankToNull(v.personalEmail),
      addressLine: blankToNull(v.addressLine),
      commune: blankToNull(v.commune),
      wilayaCode: blankToNull(v.wilayaCode),
      postalCode: blankToNull(v.postalCode),
    };
    const { updatedAt: _u, ...current } = this.profile().personal.contact;
    if (changedKeys<ContactInput>(current, payload).length === 0) {
      this.submission.formError.set({ key: 'profile.problems.unchanged' });
      return;
    }
    const comment = blankToNull(this.form.controls.comment.value);
    const files = this.mode() === 'approval' ? this.form.controls.files.value : [];
    this.submission.submit(this.form, { section: 'contact', payload, ...(comment && this.mode() === 'approval' ? { comment } : {}) }, files, (r) => this.done.emit(r));
  }
}
