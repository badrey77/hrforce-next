/** Shapes of docs/contracts/recruitment.md (Phases A and B). */
import type { EmployeeDetail, NamePair, UnitRef } from '../employees/employees.models';
import type { AppLanguage } from '../i18n/languages';
import type { Labels, WorkflowProgress, WorkflowTaskHistory } from '../leave/leave.models';
import type { SiteRef } from '../org/org.models';

export const OPENING_STATUSES = ['pending', 'open', 'filled', 'closed', 'rejected', 'cancelled'] as const;
export type OpeningStatus = (typeof OPENING_STATUSES)[number];
export const CONTRACT_TYPES = ['cdi', 'cdd', 'pre_emploi', 'apprentissage', 'stage'] as const;
export type ContractType = (typeof CONTRACT_TYPES)[number];
export const STAGES = ['received', 'shortlisted', 'interview', 'offer', 'hired', 'rejected', 'withdrawn'] as const;
export type Stage = (typeof STAGES)[number];
export const ACTIVE_STAGES = ['received', 'shortlisted', 'interview', 'offer'] as const;
export type ActiveStage = (typeof ACTIVE_STAGES)[number];
export const FINAL_STAGES: readonly Stage[] = ['hired', 'rejected', 'withdrawn'];
export const SOURCES = ['anem', 'spontaneous', 'referral', 'job_board', 'social', 'internal', 'other'] as const;
export type Source = (typeof SOURCES)[number];
export const FILE_KINDS = ['cv', 'cover_letter', 'diploma', 'id_document', 'other'] as const;
export type FileKind = (typeof FILE_KINDS)[number];
export const WORKFLOW_CODES = ['recruitment.manager_then_hr', 'recruitment.hr_only'] as const;
export type OpeningWorkflowCode = (typeof WORKFLOW_CODES)[number];

export const POSTS_MIN = 1;
export const POSTS_MAX = 99;
export const TITLE_MAX = 120;
export const JUSTIFICATION_MIN = 3;
export const JUSTIFICATION_MAX = 2000;
export const CLOSE_REASON_MIN = 3;
export const CLOSE_REASON_MAX = 500;
export const ANEM_MAX = 40;
export const NAME_MAX = 80;
export const BIRTH_PLACE_MAX = 120;
export const EMAIL_MAX = 254;
export const PHONE_MAX = 30;
export const COMMENT_MAX = 1000;
export const NOTE_MAX = 4000;
export const RETENTION_MIN = 1;
export const RETENTION_MAX = 60;
export const REASON_CODE_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;
export const IDLE_MONTHS = 6;
export const LABEL_MAX = 120;
export const LOCATION_MAX = 200;
export const DURATION_MIN = 15;
export const DURATION_MAX = 480;
export const DURATION_DEFAULT = 60;
export const INTERVIEWERS_MAX = 5;
export const CANCEL_REASON_MIN = 3;
export const CANCEL_REASON_MAX = 500;
export const EVALUATION_COMMENT_MAX = 4000;
export const OFFER_NOTE_MAX = 1000;
export const OPENING_CRITERIA_MAX = 8;
export const COPY_FILES_MAX = 5;
export const SCORES = [1, 2, 3, 4, 5] as const;
export const RECOMMENDATIONS = ['strong_yes', 'yes', 'no', 'strong_no'] as const;
export type Recommendation = (typeof RECOMMENDATIONS)[number];
export const INTERVIEW_MODES = ['on_site', 'video', 'phone'] as const;
export type InterviewMode = (typeof INTERVIEW_MODES)[number];

export function isActiveStage(stage: Stage): stage is ActiveStage {
  return (ACTIVE_STAGES as readonly string[]).includes(stage);
}

export interface UserRef {
  readonly id: string;
  readonly displayName: string;
}

export type StageCounts = Readonly<Record<Stage, number>> & { readonly total: number };

export type OpeningAction = 'update' | 'close' | 'reopen' | 'add_application' | 'set_criteria';

export interface CriterionRef {
  readonly id: string;
  readonly labels: Labels;
}

