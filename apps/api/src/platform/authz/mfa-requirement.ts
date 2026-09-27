import { Injectable } from '@nestjs/common';
import type { RequestIdentity } from '../context/request-identity.js';

/**
 * Seam for the two-step sign-in policy (docs/contracts/mfa.md › Enforcement), used by {@link PermissionCheck} on
 * every non-public route and by GET /api/me. Implemented by the Authorization module (company security_policy +
 * held permissions + the caller's factor); always called INSIDE the request transaction and memoised per request.
 *  - `isRequired`: the company enforces MFA and the caller holds (anywhere) a permission of its list;
 *  - `isEnabled`:  the caller's second factor is active.
 */
export abstract class MfaRequirement {
  abstract isRequired(identity: RequestIdentity): Promise<boolean>;
  abstract isEnabled(identity: RequestIdentity): Promise<boolean>;
}

/** Never required (unit tests and tooling). */
@Injectable()
export class NoMfaRequirement extends MfaRequirement {
  isRequired(): Promise<boolean> {
    return Promise.resolve(false);
  }

  isEnabled(): Promise<boolean> {
    return Promise.resolve(false);
  }
}
