import { createHmac, randomInt } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEMO_PASSWORD, DEMO_USERS, inviteUser, seedIdentity, sha256 } from '../src/modules/identity/index.js';
import { DEMO_COMPANY_ID, DEMO_ORGANIZATION, seedOrganization, toIsoDate } from '../src/modules/organization/index.js';
import { createDatabase, type Database } from '../src/platform/db/database.js';
import { signAccessToken, type AccessClaims } from '../src/platform/security/jwt.js';
import { issueXsrfToken } from '../src/platform/security/xsrf.js';
import { assertNoSecrets } from './support/assert-no-secrets.js';
import { Browser } from './support/cookie-jar.js';
import { createTestApp, RecordingMailSender, TEST_SECRETS } from './support/test-app.js';
import { createTestDatabase, query, type TestDatabase } from './support/test-database.js';
import { setCookieHeaders } from './support/xsrf.js';

const ADMIN = DEMO_USERS[0] ?? { id: '', email: '', displayName: '', locale: 'fr' as const };
const EST = DEMO_USERS[1] ?? ADMIN;
const PROBLEM_JSON = /^application\/problem\+json/;
const PROBLEM = (slug: string) => `urn:hrforce:problem:${slug}`;
const STRONG = 'rivière-lune-cartable-97';

type Res = Awaited<ReturnType<Browser['get']>>;

/** Asserts an auth response never leaks secrets and returns its body. */
function safe(res: Res): unknown {
  assertNoSecrets(res.body);
  expect(res.text).not.toMatch(/\$argon2|password_hash|token_hash/);
  return res.body;
}

