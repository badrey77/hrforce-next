import { ForbiddenException, Injectable, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { RequestIdentity } from '../context/request-identity.js';
import { accessPolicyOf } from './access-policy.js';
import { PermissionEvaluator } from './permission-evaluator.js';

/**
 * The permission decision for @RequirePermission routes (@Authenticated routes: any authenticated caller). Invoked by RequestContextInterceptor right AFTER it has
 * opened the request transaction and set `app.company_id` / `app.user_id`, so the evaluator can use `currentTx()`
 * (tenant-scoped, RLS-protected). A denial throws 403 and rolls the transaction back.
 * Fails closed: a misconfigured route (neither/both decorators) is denied here too, even if no guard ran.
 */
@Injectable()
export class PermissionCheck {
  constructor(
    private readonly reflector: Reflector,
    private readonly evaluator: PermissionEvaluator,
  ) {}

  async assertAllowed(context: ExecutionContext, identity: RequestIdentity): Promise<void> {
    const policy = accessPolicyOf(this.reflector, context);
    if (policy.kind === 'public') return;
    if (policy.kind === 'invalid') throw new ForbiddenException();
    if (!identity.userId) throw new UnauthorizedException();
    if (policy.kind === 'authenticated') return;
    if (!(await this.evaluator.hasPermission(identity, policy.permission))) throw new ForbiddenException();
  }
}
