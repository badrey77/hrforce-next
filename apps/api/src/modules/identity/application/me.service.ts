import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ScopeService } from '../../../platform/authz/scope-service.js';
import { requireContext } from '../../../platform/context/request-context.js';
import { IdentityRepository } from '../infra/identity.repository.js';
import type { MeView } from './identity-views.js';
import { MfaService } from './mfa.service.js';

@Injectable()
export class MeService {
  constructor(
    private readonly repo: IdentityRepository,
    private readonly scopes: ScopeService,
    private readonly mfa: MfaService,
  ) {}

  /**
   * The caller, the active company, every company the caller belongs to, and the caller's effective permissions and
   * scopes (platform ScopeService, implemented by the Authorization module). 401 if no longer active / member.
   */
  async me(): Promise<MeView> {
    const { userId, companyId } = requireContext();
    if (!userId || !companyId) throw new UnauthorizedException();
    const me = await this.repo.me(userId, companyId);
    if (!me) throw new UnauthorizedException();
    const companies = await this.repo.userCompanies(userId);
    const access = await this.scopes.summary();
    return {
      user: { id: me.userId, email: me.email, displayName: me.displayName, locale: me.locale },
      company: me.company,
      companies,
      permissions: access.permissions,
      scopes: access.scopes,
      mfa: await this.mfa.meBlock(),
    };
  }
}
