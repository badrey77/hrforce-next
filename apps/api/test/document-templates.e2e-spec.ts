/**
 * Document templates (docs/contracts/document-templates.md, ADR 008 amendment 2026-10-09) against the real grants, the
 * real Typst renderer and the demo seed: custom types, drafts (one per type, optimistic revision), validation, the
 * PDF preview (sample and real subject), publishing (versions, the type's mode, events), the return to a built-in,
 * issuing with a designed template (fields, numbering, replays, stored bytes that never change), self-service.
 * "Today" is pinned (DocumentsClock / LeaveClock / StaffingClock).
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Response } from 'supertest';
import { extractText, getDocumentProxy } from 'unpdf';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_TEMPLATES, DocumentsClock, seedDemoTemplates } from '../src/modules/documents/index.js';
import { createDatabase } from '../src/platform/db/database.js';
import { LEAVE_DEMO, LeaveClock } from '../src/modules/leave/index.js';
import { StaffingClock } from '../src/modules/staffing/index.js';
import { as, COMPANY_A, EMPLOYEE_B, employeeA, seedAccessFixture, USERS, type ActorName } from './support/access-fixture.js';
import { assertNoSecrets } from './support/assert-no-secrets.js';
import { SIMPLE_LAYOUT } from './support/templates-fixture.js';
import { createTestApp } from './support/test-app.js';
import { createTestDatabase, query, type TestDatabase } from './support/test-database.js';
import { fetchXsrf, type XsrfPair } from './support/xsrf.js';

const pinned = { today: () => '2026-09-28' };

let db: TestDatabase;
let app: NestExpressApplication;
let xsrf: XsrfPair;

const client = (actor: ActorName) => as(app, actor, xsrf);
const slug = (body: { type?: string }) => (body.type ?? '').replace('urn:hrforce:problem:', '');
const errorsOf = (body: { errors?: { field: string; code: string }[] }) => (body.errors ?? []).map((e) => [e.field, e.code]);

function binary(res: Response, callback: (error: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

async function pdfText(pdf: Buffer): Promise<{ text: string; pages: number }> {
  const doc = await getDocumentProxy(new Uint8Array(pdf));
  return { text: (await extractText(doc, { mergePages: true })).text.replace(/\s+/g, ' '), pages: doc.numPages };
}

async function preview(actor: ActorName, versionId: string, body: object): Promise<{ status: number; pdf: Buffer; json: { type?: string; errors?: { field: string; code: string }[] } }> {
  const res = await client(actor).post(`/api/documents/templates/${versionId}/preview`).send(body).buffer(true).parse(binary);
  const pdf = res.body as Buffer;
  return { status: res.status, pdf, json: res.status === 200 ? {} : (JSON.parse(pdf.toString('utf8')) as { type?: string }) };
}

interface TypeView {
  id: string;
  code: string;
  kind: string;
  subject: string;
  employmentRule: string;
  templateMode: string;
  active: boolean;
  selfService: boolean;
  languages: string[];
  nextNumber: string | null;
  template: { id: string; version: number; fields: { key: string }[] } | null;
}
interface VersionView {
  id: string;
  version: number;
  status: string;
  revision: number;
  languages: string[];
  fieldCount: number;
  issuedCount: number;
  basedOn: string | null;
  layouts: { fr?: typeof SIMPLE_LAYOUT; ar?: typeof SIMPLE_LAYOUT };
  fields: unknown[];
  _actions: string[];
}

const types = async (actor: ActorName = 'admin') => (await client(actor).get('/api/documents/types').expect(200)).body.items as TypeView[];
const typeOf = async (code: string) => {
  const type = (await types()).find((t) => t.code === code);
  if (!type) throw new Error(`no type ${code}`);
  return type;
};

async function createType(code: string, extra: object = {}): Promise<TypeView> {
  const res = await client('admin')
    .post('/api/documents/types')
    .send({ code, names: { fr: `Type ${code}`, ar: 'وثيقة', en: `Type ${code}` }, subject: 'employment', numberFormat: `${code.toUpperCase().replace(/_/g, '')}-{YYYY}-{SEQ:4}`, languages: ['fr'], ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as TypeView;
}

async function draft(typeId: string, from = 'blank'): Promise<VersionView> {
  const res = await client('admin').post(`/api/documents/types/${typeId}/templates`).send({ from });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as VersionView;
}

async function save(version: VersionView, layouts: object, fields: unknown[] = [], status = 200) {
  const res = await client('admin').put(`/api/documents/templates/${version.id}`).send({ revision: version.revision, layouts, fields });
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body as VersionView & { type?: string; errors?: { field: string; code: string }[] };
}

async function publish(version: { id: string; revision: number }, status = 200) {
  const res = await client('admin').post(`/api/documents/templates/${version.id}/publish`).send({ revision: version.revision });
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body as VersionView & { type?: string; errors?: { field: string; code: string }[] };
}

/** A custom type with a published version of `layout` and `fields`, activated. */
async function publishedType(code: string, layout: object = SIMPLE_LAYOUT, fields: unknown[] = [], extra: object = {}): Promise<{ type: TypeView; version: VersionView }> {
  const type = await createType(code, extra);
  const saved = await save(await draft(type.id), { fr: layout }, fields);
  const version = await publish(saved);
  await client('admin').put(`/api/documents/types/${type.id}`).send({ active: true }).expect(200);
  return { type: await typeOf(code), version };
}

const MISSION_FIELDS = [
  { key: 'destination', kind: 'text', labels: { fr: 'Destination', ar: 'الوجهة' }, required: true },
  { key: 'depart', kind: 'date', labels: { fr: 'Départ', ar: 'الذهاب' }, required: true },
  { key: 'jours', kind: 'number', labels: { fr: 'Jours', ar: 'الأيام' }, required: false },
  { key: 'transport', kind: 'choice', labels: { fr: 'Transport', ar: 'النقل' }, required: false, options: [{ value: 'avion', labels: { fr: 'Avion', ar: 'طائرة' } }] },
];
const MISSION_LAYOUT = {
  ...SIMPLE_LAYOUT,
  blocks: [
    ...SIMPLE_LAYOUT.blocks.slice(0, 2),
    {
      id: 'm',
      type: 'paragraph',
      align: 'start',
      content: [
        { t: 'text', text: 'Destination : ' },
        { t: 'var', key: 'field.destination', bold: true },
        { t: 'text', text: ', départ le ' },
        { t: 'var', key: 'field.depart' },
        { t: 'optional', key: 'field.transport', content: [{ t: 'text', text: ' en ' }, { t: 'var', key: 'field.transport' }] },
        { t: 'optional', key: 'field.jours', content: [{ t: 'text', text: ' pour ' }, { t: 'var', key: 'field.jours' }, { t: 'text', text: ' jours' }] },
        { t: 'text', text: '. N° ' },
        { t: 'var', key: 'document.number' },
      ],
    },
    SIMPLE_LAYOUT.blocks[2],
  ],
};

