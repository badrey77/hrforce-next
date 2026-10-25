/**
 * Personal details and self-service profile changes — API types from the binding contract
 * `docs/contracts/profile-changes.md`, plus the small pure helpers both the employee side (« Mon profil ») and the HR
 * side (tab, task panel, list) share. Plain TypeScript, no Angular.
 */
import type { WorkflowProgress, WorkflowTaskHistory } from '../leave/leave.models';
import type { NamePair, UnitRef } from '../employees/employees.models';
import type { ChildView, ContactView, EmergencyContactView, FamilyView, PersonalView } from './personal.models';

// --- Personal details (Employment additions) -----------------------------------------------------------------------
export * from './personal.models';

export type ContactInput = Omit<ContactView, 'updatedAt'>;
export type EmergencyInput = EmergencyContactView;
export type ChildInput = { readonly id?: string } & Omit<ChildView, 'id'>;
export type FamilyInput = Omit<FamilyView, 'children'> & { readonly children: readonly ChildInput[] };
export interface BankInput {
  readonly rib: string;
  readonly bankName: string;
}
export interface IdentityNoteInput {
  readonly note: string;
}

/** Field limits of the contract (the API validates; the forms use them for `maxlength` and courtesy checks). */
export const PROFILE_LIMITS = {
  addressLine: 200,
  commune: 80,
  email: 254,
  fullName: 120,
  childFirstName: 80,
  children: 15,
  comment: 500,
  note: 500,
  bankName: 120,
  files: 3,
} as const;

/** `^\+?[0-9 ]{8,20}$` (contract). */
export const PHONE_PATTERN = /^\+?[0-9 ]{8,20}$/;
export const POSTAL_CODE_PATTERN = /^[0-9]{5}$/;
/** The Algerian RIB: 20 digits (spaces allowed while typing; stripped before sending). */
export const RIB_PATTERN = /^[0-9]{20}$/;

// --- Requests (module profile) ---------------------------------------------------------------------------------------

export type ProfileSection = 'contact' | 'emergency' | 'family' | 'bank' | 'identity_note';
export const PROFILE_SECTIONS: readonly ProfileSection[] = ['contact', 'emergency', 'family', 'bank', 'identity_note'];
/** Sections whose mode is set by the company (`profile_policy`); bank and identity note always need approval. */
export type ConfigurableSection = 'contact' | 'emergency' | 'family';
export type ProfileMode = 'immediate' | 'approval';

export type ProfileRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'applied';
export const PROFILE_REQUEST_STATUSES: readonly ProfileRequestStatus[] = ['pending', 'approved', 'rejected', 'cancelled', 'applied'];

/** The `payload` of a request, per section. */
export interface ProfilePayloads {
  readonly contact: ContactInput;
  readonly emergency: EmergencyInput | null;
  readonly family: FamilyInput;
  readonly bank: BankInput;
  readonly identity_note: IdentityNoteInput;
}

export interface ProfileEmployeeRef {
  readonly id: string;
  readonly matricule: string;
  readonly person: NamePair;
  readonly unit: UnitRef;
}

export interface MyProfileView {
  readonly employee: ProfileEmployeeRef & { readonly jobTitle: string; readonly hireDate: string };
  readonly identity: {
    readonly birthDate: string | null;
    readonly birthPlace: string | null;
    readonly nationality: string;
    /** Last 4 digits only. */
    readonly ninMasked: string | null;
  };
  readonly personal: PersonalView;
  /** `ribMasked` like `•••• •••• 1234`. */
  readonly bank: { readonly ribMasked: string | null; readonly bankName: string | null };
  readonly modes: Readonly<Record<ConfigurableSection, ProfileMode>>;
  readonly pending: readonly { readonly id: string; readonly section: ProfileSection; readonly requestedAt: string }[];
}

export interface ProfileRequestFile {
  readonly id: string;
  readonly filename: string;
  readonly mime: string;
  readonly sizeBytes: number;
  /** The bytes were erased (retention) or moved to the employee file. */
  readonly purged: boolean;
}

export type ProfileRequestAction = 'cancel';

export interface ProfileRequestView {
  readonly id: string;
  readonly section: ProfileSection;
  readonly status: ProfileRequestStatus;
  readonly employee: ProfileEmployeeRef;
  /** The section's new values (`ProfilePayloads[section]`); bank RIB masked except for `employee.bank.read` / the requester. */
  readonly payload: unknown;
  /** The section's values when the request was made. */
  readonly before: unknown;
  readonly changedFields: readonly string[];
  /** The section changed since the request was made (« modifié depuis la demande »). */
  readonly changedSince: boolean;
  readonly comment: string | null;
  readonly files: readonly ProfileRequestFile[];
  readonly requestedAt: string;
  readonly decidedAt: string | null;
  readonly workflow: WorkflowProgress | null;
  readonly rejectionComment: string | null;
  readonly _actions: readonly ProfileRequestAction[];
}

