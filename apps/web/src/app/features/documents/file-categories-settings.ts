/**
 * The "File categories" tab of /documents/settings (`document.configure`): the categories of the employee file
 * (Diplômes, Contrats, Pièces d'identité, Médical, Autres… — docs/contracts/documents.md › Phase B › Data) with their
 * names in three languages, how long a file is kept after the end of employment, and whether the category is still
 * offered for new uploads. New categories are always `standard`: the medical class is fixed by the seed.
 *
 * Angular concepts (met before; this tab combines them):
 * - **One panel for create AND edit**, driven by `editing` (`null` / `'new'` / an id) — the Signatories tab's pattern.
 *   The `code` control exists only for a new category: it is DISABLED when editing, and a disabled control is left out
 *   of `form.value`, skipped by validation and rendered read-only by `formControlName` — the code of an existing
 *   category is its identity (files and permissions refer to it), so the API does not accept a change.
 * - **A nested group for the three labels** (`labels: {fr, ar, en}`) matches the API body shape one to one, so
 *   `getRawValue().labels` is sent as is (chapter 14).
 * - **`<input type="number">` → `number | null`** (the leave types table): an empty box is `null`, which the API reads
 *   as "keep forever"; `Validators.min/max` and an integer check cover the rest.
 * - The Dossier tab of an employee reads the categories itself when it opens, so no shared catalogue to reload here.
 */
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import {
  type AbstractControl,
  NonNullableFormBuilder,
  ReactiveFormsModule,
  type ValidationErrors,
  Validators,
} from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import { EmployeeFilesApi } from '../../core/employee-files/employee-files-api';
import type { EmployeeFileCategory } from '../../core/employee-files/employee-files.models';
import { type FormMessage, problemToForm, type SlugTable } from '../../core/http/problem-form';
import { LanguageService } from '../../core/i18n/language.service';
import { pickLabel } from '../../core/leave/leave-catalog';
import { CONFIG_SLUGS } from './document-forms';

export const CATEGORY_LABEL_MAX = 120;
/** Lower-case letters, digits and `_`, starting with a letter (like the seeded `id_document`). */
export const CATEGORY_CODE = /^[a-z][a-z0-9_]{1,39}$/;
export const RETENTION_MAX = 100;

export const CATEGORY_SLUGS: SlugTable = {
  ...CONFIG_SLUGS,
  'category-code-taken': { key: 'documents.fileCategories.codeTaken', field: 'code' },
};

function wholeYears(control: AbstractControl): ValidationErrors | null {
  const value: unknown = control.value;
  return value === null || value === '' || Number.isInteger(value) ? null : { integer: true };
}

@Component({
  selector: 'app-document-file-categories-settings',
  imports: [TranslocoDirective, ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './file-categories-settings.html',
  styleUrl: './documents.css',
})
export class FileCategoriesSettings {
  private readonly api = inject(EmployeeFilesApi);
  private readonly fb = inject(NonNullableFormBuilder);
  private readonly lang = inject(LanguageService).current;

  protected readonly categories = this.api.categoriesResource();
  protected readonly items = computed<readonly EmployeeFileCategory[]>(() =>
    this.categories.hasValue() ? this.categories.value().items : [],
  );

  /** `null` = panel closed · `'new'` = creating · an id = editing that category. */
  protected readonly editing = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly feedback = signal<string | null>(null);
  protected readonly formError = signal<FormMessage | null>(null);
  protected readonly retentionMax = RETENTION_MAX;
  protected readonly languages = ['fr', 'ar', 'en'] as const;

  private readonly label = [Validators.required, Validators.maxLength(CATEGORY_LABEL_MAX), Validators.pattern(/\S/)];
  protected readonly form = this.fb.group({
    code: ['', [Validators.required, Validators.pattern(CATEGORY_CODE)]],
    labels: this.fb.group({ fr: ['', this.label], ar: ['', this.label], en: ['', this.label] }),
    retentionYearsAfterEnd: this.fb.control<number | null>(null, [Validators.min(1), Validators.max(RETENTION_MAX), wholeYears]),
    active: [true],
  });

  protected name(category: EmployeeFileCategory): string {
    return pickLabel(category.labels, this.lang());
  }

  protected open(category: EmployeeFileCategory | null): void {
    this.feedback.set(null);
    this.formError.set(null);
    this.form.reset({
      code: category?.code ?? '',
      labels: { fr: category?.labels.fr ?? '', ar: category?.labels.ar ?? '', en: category?.labels.en ?? '' },
      retentionYearsAfterEnd: category?.retentionYearsAfterEnd ?? null,
      active: category?.active ?? true,
    });
    if (category) this.form.controls.code.disable();
    else this.form.controls.code.enable();
    this.editing.set(category?.id ?? 'new');
  }

  protected close(): void {
    this.editing.set(null);
  }

  protected save(): void {
    const editing = this.editing();
    this.formError.set(null);
    if (!editing) return;
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const v = this.form.getRawValue();
    const labels = { fr: v.labels.fr.trim(), ar: v.labels.ar.trim(), en: v.labels.en.trim() };
    const retentionYearsAfterEnd = v.retentionYearsAfterEnd ?? null;
    const request$ =
      editing === 'new'
        ? this.api.createCategory({ code: v.code.trim(), labels, retentionYearsAfterEnd })
        : this.api.updateCategory(editing, { labels, retentionYearsAfterEnd, active: v.active });
    this.saving.set(true);
    request$.subscribe({
      next: () => {
        this.saving.set(false);
        this.editing.set(null);
        this.feedback.set(editing === 'new' ? 'documents.fileCategories.created' : 'documents.fileCategories.saved');
        this.categories.reload();
      },
      error: (error: unknown) => {
        this.saving.set(false);
        this.formError.set(problemToForm(this.form, error, CATEGORY_SLUGS));
      },
    });
  }
}
