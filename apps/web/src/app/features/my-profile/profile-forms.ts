/**
 * Validators, error keys and the submit flow shared by the « Mon profil » section forms. The API validates the same
 * rules (docs/contracts/profile-changes.md); these checks only give a translated message before the round trip.
 */
import { computed, DestroyRef, inject, signal } from '@angular/core';
import type { AbstractControl, FormGroup, ValidationErrors, ValidatorFn } from '@angular/forms';
import type { Subscription } from 'rxjs';
import { checkFile, EMPLOYEE_FILE_MAX_BYTES } from '../../core/employee-files/employee-files.models';
import { ApiProblemError, isApiProblemError } from '../../core/http/api-problem';
import { type FormMessage, problemSlug, problemToForm, type SlugTable } from '../../core/http/problem-form';
import { ProfileApi } from '../../core/profile/profile-api';
import {
  type NewProfileRequest,
  PHONE_PATTERN,
  POSTAL_CODE_PATTERN,
  PROFILE_LIMITS,
  PROFILE_PROBLEMS,
  type ProfileRequestView,
  RIB_PATTERN,
  normaliseRib,
} from '../../core/profile/profile.models';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Today as `YYYY-MM-DD` in the device's time zone (a birth date typed today is not « in the future »). */
function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function todayIso(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function textOf(control: AbstractControl): string {
  return typeof control.value === 'string' ? control.value.trim() : '';
}

export const phone: ValidatorFn = (control) => {
  const value = textOf(control);
  return value === '' || PHONE_PATTERN.test(value) ? null : { phone: true };
};

export const email: ValidatorFn = (control) => {
  const value = textOf(control);
  return value === '' || (value.length <= PROFILE_LIMITS.email && EMAIL.test(value)) ? null : { email: true };
};

export const postalCode: ValidatorFn = (control) => {
  const value = textOf(control);
  return value === '' || POSTAL_CODE_PATTERN.test(value) ? null : { postalCode: true };
};

export const rib: ValidatorFn = (control) => {
  const value = typeof control.value === 'string' ? normaliseRib(control.value) : '';
  return value === '' || RIB_PATTERN.test(value) ? null : { rib: true };
};

export const notBlank: ValidatorFn = (control) => (textOf(control) === '' ? { required: true } : null);

/** A `YYYY-MM-DD` date not after today. */
export function pastDate(today: () => string = todayIso): ValidatorFn {
  return (control) => {
    const value = textOf(control);
    if (value === '') return null;
    if (!DATE.test(value)) return { isoDate: true };
    return value > today() ? { future: true } : null;
  };
}

/** The files control: courtesy checks of type / size / emptiness, at most `PROFILE_LIMITS.files`. */
export const acceptedFiles: ValidatorFn = (control): ValidationErrors | null => {
  const files = Array.isArray(control.value) ? (control.value as File[]) : [];
  if (files.length > PROFILE_LIMITS.files) return { tooMany: true };
  for (const file of files) {
    const problem = checkFile(file, EMPLOYEE_FILE_MAX_BYTES);
    if (problem) return { file: problem };
  }
  return null;
};

/** The translation key of a control's first error. */
export function profileErrorKey(control: AbstractControl): string {
  const serverKey: unknown = control.getError('serverKey');
  if (typeof serverKey === 'string') return serverKey;
  if (control.hasError('required')) return 'profile.errors.required';
  if (control.hasError('maxlength')) return 'profile.errors.tooLong';
  if (control.hasError('phone')) return 'profile.errors.phone';
  if (control.hasError('email')) return 'profile.errors.email';
  if (control.hasError('postalCode')) return 'profile.errors.postalCode';
  if (control.hasError('rib')) return 'profile.errors.rib';
  if (control.hasError('isoDate')) return 'profile.errors.invalidDate';
  if (control.hasError('future')) return 'profile.errors.future';
  if (control.hasError('tooMany')) return 'profile.files.tooMany';
  if (control.hasError('filesRequired')) return 'profile.files.required';
  const file: unknown = control.getError('file');
  if (file === 'empty') return 'documents.file.errors.empty';
  if (file === 'type') return 'documents.file.errors.unsupported_type';
  if (file === 'size') return 'documents.file.errors.too_large';
  return 'errors.generic';
}

export function profileErrorParams(control: AbstractControl): Record<string, string | number> {
  const max: unknown = control.getError('maxlength');
  if (max && typeof max === 'object') return { max: (max as { requiredLength: number }).requiredLength };
  return {};
}

/** Refusals of `POST /me/profile/requests` that are not field errors. */
export const PROFILE_REQUEST_SLUGS: SlugTable = {
  [PROFILE_PROBLEMS.pending]: { key: 'profile.problems.pending' },
  [PROFILE_PROBLEMS.employmentEnded]: { key: 'profile.problems.ended' },
  [PROFILE_PROBLEMS.notLinked]: { key: 'profile.problems.notLinked' },
};

const FILE_CODES: Readonly<Record<string, string>> = {
  required: 'profile.files.required',
  empty: 'documents.file.errors.empty',
  unsupported_type: 'documents.file.errors.unsupported_type',
  too_large: 'documents.file.errors.too_large',
  too_many: 'profile.files.tooMany',
};

/**
 * A refused request → form errors. `payload` `unchanged` becomes the form's message; `files…` errors go to the
 * `files` control (a 413 from the reverse proxy too); `payload.x` field paths reach the `payload` group's controls.
 */
export function requestProblemToForm(form: FormGroup, error: unknown): FormMessage | null {
  if (!isApiProblemError(error)) return problemToForm(form, error, PROFILE_REQUEST_SLUGS);
  const filesControl = form.get('files');
  if (error.status === 413 && filesControl) {
    filesControl.setErrors({ serverKey: 'documents.file.errors.too_large' });
    filesControl.markAsTouched();
    return null;
  }
  const errors = error.problem.errors ?? [];
  const unchanged = errors.some((e) => e.field === 'payload' && e.code === 'unchanged');
  const message: FormMessage | null = unchanged ? { key: 'profile.problems.unchanged' } : null;
  const rest = errors.filter((e) => {
    if (e.field === 'payload' && e.code === 'unchanged') return false;
    if ((e.field === 'files' || e.field.startsWith('files.')) && filesControl) {
      filesControl.setErrors({ serverKey: FILE_CODES[e.code] ?? 'profile.files.invalid' });
      filesControl.markAsTouched();
      return false;
    }
    return true;
  });
  if (rest.length === errors.length) return problemToForm(form, error, PROFILE_REQUEST_SLUGS);
  if (rest.length === 0) return message;
  return message ?? problemToForm(form, new ApiProblemError({ ...error.problem, errors: rest }, { cause: error }), PROFILE_REQUEST_SLUGS);
}

export interface SubmitProgress {
  readonly loaded: number;
  readonly total: number | null;
}

/**
 * The submit of one section form: progress while the files go up, the refusal mapped onto the form, abort. Create it
 * in a field initializer (it injects).
 */
export class RequestSubmission {
  private readonly api = inject(ProfileApi);
  private subscription: Subscription | null = null;
  readonly progress = signal<SubmitProgress | null>(null);
  readonly busy = computed(() => this.progress() !== null);
  readonly percent = computed(() => {
    const p = this.progress();
    return p?.total ? Math.min(100, Math.round((p.loaded / p.total) * 100)) : null;
  });
  readonly formError = signal<FormMessage | null>(null);
  /** The API said the account is no longer linked to an open employment. */
  readonly lostLink = signal(false);

  constructor() {
    inject(DestroyRef).onDestroy(() => this.subscription?.unsubscribe());
  }

  submit(form: FormGroup, request: NewProfileRequest, files: readonly File[], done: (request: ProfileRequestView) => void): void {
    this.formError.set(null);
    this.progress.set({ loaded: 0, total: files.reduce((total, f) => total + f.size, 0) || null });
    this.subscription = this.api.submit(request, files).subscribe({
      next: (event) => {
        if (event.kind === 'progress') {
          this.progress.set({ loaded: event.loaded, total: event.total });
          return;
        }
        this.progress.set(null);
        done(event.request);
      },
      error: (error: unknown) => {
        this.progress.set(null);
        if (isApiProblemError(error) && problemSlug(error.problem.type) === PROFILE_PROBLEMS.notLinked) this.lostLink.set(true);
        this.formError.set(requestProblemToForm(form, error));
      },
    });
  }

  abort(): void {
    this.subscription?.unsubscribe();
    this.subscription = null;
    this.progress.set(null);
    this.formError.set({ key: 'profile.upload.aborted' });
  }
}
