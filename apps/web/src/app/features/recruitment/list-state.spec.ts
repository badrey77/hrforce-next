import { DEFAULT_CANDIDATE_QUERY, DEFAULT_OPENING_QUERY } from '../../core/recruitment/recruitment.models';
import { resolveCandidateQuery, resolveOpeningQuery, toQueryParams } from './list-state';

describe('recruitment list state', () => {
  it('an empty URL is the default query', () => {
    expect(resolveOpeningQuery({})).toEqual(DEFAULT_OPENING_QUERY);
    expect(resolveCandidateQuery({})).toEqual(DEFAULT_CANDIDATE_QUERY);
  });

  it('unknown values fall back to the defaults instead of reaching the API', () => {
    const query = resolveOpeningQuery({ status: 'nope', contractType: 'x', sort: 'salary', page: '-3', pageSize: '7' });
    expect(query).toEqual(DEFAULT_OPENING_QUERY);
    expect(resolveCandidateQuery({ stage: 'x', state: 'y', idle: 'yes' })).toEqual(DEFAULT_CANDIDATE_QUERY);
  });

  it('each sort has its natural direction unless the URL says otherwise', () => {
    expect(resolveOpeningQuery({ sort: 'title' })).toMatchObject({ sort: 'title', dir: 'asc' });
    expect(resolveOpeningQuery({ sort: 'title', dir: 'desc' })).toMatchObject({ sort: 'title', dir: 'desc' });
    expect(resolveOpeningQuery({})).toMatchObject({ sort: 'requestedAt', dir: 'desc' });
  });

  it('toQueryParams removes what is back to its default', () => {
    expect(toQueryParams({ status: 'closed', page: 1, q: '' }, DEFAULT_OPENING_QUERY)).toEqual({ status: 'closed', page: null, q: null });
    expect(toQueryParams({ status: 'active' }, DEFAULT_OPENING_QUERY)).toEqual({ status: null });
    expect(toQueryParams({ idle: true, stage: 'interview' }, DEFAULT_CANDIDATE_QUERY)).toEqual({ idle: 'true', stage: 'interview' });
  });

  it('toQueryParams writes the direction only when it is not the sort’s natural one', () => {
    expect(toQueryParams({ sort: 'title', dir: 'asc' }, DEFAULT_OPENING_QUERY)).toEqual({ sort: 'title', dir: null });
    expect(toQueryParams({ sort: 'title', dir: 'desc' }, DEFAULT_OPENING_QUERY)).toEqual({ sort: 'title', dir: 'desc' });
    expect(toQueryParams({ sort: 'requestedAt', dir: 'asc' }, DEFAULT_OPENING_QUERY)).toEqual({ sort: null, dir: 'asc' });
  });
});
