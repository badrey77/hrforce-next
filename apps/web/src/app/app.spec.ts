import { DOCUMENT } from '@angular/common';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { App } from './app';
import { Session } from './core/auth/session';
import { MyEmployment } from './core/leave/my-employment';
import { NotificationCenter } from './core/notifications/notification-center';
import { TasksBadge } from './core/tasks/tasks-badge';
import type { OpenTask } from './core/tasks/tasks.models';
import { LanguageService } from './core/i18n/language.service';
import { ME_FIXTURE, ME_LECTURE, meWith } from '../testing/auth-fixtures';
import { translocoTesting } from '../testing/transloco-testing';

const links = (el: HTMLElement) => [...el.querySelectorAll('nav a')].map((a) => a.getAttribute('href'));

/** What the root stores ask for once signed in: open tasks, leave types, the linked employment, notifications. */
interface Answers {
  tasks?: readonly OpenTask[];
  /** `null` = 404 (not linked). */
  employment?: object | null;
  /** Unread notifications (`GET /api/me/notifications/unread-count`). */
  unread?: number;
}
let answers: Answers = {};

/**
 * Answers every request the shell's root services sent (TasksBadge, LeaveCatalog, MyEmployment). A pending
 * `httpResource` request keeps the app "unstable", so `whenStable()` would wait for it forever.
 */
async function settle(fixture: ComponentFixture<App>): Promise<void> {
  const http = TestBed.inject(HttpTestingController);
  for (let round = 0; round < 3; round++) {
    TestBed.tick();
    for (const req of http.match(() => true)) {
      if (req.cancelled) continue;
      if (req.request.url === '/api/tasks') req.flush({ items: answers.tasks ?? [] });
      else if (req.request.url === '/api/leave/types') req.flush({ items: [] });
      else if (req.request.url === '/api/me/notifications') req.flush({ items: [], nextCursor: null });
      else if (req.request.url === '/api/me/notifications/unread-count') req.flush({ count: answers.unread ?? 0 });
      else if (req.request.url === '/api/me/employment') {
        if (answers.employment) req.flush(answers.employment);
        else req.flush({ type: 'about:blank', title: 'Not found', status: 404 }, { status: 404, statusText: 'Not Found' });
      }
    }
    await new Promise((resolve) => setTimeout(resolve));
  }
  await fixture.whenStable();
}

