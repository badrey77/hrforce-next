/**
 * Employment contracts and end-of-contract decisions (docs/contracts/contracts-deadlines.md › Contracts, Contract
 * decisions) against the real grants and the demo seed: the initial contract on POST /employees, renewals /
 * conversions / amendments, corrections, scope, then decisions opened by HR and by the daily job (worker role),
 * proposed by the unit head (chef.annaba), approved by HR — renew, end, reject — and applied atomically.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, openDueContractDecisions, seedContractDefaults } from '../src/modules/contracts/index.js';
import { toIsoDate } from '../src/modules/organization/index.js';
import { createDatabase, type Database } from '../src/platform/db/database.js';
import { inCompany } from '../src/worker/company-loop.js';
import { as, COMPANY_A, COMPANY_B, employeeA, seedAccessFixture, unitA, type ActorName } from './support/access-fixture.js';
import { assertNoSecrets } from './support/assert-no-secrets.js';
import { createTestApp } from './support/test-app.js';
import { createTestDatabase, query, type TestDatabase } from './support/test-database.js';
import { fetchXsrf, type XsrfPair } from './support/xsrf.js';

const TODAY = toIsoDate(new Date());

let db: TestDatabase;
let app: NestExpressApplication;
let xsrf: XsrfPair;
let worker: Database;

const client = (actor: ActorName) => as(app, actor, xsrf);
const slug = (body: { type?: string }) => (body.type ?? '').replace('urn:hrforce:problem:', '');
const errorsOf = (body: { errors?: { field: string; code: string }[] }) => (body.errors ?? []).map((e) => [e.field, e.code]);

interface Contract {
  id: string;
  seq: number;
  kind: string;
  contractType: string;
  startDate: string;
  endDate: string | null;
  probationEnd: string | null;
  reference: string | null;
  current: boolean;
  decision: { id: string } | null;
  pendingDecision: { id: string; status: string } | null;
  _actions: string[];
}
interface Decision {
  id: string;
  status: string;
  proposal: string | null;
  proposedStartDate: string | null;
  proposedEndDate: string | null;
  resultContractId: string | null;
  openedBy: string;
  workflow: { currentStep: number | null; status: string } | null;
  _actions: string[];
}

const contracts = async (employmentId: string, actor: ActorName = 'admin') =>
  (await client(actor).get(`/api/employees/${employmentId}/contracts`).expect(200)).body as { items: Contract[]; currentId: string | null };

async function hireOf(employmentId: string): Promise<string> {
  const [row] = await query<{ d: string }>(db.superuserUrl, `select to_char(hire_date, 'YYYY-MM-DD') as d from employment where id = $1`, [employmentId]);
  return row?.d ?? '';
}

async function initialCdd(employmentId: string, endDate: string, actor: ActorName = 'admin'): Promise<Contract> {
  const res = await client(actor).post(`/api/employees/${employmentId}/contracts`).send({ kind: 'initial', contractType: 'cdd', endDate });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as Contract;
}

/** The open contract-decision task of `actor` for decision `id`. */
async function taskOf(actor: ActorName, decisionId: string): Promise<{ id: string; stepKey: string; subject: Record<string, unknown> } | undefined> {
  const items = (await client(actor).get('/api/tasks?status=open').expect(200)).body.items as { id: string; stepKey: string; subject: { type: string; id: string } & Record<string, unknown> }[];
  return items.find((t) => t.subject.type === 'contract_decision' && t.subject.id === decisionId);
}

beforeAll(async () => {
  db = await createTestDatabase();
  await seedAccessFixture(db, undefined, { leave: true });
  const migrator = createDatabase({ connectionString: db.migratorUrl, maxConnections: 1 });
  await migrator.transaction().execute(async (tx) => {
    await seedContractDefaults(tx, COMPANY_A);
    await seedContractDefaults(tx, COMPANY_B);
  });
  await migrator.destroy();
  app = await createTestApp(db, { devAuth: true, devPermissions: false });
  xsrf = await fetchXsrf(app);
  worker = createDatabase({ connectionString: db.workerUrl, maxConnections: 2, applicationName: 'hrforce-worker-test' });
});

