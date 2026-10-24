/**
 * Payroll variables (docs/contracts/payroll-variables.md › Computation, Endpoints — API builder 2): the live variables
 * of an open month (leave, attendance where a kiosk is in use, entries and exits, flags), HR adjustments and manual
 * lines, amount lines hidden from regional HR, closing (cut-off, previous-open rule, concurrency → one wins, the
 * snapshot, closed months refuse writes), reopening (latest only), régularisations (a late approval, not doubled,
 * adjusted lines skipped), audit events and the employee History. "Today" is pinned (PayrollClock); leave, punches and
 * kiosks are written as the superuser. TEST DATA.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_KIOSKS } from '../src/modules/attendance/index.js';
import { seedGrants } from '../src/modules/authorization/index.js';
import { seedEmployees, type SeedEmployee } from '../src/modules/employment/index.js';
import { PayrollClock } from '../src/modules/payroll/index.js';
import { createDatabase } from '../src/platform/db/database.js';
import { as, COMPANY_A, employeeA, seedAccessFixture, unitA, USERS, type ActorName } from './support/access-fixture.js';
import { assertNoSecrets } from './support/assert-no-secrets.js';
import { createTestApp } from './support/test-app.js';
import { createTestDatabase, query, type TestDatabase } from './support/test-database.js';
import { fetchXsrf, type XsrfPair } from './support/xsrf.js';

const clock = { value: '2026-10-24', today(): string { return this.value; } };

let db: TestDatabase;
let app: NestExpressApplication;
let xsrf: XsrfPair;
const client = (actor: ActorName | null) => as(app, actor, xsrf);
const PROBLEM = (slug: string) => `urn:hrforce:problem:${slug}`;

/** EMP-0027 (Agence Constantine, Région Est): punches at the Constantine kiosk from 2026-10-18. */
const E1 = employeeA(27);
/** EMP-0036 (Agence Oran, Région Ouest). */
const OUEST = employeeA(36);
/** EMP-0025: ended 2026-06-30. */
const ENDED = employeeA(25);

const fid = (n: number) => `0190a5d0-0000-7000-8000-0000000c${String(n).padStart(4, '0')}`;
const seedPerson = (n: number, over: Partial<SeedEmployee>): SeedEmployee => ({
  personId: fid(n * 10 + 1),
  employmentId: fid(n * 10 + 2),
  lastName: 'Paie',
  firstName: `Test${n}`,
  lastNameAr: null,
  firstNameAr: null,
  sex: 'F',
  birthDate: '1990-01-01',
  birthPlace: 'Constantine',
  nin: `19099000000000${String(n).padStart(4, '0')}`,
  nss: `99000000${String(n).padStart(4, '0')}`,
  rib: `0079999900000000${String(n).padStart(4, '0')}`,
  bankName: 'BNA',
  matricule: `PAY-${n}`,
  hireDate: '2019-01-01',
  endDate: null,
  endReason: null,
  assignments: [{ id: fid(n * 10 + 3), orgUnitId: unitA('AG-CNE'), jobTitle: 'Agent', validFrom: '2019-01-01', validTo: null }],
  salaries: [{ id: fid(n * 10 + 4), baseSalary: '60000.00', validFrom: '2019-01-01', validTo: null }],
  ...over,
});
/** hired on 2026-10-12 */
const HIRE = seedPerson(1, {
  hireDate: '2026-10-12',
  assignments: [{ id: fid(13), orgUnitId: unitA('AG-CNE'), jobTitle: 'Agent', validFrom: '2026-10-12', validTo: null }],
  salaries: [{ id: fid(14), baseSalary: '60000.00', validFrom: '2026-10-12', validTo: null }],
});
/** left on 2026-10-15 */
const LEAVER = seedPerson(2, {
  endDate: '2026-10-15',
  endReason: 'resignation',
  assignments: [{ id: fid(23), orgUnitId: unitA('AG-CNE'), jobTitle: 'Agent', validFrom: '2019-01-01', validTo: '2026-10-16' }],
  salaries: [{ id: fid(24), baseSalary: '60000.00', validFrom: '2019-01-01', validTo: '2026-10-16' }],
});

