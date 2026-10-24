import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditEvents } from '../../../platform/audit/audit-events.js';
import { ScopeService } from '../../../platform/authz/scope-service.js';
import { requireContext } from '../../../platform/context/request-context.js';
import { ProblemException, ValidationProblemException } from '../../../platform/http/problem-details.js';
import { assignmentOn, employeeRefOn, type EmploymentFacts } from '../../attendance/index.js';
import { employmentWindow, type PayrollSource } from '../domain/computation.js';
import type { Line, RubriqueFact } from '../domain/lines.js';
import { closeRefusal, cutoffDate, isLatestClosed, lastDayOf, minDate, monthKey, monthOf, parseMonth, type PeriodState } from '../domain/period.js';
import { PAYROLL_PERMISSIONS as P } from '../domain/settings.js';
import { VariablesRepository, type ClosingRow, type LineRow } from '../infra/variables.repository.js';
import { currentClosings, PayrollEngine, refDateOf, type EmployeeMonth, type PayrollBook } from './payroll-engine.js';
import type { PayrollExportLine, PayrollLinesQuery, PayrollLinesResult, PayrollLinesSource } from './payroll-lines.port.js';
import type { EmployeeFlag, EmployeeVariables, PayrollLineView, PeriodAction, PeriodSummary, PeriodView, UserRef, VariablesPage } from './variables-views.js';

const SALARY_READ = 'employee.salary.read';
const SALARY_UPDATE = 'employee.salary.update';

type ScopePermission = 'payroll.read' | 'payroll.prepare' | 'payroll.export' | 'payroll.configure';

export interface VariablesQuery {
  unitId?: string | undefined;
  includeSubUnits: boolean;
  q?: string | undefined;
  rubriqueId?: string | undefined;
  filter?: 'adjusted' | 'regularization' | 'flagged' | undefined;
  lang: 'fr' | 'ar' | 'en';
  page: number;
  pageSize: number;
}

export interface LineInput {
  rubriqueId: string;
  originMonth?: string | undefined;
  value: number;
  note: string | null;
}

interface Filter {
  unitId?: string | undefined;
  includeSubUnits?: boolean | undefined;
  q?: string | undefined;
}

/** The employees of a month in a scope, with their lines (live for an open month, the snapshot for a closed one). */
interface MonthData {
  status: 'open' | 'closed';
  closing: ClosingRow | null;
  rows: EmployeeMonth[];
  /** closed months: the snapshot lines by employment (export fields) */
  snapshot: Map<string, LineRow[]>;
}

const fr = new Intl.Collator('fr', { sensitivity: 'base' });
const ar = new Intl.Collator('ar', { sensitivity: 'base' });

function caller(): { companyId: string; userId: string } {
  const { companyId, userId } = requireContext();
  if (!companyId || !userId) throw new NotFoundException();
  return { companyId, userId };
}

const notFound = () => new NotFoundException('Employee not found');
const closedProblem = () => new ProblemException(409, 'payroll-period-closed', 'This month is closed: reopen it to change its variables.');
const invalidOrigin = () => new ValidationProblemException([{ field: 'originMonth', code: 'invalid', message: 'No régularisation line for this month.' }]);

/**
 * Payroll variables, periods, closings (docs/contracts/payroll-variables.md › Endpoints, API builder 2): the month's
 * lines in the caller's scope (the employee's assignment unit on the month's last employed day), HR's adjustments,
 * close (one transaction under a lock on the period row: the snapshot) and reopen. Also the lines port of the export
 * and control endpoints.
 */
@Injectable()
export class VariablesService implements PayrollLinesSource {
  constructor(
    private readonly engine: PayrollEngine,
    private readonly repo: VariablesRepository,
    private readonly scopes: ScopeService,
    private readonly audit: AuditEvents,
  ) {}

  /** `YYYY-MM` → first day; 422 `month` invalid / future. */
  private month(value: string, today: string): string {
    const month = parseMonth(value);
    if (!month) throw new ValidationProblemException([{ field: 'month', code: 'invalid', message: 'A month written YYYY-MM.' }]);
    if (month > monthOf(today)) throw new ValidationProblemException([{ field: 'month', code: 'future', message: 'Not after the current month.' }]);
    return month;
  }

