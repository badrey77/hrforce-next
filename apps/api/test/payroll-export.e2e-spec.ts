/**
 * The payroll file and the control report (docs/contracts/payroll-variables.md › Endpoints, Export file): a closed
 * month exports its closing with identical bytes, an open month only as a draft, rows limited to the caller's scope,
 * amount lines only for salary readers, the unit filter, the format settings, Windows-1252, the audit events.
 * "Today" is pinned to 2026-10-24 (PayrollClock): September 2026 is closed in beforeAll, October stays open. TEST DATA.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import type request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PayrollClock } from '../src/modules/payroll/index.js';
import { as, COMPANY_A, employeeA, seedAccessFixture, unitA, type ActorName } from './support/access-fixture.js';
import { createTestApp } from './support/test-app.js';
import { createTestDatabase, query, type TestDatabase } from './support/test-database.js';
import { fetchXsrf, type XsrfPair } from './support/xsrf.js';

const TODAY = '2026-10-24';
const CLOSED = '2026-09';
const OPEN = '2026-10';

let db: TestDatabase;
let app: NestExpressApplication;
let xsrf: XsrfPair;
const client = (actor: ActorName) => as(app, actor, xsrf);
const R = { prime: '', panier: '' };
/** HRForce matricules (filled in beforeAll) */
const M = { est: '', ouest: '' };
const EST = () => employeeA(27);
const OUEST = () => employeeA(36);

