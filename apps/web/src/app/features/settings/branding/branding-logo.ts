/**
 * One logo of the branding settings: the current image, a file chooser with a local preview, save / cancel / remove.
 * The file is checked here as a courtesy (type, size); the API sniffs the bytes, reads the pixel size and decides,
 * and its refusal lands under the same input. The preview is a `data:` URL: the CSP allows `img-src 'self' data:`,
 * not `blob:`.
 */
import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';
import { BrandingApi, type LogoTarget } from '../../../core/branding/branding-api';
import type { BrandingSettingsView, LogoRef, LogoView } from '../../../core/branding/branding.models';
import { blobToDataUrl } from '../../../core/browser/download';
import type { FormMessage } from '../../../core/http/problem-form';
import { LanguageService } from '../../../core/i18n/language.service';
import { FileSizePipe } from '../../../shared/file-size/file-size.pipe';
import { isScopeRefusal, LOGO_ERROR_KEYS, type LogoError, logoPrecheck, logoUploadError, writeMessage } from './branding-forms';

@Component({
  selector: 'app-branding-logo',
  imports: [TranslocoDirective, FileSizePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="logo-field" *transloco="let t" [attr.data-logo]="target()" [attr.aria-labelledby]="inputId() + '-title'">
      <h4 [id]="inputId() + '-title'">{{ t(labelKey()) }}</h4>
      <p class="field-hint">{{ t(hintKey()) }}</p>

      @if (done(); as key) {
        <p class="feedback" role="status" data-state="logo-feedback">{{ t(key) }}</p>
      }
      @if (problem(); as message) {
        <p class="form-error" role="alert" data-error="logo-problem">{{ 'key' in message ? t(message.key) : message.text }}</p>
      }

      <div class="logo-box">
        @if (pendingUrl(); as url) {
          <img [src]="url" [alt]="t('branding.logo.preview')" data-image="pending" />
        } @else if (current(); as logo) {
          <img [src]="logo.url" [attr.width]="logo.width" [attr.height]="logo.height" [alt]="t('branding.logo.current')" data-image="current" />
          <span class="muted" dir="ltr">{{ logo.width }} × {{ logo.height }} px · {{ logo.sizeBytes | fileSize: language.current() }}</span>
        } @else if (inherited(); as logo) {
          <img [src]="logo.url" [attr.width]="logo.width" [attr.height]="logo.height" [alt]="t('branding.logo.inherited')" data-image="inherited" />
          <span class="muted">{{ t('branding.logo.inherited') }}</span>
        } @else {
          <span class="muted" data-image="none">{{ t('branding.logo.none') }}</span>
        }
      </div>

      <div class="field">
        <label [for]="inputId()">{{ t('branding.logo.choose') }}</label>
        <input
          #file
          [id]="inputId()"
          [disabled]="readOnly()"
          type="file"
          accept="image/png,image/jpeg"
          [attr.aria-invalid]="error() !== null"
          [attr.aria-describedby]="inputId() + '-hint ' + inputId() + '-error'"
          (change)="onFile($event)"
        />
        <p class="field-hint" [id]="inputId() + '-hint'">{{ t('branding.logo.hint') }}</p>
        @if (error(); as code) {
          <p class="field-error" [id]="inputId() + '-error'" data-error="logo">{{ t(errorKeys[code]) }}</p>
        }
      </div>
      <div class="form-actions">
        <button class="btn" type="button" data-action="upload-logo" [disabled]="!pendingFile() || busy() || readOnly()" (click)="upload(file)">
          {{ t('branding.logo.save') }}
        </button>
        @if (pendingFile() || error()) {
          <button class="btn secondary" type="button" data-action="cancel-logo" [disabled]="busy()" (click)="cancel(file)">{{ t('common.cancel') }}</button>
        }
        @if (current()) {
          <button class="btn secondary" type="button" data-action="remove-logo" [disabled]="busy() || readOnly()" (click)="remove()">{{ t('branding.logo.remove') }}</button>
        }
        <ng-content />
      </div>
    </section>
  `,
  styles: `
    h4 { margin-block: var(--space-4) var(--space-1); font-size: 1rem; }
    .logo-box { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); margin-block: var(--space-2) var(--space-3); min-block-size: 3rem; }
    .logo-box img { inline-size: auto; block-size: auto; max-block-size: 4.5rem; max-inline-size: min(16rem, 100%); padding: var(--space-1); border: 1px solid var(--color-border); border-radius: var(--radius); background: var(--color-surface); object-fit: contain; }
    input[type='file'] { max-inline-size: 100%; }
  `,
})
export class BrandingLogo {
  private readonly api = inject(BrandingApi);
  protected readonly language = inject(LanguageService);

  /** Unique in the page: the `id` of the file input. */
  readonly inputId = input.required<string>();
  readonly target = input.required<LogoTarget>();
  readonly labelKey = input.required<string>();
  readonly hintKey = input.required<string>();
  readonly current = input<LogoView | null>(null);
  /** Shown when the level has no logo of its own (the company's app logo falls back to the installation's). */
  readonly inherited = input<LogoRef | null>(null);
  readonly maxBytes = input.required<number>();
  /** The caller may read the settings but not change them (see the page). */
  readonly readOnly = input(false);

  /** The view after an upload. */
  readonly saved = output<BrandingSettingsView>();
  /** The logo was deleted (204: the parent reloads the view). */
  readonly removed = output<void>();
  /** The chosen file as a `data:` URL while it waits to be saved (for the live preview), else `null`. */
  readonly pendingChange = output<string | null>();
  /** A write was refused for lack of company-wide scope. */
  readonly scopeRefused = output<void>();

  protected readonly pendingFile = signal<File | null>(null);
  protected readonly pendingUrl = signal<string | null>(null);
  protected readonly error = signal<LogoError | null>(null);
  protected readonly errorKeys = LOGO_ERROR_KEYS;
  protected readonly problem = signal<FormMessage | null>(null);
  protected readonly done = signal<string | null>(null);
  protected readonly busy = signal(false);

  protected onFile(event: Event): void {
    const file = event.target instanceof HTMLInputElement ? (event.target.files?.[0] ?? null) : null;
    this.done.set(null);
    this.problem.set(null);
    this.setPending(null, null);
    if (!file) {
      this.error.set(null);
      return;
    }
    const error = logoPrecheck(file, this.maxBytes());
    this.error.set(error);
    if (error) return;
    this.pendingFile.set(file);
    void blobToDataUrl(file).then(
      (url) => {
        // The file may have been replaced or cancelled while it was being read.
        if (this.pendingFile() === file) this.setPending(file, url);
      },
      () => undefined,
    );
  }

  protected upload(field: HTMLInputElement): void {
    const file = this.pendingFile();
    if (!file || this.busy()) return;
    this.busy.set(true);
    this.problem.set(null);
    this.api.uploadLogo(this.target(), file, file.name).subscribe({
      next: (view) => {
        this.busy.set(false);
        this.clear(field);
        this.done.set('branding.logo.saved');
        this.saved.emit(view);
      },
      error: (error: unknown) => {
        this.busy.set(false);
        const code = logoUploadError(error);
        if (code) {
          // A refusal of the file itself: shown under the input, and the file is dropped so it is not sent again.
          this.clear(field);
          this.error.set(code);
        } else {
          this.fail(error);
        }
      },
    });
  }

  protected cancel(field: HTMLInputElement): void {
    this.clear(field);
  }

  protected remove(): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.problem.set(null);
    this.done.set(null);
    this.api.deleteLogo(this.target()).subscribe({
      next: () => {
        this.busy.set(false);
        this.done.set('branding.logo.removed');
        this.removed.emit();
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.fail(error);
      },
    });
  }

  private fail(error: unknown): void {
    this.problem.set(writeMessage(error));
    if (isScopeRefusal(error)) this.scopeRefused.emit();
  }

  private clear(field: HTMLInputElement): void {
    field.value = '';
    this.error.set(null);
    this.setPending(null, null);
  }

  private setPending(file: File | null, url: string | null): void {
    this.pendingFile.set(file);
    if (this.pendingUrl() !== url) {
      this.pendingUrl.set(url);
      this.pendingChange.emit(url);
    }
  }
}
