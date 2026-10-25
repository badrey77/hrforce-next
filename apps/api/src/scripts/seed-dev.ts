/**
 * CLI: seed the demo company, its organisation (docs/contracts/organization.md), the demo users
 * (docs/contracts/identity.md › CLI and seed: rh.admin@demo.dz, rh.est@demo.dz, lecture.ouest@demo.dz, password
 * DEMO_PASSWORD), the system roles, the demo grants (docs/contracts/authorization.md › Dev seed) and 40 fictitious
 * employees (docs/contracts/employment.md › Seed — TEST DATA) and the leave demo (docs/contracts/leave.md › Seed additions:
 * defaults, agent.annaba / chef.annaba, links, unit heads, accruals Jul 2025 – Sep 2026, requests in each status), and
 * the DEMO security policy with two-step sign-in enforcement OFF (docs/contracts/mfa.md), and the documents demo
 * (docs/contracts/documents.md › Seed: letterhead, signatories, issued documents rendered with Typst, a pending request),
 * and the attendance demo (docs/contracts/attendance.md › Seed: schedules with the Ramadan override, kiosks in every
 * state — the pending one pairs with the dev code DEMK-2026 at /kiosk — and ~15 days of punches), and the recruitment
 * demo (docs/contracts/recruitment.md › Seed: openings in every status, fictitious candidates, generated CVs).
 *   npm run seed:dev -w @hrforce/api        (reads MIGRATOR_DATABASE_URL; idempotent; refuses NODE_ENV=production)
 * Runs as the migrator role (owner, BYPASSRLS) after `npm run migrate`.
 */
import { pino } from 'pino';
import { z } from 'zod';
import { migratorEnvSchema } from '../platform/config/env.schema.js';
import { parseEnv } from '../platform/config/load-env.js';
import { createDatabase } from '../platform/db/database.js';
import { TypstPdfRenderer } from '../platform/pdf/typst-renderer.js';
import { DEMO_GRANTS, SYSTEM_ROLES, seedDemoAccess, seedSecurityPolicy } from '../modules/authorization/index.js';
import { seedDemoAttendance } from '../modules/attendance/index.js';
import { seedDemoBranding } from '../modules/branding/index.js';
import { seedContractDefaults, seedDemoContracts } from '../modules/contracts/index.js';
import { seedDemoDeadlineAcks } from '../modules/deadlines/index.js';
import { seedDemoPayrollClosing, seedDemoPayrollRubriques } from '../modules/payroll/index.js';
import { algiersToday, demoLogoPng, seedDemoDocuments, seedDemoEmployeeFiles } from '../modules/documents/index.js';
import { demoEmployees, seedDemoEmployees, seedDemoPersonal, seedProfileDefaults } from '../modules/employment/index.js';
import { DEMO_PASSWORD, DEMO_USERS, seedIdentity } from '../modules/identity/index.js';
import { LEAVE_DEMO, LEAVE_DEMO_USERS, seedDemoLeave } from '../modules/leave/index.js';
import { DEMO_ORGANIZATION, seedOrganization, toIsoDate } from '../modules/organization/index.js';
import { seedDemoProfileRequests } from '../modules/profile/index.js';
import { seedDemoRecruitment } from '../modules/recruitment/index.js';
import { DEMO_SSO_CLIENT, seedDemoSso } from '../modules/sso/index.js';

const seedEnvSchema = migratorEnvSchema.extend({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** the API's OIDC_KEY (unset = the public development key): the demo app's secret is sealed with it */
  OIDC_KEY: z.string().optional(),
});

