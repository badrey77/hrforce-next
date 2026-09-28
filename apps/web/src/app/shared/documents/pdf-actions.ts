/**
 * `<app-pdf-actions [documentId]="d.id" [number]="d.number" />` — "Open" (new tab) and "Download" buttons for one
 * issued document's stored PDF. `[mine]="true"` uses the self-service endpoint (`GET /me/documents/:id/pdf`) instead of
 * the register's (`GET /documents/:id/pdf`). Used by the document detail page and My documents.
 *
 * Angular concepts:
 * - **`providers: [BlobFiles]` — a service per component instance.** Each `<app-pdf-actions>` gets its own `BlobFiles`
 *   (core/browser/blob-files.ts), created with it and destroyed with it; `BlobFiles` injects `DestroyRef` to revoke
 *   the object URLs it created when THIS component goes away. The component asks for it with `inject(BlobFiles)` like
 *   any service: DI looks in the component's own injector first, which is where `providers` put it.
 * - **Subscribing in the click handler.** `open()` must run inside the click (pop-up blockers), so the handler calls
 *   `files.open(...)` and subscribes right there; `busy` disables both buttons until the bytes have arrived or failed.
 *   The subscription is not tied to the component's life on purpose: the tab is already open and should get its PDF
 *   even if the user navigates meanwhile (an HTTP Observable completes by itself, so nothing leaks).
 * - **Errors of a Blob request as problems**: `apiProblemInterceptor` has already read the error Blob as JSON, so a
 *   404 is an `ApiProblemError` with `status` 404 here, like any JSON call.
 * - `aria-busy` + a `role="alert"` message: screen readers hear a failure without the focus moving.
 */
import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';
import type { Observable } from 'rxjs';
import { BlobFiles } from '../../core/browser/blob-files';
import { DocumentsApi } from '../../core/documents/documents-api';
import type { PdfDisposition } from '../../core/documents/documents.models';
import { isApiProblemError, PROBLEM_TYPE_NETWORK } from '../../core/http/api-problem';

/** Translation key for a failed PDF fetch. */
export function pdfErrorKey(error: unknown): string {
  if (!isApiProblemError(error)) return 'documents.pdf.error';
  if (error.problem.type === PROBLEM_TYPE_NETWORK) return 'errors.network';
  if (error.status === 404) return 'documents.pdf.notFound';
  if (error.status === 403) return 'errors.forbidden';
  return 'documents.pdf.error';
}

@Component({
  selector: 'app-pdf-actions',
  imports: [TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [BlobFiles],
  template: `
    <ng-container *transloco="let t">
      <span class="pdf-actions" [attr.aria-busy]="busy() !== null">
        <button class="btn secondary" type="button" data-action="open-pdf" [disabled]="busy() !== null" (click)="open()">
          {{ busy() === 'open' ? t('documents.pdf.opening') : t('documents.pdf.open') }}
        </button>
        <button class="btn secondary" type="button" data-action="download-pdf" [disabled]="busy() !== null" (click)="download()">
          {{ busy() === 'save' ? t('documents.pdf.downloading') : t('documents.pdf.download') }}
        </button>
      </span>
      @if (saved()) {
        <span class="field-hint" role="status" data-state="saved-instead">{{ t('documents.pdf.savedInstead') }}</span>
      }
      @if (errorKey(); as key) {
        <span class="form-error" role="alert" data-error="pdf">{{ t(key) }}</span>
      }
    </ng-container>
  `,
  styles: `
    :host { display: inline-flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
    .pdf-actions { display: inline-flex; flex-wrap: wrap; gap: var(--space-2); }
    .form-error { margin: 0; }
  `,
})
export class PdfActions {
  private readonly api = inject(DocumentsApi);
  private readonly files = inject(BlobFiles);

  readonly documentId = input.required<string>();
  /** The document number: the file name (`<number>.pdf`). */
  readonly number = input.required<string>();
  /** Self-service endpoint (the caller's own document). */
  readonly mine = input(false);

  protected readonly busy = signal<'open' | 'save' | null>(null);
  protected readonly errorKey = signal<string | null>(null);
  /** The new tab was blocked: the file was downloaded instead. */
  protected readonly saved = signal(false);

  private source(disposition: PdfDisposition): Observable<Blob> {
    return this.mine() ? this.api.myPdf(this.documentId(), disposition) : this.api.pdf(this.documentId(), disposition);
  }

  private get fileName(): string {
    return `${this.number()}.pdf`;
  }

  protected open(): void {
    this.start('open');
    this.files.open(this.source('inline'), this.fileName).subscribe({
      next: (result) => {
        this.busy.set(null);
        this.saved.set(result === 'saved');
      },
      error: (error: unknown) => this.fail(error),
    });
  }

  protected download(): void {
    this.start('save');
    this.files.save(this.source('attachment'), this.fileName).subscribe({
      next: () => this.busy.set(null),
      error: (error: unknown) => this.fail(error),
    });
  }

  private start(what: 'open' | 'save'): void {
    this.errorKey.set(null);
    this.saved.set(false);
    this.busy.set(what);
  }

  private fail(error: unknown): void {
    this.busy.set(null);
    this.errorKey.set(pdfErrorKey(error));
  }
}
