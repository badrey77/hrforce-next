import { Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { AuditEvents } from '../../../platform/audit/audit-events.js';
import { ScopeService } from '../../../platform/authz/scope-service.js';
import { requireContext } from '../../../platform/context/request-context.js';
import { ProblemException } from '../../../platform/http/problem-details.js';
import { StaffingClock, StaffingService } from '../../staffing/index.js';
import { WorkflowEngine, WorkflowSubjects, type HookContext } from '../../workflow/index.js';
import { CONTRACT_PERMISSIONS as P, ContractRuleViolation, isFixedTerm, latestOf, planProposal, type Proposal } from '../domain/contracts.js';
import { ContractsRepository, type DecisionRow } from '../infra/contracts.repository.js';
import { ContractHooks } from './contract-hooks.js';
import type { ContractDecisionView } from './contract-views.js';
import { contractProblems, ContractsService, toView } from './contracts.service.js';
import { DecisionOpener } from './decision-opener.js';

export interface ProposalBody {
  proposal: Proposal;
  proposedStartDate?: string | null | undefined;
  proposedEndDate?: string | null | undefined;
  comment?: string | null | undefined;
}

function tenant(): { companyId: string; userId: string } {
  const { companyId, userId } = requireContext();
  if (!companyId || !userId) throw notFound();
  return { companyId, userId };
}

function notFound(): NotFoundException {
  return new NotFoundException('Decision not found');
}

/**
 * End-of-contract decisions (docs/contracts/contracts-deadlines.md › Contract decisions): opened by HR or the daily
 * job, proposed by the step's assignee (unit head, then HR may change it), approved through the workflow engine; the
 * HR approval applies the proposal in the same transaction. Workflow subject type `contract_decision`.
 */
@Injectable()
export class DecisionsService implements OnModuleInit {
  readonly opener: DecisionOpener;

  constructor(
    private readonly repo: ContractsRepository,
    private readonly contracts: ContractsService,
    private readonly scopes: ScopeService,
    private readonly staffing: StaffingService,
    private readonly clock: StaffingClock,
    private readonly engine: WorkflowEngine,
    private readonly subjects: WorkflowSubjects,
    private readonly hooks: ContractHooks,
    private readonly audit: AuditEvents,
  ) {
    this.opener = new DecisionOpener(repo, staffing, clock, engine, audit);
  }

  onModuleInit(): void {
    this.subjects.register('contract_decision', {
      resolveManager: (id) => this.opener.resolveManager(tenant().companyId, id),
      beforeApprove: (c) => this.beforeApprove(c),
      onApproved: (c) => this.onApproved(c),
      onRejected: (c) => this.finish(c, 'rejected'),
      onCancelled: (c) => this.finish(c, 'cancelled'),
      summaries: (ids) => this.summaries(ids),
      notificationData: (id) => this.opener.notificationData(tenant().companyId, id),
    });
  }

  // ── use cases ─────────────────────────────────────────────────────────────────────────────────────────────────

  /** POST /employees/:id/contracts/:contractId/decision (HR). */
  async open(employmentId: string, contractId: string): Promise<ContractDecisionView> {
    const { userId } = tenant();
    const loaded = await this.contracts.load(employmentId, P.read);
    if (!(await this.contracts.canManageUnit(loaded.card.unit.id))) {
      throw new ProblemException(403, 'forbidden-scope', 'You cannot open a decision for this employee (outside your employee.contract.manage scope).');
    }
    const contract = loaded.contracts.find((c) => c.id === contractId);
    if (!contract) throw new NotFoundException('Contract not found');
    if (!isFixedTerm(contract.contractType)) throw new ProblemException(409, 'contract-not-fixed-term', 'Only a fixed-term contract has an end-of-contract decision.');
    if (latestOf(loaded.contracts)?.id !== contract.id) {
      throw new ProblemException(409, 'contract-not-latest', 'A later contract already follows this one.');
    }
    if (loaded.employment.endDate !== null && loaded.employment.endDate <= (contract.endDate ?? '')) {
      throw new ProblemException(409, 'employment-ended', 'The employment ends with (or before) this contract: there is nothing to decide.');
    }
    if ((await this.repo.activeDecisionsOf(loaded.companyId, [contract.id])).has(contract.id)) {
      throw new ProblemException(409, 'contract-decision-pending', 'A decision about this contract is already in progress or approved.');
    }
    const id = await contractProblems(() => this.opener.open(loaded.companyId, contract, loaded.employment, userId));
    return this.view(id);
  }

  /** PUT /contract-decisions/:id/proposal — by a candidate of the open step. */
  async propose(id: string, body: ProposalBody): Promise<ContractDecisionView> {
    const { companyId, userId } = tenant();
    const decision = await this.repo.decision(companyId, id, { lock: true });
    if (!decision) throw notFound();
    if (!decision.workflowInstanceId || !(await this.engine.isCandidate(decision.workflowInstanceId))) {
      if (await this.canRead(decision)) throw new ProblemException(403, 'contract-decision-not-assignee', 'Only the person handling the current step can change the proposal.');
      throw notFound();
    }
    if (decision.status !== 'pending') throw new ProblemException(409, 'contract-decision-closed', 'This decision is closed.');
    const contract = await this.repo.contract(companyId, decision.contractId);
    if (!contract) throw notFound();
    await contractProblems(async () => {
      const plan = planProposal(contract, body);
      const comment = body.comment?.trim() ? body.comment.trim() : null;
      await this.repo.setProposal(companyId, id, { ...plan, comment, by: userId });
    });
    return this.view(id);
  }

  /** GET /contract-decisions/:id — employee.read over the employee, or a candidate of its open step. */
  async get(id: string): Promise<ContractDecisionView> {
    const { companyId } = tenant();
    const decision = await this.repo.decision(companyId, id);
    if (!decision) throw notFound();
    const candidate = decision.workflowInstanceId !== null && (await this.engine.isCandidate(decision.workflowInstanceId));
    if (!candidate && !(await this.canRead(decision))) throw notFound();
    return this.view(id);
  }

  /** The decisions of an employment (newest first), for the Contracts tab. */
  async ofEmployment(employmentId: string): Promise<ContractDecisionView[]> {
    const loaded = await this.contracts.load(employmentId, P.read);
    const rows = await this.repo.decisionsOfEmployment(loaded.companyId, employmentId);
    return Promise.all(rows.map((r) => this.view(r.id)));
  }

  // ── workflow hooks (same transaction as the workflow change) ────────────────────────────────────────────────────

  private async beforeApprove(context: HookContext & { stepKey: string }): Promise<void> {
    const { companyId } = tenant();
    const decision = await this.repo.decision(companyId, context.subjectId);
    if (!decision) throw notFound();
    if (decision.proposal === null) {
      throw new ProblemException(409, 'contract-decision-no-proposal', 'Record a proposal (renew, convert to CDI or end) before approving.');
    }
  }

  /** The last (HR) step approved: apply the proposal — a renewal / conversion contract, or the end of employment. */
  private async onApproved(context: HookContext): Promise<void> {
    const { companyId } = tenant();
    const decision = await this.repo.decision(companyId, context.subjectId, { lock: true });
    if (!decision) throw notFound();
    const contract = await this.repo.contract(companyId, decision.contractId);
    if (!contract?.endDate || decision.proposal === null) {
      throw new ProblemException(409, 'contract-decision-no-proposal', 'Record a proposal (renew, convert to CDI or end) before approving.');
    }
    let resultContractId: string | null = null;
    try {
      if (decision.proposal === 'end') {
        await this.hooks.endEmployment(decision.employmentId, contract.endDate);
      } else {
        const plan = planProposal(contract, { proposal: decision.proposal, proposedStartDate: decision.proposedStartDate, proposedEndDate: decision.proposedEndDate });
        resultContractId = await this.contracts.applyDecisionContract(companyId, decision.employmentId, decision.id, decision.proposal === 'renew' ? 'renewal' : 'conversion', {
          contractType: decision.proposal === 'renew' ? contract.contractType : 'cdi',
          startDate: plan.startDate ?? contract.endDate,
          endDate: plan.endDate,
        });
      }
    } catch (error) {
      // the proposal no longer fits (e.g. a contract recorded meanwhile): the approval fails with the rule's slug
      if (error instanceof ContractRuleViolation) throw new ProblemException(409, error.slug, error.message);
      throw error;
    }
    await this.repo.finishDecision(companyId, decision.id, 'approved', resultContractId);
    await this.audit.record({
      type: 'contract.decision_applied',
      subject: { type: 'contract_decision', id: decision.id },
      data: { proposal: decision.proposal, resultContractId, employmentId: decision.employmentId },
    });
  }

  private async finish(context: HookContext, status: 'rejected' | 'cancelled'): Promise<void> {
    const { companyId } = tenant();
    await this.repo.finishDecision(companyId, context.subjectId, status);
  }

  private async summaries(ids: readonly string[]): Promise<Map<string, Record<string, unknown>>> {
    const { companyId } = tenant();
    const rows = await this.repo.decisions(companyId, ids);
    const cards = await this.staffing.cards(rows.map((r) => r.employmentId), this.clock.today());
    const out = new Map<string, Record<string, unknown>>();
    for (const r of rows) {
      const card = cards.get(r.employmentId);
      const contract = await this.repo.contract(companyId, r.contractId);
      out.set(r.id, {
        type: 'contract_decision',
        id: r.id,
        employee: card ? { id: card.id, matricule: card.matricule, person: personOf(card.person), unit: card.unit } : null,
        contract: contract ? { id: contract.id, contractType: contract.contractType, startDate: contract.startDate, endDate: contract.endDate } : null,
        proposal: r.proposal,
        proposedStartDate: r.proposedStartDate,
        proposedEndDate: r.proposedEndDate,
        comment: r.comment,
      });
    }
    return out;
  }

  // ── helpers ───────────────────────────────────────────────────────────────────────────────────────────────────

  private async canRead(decision: DecisionRow): Promise<boolean> {
    const card = (await this.staffing.cards([decision.employmentId], this.clock.today())).get(decision.employmentId);
    return card !== undefined && (await this.scopes.inScope(P.read, card.unit.id));
  }

  private async view(id: string): Promise<ContractDecisionView> {
    const { companyId } = tenant();
    const d = await this.repo.decision(companyId, id);
    if (!d) throw notFound();
    const [card, contract, names] = await Promise.all([
      this.staffing.cards([d.employmentId], this.clock.today()).then((m) => m.get(d.employmentId)),
      this.repo.contract(companyId, d.contractId),
      this.repo.names(companyId),
    ]);
    if (!card || !contract) throw notFound();
    const [workflow] = d.workflowInstanceId ? await this.engine.progress([d.workflowInstanceId]) : [];
    const candidate = d.status === 'pending' && d.workflowInstanceId !== null && (await this.engine.isCandidate(d.workflowInstanceId));
    return {
      id: d.id,
      status: d.status,
      employee: { id: card.id, matricule: card.matricule, person: personOf(card.person), unit: card.unit },
      contract: toView(contract, names, null, false),
      proposal: d.proposal,
      proposedStartDate: d.proposedStartDate,
      proposedEndDate: d.proposedEndDate,
      comment: d.comment,
      proposedBy: d.proposedBy ? { id: d.proposedBy, displayName: names.get(d.proposedBy) ?? '' } : null,
      proposedAt: d.proposedAt,
      workflow: workflow ?? null,
      resultContractId: d.resultContractId,
      openedBy: d.openedBy === 'system' ? 'system' : 'user',
      _actions: candidate ? ['propose'] : [],
    };
  }
}

function personOf(p: { lastName: string; firstName: string; lastNameAr: string | null; firstNameAr: string | null }) {
  return { lastName: p.lastName, firstName: p.firstName, lastNameAr: p.lastNameAr, firstNameAr: p.firstNameAr };
}