const R: Record<string, string> = {};

interface Line {
  rubriqueId: string;
  exportCode: string;
  unit: string;
  source: string;
  originMonth: string;
  computed: number | null;
  value: number;
  adjusted: boolean;
  note: string | null;
}
interface Variables {
  employee: { id: string; matricule: string; unit: { code: string } };
  payrollCode: string | null;
  entry: string | null;
  exit: string | null;
  flags: string[];
  incompleteDays: number;
  lines: Line[];
  _actions: string[];
}

async function variables(actor: ActorName, month: string, employeeId: string): Promise<Variables> {
  const res = await client(actor).get(`/api/payroll/periods/${month}/variables/${employeeId}`).expect(200);
  return res.body as Variables;
}

const byCode = (v: Variables, code: string, origin?: string) => v.lines.filter((l) => l.exportCode === code && (!origin || l.originMonth === origin));
const value = (v: Variables, code: string, origin?: string) => byCode(v, code, origin)[0]?.value;

async function leave(employmentId: string, start: string, end: string, status: 'approved' | 'pending', code = 'annual'): Promise<string> {
  const [row] = await query<{ id: string }>(
    db.superuserUrl,
    `insert into leave_request (company_id, employment_id, leave_type_id, org_unit_id, start_date, end_date, days, status, requested_by)
     values ($1, $2, (select id from leave_type where company_id = $1 and code = $6), $7, $3, $4, ($4::date - $3::date + 1), $5, $8) returning id`,
    [COMPANY_A, employmentId, start, end, status, code, unitA('AG-CNE'), USERS.admin.id],
  );
  return row?.id ?? '';
}

/** A manual punch at an Algiers wall-clock time. */
async function punch(date: string, time: string, direction: 'in' | 'out'): Promise<void> {
  const [h, m] = time.split(':').map(Number);
  const at = new Date(Date.parse(`${date}T00:00:00Z`) + (((h ?? 0) - 1) * 60 + (m ?? 0)) * 60_000);
  await query(
    db.superuserUrl,
    `insert into attendance_punch (company_id, employment_id, direction, occurred_at, source, reason, created_by) values ($1, $2, $3, $4, 'manual', 'test', $5)`,
    [COMPANY_A, E1, direction, at, USERS.admin.id],
  );
}

beforeAll(async () => {
  db = await createTestDatabase();
  await seedAccessFixture(db, undefined, { leave: true, attendance: true });
  const migrator = createDatabase({ connectionString: db.migratorUrl, maxConnections: 1 });
  await migrator.transaction().execute(async (tx) => {
    await seedEmployees(tx, COMPANY_A, [HIRE, LEAVER]);
    // a central-HR role held on one region only: payroll.close is company-wide → 403 forbidden-scope
    await seedGrants(tx, COMPANY_A, [{ id: fid(90), userId: USERS.newbie.id, roleCode: 'admin_rh_central', orgUnitId: unitA('REG-EST'), includeDescendants: true, validFrom: '2026-01-01' }]);
  });
  await migrator.destroy();
  for (const r of await query<{ id: string; code: string }>(db.superuserUrl, 'select id, export_code as code from payroll_rubrique where company_id = $1', [COMPANY_A])) R[r.code] = r.id;
  // lateness and overtime are inactive by default: on for these tests
  await query(db.superuserUrl, `update payroll_rubrique set active = true where company_id = $1 and export_code in ('RETARD', 'HS50', 'HS75')`, [COMPANY_A]);
  // attendance in use at Constantine from Sunday 2026-10-18 only; the Annaba kiosk after the months tested
  await query(db.superuserUrl, `update attendance_device set status = 'active', paired_at = '2026-10-17T23:30:00Z', revoked_at = null, revoked_by = null, revoke_reason = null where id = $1`, [DEMO_KIOSKS.cne.id]);
  await query(db.superuserUrl, `update attendance_device set paired_at = '2027-06-01T08:00:00Z' where id = $1`, [DEMO_KIOSKS.annaba.id]);
  await query(db.superuserUrl, `update assignment set site_id = (select id from site where company_id = $1 and code = 'CNE') where employment_id = $2`, [COMPANY_A, E1]);
  // the agency schedule at CNE: Sun–Thu 07:30–16:00, break 12:00–12:30 (480 min), tolerance 10
  await punch('2026-10-18', '07:25', 'in'); // present, 5 min extra: below the 30-min overtime minimum
  await punch('2026-10-18', '16:00', 'out');
  await punch('2026-10-19', '07:30', 'in'); // 90 min of overtime
  await punch('2026-10-19', '17:30', 'out');
  await punch('2026-10-20', '08:00', 'in'); // 30 min late
  await punch('2026-10-20', '16:00', 'out');
  // 2026-10-21: no punch → absent
  await punch('2026-10-22', '07:30', 'in'); // never closed → incomplete
  await punch('2026-10-23', '09:00', 'in'); // Friday (rest day): 2.25 h
  await punch('2026-10-23', '11:15', 'out');
  await leave(E1, '2026-09-28', '2026-10-01', 'approved'); // 3 days in September, 1 in October
  await leave(E1, '2026-10-26', '2026-10-27', 'pending');
  app = await createTestApp(db, { devAuth: true, devPermissions: false, overrides: [{ provide: PayrollClock, useValue: clock }] });
  xsrf = await fetchXsrf(app);
});

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