function withoutRequestId(body: unknown): unknown {
  const { requestId: _r, ...rest } = body as Record<string, unknown>;
  return rest;
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const randomIp = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;

describe('Identity (e2e)', () => {
  let db: TestDatabase;
  let migrator: Database;
  let app: NestExpressApplication;
  const mails = new RecordingMailSender();
  const browser = () => new Browser(app, undefined, { 'X-Forwarded-For': randomIp() });

  const sessions = (userId: string) =>
    query<{ id: string; family_id: string; rotated_at: Date | null; revoked_at: Date | null; revoke_reason: string | null }>(
      db.superuserUrl,
      'select id, family_id, rotated_at, revoked_at, revoke_reason from auth.refresh_session where user_id = $1 order by created_at',
      [userId],
    );
  const invite = (email: string, name = 'Invité Test') =>
    migrator.transaction().execute((tx) => inviteUser(tx, { email, displayName: name, companyCode: 'DEMO', locale: 'en' }));

  beforeAll(async () => {
    db = await createTestDatabase();
    migrator = createDatabase({ connectionString: db.migratorUrl, maxConnections: 1 });
    await migrator.transaction().execute(async (tx) => {
      await seedOrganization(tx, DEMO_ORGANIZATION, toIsoDate(new Date()));
      await seedIdentity(tx, DEMO_COMPANY_ID);
      await seedIdentity(tx, DEMO_COMPANY_ID); // idempotent
    });
    app = await createTestApp(db, { devAuth: true, mailSender: mails, env: { TRUST_PROXY_HOPS: '1' } });
  });

  afterAll(async () => {
    await app?.close();
    await migrator?.destroy();
    await db?.drop();
  });

  beforeEach(async () => {
    mails.sent.length = 0;
    await query(db.superuserUrl, 'delete from auth.login_event');
  });

  // ---------------------------------------------------------------------------------------------------------
  describe('login', () => {
    it('success → 204 + hrf_at, hrf_rt and a new XSRF-TOKEN with the exact attributes; history recorded', async () => {
      const b = browser();
      await b.get('/api/auth/csrf');
      const anonXsrf = b.jar.get('XSRF-TOKEN');
      const res = await b.post('/api/auth/login', { email: '  RH.Admin@Demo.dz ', password: DEMO_PASSWORD }, { 'User-Agent': 'vitest-agent' });
      expect(res.status).toBe(204);
      expect(res.text).toBe('');
      const cookies = setCookieHeaders(res);
      expect(cookies).toHaveLength(3);
      expect(cookies.find((c) => c.startsWith('hrf_at='))).toMatch(
        /^hrf_at=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+; Max-Age=900; Path=\/api; HttpOnly; SameSite=Strict$/,
      );
      expect(cookies.find((c) => c.startsWith('hrf_rt='))).toMatch(/^hrf_rt=[A-Za-z0-9_-]{43}; Max-Age=(60479\d|604800); Path=\/api\/auth; HttpOnly; SameSite=Strict$/);
      expect(cookies.find((c) => c.startsWith('XSRF-TOKEN='))).toMatch(/^XSRF-TOKEN=[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}; Path=\/; SameSite=Strict$/);
      expect(b.jar.get('XSRF-TOKEN')).not.toBe(anonXsrf);

      const [live] = await sessions(ADMIN.id);
      expect(live).toBeDefined();
      // the new XSRF token is bound to the new session id
      const [random] = (b.jar.get('XSRF-TOKEN') ?? '').split('.');
      const expected = createHmac('sha256', TEST_SECRETS.AUTH_XSRF_SECRET).update(`${random}.${(await sessions(ADMIN.id)).at(-1)?.id}`).digest('base64url');
      expect(b.jar.get('XSRF-TOKEN')).toBe(`${random}.${expected}`);

      const events = await query<{ email: string; user_id: string; outcome: string; user_agent: string; ip: string }>(
        db.superuserUrl,
        'select email, user_id, outcome, user_agent, host(ip) as ip from auth.login_event',
      );
      expect(events).toEqual([{ email: ADMIN.email, user_id: ADMIN.id, outcome: 'success', user_agent: 'vitest-agent', ip: b.defaultHeaders['X-Forwarded-For'] }]);
    });

    it('COOKIE_SECURE=true adds Secure to every cookie', async () => {
      const secureApp = await createTestApp(db, { devAuth: true, env: { COOKIE_SECURE: 'true' } });
      try {
        const b = new Browser(secureApp, undefined, { 'X-Forwarded-For': randomIp() });
        const csrf = await b.get('/api/auth/csrf');
        expect(setCookieHeaders(csrf)[0]).toMatch(/; Path=\/; Secure; SameSite=Strict$/);
        const res = await b.post('/api/auth/login', { email: EST.email, password: DEMO_PASSWORD });
        expect(res.status).toBe(204);
        const cookies = setCookieHeaders(res);
        expect(cookies).toHaveLength(3);
        for (const c of cookies) expect(c).toMatch(/; Secure; SameSite=Strict$/);
      } finally {
        await secureApp.close();
      }
    });

    it('wrong password, unknown e-mail and invited account → identical 401 bodies', async () => {
      await invite('invited.only@demo.dz');
      const attempts = [
        { email: ADMIN.email, password: 'wrong-password-123' },
        { email: 'nobody@demo.dz', password: DEMO_PASSWORD },
        { email: 'invited.only@demo.dz', password: DEMO_PASSWORD },
      ];
      const bodies: unknown[] = [];
      for (const attempt of attempts) {
        const b = browser();
        await b.get('/api/auth/csrf');
        const res = await b.post('/api/auth/login', attempt);
        expect(res.status).toBe(401);
        expect(res.headers['content-type']).toMatch(PROBLEM_JSON);
        expect(setCookieHeaders(res)).toEqual([]);
        bodies.push(withoutRequestId(safe(res)));
      }
      expect(bodies[0]).toEqual({
        type: PROBLEM('invalid-credentials'),
        title: 'Unauthorized',
        status: 401,
        detail: 'Invalid e-mail or password.',
        instance: '/api/auth/login',
      });
      expect(bodies[1]).toEqual(bodies[0]);
      expect(bodies[2]).toEqual(bodies[0]);
      const outcomes = await query<{ outcome: string }>(db.superuserUrl, 'select outcome from auth.login_event');
      expect(outcomes.map((o) => o.outcome)).toEqual(['bad_credentials', 'bad_credentials', 'bad_credentials']);
    });

    it('5 failures lock the e-mail: 423 + Retry-After, even with the correct password', async () => {
      const b = browser();
      await b.get('/api/auth/csrf');
      for (let i = 0; i < 5; i++) {
        expect((await b.post('/api/auth/login', { email: EST.email, password: `wrong-${i}-password` })).status).toBe(401);
      }
      const locked = await b.post('/api/auth/login', { email: EST.email, password: 'wrong-again-password' });
      expect(locked.status).toBe(423);
      expect(safe(locked)).toMatchObject({ type: PROBLEM('account-locked'), status: 423 });
      const retryAfter = Number(locked.headers['retry-after']);
      expect(locked.headers['retry-after']).toMatch(/^\d+$/);
      expect(retryAfter).toBeGreaterThan(890);
      expect(retryAfter).toBeLessThanOrEqual(900);

      // from another IP, with the right password: still locked (the lock is per e-mail)
      const other = browser();
      await other.get('/api/auth/csrf');
      const blocked = await other.post('/api/auth/login', { email: EST.email, password: DEMO_PASSWORD });
      expect(blocked.status).toBe(423);
      expect(setCookieHeaders(blocked)).toEqual([]);

      // 15 min after the 5th failure the lock is over
      // (login_event is append-only: bypass its trigger as superuser to travel in time)
      await query(db.superuserUrl, `set session_replication_role = replica; update auth.login_event set at = at - interval '15 minutes 1 second'`);
      await expect(other.post('/api/auth/login', { email: EST.email, password: DEMO_PASSWORD })).resolves.toMatchObject({ status: 204 });
      const outcomes = await query<{ outcome: string }>(db.superuserUrl, 'select outcome from auth.login_event order by id');
      expect(outcomes.map((o) => o.outcome)).toEqual([...Array(5).fill('bad_credentials'), 'locked', 'locked', 'success']);
    });

    it('30 failures from one IP → 429 + Retry-After (other e-mails too)', async () => {
      const b = browser();
      await b.get('/api/auth/csrf');
      for (let i = 0; i < 30; i++) {
        expect((await b.post('/api/auth/login', { email: `ghost${i}@demo.dz`, password: 'whatever-password' })).status).toBe(401);
      }
      const res = await b.post('/api/auth/login', { email: ADMIN.email, password: DEMO_PASSWORD });
      expect(res.status).toBe(429);
      expect(safe(res)).toMatchObject({ type: PROBLEM('too-many-attempts'), status: 429 });
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      expect(Number(res.headers['retry-after'])).toBeLessThanOrEqual(900);
      // another IP is not affected
      const other = browser();
      expect((await other.login(ADMIN.email, DEMO_PASSWORD)).status).toBe(204);
    });

    it('disabled account → 403 only with the correct password', async () => {
      await migrator.transaction().execute((tx) =>
        seedIdentity(tx, DEMO_COMPANY_ID, [{ id: '0190a5d0-0000-7000-8000-0000000000d1', email: 'off@demo.dz', displayName: 'Off', locale: 'fr' }]),
      );
      await query(db.superuserUrl, `update auth.user_account set status = 'disabled' where email = 'off@demo.dz'`);
      const b = browser();
      await b.get('/api/auth/csrf');
      const wrong = await b.post('/api/auth/login', { email: 'off@demo.dz', password: 'not-the-password' });
      expect(wrong.status).toBe(401);
      expect(safe(wrong)).toMatchObject({ type: PROBLEM('invalid-credentials') });
      const right = await b.post('/api/auth/login', { email: 'off@demo.dz', password: DEMO_PASSWORD });
      expect(right.status).toBe(403);
      expect(safe(right)).toMatchObject({ type: PROBLEM('account-disabled'), status: 403 });
      expect(setCookieHeaders(right)).toEqual([]);
    });

    it('missing fields → 422', async () => {
      const b = browser();
      await b.get('/api/auth/csrf');
      const res = await b.post('/api/auth/login', { email: ADMIN.email });
      expect(res.status).toBe(422);
      expect(safe(res)).toMatchObject({ errors: [{ field: 'password' }] });
    });
  });

  // ---------------------------------------------------------------------------------------------------------
  describe('session', () => {
    it('GET /api/me → user, active company and memberships (no secrets)', async () => {
      const b = browser();
      await b.login(ADMIN.email, DEMO_PASSWORD);
      const res = await b.get('/api/me');
      expect(res.status).toBe(200);
      expect(safe(res)).toEqual({
        user: { id: ADMIN.id, email: 'rh.admin@demo.dz', displayName: 'Amina Benali', locale: 'fr' },
        company: { id: DEMO_COMPANY_ID, code: 'DEMO', name: 'Groupe Démo' },
        companies: [{ id: DEMO_COMPANY_ID, code: 'DEMO', name: 'Groupe Démo' }],
        // DEV_PERMISSIONS=allow_all in this file: every catalogue code, scoped to the whole company (root + sub-units)
        permissions: expect.arrayContaining(['org_unit.read', 'access.grant', 'employee.medical.read']),
        scopes: expect.objectContaining({ 'org_unit.read': [{ unitId: expect.any(String), includeDescendants: true }] }),
      });
      const est = browser();
      await est.login(EST.email, DEMO_PASSWORD);
      expect((await est.get('/api/me')).body).toMatchObject({ user: { email: 'rh.est@demo.dz', displayName: 'Karim Haddad', locale: 'ar' } });
    });

    it('anonymous /api/me → 401; the cookie identity reaches permission routes (DEV_PERMISSIONS=allow_all)', async () => {
      const b = browser();
      const anon = await b.get('/api/me');
      expect(anon.status).toBe(401);
      expect(safe(anon)).toMatchObject({ type: PROBLEM('unauthenticated') });
      await b.login(ADMIN.email, DEMO_PASSWORD);
      const tree = await b.get('/api/org/tree');
      expect(tree.status).toBe(200);
      expect(tree.body.root.code).toBe('DG');
    });

    it('a valid cookie wins over DEV_AUTH headers', async () => {
      const b = browser();
      await b.login(ADMIN.email, DEMO_PASSWORD);
      const res = await b.get('/api/me', { 'X-Dev-User-Id': EST.id, 'X-Dev-Company-Id': DEMO_COMPANY_ID });
      expect(res.body.user.id).toBe(ADMIN.id);
    });

    it('tampered access tokens (alg none, wrong signature, expired) are anonymous → 401', async () => {
      const b = browser();
      await b.login(ADMIN.email, DEMO_PASSWORD);
      const good = b.jar.get('hrf_at') ?? '';
      const [h, p] = good.split('.');
      const claims = JSON.parse(Buffer.from(p ?? '', 'base64url').toString()) as AccessClaims;
      const now = Math.floor(Date.now() / 1000);
      const variants = {
        none: `${b64({ alg: 'none', typ: 'JWT' })}.${p}.`,
        wrongSignature: `${h}.${p}.${createHmac('sha256', 'another-secret-another-secret-00').update(`${h}.${p}`).digest('base64url')}`,
        forgedClaims: `${h}.${b64({ ...claims, sub: EST.id })}.${good.split('.')[2]}`,
        expired: signAccessToken(TEST_SECRETS.AUTH_ACCESS_SECRET, { ...claims, iat: now - 1000, exp: now - 100 }),
      };
      for (const [name, token] of Object.entries(variants)) {
        const res = await request(app.getHttpServer()).get('/api/me').set('Cookie', `hrf_at=${token}`);
        expect(res.status, name).toBe(401);
      }
      expect((await request(app.getHttpServer()).get('/api/me').set('Cookie', `hrf_at=${good}`)).status).toBe(200);
    });

    it('refresh rotates; a rotated token presented after 10 s is reuse: the family is revoked, old and new tokens 401', async () => {
      const b = browser();
      await b.login(ADMIN.email, DEMO_PASSWORD);
      const firstRt = b.jar.get('hrf_rt');
      const firstAt = b.jar.get('hrf_at');
      const res = await b.post('/api/auth/refresh');
      expect(res.status).toBe(204);
      expect(setCookieHeaders(res).map((c) => c.split('=')[0]).toSorted()).toEqual(['XSRF-TOKEN', 'hrf_at', 'hrf_rt']);
      const secondRt = b.jar.get('hrf_rt');
      expect(secondRt).not.toBe(firstRt);
      expect(b.jar.get('hrf_at')).not.toBe(firstAt);
      expect((await b.get('/api/me')).status).toBe(200);

      const rows = await sessions(ADMIN.id);
      const family = rows.at(-1)?.family_id;
      expect(rows.filter((r) => r.family_id === family)).toHaveLength(2);
      await query(db.superuserUrl, `update auth.refresh_session set rotated_at = rotated_at - interval '11 seconds' where family_id = $1 and rotated_at is not null`, [family]);

      // an attacker replays the first token
      const attacker = b.tab();
      attacker.jar.set('hrf_rt', firstRt ?? '', '/api/auth');
      const replay = await attacker.post('/api/auth/refresh');
      expect(replay.status).toBe(401);
      expect(safe(replay)).toMatchObject({ type: PROBLEM('session-expired'), status: 401 });
      expect(setCookieHeaders(replay).filter((c) => c.includes('Max-Age=0')).map((c) => c.split('=')[0]).toSorted()).toEqual(['hrf_at', 'hrf_rt']);

      const after = (await sessions(ADMIN.id)).filter((r) => r.family_id === family);
      expect(after.every((r) => r.revoked_at !== null && r.revoke_reason === 'reuse')).toBe(true);
      // the legitimate user's (newer) token is dead too
      const legit = await b.post('/api/auth/refresh');
      expect(legit.status).toBe(401);
      expect(b.jar.get('hrf_rt')).toBeUndefined();
    });

    it('two tabs refreshing at once: the loser gets 409 refresh-race and nothing is revoked', async () => {
      const a = browser();
      await a.login(ADMIN.email, DEMO_PASSWORD);
      const b = a.tab();
      expect((await a.post('/api/auth/refresh')).status).toBe(204);
      const race = await b.post('/api/auth/refresh');
      expect(race.status).toBe(409);
      expect(safe(race)).toMatchObject({ type: PROBLEM('refresh-race'), status: 409 });
      expect(setCookieHeaders(race)).toEqual([]);
      const family = (await sessions(ADMIN.id)).at(-1)?.family_id;
      expect((await sessions(ADMIN.id)).filter((r) => r.family_id === family && r.revoked_at !== null)).toEqual([]);
      // the winner's session keeps working
      expect((await a.post('/api/auth/refresh')).status).toBe(204);
      expect((await a.get('/api/me')).status).toBe(200);
    });

    it('concurrent refreshes of the same token: exactly one rotation wins', async () => {
      const a = browser();
      await a.login(ADMIN.email, DEMO_PASSWORD);
      const tabs = [a.tab(), a.tab(), a.tab()];
      const statuses = (await Promise.all(tabs.map((t) => t.post('/api/auth/refresh')))).map((r) => r.status).toSorted();
      expect(statuses).toEqual([204, 409, 409]);
    });

    it('expired access cookie + valid refresh cookie: 401 on /api/me, refresh, then 200', async () => {
      const b = browser();
      await b.login(EST.email, DEMO_PASSWORD);
      b.jar.cookies.delete('hrf_at'); // Max-Age=900 elapsed
      expect((await b.get('/api/me')).status).toBe(401);
      // the XSRF token is bound to the session id: without hrf_at it is checked against the refresh cookie's session
      expect((await b.post('/api/auth/refresh')).status).toBe(204);
      expect((await b.get('/api/me')).status).toBe(200);
    });

    it('refresh without / with an unknown refresh cookie → 401 session-expired', async () => {
      const b = browser();
      await b.get('/api/auth/csrf');
      const res = await b.post('/api/auth/refresh');
      expect(res.status).toBe(401);
      expect(safe(res)).toMatchObject({ type: PROBLEM('session-expired') });
      b.jar.set('hrf_rt', 'A'.repeat(43), '/api/auth');
      expect((await b.post('/api/auth/refresh')).status).toBe(401);
    });

    it('idle-expired session (12 h) → 401 and the family is revoked', async () => {
      const b = browser();
      await b.login(EST.email, DEMO_PASSWORD);
      const id = (await sessions(EST.id)).at(-1)?.id;
      await query(db.superuserUrl, `update auth.refresh_session set expires_at = now() - interval '1 second' where id = $1`, [id]);
      expect((await b.post('/api/auth/refresh')).status).toBe(401);
      expect((await sessions(EST.id)).find((r) => r.id === id)?.revoke_reason).toBe('expired');
    });

    it('logout revokes the family, clears the cookies and issues an anon XSRF token', async () => {
      const b = browser();
      await b.login(ADMIN.email, DEMO_PASSWORD);
      const rt = b.jar.get('hrf_rt');
      const res = await b.post('/api/auth/logout');
      expect(res.status).toBe(204);
      const cookies = setCookieHeaders(res);
      expect(cookies).toContain('hrf_at=; Max-Age=0; Path=/api; HttpOnly; SameSite=Strict');
      expect(cookies).toContain('hrf_rt=; Max-Age=0; Path=/api/auth; HttpOnly; SameSite=Strict');
      expect(cookies.find((c) => c.startsWith('XSRF-TOKEN='))).toMatch(/; Path=\/; SameSite=Strict$/);
      expect((await b.get('/api/me')).status).toBe(401);
      const family = (await sessions(ADMIN.id)).at(-1);
      expect(family?.revoke_reason).toBe('logout');
      b.jar.set('hrf_rt', rt ?? '', '/api/auth');
      expect((await b.post('/api/auth/refresh')).status).toBe(401);
      // the anon token issued by logout is valid for the next login
      b.jar.cookies.delete('hrf_rt');
      expect((await b.post('/api/auth/login', { email: ADMIN.email, password: DEMO_PASSWORD })).status).toBe(204);
    });
  });

  // ---------------------------------------------------------------------------------------------------------
  describe('XSRF', () => {
    it('login: missing header or cookie → 403 xsrf; mismatched → 403; anon token accepted', async () => {
      const b = browser();
      await b.get('/api/auth/csrf');
      const token = b.jar.get('XSRF-TOKEN') ?? '';
      const body = { email: ADMIN.email, password: DEMO_PASSWORD };
      const server = app.getHttpServer();
      const noHeader = await request(server).post('/api/auth/login').set('Cookie', `XSRF-TOKEN=${token}`).send(body);
      expect(noHeader.status).toBe(403);
      expect(safe(noHeader)).toMatchObject({ type: PROBLEM('xsrf'), status: 403 });
      expect((await request(server).post('/api/auth/login').set('X-XSRF-TOKEN', token).send(body)).status).toBe(403);
      const other = issueXsrfToken(TEST_SECRETS.AUTH_XSRF_SECRET, 'anon');
      expect((await request(server).post('/api/auth/login').set('Cookie', `XSRF-TOKEN=${token}`).set('X-XSRF-TOKEN', other).send(body)).status).toBe(403);
      const unsigned = `${'a'.repeat(43)}.${'b'.repeat(43)}`;
      expect((await request(server).post('/api/auth/login').set('Cookie', `XSRF-TOKEN=${unsigned}`).set('X-XSRF-TOKEN', unsigned).send(body)).status).toBe(403);
      expect((await b.post('/api/auth/login', body)).status).toBe(204);
    });

    it('a token signed for another sid → 403 (logout and ordinary routes)', async () => {
      const b = browser();
      await b.login(ADMIN.email, DEMO_PASSWORD);
      const foreign = issueXsrfToken(TEST_SECRETS.AUTH_XSRF_SECRET, '0190a5d0-0000-7000-8000-00000000dead');
      const tampered = b.tab();
      tampered.jar.set('XSRF-TOKEN', foreign);
      const logout = await tampered.post('/api/auth/logout');
      expect(logout.status).toBe(403);
      expect(safe(logout)).toMatchObject({ type: PROBLEM('xsrf') });
      expect((await tampered.post('/api/_test/echo', { name: 'A', age: 1, address: { city: 'Oran' } })).status).toBe(403);
      // once signed in, an anon token no longer passes on ordinary routes; the session-bound one does
      const anon = b.tab();
      anon.jar.set('XSRF-TOKEN', issueXsrfToken(TEST_SECRETS.AUTH_XSRF_SECRET, 'anon'));
      expect((await anon.post('/api/_test/echo', { name: 'A', age: 1, address: { city: 'Oran' } })).status).toBe(403);
      expect((await b.post('/api/_test/echo', { name: 'A', age: 1, address: { city: 'Oran' } })).status).toBe(201);
      expect((await sessions(ADMIN.id)).at(-1)?.revoked_at).toBeNull();
    });

    it('GET /api/auth/csrf keeps a valid token and replaces a missing or stale one', async () => {
      const b = browser();
      const first = await b.get('/api/auth/csrf');
      expect(first.status).toBe(204);
      expect(setCookieHeaders(first)).toHaveLength(1);
      expect(setCookieHeaders(await b.get('/api/auth/csrf'))).toEqual([]);
      await b.post('/api/auth/login', { email: ADMIN.email, password: DEMO_PASSWORD });
      expect(setCookieHeaders(await b.get('/api/auth/csrf'))).toEqual([]);
      b.jar.set('XSRF-TOKEN', issueXsrfToken(TEST_SECRETS.AUTH_XSRF_SECRET, 'anon'));
      const replaced = await b.get('/api/auth/csrf');
      expect(setCookieHeaders(replaced)).toHaveLength(1);
      expect((await b.post('/api/_test/echo', { name: 'A', age: 1, address: { city: 'Oran' } })).status).toBe(201);
    });
  });

  // ---------------------------------------------------------------------------------------------------------
  describe('password setup and reset', () => {
    it('invite → setup: password set, account active, login works; the token is single-use (410)', async () => {
      const invited = await invite('new.hire@demo.dz', 'New Hire');
      expect(invited).toMatchObject({ created: true });
      const token = invited.setupToken ?? '';
      const b = browser();
      await b.get('/api/auth/csrf');
      const res = await b.post('/api/auth/password/setup', { token, password: STRONG });
      expect(res.status).toBe(204);
      expect(res.text).toBe('');
      const [account] = await query<{ status: string }>(db.superuserUrl, `select status from auth.user_account where email = 'new.hire@demo.dz'`);
      expect(account?.status).toBe('active');
      expect((await b.post('/api/auth/login', { email: 'new.hire@demo.dz', password: STRONG })).status).toBe(204);
      const again = await b.post('/api/auth/password/setup', { token, password: `${STRONG}-2` });
      expect(again.status).toBe(410);
      expect(safe(again)).toMatchObject({ type: PROBLEM('token-invalid'), status: 410 });
    });

    it('expired, unknown or malformed tokens → 410', async () => {
      const invited = await invite('late.hire@demo.dz');
      await query(db.superuserUrl, `update auth.password_token set expires_at = now() - interval '1 second' where token_hash = $1`, [sha256(invited.setupToken ?? '')]);
      const b = browser();
      await b.get('/api/auth/csrf');
      for (const token of [invited.setupToken ?? '', 'A'.repeat(43), 'not a token']) {
        const res = await b.post('/api/auth/password/setup', { token, password: STRONG });
        expect(res.status).toBe(410);
      }
    });

    it('policy violations → 422 with errors[{field: password, code}] (token kept)', async () => {
      const invited = await invite('policy.check@demo.dz');
      const b = browser();
      await b.get('/api/auth/csrf');
      const cases: [string, string[]][] = [
        ['short-pw', ['too_short']],
        ['x'.repeat(129), ['too_long']],
        ['my-policy.check-is-long', ['contains_email']],
        ['Password1234', ['common']],
      ];
      for (const [password, codes] of cases) {
        const res = await b.post('/api/auth/password/setup', { token: invited.setupToken, password });
        expect(res.status, password).toBe(422);
        const body = safe(res) as { type: string; errors: { field: string; code: string }[] };
        expect(body.type).toBe(PROBLEM('validation-error'));
        expect(body.errors.map((e) => e.field)).toEqual(codes.map(() => 'password'));
        expect(body.errors.map((e) => e.code)).toEqual(codes);
      }
      expect((await b.post('/api/auth/password/setup', { token: invited.setupToken, password: STRONG })).status).toBe(204);
    });

    it('forgot → 202 always; mails only active accounts; reset revokes every session; 3 per hour', async () => {
      await invite('pending@demo.dz');
      const b = browser();
      await b.get('/api/auth/csrf');
      for (const email of ['nobody@demo.dz', 'pending@demo.dz', 'off@demo.dz']) {
        const res = await b.post('/api/auth/password/forgot', { email });
        expect(res.status).toBe(202);
        expect(res.text).toBe('');
      }
      await new Promise((r) => setTimeout(r, 50));
      expect(mails.sent).toEqual([]);

      // an active user with two live sessions asks for a reset
      const user = browser();
      await user.login(EST.email, DEMO_PASSWORD);
      const other = browser();
      await other.login(EST.email, DEMO_PASSWORD);
      expect((await b.post('/api/auth/password/forgot', { email: 'RH.EST@demo.dz' })).status).toBe(202);
      await vi.waitFor(() => expect(mails.sent).toHaveLength(1));
      const mail = mails.sent[0];
      expect(mail?.to).toBe(EST.email);
      expect(mail?.subject).toContain('HRForce');
      const link = /http:\/\/web\.test\/password\/setup\?token=([A-Za-z0-9_-]{43})/.exec(mail?.text ?? '');
      expect(link).not.toBeNull();
      expect(mail?.html).toContain(link?.[0]);
      expect(mail?.text).toContain('فريق HRForce'); // Karim's locale is ar

      const newPassword = 'nouveau-mot-de-passe-solide';
      expect((await b.post('/api/auth/password/setup', { token: link?.[1], password: newPassword })).status).toBe(204);
      expect((await sessions(EST.id)).filter((r) => r.revoked_at === null)).toEqual([]);
      expect((await user.post('/api/auth/refresh')).status).toBe(401);
      expect((await other.post('/api/auth/refresh')).status).toBe(401);
      expect((await browser().login(EST.email, DEMO_PASSWORD)).status).toBe(401);
      expect((await browser().login(EST.email, newPassword)).status).toBe(204);
      // restore the demo password for the other tests
      await migrator.transaction().execute(async (tx) => {
        await query(db.superuserUrl, `delete from auth.user_credential where user_id = $1`, [EST.id]);
        await seedIdentity(tx, DEMO_COMPANY_ID);
      });

      // quota: 3 reset tokens per account per hour (1 used above)
      mails.sent.length = 0;
      for (let i = 0; i < 3; i++) expect((await b.post('/api/auth/password/forgot', { email: EST.email })).status).toBe(202);
      await vi.waitFor(() => expect(mails.sent).toHaveLength(2));
      await new Promise((r) => setTimeout(r, 50));
      expect(mails.sent).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------------------------------------
  describe('database privileges', () => {
    it('hrforce_app has no direct access to the auth tables (only the SECURITY DEFINER functions)', async () => {
      for (const table of ['user_account', 'user_credential', 'user_company', 'refresh_session', 'password_token', 'login_event']) {
        await expect(query(db.appUrl, `select * from auth.${table} limit 1`)).rejects.toThrow(/permission denied/);
      }
      await expect(query(db.appUrl, `insert into auth.login_event (email, outcome) values ('x', 'success')`)).rejects.toThrow(/permission denied/);
      await expect(query(db.appUrl, `update auth.user_account set status = 'active'`)).rejects.toThrow(/permission denied/);
      // functions: granted ones work, nothing else is executable by the app
      const [row] = await query<{ n: number }>(db.appUrl, `select count(*)::int as n from auth.find_login('rh.admin@demo.dz')`);
      expect(row?.n).toBe(1);
      await expect(query(db.appUrl, `select auth.login_event_append_only()`)).rejects.toThrow(/permission denied/);
      const publicExec = await query(
        db.superuserUrl,
        `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'auth' and has_function_privilege('public', p.oid, 'execute')`,
      );
      expect(publicExec).toEqual([]);
      const definers = await query<{ proname: string; prosecdef: boolean; proconfig: string[] | null }>(
        db.superuserUrl,
        `select p.proname, p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'auth' and has_function_privilege('hrforce_app', p.oid, 'execute')`,
      );
      expect(definers.length).toBe(15); // 0007's twelve + auth.company_members (0008) + auth.session_owner, auth.default_company (0009)
      for (const f of definers) {
        expect(f.prosecdef, f.proname).toBe(true);
        expect(f.proconfig, f.proname).toEqual(['search_path=pg_catalog, auth']);
      }
    });

    it('login_event is append-only', async () => {
      await query(db.superuserUrl, `insert into auth.login_event (email, outcome) values ('x@y.z', 'success')`);
      await expect(query(db.migratorUrl, `update auth.login_event set outcome = 'locked'`)).rejects.toThrow(/append-only/);
    });
  });
});
