import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { currentTx } from '../../../platform/context/request-context.js';
import type { AssignmentFact, OverrideFact, TargetKind, VersionFact } from '../domain/schedules.js';
import { storedWeek, type Week } from '../domain/week.js';

export interface ScheduleRow {
  id: string;
  code: string;
  nameFr: string;
  nameAr: string;
  nameEn: string;
  active: boolean;
}

export interface PolicyRow {
  retentionMonths: number;
  minPunchGapSeconds: number;
}

export const DEFAULT_ATTENDANCE_POLICY: PolicyRow = { retentionMonths: 60, minPunchGapSeconds: 120 };

export interface OverrideInput {
  scheduleId: string | null;
  labels: { fr: string; ar: string; en: string };
  from: string;
  to: string;
  week: Week;
  toleranceMinutes: number;
  approximate: boolean;
}

/** Postgres error helper: the SQLSTATE and constraint of a driver error. */
export function pgError(error: unknown): { code?: string; constraint?: string } {
  if (typeof error !== 'object' || error === null) return {};
  const e = error as { code?: unknown; constraint?: unknown };
  return { ...(typeof e.code === 'string' ? { code: e.code } : {}), ...(typeof e.constraint === 'string' ? { constraint: e.constraint } : {}) };
}

/**
 * Policy, schedules, versions, overrides and assignments — through the request transaction, always filtered by
 * company too (RLS is the backstop).
 */
@Injectable()
export class SchedulesRepository {
  // ── policy ────────────────────────────────────────────────────────────────────────────────────────────────────

  async policy(companyId: string): Promise<PolicyRow> {
    const row = await currentTx()
      .selectFrom('attendance_policy')
      .select(['retention_months', 'min_punch_gap_seconds'])
      .where('company_id', '=', companyId)
      .executeTakeFirst();
    return row ? { retentionMonths: row.retention_months, minPunchGapSeconds: row.min_punch_gap_seconds } : { ...DEFAULT_ATTENDANCE_POLICY };
  }

  async savePolicy(companyId: string, policy: PolicyRow): Promise<void> {
    await sql`
      insert into attendance_policy (company_id, retention_months, min_punch_gap_seconds, updated_at)
      values (${companyId}::uuid, ${policy.retentionMonths}, ${policy.minPunchGapSeconds}, now())
      on conflict (company_id) do update
         set retention_months = excluded.retention_months, min_punch_gap_seconds = excluded.min_punch_gap_seconds, updated_at = now()
       where attendance_policy.retention_months is distinct from excluded.retention_months
          or attendance_policy.min_punch_gap_seconds is distinct from excluded.min_punch_gap_seconds`.execute(currentTx());
  }

  // ── schedules and versions ────────────────────────────────────────────────────────────────────────────────────

  async schedules(companyId: string): Promise<ScheduleRow[]> {
    const { rows } = await sql<ScheduleRow>`
      select id, code, name_fr as "nameFr", name_ar as "nameAr", name_en as "nameEn", active
        from attendance_schedule where company_id = ${companyId}::uuid order by code`.execute(currentTx());
    return rows;
  }

  async schedule(companyId: string, id: string): Promise<ScheduleRow | undefined> {
    return (await this.schedules(companyId)).find((s) => s.id === id);
  }

  async codeTaken(companyId: string, code: string): Promise<boolean> {
    const row = await currentTx().selectFrom('attendance_schedule').select('id').where('company_id', '=', companyId).where('code', '=', code).executeTakeFirst();
    return row !== undefined;
  }

  async insertSchedule(companyId: string, input: { code: string; labels: { fr: string; ar: string; en: string } }): Promise<string> {
    const { rows } = await sql<{ id: string }>`
      insert into attendance_schedule (company_id, code, name_fr, name_ar, name_en)
      values (${companyId}::uuid, ${input.code}, ${input.labels.fr}, ${input.labels.ar}, ${input.labels.en})
      returning id`.execute(currentTx());
    const id = rows[0]?.id;
    if (!id) throw new Error('attendance_schedule insert returned no id');
    return id;
  }

