import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { currentTx } from '../../../platform/context/request-context.js';
import type { ContractKind, ContractType, Proposal } from '../domain/contracts.js';

export interface ContractRow {
  id: string;
  employmentId: string;
  seq: number;
  kind: ContractKind;
  contractType: ContractType;
  startDate: string;
  endDate: string | null;
  probationEnd: string | null;
  reference: string | null;
  reason: string | null;
  note: string | null;
  decisionId: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface EmploymentRow {
  id: string;
  hireDate: string;
  endDate: string | null;
}

export type DecisionStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface DecisionRow {
  id: string;
  employmentId: string;
  contractId: string;
  status: DecisionStatus;
  proposal: Proposal | null;
  proposedStartDate: string | null;
  proposedEndDate: string | null;
  comment: string | null;
  proposedBy: string | null;
  proposedAt: string | null;
  workflowInstanceId: string | null;
  resultContractId: string | null;
  openedBy: string;
  createdAt: string;
}

export interface NewContract {
  employmentId: string;
  seq: number;
  kind: ContractKind;
  contractType: ContractType;
  startDate: string;
  endDate: string | null;
  probationEnd: string | null;
  reference: string | null;
  reason: string | null;
  note: string | null;
  decisionId: string | null;
  createdBy: string | null;
}

const CONTRACT_COLUMNS = sql`c.id, c.employment_id as "employmentId", c.seq, c.kind, c.contract_type as "contractType",
  c.start_date::text as "startDate", c.end_date::text as "endDate", c.probation_end::text as "probationEnd",
  c.reference, c.reason, c.note, c.decision_id as "decisionId", c.created_by as "createdBy", to_char(c.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt"`;

const DECISION_COLUMNS = sql`d.id, d.employment_id as "employmentId", d.contract_id as "contractId", d.status, d.proposal,
  d.proposed_start_date::text as "proposedStartDate", d.proposed_end_date::text as "proposedEndDate", d.comment,
  d.proposed_by as "proposedBy", to_char(d.proposed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "proposedAt", d.workflow_instance_id as "workflowInstanceId",
  d.result_contract_id as "resultContractId", d.opened_by as "openedBy", to_char(d.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt"`;

/** Postgres error fields (code, constraint) of a failed statement, if any. */
export function pgError(error: unknown): { code?: string; constraint?: string } | undefined {
  if (error && typeof error === 'object' && 'code' in error) return error as { code?: string; constraint?: string };
  return undefined;
}

/** Contracts and decisions, through the request (or job) transaction. */
@Injectable()
export class ContractsRepository {
  async employment(companyId: string, id: string): Promise<EmploymentRow | undefined> {
    const { rows } = await sql<EmploymentRow>`select e.id, e.hire_date::text as "hireDate", e.end_date::text as "endDate"
      from employment e where e.company_id = ${companyId}::uuid and e.id = ${id}::uuid`.execute(currentTx());
    return rows[0];
  }

  async contractsOf(companyId: string, employmentId: string): Promise<ContractRow[]> {
    const { rows } = await sql<ContractRow>`select ${CONTRACT_COLUMNS} from employment_contract c
      where c.company_id = ${companyId}::uuid and c.employment_id = ${employmentId}::uuid order by c.seq`.execute(currentTx());
    return rows;
  }

  async contract(companyId: string, id: string): Promise<ContractRow | undefined> {
    const { rows } = await sql<ContractRow>`select ${CONTRACT_COLUMNS} from employment_contract c
      where c.company_id = ${companyId}::uuid and c.id = ${id}::uuid`.execute(currentTx());
    return rows[0];
  }

  /** The contract covering `date` of each employment (absent key = none). */
  async currentContracts(companyId: string, employmentIds: readonly string[], date: string): Promise<Map<string, ContractRow>> {
    if (employmentIds.length === 0) return new Map();
    const { rows } = await sql<ContractRow>`select ${CONTRACT_COLUMNS} from employment_contract c
      where c.company_id = ${companyId}::uuid and c.employment_id = any(${[...employmentIds]}::uuid[])
        and c.start_date <= ${date}::date and (c.end_date is null or c.end_date >= ${date}::date)`.execute(currentTx());
    return new Map(rows.map((r) => [r.employmentId, r]));
  }

