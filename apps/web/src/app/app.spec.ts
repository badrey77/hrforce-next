import { DOCUMENT } from '@angular/common';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { App } from './app';
import { Session } from './core/auth/session';
import { LanguageService } from './core/i18n/language.service';
import { ME_FIXTURE, ME_LECTURE, meWith } from '../testing/auth-fixtures';
import { translocoTesting } from '../testing/transloco-testing';

const links = (el: HTMLElement) => [...el.querySelectorAll('nav a')].map((a) => a.getAttribute('href'));

async function render() {
  const fixture = TestBed.createComponent(App);
  await fixture.whenStable();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

describe('App shell', () => {
  beforeEach(async () => {
    localStorage.clear();
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
    await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();

    expect(session.isAuthenticated()).toBe(false);
    expect(el.querySelector('nav')).toBeNull();
    expect(navigate).toHaveBeenCalledWith('/login');
  });

  it('re-renders in Arabic and flips the document to RTL', async () => {
    TestBed.inject(Session).set(ME_FIXTURE);
    const { fixture, el } = await render();

    TestBed.inject(LanguageService).use('ar');
    await fixture.whenStable();

    expect([...el.querySelectorAll('nav a')].map((a) => a.textContent?.trim())).toContain('الموظفون');
    expect(el.querySelector('app-user-menu button')?.textContent?.trim()).toBe('تسجيل الخروج');
    expect(TestBed.inject(DOCUMENT).documentElement.dir).toBe('rtl');
  });

  describe('permission-aware nav', () => {

    it('shows Organization (org_unit.read) and Access (access.read) to an admin', async () => {
      TestBed.inject(Session).set(ME_FIXTURE);
      const { el } = await render();

      expect(links(el)).toEqual(['/', '/employees', '/organization', '/access', '/settings']);
      expect(el.querySelector('nav a[href="/access"]')?.textContent?.trim()).toBe('Accès');
    });

    it('hides Access from a read-only user, and both from a user without org_unit.read', async () => {
      const session = TestBed.inject(Session);
      session.set(ME_LECTURE);
      const { fixture, el } = await render();
      expect(links(el)).toEqual(['/', '/employees', '/organization', '/settings']);

      session.set(meWith([]));
      await fixture.whenStable();
      expect(links(el)).toEqual(['/', '/employees', '/settings']);
    });

    it('re-renders when permissions change (e.g. after a reload of /api/me)', async () => {
      const session = TestBed.inject(Session);
      session.set(meWith(['org_unit.read']));
      const { fixture, el } = await render();
      expect(links(el)).not.toContain('/access');

      session.set(meWith(['org_unit.read', 'access.read']));
      await fixture.whenStable();
      expect(links(el)).toContain('/access');
    });
  });
});
