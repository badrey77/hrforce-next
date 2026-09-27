import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_COMPANY_ID, DEMO_ORGANIZATION, DEMO_USER_ID, seedOrganization, toIsoDate, type SeedOrganization } from '../src/modules/organization/index.js';
import { createDatabase, type Database } from '../src/platform/db/database.js';
import { assertNoSecrets } from './support/assert-no-secrets.js';
import { seedSecurityPolicy } from '../src/modules/authorization/index.js';
import { createTestApp, TestPermissionEvaluator } from './support/test-app.js';
import { createTestDatabase, query, type TestDatabase } from './support/test-database.js';
import { fetchXsrf, withXsrf, type XsrfPair } from './support/xsrf.js';

const PROBLEM_JSON = /^application\/problem\+json/;
const unit = (code: string) => {
  const found = DEMO_ORGANIZATION.units.find((u) => u.code === code);
  if (!found) throw new Error(code);
  return found.id;
};
const site = (code: string) => {
  const found = DEMO_ORGANIZATION.sites.find((s) => s.code === code);
  if (!found) throw new Error(code);
  return found.id;
};
const siteRef = (code: string) => {
  const found = DEMO_ORGANIZATION.sites.find((s) => s.code === code);
  if (!found) throw new Error(code);
  return { id: found.id, code: found.code, name: found.name };
};
const MISSING = '0190a5d0-0000-7000-8000-0000000fffff';

const COMPANY_B = '0190a5d0-0000-7000-8000-00000000000b';
const USER_B = '0190a5d0-0000-7000-8000-0000000000bb';
const SITE_B = '0190a5d0-0000-7000-8000-000000000b21';
const ORG_B: SeedOrganization = {
  company: { id: COMPANY_B, code: 'BETA', name: 'Beta SARL' },
  validFrom: '2026-01-01',
  sites: [{ id: SITE_B, code: 'BETA-HQ', name: 'Beta Siège', wilaya: 'Sétif', address: '1 rue des Frères' }],
  units: [
    { id: '0190a5d0-0000-7000-8000-000000000b01', kind: 'direction_generale', code: 'BETA-DG', name: 'Beta DG', parent: null, site: 'BETA-HQ' },
    { id: '0190a5d0-0000-7000-8000-000000000b11', kind: 'department', code: 'BETA-RH', name: 'Beta RH', parent: 'BETA-DG' },
  ],
};

interface TreeNode {
  id: string;
  kind: string;
  code: string;
  name: string;
  site: { id: string; code: string; name: string } | null;
  children: TreeNode[];
  _actions: string[];
}

type Agent = ReturnType<typeof request>;

/** XSRF token (anon: header identities have no session) — fetched once, valid for every app of this file. */
let xsrf: XsrfPair;

/** Requests carrying the DEV_AUTH identity headers (+ the XSRF cookie/header on unsafe methods). */
function as(a: NestExpressApplication, user = DEMO_USER_ID, company = DEMO_COMPANY_ID) {
  const agent: Agent = request(a.getHttpServer());
  const withIdentity = (req: request.Test) => req.set('X-Dev-User-Id', user).set('X-Dev-Company-Id', company);
  return {
    get: (url: string) => withIdentity(agent.get(url)),
    post: (url: string) => withXsrf(withIdentity(agent.post(url)), xsrf),
    patch: (url: string) => withXsrf(withIdentity(agent.patch(url)), xsrf),
  };
}

function find(node: TreeNode, code: string): TreeNode | undefined {
  if (node.code === code) return node;
  for (const child of node.children) {
    const hit = find(child, code);
    if (hit) return hit;
  }
  return undefined;
}

function childCodes(tree: { root: TreeNode }, code: string): string[] | undefined {
  return find(tree.root, code)?.children.map((c) => c.code);
}

function actionsOf(node: unknown): unknown {
  return (node as Record<string, unknown>)['_actions'];
}

function shape(node: TreeNode): unknown {
  return node.children.length ? { [node.code]: node.children.map(shape) } : node.code;
}

