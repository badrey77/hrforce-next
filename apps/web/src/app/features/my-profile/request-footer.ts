import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';
import { type FormControl, ReactiveFormsModule } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import { LanguageService } from '../../core/i18n/language.service';
import { PROFILE_LIMITS, type ProfileMode } from '../../core/profile/profile.models';
import { FileSizePipe } from '../../shared/file-size/file-size.pipe';
import { ProfileFieldError } from './profile-field-error';
import { ProfileFiles } from './profile-files';
import type { RequestSubmission } from './profile-forms';

/**
 * The end of every « Mon profil » section form: the comment and the supporting documents (approval sections only),
 * the upload progress, and the buttons — « Enregistrer » for an immediate change, « Envoyer aux RH » otherwise.
 */
@Component({
  selector: 'app-request-footer',
  imports: [TranslocoDirective, ReactiveFormsModule, ProfileFiles, ProfileFieldError, FileSizePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-container *transloco="let t">
      @let busy = submission().busy();
      @if (mode() === 'approval') {
        @if (comment(); as c) {
          <div class="field">
            <label [for]="idPrefix() + '-comment'">{{ t('profile.fields.comment') }} <span class="muted">({{ t('profile.files.optional') }})</span></label>
            <textarea [id]="idPrefix() + '-comment'" rows="2" dir="auto" [formControl]="c" [attr.maxlength]="commentMax"
              [attr.aria-invalid]="c.invalid && c.touched" [attr.aria-describedby]="idPrefix() + '-comment-hint ' + idPrefix() + '-comment-error'"></textarea>
            <p class="field-hint" [id]="idPrefix() + '-comment-hint'">{{ t('profile.form.commentHint') }}</p>
            <app-profile-field-error [control]="c" [errorId]="idPrefix() + '-comment-error'" />
          </div>
        }
        @if (files(); as f) {
          <app-profile-files [control]="f" [idPrefix]="idPrefix()" [hintKey]="filesHintKey()" [required]="filesRequired()" [disabled]="busy" />
        }
      }
      @if (submission().progress(); as p) {
        <div class="upload-progress" data-state="uploading">
          <label [for]="idPrefix() + '-progress'">{{ t('profile.upload.sending') }}</label>
          <progress [id]="idPrefix() + '-progress'" max="100" [attr.value]="submission().percent()"></progress>
          @if (submission().percent() !== null && p.total) {
            <span class="field-hint" data-field="percent">{{
              t('profile.upload.percent', { percent: submission().percent(), loaded: (p.loaded | fileSize: lang()), total: (p.total | fileSize: lang()) })
            }}</span>
          }
        </div>
      }
      <div class="form-actions">
        <button class="btn" type="submit" data-action="submit" [disabled]="busy">
          {{ busy ? t('profile.actions.sending') : mode() === 'immediate' ? t('profile.actions.save') : t('profile.actions.send') }}
        </button>
        @if (busy) {
          <button class="btn secondary" type="button" data-action="abort" (click)="submission().abort()">{{ t('profile.actions.abort') }}</button>
        } @else {
          <button class="btn secondary" type="button" data-action="close" (click)="closed.emit()">{{ t('common.cancel') }}</button>
        }
      </div>
    </ng-container>
  `,
  styles: `
    :host { display: block; }
    .upload-progress { display: grid; gap: var(--space-1); margin-block-end: var(--space-3); }
    progress { inline-size: 100%; }
    textarea { inline-size: 100%; }
  `,
})
export class RequestFooter {
  protected readonly lang = inject(LanguageService).current;
  protected readonly commentMax = PROFILE_LIMITS.comment;

  readonly submission = input.required<RequestSubmission>();
  readonly mode = input.required<ProfileMode>();
  readonly idPrefix = input.required<string>();
  readonly comment = input<FormControl<string> | null>(null);
  readonly files = input<FormControl<File[]> | null>(null);
  readonly filesRequired = input(false);
  readonly filesHintKey = input<string | null>(null);
  readonly closed = output<void>();
}
