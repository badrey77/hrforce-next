import { Injectable, NotFoundException } from '@nestjs/common';
import { ScopeService } from '../../../platform/authz/scope-service.js';
import { requireContext } from '../../../platform/context/request-context.js';
import { ProblemException, ValidationProblemException } from '../../../platform/http/problem-details.js';
import { StaffingService } from '../../staffing/index.js';
import { DAY_STATUSES, type DayResult, type DayStatus } from '../domain/day.js';
import { addDays, daysBetween, datesBetween, isIsoDate, monthEnd, monthStart } from '../domain/time.js';
import { AttendanceRepository, type EmploymentFacts } from '../infra/attendance.repository.js';
import { SchedulesRepository } from '../infra/schedules.repository.js';
import { AttendanceClock } from './attendance-clock.js';
import type {
  Counts,
  DayTotals,
  EmployeeDaysView,
  MyDaysView,
  PresenceBoardView,
  ScheduleSegmentsView,
  TeamPresenceView,
  UnitRef,
} from './attendance-views.js';
import { assignmentOn, PresenceEngine, type OrgBook, type PresenceData } from './presence-engine.js';

export const ATTENDANCE_PERMISSIONS = {
  punchSelf: 'attendance.punch_self',
  read: 'attendance.read',
  manage: 'attendance.manage',
  configure: 'attendance.configure',
} as const;
const P = ATTENDANCE_PERMISSIONS;

/** Most employees one board / team request may compute (docs/contracts/attendance.md › GET /attendance/presence). */
export const BOARD_MAX_EMPLOYEES = 5000;
const DAYS_MAX_RANGE = 62;
const SEGMENTS_MAX_RANGE = 366;
const TEAM_MAX_AGE_DAYS = 31;

export type BoardSort = 'unit' | 'name' | 'arrival' | 'status';

export interface BoardQuery {
  date?: string | undefined;
  unitId?: string | undefined;
  includeSubUnits: boolean;
  siteId?: string | undefined;
  status?: Exclude<DayStatus, 'not_employed'> | undefined;
  q?: string | undefined;
  sort: BoardSort;
  lang: 'fr' | 'ar' | 'en';
  page: number;
  pageSize: number;
}

export interface RangeQuery {
  from?: string | undefined;
  to?: string | undefined;
}

export function caller(): { companyId: string; userId: string } {
  const { companyId, userId } = requireContext();
  if (!companyId || !userId) throw new NotFoundException();
  return { companyId, userId };
}

export function notLinked(): ProblemException {
  return new ProblemException(409, 'attendance-not-linked', 'No employee is linked to your account.');
}

const employeeNotFound = () => new NotFoundException('Employee not found');

function emptyCounts(): Counts {
  return { present: 0, late: 0, absent: 0, incomplete: 0, expected: 0, on_leave: 0, holiday: 0, rest_day: 0, total: 0 };
}

function totalsOf(results: readonly DayResult[]): DayTotals {
  const t: DayTotals = { workedMinutes: 0, scheduledMinutes: 0, lateDays: 0, lateMinutes: 0, absentDays: 0, incompleteDays: 0, leaveDays: 0, earlyDepartureDays: 0 };
  for (const r of results) {
    t.workedMinutes += r.workedMinutes;
    t.scheduledMinutes += r.scheduledMinutes;
    t.lateMinutes += r.lateMinutes;
    if (r.status === 'late') t.lateDays++;
    if (r.status === 'absent') t.absentDays++;
    if (r.status === 'incomplete') t.incompleteDays++;
    if (r.status === 'on_leave') t.leaveDays++;
    if (r.flags.includes('early_departure')) t.earlyDepartureDays++;
  }
  return t;
}

/**
 * The days a correction may be asked for today (Phase B): [max(today − maxAgeDays, hire), min(today, end)], or null
 * when empty.
 */
export function correctionWindowOf(today: string, maxAgeDays: number, e: { hireDate: string; endDate: string | null }): { from: string; to: string } | null {
  const earliest = addDays(today, -maxAgeDays);
  const from = e.hireDate > earliest ? e.hireDate : earliest;
  const to = e.endDate !== null && e.endDate < today ? e.endDate : today;
  return from <= to ? { from, to } : null;
}

const fr = new Intl.Collator('fr', { sensitivity: 'base' });
const ar = new Intl.Collator('ar', { sensitivity: 'base' });

/**
 * Presence views (docs/contracts/attendance.md › Daily computation, Scope, Endpoints): the HR board, the unit heads'
 * team view, the employee's own days, an employee's days and schedule segments. Everything is computed on read in the
 * request transaction.
 */
