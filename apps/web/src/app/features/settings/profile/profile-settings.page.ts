/**
 * /settings/profile — how employees' profile changes are handled (`profile.configure`, company-wide): contact,
 * emergency contact and family each applied at once or sent to HR for approval, and how long the files of refused or
 * cancelled requests are kept. Bank changes and identity notes always need approval (not configurable).
 */
import { ChangeDetectionStrategy, Component, effect, inject, signal, untracked } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import { type FormMessage, problemToForm } from '../../../core/http/problem-form';
import { ProfileApi } from '../../../core/profile/profile-api';
import {
  type ConfigurableSection,
  FILE_RETENTION_MAX,
  FILE_RETENTION_MIN,
  type ProfileMode,
  type ProfileSettings,
} from '../../../core/profile/profile.models';
import { RevealAlert } from '../../../shared/reveal-alert/reveal-alert.directive';
import { SettingsNav } from '../settings-nav';

const MODES: readonly ProfileMode[] = ['immediate', 'approval'];

@Component({
  selector: 'app-profile-settings-page',
  imports: [TranslocoDirective, ReactiveFormsModule, RevealAlert, SettingsNav],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-container *transloco="let t">
      <app-settings-nav />
      <h2 id="profile-settings-title">{{ t('profile.settings.title') }}</h2>
      <p class="muted">{{ t('profile.settings.intro') }}</p>

      @if (settings.error() && !settings.hasValue()) {
        <div class="form-error" role="alert" data-error="load">
          <p>{{ t('profile.settings.loadError') }}</p>
          <button class="btn secondary" type="button" (click)="settings.reload()">{{ t('common.retry') }}</button>
        </div>
      } @else if (settings.hasValue()) {
        @let c = form.controls;
        <form [formGroup]="form" (ngSubmit)="save()" novalidate aria-labelledby="profile-settings-title" data-form="profile-settings">
          @if (feedback(); as key) {
            <p class="feedback" role="status">{{ t(key) }}</p>
          }
          @if (formError(); as error) {
            <p class="form-error" role="alert" [appRevealAlert]="error">{{ 'key' in error ? t(error.key) : error.text }}</p>
          }
          @for (row of rows; track row.control) {
            <fieldset class="field">
              <legend>{{ t('profile.sections.' + row.section) }}</legend>
              <div class="radios">
                @for (mode of modes; track mode) {
                  <div class="check">
                    <input type="radio" [id]="row.control + '-' + mode" [formControlName]="row.control" [value]="mode" />
                    <label [for]="row.control + '-' + mode">{{ t('profile.settings.modes.' + mode) }}</label>
                  </div>
                }
              </div>
            </fieldset>
          }
          <p class="field-hint">{{ t('profile.settings.alwaysApproval') }}</p>
          <div class="field">
            <label for="profile-retention">{{ t('profile.settings.retention') }}</label>
            <input id="profile-retention" type="number" inputmode="numeric" formControlName="fileRetentionDays" [min]="min" [max]="max" required
              [attr.aria-invalid]="c.fileRetentionDays.invalid && c.fileRetentionDays.touched" aria-describedby="profile-retention-hint profile-retention-error" />
            <p class="field-hint" id="profile-retention-hint">{{ t('profile.settings.retentionHint', { min: min, max: max }) }}</p>
            @if (c.fileRetentionDays.invalid && c.fileRetentionDays.touched) {
              <p class="field-error" id="profile-retention-error">{{ c.fileRetentionDays.getError('server') ?? t('profile.settings.retentionError', { min: min, max: max }) }}</p>
            }
          </div>
          <div class="form-actions">
            <button class="btn" type="submit" data-action="save" [disabled]="saving()">{{ saving() ? t('profile.settings.saving') : t('common.save') }}</button>
          </div>
        </form>
      } @else {
        <p class="muted">{{ t('common.loading') }}</p>
      }
    </ng-container>
  `,
  styles: `
    h2 { margin-block: 0 var(--space-2); font-size: 1.25rem; }
    form { max-inline-size: 40rem; }
    fieldset { margin: 0 0 var(--space-3); padding: 0; border: 0; }
    legend { font-weight: 600; margin-block-end: var(--space-1); }
    .radios { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-4); }
    input[type='number'] { max-inline-size: 8rem; }
  `,
})
export class ProfileSettingsPage {
  private readonly api = inject(ProfileApi);
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly settings = this.api.settingsResource();
  protected readonly modes = MODES;
  protected readonly min = FILE_RETENTION_MIN;
  protected readonly max = FILE_RETENTION_MAX;
  protected readonly rows: readonly { section: ConfigurableSection; control: 'contactMode' | 'emergencyMode' | 'familyMode' }[] = [
    { section: 'contact', control: 'contactMode' },
    { section: 'emergency', control: 'emergencyMode' },
    { section: 'family', control: 'familyMode' },
  ];

  protected readonly form = this.fb.group({
    contactMode: this.fb.control<ProfileMode>('immediate'),
    emergencyMode: this.fb.control<ProfileMode>('immediate'),
    familyMode: this.fb.control<ProfileMode>('approval'),
    fileRetentionDays: [30, [Validators.required, Validators.min(FILE_RETENTION_MIN), Validators.max(FILE_RETENTION_MAX)]],
  });
  protected readonly saving = signal(false);
  protected readonly feedback = signal<string | null>(null);
  protected readonly formError = signal<FormMessage | null>(null);

  constructor() {
    effect(() => {
      if (!this.settings.hasValue()) return;
      const value = this.settings.value();
      untracked(() => this.form.reset(value));
    });
  }

  protected save(): void {
    this.feedback.set(null);
    this.formError.set(null);
    const days = this.form.controls.fileRetentionDays.value;
    if (this.form.invalid || !Number.isInteger(days)) {
      this.form.markAllAsTouched();
      return;
    }
    const body: ProfileSettings = this.form.getRawValue();
    this.saving.set(true);
    this.api.updateSettings(body).subscribe({
      next: (saved) => {
        this.saving.set(false);
        this.form.reset(saved);
        this.feedback.set('profile.settings.saved');
      },
      error: (error: unknown) => {
        this.saving.set(false);
        this.formError.set(problemToForm(this.form, error, {}));
      },
    });
  }
}
