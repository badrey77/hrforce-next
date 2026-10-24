/**
 * Payroll settings, rubriques and payroll matricules (docs/contracts/payroll-variables.md › Endpoints, Data): the
 * company-wide settings with their column rules and preview, the seeded rubriques, manual rubriques and code
 * collisions, payroll matricules in scope, the database rules of migration 0024 (append-only lines, no deletes,
 * closed-month adjustments) and the two-step list. TEST DATA.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PayrollClock } from '../src/modules/payroll/index.js';
import { assertNoSecrets } from './support/assert-no-secrets.js';
import { as, COMPANY_A, COMPANY_B, employeeA, seedAccessFixture, USERS, type ActorName } from './support/access-fixture.js';
import { createTestApp } from './support/test-app.js';
import { createTestDatabase, query, type TestDatabase } from './support/test-database.js';
import { fetchXsrf, type XsrfPair } from './support/xsrf.js';

const TODAY = '2026-10-24';

let db: TestDatabase;
let app: NestExpressApplication;
let xsrf: XsrfPair;
const client = (actor: ActorName) => as(app, actor, xsrf);
const est = () => employeeA(27);
const ouest = () => employeeA(36);

interface Rubrique {
  id: string;
  source: string;
  leaveType: { id: string; code: string } | null;
  exportCode: string;
  names: { fr: string; ar: string; en: string };
  unit: string;
  active: boolean;
  sortOrder: number;
}

async function policyAuditRows(): Promise<number> {
  return (await query<{ n: number }>(db.superuserUrl, `select count(*)::int as n from audit.change_log where table_name = 'payroll_policy' and company_id = $1`, [COMPANY_A]))[0]?.n ?? 0;
}

async function rubriques(actor: ActorName = 'admin'): Promise<Rubrique[]> {
  return ((await client(actor).get('/api/payroll/rubriques').expect(200)).body as { items: Rubrique[] }).items;
}

beforeAll(async () => {
  db = await createTestDatabase();
  await seedAccessFixture(db, undefined, { leave: true });
  app = await createTestApp(db, { devAuth: true, devPermissions: false, overrides: [{ provide: PayrollClock, useValue: { today: () => TODAY } }] });
  xsrf = await fetchXsrf(app);
});

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

describe('settings', () => {
  it('answers the defaults for a company without a policy row, company-wide only', async () => {
    const res = await client('beta').get('/api/payroll/settings').expect(200);
    expect(res.body).toEqual({
      cutoffDay: 20, regularizationMonths: 3, overtimeMinMinutes: 30, layout: 'per_line', separator: 'semicolon', decimalSeparator: 'comma',
      encoding: 'windows1252', headerRow: true, columns: ['matricule', 'rubrique', 'value', 'period'], periodFormat: 'mm_yyyy', fileExtension: 'csv',
    });
    await client('est').get('/api/payroll/settings').expect(403);
    await client('ouest').put('/api/payroll/settings').send({ cutoffDay: 10 }).expect(403);
  });

  it('saves a partial change, audited, and an unchanged save writes nothing', async () => {
    const res = await client('admin').put('/api/payroll/settings').send({ cutoffDay: 18, separator: 'pipe', columns: ['matricule', 'last_name', 'rubrique', 'value', 'period'] }).expect(200);
    expect(res.body).toMatchObject({ cutoffDay: 18, separator: 'pipe', encoding: 'windows1252', columns: ['matricule', 'last_name', 'rubrique', 'value', 'period'] });
    const before = await policyAuditRows();
    expect(before).toBeGreaterThan(0);
    await client('admin').put('/api/payroll/settings').send({ cutoffDay: 18 }).expect(200);
    expect(await policyAuditRows()).toBe(before);
  });

  it('refuses columns that do not suit the layout (422 columns invalid) and out-of-range values', async () => {
    const missing = await client('admin').put('/api/payroll/settings').send({ columns: ['matricule', 'value'] }).expect(422);
    expect(missing.body.errors).toEqual([expect.objectContaining({ field: 'columns', code: 'invalid' })]);
    const dup = await client('admin').put('/api/payroll/settings').send({ columns: ['matricule', 'rubrique', 'value', 'value'] }).expect(422);
    expect(dup.body.errors[0]).toMatchObject({ field: 'columns', code: 'invalid' });
    // per_employee: identity columns only
    const wrong = await client('admin').put('/api/payroll/settings').send({ layout: 'per_employee' }).expect(422);
    expect(wrong.body.errors[0]).toMatchObject({ field: 'columns', code: 'invalid' });
    await client('admin').put('/api/payroll/settings').send({ layout: 'per_employee', columns: ['matricule', 'last_name', 'period'] }).expect(200);
    await client('admin').put('/api/payroll/settings').send({ columns: ['matricule', 'salary'] }).expect(422);
    await client('admin').put('/api/payroll/settings').send({ cutoffDay: 29 }).expect(422);
    await client('admin').put('/api/payroll/settings').send({ regularizationMonths: -1 }).expect(422);
    await client('admin').put('/api/payroll/settings').send({ encoding: 'latin1' }).expect(422);
    await client('admin').put('/api/payroll/settings').send({ unknown: 1 }).expect(422);
    // back to the line layout for the other tests
    await client('admin').put('/api/payroll/settings').send({ layout: 'per_line', columns: ['matricule', 'rubrique', 'value', 'period'], separator: 'semicolon' }).expect(200);
  });

  it('previews the first rows of a file with the current settings', async () => {
    const res = await client('admin').get('/api/payroll/settings/preview').expect(200);
    expect(res.body).toMatchObject({ filename: 'variables-paie-2026-10-brouillon.csv', encoding: 'windows1252' });
    const rows = (res.body.sample as string).split('\r\n');
    expect(rows[0]).toBe('matricule;rubrique;valeur;periode');
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.length).toBeLessThanOrEqual(5);
    for (const row of rows.slice(1)) expect(row).toMatch(/^[^;]+;[^;]+;-?\d+(,\d{1,2})?;10\/2026$/);
    await client('est').get('/api/payroll/settings/preview').expect(403);
  });
});

describe('rubriques', () => {
  it('lists the seeded rubriques: one per leave type, the computed sources, active first', async () => {
    const items = await rubriques('est');
    assertNoSecrets(items);
    const byCode = new Map(items.map((r) => [r.exportCode, r]));
    expect(byCode.get('CG_ANNUEL')).toMatchObject({ source: 'leave', unit: 'days', active: true, leaveType: expect.objectContaining({ code: 'annual' }) });
    expect(byCode.get('CG_RECUP')).toMatchObject({ source: 'leave', active: false });
    expect(byCode.get('ABS_NJ')).toMatchObject({ source: 'absence', unit: 'days', active: true });
    expect(byCode.get('JRS_PRES')).toMatchObject({ source: 'service_days', active: true });
    for (const code of ['RETARD', 'HS50', 'HS75', 'HS100']) expect(byCode.get(code)).toMatchObject({ unit: 'hours', active: false });
    expect(byCode.get('PRIME_REND')).toMatchObject({ source: 'manual', unit: 'amount', active: true });
    expect(byCode.get('IND_PANIER_J')).toMatchObject({ source: 'manual', unit: 'days' });
    const firstInactive = items.findIndex((r) => !r.active);
    expect(items.slice(firstInactive).every((r) => !r.active)).toBe(true);
    // BETA has its own computed rubriques and none of DEMO's
    const beta = await rubriques('beta');
    expect(beta.some((r) => r.exportCode === 'PRIME_REND')).toBe(false);
    expect(beta.some((r) => r.exportCode === 'ABS_NJ')).toBe(true);
    await client('ouest').get('/api/payroll/rubriques').expect(403);
  });

  it('creates a manual rubrique (201), refuses a taken code (409, case-insensitive) unless the other is inactive', async () => {
    const created = await client('admin').post('/api/payroll/rubriques').send({ exportCode: 'IND_TRANSP', names: { fr: 'Indemnité de transport', ar: 'منحة النقل', en: 'Transport allowance' }, unit: 'amount' }).expect(201);
    expect(created.body).toMatchObject({ source: 'manual', exportCode: 'IND_TRANSP', unit: 'amount', active: true, leaveType: null });
    const taken = await client('admin').post('/api/payroll/rubriques').send({ exportCode: 'abs_nj', names: { fr: 'X', ar: 'X', en: 'X' }, unit: 'days' }).expect(409);
    expect(taken.body.type).toContain('payroll-code-taken');
    // RETARD is inactive: its code may be reused by an active rubrique, and reactivating RETARD then collides
    const reuse = await client('admin').post('/api/payroll/rubriques').send({ exportCode: 'RETARD', names: { fr: 'Retenue', ar: 'اقتطاع', en: 'Deduction' }, unit: 'amount' }).expect(201);
    const retard = (await rubriques()).find((r) => r.exportCode === 'RETARD' && r.source === 'late') as Rubrique;
    await client('admin').put(`/api/payroll/rubriques/${retard.id}`).send({ active: true }).expect(409);
    await client('admin').put(`/api/payroll/rubriques/${reuse.body.id}`).send({ exportCode: 'RETENUE' }).expect(200);
    await client('admin').put(`/api/payroll/rubriques/${retard.id}`).send({ active: true }).expect(200);
    await client('admin').post('/api/payroll/rubriques').send({ exportCode: 'BAD CODE', names: { fr: 'X', ar: 'X', en: 'X' }, unit: 'days' }).expect(422);
    await client('admin').post('/api/payroll/rubriques').send({ exportCode: 'A'.repeat(21), names: { fr: 'X', ar: 'X', en: 'X' }, unit: 'days' }).expect(422);
    await client('est').post('/api/payroll/rubriques').send({ exportCode: 'EST', names: { fr: 'X', ar: 'X', en: 'X' }, unit: 'days' }).expect(403);
  });

  it('updates codes, names, order and activity; the unit of a computed rubrique is fixed', async () => {
    const abs = (await rubriques()).find((r) => r.exportCode === 'ABS_NJ') as Rubrique;
    const res = await client('admin').put(`/api/payroll/rubriques/${abs.id}`).send({ exportCode: 'ABS-NJ.1', names: { fr: 'Absence', ar: 'غياب', en: 'Absence' }, sortOrder: 5 }).expect(200);
    expect(res.body).toMatchObject({ exportCode: 'ABS-NJ.1', sortOrder: 5, unit: 'days', source: 'absence' });
    const fixed = await client('admin').put(`/api/payroll/rubriques/${abs.id}`).send({ unit: 'amount' }).expect(422);
    expect(fixed.body.errors[0]).toMatchObject({ field: 'unit', code: 'fixed' });
    await client('admin').put(`/api/payroll/rubriques/${abs.id}`).send({ exportCode: 'ABS_NJ', sortOrder: 500 }).expect(200);
    const panier = (await rubriques()).find((r) => r.exportCode === 'IND_PANIER_J') as Rubrique;
    await client('admin').put(`/api/payroll/rubriques/${panier.id}`).send({ unit: 'hours' }).expect(200);
    await client('admin').put(`/api/payroll/rubriques/${panier.id}`).send({ unit: 'days', active: false }).expect(200);
    await client('admin').put('/api/payroll/rubriques/not-a-uuid').send({ active: true }).expect(404);
    await client('admin').put('/api/payroll/rubriques/0190a5d0-0000-7000-8000-00000000dead').send({ active: true }).expect(404);
    // another company's rubrique
    const betaAbs = (await rubriques('beta')).find((r) => r.exportCode === 'ABS_NJ') as Rubrique;
    await client('admin').put(`/api/payroll/rubriques/${betaAbs.id}`).send({ active: false }).expect(404);
  });
});

describe('payroll matricules', () => {
  it('sets, changes and removes an employee payroll matricule in scope', async () => {
    const res = await client('est').put(`/api/payroll/employee-codes/${est()}`).send({ code: 'P-1027' }).expect(200);
    expect(res.body).toEqual({ employeeId: est(), code: 'P-1027' });
    await client('est').put(`/api/payroll/employee-codes/${est()}`).send({ code: 'P-2027' }).expect(200);
    const rows = await query<{ code: string; updated_by: string }>(db.superuserUrl, `select code, updated_by from payroll_employee_code where employment_id = $1`, [est()]);
    expect(rows).toEqual([{ code: 'P-2027', updated_by: USERS.est.id }]);
    const removed = await client('est').put(`/api/payroll/employee-codes/${est()}`).send({ code: null }).expect(200);
    expect(removed.body).toEqual({ employeeId: est(), code: null });
    await client('est').put(`/api/payroll/employee-codes/${est()}`).send({ code: '' }).expect(200);
    const audit = await query<{ n: number }>(db.superuserUrl, `select count(*)::int as n from audit.change_log where table_name = 'payroll_employee_code'`);
    expect(audit[0]?.n).toBeGreaterThanOrEqual(3);
  });

  it('refuses a code another employee has (409, case-insensitive), an invalid code (422), out of scope (404)', async () => {
    await client('admin').put(`/api/payroll/employee-codes/${ouest()}`).send({ code: 'PAIE-36' }).expect(200);
    const taken = await client('admin').put(`/api/payroll/employee-codes/${est()}`).send({ code: 'paie-36' }).expect(409);
    expect(taken.body.type).toContain('payroll-matricule-taken');
    await client('admin').put(`/api/payroll/employee-codes/${est()}`).send({ code: 'a b' }).expect(422);
    await client('admin').put(`/api/payroll/employee-codes/${est()}`).send({}).expect(422);
    await client('est').put(`/api/payroll/employee-codes/${ouest()}`).send({ code: 'X1' }).expect(404);
    await client('ouest').put(`/api/payroll/employee-codes/${ouest()}`).send({ code: 'X1' }).expect(403);
    await client('beta').put(`/api/payroll/employee-codes/${est()}`).send({ code: 'X1' }).expect(404);
    await client('admin').put('/api/payroll/employee-codes/nope').send({ code: 'X1' }).expect(404);
  });
});

describe('migration 0024', () => {
  it('puts payroll.close in the two-step list of the defaults and of every existing policy', async () => {
    const defaults = await query<{ list: string[] }>(db.superuserUrl, `select public.security_policy_default_permissions() as list`);
    expect(defaults[0]?.list).toContain('payroll.close');
    expect(defaults[0]?.list).not.toContain('payroll.configure');
    const perms = await query<{ code: string; group_code: string }>(db.superuserUrl, `select code, group_code from permission where code like 'payroll.%' order by sort_order`);
    expect(perms.map((p) => p.code)).toEqual(['payroll.read', 'payroll.prepare', 'payroll.export', 'payroll.close', 'payroll.configure']);
    expect(new Set(perms.map((p) => p.group_code))).toEqual(new Set(['payroll']));
  });

  it('gives the app role no delete on rubriques, closings, periods and policies, no update/delete on lines', async () => {
    const rows = await query<{ table_name: string; privilege_type: string }>(
      db.superuserUrl,
      `select table_name, privilege_type from information_schema.role_table_grants
        where grantee = 'hrforce_app' and table_name like 'payroll\\_%' order by 1, 2`,
    );
    const has = (t: string, p: string) => rows.some((r) => r.table_name === t && r.privilege_type === p);
    for (const t of ['payroll_rubrique', 'payroll_closing', 'payroll_period', 'payroll_policy', 'payroll_line']) expect(has(t, 'DELETE'), t).toBe(false);
    expect(has('payroll_line', 'UPDATE')).toBe(false);
    expect(has('payroll_line', 'INSERT')).toBe(true);
    expect(has('payroll_adjustment', 'DELETE')).toBe(true);
    expect(has('payroll_employee_code', 'DELETE')).toBe(true);
    const worker = await query<{ privilege_type: string }>(
      db.superuserUrl,
      `select privilege_type from information_schema.role_table_grants where grantee = 'hrforce_worker' and table_name like 'payroll\\_%' and privilege_type <> 'SELECT'`,
    );
    expect(worker).toEqual([]);
  });

  it('refuses adjustments of a closed month and keeps closings and lines immutable', async () => {
    const [rub] = await query<{ id: string }>(db.superuserUrl, `select id from payroll_rubrique where company_id = $1 and export_code = 'PRIME_REND'`, [COMPANY_A]);
    const e = employeeA(27);
    const [period] = await query<{ id: string }>(db.superuserUrl, `insert into payroll_period (company_id, month, status) values ($1, '2026-08-01', 'open') returning id`, [COMPANY_A]);
    await query(db.superuserUrl, `insert into payroll_adjustment (company_id, month, origin_month, employment_id, rubrique_id, value, updated_by) values ($1, '2026-08-01', '2026-08-01', $2, $3, 5000, $4)`, [COMPANY_A, e, rub?.id, USERS.admin.id]);
    await query(db.superuserUrl, `update payroll_period set status = 'closed' where id = $1`, [period?.id]);
    await expect(query(db.superuserUrl, `update payroll_adjustment set value = 1 where month = '2026-08-01'`)).rejects.toThrow(/closed/);
    await expect(query(db.superuserUrl, `delete from payroll_adjustment where month = '2026-08-01'`)).rejects.toThrow(/closed/);
    await expect(query(db.superuserUrl, `update payroll_period set month = '2026-07-01' where id = $1`, [period?.id])).rejects.toThrow(/never change/);
    const [closing] = await query<{ id: string }>(db.superuserUrl, `insert into payroll_closing (company_id, period_id, version, closed_by, lines, employees) values ($1, $2, 1, $3, 1, 1) returning id`, [COMPANY_A, period?.id, USERS.admin.id]);
    await expect(query(db.superuserUrl, `insert into payroll_closing (company_id, period_id, version, closed_by, lines, employees) values ($1, $2, 2, $3, 0, 0)`, [COMPANY_A, period?.id, USERS.admin.id])).rejects.toThrow(/payroll_closing_current_uk/);
    await expect(query(db.superuserUrl, `update payroll_closing set lines = 2 where id = $1`, [closing?.id])).rejects.toThrow(/only a reopening/);
    await expect(query(db.superuserUrl, `update payroll_closing set reopened_at = now(), reopened_by = $2, reopen_reason = 'x' where id = $1`, [closing?.id, USERS.admin.id])).rejects.toThrow(/payroll_closing_reopen_ck/);
    await query(db.superuserUrl, `update payroll_closing set reopened_at = now(), reopened_by = $2, reopen_reason = 'Erreur de saisie' where id = $1`, [closing?.id, USERS.admin.id]);
    await expect(query(db.superuserUrl, `update payroll_closing set reopen_reason = 'Autre raison' where id = $1`, [closing?.id])).rejects.toThrow(/only a reopening/);
    await expect(
      query(db.superuserUrl, `insert into payroll_line (company_id, closing_id, employment_id, rubrique_id, origin_month, value, adjusted, export_code, unit, matricule, last_name, first_name) values ($1, $2, $3, $4, '2026-08-01', 0, false, 'X', 'amount', 'M', 'N', 'P')`, [COMPANY_A, closing?.id, e, rub?.id]),
    ).rejects.toThrow(/not being written in this transaction/);
    // a month is stored as its first day; a rubrique keeps its source
    await expect(query(db.superuserUrl, `insert into payroll_period (company_id, month) values ($1, '2026-09-02')`, [COMPANY_A])).rejects.toThrow(/payroll_period_month_ck/);
    await expect(query(db.superuserUrl, `update payroll_rubrique set source = 'absence' where id = $1`, [rub?.id])).rejects.toThrow(/never change/);
    // a computed rubrique cannot be counted in amounts
    await expect(query(db.superuserUrl, `insert into payroll_rubrique (company_id, source, export_code, name_fr, name_ar, name_en, unit) values ($1, 'late', 'X2', 'x', 'x', 'x', 'amount')`, [COMPANY_B])).rejects.toThrow(/payroll_rubrique_source_unit_ck|payroll_rubrique_source_uk/);
  });
});
