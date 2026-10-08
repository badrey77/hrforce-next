import { Injectable } from '@nestjs/common';
import { sql, type RawBuilder } from 'kysely';
import type { UnitIdQuery } from '../../../platform/authz/scope-service.js';
import { currentTx } from '../../../platform/context/request-context.js';
import {
  ACTIVE_STAGES,
  DEFAULT_RETENTION_MONTHS,
  DEFAULT_WORKFLOW_CODE,
  likeContains,
  OPENING_STATUSES,
  STAGES,
  type ActiveStage,
  type ContractType,
  type OpeningStatus,
  type OpeningWorkflowCode,
  type Stage,
} from '../domain/rules.js';

export interface OpeningRow {
  id: string;
  reference: string;
  title: string;
  orgUnitId: string;
  siteId: string | null;
  contractType: ContractType;
  posts: number;
  hiredCount: number;
  justification: string;
  targetDate: string;
  anemReference: string | null;
  status: OpeningStatus;
  requestedBy: string;
  requestedAt: Date;
  workflowInstanceId: string | null;
  openedAt: Date | null;
  closedAt: Date | null;
  closedBy: string | null;
  closeReason: string | null;
}

export interface SnapshotUnitRow {
  id: string;
  kind: string;
  code: string;
  name: string;
  nameAr: string | null;
  parentId: string | null;
  siteId: string | null;
}

export interface SiteRow {
  id: string;
  code: string;
  name: string;
}

export interface ReasonRow {
  id: string;
  code: string;
  nameFr: string;
  nameAr: string;
  nameEn: string;
  active: boolean;
  sortOrder: number;
  isSystem: boolean;
  autoOnly: boolean;
}

export interface PolicyRow {
  retentionMonths: number;
  openingWorkflowCode: OpeningWorkflowCode;
}

export type OpeningSort = 'requestedAt' | 'targetDate' | 'title' | 'unit';

export interface OpeningListQuery {
  /** recruitment.read scope */
  scope: UnitIdQuery;
  statuses?: readonly OpeningStatus[] | undefined;
  /** the opening's unit is one of these (unitId, with sub-units or not) */
  units?: readonly string[] | undefined;
  contractType?: ContractType | undefined;
  q?: string | undefined;
  sort: OpeningSort;
  dir: 'asc' | 'desc';
  limit: number;
  offset: number;
}

export type StageCountsRow = Record<Stage, number> & { total: number };

const OPENING = sql`
  o.id, o.reference, o.title, o.org_unit_id as "orgUnitId", o.site_id as "siteId", o.contract_type as "contractType", o.posts,
  o.hired_count as "hiredCount", o.justification, o.target_date::text as "targetDate", o.anem_reference as "anemReference", o.status,
  o.requested_by as "requestedBy", o.requested_at as "requestedAt", o.workflow_instance_id as "workflowInstanceId",
  o.opened_at as "openedAt", o.closed_at as "closedAt", o.closed_by as "closedBy", o.close_reason as "closeReason"`;

const REASON = sql`r.id, r.code, r.name_fr as "nameFr", r.name_ar as "nameAr", r.name_en as "nameEn", r.active, r.sort_order as "sortOrder",
  r.is_system as "isSystem", r.auto_only as "autoOnly"`;

export const ids = (list: readonly string[]): RawBuilder<unknown> => sql.join(list.map((id) => sql`${id}::uuid`));

/** Postgres error helper: the constraint of a driver error. */
export function constraintOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const c = (error as { constraint?: unknown }).constraint;
  return typeof c === 'string' ? c : undefined;
}

export function emptyCounts(): StageCountsRow {
  return { received: 0, shortlisted: 0, interview: 0, offer: 0, hired: 0, rejected: 0, withdrawn: 0, total: 0 };
}

/**
 * Openings, the company settings and the organisation reads of the Recruitment module (docs/contracts/recruitment.md)
 * — through the request transaction, always filtered by company too (RLS is the backstop).
 */
@Injectable()
export class RecruitmentRepository {
  // ── organisation, members ───────────────────────────────────────────────────────────────────────────────────────

