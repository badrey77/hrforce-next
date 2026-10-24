import { describe, expect, it } from 'vitest';
import { buildLines, regularizationsOf, type ClosedLineFact, type RubriqueFact } from './lines.js';
import { closeRefusal, cutoffDate, isLatestClosed, regularizationOrigins, round2 } from './period.js';

const labels = { fr: 'x', ar: 'x', en: 'x' };
const R = (id: string, source: RubriqueFact['source'], over: Partial<RubriqueFact> = {}): RubriqueFact => ({
  id,
  source,
  leaveTypeId: source === 'leave' ? `t-${id}` : null,
  exportCode: id.toUpperCase(),
  names: labels,
  unit: source === 'late' || source.startsWith('overtime') ? 'hours' : 'days',
  active: true,
  sortOrder: 0,
  ...over,
});
const annual = R('cg', 'leave', { sortOrder: 1 });
const absence = R('abs', 'absence', { sortOrder: 2 });
const prime = R('prime', 'manual', { unit: 'amount', sortOrder: 3 });
const overtime = R('hs', 'overtime_normal', { active: false, sortOrder: 4 });
const RUBRIQUES = [annual, absence, prime, overtime];
const closedLine = (rubriqueId: string, originMonth: string, computedValue: number | null, over: Partial<ClosedLineFact> = {}): ClosedLineFact => ({
  rubriqueId,
  originMonth,
  computedValue,
  value: computedValue ?? 0,
  adjusted: false,
  ...over,
});

describe('régularisations', () => {
  const SEP = '2026-09-01';

  it('a leave approved after the closing gives the missing days', () => {
    const recomputed = new Map([
      ['leave:t-cg', 5],
      ['absence', 1],
    ]);
    const regs = regularizationsOf({ origin: SEP, rubriques: RUBRIQUES, recomputed, closed: [closedLine('cg', SEP, 3), closedLine('abs', SEP, 1)], later: [] });
    expect(regs).toEqual([{ originMonth: SEP, rubriqueId: 'cg', delta: 2 }]);
  });

  it('a value that went away gives a negative delta', () => {
    const regs = regularizationsOf({ origin: SEP, rubriques: RUBRIQUES, recomputed: new Map(), closed: [closedLine('abs', SEP, 2)], later: [] });
    expect(regs).toEqual([{ originMonth: SEP, rubriqueId: 'abs', delta: -2 }]);
  });

  it('a second régularisation is not doubled (the later closings already carried it, even when HR changed its value)', () => {
    const recomputed = new Map([['leave:t-cg', 5]]);
    const later = [closedLine('cg', SEP, 2, { value: 0, adjusted: true })];
    expect(regularizationsOf({ origin: SEP, rubriques: RUBRIQUES, recomputed, closed: [closedLine('cg', SEP, 3)], later })).toEqual([]);
    // one more day since: only that day
    const more = new Map([['leave:t-cg', 6]]);
    expect(regularizationsOf({ origin: SEP, rubriques: RUBRIQUES, recomputed: more, closed: [closedLine('cg', SEP, 3)], later })).toEqual([
      { originMonth: SEP, rubriqueId: 'cg', delta: 1 },
    ]);
  });

  it('skips a line HR adjusted in the closed month, manual and inactive rubriques', () => {
    const recomputed = new Map([
      ['leave:t-cg', 5],
      ['overtime_normal', 3],
    ]);
    const closed = [closedLine('cg', SEP, 3, { value: 4, adjusted: true }), closedLine('prime', SEP, null, { value: 1000, adjusted: true })];
    expect(regularizationsOf({ origin: SEP, rubriques: RUBRIQUES, recomputed, closed, later: [] })).toEqual([]);
  });

  it('takes the closed months of the window only', () => {
    const closed = ['2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01'];
    expect(regularizationOrigins('2026-10-01', 3, closed)).toEqual(['2026-07-01', '2026-08-01', '2026-09-01']);
    expect(regularizationOrigins('2026-10-01', 0, closed)).toEqual([]);
    expect(regularizationOrigins('2026-10-01', 1, ['2026-08-01'])).toEqual([]);
    expect(regularizationOrigins('2026-02-01', 2, ['2025-12-01', '2026-01-01', '2026-02-01'])).toEqual(['2025-12-01', '2026-01-01']);
  });
});

