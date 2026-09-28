import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditEvents, type AuditSubjectType } from '../../../platform/audit/audit-events.js';
import { ScopeService, type UnitIdQuery } from '../../../platform/authz/scope-service.js';
import { requireContext } from '../../../platform/context/request-context.js';
import { ProblemException, ValidationProblemException } from '../../../platform/http/problem-details.js';
import { Notifier } from '../../../platform/notifications/notifier.js';
import { excludedActors, parseSteps, progressOf, type Labels, type StepDef } from '../domain/steps.js';
import { WorkflowRepository, type InstanceRow, type TaskRow } from '../infra/workflow.repository.js';
import { WorkflowSubjects } from './workflow-subjects.js';
import type { AssigneeView, OpenTaskView, TaskActionView, TaskHistoryView, UserRef, WorkflowProgressView } from './workflow-views.js';

/** Subject types the engine drives (workflow_instance_subject_type_ck, migrations 0011 and 0014). */
export type WorkflowSubjectType = 'leave_request' | 'document_request';

export interface StartInput {
  definitionId: string;
  subjectType: WorkflowSubjectType;
  subjectId: string;
  /** the subject employee's unit: permission steps must cover it */
  scopeUnitId: string;
  /** the user the subject is about (excluded from acting), if any */
  subjectUserId: string | null;
}

export interface DefinitionView {
  id: string;
  code: string;
  names: Labels;
  isSystem: boolean;
  steps: StepDef[];
}

function caller(): { companyId: string; userId: string } {
  const { companyId, userId } = requireContext();
  if (!companyId || !userId) throw new NotFoundException();
  return { companyId, userId };
}

function taskNotFound(): NotFoundException {
  return new NotFoundException('Task not found');
}

/** The subject of an instance, as the subject of its audit events and notifications. */
function subjectOf(instance: Pick<InstanceRow, 'subjectType' | 'subjectId'>): { type: AuditSubjectType & WorkflowSubjectType; id: string } {
  const type: WorkflowSubjectType = instance.subjectType === 'document_request' ? 'document_request' : 'leave_request';
  return { type, id: instance.subjectId };
}

/**
 * The workflow engine (ADR 006): a synchronous Postgres state machine. Every call runs inside the request
 * transaction; acting on a task row-locks it (FOR UPDATE) so concurrent actors are serialised and the loser gets
 * 409 `workflow-task-closed`. Candidates of permission tasks are evaluated at READ time through ScopeService.
 */
@Injectable()
export class WorkflowEngine {
  constructor(
    private readonly repo: WorkflowRepository,
    private readonly scopes: ScopeService,
    private readonly subjects: WorkflowSubjects,
    private readonly audit: AuditEvents,
    private readonly notifier: Notifier,
  ) {}

  // ── definitions ───────────────────────────────────────────────────────────────────────────────────────────────

