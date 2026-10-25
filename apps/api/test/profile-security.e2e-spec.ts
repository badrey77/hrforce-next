/**
 * Personal details and self-service profile changes — security probes of the independent verification
 * (docs/contracts/profile-changes.md › "Settled by the verification (gate and security)"): nobody reads or changes
 * another person's profile, requests or files; ended / future-ended employments; regional HR never sees an Ouest or
 * BETA request nor any bank request or full RIB (list, detail, tasks, notifications, e-mails, History, audit log);
 * `lecture` gets no personal block; self-approval; atomic approval (values and file copy together) and concurrent
 * approvals; one pending request per section under concurrency; upload sniffing, limits and file names; download
 * headers; the purge erasing only what it should; XSRF, anonymous and malformed inputs. TEST DATA — fictitious.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { demoPdf } from '../src/modules/documents/index.js';
import { createDatabase, type Database } from '../src/platform/db/database.js';
import { emailTask, profileFilesPurgeTask, type WorkerDeps } from '../src/worker/tasks.js';
import { as, COMPANY_A, COMPANY_B, employeeA, seedAccessFixture, unitA, USERS, type ActorName } from './support/access-fixture.js';
import { createTestApp } from './support/test-app.js';
import { createTestDatabase, query, type TestDatabase } from './support/test-database.js';
import { fetchXsrf, type XsrfPair } from './support/xsrf.js';

const MAX_BYTES = 64 * 1024;
const PROBLEM = 'urn:hrforce:problem:';

let db: TestDatabase;
let app: NestExpressApplication;
let xsrf: XsrfPair;
let worker: Database;
let deps: WorkerDeps;
const mails: { to: string; subject: string; text: string; html: string }[] = [];
let jobSeq = 0;
const job = () => ({ id: `profile-security-${++jobSeq}`, attempt: 1 });
const client = (actor: ActorName | null) => as(app, actor, xsrf);
const slug = (body: { type?: string }) => (body.type ?? '').replace(PROBLEM, '');
const dev = (r: request.Test, actor: ActorName) => r.set('X-Dev-User-Id', USERS[actor].id).set('X-Dev-Company-Id', actor === 'beta' ? COMPANY_B : COMPANY_A);

/** EMP-0030, Agence Annaba (Est), linked to `agent` */
const AGENT = employeeA(30);
/** EMP-0029, linked to `chef` */
const CHEF = employeeA(29);
/** EMP-0036, Oran (Ouest), linked to `newbie` by this spec */
const OUEST = employeeA(36);

// distinctive values: none of them may reach a place that must not hold them
const V = {
  phone: '0661 23 45 67',
  phoneStored: '661234567',
  email: 'zq.secret@exemple.test',
  address: 'Impasse Zorglub',
  emergencyName: 'Ouardia Zorglub',
  emergencyPhone: '0770 11 22 33',
  emergencyStored: '770112233',
  child: 'Zinebprobe',
  child2: 'Yanisprobe',
  oldRib: '00799999000111122223',
  newRib: '00799999000555566667',
  comment: 'Commentaire Zorglub',
  file: 'livret-Zorglub.pdf',
};
const SECRETS = [V.phoneStored, V.email, V.address, V.emergencyName, V.emergencyStored, V.child, V.child2, V.oldRib, V.newRib, V.comment, 'Zorglub'];
const PDF = demoPdf('PIECE JUSTIFICATIVE - TEST');
const CONTACT = { mobilePhone: V.phone, otherPhone: null, personalEmail: V.email, addressLine: `3, ${V.address}`, commune: 'Annaba', wilayaCode: '23', postalCode: '23000' };
const FAMILY = (children: unknown[]) => ({ maritalStatus: 'married', maritalStatusSince: '2019-05-10', spouseEmployed: 'no', children });
const CHILD = { firstName: V.child, birthDate: '2020-02-02', sex: 'F', dependent: true };

function noSecrets(text: string, what: string): void {
  for (const s of SECRETS) expect(text, `${what} holds ${s}`).not.toContain(s);
}

interface Upload {
  data: unknown;
  files?: { content: Buffer; name: string }[];
}
function submit(actor: ActorName, body: Upload) {
  let req = client(actor).post('/api/me/profile/requests').field('data', typeof body.data === 'string' ? body.data : JSON.stringify(body.data));
  for (const f of body.files ?? []) req = req.attach('files', f.content, f.name);
  return req;
}
async function taskOf(actor: ActorName, requestId: string): Promise<string | undefined> {
  const items = (await client(actor).get('/api/tasks?status=open').expect(200)).body.items as { id: string; subject: { type: string; id: string } }[];
  return items.find((t) => t.subject.type === 'profile_change_request' && t.subject.id === requestId)?.id;
}
/** The open task of a request, whoever may act on it (superuser read). */
async function openTask(requestId: string): Promise<string> {
  const [row] = await query<{ id: string }>(
    db.superuserUrl,
    `select t.id::text from workflow_task t join workflow_instance i on i.id = t.instance_id where i.subject_id = $1 and t.status = 'open'`,
    [requestId],
  );
  if (!row) throw new Error(`no open task for ${requestId}`);
  return row.id;
}
const statusOf = async (id: string) => (await query<{ status: string }>(db.superuserUrl, 'select status from profile_change_request where id = $1', [id]))[0]?.status;
const childrenOf = async (employmentId: string) =>
  (await query<{ first_name: string }>(db.superuserUrl, 'select c.first_name from person_child c join employment e on e.person_id = c.person_id where e.id = $1 order by 1', [employmentId])).map((r) => r.first_name);
