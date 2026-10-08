import { boardCard, boardView, stageCounts } from '../../../testing/recruitment-fixtures';
import {
  activeCount,
  candidateParams,
  daysSince,
  DEFAULT_CANDIDATE_QUERY,
  DEFAULT_OPENING_QUERY,
  matchQueryOf,
  openingParams,
  restorableCount,
} from './recruitment.models';

describe('recruitment models', () => {
  it('openingParams: the default list asks for the active openings, newest request first', () => {
    expect(openingParams(DEFAULT_OPENING_QUERY)).toEqual({ status: 'active', sort: 'requestedAt', dir: 'desc', page: '1', pageSize: '25' });
  });

  it('openingParams: sub-units only travel with a unit; the search is trimmed', () => {
    const params = openingParams({ ...DEFAULT_OPENING_QUERY, unitId: 'u-1', includeSubUnits: false, contractType: 'cdd', q: '  agent ' });
    expect(params).toMatchObject({ unitId: 'u-1', includeSubUnits: 'false', contractType: 'cdd', q: 'agent' });
    expect(openingParams({ ...DEFAULT_OPENING_QUERY, includeSubUnits: false })).not.toHaveProperty('includeSubUnits');
  });

  it('candidateParams: « sans mouvement » becomes idleMonths=6; Arabic sorts by the Arabic name', () => {
    expect(candidateParams({ ...DEFAULT_CANDIDATE_QUERY, idle: true, stage: 'interview' }, 'ar')).toMatchObject({
      state: 'active',
      idleMonths: '6',
      stage: 'interview',
      lang: 'ar',
    });
    expect(candidateParams(DEFAULT_CANDIDATE_QUERY, 'fr')).not.toHaveProperty('lang');
  });

  it('daysSince: whole days, never negative, 0 for an unreadable date', () => {
    const now = Date.parse('2026-10-07T12:00:00Z');
    expect(daysSince('2026-10-03T10:00:00Z', now)).toBe(4);
    expect(daysSince('2026-10-07T11:00:00Z', now)).toBe(0);
    expect(daysSince('2026-10-09T11:00:00Z', now)).toBe(0);
    expect(daysSince('nope', now)).toBe(0);
  });

  it('activeCount: the four active stages only', () => {
    expect(activeCount(stageCounts({ received: 2, shortlisted: 1, interview: 2, offer: 1, hired: 3, rejected: 4 }))).toBe(6);
  });

  it('restorableCount: the rejected cards closed with the opening', () => {
    const closed = { code: 'opening_closed', labels: { fr: 'Recrutement clôturé', ar: 'x', en: 'x' } };
    const other = { code: 'experience', labels: { fr: 'Expérience insuffisante', ar: 'x', en: 'x' } };
    const board = boardView([
      boardCard({ id: 'a-1', stage: 'rejected', rejectionReason: closed }),
      boardCard({ id: 'a-2', stage: 'rejected', rejectionReason: closed }),
      boardCard({ id: 'a-3', stage: 'rejected', rejectionReason: other }),
      boardCard({ id: 'a-4', stage: 'withdrawn' }),
    ]);
    expect(restorableCount(board)).toBe(2);
  });

  describe('matchQueryOf', () => {
    const empty = { nin: '', email: '', phone: '', lastName: '', firstName: '', birthDate: '' };

    it('nothing usable → undefined (the API would answer 422)', () => {
      expect(matchQueryOf(empty)).toBeUndefined();
      expect(matchQueryOf({ ...empty, lastName: 'TESTEUR' })).toBeUndefined();
      expect(matchQueryOf({ ...empty, nin: '123', phone: '05' })).toBeUndefined();
    });

    it('a NIN typed with spaces is sent as 18 digits', () => {
      expect(matchQueryOf({ ...empty, nin: '199504 120000 000017' })).toEqual({ nin: '199504120000000017' });
    });

    it('the name pair carries the birth date; an incomplete e-mail is left out', () => {
      expect(matchQueryOf({ ...empty, lastName: ' TESTEUR ', firstName: 'Nadia', birthDate: '1995-04-12', email: 'nadia' })).toEqual({
        lastName: 'TESTEUR',
        firstName: 'Nadia',
        birthDate: '1995-04-12',
      });
    });
  });
});