describe('buildLines', () => {
  const OCT = '2026-10-01';
  const values = new Map([
    ['leave:t-cg', 3],
    ['absence', 2],
    ['overtime_normal', 4],
  ]);

  it('one line per active rubrique with a value; adjustments win; manual lines are HR’s values only', () => {
    const lines = buildLines({
      month: OCT,
      rubriques: RUBRIQUES,
      values,
      regularizations: [],
      adjustments: [
        { originMonth: OCT, rubriqueId: 'abs', value: 1, note: 'justifié' },
        { originMonth: OCT, rubriqueId: 'prime', value: 15000, note: null },
        { originMonth: OCT, rubriqueId: 'hs', value: 2, note: null },
      ],
    });
    expect(lines).toEqual([
      { rubriqueId: 'cg', source: 'leave', originMonth: OCT, computed: 3, value: 3, adjusted: false, note: null },
      { rubriqueId: 'abs', source: 'absence', originMonth: OCT, computed: 2, value: 1, adjusted: true, note: 'justifié' },
      { rubriqueId: 'prime', source: 'manual', originMonth: OCT, computed: null, value: 15000, adjusted: true, note: null },
    ]);
  });

  it('a zero value gives no line, except HR’s 0 over a non-zero computed value', () => {
    const lines = buildLines({
      month: OCT,
      rubriques: RUBRIQUES,
      values: new Map([['absence', 2]]),
      regularizations: [],
      adjustments: [
        { originMonth: OCT, rubriqueId: 'abs', value: 0, note: null },
        { originMonth: OCT, rubriqueId: 'prime', value: 0, note: null },
        { originMonth: OCT, rubriqueId: 'cg', value: 0, note: null },
      ],
    });
    expect(lines).toEqual([{ rubriqueId: 'abs', source: 'absence', originMonth: OCT, computed: 2, value: 0, adjusted: true, note: null }]);
  });

  it('adds régularisation lines after the month’s own line; an adjusted origin stays after its delta is gone', () => {
    const lines = buildLines({
      month: OCT,
      rubriques: RUBRIQUES,
      values: new Map([['leave:t-cg', 3]]),
      regularizations: [
        { originMonth: '2026-08-01', rubriqueId: 'cg', delta: 1 },
        { originMonth: '2026-09-01', rubriqueId: 'cg', delta: 2 },
        { originMonth: '2026-09-01', rubriqueId: 'hs', delta: 2 },
      ],
      adjustments: [
        { originMonth: '2026-09-01', rubriqueId: 'cg', value: 1.5, note: null },
        { originMonth: '2026-07-01', rubriqueId: 'abs', value: -1, note: 'retenue' },
      ],
    });
    expect(lines.map((l) => [l.rubriqueId, l.originMonth, l.computed, l.value, l.adjusted])).toEqual([
      ['cg', OCT, 3, 3, false],
      ['cg', '2026-09-01', 2, 1.5, true],
      ['cg', '2026-08-01', 1, 1, false],
      ['abs', '2026-07-01', 0, -1, true],
    ]);
  });
});

const open = (month: string, hasClosings = false) => ({ month, status: 'open' as const, hasClosings });
const closed = (month: string) => ({ month, status: 'closed' as const, hasClosings: true });

describe('periods', () => {
  it('cut-off date and rounding', () => {
    expect(cutoffDate('2026-10-01', 20)).toBe('2026-10-20');
    expect(cutoffDate('2026-02-01', 5)).toBe('2026-02-05');
    expect(round2(0.615)).toBe(0.62);
    expect(round2(-0.005)).toBe(-0.01);
    expect(round2(-0.001)).toBe(0);
  });

  it('refuses before the cut-off, a closed month, a reopened earlier month and a gap', () => {
    expect(closeRefusal('2026-10-01', '2026-10-19', 20, [])).toBe('payroll-before-cutoff');
    expect(closeRefusal('2026-10-01', '2026-10-20', 20, [])).toBeNull();
    expect(closeRefusal('2026-10-01', '2026-11-03', 20, [closed('2026-10-01')])).toBe('payroll-period-closed');
    expect(closeRefusal('2026-10-01', '2026-10-24', 20, [closed('2026-08-01'), open('2026-09-01', true)])).toBe('payroll-previous-open');
    expect(closeRefusal('2026-10-01', '2026-10-24', 20, [closed('2026-08-01')])).toBe('payroll-previous-open');
    expect(closeRefusal('2026-10-01', '2026-10-24', 20, [closed('2026-08-01'), closed('2026-09-01')])).toBeNull();
    // the first closing ever: earlier months never closed are no obstacle
    expect(closeRefusal('2026-10-01', '2026-10-24', 20, [open('2026-09-01')])).toBeNull();
  });

  it('only the latest closed month may be reopened', () => {
    const periods = [closed('2026-08-01'), closed('2026-09-01'), open('2026-10-01')];
    expect(isLatestClosed('2026-09-01', periods)).toBe(true);
    expect(isLatestClosed('2026-08-01', periods)).toBe(false);
    expect(isLatestClosed('2026-10-01', periods)).toBe(false);
  });
});
