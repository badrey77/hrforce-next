import { DEFAULT_DEADLINE_QUERY } from '../../core/deadlines/deadlines.models';
import { resolveBoardQuery, toBoardQueryParams } from './board-state';

describe('deadlines board state', () => {
  it('parses the URL defensively', () => {
    expect(resolveBoardQuery({})).toEqual(DEFAULT_DEADLINE_QUERY);
    expect(resolveBoardQuery({ kind: 'nope', status: 'nope', within: '9999', page: '0', pageSize: '500', includeSubUnits: 'false' })).toEqual({
      ...DEFAULT_DEADLINE_QUERY,
      includeSubUnits: false,
    });
    expect(resolveBoardQuery({ kind: 'retirement', status: 'handled', within: '365', unitId: 'u-1', q: 'x', page: '3' })).toEqual({
      ...DEFAULT_DEADLINE_QUERY,
      kind: 'retirement',
      status: 'handled',
      within: 365,
      unitId: 'u-1',
      q: 'x',
      page: 3,
    });
  });

  it('writes only what differs from the default', () => {
    expect(toBoardQueryParams({ page: 1, status: 'open', within: 90, kind: null, q: '' })).toEqual({ page: null, status: null, within: null, kind: null, q: null });
    expect(toBoardQueryParams({ page: 2, status: 'all', within: 30, kind: 'contract_end' })).toEqual({ page: '2', status: 'all', within: '30', kind: 'contract_end' });
  });
});
