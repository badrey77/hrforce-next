import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditEvents } from '../../../platform/audit/audit-events.js';
import { ScopeService } from '../../../platform/authz/scope-service.js';
import { ProblemException, ValidationProblemException, type FieldError } from '../../../platform/http/problem-details.js';
import { EmployeeFileImporter, type ImportedFile } from '../../documents/index.js';
import { EMPLOYEE_PERMISSIONS, EmployeesService, type CreateEmployeeInput } from '../../employment/index.js';
import { isPreOfferStage, RECRUITMENT_PERMISSIONS as P, type ContractType, type Stage } from '../domain/rules.js';
import { CandidatesRepository, type ApplicationRow } from '../infra/candidates.repository.js';
import { InterviewsRepository, type OfferFields } from '../infra/interviews.repository.js';
import { RecruitmentRepository, type OpeningRow } from '../infra/recruitment.repository.js';
import { ApplicationsService } from './applications.service.js';
import { InterviewNotices } from './interview-support.js';
import { OpeningsService } from './openings.service.js';
import { caller, RecruitmentAccess } from './recruitment-access.js';
import type { ApplicationDetailView, HirePrefillView, HireResult } from './recruitment-views.js';
import { fileView } from './view-helpers.js';

export interface OfferInput {
  expectedStage: Stage;
  jobTitle: string;
  orgUnitId: string;
  siteId?: string | null | undefined;
  contractType: ContractType;
  startDate: string;
  note?: string | null | undefined;
  proposedSalary?: string | null | undefined;
}

export type UpdateOfferInput = Partial<Omit<OfferInput, 'expectedStage'>>;

export interface HireInput extends CreateEmployeeInput {
  expectedStage: Stage;
  copyFileIds: string[];
}

const applicationNotFound = () => new NotFoundException('Application not found');
const notOpen = () => new ProblemException(409, 'recruitment-opening-not-open', 'This opening is not open.');
const stageChanged = () => new ProblemException(409, 'recruitment-stage-changed', 'This application was changed in the meantime. Please refresh.');
const noOffer = () => new ProblemException(409, 'recruitment-no-offer', 'This application has no offer in progress.');
const noPostLeft = () => new ProblemException(409, 'recruitment-no-post-left', 'Every post of this opening is filled or under offer.');
const forbiddenSalary = () =>
  new ProblemException(403, 'forbidden-field', 'Entering a salary needs recruitment.salary.update.', [
    { field: 'proposedSalary', code: 'forbidden', message: 'recruitment.salary.update is needed.' },
  ]);
const invalid = (field: string, code: string, message: string) => new ValidationProblemException([{ field, code, message }]);

interface Locked {
  opening: OpeningRow;
  application: ApplicationRow;
}

/**
 * What the offer and the hire share: the application with `permission` over its opening's unit (404 / 403), then the
 * locks in the contract's order — the OPENING row first, then the application (hire, fill and close do the same, so
 * two users acting on the last post never deadlock and the second always sees what the first did).
 */
@Injectable()
export class RecruitmentLocks {
  constructor(
    private readonly applications: ApplicationsService,
    private readonly repo: RecruitmentRepository,
  ) {}

  async take(companyId: string, applicationId: string): Promise<Locked> {
    const pre = await this.applications.writable(companyId, applicationId, P.hire);
    const opening = await this.repo.opening(companyId, pre.openingId, { lock: true });
    if (!opening) throw applicationNotFound();
    const application = await this.applications.readable(companyId, applicationId, { lock: true });
    return { opening, application };
  }
}

/**
 * Offers (docs/contracts/recruitment.md › Offers): recorded in HRForce only — no letter is generated, nothing is sent.
 * One offer in progress per application; offers in progress + hires never exceed the opening's posts; the proposed
 * salary lives in the salary side table behind recruitment.salary.read / .update. Declining withdraws the application,
 * cancelling returns it to `interview`; acceptance is the hire.
 */
@Injectable()
export class OffersService {
  constructor(
    private readonly repo: InterviewsRepository,
    private readonly candidates: CandidatesRepository,
    private readonly settings: RecruitmentRepository,
    private readonly applications: ApplicationsService,
    private readonly locks: RecruitmentLocks,
    private readonly notices: InterviewNotices,
    private readonly access: RecruitmentAccess,
  ) {}

