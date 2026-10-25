import { Injectable, NotFoundException } from '@nestjs/common';
import { ScopeService } from '../../../platform/authz/scope-service.js';
import { requireContext } from '../../../platform/context/request-context.js';
import { ProblemException, ValidationProblemException } from '../../../platform/http/problem-details.js';
import { assertOpen, EmploymentRuleViolation, scopeAssignment } from '../domain/employee.js';
import {
  EMPTY_CONTACT,
  familyErrors,
  planChildren,
  sameContact,
  sameEmergency,
  type BankValues,
  type ContactValues,
  type EmergencyValues,
  type FamilyInput,
  type PersonalFieldError,
} from '../domain/personal.js';
import { constraintViolation, EmployeeRepository, type EmploymentRow } from '../infra/employee.repository.js';
import { PersonalRepository } from '../infra/personal.repository.js';
import type { NamePair, PersonalView, UnitRef } from './employee-views.js';

export type { PersonalView } from './employee-views.js';
import { EmploymentClock } from './employment-clock.js';
import { UnitSnapshots } from './unit-snapshots.js';

export const PERSONAL_PERMISSIONS = {
  read: 'employee.personal.read',
  update: 'employee.personal.update',
} as const;

/** Who applies a change: the employee (an immediate self-service change) or the HR user (an HR edit or an approval). */
export interface PersonalActor {
  userId: string;
}

/**
 * What the self-service profile shows about an employment (docs/contracts/profile-changes.md › MyProfileView), RAW:
 * the caller masks the NIN and the RIB. No permission is checked: the caller (module `profile`) has established that
 * the employment is the signed-in user's own.
 */
export interface ProfileFacts {
  employmentId: string;
  personId: string;
  matricule: string;
  person: NamePair;
  unit: UnitRef;
  jobTitle: string;
  hireDate: string;
  endDate: string | null;
  identity: { birthDate: string | null; birthPlace: string | null; nationality: string; nin: string | null };
  bank: { rib: string | null; bankName: string | null };
  personal: PersonalView;
}

function tenant(): string {
  const { companyId } = requireContext();
  if (!companyId) throw notFound();
  return companyId;
}

function notFound(): NotFoundException {
  return new NotFoundException('Employee not found');
}

function validation(errors: readonly PersonalFieldError[]): ValidationProblemException {
  return new ValidationProblemException([...errors]);
}

/** employment-ended → 409, the children backstop → 422; anything else unchanged. */
function toProblem(error: unknown): unknown {
  if (error instanceof EmploymentRuleViolation) return new ProblemException(409, error.slug, error.message);
  if (constraintViolation(error)?.constraint === 'person_child_max_ck') {
    return validation([{ field: 'children', code: 'too_many', message: 'At most 15 children.' }]);
  }
  return error;
}

async function problems<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw toProblem(error);
  }
}

/**
 * Personal details of an employee (docs/contracts/profile-changes.md › Employment additions): HR's edits behind
 * employee.personal.update, and the `apply*` use cases the `profile` module calls when it applies a request. Everything
 * runs in the request transaction (the repositories take it from the RequestContext), so the profile module's writes
 * and these commit or roll back together.
 */
@Injectable()
export class PersonalDetailsService {
  constructor(
    private readonly repo: EmployeeRepository,
    private readonly personal: PersonalRepository,
    private readonly scopes: ScopeService,
    private readonly clock: EmploymentClock,
  ) {}

  // ── HR endpoints ──────────────────────────────────────────────────────────────────────────────────────────────

  async setContact(id: string, input: ContactValues): Promise<PersonalView> {
    const employment = await this.loadForWrite(id);
    return this.applyContactTo(employment, input, this.signedIn());
  }

  async setEmergency(id: string, input: EmergencyValues | null): Promise<PersonalView> {
    const employment = await this.loadForWrite(id);
    return this.applyEmergencyTo(employment, input, this.signedIn());
  }

  async setFamily(id: string, input: FamilyInput): Promise<PersonalView> {
    const employment = await this.loadForWrite(id);
    return this.applyFamilyTo(employment, input, this.signedIn());
  }

  // ── for module `profile` (no permission check; the employment must exist and be open) ──────────────────────────

  /** The section values of an employment's person (404 when the employment is unknown). */
  async personalOf(employmentId: string): Promise<PersonalView> {
    const employment = await this.find(employmentId);
    return this.view(tenant(), employment.personId);
  }

