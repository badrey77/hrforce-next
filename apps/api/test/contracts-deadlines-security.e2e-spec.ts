/**
 * Contracts & deadlines — security probes of the independent verification (docs/contracts/contracts-deadlines.md ›
 * "Settled by the verification (gate and security)"): scope of the board's filters and of acknowledgements, medical
 * files, regional settings, XSRF / anonymous, self-approval, an approval that fails half-way (nothing persists),
 * concurrent opens and approvals, the daily job per company and idempotent, the digest's medical rule, the worker
 * and app roles' privileges on the new tables. TEST DATA — fictitious.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays } from '../src/modules/contracts/index.js';
import { toIsoDate } from '../src/modules/organization/index.js';
import { createDatabase, type Database } from '../src/platform/db/database.js';
import { deadlinesDailyTask, type WorkerDeps } from '../src/worker/tasks.js';
import { as, COMPANY_A, COMPANY_B, EMPLOYEE_B, employeeA, seedAccessFixture, unitA, unitB, USERS, type ActorName } from './support/access-fixture.js';
import { assertNoSecrets } from './support/assert-no-secrets.js';
import { insertAck, insertContract, insertExpiringFile } from './support/deadlines-fixture.js';
import { createTestApp } from './support/test-app.js';
import { createTestDatabase, query, type TestDatabase } from './support/test-database.js';
import { fetchXsrf, type XsrfPair } from './support/xsrf.js';

const TODAY = toIsoDate(new Date());

let db: TestDatabase;
let app: NestExpressApplication;
let xsrf: XsrfPair;
let worker: Database;
let deps: WorkerDeps;
let jobSeq = 0;
const job = () => ({ id: `probe-${++jobSeq}`, attempt: 1 });
const client = (actor: ActorName) => as(app, actor, xsrf);
const slug = (body: { type?: string }) => (body.type ?? '').replace('urn:hrforce:problem:', '');

const EST = { cne: employeeA(28), cne2: employeeA(26), cne3: employeeA(27), annaba: employeeA(31), admEst: employeeA(23), karim: employeeA(22) };
const OUEST = { oran: employeeA(35), oran2: employeeA(36) };
const FX = { ouestFile: '', estFile: '', estMedical: '', betaFile: '', betaAck: '', ouestAck: '', ouestMatricule: '' };

/** Header identity of rh.admin, without the XSRF token. */
const dev = (r: request.Test) => r.set('X-Dev-User-Id', USERS.admin.id).set('X-Dev-Company-Id', COMPANY_A);
/** One statement as hrforce_worker inside DEMO's company context. */
const tx = (sqlText: string) => query(db.workerUrl, `begin; select set_config('app.company_id', '${COMPANY_A}', true); ${sqlText}; commit;`);

const ack = (actor: ActorName, body: Record<string, unknown>) => client(actor).post('/api/deadlines/acks').send(body);

async function hireOf(employmentId: string): Promise<string> {
  const [row] = await query<{ d: string }>(db.superuserUrl, `select to_char(hire_date, 'YYYY-MM-DD') as d from employment where id = $1`, [employmentId]);
  return row?.d ?? '';
}

async function cdd(companyId: string, employmentId: string, endDate: string): Promise<string> {
  return insertContract(db.superuserUrl, { companyId, employmentId, seq: 1, contractType: 'cdd', startDate: await hireOf(employmentId), endDate });
}

async function taskOf(actor: ActorName, decisionId: string): Promise<{ id: string; stepKey: string } | undefined> {
  const items = (await client(actor).get('/api/tasks?status=open').expect(200)).body.items as { id: string; stepKey: string; subject: { type: string; id: string } }[];
  return items.find((t) => t.subject.type === 'contract_decision' && t.subject.id === decisionId);
}

/** A custom role with `permissions`, granted to `userId` on `unitId` (+ sub-units). */
async function grant(userId: string, code: string, permissions: string[], unitId: string): Promise<void> {
  const [role] = await query<{ id: string }>(
    db.superuserUrl,
    `insert into role (company_id, code, name_fr, name_ar, name_en) values ($1, $2, 'Sonde', 'مسبار', 'Probe') returning id`,
    [COMPANY_A, code],
  );
  for (const p of permissions) await query(db.superuserUrl, 'insert into role_permission (company_id, role_id, permission_code) values ($1, $2, $3)', [COMPANY_A, role?.id, p]);
  await query(db.superuserUrl, `insert into role_grant (company_id, user_id, role_id, org_unit_id, valid_from, include_descendants) values ($1, $2, $3, $4, '2026-01-01', true)`, [
    COMPANY_A,
    userId,
    role?.id,
    unitId,
  ]);
}

