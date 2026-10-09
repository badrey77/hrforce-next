/**
 * One tab of /settings/branding — the installation default or the caller's company (docs/contracts/branding.md ›
 * Settings section): texts in three languages with counters, the palette, the logos, the live preview, save and
 * reset. Both tabs use this component; `level` decides the fields, the endpoints and what an empty field inherits.
 */
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { type AbstractControl, NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { TranslocoDirective } from '@jsverse/transloco';
import { map } from 'rxjs';
import { Session } from '../../../core/auth/session';
import { BrandingApi } from '../../../core/branding/branding-api';
import {
  BRAND_COLORS,
  type BrandColor,
  type BrandingSettingsView,
  isBrandColor,
  type Lang3,
  resolve,
} from '../../../core/branding/branding.models';
import { DocumentsApi } from '../../../core/documents/documents-api';
import { isApiProblemError } from '../../../core/http/api-problem';
import type { FormMessage } from '../../../core/http/problem-form';
import { LanguageService } from '../../../core/i18n/language.service';
import type { AppLanguage } from '../../../core/i18n/languages';
import { RevealAlert } from '../../../shared/reveal-alert/reveal-alert.directive';
import {
  applyWriteProblem,
  type BrandingLevel,
  DEFAULT_LIMITS,
  draftLength,
  FORM_LANGUAGES,
  fromLang3,
  frRequired,
  isScopeRefusal,
  LEVEL_FIELDS,
  LOGO_ERROR_KEYS,
  logoUploadError,
  MULTILINE_FIELDS,
  TEXT_FIELDS,
  type TextField,
  textErrorKey,
  textLimit,
  toLang3,
  writeMessage,
} from './branding-forms';
import { BrandingLogo } from './branding-logo';
import { BrandingPreview } from './branding-preview';
import { ConfirmDialog } from './confirm-dialog';

/** Needed for the two one-click copies between the company logo and the documents' letterhead logo. */
export const LETTERHEAD_PERMISSION = 'document.configure';

type Draft = Record<TextField, Record<AppLanguage, string>>;

@Component({
  selector: 'app-branding-form',
  imports: [ReactiveFormsModule, TranslocoDirective, RevealAlert, BrandingLogo, BrandingPreview, ConfirmDialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './branding-form.html',
  styleUrl: './branding-form.css',
})
export class BrandingForm {
  private readonly api = inject(BrandingApi);
  private readonly documents = inject(DocumentsApi);
  private readonly session = inject(Session);
  private readonly language = inject(LanguageService);
  private readonly fb = inject(NonNullableFormBuilder);

  readonly level = input.required<BrandingLevel>();
  readonly view = input.required<BrandingSettingsView>();
  /** A write answered with the new view. */
  readonly saved = output<BrandingSettingsView>();
  /** A write answered 204: the view must be read again. */
  readonly reload = output<void>();
  /** The caller holds the permission on part of the company only: the settings can be read, not changed. */
  readonly readOnly = input(false);
  /** A write was refused for lack of company-wide scope. */
  readonly scopeRefused = output<void>();

  private limits = DEFAULT_LIMITS;
  protected readonly form = this.fb.group(
    Object.fromEntries(TEXT_FIELDS.map((field) => [field, this.langGroup(field)])) as Record<TextField, ReturnType<BrandingForm['langGroup']>>,
  );
  private readonly draft = toSignal(this.form.valueChanges.pipe(map(() => this.form.getRawValue() as Draft)), {
    initialValue: this.form.getRawValue() as Draft,
  });

  protected readonly languages = FORM_LANGUAGES;
  protected readonly fields = computed(() => LEVEL_FIELDS[this.level()]);
  /** The palette the API lists, limited to the codes this build can draw. */
  protected readonly palette = computed(() => {
    const listed = this.view().palette.filter(isBrandColor);
    return listed.length > 0 ? listed : BRAND_COLORS;
  });
  protected readonly canCopyLetterhead = this.session.allows(LETTERHEAD_PERMISSION);
  protected readonly logoErrorKeys = LOGO_ERROR_KEYS;

  /** The chosen colour; `null` = « Par défaut (installation) », on the company tab only. */
  protected readonly color = signal<BrandColor | null>(null);
  protected readonly colorInvalid = signal(false);
  /** A logo chosen but not saved yet, as a `data:` URL (shown in the preview). */
  protected readonly pendingAppLogo = signal<string | null>(null);

  protected readonly saving = signal(false);
  protected readonly feedback = signal<string | null>(null);
  protected readonly formError = signal<FormMessage | null>(null);
  protected readonly copyBusy = signal(false);
  protected readonly copyMessage = signal<{ readonly key: string; readonly ok: boolean } | null>(null);

  private readonly confirm = viewChild.required(ConfirmDialog);

  /** What is stored for this level's texts and colour; the form follows it, and only it (a logo upload changes the
   *  view too, and must not throw away what is being typed). */
  private readonly stored = computed(() => this.storedIn(this.view()), { equal: (a, b) => JSON.stringify(a) === JSON.stringify(b) });

  constructor() {
    effect(() => {
      const stored = this.stored();
      untracked(() => this.show(stored));
    });
  }

  private storedIn(view: BrandingSettingsView) {
    const level = this.level() === 'installation' ? view.installation : view.company;
    const source = (level ?? {}) as Partial<Record<TextField, Lang3>> & { readonly color?: BrandColor | null };
    return {
      limits: view.limits,
      texts: Object.fromEntries(TEXT_FIELDS.map((field) => [field, fromLang3(source[field])])) as Draft,
      color: isBrandColor(source.color) ? source.color : null,
    };
  }

  /** Puts stored values into the form (pristine again). */
  private show(stored: ReturnType<BrandingForm['storedIn']>): void {
    this.limits = stored.limits;
    this.form.reset(stored.texts);
    this.color.set(stored.color ?? (this.level() === 'installation' ? 'blue' : null));
    this.colorInvalid.set(false);
  }

  // --- Text fields --------------------------------------------------------------------------------------------------

  private langGroup(field: TextField) {
    const multiline = MULTILINE_FIELDS.has(field);
    const limit = textLimit(() => this.limits[field], multiline);
    return this.fb.group({ fr: ['', limit], ar: ['', limit], en: ['', limit] }, { validators: frRequired });
  }

  protected multiline(field: TextField): boolean {
    return MULTILINE_FIELDS.has(field);
  }

  protected limit(field: TextField): number {
    return this.view().limits[field];
  }

  protected count(field: TextField, lang: AppLanguage): number {
    return draftLength(this.draft()[field][lang], MULTILINE_FIELDS.has(field));
  }

  /** Shown once the input was used (or the server refused it), not on a pristine form. */
  protected errorKey(field: TextField, lang: AppLanguage): string | null {
    this.draft();
    const group: AbstractControl = this.form.controls[field];
    return group.touched || group.dirty ? textErrorKey(group, lang) : null;
  }

  /** What an empty company field falls back to, per language (the input's placeholder). */
  protected inheritedIn(field: TextField, lang: AppLanguage): string {
    const inherited = this.inheritedOf(field);
    return (inherited?.[lang] ?? '') || '';
  }

  /** « Par défaut : … » under a company field that is empty: the inherited text in the UI language. */
  protected inheritedText(field: TextField): string | null {
    if (this.draft()[field].fr.trim() !== '') return null;
    return resolve(this.inheritedOf(field), this.language.current())?.text ?? null;
  }

  private inheritedOf(field: TextField): Lang3 | null {
    if (this.level() !== 'company') return null;
    const inherited = this.view().inherited;
    return field === 'appTitle' ? inherited.appTitle : field === 'footer' ? inherited.footer : null;
  }

  // --- Colour -------------------------------------------------------------------------------------------------------

  protected pick(color: BrandColor | null): void {
    this.color.set(color);
    this.colorInvalid.set(false);
    this.feedback.set(null);
  }

  // --- Preview ------------------------------------------------------------------------------------------------------

  private previewText(field: TextField): string | null {
    const lang = this.language.current();
    if (!this.fields().includes(field)) return null;
    const own = toLang3(this.draft()[field], MULTILINE_FIELDS.has(field));
    // Same rule as the API: the level's own triple as soon as it has French, else the whole inherited triple.
    return resolve(own.fr !== null ? own : this.inheritedOf(field), lang)?.text ?? null;
  }

  protected readonly preview = computed(() => {
    const view = this.view();
    const company = this.level() === 'company';
    const ownLogo = company ? view.company.appLogo : view.installation?.appLogo;
    return {
      color: this.color() ?? view.inherited.color,
      logoUrl: this.pendingAppLogo() ?? ownLogo?.url ?? (company ? view.inherited.appLogo?.url : null) ?? null,
      title: this.previewText('appTitle'),
      welcomeTitle: this.previewText('welcomeTitle'),
      welcomeMessage: this.previewText('welcomeMessage'),
      signInMessage: this.previewText('signInMessage'),
      footer: this.previewText('footer'),
    };
  });

  // --- Save and reset -----------------------------------------------------------------------------------------------

  protected save(): void {
    if (this.saving()) return;
    this.feedback.set(null);
    this.formError.set(null);
    this.form.markAllAsTouched();
    if (this.fields().some((field) => this.form.controls[field].invalid)) {
      this.formError.set({ key: 'branding.errors.fix' });
      return;
    }
    const draft = this.form.getRawValue() as Draft;
    const text = (field: TextField): Lang3 => toLang3(draft[field], MULTILINE_FIELDS.has(field));
    const request =
      this.level() === 'installation'
        ? this.api.saveInstallation({ appTitle: text('appTitle'), signInMessage: text('signInMessage'), footer: text('footer'), color: this.color() ?? 'blue' })
        : this.api.saveCompany({
            appTitle: text('appTitle'),
            welcomeTitle: text('welcomeTitle'),
            welcomeMessage: text('welcomeMessage'),
            footer: text('footer'),
            color: this.color(),
          });
    this.saving.set(true);
    request.subscribe({
      next: (view) => {
        this.saving.set(false);
        // The server cleans the texts: show what it stored, also when that equals what was stored before.
        this.show(this.storedIn(view));
        this.feedback.set('branding.saved');
        this.saved.emit(view);
      },
      error: (error: unknown) => {
        this.saving.set(false);
        if (isScopeRefusal(error)) this.scopeRefused.emit();
        const problem = applyWriteProblem(this.form, error);
        this.colorInvalid.set(problem.colorInvalid);
        this.formError.set(problem.message ?? { key: 'branding.errors.fix' });
      },
    });
  }

  protected async reset(): Promise<void> {
    const level = this.level();
    const yes = await this.confirm().ask({
      titleKey: 'branding.reset.title',
      messageKey: `branding.reset.${level}`,
      confirmKey: 'branding.reset.confirm',
      danger: true,
    });
    if (!yes || this.saving()) return;
    this.saving.set(true);
    this.feedback.set(null);
    this.formError.set(null);
    this.api.reset(level).subscribe({
      next: () => {
        this.saving.set(false);
        // Also when nothing was stored (the view does not change then): the form goes back to what is stored.
        this.show(this.stored());
        this.feedback.set('branding.reset.done');
        this.reload.emit();
      },
      error: (error: unknown) => {
        this.saving.set(false);
        if (isScopeRefusal(error)) this.scopeRefused.emit();
        this.formError.set(writeMessage(error));
      },
    });
  }

  // --- Copies between the company logo and the documents' letterhead ------------------------------------------------

  /** « Reprendre le logo de l'en-tête des documents »: the letterhead logo becomes the company logo. */
  protected async copyFromLetterhead(): Promise<void> {
    const yes = await this.confirm().ask({
      titleKey: 'branding.letterhead.fromTitle',
      messageKey: 'branding.letterhead.fromConfirm',
      confirmKey: 'branding.letterhead.from',
    });
    if (!yes || this.copyBusy()) return;
    this.copyBusy.set(true);
    this.copyMessage.set(null);
    this.documents.logo().subscribe({
      next: (blob) =>
        this.api.uploadLogo('company', blob).subscribe({
          next: (view) => {
            this.copyBusy.set(false);
            this.copyMessage.set({ key: 'branding.letterhead.fromDone', ok: true });
            this.saved.emit(view);
          },
          error: (error: unknown) => this.copyFailed(error),
        }),
      error: (error: unknown) => this.copyFailed(error, 'branding.letterhead.none'),
    });
  }

  /** « Utiliser ce logo pour l'en-tête des documents »: the company logo becomes the letterhead logo. */
  protected async copyToLetterhead(): Promise<void> {
    const logo = this.view().company.companyLogo;
    if (!logo) return;
    const yes = await this.confirm().ask({
      titleKey: 'branding.letterhead.toTitle',
      messageKey: 'branding.letterhead.toConfirm',
      confirmKey: 'branding.letterhead.to',
    });
    if (!yes || this.copyBusy()) return;
    this.copyBusy.set(true);
    this.copyMessage.set(null);
    this.api.logoBytes(logo.url).subscribe({
      next: (blob) =>
        this.documents.uploadLogo(blob).subscribe({
          next: () => {
            this.copyBusy.set(false);
            this.copyMessage.set({ key: 'branding.letterhead.toDone', ok: true });
          },
          error: (error: unknown) => this.copyFailed(error),
        }),
      error: (error: unknown) => this.copyFailed(error),
    });
  }

  private copyFailed(error: unknown, notFoundKey?: string): void {
    this.copyBusy.set(false);
    const refused = logoUploadError(error);
    const message = writeMessage(error);
    if (isScopeRefusal(error)) this.scopeRefused.emit();
    const missing = notFoundKey !== undefined && isApiProblemError(error) && error.status === 404;
    const key = refused ? LOGO_ERROR_KEYS[refused] : missing ? notFoundKey : 'key' in message ? message.key : 'errors.generic';
    this.copyMessage.set({ key, ok: false });
  }
}