  /** Identity, bank (raw), personal details, unit and job of an employment, for « Mon profil ». */
  async profileFacts(employmentId: string): Promise<ProfileFacts> {
    const companyId = tenant();
    const employment = await this.find(employmentId);
    const today = this.clock.today();
    const [person, sensitive, assignments, versions, personal] = await Promise.all([
      this.repo.findPerson(companyId, employment.personId),
      this.repo.findSensitive(companyId, employment.personId),
      this.repo.listAssignments(companyId, employment.id),
      this.repo.unitVersions(companyId),
      this.view(companyId, employment.personId),
    ]);
    if (!person) throw notFound();
    const shown = scopeAssignment(assignments, today);
    const unit = shown ? new UnitSnapshots(versions).at(today).get(shown.orgUnitId) : undefined;
    return {
      employmentId: employment.id,
      personId: employment.personId,
      matricule: employment.matricule,
      person: { lastName: person.lastName, firstName: person.firstName, lastNameAr: person.lastNameAr, firstNameAr: person.firstNameAr },
      unit: { id: shown?.orgUnitId ?? '', code: unit?.code ?? '', name: unit?.name ?? '', nameAr: unit?.nameAr ?? null, kind: unit?.kind ?? '' },
      jobTitle: shown?.jobTitle ?? '',
      hireDate: employment.hireDate,
      endDate: employment.endDate,
      identity: { birthDate: person.birthDate, birthPlace: person.birthPlace, nationality: person.nationality, nin: person.nin },
      bank: { rib: sensitive?.rib ?? null, bankName: sensitive?.bankName ?? null },
      personal,
    };
  }

  /**
   * The family rules that need the person's children and today's date (paths relative to the section, e.g.
   * `children.2.birthDate`); [] = valid. The `apply*` use cases check them too (422).
   */
  async familyProblems(employmentId: string, input: FamilyInput): Promise<PersonalFieldError[]> {
    const employment = await this.find(employmentId);
    const children = await this.personal.listChildren(tenant(), employment.personId);
    return familyErrors(input, new Set(children.map((c) => c.id)), this.clock.today());
  }

  async applyContact(employmentId: string, input: ContactValues, actor: PersonalActor): Promise<PersonalView> {
    return this.applyContactTo(await this.findOpen(employmentId), input, actor);
  }

  /** `null` removes the emergency contact. */
  async applyEmergency(employmentId: string, input: EmergencyValues | null, actor: PersonalActor): Promise<PersonalView> {
    return this.applyEmergencyTo(await this.findOpen(employmentId), input, actor);
  }

  /** The full children list: items with an id are updated, without one created, missing ones deleted. */
  async applyFamily(employmentId: string, input: FamilyInput, actor: PersonalActor): Promise<PersonalView> {
    return this.applyFamilyTo(await this.findOpen(employmentId), input, actor);
  }

  /** RIB and bank name (person_sensitive, as PUT /employees/:id/bank). `actor` is recorded by the audit trigger. */
  async applyBank(employmentId: string, input: BankValues, actor: PersonalActor): Promise<{ rib: string | null; bankName: string | null }> {
    void actor;
    const employment = await this.findOpen(employmentId);
    const companyId = tenant();
    await this.repo.upsertSensitive(companyId, employment.personId, { rib: input.rib, bankName: input.bankName });
    const sensitive = await this.repo.findSensitive(companyId, employment.personId);
    return { rib: sensitive?.rib ?? null, bankName: sensitive?.bankName ?? null };
  }

  /** Whether the caller holds employee.personal.read / update over a unit (the detail's block and action). */
  async can(unitId: string): Promise<{ read: boolean; update: boolean }> {
    const [read, update] = await Promise.all([this.scopes.inScope(PERSONAL_PERMISSIONS.read, unitId), this.scopes.inScope(PERSONAL_PERMISSIONS.update, unitId)]);
    return { read, update };
  }

  /** The detail's `personal` block (the caller checked employee.personal.read). */
  async viewOfPerson(personId: string): Promise<PersonalView> {
    return this.view(tenant(), personId);
  }

  // ── internals ─────────────────────────────────────────────────────────────────────────────────────────────────

  private async applyContactTo(employment: EmploymentRow, input: ContactValues, actor: PersonalActor): Promise<PersonalView> {
    const companyId = tenant();
    return problems(async () => {
      await this.personal.lockPerson(companyId, employment.personId);
      const current = await this.personal.findContact(companyId, employment.personId);
      // unchanged → no write (no audit row, updatedAt kept)
      if (!sameContact(current ?? EMPTY_CONTACT, input)) {
        await this.personal.upsertContact(companyId, employment.personId, input, actor.userId);
      }
      return this.view(companyId, employment.personId);
    });
  }

