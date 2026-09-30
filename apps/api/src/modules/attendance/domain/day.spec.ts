import { describe, expect, it } from 'vitest';
import { computeDay, leavePartOn, type DayInput, type PunchFact } from './day.js';
import { algiersDate, algiersInstant } from './time.js';
import type { WeekDay } from './week.js';

const DAY = '2026-09-27'; // a Sunday (working day of the standard week)
const WORK: WeekDay = { day: 7, start: '08:00', end: '16:30', breakStart: '12:00', breakEnd: '12:30' };
const NO_BREAK: WeekDay = { day: 7, start: '09:00', end: '16:00', breakStart: null, breakEnd: null };
const REST: WeekDay = { day: 5, rest: true };

let seq = 0;
function punch(direction: 'in' | 'out', time: string, extra: Partial<PunchFact> = {}, date = DAY): PunchFact {
  const [h = '0', m = '0', s = '0'] = time.split(':');
  return {
    id: `p${String(++seq).padStart(4, '0')}`,
    direction,
    occurredAtMs: algiersInstant(date, Number(h) * 60 + Number(m)) + Number(s) * 1000,
    source: 'qr',
    status: 'live',
    siteId: 'site-a',
    deviceRef: null,
    ...extra,
  };
}

function day(punches: PunchFact[], extra: Partial<DayInput> = {}): ReturnType<typeof computeDay> {
  return computeDay({
    date: DAY,
    today: '2026-09-28',
    nowMs: algiersInstant('2026-09-28', '10:00'),
    employed: true,
    rule: { entry: WORK, toleranceMinutes: 10 },
    leave: null,
    leavePending: false,
    holiday: false,
    punches,
    siteId: 'site-a',
    sharedRefs: new Set(),
    showSharedDevice: true,
    ...extra,
  });
}

describe('computeDay — working days', () => {
  it('present: on time, full day, break subtracted', () => {
    const r = day([punch('in', '07:58'), punch('out', '16:34')]);
    expect(r).toMatchObject({ status: 'present', final: true, lateMinutes: 0, earlyDepartureMinutes: 0, scheduledMinutes: 480, flags: [] });
    expect(r.workedMinutes).toBe(8 * 60 + 36 - 30);
    expect(r.expectedStart).toBe(480);
    expect(r.expectedEnd).toBe(990);
  });

  it('tolerance boundary: exactly start + tolerance (seconds ignored) is on time; one minute more is late from the start', () => {
    expect(day([punch('in', '08:10:59'), punch('out', '16:30')]).status).toBe('present');
    const late = day([punch('in', '08:11'), punch('out', '16:30')]);
    expect(late).toMatchObject({ status: 'late', lateMinutes: 11 });
  });

  it('early departure: before end − tolerance on a closed day; exactly end − tolerance is not early', () => {
    expect(day([punch('in', '08:00'), punch('out', '16:20')]).flags).not.toContain('early_departure');
    const r = day([punch('in', '08:00'), punch('out', '15:00')]);
    expect(r).toMatchObject({ status: 'present', earlyDepartureMinutes: 90, flags: ['early_departure'] });
  });

  it('absent (final, no punch); expected (today before start + tolerance); absent today after it', () => {
    expect(day([]).status).toBe('absent');
    const today = { today: DAY, nowMs: algiersInstant(DAY, '08:09') };
    expect(day([], today).status).toBe('expected');
    expect(day([], { today: DAY, nowMs: algiersInstant(DAY, '08:10') }).status).toBe('absent');
  });

  it('incomplete: only an out; a final day with a pair still open (late minutes still reported)', () => {
    expect(day([punch('out', '16:30')]).status).toBe('incomplete');
    const open = day([punch('in', '08:20')]);
    expect(open).toMatchObject({ status: 'incomplete', lateMinutes: 20, flags: [] });
  });

  it('today with an open pair: present + open, no early departure yet', () => {
    const r = day([punch('in', '07:55')], { today: DAY, nowMs: algiersInstant(DAY, '11:00') });
    expect(r).toMatchObject({ status: 'present', flags: ['open'], workedMinutes: 0 });
    const back = day([punch('in', '07:55'), punch('out', '10:00'), punch('in', '10:30')], { today: DAY, nowMs: algiersInstant(DAY, '11:00') });
    expect(back.flags).toEqual(['open']);
    expect(back.earlyDepartureMinutes).toBe(0);
  });

  it('pairs: several pairs, unpaired in / out, break overlap, departure = last out after arrival', () => {
    const r = day([punch('out', '07:00'), punch('in', '08:00'), punch('in', '08:05'), punch('out', '12:15'), punch('in', '12:40'), punch('out', '16:30')]);
    expect(r.flags).toEqual(['unpaired_punch']);
    // 08:00–12:15 minus 12:00–12:15 of break = 240, then 12:40–16:30 = 230
    expect(r.workedMinutes).toBe(470);
    expect(r.status).toBe('present');
    expect(r.departureId).not.toBeNull();
  });

  it('void punches are ignored', () => {
    const r = day([punch('in', '08:00'), punch('out', '16:30'), punch('in', '17:00', { status: 'void' })]);
    expect(r.flags).toEqual([]);
  });

  it('half days: morning off → expected from the break end; afternoon off → until the break start; no break → the middle', () => {
    const morning = day([punch('in', '12:35'), punch('out', '16:30')], { leave: 'morning' });
    expect(morning).toMatchObject({ status: 'present', expectedStart: 750, scheduledMinutes: 240, flags: ['half_day_leave_morning'] });
    const afternoon = day([punch('in', '08:00'), punch('out', '12:00')], { leave: 'afternoon' });
    expect(afternoon).toMatchObject({ status: 'present', expectedEnd: 720, scheduledMinutes: 240, flags: ['half_day_leave_afternoon'] });
    const middle = day([], { rule: { entry: NO_BREAK, toleranceMinutes: 0 }, leave: 'afternoon' });
    expect(middle).toMatchObject({ expectedEnd: 750, scheduledMinutes: 210 });
    const middleMorning = day([], { rule: { entry: NO_BREAK, toleranceMinutes: 0 }, leave: 'morning' });
    expect(middleMorning.expectedStart).toBe(750);
  });

  it('flags: other_site (QR at another site), manual_punch, leave_pending, shared_device only when allowed', () => {
    const punches = [punch('in', '08:00', { siteId: 'site-b', deviceRef: 'ref1' }), punch('out', '16:30', { source: 'manual', siteId: null })];
    const r = day(punches, { leavePending: true, sharedRefs: new Set(['ref1']) });
    expect(r.flags).toEqual(['leave_pending', 'other_site', 'manual_punch', 'shared_device']);
    expect(day(punches, { sharedRefs: new Set(['ref1']), showSharedDevice: false }).flags).not.toContain('shared_device');
  });

  it('corrected (Phase B): a live correction punch, or a punch voided by a correction — not a plain HR void', () => {
    const added = day([punch('in', '08:00', { source: 'correction', siteId: null }), punch('out', '16:30')]);
    expect(added).toMatchObject({ status: 'present', flags: ['corrected'] });
    const voided = day([punch('in', '07:00', { status: 'void', voidedByCorrection: true }), punch('in', '08:05'), punch('out', '16:30')]);
    expect(voided).toMatchObject({ status: 'present', flags: ['corrected'] });
    expect(day([punch('in', '07:00', { status: 'void' }), punch('in', '08:05'), punch('out', '16:30')]).flags).toEqual([]);
  });
});

