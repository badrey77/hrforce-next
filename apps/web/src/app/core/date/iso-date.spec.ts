import { isIsoDate, todayIso } from './iso-date';

describe('iso-date', () => {
  it('formats today in local time as YYYY-MM-DD', () => {
    expect(todayIso(new Date(2025, 0, 5, 23, 59))).toBe('2025-01-05');
  });

  it('accepts only real calendar dates', () => {
    expect(isIsoDate('2024-02-29')).toBe(true);
    expect(isIsoDate('2025-02-29')).toBe(false);
    expect(isIsoDate('2025-1-05')).toBe(false);
    expect(isIsoDate(undefined)).toBe(false);
  });
});
