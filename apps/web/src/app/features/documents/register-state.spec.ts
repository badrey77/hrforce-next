import { DEFAULT_DOCUMENT_QUERY } from '../../core/documents/documents.models';
import { resolveRegisterQuery, toRegisterQueryParams } from './register-state';

describe('register URL state', () => {
  it('parses defensively', () => {
    expect(resolveRegisterQuery({})).toEqual(DEFAULT_DOCUMENT_QUERY);
    const q = resolveRegisterQuery({ status: 'void', typeCode: 'titre_conge', from: '2026-02-30', to: '2026-09-30', page: '0', pageSize: '500', includeSubUnits: 'false' });
    expect(q).toMatchObject({ status: 'void', typeCode: 'titre_conge', from: null, to: '2026-09-30', page: 1, pageSize: 25, includeSubUnits: false });
    expect(resolveRegisterQuery({ status: 'bogus' }).status).toBe('all');
  });

  it('writes only what differs from the default', () => {
    expect(toRegisterQueryParams({ page: 1, status: 'all', typeCode: 'attestation_travail', q: '' })).toEqual({
      page: null,
      status: null,
      typeCode: 'attestation_travail',
      q: null,
    });
  });
});
