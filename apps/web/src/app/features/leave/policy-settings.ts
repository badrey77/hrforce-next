/**
 * Leave policy: weekend days (checkboxes) and the first month of the reference year — part of /leave/settings.
 *
 * Angular concepts:
 * - **A checkbox group as a `FormGroup` of booleans** (`weekend.1` … `weekend.7`), converted to the API's
 *   `weekendDays: number[]` on submit — the same "form shape ≠ wire format" idea as the employee create form. (A
 *   `FormControl<number[]>` with a custom control — features/access/permission-checklist.ts — is the alternative when
 *   the list is long or dynamic; seven fixed days read better as seven plain controls.) A GROUP validator enforces
 *   "at most three weekend days", the API's rule.
 * - **Filling a form from a resource with `effect()`**: the policy arrives asynchronously; an effect `reset()`s the
 *   form when it does (and after a reload). `untracked` is not needed: the effect reads only the resource.
 * - **Day and month names from the locale data, not from translations**: `DatePipe` with the 'EEEE' / 'LLLL'
 *   formats on fixed dates (2026-01-05 is a Monday) gives "vendredi" / "الجمعة" / "Friday" and "juillet" / "جويلية" /
 *   "July" in the active locale — no translation keys to maintain for calendar words.
 */
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { type AbstractControl, type FormControl, NonNullableFormBuilder, ReactiveFormsModule, type ValidationErrors } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import { type FormMessage, problemToForm } from '../../core/http/problem-form';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { LeaveApi } from '../../core/leave/leave-api';
import { ISO_WEEKDAYS, type IsoWeekday, type LeavePolicy } from '../../core/leave/leave.models';

export const MAX_WEEKEND_DAYS = 3;

/** ISO weekday → a date that falls on it (2026-01-05 is a Monday), for DatePipe's 'EEEE'. */
export function weekdayDate(day: IsoWeekday): string {
  return `2026-01-${String(4 + day).padStart(2, '0')}`;
}

function atMostWeekendDays(group: AbstractControl): ValidationErrors | null {
  const count = Object.values(group.value as Record<string, boolean>).filter(Boolean).length;
  return count > MAX_WEEKEND_DAYS ? { tooManyWeekendDays: { max: MAX_WEEKEND_DAYS } } : null;
}

@Component({
  selector: 'app-policy-settings',
  imports: [TranslocoDirective, ReactiveFormsModule, DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section *transloco="let t" aria-labelledby="policy-title">
      <div class="toolbar">
        <h2 id="policy-title">{{ t('leave.settings.policy.title') }}</h2>
      </div>
      @if (feedback(); as key) {
        <p class="feedback" role="status">{{ t(key) }}</p>
      }
      @if (formError(); as error) {
        <p class="form-error" role="alert">{{ 'key' in error ? t(error.key) : error.text }}</p>
      }
      @if (policy.error()) {
        <div class="form-error" role="alert">
          <p>{{ t('leave.settings.policy.loadError') }}</p>
          <button class="btn secondary" type="button" (click)="policy.reload()">{{ t('common.retry') }}</button>
        </div>
      } @else if (policy.hasValue()) {
        <form class="panel" [formGroup]="form" (ngSubmit)="save()" novalidate data-form="policy">
          <fieldset formGroupName="weekend">
            <legend>{{ t('leave.settings.policy.weekend') }}</legend>
            <div class="days">
              @for (day of weekdays; track day) {
                <div class="check">
                  <input [id]="'weekend-' + day" type="checkbox" [formControlName]="day" />
                  <label [for]="'weekend-' + day">{{ weekdayDate(day) | date: 'EEEE' : undefined : locale() }}</label>
                </div>
              }
            </div>
            @if (form.controls.weekend.hasError('tooManyWeekendDays')) {
              <p class="field-error" data-error="weekend">{{ t('leave.settings.policy.tooMany', { max: maxWeekend }) }}</p>
            }
          </fieldset>
          <div class="field">
            <label for="policy-month">{{ t('leave.settings.policy.referenceMonth') }}</label>
            <select id="policy-month" formControlName="referenceStartMonth">
              @for (month of months; track month) {
                <option [ngValue]="month">{{ monthDate(month) | date: 'LLLL' : undefined : locale() }}</option>
              }
            </select>
            <p class="field-hint">{{ t('leave.settings.policy.referenceHint') }}</p>
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
  styles: `
    fieldset { border: 0; padding: 0; margin: 0 0 var(--space-4); }
    legend { font-weight: 600; margin-block-end: var(--space-2); }
    .days { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-4); }
  `,
})
export class PolicySettings {
  private readonly api = inject(LeaveApi);
  private readonly fb = inject(NonNullableFormBuilder);
  private readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));

  protected readonly weekdays = ISO_WEEKDAYS;
  protected readonly months = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  protected readonly maxWeekend = MAX_WEEKEND_DAYS;
  protected readonly weekdayDate = weekdayDate;
  protected readonly policy = this.api.policyResource();
  protected readonly saving = signal(false);
  protected readonly feedback = signal<string | null>(null);
  protected readonly formError = signal<FormMessage | null>(null);

  protected readonly form = this.fb.group({
    weekend: this.fb.group(
      Object.fromEntries(ISO_WEEKDAYS.map((day): [string, FormControl<boolean>] => [String(day), this.fb.control(false)])),
      { validators: atMostWeekendDays },
    ),
    referenceStartMonth: [7],
  });

  constructor() {
    effect(() => {
      if (this.policy.hasValue()) this.fill(this.policy.value());
    });
  }

  protected monthDate(month: number): string {
    return `2026-${String(month).padStart(2, '0')}-01`;
  }

  private fill(policy: LeavePolicy): void {
    this.form.reset({
      weekend: Object.fromEntries(ISO_WEEKDAYS.map((day) => [String(day), policy.weekendDays.includes(day)])),
      referenceStartMonth: policy.referenceStartMonth,
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
    const weekend: Record<string, boolean> = v.weekend;
    const current = this.policy.hasValue() ? this.policy.value() : undefined;
    const body: LeavePolicy = {
      referenceStartMonth: Number(v.referenceStartMonth),
      weekendDays: ISO_WEEKDAYS.filter((day) => weekend[String(day)]),
      ...(current?.entitlementDelayMonths !== undefined ? { entitlementDelayMonths: current.entitlementDelayMonths } : {}),
    };
    this.saving.set(true);
    this.api.updatePolicy(body).subscribe({
      next: () => {
        this.saving.set(false);
        this.feedback.set('leave.settings.policy.saved');
        this.policy.reload();
      },
      error: (error: unknown) => {
        this.saving.set(false);
        this.formError.set(problemToForm(this.form, error, {}));
      },
    });
  }
}
