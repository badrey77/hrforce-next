/**
 * Self-service profile changes (docs/contracts/profile-changes.md › Self-service requests) — pure rules: the sections,
 * their diffs (`changedFields`, « unchanged », « modifié depuis la demande »), the « files required » rule and the
 * masking of the RIB and the NIN. No Nest, no Kysely.
 */

export const PROFILE_SECTIONS = ['contact', 'emergency', 'family', 'bank', 'identity_note'] as const;
export type ProfileSection = (typeof PROFILE_SECTIONS)[number];

/** Sections whose mode the company chooses (profile_policy); bank and identity_note always need approval. */
export const CONFIGURABLE_SECTIONS = ['contact', 'emergency', 'family'] as const;
export type ConfigurableSection = (typeof CONFIGURABLE_SECTIONS)[number];
export type SectionMode = 'immediate' | 'approval';

export const REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'cancelled', 'applied'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const PROFILE_PERMISSIONS = {
  requestSelf: 'profile.request_self',
  configure: 'profile.configure',
  personalRead: 'employee.personal.read',
  personalUpdate: 'employee.personal.update',
  bankRead: 'employee.bank.read',
  bankUpdate: 'employee.bank.update',
  fileRead: 'employee_file.read',
} as const;

/** Workflow definitions (migration 0025): family / identity note → HR in scope; bank → central HR. */
export const PROFILE_WORKFLOWS = { hr: 'profile.hr', bank: 'profile.bank' } as const;

/** The employee-file category approved supporting documents are copied into (migration 0025). */
export const SUPPORTING_DOCUMENT_CATEGORY = 'supporting_document';

export const MAX_FILES_PER_REQUEST = 3;
export const COMMENT_MAX = 500;
export const IDENTITY_NOTE_MAX = 500;

// ── section values (the shapes of docs/contracts/profile-changes.md › Employment additions) ──────────────────────

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
  relationship: 'spouse' | 'parent' | 'child' | 'sibling' | 'other';
  phone: string;
}

export interface ChildValues {
  id?: string | undefined;
  firstName: string;
  birthDate: string;
  sex: 'M' | 'F' | null;
  dependent: boolean;
}

export interface FamilyValues {
  maritalStatus: 'single' | 'married' | 'divorced' | 'widowed' | null;
  maritalStatusSince: string | null;
  spouseEmployed: 'yes' | 'no' | 'unknown' | null;
  children: ChildValues[];
}

export interface BankValues {
  rib: string | null;
  bankName: string | null;
}

export interface IdentityNote {
  note: string;
}

/** The new values of a section, as stored in `profile_change_request.payload` (emergency: null = remove the person). */
export type SectionPayload =
  | { section: 'contact'; payload: ContactValues }
  | { section: 'emergency'; payload: EmergencyValues | null }
  | { section: 'family'; payload: FamilyValues }
  | { section: 'bank'; payload: BankValues }
  | { section: 'identity_note'; payload: IdentityNote };

const CONTACT_FIELDS = ['mobilePhone', 'otherPhone', 'personalEmail', 'addressLine', 'commune', 'wilayaCode', 'postalCode'] as const;
const EMERGENCY_FIELDS = ['fullName', 'relationship', 'phone'] as const;
const FAMILY_FIELDS = ['maritalStatus', 'maritalStatusSince', 'spouseEmployed'] as const;
const CHILD_FIELDS = ['firstName', 'birthDate', 'sex', 'dependent'] as const;

export function isProfileSection(value: unknown): value is ProfileSection {
  return typeof value === 'string' && (PROFILE_SECTIONS as readonly string[]).includes(value);
}

