/**
 * Leave + workflow slice (docs/contracts/leave.md, ADR 006) against the real grants (DEV_AUTH header identity, no
 * DEV_PERMISSIONS) and the leave demo seed (without requests): the manager → HR chain, candidates at read time,
 * separation of duties, escalation, concurrency, the 409 slugs, scope, cancellation with reversal, accruals, and the
 * database backstops (append-only ledger, immutable task history).
 * "Today" is pinned to 2026-09-26 (LeaveClock / StaffingClock).
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { demoEmployment, LeaveClock } from '../src/modules/leave/index.js';
import { StaffingClock } from '../src/modules/staffing/index.js';
import { as, COMPANY_A, employeeA, seedAccessFixture, unitA, USERS, type ActorName } from './support/access-fixture.js';
import { assertNoSecrets } from './support/assert-no-secrets.js';
import { createTestApp } from './support/test-app.js';
import { createTestDatabase, query, type TestDatabase } from './support/test-database.js';
import { fetchXsrf, type XsrfPair } from './support/xsrf.js';

const TODAY = '2026-09-26';

interface Task {
  id: string;
  stepKey: string;
  escalated: boolean;
  subject: { id: string; startDate: string; days: number; employee: { id: string } };
}
interface Detail {
  id: string;
  status: string;
  days: number;
  workflow: { status: string; currentStep: number | null; steps: { key: string; state: string }[] };
  history: { stepKey: string; status: string; outcome: string | null; comment: string | null; assignee: { kind: string; user?: { id: string } } }[];
  _actions: string[];
}
interface Balance {
  leaveTypeCode: string;
  periodStart: string;
  availableFrom: string;
  accrued: number;
  taken: number;
  balance: number;
  pending: number;
  available: number;
}

let db: TestDatabase;
let app: NestExpressApplication;
let xsrf: XsrfPair;
let types: Record<string, string> = {};

const client = (actor: ActorName) => as(app, actor, xsrf);
const req = (type: string, startDate: string, endDate: string, extra: object = {}) => ({ leaveTypeId: types[type], startDate, endDate, ...extra });

async function tasksOf(actor: ActorName): Promise<Task[]> {
  const res = await client(actor).get('/api/tasks').expect(200);
  return res.body.items as Task[];
}

async function taskFor(actor: ActorName, requestId: string): Promise<Task | undefined> {
  return (await tasksOf(actor)).find((t) => t.subject.id === requestId);
}

async function annual(actor: ActorName): Promise<Balance[]> {
  const res = await client(actor).get('/api/me/leave/balances').expect(200);
  return (res.body.items as Balance[]).filter((b) => b.leaveTypeCode === 'annual');
}

beforeAll(async () => {
  db = await createTestDatabase();
  await seedAccessFixture(db, undefined, { leave: true });
  const pinned = { today: () => TODAY };
  app = await createTestApp(db, {
    devAuth: true,
    devPermissions: false,
    overrides: [
      { provide: LeaveClock, useValue: pinned },
      { provide: StaffingClock, useValue: pinned },
    ],
  });
  xsrf = await fetchXsrf(app);
  const res = await client('agent').get('/api/leave/types').expect(200);
  types = Object.fromEntries((res.body.items as { code: string; id: string }[]).map((t) => [t.code, t.id]));
});

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

describe('self-service basics', () => {
  it('GET /me/employment: the linked employee and today’s manager; 404 without a link', async () => {
    const res = await client('agent').get('/api/me/employment').expect(200);
    expect(res.body).toMatchObject({ id: demoEmployment(30), unit: { code: 'AG-ANNABA' }, manager: { id: demoEmployment(29) } });
    await client('admin').get('/api/me/employment').expect(404);
  });

  it('balances per reference year: 2025-26 (30 days, usable from 1 July 2026) and 2026-27 (accruing)', async () => {
    const b = await annual('agent');
    expect(b).toEqual([
      expect.objectContaining({ periodStart: '2025-07-01', availableFrom: '2026-07-01', accrued: 30, balance: 30, available: 30, pending: 0 }),
      expect.objectContaining({ periodStart: '2026-07-01', availableFrom: '2027-07-01', accrued: 7.5, balance: 7.5, available: 0 }),
    ]);
  });

  it('reference data: 11 types, holidays with approximate lunar dates, policy', async () => {
    expect(Object.keys(types)).toHaveLength(11);
    const h = await client('agent').get('/api/leave/holidays?year=2026').expect(200);
    const items = h.body.items as { date: string; approximate: boolean; labels: { ar: string } }[];
    expect(items.find((x) => x.date === '2026-11-01')).toMatchObject({ approximate: false });
    expect(items.some((x) => x.approximate)).toBe(true);
    expect((await client('agent').get('/api/leave/policy').expect(200)).body).toEqual({ referenceStartMonth: 7, weekendDays: [5, 6], entitlementDelayMonths: 12 });
  });
});

describe('manager → HR chain', () => {
  let requestId = '';

  it('agent.annaba previews then requests annual leave → a task for chef.annaba (manager)', async () => {
    const preview = await client('agent').post('/api/leave/preview').send(req('annual', '2026-11-15', '2026-11-19')).expect(200);
    expect(preview.body).toMatchObject({ days: 5, balanceAfter: 25, warnings: [], breakdown: { calendarDays: 5, weekendDays: 0 } });
    const res = await client('agent').post('/api/me/leave/requests').send(req('annual', '2026-11-15', '2026-11-19', { reason: 'Famille' })).expect(201);
    assertNoSecrets(res.body);
    const detail = res.body as Detail;
    requestId = detail.id;
    expect(detail).toMatchObject({ status: 'pending', days: 5, workflow: { status: 'pending', currentStep: 0 }, _actions: ['cancel'] });
    expect(detail.workflow.steps.map((s) => s.state)).toEqual(['current', 'pending']);
    expect(detail.history[0]).toMatchObject({ stepKey: 'manager', status: 'open', assignee: { kind: 'user', user: { id: USERS.chef.id } } });
    expect(await taskFor('chef', requestId)).toMatchObject({ stepKey: 'manager', subject: { days: 5, employee: { id: demoEmployment(30) } } });
    for (const actor of ['est', 'admin', 'agent', 'ouest'] as const) expect(await taskFor(actor, requestId), actor).toBeUndefined();
    // pending days count against the available balance
    expect((await annual('agent'))[0]).toMatchObject({ pending: 5, available: 25 });
  });

  it('chef approves → an HR task that rh.est and rh.admin see (lecture.ouest does not)', async () => {
    const task = await taskFor('chef', requestId);
    const res = await client('chef').post(`/api/tasks/${task?.id}/approve`).send({}).expect(200);
    expect(res.body.workflow.steps.map((s: { state: string }) => s.state)).toEqual(['done', 'current']);
    expect(await taskFor('est', requestId)).toMatchObject({ stepKey: 'hr', escalated: false });
    expect(await taskFor('admin', requestId)).toMatchObject({ stepKey: 'hr' });
    for (const actor of ['ouest', 'chef', 'agent', 'acces'] as const) expect(await taskFor(actor, requestId), actor).toBeUndefined();
    // the manager's task is closed: acting again → 409; a non-candidate → 404
    await client('chef').post(`/api/tasks/${task?.id}/approve`).send({}).expect(409);
    await client('ouest').post(`/api/tasks/${task?.id}/approve`).send({}).expect(404);
    // a candidate reads the request
    await client('est').get(`/api/leave/requests/${requestId}`).expect(200);
  });

  it('rh.est approves → approved, a taken row against 2025-26, balance 25', async () => {
    const task = await taskFor('est', requestId);
    await client('ouest').post(`/api/tasks/${task?.id}/approve`).send({}).expect(404);
    const res = await client('est').post(`/api/tasks/${task?.id}/approve`).send({ comment: 'OK' }).expect(200);
    expect(res.body.workflow).toMatchObject({ status: 'approved', currentStep: null });
    const detail = (await client('agent').get(`/api/leave/requests/${requestId}`).expect(200)).body as Detail;
    expect(detail.status).toBe('approved');
    const ledger = await query<{ kind: string; days: string; period_start: string }>(
      db.superuserUrl,
      `select kind, days::text, period_start::text from leave_ledger where request_id = $1`,
      [requestId],
    );
    expect(ledger).toEqual([{ kind: 'taken', days: '-5.0', period_start: '2025-07-01' }]);
    expect((await annual('agent'))[0]).toMatchObject({ taken: -5, balance: 25, available: 25, pending: 0 });
    const events = await query<{ type: string }>(db.superuserUrl, `select type from audit.event where subject_id = $1 order by id`, [requestId]);
    expect(events.map((e) => e.type)).toEqual(['workflow.start', 'workflow.approve', 'workflow.approve']);
  });

  it('cancelling the approved future request writes a reversal; a second cancel → 409', async () => {
    const res = await client('agent').post(`/api/me/leave/requests/${requestId}/cancel`).expect(200);
    expect(res.body).toMatchObject({ status: 'cancelled', _actions: [] });
    const ledger = await query<{ kind: string; days: string }>(db.superuserUrl, `select kind, days::text from leave_ledger where request_id = $1 order by created_at, kind`, [requestId]);
    expect(ledger.map((l) => `${l.kind}:${l.days}`).toSorted()).toEqual(['reversal:5.0', 'taken:-5.0']);
    expect((await annual('agent'))[0]).toMatchObject({ balance: 30, available: 30 });
    const again = await client('agent').post(`/api/me/leave/requests/${requestId}/cancel`).expect(409);
    expect(again.body.type).toBe('urn:hrforce:problem:leave-not-cancellable');
    // someone else's request → 404
    await client('chef').post(`/api/me/leave/requests/${requestId}/cancel`).expect(404);
  });

  it('reject needs a comment', async () => {
    const created = await client('agent').post('/api/me/leave/requests').send(req('annual', '2026-12-06', '2026-12-07')).expect(201);
    const task = await taskFor('chef', created.body.id);
    const bad = await client('chef').post(`/api/tasks/${task?.id}/reject`).send({}).expect(422);
    expect(bad.body.errors[0]).toMatchObject({ field: 'comment', code: 'required' });
    const res = await client('chef').post(`/api/tasks/${task?.id}/reject`).send({ comment: 'Période chargée' }).expect(200);
    expect(res.body.workflow.status).toBe('rejected');
    expect((await client('agent').get(`/api/leave/requests/${created.body.id}`).expect(200)).body).toMatchObject({ status: 'rejected' });
  });
});

describe('separation of duties and escalation', () => {
  it('the chef heads his own unit: his manager step goes to the head of Région Est (Karim), never to himself', async () => {
    const res = await client('chef').post('/api/me/leave/requests').send(req('annual', '2026-10-11', '2026-10-12')).expect(201);
    expect((res.body as Detail).history[0]).toMatchObject({ stepKey: 'manager', assignee: { kind: 'user', user: { id: USERS.est.id } } });
    expect(await taskFor('chef', res.body.id)).toBeUndefined();
    expect(await taskFor('est', res.body.id)).toMatchObject({ stepKey: 'manager' });
  });

  it('Karim requests his own leave: no manager can act (DG head not linked) → escalated to HR; he cannot approve it (409), rh.admin can', async () => {
    const res = await client('est').post('/api/me/leave/requests').send(req('annual', '2026-10-18', '2026-10-19')).expect(201);
    const detail = res.body as Detail;
    expect(detail.history[0]).toMatchObject({ stepKey: 'manager', status: 'skipped', outcome: 'escalated', comment: 'manager-not-linked' });
    expect(detail.workflow.steps.map((s) => s.state)).toEqual(['escalated', 'current']);
    expect(await taskFor('est', detail.id)).toBeUndefined();
    const adminTask = await taskFor('admin', detail.id);
    expect(adminTask).toMatchObject({ stepKey: 'hr', escalated: true });
    const self = await client('est').post(`/api/tasks/${adminTask?.id}/approve`).send({}).expect(409);
    expect(self.body.type).toBe('urn:hrforce:problem:workflow-self-approval');
    // the database refuses it too
    await expect(
      query(db.superuserUrl, `update workflow_task set status = 'done', outcome = 'approve', acted_by = $1, acted_at = now() where id = $2`, [USERS.est.id, adminTask?.id]),
    ).rejects.toThrow(/own request/);
  });

  it('a manager without a linked user → escalated to HR (on-behalf request for an employee of Agence Constantine)', async () => {
    const res = await client('admin').post(`/api/employees/${employeeA(27)}/leave/requests`).send(req('annual', '2026-10-25', '2026-10-27')).expect(201);
    expect((res.body as Detail).history.map((h) => `${h.stepKey}:${h.status}`)).toEqual(['manager:skipped', 'hr:open']);
    // started by rh.admin: excluded; rh.est (REG-EST) is the candidate
    expect(await taskFor('admin', res.body.id)).toBeUndefined();
    expect(await taskFor('est', res.body.id)).toMatchObject({ escalated: true });
  });

  it('concurrent approvals: one wins, the other gets 409 workflow-task-closed', async () => {
    const other = await client('agent').post('/api/me/leave/requests').send(req('annual', '2026-11-22', '2026-11-23')).expect(201);
    const managerTask = await taskFor('chef', other.body.id);
    await client('chef').post(`/api/tasks/${managerTask?.id}/approve`).send({}).expect(200);
    const hrTask = await taskFor('est', other.body.id);
    const results = await Promise.all([
      client('est').post(`/api/tasks/${hrTask?.id}/approve`).send({}),
      client('admin').post(`/api/tasks/${hrTask?.id}/approve`).send({}),
    ]);
    expect(results.map((r) => r.status).toSorted()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)?.body.type).toBe('urn:hrforce:problem:workflow-task-closed');
    const taken = await query<{ n: number }>(db.superuserUrl, `select count(*)::int as n from leave_ledger where request_id = $1`, [other.body.id]);
    expect(taken[0]?.n).toBe(1);
  });
});

const slug = (res: { body: { type?: string } }) => res.body.type?.replace('urn:hrforce:problem:', '');

describe('validation slugs', () => {
  it('overlap, balance, max per request, once per career, document, dates, not linked, inactive type', async () => {
    await client('agent').post('/api/me/leave/requests').send(req('annual', '2027-01-10', '2027-01-12')).expect(201);
    expect(slug(await client('agent').post('/api/me/leave/requests').send(req('sick', '2027-01-12', '2027-01-13', { documentRef: 'CM-1' })).expect(409))).toBe('leave-overlap');
    expect(slug(await client('agent').post('/api/me/leave/requests').send(req('annual', '2027-02-01', '2027-03-15')).expect(409))).toBe('leave-balance');
    expect(slug(await client('agent').post('/api/me/leave/requests').send(req('marriage', '2027-02-07', '2027-02-11')).expect(409))).toBe('leave-max-request');
    await client('agent').post('/api/me/leave/requests').send(req('pilgrimage', '2027-05-01', '2027-05-20')).expect(201);
    expect(slug(await client('agent').post('/api/me/leave/requests').send(req('pilgrimage', '2028-05-01', '2028-05-10')).expect(409))).toBe('leave-once-per-career');
    const doc = await client('agent').post('/api/me/leave/requests').send(req('sick', '2027-03-01', '2027-03-02')).expect(409);
    expect(slug(doc)).toBe('leave-document-required');
    expect(doc.body.errors[0].field).toBe('documentRef');
    expect(slug(await client('agent').post('/api/me/leave/requests').send(req('annual', '2027-03-05', '2027-03-01')).expect(409))).toBe('leave-dates');
    expect(slug(await client('agent').post('/api/me/leave/requests').send(req('annual', '2001-03-05', '2001-03-06')).expect(409))).toBe('leave-dates');
    // working mode: a Friday + Saturday only → no counted day
    expect(slug(await client('agent').post('/api/me/leave/requests').send(req('recovery', '2027-01-01', '2027-01-02')).expect(409))).toBe('leave-dates');
    expect(slug(await client('admin').post('/api/me/leave/requests').send(req('annual', '2027-01-10', '2027-01-12')).expect(409))).toBe('leave-not-linked');
    // lecture.ouest has no leave.request_self at all
    await client('ouest').post('/api/me/leave/requests').send(req('annual', '2027-01-10', '2027-01-12')).expect(403);
    await client('agent').post('/api/me/leave/requests').send({ ...req('annual', '2027-01-10', '2027-01-12'), leaveTypeId: '0190a5d0-0000-7000-8000-00000000dead' }).expect(422);
  });

  it('preview reports the would-be slug without writing', async () => {
    const before = await query<{ n: number }>(db.superuserUrl, 'select count(*)::int as n from leave_request');
    const res = await client('agent').post('/api/leave/preview').send(req('annual', '2027-01-11', '2027-01-11')).expect(200);
    expect(res.body.warnings).toEqual(['leave-overlap']);
    const after = await query<{ n: number }>(db.superuserUrl, 'select count(*)::int as n from leave_request');
    expect(after[0]?.n).toBe(before[0]?.n);
    // working-mode preview with the 1 November holiday and a half day
    const work = await client('agent').post('/api/leave/preview').send(req('recovery', '2026-11-01', '2026-11-05', { halfDayEnd: true })).expect(200);
    expect(work.body).toMatchObject({ days: 3.5, breakdown: { calendarDays: 5, holidays: [{ date: '2026-11-01', name: { fr: 'Fête de la Révolution' } }] } });
  });
});

describe('scope', () => {
  let ouestRequest = '';

  it('rh.est cannot read an Ouest request (404), nor act on behalf of an Ouest employee; lecture.ouest has no leave.read', async () => {
    const created = await client('admin').post(`/api/employees/${employeeA(36)}/leave/requests`).send(req('annual', '2026-12-13', '2026-12-14')).expect(201);
    ouestRequest = created.body.id;
    await client('est').get(`/api/leave/requests/${ouestRequest}`).expect(404);
    await client('ouest').get(`/api/leave/requests/${ouestRequest}`).expect(404);
    await client('admin').get(`/api/leave/requests/${ouestRequest}`).expect(200);
    await client('est').post(`/api/employees/${employeeA(36)}/leave/requests`).send(req('annual', '2026-12-20', '2026-12-21')).expect(404);
    await client('est').get(`/api/employees/${employeeA(36)}/leave/balances`).expect(404);
    const list = await client('est').get('/api/leave/requests?status=all&pageSize=100').expect(200);
    const ids = (list.body.items as { id: string; employee: { unit: { code: string } } }[]).map((r) => r.id);
    expect(ids).not.toContain(ouestRequest);
    expect(list.body.total).toBeGreaterThan(0);
    const all = await client('admin').get(`/api/leave/requests?unitId=${unitA('REG-OUEST')}&includeSubUnits=true`).expect(200);
    expect((all.body.items as { id: string }[]).map((r) => r.id)).toEqual([ouestRequest]);
  });

  it('HR employee views: balances, ledger (accruals, taken, reversal), adjustments', async () => {
    const b = await client('est').get(`/api/employees/${demoEmployment(30)}/leave/balances`).expect(200);
    expect((b.body.items as Balance[]).some((x) => x.leaveTypeCode === 'annual')).toBe(true);
    const ledger = await client('est').get(`/api/employees/${demoEmployment(30)}/leave/ledger`).expect(200);
    const kinds = new Set((ledger.body.items as { kind: string }[]).map((l) => l.kind));
    expect([...kinds].toSorted()).toEqual(['accrual', 'reversal', 'taken']);
    await client('est').post(`/api/employees/${demoEmployment(30)}/leave/adjustments`).send({ leaveTypeId: types['recovery'], periodStart: '2026-07-02', days: 2, note: 'x' }).expect(422);
    const adj = await client('est').post(`/api/employees/${demoEmployment(30)}/leave/adjustments`).send({ leaveTypeId: types['recovery'], periodStart: '2026-07-01', days: 2, note: 'Travail du 5 juillet' }).expect(201);
    expect(adj.body).toMatchObject({ kind: 'adjustment', days: 2, createdBy: { id: USERS.est.id } });
    const rec = (await client('agent').get('/api/me/leave/balances').expect(200)).body.items as Balance[];
    expect(rec.find((x) => x.leaveTypeCode === 'recovery')).toMatchObject({ balance: 2, available: 2 });
  });
});

describe('accruals', () => {
  it('idempotent per employee / month; future months refused', async () => {
    const again = await client('admin').post('/api/leave/accruals/run').send({ month: '2026-09' }).expect(200);
    expect(again.body).toMatchObject({ month: '2026-09', created: 0 });
    expect(again.body.alreadyAccrued).toBeGreaterThan(30);
    const first = await client('admin').post('/api/leave/accruals/run').send({ month: '2025-06' }).expect(200);
    expect(first.body.created).toBeGreaterThan(30);
    const second = await client('admin').post('/api/leave/accruals/run').send({ month: '2025-06' }).expect(200);
    expect(second.body).toMatchObject({ created: 0, alreadyAccrued: first.body.created });
    await client('admin').post('/api/leave/accruals/run').send({ month: '2026-10' }).expect(422);
    // rh.est only accrues its region: a fresh month creates rows for Région Est employees only
    const est = await client('est').post('/api/leave/accruals/run').send({ month: '2025-05' }).expect(200);
    expect(est.body.employees).toBeLessThan(20);
    expect(est.body.created).toBeGreaterThan(0);
  });
});

describe('links and heads', () => {
  it('PUT /access/users/:id/employment links / unlinks; self-link and double link refused', async () => {
    const res = await client('admin').put(`/api/access/users/${USERS.newbie.id}/employment`).send({ employmentId: employeeA(31) }).expect(200);
    expect(res.body).toMatchObject({ userId: USERS.newbie.id, employment: { id: employeeA(31) } });
    const user = await client('admin').get(`/api/access/users/${USERS.newbie.id}`).expect(200);
    expect(user.body.employment).toMatchObject({ id: employeeA(31) });
    expect((await client('admin').put(`/api/access/users/${USERS.target.id}/employment`).send({ employmentId: employeeA(31) }).expect(409)).body.type).toContain('employment-linked');
    expect((await client('admin').put(`/api/access/users/${USERS.admin.id}/employment`).send({ employmentId: employeeA(2) }).expect(409)).body.type).toContain('link-self');
    await client('admin').put(`/api/access/users/${USERS.newbie.id}/employment`).send({ employmentId: null }).expect(200);
    expect((await client('admin').get(`/api/access/users/${USERS.newbie.id}`).expect(200)).body.employment).toBeNull();
  });

  it('PUT /org/units/:id/head closes the previous head; the unit detail shows today’s head', async () => {
    const res = await client('admin').put(`/api/org/units/${unitA('AG-ANNABA')}/head`).send({ employmentId: employeeA(31), validFrom: '2027-01-01' }).expect(200);
    expect(res.body.heads.map((h: { validFrom: string; validTo: string | null }) => `${h.validFrom}→${h.validTo}`)).toEqual(['2027-01-01→null', '2026-04-01→2027-01-01']);
    expect(res.body.head.employment.id).toBe(demoEmployment(29));
    const unit = await client('admin').get(`/api/org/units/${unitA('AG-ANNABA')}`).expect(200);
    expect(unit.body.head).toMatchObject({ employmentId: demoEmployment(29), validFrom: '2026-04-01', validTo: '2027-01-01' });
    await client('admin').put(`/api/org/units/${unitA('AG-ANNABA')}/head`).send({ employmentId: employeeA(31), validFrom: '2026-12-01' }).expect(409);
    await client('est').put(`/api/org/units/${unitA('AG-ANNABA')}/head`).send({ employmentId: employeeA(31), validFrom: '2027-02-01' }).expect(403);
  });
});

describe('database backstops (hrforce_app)', () => {
  it('the ledger is append-only and closed tasks are history', async () => {
    await expect(query(db.appUrl, `begin; select set_config('app.company_id', '${COMPANY_A}', true); update leave_ledger set days = 99; commit;`)).rejects.toThrow(/permission denied/);
    await expect(query(db.appUrl, `begin; select set_config('app.company_id', '${COMPANY_A}', true); delete from leave_ledger; commit;`)).rejects.toThrow(/permission denied/);
    await expect(query(db.superuserUrl, `update leave_ledger set note = 'x'`)).rejects.toThrow(/append-only/);
    await expect(query(db.superuserUrl, `update workflow_task set comment = 'x' where status = 'done'`)).rejects.toThrow(/history/);
    await expect(query(db.appUrl, `begin; select set_config('app.company_id', '${COMPANY_A}', true); delete from workflow_task; commit;`)).rejects.toThrow(/permission denied/);
  });

  it('overlapping live requests are refused by the exclusion constraint', async () => {
    const [r] = await query<{ employment_id: string; leave_type_id: string; org_unit_id: string; requested_by: string }>(
      db.superuserUrl,
      `select employment_id, leave_type_id, org_unit_id, requested_by from leave_request where status in ('pending', 'approved') limit 1`,
    );
    const [live] = await query<{ start_date: string }>(db.superuserUrl, `select start_date::text from leave_request where employment_id = $1 and status in ('pending','approved') limit 1`, [r?.employment_id]);
    await expect(
      query(
        db.superuserUrl,
        `insert into leave_request (company_id, employment_id, leave_type_id, org_unit_id, start_date, end_date, days, requested_by)
         values ($1, $2, $3, $4, $5, $5, 1, $6)`,
        [COMPANY_A, r?.employment_id, r?.leave_type_id, r?.org_unit_id, live?.start_date, r?.requested_by],
      ),
    ).rejects.toThrow(/leave_request_no_overlap_ex/);
  });
});
