import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditEvents } from '../../../platform/audit/audit-events.js';
import { ScopeService } from '../../../platform/authz/scope-service.js';
import { currentTx } from '../../../platform/context/request-context.js';
import { ProblemException, ValidationProblemException, type FieldError } from '../../../platform/http/problem-details.js';
import { EMPLOYEE_PERMISSIONS, EmployeesService } from '../../employment/index.js';
import {
  BOARD_MAX_APPLICATIONS,
  isActiveStage,
  isFinalStage,
  isPreOfferStage,
  moveTargets,
  phoneKey,
  RECRUITMENT_PERMISSIONS as P,
  restoredStage,
  STAGES,
  type Source,
  type Stage,
} from '../domain/rules.js';
import {
  CandidatesRepository,
  purgeApplications,
  type ApplicationRow,
  type ApplicationSort,
  type CandidateFields,
  type CandidateRow,
  type ListedApplicationRow,
  type MatchInput,
} from '../infra/candidates.repository.js';
import { InterviewsRepository, type OfferRow } from '../infra/interviews.repository.js';
import { constraintOf, emptyCounts, RecruitmentRepository } from '../infra/recruitment.repository.js';
import { InterviewNotices, InterviewReads } from './interview-support.js';
import { OpeningsService } from './openings.service.js';
import { caller, RecruitmentAccess, RecruitmentClock } from './recruitment-access.js';
import type {
  ApplicationDetailView,
  ApplicationListItem,
  ApplicationPage,
  ApplicationSummary,
  BoardCard,
  BoardView,
  CandidateMatchView,
  CandidateView,
  KnownPersonView,
  NoteView,
  OfferView,
  StageEntry,
} from './recruitment-views.js';
import { fileView, namePair, reasonRef } from './view-helpers.js';

export interface CandidateInput {
  lastName: string;
  firstName: string;
  lastNameAr?: string | null | undefined;
  firstNameAr?: string | null | undefined;
  birthDate?: string | null | undefined;
  birthPlace?: string | null | undefined;
  sex?: 'M' | 'F' | null | undefined;
  nationality?: string | undefined;
  nin?: string | null | undefined;
  email?: string | null | undefined;
  phone?: string | null | undefined;
  informedOn?: string | null | undefined;
}

export interface CreateApplicationInput {
  candidateId?: string | undefined;
  candidate?: CandidateInput | undefined;
  allowDuplicate?: boolean | undefined;
  source: Source;
  expectedSalary?: string | undefined;
  comment?: string | undefined;
}

export interface MatchRequest {
  nin?: string | undefined;
  email?: string | undefined;
  phone?: string | undefined;
  lastName?: string | undefined;
  firstName?: string | undefined;
  birthDate?: string | undefined;
  excludeCandidateId?: string | undefined;
}

export interface MoveInput {
  toStage: Stage;
  expectedStage: Stage;
  rejectionReasonId?: string | undefined;
  comment?: string | undefined;
}

export interface ApplicationListInput {
  q?: string | undefined;
  openingId?: string | undefined;
  stage?: Stage | undefined;
  state: 'active' | 'final' | 'all';
  idleMonths?: number | undefined;
  unitId?: string | undefined;
  includeSubUnits: boolean;
  sort: ApplicationSort;
  dir?: 'asc' | 'desc' | undefined;
  lang: 'fr' | 'ar' | 'en';
  page: number;
  pageSize: number;
}

const candidateNotFound = () => new NotFoundException('Candidate not found');
const applicationNotFound = () => new NotFoundException('Application not found');
const notOpen = () => new ProblemException(409, 'recruitment-opening-not-open', 'This opening is not open.');
const stageChanged = () => new ProblemException(409, 'recruitment-stage-changed', 'This application was changed in the meantime. Please refresh.');
const forbiddenScope = (permission: string) =>
  new ProblemException(403, 'forbidden-scope', `You cannot do this for this application (outside your ${permission} scope).`);
const forbiddenSalary = () =>
  new ProblemException(403, 'forbidden-field', 'Entering a salary needs recruitment.salary.update.', [
    { field: 'expectedSalary', code: 'forbidden', message: 'recruitment.salary.update is needed.' },
  ]);
const invalid = (field: string, code: string, message: string) => new ValidationProblemException([{ field, code, message }]);

/** A candidate with the applications the caller may see (recruitment.read over the opening's unit) and all of them. */
interface Loaded {
  candidate: CandidateRow;
  all: ApplicationRow[];
  visible: ApplicationRow[];
  /** recruitment.manage over the unit of at least one visible application's opening */
  manageable: boolean;
}