  /** The unit is the opening's or one of its sub-units; the site exists. */
  private async assertPlace(companyId: string, openingUnitId: string, orgUnitId: string, siteId: string | null): Promise<void> {
    if (!(await this.settings.unitExists(companyId, orgUnitId))) throw invalid('orgUnitId', 'not_found', 'The org unit does not exist.');
    if (!(await this.access.org()).subtree([openingUnitId]).has(orgUnitId)) {
      throw invalid('orgUnitId', 'outside_opening', 'The unit must be the opening’s unit or one of its sub-units.');
    }
    if (siteId !== null && !(await this.settings.siteExists(companyId, siteId))) throw invalid('siteId', 'not_found', 'The site does not exist.');
  }

  /** POST /recruitment/applications/:id/offer → 201: received / shortlisted / interview → `offer`. */
  async make(applicationId: string, input: OfferInput): Promise<ApplicationDetailView> {
    const { companyId, userId } = caller();
    if (!isPreOfferStage(input.expectedStage)) throw invalid('expectedStage', 'not_allowed', 'An offer is made to an application that is received, shortlisted or in interview.');
    const pre = await this.applications.writable(companyId, applicationId, P.hire);
    const salary = input.proposedSalary ?? null;
    if (salary !== null && !(await this.access.can(P.salaryUpdate, pre.unitId))) throw forbiddenSalary();
    const siteId = input.siteId ?? null;
    await this.assertPlace(companyId, pre.unitId, input.orgUnitId, siteId);
    const { opening, application } = await this.locks.take(companyId, applicationId);
    if (application.stage !== input.expectedStage) throw stageChanged();
    if (opening.status !== 'open') throw notOpen();
    if (opening.hiredCount + (await this.repo.proposedCount(companyId, opening.id)) >= opening.posts) throw noPostLeft();
    await this.repo.insertOffer(
      companyId,
      applicationId,
      { jobTitle: input.jobTitle, orgUnitId: input.orgUnitId, siteId, contractType: input.contractType, startDate: input.startDate, note: input.note ?? null },
      userId,
    );
    await this.candidates.setStage(companyId, applicationId, 'offer', false);
    await this.candidates.insertStage(companyId, { applicationId, from: application.stage, to: 'offer', movedBy: userId });
    if (salary !== null) await this.repo.setProposedSalary(companyId, applicationId, salary);
    return this.applications.detailOf(companyId, applicationId);
  }

  /** PUT /recruitment/applications/:id/offer: what is sent replaces the offer's value, while it is proposed. */
  async update(applicationId: string, input: UpdateOfferInput): Promise<ApplicationDetailView> {
    const { companyId } = caller();
    const pre = await this.applications.writable(companyId, applicationId, P.hire);
    if (input.proposedSalary !== undefined && !(await this.access.can(P.salaryUpdate, pre.unitId))) throw forbiddenSalary();
    const { application } = await this.locks.take(companyId, applicationId);
    const offer = await this.repo.proposedOffer(companyId, applicationId);
    if (application.stage !== 'offer' || !offer) throw noOffer();
    const next: OfferFields = {
      jobTitle: input.jobTitle ?? offer.jobTitle,
      orgUnitId: input.orgUnitId ?? offer.orgUnitId,
      siteId: input.siteId !== undefined ? input.siteId : offer.siteId,
      contractType: input.contractType ?? offer.contractType,
      startDate: input.startDate ?? offer.startDate,
      note: input.note !== undefined ? input.note : offer.note,
    };
    if (next.orgUnitId !== offer.orgUnitId || next.siteId !== offer.siteId) await this.assertPlace(companyId, application.unitId, next.orgUnitId, next.siteId);
    if ((Object.keys(next) as (keyof OfferFields)[]).some((k) => next[k] !== offer[k])) await this.repo.updateOffer(companyId, offer.id, next);
    if (input.proposedSalary !== undefined) await this.repo.setProposedSalary(companyId, applicationId, input.proposedSalary);
    return this.applications.detailOf(companyId, applicationId);
  }

  /**
   * POST …/offer/decline (the person turned it down: offer `declined`, application `withdrawn`) and …/offer/cancel
   * (HR takes it back: offer `cancelled`, application back in `interview`).
   */
  async end(applicationId: string, how: 'decline' | 'cancel', input: { expectedStage: Stage; comment?: string | undefined }): Promise<ApplicationDetailView> {
    const { companyId, userId } = caller();
    if (input.expectedStage !== 'offer') throw invalid('expectedStage', 'not_allowed', 'Only an application under offer has an offer to end.');
    const { application } = await this.locks.take(companyId, applicationId);
    if (application.stage !== 'offer') throw stageChanged();
    const offer = await this.repo.proposedOffer(companyId, applicationId);
    if (!offer) throw noOffer();
    const to: Stage = how === 'decline' ? 'withdrawn' : 'interview';
    await this.repo.setOfferStatus(companyId, offer.id, how === 'decline' ? 'declined' : 'cancelled');
    await this.candidates.setStage(companyId, applicationId, to, how === 'decline');
    await this.candidates.insertStage(companyId, { applicationId, from: 'offer', to, comment: input.comment ?? null, movedBy: userId });
    if (how === 'decline') await this.notices.applicationsClosed(companyId, [applicationId], 'Offre déclinée');
    return this.applications.detailOf(companyId, applicationId);
  }
}

