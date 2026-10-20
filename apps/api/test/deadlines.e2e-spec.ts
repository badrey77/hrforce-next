/**
 * Deadlines (docs/contracts/contracts-deadlines.md › Deadlines, Worker): the board in the caller's scope, the summary,
 * acknowledgements, the policy, and the daily digest of the worker (once per user and day, counts only).
 * "Today" is pinned to 2026-10-19 (DeadlinesClock); contracts and files are written as the superuser. TEST DATA.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedContractDefaults } from '../src/modules/contracts/index.js';
import { DeadlinesClock, digestSubjectId } from '../src/modules/deadlines/index.js';
import { createDatabase, type Database } from '../src/platform/db/database.js';
import { deadlinesDailyTask, emailTask, type WorkerDeps } from '../src/worker/tasks.js';
import { as, COMPANY_A, COMPANY_B, EMPLOYEE_B, employeeA, seedAccessFixture, unitA, USERS, type ActorName } from './support/access-fixture.js';
import { insertAck, insertContract, insertExpiringFile } from './support/deadlines-fixture.js';
import { createTestApp } from './support/test-app.js';
import { createTestDatabase, query, type TestDatabase } from './support/test-database.js';
import { fetchXsrf, type XsrfPair } from './support/xsrf.js';

const TODAY = '2026-10-19';

let db: TestDatabase;
let app: NestExpressApplication;
let xsrf: XsrfPair;
let worker: Database;
let deps: WorkerDeps;
let jobSeq = 0;
const sent: { to: string; subject: string; text: string; html: string }[] = [];
const client = (actor: ActorName) => as(app, actor, xsrf);
const job = () => ({ id: String(++jobSeq), attempt: 1 });

/** Fixture ids (filled in beforeAll). */
const FX = { est: '', est2: '', ouest: '', probation: '', cddEst: '', cddOuest: '', fileEst: '', medicalEst: '', fileBeta: '' };

interface Item {
  key: string;
  kind: string;
  dueDate: string;
  daysLeft: number;
  status: string;
  severity: string;
  employee: { id: string; matricule: string };
  contract: { id: string } | null;
  file: { id: string; title: string } | null;
  ack: { id: string; note: string | null; by: { displayName: string } | null } | null;
  // oxlint-disable-next-line no-underscore-dangle -- the API's field name
  _actions: string[];
}

async function board(actor: ActorName, qs = ''): Promise<Item[]> {
  const res = await client(actor).get(`/api/deadlines?pageSize=100${qs}`).expect(200);
  return (res.body as { items: Item[] }).items;
}

const of = (items: Item[], employmentId: string, kind?: string) => items.filter((i) => i.employee.id === employmentId && (!kind || i.kind === kind));

async function inEst(employmentId: string): Promise<boolean> {
  const rows = await query<{ ok: boolean }>(
    db.superuserUrl,
    `select exists (select 1 from assignment a join org_unit_closure c on c.company_id = a.company_id and c.descendant_id = a.org_unit_id
       where a.employment_id = $1 and a.valid @> $2::date and c.ancestor_id = $3) as ok`,
    [employmentId, TODAY, unitA('REG-EST')],
  );
  return rows[0]?.ok ?? false;
}

