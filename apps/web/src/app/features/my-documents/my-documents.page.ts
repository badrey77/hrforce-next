/**
 * /me/documents — self-service documents (docs/contracts/documents.md › Web › My documents, assumption 6): "Request an
 * attestation" (type, language, purpose), my requests with their approval progress and a Cancel, and my issued
 * documents with Open / Download. Needs `document.request_self` (route guard) AND a linked employment (the root
 * `MyEmployment` service, shared with My leave).
 *
 * Angular concepts (the My leave page's, reused — read features/my-leave/my-leave.page.ts first):
 * - **A resource gated on another resource**: `GET /me/documents` is sent only once `MyEmployment.linked()` is true.
 * - **Reload after a write**: requesting or cancelling reloads the one resource that holds both lists.
 * - **`?document=<id>` / `?request=<id>` → scroll to and highlight that item** (links of the `document.ready` and
 *   `document.rejected` notifications). Both are inputs; one `computed()` finds which list item is meant, and an
 *   `afterRenderEffect()` scrolls to it and focuses it once the DOM row exists.
 * - **Live refresh while open**: a `document.*` notification (ready, rejected) arriving over SSE reloads the lists
 *   (the `NotificationEvents` bus, `takeUntilDestroyed()`), so an approval shows up without a reload.
 * - **Open / Download of MY document**: `<app-pdf-actions [mine]="true">` calls `GET /me/documents/:id/pdf` — the
 *   self-service endpoint, which never serves a voided document or another person's.
 * - **Radio buttons as ONE control**: several `<input type="radio" formControlName="language" [value]="…">` share a
 *   control; the checked one's `value` is the control's value (Angular's RadioControlValueAccessor groups them by
 *   `formControlName`).
 */
import { DatePipe } from '@angular/common';
import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import { DocumentCatalog } from '../../core/documents/document-catalog';
import { DocumentsApi } from '../../core/documents/documents-api';
import {
  type DocumentLanguage,
  type DocumentRequestView,
  documentRequestActions,
  type IssuedDocumentView,
} from '../../core/documents/documents.models';
import { isApiProblemError } from '../../core/http/api-problem';
import { type FormMessage, problemSlug, problemToForm, type SlugTable } from '../../core/http/problem-form';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { pickLabel } from '../../core/leave/leave-catalog';
import type { Labels } from '../../core/leave/leave.models';
import { MyEmployment } from '../../core/leave/my-employment';
import { NotificationEvents } from '../../core/notifications/notification-events';
import { DisplayNamePipe } from '../../shared/display-name/display-name.pipe';
import { PdfActions } from '../../shared/documents/pdf-actions';
import { WorkflowStepper } from '../../shared/workflow-stepper/workflow-stepper';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';

export const PURPOSE_MAX = 200;

/** `POST /me/documents/requests` refusals (contract › Endpoints). */
export const REQUEST_SLUGS: SlugTable = {
  'document-type-not-self-service': { key: 'documents.mine.problems.notSelfService', field: 'typeCode' },
  'document-type-inactive': { key: 'documents.problems.typeInactive', field: 'typeCode' },
  'document-request-pending': { key: 'documents.mine.problems.pending' },
  'document-employment-ended': { key: 'documents.mine.problems.employmentEnded' },
};