  private async applyEmergencyTo(employment: EmploymentRow, input: EmergencyValues | null, actor: PersonalActor): Promise<PersonalView> {
    const companyId = tenant();
    return problems(async () => {
      await this.personal.lockPerson(companyId, employment.personId);
      const current = (await this.personal.findEmergency(companyId, employment.personId)) ?? null;
      if (!sameEmergency(current, input)) {
        if (input === null) await this.personal.deleteEmergency(companyId, employment.personId);
        else await this.personal.upsertEmergency(companyId, employment.personId, input, actor.userId);
      }
      return this.view(companyId, employment.personId);
    });
  }

  private async applyFamilyTo(employment: EmploymentRow, input: FamilyInput, actor: PersonalActor): Promise<PersonalView> {
    const companyId = tenant();
    return problems(async () => {
      await this.personal.lockPerson(companyId, employment.personId);
      const children = await this.personal.listChildren(companyId, employment.personId);
      const errors = familyErrors(input, new Set(children.map((c) => c.id)), this.clock.today());
      if (errors.length) throw validation(errors);
      const current = await this.personal.findFamily(companyId, employment.personId);
      const status = { maritalStatus: input.maritalStatus, maritalStatusSince: input.maritalStatusSince, spouseEmployed: input.spouseEmployed };
      const statusChanged =
        current === undefined
          ? status.maritalStatus !== null || status.maritalStatusSince !== null || status.spouseEmployed !== null
          : current.maritalStatus !== status.maritalStatus || current.maritalStatusSince !== status.maritalStatusSince || current.spouseEmployed !== status.spouseEmployed;
      if (statusChanged) await this.personal.upsertFamily(companyId, employment.personId, status, actor.userId);
      const plan = planChildren(children, input.children);
      // deletions first: a full list replacing all 15 children stays within the limit
      await this.personal.deleteChildren(companyId, employment.personId, plan.remove.map((c) => c.id));
      for (const child of plan.update) await this.personal.updateChild(companyId, employment.personId, child);
      for (const child of plan.insert) await this.personal.insertChild(companyId, employment.personId, child);
      return this.view(companyId, employment.personId);
    });
  }

  private async view(companyId: string, personId: string): Promise<PersonalView> {
    const [contact, emergency, family, children] = await Promise.all([
      this.personal.findContact(companyId, personId),
      this.personal.findEmergency(companyId, personId),
      this.personal.findFamily(companyId, personId),
      this.personal.listChildren(companyId, personId),
    ]);
    return {
      contact: contact ?? { ...EMPTY_CONTACT, updatedAt: null },
      emergencyContact: emergency ?? null,
      family: {
        maritalStatus: family?.maritalStatus ?? null,
        maritalStatusSince: family?.maritalStatusSince ?? null,
        spouseEmployed: family?.spouseEmployed ?? null,
        children: children.map((c) => ({ id: c.id, firstName: c.firstName, birthDate: c.birthDate, sex: c.sex, dependent: c.dependent })),
      },
    };
  }

  private signedIn(): PersonalActor {
    const { userId } = requireContext();
    if (!userId) throw notFound();
    return { userId };
  }

  private async find(employmentId: string): Promise<EmploymentRow> {
    const employment = await this.repo.findEmployment(tenant(), employmentId);
    if (!employment) throw notFound();
    return employment;
  }

  private async findOpen(employmentId: string): Promise<EmploymentRow> {
    return this.findOpenRow(await this.find(employmentId));
  }

  /**
   * HR write: readable with employee.read over the scope unit (else 404), employee.personal.update there (else 403
   * forbidden-scope), still open (else 409 employment-ended) — the same order as the other employee writes.
   */
  private async loadForWrite(id: string): Promise<EmploymentRow> {
    const companyId = tenant();
    const employment = await this.repo.findEmployment(companyId, id);
    if (!employment) throw notFound();
    const unitId = scopeAssignment(await this.repo.listAssignments(companyId, id), this.clock.today())?.orgUnitId;
    if (!unitId || !(await this.scopes.inScope('employee.read', unitId))) throw notFound();
    if (!(await this.scopes.inScope(PERSONAL_PERMISSIONS.update, unitId))) {
      throw new ProblemException(403, 'forbidden-scope', `You cannot change this employee (outside your ${PERSONAL_PERMISSIONS.update} scope).`);
    }
    return this.findOpenRow(employment);
  }

  private findOpenRow(employment: EmploymentRow): EmploymentRow {
    try {
      assertOpen(employment.endDate);
    } catch (error) {
      throw toProblem(error);
    }
    return employment;
  }
}
