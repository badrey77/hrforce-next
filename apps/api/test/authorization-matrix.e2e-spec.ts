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
import { as, BETA_SIGNATORY, COMPANY_B, companyOf, EMPLOYEE_B, employeeA, GRANTS, seedAccessFixture, unitA, unitB, USERS, type AccessFixture, type ActorName } from './support/access-fixture.js';
import { DEMO_SIGNATORIES, demoLogoPng, demoPdf, DocumentsClock } from '../src/modules/documents/index.js';
import { LeaveClock } from '../src/modules/leave/index.js';
import { DEMO_KIOSKS, DEMO_PAIRING_CODE, DEMO_SCHEDULES, weekOf, windowOf } from '../src/modules/attendance/index.js';
import { BETA_KIOSK, kioskCookie, qrToken, scanReceipt } from './support/attendance-fixture.js';
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
  /** multipart upload of `file` (PUT /documents/settings/profile/logo, POST /employees/:id/files) */
  upload?: Buffer;
  /** multipart text fields sent with `upload` */
  fields?: Record<string, string>;
  /** the upload's file name (default logo.png) */
  filename?: string;
  /** extra cookies (kiosk credential, scan receipt), sent with the XSRF cookie on unsafe methods */
  cookie?: string;
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
/** Documents fixtures (filled in beforeAll): one issued document per target, own documents, a pending request, type ids. */
const DOC = { est: '', ouest: '', other: '', agentOwn: '', karimOwn: '', agentRequest: '', typeA: '', typeB: '' };
const docOf = (t: Target): string => (t === 'est' ? DOC.est : t === 'ouest' ? DOC.ouest : DOC.other);
const issueBody = (t: Target) => ({ typeCode: 'attestation_travail', employmentId: employeeOf(t), language: 'fr' });
const PROFILE_BODY = { legalNameFr: 'Société test', legalNameAr: null, addressFr: '1 rue X, Alger', addressAr: null, cityFr: 'Alger', cityAr: null };
/** HR issuing (document.issue): admin everywhere, rh_regional in REG-EST; lecture / admin_acces / employees none. */
const DOC_ISSUE_ROWS = (ok: number): readonly Row[] => [
  ['admin', 'est', ok], ['admin', 'ouest', ok], ['admin', 'other', 404],
  ['est', 'est', ok], ['est', 'ouest', 404],
  ['ouest', 'ouest', 403], ['acces', 'est', 403],
  ['beta', 'est', 404], ['beta', 'other', ok],
  ['agent', 'est', 403],
];
const DOC_READ_ROWS: readonly Row[] = [
  ['admin', 'est', 200], ['admin', 'ouest', 200], ['admin', 'other', 404],
  ['est', 'est', 200], ['est', 'ouest', 404],
  ['ouest', 'ouest', 403], ['acces', 'est', 403],
  ['beta', 'est', 404], ['beta', 'other', 200],
  ['agent', 'est', 403],
];
/** document.configure writes on the caller's own company: est = company A's row, other = BETA's. */
const DOC_CONFIG_ROWS = (ok: number): readonly Row[] => [
  ['admin', 'est', ok], ['est', 'est', 403], ['ouest', 'est', 403], ['acces', 'est', 403],
  ['beta', 'other', ok], ['beta', 'est', 404],
];
/** Employee files (filled in beforeAll): one file per target to read, one per target to delete, the categories. */
const FILE = { est: '', ouest: '', other: '', delEst: '', delOuest: '', delOther: '', catA: '', catB: '', diplomaA: '', diplomaB: '' };
const fileOf = (t: Target): string => (t === 'est' ? FILE.est : t === 'ouest' ? FILE.ouest : FILE.other);
const delFileOf = (t: Target): string => (t === 'est' ? FILE.delEst : t === 'ouest' ? FILE.delOuest : FILE.delOther);
const fileUpload = (t: Target, n: number): Req => ({
  path: `/api/employees/${employeeOf(t)}/files`,
  upload: demoPdf(`TEST DATA - matrix upload ${n}`),
  filename: `piece-${n}.pdf`,
  fields: { categoryId: t === 'other' ? FILE.diplomaB : FILE.diplomaA, title: `Pièce ${n}` },
});
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

