/**
 * The « Contrat » section of the create, rehire and hire forms: the initial contract, starting on the hire date
 * (docs/contracts/contracts-deadlines.md › Web builder 1). `<app-contract-fields [group]="form.controls.contract"
 * idPrefix="new" [start]="hireDate()" />`. In a hire, the type comes from the offer (`lockedType`) and only the end
 * and probation dates are sent, so the reference and the reason are not asked for (`hire`).
 */
import { ChangeDetectionStrategy, Component, computed, effect, input } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { ReactiveFormsModule } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import { of, startWith, switchMap } from 'rxjs';
import { CONTRACT_REASON_MAX, CONTRACT_REFERENCE_MAX, CONTRACT_TYPES, type ContractType, isFixedTerm } from '../../core/contracts/contracts.models';
import { type ContractFormGroup, probationLimit, revalidateDates } from './contract-forms';
import { FieldError } from './field-error';

@Component({
  selector: 'app-contract-fields',
  imports: [TranslocoDirective, ReactiveFormsModule, FieldError],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <fieldset *transloco="let t" class="section" data-section="contract" [formGroup]="group()">
      <legend>{{ t('contracts.form.legend') }}</legend>
      @let c = group().controls;
      @let id = idPrefix();
      <div class="grid">
        <div class="field">
          <label [for]="id + '-contract-type'">{{ t('contracts.fields.contractType') }}</label>
          <select [id]="id + '-contract-type'" formControlName="contractType" required
            [attr.aria-invalid]="c.contractType.invalid && c.contractType.touched" [attr.aria-describedby]="id + '-contract-type-error ' + id + '-contract-type-hint'">
            <option value="" disabled>{{ t('contracts.form.typePlaceholder') }}</option>
            @for (type of types; track type) {
              <option [value]="type">{{ t('contracts.type.' + type) }}</option>
            }
          </select>
          @if (lockedType()) {
            <p class="field-hint" [id]="id + '-contract-type-hint'">{{ t('contracts.form.typeFromOffer') }}</p>
          }
          <app-field-error [control]="c.contractType" [errorId]="id + '-contract-type-error'" />
        </div>
        @if (fixedTerm()) {
          <div class="field">
            <label [for]="id + '-contract-end'">{{ t('contracts.fields.endDate') }}</label>
            <input [id]="id + '-contract-end'" type="date" formControlName="endDate" aria-required="true" [min]="start() ?? ''"
              [attr.aria-invalid]="c.endDate.invalid && c.endDate.touched" [attr.aria-describedby]="id + '-contract-end-hint ' + id + '-contract-end-error'" />
            <p class="field-hint" [id]="id + '-contract-end-hint'">{{ t('contracts.form.endHint') }}</p>
            <app-field-error [control]="c.endDate" [errorId]="id + '-contract-end-error'" />
          </div>
        }
        <div class="field">
          <label [for]="id + '-contract-probation'">{{ t('contracts.fields.probationEnd') }} <span class="field-hint">{{ t('employees.form.optional') }}</span></label>
          <input [id]="id + '-contract-probation'" type="date" formControlName="probationEnd" [min]="start() ?? ''" [max]="probationMax() ?? ''"
            [attr.aria-invalid]="c.probationEnd.invalid && c.probationEnd.touched" [attr.aria-describedby]="id + '-contract-probation-hint ' + id + '-contract-probation-error'" />
          <p class="field-hint" [id]="id + '-contract-probation-hint'">{{ t('contracts.form.probationHint') }}</p>
          <app-field-error [control]="c.probationEnd" [errorId]="id + '-contract-probation-error'" />
        </div>
        @if (!hire()) {
          <div class="field">
            <label [for]="id + '-contract-reference'">{{ t('contracts.fields.reference') }} <span class="field-hint">{{ t('employees.form.optional') }}</span></label>
            <input [id]="id + '-contract-reference'" type="text" formControlName="reference" autocomplete="off" dir="auto" [maxlength]="referenceMax"
              [attr.aria-invalid]="c.reference.invalid && c.reference.touched" [attr.aria-describedby]="id + '-contract-reference-error'" />
            <app-field-error [control]="c.reference" [errorId]="id + '-contract-reference-error'" />
          </div>
          @if (fixedTerm()) {
            <div class="field">
              <label [for]="id + '-contract-reason'">{{ t('contracts.fields.reason') }} <span class="field-hint">{{ t('employees.form.optional') }}</span></label>
              <input [id]="id + '-contract-reason'" type="text" formControlName="reason" autocomplete="off" dir="auto" [maxlength]="reasonMax"
                [attr.aria-invalid]="c.reason.invalid && c.reason.touched" [attr.aria-describedby]="id + '-contract-reason-hint ' + id + '-contract-reason-error'" />
              <p class="field-hint" [id]="id + '-contract-reason-hint'">{{ t('contracts.form.reasonHint') }}</p>
              <app-field-error [control]="c.reason" [errorId]="id + '-contract-reason-error'" />
            </div>
          }
        }
      </div>
      <p class="field-hint">{{ t('contracts.form.startsOnHire') }}</p>
    </fieldset>
  `,
  styleUrl: './employees.css',
})
export class ContractFields {
  readonly group = input.required<ContractFormGroup>();
  /** Prefix of the element ids (`new`, `rehire`): two forms of the feature never share an id. */
  readonly idPrefix = input.required<string>();
  /** The contract start (the hire date): bounds of the end and probation dates. */
  readonly start = input<string | null>(null);
  /** A recruitment hire: the reference and the reason are not sent. */
  readonly hire = input(false);
  /** The offer's contract type, when known: preset and not editable. */
  readonly lockedType = input<ContractType | null>(null);

  protected readonly types = CONTRACT_TYPES;
  protected readonly referenceMax = CONTRACT_REFERENCE_MAX;
  protected readonly reasonMax = CONTRACT_REASON_MAX;

  private readonly type = toSignal(
    toObservable(this.group).pipe(switchMap((g) => g?.controls.contractType.valueChanges.pipe(startWith(g.controls.contractType.value)) ?? of(''))),
    { initialValue: '' as ContractType | '' },
  );
  protected readonly fixedTerm = computed(() => isFixedTerm(this.type()));
  protected readonly probationMax = computed(() => {
    const start = this.start();
    return start ? probationLimit(start) : null;
  });

  constructor() {
    effect(() => {
      const locked = this.lockedType();
      const control = this.group().controls.contractType;
      if (locked) {
        if (control.value !== locked) control.setValue(locked);
        if (control.enabled) control.disable();
      } else if (control.disabled) {
        control.enable();
      }
    });
    // A new hire date moves the bounds of the end and probation dates.
    effect(() => {
      this.start();
      revalidateDates(this.group());
    });
  }
}
