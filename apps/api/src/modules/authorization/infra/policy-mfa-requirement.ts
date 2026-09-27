import { Injectable } from '@nestjs/common';
import { MfaRequirement } from '../../../platform/authz/mfa-requirement.js';
import { PermissionEvaluator } from '../../../platform/authz/permission-evaluator.js';
import { requestMemo } from '../../../platform/context/request-memo.js';
import type { RequestIdentity } from '../../../platform/context/request-identity.js';
import { SecurityPolicyRepository } from './security-policy.repository.js';

/**
 * The platform MfaRequirement seam (docs/contracts/mfa.md › Enforcement): required ⇔ the company's security policy
 * enforces MFA AND the caller holds, anywhere, a permission of its list (through the active PermissionEvaluator: real
 * grants, or DEV_PERMISSIONS=allow_all). Memoised per request; runs in the request transaction.
 */
@Injectable()
export class PolicyMfaRequirement extends MfaRequirement {
  constructor(
    private readonly policies: SecurityPolicyRepository,
    private readonly evaluator: PermissionEvaluator,
  ) {
    super();
  }

  isRequired(identity: RequestIdentity): Promise<boolean> {
    const { userId, companyId } = identity;
    if (!userId || !companyId) return Promise.resolve(false);
    return requestMemo(`mfa:required:${userId}:${companyId}`, async () => {
      const policy = await this.policies.get(companyId);
      if (!policy.mfaEnforced) return false;
      for (const code of policy.mfaRequiredPermissions) {
        if (await this.evaluator.hasPermission(identity, code)) return true;
      }
      return false;
    });
  }

  isEnabled(identity: RequestIdentity): Promise<boolean> {
    const { userId } = identity;
    if (!userId) return Promise.resolve(false);
    return requestMemo(`mfa:enabled:${userId}`, () => this.policies.mfaActive(userId));
  }
}
