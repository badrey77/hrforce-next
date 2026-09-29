/**
 * Documents, Phase B — the employee file (docs/contracts/documents.md › Phase B) against the real grants (DEV_AUTH
 * header identity, no DEV_PERMISSIONS): upload / list / download / delete per permission and scope, content sniffing
 * and the size limit, download headers (attachment, safe names, nosniff, sandbox), audited downloads, medical files
 * (invisible without employee.medical.read, not addable without employee.medical.update), tombstones, duplicates,
 * rehire, categories, the timeline, the database guards and the retention purge run by the worker role.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client } from 'pg';
import { pino } from 'pino';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { demoLogoPng, demoPdf, DocumentsClock } from '../src/modules/documents/index.js';
import { LeaveClock } from '../src/modules/leave/index.js';
import { StaffingClock } from '../src/modules/staffing/index.js';
import { createDatabase, type Database } from '../src/platform/db/database.js';
import { employeeFilesRetentionTask, type WorkerDeps } from '../src/worker/tasks.js';
import { as, COMPANY_A, EMPLOYEE_B, employeeA, seedAccessFixture, unitA, USERS, type ActorName } from './support/access-fixture.js';
import { assertNoSecrets } from './support/assert-no-secrets.js';
import { createTestApp } from './support/test-app.js';
import { createTestDatabase, query, type TestDatabase } from './support/test-database.js';
import { fetchXsrf, type XsrfPair } from './support/xsrf.js';

interface FileView {
  id: string;
  employmentId: string;
  category: { id: string; code: string; accessClass: string; labels: { fr: string; ar: string; en: string } };
  title: string;
  originalFilename: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
  documentDate: string | null;
  expiresOn: string | null;
  uploadedBy: { id: string; displayName: string } | null;
  deleted: { at: string; by: { id: string } | null; reason: string } | null;
  purgedAt: string | null;
  _actions: string[];
}
interface ListView {
  items: FileView[];
  _redacted: string[];
  _actions: string[];
}

const MAX = 10 * 1024 * 1024;
const EST = employeeA(27); // Agence Constantine (Région Est)
const OUEST = employeeA(36); // Agence Oran (Région Ouest)
const ENDED = employeeA(25); // Agence Constantine, ended 2026-06-30
const PROBLEM = (slug: string) => `urn:hrforce:problem:${slug}`;

let db: TestDatabase;
let app: NestExpressApplication;
let xsrf: XsrfPair;
const cat: Record<string, string> = {};
let seq = 0;

const client = (actor: ActorName) => as(app, actor, xsrf);
/** A unique, valid PDF. */
const pdf = (label = `n${++seq}`) => demoPdf(`TEST DATA - ${label}`);

