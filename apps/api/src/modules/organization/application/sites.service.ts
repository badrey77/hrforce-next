import { Injectable } from '@nestjs/common';
import { OrgRuleViolation } from '../domain/org-unit.js';
import { constraintViolation } from '../infra/org-unit.repository.js';
import { SiteRepository } from '../infra/site.repository.js';
import { tenant } from './org-units.service.js';
import type { Site, SitesView } from './org-views.js';

export const SITE_LIST_LIMIT = 200;

export interface CreateSiteInput {
  code: string;
  name: string;
  wilaya: string;
  address?: string | null | undefined;
}

/** Sites: places that host org units (docs/contracts/organization.md › Sites). Runs in the request transaction. */
@Injectable()
export class SitesService {
  constructor(private readonly sites: SiteRepository) {}

  async list(q?: string): Promise<SitesView> {
    const companyId = tenant();
    const items = await this.sites.list(companyId, { limit: SITE_LIST_LIMIT, ...(q ? { q } : {}) });
    return { items };
  }

  async create(input: CreateSiteInput): Promise<Site> {
    const companyId = tenant();
    if (await this.sites.codeExists(companyId, input.code)) throw codeTaken(input.code);
    try {
      return await this.sites.insert(companyId, {
        code: input.code,
        name: input.name,
        wilaya: input.wilaya,
        address: input.address ?? null,
      });
    } catch (error) {
      if (constraintViolation(error)?.constraint === 'site_company_code_uk') throw codeTaken(input.code);
      throw error;
    }
  }
}

function codeTaken(code: string): OrgRuleViolation {
  return new OrgRuleViolation('site-code-taken', `The site code ${code} is already used in this company.`, 'code');
}