  private status(book: PayrollBook, month: string): 'open' | 'closed' {
    return book.status.get(month) === 'closed' ? 'closed' : 'open';
  }

  /** The employments of `ids` in the scope of `permission` (by their unit on the month's last employed day) and the filter. */
  private async inScope(book: PayrollBook, month: string, ids: readonly string[], permission: ScopePermission, filter: Filter): Promise<EmploymentFacts[]> {
    if (ids.length === 0) return [];
    const [facts, readable] = await Promise.all([this.repo.employments(book.companyId, ids), this.scopes.unitIds(permission)]);
    const at = minDate(lastDayOf(month), book.today);
    const units = filter.unitId ? (filter.includeSubUnits === false ? new Set([filter.unitId]) : book.org.subtree([filter.unitId], at)) : null;
    return facts.filter((e) => {
      const unit = assignmentOn(e, refDateOf(e, month, book.today))?.orgUnitId;
      return unit !== undefined && readable.has(unit) && (units === null || units.has(unit));
    });
  }

  /** The month's employees in scope: open → computed now; closed → the current closing's lines. */
  private async monthData(book: PayrollBook, month: string, permission: ScopePermission, filter: Filter, only?: string): Promise<MonthData> {
    const last = lastDayOf(month);
    if (this.status(book, month) === 'open') {
      const active = await this.repo.activeIn(book.companyId, this.engine.rangeStart(book, month), last, only ? undefined : filter.q);
      const facts = await this.inScope(book, month, only ? active.filter((id) => id === only) : active, permission, filter);
      return { status: 'open', closing: null, rows: await this.engine.live(book, month, facts), snapshot: new Map() };
    }
    const snap = await this.engine.snapshot(book, month, only ? [only] : null);
    const lines = snap?.lines ?? [];
    const byEmployment = new Map<string, LineRow[]>();
    for (const l of lines) byEmployment.set(l.employmentId, [...(byEmployment.get(l.employmentId) ?? []), l]);
    let ids = [...byEmployment.keys()];
    if (filter.q && ids.length > 0) {
      const matching = new Set(await this.repo.activeIn(book.companyId, '0001-01-01', '9999-12-31', filter.q));
      ids = ids.filter((id) => matching.has(id));
    }
    const facts = await this.inScope(book, month, ids, permission, filter);
    const rubriques = new Map(book.rubriques.map((r) => [r.id, r]));
    const rows: EmployeeMonth[] = facts.map((e) => {
      const refDate = refDateOf(e, month, book.today);
      return {
        employment: e,
        refDate,
        unitId: assignmentOn(e, refDate)?.orgUnitId ?? null,
        employedInMonth: employmentWindow(month, e) !== null,
        result: null,
        lines: (byEmployment.get(e.id) ?? []).map((l) => ({
          rubriqueId: l.rubriqueId,
          source: (rubriques.get(l.rubriqueId)?.source ?? 'manual') as PayrollSource,
          originMonth: l.originMonth,
          computed: l.computedValue,
          value: l.value,
          adjusted: l.adjusted,
          note: l.note,
        })),
      };
    });
    return { status: 'closed', closing: snap?.closing ?? null, rows, snapshot: byEmployment };
  }

  // ── views ─────────────────────────────────────────────────────────────────────────────────────────────────────

  private lineView(l: Line, r: RubriqueFact | undefined, snapshot?: LineRow): PayrollLineView {
    return {
      rubriqueId: l.rubriqueId,
      exportCode: snapshot?.exportCode ?? r?.exportCode ?? '',
      names: r?.names ?? { fr: '', ar: '', en: '' },
      unit: snapshot?.unit ?? r?.unit ?? 'days',
      source: l.source,
      originMonth: monthKey(l.originMonth),
      computed: l.computed,
      value: l.value,
      adjusted: l.adjusted,
      note: l.note,
    };
  }

