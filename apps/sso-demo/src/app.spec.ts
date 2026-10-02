/**
 * Integration: the demo's routes with the real openid-client against a fake provider (discovery, JWKS, token
 * endpoint, RS256 ID tokens). The HRForce sign-in itself is skipped: the test plays the provider's redirect back to
 * /callback. The real round trip through HRForce is covered by apps/api/test/sso.e2e-spec.ts and the verifier.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp, type DemoLogger, SESSION_COOKIE } from './app.js';
import { createRelyingParty, discover } from './oidc.js';
import { SessionStore } from './session.js';
import { startFakeProvider, type FakeProvider } from './test-support/fake-provider.js';

const CLIENT = { clientId: 'sso-demo', clientSecret: 'test-secret-0123456789-0123456789-abcdef' };
const BASE = 'http://localhost:4300';

const agentClaims = {
  sub: '0192f000-0000-7000-8000-000000000030',
  name: 'Amine Agent',
  email: 'agent.annaba@demo.dz',
  locale: 'ar',
  company: { id: 'c1', code: 'DEMO', name: 'Démo SPA' },
  employee: { matricule: 'EMP-0030', active: true, unit: { id: 'u1', code: 'AG-ANNABA', name: 'Agence Annaba', nameAr: 'وكالة عنابة' } },
  roles: ['operator'],
};

let provider: FakeProvider;
let app: ReturnType<typeof createApp>;
const logLines: string[] = [];
const logger: DemoLogger = {
  info: (obj, msg) => logLines.push(JSON.stringify({ obj, msg })),
  warn: (obj, msg) => logLines.push(JSON.stringify({ obj, msg })),
  error: (obj, msg) => logLines.push(JSON.stringify({ obj, msg })),
};

beforeAll(async () => {
  provider = await startFakeProvider(CLIENT);
  const env = { baseUrl: BASE, issuer: provider.issuer, cookieSecure: false, ...CLIENT };
  const config = await discover(env);
  app = createApp({ env, rp: createRelyingParty(config, env), sessions: new SessionStore(), logger });
});

afterAll(async () => {
  await provider.close();
});

function sessionCookie(res: request.Response): string | undefined {
  const header = res.headers['set-cookie'] as unknown as string[] | undefined;
  const cookie = header?.find((c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`));
  return cookie?.split(';')[0];
}

async function startLogin(cookie?: string) {
  const res = await request(app).get('/login').set('Cookie', cookie ?? '');
  expect(res.status).toBe(303);
  const location = new URL(res.headers['location'] as string);
  return { res, location, cookie: sessionCookie(res) ?? cookie ?? '' };
}

async function signIn(claims: Record<string, unknown> = agentClaims) {
  const { location, cookie, res } = await startLogin();
  const p = location.searchParams;
  const code = provider.issueCode({
    redirectUri: p.get('redirect_uri') ?? '',
    codeChallenge: p.get('code_challenge') ?? '',
    nonce: p.get('nonce') ?? '',
    claims,
  });
  const callbackPath = `/callback?code=${code}&state=${p.get('state')}&iss=${encodeURIComponent(provider.issuer)}`;
  const callback = await request(app).get(callbackPath).set('Cookie', cookie);
  return { loginRes: res, location, preLoginCookie: cookie, callbackPath, callback, cookie: sessionCookie(callback) ?? '' };
}

describe('demo app (integration with a fake provider)', () => {
  it('home: security headers, no script, sign-in button', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-security-policy']).toBe(
      `default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self' ${new URL(provider.issuer).origin}; frame-ancestors 'none'; base-uri 'none'`,
    );
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('same-origin');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.text).toContain('Se connecter avec HRForce');
    expect(res.text).not.toContain('<script');
  });

  it('login: PKCE S256, state, nonce, scope, redirect URI, ui_locales; HttpOnly SameSite=Lax cookie', async () => {
    const { location, res } = await startLogin();
    expect(location.origin + location.pathname).toBe(`${provider.issuer}/auth`);
    const p = location.searchParams;
    expect(p.get('response_type')).toBe('code');
    expect(p.get('client_id')).toBe('sso-demo');
    expect(p.get('redirect_uri')).toBe(`${BASE}/callback`);
    expect(p.get('scope')).toBe('openid profile email hrforce');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.get('state')).toBeTruthy();
    expect(p.get('nonce')).toBeTruthy();
    expect(p.get('ui_locales')).toBe('fr');
    const setCookie = (res.headers['set-cookie'] as unknown as string[])[0] ?? '';
    expect(setCookie).toMatch(/^sso_demo_sid=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax$/);
  });

  it('full sign-in: session id regenerated, welcome with role and claims; sign-out goes to end_session', async () => {
    const { callback, cookie, preLoginCookie } = await signIn();
    expect(callback.status).toBe(303);
    expect(callback.headers['location']).toBe('/welcome');
    expect(cookie).toBeTruthy();
    expect(cookie).not.toBe(preLoginCookie);

    // the pre-login id is dead (fixation)
    expect((await request(app).get('/welcome').set('Cookie', preLoginCookie)).status).toBe(303);

    const welcome = await request(app).get('/welcome').set('Cookie', cookie);
    expect(welcome.status).toBe(200);
    // no language chosen: the account's locale (ar) applies
    expect(welcome.text).toContain('<html lang="ar" dir="rtl">');
    expect(welcome.text).toContain('مرحبا، Amine Agent');
    expect(welcome.text).toContain('التشغيل');
    expect(welcome.text).toContain('EMP-0030');
    expect(welcome.text).toContain('وكالة عنابة');
    expect(welcome.text).toContain('&quot;roles&quot;');
    expect(welcome.text).not.toMatch(/eyJ[A-Za-z0-9_-]+\./); // no raw JWT on the page

    expect((await request(app).get('/').set('Cookie', cookie)).headers['location']).toBe('/welcome');

    const logout = await request(app).post('/logout').set('Cookie', cookie);
    expect(logout.status).toBe(303);
    const end = new URL(logout.headers['location'] as string);
    expect(end.origin + end.pathname).toBe(`${provider.issuer}/session/end`);
    expect(end.searchParams.get('post_logout_redirect_uri')).toBe(`${BASE}/signed-out`);
    expect(end.searchParams.get('id_token_hint')).toMatch(/^eyJ/);
    expect((await request(app).get('/welcome').set('Cookie', cookie)).status).toBe(303);

    const signedOut = await request(app).get('/signed-out');
    expect(signedOut.text).toContain('Vous êtes déconnecté(e) de la démo et de HRForce.');

    // nothing sensitive in the logs
    const logs = logLines.join('\n');
    expect(logs).not.toContain('eyJ');
    expect(logs).not.toContain('code=');
    expect(logs).not.toContain(CLIENT.clientSecret);
    expect(logs).not.toContain('agent.annaba');
  });

  it('a user without roles sees the notice; an unlinked user sees no employee block', async () => {
    const { cookie } = await signIn({ ...agentClaims, locale: 'fr', roles: [], employee: null });
    const welcome = await request(app).get('/welcome').set('Cookie', cookie);
    expect(welcome.text).toContain('Aucun rôle ne vous est attribué dans cette application.');
    expect(welcome.text).toContain('Aucun dossier salarié');
  });

  it('a replayed callback is refused (one attempt per pending sign-in)', async () => {
    const { callbackPath, preLoginCookie } = await signIn();
    const replay = await request(app).get(callbackPath).set('Cookie', preLoginCookie);
    expect(replay.status).toBe(400);
    expect(replay.text).toContain('no_pending_sign_in');
  });

  it('a wrong state is refused and the code is not exchanged', async () => {
    const { location, cookie } = await startLogin();
    const calls = provider.tokenCalls;
    const res = await request(app)
      .get(`/callback?code=abc&state=wrong&iss=${encodeURIComponent(provider.issuer)}`)
      .set('Cookie', cookie);
    expect(res.status).toBe(400);
    expect(res.text).toContain('(invalid_response)');
    expect(provider.tokenCalls).toBe(calls);
    expect(location.searchParams.get('state')).not.toBe('wrong');
  });

  it('a wrong iss (mix-up) is refused', async () => {
    const { location, cookie } = await startLogin();
    const res = await request(app)
      .get(`/callback?code=abc&state=${location.searchParams.get('state')}&iss=${encodeURIComponent('https://evil.example/oidc')}`)
      .set('Cookie', cookie);
    expect(res.status).toBe(400);
  });

  it('a nonce mismatch in the ID token is refused', async () => {
    const { location, cookie } = await startLogin();
    const p = location.searchParams;
    const code = provider.issueCode({ redirectUri: p.get('redirect_uri') ?? '', codeChallenge: p.get('code_challenge') ?? '', nonce: 'other', claims: agentClaims });
    const res = await request(app)
      .get(`/callback?code=${code}&state=${p.get('state')}&iss=${encodeURIComponent(provider.issuer)}`)
      .set('Cookie', cookie);
    expect(res.status).toBe(400);
    expect(res.text).not.toContain('Amine');
  });

  it('access_denied (cancelled in HRForce) shows the home page with « Connexion annulée. »', async () => {
    const { location, cookie } = await startLogin();
    const res = await request(app)
      .get(`/callback?error=access_denied&state=${location.searchParams.get('state')}&iss=${encodeURIComponent(provider.issuer)}`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Connexion annulée.');
  });

  it('a token-endpoint error is shown by its code only', async () => {
    const { location, cookie } = await startLogin();
    const res = await request(app)
      .get(`/callback?code=unknown&state=${location.searchParams.get('state')}&iss=${encodeURIComponent(provider.issuer)}`)
      .set('Cookie', cookie);
    expect(res.status).toBe(400);
    expect(res.text).toContain('(invalid_grant)');
  });

  it('language switch: cookie without a session, session value with one; next limited to demo pages', async () => {
    const res = await request(app).get('/lang/ar?next=/signed-out');
    expect(res.status).toBe(303);
    expect(res.headers['location']).toBe('/signed-out');
    const langCookie = ((res.headers['set-cookie'] as unknown as string[])[0] ?? '').split(';')[0] ?? '';
    expect(langCookie).toBe('sso_demo_lang=ar');
    expect((await request(app).get('/').set('Cookie', langCookie)).text).toContain('dir="rtl"');

    expect((await request(app).get('/lang/fr?next=https://evil.example/')).headers['location']).toBe('/');
    expect((await request(app).get('/lang/fr?next=//evil.example')).headers['location']).toBe('/');
    expect((await request(app).get('/lang/de')).status).toBe(404);

    const { cookie } = await signIn();
    await request(app).get('/lang/fr?next=/welcome').set('Cookie', cookie);
    expect((await request(app).get('/welcome').set('Cookie', cookie)).text).toContain('<html lang="fr" dir="ltr">');
  });

  it('logout refuses a foreign Origin; stylesheet is served as CSS', async () => {
    const { cookie } = await signIn();
    const res = await request(app).post('/logout').set('Cookie', cookie).set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
    expect((await request(app).post('/logout').set('Cookie', cookie).set('Origin', 'null')).status).toBe(403);
    expect((await request(app).get('/welcome').set('Cookie', cookie)).status).toBe(200);
    // what a browser sends for the demo's own form under Referrer-Policy: same-origin
    expect((await request(app).post('/logout').set('Cookie', cookie).set('Origin', BASE)).status).toBe(303);
    const css = await request(app).get('/assets/demo.css');
    expect(css.headers['content-type']).toMatch(/^text\/css/);
    expect(css.text).toContain('padding-inline');
    const icon = await request(app).get('/assets/favicon.svg');
    expect(icon.status).toBe(200);
    expect(icon.headers['content-type']).toMatch(/^image\/svg\+xml/);
    expect((await request(app).get('/')).text).toContain('<link rel="icon" href="/assets/favicon.svg"');
  });
});