describe('computeDay — non-working days and precedence', () => {
  it('rest day, with work → worked_on_rest_day and worked minutes (no break subtraction)', () => {
    expect(day([], { rule: { entry: REST, toleranceMinutes: 10 } })).toMatchObject({ status: 'rest_day', scheduledMinutes: 0, flags: [] });
    const r = day([punch('in', '09:00'), punch('out', '13:00')], { rule: { entry: REST, toleranceMinutes: 10 } });
    expect(r).toMatchObject({ status: 'rest_day', workedMinutes: 240, flags: ['worked_on_rest_day'] });
  });

  it('holiday beats a working day; leave beats a holiday (leave on a holiday → on_leave)', () => {
    expect(day([], { holiday: true }).status).toBe('holiday');
    expect(day([punch('in', '08:00'), punch('out', '10:00')], { holiday: true }).flags).toEqual(['worked_on_holiday']);
    expect(day([], { holiday: true, leave: 'full' }).status).toBe('on_leave');
    expect(day([], { rule: { entry: REST, toleranceMinutes: 0 }, leave: 'full' }).status).toBe('on_leave');
    expect(day([punch('in', '08:00'), punch('out', '09:00')], { leave: 'full' }).flags).toEqual(['worked_on_leave']);
  });

  it('a half-day leave on a holiday is a holiday', () => {
    expect(day([], { holiday: true, leave: 'morning' }).status).toBe('holiday');
  });

  it('outside the employment → not_employed', () => {
    expect(day([punch('in', '08:00')], { employed: false })).toMatchObject({ status: 'not_employed', flags: [], arrivalId: null });
  });
});

const r = (startDate: string, endDate: string, halfDayStart: boolean, halfDayEnd: boolean) => ({ startDate, endDate, halfDayStart, halfDayEnd });

describe('leavePartOn', () => {
  it('full days, afternoon off on the start date, morning off on the end date; one-day requests', () => {
    expect(leavePartOn(r('2026-10-01', '2026-10-03', false, false), '2026-10-02')).toBe('full');
    expect(leavePartOn(r('2026-10-01', '2026-10-03', true, false), '2026-10-01')).toBe('afternoon');
    expect(leavePartOn(r('2026-10-01', '2026-10-03', true, true), '2026-10-03')).toBe('morning');
    expect(leavePartOn(r('2026-10-01', '2026-10-01', true, false), '2026-10-01')).toBe('afternoon');
    expect(leavePartOn(r('2026-10-01', '2026-10-01', false, true), '2026-10-01')).toBe('morning');
  });
});

describe('work date near midnight (Africa/Algiers, UTC+1)', () => {
  it('a punch at 23:30Z counts for the next Algerian day', () => {
    expect(algiersDate(Date.parse('2026-09-27T23:30:00Z'))).toBe('2026-09-28');
    expect(algiersDate(Date.parse('2026-09-27T22:59:59Z'))).toBe('2026-09-27');
  });
});
