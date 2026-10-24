import { Injectable } from '@nestjs/common';
import { algiersDate, assignmentOn, PresenceEngine, type EmploymentFacts, type KioskSpan, type OrgBook, type PresenceData } from '../../attendance/index.js';
import { LeaveFacts, leaveDaysWithin, type PayrollLeaveInputs } from '../../leave/index.js';
import {
  attendanceDates,
  attendanceInUse,
  computeMonth,
  employmentWindow,
  type AttendanceDayFact,
  type LeaveRequestFact,
  type MonthResult,
} from '../domain/computation.js';
import { buildLines, regularizationsOf, type AdjustmentFact, type Line, type Regularization, type RubriqueFact } from '../domain/lines.js';
import { lastDayOf, minDate, regularizationOrigins } from '../domain/period.js';
import { VariablesRepository, type ClosingRow, type LineRow, type NewLine, type PayrollPolicyFacts } from '../infra/variables.repository.js';
import { PayrollClock, payrollToday } from './payroll-clock.js';

/** Employments computed per chunk: the presence data scans its leave requests per day, so it stays small. */
const CHUNK = 200;

/** What one request knows about the company's payroll months (loaded once). */
export interface PayrollBook {
  companyId: string;
  today: string;
  policy: PayrollPolicyFacts;
  rubriques: RubriqueFact[];
  /** first day → status (months without a row are open) */
  status: ReadonlyMap<string, 'open' | 'closed'>;
  /** every closing of the company, oldest month and version first */
  closings: readonly ClosingRow[];
  org: OrgBook;
}

/** One employment's month: the computed result (open months) and its lines. */
export interface EmployeeMonth {
  employment: EmploymentFacts;
  /** the day that decides the unit: the month's last employed day (as the attendance monthly report) */
  refDate: string;
  unitId: string | null;
  /** employed on at least one day of the month (else only régularisation lines brought it in) */
  employedInMonth: boolean;
  /** null for a closed month (the snapshot has no flags) */
  result: MonthResult | null;
  lines: Line[];
}

/** The month's last employed day: min(month end, employment end, today), never before the hire date. */
export function refDateOf(e: Pick<EmploymentFacts, 'hireDate' | 'endDate'>, month: string, today: string): string {
  let at = minDate(lastDayOf(month), today);
  if (e.endDate !== null && e.endDate < at) at = e.endDate;
  if (at < e.hireDate) at = minDate(e.hireDate, lastDayOf(month));
  return at;
}

/** The current (not reopened) closing of each month. */
export function currentClosings(closings: readonly ClosingRow[]): Map<string, ClosingRow> {
  const out = new Map<string, ClosingRow>();
  for (const c of closings) if (c.reopenedAt === null) out.set(c.month, c);
  return out;
}

/**
 * The payroll computation (docs/contracts/payroll-variables.md › Computation): reads Leave (approved / pending requests,
 * day counting), Attendance (the daily computation, kiosks) and Employment through their public surfaces, for many
 * employments at once (a few queries per chunk of {@link CHUNK}, never per employee), and builds each employment's
 * lines for an open month — computed values, régularisations of the closed months of the window, HR's adjustments.
 */
@Injectable()
export class PayrollEngine {
  constructor(
    private readonly repo: VariablesRepository,
    private readonly presence: PresenceEngine,
    private readonly leave: LeaveFacts,
    private readonly clock: PayrollClock,
  ) {}

  async book(companyId: string): Promise<PayrollBook> {
    const [policy, rubriques, periods, closings, org] = await Promise.all([
      this.repo.policy(companyId),
      this.repo.rubriques(companyId),
      this.repo.periods(companyId),
      this.repo.closings(companyId, null),
      this.presence.orgBook(companyId),
    ]);
    return { companyId, today: this.clock.today(), policy, rubriques, status: new Map(periods.map((p) => [p.month, p.status])), closings, org };
  }

  /** The closed months whose régularisations come into open month `month`. */
  origins(book: PayrollBook, month: string): string[] {
    const closed = [...currentClosings(book.closings).keys()].filter((m) => book.status.get(m) === 'closed');
    return regularizationOrigins(month, book.policy.regularizationMonths, closed);
  }

