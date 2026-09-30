/**
 * Attendance, Phase A (docs/contracts/attendance.md, ADR 009): the QR check-in (tokens, scan receipt, punch at the scan
 * instant, duplicates and replays, the XSRF-unbound scan), kiosk pairing / credential / revocation / allowed networks,
 * manual punches and voids, schedules and their resolution, the daily status, scopes (HR, lecture, unit heads,
 * employees), the retention purge and the punch audit events without personal payload.
 */
import type { NestExpressApplication } from '@nestjs/platform-express';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { algiersDate, AttendanceClock, attendanceSha256, DEMO_KIOSKS, DEMO_SCHEDULES, windowOf } from '../src/modules/attendance/index.js';
import { DEMO_PASSWORD } from '../src/modules/identity/index.js';
import { createDatabase, type Database } from '../src/platform/db/database.js';
import { issueXsrfToken } from '../src/platform/security/xsrf.js';
import { attendanceRetentionTask, type WorkerDeps } from '../src/worker/tasks.js';
import { companyOf, COMPANY_A, COMPANY_B, employeeA, seedAccessFixture, unitA, USERS, type ActorName } from './support/access-fixture.js';
import { assertNoSecrets } from './support/assert-no-secrets.js';
import { BETA_KIOSK, qrToken, scanReceipt } from './support/attendance-fixture.js';
import { Browser } from './support/cookie-jar.js';
import { createTestApp, TEST_SECRETS } from './support/test-app.js';
import { createTestDatabase, query, type TestDatabase } from './support/test-database.js';
import { fetchXsrf, setCookieHeaders, type XsrfPair } from './support/xsrf.js';

