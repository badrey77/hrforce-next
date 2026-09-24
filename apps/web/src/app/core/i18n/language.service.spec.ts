import { DOCUMENT } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { TranslocoService } from '@jsverse/transloco';
import { translocoTesting } from '../../../testing/transloco-testing';
import { LANGUAGE_STORAGE_KEY, LanguageService } from './language.service';

describe('LanguageService', () => {
  let service: LanguageService;
  let transloco: TranslocoService;
  let html: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({ imports: [translocoTesting()] });
    service = TestBed.inject(LanguageService);
    transloco = TestBed.inject(TranslocoService);
    html = TestBed.inject(DOCUMENT).documentElement;
    html.lang = 'fr';
    html.dir = 'ltr';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('defaults to French, LTR, when nothing is stored', async () => {
    await service.init();

    expect(service.current()).toBe('fr');
    expect(transloco.getActiveLang()).toBe('fr');
    expect(html.lang).toBe('fr');
    expect(html.dir).toBe('ltr');
  });

  it('switches to Arabic and sets dir="rtl"', () => {
    service.use('ar');

    expect(service.current()).toBe('ar');
    expect(transloco.getActiveLang()).toBe('ar');
    expect(html.lang).toBe('ar');
    expect(html.dir).toBe('rtl');
    expect(transloco.translate('nav.employees')).toBe('الموظفون');
  });

  it('switches back to LTR for English', () => {
    service.use('ar');
    service.use('en');

    expect(html.lang).toBe('en');
    expect(html.dir).toBe('ltr');
  });

  it('persists the choice in localStorage', () => {
    service.use('ar');

    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('ar');
  });

  it('restores a stored language on init', async () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, 'ar');

    await service.init();

    expect(service.current()).toBe('ar');
    expect(html.dir).toBe('rtl');
  });

  it('ignores an unknown stored value', async () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, 'de');

    await service.init();

    expect(service.current()).toBe('fr');
  });

  it('keeps working when localStorage throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });

    await service.init();
    service.use('ar');

    expect(service.current()).toBe('ar');
    expect(html.dir).toBe('rtl');
  });
});
