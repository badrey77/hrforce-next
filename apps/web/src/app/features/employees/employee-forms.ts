/**
 * Form helpers of the Employees feature: the contract's field rules as validators, value normalisers, and the
 * mapping of 403/409 problems onto the controls of NESTED form groups.
 *
 * Angular concepts:
 * - **A validator FACTORY** (`digits(min, max)`). `Validators.pattern(/^\d{18}$/)` would do for one field, but the
 *   contract has three digit-only identifiers with different lengths (NIN 18, RIB 20, NSS 10–15) and one message
 *   shape for all of them. A factory is a function that RETURNS a `ValidatorFn`; the returned arrow "closes over"
 *   `min`/`max` (same idea as `permissionGuard(code)` — core/auth/permission.guard.ts). The error carries its
 *   parameters (`{ digits: { min: 10, max: 15 } }`), so ONE translation with placeholders explains every field:
 *   "10 à 15 chiffres". Built-ins do the same: `Validators.maxLength(120)` is a factory; its error is
 *   `{ maxlength: { requiredLength, actualLength } }`.
 * - **Validators ignore empty values** (left to `Validators.required`): a validator answers ONE question, so an
 *   optional NIN is optional simply by not adding `required`.
 * - **Normalise in one place.** People type RIBs in groups ("0040 0123 …"). `digits()` ignores spaces, and
 *   `digitsOnly()` strips them before sending: the rule and the payload agree on what "the value" is.
 * - **A cross-SECTION validator** (`birthBeforeHire`) sits on the ROOT group, because it reads two nested groups
 *   (`identity.birthDate`, `employment.hireDate`). The error lands on the root (`form.errors.birthAfterHire`), and
 *   the template shows it next to the hire date. See docs/angular/14-big-forms-and-url-state.md.
 * - **`bothOrNeither`**: a GROUP validator for an optional section — leave the bank block empty, or fill both.
 *
 * Problems → controls (`employeeProblemToForm`): the API names fields as BODY properties (`matricule`, `nin`,
 * `rib`), while the create form nests them (`employment.matricule`, `identity.nin`, `bank.rib`). A path table
 * translates, then the known slug's TRANSLATED message goes on the control (`{ serverKey }`), as in
 * core/http/problem-form.ts. 403 `forbidden-field` (a sensitive block without the `.update` permission) lands on
 * the named field; `forbidden-scope` on the unit picker.
 */
import type { AbstractControl, FormGroup, ValidationErrors, ValidatorFn } from '@angular/forms';
import { isIsoDate } from '../../core/date/iso-date';
import { isApiProblemError } from '../../core/http/api-problem';
import { type FormMessage, problemSlug, problemToForm, type SlugTable } from '../../core/http/problem-form';

/** Contract: `^[A-Z0-9][A-Z0-9-]{0,19}$`, entered by HR, immutable. */
export const MATRICULE_PATTERN = /^[A-Z0-9][A-Z0-9-]{0,19}$/;
export const NAME_MAX = 120;
export const JOB_TITLE_MAX = 120;
/** numeric(12,2): at most 10 integer digits, 2 decimals; `,` accepted as the decimal separator (French habit). */
export const MONEY_PATTERN = /^\d{1,10}([.,]\d{1,2})?$/;
export const NATIONALITY_PATTERN = /^[A-Z]{2}$/;

/** The value without whitespace (`"0040 0123"` → `"00400123"`). */
export function digitsOnly(value: string): string {
  return value.replace(/\s+/g, '');
}

/** Validator factory: the value (spaces ignored) is `min`–`max` digits. Empty → no error (optional unless `required`). */
export function digits(min: number, max: number = min): ValidatorFn {
  const pattern = new RegExp(`^\\d{${min},${max}}$`);
  return (control: AbstractControl): ValidationErrors | null => {
    const value: unknown = control.value;
    if (typeof value !== 'string' || value.trim() === '') return null;
    return pattern.test(digitsOnly(value)) ? null : { digits: { min, max } };
  };
}

/** A positive amount with at most 2 decimals. Empty → no error. */
export const money: ValidatorFn = (control: AbstractControl): ValidationErrors | null => {
  const value: unknown = control.value;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const text = value.trim();
  if (!MONEY_PATTERN.test(text)) return { money: true };
  return Number(text.replace(',', '.')) > 0 ? null : { money: true };
};

/** `"85000,5"` → `"85000.50"`: the decimal string the API expects (no float arithmetic involved). */
export function normaliseMoney(value: string): string {
  const [whole = '0', fraction = ''] = value.trim().replace(',', '.').split('.');
  return `${whole.replace(/^0+(?=\d)/, '')}.${fraction.padEnd(2, '0')}`;
}

