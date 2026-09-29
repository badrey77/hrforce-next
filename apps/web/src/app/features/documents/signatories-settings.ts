/**
 * The "Signatories" tab of /documents/settings (`document.configure`): who signs documents, for the whole company or
 * for a unit and its sub-units (contract assumption 8), with name and title in French and Arabic. Signatories are
 * never deleted: they are deactivated (issued documents keep pointing at them).
 *
 * Angular concepts:
 * - **One form for create AND edit**, driven by an `editing` signal (`null` closed, `'new'`, or the edited id) — the
 *   leave types table's inline-edit idea, as a panel above the table (the form is too wide for a table row on a phone).
 * - **A radio pair that enables a control.** "Whole company" / "A unit" is a `scope` control; the unit picker's
 *   control is enabled only for `'unit'`, from `scope.valueChanges`. A disabled control is valid by definition, so
 *   `Validators.required` on the unit only bites when a unit is actually asked for.
 * - **The org-unit picker is a ControlValueAccessor** (shared/org-unit-picker): `formControlName="orgUnitId"` is all it
 *   takes, exactly like a text input.
 * - **PATCH sends only what the form holds**; the table reloads from the server afterwards (`reload()`), which also
 *   refreshes `defaultFor` if the Types tab changed defaults meanwhile.
 */
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import { DocumentCatalog } from '../../core/documents/document-catalog';
import { DocumentsApi } from '../../core/documents/documents-api';
import type { SignatoryView } from '../../core/documents/documents.models';
import { type FormMessage, problemToForm } from '../../core/http/problem-form';
import { LanguageService } from '../../core/i18n/language.service';
import { displayNameOf } from '../../shared/display-name/display-name.pipe';
import { OrgUnitPicker } from '../../shared/org-unit-picker/org-unit-picker';
import { CONFIG_SLUGS } from './document-forms';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';

export const SIGNATORY_TEXT_MAX = 120;

@Component({
  selector: 'app-document-signatories-settings',
  imports: [RevealAlert, TranslocoDirective, ReactiveFormsModule, OrgUnitPicker],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './signatories-settings.html',
  styleUrl: './documents.css',
})
export class SignatoriesSettings {
  private readonly api = inject(DocumentsApi);
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly catalog = inject(DocumentCatalog);
  private readonly lang = inject(LanguageService).current;

  protected readonly signatories = this.api.settingsSignatoriesResource();
  protected readonly items = computed<readonly SignatoryView[]>(() => (this.signatories.hasValue() ? this.signatories.value().items : []));

  /** `null` = form closed · `'new'` = creating · an id = editing that signatory. */
  protected readonly editing = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly feedback = signal<string | null>(null);
  protected readonly formError = signal<FormMessage | null>(null);

  private readonly text = [Validators.required, Validators.maxLength(SIGNATORY_TEXT_MAX), Validators.pattern(/\S/)];
  protected readonly form = this.fb.group({
    scope: this.fb.control<'company' | 'unit'>('company'),
    orgUnitId: this.fb.control<string | null>({ value: null, disabled: true }, Validators.required),
    nameFr: ['', this.text],
    nameAr: ['', this.text],
    titleFr: ['', this.text],
    titleAr: ['', this.text],
    active: [true],
  });

  constructor() {
    this.form.controls.scope.valueChanges.pipe(takeUntilDestroyed()).subscribe((scope) => {
      const unit = this.form.controls.orgUnitId;
      if (scope === 'unit') unit.enable();
      else unit.disable();
    });
  }

  protected scopeLabel(s: SignatoryView): string {
    return s.unit ? displayNameOf(s.unit, this.lang()) : '';
  }

  protected open(s: SignatoryView | null): void {
    this.feedback.set(null);
    this.formError.set(null);
    this.form.reset({
      scope: s?.unit ? 'unit' : 'company',
      orgUnitId: s?.unit?.id ?? null,
      nameFr: s?.names.fr ?? '',
      nameAr: s?.names.ar ?? '',
      titleFr: s?.titles.fr ?? '',
      titleAr: s?.titles.ar ?? '',
      active: s?.active ?? true,
    });
    this.editing.set(s?.id ?? 'new');
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
    const common = {
      orgUnitId: v.scope === 'unit' ? v.orgUnitId : null,
      names: { fr: v.nameFr.trim(), ar: v.nameAr.trim() },
      titles: { fr: v.titleFr.trim(), ar: v.titleAr.trim() },
    };
    const request$ = editing === 'new' ? this.api.createSignatory(common) : this.api.updateSignatory(editing, { ...common, active: v.active });
    this.saving.set(true);
    request$.subscribe({
      next: () => {
        this.saving.set(false);
        this.editing.set(null);
        this.feedback.set(editing === 'new' ? 'documents.signatories.created' : 'documents.signatories.saved');
        this.signatories.reload();
      },
      error: (error: unknown) => {
        this.saving.set(false);
        this.formError.set(problemToForm(this.form, error, CONFIG_SLUGS));
      },
    });
  }
}
