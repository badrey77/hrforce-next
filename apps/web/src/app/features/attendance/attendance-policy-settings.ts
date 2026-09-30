/**
 * Settings › Politique (docs/contracts/attendance.md › Data › attendance_policy): how long punches are kept (12–120
 * months, default 60 — assumption 5) and the gap under which a second scan returns the first punch instead of a
 * departure (0–600 s, default 120 — assumption 9).
 *
 * Angular concepts: the /leave/settings policy pattern (features/leave/policy-settings.ts) — an `effect()` fills
 * the form when the resource answers (and again after a save's `reload()`); `Validators.min/max` mirror the API's
 * bounds so the usual mistakes are caught before sending; number inputs give numbers (`type="number"` + a typed
 * control), and `PUT` sends only what the form holds.
 */
import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import { AttendanceApi } from '../../core/attendance/attendance-api';
import { GAP_MAX, GAP_MIN, RETENTION_MAX, RETENTION_MIN } from '../../core/attendance/attendance.models';
import type { FormMessage } from '../../core/http/problem-form';
import { attendanceProblemToForm } from '../../shared/attendance/attendance-forms';
import { ControlError } from '../../shared/attendance/control-error';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';
import { POLICY_SLUGS } from './settings-problems';

@Component({
  selector: 'app-attendance-policy-settings',
  imports: [TranslocoDirective, ReactiveFormsModule, RevealAlert, ControlError],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section *transloco="let t" aria-labelledby="att-policy-title" data-section="policy">
      <div class="toolbar">
        <h2 id="att-policy-title">{{ t('attendance.policy.title') }}</h2>
      </div>
      @if (feedback(); as key) {
        <p class="feedback" role="status">{{ t(key) }}</p>
      }
      @if (formError(); as error) {
        <p class="form-error" role="alert" [appRevealAlert]="error">{{ 'key' in error ? t(error.key) : error.text }}</p>
      }
      @if (policy.error()) {
        <div class="form-error" role="alert">
          <p>{{ t('attendance.settings.loadError') }}</p>
          <button class="btn secondary" type="button" (click)="policy.reload()">{{ t('common.retry') }}</button>
        </div>
      } @else if (policy.hasValue()) {
        @let c = form.controls;
        <form class="panel" [formGroup]="form" (ngSubmit)="save()" novalidate data-form="attendance-policy">
          <div class="field">
            <label for="att-retention">{{ t('attendance.policy.retention') }}</label>
            <input id="att-retention" type="number" [min]="bounds.retentionMin" [max]="bounds.retentionMax" formControlName="retentionMonths"
              aria-describedby="att-retention-hint att-retention-error" />
            <p class="field-hint" id="att-retention-hint">{{ t('attendance.policy.retentionHint', { min: bounds.retentionMin, max: bounds.retentionMax }) }}</p>
            <app-control-error [control]="c.retentionMonths" errorId="att-retention-error" />
          </div>
          <div class="field">
            <label for="att-gap">{{ t('attendance.policy.gap') }}</label>
            <input id="att-gap" type="number" [min]="bounds.gapMin" [max]="bounds.gapMax" formControlName="minPunchGapSeconds"
              aria-describedby="att-gap-hint att-gap-error" />
            <p class="field-hint" id="att-gap-hint">{{ t('attendance.policy.gapHint', { min: bounds.gapMin, max: bounds.gapMax }) }}</p>
            <app-control-error [control]="c.minPunchGapSeconds" errorId="att-gap-error" />
          </div>
          <div class="form-actions">
            <button class="btn" type="submit" data-action="save-policy" [disabled]="saving()">{{ t('common.save') }}</button>
          </div>
        </form>
      } @else {
        <p class="muted">{{ t('common.loading') }}</p>
      }
    </section>
  `,
})
export class AttendancePolicySettings {
  private readonly api = inject(AttendanceApi);
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly bounds = { retentionMin: RETENTION_MIN, retentionMax: RETENTION_MAX, gapMin: GAP_MIN, gapMax: GAP_MAX };
  protected readonly policy = this.api.policyResource();
  protected readonly saving = signal(false);
  protected readonly feedback = signal<string | null>(null);
  protected readonly formError = signal<FormMessage | null>(null);

  protected readonly form = this.fb.group({
    retentionMonths: [60, [Validators.required, Validators.min(RETENTION_MIN), Validators.max(RETENTION_MAX)]],
    minPunchGapSeconds: [120, [Validators.required, Validators.min(GAP_MIN), Validators.max(GAP_MAX)]],
  });

  constructor() {
    effect(() => {
      if (this.policy.hasValue()) this.form.reset(this.policy.value());
    });
  }

  protected save(): void {
    this.formError.set(null);
    this.feedback.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const v = this.form.getRawValue();
    this.saving.set(true);
    this.api.updatePolicy({ retentionMonths: Number(v.retentionMonths), minPunchGapSeconds: Number(v.minPunchGapSeconds) }).subscribe({
      next: () => {
        this.saving.set(false);
        this.feedback.set('attendance.policy.saved');
        this.policy.reload();
      },
      error: (error: unknown) => {
        this.saving.set(false);
        this.formError.set(attendanceProblemToForm(this.form, error, POLICY_SLUGS));
      },
    });
  }
}
