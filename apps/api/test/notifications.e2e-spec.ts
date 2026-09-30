/**
 * Notifications (docs/contracts/notifications.md): who gets which type (candidates incl. permission holders, requester
 * and actor excluded, deduplication), the transactional outbox (a rollback leaves no row and no job), the restrictive
 * own-user RLS, the endpoints (paging, unread count, mark read, preferences) and the live SSE stream (fan-out via
 * LISTEN/NOTIFY within ~1 s, unread updates, isolation, one listener connection, close at token expiry).
 * Real grants (DEV_AUTH header identity, no DEV_PERMISSIONS) on the leave demo seed; "today" pinned to 2026-09-26.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LeaveClock } from '../src/modules/leave/index.js';
import { LISTENER_APPLICATION_NAME } from '../src/modules/notifications/index.js';
import { StaffingClock } from '../src/modules/staffing/index.js';
import { runInRequestTransaction } from '../src/platform/context/request-transaction.js';
import { KYSELY, type Database } from '../src/platform/db/database.js';
import { Notifier } from '../src/platform/notifications/notifier.js';
import { signAccessToken } from '../src/platform/security/jwt.js';
import { as, COMPANY_A, COMPANY_B, companyOf, employeeA, seedAccessFixture, USERS, type ActorName } from './support/access-fixture.js';
import { assertNoSecrets } from './support/assert-no-secrets.js';
import { openSse, type SseStream } from './support/sse.js';
import { createTestApp, TEST_SECRETS } from './support/test-app.js';
import { createTestDatabase, query, type TestDatabase } from './support/test-database.js';
import { fetchXsrf, type XsrfPair } from './support/xsrf.js';

interface Row {
  id: string;
  user_id: string;
  type: string;
  subject_type: string;
  subject_id: string;
  data: Record<string, unknown>;
  read_at: string | null;
}

interface View {
  id: string;
  type: string;
  createdAt: string;
  readAt: string | null;
  subject: { type: string; id: string };
  data: Record<string, unknown>;
  audience: string | null;
  link: string;
}

let db: TestDatabase;
let app: NestExpressApplication;
let xsrf: XsrfPair;
let annual = '';
let day = 0;

const client = (actor: ActorName) => as(app, actor, xsrf);
/** A distinct 1-day annual leave date per request (Oct 2026 → …), never overlapping another. */
const nextDate = () => new Date(Date.UTC(2026, 9, 1 + day++ * 2)).toISOString().slice(0, 10);

function rows(where = 'true', values: unknown[] = []): Promise<Row[]> {
  return query<Row>(db.superuserUrl, `select id, user_id, type, subject_type, subject_id, data, read_at from notification where ${where} order by created_at, id`, values);
}

function about(subjectId: string): Promise<Row[]> {
  return rows('subject_id = $1', [subjectId]);
}

const nameOf = (actor: ActorName) => USERS[actor].id;
const headersOf = (actor: ActorName) => ({ 'X-Dev-User-Id': USERS[actor].id, 'X-Dev-Company-Id': companyOf(actor) });
const who = (list: Row[]) => list.map((r) => r.user_id).toSorted();
const ids = (...actors: ActorName[]) => actors.map(nameOf).toSorted();

