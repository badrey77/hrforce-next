/**
 * Personal details (docs/contracts/profile-changes.md › Data) — pure rules: phone / e-mail / address formats, the
 * children list, masking. No Nest, no Kysely.
 */

export const RELATIONSHIPS = ['spouse', 'parent', 'child', 'sibling', 'other'] as const;
export type Relationship = (typeof RELATIONSHIPS)[number];
export const MARITAL_STATUSES = ['single', 'married', 'divorced', 'widowed'] as const;
export type MaritalStatus = (typeof MARITAL_STATUSES)[number];
export const SPOUSE_EMPLOYED = ['yes', 'no', 'unknown'] as const;
export type SpouseEmployed = (typeof SPOUSE_EMPLOYED)[number];

export const MAX_CHILDREN = 15;
export const ADDRESS_LINE_MAX = 200;
export const COMMUNE_MAX = 80;
export const EMAIL_MAX = 254;
export const CONTACT_NAME_MAX = 120;
export const CHILD_NAME_MAX = 80;

/** What a person may type: digits and spaces, an optional leading `+`, 8–20 characters. */
export const PHONE_INPUT_PATTERN = /^\+?[0-9 ]{8,20}$/;
/** What is stored (the database check): no spaces. */
export const PHONE_STORED_PATTERN = /^\+?[0-9]{8,20}$/;
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** The 58 wilayas, `01`–`58`. */
export const WILAYA_CODE_PATTERN = /^(0[1-9]|[1-4][0-9]|5[0-8])$/;
export const POSTAL_CODE_PATTERN = /^[0-9]{5}$/;

/**
 * A phone as stored: spaces removed; `00…` → `+…`; an Algerian national number (`0` + 9 digits) → `+213` + the 9
 * digits; anything else as typed (digits, with its `+`). Assumes {@link PHONE_INPUT_PATTERN} already matched.
 * The result can be shorter than 8 characters only if the input was (it never is after the pattern check).
 */
export function normalizePhone(input: string): string {
  const compact = input.replace(/ /g, '');
  if (compact.startsWith('00')) return `+${compact.slice(2)}`;
  if (/^0[0-9]{9}$/.test(compact)) return `+213${compact.slice(1)}`;
  return compact;
}

/** Valid as typed AND still 8–20 characters once normalised (`00` removed counts). */
export function isValidPhone(input: string): boolean {
  return PHONE_INPUT_PATTERN.test(input) && PHONE_STORED_PATTERN.test(normalizePhone(input));
}

/** A personal e-mail as stored: trimmed, lower case. */
export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}

export function isValidEmail(input: string): boolean {
  const value = normalizeEmail(input);
  return value.length <= EMAIL_MAX && EMAIL_PATTERN.test(value);
}

/** `1` → `01` (a one-digit wilaya number is accepted); anything else unchanged. */
export function normalizeWilaya(input: string): string {
  const value = input.trim();
  return /^[1-9]$/.test(value) ? `0${value}` : value;
}

// ── the section shapes (docs/contracts/profile-changes.md › PersonalView) ──────────────────────────────────────────

export interface ContactValues {
  mobilePhone: string | null;
  otherPhone: string | null;
  personalEmail: string | null;
  addressLine: string | null;
  commune: string | null;
  wilayaCode: string | null;
  postalCode: string | null;
}

export interface EmergencyValues {
  fullName: string;
  relationship: Relationship;
  phone: string;
}

export interface ChildValues {
  firstName: string;
  birthDate: string;
  sex: 'M' | 'F' | null;
  dependent: boolean;
}

export interface FamilyValues {
  maritalStatus: MaritalStatus | null;
  maritalStatusSince: string | null;
  spouseEmployed: SpouseEmployed | null;
}

export interface ChildInput extends ChildValues {
  /** an existing child of the person (updated); absent = a new child */
  id?: string | undefined;
}

export interface FamilyInput extends FamilyValues {
  /** the FULL list: existing ids are updated, items without id created, children missing from it deleted */
  children: ChildInput[];
}

export interface BankValues {
  rib: string;
  bankName: string;
}

