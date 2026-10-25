import { ChangeDetectionStrategy, Component, computed, inject, input, type OnInit, output } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import {
  blankToNull,
  type EmergencyInput,
  type MyProfileView,
  PROFILE_LIMITS,
  type ProfileRequestView,
  type Relationship,
  RELATIONSHIPS,
  sectionMode,
} from '../../core/profile/profile.models';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';
import { ProfileFieldError } from './profile-field-error';
import { acceptedFiles, notBlank, phone, RequestSubmission } from './profile-forms';
import { RequestFooter } from './request-footer';

@Component({
  selector: 'app-profile-emergency-form',
  imports: [TranslocoDirective, ReactiveFormsModule, RevealAlert, ProfileFieldError, RequestFooter],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form *transloco="let t" [formGroup]="form" (ngSubmit)="submit()" novalidate data-form="emergency" [attr.aria-label]="t('profile.sections.emergency')">
      <p class="mode-note" data-field="mode">{{ t('profile.mode.' + mode()) }}</p>
      @if (submission.formError(); as error) {
        <p class="form-error" role="alert" data-error="form" [appRevealAlert]="error">{{ 'key' in error ? t(error.key) : error.text }}</p>
      }
      @let p = form.controls.payload.controls;
      <div class="field">
        <label for="emergency-name">{{ t('profile.fields.fullName') }}</label>
        <input id="emergency-name" type="text" autocomplete="off" dir="auto" required [formControl]="p.fullName" [attr.maxlength]="limits.fullName"
          [attr.aria-invalid]="p.fullName.invalid && p.fullName.touched" aria-describedby="emergency-name-error" />
        <app-profile-field-error [control]="p.fullName" errorId="emergency-name-error" />
      </div>
      <div class="grid">
        <div class="field">
          <label for="emergency-relationship">{{ t('profile.fields.relationship') }}</label>
          <select id="emergency-relationship" required [formControl]="p.relationship"
            [attr.aria-invalid]="p.relationship.invalid && p.relationship.touched" aria-describedby="emergency-relationship-error">
            <option value="" disabled>{{ t('profile.form.choose') }}</option>
            @for (r of relationships; track r) {
              <option [value]="r">{{ t('profile.relationship.' + r) }}</option>
            }
          </select>
          <app-profile-field-error [control]="p.relationship" errorId="emergency-relationship-error" />
        </div>
        <div class="field">
          <label for="emergency-phone">{{ t('profile.fields.phone') }}</label>
          <input id="emergency-phone" type="tel" inputmode="tel" dir="ltr" required [formControl]="p.phone"
            [attr.aria-invalid]="p.phone.invalid && p.phone.touched" aria-describedby="emergency-phone-hint emergency-phone-error" />
          <p class="field-hint" id="emergency-phone-hint">{{ t('profile.form.phoneHint') }}</p>
          <app-profile-field-error [control]="p.phone" errorId="emergency-phone-error" />
        </div>
      </div>
      <app-request-footer [submission]="submission" [mode]="mode()" idPrefix="emergency" [comment]="form.controls.comment" [files]="form.controls.files" (closed)="closed.emit()" />
      @if (profile().personal.emergencyContact && !submission.busy()) {
        <p>
          <button class="btn danger" type="button" data-action="remove-emergency" (click)="remove()">{{ t('profile.emergency.remove') }}</button>
        </p>
      }
    </form>
  `,
  styles: `
    .mode-note { margin-block: 0 var(--space-3); padding: var(--space-2) var(--space-3); border-radius: var(--radius); background: var(--color-surface-alt); }
  `,
})
export class ProfileEmergencyForm implements OnInit {
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly submission = new RequestSubmission();
  protected readonly limits = PROFILE_LIMITS;
  protected readonly relationships = RELATIONSHIPS;

  readonly profile = input.required<MyProfileView>();
  readonly done = output<ProfileRequestView>();
  readonly closed = output<void>();
  protected readonly mode = computed(() => sectionMode(this.profile().modes, 'emergency'));

  protected readonly form = this.fb.group({
    payload: this.fb.group({
      fullName: ['', [notBlank, Validators.maxLength(PROFILE_LIMITS.fullName)]],
      relationship: this.fb.control<Relationship | ''>('', Validators.required),
      phone: ['', [notBlank, phone]],
    }),
    comment: ['', Validators.maxLength(PROFILE_LIMITS.comment)],
    files: this.fb.control<File[]>([], acceptedFiles),
  });

  ngOnInit(): void {
    const current = this.profile().personal.emergencyContact;
    if (current) this.form.controls.payload.setValue({ fullName: current.fullName, relationship: current.relationship, phone: current.phone });
  }

  protected submit(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const v = this.form.controls.payload.getRawValue();
    if (v.relationship === '') return;
    const payload: EmergencyInput = { fullName: v.fullName.trim(), relationship: v.relationship, phone: v.phone.trim() };
    const current = this.profile().personal.emergencyContact;
    if (current && current.fullName === payload.fullName && current.relationship === payload.relationship && current.phone === payload.phone) {
      this.submission.formError.set({ key: 'profile.problems.unchanged' });
      return;
    }
    this.send(payload);
  }

  /** No emergency contact any more (`payload: null`). */
  protected remove(): void {
    this.send(null);
  }

  private send(payload: EmergencyInput | null): void {
    const approval = this.mode() === 'approval';
    const comment = blankToNull(this.form.controls.comment.value);
    this.submission.submit(
      this.form,
      { section: 'emergency', payload, ...(comment && approval ? { comment } : {}) },
      approval ? this.form.controls.files.value : [],
      (r) => this.done.emit(r),
    );
  }
}
