/**
 * Two-step sign-in (docs/contracts/mfa.md): enrollment, the login second step with the hrf_mfa cookie, replay and
 * ±1-step window, challenge failures and the per-e-mail lock, recovery codes (single use, normalization, security
 * mail), regeneration, disable, enforcement by company policy (@AllowWithoutMfa exceptions), admin reset (scope, self,
 * sessions), the security policy and database privileges. Log redaction: mfa-logs.e2e-spec.ts (its own app: nestjs-pino
 * logs through the first app created in a process).
 * Real cookie sessions (Browser) for the user flows; DEV_AUTH header identities (real grants) for the admin rules.
 */
import { randomInt } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { base32Decode, DEMO_PASSWORD, hotp, MfaClock, totpStep } from '../src/modules/identity/index.js';
import { signAccessToken } from '../src/platform/security/jwt.js';
import { as, COMPANY_A, seedAccessFixture, USERS } from './support/access-fixture.js';
import { assertNoSecrets } from './support/assert-no-secrets.js';
import { Browser } from './support/cookie-jar.js';
import { createTestApp, RecordingMailSender, TEST_SECRETS } from './support/test-app.js';
import { createTestDatabase, query, type TestDatabase } from './support/test-database.js';
import { fetchXsrf, setCookieHeaders, type XsrfPair } from './support/xsrf.js';

const PROBLEM = (slug: string) => `urn:hrforce:problem:${slug}`;
const randomIp = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
type Res = Awaited<ReturnType<Browser['get']>>;
const typeOf = (res: Res) => (res.body as { type?: string }).type;

/** The app's TOTP clock: every `code()` moves it one 30-second step (a step is never accepted twice). */
const clock = { now: Date.now() };

/** Password step of a user with MFA: 200 {mfaRequired: true} + hrf_mfa only. */
async function passwordStep(b: Browser, email: string): Promise<Res> {
  const res = await b.login(email, DEMO_PASSWORD);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body).toEqual({ mfaRequired: true });
  return res;
}

