import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { meWith } from '../../../testing/auth-fixtures';
import { DOCUMENT_TYPES, SIGNATORY_DG, TYPE_ATT, TYPE_CT } from '../../../testing/document-fixtures';
import { TYPE_OM } from '../../../testing/template-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { Session } from '../../core/auth/session';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import { selfServiceOffered, TypesSettings } from './types-settings';

async function settle(): Promise<void> {
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
}

describe('TypesSettings', () => {
  it('previews the next number under the format being typed, and maps document-format-taken to the field', async () => {
    await TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting()],
    }).compileComponents();
    const http = TestBed.inject(HttpTestingController);
    TestBed.inject(Session).set(meWith(['document.configure']));
    const fixture = TestBed.createComponent(TypesSettings);
    const el = fixture.nativeElement as HTMLElement;
    await settle();
    http.expectOne('/api/documents/types').flush({ items: DOCUMENT_TYPES });
    http.expectOne('/api/documents/settings/signatories').flush({ items: [SIGNATORY_DG] });
    await settle();

    expect(el.querySelector('[data-type="attestation_travail"] [data-field="next"]')?.textContent).toBe('ATT-2026-00043');
    (el.querySelector('[data-type="attestation_travail"] [data-action="edit-type"]') as HTMLButtonElement).click();
    await settle();
    const input = el.querySelector('#type-format') as HTMLInputElement;
    input.value = 'AT/{YY}/{SEQ:3}';
    input.dispatchEvent(new Event('input'));
    await settle();
    expect(el.querySelector('[data-field="preview"]')?.textContent).toContain('AT/26/043');

    input.value = 'AT-{SEQ}';
    input.dispatchEvent(new Event('input'));
    await settle();
    expect(el.querySelector('[data-field="preview"]')?.textContent?.trim()).toBe('');
    expect(el.querySelector('[data-error="numberFormat"]')?.textContent).toContain('l’année');

    // typed in lower case: the input SHOWS capitals (CSS), so the value is upper-cased for the check, preview and save
    input.value = 'at-{yyyy}-{seq:4}';
    input.dispatchEvent(new Event('input'));
    await settle();
    expect(el.querySelector('[data-error="numberFormat"]')).toBeNull();
    expect(el.querySelector('[data-field="preview"]')?.textContent).toContain('AT-2026-0043');

    input.value = 'ct-{YYYY}-{SEQ:5}';
    input.dispatchEvent(new Event('input'));
    (el.querySelector('[data-action="save-type"]') as HTMLButtonElement).click();
    const req = http.expectOne('/api/documents/types/dt-att');
    expect(req.request.body).toEqual({ numberFormat: 'CT-{YYYY}-{SEQ:5}', languages: ['fr', 'ar'], selfService: true, defaultSignatoryId: null, active: true });
    req.flush({ type: 'urn:hrforce:problem:document-format-taken', title: 'Conflict', status: 409 }, { status: 409, statusText: 'Conflict' });
    await settle();
    expect(el.querySelector('[data-error="numberFormat"]')?.textContent).toContain('déjà utilisé');
    http.verify();
  });

  it('edits a custom type: names, employment rule, and activation refused without a published template', async () => {
    await TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting()],
    }).compileComponents();
    const http = TestBed.inject(HttpTestingController);
    TestBed.inject(Session).set(meWith(['document.configure']));
    const fixture = TestBed.createComponent(TypesSettings);
    const el = fixture.nativeElement as HTMLElement;
    await settle();
    const unpublished = { ...TYPE_OM, active: false, templateMode: 'designed' as const, template: null };
    http.expectOne('/api/documents/types').flush({ items: [...DOCUMENT_TYPES, unpublished] });
    http.expectOne('/api/documents/settings/signatories').flush({ items: [SIGNATORY_DG] });
    await settle();

    expect(el.querySelector('[data-type="ordre_mission"] [data-kind="custom"]')).not.toBeNull();
    (el.querySelector('[data-type="ordre_mission"] [data-action="edit-type"]') as HTMLButtonElement).click();
    await settle();
    expect(el.querySelector('[data-hint="unpublished"]')).not.toBeNull();
    const name = el.querySelector('#type-name-fr') as HTMLInputElement;
    name.value = 'Ordre de mission (Algérie)';
    name.dispatchEvent(new Event('input'));
    const rule = el.querySelector('#type-rule') as HTMLSelectElement;
    rule.value = 'any';
    rule.dispatchEvent(new Event('change'));
    const active = el.querySelector('#type-active') as HTMLInputElement;
    active.click();
    (el.querySelector('[data-action="save-type"]') as HTMLButtonElement).click();
    const req = http.expectOne('/api/documents/types/dt-om');
    expect(req.request.body).toMatchObject({
      active: true,
      selfService: false,
      employmentRule: 'any',
      names: { fr: 'Ordre de mission (Algérie)', ar: 'أمر بمهمة', en: 'Mission order' },
    });
    req.flush({ type: 'urn:hrforce:problem:document-template-missing', title: 'Conflict', status: 409 }, { status: 409, statusText: 'Conflict' });
    await settle();
    expect(el.querySelector('[data-error="active"]')?.textContent).toContain('pas encore de modèle publié');
    http.verify();
  });

  it('offers self-service for the attestation and for custom types without a required field', () => {
    expect(selfServiceOffered(TYPE_ATT)).toBe(true);
    expect(selfServiceOffered(TYPE_CT)).toBe(false);
    expect(selfServiceOffered(TYPE_OM)).toBe(false);
    expect(selfServiceOffered({ ...TYPE_OM, template: { id: 't', version: 1, fields: [] } })).toBe(true);
    expect(selfServiceOffered({ ...TYPE_OM, subject: 'leave_request', template: { id: 't', version: 1, fields: [] } })).toBe(false);
  });
});