@Component({
  selector: 'app-my-documents-page',
  imports: [RevealAlert, TranslocoDirective, ReactiveFormsModule, DatePipe, DisplayNamePipe, PdfActions, WorkflowStepper],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './my-documents.page.html',
  styles: `
    .items { display: grid; gap: var(--space-3); margin: 0; padding: 0; list-style: none; }
    .items > li { padding: var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius); }
    .items > li.highlight { border-color: var(--color-primary); border-inline-start-width: 4px; background: var(--color-surface-alt); }
    .items > li:focus-visible { outline: 2px solid var(--color-focus); outline-offset: 2px; }
    .head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: var(--space-2); margin-block-end: var(--space-2); }
    .head p { margin: 0; }
    .radios { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-4); margin: 0; padding: 0; border: 0; }
    form { max-inline-size: 40rem; }
  `,
})
export class MyDocumentsPage {
  private readonly api = inject(DocumentsApi);
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly me = inject(MyEmployment);
  protected readonly catalog = inject(DocumentCatalog);
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));

  /** A request answered `document-not-linked` (the link disappeared since the page loaded). */
  protected readonly lostLink = signal(false);
  protected readonly linked = computed(() => this.me.linked() === true && !this.lostLink());

  protected readonly mine = this.api.myDocumentsResource(() => this.linked());
  protected readonly documents = computed<readonly IssuedDocumentView[]>(() => (this.mine.hasValue() ? this.mine.value().documents : []));
  protected readonly requests = computed<readonly DocumentRequestView[]>(() => (this.mine.hasValue() ? this.mine.value().requests : []));

  protected readonly feedback = signal<string | null>(null);

  protected label(labels: Labels): string {
    return pickLabel(labels, this.lang());
  }

  protected canCancel(request: DocumentRequestView): boolean {
    return request.status === 'pending' && documentRequestActions(request).includes('cancel');
  }

  // --- Request form -----------------------------------------------------------------------------------------------

  protected readonly form = this.fb.group({
    typeCode: ['', Validators.required],
    language: this.fb.control<DocumentLanguage>('fr'),
    purpose: ['', Validators.maxLength(PURPOSE_MAX)],
  });
  private readonly typeCode = toSignal(this.form.controls.typeCode.valueChanges, { initialValue: '' });
  protected readonly languages = computed<readonly DocumentLanguage[]>(() => this.catalog.type(this.typeCode())?.languages ?? ['fr', 'ar']);
  protected readonly submitting = signal(false);
  protected readonly formError = signal<FormMessage | null>(null);

  // --- ?document= / ?request= -------------------------------------------------------------------------------------

  /** `?document=<id>` (the `document.ready` notification link), bound by the router. */
  readonly document = input<string | undefined>();
  /** `?request=<id>` (the `document.rejected` notification link). */
  readonly request = input<string | undefined>();
  /** `data-item` value of the linked item once it is in the loaded lists. */
  protected readonly highlighted = computed(() => {
    const doc = this.document();
    if (doc && this.documents().some((d) => d.id === doc)) return `document:${doc}`;
    const req = this.request();
    if (req && this.requests().some((r) => r.id === req)) return `request:${req}`;
    return null;
  });
  protected readonly linkedMissing = computed(() => (!!this.document() || !!this.request()) && this.mine.hasValue() && this.highlighted() === null);
  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);
  private scrolledTo: string | null = null;

  constructor() {
    // Default type (the first self-service one) and language (the UI's, when the type is printed in it).
    effect(() => {
      const types = this.catalog.selfServiceTypes();
      if (types.length && !untracked(() => this.form.controls.typeCode.value)) this.form.controls.typeCode.setValue(types[0]?.code ?? '');
    });
    effect(() => {
      const allowed = this.languages();
      const preferred: DocumentLanguage = untracked(this.lang) === 'ar' ? 'ar' : 'fr';
      if (!this.form.controls.language.dirty || !allowed.includes(untracked(() => this.form.controls.language.value))) {
        this.form.controls.language.setValue(allowed.includes(preferred) ? preferred : (allowed[0] ?? 'fr'));
      }
    });
    afterRenderEffect(() => {
      const key = this.highlighted();
      if (!key || key === this.scrolledTo) return;
      const item = [...this.host.nativeElement.querySelectorAll<HTMLElement>('[data-item]')].find((el) => el.dataset['item'] === key);
      if (!item) return;
      this.scrolledTo = key;
      item.scrollIntoView?.({ block: 'center' });
      item.focus({ preventScroll: true });
    });
    inject(NotificationEvents)
      .of((type) => type.startsWith('document.'))
      .pipe(takeUntilDestroyed())
      .subscribe(() => {
        if (this.linked()) this.mine.reload();
      });
  }

  protected submit(): void {
    this.formError.set(null);
    this.feedback.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const v = this.form.getRawValue();
    const purpose = v.purpose.trim();
    this.submitting.set(true);
    this.api.requestSelf({ typeCode: v.typeCode, language: v.language, ...(purpose ? { purpose } : {}) }).subscribe({
      next: () => {
        this.submitting.set(false);
        this.feedback.set('documents.mine.requested');
        this.form.controls.purpose.reset('');
        this.mine.reload();
      },
      error: (error: unknown) => {
        this.submitting.set(false);
        if (isApiProblemError(error) && problemSlug(error.problem.type) === 'document-not-linked') {
          this.lostLink.set(true);
          this.me.reload();
          return;
        }
        this.formError.set(problemToForm(this.form, error, REQUEST_SLUGS));
      },
    });
  }

  // --- Cancel dialog ------------------------------------------------------------------------------------------------

  private readonly cancelDialog = viewChild.required<ElementRef<HTMLDialogElement>>('cancelDialog');
  protected readonly cancelling = signal<DocumentRequestView | null>(null);
  protected readonly cancelSubmitting = signal(false);
  protected readonly cancelError = signal<string | null>(null);

  protected openCancel(request: DocumentRequestView): void {
    this.feedback.set(null);
    this.cancelError.set(null);
    this.cancelling.set(request);
    this.cancelDialog().nativeElement.showModal();
  }

  protected closeCancel(): void {
    this.cancelDialog().nativeElement.close();
  }

  protected onCancelClosed(): void {
    this.cancelling.set(null);
    this.cancelSubmitting.set(false);
  }

  protected confirmCancel(): void {
    const request = this.cancelling();
    if (!request) return;
    this.cancelSubmitting.set(true);
    this.api.cancelMine(request.id).subscribe({
      next: () => {
        this.closeCancel();
        this.feedback.set('documents.mine.cancelled');
        this.mine.reload();
      },
      error: (error: unknown) => {
        this.cancelSubmitting.set(false);
        this.cancelError.set(isApiProblemError(error) && error.status === 409 ? 'documents.mine.problems.notCancellable' : 'errors.generic');
        if (isApiProblemError(error) && error.status === 409) this.mine.reload();
      },
    });
  }
}
