import { DOCUMENT } from '@angular/common';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ME_FIXTURE } from '../../../testing/auth-fixtures';
import { openTask } from '../../../testing/leave-fixtures';
import { Session } from '../auth/session';
import { apiProblemInterceptor } from '../http/api-problem.interceptor';
import { TasksApi } from './tasks-api';
import { TasksBadge } from './tasks-badge';

const isTasks = (r: { url: string }) => r.url === '/api/tasks';

describe('TasksApi', () => {
  it('approve / reject POST to the contract URLs with the comment', () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting()],
    });
    const api = TestBed.inject(TasksApi);
    const http = TestBed.inject(HttpTestingController);
    void firstValueFrom(api.approve('k-1'));
    const approve = http.expectOne('/api/tasks/k-1/approve');
    expect(approve.request.method).toBe('POST');
    expect(approve.request.body).toEqual({});
    void firstValueFrom(api.reject('k-2', { comment: 'Période chargée' }));
    expect(http.expectOne('/api/tasks/k-2/reject').request.body).toEqual({ comment: 'Période chargée' });
    http.verify();
  });
});

describe('TasksBadge', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function signedIn(items = [openTask('k-1'), openTask('k-2')]): Promise<TasksBadge> {
    TestBed.inject(Session).set(ME_FIXTURE);
    const badge = TestBed.inject(TasksBadge);
    TestBed.tick();
    const req = http.expectOne(isTasks);
    expect(req.request.params.get('status')).toBe('open');
    req.flush({ items });
    await TestBed.inject(ApplicationRef).whenStable();
    return badge;
  }

  it('sends nothing while signed out', () => {
    const badge = TestBed.inject(TasksBadge);
    TestBed.tick();
    http.expectNone(isTasks);
    expect(badge.count()).toBe(0);
    badge.refresh();
    TestBed.tick();
    http.expectNone(isTasks);
  });

  it('counts open tasks; hide() removes one at once and show() rolls it back in place', async () => {
    const badge = await signedIn([openTask('k-1'), openTask('k-2'), openTask('k-3')]);
    expect(badge.count()).toBe(3);
    badge.hide('k-2');
    expect(badge.count()).toBe(2);
    expect(badge.items().map((t) => t.id)).toEqual(['k-1', 'k-3']);
    badge.show('k-2');
    expect(badge.items().map((t) => t.id)).toEqual(['k-1', 'k-2', 'k-3']);
  });

  it('refreshes after a navigation and when the tab becomes visible again', async () => {
    const badge = await signedIn();

    await TestBed.inject(Router).navigateByUrl('/');
    TestBed.tick();
    http.expectOne(isTasks).flush({ items: [openTask('k-1')] });
    await TestBed.inject(ApplicationRef).whenStable();
    expect(badge.count()).toBe(1);

    const doc = TestBed.inject(DOCUMENT);
    const state = vi.spyOn(doc, 'visibilityState', 'get');
    state.mockReturnValue('hidden');
    doc.dispatchEvent(new Event('visibilitychange'));
    TestBed.tick();
    http.expectNone(isTasks);

    state.mockReturnValue('visible');
    doc.dispatchEvent(new Event('visibilitychange'));
    TestBed.tick();
    http.expectOne(isTasks).flush({ items: [] });
    await TestBed.inject(ApplicationRef).whenStable();
    expect(badge.count()).toBe(0);
    state.mockRestore();
  });
});
