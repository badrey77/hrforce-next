import { ChangeDetectionStrategy, Component, inject, output } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import { PROFILE_LIMITS, type ProfileRequestView } from '../../core/profile/profile.models';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';
import { ProfileFieldError } from './profile-field-error';
import { acceptedFiles, notBlank, RequestSubmission } from './profile-forms';
import { RequestFooter } from './request-footer';

/** « Signaler une erreur »: a note to HR about the identity data (section `identity_note`, nothing applied). */
@Component({
  selector: 'app-profile-identity-note-form',
  imports: [TranslocoDirective, ReactiveFormsModule, RevealAlert, ProfileFieldError, RequestFooter],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form *transloco="let t" [formGroup]="form" (ngSubmit)="submit()" novalidate data-form="identity_note" [attr.aria-label]="t('profile.identity.report')">
      <p class="mode-note" data-field="mode">{{ t('profile.mode.identityNote') }}</p>
      @if (submission.formError(); as error) {
        <p class="form-error" role="alert" data-error="form" [appRevealAlert]="error">{{ 'key' in error ? t(error.key) : error.text }}</p>
      }
      @let note = form.controls.payload.controls.note;
      <div class="field">
        <label for="identity-note">{{ t('profile.identity.noteLabel') }}</label>
        <textarea id="identity-note" rows="4" dir="auto" required [formControl]="note" [attr.maxlength]="noteMax"
          [attr.aria-invalid]="note.invalid && note.touched" aria-describedby="identity-note-hint identity-note-error"></textarea>
        <p class="field-hint" id="identity-note-hint">{{ t('profile.identity.noteHint', { max: noteMax }) }}</p>
        <app-profile-field-error [control]="note" errorId="identity-note-error" />
      </div>
      <app-request-footer [submission]="submission" mode="approval" idPrefix="identity" [files]="form.controls.files" (closed)="closed.emit()" />
    </form>
  `,
  styles: `
    .mode-note { margin-block: 0 var(--space-3); padding: var(--space-2) var(--space-3); border-radius: var(--radius); background: var(--color-surface-alt); }
    textarea { inline-size: 100%; }
  `,
})
export class ProfileIdentityNoteForm {
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly submission = new RequestSubmission();
  protected readonly noteMax = PROFILE_LIMITS.note;

  readonly done = output<ProfileRequestView>();
  readonly closed = output<void>();

  protected readonly form = this.fb.group({
    payload: this.fb.group({ note: ['', [notBlank, Validators.maxLength(PROFILE_LIMITS.note)]] }),
    files: this.fb.control<File[]>([], acceptedFiles),
  });

  protected submit(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.submission.submit(
      this.form,
      { section: 'identity_note', payload: { note: this.form.controls.payload.controls.note.value.trim() } },
      this.form.controls.files.value,
      (r) => this.done.emit(r),
    );
  }
}