  /** The lines a caller sees: amount lines only with employee.salary.read over the employee. */
  private visible(row: EmployeeMonth, book: PayrollBook, salaryRead: ReadonlySet<string>, data: MonthData): { line: Line; view: PayrollLineView }[] {
    const rubriques = new Map(book.rubriques.map((r) => [r.id, r]));
    const snapshot = data.snapshot.get(row.employment.id) ?? [];
    const canSeeAmounts = row.unitId !== null && salaryRead.has(row.unitId);
    return row.lines
      .map((line) => {
        const snap = snapshot.find((s) => s.rubriqueId === line.rubriqueId && s.originMonth === line.originMonth);
        return { line, view: this.lineView(line, rubriques.get(line.rubriqueId), snap) };
      })
      .filter(({ view }) => view.unit !== 'amount' || canSeeAmounts);
  }

  private employeeView(
    row: EmployeeMonth,
    book: PayrollBook,
    month: string,
    data: MonthData,
    ctx: { salaryRead: ReadonlySet<string>; prepare: ReadonlySet<string>; codes: ReadonlyMap<string, string> },
  ): EmployeeVariables {
    const e = row.employment;
    const r = row.result;
    const flags: EmployeeFlag[] = [];
    if (r && r.incompleteDays > 0) flags.push('incomplete_days');
    if (r?.pendingLeave) flags.push('pending_leave');
    if (r?.noAttendance) flags.push('no_attendance');
    const last = lastDayOf(month);
    return {
      employee: employeeRefOn(book.org, e, row.refDate),
      payrollCode: ctx.codes.get(e.id) ?? null,
      entry: e.hireDate >= month && e.hireDate <= last ? e.hireDate : null,
      exit: e.endDate !== null && e.endDate >= month && e.endDate <= last ? e.endDate : null,
      flags,
      incompleteDays: r?.incompleteDays ?? 0,
      lines: this.visible(row, book, ctx.salaryRead, data).map((v) => v.view),
      // `edit` = payroll.prepare over the employee, open or closed month: the month's lines are written only while it is
      // open (409 otherwise, and the web reads the status), but the payroll matricule stays editable after a close.
      _actions: row.unitId !== null && ctx.prepare.has(row.unitId) ? ['edit'] : [],
    };
  }

  private async viewContext(book: PayrollBook, rows: readonly EmployeeMonth[]) {
    const [salaryRead, prepare, codes] = await Promise.all([
      this.scopes.unitIds(SALARY_READ),
      this.scopes.unitIds(P.prepare),
      this.repo.employeeCodes(book.companyId, rows.map((r) => r.employment.id)),
    ]);
    return { salaryRead, prepare, codes };
  }

  private sorted(rows: EmployeeMonth[], lang: 'fr' | 'ar' | 'en'): EmployeeMonth[] {
    const name = (e: EmploymentFacts) =>
      lang === 'ar' ? `${(e.lastNameAr ?? '').trim() || e.lastName} ${(e.firstNameAr ?? '').trim() || e.firstName}` : e.sortName || `${e.lastName} ${e.firstName}`;
    const collator = lang === 'ar' ? ar : fr;
    return rows.toSorted(
      (a, b) =>
        collator.compare(name(a.employment), name(b.employment)) ||
        (a.employment.matricule < b.employment.matricule ? -1 : a.employment.matricule > b.employment.matricule ? 1 : 0),
    );
  }

  private user(members: ReadonlyMap<string, string>, id: string | null): UserRef | null {
    return id ? { id, displayName: members.get(id) ?? id } : null;
  }

  private periodStates(book: PayrollBook): PeriodState[] {
    const withClosings = new Set(book.closings.map((c) => c.month));
    return [...book.status].map(([month, status]) => ({ month, status, hasClosings: withClosings.has(month) }));
  }

  private summary(book: PayrollBook, month: string, members: ReadonlyMap<string, string>): PeriodSummary {
    const status = this.status(book, month);
    const closing = status === 'closed' ? (currentClosings(book.closings).get(month) ?? null) : null;
    return {
      month: monthKey(month),
      status,
      cutoffDate: cutoffDate(month, book.policy.cutoffDay),
      version: closing?.version ?? null,
      closedAt: closing?.closedAt.toISOString() ?? null,
      closedBy: closing ? this.user(members, closing.closedBy) : null,
    };
  }

