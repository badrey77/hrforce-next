import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { CREATED, LEAVE_APPROVED, LEAVE_CREATED, PAGE_1, PAGE_2, TASK_DONE, WORKFLOW_APPROVE } from '../../../testing/audit-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import { LanguageService } from '../../core/i18n/language.service';
import { Timeline } from './timeline';
import type { AuditNameResolver } from './timeline-view';

const isTimeline = (r: { url: string }) => r.url === '/api/audit/timeline';
const clean = (s: string | null | undefined) => s?.replace(/\s+/g, ' ').trim() ?? '';

/** Not `fixture.whenStable()`: an open request (a pending resource) keeps the app "unstable" until flushed. */
async function settle(): Promise<void> {
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
}

const DG_NAME: AuditNameResolver = (kind, value) => (kind === 'unit' && value === 'dg' ? 'Direction générale' : undefined);
const GRANT_NAMES: AuditNameResolver = (kind, value) =>
  kind === 'unit' && value === 'r-ouest' ? 'Région Ouest' : kind === 'roleCode' && value === 'lecture' ? 'Lecture' : undefined;

const LEAVE_NAMES: AuditNameResolver = (kind, value) =>
  kind === 'leaveType' && value === 't-annual' ? 'Congé annuel' : kind === 'step' && value === 'hr' ? 'RH régionales' : undefined;

