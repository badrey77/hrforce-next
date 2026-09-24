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
import { PERMISSION_KEY, PUBLIC_KEY } from './decorators.js';
import { PermissionEvaluator } from './permission-evaluator.js';

/**
 * Global, deny-by-default guard:
 *  - @Public()                → allowed;
 *  - @RequirePermission(code) → 401 if anonymous, 403 unless the PermissionEvaluator grants `code`;
 *  - neither (or both)        → 403 (misconfigured route; the route-scan guardrail should catch it first).
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  private readonly logger = new Logger('PermissionGuard');

  constructor(
    private readonly reflector: Reflector,
    private readonly identityResolver: RequestIdentityResolver,
    private readonly evaluator: PermissionEvaluator,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(PUBLIC_KEY, targets) === true;
    const permission = this.reflector.getAllAndOverride<string | undefined>(PERMISSION_KEY, targets);

    if (isPublic === (permission !== undefined)) {
      this.logger.warn(
        { handler: `${context.getClass().name}.${context.getHandler().name}` },
        isPublic ? 'route has both @Public and @RequirePermission' : 'route has no access policy; denied',
      );
      throw new ForbiddenException();
    }
    if (isPublic || permission === undefined) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const identity = await identityOf(this.identityResolver, req);
    if (!identity.userId) throw new UnauthorizedException();
    if (!(await this.evaluator.hasPermission(identity, permission))) throw new ForbiddenException();
    return true;
  }
}