/**
 * Candidates and their applications (docs/contracts/recruitment.md › Candidates, duplicates, known persons; Stage
 * rules): creation with duplicate detection limited to what the caller can see, the pipeline board, moves with
 * `expectedStage` under a row lock, notes, the salary block behind its own permissions, the known-person link, the
 * erasure on request. Scope: an application follows its opening's unit; a candidate is visible when at least one of
 * its applications is, and its views list only the visible ones.
 */
@Injectable()
export class ApplicationsService {
  constructor(
    private readonly repo: CandidatesRepository,
    private readonly settings: RecruitmentRepository,
    private readonly interviews: InterviewsRepository,
    private readonly interviewReads: InterviewReads,
    private readonly notices: InterviewNotices,
    private readonly openings: OpeningsService,
    private readonly access: RecruitmentAccess,
    private readonly scopes: ScopeService,
    private readonly employees: EmployeesService,
    private readonly audit: AuditEvents,
    private readonly clock: RecruitmentClock,
  ) {}

  // ── access ──────────────────────────────────────────────────────────────────────────────────────────────────────

  private async visibleOf(rows: readonly ApplicationRow[]): Promise<ApplicationRow[]> {
    const out: ApplicationRow[] = [];
    for (const r of rows) if (await this.access.can(P.read, r.unitId)) out.push(r);
    return out;
  }

  /** The candidate when at least one of its applications is visible, else 404. */
  async candidate(companyId: string, id: string, options: { lock?: boolean } = {}): Promise<Loaded> {
    const candidate = await this.repo.candidate(companyId, id, options);
    if (!candidate) throw candidateNotFound();
    const all = await this.repo.applicationsOfCandidates(companyId, [id]);
    const visible = await this.visibleOf(all);
    if (visible.length === 0) throw candidateNotFound();
    let manageable = false;
    for (const a of visible) manageable ||= await this.access.can(P.manage, a.unitId);
    return { candidate, all, visible, manageable };
  }

  /** {@link candidate} + recruitment.manage over one of its visible applications' units (else 403 forbidden-scope). */
  async manageableCandidate(companyId: string, id: string, options: { lock?: boolean } = {}): Promise<Loaded> {
    const loaded = await this.candidate(companyId, id, options);
    if (!loaded.manageable) throw new ProblemException(403, 'forbidden-scope', 'You cannot change this candidate (outside your recruitment.manage scope).');
    return loaded;
  }

  /** An unpurged application the caller can read (else 404). */
  async readable(companyId: string, id: string, options: { lock?: boolean } = {}): Promise<ApplicationRow> {
    const row = await this.repo.application(companyId, id, options);
    if (!row || row.purgedAt !== null || row.candidateId === null || !(await this.access.can(P.read, row.unitId))) throw applicationNotFound();
    return row;
  }

  async manageable(companyId: string, id: string, options: { lock?: boolean } = {}): Promise<ApplicationRow> {
    return this.writable(companyId, id, P.manage, options);
  }

  /** {@link readable} + `permission` over the opening's unit (else 403 forbidden-scope). */
  async writable(companyId: string, id: string, permission: string, options: { lock?: boolean } = {}): Promise<ApplicationRow> {
    const row = await this.readable(companyId, id, options);
    if (!(await this.access.can(permission, row.unitId))) throw forbiddenScope(permission);
    return row;
  }

  // ── duplicates, known persons ───────────────────────────────────────────────────────────────────────────────────

  private fields(input: CandidateInput): CandidateFields {
    const phone = input.phone ?? null;
    return {
      lastName: input.lastName,
      firstName: input.firstName,
      lastNameAr: input.lastNameAr ?? null,
      firstNameAr: input.firstNameAr ?? null,
      birthDate: input.birthDate ?? null,
      birthPlace: input.birthPlace ?? null,
      sex: input.sex ?? null,
      nationality: input.nationality ?? 'DZ',
      nin: input.nin ?? null,
      email: input.email ? input.email.toLowerCase() : null,
      phone,
      phoneKey: phoneKey(phone),
      informedOn: input.informedOn ?? null,
    };
  }

