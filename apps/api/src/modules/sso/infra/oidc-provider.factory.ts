import type { IncomingMessage, ServerResponse } from 'node:http';
import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { interactionPolicy, Provider, type Configuration, type KoaContextWithOIDC } from 'oidc-provider';
import type { Env } from '../../../platform/config/env.schema.js';
import { getRequestId } from '../../../platform/http/request-id.js';
import type { Database } from '../../../platform/db/database.js';
import type { ClaimsBuilder } from '../application/claims.js';
import { SSO_SCOPE_STRING, SSO_SCOPES } from '../domain/rules.js';
import type { ClientAuthThrottle } from './client-auth-throttle.js';
import { COMPANY_METADATA, NAME_AR_METADATA, type ClientDirectory } from './client-directory.js';
import { pgAdapterClass } from './oidc-adapter.js';
import type { OidcKeys } from './oidc-keys.js';
import { END_SESSION_SCRIPT, renderErrorPage, renderLogoutPage, renderSignedOutPage } from './oidc-pages.js';
import { ensureCurrentKey, loadSigningKeys } from './signing-keys.js';

/** Nest token of the {@link OidcRuntime} (built once, at NestFactory.create). */
export const OIDC_RUNTIME = Symbol('OIDC_RUNTIME');
/** Nest token of the Express handler mounted at /oidc by configureApp(). */
export const OIDC_HTTP_HANDLER = Symbol('OIDC_HTTP_HANDLER');

export type HttpHandler = (req: IncomingMessage, res: ServerResponse) => void;

export interface OidcRuntime {
  issuer: string;
  /** null when the signing keys cannot be decrypted: /oidc answers 503, the rest of HRForce works */
  provider: Provider | null;
  handler: HttpHandler;
}

/** The CSP of every /oidc response (docs/contracts/sso.md › Koa middleware 1); the library appends its script hashes. */
export const OIDC_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

const accessLogger = new Logger('OidcAccess');
const providerLogger = new Logger('OidcProvider');

/** An absolute http(s) URL's origin, else null. */
function originOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Adds a source to the `form-action` directive of the response's CSP, keeping what the library already appended
 * (script hashes). Chrome applies `form-action` to the redirects that follow a form POST, so the logout page and the
 * account-switch step must allow the app's origin.
 */
export function addFormActionSource(ctx: { response: { get(name: string): string }; set(name: string, value: string): void }, origin: string): void {
  const csp = ctx.response.get('content-security-policy');
  if (!csp) return;
  const directives = csp.split(';').map((d) => d.trim()).filter((d) => d.length > 0);
  const updated = directives.map((d) => (d.split(/\s+/)[0] === 'form-action' && !d.split(/\s+/).includes(origin) ? `${d} ${origin}` : d));
  ctx.set('Content-Security-Policy', updated.join('; '));
}

/** Path below the mount point (Express strips `/oidc` before Koa sees the request). */
function routePath(path: string): string {
  return path.replace(/^\/oidc(?=\/|$)/, '') || '/';
}

/** The client id of a token request: HTTP Basic user name, else the `client_id` body parameter. */
function tokenClientId(ctx: KoaContextWithOIDC): string {
  const auth = ctx.get('authorization');
  if (/^basic /i.test(auth)) {
    try {
      const decoded = Buffer.from(auth.slice(6).trim(), 'base64').toString('utf8');
      const user = decoded.split(':')[0] ?? '';
      return decodeURIComponent(user.replace(/\+/g, ' '));
    } catch {
      return '';
    }
  }
  const body = (ctx.oidc as unknown as { body?: Record<string, unknown> } | undefined)?.body;
  return typeof body?.['client_id'] === 'string' ? body['client_id'] : '';
}

/**
 * The /oidc access log (ADR 007 gotcha 12: nestjs-pino never sees these requests): one line per request — method,
 * path WITHOUT the query string, status, duration, request id. No headers, no bodies.
 */
