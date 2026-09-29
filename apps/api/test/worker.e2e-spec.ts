/**
 * The background worker (docs/contracts/notifications.md › Worker), as the role hrforce_worker: the e-mail job
 * (preference and account re-checked at send time, locale, link, fake mailer), the real Graphile runner processing the
 * jobs the API enqueued, the cron tasks (idempotent, company by company, system actor), the cleanup functions, and the
 * worker role's limits (RLS, no privilege on auth tables, graphile_worker only through its grants).
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import { runOnce } from 'graphile-worker';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LeaveClock } from '../src/modules/leave/index.js';
import { StaffingClock } from '../src/modules/staffing/index.js';
import { createDatabase, type Database } from '../src/platform/db/database.js';
import { companyIds, forEachCompany } from '../src/worker/company-loop.js';
import { CRON_ITEMS, parsedCronItems } from '../src/worker/cron.js';
import { graphileLogger } from '../src/worker/graphile-logger.js';
import {
  accrualMonth,
  accrualsTask,
  authCleanupTask,
  buildTaskList,
  emailTask,
  ensurePartitionsTask,
  notificationsCleanupTask,
  TASKS,
  type WorkerDeps,
} from '../src/worker/tasks.js';
import { as, COMPANY_A, COMPANY_B, seedAccessFixture, USERS, type ActorName } from './support/access-fixture.js';
import { createTestApp } from './support/test-app.js';
import { createTestDatabase, query, type TestDatabase } from './support/test-database.js';
import { fetchXsrf, type XsrfPair } from './support/xsrf.js';

interface Sent {
  to: string;
  subject: string;
  text: string;
  html: string;
}

class FakeMailer {
  readonly sent: Sent[] = [];
  send(message: Sent): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
}

let db: TestDatabase;
let app: NestExpressApplication;
let xsrf: XsrfPair;
let worker: Database;
let mailer: FakeMailer;
let deps: WorkerDeps;
let annual = '';
let jobSeq = 0;
let day = 0;

const job = () => ({ id: String(++jobSeq), attempt: 1 });
const client = (actor: ActorName) => as(app, actor, xsrf);
const nextDate = () => new Date(Date.UTC(2026, 10, 2 + day++ * 2)).toISOString().slice(0, 10);

async function notificationOf(userId: string, type: string): Promise<string> {
  const [row] = await query<{ id: string }>(db.superuserUrl, 'select id from notification where user_id = $1 and type = $2 order by created_at desc limit 1', [userId, type]);
  if (!row) throw new Error(`no ${type} for ${userId}`);
  return row.id;
}

async function agentRequest(): Promise<string> {
  const start = nextDate();
  return (await client('agent').post('/api/me/leave/requests').send({ leaveTypeId: annual, startDate: start, endDate: start }).expect(201)).body.id as string;
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
  worker = createDatabase({ connectionString: db.workerUrl, maxConnections: 3, applicationName: 'hrforce-worker-test' });
  mailer = new FakeMailer();
  deps = { db: worker, logger: pino({ level: 'silent' }), mail: mailer, webBaseUrl: 'https://hr.example.dz' };
});

afterAll(async () => {
  await worker?.destroy();
  await app?.close();
  await db?.drop();
});

// ---------------------------------------------------------------------------------------------------------------
describe('notifications.email', () => {
  it('sends in the recipient’s locale with the absolute link — no balance, no reason', async () => {
    await agentRequest();
    const id = await notificationOf(USERS.chef.id, 'task.assigned');
    mailer.sent.length = 0;
    const result = await emailTask(deps, { companyId: COMPANY_A, notificationId: id }, job());
    expect(result).toMatchObject({ outcome: 'sent' });
    expect(mailer.sent).toHaveLength(1);
    const [mail] = mailer.sent;
    expect(mail?.to).toBe(USERS.chef.email);
    const [row] = await query<{ subject_id: string }>(db.superuserUrl, 'select subject_id from notification where id = $1', [id]);
    expect(mail?.text).toContain(`https://hr.example.dz/tasks?task=${row?.subject_id}`);
    expect(mail?.subject).toMatch(/^HRForce — demande de congé à traiter/);
    expect(mail?.text).toContain('Congé annuel');
  });

  it('Arabic recipient (rh.est) → Arabic mail, rtl', async () => {
    const requestId = await agentRequest();
    const tasks = (await client('chef').get('/api/tasks').expect(200)).body.items as { id: string; subject: { id: string } }[];
    await client('chef').post(`/api/tasks/${tasks.find((t) => t.subject.id === requestId)?.id}/approve`).send({}).expect(200);
    const id = await notificationOf(USERS.est.id, 'task.assigned');
    mailer.sent.length = 0;
    expect(await emailTask(deps, { companyId: COMPANY_A, notificationId: id }, job())).toMatchObject({ outcome: 'sent' });
    expect(mailer.sent[0]?.html).toContain('dir="rtl"');
    expect(mailer.sent[0]?.subject).toContain('طلب عطلة');
  });

  it('re-checks the preference at send time (off by preference; a default-off type is sent only when switched on)', async () => {
    await client('chef').put('/api/me/notification-preferences').send([{ type: 'task.assigned', email: false }]).expect(200);
    await agentRequest();
    const id = await notificationOf(USERS.chef.id, 'task.assigned');
    mailer.sent.length = 0;
    expect(await emailTask(deps, { companyId: COMPANY_A, notificationId: id }, job())).toMatchObject({ outcome: 'preference-off' });
    await client('chef').put('/api/me/notification-preferences').send([{ type: 'task.assigned', email: true }]).expect(200);
    expect(await emailTask(deps, { companyId: COMPANY_A, notificationId: id }, job())).toMatchObject({ outcome: 'sent' });

    // leave.cancelled is off by default
    const cancelled = await agentRequest();
    await client('agent').post(`/api/me/leave/requests/${cancelled}/cancel`).send({}).expect(200);
    const cancelledId = await notificationOf(USERS.chef.id, 'leave.cancelled');
    expect(await emailTask(deps, { companyId: COMPANY_A, notificationId: cancelledId }, job())).toMatchObject({ outcome: 'preference-off' });
    await client('chef').put('/api/me/notification-preferences').send([{ type: 'leave.cancelled', email: true }]).expect(200);
    expect(await emailTask(deps, { companyId: COMPANY_A, notificationId: cancelledId }, job())).toMatchObject({ outcome: 'sent' });
    expect(mailer.sent).toHaveLength(2);
  });

  it('skips a disabled account; an unknown / other-company notification is `missing`', async () => {
    await agentRequest();
    const id = await notificationOf(USERS.chef.id, 'task.assigned');
    await query(db.superuserUrl, `update auth.user_account set status = 'disabled' where id = $1`, [USERS.chef.id]);
    try {
      mailer.sent.length = 0;
      expect(await emailTask(deps, { companyId: COMPANY_A, notificationId: id }, job())).toMatchObject({ outcome: 'recipient-inactive' });
      expect(mailer.sent).toEqual([]);
    } finally {
      await query(db.superuserUrl, `update auth.user_account set status = 'active' where id = $1`, [USERS.chef.id]);
    }
    // the job runs under the company of its payload: company B cannot see company A's row
    expect(await emailTask(deps, { companyId: COMPANY_B, notificationId: id }, job())).toMatchObject({ outcome: 'missing' });
    await expect(emailTask(deps, { companyId: 'x', notificationId: id }, job())).rejects.toThrow(/payload/);
  });

  it('the real Graphile runner (as hrforce_worker) drains the jobs the API enqueued in its transactions', async () => {
    const pending = await query<{ n: number }>(
      db.superuserUrl,
      `select count(*)::int as n from graphile_worker._private_jobs j join graphile_worker._private_tasks t on t.id = j.task_id where t.identifier = 'notifications.email'`,
    );
    expect(pending[0]?.n).toBeGreaterThan(0);
    mailer.sent.length = 0;
    await runOnce({ connectionString: db.workerUrl, taskList: buildTaskList(deps), logger: graphileLogger(pino({ level: 'silent' })), noHandleSignals: true });
    const left = await query<{ n: number; errors: string[] }>(
      db.superuserUrl,
      `select count(*)::int as n, array_agg(j.last_error) as errors from graphile_worker._private_jobs j`,
    );
    expect(left[0], JSON.stringify(left[0]?.errors)).toMatchObject({ n: 0 });
    expect(mailer.sent.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('cron', () => {
  it('schedule: the five contract jobs, parseable by Graphile', () => {
    expect(CRON_ITEMS.map((c) => [c.task, c.match])).toEqual([
      ['audit.ensure_partitions', '10 0 1 * *'],
      ['leave.accruals', '0 1 1 * *'],
      ['auth.cleanup', '0 3 * * *'],
      ['notifications.cleanup', '30 3 * * *'],
      ['employee_files.retention', '0 2 1 * *'],
    ]);
    expect(parsedCronItems()).toHaveLength(5);
    expect(Object.keys(buildTaskList(deps)).toSorted()).toEqual(Object.values(TASKS).toSorted());
  });

  it('leave.accruals month: the month before the tick (backfill-safe), or payload.month', () => {
    expect(accrualMonth({ _cron: { ts: '2026-10-01T01:00:00.000Z' } })).toBe('2026-09-01');
    expect(accrualMonth({ _cron: { ts: '2027-01-01T01:00:00.000Z' } })).toBe('2026-12-01');
    expect(accrualMonth({ month: '2025-06' })).toBe('2025-06-01');
    expect(accrualMonth({}, new Date('2026-03-15T00:00:00Z'))).toBe('2026-02-01');
    expect(() => accrualMonth({ month: '2025-13' })).toThrow(/YYYY-MM/);
  });

  it('leave.accruals: company by company as the system actor; a second run changes nothing', async () => {
    const count = () => query<{ n: number }>(db.superuserUrl, `select count(*)::int as n from leave_ledger where kind = 'accrual' and accrual_month = '2025-06-01'`);
    expect((await count())[0]?.n).toBe(0);
    const first = await accrualsTask(deps, { month: '2025-06' }, { id: 'acc-1', attempt: 1 });
    expect(first).toMatchObject({ month: '2025-06', companies: 2 });
    expect(first['created']).toBeGreaterThan(0);
    const after = (await count())[0]?.n;
    expect(after).toBe(first['created']);
    const second = await accrualsTask(deps, { month: '2025-06' }, { id: 'acc-2', attempt: 1 });
    expect(second).toMatchObject({ created: 0, alreadyAccrued: first['created'] });
    expect((await count())[0]?.n).toBe(after);
    // audited with actor null (system) and the job as request id; ledger created_by null
    const audit = await query<{ actor_user_id: string | null; request_id: string }>(
      db.superuserUrl,
      `select distinct actor_user_id, request_id from audit.change_log where table_name = 'leave_ledger' and request_id like 'job:%'`,
    );
    expect(audit).toEqual([{ actor_user_id: null, request_id: 'job:leave.accruals:acc-1' }]);
  });

  it('audit.ensure_partitions: recreates a missing future partition, then is a no-op', async () => {
    const [last] = await query<{ name: string }>(
      db.superuserUrl,
      `select c.relname as name from pg_inherits i join pg_class c on c.oid = i.inhrelid
        where i.inhparent = 'audit.change_log'::regclass and c.relname <> 'change_log_default' order by c.relname desc limit 1`,
    );
    await query(db.superuserUrl, `drop table audit.${last?.name ?? 'missing'}`);
    expect(await ensurePartitionsTask(deps)).toEqual({ created: 1 });
    expect(await ensurePartitionsTask(deps)).toEqual({ created: 0 });
  });

  it('auth.cleanup: login events > 180 days and used/expired tokens > 30 days; a second run deletes nothing', async () => {
    await query(
      db.superuserUrl,
      `insert into auth.login_event (at, email, outcome) values (now() - interval '200 days', 'old@demo.dz', 'bad_credentials'),
                                                               (now() - interval '10 days', 'recent@demo.dz', 'bad_credentials')`,
    );
    await query(
      db.superuserUrl,
      `insert into auth.password_token (id, user_id, token_hash, purpose, expires_at, used_at, created_at) values
         ('0190a5d0-0000-7000-8000-0000000071a1', $1, sha256('1'), 'reset', now() - interval '39 days', now() - interval '39 days', now() - interval '40 days'),
         ('0190a5d0-0000-7000-8000-0000000071a2', $1, sha256('2'), 'reset', now() - interval '39 days', null, now() - interval '40 days'),
         ('0190a5d0-0000-7000-8000-0000000071a3', $1, sha256('3'), 'setup', now() + interval '1 day', null, now() - interval '40 days'),
         ('0190a5d0-0000-7000-8000-0000000071a4', $1, sha256('4'), 'reset', now() - interval '1 day', now() - interval '1 day', now() - interval '2 days')`,
      [USERS.newbie.id],
    );
    expect(await authCleanupTask(deps)).toEqual({ loginEvents: 1, passwordTokens: 2 });
    expect(await authCleanupTask(deps)).toEqual({ loginEvents: 0, passwordTokens: 0 });
    const tokens = await query<{ id: string }>(db.superuserUrl, `select id from auth.password_token where user_id = $1 order by 1`, [USERS.newbie.id]);
    // kept: a still-valid setup token (old but unexpired, unused) and a recently used one
    expect(tokens.map((t) => t.id)).toEqual(['0190a5d0-0000-7000-8000-0000000071a3', '0190a5d0-0000-7000-8000-0000000071a4']);
  });

  it('notifications.cleanup: only notifications read > 90 days ago, in every company', async () => {
    const [a, b] = await query<{ id: string }>(db.superuserUrl, `select id from notification where company_id = $1 order by created_at limit 2`, [COMPANY_A]);
    await query(db.superuserUrl, `update notification set read_at = now() - interval '100 days' where id = $1`, [a?.id]);
    await query(db.superuserUrl, `update notification set read_at = now() - interval '10 days' where id = $1`, [b?.id]);
    const total = (await query<{ n: number }>(db.superuserUrl, 'select count(*)::int as n from notification'))[0]?.n ?? 0;
    expect(await notificationsCleanupTask(deps, {}, { id: 'nc-1', attempt: 1 })).toEqual({ companies: 2, deleted: 1 });
    expect(await notificationsCleanupTask(deps, {}, { id: 'nc-2', attempt: 1 })).toEqual({ companies: 2, deleted: 0 });
    expect((await query<{ n: number }>(db.superuserUrl, 'select count(*)::int as n from notification'))[0]?.n).toBe(total - 1);
    expect(await query(db.superuserUrl, 'select 1 from notification where id = $1', [b?.id])).toHaveLength(1);
  });

  it('a failing company does not stop the others; the job then fails (retried)', async () => {
    const seen: string[] = [];
    await expect(
      forEachCompany(worker, 'job:test:1', (_tx, companyId) => {
        seen.push(companyId);
        if (companyId === COMPANY_A) throw new Error('boom');
        return Promise.resolve(companyId);
      }),
    ).rejects.toThrow(/failed for 1 company/);
    expect(seen.toSorted()).toEqual([COMPANY_A, COMPANY_B].toSorted());
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('the hrforce_worker role', () => {
  it('RLS applies: without app.company_id it sees no tenant rows; it lists companies only through job_company_ids()', async () => {
    expect((await companyIds(worker)).toSorted()).toEqual([COMPANY_A, COMPANY_B].toSorted());
    const rows = await query(db.workerUrl, 'select id from notification union all select id from company');
    expect(rows).toEqual([]);
  });

  it('has no privilege on auth tables or tenant writes outside its jobs; the app has only add_job on the queue', async () => {
    await expect(query(db.workerUrl, 'select * from auth.user_account')).rejects.toThrow(/permission denied/);
    await expect(query(db.workerUrl, `select * from auth.me('${USERS.admin.id}', '${COMPANY_A}')`)).rejects.toThrow(/permission denied/);
    await expect(query(db.workerUrl, `update leave_type set active = false`)).rejects.toThrow(/permission denied/);
    await expect(query(db.workerUrl, `insert into notification (company_id, user_id, type, subject_type, subject_id) values ('${COMPANY_A}', '${USERS.admin.id}', 'x.y', 'leave_request', gen_random_uuid())`)).rejects.toThrow(/permission denied/);
    await expect(query(db.appUrl, 'select * from graphile_worker._private_jobs')).rejects.toThrow(/permission denied/);
    await expect(query(db.appUrl, 'select graphile_worker.complete_jobs(array[1]::bigint[])')).rejects.toThrow(/permission denied/);
    await expect(query(db.appUrl, 'select public.job_company_ids()')).rejects.toThrow(/permission denied/);
    await expect(query(db.appUrl, 'select auth.cleanup_login_events()')).rejects.toThrow(/permission denied/);
    const [fn] = await query<{ secdef: boolean }>(db.superuserUrl, `select bool_and(prosecdef) as secdef from pg_proc where proname = 'add_job' and pronamespace = 'graphile_worker'::regnamespace`);
    expect(fn?.secdef).toBe(true);
  });
});
