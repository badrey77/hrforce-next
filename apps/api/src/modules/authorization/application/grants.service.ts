import { Injectable, NotFoundException } from '@nestjs/common';
import { AuditEvents } from '../../../platform/audit/audit-events.js';
import { ScopeService } from '../../../platform/authz/scope-service.js';
import { ValidationProblemException } from '../../../platform/http/problem-details.js';
import {
  AccessRuleViolation,
  assertEndDate,
  assertNewGrantDates,
  assertNotSelf,
  isCurrentOrFuture,
} from '../domain/access-rules.js';
import { ACCESS_PERMISSIONS } from '../domain/catalogue.js';
import { AccessClock } from '../infra/access-clock.js';
import { AccessRepository, constraintViolation, type GrantRow, type MemberRow } from '../infra/access.repository.js';
import type { AccessUserView, GrantView, ItemsView } from './access-views.js';
import { callerId, tenant } from './tenant.js';

export interface CreateGrantInput {
  userId: string;
  roleId: string;
  orgUnitId: string;
  includeDescendants: boolean;
  validFrom?: string | undefined;
  validTo?: string | null | undefined;
}

export interface ListGrantsInput {
  userId?: string | undefined;
  unitId?: string | undefined;
  includeEnded?: boolean | undefined;
}

export const USER_LIST_LIMIT = 200;