export function oidcAccessLog(req: Request, res: Response, next: NextFunction): void {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const path = (req.originalUrl || req.url).split('?')[0];
    const ms = Number((process.hrtime.bigint() - started) / 1_000_000n);
    accessLogger.log({ method: req.method, path, status: res.statusCode, ms, requestId: getRequestId(req) }, 'oidc request');
  });
  next();
}

/**
 * Express-level host check (also done inside the provider): a request whose origin is not the issuer's origin → 400
 * plain text, before the provider builds any URL from the request's Host (discovery poisoning).
 */
export function oidcHostCheck(issuer: string) {
  const expected = new URL(issuer).origin.toLowerCase();
  return (req: Request, res: Response, next: NextFunction): void => {
    // Express 5: req.protocol and req.host (with port) honour `trust proxy`, like the provider's Koa context
    const origin = `${req.protocol}://${req.host}`.toLowerCase();
    if (origin !== expected) {
      res.status(400).type('text/plain').send('Bad Request');
      return;
    }
    next();
  };
}

/** GET /oidc/assets/end-session.js — registered before the provider mount. */
export function endSessionScript(_req: Request, res: Response): void {
  res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(END_SESSION_SCRIPT);
}

function unavailableHandler(): HttpHandler {
  return (_req, res) => {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ error: 'temporarily_unavailable' }));
  };
}

export interface OidcRuntimeDeps {
  env: Env;
  db: Database;
  keys: OidcKeys;
  clients: ClientDirectory;
  claims: ClaimsBuilder;
  throttle: ClientAuthThrottle;
}