const supportingFiles = async (employmentId: string) =>
  (await query<{ n: number }>(db.superuserUrl, `select count(*)::int as n from employee_file f join employee_file_category c on c.id = f.category_id where f.employment_id = $1 and c.code = 'supporting_document'`, [employmentId]))[0]?.n;

const note = (files: { content: Buffer; name: string }[]) => submit('chef', { data: { section: 'identity_note', payload: { note: 'Le nom arabe est mal écrit.' } }, files });
const http = () => request(app.getHttpServer());
const bytes = async () =>
  new Map(
    (
      await query<{ status: string; id: string; has: boolean }>(
        db.superuserUrl,
        `select r.status, f.id::text, f.content is not null as has from profile_change_file f join profile_change_request r on r.id = f.request_id`,
      )
    ).map((r) => [r.id, r]),
  );
const copies = async () => (await query<{ n: number }>(db.superuserUrl, `select count(*)::int as n from employee_file f join employee_file_content c on c.file_id = f.id where f.purged_at is null`))[0]?.n;
const asWorker = (text: string) => query(db.workerUrl, `begin; select set_config('app.company_id', '${COMPANY_A}', true); ${text}; commit;`);
/** A path separator, a control character or a bidi override / isolate. */
const unsafe = (c: string) => { const cp = c.codePointAt(0) ?? 0; return cp < 0x20 || c === '/' || c === '\\' || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069); };

beforeAll(async () => {
  db = await createTestDatabase();
  await seedAccessFixture(db, undefined, { leave: true });
  app = await createTestApp(db, { devAuth: true, devPermissions: false, env: { EMPLOYEE_FILE_MAX_BYTES: String(MAX_BYTES) } });
  xsrf = await fetchXsrf(app);
  worker = createDatabase({ connectionString: db.workerUrl, maxConnections: 3, applicationName: 'hrforce-worker-profile-security' });
  deps = { db: worker, logger: pino({ level: 'silent' }), mail: { send: (m) => (mails.push(m), Promise.resolve()) }, webBaseUrl: 'https://hr.example.dz' };
  // `newbie` becomes an Ouest employee (EMP-0036) with the employe role
  await query(db.superuserUrl, 'insert into user_employment (company_id, user_id, employment_id) values ($1, $2, $3)', [COMPANY_A, USERS.newbie.id, OUEST]);
  await query(
    db.superuserUrl,
    `insert into role_grant (company_id, user_id, role_id, org_unit_id, valid_from, include_descendants)
     select $1, $2, r.id, $3, '2026-01-01', true from role r where r.company_id = $1 and r.code = 'employe' and r.is_system`,
    [COMPANY_A, USERS.newbie.id, unitA('AG-ORAN')],
  );
  // HR records the agent's details and old RIB; the Ouest employee gets its own contact
  await client('admin').put(`/api/employees/${AGENT}/contact`).send(CONTACT).expect(200);
  await client('admin').put(`/api/employees/${AGENT}/emergency-contact`).send({ fullName: V.emergencyName, relationship: 'sibling', phone: V.emergencyPhone }).expect(200);
  await client('admin').put(`/api/employees/${AGENT}/bank`).send({ rib: V.oldRib, bankName: 'BNA' }).expect(200);
  await client('admin').put(`/api/employees/${OUEST}/contact`).send({ ...CONTACT, mobilePhone: '0550 00 00 01', personalEmail: null, addressLine: null }).expect(200);
});

afterAll(async () => {
  await worker?.destroy();
  await app?.close();
  await db?.drop();
});

