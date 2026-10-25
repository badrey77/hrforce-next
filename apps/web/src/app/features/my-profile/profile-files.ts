import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import type { FormControl } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import { map, startWith, switchMap } from 'rxjs';
import { EMPLOYEE_FILE_MAX_BYTES } from '../../core/employee-files/employee-files.models';
import { LanguageService } from '../../core/i18n/language.service';
import { PROFILE_LIMITS } from '../../core/profile/profile.models';
import { FileSizePipe } from '../../shared/file-size/file-size.pipe';
import { ProfileFieldError } from './profile-field-error';

/**
 * `<app-profile-files>` — the supporting documents of a request (1–3 PDF/JPEG/PNG): « Prendre une photo » opens the
 * phone's camera (`capture`), « Choisir un fichier » the file picker (photos or PDF), and a drop zone on desktops.
 * The files live in the parent form's `files` control.
 */
@Component({
  selector: 'app-profile-files',
  imports: [TranslocoDirective, FileSizePipe, ProfileFieldError],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <fieldset
      *transloco="let t"
      class="field files"
      data-field="files"
      [class.over]="dragOver()"
      [class.invalid]="invalid()"
      [attr.aria-describedby]="idPrefix() + '-files-hint ' + idPrefix() + '-files-error'"
      (dragenter)="onDragOver($event)"
      (dragover)="onDragOver($event)"
      (dragleave)="dragOver.set(false)"
      (drop)="onDrop($event)"
    >
      <legend>
        {{ t('profile.files.label') }}
        @if (!required()) {
          <span class="muted">({{ t('profile.files.optional') }})</span>
        }
      </legend>
      <p class="field-hint" [id]="idPrefix() + '-files-hint'">
        @if (hintKey(); as key) {
          {{ t(key) }}
        }
        {{ t('profile.files.hint', { max: (maxBytes | fileSize: lang()), count: maxFiles }) }}
      </p>
      <div class="pickers">
        <span class="picker">
          <input [id]="idPrefix() + '-camera'" class="visually-hidden" type="file" accept="image/*" capture="environment"
            data-input="camera" [disabled]="disabled() || full()" (change)="onInput($event)" />
          <label class="btn secondary" [for]="idPrefix() + '-camera'" [class.disabled]="disabled() || full()">{{ t('profile.files.takePhoto') }}</label>
        </span>
        <span class="picker">
          <input [id]="idPrefix() + '-pick'" class="visually-hidden" type="file" [accept]="accept" multiple
            data-input="pick" [disabled]="disabled() || full()" (change)="onInput($event)" />
          <label class="btn secondary" [for]="idPrefix() + '-pick'" [class.disabled]="disabled() || full()">{{ t('profile.files.choose') }}</label>
        </span>
        <span class="drop-hint muted">{{ t('profile.files.drop') }}</span>
      </div>
      @if (files().length) {
        <ul class="chosen" [attr.aria-label]="t('profile.files.chosen')">
          @for (file of files(); track $index) {
            <li data-file>
              <span><bdi>{{ file.name }}</bdi> · {{ file.size | fileSize: lang() }}</span>
              <button class="btn secondary small" type="button" data-action="remove-file" [disabled]="disabled()"
                [attr.aria-label]="t('profile.files.remove', { name: file.name })" (click)="remove($index)">{{ t('profile.files.removeShort') }}</button>
            </li>
          }
        </ul>
      }
      @if (dropped()) {
        <p class="field-hint" data-state="dropped">{{ t('profile.files.tooMany') }}</p>
      }
      <app-profile-field-error [control]="control()" [errorId]="idPrefix() + '-files-error'" />
    </fieldset>
  `,
  styles: `
    .files { margin: 0 0 var(--space-3); padding: var(--space-3); border: 1px dashed var(--color-border); border-radius: var(--radius); }
    .files.over { border-color: var(--color-primary); background: var(--color-surface-alt); }
    .files.invalid { border-color: var(--color-danger); }
    legend { padding-inline: var(--space-1); font-weight: 600; }
    .pickers { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
    .picker:focus-within label { outline: 2px solid var(--color-focus); outline-offset: 2px; }
    label.disabled { opacity: 0.5; pointer-events: none; }
    .chosen { display: grid; gap: var(--space-2); margin: var(--space-3) 0 0; padding: 0; list-style: none; }
    .chosen li { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-2); overflow-wrap: anywhere; }
    .small { padding-block: var(--space-1); }
    @media (hover: none) { .drop-hint { display: none; } }
  `,
})
export class ProfileFiles {
  protected readonly lang = inject(LanguageService).current;

  readonly control = input.required<FormControl<File[]>>();
  /** Unique per form: ids of the inputs, hint and error. */
  readonly idPrefix = input.required<string>();
  /** A sentence naming the expected papers (« livret de famille… »). */
  readonly hintKey = input<string | null>(null);
  readonly required = input(false);
  readonly disabled = input(false);

  protected readonly accept = 'image/*,application/pdf';
  protected readonly maxBytes = EMPLOYEE_FILE_MAX_BYTES;
  protected readonly maxFiles = PROFILE_LIMITS.files;
  protected readonly dragOver = signal(false);
  /** Some chosen files were left out (more than 3). */
  protected readonly dropped = signal(false);

  private readonly state = toSignal(
    toObservable(this.control).pipe(
      switchMap((control) =>
        control.events.pipe(
          startWith(null),
          map(() => ({ files: control.value, invalid: control.invalid && control.touched })),
        ),
      ),
    ),
    { initialValue: { files: [] as File[], invalid: false } },
  );
  protected readonly files = computed(() => this.state().files);
  protected readonly invalid = computed(() => this.state().invalid);
  protected readonly full = computed(() => this.files().length >= this.maxFiles);

  protected onInput(event: Event): void {
    const target = event.target instanceof HTMLInputElement ? event.target : null;
    this.add([...(target?.files ?? [])]);
    if (target) target.value = '';
  }

  protected onDragOver(event: DragEvent): void {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    this.dragOver.set(true);
  }

  protected onDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragOver.set(false);
    if (this.disabled()) return;
    this.add([...(event.dataTransfer?.files ?? [])]);
  }

  add(chosen: readonly File[]): void {
    if (!chosen.length) return;
    const control = this.control();
    const all = [...control.value, ...chosen];
    this.dropped.set(all.length > this.maxFiles);
    control.setValue(all.slice(0, this.maxFiles));
    control.markAsTouched();
  }

  protected remove(index: number): void {
    const control = this.control();
    control.setValue(control.value.filter((_, i) => i !== index));
    control.markAsTouched();
    this.dropped.set(false);
  }
}