/** A full table (6 columns × 40 rows): about 6 KB of JSON. */
const table = (n: number) => ({ id: `t${n}`, type: 'table', widths: [1, 1, 1, 1, 1, 1], headerRow: false, borders: true, rows: Array.from({ length: 40 }, () => Array.from({ length: 6 }, () => [{ t: 'text', text: 'x' }])) });

beforeAll(async () => {
  db = await createTestDatabase();
  await seedAccessFixture(db, '2026-09-28', { leave: true, documents: true });
  app = await createTestApp(db, {
    devAuth: true,
    devPermissions: false,
    overrides: [
      { provide: DocumentsClock, useValue: pinned },
      { provide: LeaveClock, useValue: pinned },
      { provide: StaffingClock, useValue: pinned },
    ],
  });
  xsrf = await fetchXsrf(app);
}, 180_000);

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

describe('catalogue, types and permission', () => {
  it('document.design: admin_rh_central only, in the two-step sign-in defaults; system types show their subject and built-in mode', async () => {
    expect((await client('admin').get('/api/me').expect(200)).body.permissions).toContain('document.design');
    for (const actor of ['est', 'ouest', 'acces', 'agent'] as const) expect((await client(actor).get('/api/me').expect(200)).body.permissions, actor).not.toContain('document.design');
    expect(await query(db.superuserUrl, `select group_code, sensitive, sort_order from permission where code = 'document.design'`)).toEqual([{ group_code: 'documents', sensitive: false, sort_order: 665 }]);
    expect((await query<{ codes: string[] }>(db.superuserUrl, 'select public.security_policy_default_permissions() as codes'))[0]?.codes).toContain('document.design');
    const byCode = new Map((await types()).map((t) => [t.code, t]));
    expect(byCode.get('attestation_travail')).toMatchObject({ kind: 'system', subject: 'employment', employmentRule: 'active', templateMode: 'builtin', template: null });
    expect(byCode.get('certificat_travail')).toMatchObject({ kind: 'system', subject: 'employment', employmentRule: 'ended', templateMode: 'builtin' });
    expect(byCode.get('titre_conge')).toMatchObject({ kind: 'system', subject: 'leave_request', employmentRule: 'any', templateMode: 'builtin' });
  });

  it('the placeholder catalogue follows the subject and has no sensitive placeholder', async () => {
    const employment = (await client('admin').get('/api/documents/template-variables?subject=employment').expect(200)).body.items as { key: string; labels: { fr: string; ar: string; en: string }; group: string; sample: { fr: string; ar: string } }[];
    const leave = (await client('admin').get('/api/documents/template-variables?subject=leave_request').expect(200)).body.items as { key: string }[];
    expect(employment.find((v) => v.key === 'employee.fullName')).toEqual({ key: 'employee.fullName', labels: { fr: 'nom', ar: 'الاسم', en: 'name' }, group: 'employee', sample: { fr: 'Amine Benali', ar: 'أمين بن علي' } });
    expect(employment.some((v) => v.key.startsWith('leave.'))).toBe(false);
    expect(leave.map((v) => v.key)).toEqual(expect.arrayContaining(['leave.daysText', 'leave.resumption', 'employee.fullName', 'signatory.title']));
    expect(JSON.stringify([...employment, ...leave])).not.toMatch(/salary|salaire|nss|rib|nin\b|medical/i);
    await client('admin').get('/api/documents/template-variables?subject=nope').expect(422);
  });

  it('POST /documents/types: a custom type, inactive and not issuable before a template is published', async () => {
    const type = await createType('ordre_test', { employmentRule: 'active' });
    assertNoSecrets(type);
    expect(type).toMatchObject({ code: 'ordre_test', kind: 'custom', subject: 'employment', employmentRule: 'active', templateMode: 'designed', template: null, active: false, selfService: false, languages: ['fr'], nextNumber: 'ORDRETEST-2026-0001' });
    const again = await client('admin').post('/api/documents/types').send({ code: 'ordre_test', names: { fr: 'X', ar: 'ع', en: 'X' }, subject: 'employment', numberFormat: 'OT2-{YYYY}-{SEQ}', languages: ['fr'] }).expect(409);
    expect(slug(again.body)).toBe('document-type-code-taken');
    const system = await client('admin').post('/api/documents/types').send({ code: 'titre_conge', names: { fr: 'X', ar: 'ع', en: 'X' }, subject: 'employment', numberFormat: 'OT3-{YYYY}-{SEQ}', languages: ['fr'] }).expect(409);
    expect(slug(system.body)).toBe('document-type-code-taken');
    const format = await client('admin').post('/api/documents/types').send({ code: 'other_test', names: { fr: 'X', ar: 'ع', en: 'X' }, subject: 'employment', numberFormat: 'ATT-{YYYY}-{SEQ:5}', languages: ['fr'] }).expect(409);
    expect(slug(format.body)).toBe('document-format-taken');
    const invalid = await client('admin').post('/api/documents/types').send({ code: 'Bad Code', names: { fr: 'X', ar: 'ع', en: 'X' }, subject: 'leave_request', employmentRule: 'ended', numberFormat: 'nope', languages: [] }).expect(422);
    expect(errorsOf(invalid.body).map(([f]) => f)).toEqual(expect.arrayContaining(['code', 'languages']));
    const rule = await client('admin').post('/api/documents/types').send({ code: 'leave_doc', names: { fr: 'X', ar: 'ع', en: 'X' }, subject: 'leave_request', employmentRule: 'ended', numberFormat: 'nope', languages: ['fr'] }).expect(422);
    expect(errorsOf(rule.body)).toEqual([['numberFormat', 'invalid_format'], ['employmentRule', 'not_allowed']]);
    // not active, no template: neither activation nor issuing
    expect(slug((await client('admin').put(`/api/documents/types/${type.id}`).send({ active: true }).expect(409)).body)).toBe('document-template-missing');
    expect(slug((await client('admin').post('/api/documents').send({ typeCode: 'ordre_test', employmentId: employeeA(27), language: 'fr' }).expect(409)).body)).toBe('document-type-inactive');
    // names and the employment rule of a custom type can change; those of a system type cannot; code, kind and subject never
    const renamed = (await client('admin').put(`/api/documents/types/${type.id}`).send({ names: { fr: 'Ordre de test', ar: 'أمر', en: 'Test order' }, employmentRule: 'any' }).expect(200)).body as TypeView & { labels: { fr: string } };
    expect(renamed).toMatchObject({ labels: { fr: 'Ordre de test' }, employmentRule: 'any' });
    const attestation = await typeOf('attestation_travail');
    expect(errorsOf((await client('admin').put(`/api/documents/types/${attestation.id}`).send({ names: { fr: 'X', ar: 'ع', en: 'X' }, employmentRule: 'any' }).expect(422)).body)).toEqual([['names', 'not_allowed'], ['employmentRule', 'not_allowed']]);
    await expect(query(db.superuserUrl, `update document_type set subject = 'leave_request' where id = $1`, [type.id])).rejects.toThrow(/fixed/);
    await expect(query(db.superuserUrl, `update document_type set employment_rule = 'any' where id = $1`, [attestation.id])).rejects.toThrow(/fixed/);
    // regional HR: no document.configure
    await client('est').post('/api/documents/types').send({ code: 'est_type', names: { fr: 'X', ar: 'ع', en: 'X' }, subject: 'employment', numberFormat: 'EST-{YYYY}-{SEQ}', languages: ['fr'] }).expect(403);
  });
});

