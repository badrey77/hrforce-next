import { Injectable, UnauthorizedException } from '@nestjs/common';
import { requireContext } from '../../../platform/context/request-context.js';
import { IdentityRepository } from '../infra/identity.repository.js';
import type { MeView } from './identity-views.js';

@Injectable()
export class MeService {
  constructor(private readonly repo: IdentityRepository) {}

  /** The caller, the active company and every company the caller belongs to. 401 if no longer active / member. */
  async me(): Promise<MeView> {
    const { userId, companyId } = requireContext();
    if (!userId || !companyId) throw new UnauthorizedException();
    const me = await this.repo.me(userId, companyId);
    if (!me) throw new UnauthorizedException();
    const companies = await this.repo.userCompanies(userId);
    return {
      user: { id: me.userId, email: me.email, displayName: me.displayName, locale: me.locale },
      company: me.company,
      companies,
    };
  }
}