  /** Every unit with its version valid on `date` (else its earliest one): today's tree, names and own sites. */
  async orgSnapshot(companyId: string, date: string): Promise<SnapshotUnitRow[]> {
    const { rows } = await sql<SnapshotUnitRow>`
      select distinct on (u.id) u.id, u.kind, u.code, v.name, v.name_ar as "nameAr", v.parent_id as "parentId", v.site_id as "siteId"
        from org_unit u
        join org_unit_version v on v.company_id = u.company_id and v.org_unit_id = u.id
       where u.company_id = ${companyId}::uuid
       order by u.id, (v.valid @> ${date}::date) desc, lower(v.valid) asc`.execute(currentTx());
    return rows;
  }

  async sites(companyId: string): Promise<SiteRow[]> {
    return currentTx().selectFrom('site').select(['id', 'code', 'name']).where('company_id', '=', companyId).execute();
  }

  /** Display names of the company's members (auth.company_members: current members only). */
  async members(companyId: string): Promise<Map<string, string>> {
    const { rows } = await sql<{ user_id: string; display_name: string }>`
      select user_id, display_name from auth.company_members(${companyId}::uuid)`.execute(currentTx());
    return new Map(rows.map((r) => [r.user_id, r.display_name]));
  }

  // ── settings ────────────────────────────────────────────────────────────────────────────────────────────────────

  /** A missing row = the defaults. */
  async policy(companyId: string): Promise<PolicyRow> {
    const row = await currentTx().selectFrom('recruitment_policy').select(['retention_months', 'opening_workflow_code']).where('company_id', '=', companyId).executeTakeFirst();
    return {
      retentionMonths: row?.retention_months ?? DEFAULT_RETENTION_MONTHS,
      openingWorkflowCode: row?.opening_workflow_code === 'recruitment.hr_only' ? 'recruitment.hr_only' : DEFAULT_WORKFLOW_CODE,
    };
  }

  async savePolicy(companyId: string, policy: PolicyRow): Promise<void> {
    await sql`
      insert into recruitment_policy (company_id, retention_months, opening_workflow_code)
      values (${companyId}::uuid, ${policy.retentionMonths}, ${policy.openingWorkflowCode})
      on conflict (company_id) do update
        set retention_months = excluded.retention_months, opening_workflow_code = excluded.opening_workflow_code, updated_at = now()
      where recruitment_policy.retention_months is distinct from excluded.retention_months
         or recruitment_policy.opening_workflow_code is distinct from excluded.opening_workflow_code`.execute(currentTx());
  }

  /** For the information notice: the letterhead's legal names (company_profile), else the company's name. */
  async companyNames(companyId: string): Promise<{ nameFr: string; nameAr: string | null }> {
    const { rows } = await sql<{ nameFr: string; nameAr: string | null }>`
      select coalesce(p.legal_name_fr, c.name) as "nameFr", p.legal_name_ar as "nameAr"
        from company c
        left join company_profile p on p.company_id = c.id
       where c.id = ${companyId}::uuid`.execute(currentTx());
    return rows[0] ?? { nameFr: '', nameAr: null };
  }

  /** The definition of a workflow code (seeded per company). */
  async definitionId(companyId: string, code: string): Promise<string | undefined> {
    const row = await currentTx().selectFrom('workflow_definition').select('id').where('company_id', '=', companyId).where('code', '=', code).executeTakeFirst();
    return row?.id;
  }

  async reasons(companyId: string): Promise<ReasonRow[]> {
    const { rows } = await sql<ReasonRow>`
      select ${REASON} from recruitment_rejection_reason r where r.company_id = ${companyId}::uuid order by r.sort_order, r.code`.execute(currentTx());
    return rows;
  }

  async reason(companyId: string, id: string): Promise<ReasonRow | undefined> {
    const { rows } = await sql<ReasonRow>`
      select ${REASON} from recruitment_rejection_reason r where r.company_id = ${companyId}::uuid and r.id = ${id}::uuid`.execute(currentTx());
    return rows[0];
  }

  async reasonByCode(companyId: string, code: string): Promise<ReasonRow | undefined> {
    const { rows } = await sql<ReasonRow>`
      select ${REASON} from recruitment_rejection_reason r where r.company_id = ${companyId}::uuid and r.code = ${code}`.execute(currentTx());
    return rows[0];
  }

