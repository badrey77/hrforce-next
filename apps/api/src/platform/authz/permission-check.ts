import { ForbiddenException, Injectable, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { RequestIdentity } from '../context/request-identity.js';
import { ProblemException } from '../http/problem-details.js';
import { accessPolicyOf } from './access-policy.js';
import { ALLOW_WITHOUT_MFA_KEY } from './decorators.js';
import { MfaRequirement } from './mfa-requirement.js';
import { PermissionEvaluator } from './permission-evaluator.js';

/**
 * The permission decision for @RequirePermission routes (@Authenticated routes: any authenticated caller). Invoked by RequestContextInterceptor right AFTER it has
 * opened the request transaction and set `app.company_id` / `app.user_id`, so the evaluator can use `currentTx()`
 * (tenant-scoped, RLS-protected). A denial throws 403 and rolls the transaction back.
 * Fails closed: a misconfigured route (neither/both decorators) is denied here too, even if no guard ran.
 * Two-step sign-in (docs/contracts/mfa.md › Enforcement) is enforced HERE, once for every non-public route: a caller
 * the company requires to use MFA who has not enrolled gets 403 `mfa-enrollment-required`, except on routes marked
 * @AllowWithoutMfa(). Checked before the permission, so the web can send the user to the enrollment wizard.
 */
@Injectable()
export class PermissionCheck {
  constructor(
    private readonly reflector: Reflector,
    private readonly evaluator: PermissionEvaluator,
    private readonly mfa: MfaRequirement,
  ) {}

  /** True when the route needs no identity at all (no database work is needed to allow it). */
  isPublic(context: ExecutionContext): boolean {
    return accessPolicyOf(this.reflector, context).kind === 'public';
  }

  async assertAllowed(context: ExecutionContext, identity: RequestIdentity): Promise<void> {
    const policy = accessPolicyOf(this.reflector, context);
    if (policy.kind === 'public') return;
    if (policy.kind === 'invalid') throw new ForbiddenException();
    if (!identity.userId) throw new UnauthorizedException();
    const exempt = this.reflector.getAllAndOverride<boolean | undefined>(ALLOW_WITHOUT_MFA_KEY, [context.getHandler(), context.getClass()]) === true;
    if (!exempt && (await this.mfa.isRequired(identity)) && !(await this.mfa.isEnabled(identity))) {
      throw new ProblemException(403, 'mfa-enrollment-required', 'Your company requires two-step sign-in: set it up first (GET /api/me/mfa).');
    }
    if (policy.kind === 'authenticated') return;
    if (!(await this.evaluator.hasPermission(identity, policy.permission))) throw new ForbiddenException();
  }
}
