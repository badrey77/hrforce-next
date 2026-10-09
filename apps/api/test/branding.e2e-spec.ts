/**
 * Branding settings (docs/contracts/branding.md › API tests): the public installation default, logos by digest,
 * inheritance on GET /api/me, the order of the write checks, text cleaning, upload rules, reset semantics, audit,
 * database privileges, the owner CLI and two-step sign-in.
 * Company A (DEMO) owns the installation default; `beta` is the central admin of the other company (BETA).
 */
import { createHash } from 'node:crypto';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Transaction } from 'kysely';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BRAND_COLORS, moveBrandingOwner, seedBrandingDefaults, seedDemoBranding, DEMO_BRANDING } from '../src/modules/branding/index.js';
import { demoLogoPng } from '../src/modules/documents/index.js';
import { DEMO_ORGANIZATION } from '../src/modules/organization/index.js';
import { createDatabase } from '../src/platform/db/database.js';
import type { DB } from '../src/platform/db/schema.js';
import { DEFAULT_MIGRATIONS_DIR, loadMigrationFiles, runMigrations } from '../src/platform/db/migrator.js';
import { bootstrapCompany } from '../src/scripts/bootstrap-company.js';
import { as, COMPANY_A, COMPANY_B, ORG_B, seedAccessFixture, unitA, USERS, type AccessFixture, type ActorName } from './support/access-fixture.js';
import { assertNoSecrets } from './support/assert-no-secrets.js';
import { createTestApp } from './support/test-app.js';
import { createTestDatabase, query, type TestDatabase } from './support/test-database.js';
import { fetchXsrf, type XsrfPair } from './support/xsrf.js';

const L0 = { fr: null, ar: null, en: null };
const t = (fr: string | null, ar: string | null = null, en: string | null = null) => ({ fr, ar, en });
const COMPANY_BODY = { appTitle: L0, welcomeTitle: L0, welcomeMessage: L0, footer: L0, color: null as string | null };
const INSTALLATION_BODY = { appTitle: L0, signInMessage: L0, footer: L0, color: 'blue' };
const PROBLEM = 'urn:hrforce:problem:';
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

// ── images ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const PNG = demoLogoPng(); // a real 160 × 48 PNG
/** A header-only JPEG (SOI, SOF0 `width` × `height` grey, EOI). */
const jpeg = (width: number, height: number) => Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0, 0xff, 0xd9]);
const JPEG = jpeg(3, 2);
/** A PNG signature and IHDR declaring `width` × `height` (8-bit RGB), then `padding` bytes. */
function pngDeclaring(width: number, height: number, padding = 0): Buffer {
  const head = Buffer.alloc(8 + 8 + 13 + 4);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write('IHDR', 12, 'latin1');
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  head.writeUInt8(8, 24);
  head.writeUInt8(2, 25);
  return Buffer.concat([head, Buffer.alloc(padding, 0x20)]);
}
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>');
const HTML = Buffer.from('<!doctype html><html><body><script>alert(1)</script></body></html>');
const GIF = Buffer.from('GIF89a\u0001\u0000\u0001\u0000\u0080\u0000\u0000\u0000\u0000\u0000ÿÿÿ!ù\u0004\u0001\u0000\u0000\u0000\u0000,\u0000\u0000\u0000\u0000\u0001\u0000\u0001\u0000\u0000\u0002\u0002D\u0001\u0000;', 'latin1');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x1a, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(18)]);
const ICO = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 0x68, 4, 0, 0, 22, 0, 0, 0]);

let db: TestDatabase;
let app: NestExpressApplication;
let fx: AccessFixture;
let xsrf: XsrfPair;
let seq = 0;

const client = (actor: ActorName | null) => as(app, actor, xsrf);
const rid = () => `branding-e2e-${++seq}`;
const upload = (actor: ActorName, url: string, bytes: Buffer, filename = 'logo.png', contentType?: string) =>
  client(actor).put(url).attach('file', bytes, contentType ? { filename, contentType } : filename);
const settings = async (actor: ActorName) => (await client(actor).get('/api/branding/settings').expect(200)).body;
const me = async (actor: ActorName) => (await client(actor).get('/api/me').expect(200)).body.branding;
const changes = (requestId: string) =>
  query<{ table_name: string; op: string; actor_user_id: string | null; company_id: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null; changed: string[] }>(
    db.superuserUrl,
    'select table_name, op, actor_user_id, company_id, before, after, changed from audit.change_log where request_id = $1 order by id',
    [requestId],
  );

/** Statements as hrforce_app in one transaction bound to a company (rolled back); returns the last result. */
async function asApp(companyId: string, statement: string, values: unknown[] = []): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
  const pg = new Client({ connectionString: db.appUrl });
  await pg.connect();
  try {
    await pg.query('begin');
    await pg.query(`select set_config('app.company_id', $1, true)`, [companyId]);
    const result = await pg.query(statement, values);
    return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount ?? 0 };
  } finally {
    await pg.query('rollback').catch(() => undefined);
    await pg.end();
  }
}

/** Every write route with a body that would be valid for the central admin of the owning company. */
const WRITES: { key: string; installation: boolean; call: (actor: ActorName, invalid?: boolean) => request.Test }[] = [
  { key: 'PUT /branding/company', installation: false, call: (a, bad) => client(a).put('/api/branding/company').send(bad ? { nope: true } : COMPANY_BODY) },
  { key: 'DELETE /branding/company', installation: false, call: (a) => client(a).delete('/api/branding/company') },
  { key: 'PUT /branding/company/logos/app', installation: false, call: (a, bad) => upload(a, '/api/branding/company/logos/app', bad ? SVG : PNG) },
  { key: 'DELETE /branding/company/logos/company', installation: false, call: (a) => client(a).delete('/api/branding/company/logos/company') },
  { key: 'PUT /branding/installation', installation: true, call: (a, bad) => client(a).put('/api/branding/installation').send(bad ? { nope: true } : INSTALLATION_BODY) },
  { key: 'DELETE /branding/installation', installation: true, call: (a) => client(a).delete('/api/branding/installation') },
  { key: 'PUT /branding/installation/logo', installation: true, call: (a, bad) => upload(a, '/api/branding/installation/logo', bad ? SVG : PNG) },
  { key: 'DELETE /branding/installation/logo', installation: true, call: (a) => client(a).delete('/api/branding/installation/logo') },
];

/** PUT /branding/company as the central admin of company A, the given fields over an all-null body. */
const put = (body: object) => client('admin').put('/api/branding/company').send({ ...COMPANY_BODY, ...body });
/** The [field, code] pairs of a 422. */
const errors = (res: request.Response) => (res.body.errors as { field: string; code: string }[]).map((e) => [e.field, e.code]);

const asMigrator = async <T>(fn: (tx: Transaction<DB>) => Promise<T>): Promise<T> => {
  const migrator = createDatabase({ connectionString: db.migratorUrl, maxConnections: 1 });
  try {
    return await migrator.transaction().execute((tx) => fn(tx));
  } finally {
    await migrator.destroy();
  }
};
const owner = async () => (await query<{ code: string }>(db.superuserUrl, 'select c.code from installation_branding b join company c on c.id = b.company_id')).map((r) => r.code);

/** Back to nothing set anywhere (both companies and the installation). */
async function resetAll(): Promise<void> {
  await client('admin').delete('/api/branding/company').expect(204);
  await client('admin').delete('/api/branding/installation').expect(204);
  await client('beta').delete('/api/branding/company').expect(204);
}

beforeAll(async () => {
  db = await createTestDatabase();
  fx = await seedAccessFixture(db);
  // `newbie` holds settings.branding through a custom role on Région Est only (not over the whole company)
  await query(db.superuserUrl, `insert into role_permission (company_id, role_id, permission_code) values ($1, $2, 'settings.branding')`, [COMPANY_A, fx.customA]);
  await query(
    db.superuserUrl,
    `insert into role_grant (company_id, user_id, role_id, org_unit_id, include_descendants, valid_from) values ($1, $2, $3, $4, true, '2026-01-01')`,
    [COMPANY_A, USERS.newbie.id, fx.customA, unitA('REG-EST')],
  );
  app = await createTestApp(db, { devAuth: true, devPermissions: false });
  xsrf = await fetchXsrf(app);
});

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

