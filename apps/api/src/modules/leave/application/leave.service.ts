import { ForbiddenException, Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { ScopeService } from '../../../platform/authz/scope-service.js';
import { currentTx, requireContext } from '../../../platform/context/request-context.js';
import { ProblemException, ValidationProblemException } from '../../../platform/http/problem-details.js';
import { Notifier, type NotificationData, type NotificationType } from '../../../platform/notifications/notifier.js';
import { StaffingService, type EmployeeCard } from '../../staffing/index.js';
import { WorkflowEngine, WorkflowSubjects, type HookContext, type ManagerCandidate, type UserRef } from '../../workflow/index.js';
import { parseMonth } from '../domain/accrual.js';
import { monthStart } from '../domain/dates.js';
import { computeLeaveDays, type DaysResult } from '../domain/days.js';
import {
  allocateTaken,
  availableOn,
  canCancel,
  checkRequest,
  fromTenths,
  isPeriodStart,
  LeaveRuleViolation,
  periodBalances,
  periodEndOf,
  periodStartOf,
  toTenths,
  type PeriodBalance,
  type RequestStatus,
} from '../domain/rules.js';
import { runAccruals, type AccrualRunResult } from '../infra/accrual-run.js';
import { constraintViolation, LeaveRepository, type PolicyRow, type RequestRow, type TypeRow } from '../infra/leave.repository.js';
import { LeaveClock } from './leave-clock.js';
import type {
  BalancesView,
  BalanceView,
  LedgerView,
  LeaveEmployee,
  LeaveRequestAction,
  LeaveRequestDetail,
  LeaveRequestPage,
  LeaveRequestSummary,
  PreviewView,
} from './leave-views.js';

export const LEAVE_PERMISSIONS = {
  requestSelf: 'leave.request_self',
  read: 'leave.read',
  request: 'leave.request',
  approveHr: 'leave.approve_hr',
  adjust: 'leave.adjust',
  configure: 'leave.configure',
} as const;
const P = LEAVE_PERMISSIONS;

export interface RequestInput {
  leaveTypeId: string;
  startDate: string;
  endDate: string;
  halfDayStart: boolean;
  halfDayEnd: boolean;
  reason: string | null;
  documentRef: string | null;
}

export interface ListInput {
  status?: RequestStatus | undefined;
  unitId?: string | undefined;
  includeSubUnits: boolean;
  from?: string | undefined;
  to?: string | undefined;
  typeId?: string | undefined;
  q?: string | undefined;
  page: number;
  pageSize: number;
}

function caller(): { companyId: string; userId: string } {
  const { companyId, userId } = requireContext();
  if (!companyId || !userId) throw new NotFoundException();
  return { companyId, userId };
}

const requestNotFound = () => new NotFoundException('Leave request not found');
const employeeNotFound = () => new NotFoundException('Employee not found');

/** Leave rule violations → 409 problem+json (`errors[]` on the offending field). */
export function toProblem(error: unknown): unknown {
  if (error instanceof LeaveRuleViolation) {
    const errors = error.field ? [{ field: error.field, code: error.slug.replace(/-/g, '_'), message: error.message }] : undefined;
    return new ProblemException(409, error.slug, error.message, errors);
  }
  if (constraintViolation(error)?.constraint === 'leave_request_no_overlap_ex') {
    return toProblem(new LeaveRuleViolation('leave-overlap', 'Another pending or approved request covers some of these days.', 'startDate'));
  }
  return error;
}

export async function problems<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw toProblem(error);
  }
}

const labelsOf = (t: TypeRow) => ({ fr: t.nameFr, ar: t.nameAr, en: t.nameEn });

/**
 * Leave use cases (docs/contracts/leave.md › Leave): self-service and HR requests, preview, balances, ledger,
 * adjustments, the accrual run, and the workflow subject hooks of `leave_request`. Everything runs in the request
 * transaction; scope from the platform ScopeService (a request is scoped by the unit recorded on it — the employee's
 * unit when it was made; an employee by their scope unit today).
 */
@Injectable()
export class LeaveService implements OnModuleInit {
  constructor(
    private readonly repo: LeaveRepository,
    private readonly scopes: ScopeService,
    private readonly staffing: StaffingService,
    private readonly engine: WorkflowEngine,
    private readonly subjects: WorkflowSubjects,
    private readonly clock: LeaveClock,
    private readonly notifier: Notifier,
  ) {}

