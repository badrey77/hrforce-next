import { Injectable, NotFoundException } from '@nestjs/common';
import { ScopeService } from '../../../platform/authz/scope-service.js';
import { requireContext } from '../../../platform/context/request-context.js';
import { ProblemException } from '../../../platform/http/problem-details.js';
import { StaffingService } from '../../staffing/index.js';
import { compareCandidates, computeDeadlines, deadlineKey, onBoard, type DeadlineCandidate } from '../domain/compute.js';
import { DEADLINE_KINDS, DEADLINE_PERMISSIONS as P, DEFAULT_WITHIN_DAYS, type DeadlineKind, type DeadlinePolicy } from '../domain/types.js';
import { DeadlinesRepository, pgError, type AckRow, type EmploymentRow, type FileRow } from '../infra/deadlines.repository.js';
import { DeadlinesClock } from './deadlines-clock.js';
import type { DeadlineItem, DeadlinePage, DeadlinePolicyView, DeadlineSummary } from './deadline-views.js';

/** The permission that opens a contract decision (docs/contracts/contracts-deadlines.md › Contract decisions). */
const CONTRACT_MANAGE = 'employee.contract.manage';
const MEDICAL_READ = 'employee.medical.read';

export interface DeadlinesQuery {
  kind?: DeadlineKind | undefined;
  status: 'open' | 'handled' | 'all';
  unitId?: string | undefined;
  includeSubUnits: boolean;
  within: number;
  q?: string | undefined;
  page: number;
  pageSize: number;
}

interface Computed {
  candidate: DeadlineCandidate;
  employment: EmploymentRow;
  ack: AckRow | undefined;
  file: FileRow | undefined;
}

function tenant(): { companyId: string; userId: string } {
  const { companyId, userId } = requireContext();
  if (!companyId || !userId) throw new Error('deadlines: no tenant or user in the request context');
  return { companyId, userId };
}

/**
 * The deadlines board (docs/contracts/contracts-deadlines.md › Deadlines): computed at read time in the caller's
 * `deadline.read` scope (the employee's scope unit today), acknowledgements, and the per-company policy.
 */
@Injectable()
export class DeadlinesService {
  constructor(
    private readonly repo: DeadlinesRepository,
    private readonly scopes: ScopeService,
    private readonly staffing: StaffingService,
    private readonly clock: DeadlinesClock,
  ) {}

  /** Every item in the read scope (with acks), before the board's filters. */
  private async compute(companyId: string, filter: { unitId?: string | undefined; includeSubUnits?: boolean; q?: string | undefined } = {}): Promise<{ today: string; items: Computed[] }> {
    const today = this.clock.today();
    const [employments, policy] = await Promise.all([
      this.repo.employments(companyId, { today, scope: await this.scopes.scopeOf(P.read), unitId: filter.unitId, includeSubUnits: filter.includeSubUnits, q: filter.q }),
      this.repo.policy(companyId),
    ]);
    const medicalUnits = await this.scopes.unitIds(MEDICAL_READ);
    const byId = new Map(employments.map((e) => [e.employmentId, e]));
    const files = (await this.repo.files(companyId, employments.map((e) => e.employmentId))).filter((f) => !f.medical || medicalUnits.has(byId.get(f.employmentId)?.unitId ?? ''));
    const fileById = new Map(files.map((f) => [f.id, f]));
    const candidates = computeDeadlines(employments, files, policy, today);
    const acks = await this.repo.acks(companyId, candidates.map((c) => c.subjectId));
    const ackByKey = new Map(acks.map((a) => [deadlineKey(a.kind, a.subjectId, a.dueDate), a]));
    const items: Computed[] = [];
    for (const candidate of candidates) {
      const employment = byId.get(candidate.employmentId);
      if (!employment) continue;
      items.push({ candidate, employment, ack: ackByKey.get(deadlineKey(candidate.kind, candidate.subjectId, candidate.dueDate)), file: candidate.fileId ? fileById.get(candidate.fileId) : undefined });
    }
    return { today, items };
  }

