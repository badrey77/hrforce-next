/**
 * The employee page's **Dossier** tab (`employee_file.read`): the documents uploaded to the person's file — diplomas,
 * contracts, ID documents… — grouped by category, with Download, Delete (reason required) and "Add a document"
 * (docs/contracts/documents.md › Phase B › Web). `<app-employee-file-tab [employee]="e" />`.
 *
 * Angular concepts:
 * - **The server says what this caller may do HERE.** `_actions` of the list (`upload`, `upload_medical`) show the add
 *   button and decide whether the medical category is offered; `_actions` of each file (`delete`) show its Delete
 *   button; `_redacted: ['medical']` says this caller may not see medical files (any there are, are absent from the
 *   list; the API sets it whether or not some exist, so it leaks nothing), so the tab says the list may be
 *   incomplete. `Session.can()` is only used for the "show deleted documents" switch, a list option the API ignores without `employee_file.delete` (chapter 12).
 * - **Two resources, one view.** `files` (keyed on the employee and the switch) and `categories` (the order and the
 *   upload choices) are independent `httpResource`s; `groups` is a `computed()` of both, so the list is grouped as
 *   soon as the files arrive and re-ordered when the categories do.
 * - **Collapsible groups with `<details>`/`<summary>`**: native disclosure, keyboard- and screen-reader-ready, no
 *   state in the component. Because `@for` tracks groups by category id, a reload after an upload reuses the same
 *   `<details>` elements, so the groups the user closed stay closed.
 * - **Downloads through `BlobFiles`** (`providers: [BlobFiles]`, chapter 18): the bytes come through `HttpClient`
 *   (refresh on 401, problems parsed) and are saved under the original file name, with the extension of the
 *   type the API detected added when it does not match (`downloadFileName`: `page.html` holding a PDF is saved as
 *   `page.html.pdf` — an `<a download>` of a Blob uses the name WE give, not the API's `Content-Disposition`).
 *   Files are never opened in a tab: the API serves them as attachments with a sandboxing CSP (no antivirus,
 *   contract assumption 13).
 * - **Confirm before delete with a native `<dialog>`** (the "End employment" dialog's pattern): `showModal()` makes
 *   the page inert and traps focus; the dialog names the document, requires a reason (3–500 characters, kept in the
 *   audit trail), and its danger button is the only way to confirm. Escape or Cancel closes it with nothing sent.
 * - **Reload after writes**: an upload or a delete reloads `files` (the resource keeps showing the old list meanwhile).
 */
import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  type ElementRef,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import { Session } from '../../core/auth/session';
import { BlobFiles } from '../../core/browser/blob-files';
import { todayIso } from '../../core/date/iso-date';
import { EmployeeFilesApi } from '../../core/employee-files/employee-files-api';
import {
  downloadFileName,
  type EmployeeFileCategory,
  type EmployeeFileView,
  fileBadge,
  fileKind,
  type FileGroup,
  fileActions,
  groupByCategory,
  listActions,
  listRedacted,
  uploadableCategories,
} from '../../core/employee-files/employee-files.models';
import type { EmployeeDetail } from '../../core/employees/employees.models';
import { isApiProblemError, PROBLEM_TYPE_NETWORK } from '../../core/http/api-problem';
import { type FormMessage, problemSlug, problemToForm } from '../../core/http/problem-form';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { pickLabel } from '../../core/leave/leave-catalog';
import { FileSizePipe } from '../../shared/file-size/file-size.pipe';
import { DELETE_SLUGS, trimmedLength } from './employee-file-forms';
import { EmployeeFileUpload } from './employee-file-upload';

export const REASON_MIN = 3;
export const REASON_MAX = 500;

/** Translation key for a failed download. */
export function downloadErrorKey(error: unknown): string {
  if (!isApiProblemError(error)) return 'documents.file.downloadError';
  if (error.problem.type === PROBLEM_TYPE_NETWORK) return 'errors.network';
  if (error.status === 404) return 'documents.file.gone';
  if (error.status === 403) return 'errors.forbidden';
  return 'documents.file.downloadError';
}

