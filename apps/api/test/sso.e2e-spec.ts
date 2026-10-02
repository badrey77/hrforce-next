/**
 * SSO (docs/contracts/sso.md, ADR 007): HRForce as an OpenID Connect provider, end to end. The API listens on a real
 * ephemeral port (WEB_BASE_URL = http://127.0.0.1:<port>, issuer …/oidc); the relying party is openid-client 6 with
 * allowInsecureRequests; the "browser" is a scripted cookie jar that stops at /sso/<uid> (no Angular here) and calls
 * the /api/sso/interactions/<uid>/* routes itself, like the web page does.
 */
import { createHash, createPrivateKey, createSign } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { pino } from 'pino';
import * as client from 'openid-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { base32Decode, DEMO_PASSWORD, hotp, MfaClock, totpStep } from '../src/modules/identity/index.js';
import {
  deriveOidcKeys,
  ensureCurrentKey,
  listKeys,
  loadSigningKeys,
  oidcOpen,
  promoteKey,
  pruneKeys,
  seedSsoClient,
  SsoClock,
  stageKey,
} from '../src/modules/sso/index.js';
import { DEV_OIDC_KEY } from '../src/platform/config/env.schema.js';
import { createDatabase, type Database } from '../src/platform/db/database.js';
import { oidcCleanupTask } from '../src/worker/tasks.js';
import { as, COMPANY_A, COMPANY_B, seedAccessFixture, USERS } from './support/access-fixture.js';
import { assertNoSecrets } from './support/assert-no-secrets.js';
import { freePort, OidcBrowser } from './support/oidc-browser.js';
import { createTestApp } from './support/test-app.js';
import { createTestDatabase, query, type TestDatabase } from './support/test-database.js';
import { fetchXsrf, type XsrfPair } from './support/xsrf.js';

const RP = 'http://localhost:4300';
const CALLBACK = `${RP}/callback`;
const SIGNED_OUT = `${RP}/signed-out`;
const SECRET = 'sso-test-secret-0123456789-abcdefghijklmnop';
const BETA_SECRET = 'beta-app-secret-0123456789-abcdefghijklmnop';
const SCOPE = 'openid profile email hrforce';
const ids = { client: '0190a5d0-0000-7000-8000-000000000d01', operator: '0190a5d0-0000-7000-8000-000000000d11', supervisor: '0190a5d0-0000-7000-8000-000000000d12' };
const betaIds = { client: '0190a5d0-0000-7000-8000-000000000d21', viewer: '0190a5d0-0000-7000-8000-000000000d22' };

const clock = { now: Date.now() };
const skew = { ms: 0 };
const totp = new Map<string, Buffer>();
const nextCode = (userId: string) => {
  clock.now += 30_000;
  return hotp(totp.get(userId) ?? Buffer.alloc(0), totpStep(clock.now));
};

let db: TestDatabase;
let app: NestExpressApplication;
let base: string;
let issuer: string;
let config: client.Configuration;
let xsrf: XsrfPair;
let appDb: Database;
let migrator: Database;

interface Pending {
  uid: string;
  verifier: string;
  state: string;
  nonce: string;
}

async function discover(clientId: string, secret: string): Promise<client.Configuration> {
  return client.discovery(new URL(issuer), clientId, undefined, client.ClientSecretBasic(secret), { execute: [client.allowInsecureRequests] });
}

/** RP → /oidc/auth → interaction entry → /sso/<uid>; returns the uid and the RP's PKCE/state/nonce. */
async function start(b: OidcBrowser, extra: Record<string, string> = {}, cfg = config): Promise<Pending> {
  const verifier = client.randomPKCECodeVerifier();
  const state = client.randomState();
  const nonce = client.randomNonce();
  const url = client.buildAuthorizationUrl(cfg, {
    redirect_uri: CALLBACK,
    scope: SCOPE,
    code_challenge: await client.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    state,
    nonce,
    ...extra,
  });
  const auth = await b.go(url.href);
  expect(auth.status, await auth.clone().text()).toBe(303);
  const entry = auth.headers.get('location') ?? '';
  expect(entry).toMatch(/^\/api\/sso\/interactions\/[\w-]+$/);
  const handoff = await b.go(entry);
  expect(handoff.status).toBe(303);
  const location = handoff.headers.get('location') ?? '';
  expect(location).toMatch(/^\/sso\/[\w-]+$/);
  return { uid: location.slice('/sso/'.length), verifier, state, nonce };
}

/** The resume redirect chain until the RP callback (not fetched). */
async function resume(b: OidcBrowser, redirectTo: string): Promise<URL> {
  const { url } = await b.follow(redirectTo, [RP]);
  return new URL(url);
}

async function exchange(callback: URL, p: Pending, cfg = config) {
  return client.authorizationCodeGrant(cfg, callback, { pkceCodeVerifier: p.verifier, expectedState: p.state, expectedNonce: p.nonce, idTokenExpected: true });
}

async function complete(b: OidcBrowser, uid: string): Promise<Response> {
  return b.api('POST', `/api/sso/interactions/${uid}/complete`);
}

/** A full silent sign-in in a jar that is already signed in to HRForce. */
async function signIn(b: OidcBrowser, cfg = config, extra: Record<string, string> = {}) {
  const p = await start(b, extra, cfg);
  const done = await complete(b, p.uid);
  expect(done.status, await done.clone().text()).toBe(200);
  const callback = await resume(b, ((await done.json()) as { redirectTo: string }).redirectTo);
  const tokens = await exchange(callback, p, cfg);
  return { p, callback, tokens, claims: tokens.claims() as Record<string, unknown> };
}

async function browserFor(email: string): Promise<OidcBrowser> {
  const b = new OidcBrowser(base);
  const res = await b.login(email, DEMO_PASSWORD);
  expect([200, 204]).toContain(res.status);
  return b;
}