afterAll(async () => {
  await worker?.destroy();
  await app?.close();
  await db?.drop();
});

describe('the initial contract on POST /employees', () => {
  const base = { lastName: 'Contrat', firstName: 'Test', hireDate: TODAY, jobTitle: 'Agent', orgUnitId: unitA('AG-CNE') };

  it('needs an end date for a fixed-term contract (field path contract.endDate)', async () => {
    const res = await client('admin').post('/api/employees').send({ ...base, matricule: 'CTR-0001', contract: { contractType: 'cdd' } });
    expect(res.status).toBe(422);
    expect(errorsOf(res.body)).toEqual([['contract.endDate', 'required']]);
    // nothing was written
    expect(await query(db.superuserUrl, `select 1 from employment where matricule = 'CTR-0001'`)).toHaveLength(0);
    const unknown = await client('admin').post('/api/employees').send({ ...base, matricule: 'CTR-0001', contract: { contractType: 'cdd', endDate: addDays(TODAY, 30), extra: 1 } });
    expect(unknown.status).toBe(422);
  });

  it('creates the initial contract on the hire date; the list and the detail show it', async () => {
    const res = await client('admin')
      .post('/api/employees')
      .send({ ...base, matricule: 'CTR-0002', contract: { contractType: 'cdd', endDate: addDays(TODAY, 300), probationEnd: addDays(TODAY, 30), reference: ' CDD-2026-7 ' } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.contract).toEqual({ type: 'cdd', endDate: addDays(TODAY, 300), probationEnd: addDays(TODAY, 30) });
    expect(res.body['_actions']).toContain('manage_contract');
    const list = await contracts(res.body.id);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ seq: 1, kind: 'initial', contractType: 'cdd', startDate: TODAY, reference: 'CDD-2026-7', current: true, _actions: ['edit'], pendingDecision: null });
    expect(list.currentId).toBe(list.items[0]?.id);
    assertNoSecrets(list);
    const found = (await client('admin').get('/api/employees?q=CTR-0002').expect(200)).body.items[0];
    expect(found.contract).toEqual({ type: 'cdd', endDate: addDays(TODAY, 300), probationEnd: addDays(TODAY, 30) });
    const cdd = (await client('admin').get(`/api/employees?contractType=cdd&unitId=${unitA('AG-CNE')}`).expect(200)).body.items as { matricule: string }[];
    expect(cdd.map((e) => e.matricule)).toContain('CTR-0002');
    const none = (await client('admin').get(`/api/employees?contractType=none&unitId=${unitA('AG-CNE')}`).expect(200)).body.items as { matricule: string }[];
    expect(none.map((e) => e.matricule)).not.toContain('CTR-0002');
  });
});

