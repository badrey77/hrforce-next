/**
 * The HR forms of the « Coordonnées et famille » tab for contact details and the emergency contact
 * (`PUT /employees/:id/contact`, `PUT /employees/:id/emergency-contact`; profile-changes contract › Employment additions):
 *   <app-contact-form [employmentId]="e.id" [contact]="p.contact" (saved)="…" (cancelled)="…" />
 *   <app-emergency-form [employmentId]="e.id" [emergency]="p.emergencyContact" (saved)="…" (cancelled)="…" />
 * `saved` carries the translation key of the feedback to show.
 */
import { ChangeDetectionStrategy, Component, inject, input, type OnInit, output, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import type { FormMessage } from '../../core/http/problem-form';
import { LanguageService } from '../../core/i18n/language.service';
import { ProfileApi } from '../../core/profile/profile-api';
import {
  type ContactView,
  type EmergencyContactView,
  PROFILE_LIMITS,
  type Relationship,
  RELATIONSHIPS,
} from '../../core/profile/profile.models';
import { WILAYAS } from '../../core/profile/wilayas';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';
import { employeeProblemToForm } from './employee-forms';
import { FieldError } from './field-error';
import { contactBody, email, emergencyBody, emergencyComplete, PERSONAL_CODE_KEYS, PERSONAL_SLUGS, phone, postalCode } from './personal-forms';

@Component({
  selector: 'app-contact-form',
  imports: [ReactiveFormsModule, TranslocoDirective, FieldError, RevealAlert],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './contact-form.html',
  styleUrl: './employees.css',
})
export class ContactForm implements OnInit {
  private readonly api = inject(ProfileApi);
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly lang = inject(LanguageService).current;

  readonly employmentId = input.required<string>();
  readonly contact = input.required<ContactView>();
  readonly saved = output<string>();
  readonly cancelled = output<void>();

  protected readonly limits = PROFILE_LIMITS;
  protected readonly wilayas = WILAYAS;
  protected readonly submitting = signal(false);
  protected readonly formError = signal<FormMessage | null>(null);

  protected readonly form = this.fb.group({
    mobilePhone: ['', [phone]],
    otherPhone: ['', [phone]],
    personalEmail: ['', [email, Validators.maxLength(PROFILE_LIMITS.email)]],
    addressLine: ['', [Validators.maxLength(PROFILE_LIMITS.addressLine)]],
    commune: ['', [Validators.maxLength(PROFILE_LIMITS.commune)]],
    wilayaCode: [''],
    postalCode: ['', [postalCode]],
  });

  ngOnInit(): void {
    const c = this.contact();
    this.form.reset({
      mobilePhone: c.mobilePhone ?? '',
      otherPhone: c.otherPhone ?? '',
      personalEmail: c.personalEmail ?? '',
      addressLine: c.addressLine ?? '',
      commune: c.commune ?? '',
      wilayaCode: c.wilayaCode ?? '',
      postalCode: c.postalCode ?? '',
    });
  }

  protected wilayaName(w: (typeof WILAYAS)[number]): string {
    const lang = this.lang();
    return lang === 'ar' ? w.ar : lang === 'en' ? w.en : w.fr;
  }

  protected submit(): void {
    this.formError.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      this.formError.set({ key: 'employees.create.fixErrors' });
      return;
    }
    this.submitting.set(true);
    this.api.updateContact(this.employmentId(), contactBody(this.form.getRawValue())).subscribe({
      next: () => {
        this.submitting.set(false);
        this.saved.emit('personal.feedback.contactSaved');
      },
      error: (error: unknown) => {
        this.formError.set(employeeProblemToForm(this.form, error, PERSONAL_SLUGS, {}, undefined, PERSONAL_CODE_KEYS));
        this.submitting.set(false);
      },
    });
  }
}