async function request(actor: ActorName = 'agent', start = nextDate()): Promise<string> {
  const res = await client(actor).post('/api/me/leave/requests').send({ leaveTypeId: annual, startDate: start, endDate: start });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

async function taskOf(actor: ActorName, requestId: string): Promise<string> {
  const items = (await client(actor).get('/api/tasks').expect(200)).body.items as { id: string; subject: { id: string } }[];
  const task = items.find((t) => t.subject.id === requestId);
  if (!task) throw new Error(`${actor} has no task for ${requestId}`);
  return task.id;
}

function emailJobs(): Promise<{ payload: { companyId: string; notificationId: string }; key: string | null }[]> {
  return query(
    db.superuserUrl,
    `select j.payload, j.key from graphile_worker._private_jobs j join graphile_worker._private_tasks t on t.id = j.task_id
      where t.identifier = 'notifications.email'`,
  );
}

beforeAll(async () => {
  db = await createTestDatabase();
  await seedAccessFixture(db, undefined, { leave: true });
  const pinned = { today: () => '2026-09-26' };
  app = await createTestApp(db, {
    devAuth: true,
    devPermissions: false,
    overrides: [
      { provide: LeaveClock, useValue: pinned },
      { provide: StaffingClock, useValue: pinned },
    ],
  });
  xsrf = await fetchXsrf(app);
  annual = (await query<{ id: string }>(db.superuserUrl, `select id from leave_type where company_id = $1 and code = 'annual'`, [COMPANY_A]))[0]?.id ?? '';
});

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

// ---------------------------------------------------------------------------------------------------------------
describe('who is notified (types, recipients, actor, dedup)', () => {
  let requestId = '';

  it('task.assigned (manager step): the assignee only — never the requester/actor; one e-mail job per row', async () => {
    const jobsBefore = (await emailJobs()).length;
    requestId = await request('agent');
    const managerTask = await taskOf('chef', requestId);
    const list = await rows('subject_id = $1', [managerTask]);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ user_id: nameOf('chef'), type: 'task.assigned', subject_type: 'workflow_task' });
    expect(list[0]?.data).toMatchObject({
      requestId,
      taskId: managerTask,
      stepKey: 'manager',
      leaveType: 'annual',
      days: 1,
      audience: 'approver',
      actorName: USERS.agent.displayName,
      employeeName: expect.any(String),
    });
    const jobs = await emailJobs();
    expect(jobs.length).toBe(jobsBefore + 1);
    expect(jobs.at(-1)).toMatchObject({ payload: { companyId: COMPANY_A, notificationId: list[0]?.id }, key: `notifications.email:${list[0]?.id}` });
  });

  it('task.assigned (permission step): every holder of leave.approve_hr over the unit (rh.est, rh.admin) — not the approving manager', async () => {
    const managerTask = await taskOf('chef', requestId);
    await client('chef').post(`/api/tasks/${managerTask}/approve`).send({}).expect(200);
    const hrTask = await taskOf('est', requestId);
    const list = await rows('subject_id = $1', [hrTask]);
    expect(who(list)).toEqual(ids('admin', 'est'));
    expect(list.every((r) => r.type === 'task.assigned' && r.data['stepKey'] === 'hr' && r.data['actorName'] === USERS.chef.displayName)).toBe(true);
  });

  it('leave.approved: the requester = the employee (deduplicated), never the approving actor', async () => {
    await client('est').post(`/api/tasks/${await taskOf('est', requestId)}/approve`).send({}).expect(200);
    const list = (await about(requestId)).filter((r) => r.type === 'leave.approved');
    expect(who(list)).toEqual(ids('agent'));
    expect(list[0]?.data).toMatchObject({ audience: 'employee', actorName: USERS.est.displayName });
    const mine = (await client('agent').get('/api/me/notifications').expect(200)).body.items as View[];
    expect(mine.find((n) => n.type === 'leave.approved')).toMatchObject({ subject: { type: 'leave_request', id: requestId }, audience: 'employee', link: `/me/leave?request=${requestId}` });
  });

  it('leave.rejected: to the requester; the comment (reason) is never in the data', async () => {
    const id = await request('agent');
    await client('chef').post(`/api/tasks/${await taskOf('chef', id)}/reject`).send({ comment: 'Période chargée — confidentiel' }).expect(200);
    const list = (await about(id)).filter((r) => r.type === 'leave.rejected');
    expect(who(list)).toEqual(ids('agent'));
    expect(JSON.stringify(list[0]?.data)).not.toMatch(/confidentiel|Période/);
  });

  it('leave.cancelled: the candidates of the task that was open (manager step: chef; HR step: rh.est + rh.admin), link /tasks', async () => {
    const atManager = await request('agent');
    await client('agent').post(`/api/me/leave/requests/${atManager}/cancel`).send({}).expect(200);
    expect(who((await about(atManager)).filter((r) => r.type === 'leave.cancelled'))).toEqual(ids('chef'));

    const atHr = await request('agent');
    await client('chef').post(`/api/tasks/${await taskOf('chef', atHr)}/approve`).send({}).expect(200);
    await client('agent').post(`/api/me/leave/requests/${atHr}/cancel`).send({}).expect(200);
    const cancelled = (await about(atHr)).filter((r) => r.type === 'leave.cancelled');
    expect(who(cancelled)).toEqual(ids('admin', 'est'));
    const view = ((await client('est').get('/api/me/notifications').expect(200)).body.items as View[]).find((n) => n.type === 'leave.cancelled' && n.subject.id === atHr);
    expect(view).toMatchObject({ link: '/tasks', audience: 'approver' });
  });

  it('leave.submitted_on_behalf: the employee’s own user (not the HR actor); approval then tells both (requester link /leave/requests/…)', async () => {
    const res = await client('admin').post(`/api/employees/${employeeA(30)}/leave/requests`).send({ leaveTypeId: annual, startDate: nextDate(), endDate: nextDate() });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const id = res.body.id as string;
    const onBehalf = (await about(id)).filter((r) => r.type === 'leave.submitted_on_behalf');
    expect(who(onBehalf)).toEqual(ids('agent'));
    expect(onBehalf[0]?.data).toMatchObject({ audience: 'employee', actorName: USERS.admin.displayName });
    // the manager task still goes to chef; then HR (rh.est) approves → the employee AND rh.admin (the requester)
    await client('chef').post(`/api/tasks/${await taskOf('chef', id)}/approve`).send({}).expect(200);
    await client('est').post(`/api/tasks/${await taskOf('est', id)}/approve`).send({}).expect(200);
    const approved = (await about(id)).filter((r) => r.type === 'leave.approved');
    expect(who(approved)).toEqual(ids('admin', 'agent'));
    const adminView = ((await client('admin').get('/api/me/notifications').expect(200)).body.items as View[]).find((n) => n.type === 'leave.approved' && n.subject.id === id);
    expect(adminView?.link).toBe(`/leave/requests/${id}`);
    // the client words it by audience: the HR filer is a `requester` (a sentence naming the employee), the employee
    // keeps "your request"; the internal key stays out of `data`
    expect(adminView).toMatchObject({ audience: 'requester', data: { employeeName: expect.any(String) } });
    expect(adminView?.data).not.toHaveProperty('audience');
    const agentView = ((await client('agent').get('/api/me/notifications').expect(200)).body.items as View[]).find((n) => n.type === 'leave.approved' && n.subject.id === id);
    expect(agentView).toMatchObject({ audience: 'employee', link: `/me/leave?request=${id}` });
  });

  it('task.escalated: the requester is told (the engine decided); the HR task goes to rh.admin, not to Karim himself', async () => {
    const id = await request('est'); // Karim: his manager (DG head) has no linked user → escalated
    const escalated = (await about(id)).filter((r) => r.type === 'task.escalated');
    expect(who(escalated)).toEqual(ids('est'));
    expect(escalated[0]?.data).toMatchObject({ escalationReason: 'manager-not-linked', stepKey: 'manager', audience: 'employee' });
    const hrTask = await taskOf('admin', id);
    expect(who(await about(hrTask))).toEqual(ids('admin'));
  });

  it('the Notifier: one row per recipient, duplicates merged, a repeated call is a no-op, the actor dropped', async () => {
    const kysely = app.get<Database>(KYSELY);
    const notifier = app.get(Notifier);
    const subject = { type: 'leave_request' as const, id: '0190a5d0-0000-7000-8000-00000000d0d0' };
    const call = () =>
      runInRequestTransaction(kysely, { requestId: 'dedup', companyId: COMPANY_A, userId: nameOf('admin') }, () =>
        notifier.notify({
          type: 'leave.approved',
          subject,
          data: { requestId: subject.id },
          recipients: [
            { userId: nameOf('agent'), audience: 'employee' },
            { userId: nameOf('agent'), audience: 'requester' },
            { userId: nameOf('admin'), audience: 'requester' },
            { userId: null, audience: 'employee' },
          ],
        }),
      );
    await call();
    await call();
    const list = await about(subject.id);
    expect(who(list)).toEqual(ids('agent'));
    expect(list[0]?.data['audience']).toBe('employee');
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('transactional outbox', () => {
  it('a rollback leaves neither the notification nor its e-mail job; a commit leaves both', async () => {
    const kysely = app.get<Database>(KYSELY);
    const notifier = app.get(Notifier);
    const input = (id: string) => ({
      type: 'leave.approved' as const,
      subject: { type: 'leave_request' as const, id },
      data: { requestId: id },
      recipients: [{ userId: nameOf('agent'), audience: 'employee' as const }],
    });
    const scope = { requestId: 'outbox', companyId: COMPANY_A, userId: nameOf('admin') };
    const rolledBack = '0190a5d0-0000-7000-8000-00000000b0b0';
    const jobs = (await emailJobs()).length;
    await expect(
      runInRequestTransaction(kysely, scope, async () => {
        await notifier.notify(input(rolledBack));
        throw new Error('business rule failed after notifying');
      }),
    ).rejects.toThrow(/business rule/);
    expect(await about(rolledBack)).toEqual([]);
    expect((await emailJobs()).length).toBe(jobs);

    const committed = '0190a5d0-0000-7000-8000-00000000c0c0';
    await runInRequestTransaction(kysely, scope, () => notifier.notify(input(committed)));
    const [row] = await about(committed);
    expect(row).toBeDefined();
    expect((await emailJobs()).map((j) => j.payload.notificationId)).toContain(row?.id);
  });

  it('a refused API write creates no notification (on-behalf request with invalid dates)', async () => {
    const before = (await rows()).length;
    const res = await client('admin').post(`/api/employees/${employeeA(30)}/leave/requests`).send({ leaveTypeId: annual, startDate: '2026-12-31', endDate: '2026-12-30' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await rows()).length).toBe(before);
  });
});

/** Statements as hrforce_app in one transaction with app.company_id = A and app.user_id = `userId` (rolled back). */
async function asApp(userId: string, statements: string[], values: unknown[][] = []): Promise<unknown[][]> {
  const pg = new Client({ connectionString: db.appUrl });
  await pg.connect();
  try {
    await pg.query('begin');
    await pg.query(`select set_config('app.company_id', $1, true), set_config('app.user_id', $2, true)`, [COMPANY_A, userId]);
    const out: unknown[][] = [];
    for (const [i, s] of statements.entries()) out.push((await pg.query(s, values[i] ?? [])).rows);
    await pg.query('rollback');
    return out;
  } finally {
    await pg.end();
  }
}

// ---------------------------------------------------------------------------------------------------------------
describe('restrictive RLS: own rows only, even inside the company', () => {
  it('hrforce_app as user A cannot read, mark or delete user B’s notifications (same company)', async () => {
    const chefRows = await rows('user_id = $1', [nameOf('chef')]);
    expect(chefRows.length).toBeGreaterThan(0);
    const target = chefRows[0]?.id;
    const [visible, updated, own] = await asApp(
      nameOf('agent'),
      [
        'select id from notification where user_id = $1',
        'update notification set read_at = now() where id = $1 returning id',
        'select count(*)::int as n from notification',
      ],
      [[nameOf('chef')], [target], []],
    );
    expect(visible).toEqual([]);
    expect(updated).toEqual([]);
    expect((own as { n: number }[])[0]?.n).toBe((await rows('user_id = $1', [nameOf('agent')])).length);
    await expect(asApp(nameOf('agent'), ['delete from notification'])).rejects.toThrow(/permission denied/);
    // without app.user_id nothing is visible at all
    const [none] = await asApp('', ['select id from notification']);
    expect(none).toEqual([]);
  });

  it('preferences: nobody reads or writes another user’s preference', async () => {
    await expect(
      asApp(nameOf('agent'), [`insert into notification_preference (company_id, user_id, type, email) values ('${COMPANY_A}', '${nameOf('chef')}', 'task.assigned', false)`]),
    ).rejects.toThrow(/row-level security/);
    await client('chef').put('/api/me/notification-preferences').send([{ type: 'leave.cancelled', email: true }]).expect(200);
    const [seen] = await asApp(nameOf('agent'), ['select * from notification_preference']);
    expect(seen).toEqual([]);
  });

  it('through the API: someone else’s id is a 404, and the other company sees nothing', async () => {
    const chefRow = (await rows('user_id = $1 and read_at is null', [nameOf('chef')]))[0];
    await client('agent').post(`/api/me/notifications/${chefRow?.id}/read`).send({}).expect(404);
    await client('beta').post(`/api/me/notifications/${chefRow?.id}/read`).send({}).expect(404);
    expect((await rows('id = $1', [chefRow?.id]))[0]?.read_at).toBeNull();
    expect((await client('beta').get('/api/me/notifications').expect(200)).body.items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('endpoints', () => {
  it('list: newest first, cursor paging, unreadOnly; unread-count; mark one / all read (idempotent)', async () => {
    const all = (await client('est').get('/api/me/notifications?limit=100').expect(200)).body as { items: View[]; nextCursor: string | null };
    assertNoSecrets(all);
    expect(all.items.length).toBeGreaterThanOrEqual(3);
    expect(all.items.every((n) => !('audience' in n.data))).toBe(true);
    expect(all.items.map((n) => n.createdAt)).toEqual(all.items.map((n) => n.createdAt).toSorted().toReversed());
    const pages: View[] = [];
    let cursor: string | null = null;
    do {
      const res = await client('est').get(`/api/me/notifications?limit=2${cursor ? `&before=${cursor}` : ''}`).expect(200);
      pages.push(...(res.body.items as View[]));
      cursor = res.body.nextCursor as string | null;
    } while (cursor);
    expect(pages.map((n) => n.id)).toEqual(all.items.map((n) => n.id));

    const count = (await client('est').get('/api/me/notifications/unread-count').expect(200)).body.count as number;
    expect(count).toBe(all.items.filter((n) => n.readAt === null).length);
    const first = all.items.find((n) => n.readAt === null);
    await client('est').post(`/api/me/notifications/${first?.id}/read`).send({}).expect(204);
    await client('est').post(`/api/me/notifications/${first?.id}/read`).send({}).expect(204); // already read: still 204
    expect((await client('est').get('/api/me/notifications/unread-count').expect(200)).body.count).toBe(count - 1);
    const unread = (await client('est').get('/api/me/notifications?unreadOnly=true&limit=100').expect(200)).body.items as View[];
    expect(unread.every((n) => n.readAt === null)).toBe(true);
    expect(unread).toHaveLength(count - 1);
    await client('est').post('/api/me/notifications/read-all').send({}).expect(204);
    expect((await client('est').get('/api/me/notifications/unread-count').expect(200)).body.count).toBe(0);
    expect((await client('est').get('/api/me/notifications?before=garbage').expect(422)).body.errors[0].field).toBe('before');
    await client('est').post('/api/me/notifications/not-a-uuid/read').send({}).expect(404);
  });

  it('preferences: every type with its default; PUT updates the listed ones; unknown / duplicate type → 422', async () => {
    const defaults = (await client('agent').get('/api/me/notification-preferences').expect(200)).body as { type: string; email: boolean; default: boolean }[];
    expect(defaults).toEqual([
      { type: 'task.assigned', email: true, default: true },
      { type: 'task.escalated', email: false, default: false },
      { type: 'leave.approved', email: true, default: true },
      { type: 'leave.rejected', email: true, default: true },
      { type: 'leave.cancelled', email: false, default: false },
      { type: 'leave.submitted_on_behalf', email: true, default: true },
      { type: 'document.ready', email: true, default: true },
      { type: 'document.rejected', email: true, default: true },
      { type: 'attendance.correction_approved', email: false, default: false },
      { type: 'attendance.correction_rejected', email: true, default: true },
    ]);
    const put = await client('agent').put('/api/me/notification-preferences').send([{ type: 'leave.approved', email: false }, { type: 'task.escalated', email: true }]).expect(200);
    expect(put.body).toEqual(expect.arrayContaining([{ type: 'leave.approved', email: false, default: true }, { type: 'task.escalated', email: true, default: false }]));
    expect((await client('agent').get('/api/me/notification-preferences').expect(200)).body).toEqual(put.body);
    // another user is unaffected
    expect(((await client('chef').get('/api/me/notification-preferences').expect(200)).body as { type: string; email: boolean }[]).find((p) => p.type === 'leave.approved')?.email).toBe(true);
    expect((await client('agent').put('/api/me/notification-preferences').send([{ type: 'nope.nope', email: true }]).expect(422)).body.errors[0]).toMatchObject({ field: '0.type', code: 'unknown_type' });
    await client('agent').put('/api/me/notification-preferences').send([{ type: 'leave.approved', email: true }, { type: 'leave.approved', email: false }]).expect(422);
    await client('agent').put('/api/me/notification-preferences').send({ type: 'leave.approved', email: true }).expect(422);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('live stream (SSE)', () => {
  const streams: SseStream[] = [];
  const open = async (actor: ActorName) => {
    const s = await openSse(app, '/api/me/notifications/stream', headersOf(actor));
    streams.push(s);
    return s;
  };
  afterAll(() => {
    for (const s of streams) s.close();
  });

  it('text/event-stream, first an `unread` event; a notification created by ANOTHER request arrives within ~1 s, then the new count', async () => {
    const chef = await open('chef');
    expect(chef.status).toBe(200);
    expect(chef.headers['content-type']).toMatch(/^text\/event-stream/);
    expect(chef.headers['cache-control']).toContain('no-cache');
    expect(chef.headers['x-accel-buffering']).toBe('no');
    const initial = (await chef.next((e) => e.event === 'unread')).data as { count: number };
    const agentStream = await open('agent');
    const betaStream = await open('beta');
    await agentStream.next((e) => e.event === 'unread');
    await betaStream.next((e) => e.event === 'unread');

    const started = Date.now();
    const id = await request('agent');
    const event = await chef.next((e) => e.event === 'notification', 1500);
    expect(Date.now() - started).toBeLessThan(1500);
    const view = event.data as View;
    expect(view).toMatchObject({ type: 'task.assigned', subject: { type: 'workflow_task' }, readAt: null });
    expect(view.data['requestId']).toBe(id);
    expect(view.link).toBe(`/tasks?task=${view.subject.id}`);
    expect(view.data).not.toHaveProperty('audience');
    await chef.next((e) => e.event === 'unread' && (e.data as { count: number }).count === initial.count + 1);

    // isolation: the requester (actor) and the other company got nothing but their initial count
    await new Promise((r) => setTimeout(r, 300));
    expect(agentStream.events.filter((e) => e.event === 'notification')).toEqual([]);
    expect(betaStream.events.filter((e) => e.event === 'notification')).toEqual([]);

    // marking read elsewhere (another request) → an `unread` update on the open stream
    await client('chef').post(`/api/me/notifications/${view.id}/read`).send({}).expect(204);
    await chef.next((e) => e.event === 'unread' && (e.data as { count: number }).count === initial.count);
  });

  it('one LISTEN connection per API process, however many streams are open', async () => {
    await open('admin');
    await open('est');
    const rowsOf = await query<{ n: number }>(
      db.superuserUrl,
      `select count(*)::int as n from pg_stat_activity where datname = $1 and application_name = $2`,
      [db.name, LISTENER_APPLICATION_NAME],
    );
    expect(rowsOf[0]?.n).toBe(1);
  });

  it('closes itself when the access token behind it expires (cookie identity)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signAccessToken(TEST_SECRETS.AUTH_ACCESS_SECRET, { sub: USERS.chef.id, cid: COMPANY_A, sid: '0190a5d0-0000-7000-8000-00000000e5e5', iat: now, exp: now + 2 });
    const s = await openSse(app, '/api/me/notifications/stream', { Cookie: `hrf_at=${token}` });
    streams.push(s);
    expect(s.status).toBe(200);
    await s.next((e) => e.event === 'unread');
    const started = Date.now();
    await s.ended;
    expect(Date.now() - started).toBeLessThan(4000);
    // an expired token cannot reopen it
    const again = await openSse(app, '/api/me/notifications/stream', { Cookie: `hrf_at=${token}` });
    await new Promise((r) => setTimeout(r, 2200));
    const late = await openSse(app, '/api/me/notifications/stream', { Cookie: `hrf_at=${token}` });
    expect(late.status).toBe(401);
    again.close();
    late.close();
  });

  it('anonymous → 401 problem+json (no stream); another company’s user gets their own (empty) stream', async () => {
    const anon = await openSse(app, '/api/me/notifications/stream');
    expect(anon.status).toBe(401);
    await anon.ended;
    const beta = await open('beta');
    expect(((await beta.next((e) => e.event === 'unread')).data as { count: number }).count).toBe(0);
    expect(COMPANY_B).not.toBe(COMPANY_A);
  });
});
