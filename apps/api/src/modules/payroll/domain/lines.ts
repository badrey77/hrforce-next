/**
 * Payroll lines and régularisations (docs/contracts/payroll-variables.md › Computation) — pure: from the computed
 * values, the rubriques, HR's adjustments and the closings of earlier months. No Nest, no Kysely.
 */
import { sourceKey, type PayrollSource, type PayrollUnit } from './computation.js';
import { round2 } from './period.js';

export interface Labels {
  fr: string;
  ar: string;
  en: string;
}

export interface RubriqueFact {
  id: string;
  source: PayrollSource;
  leaveTypeId: string | null;
  exportCode: string;
  names: Labels;
  unit: PayrollUnit;
  active: boolean;
  sortOrder: number;
}

export interface AdjustmentFact {
  originMonth: string;
  rubriqueId: string;
  value: number;
  note: string | null;
}

/** A line of a closing (payroll_line), as régularisations need it. */
export interface ClosedLineFact {
  rubriqueId: string;
  originMonth: string;
  /** null for a manual rubrique */
  computedValue: number | null;
  value: number;
  adjusted: boolean;
}

export interface Regularization {
  originMonth: string;
  rubriqueId: string;
  delta: number;
}

export interface Line {
  rubriqueId: string;
  source: PayrollSource;
  originMonth: string;
  /** null for a manual rubrique */
  computed: number | null;
  value: number;
  adjusted: boolean;
  note: string | null;
}

/** The value of a rubrique among computed values (0 when absent; manual rubriques have none). */
export function computedValueOf(r: RubriqueFact, values: ReadonlyMap<string, number>): number {
  return r.source === 'manual' ? 0 : (values.get(sourceKey(r.source, r.leaveTypeId)) ?? 0);
}

/**
 * The régularisations of one employment for closed month `origin`, computed while preparing a later open month:
 * for every active computed rubrique, the value recomputed now − the computed value in `origin`'s current closing −
 * the computed values of the régularisation lines for `origin` already in the current closings of the months between.
 * A rubrique HR adjusted in `origin`'s closing is skipped (HR's value wins). Non-zero deltas only.
 */
export function regularizationsOf(input: {
  origin: string;
  rubriques: readonly RubriqueFact[];
  /** values recomputed now for `origin` */
  recomputed: ReadonlyMap<string, number>;
  /** the employment's lines with origin_month = `origin` in `origin`'s current closing */
  closed: readonly ClosedLineFact[];
  /** the employment's lines with origin_month = `origin` in the current closings of the months after it and before the open month */
  later: readonly ClosedLineFact[];
}): Regularization[] {
  const out: Regularization[] = [];
  for (const r of input.rubriques) {
    if (!r.active || r.source === 'manual') continue;
    const own = input.closed.filter((l) => l.rubriqueId === r.id && l.originMonth === input.origin);
    if (own.some((l) => l.adjusted)) continue;
    const before = own.reduce((s, l) => s + (l.computedValue ?? 0), 0);
    const already = input.later.filter((l) => l.rubriqueId === r.id && l.originMonth === input.origin).reduce((s, l) => s + (l.computedValue ?? 0), 0);
    const delta = round2(computedValueOf(r, input.recomputed) - before - already);
    if (delta !== 0) out.push({ originMonth: input.origin, rubriqueId: r.id, delta });
  }
  return out;
}

/**
 * The lines of an employment for open month `month`: one per active rubrique with a value (computed, or HR's
 * adjustment), plus the régularisation lines (origin = an earlier month). `value` = the adjustment if any, else the
 * computed value; a zero value gives no line, except an adjustment to 0 of a non-zero computed value (kept, so HR
 * sees and can revert it, and so the closing records that HR overrode it). Sorted by rubrique order, then origin month.
 */
export function buildLines(input: {
  month: string;
  rubriques: readonly RubriqueFact[];
  values: ReadonlyMap<string, number>;
  regularizations: readonly Regularization[];
  adjustments: readonly AdjustmentFact[];
}): Line[] {
  const byId = new Map(input.rubriques.map((r) => [r.id, r]));
  const adjustment = new Map(input.adjustments.map((a) => [`${a.originMonth}|${a.rubriqueId}`, a]));
  const lines: Line[] = [];
  const push = (r: RubriqueFact, originMonth: string, computed: number | null) => {
    const adj = adjustment.get(`${originMonth}|${r.id}`);
    const value = adj ? round2(adj.value) : (computed ?? 0);
    if (value === 0 && (!adj || (computed ?? 0) === 0)) return;
    lines.push({ rubriqueId: r.id, source: r.source, originMonth, computed, value, adjusted: adj !== undefined, note: adj?.note ?? null });
  };
  for (const r of input.rubriques) {
    if (!r.active) continue;
    push(r, input.month, r.source === 'manual' ? null : computedValueOf(r, input.values));
  }
  // régularisation lines: the deltas, and HR's adjustments of an origin month whose delta is now 0
  const regs = new Map(input.regularizations.map((g) => [`${g.originMonth}|${g.rubriqueId}`, g]));
  for (const a of input.adjustments) {
    const key = `${a.originMonth}|${a.rubriqueId}`;
    if (a.originMonth !== input.month && !regs.has(key)) regs.set(key, { originMonth: a.originMonth, rubriqueId: a.rubriqueId, delta: 0 });
  }
  for (const g of regs.values()) {
    const r = byId.get(g.rubriqueId);
    if (!r || !r.active || r.source === 'manual' || g.originMonth >= input.month) continue;
    push(r, g.originMonth, g.delta);
  }
  return lines.toSorted((a, b) => {
    const ra = byId.get(a.rubriqueId);
    const rb = byId.get(b.rubriqueId);
    return (
      (ra?.sortOrder ?? 0) - (rb?.sortOrder ?? 0) ||
      (ra?.exportCode ?? '').localeCompare(rb?.exportCode ?? '') ||
      (a.originMonth < b.originMonth ? 1 : a.originMonth > b.originMonth ? -1 : 0)
    );
  });
}
