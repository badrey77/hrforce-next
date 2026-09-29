/**
 * "Add a document" to an employee's file (docs/contracts/documents.md › Phase B › Web): a drop zone with a file input,
 * category (medical only when the server's `_actions` allow it), title (proposed from the file name), document date,
 * expiry date, and a progress bar while the bytes are sent. Used by the Dossier tab (employee-file-tab.ts):
 *
 *   <app-employee-file-upload [employmentId]="e.id" [categories]="uploadable()" (uploaded)="onUploaded($event)" (cancelled)="…" />
 *
 * Angular concepts:
 * - **A form control with no input bound to it.** `file` is a `FormControl<File | null>` in the same `FormGroup` as the
 *   text fields, but no element carries `formControlName="file"`: `<input type="file">` has no Forms value accessor
 *   worth using (the browser owns its value; only `input.files` matters, chapter 18 §8), and a dropped file never
 *   passes through the input at all. So `(change)` and `(drop)` call `choose(file)`, which `setValue()`s the control.
 *   Having it IN the group still pays: `Validators.required` and `acceptedFile` run with the others, `form.invalid`
 *   covers it, and the server's 422 on `file` lands on it like on any field (`uploadProblemToForm`).
 * - **Drag and drop with event bindings.** `(dragover)` must call `event.preventDefault()`, or the browser refuses the
 *   drop; `(drop)` must too, or the browser OPENS the file in place of the app. `dataTransfer.files` is a `FileList`
 *   like `input.files`. A `dragOver` signal styles the zone while a file hovers. The file input stays visible and
 *   keyboard-usable: drag and drop is a shortcut, never the only way.
 * - **A proposed value that yields to the user.** Choosing a file fills the title only while the title control is
 *   still pristine (`!title.dirty`): Angular marks a control dirty on user input, never on `setValue()`, so a title
 *   the user typed is never overwritten by a second file choice.
 * - **Upload progress** (core/employee-files/employee-files-api.ts): `upload()` emits `progress` events then `done`.
 *   The `<progress>` element is bound with `[value]` when the total is known, and WITHOUT a value (indeterminate, an
 *   animated bar) when it is not; `[attr.value]` with `null` removes the attribute. At 100 % the bytes are sent but the
 *   server is still checking them: the label says so instead of looking stuck.
 * - **Cancel = unsubscribe.** The subscription is kept; "Cancel" unsubscribes, which aborts the XMLHttpRequest.
 *   `takeUntilDestroyed(destroyRef)` does the same if the component goes away mid-upload (the tab is closed, the user
 *   navigates): nothing keeps running for a screen that no longer exists.
 * - **A rule between two fields** (`notBefore`, chapter 19): the expiry date may not precede the document date. The
 *   validator (added to `expiresOn` in the constructor with `addValidators()`) READS `documentDate` when it runs;
 *   Angular re-runs a control's validators only when THAT control changes, so the constructor subscribes to
 *   `documentDate.valueChanges` and calls
 *   `expiresOn.updateValueAndValidity()`. `takeUntilDestroyed()` without an argument works here because it is called
 *   in the constructor (an injection context): it finds the component's `DestroyRef` itself.
 * - **`output()`** tells the parent what happened; the parent reloads its list (the server's answer is the truth).
 */
import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, input, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import type { Subscription } from 'rxjs';
import { EmployeeFilesApi } from '../../core/employee-files/employee-files-api';
import {
  EMPLOYEE_FILE_ACCEPT,
  EMPLOYEE_FILE_MAX_BYTES,
  type EmployeeFileCategory,
  type EmployeeFileView,
  TITLE_MAX,
  titleFromFileName,
} from '../../core/employee-files/employee-files.models';
import type { FormMessage } from '../../core/http/problem-form';
import { LanguageService } from '../../core/i18n/language.service';
import { pickLabel } from '../../core/leave/leave-catalog';
import { FileSizePipe } from '../../shared/file-size/file-size.pipe';
import { acceptedFile, fileErrorKey, notBlank, uploadProblemToForm } from './employee-file-forms';
import { isoDate, notBefore } from './employee-forms';
import { FieldError } from './field-error';

