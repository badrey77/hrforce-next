import { Injectable } from '@nestjs/common';
import { sql, type RawBuilder } from 'kysely';
import type { UnitIdQuery } from '../../../platform/authz/scope-service.js';
import { currentTx } from '../../../platform/context/request-context.js';
import { requestMemo } from '../../../platform/context/request-memo.js';
import type { InstanceStatus, TaskOutcome, TaskStatus } from '../domain/steps.js';

export interface DefinitionRow {
  id: string;
  code: string;
  nameFr: string;
  nameAr: string;
  nameEn: string;
  steps: unknown;
  isSystem: boolean;
}

export interface InstanceRow {
  id: string;
  definitionId: string;
  subjectType: string;
  subjectId: string;
  status: InstanceStatus;
  currentStep: number;
  startedBy: string;
  subjectUserId: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface TaskRow {
  id: string;
  instanceId: string;
  stepKey: string;
  stepIndex: number;
  assigneeKind: 'user' | 'permission' | 'none';
  assigneeUserId: string | null;
  permission: string | null;
  scopeUnitId: string;
  status: TaskStatus;
  outcome: TaskOutcome | null;
  actedBy: string | null;
  actedAt: string | null;
  comment: string | null;
  createdAt: string;
}

export interface NewTask {
  instanceId: string;
  stepKey: string;
  stepIndex: number;
  assigneeKind: 'user' | 'permission' | 'none';
  assigneeUserId: string | null;
  permission: string | null;
  scopeUnitId: string;
  /** skipped (escalated) tasks are written closed */
  escalated?: { reason: string };
}

const TASK_COLUMNS = sql`t.id, t.instance_id as "instanceId", t.step_key as "stepKey", t.step_index as "stepIndex",
  t.assignee_kind as "assigneeKind", t.assignee_user_id as "assigneeUserId", t.permission, t.scope_unit_id as "scopeUnitId",
  t.status, t.outcome, t.acted_by as "actedBy", to_char(t.acted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "actedAt",
  t.comment, to_char(t.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt"`;

const INSTANCE_COLUMNS = sql`i.id, i.definition_id as "definitionId", i.subject_type as "subjectType", i.subject_id as "subjectId",
  i.status, i.current_step as "currentStep", i.started_by as "startedBy", i.subject_user_id as "subjectUserId",
  to_char(i.started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "startedAt",
  to_char(i.finished_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "finishedAt"`;

/** Workflow definitions, instances and tasks — through the request transaction, always filtered by company. */
@Injectable()
export class WorkflowRepository {
  async definitions(companyId: string): Promise<DefinitionRow[]> {
    const { rows } = await sql<DefinitionRow>`
      select id, code, name_fr as "nameFr", name_ar as "nameAr", name_en as "nameEn", steps, is_system as "isSystem"
        from workflow_definition where company_id = ${companyId}::uuid order by code`.execute(currentTx());
    return rows;
  }

  async definition(companyId: string, id: string): Promise<DefinitionRow | undefined> {
    return (await this.definitions(companyId)).find((d) => d.id === id);
  }

