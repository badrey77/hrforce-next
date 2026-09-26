/**
 * Authorization slice (docs/contracts/authorization.md) against real grants: organisation scoping, separation of
 * duties, escalation attempts, date-effective grants, /api/me, RLS on the new tables and auth.company_members.
 * The route × actor × target status matrix lives in authorization-matrix.e2e-spec.ts.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessClock, seedGrants } from '../src/modules/authorization/index.js';
import { DEMO_PASSWORD, seedIdentity } from '../src/modules/identity/index.js';
import { DEMO_ORGANIZATION, toIsoDate } from '../src/modules/organization/index.js';
import { createDatabase } from '../src/platform/db/database.js';
import { assertNoSecrets } from './support/assert-no-secrets.js';
import { as, COMPANY_A, COMPANY_B, GRANTS, seedAccessFixture, unitA, USERS, type AccessFixture, type ActorName } from './support/access-fixture.js';
import { Browser } from './support/cookie-jar.js';
import { createTestApp } from './support/test-app.js';
import { createTestDatabase, query, type TestDatabase } from './support/test-database.js';
import { fetchXsrf, type XsrfPair } from './support/xsrf.js';

interface TreeNode {
  id: string;
  code: string;
  inScope: boolean;
  site: { code: string } | null;
  children: TreeNode[];
  _actions: string[];
}

function shape(node: TreeNode): unknown {
  return node.children.length ? { [node.code]: node.children.map(shape) } : node.code;
}

function find(node: TreeNode, code: string): TreeNode | undefined {
  if (node.code === code) return node;
  for (const child of node.children) {
    const hit = find(child, code);
    if (hit) return hit;
  }
  return undefined;
}

function allCodes(node: TreeNode): string[] {
  return [node.code, ...node.children.flatMap(allCodes)];
}

const extraGrant = (n: string) => `0190a5d0-0000-7000-8000-000000000e${n}`;
const serviceBody = (code: string, parent: string) => ({ kind: 'service', code, name: `Service ${code}`, parentId: unitA(parent) });
/** POST /api/access/grants with defaults (sub-units included, from 2028-01-01). */
const grant = (actor: { post: (url: string) => ReturnType<ReturnType<typeof as>['post']> }, body: Record<string, unknown>) =>
  actor.post('/api/access/grants').send({ includeDescendants: true, validFrom: '2028-01-01', ...body });
const PROBLEM = (slug: string) => `urn:hrforce:problem:${slug}`;
const shift = (days: number) => toIsoDate(new Date(Date.now() + days * 86_400_000));

/** Extra users of this file (members of DEMO), seeded with their grants below. */
const EXTRA = {
  /** custom role {org_unit.read, create, update} on REG-EST (+) and lecture on REG-OUEST (+) */
  creator: { id: '0190a5d0-0000-7000-8000-0000000000c1', email: 'creator@demo.dz', displayName: 'Rym Createur', locale: 'fr' as const },
  /** admin_acces on REG-EST WITHOUT sub-units */
  accesUnit: { id: '0190a5d0-0000-7000-8000-0000000000c2', email: 'acces.unit@demo.dz', displayName: 'Omar Unite', locale: 'fr' as const },
  /** admin_acces on DG (+): company-wide access admin */
  accesDg: { id: '0190a5d0-0000-7000-8000-0000000000c3', email: 'acces.dg@demo.dz', displayName: 'Sara Globale', locale: 'fr' as const },
  /** lecture on REG-EST (+), valid from TOMORROW */
  future: { id: '0190a5d0-0000-7000-8000-0000000000c4', email: 'future@demo.dz', displayName: 'Farid Futur', locale: 'fr' as const },
};