  async list(query: DeadlinesQuery): Promise<DeadlinePage> {
    const { companyId } = tenant();
    const { today, items } = await this.compute(companyId, query);
    const selected = items
      .filter(({ candidate, ack }) => {
        if (query.kind && candidate.kind !== query.kind) return false;
        if (query.status === 'open' && ack) return false;
        if (query.status === 'handled' && !ack) return false;
        return onBoard(candidate, today, query.within);
      })
      .map((c) => ({ ...c, status: c.ack ? ('handled' as const) : c.candidate.status }))
      .toSorted((a, b) => compareCandidates({ ...a.candidate, status: a.status }, { ...b.candidate, status: b.status }));
    const offset = (query.page - 1) * query.pageSize;
    const page = selected.slice(offset, offset + query.pageSize);
    return { items: await this.views(companyId, page), total: selected.length, page: query.page, pageSize: query.pageSize };
  }

  async summary(): Promise<DeadlineSummary> {
    const { companyId } = tenant();
    const { today, items } = await this.compute(companyId);
    const byKind = Object.fromEntries(DEADLINE_KINDS.map((k) => [k, { overdue: 0, due: 0 }])) as DeadlineSummary['byKind'];
    const summary: DeadlineSummary = { overdue: 0, critical: 0, next30: 0, byKind };
    for (const { candidate: c, ack } of items) {
      if (ack || !onBoard(c, today, DEFAULT_WITHIN_DAYS)) continue;
      if (c.status === 'overdue') {
        summary.overdue += 1;
        byKind[c.kind].overdue += 1;
        if (c.severity === 'critical') summary.critical += 1;
      } else {
        byKind[c.kind].due += 1;
        if (c.daysLeft <= 30) summary.next30 += 1;
      }
    }
    return summary;
  }

  /** POST /deadlines/acks: the item must exist today in the read scope (404 outside it), handled in the handle scope. */
  async ack(body: { kind: DeadlineKind; subjectId: string; dueDate: string; note: string | null }): Promise<DeadlineItem> {
    const { companyId, userId } = tenant();
    const unitId = await this.repo.subjectUnit(companyId, body.kind, body.subjectId, this.clock.today());
    if (!unitId || !(await this.scopes.inScope(P.read, unitId))) throw new NotFoundException('Deadline not found');
    const { items } = await this.compute(companyId);
    const found = items.find(({ candidate: c }) => c.kind === body.kind && c.subjectId === body.subjectId && c.dueDate === body.dueDate);
    if (!found) {
      throw new ProblemException(422, 'validation-error', 'No such deadline today in your scope.', [
        { field: 'subjectId', code: 'not_found', message: 'No deadline of this kind, subject and due date.' },
      ]);
    }
    if (!(await this.scopes.inScope(P.handle, found.employment.unitId))) {
      throw new ProblemException(403, 'forbidden-scope', 'This employee is outside the scope where you can handle deadlines.');
    }
    if (found.ack) throw new ProblemException(409, 'deadline-already-handled', 'This deadline is already marked as handled.');
    let id: string;
    try {
      id = await this.repo.insertAck(companyId, { kind: body.kind, subjectId: body.subjectId, dueDate: body.dueDate, note: body.note, ackedBy: userId });
    } catch (error) {
      if (pgError(error)?.constraint === 'deadline_ack_once_uk') throw new ProblemException(409, 'deadline-already-handled', 'This deadline is already marked as handled.');
      throw error;
    }
    const ack = await this.repo.ack(companyId, id);
    const [view] = await this.views(companyId, [{ ...found, ack, status: 'handled' }]);
    if (!view) throw new Error('deadline view not built');
    return view;
  }

