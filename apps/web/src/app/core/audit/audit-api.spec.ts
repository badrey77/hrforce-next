import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { PAGE_1 } from '../../../testing/audit-fixtures';
import { AuditApi, type TimelineRequest } from './audit-api';

describe('AuditApi', () => {
  let http: HttpTestingController;
  let api: AuditApi;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    api = TestBed.inject(AuditApi);
  });

  afterEach(() => http.verify());

  it('first page: subject + limit, no `before`', () => {
    api.timeline('org_unit:u-1').subscribe();
    const req = http.expectOne((r) => r.url === '/api/audit/timeline');
    expect(req.request.method).toBe('GET');
    expect(req.request.params.get('subject')).toBe('org_unit:u-1');
    expect(req.request.params.get('limit')).toBe('50');
    expect(req.request.params.has('before')).toBe(false);
    req.flush(PAGE_1);
  });

  it('next page: the cursor goes back as `before`', () => {
    api.timeline('user:u-samir', 'cur-2').subscribe();
    http.expectOne('/api/audit/timeline?subject=user:u-samir&limit=50&before=cur-2').flush(PAGE_1);
  });

  it('timelineResource: idle while the request is undefined, re-fetches when the cursor changes', () => {
    const request = signal<TimelineRequest | undefined>(undefined);
    const page = TestBed.runInInjectionContext(() => api.timelineResource(request));
    TestBed.tick();
    http.expectNone((r) => r.url === '/api/audit/timeline');
    expect(page.status()).toBe('idle');

    request.set({ subject: 'role:r-1', cursor: null });
    TestBed.tick();
    http.expectOne('/api/audit/timeline?subject=role:r-1&limit=50').flush(PAGE_1);

    request.set({ subject: 'role:r-1', cursor: 'cur-2' });
    TestBed.tick();
    http.expectOne('/api/audit/timeline?subject=role:r-1&limit=50&before=cur-2').flush({ items: [], nextCursor: null });
  });
});