  /**
   * 409 recruitment-candidate-duplicate when a candidate THE CALLER CAN SEE has the same NIN (never overridable: use
   * the existing candidate), or the same e-mail / phone unless `allowDuplicate` (relatives share a phone).
   */
  private async assertNoDuplicate(companyId: string, input: MatchInput, allowDuplicate: boolean): Promise<void> {
    const matches = await this.repo.match(companyId, await this.scopes.scopeOf(P.read), input, 10);
    const errors: FieldError[] = [];
    if (matches.some((m) => m.onNin)) errors.push({ field: 'nin', code: 'duplicate', message: 'A candidate with this NIN already exists: use the existing record.' });
    if (!allowDuplicate && matches.some((m) => m.onEmail)) errors.push({ field: 'email', code: 'duplicate', message: 'A candidate with this e-mail already exists.' });
    if (!allowDuplicate && matches.some((m) => m.onPhone)) errors.push({ field: 'phone', code: 'duplicate', message: 'A candidate with this phone number already exists.' });
    if (errors.length > 0) throw new ProblemException(409, 'recruitment-candidate-duplicate', 'A matching candidate already exists.', errors);
  }

  /** The former employee behind a candidate: the linked person, else a person with the candidate's NIN — when visible. */
  async knownPerson(candidate: Pick<CandidateRow, 'personId' | 'nin'>): Promise<KnownPersonView | null> {
    if (candidate.personId) {
      const known = await this.employees.knownPerson({ personId: candidate.personId });
      return known ? { ...known, linked: true } : null;
    }
    if (!candidate.nin) return null;
    const known = await this.employees.knownPerson({ nin: candidate.nin });
    return known ? { ...known, linked: false } : null;
  }

  /** POST /recruitment/candidates/match: the visible candidates that look like the input; writes nothing. */
  async match(input: MatchRequest): Promise<{ candidates: CandidateMatchView[]; person: KnownPersonView | null }> {
    const { companyId } = caller();
    const name = input.lastName && input.firstName && input.birthDate ? { lastName: input.lastName, firstName: input.firstName, birthDate: input.birthDate } : undefined;
    const rows = await this.repo.match(
      companyId,
      await this.scopes.scopeOf(P.read),
      { nin: input.nin, email: input.email?.toLowerCase(), phoneKey: phoneKey(input.phone), name, excludeCandidateId: input.excludeCandidateId },
      10,
    );
    const applications = await this.visibleOf(await this.repo.applicationsOfCandidates(companyId, rows.map((r) => r.id)));
    const candidates: CandidateMatchView[] = [];
    for (const r of rows) {
      const own = applications.filter((a) => a.candidateId === r.id);
      const matchedOn: CandidateMatchView['matchedOn'] = [];
      if (r.onNin) matchedOn.push('nin');
      if (r.onEmail) matchedOn.push('email');
      if (r.onPhone) matchedOn.push('phone');
      if (r.onName) matchedOn.push('name_birth');
      candidates.push({
        id: r.id,
        person: namePair(r),
        birthDate: r.birthDate,
        matchedOn,
        applications: await Promise.all(own.map(async (a) => ({ id: a.id, opening: await this.openingRef(a), stage: a.stage }))),
      });
    }
    const known = input.nin ? await this.employees.knownPerson({ nin: input.nin }) : null;
    return { candidates, person: known ? { ...known, linked: false } : null };
  }

  // ── candidates ──────────────────────────────────────────────────────────────────────────────────────────────────

  /** GET /recruitment/candidates/:id. */
  async candidateDetail(id: string): Promise<CandidateView> {
    const { companyId } = caller();
    return this.candidateView(companyId, await this.candidate(companyId, id));
  }