/** The attendance clock of the app: real time unless pinned. */
const clock = {
  pinned: null as number | null,
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
let seq = 0;

const CNE = DEMO_KIOSKS.cne.id;
const ANNABA = DEMO_KIOSKS.annaba.id;
const PROBLEM = (slug: string) => `urn:hrforce:problem:${slug}`;
/** Sunday 2026-09-27, 07:55 in Algiers. */
const T_TODAY = Date.parse('2026-09-27T06:55:00Z');

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** A request as an actor (DEV headers; null = anonymous) with extra cookies and the anon XSRF pair on unsafe methods. */
function call(actor: ActorName | null, method: Method, url: string, opts: { cookie?: string; body?: object; headers?: Record<string, string> } = {}) {
  let t = request(app.getHttpServer())[method](url);
  if (actor) t = t.set('X-Dev-User-Id', USERS[actor].id).set('X-Dev-Company-Id', companyOf(actor));
  const cookies = [method === 'get' ? null : xsrf.cookie, opts.cookie ?? null].filter(Boolean).join('; ');
  if (cookies) t = t.set('Cookie', cookies);
  if (method !== 'get') t = t.set('X-XSRF-TOKEN', xsrf.token);
  for (const [k, v] of Object.entries(opts.headers ?? {})) t = t.set(k, v);
  return opts.body ? t.send(opts.body) : t;
}

const punchAs = (actor: ActorName, receipt: string) => call(actor, 'post', '/api/me/attendance/punches', { cookie: receipt });

function cookieLine(res: { headers: Record<string, unknown> }, name: string): string | undefined {
  return setCookieHeaders(res).find((c) => c.startsWith(`${name}=`));
}

async function punchCount(employmentId: string): Promise<number> {
  const [row] = await query<{ n: number }>(db.superuserUrl, 'select count(*)::int as n from attendance_punch where employment_id = $1', [employmentId]);
  return row?.n ?? 0;
}

async function leave(n: number, date: string, status: 'approved' | 'pending', halfDayEnd = false): Promise<string> {
  const unit = (await query<{ unit: string }>(db.superuserUrl, `select org_unit_id as unit from assignment where employment_id = $1 order by lower(valid) desc limit 1`, [employeeA(n)]))[0]?.unit;
  const [row] = await query<{ id: string }>(
    db.superuserUrl,
    `insert into leave_request (company_id, employment_id, leave_type_id, org_unit_id, start_date, end_date, days, half_day_end, status, requested_by)
     values ($1, $2, (select id from leave_type where company_id = $1 and code = 'annual'), $3, $4, $4, $5, $6, $7, $8) returning id`,
    [COMPANY_A, employeeA(n), unit, date, halfDayEnd ? 0.5 : 1, halfDayEnd, status, USERS.admin.id],
  );
  return row?.id ?? '';
}

async function qrPunchSql(n: number, deviceId: string, iso: string, ref: string | null): Promise<string> {
  const site = (await query<{ site: string }>(db.superuserUrl, 'select site_id as site from attendance_device where id = $1', [deviceId]))[0]?.site;
  const at = new Date(iso);
  const [row] = await query<{ id: string }>(
    db.superuserUrl,
    `insert into attendance_punch (company_id, employment_id, direction, occurred_at, source, device_id, qr_window, site_id, device_ref)
     values ($1, $2, 'in', $3, 'qr', $4, $5, $6, $7) returning id`,
    [COMPANY_A, employeeA(n), at, deviceId, windowOf(at.getTime()), site, ref],
  );
  return row?.id ?? '';
}

beforeAll(async () => {
  db = await createTestDatabase();
  await seedAccessFixture(db, undefined, { leave: true, attendance: true });
  app = await createTestApp(db, { devAuth: true, devPermissions: false, env: { TRUST_PROXY_HOPS: '1' }, overrides: [{ provide: AttendanceClock, useValue: clock }] });
  xsrf = await fetchXsrf(app);
});

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

// ---------------------------------------------------------------------------------------------------------------
describe('scan: tokens and windows', () => {
  it('a current-window token → 200, the receipt and the device cookies, no secret in the body', async () => {
    const now = Date.now();
    const res = await call(null, 'post', '/api/attendance/scan', { body: { token: qrToken(CNE, windowOf(now)) } }).expect(200);
    assertNoSecrets(res.body);
    expect(res.body).toMatchObject({ kiosk: { labels: { fr: 'Constantine — Entrée' }, site: { code: 'CNE' } } });
    expect(res.body.localTime).toMatch(/^\d{2}:\d{2}$/);
    expect(Date.parse(res.body.receiptExpiresAt) - Date.parse(res.body.scannedAt)).toBe(300_000);
    expect(cookieLine(res, 'hrf_scan')).toMatch(/Max-Age=300; Path=\/api\/me\/attendance; HttpOnly; SameSite=Strict$/);
    expect(cookieLine(res, 'hrf_dev')).toMatch(/Max-Age=34560000; Path=\/api\/me\/attendance; HttpOnly; SameSite=Strict$/);
  });

  it('the previous window is accepted; older and future windows → 410; forged, other kiosk/company, revoked, pending, malformed → 422', async () => {
    const w = windowOf(Date.now());
    await call(null, 'post', '/api/attendance/scan', { body: { token: qrToken(CNE, w - 1) } }).expect(200);
    for (const window of [w - 2, w + 1, w + 3]) {
      const res = await call(null, 'post', '/api/attendance/scan', { body: { token: qrToken(CNE, window) } }).expect(410);
      expect(res.body.type).toBe(PROBLEM('attendance-qr-expired'));
    }
    const good = Buffer.from(qrToken(CNE, w), 'base64url');
    good[50] = (good[50] ?? 0) ^ 1;
    const invalid = [
      good.toString('base64url'),
      qrToken(BETA_KIOSK, w), // BETA's kiosk claimed for company A
      qrToken(CNE, w, COMPANY_B),
      qrToken(DEMO_KIOSKS.oran.id, w), // revoked
      qrToken(DEMO_KIOSKS.hq.id, w), // pending
      'not-a-token',
    ];
    for (const token of invalid) {
      const res = await call(null, 'post', '/api/attendance/scan', { body: { token } }).expect(422);
      expect(res.body.type, token).toBe(PROBLEM('attendance-qr-invalid'));
    }
  });
});

describe('the phone flow: scan → sign in → punch at the scan instant', () => {
  afterAll(() => {
    clock.pinned = null;
  });

  it('the receipt survives the sign-in; the punch keeps the scan time; the receipt is then cleared; replays are duplicates', async () => {
    const t1 = Date.parse('2026-09-28T06:58:10Z'); // Monday 07:58 in Algiers
    clock.pinned = t1;
    const phone = new Browser(app);
    await phone.get('/api/auth/csrf');
    expect((await phone.post('/api/attendance/scan', { token: qrToken(ANNABA, windowOf(t1)) })).status).toBe(200);
    const receipt = phone.jar.get('hrf_scan') ?? '';
    // no session yet: 401 (the web's refresh interceptor sends the employee to the login page)
    expect((await phone.post('/api/me/attendance/punches')).status).toBe(401);
    expect((await phone.login('agent.annaba@demo.dz', DEMO_PASSWORD)).status).toBe(204);
    clock.pinned = t1 + 150_000; // signing in took 2.5 minutes
    const res = await phone.post('/api/me/attendance/punches');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    assertNoSecrets(res.body);
    expect(res.body).toMatchObject({ duplicate: false, punch: { direction: 'in', source: 'qr', occurredAt: new Date(t1).toISOString(), localTime: '07:58', workDate: '2026-09-28', kiosk: { id: ANNABA }, createdBy: null, _actions: [] } });
    expect(res.body.day).toMatchObject({ date: '2026-09-28', status: 'late', lateMinutes: 28, flags: ['open'] });
    expect(res.body.day.punches).toBeUndefined();
    expect(cookieLine(res, 'hrf_scan')).toMatch(/^hrf_scan=; Max-Age=0/);
    const [row] = await query<{ device_ref: string | null; received_at: Date; occurred_at: Date }>(db.superuserUrl, 'select device_ref, received_at, occurred_at from attendance_punch where id = $1', [res.body.punch.id]);
    expect(row?.device_ref).toMatch(/^[0-9a-f]{32}$/);
    // replaying the old receipt: the same punch, nothing written
    const replay = await punchAs('agent', `hrf_scan=${receipt}`).expect(200);
    expect(replay.body).toMatchObject({ duplicate: true, punch: { id: res.body.punch.id } });
    expect(await punchCount(employeeA(30))).toBe(1);
  });

  it('direction is inferred; a second scan within 2 minutes returns the first punch; after the gap → out, then in', async () => {
    const t = Date.parse('2026-09-28T06:58:10Z');
    clock.pinned = t + 90_000;
    const dup = await punchAs('agent', scanReceipt(ANNABA, t + 90_000)).expect(200);
    expect(dup.body.duplicate).toBe(true);
    clock.pinned = t + 8 * 3600_000;
    const outRes = await punchAs('agent', scanReceipt(ANNABA, t + 8 * 3600_000));
    expect(outRes.status, JSON.stringify(outRes.body)).toBe(201);
    const out = outRes;
    expect(out.body.punch.direction).toBe('out');
    expect(out.body.day).toMatchObject({ status: 'late', flags: [] });
    clock.pinned = t + 8 * 3600_000 + 300_000;
    const back = await punchAs('agent', scanReceipt(ANNABA, t + 8 * 3600_000 + 300_000)).expect(201);
    expect(back.body.punch.direction).toBe('in');
  });

  it('a receipt older than 5 minutes, tampered, or of a revoked kiosk is refused', async () => {
    const t = Date.parse('2026-09-28T12:00:00Z');
    clock.pinned = t + 301_000;
    expect((await punchAs('chef', scanReceipt(ANNABA, t)).expect(409)).body.type).toBe(PROBLEM('attendance-no-scan'));
    expect((await punchAs('chef', 'hrf_scan=AAAA').expect(409)).body.type).toBe(PROBLEM('attendance-no-scan'));
    expect((await punchAs('chef', '').expect(409)).body.type).toBe(PROBLEM('attendance-no-scan'));
    expect((await punchAs('chef', scanReceipt(DEMO_KIOSKS.oran.id, t + 300_000)).expect(422)).body.type).toBe(PROBLEM('attendance-qr-invalid'));
    expect((await punchAs('admin', scanReceipt(ANNABA, t + 300_000)).expect(409)).body.type).toBe(PROBLEM('attendance-not-linked'));
  });

  it('the same token by two employees → both 201; one employee scanning in parallel → one punch (unique index)', async () => {
    const t = Date.parse('2026-09-21T06:40:00Z');
    clock.pinned = t + 5_000;
    const receipt = scanReceipt(ANNABA, t);
    await punchAs('chef', receipt).expect(201);
    await punchAs('est', receipt).expect(201);
    const results = await Promise.all(Array.from({ length: 6 }, () => punchAs('agent', receipt)));
    expect(results.map((r) => r.status).toSorted()).toEqual([200, 200, 200, 200, 200, 201]);
    const rows = await query<{ n: number }>(db.superuserUrl, `select count(*)::int as n from attendance_punch where employment_id = $1 and work_date = '2026-09-21'`, [employeeA(30)]);
    expect(rows[0]?.n).toBe(1);
    await expect(
      query(
        db.superuserUrl,
        `insert into attendance_punch (company_id, employment_id, direction, occurred_at, source, device_id, qr_window, site_id)
         select company_id, employment_id, 'out', occurred_at + interval '5 minutes', source, device_id, qr_window, site_id
           from attendance_punch where employment_id = $1 and work_date = '2026-09-21' limit 1`,
        [employeeA(30)],
      ),
    ).rejects.toThrow(/attendance_punch_qr_window_uk/);
  });

  it('a punch at 23:30Z counts for the next Algerian day', async () => {
    const t = Date.parse('2026-09-26T23:30:00Z');
    clock.pinned = t + 1_000;
    const res = await punchAs('chef', scanReceipt(ANNABA, t)).expect(201);
    expect(res.body.punch).toMatchObject({ workDate: '2026-09-27', localTime: '00:30' });
  });

  it('XSRF-unbound scan with a stale session-bound XSRF cookie → 200; the punch then answers 401, not 403', async () => {
    clock.pinned = null;
    const phone = new Browser(app);
    phone.jar.set('XSRF-TOKEN', issueXsrfToken(TEST_SECRETS.AUTH_XSRF_SECRET, 'expired-session-id'), '/');
    const scan = await phone.post('/api/attendance/scan', { token: qrToken(CNE, windowOf(Date.now())) });
    expect(scan.status, JSON.stringify(scan.body)).toBe(200);
    const punch = await phone.post('/api/me/attendance/punches');
    expect(punch.status).toBe(401);
    expect(punch.body.type).not.toBe(PROBLEM('xsrf'));
    // the signature is still checked on ordinary public writes, and header/cookie must still match everywhere
    expect((await phone.post('/api/kiosk/pair', { code: 'ABCD-EFGH' })).status).toBe(403);
    const mismatch = await request(app.getHttpServer()).post('/api/attendance/scan').set('Cookie', xsrf.cookie).set('X-XSRF-TOKEN', 'x').send({ token: 'x' });
    expect(mismatch.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('kiosks: pairing, credential, networks, revocation', () => {
  let kioskId = '';
  let firstCookie = '';

  it('create → 201 with a one-time code shown once; only its SHA-256 is stored', async () => {
    const res = await call('admin', 'post', '/api/attendance/kiosks', { body: { siteId: '0190a5d0-0000-7000-8000-000000000205', labels: { fr: 'Annaba — Porte 2', ar: 'عنابة — الباب 2' } } }).expect(201);
    assertNoSecrets(res.body);
    kioskId = res.body.kiosk.id;
    expect(res.body.kiosk).toMatchObject({ status: 'pending', kind: 'qr_kiosk', site: { code: 'ANNABA' }, allowedNetworks: [], pairedAt: null, _actions: ['update', 'pair', 'revoke'] });
    expect(res.body.kiosk.pairing.expiresAt).toBe(res.body.pairing.expiresAt);
    expect(res.body.pairing.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    const [row] = await query<{ hash: Buffer }>(db.superuserUrl, 'select pairing_code_hash as hash from attendance_device where id = $1', [kioskId]);
    expect(row?.hash.equals(attendanceSha256(res.body.pairing.code.replace('-', '')))).toBe(true);
    const list = await call('admin', 'get', '/api/attendance/kiosks').expect(200);
    expect(JSON.stringify(list.body)).not.toContain(res.body.pairing.code);
    // pairing: lower case, no hyphen accepted; the device cookie is httpOnly on /api/kiosk for 400 days
    const pair = await call(null, 'post', '/api/kiosk/pair', { body: { code: res.body.pairing.code.toLowerCase().replace('-', '') } }).expect(200);
    expect(pair.body).toMatchObject({ kiosk: { id: kioskId, site: { code: 'ANNABA' } }, windowSeconds: 30 });
    const line = cookieLine(pair, 'hrf_kiosk') ?? '';
    expect(line).toMatch(/Max-Age=34560000; Path=\/api\/kiosk; HttpOnly; SameSite=Strict$/);
    firstCookie = line.split(';')[0] ?? '';
    const events = await query<{ actor: string | null; data: Record<string, unknown> }>(db.superuserUrl, `select actor_user_id as actor, data from audit.event where type = 'attendance.device_paired' and subject_id = $1`, [kioskId]);
    expect(events).toEqual([{ actor: null, data: expect.objectContaining({ deviceId: kioskId, replacedCredential: false }) }]);
    // one-time
    expect((await call(null, 'post', '/api/kiosk/pair', { body: { code: res.body.pairing.code } }).expect(410)).body.type).toBe(PROBLEM('kiosk-pairing-invalid'));
    expect((await call(null, 'post', '/api/kiosk/pair', { body: { code: 'bad' } }).expect(422)).body.errors[0]).toMatchObject({ field: 'code', code: 'invalid' });
  });

  it('session and QR windows; the code of each window verifies; no-store', async () => {
    const session = await call(null, 'get', '/api/kiosk/session', { cookie: firstCookie }).expect(200);
    expect(session.headers['cache-control']).toBe('no-store');
    expect(cookieLine(session, 'hrf_kiosk')).toMatch(/Max-Age=34560000/);
    expect(session.body.company).toEqual({ name: 'Groupe Démo' });
    const qr = await call(null, 'get', '/api/kiosk/qr', { cookie: firstCookie }).expect(200);
    assertNoSecrets(qr.body);
    expect(qr.body.windows).toHaveLength(4);
    const w = qr.body.windows as { window: number; qr: string; showFrom: string; showUntil: string }[];
    expect(w.map((x) => x.window - (w[0]?.window ?? 0))).toEqual([0, 1, 2, 3]);
    expect(w[0]?.qr).toMatch(/^http:\/\/web\.test\/punch#[A-Za-z0-9_-]{71}$/);
    expect(Date.parse(w[0]?.showUntil ?? '') - Date.parse(w[0]?.showFrom ?? '')).toBe(30_000);
    await call(null, 'post', '/api/attendance/scan', { body: { token: w[0]?.qr.split('#')[1] } }).expect(200);
    const list = await call('admin', 'get', '/api/attendance/kiosks').expect(200);
    expect((list.body.items as { id: string; lastSeen: unknown }[]).find((k) => k.id === kioskId)?.lastSeen).toMatchObject({ ip: expect.any(String) });
  });

  it('the kiosk credential reads no personal data', async () => {
    for (const url of ['/api/employees', '/api/attendance/presence', '/api/me', '/api/me/attendance/days']) {
      await call(null, 'get', url, { cookie: firstCookie }).expect(401);
    }
    await call(null, 'get', '/api/kiosk/session').expect(401);
  });

  it('re-pairing kills the old credential; an expired code → 410', async () => {
    const code = (await call('admin', 'post', `/api/attendance/kiosks/${kioskId}/pairing-code`).expect(200)).body.code as string;
    await call(null, 'get', '/api/kiosk/session', { cookie: firstCookie }).expect(200); // until the new code is used
    const pair = await call(null, 'post', '/api/kiosk/pair', { body: { code } }).expect(200);
    const second = cookieLine(pair, 'hrf_kiosk')?.split(';')[0] ?? '';
    const old = await call(null, 'get', '/api/kiosk/session', { cookie: firstCookie }).expect(401);
    expect(old.body.type).toBe(PROBLEM('kiosk-unpaired'));
    expect(cookieLine(old, 'hrf_kiosk')).toMatch(/^hrf_kiosk=; Max-Age=0/);
    await call(null, 'get', '/api/kiosk/session', { cookie: second }).expect(200);
    const replaced = await query<{ data: Record<string, unknown> }>(db.superuserUrl, `select data from audit.event where type = 'attendance.device_paired' and subject_id = $1 order by id`, [kioskId]);
    expect(replaced.at(-1)?.data['replacedCredential']).toBe(true);
    const expired = (await call('admin', 'post', `/api/attendance/kiosks/${kioskId}/pairing-code`).expect(200)).body.code as string;
    await query(db.superuserUrl, `update attendance_device set pairing_expires_at = now() - interval '1 second' where id = $1`, [kioskId]);
    await call(null, 'post', '/api/kiosk/pair', { body: { code: expired } }).expect(410);
    firstCookie = second;
  });

  it('allowed networks restrict the credential (client address through the trusted proxy); a bad block → 422', async () => {
    const bad = await call('admin', 'patch', `/api/attendance/kiosks/${kioskId}`, { body: { allowedNetworks: ['41.100.1.5/24'] } }).expect(422);
    expect(bad.body.errors[0]).toMatchObject({ field: 'allowedNetworks.0', code: 'invalid' });
    const ok = await call('admin', 'patch', `/api/attendance/kiosks/${kioskId}`, { body: { allowedNetworks: ['41.100.1.0/24'] } }).expect(200);
    expect(ok.body.allowedNetworks).toEqual(['41.100.1.0/24']);
    const refused = await call(null, 'get', '/api/kiosk/qr', { cookie: firstCookie, headers: { 'X-Forwarded-For': '41.100.2.9' } }).expect(403);
    expect(refused.body.type).toBe(PROBLEM('kiosk-network-refused'));
    await call(null, 'get', '/api/kiosk/qr', { cookie: firstCookie, headers: { 'X-Forwarded-For': '41.100.1.9' } }).expect(200);
  });

  it('revocation is final: the credential answers 401, further changes 409', async () => {
    await call('est', 'post', `/api/attendance/kiosks/${kioskId}/revoke`, { body: { reason: 'Tablette volée' } }).expect(403);
    const res = await call('admin', 'post', `/api/attendance/kiosks/${kioskId}/revoke`, { body: { reason: 'Tablette volée' } }).expect(200);
    expect(res.body).toMatchObject({ status: 'revoked', revoked: { reason: 'Tablette volée', by: { id: USERS.admin.id } }, _actions: [], pairing: null });
    await call(null, 'get', '/api/kiosk/session', { cookie: firstCookie, headers: { 'X-Forwarded-For': '41.100.1.9' } }).expect(401);
    for (const [method, url, body] of [
      ['post', `/api/attendance/kiosks/${kioskId}/revoke`, { reason: 'encore' }],
      ['post', `/api/attendance/kiosks/${kioskId}/pairing-code`, undefined],
      ['patch', `/api/attendance/kiosks/${kioskId}`, { labels: { fr: 'x', ar: 'س' } }],
    ] as const) {
      expect((await call('admin', method, url, body ? { body } : {}).expect(409)).body.type).toBe(PROBLEM('kiosk-revoked'));
    }
    await expect(query(db.migratorUrl, `update attendance_device set name_fr = 'x' where id = $1`, [kioskId])).rejects.toThrow(/final/);
  });

  it('kiosk timeline: attendance.configure anywhere; hashes masked; others 404', async () => {
    const res = await call('admin', 'get', `/api/audit/timeline?subject=attendance_device:${kioskId}`).expect(200);
    const items = res.body.items as { kind: string; event?: { type: string }; changes?: { field: string; after: unknown }[] }[];
    expect(items.some((i) => i.event?.type === 'attendance.device_paired')).toBe(true);
    const hashes = items.flatMap((i) => i.changes ?? []).filter((c) => c.field === 'credential_hash' && c.after !== null);
    expect(hashes.length).toBeGreaterThan(0);
    expect(hashes.every((c) => c.after === '***')).toBe(true);
    await call('est', 'get', `/api/audit/timeline?subject=attendance_device:${kioskId}`).expect(404);
    await call('beta', 'get', `/api/audit/timeline?subject=attendance_device:${kioskId}`).expect(404);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('manual punches and voids', () => {
  let manual = '';

  beforeAll(() => {
    clock.pinned = T_TODAY;
  });
  afterAll(() => {
    clock.pinned = null;
  });

  it('a manual punch with a reason → 201; audited as an event without the payload', async () => {
    const requestId = `att-manual-${++seq}`;
    const res = await call('admin', 'post', `/api/employees/${employeeA(27)}/attendance/punches`, {
      body: { direction: 'in', date: '2026-09-20', time: '07:35', reason: 'Réseau coupé' },
      headers: { 'X-Request-Id': requestId },
    }).expect(201);
    manual = res.body.id;
    expect(res.body).toMatchObject({ source: 'manual', direction: 'in', localTime: '07:35', workDate: '2026-09-20', reason: 'Réseau coupé', site: { code: 'CNE' }, createdBy: { id: USERS.admin.id }, _actions: ['void'], status: 'live' });
    const events = await query<{ type: string; actor: string; data: Record<string, unknown>; subject_type: string }>(
      db.superuserUrl,
      'select type, actor_user_id as actor, data, subject_type from audit.event where request_id = $1',
      [requestId],
    );
    expect(events).toEqual([{ type: 'attendance.punch_recorded', actor: USERS.admin.id, data: { source: 'manual', direction: 'in' }, subject_type: 'attendance_punch' }]);
    expect(await query(db.superuserUrl, `select 1 from audit.change_log where table_name = 'attendance_punch'`)).toEqual([]);
  });

  it('validation and conflicts: reason, future, too old, site, not employed, same minute, own employment', async () => {
    const url = `/api/employees/${employeeA(27)}/attendance/punches`;
    const body = { direction: 'out', date: '2026-09-20', time: '16:00', reason: 'Réseau coupé' };
    expect((await call('admin', 'post', url, { body: { ...body, reason: 'x' } }).expect(422)).body.errors[0].field).toBe('reason');
    expect((await call('admin', 'post', url, { body: { ...body, date: '2026-09-27', time: '10:00' } }).expect(422)).body.errors).toEqual([expect.objectContaining({ field: 'time', code: 'future' })]);
    expect((await call('admin', 'post', url, { body: { ...body, date: '2019-01-06' } }).expect(422)).body.errors).toEqual([expect.objectContaining({ field: 'date', code: 'too_old' })]);
    expect((await call('admin', 'post', url, { body: { ...body, siteId: '0190a5d0-0000-7000-8000-00000000dead' } }).expect(422)).body.errors).toEqual([expect.objectContaining({ field: 'siteId', code: 'not_found' })]);
    expect((await call('admin', 'post', `/api/employees/${employeeA(25)}/attendance/punches`, { body }).expect(409)).body.type).toBe(PROBLEM('attendance-not-employed'));
    expect((await call('admin', 'post', url, { body: { ...body, direction: 'out', time: '07:35' } }).expect(409)).body.type).toBe(PROBLEM('attendance-punch-exists'));
    expect((await call('est', 'post', `/api/employees/${employeeA(22)}/attendance/punches`, { body }).expect(409)).body.type).toBe(PROBLEM('attendance-self-manage'));
    await call('est', 'post', `/api/employees/${employeeA(36)}/attendance/punches`, { body }).expect(404);
    await call('ouest', 'post', `/api/employees/${employeeA(36)}/attendance/punches`, { body }).expect(403);
  });

  it('void with a reason; a second void → 409; never one’s own; immutability in the database', async () => {
    await call('admin', 'post', `/api/attendance/punches/${manual}/void`, { body: { reason: 'x' } }).expect(422);
    const res = await call('est', 'post', `/api/attendance/punches/${manual}/void`, { body: { reason: 'Erreur de saisie' } }).expect(200);
    expect(res.body).toMatchObject({ status: 'void', void: { reason: 'Erreur de saisie', by: { id: USERS.est.id } }, _actions: [] });
    expect((await call('admin', 'post', `/api/attendance/punches/${manual}/void`, { body: { reason: 'Encore' } }).expect(409)).body.type).toBe(PROBLEM('attendance-punch-void'));
    const own = (await call('admin', 'post', `/api/employees/${employeeA(22)}/attendance/punches`, { body: { direction: 'in', date: '2026-09-20', time: '07:31', reason: 'Oubli' } }).expect(201)).body.id;
    expect((await call('est', 'post', `/api/attendance/punches/${own}/void`, { body: { reason: 'Mien' } }).expect(409)).body.type).toBe(PROBLEM('attendance-self-manage'));
    await call('ouest', 'post', `/api/attendance/punches/${own}/void`, { body: { reason: 'Hors' } }).expect(403);
    await call('beta', 'post', `/api/attendance/punches/${own}/void`, { body: { reason: 'Hors' } }).expect(404);
    const voided = await query<{ type: string }>(db.superuserUrl, `select type from audit.event where subject_id = $1 order by id`, [manual]);
    expect(voided.map((e) => e.type)).toEqual(['attendance.punch_recorded', 'attendance.punch_voided']);
    // the database guards
    const asApp = async (statements: string[]) => {
      const { Client } = await import('pg');
      const c = new Client({ connectionString: db.appUrl });
      await c.connect();
      try {
        for (const s of statements) await c.query(s);
      } finally {
        await c.end();
      }
    };
    await expect(asApp(inTenant(`update attendance_punch set occurred_at = occurred_at + interval '1 hour' where id = '${own}'`))).rejects.toThrow(/immutable/);
    await expect(asApp(inTenant(`update attendance_punch set void_reason = 'autre', voided_at = now() where id = '${manual}'`))).rejects.toThrow(/immutable/);
    await expect(asApp(inTenant(`delete from attendance_punch where id = '${own}'`))).rejects.toThrow(/permission denied/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('schedules and their resolution', () => {
  it('schedules: standard (40 h) and agence; assignments; the Ramadan override', async () => {
    const res = await call('ouest', 'get', '/api/attendance/schedules').expect(200);
    const items = res.body.items as { code: string; current: { weeklyMinutes: number } | null; assignmentCount: number }[];
    expect(items.map((s) => s.code)).toEqual(['agence', 'standard']);
    expect(items.find((s) => s.code === 'standard')?.current?.weeklyMinutes).toBe(2400);
    expect(items.find((s) => s.code === 'agence')?.assignmentCount).toBe(2);
    const overrides = await call('est', 'get', '/api/attendance/schedule-overrides?year=2027').expect(200);
    expect(overrides.body.items).toEqual([expect.objectContaining({ id: DEMO_SCHEDULES.ramadan, schedule: null, from: '2027-02-08', to: '2027-03-09', approximate: true })]);
    const assignments = await call('admin', 'get', '/api/attendance/schedule-assignments?at=2026-09-27').expect(200);
    expect((assignments.body.items as { target: { kind: string; code: string | null } }[]).map((a) => `${a.target.kind}:${a.target.code ?? ''}`).toSorted()).toEqual(['company:', 'site:CNE', 'unit:AG-ANNABA']);
  });

  it('resolution precedence: employment > unit > ancestor unit > site > company; overrides listed', async () => {
    const seg = async (n: number, from: string, to: string) =>
      (await call('admin', 'get', `/api/employees/${employeeA(n)}/attendance/schedule?from=${from}&to=${to}`).expect(200)).body.items as {
        from: string;
        to: string;
        schedule: { code: string };
        source: string;
        sourceRef: { code: string } | null;
        overrides: { id: string }[];
      }[];
    expect((await seg(30, '2026-09-01', '2026-09-30')).map((s) => [s.schedule.code, s.source, s.sourceRef?.code])).toEqual([['agence', 'unit', 'AG-ANNABA']]);
    expect((await seg(26, '2026-09-01', '2026-09-30')).map((s) => [s.schedule.code, s.source, s.sourceRef?.code])).toEqual([['agence', 'site', 'CNE']]);
    expect((await seg(36, '2026-09-01', '2026-09-30')).map((s) => [s.schedule.code, s.source, s.sourceRef])).toEqual([['standard', 'company', null]]);
    const feb = await seg(36, '2027-02-01', '2027-02-28');
    expect(feb.map((s) => [s.from, s.to, s.overrides.map((o) => o.id)])).toEqual([
      ['2027-02-01', '2027-02-07', []],
      ['2027-02-08', '2027-02-28', [DEMO_SCHEDULES.ramadan]],
    ]);

    const week = [1, 2, 3, 4, 5, 6, 7].map((day) => (day === 5 || day === 6 ? { day, rest: true } : { day, start: '09:00', end: '17:00', breakStart: null, breakEnd: null }));
    const created = await call('admin', 'post', '/api/attendance/schedules', { body: { code: 'region_est', labels: { fr: 'Région Est', ar: 'منطقة الشرق', en: 'East' }, week, toleranceMinutes: 5, validFrom: '2026-01-01' } }).expect(201);
    const scheduleId = created.body.id as string;
    await call('admin', 'post', '/api/attendance/schedule-assignments', { body: { scheduleId, target: { kind: 'unit', id: unitA('REG-EST') }, validFrom: '2026-11-01' } }).expect(201);
    await call('admin', 'post', '/api/attendance/schedule-assignments', { body: { scheduleId: created.body.id, target: { kind: 'employment', id: employeeA(26) }, validFrom: '2026-12-01' } }).expect(201);
    expect((await seg(26, '2026-10-30', '2026-12-02')).map((s) => [s.from, s.schedule.code, s.source, s.sourceRef?.code])).toEqual([
      ['2026-10-30', 'agence', 'site', 'CNE'],
      ['2026-11-01', 'region_est', 'unit', 'REG-EST'],
      ['2026-12-01', 'region_est', 'employment', 'EMP-0026'],
    ]);
    // the nearest unit wins over an ancestor
    expect((await seg(30, '2026-11-01', '2026-11-02')).map((s) => [s.schedule.code, s.sourceRef?.code])).toEqual([['agence', 'AG-ANNABA']]);
  });

  it('configuration rules and errors', async () => {
    const week = [1, 2, 3, 4, 5, 6, 7].map((day) => ({ day, start: '17:00', end: '08:00', breakStart: null, breakEnd: null }));
    const bad = await call('admin', 'post', '/api/attendance/schedules', { body: { code: 'bad_one', labels: { fr: 'x', ar: 'س', en: 'x' }, week, toleranceMinutes: 5 } }).expect(422);
    expect(bad.body.errors[0]).toMatchObject({ field: 'week.0.end', code: 'invalid_time' });
    const std = (await call('admin', 'get', '/api/attendance/schedules').expect(200)).body.items.find((s: { code: string }) => s.code === 'standard');
    const okWeek = std.current.week;
    expect((await call('admin', 'post', '/api/attendance/schedules', { body: { code: 'standard', labels: { fr: 'x', ar: 'س', en: 'x' }, week: okWeek, toleranceMinutes: 5 } }).expect(409)).body.type).toBe(PROBLEM('attendance-schedule-code-taken'));
    expect((await call('admin', 'post', `/api/attendance/schedules/${std.id}/versions`, { body: { validFrom: '1999-01-01', week: okWeek, toleranceMinutes: 5 } }).expect(409)).body.type).toBe(PROBLEM('attendance-version-date'));
    const v = await call('admin', 'post', `/api/attendance/schedules/${std.id}/versions`, { body: { validFrom: '2030-01-01', week: okWeek, toleranceMinutes: 15 } }).expect(201);
    expect(v.body.versions.map((x: { validFrom: string; validTo: string | null }) => [x.validFrom, x.validTo])).toEqual([['2030-01-01', null], ['2000-01-01', '2030-01-01']]);
    const ov = { scheduleId: null, labels: { fr: 'Été', ar: 'صيف', en: 'Summer' }, from: '2027-02-20', to: '2027-02-25', week: okWeek, toleranceMinutes: 5, approximate: false };
    expect((await call('admin', 'post', '/api/attendance/schedule-overrides', { body: ov }).expect(409)).body.type).toBe(PROBLEM('attendance-override-overlap'));
    expect((await call('admin', 'post', '/api/attendance/schedule-overrides', { body: { ...ov, from: '2028-01-01', to: '2028-03-15' } }).expect(422)).body.errors[0]).toMatchObject({ field: 'to', code: 'range_too_long' });
    const created = await call('admin', 'post', '/api/attendance/schedule-overrides', { body: { ...ov, scheduleId: std.id } }).expect(201);
    await call('admin', 'put', `/api/attendance/schedule-overrides/${created.body.id}`, { body: { ...ov, scheduleId: std.id, to: '2027-02-26' } }).expect(200);
    await call('admin', 'delete', `/api/attendance/schedule-overrides/${created.body.id}`).expect(204);
    const root = await call('admin', 'post', '/api/attendance/schedule-assignments', { body: { scheduleId: std.id, target: { kind: 'unit', id: unitA('DG') }, validFrom: '2027-01-01' } }).expect(422);
    expect(root.body.errors[0]).toMatchObject({ field: 'target.id', code: 'root_unit' });
    const inUse = await call('admin', 'patch', `/api/attendance/schedules/${DEMO_SCHEDULES.agence}`, { body: { active: false } }).expect(409);
    expect(inUse.body.type).toBe(PROBLEM('attendance-schedule-in-use'));
    const assignments = (await call('admin', 'get', '/api/attendance/schedule-assignments?at=all').expect(200)).body.items as { id: string; target: { kind: string }; _actions: string[] }[];
    const company = assignments.find((a) => a.target.kind === 'company');
    expect(company?.['_actions']).toEqual([]);
    expect((await call('admin', 'post', `/api/attendance/schedule-assignments/${company?.id}/end`, { body: { validTo: '2030-01-01' } }).expect(409)).body.type).toBe(PROBLEM('attendance-assignment-company'));
    expect((await call('admin', 'delete', `/api/attendance/schedule-assignments/${company?.id}`).expect(409)).body.type).toBe(PROBLEM('attendance-assignment-started'));
    // a new future company default closes the current one; deleting it re-opens the current one
    const next = await call('admin', 'post', '/api/attendance/schedule-assignments', { body: { scheduleId: DEMO_SCHEDULES.agence, target: { kind: 'company', id: null }, validFrom: '2031-01-01' } }).expect(201);
    expect(next.body['_actions']).toEqual(['delete']);
    expect((await call('admin', 'get', '/api/attendance/schedule-assignments?targetKind=company&at=all').expect(200)).body.items.map((a: { validTo: string | null }) => a.validTo)).toEqual(['2030-12-31', null]);
    await call('admin', 'delete', `/api/attendance/schedule-assignments/${next.body.id}`).expect(204);
    expect((await call('admin', 'get', '/api/attendance/schedule-assignments?targetKind=company&at=all').expect(200)).body.items.map((a: { validTo: string | null }) => a.validTo)).toEqual([null]);
    // policy
    await call('est', 'put', '/api/attendance/policy', { body: { retentionMonths: 24 } }).expect(403);
    await call('admin', 'put', '/api/attendance/policy', { body: { retentionMonths: 9 } }).expect(422);
    expect((await call('admin', 'put', '/api/attendance/policy', { body: { minPunchGapSeconds: 90 } }).expect(200)).body).toEqual({ retentionMonths: 60, minPunchGapSeconds: 90 });
    await call('admin', 'put', '/api/attendance/policy', { body: { minPunchGapSeconds: 120 } }).expect(200);
  });
});

// ---------------------------------------------------------------------------------------------------------------
/** Statements run as hrforce_app in company A. */
const inTenant = (sqlText: string) => [`select set_config('app.company_id', '${COMPANY_A}', false)`, sqlText];

const dayOf = async (n: number, date: string, actor: ActorName = 'admin') => {
    const res = await call(actor, 'get', `/api/employees/${employeeA(n)}/attendance/days?from=${date}&to=${date}`).expect(200);
    assertNoSecrets(res.body);
    return res.body.items[0] as { status: string; flags: string[]; lateMinutes: number; workedMinutes: number; leave: { part: string } | null; holiday: unknown; schedule: { expectedStart: string | null } | null; punches: unknown[] };
};
const manualPunch = (n: number, direction: 'in' | 'out', date: string, time: string) =>
  call('admin', 'post', `/api/employees/${employeeA(n)}/attendance/punches`, { body: { direction, date, time, reason: 'Saisie test' } }).expect(201);

describe('daily status (computed on read)', () => {
  const day = dayOf;
  const manual = manualPunch;

  beforeAll(async () => {
    clock.pinned = T_TODAY;
    await manual(33, 'in', '2026-09-20', '07:45');
    await manual(33, 'out', '2026-09-20', '16:05');
    await manual(31, 'in', '2026-09-20', '07:20');
    await manual(31, 'in', '2026-09-22', '07:25');
    await manual(31, 'out', '2026-09-22', '16:00');
  });
  afterAll(() => {
    clock.pinned = null;
  });

  it('present, late, absent, incomplete, expected, rest day, holiday, not employed', async () => {
    expect(await day(33, '2026-09-20')).toMatchObject({ status: 'late', lateMinutes: 15, workedMinutes: 470, flags: ['manual_punch'] });
    expect((await day(31, '2026-09-22')).status).toBe('present');
    expect((await day(32, '2026-09-20')).status).toBe('absent');
    expect((await day(31, '2026-09-20')).status).toBe('incomplete');
    expect((await day(36, '2026-09-27')).status).toBe('expected'); // standard 08:00 + 10, now 07:55
    expect((await day(26, '2026-09-27')).status).toBe('absent'); // agence 07:30 + 10 passed
    expect((await day(33, '2026-09-25')).status).toBe('rest_day');
    expect(await day(33, '2026-08-25')).toMatchObject({ status: 'holiday', holiday: expect.objectContaining({ approximate: true }) });
    expect(await day(25, '2026-09-20')).toMatchObject({ status: 'not_employed', schedule: null });
  });

  it('leave: approved → on_leave; pending → leave_pending; a late approval recomputes the past day; half day', async () => {
    await leave(34, '2026-09-21', 'approved');
    expect(await day(34, '2026-09-21')).toMatchObject({ status: 'on_leave', leave: { part: 'full' } });
    const pending = await leave(35, '2026-09-22', 'pending');
    expect(await day(35, '2026-09-22')).toMatchObject({ status: 'absent', flags: ['leave_pending'] });
    await query(db.superuserUrl, `update leave_request set status = 'approved' where id = $1`, [pending]);
    expect((await day(35, '2026-09-22')).status).toBe('on_leave');
    await leave(37, '2026-09-23', 'approved', true);
    expect(await day(37, '2026-09-23')).toMatchObject({ status: 'absent', flags: ['half_day_leave_morning'], leave: { part: 'morning' }, schedule: { expectedStart: '12:30' } });
  });

  it('other_site and shared_device (shown only with attendance.manage over the employee)', async () => {
    await qrPunchSql(27, ANNABA, '2026-09-16T06:30:00Z', 'aa'.repeat(16));
    await qrPunchSql(28, CNE, '2026-09-16T06:31:00Z', 'aa'.repeat(16));
    expect((await day(27, '2026-09-16')).flags).toEqual(['other_site', 'shared_device']);
    expect((await day(28, '2026-09-16', 'est')).flags).toEqual(['shared_device']);
    await qrPunchSql(30, ANNABA, '2026-09-17T06:30:00Z', 'bb'.repeat(16));
    await qrPunchSql(31, ANNABA, '2026-09-17T06:31:00Z', 'bb'.repeat(16));
    const team = await call('chef', 'get', '/api/me/team/presence?date=2026-09-17').expect(200);
    const agent = (team.body.items as { employee: { id: string }; flags: string[] }[]).find((i) => i.employee.id === employeeA(30));
    expect(agent?.flags).toEqual([]);
    const board = await call('admin', 'get', `/api/attendance/presence?date=2026-09-17&unitId=${unitA('AG-ANNABA')}`).expect(200);
    expect((board.body.items as { employee: { id: string }; flags: string[] }[]).find((i) => i.employee.id === employeeA(30))?.flags).toEqual(['shared_device']);
  });

  it('ranges, totals, punches with actions, validation', async () => {
    const res = await call('admin', 'get', `/api/employees/${employeeA(33)}/attendance/days?from=2026-09-20&to=2026-09-26`).expect(200);
    expect(res.body.items).toHaveLength(7);
    expect(res.body).toMatchObject({ canManage: true, retentionMonths: 60, employee: { matricule: 'EMP-0033', unit: { code: 'SRV-CLI-ANB' }, site: { code: 'ANNABA' } } });
    expect(res.body.totals).toMatchObject({ lateDays: 1, lateMinutes: 15, workedMinutes: 470 });
    expect(res.body.items[0].punches.map((p: { _actions: string[] }) => p['_actions'])).toEqual([['void'], ['void']]);
    const lecture = await call('ouest', 'get', `/api/employees/${employeeA(36)}/attendance/days`).expect(200);
    expect(lecture.body.canManage).toBe(false);
    expect((await call('admin', 'get', `/api/employees/${employeeA(33)}/attendance/days?to=2026-09-28`).expect(422)).body.errors[0]).toMatchObject({ field: 'to', code: 'future' });
    expect((await call('admin', 'get', `/api/employees/${employeeA(33)}/attendance/days?from=2026-06-01&to=2026-09-01`).expect(422)).body.errors[0]).toMatchObject({ code: 'range_too_long' });
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('scope: HR board, lecture, unit heads, employees', () => {
  beforeAll(() => {
    clock.pinned = T_TODAY;
  });
  afterAll(() => {
    clock.pinned = null;
  });

  const estUnits = ['REG-EST', 'SRV-ADM-EST', 'AG-CNE', 'AG-ANNABA', 'SRV-CLI-ANB'];
  const ouestUnits = ['REG-OUEST', 'AG-ORAN', 'AG-TLEMCEN'];

  it('the board: admin everything, rh_regional its region, lecture its region; counts before the status filter', async () => {
    const admin = await call('admin', 'get', '/api/attendance/presence?date=2026-09-20&pageSize=100').expect(200);
    assertNoSecrets(admin.body);
    expect(admin.body.total).toBe(38); // 40 minus the two ended employments
    const est = await call('est', 'get', '/api/attendance/presence?date=2026-09-20&pageSize=100').expect(200);
    expect(est.body.total).toBe(11);
    expect((est.body.items as { employee: { unit: { code: string } } }[]).every((i) => estUnits.includes(i.employee.unit.code))).toBe(true);
    const ouest = await call('ouest', 'get', '/api/attendance/presence?date=2026-09-20&pageSize=100').expect(200);
    expect((ouest.body.items as { employee: { unit: { code: string } } }[]).every((i) => ouestUnits.includes(i.employee.unit.code))).toBe(true);
    expect(ouest.body.total).toBe(6);
    const late = await call('est', 'get', '/api/attendance/presence?date=2026-09-20&status=late').expect(200);
    expect(late.body.counts.total).toBe(11);
    expect(late.body.total).toBe(late.body.counts.late);
    const sub = await call('admin', 'get', `/api/attendance/presence?date=2026-09-20&unitId=${unitA('AG-ANNABA')}&includeSubUnits=false`).expect(200);
    expect(sub.body.total).toBe(3);
    await call('admin', 'get', '/api/attendance/presence?date=2026-09-28').expect(422);
    await call('acces', 'get', '/api/attendance/presence').expect(403);
    await call('agent', 'get', '/api/attendance/presence').expect(403);
  });

  it('team view: heads see their units and sub-units without a grant; others see nothing', async () => {
    const chef = await call('chef', 'get', '/api/me/team/presence?date=2026-09-20').expect(200);
    expect(chef.body.units.map((u: { code: string }) => u.code)).toEqual(['AG-ANNABA']);
    expect(chef.body.total).toBe(5);
    expect((chef.body.items as { employee: { unit: { code: string } } }[]).every((i) => ['AG-ANNABA', 'SRV-CLI-ANB'].includes(i.employee.unit.code))).toBe(true);
    const karim = await call('est', 'get', '/api/me/team/presence?date=2026-09-20').expect(200);
    expect(karim.body.units.map((u: { code: string }) => u.code)).toEqual(['REG-EST']);
    expect(karim.body.total).toBe(11);
    const agent = await call('agent', 'get', '/api/me/team/presence').expect(200);
    expect(agent.body).toMatchObject({ units: [], items: [], total: 0 });
    await call('chef', 'get', '/api/me/team/presence?date=2026-08-01').expect(422);
  });

  it('employees see their own days only; /me/employment lists the headed units', async () => {
    const mine = await call('agent', 'get', '/api/me/attendance/days?from=2026-09-20&to=2026-09-27').expect(200);
    expect(mine.body.employee.id).toBe(employeeA(30));
    expect(mine.body.items).toHaveLength(8);
    expect((mine.body.items as { punches: { _actions: string[] }[] }[]).flatMap((d) => d.punches).every((p) => p['_actions'].length === 0)).toBe(true);
    await call('admin', 'get', '/api/me/attendance/days').expect(409);
    await call('ouest', 'get', '/api/me/attendance/days').expect(403);
    expect((await call('chef', 'get', '/api/me/employment').expect(200)).body.headOf.map((u: { code: string }) => u.code)).toEqual(['AG-ANNABA']);
    expect((await call('agent', 'get', '/api/me/employment').expect(200)).body.headOf).toEqual([]);
    // per-employee routes: out of scope → 404
    await call('est', 'get', `/api/employees/${employeeA(36)}/attendance/days`).expect(404);
    await call('beta', 'get', `/api/employees/${employeeA(27)}/attendance/schedule`).expect(404);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('retention and the punch audit', () => {
  let worker: Database;
  let deps: WorkerDeps;
  let jobSeq = 0;

  beforeAll(() => {
    worker = createDatabase({ connectionString: db.workerUrl, maxConnections: 2 });
    deps = { db: worker, logger: pino({ level: 'silent' }), mail: { send: () => Promise.resolve() }, webBaseUrl: 'http://web.test' };
  });
  afterAll(async () => {
    await worker?.destroy();
  });

  it('the purge erases old punches fully: no row copy, no per-row delete event, one attendance.purged event', async () => {
    const old = [await qrPunchSql(27, CNE, '2020-01-15T07:00:00Z', 'cc'.repeat(16)), await qrPunchSql(27, CNE, '2020-01-15T15:30:00Z', null)];
    const kept = await qrPunchSql(27, CNE, '2021-09-01T07:00:00Z', null);
    const result = await attendanceRetentionTask(deps, { today: '2026-09-27' }, { id: String(++jobSeq), attempt: 1 });
    expect(result).toMatchObject({ today: '2026-09-27', punches: 2 });
    expect(await query(db.superuserUrl, 'select id from attendance_punch where id = any($1)', [old])).toEqual([]);
    expect(await query(db.superuserUrl, 'select id from attendance_punch where id = $1', [kept])).toHaveLength(1);
    expect(await query(db.superuserUrl, `select 1 from audit.change_log where table_name = 'attendance_punch'`)).toEqual([]);
    expect(await query(db.superuserUrl, `select 1 from audit.event where type = 'attendance.punch_deleted'`)).toEqual([]);
    const purged = await query<{ data: Record<string, unknown>; actor: string | null; company_id: string }>(db.superuserUrl, `select data, actor_user_id as actor, company_id from audit.event where type = 'attendance.purged'`);
    expect(purged).toEqual([{ data: { punches: 2, before: '2021-09-01' }, actor: null, company_id: COMPANY_A }]);
    // what the audit log still holds about the erased punches: their ids and source only (nothing personal)
    const left = await query<{ actor: string | null; data: Record<string, unknown>; subject_id: string }>(db.superuserUrl, `select actor_user_id as actor, data, subject_id from audit.event where subject_id = any($1)`, [old]);
    expect(left).toHaveLength(2);
    for (const e of left) {
      expect(e).toMatchObject({ actor: null, data: { source: 'qr', direction: 'in' } });
      expect(Object.keys(e.data).toSorted()).toEqual(['direction', 'source']);
    }
    expect(JSON.stringify(left)).not.toContain(employeeA(27));
    expect(JSON.stringify(left)).not.toContain('2020-01-15');
    // idempotent
    expect(await attendanceRetentionTask(deps, { today: '2026-09-27' }, { id: String(++jobSeq), attempt: 1 })).toMatchObject({ punches: 0 });
    expect(await query(db.superuserUrl, `select 1 from audit.event where type = 'attendance.purged'`)).toHaveLength(1);
  });

  it('a QR punch through the API: one event, actor null, request id, no payload; a manual delete by an operator is recorded', async () => {
    clock.pinned = Date.parse('2026-09-24T06:40:00Z');
    const requestId = `att-qr-${++seq}`;
    const res = await punchAs('agent', scanReceipt(CNE, Date.parse('2026-09-24T06:39:50Z'))).set('X-Request-Id', requestId).expect(201);
    clock.pinned = null;
    expect(await query(db.superuserUrl, 'select type, actor_user_id as actor, data from audit.event where request_id = $1', [requestId])).toEqual([
      { type: 'attendance.punch_recorded', actor: null, data: { source: 'qr', direction: 'in' } },
    ]);
    await query(db.migratorUrl, `delete from attendance_punch where id = $1`, [res.body.punch.id]);
    expect(await query(db.superuserUrl, `select type from audit.event where subject_id = $1 order by id`, [res.body.punch.id])).toEqual([{ type: 'attendance.punch_recorded' }, { type: 'attendance.punch_deleted' }]);
    // the employee timeline lists manual punches and voids, not QR arrivals
    const timeline = await call('admin', 'get', `/api/audit/timeline?subject=employee:${employeeA(27)}&limit=100`).expect(200);
    const types = (timeline.body.items as { event?: { type: string; data: Record<string, unknown> } }[]).flatMap((i) => (i.event ? [i.event] : []));
    expect(types.some((e) => e.type === 'attendance.punch_recorded' && e.data['source'] === 'manual')).toBe(true);
    expect(types.some((e) => e.type === 'attendance.punch_voided')).toBe(true);
    expect(types.some((e) => e.type === 'attendance.punch_recorded' && e.data['source'] === 'qr')).toBe(false);
  });

  it('privileges: the app cannot delete punches; the worker can only through its job role', async () => {
    const [trigger] = await query<{ fn: string }>(db.superuserUrl, `select p.proname as fn from pg_trigger t join pg_proc p on p.oid = t.tgfoid where t.tgrelid = 'public.attendance_punch'::regclass and t.tgname = 'audit_capture_tg'`);
    expect(trigger?.fn).toBe('capture_punch_event');
    await expect(query(db.appUrl, 'delete from attendance_punch')).rejects.toThrow(/permission denied/);
    await expect(query(db.workerUrl, 'update attendance_punch set reason = null')).rejects.toThrow(/permission denied/);
  });
});
