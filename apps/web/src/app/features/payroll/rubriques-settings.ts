/**
 * « Rubriques » tab of /payroll/settings: every rubrique (computed ones per source, one per leave type, and the
 * manual ones typed by HR) with its export code, names, unit, activation and order; « Nouvelle rubrique saisie »
 * opens a dialog (source `manual`). The unit of a computed rubrique is fixed by its source.
 */
import { ChangeDetectionStrategy, Component, computed, type ElementRef, inject, signal, viewChild } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import type { FormMessage } from '../../core/http/problem-form';
import { LanguageService } from '../../core/i18n/language.service';
import { pickLabel } from '../../core/leave/leave-catalog';
import { PayrollApi } from '../../core/payroll/payroll-api';
import { PAYROLL_CODE_PATTERN, PAYROLL_UNITS, type PayrollUnit, type RubriqueView } from '../../core/payroll/payroll.models';
import { ControlError } from '../../shared/attendance/control-error';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';
import { PAYROLL_ERROR_KEYS, requiredText, settingsProblemToForm, wholeNumberBetween } from './payroll-settings-forms';

export const NAME_MAX = 80;
export const SORT_ORDER_MAX = 9999;

@Component({
  selector: 'app-payroll-rubriques-settings',
  imports: [TranslocoDirective, ReactiveFormsModule, ControlError, RevealAlert],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './rubriques-settings.html',
  styleUrl: './payroll-settings.css',
})
export class RubriquesSettings {
  private readonly api = inject(PayrollApi);
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly lang = inject(LanguageService).current;
  protected readonly units = PAYROLL_UNITS;
  protected readonly errorKeys = PAYROLL_ERROR_KEYS;

  protected readonly list = this.api.rubriquesResource();
  protected readonly items = computed<readonly RubriqueView[]>(() => (this.list.hasValue() ? this.list.value().items : []));

  /** The rubrique being edited inline, or null. */
  protected readonly editing = signal<RubriqueView | null>(null);
  protected readonly saving = signal(false);
  protected readonly feedback = signal<string | null>(null);
  protected readonly formError = signal<FormMessage | null>(null);
  protected readonly createError = signal<FormMessage | null>(null);

  private readonly createDialog = viewChild.required<ElementRef<HTMLDialogElement>>('createDialog');

  private names() {
    return {
      fr: this.fb.control('', requiredText(NAME_MAX)),
      ar: this.fb.control('', requiredText(NAME_MAX)),
      en: this.fb.control('', requiredText(NAME_MAX)),
    };
  }

  protected readonly form = this.fb.group({
    exportCode: ['', [Validators.required, Validators.pattern(PAYROLL_CODE_PATTERN)]],
    ...this.names(),
    unit: this.fb.control<PayrollUnit>('days'),
    sortOrder: [0, wholeNumberBetween(0, SORT_ORDER_MAX)],
    active: [true],
  });

  protected readonly createForm = this.fb.group({
    exportCode: ['', [Validators.required, Validators.pattern(PAYROLL_CODE_PATTERN)]],
    ...this.names(),
    unit: this.fb.control<PayrollUnit>('amount'),
  });

  protected name(rubrique: RubriqueView): string {
    return pickLabel(rubrique.names, this.lang());
  }

  protected sourceLabel(rubrique: RubriqueView): string | null {
    return rubrique.leaveType ? pickLabel(rubrique.leaveType.labels, this.lang()) : null;
  }

  protected edit(rubrique: RubriqueView): void {
    this.feedback.set(null);
    this.formError.set(null);
    this.form.reset({
      exportCode: rubrique.exportCode,
      ...rubrique.names,
      unit: rubrique.unit,
      sortOrder: rubrique.sortOrder,
      active: rubrique.active,
    });
    // The unit of a computed rubrique follows its source.
    if (rubrique.source === 'manual') this.form.controls.unit.enable();
    else this.form.controls.unit.disable();
    this.editing.set(rubrique);
  }

  protected cancel(): void {
    this.editing.set(null);
    this.formError.set(null);
  }

  protected save(): void {
    const rubrique = this.editing();
    if (!rubrique) return;
    this.formError.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const v = this.form.getRawValue();
    this.saving.set(true);
    this.api
      .updateRubrique(rubrique.id, {
        exportCode: v.exportCode.trim(),
        names: { fr: v.fr.trim(), ar: v.ar.trim(), en: v.en.trim() },
        ...(rubrique.source === 'manual' ? { unit: v.unit } : {}),
        active: v.active,
        sortOrder: Number(v.sortOrder),
      })
      .subscribe({
        next: () => {
          this.saving.set(false);
          this.editing.set(null);
          this.feedback.set('payroll.settings.saved');
          this.list.reload();
        },
        error: (error: unknown) => {
          this.saving.set(false);
          this.formError.set(settingsProblemToForm(this.form, error));
        },
      });
  }

  protected openCreate(): void {
    this.feedback.set(null);
    this.createError.set(null);
    this.createForm.reset({ exportCode: '', fr: '', ar: '', en: '', unit: 'amount' });
    this.createDialog().nativeElement.showModal();
  }

  protected closeCreate(): void {
    this.createDialog().nativeElement.close();
  }

  protected create(): void {
    this.createError.set(null);
    if (this.createForm.invalid) {
      this.createForm.markAllAsTouched();
      return;
    }
    const v = this.createForm.getRawValue();
    this.saving.set(true);
    this.api
      .createRubrique({ exportCode: v.exportCode.trim(), names: { fr: v.fr.trim(), ar: v.ar.trim(), en: v.en.trim() }, unit: v.unit })
      .subscribe({
        next: () => {
          this.saving.set(false);
          this.closeCreate();
          this.feedback.set('payroll.settings.rubriques.created');
          this.list.reload();
        },
        error: (error: unknown) => {
          this.saving.set(false);
          this.createError.set(settingsProblemToForm(this.createForm, error));
        },
      });
  }
}
