/**
 * Recruitment, Phase A (docs/contracts/recruitment.md) against the real grants (DEV_AUTH header identity, no
 * DEV_PERMISSIONS): the opening request and its approval chain (the head-above rule, the hr_only switch, separation of
 * duties, the scope of approvers), reference numbering, the posts rule, close / fill / reopen with the automatic
 * rejections restored exactly, candidates and applications (scope, duplicates that never leak across regions, known
 * persons), the stage machine with `expectedStage` (two simultaneous moves → one 409), notes, the salary block,
 * candidate files (sniffing, limits, headers, audited downloads, hard delete), the heads' restricted view, settings,
 * the timeline, the audit events without personal payload, the erasure on request and the retention purge run by the
 * worker role — with a search of the whole database and audit log for any remaining personal value.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client } from 'pg';
import { pino } from 'pino';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { demoLogoPng, demoPdf } from '../src/modules/documents/index.js';
import { DEMO_OPENINGS, demoApplication, demoCandidate, demoCandidateFile } from '../src/modules/recruitment/index.js';
import { createDatabase, type Database } from '../src/platform/db/database.js';
import { CRON_ITEMS } from '../src/worker/cron.js';
import { recruitmentRetentionTask, TASKS, type WorkerDeps } from '../src/worker/tasks.js';
import { companyOf, COMPANY_A, COMPANY_B, demoEmployee, seedAccessFixture, unitA, USERS, type ActorName } from './support/access-fixture.js';
import { assertNoSecrets } from './support/assert-no-secrets.js';
import { REC_FX } from './support/recruitment-fixture.js';
import { createTestApp } from './support/test-app.js';
import { createTestDatabase, query, type TestDatabase } from './support/test-database.js';
import { fetchXsrf, type XsrfPair } from './support/xsrf.js';

let db: TestDatabase;
let app: NestExpressApplication;
let xsrf: XsrfPair;
let seq = 0;

const PROBLEM = (slug: string) => `urn:hrforce:problem:${slug}`;
const ANNABA = unitA('AG-ANNABA');
const CNE = unitA('AG-CNE');
const ORAN = unitA('AG-ORAN');
const FUTURE = '2031-06-30';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
/** Response bodies of many shapes, asserted field by field (supertest types them loosely). */
type Body = Response['body'];

/** A request as an actor; every JSON answer is checked for secret-looking keys. */
async function call(actor: ActorName | null, method: Method, url: string, body?: object): Promise<Response> {
  let t = request(app.getHttpServer())[method](url);
  if (actor) t = t.set('X-Dev-User-Id', USERS[actor].id).set('X-Dev-Company-Id', companyOf(actor));
  if (method !== 'get') t = t.set('Cookie', xsrf.cookie).set('X-XSRF-TOKEN', xsrf.token);
  const res = await (body ? t.send(body) : t);
  if (/json/.test(String(res.headers['content-type'] ?? ''))) assertNoSecrets(res.body);
  return res;
}

async function ok(actor: ActorName, method: Method, url: string, body?: object, status = 200): Promise<Body> {
  const res = await call(actor, method, url, body);
  expect(res.status, `${method} ${url} as ${actor}: ${JSON.stringify(res.body)}`).toBe(status);
  return res.body as Body;
}

/** Expects a problem with `status` and `slug`; returns its body. */
async function problem(actor: ActorName, method: Method, url: string, body: object | undefined, status: number, slug: string): Promise<Body> {
  const res = await call(actor, method, url, body);
  expect([res.status, (res.body as Body).type], `${method} ${url} as ${actor}: ${JSON.stringify(res.body)}`).toEqual([status, PROBLEM(slug)]);
  return res.body as Body;
}

const errorsOf = (body: Body): [string, string][] => ((body.errors ?? []) as { field: string; code: string }[]).map((e) => [e.field, e.code]);

function upload(actor: ActorName, candidateId: string, file: Buffer | null, fields: Record<string, string> = {}, filename = 'cv.pdf') {
  let t = request(app.getHttpServer())
    .post(`/api/recruitment/candidates/${candidateId}/files`)
    .set('X-Dev-User-Id', USERS[actor].id)
    .set('X-Dev-Company-Id', companyOf(actor))
    .set('Cookie', xsrf.cookie)
    .set('X-XSRF-TOKEN', xsrf.token);
  for (const [k, v] of Object.entries({ kind: 'cv', title: 'CV', ...fields })) t = t.field(k, v);
  return file ? t.attach('file', file, filename) : t;
}

function download(actor: ActorName, url: string) {
  return request(app.getHttpServer())
    .get(url)
    .set('X-Dev-User-Id', USERS[actor].id)
    .set('X-Dev-Company-Id', companyOf(actor))
    .buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
}

const openingBody = (orgUnitId: string, extra: object = {}) => ({
  title: `Poste test ${++seq}`,
  orgUnitId,
  contractType: 'cdi',
  posts: 2,
  justification: 'Besoin du service, sans nommer de personne.',
  targetDate: FUTURE,
  ...extra,
});

interface Task {
  id: string;
  stepKey: string;
  escalated: boolean;
  subject: { type: string; id: string } & Record<string, unknown>;
}

async function taskOf(actor: ActorName, openingId: string): Promise<Task | undefined> {
  const items = (await ok(actor, 'get', '/api/tasks')).items as Task[];
  return items.find((t) => t.subject.id === openingId);
}

async function openTaskId(openingId: string): Promise<string> {
  const rows = await query<{ id: string }>(
    db.superuserUrl,
    `select t.id from workflow_task t join workflow_instance i on i.id = t.instance_id where i.subject_id = $1 and t.status = 'open'`,
    [openingId],
  );
  return rows[0]?.id ?? '';
}

/** An OPEN opening on `unitId`, created by SQL (no approval history), as the fixture does. */
async function openOpening(unitId: string, posts = 2, companyId = COMPANY_A): Promise<string> {
  const n = ++seq;
  const [row] = await query<{ id: string }>(
    db.superuserUrl,
    `insert into recruitment_opening (company_id, reference, title, org_unit_id, contract_type, posts, justification, target_date, status, requested_by, opened_at)
     values ($1, $2, $3, $4, 'cdi', $5, 'Besoin de test.', '2031-01-01', 'open', $6, now()) returning id`,
    [companyId, `REC-2021-${String(n).padStart(4, '0')}`, `Ouverture SQL ${n}`, unitId, posts, USERS.admin.id],
  );
  return row?.id ?? '';
}

/** A new candidate + application through the API (as `actor`, default admin) → the ApplicationDetailView. */
async function apply(openingId: string, candidate: object = {}, actor: ActorName = 'admin', extra: object = {}): Promise<Body> {
  const n = ++seq;
  return ok(actor, 'post', `/api/recruitment/openings/${openingId}/applications`, { candidate: { lastName: `Candidat${n}`, firstName: 'Test', ...candidate }, source: 'spontaneous', ...extra }, 201);
}

const move = (actor: ActorName, id: string, body: object) => call(actor, 'post', `/api/recruitment/applications/${id}/move`, body);

async function reasonId(code: string, companyId = COMPANY_A): Promise<string> {
  return (await query<{ id: string }>(db.superuserUrl, 'select id from recruitment_rejection_reason where company_id = $1 and code = $2', [companyId, code]))[0]?.id ?? '';
}

/** Every key of a JSON value, at any depth. */
function keysOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysOf(v, out);
  else if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysOf(v, out);
    }
  }
  return out;
}

/**
 * Searches EVERY table of the schemas `public` and `audit` (as the superuser, RLS bypassed) for rows whose text holds
 * one of `needles` (case-insensitive; bytea columns are searched as hex) → `table: needle` hits.
 */
async function searchDatabase(needles: readonly string[]): Promise<string[]> {
  const tables = await query<{ schema: string; name: string }>(
    db.superuserUrl,
    `select n.nspname as schema, c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('public', 'audit') and c.relkind in ('r', 'p') and not c.relispartition order by 1, 2`,
  );
  const hits: string[] = [];
  const pg = new Client({ connectionString: db.superuserUrl });
  await pg.connect();
  try {
    for (const t of tables) {
      const { rows } = await pg.query<{ needle: string }>(
        `select n.needle from unnest($1::text[]) as n (needle)
          where exists (select 1 from ${t.schema}."${t.name}" x where x::text ilike '%' || n.needle || '%')`,
        [needles],
      );
      for (const r of rows) hits.push(`${t.schema}.${t.name}: ${r.needle}`);
    }
  } finally {
    await pg.end();
  }
  return hits;
}

async function asRole(url: string, companyId: string, statement: string): Promise<unknown[]> {
  const pg = new Client({ connectionString: url });
  await pg.connect();
  try {
    await pg.query('begin');
    await pg.query(`select set_config('app.company_id', $1, true)`, [companyId]);
    const { rows } = await pg.query(statement);
    await pg.query('rollback');
    return rows;
  } catch (error) {
    await pg.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await pg.end();
  }
}

const asApp = (statement: string) => asRole(db.appUrl, COMPANY_A, statement);
const asWorker = (statement: string) => asRole(db.workerUrl, COMPANY_A, statement);
const refNumber = (ref: string) => Number(ref.split('-')[2]);
const twinBody = (candidate: object, extra: object = {}) => ({ candidate: { lastName: 'Doublon', firstName: 'Second', ...candidate }, source: 'other', ...extra });
const timeline = async (actor: ActorName, subject: string) => call(actor, 'get', `/api/audit/timeline?subject=${subject}`);
/** Decides an application (withdrawn, or rejected) and back-dates the decision `monthsAgo` months before 2028-06-15. */
const decide = async (applicationId: string, monthsAgo: number, stage: 'rejected' | 'withdrawn' = 'withdrawn') => {
  await ok('admin', 'post', `/api/recruitment/applications/${applicationId}/move`, stage === 'rejected' ? { toStage: 'rejected', expectedStage: 'received', rejectionReasonId: await reasonId('other'), comment: 'Motif confidentiel Xq' } : { toStage: 'withdrawn', expectedStage: 'received', comment: 'Désistement Xq' });
  await query(db.superuserUrl, `update recruitment_application set decided_at = $2::date - make_interval(months => $3) + interval '12 hours' where id = $1`, [applicationId, '2028-06-15', monthsAgo]);
};


beforeAll(async () => {
  db = await createTestDatabase();
  await seedAccessFixture(db, undefined, { leave: true, documents: true, recruitment: true });
  app = await createTestApp(db, { devAuth: true, devPermissions: false });
  xsrf = await fetchXsrf(app);
});

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

