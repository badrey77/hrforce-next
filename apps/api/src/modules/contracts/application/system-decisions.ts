import { DenyAllPermissionEvaluator } from '../../../platform/authz/permission-evaluator.js';
import { CompanyWideScopeService } from '../../../platform/authz/scope-service.js';
import type { Database } from '../../../platform/db/database.js';
import { PgAuditEvents } from '../../audit/index.js';
import { createWorkerNotifier } from '../../notifications/index.js';
import { StaffingClock, StaffingRepository, StaffingService } from '../../staffing/index.js';
import { WorkflowEngine, WorkflowRepository, WorkflowSubjects } from '../../workflow/index.js';
import { ContractsRepository } from '../infra/contracts.repository.js';
import { DecisionOpener } from './decision-opener.js';

const refuse = (): Promise<never> => Promise.reject(new Error('contract decisions are acted on in the API, not by the worker'));

/**
 * The daily job's « open the due contract decisions » (docs/contracts/contracts-deadlines.md › Worker), for one
 * company. MUST run inside `inCompany` (src/worker/company-loop.ts): the request context of the job — company set,
 * no user — and its transaction. Builds the few services it needs by hand (the worker has no Nest container);
 * the workflow starts as the system actor and notifies the first step's candidates (`task.assigned`). Returns how
 * many decisions were opened (0 when the policy's decision notice is 0). Idempotent: a contract with a pending or
 * approved decision is skipped, and the pending-decision unique index refuses a concurrent duplicate.
 */
export async function openDueContractDecisions(db: Database, companyId: string, today: string): Promise<number> {
  const audit = new PgAuditEvents(db);
  // the system holds no permission: candidates are read from grants (permissionHolders), never from this scope
  const scopes = new CompanyWideScopeService(new DenyAllPermissionEvaluator());
  const clock = new StaffingClock();
  const staffing = new StaffingService(new StaffingRepository(), scopes, clock, audit);
  const repo = new ContractsRepository();
  const subjects = new WorkflowSubjects();
  const engine = new WorkflowEngine(new WorkflowRepository(), scopes, subjects, audit, createWorkerNotifier());
  const opener = new DecisionOpener(repo, staffing, clock, engine, audit);
  subjects.register('contract_decision', {
    resolveManager: (id) => opener.resolveManager(companyId, id),
    notificationData: (id) => opener.notificationData(companyId, id),
    onApproved: refuse,
    onRejected: refuse,
    onCancelled: refuse,
    summaries: () => Promise.resolve(new Map()),
  });
  return opener.openDue(companyId, today);
}
