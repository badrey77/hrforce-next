/**
 * « Calendrier » tab of /payroll/settings: the cut-off day (from which a month may be closed), how many closed months
 * are recomputed for régularisations, and the overtime minimum. Saved with the rest of the settings unchanged.
 */
import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import type { FormMessage } from '../../core/http/problem-form';
import { PayrollApi } from '../../core/payroll/payroll-api';
import { DEFAULT_PAYROLL_SETTINGS, type PayrollSettings, SETTINGS_BOUNDS } from '../../core/payroll/payroll.models';
import { ControlError } from '../../shared/attendance/control-error';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';
import { PAYROLL_ERROR_KEYS, settingsProblemToForm, wholeNumberBetween } from './payroll-settings-forms';

type CalendarField = keyof typeof SETTINGS_BOUNDS;
const FIELDS: readonly CalendarField[] = ['cutoffDay', 'regularizationMonths', 'overtimeMinMinutes'];

@Component({
  selector: 'app-payroll-calendar-settings',
  imports: [TranslocoDirective, ReactiveFormsModule, ControlError, RevealAlert],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './payroll-settings.css',
  template: `
    <section *transloco="let t" aria-labelledby="pay-calendar-title" data-section="calendar">
      <div class="toolbar">
        <h2 id="pay-calendar-title">{{ t('payroll.settings.tab.calendar') }}</h2>
      </div>
      @if (feedback(); as key) {
        <p class="feedback" role="status" data-feedback>{{ t(key) }}</p>
      }
      @if (formError(); as error) {
        <p class="form-error" role="alert" [appRevealAlert]="error">{{ 'key' in error ? t(error.key) : error.text }}</p>
      }
      @if (settings.error()) {
        <div class="form-error" role="alert">
          <p>{{ t('payroll.settings.loadError') }}</p>
          <button class="btn secondary" type="button" (click)="settings.reload()">{{ t('common.retry') }}</button>
        </div>
      } @else if (settings.hasValue()) {
        <form class="panel" [formGroup]="form" (ngSubmit)="save()" novalidate data-form="payroll-calendar">
          @for (f of fields; track f) {
            @let control = form.controls[f];
            <div class="field">
              <label [for]="'cal-' + f">{{ t('payroll.settings.calendar.' + f) }}</label>
              <input [id]="'cal-' + f" type="number" inputmode="numeric" [min]="bounds[f].min" [max]="bounds[f].max" [formControlName]="f"
                [attr.aria-describedby]="'cal-' + f + '-hint cal-' + f + '-error'" [attr.aria-invalid]="control.invalid && control.touched" />
              <p class="field-hint" [id]="'cal-' + f + '-hint'">{{ t('payroll.settings.calendar.hints.' + f, { min: bounds[f].min, max: bounds[f].max }) }}</p>
              <app-control-error [control]="control" [errorId]="'cal-' + f + '-error'" [keys]="errorKeys" />
            </div>
          }
          <div class="form-actions">
            <button class="btn" type="submit" data-action="save-calendar" [disabled]="saving()">{{ t('common.save') }}</button>
          </div>
        </form>
      } @else {
        <p class="muted">{{ t('common.loading') }}</p>
      }
    </section>
  `,
})
export class CalendarSettings {
  private readonly api = inject(PayrollApi);
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly fields = FIELDS;
  protected readonly bounds = SETTINGS_BOUNDS;
  protected readonly errorKeys = PAYROLL_ERROR_KEYS;
  protected readonly settings = this.api.settingsResource();
  protected readonly saving = signal(false);
  protected readonly feedback = signal<string | null>(null);
  protected readonly formError = signal<FormMessage | null>(null);

  private numberControl(name: CalendarField) {
    const { min, max } = SETTINGS_BOUNDS[name];
    return this.fb.control<number>(DEFAULT_PAYROLL_SETTINGS[name], wholeNumberBetween(min, max));
  }

  protected readonly form = this.fb.group({
    cutoffDay: this.numberControl('cutoffDay'),
    regularizationMonths: this.numberControl('regularizationMonths'),
    overtimeMinMinutes: this.numberControl('overtimeMinMinutes'),
  });

  constructor() {
    effect(() => {
      if (!this.settings.hasValue()) return;
      const s = this.settings.value();
      this.form.reset({ cutoffDay: s.cutoffDay, regularizationMonths: s.regularizationMonths, overtimeMinMinutes: s.overtimeMinMinutes });
    });
  }

  protected save(): void {
    this.formError.set(null);
    this.feedback.set(null);
    if (!this.settings.hasValue()) return;
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const v = this.form.getRawValue();
    const body: PayrollSettings = {
      ...this.settings.value(),
      cutoffDay: Number(v.cutoffDay),
      regularizationMonths: Number(v.regularizationMonths),
      overtimeMinMinutes: Number(v.overtimeMinMinutes),
    };
    this.saving.set(true);
    this.api.updateSettings(body).subscribe({
      next: () => {
        this.saving.set(false);
        this.feedback.set('payroll.settings.saved');
        this.settings.reload();
      },
      error: (error: unknown) => {
        this.saving.set(false);
        this.formError.set(settingsProblemToForm(this.form, error));
      },
    });
  }
}
