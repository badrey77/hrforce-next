import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import type { FormMessage } from '../../core/http/problem-form';
import { LanguageService } from '../../core/i18n/language.service';
import { pickLabel } from '../../core/leave/leave-catalog';
import { RecruitmentApi } from '../../core/recruitment/recruitment-api';
import { type CriterionView, LABEL_MAX, REASON_CODE_PATTERN } from '../../core/recruitment/recruitment.models';
import { ControlError } from '../../shared/attendance/control-error';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';
import { ERROR_KEYS, recruitmentProblemToForm, text, wholeNumber } from './recruitment-forms';

const SORT_MAX = 9999;
const KEYS = { ...ERROR_KEYS, pattern: 'recruitment.settings.reasons.codeHint' };

/**
 * The company's evaluation criteria: labels, order and activation. An opening copies the active ones when it opens,
 * so a change here applies to the openings approved afterwards.
 */
@Component({
  selector: 'app-recruitment-criteria-settings',
  imports: [TranslocoDirective, ReactiveFormsModule, ControlError, RevealAlert],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './criteria-settings.html',
  styleUrl: './recruitment.css',
})
export class CriteriaSettings {
  private readonly api = inject(RecruitmentApi);
  private readonly fb = inject(NonNullableFormBuilder);
  private readonly lang = inject(LanguageService).current;

  protected readonly list = this.api.criteriaResource();
  protected readonly items = computed<readonly CriterionView[]>(() => (this.list.hasValue() ? this.list.value().items : []));
  /** `'new'`, a criterion id, or null when no form is open. */
  protected readonly editing = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly feedback = signal<string | null>(null);
  protected readonly formError = signal<FormMessage | null>(null);
  protected readonly errorKeys = KEYS;

  protected readonly form = this.fb.group({
    code: ['', [Validators.required, Validators.pattern(REASON_CODE_PATTERN)]],
    fr: ['', text(1, LABEL_MAX)],
    ar: ['', text(1, LABEL_MAX)],
    en: ['', text(1, LABEL_MAX)],
    sortOrder: [0, wholeNumber(0, SORT_MAX)],
    active: [true],
  });

  protected label(criterion: CriterionView): string {
    return pickLabel(criterion.labels, this.lang());
  }

  protected open(criterion: CriterionView | null): void {
    this.feedback.set(null);
    this.formError.set(null);
    const { code } = this.form.controls;
    if (criterion) {
      this.form.reset({ code: criterion.code, ...criterion.labels, sortOrder: criterion.sortOrder, active: criterion.active });
      code.disable(); // the code is immutable
    } else {
      this.form.reset({ code: '', fr: '', ar: '', en: '', sortOrder: 0, active: true });
      code.enable();
    }
    this.editing.set(criterion?.id ?? 'new');
  }

  protected save(): void {
    this.formError.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const id = this.editing();
    const v = this.form.getRawValue();
    const labels = { fr: v.fr.trim(), ar: v.ar.trim(), en: v.en.trim() };
    this.saving.set(true);
    const request$ =
      id === 'new' || id === null
        ? this.api.createCriterion({ code: v.code.trim(), labels })
        : this.api.updateCriterion(id, { labels, active: v.active, sortOrder: Number(v.sortOrder) });
    request$.subscribe({
      next: () => {
        this.saving.set(false);
        this.editing.set(null);
        this.feedback.set('recruitment.settings.saved');
        this.list.reload();
      },
      error: (error: unknown) => {
        this.saving.set(false);
        this.formError.set(recruitmentProblemToForm(this.form, error));
      },
    });
  }
}
