/** Response shapes of docs/contracts/recruitment.md › Phase A (the API layer returns them as is). */
import type { KnownPerson, NamePair, SiteRef, UnitRef } from '../../employment/index.js';
import type { TaskHistoryView, WorkflowProgressView } from '../../workflow/index.js';
import type { ActiveStage, AutoCause, ContractType, FileKind, OpeningStatus, OpeningWorkflowCode, Source, Stage } from '../domain/rules.js';

export type { NamePair, SiteRef, UnitRef };

export interface Labels {
  fr: string;
  ar: string;
  en: string;
}

/** `displayName` = the id for a former member. */
export interface UserRef {
  id: string;
  displayName: string;
}

/** Every application of the opening, purged ones included. */
export type StageCounts = Record<Stage, number> & { total: number };

export type OpeningAction = 'update' | 'close' | 'reopen' | 'add_application';

export interface OpeningView {
  id: string;
  reference: string;
  title: string;
  unit: UnitRef;
  site: SiteRef | null;
  siteInherited: boolean;
  contractType: ContractType;
  posts: number;
  hiredCount: number;
  justification: string;
  targetDate: string;
  anemReference: string | null;
  status: OpeningStatus;
  requestedAt: string;
  requestedBy: UserRef | null;
  openedAt: string | null;
  /** filled: `reason` and `by` null */
  closed: { at: string; by: UserRef | null; reason: string | null } | null;
  workflow: WorkflowProgressView | null;
  rejectionComment: string | null;
  counts: StageCounts;
  _actions: OpeningAction[];
}

export interface OpeningDetailView extends OpeningView {
  history: TaskHistoryView[];
}

export interface MyOpeningView extends Omit<OpeningView, 'counts' | '_actions'> {
  roles: ('requester' | 'head')[];
  /** null without the head role */
  counts: StageCounts | null;
  _actions: 'cancel'[];
}

export interface HeadApplicationView {
  id: string;
  candidate: NamePair;
  stage: Stage;
  stageSince: string;
  /** [] once the stage is final */
  files: CandidateFileView[];
}

export interface MyOpeningDetailView extends MyOpeningView {
  history: TaskHistoryView[];
  /** null without the head role; purged ones absent */
  applications: HeadApplicationView[] | null;
}

export interface SummaryView {
  openings: Record<OpeningStatus, number>;
  /** of open openings */
  applications: Record<ActiveStage, number>;
}

export interface MySummaryView {
  canRequestOpening: boolean;
  openings: number;
  pendingOpenings: number;
}

export interface OpeningPage {
  items: OpeningView[];
  total: number;
  page: number;
  pageSize: number;
}

export interface KnownPersonView extends KnownPerson {
  /** stored on the candidate (HR confirmed the link) */
  linked: boolean;
}

export interface OpeningRef {
  id: string;
  reference: string;
  title: string;
  unit: UnitRef;
  status: OpeningStatus;
}

export interface CandidateMatchView {
  id: string;
  person: NamePair;
  birthDate: string | null;
  matchedOn: ('nin' | 'email' | 'phone' | 'name_birth')[];
  /** the visible ones */
  applications: { id: string; opening: OpeningRef; stage: Stage }[];
}

export interface CandidateFileView {
  id: string;
  kind: FileKind;
  title: string;
  originalFilename: string;
  mime: string;
  sizeBytes: number;
  uploadedAt: string;
  uploadedBy: UserRef | null;
  _actions: 'delete'[];
}

export interface ReasonRef {
  code: string;
  labels: Labels;
}

export interface ApplicationSummary {
  id: string;
  opening: OpeningRef;
  stage: Stage;
  stageSince: string;
  source: Source;
  createdAt: string;
  decidedAt: string | null;
  rejectionReason: ReasonRef | null;
}

export interface CandidateView {
  id: string;
  person: NamePair;
  birthDate: string | null;
  birthPlace: string | null;
  sex: 'M' | 'F' | null;
  nationality: string;
  nin: string | null;
  email: string | null;
  phone: string | null;
  informedOn: string | null;
  createdAt: string;
  createdBy: UserRef | null;
  knownPerson: KnownPersonView | null;
  /** newest first */
  files: CandidateFileView[];
  /** the visible ones, newest first */
  applications: ApplicationSummary[];
  _actions: ('update' | 'upload' | 'link_person' | 'erase')[];
}

export interface ApplicationListItem extends ApplicationSummary {
  candidate: NamePair & { id: string };
  hasCv: boolean;
}

export interface ApplicationPage {
  items: ApplicationListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface StageEntry {
  id: string;
  from: Stage | null;
  to: Stage;
  at: string;
  by: UserRef | null;
  rejectionReason: ReasonRef | null;
  comment: string | null;
  autoCause: AutoCause | 'interview_scheduled' | null;
}

export interface NoteView {
  id: string;
  body: string;
  createdAt: string;
  createdBy: UserRef;
  _actions: 'delete'[];
}

export interface ApplicationDetailView extends ApplicationSummary {
  candidate: CandidateView;
  /** oldest first */
  stages: StageEntry[];
  /** newest first */
  notes: NoteView[];
  /** only with recruitment.salary.read over the opening's unit */
  salary?: { expected: string | null };
  _redacted: 'salary'[];
  /** what POST …/move accepts now ([] when final or not manageable) */
  moveTargets: Stage[];
  _actions: ('move' | 'reopen' | 'add_note' | 'update' | 'update_salary')[];
}

export interface BoardCard {
  id: string;
  candidate: NamePair & { id: string };
  stage: Stage;
  stageSince: string;
  source: Source;
  hasCv: boolean;
  notes: number;
  /** knownPerson would be non-null */
  formerEmployee: boolean;
  rejectionReason: ReasonRef | null;
  moveTargets: Stage[];
  _actions: ('move' | 'reopen')[];
}

export interface BoardView {
  opening: OpeningView;
  /** the 7 stages in order; cards oldest stageSince first */
  columns: { stage: Stage; count: number; cards: BoardCard[] }[];
  /** applications already anonymised (in the counts) */
  purged: number;
}

export interface PolicyView {
  retentionMonths: number;
  openingWorkflowCode: OpeningWorkflowCode;
  /** for the information notice: the letterhead's legal names, else the company's name */
  company: { nameFr: string; nameAr: string | null };
}

export interface ReasonView {
  id: string;
  code: string;
  labels: Labels;
  active: boolean;
  sortOrder: number;
  isSystem: boolean;
  autoOnly: boolean;
}