describe("another person's profile, requests and files", () => {
  const ouest = { request: '', file: '' };

  it('an Ouest request is invisible to the agent, to regional HR Est, to lecture and to BETA', async () => {
    const res = await submit('newbie', { data: { section: 'family', payload: FAMILY([{ ...CHILD, firstName: 'Ouestchild' }]) }, files: [{ content: PDF, name: 'livret.pdf' }] }).expect(201);
    ouest.request = res.body.id;
    ouest.file = res.body.files[0].id;
    expect(res.body.employee.id).toBe(OUEST);
    // the agent: through its own routes, ids of others are 404
    await client('agent').get(`/api/me/profile/requests/${ouest.request}/files/${ouest.file}`).expect(404);
    await client('agent').post(`/api/me/profile/requests/${ouest.request}/cancel`).expect(404);
    expect((await client('agent').get('/api/me/profile/requests').expect(200)).body.items).toEqual([]);
    // … and the HR routes are not theirs
    await client('agent').get('/api/profile/requests').expect(403);
    await client('agent').get(`/api/profile/requests/${ouest.request}`).expect(404);
    await client('agent').get(`/api/profile/requests/${ouest.request}/files/${ouest.file}`).expect(404);
    // regional HR Est: no filter reaches the Ouest
    for (const qs of [`employmentId=${OUEST}`, `unitId=${unitA('REG-OUEST')}`, `unitId=${unitA('AG-ORAN')}&includeSubUnits=false`, 'q=0036', 'status=pending']) {
      const page = (await client('est').get(`/api/profile/requests?${qs}`).expect(200)).body as { items: { id: string }[] };
      expect(page.items.map((r) => r.id), qs).not.toContain(ouest.request);
    }
    await client('est').get(`/api/profile/requests/${ouest.request}`).expect(404);
    await client('est').get(`/api/profile/requests/${ouest.request}/files/${ouest.file}`).expect(404);
    expect(await taskOf('est', ouest.request)).toBeUndefined();
    // lecture (Ouest) and the access admin
    await client('ouest').get('/api/profile/requests').expect(403);
    await client('ouest').get(`/api/profile/requests/${ouest.request}`).expect(404);
    await client('acces').get(`/api/profile/requests/${ouest.request}/files/${ouest.file}`).expect(404);
    // another company
    await client('beta').get(`/api/profile/requests/${ouest.request}`).expect(404);
    expect((await client('beta').get(`/api/profile/requests?employmentId=${OUEST}`).expect(200)).body.total).toBe(0);
    await client('beta').put(`/api/employees/${OUEST}/contact`).send(CONTACT).expect(404);
    // central HR does see it
    expect((await client('admin').get(`/api/profile/requests/${ouest.request}`).expect(200)).body.id).toBe(ouest.request);
  });

  it('ids of another employee in the body change nothing but the caller’s own section', async () => {
    const before = (await client('admin').get(`/api/employees/${OUEST}`).expect(200)).body.personal.contact;
    const data = { section: 'contact', employmentId: OUEST, personId: OUEST, payload: { ...CONTACT, commune: 'Seraidi', employmentId: OUEST, personId: OUEST } };
    const res = await submit('agent', { data }).expect(201);
    expect(res.body.employee.id).toBe(AGENT);
    expect(res.body.payload).not.toHaveProperty('employmentId');
    expect((await client('admin').get(`/api/employees/${OUEST}`).expect(200)).body.personal.contact).toEqual(before);
    expect((await client('admin').get(`/api/employees/${AGENT}`).expect(200)).body.personal.contact.commune).toBe('Seraidi');
  });

  it('HR writes: Est on an Ouest employee → 404, lecture / access admin / employee → 403; the employee cannot use the HR routes on itself', async () => {
    await client('est').put(`/api/employees/${OUEST}/contact`).send(CONTACT).expect(404);
    await client('est').put(`/api/employees/${OUEST}/emergency-contact`).send({ fullName: 'A B', relationship: 'other', phone: '0550000000' }).expect(404);
    await client('est').put(`/api/employees/${OUEST}/family`).send(FAMILY([])).expect(404);
    await client('ouest').put(`/api/employees/${OUEST}/contact`).send(CONTACT).expect(403);
    await client('acces').put(`/api/employees/${AGENT}/contact`).send(CONTACT).expect(403);
    await client('agent').put(`/api/employees/${AGENT}/contact`).send(CONTACT).expect(403);
    await client('newbie').put(`/api/employees/${OUEST}/family`).send(FAMILY([])).expect(403);
  });

  it('lecture gets no personal block (redacted) and the list never carries personal data', async () => {
    const res = (await client('ouest').get(`/api/employees/${OUEST}`).expect(200)).body;
    expect(res.personal).toBeUndefined();
    expect(res['_redacted']).toContain('personal');
    expect(res['_actions'] ?? []).not.toContain('update_personal');
    const list = await client('admin').get('/api/employees?pageSize=100').expect(200);
    noSecrets(JSON.stringify(list.body), 'GET /employees');
    expect(JSON.stringify(list.body)).not.toContain('personal');
  });
});

