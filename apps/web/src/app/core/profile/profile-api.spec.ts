import { HttpEventType, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Injector, runInInjectionContext, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom, toArray } from 'rxjs';
import { fakeFile, provideUploadsThroughTestingBackend } from '../../../testing/employee-file-fixtures';
import { myProfile, personalView, PROFILE_SETTINGS, profileRequest, profileRequestDetail } from '../../../testing/profile-fixtures';
import { ProfileApi, profileRequestFormData, profileRequestParams, toProfileUploadEvent } from './profile-api';
import {
  ageOn,
  blankToNull,
  changedKeys,
  DEFAULT_PROFILE_REQUEST_QUERY,
  familyNeedsProof,
  normaliseRib,
  pendingOf,
  type ProfileUploadEvent,
  sectionMode,
} from './profile.models';
import { WILAYAS, wilayaLabel } from './wilayas';

describe('profile models', () => {
  it('lists the 58 wilayas in code order with fr/ar/en names', () => {
    expect(WILAYAS).toHaveLength(58);
    expect(WILAYAS.map((w) => w.code)).toEqual(Array.from({ length: 58 }, (_, i) => String(i + 1).padStart(2, '0')));
    expect(WILAYAS.every((w) => w.fr && w.ar && w.en)).toBe(true);
    expect(wilayaLabel('23', 'fr')).toBe('23 — Annaba');
    expect(wilayaLabel('16', 'en')).toBe('16 — Algiers');
    expect(wilayaLabel('16', 'ar')).toBe('16 — الجزائر');
    expect(wilayaLabel(null, 'fr')).toBe('');
  });

  it('bank and identity note always need approval; the others follow the company', () => {
    const modes = myProfile().modes;
    expect(sectionMode(modes, 'contact')).toBe('immediate');
    expect(sectionMode(modes, 'family')).toBe('approval');
    expect(sectionMode(modes, 'bank')).toBe('approval');
    expect(sectionMode(modes, 'identity_note')).toBe('approval');
  });

  it('finds the pending request of a section', () => {
    const profile = myProfile({ pending: [{ id: 'pr-1', section: 'family', requestedAt: '2026-10-20T08:30:00Z' }] });
    expect(pendingOf(profile, 'family')?.id).toBe('pr-1');
    expect(pendingOf(profile, 'contact')).toBeNull();
  });

  it('a family change needs proof only when the status or the children change', () => {
    const family = personalView().family;
    expect(familyNeedsProof(family, { ...family, spouseEmployed: 'yes' })).toBe(false);
    expect(familyNeedsProof(family, { ...family, maritalStatus: 'divorced' })).toBe(true);
    expect(familyNeedsProof(family, { ...family, children: [] })).toBe(true);
    expect(familyNeedsProof(family, { ...family, children: family.children.map((c) => ({ ...c, dependent: false })) })).toBe(true);
  });

  it('small helpers: changed keys, blanks, RIB spaces, ages', () => {
    const contact = personalView().contact;
    expect(changedKeys(contact, { ...contact, commune: 'El Bouni', updatedAt: null })).toEqual(['commune']);
    expect(changedKeys(null, null)).toEqual([]);
    expect(blankToNull('  ')).toBeNull();
    expect(blankToNull(' a ')).toBe('a');
    expect(normaliseRib('0040 0123 4567 8901 2345')).toBe('00400123456789012345');
    expect(ageOn('2020-03-14', '2026-03-13')).toBe(5);
    expect(ageOn('2020-03-14', '2026-03-14')).toBe(6);
  });
});