interface OpeningBase {
  readonly id: string;
  readonly reference: string;
  readonly title: string;
  readonly unit: UnitRef;
  readonly site: SiteRef | null;
  readonly siteInherited: boolean;
  readonly contractType: ContractType;
  readonly posts: number;
  readonly hiredCount: number;
  readonly justification: string;
  readonly targetDate: string;
  readonly anemReference: string | null;
  readonly status: OpeningStatus;
  readonly requestedAt: string;
  readonly requestedBy: UserRef | null;
  readonly openedAt: string | null;
  /** `reason` is null for a filled opening. */
  readonly closed: { readonly at: string; readonly by: UserRef | null; readonly reason: string | null } | null;
  readonly workflow: WorkflowProgress | null;
  readonly rejectionComment: string | null;
  /** The criteria interviewers score on this opening, in order (empty while the request is pending). */
  readonly criteria: readonly CriterionRef[];
}

export interface OpeningView extends OpeningBase {
  readonly counts: StageCounts;
  readonly _actions: readonly OpeningAction[];
}

export interface OpeningDetailView extends OpeningView {
  readonly history: readonly WorkflowTaskHistory[];
}

export type MyOpeningRole = 'requester' | 'head';

export interface MyOpeningView extends OpeningBase {
  readonly roles: readonly MyOpeningRole[];
  /** Null without the head role. */
  readonly counts: StageCounts | null;
  readonly _actions: readonly 'cancel'[];
}

export interface HeadApplicationView {
  readonly id: string;
  readonly candidate: NamePair;
  readonly stage: Stage;
  readonly stageSince: string;
  /** Empty once the stage is final. */
  readonly files: readonly CandidateFileView[];
  readonly average: number | null;
  /** Non-cancelled interviews. */
  readonly interviews: number;
}

export interface MyOpeningDetailView extends MyOpeningView {
  readonly history: readonly WorkflowTaskHistory[];
  /** Null without the head role; purged applications are absent. */
  readonly applications: readonly HeadApplicationView[] | null;
}