// ---------------------------------------------------------------------------------------------------------------
describe('opening request and approval chain', () => {
  it('validation, who may request, and the 403 on the unit', async () => {
    expect(errorsOf(await problem('chef', 'post', '/api/recruitment/openings', { ...openingBody(ANNABA), title: '', posts: 0, contractType: 'x' }, 422, 'validation-error')).map(([f]) => f).toSorted()).toEqual(['contractType', 'posts', 'title']);
    expect(errorsOf(await problem('chef', 'post', '/api/recruitment/openings', openingBody('0190a5d0-0000-7000-8000-00000000dead'), 422, 'validation-error'))).toEqual([['orgUnitId', 'not_found']]);
    // BETA's unit does not exist for a DEMO caller
    expect(errorsOf(await problem('admin', 'post', '/api/recruitment/openings', openingBody('0190a5d0-0000-7000-8000-000000000b11'), 422, 'validation-error'))).toEqual([['orgUnitId', 'not_found']]);
    // an employee who heads nothing, a head outside his units, lecture, admin_acces: 403 forbidden-scope on the unit
    for (const [actor, unit] of [['agent', ANNABA], ['chef', CNE], ['ouest', ORAN], ['acces', CNE], ['est', ORAN]] as const) {
      expect(errorsOf(await problem(actor, 'post', '/api/recruitment/openings', openingBody(unit), 403, 'forbidden-scope')), actor).toEqual([['orgUnitId', 'forbidden_scope']]);
    }
    expect(errorsOf(await problem('chef', 'post', '/api/recruitment/openings', openingBody(ANNABA, { siteId: '0190a5d0-0000-7000-8000-00000000dead' }), 422, 'validation-error'))).toEqual([['siteId', 'not_found']]);
    expect(errorsOf(await problem('chef', 'post', '/api/recruitment/openings', openingBody(ANNABA, { targetDate: '2020-01-01' }), 422, 'validation-error'))).toEqual([['targetDate', 'past']]);
    expect((await call(null, 'post', '/api/recruitment/openings', openingBody(ANNABA))).status).toBe(401);
  });

  it('the chain: chef requests for his agency → the head above (rh.est) → HR → open; requester notified, e-mail queued', async () => {
    const res = await call('chef', 'post', '/api/recruitment/openings', openingBody(ANNABA, { title: 'Guichetier polyvalent' }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const opening = res.body as Body;
    expect(res.headers['location']).toBe(`/api/recruitment/openings/${opening.id}`);
    expect(opening).toMatchObject({
      title: 'Guichetier polyvalent', status: 'pending', posts: 2, hiredCount: 0, contractType: 'cdi', siteInherited: true,
      unit: { id: ANNABA, code: 'AG-ANNABA' }, site: { code: 'ANNABA' }, requestedBy: { id: USERS.chef.id }, openedAt: null, closed: null,
      counts: { total: 0, received: 0 }, _actions: [],
    });
    expect(opening.reference).toMatch(/^REC-\d{4}-\d{4}$/);
    expect(opening.workflow.steps.map((s: Body) => [s.key, s.state])).toEqual([['manager', 'current'], ['hr', 'pending']]);

    // the chef heads the unit himself: the manager task goes to the head of Région Est (rh.est), with all an approver needs
    expect(await taskOf('chef', opening.id)).toBeUndefined();
    expect(await taskOf('admin', opening.id)).toBeUndefined();
    const managerTask = await taskOf('est', opening.id);
    expect(managerTask).toMatchObject({
      stepKey: 'manager', escalated: false,
      subject: { type: 'recruitment_opening', id: opening.id, reference: opening.reference, title: 'Guichetier polyvalent', contractType: 'cdi', posts: 2, targetDate: FUTURE, unit: { code: 'AG-ANNABA' }, site: { code: 'ANNABA' }, requestedBy: { id: USERS.chef.id } },
    });
    const assigned = await query<{ user_id: string; data: Body }>(db.superuserUrl, `select user_id, data from notification where type = 'task.assigned' and subject_id = $1`, [managerTask?.id]);
    expect(assigned.map((n) => n.user_id)).toEqual([USERS.est.id]);
    expect(assigned[0]?.data).toMatchObject({ subjectType: 'recruitment_opening', openingId: opening.id, reference: opening.reference, title: 'Guichetier polyvalent', unitName: 'Agence Annaba', posts: 2 });

    // scope of approvers: nobody else may act on the task (404), the requester neither
    for (const actor of ['admin', 'ouest', 'agent', 'beta', 'chef'] as const) expect((await call(actor, 'post', `/api/tasks/${managerTask?.id}/approve`, {})).status, actor).toBe(404);
    await ok('est', 'post', `/api/tasks/${managerTask?.id}/approve`, {});

    // the HR step: holders of recruitment.approve_opening over the unit — admin and rh_regional of the region
    const hrTask = await taskOf('admin', opening.id);
    expect(hrTask?.stepKey).toBe('hr');
    for (const actor of ['ouest', 'agent', 'beta', 'acces'] as const) expect((await call(actor, 'post', `/api/tasks/${hrTask?.id}/approve`, {})).status, actor).toBe(404);
    await ok('admin', 'post', `/api/tasks/${hrTask?.id}/approve`, { comment: 'Budget confirmé.' });

    const mine = await ok('chef', 'get', `/api/me/recruitment/openings/${opening.id}`);
    expect(mine).toMatchObject({ status: 'open', roles: ['requester', 'head'], applications: [], _actions: [] });
    expect(mine.openedAt).not.toBeNull();
    expect(mine.history.map((t: Body) => [t.stepKey, t.outcome])).toEqual([['manager', 'approve'], ['hr', 'approve']]);
    const hr = await ok('admin', 'get', `/api/recruitment/openings/${opening.id}`);
    expect(hr).toMatchObject({ status: 'open', _actions: ['update', 'close', 'add_application'] });

    const [approved] = await query<{ id: string; user_id: string; data: Body; subject_type: string }>(db.superuserUrl, `select id, user_id, data, subject_type from notification where type = 'recruitment.opening_approved' and subject_id = $1`, [opening.id]);
    expect(approved).toMatchObject({ user_id: USERS.chef.id, subject_type: 'recruitment_opening', data: { openingId: opening.id, reference: opening.reference, title: 'Guichetier polyvalent', unitName: 'Agence Annaba', posts: 2, actorName: USERS.admin.displayName } });
    expect(await query(db.superuserUrl, `select 1 from graphile_worker._private_jobs where key = $1`, [`notifications.email:${approved?.id}`])).toHaveLength(1);
    const feed = (await ok('chef', 'get', '/api/me/notifications')).items as Body[];
    expect(feed.find((n) => n.id === approved?.id)?.link).toBe(`/me/recruitment/openings/${opening.id}`);
  });

  it('reference numbering: REC-<year>-<4 digits>, consecutive per company, distinct under concurrency', async () => {
    const a = await ok('chef', 'post', '/api/recruitment/openings', openingBody(ANNABA), 201);
    const b = await ok('est', 'post', '/api/recruitment/openings', openingBody(CNE), 201);
    const year = new Date(Date.now() + 3_600_000).toISOString().slice(0, 4);
    expect(a.reference.startsWith(`REC-${year}-`)).toBe(true);
    expect(refNumber(b.reference)).toBe(refNumber(a.reference) + 1);
    const parallel = await Promise.all(Array.from({ length: 4 }, () => call('chef', 'post', '/api/recruitment/openings', openingBody(ANNABA))));
    expect(parallel.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    const numbers = parallel.map((r) => refNumber((r.body as Body).reference)).toSorted((x, y) => x - y);
    expect(numbers).toEqual([1, 2, 3, 4].map((k) => refNumber(b.reference) + k));
    // BETA has its own counter
    const beta = await ok('beta', 'post', '/api/recruitment/openings', openingBody('0190a5d0-0000-7000-8000-000000000b11'), 201);
    expect(beta.reference).toBe(`REC-${year}-0001`);
  });

  it('a request by the regional head escalates past the missing head above; an HR requester never takes the HR step', async () => {
    // Karim (rh.est) heads Région Est: nobody above him has an account → the manager step is skipped
    const opening = await ok('est', 'post', '/api/recruitment/openings', openingBody(unitA('REG-EST')), 201);
    expect(opening.history.map((t: Body) => [t.stepKey, t.status, t.outcome, t.comment])).toEqual([['manager', 'skipped', 'escalated', 'manager-not-linked'], ['hr', 'open', null, null]]);
    const [escalated] = await query<{ user_id: string }>(db.superuserUrl, `select user_id from notification where type = 'task.escalated' and subject_id = $1`, [opening.id]);
    expect(escalated?.user_id).toBe(USERS.est.id);
    // he holds recruitment.approve_opening over the unit, but it is his own request
    expect(await taskOf('est', opening.id)).toBeUndefined();
    const taskId = await openTaskId(opening.id);
    await problem('est', 'post', `/api/tasks/${taskId}/approve`, {}, 409, 'workflow-self-approval');
    expect((await taskOf('admin', opening.id))?.escalated).toBe(true);
    await ok('admin', 'post', `/api/tasks/${taskId}/approve`, {});
    expect((await ok('est', 'get', `/api/recruitment/openings/${opening.id}`)).status).toBe('open');
  });

  it('the hr_only switch applies to new requests; rejection needs a comment and tells the requester; cancel is the requester’s, while pending', async () => {
    await ok('admin', 'put', '/api/recruitment/policy', { openingWorkflowCode: 'recruitment.hr_only' });
    const hrOnly = await ok('chef', 'post', '/api/recruitment/openings', openingBody(ANNABA), 201);
    expect(hrOnly.workflow.steps.map((s: Body) => s.key)).toEqual(['hr']);
    expect(await taskOf('est', hrOnly.id)).toMatchObject({ stepKey: 'hr' });
    await ok('admin', 'put', '/api/recruitment/policy', { openingWorkflowCode: 'recruitment.manager_then_hr' });

    const taskId = await openTaskId(hrOnly.id);
    expect(errorsOf(await problem('est', 'post', `/api/tasks/${taskId}/reject`, {}, 422, 'validation-error'))).toEqual([['comment', 'required']]);
    await ok('est', 'post', `/api/tasks/${taskId}/reject`, { comment: 'Poste non budgétisé' });
    const rejected = await ok('chef', 'get', `/api/me/recruitment/openings/${hrOnly.id}`);
    expect(rejected).toMatchObject({ status: 'rejected', rejectionComment: 'Poste non budgétisé', _actions: [] });
    const [note] = await query<{ user_id: string; data: Body }>(db.superuserUrl, `select user_id, data from notification where type = 'recruitment.opening_rejected' and subject_id = $1`, [hrOnly.id]);
    expect(note).toMatchObject({ user_id: USERS.chef.id, data: { reference: hrOnly.reference, actorName: USERS.est.displayName } });
    expect(JSON.stringify(note?.data)).not.toMatch(/budgétisé|Besoin du service/);
    await problem('chef', 'post', `/api/me/recruitment/openings/${hrOnly.id}/cancel`, undefined, 409, 'recruitment-opening-not-cancellable');

    const pending = await ok('chef', 'post', '/api/recruitment/openings', openingBody(ANNABA), 201);
    expect((await ok('chef', 'get', `/api/me/recruitment/openings/${pending.id}`))['_actions']).toEqual(['cancel']);
    // rh.est heads the region: he sees it (head) but it is not his to cancel; anyone else gets 404 on the opening itself
    expect((await call('est', 'post', `/api/me/recruitment/openings/${pending.id}/cancel`)).status).toBe(404);
    expect((await call('agent', 'get', `/api/me/recruitment/openings/${pending.id}`)).status).toBe(404);
    const cancelled = await ok('chef', 'post', `/api/me/recruitment/openings/${pending.id}/cancel`);
    expect(cancelled).toMatchObject({ status: 'cancelled', _actions: [] });
    expect(await taskOf('est', pending.id)).toBeUndefined();
    // an HR requester reaches the requester view too (the link of the notifications), without applications
    const byHr = await ok('admin', 'post', '/api/recruitment/openings', openingBody(ORAN), 201);
    expect(await ok('admin', 'get', `/api/me/recruitment/openings/${byHr.id}`)).toMatchObject({ roles: ['requester'], counts: null, applications: null, _actions: ['cancel'] });
    // admin is the only HR of the Ouest region: the task is not his to take
    await problem('admin', 'post', `/api/tasks/${await openTaskId(byHr.id)}/approve`, {}, 409, 'workflow-self-approval');
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('openings: lists, edits, the posts rule, close and reopen', () => {
  it('GET /recruitment/openings and /summary are scoped: rh.est sees its region only; lecture and admin_acces nothing', async () => {
    const all = await ok('admin', 'get', '/api/recruitment/openings?status=all&pageSize=100');
    const est = await ok('est', 'get', '/api/recruitment/openings?status=all&pageSize=100');
    const estUnits = new Set(['AG-CNE', 'AG-ANNABA', 'SRV-CLI-ANB', 'SRV-ADM-EST', 'REG-EST']);
    expect(est.items.length).toBeGreaterThan(3);
    expect(est.items.every((o: Body) => estUnits.has(o.unit.code))).toBe(true);
    expect(all.total).toBeGreaterThan(est.total);
    expect(all.items.some((o: Body) => o.unit.code === 'AG-ORAN')).toBe(true);
    for (const actor of ['ouest', 'acces', 'agent', 'chef'] as const) {
      expect((await call(actor, 'get', '/api/recruitment/openings')).status, actor).toBe(403);
      expect((await call(actor, 'get', '/api/recruitment/summary')).status, actor).toBe(403);
    }
    // filters: status (default = pending + open), unit with sub-units, contract type, search, sort
    const active = await ok('admin', 'get', '/api/recruitment/openings?pageSize=100');
    expect(new Set(active.items.map((o: Body) => o.status))).toEqual(new Set(['pending', 'open']));
    const filled = await ok('admin', 'get', '/api/recruitment/openings?status=filled');
    expect(filled.items.map((o: Body) => o.reference)).toEqual(['REC-2026-0003']);
    expect(filled.items[0]).toMatchObject({ hiredCount: 1, posts: 1, closed: { by: null, reason: null }, counts: { hired: 1, rejected: 2, total: 3 } });
    const annaba = await ok('admin', 'get', `/api/recruitment/openings?status=all&unitId=${ANNABA}&pageSize=100`);
    expect(new Set(annaba.items.map((o: Body) => o.unit.code))).toEqual(new Set(['AG-ANNABA', 'SRV-CLI-ANB']));
    const exact = await ok('admin', 'get', `/api/recruitment/openings?status=all&unitId=${ANNABA}&includeSubUnits=false&pageSize=100`);
    expect(new Set(exact.items.map((o: Body) => o.unit.code))).toEqual(new Set(['AG-ANNABA']));
    expect((await ok('admin', 'get', '/api/recruitment/openings?status=all&q=clientele')).items.map((o: Body) => o.reference)).toEqual(['REC-2026-0001']);
    expect((await ok('admin', 'get', '/api/recruitment/openings?status=all&q=rec-2026-0006')).items.map((o: Body) => o.title)).toEqual(['Conseiller(ère) commercial(e)']);
    const cdd = await ok('admin', 'get', '/api/recruitment/openings?status=all&contractType=cdd&pageSize=100');
    expect(cdd.items.every((o: Body) => o.contractType === 'cdd')).toBe(true);
    const byTitle = (await ok('admin', 'get', '/api/recruitment/openings?status=all&sort=title&pageSize=100')).items.map((o: Body) => o.title);
    expect(byTitle).toEqual(byTitle.toSorted((a: string, b: string) => a.localeCompare(b, 'fr')));
    expect((await call('admin', 'get', '/api/recruitment/openings?status=nope')).status).toBe(422);

    const summary = await ok('admin', 'get', '/api/recruitment/summary');
    const estSummary = await ok('est', 'get', '/api/recruitment/summary');
    expect(Object.keys(summary.openings).toSorted()).toEqual(['cancelled', 'closed', 'filled', 'open', 'pending', 'rejected']);
    expect(Object.keys(summary.applications).toSorted()).toEqual(['interview', 'offer', 'received', 'shortlisted']);
    expect(summary.openings.closed).toBeGreaterThan(estSummary.openings.closed); // the closed ones are all in the Ouest region
    expect(estSummary.openings.filled).toBe(1);
    expect(summary.applications.interview).toBeGreaterThan(estSummary.applications.interview);

    // detail: 404 outside the read scope, other company, unknown, malformed
    expect((await call('est', 'get', `/api/recruitment/openings/${DEMO_OPENINGS.oran}`)).status).toBe(404);
    expect((await call('beta', 'get', `/api/recruitment/openings/${DEMO_OPENINGS.annaba}`)).status).toBe(404);
    expect((await call('admin', 'get', '/api/recruitment/openings/nope')).status).toBe(404);
    const detail = await ok('est', 'get', `/api/recruitment/openings/${DEMO_OPENINGS.annaba}`);
    expect(detail).toMatchObject({ reference: 'REC-2026-0001', anemReference: 'ANEM-23-2026-0417', counts: { received: 2, shortlisted: 1, interview: 2, rejected: 1, withdrawn: 1, total: 7 } });
    expect(detail.history.map((t: Body) => [t.stepKey, t.outcome, t.actedBy?.id])).toEqual([['manager', 'approve', USERS.est.id], ['hr', 'approve', USERS.admin.id]]);
  });

  it('PATCH while open: target date, site, ANEM reference; posts downwards only; lowering to the hires fills the opening', async () => {
    const id = await openOpening(CNE, 3);
    const a1 = await apply(id);
    const a2 = await apply(id);
    await ok('admin', 'post', `/api/recruitment/applications/${a2.id}/move`, { toStage: 'interview', expectedStage: 'received' });
    const patched = await ok('est', 'patch', `/api/recruitment/openings/${id}`, { targetDate: '2032-02-01', anemReference: ' ANEM-1 ', siteId: '0190a5d0-0000-7000-8000-000000000205' });
    expect(patched).toMatchObject({ targetDate: '2032-02-01', anemReference: 'ANEM-1', site: { code: 'ANNABA' }, siteInherited: false });
    expect(await ok('est', 'patch', `/api/recruitment/openings/${id}`, { siteId: null, anemReference: null })).toMatchObject({ anemReference: null, site: { code: 'CNE' }, siteInherited: true });
    expect(errorsOf(await problem('est', 'patch', `/api/recruitment/openings/${id}`, { posts: 4 }, 422, 'validation-error'))).toEqual([['posts', 'increase']]);
    expect(errorsOf(await problem('est', 'patch', `/api/recruitment/openings/${id}`, { targetDate: '2020-01-01' }, 422, 'validation-error'))).toEqual([['targetDate', 'past']]);
    expect((await ok('est', 'patch', `/api/recruitment/openings/${id}`, { posts: 2 })).posts).toBe(2);
    // scope: lecture 403 (guard), an Est user on an Ouest opening 404, admin_acces 403
    expect((await call('ouest', 'patch', `/api/recruitment/openings/${id}`, { posts: 1 })).status).toBe(403);
    expect((await call('est', 'patch', `/api/recruitment/openings/${DEMO_OPENINGS.oran}`, { posts: 1 })).status).toBe(404);

    // one hire recorded (Phase B does it through the hire): a third application, hired
    const hired = await apply(id);
    await query(db.superuserUrl, `update recruitment_application set stage = 'hired', decided_at = now() where id = $1`, [hired.id]);
    await query(db.superuserUrl, `update recruitment_opening set hired_count = 1 where id = $1`, [id]);
    expect(errorsOf(await problem('est', 'patch', `/api/recruitment/openings/${id}`, { posts: 0 }, 422, 'validation-error'))).toEqual([['posts', 'too_small']]);
    const filled = await ok('est', 'patch', `/api/recruitment/openings/${id}`, { posts: 1 });
    expect(filled).toMatchObject({ status: 'filled', posts: 1, hiredCount: 1, closed: { by: null, reason: null }, counts: { hired: 1, rejected: 2, total: 3 }, _actions: [] });
    for (const a of [a1, a2]) {
      const after = await ok('admin', 'get', `/api/recruitment/applications/${a.id}`);
      expect(after).toMatchObject({ stage: 'rejected', rejectionReason: { code: 'position_filled', labels: { fr: 'Poste pourvu', ar: 'تم شغل المنصب' } }, moveTargets: [], _actions: ['add_note', 'update', 'update_salary'] });
      expect(after.stages.at(-1)).toMatchObject({ to: 'rejected', autoCause: 'opening_filled', by: { id: USERS.est.id } });
      expect(after.decidedAt).not.toBeNull();
    }
    // any write on an opening that is not open → 409
    await problem('est', 'patch', `/api/recruitment/openings/${id}`, { targetDate: '2032-03-01' }, 409, 'recruitment-opening-not-open');
    await problem('est', 'post', `/api/recruitment/openings/${id}/close`, { reason: 'Trop tard' }, 409, 'recruitment-opening-not-open');
    await problem('est', 'post', `/api/recruitment/openings/${id}/applications`, { candidate: { lastName: 'Tard', firstName: 'Trop' }, source: 'other' }, 409, 'recruitment-opening-not-open');
    await problem('est', 'post', `/api/recruitment/openings/${id}/reopen`, undefined, 409, 'recruitment-opening-not-closed');
  });

  it('close rejects the applications in progress (opening_closed); reopen restores exactly those, each in its stage', async () => {
    const id = await openOpening(CNE);
    const received = await apply(id);
    const interview = await apply(id);
    const manual = await apply(id);
    const withdrawn = await apply(id);
    await ok('est', 'post', `/api/recruitment/applications/${interview.id}/move`, { toStage: 'interview', expectedStage: 'received' });
    await ok('est', 'post', `/api/recruitment/applications/${manual.id}/move`, { toStage: 'rejected', expectedStage: 'received', rejectionReasonId: await reasonId('experience') });
    await ok('est', 'post', `/api/recruitment/applications/${withdrawn.id}/move`, { toStage: 'withdrawn', expectedStage: 'received' });

    expect(errorsOf(await problem('est', 'post', `/api/recruitment/openings/${id}/close`, { reason: 'x' }, 422, 'validation-error'))).toEqual([['reason', 'too_small']]);
    const closed = await ok('est', 'post', `/api/recruitment/openings/${id}/close`, { reason: 'Budget reporté' });
    expect(closed).toMatchObject({ status: 'closed', closed: { by: { id: USERS.est.id }, reason: 'Budget reporté' }, counts: { rejected: 3, withdrawn: 1, received: 0, interview: 0, total: 4 }, _actions: ['reopen'] });
    const stageOf = async (appId: string) => {
      const a = await ok('admin', 'get', `/api/recruitment/applications/${appId}`);
      return [a.stage, a.rejectionReason?.code ?? null, a.stages.at(-1).autoCause, a.decidedAt !== null];
    };
    expect(await stageOf(received.id)).toEqual(['rejected', 'opening_closed', 'opening_closed', true]);
    expect(await stageOf(interview.id)).toEqual(['rejected', 'opening_closed', 'opening_closed', true]);
    expect(await stageOf(manual.id)).toEqual(['rejected', 'experience', null, true]);
    // its applications are all final: no move, no reopen of one of them while the opening is closed
    await problem('est', 'post', `/api/recruitment/applications/${manual.id}/reopen`, { expectedStage: 'rejected' }, 409, 'recruitment-opening-not-open');
    await problem('est', 'post', `/api/recruitment/openings/${id}/close`, { reason: 'Deux fois' }, 409, 'recruitment-opening-not-open');

    const reopened = await ok('est', 'post', `/api/recruitment/openings/${id}/reopen`);
    expect(reopened).toMatchObject({ status: 'open', closed: null, counts: { received: 1, interview: 1, rejected: 1, withdrawn: 1, total: 4 } });
    expect(await stageOf(received.id)).toEqual(['received', null, 'opening_reopened', false]);
    expect(await stageOf(interview.id)).toEqual(['interview', null, 'opening_reopened', false]);
    expect(await stageOf(manual.id)).toEqual(['rejected', 'experience', null, true]);
    expect((await ok('admin', 'get', `/api/recruitment/applications/${withdrawn.id}`)).stage).toBe('withdrawn');
    expect((await ok('admin', 'get', `/api/recruitment/applications/${interview.id}`)).stages.map((s: Body) => [s.from, s.to, s.autoCause])).toEqual([
      [null, 'received', null], ['received', 'interview', null], ['interview', 'rejected', 'opening_closed'], ['rejected', 'interview', 'opening_reopened'],
    ]);
    // no post left: a closed opening whose posts are all filled is not reopened
    const full = await openOpening(CNE, 1);
    await ok('admin', 'post', `/api/recruitment/openings/${full}/close`, { reason: 'Clos' });
    await query(db.superuserUrl, `update recruitment_opening set hired_count = 1 where id = $1`, [full]);
    await problem('admin', 'post', `/api/recruitment/openings/${full}/reopen`, undefined, 409, 'recruitment-no-post-left');
  });

  it('database guards on openings: immutable request, only the contract’s status transitions, no delete', async () => {
    const id = await openOpening(CNE);
    await expect(asRole(db.appUrl, COMPANY_A, `update recruitment_opening set title = 'Autre' where id = '${id}'`)).rejects.toThrow(/immutable/);
    await expect(asRole(db.appUrl, COMPANY_A, `update recruitment_opening set status = 'pending' where id = '${id}'`)).rejects.toThrow(/status cannot go/);
    await expect(asRole(db.appUrl, COMPANY_A, `update recruitment_opening set status = 'filled', closed_at = now() where id = '${id}'`)).rejects.toThrow(/recruitment_opening_filled_ck/);
    await expect(asRole(db.appUrl, COMPANY_A, `delete from recruitment_opening where id = '${id}'`)).rejects.toThrow(/permission denied/);
    await expect(asRole(db.appUrl, COMPANY_A, `delete from recruitment_rejection_reason`)).rejects.toThrow(/permission denied/);
    expect(await asRole(db.appUrl, COMPANY_B, `select id from recruitment_opening where id = '${id}'`)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('candidates and applications', () => {
  it('create: a new candidate with its application; the salary needs its own permissions', async () => {
    const view = await apply(DEMO_OPENINGS.annaba, { lastName: '  Benkhaled ', firstName: 'Rym', lastNameAr: 'بن خالد', birthDate: '1995-04-12', nin: '2 95 99 0000000000777', email: 'Rym.Benkhaled@Example.TEST', phone: '+213 555 10 20 30', informedOn: '2026-10-01' }, 'est', { source: 'anem', comment: 'Reçue au guichet' });
    expect(view).toMatchObject({
      stage: 'received', source: 'anem', decidedAt: null, rejectionReason: null,
      opening: { id: DEMO_OPENINGS.annaba, reference: 'REC-2026-0001', status: 'open', unit: { code: 'AG-ANNABA' } },
      candidate: { person: { lastName: 'Benkhaled', firstName: 'Rym', lastNameAr: 'بن خالد', firstNameAr: null }, birthDate: '1995-04-12', nationality: 'DZ', nin: '295990000000000777', email: 'rym.benkhaled@example.test', phone: '+213 555 10 20 30', informedOn: '2026-10-01', createdBy: { id: USERS.est.id }, knownPerson: null, files: [] },
      moveTargets: ['shortlisted', 'interview', 'rejected', 'withdrawn'], notes: [],
      // rh_regional runs the pipeline without the salaries
      _redacted: ['salary'], _actions: ['move', 'add_note', 'update'],
    });
    expect('salary' in view).toBe(false);
    expect(view.stages).toHaveLength(1);
    expect(view.stages[0]).toMatchObject({ from: null, to: 'received', comment: 'Reçue au guichet', by: { id: USERS.est.id }, autoCause: null, rejectionReason: null });
    expect(view.candidate.applications.map((a: Body) => a.id)).toEqual([view.id]);
    expect(view.candidate['_actions']).toEqual(['update', 'upload', 'link_person']); // no erase for rh_regional

    // rh_regional writing a salary: 403 forbidden-field, nothing written
    const before = (await ok('admin', 'get', `/api/recruitment/openings/${DEMO_OPENINGS.annaba}`)).counts.total;
    expect(errorsOf(await problem('est', 'post', `/api/recruitment/openings/${DEMO_OPENINGS.annaba}/applications`, { candidate: { lastName: 'Salaire', firstName: 'Interdit' }, source: 'other', expectedSalary: '90000' }, 403, 'forbidden-field'))).toEqual([['expectedSalary', 'forbidden']]);
    expect(errorsOf(await problem('est', 'patch', `/api/recruitment/applications/${view.id}`, { expectedSalary: '90000' }, 403, 'forbidden-field'))).toEqual([['expectedSalary', 'forbidden']]);
    expect((await ok('admin', 'get', `/api/recruitment/openings/${DEMO_OPENINGS.annaba}`)).counts.total).toBe(before);
    expect(await query(db.superuserUrl, 'select 1 from recruitment_application_salary where application_id = $1', [view.id])).toEqual([]);

    // central HR reads and writes it; money is a decimal string
    const asAdmin = await ok('admin', 'get', `/api/recruitment/applications/${view.id}`);
    expect(asAdmin).toMatchObject({ salary: { expected: null }, _redacted: [], _actions: ['move', 'add_note', 'update', 'update_salary'] });
    expect(asAdmin.candidate['_actions']).toEqual(['update', 'upload', 'link_person', 'erase']);
    expect((await ok('admin', 'patch', `/api/recruitment/applications/${view.id}`, { expectedSalary: '72000', source: 'referral' })).salary).toEqual({ expected: '72000.00' });
    expect((await ok('est', 'patch', `/api/recruitment/applications/${view.id}`, { source: 'job_board' }))).toMatchObject({ source: 'job_board', _redacted: ['salary'] });
    expect(errorsOf(await problem('admin', 'patch', `/api/recruitment/applications/${view.id}`, { expectedSalary: '-5' }, 422, 'validation-error'))).toEqual([['expectedSalary', 'custom']]);
    expect((await ok('admin', 'patch', `/api/recruitment/applications/${view.id}`, { expectedSalary: null })).salary).toEqual({ expected: null });
    expect(await query(db.superuserUrl, 'select 1 from recruitment_application_salary where application_id = $1', [view.id])).toEqual([]);
    const created = await apply(DEMO_OPENINGS.annaba, {}, 'admin', { expectedSalary: '65000.50' });
    expect(created.salary).toEqual({ expected: '65000.50' });
    // the seeded one: visible to central HR only
    expect((await ok('admin', 'get', `/api/recruitment/applications/${demoApplication(3)}`)).salary).toEqual({ expected: '68000.00' });
    const seededAsEst = await ok('est', 'get', `/api/recruitment/applications/${demoApplication(3)}`);
    expect(seededAsEst['_redacted']).toEqual(['salary']);
    expect(JSON.stringify(seededAsEst)).not.toContain('68000');
  });

  it('create: body rules, an existing candidate, already applied, an opening that is not open', async () => {
    const url = `/api/recruitment/openings/${DEMO_OPENINGS.annaba}/applications`;
    expect(errorsOf(await problem('est', 'post', url, { source: 'other' }, 422, 'validation-error'))).toEqual([['candidate', 'one_of']]);
    expect(errorsOf(await problem('est', 'post', url, { candidateId: demoCandidate(1), candidate: { lastName: 'A', firstName: 'B' }, source: 'other' }, 422, 'validation-error'))).toEqual([['candidate', 'one_of']]);
    expect(errorsOf(await problem('est', 'post', url, { candidate: { lastName: '', firstName: 'B', nin: '123', email: 'pas-un-mail', sex: 'X' }, source: 'x' }, 422, 'validation-error')).map(([f]) => f).toSorted()).toEqual(['candidate.email', 'candidate.lastName', 'candidate.nin', 'candidate.sex', 'source']);
    expect(errorsOf(await problem('est', 'post', url, { candidateId: '0190a5d0-0000-7000-8000-00000000dead', source: 'other' }, 422, 'validation-error'))).toEqual([['candidateId', 'not_found']]);
    // a candidate the caller cannot see (Ouest only) answers like an unknown one; an existing visible one applies once
    expect(errorsOf(await problem('est', 'post', url, { candidateId: demoCandidate(13), source: 'other' }, 422, 'validation-error'))).toEqual([['candidateId', 'not_found']]);
    expect(errorsOf(await problem('est', 'post', url, { candidateId: demoCandidate(1), source: 'other' }, 409, 'recruitment-already-applied'))).toEqual([['candidateId', 'already_applied']]);
    const other = await openOpening(CNE);
    const second = await ok('est', 'post', `/api/recruitment/openings/${other}/applications`, { candidateId: demoCandidate(1), source: 'internal' }, 201);
    expect(second.candidate.id).toBe(demoCandidate(1));
    expect(second.candidate.applications.map((a: Body) => a.opening.id).toSorted()).toEqual([DEMO_OPENINGS.annaba, other].toSorted());
    // a pending / rejected / filled opening takes no application; out of scope 404; lecture 403
    for (const opening of [DEMO_OPENINGS.accueil, DEMO_OPENINGS.chauffeur, DEMO_OPENINGS.cne]) {
      await problem('est', 'post', `/api/recruitment/openings/${opening}/applications`, { candidate: { lastName: 'A', firstName: 'B' }, source: 'other' }, 409, 'recruitment-opening-not-open');
    }
    expect((await call('est', 'post', `/api/recruitment/openings/${DEMO_OPENINGS.oran}/applications`, { candidate: { lastName: 'A', firstName: 'B' }, source: 'other' })).status).toBe(404);
    expect((await call('ouest', 'post', url, { candidate: { lastName: 'A', firstName: 'B' }, source: 'other' })).status).toBe(403);
  });

  it('duplicates: the NIN never overridable, e-mail and phone unless allowDuplicate — and only among what the caller can see', async () => {
    const opening = await openOpening(CNE);
    const url = `/api/recruitment/openings/${opening}/applications`;
    const first = await apply(opening, { lastName: 'Doublon', firstName: 'Premier', birthDate: '1990-05-05', nin: '190990000000000888', email: 'doublon@example.test', phone: '0555 11 22 33' }, 'est');
    expect(errorsOf(await problem('est', 'post', url, twinBody({ nin: '190990000000000888' }), 409, 'recruitment-candidate-duplicate'))).toEqual([['nin', 'duplicate']]);
    expect(errorsOf(await problem('est', 'post', url, twinBody({ nin: '190990000000000888' }, { allowDuplicate: true }), 409, 'recruitment-candidate-duplicate'))).toEqual([['nin', 'duplicate']]);
    expect(errorsOf(await problem('est', 'post', url, twinBody({ email: 'DOUBLON@example.test' }), 409, 'recruitment-candidate-duplicate'))).toEqual([['email', 'duplicate']]);
    // the same number written another way
    expect(errorsOf(await problem('est', 'post', url, twinBody({ phone: '+213 555 112 233' }), 409, 'recruitment-candidate-duplicate'))).toEqual([['phone', 'duplicate']]);
    expect(errorsOf(await problem('est', 'post', url, twinBody({ email: 'doublon@example.test', phone: '00213555112233' }), 409, 'recruitment-candidate-duplicate'))).toEqual([['email', 'duplicate'], ['phone', 'duplicate']]);
    const relative = await ok('est', 'post', url, twinBody({ phone: '0555112233' }, { allowDuplicate: true }), 201);
    expect(relative.candidate.id).not.toBe(first.candidate.id);

    // match: what the add form shows before saving
    const match = async (actor: ActorName, input: object) => ok(actor, 'post', '/api/recruitment/candidates/match', input);
    const byNin = await match('est', { nin: '190990000000000888' });
    expect(byNin.candidates).toEqual([{ id: first.candidate.id, person: { lastName: 'Doublon', firstName: 'Premier', lastNameAr: null, firstNameAr: null }, birthDate: '1990-05-05', matchedOn: ['nin'], applications: [{ id: first.id, opening: expect.objectContaining({ id: opening }), stage: 'received' }] }]);
    expect(byNin.person).toBeNull();
    expect((await match('est', { phone: '0555 11 22 33' })).candidates.map((c: Body) => [c.id, c.matchedOn]).toSorted()).toEqual([[first.candidate.id, ['phone']], [relative.candidate.id, ['phone']]].toSorted());
    expect((await match('est', { lastName: 'doublon', firstName: 'PREMIER', birthDate: '1990-05-05' })).candidates.map((c: Body) => c.matchedOn)).toEqual([['name_birth']]);
    expect((await match('est', { lastName: 'Doublon', firstName: 'Premier' })).candidates).toEqual([]);
    expect((await match('est', { email: 'doublon@example.test', excludeCandidateId: first.candidate.id })).candidates).toEqual([]);
    expect(errorsOf(await problem('est', 'post', '/api/recruitment/candidates/match', { birthDate: '1990-05-05' }, 422, 'validation-error'))).toEqual([['nin', 'required']]);
    const res = await call('est', 'post', '/api/recruitment/candidates/match', { nin: '190990000000000888' });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(await query(db.superuserUrl, `select 1 from audit.event where type like 'recruitment.%' and request_id = $1`, [res.headers['x-request-id']])).toEqual([]);

    // an out-of-scope duplicate is INVISIBLE: the Ouest candidate's NIN returns nothing to an Est user, and saving it
    // is not refused (two regions may each hold a record — accepted); central HR sees both
    expect((await match('est', { nin: REC_FX.ouestNin, email: 'principal.ouest@example.test', phone: '0661 00 00 01' })).candidates).toEqual([]);
    const twin = await ok('est', 'post', url, { candidate: { lastName: 'Jumeau', firstName: 'Est', nin: REC_FX.ouestNin, email: 'principal.ouest@example.test' }, source: 'other' }, 201);
    expect((await match('admin', { nin: REC_FX.ouestNin })).candidates.map((c: Body) => c.id).toSorted()).toEqual([REC_FX.candidate.ouest, twin.candidate.id].toSorted());
    expect((await match('ouest', { nin: REC_FX.ouestNin }).catch(() => null)) ?? null).toBeNull();
  });

  it('PATCH a candidate: identity and contact; duplicates on what changes; scope', async () => {
    const opening = await openOpening(CNE);
    const a = await apply(opening, { lastName: 'Avant', firstName: 'Nom', phone: '0770 00 00 01' }, 'est');
    const b = await apply(opening, { lastName: 'Autre', firstName: 'Personne', nin: '190990000000000999', email: 'autre@example.test' }, 'est');
    const id = a.candidate.id;
    const patched = await ok('est', 'patch', `/api/recruitment/candidates/${id}`, { lastName: 'Après', firstNameAr: 'اسم', birthDate: '1991-01-01', birthPlace: 'Skikda', sex: 'F', nationality: 'tn', email: 'apres@example.test', informedOn: '2026-10-02' });
    expect(patched).toMatchObject({ person: { lastName: 'Après', firstName: 'Nom', firstNameAr: 'اسم' }, birthDate: '1991-01-01', birthPlace: 'Skikda', sex: 'F', nationality: 'TN', email: 'apres@example.test', phone: '0770 00 00 01', informedOn: '2026-10-02' });
    expect(errorsOf(await problem('est', 'patch', `/api/recruitment/candidates/${id}`, { nin: '190990000000000999' }, 409, 'recruitment-candidate-duplicate'))).toEqual([['nin', 'duplicate']]);
    expect(errorsOf(await problem('est', 'patch', `/api/recruitment/candidates/${id}`, { email: 'autre@example.test' }, 409, 'recruitment-candidate-duplicate'))).toEqual([['email', 'duplicate']]);
    expect((await ok('est', 'patch', `/api/recruitment/candidates/${id}`, { email: 'autre@example.test', allowDuplicate: true })).email).toBe('autre@example.test');
    // a later edit of something else is not blocked by the accepted duplicate
    expect((await ok('est', 'patch', `/api/recruitment/candidates/${id}`, { birthPlace: 'Jijel', phone: null })).phone).toBeNull();
    expect((await ok('est', 'patch', `/api/recruitment/candidates/${b.candidate.id}`, { nin: null })).nin).toBeNull();
    expect((await call('est', 'patch', `/api/recruitment/candidates/${id}`, { lastName: '' })).status).toBe(422);
    // scope
    expect((await call('est', 'patch', `/api/recruitment/candidates/${demoCandidate(13)}`, { birthPlace: 'Oran' })).status).toBe(404);
    expect((await call('beta', 'patch', `/api/recruitment/candidates/${id}`, { birthPlace: 'Sétif' })).status).toBe(404);
    expect((await call('ouest', 'patch', `/api/recruitment/candidates/${id}`, { birthPlace: 'Oran' })).status).toBe(403);
  });

  it('scope: regional HR its region only (404 outside), a candidate’s views list the visible applications only; lecture and admin_acces nothing', async () => {
    // demo candidate 11 has two applications, both in the Ouest region
    for (const url of [`/api/recruitment/candidates/${demoCandidate(11)}`, `/api/recruitment/applications/${demoApplication(15)}`, `/api/recruitment/openings/${DEMO_OPENINGS.oran}/board`, `/api/recruitment/candidates/${REC_FX.candidate.other}`]) {
      expect((await call('est', 'get', url)).status, url).toBe(404);
    }
    const two = await ok('admin', 'get', `/api/recruitment/candidates/${demoCandidate(11)}`);
    expect(two.applications.map((a: Body) => a.opening.reference).toSorted()).toEqual(['REC-2026-0004', 'REC-2026-0006']);
    expect(two.applications.find((a: Body) => a.opening.reference === 'REC-2026-0004')).toMatchObject({ stage: 'rejected', rejectionReason: { code: 'opening_closed' } });
    // central HR adds that candidate to an Est opening: rh.est now sees the candidate, with the Est application only
    const estOpening = await openOpening(CNE);
    const added = await ok('admin', 'post', `/api/recruitment/openings/${estOpening}/applications`, { candidateId: demoCandidate(11), source: 'internal' }, 201);
    const asEst = await ok('est', 'get', `/api/recruitment/candidates/${demoCandidate(11)}`);
    expect(asEst.applications.map((a: Body) => a.id)).toEqual([added.id]);
    expect(JSON.stringify(asEst)).not.toMatch(/REC-2026-0004|REC-2026-0006/);
    expect((await ok('est', 'get', `/api/recruitment/applications/${added.id}`)).candidate.applications).toHaveLength(1);
    expect((await call('est', 'get', `/api/recruitment/applications/${demoApplication(15)}`)).status).toBe(404);
    // erasing needs recruitment.erase over ALL the applications' units; rh.est has none anyway
    expect(asEst['_actions']).toEqual(['update', 'upload', 'link_person']);

    for (const actor of ['ouest', 'acces', 'agent', 'chef'] as const) {
      for (const url of ['/api/recruitment/candidates', `/api/recruitment/candidates/${demoCandidate(1)}`, `/api/recruitment/applications/${demoApplication(1)}`, `/api/recruitment/openings/${DEMO_OPENINGS.annaba}/board`, '/api/recruitment/policy', '/api/recruitment/rejection-reasons']) {
        expect((await call(actor, 'get', url)).status, `${actor} ${url}`).toBe(403);
      }
    }
    for (const url of [`/api/recruitment/candidates/${demoCandidate(1)}`, `/api/recruitment/applications/${demoApplication(1)}`, `/api/recruitment/openings/${DEMO_OPENINGS.annaba}/board`]) {
      expect((await call('beta', 'get', url)).status).toBe(404);
      expect((await call(null, 'get', url)).status).toBe(401);
    }
  });

  it('known person: shown only to a caller who can read the latest employment; HR confirms the link', async () => {
    // demo candidate 4 is linked to the person of EMP-0025 (Agence Constantine, resigned, not rehired)
    const former = demoEmployee(25);
    const linked = await ok('est', 'get', `/api/recruitment/candidates/${demoCandidate(4)}`);
    expect(linked.knownPerson).toMatchObject({
      personId: former.personId, linked: true, hasOpenEmployment: false, person: { lastName: former.lastName, firstName: former.firstName },
      latestEmployment: { id: former.employmentId, matricule: 'EMP-0025', endDate: '2026-06-30', unit: { code: 'AG-CNE' } },
    });
    // a candidate whose NIN is that of a retired employee of Agence Tlemcen (EMP-0040), on an Est opening
    const retired = demoEmployee(40);
    const opening = await openOpening(CNE);
    const view = await apply(opening, { lastName: 'Retraité', firstName: 'Ancien', nin: retired.nin }, 'admin');
    expect(view.candidate.knownPerson).toMatchObject({ personId: retired.personId, linked: false, hasOpenEmployment: false, latestEmployment: { matricule: 'EMP-0040', unit: { code: 'AG-TLEMCEN' } } });
    // rh.est cannot read that employment: no known person, on the page, on the match and on the board
    expect((await ok('est', 'get', `/api/recruitment/candidates/${view.candidate.id}`)).knownPerson).toBeNull();
    expect((await ok('est', 'post', '/api/recruitment/candidates/match', { nin: retired.nin })).person).toBeNull();
    expect((await ok('admin', 'post', '/api/recruitment/candidates/match', { nin: retired.nin })).person).toMatchObject({ personId: retired.personId, linked: false });
    const card = (board: Body) => board.columns.flatMap((c: Body) => c.cards).find((c: Body) => c.id === view.id);
    expect(card(await ok('est', 'get', `/api/recruitment/openings/${opening}/board`)).formerEmployee).toBe(false);
    expect(card(await ok('admin', 'get', `/api/recruitment/openings/${opening}/board`)).formerEmployee).toBe(true);
    // the link: invisible person → 422 not_found; visible → linked; null unlinks; a person still employed is shown as such
    const link = `/api/recruitment/candidates/${view.candidate.id}/person`;
    expect(errorsOf(await problem('est', 'put', link, { personId: retired.personId }, 422, 'validation-error'))).toEqual([['personId', 'not_found']]);
    expect(errorsOf(await problem('admin', 'put', link, { personId: '0190a5d0-0000-7000-8000-00000000dead' }, 422, 'validation-error'))).toEqual([['personId', 'not_found']]);
    expect((await ok('admin', 'put', link, { personId: retired.personId })).knownPerson).toMatchObject({ linked: true });
    expect((await ok('admin', 'put', link, { personId: demoEmployee(27).personId })).knownPerson).toMatchObject({ linked: true, hasOpenEmployment: true, latestEmployment: { matricule: 'EMP-0027', endDate: null } });
    expect((await ok('admin', 'put', link, { personId: null })).knownPerson).toMatchObject({ linked: false, personId: retired.personId });
    expect((await call('est', 'put', `/api/recruitment/candidates/${demoCandidate(13)}/person`, { personId: null })).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('stage moves, notes, the board and the list', () => {
  it('moves between received / shortlisted / interview in any direction; reject needs an active, non-automatic reason; reopen lands in the previous stage', async () => {
    const opening = await openOpening(CNE);
    const a = await apply(opening, {}, 'est');
    const url = `/api/recruitment/applications/${a.id}`;
    const m = async (body: object) => ok('est', 'post', `${url}/move`, body);
    expect(await m({ toStage: 'interview', expectedStage: 'received', comment: 'Profil solide' })).toMatchObject({ stage: 'interview', moveTargets: ['received', 'shortlisted', 'rejected', 'withdrawn'] });
    expect((await m({ toStage: 'shortlisted', expectedStage: 'interview' })).stage).toBe('shortlisted');
    // static refusals
    expect(errorsOf(await problem('est', 'post', `${url}/move`, { toStage: 'shortlisted', expectedStage: 'shortlisted' }, 422, 'validation-error'))).toEqual([['toStage', 'same']]);
    for (const toStage of ['offer', 'hired']) expect(errorsOf(await problem('est', 'post', `${url}/move`, { toStage, expectedStage: 'shortlisted' }, 422, 'validation-error'))).toEqual([['toStage', 'not_allowed']]);
    expect(errorsOf(await problem('est', 'post', `${url}/move`, { toStage: 'received', expectedStage: 'hired' }, 422, 'validation-error'))).toEqual([['toStage', 'not_allowed']]);
    expect(errorsOf(await problem('est', 'post', `${url}/move`, { toStage: 'nope', expectedStage: 'shortlisted' }, 422, 'validation-error'))).toEqual([['toStage', 'invalid_value']]);
    expect(errorsOf(await problem('est', 'post', `${url}/move`, { toStage: 'interview' }, 422, 'validation-error'))).toEqual([['expectedStage', 'invalid_value']]);
    // a stale view
    await problem('est', 'post', `${url}/move`, { toStage: 'interview', expectedStage: 'received' }, 409, 'recruitment-stage-changed');
    // rejection: reason required, known, active, not automatic; a reason only with a rejection
    const reject = { toStage: 'rejected', expectedStage: 'shortlisted' };
    expect(errorsOf(await problem('est', 'post', `${url}/move`, reject, 422, 'validation-error'))).toEqual([['rejectionReasonId', 'required']]);
    expect(errorsOf(await problem('est', 'post', `${url}/move`, { ...reject, rejectionReasonId: '0190a5d0-0000-7000-8000-00000000dead' }, 422, 'validation-error'))).toEqual([['rejectionReasonId', 'not_found']]);
    expect(errorsOf(await problem('est', 'post', `${url}/move`, { ...reject, rejectionReasonId: await reasonId('opening_closed') }, 422, 'validation-error'))).toEqual([['rejectionReasonId', 'not_found']]);
    expect(errorsOf(await problem('est', 'post', `${url}/move`, { ...reject, rejectionReasonId: await reasonId('experience', COMPANY_B) }, 422, 'validation-error'))).toEqual([['rejectionReasonId', 'not_found']]);
    await ok('admin', 'put', `/api/recruitment/rejection-reasons/${await reasonId('no_show')}`, { active: false });
    expect(errorsOf(await problem('est', 'post', `${url}/move`, { ...reject, rejectionReasonId: await reasonId('no_show') }, 422, 'validation-error'))).toEqual([['rejectionReasonId', 'inactive']]);
    await ok('admin', 'put', `/api/recruitment/rejection-reasons/${await reasonId('no_show')}`, { active: true });
    expect(errorsOf(await problem('est', 'post', `${url}/move`, { toStage: 'interview', expectedStage: 'shortlisted', rejectionReasonId: await reasonId('experience') }, 422, 'validation-error'))).toEqual([['rejectionReasonId', 'not_allowed']]);
    const rejected = await m({ ...reject, rejectionReasonId: await reasonId('experience'), comment: 'Trop junior' });
    expect(rejected).toMatchObject({ stage: 'rejected', rejectionReason: { code: 'experience', labels: { fr: 'Expérience insuffisante', ar: 'خبرة غير كافية', en: 'Insufficient experience' } }, moveTargets: [], _actions: ['reopen', 'add_note', 'update'] });
    expect(rejected.decidedAt).not.toBeNull();
    expect(rejected.stages.at(-1)).toMatchObject({ from: 'shortlisted', to: 'rejected', comment: 'Trop junior', rejectionReason: { code: 'experience' } });
    // final: no move; reopen needs the final stage the user sees
    expect(errorsOf(await problem('est', 'post', `${url}/move`, { toStage: 'received', expectedStage: 'rejected' }, 422, 'validation-error'))).toEqual([['toStage', 'not_allowed']]);
    expect(errorsOf(await problem('est', 'post', `${url}/reopen`, { expectedStage: 'interview' }, 422, 'validation-error'))).toEqual([['expectedStage', 'not_final']]);
    await problem('est', 'post', `${url}/reopen`, { expectedStage: 'withdrawn' }, 409, 'recruitment-stage-changed');
    const reopened = await ok('est', 'post', `${url}/reopen`, { expectedStage: 'rejected' });
    expect(reopened).toMatchObject({ stage: 'shortlisted', decidedAt: null, rejectionReason: null });
    expect(reopened.stages.map((s: Body) => [s.from, s.to])).toEqual([[null, 'received'], ['received', 'interview'], ['interview', 'shortlisted'], ['shortlisted', 'rejected'], ['rejected', 'shortlisted']]);
    const withdrawn = await m({ toStage: 'withdrawn', expectedStage: 'shortlisted', comment: 'A trouvé ailleurs' });
    expect(withdrawn).toMatchObject({ stage: 'withdrawn', rejectionReason: null });
    expect((await ok('est', 'post', `${url}/reopen`, { expectedStage: 'withdrawn' })).stage).toBe('shortlisted');
    // scope and guard
    expect((await move('est', demoApplication(13), { toStage: 'interview', expectedStage: 'shortlisted' })).status).toBe(404);
    expect((await move('ouest', a.id, { toStage: 'interview', expectedStage: 'shortlisted' })).status).toBe(403);
    expect((await move('beta', a.id, { toStage: 'interview', expectedStage: 'shortlisted' })).status).toBe(404);
  });

  it('concurrency: two simultaneous moves of one application → one 200 and one 409 recruitment-stage-changed', async () => {
    const opening = await openOpening(CNE);
    for (let round = 0; round < 5; round++) {
      const a = await apply(opening, {}, 'est');
      const [one, two] = await Promise.all([
        move('est', a.id, { toStage: 'shortlisted', expectedStage: 'received' }),
        move('admin', a.id, { toStage: 'interview', expectedStage: 'received' }),
      ]);
      expect([one.status, two.status].toSorted(), `round ${round}`).toEqual([200, 409]);
      const loser = one.status === 409 ? one : two;
      const winner = one.status === 200 ? one : two;
      expect((loser.body as Body).type).toBe(PROBLEM('recruitment-stage-changed'));
      const after = await ok('admin', 'get', `/api/recruitment/applications/${a.id}`);
      expect(after.stage).toBe((winner.body as Body).stage);
      expect(after.stages).toHaveLength(2);
    }
  });

  it('notes: added by HR, newest first, deleted by their author or a holder of recruitment.erase', async () => {
    const opening = await openOpening(CNE);
    const a = await apply(opening, {}, 'est');
    const url = `/api/recruitment/applications/${a.id}/notes`;
    const mine = await ok('est', 'post', url, { body: '  Très bon contact au téléphone.  ' }, 201);
    expect(mine).toMatchObject({ body: 'Très bon contact au téléphone.', createdBy: { id: USERS.est.id, displayName: USERS.est.displayName }, _actions: ['delete'] });
    const theirs = await ok('admin', 'post', url, { body: 'Référence vérifiée.' }, 201);
    expect(errorsOf(await problem('est', 'post', url, { body: ' ' }, 422, 'validation-error'))).toEqual([['body', 'too_small']]);
    const asEst = await ok('est', 'get', `/api/recruitment/applications/${a.id}`);
    expect(asEst.notes.map((n: Body) => [n.id, n['_actions']])).toEqual([[theirs.id, []], [mine.id, ['delete']]]);
    expect((await ok('admin', 'get', `/api/recruitment/applications/${a.id}`)).notes.map((n: Body) => n['_actions'])).toEqual([['delete'], ['delete']]);
    // rh.est may not delete admin's note; a note of another application is 404; admin (recruitment.erase) deletes any
    await problem('est', 'delete', `${url}/${theirs.id}`, undefined, 403, 'forbidden');
    expect((await call('est', 'delete', `/api/recruitment/applications/${demoApplication(1)}/notes/${mine.id}`)).status).toBe(404);
    expect((await call('est', 'delete', `${url}/${mine.id}`)).status).toBe(204);
    expect((await call('admin', 'delete', `${url}/${theirs.id}`)).status).toBe(204);
    expect((await call('admin', 'delete', `${url}/${theirs.id}`)).status).toBe(404);
    expect((await ok('est', 'get', `/api/recruitment/applications/${a.id}`)).notes).toEqual([]);
    expect((await call('ouest', 'post', url, { body: 'x' })).status).toBe(403);
    expect((await call('est', 'post', `/api/recruitment/applications/${demoApplication(13)}/notes`, { body: 'x' })).status).toBe(404);
    // database: a note is immutable
    const kept = await ok('est', 'post', url, { body: 'Immuable' }, 201);
    await expect(asRole(db.appUrl, COMPANY_A, `update recruitment_note set body = 'x' where id = '${kept.id}'`)).rejects.toThrow(/permission denied/);
  });

  it('the board: the seven stages in order, counts of every stage, cards of the active ones (final on request), purged applications counted', async () => {
    const board = await ok('est', 'get', `/api/recruitment/openings/${DEMO_OPENINGS.annaba}/board`);
    expect(board.columns.map((c: Body) => c.stage)).toEqual(['received', 'shortlisted', 'interview', 'offer', 'hired', 'rejected', 'withdrawn']);
    expect(board.opening).toMatchObject({ reference: 'REC-2026-0001', _actions: ['update', 'close', 'add_application'] });
    const column = (b: Body, stage: string) => b.columns.find((c: Body) => c.stage === stage);
    expect(column(board, 'rejected')).toMatchObject({ count: 1, cards: [] });
    expect(column(board, 'withdrawn')).toMatchObject({ count: 1, cards: [] });
    const interview = column(board, 'interview').cards as Body[];
    expect(interview.map((c) => c.id)).toEqual([demoApplication(4), demoApplication(5)]); // oldest stageSince first
    expect(interview[0]).toMatchObject({ stage: 'interview', source: 'internal', hasCv: true, notes: 1, formerEmployee: true, rejectionReason: null, moveTargets: ['received', 'shortlisted', 'rejected', 'withdrawn'], _actions: ['move'] });
    expect(interview[1]).toMatchObject({ formerEmployee: false, notes: 1 });
    expect(Object.keys(interview[0]).toSorted()).toEqual(['_actions', 'candidate', 'formerEmployee', 'hasCv', 'id', 'moveTargets', 'notes', 'rejectionReason', 'source', 'stage', 'stageSince']);
    expect(Object.keys(interview[0].candidate).toSorted()).toEqual(['firstName', 'firstNameAr', 'id', 'lastName', 'lastNameAr']);
    const full = await ok('est', 'get', `/api/recruitment/openings/${DEMO_OPENINGS.annaba}/board?includeFinal=true`);
    expect(column(full, 'rejected').cards[0]).toMatchObject({ id: demoApplication(6), rejectionReason: { code: 'experience' }, moveTargets: [], _actions: ['reopen'] });
    expect(column(full, 'withdrawn').cards.map((c: Body) => c['_actions'])).toEqual([['reopen']]);
    // a filled opening: nothing to do on its cards
    const filled = await ok('est', 'get', `/api/recruitment/openings/${DEMO_OPENINGS.cne}/board?includeFinal=true`);
    expect(filled.columns.flatMap((c: Body) => c.cards).every((c: Body) => c['_actions'].length === 0 && c.moveTargets.length === 0)).toBe(true);
    expect(column(filled, 'hired').cards).toHaveLength(1);
    // the opening closed 14 months ago: three anonymous applications, in the counts, no card
    const old = await ok('admin', 'get', `/api/recruitment/openings/${DEMO_OPENINGS.tlemcen}/board?includeFinal=true`);
    expect(old).toMatchObject({ purged: 3, opening: { counts: { rejected: 2, withdrawn: 1, total: 3 } } });
    expect(old.columns.flatMap((c: Body) => c.cards)).toEqual([]);
    expect(column(old, 'rejected').count).toBe(2);
    // more than 1 000 unpurged applications → 422 too_many
    const big = await openOpening(CNE, 1);
    await query(db.superuserUrl, `with c as (insert into recruitment_candidate (company_id, last_name, first_name) select $1, 'Masse', 'N' || g from generate_series(1, 1001) g returning id)
      insert into recruitment_application (company_id, opening_id, candidate_id, source) select $1, $2, id, 'other' from c`, [COMPANY_A, big]);
    expect(errorsOf(await problem('admin', 'get', `/api/recruitment/openings/${big}/board`, undefined, 422, 'validation-error'))).toEqual([['id', 'too_many']]);
    await query(db.superuserUrl, `update recruitment_opening set status = 'closed', closed_at = now(), closed_by = $2, close_reason = 'Masse' where id = $1`, [big, USERS.admin.id]);
  });

  it('GET /recruitment/candidates: one item per visible application; search, stage, state, opening, unit, idle, sort', async () => {
    const list = async (actor: ActorName, qs: string) => ok(actor, 'get', `/api/recruitment/candidates?pageSize=100&${qs}`);
    const annaba = await list('est', `openingId=${DEMO_OPENINGS.annaba}&state=all`);
    expect(annaba.items.filter((i: Body) => [1, 2, 3, 4, 5, 6, 7].map(demoApplication).includes(i.id))).toHaveLength(7);
    expect(annaba.items.find((i: Body) => i.id === demoApplication(6))).toMatchObject({ stage: 'rejected', hasCv: true, rejectionReason: { code: 'experience' }, opening: { reference: 'REC-2026-0001' }, candidate: { id: demoCandidate(6), lastName: 'Ghezali' } });
    expect((await list('est', `openingId=${DEMO_OPENINGS.annaba}`)).items.every((i: Body) => ['received', 'shortlisted', 'interview', 'offer'].includes(i.stage))).toBe(true);
    expect((await list('est', `openingId=${DEMO_OPENINGS.annaba}&state=final`)).items.map((i: Body) => i.stage).toSorted()).toEqual(['rejected', 'withdrawn']);
    expect((await list('est', `openingId=${DEMO_OPENINGS.annaba}&state=all&stage=interview`)).items.map((i: Body) => i.id).toSorted()).toEqual([demoApplication(4), demoApplication(5)].toSorted());
    // rh.est: Est only — the Ouest candidates never show, whatever the filter
    const est = await list('est', 'state=all');
    const all = await list('admin', 'state=all');
    expect(est.items.every((i: Body) => ['AG-CNE', 'AG-ANNABA', 'SRV-CLI-ANB', 'REG-EST', 'SRV-ADM-EST'].includes(i.opening.unit.code))).toBe(true);
    expect(all.total).toBeGreaterThan(est.total);
    expect((await list('est', 'state=all&q=zerrouki')).items).toEqual([]);
    expect((await list('admin', 'state=all&q=zerrouki')).items.map((i: Body) => i.candidate.id)).toEqual([demoCandidate(13)]);
    expect((await list('est', `state=all&unitId=${ORAN}`)).items).toEqual([]);
    // search: Latin and Arabic names, e-mail, phone digits, NIN
    for (const q of ['GHEZALI ima', 'غزالي', 'imane.ghezali@', '0550 00 00 06', '+213550000006', '299999000000000006']) {
      expect((await list('est', `state=all&q=${encodeURIComponent(q)}`)).items.map((i: Body) => i.candidate.id), q).toEqual([demoCandidate(6)]);
    }
    // sort: by name (fr default, Arabic collation with lang=ar), by time in stage
    const names = (await list('est', `openingId=${DEMO_OPENINGS.annaba}&state=all&sort=name`)).items.map((i: Body) => i.candidate.lastName.toLowerCase());
    expect(names).toEqual(names.toSorted());
    const arabic = (await list('est', `openingId=${DEMO_OPENINGS.annaba}&state=all&sort=name&lang=ar&dir=desc`)).items.map((i: Body) => i.candidate.lastNameAr ?? i.candidate.lastName);
    expect(arabic).toEqual(arabic.toSorted((a: string, b: string) => b.localeCompare(a, 'ar')));
    const since = (await list('est', `openingId=${DEMO_OPENINGS.annaba}&state=all&sort=stageSince`)).items.map((i: Body) => i.stageSince);
    expect(since).toEqual(since.toSorted().toReversed());
    // « sans mouvement depuis 6 mois »: active applications whose stage has not moved
    const stale = await apply(await openOpening(CNE), { lastName: 'Immobile', firstName: 'Longtemps' }, 'est');
    await query(db.superuserUrl, `update recruitment_application set stage_since = now() - interval '7 months' where id = $1`, [stale.id]);
    expect((await list('est', 'idleMonths=6')).items.map((i: Body) => i.id)).toEqual([stale.id]);
    expect((await call('est', 'get', '/api/recruitment/candidates?idleMonths=0')).status).toBe(422);
    const paged = await ok('est', 'get', '/api/recruitment/candidates?state=all&pageSize=2&page=2');
    expect(paged).toMatchObject({ page: 2, pageSize: 2 });
    expect(paged.items).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('candidate files', () => {
  let opening = '';
  let candidate = '';
  let application = '';

  beforeAll(async () => {
    opening = await openOpening(CNE);
    const view = await apply(opening, { lastName: 'Pièces', firstName: 'Jointes' }, 'est');
    candidate = view.candidate.id;
    application = view.id;
  });

  it('upload: type by content only, the size limit, one file, the kind — exactly the employee file’s rules', async () => {
    const code = (res: Response) => (res.body as Body).errors?.[0]?.code;
    const fakePdf = Buffer.from('%PDF-1.7\n<script>alert(1)</script>\n', 'latin1');
    expect(code(await upload('est', candidate, fakePdf).expect(422))).toBe('unsupported_type');
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect/></svg>');
    expect(code(await upload('est', candidate, svg, {}, 'photo.png').expect(422))).toBe('unsupported_type');
    expect(code(await upload('est', candidate, Buffer.from('MZ\x90\x00 not an image'), {}, 'cv.docx').expect(422))).toBe('unsupported_type');
    expect(code(await upload('est', candidate, Buffer.alloc(0)).expect(422))).toBe('empty');
    expect(code(await upload('est', candidate, null).expect(422))).toBe('required');
    const two = await upload('est', candidate, null).attach('file', demoPdf('a'), 'a.pdf').attach('file', demoPdf('b'), 'b.pdf').expect(422);
    expect(code(two)).toBe('one_file_only');
    expect(((await upload('est', candidate, demoPdf('kind'), { kind: 'passport' }).expect(422)).body as Body).errors.map((e: Body) => e.field)).toEqual(['kind']);
    expect(((await upload('est', candidate, demoPdf('title'), { title: ' ' }).expect(422)).body as Body).errors.map((e: Body) => e.field)).toEqual(['title']);
    // the limit is EMPLOYEE_FILE_MAX_BYTES (10 MB): one byte more is a 422 too_large, never a 413 or a 500
    const MAX = 10 * 1024 * 1024;
    const head = Buffer.from('%PDF-1.4\n%', 'latin1');
    const tail = Buffer.from('\n%%EOF\n', 'latin1');
    const over = await upload('est', candidate, Buffer.concat([head, Buffer.alloc(MAX + 1 - head.length - tail.length, 0x42), tail]), {}, 'too-big.pdf');
    expect([over.status, (over.body as Body).errors]).toMatchObject([422, [{ field: 'file', code: 'too_large' }]]);

    const res = await upload('est', candidate, demoPdf('TEST DATA - CV pieces'), { kind: 'cv', title: '  CV 2026 ' }, 'CV Pièces.pdf').expect(201);
    assertNoSecrets(res.body);
    expect(res.body).toMatchObject({ kind: 'cv', title: 'CV 2026', originalFilename: 'CV Pièces.pdf', mime: 'application/pdf', uploadedBy: { id: USERS.est.id }, _actions: ['delete'] });
    expect(Object.keys(res.body as object).toSorted()).toEqual(['_actions', 'id', 'kind', 'mime', 'originalFilename', 'sizeBytes', 'title', 'uploadedAt', 'uploadedBy']);
    // a PNG sent as .pdf is a PNG; the same bytes twice → 409 on `file`
    expect(((await upload('est', candidate, demoLogoPng(), { kind: 'diploma', title: 'Diplôme' }, 'diplome.pdf').expect(201)).body as Body).mime).toBe('image/png');
    const dup = await upload('est', candidate, demoPdf('TEST DATA - CV pieces'), { kind: 'other', title: 'Encore' }).expect(409);
    expect([(dup.body as Body).type, (dup.body as Body).errors.map((e: Body) => [e.field, e.code])]).toEqual([PROBLEM('recruitment-file-duplicate'), [['file', 'duplicate']]]);
    // the upload runs in its own transaction with the caller as the audit actor; the event names the kind, nothing else
    const [event] = await query<{ actor_user_id: string; data: Body; subject_id: string }>(db.superuserUrl, `select actor_user_id, data, subject_id from audit.event where type = 'recruitment.file_added' and request_id = $1`, [res.headers['x-request-id']]);
    expect(event).toEqual({ actor_user_id: USERS.est.id, data: { kind: 'cv' }, subject_id: candidate });
    // scope: lecture 403, another region / company 404
    expect((await upload('ouest', candidate, demoPdf('x'))).status).toBe(403);
    expect((await upload('est', demoCandidate(13), demoPdf('x'))).status).toBe(404);
    expect((await upload('beta', candidate, demoPdf('x'))).status).toBe(404);
    const view = await ok('est', 'get', `/api/recruitment/candidates/${candidate}`);
    expect(view.files.map((f: Body) => f.kind)).toEqual(['diploma', 'cv']); // newest first
  });

  it('at most 20 files per candidate', async () => {
    const view = await apply(opening, { lastName: 'Limite', firstName: 'Vingt' }, 'est');
    for (let k = 0; k < 20; k++) await upload('est', view.candidate.id, demoPdf(`limite ${k}`), { kind: 'other', title: `Pièce ${k}` }).expect(201);
    const res = await upload('est', view.candidate.id, demoPdf('limite 21'), { kind: 'other', title: 'De trop' });
    expect([res.status, (res.body as Body).type]).toEqual([409, PROBLEM('recruitment-file-limit')]);
  });

  it('download: an attachment under the sniffed type with nosniff, a sandbox CSP and no caching; audited without the name', async () => {
    const polyglot = Buffer.from(`%PDF-1.4\n<html><script>alert(document.cookie)</script></html>\n%%EOF\n`, 'latin1');
    const file = (await upload('est', candidate, polyglot, { kind: 'other', title: 'Page' }, 'page.html').expect(201)).body as Body;
    const res = await download('est', `/api/recruitment/candidates/${candidate}/files/${file.id}/content`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="page.html.pdf"; filename*=UTF-8''page.html.pdf`);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe("sandbox; default-src 'none'");
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(Buffer.compare(res.body as Buffer, polyglot)).toBe(0);
    // an RTL name with quotes, CR/LF and a bidi override: stored clean, header safe
    const tricky = (await upload('est', candidate, demoPdf('tricky'), { kind: 'other', title: 'Nom' }, 'سيرة "ذاتية"\r\nX-Injected: 1\u202Egnp.pdf').expect(201)).body as Body;
    expect(tricky.originalFilename).toBe('سيرة "ذاتية"X-Injected: 1gnp.pdf');
    const header = String((await download('est', `/api/recruitment/candidates/${candidate}/files/${tricky.id}/content`)).headers['content-disposition']);
    expect(header).not.toMatch(/[\r\n]/);
    expect(decodeURIComponent(header.split("UTF-8''")[1] ?? '')).toBe('سيرة "ذاتية"X-Injected: 1gnp.pdf');

    const events = await query<{ actor_user_id: string; subject_type: string; subject_id: string; data: Body }>(db.superuserUrl, `select actor_user_id, subject_type, subject_id, data from audit.event where type = 'recruitment.file_downloaded' and subject_id = $1 order by id`, [candidate]);
    expect(events).toEqual([
      { actor_user_id: USERS.est.id, subject_type: 'recruitment_candidate', subject_id: candidate, data: { kind: 'other', via: 'hr' } },
      { actor_user_id: USERS.est.id, subject_type: 'recruitment_candidate', subject_id: candidate, data: { kind: 'other', via: 'hr' } },
    ]);
    // scope: the file of another candidate, another region, lecture, anonymous
    expect((await download('est', `/api/recruitment/candidates/${demoCandidate(1)}/files/${file.id}/content`)).status).toBe(404);
    expect((await download('est', `/api/recruitment/candidates/${demoCandidate(13)}/files/${demoCandidateFile(13)}/content`)).status).toBe(404);
    expect((await download('ouest', `/api/recruitment/candidates/${candidate}/files/${file.id}/content`)).status).toBe(403);
    expect((await call(null, 'get', `/api/recruitment/candidates/${candidate}/files/${file.id}/content`)).status).toBe(401);
  });

  it('delete is a hard delete: the row and its bytes are gone, nothing is left behind', async () => {
    const file = (await upload('est', candidate, demoPdf('TEST DATA - a supprimer'), { kind: 'id_document', title: 'Carte' }, 'cni-secret.pdf').expect(201)).body as Body;
    expect((await call('ouest', 'delete', `/api/recruitment/candidates/${candidate}/files/${file.id}`)).status).toBe(403);
    expect((await call('est', 'delete', `/api/recruitment/candidates/${demoCandidate(1)}/files/${file.id}`)).status).toBe(404);
    expect((await call('est', 'delete', `/api/recruitment/candidates/${candidate}/files/${file.id}`)).status).toBe(204);
    expect(await query(db.superuserUrl, 'select 1 from recruitment_candidate_file where id = $1', [file.id])).toEqual([]);
    expect(await query(db.superuserUrl, 'select 1 from recruitment_candidate_file_content where file_id = $1', [file.id])).toEqual([]);
    expect((await call('est', 'delete', `/api/recruitment/candidates/${candidate}/files/${file.id}`)).status).toBe(404);
    expect((await download('est', `/api/recruitment/candidates/${candidate}/files/${file.id}/content`)).status).toBe(404);
    expect(await searchDatabase(['cni-secret'])).toEqual([]);
    const types = (await query<{ type: string; data: Body }>(db.superuserUrl, `select type, data from audit.event where subject_id = $1 and type in ('recruitment.file_added', 'recruitment.file_deleted') and data ->> 'kind' = 'id_document' order by id`, [candidate]));
    expect(types).toEqual([{ type: 'recruitment.file_added', data: { kind: 'id_document' } }, { type: 'recruitment.file_deleted', data: { kind: 'id_document' } }]);
    // database: metadata and bytes are never rewritten by the app
    await expect(asRole(db.appUrl, COMPANY_A, `update recruitment_candidate_file set title = 'x'`)).rejects.toThrow(/permission denied/);
    await expect(asRole(db.appUrl, COMPANY_A, `update recruitment_candidate_file_content set content = '\\x00'`)).rejects.toThrow(/permission denied/);
    expect(application).not.toBe('');
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('the heads’ restricted view and the home counts', () => {
  it('a head sees the applications of his openings: names, stage and files — never NIN, birth, contact, salary or notes', async () => {
    const list = (await ok('chef', 'get', '/api/me/recruitment/openings')).items as Body[];
    expect(list.length).toBeGreaterThanOrEqual(3);
    expect(list.every((o) => ['AG-ANNABA', 'SRV-CLI-ANB'].includes(o.unit.code))).toBe(true);
    const mine = list.find((o) => o.id === DEMO_OPENINGS.annaba);
    expect(mine).toMatchObject({ reference: 'REC-2026-0001', roles: ['requester', 'head'], _actions: [] });
    expect(mine.counts.total).toBeGreaterThanOrEqual(7);
    expect(list.find((o) => o.id === DEMO_OPENINGS.accueil)).toMatchObject({ status: 'pending', _actions: ['cancel'] });
    expect(list.map((o) => o.requestedAt)).toEqual(list.map((o) => o.requestedAt).toSorted().toReversed());

    const detail = await ok('chef', 'get', `/api/me/recruitment/openings/${DEMO_OPENINGS.annaba}`);
    const applications = detail.applications as Body[];
    const four = applications.find((a) => a.id === demoApplication(4));
    expect(four).toEqual({
      id: demoApplication(4),
      candidate: { lastName: demoEmployee(25).lastName, firstName: demoEmployee(25).firstName, lastNameAr: demoEmployee(25).lastNameAr, firstNameAr: demoEmployee(25).firstNameAr },
      stage: 'interview',
      stageSince: expect.any(String),
      files: [expect.objectContaining({ id: demoCandidateFile(4), kind: 'cv', _actions: [] })],
    });
    // asserted BY KEY over the whole answer: nothing of the HR view leaks
    const keys = keysOf(detail);
    for (const forbidden of ['nin', 'birthDate', 'birthPlace', 'email', 'phone', 'sex', 'nationality', 'salary', 'expected', 'notes', 'note', 'informedOn', 'knownPerson', 'stages', 'rejectionReason', 'source', 'moveTargets']) {
      expect(keys.has(forbidden), forbidden).toBe(false);
    }
    const text = JSON.stringify(detail);
    for (const value of [demoEmployee(25).nin, 'example.test', '0550 00', '68000', 'Bon dossier', 'Première expérience']) expect(text, value).not.toContain(value);
    // a final stage: listed, without files
    expect(applications.find((a) => a.id === demoApplication(6))).toMatchObject({ stage: 'rejected', files: [] });

    // the head above (rh.est heads Région Est) has the head role too; nobody else reaches it
    expect(await ok('est', 'get', `/api/me/recruitment/openings/${DEMO_OPENINGS.annaba}`)).toMatchObject({ roles: ['head'], _actions: [] });
    for (const actor of ['admin', 'agent', 'ouest', 'acces', 'beta'] as const) expect((await call(actor, 'get', `/api/me/recruitment/openings/${DEMO_OPENINGS.annaba}`)).status, actor).toBe(404);
    // the HR routes stay closed to a head
    expect((await call('chef', 'get', `/api/recruitment/applications/${demoApplication(4)}`)).status).toBe(403);
    expect((await call('chef', 'get', `/api/recruitment/candidates/${demoCandidate(4)}`)).status).toBe(403);
  });

  it('a head downloads the files while the application is in progress — and loses them once the stage is final', async () => {
    const opening = await ok('chef', 'post', '/api/recruitment/openings', openingBody(ANNABA), 201);
    await ok('est', 'post', `/api/tasks/${await openTaskId(opening.id)}/approve`, {});
    await ok('admin', 'post', `/api/tasks/${await openTaskId(opening.id)}/approve`, {});
    const a = await apply(opening.id, { lastName: 'Visible', firstName: 'Chef' }, 'est');
    const file = (await upload('est', a.candidate.id, demoPdf('TEST DATA - CV chef'), { kind: 'cv', title: 'CV' }).expect(201)).body as Body;
    const url = `/api/me/recruitment/applications/${a.id}/files/${file.id}/content`;
    const res = await download('chef', url);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/^attachment; /);
    expect(res.headers['content-security-policy']).toBe("sandbox; default-src 'none'");
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(Buffer.compare(res.body as Buffer, demoPdf('TEST DATA - CV chef'))).toBe(0);
    expect((await download('est', url)).status).toBe(200); // the head above
    const events = await query<{ actor_user_id: string; data: Body }>(db.superuserUrl, `select actor_user_id, data from audit.event where type = 'recruitment.file_downloaded' and subject_id = $1 order by id`, [a.candidate.id]);
    expect(events).toEqual([{ actor_user_id: USERS.chef.id, data: { kind: 'cv', via: 'head' } }, { actor_user_id: USERS.est.id, data: { kind: 'cv', via: 'head' } }]);
    // not a head of that unit, a file of another candidate, an application of another opening
    for (const actor of ['agent', 'admin', 'ouest', 'beta'] as const) expect((await download(actor, url)).status, actor).toBe(404);
    expect((await download('chef', `/api/me/recruitment/applications/${a.id}/files/${demoCandidateFile(1)}/content`)).status).toBe(404);
    expect((await download('chef', `/api/me/recruitment/applications/${REC_FX.application.est}/files/${REC_FX.file.est}/content`)).status).toBe(404);
    // once the stage is final the head loses the files
    await ok('est', 'post', `/api/recruitment/applications/${a.id}/move`, { toStage: 'withdrawn', expectedStage: 'received' });
    expect((await download('chef', url)).status).toBe(404);
    const after = await ok('chef', 'get', `/api/me/recruitment/openings/${opening.id}`);
    expect(after.applications).toEqual([{ id: a.id, candidate: { lastName: 'Visible', firstName: 'Chef', lastNameAr: null, firstNameAr: null }, stage: 'withdrawn', stageSince: expect.any(String), files: [] }]);
  });

  it('GET /me/recruitment/summary: never 404; who may request, how many openings, how many pending', async () => {
    const chef = await ok('chef', 'get', '/api/me/recruitment/summary');
    expect(chef.canRequestOpening).toBe(true);
    expect(chef.openings).toBeGreaterThanOrEqual(3);
    expect(chef.pendingOpenings).toBeGreaterThanOrEqual(1);
    expect(await ok('agent', 'get', '/api/me/recruitment/summary')).toEqual({ canRequestOpening: false, openings: 0, pendingOpenings: 0 });
    expect(await ok('ouest', 'get', '/api/me/recruitment/summary')).toEqual({ canRequestOpening: false, openings: 0, pendingOpenings: 0 });
    expect(await ok('acces', 'get', '/api/me/recruitment/summary')).toMatchObject({ canRequestOpening: false });
    expect(await ok('admin', 'get', '/api/me/recruitment/summary')).toMatchObject({ canRequestOpening: true }); // recruitment.manage
    expect((await ok('est', 'get', '/api/me/recruitment/summary')).canRequestOpening).toBe(true);
    expect((await ok('agent', 'get', '/api/me/recruitment/openings')).items).toEqual([]);
    expect((await call(null, 'get', '/api/me/recruitment/summary')).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('settings', () => {
  it('policy: read with recruitment.read, written with recruitment.configure over the whole company', async () => {
    expect(await ok('est', 'get', '/api/recruitment/policy')).toEqual({ retentionMonths: 12, openingWorkflowCode: 'recruitment.manager_then_hr', company: { nameFr: 'Entreprise Démo HRForce', nameAr: 'مؤسسة هرفورس التجريبية' } });
    expect((await ok('beta', 'get', '/api/recruitment/policy')).company.nameFr).toBe('Beta SARL');
    expect(await ok('admin', 'put', '/api/recruitment/policy', { retentionMonths: 24 })).toMatchObject({ retentionMonths: 24, openingWorkflowCode: 'recruitment.manager_then_hr' });
    for (const retentionMonths of [0, 61, 1.5]) expect(errorsOf(await problem('admin', 'put', '/api/recruitment/policy', { retentionMonths }, 422, 'validation-error')).map(([f]) => f)).toEqual(['retentionMonths']);
    expect((await call('admin', 'put', '/api/recruitment/policy', { openingWorkflowCode: 'leave.hr_only' })).status).toBe(422);
    await ok('admin', 'put', '/api/recruitment/policy', { retentionMonths: 12 });
    for (const actor of ['est', 'ouest', 'acces', 'chef'] as const) expect((await call(actor, 'put', '/api/recruitment/policy', { retentionMonths: 6 })).status, actor).toBe(403);
    // a regional holder of recruitment.configure: the settings are company-wide → 403 forbidden-scope
    const [role] = await query<{ id: string }>(db.superuserUrl, `insert into role (company_id, code, name_fr, name_ar, name_en) values ($1, 'rec_regional_cfg', 'Config', 'إعداد', 'Config') returning id`, [COMPANY_A]);
    await query(db.superuserUrl, `insert into role_permission (company_id, role_id, permission_code) values ($1, $2, 'recruitment.configure'), ($1, $2, 'recruitment.read')`, [COMPANY_A, role?.id]);
    await query(db.superuserUrl, `insert into role_grant (company_id, user_id, role_id, org_unit_id, include_descendants, valid_from) values ($1, $2, $3, $4, true, '2026-01-01')`, [COMPANY_A, USERS.newbie.id, role?.id, unitA('REG-EST')]);
    await problem('newbie', 'put', '/api/recruitment/policy', { retentionMonths: 6 }, 403, 'forbidden-scope');
    await problem('newbie', 'post', '/api/recruitment/rejection-reasons', { code: 'regional', labels: { fr: 'a', ar: 'b', en: 'c' } }, 403, 'forbidden-scope');
    expect((await ok('newbie', 'get', '/api/recruitment/policy')).retentionMonths).toBe(12);
  });

  it('rejection reasons: the seeded list, new ones, labels / order / active — the automatic ones stay active', async () => {
    const list = (await ok('est', 'get', '/api/recruitment/rejection-reasons')).items as Body[];
    expect(list.map((r) => r.code)).toEqual(['profile_mismatch', 'experience', 'qualification', 'salary', 'other_selected', 'no_show', 'incomplete', 'other', 'position_filled', 'opening_closed']);
    expect(list.filter((r) => r.autoOnly).map((r) => [r.code, r.isSystem, r.active, r.labels.fr, r.labels.ar])).toEqual([['position_filled', true, true, 'Poste pourvu', 'تم شغل المنصب'], ['opening_closed', true, true, 'Recrutement clôturé', 'تم إغلاق عملية التوظيف']]);
    const created = await ok('admin', 'post', '/api/recruitment/rejection-reasons', { code: 'mobilite', labels: { fr: 'Mobilité géographique', ar: 'التنقل الجغرافي', en: 'Mobility' } }, 201);
    expect(created).toMatchObject({ code: 'mobilite', active: true, isSystem: false, autoOnly: false, sortOrder: 90 });
    expect(errorsOf(await problem('admin', 'post', '/api/recruitment/rejection-reasons', { code: 'mobilite', labels: { fr: 'a', ar: 'b', en: 'c' } }, 409, 'recruitment-reason-code-taken'))).toEqual([['code', 'taken']]);
    expect((await call('admin', 'post', '/api/recruitment/rejection-reasons', { code: 'Bad Code', labels: { fr: 'a', ar: 'b', en: 'c' } })).status).toBe(422);
    const updated = await ok('admin', 'put', `/api/recruitment/rejection-reasons/${created.id}`, { labels: { fr: 'Mobilité', ar: 'التنقل', en: 'Mobility' }, sortOrder: 5, active: false });
    expect(updated).toMatchObject({ labels: { fr: 'Mobilité' }, sortOrder: 5, active: false });
    expect(((await ok('est', 'get', '/api/recruitment/rejection-reasons')).items as Body[])[0].code).toBe('mobilite');
    const auto = list.find((r) => r.code === 'opening_closed');
    expect(errorsOf(await problem('admin', 'put', `/api/recruitment/rejection-reasons/${auto.id}`, { active: false }, 422, 'validation-error'))).toEqual([['active', 'auto_only']]);
    expect((await ok('admin', 'put', `/api/recruitment/rejection-reasons/${auto.id}`, { labels: { fr: 'Recrutement clôturé', ar: 'تم إغلاق عملية التوظيف', en: 'Recruitment closed' } })).active).toBe(true);
    expect((await call('beta', 'put', `/api/recruitment/rejection-reasons/${created.id}`, { active: true })).status).toBe(404);
    expect((await call('est', 'put', `/api/recruitment/rejection-reasons/${created.id}`, { active: true })).status).toBe(403);
    // every company has its own; the system employee-file category `recruitment` too
    expect(((await ok('beta', 'get', '/api/recruitment/rejection-reasons')).items as Body[]).map((r) => r.code)).not.toContain('mobilite');
    expect(await query(db.superuserUrl, `select company_id, access_class, is_system from employee_file_category where code = 'recruitment' order by company_id`)).toEqual([
      { company_id: COMPANY_A, access_class: 'standard', is_system: true },
      { company_id: COMPANY_B, access_class: 'standard', is_system: true },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('audit: events without personal payload, the timeline', () => {
  const SECRETS = { last: 'Zzyzxqvist', first: 'Quetzalina', nin: '288990000000424242', email: 'zzyzx.audit@example.test', phone: '0799 42 42 42', note: 'Xylophagous', comment: 'Pneumonoultra', salary: '123456.78' };

  it('every write on candidate data is an event naming fields, kinds and stages — never a value; no change row', async () => {
    const opening = await openOpening(CNE);
    const since = (await query<{ id: string }>(db.superuserUrl, 'select coalesce(max(id), 0)::text as id from audit.event'))[0]?.id ?? '0';
    const sinceChange = (await query<{ id: string }>(db.superuserUrl, 'select coalesce(max(id), 0)::text as id from audit.change_log'))[0]?.id ?? '0';
    const a = await apply(opening, { lastName: SECRETS.last, firstName: SECRETS.first, nin: SECRETS.nin, email: SECRETS.email, phone: SECRETS.phone, birthDate: '1988-08-08' }, 'admin', { expectedSalary: SECRETS.salary, comment: SECRETS.comment });
    await ok('admin', 'patch', `/api/recruitment/candidates/${a.candidate.id}`, { birthPlace: 'Timimoun', phone: '0799 42 42 43' });
    await ok('admin', 'patch', `/api/recruitment/applications/${a.id}`, { source: 'referral', expectedSalary: '123457.00' });
    const note = await ok('admin', 'post', `/api/recruitment/applications/${a.id}/notes`, { body: `${SECRETS.note} — très motivée` }, 201);
    await ok('admin', 'post', `/api/recruitment/applications/${a.id}/move`, { toStage: 'rejected', expectedStage: 'received', rejectionReasonId: await reasonId('salary'), comment: SECRETS.comment });
    await call('admin', 'delete', `/api/recruitment/applications/${a.id}/notes/${note.id}`);
    await ok('admin', 'put', `/api/recruitment/candidates/${a.candidate.id}/person`, { personId: demoEmployee(27).personId });

    const events = await query<{ type: string; subject_type: string; subject_id: string; actor_user_id: string; data: Body }>(db.superuserUrl, `select type, subject_type, subject_id, actor_user_id, data from audit.event where id > $1 and type like 'recruitment.%' order by id`, [since]);
    expect(events.map((e) => [e.type, e.subject_type, e.subject_id === a.id ? 'application' : e.subject_id === a.candidate.id ? 'candidate' : '?', e.data])).toEqual([
      ['recruitment.candidate_created', 'recruitment_candidate', 'candidate', {}],
      ['recruitment.application_created', 'recruitment_application', 'application', { openingId: opening, source: 'spontaneous' }],
      ['recruitment.stage_changed', 'recruitment_application', 'application', { from: null, to: 'received', reasonCode: null, autoCause: null }],
      ['recruitment.salary_changed', 'recruitment_application', 'application', { fields: ['expected_salary'] }],
      ['recruitment.candidate_updated', 'recruitment_candidate', 'candidate', { fields: ['birth_place', 'phone', 'phone_key'] }],
      ['recruitment.application_updated', 'recruitment_application', 'application', { fields: ['source'] }],
      ['recruitment.salary_changed', 'recruitment_application', 'application', { fields: ['expected_salary'] }],
      ['recruitment.note_added', 'recruitment_application', 'application', {}],
      ['recruitment.stage_changed', 'recruitment_application', 'application', { from: 'received', to: 'rejected', reasonCode: 'salary', autoCause: null }],
      ['recruitment.note_deleted', 'recruitment_application', 'application', {}],
      ['recruitment.candidate_updated', 'recruitment_candidate', 'candidate', { fields: ['person_id'] }],
    ]);
    expect(events.every((e) => e.actor_user_id === USERS.admin.id)).toBe(true);
    // the six personal tables never write a row diff
    const tables = await query<{ table_name: string }>(db.superuserUrl, `select distinct table_name from audit.change_log where id > $1`, [sinceChange]);
    expect(tables.filter((t) => /^recruitment_(candidate|application|note)/.test(t.table_name))).toEqual([]);
    // … and no value of the candidate is anywhere in the audit schema
    const hits = await searchDatabase(Object.values(SECRETS).concat(['Timimoun', '123457']));
    expect(hits.filter((h) => h.startsWith('audit.'))).toEqual([]);
    expect(hits.some((h) => h.startsWith('public.recruitment_candidate:'))).toBe(true); // the search itself works
    // the settings and openings keep their row diffs
    await ok('admin', 'put', '/api/recruitment/policy', { retentionMonths: 13 });
    await ok('admin', 'put', '/api/recruitment/policy', { retentionMonths: 12 });
    const policy = await query<{ op: string; changed: string[] }>(db.superuserUrl, `select op, changed from audit.change_log where id > $1 and table_name = 'recruitment_policy' order by id`, [sinceChange]);
    expect(policy).toEqual([{ op: 'update', changed: ['retention_months', 'updated_at'] }, { op: 'update', changed: ['retention_months', 'updated_at'] }]);
  });

  it('timeline: an opening (rows, workflow, events) and an application (its events and its candidate’s) with recruitment.read over the unit, without audit.read', async () => {
    const opening = await ok('chef', 'post', '/api/recruitment/openings', openingBody(ANNABA), 201);
    await ok('est', 'post', `/api/tasks/${await openTaskId(opening.id)}/approve`, {});
    await ok('admin', 'post', `/api/tasks/${await openTaskId(opening.id)}/approve`, {});
    await ok('est', 'patch', `/api/recruitment/openings/${opening.id}`, { anemReference: 'ANEM-TL' });
    // rh.est holds no audit.read: the subject follows recruitment.read
    const res = await timeline('est', `recruitment_opening:${opening.id}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const items = (res.body as Body).items as Body[];
    expect(items.filter((i) => i.kind === 'event').map((i) => i.event.type).toReversed()).toEqual(['workflow.start', 'workflow.approve', 'workflow.approve']);
    expect(new Set(items.filter((i) => i.kind === 'change').map((i) => i.table))).toEqual(new Set(['recruitment_opening', 'workflow_instance', 'workflow_task']));
    const anem = items.find((i) => i.kind === 'change' && i.table === 'recruitment_opening' && i.changes.some((c: Body) => c.field === 'anem_reference'));
    expect(anem.changes).toEqual([{ field: 'anem_reference', before: null, after: 'ANEM-TL', masked: false }]);
    expect(anem.actor).toEqual({ id: USERS.est.id, displayName: USERS.est.displayName });

    const a = await apply(opening.id, { lastName: 'Chronologie', firstName: 'Test' }, 'est');
    await upload('est', a.candidate.id, demoPdf('TEST DATA - timeline'), { kind: 'cv', title: 'CV' }).expect(201);
    await ok('est', 'post', `/api/recruitment/applications/${a.id}/move`, { toStage: 'shortlisted', expectedStage: 'received' });
    const appTimeline = (await timeline('est', `recruitment_application:${a.id}`)).body as Body;
    expect(appTimeline.items.map((i: Body) => [i.kind, i.event?.type]).toReversed()).toEqual([
      ['event', 'recruitment.candidate_created'], ['event', 'recruitment.application_created'], ['event', 'recruitment.stage_changed'], ['event', 'recruitment.file_added'], ['event', 'recruitment.stage_changed'],
    ]);
    expect(JSON.stringify(appTimeline)).not.toMatch(/Chronologie/);
    // a salary event is shown only with recruitment.salary.read: its existence says a salary was entered
    await ok('admin', 'patch', `/api/recruitment/applications/${a.id}`, { expectedSalary: '50000' });
    const typesFor = async (actor: ActorName) => ((await timeline(actor, `recruitment_application:${a.id}`)).body as Body).items.map((i: Body) => i.event?.type);
    expect(await typesFor('est')).not.toContain('recruitment.salary_changed');
    expect(JSON.stringify((await timeline('est', `recruitment_application:${a.id}`)).body)).not.toMatch(/salary/);
    expect(await typesFor('admin')).toContain('recruitment.salary_changed');
    // out of scope, other company, lecture, heads (no grant): 404 — and unknown ids
    for (const actor of ['ouest', 'acces', 'beta', 'chef', 'agent'] as const) {
      expect((await timeline(actor, `recruitment_opening:${opening.id}`)).status, actor).toBe(404);
      expect((await timeline(actor, `recruitment_application:${a.id}`)).status, actor).toBe(404);
    }
    expect((await timeline('est', `recruitment_opening:${DEMO_OPENINGS.oran}`)).status).toBe(404);
    expect((await timeline('est', `recruitment_application:${demoApplication(13)}`)).status).toBe(404);
    expect((await timeline('admin', 'recruitment_application:0190a5d0-0000-7000-8000-00000000dead')).status).toBe(404);
    expect((await timeline('admin', `recruitment_application:${demoApplication(13)}`)).status).toBe(200);
    // a candidate is not a timeline subject
    expect((await timeline('admin', `recruitment_candidate:${a.candidate.id}`)).status).toBe(422);
  });

  it('no notification of this module ever holds a candidate’s name (nor anything but the post)', async () => {
    const rows = await query<{ type: string; subject_type: string; data: Body }>(
      db.superuserUrl,
      `select type, subject_type, data from notification where subject_type = 'recruitment_opening' or data ->> 'subjectType' = 'recruitment_opening'`,
    );
    expect(rows.length).toBeGreaterThan(5);
    expect(new Set(rows.map((r) => r.type))).toEqual(new Set(['task.assigned', 'task.escalated', 'recruitment.opening_approved', 'recruitment.opening_rejected']));
    const allowed = new Set(['openingId', 'reference', 'title', 'unitName', 'unitNameAr', 'posts', 'actorName', 'audience', 'subjectType', 'stepKey', 'taskId', 'escalationReason']);
    for (const r of rows) expect(Object.keys(r.data).filter((k) => !allowed.has(k)), r.type).toEqual([]);
    const names = (await query<{ last_name: string; first_name: string }>(db.superuserUrl, `select last_name, first_name from recruitment_candidate where char_length(last_name) > 4`)).flatMap((c) => [c.last_name]);
    expect(names.length).toBeGreaterThan(20);
    const text = JSON.stringify(await query(db.superuserUrl, 'select data from notification'));
    for (const name of new Set(names)) expect(text.includes(name), name).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('erasure on request and the retention purge', () => {
  let worker: Database;
  let deps: WorkerDeps;
  let jobSeq = 0;
  let markSeq = 0;
  const job = () => ({ id: `rec-${++jobSeq}`, attempt: 1 });

  beforeAll(() => {
    worker = createDatabase({ connectionString: db.workerUrl, maxConnections: 2 });
    deps = { db: worker, logger: pino({ level: 'silent' }), mail: { send: () => Promise.resolve() }, webBaseUrl: 'http://web.test' };
  });
  afterAll(async () => {
    await worker?.destroy();
  });

  /** A candidate with unmistakable values everywhere a value can live. */
  async function marked(opening: string, tag: string): Promise<{ candidate: string; application: string; needles: string[]; sha: string }> {
    const n = ++markSeq;
    const values = { last: `Xq${tag}Nom`, first: `Xq${tag}Prenom`, lastAr: `قق${tag}`, nin: `17799${String(4_200_000_000_000 + n)}`, email: `xq.${tag.toLowerCase()}@example.test`, phone: `0798 ${String(410_000 + n)}`, place: `Xq${tag}Ville`, salary: `${71_000 + n}.77` };
    const a = await apply(opening, { lastName: values.last, firstName: values.first, lastNameAr: values.lastAr, nin: values.nin, email: values.email, phone: values.phone, birthPlace: values.place, birthDate: '1987-07-07' }, 'admin', { expectedSalary: values.salary, comment: `Xq${tag}Commentaire` });
    await ok('admin', 'post', `/api/recruitment/applications/${a.id}/notes`, { body: `Xq${tag}Note confidentielle` }, 201);
    const bytes = demoPdf(`TEST DATA - Xq${tag} CV`);
    const file = (await upload('admin', a.candidate.id, bytes, { kind: 'cv', title: `Xq${tag}Titre` }, `xq-${tag}-cv.pdf`).expect(201)).body as Body;
    const [sha] = await query<{ sha: string }>(db.superuserUrl, `select encode(sha256, 'hex') as sha from recruitment_candidate_file where id = $1`, [file.id]);
    return {
      candidate: a.candidate.id,
      application: a.id,
      sha: sha?.sha ?? '',
      // names, NIN, e-mail, phone (as typed and as its key), birth place, comment, note, file title and name, the
      // amount, the file's hash and a piece of its bytes (bytea columns are searched as hex)
      needles: [values.last, values.first, values.lastAr, values.nin, values.email, values.phone, values.phone.replace(/\D/g, '').replace(/^0/, ''), values.place, `Xq${tag}Commentaire`, `Xq${tag}Note`, `Xq${tag}Titre`, `xq-${tag}-cv`, values.salary, sha?.sha ?? 'x', Buffer.from(`Xq${tag} CV`).toString('hex')],
    };
  }

  it('erase on request: refused while an application is in progress, then nothing personal is left in the database or the audit log', async () => {
    const opening = await openOpening(CNE);
    const other = await openOpening(ORAN);
    const m = await marked(opening, 'Erase1');
    const second = await ok('admin', 'post', `/api/recruitment/openings/${other}/applications`, { candidateId: m.candidate, source: 'internal' }, 201);
    expect((await searchDatabase(m.needles)).length).toBeGreaterThan(8);
    const url = `/api/recruitment/candidates/${m.candidate}/erase`;
    // rh_regional holds no recruitment.erase (guard); a regional eraser cannot erase a candidate who also applied elsewhere
    expect((await call('est', 'post', url)).status).toBe(403);
    const [role] = await query<{ id: string }>(db.superuserUrl, `insert into role (company_id, code, name_fr, name_ar, name_en) values ($1, 'rec_regional_erase', 'Effacement', 'حذف', 'Erase') returning id`, [COMPANY_A]);
    await query(db.superuserUrl, `insert into role_permission (company_id, role_id, permission_code) values ($1, $2, 'recruitment.erase'), ($1, $2, 'recruitment.read')`, [COMPANY_A, role?.id]);
    await query(db.superuserUrl, `insert into role_grant (company_id, user_id, role_id, org_unit_id, include_descendants, valid_from) values ($1, $2, $3, $4, true, '2026-01-01')`, [COMPANY_A, USERS.target.id, role?.id, unitA('REG-EST')]);
    expect((await ok('target', 'get', `/api/recruitment/candidates/${m.candidate}`))['_actions']).toEqual([]);
    await problem('target', 'post', url, undefined, 403, 'forbidden-scope');
    expect((await call('beta', 'post', url)).status).toBe(404);
    // in progress → 409; reject / withdraw both first
    await problem('admin', 'post', url, undefined, 409, 'recruitment-application-active');
    await ok('admin', 'post', `/api/recruitment/applications/${m.application}/move`, { toStage: 'rejected', expectedStage: 'received', rejectionReasonId: await reasonId('other'), comment: 'XqErase1Commentaire refus' });
    await problem('admin', 'post', url, undefined, 409, 'recruitment-application-active');
    await ok('admin', 'post', `/api/recruitment/applications/${second.id}/move`, { toStage: 'withdrawn', expectedStage: 'received' });
    const before = (await ok('admin', 'get', `/api/recruitment/openings/${opening}`)).counts;

    const res = await call('admin', 'post', url);
    expect(res.status, JSON.stringify(res.body)).toBe(204);
    // gone from the API …
    expect((await call('admin', 'get', `/api/recruitment/candidates/${m.candidate}`)).status).toBe(404);
    expect((await call('admin', 'get', `/api/recruitment/applications/${m.application}`)).status).toBe(404);
    expect((await call('admin', 'post', url)).status).toBe(404);
    expect((await call('admin', 'get', `/api/audit/timeline?subject=recruitment_application:${m.application}`)).status).toBe(200);
    // … the anonymous rows remain: counts unchanged, the board says how many were anonymised
    expect((await ok('admin', 'get', `/api/recruitment/openings/${opening}`)).counts).toEqual(before);
    expect(await ok('admin', 'get', `/api/recruitment/openings/${opening}/board?includeFinal=true`)).toMatchObject({ purged: 1, columns: expect.arrayContaining([expect.objectContaining({ stage: 'rejected', count: 1, cards: [] })]) });
    const rows = await query<{ id: string; candidate_id: string | null; stage: string; source: string; purged: boolean; decided: boolean }>(db.superuserUrl, `select id, candidate_id, stage, source, purged_at is not null as purged, decided_at is not null as decided from recruitment_application where id = any($1) order by stage`, [[m.application, second.id]]);
    expect(rows).toEqual([
      { id: m.application, candidate_id: null, stage: 'rejected', source: 'spontaneous', purged: true, decided: true },
      { id: second.id, candidate_id: null, stage: 'withdrawn', source: 'internal', purged: true, decided: true },
    ]);
    const history = await query<{ to_stage: string; comment: string | null; reason: string | null; moved_by: string }>(db.superuserUrl, `select s.to_stage, s.comment, r.code as reason, s.moved_by from recruitment_application_stage s left join recruitment_rejection_reason r on r.id = s.rejection_reason_id where s.application_id = $1 order by s.seq`, [m.application]);
    expect(history).toEqual([{ to_stage: 'received', comment: null, reason: null, moved_by: USERS.admin.id }, { to_stage: 'rejected', comment: null, reason: 'other', moved_by: USERS.admin.id }]);
    for (const table of ['recruitment_candidate', 'recruitment_candidate_file']) expect(await query(db.superuserUrl, `select 1 from ${table} where ${table === 'recruitment_candidate' ? 'id' : 'candidate_id'} = $1`, [m.candidate])).toEqual([]);
    expect(await query(db.superuserUrl, `select 1 from recruitment_note where application_id = any($1)`, [[m.application, second.id]])).toEqual([]);
    expect(await query(db.superuserUrl, `select 1 from recruitment_application_salary where application_id = any($1)`, [[m.application, second.id]])).toEqual([]);

    // THE search: no personal value anywhere in `public` or `audit`
    expect(await searchDatabase(m.needles)).toEqual([]);
    const [event] = await query<{ actor_user_id: string; subject_type: string; subject_id: string; data: Body }>(db.superuserUrl, `select actor_user_id, subject_type, subject_id, data from audit.event where type = 'recruitment.candidate_erased' and request_id = $1`, [res.headers['x-request-id']]);
    expect(event).toEqual({ actor_user_id: USERS.admin.id, subject_type: 'recruitment_candidate', subject_id: m.candidate, data: { applications: 2, files: 1 } });
  });

  it('the retention job (worker role): 13 months purged, 11 kept; a candidate with an application left keeps its record and files; the last purge deletes them', async () => {
    // first, everything the other tests decided (well before 2028) is swept away
    await recruitmentRetentionTask(deps, { today: '2028-04-15' }, job());
    const opening = await openOpening(CNE);
    const other = await openOpening(CNE);
    const old = await marked(opening, 'Ret13');
    const recent = await marked(opening, 'Ret11');
    const shared = await marked(opening, 'RetTwo');
    const sharedSecond = await ok('admin', 'post', `/api/recruitment/openings/${other}/applications`, { candidateId: shared.candidate, source: 'internal' }, 201);
    const undecided = await marked(opening, 'RetOpen');
    // a hired application, 13 months ago (assumption 12): its recruitment-side data goes, the employment link stays
    const hired = await marked(opening, 'RetHired');
    await query(db.superuserUrl, `update recruitment_application set stage = 'hired', decided_at = $2::date - interval '13 months', employment_id = $3 where id = $1`, [hired.application, '2028-06-15', demoEmployee(26).employmentId]);
    await decide(old.application, 13, 'rejected');
    await decide(recent.application, 11);
    await decide(shared.application, 14);
    const countsBefore = (await ok('admin', 'get', `/api/recruitment/openings/${opening}`)).counts;
    const eventsBefore = (await query<{ n: number }>(db.superuserUrl, `select count(*)::int as n from audit.event`))[0]?.n ?? 0;

    // the day before the 12 months are over for anyone: nothing
    expect(await recruitmentRetentionTask(deps, { today: '2028-04-15' }, job())).toMatchObject({ applications: 0, candidates: 0, files: 0 });
    const run = await recruitmentRetentionTask(deps, { today: '2028-06-15' }, job());
    expect(run).toMatchObject({ today: '2028-06-15', companies: 2, applications: 3, candidates: 2, files: 2 });

    // purged: the 13-month rejection, the hired one, and the shared candidate's old application
    const state = async (ids: string[]) => Object.fromEntries((await query<{ id: string; purged: boolean; candidate_id: string | null; employment_id: string | null; stage: string }>(db.superuserUrl, `select id, purged_at is not null as purged, candidate_id, employment_id, stage from recruitment_application where id = any($1)`, [ids])).map((r) => [r.id, r]));
    const rows = await state([old.application, recent.application, shared.application, sharedSecond.id, undecided.application, hired.application]);
    expect(rows[old.application]).toMatchObject({ purged: true, candidate_id: null, stage: 'rejected' });
    expect(rows[hired.application]).toMatchObject({ purged: true, candidate_id: null, stage: 'hired', employment_id: demoEmployee(26).employmentId });
    expect(rows[shared.application]).toMatchObject({ purged: true, candidate_id: null });
    expect(rows[recent.application]).toMatchObject({ purged: false, candidate_id: recent.candidate });
    expect(rows[undecided.application]).toMatchObject({ purged: false, candidate_id: undecided.candidate });
    expect(rows[sharedSecond.id]).toMatchObject({ purged: false, candidate_id: shared.candidate });
    // the candidate with an application left keeps its record and its files (bytes included); the notes and salary of
    // its purged application are gone
    expect((await ok('admin', 'get', `/api/recruitment/candidates/${shared.candidate}`)).files).toHaveLength(1);
    expect(await query(db.superuserUrl, `select 1 from recruitment_candidate_file_content c join recruitment_candidate_file f on f.id = c.file_id where f.candidate_id = $1`, [shared.candidate])).toHaveLength(1);
    expect(await query(db.superuserUrl, `select 1 from recruitment_note where application_id = $1`, [shared.application])).toEqual([]);
    expect(await query(db.superuserUrl, `select 1 from recruitment_application_salary where application_id = $1`, [shared.application])).toEqual([]);
    expect((await searchDatabase(['XqRetTwoNote', 'XqRetTwoCommentaire'])).filter((h) => !h.includes('graphile'))).toEqual([]);
    // nothing personal of the two erased candidates remains anywhere; the kept ones are untouched
    expect(await searchDatabase([...old.needles, ...hired.needles])).toEqual([]);
    expect((await searchDatabase(recent.needles)).length).toBeGreaterThan(8);
    expect((await ok('admin', 'get', `/api/recruitment/applications/${recent.application}`)).notes).toHaveLength(1);
    // counts unchanged; the purged ones are anonymous
    expect((await ok('admin', 'get', `/api/recruitment/openings/${opening}`)).counts).toEqual(countsBefore);
    expect((await ok('admin', 'get', `/api/recruitment/openings/${opening}/board`)).purged).toBe(3);

    // audit: NO per-row event from the worker, exactly one recruitment.purged for the company that lost something
    const events = await query<{ type: string; company_id: string; actor_user_id: string | null; request_id: string; subject_id: string | null; data: Body }>(db.superuserUrl, `select type, company_id, actor_user_id, request_id, subject_id, data from audit.event order by id offset $1`, [eventsBefore]);
    expect(events).toEqual([{ type: 'recruitment.purged', company_id: COMPANY_A, actor_user_id: null, request_id: `job:recruitment.retention:rec-${jobSeq}`, subject_id: null, data: { applications: 3, candidates: 2, files: 2, before: '2028-06-15' } }]);
    expect(await query(db.superuserUrl, `select 1 from audit.change_log where request_id like 'job:recruitment.retention:%'`)).toEqual([]);

    // idempotent; then the last application of the shared candidate is decided and, a year later, the candidate goes
    expect(await recruitmentRetentionTask(deps, { today: '2028-06-15' }, job())).toMatchObject({ applications: 0, candidates: 0, files: 0 });
    await ok('admin', 'post', `/api/recruitment/applications/${sharedSecond.id}/move`, { toStage: 'withdrawn', expectedStage: 'received' });
    await query(db.superuserUrl, `update recruitment_application set decided_at = '2028-01-10T10:00:00Z' where id = $1`, [sharedSecond.id]);
    expect(await recruitmentRetentionTask(deps, { today: '2029-01-10' }, job())).toMatchObject({ applications: 1 }); // 12 months to the day: not yet … but `recent` is
    expect((await state([sharedSecond.id]))[sharedSecond.id]).toMatchObject({ purged: false });
    expect(await recruitmentRetentionTask(deps, { today: '2029-01-11' }, job())).toMatchObject({ applications: 1, candidates: 1, files: 1 });
    expect(await query(db.superuserUrl, 'select 1 from recruitment_candidate where id = $1', [shared.candidate])).toEqual([]);
    expect(await searchDatabase([...shared.needles, ...recent.needles])).toEqual([]);
    // an application never decided is never erased (assumption 13)
    expect(await recruitmentRetentionTask(deps, { today: '2040-01-01' }, job())).toMatchObject({ applications: expect.any(Number) });
    expect((await state([undecided.application]))[undecided.application]).toMatchObject({ purged: false, candidate_id: undecided.candidate });
    await expect(recruitmentRetentionTask(deps, { today: 'soon' }, job())).rejects.toThrow(/YYYY-MM-DD/);
  }, 120_000);

  it('the policy’s months decide; the cron is the eighth job, on day 1 at 02:45', async () => {
    await recruitmentRetentionTask(deps, { today: '2040-06-01' }, job());
    const opening = await openOpening(CNE);
    const a = await apply(opening, { lastName: 'Politique', firstName: 'Mois' });
    await ok('admin', 'post', `/api/recruitment/applications/${a.id}/move`, { toStage: 'withdrawn', expectedStage: 'received' });
    await query(db.superuserUrl, `update recruitment_application set decided_at = '2041-01-01T10:00:00Z' where id = $1`, [a.id]);
    await ok('admin', 'put', '/api/recruitment/policy', { retentionMonths: 2 });
    expect(await recruitmentRetentionTask(deps, { today: '2041-03-01' }, job())).toMatchObject({ applications: 0 });
    expect(await recruitmentRetentionTask(deps, { today: '2041-03-02' }, job())).toMatchObject({ applications: 1, candidates: 1 });
    await ok('admin', 'put', '/api/recruitment/policy', { retentionMonths: 12 });
    expect(CRON_ITEMS.find((c) => c.task === TASKS.recruitmentRetention)).toMatchObject({ task: 'recruitment.retention', match: '45 2 1 * *', options: { maxAttempts: 10, backfillPeriod: 7 * 24 * 3_600_000 } });
  });

  it('database guards, as hrforce_app and hrforce_worker', async () => {
    const opening = await openOpening(CNE);
    const live = await apply(opening, { lastName: 'Garde', firstName: 'Vive' });
    const gone = await apply(opening, { lastName: 'Garde', firstName: 'Purgée' });
    await ok('admin', 'post', `/api/recruitment/applications/${gone.id}/move`, { toStage: 'withdrawn', expectedStage: 'received', comment: 'Commentaire' });
    await ok('admin', 'post', `/api/recruitment/candidates/${gone.candidate.id}/erase`, undefined, 204);
    // an application is never deleted — by anyone
    await expect(asApp(`delete from recruitment_application where id = '${live.id}'`)).rejects.toThrow(/permission denied/);
    await expect(asWorker(`delete from recruitment_application where id = '${gone.id}'`)).rejects.toThrow(/permission denied/);
    // the history is immutable: no column but the comment, and the comment only to null
    await expect(asApp(`update recruitment_application_stage set to_stage = 'interview' where application_id = '${live.id}'`)).rejects.toThrow(/permission denied/);
    await expect(asApp(`update recruitment_application_stage set comment = 'réécrit' where application_id = '${live.id}'`)).rejects.toThrow(/immutable/);
    await expect(asApp(`delete from recruitment_application_stage where application_id = '${live.id}'`)).rejects.toThrow(/permission denied/);
    await expect(asWorker(`update recruitment_application_stage set moved_by = null where application_id = '${live.id}'`)).rejects.toThrow(/permission denied/);
    // a purged application never changes again (un-purging refused); the candidate only leaves by the purge
    await expect(asApp(`update recruitment_application set purged_at = null, candidate_id = '${live.candidate.id}' where id = '${gone.id}'`)).rejects.toThrow(/never changes/);
    await expect(asApp(`update recruitment_application set source = 'anem' where id = '${gone.id}'`)).rejects.toThrow(/never changes/);
    await expect(asWorker(`update recruitment_application set purged_at = now() where id = '${gone.id}'`)).rejects.toThrow(/never changes/);
    await expect(asApp(`update recruitment_application set candidate_id = null where id = '${live.id}'`)).rejects.toThrow(/only leaves an application by its purge/);
    await expect(asApp(`update recruitment_application set candidate_id = null, purged_at = now() where id = '${live.id}'`)).rejects.toThrow(/only a decided application is purged/);
    await expect(asApp(`update recruitment_application set opening_id = '${DEMO_OPENINGS.annaba}' where id = '${live.id}'`)).rejects.toThrow(/immutable/);
    // a candidate is deleted only when unreferenced
    await expect(asApp(`delete from recruitment_candidate where id = '${live.candidate.id}'`)).rejects.toThrow(/recruitment_application_candidate_fk/);
    // the worker: nothing but the purge's writes
    await expect(asWorker(`update recruitment_candidate set last_name = 'x' where id = '${live.candidate.id}'`)).rejects.toThrow(/permission denied/);
    await expect(asWorker(`update recruitment_application set stage = 'rejected' where id = '${live.id}'`)).rejects.toThrow(/permission denied/);
    await expect(asWorker(`insert into recruitment_note (company_id, application_id, body, created_by) values ('${COMPANY_A}', '${live.id}', 'x', '${USERS.admin.id}')`)).rejects.toThrow(/permission denied/);
    await expect(asWorker(`update recruitment_opening set posts = 1`)).rejects.toThrow(/permission denied/);
    // RLS: another tenant sees none of it
    expect(await asRole(db.appUrl, COMPANY_B, `select id from recruitment_candidate where id = '${live.candidate.id}'`)).toEqual([]);
    expect(await asRole(db.appUrl, COMPANY_B, `select id from recruitment_application where id = '${live.id}'`)).toEqual([]);
  });
});
