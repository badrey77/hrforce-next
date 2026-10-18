/**
 * /documents/settings/templates/:typeId?version= — the template designer page (`document.design`;
 * docs/contracts/document-templates.md › Web › Designer). Hosts the designer package (`src/lib/document-designer`)
 * and owns everything it does not: loading a version, saving the draft (autosave 3 s after the last change, with the
 * `revision` lock), the 409 conflict banner, 422 problems, publishing, discarding, read-only versions and their
 * duplication, the versions drawer and PDF previews. Below 900 px only the versions and their previews are offered.
 */
import { DatePipe, DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  type ElementRef,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { TranslocoDirective, TranslocoService } from '@jsverse/transloco';
import { type Observable, of, switchMap, tap, map, finalize, shareReplay } from 'rxjs';
import { Session } from '../../../core/auth/session';
import { BlobFiles } from '../../../core/browser/blob-files';
import { DocumentCatalog } from '../../../core/documents/document-catalog';
import { DocumentsApi } from '../../../core/documents/documents-api';
import {
  type DocumentLanguage,
  subjectOf,
  type TemplatePreviewBody,
  type TemplateSource,
  type TemplateVersionSummary,
  type TemplateVersionView,
  templateActions,
} from '../../../core/documents/documents.models';
import { isApiProblemError } from '../../../core/http/api-problem';
import { problemSlug } from '../../../core/http/problem-form';
import { dateLocaleOf } from '../../../core/i18n/date-locale';
import { LanguageService } from '../../../core/i18n/language.service';
import { EmployeePicker } from '../../../shared/employee-picker/employee-picker';
import { pdfErrorKey } from '../../../shared/documents/pdf-actions';
import { DocumentDesigner, emptyLayout, type LayoutProblem, type TemplateField, type TemplateLayout } from '../../../../lib/document-designer';
import type { LeavesWithConfirmation } from './unsaved-template.guard';

export const AUTOSAVE_MS = 3000;
export const WIDE_QUERY = '(min-width: 900px)';

export type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'invalid' | 'error';

/** Problem slugs of the template endpoints → message keys (`documents.templates.problems.*`). */
export const TEMPLATE_SLUG_KEYS: Readonly<Record<string, string>> = {
  'document-template-changed': 'documents.templates.problems.changed',
  'document-template-not-draft': 'documents.templates.problems.notDraft',
  'document-template-draft-exists': 'documents.templates.problems.draftExists',
  'document-template-too-long': 'documents.templates.problems.tooLong',
  'document-template-self-service': 'documents.templates.problems.selfService',
  'document-template-no-builtin': 'documents.templates.problems.noBuiltin',
  'document-profile-incomplete': 'documents.problems.profileIncomplete',
  'document-render-failed': 'documents.problems.renderFailed',
  'forbidden-scope': 'documents.problems.companyWide',
};

/** Validation codes of the template endpoints (422 `errors[].code`) with a message under `documents.templates.codes.*`. */
export const TEMPLATE_ERROR_CODES: ReadonlySet<string> = new Set([
  'invalid',
  'required',
  'empty',
  'too_many_blocks',
  'text_too_long',
  'invalid_text',
  'unknown_variable',
  'unknown_field',
  'empty_gender',
  'invalid_id',
  'duplicate_id',
  'too_many_items',
  'table_too_large',
  'invalid_width',
  'invalid_row',
  'positions_not_allowed',
  'layout_too_large',
  'too_many_fields',
  'invalid_key',
  'duplicate_key',
  'invalid_label',
  'invalid_options',
  'invalid_value',
  'duplicate_value',
  'not_allowed',
]);

/** The message key of a failed template call. */
export function templateProblemKey(error: unknown): string {
  if (!isApiProblemError(error)) return 'errors.generic';
  const slug = problemSlug(error.problem.type);
  if (slug && TEMPLATE_SLUG_KEYS[slug]) return TEMPLATE_SLUG_KEYS[slug];
  if (error.status === 422) return 'documents.templates.problems.invalid';
  if (error.status === 404) return 'documents.templates.problems.notFound';
  if (error.status === 403) return 'errors.forbidden';
  return 'errors.generic';
}

/** The version to open first: the one asked for, else the draft, else the published one. */
export function initialVersion(items: readonly TemplateVersionSummary[], wanted: string | undefined): TemplateVersionSummary | null {
  return items.find((v) => v.id === wanted) ?? items.find((v) => v.status === 'draft') ?? items.find((v) => v.status === 'published') ?? null;
}

@Component({
  selector: 'app-template-designer-page',
  imports: [TranslocoDirective, RouterLink, DatePipe, ReactiveFormsModule, EmployeePicker, DocumentDesigner],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [BlobFiles],
  templateUrl: './template-designer.page.html',
  styleUrl: './template-designer.page.css',
  host: { '(window:beforeunload)': 'onBeforeUnload($event)' },
})
export class TemplateDesignerPage implements LeavesWithConfirmation {
  private readonly api = inject(DocumentsApi);
  private readonly files = inject(BlobFiles);
  private readonly router = inject(Router);
  private readonly transloco = inject(TranslocoService);
  private readonly window = inject(DOCUMENT).defaultView;
  protected readonly catalog = inject(DocumentCatalog);
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));
  protected readonly canIssue = inject(Session).allows('document.issue');

  /** `:typeId` and `?version=` (bound by the router). */
  readonly typeId = input.required<string>();
  readonly version = input<string | undefined>();

  protected readonly type = computed(() => this.catalog.types().find((t) => t.id === this.typeId()));
  protected readonly subject = computed(() => subjectOf(this.type()));
  protected readonly languages = computed<readonly DocumentLanguage[]>(() => this.type()?.languages ?? ['fr', 'ar']);
  protected readonly isSystem = computed(() => (this.type()?.kind ?? 'system') === 'system');

  protected readonly templates = this.api.typeTemplatesResource(this.typeId);
  protected readonly versions = computed<readonly TemplateVersionSummary[]>(() => (this.templates.hasValue() ? this.templates.value().items : []));
  protected readonly published = computed(() => this.versions().find((v) => v.status === 'published') ?? null);
  protected readonly draft = computed(() => this.versions().find((v) => v.status === 'draft') ?? null);
  private readonly variablesResource = this.api.templateVariablesResource(this.subject);
  protected readonly variables = computed(() => (this.variablesResource.hasValue() ? this.variablesResource.value().items : []));

  /** Wide enough for the designer (≥ 900 px). */
  protected readonly wide = signal(true);
  /**
   * The designer was shown once: from then on a narrow window hides it instead of destroying it, so resizing across
   * 900 px keeps the undo history and the selection. A phone never mounts it.
   */
  protected readonly mounted = signal(true);

  // --- The open version and its working copy ----------------------------------------------------------------

  protected readonly opened = signal<TemplateVersionView | null>(null);
  protected readonly opening = signal(false);
  protected readonly pageError = signal<string | null>(null);
  protected readonly feedback = signal<string | null>(null);
  /** The start screen was decided (version picked or none exists). */
  private picked = false;

  protected readonly layouts = signal<{ fr?: TemplateLayout; ar?: TemplateLayout }>({});
  protected readonly fields = signal<readonly TemplateField[]>([]);
  private readonly revision = signal(0);
  protected readonly editLang = signal<DocumentLanguage>('fr');
  protected readonly currentLayout = computed(() => this.layouts()[this.editLang()] ?? null);
  protected readonly editable = computed(() => {
    const v = this.opened();
    return !!v && v.status === 'draft' && templateActions(v).includes('edit');
  });
  protected readonly actions = computed(() => {
    const v = this.opened();
    return v ? templateActions(v) : [];
  });

  protected readonly dirty = signal(false);
  protected readonly saveState = signal<SaveState>('idle');
  protected readonly savedAt = signal<Date | null>(null);
  protected readonly conflict = signal<string | null>(null);
  /** The `errors[]` of the last 422, as the API sent them. */
  private readonly apiProblems = signal<readonly { field: string; code: string; message: string }[]>([]);
  /** The same in the UI language: a known code has its own message, any other keeps the API's text. */
  protected readonly problems = computed<readonly LayoutProblem[]>(() => {
    this.lang();
    return this.apiProblems().map((e) => ({
      field: e.field,
      message: TEMPLATE_ERROR_CODES.has(e.code) ? this.transloco.translate(`documents.templates.codes.${e.code}`) : e.message,
    }));
  });
  protected readonly saveErrorKey = signal<string | null>(null);
  private changes = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Observable<void> | null = null;

  // --- Dialogs, drawer, preview ---------------------------------------------------------------------------------

  private readonly publishDialog = viewChild<ElementRef<HTMLDialogElement>>('publishDialog');
  private readonly discardDialog = viewChild<ElementRef<HTMLDialogElement>>('discardDialog');
  protected readonly publishNote = signal('');
  protected readonly publishing = signal(false);
  protected readonly publishError = signal<string | null>(null);
  protected readonly discarding = signal(false);
  protected readonly showVersions = signal(false);
  protected readonly creating = signal(false);
  protected readonly previewing = signal(false);
  protected readonly previewSubject = new FormControl<string | null>(null);
  protected readonly previewMode = signal<'sample' | 'employee'>('sample');

  constructor() {
    const media = this.window?.matchMedia?.(WIDE_QUERY);
    if (media) {
      this.wide.set(media.matches);
      this.mounted.set(media.matches);
      const listener = (event: MediaQueryListEvent) => {
        this.wide.set(event.matches);
        if (event.matches) this.mounted.set(true);
      };
      media.addEventListener?.('change', listener);
      inject(DestroyRef).onDestroy(() => media.removeEventListener?.('change', listener));
    }
    inject(DestroyRef).onDestroy(() => this.clearTimer());

    // First load: open the asked version, else the draft, else the published one; else the start screen.
    effect(() => {
      if (!this.templates.hasValue() || this.picked) return;
      const wanted = untracked(this.version);
      const first = initialVersion(this.templates.value().items, wanted);
      this.picked = true;
      if (first) untracked(() => this.open(first.id));
    });
    // The editing language: the UI language when the type is printed in it.
    effect(() => {
      const langs = this.languages();
      untracked(() => {
        const preferred: DocumentLanguage = this.lang() === 'ar' ? 'ar' : 'fr';
        if (!langs.includes(this.editLang())) this.editLang.set(langs.includes(preferred) ? preferred : (langs[0] ?? 'fr'));
      });
    });
  }

  // --- Opening ------------------------------------------------------------------------------------------------

  protected open(id: string): void {
    this.clearTimer();
    this.opening.set(true);
    this.pageError.set(null);
    this.api.template(id).subscribe({
      next: (view) => this.load(view),
      error: (error: unknown) => {
        this.opening.set(false);
        this.pageError.set(templateProblemKey(error));
      },
    });
  }

  private load(view: TemplateVersionView): void {
    this.opened.set(view);
    this.layouts.set({ ...view.layouts });
    this.fields.set(view.fields);
    this.revision.set(view.revision);
    this.dirty.set(false);
    this.conflict.set(null);
    this.apiProblems.set([]);
    this.saveErrorKey.set(null);
    this.saveState.set('idle');
    this.opening.set(false);
    this.showVersions.set(false);
    const preferred: DocumentLanguage = this.lang() === 'ar' ? 'ar' : 'fr';
    const langs = this.languages();
    this.editLang.set(langs.includes(preferred) ? preferred : (langs[0] ?? 'fr'));
    void this.router.navigate([], { queryParams: { version: view.id }, replaceUrl: true });
  }

  /** A new draft from blank, the built-in wording, the published version or a given version. */
  protected createDraft(from: TemplateSource): void {
    if (this.creating()) return;
    this.creating.set(true);
    this.pageError.set(null);
    this.api.createTemplate(this.typeId(), from).subscribe({
      next: (view) => {
        this.creating.set(false);
        this.templates.reload();
        this.load(view);
      },
      error: (error: unknown) => {
        this.creating.set(false);
        this.pageError.set(templateProblemKey(error));
      },
    });
  }

  // --- Editing and saving -------------------------------------------------------------------------------------

  protected onLayout(layout: TemplateLayout): void {
    this.layouts.update((all) => ({ ...all, [this.editLang()]: layout }));
    this.changed();
  }

  protected onFields(fields: TemplateField[]): void {
    this.fields.set(fields);
    this.changed();
  }

  /** Adds this language's layout to the draft: empty, or the built-in wording (system types). */
  protected addLayout(from: 'blank' | 'builtin'): void {
    const lang = this.editLang();
    if (from === 'blank') {
      this.layouts.update((all) => ({ ...all, [lang]: emptyLayout() }));
      this.changed();
      return;
    }
    this.api.builtinLayout(this.typeId(), lang).subscribe({
      next: (layout) => {
        this.layouts.update((all) => ({ ...all, [lang]: layout }));
        this.changed();
      },
      error: (error: unknown) => this.pageError.set(templateProblemKey(error)),
    });
  }

  private changed(): void {
    if (!this.editable() || this.conflict()) return;
    this.changes += 1;
    this.dirty.set(true);
    this.saveState.set('pending');
    this.feedback.set(null);
    this.clearTimer();
    this.timer = setTimeout(() => this.saveNow().subscribe({ error: () => undefined }), AUTOSAVE_MS);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Saves the draft now (no-op when nothing changed); completes once the server has it. */
  saveNow(): Observable<void> {
    this.clearTimer();
    if (this.inflight) return this.inflight.pipe(switchMap(() => (this.dirty() ? this.saveNow() : of(undefined))));
    const view = this.opened();
    if (!view || !this.editable() || !this.dirty() || this.conflict()) return of(undefined);
    const at = this.changes;
    this.saveState.set('saving');
    const request = this.api.saveTemplate(view.id, { revision: this.revision(), layouts: this.layouts(), fields: this.fields() }).pipe(
      tap({
        next: (saved) => {
          this.revision.set(saved.revision);
          this.opened.set({ ...saved, layouts: this.layouts(), fields: this.fields() });
          if (this.changes === at) this.dirty.set(false);
          this.apiProblems.set([]);
          this.saveErrorKey.set(null);
          this.savedAt.set(new Date());
          this.saveState.set(this.dirty() ? 'pending' : 'saved');
        },
        error: (error: unknown) => this.saveFailed(error),
      }),
      map(() => undefined),
      finalize(() => {
        this.inflight = null;
      }),
      shareReplay(1),
    );
    this.inflight = request;
    return request;
  }

  private saveFailed(error: unknown): void {
    const slug = isApiProblemError(error) ? problemSlug(error.problem.type) : undefined;
    if (slug === 'document-template-changed' || slug === 'document-template-not-draft') {
      this.conflict.set(TEMPLATE_SLUG_KEYS[slug] ?? 'errors.generic');
      this.saveState.set('error');
      return;
    }
    if (isApiProblemError(error) && error.status === 422) {
      this.apiProblems.set(error.problem.errors ?? []);
      this.saveState.set('invalid');
      this.saveErrorKey.set('documents.templates.problems.invalid');
      return;
    }
    this.saveState.set('error');
    this.saveErrorKey.set(templateProblemKey(error));
  }

  protected save(): void {
    this.saveNow().subscribe({ error: () => undefined });
  }

  protected reloadAfterConflict(): void {
    const view = this.opened();
    this.templates.reload();
    if (view) this.open(view.id);
  }

  // --- Publish, discard ---------------------------------------------------------------------------------------

  protected openPublish(): void {
    this.publishError.set(null);
    this.publishNote.set('');
    this.publishDialog()?.nativeElement.showModal();
  }

  protected closePublish(): void {
    this.publishDialog()?.nativeElement.close();
  }

  protected publish(): void {
    const view = this.opened();
    if (!view || this.publishing()) return;
    this.publishing.set(true);
    this.publishError.set(null);
    const note = this.publishNote().trim();
    this.saveNow()
      .pipe(switchMap(() => this.api.publishTemplate(view.id, this.revision(), note || null)))
      .subscribe({
        next: (published) => {
          this.publishing.set(false);
          this.closePublish();
          this.feedback.set('documents.templates.published');
          this.catalog.reload();
          this.templates.reload();
          this.load(published);
        },
        error: (error: unknown) => {
          this.publishing.set(false);
          if (isApiProblemError(error) && error.status === 422) {
            this.apiProblems.set(error.problem.errors ?? []);
          }
          this.publishError.set(templateProblemKey(error));
        },
      });
  }

  protected openDiscard(): void {
    this.discardDialog()?.nativeElement.showModal();
  }

  protected closeDiscard(): void {
    this.discardDialog()?.nativeElement.close();
  }

  protected discard(): void {
    const view = this.opened();
    if (!view || this.discarding()) return;
    this.clearTimer();
    this.discarding.set(true);
    this.api.discardTemplate(view.id).subscribe({
      next: () => {
        this.discarding.set(false);
        this.closeDiscard();
        this.dirty.set(false);
        this.opened.set(null);
        this.feedback.set('documents.templates.discarded');
        this.picked = false;
        this.templates.reload();
        void this.router.navigate([], { queryParams: { version: null }, replaceUrl: true });
      },
      error: (error: unknown) => {
        this.discarding.set(false);
        this.closeDiscard();
        this.pageError.set(templateProblemKey(error));
      },
    });
  }

  // --- Preview ------------------------------------------------------------------------------------------------

  protected preview(lang: DocumentLanguage = this.editLang(), versionId: string | null = this.opened()?.id ?? null): void {
    if (!versionId) return;
    const employmentId = this.previewMode() === 'employee' ? this.previewSubject.value : null;
    const body: TemplatePreviewBody = employmentId ? { lang, employmentId } : { lang, sample: true };
    const own = versionId === this.opened()?.id;
    this.previewing.set(true);
    this.pageError.set(null);
    const source = (own ? this.saveNow() : of(undefined)).pipe(switchMap(() => this.api.previewTemplate(versionId, body)));
    this.files.open(source, `${this.type()?.code ?? 'template'}-${lang}.pdf`).subscribe({
      next: () => this.previewing.set(false),
      error: (error: unknown) => {
        this.previewing.set(false);
        const key = templateProblemKey(error);
        this.pageError.set(key === 'errors.generic' ? pdfErrorKey(error) : key);
      },
    });
  }

  // --- Leaving --------------------------------------------------------------------------------------------------

  canLeave(): boolean {
    if (!this.dirty() || this.conflict()) return true;
    const ok = this.window?.confirm(this.transloco.translate('documents.templates.leaveConfirm')) ?? true;
    if (ok) this.clearTimer();
    return ok;
  }

  protected onBeforeUnload(event: BeforeUnloadEvent): void {
    if (this.dirty() && !this.conflict()) event.preventDefault();
  }

  protected statusKey(status: string): string {
    return `documents.templates.status.${status}`;
  }
}