function binary(res: Response, callback: (error: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

function upload(actor: ActorName, employmentId: string, file: Buffer | null, fields: Record<string, string> = {}, filename = 'piece.pdf') {
  let req = client(actor).post(`/api/employees/${employmentId}/files`);
  const all = { categoryId: cat['diploma'] ?? '', title: 'Pièce test', ...fields };
  for (const [k, v] of Object.entries(all)) req = req.field(k, v);
  if (file) req = req.attach('file', file, { filename, contentType: 'application/octet-stream' });
  return req;
}

async function uploaded(actor: ActorName, employmentId: string, file: Buffer, fields: Record<string, string> = {}, filename?: string): Promise<FileView> {
  const res = await upload(actor, employmentId, file, fields, filename);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as FileView;
}

async function download(actor: ActorName, employmentId: string, fileId: string) {
  return client(actor).get(`/api/employees/${employmentId}/files/${fileId}/content`).buffer(true).parse(binary);
}

/** A multipart body built by hand (to send a filename* with CR/LF, quotes and bidi controls). */
function rawMultipart(fields: Record<string, string>, file: Buffer, filenameStar: string): { body: Buffer; type: string } {
  const boundary = 'hrforceBoundary7MA4YWxk';
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf8'));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename*=UTF-8''${filenameStar}\r\nContent-Type: text/html\r\n\r\n`, 'utf8'));
  parts.push(file, Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${boundary}` };
}

/** Runs one statement as `url`'s role in company A's tenant (RLS applies), in its own transaction. */
async function asRole(url: string, statement: string, params: unknown[] = []): Promise<void> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('app.company_id', $1, true)`, [COMPANY_A]);
    await c.query(statement, params);
    await c.query('commit');
  } catch (error) {
    await c.query('rollback');
    throw error;
  } finally {
    await c.end();
  }
}

const inTenant = (statement: string, params: unknown[] = []) => asRole(db.appUrl, statement, params);
const asWorker = (statement: string) => asRole(db.workerUrl, statement);

const codeOf = (res: { body: { errors?: { field: string; code: string }[] } }) => res.body.errors?.find((e) => e.field === 'file')?.code;

const events = async (type: string, fileId: string) =>
  (await query<{ n: number }>(db.superuserUrl, `select count(*)::int as n from audit.event where type = $1 and subject_type = 'employee_file' and subject_id = $2`, [type, fileId]))[0]?.n ?? 0;

beforeAll(async () => {
  db = await createTestDatabase();
  await seedAccessFixture(db, undefined, { leave: true, documents: true });
  const pinned = { today: () => '2026-09-26' };
  app = await createTestApp(db, {
    devAuth: true,
    devPermissions: false,
    overrides: [
      { provide: LeaveClock, useValue: pinned },
      { provide: StaffingClock, useValue: pinned },
      { provide: DocumentsClock, useValue: pinned },
    ],
  });
  xsrf = await fetchXsrf(app);
  for (const r of await query<{ id: string; code: string }>(db.superuserUrl, 'select id, code from employee_file_category where company_id = $1', [COMPANY_A])) cat[r.code] = r.id;
  // "médecin du travail": a custom role holding the medical permissions over REG-EST (no system role holds them, so
  // the API refuses to create it: role-escalation) — seeded by SQL, granted to newbie
  const [role] = await query<{ id: string }>(
    db.superuserUrl,
    `insert into role (company_id, code, name_fr, name_ar, name_en) values ($1, 'medecin', 'Médecin du travail', 'طبيب العمل', 'Occupational doctor') returning id`,
    [COMPANY_A],
  );
  for (const code of ['employee_file.read', 'employee_file.upload', 'employee_file.delete', 'employee.medical.read', 'employee.medical.update']) {
    await query(db.superuserUrl, 'insert into role_permission (company_id, role_id, permission_code) values ($1, $2, $3)', [COMPANY_A, role?.id, code]);
  }
  await query(
    db.superuserUrl,
    `insert into role_grant (company_id, user_id, role_id, org_unit_id, include_descendants, valid_from) values ($1, $2, $3, $4, true, '2026-01-01')`,
    [COMPANY_A, USERS.newbie.id, role?.id, unitA('REG-EST')],
  );
});

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

// ---------------------------------------------------------------------------------------------------------------
describe('categories', () => {
  it('GET: the five system categories for anyone signed in (medical one medical, no retention)', async () => {
    const res = await client('agent').get('/api/employee-files/categories').expect(200);
    const items = res.body.items as { code: string; accessClass: string; retentionYearsAfterEnd: number | null; isSystem: boolean; active: boolean; labels: { ar: string } }[];
    expect(items.map((c) => c.code)).toEqual(['diploma', 'contract', 'id_document', 'medical', 'other']);
    expect(items.every((c) => c.isSystem && c.active && c.retentionYearsAfterEnd === null)).toBe(true);
    expect(items.filter((c) => c.accessClass === 'medical').map((c) => c.code)).toEqual(['medical']);
    expect(items.find((c) => c.code === 'medical')?.labels.ar).toBe('طبي');
  });

  it('POST / PUT with document.configure over the company; standard only; code taken; validation; scope', async () => {
    const created = await client('admin')
      .post('/api/employee-files/categories')
      .send({ code: 'training', labels: { fr: 'Formations', ar: 'التكوين', en: 'Training' }, retentionYearsAfterEnd: 5 })
      .expect(201);
    expect(created.body).toMatchObject({ code: 'training', accessClass: 'standard', isSystem: false, retentionYearsAfterEnd: 5, active: true, sortOrder: 60 });
    const taken = await client('admin').post('/api/employee-files/categories').send({ code: 'training', labels: { fr: 'x', ar: 'س', en: 'x' } }).expect(409);
    expect(taken.body).toMatchObject({ type: PROBLEM('category-code-taken'), errors: [{ field: 'code' }] });
    const bad = await client('admin').post('/api/employee-files/categories').send({ code: 'Bad Code', labels: { fr: 'x', ar: 'س', en: 'x' }, retentionYearsAfterEnd: 0 }).expect(422);
    expect((bad.body.errors as { field: string }[]).map((e) => e.field).toSorted()).toEqual(['code', 'retentionYearsAfterEnd']);
    // an unknown accessClass key is ignored: created categories are always standard
    const medicalTry = await client('admin').post('/api/employee-files/categories').send({ code: 'medical2', accessClass: 'medical', labels: { fr: 'x', ar: 'س', en: 'x' } });
    expect(medicalTry.body.accessClass ?? 'standard').toBe('standard');
    const put = await client('admin').put(`/api/employee-files/categories/${created.body.id}`).send({ retentionYearsAfterEnd: null, active: false }).expect(200);
    expect(put.body).toMatchObject({ retentionYearsAfterEnd: null, active: false });
    await client('est').post('/api/employee-files/categories').send({ code: 'x_est', labels: { fr: 'x', ar: 'س', en: 'x' } }).expect(403);
    await client('beta').put(`/api/employee-files/categories/${created.body.id}`).send({ active: true }).expect(404);
    // uploading into the inactive category → 422 inactive
    const inactive = await upload('admin', EST, pdf(), { categoryId: created.body.id }).expect(422);
    expect(inactive.body.errors).toEqual([expect.objectContaining({ field: 'categoryId', code: 'inactive' })]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('upload, list, download, delete per permission and scope', () => {
  it('admin_rh_central everywhere; rh_regional within its region; lecture, admin_acces, employees refused', async () => {
    const mine = await uploaded('admin', EST, pdf(), { title: '  Licence  ', documentDate: '2012-07-01', expiresOn: '' }, 'licence.pdf');
    expect(mine).toMatchObject({ employmentId: EST, title: 'Licence', mime: 'application/pdf', originalFilename: 'licence.pdf', documentDate: '2012-07-01', expiresOn: null, deleted: null, purgedAt: null });
    expect(mine.uploadedBy).toEqual({ id: USERS.admin.id, displayName: USERS.admin.displayName });
    expect(mine.sha256).toMatch(/^[0-9a-f]{64}$/);
    assertNoSecrets(mine);

    const estFile = await uploaded('est', EST, pdf());
    expect(estFile).toMatchObject({ _actions: [] }); // rh_regional has no employee_file.delete
    await uploaded('admin', OUEST, pdf());
    expect((await upload('est', OUEST, pdf())).status).toBe(404);
    expect((await upload('ouest', OUEST, pdf())).status).toBe(403);
    expect((await upload('acces', EST, pdf())).status).toBe(403);
    expect((await upload('agent', EST, pdf())).status).toBe(403);
    expect((await upload('beta', EST, pdf())).status).toBe(404);
    // an ended employment accepts files (archiving after departure)
    await uploaded('admin', ENDED, pdf());

    const list = (await client('est').get(`/api/employees/${EST}/files`).expect(200)).body as ListView;
    expect(list.items.map((f) => f.id)).toEqual(expect.arrayContaining([mine.id, estFile.id]));
    expect(list).toMatchObject({ _actions: ['upload'], _redacted: ['medical'] });
    expect((await client('admin').get(`/api/employees/${EST}/files`).expect(200)).body.items.find((f: FileView) => f.id === estFile.id)).toMatchObject({ _actions: ['delete'] });
    await client('est').get(`/api/employees/${OUEST}/files`).expect(404);
    await client('ouest').get(`/api/employees/${OUEST}/files`).expect(403);
    await client('acces').get(`/api/employees/${EST}/files`).expect(403);
    await client('agent').get(`/api/employees/${EST}/files`).expect(403);
    await client('beta').get(`/api/employees/${EST}/files`).expect(404);
    await client('admin').get(`/api/employees/${EMPLOYEE_B.employmentId}/files`).expect(404);
    await client('admin').get(`/api/employees/not-a-uuid/files`).expect(404);

    expect((await download('est', EST, mine.id)).status).toBe(200);
    expect((await download('est', OUEST, mine.id)).status).toBe(404);
    expect((await download('ouest', EST, mine.id)).status).toBe(403);
    expect((await download('beta', EST, mine.id)).status).toBe(404);
    // a file id through another employee's URL → 404
    const other = (await client('admin').get(`/api/employees/${OUEST}/files`).expect(200)).body as ListView;
    expect((await download('admin', EST, other.items[0]?.id ?? '')).status).toBe(404);

    await client('est').post(`/api/employees/${EST}/files/${mine.id}/delete`).send({ reason: 'Doublon' }).expect(403);
    await client('ouest').post(`/api/employees/${EST}/files/${mine.id}/delete`).send({ reason: 'Doublon' }).expect(403);
    await client('beta').post(`/api/employees/${EST}/files/${mine.id}/delete`).send({ reason: 'Doublon' }).expect(404);
  });

  it('the upload runs in its own transaction with the caller as the audit actor', async () => {
    const file = await uploaded('est', EST, pdf());
    const rows = await query<{ actor_user_id: string; op: string }>(db.superuserUrl, `select actor_user_id, op from audit.change_log where table_name = 'employee_file' and row_id = $1`, [file.id]);
    expect(rows).toEqual([{ actor_user_id: USERS.est.id, op: 'insert' }]);
    const content = await query<{ n: number }>(db.superuserUrl, 'select octet_length(content)::int as n from employee_file_content where file_id = $1', [file.id]);
    expect(content[0]?.n).toBe(file.sizeBytes);
  });

  it('a duplicate of a live file of the same employee → 409 employee-file-duplicate; after deletion it can be added again', async () => {
    const bytes = pdf();
    const first = await uploaded('admin', EST, bytes);
    const dup = await upload('admin', EST, bytes).expect(409);
    expect(dup.body).toMatchObject({ type: PROBLEM('employee-file-duplicate'), errors: [{ field: 'file', code: 'duplicate' }] });
    await uploaded('admin', OUEST, bytes); // another employee: fine
    await client('admin').post(`/api/employees/${EST}/files/${first.id}/delete`).send({ reason: 'Remplacée' }).expect(204);
    await uploaded('admin', EST, bytes);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('content sniffing and size', () => {
  it('type by content only: fake PDF, polyglots, SVG renamed .png, text → unsupported_type; empty → empty; none → required', async () => {
    const fakePdf = Buffer.from('%PDF-1.7\n<script>alert(1)</script>\n', 'latin1');
    expect(codeOf(await upload('admin', EST, fakePdf, {}, 'fake.pdf').expect(422))).toBe('unsupported_type');
    const htmlPolyglot = Buffer.concat([Buffer.from('<html><body><script>alert(1)</script>\n', 'latin1'), pdf()]);
    expect(codeOf(await upload('admin', EST, htmlPolyglot, {}, 'poly.pdf').expect(422))).toBe('unsupported_type');
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect/></svg>');
    expect(codeOf(await upload('admin', EST, svg, {}, 'image.png').expect(422))).toBe('unsupported_type');
    expect(codeOf(await upload('admin', EST, Buffer.from('MZ\x90\x00 not an image'), {}, 'photo.jpg').expect(422))).toBe('unsupported_type');
    expect(codeOf(await upload('admin', EST, Buffer.alloc(0), {}, 'empty.pdf').expect(422))).toBe('empty');
    expect(codeOf(await upload('admin', EST, null).expect(422))).toBe('required');
    // two files → one_file_only; a declared Content-Type or extension never matters (PNG sent as .pdf is a PNG)
    const two = await client('admin').post(`/api/employees/${EST}/files`).field('categoryId', cat['diploma'] ?? '').field('title', 'x')
      .attach('file', pdf(), 'a.pdf').attach('file', pdf(), 'b.pdf').expect(422);
    expect(codeOf(two)).toBe('one_file_only');
    const png = await uploaded('admin', EST, demoLogoPng(), {}, 'logo.pdf');
    expect(png.mime).toBe('image/png');
    const jpeg = await uploaded('admin', EST, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`jpeg ${++seq}`)]), {}, 'photo.jpeg');
    expect(jpeg.mime).toBe('image/jpeg');
  });

  it('a PDF-headed polyglot is accepted as a PDF and only ever served as an attachment with nosniff and a sandbox CSP', async () => {
    const polyglot = Buffer.from(`%PDF-1.4\n<html><script>alert(document.cookie)</script></html>\n%%EOF\n`, 'latin1');
    const file = await uploaded('admin', EST, polyglot, {}, 'page.html');
    const res = await download('admin', EST, file.id);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe(`attachment; filename="page.html.pdf"; filename*=UTF-8''page.html.pdf`);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe("sandbox; default-src 'none'");
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(Buffer.compare(res.body as Buffer, polyglot)).toBe(0);
  });

  it(`the ${MAX}-byte limit: exactly the limit is accepted, one byte more is 422 too_large (never 413/500)`, async () => {
    const head = Buffer.from('%PDF-1.4\n%', 'latin1');
    const tail = Buffer.from('\n%%EOF\n', 'latin1');
    const exact = Buffer.concat([head, Buffer.alloc(MAX - head.length - tail.length, 0x41), tail]);
    expect(exact.length).toBe(MAX);
    const ok = await uploaded('admin', EST, exact, {}, 'big.pdf');
    expect(ok.sizeBytes).toBe(MAX);
    const over = Buffer.concat([head, Buffer.alloc(MAX + 1 - head.length - tail.length, 0x42), tail]);
    const res = await upload('admin', EST, over, {}, 'too-big.pdf');
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ type: PROBLEM('validation-error'), errors: [{ field: 'file', code: 'too_large' }] });
  });

  it('field validation: category, title and dates', async () => {
    const res = await upload('admin', EST, pdf(), { categoryId: 'nope', title: '', documentDate: '2026-02-30' }).expect(422);
    expect((res.body.errors as { field: string }[]).map((e) => e.field).toSorted()).toEqual(['categoryId', 'documentDate', 'title']);
    const unknown = await upload('admin', EST, pdf(), { categoryId: '0190a5d0-0000-7000-8000-00000000dead' }).expect(422);
    expect(unknown.body.errors).toEqual([expect.objectContaining({ field: 'categoryId', code: 'not_found' })]);
    const order = await upload('admin', EST, pdf(), { documentDate: '2026-05-01', expiresOn: '2026-04-01' }).expect(422);
    expect(order.body.errors).toEqual([expect.objectContaining({ field: 'expiresOn', code: 'before_document_date' })]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('download names and audit', () => {
  it('RTL, quotes, CR/LF and bidi overrides in the original name: stored clean, header safe', async () => {
    const name = `عقد "عمل"\r\nX-Injected: 1\u202Egnp.pdf`;
    const bytes = pdf();
    const { body, type } = rawMultipart({ categoryId: cat['contract'] ?? '', title: 'Contrat' }, bytes, encodeURIComponent(name));
    const res = await client('admin').post(`/api/employees/${EST}/files`).set('Content-Type', type).send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const file = res.body as FileView;
    expect(file.originalFilename).toBe('عقد "عمل"X-Injected: 1gnp.pdf');
    const dl = await download('admin', EST, file.id);
    expect(dl.status).toBe(200);
    const header = String(dl.headers['content-disposition']);
    expect(header).toMatch(/^attachment; filename="[A-Za-z0-9._-]+"; filename\*=UTF-8''[A-Za-z0-9%._~!-]+$/);
    expect(header).not.toMatch(/[\r\n]|X-Injected: /);
    expect(header.match(/"/g)).toHaveLength(2); // only the fallback's own quotes
    expect(decodeURIComponent(header.split("UTF-8''")[1] ?? '')).toBe('عقد "عمل"X-Injected: 1gnp.pdf');
    expect(dl.headers['x-injected']).toBeUndefined();
  });

  it('a browser-style filename="…" in raw UTF-8 (Arabic, accents, bidi override) is read as UTF-8', async () => {
    // what Chrome/Firefox send: no filename*, the name's UTF-8 bytes inside the quotes (" → %22, CR/LF → %0D%0A)
    const boundary = 'hrforceBoundaryUtf8Raw';
    const name = 'عقد العمل — été‮gnp.pdf';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="categoryId"\r\n\r\n${cat['contract'] ?? ''}\r\n`, 'utf8'),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nعقد\r\n`, 'utf8'),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/pdf\r\n\r\n`, 'utf8'),
      pdf(),
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    ]);
    const res = await client('admin').post(`/api/employees/${EST}/files`).set('Content-Type', `multipart/form-data; boundary=${boundary}`).send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((res.body as FileView).originalFilename).toBe('عقد العمل — étégnp.pdf');
  });

  it('every download is audited (employee_file.downloaded with the category and class)', async () => {
    const file = await uploaded('admin', EST, pdf());
    expect(await events('employee_file.downloaded', file.id)).toBe(0);
    await download('admin', EST, file.id);
    await download('est', EST, file.id);
    expect(await events('employee_file.downloaded', file.id)).toBe(2);
    const [event] = await query<{ data: Record<string, unknown>; actor_user_id: string }>(
      db.superuserUrl,
      `select data, actor_user_id from audit.event where type = 'employee_file.downloaded' and subject_id = $1 order by at desc limit 1`,
      [file.id],
    );
    expect(event).toEqual({ data: { fileId: file.id, categoryCode: 'diploma', accessClass: 'standard' }, actor_user_id: USERS.est.id });
    // a refused download is not a download
    await download('ouest', EST, file.id);
    expect(await events('employee_file.downloaded', file.id)).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('medical files', () => {
  let medical: FileView;

  it('upload into medical needs employee.medical.update (admin_rh_central: 403 forbidden-field); the médecin role can', async () => {
    const refused = await upload('admin', EST, pdf(), { categoryId: cat['medical'] ?? '' }).expect(403);
    expect(refused.body).toMatchObject({ type: PROBLEM('forbidden-field'), errors: [{ field: 'categoryId' }] });
    medical = await uploaded('newbie', EST, pdf(), { categoryId: cat['medical'] ?? '', title: "Certificat d'aptitude" });
    expect(medical.category.accessClass).toBe('medical');
    expect(medical).toMatchObject({ _actions: ['delete'] });
    const theirs = (await client('newbie').get(`/api/employees/${EST}/files`).expect(200)).body as ListView;
    expect(theirs).toMatchObject({ _redacted: [], _actions: ['upload', 'upload_medical'] });
    expect(theirs.items.some((f) => f.id === medical.id)).toBe(true);
    // the médecin role covers REG-EST only
    await client('newbie').get(`/api/employees/${OUEST}/files`).expect(404);
  });

  it('without employee.medical.read: absent from the list (and _redacted), 404 on content, delete and timeline', async () => {
    for (const actor of ['admin', 'est'] as const) {
      const list = (await client(actor).get(`/api/employees/${EST}/files?includeDeleted=true`).expect(200)).body as ListView;
      expect(list.items.some((f) => f.id === medical.id)).toBe(false);
      expect(list.items.some((f) => f.category.accessClass === 'medical')).toBe(false);
      expect(list).toMatchObject({ _redacted: ['medical'], _actions: ['upload'] });
      const filtered = (await client(actor).get(`/api/employees/${EST}/files?categoryId=${cat['medical']}`).expect(200)).body as ListView;
      expect(filtered.items).toEqual([]);
      expect((await download(actor, EST, medical.id)).status).toBe(404);
    }
    await client('admin').post(`/api/employees/${EST}/files/${medical.id}/delete`).send({ reason: 'Essai' }).expect(404);
    expect(await events('employee_file.downloaded', medical.id)).toBe(0);

    // the timeline of the employee (audit.read: admin) omits the medical file's rows and events
    const dl = await download('newbie', EST, medical.id);
    expect(dl.status).toBe(200);
    expect(await events('employee_file.downloaded', medical.id)).toBe(1);
    const timeline = (await client('admin').get(`/api/audit/timeline?subject=employee:${EST}&limit=100`).expect(200)).body as { items: { kind: string; table?: string; event?: { type: string; data: { fileId?: string } }; changes?: { field: string; after: unknown }[] }[] };
    const fileRows = timeline.items.filter((i) => i.table === 'employee_file');
    expect(fileRows.length).toBeGreaterThan(0);
    expect(JSON.stringify(timeline.items)).not.toContain(medical.id);
    expect(JSON.stringify(timeline.items)).not.toContain("Certificat d'aptitude");
  });

  it('with employee.medical.read over the employee (and audit.read): the timeline shows them', async () => {
    const [role] = await query<{ id: string }>(db.superuserUrl, `select id from role where company_id = $1 and code = 'medecin'`, [COMPANY_A]);
    await query(db.superuserUrl, `insert into role_permission (company_id, role_id, permission_code) values ($1, $2, 'audit.read')`, [COMPANY_A, role?.id]);
    const timeline = (await client('newbie').get(`/api/audit/timeline?subject=employee:${EST}&limit=100`).expect(200)).body as { items: unknown[] };
    expect(JSON.stringify(timeline.items)).toContain(medical.id);
    expect(JSON.stringify(timeline.items)).toContain('employee_file.downloaded');
  });

  it('deleting a medical file needs employee.medical.update too', async () => {
    await client('newbie').post(`/api/employees/${EST}/files/${medical.id}/delete`).send({ reason: 'Erreur de dossier' }).expect(204);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('delete: tombstone kept, bytes removed', () => {
  it('204, metadata kept (deleted), content row gone, 404 on content, 409 the second time; includeDeleted for deleters only', async () => {
    const file = await uploaded('est', EST, pdf());
    await client('admin').post(`/api/employees/${EST}/files/${file.id}/delete`).send({ reason: 'x' }).expect(422);
    await client('admin').post(`/api/employees/${EST}/files/${file.id}/delete`).send({ reason: 'Pièce illisible' }).expect(204);
    const [row] = await query<{ deleted_at: Date | null; deleted_by: string; delete_reason: string; title: string }>(
      db.superuserUrl, 'select deleted_at, deleted_by, delete_reason, title from employee_file where id = $1', [file.id]);
    expect(row).toMatchObject({ deleted_by: USERS.admin.id, delete_reason: 'Pièce illisible', title: 'Pièce test' });
    expect(row?.deleted_at).not.toBeNull();
    expect(await query(db.superuserUrl, 'select 1 from employee_file_content where file_id = $1', [file.id])).toHaveLength(0);
    expect((await download('admin', EST, file.id)).status).toBe(404);
    const again = await client('admin').post(`/api/employees/${EST}/files/${file.id}/delete`).send({ reason: 'Encore' }).expect(409);
    expect(again.body.type).toBe(PROBLEM('employee-file-deleted'));
    expect(await events('employee_file.deleted', file.id)).toBe(1);

    const visible = async (actor: ActorName, q: string) => ((await client(actor).get(`/api/employees/${EST}/files${q}`).expect(200)).body as ListView).items.find((f) => f.id === file.id);
    expect(await visible('admin', '')).toBeUndefined();
    const shown = await visible('admin', '?includeDeleted=true');
    expect(shown).toMatchObject({ deleted: { reason: 'Pièce illisible', by: { id: USERS.admin.id } }, _actions: [] });
    expect(await visible('est', '?includeDeleted=true')).toBeUndefined(); // no employee_file.delete: ignored
  });

  it('database guards: the app role cannot delete metadata, change it, rewrite a tombstone or drop bytes of a live file', async () => {
    const file = await uploaded('admin', EST, pdf());
    {
      await expect(inTenant('delete from employee_file where id = $1', [file.id])).rejects.toThrow(/permission denied/);
      await expect(inTenant(`update employee_file set title = 'x' where id = $1`, [file.id])).rejects.toThrow(/only the tombstone/);
      await expect(inTenant('delete from employee_file_content where file_id = $1', [file.id])).rejects.toThrow(/tombstone/);
      await expect(inTenant(`update employee_file_content set content = '\\x00' where file_id = $1`, [file.id])).rejects.toThrow(/permission denied/);
      await expect(inTenant(`update employee_file_category set access_class = 'standard' where code = 'medical'`)).rejects.toThrow(/immutable/);
      await expect(inTenant(`insert into employee_file_category (company_id, code, name_fr, name_ar, name_en, access_class) values ($1, 'med2', 'x', 'x', 'x', 'medical')`, [COMPANY_A])).rejects.toThrow(/medical_system/);
      await inTenant(`update employee_file set deleted_at = now(), deleted_by = $2, delete_reason = 'Test garde' where id = $1`, [file.id, USERS.admin.id]);
      await expect(inTenant(`update employee_file set delete_reason = 'Autre raison' where id = $1`, [file.id])).rejects.toThrow(/only the tombstone/);
      await inTenant('delete from employee_file_content where file_id = $1', [file.id]);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('rehire: a person keeps the files of earlier employments', () => {
  it('the new employment lists the old one’s files; the old one does not list the new one’s', async () => {
    const oldFile = await uploaded('admin', ENDED, pdf(), { categoryId: cat['diploma'] ?? '', title: 'Diplôme (1er contrat)' });
    const [person] = await query<{ person_id: string }>(db.superuserUrl, 'select person_id from employment where id = $1', [ENDED]);
    const rehired = await client('admin')
      .post('/api/employees')
      .send({ personId: person?.person_id, matricule: 'EMP-R025', hireDate: '2026-09-01', orgUnitId: unitA('AG-CNE'), jobTitle: 'Chargé de clientèle' })
      .expect(201);
    const newId = (rehired.body as { id: string }).id;
    const newFile = await uploaded('est', newId, pdf(), { title: 'Contrat (2e)' , categoryId: cat['contract'] ?? '' });
    const onNew = ((await client('est').get(`/api/employees/${newId}/files`).expect(200)).body as ListView).items.map((f) => f.id);
    expect(onNew).toEqual(expect.arrayContaining([oldFile.id, newFile.id]));
    const onOld = ((await client('est').get(`/api/employees/${ENDED}/files`).expect(200)).body as ListView).items.map((f) => f.id);
    expect(onOld).toContain(oldFile.id);
    expect(onOld).not.toContain(newFile.id);
    // the old file downloads through the new employment's URL
    expect((await download('est', newId, oldFile.id)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('retention purge (worker role)', () => {
  let worker: Database;
  let deps: WorkerDeps;
  let jobSeq = 0;

  beforeAll(() => {
    worker = createDatabase({ connectionString: db.workerUrl, maxConnections: 2 });
    deps = {
      db: worker,
      logger: pino({ level: 'silent' }),
      mail: { send: () => Promise.resolve() },
      webBaseUrl: 'http://web.test',
    };
  });
  afterAll(async () => {
    await worker?.destroy();
  });

  it('no retention by default: nothing is purged', async () => {
    const result = await employeeFilesRetentionTask(deps, { today: '2090-01-01' }, { id: String(++jobSeq), attempt: 1 });
    // EMP-0025's person was rehired above (still employed); nobody else has a retention
    expect(result).toMatchObject({ purged: 0 });
  });

  it('files of people gone more than N years ago lose their bytes (metadata kept, purged_at, audited); others stay; idempotent', async () => {
    // EMP-0040 (Agence Tlemcen) retired 2026-03-31; its person has no other employment
    const retired = employeeA(40);
    const gone = await uploaded('admin', retired, pdf(), { categoryId: cat['other'] ?? '' });
    const stillHere = await uploaded('admin', EST, pdf(), { categoryId: cat['other'] ?? '' });
    const keptCategory = await uploaded('admin', retired, pdf(), { categoryId: cat['diploma'] ?? '' });
    await client('admin').put(`/api/employee-files/categories/${cat['other']}`).send({ retentionYearsAfterEnd: 2 }).expect(200);

    // 2028-03-31 is not after end + 2 years
    expect(await employeeFilesRetentionTask(deps, { today: '2028-03-31' }, { id: String(++jobSeq), attempt: 1 })).toMatchObject({ purged: 0 });
    const run = await employeeFilesRetentionTask(deps, { today: '2028-04-02' }, { id: String(++jobSeq), attempt: 1 });
    expect(run).toMatchObject({ today: '2028-04-02', purged: 1, companies: 2 });

    const rows = await query<{ id: string; purged_at: Date | null }>(db.superuserUrl, 'select id, purged_at from employee_file where id = any($1)', [[gone.id, stillHere.id, keptCategory.id]]);
    expect(rows.find((r) => r.id === gone.id)?.purged_at).not.toBeNull();
    expect(rows.filter((r) => r.purged_at !== null)).toHaveLength(1);
    const contents = await query<{ file_id: string }>(db.superuserUrl, 'select file_id from employee_file_content where file_id = any($1)', [[gone.id, stillHere.id, keptCategory.id]]);
    expect(contents.map((c) => c.file_id).toSorted()).toEqual([stillHere.id, keptCategory.id].toSorted());
    const [change] = await query<{ actor_user_id: string | null; request_id: string; changed: string[] }>(
      db.superuserUrl, `select actor_user_id, request_id, changed from audit.change_log where table_name = 'employee_file' and row_id = $1 and op = 'update'`, [gone.id]);
    expect(change).toMatchObject({ actor_user_id: null, changed: ['purged_at'] });
    expect(change?.request_id).toMatch(/^job:employee_files\.retention:/);
    const purgedEvents = await query<{ data: { count: number }; company_id: string }>(db.superuserUrl, `select data, company_id from audit.event where type = 'employee_file.purged'`);
    expect(purgedEvents).toEqual([{ data: { count: 1 }, company_id: COMPANY_A }]);

    // listed with includeDeleted (purgedAt set, no action), content 404
    const list = (await client('admin').get(`/api/employees/${retired}/files?includeDeleted=true`).expect(200)).body as ListView;
    expect(list.items.find((f) => f.id === gone.id)).toMatchObject({ deleted: null, _actions: [] });
    expect(list.items.find((f) => f.id === gone.id)?.purgedAt).not.toBeNull();
    expect(((await client('admin').get(`/api/employees/${retired}/files`).expect(200)).body as ListView).items.some((f) => f.id === gone.id)).toBe(false);
    expect((await download('admin', retired, gone.id)).status).toBe(404);

    // a second run changes nothing
    expect(await employeeFilesRetentionTask(deps, { today: '2028-04-02' }, { id: String(++jobSeq), attempt: 1 })).toMatchObject({ purged: 0 });
  });

  it('the worker role may only set purged_at and delete bytes', async () => {
    await expect(asWorker(`update employee_file set title = 'x'`)).rejects.toThrow(/permission denied/);
    await expect(asWorker('delete from employee_file')).rejects.toThrow(/permission denied/);
    await expect(asWorker(`insert into employee_file_content (file_id, company_id, content) values (gen_random_uuid(), '${COMPANY_A}', '\\x01')`)).rejects.toThrow(/permission denied/);
    await expect(employeeFilesRetentionTask(deps, { today: 'soon' }, { id: 'x', attempt: 1 })).rejects.toThrow(/YYYY-MM-DD/);
  });
});
