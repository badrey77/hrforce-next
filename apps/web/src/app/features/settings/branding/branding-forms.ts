/**
 * Pure rules of the branding settings forms (docs/contracts/branding.md › Settings section): which fields each level
 * has, the client mirror of the server's text validation, the request bodies, and where a refused write is shown.
 * The server stays the authority for all of it.
 */
import { type AbstractControl, FormGroup, type ValidationErrors, type ValidatorFn } from '@angular/forms';
import { isApiProblemError, PROBLEM_TYPE_NETWORK } from '../../../core/http/api-problem';
import { type FormMessage, problemSlug } from '../../../core/http/problem-form';
import type { BrandingLimits, Lang3 } from '../../../core/branding/branding.models';
import { APP_LANGUAGES, type AppLanguage } from '../../../core/i18n/languages';

export type BrandingLevel = 'installation' | 'company';
export type TextField = 'appTitle' | 'welcomeTitle' | 'welcomeMessage' | 'signInMessage' | 'footer';

export const TEXT_FIELDS: readonly TextField[] = ['appTitle', 'welcomeTitle', 'welcomeMessage', 'signInMessage', 'footer'];
/** The fields of each tab, in form order. */
export const LEVEL_FIELDS: Readonly<Record<BrandingLevel, readonly TextField[]>> = {
  installation: ['appTitle', 'signInMessage', 'footer'],
  company: ['appTitle', 'welcomeTitle', 'welcomeMessage', 'footer'],
};
export const MULTILINE_FIELDS: ReadonlySet<TextField> = new Set<TextField>(['welcomeMessage', 'signInMessage']);
export const MAX_LINES = 6;
export const FORM_LANGUAGES: readonly AppLanguage[] = APP_LANGUAGES;

/** The contract's limits, used until the settings view (which carries them) has arrived. */
export const DEFAULT_LIMITS: BrandingLimits = { appTitle: 40, welcomeTitle: 80, welcomeMessage: 500, signInMessage: 500, footer: 200, logoMaxBytes: 262144 };

export const LOGO_TYPES: readonly string[] = ['image/png', 'image/jpeg'];

/**
 * What the server will store for a typed text, closely enough to count and validate while typing (contract › Text
 * rules): NFC, one kind of line break, single-line fields on one line, no spaces around a line break, at most one
 * empty line in a row, single spaces, trimmed. Control and bidi characters are removed by the server only.
 */
export function cleanDraft(value: string, multiline: boolean): string {
  let text = value.normalize('NFC').replace(/\r\n?/g, '\n').replace(/\t/g, ' ');
  text = multiline ? text.replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n') : text.replace(/\n/g, ' ');
  return text.replace(/ {2,}/g, ' ').trim();
}

/** Length as the server counts it: Unicode code points of the cleaned text. */
export function draftLength(value: string, multiline: boolean): number {
  return [...cleanDraft(value, multiline)].length;
}

export function textLimit(max: () => number, multiline: boolean): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const text = cleanDraft(typeof control.value === 'string' ? control.value : '', multiline);
    if ([...text].length > max()) return { tooLong: true };
    if (multiline && text.split('\n').length > MAX_LINES) return { tooManyLines: true };
    return null;
  };
}

/** On a `{fr, ar, en}` group: French is required as soon as another language is filled. */
export const frRequired: ValidatorFn = (group: AbstractControl): ValidationErrors | null => {
  const value = group.value as Partial<Record<AppLanguage, string>>;
  const has = (lang: AppLanguage): boolean => (value[lang] ?? '').trim() !== '';
  return !has('fr') && (has('ar') || has('en')) ? { frRequired: true } : null;
};

export function toLang3(value: Partial<Record<AppLanguage, string>>, multiline: boolean): Lang3 {
  const text = (lang: AppLanguage): string | null => cleanDraft(value[lang] ?? '', multiline) || null;
  return { fr: text('fr'), ar: text('ar'), en: text('en') };
}

export function fromLang3(value: Lang3 | null | undefined): Record<AppLanguage, string> {
  return { fr: value?.fr ?? '', ar: value?.ar ?? '', en: value?.en ?? '' };
}

const SERVER_CODE_KEYS: Readonly<Record<string, string>> = {
  too_long: 'branding.errors.tooLong',
  too_big: 'branding.errors.tooLong',
  too_many_lines: 'branding.errors.tooManyLines',
  fr_required: 'branding.errors.frRequired',
};