describe('a linked account whose employment has ended (or ends in the future) is refused everywhere', () => {
  it('every /me/profile route → 409 profile-not-linked', async () => {
    const pending = await submit('chef', { data: { section: 'identity_note', payload: { note: 'Erreur de date de naissance.' } }, files: [{ content: PDF, name: 'acte.pdf' }] }).expect(201);
    const fileId = pending.body.files[0].id as string;
    for (const endDate of ['2026-01-31', '2099-12-31']) {
      await query(db.superuserUrl, `set session_replication_role = replica; update employment set end_date = '${endDate}', end_reason = 'resignation' where id = '${CHEF}'`);
      try {
        for (const res of [
          await client('chef').get('/api/me/profile'),
          await client('chef').get('/api/me/profile/requests'),
          await client('chef').get(`/api/me/profile/requests/${pending.body.id}/files/${fileId}`),
          await client('chef').post(`/api/me/profile/requests/${pending.body.id}/cancel`),
          await submit('chef', { data: { section: 'contact', payload: CONTACT } }),
        ]) {
          expect(res.status, endDate).toBe(409);
          expect(slug(res.body)).toBe('profile-not-linked');
        }
      } finally {
        await query(db.superuserUrl, `set session_replication_role = replica; update employment set end_date = null, end_reason = null where id = '${CHEF}'`);
      }
    }
    expect(await statusOf(pending.body.id)).toBe('pending');
    await client('chef').post(`/api/me/profile/requests/${pending.body.id}/cancel`).expect(200);
  });

  it('an approval on an ended employment → 409 employment-ended and nothing is applied', async () => {
    const res = await submit('chef', { data: { section: 'family', payload: FAMILY([CHILD]) }, files: [{ content: PDF, name: 'livret.pdf' }] }).expect(201);
    const taskId = await openTask(res.body.id);
    await query(db.superuserUrl, `set session_replication_role = replica; update employment set end_date = '2026-01-31', end_reason = 'resignation' where id = '${CHEF}'`);
    try {
      const approve = await client('est').post(`/api/tasks/${taskId}/approve`).send({});
      expect(approve.status).toBe(409);
      expect(slug(approve.body)).toBe('employment-ended');
    } finally {
      await query(db.superuserUrl, `set session_replication_role = replica; update employment set end_date = null, end_reason = null where id = '${CHEF}'`);
    }
    expect(await statusOf(res.body.id)).toBe('pending');
    expect(await childrenOf(CHEF)).toEqual([]);
    expect(await supportingFiles(CHEF)).toBe(0);
    await client('est').post(`/api/tasks/${taskId}/reject`).send({ comment: 'Dossier incomplet.' }).expect(200);
  });
});

describe('bank requests: central HR only, RIB masked everywhere else', () => {
  const ids = { request: '', file: '' };

  it('the requester sees the RIB it typed, never the full one on record', async () => {
    const res = await submit('agent', { data: { section: 'bank', payload: { rib: V.newRib, bankName: 'CPA' }, comment: V.comment }, files: [{ content: PDF, name: V.file }] }).expect(201);
    ids.request = res.body.id;
    ids.file = res.body.files[0].id;
    expect(res.body.payload.rib).toBe(V.newRib);
    expect(res.body.before.rib).toBe('•••• •••• 2223');
    expect(JSON.stringify(res.body)).not.toContain(V.oldRib);
    const mine = (await client('agent').get('/api/me/profile/requests?status=pending').expect(200)).body;
    expect(JSON.stringify(mine)).not.toContain(V.oldRib);
    const profile = (await client('agent').get('/api/me/profile').expect(200)).body;
    expect(JSON.stringify(profile)).not.toContain(V.oldRib);
    expect(profile.bank.ribMasked).toBe('•••• •••• 2223');
  });

  it('regional HR: not in the list (any filter), no detail, no file, no task, no notification', async () => {
    for (const qs of ['', 'section=bank', `employmentId=${AGENT}`, 'status=pending', `unitId=${unitA('REG-EST')}`]) {
      const page = (await client('est').get(`/api/profile/requests?${qs}`).expect(200)).body as { items: { id: string; section: string }[] };
      expect(page.items.filter((r) => r.section === 'bank'), qs).toEqual([]);
    }
    await client('est').get(`/api/profile/requests/${ids.request}`).expect(404);
    await client('est').get(`/api/profile/requests/${ids.request}/files/${ids.file}`).expect(404);
    expect(await taskOf('est', ids.request)).toBeUndefined();
    const tasks = await client('est').get('/api/tasks?status=open').expect(200);
    noSecrets(JSON.stringify(tasks.body), 'est tasks');
    const notes = await client('est').get('/api/me/notifications?limit=100').expect(200);
    expect(JSON.stringify(notes.body)).not.toContain(ids.request);
    // the History: not readable by regional HR; central HR's holds no RIB, no comment, no file name
    await client('est').get(`/api/audit/timeline?subject=employee:${AGENT}&limit=100`).expect(403);
    const timeline = await client('admin').get(`/api/audit/timeline?subject=employee:${AGENT}&limit=100`).expect(200);
    noSecrets(JSON.stringify(timeline.body), 'est timeline');
  });

  it('central HR sees the full RIB; approval applies it and only the security notice goes out', async () => {
    const detail = (await client('admin').get(`/api/profile/requests/${ids.request}`).expect(200)).body;
    expect(detail.payload.rib).toBe(V.newRib);
    expect(detail.before.rib).toBe(V.oldRib);
    const tasks = await client('admin').get('/api/tasks?status=open').expect(200);
    noSecrets(JSON.stringify(tasks.body), 'admin tasks');
    await client('admin').post(`/api/tasks/${await taskOf('admin', ids.request)}/approve`).send({}).expect(200);
    expect((await client('admin').get(`/api/employees/${AGENT}`).expect(200)).body.bank.rib).toBe(V.newRib);
    const prefs = (await client('agent').get('/api/me/notification-preferences').expect(200)).body as { type: string; email: boolean }[] | { items: { type: string; email: boolean }[] };
    const list = Array.isArray(prefs) ? prefs : prefs.items;
    expect(list.find((p) => p.type === 'profile.bank_changed')?.email).toBe(true);
    await client('agent').put('/api/me/notification-preferences').send([{ type: 'profile.bank_changed', email: false }]).expect(422);
  });
});

