/**
 * Schedule resolution (docs/contracts/attendance.md › Schedule resolution) — pure rules over the company's
 * assignments, versions and overrides (loaded once per request).
 *
 * The effective schedule of employment E on date D, first match wins (reported as `source`):
 *   1. an `employment` assignment of E valid on D;
 *   2. a `unit` assignment valid on D on E's unit on D, else on its nearest ancestor that has one (today's tree);
 *   3. a `site` assignment valid on D on E's effective site on D;
 *   4. the `company` assignment valid on D.
 * The day rule on D: the override of that schedule covering D, else the company-wide override covering D, else the
 * schedule's version valid on D — its week entry for D's ISO weekday and that document's tolerance.
 */
import { isoWeekday } from './time.js';
import type { Week, WeekDay } from './week.js';

export type TargetKind = 'company' | 'site' | 'unit' | 'employment';
export type ScheduleSource = TargetKind;

export interface AssignmentFact {
  id: string;
  scheduleId: string;
  targetKind: TargetKind;
  /** null for `company` */
  targetId: string | null;
  from: string;
  /** exclusive; null = open */
  to: string | null;
}

export interface VersionFact {
  id: string;
  scheduleId: string;
  from: string;
  to: string | null;
  week: Week;
  toleranceMinutes: number;
}

export interface OverrideFact {
  id: string;
  /** null = every schedule */
  scheduleId: string | null;
  labels: { fr: string; ar: string; en: string };
  from: string;
  /** exclusive */
  toExclusive: string;
  week: Week;
  toleranceMinutes: number;
  approximate: boolean;
}

export interface Placement {
  employmentId: string;
  /** the employee's unit on D */
  unitId: string;
  /** that unit then its ancestors, nearest first (today's tree) */
  unitChain: readonly string[];
  /** the employee's effective site on D */
  siteId: string | null;
}

export interface Resolved {
  assignment: AssignmentFact;
  source: ScheduleSource;
}

export interface DayRule {
  entry: WeekDay;
  toleranceMinutes: number;
  override: OverrideFact | null;
  version: VersionFact | null;
}

const covers = (from: string, to: string | null, date: string) => from <= date && (to === null || date < to);

/** Assignments indexed by target, for many (employee, day) lookups. */
export class AssignmentIndex {
  private readonly byTarget = new Map<string, AssignmentFact[]>();

  constructor(assignments: readonly AssignmentFact[]) {
    for (const a of assignments) {
      const key = `${a.targetKind}:${a.targetId ?? ''}`;
      const list = this.byTarget.get(key) ?? [];
      list.push(a);
      this.byTarget.set(key, list);
    }
  }

  private at(kind: TargetKind, id: string | null, date: string): AssignmentFact | undefined {
    return this.byTarget.get(`${kind}:${id ?? ''}`)?.find((a) => covers(a.from, a.to, date));
  }

  resolve(p: Placement, date: string): Resolved | null {
    const own = this.at('employment', p.employmentId, date);
    if (own) return { assignment: own, source: 'employment' };
    for (const unitId of p.unitChain) {
      const unit = this.at('unit', unitId, date);
      if (unit) return { assignment: unit, source: 'unit' };
    }
    if (p.siteId) {
      const site = this.at('site', p.siteId, date);
      if (site) return { assignment: site, source: 'site' };
    }
    const company = this.at('company', null, date);
    return company ? { assignment: company, source: 'company' } : null;
  }
}

export function dayRuleOf(scheduleId: string, date: string, versions: readonly VersionFact[], overrides: readonly OverrideFact[]): DayRule | null {
  const day = isoWeekday(date);
  const inOverride = (o: OverrideFact) => o.from <= date && date < o.toExclusive;
  const override = overrides.find((o) => o.scheduleId === scheduleId && inOverride(o)) ?? overrides.find((o) => o.scheduleId === null && inOverride(o));
  if (override) {
    const entry = override.week.find((d) => d.day === day);
    return entry ? { entry, toleranceMinutes: override.toleranceMinutes, override, version: null } : null;
  }
  const version = versions.find((v) => v.scheduleId === scheduleId && covers(v.from, v.to, date));
  const entry = version?.week.find((d) => d.day === day);
  return version && entry ? { entry, toleranceMinutes: version.toleranceMinutes, override: null, version } : null;
}