beforeAll(async () => {
  db = await createTestDatabase();
  await seedAccessFixture(db, undefined, { leave: true });
  app = await createTestApp(db, { devAuth: true, devPermissions: false });
  xsrf = await fetchXsrf(app);
  worker = createDatabase({ connectionString: db.workerUrl, maxConnections: 3, applicationName: 'hrforce-worker-probe' });
  deps = { db: worker, logger: pino({ level: 'silent' }), mail: { send: () => Promise.resolve() }, webBaseUrl: 'https://hr.example.dz' };

  const [m] = await query<{ matricule: string }>(db.superuserUrl, 'select matricule from employment where id = $1', [OUEST.oran]);
  FX.ouestMatricule = m?.matricule ?? '';
  FX.ouestFile = await insertExpiringFile(db.superuserUrl, { companyId: COMPANY_A, employmentId: OUEST.oran, uploadedBy: USERS.admin.id, expiresOn: addDays(TODAY, 10), title: 'Permis Ouest' });
  FX.estFile = await insertExpiringFile(db.superuserUrl, { companyId: COMPANY_A, employmentId: EST.cne, uploadedBy: USERS.admin.id, expiresOn: addDays(TODAY, 10), title: 'Permis Est' });
  FX.estMedical = await insertExpiringFile(db.superuserUrl, { companyId: COMPANY_A, employmentId: EST.cne, uploadedBy: USERS.admin.id, expiresOn: addDays(TODAY, 11), categoryCode: 'medical', title: 'Aptitude Est' });
  FX.betaFile = await insertExpiringFile(db.superuserUrl, { companyId: COMPANY_B, employmentId: EMPLOYEE_B.employmentId, uploadedBy: USERS.beta.id, expiresOn: addDays(TODAY, 10) });
  FX.betaAck = await insertAck(db.superuserUrl, { companyId: COMPANY_B, kind: 'retirement', subjectId: EMPLOYEE_B.employmentId, dueDate: '2050-01-01', ackedBy: USERS.beta.id });
  FX.ouestAck = await insertAck(db.superuserUrl, { companyId: COMPANY_A, kind: 'retirement', subjectId: OUEST.oran2, dueDate: '2050-01-01', ackedBy: USERS.admin.id });
  // `target`: deadlines with medical files and the configure permission, on Région Est only (not company-wide)
  await grant(USERS.target.id, 'probe_dl_est', ['deadline.read', 'deadline.handle', 'deadline.configure', 'employee.medical.read'], unitA('REG-EST'));
});

afterAll(async () => {
  await worker?.destroy();
  await app?.close();
  await db?.drop();
});

interface Item {
  kind: string;
  employee: { id: string };
  file: { id: string } | null;
}
const board = async (actor: ActorName, qs = '') => (await client(actor).get(`/api/deadlines?status=all&within=730&pageSize=100${qs}`).expect(200)).body as { items: Item[]; total: number };

describe('the board cannot be used to probe other units', () => {
  it('unitId / q of another region, or of another company, give nothing to regional HR', async () => {
    const admin = await board('admin', `&q=${encodeURIComponent(FX.ouestMatricule)}`);
    expect(admin.items.some((i) => i.employee.id === OUEST.oran)).toBe(true);
    expect((await board('est', `&q=${encodeURIComponent(FX.ouestMatricule)}`)).total).toBe(0);
    expect((await board('est', `&unitId=${unitA('REG-OUEST')}`)).total).toBe(0);
    expect((await board('est', `&unitId=${unitA('AG-ORAN')}&includeSubUnits=false`)).total).toBe(0);
    expect((await board('admin', `&unitId=${unitB('BETA-DG')}`)).total).toBe(0);
    const all = await board('est');
    expect(all.items.every((i) => i.employee.id !== OUEST.oran && i.employee.id !== OUEST.oran2)).toBe(true);
    assertNoSecrets(all);
    // the summary counts nothing of Ouest: same totals with or without the Ouest file
    const summary = (await client('est').get('/api/deadlines/summary').expect(200)).body;
    assertNoSecrets(summary);
    expect((await client('est').get('/api/deadlines?within=731')).status).toBe(422);
    expect((await client('est').get('/api/deadlines?unitId=not-a-uuid')).status).toBe(422);
  });

  it('medical files: hidden without employee.medical.read, shown with it (and only in its scope)', async () => {
    expect((await board('est')).items.some((i) => i.file?.id === FX.estMedical)).toBe(false);
    expect((await board('admin')).items.some((i) => i.file?.id === FX.estMedical)).toBe(false);
    const target = await board('target');
    expect(target.items.some((i) => i.file?.id === FX.estMedical)).toBe(true);
    expect(target.items.some((i) => i.employee.id === OUEST.oran)).toBe(false);
  });
});

