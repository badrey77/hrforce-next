import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { meWith } from '../../../testing/auth-fixtures';
import { CRITICAL_ITEM, deadlinePage, HANDLED_ITEM, SUMMARY } from '../../../testing/deadline-fixtures';
import { installDialogPolyfill } from '../../../testing/dialog-polyfill';
import { translocoTesting } from '../../../testing/transloco-testing';
import { Session } from '../../core/auth/session';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import { LanguageService } from '../../core/i18n/language.service';
import { DeadlinesBoardPage } from './deadlines-board.page';

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    TestBed.tick();
    await new Promise((resolve) => setTimeout(resolve));
  }
}

const isList = (url: string) => url === '/api/deadlines';

describe('DeadlinesBoardPage', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;
  let router: Router;

  beforeEach(async () => {
    installDialogPolyfill();
    await TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [
        provideRouter([{ path: 'deadlines', component: DeadlinesBoardPage }], withComponentInputBinding()),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
    TestBed.inject(Session).set(meWith(['deadline.read', 'deadline.handle', 'employee.contract.manage']));
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => {
    TestBed.inject(LanguageService).use('fr', { remember: false });
    http.verify();
  });

  const el = () => harness.routeNativeElement as HTMLElement;

  async function open(url = '/deadlines', page = deadlinePage()) {
    await harness.navigateByUrl(url);
    await settle();
    http.expectOne('/api/deadlines/summary').flush(SUMMARY);
    const req = http.expectOne((r) => isList(r.url));
    req.flush(page);
    await settle();
    return req.request.params;
  }

  function click(selector: string): void {
    const button = el().querySelector<HTMLElement>(selector);
    if (!button) throw new Error(selector);
    button.click();
    TestBed.tick();
  }

  it('reads its filters from the URL and sends them to the API', async () => {
    const params = await open('/deadlines?kind=contract_end&status=all&within=30&q=benali&page=2');
    expect(params.get('kind')).toBe('contract_end');
    expect(params.get('status')).toBe('all');
    expect(params.get('within')).toBe('30');
    expect(params.get('q')).toBe('benali');
    expect(params.get('page')).toBe('2');
    expect(el().querySelector<HTMLSelectElement>('#dl-kind')?.value).toBe('contract_end');
  });

  it('groups the rows and names the severity in words, not colour alone', async () => {
    await open();
    expect([...el().querySelectorAll('[data-group]')].map((g) => g.getAttribute('data-group'))).toEqual(['overdue', 'soon', 'later']);
    const critical = el().querySelector(`[data-item="${CRITICAL_ITEM.key}"]`);
    expect(critical?.querySelector('[data-field="severity"]')?.textContent?.trim()).toBe('Critique');
    expect(critical?.querySelector('[data-field="relative"]')?.textContent?.trim()).toBe('3 j de retard');
    expect(critical?.textContent).toContain('CDD');
    // ISO days print as that day in any time zone (verification 2026-10-19: with the pipe's 'UTC' zone a machine east
    // of UTC printed the day before)
    expect(critical?.querySelector('.date')?.textContent?.trim()).toBe('16 oct. 2026');
    expect(el().querySelector('[data-summary] [data-count="overdue"]')?.textContent).toContain('4');
    // links: the employee's contracts tab, the document in the file
    expect(critical?.querySelector('[data-link="employee"]')?.getAttribute('href')).toBe('/employees/emp-27?tab=contracts');
    expect(el().querySelector('[data-link="file"]')?.getAttribute('href')).toBe('/employees/emp-29?tab=file');
  });

  it('a filter change goes to the URL and back to page 1', async () => {
    await open('/deadlines?page=3');
    const select = el().querySelector<HTMLSelectElement>('#dl-status');
    if (!select) throw new Error('status');
    select.value = 'handled';
    select.dispatchEvent(new Event('change'));
    await settle();
    expect(router.url).toBe('/deadlines?status=handled');
    http.expectOne((r) => isList(r.url) && r.params.get('status') === 'handled').flush(deadlinePage([HANDLED_ITEM]));
    await settle();
    expect(el().querySelector('[data-group="handled"] [data-field="ack"]')?.textContent).toContain('Période d’essai confirmée');
  });

  it('« Traiter » acks the item with its note, then reloads the list and the badge', async () => {
    await open();
    click(`[data-item="${CRITICAL_ITEM.key}"] [data-action="ack"]`);
    const note = el().querySelector<HTMLTextAreaElement>('#ack-note');
    if (!note) throw new Error('note');
    note.value = '  Renouvellement signé  ';
    note.dispatchEvent(new Event('input'));
    click('[data-action="confirm-ack"]');
    const ack = http.expectOne('/api/deadlines/acks');
    expect(ack.request.body).toEqual({ kind: 'contract_end', subjectId: 'c-1', dueDate: '2026-10-16', note: 'Renouvellement signé' });
    ack.flush({ ...CRITICAL_ITEM, status: 'handled' });
    await settle();
    http.expectOne((r) => isList(r.url)).flush(deadlinePage([]));
    http.expectOne('/api/deadlines/summary').flush({ ...SUMMARY, overdue: 3 });
    await settle();
    expect(el().querySelector('[data-feedback]')?.textContent).toContain('Échéance marquée comme traitée.');
  });

  it('« Annuler » removes the ack; « Lancer la décision » opens one; refusals are explained', async () => {
    await open('/deadlines?status=all', deadlinePage([CRITICAL_ITEM, HANDLED_ITEM]));
    click(`[data-item="${HANDLED_ITEM.key}"] [data-action="unack"]`);
    const undo = http.expectOne('/api/deadlines/acks/ack-1');
    expect(undo.request.method).toBe('DELETE');
    undo.flush(null);
    await settle();
    http.expectOne((r) => isList(r.url)).flush(deadlinePage([CRITICAL_ITEM, HANDLED_ITEM]));
    http.expectOne('/api/deadlines/summary').flush(SUMMARY);
    await settle();

    click(`[data-item="${CRITICAL_ITEM.key}"] [data-action="open-decision"]`);
    http
      .expectOne('/api/employees/emp-27/contracts/c-1/decision')
      .flush({ type: 'urn:hrforce:problem:contract-decision-pending', title: 'Pending', status: 409 }, { status: 409, statusText: 'Conflict' });
    await settle();
    http.expectOne((r) => isList(r.url)).flush(deadlinePage([CRITICAL_ITEM]));
    await settle();
    expect(el().querySelector('[data-feedback]')?.textContent).toContain('Une décision est déjà en cours pour ce contrat.');
  });

  it('in Arabic', async () => {
    TestBed.inject(LanguageService).use('ar', { remember: false });
    await open();
    expect(el().querySelector('h1')?.textContent).toContain('الآجال');
    expect(el().querySelector(`[data-item="${CRITICAL_ITEM.key}"] [data-field="severity"]`)?.textContent?.trim()).toBe('حرج');
    expect(el().querySelector(`[data-item="${CRITICAL_ITEM.key}"] [data-field="relative"]`)?.textContent?.trim()).toBe('أيام التأخير: 3');
  });
});