beforeAll(async () => {
  db = await createTestDatabase();
  await seedAccessFixture(db, undefined, { leave: true });
  // the contract.decision chain of both companies (the daily job opens decisions before the digest)
  const migrator = createDatabase({ connectionString: db.migratorUrl, maxConnections: 1 });
  await migrator.transaction().execute(async (tx) => {
    await seedContractDefaults(tx, COMPANY_A);
    await seedContractDefaults(tx, COMPANY_B);
  });
  await migrator.destroy();
  app = await createTestApp(db, { devAuth: true, devPermissions: false, overrides: [{ provide: DeadlinesClock, useValue: { today: () => TODAY } }] });
  xsrf = await fetchXsrf(app);
  worker = createDatabase({ connectionString: db.workerUrl, maxConnections: 3, applicationName: 'hrforce-worker-test' });
  deps = { db: worker, logger: pino({ level: 'silent' }), mail: { send: (m) => (sent.push(m), Promise.resolve()) }, webBaseUrl: 'https://hr.example.dz' };

  FX.est = employeeA(27);
  FX.ouest = employeeA(36);
  // a second Est employee
  for (let n = 21; n <= 35; n += 1) {
    if (n !== 27 && (await inEst(employeeA(n)))) {
      FX.est2 = employeeA(n);
      break;
    }
  }
  expect(await inEst(FX.est)).toBe(true);
  expect(await inEst(FX.ouest)).toBe(false);
  // no contract from any seed on the employees used here
  await query(db.superuserUrl, 'delete from contract_decision where employment_id = any($1)', [[FX.est, FX.est2, FX.ouest]]);
  await query(db.superuserUrl, 'delete from employment_contract where employment_id = any($1)', [[FX.est, FX.est2, FX.ouest]]);
  const hire = async (e: string) => (await query<{ d: string }>(db.superuserUrl, `select to_char(hire_date, 'YYYY-MM-DD') as d from employment where id = $1`, [e]))[0]?.d ?? '';
  // EMP-0027: CDD ending in 20 days (contract-end window), probation ending in 10 days
  // (a first CDD from the hire date, then the current one: the probation must fall within 12 months of its start)
  await insertContract(db.superuserUrl, { companyId: COMPANY_A, employmentId: FX.est, seq: 1, contractType: 'cdd', startDate: await hire(FX.est), endDate: '2026-05-31' });
  FX.cddEst = await insertContract(db.superuserUrl, { companyId: COMPANY_A, employmentId: FX.est, seq: 2, contractType: 'cdd', startDate: '2026-06-01', endDate: '2026-11-08', probationEnd: '2026-10-29' });
  FX.probation = FX.cddEst;
  // EMP-0036 (Ouest): a CDD ended 4 days ago while the person keeps working → critical
  FX.cddOuest = await insertContract(db.superuserUrl, { companyId: COMPANY_A, employmentId: FX.ouest, seq: 1, contractType: 'cdd', startDate: await hire(FX.ouest), endDate: '2026-10-15' });
  // FX.est2: a CDI → no contract item; an identity document expiring in 12 days
  await insertContract(db.superuserUrl, { companyId: COMPANY_A, employmentId: FX.est2, seq: 1, contractType: 'cdi', startDate: await hire(FX.est2), endDate: null });
  FX.fileEst = await insertExpiringFile(db.superuserUrl, { companyId: COMPANY_A, employmentId: FX.est2, uploadedBy: USERS.admin.id, expiresOn: '2026-10-31', title: 'Passeport' });
  FX.medicalEst = await insertExpiringFile(db.superuserUrl, { companyId: COMPANY_A, employmentId: FX.est2, uploadedBy: USERS.admin.id, expiresOn: '2026-10-30', categoryCode: 'medical', title: 'Aptitude' });
  FX.fileBeta = await insertExpiringFile(db.superuserUrl, { companyId: COMPANY_B, employmentId: EMPLOYEE_B.employmentId, uploadedBy: USERS.beta.id, expiresOn: '2026-10-25' });
});

afterAll(async () => {
  await worker?.destroy();
  await app?.close();
  await db?.drop();
});