describe('approval is atomic and happens once', () => {
  it('a file copy that fails rolls the applied values back', async () => {
    const filesBefore = await supportingFiles(AGENT);
    const res = await submit('agent', { data: { section: 'family', payload: FAMILY([CHILD]) }, files: [{ content: demoPdf('ATOMIC'), name: V.file }] }).expect(201);
    const taskId = await openTask(res.body.id);
    // the employee-file insert fails (after the values were applied in the same transaction)
    await query(
      db.superuserUrl,
      `create function probe_fail() returns trigger language plpgsql as $$ begin raise exception 'probe: copy fails'; end $$;
       create trigger probe_fail_tg before insert on employee_file for each row execute function probe_fail();`,
    );
    try {
      const approve = await client('est').post(`/api/tasks/${taskId}/approve`).send({});
      expect(approve.status).toBeGreaterThanOrEqual(500);
    } finally {
      await query(db.superuserUrl, 'drop trigger probe_fail_tg on employee_file; drop function probe_fail();');
    }
    expect(await statusOf(res.body.id)).toBe('pending');
    expect(await childrenOf(AGENT)).toEqual([]);
    expect(await supportingFiles(AGENT)).toBe(filesBefore);
    expect((await query<{ n: number }>(db.superuserUrl, `select count(*)::int as n from person_family f join employment e on e.person_id = f.person_id where e.id = $1`, [AGENT]))[0]?.n).toBe(0);
    expect(await openTask(res.body.id)).toBe(taskId);
    // the same approval now goes through: values and file together
    await client('est').post(`/api/tasks/${taskId}/approve`).send({}).expect(200);
    expect(await childrenOf(AGENT)).toEqual([V.child]);
    expect(await supportingFiles(AGENT)).toBe((filesBefore ?? 0) + 1);
  });

  it('two HR users approving at once: one wins, the change is applied once', async () => {
    const current = (await client('agent').get('/api/me/profile').expect(200)).body.personal.family.children as { id: string }[];
    const res = await submit('agent', { data: { section: 'family', payload: FAMILY([...current.map((c) => ({ ...CHILD, id: c.id })), { ...CHILD, firstName: V.child2, birthDate: '2024-06-01' }]) }, files: [{ content: demoPdf('SECOND'), name: 'acte2.pdf' }] }).expect(201);
    const filesBefore = await supportingFiles(AGENT);
    const taskId = await openTask(res.body.id);
    const results = await Promise.all([client('est').post(`/api/tasks/${taskId}/approve`).send({}), client('admin').post(`/api/tasks/${taskId}/approve`).send({})]);
    expect(results.map((r) => r.status).toSorted()).toEqual([200, 409]);
    expect(await childrenOf(AGENT)).toEqual([V.child2, V.child].toSorted());
    expect(await supportingFiles(AGENT)).toBe((filesBefore ?? 0) + 1);
    const approvals = await query<{ n: number }>(db.superuserUrl, `select count(*)::int as n from audit.event where subject_id = $1 and type = 'profile.applied'`, [res.body.id]);
    expect(approvals[0]?.n).toBe(1);
  });

  it('HR cannot approve its own request; the employee is never a candidate of its own task', async () => {
    const res = await submit('est', { data: { section: 'family', payload: FAMILY([]) }, files: [{ content: PDF, name: 'livret.pdf' }] }).expect(201);
    const taskId = await openTask(res.body.id);
    expect(slug((await client('est').post(`/api/tasks/${taskId}/approve`).send({}).expect(409)).body)).toBe('workflow-self-approval');
    expect((await client('est').post(`/api/tasks/${taskId}/reject`).send({ comment: 'non' })).status).toBeGreaterThanOrEqual(400);
    const agentRequest = (await client('agent').get('/api/me/profile/requests?status=approved').expect(200)).body.items[0] as { id: string };
    expect(agentRequest).toBeDefined();
    await client('admin').post(`/api/tasks/${taskId}/reject`).send({ comment: 'Pièce illisible.' }).expect(200);
  });
});

