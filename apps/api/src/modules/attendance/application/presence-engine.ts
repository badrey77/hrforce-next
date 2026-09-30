import { Injectable } from '@nestjs/common';
import { effectiveSite, type OrgSnapshotUnit, type OrgUnitKind } from '../../organization/index.js';
import { LeaveFacts, type AttendanceLeaveInputs } from '../../leave/index.js';
import { computeDay, leavePartOn, type DayResult, type LeavePart, type PunchFact } from '../domain/day.js';
import { AssignmentIndex, dayRuleOf, type OverrideFact, type Placement, type Resolved, type VersionFact } from '../domain/schedules.js';
import { algiersTime, formatHhMm } from '../domain/time.js';
import { isRestDay } from '../domain/week.js';
import { AttendanceRepository, type EmploymentFacts, type PunchRow, type SiteRow, type UnitVersionRow } from '../infra/attendance.repository.js';
import { KiosksRepository } from '../infra/kiosks.repository.js';
import { SchedulesRepository, type ScheduleRow } from '../infra/schedules.repository.js';
import type { AttendanceDayView, DaySchedule, EmployeeRef, PunchView, SiteRef, UnitRef, UserRef } from './attendance-views.js';
import { AttendanceClock } from './attendance-clock.js';

interface SnapshotUnit extends OrgSnapshotUnit {
  isRoot: boolean;
}

/**
 * The organisation at any date, from every unit version of the company (loaded once per request): each unit with its
 * version valid on the date (else its earliest one), its effective site, its sub-units; plus today's ancestor chains
 * (org_unit_closure) for the schedule resolution.
 */
export class OrgBook {
  private readonly byDate = new Map<string, ReadonlyMap<string, SnapshotUnit>>();

  constructor(
    private readonly versions: readonly UnitVersionRow[],
    private readonly ancestorsToday: ReadonlyMap<string, string[]>,
    readonly sites: ReadonlyMap<string, SiteRow>,
  ) {}

  at(date: string): ReadonlyMap<string, SnapshotUnit> {
    const hit = this.byDate.get(date);
    if (hit) return hit;
    const chosen = new Map<string, UnitVersionRow>();
    for (const v of this.versions) {
      const current = chosen.get(v.unitId);
      const covers = v.from <= date && (v.to === null || date < v.to);
      const currentCovers = current !== undefined && current.from <= date && (current.to === null || date < current.to);
      if (!current || (covers && !currentCovers) || (!covers && !currentCovers && v.from < current.from)) chosen.set(v.unitId, v);
    }
    const snapshot = new Map<string, SnapshotUnit>(
      [...chosen.values()].map((v) => [
        v.unitId,
        { id: v.unitId, kind: v.kind as OrgUnitKind, code: v.code, name: v.name, nameAr: v.nameAr, parentId: v.parentId, siteId: v.siteId, isRoot: v.isRoot },
      ]),
    );
    this.byDate.set(date, snapshot);
    return snapshot;
  }

  unitRef(unitId: string, date: string): UnitRef {
    const u = this.at(date).get(unitId);
    return u ? { id: u.id, code: u.code, name: u.name, nameAr: u.nameAr ?? null, kind: u.kind } : { id: unitId, code: '', name: '', nameAr: null, kind: '' };
  }

  effectiveSiteOf(unitId: string, date: string): string | null {
    const snapshot = this.at(date);
    const u = snapshot.get(unitId);
    return u ? effectiveSite(u.siteId, u.parentId, snapshot).siteId : null;
  }

  /** The unit then its ancestors in today's tree (the unit alone when it is not in today's tree). */
  chain(unitId: string): string[] {
    return this.ancestorsToday.get(unitId) ?? [unitId];
  }

