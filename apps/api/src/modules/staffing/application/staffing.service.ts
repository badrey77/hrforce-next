import { Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import { AuditEvents } from '../../../platform/audit/audit-events.js';
import { ScopeService } from '../../../platform/authz/scope-service.js';
import { currentTx, requireContext } from '../../../platform/context/request-context.js';
import { ProblemException, ValidationProblemException } from '../../../platform/http/problem-details.js';
import { pickManager, type ManagerResolution } from '../domain/manager.js';
import { StaffingRepository, type EmployeeCardRow } from '../infra/staffing.repository.js';
import { StaffingClock } from './staffing-clock.js';

export interface EmployeeCard {
  id: string;
  matricule: string;
  person: { id: string; lastName: string; firstName: string; lastNameAr: string | null; firstNameAr: string | null };
  unit: { id: string; code: string; kind: string; name: string; nameAr: string | null };
  jobTitle: string;
  hireDate: string;
  endDate: string | null;
}

export interface UnitRef {
  id: string;
  code: string;
  name: string;
  nameAr: string | null;
  kind: string;
}

export interface MyEmploymentView extends EmployeeCard {
  /** today's manager (nearest head up the tree who is not me), or null */
  manager: EmployeeCard | null;
  /** the units I head today (docs/contracts/attendance.md › Module boundaries: the web's "Mon équipe" entry), [] when none */
  headOf: UnitRef[];
}

/** The SSO `employee` claim (docs/contracts/sso.md › Claims). */
export interface EmployeeClaim {
  matricule: string;
  /** the employment is open on the date */
  active: boolean;
  /** the unit of the assignment valid on the date; null when none */
  unit: { id: string; code: string; name: string; nameAr: string | null } | null;
}

export interface UserEmploymentView {
  userId: string;
  employment: EmployeeCard | null;
}

export interface HeadView {
  id: string;
  employment: EmployeeCard;
  validFrom: string;
  validTo: string | null;
}

export interface UnitHeadsView {
  unitId: string;
  /** head on today's date, or null */
  head: HeadView | null;
  /** every head, newest first */
  heads: HeadView[];
}

const PERM = { orgRead: 'org_unit.read', orgUpdate: 'org_unit.update', grant: 'access.grant' } as const;

function tenant(): { companyId: string; userId: string } {
  const { companyId, userId } = requireContext();
  if (!companyId || !userId) throw new NotFoundException();
  return { companyId, userId };
}

export function toCard(r: EmployeeCardRow): EmployeeCard {
  return {
    id: r.id,
    matricule: r.matricule,
    person: { id: r.personId, lastName: r.lastName, firstName: r.firstName, lastNameAr: r.lastNameAr, firstNameAr: r.firstNameAr },
    unit: { id: r.unitId, code: r.unitCode, kind: r.unitKind, name: r.unitName, nameAr: r.unitNameAr },
    jobTitle: r.jobTitle,
    hireDate: r.hireDate,
    endDate: r.endDate,
  };
}

function conflict(slug: string, message: string, field?: string): ProblemException {
  return new ProblemException(409, slug, message, field ? [{ field, code: slug.replace(/-/g, '_'), message }] : undefined);
}

/**
 * Self-service links and unit heads (docs/contracts/leave.md › Links added to M1 data) + manager resolution.
 * Everything runs in the request transaction; scope from the platform ScopeService.
 */
@Injectable()
export class StaffingService {
  constructor(
    private readonly repo: StaffingRepository,
    private readonly scopes: ScopeService,
    private readonly clock: StaffingClock,
    private readonly audit: AuditEvents,
  ) {}

  // ── reads used by other modules ─────────────────────────────────────────────────────────────────────────────────

  /** The employment linked to a user (null = none). */
  async linkedEmploymentOf(userId: string): Promise<string | null> {
    const { companyId } = tenant();
    return (await this.repo.linkOfUser(companyId, userId)) ?? null;
  }

  /**
   * The SSO `employee` claim of `userId` on `date` (Algiers date), read in the current transaction (the claims
   * transaction of the client's company); null when the user is not linked to an employment of this company.
   */
  async employeeClaim(userId: string, date: string): Promise<EmployeeClaim | null> {
    const { companyId } = requireContext();
    if (!companyId) return null;
    const row = await this.repo.employeeClaim(companyId, userId, date);
    if (!row) return null;
    return {
      matricule: row.matricule,
      active: row.active,
      unit: row.unitId && row.unitCode ? { id: row.unitId, code: row.unitCode, name: row.unitName ?? row.unitCode, nameAr: row.unitNameAr } : null,
    };
  }

  /** employmentId → linked user id. */
  async linkedUsersOf(employmentIds: readonly string[]): Promise<Map<string, string>> {
    const { companyId } = tenant();
    return this.repo.usersOfEmployments(companyId, [...new Set(employmentIds)]);
  }

  /** Employee cards (person + scope unit as of `date`, default today), by id. */
  async cards(ids: readonly string[], date = this.clock.today()): Promise<Map<string, EmployeeCard>> {
    const { companyId } = tenant();
    const rows = await this.repo.cards(companyId, [...new Set(ids)], date);
    return new Map(rows.map((r) => [r.id, toCard(r)]));
  }

  /** Units whose head on `date` is `employmentId` (docs/contracts/attendance.md › Team view). */
  async unitsHeadedBy(employmentId: string, date: string): Promise<string[]> {
    const { companyId } = tenant();
    return (await this.repo.unitsHeadedBy(companyId, employmentId, date)).map((u) => u.id);
  }

  /** The manager of an employment on `date` (contract rule; see domain/manager.ts). */
  async managerOf(employmentId: string, date: string): Promise<ManagerResolution> {
    const { companyId } = tenant();
    const [card] = await this.repo.cards(companyId, [employmentId], date);
    if (!card) return { kind: 'none', reason: 'no-manager' };
    return pickManager(await this.repo.chain(companyId, card.unitId, date), employmentId);
  }

  // ── GET /me/employment ─────────────────────────────────────────────────────────────────────────────────────────

  async myEmployment(): Promise<MyEmploymentView> {
    const { companyId, userId } = tenant();
    const employmentId = await this.repo.linkOfUser(companyId, userId);
    if (!employmentId) throw new NotFoundException('No employment is linked to your account');
    const today = this.clock.today();
    const [row] = await this.repo.cards(companyId, [employmentId], today);
    if (!row) throw new NotFoundException('No employment is linked to your account');
    const manager = pickManager(await this.repo.chain(companyId, row.unitId, today), employmentId);
    const managerId = manager.kind === 'user' || manager.reason === 'manager-not-linked' ? manager.employmentId : null;
    const [managerRow] = managerId ? await this.repo.cards(companyId, [managerId], today) : [];
    const headOf = await this.repo.unitsHeadedBy(companyId, employmentId, today);
    return { ...toCard(row), manager: managerRow ? toCard(managerRow) : null, headOf };
  }

  // ── PUT /access/users/:id/employment ───────────────────────────────────────────────────────────────────────────

  /**
   * Links (or, with null, unlinks) a member to an employment. The member must be visible to the caller (no grant at
   * all, or a grant on a unit of the caller's access.grant scope — else 404 like an unknown id); the employment's
   * scope unit must be in that scope too (else 422 `employmentId` not_found). Nobody links themselves (409
   * `link-self`); an employment has at most one user (409 `employment-linked`); an ended employment cannot be linked
   * (409 `employment-ended`).
   */
  async setUserEmployment(targetUserId: string, employmentId: string | null): Promise<UserEmploymentView> {
    const { companyId, userId } = tenant();
    const members = await this.repo.members(companyId);
    if (!members.some((m) => m.id === targetUserId)) throw new NotFoundException('User not found');
    const grantable = await this.scopes.unitIds(PERM.grant);
    const grantUnits = await this.grantUnitsOf(companyId, targetUserId);
    if (grantUnits.length > 0 && !grantUnits.some((u) => grantable.has(u))) throw new NotFoundException('User not found');
    if (targetUserId === userId) throw conflict('link-self', 'You cannot link your own account to an employment.', 'employmentId');

    const today = this.clock.today();
    const current = await this.repo.linkOfUser(companyId, targetUserId);
    if (current) {
      const [row] = await this.repo.cards(companyId, [current], today);
      if (row && !grantable.has(row.unitId)) {
        throw new ProblemException(403, 'forbidden-scope', 'The current link is outside your access.grant scope.');
      }
    }
    if (employmentId === null) {
      if (current) {
        await this.repo.unlink(companyId, targetUserId);
        await this.audit.record({ type: 'access.employment_unlinked', subject: { type: 'user', id: targetUserId }, data: { employmentId: current } });
      }
      return { userId: targetUserId, employment: null };
    }
    const [row] = await this.repo.cards(companyId, [employmentId], today);
    if (!row || !grantable.has(row.unitId)) {
      throw new ValidationProblemException([{ field: 'employmentId', code: 'not_found', message: 'The employee does not exist.' }]);
    }
    if (current !== employmentId) {
      if (row.endDate !== null && row.endDate < today) throw conflict('employment-ended', 'This employment has ended.', 'employmentId');
      const holder = (await this.repo.usersOfEmployments(companyId, [employmentId])).get(employmentId);
      if (holder) throw conflict('employment-linked', 'This employee is already linked to another user.', 'employmentId');
      if (current) await this.repo.unlink(companyId, targetUserId);
      await this.repo.link(companyId, targetUserId, employmentId, userId);
      await this.audit.record({ type: 'access.employment_linked', subject: { type: 'user', id: targetUserId }, data: { employmentId, previous: current ?? null } });
    }
    return { userId: targetUserId, employment: toCard(row) };
  }

  /** Units of the user's current and future grants. */
  private async grantUnitsOf(companyId: string, userId: string): Promise<string[]> {
    const today = this.clock.today();
    const rows = await currentTx()
      .selectFrom('role_grant')
      .select('org_unit_id')
      .where('company_id', '=', companyId)
      .where('user_id', '=', userId)
      .where((eb) => eb.or([eb('valid_to', 'is', null), eb('valid_to', '>', sql<Date>`${today}::date`)]))
      .execute();
    return rows.map((r) => r.org_unit_id);
  }

  // ── PUT /org/units/:id/head ────────────────────────────────────────────────────────────────────────────────────

  /**
   * Makes `employmentId` the head of the unit from `validFrom` (default today), closing the head in place on that
   * date; null ends the current head on `validFrom`. 404 when the unit is unknown or outside org_unit.read, 403
   * `forbidden-scope` without org_unit.update over it. 422 `employmentId` not_found for an unknown employee; 409
   * `head-date` when a head already starts on/after `validFrom` or the employee is not employed on `validFrom`.
   */
  async setUnitHead(unitId: string, employmentId: string | null, validFrom?: string): Promise<UnitHeadsView> {
    const { companyId } = tenant();
    if (!(await this.repo.unitExists(companyId, unitId)) || !(await this.scopes.inScope(PERM.orgRead, unitId))) {
      throw new NotFoundException('Org unit not found');
    }
    if (!(await this.scopes.inScope(PERM.orgUpdate, unitId))) {
      throw new ProblemException(403, 'forbidden-scope', 'You cannot change this unit (outside your org_unit.update scope).');
    }
    const from = validFrom ?? this.clock.today();
    const heads = await this.repo.heads(companyId, unitId);
    if (heads.some((h) => h.validFrom >= from)) {
      throw conflict('head-date', 'A head already starts on or after this date.', 'validFrom');
    }
    const covering = heads.find((h) => h.validFrom < from && (h.validTo === null || h.validTo > from));
    if (employmentId !== null) {
      const [row] = await this.repo.cards(companyId, [employmentId], from);
      if (!row) throw new ValidationProblemException([{ field: 'employmentId', code: 'not_found', message: 'The employee does not exist.' }]);
      if (row.hireDate > from || (row.endDate !== null && row.endDate < from)) {
        throw conflict('head-date', 'The employee is not employed on this date.', 'validFrom');
      }
      if (covering?.employmentId === employmentId && covering.validTo === null) return this.headsView(companyId, unitId);
    }
    if (covering) await this.repo.closeHead(companyId, covering.id, from);
    if (employmentId !== null) await this.repo.insertHead(companyId, unitId, employmentId, from);
    return this.headsView(companyId, unitId);
  }

  async headsView(companyId: string, unitId: string): Promise<UnitHeadsView> {
    const today = this.clock.today();
    const heads = await this.repo.heads(companyId, unitId);
    const cards = new Map((await this.repo.cards(companyId, heads.map((h) => h.employmentId), today)).map((r) => [r.id, toCard(r)]));
    const views = heads.flatMap((h) => {
      const employment = cards.get(h.employmentId);
      return employment ? [{ id: h.id, employment, validFrom: h.validFrom, validTo: h.validTo }] : [];
    });
    const head = views.find((h) => h.validFrom <= today && (h.validTo === null || today < h.validTo)) ?? null;
    return { unitId, head, heads: views };
  }
}
