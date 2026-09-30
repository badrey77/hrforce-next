import { timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, SetMetadata, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { PUBLIC_KEY } from '../authz/decorators.js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.schema.js';
import { identityOf, RequestIdentityResolver } from '../context/request-identity.js';
import { ProblemException } from '../http/problem-details.js';
import { readCookie, XSRF_COOKIE, XSRF_HEADER } from './cookies.js';
import { ANON_BINDING, verifyXsrfToken } from './xsrf.js';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const XSRF_BINDING_KEY = 'hrforce:xsrfBinding';

/**
 * Marks a route whose handler-level guard verifies the XSRF signature itself against the refresh session (the
 * /api/auth routes: after 15 min the access cookie is gone, so the global guard cannot know the caller's `sid`).
 * The global {@link XsrfGuard} then only checks presence + header/cookie equality. Use the Identity module's
 * `@AuthXsrf()`, which applies this AND the guard that does the signature check — never this alone.
 */
export const XsrfBindingFromRefreshSession = (): MethodDecorator & ClassDecorator => SetMetadata(XSRF_BINDING_KEY, 'refresh-session');

/**
 * Marks a PUBLIC route whose XSRF check is the double submit only (header equal to the cookie), WITHOUT verifying
 * that the token is signed for the caller's session (docs/contracts/attendance.md › Scan, ADR 009 §3).
 * Why: `POST /api/attendance/scan` is called by a phone whose session usually expired overnight — its `XSRF-TOKEN`
 * cookie may still be bound to that dead session id, so the signed check would refuse the scan with 403 before the
 * employee can even sign in. Allowed ONLY on `@Public()` routes that write nothing to the database and whose only
 * effect is a cookie for the caller's own browser (a cross-site request cannot read that cookie, and SameSite=Strict
 * keeps it from being sent cross-site anyway). The guard refuses (403) a route that carries it without `@Public()`.
 */
export const XsrfUnbound = (): MethodDecorator & ClassDecorator => SetMetadata(XSRF_BINDING_KEY, 'unbound');

export function xsrfProblem(): ProblemException {
  return new ProblemException(403, 'xsrf', 'Missing or invalid XSRF token.');
}

/** The XSRF header and cookie, when both are present and equal (constant-time comparison); else undefined. */
export function matchingXsrfToken(req: Request): string | undefined {
  const header = req.headers[XSRF_HEADER];
  const cookie = readCookie(req, XSRF_COOKIE);
  if (typeof header !== 'string' || !cookie) return undefined;
  const a = Buffer.from(header);
  const b = Buffer.from(cookie);
  return a.length === b.length && timingSafeEqual(a, b) ? cookie : undefined;
}

/**
 * Global (APP_GUARD, registered before PermissionGuard) signed double-submit check — docs/contracts/identity.md:
 * every POST/PUT/PATCH/DELETE needs header `X-XSRF-TOKEN` equal to the `XSRF-TOKEN` cookie, signed for the caller's
 * refresh session id (`sid` of a valid access cookie) or `anon` without one. Failure → 403 `urn:hrforce:problem:xsrf`.
 * Safe methods are never checked. Header-only identities (DEV_AUTH, tests) have no `sid`: they use an anon token.
 * `@XsrfUnbound()` routes (public only) skip the signature check. An ANONYMOUS caller of a non-public route whose
 * header and cookie match is let through to the PermissionGuard, which answers 401: the web then refreshes the
 * session (or signs in) instead of failing with 403 on a token still bound to an expired session (docs/contracts/
 * attendance.md › Punch: the morning scan after an overnight expiry). Nothing runs for such a caller.
 */
@Injectable()
export class XsrfGuard implements CanActivate {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly reflector: Reflector,
    private readonly identityResolver: RequestIdentityResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<Request>();
    if (!UNSAFE_METHODS.has(req.method.toUpperCase())) return true;

    const token = matchingXsrfToken(req);
    if (!token) throw xsrfProblem();
    const binding = this.reflector.getAllAndOverride<string | undefined>(XSRF_BINDING_KEY, [context.getHandler(), context.getClass()]);
    if (binding === 'refresh-session') return true; // signature verified by the route's own guard
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(PUBLIC_KEY, [context.getHandler(), context.getClass()]) === true;
    if (binding === 'unbound') {
      if (!isPublic) throw xsrfProblem(); // misconfigured: @XsrfUnbound() is for @Public() routes only
      return true;
    }

    const identity = await identityOf(this.identityResolver, req);
    if (!identity.userId && !isPublic) return true; // PermissionGuard answers 401 (see above)
    if (!verifyXsrfToken(this.env.AUTH_XSRF_SECRET, token, identity.sessionId ?? ANON_BINDING)) throw xsrfProblem();
    return true;
  }
}