  /** The units and all their sub-units in the tree of `date`. */
  subtree(unitIds: readonly string[], date: string): Set<string> {
    const snapshot = this.at(date);
    const children = new Map<string, string[]>();
    for (const u of snapshot.values()) if (u.parentId) children.set(u.parentId, [...(children.get(u.parentId) ?? []), u.id]);
    const out = new Set<string>();
    const stack = [...unitIds];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (out.has(id)) continue;
      out.add(id);
      stack.push(...(children.get(id) ?? []));
    }
    return out;
  }

  siteRef(siteId: string | null): SiteRef | null {
    if (!siteId) return null;
    const s = this.sites.get(siteId);
    return s ? { id: s.id, code: s.code, name: s.name } : null;
  }
}

/** The assignment of an employment on `date`: valid then, else the latest started before, else the first. */
export function assignmentOn(e: EmploymentFacts, date: string): EmploymentFacts['assignments'][number] | undefined {
  const valid = e.assignments.find((a) => a.from <= date && (a.to === null || date < a.to));
  if (valid) return valid;
  const before = e.assignments.filter((a) => a.from <= date).toSorted((a, b) => (a.from < b.from ? 1 : -1))[0];
  return before ?? e.assignments.toSorted((a, b) => (a.from < b.from ? -1 : 1))[0];
}

export function isEmployedOn(e: EmploymentFacts, date: string): boolean {
  return e.hireDate <= date && (e.endDate === null || e.endDate >= date);
}

export interface DayOptions {
  /** attendance.manage over the employee (shared_device flag, void action) */
  canManage: boolean;
  /** include `punches` (per-employee routes) */
  withPunches: boolean;
}

/**
 * Everything the daily computation needs for some employments over [from, to], loaded in a few queries, and the
 * builder of {@link AttendanceDayView}s from it.
 */
export class PresenceData {
  private readonly punchesByKey = new Map<string, PunchRow[]>();
  private readonly holidays: Map<string, AttendanceLeaveInputs['holidays'][number]>;
  private readonly index: AssignmentIndex;

  constructor(
    readonly org: OrgBook,
    readonly today: string,
    readonly nowMs: number,
    private readonly employments: ReadonlyMap<string, EmploymentFacts>,
    private readonly schedules: ReadonlyMap<string, ScheduleRow>,
    private readonly versions: readonly VersionFact[],
    private readonly overrides: readonly OverrideFact[],
    assignments: ConstructorParameters<typeof AssignmentIndex>[0],
    private readonly leave: AttendanceLeaveInputs,
    punches: readonly PunchRow[],
    private readonly deviceRefs: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>,
    private readonly kiosks: ReadonlyMap<string, { labels: { fr: string; ar: string }; site: SiteRef }>,
    private readonly members: ReadonlyMap<string, string>,
  ) {
    for (const p of punches) {
      const key = `${p.employmentId}|${p.workDate}`;
      this.punchesByKey.set(key, [...(this.punchesByKey.get(key) ?? []), p]);
    }
    this.holidays = new Map(leave.holidays.map((h) => [h.date, h]));
    this.index = new AssignmentIndex(assignments);
  }

  employment(id: string): EmploymentFacts | undefined {
    return this.employments.get(id);
  }

  placement(e: EmploymentFacts, date: string): Placement | null {
    const a = assignmentOn(e, date);
    if (!a) return null;
    return { employmentId: e.id, unitId: a.orgUnitId, unitChain: this.org.chain(a.orgUnitId), siteId: a.siteId ?? this.org.effectiveSiteOf(a.orgUnitId, date) };
  }

  employeeRef(e: EmploymentFacts, date: string): EmployeeRef {
    const p = this.placement(e, date);
    return {
      id: e.id,
      matricule: e.matricule,
      person: { lastName: e.lastName, firstName: e.firstName, lastNameAr: e.lastNameAr, firstNameAr: e.firstNameAr },
      unit: p ? this.org.unitRef(p.unitId, date) : { id: '', code: '', name: '', nameAr: null, kind: '' },
      site: p ? this.org.siteRef(p.siteId) : null,
    };
  }

  resolve(e: EmploymentFacts, date: string): Resolved | null {
    const p = this.placement(e, date);
    return p ? this.index.resolve(p, date) : null;
  }

