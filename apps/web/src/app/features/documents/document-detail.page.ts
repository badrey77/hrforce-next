/**
 * /documents/:id — one issued document (`document.read` in scope): its facts, the signatory, a short hash, "Open" and
 * "Download" (the stored PDF, byte-identical on every reprint — contract assumption 10), "Void" when the server lists
 * it in `_actions`, and a History tab (the audit timeline of `issued_document:<id>`: its row, `document.issued`,
 * `document.downloaded` and `document.voided` events). `?issued=1` (set by the issue page after a success) shows a
 * "document issued, open the PDF" call to action.
 *
 * Angular concepts (all met before; this page combines them):
 * - **Route param → `input.required()` → `httpResource`** (the employee detail page); a 404 reads "not found" without
 *   a retry — out-of-scope ids are 404 by design (ADR 002).
 * - **Tabs as a local `linkedSignal`** of the id (chapter 14): Details / History show the same loaded document.
 * - **History through `@defer (on viewport)`**: the timeline's code is fetched only when the tab is opened. The
 *   timeline needs no `audit.read`: the API shows an `issued_document` timeline to whoever may read the document.
 * - **The void button from `_actions`**, not from `session.can('document.void')`: the server evaluated the caller's
 *   scope on THIS document's employee (a regional HR user holds no `document.void`; a central admin does, everywhere).
 * - **Native `<dialog>` with a required reason** (as "End employment"): a one-control reactive form, 3–500 characters,
 *   `problemToForm()` for the server's answer.
 * - `<app-pdf-actions>` owns its own `BlobFiles` (component-scoped provider), so this page does no blob handling.
 */
import { DatePipe, DecimalPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  type ElementRef,
  inject,
  input,
  linkedSignal,
  signal,
  viewChild,
} from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { TranslocoDirective } from '@jsverse/transloco';
import { Session } from '../../core/auth/session';
import { DocumentsApi } from '../../core/documents/documents-api';
import { documentActions, type IssuedDocumentDetail } from '../../core/documents/documents.models';
import { isApiProblemError, PROBLEM_TYPE_NETWORK } from '../../core/http/api-problem';
import { type FormMessage, problemToForm } from '../../core/http/problem-form';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { pickLabel } from '../../core/leave/leave-catalog';
import { CanDirective } from '../../shared/can/can.directive';
import { DisplayNamePipe, displayNameOf } from '../../shared/display-name/display-name.pipe';
import { PdfActions } from '../../shared/documents/pdf-actions';
import { Timeline } from '../../shared/timeline/timeline';
import type { AuditNameResolver } from '../../shared/timeline/timeline-view';
import { VOID_SLUGS } from './document-forms';

export const VOID_REASON_MIN = 3;
export const VOID_REASON_MAX = 500;

type DetailTab = 'details' | 'history';

@Component({
  selector: 'app-document-detail-page',
  imports: [TranslocoDirective, RouterLink, ReactiveFormsModule, DatePipe, DecimalPipe, DisplayNamePipe, CanDirective, PdfActions, Timeline],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './document-detail.page.html',
  styleUrl: './documents.css',
})
export class DocumentDetailPage {
  private readonly api = inject(DocumentsApi);
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));
  protected readonly canLeave = inject(Session).allows('leave.read');

  /** `:id` of the route. */
  readonly id = input.required<string>();
  /** `?issued=1` — arriving from the issue page right after a success. */
  readonly issued = input<string | undefined>();

  protected readonly document = this.api.detailResource(this.id);
  protected readonly detail = computed<IssuedDocumentDetail | undefined>(() =>
    this.document.hasValue() ? this.document.value() : undefined,
  );
  protected readonly notFound = computed(() => {
    const error = this.document.error();
    return isApiProblemError(error) && error.status === 404;
  });
  protected readonly errorKey = computed(() => {
    const error = this.document.error();
    if (!isApiProblemError(error)) return 'documents.detail.loadError';
    if (error.problem.type === PROBLEM_TYPE_NETWORK) return 'errors.network';
    if (error.status === 404) return 'documents.detail.notFound';
    if (error.status === 403) return 'errors.forbidden';
    return 'documents.detail.loadError';
  });
  protected readonly canVoid = computed(() => {
    const d = this.detail();
    return !!d && d.status === 'issued' && documentActions(d).includes('void');
  });
  /** First 12 hex digits: enough to compare a printout with the register by eye; the full hash is in `title`. */
  protected readonly shortHash = computed(() => this.detail()?.sha256.slice(0, 12) ?? '');

  protected readonly tabs: readonly DetailTab[] = ['details', 'history'];
  protected readonly tab = linkedSignal<string, DetailTab>({ source: this.id, computation: () => 'details' });
  protected readonly feedback = signal<string | null>(null);

  protected label(labels: IssuedDocumentDetail['type']['labels']): string {
    return pickLabel(labels, this.lang());
  }

  /** Names for the History: the employee's unit and the people the document names. */
  protected readonly auditNames: AuditNameResolver = (kind, value) => {
    const d = this.detail();
    if (!d) return undefined;
    if (kind === 'unit' && d.employee.unit.id === value) return displayNameOf(d.employee.unit, this.lang());
    if (kind === 'user') {
      if (d.issuedBy?.id === value) return d.issuedBy.displayName;
      if (d.void?.by?.id === value) return d.void.by.displayName;
    }
    return undefined;
  };

  // --- Void dialog ------------------------------------------------------------------------------------------------

  private readonly voidDialog = viewChild.required<ElementRef<HTMLDialogElement>>('voidDialog');
  protected readonly voidSubmitting = signal(false);
  protected readonly voidError = signal<FormMessage | null>(null);
  protected readonly voidForm = inject(NonNullableFormBuilder).group({
    reason: ['', [Validators.required, Validators.minLength(VOID_REASON_MIN), Validators.maxLength(VOID_REASON_MAX), Validators.pattern(/\S/)]],
  });

  protected openVoid(): void {
    this.feedback.set(null);
    this.voidError.set(null);
    this.voidForm.reset({ reason: '' });
    this.voidDialog().nativeElement.showModal();
  }

  protected closeVoid(): void {
    this.voidDialog().nativeElement.close();
  }

  protected onVoidClosed(): void {
    this.voidSubmitting.set(false);
  }

  protected submitVoid(): void {
    const d = this.detail();
    this.voidError.set(null);
    if (!d) return;
    if (this.voidForm.invalid) {
      this.voidForm.markAllAsTouched();
      return;
    }
    this.voidSubmitting.set(true);
    this.api.void(d.id, this.voidForm.getRawValue().reason.trim()).subscribe({
      next: () => {
        this.closeVoid();
        this.feedback.set('documents.feedback.voided');
        this.document.reload();
      },
      error: (error: unknown) => {
        this.voidSubmitting.set(false);
        this.voidError.set(problemToForm(this.voidForm, error, VOID_SLUGS, 'documents.detail.notFound'));
        // Someone else voided it meanwhile: show the current state behind the dialog.
        if (isApiProblemError(error) && error.status === 409) this.document.reload();
      },
    });
  }
}