async function render() {
  const fixture = TestBed.createComponent(App);
  await settle(fixture);
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

function task(id: string): OpenTask {
  return {
    id,
    stepKey: 'manager',
    stepIndex: 0,
    stepLabels: { fr: 'Responsable', ar: 'المسؤول', en: 'Manager' },
    createdAt: '2026-09-20T08:00:00Z',
    subject: {
      type: 'leave_request',
      id: `r-${id}`,
      employee: { id: 'e-1', matricule: 'EMP-1', person: { lastName: 'A', firstName: 'B', lastNameAr: null, firstNameAr: null } },
      leaveTypeId: 't-annual',
      startDate: '2026-10-01',
      endDate: '2026-10-02',
      days: 2,
    },
  };
}

describe('App shell', () => {
  beforeEach(async () => {
    localStorage.clear();
    answers = {};
    await TestBed.configureTestingModule({
      imports: [App, translocoTesting()],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
  });

  it('hides the nav and the user menu when signed out', async () => {
    const { el } = await render();

    expect(el.querySelector('.brand')?.textContent).toContain('HRForce');
    expect(el.querySelector('nav')).toBeNull();
    expect(el.querySelector('app-user-menu button')).toBeNull();
    expect(el.querySelector('app-language-switcher select')).not.toBeNull();
  });

  it('shows the notification bell only when signed in, with the unread count', async () => {
    answers = { unread: 3 };
    const session = TestBed.inject(Session);
    const { fixture, el } = await render();
    expect(el.querySelector('app-notification-bell')).toBeNull();

    session.set(ME_FIXTURE);
    await settle(fixture);
    const bell = el.querySelector('app-notification-bell [data-action="bell"]');
    expect(bell?.getAttribute('aria-label')).toBe('Notifications, 3 non lue(s)');
    // jsdom has no EventSource: the center runs in its visibility-refresh fallback.
    expect(TestBed.inject(NotificationCenter).status()).toBe('fallback');

    session.clear();
    await settle(fixture);
    expect(el.querySelector('app-notification-bell')).toBeNull();
  });

  it('shows the nav, display name, company and "Sign out" when signed in', async () => {
    TestBed.inject(Session).set(ME_FIXTURE);
    const { el } = await render();

    expect(el.querySelector('nav')?.getAttribute('aria-label')).toBe('Navigation principale');
    expect([...el.querySelectorAll('nav a')].map((a) => a.textContent?.trim())).toContain('Employés');
    expect(el.querySelector('app-user-menu .name')?.textContent?.trim()).toBe('Amina Benali');
    expect(el.querySelector('app-user-menu .company')?.textContent?.trim()).toBe('Groupe Démo');
    expect(el.querySelector('app-user-menu button')?.textContent?.trim()).toBe('Se déconnecter');
  });

  it('signs out: POST logout, session cleared, nav hidden, /login', async () => {
    const session = TestBed.inject(Session);
    session.set(ME_FIXTURE);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const { fixture, el } = await render();

    el.querySelector<HTMLButtonElement>('app-user-menu button')?.click();
    const req = TestBed.inject(HttpTestingController).expectOne('/api/auth/logout');
    expect(req.request.method).toBe('POST');
    req.flush(null, { status: 204, statusText: 'No Content' });
    await settle(fixture);

    expect(session.isAuthenticated()).toBe(false);
    expect(el.querySelector('nav')).toBeNull();
    expect(navigate).toHaveBeenCalledWith('/login');
  });

  it('re-renders in Arabic and flips the document to RTL', async () => {
    TestBed.inject(Session).set(ME_FIXTURE);
    const { fixture, el } = await render();

    TestBed.inject(LanguageService).use('ar');
    await settle(fixture);

    expect([...el.querySelectorAll('nav a')].map((a) => a.textContent?.trim())).toContain('الموظفون');
    expect(el.querySelector('app-user-menu button')?.textContent?.trim()).toBe('تسجيل الخروج');
    expect(TestBed.inject(DOCUMENT).documentElement.dir).toBe('rtl');
  });

  describe('permission-aware nav', () => {

    it('shows Organization (org_unit.read) and Access (access.read) to an admin', async () => {
      TestBed.inject(Session).set(ME_FIXTURE);
      const { el } = await render();

      expect(links(el)).toEqual(['/', '/tasks', '/employees', '/organization', '/access', '/settings']);
      expect(el.querySelector('nav a[href="/access"]')?.textContent?.trim()).toBe('Accès');
    });

    it('hides Access from a read-only user, and Employees/Organization from a user without their read permission', async () => {
      const session = TestBed.inject(Session);
      session.set(ME_LECTURE);
      const { fixture, el } = await render();
      expect(links(el)).toEqual(['/', '/tasks', '/employees', '/organization', '/settings']);

      session.set(meWith([]));
      await settle(fixture);
      expect(links(el)).toEqual(['/', '/tasks', '/settings']);
    });

    it('re-renders when permissions change (e.g. after a reload of /api/me)', async () => {
      const session = TestBed.inject(Session);
      session.set(meWith(['org_unit.read']));
      const { fixture, el } = await render();
      expect(links(el)).not.toContain('/access');

      session.set(meWith(['org_unit.read', 'access.read']));
      await settle(fixture);
      expect(links(el)).toContain('/access');
    });

    it('shows HR Leave with leave.read', async () => {
      TestBed.inject(Session).set(meWith(['leave.read']));
      const { el } = await render();
      expect(links(el)).toEqual(['/', '/tasks', '/leave', '/settings']);
      expect(el.querySelector('nav a[href="/leave"]')?.textContent?.trim()).toBe('Congés');
    });

    it('shows My leave only with leave.request_self AND a linked employment', async () => {
      const http = TestBed.inject(HttpTestingController);
      // Permission, but GET /me/employment answers 404: no link.
      TestBed.inject(Session).set(meWith(['leave.request_self']));
      const first = await render();
      expect(links(first.el)).not.toContain('/me/leave');

      // Linked: the link appears once /me/employment answers 200.
      answers = { employment: { id: 'e-1', matricule: 'EMP-1' } };
      TestBed.inject(Session).set(meWith(['leave.request_self', 'employee.read']));
      TestBed.inject(MyEmployment).reload();
      await settle(first.fixture);
      expect(links(first.el)).toEqual(['/', '/me/leave', '/tasks', '/employees', '/settings']);

      // Linked but without the permission: nothing is even asked.
      TestBed.inject(Session).set(meWith([]));
      await settle(first.fixture);
      http.expectNone('/api/me/employment');
      expect(links(first.el)).not.toContain('/me/leave');
    });
  });

  describe('My tasks badge', () => {
    it('shows the open count with an accessible name, and announces changes politely', async () => {
      answers = { tasks: [task('t1'), task('t2'), task('t3')] };
      TestBed.inject(Session).set(meWith([]));
      const { fixture, el } = await render();

      const link = el.querySelector('nav a[href="/tasks"]');
      expect(link?.querySelector('[data-badge="tasks"]')?.textContent?.trim()).toBe('3');
      expect(link?.querySelector('[data-badge="tasks"]')?.getAttribute('aria-hidden')).toBe('true');
      expect(link?.getAttribute('aria-label')).toBe('Mes tâches, 3 en attente');
      const live = el.querySelector('[data-live="tasks"]');
      expect(live?.getAttribute('aria-live')).toBe('polite');
      expect(live?.textContent?.trim()).toBe('3 tâche(s) en attente');

      // An optimistic removal updates the badge at once.
      TestBed.inject(TasksBadge).hide('t1');
      await settle(fixture);
      expect(link?.querySelector('[data-badge="tasks"]')?.textContent?.trim()).toBe('2');
      expect(live?.textContent?.trim()).toBe('2 tâche(s) en attente');
    });

    it('shows no badge at zero, and refreshes after a navigation', async () => {
      TestBed.inject(Session).set(meWith([]));
      const { fixture, el } = await render();
      expect(el.querySelector('[data-badge="tasks"]')).toBeNull();
      expect(el.querySelector('nav a[href="/tasks"]')?.getAttribute('aria-label')).toBeNull();

      answers = { tasks: [task('t9')] };
      await TestBed.inject(Router).navigateByUrl('/');
      await settle(fixture);
      expect(el.querySelector('[data-badge="tasks"]')?.textContent?.trim()).toBe('1');
    });
  });
});
