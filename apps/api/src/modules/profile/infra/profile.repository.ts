import { Injectable } from '@nestjs/common';
import { sql, type RawBuilder, type Transaction } from 'kysely';
import type { UnitIdQuery } from '../../../platform/authz/scope-service.js';
import { currentTx } from '../../../platform/context/request-context.js';
import type { DB } from '../../../platform/db/schema.js';
import { scopeAssignmentSql } from '../../staffing/index.js';
import type { ConfigurableSection, ProfileSection, RequestStatus, SectionMode } from '../domain/profile.js';

export interface RequestRow {
  id: string;
  employmentId: string;
  personId: string;
  section: ProfileSection;
  status: RequestStatus;
  payload: unknown;
  before: unknown;
  employeeComment: string | null;
  workflowInstanceId: string | null;
  requestedBy: string;
  requestedAt: Date;
  decidedAt: Date | null;
  filesPurgedAt: Date | null;
}

export interface FileRow {
  id: string;
  requestId: string;
  originalFilename: string;
  mime: 'application/pdf' | 'image/jpeg' | 'image/png';
  sizeBytes: number;
  sha256: string;
  hasContent: boolean;
  employeeFileId: string | null;
}

export interface PolicyRow {
  modes: Record<ConfigurableSection, SectionMode>;
  fileRetentionDays: number;
}

export const DEFAULT_POLICY: PolicyRow = { modes: { contact: 'immediate', emergency: 'immediate', family: 'approval' }, fileRetentionDays: 30 };

export interface HrListQuery {
  /** employee.personal.read scope (the employee's scope unit today must be in it) */
  scope: UnitIdQuery;
  today: string;
  /** employee.bank.read scope: bank requests only for employees inside it */
  bankScope: UnitIdQuery;
  status?: RequestStatus | undefined;
  section?: ProfileSection | undefined;
  /** the employee's scope unit is `unitId` (or in its subtree) */
  unitId?: string | undefined;
  includeSubUnits: boolean;
  q?: string | undefined;
  /** one employee only */
  employmentId?: string | undefined;
  limit: number;
  offset: number;
}

const COLUMNS = sql`r.id, r.employment_id as "employmentId", r.person_id as "personId", r.section, r.status, r.payload, r.before,
  r.employee_comment as "employeeComment", r.workflow_instance_id as "workflowInstanceId", r.requested_by as "requestedBy",
  r.requested_at as "requestedAt", r.decided_at as "decidedAt", r.files_purged_at as "filesPurgedAt"`;

function ids(values: readonly string[]): RawBuilder<unknown> {
  return sql.join(values.map((v) => sql`${v}::uuid`));
}