  /** The first day the open month's computation reads (its oldest régularisation month, else the month). */
  rangeStart(book: PayrollBook, month: string): string {
    return this.origins(book, month)[0] ?? month;
  }

  /** The instant the attendance days are computed at (the payroll clock's day; the real instant when it is today). */
  private nowMs(today: string): number {
    const now = Date.now();
    return algiersDate(now) === today && payrollToday() === today ? now : Date.parse(`${today}T11:00:00Z`);
  }

  /**
   * The lines of open month `month` for the employments (already filtered by scope; active on a day of
   * [rangeStart, month end]). Employments neither employed in the month nor with a line are left out.
   */
  async live(book: PayrollBook, month: string, employments: readonly EmploymentFacts[]): Promise<EmployeeMonth[]> {
    if (employments.length === 0) return [];
    const { companyId, today } = book;
    const origins = this.origins(book, month);
    const from = origins[0] ?? month;
    const last = lastDayOf(month);
    const current = currentClosings(book.closings);
    // the current closings of every month from the oldest origin to the month before: their lines of the origins
    const closingIds = [...current.values()].filter((c) => c.month >= from && c.month < month && book.status.get(c.month) === 'closed').map((c) => c.id);
    const closingMonth = new Map(book.closings.map((c) => [c.id, c.month]));
    const spans = await this.presence.kioskSpans(companyId);
    const out: EmployeeMonth[] = [];
    for (let i = 0; i < employments.length; i += CHUNK) {
      const chunk = employments.slice(i, i + CHUNK);
      const chunkIds = chunk.map((e) => e.id);
      const attendanceTo = minDate(last, today);
      const [presence, leave, adjustments, closedLines] = await Promise.all([
        from <= attendanceTo ? this.presence.load(companyId, chunkIds, from, attendanceTo, book.org, { nowMs: this.nowMs(today) }) : Promise.resolve(null),
        this.leave.payrollInputs(companyId, chunkIds, from, last),
        this.repo.adjustments(companyId, month, chunkIds),
        this.repo.lines(companyId, closingIds, chunkIds),
      ]);
      const counter = leaveCounter(leave);
      const requestsBy = groupBy(leave.requests, (r) => r.employmentId);
      const adjustmentsBy = groupBy(adjustments, (a) => a.employmentId);
      const linesBy = groupBy(closedLines, (l) => l.employmentId);
      for (const e of chunk) {
        const requests: LeaveRequestFact[] = requestsBy.get(e.id) ?? [];
        const monthOfE = (m: string): MonthResult =>
          computeMonth({
            month: m,
            today,
            employment: e,
            leave: requests,
            days: presence ? attendanceDays(presence, spans, e, m, today) : [],
            overtimeMinMinutes: book.policy.overtimeMinMinutes,
            countLeaveDays: counter,
          });
        const result = monthOfE(month);
        const regularizations: Regularization[] = [];
        const own = linesBy.get(e.id) ?? [];
        for (const origin of origins) {
          const closing = current.get(origin);
          if (!closing) continue;
          regularizations.push(
            ...regularizationsOf({
              origin,
              rubriques: book.rubriques,
              recomputed: employmentWindow(origin, e) ? monthOfE(origin).values : new Map(),
              closed: own.filter((l) => l.closingId === closing.id),
              later: own.filter((l) => l.closingId !== closing.id && l.originMonth === origin && (closingMonth.get(l.closingId) ?? '') > origin),
            }),
          );
        }
        const lines = buildLines({ month, rubriques: book.rubriques, values: result.values, regularizations, adjustments: (adjustmentsBy.get(e.id) ?? []) as AdjustmentFact[] });
        const employedInMonth = employmentWindow(month, e) !== null;
        if (!employedInMonth && lines.length === 0) continue;
        const refDate = refDateOf(e, month, today);
        out.push({ employment: e, refDate, unitId: assignmentOn(e, refDate)?.orgUnitId ?? null, employedInMonth, result, lines });
      }
    }
    return out;
  }

