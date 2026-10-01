import { Injectable } from '@nestjs/common';
import { IdentityRepository, type MeRecord, type SsoSessionRecord } from '../infra/identity.repository.js';

/**
 * Identity facts the SSO module needs (docs/contracts/sso.md › Module boundaries), without exposing the repository:
 *  - `ssoSession(sid, userId)`: whether the HRForce session behind an access token is still live (the whole refresh
 *    family, auth.sso_session), its login instant and amr, and the account status — null for an unknown sid;
 *  - `member(userId, companyId)`: the active member's profile in that company (auth.me), else null.
 * Both run on the current transaction when there is one, else on the root pool (definer functions only).
 */
@Injectable()
export class IdentitySessions {
  constructor(private readonly repo: IdentityRepository) {}

  ssoSession(sid: string, userId: string): Promise<SsoSessionRecord | null> {
    return this.repo.ssoSession(sid, userId);
  }

  member(userId: string, companyId: string): Promise<MeRecord | null> {
    return this.repo.me(userId, companyId);
  }
}