describe('GET /deadlines', () => {
  it('computes each kind for central HR, overdue first, medical files hidden', async () => {
    const items = await board('admin');
    const cdd = of(items, FX.est, 'contract_end')[0];
    expect(cdd).toMatchObject({ kind: 'contract_end', dueDate: '2026-11-08', daysLeft: 20, status: 'due', severity: 'info', contract: { id: FX.cddEst } });
    expect(cdd?.['_actions']).toEqual(expect.arrayContaining(['ack', 'open_decision']));
    expect(of(items, FX.est, 'probation_end')[0]).toMatchObject({ dueDate: '2026-10-29', daysLeft: 10, status: 'due' });
    expect(of(items, FX.ouest, 'contract_end')[0]).toMatchObject({ status: 'overdue', severity: 'critical', daysLeft: -4 });
    const files = of(items, FX.est2, 'document_expiry');
    expect(files.map((f) => f.file?.id)).toEqual([FX.fileEst]);
    expect(files[0]?.file?.title).toBe('Passeport');
    expect(of(items, FX.est2, 'contract_missing')).toEqual([]);
    // the employees of the demo without any contract
    expect(items.some((i) => i.kind === 'contract_missing' && i.severity === 'warning')).toBe(true);
    const firstDue = items.findIndex((i) => i.status === 'due');
    expect(items.slice(firstDue).every((i) => i.status === 'due')).toBe(true);
    expect(items.some((i) => i.employee.id === EMPLOYEE_B.employmentId)).toBe(false);
  });

  it('regional HR sees its region only; lecture, access admins and employees are refused', async () => {
    const items = await board('est');
    expect(of(items, FX.est).length).toBeGreaterThan(0);
    expect(of(items, FX.ouest)).toEqual([]);
    for (const actor of ['ouest', 'acces', 'agent'] as const) await client(actor).get('/api/deadlines').expect(403);
    await as(app, null, xsrf).get('/api/deadlines').expect(401);
    const beta = await board('beta');
    expect(beta.map((i) => i.employee.id)).toContain(EMPLOYEE_B.employmentId);
    expect(beta.every((i) => i.employee.id === EMPLOYEE_B.employmentId)).toBe(true);
  });

  it('filters by kind, unit, search and horizon', async () => {
    const onlyEnd = await board('admin', '&kind=contract_end');
    expect(onlyEnd.every((i) => i.kind === 'contract_end')).toBe(true);
    const ouest = await board('admin', `&unitId=${unitA('REG-OUEST')}`);
    expect(of(ouest, FX.est)).toEqual([]);
    expect(of(ouest, FX.ouest).length).toBeGreaterThan(0);
    const [matricule] = (await query<{ m: string }>(db.superuserUrl, 'select matricule as m from employment where id = $1', [FX.est])).map((r) => r.m);
    const searched = await board('admin', `&q=${encodeURIComponent(matricule ?? '')}`);
    expect(searched.every((i) => i.employee.id === FX.est)).toBe(true);
    // a contract end 20 days ahead is inside its 30-day window: shown even with within=5
    expect(of(await board('admin', '&within=5'), FX.est, 'contract_end')).toHaveLength(1);
    await client('admin').get('/api/deadlines?within=999').expect(422);
    await client('admin').get('/api/deadlines?kind=nope').expect(422);
  });

  it('summary counts the open items of the scope', async () => {
    const all = (await client('admin').get('/api/deadlines/summary').expect(200)).body as { overdue: number; critical: number; next30: number; byKind: Record<string, { overdue: number; due: number }> };
    expect(all.critical).toBeGreaterThanOrEqual(1);
    expect(all.byKind['contract_end']?.overdue).toBeGreaterThanOrEqual(1);
    expect(all.next30).toBeGreaterThanOrEqual(3);
    const est = (await client('est').get('/api/deadlines/summary').expect(200)).body as { critical: number };
    expect(est.critical).toBe(0);
    await client('ouest').get('/api/deadlines/summary').expect(403);
  });
});

