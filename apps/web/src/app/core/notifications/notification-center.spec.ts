import { DOCUMENT } from '@angular/common';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ME_FIXTURE } from '../../../testing/auth-fixtures';
import { type FakeEventSources, fakeEventSources, notification } from '../../../testing/fake-event-source';
import { authRefreshInterceptor } from '../auth/auth-refresh.interceptor';
import { Session } from '../auth/session';
import { apiProblemInterceptor } from '../http/api-problem.interceptor';
import { EVENT_SOURCE_FACTORY } from './event-source';
import { MAX_STREAM_FAILURES, NotificationCenter, backoffDelay, safeAppLink } from './notification-center';
import { NotificationEvents } from './notification-events';
import { NotificationsApi, notificationListParams, toPreferences } from './notifications-api';
import type { NotificationEvent } from './notifications.models';

const isList = (r: { url: string }) => r.url === '/api/me/notifications';
const isCount = (r: { url: string }) => r.url === '/api/me/notifications/unread-count';

describe('NotificationsApi', () => {
  let http: HttpTestingController;
  let api: NotificationsApi;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    api = TestBed.inject(NotificationsApi);
  });

  afterEach(() => http.verify());

  it('list params: limit always; unreadOnly and before only when they apply', () => {
    expect(notificationListParams({ unreadOnly: false, cursor: null, limit: 10 })).toEqual({ limit: '10' });
    expect(notificationListParams({ unreadOnly: true, cursor: 'c-2', limit: 20 })).toEqual({ limit: '20', unreadOnly: 'true', before: 'c-2' });
    void firstValueFrom(api.list({ unreadOnly: true, cursor: 'c-2', limit: 20 }));
    http.expectOne('/api/me/notifications?limit=20&unreadOnly=true&before=c-2').flush({ items: [], nextCursor: null });
  });

  it('count, mark read (encoded id), mark all, preferences GET/PUT hit the contract URLs', () => {
    void firstValueFrom(api.unreadCount());
    http.expectOne('/api/me/notifications/unread-count').flush({ count: 2 });
    void firstValueFrom(api.markRead('n/1'));
    const read = http.expectOne('/api/me/notifications/n%2F1/read');
    expect(read.request.method).toBe('POST');
    read.flush(null, { status: 204, statusText: 'No Content' });
    void firstValueFrom(api.markAllRead());
    expect(http.expectOne('/api/me/notifications/read-all').request.method).toBe('POST');
    void firstValueFrom(api.savePreferences([{ type: 'task.assigned', email: false }]));
    const put = http.expectOne('/api/me/notification-preferences');
    expect(put.request.method).toBe('PUT');
    expect(put.request.body).toEqual([{ type: 'task.assigned', email: false }]);
  });

  it('listResource: idle without a query, re-fetches with the cursor', () => {
    const query = signal<{ unreadOnly: boolean; cursor: string | null; limit: number } | undefined>(undefined);
    TestBed.runInInjectionContext(() => api.listResource(query));
    TestBed.tick();
    http.expectNone(isList);
    query.set({ unreadOnly: false, cursor: null, limit: 20 });
    TestBed.tick();
    http.expectOne('/api/me/notifications?limit=20').flush({ items: [], nextCursor: 'c-2' });
    query.set({ unreadOnly: false, cursor: 'c-2', limit: 20 });
    TestBed.tick();
    http.expectOne('/api/me/notifications?limit=20&before=c-2').flush({ items: [], nextCursor: null });
  });

  it('preferences body: a bare array (contract) or {items}', () => {
    const list = [{ type: 'task.assigned', email: true, default: true }];
    expect(toPreferences(list)).toEqual(list);
    expect(toPreferences({ items: list })).toEqual(list);
    expect(toPreferences(null)).toEqual([]);
  });
});