  /** A new reason goes last among the user reasons (before the automatic ones, 900+). */
  async insertReason(companyId: string, r: { code: string; nameFr: string; nameAr: string; nameEn: string }): Promise<string> {
    const { rows } = await sql<{ id: string }>`
      insert into recruitment_rejection_reason (company_id, code, name_fr, name_ar, name_en, sort_order)
      select ${companyId}::uuid, ${r.code}, ${r.nameFr}, ${r.nameAr}, ${r.nameEn},
             coalesce((select max(x.sort_order) from recruitment_rejection_reason x where x.company_id = ${companyId}::uuid and not x.auto_only), 0) + 10
      returning id`.execute(currentTx());
    const id = rows[0]?.id;
    if (!id) throw new Error('recruitment_rejection_reason insert returned no id');
    return id;
  }

  async updateReason(companyId: string, id: string, patch: { nameFr?: string; nameAr?: string; nameEn?: string; active?: boolean; sortOrder?: number }): Promise<void> {
    await sql`
      update recruitment_rejection_reason
         set name_fr = coalesce(${patch.nameFr ?? null}, name_fr), name_ar = coalesce(${patch.nameAr ?? null}, name_ar),
             name_en = coalesce(${patch.nameEn ?? null}, name_en), active = coalesce(${patch.active ?? null}::boolean, active),
             sort_order = coalesce(${patch.sortOrder ?? null}::int, sort_order)
       where company_id = ${companyId}::uuid and id = ${id}::uuid`.execute(currentTx());
  }

  // ── openings ────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Takes the next number of the company's year (the counter row is locked until the transaction ends). */
  async nextSequence(companyId: string, year: number): Promise<number> {
    const { rows } = await sql<{ value: number }>`
      insert into recruitment_opening_sequence (company_id, year, last_value) values (${companyId}::uuid, ${year}, 1)
      on conflict (company_id, year) do update set last_value = recruitment_opening_sequence.last_value + 1
      returning last_value as value`.execute(currentTx());
    const value = rows[0]?.value;
    if (!value) throw new Error('recruitment_opening_sequence returned no value');
    return value;
  }

  async insertOpening(
    companyId: string,
    o: { reference: string; title: string; orgUnitId: string; siteId: string | null; contractType: ContractType; posts: number; justification: string; targetDate: string; requestedBy: string },
  ): Promise<string> {
    const { rows } = await sql<{ id: string }>`
      insert into recruitment_opening (company_id, reference, title, org_unit_id, site_id, contract_type, posts, justification, target_date, requested_by)
      values (${companyId}::uuid, ${o.reference}, ${o.title}, ${o.orgUnitId}::uuid, ${o.siteId}::uuid, ${o.contractType}, ${o.posts}, ${o.justification},
              ${o.targetDate}::date, ${o.requestedBy}::uuid)
      returning id`.execute(currentTx());
    const id = rows[0]?.id;
    if (!id) throw new Error('recruitment_opening insert returned no id');
    return id;
  }

  async setInstance(companyId: string, id: string, instanceId: string): Promise<void> {
    await sql`update recruitment_opening set workflow_instance_id = ${instanceId}::uuid where company_id = ${companyId}::uuid and id = ${id}::uuid`.execute(currentTx());
  }

  async opening(companyId: string, id: string, { lock = false } = {}): Promise<OpeningRow | undefined> {
    const { rows } = await sql<OpeningRow>`
      select ${OPENING} from recruitment_opening o where o.company_id = ${companyId}::uuid and o.id = ${id}::uuid
      ${lock ? sql`for update` : sql``}`.execute(currentTx());
    return rows[0];
  }

  async openings(companyId: string, list: readonly string[]): Promise<OpeningRow[]> {
    if (list.length === 0) return [];
    const { rows } = await sql<OpeningRow>`
      select ${OPENING} from recruitment_opening o where o.company_id = ${companyId}::uuid and o.id in (${ids(list)})`.execute(currentTx());
    return rows;
  }

