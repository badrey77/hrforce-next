import { applyDecorators, Injectable, UseGuards, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { matchingXsrfToken, XsrfBindingFromRefreshSession, xsrfProblem } from '../../../platform/security/xsrf.guard.js';
import { AuthService } from '../application/auth.service.js';

/**
 * XSRF signature check of the /api/auth POST routes. After 15 minutes the access cookie is gone, so the caller's
 * `sid` can only be learnt from the refresh cookie (a database lookup): accepted when the token is signed for anon,
 * for the access cookie's sid, or for the refresh cookie's session. Header/cookie equality is checked by the global
 * XsrfGuard (and again here).
 */
@Injectable()
export class AuthXsrfGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const value = matchingXsrfToken(req);
    if (!value || !(await this.auth.isAuthRouteXsrfValid(req, value))) throw xsrfProblem();
    return true;
  }
}

/** Marks an /api/auth POST route: the global guard defers the signature check to {@link AuthXsrfGuard}. */
export const AuthXsrf = (): MethodDecorator & ClassDecorator => applyDecorators(XsrfBindingFromRefreshSession(), UseGuards(AuthXsrfGuard));
