import { Global, Module } from '@nestjs/common';
import { permissionEvaluatorFactory } from '../../platform/authz/dev-auth.js';
import { PermissionEvaluator } from '../../platform/authz/permission-evaluator.js';
import { MfaRequirement } from '../../platform/authz/mfa-requirement.js';
import { CompanyWideScopeService, ScopeService } from '../../platform/authz/scope-service.js';
import { ENV } from '../../platform/config/config.module.js';
import { IdentityModule } from '../identity/index.js';
import { AccessController } from './api/access.controller.js';
import { GrantsService } from './application/grants.service.js';
import { RolesService } from './application/roles.service.js';
import { SecurityPolicyService } from './application/security-policy.service.js';
import { AccessClock } from './infra/access-clock.js';
import { AccessRepository } from './infra/access.repository.js';
import { GrantPermissionEvaluator, GrantScopeService } from './infra/grant-scope.service.js';
import { PolicyMfaRequirement } from './infra/policy-mfa-requirement.js';
import { SecurityPolicyRepository } from './infra/security-policy.repository.js';

/**
 * Selects the ScopeService matching the active PermissionEvaluator: grant-backed scopes for the real evaluator,
 * otherwise (DEV_PERMISSIONS=allow_all, test evaluators) flat company-wide scopes derived from the evaluator.
 */
export function scopeServiceFactory(evaluator: PermissionEvaluator, grants: GrantScopeService): ScopeService {
  return evaluator instanceof GrantPermissionEvaluator ? grants : new CompanyWideScopeService(evaluator);
}

/**
 * Authorization (docs/contracts/authorization.md, ADR 002): permission catalogue, roles, org-unit-scoped and
 * date-effective grants. GLOBAL: it provides the platform seams PermissionEvaluator (used by PermissionCheck) and
 * ScopeService (used by repositories/use cases of every module, e.g. Organization, and by GET /api/me), and
 * MfaRequirement (company security_policy: who must use two-step sign-in; docs/contracts/mfa.md).
 */
@Global()
@Module({
  imports: [IdentityModule],
  controllers: [AccessController],
  providers: [
    AccessClock,
    AccessRepository,
    GrantScopeService,
    GrantPermissionEvaluator,
    RolesService,
    GrantsService,
    SecurityPolicyRepository,
    SecurityPolicyService,
    { provide: MfaRequirement, useClass: PolicyMfaRequirement },
    { provide: PermissionEvaluator, inject: [ENV, GrantPermissionEvaluator], useFactory: permissionEvaluatorFactory },
    { provide: ScopeService, inject: [PermissionEvaluator, GrantScopeService], useFactory: scopeServiceFactory },
  ],
  exports: [PermissionEvaluator, ScopeService, MfaRequirement],
})
export class AuthorizationModule {}