describe('drafts', () => {
  it('one draft per type: two concurrent creates → one 201, one 409; from blank, builtin, a version; discard', async () => {
    const titre = await typeOf('titre_conge');
    const results = await Promise.all([0, 1].map(() => client('admin').post(`/api/documents/types/${titre.id}/templates`).send({ from: 'builtin' })));
    expect(results.map((r) => r.status).toSorted()).toEqual([201, 409]);
    expect(slug(results.find((r) => r.status === 409)?.body ?? {})).toBe('document-template-draft-exists');
    const created = results.find((r) => r.status === 201)?.body as VersionView;
    assertNoSecrets(created);
    expect(created).toMatchObject({ version: 1, status: 'draft', revision: 1, languages: ['fr', 'ar'], fieldCount: 0, issuedCount: 0, basedOn: 'builtin:titre_conge@2', _actions: ['edit', 'publish', 'discard'] });
    // the designer copy of the built-in equals GET builtin-layout
    const builtin = (await client('admin').get(`/api/documents/types/${titre.id}/builtin-layout?lang=ar`).expect(200)).body;
    expect(created.layouts.ar).toEqual(builtin);
    const list = (await client('admin').get(`/api/documents/types/${titre.id}/templates`).expect(200)).body as { mode: string; builtin: { version: string; available: boolean }; items: VersionView[] };
    expect(list).toMatchObject({ mode: 'builtin', builtin: { version: 'titre_conge@2', available: true } });
    expect(list.items.map((v) => [v.version, v.status])).toEqual([[1, 'draft']]);
    expect((list.items[0] as unknown as { updatedBy: { id: string } }).updatedBy.id).toBe(USERS.admin.id);
    // the type still issues with its built-in template
    expect((await typeOf('titre_conge')).templateMode).toBe('builtin');
    await client('admin').delete(`/api/documents/templates/${created.id}`).expect(204);
    await client('admin').get(`/api/documents/templates/${created.id}`).expect(404);
    await client('admin').delete(`/api/documents/templates/${created.id}`).expect(404);
    // version numbers are never reused... a discarded draft's number is free again only because it never existed for anyone
    const custom = await createType('draft_test');
    expect(slug((await client('admin').post(`/api/documents/types/${custom.id}/templates`).send({ from: 'builtin' }).expect(409)).body)).toBe('document-template-no-builtin');
    expect(slug((await client('admin').post(`/api/documents/types/${custom.id}/templates`).send({ from: 'published' }).expect(409)).body)).toBe('document-template-missing');
    await client('admin').post(`/api/documents/types/${custom.id}/templates`).send({ from: '0190a5d0-0000-7000-8000-00000000dead' }).expect(404);
    await client('admin').get(`/api/documents/types/${custom.id}/builtin-layout?lang=fr`).expect(404);
    const blank = await draft(custom.id);
    expect(blank).toMatchObject({ basedOn: 'blank', languages: ['fr'] });
    expect(blank.layouts.fr).toMatchObject({ v: 1, blocks: [] });
  });

  it('saving: optimistic revision (409 with the current one), validation paths, limits, a large template', async () => {
    const type = await createType('save_test');
    const v1 = await draft(type.id);
    const saved = await save(v1, { fr: SIMPLE_LAYOUT });
    expect(saved).toMatchObject({ revision: 2, status: 'draft' });
    expect(saved.layouts.fr).toEqual(SIMPLE_LAYOUT);
    // the first tab still holds revision 1
    const stale = await client('admin').put(`/api/documents/templates/${v1.id}`).send({ revision: 1, layouts: { fr: SIMPLE_LAYOUT }, fields: [] }).expect(409);
    expect(slug(stale.body)).toBe('document-template-changed');
    expect(stale.body).toMatchObject({ revision: 2, updatedBy: USERS.admin.id });
    // validation: every error with its path
    const bad = await save(
      saved,
      {
        fr: {
          ...SIMPLE_LAYOUT,
          blocks: [
            { id: 'a', type: 'paragraph', align: 'start', content: [{ t: 'var', key: 'employee.salary' }, { t: 'var', key: 'field.nope' }, { t: 'var', key: 'leave.days' }] },
            { id: 'a', type: 'heading', align: 'start', content: [{ t: 'text', text: 'x\u0007' }] },
          ],
        },
        ar: SIMPLE_LAYOUT,
      },
      [{ key: 'Bad', kind: 'text', labels: { fr: 'X', ar: 'ع' }, required: true }],
      422,
    );
    expect(errorsOf(bad)).toEqual([
      ['fields.0.key', 'invalid_key'],
      ['layouts.fr.blocks.0.content.0.key', 'unknown_variable'],
      ['layouts.fr.blocks.0.content.1.key', 'unknown_field'],
      ['layouts.fr.blocks.0.content.2.key', 'unknown_variable'],
      ['layouts.fr.blocks.1.id', 'duplicate_id'],
      ['layouts.fr.blocks.1.content.0.text', 'invalid_text'],
      ['layouts.ar', 'not_allowed'],
    ]);
    expect(errorsOf(await save(saved, { fr: { ...SIMPLE_LAYOUT, blocks: [{ id: 'a', type: 'script', code: '#panic()' }] } }, [], 422))).toEqual([['layouts.fr.blocks.0.type', 'invalid']]);
    await client('admin').put(`/api/documents/templates/${saved.id}`).send({ revision: 2, layouts: 'x', fields: [] }).expect(422);
    // a template over the 100 KB default body limit is accepted; over 256 KB of JSON it is refused
    const big = await save(saved, { fr: { ...SIMPLE_LAYOUT, blocks: Array.from({ length: 25 }, (_, i) => table(i)) } });
    expect(big.revision).toBe(3);
    expect(JSON.stringify(big.layouts).length).toBeGreaterThan(120_000);
    expect(errorsOf(await save(big, { fr: { ...SIMPLE_LAYOUT, blocks: Array.from({ length: 60 }, (_, i) => table(i)) } }, [], 422))).toEqual([['layouts', 'layout_too_large']]);
    // bidi controls are removed from what is stored
    const cleaned = await save(big, { fr: { ...SIMPLE_LAYOUT, blocks: [{ id: 'a', type: 'paragraph', align: 'start', content: [{ t: 'text', text: 'a‮b' }] }] } });
    expect(JSON.stringify(cleaned.layouts)).toContain('"ab"');
    // audit: the save is a row change with before and after
    const rows = await query<{ op: string; changed: string[] }>(db.superuserUrl, `select op, changed from audit.change_log where table_name = 'document_template_version' and row_id = $1 order by id`, [saved.id]);
    expect(rows.map((r) => r.op)).toEqual(['insert', 'update', 'update', 'update']);
    expect(rows[1]?.changed).toEqual(expect.arrayContaining(['layouts', 'revision']));
  });
});

