import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { ORG_KIND_LIST, SITE_ANNABA, SITE_CNE, SITE_HQ, SITES } from '../../../testing/org-fixtures';
import { translocoTesting } from '../../../testing/transloco-testing';
import { todayIso } from '../../core/date/iso-date';
import { apiProblemInterceptor } from '../../core/http/api-problem.interceptor';
import { LanguageService } from '../../core/i18n/language.service';
import type { OrgAction, OrgTree, OrgTreeNode, OrgUnitDetail, SiteRef } from '../../core/org/org.models';
import { ORG_UNIT_PICKER_DEBOUNCE_MS } from '../../shared/org-unit-picker/org-unit-picker';
import { ORGANIZATION_ROUTES } from './organization.routes';

const ref = ({ id, code, name }: SiteRef): SiteRef => ({ id, code, name });

function node(
  id: string,
  kind: string,
  code: string,
  name: string,
  site: SiteRef | null,
  extra: Partial<OrgTreeNode> = {},
): OrgTreeNode {
  return { id, kind, code, name, site, children: [], _actions: [], ...extra };
}

const ALL: OrgAction[] = ['update', 'create_child'];
const HQ = ref(SITE_HQ);
const CNE = ref(SITE_CNE);
const ANNABA = ref(SITE_ANNABA);

// A slice of the contract's seed tree.
const SRV_PAIE = node('s-paie', 'service', 'SRV-PAIE', 'Service Paie', HQ, { _actions: ['update'] });
const DEP_RH = node('d-rh', 'department', 'DEP-RH', 'Département RH', HQ, { _actions: ALL, children: [SRV_PAIE] });
const DEP_FIN = node('d-fin', 'department', 'DEP-FIN', 'Département Finances', HQ); // no _actions
// A service that (wrongly) says create_child: the catalogue allows no child kind, so no create button.
const SRV_CLI = node('s-cli', 'service', 'SRV-CLI-ANB', 'Service Clientèle', ANNABA, { _actions: ALL });
const AG_ANNABA = node('a-annaba', 'agency', 'AG-ANNABA', 'Agence Annaba', ANNABA, { _actions: ALL, children: [SRV_CLI] });
const REG_EST = node('r-est', 'region', 'REG-EST', 'Région Est', CNE, { _actions: ALL, children: [AG_ANNABA] });
const DEP_RX = node('d-rx', 'department', 'DEP-RX', 'Département RX', HQ, { _actions: ALL, children: [REG_EST] });
const ROOT = node('dg', 'direction_generale', 'DG', 'Direction Générale', HQ, {
  _actions: ALL,
  children: [DEP_RH, DEP_FIN, DEP_RX],
});

const P_DG = { id: 'dg', name: 'Direction Générale' };
const P_RX = { id: 'd-rx', name: 'Département RX' };
const P_EST = { id: 'r-est', name: 'Région Est' };

function tree(asOf: string, root: OrgTreeNode = ROOT): OrgTree {
  return { asOf, root };
}