describe('Two-step sign-in (e2e)', () => {
  let db: TestDatabase;
  let app: NestExpressApplication;
  let xsrf: XsrfPair;
  const mails = new RecordingMailSender();
  const browser = () => new Browser(app, undefined, { 'X-Forwarded-For': randomIp() });
  /** TOTP secrets of the enrolled users (base32 from enroll/start). */
  const secrets = new Map<string, Buffer>();
  const code = (userId: string, offsetSteps = 0) => {
    clock.now += 30_000;
    return hotp(secrets.get(userId) ?? Buffer.alloc(0), totpStep(clock.now) + offsetSteps);
  };
  const loginEvents = (email: string) =>
    query<{ outcome: string }>(db.superuserUrl, 'select outcome from auth.login_event where email = $1 order by id', [email]);
  const events = (type: string, subject: string) =>
    query<{ actor_user_id: string | null; data: Record<string, unknown>; company_id: string }>(
      db.superuserUrl,
      'select actor_user_id, data, company_id from audit.event where type = $1 and subject_id = $2 order by id',
      [type, subject],
    );
  const setPolicy = (enforced: boolean, permissions?: string[]) =>
    query(
      db.superuserUrl,
      `update security_policy set mfa_enforced = $2, mfa_required_permissions = coalesce($3::text[], public.security_policy_default_permissions()) where company_id = $1`,
      [COMPANY_A, enforced, permissions ?? null],
    );

  /** Signs in with the password only (no factor yet) and enrolls; returns the browser and the recovery codes. */
  async function enroll(email: string, userId: string): Promise<{ b: Browser; recoveryCodes: string[] }> {
    const b = browser();
    expect((await b.login(email, DEMO_PASSWORD)).status).toBe(204);
    const start = await b.post('/api/me/mfa/enroll/start');
    expect(start.status).toBe(200);
    secrets.set(userId, base32Decode(start.body.secret as string) ?? Buffer.alloc(0));
    const confirm = await b.post('/api/me/mfa/enroll/confirm', { code: code(userId) });
    expect(confirm.status, JSON.stringify(confirm.body)).toBe(200);
    return { b, recoveryCodes: confirm.body.recoveryCodes as string[] };
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    await seedAccessFixture(db);
    app = await createTestApp(db, {
      devAuth: true,
      devPermissions: false,
      mailSender: mails,
      env: { TRUST_PROXY_HOPS: '1' },
      overrides: [{ provide: MfaClock, useValue: { nowMs: () => clock.now } }],
    });
    xsrf = await fetchXsrf(app);
  });
  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });
  beforeEach(async () => {
    mails.sent.length = 0;
    await query(db.superuserUrl, 'delete from auth.login_event');
  });

  // ---------------------------------------------------------------------------------------------------------
  describe('enrollment (rh.est, not required)', () => {
    it('status → start (pending, replaceable) → wrong code 422 → confirm → 10 recovery codes once; 409 afterwards', async () => {
      const b = browser();
      await b.login(USERS.est.email, DEMO_PASSWORD);
      expect((await b.get('/api/me/mfa')).body).toEqual({ enabled: false, required: false, enrolledAt: null, recoveryCodesLeft: null });

      const first = await b.post('/api/me/mfa/enroll/start');
      const start = await b.post('/api/me/mfa/enroll/start');
      expect(start.status).toBe(200);
      assertNoSecrets(start.body, ['$.secret']);
      expect(Object.keys(start.body).toSorted()).toEqual(['otpauthUri', 'qrPng', 'secret']);
      expect(start.body.secret).toMatch(/^[A-Z2-7]{32}$/);
      expect(start.body.secret).not.toBe(first.body.secret);
      expect(start.body.otpauthUri).toBe(
        `otpauth://totp/HRForce:rh.est%40demo.dz?secret=${start.body.secret}&issuer=HRForce&algorithm=SHA1&digits=6&period=30`,
      );
      expect(start.body.qrPng).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/);
      const secret = base32Decode(start.body.secret as string) ?? Buffer.alloc(0);
      secrets.set(USERS.est.id, secret);
      // stored encrypted (48 bytes: nonce ‖ ciphertext ‖ tag), never in clear
      const [stored] = await query<{ status: string; secret_enc: Buffer }>(db.superuserUrl, 'select status, secret_enc from auth.user_mfa where user_id = $1', [USERS.est.id]);
      expect(stored?.status).toBe('pending');
      expect(stored?.secret_enc).toHaveLength(48);
      expect(stored?.secret_enc.includes(secret)).toBe(false);
      // the first (replaced) secret no longer works
      const stale = await b.post('/api/me/mfa/enroll/confirm', { code: hotp(base32Decode(first.body.secret as string) ?? Buffer.alloc(0), totpStep(clock.now + 30_000)) });
      expect(stale.status).toBe(422);

      const wrong = await b.post('/api/me/mfa/enroll/confirm', { code: '000000' });
      expect(wrong.status).toBe(422);
      expect(wrong.body).toMatchObject({ type: PROBLEM('mfa-invalid'), errors: [{ field: 'code', code: 'mfa_invalid' }] });
      expect((await loginEvents(USERS.est.email)).map((e) => e.outcome)).toEqual(['success', 'mfa_failed', 'mfa_failed']);

      const confirm = await b.post('/api/me/mfa/enroll/confirm', { code: code(USERS.est.id) });
      expect(confirm.status).toBe(200);
      const codes = confirm.body.recoveryCodes as string[];
      expect(codes).toHaveLength(10);
      for (const c of codes) expect(c).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
      recoveryCodes.push(...codes);

      const status = await b.get('/api/me/mfa');
      expect(status.body).toMatchObject({ enabled: true, required: false, recoveryCodesLeft: 10 });
      expect(Date.parse(status.body.enrolledAt as string)).not.toBeNaN();
      expect((await b.get('/api/me')).body.mfa).toEqual({ enabled: true, required: false, recoveryCodesLeft: 10 });
      expect(typeOf(await b.post('/api/me/mfa/enroll/start'))).toBe(PROBLEM('mfa-already-enabled'));
      expect((await b.post('/api/me/mfa/enroll/confirm', { code: code(USERS.est.id) })).status).toBe(409);
      expect(await events('auth.mfa_enrolled', USERS.est.id)).toEqual([expect.objectContaining({ actor_user_id: USERS.est.id, data: {} })]);
    });
  });
  const recoveryCodes: string[] = [];

  // ---------------------------------------------------------------------------------------------------------
  describe('login with a second factor', () => {
    it('password → 200 {mfaRequired} + hrf_mfa only; verify → 204 + session cookies, hrf_mfa cleared; history + audit', async () => {
      const b = browser();
      const step1 = await passwordStep(b, USERS.est.email);
      const cookies = setCookieHeaders(step1);
      expect(cookies).toHaveLength(1);
      expect(cookies[0]).toMatch(/^hrf_mfa=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+; Max-Age=300; Path=\/api\/auth\/mfa; HttpOnly; SameSite=Strict$/);
      expect((await b.get('/api/me')).status).toBe(401);
      expect(await loginEvents(USERS.est.email)).toEqual([]); // the second step writes the event

      const wrong = await b.post('/api/auth/mfa/verify', { code: '000000' });
      expect(wrong.status).toBe(401);
      expect(typeOf(wrong)).toBe(PROBLEM('mfa-invalid'));
      const ok = await b.post('/api/auth/mfa/verify', { code: code(USERS.est.id) });
      expect(ok.status, JSON.stringify(ok.body)).toBe(204);
      const set = setCookieHeaders(ok);
      expect(set.map((c) => c.split('=')[0]).toSorted()).toEqual(['XSRF-TOKEN', 'hrf_at', 'hrf_mfa', 'hrf_rt']);
      expect(set.find((c) => c.startsWith('hrf_mfa='))).toBe('hrf_mfa=; Max-Age=0; Path=/api/auth/mfa; HttpOnly; SameSite=Strict');
      expect((await b.get('/api/me')).status).toBe(200);
      expect((await loginEvents(USERS.est.email)).map((e) => e.outcome)).toEqual(['mfa_failed', 'success']);
      const logins = await events('auth.login', USERS.est.id);
      expect(logins.at(-1)).toMatchObject({ actor_user_id: USERS.est.id, company_id: COMPANY_A, data: expect.objectContaining({ mfa: 'totp' }) });
    });

    it('a code is never accepted twice (replay); the next step (+1) is accepted; a consumed challenge is dead', async () => {
      const used = code(USERS.est.id);
      const first = browser();
      await passwordStep(first, USERS.est.email);
      const spent = first.jar.get('hrf_mfa') ?? '';
      expect((await first.post('/api/auth/mfa/verify', { code: used })).status).toBe(204);

      const second = browser();
      await passwordStep(second, USERS.est.email);
      const replay = await second.post('/api/auth/mfa/verify', { code: used });
      expect([replay.status, typeOf(replay)]).toEqual([401, PROBLEM('mfa-invalid')]);
      // one step ahead of the clock (drift +1) is accepted
      const ahead = hotp(secrets.get(USERS.est.id) ?? Buffer.alloc(0), totpStep(clock.now) + 1);
      expect((await second.post('/api/auth/mfa/verify', { code: ahead })).status).toBe(204);
      // two steps behind is refused even when never used
      const third = browser();
      await passwordStep(third, USERS.est.email);
      clock.now += 90_000;
      const behind = hotp(secrets.get(USERS.est.id) ?? Buffer.alloc(0), totpStep(clock.now) - 2);
      expect(typeOf(await third.post('/api/auth/mfa/verify', { code: behind }))).toBe(PROBLEM('mfa-invalid'));

      // the consumed challenge of `first` cannot be used again
      const again = browser();
      again.jar.set('hrf_mfa', spent, '/api/auth/mfa');
      await again.get('/api/auth/csrf');
      const dead = await again.post('/api/auth/mfa/verify', { code: code(USERS.est.id) });
      expect([dead.status, typeOf(dead)]).toEqual([401, PROBLEM('mfa-challenge-expired')]);
    });

    it('the pending token is not an access token, and an access token cannot complete a challenge', async () => {
      const pending = browser();
      await passwordStep(pending, USERS.est.email);
      const token = pending.jar.get('hrf_mfa') ?? '';
      // pending token presented as the access cookie → anonymous everywhere
      const misuse = browser();
      misuse.jar.set('hrf_at', token, '/api');
      expect((await misuse.get('/api/me')).status).toBe(401);
      expect((await misuse.get('/api/me/mfa')).status).toBe(401);
      expect((await misuse.get('/api/org/tree')).status).toBe(401);
      // a real access token presented as hrf_mfa → challenge expired
      const now = Math.floor(Date.now() / 1000);
      const access = signAccessToken(TEST_SECRETS.AUTH_ACCESS_SECRET, { sub: USERS.est.id, cid: COMPANY_A, sid: USERS.est.id, iat: now, exp: now + 900 });
      const forged = browser();
      await forged.get('/api/auth/csrf');
      forged.jar.set('hrf_mfa', access, '/api/auth/mfa');
      const res = await forged.post('/api/auth/mfa/verify', { code: code(USERS.est.id) });
      expect([res.status, typeOf(res)]).toEqual([401, PROBLEM('mfa-challenge-expired')]);
      // no cookie at all
      const none = browser();
      await none.get('/api/auth/csrf');
      expect(typeOf(await none.post('/api/auth/mfa/verify', { code: '123456' }))).toBe(PROBLEM('mfa-challenge-expired'));
      // exactly one of code / recoveryCode
      expect((await pending.post('/api/auth/mfa/verify', {})).status).toBe(422);
      expect((await pending.post('/api/auth/mfa/verify', { code: '123456', recoveryCode: 'ABCDE-FGHJK' })).status).toBe(422);
      // XSRF is required
      expect((await new Browser(app).post('/api/auth/mfa/verify', { code: '123456' })).status).toBe(403);
    });

    it('5 failures kill the challenge (then even the right code is refused); they lock the e-mail like wrong passwords', async () => {
      const b = browser();
      await passwordStep(b, USERS.est.email);
      for (let i = 0; i < 4; i++) expect(typeOf(await b.post('/api/auth/mfa/verify', { code: '000000' }))).toBe(PROBLEM('mfa-invalid'));
      const fifth = await b.post('/api/auth/mfa/verify', { code: '000000' });
      expect([fifth.status, typeOf(fifth)]).toEqual([401, PROBLEM('mfa-challenge-expired')]);
      expect(setCookieHeaders(fifth)).toContain('hrf_mfa=; Max-Age=0; Path=/api/auth/mfa; HttpOnly; SameSite=Strict');
      expect((await loginEvents(USERS.est.email)).map((e) => e.outcome)).toEqual(Array(5).fill('mfa_failed'));
      // 5 failures in 15 min: the e-mail is locked, even with the right password
      const locked = await browser().login(USERS.est.email, DEMO_PASSWORD);
      expect(locked.status).toBe(423);
      expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('wrong passwords and MFA failures add up: 4 bad passwords + 1 wrong code → the next verify is 423', async () => {
      const bad = browser();
      for (let i = 0; i < 4; i++) expect((await bad.login(USERS.est.email, 'wrong-password-123')).status).toBe(401);
      const b = browser();
      await passwordStep(b, USERS.est.email);
      expect(typeOf(await b.post('/api/auth/mfa/verify', { code: '000000' }))).toBe(PROBLEM('mfa-invalid'));
      const res = await b.post('/api/auth/mfa/verify', { code: code(USERS.est.id) });
      expect([res.status, typeOf(res)]).toEqual([423, PROBLEM('account-locked')]);
    });
  });

  // ---------------------------------------------------------------------------------------------------------
  describe('recovery codes', () => {
    it('single use; case, hyphens and spaces ignored; security mail with the count; audit auth.mfa_recovery_used', async () => {
      const [c1 = '', c2 = '', c3 = ''] = recoveryCodes;
      const variants = [c1.toLowerCase(), ` ${c2.replace('-', '')} `, `${c3.slice(0, 2)} ${c3.slice(2, 7).toLowerCase()} - ${c3.slice(7)}`];
      for (const [i, variant] of variants.entries()) {
        const b = browser();
        await passwordStep(b, USERS.est.email);
        const res = await b.post('/api/auth/mfa/verify', { recoveryCode: variant });
        expect(res.status, `${variant}: ${JSON.stringify(res.body)}`).toBe(204);
        expect((await b.get('/api/me/mfa')).body.recoveryCodesLeft).toBe(9 - i);
      }
      expect(mails.sent).toHaveLength(3);
      expect(mails.sent[0]).toMatchObject({ to: USERS.est.email });
      expect(mails.sent[2]?.text).toContain('7'); // rh.est reads Arabic: "7" codes left
      const used = await events('auth.mfa_recovery_used', USERS.est.id);
      expect(used.map((e) => e.data)).toEqual([{ recoveryCodesLeft: 9 }, { recoveryCodesLeft: 8 }, { recoveryCodesLeft: 7 }]);
      expect((await events('auth.login', USERS.est.id)).at(-1)?.data).toMatchObject({ mfa: 'recovery' });

      // a used code is refused; so is garbage
      const b = browser();
      await passwordStep(b, USERS.est.email);
      expect(typeOf(await b.post('/api/auth/mfa/verify', { recoveryCode: c1 }))).toBe(PROBLEM('mfa-invalid'));
      expect(typeOf(await b.post('/api/auth/mfa/verify', { recoveryCode: 'not-a-code' }))).toBe(PROBLEM('mfa-invalid'));
      expect(mails.sent).toHaveLength(3);
    });

    it('regenerate: needs a current code (422 otherwise); the old set stops working', async () => {
      const b = browser();
      await passwordStep(b, USERS.est.email);
      await b.post('/api/auth/mfa/verify', { code: code(USERS.est.id) });
      expect(typeOf(await b.post('/api/me/mfa/recovery-codes', { code: '000000' }))).toBe(PROBLEM('mfa-invalid'));
      const res = await b.post('/api/me/mfa/recovery-codes', { code: code(USERS.est.id) });
      expect(res.status).toBe(200);
      const fresh = res.body.recoveryCodes as string[];
      expect(fresh).toHaveLength(10);
      expect((await b.get('/api/me/mfa')).body.recoveryCodesLeft).toBe(10);
      expect(await events('auth.mfa_recovery_regenerated', USERS.est.id)).toHaveLength(1);

      const old = browser();
      await passwordStep(old, USERS.est.email);
      expect(typeOf(await old.post('/api/auth/mfa/verify', { recoveryCode: recoveryCodes[5] ?? '' }))).toBe(PROBLEM('mfa-invalid'));
      expect((await old.post('/api/auth/mfa/verify', { recoveryCode: fresh[0] ?? '' })).status).toBe(204);
      recoveryCodes.splice(0, recoveryCodes.length, ...fresh.slice(1));
    });
  });

  // ---------------------------------------------------------------------------------------------------------
  describe('enforcement by company policy', () => {
    afterAll(() => setPolicy(false));

    it('rh.admin (sensitive + access permissions) turns enforcement on: 403 mfa-enrollment-required except /me, /me/mfa*, unread count, /auth/*; enrolling unlocks everything', async () => {
      const b = browser();
      await b.login(USERS.admin.email, DEMO_PASSWORD);
      expect((await b.get('/api/me')).body.mfa).toEqual({ enabled: false, required: false, recoveryCodesLeft: null });
      const put = await b.put('/api/access/security-policy', { mfaEnforced: true, mfaRequiredPermissions: ['employee.salary.read', 'access.grant', 'access.grant'] });
      expect(put.status, JSON.stringify(put.body)).toBe(200);
      expect(put.body).toEqual({ mfaEnforced: true, mfaRequiredPermissions: ['access.grant', 'employee.salary.read'] }); // catalogue order, no duplicate

      const blocked = await b.get('/api/employees');
      expect(blocked.status).toBe(403);
      expect(blocked.body).toMatchObject({ type: PROBLEM('mfa-enrollment-required'), status: 403 });
      for (const path of ['/api/org/tree', '/api/access/security-policy', '/api/tasks', '/api/me/notifications']) expect(typeOf(await b.get(path)), path).toBe(PROBLEM('mfa-enrollment-required'));
      expect(typeOf(await b.put('/api/access/security-policy', { mfaEnforced: false, mfaRequiredPermissions: [] }))).toBe(PROBLEM('mfa-enrollment-required'));
      expect((await b.get('/api/me')).body.mfa).toEqual({ enabled: false, required: true, recoveryCodesLeft: null });
      expect((await b.get('/api/me/mfa')).body).toMatchObject({ enabled: false, required: true });
      expect((await b.get('/api/me/notifications/unread-count')).status).toBe(200);
      expect((await b.post('/api/auth/refresh')).status).toBe(204);

      const start = await b.post('/api/me/mfa/enroll/start');
      expect(start.status).toBe(200);
      secrets.set(USERS.admin.id, base32Decode(start.body.secret as string) ?? Buffer.alloc(0));
      expect((await b.post('/api/me/mfa/enroll/confirm', { code: code(USERS.admin.id) })).status).toBe(200);
      expect((await b.get('/api/employees')).status).toBe(200);
      expect((await b.get('/api/me')).body.mfa).toEqual({ enabled: true, required: true, recoveryCodesLeft: 10 });

      // required → disable refused
      const disable = await b.post('/api/me/mfa/disable', { code: code(USERS.admin.id) });
      expect([disable.status, typeOf(disable)]).toEqual([409, PROBLEM('mfa-required-by-policy')]);
      // logout is always possible; the next login asks for the second factor
      expect((await b.post('/api/auth/logout')).status).toBe(204);
      const again = browser();
      await passwordStep(again, USERS.admin.email);
      expect((await again.post('/api/auth/mfa/verify', { code: code(USERS.admin.id) })).status).toBe(204);
      expect((await again.get('/api/employees')).status).toBe(200);
    });

    it('a user the policy does not cover is unaffected; changing the list changes `required`', async () => {
      const ouest = browser(); // lecture: org_unit.read, site.read, employee.read
      await ouest.login(USERS.ouest.email, DEMO_PASSWORD);
      expect((await ouest.get('/api/org/tree')).status).toBe(200);
      expect((await ouest.get('/api/me')).body.mfa).toEqual({ enabled: false, required: false, recoveryCodesLeft: null });
      await setPolicy(true, ['employee.read']);
      expect((await ouest.get('/api/me')).body.mfa).toEqual({ enabled: false, required: true, recoveryCodesLeft: null });
      expect(typeOf(await ouest.get('/api/org/tree'))).toBe(PROBLEM('mfa-enrollment-required'));
      await setPolicy(false, ['employee.read']);
      expect((await ouest.get('/api/me')).body.mfa.required).toBe(false);
      expect((await ouest.get('/api/org/tree')).status).toBe(200);
    });

    it('policy: GET for access.manage_roles holders; PUT needs it company-wide (403 forbidden-scope); unknown codes 422', async () => {
      expect((await as(app, 'acces', xsrf).get('/api/access/security-policy')).status).toBe(200);
      expect((await as(app, 'est', xsrf).get('/api/access/security-policy')).status).toBe(403);
      const regional = await as(app, 'acces', xsrf).put('/api/access/security-policy').send({ mfaEnforced: false, mfaRequiredPermissions: [] });
      expect([regional.status, regional.body.type]).toEqual([403, PROBLEM('forbidden-scope')]);
      const unknown = await as(app, 'admin', xsrf).put('/api/access/security-policy').send({ mfaEnforced: false, mfaRequiredPermissions: ['nope.read'] });
      expect(unknown.status).toBe(422);
      expect(unknown.body.errors).toEqual([expect.objectContaining({ field: 'mfaRequiredPermissions', code: 'unknown_permission' })]);
      expect((await as(app, 'admin', xsrf).put('/api/access/security-policy').send({ mfaEnforced: 'yes' })).status).toBe(422);
      // a company without a row has the defaults: enforced, sensitive + access.grant, access.manage_roles, leave.configure
      await query(db.superuserUrl, 'delete from security_policy where company_id = $1', [COMPANY_A]);
      const defaults = await as(app, 'admin', xsrf).get('/api/access/security-policy');
      expect(defaults.body.mfaEnforced).toBe(true);
      expect(defaults.body.mfaRequiredPermissions).toEqual(expect.arrayContaining(['access.grant', 'access.manage_roles', 'leave.configure', 'employee.salary.read', 'employee.medical.read']));
      expect(defaults.body.mfaRequiredPermissions).not.toContain('employee.read');
      await query(db.superuserUrl, 'insert into security_policy (company_id, mfa_enforced) values ($1, false)', [COMPANY_A]);
    });
  });

  // ---------------------------------------------------------------------------------------------------------
  describe('disable and admin reset', () => {
    it('disable (not required): needs a current code; afterwards login needs no second factor', async () => {
      await enroll(USERS.target.email, USERS.target.id);
      const b = browser();
      await passwordStep(b, USERS.target.email);
      await b.post('/api/auth/mfa/verify', { code: code(USERS.target.id) });
      expect(typeOf(await b.post('/api/me/mfa/disable', { code: '000000' }))).toBe(PROBLEM('mfa-invalid'));
      expect((await b.post('/api/me/mfa/disable', { code: code(USERS.target.id) })).status).toBe(204);
      expect((await b.get('/api/me/mfa')).body).toEqual({ enabled: false, required: false, enrolledAt: null, recoveryCodesLeft: null });
      expect(await events('auth.mfa_disabled', USERS.target.id)).toHaveLength(1);
      expect((await browser().login(USERS.target.email, DEMO_PASSWORD)).status).toBe(204);
      expect(typeOf(await b.post('/api/me/mfa/disable', { code: code(USERS.target.id) }))).toBe(PROBLEM('mfa-not-enabled'));
    });

    it('reset: access.grant over the user (404 outside the scope, 403 without it), never oneself (409); removes the factor, revokes sessions, mails, audits', async () => {
      const { b: estSession } = await enroll(USERS.target.email, USERS.target.id);
      expect((await estSession.get('/api/me')).status).toBe(200);
      // scope: admin_acces (REG-EST) cannot see lecture.ouest (REG-OUEST) → 404; lecture has no access.grant → 403
      expect((await as(app, 'acces', xsrf).post(`/api/access/users/${USERS.ouest.id}/mfa/reset`)).status).toBe(404);
      expect((await as(app, 'ouest', xsrf).post(`/api/access/users/${USERS.target.id}/mfa/reset`)).status).toBe(403);
      expect((await as(app, 'beta', xsrf).post(`/api/access/users/${USERS.target.id}/mfa/reset`)).status).toBe(404); // not a BETA member
      expect((await as(app, 'acces', xsrf).post('/api/access/users/not-a-uuid/mfa/reset')).status).toBe(404);
      const self = await as(app, 'acces', xsrf).post(`/api/access/users/${USERS.acces.id}/mfa/reset`);
      expect([self.status, self.body.type]).toEqual([409, PROBLEM('mfa-reset-self')]);

      mails.sent.length = 0;
      expect((await as(app, 'acces', xsrf).post(`/api/access/users/${USERS.target.id}/mfa/reset`)).status).toBe(204);
      expect(await query(db.superuserUrl, 'select 1 from auth.user_mfa where user_id = $1', [USERS.target.id])).toEqual([]);
      expect(await query(db.superuserUrl, 'select 1 from auth.mfa_recovery_code where user_id = $1', [USERS.target.id])).toEqual([]);
      const live = await query<{ revoke_reason: string | null }>(db.superuserUrl, 'select revoke_reason from auth.refresh_session where user_id = $1', [USERS.target.id]);
      expect(live.length).toBeGreaterThan(0);
      expect(live.every((s) => s.revoke_reason !== null)).toBe(true);
      expect(live.some((s) => s.revoke_reason === 'mfa_reset')).toBe(true);
      expect((await estSession.post('/api/auth/refresh')).status).toBe(401); // the session is gone
      expect(mails.sent).toEqual([expect.objectContaining({ to: USERS.target.email, subject: expect.stringMatching(/HRForce/) })]);
      expect(await events('auth.mfa_reset', USERS.target.id)).toEqual([expect.objectContaining({ actor_user_id: USERS.acces.id, data: { hadMfa: true } })]);
      // next login: password only
      expect((await browser().login(USERS.target.email, DEMO_PASSWORD)).status).toBe(204);
    });
  });

  // ---------------------------------------------------------------------------------------------------------
  describe('database privileges', () => {
    it('hrforce_app cannot read or write the MFA tables; the functions only act for the transaction’s own user', async () => {
      for (const table of ['user_mfa', 'mfa_recovery_code', 'mfa_challenge']) {
        await expect(query(db.appUrl, `select * from auth.${table} limit 1`)).rejects.toThrow(/permission denied/);
        await expect(query(db.appUrl, `delete from auth.${table}`)).rejects.toThrow(/permission denied/);
      }
      await expect(query(db.appUrl, `select * from auth.mfa_own_secret('${USERS.est.id}')`)).rejects.toThrow(/not the current user/);
      await expect(query(db.appUrl, `select * from auth.mfa_status('${USERS.est.id}')`)).rejects.toThrow(/not the current user/);
      await expect(query(db.appUrl, `select auth.mfa_store_recovery_codes('${USERS.est.id}', '{}')`)).rejects.toThrow(/permission denied/);
      // a challenge id is needed to read a secret at login time
      expect(await query(db.appUrl, `select * from auth.mfa_challenge_open(gen_random_uuid(), '${USERS.est.id}')`)).toEqual([]);
      await expect(query(db.appUrl, `select * from auth.mfa_reset('${USERS.est.id}')`)).rejects.toThrow(/refused/);
      await expect(query(db.workerUrl, 'select * from auth.user_mfa')).rejects.toThrow(/permission denied/);
    });
  });
});
