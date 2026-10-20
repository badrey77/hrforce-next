import { AuditEvents } from '../../../platform/audit/audit-events.js';
import type { NotificationData } from '../../../platform/notifications/notifier.js';
import { StaffingClock, StaffingService } from '../../staffing/index.js';
import { WorkflowEngine, type ManagerCandidate } from '../../workflow/index.js';
import { decisionDue, DECISION_WORKFLOW_CODE, isFixedTerm } from '../domain/contracts.js';
import { ContractsRepository, type ContractRow, type EmploymentRow } from '../infra/contracts.repository.js';

/**
 * Opening a contract decision and the read-only workflow hooks (manager, notification data) — shared by the API
 * (HR opens one) and the worker's daily job (no user, no Nest container: the job builds this class itself, see
 * {@link openDueContractDecisions}). Runs in the current transaction (request or `inCompany`).
 */
export class DecisionOpener {
  constructor(
    private readonly repo: ContractsRepository,
    private readonly staffing: StaffingService,
    private readonly clock: StaffingClock,
    private readonly engine: WorkflowEngine,
    private readonly audit: AuditEvents,
  ) {}

  /**
   * Opens the decision about `contract` (fixed term, of `employment`): its row, then the `contract.decision` workflow,
   * always started by the SYSTEM actor (so the HR user who opens it by hand can still approve the HR step). `openedBy`
   * = the user id, or 'system'. The pending-decision unique index refuses a second one (409 by the caller's mapping).
   */
  async open(companyId: string, contract: ContractRow, employment: EmploymentRow, openedBy: string): Promise<string> {
    if (!isFixedTerm(contract.contractType)) throw new Error('decision about a CDI');
    const definitionId = await this.repo.decisionDefinitionId(companyId, DECISION_WORKFLOW_CODE);
    if (!definitionId) throw new Error(`workflow definition ${DECISION_WORKFLOW_CODE} missing for company ${companyId}`);
    const card = (await this.staffing.cards([employment.id], this.clock.today())).get(employment.id);
    if (!card) throw new Error(`employment ${employment.id} has no card`);
    const decisionId = await this.repo.insertDecision(companyId, { employmentId: employment.id, contractId: contract.id, openedBy });
    const subjectUserId = (await this.staffing.linkedUsersOf([employment.id])).get(employment.id) ?? null;
    const instanceId = await this.engine.startAsSystem({
      definitionId,
      subjectType: 'contract_decision',
      subjectId: decisionId,
      scopeUnitId: card.unit.id,
      subjectUserId,
    });
    await this.repo.setDecisionInstance(companyId, decisionId, instanceId);
    await this.audit.record({
      type: 'contract.decision_opened',
      subject: { type: 'contract_decision', id: decisionId },
      data: { contractId: contract.id, employmentId: employment.id, by: openedBy === 'system' ? 'system' : 'user' },
    });
    return decisionId;
  }

  /** The daily job's part: every contract whose decision is due today (policy notice) gets one. Returns how many. */
  async openDue(companyId: string, today: string): Promise<number> {
    const notice = await this.repo.decisionNoticeDays(companyId);
    if (notice <= 0) return 0;
    let opened = 0;
    for (const { contract, employment } of await this.repo.decisionCandidates(companyId, today, notice)) {
      if (!decisionDue(contract, true, employment, today, notice, false)) continue;
      await this.open(companyId, contract, employment, 'system');
      opened += 1;
    }
    return opened;
  }

  /** The manager of the decision's employee today (as for leave): escalated to HR when there is none. */
  async resolveManager(companyId: string, decisionId: string): Promise<ManagerCandidate> {
    const decision = await this.repo.decision(companyId, decisionId);
    if (!decision) return { userId: null, reason: 'no-manager' };
    const manager = await this.staffing.managerOf(decision.employmentId, this.clock.today());
    return manager.kind === 'user' ? { userId: manager.userId } : { userId: null, reason: manager.reason };
  }

  /** Names and dates for notifications (never anything sensitive). */
  async notificationData(companyId: string, decisionId: string): Promise<NotificationData> {
    const decision = await this.repo.decision(companyId, decisionId);
    if (!decision) return { decisionId };
    const [card, contract] = await Promise.all([
      this.staffing.cards([decision.employmentId], this.clock.today()).then((m) => m.get(decision.employmentId)),
      this.repo.contract(companyId, decision.contractId),
    ]);
    return {
      decisionId,
      employmentId: decision.employmentId,
      matricule: card?.matricule ?? null,
      employeeName: card ? `${card.person.firstName} ${card.person.lastName}` : null,
      employeeNameAr: card && (card.person.firstNameAr || card.person.lastNameAr) ? `${card.person.firstNameAr ?? card.person.firstName} ${card.person.lastNameAr ?? card.person.lastName}` : null,
      contractType: contract?.contractType ?? null,
      contractEndDate: contract?.endDate ?? null,
    };
  }
}
