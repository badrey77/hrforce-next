import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { seedDemoAccess, seedGrants, seedSecurityPolicy, seedSystemRoles, type SeedGrant } from '../../src/modules/authorization/index.js';
import { seedBrandingDefaults } from '../../src/modules/branding/index.js';
import { seedCompanyProfile, seedDemoDocumentSettings, seedDocumentDefaults, seedSignatory } from '../../src/modules/documents/index.js';
import { demoEmployees, seedDemoEmployees, seedEmployees, type SeedEmployee } from '../../src/modules/employment/index.js';
import { DEMO_USERS, seedIdentity, type DemoUser } from '../../src/modules/identity/index.js';
import { LEAVE_DEMO_USERS, seedDemoLeave, seedLeaveDefaults } from '../../src/modules/leave/index.js';
import { DEMO_COMPANY_ID, DEMO_ORGANIZATION, seedOrganization, toIsoDate, type SeedOrganization } from '../../src/modules/organization/index.js';
import { seedRecruitmentDefaults } from '../../src/modules/recruitment/index.js';
import { createDatabase } from '../../src/platform/db/database.js';
import { query, type TestDatabase } from './test-database.js';
import { seedAttendanceFixture } from './attendance-fixture.js';
import { seedRecruitmentFixture } from './recruitment-fixture.js';
import { withXsrf, type XsrfPair } from './xsrf.js';

/*
 * Access fixture shared by the authorization e2e suites: the demo company (DEMO) with its seeded roles and grants,
 * a second company (BETA), and a few extra members. Everything is seeded as the migrator, like seed:dev.
 */

const id = (suffix: string) => `0190a5d0-0000-7000-8000-${suffix.padStart(12, '0')}`;

export const COMPANY_A = DEMO_COMPANY_ID;
export const COMPANY_B = id('b');

export const ORG_B: SeedOrganization = {
  company: { id: COMPANY_B, code: 'BETA', name: 'Beta SARL' },
  validFrom: '2026-01-01',
  sites: [{ id: id('b21'), code: 'BETA-HQ', name: 'Beta Siège', wilaya: 'Sétif' }],
  units: [
    { id: id('b01'), kind: 'direction_generale', code: 'BETA-DG', name: 'Beta DG', parent: null, site: 'BETA-HQ' },
    { id: id('b11'), kind: 'department', code: 'BETA-RH', name: 'Beta RH', parent: 'BETA-DG' },
  ],
};

function demoUser(email: string): DemoUser {
  const user = DEMO_USERS.find((u) => u.email === email);
  if (!user) throw new Error(email);
  return user;
}

/** Actors (header identity: X-Dev-User-Id / X-Dev-Company-Id). */
export const USERS = {
  /** admin_rh_central on DG (+ sub-units) — seeded demo grant */
  admin: demoUser('rh.admin@demo.dz'),
  /** rh_regional on REG-EST (+) — seeded demo grant */
  est: demoUser('rh.est@demo.dz'),
  /** lecture on REG-OUEST (+) — seeded demo grant */
  ouest: demoUser('lecture.ouest@demo.dz'),
  /** admin_acces on REG-EST (+) */
  acces: { id: id('ad'), email: 'acces.est@demo.dz', displayName: 'Nadia Acces', locale: 'fr' } satisfies DemoUser,
  /** a member without any grant */
  newbie: { id: id('ae'), email: 'newbie@demo.dz', displayName: 'Yacine Nouveau', locale: 'fr' } satisfies DemoUser,
  /** a member holding grants that tests end (lecture on AG-CNE and on AG-ORAN) */
  target: { id: id('af'), email: 'target@demo.dz', displayName: 'Lina Cible', locale: 'ar' } satisfies DemoUser,
  /** admin_rh_central of BETA (member of BETA only) */
  beta: { id: id('bb'), email: 'admin@beta.dz', displayName: 'Beta Admin', locale: 'fr' } satisfies DemoUser,
  /** employe, linked to EMP-0030 (Agence Annaba) — seeded with `{ leave: true }` */
  agent: LEAVE_DEMO_USERS[0] as DemoUser,
  /** employe, linked to EMP-0029, head of Agence Annaba — seeded with `{ leave: true }` */
  chef: LEAVE_DEMO_USERS[1] as DemoUser,
} as const;

export type ActorName = keyof typeof USERS;

export function unitA(code: string): string {
  const found = DEMO_ORGANIZATION.units.find((u) => u.code === code);
  if (!found) throw new Error(code);
  return found.id;
}