describe('ProfileApi', () => {
  let http: HttpTestingController;
  let api: ProfileApi;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), provideUploadsThroughTestingBackend()] });
    http = TestBed.inject(HttpTestingController);
    api = TestBed.inject(ProfileApi);
  });

  afterEach(() => http.verify());

  it('reads the profile, own requests, an HR request and the settings as resources', () => {
    const enabled = signal(false);
    runInInjectionContext(TestBed.inject(Injector), () => {
      api.myProfileResource(() => enabled());
      api.myRequestsResource(() => enabled(), () => 'pending');
      api.requestResource(() => 'pr-1');
      api.settingsResource();
    });
    TestBed.tick();
    http.expectOne('/api/profile/requests/pr-1').flush(profileRequestDetail());
    http.expectOne('/api/profile/settings').flush(PROFILE_SETTINGS);
    enabled.set(true);
    TestBed.tick();
    http.expectOne('/api/me/profile').flush(myProfile());
    http.expectOne((r) => r.url === '/api/me/profile/requests' && r.params.get('status') === 'pending').flush({ items: [] });
  });

  it('sends the HR list filters only when set', () => {
    expect(profileRequestParams(DEFAULT_PROFILE_REQUEST_QUERY)).toEqual({ status: 'pending', page: '1', pageSize: '50' });
    expect(
      profileRequestParams({ ...DEFAULT_PROFILE_REQUEST_QUERY, status: '', section: 'bank', unitId: 'u-1', includeSubUnits: false, q: ' EMP ' }),
    ).toEqual({ section: 'bank', unitId: 'u-1', includeSubUnits: 'false', q: 'EMP', page: '1', pageSize: '50' });
    expect(profileRequestParams({ ...DEFAULT_PROFILE_REQUEST_QUERY, status: '', employmentId: 'e-1' })).toEqual({ employmentId: 'e-1', page: '1', pageSize: '50' });
    runInInjectionContext(TestBed.inject(Injector), () => api.requestsResource(() => DEFAULT_PROFILE_REQUEST_QUERY));
    TestBed.tick();
    http.expectOne((r) => r.url === '/api/profile/requests' && r.params.get('status') === 'pending').flush({ items: [], total: 0, page: 1, pageSize: 50 });
  });

  it('builds the multipart body: the JSON data first, then the files', () => {
    const form = profileRequestFormData({ section: 'identity_note', payload: { note: 'Date de naissance' } }, [
      fakeFile('a.pdf', 'application/pdf'),
      fakeFile('b.jpg', 'image/jpeg'),
    ]);
    expect([...form.keys()]).toEqual(['data', 'files', 'files']);
    expect(JSON.parse(form.get('data') as string)).toEqual({ section: 'identity_note', payload: { note: 'Date de naissance' } });
    expect(toProfileUploadEvent({ type: HttpEventType.DownloadProgress, loaded: 1 }, 1)).toBeNull();
  });

  it('submits with progress, then the created request', async () => {
    const events = firstValueFrom(
      api.submit({ section: 'family', payload: { ...personalView().family } }, [fakeFile('livret.pdf', 'application/pdf', 100)]).pipe(toArray()),
    );
    const req = http.expectOne('/api/me/profile/requests');
    expect(req.request.method).toBe('POST');
    expect(req.request.reportProgress).toBe(true);
    expect(req.request.body).toBeInstanceOf(FormData);
    req.event({ type: HttpEventType.UploadProgress, loaded: 60, total: 100 });
    req.flush(profileRequest(), { status: 201, statusText: 'Created' });
    const all: ProfileUploadEvent[] = await events;
    expect(all.map((e) => (e.kind === 'progress' ? e.loaded : e.request.id))).toEqual([0, 60, 'pr-1']);
  });

  it('cancels, downloads files and writes the settings', () => {
    api.cancel('pr-1').subscribe();
    const cancel = http.expectOne('/api/me/profile/requests/pr-1/cancel');
    expect(cancel.request.method).toBe('POST');
    cancel.flush(profileRequest({ status: 'cancelled', _actions: [] }));

    api.myFile('pr-1', 'pf-1').subscribe();
    expect(http.expectOne('/api/me/profile/requests/pr-1/files/pf-1').request.responseType).toBe('blob');
    api.file('pr-1', 'pf-1').subscribe();
    expect(http.expectOne('/api/profile/requests/pr-1/files/pf-1').request.responseType).toBe('blob');
    api.request('pr-1').subscribe();
    http.expectOne('/api/profile/requests/pr-1').flush(profileRequestDetail());

    api.updateSettings({ ...PROFILE_SETTINGS, familyMode: 'immediate' }).subscribe();
    const put = http.expectOne('/api/profile/settings');
    expect(put.request.method).toBe('PUT');
    expect(put.request.body).toEqual({ ...PROFILE_SETTINGS, familyMode: 'immediate' });
    put.flush(PROFILE_SETTINGS);
  });

  it('writes an employee’s contact, emergency contact and family (HR)', () => {
    const personal = personalView();
    const { updatedAt: _u, ...contact } = personal.contact;
    api.updateContact('emp-31', contact).subscribe();
    const c = http.expectOne('/api/employees/emp-31/contact');
    expect(c.request.method).toBe('PUT');
    c.flush(personal);
    api.updateEmergencyContact('emp-31', null).subscribe();
    const removal = http.expectOne('/api/employees/emp-31/emergency-contact');
    expect(removal.request.body).toBe('null');
    expect(removal.request.headers.get('Content-Type')).toBe('application/json');
    api.updateFamily('emp-31', personal.family).subscribe();
    expect(http.expectOne('/api/employees/emp-31/family').request.body).toEqual(personal.family);
  });
});
