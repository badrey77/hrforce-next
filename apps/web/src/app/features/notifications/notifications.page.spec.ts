import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { ME_FIXTURE } from '../../../testing/auth-fixtures';
import { fakeEventSources, notification } from '../../../testing/fake-event-source';
import { translocoTesting } from '../../../testing/transloco-testing';
import { Session } from '../../core/auth/session';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import { EVENT_SOURCE_FACTORY } from '../../core/notifications/event-source';
import { NotificationCenter } from '../../core/notifications/notification-center';
import { NotificationsPage } from './notifications.page';

@Component({ template: '' })
class Blank {}

describe('NotificationsPage', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [
        provideRouter([
          { path: 'notifications', component: NotificationsPage },
          { path: 'tasks', component: Blank },
        ]),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
        { provide: EVENT_SOURCE_FACTORY, useValue: fakeEventSources().factory },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(Session).set(ME_FIXTURE);
    // The root center (the bell's store) is started as in the app: it asks for the latest 10 and the count.
    TestBed.inject(NotificationCenter);
    TestBed.tick();
    http.expectOne('/api/me/notifications?limit=10').flush({ items: [], nextCursor: null });
    http.expectOne('/api/me/notifications/unread-count').flush({ count: 2 });
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => http.verify());

  async function settle(): Promise<void> {
    for (let round = 0; round < 2; round++) {
      TestBed.tick();
      for (const req of http.match('/api/leave/types')) req.flush({ items: [] });
      await new Promise((resolve) => setTimeout(resolve));
    }
    TestBed.tick();
  }

  const el = () => harness.routeNativeElement as HTMLElement;
  const ids = () => [...el().querySelectorAll('[data-notification]')].map((li) => li.getAttribute('data-notification'));

  async function open(): Promise<void> {
    await harness.navigateByUrl('/notifications');
    await settle();
    http.expectOne('/api/me/notifications?limit=20').flush({
      items: [notification('n-1'), notification('n-2', { readAt: '2026-09-26T10:00:00Z' })],
      nextCursor: 'c-2',
    });
    await settle();
  }

  it('lists the newest page, then appends the next one with the cursor ("load more")', async () => {
    await open();
    expect(ids()).toEqual(['n-1', 'n-2']);
    expect(el().querySelector('[data-notification="n-1"]')?.classList.contains('unread')).toBe(true);
    expect(el().querySelector('[data-notification="n-2"]')?.classList.contains('unread')).toBe(false);

    (el().querySelector('[data-action="load-more"]') as HTMLButtonElement).click();
    await settle();
    http.expectOne('/api/me/notifications?limit=20&before=c-2').flush({ items: [notification('n-3')], nextCursor: null });
    await settle();
    expect(ids()).toEqual(['n-1', 'n-2', 'n-3']);
    expect(el().querySelector('[data-action="load-more"]')).toBeNull();
  });

  it('"unread only" restarts from the newest page with unreadOnly=true', async () => {
    await open();
    const box = el().querySelector('[data-filter="unread"]') as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    await settle();
    http.expectOne('/api/me/notifications?limit=20&unreadOnly=true').flush({ items: [], nextCursor: null });
    await settle();
    expect(ids()).toEqual([]);
    expect(el().querySelector('[data-state="empty"]')?.textContent).toContain('Aucune notification non lue');
  });

  it('"mark as read" posts, restyles the row and lowers the shared count; "mark all" posts read-all', async () => {
    await open();
    const center = TestBed.inject(NotificationCenter);
    (el().querySelector('[data-notification="n-1"] [data-action="mark-read"]') as HTMLButtonElement).click();
    await settle();
    http.expectOne('/api/me/notifications/n-1/read').flush(null, { status: 204, statusText: 'No Content' });
    expect(el().querySelector('[data-notification="n-1"]')?.classList.contains('unread')).toBe(false);
    expect(center.unreadCount()).toBe(1);

    (el().querySelector('[data-action="mark-all"]') as HTMLButtonElement).click();
    await settle();
    http.expectOne('/api/me/notifications/read-all').flush(null, { status: 204, statusText: 'No Content' });
    expect(center.unreadCount()).toBe(0);
  });

  it('clicking a notification marks it read and opens its link', async () => {
    await open();
    (el().querySelector('[data-notification="n-1"] a') as HTMLAnchorElement).click();
    await settle();
    http.expectOne('/api/me/notifications/n-1/read').flush(null, { status: 204, statusText: 'No Content' });
    expect(TestBed.inject(Router).url).toBe('/tasks?task=k-n-1');
  });

  it('shows an error with a retry when the first page fails', async () => {
    await harness.navigateByUrl('/notifications');
    await settle();
    http.expectOne('/api/me/notifications?limit=20').flush({ type: 'about:blank', title: 'Error', status: 500 }, { status: 500, statusText: 'Error' });
    await settle();
    expect(el().querySelector('[role="alert"]')?.textContent).toContain('Impossible de charger les notifications');
    (el().querySelector('[role="alert"] button') as HTMLButtonElement).click();
    await settle();
    http.expectOne('/api/me/notifications?limit=20').flush({ items: [], nextCursor: null });
  });
});
