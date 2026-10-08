import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { meWith } from '../../../testing/auth-fixtures';
import { installDialogPolyfill } from '../../../testing/dialog-polyfill';
import { provideUploadsThroughTestingBackend } from '../../../testing/employee-file-fixtures';
import {
  applicationDetail,
  boardCard,
  boardView,
  candidateView,
  comparisonView,
  COMPANY_CRITERIA,
  evaluationView,
  interviewView,
  myInterviewView,
  offerView,
  openingDetail,
  recruitmentProblem,
  UNIT_ANNABA,
} from '../../../testing/recruitment-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { Session } from '../../core/auth/session';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import { LanguageService } from '../../core/i18n/language.service';
import { INTERVIEWER_SEARCH_DEBOUNCE_MS } from './interview-dialog';
import { MY_INTERVIEWS_ROUTES, MY_RECRUITMENT_ROUTES, RECRUITMENT_ROUTES } from './recruitment.routes';

const HR = ['recruitment.read', 'recruitment.manage', 'recruitment.approve_opening', 'recruitment.hire'];
const CENTRAL = [...HR, 'recruitment.erase', 'recruitment.configure', 'recruitment.salary.read', 'recruitment.salary.update', 'employee.read', 'employee.create'];
const MANAGE_ACTIONS = ['move', 'add_note', 'update'] as const;

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    TestBed.tick();
    await new Promise((resolve) => setTimeout(resolve));
  }
}

