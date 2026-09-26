/**
 * "New assignment" (Assignments tab): `<app-assignment-form [employee]="e" (saved)="…" (cancelled)="…" />`.
 * `POST /employees/:id/assignments` — the API closes the current assignment the day before `validFrom`.
 *
 * Angular concepts:
 * - **The org-unit picker inside a reactive form** (`formControlName="orgUnitId"`, a ControlValueAccessor —
 *   shared/org-unit-picker). Its `[asOf]` follows the effective date the user picks (`toSignal(valueChanges)`), so it
 *   offers units that exist on that day.
 * - **A validator reading an input** (`notBefore(() => …)`): the new assignment must start after the current one
 *   (contract `assignment-date`). The getter reads the `employee` input each time validation runs — one validator
 *   instance, no `setValidators()` when the input changes. The server still decides (409 → the date field).
 */
import { ChangeDetectionStrategy, Component, computed, inject, input, type OnInit, output, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import { Session } from '../../core/auth/session';
import { todayIso } from '../../core/date/iso-date';
import { EmployeesApi } from '../../core/employees/employees-api';
import type { EmployeeDetail } from '../../core/employees/employees.models';
import type { FormMessage } from '../../core/http/problem-form';
import { OrgApi } from '../../core/org/org-api';
import type { Site } from '../../core/org/org.models';
import { OrgUnitPicker } from '../../shared/org-unit-picker/org-unit-picker';
import { ASSIGNMENT_SLUGS, employeeProblemToForm, isoDate, JOB_TITLE_MAX, notBefore, notBlank } from './employee-forms';
import { FieldError } from './field-error';

/** The day after `iso` (`YYYY-MM-DD`), computed in UTC so no time zone shifts it. */
export function nextDay(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

@Component({
  selector: 'app-assignment-form',
  imports: [ReactiveFormsModule, TranslocoDirective, OrgUnitPicker, FieldError],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form *transloco="let t" class="panel" [formGroup]="form" (ngSubmit)="submit()" aria-labelledby="assign-title" novalidate>
      <h3 id="assign-title">{{ t('employees.assignments.newTitle') }}</h3>
      <p class="field-hint">{{ t('employees.assignments.newIntro') }}</p>
      @if (formError(); as error) {
        <p class="form-error" role="alert">{{ 'key' in error ? t(error.key) : error.text }}</p>
      }
      @let c = form.controls;
      <div class="grid">
        <div class="field">
          <label for="assign-unit">{{ t('employees.fields.unit') }}</label>
          <app-org-unit-picker
            formControlName="orgUnitId"
            inputId="assign-unit"
            [asOf]="validFrom() || undefined"
            [invalid]="c.orgUnitId.invalid && c.orgUnitId.touched"
            describedBy="assign-unit-error"
          />
          <app-field-error [control]="c.orgUnitId" errorId="assign-unit-error" />
        </div>
        @if (canSites()) {
          <div class="field">
            <label for="assign-site">{{ t('employees.fields.site') }}</label>
            <select id="assign-site" formControlName="siteId">
              <option [ngValue]="null">{{ t('employees.fields.siteOfUnit') }}</option>
              @for (site of sites(); track site.id) {
                <option [ngValue]="site.id">{{ site.name }} ({{ site.code }})</option>
              }
            </select>
          </div>
        }
        <div class="field">
          <label for="assign-job-title">{{ t('employees.fields.jobTitle') }}</label>
          <input id="assign-job-title" type="text" formControlName="jobTitle" dir="auto" required
            [attr.aria-invalid]="c.jobTitle.invalid && c.jobTitle.touched" aria-describedby="assign-job-title-error" />
          <app-field-error [control]="c.jobTitle" errorId="assign-job-title-error" />
        </div>
        <div class="field">
          <label for="assign-valid-from">{{ t('employees.fields.validFrom') }}</label>
          <input id="assign-valid-from" type="date" formControlName="validFrom" required [min]="minDate()"
            [attr.aria-invalid]="c.validFrom.invalid && c.validFrom.touched" aria-describedby="assign-valid-from-error" />
          <app-field-error [control]="c.validFrom" errorId="assign-valid-from-error" />
        </div>
      </div>
      <div class="form-actions">
        <button class="btn" type="submit" [disabled]="submitting()">
          {{ submitting() ? t('employees.form.saving') : t('common.save') }}
        </button>
        <button class="btn secondary" type="button" (click)="cancelled.emit()">{{ t('common.cancel') }}</button>
      </div>
    </form>
  `,
  styleUrl: './employees.css',
})
export class AssignmentForm implements OnInit {
  private readonly api = inject(EmployeesApi);
  private readonly fb = inject(NonNullableFormBuilder);

  readonly employee = input.required<EmployeeDetail>();
  readonly saved = output<void>();
  readonly cancelled = output<void>();

  /** First allowed day: after the current (newest) assignment's start. */
  protected readonly minDate = computed(() => {
    const current = this.employee().assignments[0];
    return current ? nextDay(current.validFrom) : this.employee().hireDate;
  });

  protected readonly form = this.fb.group({
    orgUnitId: this.fb.control<string | null>(null, Validators.required),
    siteId: this.fb.control<string | null>(null),
    jobTitle: ['', [Validators.required, notBlank, Validators.maxLength(JOB_TITLE_MAX)]],
    // Empty until ngOnInit: the validator reads the `employee` input, which is not set during field initialisation.
    validFrom: ['', [Validators.required, isoDate, notBefore(() => this.minDate())]],
  });

  protected readonly validFrom = toSignal(this.form.controls.validFrom.valueChanges, { initialValue: '' });
  protected readonly canSites = inject(Session).allows('site.read');
  private readonly sitesResource = inject(OrgApi).sitesResource(() => '', this.canSites);
  protected readonly sites = computed<readonly Site[]>(() => (this.sitesResource.hasValue() ? this.sitesResource.value().items : []));
  protected readonly submitting = signal(false);
  protected readonly formError = signal<FormMessage | null>(null);

  ngOnInit(): void {
    const today = todayIso();
    this.form.controls.validFrom.setValue(today > this.minDate() ? today : this.minDate());
  }

  protected submit(): void {
    this.formError.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const v = this.form.getRawValue();
    this.submitting.set(true);
    this.api
      .assign(this.employee().id, { orgUnitId: v.orgUnitId ?? '', siteId: v.siteId, jobTitle: v.jobTitle.trim(), validFrom: v.validFrom })
      .subscribe({
        next: () => {
          this.submitting.set(false);
          this.saved.emit();
        },
        error: (error: unknown) => {
          this.formError.set(employeeProblemToForm(this.form, error, ASSIGNMENT_SLUGS));
          this.submitting.set(false);
        },
      });
  }
}
