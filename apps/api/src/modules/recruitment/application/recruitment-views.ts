/** Response shapes of docs/contracts/recruitment.md, Phases A and B (the API layer returns them as is). */
import type { EmployeeDetail, KnownPerson, NamePair, SiteRef, UnitRef } from '../../employment/index.js';
import type { TaskHistoryView, WorkflowProgressView } from '../../workflow/index.js';
import type {
  ActiveStage,
  AutoCause,
  ContractType,
  FileKind,
  InterviewMode,
  InterviewState,
  OfferStatus,
  OpeningStatus,
  OpeningWorkflowCode,
  Recommendation,
  Source,
  Stage,
} from '../domain/rules.js';

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

export type OpeningAction = 'update' | 'close' | 'reopen' | 'add_application' | 'set_criteria';

export interface CriterionRef {
  id: string;
  labels: Labels;
}

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
  /** the criteria interviewers score, in order ([] while pending) */
  criteria: CriterionRef[];
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
  /** null when nothing is submitted — or while the caller still owes an evaluation of this application */
  average: number | null;
  /** non-cancelled interviews */
  interviews: number;
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
  /** scheduled interviews of applications in progress, from now to now + 7 days */
  interviewsNext7Days: number;
  /** proposed offers of open openings */
  offersPending: number;
}

export interface MySummaryView {
  canRequestOpening: boolean;
  openings: number;
  pendingOpenings: number;
  /** interviews the caller sees as an interviewer */
  interviews: number;
  /** those they can evaluate now and have not */
  evaluationsTodo: number;
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
  autoCause: AutoCause | null;
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
  salary?: { expected: string | null; proposed: string | null };
  _redacted: 'salary'[];
  /** what POST …/move accepts now ([] when final or not manageable) */
  moveTargets: Stage[];
  /** soonest last */
  interviews: InterviewView[];
  /** the latest one, whatever its status */
  offer: OfferView | null;
  average: number | null;
  /** hired: the employment, when the caller can read it with employee.read */
  employment: { id: string; matricule: string } | null;
  _actions: ApplicationAction[];
}

export type ApplicationAction =
  | 'move'
  | 'reopen'
  | 'add_note'
  | 'update'
  | 'update_salary'
  | 'schedule_interview'
  | 'make_offer'
  | 'update_offer'
  | 'decline_offer'
  | 'cancel_offer'
  | 'hire'
  | 'undo_hire';

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
  nextInterviewAt: string | null;
  average: number | null;
  /** evaluations still expected of interviews already held */
  pendingEvaluations: number;
  _actions: ('move' | 'reopen' | 'schedule_interview' | 'make_offer' | 'hire')[];
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

// ── Phase B ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface CriterionView {
  id: string;
  code: string;
  labels: Labels;
  active: boolean;
  sortOrder: number;
  isSystem: boolean;
}

export interface ScoreEntry {
  criterionId: string;
  score: number;
}

export interface EvaluationView {
  interviewer: UserRef;
  submittedAt: string | null;
  scores: ScoreEntry[];
  overall: number | null;
  recommendation: Recommendation | null;
  comment: string | null;
}

export interface InterviewView {
  id: string;
  applicationId: string;
  label: string | null;
  scheduledAt: string;
  /** Algiers */
  date: string;
  time: string;
  durationMinutes: number;
  mode: InterviewMode;
  location: string | null;
  status: 'scheduled' | 'cancelled';
  state: InterviewState;
  cancelReason: string | null;
  createdBy: UserRef | null;
  /** one per interviewer, submitted or not */
  evaluations: EvaluationView[];
  average: number | null;
  /**
   * true while the caller is an interviewer of this interview who has not submitted: the other evaluations are then
   * listed without their scores, recommendation and comment, and `average` is null
   */
  evaluationsHidden: boolean;
  _actions: ('update' | 'cancel')[];
}

export interface InterviewerOption {
  id: string;
  displayName: string;
  employee: { matricule: string; unit: UnitRef } | null;
}

export interface MyInterviewView {
  id: string;
  label: string | null;
  scheduledAt: string;
  date: string;
  time: string;
  durationMinutes: number;
  mode: InterviewMode;
  location: string | null;
  opening: { id: string; reference: string; title: string; unit: UnitRef };
  applicationId: string;
  candidate: NamePair;
  /** `_actions` always [] */
  files: CandidateFileView[];
  criteria: CriterionRef[];
  evaluation: Omit<EvaluationView, 'interviewer'>;
  _actions: 'evaluate'[];
}

export interface OfferView {
  id: string;
  jobTitle: string;
  unit: UnitRef;
  site: SiteRef | null;
  contractType: ContractType;
  startDate: string;
  note: string | null;
  status: OfferStatus;
  decidedAt: string | null;
  createdAt: string;
  createdBy: UserRef | null;
}

export interface ComparisonRow {
  applicationId: string;
  candidate: NamePair & { id: string };
  stage: Stage;
  interviews: number;
  evaluations: { submitted: number; expected: number };
  criteria: { criterionId: string; average: number | null }[];
  average: number | null;
  recommendations: Record<Recommendation, number>;
  comments: { interviewer: UserRef; interviewLabel: string | null; recommendation: Recommendation; comment: string | null }[];
  /** true while the caller still owes an evaluation of this application: averages null, counts 0, no comment */
  hidden: boolean;
}

export interface ComparisonView {
  opening: OpeningRef;
  criteria: CriterionRef[];
  /** applications with at least one non-cancelled interview, best average first (null last), then name */
  rows: ComparisonRow[];
}

export interface HirePrefillView {
  /** the candidate page to go back to */
  candidateId: string;
  /** personId set = rehire: the identity is read-only, only `personId` is sent */
  person: {
    personId: string | null;
    lastName: string;
    firstName: string;
    lastNameAr: string | null;
    firstNameAr: string | null;
    birthDate: string | null;
    birthPlace: string | null;
    sex: 'M' | 'F' | null;
    nationality: string;
    nin: string | null;
    email: string | null;
    phone: string | null;
    informedOn: string | null;
  };
  knownPerson: KnownPersonView | null;
  /** from the proposed offer */
  orgUnitId: string;
  siteId: string | null;
  jobTitle: string;
  hireDate: string;
  /** only with recruitment.salary.read AND employee.salary.update over the offer's unit */
  salary?: { baseSalary: string | null };
  files: CandidateFileView[];
  /** the cv files */
  defaultCopyFileIds: string[];
  opening: OpeningRef;
  expectedStage: 'offer';
}

export interface HireResult {
  employee: EmployeeDetail;
  application: ApplicationDetailView;
  opening: OpeningView;
}

/** A unit the caller may request an opening for as a head: one they head, or a sub-unit of it. */
export interface RequestableUnit {
  id: string;
  code: string;
  kind: string;
  name: string;
  nameAr: string | null;
  /** the unit's effective site (its own, else the nearest ancestor's) */
  site: SiteRef | null;
  /** null for a top unit of the list (its parent is not in it) */
  parentId: string | null;
  /** 0 for the top units of the list */
  depth: number;
}
