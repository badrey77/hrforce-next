import { Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { ScopeService } from '../../../platform/authz/scope-service.js';
import { ProblemException, ValidationProblemException } from '../../../platform/http/problem-details.js';
import { Notifier, type NotificationData, type NotificationType } from '../../../platform/notifications/notifier.js';
import { StaffingService } from '../../staffing/index.js';
import { WorkflowEngine, WorkflowSubjects, type HookContext, type ManagerCandidate, type TaskHistoryView } from '../../workflow/index.js';
import { checkCorrectionRequest, type ChangeInput } from '../domain/corrections.js';
import { algiersTime, minDate, maxDate } from '../domain/time.js';
import { AttendanceRepository, type EmploymentFacts } from '../infra/attendance.repository.js';
import { constraintOf, CorrectionsRepository, type CorrectionItemRow, type CorrectionRow, type CorrectionStatus } from '../infra/corrections.repository.js';
import { SchedulesRepository } from '../infra/schedules.repository.js';
import { AttendanceClock } from './attendance-clock.js';
import type { CorrectionChangeView, CorrectionDetailView, CorrectionPage, CorrectionView, UserRef } from './attendance-views.js';
import { employeeRefOn, PresenceEngine } from './presence-engine.js';
import { ATTENDANCE_PERMISSIONS as P, caller, notLinked, PresenceService } from './presence.service.js';

export interface CorrectionRequestInput {
  date: string;
  reason: string;
  changes: ChangeInput[];
}

export interface CorrectionListInput {
  status?: CorrectionStatus | undefined;
  unitId?: string | undefined;
  includeSubUnits: boolean;
  employmentId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  q?: string | undefined;
  page: number;
  pageSize: number;
}

const SUBJECT = 'attendance_correction' as const;
const correctionNotFound = () => new NotFoundException('Correction not found');
const pending = () => new ProblemException(409, 'attendance-correction-pending', 'You already have a pending correction for this day.');

/**
 * Punch corrections (docs/contracts/attendance.md › Phase B): the employee asks, for one day of the last
 * `correction_max_age_days`, for 1–4 changes (add a punch / void a live punch of that day); the request goes through
 * the workflow engine (subject type `attendance_correction`, chain = the policy's `attendance.manager_then_hr` — the
 * unit head then HR holding attendance.manage over the employee's unit — or `attendance.hr_only`). The final approval
 * inserts `source='correction'` punches and voids the targets IN THE APPROVAL TRANSACTION (never editing a punch in
 * place); a target voided meanwhile makes the approval fail (409 attendance-correction-stale, everything rolled back).
 * Also: the HR list and detail, the subject hooks, the notifications correction_approved / correction_rejected.
 */
@Injectable()
export class CorrectionsService implements OnModuleInit {
  constructor(
    private readonly repo: CorrectionsRepository,
    private readonly people: AttendanceRepository,
    private readonly schedules: SchedulesRepository,
    private readonly engine: PresenceEngine,
    private readonly presence: PresenceService,
    private readonly scopes: ScopeService,
    private readonly staffing: StaffingService,
    private readonly workflow: WorkflowEngine,
    private readonly subjects: WorkflowSubjects,
    private readonly notifier: Notifier,
    private readonly clock: AttendanceClock,
  ) {}

  onModuleInit(): void {
    this.subjects.register(SUBJECT, {
      resolveManager: (id) => this.resolveManager(id),
      onApproved: (c) => this.onApproved(c),
      onRejected: (c) => this.onRejected(c),
      onCancelled: (c) => this.onCancelled(c),
      summaries: (ids) => this.summaries(ids),
      notificationData: (id) => this.notificationData(id),
    });
  }

  private async ownEmployment(): Promise<string> {
    const { companyId, userId } = caller();
    const employmentId = await this.people.linkedEmployment(companyId, userId);
    if (!employmentId) throw notLinked();
    return employmentId;
  }

  // ── self-service ────────────────────────────────────────────────────────────────────────────────────────────────

  /** POST /me/attendance/corrections → 201 CorrectionView. */
  async request(input: CorrectionRequestInput): Promise<CorrectionView> {
    const { companyId, userId } = caller();
    const employmentId = await this.ownEmployment();
    const today = this.clock.today();
    const [employment] = await this.people.employments(companyId, [employmentId]);
    if (!employment) throw notLinked();
    const policy = await this.schedules.policy(companyId);
    const dayPunches = await this.people.punches(companyId, [employmentId], input.date, input.date);
    const check = checkCorrectionRequest({
      date: input.date,
      today,
      nowMs: this.clock.nowMs(),
      maxAgeDays: policy.correctionMaxAgeDays,
      employment,
      changes: input.changes,
      dayPunches: dayPunches.map((p) => ({ id: p.id, status: p.status, occurredAtMs: p.occurredAt.getTime() })),
    });
    if (!check.ok && check.kind === 'date') {
      throw new ProblemException(409, 'attendance-correction-date', `A correction can be asked for a day of your employment, from ${policy.correctionMaxAgeDays} days ago to today.`, [
        { field: 'date', code: 'out_of_window', message: `From ${policy.correctionMaxAgeDays} days ago to today, inside the employment.` },
      ]);
    }
    if (!check.ok) throw new ValidationProblemException(check.kind === 'invalid' ? check.errors : []);
    if (await this.repo.pendingExists(companyId, employmentId, input.date)) throw pending();
    const orgUnitId = await this.people.scopeUnit(companyId, employmentId, today);
    if (!orgUnitId) throw notLinked();
    const definitionId = await this.repo.definitionId(companyId, policy.correctionWorkflowCode);
    if (!definitionId) throw new Error(`workflow definition ${policy.correctionWorkflowCode} missing`);
    let id: string;
    try {
      id = await this.repo.insert(
        companyId,
        { employmentId, orgUnitId, workDate: input.date, reason: input.reason, requestedBy: userId },
        check.changes.map((c) => ({ position: c.position, action: c.action, direction: c.direction, occurredAt: c.occurredAtMs === null ? null : new Date(c.occurredAtMs), punchId: c.punchId })),
      );
    } catch (error) {
      if (constraintOf(error) === 'attendance_correction_one_pending_uk') throw pending();
      throw error;
    }
    const instanceId = await this.workflow.start({ definitionId, subjectType: SUBJECT, subjectId: id, scopeUnitId: orgUnitId, subjectUserId: userId });
    await this.repo.setInstance(companyId, id, instanceId);
    return this.one(companyId, id, { own: true });
  }

  /** GET /me/attendance/corrections?status= → newest first. */
  async mine(status?: CorrectionStatus): Promise<{ items: CorrectionView[] }> {
    const { companyId } = caller();
    const employmentId = await this.ownEmployment();
    return { items: await this.views(companyId, await this.repo.ofEmployment(companyId, employmentId, status), { own: true }) };
  }

  /** POST /me/attendance/corrections/:id/cancel: own and pending only. */
  async cancelOwn(id: string): Promise<CorrectionView> {
    const { companyId, userId } = caller();
    const employmentId = await this.ownEmployment();
    const row = await this.repo.get(companyId, id);
    if (!row || row.employmentId !== employmentId || row.requestedBy !== userId) throw correctionNotFound();
    if (row.status !== 'pending' || !row.workflowInstanceId) {
      throw new ProblemException(409, 'attendance-correction-not-cancellable', 'Only a pending correction can be cancelled.');
    }
    await this.workflow.cancel(row.workflowInstanceId);
    return this.one(companyId, id, { own: true });
  }

  // ── HR ──────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** GET /attendance/corrections: scoped by the employee's scope unit today (attendance.read). */
  async list(input: CorrectionListInput): Promise<CorrectionPage> {
    const { companyId } = caller();
    const today = this.clock.today();
    let units: string[] | undefined;
    if (input.unitId) units = input.includeSubUnits ? [...(await this.engine.orgBook(companyId)).subtree([input.unitId], today)] : [input.unitId];
    const { rows, total } = await this.repo.list(companyId, {
      scope: await this.scopes.scopeOf(P.read),
      today,
      status: input.status,
      units,
      employmentId: input.employmentId,
      from: input.from,
      to: input.to,
      q: input.q,
      limit: input.pageSize,
      offset: (input.page - 1) * input.pageSize,
    });
    return { items: await this.views(companyId, rows, { own: false }), total, page: input.page, pageSize: input.pageSize };
  }

  /**
   * GET /attendance/corrections/:id: the employee's linked user, a current candidate of its open task, or
   * attendance.read over the employee (scope unit today); anyone else → 404. + history + the day as computed now.
   */
  async detail(id: string): Promise<CorrectionDetailView> {
    const { companyId } = caller();
    const row = await this.repo.get(companyId, id);
    if (!row) throw correctionNotFound();
    const own = (await this.people.linkedEmployment(companyId, caller().userId)) === row.employmentId;
    const unitId = await this.people.scopeUnit(companyId, row.employmentId, this.clock.today());
    const readable = unitId !== undefined && (await this.scopes.inScope(P.read, unitId));
    const candidate = !own && !readable && row.workflowInstanceId !== null && (await this.workflow.isCandidate(row.workflowInstanceId));
    if (!own && !readable && !candidate) throw correctionNotFound();
    const [view] = await this.views(companyId, [row], { own });
    if (!view) throw correctionNotFound();
    const history = row.workflowInstanceId ? ((await this.workflow.history([row.workflowInstanceId])).get(row.workflowInstanceId) ?? []) : [];
    const data = await this.engine.load(companyId, [row.employmentId], row.workDate, row.workDate);
    const e = data.employment(row.employmentId);
    if (!e) throw correctionNotFound();
    // shared_device only for attendance.manage over the employee (never on one's own day)
    const canManage = !own && unitId !== undefined && (await this.presence.canManage(row.employmentId, unitId));
    const day = data.day(e, row.workDate, { canManage, withPunches: true }).view;
    day.punches = (day.punches ?? []).map((p) => ({ ...p, _actions: [] }));
    return { ...view, history, day };
  }

  // ── views ───────────────────────────────────────────────────────────────────────────────────────────────────────

  private async one(companyId: string, id: string, options: { own: boolean }): Promise<CorrectionView> {
    const row = await this.repo.get(companyId, id);
    if (!row) throw correctionNotFound();
    const [view] = await this.views(companyId, [row], options);
    if (!view) throw correctionNotFound();
    return view;
  }

  private async changeViews(companyId: string, items: readonly CorrectionItemRow[]): Promise<Map<string, CorrectionChangeView[]>> {
    const targets = new Map((await this.people.punchesByIds(companyId, items.flatMap((i) => (i.punchId ? [i.punchId] : [])))).map((p) => [p.id, p]));
    const out = new Map<string, CorrectionChangeView[]>();
    for (const i of items) {
      const target = i.punchId ? targets.get(i.punchId) : undefined;
      out.set(i.correctionId, [
        ...(out.get(i.correctionId) ?? []),
        {
          position: i.position,
          action: i.action,
          direction: i.action === 'add' ? i.direction : null,
          time: i.occurredAt ? algiersTime(i.occurredAt.getTime()) : null,
          punch: target ? { id: target.id, direction: target.direction, localTime: algiersTime(target.occurredAt.getTime()) } : null,
          resultPunchId: i.resultPunchId,
        },
      ]);
    }
    return out;
  }

  private async views(companyId: string, rows: readonly CorrectionRow[], options: { own: boolean; withWorkflow?: boolean }): Promise<CorrectionView[]> {
    if (rows.length === 0) return [];
    const { userId } = caller();
    const instanceIds = rows.flatMap((r) => (r.workflowInstanceId ? [r.workflowInstanceId] : []));
    const withWorkflow = options.withWorkflow !== false;
    const [items, facts, org, members, progress, history] = await Promise.all([
      this.repo.items(companyId, rows.map((r) => r.id)),
      this.people.employments(companyId, [...new Set(rows.map((r) => r.employmentId))]),
      this.engine.orgBook(companyId),
      this.people.members(companyId),
      withWorkflow ? this.workflow.progress(instanceIds) : Promise.resolve([]),
      withWorkflow ? this.workflow.history(instanceIds) : Promise.resolve(new Map<string, TaskHistoryView[]>()),
    ]);
    const changes = await this.changeViews(companyId, items);
    const byEmployment = new Map(facts.map((e) => [e.id, e]));
    const progressById = new Map(progress.map((p) => [p.instanceId, p]));
    const ref = (id: string): UserRef => ({ id, displayName: members.get(id) ?? id });
    return rows.flatMap((r) => {
      const e = byEmployment.get(r.employmentId);
      if (!e) return [];
      const rejection = r.workflowInstanceId ? (history.get(r.workflowInstanceId) ?? []).find((t) => t.outcome === 'reject') : undefined;
      return [
        {
          id: r.id,
          date: r.workDate,
          reason: r.reason,
          status: r.status,
          requestedAt: r.requestedAt.toISOString(),
          requestedBy: ref(r.requestedBy),
          employee: employeeRefOn(org, e, r.workDate),
          changes: changes.get(r.id) ?? [],
          workflow: r.workflowInstanceId ? (progressById.get(r.workflowInstanceId) ?? null) : null,
          rejectionComment: rejection?.comment ?? null,
          _actions: options.own && r.status === 'pending' && r.requestedBy === userId ? ['cancel' as const] : [],
        },
      ];
    });
  }

  // ── workflow hooks (inside the request transaction that changes the workflow) ───────────────────────────────────

  private async resolveManager(id: string): Promise<ManagerCandidate> {
    const { companyId } = caller();
    const row = await this.repo.get(companyId, id);
    if (!row) return { userId: null, reason: 'no-manager' };
    const manager = await this.staffing.managerOf(row.employmentId, this.clock.today());
    return manager.kind === 'user' ? { userId: manager.userId } : { userId: null, reason: manager.reason };
  }

  /**
   * Final approval: in position order, `add` inserts a punch (source `correction`, the requested direction and instant,
   * created_by = the approver, site = the employee's effective site that day) and records it on the item; `void` voids
   * the target (voided_by = the approver, void_reason = the correction's reason, void_correction_id). A target no
   * longer live → 409 attendance-correction-stale: the whole approval rolls back.
   */
  private async onApproved(context: HookContext): Promise<void> {
    const { companyId } = caller();
    const row = await this.repo.get(companyId, context.subjectId, { lock: true });
    if (!row) throw correctionNotFound();
    await this.people.lockEmployment(companyId, row.employmentId);
    const data = await this.engine.load(companyId, [row.employmentId], row.workDate, row.workDate);
    const e = data.employment(row.employmentId);
    const siteId = e ? (data.placement(e, row.workDate)?.siteId ?? null) : null;
    for (const item of (await this.repo.items(companyId, [row.id])).toSorted((a, b) => a.position - b.position)) {
      if (item.action === 'add' && item.direction && item.occurredAt) {
        const punchId = await this.people.insertPunch(companyId, {
          employmentId: row.employmentId,
          direction: item.direction,
          occurredAt: item.occurredAt,
          source: 'correction',
          deviceId: null,
          qrWindow: null,
          siteId,
          deviceRef: null,
          reason: null,
          createdBy: context.actorUserId,
          correctionId: row.id,
        });
        await this.repo.setResultPunch(companyId, item.id, punchId);
      } else if (item.action === 'void' && item.punchId) {
        const target = await this.people.punch(companyId, item.punchId, { lock: true });
        if (!target || target.status !== 'live' || target.employmentId !== row.employmentId) {
          throw new ProblemException(409, 'attendance-correction-stale', 'A punch this correction voids is no longer live: reject the correction instead.');
        }
        await this.people.voidPunch(companyId, item.punchId, context.actorUserId, row.reason, row.id);
      }
    }
    await this.repo.setStatus(companyId, row.id, 'approved');
    await this.notifyOutcome('attendance.correction_approved', row, context.actorUserId);
  }

  private async onRejected(context: HookContext): Promise<void> {
    const { companyId } = caller();
    await this.repo.setStatus(companyId, context.subjectId, 'rejected');
    const row = await this.repo.get(companyId, context.subjectId);
    if (row) await this.notifyOutcome('attendance.correction_rejected', row, context.actorUserId);
  }

  private async onCancelled(context: HookContext): Promise<void> {
    const { companyId } = caller();
    await this.repo.setStatus(companyId, context.subjectId, 'cancelled');
  }

  /** The employee's linked user (never the actor: the Notifier drops them). */
  private async notifyOutcome(type: NotificationType, row: CorrectionRow, actorUserId: string): Promise<void> {
    const { companyId } = caller();
    const employeeUser = (await this.people.linkedUsers(companyId, [row.employmentId])).get(row.employmentId) ?? null;
    await this.notifier.notify({
      type,
      subject: { type: SUBJECT, id: row.id },
      data: { ...(await this.notificationData(row.id)), actorName: (await this.workflow.displayName(actorUserId)) || null },
      recipients: [{ userId: employeeUser, audience: 'employee' }],
    });
  }

  /** "My tasks": {type, employee, date, reason, changes, day: {status, arrival, departure}}; {type, purged: true} once purged. */
  private async summaries(ids: readonly string[]): Promise<Map<string, Record<string, unknown>>> {
    const { companyId } = caller();
    const rows = await this.repo.many(companyId, ids);
    const out = new Map<string, Record<string, unknown>>(ids.map((id) => [id, { type: SUBJECT, purged: true }]));
    if (rows.length === 0) return out;
    const views = new Map((await this.views(companyId, rows, { own: false, withWorkflow: false })).map((v) => [v.id, v]));
    const from = rows.map((r) => r.workDate).reduce(minDate);
    const to = rows.map((r) => r.workDate).reduce(maxDate);
    const data = await this.engine.load(companyId, [...new Set(rows.map((r) => r.employmentId))], from, to);
    for (const r of rows) {
      const view = views.get(r.id);
      const e: EmploymentFacts | undefined = data.employment(r.employmentId);
      if (!view || !e) continue;
      const day = data.day(e, r.workDate, { canManage: false, withPunches: false }).view;
      out.set(r.id, {
        type: SUBJECT,
        employee: view.employee,
        date: r.workDate,
        reason: r.reason,
        changes: view.changes,
        day: { status: day.status, arrival: day.arrival, departure: day.departure },
      });
    }
    return out;
  }

  /** Names, the day and the number of changes — never the reason or the times. */
  private async notificationData(id: string): Promise<NotificationData> {
    const { companyId } = caller();
    const row = await this.repo.get(companyId, id);
    if (!row) return { correctionId: id };
    const [e] = await this.people.employments(companyId, [row.employmentId]);
    const items = await this.repo.items(companyId, [row.id]);
    return {
      correctionId: id,
      employeeName: e ? `${e.firstName} ${e.lastName}` : null,
      employeeNameAr: e?.firstNameAr && e.lastNameAr ? `${e.firstNameAr} ${e.lastNameAr}` : null,
      date: row.workDate,
      changes: items.length,
    };
  }
}