describe('live variables', () => {
  it('lists the months of the year up to the current one, all open', async () => {
    const res = await client('admin').get('/api/payroll/periods').expect(200);
    expect(res.body.items.map((p: { month: string }) => p.month)).toEqual(['01', '02', '03', '04', '05', '06', '07', '08', '09', '10'].map((m) => `2026-${m}`));
    expect(res.body.items[9]).toEqual({ month: '2026-10', status: 'open', cutoffDate: '2026-10-20', version: null, closedAt: null, closedBy: null });
    expect((await client('admin').get('/api/payroll/periods?year=2025').expect(200)).body.items).toHaveLength(12);
    expect((await client('admin').get('/api/payroll/periods?year=2027').expect(200)).body.items).toEqual([]);
    await client('admin').get('/api/payroll/periods/2026-11').expect(422);
    await client('admin').get('/api/payroll/periods/2026-13').expect(422);
  });

  it('computes leave, absences, lateness and overtime where the kiosk is in use, with the flags', async () => {
    const v = await variables('admin', '2026-10', E1);
    assertNoSecrets(v);
    expect(v.employee).toMatchObject({ id: E1, matricule: 'EMP-0027', unit: { code: 'AG-CNE' } });
    expect(value(v, 'CG_ANNUEL')).toBe(1);
    expect(value(v, 'ABS_NJ')).toBe(1);
    expect(value(v, 'RETARD')).toBe(0.5);
    expect(value(v, 'HS50')).toBe(1.5);
    expect(value(v, 'HS75')).toBe(2.25);
    expect(byCode(v, 'JRS_PRES')).toEqual([]);
    expect(v.flags).toEqual(['incomplete_days', 'pending_leave']);
    expect(v.incompleteDays).toBe(1);
    expect(v['_actions']).toEqual(['edit']);
    expect(byCode(v, 'CG_ANNUEL')[0]).toMatchObject({ source: 'leave', unit: 'days', originMonth: '2026-10', computed: 1, adjusted: false, note: null });
    // September: no kiosk in use → no absence, the flag
    const sep = await variables('admin', '2026-09', E1);
    expect(sep.lines.map((l) => [l.exportCode, l.value])).toEqual([['CG_ANNUEL', 3]]);
    expect(sep.flags).toEqual(['no_attendance']);
  });

  it('presence days only for a month with a hire or an exit', async () => {
    const hire = await variables('admin', '2026-10', HIRE.employmentId);
    expect(hire).toMatchObject({ entry: '2026-10-12', exit: null });
    expect(value(hire, 'JRS_PRES')).toBe(20);
    const leaver = await variables('admin', '2026-10', LEAVER.employmentId);
    expect(leaver).toMatchObject({ entry: null, exit: '2026-10-15' });
    expect(value(leaver, 'JRS_PRES')).toBe(15);
    expect(byCode(await variables('admin', '2026-09', LEAVER.employmentId), 'JRS_PRES')).toEqual([]);
    // not employed in the month, never in the window → 404 on read
    await client('admin').get(`/api/payroll/periods/2026-10/variables/${ENDED}`).expect(404);
  });

  it('lists the caller’s scope with filters and paging; Ouest is not Est’s', async () => {
    const all = (await client('admin').get('/api/payroll/periods/2026-10/variables?pageSize=100').expect(200)).body;
    expect(all.total).toBeGreaterThanOrEqual(40);
    const ids = all.items.map((i: Variables) => i.employee.id);
    expect(ids).toEqual(expect.arrayContaining([E1, OUEST, HIRE.employmentId, LEAVER.employmentId]));
    const est = (await client('est').get('/api/payroll/periods/2026-10/variables?pageSize=100').expect(200)).body;
    expect(est.items.map((i: Variables) => i.employee.id)).toContain(E1);
    expect(est.items.map((i: Variables) => i.employee.id)).not.toContain(OUEST);
    await client('est').get(`/api/payroll/periods/2026-10/variables/${OUEST}`).expect(404);
    const flagged = (await client('admin').get('/api/payroll/periods/2026-10/variables?filter=flagged&pageSize=100').expect(200)).body.items as Variables[];
    expect(flagged.map((i) => i.employee.id)).toContain(E1);
    expect(flagged.every((i) => i.flags.length > 0)).toBe(true);
    const cg = (await client('admin').get(`/api/payroll/periods/2026-10/variables?rubriqueId=${R['CG_ANNUEL']}`).expect(200)).body.items as Variables[];
    expect(cg.map((i) => i.employee.id)).toEqual([E1]);
    const searched = (await client('admin').get('/api/payroll/periods/2026-10/variables?q=EMP-0027').expect(200)).body;
    expect(searched.items.map((i: Variables) => i.employee.id)).toEqual([E1]);
    const page2 = (await client('admin').get('/api/payroll/periods/2026-10/variables?pageSize=10&page=2').expect(200)).body;
    expect(page2).toMatchObject({ page: 2, pageSize: 10, total: all.total });
    expect(page2.items[0].employee.id).toBe(all.items[10].employee.id);
    const sub = (await client('admin').get(`/api/payroll/periods/2026-10/variables?unitId=${unitA('REG-OUEST')}&pageSize=100`).expect(200)).body.items as Variables[];
    expect(sub.map((i) => i.employee.id)).toContain(OUEST);
    expect(sub.map((i) => i.employee.id)).not.toContain(E1);
    for (const actor of ['ouest', 'acces', 'agent'] as const) await client(actor).get('/api/payroll/periods/2026-10/variables').expect(403);
    await client(null).get('/api/payroll/periods/2026-10/variables').expect(401);
  });

  it('the period view totals the caller’s lines', async () => {
    const view = (await client('admin').get('/api/payroll/periods/2026-10').expect(200)).body;
    expect(view).toMatchObject({ month: '2026-10', status: 'open', version: null, closings: [] });
    expect(view['_actions']).toEqual(['close', 'export_draft']);
    const cg = view.totals.find((t: { exportCode: string }) => t.exportCode === 'CG_ANNUEL');
    expect(cg).toMatchObject({ unit: 'days', employees: 1, total: 1 });
    expect(view.flags.pendingLeave).toBeGreaterThanOrEqual(1);
    expect(view.flags.incompleteDays).toBeGreaterThanOrEqual(1);
    expect(view.employees).toBeGreaterThan(0);
    expect(view.lines).toBeGreaterThanOrEqual(view.employees);
    // regional HR: no close action
    expect((await client('est').get('/api/payroll/periods/2026-10').expect(200)).body['_actions']).toEqual(['export_draft']);
  });
});