describe('POST / PATCH /employees/:id/contracts', () => {
  it('renews from the day after, converts, amends; refuses what breaks the rules', async () => {
    const id = employeeA(23);
    const hire = await hireOf(id);
    expect((await contracts(id)).items).toEqual([]);
    const first = await initialCdd(id, addDays(TODAY, 100), 'est');
    // a second initial → 409; a renewal that does not follow → 422; another type → 422
    expect(slug((await client('est').post(`/api/employees/${id}/contracts`).send({ kind: 'initial', contractType: 'cdi' })).body)).toBe('contract-initial-exists');
    const gap = await client('est').post(`/api/employees/${id}/contracts`).send({ kind: 'renewal', contractType: 'cdd', startDate: addDays(TODAY, 102), endDate: addDays(TODAY, 200) });
    expect(errorsOf(gap.body)).toEqual([['startDate', 'must_follow_previous']]);
    const otherType = await client('est').post(`/api/employees/${id}/contracts`).send({ kind: 'renewal', contractType: 'stage', startDate: addDays(TODAY, 101), endDate: addDays(TODAY, 200) });
    expect(errorsOf(otherType.body)).toEqual([['contractType', 'must_match_previous']]);
    const renewal = await client('est').post(`/api/employees/${id}/contracts`).send({ kind: 'renewal', contractType: 'cdd', startDate: addDays(TODAY, 101), endDate: addDays(TODAY, 200) });
    expect(renewal.status).toBe(201);
    expect(renewal.body).toMatchObject({ seq: 2, kind: 'renewal', current: false });
    // a conversion inside the renewal cuts it the day before
    const conversion = await client('est').post(`/api/employees/${id}/contracts`).send({ kind: 'conversion', contractType: 'cdi', startDate: addDays(TODAY, 150), probationEnd: addDays(TODAY, 240) });
    expect(conversion.status, JSON.stringify(conversion.body)).toBe(201);
    const list = await contracts(id);
    expect(list.items.map((c) => [c.seq, c.kind, c.contractType, c.startDate, c.endDate])).toEqual([
      [3, 'conversion', 'cdi', addDays(TODAY, 150), null],
      [2, 'renewal', 'cdd', addDays(TODAY, 101), addDays(TODAY, 149)],
      [1, 'initial', 'cdd', hire, addDays(TODAY, 100)],
    ]);
    expect(list.currentId).toBe(first.id);
    // only the latest one is editable
    expect(list.items.map((c) => c['_actions'])).toEqual([['edit'], [], []]);
    expect(slug((await client('est').patch(`/api/employees/${id}/contracts/${first.id}`).send({ reference: 'X' })).body)).toBe('contract-not-latest');
    const latest = list.items[0]?.id ?? '';
    const patched = await client('est').patch(`/api/employees/${id}/contracts/${latest}`).send({ reference: 'CDI-23', note: 'Signé' });
    expect(patched.body).toMatchObject({ reference: 'CDI-23', note: 'Signé' });
    const cleared = await client('est').patch(`/api/employees/${id}/contracts/${latest}`).send({ reference: null, probationEnd: null });
    expect(cleared.body).toMatchObject({ reference: null, probationEnd: null, note: 'Signé' });
    expect(errorsOf((await client('est').patch(`/api/employees/${id}/contracts/${latest}`).send({ endDate: addDays(TODAY, 400) })).body)).toEqual([['endDate', 'not_allowed']]);
    // an amendment of a CDI (new terms on a permanent contract) ends the superseded CDI the day before (verification
    // 2026-10-19: this was a 500, the check constraint refused a CDI with an end date)
    const amendment = await client('est').post(`/api/employees/${id}/contracts`).send({ kind: 'amendment', contractType: 'cdi', startDate: addDays(TODAY, 300), note: 'Nouveau poste' });
    expect(amendment.status, JSON.stringify(amendment.body)).toBe(201);
    expect((await contracts(id)).items.slice(0, 2).map((c) => [c.seq, c.kind, c.contractType, c.startDate, c.endDate])).toEqual([
      [4, 'amendment', 'cdi', addDays(TODAY, 300), null],
      [3, 'conversion', 'cdi', addDays(TODAY, 150), addDays(TODAY, 299)],
    ]);
    // the audit trail has the rows
    const audited = await query(db.superuserUrl, `select 1 from audit.change_log where table_name = 'employment_contract' and row_id = $1`, [latest]);
    expect(audited.length).toBeGreaterThanOrEqual(3);
  });

  it('scope: another region is 404, read-only is 403 on writes, another company 404', async () => {
    const ouest = employeeA(36);
    expect((await client('est').get(`/api/employees/${ouest}/contracts`)).status).toBe(404);
    expect((await client('ouest').get(`/api/employees/${ouest}/contracts`)).status).toBe(200);
    expect((await client('ouest').post(`/api/employees/${ouest}/contracts`).send({ kind: 'initial', contractType: 'cdi' })).status).toBe(403);
    expect((await client('beta').get(`/api/employees/${ouest}/contracts`)).status).toBe(404);
    expect((await client('est').get(`/api/employees/not-a-uuid/contracts`)).status).toBe(404);
  });
});