@Injectable()
export class PresenceService {
  constructor(
    private readonly repo: AttendanceRepository,
    private readonly schedules: SchedulesRepository,
    private readonly engine: PresenceEngine,
    private readonly scopes: ScopeService,
    private readonly staffing: StaffingService,
    private readonly clock: AttendanceClock,
  ) {}

  // ── scope helpers ─────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * The employee's scope unit TODAY (employment.md › Scope) when `permission` covers it; 404 when unknown, of another
   * company or outside attendance.read; 403 `forbidden-scope` when readable but outside `permission`.
   */
  async employeeInScope(employmentId: string, permission: string): Promise<string> {
    const { companyId } = caller();
    const unitId = await this.repo.scopeUnit(companyId, employmentId, this.clock.today());
    if (!unitId || !(await this.scopes.inScope(P.read, unitId))) throw employeeNotFound();
    if (permission !== P.read && !(await this.scopes.inScope(permission, unitId))) {
      throw new ProblemException(403, 'forbidden-scope', `You cannot do this for this employee (outside your ${permission} scope).`);
    }
    return unitId;
  }

  /** attendance.manage over the employee and not the caller's own employment. */
  async canManage(employmentId: string, unitId: string): Promise<boolean> {
    const { companyId, userId } = caller();
    if ((await this.repo.linkedEmployment(companyId, userId)) === employmentId) return false;
    return this.scopes.inScope(P.manage, unitId);
  }

  // ── ranges ────────────────────────────────────────────────────────────────────────────────────────────────────

  /** from/to of the day routes: default today; to ≤ today; from ≤ to; at most 62 days. */
  private dayRange(query: RangeQuery): { from: string; to: string } {
    const today = this.clock.today();
    const to = query.to ?? (query.from && query.from > today ? query.from : today);
    const from = query.from ?? to;
    const errors: { field: string; code: string; message: string }[] = [];
    if (!isIsoDate(from)) errors.push({ field: 'from', code: 'invalid', message: 'A date written YYYY-MM-DD.' });
    if (!isIsoDate(to)) errors.push({ field: 'to', code: 'invalid', message: 'A date written YYYY-MM-DD.' });
    if (errors.length === 0) {
      if (to > today) errors.push({ field: 'to', code: 'future', message: 'Not after today.' });
      else if (from > to) errors.push({ field: 'from', code: 'invalid', message: 'Not after `to`.' });
      else if (daysBetween(from, to) + 1 > DAYS_MAX_RANGE) errors.push({ field: 'from', code: 'range_too_long', message: `At most ${DAYS_MAX_RANGE} days.` });
    }
    if (errors.length > 0) throw new ValidationProblemException(errors);
    return { from, to };
  }

  // ── self ──────────────────────────────────────────────────────────────────────────────────────────────────────

  async myDays(query: RangeQuery): Promise<MyDaysView> {
    const { companyId, userId } = caller();
    const employmentId = await this.repo.linkedEmployment(companyId, userId);
    if (!employmentId) throw notLinked();
    const { from, to } = this.dayRange(query);
    return this.daysView(companyId, employmentId, from, to, false);
  }

  // ── HR: one employee ──────────────────────────────────────────────────────────────────────────────────────────

  async employeeDays(employmentId: string, query: RangeQuery): Promise<EmployeeDaysView> {
    const { companyId } = caller();
    const unitId = await this.employeeInScope(employmentId, P.read);
    const { from, to } = this.dayRange(query);
    const canManage = await this.canManage(employmentId, unitId);
    return { ...(await this.daysView(companyId, employmentId, from, to, canManage)), canManage };
  }

  private async daysView(companyId: string, employmentId: string, from: string, to: string, canManage: boolean): Promise<MyDaysView> {
    const [data, policy] = await Promise.all([this.engine.load(companyId, [employmentId], from, to), this.schedules.policy(companyId)]);
    const e = data.employment(employmentId);
    if (!e) throw employeeNotFound();
    const days = datesBetween(from, to).map((date) => data.day(e, date, { canManage, withPunches: true }));
    return {
      from,
      to,
      employee: data.employeeRef(e, to),
      items: days.map((d) => d.view),
      totals: totalsOf(days.map((d) => d.result)),
      retentionMonths: policy.retentionMonths,
      correctionWindow: correctionWindowOf(this.clock.today(), policy.correctionMaxAgeDays, e),
    };
  }