async function main(): Promise<void> {
  const env = parseEnv(seedEnvSchema, process.env);
  const logger = pino({ level: env.LOG_LEVEL, name: 'seed-dev' });
  if (env.NODE_ENV === 'production') throw new Error('seed:dev refuses to run with NODE_ENV=production');
  const renderer = new TypstPdfRenderer();
  const db = createDatabase({ connectionString: env.MIGRATOR_DATABASE_URL, maxConnections: 1, applicationName: 'hrforce-seed' });
  try {
    await db.transaction().execute(async (tx) => {
      await seedOrganization(tx, DEMO_ORGANIZATION, toIsoDate(new Date()));
      await seedIdentity(tx, DEMO_ORGANIZATION.company.id);
      await seedDemoAccess(tx);
      // docs/contracts/mfa.md: two-step sign-in is NOT enforced in the demo company (demos keep working)
      await seedSecurityPolicy(tx, DEMO_ORGANIZATION.company.id, { mfaEnforced: false });
      const employees = await seedDemoEmployees(tx);
      // docs/contracts/profile-changes.md › Seed: the request approval chains, the policy defaults, and fictitious
      // contact / emergency / family data (TEST DATA) for most demo employees
      await seedProfileDefaults(tx, DEMO_ORGANIZATION.company.id);
      const personal = await seedDemoPersonal(tx, DEMO_ORGANIZATION.company.id, demoEmployees());
      logger.info({ persons: personal }, 'personal details demo seeded (fictitious contact, emergency and family data)');
      const leave = await seedDemoLeave(tx, { requests: true });
      // docs/contracts/profile-changes.md › Seed: agent.annaba's change requests (pending family, applied contact,
      // rejected bank) — TEST DATA
      const profileRequests = await seedDemoProfileRequests(tx, DEMO_ORGANIZATION.company.id);
      logger.info({ requests: profileRequests }, 'profile change requests demo seeded');
      const documents = await seedDemoDocuments(tx, renderer, algiersToday());
      const employeeFiles = await seedDemoEmployeeFiles(tx, algiersToday());
      const attendance = await seedDemoAttendance(tx, Date.now());
      const sso = await seedDemoSso(tx, env.OIDC_KEY);
      const recruitment = await seedDemoRecruitment(tx, Date.now());
      // docs/contracts/branding.md › Seed: DEMO owns the installation default (sample footer and sign-in message)
      // and shows a sample welcome message with the letterhead's generated logo as company logo
      await seedDemoBranding(tx, DEMO_ORGANIZATION.company.id, demoLogoPng());
      // docs/contracts/contracts-deadlines.md › Seed: contracts (CDI, CDD, pré-emploi) placed around today, one pending
      // end-of-contract decision at chef.annaba's step
      await seedContractDefaults(tx, DEMO_ORGANIZATION.company.id);
      const annaba = DEMO_ORGANIZATION.units.find((u) => u.code === 'AG-ANNABA');
      if (!annaba) throw new Error('seed: AG-ANNABA missing');
      const contracts = await seedDemoContracts(tx, {
        companyId: DEMO_ORGANIZATION.company.id,
        today: algiersToday(),
        employees: demoEmployees(),
        annabaHeadUserId: LEAVE_DEMO.chef.userId,
        annabaUnitId: annaba.id,
      });
      logger.info(contracts, 'contracts demo seeded (deadlines around today, a pending end-of-contract decision for chef.annaba)');
      // docs/contracts/contracts-deadlines.md › Seed: DEMO's stored deadline policy and one item marked handled by rh.admin
      const rhAdmin = DEMO_USERS.find((u) => u.email === 'rh.admin@demo.dz');
      if (!rhAdmin) throw new Error('seed: rh.admin missing');
      const deadlines = await seedDemoDeadlineAcks(tx, DEMO_ORGANIZATION.company.id, rhAdmin.id, algiersToday());
      logger.info(deadlines, 'deadlines demo seeded (policy, one handled item)');
      // docs/contracts/payroll-variables.md › Seed: DEMO's stored policy, the computed rubriques and three manual ones
      const payrollRubriques = await seedDemoPayrollRubriques(tx, DEMO_ORGANIZATION.company.id);
      logger.info({ rubriques: payrollRubriques.size }, 'payroll rubriques seeded');
      // docs/contracts/payroll-variables.md › Seed: two payroll matricules, the previous month closed (v1, an adjusted line,
      // a PRIME_REND bonus), then a sick leave in it approved after the closing → a régularisation in the current month
      const demo = demoEmployees();
      const emp = (n: number) => demo[n - 1]?.employmentId ?? '';
      const payrollClosing = await seedDemoPayrollClosing(tx, {
        companyId: DEMO_ORGANIZATION.company.id,
        closedBy: rhAdmin.id,
        today: algiersToday(),
        manual: payrollRubriques,
        payrollCodes: [
          [emp(1), 'P-0001'],
          [emp(27), 'P-0027'],
        ],
        bonusEmploymentId: emp(29),
        lateLeaveEmploymentId: emp(5),
      });
      logger.info(payrollClosing, 'payroll demo seeded (previous month closed, a late sick leave → régularisation)');
      return { employees, leave, documents: { ...documents, employeeFiles }, attendance, sso, recruitment };
    }).then(({ employees, leave, documents, attendance, sso, recruitment }) => {
      logger.info(recruitment, 'recruitment demo seeded (openings in every status, fictitious candidates across the stages, an already purged opening)');
      logger.info(
        { clientId: DEMO_SSO_CLIENT.clientId, created: sso, redirectUris: DEMO_SSO_CLIENT.redirectUris },
        `SSO demo app seeded (docs/contracts/sso.md): client ${DEMO_SSO_CLIENT.clientId}, development secret ${DEMO_SSO_CLIENT.secret} (INSECURE, also in apps/sso-demo/.env.example)`,
      );
      logger.info(
        attendance,
        `attendance demo seeded (schedules, kiosks, punches); pair a kiosk at /kiosk with the development code ${attendance.pairingCode} (valid 30 days)`,
      );
      logger.info(documents, 'documents demo seeded (letterhead, signatories, issued documents, a pending request, employee files)');
      logger.info({ employees }, 'demo employees seeded (fictitious test data)');
      logger.info(
        { ...leave, users: LEAVE_DEMO_USERS.map((u) => u.email) },
        'leave demo seeded (defaults, links, unit heads, accruals 2025-07 → 2026-09, requests)',
      );
    });
    logger.info(
      { companyId: DEMO_ORGANIZATION.company.id, units: DEMO_ORGANIZATION.units.length },
      'demo organisation seeded',
    );
    logger.info(
      { users: DEMO_USERS.map((u) => ({ id: u.id, email: u.email, locale: u.locale })), devPassword: DEMO_PASSWORD },
      `demo users seeded (active, company ${DEMO_ORGANIZATION.company.code}); development password: ${DEMO_PASSWORD}`,
    );
    logger.info(
      { roles: SYSTEM_ROLES.map((r) => r.code), grants: DEMO_GRANTS.map((g) => ({ id: g.id, userId: g.userId, role: g.roleCode, unitId: g.orgUnitId })) },
      'system roles and demo grants seeded',
    );
  } finally {
    await renderer.close();
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`seed:dev: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
