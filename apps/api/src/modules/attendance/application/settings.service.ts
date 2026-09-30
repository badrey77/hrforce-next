import { Injectable, NotFoundException } from '@nestjs/common';
import { ScopeService } from '../../../platform/authz/scope-service.js';
import { ProblemException, ValidationProblemException, type FieldError } from '../../../platform/http/problem-details.js';
import type { AssignmentFact, TargetKind } from '../domain/schedules.js';
import { addDays, daysBetween } from '../domain/time.js';
import { validateWeek, weeklyMinutesOf, type Week } from '../domain/week.js';
import { AttendanceRepository } from '../infra/attendance.repository.js';
import { pgError, SchedulesRepository, type OverrideInput, type PolicyRow, type ScheduleRow } from '../infra/schedules.repository.js';
import { AttendanceClock } from './attendance-clock.js';
import type { AssignmentView, OverrideView, PolicyView, ScheduleView } from './attendance-views.js';
import { PresenceEngine } from './presence-engine.js';
import { ATTENDANCE_PERMISSIONS as P, caller } from './presence.service.js';

type Labels = { fr: string; ar: string; en: string };

export interface CreateScheduleInput {
  code: string;
  labels: Labels;
  week: unknown;
  toleranceMinutes: number;
  validFrom?: string | undefined;
}

export interface OverrideBody {
  scheduleId: string | null;
  labels: Labels;
  from: string;
  to: string;
  week: unknown;
  toleranceMinutes: number;
  approximate: boolean;
}

export interface AssignmentInput {
  scheduleId: string;
  target: { kind: TargetKind; id: string | null };
  validFrom: string;
}

/** The longest override (docs/contracts/attendance.md › attendance_schedule_override). */
export const OVERRIDE_MAX_DAYS = 60;
const EXCLUSION_VIOLATION = '23P01';
const UNIQUE_VIOLATION = '23505';

const taken = () => new ProblemException(409, 'attendance-schedule-code-taken', 'This code is already used.', [{ field: 'code', code: 'taken', message: 'Already used.' }]);
const dated = () =>
  new ProblemException(409, 'attendance-version-date', 'A new version must start after the latest one.', [{ field: 'validFrom', code: 'too_early', message: 'After the latest version’s start.' }]);
const labelsOf = (s: ScheduleRow): Labels => ({ fr: s.nameFr, ar: s.nameAr, en: s.nameEn });

function weekOrThrow(raw: unknown, extra: FieldError[] = []): Week {
  const checked = validateWeek(raw);
  if (!checked.ok || extra.length > 0) throw new ValidationProblemException([...extra, ...(checked.ok ? [] : checked.errors)]);
  return checked.week;
}

/**
 * Attendance configuration (docs/contracts/attendance.md › Endpoints): the policy, schedules and their versions,
 * overrides, assignments. Reads need attendance.read (or attendance.configure) anywhere — the route guard; writes need
 * attendance.configure over the WHOLE company (else 403 forbidden-scope, like document.configure). Every write is
 * audited by the row triggers.
 */
@Injectable()
export class AttendanceSettingsService {
  constructor(
    private readonly repo: SchedulesRepository,
    private readonly people: AttendanceRepository,
    private readonly engine: PresenceEngine,
    private readonly scopes: ScopeService,
    private readonly clock: AttendanceClock,
  ) {}

  private async assertCompanyWide(): Promise<void> {
    if (!(await this.scopes.coversCompany(P.configure))) {
      throw new ProblemException(403, 'forbidden-scope', 'Attendance settings apply to the whole company: attendance.configure over the root unit is needed.');
    }
  }

  // ── policy ────────────────────────────────────────────────────────────────────────────────────────────────────

  async policy(): Promise<PolicyView> {
    const { companyId } = caller();
    return this.repo.policy(companyId);
  }

