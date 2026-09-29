/**
 * Employment slice (docs/contracts/employment.md): list (scope as of a date, filters, search Latin/Arabic, sorting,
 * paging), detail (field blocks, _redacted, _actions), writes and their date rules / 409 slugs, rehire, end,
 * field-level permissions (forbidden-field) and scope (forbidden-scope), plus the database backstops of migration 0010.
 * Real grants (DEV_AUTH header identity, no DEV_PERMISSIONS) over the seeded demo employees (fictitious test data).
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, COMPANY_A, demoEmployee, EMPLOYEE_B, employeeA, seedAccessFixture, unitA, type ActorName } from './support/access-fixture.js';
import { assertNoSecrets } from './support/assert-no-secrets.js';
import { createTestApp } from './support/test-app.js';
import { createTestDatabase, query, type TestDatabase } from './support/test-database.js';
import { fetchXsrf, type XsrfPair } from './support/xsrf.js';

interface Item {
  id: string;
  matricule: string;
  person: { id: string; lastName: string; firstName: string; lastNameAr: string | null; firstNameAr: string | null };
  unit: { id: string; code: string; name: string; nameAr: string | null; kind: string };
  site: { id: string; code: string; name: string } | null;
  jobTitle: string;
  hireDate: string;
  endDate: string | null;
  status: string;
}
interface ListBody {
  items: Item[];
  total: number;
  page: number;
  pageSize: number;
}

const EST_UNITS = new Set(['REG-EST', 'SRV-ADM-EST', 'AG-CNE', 'AG-ANNABA', 'SRV-CLI-ANB']);
const OUEST_UNITS = new Set(['REG-OUEST', 'AG-ORAN', 'AG-TLEMCEN']);

let db: TestDatabase;
let app: NestExpressApplication;
let xsrf: XsrfPair;
const client = (actor: ActorName) => as(app, actor, xsrf);

async function list(actor: ActorName, qs = ''): Promise<ListBody> {
  const res = await client(actor).get(`/api/employees${qs ? `?${qs}` : ''}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  assertNoSecrets(res.body);
  return res.body as ListBody;
}

/** Every page of a listing (pageSize 100). */
async function all(actor: ActorName, qs = ''): Promise<Item[]> {
  return (await list(actor, `pageSize=100${qs ? `&${qs}` : ''}`)).items;
}

const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const key = (i: Item) => fold(`${i.person.lastName} ${i.person.firstName}`);
const unitKey = (i: Item) => fold(i.unit.name);
const matricules = (items: Item[]) => items.map((i) => i.matricule);
const enc = encodeURIComponent;
/** `sort=name&lang=ar` key: Arabic last / first name, each falling back to the Latin one. */
const nameAr = (i: Item) => [i.person.lastNameAr?.trim() || i.person.lastName, i.person.firstNameAr?.trim() || i.person.firstName] as const;
const byMatricule = (a: Item, b: Item) => (a.matricule < b.matricule ? -1 : a.matricule > b.matricule ? 1 : 0);

beforeAll(async () => {
  db = await createTestDatabase();
  await seedAccessFixture(db);
  app = await createTestApp(db, { devAuth: true, devPermissions: false });
  xsrf = await fetchXsrf(app);
});

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