/**
 * The hire and its undo (docs/contracts/recruitment.md › Hire). The hire is ONE request transaction: the opening and
 * the application are locked, `EmployeesService.create` — unchanged, so every rule, status, slug and field of
 * POST /employees applies — creates the employee (or rehires the linked person), the chosen candidate files are copied
 * into the employee file under the system category `recruitment`, the application becomes `hired`, the offer
 * `accepted`, the opening counts one more hire and is filled on its last post (the other applications in progress are
 * closed). Any failure rolls all of it back: nothing persists, the application is still under offer.
 */
@Injectable()
export class HireService {
  constructor(
    private readonly repo: InterviewsRepository,
    private readonly candidates: CandidatesRepository,
    private readonly settings: RecruitmentRepository,
    private readonly applications: ApplicationsService,
    private readonly openings: OpeningsService,
    private readonly locks: RecruitmentLocks,
    private readonly access: RecruitmentAccess,
    private readonly scopes: ScopeService,
    private readonly employees: EmployeesService,
    private readonly importer: EmployeeFileImporter,
    private readonly audit: AuditEvents,
  ) {}

  /** GET /recruitment/applications/:id/hire-prefill: what the create-employee form starts from. */
  async prefill(applicationId: string): Promise<HirePrefillView> {
    const { companyId } = caller();
    const application = await this.applications.writable(companyId, applicationId, P.hire);
    const offer = await this.repo.proposedOffer(companyId, applicationId);
    if (application.stage !== 'offer' || !offer || application.candidateId === null) throw stageChanged();
    const candidate = await this.candidates.candidate(companyId, application.candidateId);
    if (!candidate) throw applicationNotFound();
    const [files, ref, knownPerson, salaryRead, salaryUpdate, salary] = await Promise.all([
      this.candidates.files(companyId, [candidate.id]),
      this.access.userRefs(),
      this.applications.knownPerson(candidate),
      this.access.can(P.salaryRead, application.unitId),
      this.scopes.inScope(EMPLOYEE_PERMISSIONS.salaryUpdate, offer.orgUnitId),
      this.repo.salary(companyId, applicationId),
    ]);
    const view: HirePrefillView = {
      candidateId: candidate.id,
      person: {
        personId: candidate.personId,
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
      },
      knownPerson,
      orgUnitId: offer.orgUnitId,
      siteId: offer.siteId,
      jobTitle: offer.jobTitle,
      hireDate: offer.startDate,
      files: files.map((f) => fileView(f, ref, false)),
      defaultCopyFileIds: files.filter((f) => f.kind === 'cv').map((f) => f.id),
      opening: await this.openings.openingRef({ id: application.openingId, reference: application.reference, title: application.title, orgUnitId: application.unitId, status: application.openingStatus }),
      expectedStage: 'offer',
    };
    if (salaryRead && salaryUpdate) view.salary = { baseSalary: salary.proposed };
    return view;
  }