describe('acknowledgements', () => {
  it('regional HR marks an item handled; it leaves the open board and shows under handled; undo', async () => {
    const res = await client('est').post('/api/deadlines/acks').send({ kind: 'probation_end', subjectId: FX.probation, dueDate: '2026-10-29', note: 'Période d’essai confirmée.' }).expect(201);
    const item = res.body as Item;
    expect(item).toMatchObject({ status: 'handled', ack: { note: 'Période d’essai confirmée.', by: { displayName: USERS.est.displayName } } });
    expect(item['_actions']).toEqual(['unack']);
    await client('est').post('/api/deadlines/acks').send({ kind: 'probation_end', subjectId: FX.probation, dueDate: '2026-10-29' }).expect(409);
    expect(of(await board('est'), FX.est, 'probation_end')).toEqual([]);
    expect(of(await board('est', '&status=handled'), FX.est, 'probation_end')).toHaveLength(1);
    // a wrong due date: not today's item
    const wrong = await client('est').post('/api/deadlines/acks').send({ kind: 'probation_end', subjectId: FX.probation, dueDate: '2026-10-28' }).expect(422);
    expect(wrong.body).toMatchObject({ errors: [{ field: 'subjectId', code: 'not_found' }] });
    const ack = item.ack as { id: string };
    await client('beta').delete(`/api/deadlines/acks/${ack.id}`).expect(404);
    await client('ouest').delete(`/api/deadlines/acks/${ack.id}`).expect(403);
    await client('est').delete(`/api/deadlines/acks/${ack.id}`).expect(204);
    expect(of(await board('est'), FX.est, 'probation_end')).toHaveLength(1);
    await client('est').delete(`/api/deadlines/acks/${ack.id}`).expect(404);
    await client('est').delete('/api/deadlines/acks/not-a-uuid').expect(404);
  });

  it('out of scope → 404, other company → 404, lecture → 403', async () => {
    await client('est').post('/api/deadlines/acks').send({ kind: 'contract_end', subjectId: FX.cddOuest, dueDate: '2026-10-15' }).expect(404);
    await client('beta').post('/api/deadlines/acks').send({ kind: 'contract_end', subjectId: FX.cddOuest, dueDate: '2026-10-15' }).expect(404);
    await client('ouest').post('/api/deadlines/acks').send({ kind: 'contract_end', subjectId: FX.cddOuest, dueDate: '2026-10-15' }).expect(403);
    await client('admin').post('/api/deadlines/acks').send({ kind: 'contract_end', subjectId: 'x', dueDate: '2026-10-15' }).expect(422);
    // the acknowledgement is audited
    const res = await client('admin').post('/api/deadlines/acks').send({ kind: 'contract_end', subjectId: FX.cddOuest, dueDate: '2026-10-15' }).expect(201);
    const id = (res.body as Item).ack?.id ?? '';
    const rows = await query<{ n: number }>(db.superuserUrl, `select count(*)::int as n from audit.change_log where table_name = 'deadline_ack' and row_id = $1`, [id]);
    expect(rows[0]?.n).toBe(1);
    await client('admin').delete(`/api/deadlines/acks/${id}`).expect(204);
  });
});

describe('settings', () => {
  it('defaults, partial update company-wide, ranges', async () => {
    expect((await client('admin').get('/api/deadlines/settings').expect(200)).body).toEqual({
      probationNoticeDays: 15, contractNoticeDays: 30, decisionNoticeDays: 45, documentNoticeDays: 30, retirementAge: 60, retirementNoticeMonths: 6, digestEnabled: true,
    });
    const saved = await client('admin').put('/api/deadlines/settings').send({ contractNoticeDays: 10 }).expect(200);
    expect(saved.body).toMatchObject({ contractNoticeDays: 10, probationNoticeDays: 15 });
    // the CDD end 20 days ahead is now outside its window but still inside the 90-day horizon
    expect(of(await board('admin'), FX.est, 'contract_end')).toHaveLength(1);
    const bad = await client('admin').put('/api/deadlines/settings').send({ retirementAge: 80, extra: 1 }).expect(422);
    expect(JSON.stringify(bad.body)).toContain('retirementAge');
    for (const actor of ['est', 'ouest', 'acces', 'agent'] as const) {
      await client(actor).get('/api/deadlines/settings').expect(403);
      await client(actor).put('/api/deadlines/settings').send({ contractNoticeDays: 20 }).expect(403);
    }
    expect((await client('beta').put('/api/deadlines/settings').send({ digestEnabled: false }).expect(200)).body).toMatchObject({ digestEnabled: false, contractNoticeDays: 30 });
    await client('admin').put('/api/deadlines/settings').send({ contractNoticeDays: 30 }).expect(200);
  });
});

