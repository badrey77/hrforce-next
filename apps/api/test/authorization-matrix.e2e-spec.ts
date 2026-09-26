/**
 * AUTHORIZATION MATRIX (plan exit criterion: "roles × {self, same scope, other site/region, other company} →
 * 200/403/404 for every endpoint").
 *
 * One row = route × actor × target → expected status, against the REAL grants (DEV_AUTH header identity, no
 * DEV_PERMISSIONS). The route list comes from the route-scan guardrail (`tools/guardrails/route-scan --json`):
 * a new route without a MATRIX entry — or a route whose access declaration changed — fails the first test.
 * Anonymous callers are derived: every non-public route must answer 401.
 *
 * Actors (test/support/access-fixture.ts):
 *   admin  admin_rh_central on DG (+)       est    rh_regional on REG-EST (+)     ouest  lecture on REG-OUEST (+)
 *   acces  admin_acces on REG-EST (+)       beta   admin_rh_central of the OTHER company (BETA)
 * Targets:
 *   est    a resource inside REG-EST (unit AG-CNE, or a company-A resource for roles)
 *   ouest  a resource inside REG-OUEST (unit AG-ORAN)
 *   other  a resource of the other company (BETA-RH, BETA's role / grant)
 *   -      no target (collection routes)
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, GRANTS, seedAccessFixture, unitA, unitB, USERS, type AccessFixture, type ActorName } from './support/access-fixture.js';
import { createTestApp } from './support/test-app.js';
import { createTestDatabase, type TestDatabase } from './support/test-database.js';
import { fetchXsrf, type XsrfPair } from './support/xsrf.js';

type Actor = ActorName | 'anon';
type Target = 'est' | 'ouest' | 'other' | '-';
type Row = readonly [actor: Actor, target: Target, status: number];

interface Req {
  path: string;
  body?: object;
}

interface RouteSpec {
  /** Must equal the route-scan's access column (permission code, "public" or "authenticated"). */
  access: string;
  request: (target: Target, n: number, fx: AccessFixture) => Req;
  rows: readonly Row[];
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const unitOf = (t: Target): string => (t === 'est' ? unitA('AG-CNE') : t === 'ouest' ? unitA('AG-ORAN') : unitB('BETA-RH'));
const roleOf = (t: Target, fx: AccessFixture): string => (t === 'other' ? fx.customB : fx.customA);
const grantOf = (t: Target): string => (t === 'est' ? GRANTS.targetCne : t === 'ouest' ? GRANTS.targetOran : GRANTS.betaAdmin);
/** A distinct future date per request (versions and grants must not collide between rows). */
const day = (n: number, plus = 0): string => new Date(Date.UTC(2027, 0, 1 + n * 2 + plus)).toISOString().slice(0, 10);
const NAMES = { fr: 'Rôle test', ar: 'دور تجريبي', en: 'Test role' };
const READERS: readonly Row[] = [
  ['admin', '-', 200],
  ['est', '-', 200],
  ['ouest', '-', 200],
  ['acces', '-', 200],
  ['beta', '-', 200],
];

