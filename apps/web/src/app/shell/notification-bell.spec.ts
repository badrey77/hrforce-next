import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { ME_FIXTURE } from '../../testing/auth-fixtures';
import { type FakeEventSources, fakeEventSources, notification } from '../../testing/fake-event-source';
import { LEAVE_TYPES } from '../../testing/leave-fixtures';
import { translocoTesting } from '../../testing/transloco-testing';
import { Session } from '../core/auth/session';
import { apiProblemInterceptor } from '../core/http/api-problem.interceptor';
import { EVENT_SOURCE_FACTORY } from '../core/notifications/event-source';
import { NotificationBell } from './notification-bell';

@Component({ template: '' })
class Blank {}

const isList = (r: { url: string }) => r.url === '/api/me/notifications';
const isCount = (r: { url: string }) => r.url === '/api/me/notifications/unread-count';

describe('NotificationBell', () => {
  let http: HttpTestingController;
  let fake: FakeEventSources;
  let fixture: ComponentFixture<NotificationBell>;

  beforeEach(async () => {
    fake = fakeEventSources();
    await TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [
        provideRouter([
          { path: 'tasks', component: Blank },
          { path: 'notifications', component: Blank },
        ]),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
        { provide: EVENT_SOURCE_FACTORY, useValue: fake.factory },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(Session).set(ME_FIXTURE);
    fixture = TestBed.createComponent(NotificationBell);
    document.body.appendChild(fixture.nativeElement);
    await settle();
    http.expectOne(isList).flush({
      items: [notification('n-1'), notification('n-2', { type: 'leave.approved', readAt: '2026-09-26T10:00:00Z', link: '/me/leave?request=r-2' })],
      nextCursor: null,
    });
    http.expectOne(isCount).flush({ count: 1 });
    await settle();
  });

  afterEach(() => {
    fixture.nativeElement.remove();
    http.verify();
  });

  /**
   * Renders, lets the @defer'red panel chunk load (a dynamic import), and answers the leave catalogue the panel's
   * sentences ask for. `fixture.whenStable()` is not used: a pending resource request would keep it waiting.
   */
  async function settle(types: 'empty' | 'none' = 'empty'): Promise<void> {
    for (let round = 0; round < 3; round++) {
      TestBed.tick();
      if (types === 'empty') for (const req of http.match('/api/leave/types')) req.flush({ items: [] });
      await new Promise((resolve) => setTimeout(resolve));
    }
    TestBed.tick();
  }

  const el = () => fixture.nativeElement as HTMLElement;
  const bell = () => el().querySelector('[data-action="bell"]') as HTMLButtonElement;
  const panel = () => el().querySelector('#notifications-panel');

  /** Clicks the bell and waits (bounded) for the @defer'red panel: its chunk is a dynamic import, slower under load. */
  async function openPanel(): Promise<void> {
    bell().click();
    for (let round = 0; round < 50 && !el().querySelector('.items'); round++) await settle();
    expect(el().querySelector('.items')).not.toBeNull();
  }

  it('shows the unread count with an accessible name and a polite live region', async () => {
    expect(el().querySelector('[data-badge="notifications"]')?.textContent?.trim()).toBe('1');
    expect(el().querySelector('[data-badge="notifications"]')?.getAttribute('aria-hidden')).toBe('true');
    expect(bell().getAttribute('aria-label')).toBe('Notifications, 1 non lue(s)');
    expect(bell().getAttribute('aria-expanded')).toBe('false');
    const live = el().querySelector('[data-live="notifications"]');
    expect(live?.getAttribute('aria-live')).toBe('polite');
    expect(live?.textContent?.trim()).toBe('1 notification(s) non lue(s)');

    // Live: the server pushes a new count.
    fake.last().send('unread', { count: 4 });
    await settle();
    expect(bell().getAttribute('aria-label')).toBe('Notifications, 4 non lue(s)');
  });

  it('opens a panel with the latest items (translated, unread marked); Escape closes it and returns focus to the bell', async () => {
    await openPanel();
    expect(bell().getAttribute('aria-expanded')).toBe('true');
    expect(panel()).not.toBeNull();
    expect(document.activeElement?.id).toBe('notifications-panel-title');
    const first = el().querySelector('[data-notification="n-1"]');
    expect(first?.classList.contains('unread')).toBe(true);
    expect(first?.textContent).toContain('Demande « annual » de BENALI Amina');
    expect(first?.textContent).toContain('(non lue)');
    expect(el().querySelector('[data-notification="n-2"]')?.textContent).toContain('a été approuvée');
    expect(el().querySelector('[data-notification="n-1"]')?.getAttribute('href')).toBe('/tasks?task=k-n-1');

    (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(bell());
  });

  it('a click outside closes the panel without stealing focus', async () => {
    await openPanel();
    document.body.click();
    await settle();
    expect(panel()).toBeNull();
  });

  it('clicking an item marks it read and navigates to its link', async () => {
    await openPanel();
    (el().querySelector('[data-notification="n-1"]') as HTMLElement).click();
    await settle();
    http.expectOne('/api/me/notifications/n-1/read').flush(null, { status: 204, statusText: 'No Content' });
    await settle();
    expect(TestBed.inject(Router).url).toBe('/tasks?task=k-n-1');
    expect(panel()).toBeNull();
    expect(el().querySelector('[data-badge="notifications"]')).toBeNull();
    expect(bell().getAttribute('aria-label')).toBe('Notifications');
  });

  it('"mark all read" posts once and clears the badge; "see all" goes to /notifications', async () => {
    await openPanel();
    (el().querySelector('[data-action="mark-all"]') as HTMLButtonElement).click();
    await settle();
    http.expectOne('/api/me/notifications/read-all').flush(null, { status: 204, statusText: 'No Content' });
    expect(el().querySelector('[data-badge="notifications"]')).toBeNull();
    expect(el().querySelector('[data-notification="n-1"]')?.classList.contains('unread')).toBe(false);
    expect((el().querySelector('[data-action="mark-all"]') as HTMLButtonElement).disabled).toBe(true);

    (el().querySelector('[data-action="see-all"]') as HTMLElement).click();
    await settle();
    expect(TestBed.inject(Router).url).toBe('/notifications');
  });

  it('a live notification appears at the top of the open panel', async () => {
    await openPanel();
    fake.last().send('notification', notification('n-3', { type: 'leave.rejected', data: { leaveType: 'annual', startDate: '2026-10-05', endDate: '2026-10-09', actorName: 'Karim Haddad' } }));
    await settle();
    const items = [...el().querySelectorAll('[data-notification]')].map((a) => a.getAttribute('data-notification'));
    expect(items).toEqual(['n-3', 'n-1', 'n-2']);
    expect(el().querySelector('[data-notification="n-3"]')?.textContent).toContain('refusée par Karim Haddad');
    expect(bell().getAttribute('aria-label')).toBe('Notifications, 2 non lue(s)');
  });

  it('uses the leave catalogue for type names once it has loaded', async () => {
    bell().click();
    // `match()` takes the requests out of the queue: keep what it found and answer it.
    let types = http.match('/api/leave/types');
    for (let round = 0; round < 50 && types.length === 0; round++) {
      await settle('none');
      types = http.match('/api/leave/types');
    }
    expect(types).toHaveLength(1);
    types[0]?.flush({ items: LEAVE_TYPES });
    await settle('none');
    expect(el().querySelector('[data-notification="n-1"]')?.textContent).toContain('Demande « Congé annuel »');
  });
});
