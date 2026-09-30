import { resolveCorrectionQuery, resolveReportQuery, toCorrectionQueryParams, toReportQueryParams } from './hr-list-state';

describe('Phase B URL state', () => {
  it('corrections: pending by default, ?status=all = every status, junk dropped', () => {
    expect(resolveCorrectionQuery({}).status).toBe('pending');
    expect(resolveCorrectionQuery({ status: 'all' }).status).toBeNull();
    expect(resolveCorrectionQuery({ status: 'approved', from: 'nope', pageSize: '7', page: '-1' })).toMatchObject({
      status: 'approved',
      from: null,
      pageSize: 25,
      page: 1,
    });
    expect(toCorrectionQueryParams({ status: null, page: 1, q: 'ben' })).toEqual({ status: 'all', page: null, q: 'ben' });
    expect(toCorrectionQueryParams({ status: 'pending', unitId: null })).toEqual({ status: null, unitId: null });
  });

  it('report: the current month (or a future or malformed one) stays out of the URL', () => {
    expect(resolveReportQuery({ month: '2026-08' }, '2026-09').month).toBe('2026-08');
    expect(resolveReportQuery({ month: '2026-09' }, '2026-09').month).toBeNull();
    expect(resolveReportQuery({ month: '2026-12' }, '2026-09').month).toBeNull();
    expect(resolveReportQuery({ month: '2026-13' }, '2026-09').month).toBeNull();
    expect(resolveReportQuery({ includeSubUnits: 'false', pageSize: '100' }, '2026-09')).toMatchObject({ includeSubUnits: false, pageSize: 100 });
    expect(toReportQueryParams({ month: null, page: 1, siteId: 's-cne' })).toEqual({ month: null, page: null, siteId: 's-cne' });
  });
});
