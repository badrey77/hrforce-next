import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { meWith } from '../../../../testing/auth-fixtures';
import { installDialogPolyfill } from '../../../../testing/dialog-polyfill';
import { DOCUMENT_TYPES } from '../../../../testing/document-fixtures';
import { TYPE_OM, templateVersion, typeTemplates, VARIABLES } from '../../../../testing/template-fixtures';
import { translocoTesting } from '../../../../testing/transloco-testing';
import { Session } from '../../../core/auth/session';
import { apiProblemInterceptor } from '../../../core/http/api-problem.interceptor';
import type { TypeTemplates } from '../../../core/documents/documents.models';
import fr from '../../../../../public/i18n/fr.json';
import { AUTOSAVE_MS, initialVersion, TEMPLATE_ERROR_CODES, TemplateDesignerPage, templateProblemKey } from './template-designer.page';

function emptyRects(): DOMRectList {
  return { length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] } as unknown as DOMRectList;
}

beforeAll(() => {
  Element.prototype.getClientRects ??= emptyRects;
  Range.prototype.getClientRects ??= emptyRects;
  Range.prototype.getBoundingClientRect ??= () => new DOMRect();
});

async function settle(): Promise<void> {
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
}

const PROBLEM = 'application/problem+json';

describe('template designer helpers', () => {
  it('opens the asked version, else the draft, else the published one', () => {
    const items = typeTemplates().items;
    expect(initialVersion(items, 'tv-om-1')?.id).toBe('tv-om-1');
    expect(initialVersion(items, undefined)?.id).toBe('tv-om-2');
    expect(initialVersion(items.filter((v) => v.status !== 'draft'), undefined)?.id).toBe('tv-om-1');
    expect(initialVersion([], undefined)).toBeNull();
  });

  it('has a message for every validation code it claims to translate', () => {
    expect([...TEMPLATE_ERROR_CODES].toSorted()).toEqual(Object.keys(fr.documents.templates.codes).toSorted());
  });
});

