import { DOCUMENT } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { LanguageService } from './core/i18n/language.service';
import { translocoTesting } from '../testing/transloco-testing';

describe('App shell', () => {
  beforeEach(async () => {
    localStorage.clear();
    await TestBed.configureTestingModule({
      imports: [App, translocoTesting()],
      providers: [provideRouter([])],
    }).compileComponents();
  });

  it('renders the title, a labelled nav and the language switcher', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('.brand')?.textContent).toContain('HRForce');
    expect(el.querySelector('nav')?.getAttribute('aria-label')).toBe('Navigation principale');
    expect([...el.querySelectorAll('nav a')].map((a) => a.textContent?.trim())).toContain('Employés');
    expect(el.querySelector('app-language-switcher select')).not.toBeNull();
  });

  it('re-renders in Arabic and flips the document to RTL', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();

    TestBed.inject(LanguageService).use('ar');
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;

    expect([...el.querySelectorAll('nav a')].map((a) => a.textContent?.trim())).toContain('الموظفون');
    expect(TestBed.inject(DOCUMENT).documentElement.dir).toBe('rtl');
  });
});