  async listOpenings(companyId: string, query: OpeningListQuery): Promise<{ rows: OpeningRow[]; total: number }> {
    if (query.units !== undefined && query.units.length === 0) return { rows: [], total: 0 };
    const filters: RawBuilder<unknown>[] = [sql`o.company_id = ${companyId}::uuid`, sql`o.org_unit_id in (${query.scope})`];
    if (query.statuses) filters.push(sql`o.status in (${sql.join(query.statuses.map((s) => sql`${s}`))})`);
    if (query.units) filters.push(sql`o.org_unit_id in (${ids(query.units)})`);
    if (query.contractType) filters.push(sql`o.contract_type = ${query.contractType}`);
    if (query.q) filters.push(sql`(search_normalize(o.title) like search_normalize(${likeContains(query.q)}) or lower(o.reference) like lower(${likeContains(query.q)}))`);
    const dir = query.dir === 'asc' ? sql`asc` : sql`desc`;
    const order = {
      requestedAt: sql`o.requested_at ${dir}, o.id ${dir}`,
      targetDate: sql`o.target_date ${dir}, o.reference ${dir}`,
      title: sql`search_normalize(o.title) ${dir}, o.reference ${dir}`,
      unit: sql`u.code ${dir}, o.reference ${dir}`,
    }[query.sort];
    const { rows } = await sql<OpeningRow & { total: number }>`
      select ${OPENING}, count(*) over ()::int as total
        from recruitment_opening o
        join org_unit u on u.company_id = o.company_id and u.id = o.org_unit_id
       where ${sql.join(filters, sql` and `)}
       order by ${order}
       limit ${query.limit} offset ${query.offset}`.execute(currentTx());
    return { rows: rows.map(({ total: _t, ...r }) => r), total: rows[0]?.total ?? 0 };
  }

  /** The openings a user requested or whose unit is one of `headUnits`, newest first. */
  async myOpenings(companyId: string, userId: string, headUnits: readonly string[], limit: number): Promise<OpeningRow[]> {
    const headed = headUnits.length > 0 ? sql`or o.org_unit_id in (${ids(headUnits)})` : sql``;
    const { rows } = await sql<OpeningRow>`
      select ${OPENING} from recruitment_opening o
       where o.company_id = ${companyId}::uuid and (o.requested_by = ${userId}::uuid ${headed})
       order by o.requested_at desc, o.id desc
       limit ${limit}`.execute(currentTx());
    return rows;
  }

  /** The caller's openings (requested or headed): how many, and how many pending ones they requested. */
  async myOpeningCounts(companyId: string, userId: string, headUnits: readonly string[]): Promise<{ openings: number; pending: number }> {
    const headed = headUnits.length > 0 ? sql`or o.org_unit_id in (${ids(headUnits)})` : sql``;
    const { rows } = await sql<{ openings: number; pending: number }>`
      select count(*)::int as openings,
             count(*) filter (where o.status = 'pending' and o.requested_by = ${userId}::uuid)::int as pending
        from recruitment_opening o
       where o.company_id = ${companyId}::uuid and (o.requested_by = ${userId}::uuid ${headed})`.execute(currentTx());
    return rows[0] ?? { openings: 0, pending: 0 };
  }