/** `GET /profile/requests/:id`. */
export interface ProfileRequestDetail extends ProfileRequestView {
  readonly history: readonly WorkflowTaskHistory[];
}

export interface ProfileRequestList {
  readonly items: readonly ProfileRequestView[];
}

/** `GET /profile/requests` (HR, paged). */
export interface ProfileRequestPage {
  readonly items: readonly ProfileRequestView[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

export interface ProfileRequestQuery {
  readonly status: ProfileRequestStatus | '';
  readonly section: ProfileSection | '';
  readonly unitId: string | null;
  readonly includeSubUnits: boolean;
  readonly q: string;
  /** One employment's requests (the employee page's « Demandes de modification »). */
  readonly employmentId?: string;
  readonly page: number;
  readonly pageSize: number;
}

export const DEFAULT_PROFILE_REQUEST_QUERY: ProfileRequestQuery = {
  status: 'pending',
  section: '',
  unitId: null,
  includeSubUnits: true,
  q: '',
  page: 1,
  pageSize: 50,
};

/** The `data` field of `POST /me/profile/requests`. */
export type NewProfileRequest = {
  [S in ProfileSection]: { readonly section: S; readonly payload: ProfilePayloads[S]; readonly comment?: string };
}[ProfileSection];

export interface ProfileSettings {
  readonly contactMode: ProfileMode;
  readonly emergencyMode: ProfileMode;
  readonly familyMode: ProfileMode;
  /** 7–365. */
  readonly fileRetentionDays: number;
}

export const FILE_RETENTION_MIN = 7;
export const FILE_RETENTION_MAX = 365;

/** Problem slugs of the slice (`type` ends with them). */
export const PROFILE_PROBLEMS = {
  notLinked: 'profile-not-linked',
  pending: 'profile-request-pending',
  notCancellable: 'profile-not-cancellable',
  employmentEnded: 'employment-ended',
  selfApproval: 'workflow-self-approval',
} as const;

/** What a request submit emits: progress while the body is sent, then the created request. */
export type ProfileUploadEvent =
  | { readonly kind: 'progress'; readonly loaded: number; readonly total: number | null }
  | { readonly kind: 'done'; readonly request: ProfileRequestView };

// --- Helpers ---------------------------------------------------------------------------------------------------------

export function requestActions(request: Pick<ProfileRequestView, '_actions'>): readonly ProfileRequestAction[] {
  // oxlint-disable-next-line no-underscore-dangle -- contract field name
  return request._actions ?? [];
}

/** The mode of a section: the company's for contact/emergency/family, always `approval` for bank and identity note. */
export function sectionMode(modes: MyProfileView['modes'], section: ProfileSection): ProfileMode {
  return section === 'bank' || section === 'identity_note' ? 'approval' : modes[section];
}

/** The pending request of a section, if any. */
export function pendingOf(profile: Pick<MyProfileView, 'pending'>, section: ProfileSection): MyProfileView['pending'][number] | null {
  return profile.pending.find((p) => p.section === section) ?? null;
}

/** Strips spaces from a RIB as typed. */
export function normaliseRib(value: string): string {
  return value.replace(/\s+/g, '');
}

/** Empty / whitespace-only text → `null`, else trimmed. */
export function blankToNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

function sameChildren(a: readonly ChildInput[], b: readonly ChildInput[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((child, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      (child.id ?? null) === (other.id ?? null) &&
      child.firstName === other.firstName &&
      child.birthDate === other.birthDate &&
      child.sex === other.sex &&
      child.dependent === other.dependent
    );
  });
}

/**
 * Whether a family change needs a supporting document (contract: when the marital status or the children change). The
 * API decides (422 `files` `required`); the form uses this to ask for files up front.
 */
export function familyNeedsProof(current: FamilyView, next: FamilyInput): boolean {
  return (
    current.maritalStatus !== next.maritalStatus ||
    current.maritalStatusSince !== next.maritalStatusSince ||
    !sameChildren(current.children, next.children)
  );
}

/** Field names of a flat section whose value differs (a courtesy check for « nothing changed »). */
export function changedKeys<T extends object>(before: T | null, after: T | null): string[] {
  if (before === null || after === null) return before === after ? [] : ['*'];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  return [...keys].filter((key) => key !== 'updatedAt' && key !== 'children' && (b[key] ?? null) !== (a[key] ?? null));
}

/** Whole years between a birth date and `today` (`YYYY-MM-DD`, calendar dates, no time zone). */
export function ageOn(birthDate: string, today: string): number {
  const [by, bm, bd] = birthDate.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = today.split('-').map(Number) as [number, number, number];
  let age = ty - by;
  if (tm < bm || (tm === bm && td < bd)) age -= 1;
  return Math.max(0, age);
}
