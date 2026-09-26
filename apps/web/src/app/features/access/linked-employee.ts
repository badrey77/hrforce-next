/**
 * "Linked employee" on the Access user page (docs/contracts/leave.md › Links): which employee record this account
 * acts as for self-service (My leave) and for approving as a unit head. Link with the employee picker, or unlink
 * (`PUT /access/users/:id/employment` with `{ employmentId }` / `{ employmentId: null }`, permission `access.grant`).
 * `<app-linked-employee [user]="person" (changed)="member.reload()" />`.
 *
 * Angular concepts:
 * - **The same CVA in a second form**: `<app-employee-picker formControlName="employmentId">` — reuse is the point
 *   of a ControlValueAccessor; neither this form nor the head-of-unit form knows how the picker searches.
 * - **`*appCan` + an inner permission**: linking needs `access.grant`; SEARCHING employees needs `employee.read`. A
 *   caller with the first but not the second would see a picker that always answers "no results", so the form is
 *   replaced by a hint instead (`Session.allows`, a per-code `computed()` kept in a field).
 * - **Two-step unlink** (`confirming` signal) rather than a modal: the action is reversible (link again), so an
 *   inline "Unlink? Yes / No" is enough friction.
 * - **Slug table**: `employment-linked` (already linked to another account) and `employment-ended` land on the
 *   picker; `link-self` (linking your own account) above the form.
 */
import { ChangeDetectionStrategy, Component, inject, input, linkedSignal, output, signal } from '@angular/core';
import { type AbstractControl, NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import type { Observable } from 'rxjs';
import { AccessApi } from '../../core/access/access-api';
import type { AccessUser } from '../../core/access/access.models';
import { Session } from '../../core/auth/session';
import { type FormMessage, problemToForm, type SlugTable } from '../../core/http/problem-form';
import { LanguageService } from '../../core/i18n/language.service';
import { CanDirective } from '../../shared/can/can.directive';
import { DisplayNamePipe } from '../../shared/display-name/display-name.pipe';
import { EmployeePicker } from '../../shared/employee-picker/employee-picker';

export const LINK_SLUGS: SlugTable = {
  'employment-linked': { key: 'access.link.problems.taken', field: 'employmentId' },
  'employment-ended': { key: 'access.link.problems.ended', field: 'employmentId' },
  'link-self': { key: 'access.link.problems.self' },
};

@Component({
  selector: 'app-linked-employee',
  imports: [TranslocoDirective, ReactiveFormsModule, CanDirective, DisplayNamePipe, EmployeePicker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section *transloco="let t" class="panel" aria-labelledby="linked-title" data-section="linked-employee">
      <div class="toolbar">
        <h3 id="linked-title">{{ t('access.link.title') }}</h3>
      </div>
      @if (feedback(); as key) {
        <p class="feedback" role="status">{{ t(key) }}</p>
      }
      @if (formError(); as error) {
        <p class="form-error" role="alert">{{ 'key' in error ? t(error.key) : error.text }}</p>
      }
      @if (user().employment; as employment) {
        <p data-field="linked">
          {{ employment.person | displayName: lang() }} <span class="code">({{ employment.matricule }})</span>
        </p>
        <div *appCan="'access.grant'" class="form-actions">
          @if (confirming()) {
            <span>{{ t('access.link.confirmUnlink') }}</span>
            <button class="btn" type="button" data-action="confirm-unlink" [disabled]="saving()" (click)="unlink()">{{ t('access.grants.yes') }}</button>
            <button class="btn secondary" type="button" (click)="confirming.set(false)">{{ t('access.grants.no') }}</button>
          } @else {
            <button class="btn secondary" type="button" data-action="unlink" (click)="confirming.set(true)">{{ t('access.link.unlink') }}</button>
          }
        </div>
      } @else {
        <p class="muted" data-field="linked">{{ t('access.link.none') }}</p>
      }

      <ng-container *appCan="'access.grant'">
        @if (canSearch()) {
          @let c = form.controls.employmentId;
          <form [formGroup]="form" (ngSubmit)="link()" novalidate data-form="link">
            <div class="field">
              <label for="link-employee">{{ user().employment ? t('access.link.replace') : t('access.link.employee') }}</label>
              <app-employee-picker formControlName="employmentId" inputId="link-employee"
                [invalid]="c.invalid && c.touched" describedBy="link-employee-hint link-employee-error" />
              <p class="field-hint" id="link-employee-hint">{{ t('access.link.hint') }}</p>
              @if (c.invalid && c.touched) {
                @let e = fieldError(c);
                <p class="field-error" id="link-employee-error">{{ 'key' in e ? t(e.key) : e.text }}</p>
              }
            </div>
            <button class="btn" type="submit" data-action="link" [disabled]="saving()">{{ t('access.link.link') }}</button>
          </form>
        } @else {
          <p class="field-hint" data-state="no-employee-read">{{ t('access.link.needsEmployeeRead') }}</p>
        }
      </ng-container>
    </section>
  `,
})
export class LinkedEmployee {
  private readonly api = inject(AccessApi);
  protected readonly lang = inject(LanguageService).current;
  protected readonly canSearch = inject(Session).allows('employee.read');

  readonly user = input.required<AccessUser>();
  readonly changed = output<void>();

  protected readonly confirming = linkedSignal<string, boolean>({ source: () => this.user().id, computation: () => false });
  protected readonly saving = signal(false);
  protected readonly feedback = signal<string | null>(null);
  protected readonly formError = signal<FormMessage | null>(null);

  protected readonly form = inject(NonNullableFormBuilder).group({
    employmentId: inject(NonNullableFormBuilder).control<string | null>(null, Validators.required),
  });

  protected fieldError(control: AbstractControl): FormMessage {
    const key: unknown = control.getError('serverKey');
    if (typeof key === 'string') return { key };
    const text: unknown = control.getError('server');
    return typeof text === 'string' ? { text } : { key: 'access.link.employeeRequired' };
  }

  protected link(): void {
    this.formError.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.write(this.api.linkEmployment(this.user().id, this.form.getRawValue().employmentId), 'access.link.linked');
  }

  protected unlink(): void {
    this.formError.set(null);
    this.write(this.api.linkEmployment(this.user().id, null), 'access.link.unlinked');
  }

  private write(request$: Observable<unknown>, successKey: string): void {
    this.saving.set(true);
    this.feedback.set(null);
    request$.subscribe({
      next: () => {
        this.saving.set(false);
        this.confirming.set(false);
        this.form.reset({ employmentId: null });
        this.feedback.set(successKey);
        this.changed.emit();
      },
      error: (error: unknown) => {
        this.saving.set(false);
        this.confirming.set(false);
        this.formError.set(problemToForm(this.form, error, LINK_SLUGS, 'access.users.notFound'));
      },
    });
  }
}
