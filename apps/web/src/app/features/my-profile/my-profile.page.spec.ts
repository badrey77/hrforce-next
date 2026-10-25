import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { meWith } from '../../../testing/auth-fixtures';
import { installDialogPolyfill } from '../../../testing/dialog-polyfill';
import { fakeFile, provideUploadsThroughTestingBackend } from '../../../testing/employee-file-fixtures';
import { problem } from '../../../testing/employee-fixtures';
import { myProfile, profileRequest } from '../../../testing/profile-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { Session } from '../../core/auth/session';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import type { MyProfileView, ProfileRequestView } from '../../core/profile/profile.models';
import { MyProfilePage } from './my-profile.page';

async function settle(): Promise<void> {
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
}

function q<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`missing ${selector}`);
  return found;
}

function click(root: ParentNode, selector: string): void {
  q<HTMLButtonElement>(root, selector).click();
}

function type(root: ParentNode, selector: string, value: string): void {
  const input = q<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(root, selector);
  input.value = value;
  input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input'));
}

describe('MyProfilePage', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;

  beforeEach(async () => {
    installDialogPolyfill();
    await TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [
        provideRouter([{ path: 'me/profile', component: MyProfilePage }], withComponentInputBinding()),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
        provideUploadsThroughTestingBackend(),
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(Session).set(meWith(['profile.request_self']));
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => http.verify());

  const el = () => harness.routeNativeElement as HTMLElement;
  const card = (section: string) => q<HTMLElement>(el(), `[data-card="${section}"]`);

  async function flushStepperTypes(): Promise<void> {
    for (const req of http.match('/api/leave/types')) req.flush({ items: [] });
    await settle();
  }

  async function open(profile: MyProfileView = myProfile(), requests: readonly ProfileRequestView[] = [], url = '/me/profile'): Promise<void> {
    await harness.navigateByUrl(url);
    await settle();
    http.expectOne('/api/me/profile').flush(profile);
    await settle();
    http.expectOne('/api/me/profile/requests').flush({ items: requests });
    await settle();
    await flushStepperTypes();
  }

  async function reloads(profile: MyProfileView = myProfile(), requests: readonly ProfileRequestView[] = []): Promise<void> {
    await settle();
    http.expectOne('/api/me/profile').flush(profile);
    http.expectOne('/api/me/profile/requests').flush({ items: requests });
    await settle();
    await flushStepperTypes();
  }

  it('shows identity read-only, the cards with their mode, the masked RIB and NIN', async () => {
    await open();
    expect(el().querySelector('h1')?.textContent).toContain('Mon profil');
    expect(card('identity_note').querySelector('[data-field="nin"]')?.textContent).toContain('•••• 4821');
    expect(card('identity_note').textContent).toContain('Signaler une erreur');
    expect(card('contact').textContent).toContain('+213 555 12 34 56');
    expect(card('contact').querySelector('[data-field="address"]')?.textContent).toContain('23 — Annaba');
    expect(card('contact').querySelector('[data-field="mode-badge"]')?.textContent).toContain('Immédiat');
    expect(card('family').querySelector('[data-field="mode-badge"]')?.textContent).toContain('Validation RH');
    expect(card('family').textContent).toContain('Marié(e)');
    expect(card('family').querySelectorAll('[data-child]')).toHaveLength(1);
    expect(card('bank').querySelector('[data-field="rib"]')?.textContent).toContain('•••• •••• 1234');
    expect(card('bank').textContent).not.toContain('00400');
    expect(el().querySelector('[data-state="no-requests"]')).not.toBeNull();
  });

  it('explains when the account is not linked to an open employment', async () => {
    await harness.navigateByUrl('/me/profile');
    await settle();
    http.expectOne('/api/me/profile').flush(...problem(409, 'profile-not-linked'));
    await settle();
    expect(el().querySelector('[data-state="not-linked"]')).not.toBeNull();
    expect(el().querySelector('[data-card]')).toBeNull();
  });

  it('applies an immediate contact change and reloads', async () => {
    await open();
    click(card('contact'), '[data-action="edit"]');
    await settle();
    const form = q(card('contact'), 'form');
    expect(form.querySelector('[data-field="mode"]')?.textContent).toContain('tout de suite');
    expect(form.querySelector('[data-field="files"]')).toBeNull();
    type(form, '#contact-commune', 'El Bouni');
    click(form, '[data-action="submit"]');
    await settle();
    const req = http.expectOne('/api/me/profile/requests');
    const data = JSON.parse((req.request.body as FormData).get('data') as string) as { section: string; payload: Record<string, unknown> };
    expect(data.section).toBe('contact');
    expect(data.payload['commune']).toBe('El Bouni');
    expect(data.payload['otherPhone']).toBeNull();
    expect((req.request.body as FormData).getAll('files')).toHaveLength(0);
    req.flush(profileRequest({ section: 'contact', status: 'applied', _actions: [] }), { status: 201, statusText: 'Created' });
    await reloads();
    expect(el().querySelector('[data-state="feedback"]')?.textContent).toContain('Modification enregistrée');
    expect(card('contact').querySelector('form')).toBeNull();
  });

  it('refuses invalid values before sending, and says when nothing changed', async () => {
    await open();
    click(card('contact'), '[data-action="edit"]');
    await settle();
    const form = q(card('contact'), 'form');
    type(form, '#contact-postal', '123');
    type(form, '#contact-mobile', 'abc');
    click(form, '[data-action="submit"]');
    await settle();
    expect(form.textContent).toContain('Le code postal compte 5 chiffres.');
    expect(form.textContent).toContain('Numéro invalide');
    type(form, '#contact-postal', '23000');
    type(form, '#contact-mobile', '+213 555 12 34 56');
    click(form, '[data-action="submit"]');
    await settle();
    http.expectNone('/api/me/profile/requests');
    expect(form.querySelector('[data-error="form"]')?.textContent).toContain('Aucune modification');
  });

  it('maps the API field errors and the pending conflict onto the form', async () => {
    await open();
    click(card('contact'), '[data-action="edit"]');
    await settle();
    const form = q(card('contact'), 'form');
    type(form, '#contact-email', 'samir@example.dz');
    click(form, '[data-action="submit"]');
    await settle();
    http
      .expectOne('/api/me/profile/requests')
      .flush(...problem(422, 'validation', [{ field: 'payload.personalEmail', code: 'invalid', message: 'Adresse refusée par le serveur' }]));
    await settle();
    expect(form.textContent).toContain('Adresse refusée par le serveur');
    // The server error stays until the field is edited.
    click(form, '[data-action="submit"]');
    await settle();
    http.expectNone('/api/me/profile/requests');
    type(form, '#contact-email', 'samir.h@example.dz');
    click(form, '[data-action="submit"]');
    await settle();
    http.expectOne('/api/me/profile/requests').flush(...problem(409, 'profile-request-pending'));
    await settle();
    expect(form.querySelector('[data-error="form"]')?.textContent).toContain('déjà en attente');
  });

  it('asks for a supporting document when the children change, then sends the family request with the files', async () => {
    await open();
    click(card('family'), '[data-action="edit"]');
    await settle();
    const form = q(card('family'), 'form');
    click(form, '[data-action="add-child"]');
    await settle();
    type(form, '#child-name-1', 'Lina');
    type(form, '#child-birth-1', '2026-09-01');
    await settle();
    click(form, '[data-action="submit"]');
    await settle();
    http.expectNone('/api/me/profile/requests');
    expect(form.textContent).toContain('Joignez au moins une pièce justificative.');
    const pick = q<HTMLInputElement>(form, '[data-input="pick"]');
    expect(pick.accept).toBe('image/*,application/pdf');
    expect(form.querySelector('[data-input="camera"]')?.getAttribute('capture')).toBe('environment');
    Object.defineProperty(pick, 'files', { value: [fakeFile('extrait.pdf', 'application/pdf')], configurable: true });
    pick.dispatchEvent(new Event('change'));
    await settle();
    expect(form.querySelectorAll('[data-file]')).toHaveLength(1);
    type(form, '#family-comment', 'Naissance de Lina');
    click(form, '[data-action="submit"]');
    await settle();
    const req: TestRequest = http.expectOne('/api/me/profile/requests');
    const body = req.request.body as FormData;
    const data = JSON.parse(body.get('data') as string) as { section: string; comment: string; payload: { children: { id?: string; firstName: string }[] } };
    expect(data.section).toBe('family');
    expect(data.comment).toBe('Naissance de Lina');
    expect(data.payload.children).toEqual([
      expect.objectContaining({ id: 'ch-1', firstName: 'Yanis' }),
      expect.not.objectContaining({ id: expect.anything() }),
    ]);
    expect(body.getAll('files')).toHaveLength(1);
    req.flush(profileRequest(), { status: 201, statusText: 'Created' });
    await reloads(myProfile({ pending: [{ id: 'pr-1', section: 'family', requestedAt: '2026-10-20T08:30:00Z' }] }), [profileRequest()]);
    expect(el().querySelector('[data-state="feedback"]')?.textContent).toContain('Demande envoyée aux RH');
    expect(card('family').querySelector('[data-state="pending"]')?.textContent).toContain('En attente de validation RH');
    expect(card('family').querySelector('[data-action="edit"]')).toBeNull();
  });

  it('a bank change always needs a RIB document and strips the spaces of the RIB', async () => {
    await open();
    click(card('bank'), '[data-action="edit"]');
    await settle();
    const form = q(card('bank'), 'form');
    expect(form.querySelector('[data-field="mode"]')?.textContent).toContain('RH centrales');
    type(form, '#bank-rib', '0040 0123 4567 8901 2345');
    type(form, '#bank-name', 'CPA');
    click(form, '[data-action="submit"]');
    await settle();
    http.expectNone('/api/me/profile/requests');
    expect(form.textContent).toContain('Joignez au moins une pièce justificative.');
    const pick = q<HTMLInputElement>(form, '[data-input="pick"]');
    Object.defineProperty(pick, 'files', { value: [fakeFile('rib.png', 'image/png')], configurable: true });
    pick.dispatchEvent(new Event('change'));
    await settle();
    click(form, '[data-action="submit"]');
    await settle();
    const req = http.expectOne('/api/me/profile/requests');
    const data = JSON.parse((req.request.body as FormData).get('data') as string) as { payload: { rib: string } };
    expect(data.payload.rib).toBe('00400123456789012345');
    req.flush(...problem(422, 'validation', [{ field: 'files', code: 'unsupported_type', message: 'x' }]));
    await settle();
    expect(form.textContent).toContain('Seuls les fichiers PDF, JPEG et PNG sont acceptés.');
  });

  it('reports an identity error to HR', async () => {
    await open();
    click(card('identity_note'), '[data-action="edit"]');
    await settle();
    const form = q(card('identity_note'), 'form');
    click(form, '[data-action="submit"]');
    await settle();
    expect(form.textContent).toContain('Champ obligatoire.');
    type(form, '#identity-note', 'Mon lieu de naissance est Seraïdi.');
    click(form, '[data-action="submit"]');
    await settle();
    const req = http.expectOne('/api/me/profile/requests');
    expect(JSON.parse((req.request.body as FormData).get('data') as string)).toEqual({
      section: 'identity_note',
      payload: { note: 'Mon lieu de naissance est Seraïdi.' },
    });
    req.flush(profileRequest({ section: 'identity_note' }), { status: 201, statusText: 'Created' });
    await reloads();
    expect(el().querySelector('[data-state="feedback"]')?.textContent).toContain('signalement a été envoyé');
  });

  it('removes the emergency contact with a null payload', async () => {
    await open();
    click(card('emergency'), '[data-action="edit"]');
    await settle();
    click(card('emergency'), '[data-action="remove-emergency"]');
    await settle();
    const req = http.expectOne('/api/me/profile/requests');
    expect(JSON.parse((req.request.body as FormData).get('data') as string)).toEqual({ section: 'emergency', payload: null });
    req.flush(profileRequest({ section: 'emergency', status: 'applied' }), { status: 201, statusText: 'Created' });
    await reloads(myProfile({ personal: { ...myProfile().personal, emergencyContact: null } }));
    expect(card('emergency').querySelector('[data-state="no-emergency"]')).not.toBeNull();
  });

  it('lists my requests with statuses and rejection comments, highlights ?request= and cancels a pending one', async () => {
    const rejected = profileRequest({
      id: 'pr-2',
      section: 'bank',
      status: 'rejected',
      changedFields: ['rib'],
      rejectionComment: 'RIB illisible',
      decidedAt: '2026-10-21T10:00:00Z',
      workflow: null,
      _actions: [],
      // not purged yet, but the API serves the requester's files only while pending: no download offered
      files: [{ id: 'pf-9', filename: 'rib.jpg', mime: 'image/jpeg', sizeBytes: 100, purged: false }],
    });
    const pendingProfile = myProfile({ pending: [{ id: 'pr-1', section: 'family', requestedAt: '2026-10-20T08:30:00Z' }] });
    await open(pendingProfile, [profileRequest(), rejected], '/me/profile?request=pr-2');
    const items = el().querySelectorAll<HTMLElement>('[data-request]');
    expect(items).toHaveLength(2);
    const second = q<HTMLElement>(el(), '[data-request="pr-2"]');
    expect(second.classList).toContain('highlight');
    expect(second.querySelector('[data-field="rejection"]')?.textContent).toContain('RIB illisible');
    expect(second.querySelector('[data-field="changed"]')?.textContent).toContain('RIB');
    expect(second.textContent).toContain('Refusée');
    expect(second.querySelector('[data-action="download"]')).toBeNull();

    click(q(el(), '[data-request="pr-1"]'), '[data-action="cancel-request"]');
    await settle();
    click(el(), '[data-action="confirm-cancel"]');
    await settle();
    http.expectOne('/api/me/profile/requests/pr-1/cancel').flush(...problem(409, 'profile-not-cancellable'));
    await settle();
    expect(el().querySelector('dialog')?.textContent).toContain('ne peut plus être annulée');
    await reloads(pendingProfile, [profileRequest(), rejected]);
    click(el(), '[data-action="confirm-cancel"]');
    await settle();
    http.expectOne('/api/me/profile/requests/pr-1/cancel').flush(profileRequest({ status: 'cancelled', _actions: [] }));
    await reloads(myProfile(), [profileRequest({ status: 'cancelled', _actions: [] }), rejected]);
    expect(el().querySelector('[data-state="feedback"]')?.textContent).toContain('Demande annulée');
  });

  it('downloads a file of my pending request', async () => {
    await open(myProfile(), [profileRequest()]);
    click(q(el(), '[data-request="pr-1"]'), '[data-action="download"]');
    await settle();
    const req = http.expectOne('/api/me/profile/requests/pr-1/files/pf-1');
    expect(req.request.responseType).toBe('blob');
    req.flush(new Blob(['%PDF'], { type: 'application/pdf' }));
    await settle();
  });
});
