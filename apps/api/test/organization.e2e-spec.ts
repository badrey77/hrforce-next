import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_COMPANY_ID, DEMO_ORGANIZATION, DEMO_USER_ID, seedOrganization, toIsoDate, type SeedOrganization } from '../src/modules/organization/index.js';
import { createDatabase, type Database } from '../src/platform/db/database.js';
import { assertNoSecrets } from './support/assert-no-secrets.js';
import { createTestApp, TestPermissionEvaluator } from './support/test-app.js';
import { createTestDatabase, query, type TestDatabase } from './support/test-database.js';

const PROBLEM_JSON = /^application\/problem\+json/;
const unit = (code: string) => {
  const found = DEMO_ORGANIZATION.units.find((u) => u.code === code);
  if (!found) throw new Error(code);
  return found.id;
};

const COMPANY_B = '0190a5d0-0000-7000-8000-00000000000b';
const USER_B = '0190a5d0-0000-7000-8000-0000000000bb';
const ORG_B: SeedOrganization = {
  company: { id: COMPANY_B, code: 'BETA', name: 'Beta SARL' },
  validFrom: '2026-01-01',
  units: [
    { id: '0190a5d0-0000-7000-8000-000000000b01', kind: 'company', code: 'BETA', name: 'Beta', parent: null },
    { id: '0190a5d0-0000-7000-8000-000000000b11', kind: 'region', code: 'NORD', name: 'Nord', parent: 'BETA' },
  ],
};

interface TreeNode {
  id: string;
  kind: string;
  code: string;
  name: string;
  children: TreeNode[];
  _actions: string[];
}

type Agent = ReturnType<typeof request>;

/** Requests carrying the DEV_AUTH identity headers. */
function as(a: NestExpressApplication, user = DEMO_USER_ID, company = DEMO_COMPANY_ID) {
  const agent: Agent = request(a.getHttpServer());
  const withIdentity = (req: request.Test) => req.set('X-Dev-User-Id', user).set('X-Dev-Company-Id', company);
  return {
    get: (url: string) => withIdentity(agent.get(url)),
    post: (url: string) => withIdentity(agent.post(url)),
    patch: (url: string) => withIdentity(agent.patch(url)),
  };
}

function sitesOf(tree: { root: TreeNode }, code: string): string[] | undefined {
  return tree.root.children.find((r) => r.code === code)?.children.map((s) => s.name);
}

function actionsOf(node: unknown): unknown {
  return (node as Record<string, unknown>)['_actions'];
}

function shape(node: TreeNode): unknown {
  return node.children.length ? { [node.code]: node.children.map(shape) } : node.code;
}