describe('<app-timeline>', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<Timeline>;
  const el = () => fixture.nativeElement as HTMLElement;
  const text = (selector: string) => clean(el().querySelector(selector)?.textContent);


  async function create(subject = 'org_unit:r-est', resolver?: AuditNameResolver): Promise<TestRequest> {
    fixture = TestBed.createComponent(Timeline);
    fixture.componentRef.setInput('subject', subject);
    if (resolver) fixture.componentRef.setInput('resolver', resolver);
    await settle();
    return http.expectOne(isTimeline);
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 8, 26, 14)); // "today" = 2026-09-26
    TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    TestBed.inject(LanguageService).use('fr');
    vi.useRealTimers();
  });

  it('shows a loading state, then day groups with French headings, actor and time', async () => {
    const req = await create();
    expect(req.request.params.get('subject')).toBe('org_unit:r-est');
    expect(text('[data-state="loading"]')).toBe('Chargement de l’historique…');

    req.flush(PAGE_1);
    await settle();
    const headings = [...el().querySelectorAll('.day h3')].map((h) => clean(h.textContent));
    expect(headings).toEqual([
      'Aujourd’hui — samedi 26 septembre 2026',
      'Hier — vendredi 25 septembre 2026',
      'dimanche 20 septembre 2026',
    ]);
    expect(text('[data-entry="c:41"] .actor')).toBe('Amina Benali');
    expect(el().querySelector('[data-entry="c:41"] time')?.getAttribute('datetime')).toBe('2026-09-26T10:30:00Z');
    expect(text('[data-entry="c:12"] .actor')).toBe('Système');
  });

  it('one line per changed field, with translated labels, names from the resolver, fallback to the column name', async () => {
    (await create('org_unit:r-est', DG_NAME)).flush(PAGE_1);
    await settle();

    expect(text('[data-entry="c:41"] .what')).toBe('Modification · Version de l’unité');
    const line = (field: string) => {
      const part = (cls: string) => text(`[data-entry="c:41"] [data-field="${field}"] .${cls}`);
      return [part('field-name'), part('before'), part('after')];
    };
    expect(line('name')).toEqual(['Nom', 'Région Est', 'Région Est-Algérie']);
    expect(line('parent_id')).toEqual(['Unité parente', 'dept-ops', 'Direction générale']);
    expect(text('[data-entry="c:41"] [data-field="name"] .visually-hidden')).toBe('devient');
    expect(el().querySelector('[data-entry="c:41"] [data-field="id"]')).toBeNull();
    // Unknown column: no key → the column name.
    expect(text('[data-entry="c:12"] [data-field="legacy_col"] .field-name')).toBe('legacy_col');
    // Insert: only "after"; booleans translated.
    expect(text('[data-entry="c:40"] [data-field="include_descendants"]')).toBe('Sous-unités incluses Oui');
    expect(text('[data-entry="c:40"] [data-field="valid_to"]')).toBe('Valable jusqu’au (exclu) (vide)');
  });

  it('masked values read "masqué" (and "مخفي" in Arabic) — the stored "***" is never shown', async () => {
    (await create()).flush(PAGE_1);
    await settle();
    const masked = () => [...el().querySelectorAll('[data-entry="c:12"] [data-field="address"] [data-value="masked"]')];
    expect(masked().map((m) => clean(m.textContent))).toEqual(['masqué', 'masqué']);
    expect(el().textContent).not.toContain('***');

    TestBed.inject(LanguageService).use('ar');
    await settle();
    expect(masked().map((m) => clean(m.textContent))).toEqual(['مخفي', 'مخفي']);
    expect(text('.day h3')).toContain('اليوم');
  });

  it('events render as a translated sentence with their data', async () => {
    (await create('user:u-samir', GRANT_NAMES)).flush(PAGE_1);
    await settle();
    expect(text('[data-entry="e:7"] [data-kind="event"]')).toBe('Rôle « Lecture » attribué sur Région Ouest à partir du 1 oct. 2026');
  });

  it('"load more" sends the cursor, APPENDS the next page, and disappears when nextCursor is null', async () => {
    (await create()).flush(PAGE_1);
    await settle();
    expect(el().querySelectorAll('.entry').length).toBe(4);

    (el().querySelector('[data-action="load-more"]') as HTMLButtonElement).click();
    await settle();
    const next = http.expectOne(isTimeline);
    expect(next.request.params.get('before')).toBe('cur-2');
    expect(text('[data-state="loading-more"]')).toBe('Chargement de l’historique…');
    // Earlier pages stay on screen while the next one loads.
    expect(el().querySelectorAll('.entry').length).toBe(4);

    next.flush(PAGE_2);
    await settle();
    expect([...el().querySelectorAll('.entry')].map((e) => e.getAttribute('data-entry'))).toEqual([
      'c:41',
      'e:7',
      'c:40',
      'c:12',
      CREATED.id,
    ]);
    expect(text(`[data-entry="${CREATED.id}"] [data-field="valid"]`)).toBe('Validité du 1 janv. 2026 au 1 janv. 2027');
    expect(el().querySelector('[data-action="load-more"]')).toBeNull();
  });

  it('empty history', async () => {
    (await create()).flush({ items: [], nextCursor: null });
    await settle();
    expect(text('[data-state="empty"]')).toBe('Aucun historique pour l’instant.');
  });

  it('error on the first page: alert + retry; a 404 reads "not found"', async () => {
    (await create()).flush({ type: 'about:blank', title: 'Not Found', status: 404 }, { status: 404, statusText: 'Not Found' });
    await settle();
    expect(text('[role="alert"] p')).toBe('Historique introuvable ou non accessible.');

    (el().querySelector('[role="alert"] button') as HTMLButtonElement).click();
    await settle();
    http.expectOne(isTimeline).flush(PAGE_2);
    await settle();
    expect(el().querySelector('[role="alert"]')).toBeNull();
    expect(el().querySelectorAll('.entry').length).toBe(1);
  });

  it('error on "load more": the loaded pages stay, retry re-sends the same cursor', async () => {
    (await create()).flush(PAGE_1);
    await settle();
    (el().querySelector('[data-action="load-more"]') as HTMLButtonElement).click();
    await settle();
    http.expectOne(isTimeline).flush({ title: 'Oops', status: 500 }, { status: 500, statusText: 'Server Error' });
    await settle();
    expect(el().querySelectorAll('.entry').length).toBe(4);
    expect(text('.footer [role="alert"] p')).toBe('Impossible de charger l’historique.');

    (el().querySelector('.footer [role="alert"] button') as HTMLButtonElement).click();
    await settle();
    const retry = http.expectOne(isTimeline);
    expect(retry.request.params.get('before')).toBe('cur-2');
    retry.flush(PAGE_2);
    await settle();
    expect(el().querySelectorAll('.entry').length).toBe(5);
  });

  it('a new subject starts over from the newest page', async () => {
    (await create('user:u-1')).flush(PAGE_1);
    await settle();
    fixture.componentRef.setInput('subject', 'user:u-2');
    await settle();
    const req = http.expectOne(isTimeline);
    expect(req.request.params.get('subject')).toBe('user:u-2');
    expect(req.request.params.has('before')).toBe(false);
    req.flush(PAGE_2);
    await settle();
    expect(el().querySelectorAll('.entry').length).toBe(1);
  });

  it('leave requests (employee History / leave request detail): labels, statuses, outcomes and workflow events', async () => {
    const req = await create('leave_request:r-1', LEAVE_NAMES);
    expect(req.request.params.get('subject')).toBe('leave_request:r-1');
    req.flush({ items: [LEAVE_APPROVED, WORKFLOW_APPROVE, TASK_DONE, LEAVE_CREATED], nextCursor: null });
    await settle();

    expect(text('[data-entry="c:90"] .what')).toBe('Création · Demande de congé');
    expect(text('[data-entry="c:90"] [data-field="leave_type_id"]')).toBe('Type de congé Congé annuel');
    expect(text('[data-entry="c:90"] [data-field="status"]')).toBe('Statut En attente');
    expect(el().querySelector('[data-entry="c:90"] [data-field="employment_id"]')).toBeNull();
    expect(text('[data-entry="c:95"] [data-field="status"] .after')).toBe('Approuvé');
    expect(text('[data-entry="c:94"] .what')).toBe('Modification · Étape d’approbation');
    expect(text('[data-entry="c:94"] [data-field="outcome"] .after')).toBe('approuvée');
    expect(text('[data-entry="e:30"] [data-kind="event"]')).toBe('Étape « RH régionales » approuvée');
  });
});
