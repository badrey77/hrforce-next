/**
 * /deadlines/settings — the deadline policy (`deadline.configure`, company-wide writes; contracts-deadlines.md ›
 * Data › deadline_policy): notice periods, the automatic contract-decision lead time (0 = off), the retirement age and
 * notice, the daily digest. The API's bounds are mirrored by the validators so the usual mistakes are caught first.
 */
import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import { type AbstractControl, NonNullableFormBuilder, ReactiveFormsModule, type ValidationErrors, type ValidatorFn, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { DeadlinesApi } from '../../core/deadlines/deadlines-api';
import {
  DEFAULT_DEADLINE_POLICY,
  POLICY_BOUNDS,
  type DeadlinePolicyView,
  type PolicyNumberField,
} from '../../core/deadlines/deadlines.models';
import { type FormMessage, problemToForm } from '../../core/http/problem-form';
import { ControlError } from '../../shared/attendance/control-error';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';

/** A whole number within [min, max], as ONE error carrying both bounds (the message names the range). */
function wholeNumberBetween(min: number, max: number): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const raw: unknown = control.value;
    if (raw === null || raw === '' || raw === undefined) return null;
    const value = Number(raw);
    return Number.isInteger(value) && value >= min && value <= max ? null : { range: { min, max } };
  };
}

const ERROR_KEYS = { range: 'deadlines.settings.outOfRange', required: 'deadlines.settings.required' } as const;

/** Each number field: its control name, translation keys and unit (days / years / months). */
const FIELDS: readonly { readonly name: PolicyNumberField; readonly unit: 'days' | 'years' | 'months' }[] = [
  { name: 'contractNoticeDays', unit: 'days' },
  { name: 'decisionNoticeDays', unit: 'days' },
  { name: 'probationNoticeDays', unit: 'days' },
  { name: 'documentNoticeDays', unit: 'days' },
  { name: 'retirementAge', unit: 'years' },
  { name: 'retirementNoticeMonths', unit: 'months' },
];

@Component({
  selector: 'app-deadline-settings-page',
  imports: [TranslocoDirective, ReactiveFormsModule, RouterLink, RevealAlert, ControlError],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-container *transloco="let t">
      <header class="page-header">
        <h1>{{ t('deadlines.settings.title') }}</h1>
        <a class="btn secondary" routerLink="/deadlines" data-action="board">{{ t('deadlines.settings.back') }}</a>
      </header>
      <p class="muted">{{ t('deadlines.settings.intro') }}</p>
      @if (feedback(); as key) {
        <p class="feedback" role="status" data-feedback>{{ t(key) }}</p>
      }
      @if (formError(); as error) {
        <p class="form-error" role="alert" [appRevealAlert]="error">{{ 'key' in error ? t(error.key) : error.text }}</p>
      }
      @if (policy.error()) {
        <div class="form-error" role="alert">
          <p>{{ t('deadlines.settings.loadError') }}</p>
          <button class="btn secondary" type="button" (click)="policy.reload()">{{ t('common.retry') }}</button>
        </div>
      } @else if (policy.hasValue()) {
        <form class="panel" [formGroup]="form" (ngSubmit)="save()" novalidate data-form="deadline-policy">
          @for (f of fields; track f.name) {
            @let control = form.controls[f.name];
            <div class="field">
              <label [for]="'dl-' + f.name">{{ t('deadlines.settings.fields.' + f.name) }}</label>
              <input [id]="'dl-' + f.name" type="number" inputmode="numeric" [min]="bounds[f.name].min" [max]="bounds[f.name].max" [formControlName]="f.name"
                [attr.aria-describedby]="'dl-' + f.name + '-hint dl-' + f.name + '-error'" [attr.aria-invalid]="control.invalid && control.touched" />
              <p class="field-hint" [id]="'dl-' + f.name + '-hint'">
                {{ t('deadlines.settings.hints.' + f.name, { min: bounds[f.name].min, max: bounds[f.name].max }) }}
              </p>
              <app-control-error [control]="control" [errorId]="'dl-' + f.name + '-error'" [keys]="errorKeys" />
            </div>
          }
          <div class="check">
            <input id="dl-digest" type="checkbox" formControlName="digestEnabled" aria-describedby="dl-digest-hint" />
            <label for="dl-digest">{{ t('deadlines.settings.fields.digestEnabled') }}</label>
          </div>
          <p class="field-hint" id="dl-digest-hint">{{ t('deadlines.settings.hints.digestEnabled') }}</p>
          <div class="form-actions">
            <button class="btn" type="submit" data-action="save-policy" [disabled]="saving()">{{ t('common.save') }}</button>
          </div>
        </form>
      } @else {
        <p class="muted">{{ t('common.loading') }}</p>
      }
    </ng-container>
  `,
})
export class DeadlineSettingsPage {
  private readonly api = inject(DeadlinesApi);
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly fields = FIELDS;
  protected readonly bounds = POLICY_BOUNDS;
  protected readonly errorKeys = ERROR_KEYS;
  protected readonly policy = this.api.policyResource();
  protected readonly saving = signal(false);
  protected readonly feedback = signal<string | null>(null);
  protected readonly formError = signal<FormMessage | null>(null);

  private numberControl(name: PolicyNumberField) {
    const { min, max } = POLICY_BOUNDS[name];
    return this.fb.control<number>(DEFAULT_DEADLINE_POLICY[name], [Validators.required, wholeNumberBetween(min, max)]);
  }

  protected readonly form = this.fb.group({
    probationNoticeDays: this.numberControl('probationNoticeDays'),
    contractNoticeDays: this.numberControl('contractNoticeDays'),
    decisionNoticeDays: this.numberControl('decisionNoticeDays'),
    documentNoticeDays: this.numberControl('documentNoticeDays'),
    retirementAge: this.numberControl('retirementAge'),
    retirementNoticeMonths: this.numberControl('retirementNoticeMonths'),
    digestEnabled: this.fb.control(DEFAULT_DEADLINE_POLICY.digestEnabled),
  });

  constructor() {
    effect(() => {
      if (!this.policy.hasValue()) return;
      this.form.reset({ ...this.policy.value() });
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
    const body: DeadlinePolicyView = {
      probationNoticeDays: Number(v.probationNoticeDays),
      contractNoticeDays: Number(v.contractNoticeDays),
      decisionNoticeDays: Number(v.decisionNoticeDays),
      documentNoticeDays: Number(v.documentNoticeDays),
      retirementAge: Number(v.retirementAge),
      retirementNoticeMonths: Number(v.retirementNoticeMonths),
      digestEnabled: v.digestEnabled,
    };
    this.saving.set(true);
    this.api.updatePolicy(body).subscribe({
      next: () => {
        this.saving.set(false);
        this.feedback.set('deadlines.settings.saved');
        this.policy.reload();
      },
      error: (error: unknown) => {
        this.saving.set(false);
        this.formError.set(problemToForm(this.form, error, { 'forbidden-scope': { key: 'deadlines.settings.companyWide' } }));
      },
    });
  }
}