/** Fails with `{ required: true }` for a whitespace-only string. */
export const notBlank: ValidatorFn = (control: AbstractControl): ValidationErrors | null =>
  typeof control.value === 'string' && control.value.trim() === '' ? { required: true } : null;

/** Fails with `{ isoDate: true }` unless empty or a real `YYYY-MM-DD` date. */
export const isoDate: ValidatorFn = (control: AbstractControl): ValidationErrors | null =>
  !control.value || isIsoDate(control.value) ? null : { isoDate: true };

/** Control validator: not before `min()` (inclusive), read when it runs; `null` bound = no rule. */
export function notBefore(min: () => string | null): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const value: unknown = control.value;
    if (!isIsoDate(value)) return null; // before reading the bound: it may read an input not set yet
    const bound = min();
    if (!bound) return null;
    return value < bound ? { notBefore: { min: bound } } : null;
  };
}

/** Group validator for an optional section: every listed control empty, or every one filled. */
export function bothOrNeither(...names: string[]): ValidatorFn {
  return (group: AbstractControl): ValidationErrors | null => {
    const filled = names.map((name) => {
      const value: unknown = group.get(name)?.value;
      return typeof value === 'string' ? value.trim() !== '' : value !== null && value !== undefined;
    });
    return filled.every(Boolean) || !filled.some(Boolean) ? null : { incomplete: true };
  };
}

/** Root-group validator: the birth date (identity section) is before the hire date (employment section). */
export const birthBeforeHire: ValidatorFn = (root: AbstractControl): ValidationErrors | null => {
  const birth: unknown = root.get('identity.birthDate')?.value;
  const hire: unknown = root.get('employment.hireDate')?.value;
  if (!isIsoDate(birth) || !isIsoDate(hire)) return null;
  return birth < hire ? null : { birthAfterHire: true };
};

/** Translation key for a control's first error (`serverKey` first; `server` text is shown as-is by templates). */
export function fieldErrorKey(control: AbstractControl): string {
  const serverKey: unknown = control.getError('serverKey');
  if (typeof serverKey === 'string') return serverKey;
  if (control.hasError('required')) return 'employees.form.errors.required';
  if (control.hasError('pattern')) return 'employees.form.errors.pattern';
  if (control.hasError('maxlength')) return 'employees.form.errors.tooLong';
  if (control.hasError('isoDate')) return 'employees.form.errors.invalidDate';
  if (control.hasError('digits')) return 'employees.form.errors.digits';
  if (control.hasError('money')) return 'employees.form.errors.money';
  if (control.hasError('notBefore')) return 'employees.form.errors.notBefore';
  return 'errors.generic';
}

/** Placeholders of `fieldErrorKey`'s message (`{{min}}`/`{{max}}` for digits, the bound for notBefore). */
export function fieldErrorParams(control: AbstractControl): Record<string, string | number> {
  const digitsError: unknown = control.getError('digits');
  if (digitsError && typeof digitsError === 'object') {
    const { min, max } = digitsError as { min: number; max: number };
    return { min, max, count: min === max ? String(min) : `${min}–${max}` };
  }
  const bound: unknown = control.getError('notBefore');
  if (bound && typeof bound === 'object') return { date: (bound as { min: string }).min };
  return {};
}

// --- Problems ----------------------------------------------------------------------------------------------------

/** Where the API's body field names live in a form (`nin` → `identity.nin`). Unknown fields are tried as-is. */
export type FieldPaths = Readonly<Record<string, string>>;

/** Create form: body field → control path. */
export const CREATE_FIELD_PATHS: FieldPaths = {
  lastName: 'identity.lastName',
  firstName: 'identity.firstName',
  lastNameAr: 'identity.lastNameAr',
  firstNameAr: 'identity.firstNameAr',
  birthDate: 'identity.birthDate',
  birthPlace: 'identity.birthPlace',
  sex: 'identity.sex',
  nationality: 'identity.nationality',
  nin: 'identity.nin',
  matricule: 'employment.matricule',
  hireDate: 'employment.hireDate',
  orgUnitId: 'assignment.orgUnitId',
  siteId: 'assignment.siteId',
  jobTitle: 'assignment.jobTitle',
  salary: 'salary.baseSalary',
  baseSalary: 'salary.baseSalary',
  bank: 'bank.rib',
  rib: 'bank.rib',
  bankName: 'bank.bankName',
  nss: 'nss.nss',
};

/** Resolves an API field name (`nin`, `person.nin`, `salary.baseSalary`) to a control of `form`. */
export function controlFor(form: FormGroup, field: string, paths: FieldPaths): AbstractControl | null {
  const candidates = [paths[field], field, paths[field.split('.').at(-1) ?? ''], paths[field.split('.')[0] ?? '']];
  for (const path of candidates) {
    const control = path ? form.get(path) : null;
    if (control) return control;
  }
  return null;
}

