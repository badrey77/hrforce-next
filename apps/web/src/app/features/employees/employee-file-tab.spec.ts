import { HttpEventType, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { meWith } from '../../../testing/auth-fixtures';
import { installDialogPolyfill } from '../../../testing/dialog-polyfill';
import { detail } from '../../../testing/employee-fixtures';
import {
  CAT_MEDICAL,
  categoryRef,
  employeeFile,
  fakeFile,
  FILE_CATEGORIES,
  fileList,
  provideUploadsThroughTestingBackend,
} from '../../../testing/employee-file-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { Session } from '../../core/auth/session';
import type { EmployeeFileList } from '../../core/employee-files/employee-files.models';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import { EmployeeFileTab } from './employee-file-tab';

@Component({
  imports: [EmployeeFileTab],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<app-employee-file-tab [employee]="employee" />`,
})
class Host {
  readonly employee = detail();
}

const LIST = '/api/employees/e-1/files';
const CATEGORIES = '/api/employee-files/categories';

describe('EmployeeFileTab', () => {
  let fixture: ComponentFixture<Host>;
  let el: HTMLElement;
  let http: HttpTestingController;

  async function settle(): Promise<void> {
    TestBed.tick();
    await new Promise((resolve) => setTimeout(resolve));
    TestBed.tick();
    fixture.detectChanges();
  }

  async function create(permissions: string[], list: EmployeeFileList = fileList()): Promise<void> {
    installDialogPolyfill();
    await TestBed.configureTestingModule({
      imports: [Host, translocoTesting()],
      providers: [provideHttpClient(withInterceptors([apiProblemInterceptor])), provideHttpClientTesting(), provideUploadsThroughTestingBackend()],
    }).compileComponents();
    TestBed.inject(Session).set(meWith(permissions));
    fixture = TestBed.createComponent(Host);
    el = fixture.nativeElement as HTMLElement;
    http = TestBed.inject(HttpTestingController);
    await settle();
    http.expectOne((r) => r.url === LIST).flush(list);
    http.expectOne(CATEGORIES).flush({ items: FILE_CATEGORIES });
    await settle();
  }

  const text = (selector: string) => el.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim();
  const click = (selector: string) => (el.querySelector(selector) as HTMLElement).click();

  function chooseFile(file: File): void {
    const input = el.querySelector('#file-input') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
  }

  function fill(id: string, value: string): void {
    const input = el.querySelector(`#${id}`) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input'));
  }

  afterEach(() => http.verify());

  it('groups files by category (categories order), shows metadata, expiry, and hides buttons the server does not allow', async () => {
    await create(['employee_file.read'], fileList({ items: [employeeFile({ _actions: [] })], _actions: [] }));
    expect([...el.querySelectorAll('details.file-group')].map((d) => d.getAttribute('data-category'))).toEqual(['diploma']);
    expect(text('[data-file="f-1"] .file-title')).toBe('Licence en droit');
    expect(text('[data-file="f-1"]')).toContain('licence_droit.pdf');
    expect(text('[data-file="f-1"] .file-type')).toBe('PDF');
    expect(text('[data-file="f-1"]')).toContain('Amina Benali');
    expect(el.querySelector('[data-action="add-file"]')).toBeNull();
    expect(el.querySelector('[data-action="delete-file"]')).toBeNull();
    expect(el.querySelector('[data-action="download-file"]')).not.toBeNull();
    expect(el.querySelector('#file-show-deleted')).toBeNull();
    expect(el.querySelector('[data-state="medical-hidden"]')).toBeNull();
  });

  it('orders groups by category, flags an expired ID document, and says when medical files are hidden', async () => {
    await create(['employee_file.read'], fileList({ _redacted: ['medical'] }));
    expect([...el.querySelectorAll('details.file-group')].map((d) => d.getAttribute('data-category'))).toEqual(['diploma', 'id_document']);
    expect(el.querySelector('[data-file="f-2"] [data-state="expired"]')).not.toBeNull();
    expect(text('[data-state="medical-hidden"]')).toContain('pièces médicales');
  });

  it('downloads the bytes under the original file name', async () => {
    await create(['employee_file.read']);
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    click('[data-file="f-1"] [data-action="download-file"]');
    await settle();
    expect(text('[data-file="f-1"] [data-action="download-file"]')).toBe('Téléchargement…');
    const req = http.expectOne(`${LIST}/f-1/content`);
    expect(req.request.responseType).toBe('blob');
    req.flush(new Blob(['%PDF'], { type: 'application/pdf' }));
    await settle();
    expect(createUrl).toHaveBeenCalled();
    expect((clickSpy.mock.contexts[0] as HTMLAnchorElement).download).toBe('licence_droit.pdf');
    expect(text('[data-file="f-1"] [data-action="download-file"]')).toBe('Télécharger');
    vi.restoreAllMocks();
  });

  it('refuses a file of the wrong type in the browser, without sending anything', async () => {
    await create(['employee_file.read', 'employee_file.upload']);
    click('[data-action="add-file"]');
    await settle();
    chooseFile(fakeFile('cv.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'));
    await settle();
    expect(text('[data-error="file"]')).toBe('Seuls les fichiers PDF, JPEG et PNG sont acceptés.');
    el.querySelector('[data-form="upload-file"]')?.dispatchEvent(new Event('submit'));
    await settle();
    http.expectNone(LIST);
  });

  it('refuses an expiry date before the document date in the browser, and re-checks when the document date changes', async () => {
    await create(['employee_file.read', 'employee_file.upload']);
    click('[data-action="add-file"]');
    await settle();
    chooseFile(fakeFile('cni.png', 'image/png'));
    fill('file-category', FILE_CATEGORIES[0]?.id ?? '');
    fill('file-document-date', '2026-01-10');
    fill('file-expires-on', '2020-01-01');
    el.querySelector('[data-form="upload-file"]')?.dispatchEvent(new Event('submit'));
    await settle();
    expect(text('#file-expires-on-error')).toBe('La date doit être au plus tôt le 2026-01-10.');
    http.expectNone(LIST);
    fill('file-document-date', '2019-06-01');
    await settle();
    expect(el.querySelector('#file-expires-on-error')).toBeNull();
  });

  it('downloads a file whose name does not match its detected type under a name with the right extension', async () => {
    await create(['employee_file.read'], fileList({ items: [employeeFile({ originalFilename: 'page.html' })] }));
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    click('[data-file="f-1"] [data-action="download-file"]');
    await settle();
    http.expectOne(`${LIST}/f-1/content`).flush(new Blob(['%PDF'], { type: 'application/pdf' }));
    await settle();
    expect((clickSpy.mock.contexts[0] as HTMLAnchorElement).download).toBe('page.html.pdf');
    vi.restoreAllMocks();
  });

  it('uploads with a progress bar, proposes the title, offers medical only with upload_medical, then reloads', async () => {
    await create(['employee_file.read', 'employee_file.upload']);
    click('[data-action="add-file"]');
    await settle();
    const options = [...el.querySelectorAll('#file-category option')].map((o) => o.getAttribute('value'));
    expect(options).toEqual(['', 'c-diploma', 'c-contract', 'c-id', 'c-other']);

    chooseFile(fakeFile('diplome_master-2014.pdf', 'application/pdf', 2048));
    await settle();
    expect((el.querySelector('#file-title') as HTMLInputElement).value).toBe('diplome master 2014');
    fill('file-category', 'c-diploma');
    el.querySelector('[data-form="upload-file"]')?.dispatchEvent(new Event('submit'));
    await settle();

    const req = http.expectOne(LIST);
    expect(req.request.method).toBe('POST');
    const body = req.request.body as FormData;
    expect([body.get('categoryId'), body.get('title'), body.get('documentDate')]).toEqual(['c-diploma', 'diplome master 2014', null]);
    req.event({ type: HttpEventType.UploadProgress, loaded: 1024, total: 2048 });
    await settle();
    expect(el.querySelector('#file-progress')?.getAttribute('value')).toBe('50');
    expect(text('[data-field="percent"]')).toContain('50 %');
    expect(el.querySelector('[data-action="abort-upload"]')).not.toBeNull();
    req.event({ type: HttpEventType.UploadProgress, loaded: 2048, total: 2048 });
    await settle();
    expect(text('.upload-progress label')).toBe('Vérification par le serveur…');

    req.flush(employeeFile({ id: 'f-9' }), { status: 201, statusText: 'Created' });
    await settle();
    expect(el.querySelector('[data-form="upload-file"]')).toBeNull();
    expect(text('.feedback')).toBe('Pièce ajoutée au dossier.');
    http.expectOne(LIST).flush(fileList());
  });

  it('shows the reverse proxy 413 (body over its cap) as "file too large" on the file field', async () => {
    await create(['employee_file.read', 'employee_file.upload']);
    click('[data-action="add-file"]');
    await settle();
    chooseFile(fakeFile('scan.pdf', 'application/pdf', 2048));
    fill('file-category', 'c-diploma');
    el.querySelector('[data-form="upload-file"]')?.dispatchEvent(new Event('submit'));
    await settle();
    http.expectOne(LIST).flush('', { status: 413, statusText: 'Request Entity Too Large' });
    await settle();
    expect(text('[data-error="file"]')).toBe('Fichier trop volumineux.');
    expect(el.querySelector('[data-error="form"]')).toBeNull();
  });

  it('lists the medical category with upload_medical; shows the server refusals on the right field', async () => {
    await create(['employee_file.read', 'employee_file.upload'], fileList({ _actions: ['upload', 'upload_medical'] }));
    click('[data-action="add-file"]');
    await settle();
    expect(el.querySelector(`#file-category option[value="${CAT_MEDICAL.id}"]`)).not.toBeNull();

    chooseFile(fakeFile('scan.pdf', 'application/pdf'));
    fill('file-category', CAT_MEDICAL.id);
    el.querySelector('[data-form="upload-file"]')?.dispatchEvent(new Event('submit'));
    await settle();
    http
      .expectOne(LIST)
      .flush(
        { type: 'urn:hrforce:problem:validation', title: 'x', status: 422, errors: [{ field: 'file', code: 'unsupported_type', message: 'x' }] },
        { status: 422, statusText: 'Unprocessable Entity' },
      );
    await settle();
    expect(text('[data-error="file"]')).toBe('Seuls les fichiers PDF, JPEG et PNG sont acceptés.');
    // The refused file keeps its server error: sending the same bytes again is blocked until another file is chosen.
    el.querySelector('[data-form="upload-file"]')?.dispatchEvent(new Event('submit'));
    await settle();
    http.expectNone(LIST);

    chooseFile(fakeFile('scan2.pdf', 'application/pdf'));
    await settle();
    el.querySelector('[data-form="upload-file"]')?.dispatchEvent(new Event('submit'));
    await settle();
    http
      .expectOne(LIST)
      .flush({ type: 'urn:hrforce:problem:employee-file-duplicate', title: 'x', status: 409 }, { status: 409, statusText: 'Conflict' });
    await settle();
    expect(text('[data-error="file"]')).toBe('Ce fichier figure déjà dans le dossier de cet employé.');
  });

  it('accepts a dropped file (the first one of several), and prevents the browser from opening it', async () => {
    await create(['employee_file.read', 'employee_file.upload']);
    click('[data-action="add-file"]');
    await settle();
    const zone = el.querySelector('[data-drop-zone]') as HTMLElement;
    const over = new Event('dragover', { cancelable: true });
    zone.dispatchEvent(over);
    await settle();
    expect(over.defaultPrevented).toBe(true);
    expect(zone.classList.contains('over')).toBe(true);
    const drop = new Event('drop', { cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [fakeFile('contrat_2025.pdf', 'application/pdf'), fakeFile('b.png', 'image/png')] } });
    zone.dispatchEvent(drop);
    await settle();
    expect(drop.defaultPrevented).toBe(true);
    expect(zone.classList.contains('over')).toBe(false);
    expect(text('[data-field="chosen"]')).toContain('contrat_2025.pdf');
    expect(el.querySelector('[data-state="only-first"]')).not.toBeNull();
    expect((el.querySelector('#file-title') as HTMLInputElement).value).toBe('contrat 2025');
  });

  it('aborts an upload in flight', async () => {
    await create(['employee_file.read', 'employee_file.upload']);
    click('[data-action="add-file"]');
    await settle();
    chooseFile(fakeFile('a.pdf', 'application/pdf'));
    fill('file-category', 'c-other');
    el.querySelector('[data-form="upload-file"]')?.dispatchEvent(new Event('submit'));
    await settle();
    const req = http.expectOne(LIST);
    click('[data-action="abort-upload"]');
    await settle();
    expect(req.cancelled).toBe(true);
    expect(text('[data-error="form"]')).toBe('Envoi interrompu : la pièce n’a pas été ajoutée.');
  });

  it('deletes after a confirmation with a reason, and can list deleted files (employee_file.delete)', async () => {
    await create(['employee_file.read', 'employee_file.delete']);
    click('[data-file="f-1"] [data-action="delete-file"]');
    await settle();
    const dialog = el.querySelector('dialog') as HTMLDialogElement;
    expect(dialog.open).toBe(true);
    expect(text('[data-field="delete-title"]')).toBe('Licence en droit');
    dialog.querySelector('form')?.dispatchEvent(new Event('submit'));
    await settle();
    expect(text('[data-error="reason"]')).toBe('Indiquez le motif.');
    http.expectNone(`${LIST}/f-1/delete`);

    const reason = el.querySelector('#file-delete-reason') as HTMLTextAreaElement;
    reason.value = '  Doublon  ';
    reason.dispatchEvent(new Event('input'));
    dialog.querySelector('form')?.dispatchEvent(new Event('submit'));
    const req = http.expectOne(`${LIST}/f-1/delete`);
    expect(req.request.body).toEqual({ reason: 'Doublon' });
    req.flush(null, { status: 204, statusText: 'No Content' });
    await settle();
    expect(dialog.open).toBe(false);
    expect(text('.feedback')).toBe('Pièce supprimée.');
    http.expectOne(LIST).flush(fileList());
    await settle();

    const toggle = el.querySelector('#file-show-deleted') as HTMLInputElement;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    await settle();
    const withDeleted = http.expectOne((r) => r.url === LIST && r.params.get('includeDeleted') === 'true');
    withDeleted.flush(
      fileList({
        items: [
          employeeFile({
            deleted: { at: '2026-09-29T08:00:00Z', by: { id: 'u', displayName: 'Karim Haddad' }, reason: 'Doublon' },
            _actions: [],
          }),
          employeeFile({ id: 'f-3', category: categoryRef(CAT_MEDICAL), purgedAt: '2026-09-01T02:00:00Z', _actions: [] }),
        ],
      }),
    );
    await settle();
    expect(text('[data-file="f-1"] [data-state="deleted"]')).toContain('Doublon');
    expect(el.querySelector('[data-file="f-1"] [data-action="download-file"]')).toBeNull();
    expect(el.querySelector('[data-file="f-3"] [data-state="purged"]')).not.toBeNull();
  });

  it('explains a delete refused because the file was deleted meanwhile, and refreshes the list', async () => {
    await create(['employee_file.read', 'employee_file.delete']);
    click('[data-file="f-1"] [data-action="delete-file"]');
    await settle();
    const reason = el.querySelector('#file-delete-reason') as HTMLTextAreaElement;
    reason.value = 'Erreur';
    reason.dispatchEvent(new Event('input'));
    el.querySelector('dialog form')?.dispatchEvent(new Event('submit'));
    http
      .expectOne(`${LIST}/f-1/delete`)
      .flush({ type: 'urn:hrforce:problem:employee-file-deleted', title: 'x', status: 409 }, { status: 409, statusText: 'Conflict' });
    await settle();
    expect(text('dialog [role="alert"]')).toBe('Cette pièce a déjà été supprimée.');
    http.expectOne(LIST).flush(fileList());
  });
});
