import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, DestroyRef, type ElementRef, inject, input, output, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import type { Subscription } from 'rxjs';
import { BlobFiles } from '../../core/browser/blob-files';
import {
  downloadFileName,
  EMPLOYEE_FILE_ACCEPT,
  EMPLOYEE_FILE_MAX_BYTES,
  fileBadge,
  fileKind,
  TITLE_MAX,
  titleFromFileName,
} from '../../core/employee-files/employee-files.models';
import { isApiProblemError } from '../../core/http/api-problem';
import type { FormMessage } from '../../core/http/problem-form';
import { dateLocaleOf } from '../../core/i18n/date-locale';
import { LanguageService } from '../../core/i18n/language.service';
import { RecruitmentApi } from '../../core/recruitment/recruitment-api';
import { type CandidateFileView, FILE_KINDS, type FileKind } from '../../core/recruitment/recruitment.models';
import { ControlError } from '../../shared/attendance/control-error';
import { FileSizePipe } from '../../shared/file-size/file-size.pipe';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';
import { acceptedFile, ERROR_KEYS, recruitmentProblemToForm, text } from './recruitment-forms';
import { actionErrorKey, downloadErrorKey } from './recruitment-view';

interface Progress {
  readonly loaded: number;
  readonly total: number | null;
}

/** A candidate's files: list, download, upload with progress and drag-and-drop, delete. */
@Component({
  selector: 'app-candidate-files',
  imports: [TranslocoDirective, ReactiveFormsModule, DatePipe, FileSizePipe, ControlError, RevealAlert],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [BlobFiles],
  templateUrl: './candidate-files.html',
  styleUrl: './candidate-files.css',
})
export class CandidateFiles {
  private readonly api = inject(RecruitmentApi);
  private readonly blobs = inject(BlobFiles);
  private readonly destroyRef = inject(DestroyRef);
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly lang = inject(LanguageService).current;
  protected readonly locale = computed(() => dateLocaleOf(this.lang()));

  readonly candidateId = input.required<string>();
  readonly files = input.required<readonly CandidateFileView[]>();
  readonly canUpload = input(false);
  /** A file was added or removed: the host reloads the candidate. */
  readonly changed = output<void>();

  protected readonly kinds = FILE_KINDS;
  protected readonly accept = EMPLOYEE_FILE_ACCEPT;
  protected readonly maxBytes = EMPLOYEE_FILE_MAX_BYTES;
  protected readonly errorKeys = ERROR_KEYS;
  protected readonly fileKeys = { ...ERROR_KEYS, required: 'documents.file.errors.required' };
  protected readonly badge = fileBadge;
  protected readonly kindOf = fileKind;
  protected readonly feedback = signal<string | null>(null);

  // --- Upload ---

  protected readonly adding = signal(false);
  protected readonly chosen = signal<File | null>(null);
  protected readonly dragOver = signal(false);
  protected readonly onlyFirst = signal(false);
  protected readonly progress = signal<Progress | null>(null);
  protected readonly formError = signal<FormMessage | null>(null);
  protected readonly percent = computed(() => {
    const p = this.progress();
    return p?.total ? Math.min(100, Math.round((p.loaded / p.total) * 100)) : null;
  });
  private upload$: Subscription | null = null;

  protected readonly form = this.fb.group({
    file: this.fb.control<File | null>(null, [Validators.required, acceptedFile]),
    kind: this.fb.control<FileKind>('cv'),
    title: ['', text(1, TITLE_MAX)],
  });

  protected openUpload(): void {
    this.feedback.set(null);
    this.formError.set(null);
    this.form.reset({ file: null, kind: this.files().some((f) => f.kind === 'cv') ? 'other' : 'cv', title: '' });
    this.chosen.set(null);
    this.adding.set(true);
  }

  protected onFileInput(event: Event): void {
    this.onlyFirst.set(false);
    this.choose(event.target instanceof HTMLInputElement ? (event.target.files?.[0] ?? null) : null);
  }