  /** GET /payroll/periods?year= */
  async periods(year: number | undefined): Promise<{ items: PeriodSummary[] }> {
    const { companyId } = caller();
    const book = await this.engine.book(companyId);
    const current = monthOf(book.today);
    const y = year ?? Number(book.today.slice(0, 4));
    const members = await this.repo.members(companyId);
    const items: PeriodSummary[] = [];
    for (let m = 1; m <= 12; m += 1) {
      const month = `${y}-${String(m).padStart(2, '0')}-01`;
      if (month > current) break;
      items.push(this.summary(book, month, members));
    }
    return { items };
  }

  /** GET /payroll/periods/:month */
  async period(monthValue: string): Promise<PeriodView> {
    const { companyId } = caller();
    const book = await this.engine.book(companyId);
    return this.periodView(book, this.month(monthValue, book.today));
  }

  private async periodView(book: PayrollBook, month: string): Promise<PeriodView> {
    const data = await this.monthData(book, month, P.read, {});
    const [salaryRead, members, closeHeld, exportUnits] = await Promise.all([
      this.scopes.unitIds(SALARY_READ),
      this.repo.members(book.companyId),
      this.scopes.coversCompany(P.close),
      this.scopes.unitIds(P.export),
    ]);
    const totals = new Map<string, { employees: Set<string>; total: number }>();
    let lines = 0;
    let regularizations = 0;
    const employees = new Set<string>();
    const flags = { incompleteDays: 0, pendingLeave: 0, noAttendance: 0 };
    for (const row of data.rows) {
      for (const { line } of this.visible(row, book, salaryRead, data)) {
        if (line.value === 0) continue;
        lines += 1;
        employees.add(row.employment.id);
        if (line.originMonth !== month) regularizations += 1;
        const t = totals.get(line.rubriqueId) ?? { employees: new Set<string>(), total: 0 };
        t.employees.add(row.employment.id);
        t.total += line.value;
        totals.set(line.rubriqueId, t);
      }
      if (row.result) {
        flags.incompleteDays += row.result.incompleteDays;
        if (row.result.pendingLeave) flags.pendingLeave += 1;
        if (row.result.noAttendance) flags.noAttendance += 1;
      }
    }
    const status = this.status(book, month);
    const states = this.periodStates(book);
    const actions: PeriodAction[] = [];
    if (closeHeld && status === 'open' && closeRefusal(month, book.today, book.policy.cutoffDay, states) === null) actions.push('close');
    if (closeHeld && status === 'closed' && isLatestClosed(month, states)) actions.push('reopen');
    if (exportUnits.size > 0) actions.push(status === 'closed' ? 'export' : 'export_draft');
    return {
      ...this.summary(book, month, members),
      employees: employees.size,
      lines,
      totals: book.rubriques
        .filter((r) => totals.has(r.id))
        .map((r) => {
          const t = totals.get(r.id) as { employees: Set<string>; total: number };
          return { rubriqueId: r.id, exportCode: r.exportCode, names: r.names, unit: r.unit, employees: t.employees.size, total: Math.round(t.total * 100) / 100 };
        }),
      regularizations,
      flags,
      closings: book.closings
        .filter((c) => c.month === month)
        .map((c) => ({
          version: c.version,
          closedAt: c.closedAt.toISOString(),
          closedBy: this.user(members, c.closedBy),
          reopenedAt: c.reopenedAt?.toISOString() ?? null,
          reopenedBy: this.user(members, c.reopenedBy),
          reopenReason: c.reopenReason,
        })),
      _actions: actions,
    };
  }

