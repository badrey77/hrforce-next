import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { translocoTesting } from '../../../testing/transloco-testing';
import { todayIso } from '../../core/date/iso-date';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import type { OrgAction, OrgTree, OrgTreeNode, OrgUnitDetail } from '../../core/org/org.models';
import { ORGANIZATION_ROUTES } from './organization.routes';

function node(id: string, kind: OrgTreeNode['kind'], code: string, name: string, extra: Partial<OrgTreeNode> = {}): OrgTreeNode {
  return { id, kind, code, name, children: [], _actions: [], ...extra };
}

const ALL: OrgAction[] = ['update', 'create_child'];
const CENTRE = node('r-centre', 'region', 'CENTRE', 'Région Centre', {
  _actions: ALL,
  children: [node('s-blida', 'site', 'BLIDA', 'Blida', { _actions: ['update'] })],
});
const EST = node('r-est', 'region', 'EST', 'Région Est'); // no _actions
const ROOT = node('c-1', 'company', 'GROUPE', 'Groupe Démo', { _actions: ['create_child'], children: [CENTRE, EST] });

function tree(asOf: string, root: OrgTreeNode = ROOT): OrgTree {
  return { asOf, root };
}

function detailOf(n: OrgTreeNode, path: OrgUnitDetail['path'] = []): OrgUnitDetail {
  return {
    id: n.id,
    kind: n.kind,
    code: n.code,
    name: n.name,
    path,
    createdAt: '2024-01-01T08:00:00Z',
    versions: [{ validFrom: '2024-01-01', validTo: null, name: n.name, parentId: path.at(-1)?.id ?? null }],
    // oxlint-disable-next-line no-underscore-dangle -- `_actions` is the contract's field name
    _actions: n._actions,
  };
}

const isTree = (r: { url: string }) => r.url === '/api/org/tree';

/**
 * Let effects run (resources send their requests from effects), async work (router navigation) finish, and the
 * view re-render. Not `fixture.whenStable()`: it also waits for in-flight httpResource requests, which only
 * complete when the test flushes them.
 */
async function settle(): Promise<void> {
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
}