/** The message under one input: the server's refusal first, then the client checks. `null` = nothing to show. */
export function textErrorKey(group: AbstractControl | null, lang: AppLanguage): string | null {
  const control = group?.get(lang);
  if (!group || !control) return null;
  const serverCode: unknown = control.getError('serverCode');
  if (typeof serverCode === 'string') return SERVER_CODE_KEYS[serverCode] ?? 'branding.errors.invalid';
  if (control.hasError('tooLong')) return 'branding.errors.tooLong';
  if (control.hasError('tooManyLines')) return 'branding.errors.tooManyLines';
  if (lang === 'fr' && group.hasError('frRequired')) return 'branding.errors.frRequired';
  return null;
}

/** What a refused write produced: a message above the form, and/or the colour's own error. */
export interface WriteProblem {
  readonly message: FormMessage | null;
  readonly colorInvalid: boolean;
}

/**
 * Maps a failed `PUT` onto the form: 422 `errors[{field: '<name>.<lang>', code}]` land on their input (as
 * `serverCode`), `color` on the palette; whatever matches nothing becomes one sentence above the form.
 */
export function applyWriteProblem(form: FormGroup, error: unknown): WriteProblem {
  const message = writeMessage(error);
  if (!isApiProblemError(error) || error.status !== 422) return { message, colorInvalid: false };
  let colorInvalid = false;
  let unmatched = 0;
  const errors = error.problem.errors ?? [];
  for (const item of errors) {
    if (item.field === 'color') {
      colorInvalid = true;
      continue;
    }
    // Only an input can show an error: one reported on a whole text (`appTitle`) or on the body (`""`) goes above.
    const control = item.field ? form.get(item.field) : null;
    if (!control || control instanceof FormGroup) {
      unmatched++;
      continue;
    }
    control.setErrors({ ...control.errors, serverCode: item.code });
    control.markAsTouched();
  }
  return { message: errors.length === 0 || unmatched > 0 ? message : null, colorInvalid };
}

/** The write needs the permission over the whole company (a regional holder may read the settings, not change them). */
export function isScopeRefusal(error: unknown): boolean {
  return isApiProblemError(error) && error.status === 403 && problemSlug(error.problem.type) === 'forbidden-scope';
}

/** The sentence for a failed write that is not about one field. */
export function writeMessage(error: unknown): FormMessage {
  if (!isApiProblemError(error)) return { key: 'errors.generic' };
  if (error.problem.type === PROBLEM_TYPE_NETWORK) return { key: 'errors.network' };
  switch (error.status) {
    case 403:
      return { key: problemSlug(error.problem.type) === 'forbidden-scope' ? 'branding.errors.companyWide' : 'errors.forbidden' };
    case 404:
      // The installation routes answer 404 to a company that is not (or no longer) the owner.
      return { key: 'branding.errors.unavailable' };
    case 422:
      return { key: 'branding.errors.refused' };
    default:
      return { key: 'errors.generic' };
  }
}

export type LogoError = 'type' | 'size' | 'dimensions' | 'required';

export const LOGO_ERROR_KEYS: Readonly<Record<LogoError, string>> = {
  type: 'branding.logo.errors.type',
  size: 'branding.logo.errors.size',
  dimensions: 'branding.logo.errors.dimensions',
  required: 'branding.logo.errors.required',
};

/** Courtesy check before sending (type as the browser reports it, size); the API sniffs the bytes and decides. */
export function logoPrecheck(file: Blob, maxBytes: number): LogoError | null {
  if (!LOGO_TYPES.includes(file.type)) return 'type';
  if (file.size > maxBytes) return 'size';
  return file.size === 0 ? 'required' : null;
}

const UPLOAD_CODES: Readonly<Record<string, LogoError>> = {
  unsupported_type: 'type',
  too_large: 'size',
  dimensions_too_large: 'dimensions',
  required: 'required',
};

/** The 422 `errors[{field: 'file', code}]` of a logo upload, or `null` for any other failure. */
export function logoUploadError(error: unknown): LogoError | null {
  if (!isApiProblemError(error) || error.status !== 422) return null;
  const code = error.problem.errors?.find((e) => e.field === 'file')?.code;
  return (code && UPLOAD_CODES[code]) || null;
}