describe('one pending request per section', () => {
  it('six simultaneous family requests → one 201, five 409 profile-request-pending', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => submit('chef', { data: { section: 'family', payload: FAMILY([{ ...CHILD, firstName: `Child${i}` }]) }, files: [{ content: demoPdf(`C${i}`), name: `c${i}.pdf` }] })),
    );
    expect(results.map((r) => r.status).toSorted()).toEqual([201, 409, 409, 409, 409, 409]);
    for (const r of results.filter((x) => x.status === 409)) expect(slug(r.body)).toBe('profile-request-pending');
    const rows = await query<{ n: number }>(db.superuserUrl, `select count(*)::int as n from profile_change_request where employment_id = $1 and section = 'family' and status = 'pending'`, [CHEF]);
    expect(rows[0]?.n).toBe(1);
    // the losers left no file behind
    const files = await query<{ n: number }>(db.superuserUrl, `select count(*)::int as n from profile_change_file f join profile_change_request r on r.id = f.request_id where r.employment_id = $1 and r.section = 'family'`, [CHEF]);
    expect(files[0]?.n).toBe(2); // the rejected one of the ended-employment probe + this one
  });
});

describe('uploads and downloads', () => {

  it('only sniffed PDF / JPEG / PNG; the size limit; at most 3 files', async () => {
    const exe = Buffer.concat([Buffer.from('MZ\x90\x00\x03\x00\x00\x00'), Buffer.alloc(200)]);
    const html = Buffer.from('<!doctype html><script>alert(document.cookie)</script>');
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
    for (const [content, name] of [[exe, 'scan.pdf'], [html, 'photo.jpg'], [svg, 'image.png'], [Buffer.alloc(0), 'vide.pdf']] as const) {
      const res = await note([{ content, name }]).expect(422);
      expect(res.body.errors[0].field, name).toBe('files.0');
    }
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(MAX_BYTES)]);
    expect((await note([{ content: big, name: 'gros.pdf' }]).expect(422)).body.errors[0]).toMatchObject({ field: 'files', code: 'too_large' });
    const four = [1, 2, 3, 4].map((i) => ({ content: demoPdf(`F${i}`), name: `f${i}.pdf` }));
    expect((await note(four).expect(422)).body.errors[0]).toMatchObject({ field: 'files', code: 'too_many' });
    // a part under another field name is refused too
    const other = await client('chef').post('/api/me/profile/requests').field('data', JSON.stringify({ section: 'identity_note', payload: { note: 'x' } })).attach('evil', PDF, 'a.pdf');
    expect(other.status).toBe(422);
    expect(await query(db.superuserUrl, `select id from profile_change_request where employment_id = $1 and section = 'identity_note' and status = 'pending'`, [CHEF])).toEqual([]);
  });

  it('file names lose path parts and bidi / control characters; downloads are attachments with nosniff and a sandbox CSP', async () => {
    const res = await note([{ content: PDF, name: '..\\..\\Windows\\evil‮fdp.exe.pdf' }, { content: demoPdf('B'), name: '../../etc/page.html' }]);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const names = (res.body.files as { filename: string }[]).map((f) => f.filename).toSorted();
    expect(names).toEqual(['evilfdp.exe.pdf', 'page.html']);
    // a control character in a part's name: the multipart body is refused, nothing stored
    expect((await note([{ content: demoPdf('BEL'), name: 'bell\u0007.pdf' }]).expect(422)).body.errors[0]).toMatchObject({ field: 'files', code: 'invalid_multipart' });
    for (const name of names) expect([...name].some(unsafe), name).toBe(false);
    for (const file of res.body.files as { id: string; filename: string }[]) {
      for (const [actor, path] of [
        ['chef', `/api/me/profile/requests/${res.body.id}/files/${file.id}`],
        ['est', `/api/profile/requests/${res.body.id}/files/${file.id}`],
      ] as const) {
        const dl = await client(actor).get(path).expect(200);
        expect(dl.headers['content-type']).toBe('application/pdf');
        expect(dl.headers['content-disposition']).toMatch(/^attachment;/);
        expect(dl.headers['content-disposition']).not.toMatch(/[‪-‮]|\.\.\//);
        expect(dl.headers['x-content-type-options']).toBe('nosniff');
        expect(dl.headers['content-security-policy']).toBe("sandbox; default-src 'none'");
        expect(dl.headers['cache-control']).toContain('no-store');
      }
    }
    // the HTML-named PDF downloads with a .pdf extension
    const htmlNamed = (res.body.files as { id: string; filename: string }[]).find((f) => f.filename === 'page.html');
    const dl = await client('chef').get(`/api/me/profile/requests/${res.body.id}/files/${htmlNamed?.id}`).expect(200);
    expect(dl.headers['content-disposition']).toContain('page.html.pdf');
    // another request's file id under this request → 404
    const other = (await query<{ id: string }>(db.superuserUrl, `select f.id::text from profile_change_file f where f.request_id <> $1 limit 1`, [res.body.id]))[0]?.id;
    await client('chef').get(`/api/me/profile/requests/${res.body.id}/files/${other}`).expect(404);
    await client('est').get(`/api/profile/requests/${res.body.id}/files/${other}`).expect(404);
    await client('chef').get(`/api/me/profile/requests/${res.body.id}/files/not-a-uuid`).expect(404);
    await client('chef').post(`/api/me/profile/requests/${res.body.id}/cancel`).expect(200);
  });
});