// ── attendance (docs/contracts/attendance.md › Authorization matrix rows) ──────────────────────────────────────────
const DEMO_SITE_ALG_CTR = '0190a5d0-0000-7000-8000-000000000202';
const BETA_SITE = '0190a5d0-0000-7000-8000-000000000b21';
const ATT_WEEK = weekOf('08:00', '16:30', '12:00', '12:30');
/** Filled in beforeAll: BETA's schedule / override / assignment, and pools of targets each used once. */
const ATT = {
  betaSchedule: '',
  betaOverride: '',
  betaAssignment: '',
  voids: { est: [] as string[], ouest: [] as string[], other: [] as string[], '-': [] as string[] },
  overrides: { est: [] as string[], ouest: [] as string[], other: [] as string[], '-': [] as string[] },
  assignments: { est: [] as string[], ouest: [] as string[], other: [] as string[], '-': [] as string[] },
  kiosks: { est: [] as string[], ouest: [] as string[], other: [] as string[], '-': [] as string[] },
};
/** Each call takes the next target of the pool (a success changes it for good: void, delete, revoke). */
const next = (pool: string[]): string => pool.shift() ?? 'pool-exhausted';
const attDay = (n: number, plus = 0) => new Date(Date.UTC(2031, 0, 1 + n * 2 + plus)).toISOString().slice(0, 10);
const ATT_READ_ROWS: readonly Row[] = [
  ['admin', 'est', 200], ['admin', 'ouest', 200], ['admin', 'other', 404],
  ['est', 'est', 200], ['est', 'ouest', 404],
  ['ouest', 'ouest', 200], ['ouest', 'est', 404],
  ['acces', 'est', 403],
  ['beta', 'est', 404], ['beta', 'other', 200],
  ['agent', 'est', 403],
];
const ATT_MANAGE_ROWS = (ok: number): readonly Row[] => [
  ['admin', 'est', ok], ['admin', 'ouest', ok], ['admin', 'other', 404],
  ['est', 'est', ok], ['est', 'ouest', 404],
  ['ouest', 'ouest', 403], ['acces', 'est', 403],
  ['beta', 'est', 404], ['beta', 'other', ok],
  ['agent', 'est', 403],
];
const ATT_SETTINGS_READ: readonly Row[] = [['admin', '-', 200], ['est', '-', 200], ['ouest', '-', 200], ['acces', '-', 403], ['beta', '-', 200], ['agent', '-', 403]];
/** attendance.configure on a resource of the caller's own company (est = company A's, other = BETA's). */
const ATT_CONFIG_ROWS = (ok: number): readonly Row[] => [
  ['admin', 'est', ok], ['est', 'est', 403], ['ouest', 'est', 403], ['acces', 'est', 403],
  ['beta', 'other', ok], ['beta', 'est', 404],
];
/** A creation whose body names a company resource (site, schedule): BETA naming company A's → 422 not_found. */
const ATT_CREATE_ROWS = (ok: number): readonly Row[] => [
  ['admin', 'est', ok], ['est', 'est', 403], ['ouest', 'est', 403], ['acces', 'est', 403],
  ['beta', 'other', ok], ['beta', 'est', 422],
];
const ATT_SELF_ROWS = (ok: number): readonly Row[] => [
  ['agent', '-', ok], ['est', '-', ok], ['chef', '-', ok],
  ['admin', '-', 409], ['beta', '-', 409], // attendance.punch_self held, no linked employment: attendance-not-linked
  ['ouest', '-', 403], ['acces', '-', 403],
];
const scheduleOf = (t: Target) => (t === 'other' ? ATT.betaSchedule : DEMO_SCHEDULES.agence);
const kioskOf = (t: Target) => (t === 'other' ? BETA_KIOSK : DEMO_KIOSKS.cne.id);

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

  // ── documents (docs/contracts/documents.md › Authorization matrix rows) ──────────────────────────────────
  'GET /api/documents/types': { access: 'authenticated', request: () => ({ path: '/api/documents/types' }), rows: [...READERS, ['agent', '-', 200], ['chef', '-', 200]] },
  'PUT /api/documents/types/:id': {
    access: 'document.configure',
    request: (t) => ({ path: `/api/documents/types/${t === 'other' ? DOC.typeB : DOC.typeA}`, body: { active: true } }),
    rows: DOC_CONFIG_ROWS(200),
  },
  'GET /api/documents/settings/profile': { access: 'document.configure', request: () => ({ path: '/api/documents/settings/profile' }), rows: CONFIG_ROWS(200) },
  'PUT /api/documents/settings/profile': { access: 'document.configure', request: () => ({ path: '/api/documents/settings/profile', body: PROFILE_BODY }), rows: CONFIG_ROWS(200) },
  'PUT /api/documents/settings/profile/logo': {
    access: 'document.configure',
    request: () => ({ path: '/api/documents/settings/profile/logo', upload: demoLogoPng() }),
    rows: CONFIG_ROWS(200),
  },
  'GET /api/documents/settings/profile/logo': { access: 'document.configure', request: () => ({ path: '/api/documents/settings/profile/logo' }), rows: CONFIG_ROWS(200) },
  'DELETE /api/documents/settings/profile/logo': { access: 'document.configure', request: () => ({ path: '/api/documents/settings/profile/logo' }), rows: CONFIG_ROWS(204) },
  'GET /api/documents/settings/signatories': { access: 'document.configure', request: () => ({ path: '/api/documents/settings/signatories' }), rows: CONFIG_ROWS(200) },
  'POST /api/documents/settings/signatories': {
    access: 'document.configure',
    request: (_t, n) => ({ path: '/api/documents/settings/signatories', body: { orgUnitId: null, names: { fr: `Signataire ${n}`, ar: 'موقع' }, titles: { fr: 'Directeur', ar: 'مدير' } } }),
    rows: CONFIG_ROWS(201),
  },
  'PATCH /api/documents/settings/signatories/:id': {
    access: 'document.configure',
    request: (t, n) => ({
      path: `/api/documents/settings/signatories/${t === 'other' ? BETA_SIGNATORY : DEMO_SIGNATORIES.hrDirector}`,
      body: { titles: { fr: `Directeur ${n}`, ar: 'مدير' } },
    }),
    rows: DOC_CONFIG_ROWS(200),
  },
  'GET /api/documents/signatories': {
    access: 'document.issue',
    request: () => ({ path: '/api/documents/signatories' }),
    rows: [['admin', '-', 200], ['est', '-', 200], ['ouest', '-', 403], ['acces', '-', 403], ['beta', '-', 200], ['agent', '-', 403]],
  },
  'POST /api/documents/preview': { access: 'document.issue', request: (t) => ({ path: '/api/documents/preview', body: issueBody(t) }), rows: DOC_ISSUE_ROWS(200) },
  'POST /api/documents': { access: 'document.issue', request: (t) => ({ path: '/api/documents', body: issueBody(t) }), rows: DOC_ISSUE_ROWS(201) },
  'GET /api/documents': {
    access: 'document.read',
    request: () => ({ path: '/api/documents?status=all&pageSize=5' }),
    rows: [['admin', '-', 200], ['est', '-', 200], ['ouest', '-', 403], ['acces', '-', 403], ['beta', '-', 200], ['agent', '-', 403]],
  },
  'GET /api/documents/:id': { access: 'document.read', request: (t) => ({ path: `/api/documents/${docOf(t)}` }), rows: DOC_READ_ROWS },
  'GET /api/documents/:id/pdf': { access: 'document.read', request: (t) => ({ path: `/api/documents/${docOf(t)}/pdf` }), rows: DOC_READ_ROWS },
  // each success voids its target's document once; the refusals do not depend on the status
  'POST /api/documents/:id/void': {
    access: 'document.void',
    request: (t) => ({ path: `/api/documents/${docOf(t)}/void`, body: { reason: 'Matrice' } }),
    rows: [
      ['admin', 'other', 404], ['est', 'est', 403], ['ouest', 'ouest', 403], ['acces', 'est', 403], ['beta', 'est', 404], ['agent', 'est', 403],
      ['admin', 'est', 200], ['admin', 'ouest', 200], ['beta', 'other', 200],
    ],
  },
  'GET /api/me/documents': {
    access: 'document.request_self',
    request: () => ({ path: '/api/me/documents' }),
    rows: [['agent', '-', 200], ['est', '-', 200], ['admin', '-', 409], ['beta', '-', 409], ['ouest', '-', 403], ['acces', '-', 403]],
  },
  // before the POST below: agent.annaba's pending request (beforeAll) is cancelled here, so the POST row can create one
  'POST /api/me/documents/requests/:id/cancel': {
    access: 'document.request_self',
    request: () => ({ path: `/api/me/documents/requests/${DOC.agentRequest}/cancel` }),
    rows: [['est', 'est', 404], ['admin', 'est', 409], ['ouest', 'est', 403], ['acces', 'est', 403], ['agent', 'est', 200]],
  },
  'POST /api/me/documents/requests': {
    access: 'document.request_self',
    request: () => ({ path: '/api/me/documents/requests', body: { typeCode: 'attestation_travail', language: 'fr' } }),
    rows: [['agent', '-', 201], ['est', '-', 201], ['admin', '-', 409], ['beta', '-', 409], ['ouest', '-', 403], ['acces', '-', 403]],
  },
  'GET /api/me/documents/:id/pdf': {
    access: 'document.request_self',
    // est: agent.annaba's own document · ouest: EMP-0027's (not the agent's) · other: Karim's own (EMP-0022)
    request: (t) => ({ path: `/api/me/documents/${t === 'est' ? DOC.agentOwn : t === 'ouest' ? DOC.est : DOC.karimOwn}/pdf` }),
    rows: [['agent', 'est', 200], ['agent', 'ouest', 404], ['est', 'other', 200], ['admin', 'est', 409], ['ouest', 'est', 403], ['acces', 'est', 403]],
  },

  // ── documents, Phase B: the employee file (docs/contracts/documents.md › Authorization matrix rows (Phase B)) ──
  'GET /api/employee-files/categories': { access: 'authenticated', request: () => ({ path: '/api/employee-files/categories' }), rows: [...READERS, ['agent', '-', 200]] },
  'POST /api/employee-files/categories': {
    access: 'document.configure',
    request: (_t, n) => ({ path: '/api/employee-files/categories', body: { code: `mx_cat_${n}`, labels: { fr: `Catégorie ${n}`, ar: 'فئة', en: `Category ${n}` } } }),
    rows: CONFIG_ROWS(201),
  },
  'PUT /api/employee-files/categories/:id': {
    access: 'document.configure',
    request: (t, n) => ({ path: `/api/employee-files/categories/${t === 'other' ? FILE.catB : FILE.catA}`, body: { retentionYearsAfterEnd: (n % 50) + 1 } }),
    rows: DOC_CONFIG_ROWS(200),
  },
  'GET /api/employees/:id/files': { access: 'employee_file.read', request: (t) => ({ path: `/api/employees/${employeeOf(t)}/files` }), rows: DOC_READ_ROWS },
  'POST /api/employees/:id/files': { access: 'employee_file.upload', request: (t, n) => fileUpload(t, n), rows: DOC_ISSUE_ROWS(201) },
  'GET /api/employees/:id/files/:fileId/content': {
    access: 'employee_file.read',
    request: (t) => ({ path: `/api/employees/${employeeOf(t)}/files/${fileOf(t)}/content` }),
    rows: DOC_READ_ROWS,
  },
  // each success deletes its target's own file once; the refusals do not depend on the state
  'POST /api/employees/:id/files/:fileId/delete': {
    access: 'employee_file.delete',
    request: (t) => ({ path: `/api/employees/${employeeOf(t)}/files/${delFileOf(t)}/delete`, body: { reason: 'Matrice' } }),
    rows: [
      ['admin', 'other', 404], ['est', 'est', 403], ['ouest', 'ouest', 403], ['acces', 'est', 403], ['beta', 'est', 404], ['agent', 'est', 403],
      ['admin', 'est', 204], ['admin', 'ouest', 204], ['beta', 'other', 204],
    ],
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

  // ── attendance: device side and scan (public) ──────────────────────────────────────────────────────────
  'POST /api/kiosk/pair': {
    access: 'public',
    request: (t) => ({ path: '/api/kiosk/pair', body: { code: t === 'est' ? DEMO_PAIRING_CODE : 'ZZZZ-ZZZZ' } }),
    rows: [['anon', '-', 410], ['anon', 'est', 200]],
  },
  'GET /api/kiosk/session': {
    access: 'public',
    request: (t) => ({ path: '/api/kiosk/session', ...(t === '-' ? {} : { cookie: kioskCookie(t === 'est' ? DEMO_KIOSKS.cne.id : DEMO_KIOSKS.oran.id) }) }),
    rows: [['anon', '-', 401], ['anon', 'est', 200], ['anon', 'other', 401]], // other: the revoked Oran kiosk
  },
  'GET /api/kiosk/qr': {
    access: 'public',
    request: (t) => ({ path: '/api/kiosk/qr', ...(t === '-' ? {} : { cookie: kioskCookie(t === 'est' ? DEMO_KIOSKS.cne.id : DEMO_KIOSKS.oran.id) }) }),
    rows: [['anon', '-', 401], ['anon', 'est', 200], ['anon', 'other', 401]],
  },
  'POST /api/attendance/scan': {
    access: 'public',
    request: (t) => ({ path: '/api/attendance/scan', body: { token: t === 'est' ? qrToken(DEMO_KIOSKS.cne.id, windowOf(Date.now())) : 'not-a-token' } }),
    rows: [['anon', 'est', 200], ['anon', '-', 422]],
  },

  // ── attendance: self-service and team ──────────────────────────────────────────────────────────────────
  'POST /api/me/attendance/punches': {
    access: 'attendance.punch_self',
    request: () => ({ path: '/api/me/attendance/punches', cookie: scanReceipt(DEMO_KIOSKS.cne.id, Date.now()) }),
    rows: ATT_SELF_ROWS(201),
  },
  'GET /api/me/attendance/days': { access: 'attendance.punch_self', request: () => ({ path: '/api/me/attendance/days' }), rows: ATT_SELF_ROWS(200) },
  'GET /api/me/team/presence': {
    access: 'authenticated',
    request: () => ({ path: '/api/me/team/presence' }),
    rows: [['chef', '-', 200], ['est', '-', 200], ['agent', '-', 200], ['admin', '-', 200], ['ouest', '-', 200], ['acces', '-', 200], ['beta', '-', 200]],
  },

  // ── attendance: HR ─────────────────────────────────────────────────────────────────────────────────────
  'GET /api/attendance/presence': {
    access: 'attendance.read',
    request: () => ({ path: '/api/attendance/presence?pageSize=5' }),
    rows: [['admin', '-', 200], ['est', '-', 200], ['ouest', '-', 200], ['acces', '-', 403], ['beta', '-', 200], ['agent', '-', 403], ['chef', '-', 403]],
  },
  'GET /api/employees/:id/attendance/days': { access: 'attendance.read', request: (t) => ({ path: `/api/employees/${employeeOf(t)}/attendance/days` }), rows: ATT_READ_ROWS },
  'GET /api/employees/:id/attendance/schedule': { access: 'attendance.read', request: (t) => ({ path: `/api/employees/${employeeOf(t)}/attendance/schedule` }), rows: ATT_READ_ROWS },
  'POST /api/employees/:id/attendance/punches': {
    access: 'attendance.manage',
    request: (t, n) => ({
      path: `/api/employees/${employeeOf(t)}/attendance/punches`,
      body: { direction: 'in', date: '2026-09-01', time: `${String(Math.floor((300 + n) / 60) % 24).padStart(2, '0')}:${String((300 + n) % 60).padStart(2, '0')}`, reason: 'Matrice' },
    }),
    rows: ATT_MANAGE_ROWS(201),
  },
  'POST /api/attendance/punches/:id/void': {
    access: 'attendance.manage',
    request: (t) => ({ path: `/api/attendance/punches/${next(ATT.voids[t])}/void`, body: { reason: 'Matrice' } }),
    rows: ATT_MANAGE_ROWS(200),
  },
  'GET /api/attendance/policy': { access: 'attendance.read', request: () => ({ path: '/api/attendance/policy' }), rows: ATT_SETTINGS_READ },
  'PUT /api/attendance/policy': { access: 'attendance.configure', request: () => ({ path: '/api/attendance/policy', body: { minPunchGapSeconds: 120 } }), rows: CONFIG_ROWS(200) },
  'GET /api/attendance/schedules': { access: 'attendance.read', request: () => ({ path: '/api/attendance/schedules' }), rows: ATT_SETTINGS_READ },
  'POST /api/attendance/schedules': {
    access: 'attendance.configure',
    request: (_t, n) => ({ path: '/api/attendance/schedules', body: { code: `mx_sched_${n}`, labels: { fr: `Horaire ${n}`, ar: 'توقيت', en: `Schedule ${n}` }, week: ATT_WEEK, toleranceMinutes: 10 } }),
    rows: CONFIG_ROWS(201),
  },
  'PATCH /api/attendance/schedules/:id': {
    access: 'attendance.configure',
    request: (t, n) => ({ path: `/api/attendance/schedules/${scheduleOf(t)}`, body: { labels: { fr: `Horaire ${n}`, ar: 'توقيت', en: `Schedule ${n}` } } }),
    rows: ATT_CONFIG_ROWS(200),
  },
  'POST /api/attendance/schedules/:id/versions': {
    access: 'attendance.configure',
    request: (t, n) => ({ path: `/api/attendance/schedules/${scheduleOf(t)}/versions`, body: { validFrom: attDay(n), week: ATT_WEEK, toleranceMinutes: 5 } }),
    rows: ATT_CONFIG_ROWS(201),
  },
  'GET /api/attendance/schedule-overrides': { access: 'attendance.read', request: () => ({ path: '/api/attendance/schedule-overrides?year=2027' }), rows: ATT_SETTINGS_READ },
  'POST /api/attendance/schedule-overrides': {
    access: 'attendance.configure',
    request: (_t, n) => ({
      path: '/api/attendance/schedule-overrides',
      body: { scheduleId: null, labels: { fr: `Période ${n}`, ar: 'فترة', en: `Period ${n}` }, from: attDay(n + 400), to: attDay(n + 400), week: ATT_WEEK, toleranceMinutes: 5, approximate: false },
    }),
    rows: CONFIG_ROWS(201),
  },
  'PUT /api/attendance/schedule-overrides/:id': {
    access: 'attendance.configure',
    request: (t, n) => ({
      path: `/api/attendance/schedule-overrides/${t === 'other' ? ATT.betaOverride : DEMO_SCHEDULES.ramadan}`,
      body: {
        scheduleId: null,
        labels: { fr: `Ramadan ${n}`, ar: 'رمضان', en: 'Ramadan' },
        from: t === 'other' ? '2027-06-01' : '2027-02-08',
        to: t === 'other' ? '2027-06-02' : '2027-03-09',
        week: weekOf('09:00', '16:00', null, null),
        toleranceMinutes: 10,
        approximate: true,
      },
    }),
    rows: ATT_CONFIG_ROWS(200),
  },
  'DELETE /api/attendance/schedule-overrides/:id': {
    access: 'attendance.configure',
    request: (t) => ({ path: `/api/attendance/schedule-overrides/${next(ATT.overrides[t])}` }),
    rows: ATT_CONFIG_ROWS(204),
  },
  'GET /api/attendance/schedule-assignments': { access: 'attendance.read', request: () => ({ path: '/api/attendance/schedule-assignments?at=all' }), rows: ATT_SETTINGS_READ },
  'POST /api/attendance/schedule-assignments': {
    access: 'attendance.configure',
    request: (t, n) => ({
      path: '/api/attendance/schedule-assignments',
      body: { scheduleId: scheduleOf(t), target: { kind: 'site', id: t === 'other' ? BETA_SITE : DEMO_SITE_ALG_CTR }, validFrom: attDay(n + 800) },
    }),
    rows: ATT_CREATE_ROWS(201),
  },
  'POST /api/attendance/schedule-assignments/:id/end': {
    access: 'attendance.configure',
    request: (t) => ({ path: `/api/attendance/schedule-assignments/${t === 'other' ? ATT.betaAssignment : DEMO_SCHEDULES.agencyUnit}/end`, body: { validTo: '2035-12-31' } }),
    rows: ATT_CONFIG_ROWS(200),
  },
  'DELETE /api/attendance/schedule-assignments/:id': {
    access: 'attendance.configure',
    request: (t) => ({ path: `/api/attendance/schedule-assignments/${next(ATT.assignments[t])}` }),
    rows: ATT_CONFIG_ROWS(204),
  },
  'GET /api/attendance/kiosks': {
    access: 'attendance.configure',
    request: () => ({ path: '/api/attendance/kiosks' }),
    rows: [['admin', '-', 200], ['est', '-', 403], ['ouest', '-', 403], ['acces', '-', 403], ['beta', '-', 200], ['agent', '-', 403]],
  },
  'POST /api/attendance/kiosks': {
    access: 'attendance.configure',
    request: (t, n) => ({ path: '/api/attendance/kiosks', body: { siteId: t === 'other' ? BETA_SITE : DEMO_SITE_ALG_CTR, labels: { fr: `Borne ${n}`, ar: 'شاشة' } } }),
    rows: ATT_CREATE_ROWS(201),
  },
  'PATCH /api/attendance/kiosks/:id': {
    access: 'attendance.configure',
    request: (t, n) => ({ path: `/api/attendance/kiosks/${kioskOf(t)}`, body: { labels: { fr: `Entrée ${n}`, ar: 'المدخل' } } }),
    rows: ATT_CONFIG_ROWS(200),
  },
  'POST /api/attendance/kiosks/:id/pairing-code': {
    access: 'attendance.configure',
    request: (t) => ({ path: `/api/attendance/kiosks/${kioskOf(t)}/pairing-code` }),
    rows: ATT_CONFIG_ROWS(200),
  },
  'POST /api/attendance/kiosks/:id/revoke': {
    access: 'attendance.configure',
    request: (t) => ({ path: `/api/attendance/kiosks/${next(ATT.kiosks[t])}/revoke`, body: { reason: 'Matrice' } }),
    rows: ATT_CONFIG_ROWS(200),
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
    fx = await seedAccessFixture(db, undefined, { leave: true, documents: true, attendance: true });
    const pinned = { today: () => '2026-09-26' };
    app = await createTestApp(db, {
      devAuth: true,
      devPermissions: false,
      overrides: [
        { provide: LeaveClock, useValue: pinned },
        { provide: StaffingClock, useValue: pinned },
        { provide: DocumentsClock, useValue: pinned },
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
    // documents: one issued document per target, the agent's and Karim's own, a pending request, BETA's logo
    const issueAs = async (actor: ActorName, employmentId: string) =>
      ((await as(app, actor, xsrf).post('/api/documents').send({ typeCode: 'attestation_travail', employmentId, language: 'fr' }).expect(201)).body as { id: string }).id;
    DOC.est = await issueAs('admin', employeeA(27));
    DOC.ouest = await issueAs('admin', employeeA(36));
    DOC.other = await issueAs('beta', EMPLOYEE_B.employmentId);
    DOC.agentOwn = await issueAs('admin', employeeA(30));
    DOC.karimOwn = await issueAs('admin', employeeA(22));
    DOC.agentRequest = ((await as(app, 'agent', xsrf).post('/api/me/documents/requests').send({ typeCode: 'attestation_travail', language: 'fr' }).expect(201)).body as { id: string }).id;
    const docType = async (company: string) =>
      (await query<{ id: string }>(db.superuserUrl, `select id from document_type where company_id = $1 and code = 'titre_conge'`, [company]))[0]?.id ?? '';
    DOC.typeA = await docType(unitCompany);
    DOC.typeB = await docType(COMPANY_B);
    await query(db.superuserUrl, `update company_profile set logo = $2, logo_mime = 'image/png', logo_sha256 = sha256($2) where company_id = $1`, [COMPANY_B, demoLogoPng()]);
    await query(db.superuserUrl, `update company_profile set logo = $2, logo_mime = 'image/png', logo_sha256 = sha256($2) where company_id = $1`, [unitCompany, demoLogoPng()]);
    expect(Object.values(DOC).every((v) => v !== ''), JSON.stringify(DOC)).toBe(true);
    // employee files: categories, then one file to read and one to delete per target
    const category = async (company: string, code: string) =>
      (await query<{ id: string }>(db.superuserUrl, `select id from employee_file_category where company_id = $1 and code = $2`, [company, code]))[0]?.id ?? '';
    Object.assign(FILE, {
      catA: await category(unitCompany, 'other'),
      catB: await category(COMPANY_B, 'other'),
      diplomaA: await category(unitCompany, 'diploma'),
      diplomaB: await category(COMPANY_B, 'diploma'),
    });
    const put = async (actor: ActorName, t: Target, label: string) => {
      const req = fileUpload(t, 0);
      const res = await as(app, actor, xsrf).post(req.path).field('categoryId', req.fields?.['categoryId'] ?? '').field('title', label)
        .attach('file', demoPdf(`TEST DATA - matrix fixture ${label}`), 'fixture.pdf').expect(201);
      return (res.body as { id: string }).id;
    };
    FILE.est = await put('admin', 'est', 'read est');
    FILE.ouest = await put('admin', 'ouest', 'read ouest');
    FILE.other = await put('beta', 'other', 'read other');
    FILE.delEst = await put('admin', 'est', 'delete est');
    FILE.delOuest = await put('admin', 'ouest', 'delete ouest');
    FILE.delOther = await put('beta', 'other', 'delete other');
    expect(Object.values(FILE).every((v) => v !== ''), JSON.stringify(FILE)).toBe(true);
    // attendance: BETA's schedule, an override and an assignment; pools of punches to void, overrides and future
    // assignments to delete, kiosks to revoke (each success consumes its target)
    ATT.betaSchedule = (await query<{ id: string }>(db.superuserUrl, `select id from attendance_schedule where company_id = $1 and code = 'standard'`, [COMPANY_B]))[0]?.id ?? '';
    const override = async (company: string, from: string) =>
      (
        await query<{ id: string }>(
          db.superuserUrl,
          `insert into attendance_schedule_override (company_id, name_fr, name_ar, name_en, dates, week, tolerance_minutes)
           values ($1, 'Matrice', 'مصفوفة', 'Matrix', daterange($2::date, $2::date + 1, '[)'), $3::jsonb, 5) returning id`,
          [company, from, JSON.stringify(ATT_WEEK)],
        )
      )[0]?.id ?? '';
    const assignment = async (company: string, schedule: string, site: string, from: string) =>
      (
        await query<{ id: string }>(
          db.superuserUrl,
          `insert into attendance_schedule_assignment (company_id, schedule_id, target_kind, site_id, valid)
           values ($1, $2, 'site', $3, daterange($4::date, $4::date + 1, '[)')) returning id`,
          [company, schedule, site, from],
        )
      )[0]?.id ?? '';
    const kiosk = async (company: string, site: string, k: number) =>
      (await query<{ id: string }>(db.superuserUrl, `insert into attendance_device (company_id, site_id, name_fr, name_ar) values ($1, $2, $3, 'شاشة') returning id`, [company, site, `Borne pool ${k}`]))[0]?.id ?? '';
    const punch = async (company: string, employmentId: string, k: number) =>
      (
        await query<{ id: string }>(
          db.superuserUrl,
          `insert into attendance_punch (company_id, employment_id, direction, occurred_at, source, reason)
           values ($1, $2, 'in', $3, 'manual', 'Matrice') returning id`,
          [company, employmentId, new Date(Date.UTC(2026, 8, 2, 6, k))],
        )
      )[0]?.id ?? '';
    ATT.betaOverride = await override(COMPANY_B, '2027-06-01');
    ATT.betaAssignment = await assignment(COMPANY_B, ATT.betaSchedule, BETA_SITE, '2035-01-01');
    for (let k = 0; k < 8; k++) {
      ATT.voids.est.push(await punch(unitCompany, employeeA(27), k));
      ATT.voids.ouest.push(await punch(unitCompany, employeeA(36), k));
      ATT.voids.other.push(await punch(COMPANY_B, EMPLOYEE_B.employmentId, k));
      ATT.overrides.est.push(await override(unitCompany, `2033-0${1 + Math.floor(k / 4)}-${String(1 + (k % 4) * 3).padStart(2, '0')}`));
      ATT.overrides.other.push(await override(COMPANY_B, `2033-0${1 + Math.floor(k / 4)}-${String(1 + (k % 4) * 3).padStart(2, '0')}`));
      ATT.assignments.est.push(await assignment(unitCompany, DEMO_SCHEDULES.agence, '0190a5d0-0000-7000-8000-000000000203', `2037-01-${String(1 + k * 3).padStart(2, '0')}`));
      ATT.assignments.other.push(await assignment(COMPANY_B, ATT.betaSchedule, BETA_SITE, `2037-01-${String(1 + k * 3).padStart(2, '0')}`));
      ATT.kiosks.est.push(await kiosk(unitCompany, DEMO_SITE_ALG_CTR, k));
      ATT.kiosks.other.push(await kiosk(COMPANY_B, BETA_SITE, k));
    }
    expect([ATT.betaSchedule, ATT.betaOverride, ATT.betaAssignment].every((v) => v !== ''), JSON.stringify(ATT)).toBe(true);
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
    let multipart = call;
    for (const [k, v] of Object.entries(req.fields ?? {})) multipart = multipart.field(k, v);
    if (req.cookie) call.set('Cookie', method === 'GET' ? req.cookie : `${xsrf.cookie}; ${req.cookie}`);
    const res = req.upload ? await multipart.attach('file', req.upload, req.filename ?? 'logo.png') : req.body ? await call.send(req.body) : await call;
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
