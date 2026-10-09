/**
 * Recruitment, Phase B (docs/contracts/recruitment.md › Phase B) against the real grants (DEV_AUTH header identity, no
 * DEV_PERMISSIONS): evaluation criteria (the company list, the copy per opening, the lock after the first evaluation),
 * interviews (schedule, change, cancel, the interviewers told — never with a candidate's name), what an interviewer
 * WITHOUT any recruitment permission sees (only the candidates they must evaluate, only while the application is in
 * progress, never another evaluation, the NIN, contact details, salary or notes), the evaluation rules, the comparison
 * per role, offers (posts never exceeded, the proposed salary behind its permissions), the hire in ONE transaction
 * (a new person, a rehire, the files copied into the employee file, the last post filling the opening, two concurrent
 * hires, and nothing persisted when anything fails), its undo, the head's sub-units route, and the purge of the Phase B
 * data with a search of the whole database and audit log.
 */
import { createHash } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client } from 'pg';
import { pino } from 'pino';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedGrants } from '../src/modules/authorization/index.js';
import { demoLogoPng, demoPdf } from '../src/modules/documents/index.js';
import { DEMO_OPENINGS, demoApplication, demoInterview } from '../src/modules/recruitment/index.js';
import { createDatabase, type Database } from '../src/platform/db/database.js';
import { recruitmentRetentionTask, type WorkerDeps } from '../src/worker/tasks.js';
import { companyOf, COMPANY_A, demoEmployee, seedAccessFixture, unitA, USERS, type AccessFixture, type ActorName } from './support/access-fixture.js';
import { assertNoSecrets } from './support/assert-no-secrets.js';
import { REC_FX } from './support/recruitment-fixture.js';
import { createTestApp } from './support/test-app.js';
import { createTestDatabase, query, type TestDatabase } from './support/test-database.js';
import { fetchXsrf, type XsrfPair } from './support/xsrf.js';

let db: TestDatabase;
let app: NestExpressApplication;
let xsrf: XsrfPair;
let fx: AccessFixture;
let seq = 0;
let criteria: string[] = [];

const PROBLEM = (slug: string) => `urn:hrforce:problem:${slug}`;
const ANNABA = unitA('AG-ANNABA');
const CNE = unitA('AG-CNE');
const ORAN = unitA('AG-ORAN');
const PAST = { date: '2026-02-10', time: '09:30' };
const FUTURE = { date: '2031-05-05', time: '14:00' };

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
type Body = Response['body'];

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

async function problem(actor: ActorName, method: Method, url: string, body: object | undefined, status: number, slug: string): Promise<Body> {
  const res = await call(actor, method, url, body);
  expect([res.status, (res.body as Body).type], `${method} ${url} as ${actor}: ${JSON.stringify(res.body)}`).toEqual([status, PROBLEM(slug)]);
  return res.body as Body;
}

const errorsOf = (body: Body): [string, string][] => ((body.errors ?? []) as { field: string; code: string }[]).map((e) => [e.field, e.code]);
const one = async <T extends object>(text: string, params: unknown[] = []): Promise<T> => ((await query<T>(db.superuserUrl, text, params))[0] ?? ({} as T));
const count = async (text: string, params: unknown[] = []): Promise<number> => (await one<{ n: number }>(`select count(*)::int as n from ${text}`, params)).n;

