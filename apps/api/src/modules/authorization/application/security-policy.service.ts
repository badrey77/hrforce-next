import { Injectable } from '@nestjs/common';
import { ScopeService } from '../../../platform/authz/scope-service.js';
import { ProblemException, ValidationProblemException } from '../../../platform/http/problem-details.js';
import { ACCESS_PERMISSIONS } from '../domain/catalogue.js';
import { AccessRepository } from '../infra/access.repository.js';
import { SecurityPolicyRepository } from '../infra/security-policy.repository.js';
import type { SecurityPolicyView } from './access-views.js';
import { tenant } from './tenant.js';

export interface SecurityPolicyInput {
  mfaEnforced: boolean;
  mfaRequiredPermissions: string[];
}

/**
 * GET/PUT /api/access/security-policy (docs/contracts/mfa.md). The policy covers the whole company, so changing it
 * needs access.manage_roles over every unit (like a role's permissions, role-escalation): a regional holder may read
 * it but gets 403 `forbidden-scope` on PUT. Codes must exist in the catalogue (422 otherwise); stored in catalogue
 * order, without duplicates. The row change is audited by the table's trigger.
 */
@Injectable()
export class SecurityPolicyService {
  constructor(
    private readonly policies: SecurityPolicyRepository,
    private readonly access: AccessRepository,
    private readonly scopes: ScopeService,
  ) {}

  async get(): Promise<SecurityPolicyView> {
    const policy = await this.policies.get(tenant());
    return { mfaEnforced: policy.mfaEnforced, mfaRequiredPermissions: policy.mfaRequiredPermissions };
  }

  async put(input: SecurityPolicyInput): Promise<SecurityPolicyView> {
    const companyId = tenant();
    if (!(await this.scopes.coversCompany(ACCESS_PERMISSIONS.manageRoles))) {
      throw new ProblemException(403, 'forbidden-scope', 'The security policy covers the whole company: access.manage_roles must cover every unit.');
    }
    const catalogue = await this.access.permissions();
    const known = new Set(catalogue.map((p) => p.code));
    const unknown = input.mfaRequiredPermissions.filter((code) => !known.has(code));
    if (unknown.length > 0) {
      throw new ValidationProblemException([
        { field: 'mfaRequiredPermissions', code: 'unknown_permission', message: `Unknown permission codes: ${unknown.join(', ')}` },
      ]);
    }
    const wanted = new Set(input.mfaRequiredPermissions);
    const ordered = catalogue.filter((p) => wanted.has(p.code)).map((p) => p.code);
    await this.policies.upsert(companyId, { mfaEnforced: input.mfaEnforced, mfaRequiredPermissions: ordered });
    return this.get();
  }
}