  /** Every contract of the given employments (oldest first per employment). */
  async contractsOfMany(companyId: string, employmentIds: readonly string[]): Promise<ContractRow[]> {
    if (employmentIds.length === 0) return [];
    const { rows } = await sql<ContractRow>`select ${CONTRACT_COLUMNS} from employment_contract c
      where c.company_id = ${companyId}::uuid and c.employment_id = any(${[...employmentIds]}::uuid[])
      order by c.employment_id, c.seq`.execute(currentTx());
    return rows;
  }

  async insertContract(companyId: string, c: NewContract): Promise<string> {
    const row = await currentTx()
      .insertInto('employment_contract')
      .values({
        company_id: companyId,
        employment_id: c.employmentId,
        seq: c.seq,
        kind: c.kind,
        contract_type: c.contractType,
        start_date: c.startDate,
        end_date: c.endDate,
        probation_end: c.probationEnd,
        reference: c.reference,
        reason: c.reason,
        note: c.note,
        decision_id: c.decisionId,
        created_by: c.createdBy,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async updateContract(
    companyId: string,
    id: string,
    patch: Partial<{ endDate: string | null; probationEnd: string | null; reference: string | null; reason: string | null; note: string | null }>,
  ): Promise<void> {
    const set: Record<string, string | null> = {};
    if (patch.endDate !== undefined) set['end_date'] = patch.endDate;
    if (patch.probationEnd !== undefined) set['probation_end'] = patch.probationEnd;
    if (patch.reference !== undefined) set['reference'] = patch.reference;
    if (patch.reason !== undefined) set['reason'] = patch.reason;
    if (patch.note !== undefined) set['note'] = patch.note;
    if (Object.keys(set).length === 0) return;
    await currentTx().updateTable('employment_contract').set(set).where('company_id', '=', companyId).where('id', '=', id).execute();
  }

  // ── decisions ───────────────────────────────────────────────────────────────────────────────────────────────────

  async decision(companyId: string, id: string, options: { lock?: boolean } = {}): Promise<DecisionRow | undefined> {
    const lock = options.lock ? sql`for update` : sql``;
    const { rows } = await sql<DecisionRow>`select ${DECISION_COLUMNS} from contract_decision d
      where d.company_id = ${companyId}::uuid and d.id = ${id}::uuid ${lock}`.execute(currentTx());
    return rows[0];
  }

  async decisions(companyId: string, ids: readonly string[]): Promise<DecisionRow[]> {
    if (ids.length === 0) return [];
    const { rows } = await sql<DecisionRow>`select ${DECISION_COLUMNS} from contract_decision d
      where d.company_id = ${companyId}::uuid and d.id = any(${[...ids]}::uuid[])`.execute(currentTx());
    return rows;
  }

  /** The pending or approved decision of each contract (absent = none). */
  async activeDecisionsOf(companyId: string, contractIds: readonly string[]): Promise<Map<string, DecisionRow>> {
    if (contractIds.length === 0) return new Map();
    const { rows } = await sql<DecisionRow>`select ${DECISION_COLUMNS} from contract_decision d
      where d.company_id = ${companyId}::uuid and d.contract_id = any(${[...contractIds]}::uuid[]) and d.status in ('pending', 'approved')
      order by d.created_at`.execute(currentTx());
    return new Map(rows.map((r) => [r.contractId, r]));
  }

  async decisionsOfEmployment(companyId: string, employmentId: string): Promise<DecisionRow[]> {
    const { rows } = await sql<DecisionRow>`select ${DECISION_COLUMNS} from contract_decision d
      where d.company_id = ${companyId}::uuid and d.employment_id = ${employmentId}::uuid order by d.created_at desc`.execute(currentTx());
    return rows;
  }

  async insertDecision(companyId: string, input: { employmentId: string; contractId: string; openedBy: string }): Promise<string> {
    const row = await currentTx()
      .insertInto('contract_decision')
      .values({ company_id: companyId, employment_id: input.employmentId, contract_id: input.contractId, opened_by: input.openedBy })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async setDecisionInstance(companyId: string, id: string, instanceId: string): Promise<void> {
    await currentTx().updateTable('contract_decision').set({ workflow_instance_id: instanceId }).where('company_id', '=', companyId).where('id', '=', id).execute();
  }

  async setProposal(
    companyId: string,
    id: string,
    p: { proposal: Proposal; startDate: string | null; endDate: string | null; comment: string | null; by: string },
  ): Promise<void> {
    await sql`update contract_decision set proposal = ${p.proposal}, proposed_start_date = ${p.startDate}::date,
        proposed_end_date = ${p.endDate}::date, comment = ${p.comment}, proposed_by = ${p.by}::uuid, proposed_at = now(), updated_at = now()
      where company_id = ${companyId}::uuid and id = ${id}::uuid`.execute(currentTx());
  }

  async finishDecision(companyId: string, id: string, status: Exclude<DecisionStatus, 'pending'>, resultContractId: string | null = null): Promise<void> {
    await sql`update contract_decision set status = ${status}, result_contract_id = coalesce(${resultContractId}::uuid, result_contract_id), updated_at = now()
      where company_id = ${companyId}::uuid and id = ${id}::uuid`.execute(currentTx());
  }

  /**
   * Candidates for an automatic decision on `today`: the latest contract of each open employment (no end date, or one
   * after the contract end), fixed term, ending between `today` and `today + noticeDays`, without a pending, approved or
   * rejected decision. The domain rule ({@link decisionDue}) re-checks each one.
   */
  async decisionCandidates(companyId: string, today: string, noticeDays: number): Promise<{ contract: ContractRow; employment: EmploymentRow }[]> {
    const { rows } = await sql<ContractRow & { hireDate: string; employmentEndDate: string | null }>`
      select ${CONTRACT_COLUMNS}, e.hire_date::text as "hireDate", e.end_date::text as "employmentEndDate"
        from employment_contract c
        join employment e on e.company_id = c.company_id and e.id = c.employment_id
       where c.company_id = ${companyId}::uuid
         and c.end_date is not null
         and c.end_date >= ${today}::date and c.end_date <= ${today}::date + ${noticeDays}::int
         and (e.end_date is null or e.end_date > c.end_date)
         and not exists (select 1 from employment_contract n where n.company_id = c.company_id and n.employment_id = c.employment_id and n.seq > c.seq)
         -- a decision already taken (or refused: HR then acts by hand) is never reopened by the job
         and not exists (select 1 from contract_decision d where d.company_id = c.company_id and d.contract_id = c.id and d.status in ('pending', 'approved', 'rejected'))
       order by c.end_date, c.id`.execute(currentTx());
    return rows.map(({ hireDate, employmentEndDate, ...contract }) => ({ contract, employment: { id: contract.employmentId, hireDate, endDate: employmentEndDate } }));
  }

  /** The decision workflow definition of the company. */
  async decisionDefinitionId(companyId: string, code: string): Promise<string | undefined> {
    const row = await currentTx().selectFrom('workflow_definition').select('id').where('company_id', '=', companyId).where('code', '=', code).executeTakeFirst();
    return row?.id;
  }

  /** decision notice days of the company's deadline policy (default 45 when no row). */
  async decisionNoticeDays(companyId: string): Promise<number> {
    const row = await currentTx().selectFrom('deadline_policy').select('decision_notice_days').where('company_id', '=', companyId).executeTakeFirst();
    return row?.decision_notice_days ?? 45;
  }

  /** Display names of the company's members (users referenced by contracts and decisions). */
  async names(companyId: string): Promise<Map<string, string>> {
    const { rows } = await sql<{ user_id: string; display_name: string }>`
      select user_id, display_name from auth.company_members(${companyId}::uuid)`.execute(currentTx());
    return new Map(rows.map((r) => [r.user_id, r.display_name]));
  }
}
