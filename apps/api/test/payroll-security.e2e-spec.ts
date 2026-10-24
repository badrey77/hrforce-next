/**
 * Payroll variables — security probes of the independent verification (docs/contracts/payroll-variables.md ›
 * "Settled by the verification (gate and security)"): regional scope of reads, writes, filters and files; amount lines
 * never reaching callers without employee.salary.read (variables, period totals, files, History, the audit log);
 * close / reopen company-wide and behind two-step sign-in; closed months refusing writes through the API and directly
 * through the app role; a close racing adjustments; export bytes, quoting, formula guard and Windows-1252; XSRF,
 * anonymous, other company, malformed inputs. "Today" is pinned to 2026-10-24 (PayrollClock). TEST DATA — fictitious.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PayrollClock } from '../src/modules/payroll/index.js';
import { as, COMPANY_A, COMPANY_B, EMPLOYEE_B, employeeA, seedAccessFixture, unitA, unitB, USERS, type ActorName } from './support/access-fixture.js';
import { assertNoSecrets } from './support/assert-no-secrets.js';
import { createTestApp } from './support/test-app.js';
import { createTestDatabase, query, type TestDatabase } from './support/test-database.js';
import { fetchXsrf, type XsrfPair } from './support/xsrf.js';

const TODAY = '2026-10-24';
const CLOSED = '2026-09';
const OPEN = '2026-10';
const PROBLEM = 'urn:hrforce:problem:';

let db: TestDatabase;
let app: NestExpressApplication;
let xsrf: XsrfPair;
const client = (actor: ActorName | null) => as(app, actor, xsrf);
const slug = (body: { type?: string }) => (body.type ?? '').replace(PROBLEM, '');

/** EMP-0027 (Constantine, Est): the bonus, the hostile names */
const EST = employeeA(27);
/** EMP-0026 (Est): Arabic-only names */
const EST_AR = employeeA(26);
/** EMP-0028 (Est): only an advance in the closed month */
const EST_ADVANCE = employeeA(28);
/** EMP-0036 (Oran, Ouest) */
const OUEST = employeeA(36);
const R = { prime: '', avance: '', panier: '', beta: '' };
const M = { ouest: '' };
const BONUS = 15432.5;
const ADVANCE = 4321;

/** Header identity, without the XSRF token. */
const dev = (r: request.Test, actor: ActorName = 'admin') => r.set('X-Dev-User-Id', USERS[actor].id).set('X-Dev-Company-Id', actor === 'beta' ? COMPANY_B : COMPANY_A);
/** Statements as `role` inside DEMO's company context, in one transaction. */
const asRole = (url: string, sqlText: string, params: unknown[] = []) =>
  query(url, `begin; select set_config('app.company_id', '${COMPANY_A}', true); ${sqlText}; commit;`, params);