@Component({
  selector: 'app-employee-file-tab',
  imports: [TranslocoDirective, ReactiveFormsModule, DatePipe, FileSizePipe, EmployeeFileUpload],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [BlobFiles],
  templateUrl: './employee-file-tab.html',
  styleUrl: './employee-file.css',
})
export class EmployeeFileTab {
  private readonly api = inject(EmployeeFilesApi);
  private readonly files = inject(BlobFiles);
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));
  /** The API honours `includeDeleted` only for `employee_file.delete` holders (contract › Endpoints). */
  protected readonly canSeeDeleted = inject(Session).allows('employee_file.delete');

  readonly employee = input.required<EmployeeDetail>();

  protected readonly showDeleted = signal(false);
  protected readonly list = this.api.filesResource(
    () => this.employee().id,
    () => this.canSeeDeleted() && this.showDeleted(),
  );
  private readonly categories = this.api.categoriesResource();

  private readonly categoryItems = computed<readonly EmployeeFileCategory[]>(() =>
    this.categories.hasValue() ? this.categories.value().items : [],
  );
  protected readonly items = computed<readonly EmployeeFileView[]>(() => (this.list.hasValue() ? this.list.value().items : []));
  protected readonly groups = computed<readonly FileGroup[]>(() => groupByCategory(this.items(), this.categoryItems()));
  protected readonly medicalHidden = computed(() => this.list.hasValue() && listRedacted(this.list.value()).includes('medical'));
  protected readonly uploadable = computed(() =>
    this.list.hasValue() ? uploadableCategories(this.categoryItems(), listActions(this.list.value())) : [],
  );
  protected readonly canUpload = computed(() => this.list.hasValue() && listActions(this.list.value()).length > 0);
  protected readonly loadErrorKey = computed(() => {
    const error = this.list.error();
    if (isApiProblemError(error) && error.problem.type === PROBLEM_TYPE_NETWORK) return 'errors.network';
    if (isApiProblemError(error) && error.status === 403) return 'errors.forbidden';
    return 'documents.file.loadError';
  });

  protected readonly adding = signal(false);
  protected readonly feedback = signal<string | null>(null);
  protected readonly today = todayIso();
  protected readonly badge = fileBadge;
  protected readonly kind = fileKind;
  protected readonly actionsOf = fileActions;

  protected label(category: FileGroup['category']): string {
    return pickLabel(category.labels, this.lang());
  }

  protected openUpload(): void {
    this.feedback.set(null);
    this.adding.set(true);
  }

  protected onUploaded(): void {
    this.adding.set(false);
    this.feedback.set('documents.file.uploaded');
    this.list.reload();
  }

  protected toggleDeleted(event: Event): void {
    this.showDeleted.set(event.target instanceof HTMLInputElement && event.target.checked);
  }

  // --- Download ---------------------------------------------------------------------------------------------------

  /** Id of the file being downloaded (its button shows "Downloading…"), and the last failure. */
  protected readonly downloading = signal<string | null>(null);
  protected readonly downloadError = signal<{ readonly id: string; readonly key: string } | null>(null);

  protected download(file: EmployeeFileView): void {
    this.downloadError.set(null);
    this.downloading.set(file.id);
    this.files.save(this.api.content(this.employee().id, file.id), downloadFileName(file.originalFilename, file.mime)).subscribe({
      next: () => this.downloading.set(null),
      error: (error: unknown) => {
        this.downloading.set(null);
        this.downloadError.set({ id: file.id, key: downloadErrorKey(error) });
      },
    });
  }

  // --- Delete dialog ----------------------------------------------------------------------------------------------

  private readonly deleteDialog = viewChild.required<ElementRef<HTMLDialogElement>>('deleteDialog');
  protected readonly deleting = signal<EmployeeFileView | null>(null);
  protected readonly deleteSubmitting = signal(false);
  protected readonly deleteError = signal<FormMessage | null>(null);
  protected readonly reasonMax = REASON_MAX;
  protected readonly deleteForm = inject(NonNullableFormBuilder).group({
    reason: ['', trimmedLength(REASON_MIN, REASON_MAX)],
  });

  protected openDelete(file: EmployeeFileView): void {
    this.feedback.set(null);
    this.deleteError.set(null);
    this.deleteForm.reset({ reason: '' });
    this.deleting.set(file);
    this.deleteDialog().nativeElement.showModal();
  }

  protected cancelDelete(): void {
    this.deleteDialog().nativeElement.close();
  }

  protected onDeleteClosed(): void {
    this.deleteSubmitting.set(false);
    this.deleting.set(null);
  }

  protected submitDelete(): void {
    const file = this.deleting();
    this.deleteError.set(null);
    if (!file) return;
    if (this.deleteForm.invalid) {
      this.deleteForm.markAllAsTouched();
      return;
    }
    this.deleteSubmitting.set(true);
    this.api.delete(this.employee().id, file.id, this.deleteForm.getRawValue().reason.trim()).subscribe({
      next: () => {
        this.deleteDialog().nativeElement.close();
        this.feedback.set('documents.file.deleted');
        this.list.reload();
      },
      error: (error: unknown) => {
        this.deleteSubmitting.set(false);
        this.deleteError.set(problemToForm(this.deleteForm, error, DELETE_SLUGS, 'documents.file.gone'));
        // Deleted meanwhile (by someone else) or gone: the list is stale — refresh it behind the dialog.
        const gone = isApiProblemError(error) && (error.status === 404 || problemSlug(error.problem.type) === 'employee-file-deleted');
        if (gone) this.list.reload();
      },
    });
  }
}
