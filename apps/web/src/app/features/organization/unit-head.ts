/**
 * "Head of unit" on the unit detail (docs/contracts/leave.md › Links): who heads the unit today, and — with the
 * unit's `update` action — a form to name a new head from a date (`PUT /org/units/:id/head`; the API closes the
 * previous head the day before). The head's linked user approves the manager step of leave requests.
 * `<app-unit-head [unit]="unit" [canEdit]="can('update')" (saved)="detail.reload()" />`.
 *
 * Angular concepts:
 * - **The employee picker (a ControlValueAccessor) in a reactive form**: `formControlName="employmentId"` on
 *   `<app-employee-picker>` works exactly like on an `<input>` — required validation, touched state, reset — because
 *   the picker implements the CVA contract (shared/employee-picker/employee-picker.ts).
 * - **Parent-owned data, child-owned form**: the page owns the unit resource; this component only emits `saved`,
 *   and the page reloads the detail (whose `head` then shows the new person). The child never patches the parent's
 *   data from what it sent.
 * - **`linkedSignal` to close the form when the unit changes**: `editing` resets to `false` whenever `unit().id`
 *   changes (another unit selected in the tree).
 * - **Slug table** for the API's 409s: `head-date` → the date field, `employment-ended` → the picker.
 */
import { ChangeDetectionStrategy, Component, computed, inject, input, linkedSignal, output, signal } from '@angular/core';
import { type AbstractControl, NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import { todayIso } from '../../core/date/iso-date';
import { type FormMessage, problemToForm, type SlugTable } from '../../core/http/problem-form';
import { LanguageService } from '../../core/i18n/language.service';
import { OrgApi } from '../../core/org/org-api';
import type { OrgUnitDetail } from '../../core/org/org.models';
import { DisplayNamePipe } from '../../shared/display-name/display-name.pipe';
import { EmployeePicker } from '../../shared/employee-picker/employee-picker';
import { isoDate } from '../../shared/leave/leave-forms';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';

export const HEAD_SLUGS: SlugTable = {
  'head-date': { key: 'org.head.problems.date', field: 'validFrom' },
  'employment-ended': { key: 'org.head.problems.ended', field: 'employmentId' },
};

@Component({
  selector: 'app-unit-head',
  imports: [RevealAlert, TranslocoDirective, ReactiveFormsModule, DisplayNamePipe, EmployeePicker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section *transloco="let t" class="head" aria-labelledby="unit-head-title" data-section="head">
      <div class="bar">
        <h3 id="unit-head-title">{{ t('org.head.title') }}</h3>
        @if (canEdit() && !editing()) {
          <button class="btn secondary" type="button" data-action="set-head" (click)="start()">{{ t('org.head.change') }}</button>
        }
      </div>
      @if (feedback(); as key) {
        <p class="feedback" role="status">{{ t(key) }}</p>
      }
      @if (head(); as h) {
        <p data-field="head">
          {{ h.person | displayName: lang() }} <span class="code">({{ h.matricule }})</span>
          <span class="muted"> — {{ t('org.head.since', { date: h.validFrom }) }}</span>
        </p>
      } @else {
        <p class="muted" data-field="head">{{ t('org.head.none') }}</p>
      }

      @if (editing()) {
        @let c = form.controls;
        <form [formGroup]="form" (ngSubmit)="submit()" novalidate data-form="head">
          @if (formError(); as error) {
            <p class="form-error" role="alert" [appRevealAlert]="error">{{ 'key' in error ? t(error.key) : error.text }}</p>
          }
          <div class="field">
            <label for="head-employee">{{ t('org.head.employee') }}</label>
            <app-employee-picker formControlName="employmentId" inputId="head-employee"
              [invalid]="c.employmentId.invalid && c.employmentId.touched" describedBy="head-employee-error" />
            @if (c.employmentId.invalid && c.employmentId.touched) {
              @let e1 = fieldError(c.employmentId, 'org.head.employeeRequired');
              <p class="field-error" id="head-employee-error">{{ 'key' in e1 ? t(e1.key) : e1.text }}</p>
            }
          </div>
          <div class="field">
            <label for="head-valid-from">{{ t('org.head.validFrom') }}</label>
            <input id="head-valid-from" type="date" formControlName="validFrom" required
              [attr.aria-invalid]="c.validFrom.invalid && c.validFrom.touched" aria-describedby="head-valid-from-error" />
            @if (c.validFrom.invalid && c.validFrom.touched) {
              @let e2 = fieldError(c.validFrom, 'org.head.dateRequired');
              <p class="field-error" id="head-valid-from-error">{{ 'key' in e2 ? t(e2.key) : e2.text }}</p>
            }
          </div>
          <div class="form-actions">
            <button class="btn" type="submit" [disabled]="saving()">{{ t('common.save') }}</button>
            <button class="btn secondary" type="button" (click)="editing.set(false)">{{ t('common.cancel') }}</button>
          </div>
        </form>
      }
    </section>
  `,
  styles: `
    .head { margin-block-start: var(--space-4); padding-block-start: var(--space-3); border-block-start: 1px solid var(--color-border); }
    .bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-2); }
    h3 { margin: 0; font-size: 1rem; }
  `,
})
export class UnitHead {
  private readonly api = inject(OrgApi);
  protected readonly lang = inject(LanguageService).current;

  readonly unit = input.required<OrgUnitDetail>();
  /** The unit's `update` action (from the server). */
  readonly canEdit = input(false);
  readonly saved = output<void>();

  protected readonly head = computed(() => this.unit().head ?? null);
  protected readonly editing = linkedSignal<string, boolean>({ source: () => this.unit().id, computation: () => false });
  protected readonly saving = signal(false);
  protected readonly formError = signal<FormMessage | null>(null);
  protected readonly feedback = signal<string | null>(null);

  protected readonly form = inject(NonNullableFormBuilder).group({
    employmentId: inject(NonNullableFormBuilder).control<string | null>(null, Validators.required),
    validFrom: [todayIso(), [Validators.required, isoDate]],
  });

  protected start(): void {
    this.feedback.set(null);
    this.formError.set(null);
    this.form.reset({ employmentId: null, validFrom: todayIso() });
    this.editing.set(true);
  }

  /** What to show under a field: a slug's translated key, the server's own text, or the local fallback. */
  protected fieldError(control: AbstractControl, fallbackKey: string): FormMessage {
    const key: unknown = control.getError('serverKey');
    if (typeof key === 'string') return { key };
    const text: unknown = control.getError('server');
    return typeof text === 'string' ? { text } : { key: fallbackKey };
  }

  protected submit(): void {
    this.formError.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const v = this.form.getRawValue();
    this.saving.set(true);
    this.api.setHead(this.unit().id, { employmentId: v.employmentId, validFrom: v.validFrom }).subscribe({
      next: () => {
        this.saving.set(false);
        this.editing.set(false);
        this.feedback.set('org.head.saved');
        this.saved.emit();
      },
      error: (error: unknown) => {
        this.saving.set(false);
        this.formError.set(problemToForm(this.form, error, HEAD_SLUGS));
      },
    });
  }
}