export function unitB(code: string): string {
  const found = ORG_B.units.find((u) => u.code === code);
  if (!found) throw new Error(code);
  return found.id;
}

const DEMO_EMPLOYEES = demoEmployees();

/** Employment id of the n-th demo employee (1-based, EMP-000n; see modules/employment/infra/demo-employees.ts). */
export function employeeA(n: number): string {
  const found = DEMO_EMPLOYEES[n - 1];
  if (!found) throw new Error(`demo employee ${n}`);
  return found.employmentId;
}

/** The demo employee record (names, unit…) of EMP-000n. */
export function demoEmployee(n: number): SeedEmployee {
  const found = DEMO_EMPLOYEES[n - 1];
  if (!found) throw new Error(`demo employee ${n}`);
  return found;
}

/** One employee of the other company (BETA), in BETA-RH. TEST DATA — fictitious. */
export const EMPLOYEE_B: SeedEmployee = {
  personId: id('b501'),
  employmentId: id('b502'),
  lastName: 'Beta',
  firstName: 'Salim',
  lastNameAr: null,
  firstNameAr: null,
  sex: 'M',
  birthDate: '1990-01-01',
  birthPlace: 'Sétif',
  nin: '190990000000000001',
  nss: '990000000001',
  rib: '00799999000000000999',
  bankName: 'BNA',
  matricule: 'B-0001',
  hireDate: '2020-01-01',
  endDate: null,
  endReason: null,
  assignments: [{ id: id('b503'), orgUnitId: id('b11'), jobTitle: 'Gestionnaire RH', validFrom: '2020-01-01', validTo: null }],
  salaries: [{ id: id('b504'), baseSalary: '70000.00', validFrom: '2020-01-01', validTo: null }],
};

/** Fixed grant ids of the fixture (on top of the demo grants …301–303). */
export const GRANTS = {
  accesEst: id('f01'),
  targetCne: id('f02'),
  targetOran: id('f03'),
  betaAdmin: id('f04'),
} as const;

export interface AccessFixture {
  /** role ids by company and code */
  rolesA: Record<string, string>;
  rolesB: Record<string, string>;
  /** a custom (non-system) role per company */
  customA: string;
  customB: string;
}

async function roleIds(db: TestDatabase, companyId: string): Promise<Record<string, string>> {
  const rows = await query<{ id: string; code: string }>(db.superuserUrl, 'select id, code from role where company_id = $1', [companyId]);
  return Object.fromEntries(rows.map((r) => [r.code, r.id]));
}

export interface FixtureOptions {
  /** + the leave demo without requests (defaults, agent/chef users, links, heads, accruals 2025-07 → 2026-09) */
  leave?: boolean;
  /**
   * + documents (docs/contracts/documents.md › Authorization matrix): DEMO's letterhead and signatories
   * (seedDemoDocumentSettings), BETA's letterhead (French only) and a company-wide signatory, BETA's leave defaults
   */
  documents?: boolean;
  /**
   * + attendance (docs/contracts/attendance.md › Seed): DEMO's schedules, override and kiosks (Annaba and Constantine
   * with known credentials, see attendance-fixture.ts), BETA's defaults, one kiosk and one punch
   */
  attendance?: boolean;
  /**
   * + recruitment (docs/contracts/recruitment.md › Seed): the DEMO openings, candidates and applications, and per
   * matrix target an open opening with pools of rows to consume (see recruitment-fixture.ts). Needs `leave`.
   */
  recruitment?: boolean;
}

/** BETA's company-wide signatory (documents fixture). */
export const BETA_SIGNATORY = id('b601');