  protected onDragOver(event: DragEvent): void {
    event.preventDefault(); // allow the drop
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    this.dragOver.set(true);
  }

  protected onDrop(event: DragEvent): void {
    event.preventDefault(); // or the browser opens the file instead of the app
    this.dragOver.set(false);
    if (this.progress()) return;
    const files = event.dataTransfer?.files;
    this.onlyFirst.set((files?.length ?? 0) > 1);
    this.choose(files?.[0] ?? null);
  }

  private choose(file: File | null): void {
    const { file: control, title } = this.form.controls;
    this.formError.set(null);
    control.setValue(file);
    control.markAsTouched();
    this.chosen.set(file);
    if (file && !title.dirty) title.setValue(titleFromFileName(file.name));
  }

  protected submit(): void {
    this.formError.set(null);
    const file = this.form.controls.file.value;
    if (this.form.invalid || !file) {
      this.form.markAllAsTouched();
      return;
    }
    const v = this.form.getRawValue();
    this.progress.set({ loaded: 0, total: file.size });
    this.upload$ = this.api
      .uploadFile(this.candidateId(), { kind: v.kind, title: v.title.trim() }, file)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (event) => {
          if (event.kind === 'progress') {
            this.progress.set({ loaded: event.loaded, total: event.total });
            return;
          }
          this.progress.set(null);
          this.adding.set(false);
          this.feedback.set('documents.file.uploaded');
          this.changed.emit();
        },
        error: (error: unknown) => {
          this.progress.set(null);
          // A proxy cut-off (413) has no problem body: it is the size limit.
          if (isApiProblemError(error) && error.status === 413) {
            this.form.controls.file.setErrors({ fileSize: true });
            return;
          }
          this.formError.set(recruitmentProblemToForm(this.form, error));
        },
      });
  }

  protected abort(): void {
    this.upload$?.unsubscribe();
    this.upload$ = null;
    this.progress.set(null);
    this.formError.set({ key: 'documents.file.upload.aborted' });
  }

  protected cancelUpload(): void {
    this.upload$?.unsubscribe();
    this.progress.set(null);
    this.adding.set(false);
  }

  // --- Download ---

  protected readonly downloading = signal<string | null>(null);
  protected readonly rowError = signal<{ readonly id: string; readonly key: string } | null>(null);

  protected download(file: CandidateFileView): void {
    this.rowError.set(null);
    this.downloading.set(file.id);
    this.blobs.save(this.api.fileContent(this.candidateId(), file.id), downloadFileName(file.originalFilename, file.mime)).subscribe({
      next: () => this.downloading.set(null),
      error: (error: unknown) => {
        this.downloading.set(null);
        this.rowError.set({ id: file.id, key: downloadErrorKey(error) });
      },
    });
  }

  // --- Delete (the row and its bytes are gone for good) ---

  private readonly deleteDialog = viewChild.required<ElementRef<HTMLDialogElement>>('deleteDialog');
  protected readonly deleting = signal<CandidateFileView | null>(null);
  protected readonly deleteBusy = signal(false);

  protected openDelete(file: CandidateFileView): void {
    this.feedback.set(null);
    this.rowError.set(null);
    this.deleting.set(file);
    this.deleteDialog().nativeElement.showModal();
  }

  protected confirmDelete(): void {
    const file = this.deleting();
    if (!file) return;
    this.deleteBusy.set(true);
    this.api.deleteFile(this.candidateId(), file.id).subscribe({
      next: () => {
        this.deleteDialog().nativeElement.close();
        this.feedback.set('documents.file.deleted');
        this.changed.emit();
      },
      error: (error: unknown) => {
        this.deleteDialog().nativeElement.close();
        this.rowError.set({ id: file.id, key: actionErrorKey(error, 'documents.file.gone') });
        // Already deleted by someone else: the list is out of date.
        if (isApiProblemError(error) && error.status === 404) this.changed.emit();
      },
    });
  }

  protected onDeleteClosed(): void {
    this.deleting.set(null);
    this.deleteBusy.set(false);
  }
}