function upload(actor: ActorName, candidateId: string, file: Buffer, fields: Record<string, string> = {}, filename = 'cv.pdf') {
  let t = request(app.getHttpServer())
    .post(`/api/recruitment/candidates/${candidateId}/files`)
    .set('X-Dev-User-Id', USERS[actor].id)
    .set('X-Dev-Company-Id', companyOf(actor))
    .set('Cookie', xsrf.cookie)
    .set('X-XSRF-TOKEN', xsrf.token);
  for (const [k, v] of Object.entries({ kind: 'cv', title: 'CV', ...fields })) t = t.field(k, v);
  return t.attach('file', file, filename);
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

/** An OPEN opening on `unitId` created by SQL, holding the company's five criteria. */
async function openOpening(unitId: string, posts = 2): Promise<string> {
  const n = ++seq;
  const { id } = await one<{ id: string }>(
    `insert into recruitment_opening (company_id, reference, title, org_unit_id, contract_type, posts, justification, target_date, status, requested_by, opened_at)
     values ($1, $2, $3, $4, 'cdi', $5, 'Besoin de test.', '2031-01-01', 'open', $6, now()) returning id`,
    [COMPANY_A, `REC-2022-${String(n).padStart(4, '0')}`, `Poste B ${n}`, unitId, posts, USERS.admin.id],
  );
  await query(
    db.superuserUrl,
    `insert into recruitment_opening_criterion (company_id, opening_id, criterion_id, position)
     select company_id, $2, id, row_number() over (order by sort_order) from recruitment_criterion where company_id = $1 and is_system`,
    [COMPANY_A, id],
  );
  return id;
}

async function apply(openingId: string, candidate: object = {}, actor: ActorName = 'admin', extra: object = {}): Promise<Body> {
  const n = ++seq;
  return ok(actor, 'post', `/api/recruitment/openings/${openingId}/applications`, { candidate: { lastName: `Postulant${n}`, firstName: 'Test', ...candidate }, source: 'spontaneous', ...extra }, 201);
}

const schedule = (actor: ActorName, applicationId: string, interviewers: ActorName[], when = PAST, extra: object = {}) =>
  ok(actor, 'post', `/api/recruitment/applications/${applicationId}/interviews`, { ...when, mode: 'on_site', interviewerIds: interviewers.map((a) => USERS[a].id), ...extra }, 201);

const scoresOf = (values: number[]) => criteria.map((criterionId, k) => ({ criterionId, score: values[k % values.length] ?? 3 }));
const evaluate = (actor: ActorName, interviewId: string, values: number[], extra: object = {}) =>
  call(actor, 'put', `/api/me/recruitment/interviews/${interviewId}/evaluation`, { scores: scoresOf(values), recommendation: 'yes', ...extra });

const offerBody = (orgUnitId: string, extra: object = {}) => ({ expectedStage: 'interview', jobTitle: 'Chargé(e) de clientèle', orgUnitId, contractType: 'cdi', startDate: '2026-11-02', ...extra });
const makeOffer = (actor: ActorName, applicationId: string, body: object) => call(actor, 'post', `/api/recruitment/applications/${applicationId}/offer`, body);

/** An application under offer on `openingId` (unit `unitId`), as admin → the ApplicationDetailView. */
async function offered(openingId: string, unitId: string, candidate: object = {}, extra: object = {}): Promise<Body> {
  const a = await apply(openingId, candidate);
  const res = await makeOffer('admin', a.id, offerBody(unitId, { expectedStage: 'received', ...extra }));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as Body;
}

const hireBody = (orgUnitId: string, extra: object = {}) => {
  const n = ++seq;
  return { lastName: `Recruté${n}`, firstName: 'Nouveau', matricule: `REC-B-${n}`, hireDate: '2026-11-02', orgUnitId, jobTitle: 'Chargé de clientèle', expectedStage: 'offer', copyFileIds: [], ...extra };
};
const hire = (actor: ActorName, applicationId: string, body: object) => call(actor, 'post', `/api/recruitment/applications/${applicationId}/hire`, body);

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

/** Searches EVERY table of `public` and `audit` (as the superuser) for rows whose text holds one of `needles`. */
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

async function asRole(url: string, statement: string): Promise<unknown[]> {
  const pg = new Client({ connectionString: url });
  await pg.connect();
  try {
    await pg.query('begin');
    await pg.query(`select set_config('app.company_id', $1, true)`, [COMPANY_A]);
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

const notificationsOf = (userId: string, subjectId: string) =>
  query<{ type: string; data: Body }>(db.superuserUrl, `select type, data from notification where user_id = $1 and subject_id = $2 order by created_at, id`, [userId, subjectId]);

/** Row counts of what a hire writes. */
const snapshot = async () =>
  one<{ persons: number; employments: number; assignments: number; salaries: number; files: number; hired: number }>(
    `select (select count(*)::int from person) as persons, (select count(*)::int from employment) as employments, (select count(*)::int from assignment) as assignments,
            (select count(*)::int from employment_salary) as salaries, (select count(*)::int from employee_file) as files,
            (select count(*)::int from audit.event where type = 'recruitment.hired') as hired`,
  );

/** An application with a value in every Phase B column that can hold one. */
async function marked(opening: string, tag: string, unitId = CNE): Promise<{ application: string; candidate: string; interview: string; needles: string[] }> {
  const a = await apply(opening, { lastName: `Xq${tag}Nom`, firstName: `Xq${tag}Prenom`, nin: `17899${String(4_300_000_000_000 + ++seq)}`, email: `xq.${tag.toLowerCase()}@example.test` });
  const interview = await schedule('admin', a.id, ['chef', 'est'], PAST, { label: `Xq${tag}Label`, location: `Xq${tag}Salle` });
  expect((await evaluate('chef', interview.id, [4, 5], { comment: `Xq${tag}Avis du chef` })).status).toBe(200);
  expect((await evaluate('est', interview.id, [3], { comment: `Xq${tag}Avis RH` })).status).toBe(200);
  const cancelled = await schedule('admin', a.id, ['chef'], FUTURE, { label: `Xq${tag}Second` });
  await ok('admin', 'post', `/api/recruitment/interviews/${cancelled.id}/cancel`, { reason: `Xq${tag}Annulation` });
  const res = await makeOffer('admin', a.id, offerBody(unitId, { jobTitle: `Xq${tag}Poste`, note: `Xq${tag}NoteOffre`, proposedSalary: `8${seq}321.99` }));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return {
    application: a.id,
    candidate: a.candidate.id,
    interview: interview.id,
    needles: [`Xq${tag}Label`, `Xq${tag}Salle`, `Xq${tag}Avis`, `Xq${tag}Second`, `Xq${tag}Annulation`, `Xq${tag}Poste`, `Xq${tag}NoteOffre`, `8${seq}321.99`, `xq.${tag.toLowerCase()}@`],
  };
}
const phaseB = async (application: string, interview: string) => ({
  interviews: await count(`recruitment_interview where application_id = $1`, [application]),
  interviewers: await count(`recruitment_interviewer where interview_id = $1`, [interview]),
  offers: await count(`recruitment_offer where application_id = $1`, [application]),
  salary: await count(`recruitment_application_salary where application_id = $1`, [application]),
});

beforeAll(async () => {
  db = await createTestDatabase();
  fx = await seedAccessFixture(db, undefined, { leave: true, documents: true, recruitment: true });
  app = await createTestApp(db, { devAuth: true, devPermissions: false });
  xsrf = await fetchXsrf(app);
  criteria = (await query<{ id: string }>(db.superuserUrl, `select id from recruitment_criterion where company_id = $1 and is_system order by sort_order`, [COMPANY_A])).map((r) => r.id);
  expect(criteria).toHaveLength(5);
});

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

// ---------------------------------------------------------------------------------------------------------------
describe('evaluation criteria', () => {
  it('the company list: five seeded, read with recruitment.read, written with recruitment.configure over the whole company', async () => {
    const list = (await ok('est', 'get', '/api/recruitment/criteria')).items as Body[];
    expect(list.map((c) => [c.code, c.labels.fr, c.labels.ar, c.active, c.isSystem])).toEqual([
      ['skills', 'Compétences techniques', 'الكفاءات التقنية', true, true],
      ['experience', 'Expérience', 'الخبرة المهنية', true, true],
      ['communication', 'Communication', 'التواصل', true, true],
      ['motivation', 'Motivation', 'الحافز', true, true],
      ['fit', 'Adéquation au poste', 'الملاءمة للمنصب', true, true],
    ]);
    for (const actor of ['ouest', 'acces', 'chef', 'agent'] as const) expect((await call(actor, 'get', '/api/recruitment/criteria')).status, actor).toBe(403);
    const labels = { fr: 'Langues', ar: 'اللغات', en: 'Languages' };
    expect((await call('est', 'post', '/api/recruitment/criteria', { code: 'languages', labels })).status).toBe(403);
    const created = await ok('admin', 'post', '/api/recruitment/criteria', { code: 'languages', labels }, 201);
    expect(created).toMatchObject({ code: 'languages', labels, active: true, isSystem: false, sortOrder: 60 });
    expect(errorsOf(await problem('admin', 'post', '/api/recruitment/criteria', { code: 'languages', labels }, 409, 'recruitment-criterion-code-taken'))).toEqual([['code', 'taken']]);
    expect((await call('admin', 'post', '/api/recruitment/criteria', { code: 'Bad Code', labels })).status).toBe(422);
    expect(await ok('admin', 'put', `/api/recruitment/criteria/${created.id}`, { active: false, sortOrder: 5, labels: { ...labels, fr: 'Langues étrangères' } })).toMatchObject({ active: false, sortOrder: 5, labels: { fr: 'Langues étrangères' } });
    expect((await call('est', 'put', `/api/recruitment/criteria/${created.id}`, { active: true })).status).toBe(403);
    expect((await call('admin', 'put', `/api/recruitment/criteria/${USERS.admin.id}`, { active: true })).status).toBe(404);
    // a criterion is never deleted
    await expect(asRole(db.appUrl, `delete from recruitment_criterion where id = '${created.id}'`)).rejects.toThrow(/permission denied/);
  });

  it('an opening gets the active criteria when it opens; HR adjusts them (1–8, active, in order) until the first evaluation', async () => {
    await ok('admin', 'put', '/api/recruitment/policy', { openingWorkflowCode: 'recruitment.hr_only' });
    const requested = await ok('est', 'post', '/api/recruitment/openings', { title: 'Poste critères', orgUnitId: CNE, contractType: 'cdi', posts: 1, justification: 'Besoin de test.', targetDate: '2031-06-30' }, 201);
    expect(requested.criteria).toEqual([]);
    const task = await one<{ id: string }>(`select t.id from workflow_task t join workflow_instance i on i.id = t.instance_id where i.subject_id = $1 and t.status = 'open'`, [requested.id]);
    await ok('admin', 'post', `/api/tasks/${task.id}/approve`, {});
    await ok('admin', 'put', '/api/recruitment/policy', { openingWorkflowCode: 'recruitment.manager_then_hr' });
    const opened = await ok('admin', 'get', `/api/recruitment/openings/${requested.id}`);
    // the inactive « languages » criterion is not copied
    expect(opened.criteria.map((c: Body) => c.id)).toEqual(criteria);
    expect(opened.criteria[0]).toEqual({ id: criteria[0], labels: { fr: 'Compétences techniques', ar: 'الكفاءات التقنية', en: 'Technical skills' } });
    expect(opened['_actions']).toContain('set_criteria');
    // the requester's view carries them too
    expect((await ok('est', 'get', `/api/me/recruitment/openings/${requested.id}`)).criteria).toHaveLength(5);

    const url = `/api/recruitment/openings/${requested.id}/criteria`;
    const two = [criteria[3], criteria[0]];
    expect((await ok('est', 'put', url, { criterionIds: two })).criteria.map((c: Body) => c.id)).toEqual(two);
    const inactive = (await one<{ id: string }>(`select id from recruitment_criterion where company_id = $1 and code = 'languages'`, [COMPANY_A])).id;
    expect(errorsOf(await problem('admin', 'put', url, { criterionIds: [criteria[0], inactive, USERS.admin.id, criteria[0]] }, 422, 'validation-error'))).toEqual([
      ['criterionIds.1', 'inactive'], ['criterionIds.2', 'not_found'], ['criterionIds.3', 'duplicate'],
    ]);
    expect((await call('admin', 'put', url, { criterionIds: [] })).status).toBe(422);
    expect((await call('ouest', 'put', url, { criterionIds: two })).status).toBe(403);
    expect((await call('admin', 'put', `/api/recruitment/openings/${DEMO_OPENINGS.oranClosed}/criteria`, { criterionIds: two })).status).toBe(409);

    // the first submitted evaluation locks them
    const a = await apply(requested.id);
    const interview = await schedule('admin', a.id, ['est']);
    const res = await call('est', 'put', `/api/me/recruitment/interviews/${interview.id}/evaluation`, { scores: two.map((criterionId) => ({ criterionId, score: 4 })), recommendation: 'yes' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await problem('admin', 'put', url, { criterionIds: criteria }, 409, 'recruitment-criteria-locked');
    expect((await ok('admin', 'get', `/api/recruitment/openings/${requested.id}`))['_actions']).not.toContain('set_criteria');
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('interviews', () => {
  it('schedule: 1–5 active users of the company; a shortlisted application moves to interview; the interviewers are told — without the candidate’s name', async () => {
    const opening = await openOpening(CNE);
    const a = await apply(opening, { lastName: 'Zzcandidat', firstName: 'Xxprenom' });
    await ok('admin', 'post', `/api/recruitment/applications/${a.id}/move`, { toStage: 'shortlisted', expectedStage: 'received' });
    const url = `/api/recruitment/applications/${a.id}/interviews`;
    const base = { ...FUTURE, mode: 'video', interviewerIds: [USERS.chef.id] };
    // body rules
    expect(errorsOf(await problem('admin', 'post', url, { ...base, time: '25:00' }, 422, 'validation-error'))).toEqual([['time', 'invalid_time']]);
    expect((await call('admin', 'post', url, { ...base, interviewerIds: [] })).status).toBe(422);
    expect((await call('admin', 'post', url, { ...base, interviewerIds: [USERS.chef.id, USERS.est.id, USERS.admin.id, USERS.agent.id, USERS.acces.id, USERS.ouest.id] })).status).toBe(422);
    expect((await call('admin', 'post', url, { ...base, durationMinutes: 10 })).status).toBe(422);
    // an unknown user, a member of another company, a user listed twice
    expect(errorsOf(await problem('admin', 'post', url, { ...base, interviewerIds: [USERS.chef.id, USERS.beta.id, CNE, USERS.chef.id] }, 422, 'validation-error'))).toEqual([
      ['interviewerIds.1', 'not_found'], ['interviewerIds.2', 'not_found'], ['interviewerIds.3', 'duplicate'],
    ]);
    // permission and scope
    for (const actor of ['ouest', 'acces', 'chef', 'agent'] as const) expect((await call(actor, 'post', url, base)).status, actor).toBe(403);
    expect((await call('beta', 'post', url, base)).status).toBe(404);

    const interview = await ok('est', 'post', url, { ...base, interviewerIds: [USERS.chef.id, USERS.est.id], label: 'Entretien technique', location: 'https://visio.example.test/x', durationMinutes: 45 }, 201);
    expect(interview).toMatchObject({
      applicationId: a.id, label: 'Entretien technique', date: FUTURE.date, time: FUTURE.time, scheduledAt: '2031-05-05T13:00:00.000Z', durationMinutes: 45, mode: 'video',
      location: 'https://visio.example.test/x', status: 'scheduled', state: 'upcoming', cancelReason: null, createdBy: { id: USERS.est.id }, average: null, _actions: ['update', 'cancel'],
    });
    expect(interview.evaluations.map((e: Body) => [e.interviewer.id, e.submittedAt, e.scores, e.overall, e.recommendation])).toEqual(
      expect.arrayContaining([[USERS.chef.id, null, [], null, null], [USERS.est.id, null, [], null, null]]),
    );
    // the application moved to `interview`, with the automatic cause
    const detail = await ok('admin', 'get', `/api/recruitment/applications/${a.id}`);
    expect(detail.stage).toBe('interview');
    expect(detail.stages.at(-1)).toMatchObject({ from: 'shortlisted', to: 'interview', autoCause: 'interview_scheduled', by: { id: USERS.est.id } });
    expect(detail.interviews.map((i: Body) => i.id)).toEqual([interview.id]);
    // chef is told (rh.est scheduled it: the actor is not); the notification names the post and the appointment only
    const told = await notificationsOf(USERS.chef.id, interview.id);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ type: 'recruitment.interview_assigned' });
    expect(Object.keys(told[0]?.data ?? {}).toSorted()).toEqual(['actorName', 'audience', 'date', 'interviewId', 'mode', 'openingId', 'reference', 'time', 'title']);
    expect(told[0]?.data).toMatchObject({ date: FUTURE.date, time: FUTURE.time, mode: 'video', actorName: USERS.est.displayName });
    expect(await notificationsOf(USERS.est.id, interview.id)).toEqual([]);
    expect(await count(`graphile_worker._private_jobs j where j.key in (select 'notifications.email:' || id::text from notification where subject_id = $1)`, [interview.id])).toBe(1);
    const mine = (await ok('chef', 'get', '/api/me/notifications')).items as Body[];
    expect(mine.find((n) => n.subject.id === interview.id)).toMatchObject({ type: 'recruitment.interview_assigned', subject: { type: 'recruitment_interview' }, link: `/me/interviews/${interview.id}` });

    // an application under offer or decided gets no interview
    const other = await offered(opening, CNE);
    await problem('admin', 'post', `/api/recruitment/applications/${other.id}/interviews`, base, 409, 'recruitment-interview-stage');
    await ok('admin', 'post', `/api/recruitment/applications/${a.id}/move`, { toStage: 'withdrawn', expectedStage: 'interview' });
    await problem('admin', 'post', url, base, 409, 'recruitment-interview-stage');
    // … and the withdrawal cancelled the interview to come: chef is told, the reason is recorded
    expect((await ok('admin', 'get', `/api/recruitment/applications/${a.id}`)).interviews[0]).toMatchObject({ status: 'cancelled', state: 'cancelled', cancelReason: 'Désistement', _actions: [] });
    expect((await notificationsOf(USERS.chef.id, interview.id)).map((n) => n.type)).toEqual(['recruitment.interview_assigned', 'recruitment.interview_cancelled']);
  });

  it('a person never evaluates their own application (a candidate linked to the interviewer’s person)', async () => {
    const opening = await openOpening(CNE);
    const a = await apply(opening);
    // rh.est is linked to EMP-0022
    await ok('admin', 'put', `/api/recruitment/candidates/${a.candidate.id}/person`, { personId: demoEmployee(22).personId });
    expect(errorsOf(await problem('admin', 'post', `/api/recruitment/applications/${a.id}/interviews`, { ...PAST, mode: 'phone', interviewerIds: [USERS.chef.id, USERS.est.id] }, 422, 'validation-error'))).toEqual([['interviewerIds.1', 'self']]);
  });

  it('change and cancel: the appointment, the interviewers (never one who submitted), the notifications; a cancelled interview is final and leaves the averages', async () => {
    const opening = await openOpening(CNE);
    const a = await apply(opening);
    const interview = await schedule('admin', a.id, ['chef', 'est'], PAST, { location: 'Salle 1' });
    expect(interview.state).toBe('awaiting_evaluations');
    expect((await evaluate('chef', interview.id, [4])).status).toBe(200);
    const url = `/api/recruitment/interviews/${interview.id}`;
    for (const actor of ['ouest', 'acces', 'chef', 'agent'] as const) expect((await call(actor, 'patch', url, { durationMinutes: 30 })).status, actor).toBe(403);
    expect((await call('beta', 'patch', url, { durationMinutes: 30 })).status).toBe(404);
    expect((await call('admin', 'patch', `/api/recruitment/interviews/${a.id}`, { durationMinutes: 30 })).status).toBe(404);

    // a label or a duration tells nobody; a new place tells the interviewers who stay (`rescheduled`)
    expect(await ok('admin', 'patch', url, { durationMinutes: 30, label: 'Second entretien' })).toMatchObject({ durationMinutes: 30, label: 'Second entretien', date: PAST.date, time: PAST.time });
    expect((await notificationsOf(USERS.est.id, interview.id)).map((n) => [n.type, n.data.rescheduled ?? null])).toEqual([['recruitment.interview_assigned', null]]);
    expect(await ok('admin', 'patch', url, { time: '10:15', location: 'Salle 2' })).toMatchObject({ time: '10:15', date: PAST.date, location: 'Salle 2' });
    expect((await notificationsOf(USERS.est.id, interview.id)).map((n) => [n.type, n.data.rescheduled ?? null, n.data.time])).toEqual([
      ['recruitment.interview_assigned', null, '09:30'], ['recruitment.interview_assigned', 1, '10:15'],
    ]);
    // est (not submitted) is replaced by agent; chef (submitted) cannot be removed
    const swapped = await ok('admin', 'patch', url, { interviewerIds: [USERS.chef.id, USERS.agent.id] });
    expect(swapped.evaluations.map((e: Body) => e.interviewer.id).toSorted()).toEqual([USERS.agent.id, USERS.chef.id].toSorted());
    expect((await notificationsOf(USERS.est.id, interview.id)).at(-1)?.type).toBe('recruitment.interview_cancelled');
    expect((await notificationsOf(USERS.agent.id, interview.id)).map((n) => n.type)).toEqual(['recruitment.interview_assigned']);
    expect(errorsOf(await problem('admin', 'patch', url, { interviewerIds: [USERS.agent.id] }, 409, 'recruitment-evaluation-exists'))).toEqual([['interviewerIds', 'evaluation_exists']]);
    expect((await ok('admin', 'get', `/api/recruitment/applications/${a.id}`)).average).toBe(4);

    // cancel: a reason, final, out of the averages
    expect((await call('admin', 'post', `${url}/cancel`, {})).status).toBe(422);
    expect((await call('ouest', 'post', `${url}/cancel`, { reason: 'Report' })).status).toBe(403);
    expect(await ok('est', 'post', `${url}/cancel`, { reason: 'Candidat indisponible' })).toMatchObject({ status: 'cancelled', state: 'cancelled', cancelReason: 'Candidat indisponible', average: null, _actions: [] });
    expect((await notificationsOf(USERS.agent.id, interview.id)).map((n) => n.type)).toEqual(['recruitment.interview_assigned', 'recruitment.interview_cancelled']);
    await problem('admin', 'post', `${url}/cancel`, { reason: 'Encore' }, 409, 'recruitment-interview-cancelled');
    await problem('admin', 'patch', url, { durationMinutes: 60 }, 409, 'recruitment-interview-cancelled');
    const detail = await ok('admin', 'get', `/api/recruitment/applications/${a.id}`);
    expect(detail.average).toBeNull();
    expect((await ok('admin', 'get', `/api/recruitment/openings/${opening}/comparison`)).rows).toEqual([]);
    // the database refuses to revive it, whoever asks
    await expect(asRole(db.appUrl, `update recruitment_interview set status = 'scheduled', cancel_reason = null where id = '${interview.id}'`)).rejects.toThrow(/never changes/);
    await expect(asRole(db.workerUrl, `update recruitment_interview set label = 'x' where id = '${interview.id}'`)).rejects.toThrow(/permission denied/);
  });

  it('the picker: active users of the company by name or e-mail, with their employee card', async () => {
    const found = (await ok('est', 'get', '/api/recruitment/interviewers?q=karim')).items as Body[];
    expect(found.map((u) => u.id)).toContain(USERS.est.id);
    expect(found.find((u) => u.id === USERS.est.id)).toEqual({ id: USERS.est.id, displayName: USERS.est.displayName, employee: { matricule: 'EMP-0022', unit: expect.objectContaining({ code: 'REG-EST' }) } });
    expect(((await ok('admin', 'get', '/api/recruitment/interviewers?q=@demo.dz')).items as Body[]).length).toBeGreaterThan(5);
    expect(((await ok('admin', 'get', '/api/recruitment/interviewers?q=newbie')).items as Body[])[0]).toMatchObject({ id: USERS.newbie.id, employee: null });
    // BETA's users only for BETA, none of company A's
    const beta = (await ok('beta', 'get', '/api/recruitment/interviewers?q=dmin')).items as Body[];
    expect(beta.map((u) => u.id)).toEqual([USERS.beta.id]);
    expect(((await ok('admin', 'get', '/api/recruitment/interviewers?q=beta.dz')).items as Body[])).toEqual([]);
    expect((await call('admin', 'get', '/api/recruitment/interviewers?q=k')).status).toBe(422);
    for (const actor of ['ouest', 'acces', 'chef', 'agent'] as const) expect((await call(actor, 'get', '/api/recruitment/interviewers?q=karim')).status, actor).toBe(403);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('what an interviewer sees (no recruitment permission)', () => {
  const NIN = '288990000000004242';

  it('only the candidates they must evaluate: name, opening, appointment, files, criteria, their own evaluation — never the NIN, contact, salary, notes or another evaluation', async () => {
    const opening = await openOpening(CNE);
    const a = await apply(opening, { lastName: 'Visible', firstName: 'Entretien', lastNameAr: 'مرئي', nin: NIN, email: 'secret.mail@example.test', phone: '0770 42 42 42', birthDate: '1988-08-08', birthPlace: 'Secretville' }, 'admin', { expectedSalary: '91234.56' });
    await ok('admin', 'post', `/api/recruitment/applications/${a.id}/notes`, { body: 'NoteSecrete des RH' }, 201);
    const cv = (await upload('admin', a.candidate.id, demoPdf('TEST DATA - CV entretien'), { title: 'CV' }).expect(201)).body as Body;
    const stranger = await apply(opening, { lastName: 'Autre', firstName: 'Inconnu' });
    await schedule('admin', stranger.id, ['est']);
    const interview = await schedule('admin', a.id, ['chef', 'est'], PAST, { label: 'Entretien RH', location: 'Salle A' });
    expect((await evaluate('est', interview.id, [5, 4], { recommendation: 'strong_yes', comment: 'AvisDeKarim confidentiel' })).status).toBe(200);

    // chef heads Agence Annaba, not Constantine: an interviewer only
    expect((await call('chef', 'get', `/api/me/recruitment/openings/${opening}`)).status).toBe(404);
    const list = (await ok('chef', 'get', '/api/me/recruitment/interviews')).items as Body[];
    const mine = list.find((i) => i.id === interview.id);
    expect(mine).toEqual({
      id: interview.id, label: 'Entretien RH', scheduledAt: '2026-02-10T08:30:00.000Z', date: PAST.date, time: PAST.time, durationMinutes: 60, mode: 'on_site', location: 'Salle A',
      opening: { id: opening, reference: expect.stringMatching(/^REC-2022-/), title: expect.any(String), unit: expect.objectContaining({ code: 'AG-CNE' }) },
      applicationId: a.id,
      candidate: { lastName: 'Visible', firstName: 'Entretien', lastNameAr: 'مرئي', firstNameAr: null },
      files: [expect.objectContaining({ id: cv.id, kind: 'cv', _actions: [] })],
      criteria: criteria.map((id) => ({ id, labels: expect.any(Object) })),
      evaluation: { submittedAt: null, scores: [], overall: null, recommendation: null, comment: null },
      _actions: ['evaluate'],
    });
    // none of the candidates they do not evaluate
    expect(list.some((i) => i.applicationId === stranger.id)).toBe(false);
    expect(await ok('chef', 'get', `/api/me/recruitment/interviews/${interview.id}`)).toEqual(mine);
    // asserted BY KEY and by value over everything the interviewer can read
    const everything = [list, await ok('chef', 'get', '/api/me/recruitment/interviews?filter=done'), await ok('chef', 'get', '/api/me/recruitment/summary')];
    const keys = keysOf(everything);
    for (const key of ['nin', 'birthDate', 'birthPlace', 'email', 'phone', 'sex', 'nationality', 'salary', 'expected', 'proposed', 'notes', 'stages', 'evaluations', 'interviewer', 'knownPerson', 'source', 'sha256']) expect(keys.has(key), key).toBe(false);
    expect(JSON.stringify(everything)).not.toMatch(/4242|secret\.mail|0770|Secretville|91234|NoteSecrete|AvisDeKarim|1988-08-08/);
    // no HR route opens for them
    for (const url of [`/api/recruitment/applications/${a.id}`, `/api/recruitment/candidates/${a.candidate.id}`, `/api/recruitment/openings/${opening}/comparison`, `/api/recruitment/openings/${opening}/board`, `/api/recruitment/candidates/${a.candidate.id}/files/${cv.id}/content`]) {
      expect((await call('chef', 'get', url)).status, url).toBe(403);
    }
    expect((await call('chef', 'get', `/api/me/recruitment/openings/${opening}/comparison`)).status).toBe(404);
    expect((await call('chef', 'get', `/api/audit/timeline?subject=recruitment_application:${a.id}`)).status).toBe(404);
    // the file, through the /me route — audited as an interviewer's download; somebody else gets nothing
    const url = `/api/me/recruitment/applications/${a.id}/files/${cv.id}/content`;
    const res = await download('chef', url);
    expect(res.status).toBe(200);
    expect(Buffer.compare(res.body as Buffer, demoPdf('TEST DATA - CV entretien'))).toBe(0);
    expect(res.headers['content-security-policy']).toBe("sandbox; default-src 'none'");
    expect((await one<{ data: Body }>(`select data from audit.event where type = 'recruitment.file_downloaded' and request_id = $1`, [res.headers['x-request-id']])).data).toEqual({ kind: 'cv', via: 'interviewer' });
    expect((await download('agent', url)).status).toBe(404);
    expect((await call('agent', 'get', `/api/me/recruitment/interviews/${interview.id}`)).status).toBe(404);
    expect((await ok('agent', 'get', '/api/me/recruitment/interviews')).items).toEqual([]);
    expect((await call('admin', 'get', `/api/me/recruitment/interviews/${interview.id}`)).status).toBe(404); // HR, but not an interviewer of it
    expect((await download('chef', `/api/me/recruitment/applications/${stranger.id}/files/${cv.id}/content`)).status).toBe(404);

    // after submitting: their own evaluation, still nobody else's
    expect((await evaluate('chef', interview.id, [3, 4, 4, 2, 5], { recommendation: 'no', comment: 'Mon avis' })).status).toBe(200);
    const done = (await ok('chef', 'get', '/api/me/recruitment/interviews?filter=done')).items as Body[];
    expect(done.find((i) => i.id === interview.id)?.evaluation).toMatchObject({ overall: 3.6, recommendation: 'no', comment: 'Mon avis', scores: scoresOf([3, 4, 4, 2, 5]) });
    expect(((await ok('chef', 'get', '/api/me/recruitment/interviews')).items as Body[]).some((i) => i.id === interview.id)).toBe(false);
    expect(JSON.stringify(done.find((i) => i.id === interview.id))).not.toMatch(/AvisDeKarim|strong_yes/);

    // only while the application is in progress: once it is decided the interview is gone, the file too
    await ok('admin', 'post', `/api/recruitment/applications/${a.id}/move`, { toStage: 'withdrawn', expectedStage: 'interview' });
    expect((await call('chef', 'get', `/api/me/recruitment/interviews/${interview.id}`)).status).toBe(404);
    expect(((await ok('chef', 'get', '/api/me/recruitment/interviews?filter=done')).items as Body[]).some((i) => i.id === interview.id)).toBe(false);
    expect((await download('chef', url)).status).toBe(404);
    expect((await evaluate('chef', interview.id, [5])).status).toBe(404);
    // reopened: visible again; cancelled: gone for good
    await ok('admin', 'post', `/api/recruitment/applications/${a.id}/reopen`, { expectedStage: 'withdrawn' });
    expect((await call('chef', 'get', `/api/me/recruitment/interviews/${interview.id}`)).status).toBe(200);
    await ok('admin', 'post', `/api/recruitment/interviews/${interview.id}/cancel`, { reason: 'Annulé' });
    expect((await call('chef', 'get', `/api/me/recruitment/interviews/${interview.id}`)).status).toBe(404);
    expect((await download('chef', url)).status).toBe(404);
  });

  it('an interviewer who has not submitted sees no other evaluation by ANY route (HR view, comparison, board) — then everything', async () => {
    const opening = await openOpening(CNE);
    const a = await apply(opening);
    const interview = await schedule('admin', a.id, ['chef', 'est']);
    expect((await evaluate('chef', interview.id, [2, 3], { recommendation: 'no', comment: 'AvisDuChef' })).status).toBe(200);
    // rh.est holds recruitment.read but still owes their evaluation
    const before = await ok('est', 'get', `/api/recruitment/applications/${a.id}`);
    expect(before.average).toBeNull();
    expect(before.interviews[0]).toMatchObject({ evaluationsHidden: true, average: null });
    expect(before.interviews[0].evaluations.find((e: Body) => e.interviewer.id === USERS.chef.id)).toEqual({ interviewer: { id: USERS.chef.id, displayName: USERS.chef.displayName }, submittedAt: expect.any(String), scores: [], overall: null, recommendation: null, comment: null });
    const hiddenRow = (await ok('est', 'get', `/api/recruitment/openings/${opening}/comparison`)).rows[0];
    expect(hiddenRow).toMatchObject({ applicationId: a.id, hidden: true, average: null, comments: [], recommendations: { strong_yes: 0, yes: 0, no: 0, strong_no: 0 }, evaluations: { submitted: 1, expected: 2 } });
    expect(hiddenRow.criteria.every((c: Body) => c.average === null)).toBe(true);
    const card = (await ok('est', 'get', `/api/recruitment/openings/${opening}/board`)).columns.find((c: Body) => c.stage === 'interview').cards[0];
    expect(card).toMatchObject({ average: null, pendingEvaluations: 1, nextInterviewAt: null });
    expect(JSON.stringify([before, hiddenRow, card])).not.toContain('AvisDuChef');
    // central HR, who evaluates nothing here, sees it all
    expect((await ok('admin', 'get', `/api/recruitment/applications/${a.id}`)).interviews[0]).toMatchObject({ evaluationsHidden: false, average: 2.4, state: 'awaiting_evaluations' });
    // rh.est submits: nothing is hidden any more
    expect((await evaluate('est', interview.id, [4])).status).toBe(200);
    const after = await ok('est', 'get', `/api/recruitment/applications/${a.id}`);
    expect(after.average).toBe(3.2);
    expect(after.interviews[0]).toMatchObject({ evaluationsHidden: false, average: 3.2, state: 'complete' });
    expect(after.interviews[0].evaluations.find((e: Body) => e.interviewer.id === USERS.chef.id)).toMatchObject({ overall: 2.4, recommendation: 'no', comment: 'AvisDuChef' });
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('evaluation rules', () => {
  it('scores 1–5 for every criterion, a recommendation; from the interview’s time, while the application is in interview; one per interviewer, re-submitted in place', async () => {
    const opening = await openOpening(CNE);
    const a = await apply(opening);
    const later = await schedule('admin', a.id, ['chef'], FUTURE);
    const url = `/api/me/recruitment/interviews/${later.id}/evaluation`;
    await problem('chef', 'put', url, { scores: scoresOf([4]), recommendation: 'yes' }, 409, 'recruitment-interview-not-held');
    expect((await ok('chef', 'get', `/api/me/recruitment/interviews/${later.id}`))['_actions']).toEqual([]);
    const held = await schedule('admin', a.id, ['chef', 'est']);
    const put = `/api/me/recruitment/interviews/${held.id}/evaluation`;
    // the body
    for (const score of [0, 6, 2.5, '4']) expect((await call('chef', 'put', put, { scores: criteria.map((criterionId) => ({ criterionId, score })), recommendation: 'yes' })).status, String(score)).toBe(422);
    expect((await call('chef', 'put', put, { scores: scoresOf([4]) })).status).toBe(422);
    expect((await call('chef', 'put', put, { scores: scoresOf([4]), recommendation: 'maybe' })).status).toBe(422);
    expect(errorsOf(await problem('chef', 'put', put, { scores: scoresOf([4]).slice(1), recommendation: 'yes' }, 422, 'validation-error'))).toEqual([['scores', 'incomplete']]);
    expect(errorsOf(await problem('chef', 'put', put, { scores: [...scoresOf([4]).slice(1), { criterionId: USERS.chef.id, score: 3 }], recommendation: 'yes' }, 422, 'validation-error'))).toEqual([['scores', 'unknown']]);
    expect(errorsOf(await problem('chef', 'put', put, { scores: [...scoresOf([4]).slice(0, 4), ...scoresOf([4]).slice(0, 1)], recommendation: 'yes' }, 422, 'validation-error'))).toEqual([['scores', 'unknown']]);
    // somebody who is not one of its interviewers
    for (const actor of ['agent', 'admin', 'ouest', 'beta'] as const) expect((await call(actor, 'put', put, { scores: scoresOf([4]), recommendation: 'yes' })).status, actor).toBe(404);

    // rounding: (5+4+4+4+4)/5 = 4.2; (3+3+3+3+4)/5 = 3.2; the application's average = (4.2 + 3.2) / 2 = 3.7
    const first = await ok('chef', 'put', put, { scores: scoresOf([5, 4, 4, 4, 4]), recommendation: 'strong_yes', comment: '  Très bien.  ' });
    expect(first.evaluation).toMatchObject({ overall: 4.2, recommendation: 'strong_yes', comment: 'Très bien.', submittedAt: expect.any(String) });
    // the scheduler is told only once the LAST expected evaluation is in
    expect(await notificationsOf(USERS.admin.id, held.id)).toEqual([]);
    expect((await evaluate('est', held.id, [3, 3, 3, 3, 4])).status).toBe(200);
    const complete = await notificationsOf(USERS.admin.id, held.id);
    expect(complete.map((n) => n.type)).toEqual(['recruitment.evaluations_complete']);
    expect(Object.keys(complete[0]?.data ?? {}).toSorted()).toEqual(['actorName', 'applicationId', 'audience', 'candidateId', 'date', 'interviewId', 'mode', 'openingId', 'reference', 'time', 'title']);
    const link = ((await ok('admin', 'get', '/api/me/notifications')).items as Body[]).find((n) => n.subject.id === held.id)?.link;
    expect(link).toBe(`/recruitment/candidates/${a.candidate.id}?application=${a.id}`);
    expect((await ok('admin', 'get', `/api/recruitment/applications/${a.id}`)).average).toBe(3.7);
    // one decimal, half up: 3.25 → 3.3 (two interviews: overalls 4.2, 3.2 and — re-submitted — 2.4 → mean 3.2666…)
    const again = await ok('chef', 'put', put, { scores: scoresOf([2, 2, 3, 3, 2]), recommendation: 'no' });
    expect(again.evaluation).toMatchObject({ overall: 2.4, recommendation: 'no', comment: null });
    expect(new Date(again.evaluation.submittedAt).getTime()).toBeGreaterThan(new Date(first.evaluation.submittedAt).getTime());
    expect(await count(`recruitment_interviewer where interview_id = $1`, [held.id])).toBe(2);
    expect(await count(`recruitment_evaluation_score s join recruitment_interviewer w on w.id = s.interviewer_id where w.interview_id = $1`, [held.id])).toBe(10);
    expect((await ok('admin', 'get', `/api/recruitment/applications/${a.id}`)).average).toBe(2.8);
    // a re-submission tells nobody again
    expect(await notificationsOf(USERS.admin.id, held.id)).toHaveLength(1);

    // closed once the application leaves the interview stage (and open again when it returns)
    await ok('admin', 'post', `/api/recruitment/applications/${a.id}/move`, { toStage: 'shortlisted', expectedStage: 'interview' });
    await problem('chef', 'put', put, { scores: scoresOf([5]), recommendation: 'yes' }, 409, 'recruitment-evaluation-closed');
    expect((await ok('chef', 'get', `/api/me/recruitment/interviews/${held.id}`))['_actions']).toEqual([]);
    await ok('admin', 'post', `/api/recruitment/applications/${a.id}/move`, { toStage: 'interview', expectedStage: 'shortlisted' });
    expect((await evaluate('chef', held.id, [5])).status).toBe(200);
    // the database holds the rules too
    await expect(asRole(db.appUrl, `update recruitment_evaluation_score set score = 6 where interviewer_id in (select id from recruitment_interviewer where interview_id = '${held.id}')`)).rejects.toThrow(/recruitment_evaluation_score_score_ck/);
    await expect(asRole(db.appUrl, `insert into recruitment_interviewer (company_id, interview_id, user_id) values ('${COMPANY_A}', '${held.id}', '${USERS.chef.id}')`)).rejects.toThrow(/recruitment_interviewer_once_uk/);
  });

  it('GET /me/recruitment/summary counts the interviews the caller sees and those they can evaluate now', async () => {
    const before = await ok('agent', 'get', '/api/me/recruitment/summary');
    expect(before).toMatchObject({ interviews: 0, evaluationsTodo: 0 });
    const opening = await openOpening(CNE);
    const a = await apply(opening);
    const held = await schedule('admin', a.id, ['agent']);
    await schedule('admin', a.id, ['agent'], FUTURE);
    expect(await ok('agent', 'get', '/api/me/recruitment/summary')).toMatchObject({ canRequestOpening: false, openings: 0, interviews: 2, evaluationsTodo: 1 });
    expect((await evaluate('agent', held.id, [4])).status).toBe(200);
    expect(await ok('agent', 'get', '/api/me/recruitment/summary')).toMatchObject({ interviews: 2, evaluationsTodo: 0 });
    // the HR home counts: interviews in the next 7 days (the demo one, in two days) and offers in progress
    const summary = await ok('admin', 'get', '/api/recruitment/summary');
    expect(summary.interviewsNext7Days).toBeGreaterThanOrEqual(1);
    expect(summary.offersPending).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('the comparison view', () => {
  it('HR: one row per interviewed application — averages per criterion, overall, recommendations, comments; best first', async () => {
    const opening = await openOpening(CNE, 3);
    const strong = await apply(opening, { lastName: 'Bbb', firstName: 'Fort', nin: '277990000000001111', email: 'fort@example.test' }, 'admin', { expectedSalary: '77000' });
    const weak = await apply(opening, { lastName: 'Aaa', firstName: 'Faible' });
    const waiting = await apply(opening, { lastName: 'Ccc', firstName: 'Attente' });
    await apply(opening, { lastName: 'Ddd', firstName: 'SansEntretien' });
    const i1 = await schedule('admin', strong.id, ['chef', 'est'], PAST, { label: 'Technique' });
    await evaluate('chef', i1.id, [5, 5, 4, 4, 5], { recommendation: 'strong_yes', comment: 'Excellent' });
    await evaluate('est', i1.id, [4, 4, 4, 4, 4], { recommendation: 'yes' });
    const i2 = await schedule('admin', weak.id, ['chef']);
    await evaluate('chef', i2.id, [2, 3, 2, 3, 2], { recommendation: 'no', comment: 'Insuffisant' });
    await schedule('admin', waiting.id, ['agent'], FUTURE);

    const view = await ok('admin', 'get', `/api/recruitment/openings/${opening}/comparison`);
    expect(view.opening).toMatchObject({ id: opening, status: 'open', unit: { code: 'AG-CNE' } });
    expect(view.criteria.map((c: Body) => c.id)).toEqual(criteria);
    expect(view.rows.map((r: Body) => [r.candidate.lastName, r.average, r.interviews, r.evaluations])).toEqual([
      ['Bbb', 4.3, 1, { submitted: 2, expected: 2 }],
      ['Aaa', 2.4, 1, { submitted: 1, expected: 1 }],
      ['Ccc', null, 1, { submitted: 0, expected: 1 }],
    ]);
    expect(view.rows[0]).toMatchObject({
      applicationId: strong.id, candidate: { id: strong.candidate.id, lastName: 'Bbb', firstName: 'Fort' }, stage: 'interview', hidden: false,
      criteria: [4.5, 4.5, 4, 4, 4.5].map((average, k) => ({ criterionId: criteria[k], average })),
      recommendations: { strong_yes: 1, yes: 1, no: 0, strong_no: 0 },
    });
    expect(view.rows[0].comments).toEqual(expect.arrayContaining([
      { interviewer: { id: USERS.chef.id, displayName: USERS.chef.displayName }, interviewLabel: 'Technique', recommendation: 'strong_yes', comment: 'Excellent' },
      { interviewer: { id: USERS.est.id, displayName: USERS.est.displayName }, interviewLabel: 'Technique', recommendation: 'yes', comment: null },
    ]));
    expect(view.rows[2]).toMatchObject({ criteria: criteria.map((criterionId) => ({ criterionId, average: null })), comments: [] });
    // nothing but names and evaluations
    const keys = keysOf(view);
    for (const key of ['nin', 'email', 'phone', 'birthDate', 'salary', 'proposed', 'notes', 'files']) expect(keys.has(key), key).toBe(false);
    expect(JSON.stringify(view)).not.toMatch(/1111|fort@example|77000/);

    // per role: regional HR in its region, central HR everywhere, lecture / admin_acces / employees nothing, other tenant 404
    expect((await ok('est', 'get', `/api/recruitment/openings/${opening}/comparison`)).rows).toHaveLength(3);
    for (const actor of ['ouest', 'acces', 'chef', 'agent'] as const) expect((await call(actor, 'get', `/api/recruitment/openings/${opening}/comparison`)).status, actor).toBe(403);
    expect((await call('beta', 'get', `/api/recruitment/openings/${opening}/comparison`)).status).toBe(404);
    expect((await call('est', 'get', `/api/recruitment/openings/${DEMO_OPENINGS.oran}/comparison`)).status).toBe(404);
    // the head's route: rh.est heads Région Est (a unit above) → 200; chef heads another agency → 404; central HR is no head → 404
    expect((await ok('est', 'get', `/api/me/recruitment/openings/${opening}/comparison`)).rows).toHaveLength(3);
    for (const actor of ['chef', 'admin', 'agent', 'ouest'] as const) expect((await call(actor, 'get', `/api/me/recruitment/openings/${opening}/comparison`)).status, actor).toBe(404);
  });

  it('a unit head: the comparison of their own openings, in the restricted view — and without the evaluations of an application they still owe one for', async () => {
    // REC-2026-0001 (Agence Annaba, requested and headed by chef.annaba): application 4 was evaluated by rh.est and chef;
    // application 5 has an interview in two days with chef and rh.admin, nothing submitted
    const view = await ok('chef', 'get', `/api/me/recruitment/openings/${DEMO_OPENINGS.annaba}/comparison`);
    expect(view.rows.map((r: Body) => [r.applicationId, r.average, r.hidden])).toEqual([[demoApplication(4), 4.2, false], [demoApplication(5), null, true]]);
    expect(view.rows[0]).toMatchObject({ evaluations: { submitted: 2, expected: 2 }, recommendations: { strong_yes: 1, yes: 1, no: 0, strong_no: 0 }, criteria: [{ average: 4 }, { average: 4.5 }, { average: 3.5 }, { average: 4.5 }, { average: 4.5 }] });
    expect(view.rows[0].comments).toHaveLength(2);
    const keys = keysOf(view);
    for (const key of ['nin', 'email', 'phone', 'birthDate', 'birthPlace', 'salary', 'proposed', 'notes', 'stages', 'source']) expect(keys.has(key), key).toBe(false);
    expect(JSON.stringify(view)).not.toContain(demoEmployee(25).nin);
    // the head's opening page shows the average and the number of interviews; the HR route stays closed to them
    const detail = await ok('chef', 'get', `/api/me/recruitment/openings/${DEMO_OPENINGS.annaba}`);
    expect((detail.applications as Body[]).find((x) => x.id === demoApplication(5))).toMatchObject({ average: null, interviews: 1 });
    expect((await call('chef', 'get', `/api/recruitment/openings/${DEMO_OPENINGS.annaba}/comparison`)).status).toBe(403);
    // « my interviews » of chef: the one to come is listed, not yet to evaluate
    const todo = (await ok('chef', 'get', '/api/me/recruitment/interviews')).items as Body[];
    expect(todo.find((i) => i.id === demoInterview(2))).toMatchObject({ applicationId: demoApplication(5), _actions: [] });
    // a requester who heads nothing sees no comparison
    expect((await call('admin', 'get', `/api/me/recruitment/openings/${DEMO_OPENINGS.oran}/comparison`)).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('offers', () => {
  it('make, edit, decline, cancel: recorded only; the unit is the opening’s or a sub-unit; the proposed salary behind its permissions', async () => {
    const opening = await openOpening(ANNABA, 3);
    const a = await apply(opening);
    const url = `/api/recruitment/applications/${a.id}/offer`;
    const body = offerBody(ANNABA, { expectedStage: 'received' });
    // the move endpoint never makes an offer
    expect(errorsOf(await problem('admin', 'post', `/api/recruitment/applications/${a.id}/move`, { toStage: 'offer', expectedStage: 'received' }, 422, 'validation-error'))).toEqual([['toStage', 'not_allowed']]);
    // body and place
    expect((await call('admin', 'post', url, { ...body, jobTitle: '' })).status).toBe(422);
    expect((await call('admin', 'post', url, { ...body, startDate: 'demain' })).status).toBe(422);
    expect(errorsOf(await problem('admin', 'post', url, { ...body, expectedStage: 'offer' }, 422, 'validation-error'))).toEqual([['expectedStage', 'not_allowed']]);
    expect(errorsOf(await problem('admin', 'post', url, { ...body, orgUnitId: CNE }, 422, 'validation-error'))).toEqual([['orgUnitId', 'outside_opening']]);
    expect(errorsOf(await problem('admin', 'post', url, { ...body, orgUnitId: USERS.admin.id }, 422, 'validation-error'))).toEqual([['orgUnitId', 'not_found']]);
    expect(errorsOf(await problem('admin', 'post', url, { ...body, siteId: USERS.admin.id }, 422, 'validation-error'))).toEqual([['siteId', 'not_found']]);
    // permission: recruitment.hire (central and regional HR); lecture, admin_acces, heads and employees are refused
    for (const actor of ['ouest', 'acces', 'chef', 'agent'] as const) expect((await call(actor, 'post', url, body)).status, actor).toBe(403);
    expect((await call('beta', 'post', url, body)).status).toBe(404);
    // regional HR runs it without the salary …
    expect(errorsOf(await problem('est', 'post', url, { ...body, proposedSalary: '70000' }, 403, 'forbidden-field'))).toEqual([['proposedSalary', 'forbidden']]);
    await problem('admin', 'post', url, { ...body, expectedStage: 'interview' }, 409, 'recruitment-stage-changed');
    const made = await ok('est', 'post', url, { ...body, orgUnitId: unitA('SRV-CLI-ANB'), note: 'Sous réserve du diplôme' }, 201);
    expect(made).toMatchObject({ stage: 'offer', _redacted: ['salary'], moveTargets: ['rejected'], _actions: ['move', 'add_note', 'update', 'update_offer', 'decline_offer', 'cancel_offer', 'hire'] });
    expect(made.salary).toBeUndefined();
    expect(made.offer).toMatchObject({ jobTitle: 'Chargé(e) de clientèle', unit: { code: 'SRV-CLI-ANB' }, contractType: 'cdi', startDate: '2026-11-02', note: 'Sous réserve du diplôme', status: 'proposed', decidedAt: null, createdBy: { id: USERS.est.id } });
    expect(made.stages.at(-1)).toMatchObject({ from: 'received', to: 'offer', autoCause: null });
    // … which central HR enters and reads
    expect(errorsOf(await problem('est', 'put', url, { proposedSalary: '70000' }, 403, 'forbidden-field'))).toEqual([['proposedSalary', 'forbidden']]);
    const edited = await ok('admin', 'put', url, { jobTitle: 'Conseiller clientèle', orgUnitId: ANNABA, siteId: null, contractType: 'cdd', startDate: '2026-12-01', note: null, proposedSalary: '70500.50' });
    expect(edited.offer).toMatchObject({ jobTitle: 'Conseiller clientèle', unit: { code: 'AG-ANNABA' }, contractType: 'cdd', startDate: '2026-12-01', note: null, status: 'proposed' });
    expect(edited.salary).toEqual({ expected: null, proposed: '70500.50' });
    expect(edited['_actions']).toContain('update_salary');
    const asEst = await ok('est', 'get', `/api/recruitment/applications/${a.id}`);
    expect(asEst.salary).toBeUndefined();
    expect(JSON.stringify(asEst)).not.toContain('70500');
    // a partial edit keeps the rest; the timeline tells a reader without the salary permission nothing about it
    expect((await ok('est', 'put', url, { note: 'Diplôme reçu' })).offer).toMatchObject({ note: 'Diplôme reçu', jobTitle: 'Conseiller clientèle', startDate: '2026-12-01' });
    expect((await ok('admin', 'get', `/api/recruitment/applications/${a.id}`)).salary).toEqual({ expected: null, proposed: '70500.50' });
    const types = async (actor: ActorName) => ((await ok(actor, 'get', `/api/audit/timeline?subject=recruitment_application:${a.id}`)).items as Body[]).map((e) => e.event?.type);
    expect(await types('admin')).toEqual(expect.arrayContaining(['recruitment.offer_made', 'recruitment.offer_updated', 'recruitment.salary_changed']));
    expect(await types('est')).not.toContain('recruitment.salary_changed');
    expect(errorsOf(await problem('admin', 'put', url, { orgUnitId: ORAN }, 422, 'validation-error'))).toEqual([['orgUnitId', 'outside_opening']]);

    // cancel: HR takes it back → interview, the offer cancelled; a new one can follow
    expect(errorsOf(await problem('admin', 'post', `${url}/cancel`, { expectedStage: 'interview' }, 422, 'validation-error'))).toEqual([['expectedStage', 'not_allowed']]);
    for (const actor of ['ouest', 'chef'] as const) expect((await call(actor, 'post', `${url}/cancel`, { expectedStage: 'offer' })).status, actor).toBe(403);
    const cancelled = await ok('est', 'post', `${url}/cancel`, { expectedStage: 'offer', comment: 'Poste redéfini' });
    expect(cancelled).toMatchObject({ stage: 'interview', offer: { status: 'cancelled', decidedAt: expect.any(String) } });
    expect(cancelled.stages.at(-1)).toMatchObject({ from: 'offer', to: 'interview', comment: 'Poste redéfini' });
    await problem('admin', 'post', `${url}/cancel`, { expectedStage: 'offer' }, 409, 'recruitment-stage-changed');
    await problem('admin', 'put', url, { note: 'x' }, 409, 'recruitment-no-offer');
    await problem('admin', 'get', `/api/recruitment/applications/${a.id}/hire-prefill`, undefined, 409, 'recruitment-stage-changed');
    // decline: the person turned it down → withdrawn
    const again = await ok('admin', 'post', url, { ...body, expectedStage: 'interview', proposedSalary: '71000' }, 201);
    expect(again.offer.id).not.toBe(made.offer.id);
    const declined = await ok('admin', 'post', `${url}/decline`, { expectedStage: 'offer', comment: 'A accepté ailleurs' });
    expect(declined).toMatchObject({ stage: 'withdrawn', decidedAt: expect.any(String), offer: { status: 'declined' }, moveTargets: [] });
    expect(declined['_actions']).toEqual(['reopen', 'add_note', 'update', 'update_salary']);
    expect(await count(`recruitment_offer where application_id = $1`, [a.id])).toBe(2);
    // the audit knows offers were made and ended — never an amount, a title or a comment
    const events = await query<{ type: string; data: Body }>(db.superuserUrl, `select type, data from audit.event where subject_id = $1 and type like 'recruitment.offer%' order by id`, [a.id]);
    expect(events.map((e) => e.type)).toEqual(['recruitment.offer_made', 'recruitment.offer_updated', 'recruitment.offer_updated', 'recruitment.offer_cancelled', 'recruitment.offer_made', 'recruitment.offer_declined']);
    expect(JSON.stringify(events)).not.toMatch(/70500|71000|Conseiller|Diplôme|ailleurs/);
  });

  it('offers in progress + hires never exceed the posts; a rejected or closed application frees its offer', async () => {
    const opening = await openOpening(CNE, 2);
    const [a, b, c] = [await apply(opening), await apply(opening), await apply(opening)];
    const offer = (id: string) => makeOffer('admin', id, offerBody(CNE, { expectedStage: 'received' }));
    expect((await offer(a.id)).status).toBe(201);
    expect((await ok('admin', 'get', `/api/recruitment/applications/${b.id}`))['_actions']).toContain('make_offer');
    expect((await offer(b.id)).status).toBe(201);
    // two posts, two offers: no third one — and the action is no longer offered
    expect(((await offer(c.id)).body as Body).type).toBe(PROBLEM('recruitment-no-post-left'));
    expect((await ok('admin', 'get', `/api/recruitment/applications/${c.id}`))['_actions']).not.toContain('make_offer');
    const cards = (await ok('admin', 'get', `/api/recruitment/openings/${opening}/board`)).columns.flatMap((col: Body) => col.cards) as Body[];
    expect(cards.find((x) => x.id === c.id)?.['_actions']).toEqual(['move', 'schedule_interview']);
    expect(cards.find((x) => x.id === a.id)?.['_actions']).toEqual(['move', 'hire']);
    // lowering the posts below what is promised is refused
    expect(errorsOf(await problem('admin', 'patch', `/api/recruitment/openings/${opening}`, { posts: 1 }, 422, 'validation-error'))).toEqual([['posts', 'below_offers']]);
    // rejecting an application under offer cancels its offer: the post is free again
    const reason = (await one<{ id: string }>(`select id from recruitment_rejection_reason where company_id = $1 and code = 'other'`, [COMPANY_A])).id;
    const rejected = await ok('admin', 'post', `/api/recruitment/applications/${a.id}/move`, { toStage: 'rejected', expectedStage: 'offer', rejectionReasonId: reason });
    expect(rejected.offer).toMatchObject({ status: 'cancelled' });
    expect((await offer(c.id)).status).toBe(201);
    // one hire, one offer left: still no room; reopening the rejected one lands in `interview`, its offer stays cancelled
    expect((await hire('admin', b.id, hireBody(CNE))).status).toBe(201);
    expect((await ok('admin', 'post', `/api/recruitment/applications/${a.id}/reopen`, { expectedStage: 'rejected' })).stage).toBe('interview');
    expect(((await makeOffer('admin', a.id, offerBody(CNE))).body as Body).type).toBe(PROBLEM('recruitment-no-post-left'));
    // closing the opening rejects the one under offer and cancels its offer
    await ok('admin', 'post', `/api/recruitment/openings/${opening}/close`, { reason: 'Gel des embauches' });
    expect(await ok('admin', 'get', `/api/recruitment/applications/${c.id}`)).toMatchObject({ stage: 'rejected', rejectionReason: { code: 'opening_closed' }, offer: { status: 'cancelled' } });
    expect(await count(`recruitment_offer f join recruitment_application x on x.id = f.application_id where x.opening_id = $1 and f.status = 'proposed'`, [opening])).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('hire', () => {
  const CV = demoPdf('TEST DATA - CV embauche');
  const DIPLOMA = demoLogoPng();

  it('the hire of a new person: the employee with the form’s values, the application hired, the offer accepted, the files in the employee file — one transaction', async () => {
    const opening = await openOpening(CNE, 2);
    const a = await offered(opening, CNE, { lastName: 'Benali', firstName: 'Samir', lastNameAr: 'بن علي', firstNameAr: 'سمير', birthDate: '1993-03-03', birthPlace: 'Constantine', sex: 'M', nin: '193990000000008801', email: 'samir.benali@example.test' }, { proposedSalary: '64000.00', startDate: '2026-11-15' });
    const cv = (await upload('admin', a.candidate.id, CV, { kind: 'cv', title: 'CV de Samir' }, 'cv samir.pdf').expect(201)).body as Body;
    const diploma = (await upload('admin', a.candidate.id, DIPLOMA, { kind: 'diploma', title: 'Licence' }, 'licence.png').expect(201)).body as Body;

    // the prefill: the candidate, the offer, the proposed salary for who may read it AND set an employee's
    const url = `/api/recruitment/applications/${a.id}`;
    const prefill = await ok('admin', 'get', `${url}/hire-prefill`);
    expect(prefill).toMatchObject({
      person: { personId: null, lastName: 'Benali', firstName: 'Samir', lastNameAr: 'بن علي', firstNameAr: 'سمير', birthDate: '1993-03-03', birthPlace: 'Constantine', sex: 'M', nationality: 'DZ', nin: '193990000000008801' },
      knownPerson: null, orgUnitId: CNE, siteId: null, jobTitle: 'Chargé(e) de clientèle', hireDate: '2026-11-15', salary: { baseSalary: '64000.00' },
      defaultCopyFileIds: [cv.id], opening: { id: opening, status: 'open' }, expectedStage: 'offer', candidateId: a.candidate.id,
    });
    expect(prefill.files.map((f: Body) => f.id).toSorted()).toEqual([cv.id, diploma.id].toSorted());
    expect((await ok('est', 'get', `${url}/hire-prefill`)).salary).toBeUndefined();
    for (const actor of ['ouest', 'acces', 'chef', 'agent'] as const) {
      expect((await call(actor, 'get', `${url}/hire-prefill`)).status, actor).toBe(403);
      expect((await hire(actor, a.id, hireBody(CNE))).status, actor).toBe(403);
    }
    expect((await hire('beta', a.id, hireBody(CNE))).status).toBe(404);

    // the body is POST /employees' own: its 422s apply as they are
    const body = hireBody(CNE, { lastName: 'Benali', firstName: 'Samir', lastNameAr: 'بن علي', firstNameAr: 'سمير', birthDate: '1993-03-03', birthPlace: 'Constantine', sex: 'M', nin: '193990000000008801', matricule: 'rec-b-samir', hireDate: '2026-11-15', jobTitle: 'Chargé de clientèle', salary: { baseSalary: '64000.00' }, nss: { nss: '930303000188' }, copyFileIds: [cv.id, diploma.id] });
    const before = await snapshot();
    expect(errorsOf((await hire('admin', a.id, { ...body, lastName: undefined, matricule: 'bad matricule!' })).body as Body).toSorted()).toEqual([['lastName', 'custom'], ['matricule', 'custom']]);
    expect(errorsOf(await problem('admin', 'post', `${url}/hire`, { ...body, expectedStage: 'interview' }, 422, 'validation-error'))).toEqual([['expectedStage', 'not_allowed']]);
    expect(errorsOf(await problem('admin', 'post', `${url}/hire`, { ...body, copyFileIds: [cv.id, USERS.admin.id, cv.id] }, 422, 'validation-error'))).toEqual([['copyFileIds.1', 'not_found'], ['copyFileIds.2', 'duplicate']]);
    expect((await call('admin', 'post', `${url}/hire`, { ...body, copyFileIds: Array.from({ length: 6 }, () => cv.id) })).status).toBe(422);
    expect(errorsOf(await problem('admin', 'post', `${url}/hire`, { ...body, lastName: undefined, firstName: undefined, lastNameAr: undefined, firstNameAr: undefined, birthDate: undefined, birthPlace: undefined, sex: undefined, nin: undefined, personId: demoEmployee(25).personId }, 422, 'validation-error'))).toEqual([['personId', 'not_linked']]);
    expect(await snapshot()).toEqual(before);

    const res = await hire('admin', a.id, body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { employee, application, opening: openingView } = res.body as Body;
    expect(res.headers['location']).toBe(`/api/employees/${employee.id}`);
    expect(employee).toMatchObject({
      matricule: 'REC-B-SAMIR', person: { lastName: 'Benali', firstName: 'Samir', lastNameAr: 'بن علي', birthDate: '1993-03-03', nin: '193990000000008801' }, unit: { code: 'AG-CNE' },
      jobTitle: 'Chargé de clientèle', hireDate: '2026-11-15', endDate: null, salary: { history: [{ baseSalary: '64000.00', validFrom: '2026-11-15' }] }, nss: { nss: '930303000188' },
    });
    expect(application).toMatchObject({ id: a.id, stage: 'hired', decidedAt: expect.any(String), offer: { status: 'accepted' }, employment: { id: employee.id, matricule: 'REC-B-SAMIR' }, moveTargets: [] });
    expect(application.stages.at(-1)).toMatchObject({ from: 'offer', to: 'hired', by: { id: USERS.admin.id }, autoCause: null });
    expect(application['_actions']).toEqual(['add_note', 'update', 'update_salary', 'undo_hire']);
    expect(application.candidate.knownPerson).toMatchObject({ personId: employee.person.id, linked: true, latestEmployment: { id: employee.id, matricule: 'REC-B-SAMIR' } });
    expect(openingView).toMatchObject({ id: opening, status: 'open', posts: 2, hiredCount: 1, counts: { hired: 1, total: 1 } });
    // the employee exists for good, as POST /employees would have made it
    expect(await ok('admin', 'get', `/api/employees/${employee.id}`)).toMatchObject({ matricule: 'REC-B-SAMIR', status: expect.any(String), person: { id: employee.person.id } });
    expect(await snapshot()).toEqual({ persons: before.persons + 1, employments: before.employments + 1, assignments: before.assignments + 1, salaries: before.salaries + 1, files: before.files + 2, hired: before.hired + 1 });

    // the chosen files, in the employee file under the system category « Recrutement », byte for byte
    const files = (await ok('admin', 'get', `/api/employees/${employee.id}/files`)).items as Body[];
    expect(files.map((f) => [f.category.code, f.title, f.originalFilename, f.mime, f.sizeBytes, f.uploadedBy.id]).toSorted()).toEqual([
      ['recruitment', 'CV de Samir', 'cv samir.pdf', 'application/pdf', CV.length, USERS.admin.id],
      ['recruitment', 'Licence', 'licence.png', 'image/png', DIPLOMA.length, USERS.admin.id],
    ].toSorted());
    for (const [title, bytes] of [['CV de Samir', CV], ['Licence', DIPLOMA]] as const) {
      const file = files.find((f) => f.title === title);
      expect(file?.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
      const got = await download('admin', `/api/employees/${employee.id}/files/${file?.id}/content`);
      expect(got.status).toBe(200);
      expect(Buffer.compare(got.body as Buffer, bytes)).toBe(0);
    }
    // the candidate's own files are untouched (they go with the purge, 12 months later)
    expect((await ok('admin', 'get', `/api/recruitment/candidates/${a.candidate.id}`)).files).toHaveLength(2);
    // the employee's history says where they came from; the application's that it was hired
    const timeline = (await ok('admin', 'get', `/api/audit/timeline?subject=employee:${employee.id}`)).items as Body[];
    const hired = timeline.find((e) => e.event?.type === 'recruitment.hired');
    expect(hired?.event.data).toEqual({ openingId: opening, applicationId: a.id, reference: openingView.reference });
    expect((await query<{ data: Body }>(db.superuserUrl, `select data from audit.event where subject_id = $1 and type = 'recruitment.stage_changed' order by id desc limit 1`, [a.id]))[0]?.data).toEqual({ from: 'offer', to: 'hired', reasonCode: null, autoCause: null });
    // regional HR sees the link (employee.read in its region); a hired application takes no other action
    expect((await ok('est', 'get', url)).employment).toEqual({ id: employee.id, matricule: 'REC-B-SAMIR' });
    await problem('admin', 'post', `${url}/hire`, hireBody(CNE), 409, 'recruitment-stage-changed');
    await problem('admin', 'post', `${url}/offer/decline`, { expectedStage: 'offer' }, 409, 'recruitment-stage-changed');
    expect(errorsOf(await problem('admin', 'post', `${url}/move`, { toStage: 'rejected', expectedStage: 'hired', rejectionReasonId: USERS.admin.id }, 422, 'validation-error'))).toEqual([['toStage', 'not_allowed']]);
  });

  it('atomicity: a taken matricule, a taken NIN, a unit out of scope, a failing file copy — each leaves NOTHING behind', async () => {
    const opening = await openOpening(CNE, 2);
    const a = await offered(opening, CNE, { lastName: 'Atomique', firstName: 'Test', nin: '191990000000005501' });
    const cv = (await upload('admin', a.candidate.id, demoPdf('TEST DATA - CV atomique')).expect(201)).body as Body;
    const url = `/api/recruitment/applications/${a.id}`;
    const before = await snapshot();
    const state = async () => ({
      ...(await snapshot()),
      ...(await one<{ stage: string; employment_id: string | null; person_id: string | null; offer: string; hired_count: number; status: string; stages: number }>(
        `select x.stage, x.employment_id, c.person_id, (select f.status from recruitment_offer f where f.application_id = x.id) as offer, o.hired_count, o.status,
                (select count(*)::int from recruitment_application_stage s where s.application_id = x.id) as stages
           from recruitment_application x join recruitment_candidate c on c.id = x.candidate_id join recruitment_opening o on o.id = x.opening_id where x.id = $1`,
        [a.id],
      )),
    });
    const untouched = { ...before, stage: 'offer', employment_id: null, person_id: null, offer: 'proposed', hired_count: 0, status: 'open', stages: 2 };
    expect(await state()).toEqual(untouched);
    const body = (extra: object = {}) => hireBody(CNE, { lastName: 'Atomique', firstName: 'Test', nin: '191990000000005501', copyFileIds: [cv.id], ...extra });

    // a matricule already used: the person row was already inserted when the check fails — and is rolled back with the rest
    expect(errorsOf(await problem('admin', 'post', `${url}/hire`, body({ matricule: 'EMP-0027' }), 409, 'matricule-taken'))).toEqual([['matricule', 'matricule_taken']]);
    expect(await state()).toEqual(untouched);
    // a NIN already recorded for another person
    expect(errorsOf(await problem('admin', 'post', `${url}/hire`, body({ nin: demoEmployee(27).nin }), 409, 'nin-taken'))).toEqual([['nin', 'nin_taken']]);
    expect(await state()).toEqual(untouched);
    // a unit outside employee.create: regional HR hiring into Région Ouest; and a sensitive block without its permission
    expect(errorsOf(await problem('est', 'post', `${url}/hire`, body({ orgUnitId: ORAN }), 403, 'forbidden-scope'))).toEqual([['orgUnitId', 'forbidden_scope']]);
    expect(errorsOf(await problem('est', 'post', `${url}/hire`, body({ salary: { baseSalary: '50000' } }), 403, 'forbidden-field'))).toEqual([['salary', 'forbidden_field']]);
    expect(errorsOf(await problem('admin', 'post', `${url}/hire`, body({ orgUnitId: USERS.admin.id }), 422, 'validation-error'))).toEqual([['orgUnitId', 'not_found']]);
    expect(await state()).toEqual(untouched);
    // the copy into the employee file fails AFTER the employee was created (the system category is gone): 500, and
    // no employee, no file, no stage change, no count
    const rename = async (from: string, to: string) => {
      const pg = new Client({ connectionString: db.superuserUrl });
      await pg.connect();
      try {
        await pg.query(`begin; set local session_replication_role = replica; update employee_file_category set code = '${to}' where company_id = '${COMPANY_A}' and code = '${from}'; commit`);
      } finally {
        await pg.end();
      }
    };
    await rename('recruitment', 'recruitment_off');
    try {
      const failed = await hire('admin', a.id, body());
      expect(failed.status).toBe(500);
      expect(await state()).toEqual(untouched);
      expect(await count(`person where nin = '191990000000005501'`)).toBe(0);
    } finally {
      await rename('recruitment_off', 'recruitment');
    }
    // a custom role holding recruitment.hire WITHOUT employee.create: the hire is POST /employees' own 403
    await query(db.superuserUrl, `insert into role_permission (company_id, role_id, permission_code) select $1, $2, c from unnest(array['recruitment.read', 'recruitment.hire']) c on conflict do nothing`, [COMPANY_A, fx.customA]);
    const migrator = createDatabase({ connectionString: db.migratorUrl, maxConnections: 1 });
    try {
      await seedGrants(migrator, COMPANY_A, [{ id: '0190a5d0-0000-7000-8000-000000000f77', userId: USERS.newbie.id, roleCode: 'custom_a', orgUnitId: unitA('DG'), includeDescendants: true, validFrom: '2026-01-01' }]);
    } finally {
      await migrator.destroy();
    }
    expect((await ok('newbie', 'get', url))['_actions']).toEqual(['update_offer', 'decline_offer', 'cancel_offer']);
    expect(errorsOf(await problem('newbie', 'post', `${url}/hire`, body(), 403, 'forbidden-scope'))).toEqual([['orgUnitId', 'forbidden_scope']]);
    expect(await state()).toEqual(untouched);
    // the same request, corrected, goes through — the application was still under offer all along
    expect((await hire('admin', a.id, body())).status).toBe(201);
    expect(await state()).toMatchObject({ stage: 'hired', offer: 'accepted', hired_count: 1, status: 'open', persons: before.persons + 1, files: before.files + 1, hired: before.hired + 1 });
  });

  it('the last post fills the opening: the other applications in progress are closed, their interviews to come cancelled and the interviewers told; the undo restores all of it', async () => {
    const opening = await openOpening(CNE, 1);
    const winner = await offered(opening, CNE, { lastName: 'Gagnant', firstName: 'Dernier' });
    const interviewed = await apply(opening, { lastName: 'Zzperdant', firstName: 'Entretien' });
    const received = await apply(opening, { lastName: 'Recu', firstName: 'Seulement' });
    const withdrawn = await apply(opening);
    await ok('admin', 'post', `/api/recruitment/applications/${withdrawn.id}/move`, { toStage: 'withdrawn', expectedStage: 'received' });
    const future = await schedule('admin', interviewed.id, ['chef'], FUTURE);
    const held = await schedule('admin', interviewed.id, ['chef']);
    const url = `/api/recruitment/applications/${winner.id}`;

    const res = await hire('est', winner.id, hireBody(CNE, { matricule: 'REC-B-LAST', hireDate: '2026-10-05' }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const employee = (res.body as Body).employee;
    expect((res.body as Body).opening).toMatchObject({ status: 'filled', posts: 1, hiredCount: 1, closed: { by: null, reason: null }, counts: { hired: 1, rejected: 2, withdrawn: 1, total: 4 }, _actions: [] });
    for (const id of [interviewed.id, received.id]) {
      const closed = await ok('admin', 'get', `/api/recruitment/applications/${id}`);
      expect(closed).toMatchObject({ stage: 'rejected', rejectionReason: { code: 'position_filled' }, moveTargets: [] });
      expect(closed.stages.at(-1)).toMatchObject({ to: 'rejected', autoCause: 'opening_filled', by: { id: USERS.est.id } });
    }
    // the interview to come is cancelled (« Poste pourvu »), the one already held is kept; chef is told
    const interviews = (await ok('admin', 'get', `/api/recruitment/applications/${interviewed.id}`)).interviews as Body[];
    expect(interviews.map((i) => [i.id, i.status, i.cancelReason])).toEqual([[held.id, 'scheduled', null], [future.id, 'cancelled', 'Poste pourvu']]);
    const told = await notificationsOf(USERS.chef.id, future.id);
    expect(told.map((n) => n.type)).toEqual(['recruitment.interview_assigned', 'recruitment.interview_cancelled']);
    expect(JSON.stringify(told)).not.toMatch(/Zzperdant|Gagnant/);
    expect((await call('chef', 'get', `/api/me/recruitment/interviews/${held.id}`)).status).toBe(404);
    // nothing more happens on a filled opening
    await problem('admin', 'post', `/api/recruitment/openings/${opening}/applications`, { candidate: { lastName: 'Trop', firstName: 'Tard' }, source: 'other' }, 409, 'recruitment-opening-not-open');

    // undo: the employment must be ended first (employments are never deleted)
    expect((await call('admin', 'post', `${url}/undo-hire`, { reason: 'x' })).status).toBe(422);
    for (const actor of ['ouest', 'acces', 'chef', 'agent'] as const) expect((await call(actor, 'post', `${url}/undo-hire`, { reason: 'Erreur de saisie' })).status, actor).toBe(403);
    await problem('admin', 'post', `${url}/undo-hire`, { reason: 'Erreur de saisie' }, 409, 'recruitment-employment-open');
    await problem('admin', 'post', `/api/recruitment/applications/${received.id}/undo-hire`, { reason: 'Erreur de saisie' }, 409, 'recruitment-stage-changed');
    await ok('admin', 'post', `/api/employees/${employee.id}/end`, { endDate: '2026-10-06', reason: 'other' });
    const undone = await ok('est', 'post', `${url}/undo-hire`, { reason: 'XqMotif : jamais présenté' });
    expect(undone).toMatchObject({ stage: 'offer', decidedAt: null, employment: null, offer: { status: 'proposed', decidedAt: null } });
    expect(undone.stages.at(-1)).toMatchObject({ from: 'hired', to: 'offer', autoCause: 'hire_undone', comment: 'XqMotif : jamais présenté' });
    expect(undone['_actions']).toEqual(expect.arrayContaining(['update_offer', 'decline_offer', 'cancel_offer', 'hire']));
    // the opening is open again, without a hire; the applications the fill had closed are back in their stage — and
    // only those (the one withdrawn before stays withdrawn; the cancelled interview stays cancelled)
    expect(await ok('admin', 'get', `/api/recruitment/openings/${opening}`)).toMatchObject({ status: 'open', hiredCount: 0, closed: null, counts: { offer: 1, interview: 1, received: 1, withdrawn: 1, rejected: 0, hired: 0 } });
    expect((await ok('admin', 'get', `/api/recruitment/applications/${interviewed.id}`)).stages.at(-1)).toMatchObject({ from: 'rejected', to: 'interview', autoCause: 'hire_undone' });
    expect(await ok('admin', 'get', `/api/recruitment/applications/${received.id}`)).toMatchObject({ stage: 'received', decidedAt: null, rejectionReason: null });
    expect((await ok('admin', 'get', `/api/recruitment/applications/${withdrawn.id}`)).stage).toBe('withdrawn');
    expect(((await ok('admin', 'get', `/api/recruitment/applications/${interviewed.id}`)).interviews as Body[]).map((i) => i.status)).toEqual(['scheduled', 'cancelled']);
    expect((await call('chef', 'get', `/api/me/recruitment/interviews/${held.id}`)).status).toBe(200);
    // both events are on the employee's history; the employment and its person are still there
    const types = ((await ok('admin', 'get', `/api/audit/timeline?subject=employee:${employee.id}`)).items as Body[]).map((e) => e.event?.type);
    expect(types).toEqual(expect.arrayContaining(['recruitment.hired', 'recruitment.hire_undone']));
    expect(await ok('admin', 'get', `/api/employees/${employee.id}`)).toMatchObject({ endDate: '2026-10-06' });
    await problem('admin', 'post', `${url}/undo-hire`, { reason: 'Deux fois' }, 409, 'recruitment-stage-changed');

    // from the offer, HR hires again: now a REHIRE of the linked person — the person fields are no longer accepted
    const prefill = await ok('admin', 'get', `${url}/hire-prefill`);
    expect(prefill).toMatchObject({ person: { personId: employee.person.id }, knownPerson: { personId: employee.person.id, linked: true, hasOpenEmployment: false } });
    expect(errorsOf(await problem('admin', 'post', `${url}/hire`, hireBody(CNE), 422, 'validation-error'))).toEqual([['personId', 'required']]);
    const rehire = { personId: employee.person.id, matricule: 'REC-B-LAST2', hireDate: '2026-11-01', orgUnitId: CNE, jobTitle: 'Agent', expectedStage: 'offer', copyFileIds: [] };
    expect(errorsOf(await problem('admin', 'post', `${url}/hire`, { ...rehire, hireDate: '2026-10-06' }, 409, 'hire-date'))).toEqual([['hireDate', 'hire_date']]);
    const again = await hire('admin', winner.id, rehire);
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    expect((again.body as Body).employee).toMatchObject({ matricule: 'REC-B-LAST2', person: { id: employee.person.id, lastName: employee.person.lastName } });
    expect((again.body as Body).employee.id).not.toBe(employee.id);
    expect((again.body as Body).opening).toMatchObject({ status: 'filled', hiredCount: 1 });
    expect(await count(`employment where person_id = $1`, [employee.person.id])).toBe(2);
  });

  it('a candidate linked to a former employee is hired as a rehire of that person; one who is still employed is not hired at all', async () => {
    const opening = await openOpening(CNE, 3);
    const former = demoEmployee(25); // Agence Constantine, resigned 2026-06-30, not rehired
    const a = await offered(opening, CNE, { lastName: former.lastName, firstName: former.firstName });
    await ok('admin', 'put', `/api/recruitment/candidates/${a.candidate.id}/person`, { personId: former.personId });
    const url = `/api/recruitment/applications/${a.id}`;
    expect(await ok('admin', 'get', `${url}/hire-prefill`)).toMatchObject({ person: { personId: former.personId }, knownPerson: { linked: true, hasOpenEmployment: false, latestEmployment: { matricule: 'EMP-0025', endDate: '2026-06-30' } } });
    const rehire = (extra: object = {}) => ({ personId: former.personId, matricule: `REC-B-R${++seq}`, hireDate: '2026-11-01', orgUnitId: CNE, jobTitle: 'Chargé de clientèle', expectedStage: 'offer', copyFileIds: [], ...extra });
    const persons = await count('person');
    expect(errorsOf(await problem('admin', 'post', `${url}/hire`, hireBody(CNE, { lastName: former.lastName, firstName: former.firstName }), 422, 'validation-error'))).toEqual([['personId', 'required']]);
    expect(errorsOf(await problem('admin', 'post', `${url}/hire`, rehire({ personId: demoEmployee(24).personId }), 422, 'validation-error'))).toEqual([['personId', 'mismatch']]);
    expect(errorsOf((await hire('admin', a.id, rehire({ lastName: 'Interdit' }))).body as Body)).toEqual([['lastName', 'custom']]);
    // POST /employees' own rehire rule: the new hire date follows the previous end
    expect(errorsOf(await problem('admin', 'post', `${url}/hire`, rehire({ hireDate: '2026-06-30' }), 409, 'hire-date'))).toEqual([['hireDate', 'hire_date']]);
    const res = await hire('est', a.id, rehire());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((res.body as Body).employee).toMatchObject({ person: { id: former.personId, lastName: former.lastName, nin: former.nin }, hireDate: '2026-11-01' });
    expect(await count('person')).toBe(persons);
    expect(await count(`employment where person_id = $1`, [former.personId])).toBe(2);

    // still employed (EMP-0027, active): internal mobility is not a hire
    const employed = demoEmployee(27);
    const b = await offered(opening, CNE, { lastName: employed.lastName, firstName: employed.firstName });
    await ok('admin', 'put', `/api/recruitment/candidates/${b.candidate.id}/person`, { personId: employed.personId });
    expect(errorsOf(await problem('admin', 'post', `/api/recruitment/applications/${b.id}/hire`, rehire({ personId: employed.personId }), 409, 'recruitment-person-employed'))).toEqual([['personId', 'employed']]);
    expect(await count(`employment where person_id = $1`, [employed.personId])).toBe(1);
    expect((await ok('admin', 'get', `/api/recruitment/applications/${b.id}`)).stage).toBe('offer');
  });

  it('two concurrent hires for the last post: one wins, the other gets 409 and creates nothing', async () => {
    // two different applications under offer, one post left
    const opening = await openOpening(CNE, 2);
    const a = await offered(opening, CNE, { lastName: 'Course', firstName: 'Un' });
    const b = await offered(opening, CNE, { lastName: 'Course', firstName: 'Deux' });
    await query(db.superuserUrl, `update recruitment_opening set posts = 1 where id = $1`, [opening]);
    const employments = await count('employment');
    const results = await Promise.all([hire('admin', a.id, hireBody(CNE)), hire('est', b.id, hireBody(CNE))]);
    expect(results.map((r) => r.status).toSorted()).toEqual([201, 409]);
    const lost = results.find((r) => r.status === 409);
    expect(['recruitment-stage-changed', 'recruitment-opening-not-open', 'recruitment-no-post-left'].map(PROBLEM)).toContain(((lost?.body ?? {}) as Body).type);
    expect(await count('employment')).toBe(employments + 1);
    expect(await ok('admin', 'get', `/api/recruitment/openings/${opening}`)).toMatchObject({ status: 'filled', hiredCount: 1, counts: { hired: 1, rejected: 1, total: 2 } });
    expect(await count(`recruitment_application where opening_id = $1 and employment_id is not null`, [opening])).toBe(1);

    // the same application hired twice at once (a double click, two HR users)
    const single = await openOpening(CNE, 1);
    const c = await offered(single, CNE);
    const twice = await Promise.all([hire('admin', c.id, hireBody(CNE)), hire('admin', c.id, hireBody(CNE))]);
    expect(twice.map((r) => r.status).toSorted()).toEqual([201, 409]);
    expect(((twice.find((r) => r.status === 409)?.body ?? {}) as Body).type).toBe(PROBLEM('recruitment-stage-changed'));
    expect(await count('employment')).toBe(employments + 2);
    expect(await ok('admin', 'get', `/api/recruitment/openings/${single}`)).toMatchObject({ status: 'filled', hiredCount: 1 });
  });

  it('scope: regional HR hires in its region only', async () => {
    const opening = await openOpening(ORAN, 1);
    const a = await offered(opening, ORAN);
    const url = `/api/recruitment/applications/${a.id}`;
    for (const [method, path, body] of [['get', `${url}/hire-prefill`, undefined], ['post', `${url}/hire`, hireBody(ORAN)], ['post', `${url}/undo-hire`, { reason: 'Erreur' }], ['post', `${url}/offer/cancel`, { expectedStage: 'offer' }], ['put', `${url}/offer`, { note: 'x' }]] as const) {
      expect((await call('est', method, path, body)).status, path).toBe(404);
      expect((await call('ouest', method, path, body)).status, path).toBe(403);
    }
    expect((await hire('admin', a.id, hireBody(ORAN))).status).toBe(201);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('the units a head may request an opening for', () => {
  it('GET /me/recruitment/units: the units the caller heads and their sub-units, whatever their org_unit.read — exactly what the request accepts', async () => {
    const chef = (await ok('chef', 'get', '/api/me/recruitment/units')).items as Body[];
    expect(chef.map((u) => [u.code, u.depth])).toEqual([['AG-ANNABA', 0], ['SRV-CLI-ANB', 1]]);
    expect(chef[0]).toEqual({ id: ANNABA, code: 'AG-ANNABA', kind: 'agency', name: expect.any(String), nameAr: expect.any(String), site: { id: expect.any(String), code: expect.any(String), name: expect.any(String) }, parentId: null, depth: 0 });
    expect(chef[1]).toMatchObject({ id: unitA('SRV-CLI-ANB'), parentId: ANNABA, site: chef[0]?.site });
    // every listed unit is accepted by the request, an unlisted one refused
    for (const unit of chef) {
      await ok('chef', 'post', '/api/recruitment/openings', { title: `Demande ${unit.code}`, orgUnitId: unit.id, contractType: 'cdd', posts: 1, justification: 'Besoin de test.', targetDate: '2031-06-30' }, 201);
    }
    await problem('chef', 'post', '/api/recruitment/openings', { title: 'Ailleurs', orgUnitId: CNE, contractType: 'cdd', posts: 1, justification: 'Besoin de test.', targetDate: '2031-06-30' }, 403, 'forbidden-scope');
    // the head of a region: the region, its agencies and their services, in tree order
    const est = (await ok('est', 'get', '/api/me/recruitment/units')).items as Body[];
    expect(est[0]).toMatchObject({ code: 'REG-EST', depth: 0, parentId: null });
    expect(est.map((u) => u.code)).toEqual(expect.arrayContaining(['AG-CNE', 'AG-ANNABA', 'SRV-CLI-ANB']));
    expect(est.find((u) => u.code === 'SRV-CLI-ANB')).toMatchObject({ depth: 2, parentId: ANNABA });
    expect(est.some((u) => u.code === 'AG-ORAN' || u.code === 'DG')).toBe(false);
    for (const [k, unit] of est.entries()) if (unit.parentId) expect(est.findIndex((u) => u.id === unit.parentId), unit.code).toBeLessThan(k);
    // nobody else gets a unit: employees, lecture, HR who heads nothing (they use the org-unit picker)
    for (const actor of ['agent', 'ouest', 'acces', 'admin', 'beta', 'newbie'] as const) expect((await ok(actor, 'get', '/api/me/recruitment/units')).items, actor).toEqual([]);
    expect((await call(null, 'get', '/api/me/recruitment/units')).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('notifications and e-mails never name a candidate', () => {
  it('no recruitment notification row holds a candidate’s name, in data or anywhere', async () => {
    const rows = await query<{ type: string; subject_type: string; data: Body }>(db.superuserUrl, `select type, subject_type, data from notification where type like 'recruitment.interview%' or type = 'recruitment.evaluations_complete'`);
    expect(rows.length).toBeGreaterThan(8);
    expect(new Set(rows.map((r) => r.type))).toEqual(new Set(['recruitment.interview_assigned', 'recruitment.interview_cancelled', 'recruitment.evaluations_complete']));
    expect(rows.every((r) => r.subject_type === 'recruitment_interview')).toBe(true);
    const names = (await query<{ last_name: string; first_name: string }>(db.superuserUrl, `select last_name, first_name from recruitment_candidate where company_id = $1`, [COMPANY_A])).flatMap((c) => [c.last_name, c.first_name]);
    const text = JSON.stringify(rows);
    // (a fictitious candidate may share a name with a user: the actor's display name is not the candidate's)
    const users = Object.values(USERS).map((u) => u.displayName).join(' ');
    for (const name of new Set(names.filter((n) => n.length >= 5 && !users.includes(n)))) expect(text.includes(name), name).toBe(false);
    for (const row of rows) {
      const allowed = ['interviewId', 'openingId', 'reference', 'title', 'date', 'time', 'mode', 'actorName', 'audience', 'rescheduled', 'applicationId', 'candidateId'];
      expect(Object.keys(row.data).every((k) => allowed.includes(k)), JSON.stringify(row.data)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('seeded data', () => {
  it('fixture sanity: the seeded demo and matrix rows are consistent with the rules', async () => {
    // demo: the offer in progress of REC-2026-0001 and the accepted one of the filled REC-2026-0003
    const demo = await ok('admin', 'get', `/api/recruitment/applications/${demoApplication(3)}`);
    expect(demo).toMatchObject({ stage: 'offer', offer: { status: 'proposed' }, salary: { expected: '68000.00', proposed: '66000.00' } });
    expect(await ok('admin', 'get', `/api/recruitment/applications/${demoApplication(8)}`)).toMatchObject({ stage: 'hired', offer: { status: 'accepted' }, average: 4.4, employment: { matricule: 'EMP-0028' } });
    expect((await ok('est', 'get', `/api/recruitment/applications/${REC_FX.offered.est}/hire-prefill`)).expectedStage).toBe('offer');
    expect(await count(`recruitment_opening o where o.hired_count + (select count(*) from recruitment_offer f join recruitment_application a on a.id = f.application_id where a.opening_id = o.id and f.status = 'proposed') > o.posts`)).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('erasure and retention of the Phase B data', () => {
  let worker: Database;
  let deps: WorkerDeps;
  let jobSeq = 0;
  const job = () => ({ id: `recb-${++jobSeq}`, attempt: 1 });

  beforeAll(() => {
    worker = createDatabase({ connectionString: db.workerUrl, maxConnections: 2 });
    deps = { db: worker, logger: pino({ level: 'silent' }), mail: { send: () => Promise.resolve() }, webBaseUrl: 'http://web.test' };
  });
  afterAll(async () => {
    await worker?.destroy();
  });


  it('erase on request: interviews, scores, comments, offers and the proposed salary are gone — nothing personal is left in the database or the audit log', async () => {
    const opening = await openOpening(CNE, 2);
    const m = await marked(opening, 'Efface');
    expect(await phaseB(m.application, m.interview)).toEqual({ interviews: 2, interviewers: 2, offers: 1, salary: 1 });
    expect((await searchDatabase(m.needles)).length).toBeGreaterThanOrEqual(8);
    const scores = await count('recruitment_evaluation_score');
    await problem('admin', 'post', `/api/recruitment/candidates/${m.candidate}/erase`, undefined, 409, 'recruitment-application-active');
    await ok('admin', 'post', `/api/recruitment/applications/${m.application}/offer/decline`, { expectedStage: 'offer', comment: 'XqEffaceRefus' });
    const res = await call('admin', 'post', `/api/recruitment/candidates/${m.candidate}/erase`);
    expect(res.status).toBe(204);
    expect(await phaseB(m.application, m.interview)).toEqual({ interviews: 0, interviewers: 0, offers: 0, salary: 0 });
    expect(await count('recruitment_evaluation_score')).toBe(scores - 10);
    // THE search: names, NIN e-mail, labels, places, comments, cancel reasons, the offer's title and note, the amount
    expect(await searchDatabase([...m.needles, 'XqEffaceNom', 'XqEffacePrenom', 'XqEffaceRefus'])).toEqual([]);
    // the anonymous row and its history remain; the interviewers' notifications named the post only
    expect(await one(`select stage, candidate_id, purged_at is not null as purged from recruitment_application where id = $1`, [m.application])).toEqual({ stage: 'withdrawn', candidate_id: null, purged: true });
    expect(await count(`notification where subject_id = $1`, [m.interview])).toBeGreaterThanOrEqual(1);
    expect((await call('chef', 'get', `/api/me/recruitment/interviews/${m.interview}`)).status).toBe(404);
    // the erasure's own events: names of tables and counts only
    const events = await query<{ type: string; data: Body }>(db.superuserUrl, `select type, data from audit.event where request_id = $1 order by id`, [res.headers['x-request-id']]);
    expect(new Set(events.map((e) => e.type))).toEqual(new Set(['recruitment.salary_changed', 'recruitment.interviewer_removed', 'recruitment.interview_deleted', 'recruitment.offer_deleted', 'recruitment.application_updated', 'recruitment.candidate_deleted', 'recruitment.candidate_erased']));
    expect(events.flatMap((e) => Object.keys(e.data)).every((k) => ['fields', 'interviewId', 'userId', 'applications', 'files'].includes(k))).toBe(true);
  });

  it('the retention job (worker role): the Phase B data of a decided application and of a HIRED one go after the period — the employee, the file copy and the link remain', async () => {
    await recruitmentRetentionTask(deps, { today: '2028-04-15' }, job());
    const opening = await openOpening(CNE, 3);
    const rejected = await marked(opening, 'Retenu');
    const hired = await marked(opening, 'Embauche');
    const kept = await marked(opening, 'Recent');
    const cv = (await upload('admin', hired.candidate, demoPdf('TEST DATA - XqEmbauche CV')).expect(201)).body as Body;
    const res = await hire('admin', hired.application, hireBody(CNE, { lastName: 'XqEmbaucheNom', firstName: 'XqEmbauchePrenom', matricule: 'REC-B-PURGE', copyFileIds: [cv.id] }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const employee = (res.body as Body).employee;
    await ok('admin', 'post', `/api/recruitment/applications/${rejected.application}/offer/decline`, { expectedStage: 'offer', comment: 'XqRetenuRefus' });
    await ok('admin', 'post', `/api/recruitment/applications/${kept.application}/offer/decline`, { expectedStage: 'offer' });
    const backdate = (id: string, months: number) => query(db.superuserUrl, `update recruitment_application set decided_at = $2::date - make_interval(months => $3) + interval '12 hours' where id = $1`, [id, '2028-06-15', months]);
    await backdate(rejected.application, 13);
    await backdate(hired.application, 13);
    await backdate(kept.application, 11);
    const eventsBefore = (await one<{ n: number }>(`select count(*)::int as n from audit.event`)).n;

    const run = await recruitmentRetentionTask(deps, { today: '2028-06-15' }, job());
    expect(run).toMatchObject({ applications: 2, candidates: 2 });
    for (const m of [rejected, hired]) {
      expect(await phaseB(m.application, m.interview)).toEqual({ interviews: 0, interviewers: 0, offers: 0, salary: 0 });
      expect(await searchDatabase(m.needles)).toEqual([]);
    }
    expect(await searchDatabase(['XqRetenuNom', 'XqRetenuRefus'])).toEqual([]);
    expect(await count(`recruitment_evaluation_score s where not exists (select 1 from recruitment_interviewer w where w.id = s.interviewer_id)`)).toBe(0);
    // the one decided 11 months ago keeps everything
    expect(await phaseB(kept.application, kept.interview)).toEqual({ interviews: 2, interviewers: 2, offers: 1, salary: 1 });
    expect((await searchDatabase(kept.needles)).length).toBeGreaterThanOrEqual(8);
    // the hire: what lives on is the employee record, the CV copied into the employee file, and the link
    expect(await one(`select stage, employment_id, candidate_id, purged_at is not null as purged from recruitment_application where id = $1`, [hired.application])).toEqual({ stage: 'hired', employment_id: employee.id, candidate_id: null, purged: true });
    expect(await ok('admin', 'get', `/api/employees/${employee.id}`)).toMatchObject({ matricule: 'REC-B-PURGE', person: { lastName: 'XqEmbaucheNom' } });
    const files = (await ok('admin', 'get', `/api/employees/${employee.id}/files`)).items as Body[];
    expect(files.map((f) => f.category.code)).toEqual(['recruitment']);
    expect(Buffer.compare((await download('admin', `/api/employees/${employee.id}/files/${files[0]?.id}/content`)).body as Buffer, demoPdf('TEST DATA - XqEmbauche CV'))).toBe(0);
    expect(await count(`recruitment_candidate where id = any($1)`, [[rejected.candidate, hired.candidate]])).toBe(0);
    expect(await count(`recruitment_candidate_file where candidate_id = $1`, [hired.candidate])).toBe(0);
    // a purged hire cannot be undone (404: the application is anonymous)
    expect((await call('admin', 'post', `/api/recruitment/applications/${hired.application}/undo-hire`, { reason: 'Trop tard' })).status).toBe(404);
    // audit: no per-row event from the worker, one recruitment.purged
    const events = await query<{ type: string; actor_user_id: string | null }>(db.superuserUrl, `select type, actor_user_id from audit.event where type like 'recruitment.%' and id > (select max(id) from (select id from audit.event order by id limit $1) x) order by id`, [eventsBefore]);
    expect(events).toEqual([{ type: 'recruitment.purged', actor_user_id: null }]);
    // the worker holds nothing but the purge's deletes
    await expect(asRole(db.workerUrl, `update recruitment_offer set note = 'x' where application_id = '${kept.application}'`)).rejects.toThrow(/permission denied/);
    await expect(asRole(db.workerUrl, `insert into recruitment_interviewer (company_id, interview_id, user_id) values ('${COMPANY_A}', '${kept.interview}', '${USERS.admin.id}')`)).rejects.toThrow(/permission denied/);
    await expect(asRole(db.workerUrl, `update recruitment_interviewer set comment = null where interview_id = '${kept.interview}'`)).rejects.toThrow(/permission denied/);
  }, 120_000);

});
