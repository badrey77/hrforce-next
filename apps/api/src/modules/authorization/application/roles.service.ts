import { Injectable, NotFoundException } from '@nestjs/common';
import { ScopeService } from '../../../platform/authz/scope-service.js';
import { ValidationProblemException } from '../../../platform/http/problem-details.js';
import { AccessRuleViolation, addedPermissions } from '../domain/access-rules.js';
import type { Names } from '../domain/catalogue.js';
import { AccessRepository, constraintViolation, type RoleRow } from '../infra/access.repository.js';
import type { ItemsView, PermissionView, RoleView } from './access-views.js';
import { tenant } from './tenant.js';

export interface CreateRoleInput {
  code: string;
  names: Names;
  permissions: readonly string[];
}

export interface UpdateRoleInput {
  names?: Names | undefined;
  permissions?: readonly string[] | undefined;
}

function roleNotFound(): NotFoundException {
  return new NotFoundException('Role not found');
}

function toView(role: RoleRow): RoleView {
  return { id: role.id, code: role.code, names: { ...role.names }, isSystem: role.isSystem, permissions: [...role.permissions] };
}

/** Permission catalogue and roles (docs/contracts/authorization.md › New endpoints). */
@Injectable()
export class RolesService {
  constructor(
    private readonly repo: AccessRepository,
    private readonly scopes: ScopeService,
  ) {}

  /** Sorted by group, then sortOrder (the catalogue's sort_order increases group by group). */
  async listPermissions(): Promise<ItemsView<PermissionView>> {
    const rows = await this.repo.permissions();
    return { items: rows.map((p) => ({ code: p.code, group: p.group, sensitive: p.sensitive, labels: { ...p.labels } })) };
  }

  async listRoles(): Promise<ItemsView<RoleView>> {
    return { items: (await this.repo.roles(tenant())).map(toView) };
  }

  async createRole(input: CreateRoleInput): Promise<RoleView> {
    const companyId = tenant();
    const permissions = await this.knownPermissions(input.permissions);
    await this.assertNoEscalation(permissions);
    if (await this.repo.roleCodeExists(companyId, input.code)) throw codeTaken(input.code);
    let id: string;
    try {
      id = await this.repo.insertRole(companyId, { code: input.code, names: input.names });
    } catch (error) {
      if (constraintViolation(error)?.constraint === 'role_company_code_uk') throw codeTaken(input.code);
      throw error;
    }
    await this.repo.setRolePermissions(companyId, id, permissions);
    return this.getRole(companyId, id);
  }

  async updateRole(id: string, input: UpdateRoleInput): Promise<RoleView> {
    const companyId = tenant();
    const [role] = await this.repo.roles(companyId, [id]);
    if (!role) throw roleNotFound();
    if (role.isSystem) {
      throw new AccessRuleViolation('role-system-immutable', `The system role ${role.code} cannot be changed.`);
    }
    if (input.permissions !== undefined) {
      const permissions = await this.knownPermissions(input.permissions);
      await this.assertNoEscalation(addedPermissions(role.permissions, permissions));
      await this.repo.setRolePermissions(companyId, id, permissions);
    }
    if (input.names !== undefined) await this.repo.updateRoleNames(companyId, id, input.names);
    return this.getRole(companyId, id);
  }

  private async getRole(companyId: string, id: string): Promise<RoleView> {
    const [role] = await this.repo.roles(companyId, [id]);
    if (!role) throw roleNotFound();
    return toView(role);
  }

  /** Deduplicated; unknown codes → 422 on `permissions`. */
  private async knownPermissions(codes: readonly string[]): Promise<string[]> {
    const catalogue = new Set((await this.repo.permissions()).map((p) => p.code));
    const unknown = [...new Set(codes)].filter((code) => !catalogue.has(code));
    if (unknown.length > 0) {
      throw new ValidationProblemException([
        { field: 'permissions', code: 'unknown_permission', message: `Unknown permission: ${unknown.join(', ')}` },
      ]);
    }
    return [...new Set(codes)];
  }

  /** role-escalation: every permission added to a role must be held by the caller company-wide. */
  private async assertNoEscalation(added: readonly string[]): Promise<void> {
    const missing: string[] = [];
    for (const code of added) {
      if (!(await this.scopes.coversCompany(code))) missing.push(code);
    }
    if (missing.length > 0) {
      throw new AccessRuleViolation(
        'role-escalation',
        `You cannot add permissions you do not hold company-wide: ${missing.join(', ')}.`,
        'permissions',
      );
    }
  }
}

function codeTaken(code: string): AccessRuleViolation {
  return new AccessRuleViolation('role-code-taken', `The role code ${code} is already used in this company.`, 'code');
}
