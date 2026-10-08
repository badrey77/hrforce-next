import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { NavigationEnd, provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { meWith } from '../../../testing/auth-fixtures';
import { installDialogPolyfill } from '../../../testing/dialog-polyfill';
import { fakeFile, provideUploadsThroughTestingBackend } from '../../../testing/employee-file-fixtures';
import {
  applicationDetail,
  boardCard,
  boardView,
  candidateFile,
  candidateView,
  CANDIDATE_NAME,
  comparisonView,
  KNOWN_PERSON,
  myOpeningDetail,
  OPENING_PROGRESS,
  OPENING_REF,
  openingDetail,
  openingView,
  REASONS,
  recruitmentProblem,
  SUMMARY,
} from '../../../testing/recruitment-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { Session } from '../../core/auth/session';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import { LanguageService } from '../../core/i18n/language.service';
import { MY_RECRUITMENT_ROUTES, RECRUITMENT_ROUTES } from './recruitment.routes';

const HR = ['recruitment.read', 'recruitment.manage', 'recruitment.approve_opening'];
const CENTRAL = [...HR, 'recruitment.erase', 'recruitment.configure', 'recruitment.salary.read', 'recruitment.salary.update'];

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    TestBed.tick();
    await new Promise((resolve) => setTimeout(resolve));
  }
}