  async updateSchedule(companyId: string, id: string, patch: { labels?: { fr: string; ar: string; en: string }; active?: boolean }): Promise<void> {
    const sets = [
      ...(patch.labels ? [sql`name_fr = ${patch.labels.fr}`, sql`name_ar = ${patch.labels.ar}`, sql`name_en = ${patch.labels.en}`] : []),
      ...(patch.active !== undefined ? [sql`active = ${patch.active}`] : []),
    ];
    if (sets.length === 0) return;
    await sql`update attendance_schedule set ${sql.join(sets)} where company_id = ${companyId}::uuid and id = ${id}::uuid`.execute(currentTx());
  }

  async versions(companyId: string, scheduleId?: string): Promise<VersionFact[]> {
    const only = scheduleId ? sql`and schedule_id = ${scheduleId}::uuid` : sql``;
    const { rows } = await sql<{ id: string; scheduleId: string; from: string; to: string | null; week: unknown; toleranceMinutes: number }>`
      select id, schedule_id as "scheduleId", lower(valid)::text as "from", upper(valid)::text as "to", week, tolerance_minutes as "toleranceMinutes"
        from attendance_schedule_version where company_id = ${companyId}::uuid ${only}
       order by schedule_id, lower(valid) desc`.execute(currentTx());
    return rows.map((r) => ({ ...r, week: storedWeek(r.week) }));
  }

  async insertVersion(companyId: string, scheduleId: string, from: string, week: Week, toleranceMinutes: number): Promise<void> {
    await sql`
      insert into attendance_schedule_version (company_id, schedule_id, valid, week, tolerance_minutes)
      values (${companyId}::uuid, ${scheduleId}::uuid, daterange(${from}::date, null, '[)'), ${JSON.stringify(week)}::jsonb, ${toleranceMinutes})`.execute(currentTx());
  }

  async closeVersion(companyId: string, id: string, to: string): Promise<void> {
    await sql`update attendance_schedule_version set valid = daterange(lower(valid), ${to}::date, '[)')
               where company_id = ${companyId}::uuid and id = ${id}::uuid`.execute(currentTx());
  }

  // ── overrides ─────────────────────────────────────────────────────────────────────────────────────────────────

  async overrides(companyId: string): Promise<OverrideFact[]> {
    const { rows } = await sql<{
      id: string;
      scheduleId: string | null;
      fr: string;
      ar: string;
      en: string;
      from: string;
      toExclusive: string;
      week: unknown;
      toleranceMinutes: number;
      approximate: boolean;
    }>`
      select id, schedule_id as "scheduleId", name_fr as fr, name_ar as ar, name_en as en, lower(dates)::text as "from",
             upper(dates)::text as "toExclusive", week, tolerance_minutes as "toleranceMinutes", approximate
        from attendance_schedule_override where company_id = ${companyId}::uuid
       order by lower(dates), id`.execute(currentTx());
    return rows.map((r) => ({
      id: r.id,
      scheduleId: r.scheduleId,
      labels: { fr: r.fr, ar: r.ar, en: r.en },
      from: r.from,
      toExclusive: r.toExclusive,
      week: storedWeek(r.week),
      toleranceMinutes: r.toleranceMinutes,
      approximate: r.approximate,
    }));
  }

  async insertOverride(companyId: string, o: OverrideInput): Promise<string> {
    const { rows } = await sql<{ id: string }>`
      insert into attendance_schedule_override (company_id, schedule_id, name_fr, name_ar, name_en, dates, week, tolerance_minutes, approximate)
      values (${companyId}::uuid, ${o.scheduleId}::uuid, ${o.labels.fr}, ${o.labels.ar}, ${o.labels.en},
              daterange(${o.from}::date, (${o.to}::date + 1), '[)'), ${JSON.stringify(o.week)}::jsonb, ${o.toleranceMinutes}, ${o.approximate})
      returning id`.execute(currentTx());
    const id = rows[0]?.id;
    if (!id) throw new Error('attendance_schedule_override insert returned no id');
    return id;
  }

