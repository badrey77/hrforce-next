import { CLOSED_PERIOD_SUMMARY, OPEN_PERIOD_SUMMARY } from '../../../testing/payroll-fixtures';
import {
  addMonths,
  defaultMonth,
  formatValue,
  monthsOfYear,
  parseValue,
  periodLabel,
  resolvePayrollQuery,
  toPayrollQueryParams,
  valueInputText,
} from './payroll-state';

describe('payroll month state', () => {
  it('reads the URL defensively: a malformed or future month, an unknown filter and bad paging fall back', () => {
    const q = resolvePayrollQuery({ month: '2026-13', filter: 'nope', page: '0', pageSize: '9999' }, '2026-10');
    expect(q.month).toBeNull();
    expect(q.variables).toEqual({ unitId: null, includeSubUnits: true, q: '', rubriqueId: null, filter: null, page: 1, pageSize: 50 });
    expect(resolvePayrollQuery({ month: '2026-11' }, '2026-10').month).toBeNull();
    const full = resolvePayrollQuery(
      { month: '2026-09', unitId: 'u-1', includeSubUnits: 'false', q: 'ben', rubriqueId: 'r-1', filter: 'regularization', page: '3', pageSize: '25', employee: 'e-1' },
      '2026-10',
    );
    expect(full).toEqual({
      month: '2026-09',
      employee: 'e-1',
      variables: { unitId: 'u-1', includeSubUnits: false, q: 'ben', rubriqueId: 'r-1', filter: 'regularization', page: 3, pageSize: 25 },
    });
  });

  it('writes only what differs from the default', () => {
    expect(toPayrollQueryParams({ page: 1, q: '', unitId: null, filter: 'flagged', month: '2026-09', employee: null, includeSubUnits: true })).toEqual({
      page: null,
      q: null,
      unitId: null,
      filter: 'flagged',
      month: '2026-09',
      employee: null,
      includeSubUnits: null,
    });
    expect(toPayrollQueryParams({ includeSubUnits: false, pageSize: 100 })).toEqual({ includeSubUnits: 'false', pageSize: '100' });
  });

  it('defaults to the latest open month up to the current one', () => {
    expect(defaultMonth([CLOSED_PERIOD_SUMMARY, OPEN_PERIOD_SUMMARY], '2026-10')).toBe('2026-10');
    expect(defaultMonth([{ ...OPEN_PERIOD_SUMMARY, month: '2026-08' }, CLOSED_PERIOD_SUMMARY, { ...OPEN_PERIOD_SUMMARY, status: 'closed' }], '2026-10')).toBe('2026-08');
    expect(defaultMonth([], '2026-10')).toBe('2026-10');
    expect(defaultMonth([{ ...OPEN_PERIOD_SUMMARY, month: '2026-10-01' }], '2026-10')).toBe('2026-10');
  });

  it('lays out the 12 months of a year, the ones after the current month marked future', () => {
    const cells = monthsOfYear(2026, [CLOSED_PERIOD_SUMMARY, OPEN_PERIOD_SUMMARY], '2026-10');
    expect(cells).toHaveLength(12);
    expect(cells[0]).toEqual({ month: '2026-01', summary: null, future: false });
    expect(cells[8]?.summary?.status).toBe('closed');
    expect(cells[10]).toEqual({ month: '2026-11', summary: null, future: true });
  });

  it('shifts months and labels origin periods', () => {
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(periodLabel('2026-09')).toBe('09/2026');
    expect(periodLabel('2026-09-01')).toBe('09/2026');
  });

  it('formats values with the locale, up to two decimals, with a real minus sign', () => {
    expect(formatValue(2.5, 'fr')).toBe('2,5');
    expect(formatValue(-1, 'fr')).toBe('−1');
    expect(formatValue(12.25, 'en-US')).toBe('12.25');
    expect(formatValue(3, 'ar-DZ')).toBe('3');
  });

  it('parses a typed value: comma or dot, spaces, minus signs, two decimals at most, bounded', () => {
    expect(parseValue('2,5')).toBe(2.5);
    expect(parseValue(' 12.25 ')).toBe(12.25);
    expect(parseValue('−1')).toBe(-1);
    expect(parseValue('-0,5')).toBe(-0.5);
    expect(parseValue('12 000')).toBe(12000);
    expect(parseValue('1,234')).toBeNull();
    expect(parseValue('abc')).toBeNull();
    expect(parseValue('')).toBeNull();
    expect(parseValue('1000000000')).toBeNull();
    expect(parseValue('999999999.99')).toBe(999999999.99);
  });

  it('shows a number in the value input with the UI language decimal mark', () => {
    expect(valueInputText(2.5, 'fr')).toBe('2,5');
    expect(valueInputText(2.5, 'ar')).toBe('2,5');
    expect(valueInputText(2.5, 'en')).toBe('2.5');
    expect(valueInputText(-3, 'fr')).toBe('-3');
  });
});