  onModuleInit(): void {
    this.subjects.register('leave_request', {
      resolveManager: (id) => this.resolveManager(id),
      onApproved: (c) => this.onApproved(c),
      onRejected: (c) => this.onRejected(c),
      onCancelled: (c) => this.onCancelled(c),
      summaries: async (ids) => {
        const { companyId } = caller();
        const summaries = await this.summaries(companyId, await this.repo.requests(companyId, ids), { withWorkflow: false });
        return new Map(summaries.map((s) => [s.id, { ...s } as Record<string, unknown>]));
      },
      notificationData: (id) => this.notificationData(id),
    });
  }

  // ── access helpers ────────────────────────────────────────────────────────────────────────────────────────────

  /** The caller's linked employment, else 409 `leave-not-linked`. */
  private async ownEmployment(): Promise<string> {
    const { userId } = caller();
    const employmentId = await this.staffing.linkedEmploymentOf(userId);
    if (!employmentId) throw toProblem(new LeaveRuleViolation('leave-not-linked', 'Your account is not linked to an employee.'));
    return employmentId;
  }

  /**
   * An employee for an HR route: 404 when unknown or outside both `leave.read` and `permission`; 403
   * `forbidden-scope` when readable but `permission` does not cover them.
   */
  private async employeeFor(employmentId: string, permission: string): Promise<EmployeeCard> {
    const card = (await this.staffing.cards([employmentId])).get(employmentId);
    if (!card) throw employeeNotFound();
    if (await this.scopes.inScope(permission, card.unit.id)) return card;
    if (await this.scopes.inScope(P.read, card.unit.id)) {
      throw new ProblemException(403, 'forbidden-scope', `You cannot do this for this employee (outside your ${permission} scope).`);
    }
    throw employeeNotFound();
  }

  private async holds(code: string): Promise<boolean> {
    return (await this.scopes.unitIds(code)).size > 0;
  }

  // ── reads ─────────────────────────────────────────────────────────────────────────────────────────────────────

  async myBalances(asOf?: string): Promise<BalancesView> {
    return this.balancesOf(await this.ownEmployment(), asOf ?? this.clock.today());
  }

  async employeeBalances(employmentId: string, asOf?: string): Promise<BalancesView> {
    await this.employeeFor(employmentId, P.read);
    return this.balancesOf(employmentId, asOf ?? this.clock.today());
  }

  async employeeLedger(employmentId: string): Promise<{ items: LedgerView[] }> {
    const { companyId } = caller();
    await this.employeeFor(employmentId, P.read);
    const rows = await this.repo.ledger(companyId, employmentId);
    const names = await this.userRefs(rows.map((r) => r.createdBy));
    return {
      items: rows.map((r) => ({
        id: r.id,
        leaveTypeId: r.leaveTypeId,
        periodStart: r.periodStart,
        kind: r.kind,
        days: Number(r.days),
        requestId: r.requestId,
        note: r.note,
        createdBy: r.createdBy ? (names.get(r.createdBy) ?? null) : null,
        createdAt: r.createdAt,
      })),
    };
  }

  async myRequests(): Promise<{ items: LeaveRequestSummary[] }> {
    const { companyId } = caller();
    const employmentId = await this.ownEmployment();
    return { items: await this.summaries(companyId, await this.repo.requestsOf(companyId, employmentId)) };
  }

  async list(input: ListInput): Promise<LeaveRequestPage> {
    const { companyId } = caller();
    const { rows, total } = await this.repo.list(companyId, {
      scope: await this.scopes.scopeOf(P.read),
      status: input.status,
      unitId: input.unitId,
      includeSubUnits: input.includeSubUnits,
      from: input.from,
      to: input.to,
      typeId: input.typeId,
      q: input.q,
      limit: input.pageSize,
      offset: (input.page - 1) * input.pageSize,
    });
    return { items: await this.summaries(companyId, rows), total, page: input.page, pageSize: input.pageSize };
  }