describe('XSRF, anonymous, malformed input', () => {
  it('writes without the XSRF token → 403; anonymous → 401', async () => {
    const noXsrf = [
      () => dev(http().post('/api/me/profile/requests'), 'agent').field('data', JSON.stringify({ section: 'contact', payload: CONTACT })),
      () => dev(http().post(`/api/me/profile/requests/${employeeA(1)}/cancel`), 'agent'),
      () => dev(http().put(`/api/employees/${AGENT}/contact`), 'admin').send(CONTACT),
      () => dev(http().put(`/api/employees/${AGENT}/emergency-contact`).set('Content-Type', 'application/json'), 'admin').send('null'),
      () => dev(http().put(`/api/employees/${AGENT}/family`), 'admin').send(FAMILY([])),
      () => dev(http().put('/api/profile/settings'), 'admin').send({ contactMode: 'approval', emergencyMode: 'approval', familyMode: 'approval', fileRetentionDays: 7 }),
    ];
    for (const r of noXsrf) expect((await r()).status).toBe(403);
    expect((await client('admin').get('/api/profile/settings').expect(200)).body.contactMode).toBe('immediate');
    for (const path of ['/api/me/profile', '/api/me/profile/requests', `/api/me/profile/requests/${employeeA(1)}/files/${employeeA(2)}`, '/api/profile/requests', `/api/profile/requests/${employeeA(1)}`, `/api/profile/requests/${employeeA(1)}/files/${employeeA(2)}`, '/api/profile/settings']) {
      await client(null).get(path).expect(401);
    }
    await client(null).post('/api/me/profile/requests').field('data', '{}').expect(401);
    await client(null).put(`/api/employees/${AGENT}/contact`).send(CONTACT).expect(401);
  });

  it('16 children, a wrong section, a non-object data or payload, an oversized data field → 422', async () => {
    const sixteen = Array.from({ length: 16 }, (_, i) => ({ firstName: `E${i}`, birthDate: '2010-01-01', sex: null, dependent: true }));
    expect((await client('admin').put(`/api/employees/${OUEST}/family`).send(FAMILY(sixteen)).expect(422)).body.errors[0].field).toBe('children');
    const self = await submit('newbie', { data: { section: 'family', payload: FAMILY(sixteen) }, files: [{ content: PDF, name: 'a.pdf' }] });
    expect(self.status).toBe(422);
    expect(self.body.errors[0].field).toMatch(/^payload\.children/);
    for (const data of ['[]', '"contact"', '5', 'null', JSON.stringify({ section: 'salary', payload: {} }), JSON.stringify({ section: 'contact', payload: null }), JSON.stringify({ section: 'contact', payload: [] }), JSON.stringify({ section: 'identity_note', payload: { note: 'x'.repeat(501) } }), JSON.stringify({ section: 'contact', payload: CONTACT, comment: 'c'.repeat(501) })]) {
      expect((await submit('newbie', { data }).expect(422)).body.errors.length, data.slice(0, 40)).toBeGreaterThan(0);
    }
    const huge = JSON.stringify({ section: 'identity_note', payload: { note: 'x' }, pad: 'p'.repeat(250_000) });
    expect((await submit('newbie', { data: huge })).status).toBe(422);
    expect(await query(db.superuserUrl, `select id from profile_change_request where employment_id = $1 and status <> 'pending'`, [OUEST])).toEqual([]);
  });

  it('a __proto__ key pollutes nothing and is not stored', async () => {
    const data = `{"section":"contact","__proto__":{"section":"bank"},"payload":{"__proto__":{"isAdmin":true},"constructor":{"prototype":{"x":1}},"mobilePhone":"0550 99 88 77","otherPhone":null,"personalEmail":null,"addressLine":null,"commune":null,"wilayaCode":null,"postalCode":null}}`;
    const res = await submit('newbie', { data }).expect(201);
    expect(res.body.section).toBe('contact');
    expect(({} as Record<string, unknown>)['isAdmin']).toBeUndefined();
    const [row] = await query<{ payload: string }>(db.superuserUrl, 'select payload::text from profile_change_request where id = $1', [res.body.id]);
    expect(row?.payload).not.toMatch(/__proto__|constructor|isAdmin/);
    // the emergency route's non-strict JSON body: only an object or null
    for (const body of ['"x"', '5', 'true', '[]', '{"__proto__":{"fullName":"A"}}']) {
      const r = await client('admin').put(`/api/employees/${OUEST}/emergency-contact`).set('Content-Type', 'application/json').send(body);
      expect(r.status, body).toBe(422);
    }
    expect((await client('admin').put(`/api/employees/${OUEST}/emergency-contact`).set('Content-Type', 'application/json').send('null')).status).toBe(200);
    const big = JSON.stringify({ fullName: 'A', relationship: 'other', phone: '0550000000', pad: 'p'.repeat(150_000) });
    expect((await client('admin').put(`/api/employees/${OUEST}/emergency-contact`).set('Content-Type', 'application/json').send(big)).status).toBe(413);
    // the other routes keep the strict parser: a top-level null is refused
    const strict = await client('admin').put(`/api/employees/${OUEST}/contact`).set('Content-Type', 'application/json').send('null');
    expect(strict.status).toBeGreaterThanOrEqual(400);
    expect(strict.status).toBeLessThan(500);
  });
});