  async updateOverride(companyId: string, id: string, o: OverrideInput): Promise<void> {
    await sql`
      update attendance_schedule_override
         set schedule_id = ${o.scheduleId}::uuid, name_fr = ${o.labels.fr}, name_ar = ${o.labels.ar}, name_en = ${o.labels.en},
             dates = daterange(${o.from}::date, (${o.to}::date + 1), '[)'), week = ${JSON.stringify(o.week)}::jsonb,
             tolerance_minutes = ${o.toleranceMinutes}, approximate = ${o.approximate}
       where company_id = ${companyId}::uuid and id = ${id}::uuid`.execute(currentTx());
  }

  async deleteOverride(companyId: string, id: string): Promise<void> {
    await currentTx().deleteFrom('attendance_schedule_override').where('company_id', '=', companyId).where('id', '=', id).execute();
  }

  // ── assignments ───────────────────────────────────────────────────────────────────────────────────────────────

  async assignments(companyId: string): Promise<AssignmentFact[]> {
    const { rows } = await sql<{ id: string; scheduleId: string; targetKind: TargetKind; targetId: string | null; from: string; to: string | null }>`
      select id, schedule_id as "scheduleId", target_kind as "targetKind", coalesce(site_id, org_unit_id, employment_id) as "targetId",
             lower(valid)::text as "from", upper(valid)::text as "to"
        from attendance_schedule_assignment where company_id = ${companyId}::uuid
       order by target_kind, lower(valid), id`.execute(currentTx());
    return rows;
  }

  async insertAssignment(companyId: string, a: { scheduleId: string; kind: TargetKind; targetId: string | null; from: string }): Promise<string> {
    const column = (k: TargetKind) => (a.kind === k ? a.targetId : null);
    const { rows } = await sql<{ id: string }>`
      insert into attendance_schedule_assignment (company_id, schedule_id, target_kind, site_id, org_unit_id, employment_id, valid)
      values (${companyId}::uuid, ${a.scheduleId}::uuid, ${a.kind}, ${column('site')}::uuid, ${column('unit')}::uuid, ${column('employment')}::uuid,
              daterange(${a.from}::date, null, '[)'))
      returning id`.execute(currentTx());
    const id = rows[0]?.id;
    if (!id) throw new Error('attendance_schedule_assignment insert returned no id');
    return id;
  }

  /** Sets the exclusive end (null = open). */
  async setAssignmentEnd(companyId: string, id: string, to: string | null): Promise<void> {
    await sql`update attendance_schedule_assignment set valid = daterange(lower(valid), ${to}::date, '[)')
               where company_id = ${companyId}::uuid and id = ${id}::uuid`.execute(currentTx());
  }

  async deleteAssignment(companyId: string, id: string): Promise<void> {
    await currentTx().deleteFrom('attendance_schedule_assignment').where('company_id', '=', companyId).where('id', '=', id).execute();
  }

  // ── assignment targets ────────────────────────────────────────────────────────────────────────────────────────

  async site(companyId: string, id: string): Promise<{ id: string; code: string; name: string } | undefined> {
    return currentTx().selectFrom('site').select(['id', 'code', 'name']).where('company_id', '=', companyId).where('id', '=', id).executeTakeFirst();
  }

  async unit(companyId: string, id: string): Promise<{ id: string; isRoot: boolean } | undefined> {
    const row = await currentTx().selectFrom('org_unit').select(['id', 'is_root']).where('company_id', '=', companyId).where('id', '=', id).executeTakeFirst();
    return row ? { id: row.id, isRoot: row.is_root } : undefined;
  }

  async employmentExists(companyId: string, id: string): Promise<boolean> {
    const row = await currentTx().selectFrom('employment').select('id').where('company_id', '=', companyId).where('id', '=', id).executeTakeFirst();
    return row !== undefined;
  }
}