const digests = (userId: string) =>
  query<{ id: string; subject_id: string; data: Record<string, unknown> }>(db.superuserUrl, `select id, subject_id, data from notification where user_id = $1 and type = 'deadline.digest' order by created_at`, [userId]);

describe('deadlines.daily (worker)', () => {
  it('one digest per holder whose items entered their window, once per day; counts only', async () => {
    // since 2026-10-08: the CDD end of EMP-0027 (window from 2026-10-09) and the critical one (overdue from 2026-10-16) are new
    const result = await deadlinesDailyTask(deps, { today: TODAY, since: '2026-10-08' }, job());
    expect(result).toMatchObject({ today: TODAY, since: '2026-10-08' });
    const admin = await digests(USERS.admin.id);
    expect(admin).toHaveLength(1);
    expect(admin[0]?.subject_id).toBe(digestSubjectId(COMPANY_A, USERS.admin.id, TODAY));
    expect(admin[0]?.data).toMatchObject({ newCount: expect.any(Number), date: TODAY });
    expect(Number(admin[0]?.data['criticalCount'])).toBeGreaterThanOrEqual(1);
    expect(Number(admin[0]?.data['newCount'])).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(admin[0]?.data)).not.toMatch(/Passeport|EMP-/);
    const est = await digests(USERS.est.id);
    expect(est).toHaveLength(1);
    // EMP-0036's critical contract end is in Ouest: not in rh.est's counts
    expect(Number(est[0]?.data['criticalCount'])).toBeLessThan(Number(admin[0]?.data['criticalCount']));
    // no deadline.read: nothing; BETA disabled its digest above
    expect(await digests(USERS.ouest.id)).toHaveLength(0);
    expect(await digests(USERS.agent.id)).toHaveLength(0);
    expect(await digests(USERS.beta.id)).toHaveLength(0);
    // same day again: no second notification
    await deadlinesDailyTask(deps, { today: TODAY, since: '2026-10-08' }, job());
    expect(await digests(USERS.admin.id)).toHaveLength(1);
    // the link and the e-mail
    sent.length = 0;
    expect(await emailTask(deps, { companyId: COMPANY_A, notificationId: admin[0]?.id ?? '' }, job())).toMatchObject({ outcome: 'sent' });
    expect(sent[0]?.subject).toMatch(/échéances à traiter$/);
    expect(sent[0]?.text).toContain('https://hr.example.dz/deadlines');
  });

  it('nothing new since yesterday → no digest; a disabled policy sends none', async () => {
    const before = (await digests(USERS.admin.id)).length;
    await deadlinesDailyTask(deps, { today: '2026-10-20', since: '2026-10-19' }, job());
    expect(await digests(USERS.admin.id)).toHaveLength(before);
    await client('admin').put('/api/deadlines/settings').send({ digestEnabled: false }).expect(200);
    await deadlinesDailyTask(deps, { today: '2026-10-21', since: '2026-10-08' }, job());
    expect(await digests(USERS.admin.id)).toHaveLength(before);
    await client('admin').put('/api/deadlines/settings').send({ digestEnabled: true }).expect(200);
  });

  it('a handled item does not count; an acknowledgement inserted by hand is honoured', async () => {
    await deadlinesDailyTask(deps, { today: '2026-10-22', since: '2026-10-08' }, job());
    const before = Number((await digests(USERS.admin.id)).at(-1)?.data['criticalCount']);
    await insertAck(db.superuserUrl, { companyId: COMPANY_A, kind: 'contract_end', subjectId: FX.cddOuest, dueDate: '2026-10-15', ackedBy: USERS.admin.id });
    await deadlinesDailyTask(deps, { today: '2026-10-23', since: '2026-10-08' }, job());
    const latest = (await digests(USERS.admin.id)).at(-1);
    expect(latest?.data).toMatchObject({ date: '2026-10-23' });
    expect(Number(latest?.data['criticalCount'])).toBe(before - 1);
  });

  it('rejects a malformed payload date', async () => {
    await expect(deadlinesDailyTask(deps, { today: '19/10/2026' }, job())).rejects.toThrow(/payload\.today/);
  });
});
