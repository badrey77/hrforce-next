import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { ME_LECTURE, meWith } from '../testing/auth-fixtures';
import { translocoTesting } from '../testing/transloco-testing';
import { routes } from './app.routes';
import type { Me } from './core/auth/auth.models';
import { Session } from './core/auth/session';

/**
 * The REAL route table: every guarded feature URL, opened by a signed-in user who lacks its permission, shows the
 * app's 404 page (never a blank outlet) and keeps the URL. Regression: `/documents` and `/leave` used to match their
 * parent with an empty outlet (shared/not-found/not-found.route.ts).
 */
async function open(me: Me, url: string): Promise<RouterTestingHarness> {
  TestBed.configureTestingModule({
    imports: [translocoTesting()],
    providers: [provideRouter(routes, withComponentInputBinding()), provideHttpClient(), provideHttpClientTesting()],
  });
  TestBed.inject(Session).set(me);
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(url);
  return harness;
}

function heading(harness: RouterTestingHarness): string | undefined {
  return harness.routeNativeElement?.querySelector('h1')?.textContent?.trim();
}

describe('app routes: refused URLs show the 404 page', () => {
  // lecture.ouest: employee.read, org_unit.read, site.read — nothing about leave, documents or access.
  it.each([
    '/documents',
    '/documents/new',
    '/documents/settings',
    '/documents/d-1',
    '/leave',
    '/leave/settings',
    '/leave/requests/r-1',
    '/access',
    '/access/users',
    '/access/roles/new',
    '/access/security',
    '/access/apps',
    '/access/apps/new',
    '/access/apps/c-1',
    '/me/leave',
    '/me/documents',
    '/employees/new',
    '/employees/e-1/rehire',
    '/attendance',
    '/attendance/settings',
    '/attendance/corrections',
    '/attendance/corrections/c-1',
    '/attendance/reports',
    '/me/attendance',
    '/recruitment',
    '/recruitment/applications/a-1/hire',
    '/settings/branding',
    '/settings/nope',
  ])('%s without its permission', async (url) => {
    const harness = await open(ME_LECTURE, url);

    expect(TestBed.inject(Router).url).toBe(url);
    expect(heading(harness)).toBe('404');
  });

  it.each([
    // Holds a permission of the feature, but not the one of its landing page: the feature's own `**` answers.
    ['/documents', ['document.configure']],
    ['/documents', ['document.issue']],
    ['/leave', ['leave.configure']],
    ['/leave/settings', ['leave.read']],
    ['/documents/settings', ['document.read', 'document.issue']],
    ['/documents/a/b', ['document.read']],
    ['/attendance', ['attendance.configure']],
    ['/attendance/settings', ['attendance.read']],
    ['/attendance/corrections', ['attendance.configure']],
    ['/attendance/reports', ['attendance.configure']],
    ['/access/users', ['sso.read']],
    ['/access/roles', ['sso.read']],
    ['/access/apps', ['access.read']],
    ['/access/apps/new', ['sso.read']],
    // Branding is for `settings.branding` only: neither access admins nor letterhead managers get the page.
    ['/settings/branding', ['access.manage_roles', 'access.grant', 'document.configure']],
  ])('%s with only %j', async (url, permissions) => {
    const harness = await open(meWith(permissions), url);

    expect(heading(harness)).toBe('404');
  });

  it.each([
    ['/documents', ['document.read']],
    ['/leave', ['leave.read']],
    ['/leave/settings', ['leave.configure']],
    ['/attendance', ['attendance.read']],
    ['/attendance/settings', ['attendance.configure']],
    ['/attendance/corrections', ['attendance.read']],
    ['/attendance/reports', ['attendance.read']],
    ['/me/team', []],
    ['/access/apps', ['sso.read']],
    ['/access/apps/new', ['sso.read', 'sso.manage_apps']],
    ['/settings', []],
    ['/settings/branding', ['settings.branding']],
  ])('%s with %j opens the page', async (url, permissions) => {
    const harness = await open(meWith(permissions), url);

    expect(harness.routeNativeElement).not.toBeNull();
    expect(heading(harness)).not.toBe('404');
  });
});

describe('app routes: the entrance kiosk', () => {
  it('opens signed out (no guard, no /login redirect) and is not the 404 page', async () => {
    TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [provideRouter(routes, withComponentInputBinding()), provideHttpClient(), provideHttpClientTesting()],
    });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/kiosk');
    expect(TestBed.inject(Router).url).toBe('/kiosk');
    expect(harness.routeNativeElement?.querySelector('app-kiosk-page, .kiosk')).not.toBeNull();
  });
});

describe('app routes: the SSO sign-in handoff', () => {
  it('/sso/:uid opens signed out (no guard, no /login redirect before the page decides)', async () => {
    TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [provideRouter(routes, withComponentInputBinding()), provideHttpClient(), provideHttpClientTesting()],
    });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/sso/Ab3_dE-fGhIjKlMnOpQrStU');
    expect(TestBed.inject(Router).url).toBe('/sso/Ab3_dE-fGhIjKlMnOpQrStU');
    expect(harness.routeNativeElement?.querySelector('.handoff')).not.toBeNull();
  });
});