@Component({
  selector: 'app-emergency-form',
  imports: [ReactiveFormsModule, TranslocoDirective, FieldError, RevealAlert],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form *transloco="let t" class="panel" [formGroup]="form" (ngSubmit)="submit()" aria-labelledby="emergency-form-title" novalidate data-form="emergency">
      <h3 id="emergency-form-title">{{ t('personal.sections.emergency') }}</h3>
      @if (formError(); as error) {
        <p class="form-error" role="alert" [appRevealAlert]="error">{{ 'key' in error ? t(error.key) : error.text }}</p>
      }
      <p class="field-hint" id="emergency-hint">{{ t('personal.emergency.clearHint') }}</p>
      @let c = form.controls;
      @let incomplete = form.hasError('emergencyIncomplete') && (c.fullName.touched || c.phone.touched || c.relationship.touched);
      <div class="grid">
        <div class="field">
          <label for="emergency-name">{{ t('personal.fields.fullName') }}</label>
          <input id="emergency-name" type="text" formControlName="fullName" autocomplete="off" dir="auto" [maxlength]="limits.fullName"
            [attr.aria-invalid]="(c.fullName.invalid && c.fullName.touched) || incomplete" aria-describedby="emergency-hint emergency-name-error" />
          <app-field-error [control]="c.fullName" errorId="emergency-name-error" />
        </div>
        <div class="field">
          <label for="emergency-relationship">{{ t('personal.fields.relationship') }}</label>
          <select id="emergency-relationship" formControlName="relationship" [attr.aria-invalid]="incomplete" aria-describedby="emergency-hint">
            <option value="">{{ t('personal.form.none') }}</option>
            @for (r of relationships; track r) {
              <option [value]="r">{{ t('personal.relationship.' + r) }}</option>
            }
          </select>
        </div>
        <div class="field">
          <label for="emergency-phone">{{ t('personal.fields.phone') }}</label>
          <input id="emergency-phone" type="tel" formControlName="phone" autocomplete="off" dir="ltr" inputmode="tel"
            [attr.aria-invalid]="(c.phone.invalid && c.phone.touched) || incomplete" aria-describedby="emergency-phone-hint emergency-phone-error" />
          <p class="field-hint" id="emergency-phone-hint">{{ t('personal.form.phoneHint') }}</p>
          <app-field-error [control]="c.phone" errorId="emergency-phone-error" />
        </div>
      </div>
      @if (incomplete) {
        <p class="field-error" data-error="emergency-incomplete">{{ t('personal.form.errors.emergencyIncomplete') }}</p>
      }
      <div class="form-actions">
        <button class="btn" type="submit" data-action="save-emergency" [disabled]="submitting()">
          {{ submitting() ? t('personal.saving') : t('personal.save') }}
        </button>
        @if (emergency()) {
          <button class="btn secondary" type="button" data-action="clear-emergency" [disabled]="submitting()" (click)="clear()">
            {{ t('personal.emergency.clear') }}
          </button>
        }
        <button class="btn secondary" type="button" (click)="cancelled.emit()">{{ t('common.cancel') }}</button>
      </div>
    </form>
  `,
  styleUrl: './employees.css',
})
export class EmergencyForm implements OnInit {
  private readonly api = inject(ProfileApi);
  private readonly fb = inject(NonNullableFormBuilder);

  readonly employmentId = input.required<string>();
  readonly emergency = input.required<EmergencyContactView | null>();
  readonly saved = output<string>();
  readonly cancelled = output<void>();

  protected readonly limits = PROFILE_LIMITS;
  protected readonly relationships = RELATIONSHIPS;
  protected readonly submitting = signal(false);
  protected readonly formError = signal<FormMessage | null>(null);

  protected readonly form = this.fb.group(
    {
      fullName: ['', [Validators.maxLength(PROFILE_LIMITS.fullName)]],
      relationship: this.fb.control<Relationship | ''>(''),
      phone: ['', [phone]],
    },
    { validators: emergencyComplete },
  );

  ngOnInit(): void {
    const e = this.emergency();
    this.form.reset({ fullName: e?.fullName ?? '', relationship: e?.relationship ?? '', phone: e?.phone ?? '' });
  }

  protected clear(): void {
    this.form.reset({ fullName: '', relationship: '', phone: '' });
    this.submit();
  }

  protected submit(): void {
    this.formError.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      this.formError.set({ key: 'employees.create.fixErrors' });
      return;
    }
    const body = emergencyBody(this.form.getRawValue());
    this.submitting.set(true);
    this.api.updateEmergencyContact(this.employmentId(), body).subscribe({
      next: () => {
        this.submitting.set(false);
        this.saved.emit(body ? 'personal.feedback.emergencySaved' : 'personal.feedback.emergencyCleared');
      },
      error: (error: unknown) => {
        this.formError.set(employeeProblemToForm(this.form, error, PERSONAL_SLUGS, {}, undefined, PERSONAL_CODE_KEYS));
        this.submitting.set(false);
      },
    });
  }
}