  async insertInstance(companyId: string, input: { definitionId: string; subjectType: string; subjectId: string; startedBy: string; subjectUserId: string | null }): Promise<string> {
    const row = await currentTx()
      .insertInto('workflow_instance')
      .values({
        company_id: companyId,
        definition_id: input.definitionId,
        subject_type: input.subjectType,
        subject_id: input.subjectId,
        started_by: input.startedBy,
        subject_user_id: input.subjectUserId,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async instance(companyId: string, id: string, options: { lock?: boolean } = {}): Promise<InstanceRow | undefined> {
    const lock = options.lock ? sql`for update` : sql``;
    const { rows } = await sql<InstanceRow>`select ${INSTANCE_COLUMNS} from workflow_instance i
      where i.company_id = ${companyId}::uuid and i.id = ${id}::uuid ${lock}`.execute(currentTx());
    return rows[0];
  }

  async instances(companyId: string, ids: readonly string[]): Promise<InstanceRow[]> {
    if (ids.length === 0) return [];
    const { rows } = await sql<InstanceRow>`select ${INSTANCE_COLUMNS} from workflow_instance i
      where i.company_id = ${companyId}::uuid and i.id = any(${[...ids]}::uuid[])`.execute(currentTx());
    return rows;
  }

  async setInstanceStep(companyId: string, id: string, step: number): Promise<void> {
    await currentTx().updateTable('workflow_instance').set({ current_step: step }).where('company_id', '=', companyId).where('id', '=', id).execute();
  }

  async finishInstance(companyId: string, id: string, status: Exclude<InstanceStatus, 'pending'>): Promise<void> {
    await sql`update workflow_instance set status = ${status}, finished_at = coalesce(finished_at, now())
               where company_id = ${companyId}::uuid and id = ${id}::uuid`.execute(currentTx());
  }

  async insertTask(companyId: string, task: NewTask): Promise<string> {
    const row = await currentTx()
      .insertInto('workflow_task')
      .values({
        company_id: companyId,
        instance_id: task.instanceId,
        step_key: task.stepKey,
        step_index: task.stepIndex,
        assignee_kind: task.assigneeKind,
        assignee_user_id: task.assigneeUserId,
        permission: task.permission,
        scope_unit_id: task.scopeUnitId,
        ...(task.escalated ? { status: 'skipped', outcome: 'escalated', comment: task.escalated.reason } : {}),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  /** The task, row-locked (FOR UPDATE) for the rest of the transaction: concurrent actors queue here. */
  async lockTask(companyId: string, id: string): Promise<TaskRow | undefined> {
    const { rows } = await sql<TaskRow>`select ${TASK_COLUMNS} from workflow_task t
      where t.company_id = ${companyId}::uuid and t.id = ${id}::uuid for update`.execute(currentTx());
    return rows[0];
  }

  async closeTask(companyId: string, id: string, input: { outcome: 'approve' | 'reject'; actedBy: string; comment: string | null }): Promise<void> {
    await sql`update workflow_task set status = 'done', outcome = ${input.outcome}, acted_by = ${input.actedBy}::uuid, acted_at = now(),
                     comment = ${input.comment}
               where company_id = ${companyId}::uuid and id = ${id}::uuid and status = 'open'`.execute(currentTx());
  }

  async cancelOpenTasks(companyId: string, instanceId: string): Promise<void> {
    await sql`update workflow_task set status = 'cancelled'
               where company_id = ${companyId}::uuid and instance_id = ${instanceId}::uuid and status = 'open'`.execute(currentTx());
  }

  async tasksOf(companyId: string, instanceIds: readonly string[]): Promise<TaskRow[]> {
    if (instanceIds.length === 0) return [];
    const { rows } = await sql<TaskRow>`select ${TASK_COLUMNS} from workflow_task t
      where t.company_id = ${companyId}::uuid and t.instance_id = any(${[...instanceIds]}::uuid[])
      order by t.step_index, t.created_at, t.id`.execute(currentTx());
    return rows;
  }

  /** Permissions of the open permission tasks of the company (to build one scope filter per permission). */
  async openTaskPermissions(companyId: string): Promise<string[]> {
    const { rows } = await sql<{ permission: string }>`select distinct t.permission from workflow_task t
      where t.company_id = ${companyId}::uuid and t.status = 'open' and t.assignee_kind = 'permission'`.execute(currentTx());
    return rows.map((r) => r.permission);
  }

  /**
   * Open tasks whose candidates include `userId` (READ time): assigned to them, or a permission task whose unit is in
   * their scope of that permission — never on an instance they started or are the subject of (separation of duties).
   */
  async candidateTasks(companyId: string, userId: string, scopes: ReadonlyMap<string, UnitIdQuery>, filter?: { taskId?: string; instanceId?: string }): Promise<TaskRow[]> {
    const byPermission: RawBuilder<unknown>[] = [...scopes].map(([permission, scope]) => sql`(t.permission = ${permission} and t.scope_unit_id in (${scope}))`);
    const candidate = sql`(t.assignee_kind = 'user' and t.assignee_user_id = ${userId}::uuid)${
      byPermission.length ? sql` or (t.assignee_kind = 'permission' and (${sql.join(byPermission, sql` or `)}))` : sql``
    }`;
    const byTask = filter?.taskId ? sql`and t.id = ${filter.taskId}::uuid` : sql``;
    const byInstance = filter?.instanceId ? sql`and t.instance_id = ${filter.instanceId}::uuid` : sql``;
    const { rows } = await sql<TaskRow>`select ${TASK_COLUMNS} from workflow_task t
      join workflow_instance i on i.company_id = t.company_id and i.id = t.instance_id
      where t.company_id = ${companyId}::uuid and t.status = 'open'
        and (${candidate})
        and i.started_by <> ${userId}::uuid and i.subject_user_id is distinct from ${userId}::uuid
        ${byTask} ${byInstance}
      order by t.created_at, t.id`.execute(currentTx());
    return rows;
  }

  /**
   * Users holding `permission` over `unitId` today (grants valid today whose role holds it, on the unit or on an
   * ancestor with include_descendants — the same rule as the grant-backed ScopeService, seen from the unit). The
   * candidates of a permission task at the moment it opens / is cancelled (notifications).
   */
  async permissionHolders(companyId: string, permission: string, unitId: string): Promise<string[]> {
    const { rows } = await sql<{ user_id: string }>`
      select distinct g.user_id
        from role_grant g
        join role_permission rp on rp.company_id = g.company_id and rp.role_id = g.role_id and rp.permission_code = ${permission}
        join org_unit_closure c on c.company_id = g.company_id and c.ancestor_id = g.org_unit_id and c.descendant_id = ${unitId}::uuid
       where g.company_id = ${companyId}::uuid and g.valid @> current_date and (g.include_descendants or c.depth = 0)
       order by g.user_id`.execute(currentTx());
    return rows.map((r) => r.user_id);
  }

  /** Open tasks of an instance (at most one). */
  async openTasks(companyId: string, instanceId: string): Promise<TaskRow[]> {
    const { rows } = await sql<TaskRow>`select ${TASK_COLUMNS} from workflow_task t
      where t.company_id = ${companyId}::uuid and t.instance_id = ${instanceId}::uuid and t.status = 'open'`.execute(currentTx());
    return rows;
  }

  /** Display names of the company's members (memoised per request). */
  names(companyId: string): Promise<Map<string, string>> {
    return requestMemo(`workflow:names:${companyId}`, async () => {
      const { rows } = await sql<{ user_id: string; display_name: string }>`
        select user_id, display_name from auth.company_members(${companyId}::uuid)`.execute(currentTx());
      return new Map(rows.map((r) => [r.user_id, r.display_name]));
    });
  }
}
