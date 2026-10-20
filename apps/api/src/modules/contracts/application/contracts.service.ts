import { Injectable, NotFoundException } from '@nestjs/common';
import { ScopeService } from '../../../platform/authz/scope-service.js';
import { requireContext } from '../../../platform/context/request-context.js';
import { ProblemException, ValidationProblemException } from '../../../platform/http/problem-details.js';
import { StaffingClock, StaffingService, type EmployeeCard } from '../../staffing/index.js';
import {
  checkTerms,
  ContractRuleViolation,
  CONTRACT_PERMISSIONS as P,
  currentOf,
  latestOf,
  planCorrection,
  planInitial,
  planLater,
  type ContractType,
  type LaterKind,
} from '../domain/contracts.js';
import { ContractsRepository, pgError, type ContractRow, type DecisionRow, type EmploymentRow } from '../infra/contracts.repository.js';
import type { ContractListView, ContractSummary, ContractView } from './contract-views.js';

/** The contract block of POST /employees and of a hire (the initial contract, starting on the hire date). */
export interface InitialContractInput {
  contractType: ContractType;
  endDate?: string | null | undefined;
  probationEnd?: string | null | undefined;
  reference?: string | null | undefined;
  reason?: string | null | undefined;
}

export interface NewContractInput {
  kind: LaterKind;
  contractType: ContractType;
  startDate: string;
  endDate?: string | null | undefined;
  probationEnd?: string | null | undefined;
  reference?: string | null | undefined;
  reason?: string | null | undefined;
  note?: string | null | undefined;
}

/** The body of POST /employees/:id/contracts (the start date is required for every kind but `initial`). */
export interface CreateContractBody {
  kind: 'initial' | LaterKind;
  contractType: ContractType;
  startDate?: string | undefined;
  endDate?: string | null | undefined;
  probationEnd?: string | null | undefined;
  reference?: string | null | undefined;
  reason?: string | null | undefined;
  note?: string | null | undefined;
}

export interface ContractPatch {
  endDate?: string | null | undefined;
  probationEnd?: string | null | undefined;
  reference?: string | null | undefined;
  reason?: string | null | undefined;
  note?: string | null | undefined;
}

function tenant(): { companyId: string; userId: string | null } {
  const { companyId, userId } = requireContext();
  if (!companyId) throw notFound();
  return { companyId, userId };
}

export function notFound(): NotFoundException {
  return new NotFoundException('Employee not found');
}

/** Contract rule violations and constraint races → problem+json. */
export function contractProblem(error: unknown): unknown {
  if (error instanceof ContractRuleViolation) {
    if (error.status === 422 && error.field) {
      return new ValidationProblemException([{ field: error.field, code: error.code ?? 'invalid', message: error.message }]);
    }
    if (error.slug === 'not-found') return new NotFoundException(error.message);
    return new ProblemException(error.status, error.slug, error.message, error.field ? [{ field: error.field, code: error.code ?? error.slug, message: error.message }] : undefined);
  }
  const pg = pgError(error);
  if (pg?.code === '23P01' && pg.constraint === 'employment_contract_no_overlap_ex') {
    return new ProblemException(409, 'contract-overlap', 'The contract overlaps another contract of this employment.', [{ field: 'startDate', code: 'contract_overlap', message: 'Overlaps another contract.' }]);
  }
  if (pg?.code === '23505' && pg.constraint === 'employment_contract_seq_uk') {
    return new ProblemException(409, 'contract-changed', 'The contracts of this employment changed meanwhile; reload and try again.');
  }
  if (pg?.code === '23505' && pg.constraint === 'contract_decision_one_pending_uk') {
    return new ProblemException(409, 'contract-decision-pending', 'A decision about this contract is already in progress.');
  }
  return error;
}

export async function contractProblems<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw contractProblem(error);
  }
}

/** Employment + its card (scope unit as of today) + its contracts. */
export interface LoadedEmployment {
  companyId: string;
  employment: EmploymentRow;
  card: EmployeeCard;
  contracts: ContractRow[];
}

const textOrNull = (v: string | null | undefined): string | null => (v === undefined || v === null || v.trim() === '' ? null : v.trim());

/**
 * Contracts of employments (docs/contracts/contracts-deadlines.md › Contracts). Scope: the employee's unit (employment
 * rule, through the Staffing cards); reading needs employee.read, writing employee.contract.manage over that unit.
 */
@Injectable()
export class ContractsService {
  constructor(
    private readonly repo: ContractsRepository,
    private readonly scopes: ScopeService,
    private readonly staffing: StaffingService,
    private readonly clock: StaffingClock,
  ) {}

  // ── reads ─────────────────────────────────────────────────────────────────────────────────────────────────────

