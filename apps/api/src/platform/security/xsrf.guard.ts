import { timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, SetMetadata, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
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

    const identity = await identityOf(this.identityResolver, req);
    if (!verifyXsrfToken(this.env.AUTH_XSRF_SECRET, token, identity.sessionId ?? ANON_BINDING)) throw xsrfProblem();
    return true;
  }
}
