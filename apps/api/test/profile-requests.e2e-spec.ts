/**
 * Self-service profile changes (docs/contracts/profile-changes.md › Self-service requests): « Mon profil », immediate
 * contact changes, family requests with a supporting file approved by HR (applied + copied into the employee file),
 * rejection, cancellation, one pending per section, « modifié depuis la demande », bank requests (central HR only, the
 * security e-mail whatever the preference), identity notes, self-approval, ended / unlinked employments, the HR list
 * scope, file download rights, the worker purge, settings, notifications and audit masking. TEST DATA — fictitious.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { demoPdf } from '../src/modules/documents/index.js';
import { createDatabase, type Database } from '../src/platform/db/database.js';
import { emailTask, profileFilesPurgeTask, type WorkerDeps } from '../src/worker/tasks.js';
import { as, COMPANY_A, employeeA, seedAccessFixture, USERS, type ActorName } from './support/access-fixture.js';
import { assertNoSecrets } from './support/assert-no-secrets.js';
import { createTestApp } from './support/test-app.js';
import { createTestDatabase, query, type TestDatabase } from './support/test-database.js';
import { fetchXsrf, type XsrfPair } from './support/xsrf.js';

let db: TestDatabase;
let app: NestExpressApplication;
let xsrf: XsrfPair;
let worker: Database;
let deps: WorkerDeps;
const sent: { to: string; subject: string }[] = [];
let jobSeq = 0;
const job = () => ({ id: `profile-${++jobSeq}`, attempt: 1 });
const client = (actor: ActorName) => as(app, actor, xsrf);
const slug = (body: { type?: string }) => (body.type ?? '').replace('urn:hrforce:problem:', '');

const AGENT = employeeA(30);
const KARIM = employeeA(22);
const CHEF = employeeA(29);
const PDF = demoPdf('LIVRET DE FAMILLE - TEST');
const PDF2 = demoPdf('RIB - TEST');
const CONTACT = { mobilePhone: '0555 12 34 56', otherPhone: null, personalEmail: 'agent.test@exemple.test', addressLine: '3, rue des Jasmins', commune: 'Annaba', wilayaCode: '23', postalCode: '23000' };
const NEW_CHILD = { firstName: 'Nour', birthDate: '2025-03-04', sex: 'F', dependent: true };
const FAMILY = (children: unknown[] = []) => ({ maritalStatus: 'married', maritalStatusSince: '2019-05-10', spouseEmployed: 'no', children });

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

async function notifications(userId: string, type: string): Promise<{ subject_id: string; data: Record<string, unknown>; id: string }[]> {
  return query(db.superuserUrl, 'select id::text, subject_id::text, data from notification where company_id = $1 and user_id = $2 and type = $3', [COMPANY_A, userId, type]);
}

beforeAll(async () => {
  db = await createTestDatabase();
  await seedAccessFixture(db, undefined, { leave: true });
  app = await createTestApp(db, { devAuth: true, devPermissions: false });
  xsrf = await fetchXsrf(app);
  worker = createDatabase({ connectionString: db.workerUrl, maxConnections: 3, applicationName: 'hrforce-worker-profile' });
  deps = { db: worker, logger: pino({ level: 'silent' }), mail: { send: (m) => (sent.push({ to: m.to, subject: m.subject }), Promise.resolve()) }, webBaseUrl: 'https://hr.example.dz' };
});

afterAll(async () => {
  await worker?.destroy();
  await app?.close();
  await db?.drop();
});

describe('GET /me/profile', () => {
  it('the linked employee sees its identity (NIN masked), personal details, masked RIB, modes and nothing pending', async () => {
    const res = await client('agent').get('/api/me/profile').expect(200);
    assertNoSecrets(res.body);
    expect(res.body.employee.id).toBe(AGENT);
    expect(res.body.identity.ninMasked === null || /^•••• \d{4}$/.test(res.body.identity.ninMasked)).toBe(true);
    expect(res.body.bank.ribMasked === null || /^•••• •••• \d{4}$/.test(res.body.bank.ribMasked)).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(/\d{18}|\d{20}/);
    expect(res.body.modes).toEqual({ contact: 'immediate', emergency: 'immediate', family: 'approval' });
    expect(res.body.pending).toEqual([]);
  });

  it('not linked → 409 profile-not-linked; no permission → 403; anonymous → 401', async () => {
    const admin = await client('admin').get('/api/me/profile').expect(409);
    expect(slug(admin.body)).toBe('profile-not-linked');
    await client('ouest').get('/api/me/profile').expect(403);
    await client('acces').get('/api/me/profile').expect(403);
    await as(app, null, xsrf).get('/api/me/profile').expect(401);
    await as(app, null, xsrf).get('/api/profile/requests').expect(401);
  });

  it('an ended employment → 409 profile-not-linked', async () => {
    // triggers off for this probe only (the assignment would have to end too)
    await query(db.superuserUrl, `set session_replication_role = replica; update employment set end_date = '2026-01-31', end_reason = 'resignation' where id = '${CHEF}'`);
    try {
      expect(slug((await client('chef').get('/api/me/profile').expect(409)).body)).toBe('profile-not-linked');
      expect(slug((await submit('chef', { data: { section: 'contact', payload: CONTACT } }).expect(409)).body)).toBe('profile-not-linked');
    } finally {
      await query(db.superuserUrl, `set session_replication_role = replica; update employment set end_date = null, end_reason = null where id = '${CHEF}'`);
    }
  });
});

describe('validation', () => {
  it('data, section, payload paths, unchanged, files rules', async () => {
    expect((await submit('agent', { data: '{not json' }).expect(422)).body.errors[0]).toMatchObject({ field: 'data', code: 'invalid_json' });
    expect((await submit('agent', { data: { section: 'salary', payload: {} } }).expect(422)).body.errors[0].field).toBe('section');
    const bad = await submit('agent', { data: { section: 'contact', payload: { ...CONTACT, mobilePhone: 'abc', wilayaCode: '77' } } }).expect(422);
    expect(bad.body.errors.map((e: { field: string }) => e.field).toSorted()).toEqual(['payload.mobilePhone', 'payload.wilayaCode']);
    const child = await submit('agent', { data: { section: 'family', payload: FAMILY([{ ...NEW_CHILD, birthDate: '2999-01-01' }]) }, files: [{ content: PDF, name: 'livret.pdf' }] }).expect(422);
    expect(child.body.errors[0]).toMatchObject({ field: 'payload.children.0.birthDate', code: 'future_date' });
    const empty = { mobilePhone: null, otherPhone: null, personalEmail: null, addressLine: null, commune: null, wilayaCode: null, postalCode: null };
    expect((await submit('agent', { data: { section: 'contact', payload: empty } }).expect(422)).body.errors[0]).toMatchObject({ field: 'payload', code: 'unchanged' });
    expect((await submit('agent', { data: { section: 'contact', payload: CONTACT }, files: [{ content: PDF, name: 'x.pdf' }] }).expect(422)).body.errors[0]).toMatchObject({ field: 'files', code: 'not_accepted' });
    expect((await submit('agent', { data: { section: 'family', payload: FAMILY([NEW_CHILD]) } }).expect(422)).body.errors[0]).toMatchObject({ field: 'files', code: 'required' });
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    expect((await submit('agent', { data: { section: 'family', payload: FAMILY([NEW_CHILD]) }, files: [{ content: html, name: 'x.pdf' }] }).expect(422)).body.errors[0]).toMatchObject({ field: 'files.0', code: 'unsupported_type' });
    const four = [1, 2, 3, 4].map((i) => ({ content: demoPdf(`f${i}`), name: `f${i}.pdf` }));
    expect((await submit('agent', { data: { section: 'family', payload: FAMILY([NEW_CHILD]) }, files: four }).expect(422)).body.errors[0]).toMatchObject({ field: 'files', code: 'too_many' });
    expect((await submit('agent', { data: { section: 'bank', payload: { rib: '123', bankName: 'BNA' } } }).expect(422)).body.errors[0].field).toBe('payload.rib');
    // nothing was written
    expect(await query(db.superuserUrl, 'select id from profile_change_request where employment_id = $1', [AGENT])).toEqual([]);
  });
});

describe('immediate contact change', () => {
  it('applied at once (status applied), normalised, audited with values masked', async () => {
    const res = await submit('agent', { data: { section: 'contact', payload: CONTACT, comment: 'Nouveau numéro' } }).expect(201);
    expect(res.body).toMatchObject({ section: 'contact', status: 'applied', workflow: null, _actions: [] });
    expect(res.body.changedFields).toEqual(expect.arrayContaining(['mobilePhone', 'personalEmail', 'commune']));
    expect(res.body.decidedAt).not.toBeNull();
    const profile = (await client('agent').get('/api/me/profile').expect(200)).body;
    expect(profile.personal.contact.mobilePhone).toBe('+213555123456');
    const events = await query<{ type: string; data: Record<string, unknown> }>(db.superuserUrl, `select type, data from audit.event where company_id = $1 and subject_id = $2`, [COMPANY_A, res.body.id]);
    expect(events.map((e) => e.type)).toContain('profile.applied');
    const log = JSON.stringify(await query(db.superuserUrl, `select before, after from audit.change_log where company_id = $1 and table_name in ('profile_change_request', 'person_contact')`, [COMPANY_A]));
    expect(log).not.toContain('555123456');
    expect(log).not.toContain('agent.test@exemple.test');
    expect(log).not.toContain('Jasmins');
    const mine = (await client('agent').get('/api/me/profile/requests').expect(200)).body.items;
    expect(mine.map((r: { id: string }) => r.id)).toContain(res.body.id);
  });
});

describe('family request with a supporting file → HR approval', () => {
  const ids = { request: '', file: '' };

  it('pending with its file and workflow; a second one is 409 profile-request-pending', async () => {
    const res = await submit('agent', { data: { section: 'family', payload: FAMILY([NEW_CHILD]), comment: 'Naissance' }, files: [{ content: PDF, name: 'livret-de-famille.pdf' }] }).expect(201);
    ids.request = res.body.id;
    ids.file = res.body.files[0].id;
    expect(res.body).toMatchObject({ status: 'pending', _actions: ['cancel'], changedSince: false, comment: 'Naissance' });
    expect(res.body.changedFields).toEqual(['maritalStatus', 'maritalStatusSince', 'spouseEmployed', 'children']);
    expect(res.body.files[0]).toMatchObject({ filename: 'livret-de-famille.pdf', mime: 'application/pdf', purged: false });
    expect(res.body.workflow.status).toBe('pending');
    expect(slug((await submit('agent', { data: { section: 'family', payload: FAMILY([]) }, files: [{ content: PDF, name: 'a.pdf' }] }).expect(409)).body)).toBe('profile-request-pending');
    expect((await client('agent').get('/api/me/profile').expect(200)).body.pending).toEqual([{ id: ids.request, section: 'family', requestedAt: res.body.requestedAt }]);
  });

  it('the task: summary without values; the HR list in scope', async () => {
    const tasks = (await client('est').get('/api/tasks?status=open').expect(200)).body.items as { subject: Record<string, unknown> }[];
    const task = tasks.find((t) => t.subject['id'] === ids.request);
    expect(task?.subject).toMatchObject({ section: 'family', changedFields: ['maritalStatus', 'maritalStatusSince', 'spouseEmployed', 'children'], files: 1 });
    expect(JSON.stringify(task)).not.toContain('Nour');
    const est = (await client('est').get('/api/profile/requests?status=pending').expect(200)).body;
    expect(est.items.map((r: { id: string }) => r.id)).toContain(ids.request);
    assertNoSecrets(est);
    await client('ouest').get('/api/profile/requests').expect(403);
    await client('agent').get('/api/profile/requests').expect(403);
    await client('acces').get('/api/profile/requests').expect(403);
    // another region's HR does not see it: a regional grant on Région Ouest only
    const beta = (await client('beta').get('/api/profile/requests').expect(200)).body;
    expect(beta.total).toBe(0);
  });

  it('files: the requester while pending, HR candidates; others 404; sandbox headers', async () => {
    const own = await client('agent').get(`/api/me/profile/requests/${ids.request}/files/${ids.file}`).expect(200);
    expect(own.headers['content-security-policy']).toBe("sandbox; default-src 'none'");
    expect(own.headers['x-content-type-options']).toBe('nosniff');
    expect(own.headers['content-disposition']).toContain('attachment');
    expect(Buffer.from(own.body as Buffer).equals(PDF)).toBe(true);
    await client('est').get(`/api/profile/requests/${ids.request}/files/${ids.file}`).expect(200);
    await client('chef').get(`/api/me/profile/requests/${ids.request}/files/${ids.file}`).expect(404);
    await client('ouest').get(`/api/profile/requests/${ids.request}/files/${ids.file}`).expect(404);
    await client('ouest').get(`/api/profile/requests/${ids.request}`).expect(404);
    await client('beta').get(`/api/profile/requests/${ids.request}`).expect(404);
    await client('chef').post(`/api/me/profile/requests/${ids.request}/cancel`).expect(404);
  });

  it('changed since the request: HR edits the family meanwhile → changedSince on the detail', async () => {
    await client('est').put(`/api/employees/${AGENT}/family`).send({ maritalStatus: 'married', maritalStatusSince: '2019-05-10', spouseEmployed: 'yes', children: [] }).expect(200);
    const detail = (await client('est').get(`/api/profile/requests/${ids.request}`).expect(200)).body;
    expect(detail.changedSince).toBe(true);
    expect(detail.history.length).toBe(1);
    expect(detail.payload.children[0].firstName).toBe('Nour');
  });

  it('approval applies the request values and copies the file into the employee file', async () => {
    const taskId = await taskOf('est', ids.request);
    expect(taskId).toBeDefined();
    await client('est').post(`/api/tasks/${taskId}/approve`).send({}).expect(200);
    const personal = (await client('agent').get('/api/me/profile').expect(200)).body.personal;
    expect(personal.family).toMatchObject({ maritalStatus: 'married', spouseEmployed: 'no' });
    expect(personal.family.children.map((c: { firstName: string }) => c.firstName)).toEqual(['Nour']);
    const files = (await client('est').get(`/api/employees/${AGENT}/files`).expect(200)).body.items as { category: { code: string }; title: string }[];
    const copy = files.find((f) => f.category.code === 'supporting_document');
    expect(copy?.title).toMatch(/^Situation familiale — demande du \d{2}\/\d{2}\/\d{4}$/);
    const request = (await client('agent').get('/api/me/profile/requests?status=approved').expect(200)).body.items[0];
    expect(request).toMatchObject({ id: ids.request, status: 'approved', _actions: [] });
    // the requester's download stops once decided
    await client('agent').get(`/api/me/profile/requests/${ids.request}/files/${ids.file}`).expect(404);
    expect(await notifications(USERS.agent.id, 'profile.change_approved')).toHaveLength(1);
    const [notice] = await notifications(USERS.agent.id, 'profile.change_approved');
    expect(JSON.stringify(notice?.data)).not.toContain('Nour');
    expect(slug((await client('agent').post(`/api/me/profile/requests/${ids.request}/cancel`).expect(409)).body)).toBe('profile-not-cancellable');
  });
});

describe('identity note → rejected', () => {
  it('rejecting needs a comment, the employee is told and sees the comment', async () => {
    const res = await submit('agent', { data: { section: 'identity_note', payload: { note: 'Mon lieu de naissance est Annaba, pas Constantine.' } } }).expect(201);
    expect(res.body).toMatchObject({ status: 'pending', changedFields: ['note'], before: null });
    const taskId = await taskOf('est', res.body.id);
    await client('est').post(`/api/tasks/${taskId}/reject`).send({}).expect(422);
    await client('est').post(`/api/tasks/${taskId}/reject`).send({ comment: 'Votre acte de naissance indique Constantine.' }).expect(200);
    const mine = (await client('agent').get('/api/me/profile/requests?status=rejected').expect(200)).body.items;
    expect(mine[0]).toMatchObject({ id: res.body.id, rejectionComment: 'Votre acte de naissance indique Constantine.' });
    expect(await notifications(USERS.agent.id, 'profile.change_rejected')).toHaveLength(1);
  });
});

describe('bank requests', () => {
  const ids = { cancelled: '', approved: '' };
  const RIB = '00799999000123456789';

  it('regional HR neither lists nor reads them; the requester sees its own RIB; cancel', async () => {
    const res = await submit('agent', { data: { section: 'bank', payload: { rib: '0079 9999 0001 2345 6789', bankName: 'CPA' } }, files: [{ content: PDF2, name: 'rib.pdf' }] }).expect(201);
    ids.cancelled = res.body.id;
    expect(res.body.payload).toEqual({ rib: RIB, bankName: 'CPA' });
    expect((await client('est').get('/api/profile/requests').expect(200)).body.items.map((r: { id: string }) => r.id)).not.toContain(ids.cancelled);
    await client('est').get(`/api/profile/requests/${ids.cancelled}`).expect(404);
    expect(await taskOf('est', ids.cancelled)).toBeUndefined();
    const admin = (await client('admin').get(`/api/profile/requests/${ids.cancelled}`).expect(200)).body;
    expect(admin.payload.rib).toBe(RIB);
    const cancelled = (await client('agent').post(`/api/me/profile/requests/${ids.cancelled}/cancel`).expect(200)).body;
    expect(cancelled.status).toBe('cancelled');
    expect(slug((await client('agent').post(`/api/me/profile/requests/${ids.cancelled}/cancel`).expect(409)).body)).toBe('profile-not-cancellable');
  });

  it('central HR approves: RIB applied, the security notice is e-mailed even with the preference off', async () => {
    await query(db.superuserUrl, `insert into notification_preference (company_id, user_id, type, email) values ($1, $2, 'profile.bank_changed', false)`, [COMPANY_A, USERS.agent.id]);
    const res = await submit('agent', { data: { section: 'bank', payload: { rib: RIB, bankName: 'CPA' } }, files: [{ content: PDF2, name: 'rib.pdf' }] }).expect(201);
    ids.approved = res.body.id;
    const taskId = await taskOf('admin', ids.approved);
    await client('admin').post(`/api/tasks/${taskId}/approve`).send({}).expect(200);
    const bank = (await client('admin').get(`/api/employees/${AGENT}`).expect(200)).body.bank;
    expect(bank).toEqual({ rib: RIB, bankName: 'CPA' });
    expect((await client('agent').get('/api/me/profile').expect(200)).body.bank).toEqual({ ribMasked: '•••• •••• 6789', bankName: 'CPA' });
    const [notice] = await notifications(USERS.agent.id, 'profile.bank_changed');
    expect(notice).toBeDefined();
    expect(await notifications(USERS.agent.id, 'profile.change_approved')).toHaveLength(1); // only the family one
    const result = await emailTask(deps, { companyId: COMPANY_A, notificationId: notice?.id }, job());
    expect(result['outcome']).toBe('sent');
    expect(sent.at(-1)?.to).toBe(USERS.agent.email);
    expect(JSON.stringify(sent)).not.toContain(RIB);
    // the preference cannot be turned off
    await client('agent').put('/api/me/notification-preferences').send([{ type: 'profile.bank_changed', email: false }]).expect(422);
    const log = JSON.stringify(await query(db.superuserUrl, `select before, after from audit.change_log where company_id = $1 and table_name in ('profile_change_request', 'person_sensitive')`, [COMPANY_A]));
    expect(log).not.toContain(RIB);
  });
});

describe('self-approval', () => {
  it('an HR user’s own request goes to another HR user', async () => {
    const res = await submit('est', { data: { section: 'identity_note', payload: { note: 'Mon prénom arabe est mal orthographié.' } } }).expect(201);
    const [task] = await query<{ id: string }>(db.superuserUrl, `select t.id::text from workflow_task t join workflow_instance i on i.id = t.instance_id where i.subject_id = $1`, [res.body.id]);
    expect(await taskOf('est', res.body.id)).toBeUndefined();
    expect(slug((await client('est').post(`/api/tasks/${task?.id}/approve`).send({}).expect(409)).body)).toBe('workflow-self-approval');
    await client('admin').post(`/api/tasks/${task?.id}/approve`).send({}).expect(200);
    expect(KARIM).toBe(res.body.employee.id);
  });
});

describe('worker purge', () => {
  it('rejected / cancelled files after the retention, approved ones once copied; idempotent; least privilege', async () => {
    await query(db.superuserUrl, `alter table profile_change_request disable trigger profile_change_request_guard_tg`);
    await query(db.superuserUrl, `update profile_change_request set decided_at = now() - interval '40 days' where status = 'cancelled'`);
    await query(db.superuserUrl, `alter table profile_change_request enable trigger profile_change_request_guard_tg`);
    const first = await profileFilesPurgeTask(deps, {}, job());
    expect(first['requests']).toBe(3); // the approved family and bank requests (copied) + the cancelled bank one (40 days)
    const rows = await query<{ status: string; purged: boolean; files_purged_at: Date | null }>(
      db.superuserUrl,
      `select r.status, bool_and(f.content is null) as purged, r.files_purged_at from profile_change_request r join profile_change_file f on f.request_id = r.id group by r.id`,
    );
    expect(rows.every((r) => r.purged && r.files_purged_at !== null)).toBe(true);
    expect((await profileFilesPurgeTask(deps, {}, job()))['requests']).toBe(0);
    const [view] = (await client('agent').get('/api/me/profile/requests?status=cancelled').expect(200)).body.items;
    expect(view.files[0].purged).toBe(true);
    // the worker cannot change anything else of a request or a file
    await expect(query(db.workerUrl, `begin; select set_config('app.company_id', '${COMPANY_A}', true); update profile_change_request set status = 'approved'; commit;`)).rejects.toThrow(/permission denied/);
    await expect(query(db.workerUrl, `begin; select set_config('app.company_id', '${COMPANY_A}', true); delete from profile_change_file; commit;`)).rejects.toThrow(/permission denied/);
  });
});

describe('settings', () => {
  it('central HR reads and changes the policy; regional HR and others 403; validation 422', async () => {
    expect((await client('admin').get('/api/profile/settings').expect(200)).body).toEqual({ contactMode: 'immediate', emergencyMode: 'immediate', familyMode: 'approval', fileRetentionDays: 30 });
    await client('est').get('/api/profile/settings').expect(403);
    await client('agent').put('/api/profile/settings').send({ contactMode: 'approval', emergencyMode: 'immediate', familyMode: 'approval', fileRetentionDays: 30 }).expect(403);
    await client('admin').put('/api/profile/settings').send({ contactMode: 'approval', emergencyMode: 'immediate', familyMode: 'approval', fileRetentionDays: 5 }).expect(422);
    const saved = (await client('admin').put('/api/profile/settings').send({ contactMode: 'approval', emergencyMode: 'immediate', familyMode: 'approval', fileRetentionDays: 60 }).expect(200)).body;
    expect(saved).toMatchObject({ contactMode: 'approval', fileRetentionDays: 60 });
    expect((await client('agent').get('/api/me/profile').expect(200)).body.modes.contact).toBe('approval');
    // a contact change now goes to HR (no file needed)
    const res = await submit('agent', { data: { section: 'contact', payload: { ...CONTACT, commune: 'El Bouni' } } }).expect(201);
    expect(res.body.status).toBe('pending');
    await client('admin').put('/api/profile/settings').send({ contactMode: 'immediate', emergencyMode: 'immediate', familyMode: 'approval', fileRetentionDays: 30 }).expect(200);
  });
});

describe('History', () => {
  it('the employee timeline lists the request events', async () => {
    const res = await client('admin').get(`/api/audit/timeline?subject=employee:${AGENT}&limit=100`).expect(200);
    expect(JSON.stringify(res.body)).toContain('profile.requested');
  });
});

describe('seed', () => {
  it('seedDemoProfileRequests: pending family (with a file, at the HR step), applied contact, rejected bank; idempotent', async () => {
    const { DEMO_PROFILE_REQUESTS, seedDemoProfileRequests } = await import('../src/modules/profile/index.js');
    const migrator = createDatabase({ connectionString: db.migratorUrl, maxConnections: 1 });
    try {
      expect(await migrator.transaction().execute((tx) => seedDemoProfileRequests(tx, COMPANY_A))).toBe(3);
      expect(await migrator.transaction().execute((tx) => seedDemoProfileRequests(tx, COMPANY_A))).toBe(0);
    } finally {
      await migrator.destroy();
    }
    const detail = (await client('est').get(`/api/profile/requests/${DEMO_PROFILE_REQUESTS.pendingFamily}`).expect(200)).body;
    expect(detail).toMatchObject({ status: 'pending', section: 'family' });
    expect(detail.files).toHaveLength(1);
    expect(await taskOf('est', DEMO_PROFILE_REQUESTS.pendingFamily)).toBeDefined();
    const rejected = (await client('agent').get('/api/me/profile/requests?status=rejected').expect(200)).body.items.find((r: { id: string }) => r.id === DEMO_PROFILE_REQUESTS.rejectedBank);
    expect(rejected.rejectionComment).toMatch(/illisible/);
  });
});