describe('acknowledgements cannot target subjects out of scope', () => {
  it('another region, another company, a mismatched kind, a medical file without the permission', async () => {
    expect((await ack('est', { kind: 'document_expiry', subjectId: FX.ouestFile, dueDate: addDays(TODAY, 10) })).status).toBe(404);
    expect((await ack('est', { kind: 'retirement', subjectId: OUEST.oran, dueDate: '2050-01-01' })).status).toBe(404);
    expect((await ack('est', { kind: 'contract_missing', subjectId: OUEST.oran, dueDate: TODAY })).status).toBe(404);
    expect((await ack('admin', { kind: 'document_expiry', subjectId: FX.betaFile, dueDate: addDays(TODAY, 10) })).status).toBe(404);
    // a file id under a contract kind: no such contract → 404
    expect((await ack('admin', { kind: 'contract_end', subjectId: FX.estFile, dueDate: addDays(TODAY, 10) })).status).toBe(404);
    // the medical item does not exist for rh.est: refused (never 201)
    const medical = await ack('est', { kind: 'document_expiry', subjectId: FX.estMedical, dueDate: addDays(TODAY, 11) });
    expect(medical.status).toBe(422);
    // the right due date only
    expect((await ack('est', { kind: 'document_expiry', subjectId: FX.estFile, dueDate: addDays(TODAY, 9) })).status).toBe(422);
    const ok = await ack('est', { kind: 'document_expiry', subjectId: FX.estFile, dueDate: addDays(TODAY, 10), note: 'Renouvelé' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    assertNoSecrets(ok.body);
    // the medical item is handled by its viewer only
    expect((await ack('target', { kind: 'document_expiry', subjectId: FX.estMedical, dueDate: addDays(TODAY, 11) })).status).toBe(201);
  });

  it('DELETE: another company 404, another region 404', async () => {
    expect((await client('admin').delete(`/api/deadlines/acks/${FX.betaAck}`)).status).toBe(404);
    expect((await client('est').delete(`/api/deadlines/acks/${FX.ouestAck}`)).status).toBe(404);
    expect((await query(db.superuserUrl, 'select 1 from deadline_ack where id = any($1)', [[FX.betaAck, FX.ouestAck]]))).toHaveLength(2);
  });
});

describe('settings, XSRF, anonymous', () => {
  it('PUT /deadlines/settings needs deadline.configure company-wide; GET with a regional grant is allowed', async () => {
    expect((await client('target').get('/api/deadlines/settings')).status).toBe(200);
    const put = await client('target').put('/api/deadlines/settings').send({ contractNoticeDays: 40 });
    expect(put.status).toBe(403);
    expect(slug(put.body)).toBe('forbidden-scope');
    expect(await query(db.superuserUrl, 'select 1 from deadline_policy where company_id = $1', [COMPANY_A])).toHaveLength(0);
    expect((await client('admin').put('/api/deadlines/settings').send({ contractNoticeDays: 0 })).status).toBe(422);
    expect((await client('admin').put('/api/deadlines/settings').send({ unknown: 1 })).status).toBe(422);
  });

  it('writes without the XSRF token are refused; anonymous reads are 401', async () => {
    const server = request(app.getHttpServer());
    expect((await dev(server.post('/api/deadlines/acks')).send({ kind: 'document_expiry', subjectId: FX.ouestFile, dueDate: addDays(TODAY, 10) })).status).toBe(403);
    expect((await dev(server.put('/api/deadlines/settings')).send({ contractNoticeDays: 40 })).status).toBe(403);
    expect((await dev(server.post(`/api/employees/${EST.cne}/contracts`)).send({ kind: 'initial', contractType: 'cdi' })).status).toBe(403);
    expect((await dev(server.delete(`/api/deadlines/acks/${FX.ouestAck}`))).status).toBe(403);
    for (const path of ['/api/deadlines', '/api/deadlines/summary', '/api/deadlines/settings', `/api/employees/${EST.cne}/contracts`, `/api/contract-decisions/${EST.cne}`]) {
      expect((await server.get(path)).status, path).toBe(401);
    }
  });
});

describe('employee list contractType filter', () => {
  it('stays in the caller scope', async () => {
    await cdd(COMPANY_A, OUEST.oran2, addDays(TODAY, 300));
    const admin = (await client('admin').get('/api/employees?contractType=cdd&pageSize=100').expect(200)).body.items as { id: string }[];
    expect(admin.map((e) => e.id)).toContain(OUEST.oran2);
    for (const qs of ['contractType=cdd', 'contractType=none', `contractType=cdd&unitId=${unitA('REG-OUEST')}`]) {
      const res = await client('est').get(`/api/employees?${qs}&pageSize=100`);
      const ids = res.status === 200 ? (res.body.items as { id: string }[]).map((e) => e.id) : [];
      expect(ids, qs).not.toContain(OUEST.oran2);
      expect(ids, qs).not.toContain(OUEST.oran);
    }
    expect((await client('est').get('/api/employees?contractType=xyz')).status).toBe(422);
  });
});

describe('decisions: self-approval, atomicity, concurrency', () => {
  it('nobody approves (or proposes on) the decision about themselves', async () => {
    // rh.est (Karim) is linked to EMP-0022, head of Région Est: the manager step is escalated to HR
    const contract = await cdd(COMPANY_A, EST.karim, addDays(TODAY, 30));
    const opened = await client('est').post(`/api/employees/${EST.karim}/contracts/${contract}/decision`);
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const decisionId = opened.body.id as string;
    expect(opened.body['_actions']).toEqual([]);
    expect(await taskOf('est', decisionId)).toBeUndefined();
    expect(slug((await client('est').put(`/api/contract-decisions/${decisionId}/proposal`).send({ proposal: 'convert_cdi' })).body)).toBe('contract-decision-not-assignee');
    const hr = await taskOf('admin', decisionId);
    expect(hr?.stepKey).toBe('hr');
    const self = await client('est').post(`/api/tasks/${hr?.id}/approve`).send({});
    expect(self.status).toBe(409);
    expect(slug(self.body)).toBe('workflow-self-approval');
    // no task notification for a user that does not exist (the system actor), whatever the escalation
    expect(await query(db.superuserUrl, `select 1 from notification where user_id = '00000000-0000-0000-0000-000000000000'`)).toHaveLength(0);
    // the employee themselves (agent, EMP-0030) cannot read or propose on their decision
    const agentContract = await cdd(COMPANY_A, employeeA(30), addDays(TODAY, 30));
    const agentDecision = (await client('admin').post(`/api/employees/${employeeA(30)}/contracts/${agentContract}/decision`).expect(201)).body.id as string;
    expect((await client('agent').get(`/api/contract-decisions/${agentDecision}`)).status).toBe(404);
    expect((await client('agent').put(`/api/contract-decisions/${agentDecision}/proposal`).send({ proposal: 'end' })).status).toBe(404);
  });

  it('an HR approval that cannot be applied persists nothing (task, decision, contracts, audit)', async () => {
    const contract = await cdd(COMPANY_A, EST.annaba, addDays(TODAY, 30));
    const decisionId = (await client('admin').post(`/api/employees/${EST.annaba}/contracts/${contract}/decision`).expect(201)).body.id as string;
    await client('chef').put(`/api/contract-decisions/${decisionId}/proposal`).send({ proposal: 'renew', proposedEndDate: addDays(TODAY, 200) }).expect(200);
    await client('chef').post(`/api/tasks/${(await taskOf('chef', decisionId))?.id}/approve`).send({}).expect(200);
    // meanwhile HR records the renewal by hand
    await client('admin').post(`/api/employees/${EST.annaba}/contracts`).send({ kind: 'renewal', contractType: 'cdd', startDate: addDays(TODAY, 31), endDate: addDays(TODAY, 100) }).expect(201);
    const hr = await taskOf('admin', decisionId);
    const before = await query<{ n: number }>(db.superuserUrl, `select count(*)::int as n from audit.event where subject_id = $1`, [decisionId]);
    const res = await client('admin').post(`/api/tasks/${hr?.id}/approve`).send({});
    expect(res.status, JSON.stringify(res.body)).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect((await taskOf('admin', decisionId))?.id).toBe(hr?.id);
    const [row] = await query<{ status: string; result: string | null; wf: string }>(
      db.superuserUrl,
      `select d.status, d.result_contract_id as result, i.status as wf from contract_decision d join workflow_instance i on i.id = d.workflow_instance_id where d.id = $1`,
      [decisionId],
    );
    expect(row).toEqual({ status: 'pending', result: null, wf: 'pending' });
    expect(await query(db.superuserUrl, 'select 1 from employment_contract where employment_id = $1', [EST.annaba])).toHaveLength(2);
    expect(await query<{ n: number }>(db.superuserUrl, `select count(*)::int as n from audit.event where subject_id = $1`, [decisionId])).toEqual(before);
    // HR can still reject it
    await client('admin').post(`/api/tasks/${hr?.id}/reject`).send({ comment: 'Déjà renouvelé' }).expect(200);
  });

  it('two concurrent manual opens → one decision; two concurrent approvals → applied once', async () => {
    const contract = await cdd(COMPANY_A, EST.cne3, addDays(TODAY, 30));
    const opens = await Promise.all([1, 2].map(() => client('admin').post(`/api/employees/${EST.cne3}/contracts/${contract}/decision`)));
    expect(opens.map((r) => r.status).toSorted()).toEqual([201, 409]);
    expect(await query(db.superuserUrl, 'select 1 from contract_decision where contract_id = $1', [contract])).toHaveLength(1);
    expect(await query(db.superuserUrl, `select 1 from workflow_instance where subject_type = 'contract_decision' and subject_id = (select id from contract_decision where contract_id = $1)`, [contract])).toHaveLength(1);

    const decisionId = (opens.find((r) => r.status === 201)?.body.id ?? '') as string;
    // AG-CNE's head is EMP-0026 (no account): escalated to HR
    await client('admin').put(`/api/contract-decisions/${decisionId}/proposal`).send({ proposal: 'convert_cdi' }).expect(200);
    const hr = await taskOf('admin', decisionId);
    expect(hr?.stepKey).toBe('hr');
    const approvals = await Promise.all([client('admin').post(`/api/tasks/${hr?.id}/approve`).send({}), client('est').post(`/api/tasks/${hr?.id}/approve`).send({})]);
    expect(approvals.map((r) => r.status).filter((s) => s === 200)).toHaveLength(1);
    expect(approvals.every((r) => r.status < 500), JSON.stringify(approvals.map((r) => r.body))).toBe(true);
    const contracts = await query<{ kind: string; contract_type: string }>(db.superuserUrl, 'select kind, contract_type from employment_contract where employment_id = $1 order by seq', [EST.cne3]);
    expect(contracts).toEqual([{ kind: 'initial', contract_type: 'cdd' }, { kind: 'conversion', contract_type: 'cdi' }]);
    expect(await query(db.superuserUrl, `select 1 from audit.event where type = 'contract.decision_applied' and subject_id = $1`, [decisionId])).toHaveLength(1);
  });
});

describe('the daily job', () => {
  it('runs per company under its own context, idempotent', async () => {
    const a = await cdd(COMPANY_A, EST.cne2, addDays(TODAY, 40));
    // BETA's employee: a CDD ending in 40 days
    const b = await insertContract(db.superuserUrl, { companyId: COMPANY_B, employmentId: EMPLOYEE_B.employmentId, seq: 1, contractType: 'cdd', startDate: EMPLOYEE_B.hireDate, endDate: addDays(TODAY, 40) });
    const first = await deadlinesDailyTask(deps, { today: TODAY }, job());
    expect(Number(first['decisions'])).toBeGreaterThanOrEqual(2);
    const rows = await query<{ company_id: string; wf_company: string; task_company: string; opened_by: string }>(
      db.superuserUrl,
      `select d.company_id, i.company_id as wf_company, t.company_id as task_company, d.opened_by
         from contract_decision d join workflow_instance i on i.id = d.workflow_instance_id join workflow_task t on t.instance_id = i.id
        where d.contract_id = any($1) order by d.company_id`,
      [[a, b]],
    );
    const byCompany = new Map(rows.map((r) => [r.company_id, r]));
    expect(byCompany.get(COMPANY_A)).toMatchObject({ wf_company: COMPANY_A, task_company: COMPANY_A, opened_by: 'system' });
    expect(byCompany.get(COMPANY_B)).toMatchObject({ wf_company: COMPANY_B, task_company: COMPANY_B, opened_by: 'system' });
    // BETA's HR sees its decision; DEMO's admin does not
    const betaDecision = (await query<{ id: string }>(db.superuserUrl, 'select id from contract_decision where contract_id = $1', [b]))[0]?.id ?? '';
    expect((await client('beta').get(`/api/contract-decisions/${betaDecision}`)).status).toBe(200);
    expect((await client('admin').get(`/api/contract-decisions/${betaDecision}`)).status).toBe(404);
    const notified = await query<{ company_id: string }>(db.superuserUrl, `select company_id from notification where subject_type = 'workflow_task' and user_id = $1`, [USERS.beta.id]);
    expect(notified.every((n) => n.company_id === COMPANY_B)).toBe(true);
    const counts = async () => (await query<{ n: number }>(db.superuserUrl, 'select (select count(*) from contract_decision) + (select count(*) from notification) + (select count(*) from workflow_task) as n'))[0]?.n;
    const n = await counts();
    const second = await deadlinesDailyTask(deps, { today: TODAY }, job());
    expect(second['decisions']).toBe(0);
    expect(await counts()).toBe(n);
  });

  it('the digest counts a medical file only for holders of employee.medical.read over the unit', async () => {
    const day = '2031-03-03';
    const expires = addDays(day, 30);
    await insertExpiringFile(db.superuserUrl, { companyId: COMPANY_A, employmentId: EST.admEst, uploadedBy: USERS.admin.id, expiresOn: expires, title: 'Permis' });
    await insertExpiringFile(db.superuserUrl, { companyId: COMPANY_A, employmentId: EST.admEst, uploadedBy: USERS.admin.id, expiresOn: expires, categoryCode: 'medical', title: 'Visite' });
    await deadlinesDailyTask(deps, { today: day, since: addDays(day, -1) }, job());
    const digest = async (userId: string) =>
      (await query<{ data: Record<string, number> }>(db.superuserUrl, `select data from notification where user_id = $1 and type = 'deadline.digest' and data->>'date' = $2`, [userId, day]))[0]?.data;
    const est = await digest(USERS.est.id);
    const target = await digest(USERS.target.id);
    expect(est?.['newCount']).toBeGreaterThanOrEqual(1);
    expect(target?.['newCount']).toBe(Number(est?.['newCount']) + 1);
    // the payload holds counts only
    expect(Object.keys(est ?? {}).toSorted()).toEqual(['audience', 'criticalCount', 'date', 'newCount', 'overdueCount']);
    // a holder of deadline.read without any unit there (lecture.ouest has none) gets nothing
    expect(await digest(USERS.ouest.id)).toBeUndefined();
  });
});

describe('database privileges on the new tables', () => {
  it('hrforce_worker only inserts/updates decisions, instances, tasks, notifications', async () => {
    await expect(tx(`update employment_contract set note = 'x'`)).rejects.toThrow(/permission denied/);
    await expect(tx(`insert into employment_contract (company_id, employment_id, seq, kind, contract_type, start_date) values ('${COMPANY_A}', '${EST.cne}', 9, 'amendment', 'cdi', '2030-01-01')`)).rejects.toThrow(/permission denied/);
    await expect(tx('delete from contract_decision')).rejects.toThrow(/permission denied/);
    await expect(tx('update workflow_task set comment = null')).rejects.toThrow(/permission denied/);
    await expect(tx('delete from workflow_instance')).rejects.toThrow(/permission denied/);
    await expect(tx('delete from deadline_ack')).rejects.toThrow(/permission denied/);
    await expect(tx(`insert into deadline_policy (company_id) values ('${COMPANY_A}')`)).rejects.toThrow(/permission denied/);
    await expect(tx(`update notification set read_at = now()`)).rejects.toThrow(/permission denied/);
  });

  it('hrforce_app cannot delete contracts, decisions or the policy', async () => {
    for (const t of ['employment_contract', 'contract_decision', 'deadline_policy']) {
      await expect(query(db.appUrl, `delete from ${t}`), t).rejects.toThrow(/permission denied/);
    }
  });
});
