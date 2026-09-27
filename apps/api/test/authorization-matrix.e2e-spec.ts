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
 *   agent  employe, linked to EMP-0030 (Agence Annaba)  chef  employe, head of Agence Annaba (leave demo seed)
 *   (est = rh.est is linked to EMP-0022 and also holds employe; admin and beta hold leave.request_self but are not linked)
 * Targets:
 *   est    a resource inside REG-EST (unit AG-CNE, employee EMP-0027 of AG-CNE, or a company-A resource for roles)
 *   ouest  a resource inside REG-OUEST (unit AG-ORAN, employee EMP-0036 of AG-ORAN)
 *   other  a resource of the other company (BETA-RH, BETA's role / grant / employee)
 *   -      no target (collection routes)
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, companyOf, EMPLOYEE_B, employeeA, GRANTS, seedAccessFixture, unitA, unitB, USERS, type AccessFixture, type ActorName } from './support/access-fixture.js';
import { LeaveClock } from '../src/modules/leave/index.js';
import { StaffingClock } from '../src/modules/staffing/index.js';
import { createTestApp } from './support/test-app.js';
import { createTestDatabase, query, type TestDatabase } from './support/test-database.js';
import { openSse } from './support/sse.js';
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
  /** Server-Sent Events: the row checks the status (and the text/event-stream content type on 200), then disconnects. */
  stream?: boolean;
  /** @AllowWithoutMfa() (must equal the route-scan's allowWithoutMfa): reachable before a required factor is enrolled. */
  noMfa?: true;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const unitOf = (t: Target): string => (t === 'est' ? unitA('AG-CNE') : t === 'ouest' ? unitA('AG-ORAN') : unitB('BETA-RH'));
