/** Validators, error keys and server-error mapping shared by the recruitment forms. */
import { type AbstractControl, type FormGroup, type ValidationErrors, type ValidatorFn } from '@angular/forms';
import { isIsoDate } from '../../core/date/iso-date';
import { checkFile } from '../../core/employee-files/employee-files.models';
import { ApiProblemError, isApiProblemError } from '../../core/http/api-problem';
import type { FormMessage, SlugTable } from '../../core/http/problem-form';
import { type CandidateInput, NAME_MAX } from '../../core/recruitment/recruitment.models';
import { attendanceProblemToForm, type FieldCodeTable } from '../../shared/attendance/attendance-forms';

/** Client-side error name → message key, for `<app-control-error [keys]>`. */
export const ERROR_KEYS: Readonly<Record<string, string>> = {
  required: 'recruitment.errors.required',
  minlength: 'recruitment.errors.tooShort',
  maxlength: 'recruitment.errors.tooLong',
  range: 'recruitment.errors.range',
  isoDate: 'recruitment.errors.date',
  past: 'recruitment.errors.past',
  future: 'recruitment.errors.future',
  digits: 'recruitment.errors.nin',
  email: 'recruitment.errors.email',
  pattern: 'recruitment.errors.pattern',
  money: 'employees.form.errors.money',
  fileEmpty: 'documents.file.errors.empty',
  fileType: 'documents.file.errors.unsupported_type',
  fileSize: 'documents.file.errors.too_large',
};

export function text(min: number, max: number, required = true): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const length = typeof control.value === 'string' ? control.value.trim().length : 0;
    if (length === 0) return required ? { required: true } : null;
    if (length < min) return { minlength: { requiredLength: min } };
    if (length > max) return { maxlength: { requiredLength: max } };
    return null;
  };
}

export function wholeNumber(min: number, max: number): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const raw: unknown = control.value;
    if (raw === null || raw === '' || raw === undefined) return { required: true };
    const value = Number(raw);
    return Number.isInteger(value) && value >= min && value <= max ? null : { range: { min, max } };
  };
}

export const isoDate: ValidatorFn = (control) => (!control.value || isIsoDate(control.value) ? null : { isoDate: true });

export function notBeforeDay(min: () => string): ValidatorFn {
  return (control) => (isIsoDate(control.value) && control.value < min() ? { past: true } : null);
}

export function notAfterDay(max: () => string): ValidatorFn {
  return (control) => (isIsoDate(control.value) && control.value > max() ? { future: true } : null);
}

export const nin: ValidatorFn = (control) => {
  const value = typeof control.value === 'string' ? control.value.replace(/\s+/g, '') : '';
  return value === '' || /^\d{18}$/.test(value) ? null : { digits: true };
};

export const emailLike: ValidatorFn = (control) => {
  const value = typeof control.value === 'string' ? control.value.trim() : '';
  return value === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? null : { email: true };
};

/** Field codes of the API's 422 / 409 answers → message keys (`<field>:<code>`). */
export const FIELD_CODES: FieldCodeTable = {
  'orgUnitId:not_found': 'recruitment.errors.unitNotFound',
  'orgUnitId:forbidden': 'recruitment.errors.unitForbidden',
  'siteId:not_found': 'recruitment.errors.siteNotFound',
  'targetDate:past': 'recruitment.errors.past',
  'posts:increase': 'recruitment.errors.postsIncrease',
  'posts:below_hired': 'recruitment.errors.postsBelowHired',
  'rejectionReasonId:required': 'recruitment.errors.required',
  'rejectionReasonId:not_found': 'recruitment.errors.reasonInactive',
  'rejectionReasonId:inactive': 'recruitment.errors.reasonInactive',
  'rejectionReasonId:auto_only': 'recruitment.errors.reasonInactive',
  'nin:duplicate': 'recruitment.errors.ninDuplicate',
  'email:duplicate': 'recruitment.errors.emailDuplicate',
  'phone:duplicate': 'recruitment.errors.phoneDuplicate',
  'candidateId:not_found': { key: 'recruitment.errors.candidateGone', control: 'source' },
  'personId:not_found': 'recruitment.errors.personNotFound',
  'file:required': 'documents.file.errors.required',
  'file:empty': 'documents.file.errors.empty',
  'file:too_large': 'documents.file.errors.too_large',
  'file:unsupported_type': 'documents.file.errors.unsupported_type',
  'file:one_file_only': 'documents.file.upload.onlyFirst',
  'interviewerIds:not_found': 'recruitment.errors.interviewerNotFound',
  'interviewerIds:duplicate': 'recruitment.errors.interviewerDuplicate',
  'interviewerIds:self': 'recruitment.errors.interviewerSelf',
  'orgUnitId:outside_opening': 'recruitment.errors.unitOutsideOpening',
  'scores:incomplete': { key: 'recruitment.errors.scoresIncomplete', control: 'recommendation' },
  'scores:unknown': { key: 'recruitment.errors.scoresIncomplete', control: 'recommendation' },
};

