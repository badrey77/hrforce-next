/**
 * The payroll demo seed (docs/contracts/payroll-variables.md › Seed, API builder 2): the previous month closed by the
 * real engine (v1, an adjusted line, a PRIME_REND bonus), two payroll matricules, and a sick leave approved after the
 * closing that comes back as a régularisation in the current month. Real "today". Idempotent. TEST DATA.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { algiersToday } from '../src/modules/documents/index.js';
import { payrollToday, seedDemoPayrollClosing, type DemoPayrollClosingOptions } from '../src/modules/payroll/index.js';
import { createDatabase } from '../src/platform/db/database.js';
import { as, COMPANY_A, employeeA, seedAccessFixture, USERS } from './support/access-fixture.js';
import { createTestApp } from './support/test-app.js';
import { createTestDatabase, query, type TestDatabase } from './support/test-database.js';
import { fetchXsrf, type XsrfPair } from './support/xsrf.js';

let db: TestDatabase;
let app: NestExpressApplication;
let xsrf: XsrfPair;
let options: DemoPayrollClosingOptions;

const monthKey = (offset: number): string => {
  const [y, m] = payrollToday().split('-').map(Number);
  return new Date(Date.UTC(y ?? 2026, (m ?? 1) - 1 + offset, 1)).toISOString().slice(0, 7);
};

async function seed() {
  const migrator = createDatabase({ connectionString: db.migratorUrl, maxConnections: 1 });
  try {
    return await migrator.transaction().execute((tx) => seedDemoPayrollClosing(tx, options));
  } finally {
    await migrator.destroy();
  }
}

beforeAll(async () => {
  db = await createTestDatabase();
  await seedAccessFixture(db, undefined, { leave: true, attendance: true });
  const manual = new Map(
    (await query<{ id: string; code: string }>(db.superuserUrl, `select id, export_code as code from payroll_rubrique where company_id = $1 and source = 'manual'`, [COMPANY_A])).map((r) => [r.code, r.id]),
  );
  options = {
    companyId: COMPANY_A,
    closedBy: USERS.admin.id,
    today: algiersToday(),
    manual,
    payrollCodes: [
      [employeeA(1), 'P-0001'],
      [employeeA(27), 'P-0027'],
    ],
    bonusEmploymentId: employeeA(29),
    lateLeaveEmploymentId: employeeA(5),
  };
  app = await createTestApp(db, { devAuth: true, devPermissions: false });
  xsrf = await fetchXsrf(app);
});

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

describe('seedDemoPayrollClosing', () => {
  it('closes the previous month; the late sick leave comes back in the current month; idempotent', async () => {
    const first = await seed();
    expect(first).toMatchObject({ closedMonth: `${monthKey(-1)}-01`, closed: true });
    expect(first.lines).toBeGreaterThan(0);
    const admin = as(app, 'admin', xsrf);
    const previous = (await admin.get(`/api/payroll/periods/${monthKey(-1)}`).expect(200)).body;
    expect(previous).toMatchObject({ status: 'closed', version: 1 });
    expect(previous.totals.find((t: { exportCode: string }) => t.exportCode === 'PRIME_REND')).toMatchObject({ total: 15000, employees: 1 });
    const adjusted = (await admin.get(`/api/payroll/periods/${monthKey(-1)}/variables?filter=adjusted&pageSize=100`).expect(200)).body.items;
    expect(adjusted.length).toBeGreaterThanOrEqual(1);
    const late = (await admin.get(`/api/payroll/periods/${monthKey(0)}/variables/${employeeA(5)}`).expect(200)).body;
    expect(late.lines).toEqual(expect.arrayContaining([expect.objectContaining({ exportCode: 'CG_MALADIE', originMonth: monthKey(-1), computed: 2, value: 2 })]));
    const coded = (await admin.get(`/api/payroll/periods/${monthKey(0)}/variables/${employeeA(27)}`).expect(200)).body;
    expect(coded.payrollCode).toBe('P-0027');
    const again = await seed();
    expect(again).toMatchObject({ closed: false });
    const closings = await query<{ n: number }>(db.superuserUrl, 'select count(*)::int as n from payroll_closing where company_id = $1', [COMPANY_A]);
    expect(closings[0]?.n).toBe(1);
  });
});