describe('preview', () => {
  it('sample data: SPÉCIMEN, the fictitious employee, the company letterhead; a real employee needs document.issue over them', async () => {
    const type = await createType('preview_test');
    const version = await save(await draft(type.id), { fr: MISSION_LAYOUT }, MISSION_FIELDS);
    const sample = await preview('admin', version.id, { lang: 'fr', sample: true });
    expect(sample.status).toBe(200);
    expect(sample.pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const text = (await pdfText(sample.pdf)).text;
    expect(text).toContain('Amine Benali');
    expect(text).toContain('Entreprise Démo HRForce');
    expect(text).toContain('SPÉCIMEN');
    expect(text).toContain('PREVIEWTEST-2026-…');
    expect(text).toContain('départ le 15 octobre 2026 en Avion pour 3 jours');
    // a real employee, fields given or sampled
    const real = await preview('admin', version.id, { lang: 'fr', employmentId: employeeA(27), fields: { destination: 'Tamanrasset' } });
    expect(real.status).toBe(200);
    expect((await pdfText(real.pdf)).text).toContain('Destination : Tamanrasset');
    expect((await preview('admin', version.id, { lang: 'fr', employmentId: employeeA(27), fields: { depart: 'demain' } })).json.errors).toEqual([expect.objectContaining({ field: 'fields.depart', code: 'invalid_value' })]);
    expect((await preview('admin', version.id, { lang: 'fr', employmentId: EMPLOYEE_B.employmentId })).status).toBe(404);
    // no Arabic layout in this version
    const ar = await preview('admin', version.id, { lang: 'ar', sample: true });
    expect([ar.status, slug(ar.json)]).toEqual([409, 'document-template-missing']);
    // nothing was numbered, stored or audited as issued
    expect(await query(db.superuserUrl, `select 1 from issued_document where type_code = 'preview_test'`)).toEqual([]);
    expect(await query(db.superuserUrl, `select 1 from document_sequence where document_type_id = $1`, [type.id])).toEqual([]);
  });

  it('text typed as Typst markup prints literally; a template over 5 pages → 422 at preview and at publish', async () => {
    const type = await createType('markup_test');
    const markup = '#panic("pwned") *gras* $x^2$ #read("/etc/passwd")';
    const v1 = await save(await draft(type.id), { fr: { ...SIMPLE_LAYOUT, blocks: [{ id: 'a', type: 'paragraph', align: 'start', content: [{ t: 'text', text: markup }] }] } });
    const ok = await preview('admin', v1.id, { lang: 'fr', sample: true });
    expect(ok.status).toBe(200);
    expect((await pdfText(ok.pdf)).text).toContain(markup);
    const long = await save(v1, { fr: { ...SIMPLE_LAYOUT, blocks: Array.from({ length: 6 }, (_, i) => [{ id: `p${i}`, type: 'paragraph', align: 'start', content: [{ t: 'text', text: `Page ${i}` }] }, { id: `b${i}`, type: 'pageBreak' }]).flat() } });
    const tooLong = await preview('admin', long.id, { lang: 'fr', sample: true });
    expect([tooLong.status, slug(tooLong.json)]).toEqual([422, 'document-template-too-long']);
    expect(slug(await publish(long, 422))).toBe('document-template-too-long');
    expect((await client('admin').get(`/api/documents/templates/${long.id}`).expect(200)).body.status).toBe('draft');
  });
});

describe('publishing and issuing', () => {
  it('publish: draft → published, the type becomes designed and issuable; fields are checked, printed and kept; numbering is gap-free', async () => {
    const type = await createType('mission_test', { employmentRule: 'active' });
    const d = await save(await draft(type.id), { fr: MISSION_LAYOUT }, MISSION_FIELDS);
    expect(slug((await client('admin').post(`/api/documents/templates/${d.id}/publish`).send({ revision: 1 }).expect(409)).body)).toBe('document-template-changed');
    const noted = await client('admin').post(`/api/documents/templates/${d.id}/publish`).send({ revision: d.revision, note: '  Première version  ' });
    expect(noted.status, JSON.stringify(noted.body)).toBe(200);
    const v1 = noted.body as VersionView & { note: string };
    expect(v1).toMatchObject({ version: 1, status: 'published', note: 'Première version', _actions: ['duplicate'] });
    const published = await typeOf('mission_test');
    expect(published).toMatchObject({ templateMode: 'designed', active: false, template: { id: v1.id, version: 1 } });
    expect(published.template?.fields.map((f) => f.key)).toEqual(['destination', 'depart', 'jours', 'transport']);
    // a published version never changes
    expect(slug((await client('admin').put(`/api/documents/templates/${v1.id}`).send({ revision: v1.revision, layouts: { fr: SIMPLE_LAYOUT }, fields: [] }).expect(409)).body)).toBe('document-template-not-draft');
    expect(slug((await client('admin').delete(`/api/documents/templates/${v1.id}`).expect(409)).body)).toBe('document-template-not-draft');
    await expect(query(db.superuserUrl, `update document_template_version set note = 'x' where id = $1`, [v1.id])).rejects.toThrow(/immutable/);
    await expect(query(db.superuserUrl, `delete from document_template_version where id = $1`, [v1.id])).rejects.toThrow(/draft/);
    const events = await query<{ type: string; data: Record<string, unknown> }>(db.superuserUrl, `select type, data from audit.event where subject_id = $1`, [v1.id]);
    expect(events).toEqual([{ type: 'document.template_published', data: { typeCode: 'mission_test', version: 1, previousVersion: null } }]);

    await client('admin').put(`/api/documents/types/${type.id}`).send({ active: true }).expect(200);
    const body = { typeCode: 'mission_test', employmentId: employeeA(27), language: 'fr' };
    // fields: required, unknown, invalid
    const missing = await client('admin').post('/api/documents').send(body).expect(422);
    expect(errorsOf(missing.body)).toEqual([['fields.destination', 'required'], ['fields.depart', 'required']]);
    const invalid = await client('admin').post('/api/documents').send({ ...body, fields: { destination: 'Oran', depart: '2026-13-01', jours: 'trois', transport: 'train', autre: 'x' } }).expect(422);
    expect(errorsOf(invalid.body)).toEqual([['fields.autre', 'unknown_field'], ['fields.depart', 'invalid_value'], ['fields.jours', 'invalid_value'], ['fields.transport', 'invalid_value']]);
    // a built-in type has no fields
    expect(errorsOf((await client('admin').post('/api/documents').send({ typeCode: 'certificat_travail', employmentId: employeeA(27), language: 'fr', fields: { x: 'y' } }).expect(422)).body)).toEqual([['fields.x', 'unknown_field']]);
    // nothing was numbered by the refusals
    expect(await query(db.superuserUrl, `select 1 from document_sequence where document_type_id = $1`, [type.id])).toEqual([]);

    const clientRequestId = '0190a5d0-0000-7000-8000-00000000c1d1';
    const fields = { destination: ' Oran ', depart: '2026-10-01', jours: '2,5', transport: 'avion' };
    const issuedRes = await client('est').post('/api/documents').send({ ...body, fields, clientRequestId }).expect(201);
    const issued = issuedRes.body as { id: string; number: string; templateVersion: string; template: { id: string; version: number } };
    assertNoSecrets(issued);
    expect(issued).toMatchObject({ number: 'MISSIONTEST-2026-0001', templateVersion: 'mission_test.designed@1', template: { id: v1.id, version: 1 } });
    // replay: same fields → the same document; other fields → 409
    expect((await client('est').post('/api/documents').send({ ...body, fields, clientRequestId }).expect(200)).body.id).toBe(issued.id);
    expect(slug((await client('est').post('/api/documents').send({ ...body, fields: { ...fields, destination: 'Alger' }, clientRequestId }).expect(409)).body)).toBe('document-client-request-reused');
    const detail = (await client('est').get(`/api/documents/${issued.id}`).expect(200)).body as { snapshot: { v: number; type: string; fields: Record<string, string | null>; fieldValues: Record<string, string>; vars: Record<string, string | null> } };
    expect(detail.snapshot).toMatchObject({
      v: 2,
      type: 'mission_test',
      fields: { destination: 'Oran', depart: '1er octobre 2026', jours: '2,5', transport: 'Avion' },
      fieldValues: { destination: 'Oran', depart: '2026-10-01', jours: '2.5', transport: 'avion' },
    });
    expect(detail.snapshot.vars).toMatchObject({ 'document.number': 'MISSIONTEST-2026-0001', 'field.destination': 'Oran', 'employee.matricule': 'EMP-0027' });
    expect(Object.keys(detail.snapshot.vars).toSorted()).toEqual(['document.number', 'employee.civility', 'employee.fullName', 'employee.matricule', 'field.depart', 'field.destination', 'field.jours', 'field.transport']);
    const pdf = (await client('est').get(`/api/documents/${issued.id}/pdf`).buffer(true).parse(binary).expect(200)).body as Buffer;
    const text = (await pdfText(pdf)).text;
    expect(text).toContain('Destination : Oran, départ le 1er octobre 2026 en Avion pour 2,5 jours. N° MISSIONTEST-2026-0001');
    expect(text).not.toContain('SPÉCIMEN');
    expect(await query(db.superuserUrl, `select subject, template_version_id, template_version from issued_document where id = $1`, [issued.id])).toEqual([
      { subject: 'employment', template_version_id: v1.id, template_version: 'mission_test.designed@1' },
    ]);
    // the employment rule of the type (active): an ended employment is refused like for the attestation
    expect(slug((await client('admin').post('/api/documents').send({ ...body, employmentId: employeeA(25), fields }).expect(409)).body)).toBe('document-employment-ended');
    // scope as for every document: Région Est cannot issue for Région Ouest
    await client('est').post('/api/documents').send({ ...body, employmentId: employeeA(36), fields }).expect(404);

    // gap-free numbering under concurrency
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => client('admin').post('/api/documents').send({ ...body, employmentId: employeeA(27 + (i % 4)), fields: { destination: `Ville ${i}`, depart: '2026-10-02' } })));
    expect(results.map((r) => r.status)).toEqual(Array.from({ length: 8 }, () => 201));
    const seqs = await query<{ seq: number }>(db.superuserUrl, `select seq from issued_document where type_code = 'mission_test' order by seq`);
    expect(seqs.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(await query(db.superuserUrl, `select last_value from document_sequence where document_type_id = $1`, [type.id])).toEqual([{ last_value: 9 }]);

    // version 2: the earlier document keeps its bytes and its version; new ones use version 2
    const d2 = await draft(type.id, 'published');
    expect(d2).toMatchObject({ version: 2, basedOn: v1.id, fieldCount: 4 });
    const v2 = await publish(await save(d2, { fr: { ...MISSION_LAYOUT, blocks: [{ id: 'new', type: 'heading', align: 'start', content: [{ t: 'text', text: 'Nouvelle version' }] }, ...MISSION_LAYOUT.blocks] } }, MISSION_FIELDS));
    expect(v2).toMatchObject({ version: 2, status: 'published' });
    const list = (await client('admin').get(`/api/documents/types/${type.id}/templates`).expect(200)).body as { mode: string; builtin: null; items: VersionView[] };
    expect(list).toMatchObject({ mode: 'designed', builtin: null });
    expect(list.items.map((v) => [v.version, v.status, v.issuedCount])).toEqual([[2, 'published', 0], [1, 'archived', 9]]);
    expect((await query<{ data: Record<string, unknown> }>(db.superuserUrl, `select data from audit.event where subject_id = $1`, [v2.id]))[0]?.data).toEqual({ typeCode: 'mission_test', version: 2, previousVersion: 1 });
    const again = (await client('est').get(`/api/documents/${issued.id}/pdf`).buffer(true).parse(binary).expect(200)).body as Buffer;
    expect(again.equals(pdf)).toBe(true);
    const next = (await client('admin').post('/api/documents').send({ ...body, fields: { destination: 'Sétif', depart: '2026-10-03' } }).expect(201)).body as { id: string; number: string; templateVersion: string };
    expect(next).toMatchObject({ number: 'MISSIONTEST-2026-0010', templateVersion: 'mission_test.designed@2' });
    expect((await pdfText((await client('admin').get(`/api/documents/${next.id}/pdf`).buffer(true).parse(binary).expect(200)).body as Buffer)).text).toContain('Nouvelle version');
    // the archived version can still be read and previewed
    expect((await preview('admin', v1.id, { lang: 'fr', sample: true })).status).toBe(200);
    await expect(query(db.superuserUrl, `update document_template_version set status = 'published' where id = $1`, [v1.id])).rejects.toThrow();
  });

  it('a system type: designed version, both languages needed, then back to the built-in', async () => {
    const attestation = await typeOf('attestation_travail');
    const before = (await client('admin').post('/api/documents').send({ typeCode: 'attestation_travail', employmentId: employeeA(28), language: 'fr' }).expect(201)).body as { id: string; templateVersion: string; template: null };
    expect(before).toMatchObject({ templateVersion: 'attestation_travail@2', template: null });
    const d = await draft(attestation.id, 'builtin');
    // remove the Arabic layout: publishing needs every language of the type
    const frOnly = await save(d, { fr: d.layouts.fr ?? SIMPLE_LAYOUT });
    expect(errorsOf(await publish(frOnly, 422))).toEqual([['layouts.ar', 'required']]);
    // …with content: an Arabic layout left empty (as a blank draft starts) would issue numbered blank pages
    const arEmpty = await save(frOnly, { fr: d.layouts.fr ?? SIMPLE_LAYOUT, ar: { ...SIMPLE_LAYOUT, blocks: [] } });
    expect(errorsOf(await publish(arEmpty, 422))).toEqual([['layouts.ar', 'empty']]);
    const closing = 'Attestation délivrée pour servir et valoir ce que de droit, sur modèle de l’entreprise.';
    const fr = { ...(d.layouts.fr ?? SIMPLE_LAYOUT), blocks: (d.layouts.fr ?? SIMPLE_LAYOUT).blocks.map((b, i) => (i === 2 ? { ...b, content: [{ t: 'text', text: closing }] } : b)) };
    const v1 = await publish(await save(arEmpty, { fr, ar: d.layouts.ar }));
    expect(await typeOf('attestation_travail')).toMatchObject({ templateMode: 'designed', template: { id: v1.id, version: 1, fields: [] } });
    for (const lang of ['fr', 'ar'] as const) {
      const doc = (await client('admin').post('/api/documents').send({ typeCode: 'attestation_travail', employmentId: employeeA(29), language: lang }).expect(201)).body as { id: string; templateVersion: string };
      expect(doc.templateVersion).toBe('attestation_travail.designed@1');
      const text = (await pdfText((await client('admin').get(`/api/documents/${doc.id}/pdf`).buffer(true).parse(binary).expect(200)).body as Buffer)).text;
      if (lang === 'fr') expect(text).toContain(closing);
      else expect(text).toMatch(/[؀-ۿ]/);
    }
    // the attestation still follows its own rule and wording of errors
    expect(slug((await client('admin').post('/api/documents').send({ typeCode: 'attestation_travail', employmentId: employeeA(25), language: 'fr' }).expect(409)).body)).toBe('document-employment-ended');
    // a self-service request approved by HR issues with the designed template
    const request = (await client('agent').post('/api/me/documents/requests').send({ typeCode: 'attestation_travail', language: 'fr' }).expect(201)).body as { id: string };
    const task = ((await client('est').get('/api/tasks').expect(200)).body.items as { id: string; subject: { id: string } }[]).find((t) => t.subject.id === request.id);
    await client('est').post(`/api/tasks/${task?.id}/approve`).send({}).expect(200);
    const mine = (await client('agent').get('/api/me/documents').expect(200)).body.documents as { templateVersion: string; employee: { id: string } }[];
    expect(mine[0]).toMatchObject({ templateVersion: 'attestation_travail.designed@1', employee: { id: LEAVE_DEMO.agent.employmentId } });
    // a self-service type cannot get a template with a required field
    const d2 = await save(await draft(attestation.id, 'published'), { fr, ar: d.layouts.ar }, [{ key: 'motif', kind: 'text', labels: { fr: 'Motif', ar: 'السبب' }, required: true }]);
    expect(slug(await publish(d2, 409))).toBe('document-template-self-service');
    await client('admin').delete(`/api/documents/templates/${d2.id}`).expect(204);
    // a language the published version lacks cannot be added… the type keeps fr + ar here, so removing ar then publishing fr only works
    // back to the built-in
    const reverted = (await client('admin').post(`/api/documents/types/${attestation.id}/templates/builtin`).send({}).expect(200)).body as TypeView;
    expect(reverted).toMatchObject({ id: attestation.id, code: 'attestation_travail', templateMode: 'builtin', template: null });
    const versions = (await client('admin').get(`/api/documents/types/${attestation.id}/templates`).expect(200)).body.items as VersionView[];
    expect(versions.map((v) => [v.version, v.status])).toEqual([[1, 'archived']]);
    expect(await typeOf('attestation_travail')).toMatchObject({ templateMode: 'builtin', template: null });
    const events = await query<{ type: string; data: Record<string, unknown> }>(db.superuserUrl, `select type, data from audit.event where type = 'document.template_reverted'`);
    expect(events).toEqual([{ type: 'document.template_reverted', data: { typeCode: 'attestation_travail', toBuiltin: true, previousVersion: 1 } }]);
    const after = (await client('admin').post('/api/documents').send({ typeCode: 'attestation_travail', employmentId: employeeA(31), language: 'fr' }).expect(201)).body as { templateVersion: string };
    expect(after.templateVersion).toBe('attestation_travail@2');
    // a second revert changes nothing; a custom type has no built-in
    await client('admin').post(`/api/documents/types/${attestation.id}/templates/builtin`).send({}).expect(200);
    expect(await query(db.superuserUrl, `select 1 from audit.event where type = 'document.template_reverted'`)).toHaveLength(1);
    const custom = await typeOf('mission_test');
    expect(slug((await client('admin').post(`/api/documents/types/${custom.id}/templates/builtin`).send({}).expect(409)).body)).toBe('document-template-no-builtin');
  });

  it('languages and self-service of a custom type follow its published template', async () => {
    const { type } = await publishedType('self_test', SIMPLE_LAYOUT, [{ key: 'motif', kind: 'text', labels: { fr: 'Motif', ar: 'السبب' }, required: true }]);
    // required field → not self-service; Arabic has no layout → cannot be added
    expect(errorsOf((await client('admin').put(`/api/documents/types/${type.id}`).send({ selfService: true }).expect(422)).body)).toEqual([['selfService', 'required_fields']]);
    expect(errorsOf((await client('admin').put(`/api/documents/types/${type.id}`).send({ languages: ['fr', 'ar'] }).expect(422)).body)).toEqual([['languages', 'template_language_missing']]);
    const titre = await typeOf('titre_conge');
    expect(errorsOf((await client('admin').put(`/api/documents/types/${titre.id}`).send({ selfService: true }).expect(422)).body)).toEqual([['selfService', 'not_allowed']]);
    // an optional field only: employees may request it, and approval issues it without the field
    const { type: open } = await publishedType('libre_test', MISSION_LAYOUT, MISSION_FIELDS.map((f) => ({ ...f, required: false })));
    expect((await client('admin').put(`/api/documents/types/${open.id}`).send({ selfService: true }).expect(200)).body.selfService).toBe(true);
    const request = (await client('agent').post('/api/me/documents/requests').send({ typeCode: 'libre_test', language: 'fr' }).expect(201)).body as { id: string; type: { code: string } };
    expect(request.type.code).toBe('libre_test');
    const task = ((await client('est').get('/api/tasks').expect(200)).body.items as { id: string; subject: { id: string } }[]).find((t) => t.subject.id === request.id);
    await client('est').post(`/api/tasks/${task?.id}/approve`).send({}).expect(200);
    const mine = (await client('agent').get('/api/me/documents').expect(200)).body.documents as { number: string; templateVersion: string }[];
    expect(mine[0]).toMatchObject({ number: 'LIBRETEST-2026-0001', templateVersion: 'libre_test.designed@1' });
    await client('agent').post('/api/me/documents/requests').send({ typeCode: 'self_test', language: 'fr' }).expect(409);
    await client('agent').post('/api/me/documents/requests').send({ typeCode: 'unknown_type', language: 'fr' }).expect(422);
  });

  it('a custom leave document: issued from an approved leave request, with the leave placeholders', async () => {
    const layout = {
      ...SIMPLE_LAYOUT,
      blocks: [
        ...SIMPLE_LAYOUT.blocks.slice(0, 2),
        { id: 'l', type: 'paragraph', align: 'start', content: [{ t: 'text', text: 'Reprise le ' }, { t: 'var', key: 'leave.resumption' }, { t: 'text', text: ' après ' }, { t: 'var', key: 'leave.daysText' }, { t: 'text', text: '.' }] },
      ],
    };
    const type = await createType('reprise_test', { subject: 'leave_request' });
    expect(errorsOf(await save(await draft(type.id), { fr: { ...layout, blocks: [...layout.blocks, { id: 'pos', type: 'positions' }] } }, [], 422))).toEqual([['layouts.fr.blocks.3', 'positions_not_allowed']]);
    const version = (await client('admin').get(`/api/documents/types/${type.id}/templates`).expect(200)).body.items[0] as VersionView;
    await publish(await save({ ...version, revision: 1 }, { fr: layout }));
    await client('admin').put(`/api/documents/types/${type.id}`).send({ active: true }).expect(200);
    const annual = (await query<{ id: string }>(db.superuserUrl, `select id from leave_type where company_id = $1 and code = 'annual'`, [COMPANY_A]))[0]?.id;
    const [leave] = await query<{ id: string }>(
      db.superuserUrl,
      `insert into leave_request (company_id, employment_id, leave_type_id, org_unit_id, start_date, end_date, days, status, requested_by)
       select $1, $2, $3, a.org_unit_id, '2026-10-12', '2026-10-14', 3, 'approved', $4 from assignment a where a.employment_id = $2 limit 1 returning id`,
      [COMPANY_A, employeeA(27), annual, USERS.admin.id],
    );
    expect(errorsOf((await client('admin').post('/api/documents').send({ typeCode: 'reprise_test', employmentId: employeeA(27), language: 'fr' }).expect(422)).body)).toEqual([['leaveRequestId', 'required']]);
    const doc = (await client('admin').post('/api/documents').send({ typeCode: 'reprise_test', leaveRequestId: leave?.id, language: 'fr' }).expect(201)).body as { id: string; leaveRequestId: string };
    expect(doc.leaveRequestId).toBe(leave?.id);
    const text = (await pdfText((await client('admin').get(`/api/documents/${doc.id}/pdf`).buffer(true).parse(binary).expect(200)).body as Buffer)).text;
    expect(text).toContain('Reprise le 15 octobre 2026 après 3 jours.');
    expect(await query(db.superuserUrl, `select subject from issued_document where id = $1`, [doc.id])).toEqual([{ subject: 'leave_request' }]);
  });

  it('writes need document.design over the whole company; reads need it anywhere', async () => {
    // a custom role with document.design, granted on Région Est only
    const [role] = await query<{ id: string }>(db.superuserUrl, `insert into role (company_id, code, name_fr, name_ar, name_en, is_system) values ($1, 'designer_est', 'Concepteur', 'مصمم', 'Designer', false) returning id`, [COMPANY_A]);
    await query(db.superuserUrl, `insert into role_permission (company_id, role_id, permission_code) values ($1, $2, 'document.design')`, [COMPANY_A, role?.id]);
    const est = (await query<{ org_unit_id: string }>(db.superuserUrl, `select org_unit_id from role_grant where user_id = $1 limit 1`, [USERS.est.id]))[0]?.org_unit_id;
    await query(db.superuserUrl, `insert into role_grant (company_id, user_id, role_id, org_unit_id, include_descendants, valid_from, granted_by) values ($1, $2, $3, $4, true, '2026-01-01', $5)`, [COMPANY_A, USERS.est.id, role?.id, est, USERS.admin.id]);
    const titre = await typeOf('titre_conge');
    await client('est').get(`/api/documents/types/${titre.id}/templates`).expect(200);
    const refused = await client('est').post(`/api/documents/types/${titre.id}/templates`).send({ from: 'blank' }).expect(403);
    expect(slug(refused.body)).toBe('forbidden-scope');
    const v = await draft(titre.id, 'builtin');
    expect(((await client('est').get(`/api/documents/templates/${v.id}`).expect(200)).body as VersionView)['_actions']).toEqual([]);
    for (const call of [
      () => client('est').put(`/api/documents/templates/${v.id}`).send({ revision: 1, layouts: {}, fields: [] }),
      () => client('est').post(`/api/documents/templates/${v.id}/publish`).send({ revision: 1 }),
      () => client('est').delete(`/api/documents/templates/${v.id}`),
      () => client('est').post(`/api/documents/types/${titre.id}/templates/builtin`).send({}),
    ]) {
      const res = await call();
      expect([res.status, slug(res.body)]).toEqual([403, 'forbidden-scope']);
    }
    // a preview is a read: sample data works, a real employee of Région Est too (rh.est holds document.issue there)
    expect((await preview('est', v.id, { lang: 'fr', sample: true })).status).toBe(200);
    await client('admin').delete(`/api/documents/templates/${v.id}`).expect(204);
  });
});