export const FORM_SLUGS: SlugTable = {
  'forbidden-scope': { key: 'errors.forbidden' },
  'forbidden-field': { key: 'recruitment.problems.salaryForbidden', field: 'expectedSalary' },
  'recruitment-opening-not-open': { key: 'recruitment.problems.openingNotOpen' },
  'recruitment-opening-not-closed': { key: 'recruitment.problems.openingNotClosed' },
  'recruitment-no-post-left': { key: 'recruitment.problems.noPostLeft' },
  'recruitment-already-applied': { key: 'recruitment.problems.alreadyApplied' },
  'recruitment-stage-changed': { key: 'recruitment.problems.stageChanged' },
  'recruitment-file-duplicate': { key: 'recruitment.files.duplicate', field: 'file' },
  'recruitment-file-limit': { key: 'recruitment.problems.fileLimit' },
  'recruitment-reason-code-taken': { key: 'recruitment.settings.reasons.codeTaken', field: 'code' },
  'recruitment-criterion-code-taken': { key: 'recruitment.settings.reasons.codeTaken', field: 'code' },
  'recruitment-criteria-locked': { key: 'recruitment.problems.criteriaLocked' },
  'recruitment-interview-stage': { key: 'recruitment.problems.interviewStage' },
  'recruitment-interview-cancelled': { key: 'recruitment.problems.interviewCancelled' },
  'recruitment-evaluation-exists': { key: 'recruitment.problems.evaluationExists', field: 'interviewerIds' },
  'recruitment-evaluation-closed': { key: 'recruitment.problems.evaluationClosed' },
  'recruitment-interview-not-held': { key: 'recruitment.problems.interviewNotHeld' },
  'recruitment-no-offer': { key: 'recruitment.problems.noOffer' },
  'recruitment-employment-open': { key: 'recruitment.problems.employmentOpen' },
};

/**
 * Server answer → field errors where the form has the control, else one top-of-form message.
 * `slugs` overrides the module table (e.g. the request form puts `forbidden-scope` on the unit).
 */
export function recruitmentProblemToForm(form: FormGroup, error: unknown, slugs: SlugTable = {}, notFoundKey = 'recruitment.problems.gone'): FormMessage | null {
  return attendanceProblemToForm(form, error, { ...FORM_SLUGS, ...slugs }, FIELD_CODES, notFoundKey);
}

/**
 * Drops the errors a previous server answer put on the controls (they stay until the value changes, which would
 * block a deliberate second attempt such as « Enregistrer quand même »).
 */
export function clearServerErrors(form: FormGroup): void {
  for (const control of Object.values(form.controls)) {
    if (control.hasError('serverKey') || control.hasError('server')) control.updateValueAndValidity();
  }
}

/**
 * The API names a new candidate's field errors `candidate.<field>` (the 409 duplicate names the bare fields): the
 * same error with the prefix removed, so both land on the identity form's controls.
 */
export function withoutFieldPrefix(error: unknown, prefix: string): unknown {
  if (!isApiProblemError(error) || !error.problem.errors?.some((e) => e.field.startsWith(prefix))) return error;
  const errors = error.problem.errors.map((e) => (e.field.startsWith(prefix) ? { ...e, field: e.field.slice(prefix.length) } : e));
  return new ApiProblemError({ ...error.problem, errors }, { cause: error.cause });
}

/**
 * The API names an item of a list `<field>.<index>` (`interviewerIds.2`); the form has one control for the whole
 * list, so the index is dropped and the error lands on it.
 */
export function withoutFieldIndex(error: unknown, field: string): unknown {
  const indexed = new RegExp(`^${field}\\.\\d+$`);
  if (!isApiProblemError(error) || !error.problem.errors?.some((e) => indexed.test(e.field))) return error;
  const errors = error.problem.errors.map((e) => (indexed.test(e.field) ? { ...e, field } : e));
  return new ApiProblemError({ ...error.problem, errors }, { cause: error.cause });
}

export interface CandidateFormValue {
  readonly lastName: string;
  readonly firstName: string;
  readonly lastNameAr: string;
  readonly firstNameAr: string;
  readonly birthDate: string;
  readonly birthPlace: string;
  readonly sex: '' | 'M' | 'F';
  readonly nationality: string;
  readonly nin: string;
  readonly email: string;
  readonly phone: string;
  readonly informedOn: string;
}

const orNull = (value: string): string | null => value.trim() || null;

/** Form value → `CandidateInput`: trimmed, empty strings as null, the NIN without spaces. */
export function toCandidateInput(v: CandidateFormValue): CandidateInput {
  return {
    lastName: v.lastName.trim(),
    firstName: v.firstName.trim(),
    lastNameAr: orNull(v.lastNameAr),
    firstNameAr: orNull(v.firstNameAr),
    birthDate: v.birthDate || null,
    birthPlace: orNull(v.birthPlace),
    sex: v.sex || null,
    nationality: v.nationality.trim().toUpperCase() || 'DZ',
    nin: v.nin.replace(/\s+/g, '') || null,
    email: orNull(v.email)?.toLowerCase() ?? null,
    phone: orNull(v.phone),
    informedOn: v.informedOn || null,
  };
}

export const NAME_VALIDATOR = text(1, NAME_MAX);

const MONEY_PATTERN = /^\d{1,10}([.,]\d{1,2})?$/;

/** A positive amount with at most two decimals (comma or dot), as the employee pages accept it. */
export const money: ValidatorFn = (control) => {
  const value = typeof control.value === 'string' ? control.value.trim() : '';
  if (value === '') return null;
  return MONEY_PATTERN.test(value) && Number(value.replace(',', '.')) > 0 ? null : { money: true };
};

/** "65000,5" → "65000.50": the decimal string the API takes. */
export function normaliseMoney(value: string): string {
  const [whole = '0', fraction = ''] = value.trim().replace(',', '.').split('.');
  return `${whole.replace(/^0+(?=\d)/, '')}.${fraction.padEnd(2, '0')}`;
}

/** The employee-file rules (type, size, not empty) applied to a chosen candidate file. */
export const acceptedFile: ValidatorFn = (control) => {
  const file: unknown = control.value;
  if (!(file instanceof File)) return null;
  const check = checkFile(file);
  if (check === 'empty') return { fileEmpty: true };
  if (check === 'type') return { fileType: true };
  if (check === 'size') return { fileSize: true };
  return null;
};