  async list(employmentId: string): Promise<ContractListView> {
    const loaded = await this.load(employmentId, P.read);
    const canManage = await this.canManage(loaded);
    return this.listView(loaded, canManage);
  }

  /** The current contract (today, or `date`) of each employment — for the employee list and detail. */
  async summaries(employmentIds: readonly string[], date = this.clock.today()): Promise<Map<string, ContractSummary>> {
    const { companyId } = tenant();
    const rows = await this.repo.currentContracts(companyId, employmentIds, date);
    return new Map([...rows].map(([id, c]) => [id, { type: c.contractType, endDate: c.endDate, probationEnd: c.probationEnd }]));
  }

  /** Whether the caller holds employee.contract.manage over `unitId`. */
  canManageUnit(unitId: string): Promise<boolean> {
    return this.scopes.inScope(P.manage, unitId);
  }

  // ── writes ────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * The initial contract of a new employment, in the creating transaction (POST /employees, hire). The caller has
   * already been authorised by the create use case; field paths are prefixed (`contract.endDate`).
   */
  async createInitial(employmentId: string, hireDate: string, input: InitialContractInput, prefix = 'contract.'): Promise<void> {
    const { companyId, userId } = tenant();
    const terms = { contractType: input.contractType, startDate: hireDate, endDate: input.endDate ?? null, probationEnd: input.probationEnd ?? null };
    await contractProblems(async () => {
      planInitial([], { hireDate, endDate: null }, terms, this.clock.today(), prefix);
      await this.repo.insertContract(companyId, {
        employmentId,
        seq: 1,
        kind: 'initial',
        ...terms,
        reference: textOrNull(input.reference),
        reason: textOrNull(input.reason),
        note: null,
        decisionId: null,
        createdBy: userId,
      });
    });
  }

  /** POST /employees/:id/contracts: the initial contract (when missing) or a renewal / conversion / amendment. */
  async create(employmentId: string, body: CreateContractBody): Promise<ContractView> {
    const input = body.kind === 'initial' ? { ...body, kind: 'initial' as const } : { ...body, kind: body.kind, startDate: body.startDate ?? '' };
    const loaded = await this.loadForWrite(employmentId);
    const { companyId } = loaded;
    const today = this.clock.today();
    const id = await contractProblems(async () => {
      if (input.kind === 'initial') {
        const terms = { contractType: input.contractType, startDate: input.startDate ?? loaded.employment.hireDate, endDate: input.endDate ?? null, probationEnd: input.probationEnd ?? null };
        planInitial(loaded.contracts, loaded.employment, terms, today);
        return this.insert(companyId, employmentId, { seq: 1, kind: 'initial', ...terms, reference: input.reference, reason: input.reason, note: input.note });
      }
      const terms = { contractType: input.contractType, startDate: input.startDate, endDate: input.endDate ?? null, probationEnd: input.probationEnd ?? null };
      const plan = planLater(loaded.contracts, loaded.employment, input.kind, terms, today);
      if (plan.shortenPrevious) await this.repo.updateContract(companyId, plan.shortenPrevious.id, { endDate: plan.shortenPrevious.endDate });
      return this.insert(companyId, employmentId, { seq: plan.seq, kind: input.kind, ...terms, reference: input.reference, reason: input.reason, note: input.note });
    });
    return this.viewOf(await this.load(employmentId, P.read), id);
  }

  /** PATCH /employees/:id/contracts/:contractId — corrections of the latest contract. */
  async patch(employmentId: string, contractId: string, patch: ContractPatch): Promise<ContractView> {
    const loaded = await this.loadForWrite(employmentId);
    if (!loaded.contracts.some((c) => c.id === contractId)) throw new NotFoundException('Contract not found');
    await contractProblems(async () => {
      const terms = planCorrection(loaded.contracts, contractId, patch, loaded.employment, this.clock.today());
      await this.repo.updateContract(loaded.companyId, contractId, {
        ...(patch.endDate !== undefined ? { endDate: terms.endDate } : {}),
        ...(patch.probationEnd !== undefined ? { probationEnd: terms.probationEnd } : {}),
        ...(patch.reference !== undefined ? { reference: textOrNull(patch.reference) } : {}),
        ...(patch.reason !== undefined ? { reason: textOrNull(patch.reason) } : {}),
        ...(patch.note !== undefined ? { note: textOrNull(patch.note) } : {}),
      });
    });
    return this.viewOf(await this.load(employmentId, P.read), contractId);
  }