describe('adjustments', () => {
  it('adjusts a computed line, reverts it, and types a manual line', async () => {
    const put = await client('admin')
      .put(`/api/payroll/periods/2026-10/variables/${E1}/lines`)
      .send({ rubriqueId: R['ABS_NJ'], value: 0, note: 'Absence justifiée' })
      .expect(200);
    expect(byCode(put.body, 'ABS_NJ')[0]).toMatchObject({ computed: 1, value: 0, adjusted: true, note: 'Absence justifiée' });
    await client('admin').put(`/api/payroll/periods/2026-10/variables/${E1}/lines`).send({ rubriqueId: R['CG_ANNUEL'], value: 2.5 }).expect(200);
    const reverted = await client('admin').delete(`/api/payroll/periods/2026-10/variables/${E1}/lines/${R['CG_ANNUEL']}`).expect(200);
    expect(byCode(reverted.body, 'CG_ANNUEL')[0]).toMatchObject({ computed: 1, value: 1, adjusted: false });
    const panier = await client('est').put(`/api/payroll/periods/2026-10/variables/${E1}/lines`).send({ rubriqueId: R['IND_PANIER_J'], value: 12 }).expect(200);
    expect(byCode(panier.body, 'IND_PANIER_J')[0]).toMatchObject({ source: 'manual', computed: null, value: 12, adjusted: true });
    const adjusted = (await client('admin').get('/api/payroll/periods/2026-10/variables?filter=adjusted').expect(200)).body.items as Variables[];
    expect(adjusted.map((i) => i.employee.id)).toEqual([E1]);
  });

  it('amount lines: central HR only (typed with employee.salary.update, hidden from regional HR)', async () => {
    const prime = await client('admin').put(`/api/payroll/periods/2026-10/variables/${E1}/lines`).send({ rubriqueId: R['PRIME_REND'], value: 15000, note: 'Prime T3' }).expect(200);
    expect(value(prime.body, 'PRIME_REND')).toBe(15000);
    const asEst = await variables('est', '2026-10', E1);
    expect(byCode(asEst, 'PRIME_REND')).toEqual([]);
    expect(value(asEst, 'IND_PANIER_J')).toBe(12);
    const refused = await client('est').put(`/api/payroll/periods/2026-10/variables/${E1}/lines`).send({ rubriqueId: R['AVANCE'], value: 5000 }).expect(403);
    expect(refused.body.type).toBe(PROBLEM('forbidden-field'));
    await client('est').delete(`/api/payroll/periods/2026-10/variables/${E1}/lines/${R['PRIME_REND']}`).expect(403);
    const estPeriod = (await client('est').get('/api/payroll/periods/2026-10').expect(200)).body;
    expect(estPeriod.totals.some((t: { exportCode: string }) => t.exportCode === 'PRIME_REND')).toBe(false);
  });

  it('refuses inactive rubriques, a régularisation month without one, a person not employed, other scopes', async () => {
    const url = `/api/payroll/periods/2026-10/variables/${E1}/lines`;
    const inactive = await client('admin').put(url).send({ rubriqueId: R['CG_RECUP'], value: 1 }).expect(422);
    expect(inactive.body.errors).toEqual([expect.objectContaining({ field: 'rubriqueId', code: 'inactive' })]);
    const origin = await client('admin').put(url).send({ rubriqueId: R['CG_ANNUEL'], originMonth: '2026-09', value: 1 }).expect(422);
    expect(origin.body.errors).toEqual([expect.objectContaining({ field: 'originMonth', code: 'invalid' })]);
    await client('admin').put(url).send({ rubriqueId: R['CG_ANNUEL'], originMonth: '2026-11', value: 1 }).expect(422);
    await client('admin').put(url).send({ rubriqueId: R['CG_ANNUEL'], value: 1.234 }).expect(422);
    await client('admin').put(url).send({ rubriqueId: R['CG_ANNUEL'], value: 1, extra: true }).expect(422);
    const ended = await client('admin').put(`/api/payroll/periods/2026-10/variables/${ENDED}/lines`).send({ rubriqueId: R['IND_PANIER_J'], value: 1 }).expect(422);
    expect(ended.body.errors).toEqual([expect.objectContaining({ field: 'employeeId', code: 'not_employed' })]);
    await client('est').put(`/api/payroll/periods/2026-10/variables/${OUEST}/lines`).send({ rubriqueId: R['IND_PANIER_J'], value: 1 }).expect(404);
    for (const actor of ['ouest', 'acces', 'agent'] as const) await client(actor).put(url).send({ rubriqueId: R['IND_PANIER_J'], value: 1 }).expect(403);
    await client(null).put(url).send({ rubriqueId: R['IND_PANIER_J'], value: 1 }).expect(401);
  });
});