describe('Organization API v2 (e2e)', () => {
  let db: TestDatabase;
  let migrator: Database;
  let app: NestExpressApplication;
  let restricted: NestExpressApplication;
  const today = toIsoDate(new Date());

  const demo = () => as(app);
  const beta = () => as(app, USER_B, COMPANY_B);
  const createUnit = (body: Record<string, unknown>) => demo().post('/api/org/units').send(body);

  beforeAll(async () => {
    db = await createTestDatabase();
    migrator = createDatabase({ connectionString: db.migratorUrl, maxConnections: 1 });
    await migrator.transaction().execute((tx) => seedOrganization(tx, DEMO_ORGANIZATION, today));
    // idempotent: a second run changes nothing
    await migrator.transaction().execute((tx) => seedOrganization(tx, DEMO_ORGANIZATION, today));
    await migrator.transaction().execute((tx) => seedOrganization(tx, ORG_B, today));
    // like seed:dev: two-step sign-in not enforced (DEV_PERMISSIONS=allow_all would make every caller "required")
    await migrator.transaction().execute(async (tx) => {
      await seedSecurityPolicy(tx, DEMO_COMPANY_ID, { mfaEnforced: false });
      await seedSecurityPolicy(tx, ORG_B.company.id, { mfaEnforced: false });
    });
    app = await createTestApp(db, { devAuth: true }); // real DEV_AUTH wiring: headers + allow-all
    restricted = await createTestApp(db, { devAuth: true, evaluator: TestPermissionEvaluator });
    xsrf = await fetchXsrf(app);
  });

  afterAll(async () => {
    await app?.close();
    await restricted?.close();
    await migrator?.destroy();
    await db?.drop();
  });

  beforeEach(() => {
    TestPermissionEvaluator.granted = [];
  });

  it('seed is idempotent and builds the closure (self rows + ancestors)', async () => {
    const [counts] = await query<{ units: string; versions: string; closure: string; sites: string }>(
      db.superuserUrl,
      `select (select count(*) from org_unit where company_id = $1)::text as units,
              (select count(*) from org_unit_version where company_id = $1)::text as versions,
              (select count(*) from org_unit_closure where company_id = $1)::text as closure,
              (select count(*) from site where company_id = $1)::text as sites`,
      [DEMO_COMPANY_ID],
    );
    // closure = 18 self + 3 departments×1 + 3 regions×2 + 6 agencies×3 + 3 dept services×2 + 1 region service×3 + 1 agency service×4
    expect(counts).toEqual({ units: '18', versions: '18', closure: String(18 + 3 + 6 + 18 + 6 + 3 + 4), sites: '7' });
  });

  it('the kind catalogue is read-only for the app role; one root unit per company', async () => {
    await expect(query(db.appUrl, `insert into org_unit_kind (code, label_fr, label_ar, label_en, sort_order) values ('x_kind', 'x', 'x', 'x', 99)`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(query(db.appUrl, `delete from org_unit_kind_parent`)).rejects.toThrow(/permission denied/);
    await expect(
      query(db.superuserUrl, `insert into org_unit (company_id, kind, code) values ($1, 'direction_generale', 'DG2')`, [DEMO_COMPANY_ID]),
    ).rejects.toThrow(/org_unit_one_root_uk/);
    await expect(query(db.superuserUrl, `insert into org_unit (company_id, kind, code) values ($1, 'company', 'OLD')`, [DEMO_COMPANY_ID])).rejects.toThrow(
      /org_unit_kind_fk/,
    );
  });

  it('GET /api/org/kinds → catalogue with fr/ar/en labels and allowed parents, sorted by sortOrder', async () => {
    const res = await demo().get('/api/org/kinds').expect(200);
    assertNoSecrets(res.body);
    expect(res.body).toEqual({
      items: [
        {
          code: 'direction_generale',
          isRoot: true,
          sortOrder: 10,
          labels: { fr: 'Direction Générale', ar: 'المديرية العامة', en: 'General Management' },
          allowedParents: [],
        },
        {
          code: 'department',
          isRoot: false,
          sortOrder: 20,
          labels: { fr: 'Département', ar: 'دائرة', en: 'Department' },
          allowedParents: ['direction_generale'],
        },
        { code: 'region', isRoot: false, sortOrder: 30, labels: { fr: 'Région', ar: 'منطقة', en: 'Region' }, allowedParents: ['department'] },
        { code: 'agency', isRoot: false, sortOrder: 40, labels: { fr: 'Agence', ar: 'وكالة', en: 'Agency' }, allowedParents: ['region'] },
        {
          code: 'service',
          isRoot: false,
          sortOrder: 50,
          labels: { fr: 'Service', ar: 'مصلحة', en: 'Service' },
          allowedParents: ['department', 'region', 'agency'],
        },
      ],
    });
  });

  it('GET /api/org/tree → whole tree, children by kind sortOrder then code, effective sites, _actions', async () => {
    const res = await demo().get('/api/org/tree').expect(200);
    assertNoSecrets(res.body);
    expect(res.body.asOf).toBe(today);
    expect(shape(res.body.root)).toEqual({
      DG: [
        { 'DEP-FIN': ['SRV-COMPTA'] },
        { 'DEP-RH': ['SRV-FORM', 'SRV-PAIE'] },
        {
          'DEP-RX': [
            { 'REG-CTR': ['AG-ALG', 'AG-BLIDA'] },
            { 'REG-EST': [{ 'AG-ANNABA': ['SRV-CLI-ANB'] }, 'AG-CNE', 'SRV-ADM-EST'] },
            { 'REG-OUEST': ['AG-ORAN', 'AG-TLEMCEN'] },
          ],
        },
      ],
    });
    const root = res.body.root as TreeNode;
    expect(root).toMatchObject({ id: unit('DG'), kind: 'direction_generale', name: 'Direction Générale', site: siteRef('ALG-HQ') });
    expect(actionsOf(root)).toEqual(['update', 'create_child']);
    expect(find(root, 'DEP-RH')?.site).toEqual(siteRef('ALG-HQ')); // inherited from the DG
    expect(find(root, 'SRV-PAIE')?.site).toEqual(siteRef('ALG-HQ'));
    expect(find(root, 'REG-EST')?.site).toEqual(siteRef('CNE'));
    expect(find(root, 'SRV-ADM-EST')?.site).toEqual(siteRef('CNE')); // service under a region
    expect(find(root, 'SRV-CLI-ANB')?.site).toEqual(siteRef('ANNABA')); // service under an agency
    expect(find(root, 'AG-ALG')?.site).toEqual(siteRef('ALG-CTR'));
    for (const code of ['DEP-RX', 'REG-EST', 'AG-ANNABA']) expect(actionsOf(find(root, code)), code).toEqual(['update', 'create_child']);
    expect(find(root, 'SRV-CLI-ANB')).toMatchObject({ kind: 'service', _actions: ['update'] });
  });

  it('GET /api/org/tree before the organisation existed → 404; bad asOf → 422', async () => {
    const res = await demo().get('/api/org/tree?asOf=2025-12-31').expect(404);
    expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
    const bad = await demo().get('/api/org/tree?asOf=2026-02-30').expect(422);
    expect(bad.body.errors[0]).toMatchObject({ field: 'asOf' });
  });

  it('GET /api/org/units → case/accent-insensitive search, repeated kind, effective site and path', async () => {
    const alger = await demo().get('/api/org/units?q=alger').expect(200);
    assertNoSecrets(alger.body);
    expect(alger.body.items).toEqual([
      {
        id: unit('AG-ALG'),
        kind: 'agency',
        code: 'AG-ALG',
        name: 'Agence Alger Centre',
        nameAr: 'وكالة الجزائر الوسطى',
        site: siteRef('ALG-CTR'),
        path: [
          { id: unit('DG'), name: 'Direction Générale', nameAr: 'المديرية العامة' },
          { id: unit('DEP-RX'), name: 'Département RX', nameAr: 'دائرة الشبكة' },
          { id: unit('REG-CTR'), name: 'Région Centre', nameAr: 'منطقة الوسط' },
        ],
      },
    ]);
    const codes = async (qs: string) =>
      ((await demo().get(`/api/org/units?${qs}`).expect(200)).body.items as { code: string }[]).map((i) => i.code);
    expect(await codes('q=GENERALE')).toEqual(['DG']);
    expect(await codes(`q=${encodeURIComponent('clientèle')}`)).toEqual(['SRV-CLI-ANB']);
    expect(await codes('q=region')).toEqual(['REG-CTR', 'REG-EST', 'REG-OUEST']);
    expect(await codes('q=srv-adm')).toEqual(['SRV-ADM-EST']); // code match
    // Arabic names (0010): tashkeel and alef/teh-marbuta variants are normalised on both sides
    expect(await codes(`q=${encodeURIComponent('عنابة')}`)).toEqual(['AG-ANNABA']);
    expect(await codes(`q=${encodeURIComponent('عَنّابه')}`)).toEqual(['AG-ANNABA']);
    expect(await codes(`q=${encodeURIComponent('منطقة الشرق')}`)).toEqual(['REG-EST']);
    expect(await codes('q=%25')).toEqual([]); // LIKE wildcards are literal
    expect(await codes('kind=service')).toEqual(['SRV-ADM-EST', 'SRV-CLI-ANB', 'SRV-COMPTA', 'SRV-FORM', 'SRV-PAIE']);
    expect(await codes('kind=region&kind=agency')).toHaveLength(9);
    expect(await codes('kind=department&q=rh')).toEqual(['DEP-RH']);
    const service = await demo().get('/api/org/units?q=paie').expect(200);
    expect(service.body.items[0]).toMatchObject({ site: siteRef('ALG-HQ') });

    const unknown = await demo().get('/api/org/units?kind=site').expect(422); // v1 kind: gone
    expect(unknown.body.errors).toEqual([expect.objectContaining({ field: 'kind' })]);
    await demo().get('/api/org/units?kind=region&kind=Bad!').expect(422);
  });

  it('GET /api/org/units/:id → detail with effective site, siteInherited and versions; unknown or malformed ids → 404', async () => {
    const res = await demo().get(`/api/org/units/${unit('SRV-CLI-ANB')}`).expect(200);
    assertNoSecrets(res.body);
    expect(res.body).toMatchObject({
      id: unit('SRV-CLI-ANB'),
      kind: 'service',
      code: 'SRV-CLI-ANB',
      name: 'Service Clientèle',
      site: siteRef('ANNABA'),
      siteInherited: true,
      path: [{ name: 'Direction Générale' }, { name: 'Département RX' }, { name: 'Région Est' }, { name: 'Agence Annaba' }],
      versions: [{ validFrom: '2026-01-01', validTo: null, name: 'Service Clientèle', parentId: unit('AG-ANNABA'), siteId: null }],
      _actions: ['update'],
    });
    expect(res.body.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const agency = await demo().get(`/api/org/units/${unit('AG-ANNABA')}`).expect(200);
    expect(agency.body).toMatchObject({ site: siteRef('ANNABA'), siteInherited: false, versions: [{ siteId: site('ANNABA') }] });
    const root = await demo().get(`/api/org/units/${unit('DG')}`).expect(200);
    expect(root.body).toMatchObject({ site: siteRef('ALG-HQ'), siteInherited: false, path: [], _actions: ['update', 'create_child'] });

    await demo().get(`/api/org/units/${MISSING}`).expect(404);
    const bad = await demo().get('/api/org/units/not-a-uuid').expect(404);
    expect(bad.headers['content-type']).toMatch(PROBLEM_JSON);
  });

  it('allowed-parent matrix: every allowed pair can be created (201 + Location)', async () => {
    const pairs: [kind: string, parent: string][] = [
      ['department', 'DG'],
      ['region', 'DEP-RX'],
      ['agency', 'REG-EST'],
      ['service', 'DEP-RH'],
      ['service', 'REG-OUEST'],
      ['service', 'AG-ORAN'],
    ];
    for (const [i, [kind, parent]] of pairs.entries()) {
      const res = await createUnit({ kind, code: `OK-${i}`, name: `  ${kind} ${i}  `, parentId: unit(parent) });
      expect(res.status, `${kind} under ${parent}`).toBe(201);
      assertNoSecrets(res.body);
      expect(res.headers['location']).toBe(`/api/org/units/${res.body.id}`);
      expect(res.body).toMatchObject({ kind, code: `OK-${i}`, name: `${kind} ${i}`, siteInherited: true });
      expect(res.body.path.at(-1)).toMatchObject({ id: unit(parent), name: expect.any(String) });
      expect(res.body.versions).toEqual([{ validFrom: today, validTo: null, name: `${kind} ${i}`, nameAr: null, parentId: unit(parent), siteId: null }]);
      expect(actionsOf(res.body)).toEqual(kind === 'service' ? ['update'] : ['update', 'create_child']);
    }
  });

  it('allowed-parent matrix: forbidden pairs → 409 org-unit-invalid-parent / invalid_parent_kind', async () => {
    const pairs: [kind: string, parent: string][] = [
      ['agency', 'DEP-RX'], // agencies only under regions
      ['region', 'DG'], // regions only under a department
      ['department', 'DEP-RH'], // departments only at DG level
      ['department', 'REG-EST'],
      ['agency', 'DG'],
      ['agency', 'AG-CNE'],
      ['region', 'AG-CNE'],
      ['service', 'DG'],
      ['service', 'SRV-PAIE'], // services have no children
    ];
    for (const [kind, parent] of pairs) {
      const res = await createUnit({ kind, code: 'NOPE', name: 'Nope', parentId: unit(parent) });
      expect(res.status, `${kind} under ${parent}`).toBe(409);
      expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
      expect(res.body).toMatchObject({ type: 'urn:hrforce:problem:org-unit-invalid-parent', status: 409 });
      expect(res.body.errors).toEqual([expect.objectContaining({ field: 'parentId', code: 'invalid_parent_kind' })]);
    }
    // an unknown parent is indistinguishable from an unreadable one (docs/contracts/authorization.md): 404
    const missing = await createUnit({ kind: 'department', code: 'NOPE', name: 'Nope', parentId: MISSING }).expect(404);
    expect(missing.body).toMatchObject({ type: 'urn:hrforce:problem:not-found' });
    const beforeParent = await createUnit({ kind: 'service', code: 'NOPE', name: 'Nope', parentId: unit('REG-EST'), validFrom: '2025-06-01' }).expect(409);
    expect(beforeParent.body.errors[0]).toMatchObject({ field: 'parentId', code: 'parent_not_effective' });
  });

  it('POST /api/org/units: the root kind and unknown kinds are invalid (422 on kind)', async () => {
    const root = await createUnit({ kind: 'direction_generale', code: 'DG2', name: 'DG 2', parentId: unit('DG') }).expect(422);
    expect(root.body.errors).toEqual([expect.objectContaining({ field: 'kind' })]);
    const v1 = await createUnit({ kind: 'site', code: 'OLD', name: 'Old', parentId: unit('REG-EST') }).expect(422);
    expect(v1.body.errors).toEqual([expect.objectContaining({ field: 'kind' })]);
  });

  it('POST with siteId: own site, closure maintained; a service without site inherits it', async () => {
    const agency = await createUnit({ kind: 'agency', code: 'AG-SETIF', name: 'Agence Sétif', parentId: unit('REG-EST'), siteId: site('CNE') }).expect(201);
    expect(agency.body).toMatchObject({ site: siteRef('CNE'), siteInherited: false, versions: [{ siteId: site('CNE') }] });
    const service = await createUnit({ kind: 'service', code: 'SRV-SETIF', name: 'Service Sétif', parentId: agency.body.id, siteId: null }).expect(201);
    expect(service.body).toMatchObject({ site: siteRef('CNE'), siteInherited: true });
    expect(service.body.path.map((p: { name: string }) => p.name)).toEqual(['Direction Générale', 'Département RX', 'Région Est', 'Agence Sétif']);

    const closure = await query<{ ancestor_id: string; depth: number }>(
      db.superuserUrl,
      'select ancestor_id, depth from org_unit_closure where descendant_id = $1 order by depth',
      [service.body.id],
    );
    expect(closure).toEqual([
      { ancestor_id: service.body.id, depth: 0 },
      { ancestor_id: agency.body.id, depth: 1 },
      { ancestor_id: unit('REG-EST'), depth: 2 },
      { ancestor_id: unit('DEP-RX'), depth: 3 },
      { ancestor_id: unit('DG'), depth: 4 },
    ]);
  });

  it('unknown or other-tenant siteId → 409 site-not-found on field siteId', async () => {
    const unknown = await createUnit({ kind: 'service', code: 'SRV-X', name: 'X', parentId: unit('DEP-RH'), siteId: MISSING }).expect(409);
    expect(unknown.body).toMatchObject({ type: 'urn:hrforce:problem:site-not-found', errors: [{ field: 'siteId', code: 'site-not-found' }] });
    const otherTenant = await createUnit({ kind: 'service', code: 'SRV-X', name: 'X', parentId: unit('DEP-RH'), siteId: SITE_B }).expect(409);
    expect(otherTenant.body).toMatchObject({ type: 'urn:hrforce:problem:site-not-found', errors: [{ field: 'siteId' }] });
    const patch = await demo().patch(`/api/org/units/${unit('SRV-PAIE')}`).send({ siteId: SITE_B, validFrom: '2026-08-01' }).expect(409);
    expect(patch.body).toMatchObject({ type: 'urn:hrforce:problem:site-not-found', errors: [{ field: 'siteId' }] });
    await demo().get(`/api/org/units?q=srv-x`).expect(200, { items: [] });
  });

  it('duplicate code → 409 org-unit-code-taken with errors[field=code]', async () => {
    const res = await createUnit({ kind: 'agency', code: 'AG-ORAN', name: 'Oran bis', parentId: unit('REG-OUEST') }).expect(409);
    expect(res.body).toMatchObject({ type: 'urn:hrforce:problem:org-unit-code-taken', errors: [{ field: 'code' }] });
  });

  it('invalid bodies → 422 with errors[] per field', async () => {
    const res = await createUnit({ kind: 'Bad Kind', code: 'bad code', name: '   ', parentId: 'x', siteId: 'nope', validFrom: '01/02/2026' }).expect(422);
    expect((res.body.errors as { field: string }[]).map((e) => e.field).toSorted()).toEqual(['code', 'kind', 'name', 'parentId', 'siteId', 'validFrom']);
    const tooLong = await createUnit({ kind: 'service', code: 'LONG', name: 'x'.repeat(121), parentId: unit('REG-EST') }).expect(422);
    expect(tooLong.body.errors[0].field).toBe('name');
    const empty = await demo().patch(`/api/org/units/${unit('AG-ORAN')}`).send({ validFrom: '2026-05-01' }).expect(422);
    expect(empty.body.errors[0].field).toBe('name');
  });

  it('PATCH moves an agency from validFrom: tree before vs after differs, history split, closure rebuilt', async () => {
    const res = await demo()
      .patch(`/api/org/units/${unit('AG-ORAN')}`)
      .send({ parentId: unit('REG-CTR'), name: 'Agence Oran Port', validFrom: '2026-03-01' })
      .expect(200);
    assertNoSecrets(res.body);
    expect(res.body.versions).toEqual([
      { validFrom: '2026-03-01', validTo: null, name: 'Agence Oran Port', nameAr: 'وكالة وهران', parentId: unit('REG-CTR'), siteId: site('ORAN') },
      { validFrom: '2026-01-01', validTo: '2026-03-01', name: 'Agence Oran', nameAr: 'وكالة وهران', parentId: unit('REG-OUEST'), siteId: site('ORAN') },
    ]);
    expect(res.body.name).toBe('Agence Oran Port');
    expect(res.body.path.map((p: { name: string }) => p.name)).toEqual(['Direction Générale', 'Département RX', 'Région Centre']);

    const before = await demo().get('/api/org/tree?asOf=2026-02-28').expect(200);
    const after = await demo().get('/api/org/tree?asOf=2026-03-01').expect(200);
    expect(childCodes(before.body, 'REG-CTR')).toEqual(['AG-ALG', 'AG-BLIDA']);
    expect(childCodes(before.body, 'REG-OUEST')).toEqual(['AG-ORAN', 'AG-TLEMCEN']);
    expect(childCodes(after.body, 'REG-CTR')).toEqual(['AG-ALG', 'AG-BLIDA', 'AG-ORAN']);
    expect(childCodes(after.body, 'REG-OUEST')).toEqual(['AG-TLEMCEN']);

    const closure = await query<{ ancestor_id: string; depth: number }>(
      db.superuserUrl,
      'select ancestor_id, depth from org_unit_closure where descendant_id = $1 order by depth',
      [unit('AG-ORAN')],
    );
    expect(closure).toEqual([
      { ancestor_id: unit('AG-ORAN'), depth: 0 },
      { ancestor_id: unit('REG-CTR'), depth: 1 },
      { ancestor_id: unit('DEP-RX'), depth: 2 },
      { ancestor_id: unit('DG'), depth: 3 },
    ]);
  });

  it('a future-dated move changes the tree from that date but not today’s closure', async () => {
    await demo().patch(`/api/org/units/${unit('AG-TLEMCEN')}`).send({ parentId: unit('REG-EST'), validFrom: '2099-01-01' }).expect(200);
    const future = await demo().get('/api/org/tree?asOf=2099-01-01').expect(200);
    expect(childCodes(future.body, 'REG-EST')).toContain('AG-TLEMCEN');
    const closure = await query<{ ancestor_id: string }>(
      db.superuserUrl,
      'select ancestor_id from org_unit_closure where descendant_id = $1 and depth = 1',
      [unit('AG-TLEMCEN')],
    );
    expect(closure).toEqual([{ ancestor_id: unit('REG-OUEST') }]);
  });

  it('a site change is a new version; siteId null inherits again', async () => {
    const moved = await demo().patch(`/api/org/units/${unit('SRV-ADM-EST')}`).send({ siteId: site('ANNABA'), validFrom: '2026-05-01' }).expect(200);
    expect(moved.body.versions).toEqual([
      { validFrom: '2026-05-01', validTo: null, name: 'Service Administration Est', nameAr: null, parentId: unit('REG-EST'), siteId: site('ANNABA') },
      { validFrom: '2026-01-01', validTo: '2026-05-01', name: 'Service Administration Est', nameAr: null, parentId: unit('REG-EST'), siteId: null },
    ]);
    expect(moved.body).toMatchObject({ site: siteRef('ANNABA'), siteInherited: false });
    const before = await demo().get('/api/org/tree?asOf=2026-04-30').expect(200);
    const after = await demo().get('/api/org/tree?asOf=2026-05-01').expect(200);
    expect(find(before.body.root, 'SRV-ADM-EST')?.site).toEqual(siteRef('CNE'));
    expect(find(after.body.root, 'SRV-ADM-EST')?.site).toEqual(siteRef('ANNABA'));

    const inherit = await demo().patch(`/api/org/units/${unit('SRV-ADM-EST')}`).send({ siteId: null, validFrom: '2026-07-01' }).expect(200);
    expect(inherit.body.versions).toHaveLength(3);
    expect(inherit.body.versions[0]).toMatchObject({ validFrom: '2026-07-01', siteId: null });
    expect(inherit.body).toMatchObject({ site: siteRef('CNE'), siteInherited: true });
    const search = await demo().get('/api/org/units?q=srv-adm-est&asOf=2026-06-15').expect(200);
    expect(search.body.items[0].site).toEqual(siteRef('ANNABA'));
  });

  it('root: can be renamed and change site, must keep a site, cannot be moved; version overlap refused', async () => {
    const noSite = await demo().patch(`/api/org/units/${unit('DG')}`).send({ siteId: null, validFrom: '2026-04-01' }).expect(409);
    expect(noSite.body).toMatchObject({ type: 'urn:hrforce:problem:org-unit-root-site-required', errors: [{ field: 'siteId' }] });

    const moved = await demo().patch(`/api/org/units/${unit('DG')}`).send({ parentId: unit('DEP-RH'), validFrom: '2026-04-01' }).expect(409);
    expect(moved.body).toMatchObject({ type: 'urn:hrforce:problem:org-unit-root-immutable', errors: [{ field: 'parentId' }] });

    const changed = await demo()
      .patch(`/api/org/units/${unit('DG')}`)
      .send({ name: 'Direction Générale Groupe', siteId: site('ALG-CTR'), validFrom: '2026-04-01' })
      .expect(200);
    expect(changed.body.versions[0]).toMatchObject({ name: 'Direction Générale Groupe', parentId: null, siteId: site('ALG-CTR') });
    const tree = await demo().get('/api/org/tree?asOf=2026-04-01').expect(200);
    expect(find(tree.body.root, 'DEP-FIN')?.site).toEqual(siteRef('ALG-CTR')); // descendants follow

    const overlap = await demo().patch(`/api/org/units/${unit('DG')}`).send({ name: 'DG again', validFrom: '2026-04-01' }).expect(409);
    expect(overlap.body).toMatchObject({ type: 'urn:hrforce:problem:org-unit-version-overlap', errors: [{ field: 'validFrom' }] });

    // A region under its own agency is refused (parent rules make cycles impossible before the cycle check).
    const cycle = await demo().patch(`/api/org/units/${unit('REG-EST')}`).send({ parentId: unit('AG-CNE'), validFrom: '2026-04-01' }).expect(409);
    expect(cycle.body.errors[0]).toMatchObject({ field: 'parentId', code: 'invalid_parent_kind' });
  });

  it('GET /api/org/sites → sorted by code, searchable (code, name, wilaya; accents ignored)', async () => {
    const res = await demo().get('/api/org/sites').expect(200);
    assertNoSecrets(res.body);
    expect((res.body.items as { code: string }[]).map((s) => s.code)).toEqual(['ALG-CTR', 'ALG-HQ', 'ANNABA', 'BLIDA', 'CNE', 'ORAN', 'TLEMCEN']);
    expect(res.body.items[1]).toEqual({ id: site('ALG-HQ'), code: 'ALG-HQ', name: 'Alger – Siège', wilaya: 'Alger', address: null });
    const codes = async (q: string) =>
      ((await demo().get(`/api/org/sites?q=${encodeURIComponent(q)}`).expect(200)).body.items as { code: string }[]).map((s) => s.code);
    expect(await codes('alger')).toEqual(['ALG-CTR', 'ALG-HQ']);
    expect(await codes('SIEGE')).toEqual(['ALG-HQ']);
    expect(await codes('cne')).toEqual(['CNE']);
    expect(await codes('_')).toEqual([]);
  });

  it('POST /api/org/sites → 201 Site; duplicate code → 409 site-code-taken; invalid → 422', async () => {
    const created = await demo()
      .post('/api/org/sites')
      .send({ code: 'SETIF', name: '  Sétif  ', wilaya: ' Sétif ', address: '  ' })
      .expect(201);
    assertNoSecrets(created.body);
    expect(created.body).toEqual({ id: expect.any(String), code: 'SETIF', name: 'Sétif', wilaya: 'Sétif', address: null });
    const withAddress = await demo()
      .post('/api/org/sites')
      .send({ code: 'BEJAIA', name: 'Béjaïa', wilaya: 'Béjaïa', address: ' Route des Aurès ' })
      .expect(201);
    expect(withAddress.body.address).toBe('Route des Aurès');
    // usable at once
    await createUnit({ kind: 'agency', code: 'AG-BEJAIA', name: 'Agence Béjaïa', parentId: unit('REG-EST'), siteId: withAddress.body.id }).expect(201);

    const dup = await demo().post('/api/org/sites').send({ code: 'ORAN', name: 'Oran 2', wilaya: 'Oran' }).expect(409);
    expect(dup.body).toMatchObject({ type: 'urn:hrforce:problem:site-code-taken', errors: [{ field: 'code' }] });

    const invalid = await demo().post('/api/org/sites').send({ code: 'bad', name: '', address: 'x'.repeat(301) }).expect(422);
    expect((invalid.body.errors as { field: string }[]).map((e) => e.field).toSorted()).toEqual(['address', 'code', 'name', 'wilaya']);
  });

  it('tenant isolation: company B cannot see, get or patch company A units or sites (404 / empty)', async () => {
    const tree = await beta().get('/api/org/tree').expect(200);
    expect(shape(tree.body.root)).toEqual({ 'BETA-DG': ['BETA-RH'] });
    expect(tree.body.root.children[0].site).toEqual({ id: SITE_B, code: 'BETA-HQ', name: 'Beta Siège' });
    const search = await beta().get('/api/org/units?q=alger').expect(200);
    expect(search.body.items).toEqual([]);
    await beta().get(`/api/org/units/${unit('AG-BLIDA')}`).expect(404);
    await beta().patch(`/api/org/units/${unit('AG-BLIDA')}`).send({ name: 'Hacked', validFrom: '2026-06-01' }).expect(404);
    // …nor use them as a parent, nor use A's sites
    await beta().post('/api/org/units').send({ kind: 'region', code: 'SPY', name: 'Spy', parentId: unit('DEP-RX') }).expect(404);
    const spySite = await beta()
      .post('/api/org/units')
      .send({ kind: 'service', code: 'SPY', name: 'Spy', parentId: '0190a5d0-0000-7000-8000-000000000b11', siteId: site('ALG-HQ') })
      .expect(409);
    expect(spySite.body.type).toBe('urn:hrforce:problem:site-not-found');

    const sites = await beta().get('/api/org/sites').expect(200);
    expect(sites.body.items).toEqual([{ id: SITE_B, code: 'BETA-HQ', name: 'Beta Siège', wilaya: 'Sétif', address: '1 rue des Frères' }]);
    // site codes are unique per company: B may reuse A's code
    await beta().post('/api/org/sites').send({ code: 'ORAN', name: 'Oran B', wilaya: 'Oran' }).expect(201);
    expect(((await demo().get('/api/org/sites?q=oran').expect(200)).body.items as { name: string }[]).map((s) => s.name)).toEqual(['Oran']);

    const [blida] = await query<{ name: string }>(db.superuserUrl, `select name from org_unit_version where org_unit_id = $1`, [unit('AG-BLIDA')]);
    expect(blida?.name).toBe('Agence Blida');
  });

  it('without the permission → 403; read-only callers get empty _actions', async () => {
    const r = as(restricted);
    const denied = await r.get('/api/org/tree').expect(403);
    expect(denied.body).toMatchObject({ type: 'urn:hrforce:problem:forbidden', status: 403 });
    await r.get('/api/org/kinds').expect(403);
    await r.get('/api/org/sites').expect(403);
    await r.post('/api/org/units').send({ kind: 'department', code: 'X1', name: 'X', parentId: unit('DG') }).expect(403);

    TestPermissionEvaluator.granted = ['org_unit.read'];
    const tree = await r.get('/api/org/tree').expect(200);
    expect(actionsOf(tree.body.root)).toEqual([]);
    await r.get('/api/org/kinds').expect(200);
    await r.get('/api/org/sites').expect(403); // site.read is separate
    await r.patch(`/api/org/units/${unit('AG-BLIDA')}`).send({ name: 'Blida 2' }).expect(403);

    TestPermissionEvaluator.granted = ['org_unit.read', 'org_unit.create'];
    expect(actionsOf((await r.get(`/api/org/units/${unit('REG-EST')}`).expect(200)).body)).toEqual(['create_child']);
    expect(actionsOf((await r.get(`/api/org/units/${unit('SRV-PAIE')}`).expect(200)).body)).toEqual([]);

    TestPermissionEvaluator.granted = ['site.read'];
    await r.get('/api/org/sites').expect(200);
    await r.post('/api/org/sites').send({ code: 'X2', name: 'X', wilaya: 'X' }).expect(403);
    TestPermissionEvaluator.granted = ['site.create'];
    await r.post('/api/org/sites').send({ code: 'X2', name: 'X', wilaya: 'X' }).expect(201);
  });

  it('anonymous (no dev headers) → 401', async () => {
    await request(app.getHttpServer()).get('/api/org/tree').expect(401);
    await request(app.getHttpServer()).get('/api/org/kinds').expect(401);
    await request(app.getHttpServer()).get('/api/org/sites').expect(401);
  });
});