/** Case- and accent-insensitive contains. */
function fold(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function userNotFound(): NotFoundException {
  return new NotFoundException('User not found');
}

function grantNotFound(): NotFoundException {
  return new NotFoundException('Grant not found');
}

/**
 * Grants and the member list (docs/contracts/authorization.md). Scope: reading is limited to grants whose unit is in
 * the caller's `access.read` scope; granting/ending needs `access.grant` over the unit (and its whole subtree when the
 * grant includes sub-units). Separation of duties: grant-self, grant-out-of-scope, grant-escalation,
 * grant-user-not-member, grant-dates.
 */
@Injectable()
export class GrantsService {
  constructor(
    private readonly repo: AccessRepository,
    private readonly scopes: ScopeService,
    private readonly clock: AccessClock,
    private readonly audit: AuditEvents,
  ) {}

  async listGrants(input: ListGrantsInput): Promise<ItemsView<GrantView>> {
    const companyId = tenant();
    const rows = await this.repo.grants(companyId, {
      ...(input.userId ? { userId: input.userId } : {}),
      ...(input.unitId ? { unitId: input.unitId } : {}),
      includeEnded: input.includeEnded ?? false,
      today: this.clock.today(),
      unitScope: await this.scopes.scopeOf(ACCESS_PERMISSIONS.read),
    });
    return { items: await this.toViews(rows, await this.repo.members(companyId)) };
  }

  /**
   * Members of the company, each with their current and future grants inside the caller's access.read scope.
   * A member is listed when at least one of their current/future grants is in that scope, or when they have none
   * (so that new users can be granted).
   */
  async listUsers(q?: string): Promise<ItemsView<AccessUserView>> {
    const companyId = tenant();
    const today = this.clock.today();
    const members = await this.repo.members(companyId);
    const all = await this.repo.grants(companyId, { includeEnded: false, today });
    const readable = await this.scopes.unitIds(ACCESS_PERMISSIONS.read);
    const views = await this.toViews(
      all.filter((g) => readable.has(g.unit.id)),
      members,
    );
    const withGrants = new Set(all.map((g) => g.userId));
    const visibleGrants = new Map<string, GrantView[]>();
    for (const view of views) visibleGrants.set(view.userId, [...(visibleGrants.get(view.userId) ?? []), view]);
    const links = await this.repo.linkedEmployments(companyId);
    const needle = q ? fold(q) : undefined;
    const items = members
      .filter((m) => !withGrants.has(m.id) || visibleGrants.has(m.id))
      .filter((m) => !needle || fold(m.displayName).includes(needle) || fold(m.email).includes(needle))
      .slice(0, USER_LIST_LIMIT)
      .map((m) => ({ id: m.id, email: m.email, displayName: m.displayName, status: m.status, grants: visibleGrants.get(m.id) ?? [], employment: links.get(m.id) ?? null }));
    return { items };
  }

  /**
   * One member (GET /access/users/:id), same shape and visibility rule as an item of {@link listUsers}: listed only
   * when they have ≥ 1 current/future grant in the caller's access.read scope, or none at all; otherwise — like an
   * unknown or other-company id — 404.
   */
  async getUser(id: string): Promise<AccessUserView> {
    const companyId = tenant();
    const today = this.clock.today();
    const members = await this.repo.members(companyId);
    const member = members.find((m) => m.id === id);
    if (!member) throw userNotFound();
    const all = await this.repo.grants(companyId, { userId: id, includeEnded: false, today });
    const readable = await this.scopes.unitIds(ACCESS_PERMISSIONS.read);
    const inScope = all.filter((g) => readable.has(g.unit.id));
    if (all.length > 0 && inScope.length === 0) throw userNotFound();
    return {
      id: member.id,
      email: member.email,
      displayName: member.displayName,
      status: member.status,
      grants: await this.toViews(inScope, members),
      employment: (await this.repo.linkedEmployments(companyId)).get(id) ?? null,
    };
  }

  async createGrant(input: CreateGrantInput): Promise<GrantView> {
    const companyId = tenant();
    const caller = callerId();
    const validFrom = input.validFrom ?? this.clock.today();
    const validTo = input.validTo ?? null;
    assertNewGrantDates(validFrom, validTo);
    assertNotSelf(caller, input.userId, 'grant');

    const [role] = await this.repo.roles(companyId, [input.roleId]);
    if (!role) {
      throw new ValidationProblemException([{ field: 'roleId', code: 'not_found', message: 'The role does not exist.' }]);
    }
    const members = await this.repo.members(companyId);
    if (!members.some((m) => m.id === input.userId)) {
      throw new AccessRuleViolation('grant-user-not-member', 'The user is not a member of this company.', 'userId');
    }
    // unknown / other-tenant units are "out of scope" too (no existence oracle)
    if (!(await this.scopes.covers(ACCESS_PERMISSIONS.grant, input.orgUnitId, input.includeDescendants))) {
      throw new AccessRuleViolation(
        'grant-out-of-scope',
        input.includeDescendants
          ? 'The unit and all its sub-units must be inside your access.grant scope.'
          : 'The unit must be inside your access.grant scope.',
        'orgUnitId',
      );
    }
    const missing: string[] = [];
    for (const code of role.permissions) {
      if (!(await this.scopes.covers(code, input.orgUnitId, input.includeDescendants))) missing.push(code);
    }
    if (missing.length > 0) {
      throw new AccessRuleViolation(
        'grant-escalation',
        `You cannot grant permissions you do not hold over this unit${input.includeDescendants ? ' and its sub-units' : ''}: ${missing.join(', ')}.`,
        'roleId',
      );
    }

    let id: string;
    try {
      id = await this.repo.insertGrant(companyId, {
        userId: input.userId,
        roleId: input.roleId,
        orgUnitId: input.orgUnitId,
        includeDescendants: input.includeDescendants,
        validFrom,
        validTo,
        grantedBy: caller,
      });
    } catch (error) {
      if (constraintViolation(error)?.constraint === 'role_grant_no_overlap_ex') {
        throw new AccessRuleViolation('grant-duplicate', 'The user already holds this role on this unit for an overlapping period.', 'roleId');
      }
      throw error;
    }
    const view = await this.getGrant(companyId, id, members);
    await this.recordGrantEvent('access.grant_created', view);
    return view;
  }

  async endGrant(id: string, validTo: string): Promise<GrantView> {
    const companyId = tenant();
    const caller = callerId();
    const grant = await this.readableGrant(companyId, id);
    assertNotSelf(caller, grant.userId, 'end');
    if (!(await this.scopes.covers(ACCESS_PERMISSIONS.grant, grant.unit.id, grant.includeDescendants))) {
      throw new AccessRuleViolation('grant-out-of-scope', 'The grant’s unit is outside your access.grant scope.', 'orgUnitId');
    }
    assertEndDate(grant, validTo);
    await this.repo.endGrant(companyId, id, validTo, caller);
    const view = await this.getGrant(companyId, id, await this.repo.members(companyId));
    await this.recordGrantEvent('access.grant_ended', view);
    return view;
  }

  /** docs/contracts/audit.md › Application events (in addition to the role_grant row trigger). */
  private recordGrantEvent(type: 'access.grant_created' | 'access.grant_ended', grant: GrantView): Promise<void> {
    return this.audit.record({
      type,
      subject: { type: 'user', id: grant.userId },
      data: { grantId: grant.id, roleCode: grant.role.code, unitId: grant.unit.id, validFrom: grant.validFrom, validTo: grant.validTo },
    });
  }

  /** A grant whose unit is in the caller's access.read scope; else 404. */
  private async readableGrant(companyId: string, id: string): Promise<GrantRow> {
    const [grant] = await this.repo.grants(companyId, {
      ids: [id],
      includeEnded: true,
      today: this.clock.today(),
      unitScope: await this.scopes.scopeOf(ACCESS_PERMISSIONS.read),
    });
    if (!grant) throw grantNotFound();
    return grant;
  }

  private async getGrant(companyId: string, id: string, members: readonly MemberRow[]): Promise<GrantView> {
    const [grant] = await this.repo.grants(companyId, { ids: [id], includeEnded: true, today: this.clock.today() });
    if (!grant) throw grantNotFound();
    const [view] = await this.toViews([grant], members);
    if (!view) throw grantNotFound();
    return view;
  }

  private async toViews(rows: readonly GrantRow[], members: readonly MemberRow[]): Promise<GrantView[]> {
    const names = new Map(members.map((m) => [m.id, m.displayName]));
    const caller = callerId();
    const today = this.clock.today();
    const views: GrantView[] = [];
    for (const g of rows) {
      const canEnd =
        g.userId !== caller && isCurrentOrFuture(g, today) && (await this.scopes.covers(ACCESS_PERMISSIONS.grant, g.unit.id, g.includeDescendants));
      const granter = g.grantedBy ? names.get(g.grantedBy) : undefined;
      views.push({
        id: g.id,
        userId: g.userId,
        role: { id: g.role.id, code: g.role.code, names: { ...g.role.names } },
        unit: { ...g.unit },
        includeDescendants: g.includeDescendants,
        validFrom: g.validFrom,
        validTo: g.validTo,
        grantedBy: g.grantedBy && granter !== undefined ? { id: g.grantedBy, displayName: granter } : null,
        grantedAt: g.grantedAt,
        _actions: canEnd ? ['end'] : [],
      });
    }
    return views;
  }
}
