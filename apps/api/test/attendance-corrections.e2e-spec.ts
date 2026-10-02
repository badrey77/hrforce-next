/**
 * Attendance, Phase B (docs/contracts/attendance.md › Phase B): punch corrections through the workflow engine (request
 * validation, the manager → HR chain and the hr_only switch, separation of duties, approval applying adds / voids
 * atomically, stale targets, rejection and cancellation, notifications, audit events without personal payload, the
 * timeline), the HR list and detail, the monthly report and its CSV export, the retention of corrections, and the scan
 * receipt preview used by the /punch one-tap confirmation.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { algiersDate, AttendanceClock, DEMO_KIOSKS } from '../src/modules/attendance/index.js';
import { createDatabase } from '../src/platform/db/database.js';
import { attendanceRetentionTask } from '../src/worker/tasks.js';
import { companyOf, COMPANY_A, employeeA, seedAccessFixture, unitA, USERS, type ActorName } from './support/access-fixture.js';
import { assertNoSecrets } from './support/assert-no-secrets.js';
import { scanReceipt } from './support/attendance-fixture.js';
import { createTestApp } from './support/test-app.js';
import { createTestDatabase, query, type TestDatabase } from './support/test-database.js';
import { fetchXsrf, type XsrfPair } from './support/xsrf.js';

/** Wednesday 2026-09-30, 10:00 in Algiers. */
const NOW = Date.parse('2026-09-30T09:00:00Z');
const clock = {
  pinned: NOW as number | null,
  nowMs(): number {
    return this.pinned ?? Date.now();
  },
  today(): string {
    return algiersDate(this.nowMs());
  },
};

let db: TestDatabase;
let app: NestExpressApplication;
let xsrf: XsrfPair;

const PROBLEM = (slug: string) => `urn:hrforce:problem:${slug}`;
const AGENT = employeeA(30);
const EST_UNITS = new Set(['AG-CNE', 'AG-ANNABA', 'SRV-CLI-ANB', 'SRV-ADM-EST', 'REG-EST'].map(unitA));

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

function call(actor: ActorName | null, method: Method, url: string, opts: { cookie?: string; body?: object } = {}) {
  let t = request(app.getHttpServer())[method](url);
  if (actor) t = t.set('X-Dev-User-Id', USERS[actor].id).set('X-Dev-Company-Id', companyOf(actor));
  const cookies = [method === 'get' ? null : xsrf.cookie, opts.cookie ?? null].filter(Boolean).join('; ');
  if (cookies) t = t.set('Cookie', cookies);
  if (method !== 'get') t = t.set('X-XSRF-TOKEN', xsrf.token);
  return opts.body ? t.send(opts.body) : t;
}

const ask = (actor: ActorName, body: object) => call(actor, 'post', '/api/me/attendance/corrections', { body });
const add = (direction: 'in' | 'out', time: string) => ({ action: 'add', direction, time });
const voidOf = (punchId: string) => ({ action: 'void', punchId });

/** A manual punch by SQL (Algiers date + time). */
async function manualPunch(employmentId: string, date: string, time: string, direction: 'in' | 'out'): Promise<string> {
  const [row] = await query<{ id: string }>(
    db.superuserUrl,
    `insert into attendance_punch (company_id, employment_id, direction, occurred_at, source, reason, created_by)
     values ($1, $2, $3, ($4::date + $5::time) at time zone 'Africa/Algiers', 'manual', 'Saisie test', $6) returning id`,
    [COMPANY_A, employmentId, direction, date, time, USERS.admin.id],
  );
  return row?.id ?? '';
}

interface Task {
  id: string;
  stepKey: string;
  escalated: boolean;
  subject: { type: string; id: string } & Record<string, unknown>;
}

async function taskOf(actor: ActorName, correctionId: string): Promise<Task | undefined> {
  const items = (await call(actor, 'get', '/api/tasks').expect(200)).body.items as Task[];
  return items.find((t) => t.subject.id === correctionId);
}

async function notificationsAbout(correctionId: string, taskIds: string[] = []): Promise<{ user_id: string; type: string; data: Record<string, unknown>; id: string }[]> {
  return query(db.superuserUrl, `select id, user_id, type, data from notification where subject_id = any($1) order by created_at, id`, [[correctionId, ...taskIds]]);
}

async function emailJobFor(notificationId: string): Promise<boolean> {
  const rows = await query(db.superuserUrl, `select 1 from graphile_worker._private_jobs where key = $1`, [`notifications.email:${notificationId}`]);
  return rows.length > 0;
}

async function punchesOf(employmentId: string, date: string): Promise<{ id: string; source: string; status: string; direction: string; correction_id: string | null; void_correction_id: string | null; created_by: string | null; voided_by: string | null; void_reason: string | null }[]> {
  return query(db.superuserUrl, `select id, source, status, direction, correction_id, void_correction_id, created_by, voided_by, void_reason from attendance_punch where employment_id = $1 and work_date = $2 order by occurred_at`, [employmentId, date]);
}