// ---------------------------------------------------------------------------------------------------------------
describe('GET /api/employees — scope, filters, search, sorting, paging', () => {
  it('rh.est lists only Région Est employees (active by default); admin sees the whole company', async () => {
    const est = await list('est', 'pageSize=100');
    expect(est.total).toBe(11); // 12 in Région Est, EMP-0025 ended
    expect(est.items.every((i) => EST_UNITS.has(i.unit.code))).toBe(true);
    expect(matricules(est.items)).not.toContain('EMP-0025');
    expect((await list('est', 'status=all&pageSize=100')).total).toBe(12);
    const ouest = await list('ouest', 'pageSize=100');
    expect(ouest.items.every((i) => OUEST_UNITS.has(i.unit.code))).toBe(true);
    expect(ouest.total).toBe(6);
    const admin = await list('admin', 'pageSize=100');
    expect(admin.total).toBe(38);
    // the other company only sees its own
    expect(matricules((await list('beta')).items)).toEqual(['B-0001']);
  });

  it('item shape: names Latin + Arabic, unit with nameAr, effective site, status', async () => {
    const [item] = (await list('admin', 'q=EMP-0032')).items;
    const seed = demoEmployee(32);
    expect(item).toEqual({
      id: employeeA(32),
      matricule: 'EMP-0032',
      person: { id: seed.personId, lastName: seed.lastName, firstName: seed.firstName, lastNameAr: seed.lastNameAr, firstNameAr: seed.firstNameAr },
      unit: { id: unitA('SRV-CLI-ANB'), code: 'SRV-CLI-ANB', name: 'Service Clientèle', nameAr: 'مصلحة الزبائن', kind: 'service' },
      // the service has no own site: it inherits its agency's
      site: { id: expect.any(String), code: 'ANNABA', name: 'Annaba' },
      jobTitle: expect.any(String),
      hireDate: seed.hireDate,
      endDate: null,
      status: 'active',
    });
  });

  it('search: Latin accent/case-insensitive, both name orders, matricule, NIN', async () => {
    expect(matricules(await all('admin', 'q=saidi&status=all'))).toEqual(['EMP-0015', 'EMP-0040']); // Saïdi Riad, Saïdi Wafa
    expect(matricules(await all('admin', `q=${enc('SAÏDI Riad')}`))).toEqual(['EMP-0015']);
    expect(matricules(await all('admin', `q=${enc('riad saidi')}`))).toEqual(['EMP-0015']);
    expect(matricules(await all('admin', 'q=leila'))).toEqual(['EMP-0008', 'EMP-0028']);
    expect(matricules(await all('admin', 'q=emp-0027'))).toEqual(['EMP-0027']);
    expect(matricules(await all('admin', `q=${demoEmployee(9).nin}`))).toEqual(['EMP-0009']);
    // LIKE wildcards are literal
    expect(await all('admin', `q=${enc('%')}`)).toEqual([]);
  });

  it('search: Arabic with or without tashkeel, alef / teh marbuta variants', async () => {
    const sarah = ['EMP-0010', 'EMP-0030'];
    expect(matricules(await all('admin', `q=${enc('سارة')}`)).toSorted()).toEqual(sarah);
    expect(matricules(await all('admin', `q=${enc('ساره')}`)).toSorted()).toEqual(sarah); // ة ↔ ه
    expect(matricules(await all('admin', `q=${enc('سَارَة')}`)).toSorted()).toEqual(sarah); // tashkeel stripped
    expect(matricules(await all('admin', `q=${enc('اسماء')}`)).toSorted()).toEqual(['EMP-0014', 'EMP-0034']); // أ ↔ ا
    expect(matricules(await all('admin', `q=${enc('مصطفي')}`)).toSorted()).toEqual(['EMP-0009', 'EMP-0029']); // ى ↔ ي
    expect(matricules(await all('admin', `q=${enc('فرحات سارة')}`))).toEqual(['EMP-0030']);
    // scope still applies to a search
    expect(matricules(await all('est', `q=${enc('سارة')}`))).toEqual(['EMP-0030']);
  });

  it('unitId with / without sub-units, siteId (effective site), status and asOf', async () => {
    expect((await all('admin', `unitId=${unitA('REG-EST')}`)).length).toBe(11);
    expect(matricules(await all('admin', `unitId=${unitA('REG-EST')}&includeSubUnits=false`))).toEqual(['EMP-0022']);
    const annabaSite = (await all('admin', `unitId=${unitA('AG-ANNABA')}&includeSubUnits=false`))[0]?.site?.id;
    const bySite = await all('admin', `siteId=${annabaSite}`);
    expect(bySite.every((i) => i.site?.code === 'ANNABA')).toBe(true);
    expect(matricules(bySite).toSorted()).toEqual(['EMP-0029', 'EMP-0030', 'EMP-0031', 'EMP-0032', 'EMP-0033']);
    // ended (as of today)
    expect(matricules(await all('admin', 'status=ended')).toSorted()).toEqual(['EMP-0025', 'EMP-0040']);
    // as of 2026-03-15: EMP-0029 was still at Agence Constantine, EMP-0040 still employed
    const march = await all('admin', `asOf=2026-03-15&unitId=${unitA('AG-CNE')}`);
    expect(matricules(march)).toContain('EMP-0029');
    expect(matricules(march)).toContain('EMP-0025');
    expect(matricules(await all('admin', 'asOf=2026-03-15&status=ended'))).toEqual([]);
    expect(matricules(await all('admin', `asOf=2026-03-15&unitId=${unitA('AG-TLEMCEN')}`)).toSorted()).toEqual(['EMP-0039', 'EMP-0040']);
    // an ended employment stays in its LAST unit's scope: EMP-0040 (Tlemcen) is visible to lecture.ouest, not rh.est
    expect(matricules(await all('ouest', 'status=ended'))).toEqual(['EMP-0040']);
    expect(matricules(await all('est', 'status=ended'))).toEqual(['EMP-0025']);
    // before the move, rh.est does not see EMP-0029 from Annaba… it was at Constantine (still Est): visible either way
    expect(matricules(await all('est', 'asOf=2020-12-31&status=all'))).toContain('EMP-0029');
    // a unit outside the caller's scope yields nothing (no 403/404 leak)
    expect(await all('est', `unitId=${unitA('AG-ORAN')}`)).toEqual([]);
  });

  it('sorting: name (default, accent-insensitive), matricule, hireDate, unit; asc/desc; stable', async () => {
    const byName = await all('admin');
    expect(byName.map(key)).toEqual(byName.map(key).toSorted());
    const desc = await all('admin', 'sort=matricule&dir=desc&status=all');
    expect(desc[0]?.matricule).toBe('EMP-0040');
    expect(matricules(desc)).toEqual(matricules(desc).toSorted().toReversed());
    const hire = await all('admin', 'sort=hireDate');
    expect(hire.map((i) => i.hireDate)).toEqual(hire.map((i) => i.hireDate).toSorted());
    const units = await all('admin', 'sort=unit&dir=desc');
    expect(units.map(unitKey)).toEqual(units.map(unitKey).toSorted().toReversed());
  });

  it('sorting: lang=ar orders sort=name by the Arabic last then first name (Latin fallback), ICU Arabic collation; dir; lang ignored elsewhere', async () => {
    const arabic = new Intl.Collator('ar');
    const compare = (a: Item, b: Item) => arabic.compare(nameAr(a)[0], nameAr(b)[0]) || arabic.compare(nameAr(a)[1], nameAr(b)[1]) || byMatricule(a, b);
    const asc = await all('admin', 'status=all&lang=ar');
    expect(asc.length).toBeGreaterThan(30);
    expect(matricules(asc)).toEqual(matricules(asc.toSorted(compare)));
    // the seed has people without an Arabic name: they fall back to their Latin name, after every Arabic one (ascending)
    const withAr = asc.map((i) => Boolean(i.person.lastNameAr));
    expect(withAr).toContain(false);
    expect(withAr.indexOf(false)).toBeGreaterThan(withAr.lastIndexOf(true));
    // it differs from the Latin order, and the explicit sort=name is the same thing
    expect(matricules(asc)).not.toEqual(matricules(await all('admin', 'status=all')));
    expect(matricules(await all('admin', 'status=all&sort=name&lang=ar'))).toEqual(matricules(asc));
    const desc = await all('admin', 'status=all&sort=name&dir=desc&lang=ar');
    expect(matricules(desc)).toEqual(matricules(asc).toReversed());
    // lang=fr is the default; lang has no effect on the other keys; paging is stable
    expect(matricules(await all('admin', 'status=all&lang=fr'))).toEqual(matricules(await all('admin', 'status=all')));
    for (const other of ['sort=matricule', 'sort=hireDate', 'sort=unit&dir=desc']) {
      expect(matricules(await all('admin', `status=all&${other}&lang=ar`)), other).toEqual(matricules(await all('admin', `status=all&${other}`)));
    }
    const pages = await Promise.all([1, 2, 3].map((page) => list('admin', `status=all&lang=ar&pageSize=15&page=${page}`)));
    expect(matricules(pages.flatMap((p) => p.items))).toEqual(matricules(asc));
    // alef forms share one base letter under the ICU Arabic collation (إبراهيم < أحمد), unlike code-point order
    const rows = await query<{ n: string }>(db.superuserUrl, `select n from (values ('أحمد'), ('إبراهيم'), ('آمنة'), ('بلقاسم')) v(n) order by n collate "ar-x-icu"`);
    expect(rows.map((r) => r.n)).toEqual(['آمنة', 'إبراهيم', 'أحمد', 'بلقاسم']);
  });

  it('lang: only fr or ar, else 422 with errors[].field = lang', async () => {
    for (const bad of ['lang=en', 'lang=AR', 'lang=', 'lang=ar-DZ']) {
      const res = await client('admin').get(`/api/employees?${bad}`);
      expect(res.status, bad).toBe(422);
      expect(res.body.errors, bad).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'lang' })]));
    }
  });

  it('paging: page/pageSize, total on every page, past the end, limits', async () => {
    const first = await list('admin', 'pageSize=10&sort=matricule');
    const third = await list('admin', 'pageSize=10&sort=matricule&page=3');
    const fourth = await list('admin', 'pageSize=10&sort=matricule&page=4');
    expect([first.total, third.total, fourth.total]).toEqual([38, 38, 38]);
    expect(first).toMatchObject({ page: 1, pageSize: 10 });
    expect(first.items).toHaveLength(10);
    expect(fourth.items).toHaveLength(8);
    expect(first.items[0]?.matricule).toBe('EMP-0001');
    const beyond = await list('admin', 'pageSize=10&page=9');
    expect(beyond).toEqual({ items: [], total: 38, page: 9, pageSize: 10 });
    expect((await list('admin')).pageSize).toBe(25);
    for (const bad of ['pageSize=101', 'pageSize=0', 'page=0', 'sort=salary', 'status=gone', 'asOf=2026-02-30', 'unitId=x', 'dir=up']) {
      const res = await client('admin').get(`/api/employees?${bad}`);
      expect(res.status, bad).toBe(422);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('GET /api/employees/:id — field blocks, _redacted, _actions', () => {
  it('admin (admin_rh_central): salary (decimal strings), bank, nss; every action', async () => {
    const res = await client('admin').get(`/api/employees/${employeeA(28)}`).expect(200);
    assertNoSecrets(res.body);
    const seed = demoEmployee(28);
    expect(res.body).toMatchObject({
      matricule: 'EMP-0028',
      status: 'active',
      endReason: null,
      person: { nin: seed.nin, sex: 'F', nationality: 'DZ', birthDate: seed.birthDate },
      unit: { code: 'AG-CNE', nameAr: 'وكالة قسنطينة' },
      salary: {
        current: { baseSalary: '49572.50', currency: 'DZD', validFrom: '2026-01-01' },
        history: [
          { baseSalary: '49572.50', validFrom: '2026-01-01', validTo: null },
          { baseSalary: '45900.00', validFrom: seed.hireDate, validTo: '2026-01-01' },
        ],
      },
      bank: { rib: seed.rib, bankName: seed.bankName },
      nss: { nss: seed.nss },
      _redacted: [],
      _actions: ['update', 'assign', 'end', 'update_salary', 'update_bank', 'update_nss'],
    });
    expect(typeof res.body.salary.current.baseSalary).toBe('string');
  });

  it('lecture.ouest reads its region: salary, bank and nss redacted, no write action', async () => {
    const res = await client('ouest').get(`/api/employees/${employeeA(36)}`).expect(200);
    assertNoSecrets(res.body);
    expect(res.body).toMatchObject({ _redacted: ['salary', 'bank', 'nss'], _actions: [] });
    for (const block of ['salary', 'bank', 'nss']) expect(res.body).not.toHaveProperty(block);
    expect(JSON.stringify(res.body)).not.toContain(demoEmployee(36).rib ?? 'x');
  });

  it('rh.est: employee actions, but no sensitive block nor action; out-of-scope / other company / malformed → 404', async () => {
    const res = await client('est').get(`/api/employees/${employeeA(33)}`).expect(200);
    expect(res.body).toMatchObject({ _redacted: ['salary', 'bank', 'nss'], _actions: ['update', 'assign', 'end'] });
    await client('est').get(`/api/employees/${employeeA(36)}`).expect(404);
    await client('est').get(`/api/employees/${EMPLOYEE_B.employmentId}`).expect(404);
    await client('admin').get('/api/employees/not-a-uuid').expect(404);
    await client('admin').get('/api/employees/0190a5d0-0000-7000-8000-00000000dead').expect(404);
  });

  it('assignment history (newest first) with unit path, effective site and siteInherited; ended employee', async () => {
    const moved = (await client('admin').get(`/api/employees/${employeeA(29)}`).expect(200)).body;
    expect(moved.assignments).toHaveLength(2);
    expect(moved.assignments[0]).toMatchObject({
      unit: { code: 'AG-ANNABA', nameAr: 'وكالة عنابة', path: [{ name: 'Direction Générale' }, { name: 'Département RX' }, { name: 'Région Est', nameAr: 'منطقة الشرق' }] },
      site: { code: 'ANNABA' },
      siteInherited: true,
      validFrom: '2026-04-01',
      validTo: null,
    });
    expect(moved.assignments[1]).toMatchObject({ unit: { code: 'AG-CNE' }, validTo: '2026-04-01' });
    const ended = (await client('admin').get(`/api/employees/${employeeA(40)}`).expect(200)).body;
    expect(ended).toMatchObject({ status: 'ended', endDate: '2026-03-31', endReason: 'retirement', unit: { code: 'AG-TLEMCEN' }, _actions: [] });
    expect(ended.assignments[0].validTo).toBe('2026-04-01');
    expect(ended.salary.current).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('writes — field permissions, scope, date rules, 409 slugs', () => {
  const base = { lastName: 'Nouveau', firstName: 'Salarié', hireDate: '2026-09-01', jobTitle: 'Agent' };

  it('POST /employees → 201 + Location, detail; money in and out as decimal strings; audit rows', async () => {
    const res = await client('admin')
      .post('/api/employees')
      .send({
        ...base,
        lastNameAr: 'جديد',
        firstNameAr: 'موظف',
        nin: '1 99 99 0000000000 077',
        matricule: 'new-0001',
        orgUnitId: unitA('SRV-CLI-ANB'),
        salary: { baseSalary: '85000' },
        bank: { rib: '00799999000000000077', bankName: 'CPA' },
        nss: { nss: '990000000077' },
      });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    assertNoSecrets(res.body);
    expect(res.headers['location']).toBe(`/api/employees/${res.body.id}`);
    expect(res.body).toMatchObject({
      matricule: 'NEW-0001',
      person: { lastName: 'Nouveau', lastNameAr: 'جديد', nin: '199990000000000077', nationality: 'DZ' },
      unit: { code: 'SRV-CLI-ANB' },
      site: { code: 'ANNABA' },
      hireDate: '2026-09-01',
      salary: { current: { baseSalary: '85000.00', currency: 'DZD', validFrom: '2026-09-01' } },
      bank: { rib: '00799999000000000077', bankName: 'CPA' },
      nss: { nss: '990000000077' },
    });
    const [row] = await query<{ base_salary: string }>(db.superuserUrl, `select base_salary::text from employment_salary where employment_id = $1`, [res.body.id]);
    expect(row?.base_salary).toBe('85000.00');
    // JSON numbers are refused for money (float rounding)
    const float = await client('admin').post('/api/employees').send({ ...base, matricule: 'NEW-FLOAT', orgUnitId: unitA('AG-CNE'), salary: { baseSalary: 85000.1 } });
    expect(float.status).toBe(422);
    expect(float.body.errors[0]).toMatchObject({ field: 'salary.baseSalary' });
  });

  it('rh.est creating an employee with a salary block → 403 forbidden-field (nothing written); without → 201', async () => {
    const res = await client('est')
      .post('/api/employees')
      .send({ ...base, matricule: 'EST-0001', orgUnitId: unitA('AG-CNE'), salary: { baseSalary: '50000.00' }, nss: { nss: '990000000123' } });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ type: 'urn:hrforce:problem:forbidden-field', errors: [{ field: 'salary', code: 'forbidden_field' }, { field: 'nss', code: 'forbidden_field' }] });
    expect(await query(db.superuserUrl, `select 1 from employment where matricule = 'EST-0001'`)).toHaveLength(0);
    const ok = await client('est').post('/api/employees').send({ ...base, matricule: 'EST-0001', orgUnitId: unitA('AG-CNE') });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).toMatchObject({ _redacted: ['salary', 'bank', 'nss'], _actions: ['update', 'assign', 'end'] });
    // outside REG-EST: forbidden-scope on the unit; unknown unit / site → 422
    const ouest = await client('est').post('/api/employees').send({ ...base, matricule: 'EST-0002', orgUnitId: unitA('AG-ORAN') });
    expect(ouest.status).toBe(403);
    expect(ouest.body).toMatchObject({ type: 'urn:hrforce:problem:forbidden-scope', errors: [{ field: 'orgUnitId', code: 'forbidden_scope' }] });
    const unknown = await client('admin').post('/api/employees').send({ ...base, matricule: 'X-1', orgUnitId: '0190a5d0-0000-7000-8000-00000000dead' });
    expect(unknown.status).toBe(422);
    expect(unknown.body.errors[0]).toMatchObject({ field: 'orgUnitId', code: 'not_found' });
  });

  it('matricule-taken, nin-taken, validation (422 with fields)', async () => {
    const taken = await client('admin').post('/api/employees').send({ ...base, matricule: 'EMP-0001', orgUnitId: unitA('AG-CNE') });
    expect(taken.status).toBe(409);
    expect(taken.body).toMatchObject({ type: 'urn:hrforce:problem:matricule-taken', errors: [{ field: 'matricule' }] });
    const nin = await client('admin').post('/api/employees').send({ ...base, matricule: 'NIN-1', nin: demoEmployee(1).nin, orgUnitId: unitA('AG-CNE') });
    expect(nin.status).toBe(409);
    expect(nin.body).toMatchObject({ type: 'urn:hrforce:problem:nin-taken', errors: [{ field: 'nin' }] });
    const patchNin = await client('admin').patch(`/api/employees/${employeeA(2)}/person`).send({ nin: demoEmployee(1).nin });
    expect(patchNin.body).toMatchObject({ type: 'urn:hrforce:problem:nin-taken' });
    const bad = await client('admin')
      .post('/api/employees')
      .send({ matricule: '-bad', hireDate: '2026-13-01', orgUnitId: unitA('AG-CNE'), jobTitle: '', nin: '123', sex: 'X', bank: { rib: '123', bankName: 'X' } });
    expect(bad.status).toBe(422);
    const fields = (bad.body.errors as { field: string }[]).map((e) => e.field);
    for (const f of ['matricule', 'hireDate', 'jobTitle', 'nin', 'sex', 'bank.rib']) expect(fields).toContain(f);
    const noNames = await client('admin').post('/api/employees').send({ matricule: 'NONAME', hireDate: '2026-09-01', orgUnitId: unitA('AG-CNE'), jobTitle: 'Agent' });
    expect(noNames.status).toBe(422);
    expect((noNames.body.errors as { field: string }[]).map((e) => e.field)).toEqual(['lastName', 'firstName']);
  });

  it('moving an employee from Est to Ouest by rh.est → 403 forbidden-scope; within Est → 200 (current closed the day before)', async () => {
    const id = employeeA(26);
    const toOuest = await client('est').post(`/api/employees/${id}/assignments`).send({ orgUnitId: unitA('AG-ORAN'), jobTitle: 'Agent', validFrom: '2026-10-01' });
    expect(toOuest.status).toBe(403);
    expect(toOuest.body).toMatchObject({ type: 'urn:hrforce:problem:forbidden-scope', errors: [{ field: 'orgUnitId', code: 'forbidden_scope' }] });
    const res = await client('est').post(`/api/employees/${id}/assignments`).send({ orgUnitId: unitA('AG-ANNABA'), jobTitle: 'Chef d’agence', validFrom: '2026-10-01' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.assignments.map((a: { unit: { code: string }; validFrom: string; validTo: string | null }) => [a.unit.code, a.validFrom, a.validTo])).toEqual([
      ['AG-ANNABA', '2026-10-01', null],
      ['AG-CNE', '2011-06-14', '2026-10-01'],
    ]);
    // assignment-date: not after the current assignment's start
    const early = await client('admin').post(`/api/employees/${id}/assignments`).send({ orgUnitId: unitA('AG-CNE'), jobTitle: 'Agent', validFrom: '2026-10-01' });
    expect(early.status).toBe(409);
    expect(early.body).toMatchObject({ type: 'urn:hrforce:problem:assignment-date', errors: [{ field: 'validFrom' }] });
    // lecture has no employee.update at all (guard); rh.est on an Ouest employee → 404
    expect((await client('ouest').post(`/api/employees/${employeeA(36)}/assignments`).send({ orgUnitId: unitA('AG-ORAN'), jobTitle: 'X', validFrom: '2027-01-01' })).status).toBe(403);
    expect((await client('est').post(`/api/employees/${employeeA(36)}/assignments`).send({ orgUnitId: unitA('AG-CNE'), jobTitle: 'X', validFrom: '2027-01-01' })).status).toBe(404);
  });

  it('PUT salary / bank / nss: admin only; salary-date; masked in the audit log', async () => {
    const id = employeeA(27);
    const early = await client('admin').put(`/api/employees/${id}/salary`).send({ baseSalary: '60000.00', validFrom: '2010-01-01' });
    expect(early.body).toMatchObject({ type: 'urn:hrforce:problem:salary-date', errors: [{ field: 'validFrom' }] });
    const salary = await client('admin').put(`/api/employees/${id}/salary`).send({ baseSalary: '60000.10', validFrom: '2026-10-01' });
    expect(salary.status, JSON.stringify(salary.body)).toBe(200);
    expect(salary.body.salary.history.slice(0, 2)).toEqual([
      { baseSalary: '60000.10', validFrom: '2026-10-01', validTo: null },
      { baseSalary: '42200.00', validFrom: '2014-11-21', validTo: '2026-10-01' },
    ]);
    const same = await client('admin').put(`/api/employees/${id}/salary`).send({ baseSalary: '61000.00', validFrom: '2026-10-01' });
    expect(same.body).toMatchObject({ type: 'urn:hrforce:problem:salary-date' });
    expect((await client('est').put(`/api/employees/${id}/salary`).send({ baseSalary: '1.00', validFrom: '2027-01-01' })).status).toBe(403);
    const bank = await client('admin').put(`/api/employees/${id}/bank`).send({ rib: '0079 9999 0000 0000 0027', bankName: 'BDL' });
    expect(bank.body.bank).toEqual({ rib: '00799999000000000027', bankName: 'BDL' });
    const nss = await client('admin').put(`/api/employees/${id}/nss`).send({ nss: null });
    expect(nss.body.nss).toEqual({ nss: null });
    const logged = await query<{ before: unknown; after: unknown }>(
      db.superuserUrl,
      `select before, after from audit.change_log where table_name in ('employment_salary', 'person_sensitive') and actor_user_id is not null`,
    );
    expect(JSON.stringify(logged)).not.toMatch(/60000|00799999000000000027|BDL/);
  });

  it('end: closes the open assignment and salary at endDate + 1; end-date; then every write is employment-ended', async () => {
    const id = employeeA(31); // raise on 2026-01-01
    const tooEarly = await client('admin').post(`/api/employees/${id}/end`).send({ endDate: '2025-12-31', reason: 'resignation' });
    expect(tooEarly.status).toBe(409);
    expect(tooEarly.body).toMatchObject({ type: 'urn:hrforce:problem:end-date', errors: [{ field: 'endDate' }] });
    const badReason = await client('admin').post(`/api/employees/${id}/end`).send({ endDate: '2026-10-31', reason: 'fired' });
    expect(badReason.status).toBe(422);
    const res = await client('admin').post(`/api/employees/${id}/end`).send({ endDate: '2026-10-31', reason: 'end_of_contract' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ endDate: '2026-10-31', endReason: 'end_of_contract', _actions: [] });
    expect(res.body.assignments[0].validTo).toBe('2026-11-01');
    expect(res.body.salary.history[0]).toMatchObject({ validFrom: '2026-01-01', validTo: '2026-11-01' });
    for (const [method, path, body] of [
      ['patch', 'person', { birthPlace: 'X' }],
      ['post', 'assignments', { orgUnitId: unitA('AG-CNE'), jobTitle: 'X', validFrom: '2026-10-15' }],
      ['post', 'end', { endDate: '2026-11-30', reason: 'other' }],
      ['put', 'salary', { baseSalary: '1.00', validFrom: '2026-10-15' }],
      ['put', 'bank', { rib: null, bankName: null }],
      ['put', 'nss', { nss: null }],
    ] as const) {
      const c = client('admin');
      const r = await (method === 'patch' ? c.patch(`/api/employees/${id}/${path}`) : method === 'put' ? c.put(`/api/employees/${id}/${path}`) : c.post(`/api/employees/${id}/${path}`)).send(body);
      expect(r.status, path).toBe(409);
      expect(r.body.type, path).toBe('urn:hrforce:problem:employment-ended');
    }
  });

  it('rehire via personId: employment-open while open; hire-date after the previous end; person fields refused', async () => {
    const open = demoEmployee(33);
    const busy = await client('admin').post('/api/employees').send({ personId: open.personId, matricule: 'RH-1', hireDate: '2026-10-01', orgUnitId: unitA('AG-CNE'), jobTitle: 'Agent' });
    expect(busy.status).toBe(409);
    expect(busy.body).toMatchObject({ type: 'urn:hrforce:problem:employment-open', errors: [{ field: 'personId' }] });
    const ended = demoEmployee(25); // ended 2026-06-30 (Agence Constantine)
    const overlap = await client('admin').post('/api/employees').send({ personId: ended.personId, matricule: 'RH-2', hireDate: '2026-06-30', orgUnitId: unitA('AG-CNE'), jobTitle: 'Agent' });
    expect(overlap.body).toMatchObject({ type: 'urn:hrforce:problem:hire-date', errors: [{ field: 'hireDate' }] });
    const mixed = await client('admin').post('/api/employees').send({ personId: ended.personId, lastName: 'X', matricule: 'RH-3', hireDate: '2026-09-01', orgUnitId: unitA('AG-CNE'), jobTitle: 'Agent' });
    expect(mixed.status).toBe(422);
    // rh.est cannot rehire someone it cannot read (EMP-0040 ended in Tlemcen)
    const hidden = await client('est').post('/api/employees').send({ personId: demoEmployee(40).personId, matricule: 'RH-4', hireDate: '2026-09-01', orgUnitId: unitA('AG-CNE'), jobTitle: 'Agent' });
    expect(hidden.status).toBe(422);
    expect(hidden.body.errors[0]).toMatchObject({ field: 'personId', code: 'not_found' });
    const rehired = await client('est').post('/api/employees').send({ personId: ended.personId, matricule: 'RH-5', hireDate: '2026-09-01', orgUnitId: unitA('AG-ANNABA'), jobTitle: 'Agent' });
    expect(rehired.status, JSON.stringify(rehired.body)).toBe(201);
    expect(rehired.body.person).toMatchObject({ id: ended.personId, lastName: ended.lastName });
    // two employments of the same person, one open
    expect(matricules(await all('admin', `q=${ended.nin}&status=all`)).toSorted()).toEqual(['EMP-0025', 'RH-5']);
  });

  it('person.hasOpenEmployment: any employment of the person not over today, whatever the viewer’s scope — a boolean, no id', async () => {
    // an open employment reports itself
    expect((await client('admin').get(`/api/employees/${employeeA(33)}`).expect(200)).body.person.hasOpenEmployment).toBe(true);
    // EMP-0040 ended 2026-03-31 in Agence Tlemcen (Région Ouest, lecture.ouest's scope)
    const before = await client('ouest').get(`/api/employees/${employeeA(40)}`).expect(200);
    expect(before.body.person.hasOpenEmployment).toBe(false);
    // the person is rehired in Région Est, outside lecture.ouest's scope
    const rehired = await client('admin').post('/api/employees').send({ personId: demoEmployee(40).personId, matricule: 'RH-6', hireDate: '2026-09-01', orgUnitId: unitA('AG-CNE'), jobTitle: 'Agent' });
    expect(rehired.status, JSON.stringify(rehired.body)).toBe(201);
    expect(rehired.body.person.hasOpenEmployment).toBe(true);
    const after = await client('ouest').get(`/api/employees/${employeeA(40)}`).expect(200);
    expect(after.body.person.hasOpenEmployment).toBe(true);
    expect(after.body.status).toBe('ended');
    // only the boolean: nothing of the other employment (id, matricule, unit) and it stays out of reach
    const text = JSON.stringify(after.body);
    for (const hidden of [rehired.body.id as string, 'RH-6', unitA('AG-CNE')]) expect(text).not.toContain(hidden);
    expect((await client('ouest').get(`/api/employees/${rehired.body.id}`)).status).toBe(404);
    // EMP-0025, rehired as RH-5 by rh.est above
    expect((await client('est').get(`/api/employees/${employeeA(25)}`).expect(200)).body.person.hasOpenEmployment).toBe(true);
  });

  it('PATCH person: names, clearing optional fields; nationality upper-cased', async () => {
    const res = await client('est').patch(`/api/employees/${employeeA(24)}/person`).send({ lastNameAr: '', birthPlace: null, nationality: 'fr', sex: 'F' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.person).toMatchObject({ lastNameAr: null, birthPlace: null, nationality: 'FR', sex: 'F' });
    expect((await client('est').patch(`/api/employees/${employeeA(24)}/person`).send({})).status).toBe(422);
  });
});

/** Runs statements as the migrator in one transaction (deferred constraints fire at the commit). */
async function tx(statements: string[]): Promise<void> {
  const pg = new Client({ connectionString: db.migratorUrl });
  await pg.connect();
  try {
    for (const s of ['begin', ...statements, 'commit']) await pg.query(s);
  } catch (error) {
    await pg.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await pg.end();
  }
}

// ---------------------------------------------------------------------------------------------------------------
describe('database backstops (migration 0010)', () => {
  it('exclusion constraints, one open employment, formats, deferred date rules', async () => {
    const e = employeeA(22);
    const p = demoEmployee(22).personId;
    await expect(tx([`insert into assignment (company_id, employment_id, org_unit_id, job_title, valid) values ('${COMPANY_A}', '${e}', '${unitA('AG-CNE')}', 'X', '[2026-02-01,)')`])).rejects.toThrow(/assignment_no_overlap_ex/);
    await expect(tx([`insert into employment_salary (company_id, employment_id, base_salary, valid) values ('${COMPANY_A}', '${e}', 1, '[2026-02-01,)')`])).rejects.toThrow(/employment_salary_no_overlap_ex/);
    await expect(tx([`insert into employment (company_id, person_id, matricule, hire_date) values ('${COMPANY_A}', '${p}', 'DB-1', '2026-09-01')`])).rejects.toThrow(/employment_one_open_uk|employment_no_overlap_ex/);
    await expect(tx([`update person_sensitive set rib = '123' where person_id = '${p}'`])).rejects.toThrow(/person_sensitive_rib_ck/);
    await expect(tx([`update person set nin = '12' where id = '${p}'`])).rejects.toThrow(/person_nin_ck/);
    await expect(tx([`update employment set matricule = 'EMP-9999' where id = '${e}'`])).rejects.toThrow(/immutable/);
    // deferred: an employment without its first assignment, a salary before the hire date, an assignment past the end
    await expect(tx([`insert into person (id, company_id, last_name, first_name) values ('0190a5d0-0000-7000-8000-00000000d001', '${COMPANY_A}', 'A', 'B')`, `insert into employment (company_id, person_id, matricule, hire_date) values ('${COMPANY_A}', '0190a5d0-0000-7000-8000-00000000d001', 'DB-2', '2026-09-01')`])).rejects.toThrow(/first assignment/);
    await expect(tx([`update employment_salary set valid = daterange('2000-01-01', upper(valid), '[)') where employment_id = '${e}' and lower(valid) < '2026-01-01'`])).rejects.toThrow(/salary starts before/);
    await expect(tx([`update employment set end_date = '2026-05-31', end_reason = 'other' where id = '${e}'`])).rejects.toThrow(/runs past the end date/);
    // the app role cannot delete history
    const runtime = new Client({ connectionString: db.appUrl });
    await runtime.connect();
    try {
      await runtime.query(`select set_config('app.company_id', '${COMPANY_A}', false)`);
      await expect(runtime.query(`delete from employment_salary where employment_id = '${e}'`)).rejects.toThrow(/permission denied/);
      await expect(runtime.query(`delete from person_sensitive`)).rejects.toThrow(/permission denied/);
    } finally {
      await runtime.end();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('Organization: nameAr (date-effective, create/change bodies, search)', () => {
  it('creates with nameAr, renames in Arabic from a date, clears with null', async () => {
    const created = await client('admin').post('/api/org/units').send({ kind: 'service', code: 'SRV-AR', name: 'Service Arabe', nameAr: '  مصلحة الترجمة  ', parentId: unitA('AG-ORAN') });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ nameAr: 'مصلحة الترجمة', versions: [{ nameAr: 'مصلحة الترجمة' }] });
    const renamed = await client('admin').patch(`/api/org/units/${created.body.id}`).send({ nameAr: 'مصلحة الترجمة و الاتصال', validFrom: '2030-01-01' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.versions.map((v: { nameAr: string | null }) => v.nameAr)).toEqual(['مصلحة الترجمة و الاتصال', 'مصلحة الترجمة']);
    const cleared = await client('admin').patch(`/api/org/units/${created.body.id}`).send({ nameAr: null, validFrom: '2031-01-01' });
    expect(cleared.body.versions[0]).toMatchObject({ name: 'Service Arabe', nameAr: null });
    const tree = await client('admin').get('/api/org/tree').expect(200);
    expect(tree.body.root).toMatchObject({ code: 'DG', nameAr: 'المديرية العامة' });
    const search = await client('admin').get(`/api/org/units?q=${enc('الترجمه')}`).expect(200);
    expect(search.body.items.map((i: { code: string }) => i.code)).toEqual(['SRV-AR']);
  });
});
