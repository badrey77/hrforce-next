import { Injectable } from '@nestjs/common';
import { AuditEvents } from '../../../platform/audit/audit-events.js';
import { ScopeService } from '../../../platform/authz/scope-service.js';
import { ValidationProblemException } from '../../../platform/http/problem-details.js';
import { hoursMinutes, toCsv } from '../domain/csv.js';
import { datesBetween, daysBetween, maxDate, minDate, monthEnd, monthStart } from '../domain/time.js';
import { AttendanceRepository, type EmploymentFacts } from '../infra/attendance.repository.js';
import { CorrectionsRepository } from '../infra/corrections.repository.js';
import { AttendanceClock } from './attendance-clock.js';
import type { MonthlyReportItem, MonthlyReportView } from './attendance-views.js';
import { assignmentOn, placementOn, PresenceEngine } from './presence-engine.js';
import { ATTENDANCE_PERMISSIONS as P, BOARD_MAX_EMPLOYEES, caller } from './presence.service.js';

export interface MonthlyQuery {
  month?: string | undefined;
  unitId?: string | undefined;
  includeSubUnits: boolean;
  siteId?: string | undefined;
  q?: string | undefined;
  lang: 'fr' | 'ar' | 'en';
  page: number;
  pageSize: number;
}

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

const HEADERS: Record<'fr' | 'ar', string[]> = {
  fr: ['Matricule', 'Nom', 'Prénom', 'Unité', 'Présents', 'Retards', 'Minutes de retard', 'Absences', 'Incomplets', 'Congés', 'Fériés', 'Heures travaillées', 'Heures prévues', 'Dates d’absence'],
  ar: ['الرقم', 'اللقب', 'الاسم', 'الوحدة', 'أيام الحضور', 'أيام التأخر', 'دقائق التأخر', 'أيام الغياب', 'أيام التسجيل الناقص', 'أيام العطلة', 'العطل الرسمية', 'ساعات العمل', 'الساعات المقررة', 'تواريخ الغياب'],
};

const fr = new Intl.Collator('fr', { sensitivity: 'base' });
const ar = new Intl.Collator('ar', { sensitivity: 'base' });