/** supertest parser keeping the raw bytes (the CSV's BOM). */
function binary(res: request.Response, cb: (err: Error | null, body: unknown) => void): void {
  const stream = res as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c));
  stream.on('end', () => cb(null, Buffer.concat(chunks)));
}

beforeAll(async () => {
  db = await createTestDatabase();
  await seedAccessFixture(db, undefined, { leave: true, attendance: true });
  app = await createTestApp(db, { devAuth: true, devPermissions: false, overrides: [{ provide: AttendanceClock, useValue: clock }] });
  xsrf = await fetchXsrf(app);
});

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

// ---------------------------------------------------------------------------------------------------------------
describe('request validation', () => {
  it('not linked → 409; the window (30 days back, not in the future, inside the employment) → 409 attendance-correction-date', async () => {
    expect((await ask('admin', { date: '2026-09-28', reason: 'Oubli', changes: [add('in', '08:00')] }).expect(409)).body.type).toBe(PROBLEM('attendance-not-linked'));
    for (const date of ['2026-08-30', '2026-10-01']) {
      const res = await ask('agent', { date, reason: 'Oubli', changes: [add('in', '08:00')] }).expect(409);
      expect(res.body.type, date).toBe(PROBLEM('attendance-correction-date'));
      expect(res.body.errors).toEqual([expect.objectContaining({ field: 'date', code: 'out_of_window' })]);
    }
    // exactly 30 days back is inside the window (then cancelled to keep the day free)
    const ok = await ask('agent', { date: '2026-08-31', reason: 'Oubli', changes: [add('in', '08:00')] }).expect(201);
    await call('agent', 'post', `/api/me/attendance/corrections/${ok.body.id}/cancel`).expect(200);
  });

  it('1–4 changes; an add in the future or at an existing minute; a void of another person’s, a void or an unknown punch; twice the same target', async () => {
    const mine = await manualPunch(AGENT, '2026-09-27', '07:35', 'in');
    const voided = await manualPunch(AGENT, '2026-09-27', '07:40', 'in');
    await query(db.superuserUrl, `update attendance_punch set status = 'void', voided_at = now(), voided_by = $2, void_reason = 'Doublon' where id = $1`, [voided, USERS.admin.id]);
    const other = await manualPunch(employeeA(27), '2026-09-27', '08:00', 'in');
    const cases: [object[], string, string, string?][] = [
      [[], 'changes', 'min_items'],
      [['07:00', '07:10', '07:20', '07:30', '07:50'].map((t) => add('in', t)), 'changes', 'max_items'],
      [[voidOf(other)], 'changes.0.punchId', 'not_found'],
      [[voidOf(voided)], 'changes.0.punchId', 'not_found'],
      [[voidOf(mine), voidOf(mine)], 'changes.1.punchId', 'duplicate'],
      [[add('in', '07:35')], 'changes.0.time', 'exists'],
    ];
    for (const [changes, field, code] of cases) {
      const res = await ask('agent', { date: '2026-09-27', reason: 'Oubli', changes }).expect(422);
      expect(res.body.errors, `${field} ${code}`).toEqual([expect.objectContaining({ field, code })]);
    }
    const future = await ask('agent', { date: '2026-09-30', reason: 'Oubli', changes: [add('out', '10:01')] }).expect(422);
    expect(future.body.errors).toEqual([expect.objectContaining({ field: 'changes.0.time', code: 'future' })]);
    // malformed input: zod 422 before anything else
    await ask('agent', { date: '2026-09-27', reason: 'x', changes: [add('in', '25:00')] }).expect(422);
    const midnight = await ask('agent', { date: '2026-09-27', reason: 'Oubli', changes: [add('in', '24:00')] }).expect(422);
    expect(midnight.body.errors).toEqual([expect.objectContaining({ field: 'changes.0.time', code: 'invalid_time' })]);
    await ask('agent', { date: '2026-09-27', reason: 'Oubli', changes: [{ action: 'void', punchId: 'nope' }] }).expect(422);
  });

  it('one pending request per day → 409 attendance-correction-pending', async () => {
    const first = await ask('agent', { date: '2026-09-24', reason: 'Oubli', changes: [add('in', '07:30')] }).expect(201);
    expect((await ask('agent', { date: '2026-09-24', reason: 'Encore', changes: [add('out', '16:00')] }).expect(409)).body.type).toBe(PROBLEM('attendance-correction-pending'));
    await call('agent', 'post', `/api/me/attendance/corrections/${first.body.id}/cancel`).expect(200);
    await ask('agent', { date: '2026-09-24', reason: 'Encore', changes: [add('out', '16:00')] }).expect(201);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('the chain: manager then HR; approval adds and voids atomically', () => {
  let correctionId = '';
  let wrongIn = '';

  it('agent.annaba asks: manager task to chef.annaba (notified), nothing for HR yet', async () => {
    wrongIn = await manualPunch(AGENT, '2026-09-28', '12:10', 'in');
    await manualPunch(AGENT, '2026-09-28', '16:05', 'out');
    const before = (await call('agent', 'get', '/api/me/attendance/days?from=2026-09-28&to=2026-09-28').expect(200)).body.items[0];
    expect(before).toMatchObject({ status: 'late', arrival: { localTime: '12:10' } });

    const res = await ask('agent', { date: '2026-09-28', reason: 'Badge oublié le matin', changes: [voidOf(wrongIn), add('in', '07:28')] }).expect(201);
    assertNoSecrets(res.body);
    correctionId = res.body.id;
    expect(res.body).toMatchObject({
      date: '2026-09-28',
      status: 'pending',
      reason: 'Badge oublié le matin',
      requestedBy: { id: USERS.agent.id },
      employee: { id: AGENT, matricule: 'EMP-0030', unit: { code: 'AG-ANNABA' } },
      changes: [
        { position: 0, action: 'void', direction: null, time: null, punch: { id: wrongIn, direction: 'in', localTime: '12:10' }, resultPunchId: null },
        { position: 1, action: 'add', direction: 'in', time: '07:28', punch: null, resultPunchId: null },
      ],
      rejectionComment: null,
      _actions: ['cancel'],
    });
    expect(res.body.workflow.steps.map((s: { key: string; state: string }) => `${s.key}:${s.state}`)).toEqual(['manager:current', 'hr:pending']);

    const task = await taskOf('chef', correctionId);
    expect(task).toMatchObject({ stepKey: 'manager', subject: { type: 'attendance_correction', date: '2026-09-28', reason: 'Badge oublié le matin', day: { status: 'late' } } });
    expect(task?.subject['changes']).toHaveLength(2);
    expect(await taskOf('est', correctionId)).toBeUndefined();
    const assigned = (await notificationsAbout(correctionId, [task?.id ?? ''])).filter((n) => n.type === 'task.assigned');
    expect(assigned.map((n) => n.user_id)).toEqual([USERS.chef.id]);
    expect(assigned[0]?.data).toMatchObject({ subjectType: 'attendance_correction', date: '2026-09-28', changes: 2, correctionId, employeeName: expect.any(String) });
    expect(JSON.stringify(assigned[0]?.data)).not.toContain('Badge');
    expect(await emailJobFor(assigned[0]?.id ?? '')).toBe(true);
  });

  it('the requester and people without the permission cannot act; chef approves → the HR task (est and admin notified)', async () => {
    const managerTask = await taskOf('chef', correctionId);
    await call('agent', 'post', `/api/tasks/${managerTask?.id}/approve`, { body: {} }).expect(404);
    await call('est', 'post', `/api/tasks/${managerTask?.id}/approve`, { body: {} }).expect(404); // not the assignee of a manager step
    await call('chef', 'post', `/api/tasks/${managerTask?.id}/approve`, { body: {} }).expect(200);
    const hr = await taskOf('est', correctionId);
    expect(hr).toMatchObject({ stepKey: 'hr' });
    expect(await taskOf('admin', correctionId)).toMatchObject({ stepKey: 'hr' });
    await call('ouest', 'post', `/api/tasks/${hr?.id}/approve`, { body: {} }).expect(404); // lecture: no attendance.manage
    await call('chef', 'post', `/api/tasks/${hr?.id}/approve`, { body: {} }).expect(404);
    const assigned = (await notificationsAbout(correctionId, [hr?.id ?? ''])).filter((n) => n.type === 'task.assigned' && n.data['stepKey'] === 'hr');
    expect(assigned.map((n) => n.user_id).toSorted()).toEqual([USERS.admin.id, USERS.est.id].toSorted());
    // punches are untouched until the final approval
    expect((await punchesOf(AGENT, '2026-09-28')).map((p) => `${p.source}:${p.status}`)).toEqual(['manual:live', 'manual:live']);
  });

  it('est approves: the void and the add happen in the approval transaction; the day recomputes; the employee is notified', async () => {
    const hr = await taskOf('est', correctionId);
    await call('est', 'post', `/api/tasks/${hr?.id}/approve`, { body: {} }).expect(200);
    const punches = await punchesOf(AGENT, '2026-09-28');
    expect(punches).toEqual([
      expect.objectContaining({ source: 'correction', status: 'live', direction: 'in', correction_id: correctionId, created_by: USERS.est.id }),
      expect.objectContaining({ id: wrongIn, source: 'manual', status: 'void', void_correction_id: correctionId, voided_by: USERS.est.id, void_reason: 'Badge oublié le matin' }),
      expect.objectContaining({ source: 'manual', status: 'live', direction: 'out' }),
    ]);
    const [item] = await query<{ result_punch_id: string }>(db.superuserUrl, `select result_punch_id from attendance_correction_item where correction_id = $1 and action = 'add'`, [correctionId]);
    expect(item?.result_punch_id).toBe(punches[0]?.id);

    const day = (await call('agent', 'get', '/api/me/attendance/days?from=2026-09-28&to=2026-09-28').expect(200)).body.items[0];
    expect(day).toMatchObject({ status: 'present', arrival: { localTime: '07:28' }, departure: { localTime: '16:05' } });
    expect(day.flags).toContain('corrected');
    const added = day.punches.find((p: { source: string }) => p.source === 'correction');
    expect(added).toMatchObject({ correctionId, createdBy: { id: USERS.est.id }, reason: null, _actions: [] });
    expect(day.punches.find((p: { id: string }) => p.id === wrongIn)).toMatchObject({ status: 'void', void: { correctionId, reason: 'Badge oublié le matin' } });

    const mine = (await call('agent', 'get', '/api/me/attendance/corrections').expect(200)).body.items.find((c: { id: string }) => c.id === correctionId);
    expect(mine).toMatchObject({ status: 'approved', _actions: [] });
    expect(mine.changes[1].resultPunchId).toBe(punches[0]?.id);

    const approved = (await notificationsAbout(correctionId)).filter((n) => n.type === 'attendance.correction_approved');
    expect(approved.map((n) => n.user_id)).toEqual([USERS.agent.id]);
    expect(approved[0]?.data).toMatchObject({ audience: 'employee', date: '2026-09-28', actorName: expect.any(String) });
    // one job per notification; the worker checks the preference (default off for this type) at send time
    expect(await emailJobFor(approved[0]?.id ?? '')).toBe(true);
    const list = (await call('agent', 'get', '/api/me/notifications').expect(200)).body.items.find((n: { type: string }) => n.type === 'attendance.correction_approved');
    expect(list?.link).toBe(`/me/attendance?correction=${correctionId}`);
  });

  it('audit: correction and item events without the reason, day or times; no change_log copy; punch events; the correction timeline', async () => {
    const events = await query<{ type: string; data: Record<string, unknown>; actor: string | null }>(
      db.superuserUrl,
      `select type, data, actor_user_id as actor from audit.event where subject_type = 'attendance_correction' and subject_id = $1 order by id`,
      [correctionId],
    );
    expect(events.map((e) => e.type)).toEqual([
      'attendance.correction_requested',
      'attendance.correction_item_added',
      'attendance.correction_item_added',
      'workflow.start',
      'workflow.approve',
      'workflow.approve',
      'attendance.correction_approved',
    ]);
    expect(events[1]?.data).toEqual({ position: 0, action: 'void', direction: null });
    expect(events[6]?.actor).toBe(USERS.est.id);
    const text = JSON.stringify(events);
    expect(text).not.toMatch(/Badge|2026-09-28|07:28|12:10/);
    expect(text).not.toContain(AGENT);
    expect(await query(db.superuserUrl, `select 1 from audit.change_log where table_name like 'attendance_correction%'`)).toEqual([]);
    const punchEvents = await query<{ type: string; data: Record<string, unknown> }>(
      db.superuserUrl,
      `select e.type, e.data from audit.event e join attendance_punch p on p.id = e.subject_id where p.correction_id = $1 or p.void_correction_id = $1 order by e.id`,
      [correctionId],
    );
    expect(punchEvents).toEqual([
      { type: 'attendance.punch_recorded', data: { source: 'manual', direction: 'in' } },
      { type: 'attendance.punch_voided', data: { source: 'manual' } },
      { type: 'attendance.punch_recorded', data: { source: 'correction', direction: 'in' } },
    ]);
    // the timeline: the employee, HR in scope; not someone outside
    const timeline = await call('agent', 'get', `/api/audit/timeline?subject=attendance_correction:${correctionId}&limit=100`).expect(200);
    const types = (timeline.body.items as { kind: string; event?: { type: string }; table?: string }[]).map((i) => i.event?.type ?? i.table);
    expect(types).toEqual(expect.arrayContaining(['attendance.correction_requested', 'workflow.approve', 'attendance.punch_voided', 'workflow_task', 'workflow_instance']));
    await call('est', 'get', `/api/audit/timeline?subject=attendance_correction:${correctionId}`).expect(200);
    await call('ouest', 'get', `/api/audit/timeline?subject=attendance_correction:${correctionId}`).expect(404);
    const employee = await call('admin', 'get', `/api/audit/timeline?subject=employee:${AGENT}&limit=100`).expect(200);
    expect((employee.body.items as { event?: { type: string } }[]).some((i) => i.event?.type === 'attendance.correction_approved')).toBe(true);
  });

  it('detail: the employee, HR in scope and the current candidate; the day with its punches; history', async () => {
    const detail = await call('agent', 'get', `/api/attendance/corrections/${correctionId}`).expect(200);
    assertNoSecrets(detail.body);
    expect(detail.body).toMatchObject({ id: correctionId, status: 'approved', _actions: [], day: { date: '2026-09-28', status: 'present' } });
    expect(detail.body.history.map((h: { stepKey: string; outcome: string }) => `${h.stepKey}:${h.outcome}`)).toEqual(['manager:approve', 'hr:approve']);
    for (const p of detail.body.day.punches as object[]) expect(p).toMatchObject({ _actions: [] });
    await call('est', 'get', `/api/attendance/corrections/${correctionId}`).expect(200);
    await call('ouest', 'get', `/api/attendance/corrections/${correctionId}`).expect(404);
    await call('chef', 'get', `/api/attendance/corrections/${correctionId}`).expect(404); // no longer a candidate
    await call('beta', 'get', `/api/attendance/corrections/${correctionId}`).expect(404);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('separation of duties, escalation, rejection', () => {
  it('Karim (rh.est, head of his own region) asks: manager escalated (DG head not linked); he cannot approve his own; admin rejects with a comment', async () => {
    const before = await punchesOf(employeeA(22), '2026-09-29');
    const res = await ask('est', { date: '2026-09-29', reason: 'Réunion à l’extérieur', changes: [add('in', '08:00'), add('out', '16:30')] }).expect(201);
    expect(res.body.workflow.steps.map((s: { state: string }) => s.state)).toEqual(['escalated', 'current']);
    const escalated = (await notificationsAbout(res.body.id)).filter((n) => n.type === 'task.escalated');
    expect(escalated.map((n) => n.user_id)).toEqual([USERS.est.id]);
    expect(escalated[0]?.data).toMatchObject({ audience: 'employee', escalationReason: 'manager-not-linked', date: '2026-09-29' });
    const task = await taskOf('admin', res.body.id);
    expect(task).toMatchObject({ stepKey: 'hr', escalated: true });
    expect(await taskOf('est', res.body.id)).toBeUndefined();
    expect((await call('est', 'post', `/api/tasks/${task?.id}/approve`, { body: {} }).expect(409)).body.type).toBe(PROBLEM('workflow-self-approval'));
    // reject: a comment is required; then nothing changes on the punches
    await call('admin', 'post', `/api/tasks/${task?.id}/reject`, { body: {} }).expect(422);
    await call('admin', 'post', `/api/tasks/${task?.id}/reject`, { body: { comment: 'Pas de justificatif' } }).expect(200);
    expect(await punchesOf(employeeA(22), '2026-09-29')).toEqual(before);
    const mine = (await call('est', 'get', '/api/me/attendance/corrections?status=rejected').expect(200)).body.items;
    expect(mine).toEqual([expect.objectContaining({ id: res.body.id, status: 'rejected', rejectionComment: 'Pas de justificatif', _actions: [] })]);
    const rejected = (await notificationsAbout(res.body.id)).filter((n) => n.type === 'attendance.correction_rejected');
    expect(rejected.map((n) => n.user_id)).toEqual([USERS.est.id]);
    expect(await emailJobFor(rejected[0]?.id ?? '')).toBe(true);
    expect(JSON.stringify(rejected[0]?.data)).not.toContain('justificatif');
  });

  it('the hr_only switch: new requests go straight to HR (the manager step does not exist)', async () => {
    await call('admin', 'put', '/api/attendance/policy', { body: { correctionWorkflowCode: 'attendance.hr_only', correctionMaxAgeDays: 10 } }).expect(200);
    try {
      expect((await ask('chef', { date: '2026-09-15', reason: 'Oubli', changes: [add('in', '07:30')] }).expect(409)).body.type).toBe(PROBLEM('attendance-correction-date'));
      const res = await ask('chef', { date: '2026-09-28', reason: 'Oubli', changes: [add('in', '07:30')] }).expect(201);
      expect(res.body.workflow.steps.map((s: { key: string; state: string }) => `${s.key}:${s.state}`)).toEqual(['hr:current']);
      expect(await taskOf('est', res.body.id)).toMatchObject({ stepKey: 'hr', escalated: false });
      const policy = (await call('ouest', 'get', '/api/attendance/policy').expect(200)).body;
      expect(policy).toMatchObject({ correctionWorkflowCode: 'attendance.hr_only', correctionMaxAgeDays: 10 });
      const days = (await call('chef', 'get', '/api/me/attendance/days').expect(200)).body;
      expect(days.correctionWindow).toEqual({ from: '2026-09-20', to: '2026-09-30' });
    } finally {
      await call('admin', 'put', '/api/attendance/policy', { body: { correctionWorkflowCode: 'attendance.manager_then_hr', correctionMaxAgeDays: 30 } }).expect(200);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('stale target, cancellation', () => {
  it('a target voided before the final approval → 409 attendance-correction-stale, nothing applied, the task stays open', async () => {
    const target = await manualPunch(AGENT, '2026-09-29', '09:15', 'in');
    const res = await ask('agent', { date: '2026-09-29', reason: 'Mauvaise heure', changes: [add('in', '07:31'), voidOf(target)] }).expect(201);
    await call('chef', 'post', `/api/tasks/${(await taskOf('chef', res.body.id))?.id}/approve`, { body: {} }).expect(200);
    await call('admin', 'post', `/api/attendance/punches/${target}/void`, { body: { reason: 'Annulé par RH' } }).expect(200);
    const hr = await taskOf('est', res.body.id);
    const stale = await call('est', 'post', `/api/tasks/${hr?.id}/approve`, { body: {} }).expect(409);
    expect(stale.body.type).toBe(PROBLEM('attendance-correction-stale'));
    expect((await punchesOf(AGENT, '2026-09-29')).map((p) => `${p.source}:${p.status}`)).toEqual(['manual:void']);
    expect(await taskOf('est', res.body.id)).toMatchObject({ id: hr?.id });
    expect((await call('agent', 'get', `/api/attendance/corrections/${res.body.id}`).expect(200)).body.status).toBe('pending');
    await call('est', 'post', `/api/tasks/${hr?.id}/reject`, { body: { comment: 'Déjà corrigé' } }).expect(200);
  });

  it('cancel: the requester, pending only; someone else → 404; the punches stay; the task disappears', async () => {
    const p = await manualPunch(AGENT, '2026-09-23', '07:40', 'in');
    const res = await ask('agent', { date: '2026-09-23', reason: 'Erreur', changes: [voidOf(p)] }).expect(201);
    expect(await taskOf('chef', res.body.id)).toBeDefined();
    await call('chef', 'post', `/api/me/attendance/corrections/${res.body.id}/cancel`).expect(404);
    const cancelled = await call('agent', 'post', `/api/me/attendance/corrections/${res.body.id}/cancel`).expect(200);
    expect(cancelled.body).toMatchObject({ status: 'cancelled', _actions: [] });
    expect((await call('agent', 'post', `/api/me/attendance/corrections/${res.body.id}/cancel`).expect(409)).body.type).toBe(PROBLEM('attendance-correction-not-cancellable'));
    expect((await punchesOf(AGENT, '2026-09-23')).map((x) => x.status)).toEqual(['live']);
    expect(await taskOf('chef', res.body.id)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('HR list scope', () => {
  it('rh_regional sees its region only, lecture its region only; filters', async () => {
    const [ouest] = await query<{ id: string }>(
      db.superuserUrl,
      `insert into attendance_correction (company_id, employment_id, org_unit_id, work_date, reason, requested_by) values ($1, $2, $3, '2026-09-28', 'Test', $4) returning id`,
      [COMPANY_A, employeeA(36), unitA('AG-ORAN'), USERS.admin.id],
    );
    const est = (await call('est', 'get', '/api/attendance/corrections?pageSize=100').expect(200)).body;
    expect(est.total).toBeGreaterThan(0);
    expect(est.items.every((c: { employee: { unit: { id: string } } }) => EST_UNITS.has(c.employee.unit.id))).toBe(true);
    expect(est.items.some((c: { id: string }) => c.id === ouest?.id)).toBe(false);
    const lecture = (await call('ouest', 'get', '/api/attendance/corrections').expect(200)).body;
    expect(lecture.items.map((c: { id: string }) => c.id)).toEqual([ouest?.id]);
    const admin = (await call('admin', 'get', `/api/attendance/corrections?employmentId=${AGENT}&status=approved`).expect(200)).body;
    expect(admin.items.length).toBe(1);
    expect(admin.items[0]).toMatchObject({ employee: { id: AGENT }, status: 'approved', _actions: [] });
    const filtered = (await call('admin', 'get', `/api/attendance/corrections?unitId=${unitA('REG-OUEST')}&from=2026-09-28&to=2026-09-28`).expect(200)).body;
    expect(filtered.items.map((c: { id: string }) => c.id)).toEqual([ouest?.id]);
    expect((await call('admin', 'get', '/api/attendance/corrections?q=EMP-0036').expect(200)).body.total).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('monthly report and CSV', () => {
  it('per employee: statuses from the 1st to today, minutes, dates; scope per role; month validation', async () => {
    const res = await call('admin', 'get', '/api/attendance/reports/monthly?month=2026-09&q=EMP-0030').expect(200);
    expect(res.body).toMatchObject({ month: '2026-09', days: 30, total: 1, page: 1 });
    const item = res.body.items[0];
    expect(item.employee).toMatchObject({ id: AGENT, unit: { code: 'AG-ANNABA' } });
    const c = item.counts;
    expect(c.present + c.late + c.absent + c.incomplete + c.onLeave + c.holiday + c.restDay).toBe(30); // today at 10:00, no arrival: absent (agency start 07:30)
    expect(item.absentDates).not.toContain('2026-09-28');
    expect(item.absentDates.length).toBe(c.absent);
    expect(item.workedMinutes).toBeGreaterThan(0);

    const est = (await call('est', 'get', '/api/attendance/reports/monthly?month=2026-09&pageSize=100').expect(200)).body;
    expect(est.total).toBeGreaterThan(0);
    expect(est.items.every((i: { employee: { unit: { id: string } } }) => EST_UNITS.has(i.employee.unit.id))).toBe(true);
    const ouest = (await call('ouest', 'get', '/api/attendance/reports/monthly?month=2026-09&pageSize=100').expect(200)).body;
    expect(ouest.total).toBeGreaterThan(0);
    expect(ouest.items.some((i: { employee: { unit: { id: string } } }) => EST_UNITS.has(i.employee.unit.id))).toBe(false);
    for (const [month, code] of [['2026-10', 'future'], ['2026-9', 'invalid'], ['abc', 'invalid']] as const) {
      const bad = await call('admin', 'get', `/api/attendance/reports/monthly?month=${month}`).expect(422);
      expect(bad.body.errors, month).toEqual([expect.objectContaining({ field: 'month', code })]);
    }
  });

  it('CSV: UTF-8 with BOM, ; separator, CRLF, localised header, formula injection neutralised, audited', async () => {
    const person = (await query<{ person_id: string; last_name: string }>(db.superuserUrl, `select e.person_id, p.last_name from employment e join person p on p.id = e.person_id where e.id = $1`, [employeeA(31)]))[0];
    await query(db.superuserUrl, `update person set last_name = '=HYPERLINK("http://evil")' where id = $1`, [person?.person_id]);
    try {
      const res = await call('est', 'get', '/api/attendance/reports/monthly.csv?month=2026-09&lang=fr').buffer(true).parse(binary).expect(200);
      expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(res.headers['content-disposition']).toBe('attachment; filename="presence-2026-09.csv"');
      const bytes = res.body as Buffer;
      expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      const text = bytes.toString('utf8').slice(1);
      expect(text.endsWith('\r\n')).toBe(true);
      const lines = text.split('\r\n').slice(0, -1);
      expect(lines[0]).toBe('Matricule;Nom;Prénom;Unité;Présents;Retards;Minutes de retard;Absences;Incomplets;Congés;Fériés;Heures travaillées;Heures prévues;Dates d’absence');
      expect(lines.every((l) => !l.includes('\n'))).toBe(true);
      const evil = lines.find((l) => l.startsWith('EMP-0031;'));
      expect(evil).toContain(`;"'=HYPERLINK(""http://evil"")";`);
      const agent = lines.find((l) => l.startsWith('EMP-0030;'))?.split(';');
      expect(agent).toHaveLength(14);
      expect(agent?.[11]).toMatch(/^\d+:\d{2}$/);
      const [event] = await query<{ data: Record<string, unknown>; actor: string }>(db.superuserUrl, `select data, actor_user_id as actor from audit.event where type = 'attendance.report_exported' order by id desc limit 1`);
      expect(event).toEqual({ data: { month: '2026-09', unitId: null, rows: lines.length - 1 }, actor: USERS.est.id });
      const ar = await call('est', 'get', '/api/attendance/reports/monthly.csv?month=2026-09&lang=ar').buffer(true).parse(binary).expect(200);
      expect((ar.body as Buffer).toString('utf8').slice(1).split('\r\n')[0]?.startsWith('الرقم;اللقب;الاسم;الوحدة;')).toBe(true);
    } finally {
      await query(db.superuserUrl, `update person set last_name = $2 where id = $1`, [person?.person_id, person?.last_name]);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('the scan receipt preview (one-tap confirmation on /punch) and the 2-minute receipt', () => {
  it('shows the kiosk, the time and the inferred direction without writing; then duplicate; expired after 2 minutes', async () => {
    const t = Date.parse('2026-09-30T08:59:00Z');
    clock.pinned = t + 30_000;
    try {
      const receipt = scanReceipt(DEMO_KIOSKS.annaba.id, t);
      const preview = await call('agent', 'get', '/api/me/attendance/receipt', { cookie: receipt }).expect(200);
      assertNoSecrets(preview.body);
      expect(preview.headers['cache-control']).toBe('no-store');
      expect(preview.body).toEqual({
        kiosk: { labels: { fr: 'Agence Annaba — Entrée', ar: 'وكالة عنابة — المدخل' }, site: { code: 'ANNABA', name: expect.any(String) } },
        scannedAt: new Date(t).toISOString(),
        localTime: '09:59',
        workDate: '2026-09-30',
        receiptExpiresAt: new Date(t + 120_000).toISOString(),
        direction: 'in',
        duplicate: false,
      });
      expect(await punchesOf(AGENT, '2026-09-30')).toEqual([]);
      await call('agent', 'post', '/api/me/attendance/punches', { cookie: receipt }).expect(201);
      expect((await call('agent', 'get', '/api/me/attendance/receipt', { cookie: receipt }).expect(200)).body).toMatchObject({ direction: 'in', duplicate: true });
      // a second scan 60 s later (another window, within the gap): duplicate, showing the time of the punch recorded
      clock.pinned = t + 61_000;
      const second = scanReceipt(DEMO_KIOSKS.annaba.id, t + 60_000);
      expect((await call('agent', 'get', '/api/me/attendance/receipt', { cookie: second }).expect(200)).body).toMatchObject({
        scannedAt: new Date(t + 60_000).toISOString(),
        localTime: '09:59',
        direction: 'in',
        duplicate: true,
      });
      clock.pinned = t + 121_000;
      expect((await call('agent', 'get', '/api/me/attendance/receipt', { cookie: receipt }).expect(409)).body.type).toBe(PROBLEM('attendance-no-scan'));
      expect((await call('admin', 'get', '/api/me/attendance/receipt', { cookie: receipt }).expect(409)).body.type).toBe(PROBLEM('attendance-not-linked'));
    } finally {
      clock.pinned = NOW;
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('retention', () => {
  it('the purge deletes old corrections, their items and punches, with no per-row event; the task summary says purged', async () => {
    const worker = createDatabase({ connectionString: db.workerUrl, maxConnections: 1 });
    try {
      const [c] = await query<{ id: string }>(
        db.superuserUrl,
        `insert into attendance_correction (company_id, employment_id, org_unit_id, work_date, reason, requested_by, status) values ($1, $2, $3, '2020-02-03', 'Ancien', $4, 'approved') returning id`,
        [COMPANY_A, AGENT, unitA('AG-ANNABA'), USERS.agent.id],
      );
      const old = await manualPunch(AGENT, '2020-02-03', '12:00', 'in');
      await query(db.superuserUrl, `update attendance_punch set status = 'void', voided_at = now(), voided_by = $2, void_reason = 'Ancien', void_correction_id = $3 where id = $1`, [old, USERS.admin.id, c?.id]);
      const [added] = await query<{ id: string }>(
        db.superuserUrl,
        `insert into attendance_punch (company_id, employment_id, direction, occurred_at, source, correction_id, created_by) values ($1, $2, 'in', '2020-02-03T06:30:00Z', 'correction', $3, $4) returning id`,
        [COMPANY_A, AGENT, c?.id, USERS.admin.id],
      );
      await query(db.superuserUrl, `insert into attendance_correction_item (company_id, correction_id, position, action, punch_id) values ($1, $2, 0, 'void', $3)`, [COMPANY_A, c?.id, old]);
      await query(db.superuserUrl, `insert into attendance_correction_item (company_id, correction_id, position, action, direction, occurred_at, result_punch_id) values ($1, $2, 1, 'add', 'in', '2020-02-03T06:30:00Z', $3)`, [COMPANY_A, c?.id, added?.id]);
      const eventsBefore = (await query(db.superuserUrl, `select 1 from audit.event`)).length;
      const result = await attendanceRetentionTask({ db: worker, logger: pino({ level: 'silent' }), mail: { send: () => Promise.resolve() }, webBaseUrl: 'http://web.test' }, { today: '2026-09-27' }, { id: '1', attempt: 1 });
      expect(result).toMatchObject({ corrections: 1, punches: 2 });
      expect(await query(db.superuserUrl, `select 1 from attendance_correction where id = $1`, [c?.id])).toEqual([]);
      expect(await query(db.superuserUrl, `select 1 from attendance_correction_item where correction_id = $1`, [c?.id])).toEqual([]);
      const newEvents = await query<{ type: string; data: Record<string, unknown> }>(db.superuserUrl, `select type, data from audit.event order by id offset $1`, [eventsBefore]);
      expect(newEvents).toEqual([{ type: 'attendance.purged', data: { punches: 2, corrections: 1, before: '2021-09-01' } }]);
      await expect(query(db.appUrl, 'delete from attendance_correction')).rejects.toThrow(/permission denied/);
    } finally {
      await worker.destroy();
    }
  });
});