  /** GET /leave/requests/:id: the requester / the employee's linked user, a current candidate, or leave.read in scope. */
  async get(id: string): Promise<LeaveRequestDetail> {
    const { companyId, userId } = caller();
    const request = await this.repo.request(companyId, id);
    if (!request) throw requestNotFound();
    const own = await this.staffing.linkedEmploymentOf(userId);
    const visible =
      own === request.employmentId ||
      request.requestedBy === userId ||
      (await this.scopes.inScope(P.read, request.orgUnitId)) ||
      (request.workflowInstanceId !== null && (await this.engine.isCandidate(request.workflowInstanceId)));
    if (!visible) throw requestNotFound();
    return this.detail(companyId, request, own === request.employmentId);
  }

  // ── preview ───────────────────────────────────────────────────────────────────────────────────────────────────

  /** POST /leave/preview: the days, the breakdown, the balance after and the 409 slugs a submit would hit. No write. */
  async preview(input: RequestInput & { employmentId?: string | undefined }): Promise<PreviewView> {
    const { companyId, userId } = caller();
    const own = await this.staffing.linkedEmploymentOf(userId);
    let employmentId: string;
    if (input.employmentId && input.employmentId !== own) {
      employmentId = (await this.employeeFor(input.employmentId, P.request)).id;
    } else {
      if (!(await this.holds(P.requestSelf))) throw new ForbiddenException();
      employmentId = await this.ownEmployment();
    }
    return problems(async () => {
      const { type, days, facts } = await this.evaluate(companyId, employmentId, input);
      let warning: string | null = null;
      try {
        checkRequest(this.rules(type), facts);
      } catch (error) {
        if (!(error instanceof LeaveRuleViolation)) throw error;
        warning = error.slug;
      }
      const holidays = await this.repo.holidays(companyId, input.startDate, input.endDate);
      const labels = new Map(holidays.map((h) => [h.date, { fr: h.nameFr, ar: h.nameAr, en: h.nameEn }]));
      return {
        days: days.days,
        breakdown: {
          calendarDays: days.breakdown.calendarDays,
          weekendDays: days.breakdown.weekendDays,
          holidays: days.breakdown.holidays.map((h) => ({ date: h.date, name: labels.get(h.date) ?? { fr: h.name, ar: h.name, en: h.name } })),
          halfDays: days.breakdown.halfDays,
        },
        balanceAfter: facts.available === null ? null : fromTenths(facts.available - facts.days),
        warnings: warning ? [warning] : [],
      };
    });
  }

  // ── requests ──────────────────────────────────────────────────────────────────────────────────────────────────

  async requestSelf(input: RequestInput): Promise<LeaveRequestDetail> {
    return this.create(await this.ownEmployment(), input);
  }

  async requestOnBehalf(employmentId: string, input: RequestInput): Promise<LeaveRequestDetail> {
    await this.employeeFor(employmentId, P.request);
    return this.create(employmentId, input);
  }

  private async create(employmentId: string, input: RequestInput): Promise<LeaveRequestDetail> {
    const { companyId, userId } = caller();
    return problems(async () => {
      const { type, days, facts } = await this.evaluate(companyId, employmentId, input);
      checkRequest(this.rules(type), facts);
      const card = (await this.staffing.cards([employmentId])).get(employmentId);
      if (!card) throw employeeNotFound();
      const id = await this.repo.insertRequest(companyId, {
        employmentId,
        leaveTypeId: type.id,
        orgUnitId: card.unit.id,
        startDate: input.startDate,
        endDate: input.endDate,
        days: String(days.days),
        halfDayStart: input.halfDayStart,
        halfDayEnd: input.halfDayEnd,
        reason: input.reason,
        documentRef: input.documentRef,
        requestedBy: userId,
      });
      const subjectUserId = (await this.staffing.linkedUsersOf([employmentId])).get(employmentId) ?? null;
      const instanceId = await this.engine.start({
        definitionId: type.workflowDefinitionId,
        subjectType: 'leave_request',
        subjectId: id,
        scopeUnitId: card.unit.id,
        subjectUserId,
      });
      await this.repo.setInstance(companyId, id, instanceId);
      // filed by someone else (HR): the employee's own user is told (the Notifier drops the actor)
      if (subjectUserId && subjectUserId !== userId) {
        await this.notifier.notify({
          type: 'leave.submitted_on_behalf',
          subject: { type: 'leave_request', id },
          data: { ...(await this.notificationData(id)), actorName: (await this.engine.displayName(userId)) || null },
          recipients: [{ userId: subjectUserId, audience: 'employee' }],
        });
      }
      const request = await this.repo.request(companyId, id);
      if (!request) throw requestNotFound();
      return this.detail(companyId, request, true);
    });
  }

