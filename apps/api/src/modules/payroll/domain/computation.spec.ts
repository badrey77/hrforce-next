import { describe, expect, it } from 'vitest';
import { leaveDaysWithin } from '../../leave/index.js';
import { attendanceDates, attendanceInUse, computeMonth, type AttendanceDayFact, type LeaveRequestFact, type MonthInput } from './computation.js';

// weekend Friday + Saturday; 2026-11-01 (Sunday) is a public holiday
const HOLIDAYS = [{ date: '2026-11-01', name: 'Révolution' }];
const MODES: Record<string, 'calendar' | 'working'> = { annual: 'calendar', special: 'working' };
const counter = (r: LeaveRequestFact, from: string, to: string) =>
  leaveDaysWithin(r, from, to, { countMode: MODES[r.leaveTypeId] ?? 'calendar', weekendDays: [5, 6], holidays: HOLIDAYS });

const approved = (over: Partial<LeaveRequestFact>): LeaveRequestFact => ({
  leaveTypeId: 'annual',
  status: 'approved',
  startDate: '2026-10-05',
  endDate: '2026-10-05',
  halfDayStart: false,
  halfDayEnd: false,
  ...over,
});

const day = (date: string, over: Partial<AttendanceDayFact> = {}): AttendanceDayFact => ({
  date,
  status: 'present',
  final: true,
  lateMinutes: 0,
  workedMinutes: 480,
  scheduledMinutes: 480,
  inUse: true,
  ...over,
});

const input = (over: Partial<MonthInput>): MonthInput => ({
  month: '2026-10-01',
  today: '2026-10-24',
  employment: { hireDate: '2020-01-01', endDate: null },
  leave: [],
  days: [],
  overtimeMinMinutes: 30,
  countLeaveDays: counter,
  ...over,
});

const values = (over: Partial<MonthInput>) => Object.fromEntries(computeMonth(input(over)).values);

describe('leave', () => {
  it('counts only the days of the month of a request across two months (calendar type)', () => {
    const leave = [approved({ startDate: '2026-09-28', endDate: '2026-10-03' })];
    expect(values({ leave })).toEqual({ 'leave:annual': 3 });
    expect(values({ month: '2026-09-01', leave })).toEqual({ 'leave:annual': 3 });
  });

  it('counts a half day only on the request’s own first / last day', () => {
    const leave = [approved({ startDate: '2026-09-29', endDate: '2026-10-02', halfDayStart: true, halfDayEnd: true })];
    // September: 29 (half), 30 → 1.5 ; October: 1, 2 (half) → 1.5
    expect(values({ month: '2026-09-01', leave })).toEqual({ 'leave:annual': 1.5 });
    expect(values({ leave })).toEqual({ 'leave:annual': 1.5 });
    expect(values({ leave: [approved({ halfDayStart: true })] })).toEqual({ 'leave:annual': 0.5 });
  });

  it('counts a working-day type without the weekend and the public holidays', () => {
    // 2026-10-29 Thu … 2026-11-03 Tue: Oct 29 counts, 30–31 weekend; Nov 1 holiday, 2 and 3 count
    const leave = [approved({ leaveTypeId: 'special', startDate: '2026-10-29', endDate: '2026-11-03' })];
    expect(values({ leave })).toEqual({ 'leave:special': 1 });
    expect(values({ month: '2026-11-01', today: '2026-11-24', leave })).toEqual({ 'leave:special': 2 });
  });

  it('counts approved future days of the month, sums per type, ignores pending requests (flagged)', () => {
    const leave = [
      approved({ startDate: '2026-10-26', endDate: '2026-10-28' }),
      approved({ startDate: '2026-10-05', endDate: '2026-10-06' }),
      approved({ leaveTypeId: 'special', startDate: '2026-10-07', endDate: '2026-10-07' }),
      approved({ status: 'pending', startDate: '2026-10-11', endDate: '2026-10-12' }),
    ];
    const r = computeMonth(input({ leave }));
    expect(Object.fromEntries(r.values)).toEqual({ 'leave:annual': 5, 'leave:special': 1 });
    expect(r.pendingLeave).toBe(true);
    expect(computeMonth(input({ leave: leave.slice(0, 3) })).pendingLeave).toBe(false);
  });

  it('counts only the employed days of the month (hire / exit inside the month)', () => {
    const leave = [approved({ startDate: '2026-10-01', endDate: '2026-10-10' })];
    expect(values({ leave, employment: { hireDate: '2026-10-06', endDate: null } })['leave:annual']).toBe(5);
    expect(values({ leave, employment: { hireDate: '2020-01-01', endDate: '2026-10-03' } })['leave:annual']).toBe(3);
  });
});