// prettier-ignore
const MATRIX: Record<string, RouteSpec> = {
  // ── public ─────────────────────────────────────────────────────────────────────────────────────────────
  'GET /api/health': { access: 'public', request: () => ({ path: '/api/health' }), rows: [['anon', '-', 200], ['admin', '-', 200]] },
  'GET /api/auth/csrf': { access: 'public', request: () => ({ path: '/api/auth/csrf' }), rows: [['anon', '-', 204], ['admin', '-', 204]] },
  'POST /api/auth/login': {
    access: 'public',
    request: () => ({ path: '/api/auth/login', body: { email: 'nobody@demo.dz', password: 'not-the-password-123' } }),
    rows: [['anon', '-', 401], ['admin', '-', 401]], // reachable; wrong credentials → invalid-credentials
  },
  'POST /api/auth/refresh': { access: 'public', request: () => ({ path: '/api/auth/refresh' }), rows: [['anon', '-', 401], ['admin', '-', 401]] },
  'POST /api/auth/logout': { access: 'public', request: () => ({ path: '/api/auth/logout' }), rows: [['anon', '-', 204], ['admin', '-', 204]] },
  'POST /api/auth/password/forgot': {
    access: 'public',
    request: () => ({ path: '/api/auth/password/forgot', body: { email: 'nobody@demo.dz' } }),
    rows: [['anon', '-', 202], ['admin', '-', 202]],
  },
  'POST /api/auth/password/setup': {
    access: 'public',
    request: () => ({ path: '/api/auth/password/setup', body: { token: 'x'.repeat(43), password: 'a-long-enough-passphrase' } }),
    rows: [['anon', '-', 410], ['admin', '-', 410]],
  },

  // ── authenticated ──────────────────────────────────────────────────────────────────────────────────────
  'GET /api/me': { access: 'authenticated', request: () => ({ path: '/api/me' }), rows: READERS },

  // ── organization ───────────────────────────────────────────────────────────────────────────────────────
  'GET /api/org/kinds': { access: 'org_unit.read', request: () => ({ path: '/api/org/kinds' }), rows: READERS },
  'GET /api/org/tree': { access: 'org_unit.read', request: () => ({ path: '/api/org/tree' }), rows: READERS },
  'GET /api/org/units': { access: 'org_unit.read', request: () => ({ path: '/api/org/units?q=agence' }), rows: READERS },
  'GET /api/org/units/:id': {
    access: 'org_unit.read',
    request: (t) => ({ path: `/api/org/units/${unitOf(t)}` }),
    rows: [
      ['admin', 'est', 200], ['admin', 'ouest', 200], ['admin', 'other', 404],
      ['est', 'est', 200], ['est', 'ouest', 404], ['est', 'other', 404],
      ['ouest', 'est', 404], ['ouest', 'ouest', 200], ['ouest', 'other', 404],
      ['acces', 'est', 200], ['acces', 'ouest', 404], ['acces', 'other', 404],
      ['beta', 'est', 404], ['beta', 'ouest', 404], ['beta', 'other', 200],
    ],
  },
  'POST /api/org/units': {
    access: 'org_unit.create',
    request: (t, n) => ({ path: '/api/org/units', body: { kind: 'service', code: `MX-${n}`, name: `Service matrice ${n}`, parentId: unitOf(t) } }),
    rows: [
      ['admin', 'est', 201], ['admin', 'ouest', 201], ['admin', 'other', 404],
      ['est', 'est', 403], ['est', 'ouest', 403], // rh_regional has no org_unit.create
      ['ouest', 'ouest', 403], ['ouest', 'est', 403], // lecture writing
      ['acces', 'est', 403],
      ['beta', 'est', 404], ['beta', 'other', 201],
    ],
  },
  'PATCH /api/org/units/:id': {
    access: 'org_unit.update',
    request: (t, n) => ({ path: `/api/org/units/${unitOf(t)}`, body: { name: `Renommée ${n}`, validFrom: day(n) } }),
    rows: [
      ['admin', 'est', 200], ['admin', 'ouest', 200], ['admin', 'other', 404],
      ['est', 'est', 403], ['est', 'ouest', 403],
      ['ouest', 'ouest', 403], ['ouest', 'est', 403],
      ['acces', 'est', 403],
      ['beta', 'est', 404], ['beta', 'other', 200],
    ],
  },
  'GET /api/org/sites': { access: 'site.read', request: () => ({ path: '/api/org/sites' }), rows: READERS },
  'POST /api/org/sites': {
    access: 'site.create',
    request: (_t, n) => ({ path: '/api/org/sites', body: { code: `MX-SITE-${n}`, name: `Site ${n}`, wilaya: 'Alger' } }),
    rows: [['admin', '-', 201], ['est', '-', 403], ['ouest', '-', 403], ['acces', '-', 403], ['beta', '-', 201]],
  },

  // ── access ─────────────────────────────────────────────────────────────────────────────────────────────
  'GET /api/access/permissions': {
    access: 'access.read',
    request: () => ({ path: '/api/access/permissions' }),
    rows: [['admin', '-', 200], ['acces', '-', 200], ['est', '-', 403], ['ouest', '-', 403], ['beta', '-', 200]],
  },
  'GET /api/access/roles': {
    access: 'access.read',
    request: () => ({ path: '/api/access/roles' }),
    rows: [['admin', '-', 200], ['acces', '-', 200], ['est', '-', 403], ['ouest', '-', 403], ['beta', '-', 200]],
  },
  'POST /api/access/roles': {
    access: 'access.manage_roles',
    request: (_t, n) => ({ path: '/api/access/roles', body: { code: `mx_role_${n}`, names: NAMES, permissions: ['org_unit.read'] } }),
    rows: [
      ['admin', '-', 201],
      ['acces', '-', 409], // role-escalation: org_unit.read is held on REG-EST only, not company-wide
      ['est', '-', 403], ['ouest', '-', 403],
      ['beta', '-', 201],
    ],
  },
  'PATCH /api/access/roles/:id': {
    access: 'access.manage_roles',
    request: (t, n, fx) => ({ path: `/api/access/roles/${roleOf(t, fx)}`, body: { names: { ...NAMES, fr: `Rôle ${n}` } } }),
    rows: [
      ['admin', 'est', 200], ['admin', 'other', 404],
      ['acces', 'est', 200], ['acces', 'other', 404],
      ['est', 'est', 403], ['ouest', 'est', 403],
      ['beta', 'est', 404], ['beta', 'other', 200],
    ],
  },
  'GET /api/access/users': {
    access: 'access.read',
    request: () => ({ path: '/api/access/users' }),
    rows: [['admin', '-', 200], ['acces', '-', 200], ['est', '-', 403], ['ouest', '-', 403], ['beta', '-', 200]],
  },
  'GET /api/access/users/:id': {
    access: 'access.read',
    // est: target (grants on AG-CNE and AG-ORAN) · ouest: lecture.ouest (REG-OUEST only) · other: BETA's admin
    request: (t) => ({ path: `/api/access/users/${t === 'est' ? USERS.target.id : t === 'ouest' ? USERS.ouest.id : USERS.beta.id}` }),
    rows: [
      ['admin', 'est', 200], ['admin', 'ouest', 200], ['admin', 'other', 404],
      ['acces', 'est', 200], ['acces', 'ouest', 404], ['acces', 'other', 404],
      ['est', 'est', 403], ['ouest', 'ouest', 403],
      ['beta', 'est', 404], ['beta', 'other', 200],
    ],
  },
  'GET /api/access/grants': {
    access: 'access.read',
    request: () => ({ path: '/api/access/grants' }),
    rows: [['admin', '-', 200], ['acces', '-', 200], ['est', '-', 403], ['ouest', '-', 403], ['beta', '-', 200]],
  },
  'POST /api/access/grants': {
    access: 'access.grant',
    request: (t, n, fx) => ({
      path: '/api/access/grants',
      body: { userId: USERS.newbie.id, roleId: fx.rolesA['admin_acces'], orgUnitId: unitOf(t), includeDescendants: true, validFrom: day(n), validTo: day(n, 1) },
    }),
    rows: [
      ['admin', 'est', 201], ['admin', 'ouest', 201], ['admin', 'other', 409], // other company's unit: grant-out-of-scope
      ['acces', 'est', 201], ['acces', 'ouest', 409], ['acces', 'other', 409],
      ['est', 'est', 403], ['ouest', 'ouest', 403],
      ['beta', 'est', 422], // company A's role does not exist in BETA (roleId not_found)
    ],
  },
  'POST /api/access/grants/:id/end': {
    access: 'access.grant',
    request: (t) => ({ path: `/api/access/grants/${grantOf(t)}/end`, body: { validTo: '2030-01-01' } }),
    rows: [
      ['admin', 'est', 200], ['admin', 'ouest', 200], ['admin', 'other', 404],
      ['acces', 'est', 200], ['acces', 'ouest', 404], ['acces', 'other', 404],
      ['est', 'est', 403], ['ouest', 'ouest', 403],
      ['beta', 'est', 404], ['beta', 'other', 409], // BETA's own grant: grant-self
    ],
  },

  // ── audit ──────────────────────────────────────────────────────────────────────────────────────────────
  'GET /api/audit/timeline': {
    access: 'audit.read',
    request: (t) => ({ path: `/api/audit/timeline?subject=org_unit:${unitOf(t)}` }),
    rows: [
      ['admin', 'est', 200], ['admin', 'ouest', 200], ['admin', 'other', 404],
      ['acces', 'est', 200], ['acces', 'ouest', 404], ['acces', 'other', 404], // admin_acces holds audit.read on REG-EST only
      ['est', 'est', 403], ['ouest', 'ouest', 403], // rh_regional and lecture have no audit.read
      ['beta', 'est', 404], ['beta', 'other', 200],
    ],
  },
};

