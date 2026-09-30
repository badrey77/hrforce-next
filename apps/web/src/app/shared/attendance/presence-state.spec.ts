import { DEFAULT_PRESENCE_QUERY } from '../../core/attendance/attendance.models';
import { resolvePresenceQuery, toPresenceQueryParams } from './presence-state';

describe('presence board URL state', () => {
  it('reads defaults from an empty URL and ignores garbage', () => {
    expect(resolvePresenceQuery({})).toEqual(DEFAULT_PRESENCE_QUERY);
    expect(
      resolvePresenceQuery({ date: '2026-02-30', status: 'nope', sort: 'salary', page: '-1', pageSize: '7', includeSubUnits: 'x' }),
    ).toEqual({ ...DEFAULT_PRESENCE_QUERY, includeSubUnits: true });
  });

  it('reads every filter', () => {
    expect(
      resolvePresenceQuery({
        date: '2026-09-28',
        unitId: 'r-est',
        includeSubUnits: 'false',
        siteId: 's-cne',
        status: 'late',
        q: 'benali',
        sort: 'arrival',
        page: '2',
        pageSize: '100',
      }),
    ).toEqual({
      date: '2026-09-28',
      unitId: 'r-est',
      includeSubUnits: false,
      siteId: 's-cne',
      status: 'late',
      q: 'benali',
      sort: 'arrival',
      page: 2,
      pageSize: 100,
    });
  });

  it('writes only what differs from the default; the default removes the param', () => {
    expect(toPresenceQueryParams({ page: 1, status: 'absent', date: null, sort: 'unit' })).toEqual({
      page: null,
      status: 'absent',
      date: null,
      sort: null,
    });
    expect(toPresenceQueryParams({ includeSubUnits: false, date: '2026-09-27' })).toEqual({ includeSubUnits: 'false', date: '2026-09-27' });
  });
});