  async employeeSchedule(employmentId: string, query: RangeQuery): Promise<ScheduleSegmentsView> {
    const { companyId } = caller();
    await this.employeeInScope(employmentId, P.read);
    const today = this.clock.today();
    const from = query.from ?? (query.to ? query.to.slice(0, 8) + '01' : monthStart(today));
    const to = query.to ?? (query.from ? monthEnd(query.from) : monthEnd(today));
    const errors: { field: string; code: string; message: string }[] = [];
    if (!isIsoDate(from)) errors.push({ field: 'from', code: 'invalid', message: 'A date written YYYY-MM-DD.' });
    if (!isIsoDate(to)) errors.push({ field: 'to', code: 'invalid', message: 'A date written YYYY-MM-DD.' });
    if (errors.length === 0 && from > to) errors.push({ field: 'from', code: 'invalid', message: 'Not after `to`.' });
    if (errors.length === 0 && daysBetween(from, to) + 1 > SEGMENTS_MAX_RANGE) errors.push({ field: 'from', code: 'range_too_long', message: `At most ${SEGMENTS_MAX_RANGE} days.` });
    if (errors.length > 0) throw new ValidationProblemException(errors);

    const data = await this.engine.load(companyId, [employmentId], from, to);
    const e = data.employment(employmentId);
    if (!e) throw employeeNotFound();
    const items: ScheduleSegmentsView['items'] = [];
    let lastKey = '';
    let lastDate = '';
    for (const date of datesBetween(from, to)) {
      if (e.hireDate > date || (e.endDate !== null && e.endDate < date)) continue;
      const resolved = data.resolve(e, date);
      const schedule = resolved ? data.scheduleRow(resolved.assignment.scheduleId) : undefined;
      if (!resolved || !schedule) continue;
      const overrides = data.overridesFor(schedule.id).filter((o) => o.from <= date && date < o.toExclusive);
      const sourceRef = this.sourceRef(data, e, resolved.source, resolved.assignment.targetId, date);
      const key = `${schedule.id}|${resolved.source}|${sourceRef?.id ?? ''}|${overrides.map((o) => o.id).join(',')}`;
      const last = items.at(-1);
      if (last && key === lastKey && addDays(lastDate, 1) === date) {
        last.to = date;
      } else {
        items.push({
          from: date,
          to: date,
          schedule: { id: schedule.id, code: schedule.code, labels: { fr: schedule.nameFr, ar: schedule.nameAr, en: schedule.nameEn } },
          source: resolved.source,
          sourceRef,
          overrides: overrides.map((o) => ({ id: o.id, labels: o.labels, from: o.from, to: addDays(o.toExclusive, -1) })),
        });
      }
      lastKey = key;
      lastDate = date;
    }
    return { items };
  }

  private sourceRef(data: PresenceData, e: EmploymentFacts, source: string, targetId: string | null, date: string): ScheduleSegmentsView['items'][number]['sourceRef'] {
    if (source === 'employment') return { kind: 'employment', id: e.id, code: e.matricule, name: `${e.firstName} ${e.lastName}` };
    if (source === 'unit' && targetId) {
      const u = data.org.unitRef(targetId, date);
      return { kind: 'unit', id: targetId, code: u.code, name: u.name };
    }
    if (source === 'site' && targetId) {
      const s = data.org.siteRef(targetId);
      return { kind: 'site', id: targetId, code: s?.code ?? '', name: s?.name ?? '' };
    }
    return null;
  }

  // ── boards ────────────────────────────────────────────────────────────────────────────────────────────────────

  async board(query: BoardQuery): Promise<PresenceBoardView> {
    const { companyId } = caller();
    const today = this.clock.today();
    const date = query.date ?? today;
    if (date > today) throw new ValidationProblemException([{ field: 'date', code: 'future', message: 'Not after today.' }]);
    const org = await this.engine.orgBook(companyId);
    let candidates = await this.repo.activeOn(companyId, date, await this.scopes.scopeOf(P.read), query.q);
    if (query.unitId) {
      const units = query.includeSubUnits ? org.subtree([query.unitId], date) : new Set([query.unitId]);
      candidates = candidates.filter((c) => units.has(c.unitId));
    }
    return this.boardOf(companyId, org, date, candidates.map((c) => c.id), query);
  }

