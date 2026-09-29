/**
 * The "Letterhead" tab of /documents/settings (`document.configure`): the company's legal names, addresses, "Fait à"
 * cities and footers in French and Arabic side by side (stacked on phones), identifiers (NIF, NIS, RC, AI), contact,
 * completeness badges per language, and the logo (upload with preview, remove).
 *
 * Angular concepts:
 * - **A form built from a field table.** Four fr/ar pairs and six single fields share the same markup, so the
 *   template loops over `PAIRS`/`SINGLES` and binds `[formControlName]="name"` with a computed NAME (`'legalName' +
 *   'Fr'`). `formControlName` is an input like any other: a literal (`formControlName="x"`) or a binding. The price is
 *   that the template can no longer check the name against the form's type, so `control(name)` goes through
 *   `form.get()` — acceptable for a table that lives two lines above.
 * - **`dir` per input.** Arabic inputs get `dir="rtl"`, identifiers, phone and e-mail `dir="ltr"` (a NIF typed in an
 *   Arabic UI must not be shown right-to-left), whatever the page direction is.
 * - **Server data into the form with `effect()` + `untracked()`** (the security-policy page's pattern): when the
 *   resource answers, `form.reset(values)` — reset, so the form is pristine again. After a save, `profile.set(saved)`
 *   (a writable resource) re-runs the effect with the server's normalised values.
 * - **A file input without a ControlValueAccessor.** `<input type="file">` has no Forms value accessor worth using
 *   (the browser owns its value, only `files` matters), so `(change)` reads `input.files[0]` into a signal. The file is
 *   checked (type, 256 KB) as a courtesy — the API sniffs the bytes, reads the pixel size from the header (at most
 *   4 000 × 4 000 px) and decides; its 422 codes land on the same field (`logoFieldError()`, document-forms.ts) —
 *   and previewed as a `data:` URL (`blobToDataUrl`, core/browser/download.ts): the production CSP allows
 *   `img-src 'self' data:` but not `blob:`. The pixel size is not pre-checked here (the server reads it from the
 *   header, and its answer lands on the same field).
 * - **`FormData` upload**: `DocumentsApi.uploadLogo()`; no progress bar for 256 KB (Phase B's attachments will need
 *   `reportProgress`).
 */