  /** GET /payroll/periods/:month/variables */
  async variables(monthValue: string, query: VariablesQuery): Promise<VariablesPage> {
    const { companyId } = caller();
    const book = await this.engine.book(companyId);
    const month = this.month(monthValue, book.today);
    const data = await this.monthData(book, month, P.read, query);
    const ctx = await this.viewContext(book, data.rows);
    const views = this.sorted(data.rows, query.lang)
      .map((row) => ({ row, view: this.employeeView(row, book, month, data, ctx) }))
      .filter(({ view }) => {
        // a closed month lists the employees of its snapshot: one whose only lines are amounts the caller cannot see
        // is left out (listing them would tell that they had a bonus or an advance)
        if (data.status === 'closed' && view.lines.length === 0) return false;
        if (query.rubriqueId && !view.lines.some((l) => l.rubriqueId === query.rubriqueId)) return false;
        if (query.filter === 'adjusted') return view.lines.some((l) => l.adjusted);
        if (query.filter === 'regularization') return view.lines.some((l) => l.originMonth !== monthKey(month));
        if (query.filter === 'flagged') return view.flags.length > 0;
        return true;
      })
      .map(({ view }) => view);
    return {
      items: views.slice((query.page - 1) * query.pageSize, query.page * query.pageSize),
      total: views.length,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /** GET /payroll/periods/:month/variables/:employeeId */
  async employee(monthValue: string, employeeId: string): Promise<EmployeeVariables> {
    const { companyId } = caller();
    const book = await this.engine.book(companyId);
    const month = this.month(monthValue, book.today);
    return this.oneView(book, month, employeeId);
  }

  private async oneView(book: PayrollBook, month: string, employeeId: string): Promise<EmployeeVariables> {
    const data = await this.monthData(book, month, P.read, {}, employeeId);
    let row = data.rows[0];
    if (!row) {
      // a closed month without a line for the employee, or an open month where nothing brought them in: an empty view
      // when they were employed in the month and are readable
      const [facts] = await this.inScope(book, month, [employeeId], P.read, {});
      if (!facts || employmentWindow(month, facts) === null) throw notFound();
      const refDate = refDateOf(facts, month, book.today);
      row = { employment: facts, refDate, unitId: assignmentOn(facts, refDate)?.orgUnitId ?? null, employedInMonth: true, result: null, lines: [] };
    }
    return this.employeeView(row, book, month, data, await this.viewContext(book, [row]));
  }

  // ── adjustments ───────────────────────────────────────────────────────────────────────────────────────────────

  /** Readable (payroll.read, else 404) and preparable (payroll.prepare, else 403) employee of the month. */
  private async writable(book: PayrollBook, month: string, employeeId: string): Promise<{ facts: EmploymentFacts; unitId: string }> {
    const active = await this.repo.activeIn(book.companyId, this.engine.rangeStart(book, month), lastDayOf(month));
    if (!active.includes(employeeId)) {
      const [known] = await this.inScope(book, month, [employeeId], P.read, {});
      if (!known) throw notFound();
      throw new ValidationProblemException([{ field: 'employeeId', code: 'not_employed', message: 'The employee is not employed in this month.' }]);
    }
    const [facts] = await this.inScope(book, month, [employeeId], P.read, {});
    if (!facts) throw notFound();
    const unitId = assignmentOn(facts, refDateOf(facts, month, book.today))?.orgUnitId ?? '';
    if (!(await this.scopes.unitIds(P.prepare)).has(unitId)) {
      throw new ProblemException(403, 'forbidden-scope', 'You cannot prepare the payroll of this employee (outside your payroll.prepare scope).');
    }
    return { facts, unitId };
  }

  private async lockOpen(book: PayrollBook, month: string): Promise<void> {
    const period = await this.repo.lockPeriod(book.companyId, month, 'share');
    if (period.status === 'closed') throw closedProblem();
  }

  private async amountAllowed(r: RubriqueFact, unitId: string): Promise<void> {
    if (r.unit !== 'amount') return;
    if (!(await this.scopes.unitIds(SALARY_UPDATE)).has(unitId)) {
      throw new ProblemException(403, 'forbidden-field', 'Amounts are entered by holders of employee.salary.update.', [
        { field: 'value', code: 'forbidden_field', message: 'Amounts need employee.salary.update.' },
      ]);
    }
  }

  /** PUT /payroll/periods/:month/variables/:employeeId/lines */
  async putLine(monthValue: string, employeeId: string, input: LineInput): Promise<EmployeeVariables> {
    const { companyId, userId } = caller();
    let book = await this.engine.book(companyId);
    const month = this.month(monthValue, book.today);
    if (this.status(book, month) === 'closed') throw closedProblem();
    const { facts, unitId } = await this.writable(book, month, employeeId);
    const rubrique = book.rubriques.find((r) => r.id === input.rubriqueId);
    if (!rubrique) throw new ValidationProblemException([{ field: 'rubriqueId', code: 'invalid', message: 'Unknown rubrique.' }]);
    if (!rubrique.active) throw new ValidationProblemException([{ field: 'rubriqueId', code: 'inactive', message: 'This rubrique is inactive.' }]);
    await this.amountAllowed(rubrique, unitId);
    const origin = input.originMonth === undefined ? month : parseMonth(input.originMonth);
    if (origin === null || origin > month) throw invalidOrigin();
    await this.lockOpen(book, month);
    book = await this.engine.book(companyId);
    if (origin === month) {
      if (employmentWindow(month, facts) === null) {
        throw new ValidationProblemException([{ field: 'employeeId', code: 'not_employed', message: 'The employee is not employed in this month.' }]);
      }
    } else {
      if (rubrique.source === 'manual') throw invalidOrigin();
      const [row] = await this.engine.live(book, month, [facts]);
      if (!row?.lines.some((l) => l.rubriqueId === rubrique.id && l.originMonth === origin)) throw invalidOrigin();
    }
    await this.repo.upsertAdjustment(companyId, { month, originMonth: origin, employmentId: employeeId, rubriqueId: rubrique.id, value: input.value, note: input.note, by: userId });
    return this.oneView(book, month, employeeId);
  }

  /** DELETE /payroll/periods/:month/variables/:employeeId/lines/:rubriqueId?originMonth= */
  async deleteLine(monthValue: string, employeeId: string, rubriqueId: string, originMonth: string | undefined): Promise<EmployeeVariables> {
    const { companyId } = caller();
    const book = await this.engine.book(companyId);
    const month = this.month(monthValue, book.today);
    if (this.status(book, month) === 'closed') throw closedProblem();
    const { unitId } = await this.writable(book, month, employeeId);
    const rubrique = book.rubriques.find((r) => r.id === rubriqueId);
    if (!rubrique) throw new NotFoundException('Rubrique not found');
    await this.amountAllowed(rubrique, unitId);
    const origin = originMonth === undefined ? month : parseMonth(originMonth);
    if (origin === null || origin > month) {
      throw new ValidationProblemException([{ field: 'originMonth', code: 'invalid', message: 'A month written YYYY-MM, not after the month.' }]);
    }
    await this.lockOpen(book, month);
    await this.repo.deleteAdjustment(companyId, { month, originMonth: origin, employmentId: employeeId, rubriqueId });
    return this.oneView(book, month, employeeId);
  }

  // ── close / reopen ────────────────────────────────────────────────────────────────────────────────────────────

  private async companyWide(): Promise<void> {
    if (!(await this.scopes.coversCompany(P.close))) {
      throw new ProblemException(403, 'forbidden-scope', 'Payroll is closed for the whole company: payroll.close over the root unit is needed.');
    }
  }

  /**
   * POST /payroll/periods/:month/close: one transaction under a lock on the period row (a second concurrent close
   * waits, then reads `closed` → 409): every employee of the company, every line, the closing and its snapshot.
   */
  async close(monthValue: string): Promise<PeriodView> {
    const { companyId, userId } = caller();
    await this.companyWide();
    const today = (await this.engine.book(companyId)).today;
    const month = this.month(monthValue, today);
    const period = await this.repo.lockPeriod(companyId, month, 'update');
    const book = await this.engine.book(companyId);
    const refusal = closeRefusal(month, book.today, book.policy.cutoffDay, this.periodStates(book));
    if (refusal === 'payroll-period-closed') throw closedProblem();
    if (refusal === 'payroll-before-cutoff') {
      throw new ProblemException(409, refusal, `This month may be closed from ${cutoffDate(month, book.policy.cutoffDay)}.`);
    }
    if (refusal === 'payroll-previous-open') throw new ProblemException(409, refusal, 'An earlier month is open: close it first.');

    const { version, lines: exported, employees } = await this.engine.close(book, month, period.id, userId);
    await this.audit.record({ type: 'payroll.closed', subject: null, data: { month: monthKey(month), version, lines: exported, employees } });
    return this.periodView(await this.engine.book(companyId), month);
  }

  /** POST /payroll/periods/:month/reopen: only the latest closed month. */
  async reopen(monthValue: string, reason: string): Promise<PeriodView> {
    const { companyId, userId } = caller();
    await this.companyWide();
    const today = (await this.engine.book(companyId)).today;
    const month = this.month(monthValue, today);
    const period = await this.repo.lockPeriod(companyId, month, 'update');
    const book = await this.engine.book(companyId);
    if (period.status !== 'closed') throw new ProblemException(409, 'payroll-period-open', 'This month is open.');
    if (!isLatestClosed(month, this.periodStates(book))) {
      throw new ProblemException(409, 'payroll-period-not-latest', 'Only the latest closed month may be reopened.');
    }
    const closing = currentClosings(book.closings).get(month);
    if (!closing) throw new Error(`payroll: closed month ${month} without a current closing`);
    await this.repo.reopenClosing(companyId, closing.id, userId, reason);
    await this.repo.setPeriodStatus(companyId, period.id, 'open');
    await this.audit.record({ type: 'payroll.reopened', subject: null, data: { month: monthKey(month), version: closing.version, reason } });
    return this.periodView(await this.engine.book(companyId), month);
  }

  // ── the lines port (export and control endpoints) ─────────────────────────────────────────────────────────────

  async linesFor(query: PayrollLinesQuery): Promise<PayrollLinesResult> {
    const { companyId } = caller();
    const book = await this.engine.book(companyId);
    const month = this.month(query.month, book.today);
    const data = await this.monthData(book, month, query.permission, { unitId: query.unitId, includeSubUnits: query.includeSubUnits });
    const [salaryRead, codes] = await Promise.all([this.scopes.unitIds(SALARY_READ), this.repo.employeeCodes(companyId, data.rows.map((r) => r.employment.id))]);
    const rubriques = new Map(book.rubriques.map((r) => [r.id, r]));
    const out: PayrollExportLine[] = [];
    for (const row of data.rows) {
      const e = row.employment;
      const unit = row.unitId ? book.org.unitRef(row.unitId, row.refDate) : null;
      const snapshot = data.snapshot.get(e.id) ?? [];
      for (const { line, view } of this.visible(row, book, salaryRead, data)) {
        if (line.value === 0) continue;
        const snap = snapshot.find((s) => s.rubriqueId === line.rubriqueId && s.originMonth === line.originMonth);
        const r = rubriques.get(line.rubriqueId);
        const payrollCode = codes.get(e.id) ?? null;
        out.push({
          employeeId: e.id,
          matricule: e.matricule,
          payrollCode,
          exportMatricule: snap?.matricule ?? payrollCode ?? e.matricule,
          lastName: snap?.lastName ?? e.lastName,
          firstName: snap?.firstName ?? e.firstName,
          lastNameAr: e.lastNameAr,
          firstNameAr: e.firstNameAr,
          unitCode: snap ? snap.unitCode : unit?.code || null,
          unitName: unit?.name || null,
          unitNameAr: unit?.nameAr ?? null,
          rubriqueId: line.rubriqueId,
          exportCode: view.exportCode,
          unit: view.unit,
          source: line.source,
          names: view.names,
          sortOrder: r?.sortOrder ?? 0,
          originMonth: view.originMonth,
          computed: line.computed,
          value: line.value,
          adjusted: line.adjusted,
          note: line.note,
        });
      }
    }
    return { status: data.status, version: data.closing?.version ?? null, lines: out };
  }
}
