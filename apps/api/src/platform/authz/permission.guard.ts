import {
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { identityOf, RequestIdentityResolver } from '../context/request-identity.js';
import { accessPolicyOf } from './access-policy.js';

/**
 * Global (APP_GUARD), deny-by-default guard — the cheap checks that need no database:
 *  - @Public()                → allowed;
 *  - @RequirePermission(code) → 401 if anonymous; otherwise allowed HERE — the permission itself is decided by
 *                               {@link PermissionCheck} inside the request transaction (guards run before
 *                               interceptors, i.e. before the transaction and its tenant settings exist);
 *  - @Authenticated()         → 401 if anonymous; otherwise allowed (no permission);
 *  - none (or several)        → 403 (misconfigured route; the route-scan guardrail should catch it first).
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  private readonly logger = new Logger('PermissionGuard');

  constructor(
    private readonly reflector: Reflector,
    private readonly identityResolver: RequestIdentityResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const policy = accessPolicyOf(this.reflector, context);
    if (policy.kind === 'invalid') {
      this.logger.warn({ handler: `${context.getClass().name}.${context.getHandler().name}` }, policy.reason);
      throw new ForbiddenException();
    }
    if (policy.kind === 'public') return true;

    const identity = await identityOf(this.identityResolver, context.switchToHttp().getRequest<Request>());
    if (!identity.userId) throw new UnauthorizedException();
    return true;
  }
}
