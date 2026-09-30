import {
  addDays,
  addMonths,
  algiersToday,
  formatMinutes,
  formatPairingCode,
  kioskLabel,
  monthRange,
  normalizePairingCode,
  retentionPeriod,
  scheduledMinutesOf,
  standardWeek,
  statusTone,
  type Week,
  weekErrors,
  weeklyMinutesOf,
} from './attendance.models';

describe('attendance models', () => {
  it('formats minutes as "1 h 05" / "1 س 05 د", under an hour as minutes', () => {
    expect(formatMinutes(65, 'fr')).toBe('1 h 05');
    expect(formatMinutes(65, 'en')).toBe('1 h 05');
    expect(formatMinutes(65, 'ar')).toBe('1 س 05 د');
    expect(formatMinutes(45, 'fr')).toBe('45 min');
    expect(formatMinutes(45, 'ar')).toBe('45 د');
    expect(formatMinutes(480, 'fr')).toBe('8 h 00');
    expect(formatMinutes(-3, 'fr')).toBe('0 min');
  });

  it('normalises pairing codes like the API (case, hyphens, spaces, O→0, I/L→1) and refuses other letters', () => {
    expect(normalizePairingCode('k7m2-9qxa')).toBe('K7M29QXA');
    expect(normalizePairingCode(' K7M2 9QXA ')).toBe('K7M29QXA');
    expect(normalizePairingCode('DEMK-2O26')).toBe('DEMK2026');
    expect(normalizePairingCode('ABCD-EFGl')).toBe('ABCDEFG1');
    expect(normalizePairingCode('ABCD-EFGU')).toBeNull(); // U is not Crockford
    expect(normalizePairingCode('ABC')).toBeNull();
    expect(formatPairingCode('K7M29QXA')).toBe('K7M2-9QXA');
  });

  it('states the retention in years when it divides by 12, else in months', () => {
    expect(retentionPeriod(60)).toEqual({ unit: 'years', count: 5 });
    expect(retentionPeriod(18)).toEqual({ unit: 'months', count: 18 });
  });

  it('computes today in Algiers (UTC+1) whatever the device zone: 23:30Z is already the next day', () => {
    expect(algiersToday(Date.parse('2026-09-28T23:30:00Z'))).toBe('2026-09-29');
    expect(algiersToday(Date.parse('2026-09-28T22:59:59Z'))).toBe('2026-09-28');
  });

  it('does calendar arithmetic on days and months', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-12', 1)).toBe('2027-01');
  });

  it('cuts a month range at today and refuses a month that has not started', () => {
    expect(monthRange('2026-08', '2026-09-29')).toEqual({ from: '2026-08-01', to: '2026-08-31' });
    expect(monthRange('2026-09', '2026-09-29')).toEqual({ from: '2026-09-01', to: '2026-09-29' });
    expect(monthRange('2026-10', '2026-09-29')).toBeNull();
    expect(monthRange('2028-02', '2028-12-01')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
  });

  it('counts scheduled minutes: end − start − break; the standard week is 40 h', () => {
    expect(scheduledMinutesOf({ day: 7, start: '08:00', end: '16:30', breakStart: '12:00', breakEnd: '12:30' })).toBe(480);
    expect(scheduledMinutesOf({ day: 5, rest: true })).toBe(0);
    expect(weeklyMinutesOf(standardWeek())).toBe(2400);
  });

  it('checks the week rules with the API codes and fields', () => {
    const week: Week = [
      { day: 1, start: '09:00', end: '08:00', breakStart: null, breakEnd: null },
      { day: 2, start: '08:00', end: '16:00', breakStart: '12:00', breakEnd: null },
      { day: 3, start: '08:00', end: '16:00', breakStart: '07:00', breakEnd: '07:30' },
      { day: 4, start: '08:00', end: '16:00', breakStart: '12:00', breakEnd: '12:30' },
      { day: 5, rest: true },
      { day: 6, rest: true },
      { day: 7, rest: true },
    ];
    expect(weekErrors(week)).toEqual([
      { field: 'week.0.end', code: 'invalid_time' },
      { field: 'week.1.breakEnd', code: 'invalid_break' },
      { field: 'week.2.breakEnd', code: 'invalid_break' },
    ]);
    expect(weekErrors(week.map((day) => ({ day: day.day, rest: true as const })))).toEqual([{ field: 'week', code: 'no_working_day' }]);
    expect(weekErrors(standardWeek())).toEqual([]);
  });

  it('picks the kiosk label in the UI language (French for fr and en)', () => {
    const labels = { fr: 'Siège — Entrée principale', ar: 'المقر — المدخل الرئيسي' };
    expect(kioskLabel(labels, 'ar')).toBe('المقر — المدخل الرئيسي');
    expect(kioskLabel(labels, 'en')).toBe('Siège — Entrée principale');
  });

  it('gives each status a tone', () => {
    expect(statusTone('present')).toBe('ok');
    expect(statusTone('late')).toBe('warn');
    expect(statusTone('absent')).toBe('bad');
    expect(statusTone('expected')).toBe('info');
    expect(statusTone('holiday')).toBe('off');
  });
});