  async team(query: Omit<BoardQuery, 'unitId' | 'includeSubUnits' | 'siteId'>): Promise<TeamPresenceView> {
    const { companyId, userId } = caller();
    const today = this.clock.today();
    const date = query.date ?? today;
    if (date > today || date < addDays(today, -TEAM_MAX_AGE_DAYS)) {
      throw new ValidationProblemException([{ field: 'date', code: date > today ? 'future' : 'too_old', message: `Between ${TEAM_MAX_AGE_DAYS} days ago and today.` }]);
    }
    const org = await this.engine.orgBook(companyId);
    const employmentId = await this.repo.linkedEmployment(companyId, userId);
    const headed = employmentId ? await this.staffing.unitsHeadedBy(employmentId, date) : [];
    const units: UnitRef[] = headed.map((id) => org.unitRef(id, date));
    const covered = [...org.subtree(headed, date)];
    const candidates = covered.length > 0 ? await this.repo.activeOn(companyId, date, covered, query.q) : [];
    const board = await this.boardOf(companyId, org, date, candidates.map((c) => c.id), query);
    return { ...board, units };
  }

  private async boardOf(
    companyId: string,
    org: OrgBook,
    date: string,
    employmentIds: string[],
    query: Pick<BoardQuery, 'siteId' | 'status' | 'sort' | 'lang' | 'page' | 'pageSize'>,
  ): Promise<PresenceBoardView> {
    if (employmentIds.length > BOARD_MAX_EMPLOYEES) {
      throw new ValidationProblemException([{ field: 'unitId', code: 'too_many', message: `More than ${BOARD_MAX_EMPLOYEES} employees: choose a unit.` }]);
    }
    const data = await this.engine.load(companyId, employmentIds, date, date, org);
    const manageUnits = await this.scopes.unitIds(P.manage);
    const { userId } = caller();
    const own = await this.repo.linkedEmployment(companyId, userId);
    const today = this.clock.today();
    let rows = employmentIds
      .map((id) => data.employment(id))
      .filter((e): e is EmploymentFacts => e !== undefined)
      .map((e) => {
        const scopeUnit = assignmentOn(e, today)?.orgUnitId;
        const canManage = e.id !== own && scopeUnit !== undefined && manageUnits.has(scopeUnit);
        return { e, ...data.day(e, date, { canManage, withPunches: false }) };
      })
      .filter((r) => r.result.status !== 'not_employed');
    if (query.siteId) rows = rows.filter((r) => r.view.employee.site?.id === query.siteId);
    if (rows.length > BOARD_MAX_EMPLOYEES) {
      throw new ValidationProblemException([{ field: 'unitId', code: 'too_many', message: `More than ${BOARD_MAX_EMPLOYEES} employees: choose a unit.` }]);
    }
    const counts = emptyCounts();
    for (const r of rows) {
      const s = r.result.status as Exclude<DayStatus, 'not_employed'>;
      counts[s]++;
      counts.total++;
    }
    if (query.status) rows = rows.filter((r) => r.result.status === query.status);
    const name = (e: EmploymentFacts) =>
      query.lang === 'ar'
        ? `${(e.lastNameAr ?? '').trim() || e.lastName} ${(e.firstNameAr ?? '').trim() || e.firstName}`
        : e.sortName || `${e.lastName} ${e.firstName}`;
    const byName = (a: (typeof rows)[number], b: (typeof rows)[number]) =>
      (query.lang === 'ar' ? ar : fr).compare(name(a.e), name(b.e)) || (a.e.matricule < b.e.matricule ? -1 : a.e.matricule > b.e.matricule ? 1 : 0);
    const compare: Record<BoardSort, (a: (typeof rows)[number], b: (typeof rows)[number]) => number> = {
      unit: (a, b) => fr.compare(a.view.employee.unit.name, b.view.employee.unit.name) || byName(a, b),
      name: byName,
      arrival: (a, b) => {
        const x = a.view.arrival?.occurredAt ?? '~';
        const y = b.view.arrival?.occurredAt ?? '~';
        return x < y ? -1 : x > y ? 1 : byName(a, b);
      },
      status: (a, b) => DAY_STATUSES.indexOf(a.result.status) - DAY_STATUSES.indexOf(b.result.status) || byName(a, b),
    };
    rows.sort((a, b) => compare[query.sort](a, b) || (a.e.id < b.e.id ? -1 : 1));
    const total = rows.length;
    const items = rows.slice((query.page - 1) * query.pageSize, query.page * query.pageSize).map((r) => r.view);
    return { date, final: date < today, asOf: new Date(this.clock.nowMs()).toISOString(), counts, items, total, page: query.page, pageSize: query.pageSize };
  }
}