// ---------------------------------------------------------------------------------------------------------------
describe('nothing set', () => {
  it('GET /branding/default: the built-in default, as JSON, cacheable by revalidation, without a cookie', async () => {
    const res = await request(app.getHttpServer()).get('/api/branding/default').expect(200);
    expect(res.body).toEqual({ appTitle: L0, signInMessage: L0, footer: L0, color: 'blue', appLogo: null });
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['etag']).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('GET /branding/settings: the owner sees the installation tab, another company does not; palette and limits', async () => {
    const a = await settings('admin');
    expect(a).toEqual({
      company: { appTitle: L0, welcomeTitle: L0, welcomeMessage: L0, footer: L0, color: null, appLogo: null, companyLogo: null, updatedAt: null },
      installation: { appTitle: L0, signInMessage: L0, footer: L0, color: 'blue', appLogo: null, updatedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) },
      inherited: { appTitle: L0, footer: L0, color: 'blue', appLogo: null },
      palette: ['blue', 'navy', 'azure', 'teal', 'green', 'olive', 'brown', 'plum', 'indigo', 'slate'],
      limits: { appTitle: 40, welcomeTitle: 80, welcomeMessage: 500, signInMessage: 500, footer: 200, logoMaxBytes: 262144 },
    });
    expect(a.palette).toEqual([...BRAND_COLORS]);
    assertNoSecrets(a);
    const b = await settings('beta');
    expect(b.installation).toBeNull();
    expect(b.company.updatedAt).toBeNull();
    // a regional holder reads the settings (the installation tab too: it belongs to this company)
    expect((await settings('newbie')).installation).not.toBeNull();
  });

  it('GET /me carries `branding` for every actor: all null, blue, no logo', async () => {
    for (const actor of ['admin', 'est', 'ouest', 'acces', 'newbie', 'target', 'beta'] as const) {
      expect(await me(actor), actor).toEqual({ appTitle: L0, welcomeTitle: L0, welcomeMessage: L0, footer: L0, color: 'blue', appLogo: null, companyLogo: null });
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('order of the write checks: permission → whole company → owner → validation', () => {
  it('without the permission: 403 on every route (rh_regional, lecture, admin_acces), anonymous 401', async () => {
    for (const actor of ['est', 'ouest', 'acces'] as const) {
      await client(actor).get('/api/branding/settings').expect(403);
      for (const w of WRITES) {
        const res = await w.call(actor, true);
        expect([res.status, res.body.type], `${w.key} as ${actor}`).toEqual([403, `${PROBLEM}forbidden`]);
      }
    }
    for (const w of WRITES) expect((await w.call(null as unknown as ActorName)).status, w.key).toBe(401);
  });

  it('held on a region only: 403 forbidden-scope on every write, before the owner check and before validation', async () => {
    for (const w of WRITES) {
      for (const invalid of [false, true]) {
        const res = await w.call('newbie', invalid);
        expect([res.status, res.body.type], `${w.key} (invalid body: ${invalid})`).toEqual([403, `${PROBLEM}forbidden-scope`]);
      }
    }
    expect((await settings('admin')).company.updatedAt).toBeNull();
  });

  it('installation routes as the central admin of a company that does not own it: 404, before validation', async () => {
    for (const w of WRITES.filter((x) => x.installation)) {
      for (const invalid of [false, true]) {
        const res = await w.call('beta', invalid);
        expect([res.status, res.body.type], `${w.key} (invalid body: ${invalid})`).toEqual([404, `${PROBLEM}not-found`]);
      }
    }
  });

  it('the owning company\'s central admin with an invalid body: 422; unknown logo kind 404; unsafe methods need the XSRF token', async () => {
    for (const w of WRITES.filter((x) => x.key.startsWith('PUT'))) {
      const res = await w.call('admin', true);
      expect([res.status, res.body.type], w.key).toEqual([422, `${PROBLEM}validation-error`]);
    }
    await upload('admin', '/api/branding/company/logos/favicon', PNG).expect(404);
    await client('admin').delete('/api/branding/company/logos/favicon').expect(404);
    await request(app.getHttpServer()).put('/api/branding/company').set('X-Dev-User-Id', USERS.admin.id).set('X-Dev-Company-Id', COMPANY_A).send(COMPANY_BODY).expect(403);
    await request(app.getHttpServer()).delete('/api/branding/installation').set('X-Dev-User-Id', USERS.admin.id).set('X-Dev-Company-Id', COMPANY_A).expect(403);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('texts are data', () => {

  it('markup is stored and returned byte for byte, as JSON', async () => {
    const xss = '<img src=x onerror=alert(1)>';
    const script = '<script>alert("x")</script> & "co"';
    const res = await put({ appTitle: t(xss), welcomeMessage: t(script), footer: t("R&D <b>'Groupe'</b>") }).expect(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.body.company.appTitle.fr).toBe(xss);
    expect(res.body.company.welcomeMessage.fr).toBe(script);
    const [row] = await query<{ app_title_fr: string; welcome_message_fr: string; footer_fr: string }>(db.superuserUrl, 'select app_title_fr, welcome_message_fr, footer_fr from company_branding where company_id = $1', [COMPANY_A]);
    expect(row).toEqual({ app_title_fr: xss, welcome_message_fr: script, footer_fr: "R&D <b>'Groupe'</b>" });
    const mine = await client('est').get('/api/me').expect(200);
    expect(mine.headers['content-type']).toMatch(/^application\/json/);
    expect(mine.body.branding.appTitle.fr).toBe(xss);
    expect(mine.body.branding.welcomeMessage.fr).toBe(script);
  });

  it('control and bidi characters are stripped, spaces and line breaks normalised, NFC applied', async () => {
    const res = await put({
      appTitle: t('  Groupe ‮omeD‬\u0000\u0007  SPA\t', '‏مجموعة‎ ديمو؜'),
      welcomeTitle: t('Bien\r\nvenue', null, 'Wel​come﻿'),
      welcomeMessage: t('Ligne 1\r\n\r\n\r\n\r\nLigne 2 \n  Ligne 3⁦x⁩', 'می‌خواهم'),
      footer: t('Société\u0085 \u009f Démo'),
    }).expect(200);
    expect(res.body.company).toMatchObject({
      appTitle: { fr: 'Groupe omeD SPA', ar: 'مجموعة ديمو', en: null },
      welcomeTitle: { fr: 'Bien venue', ar: null, en: 'Welcome' },
      welcomeMessage: { fr: 'Ligne 1\n\nLigne 2\nLigne 3x', ar: 'می‌خواهم', en: null },
      footer: { fr: 'Société Démo', ar: null, en: null },
    });
  });

  it('lengths are counted in code points after cleaning (Arabic, emoji); empty → null', async () => {
    const ok = await put({ appTitle: t('😀'.repeat(40), 'ع'.repeat(40), `  ${'x'.repeat(40)}​  `), welcomeTitle: t('é'.repeat(80)), footer: t('   ') }).expect(200);
    expect(ok.body.company.appTitle).toEqual({ fr: '😀'.repeat(40), ar: 'ع'.repeat(40), en: 'x'.repeat(40) });
    expect(ok.body.company.footer).toEqual(L0);
    const ko = await put({
      appTitle: t('x'.repeat(41), 'ع'.repeat(41), '😀'.repeat(41)),
      welcomeTitle: t('x'.repeat(81)),
      welcomeMessage: t('x'.repeat(501)),
      footer: t('x'.repeat(201)),
    }).expect(422);
    expect(errors(ko)).toEqual([
      ['appTitle.fr', 'too_long'], ['appTitle.ar', 'too_long'], ['appTitle.en', 'too_long'],
      ['welcomeTitle.fr', 'too_long'], ['welcomeMessage.fr', 'too_long'], ['footer.fr', 'too_long'],
    ]);
    const sign = await client('admin').put('/api/branding/installation').send({ ...INSTALLATION_BODY, signInMessage: t('x'.repeat(501)) }).expect(422);
    expect(errors(sign)).toEqual([['signInMessage.fr', 'too_long']]);
    await client('admin').put('/api/branding/installation').send({ ...INSTALLATION_BODY, signInMessage: t('x'.repeat(500)) }).expect(200);
  });

  it('French is required with another language; at most 6 lines; colours are palette codes', async () => {
    expect(errors(await put({ appTitle: t(null, 'عنوان') }).expect(422))).toEqual([['appTitle.fr', 'fr_required']]);
    expect(errors(await put({ footer: t(' ​ ', null, 'Footer') }).expect(422))).toEqual([['footer.fr', 'fr_required']]);
    expect(errors(await put({ welcomeMessage: t('1\n2\n3\n4\n5\n6\n7') }).expect(422))).toEqual([['welcomeMessage.fr', 'too_many_lines']]);
    await put({ welcomeMessage: t('1\n2\n3\n4\n5\n6') }).expect(200);
    for (const color of ['red', '#1f4e79', 'Blue', '']) expect(errors(await put({ color }).expect(422)), color).toEqual([['color', 'invalid_color']]);
    for (const color of BRAND_COLORS) expect((await put({ color }).expect(200)).body.company.color).toBe(color);
    expect((await put({ color: null }).expect(200)).body.company.color).toBeNull();
    // the installation colour cannot be null
    await client('admin').put('/api/branding/installation').send({ ...INSTALLATION_BODY, color: null }).expect(422);
    expect(errors(await client('admin').put('/api/branding/installation').send({ ...INSTALLATION_BODY, color: 'red' }).expect(422))).toEqual([['color', 'invalid_color']]);
  });

  it('bodies are strict: unknown keys, missing keys and wrong types → 422', async () => {
    await put({ extra: 1 }).expect(422);
    await put({ appTitle: { fr: 'x', ar: null, en: null, de: 'x' } }).expect(422);
    await put({ appTitle: { fr: 'x' } }).expect(422);
    await put({ appTitle: 'x' }).expect(422);
    await put({ appTitle: { fr: 1, ar: null, en: null } }).expect(422);
    await client('admin').put('/api/branding/company').send({ appTitle: L0 }).expect(422);
    await client('admin').put('/api/branding/company').send({ ...COMPANY_BODY, signInMessage: L0 }).expect(422);
    await client('admin').put('/api/branding/installation').send({ ...INSTALLATION_BODY, welcomeTitle: L0 }).expect(422);
  });

  afterAll(resetAll);
});

// ---------------------------------------------------------------------------------------------------------------
describe('logo uploads', () => {

  it.each([
    ['an SVG with a script', SVG, 'logo.svg', 'image/svg+xml', 'unsupported_type'],
    ['an SVG sent as image/png and named logo.png', SVG, 'logo.png', 'image/png', 'unsupported_type'],
    ['an HTML file', HTML, 'logo.html', 'text/html', 'unsupported_type'],
    ['an HTML file named logo.jpg', HTML, 'logo.jpg', 'image/jpeg', 'unsupported_type'],
    ['a GIF', GIF, 'logo.gif', 'image/gif', 'unsupported_type'],
    ['a WebP', WEBP, 'logo.webp', 'image/webp', 'unsupported_type'],
    ['an ICO', ICO, 'favicon.ico', 'image/x-icon', 'unsupported_type'],
    ['a PNG signature followed by garbage', Buffer.concat([PNG.subarray(0, 8), Buffer.from('garbage garbage garbage garbage')]), 'logo.png', 'image/png', 'unsupported_type'],
    ['a truncated PNG (signature and half a header)', PNG.subarray(0, 20), 'logo.png', 'image/png', 'unsupported_type'],
    ['a truncated JPEG', JPEG.subarray(0, 6), 'logo.jpg', 'image/jpeg', 'unsupported_type'],
    ['a small PNG declaring 45 000 × 45 000 px', pngDeclaring(45000, 45000), 'logo.png', 'image/png', 'dimensions_too_large'],
    ['a PNG of 4 001 px on one side', pngDeclaring(4001, 10), 'logo.png', 'image/png', 'dimensions_too_large'],
    ['a JPEG of 4 000 × 4 000 px (16 MP is the limit, 4 000 × 4 000 is exactly 16 MP)', jpeg(4000, 4001), 'logo.jpg', 'image/jpeg', 'dimensions_too_large'],
    ['a 257 KB PNG', pngDeclaring(100, 100, 257 * 1024), 'logo.png', 'image/png', 'too_large'],
    ['a PNG of 256 KB + 1 byte', pngDeclaring(100, 100, 262144 + 1 - 33), 'logo.png', 'image/png', 'too_large'],
    ['an empty file', Buffer.alloc(0), 'logo.png', 'image/png', 'required'],
  ])('refuses %s', async (_name, bytes, filename, contentType, expected) => {
    for (const url of ['/api/branding/company/logos/app', '/api/branding/company/logos/company', '/api/branding/installation/logo']) {
      const res = await upload('admin', url, bytes, filename, contentType);
      expect([res.status, errors(res)], url).toEqual([422, [['file', expected]]]);
    }
  });

  it('refuses a request without a file', async () => {
    const res = await client('admin').put('/api/branding/company/logos/app').field('other', 'x');
    expect([res.status, errors(res)]).toEqual([422, [['file', 'required']]]);
    expect((await settings('admin')).company).toMatchObject({ appLogo: null, companyLogo: null });
  });

  it('accepts a PNG: stored with its sniffed type and pixel size, served under an immutable digest URL', async () => {
    // declared as text/html and named .svg: both are ignored
    const res = await upload('admin', '/api/branding/company/logos/app', PNG, 'evil.svg', 'text/html').expect(200);
    const logo = res.body.company.appLogo;
    expect(logo).toEqual({ url: `/api/branding/logos/app/${sha256(PNG)}`, width: 160, height: 48, mime: 'image/png', sizeBytes: PNG.length });
    expect(res.body.company.companyLogo).toBeNull();
    assertNoSecrets(res.body);
    const image = await client('est').get(logo.url).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(Buffer.compare(image.body as Buffer, PNG)).toBe(0);
    expect(image.headers).toMatchObject({
      'content-type': 'image/png',
      'content-length': String(PNG.length),
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, max-age=31536000, immutable',
      'content-disposition': 'inline; filename="logo.png"',
      etag: `"${sha256(PNG)}"`,
    });
    const [row] = await query<{ mime: string; w: number; h: number; digest: string; n: number }>(
      db.superuserUrl,
      `select app_logo_mime as mime, app_logo_width as w, app_logo_height as h, encode(app_logo_sha256, 'hex') as digest, octet_length(app_logo) as n from company_branding where company_id = $1`,
      [COMPANY_A],
    );
    expect(row).toEqual({ mime: 'image/png', w: 160, h: 48, digest: sha256(PNG), n: PNG.length });
  });

  it('accepts a JPEG (named .png): served as image/jpeg; exactly 256 KB and 4 000 × 4 000 px pass', async () => {
    const res = await upload('admin', '/api/branding/company/logos/company', JPEG, 'logo.png', 'image/png').expect(200);
    expect(res.body.company.companyLogo).toEqual({ url: `/api/branding/logos/company/${sha256(JPEG)}`, width: 3, height: 2, mime: 'image/jpeg', sizeBytes: JPEG.length });
    const image = await client('admin').get(res.body.company.companyLogo.url).expect(200);
    expect(image.headers).toMatchObject({ 'content-type': 'image/jpeg', 'x-content-type-options': 'nosniff', 'content-disposition': 'inline; filename="logo.jpg"' });
    const big = pngDeclaring(4000, 4000, 262144 - 33);
    expect(big).toHaveLength(262144);
    const max = await upload('admin', '/api/branding/company/logos/company', big).expect(200);
    expect(max.body.company.companyLogo).toMatchObject({ width: 4000, height: 4000, sizeBytes: 262144 });
  });

  it('a replaced or deleted logo: the old URL answers 404; a wrong, malformed or other-kind digest too', async () => {
    const old = `/api/branding/logos/app/${sha256(PNG)}`;
    await client('admin').get(old).expect(200);
    await client('admin').get(`/api/branding/logos/company/${sha256(PNG)}`).expect(404); // the app logo is not the company logo
    await client('admin').get(`/api/branding/logos/app/${'0'.repeat(64)}`).expect(404);
    await client('admin').get(`/api/branding/logos/app/${sha256(PNG).toUpperCase()}`).expect(404);
    await client('admin').get('/api/branding/logos/app/abc').expect(404);
    await client('admin').get(`/api/branding/logos/favicon/${sha256(PNG)}`).expect(404);
    await request(app.getHttpServer()).get(old).expect(401);
    const replaced = await upload('admin', '/api/branding/company/logos/app', JPEG).expect(200);
    expect(replaced.body.company.appLogo.url).toBe(`/api/branding/logos/app/${sha256(JPEG)}`);
    await client('admin').get(old).expect(404);
    await client('admin').get(replaced.body.company.appLogo.url).expect(200);
    await client('admin').delete('/api/branding/company/logos/app').expect(204);
    await client('admin').get(replaced.body.company.appLogo.url).expect(404);
    expect((await settings('admin')).company.appLogo).toBeNull();
    // deleting a logo that is not there is still a 204
    await client('admin').delete('/api/branding/company/logos/app').expect(204);
  });

  afterAll(resetAll);
});

// ---------------------------------------------------------------------------------------------------------------
describe('two branded companies: the public default, isolation and inheritance', () => {
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const INSTALLATION = {
    appTitle: t('Portail RH', 'بوابة الموارد البشرية', 'HR portal'),
    signInMessage: t('Assistance : 021 00 00 00\nsupport@groupe.test', 'الدعم'),
    footer: t('Groupe — usage interne', 'المجموعة'),
    color: 'navy',
  };
  const PUBLIC = { ...INSTALLATION, appLogo: { url: `/api/branding/default/logo/${sha256(PNG)}`, width: 160, height: 48 } };
  const A_LOGO = jpeg(30, 10);
  const B_LOGO = jpeg(40, 20);
  const B_APP_LOGO = jpeg(50, 25);

  beforeAll(async () => {
    await client('admin').put('/api/branding/installation').send(INSTALLATION).expect(200);
    await upload('admin', '/api/branding/installation/logo', PNG).expect(200);
    await client('admin').put('/api/branding/company').send({ ...COMPANY_BODY, appTitle: t('RH Démo'), welcomeTitle: t('Bienvenue chez Démo'), color: 'teal' }).expect(200);
    await upload('admin', '/api/branding/company/logos/company', A_LOGO).expect(200);
    await client('beta').put('/api/branding/company').send({ ...COMPANY_BODY, welcomeMessage: t('Bonjour Beta') }).expect(200);
  });

  it('the anonymous body is exactly the installation row as PublicBranding: no extra key, no id, no company code or name', async () => {
    const res = await request(app.getHttpServer()).get('/api/branding/default').expect(200);
    expect(res.body).toEqual(PUBLIC);
    expect(Object.keys(res.body).toSorted()).toEqual(['appLogo', 'appTitle', 'color', 'footer', 'signInMessage']);
    expect(Object.keys(res.body.appLogo).toSorted()).toEqual(['height', 'url', 'width']);
    expect(res.text).not.toMatch(UUID);
    for (const word of ['DEMO', 'BETA', DEMO_ORGANIZATION.company.name, ORG_B.company.name, 'RH Démo', 'Bienvenue', 'Bonjour Beta', 'teal', USERS.admin.email]) {
      expect(res.text, word).not.toContain(word);
    }
    assertNoSecrets(res.body);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('the same body and ETag for every caller: anonymous, company A, company B', async () => {
    const anon = await request(app.getHttpServer()).get('/api/branding/default').expect(200);
    for (const actor of ['admin', 'est', 'newbie', 'beta'] as const) {
      const res = await client(actor).get('/api/branding/default').expect(200);
      expect(res.text, actor).toBe(anon.text);
      expect(res.headers['etag'], actor).toBe(anon.headers['etag']);
      expect(res.headers['set-cookie'], actor).toBeUndefined();
    }
  });

  it('If-None-Match → 304 without a body; the ETag follows the content', async () => {
    const first = await request(app.getHttpServer()).get('/api/branding/default').expect(200);
    const etag = String(first.headers['etag']);
    const cached = await request(app.getHttpServer()).get('/api/branding/default').set('If-None-Match', etag).expect(304);
    expect(cached.text).toBe('');
    expect(cached.headers['etag']).toBe(etag);
    expect(cached.headers['cache-control']).toBe('no-cache');
    await request(app.getHttpServer()).get('/api/branding/default').set('If-None-Match', `"other", W/${etag}`).expect(304);
    await request(app.getHttpServer()).get('/api/branding/default').set('If-None-Match', '"other"').expect(200);
    await client('admin').put('/api/branding/installation').send({ ...INSTALLATION, color: 'plum' }).expect(200);
    const changed = await request(app.getHttpServer()).get('/api/branding/default').set('If-None-Match', etag).expect(200);
    expect(changed.body.color).toBe('plum');
    expect(changed.headers['etag']).not.toBe(etag);
    await client('admin').put('/api/branding/installation').send(INSTALLATION).expect(200);
    // back to the same content → the same tag
    expect((await request(app.getHttpServer()).get('/api/branding/default').expect(200)).headers['etag']).toBe(etag);
  });

  it('the public logo route serves the installation logo for its digest only, never a company logo', async () => {
    const res = await request(app.getHttpServer()).get(PUBLIC.appLogo.url).expect(200);
    expect(res.headers).toMatchObject({
      'content-type': 'image/png',
      'content-length': String(PNG.length),
      'x-content-type-options': 'nosniff',
      'cache-control': 'public, max-age=31536000, immutable',
      'content-disposition': 'inline; filename="logo.png"',
      etag: `"${sha256(PNG)}"`,
    });
    expect(res.headers['set-cookie']).toBeUndefined();
    await upload('beta', '/api/branding/company/logos/company', B_LOGO).expect(200);
    await upload('beta', '/api/branding/company/logos/app', B_APP_LOGO).expect(200);
    for (const digest of [sha256(A_LOGO), sha256(B_LOGO), sha256(B_APP_LOGO), '0'.repeat(64), sha256(PNG).toUpperCase(), 'abc', `${sha256(PNG)}0`]) {
      await request(app.getHttpServer()).get(`/api/branding/default/logo/${digest}`).expect(404);
      await client('beta').get(`/api/branding/default/logo/${digest}`).expect(404);
    }
    // the installation logo is not a company logo either
    await client('admin').get(`/api/branding/logos/app/${sha256(PNG)}`).expect(404);
  });

  it('company logos need a session of that company: another company\'s digest → 404, anonymous → 401', async () => {
    const a = `/api/branding/logos/company/${sha256(A_LOGO)}`;
    const b = `/api/branding/logos/company/${sha256(B_LOGO)}`;
    for (const actor of ['admin', 'est', 'ouest', 'acces', 'newbie', 'target'] as const) await client(actor).get(a).expect(200);
    await client('beta').get(a).expect(404);
    await client('beta').get(b).expect(200);
    await client('admin').get(b).expect(404);
    await client('admin').get(`/api/branding/logos/app/${sha256(B_APP_LOGO)}`).expect(404);
    await request(app.getHttpServer()).get(a).expect(401);
  });

  it('GET /me: each company after inheritance, field by field', async () => {
    // A set its title, welcome title, colour and company logo; its footer and app logo come from the installation
    expect(await me('est')).toEqual({
      appTitle: t('RH Démo'),
      welcomeTitle: t('Bienvenue chez Démo'),
      welcomeMessage: L0,
      footer: INSTALLATION.footer,
      color: 'teal',
      appLogo: PUBLIC.appLogo,
      companyLogo: { url: `/api/branding/logos/company/${sha256(A_LOGO)}`, width: 30, height: 10 },
    });
    // B set a welcome message and both logos: the owner's installation title, colour and footer are inherited
    expect(await me('beta')).toEqual({
      appTitle: INSTALLATION.appTitle,
      welcomeTitle: L0,
      welcomeMessage: t('Bonjour Beta'),
      footer: INSTALLATION.footer,
      color: 'navy',
      appLogo: { url: `/api/branding/logos/app/${sha256(B_APP_LOGO)}`, width: 50, height: 25 },
      companyLogo: { url: `/api/branding/logos/company/${sha256(B_LOGO)}`, width: 40, height: 20 },
    });
    // B sets a French-only title and its own colour: the whole triple is its own (no Arabic borrowed), the footer still inherited
    await client('beta').put('/api/branding/company').send({ ...COMPANY_BODY, appTitle: t('Beta RH'), welcomeMessage: t('Bonjour Beta'), color: 'olive' }).expect(200);
    await client('beta').delete('/api/branding/company/logos/app').expect(204);
    expect(await me('beta')).toMatchObject({ appTitle: t('Beta RH'), footer: INSTALLATION.footer, color: 'olive', appLogo: PUBLIC.appLogo });
    // the non-owner's admin view shows what it inherits, and no installation tab
    const view = await settings('beta');
    expect(view.installation).toBeNull();
    expect(view.inherited).toEqual({ appTitle: INSTALLATION.appTitle, footer: INSTALLATION.footer, color: 'navy', appLogo: PUBLIC.appLogo });
    expect(view.company).toMatchObject({ appTitle: t('Beta RH'), color: 'olive', appLogo: null });
    // A's own colour never reaches the sign-in page
    expect((await request(app.getHttpServer()).get('/api/branding/default')).body.color).toBe('navy');
    for (const actor of ['admin', 'est', 'beta'] as const) assertNoSecrets((await client(actor).get('/api/me').expect(200)).body);
  });

  it('GET /me never reads image bytes: it works with SELECT on the non-image columns only', async () => {
    const columns = (await query<{ c: string }>(db.superuserUrl, `select column_name as c from information_schema.columns where table_name = 'company_branding' and data_type <> 'bytea' or (table_name = 'company_branding' and column_name like '%sha256')`)).map((r) => r.c);
    expect(columns).not.toContain('app_logo');
    expect(columns).toContain('app_logo_sha256');
    await query(db.superuserUrl, `revoke select on table company_branding from hrforce_app`);
    await query(db.superuserUrl, `grant select (${columns.join(', ')}) on table company_branding to hrforce_app`);
    try {
      const res = await client('est').get('/api/me').expect(200);
      expect(res.body.branding.companyLogo).toEqual({ url: `/api/branding/logos/company/${sha256(A_LOGO)}`, width: 30, height: 10 });
      expect(JSON.stringify(res.body.branding).length).toBeLessThan(1000);
      // the image route does need the bytes
      await client('est').get(res.body.branding.companyLogo.url).expect(500);
    } finally {
      await query(db.superuserUrl, `grant select on table company_branding to hrforce_app`);
    }
    await client('est').get(`/api/branding/logos/company/${sha256(A_LOGO)}`).expect(200);
  });

  it('reset: DELETE /branding/company → every text, the colour and both logos null (the row stays); DELETE /branding/installation → texts and logo null, colour blue, row and owner kept', async () => {
    await upload('admin', '/api/branding/company/logos/app', B_APP_LOGO).expect(200);
    await client('admin').delete('/api/branding/company').expect(204);
    const a = await settings('admin');
    expect(a.company).toEqual({ appTitle: L0, welcomeTitle: L0, welcomeMessage: L0, footer: L0, color: null, appLogo: null, companyLogo: null, updatedAt: expect.any(String) });
    expect(await query(db.superuserUrl, 'select 1 from company_branding where company_id = $1', [COMPANY_A])).toHaveLength(1);
    await client('admin').get(`/api/branding/logos/company/${sha256(A_LOGO)}`).expect(404);
    await client('admin').get(`/api/branding/logos/app/${sha256(B_APP_LOGO)}`).expect(404);
    // company A now inherits everything
    expect(await me('admin')).toEqual({ appTitle: INSTALLATION.appTitle, welcomeTitle: L0, welcomeMessage: L0, footer: INSTALLATION.footer, color: 'navy', appLogo: PUBLIC.appLogo, companyLogo: null });
    // a second reset changes nothing and still answers 204
    await client('admin').delete('/api/branding/company').expect(204);

    await client('admin').delete('/api/branding/installation').expect(204);
    expect((await request(app.getHttpServer()).get('/api/branding/default')).body).toEqual({ appTitle: L0, signInMessage: L0, footer: L0, color: 'blue', appLogo: null });
    await request(app.getHttpServer()).get(PUBLIC.appLogo.url).expect(404);
    expect((await settings('admin')).installation).toMatchObject({ appTitle: L0, color: 'blue', appLogo: null });
    expect((await settings('beta')).installation).toBeNull();
    expect(await query<{ company_id: string }>(db.superuserUrl, 'select company_id from installation_branding')).toEqual([{ company_id: COMPANY_A }]);
    await client('admin').delete('/api/branding/installation').expect(204);
    // B keeps its own values, and falls back to the built-in ones for the rest
    expect(await me('beta')).toMatchObject({ appTitle: t('Beta RH'), footer: L0, color: 'olive', appLogo: null });
  });

  afterAll(resetAll);
});

// ---------------------------------------------------------------------------------------------------------------
describe('audit: row triggers, logo bytes masked, nothing for a write that changes nothing', () => {
  it('a text change: one row with the actor, the request id and before / after of the changed columns only', async () => {
    const first = rid();
    await client('admin').put('/api/branding/company').set('X-Request-Id', first).send({ ...COMPANY_BODY, appTitle: t('Titre 1') }).expect(200);
    const [seen] = await changes(first);
    expect(seen).toMatchObject({ table_name: 'company_branding', actor_user_id: USERS.admin.id, company_id: COMPANY_A });
    const second = rid();
    await client('admin').put('/api/branding/company').set('X-Request-Id', second).send({ ...COMPANY_BODY, appTitle: t('Titre 2'), color: 'slate' }).expect(200);
    const rows = await changes(second);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ table_name: 'company_branding', op: 'update', actor_user_id: USERS.admin.id, company_id: COMPANY_A });
    expect(rows[0]?.changed.toSorted()).toEqual(['app_title_fr', 'color', 'updated_at']);
    expect(rows[0]?.before).toMatchObject({ app_title_fr: 'Titre 1', color: null });
    expect(rows[0]?.after).toMatchObject({ app_title_fr: 'Titre 2', color: 'slate' });
  });

  it('a logo: the bytes are ***, the digest, type and size are readable; removal too', async () => {
    const set = rid();
    await upload('admin', '/api/branding/company/logos/company', PNG).set('X-Request-Id', set).expect(200);
    const [row] = await changes(set);
    expect(row?.changed.toSorted()).toEqual(['company_logo', 'company_logo_height', 'company_logo_mime', 'company_logo_sha256', 'company_logo_width', 'updated_at']);
    expect(row?.before).toMatchObject({ company_logo: null, company_logo_sha256: null });
    expect(row?.after).toMatchObject({ company_logo: '***', company_logo_sha256: `\\x${sha256(PNG)}`, company_logo_mime: 'image/png', company_logo_width: 160, company_logo_height: 48 });
    expect(JSON.stringify(row)).not.toContain(PNG.toString('hex').slice(0, 64));
    const installation = rid();
    await upload('admin', '/api/branding/installation/logo', JPEG).set('X-Request-Id', installation).expect(200);
    const [inst] = await changes(installation);
    expect(inst).toMatchObject({ table_name: 'installation_branding', op: 'update', actor_user_id: USERS.admin.id, company_id: COMPANY_A });
    expect(inst?.after).toMatchObject({ app_logo: '***', app_logo_sha256: `\\x${sha256(JPEG)}`, app_logo_mime: 'image/jpeg', app_logo_width: 3, app_logo_height: 2 });
    const removed = rid();
    await client('admin').delete('/api/branding/installation/logo').set('X-Request-Id', removed).expect(204);
    const [gone] = await changes(removed);
    expect(gone?.before).toMatchObject({ app_logo: '***', app_logo_mime: 'image/jpeg' });
    expect(gone?.after).toMatchObject({ app_logo: null, app_logo_sha256: null });
  });

  it('a write that changes nothing writes no audit row, leaves updated_at alone and still answers 200 / 204', async () => {
    const stamp = async () => (await query<{ c: Date; i: Date }>(db.superuserUrl, `select (select updated_at from company_branding where company_id = $1) as c, (select updated_at from installation_branding) as i`, [COMPANY_A]))[0];
    const before = await stamp();
    const same = { ...COMPANY_BODY, appTitle: t('Titre 2'), color: 'slate' };
    const calls: [string, () => request.Test, number][] = [
      ['PUT company (same values)', () => client('admin').put('/api/branding/company').send(same), 200],
      ['PUT company (same values, different spacing)', () => client('admin').put('/api/branding/company').send({ ...same, appTitle: t('  Titre​ 2 ') }), 200],
      ['PUT company logo (same image)', () => upload('admin', '/api/branding/company/logos/company', PNG), 200],
      ['DELETE company logo (none)', () => client('admin').delete('/api/branding/company/logos/app'), 204],
      ['PUT installation (same values)', () => client('admin').put('/api/branding/installation').send(INSTALLATION_BODY), 200],
      ['DELETE installation logo (none)', () => client('admin').delete('/api/branding/installation/logo'), 204],
      ['DELETE installation (nothing set)', () => client('admin').delete('/api/branding/installation'), 204],
      // BETA has no row at all: nothing is created by an empty save, a logo removal or a reset
      ['DELETE company (no row)', () => client('beta').delete('/api/branding/company'), 204],
    ];
    for (const [name, call, status] of calls) {
      const id = rid();
      await call().set('X-Request-Id', id).expect(status);
      expect(await changes(id), name).toEqual([]);
    }
    expect(await stamp()).toEqual(before);
    await query(db.superuserUrl, 'delete from company_branding where company_id = $1', [COMPANY_B]);
    for (const [name, call, status] of [
      ['PUT company (all null, no row)', () => client('beta').put('/api/branding/company').send(COMPANY_BODY), 200],
      ['DELETE company logo (no row)', () => client('beta').delete('/api/branding/company/logos/company'), 204],
      ['DELETE company (no row)', () => client('beta').delete('/api/branding/company'), 204],
    ] as [string, () => request.Test, number][]) {
      const id = rid();
      await call().set('X-Request-Id', id).expect(status);
      expect(await changes(id), name).toEqual([]);
    }
    expect(await query(db.superuserUrl, 'select 1 from company_branding where company_id = $1', [COMPANY_B])).toEqual([]);
    // the first real write of a company creates its row: one insert row
    const created = rid();
    await upload('beta', '/api/branding/company/logos/app', JPEG).set('X-Request-Id', created).expect(200);
    expect((await changes(created)).map((r) => [r.table_name, r.op, r.company_id, r.actor_user_id, r.after?.['app_logo']])).toEqual([['company_branding', 'insert', COMPANY_B, USERS.beta.id, '***']]);
  });

  afterAll(resetAll);
});

// ---------------------------------------------------------------------------------------------------------------
describe('database: RLS and privileges of hrforce_app', () => {
  beforeAll(async () => {
    await client('admin').put('/api/branding/company').send({ ...COMPANY_BODY, appTitle: t('A') }).expect(200);
    await client('admin').put('/api/branding/installation').send({ ...INSTALLATION_BODY, appTitle: t('Installation') }).expect(200);
    await upload('admin', '/api/branding/installation/logo', PNG).expect(200);
  });

  it('a session of company B can neither read nor update installation_branding or A\'s company_branding', async () => {
    expect((await asApp(COMPANY_B, 'select * from installation_branding')).rows).toEqual([]);
    expect((await asApp(COMPANY_B, `update installation_branding set color = 'plum'`)).rowCount).toBe(0);
    expect((await asApp(COMPANY_B, 'select * from company_branding where company_id = $1', [COMPANY_A])).rows).toEqual([]);
    expect((await asApp(COMPANY_B, `update company_branding set color = 'plum' where company_id = $1`, [COMPANY_A])).rowCount).toBe(0);
    await expect(asApp(COMPANY_B, `insert into company_branding (company_id, color) values ($1, 'plum')`, [COMPANY_A])).rejects.toThrow(/row-level security/);
    // the owner sees and may edit its row
    expect((await asApp(COMPANY_A, 'select company_id from installation_branding')).rows).toEqual([{ company_id: COMPANY_A }]);
    expect((await asApp(COMPANY_A, `update installation_branding set color = 'plum'`)).rowCount).toBe(1);
    expect((await query<{ color: string }>(db.superuserUrl, 'select color from installation_branding'))[0]?.color).toBe('blue'); // rolled back
  });

  it('hrforce_app cannot insert or delete in installation_branding, nor move its owner; no DELETE on company_branding', async () => {
    const denied = /permission denied for table installation_branding/;
    await expect(asApp(COMPANY_B, 'insert into installation_branding (company_id) values ($1)', [COMPANY_B])).rejects.toThrow(denied);
    await expect(asApp(COMPANY_A, 'delete from installation_branding')).rejects.toThrow(denied);
    await expect(asApp(COMPANY_A, 'update installation_branding set company_id = $1', [COMPANY_B])).rejects.toThrow(denied);
    await expect(asApp(COMPANY_A, 'update installation_branding set company_id = company_id')).rejects.toThrow(denied);
    await expect(asApp(COMPANY_A, 'update installation_branding set singleton = true')).rejects.toThrow(denied);
    await expect(asApp(COMPANY_A, 'delete from company_branding')).rejects.toThrow(/permission denied for table company_branding/);
    const grants = await query<{ privilege_type: string }>(db.superuserUrl, `select privilege_type from information_schema.role_table_grants where grantee = 'hrforce_app' and table_name = 'installation_branding'`);
    expect(grants.map((g) => g.privilege_type)).toEqual(['SELECT']);
    const columns = await query<{ column_name: string }>(db.superuserUrl, `select column_name from information_schema.role_column_grants where grantee = 'hrforce_app' and table_name = 'installation_branding' and privilege_type = 'UPDATE'`);
    expect(columns.map((c) => c.column_name)).not.toContain('company_id');
    expect(columns.map((c) => c.column_name)).not.toContain('singleton');
    expect(columns).toHaveLength(17);
  });

  it('the table holds at most one row, and the checks refuse what the API refuses', async () => {
    await expect(query(db.superuserUrl, 'insert into installation_branding (company_id) values ($1)', [COMPANY_B])).rejects.toThrow(/installation_branding_pkey/);
    await expect(query(db.superuserUrl, 'insert into installation_branding (singleton, company_id) values (false, $1)', [COMPANY_B])).rejects.toThrow(/installation_branding_singleton_ck/);
    const refused: [string, RegExp][] = [
      [`update company_branding set app_title_fr = repeat('x', 41)`, /company_branding_app_title_ck/],
      [`update company_branding set app_title_fr = ''`, /company_branding_app_title_ck/],
      [`update company_branding set app_title_fr = null, app_title_ar = 'ع'`, /company_branding_app_title_ck/],
      [`update company_branding set color = 'red'`, /company_branding_color_ck/],
      [`update company_branding set app_logo = '\\x00'`, /company_branding_app_logo_ck/],
      [`update company_branding set company_logo = '\\x00', company_logo_mime = 'image/svg+xml', company_logo_sha256 = sha256('x'), company_logo_width = 1, company_logo_height = 1`, /company_branding_company_logo_ck/],
      [`update company_branding set company_logo = '\\x00', company_logo_mime = 'image/png', company_logo_sha256 = sha256('x'), company_logo_width = 4000, company_logo_height = 4001`, /company_branding_company_logo_ck/],
      [`update installation_branding set color = null`, /null value in column "color"/],
      [`update installation_branding set sign_in_message_fr = repeat('x', 501)`, /installation_branding_sign_in_message_ck/],
      [`update installation_branding set footer_en = 'x'`, /installation_branding_footer_ck/],
    ];
    for (const [statement, error] of refused) await expect(query(db.superuserUrl, statement), statement).rejects.toThrow(error);
    // char_length counts code points, like the API: 40 emoji fit
    await query(db.superuserUrl, `update company_branding set app_title_en = repeat('😀', 40) where company_id = $1`, [COMPANY_A]);
    await query(db.superuserUrl, `update company_branding set app_title_en = null where company_id = $1`, [COMPANY_A]);
  });

  it('the two definer functions: pinned search_path, EXECUTE for hrforce_app only, no company id and no bytes in the first', async () => {
    const functions = await query<{ proname: string; prosecdef: boolean; proconfig: string[] | null; owner: string; acl: string }>(
      db.superuserUrl,
      `select p.proname, p.prosecdef, p.proconfig, r.rolname as owner, p.proacl::text as acl
         from pg_proc p join pg_roles r on r.oid = p.proowner
        where p.pronamespace = 'public'::regnamespace and p.proname like 'branding_installation_%' order by 1`,
    );
    expect(functions.map((f) => f.proname)).toEqual(['branding_installation_default', 'branding_installation_logo']);
    for (const f of functions) {
      expect(f).toMatchObject({ prosecdef: true, owner: 'hrforce_migrator', proconfig: ['search_path=pg_catalog, public'] });
      expect(f.acl).toBe('{hrforce_migrator=X/hrforce_migrator,hrforce_app=X/hrforce_migrator}');
    }
    // as BETA (not the owner), and without any tenant
    for (const company of [COMPANY_B, '00000000-0000-0000-0000-000000000000']) {
      const { rows } = await asApp(company, 'select * from public.branding_installation_default()');
      expect(rows).toHaveLength(1);
      expect(Object.keys(rows[0] ?? {}).toSorted()).toEqual([
        'app_logo_height', 'app_logo_mime', 'app_logo_sha256', 'app_logo_width', 'app_title_ar', 'app_title_en', 'app_title_fr', 'color',
        'footer_ar', 'footer_en', 'footer_fr', 'sign_in_message_ar', 'sign_in_message_en', 'sign_in_message_fr',
      ]);
      expect(rows[0]).toMatchObject({ app_title_fr: 'Installation', color: 'blue', app_logo_mime: 'image/png' });
      expect((await asApp(company, 'select mime, octet_length(bytes) as n from public.branding_installation_logo($1)', [Buffer.from(sha256(PNG), 'hex')])).rows).toEqual([{ mime: 'image/png', n: PNG.length }]);
      expect((await asApp(company, 'select * from public.branding_installation_logo($1)', [Buffer.from(sha256(JPEG), 'hex')])).rows).toEqual([]);
      expect((await asApp(company, 'select * from public.branding_installation_logo(null)')).rows).toEqual([]);
    }
    const worker = new Client({ connectionString: db.workerUrl });
    await worker.connect();
    try {
      await expect(worker.query('select * from public.branding_installation_default()')).rejects.toThrow(/permission denied for function/);
    } finally {
      await worker.end();
    }
  });

  afterAll(resetAll);
});

// ---------------------------------------------------------------------------------------------------------------
describe('owning company: seed, bootstrap, CLI, migration', () => {
  it('seedBrandingDefaults creates the row only when none exists: the first company keeps it', async () => {
    expect(await owner()).toEqual(['DEMO']);
    await asMigrator((tx) => seedBrandingDefaults(tx, COMPANY_B));
    expect(await owner()).toEqual(['DEMO']);
    // a later company created by bootstrap does not take it either
    const created = await asMigrator((tx) =>
      bootstrapCompany(tx, { companyCode: 'GAMMA', companyName: 'Gamma SPA', rootCode: 'G-DG', rootName: 'Direction', siteCode: 'G-HQ', siteName: 'Siège', wilaya: 'Alger', adminEmail: 'admin@gamma.test', adminName: 'Admin Gamma' }, '2026-10-01'),
    );
    expect(await owner()).toEqual(['DEMO']);
    // new companies: admin_rh_central holds settings.branding, and the default two-step sign-in list requires it
    const held = await query(db.superuserUrl, `select 1 from role_permission rp join role r on r.id = rp.role_id where r.company_id = $1 and rp.permission_code = 'settings.branding'`, [created.companyId]);
    expect(held).toHaveLength(1);
    const [policy] = await query<{ mfa_enforced: boolean; codes: string[] }>(db.superuserUrl, 'select mfa_enforced, mfa_required_permissions as codes from security_policy where company_id = $1', [created.companyId]);
    expect(policy?.mfa_enforced).toBe(true);
    expect(policy?.codes).toContain('settings.branding');
  });

  it('bootstrap on a database without a row makes the new company the owner', async () => {
    const empty = await createTestDatabase();
    const migrator = createDatabase({ connectionString: empty.migratorUrl, maxConnections: 1 });
    try {
      expect(await query(empty.superuserUrl, 'select 1 from installation_branding')).toEqual([]);
      const first = await migrator.transaction().execute((tx) =>
        bootstrapCompany(tx, { companyCode: 'ACME', companyName: 'ACME SPA', rootCode: 'DG', rootName: 'Direction Générale', siteCode: 'HQ', siteName: 'Siège', wilaya: 'Alger', adminEmail: 'admin@acme.test', adminName: 'Admin' }, '2026-10-01'),
      );
      await migrator.transaction().execute((tx) =>
        bootstrapCompany(tx, { companyCode: 'OTHER', companyName: 'Other SPA', rootCode: 'O-DG', rootName: 'Direction', siteCode: 'O-HQ', siteName: 'Siège', wilaya: 'Oran', adminEmail: 'admin@other.test', adminName: 'Admin' }, '2026-10-01'),
      );
      expect(await query(empty.superuserUrl, 'select company_id, color from installation_branding')).toEqual([{ company_id: first.companyId, color: 'blue' }]);
      // seed:dev's demo branding on a database owned by someone else: the installation default is left alone
      await migrator.transaction().execute((tx) => seedDemoBranding(tx, first.companyId, PNG));
      const [row] = await query<{ footer_fr: string; sign_in_message_ar: string; color: string; logo: Buffer | null }>(empty.superuserUrl, 'select footer_fr, sign_in_message_ar, color, app_logo as logo from installation_branding');
      expect(row).toEqual({ footer_fr: DEMO_BRANDING.footer.fr, sign_in_message_ar: DEMO_BRANDING.signInMessage.ar, color: 'blue', logo: null });
      const [company] = await query<{ welcome_message_en: string; w: number; h: number; mime: string }>(
        empty.superuserUrl,
        'select welcome_message_en, company_logo_width as w, company_logo_height as h, company_logo_mime as mime from company_branding where company_id = $1',
        [first.companyId],
      );
      expect(company).toEqual({ welcome_message_en: DEMO_BRANDING.welcomeMessage.en, w: 160, h: 48, mime: 'image/png' });
      // idempotent
      await migrator.transaction().execute((tx) => seedDemoBranding(tx, first.companyId, JPEG));
      expect((await query<{ mime: string }>(empty.superuserUrl, 'select company_logo_mime as mime from company_branding'))[0]?.mime).toBe('image/png');
    } finally {
      await migrator.destroy();
      await empty.drop();
    }
  });

  it('branding:owner moves the row and keeps its content; the installation tab follows; unknown code fails', async () => {
    await client('admin').put('/api/branding/installation').send({ ...INSTALLATION_BODY, appTitle: t('Portail', 'بوابة'), color: 'indigo' }).expect(200);
    await upload('admin', '/api/branding/installation/logo', PNG).expect(200);
    expect(await asMigrator((tx) => moveBrandingOwner(tx, 'BETA'))).toEqual({ previous: 'DEMO', current: 'BETA', changed: true });
    expect(await owner()).toEqual(['BETA']);
    const moved = (await request(app.getHttpServer()).get('/api/branding/default').expect(200)).body;
    expect(moved).toEqual({ appTitle: t('Portail', 'بوابة'), signInMessage: L0, footer: L0, color: 'indigo', appLogo: { url: `/api/branding/default/logo/${sha256(PNG)}`, width: 160, height: 48 } });
    expect((await settings('beta')).installation).toMatchObject({ appTitle: t('Portail', 'بوابة'), color: 'indigo' });
    expect((await settings('admin')).installation).toBeNull();
    await client('admin').put('/api/branding/installation').send(INSTALLATION_BODY).expect(404);
    await client('beta').put('/api/branding/installation').send({ ...INSTALLATION_BODY, appTitle: t('Portail Beta') }).expect(200);
    // already the owner: nothing changes
    expect(await asMigrator((tx) => moveBrandingOwner(tx, 'BETA'))).toEqual({ previous: 'BETA', current: 'BETA', changed: false });
    await expect(asMigrator((tx) => moveBrandingOwner(tx, 'NOPE'))).rejects.toThrow(/no company with code NOPE/);
    expect(await owner()).toEqual(['BETA']);
    // no row at all: the CLI creates it; meanwhile the public endpoint answers the built-in default
    await query(db.superuserUrl, 'delete from installation_branding');
    expect((await request(app.getHttpServer()).get('/api/branding/default').expect(200)).body).toEqual({ appTitle: L0, signInMessage: L0, footer: L0, color: 'blue', appLogo: null });
    expect((await settings('admin')).installation).toBeNull();
    expect((await settings('beta')).installation).toBeNull();
    await client('admin').delete('/api/branding/installation').expect(404);
    expect(await asMigrator((tx) => moveBrandingOwner(tx, 'DEMO'))).toEqual({ previous: null, current: 'DEMO', changed: true });
    expect(await owner()).toEqual(['DEMO']);
    expect((await settings('admin')).installation).toMatchObject({ appTitle: L0, color: 'blue' });
  });

  it('migration 0021 on an existing installation: the oldest company owns the default, admin_rh_central gets the permission, policies get the code once', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'hrforce-pre-branding-'));
    let old: TestDatabase | undefined;
    try {
      for (const f of (await loadMigrationFiles(DEFAULT_MIGRATIONS_DIR)).filter((m) => m.version <= 20)) await cp(path.join(DEFAULT_MIGRATIONS_DIR, f.fileName), path.join(dir, f.fileName));
      old = await createTestDatabase({ migrationsDir: dir });
      const [young, elder] = ['0190a5d0-0000-7000-8000-0000000000e1', '0190a5d0-0000-7000-8000-0000000000e2'];
      await query(old.superuserUrl, `insert into company (id, code, name, created_at) values ($1, 'AAA', 'Jeune', '2026-05-01'), ($2, 'ZZZ', 'Ancienne', '2025-01-01')`, [young, elder]);
      await query(old.superuserUrl, `insert into role (company_id, code, name_fr, name_ar, name_en, is_system) values ($1, 'admin_rh_central', 'A', 'أ', 'A', true), ($1, 'lecture', 'L', 'ل', 'L', true)`, [elder]);
      await query(old.superuserUrl, `insert into security_policy (company_id, mfa_enforced, mfa_required_permissions) values ($1, true, '{access.grant}'), ($2, false, '{access.grant,leave.configure}')`, [young, elder]);
      const result = await runMigrations({ connectionString: old.migratorUrl });
      expect(result.applied).toEqual(['0021_branding.sql']);
      expect(await query(old.superuserUrl, 'select company_id, color, app_title_fr from installation_branding')).toEqual([{ company_id: elder, color: 'blue', app_title_fr: null }]);
      expect(await query(old.superuserUrl, `select r.code from role_permission rp join role r on r.id = rp.role_id where rp.permission_code = 'settings.branding'`)).toEqual([{ code: 'admin_rh_central' }]);
      expect(await query(old.superuserUrl, 'select mfa_required_permissions as codes from security_policy order by company_id')).toEqual([
        { codes: ['access.grant', 'settings.branding'] },
        { codes: ['access.grant', 'leave.configure', 'settings.branding'] },
      ]);
      expect(await query(old.superuserUrl, `select group_code, sensitive, sort_order from permission where code = 'settings.branding'`)).toEqual([{ group_code: 'settings', sensitive: false, sort_order: 1010 }]);
    } finally {
      await old?.drop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  afterAll(resetAll);
});

// ---------------------------------------------------------------------------------------------------------------
describe('permission and two-step sign-in', () => {
  it('settings.branding: group settings, held by admin_rh_central only, in the default two-step list', async () => {
    const holders = await query<{ code: string }>(db.superuserUrl, `select distinct r.code from role_permission rp join role r on r.id = rp.role_id where rp.permission_code = 'settings.branding' and r.is_system`);
    expect(holders).toEqual([{ code: 'admin_rh_central' }]);
    const [defaults] = await query<{ codes: string[] }>(db.superuserUrl, 'select public.security_policy_default_permissions() as codes');
    expect(defaults?.codes).toContain('settings.branding');
    expect(defaults?.codes).toEqual(expect.arrayContaining(['access.grant', 'sso.manage_apps', 'employee.salary.read']));
    expect(defaults?.codes).not.toContain('employee.read');
    const catalogue = await client('admin').get('/api/access/permissions').expect(200);
    expect((catalogue.body.items as { code: string; group: string; sensitive: boolean; labels: Record<string, string> }[]).at(-1)).toEqual({
      code: 'settings.branding',
      group: 'settings',
      sensitive: false,
      labels: { fr: "Personnaliser l'identité visuelle (titre, logos, couleur, messages)", ar: 'تخصيص الهوية البصرية (العنوان، الشعارات، اللون، الرسائل)', en: 'Customise branding (title, logos, colour, messages)' },
    });
    expect((await client('admin').get('/api/me')).body.permissions).toContain('settings.branding');
    for (const actor of ['est', 'ouest', 'acces', 'target'] as const) expect((await client(actor).get('/api/me')).body.permissions, actor).not.toContain('settings.branding');
  });

  it('with the policy enforced, a holder without a second factor is sent to enrol; the logos and /me stay reachable', async () => {
    await upload('admin', '/api/branding/company/logos/company', PNG).expect(200);
    await query(db.superuserUrl, `update security_policy set mfa_enforced = true, mfa_required_permissions = public.security_policy_default_permissions() where company_id = $1`, [COMPANY_A]);
    try {
      for (const call of [() => client('admin').get('/api/branding/settings'), () => client('admin').put('/api/branding/company').send(COMPANY_BODY), () => client('admin').delete('/api/branding/installation')]) {
        const res = await call();
        expect([res.status, res.body.type]).toEqual([403, `${PROBLEM}mfa-enrollment-required`]);
      }
      // the regional holder too: the permission is in the list wherever it is held
      expect((await client('newbie').get('/api/branding/settings')).body.type).toBe(`${PROBLEM}mfa-enrollment-required`);
      const mine = await client('admin').get('/api/me').expect(200);
      expect(mine.body.mfa).toMatchObject({ required: true, enabled: false });
      await client('admin').get(mine.body.branding.companyLogo.url).expect(200);
      await client('admin').get('/api/branding/default').expect(200);
      // someone the policy does not cover is unaffected
      await client('ouest').get(mine.body.branding.companyLogo.url).expect(200);
    } finally {
      await query(db.superuserUrl, `update security_policy set mfa_enforced = false where company_id = $1`, [COMPANY_A]);
    }
    await client('admin').get('/api/branding/settings').expect(200);
  });
});