  /** POST /me/leave/requests/:id/cancel: own request, pending or approved-and-not-started. */
  async cancelOwn(id: string): Promise<LeaveRequestDetail> {
    const { companyId } = caller();
    const employmentId = await this.ownEmployment();
    const request = await this.repo.request(companyId, id);
    if (!request || request.employmentId !== employmentId) throw requestNotFound();
    if (!canCancel(request.status, request.startDate, this.clock.today()) || !request.workflowInstanceId) {
      throw toProblem(new LeaveRuleViolation('leave-not-cancellable', 'Only a pending request, or an approved one that has not started, can be cancelled.'));
    }
    await problems(() => this.engine.cancel(request.workflowInstanceId ?? ''));
    const updated = await this.repo.request(companyId, id);
    if (!updated) throw requestNotFound();
    return this.detail(companyId, updated, true);
  }

  /** Type, days and the facts of the rules for a (prospective) request of `employmentId`. */
  private async evaluate(companyId: string, employmentId: string, input: RequestInput): Promise<{ type: TypeRow; days: DaysResult; facts: Parameters<typeof checkRequest>[1] }> {
    const type = await this.repo.type(companyId, input.leaveTypeId);
    if (!type) throw new ValidationProblemException([{ field: 'leaveTypeId', code: 'not_found', message: 'The leave type does not exist.' }]);
    const employment = await this.repo.employment(companyId, employmentId);
    if (!employment) throw employeeNotFound();
    const policy = await this.repo.policy(companyId);
    const holidays = input.endDate >= input.startDate ? await this.repo.holidays(companyId, input.startDate, input.endDate) : [];
    const days = computeLeaveDays({
      startDate: input.startDate,
      endDate: input.endDate,
      halfDayStart: input.halfDayStart,
      halfDayEnd: input.halfDayEnd,
      countMode: type.countMode,
      weekendDays: policy.weekendDays,
      holidays: holidays.map((h) => ({ date: h.date, name: h.nameFr })),
    });
    let available: number | null = null;
    if (type.hasBalance) {
      const periods = await this.periodsOf(companyId, employmentId, type, policy);
      const pending = (await this.repo.pendingTenths(companyId, employmentId)).get(type.id) ?? 0;
      available = availableOn(periods, input.startDate) - pending;
    }
    return {
      type,
      days,
      facts: {
        startDate: input.startDate,
        endDate: input.endDate,
        days: toTenths(days.days),
        documentRef: input.documentRef,
        employment: { hireDate: employment.hireDate, endDate: employment.endDate },
        overlaps: await this.repo.overlaps(companyId, employmentId, input.startDate, input.endDate),
        alreadyTaken: type.oncePerCareer ? await this.repo.takenByPerson(companyId, employment.personId, type.id) : false,
        available,
      },
    };
  }

  private rules(type: TypeRow) {
    return {
      active: type.active,
      hasBalance: type.hasBalance,
      maxDaysPerRequest: type.maxDaysPerRequest === null ? null : toTenths(type.maxDaysPerRequest),
      oncePerCareer: type.oncePerCareer,
      requiresDocument: type.requiresDocument,
    };
  }

  // ── workflow hooks (same transaction as the workflow change) ────────────────────────────────────────────────────

  private async resolveManager(requestId: string): Promise<ManagerCandidate> {
    const { companyId } = caller();
    const request = await this.repo.request(companyId, requestId);
    if (!request) return { userId: null, reason: 'no-manager' };
    const manager = await this.staffing.managerOf(request.employmentId, this.clock.today());
    return manager.kind === 'user' ? { userId: manager.userId } : { userId: null, reason: manager.reason };
  }