  /** DELETE /deadlines/acks/:id: the acknowledged item's employee must be in the handle scope (404 outside the read one). */
  async unack(id: string): Promise<void> {
    const { companyId } = tenant();
    const ack = await this.repo.ack(companyId, id);
    if (!ack) throw new NotFoundException('Acknowledgement not found');
    const unitId = await this.repo.subjectUnit(companyId, ack.kind, ack.subjectId, this.clock.today());
    if (!unitId || !(await this.scopes.inScope(P.read, unitId))) throw new NotFoundException('Acknowledgement not found');
    if (!(await this.scopes.inScope(P.handle, unitId))) {
      throw new ProblemException(403, 'forbidden-scope', 'This employee is outside the scope where you can handle deadlines.');
    }
    await this.repo.deleteAck(companyId, id);
  }

  async settings(): Promise<DeadlinePolicyView> {
    const { companyId } = tenant();
    return this.repo.policy(companyId);
  }

  async saveSettings(patch: Partial<DeadlinePolicy>): Promise<DeadlinePolicyView> {
    const { companyId } = tenant();
    if (!(await this.scopes.coversCompany(P.configure))) {
      throw new ProblemException(403, 'forbidden-scope', 'Deadline settings are changed company-wide only.');
    }
    const current = await this.repo.policy(companyId);
    const next: DeadlinePolicy = { ...current };
    for (const [key, value] of Object.entries(patch) as [keyof DeadlinePolicy, number | boolean | undefined][]) {
      if (value !== undefined) (next as unknown as Record<string, number | boolean>)[key] = value;
    }
    await this.repo.savePolicy(companyId, next);
    return this.repo.policy(companyId);
  }

  private async views(companyId: string, rows: readonly (Computed & { status: 'due' | 'overdue' | 'handled' })[]): Promise<DeadlineItem[]> {
    if (rows.length === 0) return [];
    const contractIds = rows.flatMap((r) => (r.candidate.kind === 'contract_end' && r.candidate.contractId ? [r.candidate.contractId] : []));
    const [cards, decisions, names, handleUnits, manageUnits] = await Promise.all([
      this.staffing.cards(rows.map((r) => r.candidate.employmentId)),
      this.repo.decisions(companyId, contractIds),
      this.repo.names(companyId),
      this.scopes.unitIds(P.handle),
      this.scopes.unitIds(CONTRACT_MANAGE),
    ]);
    return rows.map(({ candidate: c, employment: e, ack, file, status }) => {
      const card = cards.get(c.employmentId);
      const contract = c.contractId ? e.contracts.find((k) => k.id === c.contractId) : undefined;
      const decision = c.contractId && c.kind === 'contract_end' ? decisions.get(c.contractId) : undefined;
      const actions: DeadlineItem['_actions'] = [];
      if (handleUnits.has(e.unitId)) actions.push(ack ? 'unack' : 'ack');
      if (c.kind === 'contract_end' && !ack && decision?.status !== 'pending' && decision?.status !== 'approved' && manageUnits.has(e.unitId)) actions.push('open_decision');
      return {
        key: deadlineKey(c.kind, c.subjectId, c.dueDate),
        kind: c.kind,
        dueDate: c.dueDate,
        daysLeft: c.daysLeft,
        status,
        severity: c.severity,
        employee: card
          ? { id: card.id, matricule: card.matricule, person: card.person, unit: card.unit, jobTitle: card.jobTitle }
          : { id: c.employmentId, matricule: '', person: { id: '', lastName: '', firstName: '', lastNameAr: null, firstNameAr: null }, unit: { id: e.unitId, code: '', kind: '', name: '', nameAr: null }, jobTitle: '' },
        contract: contract ? { id: contract.id, contractType: contract.contractType, startDate: contract.startDate, endDate: contract.endDate } : null,
        file: file ? { id: file.id, title: file.title, category: { code: file.categoryCode, names: { fr: file.categoryNameFr, ar: file.categoryNameAr, en: file.categoryNameEn } } } : null,
        decision: decision ? { id: decision.id, status: decision.status } : null,
        ack: ack ? { id: ack.id, note: ack.note, at: ack.ackedAt, by: { id: ack.ackedBy, displayName: names.get(ack.ackedBy) ?? ack.ackedBy } } : null,
        _actions: actions,
      };
    });
  }
}