  async definitions(): Promise<DefinitionView[]> {
    const { companyId } = caller();
    return (await this.repo.definitions(companyId)).map((d) => ({
      id: d.id,
      code: d.code,
      names: { fr: d.nameFr, ar: d.nameAr, en: d.nameEn },
      isSystem: d.isSystem,
      steps: parseSteps(d.steps),
    }));
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────────────────────────────────────────

  async start(input: StartInput): Promise<string> {
    const { companyId, userId } = caller();
    const definition = await this.repo.definition(companyId, input.definitionId);
    if (!definition) throw new Error(`workflow definition ${input.definitionId} not found`);
    const steps = parseSteps(definition.steps);
    const instanceId = await this.repo.insertInstance(companyId, {
      definitionId: definition.id,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      startedBy: userId,
      subjectUserId: input.subjectUserId,
    });
    await this.audit.record({
      type: 'workflow.start',
      subject: { type: input.subjectType, id: input.subjectId },
      data: { instanceId, definition: definition.code },
    });
    const instance = await this.repo.instance(companyId, instanceId);
    if (!instance) throw new Error('workflow instance vanished');
    await this.openStep(companyId, instance, steps, 0, input.scopeUnitId);
    return instanceId;
  }

  /**
   * Opens step `index`. A manager step whose manager cannot act (none, no linked user, or the requester / subject
   * user themselves) is written as a SKIPPED task (outcome `escalated`, the reason as comment) and the next step
   * opens — the definition's last step is always a permission step.
   */
  private async openStep(companyId: string, instance: InstanceRow, steps: readonly StepDef[], index: number, scopeUnitId: string): Promise<void> {
    const step = steps[index];
    if (!step) throw new Error('workflow: no step to open');
    await this.repo.setInstanceStep(companyId, instance.id, index);
    const base = { instanceId: instance.id, stepKey: step.key, stepIndex: index, scopeUnitId };
    if (step.kind === 'permission') {
      const permission = step.permission ?? null;
      const taskId = await this.repo.insertTask(companyId, { ...base, assigneeKind: 'permission', assigneeUserId: null, permission });
      await this.notifyAssigned(companyId, instance, step.key, taskId, { assigneeKind: 'permission', assigneeUserId: null, permission, scopeUnitId });
      return;
    }
    const manager = await this.subjects.get(instance.subjectType).resolveManager(instance.subjectId);
    const excluded = excludedActors(instance.startedBy, instance.subjectUserId);
    if (manager.userId !== null && !excluded.has(manager.userId)) {
      const taskId = await this.repo.insertTask(companyId, { ...base, assigneeKind: 'user', assigneeUserId: manager.userId, permission: null });
      await this.notifyAssigned(companyId, instance, step.key, taskId, { assigneeKind: 'user', assigneeUserId: manager.userId, permission: null, scopeUnitId });
      return;
    }
    const reason = manager.userId === null ? manager.reason : 'manager-is-requester';
    await this.repo.insertTask(companyId, { ...base, assigneeKind: 'none', assigneeUserId: null, permission: null, escalated: { reason } });
    await this.audit.record({
      type: 'workflow.escalate',
      subject: subjectOf(instance),
      data: { instanceId: instance.id, step: step.key, reason },
    });
    // the requester is told even when they are the actor: the engine, not they, decided to skip the manager
    await this.notifier.notify({
      type: 'task.escalated',
      subject: subjectOf(instance),
      data: { ...(await this.notificationData(instance)), stepKey: step.key, escalationReason: reason },
      recipients: [{ userId: instance.startedBy, audience: instance.startedBy === instance.subjectUserId ? 'employee' : 'requester' }],
      includeActor: true,
    });
    await this.openStep(companyId, instance, steps, index + 1, scopeUnitId);
  }

  // ── notifications (docs/contracts/notifications.md › Types) ─────────────────────────────────────────────────────

  /** Subject data + the acting user's name. */
  private async notificationData(instance: InstanceRow): Promise<Record<string, string | number | null>> {
    const { userId } = caller();
    const data = await this.subjects.get(instance.subjectType).notificationData(instance.subjectId);
    return { ...data, actorName: (await this.displayName(userId)) || null };
  }

  /**
   * Candidates of a task at this moment: its assignee, or every holder of its permission over its unit (today's
   * grants) — never the requester or the subject's user (separation of duties).
   */
  private async candidatesOf(companyId: string, instance: InstanceRow, task: Pick<TaskRow, 'assigneeKind' | 'assigneeUserId' | 'permission' | 'scopeUnitId'>): Promise<string[]> {
    const excluded = excludedActors(instance.startedBy, instance.subjectUserId);
    const users =
      task.assigneeKind === 'user' && task.assigneeUserId
        ? [task.assigneeUserId]
        : task.assigneeKind === 'permission' && task.permission
          ? await this.repo.permissionHolders(companyId, task.permission, task.scopeUnitId)
          : [];
    return users.filter((u) => !excluded.has(u));
  }

  /** `task.assigned` to the new task's candidates (the actor is left out by the Notifier). */
  private async notifyAssigned(
    companyId: string,
    instance: InstanceRow,
    stepKey: string,
    taskId: string,
    task: Pick<TaskRow, 'assigneeKind' | 'assigneeUserId' | 'permission' | 'scopeUnitId'>,
  ): Promise<void> {
    const candidates = await this.candidatesOf(companyId, instance, task);
    if (candidates.length === 0) return;
    await this.notifier.notify({
      type: 'task.assigned',
      subject: { type: 'workflow_task', id: taskId },
      data: { ...(await this.notificationData(instance)), subjectType: instance.subjectType, stepKey, taskId },
      recipients: candidates.map((userId) => ({ userId, audience: 'approver' as const })),
    });
  }

  /** POST /tasks/:id/approve | reject. */
  async act(taskId: string, action: 'approve' | 'reject', comment: string | null): Promise<TaskActionView> {
    const { companyId, userId } = caller();
    if (action === 'reject' && !comment) {
      throw new ValidationProblemException([{ field: 'comment', code: 'required', message: 'A comment is required to reject.' }]);
    }
    const task = await this.repo.lockTask(companyId, taskId);
    if (!task) throw taskNotFound();
    const instance = await this.repo.instance(companyId, task.instanceId, { lock: true });
    if (!instance) throw taskNotFound();
    // not a candidate (assignee / permission over the unit) → 404 like an unknown id; the requester → 409; a task
    // already handled (e.g. by a concurrent approver who got the lock first) → 409
    if (!(await this.isCandidateByRule(task, userId))) throw taskNotFound();
    if (excludedActors(instance.startedBy, instance.subjectUserId).has(userId)) {
      throw new ProblemException(409, 'workflow-self-approval', 'You cannot act on a task of your own request.');
    }
    if (task.status !== 'open') throw new ProblemException(409, 'workflow-task-closed', 'This task has already been handled.');

    await this.repo.closeTask(companyId, task.id, { outcome: action, actedBy: userId, comment });
    const subject = this.subjects.get(instance.subjectType);
    const context = { instanceId: instance.id, subjectId: instance.subjectId, actorUserId: userId };
    await this.audit.record({
      type: `workflow.${action}`,
      subject: subjectOf(instance),
      data: { instanceId: instance.id, taskId: task.id, step: task.stepKey, ...(comment ? { comment } : {}) },
    });
    const steps = await this.stepsOf(companyId, instance.definitionId);
    if (action === 'reject') {
      await this.repo.finishInstance(companyId, instance.id, 'rejected');
      await subject.onRejected(context);
    } else if (task.stepIndex + 1 < steps.length) {
      await this.openStep(companyId, instance, steps, task.stepIndex + 1, task.scopeUnitId);
    } else {
      await this.repo.finishInstance(companyId, instance.id, 'approved');
      await subject.onApproved(context);
    }
    const [progress] = await this.progress([instance.id]);
    const history = (await this.history([instance.id])).get(instance.id) ?? [];
    if (!progress) throw new Error('workflow instance vanished');
    return { taskId: task.id, outcome: action, workflow: progress, history };
  }

  /** Cancels a pending (open task → cancelled) or approved instance; calls the subject's onCancelled. */
  async cancel(instanceId: string): Promise<void> {
    const { companyId, userId } = caller();
    const instance = await this.repo.instance(companyId, instanceId, { lock: true });
    if (!instance) throw new NotFoundException();
    if (instance.status !== 'pending' && instance.status !== 'approved') {
      const slug = instance.subjectType === 'document_request' ? 'document-request-not-cancellable' : 'leave-not-cancellable';
      throw new ProblemException(409, slug, 'This request can no longer be cancelled.');
    }
    const openTaskCandidates: string[] = [];
    for (const task of await this.repo.openTasks(companyId, instance.id)) openTaskCandidates.push(...(await this.candidatesOf(companyId, instance, task)));
    await this.repo.cancelOpenTasks(companyId, instance.id);
    await this.repo.finishInstance(companyId, instance.id, 'cancelled');
    await this.audit.record({
      type: 'workflow.cancel',
      subject: subjectOf(instance),
      data: { instanceId: instance.id, wasApproved: instance.status === 'approved' },
    });
    await this.subjects.get(instance.subjectType).onCancelled({
      instanceId: instance.id,
      subjectId: instance.subjectId,
      actorUserId: userId,
      wasApproved: instance.status === 'approved',
      openTaskCandidates,
    });
  }

  // ── candidates ────────────────────────────────────────────────────────────────────────────────────────────────

  /** Assignee, or holder of the task's permission over its unit (today's grants) — ignoring separation of duties. */
  private async isCandidateByRule(task: TaskRow, userId: string): Promise<boolean> {
    if (task.assigneeKind === 'user') return task.assigneeUserId === userId;
    if (task.assigneeKind === 'permission' && task.permission) return this.scopes.inScope(task.permission, task.scopeUnitId);
    return false;
  }

  private async candidateScopes(companyId: string): Promise<Map<string, UnitIdQuery>> {
    const scopes = new Map<string, UnitIdQuery>();
    for (const permission of await this.repo.openTaskPermissions(companyId)) scopes.set(permission, await this.scopes.scopeOf(permission));
    return scopes;
  }

  /** True when the caller is a current candidate of an open task of the instance (SoD applied). */
  async isCandidate(instanceId: string): Promise<boolean> {
    const { companyId, userId } = caller();
    const tasks = await this.repo.candidateTasks(companyId, userId, await this.candidateScopes(companyId), { instanceId });
    return tasks.length > 0;
  }

  /** GET /tasks?status=open — "My tasks". */
  async myTasks(): Promise<{ items: OpenTaskView[] }> {
    const { companyId, userId } = caller();
    const tasks = await this.repo.candidateTasks(companyId, userId, await this.candidateScopes(companyId));
    const instances = new Map((await this.repo.instances(companyId, tasks.map((t) => t.instanceId))).map((i) => [i.id, i]));
    const allTasks = await this.repo.tasksOf(companyId, [...instances.keys()]);
    const escalatedInstances = new Set(allTasks.filter((t) => t.outcome === 'escalated').map((t) => t.instanceId));
    const defs = new Map((await this.repo.definitions(companyId)).map((d) => [d.id, parseSteps(d.steps)]));
    const bySubjectType = new Map<string, string[]>();
    for (const instance of instances.values()) bySubjectType.set(instance.subjectType, [...(bySubjectType.get(instance.subjectType) ?? []), instance.subjectId]);
    const summaries = new Map<string, Record<string, unknown>>();
    for (const [type, ids] of bySubjectType) for (const [id, s] of await this.subjects.get(type).summaries(ids)) summaries.set(`${type}:${id}`, s);
    const items: OpenTaskView[] = [];
    for (const task of tasks) {
      const instance = instances.get(task.instanceId);
      const step = instance ? defs.get(instance.definitionId)?.[task.stepIndex] : undefined;
      const summary = instance ? summaries.get(`${instance.subjectType}:${instance.subjectId}`) : undefined;
      if (!instance || !step || !summary) continue;
      items.push({
        id: task.id,
        instanceId: instance.id,
        stepKey: task.stepKey,
        stepIndex: task.stepIndex,
        stepLabels: step.labels,
        escalated: escalatedInstances.has(instance.id),
        createdAt: task.createdAt,
        subject: { ...summary, type: instance.subjectType, id: instance.subjectId },
      });
    }
    return { items };
  }

  // ── views ─────────────────────────────────────────────────────────────────────────────────────────────────────

  private async stepsOf(companyId: string, definitionId: string): Promise<StepDef[]> {
    const definition = await this.repo.definition(companyId, definitionId);
    if (!definition) throw new Error(`workflow definition ${definitionId} not found`);
    return parseSteps(definition.steps);
  }

  /** Progress of instances (step states), by instance id. */
  async progress(instanceIds: readonly string[]): Promise<WorkflowProgressView[]> {
    const { companyId } = caller();
    const instances = await this.repo.instances(companyId, instanceIds);
    const tasks = await this.repo.tasksOf(companyId, instances.map((i) => i.id));
    const defs = new Map((await this.repo.definitions(companyId)).map((d) => [d.id, parseSteps(d.steps)]));
    return instances.map((instance) => {
      const steps = defs.get(instance.definitionId) ?? [];
      const states = progressOf(steps, tasks.filter((t) => t.instanceId === instance.id), instance.status);
      return {
        instanceId: instance.id,
        status: instance.status,
        currentStep: instance.status === 'pending' ? instance.currentStep : null,
        steps: steps.map((s, i) => ({ ...s, state: states[i]?.state ?? 'pending' })),
      };
    });
  }

  /** Task history per instance, oldest first, with display names. */
  async history(instanceIds: readonly string[]): Promise<Map<string, TaskHistoryView[]>> {
    const { companyId } = caller();
    const tasks = await this.repo.tasksOf(companyId, instanceIds);
    const names = await this.repo.names(companyId);
    const ref = (id: string | null): UserRef | null => (id ? { id, displayName: names.get(id) ?? '' } : null);
    const out = new Map<string, TaskHistoryView[]>();
    for (const t of tasks) {
      const assignee: AssigneeView =
        t.assigneeKind === 'user' && t.assigneeUserId
          ? { kind: 'user', user: ref(t.assigneeUserId) ?? { id: t.assigneeUserId, displayName: '' } }
          : t.assigneeKind === 'permission' && t.permission
            ? { kind: 'permission', permission: t.permission }
            : { kind: 'none' };
      out.set(t.instanceId, [
        ...(out.get(t.instanceId) ?? []),
        {
          id: t.id,
          stepKey: t.stepKey,
          stepIndex: t.stepIndex,
          assignee,
          status: t.status,
          outcome: t.outcome,
          actedBy: ref(t.actedBy),
          actedAt: t.actedAt,
          comment: t.comment,
          createdAt: t.createdAt,
        },
      ]);
    }
    return out;
  }

  /** Display name of a member (empty when unknown). */
  async displayName(userId: string): Promise<string> {
    const { companyId } = caller();
    return (await this.repo.names(companyId)).get(userId) ?? '';
  }
}
