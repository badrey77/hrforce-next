import { Injectable, NotFoundException } from '@nestjs/common';
import { ScopeService } from '../../../platform/authz/scope-service.js';
import { ProblemException, ValidationProblemException } from '../../../platform/http/problem-details.js';
import { RECRUITMENT_PERMISSIONS as P, type OpeningWorkflowCode } from '../domain/rules.js';
import { InterviewsRepository, type CriterionRow } from '../infra/interviews.repository.js';
import { constraintOf, RecruitmentRepository, type ReasonRow } from '../infra/recruitment.repository.js';
import { caller } from './recruitment-access.js';
import type { CriterionView, Labels, PolicyView, ReasonView } from './recruitment-views.js';

const taken = () =>
  new ProblemException(409, 'recruitment-reason-code-taken', 'This code is already used.', [{ field: 'code', code: 'taken', message: 'This code is already used.' }]);

const criterionTaken = () =>
  new ProblemException(409, 'recruitment-criterion-code-taken', 'This code is already used.', [{ field: 'code', code: 'taken', message: 'This code is already used.' }]);

function criterionView(c: CriterionRow): CriterionView {
  return { id: c.id, code: c.code, labels: { fr: c.nameFr, ar: c.nameAr, en: c.nameEn }, active: c.active, sortOrder: c.sortOrder, isSystem: c.isSystem };
}

function reasonView(r: ReasonRow): ReasonView {
  return { id: r.id, code: r.code, labels: { fr: r.nameFr, ar: r.nameAr, en: r.nameEn }, active: r.active, sortOrder: r.sortOrder, isSystem: r.isSystem, autoOnly: r.autoOnly };
}

/**
 * Recruitment settings (docs/contracts/recruitment.md › Settings): the policy (retention of candidate data, the
 * approval chain of new opening requests) and the rejection reasons. Reads need recruitment.read anywhere (the route
 * guard); writes need recruitment.configure over the WHOLE company (else 403 forbidden-scope, as attendance.configure).
 * Every write is audited by the row triggers.
 */
@Injectable()
export class RecruitmentSettingsService {
  constructor(
    private readonly repo: RecruitmentRepository,
    private readonly interviews: InterviewsRepository,
    private readonly scopes: ScopeService,
  ) {}

  // ── evaluation criteria (Phase B): the company list an opening copies when it opens ─────────────────────────────

  /** GET /recruitment/criteria: inactive ones included; sortOrder, then code. */
  async criteria(): Promise<{ items: CriterionView[] }> {
    const { companyId } = caller();
    return { items: (await this.interviews.criteria(companyId)).map(criterionView) };
  }

  async createCriterion(input: { code: string; labels: Labels }): Promise<CriterionView> {
    const { companyId } = caller();
    await this.assertCompanyWide();
    if (await this.interviews.criterionByCode(companyId, input.code)) throw criterionTaken();
    let id: string;
    try {
      id = await this.interviews.insertCriterion(companyId, { code: input.code, nameFr: input.labels.fr, nameAr: input.labels.ar, nameEn: input.labels.en });
    } catch (error) {
      if (constraintOf(error) === 'recruitment_criterion_company_code_uk') throw criterionTaken();
      throw error;
    }
    const row = await this.interviews.criterion(companyId, id);
    if (!row) throw new NotFoundException('Criterion not found');
    return criterionView(row);
  }

  /** PUT /recruitment/criteria/:id: labels, order, active (a deactivated criterion stays on the openings that hold it). */
  async updateCriterion(id: string, input: { labels?: Labels | undefined; active?: boolean | undefined; sortOrder?: number | undefined }): Promise<CriterionView> {
    const { companyId } = caller();
    const row = await this.interviews.criterion(companyId, id);
    if (!row) throw new NotFoundException('Criterion not found');
    await this.assertCompanyWide();
    const patch: { nameFr?: string; nameAr?: string; nameEn?: string; active?: boolean; sortOrder?: number } = {};
    if (input.labels) Object.assign(patch, { nameFr: input.labels.fr, nameAr: input.labels.ar, nameEn: input.labels.en });
    if (input.active !== undefined) patch.active = input.active;
    if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;
    await this.interviews.updateCriterion(companyId, id, patch);
    const updated = await this.interviews.criterion(companyId, id);
    if (!updated) throw new NotFoundException('Criterion not found');
    return criterionView(updated);
  }

  private async assertCompanyWide(): Promise<void> {
    if (!(await this.scopes.coversCompany(P.configure))) {
      throw new ProblemException(403, 'forbidden-scope', 'Recruitment settings apply to the whole company: recruitment.configure over the root unit is needed.');
    }
  }

  async policy(): Promise<PolicyView> {
    const { companyId } = caller();
    const [policy, company] = await Promise.all([this.repo.policy(companyId), this.repo.companyNames(companyId)]);
    return { ...policy, company };
  }

  /** PUT /recruitment/policy: the workflow applies to new requests only. */
  async savePolicy(input: { retentionMonths?: number | undefined; openingWorkflowCode?: OpeningWorkflowCode | undefined }): Promise<PolicyView> {
    const { companyId } = caller();
    await this.assertCompanyWide();
    const current = await this.repo.policy(companyId);
    await this.repo.savePolicy(companyId, {
      retentionMonths: input.retentionMonths ?? current.retentionMonths,
      openingWorkflowCode: input.openingWorkflowCode ?? current.openingWorkflowCode,
    });
    return this.policy();
  }

  /** GET /recruitment/rejection-reasons: inactive and automatic ones included; sortOrder, then code. */
  async reasons(): Promise<{ items: ReasonView[] }> {
    const { companyId } = caller();
    return { items: (await this.repo.reasons(companyId)).map(reasonView) };
  }

  async createReason(input: { code: string; labels: Labels }): Promise<ReasonView> {
    const { companyId } = caller();
    await this.assertCompanyWide();
    if (await this.repo.reasonByCode(companyId, input.code)) throw taken();
    let id: string;
    try {
      id = await this.repo.insertReason(companyId, { code: input.code, nameFr: input.labels.fr, nameAr: input.labels.ar, nameEn: input.labels.en });
    } catch (error) {
      if (constraintOf(error) === 'recruitment_rejection_reason_company_code_uk') throw taken();
      throw error;
    }
    const row = await this.repo.reason(companyId, id);
    if (!row) throw new NotFoundException('Reason not found');
    return reasonView(row);
  }

  /** PUT /recruitment/rejection-reasons/:id: labels, order, active — an automatic reason is never deactivated. */
  async updateReason(id: string, input: { labels?: Labels | undefined; active?: boolean | undefined; sortOrder?: number | undefined }): Promise<ReasonView> {
    const { companyId } = caller();
    const row = await this.repo.reason(companyId, id);
    if (!row) throw new NotFoundException('Reason not found');
    await this.assertCompanyWide();
    if (row.autoOnly && input.active !== undefined) {
      throw new ValidationProblemException([{ field: 'active', code: 'auto_only', message: 'An automatic reason is always active.' }]);
    }
    const patch: { nameFr?: string; nameAr?: string; nameEn?: string; active?: boolean; sortOrder?: number } = {};
    if (input.labels) Object.assign(patch, { nameFr: input.labels.fr, nameAr: input.labels.ar, nameEn: input.labels.en });
    if (input.active !== undefined) patch.active = input.active;
    if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;
    await this.repo.updateReason(companyId, id, patch);
    const updated = await this.repo.reason(companyId, id);
    if (!updated) throw new NotFoundException('Reason not found');
    return reasonView(updated);
  }
}