  user(id: string | null): UserRef | null {
    return id ? { id, displayName: this.members.get(id) ?? id } : null;
  }

  punchView(p: PunchRow, canVoid: boolean): PunchView {
    const kiosk = p.deviceId ? this.kiosks.get(p.deviceId) : undefined;
    return {
      id: p.id,
      direction: p.direction,
      occurredAt: p.occurredAt.toISOString(),
      localTime: algiersTime(p.occurredAt.getTime()),
      workDate: p.workDate,
      source: p.source,
      kiosk: p.deviceId && kiosk ? { id: p.deviceId, labels: kiosk.labels, site: kiosk.site } : null,
      site: this.org.siteRef(p.siteId),
      reason: p.reason,
      // a QR punch is created by the employee themselves
      createdBy: p.source === 'qr' ? null : this.user(p.createdBy),
      correctionId: null,
      status: p.status,
      void: p.status === 'void' && p.voidedAt ? { at: p.voidedAt.toISOString(), by: this.user(p.voidedBy), reason: p.voidReason ?? '', correctionId: null } : null,
      _actions: canVoid && p.status === 'live' ? ['void'] : [],
    };
  }

  punchesOf(employmentId: string, date: string): PunchRow[] {
    return this.punchesByKey.get(`${employmentId}|${date}`) ?? [];
  }

  /** The day of an employment (with `result` for sorting / totals). */
  day(e: EmploymentFacts, date: string, options: DayOptions): { view: AttendanceDayView; result: DayResult } {
    const employed = isEmployedOn(e, date);
    const punches = this.punchesOf(e.id, date);
    const resolved = employed ? this.resolve(e, date) : null;
    const schedule = resolved ? this.schedules.get(resolved.assignment.scheduleId) : undefined;
    const rule = resolved ? dayRuleOf(resolved.assignment.scheduleId, date, this.versions, this.overrides) : null;
    const approved = this.leave.requests.find((r) => r.employmentId === e.id && r.status === 'approved' && r.startDate <= date && date <= r.endDate);
    const pending = this.leave.requests.some((r) => r.employmentId === e.id && r.status === 'pending' && r.startDate <= date && date <= r.endDate);
    const part: LeavePart | null = approved ? leavePartOn(approved, date) : null;
    const holiday = this.holidays.get(date);
    const placement = employed ? this.placement(e, date) : null;
    const refs = this.deviceRefs.get(date);
    const sharedRefs = new Set<string>();
    if (refs) for (const [ref, users] of refs) if ([...users].some((u) => u !== e.id)) sharedRefs.add(ref);
    const facts: PunchFact[] = punches.map((p) => ({
      id: p.id,
      direction: p.direction,
      occurredAtMs: p.occurredAt.getTime(),
      source: p.source,
      status: p.status,
      siteId: p.siteId,
      deviceRef: p.deviceRef,
    }));
    const result = computeDay({
      date,
      today: this.today,
      nowMs: this.nowMs,
      employed,
      rule: rule ? { entry: rule.entry, toleranceMinutes: rule.toleranceMinutes } : null,
      leave: part,
      leavePending: pending,
      holiday: holiday !== undefined,
      punches: facts,
      siteId: placement?.siteId ?? null,
      sharedRefs,
      showSharedDevice: options.canManage,
    });
    const byId = new Map(punches.map((p) => [p.id, p]));
    const time = (id: string | null) => {
      const p = id ? byId.get(id) : undefined;
      return p ? { id: p.id, occurredAt: p.occurredAt.toISOString(), localTime: algiersTime(p.occurredAt.getTime()) } : null;
    };
    let daySchedule: DaySchedule | null = null;
    if (employed && resolved && schedule) {
      const entry = rule?.entry ?? null;
      const work = entry && !isRestDay(entry) ? entry : null;
      daySchedule = {
        scheduleId: schedule.id,
        code: schedule.code,
        labels: { fr: schedule.nameFr, ar: schedule.nameAr, en: schedule.nameEn },
        source: resolved.source,
        override: rule?.override ? { id: rule.override.id, labels: rule.override.labels, approximate: rule.override.approximate } : null,
        start: work?.start ?? null,
        end: work?.end ?? null,
        breakStart: work?.breakStart ?? null,
        breakEnd: work?.breakEnd ?? null,
        expectedStart: result.expectedStart === null ? null : formatHhMm(result.expectedStart),
        expectedEnd: result.expectedEnd === null ? null : formatHhMm(result.expectedEnd),
        toleranceMinutes: rule?.toleranceMinutes ?? 0,
        scheduledMinutes: result.scheduledMinutes,
      };
    }
    const view: AttendanceDayView = {
      date,
      employee: this.employeeRef(e, date),
      status: result.status,
      final: result.final,
      schedule: daySchedule,
      arrival: time(result.arrivalId),
      departure: time(result.departureId),
      lateMinutes: result.lateMinutes,
      earlyDepartureMinutes: result.earlyDepartureMinutes,
      workedMinutes: result.workedMinutes,
      flags: result.flags,
      leave: employed && approved && part ? { requestId: approved.id, type: { code: approved.typeCode, labels: approved.labels }, part } : null,
      holiday: employed && holiday ? { labels: holiday.labels, approximate: holiday.approximate } : null,
    };
    if (options.withPunches) view.punches = punches.map((p) => this.punchView(p, options.canManage));
    return { view, result };
  }

