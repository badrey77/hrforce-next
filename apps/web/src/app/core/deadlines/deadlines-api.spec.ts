import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Injector, runInInjectionContext, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { CRITICAL_ITEM, DOCUMENT_ITEM, HANDLED_ITEM, PROBATION_ITEM, POLICY } from '../../../testing/deadline-fixtures';
import { DeadlinesApi, deadlineListParams } from './deadlines-api';
import { ackSubjectId, addDays, DEFAULT_DEADLINE_QUERY, type DeadlineQuery, groupItems } from './deadlines.models';

describe('deadlines models', () => {
  it('groups a page into overdue / next 30 days / later / handled, keeping the API order', () => {
    const groups = groupItems([PROBATION_ITEM, CRITICAL_ITEM, DOCUMENT_ITEM, HANDLED_ITEM]);
    expect(groups.map((g) => [g.group, g.items.map((i) => i.key)])).toEqual([
      ['overdue', [CRITICAL_ITEM.key]],
      ['soon', [PROBATION_ITEM.key]],
      ['later', [DOCUMENT_ITEM.key]],
      ['handled', [HANDLED_ITEM.key]],
    ]);
    expect(groupItems([])).toEqual([]);
  });

  it('an ack names the contract, the file or the employment', () => {
    expect(ackSubjectId(CRITICAL_ITEM)).toBe('c-1');
    expect(ackSubjectId(DOCUMENT_ITEM)).toBe('f-1');
    expect(ackSubjectId({ ...CRITICAL_ITEM, kind: 'retirement', contract: null })).toBe('emp-27');
    expect(ackSubjectId({ ...CRITICAL_ITEM, kind: 'contract_missing', contract: null })).toBe('emp-27');
  });

  it('adds calendar days without a time-zone shift', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });
});

describe('DeadlinesApi', () => {
  let http: HttpTestingController;
  let api: DeadlinesApi;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    api = TestBed.inject(DeadlinesApi);
  });

  afterEach(() => http.verify());

  it('sends status, within and paging always; the other filters only when set', () => {
    expect(deadlineListParams(DEFAULT_DEADLINE_QUERY)).toEqual({ status: 'open', within: '90', page: '1', pageSize: '50' });
    const query: DeadlineQuery = { ...DEFAULT_DEADLINE_QUERY, q: ' Benali ', kind: 'contract_end', unitId: 'u-1', includeSubUnits: false, within: 30, status: 'all' };
    expect(deadlineListParams(query)).toEqual({ q: 'Benali', kind: 'contract_end', status: 'all', unitId: 'u-1', includeSubUnits: 'false', within: '30', page: '1', pageSize: '50' });
  });

  it('reads the board and the summary as resources', () => {
    const injector = TestBed.inject(Injector);
    const enabled = signal(false);
    runInInjectionContext(injector, () => {
      api.listResource(() => DEFAULT_DEADLINE_QUERY);
      api.summaryResource(() => enabled());
    });
    TestBed.tick();
    http.expectOne((r) => r.url === '/api/deadlines' && r.params.get('status') === 'open').flush({ items: [], total: 0, page: 1, pageSize: 50 });
    http.expectNone('/api/deadlines/summary');
    enabled.set(true);
    TestBed.tick();
    http.expectOne('/api/deadlines/summary').flush({ overdue: 0, critical: 0, next30: 0, byKind: {} });
  });

  it('acks, undoes, saves the policy, opens a decision and records a proposal', () => {
    api.ack({ kind: 'contract_end', subjectId: 'c-1', dueDate: '2026-10-16', note: 'vu' }).subscribe();
    const ack = http.expectOne('/api/deadlines/acks');
    expect(ack.request.method).toBe('POST');
    expect(ack.request.body).toEqual({ kind: 'contract_end', subjectId: 'c-1', dueDate: '2026-10-16', note: 'vu' });
    ack.flush(HANDLED_ITEM);

    api.unack('ack 1').subscribe();
    const undo = http.expectOne('/api/deadlines/acks/ack%201');
    expect(undo.request.method).toBe('DELETE');
    undo.flush(null);

    api.updatePolicy(POLICY).subscribe();
    const put = http.expectOne('/api/deadlines/settings');
    expect(put.request.method).toBe('PUT');
    put.flush(POLICY);

    api.openDecision('emp-27', 'c-1').subscribe();
    const open = http.expectOne('/api/employees/emp-27/contracts/c-1/decision');
    expect(open.request.method).toBe('POST');
    open.flush({});

    api.propose('dec-1', { proposal: 'renew', proposedEndDate: '2027-11-30' }).subscribe();
    const propose = http.expectOne('/api/contract-decisions/dec-1/proposal');
    expect(propose.request.method).toBe('PUT');
    expect(propose.request.body).toEqual({ proposal: 'renew', proposedEndDate: '2027-11-30' });
    propose.flush({});
  });
});