describe('Recruitment pages (Phase B)', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;
  let router: Router;

  async function start(permissions: readonly string[]): Promise<void> {
    installDialogPolyfill();
    await TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [
        provideRouter(
          [
            { path: 'recruitment', children: RECRUITMENT_ROUTES },
            { path: 'me/recruitment', children: MY_RECRUITMENT_ROUTES },
            { path: 'me/interviews', children: MY_INTERVIEWS_ROUTES },
          ],
          withComponentInputBinding(),
        ),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
        provideUploadsThroughTestingBackend(),
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
    TestBed.inject(Session).set(meWith(permissions));
    harness = await RouterTestingHarness.create();
  }

  afterEach(() => {
    TestBed.inject(LanguageService).use('fr', { remember: false });
    for (const req of http.match('/api/leave/types')) req.flush({ items: [] });
    for (const req of http.match('/api/me/recruitment/summary')) req.flush({ canRequestOpening: false, openings: 0, pendingOpenings: 0, interviews: 1, evaluationsTodo: 0 });
    http.verify();
  });

  const el = () => harness.routeNativeElement as HTMLElement;
  const text = (selector: string) => el().querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const click = (selector: string) => (el().querySelector(selector) as HTMLElement).click();
  const value = (selector: string) => (el().querySelector(selector) as HTMLInputElement).value;

  /** The one request `method url`, once it has been issued (see recruitment.pages.spec.ts). */
  async function one(method: string, url: string): Promise<TestRequest> {
    const wanted = (r: { method: string; url: string }) => r.method === method && r.url === url;
    for (let turn = 0; turn < 200; turn++) {
      const found = http.match(wanted).filter((req) => !req.cancelled);
      if (found.length === 1 && found[0]) return found[0];
      if (found.length > 1) throw new Error(`${found.length} requests for ${method} ${url}, expected one`);
      await settle();
    }
    throw new Error(`No request for ${method} ${url}`);
  }

  function fill(selector: string, text_: string): void {
    const input = el().querySelector(selector) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    input.value = text_;
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input'));
  }

  async function go(url: string): Promise<void> {
    await harness.navigateByUrl(url);
    await settle();
  }

  async function openCandidate(application = applicationDetail(), candidate = candidateView()): Promise<void> {
    await go('/recruitment/candidates/cand-1?application=a-1');
    (await one('GET', '/api/recruitment/candidates/cand-1')).flush(candidate);
    await settle();
    (await one('GET', '/api/recruitment/applications/a-1')).flush(application);
    await settle();
  }

  async function reloaded(application = applicationDetail()): Promise<void> {
    (await one('GET', '/api/recruitment/candidates/cand-1')).flush(candidateView());
    (await one('GET', '/api/recruitment/applications/a-1')).flush(application);
    await settle();
  }

  // --- Settings: evaluation criteria ---

  it('settings: the criteria tab lists, edits and adds criteria; a taken code lands on the field', async () => {
    await start(CENTRAL);
    await go('/recruitment/settings?tab=criteria');
    (await one('GET', '/api/recruitment/criteria')).flush({ items: COMPANY_CRITERIA });
    await settle();
    expect(el().querySelector('[data-tab="criteria"]')?.getAttribute('aria-selected')).toBe('true');
    expect(el().querySelectorAll('[data-table="criteria"] tbody tr').length).toBe(4);
    expect(el().querySelector('[data-criterion="skills"] [data-tag="system"]')).not.toBeNull();

    click('[data-criterion="old_one"] [data-action="edit-criterion"]');
    await settle();
    expect((el().querySelector('#criterion-code') as HTMLInputElement).disabled).toBe(true);
    (el().querySelector('#criterion-active') as HTMLInputElement).click();
    click('[data-action="save-criterion"]');
    await settle();
    const put = await one('PUT', '/api/recruitment/criteria/cr-old');
    expect(put.request.body).toEqual({ labels: { fr: 'Ancien critère', ar: 'معيار قديم', en: 'Old criterion' }, active: true, sortOrder: 40 });
    put.flush(COMPANY_CRITERIA[3] ?? null);
    await settle();
    (await one('GET', '/api/recruitment/criteria')).flush({ items: COMPANY_CRITERIA });
    await settle();

    click('[data-action="new-criterion"]');
    await settle();
    fill('#criterion-code', 'languages');
    fill('#criterion-fr', 'Langues');
    fill('#criterion-ar', 'اللغات');
    fill('#criterion-en', 'Languages');
    click('[data-action="save-criterion"]');
    await settle();
    const post = await one('POST', '/api/recruitment/criteria');
    expect(post.request.body).toEqual({ code: 'languages', labels: { fr: 'Langues', ar: 'اللغات', en: 'Languages' } });
    const taken = recruitmentProblem(409, 'recruitment-criterion-code-taken');
    post.flush(taken.body, taken.options);
    await settle();
    expect(text('#criterion-code-error')).toBe('Ce code est déjà utilisé.');
  });

  // --- Opening: its criteria and the comparison ---

  it('opening details: the criteria in order; « Modifier » reorders, adds among the active ones and saves the ids; locked → the message', async () => {
    await start(HR);
    await go('/recruitment/openings/o-1?tab=details');
    (await one('GET', '/api/recruitment/openings/o-1')).flush(openingDetail({ _actions: ['update', 'close', 'add_application', 'set_criteria'] }));
    await settle();
    expect([...el().querySelectorAll('[data-panel="criteria"] li')].map((li) => li.textContent?.trim())).toEqual(['Compétences techniques', 'Adéquation au poste']);

    click('[data-action="edit-criteria"]');
    await settle();
    (await one('GET', '/api/recruitment/criteria')).flush({ items: COMPANY_CRITERIA });
    await settle();
    // Only active criteria not yet chosen are offered.
    expect([...el().querySelectorAll('[data-add-criterion]')].map((b) => b.getAttribute('data-add-criterion'))).toEqual(['cr-motivation']);
    click('[data-add-criterion="cr-motivation"]');
    await settle();
    click('[data-panel="picked-criteria"] [data-criterion="cr-motivation"] [data-action="criterion-up"]');
    await settle();
    click('[data-panel="picked-criteria"] [data-criterion="cr-skills"] [data-action="criterion-remove"]');
    await settle();
    click('[data-action="save-criteria"]');
    await settle();
    const put = await one('PUT', '/api/recruitment/openings/o-1/criteria');
    expect(put.request.body).toEqual({ criterionIds: ['cr-motivation', 'cr-fit'] });
    const locked = recruitmentProblem(409, 'recruitment-criteria-locked');
    put.flush(locked.body, locked.options);
    await settle();
    expect(text('dialog[open] [data-error="form"]')).toContain('Les critères ne peuvent plus être modifiés');

    // Without the action, no button.
    await go('/recruitment/openings/o-2?tab=details');
    (await one('GET', '/api/recruitment/openings/o-2')).flush(openingDetail({ id: 'o-2' }));
    await settle();
    expect(el().querySelector('[data-action="edit-criteria"]')).toBeNull();
  });

  it('comparison: one row per application with criteria averages, recommendations and evaluations; sortable by average; a row expands to its comments', async () => {
    await start(HR);
    await go('/recruitment/openings/o-1?tab=comparison');
    (await one('GET', '/api/recruitment/openings/o-1')).flush(openingDetail());
    await settle();
    (await one('GET', '/api/recruitment/openings/o-1/comparison')).flush(comparisonView());
    await settle();
    http.expectNone('/api/recruitment/openings/o-1/board');

    const order = () => [...el().querySelectorAll('[data-table="comparison"] [data-row]')].map((tr) => tr.getAttribute('data-row'));
    // Best average first, the application without any score last.
    expect(order()).toEqual(['a-3', 'a-1', 'a-2']);
    const row = el().querySelector('[data-row="a-1"]') as HTMLElement;
    expect(row.querySelector('a')?.getAttribute('href')).toBe('/recruitment/candidates/cand-1?application=a-1');
    expect(row.querySelector('[data-criterion="cr-skills"]')?.textContent?.trim()).toBe('4,5');
    expect(row.querySelector('[data-criterion="cr-skills"]')?.getAttribute('data-label')).toBe('Compétences techniques');
    expect(row.querySelector('[data-field="average"]')?.textContent?.trim()).toBe('3,8');
    expect([...row.querySelectorAll('[data-recommendation]')].map((b) => b.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['Très favorable × 1', 'Favorable × 1']);
    expect(row.querySelector('[data-field="evaluations"]')?.textContent).toContain('2 / 2');
    expect(el().querySelector('[data-row="a-2"] [data-field="average"]')?.textContent?.trim()).toBe('—');
    // Cards on a phone: every cell names its column.
    expect([...row.querySelectorAll('td')].every((td) => td.hasAttribute('data-label'))).toBe(true);

    click('[data-action="sort-average"]');
    await settle();
    expect(order()).toEqual(['a-1', 'a-3', 'a-2']);

    expect(el().querySelector('[data-comments="a-1"]')).toBeNull();
    click('[data-row="a-1"] [data-action="toggle-comments"]');
    await settle();
    expect(text('[data-comments="a-1"]')).toContain('Chef Annaba');
    expect(text('[data-comments="a-1"]')).toContain('Bonne maîtrise du métier.');
    expect(el().querySelector('[data-row="a-2"] [data-action="toggle-comments"]')).toBeNull();
  });

  // --- Candidate page: interviews ---

  it('interviews: evaluations with scores by criterion; scheduling picks interviewers among users and posts the contract body', async () => {
    await start(HR);
    const evaluated = interviewView({
      state: 'awaiting_evaluations',
      average: 4.5,
      evaluations: [
        evaluationView({ submittedAt: '2026-10-06T10:00:00Z', scores: [{ criterionId: 'cr-skills', score: 4 }, { criterionId: 'cr-fit', score: 5 }], overall: 4.5, recommendation: 'yes', comment: 'Solide.' }),
        evaluationView({ interviewer: { id: 'u-karim', displayName: 'Karim Haddad' } }),
      ],
    });
    await openCandidate(applicationDetail({ stage: 'interview', interviews: [evaluated], average: 4.5, _actions: [...MANAGE_ACTIONS, 'schedule_interview'] }));
    // The scores name their criteria from the company list.
    (await one('GET', '/api/recruitment/criteria')).flush({ items: COMPANY_CRITERIA });
    await settle();
    expect(text('[data-field="application-average"]')).toBe('Moyenne 4,5 / 5');
    expect(text('[data-interview="i-1"] [data-field="interview-state"]')).toBe('Évaluations attendues');
    expect(text('[data-evaluation="u-chef"] [data-panel="scores"]')).toBe('Compétences techniques4 / 5Adéquation au poste5 / 5');
    expect(text('[data-evaluation="u-chef"] [data-field="recommendation"]')).toBe('Favorable');
    expect(text('[data-evaluation="u-chef"] [data-field="evaluation-comment"]')).toBe('Solide.');
    expect(text('[data-evaluation="u-karim"] [data-state="evaluation-pending"]')).toBe('Évaluation en attente');

    click('[data-action="schedule-interview"]');
    await settle();
    click('[data-action="save-interview"]');
    await settle();
    http.expectNone((r) => r.method === 'POST');
    expect(text('#iv-interviewers-error')).toBe('Ce champ est obligatoire.');

    fill('#iv-date', '2026-10-12');
    fill('#iv-time', '10:00');
    fill('#iv-location', ' Salle 2 ');
    fill('#iv-search', 'ch');
    await new Promise((resolve) => setTimeout(resolve, INTERVIEWER_SEARCH_DEBOUNCE_MS + 30));
    const search = await one('GET', '/api/recruitment/interviewers');
    expect(search.request.params.get('q')).toBe('ch');
    search.flush({ items: [{ id: 'u-chef', displayName: 'Chef Annaba', employee: { matricule: 'EMP-0007', unit: UNIT_ANNABA } }] });
    await settle();
    expect(text('[data-option="u-chef"]')).toContain('EMP-0007');
    click('[data-option="u-chef"]');
    await settle();
    expect(text('[data-panel="interviewers"] [data-interviewer="u-chef"]')).toContain('Chef Annaba');
    click('[data-action="save-interview"]');
    await settle();
    const post = await one('POST', '/api/recruitment/applications/a-1/interviews');
    expect(post.request.body).toEqual({ date: '2026-10-12', time: '10:00', durationMinutes: 60, mode: 'on_site', location: 'Salle 2', label: null, interviewerIds: ['u-chef'] });
    // The API names the item of the list: the error lands on the picker.
    const self = recruitmentProblem(422, 'validation', [{ field: 'interviewerIds.0', code: 'self' }]);
    post.flush(self.body, self.options);
    await settle();
    expect(text('#iv-interviewers-error')).toBe('Une personne ne peut pas évaluer sa propre candidature.');
    expect(el().querySelector('dialog[open] [data-form="interview"]')).not.toBeNull();
  });

  it('interviews: an edit sends only what changed; cancelling needs a reason; a stale answer reloads the page', async () => {
    await start(HR);
    await openCandidate(applicationDetail({ stage: 'interview', interviews: [interviewView()], _actions: [...MANAGE_ACTIONS, 'schedule_interview'] }));

    click('[data-interview="i-1"] [data-action="edit-interview"]');
    await settle();
    expect(value('#iv-date')).toBe('2026-10-12');
    expect(text('[data-panel="interviewers"] [data-interviewer="u-chef"]')).toContain('Chef Annaba');
    fill('#iv-time', '14:30');
    click('[data-action="save-interview"]');
    await settle();
    const patch = await one('PATCH', '/api/recruitment/interviews/i-1');
    expect(patch.request.body).toEqual({ date: '2026-10-12', time: '14:30' });
    patch.flush(interviewView({ time: '14:30' }));
    await settle();
    expect(text('[data-feedback]')).toBe('Entretien mis à jour pour la candidature de TESTEUR Nadia.');
    await reloaded(applicationDetail({ stage: 'interview', interviews: [interviewView({ time: '14:30' })], _actions: [...MANAGE_ACTIONS] }));

    click('[data-interview="i-1"] [data-action="cancel-interview"]');
    await settle();
    click('[data-action="confirm-cancel-interview"]');
    await settle();
    http.expectNone((r) => r.method === 'POST');
    fill('#iv-cancel-reason', 'Indisponibilité');
    click('[data-action="confirm-cancel-interview"]');
    await settle();
    const cancel = await one('POST', '/api/recruitment/interviews/i-1/cancel');
    expect(cancel.request.body).toEqual({ reason: 'Indisponibilité' });
    const gone = recruitmentProblem(409, 'recruitment-interview-cancelled');
    cancel.flush(gone.body, gone.options);
    await settle();
    expect(el().querySelector('dialog[open]')).toBeNull();
    expect(text('[data-error="action"]')).toBe('Cet entretien a été annulé entre-temps.');
    await reloaded(applicationDetail({ stage: 'interview', interviews: [interviewView({ status: 'cancelled', state: 'cancelled', cancelReason: 'Autre', _actions: [] })] }));
    expect(text('[data-interview="i-1"] [data-field="cancel-reason"]')).toContain('Autre');
    expect(el().querySelector('[data-action="schedule-interview"]')).toBeNull();
  });

  // --- Candidate page: offer, hire link, undo ---

  it('offer: the dialog starts from the opening; central HR enters the proposed salary; no post left → the message; then the offer and « Embaucher »', async () => {
    await start(CENTRAL);
    await openCandidate(applicationDetail({ stage: 'interview', _actions: [...MANAGE_ACTIONS, 'update_salary', 'make_offer'] }));
    expect(el().querySelector('[data-state="no-offer"]')).not.toBeNull();
    click('[data-action="make-offer"]');
    await settle();
    (await one('GET', '/api/recruitment/openings/o-1')).flush(openingDetail());
    await settle();
    expect(value('#offer-title')).toBe('Chargé(e) de clientèle');
    expect([...(el().querySelector('#offer-unit') as HTMLSelectElement).options].map((o) => o.textContent?.trim())).toEqual(['Agence Annaba (AG-ANNABA)']);
    expect(value('#offer-contract')).toBe('cdi');

    click('[data-action="save-offer"]');
    await settle();
    http.expectNone((r) => r.method === 'POST');
    fill('#offer-start', '2026-11-02');
    fill('#offer-salary', '70000,5');
    click('[data-action="save-offer"]');
    await settle();
    const post = await one('POST', '/api/recruitment/applications/a-1/offer');
    expect(post.request.body).toEqual({
      jobTitle: 'Chargé(e) de clientèle',
      orgUnitId: 'u-annaba',
      siteId: null,
      contractType: 'cdi',
      startDate: '2026-11-02',
      note: null,
      proposedSalary: '70000.50',
      expectedStage: 'interview',
    });
    const full = recruitmentProblem(409, 'recruitment-no-post-left');
    post.flush(full.body, full.options);
    await settle();
    expect(text('dialog[open] [data-error="form"]')).toBe('Tous les postes sont pourvus ou font déjà l’objet d’une offre.');

    click('[data-action="save-offer"]');
    await settle();
    const offered = applicationDetail({
      stage: 'offer',
      offer: offerView(),
      salary: { expected: '65000.00', proposed: '70000.50' },
      moveTargets: ['rejected'],
      _actions: [...MANAGE_ACTIONS, 'update_salary', 'update_offer', 'decline_offer', 'cancel_offer', 'hire'],
    });
    (await one('POST', '/api/recruitment/applications/a-1/offer')).flush(offered, { status: 201, statusText: 'Created' });
    await settle();
    expect(text('[data-feedback]')).toBe('Offre enregistrée pour la candidature de TESTEUR Nadia.');
    await reloaded(offered);
    expect(text('[data-field="offer-status"]')).toBe('Proposée');
    expect(text('[data-field="proposed-salary"]')).toContain('70');
    expect(el().querySelector('[data-action="hire"]')?.getAttribute('href')).toBe('/recruitment/applications/a-1/hire?candidate=cand-1');

    // « Offre déclinée »: the stage on screen goes with it; a stale card reloads the page.
    click('[data-action="decline-offer"]');
    await settle();
    fill('#end-offer-comment', 'A accepté un autre poste');
    click('[data-action="confirm-end-offer"]');
    await settle();
    const decline = await one('POST', '/api/recruitment/applications/a-1/offer/decline');
    expect(decline.request.body).toEqual({ expectedStage: 'offer', comment: 'A accepté un autre poste' });
    const changed = recruitmentProblem(409, 'recruitment-stage-changed');
    decline.flush(changed.body, changed.options);
    await settle();
    expect(text('[data-error="action"]')).toBe('Cette candidature a été modifiée entre-temps. Veuillez actualiser.');
    await reloaded(offered);

    click('[data-action="cancel-offer"]');
    await settle();
    click('[data-action="confirm-end-offer"]');
    await settle();
    const cancel = await one('POST', '/api/recruitment/applications/a-1/offer/cancel');
    expect(cancel.request.body).toEqual({ expectedStage: 'offer' });
    cancel.flush(applicationDetail({ stage: 'interview', offer: offerView({ status: 'cancelled' }) }));
    await settle();
    expect(text('[data-feedback]')).toContain('Offre annulée');
    await reloaded(applicationDetail({ stage: 'interview', offer: offerView({ status: 'cancelled' }) }));
  });

  it('offer: regional HR sees « Salaire masqué », is not offered the salary field and never sends it; no hire link without employee.create', async () => {
    await start(HR);
    const offered = applicationDetail({ stage: 'offer', offer: offerView({ note: 'Début au guichet' }), _redacted: ['salary'], _actions: [...MANAGE_ACTIONS, 'update_offer', 'hire'] });
    Reflect.deleteProperty(offered, 'salary');
    await openCandidate(offered);
    expect(text('[data-field="proposed-salary"] [data-state="redacted"]')).toBe('Salaire masqué');
    expect(el().querySelector('[data-action="hire"]')).toBeNull();
    expect(el().querySelector('[data-state="hire-needs-create"]')).not.toBeNull();

    click('[data-action="edit-offer"]');
    await settle();
    (await one('GET', '/api/recruitment/openings/o-1')).flush(openingDetail());
    await settle();
    expect(el().querySelector('#offer-salary')).toBeNull();
    expect(value('#offer-start')).toBe('2026-11-02');
    fill('#offer-start', '2026-12-01');
    click('[data-action="save-offer"]');
    await settle();
    const put = await one('PUT', '/api/recruitment/applications/a-1/offer');
    expect(put.request.body).toEqual({ jobTitle: 'Chargé(e) de clientèle', orgUnitId: 'u-annaba', siteId: null, contractType: 'cdi', startDate: '2026-12-01', note: 'Début au guichet' });
    put.flush(offered);
    await settle();
    await reloaded(offered);
  });

  it('after the hire: a link to the employee; « Annuler l’embauche » needs a reason and says when the employment is still open', async () => {
    await start(CENTRAL);
    const hired = applicationDetail({
      stage: 'hired',
      decidedAt: '2026-10-08T10:00:00Z',
      offer: offerView({ status: 'accepted', decidedAt: '2026-10-08T10:00:00Z' }),
      employment: { id: 'e-100', matricule: 'EMP-0100' },
      moveTargets: [],
      _actions: ['add_note', 'update', 'undo_hire'],
    });
    await openCandidate(hired);
    expect(el().querySelector('[data-action="open-employee"]')?.getAttribute('href')).toBe('/employees/e-100');
    expect(text('[data-action="open-employee"]')).toContain('EMP-0100');
    expect(el().querySelector('[data-action="hire"]')).toBeNull();

    click('[data-action="undo-hire"]');
    await settle();
    expect(text('dialog[open]')).toContain('L’emploi doit d’abord être clôturé sur la fiche employé');
    click('[data-action="confirm-undo-hire"]');
    await settle();
    http.expectNone((r) => r.method === 'POST');
    fill('#undo-reason', 'Ne s’est jamais présenté');
    click('[data-action="confirm-undo-hire"]');
    await settle();
    const undo = await one('POST', '/api/recruitment/applications/a-1/undo-hire');
    expect(undo.request.body).toEqual({ reason: 'Ne s’est jamais présenté' });
    const open = recruitmentProblem(409, 'recruitment-employment-open');
    undo.flush(open.body, open.options);
    await settle();
    expect(text('dialog[open] [data-error="form"]')).toContain('clôturez-le d’abord sur la fiche employé');

    click('[data-action="confirm-undo-hire"]');
    await settle();
    (await one('POST', '/api/recruitment/applications/a-1/undo-hire')).flush(applicationDetail({ stage: 'offer', offer: offerView() }));
    await settle();
    expect(text('[data-feedback]')).toContain('Embauche annulée');
    await reloaded(applicationDetail({ stage: 'offer', offer: offerView() }));
  });

  // --- Board ---

  it('board: cards show the next interview, the average and the evaluations awaited; the menu opens the interview and offer dialogs; « Embaucher » on an offer', async () => {
    await start([...HR, 'employee.create']);
    await go('/recruitment/openings/o-1');
    (await one('GET', '/api/recruitment/openings/o-1')).flush(openingDetail());
    await settle();
    (await one('GET', '/api/recruitment/openings/o-1/board')).flush(
      boardView([
        boardCard({ stage: 'interview', nextInterviewAt: '2026-10-12T09:00:00Z', average: 4.5, pendingEvaluations: 1, moveTargets: ['received', 'shortlisted', 'rejected', 'withdrawn'], _actions: ['move', 'schedule_interview', 'make_offer'] }),
        boardCard({ id: 'a-2', candidate: { id: 'cand-2', lastName: 'AUTRE', firstName: 'Test', lastNameAr: null, firstNameAr: null }, stage: 'offer', moveTargets: ['rejected'], _actions: ['move', 'hire'] }),
        // Under offer too, but the API does not offer the hire to this caller for this card.
        boardCard({ id: 'a-3', candidate: { id: 'cand-3', lastName: 'TIERS', firstName: 'Test', lastNameAr: null, firstNameAr: null }, stage: 'offer', moveTargets: ['rejected'], _actions: ['move'] }),
      ]),
    );
    await settle();
    const card = el().querySelector('[data-card="a-1"]') as HTMLElement;
    expect(card.querySelector('[data-field="next-interview"]')?.textContent).toContain('Entretien le');
    expect(card.querySelector('[data-field="average"]')?.textContent?.trim()).toBe('Moyenne 4,5 / 5');
    expect(card.querySelector('[data-field="pending-evaluations"]')?.textContent?.trim()).toBe('1 évaluation(s) attendue(s)');
    expect(el().querySelector('[data-card="a-2"]')?.closest('[data-stage]')?.getAttribute('data-stage')).toBe('offer');
    expect(el().querySelector('[data-card="a-2"] [data-action="hire"]')?.getAttribute('href')).toBe('/recruitment/applications/a-2/hire?candidate=cand-2');
    expect(card.querySelector('[data-action="hire"]')).toBeNull();
    expect(el().querySelector('[data-card="a-3"] [data-action="hire"]')).toBeNull();
    expect(el().querySelector('[data-card="a-2"] [data-panel="interview-facts"]')).toBeNull();

    (card.querySelector('[data-action="move"]') as HTMLElement).click();
    await settle();
    expect([...card.querySelectorAll('[data-extra]')].map((b) => b.textContent?.trim())).toEqual(['Planifier un entretien', 'Proposer une offre']);
    (card.querySelector('[data-extra="make_offer"]') as HTMLElement).click();
    await settle();
    // The board already holds the opening: nothing is fetched.
    http.expectNone('/api/recruitment/openings/o-1');
    expect(value('#offer-title')).toBe('Chargé(e) de clientèle');
    fill('#offer-start', '2026-11-02');
    click('[data-action="save-offer"]');
    await settle();
    const post = await one('POST', '/api/recruitment/applications/a-1/offer');
    expect(post.request.body).toMatchObject({ expectedStage: 'interview', orgUnitId: 'u-annaba' });
    expect(post.request.body).not.toHaveProperty('proposedSalary');
    post.flush(applicationDetail({ stage: 'offer', offer: offerView() }), { status: 201, statusText: 'Created' });
    await settle();
    expect(text('[data-feedback]')).toBe('Offre enregistrée pour la candidature de TESTEUR Nadia.');
    (await one('GET', '/api/recruitment/openings/o-1/board')).flush(boardView([boardCard({ stage: 'offer', moveTargets: ['rejected'] })]));
    (await one('GET', '/api/recruitment/openings/o-1')).flush(openingDetail());
    await settle();

    // A card whose menu only holds a dialog entry still gets the button.
    expect(el().querySelector('[data-card="a-1"] [data-action="move"]')).not.toBeNull();
  });

  // --- Mes entretiens ---

  it('my interviews: no permission needed; « À évaluer » by default, « Évalués » in the URL', async () => {
    await start([]);
    await go('/me/interviews');
    const todo = await one('GET', '/api/me/recruitment/interviews');
    expect(todo.request.params.get('filter')).toBe('todo');
    todo.flush({ items: [myInterviewView()] });
    await settle();
    expect(el().querySelector('[data-interview="i-1"] a')?.getAttribute('href')).toBe('/me/interviews/i-1');
    expect(text('[data-interview="i-1"]')).toContain('TESTEUR Nadia');
    expect(text('[data-interview="i-1"]')).toContain('REC-2026-0001');
    expect(text('[data-interview="i-1"] [data-state="todo"]')).toBe('Évaluation à saisir');

    click('[data-tab="done"]');
    await settle();
    expect(router.url).toBe('/me/interviews?filter=done');
    const done = await one('GET', '/api/me/recruitment/interviews');
    expect(done.request.params.get('filter')).toBe('done');
    done.flush({ items: [] });
    await settle();
    expect(text('[data-state="no-interviews"]')).toBe('Aucun entretien évalué.');
  });

  it('evaluation: the restricted view; every criterion and the recommendation are required; the scores are sent and the saved state is clear', async () => {
    await start([]);
    await go('/me/interviews/i-1');
    (await one('GET', '/api/me/recruitment/interviews/i-1')).flush(myInterviewView());
    await settle();
    expect(text('h1')).toBe('TESTEUR Nadia');
    expect(text('[data-panel="interview"]')).toContain('REC-2026-0001');
    // Nothing else about the candidate, nothing from HR.
    for (const selector of ['[data-field="nin"]', '[data-field="email"]', '[data-panel="notes"]', '[data-panel="stages"]', 'app-stage-menu']) expect(el().querySelector(selector)).toBeNull();
    expect(el().querySelector('[data-section="files"] [data-action="download-file"]')).not.toBeNull();
    const radios = (criterion: string) => [...el().querySelectorAll<HTMLInputElement>(`[data-criterion="${criterion}"] input[type="radio"]`)];
    expect(radios('cr-skills').length).toBe(5);
    expect(text('[data-criterion="cr-skills"] .choice')).toBe('1 — Insuffisant');
    expect(el().querySelector('[data-state="submitted"]')).toBeNull();

    click('[data-action="submit-evaluation"]');
    await settle();
    http.expectNone((r) => r.method === 'PUT');
    expect(text('[data-error="form"]')).toBe('Notez chaque critère et donnez votre avis avant d’enregistrer.');
    expect(el().querySelectorAll('.criterion.missing').length).toBe(3);

    radios('cr-skills')[3]?.click();
    radios('cr-fit')[4]?.click();
    // The four recommendations in order: « Favorable » is the second.
    el().querySelectorAll<HTMLInputElement>('[data-field="recommendation"] input[type="radio"]')[1]?.click();
    fill('#evaluation-comment', ' Très bon échange. ');
    await settle();
    click('[data-action="submit-evaluation"]');
    await settle();
    const put = await one('PUT', '/api/me/recruitment/interviews/i-1/evaluation');
    expect(put.request.body).toEqual({
      scores: [
        { criterionId: 'cr-skills', score: 4 },
        { criterionId: 'cr-fit', score: 5 },
      ],
      recommendation: 'yes',
      comment: 'Très bon échange.',
    });
    const submitted = myInterviewView({
      evaluation: { submittedAt: '2026-10-08T11:00:00Z', scores: [{ criterionId: 'cr-skills', score: 4 }, { criterionId: 'cr-fit', score: 5 }], overall: 4.5, recommendation: 'yes', comment: 'Très bon échange.' },
    });
    put.flush(submitted);
    await settle();
    (await one('GET', '/api/me/recruitment/interviews/i-1')).flush(submitted);
    await settle();
    // The nav count of evaluations to enter is refreshed.
    expect(http.match('/api/me/recruitment/summary').length).toBeGreaterThan(0);
    expect(text('[data-state="submitted"]')).toContain('Évaluation enregistrée le');
    expect(text('[data-state="submitted"] [data-field="overall"]')).toBe('Moyenne 4,5 / 5');
    expect(radios('cr-skills')[3]?.checked).toBe(true);
    expect(text('[data-action="submit-evaluation"]')).toBe('Mettre à jour l’évaluation');

    // Closed meanwhile: the message, and the page reloads to its read-only state.
    click('[data-action="submit-evaluation"]');
    await settle();
    const closed = recruitmentProblem(409, 'recruitment-evaluation-closed');
    (await one('PUT', '/api/me/recruitment/interviews/i-1/evaluation')).flush(closed.body, closed.options);
    await settle();
    expect(text('[data-error="form"]')).toContain('L’évaluation est close');
    (await one('GET', '/api/me/recruitment/interviews/i-1')).flush({ ...submitted, _actions: [] });
    await settle();
    expect(text('[data-state="locked"]')).toContain('n’est plus modifiable');
    expect(el().querySelector('[data-action="submit-evaluation"]')).toBeNull();
    expect(radios('cr-skills').every((r) => r.disabled)).toBe(true);
  });

  it('evaluation: before the interview time the form is read-only and says why; a 404 says the interview is no longer available', async () => {
    await start([]);
    await go('/me/interviews/i-1');
    (await one('GET', '/api/me/recruitment/interviews/i-1')).flush(myInterviewView({ scheduledAt: '2099-01-01T09:00:00Z', date: '2099-01-01', _actions: [] }));
    await settle();
    expect(text('[data-state="locked"]')).toBe('L’évaluation pourra être saisie une fois l’entretien commencé.');
    expect(el().querySelector('[data-action="submit-evaluation"]')).toBeNull();
    expect((el().querySelector('#evaluation-comment') as HTMLTextAreaElement).disabled).toBe(true);

    await go('/me/interviews/i-2');
    const gone = recruitmentProblem(404, null);
    (await one('GET', '/api/me/recruitment/interviews/i-2')).flush(gone.body, gone.options);
    await settle();
    expect(text('[role="alert"]')).toContain('Cet entretien n’est plus disponible');
  });
});