describe('safeAppLink / backoffDelay', () => {
  it('keeps app paths, rejects other origins', () => {
    expect(safeAppLink('/tasks?task=k-1')).toBe('/tasks?task=k-1');
    expect(safeAppLink('//evil.example/x')).toBe('/notifications');
    expect(safeAppLink('/\\evil.example')).toBe('/notifications');
    expect(safeAppLink('https://evil.example')).toBe('/notifications');
    expect(safeAppLink('javascript:alert(1)')).toBe('/notifications');
  });

  it('grows 1s, 2s, 5s, 15s, 30s and stays capped', () => {
    expect([1, 2, 3, 4, 5, 6, 9].map(backoffDelay)).toEqual([1000, 2000, 5000, 15000, 30000, 30000, 30000]);
  });
});

describe('NotificationCenter', () => {
  let http: HttpTestingController;
  let fake: FakeEventSources;
  let center: NotificationCenter;

  beforeEach(() => {
    fake = fakeEventSources();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(withInterceptors([apiProblemInterceptor, authRefreshInterceptor])),
        provideHttpClientTesting(),
        { provide: EVENT_SOURCE_FACTORY, useValue: fake.factory },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    center = TestBed.inject(NotificationCenter);
  });

  afterEach(() => {
    vi.useRealTimers();
    http.verify();
  });

  /** Signs in and answers the initial list + count. */
  function signIn(count = 2, items = [notification('n-1'), notification('n-2', { readAt: '2026-09-26T10:00:00Z' })]): void {
    TestBed.inject(Session).set(ME_FIXTURE);
    TestBed.tick();
    http.expectOne(isList).flush({ items, nextCursor: null });
    http.expectOne(isCount).flush({ count });
  }

  it('connects only while signed in', () => {
    TestBed.tick();
    expect(fake.sources).toHaveLength(0);
    expect(center.status()).toBe('off');
    http.expectNone(isCount);

    signIn();
    expect(fake.sources).toHaveLength(1);
    expect(fake.last().url).toBe('/api/me/notifications/stream');
    expect(center.status()).toBe('connecting');
    expect(center.unreadCount()).toBe(2);
    expect(center.latest().map((n) => n.id)).toEqual(['n-1', 'n-2']);
    fake.last().open();
    expect(center.status()).toBe('live');
  });

  it('closes the stream and forgets the data on sign-out', () => {
    signIn();
    const source = fake.last();
    TestBed.inject(Session).clear();
    TestBed.tick();
    expect(source.closed).toBe(true);
    expect(center.status()).toBe('off');
    expect(center.unreadCount()).toBe(0);
    expect(center.latest()).toEqual([]);
    // A late event from the closed source changes nothing.
    source.send('unread', { count: 9 });
    expect(center.unreadCount()).toBe(0);
  });

  it('updates the count on `unread`, prepends a `notification` and publishes it on the bus', () => {
    signIn();
    fake.last().open();
    const received: NotificationEvent[] = [];
    TestBed.inject(NotificationEvents).events$.subscribe((e) => received.push(e));

    fake.last().send('unread', { count: 5 });
    expect(center.unreadCount()).toBe(5);

    fake.last().send('notification', notification('n-3', { type: 'leave.approved' }));
    expect(center.latest()[0]?.id).toBe('n-3');
    expect(center.unreadCount()).toBe(6);
    expect(received.map((e) => e.type)).toEqual(['leave.approved']);

    // A partial payload ({id, type}) is re-read over HTTP, and still published.
    fake.last().send('notification', { id: 'n-4', type: 'task.assigned' });
    http.expectOne(isList).flush({ items: [notification('n-4'), notification('n-3')], nextCursor: null });
    http.expectOne(isCount).flush({ count: 7 });
    expect(center.latest().map((n) => n.id)).toEqual(['n-4', 'n-3']);
    expect(received.map((e) => e.type)).toEqual(['leave.approved', 'task.assigned']);
  });

  it('on error: closes, backs off, renews the session with an ordinary request, then reconnects', () => {
    vi.useFakeTimers();
    signIn();
    const first = fake.last();
    first.open();
    first.fail();
    expect(first.closed).toBe(true);
    expect(center.status()).toBe('retrying');

    vi.advanceTimersByTime(999);
    http.expectNone(isCount);
    vi.advanceTimersByTime(1);
    // The access cookie expired: 401 → the refresh interceptor renews it → the count is retried → then reconnect.
    http.expectOne(isCount).flush({ type: 'about:blank', title: 'Unauthorized', status: 401 }, { status: 401, statusText: 'Unauthorized' });
    http.expectOne('/api/auth/refresh').flush({});
    expect(fake.sources).toHaveLength(1); // not before the session is renewed
    http.expectOne(isCount).flush({ count: 4 });
    expect(fake.sources).toHaveLength(2);
    expect(center.unreadCount()).toBe(4);
    fake.last().open();
    expect(center.status()).toBe('live');

    // `open` reset the ladder: the next failure waits 1 s again.
    fake.last().fail();
    vi.advanceTimersByTime(1000);
    http.expectOne(isCount).flush({ count: 4 });
    expect(fake.sources).toHaveLength(3);
  });

  it(`falls back to refresh-on-visibility after ${MAX_STREAM_FAILURES} failures in a row`, () => {
    vi.useFakeTimers();
    signIn();
    for (let attempt = 1; attempt < MAX_STREAM_FAILURES; attempt++) {
      fake.last().fail();
      vi.advanceTimersByTime(backoffDelay(attempt));
      http.expectOne(isCount).flush({ count: 2 });
    }
    expect(fake.sources).toHaveLength(MAX_STREAM_FAILURES);
    fake.last().fail();
    expect(center.status()).toBe('fallback');
    vi.advanceTimersByTime(60_000);
    http.expectNone(isCount);
    expect(fake.sources).toHaveLength(MAX_STREAM_FAILURES);

    const doc = TestBed.inject(DOCUMENT);
    const state = vi.spyOn(doc, 'visibilityState', 'get').mockReturnValue('visible');
    doc.dispatchEvent(new Event('visibilitychange'));
    http.expectOne(isList).flush({ items: [notification('n-9')], nextCursor: null });
    http.expectOne(isCount).flush({ count: 1 });
    expect(center.unreadCount()).toBe(1);
    // One fresh attempt; failing again goes straight back to fallback, no ladder.
    expect(fake.sources).toHaveLength(MAX_STREAM_FAILURES + 1);
    fake.last().fail();
    expect(center.status()).toBe('fallback');
    state.mockRestore();
  });

  it('starts in fallback mode when the browser has no EventSource', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), { provide: EVENT_SOURCE_FACTORY, useValue: () => null }],
    });
    const plain = TestBed.inject(NotificationCenter);
    TestBed.inject(Session).set(ME_FIXTURE);
    TestBed.tick();
    const ctrl = TestBed.inject(HttpTestingController);
    ctrl.expectOne(isList).flush({ items: [], nextCursor: null });
    ctrl.expectOne(isCount).flush({ count: 0 });
    expect(plain.status()).toBe('fallback');
    ctrl.verify();
    http = ctrl;
  });

  it('markRead / markAllRead are optimistic and re-read the truth on failure', () => {
    signIn(2, [notification('n-1'), notification('n-2')]);
    const [first] = center.latest();
    if (!first) throw new Error('no notification');
    center.markRead(first);
    expect(center.latest()[0]?.readAt).not.toBeNull();
    expect(center.unreadCount()).toBe(1);
    const read: TestRequest = http.expectOne('/api/me/notifications/n-1/read');
    read.flush({ type: 'about:blank', title: 'Server error', status: 500 }, { status: 500, statusText: 'Server Error' });
    http.expectOne(isList).flush({ items: [notification('n-1'), notification('n-2')], nextCursor: null });
    http.expectOne(isCount).flush({ count: 2 });
    expect(center.unreadCount()).toBe(2);

    center.markAllRead();
    expect(center.unreadCount()).toBe(0);
    expect(center.latest().every((n) => n.readAt)).toBe(true);
    http.expectOne('/api/me/notifications/read-all').flush(null, { status: 204, statusText: 'No Content' });
  });
});