describe('the purge erases only what it should', () => {
  it('rejected / cancelled after the retention, approved once copied; pending and the employee-file copies stay', async () => {
    const copiesBefore = await copies();
    const start = await bytes();
    expect([...start.values()].some((f) => f.status === 'pending' && f.has)).toBe(true);
    // ten days on: only the approved requests (copied) lose their bytes
    await profileFilesPurgeTask(deps, { now: new Date(Date.now() + 10 * 86_400_000).toISOString() }, job());
    const soon = await bytes();
    for (const [id, f] of soon) expect(f.has, `${f.status} ${id}`).toBe(f.status === 'approved' ? false : start.get(id)?.has);
    // 31 days on: rejected and cancelled too; pending ones never
    await profileFilesPurgeTask(deps, { now: new Date(Date.now() + 31 * 86_400_000).toISOString() }, job());
    await profileFilesPurgeTask(deps, { now: new Date(Date.now() + 400 * 86_400_000).toISOString() }, job());
    for (const [id, f] of await bytes()) expect(f.has, `${f.status} ${id}`).toBe(f.status === 'pending');
    expect(await copies()).toBe(copiesBefore);
    // the worker nulls the bytes but never reads them, nor the file names
    await expect(asWorker('select content from profile_change_file limit 1')).rejects.toThrow(/permission denied/);
    await expect(asWorker('select original_filename from profile_change_file limit 1')).rejects.toThrow(/permission denied/);
    await expect(asWorker('update profile_change_file set content = null where content is not null')).rejects.toThrow(/permission denied/);
    await asWorker('select id, request_id, employee_file_id from profile_change_file limit 1');
    // the requester cannot download a purged file of a pending… nothing left but metadata on decided ones
    const decided = (await client('agent').get('/api/me/profile/requests').expect(200)).body.items as { status: string; files: { purged: boolean }[] }[];
    for (const r of decided.filter((x) => x.status !== 'pending')) for (const f of r.files) expect(f.purged).toBe(true);
  });
});

describe('no personal value outside the personal tables and the requests themselves', () => {
  it('notifications, their e-mails, the task summaries and the audit log hold none', async () => {
    const notes = await query<{ id: string; data: unknown; company_id: string }>(db.superuserUrl, `select id::text, data, company_id::text from notification`);
    noSecrets(JSON.stringify(notes), 'notification');
    for (const n of notes) await emailTask(deps, { companyId: n.company_id, notificationId: n.id }, job());
    expect(mails.length).toBeGreaterThan(0);
    expect(mails.some((m) => m.subject.includes('bancaires'))).toBe(true);
    noSecrets(JSON.stringify(mails), 'e-mails');
    const tasks = await query<{ t: string }>(db.superuserUrl, `select row_to_json(t)::text as t from workflow_task t`);
    noSecrets(JSON.stringify(tasks), 'workflow_task');
    const log = await query<{ t: string }>(
      db.superuserUrl,
      `select table_name || ' ' || coalesce(before::text, '') || ' ' || coalesce(after::text, '') as t from audit.change_log
        where table_name in ('person_contact', 'person_emergency_contact', 'person_family', 'person_child', 'profile_policy',
                             'profile_change_request', 'profile_change_file', 'person_sensitive', 'workflow_instance', 'workflow_task', 'notification')`,
    );
    expect(log.length).toBeGreaterThan(20);
    noSecrets(log.map((r) => r.t).join('\n'), 'audit.change_log');
    // the file names stay out of the request tables' log; the RIBs out of every table
    const all = (await query<{ t: string }>(db.superuserUrl, `select coalesce(before::text, '') || coalesce(after::text, '') as t from audit.change_log`)).map((r) => r.t).join('\n');
    expect(all).not.toContain(V.oldRib);
    expect(all).not.toContain(V.newRib);
    const events = await query<{ t: string }>(db.superuserUrl, `select type || ' ' || coalesce(data::text, '') as t from audit.event`);
    noSecrets(events.map((r) => r.t).join('\n'), 'audit.event');
    expect(events.some((e) => e.t.startsWith('profile.file_downloaded'))).toBe(true);
    // the bytes of a request file are never copied into the log
    expect(all).not.toContain('PIECE JUSTIFICATIVE');
  });
});