describe('TemplateDesignerPage', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;
  let templates: TypeTemplates;

  beforeEach(async () => {
    installDialogPolyfill();
    templates = typeTemplates();
    await TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [
        provideRouter([{ path: 'documents/settings/templates/:typeId', component: TemplateDesignerPage }], withComponentInputBinding()),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(Session).set(meWith(['document.configure', 'document.design', 'document.issue', 'document.read']));
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => http.verify());

  const el = () => harness.routeNativeElement as HTMLElement;
  const q = (selector: string) => el().querySelector(selector) as HTMLElement | null;

  async function answer(extra: (req: TestRequest) => boolean = () => false): Promise<void> {
    for (let round = 0; round < 5; round++) {
      await settle();
      for (const req of http.match(() => true)) {
        if (req.cancelled) continue;
        const { url, method } = req.request;
        if (extra(req)) continue;
        if (url === '/api/documents/types' && method === 'GET') req.flush({ items: [...DOCUMENT_TYPES, TYPE_OM] });
        else if (url === '/api/documents/types/dt-om/templates' && method === 'GET') req.flush(templates);
        else if (url === '/api/documents/template-variables') req.flush({ items: VARIABLES });
        else if (url === '/api/documents/templates/tv-om-2' && method === 'GET') req.flush(templateVersion());
        else if (url === '/api/documents/templates/tv-om-1' && method === 'GET')
          req.flush(templateVersion({ id: 'tv-om-1', version: 1, status: 'published', _actions: ['duplicate'] }));
      }
    }
    harness.detectChanges();
  }

  async function open(url = '/documents/settings/templates/dt-om'): Promise<void> {
    await harness.navigateByUrl(url);
    await answer();
  }

  function addParagraph(): void {
    (q('[data-add="paragraph"]') as HTMLButtonElement).click();
    harness.detectChanges();
  }

  it('opens the draft in the designer with its blocks and placeholders', async () => {
    await open();
    expect(q('[data-field="version"]')?.textContent).toContain('Version 2');
    expect(q('[data-template-status="draft"]')).not.toBeNull();
    expect(el().querySelectorAll('[data-block-id]')).toHaveLength(3);
    expect(q('[data-insert="employee.fullName"]')).not.toBeNull();
    expect(q('[data-insert="field.destination"]')).not.toBeNull();
  });

  it('saves with the revision on « Enregistrer », then counts the next revision', async () => {
    await open();
    addParagraph();
    expect(q('[data-save="pending"]')).not.toBeNull();
    (q('[data-action="save"]') as HTMLButtonElement).click();
    const put = http.expectOne((r) => r.method === 'PUT' && r.url === '/api/documents/templates/tv-om-2');
    expect(put.request.body.revision).toBe(4);
    expect(put.request.body.layouts.fr.blocks).toHaveLength(4);
    expect(put.request.body.fields).toEqual(templateVersion().fields);
    put.flush(templateVersion({ revision: 5 }));
    await settle();
    harness.detectChanges();
    expect(q('[data-save="saved"]')).not.toBeNull();

    addParagraph();
    (q('[data-action="save"]') as HTMLButtonElement).click();
    const again = http.expectOne((r) => r.method === 'PUT');
    expect(again.request.body.revision).toBe(5);
    again.flush(templateVersion({ revision: 6 }));
  });

  it('autosaves 3 s after the last change', async () => {
    await open();
    vi.useFakeTimers();
    try {
      addParagraph();
      vi.advanceTimersByTime(AUTOSAVE_MS - 100);
      http.expectNone((r) => r.method === 'PUT');
      addParagraph();
      vi.advanceTimersByTime(AUTOSAVE_MS - 100);
      http.expectNone((r) => r.method === 'PUT');
      vi.advanceTimersByTime(200);
      const put = http.expectOne((r) => r.method === 'PUT');
      expect(put.request.body.layouts.fr.blocks).toHaveLength(5);
      put.flush(templateVersion({ revision: 5 }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the conflict banner on a stale revision and reloads the version', async () => {
    await open();
    addParagraph();
    (q('[data-action="save"]') as HTMLButtonElement).click();
    http
      .expectOne((r) => r.method === 'PUT')
      .flush(
        { type: 'urn:hrforce:problem:document-template-changed', title: 'Changed', status: 409 },
        { status: 409, statusText: 'Conflict', headers: { 'content-type': PROBLEM } },
      );
    await settle();
    harness.detectChanges();
    expect(q('[data-state="conflict"]')?.textContent).toContain('modifié ailleurs');
    (q('[data-action="reload"]') as HTMLButtonElement).click();
    await answer();
    expect(q('[data-state="conflict"]')).toBeNull();
    expect(el().querySelectorAll('[data-block-id]')).toHaveLength(3);
  });

  it('lists 422 problems and highlights their block', async () => {
    await open();
    addParagraph();
    (q('[data-action="save"]') as HTMLButtonElement).click();
    http.expectOne((r) => r.method === 'PUT').flush(
      {
        type: 'urn:hrforce:problem:validation-error',
        title: 'Invalid',
        status: 422,
        errors: [
          { field: 'layouts.fr.blocks.1.content.2', code: 'unknown_variable', message: 'Unknown placeholder' },
          { field: 'layouts.fr', code: 'some_new_code', message: 'A message without a translation' },
        ],
      },
      { status: 422, statusText: 'Unprocessable', headers: { 'content-type': PROBLEM } },
    );
    await settle();
    harness.detectChanges();
    // a known code is shown in the UI language; an unknown one keeps the API's text
    expect(q('[data-problems]')?.textContent).toContain('Ce champ à insérer n’existe pas pour ce type de document.');
    expect(q('[data-problems]')?.textContent).not.toContain('Unknown placeholder');
    expect(q('[data-problems]')?.textContent).toContain('A message without a translation');
    expect(q('[data-block-id="p1"]')?.classList).toContain('dd-has-problem');
    expect(q('[data-error="save"]')?.textContent).toContain('Le modèle contient des problèmes');
  });

  it('publishes with a note, then opens the published version read-only', async () => {
    await open();
    (q('[data-action="publish"]') as HTMLButtonElement).click();
    harness.detectChanges();
    const note = q('#publish-note') as HTMLTextAreaElement;
    note.value = 'Nouvelle formule';
    note.dispatchEvent(new Event('input'));
    (q('[data-action="confirm-publish"]') as HTMLButtonElement).click();
    const post = http.expectOne((r) => r.method === 'POST' && r.url === '/api/documents/templates/tv-om-2/publish');
    expect(post.request.body).toEqual({ revision: 4, note: 'Nouvelle formule' });
    post.flush(templateVersion({ status: 'published', _actions: ['duplicate'] }));
    templates = typeTemplates({ items: typeTemplates().items.filter((v) => v.status === 'draft').map((v) => ({ ...v, status: 'published' as const })) });
    await answer();
    expect(q('.feedback')?.textContent).toContain('Modèle publié.');
    expect(q('[data-state="readonly"]')).not.toBeNull();
    expect(q('[data-add]')).toBeNull();
  });

  it('shows why publishing failed', async () => {
    await open();
    (q('[data-action="publish"]') as HTMLButtonElement).click();
    (q('[data-action="confirm-publish"]') as HTMLButtonElement).click();
    http
      .expectOne((r) => r.url.endsWith('/publish'))
      .flush({ type: 'urn:hrforce:problem:document-template-too-long', title: 'Too long', status: 422 }, { status: 422, statusText: 'x', headers: { 'content-type': PROBLEM } });
    await settle();
    harness.detectChanges();
    expect(q('[data-error="publish"]')?.textContent).toContain('dépasserait 5 pages');
  });

  it('discards the draft after confirmation and falls back to the published version', async () => {
    await open();
    (q('[data-action="discard"]') as HTMLButtonElement).click();
    (q('[data-action="confirm-discard"]') as HTMLButtonElement).click();
    http.expectOne((r) => r.method === 'DELETE' && r.url === '/api/documents/templates/tv-om-2').flush(null);
    templates = typeTemplates({ items: typeTemplates().items.filter((v) => v.status !== 'draft') });
    await answer();
    expect(q('.feedback')?.textContent).toContain('Brouillon abandonné.');
    expect(q('[data-template-status="published"]')).not.toBeNull();
  });

  it('creates a draft from a read-only published version', async () => {
    templates = typeTemplates({ items: typeTemplates().items.filter((v) => v.status !== 'draft') });
    await open();
    expect(q('[data-state="readonly"]')).not.toBeNull();
    (q('[data-action="duplicate"]') as HTMLButtonElement).click();
    const post = http.expectOne((r) => r.method === 'POST' && r.url === '/api/documents/types/dt-om/templates');
    expect(post.request.body).toEqual({ from: 'tv-om-1' });
    post.flush(templateVersion({ id: 'tv-om-3', version: 3 }));
    await answer();
    expect(q('[data-add="paragraph"]')).not.toBeNull();
  });

  it('starts a custom type without versions from a blank page', async () => {
    templates = { mode: 'designed', builtin: null, items: [] };
    await open();
    expect(q('[data-state="start"]')).not.toBeNull();
    expect(q('[data-action="start-builtin"]')).toBeNull();
    (q('[data-action="start-blank"]') as HTMLButtonElement).click();
    const post = http.expectOne((r) => r.method === 'POST' && r.url === '/api/documents/types/dt-om/templates');
    expect(post.request.body).toEqual({ from: 'blank' });
    post.flush(templateVersion({ layouts: {} }));
    await answer();
    expect(q('[data-state="no-layout"]')).not.toBeNull();
    (q('[data-action="layout-blank"]') as HTMLButtonElement).click();
    harness.detectChanges();
    expect(q('[data-canvas]')).not.toBeNull();
  });

  it('previews the saved draft as a PDF in a new tab', async () => {
    const tab = { document: { title: '' }, location: { href: '' }, opener: {}, close: vi.fn() };
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    try {
      await open();
      (q('dd-document-designer [data-action="preview"]') as HTMLButtonElement).click();
      const post = http.expectOne((r) => r.url === '/api/documents/templates/tv-om-2/preview');
      expect(post.request.body).toEqual({ lang: 'fr', sample: true });
      post.flush(new Blob(['%PDF'], { type: 'application/pdf' }));
      await settle();
      expect(openSpy).toHaveBeenCalled();
    } finally {
      openSpy.mockRestore();
    }
  });

  it('asks before leaving with unsaved changes', async () => {
    await open();
    const page = harness.routeDebugElement?.componentInstance as TemplateDesignerPage;
    expect(page.canLeave()).toBe(true);
    addParagraph();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    expect(page.canLeave()).toBe(false);
    expect(confirm).toHaveBeenCalledWith('Des modifications ne sont pas encore enregistrées. Quitter quand même ?');
    confirm.mockRestore();
  });

  it('offers only the versions and previews on a narrow screen', async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia;
    try {
      await open();
      expect(q('[data-state="narrow"]')).not.toBeNull();
      expect(q('dd-document-designer')).toBeNull();
      expect(q('[data-action="preview-fr"]')).not.toBeNull();
    } finally {
      window.matchMedia = original;
    }
  });

  it('maps template problems to messages', () => {
    expect(templateProblemKey(new Error('x'))).toBe('errors.generic');
  });
});