describe('end-of-contract decisions', () => {
  it('HR opens one; the unit head proposes a renewal; HR approves; the renewal contract exists', async () => {
    const id = employeeA(31);
    const contract = await initialCdd(id, addDays(TODAY, 30));
    const opened = await client('est').post(`/api/employees/${id}/contracts/${contract.id}/decision`);
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const decision = opened.body as Decision;
    expect(decision).toMatchObject({ status: 'pending', proposal: null, openedBy: 'user', workflow: { currentStep: 0 } });
    expect(slug((await client('est').post(`/api/employees/${id}/contracts/${contract.id}/decision`)).body)).toBe('contract-decision-pending');
    expect((await contracts(id)).items[0]?.pendingDecision).toEqual({ id: decision.id, status: 'pending' });

    // the manager step: chef.annaba (head of Agence Annaba)
    const task = await taskOf('chef', decision.id);
    expect(task?.stepKey).toBe('manager');
    expect(task?.subject).toMatchObject({ id: decision.id, contract: { contractType: 'cdd', endDate: addDays(TODAY, 30) }, proposal: null });
    expect(slug((await client('chef').post(`/api/tasks/${task?.id}/approve`).send({})).body)).toBe('contract-decision-no-proposal');
    // someone else cannot propose (est can read the employee → 403, beta → 404)
    expect(slug((await client('est').put(`/api/contract-decisions/${decision.id}/proposal`).send({ proposal: 'end' })).body)).toBe('contract-decision-not-assignee');
    expect((await client('beta').put(`/api/contract-decisions/${decision.id}/proposal`).send({ proposal: 'end' })).status).toBe(404);
    expect(errorsOf((await client('chef').put(`/api/contract-decisions/${decision.id}/proposal`).send({ proposal: 'renew' })).body)).toEqual([['proposedEndDate', 'required']]);
    const proposed = await client('chef').put(`/api/contract-decisions/${decision.id}/proposal`).send({ proposal: 'renew', proposedEndDate: addDays(TODAY, 210), comment: 'Bon élément' });
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(200);
    expect(proposed.body).toMatchObject({ proposal: 'renew', proposedStartDate: addDays(TODAY, 31), proposedEndDate: addDays(TODAY, 210), _actions: ['propose'] });
    expect((await client('chef').get(`/api/contract-decisions/${decision.id}`)).status).toBe(200);
    expect((await client('chef').post(`/api/tasks/${task?.id}/approve`).send({})).status).toBe(200);

    // the HR step: rh.est approves → the renewal is applied
    const hrTask = await taskOf('est', decision.id);
    expect(hrTask?.stepKey).toBe('hr');
    expect((await client('chef').get(`/api/contract-decisions/${decision.id}`)).status).toBe(404);
    expect((await client('est').post(`/api/tasks/${hrTask?.id}/approve`).send({})).status).toBe(200);
    const after = (await client('est').get(`/api/contract-decisions/${decision.id}`).expect(200)).body as Decision;
    expect(after).toMatchObject({ status: 'approved', workflow: { status: 'approved' } });
    const list = await contracts(id);
    expect(list.items[0]).toMatchObject({ seq: 2, kind: 'renewal', contractType: 'cdd', startDate: addDays(TODAY, 31), endDate: addDays(TODAY, 210), decision: { id: decision.id } });
    expect(after.resultContractId).toBe(list.items[0]?.id);
    expect(list.items[1]?.pendingDecision).toEqual({ id: decision.id, status: 'approved' });
    const events = await query<{ type: string }>(db.superuserUrl, `select type from audit.event where subject_type = 'contract_decision' and subject_id = $1 order by at, id`, [decision.id]);
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['contract.decision_opened', 'contract.decision_applied']));
  });

  it('an approved « end » records the end of employment at the contract end; a rejection applies nothing', async () => {
    const endId = employeeA(32);
    const ending = await initialCdd(endId, addDays(TODAY, 12));
    const decision = (await client('admin').post(`/api/employees/${endId}/contracts/${ending.id}/decision`).expect(201)).body as Decision;
    await client('chef').put(`/api/contract-decisions/${decision.id}/proposal`).send({ proposal: 'end' }).expect(200);
    await client('chef').post(`/api/tasks/${(await taskOf('chef', decision.id))?.id}/approve`).send({}).expect(200);
    await client('admin').post(`/api/tasks/${(await taskOf('admin', decision.id))?.id}/approve`).send({}).expect(200);
    const employee = (await client('admin').get(`/api/employees/${endId}`).expect(200)).body as { endDate: string; endReason: string };
    expect(employee).toMatchObject({ endDate: addDays(TODAY, 12), endReason: 'end_of_contract' });

    const rejectId = employeeA(33);
    const contract = await initialCdd(rejectId, addDays(TODAY, 20));
    const rejected = (await client('admin').post(`/api/employees/${rejectId}/contracts/${contract.id}/decision`).expect(201)).body as Decision;
    await client('chef').put(`/api/contract-decisions/${rejected.id}/proposal`).send({ proposal: 'convert_cdi' }).expect(200);
    await client('chef').post(`/api/tasks/${(await taskOf('chef', rejected.id))?.id}/approve`).send({}).expect(200);
    // HR may change the proposal at its step, then rejects
    await client('admin').put(`/api/contract-decisions/${rejected.id}/proposal`).send({ proposal: 'renew', proposedEndDate: addDays(TODAY, 100) }).expect(200);
    await client('admin').post(`/api/tasks/${(await taskOf('admin', rejected.id))?.id}/reject`).send({ comment: 'À revoir' }).expect(200);
    expect(((await client('admin').get(`/api/contract-decisions/${rejected.id}`).expect(200)).body as Decision).status).toBe('rejected');
    expect((await contracts(rejectId)).items).toHaveLength(1);
  });

  it('refuses a decision about a CDI, and about a contract another follows', async () => {
    const id = employeeA(34);
    const cdi = (await client('admin').post(`/api/employees/${id}/contracts`).send({ kind: 'initial', contractType: 'cdi' }).expect(201)).body as Contract;
    expect(slug((await client('admin').post(`/api/employees/${id}/contracts/${cdi.id}/decision`)).body)).toBe('contract-not-fixed-term');
    expect((await client('ouest').post(`/api/employees/${id}/contracts/${cdi.id}/decision`)).status).toBe(403);
  });

  it('the daily job opens the due decisions as the system, once', async () => {
    const id = employeeA(27);
    await initialCdd(id, addDays(TODAY, 40));
    const run = () => inCompany(worker, COMPANY_A, 'job:deadlines.daily:test', () => openDueContractDecisions(worker, COMPANY_A, TODAY));
    // EMP-0027 (ends in 40 days ≤ 45); EMP-0031's renewal is far, EMP-0033's contract was decided (rejected)
    expect(await run()).toBe(1);
    expect(await run()).toBe(0);
    const [row] = await query<{ id: string; opened_by: string; started_by: string; tasks: number }>(
      db.superuserUrl,
      `select d.id, d.opened_by, i.started_by::text as started_by, (select count(*)::int from workflow_task t where t.instance_id = i.id) as tasks
         from contract_decision d join workflow_instance i on i.id = d.workflow_instance_id where d.employment_id = $1`,
      [id],
    );
    expect(row).toMatchObject({ opened_by: 'system', started_by: '00000000-0000-0000-0000-000000000000' });
    expect(row?.tasks).toBeGreaterThanOrEqual(1);
    const view = (await client('admin').get(`/api/contract-decisions/${row?.id}`).expect(200)).body as Decision;
    expect(view).toMatchObject({ status: 'pending', openedBy: 'system' });
    // nothing for BETA
    expect(await inCompany(worker, COMPANY_B, 'job:test', () => openDueContractDecisions(worker, COMPANY_B, TODAY))).toBe(0);
  });
});
