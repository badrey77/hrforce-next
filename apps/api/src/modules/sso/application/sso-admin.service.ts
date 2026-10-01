import { randomBytes } from 'node:crypto';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import { AuditEvents } from '../../../platform/audit/audit-events.js';
import { ScopeService } from '../../../platform/authz/scope-service.js';
import { ENV } from '../../../platform/config/config.module.js';
import type { Env } from '../../../platform/config/env.schema.js';
import { currentTx, requireContext } from '../../../platform/context/request-context.js';
import { ProblemException, ValidationProblemException } from '../../../platform/http/problem-details.js';
import { SSO_PERMISSIONS as P, type FieldIssue } from '../domain/rules.js';
import {
  validateAssignment,
  validateAssignmentFilters,
  validateClientCreate,
  validateClientPatch,
  validateReason,
  validateRoleCreate,
  validateRolePatch,
  type Validated,
} from '../domain/validation.js';
import { OidcKeys } from '../infra/oidc-keys.js';
import { seal } from '../infra/oidc-crypto.js';
import { isUniqueViolation, SsoRepository, type AssignmentRow, type ClientRow, type MemberRow, type RoleRow } from '../infra/sso.repository.js';
import type { SsoAppRoleView, SsoAssignmentView, SsoClientCreatedView, SsoClientView } from './sso-views.js';

const ASSIGNMENTS_MAX = 1000;

function caller(): { companyId: string; userId: string } {
  const { companyId, userId } = requireContext();
  if (!companyId || !userId) throw new NotFoundException();
  return { companyId, userId };
}

function valid<T>(result: Validated<T>): T {
  if (!result.ok) throw new ValidationProblemException(result.issues);
  return result.value;
}

const fieldError = (field: string, code: string, message: string): FieldIssue[] => [{ field, code, message }];