function markServerKey(control: AbstractControl, key: string): void {
  control.setErrors({ ...control.errors, serverKey: key });
  control.markAsTouched();
}

/**
 * Applies a failed write to `form` and returns the form-level message, if any.
 * - A known slug (409 or 403 `forbidden-*`): its translated message on each field named by `errors[]` (through
 *   `paths`), else on the table's `field`, else above the form.
 * - 422 `errors[]`: the server's text on the mapped controls (field names rewritten through `paths`).
 * - Anything else: `problemToForm()` (403 → forbidden, 404 → `notFoundKey`, network…).
 */
export function employeeProblemToForm(
  form: FormGroup,
  error: unknown,
  slugs: SlugTable,
  paths: FieldPaths = {},
  notFoundKey = 'employees.problems.notFound',
): FormMessage | null {
  if (!isApiProblemError(error)) return { key: 'errors.generic' };
  const { problem } = error;
  const slug = problemSlug(problem.type);
  const rule = slug === undefined ? undefined : slugs[slug];

  if (rule) {
    const targets = (problem.errors ?? []).map((e) => controlFor(form, e.field, paths));
    const matched = targets.filter((c): c is AbstractControl => c !== null);
    if (matched.length > 0) {
      for (const control of matched) markServerKey(control, rule.key);
      return matched.length === targets.length ? null : { key: rule.key };
    }
    const fallback = rule.field ? form.get(rule.field) : null;
    if (!fallback) return { key: rule.key };
    markServerKey(fallback, rule.key);
    return null;
  }

  if (problem.status === 422 && problem.errors?.length) {
    const unmatched = problem.errors.filter((e) => {
      const control = controlFor(form, e.field, paths);
      if (!control) return true;
      control.setErrors({ ...control.errors, server: e.message });
      control.markAsTouched();
      return false;
    });
    if (unmatched.length === 0) return null;
    return { text: unmatched[0]?.message || problem.detail || problem.title };
  }

  return problemToForm(form, error, {}, notFoundKey);
}

/** `POST /employees` (the create page). */
export const CREATE_SLUGS: SlugTable = {
  'matricule-taken': { key: 'employees.problems.matriculeTaken', field: 'employment.matricule' },
  'nin-taken': { key: 'employees.problems.ninTaken', field: 'identity.nin' },
  'employment-open': { key: 'employees.problems.employmentOpen' },
  'assignment-date': { key: 'employees.problems.assignmentDate', field: 'employment.hireDate' },
  'forbidden-scope': { key: 'employees.problems.forbiddenScope', field: 'assignment.orgUnitId' },
  'forbidden-field': { key: 'employees.problems.forbiddenField' },
};

/** `PATCH /employees/:id/person`. */
export const PERSON_SLUGS: SlugTable = {
  'nin-taken': { key: 'employees.problems.ninTaken', field: 'nin' },
  'employment-ended': { key: 'employees.problems.employmentEnded' },
  'forbidden-scope': { key: 'employees.problems.forbiddenWrite' },
};

/** `POST /employees/:id/assignments`. */
export const ASSIGNMENT_SLUGS: SlugTable = {
  'assignment-date': { key: 'employees.problems.assignmentDate', field: 'validFrom' },
  'employment-ended': { key: 'employees.problems.employmentEnded' },
  'forbidden-scope': { key: 'employees.problems.forbiddenScope', field: 'orgUnitId' },
};

/** `PUT /employees/:id/salary`. */
export const SALARY_SLUGS: SlugTable = {
  'salary-date': { key: 'employees.problems.salaryDate', field: 'validFrom' },
  'employment-ended': { key: 'employees.problems.employmentEnded' },
  'forbidden-field': { key: 'employees.problems.forbiddenField', field: 'baseSalary' },
  'forbidden-scope': { key: 'employees.problems.forbiddenWrite' },
};

/** `PUT /employees/:id/bank` and `/nss`. */
export const SENSITIVE_SLUGS: SlugTable = {
  'employment-ended': { key: 'employees.problems.employmentEnded' },
  'forbidden-field': { key: 'employees.problems.forbiddenField' },
  'forbidden-scope': { key: 'employees.problems.forbiddenWrite' },
};

/** `POST /employees/:id/end`. */
export const END_SLUGS: SlugTable = {
  'end-date': { key: 'employees.problems.endDate', field: 'endDate' },
  'employment-ended': { key: 'employees.problems.employmentEnded' },
  'forbidden-scope': { key: 'employees.problems.forbiddenWrite' },
};