function obj(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function same(a: unknown, b: unknown): boolean {
  return (a ?? null) === (b ?? null);
}

/** The children of a family value, keyed and ordered for comparison (items without id keep their order, after). */
function childrenOf(value: unknown): ChildValues[] {
  const list = obj(value)['children'];
  return Array.isArray(list) ? (list as ChildValues[]) : [];
}

function childrenDiffer(before: unknown, after: unknown): boolean {
  const a = childrenOf(before);
  const b = childrenOf(after);
  if (a.length !== b.length) return true;
  const byId = new Map(a.filter((c) => c.id).map((c) => [c.id, c]));
  for (const child of b) {
    const old = child.id ? byId.get(child.id) : undefined;
    if (!old) return true; // a new child (or one whose id is not among the current ones)
    if (CHILD_FIELDS.some((f) => !same(old[f], child[f]))) return true;
  }
  return false;
}

/**
 * The names of the fields that differ between `before` and `after` (both section values, or null for an absent
 * emergency contact). Family: `maritalStatus`, `maritalStatusSince`, `spouseEmployed` and `children` (any child
 * added, removed or changed). Bank: `rib`, `bankName`. Identity note: `note` (always: nothing is compared).
 */
export function changedFields(section: ProfileSection, before: unknown, after: unknown): string[] {
  switch (section) {
    case 'contact':
      return CONTACT_FIELDS.filter((f) => !same(obj(before)[f], obj(after)[f]));
    case 'emergency': {
      if (before === null && after === null) return [];
      if (before === null || after === null) return [...EMERGENCY_FIELDS];
      return EMERGENCY_FIELDS.filter((f) => !same(obj(before)[f], obj(after)[f]));
    }
    case 'family': {
      const fields: string[] = FAMILY_FIELDS.filter((f) => !same(obj(before)[f], obj(after)[f]));
      if (childrenDiffer(before, after)) fields.push('children');
      return fields;
    }
    case 'bank':
      return (['rib', 'bankName'] as const).filter((f) => !same(obj(before)[f], obj(after)[f]));
    case 'identity_note':
      return ['note'];
  }
}

/**
 * The current values still equal the values the request was made against (`before`)? Used for « modifié depuis la
 * demande » (changedSince = !unchangedSince). Identity notes never change anything.
 */
export function sameSection(section: ProfileSection, a: unknown, b: unknown): boolean {
  if (section === 'identity_note') return true;
  return changedFields(section, a, b).length === 0;
}

/**
 * Proof needed for an approval request (contract › POST /me/profile/requests): family when the marital status (or its
 * date) or the children change; bank always; never for the other sections.
 */
export function filesRequired(section: ProfileSection, changed: readonly string[]): boolean {
  if (section === 'bank') return true;
  if (section === 'family') return changed.some((f) => f === 'maritalStatus' || f === 'maritalStatusSince' || f === 'children');
  return false;
}

/** Bank and identity note always go to approval; the others follow the company policy. */
export function modeOf(section: ProfileSection, modes: Readonly<Record<ConfigurableSection, SectionMode>>): SectionMode {
  if (section === 'bank' || section === 'identity_note') return 'approval';
  return modes[section];
}

/** The workflow definition code of an approval section. */
export function workflowOf(section: ProfileSection): string {
  return section === 'bank' ? PROFILE_WORKFLOWS.bank : PROFILE_WORKFLOWS.hr;
}

/** "•••• •••• 1234" (null stays null; fewer than 4 digits are all hidden). */
export function maskRib(rib: string | null | undefined): string | null {
  if (!rib) return null;
  const digits = rib.replace(/\s+/g, '');
  return digits.length > 4 ? `•••• •••• ${digits.slice(-4)}` : '••••';
}

/** "•••• 1234" for the NIN (last 4 digits). */
export function maskNin(nin: string | null | undefined): string | null {
  if (!nin) return null;
  const digits = nin.replace(/\s+/g, '');
  return digits.length > 4 ? `•••• ${digits.slice(-4)}` : '••••';
}

/** A bank section value with its RIB masked (anything else is returned as is). */
export function maskBankValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  const v = obj(value);
  return { ...v, rib: maskRib(typeof v['rib'] === 'string' ? v['rib'] : null) };
}

/**
 * The family payload to apply on approval: a child id the request referred to that no longer exists (HR removed that
 * child meanwhile) is applied as a new child — the request's values win, as the contract says.
 */
export function familyToApply(payload: FamilyValues, currentChildIds: ReadonlySet<string>): FamilyValues {
  return {
    ...payload,
    children: payload.children.map((c) => (c.id && !currentChildIds.has(c.id) ? { firstName: c.firstName, birthDate: c.birthDate, sex: c.sex, dependent: c.dependent } : c)),
  };
}

/** Section label for the employee-file title « <Section> — demande du <date> » (fr: the file title is French, as the category's). */
export const SECTION_TITLES: Record<ProfileSection, string> = {
  contact: 'Coordonnées',
  emergency: 'Personne à prévenir',
  family: 'Situation familiale',
  bank: 'Coordonnées bancaires',
  identity_note: 'Signalement d’erreur',
};

/** 2026-10-24 → 24/10/2026. */
export function frenchDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

export function fileTitle(section: ProfileSection, requestedOn: string): string {
  return `${SECTION_TITLES[section]} — demande du ${frenchDate(requestedOn)}`;
}

/** Files of rejected / cancelled requests are erased `retentionDays` after the decision; approved ones once copied. */
export function purgeDue(input: { status: RequestStatus; decidedAt: Date | null; copied: boolean; retentionDays: number; now: Date }): boolean {
  if (input.status === 'approved') return input.copied || (input.decidedAt !== null && input.decidedAt.getTime() + input.retentionDays * 86_400_000 <= input.now.getTime());
  if (input.status === 'rejected' || input.status === 'cancelled') {
    return input.decidedAt !== null && input.decidedAt.getTime() + input.retentionDays * 86_400_000 <= input.now.getTime();
  }
  return false;
}
