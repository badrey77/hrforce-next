/**
 * The "Types" tab of /documents/settings (`document.configure`): per document type, the number format with a LIVE
 * preview of the next number, the languages it is printed in, self-service (attestation only), the default signatory
 * and whether it is active (docs/contracts/documents.md › Numbering, Web › Settings).
 *
 * Angular concepts:
 * - **A live preview computed on the client.** `format` is the format control as a signal (`toSignal(valueChanges)`);
 *   `preview` is a `computed()` of it and of the edited type: the API's `nextNumber` is parsed back with the STORED
 *   format (year + sequence), then re-rendered with the format being typed (`renderNumber`, core/documents). No
 *   request per keystroke — the rule is small and pure, and the server re-checks it on save (422 `invalid_format`,
 *   409 `document-format-taken`).
 * - **A custom validator from a pure function**: `numberFormat` wraps `numberFormatError()` so the same rule drives
 *   the error message and the preview (no preview for an invalid format).
 * - **A `FormGroup` validator across two checkboxes**: "at least one language" belongs to the `languages` group, not to
 *   either box.
 * - **Reload the shared catalogue after a save** (`DocumentCatalog.reload()`): the register filter, the issue page and
 *   My documents read the same root resource (the leave types settings' pattern).
 */
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  type AbstractControl,
  NonNullableFormBuilder,
  ReactiveFormsModule,
  type ValidationErrors,
} from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import { todayIso } from '../../core/date/iso-date';
import { DocumentCatalog } from '../../core/documents/document-catalog';
import { DocumentsApi } from '../../core/documents/documents-api';
import {
  type DocumentLanguage,
  type DocumentTypeView,
  numberFormatError,
  parseNumber,
  renderNumber,
  type SignatoryView,
  type UpdateDocumentType,
} from '../../core/documents/documents.models';
import { type FormMessage, problemToForm } from '../../core/http/problem-form';
import { CONFIG_SLUGS } from './document-forms';

/** The only type employees may request themselves (contract: `selfService` is refused on the others). */
export const SELF_SERVICE_TYPE = 'attestation_travail';

/**
 * The format as it will be saved: trimmed and in capitals. The input only SHOWS capitals (`class="uppercase"`, a CSS
 * `text-transform`, styles.css) so the caret does not jump while typing; the value keeps what was typed. Without this,
 * `att-{yyyy}-{seq:5}` would look like `ATT-{YYYY}-{SEQ:5}` on screen and still be refused (the API does not
 * upper-case formats), so the validator, the preview and the request all read the normalised value.
 */
export function normalizeFormat(value: string): string {
  return value.trim().toUpperCase();
}

export function numberFormat(control: AbstractControl): ValidationErrors | null {
  const value = typeof control.value === 'string' ? normalizeFormat(control.value) : '';
  if (!value) return { required: true };
  const error = numberFormatError(value);
  return error ? { numberFormat: error } : null;
}

function atLeastOne(group: AbstractControl): ValidationErrors | null {
  const value = group.value as Record<string, boolean>;
  return Object.values(value).some(Boolean) ? null : { languages: true };
}

@Component({
  selector: 'app-document-types-settings',
  imports: [TranslocoDirective, ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './types-settings.html',
  styleUrl: './documents.css',
})
export class TypesSettings {
  private readonly api = inject(DocumentsApi);
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly catalog = inject(DocumentCatalog);
  protected readonly selfServiceType = SELF_SERVICE_TYPE;

  private readonly signatories = this.api.settingsSignatoriesResource();
  protected readonly activeSignatories = computed<readonly SignatoryView[]>(() =>
    this.signatories.hasValue() ? this.signatories.value().items.filter((s) => s.active) : [],
  );
  private readonly signatoryNames = computed(() => new Map((this.signatories.hasValue() ? this.signatories.value().items : []).map((s) => [s.id, s.names])));

  protected readonly editing = signal<DocumentTypeView | null>(null);
  protected readonly saving = signal(false);
  protected readonly feedback = signal<string | null>(null);
  protected readonly formError = signal<FormMessage | null>(null);

  protected readonly form = this.fb.group({
    numberFormat: ['', numberFormat],
    languages: this.fb.group({ fr: [true], ar: [true] }, { validators: atLeastOne }),
    selfService: [false],
    defaultSignatoryId: [''],
    active: [true],
  });

  private readonly format = toSignal(this.form.controls.numberFormat.valueChanges, { initialValue: '' });

  /** The next number under the format being typed, or `null` when the format is invalid. */
  protected readonly preview = computed(() => {
    const type = this.editing();
    const format = normalizeFormat(this.format());
    if (!type || !format || numberFormatError(format)) return null;
    const parsed = type.numberFormat && type.nextNumber ? parseNumber(type.numberFormat, type.nextNumber) : null;
    const year = parsed?.year ?? Number(todayIso().slice(0, 4));
    return renderNumber(format, year, parsed?.seq ?? 1);
  });

  protected signatoryName(id: string | null): string {
    const names = id ? this.signatoryNames().get(id) : undefined;
    return names ? names.fr : '—';
  }

  protected edit(type: DocumentTypeView): void {
    this.feedback.set(null);
    this.formError.set(null);
    this.form.reset({
      numberFormat: type.numberFormat ?? '',
      languages: { fr: type.languages.includes('fr'), ar: type.languages.includes('ar') },
      selfService: type.selfService,
      defaultSignatoryId: type.defaultSignatoryId ?? '',
      active: type.active,
    });
    this.editing.set(type);
  }

  protected cancel(): void {
    this.editing.set(null);
  }

  protected save(): void {
    const type = this.editing();
    this.formError.set(null);
    if (!type) return;
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const v = this.form.getRawValue();
    const languages = (['fr', 'ar'] as const).filter((l) => v.languages[l]) as DocumentLanguage[];
    const body: UpdateDocumentType = {
      numberFormat: normalizeFormat(v.numberFormat),
      languages,
      ...(type.code === SELF_SERVICE_TYPE ? { selfService: v.selfService } : {}),
      defaultSignatoryId: v.defaultSignatoryId || null,
      active: v.active,
    };
    this.saving.set(true);
    this.api.updateType(type.id, body).subscribe({
      next: () => {
        this.saving.set(false);
        this.editing.set(null);
        this.feedback.set('documents.types.saved');
        this.catalog.reload();
        this.signatories.reload();
      },
      error: (error: unknown) => {
        this.saving.set(false);
        this.formError.set(problemToForm(this.form, error, CONFIG_SLUGS));
      },
    });
  }
}