export const CONTACT_FIELDS = ['mobilePhone', 'otherPhone', 'personalEmail', 'addressLine', 'commune', 'wilayaCode', 'postalCode'] as const;

/** An empty contact block (no row yet). */
export const EMPTY_CONTACT: ContactValues = {
  mobilePhone: null,
  otherPhone: null,
  personalEmail: null,
  addressLine: null,
  commune: null,
  wilayaCode: null,
  postalCode: null,
};

export function sameContact(a: ContactValues, b: ContactValues): boolean {
  return CONTACT_FIELDS.every((f) => a[f] === b[f]);
}

export function sameEmergency(a: EmergencyValues | null, b: EmergencyValues | null): boolean {
  if (a === null || b === null) return a === b;
  return a.fullName === b.fullName && a.relationship === b.relationship && a.phone === b.phone;
}

export function sameChild(a: ChildValues, b: ChildValues): boolean {
  return a.firstName === b.firstName && a.birthDate === b.birthDate && a.sex === b.sex && a.dependent === b.dependent;
}

/** A field error of a section input, its path relative to the section (`children.2.birthDate`). */
export interface PersonalFieldError {
  field: string;
  code: string;
  message: string;
}

/**
 * The rules zod cannot see (they need the person's current children or today's date):
 *  - at most {@link MAX_CHILDREN} children;
 *  - a child's birth date and the marital-status date are not after `today`;
 *  - `maritalStatusSince` needs a `maritalStatus`;
 *  - an `id` names one of the person's children (`existingIds`), once.
 */
export function familyErrors(input: FamilyInput, existingIds: ReadonlySet<string>, today: string): PersonalFieldError[] {
  const errors: PersonalFieldError[] = [];
  if (input.maritalStatusSince !== null && input.maritalStatus === null) {
    errors.push({ field: 'maritalStatusSince', code: 'status_required', message: 'A date needs a marital status.' });
  }
  if (input.maritalStatusSince !== null && input.maritalStatusSince > today) {
    errors.push({ field: 'maritalStatusSince', code: 'future_date', message: 'The date cannot be in the future.' });
  }
  if (input.children.length > MAX_CHILDREN) {
    errors.push({ field: 'children', code: 'too_many', message: `At most ${MAX_CHILDREN} children.` });
  }
  const seen = new Set<string>();
  input.children.forEach((child, index) => {
    if (child.birthDate > today) {
      errors.push({ field: `children.${index}.birthDate`, code: 'future_date', message: 'The birth date cannot be in the future.' });
    }
    if (child.id !== undefined) {
      if (!existingIds.has(child.id) || seen.has(child.id)) {
        errors.push({ field: `children.${index}.id`, code: 'not_found', message: 'This child is not recorded for this person.' });
      }
      seen.add(child.id);
    }
  });
  return errors;
}

/** What a family input does to the recorded children. */
export interface ChildrenPlan<T extends ChildValues & { id: string }> {
  insert: ChildValues[];
  update: (ChildValues & { id: string })[];
  remove: T[];
}

/** Diffs the full list against the recorded children (unchanged children are neither updated nor touched). */
export function planChildren<T extends ChildValues & { id: string }>(current: readonly T[], next: readonly ChildInput[]): ChildrenPlan<T> {
  const byId = new Map(current.map((c) => [c.id, c]));
  const kept = new Set<string>();
  const plan: ChildrenPlan<T> = { insert: [], update: [], remove: [] };
  for (const child of next) {
    const values: ChildValues = { firstName: child.firstName, birthDate: child.birthDate, sex: child.sex, dependent: child.dependent };
    const existing = child.id !== undefined ? byId.get(child.id) : undefined;
    if (existing) {
      kept.add(existing.id);
      if (!sameChild(existing, values)) plan.update.push({ id: existing.id, ...values });
    } else plan.insert.push(values);
  }
  plan.remove = current.filter((c) => !kept.has(c.id));
  return plan;
}

/** `•••• •••• 1234`: the last 4 digits of a RIB (or a NIN); null stays null. */
export function maskLast4(value: string | null): string | null {
  if (value === null) return null;
  return `•••• •••• ${value.slice(-4)}`;
}