const roleOf = (t: Target, fx: AccessFixture): string => (t === 'other' ? fx.customB : fx.customA);
/** Employees (seeded demo data): EMP-0027 (Agence Constantine), EMP-0036 (Agence Oran), BETA's employee. */
const employeeOf = (t: Target): string => (t === 'est' ? employeeA(27) : t === 'ouest' ? employeeA(36) : EMPLOYEE_B.employmentId);
/** Ending is final: each successful end gets its own employee (Est: EMP-0030…0032 of Annaba / Clientèle; Ouest: EMP-0037, 0038). */
const endPools: Record<Target, string[]> = {
  est: [employeeA(30), employeeA(31), employeeA(32)],
  ouest: [employeeA(37), employeeA(38)],
  other: [EMPLOYEE_B.employmentId],
  '-': [],
};
const endTargetOf = (t: Target): string => (endPools[t].length > 1 ? (endPools[t].shift() ?? '') : (endPools[t][0] ?? ''));
const newUnitOf = (t: Target): string => (t === 'est' ? unitA('AG-ANNABA') : t === 'ouest' ? unitA('AG-TLEMCEN') : unitB('BETA-RH'));
const EMPLOYEE_WRITE_ROWS: readonly Row[] = [
  ['admin', 'est', 200], ['admin', 'ouest', 200], ['admin', 'other', 404],
  ['est', 'est', 200], ['est', 'ouest', 404], ['est', 'other', 404],
  ['ouest', 'ouest', 403], ['ouest', 'est', 403], // lecture has no employee.update
  ['acces', 'est', 403],
  ['beta', 'est', 404], ['beta', 'other', 200],
];
/** Sensitive writes: only admin_rh_central holds employee.{salary,bank,nss}.update. */
const SENSITIVE_WRITE_ROWS: readonly Row[] = [
  ['admin', 'est', 200], ['admin', 'ouest', 200], ['admin', 'other', 404],
  ['est', 'est', 403], ['est', 'ouest', 403],
  ['ouest', 'ouest', 403], ['acces', 'est', 403],
  ['beta', 'est', 404], ['beta', 'other', 200],
];
const grantOf = (t: Target): string => (t === 'est' ? GRANTS.targetCne : t === 'ouest' ? GRANTS.targetOran : GRANTS.betaAdmin);
/** A distinct future date per request (versions and grants must not collide between rows). */
const day = (n: number, plus = 0): string => new Date(Date.UTC(2027, 0, 1 + n * 2 + plus)).toISOString().slice(0, 10);
const NAMES = { fr: 'Rôle test', ar: 'دور تجريبي', en: 'Test role' };
/** Leave fixtures (filled in beforeAll): type ids, a holiday of each kind, requests and open tasks. */
const LV = {
  annual: '', recovery: '', marriage: '', holidayA: '', holidayToDelete: '',
  agentCancel: '', estRequest: '', ouestRequest: '', approveTask: '', rejectTask: '',
  /** a notification of chef.annaba (task.assigned of the manager task above) */
  chefNotification: '',
};
const MISSING = '0190a5d0-0000-7000-8000-00000000dead';
const leaveDay = (n: number) => day(n);
const leaveBody = (n: number, extra: object = {}) => ({ leaveTypeId: LV.annual, startDate: leaveDay(n), endDate: leaveDay(n), ...extra });
const HR_ROWS: readonly Row[] = [
  ['admin', 'est', 200], ['admin', 'ouest', 200], ['admin', 'other', 404],
  ['est', 'est', 200], ['est', 'ouest', 404],
  ['ouest', 'ouest', 403], ['acces', 'est', 403],
  ['beta', 'est', 404], ['beta', 'other', 200],
];
const CONFIG_ROWS = (ok: number): readonly Row[] => [['admin', '-', ok], ['est', '-', 403], ['ouest', '-', 403], ['acces', '-', 403], ['beta', '-', ok]];
const SELF_ROWS = (ok: number): readonly Row[] => [
  ['admin', '-', 409], ['beta', '-', 409], // leave.request_self held, no linked employment: leave-not-linked
  ['est', '-', ok], ['agent', '-', ok], // Karim and agent.annaba are linked
  ['ouest', '-', 403], ['acces', '-', 403],
];

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
  'POST /api/auth/mfa/verify': {
    access: 'public',
    request: () => ({ path: '/api/auth/mfa/verify', body: { code: '123456' } }),
    rows: [['anon', '-', 401], ['admin', '-', 401]], // reachable; no hrf_mfa cookie → mfa-challenge-expired
  },
  'POST /api/auth/password/setup': {
    access: 'public',
    request: () => ({ path: '/api/auth/password/setup', body: { token: 'x'.repeat(43), password: 'a-long-enough-passphrase' } }),
    rows: [['anon', '-', 410], ['admin', '-', 410]],
  },

  // ── authenticated ──────────────────────────────────────────────────────────────────────────────────────
  'GET /api/me': { access: 'authenticated', noMfa: true, request: () => ({ path: '/api/me' }), rows: READERS },

  // ── two-step sign-in: the caller's own factor (a wrong code counts once per actor toward the e-mail lock) ──────
  'GET /api/me/mfa': { access: 'authenticated', noMfa: true, request: () => ({ path: '/api/me/mfa' }), rows: [...READERS, ['agent', '-', 200]] },
  'POST /api/me/mfa/enroll/start': { access: 'authenticated', noMfa: true, request: () => ({ path: '/api/me/mfa/enroll/start' }), rows: READERS },
  'POST /api/me/mfa/enroll/confirm': {
    access: 'authenticated',
    noMfa: true,
    request: () => ({ path: '/api/me/mfa/enroll/confirm', body: { code: '000000' } }),
    rows: READERS.map(([a, t]) => [a, t, 422] as const), // pending secret, wrong code → mfa-invalid
  },
  'POST /api/me/mfa/recovery-codes': {
    access: 'authenticated',
    noMfa: true,
    request: () => ({ path: '/api/me/mfa/recovery-codes', body: { code: '000000' } }),
    rows: READERS.map(([a, t]) => [a, t, 409] as const), // not enabled → mfa-not-enabled
  },
  'POST /api/me/mfa/disable': {
    access: 'authenticated',
    noMfa: true,
    request: () => ({ path: '/api/me/mfa/disable', body: { code: '000000' } }),
    rows: READERS.map(([a, t]) => [a, t, 409] as const), // not required (policy off), not enabled → mfa-not-enabled
  },

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
  'POST /api/access/users/:id/mfa/reset': {
    access: 'access.grant',
    // est: target (grants on AG-CNE, AG-ORAN) · ouest: lecture.ouest (REG-OUEST only) · other: BETA's admin (= beta itself)
    request: (t) => ({ path: `/api/access/users/${t === 'est' ? USERS.target.id : t === 'ouest' ? USERS.ouest.id : USERS.beta.id}/mfa/reset` }),
    rows: [
      ['admin', 'est', 204], ['admin', 'ouest', 204], ['admin', 'other', 404],
      ['acces', 'est', 204], ['acces', 'ouest', 404], ['acces', 'other', 404], // admin_acces: access.grant on REG-EST only
      ['est', 'est', 403], ['ouest', 'ouest', 403],
      ['beta', 'est', 404], ['beta', 'other', 409], // BETA's own account: mfa-reset-self
    ],
  },
  'GET /api/access/security-policy': {
    access: 'access.manage_roles',
    request: () => ({ path: '/api/access/security-policy' }),
    rows: [['admin', '-', 200], ['acces', '-', 200], ['est', '-', 403], ['ouest', '-', 403], ['beta', '-', 200]],
  },
  'PUT /api/access/security-policy': {
    access: 'access.manage_roles',
    // enforcement stays OFF (the other rows run without a second factor)
    request: (_t, n) => ({ path: '/api/access/security-policy', body: { mfaEnforced: false, mfaRequiredPermissions: n % 2 ? ['access.grant'] : ['access.grant', 'employee.salary.read'] } }),
    rows: [
      ['admin', '-', 200],
      ['acces', '-', 403], // access.manage_roles on REG-EST only: the policy covers the whole company → forbidden-scope
      ['est', '-', 403], ['ouest', '-', 403],
      ['beta', '-', 200],
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

  // ── employment ────────────────────────────────────────────────────────────────────────────────────────
  'GET /api/employees': {
    access: 'employee.read',
    request: () => ({ path: '/api/employees?q=a&sort=unit&pageSize=5' }),
    rows: [['admin', '-', 200], ['est', '-', 200], ['ouest', '-', 200], ['acces', '-', 403], ['beta', '-', 200]],
  },
  'GET /api/employees/:id': {
    access: 'employee.read',
    request: (t) => ({ path: `/api/employees/${employeeOf(t)}` }),
    rows: [
      ['admin', 'est', 200], ['admin', 'ouest', 200], ['admin', 'other', 404],
      ['est', 'est', 200], ['est', 'ouest', 404], ['est', 'other', 404],
      ['ouest', 'ouest', 200], ['ouest', 'est', 404], ['ouest', 'other', 404],
      ['acces', 'est', 403],
      ['beta', 'est', 404], ['beta', 'other', 200],
    ],
  },
  'POST /api/employees': {
    access: 'employee.create',
    request: (t, n) => ({
      path: '/api/employees',
      body: { lastName: 'Matrice', firstName: `Test ${n}`, matricule: `MX-${n}`, hireDate: '2026-09-01', orgUnitId: unitOf(t), jobTitle: 'Agent' },
    }),
    rows: [
      ['admin', 'est', 201], ['admin', 'ouest', 201], ['admin', 'other', 422], // another company's unit does not exist here
      ['est', 'est', 201], ['est', 'ouest', 403], // rh_regional creates in REG-EST only (forbidden-scope)
      ['ouest', 'ouest', 403], ['ouest', 'est', 403], // lecture has no employee.create
      ['acces', 'est', 403],
      ['beta', 'est', 422], ['beta', 'other', 201],
    ],
  },
  'PATCH /api/employees/:id/person': {
    access: 'employee.update',
    request: (t, n) => ({ path: `/api/employees/${employeeOf(t)}/person`, body: { birthPlace: `Ville ${n}` } }),
    rows: EMPLOYEE_WRITE_ROWS,
  },
  'POST /api/employees/:id/assignments': {
    access: 'employee.update',
    request: (t, n) => ({ path: `/api/employees/${employeeOf(t)}/assignments`, body: { orgUnitId: newUnitOf(t), jobTitle: `Poste ${n}`, validFrom: day(n) } }),
    rows: EMPLOYEE_WRITE_ROWS,
  },
  'PUT /api/employees/:id/salary': {
    access: 'employee.salary.update',
    request: (t, n) => ({ path: `/api/employees/${employeeOf(t)}/salary`, body: { baseSalary: `${50000 + n}.50`, validFrom: day(n) } }),
    rows: SENSITIVE_WRITE_ROWS,
  },
  'PUT /api/employees/:id/bank': {
    access: 'employee.bank.update',
    request: (t, n) => ({ path: `/api/employees/${employeeOf(t)}/bank`, body: { rib: `0079999900000000${String(n).padStart(4, '0')}`, bankName: 'BNA' } }),
    rows: SENSITIVE_WRITE_ROWS,
  },
  'PUT /api/employees/:id/nss': {
    access: 'employee.nss.update',
    request: (t, n) => ({ path: `/api/employees/${employeeOf(t)}/nss`, body: { nss: `99000000${String(n).padStart(4, '0')}` } }),
    rows: SENSITIVE_WRITE_ROWS,
  },
  // last of the employee routes: a successful end is final (each one takes a fresh employee, see endTargetOf)
  'POST /api/employees/:id/end': {
    access: 'employee.update',
    request: (t) => ({ path: `/api/employees/${endTargetOf(t)}/end`, body: { endDate: '2030-12-31', reason: 'end_of_contract' } }), // after every day(n) of the other rows
    rows: EMPLOYEE_WRITE_ROWS,
  },

  // ── staffing (links, heads) ────────────────────────────────────────────────────────────────────────────
  'GET /api/me/employment': {
    access: 'authenticated',
    request: () => ({ path: '/api/me/employment' }),
    rows: [['admin', '-', 404], ['est', '-', 200], ['ouest', '-', 404], ['acces', '-', 404], ['beta', '-', 404], ['agent', '-', 200]],
  },
  'PUT /api/access/users/:id/employment': {
    access: 'access.grant',
    request: (t) => ({ path: `/api/access/users/${USERS.newbie.id}/employment`, body: { employmentId: employeeOf(t) } }),
    rows: [
      ['admin', 'est', 200],
      ['acces', 'est', 200], // same link: no change
      ['acces', 'ouest', 422], // EMP-0036 is outside admin_acces's REG-EST scope: employmentId not_found
      ['admin', 'ouest', 200], ['admin', 'other', 422],
      ['est', 'est', 403], ['ouest', 'ouest', 403],
      ['beta', 'est', 404], // newbie is not a member of BETA
    ],
  },
  'PUT /api/org/units/:id/head': {
    access: 'org_unit.update',
    request: (t, n) => ({ path: `/api/org/units/${unitOf(t)}/head`, body: { employmentId: employeeOf(t), validFrom: day(n) } }),
    rows: [
      ['admin', 'est', 200], ['admin', 'ouest', 200], ['admin', 'other', 404],
      ['est', 'est', 403], ['est', 'ouest', 403],
      ['ouest', 'ouest', 403], ['acces', 'est', 403],
      ['beta', 'est', 404], ['beta', 'other', 200],
    ],
  },

  // ── leave: self-service ────────────────────────────────────────────────────────────────────────────────
  'GET /api/me/leave/balances': { access: 'leave.request_self', request: () => ({ path: '/api/me/leave/balances' }), rows: SELF_ROWS(200) },
  'GET /api/me/leave/requests': { access: 'leave.request_self', request: () => ({ path: '/api/me/leave/requests' }), rows: SELF_ROWS(200) },
  'POST /api/me/leave/requests': { access: 'leave.request_self', request: (_t, n) => ({ path: '/api/me/leave/requests', body: leaveBody(n) }), rows: SELF_ROWS(201) },
  'POST /api/me/leave/requests/:id/cancel': {
    access: 'leave.request_self',
    request: () => ({ path: `/api/me/leave/requests/${LV.agentCancel}/cancel` }),
    rows: [
      ['est', 'est', 404], ['chef', 'est', 404], // someone else's request
      ['admin', 'est', 409], ['beta', 'est', 409], // not linked
      ['ouest', 'est', 403], ['acces', 'est', 403],
      ['agent', 'est', 200], // own pending request
    ],
  },

  // ── leave: reference data, configuration ───────────────────────────────────────────────────────────────
  'POST /api/leave/preview': {
    access: 'authenticated',
    // target: whose leave (est: EMP-0027, ouest: EMP-0036, other: BETA's employee, -: the caller's own)
    request: (t, n) => ({ path: '/api/leave/preview', body: t === '-' ? leaveBody(n) : leaveBody(n, { employmentId: employeeOf(t) }) }),
    rows: [
      ['admin', 'est', 200], ['admin', 'ouest', 200], ['admin', 'other', 404], ['admin', '-', 409],
      ['est', 'est', 200], ['est', 'ouest', 404], ['est', '-', 200],
      ['ouest', 'ouest', 404], ['ouest', '-', 403],
      ['acces', 'est', 404],
      ['beta', 'est', 404], ['beta', 'other', 422], // company A's leave type does not exist in BETA
      ['agent', '-', 200], ['agent', 'est', 404],
    ],
  },
  'GET /api/leave/types': { access: 'authenticated', request: () => ({ path: '/api/leave/types' }), rows: READERS },
  'GET /api/leave/holidays': { access: 'authenticated', request: () => ({ path: '/api/leave/holidays?year=2026' }), rows: READERS },
  'GET /api/leave/policy': { access: 'authenticated', request: () => ({ path: '/api/leave/policy' }), rows: READERS },
  'PUT /api/leave/types/:id': {
    access: 'leave.configure',
    request: () => ({ path: `/api/leave/types/${LV.marriage}`, body: { maxDaysPerRequest: 3 } }),
    rows: [['admin', 'est', 200], ['est', 'est', 403], ['ouest', 'est', 403], ['acces', 'est', 403], ['beta', 'est', 404]],
  },
  'POST /api/leave/holidays': {
    access: 'leave.configure',
    request: (_t, n) => ({
      path: '/api/leave/holidays',
      body: { date: new Date(Date.UTC(2031, 0, 1 + n)).toISOString().slice(0, 10), labels: { fr: `Férié ${n}`, ar: 'عطلة', en: `Holiday ${n}` } },
    }),
    rows: CONFIG_ROWS(201),
  },
  'PUT /api/leave/holidays/:id': {
    access: 'leave.configure',
    request: () => ({ path: `/api/leave/holidays/${LV.holidayA}`, body: { date: '2026-11-01', labels: { fr: 'Fête de la Révolution (1954)', ar: 'عيد الثورة', en: 'Revolution Day' } } }),
    rows: [['admin', 'est', 200], ['est', 'est', 403], ['ouest', 'est', 403], ['acces', 'est', 403], ['beta', 'est', 404]],
  },
  'DELETE /api/leave/holidays/:id': {
    access: 'leave.configure',
    request: () => ({ path: `/api/leave/holidays/${LV.holidayToDelete}` }),
    rows: [['est', 'est', 403], ['ouest', 'est', 403], ['acces', 'est', 403], ['beta', 'est', 404], ['admin', 'est', 204]],
  },
  'PUT /api/leave/policy': {
    access: 'leave.configure',
    request: () => ({ path: '/api/leave/policy', body: { referenceStartMonth: 7, weekendDays: [5, 6] } }),
    rows: CONFIG_ROWS(200),
  },
  'GET /api/leave/workflows': { access: 'leave.configure', request: () => ({ path: '/api/leave/workflows' }), rows: CONFIG_ROWS(200) },

  // ── leave: HR ──────────────────────────────────────────────────────────────────────────────────────────
  'GET /api/leave/requests': {
    access: 'leave.read',
    request: () => ({ path: '/api/leave/requests?status=all' }),
    rows: [['admin', '-', 200], ['est', '-', 200], ['ouest', '-', 403], ['acces', '-', 403], ['beta', '-', 200], ['agent', '-', 403]],
  },
  'GET /api/leave/requests/:id': {
    access: 'authenticated',
    request: (t) => ({ path: `/api/leave/requests/${t === 'ouest' ? LV.ouestRequest : t === 'other' ? MISSING : LV.estRequest}` }),
    rows: [
      ['admin', 'est', 200], ['admin', 'ouest', 200], ['admin', 'other', 404],
      ['est', 'est', 200], ['est', 'ouest', 404],
      ['ouest', 'ouest', 404], ['ouest', 'est', 404], // lecture has no leave.read
      ['acces', 'est', 404], ['beta', 'est', 404], ['agent', 'est', 404],
    ],
  },
  'POST /api/employees/:id/leave/requests': {
    access: 'leave.request',
    request: (t, n) => ({ path: `/api/employees/${employeeOf(t)}/leave/requests`, body: leaveBody(n) }),
    rows: [
      ['admin', 'est', 201], ['admin', 'ouest', 201], ['admin', 'other', 404],
      ['est', 'est', 201], ['est', 'ouest', 404],
      ['ouest', 'ouest', 403], ['acces', 'est', 403],
      ['beta', 'est', 404], ['beta', 'other', 422], // company A's leave type does not exist in BETA
    ],
  },
  'GET /api/employees/:id/leave/balances': { access: 'leave.read', request: (t) => ({ path: `/api/employees/${employeeOf(t)}/leave/balances` }), rows: HR_ROWS },
  'GET /api/employees/:id/leave/ledger': { access: 'leave.read', request: (t) => ({ path: `/api/employees/${employeeOf(t)}/leave/ledger` }), rows: HR_ROWS },
  'POST /api/employees/:id/leave/adjustments': {
    access: 'leave.adjust',
    request: (t) => ({ path: `/api/employees/${employeeOf(t)}/leave/adjustments`, body: { leaveTypeId: LV.recovery, periodStart: '2026-07-01', days: 1, note: 'Matrice' } }),
    rows: [
      ['admin', 'est', 201], ['admin', 'ouest', 201], ['admin', 'other', 404],
      ['est', 'est', 201], ['est', 'ouest', 404],
      ['ouest', 'ouest', 403], ['acces', 'est', 403],
      ['beta', 'est', 404], ['beta', 'other', 422],
    ],
  },
  'POST /api/leave/accruals/run': {
    access: 'leave.adjust',
    request: () => ({ path: '/api/leave/accruals/run', body: { month: '2025-06' } }),
    rows: [['admin', '-', 200], ['est', '-', 200], ['ouest', '-', 403], ['acces', '-', 403], ['beta', '-', 200]],
  },

  // ── workflow: My tasks ─────────────────────────────────────────────────────────────────────────────────
  'GET /api/tasks': { access: 'authenticated', request: () => ({ path: '/api/tasks?status=open' }), rows: [...READERS, ['agent', '-', 200], ['chef', '-', 200]] },
  'POST /api/tasks/:id/approve': {
    access: 'authenticated',
    // the manager task of an agent.annaba request: only chef.annaba is a candidate
    request: () => ({ path: `/api/tasks/${LV.approveTask}/approve`, body: {} }),
    rows: [['admin', 'est', 404], ['est', 'est', 404], ['ouest', 'est', 404], ['acces', 'est', 404], ['beta', 'est', 404], ['agent', 'est', 404], ['chef', 'est', 200]],
  },
  'POST /api/tasks/:id/reject': {
    access: 'authenticated',
    request: () => ({ path: `/api/tasks/${LV.rejectTask}/reject`, body: { comment: 'Période chargée' } }),
    rows: [['admin', 'est', 404], ['est', 'est', 404], ['ouest', 'est', 404], ['acces', 'est', 404], ['beta', 'est', 404], ['agent', 'est', 404], ['chef', 'est', 200]],
  },

  // ── notifications (own rows only: someone else's id is a 404) ──────────────────────────────────────────
  'GET /api/me/notifications': { access: 'authenticated', request: () => ({ path: '/api/me/notifications?unreadOnly=true&limit=5' }), rows: [...READERS, ['agent', '-', 200], ['chef', '-', 200]] },
  'GET /api/me/notifications/unread-count': { access: 'authenticated', noMfa: true, request: () => ({ path: '/api/me/notifications/unread-count' }), rows: [...READERS, ['chef', '-', 200]] },
  'GET /api/me/notifications/stream': {
    access: 'authenticated',
    stream: true,
    request: () => ({ path: '/api/me/notifications/stream' }),
    rows: [...READERS, ['agent', '-', 200], ['chef', '-', 200]],
  },
  'POST /api/me/notifications/:id/read': {
    access: 'authenticated',
    request: () => ({ path: `/api/me/notifications/${LV.chefNotification}/read` }),
    rows: [['admin', 'est', 404], ['est', 'est', 404], ['ouest', 'est', 404], ['acces', 'est', 404], ['beta', 'est', 404], ['agent', 'est', 404], ['chef', 'est', 204]],
  },
  'POST /api/me/notifications/read-all': { access: 'authenticated', request: () => ({ path: '/api/me/notifications/read-all' }), rows: [...READERS.map(([a, t]) => [a, t, 204] as const), ['agent', '-', 204]] },
  'GET /api/me/notification-preferences': { access: 'authenticated', request: () => ({ path: '/api/me/notification-preferences' }), rows: [...READERS, ['agent', '-', 200]] },
  'PUT /api/me/notification-preferences': {
    access: 'authenticated',
    request: (_t, n) => ({ path: '/api/me/notification-preferences', body: [{ type: 'task.assigned', email: n % 2 === 0 }] }),
    rows: [...READERS, ['agent', '-', 200], ['chef', '-', 200]],
  },

  // ── audit ──────────────────────────────────────────────────────────────────────────────────────────────
  'GET /api/audit/timeline': {
    // @Authenticated: audit.read is checked by the handler for every subject type except leave_request (own visibility)
    access: 'authenticated',
    request: (t) => ({ path: `/api/audit/timeline?subject=org_unit:${unitOf(t)}` }),
    rows: [
      ['admin', 'est', 200], ['admin', 'ouest', 200], ['admin', 'other', 404],
      ['acces', 'est', 200], ['acces', 'ouest', 404], ['acces', 'other', 404], // admin_acces holds audit.read on REG-EST only
      ['est', 'est', 403], ['ouest', 'ouest', 403], // rh_regional and lecture have no audit.read
      ['beta', 'est', 404], ['beta', 'other', 200],
      ['agent', 'est', 403],
    ],
  },
};

interface ScannedRoute {
  method: string;
  path: string;
  access: string;
  allowWithoutMfa: boolean;
}

function scanRoutes(): ScannedRoute[] {
  const result = spawnSync(process.execPath, ['tools/guardrails/route-scan/route-scan.ts', '--json'], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`route-scan failed:\n${result.stderr}`);
  return (JSON.parse(result.stdout) as { routes: ScannedRoute[] }).routes;
}

const scanned = scanRoutes();
const unitCompany = '0190a5d0-0000-7000-8000-000000000001';

describe('Authorization matrix (e2e, real grants)', () => {
  let db: TestDatabase;
  let app: NestExpressApplication;
  let fx: AccessFixture;
  let xsrf: XsrfPair;
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    fx = await seedAccessFixture(db, undefined, { leave: true });
    const pinned = { today: () => '2026-09-26' };
    app = await createTestApp(db, {
      devAuth: true,
      devPermissions: false,
      overrides: [
        { provide: LeaveClock, useValue: pinned },
        { provide: StaffingClock, useValue: pinned },
      ],
    });
    xsrf = await fetchXsrf(app);
    const types = await query<{ id: string; code: string }>(db.superuserUrl, 'select id, code from leave_type where company_id = $1', [unitCompany]);
    const typeId = (code: string) => types.find((t) => t.code === code)?.id ?? '';
    Object.assign(LV, { annual: typeId('annual'), recovery: typeId('recovery'), marriage: typeId('marriage') });
    LV.holidayA = (await query<{ id: string }>(db.superuserUrl, `select id from public_holiday where company_id = $1 and date = '2026-11-01'`, [unitCompany]))[0]?.id ?? '';
    LV.holidayToDelete = (await query<{ id: string }>(db.superuserUrl, `select id from public_holiday where company_id = $1 and date = '2027-08-15'`, [unitCompany]))[0]?.id ?? '';
    const agent = as(app, 'agent', xsrf);
    const create = async (start: string) => ((await agent.post('/api/me/leave/requests').send({ leaveTypeId: LV.annual, startDate: start, endDate: start })).body as { id: string }).id;
    const managerTask = async (requestId: string) => {
      const tasks = (await as(app, 'chef', xsrf).get('/api/tasks')).body as { items: { id: string; subject: { id: string } }[] };
      return tasks.items.find((t) => t.subject.id === requestId)?.id ?? '';
    };
    LV.approveTask = await managerTask(await create('2030-06-01'));
    LV.rejectTask = await managerTask(await create('2030-06-03'));
    LV.agentCancel = await create('2030-06-05');
    const onBehalf = async (employee: string) =>
      ((await as(app, 'admin', xsrf).post(`/api/employees/${employee}/leave/requests`).send({ leaveTypeId: LV.annual, startDate: '2030-07-01', endDate: '2030-07-01' })).body as { id: string }).id;
    LV.estRequest = await onBehalf(employeeA(27));
    LV.ouestRequest = await onBehalf(employeeA(36));
    LV.chefNotification =
      (await query<{ id: string }>(db.superuserUrl, `select id from notification where user_id = $1 and type = 'task.assigned' and subject_id = $2`, [USERS.chef.id, LV.approveTask]))[0]
        ?.id ?? '';
    expect(Object.values(LV).every((v) => v !== ''), JSON.stringify(LV)).toBe(true);
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
      expect(MATRIX[`${route.method} ${route.path}`]?.noMfa === true, `${route.method} ${route.path} @AllowWithoutMfa`).toBe(route.allowWithoutMfa);
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
    if (spec.stream) {
      const headers: Record<string, string> = actor === 'anon' ? {} : { 'X-Dev-User-Id': USERS[actor].id, 'X-Dev-Company-Id': companyOf(actor) };
      const sse = await openSse(app, req.path, headers);
      try {
        expect(sse.status, `${key} as ${actor}: ${sse.raw()}`).toBe(status);
        if (status === 200) {
          expect(sse.headers['content-type']).toMatch(/^text\/event-stream/);
          await sse.next((e) => e.event === 'unread');
        } else {
          await sse.ended;
          expect(sse.headers['content-type']).toMatch(/^application\/problem\+json/);
        }
      } finally {
        sse.close();
      }
      return;
    }
    const client = as(app, actor === 'anon' ? null : actor, xsrf);
    const call =
      method === 'GET'
        ? client.get(req.path)
        : method === 'POST'
          ? client.post(req.path)
          : method === 'PUT'
            ? client.put(req.path)
            : method === 'DELETE'
              ? client.delete(req.path)
              : client.patch(req.path);
    const res = req.body ? await call.send(req.body) : await call;
    expect(res.status, `${key} as ${actor} on ${target}: ${JSON.stringify(res.body)}`).toBe(status);
  });

  it('two-step sign-in enforcement: with the DEMO policy enforced, a required user without a factor gets 403 mfa-enrollment-required on every non-public route except the @AllowWithoutMfa ones', async () => {
    await query(db.superuserUrl, `update security_policy set mfa_enforced = true, mfa_required_permissions = '{access.grant}' where company_id = $1`, [unitCompany]);
    try {
      for (const [key, spec] of Object.entries(MATRIX)) {
        if (spec.access === 'public' || spec.stream) continue;
        const [method = ''] = key.split(' ');
        const req = spec.request(spec.rows[0]?.[1] ?? '-', ++counter, fx);
        const client = as(app, 'admin', xsrf);
        const call =
          method === 'GET' ? client.get(req.path) : method === 'POST' ? client.post(req.path) : method === 'PUT' ? client.put(req.path) : method === 'DELETE' ? client.delete(req.path) : client.patch(req.path);
        const res = req.body ? await call.send(req.body) : await call;
        if (spec.noMfa) expect((res.body as { type?: string }).type, key).not.toBe('urn:hrforce:problem:mfa-enrollment-required');
        else expect([res.status, (res.body as { type?: string }).type], key).toEqual([403, 'urn:hrforce:problem:mfa-enrollment-required']);
      }
      // the SSE stream too; and someone the policy does not cover (lecture: no access.grant) is unaffected
      const sse = await openSse(app, '/api/me/notifications/stream', { 'X-Dev-User-Id': USERS.admin.id, 'X-Dev-Company-Id': unitCompany });
      expect(sse.status).toBe(403);
      sse.close();
      await as(app, 'ouest', xsrf).get('/api/org/tree').expect(200);
    } finally {
      await query(db.superuserUrl, `update security_policy set mfa_enforced = false where company_id = $1`, [unitCompany]);
    }
  });

  it('every protected route is exercised by admin_rh_central, rh_regional and lecture', () => {
    for (const [key, spec] of Object.entries(MATRIX)) {
      if (spec.access === 'public') continue;
      const actors = new Set(spec.rows.map(([actor]) => actor));
      for (const actor of ['admin', 'est', 'ouest'] as const) expect(actors.has(actor), `${key} has no ${actor} row`).toBe(true);
    }
  });
});