  async statusCounts(companyId: string, scope: UnitIdQuery): Promise<Record<OpeningStatus, number>> {
    const { rows } = await sql<{ status: OpeningStatus; n: number }>`
      select o.status, count(*)::int as n from recruitment_opening o
       where o.company_id = ${companyId}::uuid and o.org_unit_id in (${scope})
       group by o.status`.execute(currentTx());
    const out = Object.fromEntries(OPENING_STATUSES.map((s) => [s, 0])) as Record<OpeningStatus, number>;
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  /** Applications in an active stage of the OPEN openings of the scope. */
  async activeStageCounts(companyId: string, scope: UnitIdQuery): Promise<Record<ActiveStage, number>> {
    const { rows } = await sql<{ stage: ActiveStage; n: number }>`
      select a.stage, count(*)::int as n
        from recruitment_application a
        join recruitment_opening o on o.company_id = a.company_id and o.id = a.opening_id
       where a.company_id = ${companyId}::uuid and o.status = 'open' and o.org_unit_id in (${scope})
         and a.stage in (${sql.join(ACTIVE_STAGES.map((s) => sql`${s}`))})
       group by a.stage`.execute(currentTx());
    const out = Object.fromEntries(ACTIVE_STAGES.map((s) => [s, 0])) as Record<ActiveStage, number>;
    for (const r of rows) out[r.stage] = r.n;
    return out;
  }

  /** Applications per stage of each opening — every application, purged ones included (the anonymous counts). */
  async stageCounts(companyId: string, openingIds: readonly string[]): Promise<Map<string, StageCountsRow>> {
    const out = new Map<string, StageCountsRow>(openingIds.map((id) => [id, emptyCounts()]));
    if (openingIds.length === 0) return out;
    const { rows } = await sql<{ openingId: string; stage: Stage; n: number }>`
      select a.opening_id as "openingId", a.stage, count(*)::int as n
        from recruitment_application a
       where a.company_id = ${companyId}::uuid and a.opening_id in (${ids(openingIds)})
       group by a.opening_id, a.stage`.execute(currentTx());
    for (const r of rows) {
      const counts = out.get(r.openingId);
      if (!counts || !(STAGES as readonly string[]).includes(r.stage)) continue;
      counts[r.stage] = r.n;
      counts.total += r.n;
    }
    return out;
  }

  async updateOpening(companyId: string, id: string, patch: { targetDate?: string; siteId?: string | null; anemReference?: string | null; posts?: number }): Promise<void> {
    const sets: RawBuilder<unknown>[] = [];
    if (patch.targetDate !== undefined) sets.push(sql`target_date = ${patch.targetDate}::date`);
    if (patch.siteId !== undefined) sets.push(sql`site_id = ${patch.siteId}::uuid`);
    if (patch.anemReference !== undefined) sets.push(sql`anem_reference = ${patch.anemReference}`);
    if (patch.posts !== undefined) sets.push(sql`posts = ${patch.posts}`);
    if (sets.length === 0) return;
    await sql`update recruitment_opening set ${sql.join(sets)} where company_id = ${companyId}::uuid and id = ${id}::uuid`.execute(currentTx());
  }

  /** pending → open (the final approval). */
  async markOpen(companyId: string, id: string): Promise<void> {
    await sql`update recruitment_opening set status = 'open', opened_at = now() where company_id = ${companyId}::uuid and id = ${id}::uuid and status = 'pending'`.execute(currentTx());
  }

  /** pending → rejected | cancelled. */
  async markEnded(companyId: string, id: string, status: 'rejected' | 'cancelled'): Promise<void> {
    await sql`update recruitment_opening set status = ${status} where company_id = ${companyId}::uuid and id = ${id}::uuid and status = 'pending'`.execute(currentTx());
  }

  async markClosed(companyId: string, id: string, by: string, reason: string): Promise<void> {
    await sql`
      update recruitment_opening set status = 'closed', closed_at = now(), closed_by = ${by}::uuid, close_reason = ${reason}
       where company_id = ${companyId}::uuid and id = ${id}::uuid`.execute(currentTx());
  }

  async markFilled(companyId: string, id: string): Promise<void> {
    await sql`
      update recruitment_opening set status = 'filled', closed_at = now(), closed_by = null, close_reason = null
       where company_id = ${companyId}::uuid and id = ${id}::uuid`.execute(currentTx());
  }

  /** closed | filled → open. */
  async markReopened(companyId: string, id: string): Promise<void> {
    await sql`
      update recruitment_opening set status = 'open', closed_at = null, closed_by = null, close_reason = null
       where company_id = ${companyId}::uuid and id = ${id}::uuid`.execute(currentTx());
  }

  async unitExists(companyId: string, id: string): Promise<boolean> {
    const row = await currentTx().selectFrom('org_unit').select('id').where('company_id', '=', companyId).where('id', '=', id).executeTakeFirst();
    return row !== undefined;
  }

  async siteExists(companyId: string, id: string): Promise<boolean> {
    const row = await currentTx().selectFrom('site').select('id').where('company_id', '=', companyId).where('id', '=', id).executeTakeFirst();
    return row !== undefined;
  }
}