export interface OpeningPage {
  readonly items: readonly OpeningView[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

export interface MyOpeningList {
  readonly items: readonly MyOpeningView[];
}

export interface SummaryView {
  readonly openings: Readonly<Record<OpeningStatus, number>>;
  readonly applications: Readonly<Record<ActiveStage, number>>;
  readonly interviewsNext7Days: number;
  readonly offersPending: number;
}

export interface MySummaryView {
  readonly canRequestOpening: boolean;
  readonly openings: number;
  readonly pendingOpenings: number;
  /** Interviews the caller can see as an interviewer, and those still waiting for their evaluation. */
  readonly interviews: number;
  readonly evaluationsTodo: number;
}

export interface NewOpening {
  readonly title: string;
  readonly orgUnitId: string;
  readonly siteId: string | null;
  readonly contractType: ContractType;
  readonly posts: number;
  readonly justification: string;
  readonly targetDate: string;
}

export interface OpeningPatch {
  readonly targetDate?: string;
  readonly siteId?: string | null;
  readonly anemReference?: string | null;
  readonly posts?: number;
}

export interface CandidateInput {
  readonly lastName: string;
  readonly firstName: string;
  readonly lastNameAr?: string | null;
  readonly firstNameAr?: string | null;
  readonly birthDate?: string | null;
  readonly birthPlace?: string | null;
  readonly sex?: 'M' | 'F' | null;
  readonly nationality?: string;
  readonly nin?: string | null;
  readonly email?: string | null;
  readonly phone?: string | null;
  readonly informedOn?: string | null;
}

export type CandidatePatch = Partial<CandidateInput> & { readonly allowDuplicate?: boolean };

export interface KnownPersonView {
  readonly personId: string;
  readonly person: NamePair;
  /** Stored on the candidate (confirmed by HR), as opposed to found by NIN. */
  readonly linked: boolean;
  readonly hasOpenEmployment: boolean;
  readonly latestEmployment: {
    readonly id: string;
    readonly matricule: string;
    readonly hireDate: string;
    readonly endDate: string | null;
    readonly unit: UnitRef;
  };
}

export interface OpeningRef {
  readonly id: string;
  readonly reference: string;
  readonly title: string;
  readonly unit: UnitRef;
  readonly status: OpeningStatus;
}

export type MatchReason = 'nin' | 'email' | 'phone' | 'name_birth';

export interface CandidateMatchView {
  readonly id: string;
  readonly person: NamePair;
  readonly birthDate: string | null;
  readonly matchedOn: readonly MatchReason[];
  readonly applications: readonly { readonly id: string; readonly opening: OpeningRef; readonly stage: Stage }[];
}

export interface MatchQuery {
  readonly nin?: string;
  readonly email?: string;
  readonly phone?: string;
  readonly lastName?: string;
  readonly firstName?: string;
  readonly birthDate?: string;
  readonly excludeCandidateId?: string;
}

export interface MatchResult {
  readonly candidates: readonly CandidateMatchView[];
  readonly person: KnownPersonView | null;
}

export interface CandidateFileView {
  readonly id: string;
  readonly kind: FileKind;
  readonly title: string;
  readonly originalFilename: string;
  readonly mime: string;
  readonly sizeBytes: number;
  readonly uploadedAt: string;
  readonly uploadedBy: UserRef | null;
  readonly _actions: readonly 'delete'[];
}

export type CandidateAction = 'update' | 'upload' | 'link_person' | 'erase';

export interface CandidateView {
  readonly id: string;
  readonly person: NamePair;
  readonly birthDate: string | null;
  readonly birthPlace: string | null;
  readonly sex: 'M' | 'F' | null;
  readonly nationality: string;
  readonly nin: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly informedOn: string | null;
  readonly createdAt: string;
  readonly createdBy: UserRef | null;
  readonly knownPerson: KnownPersonView | null;
  readonly files: readonly CandidateFileView[];
  readonly applications: readonly ApplicationSummary[];
  readonly _actions: readonly CandidateAction[];
}

export interface ReasonRef {
  readonly code: string;
  readonly labels: Labels;
}

export interface ApplicationSummary {
  readonly id: string;
  readonly opening: OpeningRef;
  readonly stage: Stage;
  readonly stageSince: string;
  readonly source: Source;
  readonly createdAt: string;
  readonly decidedAt: string | null;
  readonly rejectionReason: ReasonRef | null;
}

export interface ApplicationListItem extends ApplicationSummary {
  readonly candidate: NamePair & { readonly id: string };
  readonly hasCv: boolean;
}

export interface ApplicationPage {
  readonly items: readonly ApplicationListItem[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

export type AutoCause = 'opening_filled' | 'opening_closed' | 'hire_undone' | 'opening_reopened' | 'interview_scheduled';

export interface StageEntry {
  readonly id: string;
  readonly from: Stage | null;
  readonly to: Stage;
  readonly at: string;
  readonly by: UserRef | null;
  readonly rejectionReason: ReasonRef | null;
  readonly comment: string | null;
  readonly autoCause: AutoCause | null;
}

export interface NoteView {
  readonly id: string;
  readonly body: string;
  readonly createdAt: string;
  readonly createdBy: UserRef;
  readonly _actions: readonly 'delete'[];
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

export interface ApplicationDetailView extends ApplicationSummary {
  readonly candidate: CandidateView;
  readonly stages: readonly StageEntry[];
  readonly notes: readonly NoteView[];
  readonly salary?: { readonly expected: string | null; readonly proposed: string | null };
  readonly _redacted: readonly 'salary'[];
  readonly moveTargets: readonly Stage[];
  /** Soonest last. */
  readonly interviews: readonly InterviewView[];
  /** The latest offer, whatever its status. */
  readonly offer: OfferView | null;
  readonly average: number | null;
  /** The employment a hire created; null when the caller cannot read it. */
  readonly employment: { readonly id: string; readonly matricule: string } | null;
  readonly _actions: readonly ApplicationAction[];
}

export interface BoardCard {
  readonly id: string;
  readonly candidate: NamePair & { readonly id: string };
  readonly stage: Stage;
  readonly stageSince: string;
  readonly source: Source;
  readonly hasCv: boolean;
  readonly notes: number;
  readonly formerEmployee: boolean;
  readonly rejectionReason: ReasonRef | null;
  readonly moveTargets: readonly Stage[];
  readonly nextInterviewAt: string | null;
  readonly average: number | null;
  readonly pendingEvaluations: number;
  /** `move` / `reopen`, plus the Phase B actions the caller may take from the board. */
  readonly _actions: readonly ApplicationAction[];
}

export interface BoardColumn {
  readonly stage: Stage;
  readonly count: number;
  readonly cards: readonly BoardCard[];
}

export interface BoardView {
  readonly opening: OpeningView;
  readonly columns: readonly BoardColumn[];
  readonly purged: number;
}

export interface NewApplication {
  readonly candidateId?: string;
  readonly candidate?: CandidateInput;
  readonly allowDuplicate?: boolean;
  readonly source: Source;
  readonly expectedSalary?: string;
  readonly comment?: string;
}

export interface ApplicationPatch {
  readonly source?: Source;
  readonly expectedSalary?: string | null;
}

export interface MoveInput {
  readonly toStage: Stage;
  readonly expectedStage: Stage;
  readonly rejectionReasonId?: string;
  readonly comment?: string;
}

export interface PolicyView {
  readonly retentionMonths: number;
  readonly openingWorkflowCode: OpeningWorkflowCode;
  readonly company: { readonly nameFr: string; readonly nameAr: string | null };
}

export interface PolicyInput {
  readonly retentionMonths?: number;
  readonly openingWorkflowCode?: OpeningWorkflowCode;
}

export interface ReasonView {
  readonly id: string;
  readonly code: string;
  readonly labels: Labels;
  readonly active: boolean;
  readonly sortOrder: number;
  readonly isSystem: boolean;
  readonly autoOnly: boolean;
}

export interface ReasonList {
  readonly items: readonly ReasonView[];
}

export interface ReasonPatch {
  readonly labels?: Labels;
  readonly active?: boolean;
  readonly sortOrder?: number;
}

export type CandidateUploadEvent =
  | { readonly kind: 'progress'; readonly loaded: number; readonly total: number | null }
  | { readonly kind: 'done'; readonly file: CandidateFileView };

/** Task summary of a `recruitment_opening` (contract › Workflow, My tasks). */
export interface OpeningTaskSummary {
  readonly type: 'recruitment_opening';
  readonly id: string;
  readonly reference: string;
  readonly title: string;
  readonly unit: UnitRef;
  readonly site: SiteRef | null;
  readonly contractType: ContractType;
  readonly posts: number;
  readonly justification: string;
  readonly targetDate: string;
  readonly requestedBy: UserRef;
}

// --- Phase B: criteria, interviews, evaluations, comparison, offers, hire ----------------------------------------

export interface CriterionView {
  readonly id: string;
  readonly code: string;
  readonly labels: Labels;
  readonly active: boolean;
  readonly sortOrder: number;
  readonly isSystem: boolean;
}

export interface CriterionList {
  readonly items: readonly CriterionView[];
}

export interface CriterionPatch {
  readonly labels?: Labels;
  readonly active?: boolean;
  readonly sortOrder?: number;
}

export interface ScoreEntry {
  readonly criterionId: string;
  readonly score: number;
}

export interface EvaluationView {
  readonly interviewer: UserRef;
  readonly submittedAt: string | null;
  readonly scores: readonly ScoreEntry[];
  readonly overall: number | null;
  readonly recommendation: Recommendation | null;
  readonly comment: string | null;
}

export type InterviewState = 'upcoming' | 'awaiting_evaluations' | 'complete' | 'cancelled';

export interface InterviewView {
  readonly id: string;
  readonly applicationId: string;
  readonly label: string | null;
  readonly scheduledAt: string;
  /** Algiers local date and time, as entered. */
  readonly date: string;
  readonly time: string;
  readonly durationMinutes: number;
  readonly mode: InterviewMode;
  readonly location: string | null;
  readonly status: 'scheduled' | 'cancelled';
  readonly state: InterviewState;
  readonly cancelReason: string | null;
  readonly createdBy: UserRef | null;
  /** One per interviewer, submitted or not. */
  readonly evaluations: readonly EvaluationView[];
  readonly average: number | null;
  /**
   * True while the caller is an interviewer of this interview who has not submitted yet: the other evaluations then
   * come without scores, recommendation and comment, and `average` is null.
   */
  readonly evaluationsHidden: boolean;
  readonly _actions: readonly ('update' | 'cancel')[];
}

export interface InterviewInput {
  readonly date: string;
  readonly time: string;
  readonly durationMinutes: number;
  readonly mode: InterviewMode;
  readonly location: string | null;
  readonly label: string | null;
  readonly interviewerIds: readonly string[];
}

/** `GET /recruitment/interviewers?q=`: an active user of the company. */
export interface InterviewerOption {
  readonly id: string;
  readonly displayName: string;
  readonly employee: { readonly matricule: string; readonly unit: UnitRef } | null;
}

export interface MyInterviewView {
  readonly id: string;
  readonly label: string | null;
  readonly scheduledAt: string;
  readonly date: string;
  readonly time: string;
  readonly durationMinutes: number;
  readonly mode: InterviewMode;
  readonly location: string | null;
  readonly opening: { readonly id: string; readonly reference: string; readonly title: string; readonly unit: UnitRef };
  readonly applicationId: string;
  readonly candidate: NamePair;
  readonly files: readonly CandidateFileView[];
  readonly criteria: readonly CriterionRef[];
  readonly evaluation: Omit<EvaluationView, 'interviewer'>;
  readonly _actions: readonly 'evaluate'[];
}

export interface MyInterviewList {
  readonly items: readonly MyInterviewView[];
}

export const MY_INTERVIEW_FILTERS = ['todo', 'done'] as const;
export type MyInterviewFilter = (typeof MY_INTERVIEW_FILTERS)[number];

export interface EvaluationInput {
  readonly scores: readonly ScoreEntry[];
  readonly recommendation: Recommendation;
  readonly comment?: string;
}

export type OfferStatus = 'proposed' | 'accepted' | 'declined' | 'cancelled';

export interface OfferView {
  readonly id: string;
  readonly jobTitle: string;
  readonly unit: UnitRef;
  readonly site: SiteRef | null;
  readonly contractType: ContractType;
  readonly startDate: string;
  readonly note: string | null;
  readonly status: OfferStatus;
  readonly decidedAt: string | null;
  readonly createdAt: string;
  readonly createdBy: UserRef | null;
}

export interface OfferInput {
  readonly jobTitle: string;
  readonly orgUnitId: string;
  readonly siteId: string | null;
  readonly contractType: ContractType;
  readonly startDate: string;
  readonly note: string | null;
  /** Only sent by a holder of `recruitment.salary.update`; null on an edit that removes it. */
  readonly proposedSalary?: string | null;
}

export interface ComparisonComment {
  readonly interviewer: UserRef;
  readonly interviewLabel: string | null;
  readonly recommendation: Recommendation;
  readonly comment: string | null;
}

export interface ComparisonRow {
  readonly applicationId: string;
  readonly candidate: NamePair & { readonly id: string };
  readonly stage: Stage;
  readonly interviews: number;
  readonly evaluations: { readonly submitted: number; readonly expected: number };
  readonly criteria: readonly { readonly criterionId: string; readonly average: number | null }[];
  readonly average: number | null;
  readonly recommendations: Readonly<Record<Recommendation, number>>;
  readonly comments: readonly ComparisonComment[];
  /** True while the caller still owes an evaluation of this application: averages null, counts 0, no comment. */
  readonly hidden: boolean;
}

export interface ComparisonView {
  readonly opening: OpeningRef;
  readonly criteria: readonly CriterionRef[];
  /** Best average first (null last), then name. */
  readonly rows: readonly ComparisonRow[];
}

export interface HirePrefillView {
  /** `personId` set = a rehire: the identity is shown read-only and only `personId` is sent. */
  readonly person: { readonly personId: string | null } & CandidateInput;
  readonly knownPerson: KnownPersonView | null;
  readonly orgUnitId: string;
  readonly siteId: string | null;
  readonly jobTitle: string;
  readonly hireDate: string;
  /** Only with `recruitment.salary.read` and `employee.salary.update` over the unit. */
  readonly salary?: { readonly baseSalary: string | null };
  readonly files: readonly CandidateFileView[];
  readonly defaultCopyFileIds: readonly string[];
  readonly opening: OpeningRef;
  /** The candidate page « back » and « cancel » lead to. */
  readonly candidateId: string;
  readonly expectedStage: 'offer';
}

/** `POST …/hire` → 201. */
export interface HireResult {
  readonly employee: EmployeeDetail;
  readonly application: ApplicationDetailView;
  readonly opening: OpeningView;
}

/** A unit the caller may request an opening for: one they head, or a sub-unit of it (`GET /me/recruitment/units`). */
export interface RequestableUnit {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly nameAr: string | null;
  /** The unit's effective site. */
  readonly site: SiteRef | null;
  /** Null for a top unit of the list. */
  readonly parentId: string | null;
  /** 0 for the units the caller heads, then one more per level below. */
  readonly depth: number;
}

export interface RequestableUnitList {
  readonly items: readonly RequestableUnit[];
}

/** Comparison rows by overall average; applications without any score stay last in both directions. */
export function sortByAverage(rows: readonly ComparisonRow[], dir: SortDir): ComparisonRow[] {
  return rows
    .map((row, index) => ({ row, index }))
    .toSorted((a, b) => {
      const x = a.row.average;
      const y = b.row.average;
      if (x === y) return a.index - b.index;
      if (x === null) return 1;
      if (y === null) return -1;
      return dir === 'desc' ? y - x : x - y;
    })
    .map(({ row }) => row);
}

/** The scores of a form (criterion id → 1–5, or null while not chosen) as the API takes them; null while one is missing. */
export function completeScores(criteria: readonly CriterionRef[], values: Readonly<Record<string, number | null>>): ScoreEntry[] | null {
  const scores: ScoreEntry[] = [];
  for (const criterion of criteria) {
    const score = values[criterion.id];
    if (typeof score !== 'number' || !Number.isInteger(score) || score < 1 || score > 5) return null;
    scores.push({ criterionId: criterion.id, score });
  }
  return scores;
}

// --- List queries -----------------------------------------------------------------------------------------------

export type OpeningStatusFilter = OpeningStatus | 'active' | 'all';
export const OPENING_STATUS_FILTERS: readonly OpeningStatusFilter[] = ['active', ...OPENING_STATUSES, 'all'];
export const OPENING_SORTS = ['requestedAt', 'targetDate', 'title', 'unit'] as const;
export type OpeningSort = (typeof OPENING_SORTS)[number];
export type SortDir = 'asc' | 'desc';
export const PAGE_SIZES: readonly number[] = [10, 25, 50, 100];

export interface OpeningQuery {
  readonly status: OpeningStatusFilter;
  readonly unitId: string | null;
  readonly includeSubUnits: boolean;
  readonly contractType: ContractType | null;
  readonly q: string;
  readonly sort: OpeningSort;
  readonly dir: SortDir;
  readonly page: number;
  readonly pageSize: number;
}

export const DEFAULT_OPENING_QUERY: OpeningQuery = {
  status: 'active',
  unitId: null,
  includeSubUnits: true,
  contractType: null,
  q: '',
  sort: 'requestedAt',
  dir: 'desc',
  page: 1,
  pageSize: 25,
};

export function openingParams(query: OpeningQuery): Record<string, string> {
  const params: Record<string, string> = { status: query.status };
  if (query.unitId) {
    params['unitId'] = query.unitId;
    params['includeSubUnits'] = String(query.includeSubUnits);
  }
  if (query.contractType) params['contractType'] = query.contractType;
  const q = query.q.trim();
  if (q) params['q'] = q;
  params['sort'] = query.sort;
  params['dir'] = query.dir;
  params['page'] = String(query.page);
  params['pageSize'] = String(query.pageSize);
  return params;
}

export const APPLICATION_STATES = ['active', 'final', 'all'] as const;
export type ApplicationState = (typeof APPLICATION_STATES)[number];
export const CANDIDATE_SORTS = ['name', 'stageSince', 'createdAt'] as const;
export type CandidateSort = (typeof CANDIDATE_SORTS)[number];

export interface CandidateQuery {
  readonly q: string;
  readonly openingId: string | null;
  readonly stage: Stage | null;
  readonly state: ApplicationState;
  readonly idle: boolean;
  readonly unitId: string | null;
  readonly includeSubUnits: boolean;
  readonly sort: CandidateSort;
  readonly dir: SortDir;
  readonly page: number;
  readonly pageSize: number;
}

export const DEFAULT_CANDIDATE_QUERY: CandidateQuery = {
  q: '',
  openingId: null,
  stage: null,
  state: 'active',
  idle: false,
  unitId: null,
  includeSubUnits: true,
  sort: 'name',
  dir: 'asc',
  page: 1,
  pageSize: 25,
};

export function candidateParams(query: CandidateQuery, lang: AppLanguage | null = null): Record<string, string> {
  const params: Record<string, string> = { state: query.state };
  const q = query.q.trim();
  if (q) params['q'] = q;
  if (query.openingId) params['openingId'] = query.openingId;
  if (query.stage) params['stage'] = query.stage;
  if (query.idle) params['idleMonths'] = String(IDLE_MONTHS);
  if (query.unitId) {
    params['unitId'] = query.unitId;
    params['includeSubUnits'] = String(query.includeSubUnits);
  }
  params['sort'] = query.sort;
  params['dir'] = query.dir;
  if (lang === 'ar') params['lang'] = 'ar';
  params['page'] = String(query.page);
  params['pageSize'] = String(query.pageSize);
  return params;
}

// --- Small view helpers -----------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** Whole days spent in the current stage (« depuis 4 j »); never negative when clocks disagree. */
export function daysSince(iso: string, now: number = Date.now()): number {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? 0 : Math.max(0, Math.floor((now - at) / DAY_MS));
}

/** Candidates in an active stage of an opening (the list's « candidatures en cours »). */
export function activeCount(counts: StageCounts): number {
  return ACTIVE_STAGES.reduce((sum, stage) => sum + (counts[stage] ?? 0), 0);
}

/**
 * Applications a reopening brings back: those auto-closed with the opening. The board only shows the rejection
 * reason, and `opening_closed` is `auto_only`, so a rejected card carrying it was closed by the opening.
 */
export function restorableCount(board: BoardView): number {
  const rejected = board.columns.find((column) => column.stage === 'rejected');
  return rejected ? rejected.cards.filter((card) => card.rejectionReason?.code === 'opening_closed').length : 0;
}

/** What the match endpoint can search on; undefined when nothing usable was typed (the API would answer 422). */
export function matchQueryOf(input: {
  readonly nin: string;
  readonly email: string;
  readonly phone: string;
  readonly lastName: string;
  readonly firstName: string;
  readonly birthDate: string;
}): MatchQuery | undefined {
  const nin = input.nin.replace(/\s+/g, '');
  const email = input.email.trim();
  const phone = input.phone.trim();
  const lastName = input.lastName.trim();
  const firstName = input.firstName.trim();
  const query: { -readonly [K in keyof MatchQuery]: MatchQuery[K] } = {};
  if (/^\d{18}$/.test(nin)) query.nin = nin;
  if (email.includes('@')) query.email = email;
  if (phone.replace(/\D/g, '').length >= 6) query.phone = phone;
  const named = !!lastName && !!firstName;
  if (!query.nin && !query.email && !query.phone && !named) return undefined;
  if (named) {
    query.lastName = lastName;
    query.firstName = firstName;
    if (input.birthDate) query.birthDate = input.birthDate;
  }
  return query;
}
