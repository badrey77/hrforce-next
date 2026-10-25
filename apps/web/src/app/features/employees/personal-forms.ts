/**
 * Rules and payload builders of the « Coordonnées et famille » forms (docs/contracts/profile-changes.md › Data):
 * phones `^\+?[0-9 ]{8,20}$`, e-mail ≤ 254, postal code 5 digits, wilaya `01`–`58`, an emergency contact complete or
 * absent, children ≤ 15 with a birth date not in the future. The API validates the same rules (422 with field paths
 * such as `children.2.birthDate`, which `FormGroup.get()` resolves inside the children `FormArray`).
 */
import type { AbstractControl, ValidationErrors, ValidatorFn } from '@angular/forms';
import { isIsoDate, todayIso } from '../../core/date/iso-date';
import type { SlugTable } from '../../core/http/problem-form';
import {
  blankToNull,
  type ChildInput,
  type ChildSex,
  type ContactInput,
  type EmergencyInput,
  type FamilyInput,
  type MaritalStatus,
  PHONE_PATTERN,
  POSTAL_CODE_PATTERN,
  type Relationship,
  type SpouseEmployed,
} from '../../core/profile/profile.models';

/** A simple e-mail shape (the API's « simple pattern »): something@something.tld, no spaces. */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function text(control: AbstractControl): string | null {
  const value: unknown = control.value;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** `{ phone: true }` unless empty or a phone number of the contract's shape. */
export const phone: ValidatorFn = (control) => {
  const value = text(control);
  return value === null || PHONE_PATTERN.test(value) ? null : { phone: true };
};

/** `{ email: true }` unless empty or a simple e-mail address. */
export const email: ValidatorFn = (control) => {
  const value = text(control);
  return value === null || EMAIL_PATTERN.test(value) ? null : { email: true };
};

/** `{ postalCode: true }` unless empty or 5 digits. */
export const postalCode: ValidatorFn = (control) => {
  const value = text(control);
  return value === null || POSTAL_CODE_PATTERN.test(value) ? null : { postalCode: true };
};

/** `{ future: true }` for a date after today (empty or malformed dates are left to other validators). */
export function notFuture(today: () => string = todayIso): ValidatorFn {
  return (control) => {
    const value: unknown = control.value;
    return isIsoDate(value) && value > today() ? { future: true } : null;
  };
}

/** Group validator of the emergency contact: the three fields all filled, or all empty (= no emergency contact). */
export const emergencyComplete: ValidatorFn = (group: AbstractControl): ValidationErrors | null => {
  const filled = ['fullName', 'relationship', 'phone'].map((name) => {
    const control = group.get(name);
    return control ? text(control) !== null : false;
  });
  return filled.every(Boolean) || !filled.some(Boolean) ? null : { emergencyIncomplete: true };
};

// --- Payloads ------------------------------------------------------------------------------------------------------

export interface ContactFormValue {
  readonly mobilePhone: string;
  readonly otherPhone: string;
  readonly personalEmail: string;
  readonly addressLine: string;
  readonly commune: string;
  readonly wilayaCode: string;
  readonly postalCode: string;
}

/** Phones are sent as typed, with runs of spaces collapsed (the API normalises and stores them). */
function phoneOrNull(value: string): string | null {
  const trimmed = blankToNull(value);
  return trimmed === null ? null : trimmed.replace(/\s+/g, ' ');
}

export function contactBody(v: ContactFormValue): ContactInput {
  return {
    mobilePhone: phoneOrNull(v.mobilePhone),
    otherPhone: phoneOrNull(v.otherPhone),
    personalEmail: blankToNull(v.personalEmail),
    addressLine: blankToNull(v.addressLine),
    commune: blankToNull(v.commune),
    wilayaCode: blankToNull(v.wilayaCode),
    postalCode: blankToNull(v.postalCode),
  };
}

export interface EmergencyFormValue {
  readonly fullName: string;
  readonly relationship: Relationship | '';
  readonly phone: string;
}

/** All three empty → `null` (no emergency contact). */
export function emergencyBody(v: EmergencyFormValue): EmergencyInput | null {
  const fullName = blankToNull(v.fullName);
  const number = phoneOrNull(v.phone);
  if (fullName === null && number === null && v.relationship === '') return null;
  return { fullName: fullName ?? '', relationship: v.relationship as Relationship, phone: number ?? '' };
}

export interface ChildFormValue {
  readonly id: string;
  readonly firstName: string;
  readonly birthDate: string;
  readonly sex: ChildSex | '';
  readonly dependent: boolean;
}

export interface FamilyFormValue {
  readonly maritalStatus: MaritalStatus | '';
  readonly maritalStatusSince: string;
  readonly spouseEmployed: SpouseEmployed | '';
  readonly children: readonly ChildFormValue[];
}

export function familyBody(v: FamilyFormValue): FamilyInput {
  const children = v.children.map((c): ChildInput => {
    const child = { firstName: c.firstName.trim(), birthDate: c.birthDate, sex: c.sex === '' ? null : c.sex, dependent: c.dependent };
    return c.id ? { id: c.id, ...child } : child;
  });
  return {
    maritalStatus: v.maritalStatus === '' ? null : v.maritalStatus,
    maritalStatusSince: v.maritalStatus === '' ? null : v.maritalStatusSince || null,
    spouseEmployed: v.spouseEmployed === '' ? null : v.spouseEmployed,
    children,
  };
}

// --- Errors --------------------------------------------------------------------------------------------------------

/** 422 error codes of the API with a translated message (the server's English text otherwise). */
export const PERSONAL_CODE_KEYS: Readonly<Record<string, string>> = {
  phone: 'personal.form.errors.phone',
  invalid_phone: 'personal.form.errors.phone',
  email: 'personal.form.errors.email',
  invalid_email: 'personal.form.errors.email',
  postal_code: 'personal.form.errors.postalCode',
  future: 'personal.form.errors.future',
  future_date: 'personal.form.errors.future',
  too_many: 'personal.form.errors.tooManyChildren',
  too_big: 'personal.form.errors.tooManyChildren',
};

/** `PUT /employees/:id/{contact,emergency-contact,family}`. */
export const PERSONAL_SLUGS: SlugTable = {
  'employment-ended': { key: 'employees.problems.employmentEnded' },
  'forbidden-scope': { key: 'employees.problems.forbiddenWrite' },
  'forbidden-field': { key: 'employees.problems.forbiddenField' },
};
