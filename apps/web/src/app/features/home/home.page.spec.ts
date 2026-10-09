import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { meWith } from '../../../testing/auth-fixtures';
import { EFFECTIVE_BRANDED, MARKUP } from '../../../testing/branding-fixtures';
import { SUMMARY } from '../../../testing/recruitment-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { Session } from '../../core/auth/session';
import type { EffectiveBranding } from '../../core/branding/branding.models';
import { HomePage } from './home.page';

async function settle(): Promise<void> {
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
}

describe('HomePage — recruitment counts (docs/contracts/recruitment.md › Web › Home)', () => {
  let fixture: ComponentFixture<HomePage>;
  let http: HttpTestingController;
  let tasks: readonly unknown[] = [];

  async function create(permissions: readonly string[], branding?: EffectiveBranding): Promise<HTMLElement> {
    await TestBed.configureTestingModule({
      imports: [HomePage, translocoTesting()],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(Session).set(branding ? { ...meWith(permissions), branding } : meWith(permissions));
    fixture = TestBed.createComponent(HomePage);
    await settle();
    // Every signed-in user gets the open-tasks tile (TasksBadge): answered here so each test names only its own requests.
    http.expectOne((req) => req.url === '/api/tasks').flush({ items: tasks });
    await settle();
    return fixture.nativeElement as HTMLElement;
  }

  afterEach(() => http.verify());

  it('HR: openings pending / open and applications per active stage, each a link to the filtered list', async () => {
    const el = await create(['recruitment.read']);
    http.expectOne('/api/recruitment/summary').flush(SUMMARY);
    http.expectOne('/api/me/recruitment/summary').flush({ canRequestOpening: true, openings: 0, pendingOpenings: 0 });
    await settle();
    const link = (name: string) => el.querySelector(`[data-count="${name}"]`) as HTMLAnchorElement;
    expect(link('pending').getAttribute('href')).toBe('/recruitment?status=pending');
    expect(link('pending').textContent).toContain('1');
    expect(link('open').getAttribute('href')).toBe('/recruitment?status=open');
    expect(link('open').textContent).toContain('2');
    expect(link('received').getAttribute('href')).toBe('/recruitment/candidates?stage=received');
    expect(link('received').textContent).toContain('4');
    expect(link('interview').textContent).toContain('2');
    // HR uses « Recrutement »: no personal line.
    expect(el.querySelector('[data-card="my-recruitment"]')).toBeNull();
  });

  it('a unit head: the « Mes recrutements » line with the pending requests; the HR counts are not even asked', async () => {
    const el = await create([]);
    http.expectNone('/api/recruitment/summary');
    http.expectOne('/api/me/recruitment/summary').flush({ canRequestOpening: true, openings: 3, pendingOpenings: 2 });
    await settle();
    const line = el.querySelector('[data-card="my-recruitment"]') as HTMLElement;
    expect(line.querySelector('a')?.getAttribute('href')).toBe('/me/recruitment');
    expect(line.textContent).toContain('2 demande(s) en attente');
    expect(el.querySelector('[data-card="recruitment"]')).toBeNull();
  });

  it('a user with nothing sees neither', async () => {
    const el = await create([]);
    http.expectOne('/api/me/recruitment/summary').flush({ canRequestOpening: false, openings: 0, pendingOpenings: 0 });
    await settle();
    expect(el.querySelector('[data-card="my-recruitment"]')).toBeNull();
    expect(el.querySelector('[data-card="recruitment"]')).toBeNull();
  });

  it('Phase B: interviews in the next 7 days and offers in progress for HR; « Mes entretiens à évaluer (n) » for an interviewer', async () => {
    const el = await create(['recruitment.read']);
    http.expectOne('/api/recruitment/summary').flush(SUMMARY);
    http.expectOne('/api/me/recruitment/summary').flush({ canRequestOpening: false, openings: 0, pendingOpenings: 0, interviews: 2, evaluationsTodo: 1 });
    await settle();
    expect(el.querySelector('[data-count="interviews-next"]')?.textContent).toContain('3');
    const offers = el.querySelector('[data-count="offers-pending"]') as HTMLAnchorElement;
    expect(offers.getAttribute('href')).toBe('/recruitment/candidates?stage=offer');
    expect(offers.textContent).toContain('1');
    const mine = el.querySelector('[data-card="my-interviews"] a') as HTMLAnchorElement;
    expect(mine.getAttribute('href')).toBe('/me/interviews');
    // Two counts: the caller's interviews (2) and the evaluations that can be entered now (1).
    expect(mine.textContent?.trim()).toBe('Mes entretiens (2)');
    expect(el.querySelector('[data-card="my-interviews"] [data-count="evaluations-todo"]')?.textContent?.trim()).toBe('1 évaluation(s) à saisir');
  });
  it('HR sections: presence today, headcount and pending leave, each a link; one small request each', async () => {
    const el = await create(['attendance.read', 'employee.read', 'leave.read']);
    http.expectOne('/api/me/recruitment/summary').flush({ canRequestOpening: false, openings: 0, pendingOpenings: 0, interviews: 0, evaluationsTodo: 0 });
    const presence = http.expectOne((req) => req.url === '/api/attendance/presence');
    expect(presence.request.params.get('pageSize')).toBe('1');
    presence.flush({ date: '2026-10-08', final: false, asOf: '2026-10-08T09:00:00Z', counts: { present: 13, late: 3, absent: 2, incomplete: 0, expected: 1, on_leave: 4, holiday: 0, rest_day: 0, total: 23 }, items: [], total: 23, page: 1, pageSize: 1 });
    http.expectOne((req) => req.url === '/api/employees').flush({ items: [], total: 38, page: 1, pageSize: 1 });
    const leave = http.expectOne((req) => req.url === '/api/leave/requests');
    expect(leave.request.params.get('status')).toBe('pending');
    leave.flush({ items: [], total: 3, page: 1, pageSize: 1 });
    await settle();
    const tile = (card: string, name: string) => el.querySelector(`[data-card="${card}"] [data-count="${name}"]`) as HTMLAnchorElement;
    expect(tile('presence', 'present').textContent).toContain('13');
    expect(tile('presence', 'late').getAttribute('href')).toBe('/attendance?status=late');
    expect(tile('presence', 'on_leave').textContent).toContain('4');
    expect(tile('overview', 'headcount').textContent).toContain('38');
    expect(tile('overview', 'leave-pending').getAttribute('href')).toBe('/leave?status=pending');
    expect(tile('overview', 'leave-pending').textContent).toContain('3');
    expect(el.querySelector('[data-card="recruitment"]')).toBeNull();
  });

  it('a linked employee: open tasks, today’s arrival and departure, the annual leave balance', async () => {
    tasks = [{ id: 't1' }, { id: 't2' }];
    const el = await create(['attendance.punch_self', 'leave.request_self']);
    tasks = [];
    http.expectOne('/api/me/recruitment/summary').flush({ canRequestOpening: false, openings: 0, pendingOpenings: 0, interviews: 0, evaluationsTodo: 0 });
    http.expectOne('/api/me/employment').flush({ employment: { id: 'e1' }, headOf: [] });
    await settle();
    http.expectOne((req) => req.url === '/api/me/attendance/days').flush({ from: '2026-10-08', to: '2026-10-08', items: [{ date: '2026-10-08', status: 'present', arrival: { id: 'p1', occurredAt: '2026-10-08T06:52:00Z', localTime: '07:52' }, departure: null }] });
    http.expectOne((req) => req.url === '/api/me/leave/balances').flush({ items: [{ leaveTypeId: 'a', leaveTypeCode: 'annual', periodStart: '2026-07-01', accrued: 30, taken: 5, adjusted: 0, balance: 25, pending: 0 }] });
    await settle();
    const tile = (name: string) => el.querySelector(`[data-card="mine"] [data-count="${name}"]`) as HTMLAnchorElement;
    expect(tile('tasks').textContent).toContain('2');
    expect(tile('arrival').textContent).toContain('07:52');
    expect(tile('departure').textContent).toContain('–');
    expect(tile('leave-balance').textContent).toContain('25');
    expect(tile('leave-balance').getAttribute('href')).toBe('/me/leave');
    expect(el.querySelector('[data-card="presence"]')).toBeNull();
    expect(el.querySelector('[data-card="overview"]')).toBeNull();
  });

  describe('branding (docs/contracts/branding.md › Dashboard)', () => {
    const NOTHING = { canRequestOpening: false, openings: 0, pendingOpenings: 0 };
    afterEach(() => {
      document.documentElement.removeAttribute('data-brand');
      document.title = '';
    });

    it('nothing set: the built-in title and intro, no logo; the sections are unchanged', async () => {
      const el = await create([]);
      http.expectOne('/api/me/recruitment/summary').flush(NOTHING);
      await settle();
      expect(el.querySelector('h1')?.textContent?.trim()).toBe('Bienvenue');
      expect(el.querySelector('.intro')?.textContent?.trim()).toBe('Choisissez une rubrique dans le menu pour commencer.');
      expect(el.querySelector('[data-brand-logo="company"]')).toBeNull();
      expect(el.querySelector('[data-card="mine"] [data-count="tasks"]')).not.toBeNull();
    });

    it('the welcome title and message of the company, and its logo named by the company', async () => {
      const el = await create([], EFFECTIVE_BRANDED);
      http.expectOne('/api/me/recruitment/summary').flush(NOTHING);
      await settle();
      expect(el.querySelector('h1')?.textContent?.trim()).toBe('Bonjour et bienvenue');
      expect(el.querySelector('.intro')?.textContent).toBe('Retrouvez ici vos tâches, vos congés et votre pointage.');
      const logo = el.querySelector('[data-brand-logo="company"]') as HTMLImageElement;
      expect(logo.getAttribute('src')).toBe(EFFECTIVE_BRANDED.companyLogo?.url);
      expect(logo.getAttribute('alt')).toBe('Groupe Démo');
      expect(logo.getAttribute('width')).toBe('256');
      expect(el.querySelector('[data-card="mine"] [data-count="tasks"]')).not.toBeNull();
    });

    it('a welcome title without a message keeps the built-in intro; markup stays text', async () => {
      const text = { fr: MARKUP, ar: null, en: null };
      const el = await create([], { ...EFFECTIVE_BRANDED, welcomeTitle: text, welcomeMessage: { fr: null, ar: null, en: null }, companyLogo: null });
      http.expectOne('/api/me/recruitment/summary').flush(NOTHING);
      await settle();
      expect(el.querySelector('h1')?.textContent).toBe(MARKUP);
      expect(el.querySelector('.intro')?.textContent?.trim()).toBe('Choisissez une rubrique dans le menu pour commencer.');
      expect(el.querySelector('img')).toBeNull();
      expect(el.querySelector('script')).toBeNull();

      TestBed.inject(Session).set({ ...meWith([]), branding: { ...EFFECTIVE_BRANDED, welcomeMessage: text } });
      await settle();
      expect(el.querySelector('.intro')?.textContent).toBe(MARKUP);
      expect(el.querySelector('img[src="x"]')).toBeNull();
    });
  });
});