interface ScannedRoute {
  method: string;
  path: string;
  access: string;
}

function scanRoutes(): ScannedRoute[] {
  const result = spawnSync(process.execPath, ['tools/guardrails/route-scan/route-scan.ts', '--json'], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`route-scan failed:\n${result.stderr}`);
  return (JSON.parse(result.stdout) as { routes: ScannedRoute[] }).routes;
}

const scanned = scanRoutes();

describe('Authorization matrix (e2e, real grants)', () => {
  let db: TestDatabase;
  let app: NestExpressApplication;
  let fx: AccessFixture;
  let xsrf: XsrfPair;
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    fx = await seedAccessFixture(db);
    app = await createTestApp(db, { devAuth: true, devPermissions: false });
    xsrf = await fetchXsrf(app);
  });
  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  it('covers every route of the route-scan exactly (a new or changed route without a matrix entry fails here)', () => {
    const scannedKeys = scanned.map((r) => `${r.method} ${r.path}`).toSorted();
    expect(Object.keys(MATRIX).toSorted()).toEqual(scannedKeys);
    for (const route of scanned) {
      expect(MATRIX[`${route.method} ${route.path}`]?.access, `${route.method} ${route.path}`).toBe(route.access);
    }
  });

  const cases = Object.entries(MATRIX).flatMap(([key, spec]) => {
    const derived: Row[] = spec.access === 'public' ? [] : [['anon', spec.rows[0]?.[1] ?? '-', 401]];
    return [...derived, ...spec.rows].map((row) => ({ key, spec, row }));
  });

  it.each(cases.map((c) => [`${c.key} — ${c.row[0]} → ${c.row[1]} ⇒ ${c.row[2]}`, c] as const))('%s', async (_name, { key, spec, row }) => {
    const [actor, target, status] = row;
    const [method = ''] = key.split(' ');
    const req = spec.request(target, ++counter, fx);
    const client = as(app, actor === 'anon' ? null : actor, xsrf);
    const call = method === 'GET' ? client.get(req.path) : method === 'POST' ? client.post(req.path) : client.patch(req.path);
    const res = req.body ? await call.send(req.body) : await call;
    expect(res.status, `${key} as ${actor} on ${target}: ${JSON.stringify(res.body)}`).toBe(status);
  });

  it('every protected route is exercised by admin_rh_central, rh_regional and lecture', () => {
    for (const [key, spec] of Object.entries(MATRIX)) {
      if (spec.access === 'public') continue;
      const actors = new Set(spec.rows.map(([actor]) => actor));
      for (const actor of ['admin', 'est', 'ouest'] as const) expect(actors.has(actor), `${key} has no ${actor} row`).toBe(true);
    }
  });
});
