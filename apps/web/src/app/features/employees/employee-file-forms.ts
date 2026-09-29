/**
 * Validators and problem mapping of the employee file forms (upload, delete) — plain TypeScript over the Forms API,
 * no DI (the pattern of employee-forms.ts and core/http/problem-form.ts).
 *
 * - `acceptedFile`: the client-side COURTESY check of the chosen file (core/employee-files/employee-files.models.ts
 *   explains why the API, which reads the bytes, stays the authority).
 * - `uploadProblemToForm()`: the API's 422 `errors[{field: 'file', code}]` codes are translated on the file control
 *   (the API writes its messages in English only); the business-rule slugs go through the usual slug table.
 */
import type { AbstractControl, FormGroup, ValidationErrors, ValidatorFn } from '@angular/forms';
import { checkFile } from '../../core/employee-files/employee-files.models';
import { ApiProblemError, isApiProblemError } from '../../core/http/api-problem';
import { type FormMessage, problemToForm, type SlugTable } from '../../core/http/problem-form';

/** `{ fileEmpty }`, `{ fileType }` or `{ fileSize }` for a `File` the API would refuse; `null` when empty or fine. */
export const acceptedFile: ValidatorFn = (control: AbstractControl): ValidationErrors | null => {
  const file: unknown = control.value;
  if (!(file instanceof File)) return null;
  const check = checkFile(file);
  if (check === 'empty') return { fileEmpty: true };
  if (check === 'type') return { fileType: true };
  if (check === 'size') return { fileSize: true };
  return null;
};

/** Required, spaces alone do not count. */
export const notBlank: ValidatorFn = (control: AbstractControl): ValidationErrors | null =>
  typeof control.value === 'string' && control.value.trim() ? null : { required: true };

/** Trimmed length between `min` and `max` (the delete reason: 3–500). Empty → `required`. */
export function trimmedLength(min: number, max: number): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const length = typeof control.value === 'string' ? control.value.trim().length : 0;
    if (length === 0) return { required: true };
    if (length < min) return { minlength: { requiredLength: min } };
    if (length > max) return { maxlength: { requiredLength: max } };
    return null;
  };
}

/** Translation key of the file control's error. */
export function fileErrorKey(control: AbstractControl): string {
  const serverKey: unknown = control.getError('serverKey');
  if (typeof serverKey === 'string') return serverKey;
  if (control.hasError('fileEmpty')) return 'documents.file.errors.empty';
  if (control.hasError('fileType')) return 'documents.file.errors.unsupported_type';
  if (control.hasError('fileSize')) return 'documents.file.errors.too_large';
  if (control.hasError('required')) return 'documents.file.errors.required';
  return 'errors.generic';
}

/** 422 codes on `file` the web translates (docs/contracts/documents.md › Upload validation). */
export const FILE_CODES: readonly string[] = ['too_large', 'unsupported_type', 'empty', 'required'];

export const UPLOAD_SLUGS: SlugTable = {
  'employee-file-duplicate': { key: 'documents.file.errors.duplicate', field: 'file' },
  'forbidden-field': { key: 'documents.file.problems.medicalForbidden', field: 'categoryId' },
};

export const DELETE_SLUGS: SlugTable = {
  'employee-file-deleted': { key: 'documents.file.problems.alreadyDeleted' },
};

/** A failed upload → errors on the form's controls, and the message to show above it (if any). */
export function uploadProblemToForm(form: FormGroup, error: unknown): FormMessage | null {
  // 413 never comes from the API (it answers 422 too_large) but from the reverse proxy, which refuses bodies over
  // 25 MB outright (deploy/Caddyfile): same meaning, same message, on the file field.
  if (isApiProblemError(error) && error.status === 413) {
    const control = form.get('file');
    if (control) {
      control.setErrors({ ...control.errors, serverKey: 'documents.file.errors.too_large' });
      control.markAsTouched();
      return null;
    }
  }
  if (isApiProblemError(error)) {
    const fileError = error.problem.errors?.find((e) => e.field === 'file' && FILE_CODES.includes(e.code));
    const control = form.get('file');
    if (fileError && control) {
      control.setErrors({ ...control.errors, serverKey: `documents.file.errors.${fileError.code}` });
      control.markAsTouched();
      const others = (error.problem.errors ?? []).filter((e) => e !== fileError);
      if (others.length === 0) return null;
      return problemToForm(form, new ApiProblemError({ ...error.problem, errors: others }, { cause: error }), UPLOAD_SLUGS);
    }
  }
  return problemToForm(form, error, UPLOAD_SLUGS);
}