/**
 * The monthly attendance report (docs/contracts/attendance.md › Phase B › GET /attendance/reports/monthly[.csv]):
 * employees whose employment is active on at least one day of the month, in the caller's attendance.read scope by
 * their assignment unit on min(month end, employment end, today); per employee the day statuses counted from the
 * 1st to min(month end, today) (computed on read, like the board), minutes and the absent / incomplete dates.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly people: AttendanceRepository,
    private readonly corrections: CorrectionsRepository,
    private readonly engine: PresenceEngine,
    private readonly scopes: ScopeService,
    private readonly audit: AuditEvents,
    private readonly clock: AttendanceClock,
  ) {}

  private period(month: string | undefined): { month: string; first: string; end: string } {
    const today = this.clock.today();
    const value = month ?? today.slice(0, 7);
    if (!MONTH.test(value)) throw new ValidationProblemException([{ field: 'month', code: 'invalid', message: 'A month written YYYY-MM.' }]);
    const first = `${value}-01`;
    if (first > monthStart(today)) throw new ValidationProblemException([{ field: 'month', code: 'future', message: 'Not after the current month.' }]);
    return { month: value, first, end: minDate(monthEnd(first), today) };
  }

  /** The employees of the report (scope, filters), sorted by name in `lang`; 422 above 5 000. */
  private async employees(companyId: string, first: string, end: string, query: MonthlyQuery): Promise<EmploymentFacts[]> {
    const ids = await this.corrections.activeIn(companyId, first, end, query.q);
    const [facts, org, readable] = await Promise.all([this.people.employments(companyId, ids), this.engine.orgBook(companyId), this.scopes.unitIds(P.read)]);
    const filter = query.unitId ? (query.includeSubUnits ? org.subtree([query.unitId], end) : new Set([query.unitId])) : null;
    const rows = facts.filter((e) => {
      const at = refDate(e, end);
      const unit = assignmentOn(e, at)?.orgUnitId;
      if (!unit || !readable.has(unit) || (filter && !filter.has(unit))) return false;
      return !query.siteId || placementOn(org, e, at)?.siteId === query.siteId;
    });
    if (rows.length > BOARD_MAX_EMPLOYEES) {
      throw new ValidationProblemException([{ field: 'unitId', code: 'too_many', message: `More than ${BOARD_MAX_EMPLOYEES} employees: choose a unit.` }]);
    }
    const name = (e: EmploymentFacts) =>
      query.lang === 'ar' ? `${(e.lastNameAr ?? '').trim() || e.lastName} ${(e.firstNameAr ?? '').trim() || e.firstName}` : e.sortName || `${e.lastName} ${e.firstName}`;
    const collator = query.lang === 'ar' ? ar : fr;
    return rows.toSorted((a, b) => collator.compare(name(a), name(b)) || (a.matricule < b.matricule ? -1 : a.matricule > b.matricule ? 1 : 0));
  }

  private async items(companyId: string, employees: readonly EmploymentFacts[], first: string, end: string): Promise<MonthlyReportItem[]> {
    if (employees.length === 0) return [];
    const data = await this.engine.load(companyId, employees.map((e) => e.id), first, end);
    return employees.map((e) => {
      const item: MonthlyReportItem = {
        employee: data.employeeRef(e, refDate(e, end)),
        counts: { present: 0, late: 0, absent: 0, incomplete: 0, onLeave: 0, holiday: 0, restDay: 0 },
        lateMinutes: 0,
        earlyDepartureMinutes: 0,
        workedMinutes: 0,
        scheduledMinutes: 0,
        absentDates: [],
        incompleteDates: [],
      };
      const from = maxDate(first, e.hireDate);
      const to = e.endDate === null ? end : minDate(end, e.endDate);
      for (const date of from <= to ? datesBetween(from, to) : []) {
        const r = data.day(e, date, { canManage: false, withPunches: false }).result;
        item.lateMinutes += r.lateMinutes;
        item.earlyDepartureMinutes += r.earlyDepartureMinutes;
        item.workedMinutes += r.workedMinutes;
        item.scheduledMinutes += r.scheduledMinutes;
        if (r.status === 'present') item.counts.present++;
        else if (r.status === 'late') item.counts.late++;
        else if (r.status === 'absent') {
          item.counts.absent++;
          item.absentDates.push(date);
        } else if (r.status === 'incomplete') {
          item.counts.incomplete++;
          item.incompleteDates.push(date);
        } else if (r.status === 'on_leave') item.counts.onLeave++;
        else if (r.status === 'holiday') item.counts.holiday++;
        else if (r.status === 'rest_day') item.counts.restDay++;
      }
      return item;
    });
  }

  /** GET /attendance/reports/monthly (paged). */
  async monthly(query: MonthlyQuery): Promise<MonthlyReportView> {
    const { companyId } = caller();
    const { month, first, end } = this.period(query.month);
    const employees = await this.employees(companyId, first, end, query);
    const page = employees.slice((query.page - 1) * query.pageSize, query.page * query.pageSize);
    return {
      month,
      days: daysBetween(first, end) + 1,
      items: await this.items(companyId, page, first, end),
      total: employees.length,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /** GET /attendance/reports/monthly.csv: every row (≤ 5 000), header in `lang`; audited `attendance.report_exported`. */
  async monthlyCsv(query: MonthlyQuery): Promise<{ filename: string; body: string }> {
    const { companyId } = caller();
    const { month, first, end } = this.period(query.month);
    const lang = query.lang === 'ar' ? 'ar' : 'fr';
    const items = await this.items(companyId, await this.employees(companyId, first, end, { ...query, lang }), first, end);
    const rows: (string | number)[][] = [HEADERS[lang]];
    for (const i of items) {
      const p = i.employee.person;
      const arabic = lang === 'ar';
      rows.push([
        i.employee.matricule,
        arabic ? p.lastNameAr?.trim() || p.lastName : p.lastName,
        arabic ? p.firstNameAr?.trim() || p.firstName : p.firstName,
        arabic ? i.employee.unit.nameAr?.trim() || i.employee.unit.name : i.employee.unit.name,
        i.counts.present,
        i.counts.late,
        i.lateMinutes,
        i.counts.absent,
        i.counts.incomplete,
        i.counts.onLeave,
        i.counts.holiday,
        hoursMinutes(i.workedMinutes),
        hoursMinutes(i.scheduledMinutes),
        i.absentDates.join(','),
      ]);
    }
    await this.audit.record({ type: 'attendance.report_exported', subject: null, data: { month, unitId: query.unitId ?? null, rows: items.length } });
    return { filename: `presence-${month}.csv`, body: toCsv(rows) };
  }
}

/** The day that decides an employee's unit in the report: min(period end, employment end). */
function refDate(e: EmploymentFacts, end: string): string {
  return e.endDate !== null && e.endDate < end ? e.endDate : end;
}