describe('OrganizationPage', () => {
  let harness: RouterTestingHarness;
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [translocoTesting()],
      providers: [
        provideRouter([{ path: 'organization', children: ORGANIZATION_ROUTES }], withComponentInputBinding()),
        provideHttpClient(withInterceptors([apiProblemInterceptor])),
        provideHttpClientTesting(),
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    harness = await RouterTestingHarness.create();
  });

  afterEach(() => http.verify());

  const el = () => harness.routeNativeElement as HTMLElement;

  async function open(url: string, root: OrgTreeNode = ROOT): Promise<void> {
    await harness.navigateByUrl(url);
    await settle();
    const req = http.expectOne(isTree);
    req.flush(tree(req.request.params.get('asOf') ?? '', root));
    await settle();
  }

  function button(text: string): HTMLButtonElement {
    const found = [...el().querySelectorAll('button')].find((b) => b.textContent?.includes(text));
    if (!found) throw new Error(`no button "${text}"`);
    return found;
  }

  async function select(n: OrgTreeNode, path: OrgUnitDetail['path'] = []): Promise<void> {
    button(n.name).click();
    await settle();
    http.expectOne(`/api/org/units/${n.id}`).flush(detailOf(n, path));
    await settle();
  }

  function fill(id: string, value: string): void {
    const input = el().querySelector(`#${id}`);
    if (!(input instanceof HTMLInputElement)) throw new Error(`missing #${id}`);
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }

  async function submit(): Promise<void> {
    el().querySelector('form')?.dispatchEvent(new Event('submit'));
    await settle();
  }

  it('asks for the tree as of the asOf query param and renders it', async () => {
    await harness.navigateByUrl('/organization?asOf=2025-03-31');
    await settle();
    const req = http.expectOne(isTree);
    expect(req.request.urlWithParams).toBe('/api/org/tree?asOf=2025-03-31');
    expect(el().textContent).toContain("Chargement de l'organisation…");
    req.flush(tree('2025-03-31'));
    await settle();

    const labels = [...el().querySelectorAll('app-org-tree-item .node')].map((b) => b.textContent?.trim());
    expect(labels).toEqual(['Société GROUPE Groupe Démo', 'Région CENTRE Région Centre', 'Site BLIDA Blida', 'Région EST Région Est']);
    expect((el().querySelector('#org-as-of') as HTMLInputElement).value).toBe('2025-03-31');
    expect(el().textContent).toContain('Sélectionnez une unité');
  });

  it('defaults to today and puts a picked date into the URL', async () => {
    await harness.navigateByUrl('/organization');
    await settle();
    const first = http.expectOne(isTree);
    expect(first.request.params.get('asOf')).toBe(todayIso());
    first.flush(tree(todayIso()));
    await settle();

    const date = el().querySelector('#org-as-of') as HTMLInputElement;
    date.value = '2024-12-31';
    date.dispatchEvent(new Event('change'));
    await settle();

    expect(TestBed.inject(Router).url).toBe('/organization?asOf=2024-12-31');
    http.expectOne((r) => isTree(r) && r.params.get('asOf') === '2024-12-31').flush(tree('2024-12-31'));
  });

  it('collapses and expands a node', async () => {
    await open('/organization?asOf=2025-03-31');
    const toggle = el().querySelector('.toggle[aria-expanded]') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    toggle.click();
    await settle();

    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(el().textContent).not.toContain('Région Centre');
  });

  it('shows an error with retry when the tree fails to load', async () => {
    await harness.navigateByUrl('/organization?asOf=2025-03-31');
    await settle();
    http.expectOne(isTree).flush({ type: 'about:blank', title: 'Boom', status: 500 }, { status: 500, statusText: 'Server Error' });
    await settle();

    expect(el().querySelector('[role="alert"]')?.textContent).toContain("Impossible de charger l'organisation.");
    button('Réessayer').click();
    await settle();
    http.expectOne(isTree).flush(tree('2025-03-31'));
  });

  it('shows the selected unit with its versions, and only the actions it allows', async () => {
    await open('/organization?asOf=2025-03-31');

    await select(EST, [{ id: 'c-1', name: 'Groupe Démo' }]);
    expect(el().querySelector('app-unit-detail h2')?.textContent).toContain('Région Est');
    expect(el().querySelectorAll('app-unit-detail tbody tr')).toHaveLength(1);
    expect(el().querySelector('app-unit-detail tbody')?.textContent).toContain('Groupe Démo');
    expect(el().querySelector('[data-action]')).toBeNull();

    await select(ROOT);
    expect(el().querySelector('[data-action="create"]')).not.toBeNull();
    expect(el().querySelector('[data-action="change"]')).toBeNull();
  });

  it('maps a 409 errors[] on code to the code field', async () => {
    await open('/organization?asOf=2025-03-31');
    await select(CENTRE, [{ id: 'c-1', name: 'Groupe Démo' }]);
    button('Ajouter une sous-unité').click();
    await settle();

    expect((el().querySelector('#create-unit-valid-from') as HTMLInputElement).value).toBe('2025-03-31');
    fill('create-unit-code', 'BLIDA');
    fill('create-unit-name', ' Blida 2 ');
    await submit();

    const post = http.expectOne('/api/org/units');
    expect(post.request.body).toEqual({
      kind: 'site',
      code: 'BLIDA',
      name: 'Blida 2',
      parentId: 'r-centre',
      validFrom: '2025-03-31',
    });
    post.flush(
      {
        type: 'urn:hrforce:problem:org-unit-code-taken',
        title: 'Conflict',
        status: 409,
        errors: [{ field: 'code', code: 'taken', message: 'Ce code existe déjà.' }],
      },
      { status: 409, statusText: 'Conflict' },
    );
    await settle();

    expect(el().querySelector('#create-unit-code-error')?.textContent?.trim()).toBe('Ce code existe déjà.');
    expect(el().querySelector('#create-unit-code')?.getAttribute('aria-invalid')).toBe('true');
    expect(el().querySelector('form [role="alert"]')).toBeNull();
  });

  it('shows a 409 without field as a form-level message', async () => {
    await open('/organization?asOf=2025-03-31');
    await select(CENTRE, [{ id: 'c-1', name: 'Groupe Démo' }]);
    button('Ajouter une sous-unité').click();
    await settle();
    fill('create-unit-code', 'MEDEA');
    fill('create-unit-name', 'Médéa');
    await submit();

    http
      .expectOne('/api/org/units')
      .flush(
        { type: 'urn:hrforce:problem:org-unit-version-overlap', title: 'Conflict', status: 409 },
        { status: 409, statusText: 'Conflict' },
      );
    await settle();

    expect(el().querySelector('form [role="alert"]')?.textContent).toContain('Une autre version commence déjà');
  });

  it('after a create, refreshes the tree and selects the new unit', async () => {
    await open('/organization?asOf=2025-03-31');
    await select(CENTRE, [{ id: 'c-1', name: 'Groupe Démo' }]);
    button('Ajouter une sous-unité').click();
    await settle();
    fill('create-unit-code', 'MEDEA');
    fill('create-unit-name', 'Médéa');
    await submit();

    const medea = node('s-medea', 'site', 'MEDEA', 'Médéa', { _actions: ['update'] });
    http.expectOne('/api/org/units').flush(detailOf(medea), { status: 201, statusText: 'Created' });
    await settle();

    http.expectOne(isTree).flush(tree('2025-03-31', { ...ROOT, children: [{ ...CENTRE, children: [...CENTRE.children, medea] }, EST] }));
    http.expectOne('/api/org/units/s-medea').flush(detailOf(medea));
    await settle();

    expect(el().querySelector('[role="status"]')?.textContent).toContain('Unité « Médéa » créée.');
    expect(el().querySelector('app-unit-detail h2')?.textContent).toContain('Médéa');
    expect(el().querySelector('[data-action="change"]')).not.toBeNull();
  });

  it('change form sends only what changed and refreshes tree and detail', async () => {
    await open('/organization?asOf=2025-03-31');
    const blida = CENTRE.children[0] as OrgTreeNode;
    await select(blida, [
      { id: 'c-1', name: 'Groupe Démo' },
      { id: 'r-centre', name: 'Région Centre' },
    ]);
    button('Modifier').click();
    await settle();
    // The parent picker labels its preset value (the current parent).
    http.expectOne('/api/org/units/r-centre').flush(detailOf(CENTRE, [{ id: 'c-1', name: 'Groupe Démo' }]));
    await settle();
    expect((el().querySelector('#change-unit-parent') as HTMLInputElement).value).toBe('Région Centre (CENTRE)');

    await submit();
    expect(el().querySelector('form [role="alert"]')?.textContent).toContain("Modifiez le nom ou l'unité parente.");

    fill('change-unit-name', 'Blida Centre');
    await submit();
    const patch = http.expectOne('/api/org/units/s-blida');
    expect(patch.request.method).toBe('PATCH');
    expect(patch.request.body).toEqual({ name: 'Blida Centre', validFrom: '2025-03-31' });
    patch.flush(detailOf({ ...blida, name: 'Blida Centre' }));
    await settle();

    http.expectOne(isTree).flush(tree('2025-03-31'));
    http.expectOne('/api/org/units/s-blida').flush(detailOf({ ...blida, name: 'Blida Centre' }));
    await settle();
    expect(el().querySelector('[role="status"]')?.textContent).toContain('Blida Centre');
  });
});
