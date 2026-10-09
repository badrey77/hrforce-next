import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { type FormControl, type FormGroup, type NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import { algiersToday } from '../../core/attendance/attendance.models';
import { BIRTH_PLACE_MAX, type CandidateView, EMAIL_MAX, NAME_MAX, PHONE_MAX } from '../../core/recruitment/recruitment.models';
import { ControlError } from '../../shared/attendance/control-error';
import { type CandidateFormValue, emailLike, ERROR_KEYS, isoDate, NAME_VALIDATOR, nin, notAfterDay, text } from './recruitment-forms';

export type CandidateForm = FormGroup<{ [K in keyof CandidateFormValue]: FormControl<CandidateFormValue[K]> }>;

const today = (): string => algiersToday();

export function candidateForm(fb: NonNullableFormBuilder): CandidateForm {
  return fb.group({
    lastName: ['', NAME_VALIDATOR],
    firstName: ['', NAME_VALIDATOR],
    lastNameAr: ['', text(1, NAME_MAX, false)],
    firstNameAr: ['', text(1, NAME_MAX, false)],
    birthDate: ['', [isoDate, notAfterDay(today)]],
    birthPlace: ['', text(1, BIRTH_PLACE_MAX, false)],
    sex: fb.control<'' | 'M' | 'F'>(''),
    nationality: ['DZ', text(2, 2)],
    nin: ['', nin],
    email: ['', [emailLike, text(3, EMAIL_MAX, false)]],
    phone: ['', text(1, PHONE_MAX, false)],
    informedOn: ['', [isoDate, notAfterDay(today)]],
  });
}

export function candidateFormValue(candidate: CandidateView): CandidateFormValue {
  return {
    lastName: candidate.person.lastName,
    firstName: candidate.person.firstName,
    lastNameAr: candidate.person.lastNameAr ?? '',
    firstNameAr: candidate.person.firstNameAr ?? '',
    birthDate: candidate.birthDate ?? '',
    birthPlace: candidate.birthPlace ?? '',
    sex: candidate.sex ?? '',
    nationality: candidate.nationality,
    nin: candidate.nin ?? '',
    email: candidate.email ?? '',
    phone: candidate.phone ?? '',
    informedOn: candidate.informedOn ?? '',
  };
}

/** The identity and contact fields of a candidate, shared by the add flow and the candidate page. */
@Component({
  selector: 'app-candidate-fields',
  imports: [TranslocoDirective, ReactiveFormsModule, ControlError],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-container *transloco="let t" [formGroup]="form()">
      @let c = form().controls;
      @let p = idPrefix();
      <div class="grid">
        <div class="field">
          <label [for]="p + '-last-name'">{{ t('employees.fields.lastName') }}</label>
          <input [id]="p + '-last-name'" type="text" formControlName="lastName" required autocomplete="off" (blur)="lookup.emit()"
            [attr.aria-invalid]="c.lastName.invalid && c.lastName.touched" [attr.aria-describedby]="p + '-last-name-error'" />
          <app-control-error [control]="c.lastName" [errorId]="p + '-last-name-error'" [keys]="keys" />
        </div>
        <div class="field">
          <label [for]="p + '-first-name'">{{ t('employees.fields.firstName') }}</label>
          <input [id]="p + '-first-name'" type="text" formControlName="firstName" required autocomplete="off" (blur)="lookup.emit()"
            [attr.aria-invalid]="c.firstName.invalid && c.firstName.touched" [attr.aria-describedby]="p + '-first-name-error'" />
          <app-control-error [control]="c.firstName" [errorId]="p + '-first-name-error'" [keys]="keys" />
        </div>
        <div class="field">
          <label [for]="p + '-last-name-ar'">{{ t('employees.fields.lastNameAr') }}</label>
          <input [id]="p + '-last-name-ar'" type="text" formControlName="lastNameAr" lang="ar" dir="rtl" autocomplete="off" [attr.aria-describedby]="p + '-last-name-ar-error'" />
          <app-control-error [control]="c.lastNameAr" [errorId]="p + '-last-name-ar-error'" [keys]="keys" />
        </div>
        <div class="field">
          <label [for]="p + '-first-name-ar'">{{ t('employees.fields.firstNameAr') }}</label>
          <input [id]="p + '-first-name-ar'" type="text" formControlName="firstNameAr" lang="ar" dir="rtl" autocomplete="off" [attr.aria-describedby]="p + '-first-name-ar-error'" />
          <app-control-error [control]="c.firstNameAr" [errorId]="p + '-first-name-ar-error'" [keys]="keys" />
        </div>
        <div class="field">
          <label [for]="p + '-birth-date'">{{ t('employees.fields.birthDate') }}</label>
          <input [id]="p + '-birth-date'" type="date" formControlName="birthDate" (blur)="lookup.emit()"
            [attr.aria-invalid]="c.birthDate.invalid && c.birthDate.touched" [attr.aria-describedby]="p + '-birth-date-error'" />
          <app-control-error [control]="c.birthDate" [errorId]="p + '-birth-date-error'" [keys]="keys" />
        </div>
        <div class="field">
          <label [for]="p + '-birth-place'">{{ t('employees.fields.birthPlace') }}</label>
          <input [id]="p + '-birth-place'" type="text" formControlName="birthPlace" dir="auto" autocomplete="off" [attr.aria-describedby]="p + '-birth-place-error'" />
          <app-control-error [control]="c.birthPlace" [errorId]="p + '-birth-place-error'" [keys]="keys" />
        </div>
        <div class="field">
          <label [for]="p + '-sex'">{{ t('employees.fields.sex') }}</label>
          <select [id]="p + '-sex'" formControlName="sex">
            <option value="">{{ t('recruitment.candidate.sexUnknown') }}</option>
            <option value="F">{{ t('recruitment.candidate.sex.F') }}</option>
            <option value="M">{{ t('recruitment.candidate.sex.M') }}</option>
          </select>
        </div>
        <div class="field">
          <label [for]="p + '-nationality'">{{ t('employees.fields.nationality') }}</label>
          <input [id]="p + '-nationality'" class="uppercase" type="text" formControlName="nationality" maxlength="2" dir="ltr" autocomplete="off"
            [attr.aria-invalid]="c.nationality.invalid && c.nationality.touched" [attr.aria-describedby]="p + '-nationality-error'" />
          <app-control-error [control]="c.nationality" [errorId]="p + '-nationality-error'" [keys]="keys" />
        </div>
        <div class="field">
          <label [for]="p + '-nin'">{{ t('employees.fields.nin') }}</label>
          <input [id]="p + '-nin'" type="text" inputmode="numeric" formControlName="nin" dir="ltr" autocomplete="off" (blur)="lookup.emit()"
            [attr.aria-invalid]="c.nin.invalid && c.nin.touched" [attr.aria-describedby]="p + '-nin-error'" />
          <app-control-error [control]="c.nin" [errorId]="p + '-nin-error'" [keys]="keys" />
        </div>
        <div class="field">
          <label [for]="p + '-email'">{{ t('recruitment.candidate.email') }}</label>
          <input [id]="p + '-email'" type="email" formControlName="email" dir="ltr" autocomplete="off" (blur)="lookup.emit()"
            [attr.aria-invalid]="c.email.invalid && c.email.touched" [attr.aria-describedby]="p + '-email-error'" />
          <app-control-error [control]="c.email" [errorId]="p + '-email-error'" [keys]="keys" />
        </div>
        <div class="field">
          <label [for]="p + '-phone'">{{ t('recruitment.candidate.phone') }}</label>
          <input [id]="p + '-phone'" type="tel" formControlName="phone" dir="ltr" autocomplete="off" (blur)="lookup.emit()"
            [attr.aria-invalid]="c.phone.invalid && c.phone.touched" [attr.aria-describedby]="p + '-phone-error'" />
          <app-control-error [control]="c.phone" [errorId]="p + '-phone-error'" [keys]="keys" />
        </div>
        @if (withInformedOn()) {
          <div class="field">
            <label [for]="p + '-informed-on'">{{ t('recruitment.candidate.informedOn') }}</label>
            <input [id]="p + '-informed-on'" type="date" formControlName="informedOn"
              [attr.aria-invalid]="c.informedOn.invalid && c.informedOn.touched" [attr.aria-describedby]="p + '-informed-on-error'" />
            <app-control-error [control]="c.informedOn" [errorId]="p + '-informed-on-error'" [keys]="keys" />
          </div>
        }
      </div>
    </ng-container>
  `,
  styles: `
    :host { display: block; }
  `,
})
export class CandidateFields {
  readonly form = input.required<CandidateForm>();
  readonly idPrefix = input('cand');
  readonly withInformedOn = input(true);
  /** A field that identifies a person lost focus: the host may look for an existing record. */
  readonly lookup = output<void>();

  protected readonly keys = ERROR_KEYS;
}