  /**
   * Writes the closing of open month `month` (the caller holds the period row locked and checked the rules): every
   * employee of the company, every line (zero values left out, but HR's 0 over a computed value kept) with the export
   * snapshot (matricule paie or matricule, names, unit code), the closing row (next version) and the period's status.
   */
  async close(book: PayrollBook, month: string, periodId: string, closedBy: string): Promise<{ version: number; lines: number; employees: number }> {
    const { companyId } = book;
    const ids = await this.repo.activeIn(companyId, this.rangeStart(book, month), lastDayOf(month));
    const rows = await this.live(book, month, await this.repo.employments(companyId, ids));
    const codes = await this.repo.employeeCodes(companyId, null);
    const rubriques = new Map(book.rubriques.map((r) => [r.id, r]));
    const lines: NewLine[] = [];
    const employees = new Set<string>();
    let exported = 0;
    for (const row of rows) {
      const e = row.employment;
      const unitCode = row.unitId ? book.org.unitRef(row.unitId, row.refDate).code || null : null;
      for (const l of row.lines) {
        const r = rubriques.get(l.rubriqueId);
        if (!r) continue;
        if (l.value !== 0) {
          exported += 1;
          employees.add(e.id);
        }
        lines.push({
          employmentId: e.id,
          rubriqueId: l.rubriqueId,
          originMonth: l.originMonth,
          computedValue: l.computed,
          value: l.value,
          adjusted: l.adjusted,
          note: l.note,
          exportCode: r.exportCode,
          unit: r.unit,
          matricule: codes.get(e.id) ?? e.matricule,
          lastName: e.lastName,
          firstName: e.firstName,
          unitCode,
        });
      }
    }
    const version = Math.max(0, ...book.closings.filter((c) => c.periodId === periodId).map((c) => c.version)) + 1;
    const closingId = await this.repo.insertClosing(companyId, { periodId, version, closedBy, lines: exported, employees: employees.size });
    await this.repo.insertLines(companyId, closingId, lines);
    await this.repo.setPeriodStatus(companyId, periodId, 'closed');
    return { version, lines: exported, employees: employees.size };
  }

  /** The lines of closed month `month` from its current closing (of some employments, or all of them). */
  async snapshot(book: PayrollBook, month: string, employmentIds: readonly string[] | null): Promise<{ closing: ClosingRow; lines: LineRow[] } | null> {
    const closing = currentClosings(book.closings).get(month);
    if (!closing) return null;
    return { closing, lines: await this.repo.lines(book.companyId, [closing.id], employmentIds) };
  }
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return out;
}

/** Leave's own day counting, with the company's weekend, holidays and each type's counting mode. */
function leaveCounter(inputs: PayrollLeaveInputs): (r: LeaveRequestFact, from: string, to: string) => number {
  const modes = new Map(inputs.requests.map((r) => [r.leaveTypeId, r.countMode]));
  return (r, from, to) => leaveDaysWithin(r, from, to, { countMode: modes.get(r.leaveTypeId) ?? 'calendar', weekendDays: inputs.weekendDays, holidays: inputs.holidays });
}

/**
 * The attendance days of the employed days of `month` up to today. A day without any punch where attendance is not in
 * use contributes nothing (no absence, lateness or overtime there), so the daily computation is skipped for it.
 */
function attendanceDays(data: PresenceData, spans: readonly KioskSpan[], e: EmploymentFacts, month: string, today: string): AttendanceDayFact[] {
  const out: AttendanceDayFact[] = [];
  for (const date of attendanceDates(month, e, today)) {
    const inUse = attendanceInUse(spans, data.placement(e, date)?.siteId ?? null, date);
    if (!inUse && data.punchesOf(e.id, date).length === 0) {
      out.push({ date, status: 'not_tracked', final: date < today, lateMinutes: 0, workedMinutes: 0, scheduledMinutes: 0, inUse: false });
      continue;
    }
    const r = data.day(e, date, { canManage: false, withPunches: false }).result;
    out.push({ date, status: r.status, final: r.final, lateMinutes: r.lateMinutes, workedMinutes: r.workedMinutes, scheduledMinutes: r.scheduledMinutes, inUse });
  }
  return out;
}