describe('entries and exits', () => {
  it('emits service days only for a month with a hire or an exit, a known end date counting', () => {
    expect(values({})['service_days']).toBeUndefined();
    const hired = computeMonth(input({ employment: { hireDate: '2026-10-12', endDate: null } }));
    expect(hired.values.get('service_days')).toBe(20);
    expect(hired.entry).toBe('2026-10-12');
    expect(hired.exit).toBeNull();
    // ends after today, inside the month: the known end date counts
    const leaving = computeMonth(input({ employment: { hireDate: '2020-01-01', endDate: '2026-10-28' } }));
    expect(leaving.values.get('service_days')).toBe(28);
    expect(leaving.exit).toBe('2026-10-28');
    expect(values({ employment: { hireDate: '2026-10-05', endDate: '2026-10-09' } })['service_days']).toBe(5);
  });

  it('employed attendance days stop at today and at the end date', () => {
    expect(attendanceDates('2026-10-01', { hireDate: '2026-10-20', endDate: null }, '2026-10-24')).toEqual(['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24']);
    expect(attendanceDates('2026-10-01', { hireDate: '2026-10-01', endDate: '2026-10-02' }, '2026-10-24')).toEqual(['2026-10-01', '2026-10-02']);
    expect(attendanceDates('2026-10-01', { hireDate: '2026-10-25', endDate: null }, '2026-10-24')).toEqual([]);
  });
});

describe('attendance sources', () => {
  it('counts final absent days only where attendance is in use; today is not final', () => {
    const days = [
      day('2026-10-20', { status: 'absent', workedMinutes: 0 }),
      day('2026-10-21', { status: 'absent', workedMinutes: 0, inUse: false }),
      day('2026-10-22', { status: 'absent', workedMinutes: 0 }),
      day('2026-10-24', { status: 'absent', workedMinutes: 0, final: false }),
    ];
    const r = computeMonth(input({ days }));
    expect(r.values.get('absence')).toBe(2);
    expect(r.noAttendance).toBe(false);
  });

  it('flags no_attendance when no employed day had a kiosk, and counts no absence or lateness then', () => {
    const days = [day('2026-10-20', { status: 'absent', inUse: false, workedMinutes: 0 }), day('2026-10-21', { status: 'late', lateMinutes: 30, inUse: false })];
    const r = computeMonth(input({ days }));
    expect(r.noAttendance).toBe(true);
    expect(r.values.get('absence')).toBeUndefined();
    expect(r.values.get('late')).toBeUndefined();
    expect(computeMonth(input({ days: [] })).noAttendance).toBe(false);
  });

  it('sums late minutes in hours (two decimals) and counts incomplete days (flag only)', () => {
    const days = [
      day('2026-10-19', { status: 'late', lateMinutes: 25 }),
      day('2026-10-20', { status: 'late', lateMinutes: 12 }),
      day('2026-10-21', { status: 'incomplete', workedMinutes: 0 }),
      day('2026-10-24', { status: 'late', lateMinutes: 50, final: false }),
    ];
    const r = computeMonth(input({ days }));
    expect(r.values.get('late')).toBe(0.62);
    expect(r.incompleteDays).toBe(1);
    expect(r.values.has('absence')).toBe(false);
  });

  it('overtime: the threshold on working days, every worked minute on rest days and holidays', () => {
    const days = [
      day('2026-10-18', { workedMinutes: 509 }), // 29 min: below 30
      day('2026-10-19', { workedMinutes: 510 }), // 30 min
      day('2026-10-20', { status: 'late', lateMinutes: 15, workedMinutes: 540 }), // 60 min
      day('2026-10-21', { workedMinutes: 300 }), // a short day
      day('2026-10-16', { status: 'rest_day', workedMinutes: 135, scheduledMinutes: 0 }),
      day('2026-10-17', { status: 'rest_day', workedMinutes: 0, scheduledMinutes: 0 }),
      day('2026-10-22', { status: 'holiday', workedMinutes: 240, scheduledMinutes: 0 }),
      day('2026-10-24', { status: 'rest_day', workedMinutes: 200, scheduledMinutes: 0, final: false }),
    ];
    const v = values({ days });
    expect(v['overtime_normal']).toBe(1.5);
    expect(v['overtime_rest_day']).toBe(2.25);
    expect(v['overtime_holiday']).toBe(4);
    expect(values({ days, overtimeMinMinutes: 0 })['overtime_normal']).toBe(1.98);
  });

  it('ignores days outside the employed days', () => {
    const days = [day('2026-10-02', { status: 'absent', workedMinutes: 0 }), day('2026-10-12', { status: 'absent', workedMinutes: 0 })];
    expect(values({ days, employment: { hireDate: '2026-10-10', endDate: null } })['absence']).toBe(1);
  });
});

describe('attendanceInUse', () => {
  const spans = [
    { siteId: 's1', from: '2026-10-10', to: null },
    { siteId: 's2', from: '2026-09-01', to: '2026-10-15' },
  ];
  it('needs a kiosk of the site paired on or before the day and not revoked before it', () => {
    expect(attendanceInUse(spans, 's1', '2026-10-09')).toBe(false);
    expect(attendanceInUse(spans, 's1', '2026-10-10')).toBe(true);
    expect(attendanceInUse(spans, 's2', '2026-10-15')).toBe(true);
    expect(attendanceInUse(spans, 's2', '2026-10-16')).toBe(false);
    expect(attendanceInUse(spans, 's3', '2026-10-16')).toBe(false);
    expect(attendanceInUse(spans, null, '2026-10-16')).toBe(false);
  });
});
