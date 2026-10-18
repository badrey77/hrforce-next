import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { meWith } from '../../../../testing/auth-fixtures';
import { installDialogPolyfill } from '../../../../testing/dialog-polyfill';
import { TYPE_CT, TYPE_TC } from '../../../../testing/document-fixtures';
import { TYPE_ATT_DESIGNED, TYPE_OM, typeTemplates } from '../../../../testing/template-fixtures';
import { translocoTesting } from '../../../../testing/transloco-testing';
import { Session } from '../../../core/auth/session';
import { apiProblemInterceptor } from '../../../core/http/api-problem.interceptor';
import { customCode, previewLanguage, TemplatesSettings } from './templates-settings';
import { FormControl } from '@angular/forms';

@Component({ template: '' })
class Stub {}

async function settle(): Promise<void> {
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
}

describe('templates settings helpers', () => {
  it('checks custom type codes', () => {
    expect(customCode(new FormControl('ordre_mission'))).toBeNull();
    expect(customCode(new FormControl('titre_conge'))).toEqual({ reserved: true });
    expect(customCode(new FormControl('Ordre'))).toEqual({ code: true });
    expect(customCode(new FormControl('ab'))).toEqual({ code: true });
    expect(customCode(new FormControl(''))).toEqual({ required: true });
  });

  it('previews in the UI language when the type is printed in it', () => {
    expect(previewLanguage({ languages: ['fr', 'ar'] }, 'ar')).toBe('ar');
    expect(previewLanguage({ languages: ['fr'] }, 'ar')).toBe('fr');
    expect(previewLanguage({ languages: ['ar'] }, 'en')).toBe('ar');
  });
});

describe('TemplatesSettings', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;

  async function setup(permissions: string[]): Promise<void> {
    installDialogPolyfill();
    await TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [
        provideRouter([
          { path: 'settings', component: TemplatesSettings },
          { path: 'documents/settings/templates/:typeId', component: Stub },
        ]),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(Session).set(meWith(permissions));
    harness = await RouterTestingHarness.create('/settings');
    await answer();
  }

  async function answer(): Promise<void> {
    for (let round = 0; round < 4; round++) {
      await settle();
      for (const req of http.match(() => true)) {
        if (req.cancelled) continue;
        const url = req.request.url;
        if (url === '/api/documents/types' && req.request.method === 'GET') req.flush({ items: [TYPE_ATT_DESIGNED, TYPE_CT, TYPE_TC, TYPE_OM] });
        else if (url === '/api/documents/types/dt-om/templates') req.flush(typeTemplates());
        else if (/\/api\/documents\/types\/[^/]+\/templates$/.test(url)) req.flush({ mode: 'builtin', builtin: { version: 'x@2', available: true }, items: [] });
      }
    }
    harness.detectChanges();
  }

  afterEach(() => http.verify());

  const el = () => harness.routeNativeElement as HTMLElement;
  const row = (code: string) => el().querySelector(`[data-type="${code}"]`) as HTMLElement;

  it('lists every type with its template, kind and draft', async () => {
    await setup(['document.design', 'document.configure']);
    expect(row('attestation_travail').textContent).toContain('Version 1 publiée');
    expect(row('certificat_travail').textContent).toContain('Modèle intégré');
    expect(row('ordre_mission').querySelector('[data-kind="custom"]')).not.toBeNull();
    expect(row('ordre_mission').querySelector('[data-badge="draft"]')?.textContent).toContain('v2');
    expect(row('attestation_travail').querySelector('[data-action="revert"]')).not.toBeNull();
    expect(row('ordre_mission').querySelector('[data-action="revert"]')).toBeNull();
    expect(row('certificat_travail').querySelector('[data-action="preview"]')).toBeNull();
  });

  it('goes back to the built-in template after confirmation', async () => {
    await setup(['document.design', 'document.configure']);
    (row('attestation_travail').querySelector('[data-action="revert"]') as HTMLButtonElement).click();
    harness.detectChanges();
    (el().querySelector('[data-action="confirm-revert"]') as HTMLButtonElement).click();
    http.expectOne((r) => r.method === 'POST' && r.url === '/api/documents/types/dt-att/templates/builtin').flush({ mode: 'builtin', builtin: null, items: [] });
    await answer();
    expect(el().querySelector('.feedback')?.textContent).toContain('modèle intégré est de nouveau utilisé');
  });

  it('creates a custom type and opens its designer', async () => {
    await setup(['document.design', 'document.configure']);
    (el().querySelector('[data-action="new-type"]') as HTMLButtonElement).click();
    harness.detectChanges();
    const set = (selector: string, value: string) => {
      const input = el().querySelector(selector) as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new Event('input'));
    };
    set('#nt-code', 'ordre_mission');
    set('#nt-fr', 'Ordre de mission');
    set('#nt-ar', 'أمر بمهمة');
    set('#nt-format', 'om-{yyyy}-{seq:4}');
    harness.detectChanges();
    expect(el().querySelector('#nt-format-preview')?.textContent).toContain('OM-2026-0001');
    (el().querySelector('[data-action="create-type"]') as HTMLButtonElement).click();
    const post = http.expectOne((r) => r.method === 'POST' && r.url === '/api/documents/types');
    expect(post.request.body).toEqual({
      code: 'ordre_mission',
      names: { fr: 'Ordre de mission', ar: 'أمر بمهمة', en: 'Ordre de mission' },
      subject: 'employment',
      employmentRule: 'any',
      numberFormat: 'OM-{YYYY}-{SEQ:4}',
      languages: ['fr', 'ar'],
    });
    post.flush({ ...TYPE_OM, id: 'dt-new' });
    await answer();
    expect(TestBed.inject(Router).url).toBe('/documents/settings/templates/dt-new');
  });

  it('shows a taken code on the code field', async () => {
    await setup(['document.design', 'document.configure']);
    (el().querySelector('[data-action="new-type"]') as HTMLButtonElement).click();
    harness.detectChanges();
    for (const [selector, value] of [['#nt-code', 'ordre_mission'], ['#nt-fr', 'A'], ['#nt-ar', 'ب'], ['#nt-format', 'OM-{YYYY}-{SEQ}']]) {
      const input = el().querySelector(selector as string) as HTMLInputElement;
      input.value = value as string;
      input.dispatchEvent(new Event('input'));
    }
    (el().querySelector('[data-action="create-type"]') as HTMLButtonElement).click();
    http
      .expectOne((r) => r.method === 'POST')
      .flush(
        { type: 'urn:hrforce:problem:document-type-code-taken', title: 'Taken', status: 409 },
        { status: 409, statusText: 'Conflict', headers: { 'content-type': 'application/problem+json' } },
      );
    await settle();
    harness.detectChanges();
    expect(el().querySelector('[data-error="code"]')?.textContent).toContain('déjà utilisé');
  });

  it('hides « Nouveau type » without document.configure', async () => {
    await setup(['document.design']);
    expect(el().querySelector('[data-action="new-type"]')).toBeNull();
    expect(row('ordre_mission').querySelector('[data-action="design"]')).not.toBeNull();
  });

  it('on a narrow screen names the link « Versions et aperçus » and starts no new type', async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
    try {
      await setup(['document.design', 'document.configure']);
      expect(el().querySelector('[data-action="new-type"]')).toBeNull();
      expect(row('ordre_mission').querySelector('[data-action="design"]')?.textContent?.trim()).toBe('Versions et aperçus');
      expect(row('attestation_travail').querySelector('[data-action="preview"]')).not.toBeNull();
    } finally {
      window.matchMedia = original;
    }
  });
});
