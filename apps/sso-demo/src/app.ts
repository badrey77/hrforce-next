/**
 * The demo's routes (docs/contracts/sso.md › Demo sister app › Routes):
 *   GET  /            home, or 303 /welcome when signed in
 *   GET  /login       PKCE verifier + state + nonce in the session, 303 to HRForce's /oidc/auth
 *   GET  /callback    code exchange, session id regenerated, 303 /welcome
 *   GET  /welcome     the user's identity and roles in this app
 *   POST /logout      local session dropped, 303 to HRForce's end_session (RP-initiated logout)
 *   GET  /signed-out  the post-logout page
 *   GET  /lang/:lang  fr | ar
 *   GET  /assets/demo.css
 * Logs: one line per request (method, path without the query string, status, ms). Never codes, tokens, the client
 * secret or claims.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { readUser } from './claims.js';
import type { DemoEnv } from './env.js';
import { isLang, type Lang } from './i18n.js';
import { oauthErrorCode, type RelyingParty } from './oidc.js';
import { errorPage, homePage, notFoundPage, PAGE_PATHS, signedOutPage, welcomePage } from './pages.js';
import { parseCookies, securityHeaders } from './security.js';
import type { SessionEntry, SessionStore } from './session.js';
import { DEMO_CSS } from './styles.js';

export const SESSION_COOKIE = 'sso_demo_sid';
export const LANG_COOKIE = 'sso_demo_lang';

export interface DemoLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface AppDeps {
  env: Pick<DemoEnv, 'baseUrl' | 'issuer' | 'cookieSecure'>;
  rp: RelyingParty;
  sessions: SessionStore;
  logger: DemoLogger;
}

interface Visit {
  id: string | undefined;
  session: SessionEntry | undefined;
  lang: Lang;
  langCookie: Lang | undefined;
}

export function createApp({ env, rp, sessions, logger }: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);

  const cookieOptions = { httpOnly: true, sameSite: 'lax' as const, secure: env.cookieSecure, path: '/' };
  const baseOrigin = new URL(env.baseUrl).origin;

  app.use((req, res, next) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      logger.info({ method: req.method, path: req.path, status: res.statusCode, ms: Number((process.hrtime.bigint() - started) / 1_000_000n) }, 'request');
    });
    next();
  });
  app.use(securityHeaders(env.issuer));

  const visit = (req: Request): Visit => {
    const cookies = parseCookies(req.headers.cookie);
    const id = cookies.get(SESSION_COOKIE);
    const session = sessions.get(id);
    const rawLang = cookies.get(LANG_COOKIE);
    const langCookie = isLang(rawLang) ? rawLang : undefined;
    return { id: session ? id : undefined, session, lang: session?.lang ?? langCookie ?? 'fr', langCookie };
  };

  app.get('/assets/demo.css', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.type('text/css').send(DEMO_CSS);
  });

  app.get('/', (req, res) => {
    const v = visit(req);
    if (v.session?.user) return res.redirect(303, '/welcome');
    page(res, homePage(v.lang));
  });

  app.get('/login', async (req, res) => {
    const v = visit(req);
    if (v.session?.user) return res.redirect(303, '/welcome');
    const request = await rp.startSignIn(v.lang);
    const pending = { codeVerifier: request.codeVerifier, state: request.state, nonce: request.nonce, createdAt: Date.now() };
    if (v.session && v.id) {
      v.session.pending = pending;
    } else {
      const created = sessions.create({ pending, ...(v.langCookie ? { lang: v.langCookie } : {}) });
      res.cookie(SESSION_COOKIE, created.id, cookieOptions);
    }
    res.redirect(303, request.url.href);
  });

  app.get('/callback', async (req, res) => {
    const v = visit(req);
    const pending = v.session?.pending;
    // The callback URL is rebuilt on the configured base URL: the Host header is never trusted.
    const currentUrl = new URL(req.originalUrl, `${env.baseUrl}/`);
    if (!v.session || !pending) {
      logger.warn({ event: 'callback', error: 'no_pending_sign_in' }, 'sign-in refused');
      return page(res, errorPage(v.lang, 'no_pending_sign_in'), 400);
    }
    // One attempt per pending sign-in: a replayed or failed callback cannot reuse the verifier.
    delete v.session.pending;
    let result;
    try {
      result = await rp.finishSignIn(currentUrl, { codeVerifier: pending.codeVerifier, state: pending.state, nonce: pending.nonce });
    } catch (error) {
      // `error=access_denied` (the user cancelled in HRForce) arrives here too, after the library checked `state`
      // and `iss` of the response.
      const code = oauthErrorCode(error);
      if (code === 'access_denied') return page(res, homePage(v.lang, { cancelled: true }));
      logger.warn({ event: 'callback', error: code, errorName: error instanceof Error ? error.name : typeof error }, 'sign-in refused');
      return page(res, errorPage(v.lang, code), 400);
    }
    const locale = readUser(result.claims).locale;
    const lang: Lang = v.session.lang ?? v.langCookie ?? (locale === 'ar' ? 'ar' : 'fr');
    const fresh = sessions.regenerate(v.id, { user: { claims: result.claims, idToken: result.idToken }, lang });
    res.cookie(SESSION_COOKIE, fresh.id, cookieOptions);
    res.redirect(303, '/welcome');
  });

  app.get('/welcome', (req, res) => {
    const v = visit(req);
    const user = v.session?.user;
    if (!user) return res.redirect(303, '/');
    page(res, welcomePage(v.lang, readUser(user.claims), user.claims));
  });

  app.post('/logout', (req, res) => {
    // SameSite=Lax keeps cross-site POSTs without the cookie; a foreign Origin is refused outright as well.
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== baseOrigin) {
      res.status(403).type('text/plain').send('Forbidden');
      return;
    }
    const v = visit(req);
    const idToken = v.session?.user?.idToken;
    sessions.destroy(v.id);
    res.clearCookie(SESSION_COOKIE, cookieOptions);
    if (!idToken) return res.redirect(303, '/');
    // Keep the chosen language for the signed-out page (the session holding it is gone).
    if (v.session?.lang) res.cookie(LANG_COOKIE, v.session.lang, { ...cookieOptions, maxAge: 365 * 24 * 3600 * 1000 });
    res.redirect(303, rp.endSessionUrl(idToken).href);
  });

  app.get('/signed-out', (req, res) => {
    page(res, signedOutPage(visit(req).lang));
  });

  app.get('/lang/:lang', (req, res) => {
    const lang = req.params.lang;
    if (!isLang(lang)) return page(res, notFoundPage(visit(req).lang), 404);
    const v = visit(req);
    if (v.session) v.session.lang = lang;
    else res.cookie(LANG_COOKIE, lang, { ...cookieOptions, maxAge: 365 * 24 * 3600 * 1000 });
    res.redirect(303, returnPath(req, baseOrigin));
  });

  app.use((req, res) => {
    page(res, notFoundPage(visit(req).lang), 404);
  });

  // Express 5 forwards rejected async handlers here. Only the error's name is logged (never a message that could
  // carry a URL or a token).
  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    logger.error({ event: 'unhandled', errorName: error instanceof Error ? error.name : typeof error, path: req.path }, 'request failed');
    if (res.headersSent) return;
    page(res, errorPage(visit(req).lang, 'server_error'), 500);
  });

  return app;
}

function page(res: Response, body: string, status = 200): void {
  res.status(status).type('html').send(body);
}

/**
 * Where `/lang/:lang` goes back to: `?next=` when it is one of the demo's pages (the pages send
 * `Referrer-Policy: no-referrer`, so the language link carries it), else a same-origin `Referer` path, else `/`.
 */
function returnPath(req: Request, baseOrigin: string): string {
  const next = req.query['next'];
  if (typeof next === 'string' && (PAGE_PATHS as readonly string[]).includes(next)) return next;
  const referer = req.headers.referer;
  if (referer) {
    try {
      const url = new URL(referer);
      if (url.origin === baseOrigin && (PAGE_PATHS as readonly string[]).includes(url.pathname)) return url.pathname;
    } catch {
      // not a URL: fall through
    }
  }
  return '/';
}