describe('Authorization (e2e, real grants)', () => {
  let db: TestDatabase;
  let app: NestExpressApplication;
  let fx: AccessFixture;
  let xsrf: XsrfPair;
  const today = toIsoDate(new Date());
  const tomorrow = shift(1);

  const client = (actor: ActorName) => as(app, actor, xsrf);
  const asUser = (user: { id: string }, company = COMPANY_A) => {
    const headers = (req: ReturnType<ReturnType<typeof as>['get']>) => req.set('X-Dev-User-Id', user.id).set('X-Dev-Company-Id', company);
    const anon = as(app, null, xsrf);
    return {
      get: (url: string) => headers(anon.get(url)),
      post: (url: string) => headers(anon.post(url)),
      patch: (url: string) => headers(anon.patch(url)),
    };
  };

  const inTenant = async <T extends object>(company: string | null, text: string, values: unknown[] = []): Promise<T[]> => {
    const c = new Client({ connectionString: db.appUrl });
    await c.connect();
    try {
      await c.query('begin');
      if (company) await c.query(`select set_config('app.company_id', $1, true)`, [company]);
      const rows = (await c.query(text, values)).rows as T[];
      await c.query('commit');
      return rows;
    } catch (error) {
      await c.query('rollback');
      throw error;
    } finally {
      await c.end();
    }
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    fx = await seedAccessFixture(db);
    const migrator = createDatabase({ connectionString: db.migratorUrl, maxConnections: 1 });
    try {
      await migrator.transaction().execute(async (tx) => {
        await seedIdentity(tx, COMPANY_A, Object.values(EXTRA));
        await tx
          .insertInto('role')
          .values({ company_id: COMPANY_A, code: 'createur_est', name_fr: 'Créateur', name_ar: 'منشئ', name_en: 'Creator' })
          .execute();
        const role = await tx.selectFrom('role').select('id').where('company_id', '=', COMPANY_A).where('code', '=', 'createur_est').executeTakeFirstOrThrow();
        await tx
          .insertInto('role_permission')
          .values(['org_unit.read', 'org_unit.create', 'org_unit.update'].map((code) => ({ company_id: COMPANY_A, role_id: role.id, permission_code: code })))
          .execute();
        await seedGrants(tx, COMPANY_A, [
          { id: extraGrant('01'), userId: EXTRA.creator.id, roleCode: 'createur_est', orgUnitId: unitA('REG-EST'), includeDescendants: true, validFrom: '2026-01-01' },
          { id: extraGrant('02'), userId: EXTRA.creator.id, roleCode: 'lecture', orgUnitId: unitA('REG-OUEST'), includeDescendants: true, validFrom: '2026-01-01' },
          { id: extraGrant('03'), userId: EXTRA.accesUnit.id, roleCode: 'admin_acces', orgUnitId: unitA('REG-EST'), includeDescendants: false, validFrom: '2026-01-01' },
          { id: extraGrant('04'), userId: EXTRA.accesDg.id, roleCode: 'admin_acces', orgUnitId: unitA('DG'), includeDescendants: true, validFrom: '2026-01-01' },
          { id: extraGrant('05'), userId: EXTRA.future.id, roleCode: 'lecture', orgUnitId: unitA('REG-EST'), includeDescendants: true, validFrom: tomorrow },
        ]);
      });
    } finally {
      await migrator.destroy();
    }
    app = await createTestApp(db, { devAuth: true, devPermissions: false });
    xsrf = await fetchXsrf(app);
  });

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  // ---------------------------------------------------------------------------------------------------------
  describe('GET /api/me', () => {
    it('rh.est (real cookie login): permissions sorted, scopes per code; no secrets', async () => {
      const b = new Browser(app);
      expect((await b.login('rh.est@demo.dz', DEMO_PASSWORD)).status).toBe(204);
      const res = await b.get('/api/me');
      expect(res.status).toBe(200);
      assertNoSecrets(res.body);
      const scope = [{ unitId: unitA('REG-EST'), includeDescendants: true }];
      expect(res.body.permissions).toEqual(['employee.create', 'employee.read', 'employee.update', 'org_unit.read', 'site.read']);
      expect(res.body.scopes).toEqual({
        'employee.create': scope,
        'employee.read': scope,
        'employee.update': scope,
        'org_unit.read': scope,
        'site.read': scope,
      });
      expect(res.body.user).toMatchObject({ email: 'rh.est@demo.dz', locale: 'ar' });
    });

    it('admin holds everything except employee.medical.read on DG (+); a member without grants holds nothing', async () => {
      const admin = await client('admin').get('/api/me').expect(200);
      expect(admin.body.permissions).toHaveLength(14);
      expect(admin.body.permissions).not.toContain('employee.medical.read');
      expect(admin.body.scopes['employee.salary.read']).toEqual([{ unitId: unitA('DG'), includeDescendants: true }]);
      const newbie = await client('newbie').get('/api/me').expect(200);
      expect(newbie.body).toMatchObject({ permissions: [], scopes: {} });
    });

    it('merges several grants of the same code (lecture.ouest-like creator: two units)', async () => {
      const res = await asUser(EXTRA.creator).get('/api/me').expect(200);
      expect(res.body.scopes['org_unit.read']).toEqual(
        [
          { unitId: unitA('REG-EST'), includeDescendants: true },
          { unitId: unitA('REG-OUEST'), includeDescendants: true },
        ].toSorted((a, b) => (a.unitId < b.unitId ? -1 : 1)),
      );
      expect(res.body.scopes['org_unit.create']).toEqual([{ unitId: unitA('REG-EST'), includeDescendants: true }]);
    });
  });

  // ---------------------------------------------------------------------------------------------------------
  describe('organisation scoping', () => {
    it('rh_regional tree: DG → DEP-RX → REG-EST subtree, ancestors as muted context', async () => {
      const res = await client('est').get('/api/org/tree').expect(200);
      const root = res.body.root as TreeNode;
      expect(shape(root)).toEqual({
        DG: [{ 'DEP-RX': [{ 'REG-EST': [{ 'AG-ANNABA': ['SRV-CLI-ANB'] }, 'AG-CNE', 'SRV-ADM-EST'] }] }],
      });
      for (const code of ['DG', 'DEP-RX']) {
        expect(find(root, code)).toMatchObject({ inScope: false, _actions: [] });
      }
      expect(find(root, 'DG')?.site?.code).toBe('ALG-HQ'); // context nodes still show their site
      for (const code of ['REG-EST', 'AG-CNE', 'SRV-CLI-ANB']) expect(find(root, code)).toMatchObject({ inScope: true, _actions: [] });
    });

    it('lecture.ouest sees only its region; admin sees the whole tree with actions', async () => {
      const ouest = (await client('ouest').get('/api/org/tree').expect(200)).body.root as TreeNode;
      expect(shape(ouest)).toEqual({ DG: [{ 'DEP-RX': [{ 'REG-OUEST': ['AG-ORAN', 'AG-TLEMCEN'] }] }] });
      const admin = (await client('admin').get('/api/org/tree').expect(200)).body.root as TreeNode;
      expect(allCodes(admin)).toHaveLength(DEMO_ORGANIZATION.units.length);
      expect(admin).toMatchObject({ inScope: true, _actions: ['update', 'create_child'] });
      expect(find(admin, 'SRV-PAIE')).toMatchObject({ inScope: true, _actions: ['update'] });
    });

    it('a regional user provably cannot read another region’s units (detail 404, search and tree omit them)', async () => {
      const ouestCodes = DEMO_ORGANIZATION.units.filter((u) => ['REG-OUEST', 'AG-ORAN', 'AG-TLEMCEN'].includes(u.code));
      for (const u of ouestCodes) {
        const res = await client('est').get(`/api/org/units/${u.id}`);
        expect(res.status, u.code).toBe(404);
        expect(res.body.type).toBe(PROBLEM('not-found'));
      }
      // identical to an id that does not exist at all
      const missing = await client('est').get('/api/org/units/0190a5d0-0000-7000-8000-0000000fffff').expect(404);
      expect(missing.body.title).toBe((await client('est').get(`/api/org/units/${unitA('AG-ORAN')}`)).body.title);
      const search = await client('est').get('/api/org/units?q=oran').expect(200);
      expect(search.body.items).toEqual([]);
      const all = await client('est').get('/api/org/units').expect(200);
      expect((all.body.items as { code: string }[]).map((u) => u.code)).toEqual(['AG-ANNABA', 'AG-CNE', 'REG-EST', 'SRV-ADM-EST', 'SRV-CLI-ANB']);
      const tree = (await client('est').get('/api/org/tree').expect(200)).body.root as TreeNode;
      expect(allCodes(tree)).not.toContain('REG-OUEST');
      expect(allCodes(tree)).not.toContain('AG-ORAN');
      // paths still name the (out-of-scope) ancestors, as context
      const cne = await client('est').get(`/api/org/units/${unitA('AG-CNE')}`).expect(200);
      expect((cne.body.path as { name: string }[]).map((p) => p.name)).toEqual(['Direction Générale', 'Département RX', 'Région Est']);
    });

    it('create: needs org_unit.create on the parent (404 unreadable, 403 forbidden-scope readable-only)', async () => {
      const c = asUser(EXTRA.creator);
      const ok = await c.post('/api/org/units').send(serviceBody('SC-EST', 'AG-CNE')).expect(201);
      expect(ok.body['_actions']).toEqual(['update']);
      const forbidden = await c.post('/api/org/units').send(serviceBody('SC-OUEST', 'AG-ORAN')).expect(403);
      expect(forbidden.body).toMatchObject({ type: PROBLEM('forbidden-scope'), errors: [{ field: 'parentId', code: 'forbidden_scope' }] });
      const hidden = await c.post('/api/org/units').send(serviceBody('SC-RH', 'DEP-RH')).expect(404);
      expect(hidden.body.type).toBe(PROBLEM('not-found'));
    });

    it('update: needs org_unit.update on the unit, and on the new parent for a move', async () => {
      const c = asUser(EXTRA.creator);
      expect((await c.get(`/api/org/units/${unitA('REG-EST')}`).expect(200)).body['_actions']).toEqual(['update', 'create_child']);
      expect((await c.get(`/api/org/units/${unitA('AG-ORAN')}`).expect(200)).body['_actions']).toEqual([]);
      await c.patch(`/api/org/units/${unitA('AG-ORAN')}`).send({ name: 'Oran bis', validFrom: '2027-03-01' }).expect(403);
      await c.patch(`/api/org/units/${unitA('AG-BLIDA')}`).send({ name: 'Blida bis', validFrom: '2027-03-01' }).expect(404);
      await c.patch(`/api/org/units/${unitA('SRV-ADM-EST')}`).send({ name: 'Admin Est bis', validFrom: '2027-03-01' }).expect(200);
      // move SRV-ADM-EST (in scope) under AG-ORAN: readable but not updatable → 403 on parentId
      const intoOuest = await c.patch(`/api/org/units/${unitA('SRV-ADM-EST')}`).send({ parentId: unitA('AG-ORAN'), validFrom: '2027-04-01' }).expect(403);
      expect(intoOuest.body).toMatchObject({ type: PROBLEM('forbidden-scope'), errors: [{ field: 'parentId' }] });
      // under AG-BLIDA: unreadable → reported like an unknown parent
      const intoCentre = await c.patch(`/api/org/units/${unitA('SRV-ADM-EST')}`).send({ parentId: unitA('AG-BLIDA'), validFrom: '2027-04-01' }).expect(409);
      expect(intoCentre.body.errors[0]).toMatchObject({ field: 'parentId', code: 'not_found' });
      await c.patch(`/api/org/units/${unitA('SRV-ADM-EST')}`).send({ parentId: unitA('AG-CNE'), validFrom: '2027-04-01' }).expect(200);
    });

    it('sites stay company-wide (site.read anywhere lists every site)', async () => {
      const res = await client('est').get('/api/org/sites').expect(200);
      expect((res.body.items as unknown[]).length).toBeGreaterThanOrEqual(DEMO_ORGANIZATION.sites.length);
    });
  });

  // ---------------------------------------------------------------------------------------------------------
  describe('access endpoints', () => {
    it('GET /access/permissions: catalogue by group then sortOrder, with real fr/ar/en labels', async () => {
      const res = await client('admin').get('/api/access/permissions').expect(200);
      const items = res.body.items as { code: string; group: string; sensitive: boolean; labels: { fr: string; ar: string; en: string } }[];
      expect(items.map((p) => p.code)).toEqual([
        'org_unit.read', 'org_unit.create', 'org_unit.update', 'site.read', 'site.create',
        'access.read', 'access.grant', 'access.manage_roles',
        'employee.read', 'employee.create', 'employee.update',
        'employee.salary.read', 'employee.bank.read', 'employee.nss.read', 'employee.medical.read',
      ]);
      expect(items[0]).toEqual({
        code: 'org_unit.read',
        group: 'organization',
        sensitive: false,
        labels: { fr: "Consulter l'organisation", ar: 'الاطلاع على الهيكل التنظيمي', en: 'View the organisation' },
      });
      expect(items.filter((p) => p.sensitive).map((p) => p.group)).toEqual(['sensitive', 'sensitive', 'sensitive', 'sensitive']);
      for (const p of items) expect(p.labels.ar).toMatch(/[؀-ۿ]/);
    });

    it('GET /access/roles: system roles first, with their permissions', async () => {
      const res = await client('acces').get('/api/access/roles').expect(200);
      const roles = res.body.items as { code: string; isSystem: boolean; permissions: string[]; names: { ar: string } }[];
      expect(roles.filter((r) => r.isSystem).map((r) => r.code).toSorted()).toEqual(['admin_acces', 'admin_rh_central', 'lecture', 'rh_regional']);
      expect(roles.find((r) => r.code === 'lecture')?.permissions).toEqual(['org_unit.read', 'site.read', 'employee.read']);
      expect(roles.find((r) => r.code === 'rh_regional')?.names.ar).toBe('مسؤول الموارد البشرية الجهوي');
    });

    it('GET /access/users: members with a grant in the caller’s access.read scope, or none at all', async () => {
      const res = await client('acces').get('/api/access/users').expect(200);
      assertNoSecrets(res.body);
      const users = res.body.items as { id: string; grants: { unit: { code: string } }[] }[];
      const ids = users.map((u) => u.id);
      expect(ids).toContain(USERS.est.id); // REG-EST
      expect(ids).toContain(USERS.newbie.id); // no grant at all
      expect(ids).not.toContain(USERS.ouest.id); // REG-OUEST only
      expect(ids).not.toContain(USERS.admin.id); // DG only
      // grants shown are only those in scope (target also holds one on AG-ORAN)
      expect(users.find((u) => u.id === USERS.target.id)?.grants.map((g) => g.unit.code)).toEqual(['AG-CNE']);
      const q = await client('acces').get('/api/access/users?q=karim').expect(200);
      expect((q.body.items as { id: string }[]).map((u) => u.id)).toEqual([USERS.est.id]);
    });

    it('GET /access/grants: limited to the access.read scope; GrantView shape; `end` never on one’s own grant', async () => {
      const res = await client('acces').get('/api/access/grants').expect(200);
      const grants = res.body.items as { id: string; userId: string; unit: { code: string }; _actions: string[] }[];
      expect(grants.every((g) => ['REG-EST', 'AG-CNE', 'AG-ANNABA', 'SRV-ADM-EST', 'SRV-CLI-ANB'].includes(g.unit.code))).toBe(true);
      expect(grants.find((g) => g.id === GRANTS.targetOran)).toBeUndefined();
      expect(grants.find((g) => g.id === GRANTS.accesEst)?.['_actions']).toEqual([]);
      const est = grants.find((g) => g.userId === USERS.est.id);
      expect(est).toEqual({
        id: '0190a5d0-0000-7000-8000-000000000302',
        userId: USERS.est.id,
        role: { id: fx.rolesA['rh_regional'], code: 'rh_regional', names: { fr: 'RH régional', ar: 'مسؤول الموارد البشرية الجهوي', en: 'Regional HR' } },
        unit: { id: unitA('REG-EST'), code: 'REG-EST', name: 'Région Est', kind: 'region' },
        includeDescendants: true,
        validFrom: '2026-01-01',
        validTo: null,
        grantedBy: null,
        grantedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
        _actions: ['end'],
      });
      const byUser = await client('admin').get(`/api/access/grants?userId=${USERS.target.id}`).expect(200);
      expect((byUser.body.items as { unit: { code: string } }[]).map((g) => g.unit.code).toSorted()).toEqual(['AG-CNE', 'AG-ORAN']);
      const byUnit = await client('admin').get(`/api/access/grants?unitId=${unitA('REG-OUEST')}`).expect(200);
      expect((byUnit.body.items as { userId: string }[]).map((g) => g.userId).toSorted()).toEqual([USERS.ouest.id, EXTRA.creator.id].toSorted());
      await client('admin').get('/api/access/grants?userId=nope').expect(422);
    });

    it('POST /access/grants → 201 GrantView (granted by the caller), then visible to the grantee', async () => {
      const res = await client('acces')
        .post('/api/access/grants')
        .send({ userId: USERS.newbie.id, roleId: fx.rolesA['admin_acces'], orgUnitId: unitA('AG-ANNABA'), includeDescendants: true, validFrom: today })
        .expect(201);
      expect(res.body).toMatchObject({
        userId: USERS.newbie.id,
        role: { code: 'admin_acces' },
        unit: { code: 'AG-ANNABA', kind: 'agency' },
        validFrom: today,
        validTo: null,
        grantedBy: { id: USERS.acces.id, displayName: 'Nadia Acces' },
        _actions: ['end'],
      });
      const me = await client('newbie').get('/api/me').expect(200);
      expect(me.body.scopes['access.grant']).toEqual([{ unitId: unitA('AG-ANNABA'), includeDescendants: true }]);
      // ending it today: from tomorrow on it is gone; ending "today" = never effective from today
      const ended = await client('acces').post(`/api/access/grants/${res.body.id}/end`).send({ validTo: today }).expect(200);
      expect(ended.body).toMatchObject({ validFrom: today, validTo: today, _actions: [] });
      expect((await client('newbie').get('/api/me').expect(200)).body.permissions).toEqual([]);
      const [row] = await query<{ ended_by: string; ended_at: Date | null }>(db.superuserUrl, 'select ended_by, ended_at from role_grant where id = $1', [res.body.id]);
      expect(row?.ended_by).toBe(USERS.acces.id);
      expect(row?.ended_at).not.toBeNull();
    });
  });

  // ---------------------------------------------------------------------------------------------------------
  describe('separation of duties (409 slugs) and escalation attempts', () => {
    it('grant-self: granting to oneself, and ending one’s own grant', async () => {
      const self = await grant(client('acces'), { userId: USERS.acces.id, roleId: fx.rolesA['lecture'], orgUnitId: unitA('AG-CNE') }).expect(409);
      expect(self.body).toMatchObject({ type: PROBLEM('grant-self'), errors: [{ field: 'userId', code: 'grant-self' }] });
      const endOwn = await client('acces').post(`/api/access/grants/${GRANTS.accesEst}/end`).send({ validTo: today }).expect(409);
      expect(endOwn.body.type).toBe(PROBLEM('grant-self'));
      const adminSelf = await grant(client('admin'), { userId: USERS.admin.id, roleId: fx.rolesA['lecture'], orgUnitId: unitA('DG') }).expect(409);
      expect(adminSelf.body.type).toBe(PROBLEM('grant-self'));
    });

    it('grant-out-of-scope: outside the caller’s access.grant scope, or a subtree not wholly inside it', async () => {
      const out = await grant(client('acces'), { userId: USERS.newbie.id, roleId: fx.rolesA['admin_acces'], orgUnitId: unitA('AG-ORAN') }).expect(409);
      expect(out.body).toMatchObject({ type: PROBLEM('grant-out-of-scope'), errors: [{ field: 'orgUnitId' }] });
      // acces.unit holds admin_acces on REG-EST WITHOUT sub-units: the unit alone is fine, the subtree is not
      const unitOnly = asUser(EXTRA.accesUnit);
      await grant(unitOnly, { userId: USERS.newbie.id, roleId: fx.rolesA['admin_acces'], orgUnitId: unitA('REG-EST'), includeDescendants: false, validFrom: '2028-02-01' }).expect(201);
      const subtree = await grant(unitOnly, { userId: USERS.target.id, roleId: fx.rolesA['admin_acces'], orgUnitId: unitA('REG-EST'), includeDescendants: true }).expect(409);
      expect(subtree.body.type).toBe(PROBLEM('grant-out-of-scope'));
      await grant(unitOnly, { userId: USERS.target.id, roleId: fx.rolesA['admin_acces'], orgUnitId: unitA('AG-CNE'), includeDescendants: false }).expect(409);
      // unknown unit ids are out of scope too (no existence oracle)
      await grant(client('admin'), { userId: USERS.newbie.id, roleId: fx.rolesA['lecture'], orgUnitId: '0190a5d0-0000-7000-8000-0000000fffff' }).expect(409);
    });

    it('grant-escalation: admin_acces cannot hand out admin_rh_central (salary, …) nor lecture (employee.read)', async () => {
      const esc = await grant(client('acces'), { userId: USERS.newbie.id, roleId: fx.rolesA['admin_rh_central'], orgUnitId: unitA('AG-CNE') }).expect(409);
      expect(esc.body).toMatchObject({ type: PROBLEM('grant-escalation'), errors: [{ field: 'roleId' }] });
      expect(esc.body.detail).toContain('employee.salary.read');
      await grant(client('acces'), { userId: USERS.newbie.id, roleId: fx.rolesA['lecture'], orgUnitId: unitA('AG-CNE') }).expect(409);
      // even a company-wide access admin (DG +) cannot, since it does not hold the employee permissions
      const dg = await grant(asUser(EXTRA.accesDg), { userId: USERS.newbie.id, roleId: fx.rolesA['admin_rh_central'], orgUnitId: unitA('DG') }).expect(409);
      expect(dg.body.type).toBe(PROBLEM('grant-escalation'));
      // admin_rh_central can give admin_rh_central on a sub-unit
      await grant(client('admin'), { userId: USERS.newbie.id, roleId: fx.rolesA['admin_rh_central'], orgUnitId: unitA('AG-CNE') }).expect(201);
    });

    it('grant-user-not-member, grant-dates, grant-duplicate, unknown role', async () => {
      const notMember = await grant(client('admin'), { userId: USERS.beta.id, roleId: fx.rolesA['lecture'], orgUnitId: unitA('AG-CNE') }).expect(409);
      expect(notMember.body).toMatchObject({ type: PROBLEM('grant-user-not-member'), errors: [{ field: 'userId' }] });
      const dates = await grant(client('admin'), { userId: USERS.newbie.id, roleId: fx.rolesA['lecture'], orgUnitId: unitA('AG-CNE'), validTo: '2028-01-01' }).expect(409);
      expect(dates.body).toMatchObject({ type: PROBLEM('grant-dates'), errors: [{ field: 'validTo' }] });
      const body = { userId: USERS.newbie.id, roleId: fx.rolesA['lecture'], orgUnitId: unitA('AG-TLEMCEN'), validFrom: '2029-01-01', validTo: '2029-06-01' };
      const first = await grant(client('admin'), body).expect(201);
      const dup = await grant(client('admin'), { ...body, validFrom: '2029-03-01', validTo: null }).expect(409);
      expect(dup.body.type).toBe(PROBLEM('grant-duplicate'));
      await grant(client('admin'), { ...body, validFrom: '2029-06-01', validTo: null }).expect(201); // adjacent, not overlapping
      const unknownRole = await grant(client('admin'), { ...body, roleId: fx.rolesB['lecture'] }).expect(422);
      expect(unknownRole.body.errors).toEqual([expect.objectContaining({ field: 'roleId', code: 'not_found' })]);
      // end: not before the start, not after the current end
      const endEarly = await client('admin').post(`/api/access/grants/${first.body.id}/end`).send({ validTo: '2028-12-31' }).expect(409);
      expect(endEarly.body).toMatchObject({ type: PROBLEM('grant-dates'), errors: [{ field: 'validTo' }] });
      await client('admin').post(`/api/access/grants/${first.body.id}/end`).send({ validTo: '2029-07-01' }).expect(409);
      await client('admin').post(`/api/access/grants/${first.body.id}/end`).send({ validTo: '2029-05-01' }).expect(200);
      await client('admin').post(`/api/access/grants/${first.body.id}/end`).send({ validTo: 'soon' }).expect(422);
    });

    it('roles: role-code-taken (case-insensitive), role-system-immutable, role-escalation, unknown permission', async () => {
      const names = { fr: 'Paie', ar: 'الأجور', en: 'Payroll' };
      const taken = await client('admin').post('/api/access/roles').send({ code: 'LECTURE', names, permissions: [] }).expect(409);
      expect(taken.body).toMatchObject({ type: PROBLEM('role-code-taken'), errors: [{ field: 'code' }] });
      const system = await client('admin').patch(`/api/access/roles/${fx.rolesA['lecture']}`).send({ names }).expect(409);
      expect(system.body.type).toBe(PROBLEM('role-system-immutable'));
      // nobody holds employee.medical.read → nobody can put it in a role
      const medical = await client('admin').post('/api/access/roles').send({ code: 'medecin', names, permissions: ['employee.medical.read'] }).expect(409);
      expect(medical.body).toMatchObject({ type: PROBLEM('role-escalation'), errors: [{ field: 'permissions' }] });
      // a company-wide access admin can bundle access permissions but not employee ones
      const dg = asUser(EXTRA.accesDg);
      await dg.post('/api/access/roles').send({ code: 'paie_rh', names, permissions: ['employee.read'] }).expect(409);
      const created = await dg.post('/api/access/roles').send({ code: 'auditeur', names, permissions: ['access.read', 'org_unit.read'] }).expect(201);
      expect(created.body).toMatchObject({ code: 'auditeur', isSystem: false, permissions: ['org_unit.read', 'access.read'], names });
      expect(created.headers['location']).toBe(`/api/access/roles/${created.body.id}`);
      // edits: adding an unheld permission escalates; removing never does
      await dg.patch(`/api/access/roles/${created.body.id}`).send({ permissions: ['access.read', 'org_unit.read', 'employee.read'] }).expect(409);
      const shrunk = await dg.patch(`/api/access/roles/${created.body.id}`).send({ permissions: ['access.read'] }).expect(200);
      expect(shrunk.body.permissions).toEqual(['access.read']);
      const unknown = await client('admin').post('/api/access/roles').send({ code: 'x_role', names, permissions: ['employee.fly'] }).expect(422);
      expect(unknown.body.errors).toEqual([expect.objectContaining({ field: 'permissions', code: 'unknown_permission' })]);
      await client('admin').post('/api/access/roles').send({ code: 'bad code', names, permissions: [] }).expect(422);
      await client('admin').patch('/api/access/roles/not-a-uuid').send({ names }).expect(404);
    });
  });

  // ---------------------------------------------------------------------------------------------------------
  describe('date-effective grants', () => {
    let tomorrowApp: NestExpressApplication;

    beforeAll(async () => {
      tomorrowApp = await createTestApp(db, {
        devAuth: true,
        devPermissions: false,
        overrides: [{ provide: AccessClock, useValue: { today: () => tomorrow } }],
      });
    });
    afterAll(async () => {
      await tomorrowApp?.close();
    });

    it('a grant starting tomorrow is not effective today (403), and is tomorrow', async () => {
      await asUser(EXTRA.future).get('/api/org/tree').expect(403);
      expect((await asUser(EXTRA.future).get('/api/me').expect(200)).body.permissions).toEqual([]);
      await as(tomorrowApp, null, xsrf).get('/api/org/tree').set('X-Dev-User-Id', EXTRA.future.id).set('X-Dev-Company-Id', COMPANY_A).expect(200);
    });

    it('a grant ended with validTo = tomorrow still works today and stops tomorrow', async () => {
      const created = await client('admin')
        .post('/api/access/grants')
        .send({ userId: USERS.newbie.id, roleId: fx.rolesA['lecture'], orgUnitId: unitA('REG-CTR'), includeDescendants: true, validFrom: '2026-01-01' })
        .expect(201);
      await client('admin').post(`/api/access/grants/${created.body.id}/end`).send({ validTo: tomorrow }).expect(200);
      await client('newbie').get(`/api/org/units/${unitA('AG-BLIDA')}`).expect(200);
      await as(tomorrowApp, 'newbie', xsrf).get(`/api/org/units/${unitA('AG-BLIDA')}`).expect(403);
      // ended grants are hidden by default and listed with includeEnded=true
      const tomorrowAdmin = as(tomorrowApp, 'admin', xsrf);
      const current = (await tomorrowAdmin.get(`/api/access/grants?userId=${USERS.newbie.id}&unitId=${unitA('REG-CTR')}`).expect(200)).body.items as unknown[];
      expect(current).toEqual([]);
      const withEnded = (await tomorrowAdmin.get(`/api/access/grants?userId=${USERS.newbie.id}&unitId=${unitA('REG-CTR')}&includeEnded=true`).expect(200))
        .body.items as { validTo: string; _actions: string[] }[];
      expect(withEnded).toEqual([expect.objectContaining({ validTo: tomorrow, _actions: [] })]);
    });
  });

  // ---------------------------------------------------------------------------------------------------------
  describe('database: RLS, privileges, constraints, auth.company_members', () => {

    it('role, role_permission and role_grant are tenant-isolated (FORCE RLS) for hrforce_app', async () => {
      for (const table of ['role', 'role_permission', 'role_grant']) {
        const a = await inTenant<{ company_id: string }>(COMPANY_A, `select distinct company_id from ${table}`);
        expect(a.map((r) => r.company_id), table).toEqual([COMPANY_A]);
        const b = await inTenant<{ company_id: string }>(COMPANY_B, `select distinct company_id from ${table}`);
        expect(b.map((r) => r.company_id), table).toEqual([COMPANY_B]);
        expect(await inTenant(null, `select 1 from ${table}`), table).toEqual([]);
      }
      await expect(
        inTenant(COMPANY_B, `insert into role (company_id, code, name_fr, name_ar, name_en) values ($1, 'spy', 'x', 'x', 'x')`, [COMPANY_A]),
      ).rejects.toThrow(/row-level security/);
      // a grant cannot point at another tenant's unit or role (composite FKs), even for the migrator
      await expect(
        query(db.migratorUrl, `insert into role_grant (company_id, user_id, role_id, org_unit_id, valid_from) values ($1, $2, $3, $4, '2026-01-01')`, [
          COMPANY_B,
          USERS.beta.id,
          fx.rolesB['lecture'],
          unitA('AG-CNE'),
        ]),
      ).rejects.toThrow(/role_grant_unit_fk/);
    });

    it('permission is a read-only catalogue; grants are never deleted and only shortened', async () => {
      expect((await inTenant<{ n: number }>(COMPANY_A, 'select count(*)::int as n from permission'))[0]?.n).toBe(15);
      await expect(inTenant(COMPANY_A, `insert into permission values ('x.y', 'x', 'x', 'x', 'access', false, 999)`)).rejects.toThrow(/permission denied/);
      await expect(inTenant(COMPANY_A, 'delete from role_grant')).rejects.toThrow(/permission denied/);
      await expect(inTenant(COMPANY_A, 'delete from role')).rejects.toThrow(/permission denied/);
      // shortening is the only change allowed: close an open grant, then try to extend it again
      await inTenant(COMPANY_A, `update role_grant set valid_to = '2031-01-01' where id = $1`, [GRANTS.targetCne]);
      await expect(inTenant(COMPANY_A, `update role_grant set valid_to = '2032-01-01' where id = $1`, [GRANTS.targetCne])).rejects.toThrow(/only be shortened/);
      await expect(inTenant(COMPANY_A, `update role_grant set valid_to = null where id = $1`, [GRANTS.targetCne])).rejects.toThrow(/only be shortened/);
      await expect(inTenant(COMPANY_A, `update role_grant set org_unit_id = $2 where id = $1`, [GRANTS.targetCne, unitA('DG')])).rejects.toThrow(/only valid_to/);
      await expect(
        inTenant(COMPANY_A, `insert into role_grant (company_id, user_id, role_id, org_unit_id, valid_from, granted_by) values ($1, $2, $3, $4, '2026-01-01', $2)`, [
          COMPANY_A,
          USERS.newbie.id,
          fx.rolesA['lecture'],
          unitA('AG-CNE'),
        ]),
      ).rejects.toThrow(/role_grant_not_self_granted_ck/);
    });

    it('auth.company_members returns the current tenant’s members and refuses any other company', async () => {
      const members = await inTenant<{ email: string; status: string }>(COMPANY_A, 'select email, status from auth.company_members($1)', [COMPANY_A]);
      expect(members.map((m) => m.email)).toContain('rh.est@demo.dz');
      expect(members.map((m) => m.email)).not.toContain('admin@beta.dz');
      await expect(inTenant(COMPANY_A, 'select * from auth.company_members($1)', [COMPANY_B])).rejects.toThrow(/not the current tenant/);
      await expect(inTenant(null, 'select * from auth.company_members($1)', [COMPANY_A])).rejects.toThrow(/not the current tenant/);
      await expect(inTenant(COMPANY_A, 'select * from auth.company_members(null)')).rejects.toThrow(/not the current tenant/);
    });
  });

  // ---------------------------------------------------------------------------------------------------------
  it('DEV_PERMISSIONS=allow_all still overrides: a member without grants sees the whole company', async () => {
    const devApp = await createTestApp(db, { devAuth: true, devPermissions: true });
    try {
      const tree = await as(devApp, 'newbie', xsrf).get('/api/org/tree').expect(200);
      expect(allCodes(tree.body.root as TreeNode).length).toBeGreaterThanOrEqual(DEMO_ORGANIZATION.units.length);
      const me = await as(devApp, 'newbie', xsrf).get('/api/me').expect(200);
      expect(me.body.permissions).toContain('employee.medical.read');
      expect(me.body.scopes['org_unit.read']).toEqual([{ unitId: unitA('DG'), includeDescendants: true }]);
    } finally {
      await devApp.close();
    }
  });
});