function tokenRequest(auth: string, body: string, ip = '127.0.0.1'): Promise<Response> {
  return fetch(`${issuer}/token`, {
    method: 'POST',
    headers: { authorization: `Basic ${Buffer.from(auth).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': ip },
    body,
  });
}

const BAD_CODE_BODY = `grant_type=authorization_code&code=nope&redirect_uri=${encodeURIComponent(CALLBACK)}&code_verifier=${'a'.repeat(43)}`;
const html = { accept: 'text/html' };
const authUrl = (params: Record<string, string>) => `${issuer}/auth?${new URLSearchParams({ client_id: 'sso-test', response_type: 'code', scope: SCOPE, redirect_uri: CALLBACK, code_challenge: 'a'.repeat(43), code_challenge_method: 'S256', state: 'st', ...params })}`;
const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const admin = () => as(app, 'admin', xsrf);

beforeAll(async () => {
  db = await createTestDatabase();
  await seedAccessFixture(db, undefined, { leave: true });
  migrator = createDatabase({ connectionString: db.migratorUrl, maxConnections: 2 });
  await migrator.transaction().execute(async (tx) => {
    await seedSsoClient(tx, {
      id: ids.client,
      companyId: COMPANY_A,
      clientId: 'sso-test',
      name: 'App test',
      nameAr: 'تطبيق اختبار',
      secret: SECRET,
      redirectUris: [CALLBACK],
      postLogoutRedirectUris: [SIGNED_OUT],
      roles: [
        { id: ids.operator, code: 'operator', names: { fr: 'Opérateur', ar: 'التشغيل', en: 'Operator' } },
        { id: ids.supervisor, code: 'supervisor', names: { fr: 'Superviseur', ar: 'الإشراف', en: 'Supervisor' } },
      ],
      assignments: [
        { roleCode: 'operator', userId: USERS.agent.id, assignedBy: USERS.admin.id },
        { roleCode: 'supervisor', userId: USERS.chef.id, assignedBy: USERS.admin.id },
      ],
    });
    await seedSsoClient(tx, {
      id: betaIds.client,
      companyId: COMPANY_B,
      clientId: 'beta-app',
      name: 'Beta app',
      nameAr: null,
      secret: BETA_SECRET,
      redirectUris: [CALLBACK],
      postLogoutRedirectUris: [],
      roles: [{ id: betaIds.viewer, code: 'viewer', names: { fr: 'Lecteur', ar: 'اطلاع', en: 'Viewer' } }],
      assignments: [{ roleCode: 'viewer', userId: USERS.beta.id, assignedBy: null }],
    });
  });
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  issuer = `${base}/oidc`;
  app = await createTestApp(db, {
    devAuth: true,
    devPermissions: false,
    env: { WEB_BASE_URL: base, TRUST_PROXY_HOPS: '1' },
    overrides: [
      { provide: MfaClock, useValue: { nowMs: () => clock.now } },
      { provide: SsoClock, useValue: { nowMs: () => Date.now() + skew.ms } },
    ],
  });
  await app.listen(port, '127.0.0.1');
  config = await discover('sso-test', SECRET);
  xsrf = await fetchXsrf(app);
  appDb = createDatabase({ connectionString: db.appUrl, maxConnections: 2 });
  // agent.annaba enrolls a TOTP factor (two-step sign-in in the middle of the handoff)
  const agent = await browserFor(USERS.agent.email);
  const enroll = (await (await agent.api('POST', '/api/me/mfa/enroll/start')).json()) as { secret: string };
  totp.set(USERS.agent.id, base32Decode(enroll.secret) ?? Buffer.alloc(0));
  const confirm = await agent.api('POST', '/api/me/mfa/enroll/confirm', { code: nextCode(USERS.agent.id) });
  expect(confirm.status).toBe(200);
}, 180_000);

afterAll(async () => {
  await app?.close();
  await appDb?.destroy();
  await migrator?.destroy();
  await db?.drop();
});

describe('SSO: discovery and keys', () => {
  it('discovery advertises the contract (code + PKCE S256, RS256, query only, logout, iss)', async () => {
    const meta = config.serverMetadata();
    expect(meta.issuer).toBe(issuer);
    expect(meta.code_challenge_methods_supported).toEqual(['S256']);
    expect(meta.grant_types_supported).toEqual(['authorization_code']);
    expect(meta.response_types_supported).toEqual(['code']);
    expect(meta.response_modes_supported).toEqual(['query']);
    expect(meta.id_token_signing_alg_values_supported).toEqual(['RS256']);
    expect(meta.token_endpoint_auth_methods_supported).toEqual(['client_secret_basic', 'client_secret_post']);
    expect(meta.end_session_endpoint).toBe(`${issuer}/session/end`);
    expect(meta.authorization_response_iss_parameter_supported).toBe(true);
    expect(meta.scopes_supported).toEqual(['openid', 'profile', 'email', 'hrforce']);
    for (const disabled of ['registration_endpoint', 'introspection_endpoint', 'revocation_endpoint', 'pushed_authorization_request_endpoint']) {
      expect(meta[disabled as keyof typeof meta], disabled).toBeUndefined();
    }
  });

  it('JWKS publishes public keys only; the first boot created exactly one current key, sealed at rest', async () => {
    const jwks = (await (await fetch(`${issuer}/jwks`)).json()) as { keys: Record<string, unknown>[] };
    expect(jwks.keys.length).toBeGreaterThanOrEqual(1);
    for (const key of jwks.keys) {
      expect(key).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig' });
      for (const member of ['d', 'p', 'q', 'dp', 'dq', 'qi']) expect(key[member]).toBeUndefined();
    }
    const rows = await query<{ kid: string; status: string; jwk: string }>(db.superuserUrl, `select kid, status, encode(jwk_enc, 'escape') as jwk from oidc.signing_key`);
    expect(rows.filter((r) => r.status === 'current')).toHaveLength(1);
    for (const r of rows) expect(r.jwk).not.toContain('"d"');
  });

  it('two processes booting on an empty key table create one key (advisory lock)', async () => {
    const aead = deriveOidcKeys(Buffer.from(DEV_OIDC_KEY, 'base64')).aead;
    const scratch = await createTestDatabase();
    const a = createDatabase({ connectionString: scratch.appUrl, maxConnections: 1 });
    const b = createDatabase({ connectionString: scratch.appUrl, maxConnections: 1 });
    try {
      const created = await Promise.all([ensureCurrentKey(a, aead), ensureCurrentKey(b, aead), ensureCurrentKey(a, aead)]);
      expect(created.filter((k) => k !== null)).toHaveLength(1);
      expect((await listKeys(a)).map((k) => k.status)).toEqual(['current']);
    } finally {
      await a.destroy();
      await b.destroy();
      await scratch.drop();
    }
  });
});

describe('SSO: sign-in round trip', () => {
  it('code + PKCE with two-step sign-in in the middle; ID token = identity + this app’s roles; userinfo = same claims', async () => {
    const b = new OidcBrowser(base);
    const p = await start(b);
    const details = await b.api('GET', `/api/sso/interactions/${p.uid}/details`);
    expect(details.status).toBe(200);
    const view = (await details.json()) as Record<string, unknown>;
    expect(view).toEqual({ uid: p.uid, client: { clientId: 'sso-test', name: 'App test', nameAr: 'تطبيق اختبار' }, freshLoginRequired: false });
    assertNoSecrets(view);
    await b.api('GET', '/api/auth/csrf');
    expect((await complete(b, p.uid)).status).toBe(401); // signed out → the web sends the user to /login
    const login = await b.login(USERS.agent.email, DEMO_PASSWORD);
    expect(login.status).toBe(200);
    expect(await login.json()).toEqual({ mfaRequired: true });
    const loginAt = Date.now();
    expect((await b.api('POST', '/api/auth/mfa/verify', { code: nextCode(USERS.agent.id) })).status).toBe(204);
    const done = await complete(b, p.uid);
    expect(done.status).toBe(200);
    expect(done.headers.get('cache-control')).toBe('no-store');
    const body = (await done.json()) as { redirectTo: string };
    expect(body.redirectTo).toBe(`${issuer}/auth/${p.uid}`);
    const callback = await resume(b, body.redirectTo);
    expect(callback.origin + callback.pathname).toBe(CALLBACK);
    expect(callback.searchParams.get('code')).toBeTruthy();
    expect(callback.searchParams.get('state')).toBe(p.state);
    expect(callback.searchParams.get('iss')).toBe(issuer);
    const tokens = await exchange(callback, p);
    expect(tokens.refresh_token).toBeUndefined();
    expect(tokens.expires_in).toBe(300);
    const claims = tokens.claims() as Record<string, unknown>;
    expect(claims).toMatchObject({
      sub: USERS.agent.id,
      aud: 'sso-test',
      iss: issuer,
      nonce: p.nonce,
      email: USERS.agent.email,
      email_verified: true,
      preferred_username: USERS.agent.email,
      roles: ['operator'],
      company: { id: COMPANY_A, code: 'DEMO' },
      employee: { matricule: 'EMP-0030', active: true },
    });
    expect((claims['employee'] as { unit: { code: string } | null }).unit?.code).toBe('AG-ANNABA');
    expect(claims['amr']).toEqual(['pwd', 'otp', 'mfa']);
    expect(Math.abs((claims['auth_time'] as number) * 1000 - loginAt)).toBeLessThan(5_000);
    expect(claims['sid']).toBeUndefined();
    const userinfo = await client.fetchUserInfo(config, tokens.access_token, USERS.agent.id);
    for (const key of ['sub', 'name', 'email', 'email_verified', 'preferred_username', 'locale', 'company', 'employee', 'roles']) {
      expect(userinfo[key], key).toEqual(claims[key]);
    }
    // sso.sign_in audited in the client's company, without tokens
    const events = await query<{ data: Record<string, unknown> }>(db.superuserUrl, `select data from audit.event where type = 'sso.sign_in' and subject_id = $1 and company_id = $2`, [USERS.agent.id, COMPANY_A]);
    expect(events.at(-1)?.data).toMatchObject({ clientId: 'sso-test', clientName: 'App test', amr: ['pwd', 'otp', 'mfa'] });
    // no bearer value at rest
    const store = await query<{ model: string; payload: string }>(db.superuserUrl, `select model, payload::text as payload from oidc.model_store`);
    const code = callback.searchParams.get('code') ?? '';
    for (const row of store) {
      // no `jti` FIELD (the id); its name stays in `__idFields` so that `find` can restore it (oidc-adapter.ts)
      expect(Object.keys(JSON.parse(row.payload) as object), `${row.model} ${row.payload}`).not.toContain('jti');
      expect(row.payload).not.toContain(code);
      expect(row.payload).not.toContain(tokens.access_token);
    }
    const all = JSON.stringify(await query(db.superuserUrl, `select data from audit.event union all select coalesce(after, before) from audit.change_log`));
    for (const leaked of [code, tokens.access_token, tokens.id_token ?? '', p.verifier, SECRET]) expect(all).not.toContain(leaked);
    // the second sign-in in the same browser is silent (HRForce session = SSO session) and goes through the handoff again
    const second = await signIn(b);
    expect(second.claims['sub']).toBe(USERS.agent.id);
    const grants = await query<{ n: number }>(db.superuserUrl, `select count(*)::int as n from oidc.model_store where model = 'Grant'`);
    expect(grants[0]?.n).toBeLessThanOrEqual(2);
  });

  it('roles: [] for a member without a role (Arabic locale), employee: null for a user not linked', async () => {
    const est = await signIn(await browserFor(USERS.est.email));
    expect(est.claims).toMatchObject({ sub: USERS.est.id, roles: [], locale: 'ar', employee: { matricule: 'EMP-0022' }, amr: ['pwd'] });
    const rhAdmin = await signIn(await browserFor(USERS.admin.email));
    expect(rhAdmin.claims).toMatchObject({ roles: [], employee: null });
    const chef = await signIn(await browserFor(USERS.chef.email));
    expect(chef.claims['roles']).toEqual(['supervisor']);
  });

  it('prompt=none → login_required; abort → access_denied', async () => {
    const b = await browserFor(USERS.chef.email);
    const verifier = client.randomPKCECodeVerifier();
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: CALLBACK,
      scope: SCOPE,
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      state: 's1',
      prompt: 'none',
    });
    const none = await b.follow(url.href, [RP]);
    expect(new URL(none.url).searchParams.get('error')).toBe('login_required');
    const p = await start(b);
    const abort = await b.api('POST', `/api/sso/interactions/${p.uid}/abort`);
    expect(abort.status).toBe(200);
    const callback = await resume(b, ((await abort.json()) as { redirectTo: string }).redirectTo);
    expect(callback.searchParams.get('error')).toBe('access_denied');
    expect(callback.searchParams.get('state')).toBe(p.state);
  });
});

describe('SSO: interaction binding and session checks', () => {
  it('another browser (signed in, no interaction cookie), a tampered cookie signature, a missing resume cookie, an expired interaction', async () => {
    const victim = await browserFor(USERS.chef.email);
    const p = await start(victim);
    const attacker = await browserFor(USERS.admin.email);
    expect((await attacker.api('GET', `/api/sso/interactions/${p.uid}/details`)).status).toBe(404);
    expect((await complete(attacker, p.uid)).status).toBe(404);
    const tampered = new OidcBrowser(base);
    tampered.jar.copyFrom(victim.jar);
    const sig = tampered.jar.find('hrf_op_interaction.sig')[0];
    expect(sig).toBeDefined();
    tampered.jar.cookies.set(`hrf_op_interaction.sig|${sig?.path}`, { name: 'hrf_op_interaction.sig', value: `x${sig?.value.slice(1)}`, path: sig?.path ?? '/' });
    expect((await tampered.api('GET', `/api/sso/interactions/${p.uid}/details`)).status).toBe(404);
    // the right browser completes, but resuming without hrf_op_resume is an error page
    const done = await complete(victim, p.uid);
    const noResume = new OidcBrowser(base);
    const r = await noResume.go(((await done.json()) as { redirectTo: string }).redirectTo, { headers: html });
    expect(r.status).toBe(400);
    expect(r.headers.get('location')).toBeNull();
    expect(await r.text()).toContain('Connexion impossible');
    // an expired interaction
    const q = await start(victim);
    await query(db.superuserUrl, `update oidc.model_store set expires_at = now() - interval '1 second' where model = 'Interaction'`);
    const expired = await victim.api('GET', `/api/sso/interactions/${q.uid}/details`);
    expect(expired.status).toBe(404);
    expect(((await expired.json()) as { type: string }).type).toBe('urn:hrforce:problem:sso-interaction-not-found');
    expect((await victim.go('/api/sso/interactions/not-a-uid!')).status).toBe(404);
  });

  it('a revoked family → 401 session-expired; a disabled account → 403; another company → 403 sso-not-member; DEV_AUTH identity → 401', async () => {
    const b = await browserFor(USERS.chef.email);
    let p = await start(b);
    await query(db.superuserUrl, `update auth.refresh_session set revoked_at = now(), revoke_reason = 'logout' where user_id = $1 and revoked_at is null`, [USERS.chef.id]);
    const revoked = await complete(b, p.uid);
    expect(revoked.status).toBe(401);
    expect(((await revoked.json()) as { type: string }).type).toBe('urn:hrforce:problem:session-expired');

    const target = await browserFor(USERS.target.email);
    p = await start(target);
    await query(db.superuserUrl, `update auth.user_account set status = 'disabled' where id = $1`, [USERS.target.id]);
    try {
      const disabled = await complete(target, p.uid);
      expect(disabled.status).toBe(403);
      expect(((await disabled.json()) as { type: string }).type).toBe('urn:hrforce:problem:account-disabled');
    } finally {
      await query(db.superuserUrl, `update auth.user_account set status = 'active' where id = $1`, [USERS.target.id]);
    }

    // a DEMO user on BETA's app; BETA's admin on DEMO's app
    const est = await browserFor(USERS.est.email);
    const betaConfig = await discover('beta-app', BETA_SECRET);
    p = await start(est, {}, betaConfig);
    const notMember = await complete(est, p.uid);
    expect(notMember.status).toBe(403);
    expect(((await notMember.json()) as { type: string }).type).toBe('urn:hrforce:problem:sso-not-member');
    const beta = await browserFor(USERS.beta.email);
    p = await start(beta);
    expect((await complete(beta, p.uid)).status).toBe(403);
    // BETA's admin on BETA's own app: roles of that app only
    const own = await signIn(beta, betaConfig);
    expect(own.claims).toMatchObject({ roles: ['viewer'], company: { code: 'BETA' }, employee: null });

    // a header identity has no HRForce session
    const anon = new OidcBrowser(base);
    p = await start(anon);
    await anon.api('GET', '/api/auth/csrf');
    const dev = await anon.api('POST', `/api/sso/interactions/${p.uid}/complete`, undefined, { 'x-dev-user-id': USERS.admin.id, 'x-dev-company-id': COMPANY_A });
    expect(dev.status).toBe(401);
    expect(((await dev.json()) as { type: string }).type).toBe('urn:hrforce:problem:session-expired');
  });

  it('two-step sign-in required but not enrolled → 403 mfa-enrollment-required', async () => {
    await query(db.superuserUrl, `update security_policy set mfa_enforced = true, mfa_required_permissions = '{org_unit.read}' where company_id = $1`, [COMPANY_A]);
    try {
      const b = await browserFor(USERS.ouest.email);
      const p = await start(b);
      const res = await complete(b, p.uid);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { type: string }).type).toBe('urn:hrforce:problem:mfa-enrollment-required');
    } finally {
      await query(db.superuserUrl, `update security_policy set mfa_enforced = false where company_id = $1`, [COMPANY_A]);
    }
  });

  it('fresh login: prompt=login and max_age', async () => {
    const b = await browserFor(USERS.chef.email);
    await new Promise((r) => setTimeout(r, 1100)); // the login is now strictly older than the interaction (seconds)
    const p = await start(b, { prompt: 'login' });
    expect(((await (await b.api('GET', `/api/sso/interactions/${p.uid}/details`)).json()) as { freshLoginRequired: boolean }).freshLoginRequired).toBe(true);
    const refused = await complete(b, p.uid);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { type: string }).type).toBe('urn:hrforce:problem:sso-fresh-login-required');
    await new Promise((r) => setTimeout(r, 1100));
    await b.login(USERS.chef.email, DEMO_PASSWORD);
    const ok = await complete(b, p.uid);
    expect(ok.status).toBe(200);
    expect((await exchange(await resume(b, ((await ok.json()) as { redirectTo: string }).redirectTo), p)).claims()?.sub).toBe(USERS.chef.id);
    skew.ms = 120_000;
    try {
      const q = await start(b, { max_age: '60' });
      expect((await complete(b, q.uid)).status).toBe(409);
    } finally {
      skew.ms = 0;
    }
  });
});

describe('SSO: protocol refusals', () => {

  it('unregistered redirect_uri → 400 page and no redirect; PKCE required (S256 only); form_post → 400 page; unknown client → 400 page', async () => {
    const b = new OidcBrowser(base);
    const evil = await b.go(authUrl({ redirect_uri: 'https://evil.example/cb' }), { headers: html });
    expect(evil.status).toBe(400);
    expect(evil.headers.get('location')).toBeNull();
    expect(evil.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const page = await evil.text();
    expect(page).toContain('Connexion impossible');
    expect(page).toContain('تعذّر تسجيل الدخول');
    for (const params of [{ code_challenge: '' }, { code_challenge_method: 'plain' }] as Record<string, string>[]) {
      const url = new URL(authUrl(params));
      if (params.code_challenge === '') {
        url.searchParams.delete('code_challenge');
        url.searchParams.delete('code_challenge_method');
      }
      const res = await b.go(url.href);
      expect(res.status).toBe(303);
      expect(new URL(res.headers.get('location') ?? '').searchParams.get('error')).toBe('invalid_request');
    }
    expect((await b.go(authUrl({ response_mode: 'form_post' }), { headers: html })).status).toBe(400);
    expect((await b.go(authUrl({ client_id: 'nobody' }), { headers: html })).status).toBe(400);
  });

  it('token endpoint: wrong secret 401, replayed code / wrong verifier / wrong redirect_uri invalid_grant, other grant types refused; disabled endpoints 404; foreign Host 400', async () => {
    const wrong = await tokenRequest('sso-test:wrong', BAD_CODE_BODY);
    expect(wrong.status).toBe(401);
    expect(((await wrong.json()) as { error: string }).error).toBe('invalid_client');
    const b = await browserFor(USERS.chef.email);
    const run = async () => {
      const p = await start(b);
      const done = await complete(b, p.uid);
      return { p, callback: await resume(b, ((await done.json()) as { redirectTo: string }).redirectTo) };
    };
    const ok = await run();
    await exchange(ok.callback, ok.p);
    const code = ok.callback.searchParams.get('code') ?? '';
    const replay = await tokenRequest(`sso-test:${SECRET}`, `grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(CALLBACK)}&code_verifier=${ok.p.verifier}`);
    expect(((await replay.json()) as { error: string }).error).toBe('invalid_grant');
    const verifier = await run();
    const v = await tokenRequest(`sso-test:${SECRET}`, `grant_type=authorization_code&code=${verifier.callback.searchParams.get('code')}&redirect_uri=${encodeURIComponent(CALLBACK)}&code_verifier=${'b'.repeat(43)}`);
    expect(((await v.json()) as { error: string }).error).toBe('invalid_grant');
    const redirect = await run();
    const rr = await tokenRequest(`sso-test:${SECRET}`, `grant_type=authorization_code&code=${redirect.callback.searchParams.get('code')}&redirect_uri=${encodeURIComponent(`${RP}/other`)}&code_verifier=${redirect.p.verifier}`);
    expect(((await rr.json()) as { error: string }).error).toBe('invalid_grant');
    for (const grant of ['refresh_token&refresh_token=x', 'client_credentials']) {
      const res = await tokenRequest(`sso-test:${SECRET}`, `grant_type=${grant}`);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('unsupported_grant_type');
    }
    for (const path of ['/reg', '/token/introspection', '/token/revocation', '/request', '/device/auth']) expect((await fetch(`${issuer}${path}`, { method: 'POST' })).status, path).toBe(404);
    const foreign = await fetch(`${issuer}/.well-known/openid-configuration`, { headers: { 'x-forwarded-host': 'evil.example' } });
    expect(foreign.status).toBe(400);
  });

  it('throttle: 20 failed client authentications from one IP → 429 with Retry-After, even with the right secret; only invalid_client counts', async () => {
    const ip = '10.9.9.9';
    await tokenRequest(`sso-test:${SECRET}`, BAD_CODE_BODY, ip); // invalid_grant: not counted
    for (let i = 0; i < 20; i++) expect((await tokenRequest('sso-test:wrong', BAD_CODE_BODY, ip)).status).toBe(401);
    const blocked = await tokenRequest('sso-test:wrong', BAD_CODE_BODY, ip);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(800);
    expect(await blocked.json()).toEqual({ error: 'temporarily_unavailable', error_description: 'too many failed client authentications' });
    expect((await tokenRequest(`sso-test:${SECRET}`, BAD_CODE_BODY, ip)).status).toBe(429);
    expect((await tokenRequest(`sso-test:${SECRET}`, BAD_CODE_BODY, '10.9.9.10')).status).toBe(400);
    const rows = await query<{ n: number; c: string }>(db.superuserUrl, `select count(*)::int as n, min(client_id) as c from oidc.client_auth_failure where ip = $1`, [ip]);
    expect(rows[0]).toEqual({ n: 20, c: 'sso-test' });
  });
});

describe('SSO: logout', () => {
  it('RP-initiated logout ends the provider session AND the HRForce session (expectedUserId guard)', async () => {
    const b = await browserFor(USERS.chef.email);
    const { tokens } = await signIn(b);
    const page = await b.go(`${issuer}/session/end?${new URLSearchParams({ id_token_hint: tokens.id_token ?? '', post_logout_redirect_uri: SIGNED_OUT, state: 'bye' })}`);
    expect(page.status).toBe(200);
    const csp = page.headers.get('content-security-policy') ?? '';
    expect(csp).toMatch(/form-action 'self' http:\/\/localhost:4300/);
    expect(csp).toContain("frame-ancestors 'none'");
    const text = await page.text();
    expect(text).toContain('data-mode="auto"');
    expect(text).toContain(`data-sub="${USERS.chef.id}"`);
    expect([...text.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)]).toHaveLength(0);
    const formXsrf = /name="xsrf" value="([^"]+)"/.exec(text)?.[1] ?? '';
    const script = await b.go('/oidc/assets/end-session.js');
    expect(script.headers.get('content-type')).toMatch(/^text\/javascript/);
    expect(script.headers.get('x-content-type-options')).toBe('nosniff');
    // a logout for ANOTHER user changes nothing (no revocation, cookies untouched)
    await b.api('GET', '/api/auth/csrf');
    const mismatch = await b.api('POST', '/api/auth/logout', { expectedUserId: USERS.admin.id });
    expect(mismatch.status).toBe(204);
    expect(mismatch.headers.getSetCookie()).toEqual([]);
    expect((await b.api('GET', '/api/me')).status).toBe(200);
    expect((await b.api('POST', '/api/auth/logout', { other: 1 })).status).toBe(422);
    // the page's script: logout with the hint's sub, then the provider's confirm form
    const logout = await b.api('POST', '/api/auth/logout', { expectedUserId: USERS.chef.id });
    expect(logout.status).toBe(204);
    // this browser's HRForce session is gone (its refresh family was revoked)
    expect((await b.api('POST', '/api/auth/refresh')).status).toBe(401);
    expect((await query(db.superuserUrl, `select 1 from audit.event where type = 'auth.logout' and subject_id = $1`, [USERS.chef.id])).length).toBeGreaterThan(0);
    const confirm = await b.go(`${issuer}/session/end/confirm`, { method: 'POST', body: `xsrf=${formXsrf}&logout=yes`, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(confirm.status).toBe(303);
    expect(confirm.headers.get('location')).toBe(`${SIGNED_OUT}?state=bye`);
    await expect(client.fetchUserInfo(config, tokens.access_token, USERS.chef.id)).rejects.toThrow();
    expect(b.jar.get('hrf_op_session')).toBeUndefined();
  });

  it('no hint → confirm page; unregistered post_logout_redirect_uri → 400; an EXPIRED id_token_hint is still accepted', async () => {
    const b = new OidcBrowser(base);
    const confirm = await b.go(`${issuer}/session/end`);
    expect(confirm.status).toBe(200);
    const text = await confirm.text();
    expect(text).toContain('data-mode="confirm"');
    expect(text).toContain('Se déconnecter de HRForce ?');
    const chef = await browserFor(USERS.chef.email);
    const { tokens } = await signIn(chef);
    const bad = await chef.go(`${issuer}/session/end?${new URLSearchParams({ id_token_hint: tokens.id_token ?? '', post_logout_redirect_uri: 'https://evil.example/' })}`, { headers: html });
    expect(bad.status).toBe(400);
    // an expired hint signed with the current key
    const aead = deriveOidcKeys(Buffer.from(DEV_OIDC_KEY, 'base64')).aead;
    const current = (await listKeys(appDb)).find((k) => k.status === 'current');
    const jwk = JSON.parse(oidcOpen(aead, current?.jwkEnc ?? Buffer.alloc(0), current?.kid ?? '') ?? '{}') as import('node:crypto').JsonWebKey & { kid: string };
    const now = Math.floor(Date.now() / 1000);
    const input = `${part({ alg: 'RS256', kid: jwk.kid, typ: 'JWT' })}.${part({ iss: issuer, sub: USERS.chef.id, aud: 'sso-test', iat: now - 7200, exp: now - 3600 })}`;
    const signature = createSign('RSA-SHA256').update(input).sign(createPrivateKey({ key: jwk, format: 'jwk' })).toString('base64url');
    const old = await new OidcBrowser(base).go(`${issuer}/session/end?${new URLSearchParams({ id_token_hint: `${input}.${signature}`, post_logout_redirect_uri: SIGNED_OUT })}`);
    expect(old.status).toBe(200);
    expect(await old.text()).toContain(`data-sub="${USERS.chef.id}"`);
  });

  it('the account-switch step of resume runs under the CSP: its inline script hash is in the header, form-action allows the app', async () => {
    const b = await browserFor(USERS.chef.email);
    await signIn(b); // provider session of chef
    await b.login(USERS.est.email, DEMO_PASSWORD); // HRForce now signed in as rh.est
    const p = await start(b);
    const done = await complete(b, p.uid);
    const res = await b.go(((await done.json()) as { redirectTo: string }).redirectTo);
    expect(res.status).toBe(200);
    const page = await res.text();
    const script = /<script>([\s\S]*?)<\/script>/.exec(page)?.[1] ?? '';
    expect(script.length).toBeGreaterThan(0);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain(`'sha256-${createHash('sha256').update(script).digest('base64')}'`);
    expect(csp).toMatch(/form-action 'self' http:\/\/localhost:4300/);
  });
});

describe('SSO: administration', () => {
  it('validation codes, show-once secret, sealed at rest, client id unique across companies', async () => {
    const invalid = await admin().post('/api/sso/clients').send({
      clientId: 'Bad Id',
      name: '',
      nameAr: 'x'.repeat(81),
      redirectUris: ['http://app.example/cb', 'https://a.example/cb#f', 'https://a.example/x', 'https://a.example/x'],
      postLogoutRedirectUris: ['https://*.example/'],
      clientAuthMethod: 'none',
    });
    expect(invalid.status).toBe(422);
    expect((invalid.body.errors as { field: string; code: string }[]).map((e) => `${e.field}:${e.code}`)).toEqual([
      'clientId:invalid',
      'name:required',
      'nameAr:too_long',
      'redirectUris.0:insecure_uri',
      'redirectUris.1:invalid_uri',
      'redirectUris.3:duplicate',
      'postLogoutRedirectUris.0:invalid_uri',
      'clientAuthMethod:invalid',
    ]);
    expect((await admin().post('/api/sso/clients').send({ clientId: 'abc', name: 'A', redirectUris: [] })).body.errors).toEqual([expect.objectContaining({ field: 'redirectUris', code: 'required' })]);
    const created = await admin().post('/api/sso/clients').send({ clientId: 'rotate-me', name: ' Rotation ', redirectUris: [CALLBACK], postLogoutRedirectUris: [SIGNED_OUT] });
    expect(created.status).toBe(201);
    assertNoSecrets(created.body, ['$.clientSecret']);
    expect(created.body).toMatchObject({ clientId: 'rotate-me', name: 'Rotation', status: 'active', clientAuthMethod: 'client_secret_basic', issuer, roles: [], assignmentCount: 0 });
    expect(created.body.clientSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.body).toMatchObject({ _actions: ['update', 'rotate_secret', 'disable', 'add_role'] });
    const secret = created.body.clientSecret as string;
    const detail = await admin().get(`/api/sso/clients/${created.body.id}`).expect(200);
    expect(detail.body.clientSecret).toBeUndefined();
    assertNoSecrets(detail.body);
    assertNoSecrets((await admin().get('/api/sso/clients').expect(200)).body);
    const [row] = await query<{ secret_enc: Buffer }>(db.superuserUrl, `select secret_enc from sso_client where id = $1`, [created.body.id]);
    const aead = deriveOidcKeys(Buffer.from(DEV_OIDC_KEY, 'base64')).aead;
    expect(row?.secret_enc.includes(Buffer.from(secret))).toBe(false);
    expect(oidcOpen(aead, row?.secret_enc ?? Buffer.alloc(0), 'rotate-me')).toBe(secret);
    expect(oidcOpen(aead, row?.secret_enc ?? Buffer.alloc(0), 'sso-test')).toBeNull();
    // the new client works; rotation cuts the old secret at once
    expect((await tokenRequest(`rotate-me:${secret}`, BAD_CODE_BODY, '10.1.1.1')).status).toBe(400);
    const rotated = await admin().post(`/api/sso/clients/${created.body.id}/rotate-secret`).expect(200);
    assertNoSecrets(rotated.body, ['$.clientSecret']);
    expect((await tokenRequest(`rotate-me:${secret}`, BAD_CODE_BODY, '10.1.1.2')).status).toBe(401);
    expect((await tokenRequest(`rotate-me:${rotated.body.clientSecret as string}`, BAD_CODE_BODY, '10.1.1.3')).status).toBe(400);
    const masked = await query<{ after: Record<string, unknown> }>(db.superuserUrl, `select after from audit.change_log where table_name = 'sso_client' and row_id = $1 and op = 'update'`, [created.body.id]);
    expect(masked.at(-1)?.after['secret_enc']).toBe('***');
    expect((await query(db.superuserUrl, `select 1 from audit.event where type = 'sso.client_secret_rotated' and subject_id = $1`, [created.body.id])).length).toBe(1);
    // taken: in the company, and by another company
    const taken = await admin().post('/api/sso/clients').send({ clientId: 'rotate-me', name: 'Again', redirectUris: [CALLBACK] });
    expect([taken.status, taken.body.type, taken.body.errors]).toEqual([409, 'urn:hrforce:problem:sso-client-id-taken', [expect.objectContaining({ field: 'clientId', code: 'taken' })]]);
    const other = await as(app, 'beta', xsrf).post('/api/sso/clients').send({ clientId: 'sso-test', name: 'Copy', redirectUris: [CALLBACK] });
    expect(other.status).toBe(409);
    expect(other.body.detail).toMatch(/another company/);
    // PATCH: clientId immutable
    const patch = await admin().patch(`/api/sso/clients/${created.body.id}`).send({ clientId: 'renamed' });
    expect([patch.status, patch.body.errors?.[0]?.code]).toEqual([422, 'immutable']);
    expect((await admin().patch(`/api/sso/clients/${created.body.id}`).send({ nameAr: 'تدوير', clientAuthMethod: 'client_secret_post' }).expect(200)).body).toMatchObject({ nameAr: 'تدوير', clientAuthMethod: 'client_secret_post' });
  });

  it('disable / enable; a disabled client is unknown to the provider', async () => {
    const created = await admin().post('/api/sso/clients').send({ clientId: 'to-disable', name: 'Off', redirectUris: [CALLBACK] }).expect(201);
    const id = created.body.id as string;
    expect((await admin().post(`/api/sso/clients/${id}/disable`).send({ reason: 'x' })).body.errors?.[0]?.code).toBe('too_short');
    expect((await admin().post(`/api/sso/clients/${id}/disable`).send({ reason: 'Plus utilisée' }).expect(200)).body).toMatchObject({ status: 'disabled', disabledReason: 'Plus utilisée', _actions: ['update', 'enable', 'add_role'] });
    expect((await admin().post(`/api/sso/clients/${id}/disable`).send({ reason: 'Encore' })).body.type).toBe('urn:hrforce:problem:sso-client-disabled');
    const page = await new OidcBrowser(base).go(`${issuer}/auth?${new URLSearchParams({ client_id: 'to-disable', response_type: 'code', scope: SCOPE, redirect_uri: CALLBACK, code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' })}`, { headers: html });
    expect(page.status).toBe(400);
    expect((await tokenRequest(`to-disable:${created.body.clientSecret as string}`, BAD_CODE_BODY, '10.2.2.2')).status).toBe(401);
    expect((await admin().post(`/api/sso/clients/${id}/enable`).expect(200)).body.status).toBe('active');
    expect((await admin().post(`/api/sso/clients/${id}/enable`)).body.type).toBe('urn:hrforce:problem:sso-client-active');
    // a disabled client during the handoff → 409 sso-client-unavailable
    const b = await browserFor(USERS.chef.email);
    const p = await start(b);
    await query(db.superuserUrl, `update sso_client set status = 'disabled', disabled_at = now(), disabled_by = $1, disabled_reason = 'test' where client_id = 'sso-test'`, [USERS.admin.id]);
    try {
      const res = await b.api('GET', `/api/sso/interactions/${p.uid}/details`);
      expect([res.status, ((await res.json()) as { type: string }).type]).toEqual([409, 'urn:hrforce:problem:sso-client-unavailable']);
      expect((await complete(b, p.uid)).status).toBe(409);
    } finally {
      await query(db.superuserUrl, `update sso_client set status = 'active', disabled_at = null, disabled_by = null, disabled_reason = null where client_id = 'sso-test'`);
    }
  });

  it('roles and assignments: codes, in use, self-assignment refused, duplicates, audit events and the app timeline', async () => {
    const role = await admin().post(`/api/sso/clients/${ids.client}/roles`).send({ code: 'auditor', names: { fr: 'Auditeur', ar: 'تدقيق', en: 'Auditor' } });
    expect(role.status).toBe(201);
    expect(role.body).toMatchObject({ code: 'auditor', assignmentCount: 0, _actions: ['update', 'delete'] });
    expect((await admin().post(`/api/sso/clients/${ids.client}/roles`).send({ code: 'auditor', names: { fr: 'A', ar: 'ب', en: 'A' } })).body.type).toBe('urn:hrforce:problem:sso-role-code-taken');
    expect((await admin().post(`/api/sso/clients/${ids.client}/roles`).send({ code: 'Bad', names: { fr: '', ar: 'ب' } })).body.errors.map((e: { field: string; code: string }) => `${e.field}:${e.code}`)).toEqual([
      'code:invalid',
      'names.fr:required',
      'names.en:required',
    ]);
    expect((await admin().patch(`/api/sso/roles/${role.body.id}`).send({ code: 'x', names: { fr: 'A', ar: 'ب', en: 'A' } })).body.errors[0]).toMatchObject({ field: 'code', code: 'immutable' });
    expect((await admin().patch(`/api/sso/roles/${role.body.id}`).send({ names: { fr: 'Audit', ar: 'تدقيق', en: 'Audit' } }).expect(200)).body.names.fr).toBe('Audit');
    expect((await admin().post('/api/sso/assignments').send({ userId: USERS.admin.id, roleId: role.body.id })).body.type).toBe('urn:hrforce:problem:sso-assign-self');
    const bad = await admin().post('/api/sso/assignments').send({ userId: USERS.beta.id, roleId: betaIds.viewer });
    expect(bad.body.errors.map((e: { field: string; code: string }) => `${e.field}:${e.code}`)).toEqual(['userId:not_member', 'roleId:unknown']);
    const assigned = await admin().post('/api/sso/assignments').send({ userId: USERS.est.id, roleId: role.body.id });
    expect(assigned.status).toBe(201);
    expect(assigned.body).toMatchObject({ user: { id: USERS.est.id, email: USERS.est.email }, role: { code: 'auditor' }, client: { clientId: 'sso-test' }, assignedBy: { id: USERS.admin.id }, _actions: ['remove'] });
    assertNoSecrets(assigned.body);
    expect((await admin().post('/api/sso/assignments').send({ userId: USERS.est.id, roleId: role.body.id })).body.type).toBe('urn:hrforce:problem:sso-assignment-duplicate');
    expect((await admin().delete(`/api/sso/roles/${role.body.id}`)).body.type).toBe('urn:hrforce:problem:sso-role-in-use');
    // the claim follows at once
    expect((await signIn(await browserFor(USERS.est.email))).claims['roles']).toEqual(['auditor']);
    const list = await admin().get(`/api/sso/assignments?userId=${USERS.est.id}`).expect(200);
    expect(list.body.items.map((i: { role: { code: string } }) => i.role.code)).toEqual(['auditor']);
    expect((await admin().get('/api/sso/assignments?userId=nope')).status).toBe(422);
    // removing one's own assignment is refused (chef's supervisor assignment, seen by chef? chef holds no sso.assign — use admin's own by SQL)
    await query(db.superuserUrl, `insert into sso_role_assignment (company_id, sso_app_role_id, user_id) values ($1, $2, $3)`, [COMPANY_A, ids.supervisor, USERS.admin.id]);
    const own = (await admin().get(`/api/sso/assignments?userId=${USERS.admin.id}`).expect(200)).body.items[0] as { id: string };
    expect(own).toMatchObject({ _actions: [] });
    expect((await admin().delete(`/api/sso/assignments/${own.id}`)).body.type).toBe('urn:hrforce:problem:sso-assign-self');
    await admin().delete(`/api/sso/assignments/${assigned.body.id}`).expect(204);
    await admin().delete(`/api/sso/roles/${role.body.id}`).expect(204);
    const events = await query<{ type: string; data: Record<string, unknown> }>(db.superuserUrl, `select type, data from audit.event where type in ('sso.role_assigned', 'sso.role_removed') and subject_id = $1 order by at`, [USERS.est.id]);
    expect(events.map((e) => e.type)).toEqual(['sso.role_assigned', 'sso.role_removed']);
    expect(events[0]?.data).toMatchObject({ clientId: 'sso-test', roleCode: 'auditor', assignmentId: assigned.body.id });
    const timeline = await admin().get(`/api/audit/timeline?subject=sso_client:${ids.client}`).expect(200);
    const tables = new Set((timeline.body.items as { table?: string; event?: { type: string } }[]).map((i) => i.table ?? i.event?.type));
    for (const expected of ['sso_app_role', 'sso_role_assignment', 'sso.sign_in', 'sso.role_assigned']) expect(tables.has(expected), expected).toBe(true);
    const userTimeline = await admin().get(`/api/audit/timeline?subject=user:${USERS.est.id}`).expect(200);
    expect((userTimeline.body.items as { table?: string }[]).some((i) => i.table === 'sso_role_assignment')).toBe(true);
    expect((await as(app, 'est', xsrf).get(`/api/audit/timeline?subject=sso_client:${ids.client}`)).status).toBe(403);
    expect((await as(app, 'beta', xsrf).get(`/api/audit/timeline?subject=sso_client:${ids.client}`)).status).toBe(404);
  });
});

describe('SSO: key rotation, unavailability and cleanup', () => {
  it('stage / promote / prune change the published set and the signing kid (after a restart)', async () => {
    const aead = deriveOidcKeys(Buffer.from(DEV_OIDC_KEY, 'base64')).aead;
    const before = (await listKeys(migrator)).find((k) => k.status === 'current')?.kid;
    const staged = await stageKey(migrator, aead);
    await expect(promoteKey(migrator, { now: false })).rejects.toThrow(/24 h/);
    const promoted = await promoteKey(migrator, { now: true });
    expect(promoted).toEqual({ current: staged, retired: before });
    const port = await freePort();
    const restarted = await createTestApp(db, { devAuth: true, devPermissions: false, env: { WEB_BASE_URL: `http://127.0.0.1:${port}` } });
    await restarted.listen(port, '127.0.0.1');
    try {
      const jwks = (await (await fetch(`http://127.0.0.1:${port}/oidc/jwks`)).json()) as { keys: { kid: string }[] };
      expect(jwks.keys.map((k) => k.kid)).toEqual([staged, before]);
      const loaded = await loadSigningKeys(appDb, aead);
      expect(loaded.ok && loaded.signingKid).toBe(staged);
    } finally {
      await restarted.close();
    }
    expect(await pruneKeys(migrator, { now: true })).toEqual([before]);
  });

  it('a wrong OIDC_KEY: /oidc answers 503 while the rest of HRForce works', async () => {
    const port = await freePort();
    const broken = await createTestApp(db, { devAuth: true, devPermissions: false, env: { WEB_BASE_URL: `http://127.0.0.1:${port}`, OIDC_KEY: Buffer.alloc(32, 3).toString('base64') } });
    await broken.listen(port, '127.0.0.1');
    try {
      const res = await fetch(`http://127.0.0.1:${port}/oidc/.well-known/openid-configuration`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'temporarily_unavailable' });
      expect((await fetch(`http://127.0.0.1:${port}/api/health`)).status).toBe(200);
    } finally {
      await broken.close();
    }
  });

  it('oidc.cleanup (worker) deletes rows expired for more than a day and failures older than a day', async () => {
    await query(
      db.superuserUrl,
      `insert into oidc.model_store (model, id_hash, payload, expires_at) values
         ('AccessToken', sha256('old-1'::bytea), '{}', '2026-01-01T00:00:00Z'),
         ('AccessToken', sha256('recent-1'::bytea), '{}', '2026-01-09T12:00:00Z')`,
    );
    await query(db.superuserUrl, `insert into oidc.client_auth_failure (at, ip, client_id) values ('2026-01-01T00:00:00Z', '10.3.3.3', 'x'), ('2026-01-09T23:00:00Z', '10.3.3.3', 'y')`);
    const worker = createDatabase({ connectionString: db.workerUrl, maxConnections: 1 });
    try {
      const result = await oidcCleanupTask({ db: worker, logger: pino({ level: 'silent' }), mail: { send: () => Promise.resolve() }, webBaseUrl: base }, { now: '2026-01-10T00:00:00Z' });
      expect(result['models']).toBeGreaterThanOrEqual(1);
      expect(result['failures']).toBe(1);
      const left = await query<{ n: number }>(db.superuserUrl, `select count(*)::int as n from oidc.model_store where id_hash in (sha256('old-1'::bytea), sha256('recent-1'::bytea))`);
      expect(left[0]?.n).toBe(1);
      expect((await query(db.superuserUrl, `select 1 from oidc.client_auth_failure where ip = '10.3.3.3'`)).length).toBe(1);
    } finally {
      await worker.destroy();
    }
  });
});