  /**
   * A contract created by an approved decision (renewal or conversion), in the approval transaction. The approver was
   * authorised by the workflow engine (HR step: employee.contract.manage over the employee's unit).
   */
  async applyDecisionContract(
    companyId: string,
    employmentId: string,
    decisionId: string,
    kind: 'renewal' | 'conversion',
    terms: { contractType: ContractType; startDate: string; endDate: string | null },
  ): Promise<string> {
    const employment = await this.repo.employment(companyId, employmentId);
    if (!employment) throw notFound();
    const contracts = await this.repo.contractsOf(companyId, employmentId);
    const { userId } = tenant();
    return contractProblems(async () => {
      const full = { ...terms, probationEnd: null };
      const plan = planLater(contracts, employment, kind, full, this.clock.today());
      if (plan.shortenPrevious) await this.repo.updateContract(companyId, plan.shortenPrevious.id, { endDate: plan.shortenPrevious.endDate });
      return this.repo.insertContract(companyId, {
        employmentId,
        seq: plan.seq,
        kind,
        ...full,
        reference: null,
        reason: null,
        note: null,
        decisionId,
        createdBy: userId,
      });
    });
  }

  // ── helpers ───────────────────────────────────────────────────────────────────────────────────────────────────

  private async insert(
    companyId: string,
    employmentId: string,
    c: { seq: number; kind: ContractRow['kind']; contractType: ContractType; startDate: string; endDate: string | null; probationEnd: string | null; reference?: string | null | undefined; reason?: string | null | undefined; note?: string | null | undefined },
  ): Promise<string> {
    checkTerms(c);
    const { userId } = tenant();
    return this.repo.insertContract(companyId, {
      employmentId,
      seq: c.seq,
      kind: c.kind,
      contractType: c.contractType,
      startDate: c.startDate,
      endDate: c.endDate,
      probationEnd: c.probationEnd,
      reference: textOrNull(c.reference),
      reason: textOrNull(c.reason),
      note: textOrNull(c.note),
      decisionId: null,
      createdBy: userId,
    });
  }

  /** The employment readable with `permission` over its scope unit — else 404. */
  async load(employmentId: string, permission: string = P.read): Promise<LoadedEmployment> {
    const { companyId } = tenant();
    const employment = await this.repo.employment(companyId, employmentId);
    if (!employment) throw notFound();
    const card = (await this.staffing.cards([employmentId])).get(employmentId);
    if (!card || !(await this.scopes.inScope(permission, card.unit.id))) throw notFound();
    return { companyId, employment, card, contracts: await this.repo.contractsOf(companyId, employmentId) };
  }

  /** Readable (employee.read, else 404) and writable (employee.contract.manage, else 403 forbidden-scope). */
  private async loadForWrite(employmentId: string): Promise<LoadedEmployment> {
    const loaded = await this.load(employmentId, P.read);
    if (!(await this.canManageUnit(loaded.card.unit.id))) {
      throw new ProblemException(403, 'forbidden-scope', 'You cannot change the contracts of this employee (outside your employee.contract.manage scope).');
    }
    return loaded;
  }

  private async canManage(loaded: LoadedEmployment): Promise<boolean> {
    const ended = loaded.employment.endDate !== null && loaded.employment.endDate < this.clock.today();
    return !ended && (await this.canManageUnit(loaded.card.unit.id));
  }

  async listView(loaded: LoadedEmployment, canManage: boolean): Promise<ContractListView> {
    const today = this.clock.today();
    const names = await this.repo.names(loaded.companyId);
    const current = currentOf(loaded.contracts, today);
    const latest = latestOf(loaded.contracts);
    const decisions = await this.repo.activeDecisionsOf(loaded.companyId, loaded.contracts.map((c) => c.id));
    const items = loaded.contracts.toReversed().map((c) => toView(c, names, current?.id ?? null, canManage && latest?.id === c.id, decisions.get(c.id) ?? null));
    return { items, currentId: current?.id ?? null };
  }

  private async viewOf(loaded: LoadedEmployment, id: string): Promise<ContractView> {
    const list = await this.listView(loaded, await this.canManage(loaded));
    const view = list.items.find((c) => c.id === id);
    if (!view) throw new NotFoundException('Contract not found');
    return view;
  }
}

export function toView(
  c: ContractRow,
  names: ReadonlyMap<string, string>,
  currentId: string | null,
  editable: boolean,
  pending: Pick<DecisionRow, 'id' | 'status'> | null = null,
): ContractView {
  return {
    id: c.id,
    seq: c.seq,
    kind: c.kind,
    contractType: c.contractType,
    startDate: c.startDate,
    endDate: c.endDate,
    probationEnd: c.probationEnd,
    reference: c.reference,
    reason: c.reason,
    note: c.note,
    decision: c.decisionId ? { id: c.decisionId } : null,
    pendingDecision: pending && (pending.status === 'pending' || pending.status === 'approved') ? { id: pending.id, status: pending.status } : null,
    createdAt: c.createdAt,
    createdBy: c.createdBy ? { id: c.createdBy, displayName: names.get(c.createdBy) ?? '' } : null,
    current: c.id === currentId,
    _actions: editable ? ['edit'] : [],
  };
}
