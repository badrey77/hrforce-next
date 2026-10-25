/**
 * Personal details of a person (contact, emergency contact, family), shared by the employee detail and the profile
 * models without importing either (keeps core/employees and core/profile free of a cycle).
 */

export type Relationship = 'spouse' | 'parent' | 'child' | 'sibling' | 'other';
export const RELATIONSHIPS: readonly Relationship[] = ['spouse', 'parent', 'child', 'sibling', 'other'];

export type MaritalStatus = 'single' | 'married' | 'divorced' | 'widowed';
export const MARITAL_STATUSES: readonly MaritalStatus[] = ['single', 'married', 'divorced', 'widowed'];

export type SpouseEmployed = 'yes' | 'no' | 'unknown';
export const SPOUSE_EMPLOYED_VALUES: readonly SpouseEmployed[] = ['yes', 'no', 'unknown'];

export type ChildSex = 'M' | 'F';

export interface ContactView {
  readonly mobilePhone: string | null;
  readonly otherPhone: string | null;
  readonly personalEmail: string | null;
  readonly addressLine: string | null;
  readonly commune: string | null;
  /** `01`–`58`. */
  readonly wilayaCode: string | null;
  /** 5 digits. */
  readonly postalCode: string | null;
  readonly updatedAt: string | null;
}

export interface EmergencyContactView {
  readonly fullName: string;
  readonly relationship: Relationship;
  readonly phone: string;
}

export interface ChildView {
  readonly id: string;
  readonly firstName: string;
  readonly birthDate: string;
  readonly sex: ChildSex | null;
  readonly dependent: boolean;
}

export interface FamilyView {
  readonly maritalStatus: MaritalStatus | null;
  readonly maritalStatusSince: string | null;
  readonly spouseEmployed: SpouseEmployed | null;
  readonly children: readonly ChildView[];
}

export interface PersonalView {
  readonly contact: ContactView;
  readonly emergencyContact: EmergencyContactView | null;
  readonly family: FamilyView;
}