function binary(res: request.Response, callback: (err: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

async function download(actor: ActorName, path: string, status = 200): Promise<{ body: Buffer; headers: Record<string, string> }> {
  const res = await client(actor).get(path).buffer(true).parse(binary).expect(status);
  return { body: res.body as Buffer, headers: res.headers as Record<string, string> };
}

const latin = (b: Buffer) => b.toString('latin1');
const rows = (text: string) => text.split('\r\n').filter((r) => r !== '');

async function matricule(employmentId: string): Promise<string> {
  return (await query<{ m: string }>(db.superuserUrl, `select matricule as m from employment where id = $1`, [employmentId]))[0]?.m ?? '';
}

beforeAll(async () => {
  db = await createTestDatabase();
  await seedAccessFixture(db, undefined, { leave: true });
  app = await createTestApp(db, { devAuth: true, devPermissions: false, overrides: [{ provide: PayrollClock, useValue: { today: () => TODAY } }] });
  xsrf = await fetchXsrf(app);
  const ids = await query<{ id: string; export_code: string }>(db.superuserUrl, `select id, export_code from payroll_rubrique where company_id = $1 and source = 'manual'`, [COMPANY_A]);
  R.prime = ids.find((r) => r.export_code === 'PRIME_REND')?.id ?? '';
  M.est = await matricule(EST());
  M.ouest = await matricule(OUEST());
  R.panier = ids.find((r) => r.export_code === 'IND_PANIER_J')?.id ?? '';
  // a name with characters Windows-1252 and ISO-8859-1 encode differently (snapshotted at close)
  await query(db.superuserUrl, `update person set last_name = 'Œuvré' where id = (select person_id from employment where id = $1)`, [EST()]);
  await client('admin').put(`/api/payroll/employee-codes/${EST()}`).send({ code: 'PAIE-27' }).expect(200);
  for (const [month, employee, rubriqueId, value] of [
    [CLOSED, EST(), R.prime, 15000.5],
    [CLOSED, EST(), R.panier, 20],
    [CLOSED, OUEST(), R.panier, 18.5],
    [OPEN, EST(), R.panier, 3],
  ] as const) {
    await client('admin').put(`/api/payroll/periods/${month}/variables/${employee}/lines`).send({ rubriqueId, value }).expect(200);
  }
  await client('admin').post(`/api/payroll/periods/${CLOSED}/close`).send({}).expect(200);
  // the code changes after the close: the closed file keeps the snapshot
  await client('admin').put(`/api/payroll/employee-codes/${EST()}`).send({ code: 'PAIE-27B' }).expect(200);
});

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

describe('GET /payroll/periods/:month/export', () => {
  it('exports a closed month in Windows-1252 with its headers; the same bytes on every download', async () => {
    const first = await download('admin', `/api/payroll/periods/${CLOSED}/export`);
    expect(first.headers['content-type']).toBe('text/csv; charset=windows-1252');
    expect(first.headers['content-disposition']).toBe(`attachment; filename="variables-paie-${CLOSED}.csv"`);
    expect(first.headers['cache-control']).toBe('no-store');
    const lines = rows(latin(first.body));
    expect(lines[0]).toBe('matricule;rubrique;valeur;periode');
    expect(lines).toContain('PAIE-27;PRIME_REND;15000,5;09/2026');
    expect(lines).toContain('PAIE-27;IND_PANIER_J;20;09/2026');
    expect(lines).toContain(`${M.ouest};IND_PANIER_J;18,5;09/2026`);
    const again = await download('admin', `/api/payroll/periods/${CLOSED}/export?draft=true`);
    expect(again.body.equals(first.body)).toBe(true);
    expect(again.headers['content-disposition']).toBe(`attachment; filename="variables-paie-${CLOSED}.csv"`);
  });

  it('limits rows to the regional scope and hides amount lines from regional HR', async () => {
    const est = rows(latin((await download('est', `/api/payroll/periods/${CLOSED}/export`)).body));
    expect(est).toContain('PAIE-27;IND_PANIER_J;20;09/2026');
    expect(est.some((l) => l.includes('PRIME_REND'))).toBe(false);
    expect(est.some((l) => l.startsWith(`${M.ouest};`))).toBe(false);
  });

  it('filters by unit (file named after it); a unit outside the scope is 404', async () => {
    const res = await download('admin', `/api/payroll/periods/${CLOSED}/export?unitId=${unitA('REG-EST')}&includeSubUnits=true`);
    expect(res.headers['content-disposition']).toBe(`attachment; filename="variables-paie-${CLOSED}-REG-EST.csv"`);
    const lines = rows(latin(res.body));
    expect(lines.some((l) => l.startsWith('PAIE-27;'))).toBe(true);
    expect(lines.some((l) => l.startsWith(`${M.ouest};`))).toBe(false);
    await download('est', `/api/payroll/periods/${CLOSED}/export?unitId=${unitA('REG-OUEST')}`, 404);
    await download('admin', `/api/payroll/periods/${CLOSED}/export?unitId=0190a5d0-0000-7000-8000-00000000dead`, 404);
  });

  it('refuses an open month unless draft=true (live values, -brouillon); a future or malformed month is 422', async () => {
    const refused = await client('admin').get(`/api/payroll/periods/${OPEN}/export`).expect(409);
    expect(refused.body.type).toContain('payroll-period-open');
    const draft = await download('admin', `/api/payroll/periods/${OPEN}/export?draft=true`);
    expect(draft.headers['content-disposition']).toBe(`attachment; filename="variables-paie-${OPEN}-brouillon.csv"`);
    // the live payroll matricule
    expect(rows(latin(draft.body))).toContain('PAIE-27B;IND_PANIER_J;3;10/2026');
    const future = await client('admin').get('/api/payroll/periods/2026-11/export?draft=true').expect(422);
    expect(future.body.errors[0]).toMatchObject({ field: 'month', code: 'future' });
    const bad = await client('admin').get('/api/payroll/periods/2026-13/export').expect(422);
    expect(bad.body.errors[0]).toMatchObject({ field: 'month', code: 'invalid' });
    await client('ouest').get(`/api/payroll/periods/${CLOSED}/export`).expect(403);
  });

  it('records payroll.exported with the month, unit, draft flag, lines and version', async () => {
    const events = await query<{ data: Record<string, unknown> }>(db.superuserUrl, `select data from audit.event where type = 'payroll.exported' order by id`);
    expect(events[0]?.data).toEqual({ month: CLOSED, unitId: null, draft: false, lines: 3, version: 1 });
    expect(events.some((e) => e.data['draft'] === true && e.data['month'] === OPEN && e.data['version'] === null)).toBe(true);
    expect(events.some((e) => e.data['unitId'] === unitA('REG-EST'))).toBe(true);
  });

  it('follows the format settings: columns, Windows-1252 names, per-employee layout, UTF-8 with BOM, extension', async () => {
    await client('admin').put('/api/payroll/settings').send({ columns: ['matricule', 'last_name', 'rubrique', 'label', 'value', 'unit', 'origin_period'], periodFormat: 'yyyymm', decimalSeparator: 'dot', separator: 'tab' }).expect(200);
    const file = (await download('admin', `/api/payroll/periods/${CLOSED}/export`)).body;
    const text = latin(file);
    expect(rows(text)[0]).toBe('matricule\tnom\trubrique\tlibelle\tvaleur\tunite\tperiode_origine');
    expect(rows(text)).toContain('PAIE-27\t\u008cuvré\tPRIME_REND\tPrime de rendement\t15000.5\tDA\t202609');
    // Œ is 0x8C in Windows-1252 (ISO-8859-1 has no Œ)
    expect(file.includes(Buffer.from([0x8c, 0x75, 0x76, 0x72, 0xe9]))).toBe(true);

    await client('admin').put('/api/payroll/settings').send({ layout: 'per_employee', columns: ['matricule', 'period'], encoding: 'utf8_bom', separator: 'semicolon', decimalSeparator: 'comma', fileExtension: 'txt' }).expect(200);
    const res = await download('admin', `/api/payroll/periods/${CLOSED}/export`);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="variables-paie-${CLOSED}.txt"`);
    expect([...res.body.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const per = rows(res.body.subarray(3).toString('utf8'));
    const header = (per[0] ?? '').split(';');
    expect(header.slice(0, 2)).toEqual(['matricule', 'periode']);
    const prime = header.indexOf('PRIME_REND');
    const panier = header.indexOf('IND_PANIER_J');
    expect(prime).toBeGreaterThan(1);
    const est = (per.find((l) => l.startsWith('PAIE-27;')) ?? '').split(';');
    expect([est[1], est[prime], est[panier]]).toEqual(['202609', '15000,5', '20']);
    await client('admin').put('/api/payroll/settings').send({ layout: 'per_line', columns: ['matricule', 'rubrique', 'value', 'period'], encoding: 'windows1252', fileExtension: 'csv', periodFormat: 'mm_yyyy' }).expect(200);
  });
});

describe('GET /payroll/periods/:month/control.csv', () => {
  it('writes the control report in UTF-8 with BOM, French header, computed and adjusted values', async () => {
    const res = await download('admin', `/api/payroll/periods/${CLOSED}/control.csv`);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="etat-controle-paie-${CLOSED}.csv"`);
    expect([...res.body.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = rows(res.body.subarray(3).toString('utf8'));
    expect(lines[0]).toBe('Matricule;Matricule paie;Nom;Prénom;Unité;Rubrique;Libellé;Période d’origine;Valeur calculée;Valeur;Ajusté;Note');
    const est = lines.filter((l) => l.startsWith(`${M.est};`));
    expect(est.some((l) => l.includes(';PRIME_REND;Prime de rendement;09/2026;;15000,5;Oui;'))).toBe(true);
    expect(est.every((l) => l.split(';')[1] === 'PAIE-27B' && l.split(';')[2] === 'Œuvré')).toBe(true);
    const event = await query<{ data: Record<string, unknown> }>(db.superuserUrl, `select data from audit.event where type = 'payroll.control_exported' order by id desc limit 1`);
    expect(event[0]?.data).toEqual({ month: CLOSED, unitId: null });
  });

  it('writes the Arabic header with lang=ar, hides amount lines from regional HR, refuses lecture', async () => {
    const ar = rows((await download('est', `/api/payroll/periods/${CLOSED}/control.csv?lang=ar`)).body.subarray(3).toString('utf8'));
    expect(ar[0]?.split(';')[0]).toBe('الرقم');
    expect(ar.some((l) => l.includes('PRIME_REND'))).toBe(false);
    expect(ar.some((l) => l.includes('IND_PANIER_J'))).toBe(true);
    expect(ar.some((l) => l.startsWith(`${M.ouest};`))).toBe(false);
    await client('ouest').get(`/api/payroll/periods/${CLOSED}/control.csv`).expect(403);
    await client('admin').get(`/api/payroll/periods/${CLOSED}/control.csv?lang=de`).expect(422);
  });
});
