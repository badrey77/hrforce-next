import { Injectable, NotFoundException } from '@nestjs/common';
import { ScopeService } from '../../../platform/authz/scope-service.js';
import { requireContext } from '../../../platform/context/request-context.js';
import { ProblemException } from '../../../platform/http/problem-details.js';
import { PROFILE_PERMISSIONS as P } from '../domain/profile.js';
import { ProfileRepository, type PolicyRow } from '../infra/profile.repository.js';
import type { ProfileSettings } from './profile-views.js';

function toView(p: PolicyRow): ProfileSettings {
  return { contactMode: p.modes.contact, emergencyMode: p.modes.emergency, familyMode: p.modes.family, fileRetentionDays: p.fileRetentionDays };
}

/** GET / PUT /profile/settings: the company's policy, profile.configure company-wide (else 403 forbidden-scope). */
@Injectable()
export class ProfileSettingsService {
  constructor(
    private readonly repo: ProfileRepository,
    private readonly scopes: ScopeService,
  ) {}

  private async company(): Promise<string> {
    const { companyId } = requireContext();
    if (!companyId) throw new NotFoundException();
    if (!(await this.scopes.coversCompany(P.configure))) {
      throw new ProblemException(403, 'forbidden-scope', 'The profile settings are company-wide: profile.configure over the whole company is needed.');
    }
    return companyId;
  }

  async get(): Promise<ProfileSettings> {
    return toView(await this.repo.policy(await this.company()));
  }

  async set(input: ProfileSettings): Promise<ProfileSettings> {
    const companyId = await this.company();
    await this.repo.setPolicy(companyId, {
      modes: { contact: input.contactMode, emergency: input.emergencyMode, family: input.familyMode },
      fileRetentionDays: input.fileRetentionDays,
    });
    return toView(await this.repo.policy(companyId));
  }
}