/** A new client secret: 32 random bytes, base64url (43 characters). */
export function newClientSecret(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Runs `fn` under a savepoint of the request transaction, so that an expected constraint violation (a taken client id
 * or role code) can be answered with a problem without aborting the whole transaction.
 */
async function withSavepoint<T>(fn: () => Promise<T>): Promise<T> {
  const tx = currentTx();
  await sql`savepoint sso_write`.execute(tx);
  try {
    const result = await fn();
    await sql`release savepoint sso_write`.execute(tx);
    return result;
  } catch (error) {
    await sql`rollback to savepoint sso_write`.execute(tx);
    throw error;
  }
}

/**
 * Connected apps administration (docs/contracts/sso.md › Administration, › Scope rules): reads need sso.read anywhere
 * (route guard); writes need sso.manage_apps (apps, secrets, roles) or sso.assign (assignments) over the WHOLE
 * company, else 403 `forbidden-scope`. Another company's ids are 404 (RLS). Nobody assigns a role to, or removes one
 * from, themselves (409 `sso-assign-self`). Secrets are shown once (create, rotate) and stored sealed.
 */
@Injectable()
export class SsoAdminService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly repo: SsoRepository,
    private readonly scopes: ScopeService,
    private readonly keys: OidcKeys,
    private readonly audit: AuditEvents,
  ) {}

  private get issuer(): string {
    return `${this.env.WEB_BASE_URL}/oidc`;
  }

  private async assertCompanyWide(permission: string): Promise<void> {
    if (!(await this.scopes.coversCompany(permission))) {
      throw new ProblemException(403, 'forbidden-scope', `Connected apps are managed for the whole company: ${permission} over the root unit is needed.`);
    }
  }

  private async clientOr404(id: string): Promise<ClientRow> {
    const client = await this.repo.client(caller().companyId, id);
    if (!client) throw new NotFoundException('App not found');
    return client;
  }

  private roleView(role: RoleRow, canWrite: boolean): SsoAppRoleView {
    return {
      id: role.id,
      code: role.code,
      names: { fr: role.nameFr, ar: role.nameAr, en: role.nameEn },
      assignmentCount: role.assignmentCount,
      _actions: canWrite ? (role.assignmentCount === 0 ? ['update', 'delete'] : ['update']) : [],
    };
  }

  private clientView(client: ClientRow, ctx: { roles: RoleRow[]; users: Map<string, number>; members: Map<string, MemberRow>; canWrite: boolean }): SsoClientView {
    const creator = client.createdBy ? ctx.members.get(client.createdBy) : undefined;
    return {
      id: client.id,
      clientId: client.clientId,
      name: client.name,
      nameAr: client.nameAr,
      status: client.status,
      redirectUris: client.redirectUris,
      postLogoutRedirectUris: client.postLogoutRedirectUris,
      clientAuthMethod: client.clientAuthMethod,
      credentialSetAt: client.credentialSetAt.toISOString(),
      issuer: this.issuer,
      createdAt: client.createdAt.toISOString(),
      createdBy: client.createdBy ? { id: client.createdBy, displayName: creator?.displayName ?? client.createdBy } : null,
      disabledAt: client.disabledAt?.toISOString() ?? null,
      disabledReason: client.disabledReason,
      roles: ctx.roles.filter((r) => r.clientRowId === client.id).map((r) => this.roleView(r, ctx.canWrite)),
      assignmentCount: ctx.users.get(client.id) ?? 0,
      _actions: ctx.canWrite ? (client.status === 'active' ? ['update', 'rotate_secret', 'disable', 'add_role'] : ['update', 'enable', 'add_role']) : [],
    };
  }

  private async viewOf(id: string): Promise<SsoClientView> {
    const { companyId } = caller();
    const client = await this.clientOr404(id);
    const [roles, users, members, canWrite] = await Promise.all([
      this.repo.roles(companyId, id),
      this.repo.userCounts(companyId),
      this.memberMap(companyId),
      this.scopes.coversCompany(P.manageApps),
    ]);
    return this.clientView(client, { roles, users, members, canWrite });
  }

  private async memberMap(companyId: string): Promise<Map<string, MemberRow>> {
    return new Map((await this.repo.members(companyId)).map((m) => [m.id, m]));
  }

  // ── clients ─────────────────────────────────────────────────────────────────────────────────────────────────────

  async list(): Promise<{ items: SsoClientView[] }> {
    const { companyId } = caller();
    const [clients, roles, users, members, canWrite] = await Promise.all([
      this.repo.clients(companyId),
      this.repo.roles(companyId),
      this.repo.userCounts(companyId),
      this.memberMap(companyId),
      this.scopes.coversCompany(P.manageApps),
    ]);
    return { items: clients.map((c) => this.clientView(c, { roles, users, members, canWrite })) };
  }

  detail(id: string): Promise<SsoClientView> {
    return this.viewOf(id);
  }

  async create(body: unknown): Promise<SsoClientCreatedView> {
    const { companyId, userId } = caller();
    await this.assertCompanyWide(P.manageApps);
    const input = valid(validateClientCreate(body));
    const secret = newClientSecret();
    let id: string;
    try {
      id = await withSavepoint(() =>
        this.repo.insertClient(companyId, {
          clientId: input.clientId,
          name: input.name,
          nameAr: input.nameAr,
          secretEnc: seal(this.keys.material.aead, secret, input.clientId),
          clientAuthMethod: input.clientAuthMethod,
          redirectUris: input.redirectUris,
          postLogoutRedirectUris: input.postLogoutRedirectUris,
          createdBy: userId,
        }),
      );
    } catch (error) {
      if (!isUniqueViolation(error, 'sso_client_client_id_uk')) throw error;
      const own = (await this.repo.clients(companyId)).some((c) => c.clientId === input.clientId);
      const message = own ? 'This client id is already used by another app of your company.' : 'This client id is already used by another company of the group.';
      throw new ProblemException(409, 'sso-client-id-taken', message, fieldError('clientId', 'taken', message));
    }
    return { ...(await this.viewOf(id)), clientSecret: secret };
  }

  async update(id: string, body: unknown): Promise<SsoClientView> {
    const { companyId } = caller();
    await this.clientOr404(id);
    await this.assertCompanyWide(P.manageApps);
    const patch = valid(validateClientPatch(body));
    await this.repo.updateClient(companyId, id, patch);
    return this.viewOf(id);
  }

  /** A new secret replaces the old one at once (assumption 7: no overlap). */
  async rotateSecret(id: string): Promise<SsoClientCreatedView> {
    const { companyId } = caller();
    const client = await this.clientOr404(id);
    await this.assertCompanyWide(P.manageApps);
    const secret = newClientSecret();
    await this.repo.setSecret(companyId, id, seal(this.keys.material.aead, secret, client.clientId));
    await this.audit.record({ type: 'sso.client_secret_rotated', subject: { type: 'sso_client', id }, data: { clientId: client.clientId } });
    return { ...(await this.viewOf(id)), clientSecret: secret };
  }

  async disable(id: string, body: unknown): Promise<SsoClientView> {
    const { companyId, userId } = caller();
    const client = await this.clientOr404(id);
    await this.assertCompanyWide(P.manageApps);
    const reason = valid(validateReason(body));
    if (client.status === 'disabled') throw new ProblemException(409, 'sso-client-disabled', 'This app is already disabled.');
    await this.repo.disable(companyId, id, userId, reason);
    return this.viewOf(id);
  }

  async enable(id: string): Promise<SsoClientView> {
    const { companyId } = caller();
    const client = await this.clientOr404(id);
    await this.assertCompanyWide(P.manageApps);
    if (client.status === 'active') throw new ProblemException(409, 'sso-client-active', 'This app is already active.');
    await this.repo.enable(companyId, id);
    return this.viewOf(id);
  }

  // ── roles ───────────────────────────────────────────────────────────────────────────────────────────────────────

  private async roleOr404(id: string): Promise<RoleRow> {
    const role = await this.repo.role(caller().companyId, id);
    if (!role) throw new NotFoundException('App role not found');
    return role;
  }

  async createRole(clientRowId: string, body: unknown): Promise<SsoAppRoleView> {
    const { companyId } = caller();
    await this.clientOr404(clientRowId);
    await this.assertCompanyWide(P.manageApps);
    const input = valid(validateRoleCreate(body));
    let id: string;
    try {
      id = await withSavepoint(() => this.repo.insertRole(companyId, clientRowId, { code: input.code, nameFr: input.names.fr, nameAr: input.names.ar, nameEn: input.names.en }));
    } catch (error) {
      if (!isUniqueViolation(error, 'sso_app_role_client_code_uk')) throw error;
      const message = 'This app already has a role with this code.';
      throw new ProblemException(409, 'sso-role-code-taken', message, fieldError('code', 'taken', message));
    }
    return this.roleView(await this.roleOr404(id), true);
  }

  async updateRole(id: string, body: unknown): Promise<SsoAppRoleView> {
    const { companyId } = caller();
    await this.roleOr404(id);
    await this.assertCompanyWide(P.manageApps);
    const { names } = valid(validateRolePatch(body));
    await this.repo.updateRoleNames(companyId, id, { nameFr: names.fr, nameAr: names.ar, nameEn: names.en });
    return this.roleView(await this.roleOr404(id), true);
  }

  async deleteRole(id: string): Promise<void> {
    const { companyId } = caller();
    const role = await this.roleOr404(id);
    await this.assertCompanyWide(P.manageApps);
    if (role.assignmentCount > 0) throw new ProblemException(409, 'sso-role-in-use', 'Remove the users of this role first.');
    await this.repo.deleteRole(companyId, id);
  }

  // ── assignments ─────────────────────────────────────────────────────────────────────────────────────────────────

  private assignmentView(row: AssignmentRow, members: Map<string, MemberRow>, canWrite: boolean, me: string): SsoAssignmentView {
    const user = members.get(row.userId);
    const by = row.assignedBy ? members.get(row.assignedBy) : undefined;
    return {
      id: row.id,
      user: { id: row.userId, email: user?.email ?? '', displayName: user?.displayName ?? row.userId },
      client: { id: row.clientRowId, clientId: row.clientId, name: row.clientName, nameAr: row.clientNameAr },
      role: { id: row.roleId, code: row.roleCode, names: { fr: row.roleNameFr, ar: row.roleNameAr, en: row.roleNameEn } },
      assignedBy: row.assignedBy ? { id: row.assignedBy, displayName: by?.displayName ?? row.assignedBy } : null,
      assignedAt: row.assignedAt.toISOString(),
      _actions: canWrite && row.userId !== me ? ['remove'] : [],
    };
  }

  async assignments(query: unknown): Promise<{ items: SsoAssignmentView[] }> {
    const { companyId, userId } = caller();
    const filters = valid(validateAssignmentFilters(query));
    const [rows, members, canWrite] = await Promise.all([
      this.repo.assignments(companyId, {
        ...(filters.clientId ? { clientRowId: filters.clientId } : {}),
        ...(filters.userId ? { userId: filters.userId } : {}),
        ...(filters.roleId ? { roleId: filters.roleId } : {}),
      }),
      this.memberMap(companyId),
      this.scopes.coversCompany(P.assign),
    ]);
    const items = rows
      .map((r) => this.assignmentView(r, members, canWrite, userId))
      .toSorted((a, b) => a.client.name.localeCompare(b.client.name) || a.role.code.localeCompare(b.role.code) || a.user.displayName.localeCompare(b.user.displayName))
      .slice(0, ASSIGNMENTS_MAX);
    return { items };
  }

  async assign(body: unknown): Promise<SsoAssignmentView> {
    const { companyId, userId: me } = caller();
    await this.assertCompanyWide(P.assign);
    const input = valid(validateAssignment(body));
    if (input.userId === me) throw new ProblemException(409, 'sso-assign-self', 'Nobody assigns an app role to themselves: ask another administrator.');
    const members = await this.memberMap(companyId);
    const issues: FieldIssue[] = [];
    if (!members.has(input.userId)) issues.push({ field: 'userId', code: 'not_member', message: 'This user is not a member of the company.' });
    const role = await this.repo.role(companyId, input.roleId);
    if (!role) issues.push({ field: 'roleId', code: 'unknown', message: 'Unknown app role.' });
    if (issues.length > 0 || !role) throw new ValidationProblemException(issues);
    if ((await this.repo.assignments(companyId, { roleId: role.id, userId: input.userId })).length > 0) {
      const message = 'This user already holds this role.';
      throw new ProblemException(409, 'sso-assignment-duplicate', message, fieldError('roleId', 'duplicate', message));
    }
    const id = await this.repo.insertAssignment(companyId, role.id, input.userId, me);
    const [row] = await this.repo.assignments(companyId, { id });
    if (!row) throw new Error('assignment vanished');
    await this.audit.record({ type: 'sso.role_assigned', subject: { type: 'user', id: input.userId }, data: { clientId: row.clientId, roleCode: row.roleCode, assignmentId: id } });
    return this.assignmentView(row, members, true, me);
  }

  async unassign(id: string): Promise<void> {
    const { companyId, userId: me } = caller();
    const [row] = await this.repo.assignments(companyId, { id });
    if (!row) throw new NotFoundException('Assignment not found');
    await this.assertCompanyWide(P.assign);
    if (row.userId === me) throw new ProblemException(409, 'sso-assign-self', 'Nobody removes their own app role: ask another administrator.');
    await this.repo.deleteAssignment(companyId, id);
    await this.audit.record({ type: 'sso.role_removed', subject: { type: 'user', id: row.userId }, data: { clientId: row.clientId, roleCode: row.roleCode, assignmentId: id } });
  }
}
