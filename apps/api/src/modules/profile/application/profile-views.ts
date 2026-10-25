import type { NamePair, PersonalView, UnitRef } from '../../employment/index.js';
import type { TaskHistoryView, WorkflowProgressView } from '../../workflow/index.js';
import type { ConfigurableSection, ProfileSection, RequestStatus, SectionMode } from '../domain/profile.js';

export interface ProfileEmployeeRef {
  id: string;
  matricule: string;
  person: NamePair;
  unit: UnitRef;
}

/** GET /me/profile (docs/contracts/profile-changes.md › MyProfileView). */
export interface MyProfileView {
  employee: ProfileEmployeeRef & { jobTitle: string; hireDate: string };
  identity: { birthDate: string | null; birthPlace: string | null; nationality: string; ninMasked: string | null };
  personal: PersonalView;
  bank: { ribMasked: string | null; bankName: string | null };
  modes: Record<ConfigurableSection, SectionMode>;
  pending: { id: string; section: ProfileSection; requestedAt: string }[];
}

export interface ProfileRequestFileView {
  id: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  /** the bytes are gone (purged by the worker); the metadata stays */
  purged: boolean;
}

export interface ProfileRequestView {
  id: string;
  section: ProfileSection;
  status: RequestStatus;
  employee: ProfileEmployeeRef;
  /** the section's new values (bank: RIB masked except for employee.bank.read holders and the requester) */
  payload: unknown;
  /** the section's values when the request was made */
  before: unknown;
  changedFields: string[];
  /** pending only: the section's current values differ from `before` (« modifié depuis la demande ») */
  changedSince: boolean;
  comment: string | null;
  files: ProfileRequestFileView[];
  requestedAt: string;
  decidedAt: string | null;
  workflow: WorkflowProgressView | null;
  rejectionComment: string | null;
  _actions: 'cancel'[];
}

export interface ProfileRequestDetail extends ProfileRequestView {
  history: TaskHistoryView[];
}

export interface ProfileRequestPage {
  items: ProfileRequestView[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ProfileSettings {
  contactMode: SectionMode;
  emergencyMode: SectionMode;
  familyMode: SectionMode;
  fileRetentionDays: number;
}

export interface FileDownload {
  bytes: Buffer;
  mime: string;
  disposition: string;
  sha256: string;
}