  /** Overrides covering [from, to] of a schedule (its own and the company-wide ones). */
  overridesFor(scheduleId: string): OverrideFact[] {
    return this.overrides.filter((o) => o.scheduleId === scheduleId || o.scheduleId === null);
  }

  scheduleRow(id: string): ScheduleRow | undefined {
    return this.schedules.get(id);
  }
}

/** Loads {@link PresenceData} (request transaction). */
@Injectable()
export class PresenceEngine {
  constructor(
    private readonly repo: AttendanceRepository,
    private readonly schedules: SchedulesRepository,
    private readonly kiosks: KiosksRepository,
    private readonly leave: LeaveFacts,
    private readonly clock: AttendanceClock,
  ) {}

  async orgBook(companyId: string): Promise<OrgBook> {
    const [versions, ancestors, sites] = await Promise.all([this.repo.unitVersions(companyId), this.repo.ancestors(companyId), this.repo.sites(companyId)]);
    return new OrgBook(versions, ancestors, sites);
  }

  /**
   * Loads the data of `employmentIds` for [from, to]. `allRefs`: device refs of the whole company (shared_device
   * compares with other employments' punches).
   */
  async load(companyId: string, employmentIds: readonly string[], from: string, to: string, org?: OrgBook): Promise<PresenceData> {
    const nowMs = this.clock.nowMs();
    const today = this.clock.today();
    const book = org ?? (await this.orgBook(companyId));
    const [employments, scheduleRows, versions, overrides, assignments, leave, punches, deviceRefs, kiosks, members] = await Promise.all([
      this.repo.employments(companyId, employmentIds),
      this.schedules.schedules(companyId),
      this.schedules.versions(companyId),
      this.schedules.overrides(companyId),
      this.schedules.assignments(companyId),
      this.leave.attendanceInputs(companyId, employmentIds, from, to),
      this.repo.punches(companyId, employmentIds, from, to),
      this.repo.deviceRefs(companyId, from, to),
      this.kiosks.list(companyId),
      this.repo.members(companyId),
    ]);
    return new PresenceData(
      book,
      today,
      nowMs,
      new Map(employments.map((e) => [e.id, e])),
      new Map(scheduleRows.map((s) => [s.id, s])),
      versions,
      overrides,
      assignments,
      leave,
      punches,
      deviceRefs,
      new Map(kiosks.map((k) => [k.id, { labels: { fr: k.nameFr, ar: k.nameAr }, site: { id: k.siteId, code: k.siteCode, name: k.siteName } }])),
      members,
    );
  }
}
