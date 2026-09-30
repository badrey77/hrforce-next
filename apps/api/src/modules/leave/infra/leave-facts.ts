import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { currentTx } from '../../../platform/context/request-context.js';
import { addDays } from '../domain/dates.js';
import { resumptionOf, type Resumption } from '../domain/resumption.js';
import type { RequestStatus } from '../domain/rules.js';
import { DEFAULT_POLICY } from './leave.repository.js';

/** What another module (Documents: the titre de congé) may know about a leave request. */
export interface LeaveRequestFacts {
  id: string;
  employmentId: string;
  status: RequestStatus;
  type: { code: string; labels: { fr: string; ar: string; en: string } };
  startDate: string;
  endDate: string;
  /** "2.5" */
  days: string;
  halfDayStart: boolean;
  halfDayEnd: boolean;
  /** back at work (weekend days of the policy and public holidays skipped; the afternoon of endDate after a half day) */
  resumption: Resumption;
}

/** What the Attendance module needs to compute presence (docs/contracts/attendance.md › Module boundaries). */
export interface AttendanceLeaveInputs {
  holidays: { date: string; labels: { fr: string; ar: string; en: string }; approximate: boolean }[];
  /** approved and pending requests intersecting [from, to] */
  requests: {
    id: string;
    employmentId: string;
    status: 'approved' | 'pending';
    typeCode: string;
    labels: { fr: string; ar: string; en: string };
    startDate: string;
    endDate: string;
    halfDayStart: boolean;
    halfDayEnd: boolean;
  }[];
}

/**
 * Read-only leave facts for other modules (exported by modules/leave/index.ts), through the request transaction,
 * always filtered by company. No constructor dependency: also usable by seeds inside `runWithContext`.
 */
@Injectable()
export class LeaveFacts {
  /**
   * Public holidays of [from, to] and the approved / pending requests intersecting it, of the given employments (null =
   * every employment of the company) — read-only inputs of the attendance daily computation.
   */
  async attendanceInputs(companyId: string, employmentIds: readonly string[] | null, from: string, to: string): Promise<AttendanceLeaveInputs> {
    const tx = currentTx();
    const holidays = await sql<{ date: string; fr: string; ar: string; en: string; approximate: boolean }>`
      select date::text as date, name_fr as fr, name_ar as ar, name_en as en, approximate
        from public_holiday
       where company_id = ${companyId}::uuid and date between ${from}::date and ${to}::date
       order by date`.execute(tx);
    if (employmentIds !== null && employmentIds.length === 0) {
      return { holidays: holidays.rows.map((h) => ({ date: h.date, labels: { fr: h.fr, ar: h.ar, en: h.en }, approximate: h.approximate })), requests: [] };
    }
    const only = employmentIds === null ? sql`` : sql`and r.employment_id in (${sql.join(employmentIds.map((id) => sql`${id}::uuid`))})`;
    const requests = await sql<{
      id: string;
      employmentId: string;
      status: 'approved' | 'pending';
      code: string;
      fr: string;
      ar: string;
      en: string;
      startDate: string;
      endDate: string;
      halfDayStart: boolean;
      halfDayEnd: boolean;
    }>`
      select r.id, r.employment_id as "employmentId", r.status, t.code, t.name_fr as fr, t.name_ar as ar, t.name_en as en,
             r.start_date::text as "startDate", r.end_date::text as "endDate",
             r.half_day_start as "halfDayStart", r.half_day_end as "halfDayEnd"
        from leave_request r
        join leave_type t on t.company_id = r.company_id and t.id = r.leave_type_id
       where r.company_id = ${companyId}::uuid and r.status in ('approved', 'pending')
         and r.start_date <= ${to}::date and r.end_date >= ${from}::date
         ${only}
       order by r.start_date, r.id`.execute(tx);
    return {
      holidays: holidays.rows.map((h) => ({ date: h.date, labels: { fr: h.fr, ar: h.ar, en: h.en }, approximate: h.approximate })),
      requests: requests.rows.map((r) => ({
        id: r.id,
        employmentId: r.employmentId,
        status: r.status,
        typeCode: r.code,
        labels: { fr: r.fr, ar: r.ar, en: r.en },
        startDate: r.startDate,
        endDate: r.endDate,
        halfDayStart: r.halfDayStart,
        halfDayEnd: r.halfDayEnd,
      })),
    };
  }

  async request(companyId: string, id: string): Promise<LeaveRequestFacts | undefined> {
    const tx = currentTx();
    const { rows } = await sql<{
      id: string;
      employmentId: string;
      status: RequestStatus;
      code: string;
      nameFr: string;
      nameAr: string;
      nameEn: string;
      startDate: string;
      endDate: string;
      days: string;
      halfDayStart: boolean;
      halfDayEnd: boolean;
    }>`
      select r.id, r.employment_id as "employmentId", r.status, t.code, t.name_fr as "nameFr", t.name_ar as "nameAr", t.name_en as "nameEn",
             r.start_date::text as "startDate", r.end_date::text as "endDate", r.days::text as days,
             r.half_day_start as "halfDayStart", r.half_day_end as "halfDayEnd"
        from leave_request r
        join leave_type t on t.company_id = r.company_id and t.id = r.leave_type_id
       where r.company_id = ${companyId}::uuid and r.id = ${id}::uuid`.execute(tx);
    const r = rows[0];
    if (!r) return undefined;
    const policy = await sql<{ weekendDays: number[] }>`
      select weekend_days as "weekendDays" from leave_policy where company_id = ${companyId}::uuid`.execute(tx);
    const holidays = await sql<{ date: string }>`
      select date::text as date from public_holiday
       where company_id = ${companyId}::uuid and date between ${addDays(r.endDate, 1)}::date and ${addDays(r.endDate, 60)}::date`.execute(tx);
    const days = Number(r.days);
    return {
      id: r.id,
      employmentId: r.employmentId,
      status: r.status,
      type: { code: r.code, labels: { fr: r.nameFr, ar: r.nameAr, en: r.nameEn } },
      startDate: r.startDate,
      endDate: r.endDate,
      days: Number.isInteger(days) ? String(days) : days.toFixed(1),
      halfDayStart: r.halfDayStart,
      halfDayEnd: r.halfDayEnd,
      resumption: resumptionOf({
        endDate: r.endDate,
        halfDayEnd: r.halfDayEnd,
        weekendDays: policy.rows[0]?.weekendDays ?? DEFAULT_POLICY.weekendDays,
        holidays: holidays.rows.map((h) => h.date),
      }),
    };
  }
}
