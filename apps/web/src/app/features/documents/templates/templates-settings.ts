/**
 * The « Modèles » tab of /documents/settings (`document.design`; docs/contracts/document-templates.md › Web): one row
 * per document type with its template (built-in or a published version), a draft badge, « Concevoir », « Aperçu »
 * and « Revenir au modèle intégré »; and « Nouveau type de document » for holders of `document.configure`.
 */
import { ChangeDetectionStrategy, Component, computed, effect, type ElementRef, inject, signal, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { type AbstractControl, NonNullableFormBuilder, ReactiveFormsModule, type ValidationErrors, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { catchError, forkJoin, map, of } from 'rxjs';
import { Session } from '../../../core/auth/session';
import { BlobFiles } from '../../../core/browser/blob-files';
import { todayIso } from '../../../core/date/iso-date';
import { DocumentCatalog } from '../../../core/documents/document-catalog';
import { DocumentsApi } from '../../../core/documents/documents-api';
import {
  CUSTOM_TYPE_CODE,
  DOCUMENT_SUBJECTS,
  DOCUMENT_TYPE_CODES,
  type DocumentLanguage,
  type DocumentSubject,
  type DocumentTypeView,
  EMPLOYMENT_RULES,
  type EmploymentRule,
  renderNumber,
  type TypeTemplates,
} from '../../../core/documents/documents.models';
import { type FormMessage, problemToForm, type SlugTable } from '../../../core/http/problem-form';
import { LanguageService } from '../../../core/i18n/language.service';
import { RevealAlert } from '../../../shared/reveal-alert/reveal-alert.directive';
import { pdfErrorKey } from '../../../shared/documents/pdf-actions';
import { normalizeFormat, numberFormat } from '../types-settings';

export const NEW_TYPE_SLUGS: SlugTable = {
  'document-type-code-taken': { key: 'documents.templates.problems.codeTaken', field: 'code' },
  'document-format-taken': { key: 'documents.problems.formatTaken', field: 'numberFormat' },
  'forbidden-scope': { key: 'documents.problems.companyWide' },
};

export const REVERT_SLUGS: SlugTable = {
  'document-template-no-builtin': { key: 'documents.templates.problems.noBuiltin' },
  'forbidden-scope': { key: 'documents.problems.companyWide' },
};

/** A custom type code: format, and not one of the three system codes. */
export function customCode(control: AbstractControl): ValidationErrors | null {
  const value = typeof control.value === 'string' ? control.value.trim() : '';
  if (!value) return { required: true };
  if (!CUSTOM_TYPE_CODE.test(value)) return { code: true };
  return (DOCUMENT_TYPE_CODES as readonly string[]).includes(value) ? { reserved: true } : null;
}

function atLeastOne(group: AbstractControl): ValidationErrors | null {
  return Object.values(group.value as Record<string, boolean>).some(Boolean) ? null : { languages: true };
}

/** The language a preview of `type` uses: the UI language when the type is printed in it. */
export function previewLanguage(type: Pick<DocumentTypeView, 'languages'>, ui: string): DocumentLanguage {
  const preferred: DocumentLanguage = ui === 'ar' ? 'ar' : 'fr';
  return type.languages.includes(preferred) ? preferred : (type.languages[0] ?? 'fr');
}

@Component({
  selector: 'app-document-templates-settings',
  imports: [TranslocoDirective, ReactiveFormsModule, RouterLink, RevealAlert],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [BlobFiles],
  templateUrl: './templates-settings.html',
  styleUrl: '../documents.css',
})
export class TemplatesSettings {
  private readonly api = inject(DocumentsApi);
  private readonly files = inject(BlobFiles);
  private readonly router = inject(Router);
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly catalog = inject(DocumentCatalog);
  protected readonly lang = inject(LanguageService).current;
  protected readonly canConfigure = inject(Session).allows('document.configure');
  protected readonly subjects = DOCUMENT_SUBJECTS;
  protected readonly rules = EMPLOYMENT_RULES;

  /** Templates of each type (`GET /documents/types/:id/templates`), by type id; null = could not be loaded. */
  protected readonly summaries = signal<ReadonlyMap<string, TypeTemplates | null>>(new Map());
  protected readonly loadingSummaries = signal(false);
  protected readonly feedback = signal<string | null>(null);
  protected readonly error = signal<FormMessage | null>(null);
  protected readonly previewing = signal<string | null>(null);

  // --- Revert to built-in ------------------------------------------------------------------------------------

  private readonly revertDialog = viewChild<ElementRef<HTMLDialogElement>>('revertDialog');
  protected readonly reverting = signal<DocumentTypeView | null>(null);
  protected readonly revertBusy = signal(false);
  protected readonly revertError = signal<FormMessage | null>(null);

  // --- New type ------------------------------------------------------------------------------------------------

  protected readonly creating = signal(false);
  protected readonly createBusy = signal(false);
  protected readonly createError = signal<FormMessage | null>(null);
  protected readonly typeForm = this.fb.group({
    code: ['', customCode],
    nameFr: ['', [Validators.required, Validators.maxLength(120)]],
    nameAr: ['', [Validators.required, Validators.maxLength(120)]],
    nameEn: ['', [Validators.maxLength(120)]],
    subject: this.fb.control<DocumentSubject>('employment'),
    employmentRule: this.fb.control<EmploymentRule>('any'),
    numberFormat: ['', numberFormat],
    languages: this.fb.group({ fr: [true], ar: [true] }, { validators: atLeastOne }),
  });
  private readonly format = toSignal(this.typeForm.controls.numberFormat.valueChanges, { initialValue: '' });
  protected readonly subject = toSignal(this.typeForm.controls.subject.valueChanges, { initialValue: 'employment' as DocumentSubject });
  protected readonly formatPreview = computed(() => {
    const format = normalizeFormat(this.format());
    return format && !this.typeForm.controls.numberFormat.errors ? renderNumber(format, Number(todayIso().slice(0, 4)), 1) : null;
  });

  constructor() {
    effect(() => {
      const types = this.catalog.types();
      if (types.length) this.loadSummaries(types);
    });
  }

  private loadSummaries(types: readonly DocumentTypeView[]): void {
    this.loadingSummaries.set(true);
    forkJoin(
      types.map((type) =>
        this.api.typeTemplates(type.id).pipe(
          map((summary): [string, TypeTemplates | null] => [type.id, summary]),
          catchError(() => of<[string, TypeTemplates | null]>([type.id, null])),
        ),
      ),
    ).subscribe((entries) => {
      this.summaries.set(new Map(entries));
      this.loadingSummaries.set(false);
    });
  }

  protected draftOf(type: DocumentTypeView): number | null {
    return this.summaries().get(type.id)?.items.find((item) => item.status === 'draft')?.version ?? null;
  }

  protected isCustom(type: DocumentTypeView): boolean {
    return type.kind === 'custom';
  }

  protected modeKey(type: DocumentTypeView): string {
    if (type.templateMode === 'designed' && type.template) return 'documents.templates.mode.designed';
    return this.isCustom(type) ? 'documents.templates.mode.none' : 'documents.templates.mode.builtin';
  }

  protected preview(type: DocumentTypeView): void {
    const template = type.template;
    if (!template) return;
    this.error.set(null);
    this.previewing.set(type.id);
    const lang = previewLanguage(type, this.lang());
    this.files.open(this.api.previewTemplate(template.id, { lang, sample: true }), `${type.code}-${lang}.pdf`).subscribe({
      next: () => this.previewing.set(null),
      error: (error: unknown) => {
        this.previewing.set(null);
        this.error.set({ key: pdfErrorKey(error) });
      },
    });
  }

  protected openRevert(type: DocumentTypeView): void {
    this.reverting.set(type);
    this.revertError.set(null);
    this.revertDialog()?.nativeElement.showModal();
  }

  protected closeRevert(): void {
    this.revertDialog()?.nativeElement.close();
  }

  protected confirmRevert(): void {
    const type = this.reverting();
    if (!type || this.revertBusy()) return;
    this.revertBusy.set(true);
    this.api.revertToBuiltin(type.id).subscribe({
      next: () => {
        this.revertBusy.set(false);
        this.closeRevert();
        this.feedback.set('documents.templates.reverted');
        this.catalog.reload();
      },
      error: (error: unknown) => {
        this.revertBusy.set(false);
        this.revertError.set(problemToForm(this.typeForm, error, REVERT_SLUGS) ?? { key: 'errors.generic' });
      },
    });
  }

  protected startCreate(): void {
    this.feedback.set(null);
    this.createError.set(null);
    this.typeForm.reset();
    this.creating.set(true);
  }

  protected cancelCreate(): void {
    this.creating.set(false);
  }

  protected create(): void {
    this.createError.set(null);
    if (this.typeForm.invalid) {
      this.typeForm.markAllAsTouched();
      return;
    }
    const v = this.typeForm.getRawValue();
    const languages = (['fr', 'ar'] as const).filter((l) => v.languages[l]);
    this.createBusy.set(true);
    this.api
      .createType({
        code: v.code.trim(),
        names: { fr: v.nameFr.trim(), ar: v.nameAr.trim(), en: v.nameEn.trim() || v.nameFr.trim() },
        subject: v.subject,
        ...(v.subject === 'employment' ? { employmentRule: v.employmentRule } : {}),
        numberFormat: normalizeFormat(v.numberFormat),
        languages,
      })
      .subscribe({
        next: (type) => {
          this.createBusy.set(false);
          this.creating.set(false);
          this.catalog.reload();
          void this.router.navigate(['/documents/settings/templates', type.id]);
        },
        error: (error: unknown) => {
          this.createBusy.set(false);
          this.createError.set(problemToForm(this.typeForm, error, NEW_TYPE_SLUGS));
        },
      });
  }
}