  /** Approved: status + (balance types) `taken` rows against the oldest usable years first, else 409 leave-balance. */
  private async onApproved(context: HookContext): Promise<void> {
    const { companyId } = caller();
    const request = await this.repo.request(companyId, context.subjectId);
    if (!request) throw requestNotFound();
    const type = await this.repo.type(companyId, request.leaveTypeId);
    if (type?.hasBalance) {
      const periods = await this.periodsOf(companyId, request.employmentId, type, await this.repo.policy(companyId));
      const allocation = allocateTaken(periods, request.startDate, toTenths(request.days));
      if (!allocation) {
        throw toProblem(new LeaveRuleViolation('leave-balance', 'The employee no longer has enough days for this request; adjust the balance first.'));
      }
      await this.repo.insertLedger(
        companyId,
        allocation.map((a) => ({
          employmentId: request.employmentId,
          leaveTypeId: type.id,
          periodStart: a.periodStart,
          kind: 'taken' as const,
          days: -fromTenths(a.days),
          requestId: request.id,
          createdBy: context.actorUserId,
        })),
      );
    }
    await this.repo.setStatus(companyId, request.id, 'approved');
    await this.notifyOutcome('leave.approved', request, context.actorUserId);
  }

  private async onRejected(context: HookContext): Promise<void> {
    const { companyId } = caller();
    await this.repo.setStatus(companyId, context.subjectId, 'rejected');
    const request = await this.repo.request(companyId, context.subjectId);
    if (request) await this.notifyOutcome('leave.rejected', request, context.actorUserId);
  }

  // ── notifications (docs/contracts/notifications.md › Types) ─────────────────────────────────────────────────────

  /** Names, type code, dates and days of a request — what its notifications show (no reason, no balance). */
  private async notificationData(requestId: string): Promise<NotificationData> {
    const { companyId } = caller();
    const request = await this.repo.request(companyId, requestId);
    if (!request) return { requestId };
    const [card, type] = await Promise.all([
      this.staffing.cards([request.employmentId]).then((cards) => cards.get(request.employmentId)),
      this.repo.type(companyId, request.leaveTypeId),
    ]);
    const person = card?.person;
    const arabic = person?.firstNameAr && person.lastNameAr ? `${person.firstNameAr} ${person.lastNameAr}` : null;
    return {
      requestId,
      employeeName: person ? `${person.firstName} ${person.lastName}` : null,
      employeeNameAr: arabic,
      leaveType: type?.code ?? null,
      startDate: request.startDate,
      endDate: request.endDate,
      days: Number(request.days),
    };
  }

  /** leave.approved / leave.rejected → the requester and the employee's linked user (deduplicated; never the actor). */
  private async notifyOutcome(type: NotificationType, request: RequestRow, actorUserId: string): Promise<void> {
    const employeeUser = (await this.staffing.linkedUsersOf([request.employmentId])).get(request.employmentId) ?? null;
    await this.notifier.notify({
      type,
      subject: { type: 'leave_request', id: request.id },
      data: { ...(await this.notificationData(request.id)), actorName: (await this.engine.displayName(actorUserId)) || null },
      recipients: [
        { userId: employeeUser, audience: 'employee' },
        { userId: request.requestedBy, audience: 'requester' },
      ],
    });
  }

  /** Cancelled: status + (was approved) a `reversal` row per `taken` row, same reference year. */
  private async onCancelled(context: HookContext & { wasApproved: boolean; openTaskCandidates: readonly string[] }): Promise<void> {
    const { companyId } = caller();
    const request = await this.repo.request(companyId, context.subjectId);
    if (!request) throw requestNotFound();
    if (context.wasApproved) {
      const taken = (await this.repo.ledgerOfRequest(companyId, request.id)).filter((r) => r.kind === 'taken');
      await this.repo.insertLedger(
        companyId,
        taken.map((r) => ({
          employmentId: request.employmentId,
          leaveTypeId: r.leaveTypeId,
          periodStart: r.periodStart,
          kind: 'reversal' as const,
          days: -Number(r.days),
          requestId: request.id,
          note: 'Annulation',
          createdBy: context.actorUserId,
        })),
      );
    }
    await this.repo.setStatus(companyId, request.id, 'cancelled');
    // the candidates of the task that was open learn it no longer needs them
    if (context.openTaskCandidates.length > 0) {
      await this.notifier.notify({
        type: 'leave.cancelled',
        subject: { type: 'leave_request', id: request.id },
        data: { ...(await this.notificationData(request.id)), actorName: (await this.engine.displayName(context.actorUserId)) || null },
        recipients: context.openTaskCandidates.map((userId) => ({ userId, audience: 'approver' as const })),
      });
    }
  }