import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { type AbstractControl, NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import { blobToDataUrl } from '../../core/browser/download';
import { DocumentsApi } from '../../core/documents/documents-api';
import { type CompanyProfileFields, type CompanyProfileView, DOCUMENT_LANGUAGES } from '../../core/documents/documents.models';
import { type FormMessage, problemToForm } from '../../core/http/problem-form';
import { CONFIG_SLUGS, LOGO_FIELD_KEYS, type LogoFieldError, logoFieldError, logoProblem, PROFILE_FIELDS, type ProfileField } from './document-forms';
import { RevealAlert } from '../../shared/reveal-alert/reveal-alert.directive';

export const LOGO_MAX_BYTES = 256 * 1024;
export const LOGO_TYPES: readonly string[] = ['image/png', 'image/jpeg'];
export const IDENTIFIER = /^[0-9A-Z /-]{1,30}$/;

interface Pair {
  readonly base: 'legalName' | 'address' | 'city' | 'footer';
  readonly multiline: boolean;
  readonly required: boolean;
}

/** fr/ar pairs, in form order. French ones marked `required` must be filled (the printed text of every document). */
export const PAIRS: readonly Pair[] = [
  { base: 'legalName', multiline: false, required: true },
  { base: 'address', multiline: true, required: true },
  { base: 'city', multiline: false, required: true },
  { base: 'footer', multiline: true, required: false },
];
export const SINGLES: readonly ('nif' | 'nis' | 'rc' | 'ai' | 'phone' | 'email')[] = ['nif', 'nis', 'rc', 'ai', 'phone', 'email'];

type LogoError = LogoFieldError | null;

@Component({
  selector: 'app-document-profile-settings',
  imports: [RevealAlert, TranslocoDirective, ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './profile-settings.html',
  styleUrl: './documents.css',
})
export class ProfileSettings {
  private readonly api = inject(DocumentsApi);
  private readonly fb = inject(NonNullableFormBuilder);

  protected readonly profile = this.api.profileResource();
  protected readonly view = computed<CompanyProfileView | undefined>(() => (this.profile.hasValue() ? this.profile.value() : undefined));
  protected readonly languages = DOCUMENT_LANGUAGES;
  protected readonly pairs = PAIRS;
  protected readonly singles = SINGLES;

  protected readonly form = this.fb.group({
    legalNameFr: ['', [Validators.required, Validators.maxLength(200)]],
    legalNameAr: ['', Validators.maxLength(200)],
    addressFr: ['', [Validators.required, Validators.maxLength(300)]],
    addressAr: ['', Validators.maxLength(300)],
    cityFr: ['', [Validators.required, Validators.maxLength(200)]],
    cityAr: ['', Validators.maxLength(200)],
    footerFr: ['', Validators.maxLength(300)],
    footerAr: ['', Validators.maxLength(300)],
    phone: ['', Validators.maxLength(200)],
    email: ['', [Validators.email, Validators.maxLength(200)]],
    nif: ['', Validators.pattern(IDENTIFIER)],
    nis: ['', Validators.pattern(IDENTIFIER)],
    rc: ['', Validators.pattern(IDENTIFIER)],
    ai: ['', Validators.pattern(IDENTIFIER)],
  });

  protected readonly saving = signal(false);
  protected readonly feedback = signal<string | null>(null);
  protected readonly formError = signal<FormMessage | null>(null);

  constructor() {
    effect(() => {
      const view = this.view();
      if (!view) return;
      untracked(() => {
        const values = Object.fromEntries(PROFILE_FIELDS.map((f) => [f, view[f] ?? '']));
        this.form.reset(values as Record<ProfileField, string>);
      });
    });
    // The current logo, shown as a data: URL (see header).
    effect(() => {
      const hasLogo = this.view()?.hasLogo ?? false;
      untracked(() => this.loadLogo(hasLogo));
    });
  }

  protected control(name: string): AbstractControl | null {
    return this.form.get(name);
  }

  protected invalid(name: string): boolean {
    const c = this.control(name);
    return !!c && c.invalid && c.touched;
  }

  /** The message of an invalid field: the server's, else ours. */
  protected errorKey(name: string): string {
    const c = this.control(name);
    if (c?.hasError('required')) return 'documents.form.required';
    if (c?.hasError('maxlength')) return 'documents.form.tooLong';
    if (c?.hasError('email')) return 'documents.form.email';
    if (c?.hasError('pattern')) return 'documents.form.identifier';
    return 'documents.form.invalid';
  }

  protected save(): void {
    this.formError.set(null);
    this.feedback.set(null);
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const raw = this.form.getRawValue();
    const body = Object.fromEntries(PROFILE_FIELDS.map((f) => [f, raw[f].trim() || null])) as unknown as CompanyProfileFields;
    this.saving.set(true);
    this.api.updateProfile(body).subscribe({
      next: (saved) => {
        this.saving.set(false);
        this.profile.set(saved);
        this.feedback.set('documents.profile.saved');
      },
      error: (error: unknown) => {
        this.saving.set(false);
        this.formError.set(problemToForm(this.form, error, CONFIG_SLUGS));
      },
    });
  }

  // --- Logo -------------------------------------------------------------------------------------------------------

  protected readonly logoUrl = signal<string | null>(null);
  protected readonly pendingFile = signal<File | null>(null);
  protected readonly pendingUrl = signal<string | null>(null);
  protected readonly logoError = signal<LogoError>(null);
  protected readonly logoErrorKeys = LOGO_FIELD_KEYS;
  protected readonly logoMessage = signal<FormMessage | null>(null);
  protected readonly logoBusy = signal(false);

  private loadLogo(hasLogo: boolean): void {
    if (!hasLogo) {
      this.logoUrl.set(null);
      return;
    }
    this.api.logo().subscribe({
      next: (blob) => void blobToDataUrl(blob).then((url) => this.logoUrl.set(url), () => this.logoUrl.set(null)),
      error: () => this.logoUrl.set(null),
    });
  }

  protected onFile(event: Event): void {
    const input = event.target instanceof HTMLInputElement ? event.target : null;
    const file = input?.files?.[0] ?? null;
    this.logoMessage.set(null);
    this.pendingUrl.set(null);
    if (!file) {
      this.pendingFile.set(null);
      this.logoError.set(null);
      return;
    }
    const error: LogoError = !LOGO_TYPES.includes(file.type) ? 'type' : file.size > LOGO_MAX_BYTES ? 'size' : null;
    this.logoError.set(error);
    this.pendingFile.set(error ? null : file);
    if (!error) void blobToDataUrl(file).then((url) => this.pendingUrl.set(url), () => this.pendingUrl.set(null));
  }

  protected uploadLogo(input: HTMLInputElement): void {
    const file = this.pendingFile();
    if (!file) return;
    this.logoBusy.set(true);
    this.api.uploadLogo(file, file.name).subscribe({
      next: (saved) => {
        this.logoBusy.set(false);
        this.pendingFile.set(null);
        this.pendingUrl.set(null);
        input.value = '';
        this.profile.set(saved);
        this.logoMessage.set({ key: 'documents.profile.logoSaved' });
      },
      error: (error: unknown) => {
        this.logoBusy.set(false);
        // a refusal of the file itself (type, size, pixel dimensions) goes under the file input, like the local
        // checks; the file is dropped so it cannot be sent again as is
        const fieldError = logoFieldError(error);
        if (fieldError) {
          this.logoError.set(fieldError);
          this.pendingFile.set(null);
          this.pendingUrl.set(null);
          input.value = '';
        } else {
          this.logoMessage.set(logoProblem(error));
        }
      },
    });
  }

  protected removeLogo(): void {
    this.logoBusy.set(true);
    this.api.deleteLogo().subscribe({
      next: () => {
        this.logoBusy.set(false);
        this.logoMessage.set({ key: 'documents.profile.logoRemoved' });
        this.profile.reload();
      },
      error: (error: unknown) => {
        this.logoBusy.set(false);
        this.logoMessage.set(logoProblem(error));
      },
    });
  }
}