  /** POST /recruitment/applications/:id/hire → 201 {employee, application, opening}. */
  async hire(applicationId: string, input: HireInput): Promise<HireResult> {
    const { companyId, userId } = caller();
    if (input.expectedStage !== 'offer') throw invalid('expectedStage', 'not_allowed', 'Only an application under offer is hired.');
    // 1. the locks, the stage, the opening
    const { opening, application } = await this.locks.take(companyId, applicationId);
    const offer = await this.repo.proposedOffer(companyId, applicationId);
    if (application.stage !== 'offer' || !offer || application.candidateId === null) throw stageChanged();
    if (opening.status !== 'open') throw notOpen();
    if (opening.hiredCount >= opening.posts) throw noPostLeft();
    const candidate = await this.candidates.candidate(companyId, application.candidateId, { lock: true });
    if (!candidate) throw applicationNotFound();

    // 2. the person: a linked candidate is a rehire of that person, anyone else a new person
    if (candidate.personId) {
      if (input.personId === undefined) throw invalid('personId', 'required', 'This candidate is linked to a former employee: the hire is a rehire of that person.');
      if (input.personId !== candidate.personId) throw invalid('personId', 'mismatch', 'This is not the person the candidate is linked to.');
      const known = await this.employees.knownPerson({ personId: candidate.personId });
      if (known && known.latestEmployment.endDate === null) {
        throw new ProblemException(409, 'recruitment-person-employed', 'This person is currently employed: a move is a new assignment, done on the employee.', [
          { field: 'personId', code: 'employed', message: 'This person is currently employed.' },
        ]);
      }
    } else if (input.personId !== undefined) {
      throw invalid('personId', 'not_linked', 'The candidate is not linked to this person: link them on the candidate page first.');
    }
    const files = await this.candidates.files(companyId, [candidate.id]);
    const errors: FieldError[] = [];
    for (const [k, fileId] of input.copyFileIds.entries()) {
      if (input.copyFileIds.indexOf(fileId) !== k) errors.push({ field: `copyFileIds.${k}`, code: 'duplicate', message: 'This file is listed twice.' });
      else if (!files.some((f) => f.id === fileId)) errors.push({ field: `copyFileIds.${k}`, code: 'not_found', message: 'No such file of this candidate.' });
    }
    if (errors.length > 0) throw new ValidationProblemException(errors);

    // 3. the employee — POST /employees' own use case, unchanged
    const { expectedStage: _stage, copyFileIds, ...body } = input;
    const employee = await this.employees.create(body);

    // 4. the chosen candidate files, into the employee file
    const copies: ImportedFile[] = [];
    for (const fileId of copyFileIds) {
      const file = files.find((f) => f.id === fileId);
      const content = file ? await this.candidates.content(companyId, file.id) : undefined;
      if (!file || !content) throw new Error(`candidate file ${fileId} has no content`);
      copies.push({ title: file.title, originalFilename: file.originalFilename, mime: file.mime, content });
    }
    await this.importer.copy(employee.id, copies);

    // 5. the application, the offer, the candidate's link, the opening
    await this.repo.markHired(companyId, applicationId, employee.id);
    await this.candidates.insertStage(companyId, { applicationId, from: 'offer', to: 'hired', movedBy: userId });
    await this.repo.setOfferStatus(companyId, offer.id, 'accepted');
    if (candidate.personId !== employee.person.id) await this.candidates.setPerson(companyId, candidate.id, employee.person.id);
    if ((await this.repo.addHire(companyId, opening.id)) >= opening.posts) await this.openings.fill(companyId, opening.id, userId);

    // 6. on the employee's history: « Recruté(e) via <référence> »
    await this.audit.record({ type: 'recruitment.hired', subject: { type: 'employee', id: employee.id }, data: { openingId: opening.id, applicationId, reference: opening.reference } });

    const after = await this.settings.opening(companyId, opening.id);
    if (!after) throw applicationNotFound();
    return { employee, application: await this.applications.detailOf(companyId, applicationId), opening: await this.openings.openingView(companyId, after) };
  }

  /**
   * POST /recruitment/applications/:id/undo-hire: for an employment created by mistake or a person who never started.
   * Employments are never deleted: HR ends the employment first. Then the application returns under offer (its offer
   * proposed again), the opening loses the hire and — when that hire had filled it — reopens with the applications the
   * fill had closed. The files copied into the employee file stay there.
   */
  async undo(applicationId: string, reason: string): Promise<ApplicationDetailView> {
    const { companyId, userId } = caller();
    const { opening, application } = await this.locks.take(companyId, applicationId);
    if (application.stage !== 'hired' || !application.employmentId) throw stageChanged();
    if (opening.status === 'closed') throw notOpen();
    const employment = await this.repo.employment(companyId, application.employmentId);
    if (!employment || employment.endDate === null) {
      throw new ProblemException(409, 'recruitment-employment-open', 'End the employment on the employee page first: an employment is never deleted.');
    }
    const offer = (await this.repo.latestOffers(companyId, [applicationId])).get(applicationId);
    const restored = offer?.status === 'accepted';
    if (offer && restored) await this.repo.setOfferStatus(companyId, offer.id, 'proposed');
    // (a hire recorded without an offer — imported data — comes back as an interview: there is no offer to restore)
    const to: Stage = restored ? 'offer' : 'interview';
    await this.repo.markHireUndone(companyId, applicationId, to);
    await this.candidates.insertStage(companyId, { applicationId, from: 'hired', to, autoCause: 'hire_undone', comment: reason, movedBy: userId });
    await this.repo.removeHire(companyId, opening.id);
    if (opening.status === 'filled') await this.openings.restore(companyId, opening.id, 'opening_filled', 'hire_undone', userId);
    await this.audit.record({
      type: 'recruitment.hire_undone',
      subject: { type: 'employee', id: application.employmentId },
      data: { openingId: opening.id, applicationId, reference: opening.reference },
    });
    return this.applications.detailOf(companyId, applicationId);
  }
}
