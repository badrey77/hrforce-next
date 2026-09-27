import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ME_FIXTURE, ME_MFA_ON, ME_MFA_REQUIRED } from '../../testing/auth-fixtures';
import { translocoTesting } from '../../testing/transloco-testing';
import { Session } from '../core/auth/session';
import { LanguageService } from '../core/i18n/language.service';
import { UserMenu } from './user-menu';

describe('UserMenu › Security link', () => {
  let fixture: ComponentFixture<UserMenu>;
  let el: HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [UserMenu, translocoTesting()],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    TestBed.inject(LanguageService).use('fr', { remember: false });
    fixture = TestBed.createComponent(UserMenu);
    el = fixture.nativeElement as HTMLElement;
  });

  const link = () => el.querySelector('a[data-link="security"]') as HTMLAnchorElement;

  it('links to /me/security without a dot when nothing is required', async () => {
    TestBed.inject(Session).set(ME_MFA_ON);
    await fixture.whenStable();

    expect(link().getAttribute('href')).toBe('/me/security');
    expect(link().textContent?.trim()).toBe('Sécurité');
    expect(el.querySelector('[data-dot="mfa"]')).toBeNull();
    expect(link().getAttribute('aria-label')).toBeNull();
  });

  it('shows a dot and an explicit accessible name when enrollment is required; the dot goes once enrolled', async () => {
    const session = TestBed.inject(Session);
    session.set(ME_MFA_REQUIRED);
    await fixture.whenStable();

    expect(el.querySelector('[data-dot="mfa"]')?.getAttribute('aria-hidden')).toBe('true');
    expect(link().getAttribute('aria-label')).toBe('Sécurité — action requise');

    session.set(ME_MFA_ON);
    await fixture.whenStable();
    expect(el.querySelector('[data-dot="mfa"]')).toBeNull();
  });

  it('treats a /me without mfa as "nothing required"', async () => {
    TestBed.inject(Session).set(ME_FIXTURE);
    await fixture.whenStable();

    expect(el.querySelector('[data-dot="mfa"]')).toBeNull();
  });
});