function detailOf(
  n: OrgTreeNode,
  path: OrgUnitDetail['path'] = [],
  extra: Partial<OrgUnitDetail> = {},
): OrgUnitDetail {
  const siteInherited = extra.siteInherited ?? false;
  return {
    id: n.id,
    kind: n.kind,
    code: n.code,
    name: n.name,
    site: n.site,
    siteInherited,
    path,
    createdAt: '2024-01-01T08:00:00Z',
    versions: [
      {
        validFrom: '2024-01-01',
        validTo: null,
        name: n.name,
        parentId: path.at(-1)?.id ?? null,
        siteId: siteInherited ? null : (n.site?.id ?? null),
      },
    ],
    // oxlint-disable-next-line no-underscore-dangle -- `_actions` is the contract's field name
    _actions: n._actions,
    ...extra,
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

  /** The page's reference data: the kind catalogue (once per app) and the sites list (once per page). */
  function flushReferenceData(): void {
    http.expectOne('/api/org/kinds').flush(ORG_KIND_LIST);
    http.expectOne((r) => r.url === '/api/org/sites').flush({ items: SITES });
  }

  async function open(url: string, root: OrgTreeNode = ROOT): Promise<void> {
    await harness.navigateByUrl(url);
    await settle();
    const req = http.expectOne(isTree);
    req.flush(tree(req.request.params.get('asOf') ?? '', root));
    flushReferenceData();
    await settle();
  }

  function button(text: string): HTMLButtonElement {
    const found = [...el().querySelectorAll('button')].find((b) => b.textContent?.includes(text));
    if (!found) throw new Error(`no button "${text}"`);
    return found;
  }

  async function select(n: OrgTreeNode, path: OrgUnitDetail['path'] = [], extra: Partial<OrgUnitDetail> = {}): Promise<void> {
    button(n.name).click();
    await settle();
    http.expectOne(`/api/org/units/${n.id}`).flush(detailOf(n, path, extra));
    await settle();
  }

  function fill(id: string, value: string): void {
    const input = el().querySelector(`#${id}`);
    if (!(input instanceof HTMLInputElement)) throw new Error(`missing #${id}`);
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }

  function selectEl(id: string): HTMLSelectElement {
    const found = el().querySelector(`#${id}`);
    if (!(found instanceof HTMLSelectElement)) throw new Error(`missing select #${id}`);
    return found;
  }

  function optionTexts(id: string): string[] {
    return [...selectEl(id).options].map((o) => o.textContent?.trim() ?? '');
  }

  function choose(id: string, optionText: string): void {
    const sel = selectEl(id);
    const index = [...sel.options].findIndex((o) => o.textContent?.includes(optionText));
    if (index < 0) throw new Error(`no option "${optionText}" in #${id}`);
    sel.selectedIndex = index;
    sel.dispatchEvent(new Event('change'));
  }

  async function submit(): Promise<void> {
    el().querySelector('form')?.dispatchEvent(new Event('submit'));
    await settle();
  }

  it('asks for the tree as of the asOf query param and renders kind labels from the catalogue', async () => {
    await harness.navigateByUrl('/organization?asOf=2025-03-31');
    await settle();
    const req = http.expectOne(isTree);
    expect(req.request.urlWithParams).toBe('/api/org/tree?asOf=2025-03-31');
    expect(el().textContent).toContain("Chargement de l'organisation…");
    req.flush(tree('2025-03-31'));
    flushReferenceData();
    await settle();

    const labels = [...el().querySelectorAll('app-org-tree-item .node')].map((b) => b.textContent?.replace(/\s+/g, ' ').trim());
    // API order is kept; a row shows its site only where it differs from the parent's.
    expect(labels).toEqual([
      'Direction générale DG Direction Générale Alger – Siège',
      'Département DEP-RH Département RH',
      'Service SRV-PAIE Service Paie',
      'Département DEP-FIN Département Finances',
      'Département DEP-RX Département RX',
      'Région REG-EST Région Est Constantine',
      'Agence AG-ANNABA Agence Annaba Annaba',
      'Service SRV-CLI-ANB Service Clientèle',
    ]);
    expect((el().querySelector('#org-as-of') as HTMLInputElement).value).toBe('2025-03-31');
    expect(el().textContent).toContain('Sélectionnez une unité');
  });

  it('switches kind labels with the language, without re-fetching the catalogue', async () => {
    await open('/organization?asOf=2025-03-31');
    TestBed.inject(LanguageService).use('ar');
    await settle();

    expect(el().querySelector('app-org-tree-item .badge')?.textContent).toBe('المديرية العامة');
    http.expectNone('/api/org/kinds');
    TestBed.inject(LanguageService).use('fr');
  });

  it('defaults to today and puts a picked date into the URL', async () => {
    await harness.navigateByUrl('/organization');
    await settle();
    const first = http.expectOne(isTree);
    expect(first.request.params.get('asOf')).toBe(todayIso());
    first.flush(tree(todayIso()));
    flushReferenceData();
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
    expect(el().textContent).not.toContain('Département RH');
  });

  it('shows an error with retry when the tree fails to load', async () => {
    await harness.navigateByUrl('/organization?asOf=2025-03-31');
    await settle();
    http.expectOne(isTree).flush({ type: 'about:blank', title: 'Boom', status: 500 }, { status: 500, statusText: 'Server Error' });
    flushReferenceData();
    await settle();

    expect(el().querySelector('[role="alert"]')?.textContent).toContain("Impossible de charger l'organisation.");
    button('Réessayer').click();
    await settle();
    http.expectOne(isTree).flush(tree('2025-03-31'));
  });

  it('shows the selected unit with its effective site, versions with a site column, and only allowed actions', async () => {
    await open('/organization?asOf=2025-03-31');

    await select(DEP_FIN, [P_DG], { siteInherited: true });
    expect(el().querySelector('app-unit-detail h2')?.textContent).toContain('Département Finances');
    const site = el().querySelector('app-unit-detail [data-field="site"]')?.textContent?.replace(/\s+/g, ' ');
    expect(site).toContain('Alger – Siège (ALG-HQ)');
    expect(site).toContain("hérité d'une unité parente");
    const cells = [...el().querySelectorAll('app-unit-detail tbody td')].map((td) => td.textContent?.trim());
    expect(cells).toEqual(['2024-01-01', 'En cours', 'Département Finances', 'Direction Générale', 'Hérité']);
    expect(el().querySelector('[data-action]')).toBeNull();

    await select(REG_EST, [P_DG, P_RX]);
    expect(el().querySelector('app-unit-detail tbody')?.textContent).toContain('Constantine (CNE)');
    expect(el().querySelector('app-unit-detail [data-field="site"]')?.textContent).not.toContain('hérité');
    expect(el().querySelector('[data-action="create"]')).not.toBeNull();
    expect(el().querySelector('[data-action="change"]')).not.toBeNull();
  });

  it('hides "add a sub-unit" when the catalogue allows no child kind, even with create_child', async () => {
    await open('/organization?asOf=2025-03-31');
    await select(SRV_CLI, [P_DG, P_RX, P_EST, { id: 'a-annaba', name: 'Agence Annaba' }], { siteInherited: true });

    expect(el().querySelector('[data-action="create"]')).toBeNull();
    expect(el().querySelector('[data-action="change"]')).not.toBeNull();
  });

  it('offers the kinds allowed under the selected parent', async () => {
    await open('/organization?asOf=2025-03-31');

    await select(ROOT);
    button('Ajouter une sous-unité').click();
    await settle();
    expect(optionTexts('create-unit-kind')).toEqual(['Département']);
    expect(selectEl('create-unit-kind').value).toBe('department'); // single choice → preselected

    await select(REG_EST, [P_DG, P_RX]);
    button('Ajouter une sous-unité').click();
    await settle();
    expect(optionTexts('create-unit-kind')).toEqual(['Choisir un type', 'Agence', 'Service']);

    await select(AG_ANNABA, [P_DG, P_RX, P_EST]);
    button('Ajouter une sous-unité').click();
    await settle();
    expect(optionTexts('create-unit-kind')).toEqual(['Service']);
  });

  it('create form: site defaults to "inherit" (null); a 409 errors[] on code lands on the code field', async () => {
    await open('/organization?asOf=2025-03-31');
    await select(REG_EST, [P_DG, P_RX]);
    button('Ajouter une sous-unité').click();
    await settle();

    expect((el().querySelector('#create-unit-valid-from') as HTMLInputElement).value).toBe('2025-03-31');
    expect(optionTexts('create-unit-site')).toEqual([
      "Hériter de l'unité parente — Constantine",
      'Alger – Siège (ALG-HQ)',
      'Annaba (ANNABA)',
      'Constantine (CNE)',
    ]);

    // Several kinds possible: submitting without choosing one is refused client-side.
    fill('create-unit-code', 'AG-CNE');
    fill('create-unit-name', ' Agence Constantine ');
    await submit();
    expect(el().querySelector('#create-unit-kind-error')?.textContent?.trim()).toBe('Ce champ est obligatoire.');
    http.expectNone('/api/org/units');

    choose('create-unit-kind', 'Agence');
    await submit();
    const post = http.expectOne('/api/org/units');
    expect(post.request.body).toEqual({
      kind: 'agency',
      code: 'AG-CNE',
      name: 'Agence Constantine',
      parentId: 'r-est',
      siteId: null,
      validFrom: '2025-03-31',
    });
    post.flush(
      {
        type: 'urn:hrforce:problem:org-unit-code-taken',
        title: 'Conflict',
        status: 409,
        errors: [{ field: 'code', code: 'taken', message: 'Code already used.' }],
      },
      { status: 409, statusText: 'Conflict' },
    );
    await settle();

    expect(el().querySelector('#create-unit-code-error')?.textContent?.trim()).toBe('Ce code est déjà utilisé.');
    expect(el().querySelector('#create-unit-code')?.getAttribute('aria-invalid')).toBe('true');
    expect(el().querySelector('form [role="alert"]')).toBeNull();
  });

  it('create form sends a chosen site, and maps a 409 site-not-found (no errors[]) to the site field', async () => {
    await open('/organization?asOf=2025-03-31');
    await select(REG_EST, [P_DG, P_RX]);
    button('Ajouter une sous-unité').click();
    await settle();
    choose('create-unit-kind', 'Agence');
    fill('create-unit-code', 'AG-ANB2');
    fill('create-unit-name', 'Agence Annaba 2');
    choose('create-unit-site', 'Annaba (ANNABA)');
    await submit();

    const post = http.expectOne('/api/org/units');
    expect(post.request.body).toMatchObject({ kind: 'agency', siteId: 's-annaba' });
    post.flush(
      { type: 'urn:hrforce:problem:site-not-found', title: 'Conflict', status: 409 },
      { status: 409, statusText: 'Conflict' },
    );
    await settle();

    expect(el().querySelector('#create-unit-site-error')?.textContent?.trim()).toBe("Ce site n'existe pas ou plus.");
    expect(el().querySelector('form [role="alert"]')).toBeNull();
  });

  it('shows a 409 without field as a form-level message', async () => {
    await open('/organization?asOf=2025-03-31');
    await select(AG_ANNABA, [P_DG, P_RX, P_EST]);
    button('Ajouter une sous-unité').click();
    await settle();
    fill('create-unit-code', 'SRV-X');
    fill('create-unit-name', 'Service X');
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
    await select(AG_ANNABA, [P_DG, P_RX, P_EST]);
    button('Ajouter une sous-unité').click();
    await settle();
    fill('create-unit-code', 'SRV-X');
    fill('create-unit-name', 'Service X');
    await submit();

    const created = node('s-x', 'service', 'SRV-X', 'Service X', ANNABA, { _actions: ['update'] });
    http.expectOne('/api/org/units').flush(detailOf(created, [], { siteInherited: true }), { status: 201, statusText: 'Created' });
    await settle();

    http.expectOne(isTree).flush(tree('2025-03-31'));
    http.expectOne('/api/org/units/s-x').flush(detailOf(created, [], { siteInherited: true }));
    await settle();

    expect(el().querySelector('[role="status"]')?.textContent).toContain('Unité « Service X » créée.');
    expect(el().querySelector('app-unit-detail h2')?.textContent).toContain('Service X');
    expect(el().querySelector('[data-action="change"]')).not.toBeNull();
  });

  it('change form sends only what changed, including "inherit" as siteId null, and refreshes', async () => {
    await open('/organization?asOf=2025-03-31');
    await select(REG_EST, [P_DG, P_RX]);
    button('Modifier').click();
    await settle();
    // The parent picker labels its preset value (the current parent).
    http.expectOne('/api/org/units/d-rx').flush(detailOf(DEP_RX, [P_DG]));
    await settle();
    expect((el().querySelector('#change-unit-parent') as HTMLInputElement).value).toBe('Département RX (DEP-RX)');
    expect(selectEl('change-unit-site').selectedOptions[0]?.textContent?.trim()).toBe('Constantine (CNE)');
    expect(optionTexts('change-unit-site')[0]).toBe("Hériter de l'unité parente");

    await submit();
    expect(el().querySelector('form [role="alert"]')?.textContent).toContain("Modifiez le nom, l'unité parente ou le site.");

    fill('change-unit-name', 'Région Est-Sud');
    choose('change-unit-site', "Hériter de l'unité parente");
    await submit();
    const patch = http.expectOne('/api/org/units/r-est');
    expect(patch.request.method).toBe('PATCH');
    expect(patch.request.body).toEqual({ name: 'Région Est-Sud', siteId: null, validFrom: '2025-03-31' });
    const changed = { ...REG_EST, name: 'Région Est-Sud', site: HQ };
    patch.flush(detailOf(changed, [P_DG, P_RX], { siteInherited: true }));
    await settle();

    http.expectOne(isTree).flush(tree('2025-03-31'));
    http.expectOne('/api/org/units/r-est').flush(detailOf(changed, [P_DG, P_RX], { siteInherited: true }));
    await settle();
    expect(el().querySelector('[role="status"]')?.textContent).toContain('Région Est-Sud');
  });

  it('the move picker only searches the kinds allowed as parents (repeated kind params)', async () => {
    await open('/organization?asOf=2025-03-31');
    await select(SRV_PAIE, [P_DG, { id: 'd-rh', name: 'Département RH' }]);
    button('Modifier').click();
    await settle();
    http.expectOne('/api/org/units/d-rh').flush(detailOf(DEP_RH, [P_DG]));
    await settle();

    fill('change-unit-parent', 'Est');
    await new Promise((resolve) => setTimeout(resolve, ORG_UNIT_PICKER_DEBOUNCE_MS + 20)); // the picker's debounce
    const search = http.expectOne((r) => r.url === '/api/org/units');
    expect(search.request.params.getAll('kind')).toEqual(['department', 'region', 'agency']);
    expect(search.request.params.get('asOf')).toBe('2025-03-31');
    search.flush({ items: [] });
  });

  it('root: cannot be moved, has no "inherit" site option, and maps org-unit-root-site-required to the site', async () => {
    await open('/organization?asOf=2025-03-31');
    await select(ROOT);
    button('Modifier').click();
    await settle();

    expect(el().querySelector('app-org-unit-picker')).toBeNull();
    expect(el().textContent).toContain("L'unité racine ne peut pas être déplacée.");
    expect(optionTexts('change-unit-site')).toEqual(['Alger – Siège (ALG-HQ)', 'Annaba (ANNABA)', 'Constantine (CNE)']);
    expect(el().querySelector('#change-unit-site-hint')?.textContent).toContain("L'unité racine doit toujours avoir un site.");

    choose('change-unit-site', 'Constantine (CNE)');
    await submit();
    const patch = http.expectOne('/api/org/units/dg');
    expect(patch.request.body).toEqual({ siteId: 's-cne', validFrom: '2025-03-31' });
    patch.flush(
      {
        type: 'urn:hrforce:problem:org-unit-root-site-required',
        title: 'Conflict',
        status: 409,
        errors: [{ field: 'siteId', code: 'required', message: 'Root needs a site.' }],
      },
      { status: 409, statusText: 'Conflict' },
    );
    await settle();

    expect(el().querySelector('#change-unit-site-error')?.textContent?.trim()).toBe("L'unité racine doit avoir un site.");
    expect(el().querySelector('form [role="alert"]')).toBeNull();
  });

  it('links to the sites section', async () => {
    await open('/organization?asOf=2025-03-31');
    const links = [...el().querySelectorAll('app-org-nav a')];
    expect(links.map((a) => a.textContent?.trim())).toEqual(['Structure', 'Sites']);
    expect(links[0]?.getAttribute('aria-current')).toBe('page');
    expect(links[1]?.getAttribute('href')).toBe('/organization/sites');
  });
});