describe('seed:dev demo templates', () => {
  it('seedDemoTemplates on a fresh company: the ordre de mission (published v1, active) and the designed attestation (v1 published, v2 draft); idempotent; issuable', async () => {
    const fresh = await createTestDatabase();
    let freshApp: NestExpressApplication | undefined;
    try {
      await seedAccessFixture(fresh, '2026-09-28', { leave: true, documents: true });
      const migrator = createDatabase({ connectionString: fresh.migratorUrl, maxConnections: 1 });
      try {
        expect(await migrator.transaction().execute((tx) => seedDemoTemplates(tx, COMPANY_A, USERS.admin.id))).toEqual({ types: 1, versions: 3 });
        expect(await migrator.transaction().execute((tx) => seedDemoTemplates(tx, COMPANY_A, USERS.admin.id))).toEqual({ types: 0, versions: 0 });
      } finally {
        await migrator.destroy();
      }
      freshApp = await createTestApp(fresh, { devAuth: true, devPermissions: false, overrides: [{ provide: DocumentsClock, useValue: pinned }, { provide: LeaveClock, useValue: pinned }, { provide: StaffingClock, useValue: pinned }] });
      const pair = await fetchXsrf(freshApp);
      const admin = as(freshApp, 'admin', pair);
      const items = (await admin.get('/api/documents/types').expect(200)).body.items as TypeView[];
      const byCode = new Map(items.map((t) => [t.code, t]));
      expect(byCode.get('ordre_mission')).toMatchObject({ kind: 'custom', employmentRule: 'active', active: true, templateMode: 'designed', languages: ['fr', 'ar'], template: { id: DEMO_TEMPLATES.ordreMissionV1, version: 1 } });
      expect(byCode.get('ordre_mission')?.template?.fields.map((f) => f.key)).toEqual(['destination', 'objet', 'depart', 'retour', 'transport']);
      expect(byCode.get('attestation_travail')).toMatchObject({ templateMode: 'designed', template: { id: DEMO_TEMPLATES.attestationV1, version: 1 } });
      expect(byCode.get('certificat_travail')?.templateMode).toBe('builtin');
      expect(byCode.get('titre_conge')?.templateMode).toBe('builtin');
      const versions = (await admin.get(`/api/documents/types/${byCode.get('attestation_travail')?.id}/templates`).expect(200)).body.items as VersionView[];
      expect(versions.map((v) => [v.version, v.status])).toEqual([[2, 'draft'], [1, 'published']]);
      // the seeded layouts are valid: they can be saved again as they are, previewed and issued in both languages
      const draftV2 = (await admin.get(`/api/documents/templates/${DEMO_TEMPLATES.attestationV2}`).expect(200)).body as VersionView;
      await admin.put(`/api/documents/templates/${draftV2.id}`).send({ revision: draftV2.revision, layouts: draftV2.layouts, fields: draftV2.fields }).expect(200);
      for (const language of ['fr', 'ar'] as const) {
        const fields = { destination: 'Oran', objet: 'Audit de l’agence\nRéunion', depart: '2026-10-05', retour: '2026-10-08', transport: 'vehicule_service' };
        const doc = (await admin.post('/api/documents').send({ typeCode: 'ordre_mission', employmentId: employeeA(27), language, fields }).expect(201)).body as { id: string; number: string };
        expect(doc.number).toMatch(/^OM-2026-000[12]$/);
        const text = (await pdfText((await admin.get(`/api/documents/${doc.id}/pdf`).buffer(true).parse(binary).expect(200)).body as Buffer)).text;
        expect(text).toContain('Oran');
        expect(text).toContain(language === 'fr' ? 'ORDRE DE MISSION' : 'EMP-0027');
        await admin.post('/api/documents').send({ typeCode: 'attestation_travail', employmentId: employeeA(27), language }).expect(201);
      }
    } finally {
      await freshApp?.close();
      await fresh.drop();
    }
  }, 120_000);
});