/** The provider's whole configuration (docs/contracts/sso.md › Provider configuration (exact)). */
export async function buildOidcRuntime(deps: OidcRuntimeDeps): Promise<OidcRuntime> {
  const { env, db, keys, clients, claims, throttle } = deps;
  const issuer = `${env.WEB_BASE_URL}/oidc`;
  const homeUrl = `${env.WEB_BASE_URL}/`;
  const created = await ensureCurrentKey(db, keys.material.aead);
  if (created) providerLogger.log({ kid: created }, 'created the first OIDC signing key');
  const loaded = await loadSigningKeys(db, keys.material.aead);
  if (!loaded.ok) {
    providerLogger.error(
      { reason: loaded.reason },
      'OIDC provider unavailable (/oidc answers 503): the signing keys cannot be read with OIDC_KEY. Restore the right OIDC_KEY, or run `oidc:keys reset` and rotate every app secret.',
    );
    return { issuer, provider: null, handler: unavailableHandler() };
  }
  if (loaded.skipped.length > 0) providerLogger.warn({ kids: loaded.skipped }, 'retired OIDC signing keys unreadable with OIDC_KEY are not published');

  const { Check, base } = interactionPolicy;
  const policy = base();
  // HRForce's session is the SSO session (ADR 007 §3): every authorization request without an interaction result goes
  // through the handoff; `login_required` so that prompt=none answers it.
  policy.get('login')?.checks.add(
    new Check('hrforce_session', 'End-User authentication is required', 'login_required', (ctx: KoaContextWithOIDC) => !ctx.oidc.result?.login),
    0,
  );

  const logoutPage = (ctx: KoaContextWithOIDC): string => {
    const hint = ctx.oidc.entities.IdTokenHint as { payload?: { sub?: unknown } } | undefined;
    const client = ctx.oidc.client as (Record<string, unknown> & { clientName?: string }) | undefined;
    const sub = typeof hint?.payload?.sub === 'string' ? hint.payload.sub : null;
    const state = ctx.oidc.session?.state as { secret?: string } | undefined;
    return renderLogoutPage({
      mode: sub ? 'auto' : 'confirm',
      sub,
      action: ctx.oidc.urlFor('end_session_confirm'),
      xsrf: state?.secret ?? '',
      appName: client?.clientName ?? null,
      appNameAr: typeof client?.[NAME_AR_METADATA] === 'string' ? (client[NAME_AR_METADATA] as string) : null,
      homeUrl,
    });
  };

  const configuration: Configuration = {
    adapter: pgAdapterClass(db, clients),
    jwks: { keys: loaded.keys as unknown as NonNullable<Configuration['jwks']>['keys'] },
    features: {
      devInteractions: { enabled: false },
      pushedAuthorizationRequests: { enabled: false },
      dPoP: { enabled: false },
      resourceIndicators: { enabled: false },
      introspection: { enabled: false },
      revocation: { enabled: false },
      registration: { enabled: false },
      clientCredentials: { enabled: false },
      backchannelLogout: { enabled: false },
      deviceFlow: { enabled: false },
      ciba: { enabled: false },
      jwtResponseModes: { enabled: false },
      webMessageResponseMode: { enabled: false },
      userinfo: { enabled: true },
      rpInitiatedLogout: {
        enabled: true,
        logoutSource: (ctx: KoaContextWithOIDC) => {
          ctx.type = 'html';
          ctx.body = logoutPage(ctx);
        },
        postLogoutSuccessSource: (ctx: KoaContextWithOIDC) => {
          ctx.type = 'html';
          ctx.body = renderSignedOutPage(homeUrl);
        },
      },
    },
    scopes: [...SSO_SCOPES],
    claims: {
      openid: ['sub', 'amr', 'auth_time'],
      profile: ['name', 'preferred_username', 'locale'],
      email: ['email', 'email_verified'],
      hrforce: ['company', 'employee', 'roles'],
    },
    conformIdTokenClaims: false,
    pkce: { required: () => true },
    responseTypes: ['code'],
    clientAuthMethods: ['client_secret_basic', 'client_secret_post'],
    enabledJWA: { idTokenSigningAlgValues: ['RS256'] },
    clientBasedCORS: () => false,
    ttl: { AuthorizationCode: 60, IdToken: 300, AccessToken: 300, Interaction: 900, Session: 43_200, Grant: 43_200 },
    cookies: {
      names: { session: 'hrf_op_session', interaction: 'hrf_op_interaction', resume: 'hrf_op_resume' },
      long: { httpOnly: true, sameSite: 'lax', path: '/oidc', secure: env.COOKIE_SECURE },
      short: { httpOnly: true, sameSite: 'lax', secure: env.COOKIE_SECURE },
      keys: [keys.material.cookies],
    },
    interactions: { policy, url: (_ctx, interaction) => `/api/sso/interactions/${interaction.uid}` },
    loadExistingGrant: async (ctx: KoaContextWithOIDC) => {
      // first-party apps: no consent screen — one grant per session and app, reused (ADR 007 gotcha 5)
      const client = ctx.oidc.client;
      const session = ctx.oidc.session;
      if (!client || !session?.accountId) return undefined;
      const result = ctx.oidc.result as { consent?: { grantId?: string } } | undefined;
      const grantId = result?.consent?.grantId ?? session.grantIdFor(client.clientId);
      if (grantId) {
        const existing = await ctx.oidc.provider.Grant.find(grantId);
        if (existing && existing.accountId === session.accountId && existing.clientId === client.clientId) return existing;
      }
      const grant = new ctx.oidc.provider.Grant({ clientId: client.clientId, accountId: session.accountId });
      grant.addOIDCScope(SSO_SCOPE_STRING);
      await grant.save();
      return grant;
    },
    findAccount: (ctx: KoaContextWithOIDC, sub: string) => {
      const client = ctx.oidc.client as unknown as (Record<string, unknown> & { clientId: string }) | undefined;
      if (!client) return undefined;
      return claims.account(client[COMPANY_METADATA], client.clientId, sub);
    },
    extraClientMetadata: { properties: [COMPANY_METADATA, NAME_AR_METADATA] },
    renderError: (ctx: KoaContextWithOIDC, out) => {
      ctx.type = 'html';
      ctx.body = renderErrorPage(typeof out.error === 'string' ? out.error : 'server_error');
    },
  };

  const provider = new Provider(issuer, configuration);
  provider.proxy = env.TRUST_PROXY_HOPS > 0;
  provider.maxIpsCount = env.TRUST_PROXY_HOPS;
  const issuerOrigin = new URL(issuer).origin.toLowerCase();

  // 1. CSP, set BEFORE the library renders (it appends the sha256 of its own inline scripts to an existing header)
  provider.use(async (ctx, next) => {
    ctx.set('Content-Security-Policy', OIDC_CSP);
    await next();
    const oidc = ctx.oidc as KoaContextWithOIDC['oidc'] | undefined;
    const path = routePath(ctx.path);
    if (path === '/session/end' && ctx.status === 200) {
      const origin = originOf(oidc?.params?.['post_logout_redirect_uri']);
      if (origin) addFormActionSource(ctx, origin);
    }
    // the account-switch step of resume posts to the logout confirm, which redirects back and then to the app
    if (/^\/auth\/[^/]+$/.test(path) && ctx.status === 200) {
      const interaction = oidc?.entities?.Interaction as { params?: Record<string, unknown> } | undefined;
      const origin = originOf(interaction?.params?.['redirect_uri']);
      if (origin) addFormActionSource(ctx, origin);
    }
  });
  // 2. host check: the provider builds its URLs from the request's host
  provider.use(async (ctx, next) => {
    if (`${ctx.protocol}://${ctx.host}`.toLowerCase() !== issuerOrigin) {
      ctx.status = 400;
      ctx.type = 'text/plain';
      ctx.body = 'Bad Request';
      return;
    }
    await next();
  });
  // 3. token-endpoint throttle on failed client authentication
  provider.use(async (ctx, next) => {
    if (ctx.method !== 'POST' || routePath(ctx.path) !== '/token') return next();
    const wait = await throttle.retryAfter(ctx.ip);
    if (wait > 0) {
      ctx.status = 429;
      ctx.set('Retry-After', String(wait));
      ctx.set('Cache-Control', 'no-store');
      ctx.body = { error: 'temporarily_unavailable', error_description: 'too many failed client authentications' };
      return;
    }
    await next();
    const body = ctx.body as { error?: unknown } | undefined;
    if (ctx.status === 401 && body?.error === 'invalid_client') await throttle.record(ctx.ip, tokenClientId(ctx as KoaContextWithOIDC));
  });
  // 4. sessionless logout: the library rendered its own auto-submitting form; HRForce's page instead. 5. discovery
  provider.use(async (ctx, next) => {
    await next();
    const path = routePath(ctx.path);
    const oidc = ctx.oidc as KoaContextWithOIDC['oidc'] | undefined;
    if (path === '/session/end' && (ctx.method === 'GET' || ctx.method === 'POST') && ctx.status === 200 && oidc && !oidc.session?.accountId) {
      ctx.type = 'html';
      ctx.body = logoutPage(ctx as KoaContextWithOIDC);
    }
    if (path === '/.well-known/openid-configuration' && ctx.status === 200 && ctx.body && typeof ctx.body === 'object') {
      (ctx.body as Record<string, unknown>)['response_modes_supported'] = ['query'];
    }
  });

  provider.on('server_error', (_ctx: unknown, err: Error) => providerLogger.error({ err: { name: err.name, message: err.message } }, 'oidc server_error'));
  const warn = (event: string) => (ctx: KoaContextWithOIDC, err: { error?: string }) =>
    providerLogger.warn({ event, error: err.error, clientId: ctx.oidc?.client?.clientId }, 'oidc error');
  provider.on('authorization.error', warn('authorization.error'));
  provider.on('grant.error', warn('grant.error'));
  provider.on('end_session.error', warn('end_session.error'));

  return { issuer, provider, handler: provider.callback() as HttpHandler };
}