function likeContains(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Profile change requests, their files and the company policy — through the request transaction. */
@Injectable()
export class ProfileRepository {
  async policy(companyId: string): Promise<PolicyRow> {
    const row = await currentTx()
      .selectFrom('profile_policy')
      .select(['contact_mode', 'emergency_mode', 'family_mode', 'file_retention_days'])
      .where('company_id', '=', companyId)
      .executeTakeFirst();
    if (!row) return DEFAULT_POLICY;
    return {
      modes: { contact: row.contact_mode as SectionMode, emergency: row.emergency_mode as SectionMode, family: row.family_mode as SectionMode },
      fileRetentionDays: row.file_retention_days,
    };
  }

  async setPolicy(companyId: string, policy: PolicyRow): Promise<void> {
    await sql`
      insert into profile_policy (company_id, contact_mode, emergency_mode, family_mode, file_retention_days)
      values (${companyId}::uuid, ${policy.modes.contact}, ${policy.modes.emergency}, ${policy.modes.family}, ${policy.fileRetentionDays})
      on conflict (company_id) do update set contact_mode = excluded.contact_mode, emergency_mode = excluded.emergency_mode,
        family_mode = excluded.family_mode, file_retention_days = excluded.file_retention_days, updated_at = now()
       where (profile_policy.contact_mode, profile_policy.emergency_mode, profile_policy.family_mode, profile_policy.file_retention_days)
             is distinct from (excluded.contact_mode, excluded.emergency_mode, excluded.family_mode, excluded.file_retention_days)`.execute(currentTx());
  }

  async definitionId(companyId: string, code: string): Promise<string | undefined> {
    const row = await currentTx().selectFrom('workflow_definition').select('id').where('company_id', '=', companyId).where('code', '=', code).executeTakeFirst();
    return row?.id;
  }

  async insertRequest(
    companyId: string,
    input: {
      employmentId: string;
      personId: string;
      section: ProfileSection;
      status: 'pending' | 'applied';
      payload: unknown;
      before: unknown;
      comment: string | null;
      requestedBy: string;
    },
  ): Promise<string> {
    const { rows } = await sql<{ id: string }>`
      insert into profile_change_request (company_id, employment_id, person_id, section, status, payload, before, employee_comment, requested_by, decided_at)
      values (${companyId}::uuid, ${input.employmentId}::uuid, ${input.personId}::uuid, ${input.section}, ${input.status},
              ${JSON.stringify(input.payload)}::jsonb, ${input.before === null ? null : JSON.stringify(input.before)}::jsonb, ${input.comment},
              ${input.requestedBy}::uuid, ${input.status === 'applied' ? sql`now()` : sql`null`})
      returning id`.execute(currentTx());
    const id = rows[0]?.id;
    if (!id) throw new Error('profile_change_request insert returned nothing');
    return id;
  }

  async insertFile(companyId: string, requestId: string, file: { originalFilename: string; mime: string; sha256: Buffer; content: Buffer }): Promise<void> {
    await currentTx()
      .insertInto('profile_change_file')
      .values({
        company_id: companyId,
        request_id: requestId,
        original_filename: file.originalFilename,
        mime: file.mime,
        size_bytes: file.content.length,
        sha256: file.sha256,
        content: file.content,
      })
      .execute();
  }

  async setInstance(companyId: string, id: string, instanceId: string): Promise<void> {
    await currentTx().updateTable('profile_change_request').set({ workflow_instance_id: instanceId }).where('company_id', '=', companyId).where('id', '=', id).execute();
  }

  /** pending → status (once: the row guard refuses a second decision). */
  async decide(companyId: string, id: string, status: 'approved' | 'rejected' | 'cancelled'): Promise<void> {
    await currentTx()
      .updateTable('profile_change_request')
      .set({ status, decided_at: sql<Date>`now()` })
      .where('company_id', '=', companyId)
      .where('id', '=', id)
      .where('status', '=', 'pending')
      .execute();
  }

  async request(companyId: string, id: string, options: { lock?: boolean } = {}): Promise<RequestRow | undefined> {
    const lock = options.lock ? sql`for update` : sql``;
    const { rows } = await sql<RequestRow>`select ${COLUMNS} from profile_change_request r
      where r.company_id = ${companyId}::uuid and r.id = ${id}::uuid ${lock}`.execute(currentTx());
    return rows[0];
  }

  async requests(companyId: string, requestIds: readonly string[]): Promise<RequestRow[]> {
    if (requestIds.length === 0) return [];
    const { rows } = await sql<RequestRow>`select ${COLUMNS} from profile_change_request r
      where r.company_id = ${companyId}::uuid and r.id in (${ids(requestIds)})`.execute(currentTx());
    return rows;
  }

  /** The requests of an employment, newest first. */
  async requestsOf(companyId: string, employmentId: string, status?: RequestStatus): Promise<RequestRow[]> {
    const filter = status ? sql`and r.status = ${status}` : sql``;
    const { rows } = await sql<RequestRow>`select ${COLUMNS} from profile_change_request r
      where r.company_id = ${companyId}::uuid and r.employment_id = ${employmentId}::uuid ${filter}
      order by r.requested_at desc, r.id desc`.execute(currentTx());
    return rows;
  }

  /** The HR list: scoped by the employee's scope unit today, newest first. */
  async list(companyId: string, query: HrListQuery): Promise<{ rows: RequestRow[]; total: number }> {
    const filters: RawBuilder<unknown>[] = [sql`r.company_id = ${companyId}::uuid`, sql`a.org_unit_id in (${query.scope})`];
    filters.push(sql`(r.section <> 'bank' or a.org_unit_id in (${query.bankScope}))`);
    if (query.status) filters.push(sql`r.status = ${query.status}`);
    if (query.section) filters.push(sql`r.section = ${query.section}`);
    if (query.employmentId) filters.push(sql`r.employment_id = ${query.employmentId}::uuid`);
    if (query.unitId) {
      filters.push(
        query.includeSubUnits
          ? sql`a.org_unit_id in (select k.descendant_id from org_unit_closure k where k.company_id = r.company_id and k.ancestor_id = ${query.unitId}::uuid)`
          : sql`a.org_unit_id = ${query.unitId}::uuid`,
      );
    }
    if (query.q) filters.push(sql`(p.search_text like search_normalize(${likeContains(query.q)}) or e.matricule_search like search_normalize(${likeContains(query.q)}))`);
    const { rows } = await sql<RequestRow & { total: number }>`
      select ${COLUMNS}, count(*) over ()::int as total
        from profile_change_request r
        join employment e on e.company_id = r.company_id and e.id = r.employment_id
        join person p on p.company_id = e.company_id and p.id = e.person_id
        join lateral ${scopeAssignmentSql(sql`e.id`, query.today)} a on true
       where ${sql.join(filters, sql` and `)}
       order by r.requested_at desc, r.id desc
       limit ${query.limit} offset ${query.offset}`.execute(currentTx());
    return { rows: rows.map(({ total: _t, ...r }) => r), total: rows[0]?.total ?? 0 };
  }

  async files(companyId: string, requestIds: readonly string[]): Promise<FileRow[]> {
    if (requestIds.length === 0) return [];
    const { rows } = await sql<FileRow>`
      select f.id, f.request_id as "requestId", f.original_filename as "originalFilename", f.mime, f.size_bytes as "sizeBytes",
             encode(f.sha256, 'hex') as sha256, (f.content is not null) as "hasContent", f.employee_file_id as "employeeFileId"
        from profile_change_file f
       where f.company_id = ${companyId}::uuid and f.request_id in (${ids(requestIds)})
       order by f.created_at, f.id`.execute(currentTx());
    return rows;
  }

  async content(companyId: string, fileId: string): Promise<Buffer | null> {
    const row = await currentTx().selectFrom('profile_change_file').select('content').where('company_id', '=', companyId).where('id', '=', fileId).executeTakeFirst();
    return row?.content ?? null;
  }

  async setEmployeeFile(companyId: string, fileId: string, employeeFileId: string): Promise<void> {
    await currentTx().updateTable('profile_change_file').set({ employee_file_id: employeeFileId }).where('company_id', '=', companyId).where('id', '=', fileId).execute();
  }

  /** Display names of the company's members (user id → name). */
  async names(companyId: string): Promise<Map<string, string>> {
    const { rows } = await sql<{ user_id: string; display_name: string }>`
      select user_id, display_name from auth.company_members(${companyId}::uuid)`.execute(currentTx());
    return new Map(rows.map((r) => [r.user_id, r.display_name]));
  }
}

// ── worker side (hrforce_worker: SELECT, UPDATE (content) / (files_purged_at); runs inside inCompany) ─────────────

export interface PurgeCandidate {
  id: string;
  status: RequestStatus;
  decidedAt: Date | null;
  copied: boolean;
}

/** Decided requests whose files still hold bytes (not yet marked purged). */
export async function purgeCandidates(tx: Transaction<DB>, companyId: string): Promise<PurgeCandidate[]> {
  const { rows } = await sql<PurgeCandidate>`
    select r.id, r.status, r.decided_at as "decidedAt",
           coalesce(bool_and(f.employee_file_id is not null), false) as copied
      from profile_change_request r
      left join profile_change_file f on f.company_id = r.company_id and f.request_id = r.id
     where r.company_id = ${companyId}::uuid and r.files_purged_at is null and r.status in ('approved', 'rejected', 'cancelled')
     group by r.id, r.status, r.decided_at
    having count(f.id) > 0`.execute(tx);
  return rows;
}

/**
 * Nulls the bytes of a request's files and marks the request → number of files whose bytes were removed. No filter
 * on `content`: hrforce_worker may not read it (migration 0025), and a request is purged once (files_purged_at), so
 * every file still holds its bytes here.
 */
export async function purgeRequestFiles(tx: Transaction<DB>, companyId: string, requestId: string): Promise<number> {
  const result = await tx
    .updateTable('profile_change_file')
    .set({ content: null })
    .where('company_id', '=', companyId)
    .where('request_id', '=', requestId)
    .executeTakeFirst();
  await tx.updateTable('profile_change_request').set({ files_purged_at: sql<Date>`now()` }).where('company_id', '=', companyId).where('id', '=', requestId).execute();
  return Number(result.numUpdatedRows);
}

export async function retentionDays(tx: Transaction<DB>, companyId: string): Promise<number> {
  const row = await tx.selectFrom('profile_policy').select('file_retention_days').where('company_id', '=', companyId).executeTakeFirst();
  return row?.file_retention_days ?? DEFAULT_POLICY.fileRetentionDays;
}