interface Progress {
  readonly loaded: number;
  readonly total: number | null;
}

@Component({
  selector: 'app-employee-file-upload',
  imports: [TranslocoDirective, ReactiveFormsModule, FieldError, FileSizePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './employee-file-upload.html',
  styleUrl: './employee-file.css',
})
export class EmployeeFileUpload {
  private readonly api = inject(EmployeeFilesApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly lang = inject(LanguageService).current;

  readonly employmentId = input.required<string>();
  /** Categories this caller may upload into (active; medical only with `upload_medical`). */
  readonly categories = input.required<readonly EmployeeFileCategory[]>();
  readonly uploaded = output<EmployeeFileView>();
  readonly cancelled = output<void>();

  protected readonly accept = EMPLOYEE_FILE_ACCEPT;
  protected readonly maxBytes = EMPLOYEE_FILE_MAX_BYTES;
  protected readonly fileErrorKey = fileErrorKey;

  protected readonly form = this.fb.group({
    file: this.fb.control<File | null>(null, [Validators.required, acceptedFile]),
    categoryId: ['', Validators.required],
    title: ['', [notBlank, Validators.maxLength(TITLE_MAX)]],
    documentDate: ['', isoDate],
    expiresOn: ['', isoDate],
  });

  constructor() {
    const { documentDate, expiresOn } = this.form.controls;
    // not before the document date: checked here so the message is translated; the API also refuses it (422). Added
    // here, not in the group literal above, because the rule reads another control of the form being built.
    expiresOn.addValidators(notBefore(() => documentDate.value || null));
    // a cross-field rule lives on ONE control, so that control must re-check when the OTHER one changes
    documentDate.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => expiresOn.updateValueAndValidity());
  }

  /** The chosen file, as a signal for the template (the control's value is not one). */
  protected readonly file = signal<File | null>(null);
  protected readonly dragOver = signal(false);
  /** More than one file was dropped: only the first is kept. */
  protected readonly onlyFirst = signal(false);
  protected readonly progress = signal<Progress | null>(null);
  protected readonly formError = signal<FormMessage | null>(null);
  protected readonly percent = computed(() => {
    const p = this.progress();
    return p?.total ? Math.min(100, Math.round((p.loaded / p.total) * 100)) : null;
  });
  private subscription: Subscription | null = null;

  protected label(category: EmployeeFileCategory): string {
    return pickLabel(category.labels, this.lang());
  }

  protected onFileInput(event: Event): void {
    const target = event.target instanceof HTMLInputElement ? event.target : null;
    this.onlyFirst.set(false);
    this.choose(target?.files?.[0] ?? null);
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

  /** Puts `file` in the form, and proposes a title while the user has not typed one. */
  protected choose(file: File | null): void {
    const { file: control, title } = this.form.controls;
    this.formError.set(null);
    control.setValue(file);
    control.markAsTouched();
    this.file.set(file);
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
    const fields = {
      categoryId: v.categoryId,
      title: v.title.trim(),
      documentDate: v.documentDate || null,
      expiresOn: v.expiresOn || null,
    };
    this.progress.set({ loaded: 0, total: file.size });
    this.subscription = this.api
      .upload(this.employmentId(), fields, file)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (event) => {
          if (event.kind === 'progress') {
            this.progress.set({ loaded: event.loaded, total: event.total });
          } else {
            this.progress.set(null);
            this.uploaded.emit(event.file);
          }
        },
        error: (error: unknown) => {
          this.progress.set(null);
          this.formError.set(uploadProblemToForm(this.form, error));
        },
      });
  }

  /** Aborts the upload in flight (unsubscribing aborts the request). */
  protected abort(): void {
    this.subscription?.unsubscribe();
    this.subscription = null;
    this.progress.set(null);
    this.formError.set({ key: 'documents.file.upload.aborted' });
  }

  protected cancel(): void {
    this.subscription?.unsubscribe();
    this.cancelled.emit();
  }
}