  // ── adjustments and accruals ──────────────────────────────────────────────────────────────────────────────────

  async adjust(employmentId: string, input: { leaveTypeId: string; periodStart: string; days: number; note: string }): Promise<LedgerView> {
    const { companyId, userId } = caller();
    await this.employeeFor(employmentId, P.adjust);
    const type = await this.repo.type(companyId, input.leaveTypeId);
    if (!type) throw new ValidationProblemException([{ field: 'leaveTypeId', code: 'not_found', message: 'The leave type does not exist.' }]);
    if (!type.hasBalance) throw new ValidationProblemException([{ field: 'leaveTypeId', code: 'no_balance', message: 'This leave type has no balance.' }]);
    const policy = await this.repo.policy(companyId);
    if (!isPeriodStart(input.periodStart, policy.referenceStartMonth)) {
      throw new ValidationProblemException([{ field: 'periodStart', code: 'invalid', message: 'Must be the first day of a reference year.' }]);
    }
    await this.repo.insertLedger(companyId, [
      { employmentId, leaveTypeId: type.id, periodStart: input.periodStart, kind: 'adjustment', days: input.days, note: input.note, createdBy: userId },
    ]);
    const [row] = (await this.repo.ledger(companyId, employmentId)).filter((r) => r.kind === 'adjustment');
    if (!row) throw new Error('adjustment vanished');
    const names = await this.userRefs([userId]);
    return {
      id: row.id,
      leaveTypeId: row.leaveTypeId,
      periodStart: row.periodStart,
      kind: row.kind,
      days: Number(row.days),
      requestId: null,
      note: row.note,
      createdBy: names.get(userId) ?? null,
      createdAt: row.createdAt,
    };
  }

  /** POST /leave/accruals/run: the month's accruals for the employees in the caller's leave.adjust scope. */
  async runAccruals(month: string): Promise<AccrualRunResult> {
    const { companyId, userId } = caller();
    const first = parseMonth(month);
    if (!first) throw new ValidationProblemException([{ field: 'month', code: 'invalid', message: 'Must be YYYY-MM.' }]);
    const today = this.clock.today();
    if (first > monthStart(today)) {
      throw new ValidationProblemException([{ field: 'month', code: 'future', message: 'Months after the current one cannot be accrued.' }]);
    }
    const ids = (await this.scopes.coversCompany(P.adjust)) ? null : await this.repo.employmentsIn(companyId, await this.scopes.scopeOf(P.adjust), today);
    return runAccruals(currentTx(), companyId, first, { employmentIds: ids, actorUserId: userId });
  }

  // ── views ─────────────────────────────────────────────────────────────────────────────────────────────────────

  private async periodsOf(companyId: string, employmentId: string, type: TypeRow, policy: PolicyRow): Promise<PeriodBalance[]> {
    const sums = (await this.repo.sums(companyId, employmentId)).get(type.id) ?? [];
    return periodBalances(sums, type.accrualDaysPerMonth !== null, policy.entitlementDelayMonths);
  }