describe('closing', () => {
  it('needs a company-wide payroll.close; refuses before the cut-off', async () => {
    const regional = await client('newbie').post('/api/payroll/periods/2026-09/close').send({}).expect(403);
    expect(regional.body.type).toBe(PROBLEM('forbidden-scope'));
    expect((await client('newbie').post('/api/payroll/periods/2026-09/reopen').send({ reason: 'Erreur de saisie' }).expect(403)).body.type).toBe(PROBLEM('forbidden-scope'));
    await client('est').post('/api/payroll/periods/2026-09/close').send({}).expect(403);
    await client('ouest').post('/api/payroll/periods/2026-09/close').send({}).expect(403);
    clock.value = '2026-10-19';
    const early = await client('admin').post('/api/payroll/periods/2026-10/close').send({}).expect(409);
    expect(early.body.type).toBe(PROBLEM('payroll-before-cutoff'));
    clock.value = '2026-10-24';
  });

  it('closes August, then refuses October while September is open', async () => {
    const aug = (await client('admin').post('/api/payroll/periods/2026-08/close').send({}).expect(200)).body;
    expect(aug).toMatchObject({ month: '2026-08', status: 'closed', version: 1, closedBy: { id: USERS.admin.id } });
    expect(aug['_actions']).toEqual(['reopen', 'export']);
    const oct = await client('admin').post('/api/payroll/periods/2026-10/close').send({}).expect(409);
    expect(oct.body.type).toBe(PROBLEM('payroll-previous-open'));
  });

  it('two concurrent closes of September: one wins, the other is told the month is closed', async () => {
    const results = await Promise.all([client('admin').post('/api/payroll/periods/2026-09/close').send({}), client('admin').post('/api/payroll/periods/2026-09/close').send({})]);
    expect(results.map((r) => r.status).toSorted()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)?.body.type).toBe(PROBLEM('payroll-period-closed'));
    const closings = await query<{ n: number }>(db.superuserUrl, `select count(*)::int as n from payroll_closing c join payroll_period p on p.id = c.period_id where p.month = '2026-09-01'`);
    expect(closings[0]?.n).toBe(1);
    // the snapshot
    const lines = await query<{ code: string; value: string; matricule: string; unit_code: string }>(
      db.superuserUrl,
      `select l.export_code as code, l.value::text as value, l.matricule, l.unit_code from payroll_line l
         join payroll_closing c on c.id = l.closing_id join payroll_period p on p.id = c.period_id
        where p.month = '2026-09-01' and l.employment_id = $1`,
      [E1],
    );
    expect(lines).toEqual([{ code: 'CG_ANNUEL', value: '3.00', matricule: 'EMP-0027', unit_code: 'AG-CNE' }]);
  });

  it('a closed month answers from its closing and refuses writes', async () => {
    const sep = await variables('admin', '2026-09', E1);
    expect(sep.lines.map((l) => [l.exportCode, l.value])).toEqual([['CG_ANNUEL', 3]]);
    // `edit`: the caller may still change the payroll matricule (not a value of the month); the lines refuse writes.
    expect(sep['_actions']).toEqual(['edit']);
    const put = await client('admin').put(`/api/payroll/periods/2026-09/variables/${E1}/lines`).send({ rubriqueId: R['IND_PANIER_J'], value: 1 }).expect(409);
    expect(put.body.type).toBe(PROBLEM('payroll-period-closed'));
    await client('admin').delete(`/api/payroll/periods/2026-09/variables/${E1}/lines/${R['CG_ANNUEL']}`).expect(409);
    const again = await client('admin').post('/api/payroll/periods/2026-09/close').send({}).expect(409);
    expect(again.body.type).toBe(PROBLEM('payroll-period-closed'));
    const periods = (await client('admin').get('/api/payroll/periods').expect(200)).body.items;
    expect(periods[8]).toMatchObject({ month: '2026-09', status: 'closed', version: 1 });
  });

  it('a leave approved after the closing comes back as a régularisation in the open month, adjustable', async () => {
    await leave(E1, '2026-09-15', '2026-09-16', 'approved');
    const oct = await variables('admin', '2026-10', E1);
    expect(byCode(oct, 'CG_ANNUEL', '2026-09')[0]).toMatchObject({ computed: 2, value: 2, adjusted: false });
    expect(value(oct, 'CG_ANNUEL', '2026-10')).toBe(1);
    const regs = (await client('admin').get('/api/payroll/periods/2026-10/variables?filter=regularization').expect(200)).body.items as Variables[];
    expect(regs.map((i) => i.employee.id)).toEqual([E1]);
    const adj = await client('admin')
      .put(`/api/payroll/periods/2026-10/variables/${E1}/lines`)
      .send({ rubriqueId: R['CG_ANNUEL'], originMonth: '2026-09', value: 1.5, note: 'Accord RH' })
      .expect(200);
    expect(byCode(adj.body, 'CG_ANNUEL', '2026-09')[0]).toMatchObject({ computed: 2, value: 1.5, adjusted: true });
    expect((await client('admin').get('/api/payroll/periods/2026-10').expect(200)).body.regularizations).toBeGreaterThanOrEqual(1);
  });

  it('reopens only the latest closed month, then closes it again as version 2', async () => {
    const notLatest = await client('admin').post('/api/payroll/periods/2026-08/reopen').send({ reason: 'Erreur de saisie' }).expect(409);
    expect(notLatest.body.type).toBe(PROBLEM('payroll-period-not-latest'));
    await client('admin').post('/api/payroll/periods/2026-09/reopen').send({ reason: 'abc' }).expect(422);
    await client('est').post('/api/payroll/periods/2026-09/reopen').send({ reason: 'Erreur de saisie' }).expect(403);
    const reopened = (await client('admin').post('/api/payroll/periods/2026-09/reopen').send({ reason: 'Congé validé en retard' }).expect(200)).body;
    expect(reopened).toMatchObject({ status: 'open', version: null });
    expect(reopened.closings).toEqual([expect.objectContaining({ version: 1, reopenedBy: { id: USERS.admin.id, displayName: expect.any(String) }, reopenReason: 'Congé validé en retard' })]);
    const open = await client('admin').post('/api/payroll/periods/2026-09/reopen').send({ reason: 'Encore une fois' }).expect(409);
    expect(open.body.type).toBe(PROBLEM('payroll-period-open'));
    // reopened and not closed again: later months wait
    expect((await client('admin').post('/api/payroll/periods/2026-10/close').send({}).expect(409)).body.type).toBe(PROBLEM('payroll-previous-open'));
    expect(value(await variables('admin', '2026-09', E1), 'CG_ANNUEL')).toBe(5);
    // while September is open, October has no régularisation of it, only HR's adjustment of that origin
    expect(byCode(await variables('admin', '2026-10', E1), 'CG_ANNUEL', '2026-09')[0]).toMatchObject({ computed: 0, value: 1.5, adjusted: true });
    const v2 = (await client('admin').post('/api/payroll/periods/2026-09/close').send({}).expect(200)).body;
    expect(v2).toMatchObject({ status: 'closed', version: 2 });
    expect(v2.closings.map((c: { version: number }) => c.version)).toEqual([1, 2]);
    // the September leave is in version 2: October's régularisation is gone; HR's adjustment of it stays until removed
    const oct = await variables('admin', '2026-10', E1);
    expect(byCode(oct, 'CG_ANNUEL', '2026-09')[0]).toMatchObject({ computed: 0, value: 1.5, adjusted: true });
    const removed = await client('admin').delete(`/api/payroll/periods/2026-10/variables/${E1}/lines/${R['CG_ANNUEL']}?originMonth=2026-09`).expect(200);
    expect(byCode(removed.body, 'CG_ANNUEL', '2026-09')).toEqual([]);
  });

  it('closes October; a later approval comes back in November, adjusted lines are skipped, not doubled after', async () => {
    const oct = (await client('admin').post('/api/payroll/periods/2026-10/close').send({}).expect(200)).body;
    expect(oct).toMatchObject({ status: 'closed', version: 1 });
    expect(oct.totals.find((t: { exportCode: string }) => t.exportCode === 'PRIME_REND')).toMatchObject({ unit: 'amount', total: 15000 });
    const closedView = await variables('admin', '2026-10', E1);
    expect(value(closedView, 'PRIME_REND')).toBe(15000);
    expect(byCode(closedView, 'ABS_NJ')[0]).toMatchObject({ computed: 1, value: 0, adjusted: true });
    expect(byCode(await variables('est', '2026-10', E1), 'PRIME_REND')).toEqual([]);
    // the 0 over a computed value is kept in the snapshot (régularisations know HR overrode it)
    const abs = await query<{ value: string; computed: string }>(
      db.superuserUrl,
      `select l.value::text as value, l.computed_value::text as computed from payroll_line l join payroll_rubrique r on r.id = l.rubrique_id
        where l.employment_id = $1 and r.export_code = 'ABS_NJ' and l.origin_month = '2026-10-01'`,
      [E1],
    );
    expect(abs).toEqual([{ value: '0.00', computed: '1.00' }]);

    await leave(E1, '2026-10-29', '2026-10-29', 'approved');
    clock.value = '2026-11-24';
    const nov = await variables('admin', '2026-11', E1);
    expect(byCode(nov, 'CG_ANNUEL', '2026-10')[0]).toMatchObject({ computed: 1, value: 1 });
    // the October days after the closing became final (absences), but HR set October's ABS_NJ: skipped
    expect(byCode(nov, 'ABS_NJ', '2026-10')).toEqual([]);
    await client('admin').post('/api/payroll/periods/2026-11/close').send({}).expect(200);
    clock.value = '2026-12-22';
    const dec = await variables('admin', '2026-12', E1);
    expect(byCode(dec, 'CG_ANNUEL', '2026-10')).toEqual([]);
    clock.value = '2026-10-24';
  });

  it('records the audit events and shows non-amount adjustments in the employee History', async () => {
    const events = await query<{ type: string; data: Record<string, unknown> }>(
      db.superuserUrl,
      `select type, data from audit.event where company_id = $1 and type like 'payroll.%' order by id`,
      [COMPANY_A],
    );
    expect(events.map((e) => e.type)).toEqual(['payroll.closed', 'payroll.closed', 'payroll.reopened', 'payroll.closed', 'payroll.closed', 'payroll.closed']);
    expect(events[2]?.data).toEqual({ month: '2026-09', version: 1, reason: 'Congé validé en retard' });
    expect(events[1]?.data).toMatchObject({ month: '2026-09', version: 1, lines: expect.any(Number), employees: expect.any(Number) });
    const timeline = (await client('admin').get(`/api/audit/timeline?subject=employee:${E1}&limit=100`).expect(200)).body;
    const tables = JSON.stringify(timeline);
    expect(tables).toContain('payroll_adjustment');
    expect(tables).not.toContain('15000');
  });
});