  /** PATCH /recruitment/candidates/:id: identity, contact details, the notice date. */
  async updateCandidate(id: string, patch: Partial<CandidateInput> & { allowDuplicate?: boolean | undefined }): Promise<CandidateView> {
    const { companyId } = caller();
    const { candidate } = await this.manageableCandidate(companyId, id, { lock: true });
    const current: CandidateInput = {
      lastName: candidate.lastName,
      firstName: candidate.firstName,
      lastNameAr: candidate.lastNameAr,
      firstNameAr: candidate.firstNameAr,
      birthDate: candidate.birthDate,
      birthPlace: candidate.birthPlace,
      sex: candidate.sex,
      nationality: candidate.nationality,
      nin: candidate.nin,
      email: candidate.email,
      phone: candidate.phone,
      informedOn: candidate.informedOn,
    };
    const { allowDuplicate, ...changes } = patch;
    const defined = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)) as Partial<CandidateInput>;
    const next = this.fields({ ...current, ...defined });
    // only what changes is checked: a record saved with `allowDuplicate` stays editable
    await this.assertNoDuplicate(
      companyId,
      {
        nin: next.nin !== candidate.nin ? next.nin : null,
        email: next.email !== candidate.email ? next.email : null,
        phoneKey: next.phoneKey !== candidate.phoneKey ? next.phoneKey : null,
        excludeCandidateId: id,
      },
      allowDuplicate === true,
    );
    await this.repo.updateCandidate(companyId, id, next);
    return this.candidateView(companyId, await this.candidate(companyId, id));
  }

  /** PUT /recruitment/candidates/:id/person: HR confirms (or removes) the link to a former employee. */
  async linkPerson(id: string, personId: string | null): Promise<CandidateView> {
    const { companyId } = caller();
    await this.manageableCandidate(companyId, id, { lock: true });
    if (personId !== null && !(await this.employees.knownPerson({ personId }))) throw invalid('personId', 'not_found', 'The person does not exist.');
    await this.repo.setPerson(companyId, id, personId);
    return this.candidateView(companyId, await this.candidate(companyId, id));
  }

  /**
   * POST /recruitment/candidates/:id/erase: the purge of every application of the candidate, at once, in the request
   * transaction — refused while one of them is in progress. Needs recruitment.erase over the units of ALL of them.
   */
  async erase(id: string): Promise<void> {
    const { companyId } = caller();
    const { all } = await this.candidate(companyId, id, { lock: true });
    for (const a of all) {
      if (!(await this.access.can(P.erase, a.unitId))) {
        throw new ProblemException(403, 'forbidden-scope', 'You cannot erase this candidate (an application is outside your recruitment.erase scope).');
      }
    }
    if (all.some((a) => isActiveStage(a.stage))) {
      throw new ProblemException(409, 'recruitment-application-active', 'An application is still in progress: reject or withdraw it first.');
    }
    const result = await purgeApplications(currentTx(), companyId, all.map((a) => a.id));
    await this.audit.record({
      type: 'recruitment.candidate_erased',
      subject: { type: 'recruitment_candidate', id },
      data: { applications: result.applications, files: result.files },
    });
  }

  // ── applications ────────────────────────────────────────────────────────────────────────────────────────────────

  /** POST /recruitment/openings/:id/applications → 201: a new candidate, or an existing one, on an open opening. */
  async create(openingId: string, input: CreateApplicationInput): Promise<ApplicationDetailView> {
    const { companyId, userId } = caller();
    const opening = await this.openings.writable(companyId, openingId, P.manage);
    if (input.expectedSalary !== undefined && !(await this.access.can(P.salaryUpdate, opening.orgUnitId))) throw forbiddenSalary();
    if (opening.status !== 'open') throw notOpen();
    let candidateId: string;
    if (input.candidateId !== undefined) {
      // an unknown candidate and one the caller cannot see answer alike
      const candidate = await this.repo.candidate(companyId, input.candidateId, { lock: true });
      const visible = candidate ? await this.visibleOf(await this.repo.applicationsOfCandidates(companyId, [candidate.id])) : [];
      if (!candidate || visible.length === 0) throw invalid('candidateId', 'not_found', 'The candidate does not exist.');
      if (await this.repo.alreadyApplied(companyId, openingId, candidate.id)) throw this.alreadyApplied();
      candidateId = candidate.id;
    } else if (input.candidate) {
      const fields = this.fields(input.candidate);
      // name + birth date matches are advisory only (POST …/match shows them)
      await this.assertNoDuplicate(companyId, { nin: fields.nin, email: fields.email, phoneKey: fields.phoneKey }, input.allowDuplicate === true);
      candidateId = await this.repo.insertCandidate(companyId, fields, userId);
    } else {
      throw invalid('candidate', 'required', 'Give either `candidateId` or `candidate`.');
    }
    let id: string;
    try {
      id = await this.repo.insertApplication(companyId, { openingId, candidateId, source: input.source, createdBy: userId });
    } catch (error) {
      if (constraintOf(error) === 'recruitment_application_once_uk') throw this.alreadyApplied();
      throw error;
    }
    await this.repo.insertStage(companyId, { applicationId: id, from: null, to: 'received', comment: input.comment ?? null, movedBy: userId });
    if (input.expectedSalary !== undefined) await this.repo.setExpectedSalary(companyId, id, input.expectedSalary);
    return this.detailOf(companyId, id);
  }

  private alreadyApplied(): ProblemException {
    return new ProblemException(409, 'recruitment-already-applied', 'This candidate already applied to this opening.', [
      { field: 'candidateId', code: 'already_applied', message: 'This candidate already applied to this opening.' },
    ]);
  }

  /** GET /recruitment/applications/:id (a purged application → 404). */
  async detail(id: string): Promise<ApplicationDetailView> {
    const { companyId } = caller();
    await this.readable(companyId, id);
    return this.detailOf(companyId, id);
  }

  /** PATCH /recruitment/applications/:id: the source, the expected salary (recruitment.salary.update). */
  async update(id: string, input: { source?: Source | undefined; expectedSalary?: string | null | undefined }): Promise<ApplicationDetailView> {
    const { companyId } = caller();
    const row = await this.manageable(companyId, id, { lock: true });
    if (input.expectedSalary !== undefined && !(await this.access.can(P.salaryUpdate, row.unitId))) throw forbiddenSalary();
    if (input.source !== undefined && input.source !== row.source) await this.repo.setSource(companyId, id, input.source);
    if (input.expectedSalary !== undefined) await this.repo.setExpectedSalary(companyId, id, input.expectedSalary);
    return this.detailOf(companyId, id);
  }

  /**
   * POST /recruitment/applications/:id/move. The row is locked; `expectedStage` is the stage the user was looking at:
   * the second of two users acting on one card always gets 409 recruitment-stage-changed.
   */
  async move(id: string, input: MoveInput): Promise<ApplicationDetailView> {
    const { companyId, userId } = caller();
    // what never depends on the stored row
    if (input.toStage === 'offer' || input.toStage === 'hired') throw invalid('toStage', 'not_allowed', 'Offers and hires have their own actions.');
    if (input.toStage === input.expectedStage) throw invalid('toStage', 'same', 'The application is already in this stage.');
    if (!moveTargets(input.expectedStage).includes(input.toStage)) throw invalid('toStage', 'not_allowed', 'This move is not possible from this stage.');
    if (input.toStage === 'rejected' && !input.rejectionReasonId) throw invalid('rejectionReasonId', 'required', 'A reason is required to reject.');
    if (input.toStage !== 'rejected' && input.rejectionReasonId) throw invalid('rejectionReasonId', 'not_allowed', 'A reason only goes with a rejection.');

    const row = await this.manageable(companyId, id, { lock: true });
    if (row.stage !== input.expectedStage) throw stageChanged();
    if (row.openingStatus !== 'open') throw notOpen();
    let reasonId: string | null = null;
    if (input.rejectionReasonId) {
      const reason = await this.settings.reason(companyId, input.rejectionReasonId);
      // an automatic reason is never chosen by a user: it answers like an unknown one
      if (!reason || reason.autoOnly) throw invalid('rejectionReasonId', 'not_found', 'No such rejection reason.');
      if (!reason.active) throw invalid('rejectionReasonId', 'inactive', 'This reason is no longer used.');
      reasonId = reason.id;
    }
    await this.repo.setStage(companyId, id, input.toStage, isFinalStage(input.toStage));
    await this.repo.insertStage(companyId, { applicationId: id, from: row.stage, to: input.toStage, reasonId, comment: input.comment ?? null, movedBy: userId });
    // an application that leaves the pipeline: its offer in progress and its interviews to come are cancelled
    if (isFinalStage(input.toStage)) await this.notices.applicationsClosed(companyId, [id], input.toStage === 'rejected' ? 'Candidature refusée' : 'Désistement');
    return this.detailOf(companyId, id);
  }

  /** POST /recruitment/applications/:id/reopen: rejected / withdrawn → the stage it had before. */
  async reopen(id: string, expectedStage: Stage): Promise<ApplicationDetailView> {
    const { companyId, userId } = caller();
    if (expectedStage !== 'rejected' && expectedStage !== 'withdrawn') {
      throw invalid('expectedStage', expectedStage === 'hired' ? 'not_allowed' : 'not_final', 'Only a rejected or withdrawn application can be reopened.');
    }
    const row = await this.manageable(companyId, id, { lock: true });
    if (row.stage !== expectedStage) throw stageChanged();
    if (row.openingStatus !== 'open') throw notOpen();
    const back = restoredStage(await this.repo.latestFrom(companyId, id));
    await this.repo.setStage(companyId, id, back, false);
    await this.repo.insertStage(companyId, { applicationId: id, from: row.stage, to: back, movedBy: userId });
    return this.detailOf(companyId, id);
  }

  // ── notes ───────────────────────────────────────────────────────────────────────────────────────────────────────

  /** POST /recruitment/applications/:id/notes → 201. */
  async addNote(id: string, body: string): Promise<NoteView> {
    const { companyId, userId } = caller();
    const row = await this.manageable(companyId, id);
    const note = await this.repo.insertNote(companyId, row.id, body, userId);
    const ref = await this.access.userRefs();
    return { id: note.id, body: note.body, createdAt: note.createdAt.toISOString(), createdBy: ref(note.createdBy) ?? { id: userId, displayName: userId }, _actions: ['delete'] };
  }

  /** DELETE /recruitment/applications/:id/notes/:noteId: the author, or a holder of recruitment.erase over the unit. */
  async deleteNote(id: string, noteId: string): Promise<void> {
    const { companyId, userId } = caller();
    const row = await this.manageable(companyId, id);
    const note = await this.repo.note(companyId, noteId);
    if (!note || note.applicationId !== row.id) throw new NotFoundException('Note not found');
    if (note.createdBy !== userId && !(await this.access.can(P.erase, row.unitId))) {
      throw new ProblemException(403, 'forbidden', 'Only the author of a note, or a holder of recruitment.erase, may delete it.');
    }
    await this.repo.deleteNote(companyId, noteId);
  }

  // ── lists ───────────────────────────────────────────────────────────────────────────────────────────────────────

  /** GET /recruitment/candidates: one item per visible application. */
  async list(input: ApplicationListInput): Promise<ApplicationPage> {
    const { companyId } = caller();
    let units: string[] | undefined;
    if (input.unitId) units = input.includeSubUnits ? [...(await this.access.org()).subtree([input.unitId])] : [input.unitId];
    let idleBefore: Date | undefined;
    if (input.idleMonths !== undefined) {
      idleBefore = new Date(this.clock.nowMs());
      idleBefore.setUTCMonth(idleBefore.getUTCMonth() - input.idleMonths);
    }
    const { rows, total } = await this.repo.list(companyId, {
      scope: await this.scopes.scopeOf(P.read),
      q: input.q,
      openingId: input.openingId,
      stage: input.stage,
      state: input.state,
      idleBefore,
      units,
      sort: input.sort,
      dir: input.dir ?? (input.sort === 'name' ? 'asc' : 'desc'),
      lang: input.lang,
      limit: input.pageSize,
      offset: (input.page - 1) * input.pageSize,
    });
    const items: ApplicationListItem[] = [];
    for (const r of rows) items.push({ ...(await this.summary(r)), candidate: { id: r.candidateId ?? '', ...namePair(r) }, hasCv: r.hasCv });
    return { items, total, page: input.page, pageSize: input.pageSize };
  }

  /** GET /recruitment/openings/:id/board. */
  async board(openingId: string, includeFinal: boolean): Promise<BoardView> {
    const { companyId } = caller();
    const opening = await this.openings.readable(companyId, openingId);
    if ((await this.repo.unpurgedCount(companyId, openingId)) > BOARD_MAX_APPLICATIONS) {
      throw invalid('id', 'too_many', `A board shows at most ${BOARD_MAX_APPLICATIONS} applications: use the candidates list.`);
    }
    const [rows, counts, purged, manage] = await Promise.all([
      this.repo.applicationsOfOpening(companyId, openingId, includeFinal ? {} : { stages: ['received', 'shortlisted', 'interview', 'offer'] }),
      this.settings.stageCounts(companyId, [openingId]),
      this.repo.purgedCount(companyId, openingId),
      this.access.can(P.manage, opening.orgUnitId),
    ]);
    const notes = await this.repo.noteCounts(companyId, rows.map((r) => r.id));
    const former = await this.formerEmployees(companyId, rows);
    const open = opening.status === 'open';
    const { userId } = caller();
    const interviews = await this.interviewReads.load(companyId, rows.map((r) => r.id));
    const offerable = open && (await this.access.can(P.hire, opening.orgUnitId)) && opening.hiredCount + (await this.interviews.proposedCount(companyId, openingId)) < opening.posts;
    // « Embaucher » on a card under offer: recruitment.hire here and employee.create somewhere (the unit is checked at submit)
    const hirable = open && (await this.access.can(P.hire, opening.orgUnitId)) && (await this.scopes.unitIds(EMPLOYEE_PERMISSIONS.create)).size > 0;
    const cards: BoardCard[] = rows.map((r) => {
      const targets = manage && open ? moveTargets(r.stage) : [];
      const actions: BoardCard['_actions'] = [];
      if (targets.length > 0) actions.push('move');
      if (manage && open && (r.stage === 'rejected' || r.stage === 'withdrawn')) actions.push('reopen');
      if (manage && open && isPreOfferStage(r.stage)) actions.push('schedule_interview');
      if (offerable && isPreOfferStage(r.stage)) actions.push('make_offer');
      if (hirable && r.stage === 'offer') actions.push('hire');
      const stats = this.interviewReads.stats(interviews.get(r.id) ?? [], userId);
      return {
        id: r.id,
        candidate: { id: r.candidateId ?? '', ...namePair(r) },
        stage: r.stage,
        stageSince: r.stageSince.toISOString(),
        source: r.source,
        hasCv: r.hasCv,
        notes: notes.get(r.id) ?? 0,
        formerEmployee: r.candidateId !== null && former.has(r.candidateId),
        rejectionReason: reasonRef(r),
        moveTargets: targets,
        nextInterviewAt: stats.nextInterviewAt ? stats.nextInterviewAt.toISOString() : null,
        average: stats.average,
        pendingEvaluations: stats.pendingEvaluations,
        _actions: actions,
      };
    });
    const stageCounts = counts.get(openingId) ?? emptyCounts();
    return {
      opening: await this.openings.openingView(companyId, opening),
      columns: STAGES.map((stage) => ({ stage, count: stageCounts[stage], cards: cards.filter((c) => c.stage === stage) })),
      purged,
    };
  }

  /** The candidates of the rows behind whom the caller would see a known person (one NIN lookup for the board). */
  private async formerEmployees(companyId: string, rows: readonly ListedApplicationRow[]): Promise<Set<string>> {
    const candidates = (await this.repo.candidates(companyId, [...new Set(rows.flatMap((r) => (r.candidateId ? [r.candidateId] : [])))])).filter((c) => c.personId || c.nin);
    const known = await this.employees.knownPersons(candidates.map((c) => (c.personId ? { personId: c.personId } : { nin: c.nin ?? '' })));
    return new Set(candidates.filter((_, i) => known[i] !== null && known[i] !== undefined).map((c) => c.id));
  }

  // ── views ───────────────────────────────────────────────────────────────────────────────────────────────────────

  private openingRef(a: ApplicationRow) {
    return this.openings.openingRef({ id: a.openingId, reference: a.reference, title: a.title, orgUnitId: a.unitId, status: a.openingStatus });
  }

  private async summary(a: ApplicationRow): Promise<ApplicationSummary> {
    return {
      id: a.id,
      opening: await this.openingRef(a),
      stage: a.stage,
      stageSince: a.stageSince.toISOString(),
      source: a.source,
      createdAt: a.createdAt.toISOString(),
      decidedAt: a.decidedAt ? a.decidedAt.toISOString() : null,
      rejectionReason: reasonRef(a),
    };
  }

  async candidateView(companyId: string, loaded: Loaded): Promise<CandidateView> {
    const { candidate, all, visible, manageable } = loaded;
    const [files, ref, knownPerson] = await Promise.all([this.repo.files(companyId, [candidate.id]), this.access.userRefs(), this.knownPerson(candidate)]);
    const actions: CandidateView['_actions'] = manageable ? ['update', 'upload', 'link_person'] : [];
    let erasable = true;
    for (const a of all) erasable &&= await this.access.can(P.erase, a.unitId);
    if (erasable) actions.push('erase');
    return {
      id: candidate.id,
      person: namePair(candidate),
      birthDate: candidate.birthDate,
      birthPlace: candidate.birthPlace,
      sex: candidate.sex,
      nationality: candidate.nationality,
      nin: candidate.nin,
      email: candidate.email,
      phone: candidate.phone,
      informedOn: candidate.informedOn,
      createdAt: candidate.createdAt.toISOString(),
      createdBy: ref(candidate.createdBy),
      knownPerson,
      files: files.map((f) => fileView(f, ref, manageable)),
      applications: await Promise.all(visible.map((a) => this.summary(a))),
      _actions: actions,
    };
  }

  async offerView(o: OfferRow): Promise<OfferView> {
    const [org, ref] = await Promise.all([this.access.org(), this.access.userRefs()]);
    return {
      id: o.id,
      jobTitle: o.jobTitle,
      unit: org.unitRef(o.orgUnitId),
      site: org.siteRef(o.siteId ?? org.effectiveSite(o.orgUnitId)),
      contractType: o.contractType,
      startDate: o.startDate,
      note: o.note,
      status: o.status,
      decidedAt: o.decidedAt ? o.decidedAt.toISOString() : null,
      createdAt: o.createdAt.toISOString(),
      createdBy: ref(o.createdBy),
    };
  }

  /** The ApplicationDetailView of an unpurged application (the caller's access was checked by the use case). */
  async detailOf(companyId: string, id: string): Promise<ApplicationDetailView> {
    const { userId } = caller();
    const row = await this.repo.application(companyId, id);
    if (!row || row.candidateId === null) throw applicationNotFound();
    const [loaded, stages, notes, ref, manage, erase, salaryRead, salaryUpdate, hire, opening, offers, interviews, criteria] = await Promise.all([
      this.candidate(companyId, row.candidateId),
      this.repo.stages(companyId, id),
      this.repo.notes(companyId, id),
      this.access.userRefs(),
      this.access.can(P.manage, row.unitId),
      this.access.can(P.erase, row.unitId),
      this.access.can(P.salaryRead, row.unitId),
      this.access.can(P.salaryUpdate, row.unitId),
      this.access.can(P.hire, row.unitId),
      this.settings.opening(companyId, row.openingId),
      this.interviews.latestOffers(companyId, [id]),
      this.interviewReads.load(companyId, [id]),
      this.interviews.openingCriteria(companyId, [row.openingId]),
    ]);
    const open = row.openingStatus === 'open';
    const targets = manage && open ? moveTargets(row.stage) : [];
    const offer = offers.get(id) ?? null;
    const proposed = offer?.status === 'proposed';
    const actions: ApplicationDetailView['_actions'] = [];
    if (targets.length > 0) actions.push('move');
    if (manage && open && (row.stage === 'rejected' || row.stage === 'withdrawn')) actions.push('reopen');
    if (manage) actions.push('add_note', 'update');
    if (manage && salaryUpdate) actions.push('update_salary');
    if (manage && open && isPreOfferStage(row.stage)) actions.push('schedule_interview');
    if (hire && open && isPreOfferStage(row.stage) && opening && opening.hiredCount + (await this.interviews.proposedCount(companyId, row.openingId)) < opening.posts) actions.push('make_offer');
    if (hire && row.stage === 'offer' && proposed) {
      actions.push('update_offer', 'decline_offer', 'cancel_offer');
      // the hire also needs employee.create over the unit the person is hired into (POST /employees' own rule)
      if (open && (await this.scopes.unitIds(EMPLOYEE_PERMISSIONS.create)).size > 0) actions.push('hire');
    }
    if (hire && row.stage === 'hired' && row.employmentId && row.openingStatus !== 'closed') actions.push('undo_hire');
    const mine = interviews.get(id) ?? [];
    const order = criteria.map((c) => c.id);
    const editable = manage && open && isActiveStage(row.stage);
    const view: ApplicationDetailView = {
      ...(await this.summary(row)),
      candidate: await this.candidateView(companyId, loaded),
      stages: stages.map(
        (s): StageEntry => ({
          id: s.id,
          from: s.fromStage,
          to: s.toStage,
          at: s.movedAt.toISOString(),
          by: ref(s.movedBy),
          rejectionReason: reasonRef(s),
          comment: s.comment,
          autoCause: s.autoCause,
        }),
      ),
      notes: notes.map((n) => ({
        id: n.id,
        body: n.body,
        createdAt: n.createdAt.toISOString(),
        createdBy: ref(n.createdBy) ?? { id: n.createdBy, displayName: n.createdBy },
        _actions: manage && (n.createdBy === userId || erase) ? (['delete'] as const).slice() : [],
      })),
      _redacted: salaryRead ? [] : ['salary'],
      moveTargets: targets,
      interviews: mine.map((i) => this.interviewReads.view(i, ref, userId, order, editable && i.row.status === 'scheduled' ? ['update', 'cancel'] : [])),
      offer: offer ? await this.offerView(offer) : null,
      average: this.interviewReads.stats(mine, userId).average,
      employment: row.employmentId ? await this.employees.visibleEmployment(row.employmentId) : null,
      _actions: actions,
    };
    if (salaryRead) view.salary = await this.interviews.salary(companyId, id);
    return view;
  }
}