  async savePolicy(patch: Partial<PolicyRow>): Promise<PolicyView> {
    const { companyId } = caller();
    await this.assertCompanyWide();
    const current = await this.repo.policy(companyId);
    await this.repo.savePolicy(companyId, { ...current, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) });
    return this.repo.policy(companyId);
  }

  // ── schedules ─────────────────────────────────────────────────────────────────────────────────────────────────

  async schedules(): Promise<{ items: ScheduleView[] }> {
    const { companyId } = caller();
    const [rows, versions, assignments] = await Promise.all([this.repo.schedules(companyId), this.repo.versions(companyId), this.repo.assignments(companyId)]);
    const today = this.clock.today();
    return {
      items: rows.map((s) => {
        const own = versions.filter((v) => v.scheduleId === s.id).toSorted((a, b) => (a.from < b.from ? 1 : -1));
        const current = own.find((v) => v.from <= today && (v.to === null || today < v.to));
        return {
          id: s.id,
          code: s.code,
          labels: labelsOf(s),
          active: s.active,
          versions: own.map((v) => ({ id: v.id, validFrom: v.from, validTo: v.to, week: v.week, toleranceMinutes: v.toleranceMinutes })),
          current: current ? { validFrom: current.from, week: current.week, toleranceMinutes: current.toleranceMinutes, weeklyMinutes: weeklyMinutesOf(current.week) } : null,
          assignmentCount: assignments.filter((a) => a.scheduleId === s.id && (a.to === null || a.to > today)).length,
        };
      }),
    };
  }

  private async scheduleView(id: string): Promise<ScheduleView> {
    const view = (await this.schedules()).items.find((s) => s.id === id);
    if (!view) throw new NotFoundException('Schedule not found');
    return view;
  }

  private async scheduleOr404(id: string): Promise<ScheduleRow> {
    const { companyId } = caller();
    const row = await this.repo.schedule(companyId, id);
    if (!row) throw new NotFoundException('Schedule not found');
    return row;
  }

  async createSchedule(input: CreateScheduleInput): Promise<ScheduleView> {
    const { companyId } = caller();
    await this.assertCompanyWide();
    const week = weekOrThrow(input.week);
    if (await this.repo.codeTaken(companyId, input.code)) throw taken();
    let id: string;
    try {
      id = await this.repo.insertSchedule(companyId, { code: input.code, labels: input.labels });
    } catch (error) {
      if (pgError(error).code === UNIQUE_VIOLATION) throw taken();
      throw error;
    }
    await this.repo.insertVersion(companyId, id, input.validFrom ?? this.clock.today(), week, input.toleranceMinutes);
    return this.scheduleView(id);
  }

  async updateSchedule(id: string, patch: { labels?: Labels | undefined; active?: boolean | undefined }): Promise<ScheduleView> {
    const { companyId } = caller();
    await this.scheduleOr404(id);
    await this.assertCompanyWide();
    if (patch.active === false) {
      const view = await this.scheduleView(id);
      if (view.assignmentCount > 0) throw new ProblemException(409, 'attendance-schedule-in-use', 'This schedule has current or future assignments: end them first.');
    }
    await this.repo.updateSchedule(companyId, id, { ...(patch.labels ? { labels: patch.labels } : {}), ...(patch.active !== undefined ? { active: patch.active } : {}) });
    return this.scheduleView(id);
  }

  async addVersion(id: string, input: { validFrom: string; week: unknown; toleranceMinutes: number }): Promise<ScheduleView> {
    const { companyId } = caller();
    await this.scheduleOr404(id);
    await this.assertCompanyWide();
    const week = weekOrThrow(input.week);
    const versions = (await this.repo.versions(companyId, id)).toSorted((a, b) => (a.from < b.from ? 1 : -1));
    const latest = versions[0];
    if (latest && input.validFrom <= latest.from) throw dated();
    try {
      if (latest && latest.to === null) await this.repo.closeVersion(companyId, latest.id, input.validFrom);
      await this.repo.insertVersion(companyId, id, input.validFrom, week, input.toleranceMinutes);
    } catch (error) {
      if (pgError(error).code === EXCLUSION_VIOLATION) throw dated();
      throw error;
    }
    return this.scheduleView(id);
  }

  // ── overrides ─────────────────────────────────────────────────────────────────────────────────────────────────

  async overrides(year?: number): Promise<{ items: OverrideView[] }> {
    const { companyId } = caller();
    const y = year ?? Number(this.clock.today().slice(0, 4));
    const from = `${y}-01-01`;
    const to = `${y + 1}-01-01`;
    const [rows, schedules] = await Promise.all([this.repo.overrides(companyId), this.repo.schedules(companyId)]);
    const byId = new Map(schedules.map((s) => [s.id, s]));
    return {
      items: rows
        .filter((o) => o.from < to && o.toExclusive > from)
        .map((o) => {
          const s = o.scheduleId ? byId.get(o.scheduleId) : undefined;
          return {
            id: o.id,
            schedule: s ? { id: s.id, code: s.code, labels: labelsOf(s) } : null,
            labels: o.labels,
            from: o.from,
            to: addDays(o.toExclusive, -1),
            week: o.week,
            toleranceMinutes: o.toleranceMinutes,
            approximate: o.approximate,
          };
        }),
    };
  }

  private async overrideInput(body: OverrideBody): Promise<OverrideInput> {
    const { companyId } = caller();
    const extra: FieldError[] = [];
    if (body.from > body.to) extra.push({ field: 'to', code: 'invalid', message: 'Not before `from`.' });
    else if (daysBetween(body.from, body.to) + 1 > OVERRIDE_MAX_DAYS) extra.push({ field: 'to', code: 'range_too_long', message: `At most ${OVERRIDE_MAX_DAYS} days.` });
    if (body.scheduleId !== null && !(await this.repo.schedule(companyId, body.scheduleId))) {
      extra.push({ field: 'scheduleId', code: 'not_found', message: 'Unknown schedule.' });
    }
    const week = weekOrThrow(body.week, extra);
    return { scheduleId: body.scheduleId, labels: body.labels, from: body.from, to: body.to, week, toleranceMinutes: body.toleranceMinutes, approximate: body.approximate };
  }

  private overlap(): ProblemException {
    return new ProblemException(409, 'attendance-override-overlap', 'Another override of the same schedule covers some of these dates.', [
      { field: 'from', code: 'overlap', message: 'Overlaps another override.' },
    ]);
  }

  private async overrideView(id: string, year: number): Promise<OverrideView> {
    const view = (await this.overrides(year)).items.find((o) => o.id === id);
    if (!view) throw new NotFoundException('Override not found');
    return view;
  }

  async createOverride(body: OverrideBody): Promise<OverrideView> {
    const { companyId } = caller();
    await this.assertCompanyWide();
    const input = await this.overrideInput(body);
    let id: string;
    try {
      id = await this.repo.insertOverride(companyId, input);
    } catch (error) {
      if (pgError(error).code === EXCLUSION_VIOLATION) throw this.overlap();
      throw error;
    }
    return this.overrideView(id, Number(input.from.slice(0, 4)));
  }

  async updateOverride(id: string, body: OverrideBody): Promise<OverrideView> {
    const { companyId } = caller();
    if (!(await this.repo.overrides(companyId)).some((o) => o.id === id)) throw new NotFoundException('Override not found');
    await this.assertCompanyWide();
    const input = await this.overrideInput(body);
    try {
      await this.repo.updateOverride(companyId, id, input);
    } catch (error) {
      if (pgError(error).code === EXCLUSION_VIOLATION) throw this.overlap();
      throw error;
    }
    return this.overrideView(id, Number(input.from.slice(0, 4)));
  }

  async deleteOverride(id: string): Promise<void> {
    const { companyId } = caller();
    if (!(await this.repo.overrides(companyId)).some((o) => o.id === id)) throw new NotFoundException('Override not found');
    await this.assertCompanyWide();
    await this.repo.deleteOverride(companyId, id);
  }

  // ── assignments ───────────────────────────────────────────────────────────────────────────────────────────────

  async assignments(query: { targetKind?: TargetKind | undefined; scheduleId?: string | undefined; at?: string | undefined }): Promise<{ items: AssignmentView[] }> {
    const { companyId } = caller();
    const today = this.clock.today();
    const at = query.at ?? today;
    const all = await this.repo.assignments(companyId);
    const rows = all.filter(
      (a) =>
        (!query.targetKind || a.targetKind === query.targetKind) &&
        (!query.scheduleId || a.scheduleId === query.scheduleId) &&
        (at === 'all' || (a.from <= at && (a.to === null || at < a.to))),
    );
    return { items: await this.assignmentViews(companyId, rows, all) };
  }

  private async assignmentViews(companyId: string, rows: readonly AssignmentFact[], all: readonly AssignmentFact[]): Promise<AssignmentView[]> {
    const today = this.clock.today();
    const [schedules, org, employments, canWrite] = await Promise.all([
      this.repo.schedules(companyId),
      this.engine.orgBook(companyId),
      this.people.employments(companyId, rows.filter((a) => a.targetKind === 'employment' && a.targetId).map((a) => a.targetId as string)),
      this.scopes.coversCompany(P.configure),
    ]);
    const byId = new Map(schedules.map((s) => [s.id, s]));
    const people = new Map(employments.map((e) => [e.id, e]));
    const companyCount = all.filter((a) => a.targetKind === 'company').length;
    return rows.map((a) => {
      const s = byId.get(a.scheduleId);
      let target: AssignmentView['target'] = { kind: a.targetKind, id: a.targetId, code: null, name: null };
      if (a.targetKind === 'site' && a.targetId) {
        const site = org.siteRef(a.targetId);
        target = { ...target, code: site?.code ?? null, name: site?.name ?? null };
      } else if (a.targetKind === 'unit' && a.targetId) {
        const unit = org.unitRef(a.targetId, today);
        target = { ...target, code: unit.code, name: unit.name };
      } else if (a.targetKind === 'employment' && a.targetId) {
        const e = people.get(a.targetId);
        target = { ...target, code: e?.matricule ?? null, name: e ? `${e.firstName} ${e.lastName}` : null };
      }
      const actions: AssignmentView['_actions'] = [];
      if (canWrite && a.targetKind !== 'company' && (a.to === null || a.to > today)) actions.push('end');
      if (canWrite && a.from > today && !(a.targetKind === 'company' && companyCount <= 1)) actions.push('delete');
      return {
        id: a.id,
        schedule: s ? { id: s.id, code: s.code, labels: labelsOf(s) } : { id: a.scheduleId, code: '', labels: { fr: '', ar: '', en: '' } },
        target,
        validFrom: a.from,
        validTo: a.to === null ? null : addDays(a.to, -1),
        _actions: actions,
      };
    });
  }

  private async assignmentOr404(id: string): Promise<AssignmentFact> {
    const { companyId } = caller();
    const found = (await this.repo.assignments(companyId)).find((a) => a.id === id);
    if (!found) throw new NotFoundException('Assignment not found');
    return found;
  }

  private assignmentOverlap(): ProblemException {
    return new ProblemException(409, 'attendance-assignment-overlap', 'Another assignment of this target covers some of these dates.', [
      { field: 'validFrom', code: 'overlap', message: 'Overlaps another assignment of the same target.' },
    ]);
  }

  async createAssignment(input: AssignmentInput): Promise<AssignmentView> {
    const { companyId } = caller();
    await this.assertCompanyWide();
    const errors: FieldError[] = [];
    const schedule = await this.repo.schedule(companyId, input.scheduleId);
    if (!schedule) errors.push({ field: 'scheduleId', code: 'not_found', message: 'Unknown schedule.' });
    else if (!schedule.active) errors.push({ field: 'scheduleId', code: 'inactive', message: 'This schedule is inactive.' });
    const { kind, id } = input.target;
    if (kind === 'company') {
      if (id !== null) errors.push({ field: 'target.id', code: 'invalid', message: 'No id for the company default.' });
    } else if (id === null) {
      errors.push({ field: 'target.id', code: 'required', message: 'Required.' });
    } else if (kind === 'site' && !(await this.repo.site(companyId, id))) {
      errors.push({ field: 'target.id', code: 'not_found', message: 'Unknown site.' });
    } else if (kind === 'unit') {
      const unit = await this.repo.unit(companyId, id);
      if (!unit) errors.push({ field: 'target.id', code: 'not_found', message: 'Unknown unit.' });
      else if (unit.isRoot) errors.push({ field: 'target.id', code: 'root_unit', message: 'The whole company: change the company default instead.' });
    } else if (kind === 'employment' && !(await this.repo.employmentExists(companyId, id))) {
      errors.push({ field: 'target.id', code: 'not_found', message: 'Unknown employee.' });
    }
    if (errors.length > 0) throw new ValidationProblemException(errors);

    const all = await this.repo.assignments(companyId);
    const same = all.filter((a) => a.targetKind === kind && (a.targetId ?? null) === id);
    const open = same.find((a) => a.to === null && a.from < input.validFrom);
    const clash = same.some((a) => a !== open && (a.to === null || a.to > input.validFrom));
    if (clash) throw this.assignmentOverlap();
    let newId: string;
    try {
      if (open) await this.repo.setAssignmentEnd(companyId, open.id, input.validFrom);
      newId = await this.repo.insertAssignment(companyId, { scheduleId: input.scheduleId, kind, targetId: id, from: input.validFrom });
    } catch (error) {
      if (pgError(error).code === EXCLUSION_VIOLATION) throw this.assignmentOverlap();
      throw error;
    }
    const after = await this.repo.assignments(companyId);
    const created = after.find((a) => a.id === newId);
    if (!created) throw new Error('assignment not found after insert');
    const [view] = await this.assignmentViews(companyId, [created], after);
    if (!view) throw new Error('assignment view missing');
    return view;
  }

  /** Ends an assignment on `validTo` (inclusive). The company default is changed by adding a new one instead. */
  async endAssignment(id: string, validTo: string): Promise<AssignmentView> {
    const { companyId } = caller();
    const a = await this.assignmentOr404(id);
    await this.assertCompanyWide();
    if (a.targetKind === 'company') {
      throw new ProblemException(409, 'attendance-assignment-company', 'The company default is never ended: add a new default from a date instead.');
    }
    if (validTo < a.from) throw new ValidationProblemException([{ field: 'validTo', code: 'invalid', message: 'Not before the start.' }]);
    try {
      await this.repo.setAssignmentEnd(companyId, id, addDays(validTo, 1));
    } catch (error) {
      if (pgError(error).code === EXCLUSION_VIOLATION) throw this.assignmentOverlap();
      throw error;
    }
    const after = await this.repo.assignments(companyId);
    const [view] = await this.assignmentViews(companyId, after.filter((x) => x.id === id), after);
    if (!view) throw new Error('assignment view missing');
    return view;
  }

  /**
   * Deletes an assignment that has not started yet; the assignment of the same target that ended on its start (closed
   * by it) takes its end again, so the company default stays contiguous and open.
   */
  async deleteAssignment(id: string): Promise<void> {
    const { companyId } = caller();
    const a = await this.assignmentOr404(id);
    await this.assertCompanyWide();
    if (a.from <= this.clock.today()) throw new ProblemException(409, 'attendance-assignment-started', 'Only an assignment that has not started yet can be deleted: end it instead.');
    const all = await this.repo.assignments(companyId);
    if (a.targetKind === 'company' && all.filter((x) => x.targetKind === 'company').length <= 1) {
      throw new ProblemException(409, 'attendance-assignment-company', 'The only company default cannot be deleted.');
    }
    const predecessor = all.find((x) => x.id !== a.id && x.targetKind === a.targetKind && x.targetId === a.targetId && x.to === a.from);
    await this.repo.deleteAssignment(companyId, id);
    if (predecessor) await this.repo.setAssignmentEnd(companyId, predecessor.id, a.to);
  }
}