  private async balancesOf(employmentId: string, asOf: string, onlyTypeId?: string): Promise<BalancesView> {
    const { companyId } = caller();
    const policy = await this.repo.policy(companyId);
    const types = (await this.repo.types(companyId)).filter((t) => t.hasBalance && (!onlyTypeId || t.id === onlyTypeId));
    const sums = await this.repo.sums(companyId, employmentId);
    const pending = await this.repo.pendingTenths(companyId, employmentId);
    const items: BalanceView[] = [];
    for (const type of types) {
      let periods = periodBalances(sums.get(type.id) ?? [], type.accrualDaysPerMonth !== null, policy.entitlementDelayMonths);
      if (periods.length === 0) {
        const start = periodStartOf(asOf, policy.referenceStartMonth);
        periods = periodBalances([{ periodStart: start, accrual: 0, taken: 0, adjustment: 0, reversal: 0 }], type.accrualDaysPerMonth !== null, policy.entitlementDelayMonths);
      }
      // pending days charged to the usable years, oldest first (the rest to the latest usable year)
      let rest = pending.get(type.id) ?? 0;
      const usable = periods.filter((p) => p.availableFrom <= asOf);
      const charged = new Map<string, number>();
      for (const p of usable) {
        const take = Math.min(rest, Math.max(0, p.balance));
        charged.set(p.periodStart, take);
        rest -= take;
      }
      const last = usable.at(-1);
      if (rest > 0 && last) charged.set(last.periodStart, (charged.get(last.periodStart) ?? 0) + rest);
      for (const p of periods) {
        const pend = charged.get(p.periodStart) ?? 0;
        items.push({
          leaveTypeId: type.id,
          leaveTypeCode: type.code,
          periodStart: p.periodStart,
          periodEnd: periodEndOf(p.periodStart),
          availableFrom: p.availableFrom,
          accrued: fromTenths(p.accrued),
          taken: fromTenths(p.taken),
          adjusted: fromTenths(p.adjusted),
          balance: fromTenths(p.balance),
          pending: fromTenths(pend),
          available: p.availableFrom <= asOf ? fromTenths(p.balance - pend) : 0,
        });
      }
    }
    return { asOf, items };
  }

  private async userRefs(ids: readonly (string | null)[]): Promise<Map<string, UserRef>> {
    const out = new Map<string, UserRef>();
    for (const id of new Set(ids)) if (id) out.set(id, { id, displayName: await this.engine.displayName(id) });
    return out;
  }

  private async summaries(companyId: string, rows: readonly RequestRow[], options: { withWorkflow?: boolean } = {}): Promise<LeaveRequestSummary[]> {
    if (rows.length === 0) return [];
    const [cards, types, progress] = await Promise.all([
      this.staffing.cards(rows.map((r) => r.employmentId)),
      this.repo.types(companyId),
      options.withWorkflow === false ? Promise.resolve([]) : this.engine.progress(rows.flatMap((r) => (r.workflowInstanceId ? [r.workflowInstanceId] : []))),
    ]);
    const typeById = new Map(types.map((t) => [t.id, t]));
    const progressById = new Map(progress.map((p) => [p.instanceId, p]));
    return rows.map((r) => {
      const card = cards.get(r.employmentId);
      const type = typeById.get(r.leaveTypeId);
      const employee: LeaveEmployee = card
        ? { id: card.id, matricule: card.matricule, person: card.person, unit: card.unit }
        : { id: r.employmentId, matricule: '', person: { id: '', lastName: '', firstName: '', lastNameAr: null, firstNameAr: null }, unit: { id: r.orgUnitId, code: '', kind: '', name: '', nameAr: null } };
      return {
        id: r.id,
        employee,
        leaveTypeId: r.leaveTypeId,
        leaveType: { code: type?.code ?? '', labels: type ? labelsOf(type) : { fr: '', ar: '', en: '' } },
        startDate: r.startDate,
        endDate: r.endDate,
        days: Number(r.days),
        halfDayStart: r.halfDayStart,
        halfDayEnd: r.halfDayEnd,
        status: r.status,
        requestedAt: r.requestedAt,
        workflow: r.workflowInstanceId ? (progressById.get(r.workflowInstanceId) ?? null) : null,
      };
    });
  }

  private async detail(companyId: string, request: RequestRow, isOwner: boolean): Promise<LeaveRequestDetail> {
    const [summary] = await this.summaries(companyId, [request]);
    if (!summary) throw requestNotFound();
    const history = request.workflowInstanceId ? ((await this.engine.history([request.workflowInstanceId])).get(request.workflowInstanceId) ?? []) : [];
    const refs = await this.userRefs([request.requestedBy]);
    const balances = (await this.balancesOf(request.employmentId, request.startDate, request.leaveTypeId)).items;
    const actions: LeaveRequestAction[] = isOwner && canCancel(request.status, request.startDate, this.clock.today()) ? ['cancel'] : [];
    return {
      ...summary,
      reason: request.reason,
      documentRef: request.documentRef,
      requestedBy: refs.get(request.requestedBy) ?? null,
      history,
      balances,
      _actions: actions,
    };
  }
}