function binary(res: request.Response, callback: (err: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}
async function download(actor: ActorName, path: string, status = 200): Promise<Buffer> {
  const res = await client(actor).get(path).buffer(true).parse(binary);
  expect(res.status, `${path}: ${res.body.toString()}`).toBe(status);
  return res.body as Buffer;
}
const cp1252 = new TextDecoder('windows-1252');
const BOM = String.fromCodePoint(0xfeff);

const line = (actor: ActorName, month: string, employeeId: string, body: Record<string, unknown>) => client(actor).put(`/api/payroll/periods/${month}/variables/${employeeId}/lines`).send(body);

/** A custom role with `permissions` granted to `userId` on `unitId` (+ sub-units). */
async function grant(userId: string, code: string, permissions: string[], unitId: string): Promise<void> {
  const [role] = await query<{ id: string }>(db.superuserUrl, `insert into role (company_id, code, name_fr, name_ar, name_en) values ($1, $2, 'Sonde', 'مسبار', 'Probe') returning id`, [COMPANY_A, code]);
  for (const p of permissions) await query(db.superuserUrl, 'insert into role_permission (company_id, role_id, permission_code) values ($1, $2, $3)', [COMPANY_A, role?.id, p]);
  await query(db.superuserUrl, `insert into role_grant (company_id, user_id, role_id, org_unit_id, valid_from, include_descendants) values ($1, $2, $3, $4, '2026-01-01', true)`, [COMPANY_A, userId, role?.id, unitId]);
}

/** No amount (value, code) in a response or file. */
function noAmounts(text: string): void {
  expect(text).not.toContain('15432');
  expect(text).not.toContain('4321');
  expect(text).not.toContain('PRIME_REND');
  expect(text).not.toContain('AVANCE');
}

// one transaction, rolled back: a closed July, its closing and one line
const zeroLine = (computed: string, adjusted: boolean) =>
  query(
    db.superuserUrl,
    `begin;
     with p as (insert into payroll_period (company_id, month, status) values ('${COMPANY_A}', '2026-07-01', 'closed') returning id),
          c as (insert into payroll_closing (company_id, period_id, version, closed_by, lines, employees) select '${COMPANY_A}', p.id, 1, '${USERS.admin.id}', 1, 1 from p returning id)
     insert into payroll_line (company_id, closing_id, employment_id, rubrique_id, origin_month, computed_value, value, adjusted, export_code, unit, matricule, last_name, first_name)
     select '${COMPANY_A}', c.id, '${EST}', '${R.panier}', '2026-07-01', ${computed}, 0, ${adjusted}, 'IND_PANIER_J', 'days', 'M', 'N', 'P' from c;
     rollback;`,
  );

beforeAll(async () => {
  db = await createTestDatabase();
  await seedAccessFixture(db, undefined, { leave: true });
  app = await createTestApp(db, { devAuth: true, devPermissions: false, overrides: [{ provide: PayrollClock, useValue: { today: () => TODAY } }] });
  xsrf = await fetchXsrf(app);
  const ids = await query<{ id: string; code: string }>(db.superuserUrl, `select id, export_code as code from payroll_rubrique where company_id = $1`, [COMPANY_A]);
  const of = (code: string) => ids.find((r) => r.code === code)?.id ?? '';
  Object.assign(R, { prime: of('PRIME_REND'), avance: of('AVANCE'), panier: of('IND_PANIER_J') });
  R.beta = (await query<{ id: string }>(db.superuserUrl, `select id from payroll_rubrique where company_id = $1 limit 1`, [COMPANY_B]))[0]?.id ?? '';
  M.ouest = (await query<{ m: string }>(db.superuserUrl, 'select matricule as m from employment where id = $1', [OUEST]))[0]?.m ?? '';
  // hostile names (snapshotted at close): a formula, the separator and quotes, Windows-1252 letters; Arabic-only names
  await query(db.superuserUrl, `update person set last_name = '=HYPERLINK("x")', first_name = 'Jean; "Le" Œuf’€' where id = (select person_id from employment where id = $1)`, [EST]);
  await query(db.superuserUrl, `update person set last_name = 'بن علي', first_name = 'سارة' where id = (select person_id from employment where id = $1)`, [EST_AR]);
  await client('admin').put('/api/payroll/settings').send({ columns: ['matricule', 'last_name', 'first_name', 'rubrique', 'label', 'value', 'period'] }).expect(200);
  for (const [month, employee, rubriqueId, value, note] of [
    [CLOSED, EST, R.prime, BONUS, 'Prime T3'],
    [CLOSED, EST, R.panier, 7, '=1+1'],
    [CLOSED, EST_AR, R.panier, 5, null],
    [CLOSED, EST_ADVANCE, R.avance, ADVANCE, null],
    [CLOSED, OUEST, R.panier, 9, null],
    [OPEN, EST, R.prime, BONUS, null],
    [OPEN, EST, R.panier, 2, null],
  ] as const) {
    const res = await line('admin', month, employee, { rubriqueId, value, note });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }
  await client('admin').post(`/api/payroll/periods/${CLOSED}/close`).send({}).expect(200);
});

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

interface Variables {
  employee: { id: string; matricule: string };
  lines: { rubriqueId: string; exportCode: string; value: number; unit: string }[];
}
const list = async (actor: ActorName, month: string, qs = '') => (await client(actor).get(`/api/payroll/periods/${month}/variables?pageSize=100${qs}`).expect(200)).body as { items: Variables[]; total: number };

describe('regional HR stays in its region (and nobody leaves the company)', () => {
  it('filters by unitId / q of another region or company give nothing; reads of an Ouest or BETA employee are 404', async () => {
    for (const month of [OPEN, CLOSED]) {
      expect((await list('admin', month, `&q=${encodeURIComponent(M.ouest)}`)).items.map((i) => i.employee.id)).toEqual([OUEST]);
      expect((await list('est', month, `&q=${encodeURIComponent(M.ouest)}`)).total).toBe(0);
      expect((await list('est', month, `&unitId=${unitA('REG-OUEST')}`)).total).toBe(0);
      expect((await list('est', month, `&unitId=${unitA('AG-ORAN')}&includeSubUnits=false`)).total).toBe(0);
      expect((await list('admin', month, `&unitId=${unitB('BETA-DG')}`)).total).toBe(0);
      expect((await list('est', month)).items.some((i) => i.employee.id === OUEST)).toBe(false);
      await client('est').get(`/api/payroll/periods/${month}/variables/${OUEST}`).expect(404);
      await client('admin').get(`/api/payroll/periods/${month}/variables/${EMPLOYEE_B.employmentId}`).expect(404);
    }
    // the BETA admin sees nothing of DEMO
    expect((await list('beta', OPEN)).items.some((i) => i.employee.id === EST)).toBe(false);
    await client('beta').get(`/api/payroll/periods/${OPEN}/variables/${EST}`).expect(404);
  });

  it('writes on an Ouest or BETA employee are 404 and change nothing', async () => {
    const before = await query(db.superuserUrl, 'select id, value::text from payroll_adjustment order by id');
    expect((await line('est', OPEN, OUEST, { rubriqueId: R.panier, value: 1 })).status).toBe(404);
    expect((await client('est').delete(`/api/payroll/periods/${OPEN}/variables/${OUEST}/lines/${R.panier}`)).status).toBe(404);
    expect((await client('est').put(`/api/payroll/employee-codes/${OUEST}`).send({ code: 'PAIE-X' })).status).toBe(404);
    expect((await line('admin', OPEN, EMPLOYEE_B.employmentId, { rubriqueId: R.panier, value: 1 })).status).toBe(404);
    expect((await client('admin').put(`/api/payroll/employee-codes/${EMPLOYEE_B.employmentId}`).send({ code: 'PAIE-X' })).status).toBe(404);
    expect((await line('beta', OPEN, EST, { rubriqueId: R.beta, value: 1 })).status).toBe(404);
    expect(await query(db.superuserUrl, 'select id, value::text from payroll_adjustment order by id')).toEqual(before);
    expect(await query(db.superuserUrl, `select 1 from payroll_employee_code where code = 'PAIE-X'`)).toHaveLength(0);
  });

  it("another company's rubrique ids: 422 on PUT (unknown), 404 on DELETE and on the settings", async () => {
    const put = await line('admin', OPEN, EST, { rubriqueId: R.beta, value: 1 });
    expect([put.status, put.body.errors?.[0]?.field]).toEqual([422, 'rubriqueId']);
    expect((await client('admin').delete(`/api/payroll/periods/${OPEN}/variables/${EST}/lines/${R.beta}`)).status).toBe(404);
    expect((await client('admin').put(`/api/payroll/rubriques/${R.beta}`).send({ active: false })).status).toBe(404);
    expect(await query(db.superuserUrl, 'select active from payroll_rubrique where id = $1', [R.beta])).toEqual([{ active: true }]);
  });

  it('the files: an Ouest or BETA unit filter is 404; the Est file holds Est rows only', async () => {
    for (const path of [`/api/payroll/periods/${CLOSED}/export`, `/api/payroll/periods/${CLOSED}/control.csv`, `/api/payroll/periods/${OPEN}/export?draft=true`]) {
      const sep = path.includes('?') ? '&' : '?';
      await download('est', `${path}${sep}unitId=${unitA('REG-OUEST')}`, 404);
      await download('admin', `${path}${sep}unitId=${unitB('BETA-DG')}`, 404);
      const text = cp1252.decode(await download('est', path));
      expect(text).not.toContain(M.ouest);
      expect(text).toContain('EMP-0027');
    }
  });
});

describe('amount lines never reach a caller without employee.salary.read', () => {
  it('variables, one employee, the rubrique filter and the period totals', async () => {
    for (const month of [OPEN, CLOSED]) {
      noAmounts(JSON.stringify(await list('est', month)));
      noAmounts(JSON.stringify((await client('est').get(`/api/payroll/periods/${month}/variables/${EST}`).expect(200)).body));
      noAmounts(JSON.stringify((await client('est').get(`/api/payroll/periods/${month}`).expect(200)).body));
      expect((await list('est', month, `&rubriqueId=${R.prime}`)).total).toBe(0);
      // central HR sees them
      expect(JSON.stringify((await client('admin').get(`/api/payroll/periods/${month}/variables/${EST}`).expect(200)).body)).toContain('15432.5');
    }
  });

  it('a closed month does not list an employee whose only line is an amount (it would tell they had one)', async () => {
    const snap = await query<{ code: string }>(
      db.superuserUrl,
      `select l.export_code as code from payroll_line l join payroll_closing c on c.id = l.closing_id join payroll_period p on p.id = c.period_id
        where p.month = '2026-09-01' and l.employment_id = $1`,
      [EST_ADVANCE],
    );
    expect(snap).toEqual([{ code: 'AVANCE' }]);
    expect((await list('admin', CLOSED)).items.some((i) => i.employee.id === EST_ADVANCE)).toBe(true);
    expect((await list('est', CLOSED)).items.some((i) => i.employee.id === EST_ADVANCE)).toBe(false);
    expect((await list('est', CLOSED, '&filter=adjusted')).items.some((i) => i.employee.id === EST_ADVANCE)).toBe(false);
  });

  it('the payroll file, the draft and the control report', async () => {
    for (const path of [`/api/payroll/periods/${CLOSED}/export`, `/api/payroll/periods/${OPEN}/export?draft=true`]) noAmounts(cp1252.decode(await download('est', path)));
    for (const path of [`/api/payroll/periods/${CLOSED}/control.csv`, `/api/payroll/periods/${OPEN}/control.csv?lang=ar`]) noAmounts((await download('est', path)).toString('utf8'));
    expect(cp1252.decode(await download('admin', `/api/payroll/periods/${CLOSED}/export`))).toContain('PRIME_REND');
  });

  it('the employee History (audit.read: admin_acces, central HR) and the audit log itself', async () => {
    for (const actor of ['acces', 'admin'] as const) {
      const timeline = (await client(actor).get(`/api/audit/timeline?subject=employee:${EST}&limit=100`).expect(200)).body;
      const text = JSON.stringify(timeline);
      expect(text).toContain('payroll_adjustment');
      expect(text).not.toContain('15432');
      // the day value of IND_PANIER_J is masked too (the audit masks per column)
      const changes = (timeline.items as { table?: string; changes?: { field: string; after: unknown; masked: boolean }[] }[]).flatMap((i) => i.changes ?? []);
      expect(changes.filter((c) => c.field === 'value').every((c) => c.masked && c.after === '***')).toBe(true);
    }
    // stored masked: nothing in audit.change_log holds an amount (adjustments and the closed snapshot)
    const rows = await query<{ t: string; before: unknown; after: unknown }>(db.superuserUrl, `select table_name as t, before, after from audit.change_log where table_name in ('payroll_adjustment', 'payroll_line')`);
    expect(rows.length).toBeGreaterThan(5);
    const stored = JSON.stringify(rows);
    expect(stored).not.toContain('15432');
    expect(stored).not.toContain('4321');
    expect(rows.every((r) => [r.before, r.after].every((img) => img === null || ['value', 'computed_value'].every((k) => !(k in (img as object)) || [null, '***'].includes((img as Record<string, unknown>)[k] as never))))).toBe(true);
  });
});

describe('close and reopen', () => {
  it('a regional payroll.close is 403 forbidden-scope; without it 403', async () => {
    await grant(USERS.target.id, 'probe_pay_est', ['payroll.read', 'payroll.close'], unitA('REG-EST'));
    for (const path of [`/api/payroll/periods/${OPEN}/close`, `/api/payroll/periods/${CLOSED}/reopen`]) {
      const res = await client('target').post(path).send(path.endsWith('reopen') ? { reason: 'Erreur de saisie' } : {});
      expect([res.status, slug(res.body)]).toEqual([403, 'forbidden-scope']);
      expect((await client('est').post(path).send({ reason: 'Erreur de saisie' })).status).toBe(403);
    }
  });

  it('with two-step sign-in enforced, a company-wide payroll.close holder without a factor is sent to enrol', async () => {
    await grant(USERS.newbie.id, 'probe_pay_dg', ['payroll.read', 'payroll.close'], unitA('DG'));
    const [policy] = await query<{ codes: string[] }>(db.superuserUrl, 'select public.security_policy_default_permissions() as codes');
    expect(policy?.codes).toContain('payroll.close');
    await query(db.superuserUrl, `insert into security_policy (company_id, mfa_enforced, mfa_required_permissions) values ($1, true, public.security_policy_default_permissions())
                                  on conflict (company_id) do update set mfa_enforced = true, mfa_required_permissions = excluded.mfa_required_permissions`, [COMPANY_A]);
    try {
      const res = await client('newbie').post(`/api/payroll/periods/${OPEN}/close`).send({});
      expect([res.status, slug(res.body)]).toEqual([403, 'mfa-enrollment-required']);
      expect(await query(db.superuserUrl, `select status from payroll_period where company_id = $1 and month = '2026-10-01'`, [COMPANY_A])).not.toEqual([{ status: 'closed' }]);
    } finally {
      await query(db.superuserUrl, 'update security_policy set mfa_enforced = false where company_id = $1', [COMPANY_A]);
    }
  });
});

describe('a closed month refuses writes, down to the database', () => {
  it('through the API: 409 on PUT and DELETE of a line', async () => {
    expect(slug((await line('admin', CLOSED, EST, { rubriqueId: R.panier, value: 1 })).body)).toBe('payroll-period-closed');
    expect(slug((await client('admin').delete(`/api/payroll/periods/${CLOSED}/variables/${EST}/lines/${R.panier}`)).body)).toBe('payroll-period-closed');
  });

  it('directly as hrforce_app: adjustments, lines, closings, periods, rubriques', async () => {
    const appRole = db.appUrl;
    await expect(asRole(appRole, `update payroll_adjustment set value = 1 where month = '2026-09-01'`)).rejects.toThrow(/closed/);
    await expect(asRole(appRole, `delete from payroll_adjustment where month = '2026-09-01'`)).rejects.toThrow(/closed/);
    await expect(
      asRole(appRole, `insert into payroll_adjustment (company_id, month, origin_month, employment_id, rubrique_id, value, updated_by) values ('${COMPANY_A}', '2026-09-01', '2026-09-01', '${EST_AR}', '${R.prime}', 99, '${USERS.admin.id}')`),
    ).rejects.toThrow(/closed/);
    // moving an open adjustment into the closed month
    await expect(asRole(appRole, `update payroll_adjustment set month = '2026-09-01', origin_month = '2026-09-01' where month = '2026-10-01'`)).rejects.toThrow(/closed/);
    const [closing] = await query<{ id: string }>(db.superuserUrl, `select c.id from payroll_closing c join payroll_period p on p.id = c.period_id where p.month = '2026-09-01' and c.reopened_at is null`);
    // the closed snapshot never gains a line (the file would change)
    await expect(
      asRole(appRole, `insert into payroll_line (company_id, closing_id, employment_id, rubrique_id, origin_month, value, adjusted, export_code, unit, matricule, last_name, first_name)
                    values ('${COMPANY_A}', '${closing?.id}', '${EST_AR}', '${R.panier}', '2026-09-01', 3, true, 'IND_PANIER_J', 'days', 'X', 'N', 'P')`),
    ).rejects.toThrow(/not being written in this transaction/);
    for (const statement of [
      'update payroll_line set value = 1',
      'delete from payroll_line',
      'delete from payroll_closing',
      'delete from payroll_period',
      'delete from payroll_rubrique',
      'delete from payroll_policy',
      'truncate payroll_line',
    ]) {
      await expect(asRole(appRole, statement), statement).rejects.toThrow(/permission denied/);
    }
    await expect(asRole(appRole, `update payroll_closing set lines = 0 where id = '${closing?.id}'`)).rejects.toThrow(/only a reopening/);
    // the worker: read only
    for (const statement of [`update payroll_period set status = 'open'`, 'delete from payroll_adjustment', `update payroll_adjustment set value = 0`]) {
      await expect(asRole(db.workerUrl, statement), statement).rejects.toThrow(/permission denied/);
    }
    expect(await query(db.superuserUrl, `select status from payroll_period where month = '2026-09-01' and company_id = $1`, [COMPANY_A])).toEqual([{ status: 'closed' }]);
  });

  it('a zero line is stored only as an adjustment over a non-zero computed value', async () => {
    await expect(zeroLine('2', false)).rejects.toThrow(/payroll_line_value_ck/);
    await expect(zeroLine('null', true)).rejects.toThrow(/payroll_line_value_ck/);
    await expect(zeroLine('0', true)).rejects.toThrow(/payroll_line_value_ck/);
    await zeroLine('2', true);
  });
});

describe('the files', () => {
  it('a closed month downloads the same bytes every time; quoting, formula guard and Windows-1252', async () => {
    const path = `/api/payroll/periods/${CLOSED}/export`;
    const first = await download('admin', path);
    expect((await download('admin', path)).equals(first)).toBe(true);
    const est = await download('est', path);
    expect((await download('est', path)).equals(est)).toBe(true);
    // Œ ’ € are 0x8C 0x92 0x80 in Windows-1252 (not ISO-8859-1); Arabic letters become ?
    expect(first.includes(Buffer.from([0x22, 0x4a, 0x65, 0x61, 0x6e, 0x3b, 0x20, 0x22, 0x22, 0x4c, 0x65, 0x22, 0x22, 0x20, 0x8c, 0x75, 0x66, 0x92, 0x80, 0x22]))).toBe(true);
    const rows = cp1252.decode(first).split('\r\n');
    expect(rows[0]).toBe('matricule;nom;prenom;rubrique;libelle;valeur;periode');
    const panier = rows.find((r) => r.startsWith('EMP-0027') && r.includes('IND_PANIER_J')) ?? '';
    expect(panier.startsWith(`EMP-0027;"'=HYPERLINK(""x"")";"Jean; ""Le"" Œuf’€";IND_PANIER_J;`)).toBe(true);
    expect(panier.endsWith(';7;09/2026')).toBe(true);
    expect(rows.find((r) => r.startsWith('EMP-0027') && r.includes('PRIME_REND'))).toMatch(/;15432,5;09\/2026$/);
    expect(rows.find((r) => r.startsWith('EMP-0026'))).toMatch(/^EMP-0026;\?\? \?\?\?;\?\?\?\?;IND_PANIER_J;/);
    // no byte-order mark
    expect(first.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
  });

  it('the control report (UTF-8): quoting, formula guard on names and notes, Arabic names kept', async () => {
    const fr = (await download('admin', `/api/payroll/periods/${CLOSED}/control.csv`)).toString('utf8');
    expect(fr.startsWith(BOM)).toBe(true);
    const row = fr.split('\r\n').find((r) => r.startsWith('EMP-0027') && r.includes('IND_PANIER_J')) ?? '';
    expect(row).toContain(`;"'=HYPERLINK(""x"")";"Jean; ""Le"" Œuf’€";`);
    expect(row.endsWith(";'=1+1")).toBe(true);
    const ar = (await download('admin', `/api/payroll/periods/${CLOSED}/control.csv?lang=ar`)).toString('utf8');
    expect(ar).toContain(';بن علي;سارة;');
  });
});

describe('a close racing adjustments: every accepted adjustment is in the snapshot', () => {
  it('PUTs during the close either land before it (and are in the closing) or get 409', async () => {
    const employees = [employeeA(23), employeeA(26), employeeA(27), employeeA(28), employeeA(31)];
    const [close, ...puts] = await Promise.all([
      client('admin').post(`/api/payroll/periods/${OPEN}/close`).send({}),
      ...employees.map((e, i) => line('admin', OPEN, e, { rubriqueId: R.panier, value: 11 + i })),
    ]);
    expect(close?.status, JSON.stringify(close?.body)).toBe(200);
    for (const p of puts) expect([200, 409]).toContain(p.status);
    const adjustments = await query<{ e: string; v: string }>(db.superuserUrl, `select employment_id as e, value::text as v from payroll_adjustment where month = '2026-10-01' and rubrique_id = $1 order by 1`, [R.panier]);
    const snapshot = await query<{ e: string; v: string }>(
      db.superuserUrl,
      `select l.employment_id as e, l.value::text as v from payroll_line l join payroll_closing c on c.id = l.closing_id join payroll_period p on p.id = c.period_id
        where p.month = '2026-10-01' and c.reopened_at is null and l.rubrique_id = $1 order by 1`,
      [R.panier],
    );
    expect(snapshot).toEqual(adjustments);
  });
});

describe('XSRF, anonymous, malformed inputs', () => {
  it('writes without the XSRF token are refused; anonymous calls are 401', async () => {
    const server = request(app.getHttpServer());
    const writes: (() => request.Test)[] = [
      () => dev(server.put(`/api/payroll/periods/${OPEN}/variables/${EST}/lines`)).send({ rubriqueId: R.panier, value: 1 }),
      () => dev(server.delete(`/api/payroll/periods/${OPEN}/variables/${EST}/lines/${R.panier}`)),
      () => dev(server.post(`/api/payroll/periods/${CLOSED}/reopen`)).send({ reason: 'Erreur de saisie' }),
      () => dev(server.post(`/api/payroll/periods/${OPEN}/close`)).send({}),
      () => dev(server.put('/api/payroll/settings')).send({ cutoffDay: 10 }),
      () => dev(server.post('/api/payroll/rubriques')).send({ exportCode: 'XSRF', names: { fr: 'x', ar: 'x', en: 'x' }, unit: 'days' }),
      () => dev(server.put(`/api/payroll/rubriques/${R.panier}`)).send({ active: false }),
      () => dev(server.put(`/api/payroll/employee-codes/${EST}`)).send({ code: 'XSRF-1' }),
    ];
    for (const w of writes) expect((await w()).status).toBe(403);
    expect(await query(db.superuserUrl, `select 1 from payroll_rubrique where export_code = 'XSRF'`)).toHaveLength(0);
    for (const path of [
      '/api/payroll/periods',
      `/api/payroll/periods/${CLOSED}`,
      `/api/payroll/periods/${CLOSED}/variables`,
      `/api/payroll/periods/${CLOSED}/variables/${EST}`,
      `/api/payroll/periods/${CLOSED}/export`,
      `/api/payroll/periods/${CLOSED}/control.csv`,
      '/api/payroll/settings',
      '/api/payroll/settings/preview',
      '/api/payroll/rubriques',
    ]) {
      expect((await server.get(path)).status, path).toBe(401);
    }
  });

  it('malformed months, values, codes and filters → 422', async () => {
    for (const month of ['2026-9', '2026-00', '2026-13', '202609', 'abcd-ef', '2026-09-01', '9999-12']) {
      for (const path of [`/api/payroll/periods/${month}`, `/api/payroll/periods/${month}/variables`, `/api/payroll/periods/${month}/export?draft=true`, `/api/payroll/periods/${month}/control.csv`]) {
        expect((await client('admin').get(path)).status, path).toBe(422);
      }
      expect((await line('admin', month, EST, { rubriqueId: R.panier, value: 1 })).status, month).toBe(422);
      expect((await client('admin').post(`/api/payroll/periods/${month}/close`).send({})).status, month).toBe(422);
    }
    // August is open (September and October are closed by now)
    for (const value of [1e12, -1e12, 1_000_000_000, '5', null, 1.005, Number.MAX_SAFE_INTEGER, true]) {
      expect((await line('admin', '2026-08', EST, { rubriqueId: R.panier, value })).status, String(value)).toBe(422);
    }
    for (const body of [{ rubriqueId: R.panier, value: 1, note: 'x'.repeat(301) }, { rubriqueId: 'nope', value: 1 }, { rubriqueId: R.panier, value: 1, originMonth: '2026-1' }, { rubriqueId: R.panier }]) {
      expect((await line('admin', '2026-08', EST, body)).status, JSON.stringify(body).slice(0, 60)).toBe(422);
    }
    expect(await query(db.superuserUrl, `select 1 from payroll_adjustment where month = '2026-08-01'`)).toHaveLength(0);
    expect((await client('admin').post(`/api/payroll/periods/${CLOSED}/reopen`).send({ reason: 'x'.repeat(301) })).status).toBe(422);
    expect((await client('admin').post(`/api/payroll/periods/${OPEN}/close`).send({ force: true })).status).toBe(422);
    for (const code of ['A'.repeat(21), 'é1', '=1+1', 'A B', 'a;b']) {
      expect((await client('admin').put(`/api/payroll/employee-codes/${EST}`).send({ code })).status, code).toBe(422);
      expect((await client('admin').post('/api/payroll/rubriques').send({ exportCode: code, names: { fr: 'x', ar: 'x', en: 'x' }, unit: 'days' })).status, code).toBe(422);
    }
    expect((await client('admin').post('/api/payroll/rubriques').send({ exportCode: 'OK1', names: { fr: 'x'.repeat(81), ar: 'x', en: 'x' }, unit: 'days' })).status).toBe(422);
    expect((await client('admin').post('/api/payroll/rubriques').send({ exportCode: 'OK1', names: { fr: 'x', ar: 'x', en: 'x' }, unit: 'euros' })).status).toBe(422);
    for (const body of [{ columns: ['matricule', 'matricule', 'rubrique', 'value'] }, { columns: ['matricule', 'salary'] }, { cutoffDay: 29 }, { cutoffDay: 0 }, { regularizationMonths: 13 }, { overtimeMinMinutes: 241 }, { encoding: 'latin1' }, { columns: [] }]) {
      expect((await client('admin').put('/api/payroll/settings').send(body)).status, JSON.stringify(body)).toBe(422);
    }
    for (const qs of ['year=1999', 'year=abc']) expect((await client('admin').get(`/api/payroll/periods?${qs}`)).status, qs).toBe(422);
    for (const qs of ['pageSize=101', 'page=0', `q=${'x'.repeat(101)}`, 'unitId=nope', 'rubriqueId=nope', 'filter=xyz', 'lang=de']) {
      expect((await client('admin').get(`/api/payroll/periods/${CLOSED}/variables?${qs}`)).status, qs).toBe(422);
    }
    expect((await client('admin').get(`/api/payroll/periods/${CLOSED}/control.csv?lang=en`)).status).toBe(422);
    expect((await client('admin').get(`/api/payroll/periods/${CLOSED}/export?unitId=nope`)).status).toBe(422);
    // nothing leaked in the problem bodies
    assertNoSecrets((await client('admin').get('/api/payroll/periods/2026-13')).body);
  });
});