describe('Recruitment pages (Phase A)', () => {
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
    // Root stores some pages touch (step labels, the personal summary): not what these tests are about.
    for (const req of http.match('/api/leave/types')) req.flush({ items: [] });
    for (const req of http.match('/api/me/recruitment/summary')) req.flush({ canRequestOpening: true, openings: 0, pendingOpenings: 0 });
    http.verify();
  });

  const el = () => harness.routeNativeElement as HTMLElement;
  const text = (selector: string) => el().querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const click = (selector: string) => (el().querySelector(selector) as HTMLElement).click();
  /**
   * The one request `method url`, once it has been issued. A request is sent by an `httpResource` only after its
   * component exists and its effects ran — after a navigation to a lazy route that is an unknown number of turns
   * (the page's `import()`), so the helper waits for the request itself instead of assuming a number of turns.
   */
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

  /** Resolves when the navigation started by the next action has ended (its lazy page is then loaded). */
  function nextNavigation(): Promise<void> {
    return new Promise((resolve) => {
      const subscription = router.events.subscribe((event) => {
        if (event instanceof NavigationEnd) {
          subscription.unsubscribe();
          resolve();
        }
      });
    });
  }

  function fill(selector: string, value: string): void {
    const input = el().querySelector(selector) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    input.value = value;
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input'));
  }

  async function go(url: string): Promise<void> {
    await harness.navigateByUrl(url);
    await settle();
  }

  // --- Routes ---

  it('refuses the HR screens without recruitment.read, and settings without recruitment.configure', async () => {
    await start(['recruitment.read']);
    await go('/recruitment/settings');
    expect(el().querySelector('app-recruitment-settings-page')).toBeNull();
    http.expectNone('/api/recruitment/rejection-reasons');
  });

  // --- Openings list ---

  it('openings list: active by default, status chips with counts write the URL, rows show hired/posts and candidates in progress', async () => {
    await start(HR);
    await go('/recruitment');
    const first = await one('GET', '/api/recruitment/openings');
    expect(first.request.params.get('status')).toBe('active');
    first.flush({ items: [openingView()], total: 1, page: 1, pageSize: 25 });
    (await one('GET', '/api/recruitment/summary')).flush(SUMMARY);
    await settle();

    const row = el().querySelector('[data-opening="o-1"]') as HTMLElement;
    expect(row.querySelector('a')?.getAttribute('href')).toBe('/recruitment/openings/o-1');
    expect(row.querySelector('[data-field="posts"]')?.textContent).toContain('0 / 2');
    expect(row.querySelector('[data-field="in-progress"]')?.textContent?.trim()).toBe('5');
    expect([...row.querySelectorAll('td')].every((td) => td.hasAttribute('data-label'))).toBe(true);
    expect(text('[data-chip="active"]')).toBe('En cours (3)');
    expect(text('[data-chip="all"]')).toBe('Tous (6)');
    expect(el().querySelector('[data-chip="active"]')?.getAttribute('aria-pressed')).toBe('true');

    click('[data-chip="closed"]');
    await settle();
    expect(router.url).toBe('/recruitment?status=closed');
    const closed = await one('GET', '/api/recruitment/openings');
    expect(closed.request.params.get('status')).toBe('closed');
    closed.flush({ items: [], total: 0, page: 1, pageSize: 25 });
    await settle();
    expect(el().querySelector('[data-state="no-match"]')).not.toBeNull();

    click('[data-action="clear"]');
    await settle();
    expect(router.url).toBe('/recruitment');
    (await one('GET', '/api/recruitment/openings')).flush({ items: [], total: 0, page: 1, pageSize: 25 });
  });

  // --- Request form (a unit head, no permission) ---

  it('request form for a head: the units they head and their sub-units, 403 forbidden-scope lands on the unit, 422 past on the date, then the request is sent', async () => {
    await start([]);
    await go('/me/recruitment/new');
    // The API lists them (a head may not read the org tree): no employment or tree request.
    (await one('GET', '/api/me/recruitment/units')).flush({
      items: [
        { id: 'u-annaba', code: 'AG-ANNABA', kind: 'agency', name: 'Agence Annaba', nameAr: 'وكالة عنابة', site: null, parentId: null, depth: 0 },
        { id: 'u-cli', code: 'SRV-CLI-ANB', kind: 'service', name: 'Service clientèle', nameAr: null, site: null, parentId: 'u-annaba', depth: 1 },
      ],
    });
    await settle();
    http.expectNone('/api/me/employment');
    http.expectNone((r) => r.url === '/api/org/tree');
    const unit = el().querySelector('#open-unit') as HTMLSelectElement;
    expect([...unit.options].map((o) => o.textContent?.trim())).toEqual(['Choisir une unité', 'Agence Annaba (AG-ANNABA)', '— Service clientèle (SRV-CLI-ANB)']);
    expect(text('#open-justification-hint')).toBe('Décrivez le besoin, sans nommer de personne.');

    // Nothing is sent while the form is invalid.
    click('[data-action="submit-request"]');
    await settle();
    expect(el().querySelectorAll('.field-error').length).toBeGreaterThan(0);

    fill('#open-title', "Agent d'accueil");
    unit.value = unit.options[1]?.value ?? '';
    unit.dispatchEvent(new Event('change'));
    fill('#open-target', '2099-01-15');
    fill('#open-justification', 'Remplacement.');
    click('[data-action="submit-request"]');
    await settle();
    const post = await one('POST', '/api/recruitment/openings');
    expect(post.request.body).toEqual({
      title: "Agent d'accueil",
      orgUnitId: 'u-annaba',
      siteId: null,
      contractType: 'cdi',
      posts: 1,
      justification: 'Remplacement.',
      targetDate: '2099-01-15',
    });
    const forbidden = recruitmentProblem(403, 'forbidden-scope', [{ field: 'orgUnitId', code: 'forbidden_scope' }]);
    post.flush(forbidden.body, forbidden.options);
    await settle();
    expect(text('#open-unit-error')).toBe('Vous ne pouvez pas demander une ouverture de poste pour cette unité.');

    // A server error stays on its field until the value changes.
    unit.dispatchEvent(new Event('change'));
    click('[data-action="submit-request"]');
    await settle();
    const past = recruitmentProblem(422, 'validation', [{ field: 'targetDate', code: 'past' }]);
    (await one('POST', '/api/recruitment/openings')).flush(past.body, past.options);
    await settle();
    expect(text('#open-target-error')).toBe('La date ne peut pas être dans le passé.');

    fill('#open-target', '2099-02-01');
    click('[data-action="submit-request"]');
    await settle();
    const created = nextNavigation();
    (await one('POST', '/api/recruitment/openings')).flush(openingDetail({ id: 'o-9', status: 'pending' }), { status: 201, statusText: 'Created' });
    await created;
    await settle();
    expect(router.url).toBe('/me/recruitment/openings/o-9?created=1');
    // The nav entry depends on the summary: fetched again after a request.
    expect(http.match('/api/me/recruitment/summary').length).toBeGreaterThan(0);
    (await one('GET', '/api/me/recruitment/openings/o-9')).flush(myOpeningDetail({ id: 'o-9', status: 'pending', workflow: OPENING_PROGRESS, roles: ['requester'], counts: null, applications: null, _actions: ['cancel'] }));
    await settle();
    expect(text('[data-feedback="created"]')).toContain('Demande envoyée');
    expect(el().querySelector('[data-section="applications"]')).toBeNull();
  });

  // --- Opening detail and the board ---

  async function openBoard(cards = [boardCard()]): Promise<void> {
    await go('/recruitment/openings/o-1');
    (await one('GET', '/api/recruitment/openings/o-1')).flush(openingDetail());
    await settle();
    const board = await one('GET', '/api/recruitment/openings/o-1/board');
    expect(board.request.params.has('includeFinal')).toBe(false);
    board.flush(boardView(cards, { purged: 3 }));
    await settle();
  }

  it('board: a card names the candidate, time in stage, source, CV, notes; « Déplacer vers… » posts the move with the stage on screen', async () => {
    await start(HR);
    await openBoard([boardCard(), boardCard({ id: 'a-2', candidate: { id: 'cand-2', lastName: 'ANCIEN', firstName: 'Test', lastNameAr: null, firstNameAr: null }, stage: 'interview', formerEmployee: true, moveTargets: ['received', 'shortlisted', 'rejected', 'withdrawn'] })]);

    expect(el().querySelector('[data-tab="pipeline"]')?.getAttribute('aria-selected')).toBe('true');
    const card = el().querySelector('[data-card="a-1"]') as HTMLElement;
    expect(card.closest('[data-stage]')?.getAttribute('data-stage')).toBe('received');
    expect(card.querySelector('a')?.getAttribute('href')).toBe('/recruitment/candidates/cand-1?application=a-1');
    expect(card.textContent).toContain('TESTEUR Nadia');
    expect(card.textContent).toContain('ANEM');
    expect(card.querySelector('[data-tag="cv"]')).not.toBeNull();
    expect(card.querySelector('[data-tag="notes"]')?.textContent).toContain('2 note(s)');
    expect(card.querySelector('[data-field="since"]')?.textContent).toContain('depuis');
    expect(el().querySelector('[data-card="a-2"] [data-tag="former"]')?.textContent).toContain('Déjà employé(e)');
    expect(text('[data-field="purged"]')).toBe('3 candidature(s) anonymisée(s)');

    // The move is a button first: a disclosure listing the stages the API accepts.
    const toggle = card.querySelector('[data-action="move"]') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    toggle.click();
    await settle();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect([...card.querySelectorAll('[data-target]')].map((b) => b.getAttribute('data-target'))).toEqual(['shortlisted', 'interview', 'rejected', 'withdrawn']);
    (card.querySelector('[data-target="interview"]') as HTMLElement).click();
    await settle();
    const move = await one('POST', '/api/recruitment/applications/a-1/move');
    expect(move.request.body).toEqual({ toStage: 'interview', expectedStage: 'received' });
    move.flush(applicationDetail({ stage: 'interview' }));
    await settle();
    expect(text('[data-feedback]')).toBe('Candidature de TESTEUR Nadia : étape « Entretien ».');
    // The board and the header counts are both refreshed.
    (await one('GET', '/api/recruitment/openings/o-1/board')).flush(boardView([boardCard({ stage: 'interview' })]));
    (await one('GET', '/api/recruitment/openings/o-1')).flush(openingDetail());
    await settle();
    expect(el().querySelector('[data-card="a-1"]')?.closest('[data-stage]')?.getAttribute('data-stage')).toBe('interview');
  });

  it('board: 409 recruitment-stage-changed shows the contract wording and reloads the board', async () => {
    await start(HR);
    await openBoard();
    click('[data-card="a-1"] [data-action="move"]');
    await settle();
    click('[data-card="a-1"] [data-target="shortlisted"]');
    await settle();
    const changed = recruitmentProblem(409, 'recruitment-stage-changed');
    (await one('POST', '/api/recruitment/applications/a-1/move')).flush(changed.body, changed.options);
    await settle();
    expect(text('[data-feedback]')).toBe('Cette candidature a été modifiée entre-temps. Veuillez actualiser.');
    (await one('GET', '/api/recruitment/openings/o-1/board')).flush(boardView([boardCard({ stage: 'interview' })]));
    (await one('GET', '/api/recruitment/openings/o-1')).flush(openingDetail());
    await settle();
    expect(el().querySelector('[data-card="a-1"]')?.closest('[data-stage]')?.getAttribute('data-stage')).toBe('interview');
  });

  it('board: « Refus » asks for a reason (active, not automatic) before anything is sent', async () => {
    await start(HR);
    await openBoard();
    click('[data-card="a-1"] [data-action="move"]');
    await settle();
    click('[data-card="a-1"] [data-target="rejected"]');
    await settle();
    (await one('GET', '/api/recruitment/rejection-reasons')).flush({ items: REASONS });
    await settle();
    const dialog = el().querySelector('dialog[open]') as HTMLElement;
    const options = [...dialog.querySelectorAll('#move-reason option')].map((o) => o.textContent?.trim());
    expect(options).toEqual(['Choisir un motif', 'Expérience insuffisante']);

    (dialog.querySelector('[data-action="confirm-move"]') as HTMLElement).click();
    await settle();
    http.expectNone('/api/recruitment/applications/a-1/move');
    expect(dialog.querySelector('#move-reason-error')?.textContent).toContain('obligatoire');

    fill('#move-reason', 'r-exp');
    fill('#move-comment', ' Profil junior ');
    (dialog.querySelector('[data-action="confirm-move"]') as HTMLElement).click();
    await settle();
    const reject = await one('POST', '/api/recruitment/applications/a-1/move');
    expect(reject.request.body).toEqual({ toStage: 'rejected', expectedStage: 'received', rejectionReasonId: 'r-exp', comment: 'Profil junior' });
    reject.flush(applicationDetail({ stage: 'rejected' }));
    await settle();
    expect(el().querySelector('dialog[open]')).toBeNull();
    expect(text('[data-feedback]')).toBe('Candidature de TESTEUR Nadia refusée.');
    (await one('GET', '/api/recruitment/openings/o-1/board')).flush(boardView([]));
    (await one('GET', '/api/recruitment/openings/o-1')).flush(openingDetail());
  });

  it('board: « Terminées » loads the final stages on demand; a rejected card can only be reopened', async () => {
    await start(HR);
    await openBoard();
    expect(el().querySelector('[data-group="final"]')).toBeNull();
    click('[data-action="toggle-final"]');
    await settle();
    const withFinal = await one('GET', '/api/recruitment/openings/o-1/board');
    expect(withFinal.request.params.get('includeFinal')).toBe('true');
    withFinal.flush(boardView([boardCard(), boardCard({ id: 'a-3', stage: 'rejected', moveTargets: [], _actions: ['reopen'], rejectionReason: { code: 'experience', labels: REASONS[0]?.labels ?? { fr: '', ar: '', en: '' } } })]));
    await settle();
    const rejected = el().querySelector('[data-group="final"] [data-card="a-3"]') as HTMLElement;
    expect(rejected.querySelector('[data-field="reason"]')?.textContent).toContain('Expérience insuffisante');
    expect(rejected.querySelector('[data-action="move"]')).toBeNull();
    (rejected.querySelector('[data-action="reopen-application"]') as HTMLElement).click();
    await settle();
    const reopen = await one('POST', '/api/recruitment/applications/a-3/reopen');
    expect(reopen.request.body).toEqual({ expectedStage: 'rejected' });
    reopen.flush(applicationDetail({ id: 'a-3' }));
    await settle();
    (await one('GET', '/api/recruitment/openings/o-1/board')).flush(boardView([]));
    (await one('GET', '/api/recruitment/openings/o-1')).flush(openingDetail());
  });

  it('opening detail: a pending request shows the stepper and no pipeline; actions come from _actions', async () => {
    await start(HR);
    await go('/recruitment/openings/o-2');
    (await one('GET', '/api/recruitment/openings/o-2')).flush(openingDetail({ id: 'o-2', status: 'pending', workflow: OPENING_PROGRESS, openedAt: null, _actions: [] }));
    await settle();
    expect(el().querySelector('app-workflow-stepper')).not.toBeNull();
    expect(el().querySelector('[data-tab="pipeline"]')).toBeNull();
    expect(el().querySelector('[data-tab="details"]')?.getAttribute('aria-selected')).toBe('true');
    expect(text('[data-field="justification"]')).toBe('Renfort du guichet.');
    for (const action of ['edit', 'close', 'reopen']) expect(el().querySelector(`.page-actions [data-action="${action}"]`)).toBeNull();
    http.expectNone('/api/recruitment/openings/o-2/board');
  });

  it('opening detail: edit sends only what changed (posts can only go down); close needs a reason', async () => {
    await start([...HR, 'site.read']);
    await openBoard();
    click('.page-actions [data-action="edit"]');
    await settle();
    (await one('GET', '/api/org/sites')).flush({ items: [{ id: 's-annaba', code: 'ANB', name: 'Annaba centre', wilaya: '23', address: null }] });
    await settle();
    const posts = el().querySelector('#edit-posts') as HTMLInputElement;
    expect(posts.max).toBe('2');
    fill('#edit-posts', '3');
    click('[data-action="save-opening"]');
    await settle();
    http.expectNone((r) => r.method === 'PATCH');
    fill('#edit-posts', '1');
    fill('#edit-anem', 'ANEM-42');
    click('[data-action="save-opening"]');
    await settle();
    const patch = await one('PATCH', '/api/recruitment/openings/o-1');
    expect(patch.request.body).toEqual({ anemReference: 'ANEM-42', posts: 1 });
    const below = recruitmentProblem(422, 'validation', [{ field: 'posts', code: 'below_hired' }]);
    patch.flush(below.body, below.options);
    await settle();
    expect(text('#edit-posts-error')).toContain('inférieur aux embauches');
    (el().querySelector('dialog[open] .btn.secondary') as HTMLElement).click();
    await settle();

    click('.page-actions [data-action="close"]');
    await settle();
    click('[data-action="confirm-close"]');
    await settle();
    http.expectNone('/api/recruitment/openings/o-1/close');
    fill('#close-reason', 'Budget reporté');
    click('[data-action="confirm-close"]');
    await settle();
    const close = await one('POST', '/api/recruitment/openings/o-1/close');
    expect(close.request.body).toEqual({ reason: 'Budget reporté' });
    close.flush(openingDetail({ status: 'closed' }));
    await settle();
    expect(text('[data-feedback]')).toBe('Recrutement clôturé.');
    (await one('GET', '/api/recruitment/openings/o-1')).flush(openingDetail({ status: 'closed', _actions: ['reopen'], closed: { at: '2026-10-07T10:00:00Z', by: null, reason: 'Budget reporté' } }));
    (await one('GET', '/api/recruitment/openings/o-1/board')).flush(boardView([]));
    await settle();

    // Reopen: the confirmation names how many applications come back.
    click('.page-actions [data-action="reopen"]');
    await settle();
    const closedReason = { code: 'opening_closed', labels: { fr: 'Recrutement clôturé', ar: 'x', en: 'x' } };
    const count = await one('GET', '/api/recruitment/openings/o-1/board');
    expect(count.request.params.get('includeFinal')).toBe('true');
    count.flush(boardView([boardCard({ stage: 'rejected', rejectionReason: closedReason }), boardCard({ id: 'a-2', stage: 'rejected', rejectionReason: closedReason })]));
    await settle();
    expect(text('[data-field="restorable"]')).toContain('2 candidature(s)');
    click('[data-action="confirm-reopen"]');
    await settle();
    (await one('POST', '/api/recruitment/openings/o-1/reopen')).flush(openingDetail());
    await settle();
    expect(text('[data-feedback]')).toBe('Recrutement rouvert.');
    (await one('GET', '/api/recruitment/openings/o-1')).flush(openingDetail());
    (await one('GET', '/api/recruitment/openings/o-1/board')).flush(boardView([]));
  });

  // --- Add an application ---

  function blur(selector: string): void {
    (el().querySelector(selector) as HTMLElement).dispatchEvent(new Event('blur'));
  }

  it('add: leaving the NIN looks for an existing record and the known person; « utiliser cette fiche » sends candidateId', async () => {
    await start(HR);
    await openBoard();
    click('[data-action="add-application"]');
    await settle();
    fill('#add-nin', '199504120000000017');
    blur('#add-nin');
    await settle();
    const match = await one('POST', '/api/recruitment/candidates/match');
    expect(match.request.body).toEqual({ nin: '199504120000000017' });
    match.flush({
      candidates: [{ id: 'cand-7', person: CANDIDATE_NAME, birthDate: '1995-04-12', matchedOn: ['nin'], applications: [{ id: 'a-7', opening: { ...OPENING_REF, id: 'o-4', reference: 'REC-2026-0004' }, stage: 'rejected' }] }],
      person: KNOWN_PERSON,
    });
    await settle();
    expect(text('[data-state="matches"]')).toContain('Candidature existante');
    expect(text('[data-match="cand-7"]')).toContain('même NIN');
    expect(text('[data-match="cand-7"]')).toContain('REC-2026-0004');
    expect(text('[data-state="known-person"]')).toContain("Déjà employé(e) dans l'entreprise");
    expect(text('[data-state="known-person"]')).toContain('matricule EMP-0099');
    // The same values are not searched twice.
    blur('#add-nin');
    await settle();
    http.expectNone('/api/recruitment/candidates/match');

    click('[data-action="use-existing"]');
    await settle();
    // Regional HR does not write salaries: the field is not offered.
    expect(el().querySelector('#add-salary')).toBeNull();
    fill('#add-source', 'referral');
    click('[data-action="save-application"]');
    await settle();
    const post = await one('POST', '/api/recruitment/openings/o-1/applications');
    expect(post.request.body).toEqual({ candidateId: 'cand-7', source: 'referral' });
    post.flush(applicationDetail({ id: 'a-8' }), { status: 201, statusText: 'Created' });
    await settle();
    expect(text('[data-feedback]')).toContain('Candidature de TESTEUR Nadia ajoutée.');
    expect(el().querySelector('[data-feedback] a')?.getAttribute('href')).toBe('/recruitment/candidates/cand-1?application=a-8');
    (await one('GET', '/api/recruitment/openings/o-1/board')).flush(boardView([]));
    (await one('GET', '/api/recruitment/openings/o-1')).flush(openingDetail());
  });

  it('add: a new record is checked before step 2; a 409 on the e-mail offers « Enregistrer quand même »; a failed CV upload keeps the application', async () => {
    await start(CENTRAL);
    await openBoard();
    click('[data-action="add-application"]');
    await settle();
    fill('#add-last-name', 'TESTEUR');
    fill('#add-first-name', 'Nadia');
    fill('#add-email', 'Nadia.Testeur@Example.test');
    click('[data-action="next"]');
    await settle();
    const match = await one('POST', '/api/recruitment/candidates/match');
    expect(match.request.body).toEqual({ email: 'Nadia.Testeur@Example.test', lastName: 'TESTEUR', firstName: 'Nadia' });
    match.flush({ candidates: [], person: null });
    await settle();

    fill('#add-salary', '65000');
    const input = el().querySelector('#add-cv') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [fakeFile('cv nadia.pdf', 'application/pdf')], configurable: true });
    input.dispatchEvent(new Event('change'));
    click('[data-action="save-application"]');
    await settle();
    const first = await one('POST', '/api/recruitment/openings/o-1/applications');
    expect(first.request.body).toMatchObject({ source: 'spontaneous', expectedSalary: '65000.00' });
    expect((first.request.body as { candidate: object }).candidate).toMatchObject({ lastName: 'TESTEUR', firstName: 'Nadia', email: 'nadia.testeur@example.test', nin: null, nationality: 'DZ' });
    expect(first.request.body).not.toHaveProperty('allowDuplicate');
    const duplicate = recruitmentProblem(409, 'recruitment-candidate-duplicate', [{ field: 'email', code: 'duplicate' }]);
    first.flush(duplicate.body, duplicate.options);
    await settle();
    expect(text('[data-error="form"]')).toContain('Une autre fiche porte déjà cet e-mail ou ce téléphone');

    click('[data-action="save-anyway"]');
    await settle();
    const second = await one('POST', '/api/recruitment/openings/o-1/applications');
    expect(second.request.body).toMatchObject({ allowDuplicate: true });
    second.flush(applicationDetail(), { status: 201, statusText: 'Created' });
    await settle();
    const upload = await one('POST', '/api/recruitment/candidates/cand-1/files');
    const form = upload.request.body as FormData;
    expect(form.get('kind')).toBe('cv');
    expect(form.get('title')).toBe('cv nadia');
    const tooLarge = recruitmentProblem(422, 'validation', [{ field: 'file', code: 'too_large' }]);
    upload.flush(tooLarge.body, tooLarge.options);
    await settle();
    expect(text('[data-feedback]')).toContain('le CV n’a pas pu être enregistré');
    expect(el().querySelector('[data-section="add-application"]')).toBeNull();
    (await one('GET', '/api/recruitment/openings/o-1/board')).flush(boardView([]));
    (await one('GET', '/api/recruitment/openings/o-1')).flush(openingDetail());
  });

  it('add: a NIN duplicate is never overridable', async () => {
    await start(HR);
    await openBoard();
    click('[data-action="add-application"]');
    await settle();
    fill('#add-last-name', 'TESTEUR');
    fill('#add-first-name', 'Nadia');
    fill('#add-nin', '199504120000000017');
    click('[data-action="next"]');
    await settle();
    (await one('POST', '/api/recruitment/candidates/match')).flush({ candidates: [], person: null });
    await settle();
    click('[data-action="save-application"]');
    await settle();
    const duplicate = recruitmentProblem(409, 'recruitment-candidate-duplicate', [{ field: 'nin', code: 'duplicate' }]);
    (await one('POST', '/api/recruitment/openings/o-1/applications')).flush(duplicate.body, duplicate.options);
    await settle();
    // Back on the identity step, the error on the field, no override.
    expect(text('#add-nin-error')).toBe('Une fiche porte déjà ce NIN : utilisez la fiche existante.');
    expect(el().querySelector('[data-action="save-anyway"]')).toBeNull();

    // A new candidate's own field errors arrive as `candidate.<field>`: they land on the identity fields too.
    fill('#add-nin', '199504120000000025');
    click('[data-action="next"]');
    await settle();
    (await one('POST', '/api/recruitment/candidates/match')).flush({ candidates: [], person: null });
    await settle();
    click('[data-action="save-application"]');
    await settle();
    const invalid = recruitmentProblem(422, 'validation', [{ field: 'candidate.phone', code: 'too_big', message: 'Trop long' }]);
    (await one('POST', '/api/recruitment/openings/o-1/applications')).flush(invalid.body, invalid.options);
    await settle();
    expect(text('#add-phone-error')).toBe('Trop long');
    expect((el().querySelector('[data-form="candidate-identity"]') as HTMLElement).hidden).toBe(false);
  });

  // --- Candidate page ---

  async function openCandidate(candidate = candidateView(), application = applicationDetail()): Promise<void> {
    await go('/recruitment/candidates/cand-1?application=a-1');
    (await one('GET', '/api/recruitment/candidates/cand-1')).flush(candidate);
    await settle();
    (await one('GET', '/api/recruitment/applications/a-1')).flush(application);
    await settle();
  }

  it('candidate page: identity, files, stage history, notes and the salary for central HR', async () => {
    await start(CENTRAL);
    await openCandidate(
      candidateView({ knownPerson: KNOWN_PERSON }),
      applicationDetail({
        stages: [
          { id: 'st-1', from: null, to: 'received', at: '2026-10-03T10:00:00Z', by: null, rejectionReason: null, comment: null, autoCause: null },
          { id: 'st-2', from: 'received', to: 'rejected', at: '2026-10-05T10:00:00Z', by: null, rejectionReason: { code: 'opening_closed', labels: REASONS[1]?.labels ?? { fr: '', ar: '', en: '' } }, comment: null, autoCause: 'opening_closed' },
        ],
      }),
    );
    expect(text('h1')).toBe('TESTEUR Nadia');
    expect(text('[data-field="nin"]')).toBe('199504120000000017');
    expect(text('[data-field="salary"]')).toContain('65');
    expect(el().querySelector('[data-state="redacted"]')).toBeNull();
    expect(text('[data-panel="known-person"]')).toContain('matricule EMP-0099');
    expect(el().querySelector('[data-file="f-1"] [data-action="delete-file"]')).not.toBeNull();
    expect(text('[data-stage-entry="rejected"] [data-field="auto-cause"]')).toBe('Recrutement clôturé');
    expect(text('[data-note="n-1"]')).toContain('Bon contact au téléphone.');

    click('[data-action="link-person"]');
    await settle();
    const link = await one('PUT', '/api/recruitment/candidates/cand-1/person');
    expect(link.request.body).toEqual({ personId: 'p-9' });
    link.flush(candidateView());
    await settle();
    (await one('GET', '/api/recruitment/candidates/cand-1')).flush(candidateView());
    (await one('GET', '/api/recruitment/applications/a-1')).flush(applicationDetail());
    await settle();

    fill('#note-body', ' À rappeler lundi. ');
    click('[data-action="add-note"]');
    await settle();
    const note = await one('POST', '/api/recruitment/applications/a-1/notes');
    expect(note.request.body).toEqual({ body: 'À rappeler lundi.' });
    note.flush({ id: 'n-2', body: 'À rappeler lundi.', createdAt: '2026-10-07T09:00:00Z', createdBy: { id: 'u-amina', displayName: 'Amina Benali' }, _actions: ['delete'] }, { status: 201, statusText: 'Created' });
    await settle();
    (await one('GET', '/api/recruitment/applications/a-1')).flush(applicationDetail());
  });

  it('candidate page: regional HR sees « Salaire masqué », cannot erase, and a stale move reloads the page', async () => {
    await start(HR);
    // Without the permission the API omits the block altogether.
    const withoutSalary = applicationDetail({ _redacted: ['salary'], _actions: ['move', 'add_note', 'update'] });
    Reflect.deleteProperty(withoutSalary, 'salary');
    await openCandidate(candidateView({ _actions: ['update', 'upload', 'link_person'] }), withoutSalary);
    expect(text('[data-state="redacted"]')).toBe('Salaire masqué');
    expect(el().querySelector('[data-action="erase"]')).toBeNull();

    click('[data-application="a-1"] [data-action="move"]');
    await settle();
    click('[data-application="a-1"] [data-target="shortlisted"]');
    await settle();
    const move = await one('POST', '/api/recruitment/applications/a-1/move');
    expect(move.request.body).toEqual({ toStage: 'shortlisted', expectedStage: 'received' });
    const changed = recruitmentProblem(409, 'recruitment-stage-changed');
    move.flush(changed.body, changed.options);
    await settle();
    expect(text('[data-error="action"]')).toBe('Cette candidature a été modifiée entre-temps. Veuillez actualiser.');
    (await one('GET', '/api/recruitment/candidates/cand-1')).flush(candidateView());
    (await one('GET', '/api/recruitment/applications/a-1')).flush({ ...withoutSalary, stage: 'interview' });
    await settle();
    expect(text('[data-field="stage"]')).toBe('Entretien');
  });

  it('candidate page: erasing asks for a confirmation that says it cannot be undone, then leaves the page', async () => {
    await start(CENTRAL);
    await openCandidate();
    click('[data-action="erase"]');
    await settle();
    expect(text('dialog[open]')).toContain('ne peut pas être annulée');
    http.expectNone('/api/recruitment/candidates/cand-1/erase');
    click('[data-action="confirm-erase"]');
    await settle();
    const active = recruitmentProblem(409, 'recruitment-application-active');
    (await one('POST', '/api/recruitment/candidates/cand-1/erase')).flush(active.body, active.options);
    await settle();
    expect(text('[data-error="action"]')).toContain('enregistrez d’abord un refus ou un désistement');

    click('[data-action="erase"]');
    await settle();
    click('[data-action="confirm-erase"]');
    await settle();
    const left = nextNavigation();
    (await one('POST', '/api/recruitment/candidates/cand-1/erase')).flush(null, { status: 204, statusText: 'No Content' });
    await left;
    await settle();
    expect(router.url).toBe('/recruitment/candidates?erased=1');
    (await one('GET', '/api/recruitment/candidates')).flush({ items: [], total: 0, page: 1, pageSize: 25 });
    (await one('GET', '/api/recruitment/openings')).flush({ items: [], total: 0, page: 1, pageSize: 100 });
    await settle();
    expect(text('[data-feedback="erased"]')).toBe('Les données ont été effacées.');
  });

  it('candidate files: upload posts kind, title and the file; delete asks first and removes for good', async () => {
    await start(HR);
    await openCandidate();
    click('[data-action="add-file"]');
    await settle();
    const input = el().querySelector('#cand-file') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [fakeFile('diplome_master.png', 'image/png')], configurable: true });
    input.dispatchEvent(new Event('change'));
    await settle();
    // A CV is already there: the kind defaults to « Autre »; the title comes from the file name.
    expect((el().querySelector('#cand-file-kind') as HTMLSelectElement).value).toBe('other');
    expect((el().querySelector('#cand-file-title') as HTMLInputElement).value).toBe('diplome master');
    fill('#cand-file-kind', 'diploma');
    click('[data-action="upload"]');
    await settle();
    const upload = await one('POST', '/api/recruitment/candidates/cand-1/files');
    const form = upload.request.body as FormData;
    expect([form.get('kind'), form.get('title'), (form.get('file') as File).name]).toEqual(['diploma', 'diplome master', 'diplome_master.png']);
    const duplicate = recruitmentProblem(409, 'recruitment-file-duplicate');
    upload.flush(duplicate.body, duplicate.options);
    await settle();
    expect(text('#cand-file-error')).toBe('Ce fichier figure déjà parmi les pièces de cette fiche.');
    click('[data-action="cancel-upload"]');
    await settle();

    click('[data-file="f-1"] [data-action="delete-file"]');
    await settle();
    http.expectNone((r) => r.method === 'DELETE');
    click('[data-action="confirm-delete-file"]');
    await settle();
    (await one('DELETE', '/api/recruitment/candidates/cand-1/files/f-1')).flush(null, { status: 204, statusText: 'No Content' });
    await settle();
    (await one('GET', '/api/recruitment/candidates/cand-1')).flush(candidateView({ files: [] }));
    await settle();
    expect(el().querySelector('[data-file="f-1"]')).toBeNull();
  });

  // --- Candidates list ---

  it('candidates list: one row per application, filters in the URL, « sans mouvement depuis 6 mois »', async () => {
    await start(HR);
    await go('/recruitment/candidates?stage=interview');
    const list = await one('GET', '/api/recruitment/candidates');
    expect(list.request.params.get('state')).toBe('active');
    expect(list.request.params.get('stage')).toBe('interview');
    list.flush({
      items: [{ id: 'a-1', opening: OPENING_REF, stage: 'interview', stageSince: '2026-10-03T10:00:00Z', source: 'anem', createdAt: '2026-10-03T10:00:00Z', decidedAt: null, rejectionReason: null, candidate: { id: 'cand-1', ...CANDIDATE_NAME }, hasCv: true }],
      total: 1,
      page: 1,
      pageSize: 25,
    });
    (await one('GET', '/api/recruitment/openings')).flush({ items: [openingView()], total: 1, page: 1, pageSize: 100 });
    await settle();
    expect(el().querySelector('[data-application="a-1"] a')?.getAttribute('href')).toBe('/recruitment/candidates/cand-1?application=a-1');

    (el().querySelector('#cands-idle') as HTMLInputElement).click();
    await settle();
    expect(router.url).toBe('/recruitment/candidates?stage=interview&idle=true');
    const idle = await one('GET', '/api/recruitment/candidates');
    expect(idle.request.params.get('idleMonths')).toBe('6');
    idle.flush({ items: [], total: 0, page: 1, pageSize: 25 });
  });

  // --- Mes recrutements ---

  it('my openings: cards with the stepper while pending; cancelling reloads the list and the summary', async () => {
    await start([]);
    await go('/me/recruitment');
    (await one('GET', '/api/me/recruitment/openings')).flush({
      items: [myOpeningDetail({ id: 'o-2', status: 'pending', workflow: OPENING_PROGRESS, roles: ['requester'], counts: null, _actions: ['cancel'] }), myOpeningDetail()],
    });
    (await one('GET', '/api/me/recruitment/summary')).flush({ canRequestOpening: true, openings: 2, pendingOpenings: 1 });
    await settle();
    expect(el().querySelector('[data-action="request"]')?.getAttribute('href')).toBe('/me/recruitment/new');
    expect(el().querySelector('[data-opening="o-2"] app-workflow-stepper')).not.toBeNull();
    expect(el().querySelector('[data-opening="o-2"] [data-field="counts"]')).toBeNull();
    expect(text('[data-opening="o-1"] [data-field="counts"]')).toContain('Reçue : 2');
    expect(el().querySelector('[data-opening="o-1"] [data-action="cancel-request"]')).toBeNull();

    click('[data-opening="o-2"] [data-action="cancel-request"]');
    await settle();
    (await one('POST', '/api/me/recruitment/openings/o-2/cancel')).flush(myOpeningDetail({ id: 'o-2', status: 'cancelled' }));
    await settle();
    expect(text('[data-feedback]')).toBe('Demande annulée.');
    (await one('GET', '/api/me/recruitment/openings')).flush({ items: [] });
    (await one('GET', '/api/me/recruitment/summary')).flush({ canRequestOpening: true, openings: 2, pendingOpenings: 0 });
  });

  it('head view: applications by stage with file downloads through the /me route — no move, no notes, no identity', async () => {
    await start([]);
    await go('/me/recruitment/openings/o-1');
    (await one('GET', '/api/me/recruitment/openings/o-1')).flush(
      myOpeningDetail({
        applications: [
          { id: 'a-1', candidate: CANDIDATE_NAME, stage: 'interview', stageSince: '2026-10-03T10:00:00Z', files: [candidateFile({ _actions: [] })], average: 4.2, interviews: 1 },
          { id: 'a-2', candidate: { lastName: 'AUTRE', firstName: 'Test', lastNameAr: null, firstNameAr: null }, stage: 'rejected', stageSince: '2026-10-04T10:00:00Z', files: [], average: null, interviews: 0 },
        ],
      }),
    );
    await settle();
    // A head also gets the comparison of the opening, through the /me route.
    (await one('GET', '/api/me/recruitment/openings/o-1/comparison')).flush(comparisonView());
    await settle();
    expect([...el().querySelectorAll('[data-section="applications"] h3')].map((h) => h.getAttribute('data-stage'))).toEqual(['interview', 'rejected']);
    expect(text('[data-application="a-1"]')).toContain('TESTEUR Nadia');
    expect(text('[data-application="a-1"] [data-field="average"]')).toBe('Moyenne 4,2 / 5');
    expect(el().querySelector('[data-section="comparison"] [data-row="a-1"] a')).toBeNull();
    expect(el().querySelector('app-stage-menu')).toBeNull();
    expect(el().querySelector('[data-panel="notes"]')).toBeNull();
    expect(el().querySelector('[data-field="nin"]')).toBeNull();
    expect(el().querySelector('[data-application="a-2"] [data-action="download-file"]')).toBeNull();

    click('[data-application="a-1"] [data-action="download-file"]');
    await settle();
    const gone = recruitmentProblem(404, null);
    (await one('GET', '/api/me/recruitment/applications/a-1/files/f-1/content')).flush(new Blob([JSON.stringify(gone.body)], { type: 'application/problem+json' }), gone.options);
    await settle();
    // 404: the application reached a final stage meanwhile — the page reloads to show it.
    (await one('GET', '/api/me/recruitment/openings/o-1')).flush(myOpeningDetail({ applications: [] }));
    await settle();
    expect(el().querySelector('[data-state="no-applications"]')).not.toBeNull();
  });

  // --- Settings and the notice ---

  it('settings: system reasons are marked, the automatic ones cannot be edited; a reason and the policy are saved', async () => {
    await start(CENTRAL);
    await go('/recruitment/settings');
    (await one('GET', '/api/recruitment/rejection-reasons')).flush({ items: REASONS });
    await settle();
    expect(el().querySelector('[data-reason="experience"] [data-tag="system"]')).not.toBeNull();
    expect(el().querySelector('[data-reason="opening_closed"] [data-tag="auto"]')).not.toBeNull();
    expect(el().querySelector('[data-reason="opening_closed"] [data-action="edit-reason"]')).toBeNull();

    click('[data-reason="old_one"] [data-action="edit-reason"]');
    await settle();
    expect((el().querySelector('#reason-code') as HTMLInputElement).disabled).toBe(true);
    (el().querySelector('#reason-active') as HTMLInputElement).click();
    click('[data-action="save-reason"]');
    await settle();
    const put = await one('PUT', '/api/recruitment/rejection-reasons/r-old');
    expect(put.request.body).toEqual({ labels: { fr: 'Ancien motif', ar: 'سبب قديم', en: 'Old reason' }, active: true, sortOrder: 30 });
    put.flush(REASONS[2] ?? null);
    await settle();
    (await one('GET', '/api/recruitment/rejection-reasons')).flush({ items: REASONS });

    click('[data-action="new-reason"]');
    await settle();
    fill('#reason-code', 'Bad Code');
    fill('#reason-fr', 'Trop loin');
    fill('#reason-ar', 'بعيد');
    fill('#reason-en', 'Too far');
    click('[data-action="save-reason"]');
    await settle();
    http.expectNone((r) => r.method === 'POST');
    fill('#reason-code', 'too_far');
    click('[data-action="save-reason"]');
    await settle();
    const post = await one('POST', '/api/recruitment/rejection-reasons');
    expect(post.request.body).toEqual({ code: 'too_far', labels: { fr: 'Trop loin', ar: 'بعيد', en: 'Too far' } });
    const taken = recruitmentProblem(409, 'recruitment-reason-code-taken');
    post.flush(taken.body, taken.options);
    await settle();
    expect(text('#reason-code-error')).toBe('Ce code est déjà utilisé.');

    click('[data-tab="policy"]');
    await settle();
    (await one('GET', '/api/recruitment/policy')).flush({ retentionMonths: 12, openingWorkflowCode: 'recruitment.manager_then_hr', company: { nameFr: 'Groupe Démo', nameAr: null } });
    await settle();
    expect(text('#rec-retention-hint')).toContain('De 1 à 60 mois');
    fill('#rec-retention', '61');
    click('[data-action="save-policy"]');
    await settle();
    http.expectNone((r) => r.method === 'PUT');
    fill('#rec-retention', '24');
    (el().querySelector('[id="rec-flow-recruitment.hr_only"]') as HTMLInputElement).click();
    click('[data-action="save-policy"]');
    await settle();
    const policy = await one('PUT', '/api/recruitment/policy');
    expect(policy.request.body).toEqual({ retentionMonths: 24, openingWorkflowCode: 'recruitment.hr_only' });
    policy.flush({ retentionMonths: 24, openingWorkflowCode: 'recruitment.hr_only', company: { nameFr: 'Groupe Démo', nameAr: null } });
    await settle();
    (await one('GET', '/api/recruitment/policy')).flush({ retentionMonths: 24, openingWorkflowCode: 'recruitment.hr_only', company: { nameFr: 'Groupe Démo', nameAr: null } });
  });

  it('notice: the French and the Arabic text with the company and the retention, whatever the UI language; « Imprimer » prints', async () => {
    await start(HR);
    TestBed.inject(LanguageService).use('ar', { remember: false });
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    await go('/recruitment/notice');
    (await one('GET', '/api/recruitment/policy')).flush({ retentionMonths: 18, openingWorkflowCode: 'recruitment.manager_then_hr', company: { nameFr: 'Groupe Démo SPA', nameAr: 'مجمع ديمو' } });
    await settle();
    const fr = el().querySelector('[data-lang="fr"]') as HTMLElement;
    const ar = el().querySelector('[data-lang="ar"]') as HTMLElement;
    expect([fr.getAttribute('dir'), ar.getAttribute('dir')]).toEqual(['ltr', 'rtl']);
    expect(fr.textContent).toContain('sont enregistrées par Groupe Démo SPA pour la gestion de ce recrutement');
    expect(fr.textContent).toContain('effacées 18 mois après la décision');
    expect(fr.textContent).toContain('loi n° 18-07 du 10 juin 2018');
    expect(ar.textContent).toContain('من طرف مجمع ديمو لغرض تسيير عملية التوظيف هذه');
    expect(ar.textContent).toContain('بعد 18 شهرا من تاريخ القرار');
    click('[data-action="print"]');
    expect(print).toHaveBeenCalledTimes(1);
    print.mockRestore();
  });
});