describe('Organization API (e2e)', () => {
  let db: TestDatabase;
  let migrator: Database;
  let app: NestExpressApplication;
  let restricted: NestExpressApplication;
  const today = toIsoDate(new Date());

  const demo = () => as(app);
  const beta = () => as(app, USER_B, COMPANY_B);

  beforeAll(async () => {
    db = await createTestDatabase();
    migrator = createDatabase({ connectionString: db.migratorUrl, maxConnections: 1 });
    await migrator.transaction().execute((tx) => seedOrganization(tx, DEMO_ORGANIZATION, today));
    // idempotent: a second run changes nothing
    await migrator.transaction().execute((tx) => seedOrganization(tx, DEMO_ORGANIZATION, today));
    await migrator.transaction().execute((tx) => seedOrganization(tx, ORG_B, today));
    app = await createTestApp(db, { devAuth: true }); // real DEV_AUTH wiring: headers + allow-all
    restricted = await createTestApp(db, { devAuth: true, evaluator: TestPermissionEvaluator });
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
    const [counts] = await query<{ units: string; versions: string; closure: string }>(
      db.superuserUrl,
      `select (select count(*) from org_unit where company_id = $1)::text as units,
              (select count(*) from org_unit_version where company_id = $1)::text as versions,
              (select count(*) from org_unit_closure where company_id = $1)::text as closure`,
      [DEMO_COMPANY_ID],
    );
    // 10 units; closure = 10 self + 3 regions×1 + 6 sites×2 = 25
    expect(counts).toEqual({ units: '10', versions: '10', closure: '25' });
  });

  it('GET /api/org/tree → whole tree, children sorted by code, _actions', async () => {
    const res = await demo().get('/api/org/tree').expect(200);
    assertNoSecrets(res.body);
    expect(res.body.asOf).toBe(today);
    expect(shape(res.body.root)).toEqual({
      GROUPE: [{ CENTRE: ['ALG-HQ', 'BLIDA'] }, { EST: ['ANNABA', 'CNE'] }, { OUEST: ['ORAN', 'TLEMCEN'] }],
    });
    const root = res.body.root as TreeNode;
    expect(root).toMatchObject({ id: unit('GROUPE'), kind: 'company', name: 'Groupe Démo', _actions: ['update', 'create_child'] });
    expect(actionsOf(root.children[0])).toEqual(['update', 'create_child']);
    expect(root.children[0]?.children[0]).toMatchObject({ code: 'ALG-HQ', name: 'Alger – Siège', kind: 'site', _actions: ['update'] });
  });

  it('GET /api/org/tree before the organisation existed → 404; bad asOf → 422', async () => {
    const res = await demo().get('/api/org/tree?asOf=2025-12-31').expect(404);
    expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
    const bad = await demo().get('/api/org/tree?asOf=2026-02-30').expect(422);
    expect(bad.body.errors[0]).toMatchObject({ field: 'asOf' });
  });

  it('GET /api/org/units → case/accent-insensitive search on name or code, with path', async () => {
    const alger = await demo().get('/api/org/units?q=alger').expect(200);
    assertNoSecrets(alger.body);
    expect(alger.body.items).toEqual([
      {
        id: unit('ALG-HQ'),
        kind: 'site',
        code: 'ALG-HQ',
        name: 'Alger – Siège',
        path: [
          { id: unit('GROUPE'), name: 'Groupe Démo' },
          { id: unit('CENTRE'), name: 'Région Centre' },
        ],
      },
    ]);
    const codes = async (q: string) =>
      ((await demo().get(`/api/org/units?q=${encodeURIComponent(q)}`).expect(200)).body.items as { code: string }[]).map((i) => i.code);
    expect(await codes('constantine')).toEqual(['CNE']);
    expect(await codes('SIEGE')).toEqual(['ALG-HQ']);
    expect(await codes('siège')).toEqual(['ALG-HQ']);
    expect(await codes('region')).toEqual(['CENTRE', 'EST', 'OUEST']);
    expect(await codes('cne')).toEqual(['CNE']); // code match
    expect(await codes('%')).toEqual([]); // LIKE wildcards are literal
    const sites = await demo().get('/api/org/units?kind=site').expect(200);
    expect(sites.body.items).toHaveLength(6);
    await demo().get('/api/org/units?kind=department').expect(422);
  });

  it('GET /api/org/units/:id → detail with versions; unknown or malformed ids → 404', async () => {
    const res = await demo().get(`/api/org/units/${unit('BLIDA')}`).expect(200);
    assertNoSecrets(res.body);
    expect(res.body).toMatchObject({
      id: unit('BLIDA'),
      kind: 'site',
      code: 'BLIDA',
      name: 'Blida',
      path: [{ name: 'Groupe Démo' }, { name: 'Région Centre' }],
      versions: [{ validFrom: '2026-01-01', validTo: null, name: 'Blida', parentId: unit('CENTRE') }],
      _actions: ['update'],
    });
    expect(res.body.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    await demo().get('/api/org/units/0190a5d0-0000-7000-8000-0000000fffff').expect(404);
    const bad = await demo().get('/api/org/units/not-a-uuid').expect(404);
    expect(bad.headers['content-type']).toMatch(PROBLEM_JSON);
  });

  it('POST /api/org/units creates a region and a site (201 + Location), closure maintained', async () => {
    const region = await demo()
      .post('/api/org/units')
      .send({ kind: 'region', code: 'SUD', name: '  Région Sud  ', parentId: unit('GROUPE'), validFrom: '2026-02-01' })
      .expect(201);
    assertNoSecrets(region.body);
    expect(region.headers['location']).toBe(`/api/org/units/${region.body.id}`);
    expect(region.body).toMatchObject({
      kind: 'region',
      code: 'SUD',
      name: 'Région Sud',
      path: [{ id: unit('GROUPE'), name: 'Groupe Démo' }],
      versions: [{ validFrom: '2026-02-01', validTo: null, name: 'Région Sud', parentId: unit('GROUPE') }],
      _actions: ['update', 'create_child'],
    });

    const site = await demo()
      .post('/api/org/units')
      .send({ kind: 'site', code: 'OUARGLA', name: 'Ouargla', parentId: region.body.id })
      .expect(201);
    expect(site.body.versions[0].validFrom).toBe(today);
    expect(site.body.path.map((p: { name: string }) => p.name)).toEqual(['Groupe Démo', 'Région Sud']);

    const closure = await query<{ ancestor_id: string; depth: number }>(
      db.superuserUrl,
      'select ancestor_id, depth from org_unit_closure where descendant_id = $1 order by depth',
      [site.body.id],
    );
    expect(closure).toEqual([
      { ancestor_id: site.body.id, depth: 0 },
      { ancestor_id: region.body.id, depth: 1 },
      { ancestor_id: unit('GROUPE'), depth: 2 },
    ]);
    await demo().get(`/api/org/units/${site.body.id}`).expect(200);
  });

  it('invalid parent kind → 409 org-unit-invalid-parent with errors[field=parentId]', async () => {
    const res = await demo()
      .post('/api/org/units')
      .send({ kind: 'site', code: 'NOPE', name: 'Nope', parentId: unit('GROUPE') })
      .expect(409);
    expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
    expect(res.body).toMatchObject({ type: 'urn:hrforce:problem:org-unit-invalid-parent', status: 409 });
    expect(res.body.errors).toEqual([expect.objectContaining({ field: 'parentId', code: 'invalid_parent_kind' })]);

    const underSite = await demo()
      .post('/api/org/units')
      .send({ kind: 'site', code: 'NOPE', name: 'Nope', parentId: unit('ORAN') })
      .expect(409);
    expect(underSite.body.errors[0].field).toBe('parentId');

    const missing = await demo()
      .post('/api/org/units')
      .send({ kind: 'region', code: 'NOPE', name: 'Nope', parentId: '0190a5d0-0000-7000-8000-0000000fffff' })
      .expect(409);
    expect(missing.body.errors[0]).toMatchObject({ field: 'parentId', code: 'not_found' });

    const beforeParent = await demo()
      .post('/api/org/units')
      .send({ kind: 'site', code: 'NOPE', name: 'Nope', parentId: unit('EST'), validFrom: '2025-06-01' })
      .expect(409);
    expect(beforeParent.body.errors[0]).toMatchObject({ field: 'parentId', code: 'parent_not_effective' });
  });

  it('duplicate code → 409 org-unit-code-taken with errors[field=code]', async () => {
    const res = await demo()
      .post('/api/org/units')
      .send({ kind: 'site', code: 'ORAN', name: 'Oran bis', parentId: unit('OUEST') })
      .expect(409);
    expect(res.body).toMatchObject({ type: 'urn:hrforce:problem:org-unit-code-taken', errors: [{ field: 'code' }] });
  });

  it('invalid bodies → 422 with errors[] per field', async () => {
    const res = await demo()
      .post('/api/org/units')
      .send({ kind: 'company', code: 'bad code', name: '   ', parentId: 'x', validFrom: '01/02/2026' })
      .expect(422);
    expect((res.body.errors as { field: string }[]).map((e) => e.field).toSorted()).toEqual([
      'code',
      'kind',
      'name',
      'parentId',
      'validFrom',
    ]);
    const tooLong = await demo()
      .post('/api/org/units')
      .send({ kind: 'site', code: 'LONG', name: 'x'.repeat(121), parentId: unit('EST') })
      .expect(422);
    expect(tooLong.body.errors[0].field).toBe('name');
    const empty = await demo().patch(`/api/org/units/${unit('ORAN')}`).send({ validFrom: '2026-05-01' }).expect(422);
    expect(empty.body.errors[0].field).toBe('name');
  });

  it('PATCH moves a site from validFrom: tree before vs after differs, history split, closure rebuilt', async () => {
    const res = await demo()
      .patch(`/api/org/units/${unit('ORAN')}`)
      .send({ parentId: unit('CENTRE'), name: 'Oran Port', validFrom: '2026-03-01' })
      .expect(200);
    assertNoSecrets(res.body);
    expect(res.body.versions).toEqual([
      { validFrom: '2026-03-01', validTo: null, name: 'Oran Port', parentId: unit('CENTRE') },
      { validFrom: '2026-01-01', validTo: '2026-03-01', name: 'Oran', parentId: unit('OUEST') },
    ]);
    expect(res.body.name).toBe('Oran Port');
    expect(res.body.path.map((p: { name: string }) => p.name)).toEqual(['Groupe Démo', 'Région Centre']);

    const before = await demo().get('/api/org/tree?asOf=2026-02-28').expect(200);
    const after = await demo().get('/api/org/tree?asOf=2026-03-01').expect(200);
    expect(sitesOf(before.body, 'CENTRE')).toEqual(['Alger – Siège', 'Blida']);
    expect(sitesOf(before.body, 'OUEST')).toEqual(['Oran', 'Tlemcen']);
    expect(sitesOf(after.body, 'CENTRE')).toEqual(['Alger – Siège', 'Blida', 'Oran Port']);
    expect(sitesOf(after.body, 'OUEST')).toEqual(['Tlemcen']);

    const closure = await query<{ ancestor_id: string; depth: number }>(
      db.superuserUrl,
      'select ancestor_id, depth from org_unit_closure where descendant_id = $1 order by depth',
      [unit('ORAN')],
    );
    expect(closure).toEqual([
      { ancestor_id: unit('ORAN'), depth: 0 },
      { ancestor_id: unit('CENTRE'), depth: 1 },
      { ancestor_id: unit('GROUPE'), depth: 2 },
    ]);
  });

  it('a future-dated move changes the tree from that date but not today’s closure', async () => {
    await demo()
      .patch(`/api/org/units/${unit('TLEMCEN')}`)
      .send({ parentId: unit('EST'), validFrom: '2099-01-01' })
      .expect(200);
    const future = await demo().get('/api/org/tree?asOf=2099-01-01').expect(200);
    const est = (future.body.root as TreeNode).children.find((r) => r.code === 'EST');
    expect(est?.children.map((s) => s.code)).toContain('TLEMCEN');
    const closure = await query<{ ancestor_id: string }>(
      db.superuserUrl,
      'select ancestor_id from org_unit_closure where descendant_id = $1 and depth = 1',
      [unit('TLEMCEN')],
    );
    expect(closure).toEqual([{ ancestor_id: unit('OUEST') }]);
  });

  it('version rules: validFrom not after the current start → 409 overlap; root cannot move; cycles refused', async () => {
    const overlap = await demo()
      .patch(`/api/org/units/${unit('ORAN')}`)
      .send({ name: 'Oran again', validFrom: '2026-03-01' })
      .expect(409);
    expect(overlap.body).toMatchObject({ type: 'urn:hrforce:problem:org-unit-version-overlap', errors: [{ field: 'validFrom' }] });

    const root = await demo()
      .patch(`/api/org/units/${unit('GROUPE')}`)
      .send({ parentId: unit('EST'), validFrom: '2026-04-01' })
      .expect(409);
    expect(root.body).toMatchObject({ type: 'urn:hrforce:problem:org-unit-root-immutable', errors: [{ field: 'parentId' }] });

    const renamed = await demo()
      .patch(`/api/org/units/${unit('GROUPE')}`)
      .send({ name: 'Groupe Démo SPA', validFrom: '2026-04-01' })
      .expect(200);
    expect(renamed.body.versions[0]).toMatchObject({ name: 'Groupe Démo SPA', parentId: null });

    // A region under a site is refused by the parent rules before it could form a cycle.
    const cycle = await demo()
      .patch(`/api/org/units/${unit('EST')}`)
      .send({ parentId: unit('CNE'), validFrom: '2026-04-01' })
      .expect(409);
    expect(cycle.body.errors[0].field).toBe('parentId');
  });

  it('tenant isolation: company B cannot see, get or patch company A units (404)', async () => {
    const tree = await beta().get('/api/org/tree').expect(200);
    expect(shape(tree.body.root)).toEqual({ BETA: ['NORD'] });
    const search = await beta().get('/api/org/units?q=alger').expect(200);
    expect(search.body.items).toEqual([]);
    await beta().get(`/api/org/units/${unit('BLIDA')}`).expect(404);
    await beta().patch(`/api/org/units/${unit('BLIDA')}`).send({ name: 'Hacked', validFrom: '2026-06-01' }).expect(404);
    // …nor use them as a parent
    const res = await beta()
      .post('/api/org/units')
      .send({ kind: 'site', code: 'SPY', name: 'Spy', parentId: unit('CENTRE') })
      .expect(409);
    expect(res.body.errors[0]).toMatchObject({ field: 'parentId', code: 'not_found' });
    const [blida] = await query<{ name: string }>(db.superuserUrl, `select name from org_unit_version where org_unit_id = $1`, [unit('BLIDA')]);
    expect(blida?.name).toBe('Blida');
  });

  it('without the permission → 403; read-only callers get empty _actions', async () => {
    const r = as(restricted);
    const denied = await r.get('/api/org/tree').expect(403);
    expect(denied.body).toMatchObject({ type: 'urn:hrforce:problem:forbidden', status: 403 });
    await r.post('/api/org/units').send({ kind: 'region', code: 'X1', name: 'X', parentId: unit('GROUPE') }).expect(403);

    TestPermissionEvaluator.granted = ['org_unit.read'];
    const tree = await r.get('/api/org/tree').expect(200);
    expect(actionsOf(tree.body.root)).toEqual([]);
    await r.patch(`/api/org/units/${unit('BLIDA')}`).send({ name: 'Blida 2' }).expect(403);

    TestPermissionEvaluator.granted = ['org_unit.read', 'org_unit.create'];
    const detail = await r.get(`/api/org/units/${unit('EST')}`).expect(200);
    expect(actionsOf(detail.body)).toEqual(['create_child']);
  });

  it('anonymous (no dev headers) → 401', async () => {
    await request(app.getHttpServer()).get('/api/org/tree').expect(401);
  });
});