/** Seeds both companies, users, roles and grants (idempotent). */
export async function seedAccessFixture(db: TestDatabase, today = toIsoDate(new Date()), options: FixtureOptions = {}): Promise<AccessFixture> {
  const migrator = createDatabase({ connectionString: db.migratorUrl, maxConnections: 1 });
  try {
    await migrator.transaction().execute(async (tx) => {
      await seedOrganization(tx, DEMO_ORGANIZATION, today);
      // docs/contracts/branding.md › Owning company: the first company (DEMO, company A) owns the installation default
      await seedBrandingDefaults(tx, COMPANY_A);
      await seedOrganization(tx, ORG_B, today);
      await seedIdentity(tx, COMPANY_A, [...DEMO_USERS, USERS.acces, USERS.newbie, USERS.target]);
      await seedIdentity(tx, COMPANY_B, [USERS.beta]);
      await seedDemoAccess(tx);
      await seedSystemRoles(tx, COMPANY_B);
      // like seed:dev: two-step sign-in not enforced (the MFA suite turns it on where it tests it)
      await seedSecurityPolicy(tx, COMPANY_A, { mfaEnforced: false });
      await seedSecurityPolicy(tx, COMPANY_B, { mfaEnforced: false });
      const extra: SeedGrant[] = [
        { id: GRANTS.accesEst, userId: USERS.acces.id, roleCode: 'admin_acces', orgUnitId: unitA('REG-EST'), includeDescendants: true, validFrom: '2026-01-01' },
        { id: GRANTS.targetCne, userId: USERS.target.id, roleCode: 'lecture', orgUnitId: unitA('AG-CNE'), includeDescendants: true, validFrom: '2026-01-01' },
        { id: GRANTS.targetOran, userId: USERS.target.id, roleCode: 'lecture', orgUnitId: unitA('AG-ORAN'), includeDescendants: true, validFrom: '2026-01-01' },
      ];
      await seedGrants(tx, COMPANY_A, extra);
      await seedDemoEmployees(tx);
      await seedEmployees(tx, COMPANY_B, [EMPLOYEE_B]);
      if (options.leave) await seedDemoLeave(tx, { requests: false });
      // the three document types + the self-service workflow of both companies (created after migration 0014)
      await seedDocumentDefaults(tx, COMPANY_A);
      await seedDocumentDefaults(tx, COMPANY_B);
      if (options.documents) {
        await seedDemoDocumentSettings(tx);
        await seedLeaveDefaults(tx, COMPANY_B);
        await seedCompanyProfile(tx, COMPANY_B, { legalNameFr: 'Beta SARL', legalNameAr: null, addressFr: '1 rue de Sétif, Sétif', addressAr: null, cityFr: 'Sétif', cityAr: null });
        await seedSignatory(tx, COMPANY_B, { id: BETA_SIGNATORY, orgUnitId: null, nameFr: 'Salima Beta', nameAr: 'سليمة بيتا', titleFr: 'Gérante', titleAr: 'المسيرة' });
      }
      if (options.attendance) await seedAttendanceFixture(tx);
      // the policy, approval chains and rejection reasons of both companies (created after migration 0019)
      await seedRecruitmentDefaults(tx, COMPANY_A);
      await seedRecruitmentDefaults(tx, COMPANY_B);
      if (options.recruitment) await seedRecruitmentFixture(tx);
      await seedGrants(tx, COMPANY_B, [
        { id: GRANTS.betaAdmin, userId: USERS.beta.id, roleCode: 'admin_rh_central', orgUnitId: unitB('BETA-DG'), includeDescendants: true, validFrom: '2026-01-01' },
      ]);
    });
  } finally {
    await migrator.destroy();
  }
  for (const [companyId, code] of [
    [COMPANY_A, 'custom_a'],
    [COMPANY_B, 'custom_b'],
  ] as const) {
    await query(
      db.superuserUrl,
      `insert into role (company_id, code, name_fr, name_ar, name_en) values ($1, $2, 'Personnalisé', 'مخصص', 'Custom')
       on conflict (company_id, lower(code)) do nothing`,
      [companyId, code],
    );
  }
  const rolesA = await roleIds(db, COMPANY_A);
  const rolesB = await roleIds(db, COMPANY_B);
  return { rolesA, rolesB, customA: rolesA['custom_a'] ?? '', customB: rolesB['custom_b'] ?? '' };
}

export function companyOf(actor: ActorName): string {
  return actor === 'beta' ? COMPANY_B : COMPANY_A;
}

/** Requests as an actor (DEV_AUTH headers) with the anon XSRF token on unsafe methods; `null` = anonymous. */
export function as(app: NestExpressApplication, actor: ActorName | null, xsrf: XsrfPair) {
  const agent = request(app.getHttpServer());
  const who = (req: request.Test) => (actor ? req.set('X-Dev-User-Id', USERS[actor].id).set('X-Dev-Company-Id', companyOf(actor)) : req);
  return {
    get: (url: string) => who(agent.get(url)),
    post: (url: string) => withXsrf(who(agent.post(url)), xsrf),
    patch: (url: string) => withXsrf(who(agent.patch(url)), xsrf),
    put: (url: string) => withXsrf(who(agent.put(url)), xsrf),
    delete: (url: string) => withXsrf(who(agent.delete(url)), xsrf),
  };
}
