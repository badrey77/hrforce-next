import { Injectable, NotFoundException } from '@nestjs/common';
import { ScopeService } from '../../../platform/authz/scope-service.js';
import { requireContext } from '../../../platform/context/request-context.js';
import { ProblemException, ValidationProblemException, type FieldError } from '../../../platform/http/problem-details.js';
import {
  assertOpen,
  assertRehireDate,
  byStart,
  employeeActions,
  EmploymentRuleViolation,
  hasOpenEmployment,
  planAssignment,
  planEnd,
  planSalary,
  referenceDate,
  scopeAssignment,
  statusOf,
  type EmployeeSort,
  type ListLang,
  type EndReason,
  type FieldBlock,
  type StatusFilter,
} from '../domain/employee.js';
import {
  constraintViolation,
  EmployeeRepository,
  type AssignmentRow,
  type EmploymentRow,
  type ListRow,
  type PersonPatch,
  type PersonRow,
} from '../infra/employee.repository.js';
import type { AssignmentView, EmployeeDetail, EmployeeListItem, EmployeeListView, KnownPerson, SiteRef, UnitRef } from './employee-views.js';
import { EmploymentClock } from './employment-clock.js';
import { UnitSnapshots } from './unit-snapshots.js';

export const EMPLOYEE_PERMISSIONS = {
  read: 'employee.read',
  create: 'employee.create',
  update: 'employee.update',
  salaryRead: 'employee.salary.read',
  salaryUpdate: 'employee.salary.update',
  bankRead: 'employee.bank.read',
  bankUpdate: 'employee.bank.update',
  nssRead: 'employee.nss.read',
  nssUpdate: 'employee.nss.update',
} as const;

const P = EMPLOYEE_PERMISSIONS;

/** Update permission of each field block (POST /employees `forbidden-field`, PUT /employees/:id/<block>). */
const BLOCK_UPDATE: Record<FieldBlock, string> = { salary: P.salaryUpdate, bank: P.bankUpdate, nss: P.nssUpdate };

export interface ListEmployeesInput {
  q?: string | undefined;
  unitId?: string | undefined;
  includeSubUnits: boolean;
  siteId?: string | undefined;
  status: StatusFilter;
  asOf?: string | undefined;
  sort: EmployeeSort;
  dir: 'asc' | 'desc';
  /** optional: `fr` when absent */
  lang?: ListLang | undefined;
  page: number;
  pageSize: number;
}

export interface PersonInput {
  lastName: string;
  firstName: string;
  lastNameAr?: string | null | undefined;
  firstNameAr?: string | null | undefined;
  birthDate?: string | null | undefined;
  birthPlace?: string | null | undefined;
  sex?: 'M' | 'F' | null | undefined;
  nationality?: string | undefined;
  nin?: string | null | undefined;
}

export interface CreateEmployeeInput extends Partial<PersonInput> {
  /** Rehire: reuse this person (the person fields are then not accepted). */
  personId?: string | undefined;
  matricule: string;
  hireDate: string;
  orgUnitId: string;
  siteId?: string | null | undefined;
  jobTitle: string;
  salary?: { baseSalary: string } | undefined;
  bank?: { rib: string | null; bankName: string | null } | undefined;
  nss?: { nss: string | null } | undefined;
}

export interface AssignInput {
  orgUnitId: string;
  siteId?: string | null | undefined;
  jobTitle: string;
  validFrom: string;
}

function tenant(): string {
  const { companyId } = requireContext();
  if (!companyId) throw notFound();
  return companyId;
}

function notFound(): NotFoundException {
  return new NotFoundException('Employee not found');
}

/** Readable but not writable (docs/contracts/authorization.md › scope rules): 403 `forbidden-scope`. */
function forbiddenScope(detail: string, field?: string): ProblemException {
  return new ProblemException(403, 'forbidden-scope', detail, field ? [{ field, code: 'forbidden_scope', message: detail }] : undefined);
}

function invalid(field: string, code: string, message: string): ValidationProblemException {
  return new ValidationProblemException([{ field, code, message }]);
}

/** Domain rule violations → 409 problem+json (`errors[]` on the offending body field when there is one). */
function toProblem(error: unknown): unknown {
  if (error instanceof EmploymentRuleViolation) {
    const errors = error.field ? [{ field: error.field, code: error.slug.replace(/-/g, '_'), message: error.message }] : undefined;
    return new ProblemException(409, error.slug, error.message, errors);
  }
  const violation = constraintViolation(error);
  switch (violation?.constraint) {
    case 'employment_company_matricule_uk':
      return toProblem(new EmploymentRuleViolation('matricule-taken', 'This matricule is already used in this company.', 'matricule'));
    case 'person_company_nin_uk':
      return toProblem(new EmploymentRuleViolation('nin-taken', 'This NIN is already recorded for another person.', 'nin'));
    case 'employment_one_open_uk':
      return toProblem(new EmploymentRuleViolation('employment-open', 'This person already has an open employment.', 'personId'));
    case 'employment_no_overlap_ex':
      return toProblem(new EmploymentRuleViolation('hire-date', 'The employment overlaps a previous employment of this person.', 'hireDate'));
    case 'assignment_no_overlap_ex':
      return toProblem(new EmploymentRuleViolation('assignment-date', 'The assignment overlaps an existing one.', 'validFrom'));
    case 'employment_salary_no_overlap_ex':
      return toProblem(new EmploymentRuleViolation('salary-date', 'The salary overlaps an existing version.', 'validFrom'));
    default:
      return error;
  }
}

async function problems<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw toProblem(error);
  }
}

interface Loaded {
  companyId: string;
  employment: EmploymentRow;
  assignments: AssignmentRow[];
  /** Unit of the scope assignment as of today (contract › Scope). */
  unitId: string;
}

/**
 * Use cases of the Employment module (docs/contracts/employment.md). Everything runs in the request transaction.
 * Scope: an employment is in scope for P when the unit of its scope assignment (as of `asOf`, default today; see
 * {@link scopeAssignment}) is in the caller's P scope. Unknown / other-company / unreadable → 404; readable but not
 * writable → 403 `forbidden-scope`; a sensitive block without its permission → 403 `forbidden-field`.
 */
@Injectable()
export class EmployeesService {
  constructor(
    private readonly repo: EmployeeRepository,
    private readonly scopes: ScopeService,
    private readonly clock: EmploymentClock,
  ) {}

  // ── reads ─────────────────────────────────────────────────────────────────────────────────────────────────────

  async list(input: ListEmployeesInput): Promise<EmployeeListView> {
    const companyId = tenant();
    const asOf = input.asOf ?? this.clock.today();
    const { rows, total } = await this.repo.listPage(companyId, {
      asOf,
      scope: await this.scopes.scopeOf(P.read),
      q: input.q,
      unitId: input.unitId,
      includeSubUnits: input.includeSubUnits,
      siteId: input.siteId,
      status: input.status,
      sort: input.sort,
      dir: input.dir,
      lang: input.lang ?? 'fr',
      limit: input.pageSize,
      offset: (input.page - 1) * input.pageSize,
    });
    return { items: rows.map((r) => listItem(r, asOf)), total, page: input.page, pageSize: input.pageSize };
  }

  async get(id: string): Promise<EmployeeDetail> {
    const loaded = await this.load(id);
    return this.detail(loaded);
  }

  // ── writes ────────────────────────────────────────────────────────────────────────────────────────────────────

  /** POST /employees: (new person or rehire) + employment + first assignment [+ salary, bank, nss]. */
  async create(input: CreateEmployeeInput): Promise<EmployeeDetail> {
    const companyId = tenant();
    await this.assertUnit(companyId, input.orgUnitId);
    if (!(await this.scopes.inScope(P.create, input.orgUnitId))) {
      throw forbiddenScope('You cannot create employees in this unit (outside your employee.create scope).', 'orgUnitId');
    }
    const forbidden: FieldError[] = [];
    for (const block of ['salary', 'bank', 'nss'] as const) {
      if (input[block] !== undefined && !(await this.scopes.inScope(BLOCK_UPDATE[block], input.orgUnitId))) {
        forbidden.push({ field: block, code: 'forbidden_field', message: `You may not set ${block} (${BLOCK_UPDATE[block]}).` });
      }
    }
    if (forbidden.length) throw new ProblemException(403, 'forbidden-field', 'Some fields may not be set by you.', forbidden);
    await this.assertSite(companyId, input.siteId ?? null);

    return problems(async () => {
      let personId: string;
      if (input.personId) {
        personId = await this.rehirePerson(companyId, input.personId, input.hireDate);
      } else {
        if (input.nin && (await this.repo.ninTaken(companyId, input.nin))) {
          throw new EmploymentRuleViolation('nin-taken', 'This NIN is already recorded for another person.', 'nin');
        }
        personId = await this.repo.insertPerson(companyId, {
          lastName: input.lastName ?? '',
          firstName: input.firstName ?? '',
          lastNameAr: input.lastNameAr ?? null,
          firstNameAr: input.firstNameAr ?? null,
          birthDate: input.birthDate ?? null,
          birthPlace: input.birthPlace ?? null,
          sex: input.sex ?? null,
          nationality: input.nationality ?? 'DZ',
          nin: input.nin ?? null,
        });
      }
      if (await this.repo.matriculeTaken(companyId, input.matricule)) {
        throw new EmploymentRuleViolation('matricule-taken', 'This matricule is already used in this company.', 'matricule');
      }
      const id = await this.repo.insertEmployment(companyId, { personId, matricule: input.matricule, hireDate: input.hireDate });
      await this.repo.insertAssignment(companyId, id, {
        orgUnitId: input.orgUnitId,
        siteId: input.siteId ?? null,
        jobTitle: input.jobTitle,
        validFrom: input.hireDate,
      });
      if (input.salary) await this.repo.insertSalary(companyId, id, { baseSalary: input.salary.baseSalary, validFrom: input.hireDate });
      if (input.bank || input.nss) {
        await this.repo.upsertSensitive(companyId, personId, { ...input.bank, ...input.nss });
      }
      // employee.create does not imply employee.read: the creator gets the detail of what they just wrote
      return this.detail({ companyId, employment: await this.mustFind(companyId, id), assignments: await this.repo.listAssignments(companyId, id), unitId: input.orgUnitId }, { skipRead: true });
    });
  }

  async updatePerson(id: string, patch: PersonPatch): Promise<EmployeeDetail> {
    const loaded = await this.loadForWrite(id, P.update);
    return problems(async () => {
      if (patch.nin && (await this.repo.ninTaken(loaded.companyId, patch.nin, loaded.employment.personId))) {
        throw new EmploymentRuleViolation('nin-taken', 'This NIN is already recorded for another person.', 'nin');
      }
      await this.repo.updatePerson(loaded.companyId, loaded.employment.personId, patch);
      return this.detail(loaded);
    });
  }

  /** New assignment from `validFrom`; the current one is closed the day before. */
  async assign(id: string, input: AssignInput): Promise<EmployeeDetail> {
    const loaded = await this.loadForWrite(id, P.update);
    const { companyId, employment } = loaded;
    await this.assertUnit(companyId, input.orgUnitId);
    const canWrite = (await this.scopes.inScope(P.update, input.orgUnitId)) || (await this.scopes.inScope(P.create, input.orgUnitId));
    if (!canWrite) throw forbiddenScope('You cannot assign employees to this unit (outside your employee.update scope).', 'orgUnitId');
    await this.assertSite(companyId, input.siteId ?? null);
    return problems(async () => {
      const { close } = planAssignment(loaded.assignments, employment.hireDate, input.validFrom);
      if (close) await this.repo.closeAssignment(companyId, close.id, input.validFrom);
      await this.repo.insertAssignment(companyId, employment.id, {
        orgUnitId: input.orgUnitId,
        siteId: input.siteId ?? null,
        jobTitle: input.jobTitle,
        validFrom: input.validFrom,
      });
      return this.detail({ ...loaded, assignments: await this.repo.listAssignments(companyId, employment.id) });
    });
  }

  /** Records the end (inclusive `endDate`) and closes the open assignment and salary at endDate + 1. */
  async end(id: string, input: { endDate: string; reason: EndReason }): Promise<EmployeeDetail> {
    const loaded = await this.loadForWrite(id, P.update);
    const { companyId, employment } = loaded;
    return problems(async () => {
      const salaries = await this.repo.listSalaries(companyId, employment.id);
      const plan = planEnd(loaded.assignments, salaries, employment.hireDate, input.endDate);
      await this.repo.endEmployment(companyId, employment.id, input.endDate, input.reason);
      if (plan.closeAssignment) await this.repo.closeAssignment(companyId, plan.closeAssignment.id, plan.validTo);
      if (plan.closeSalary) await this.repo.closeSalary(companyId, plan.closeSalary.id, plan.validTo);
      return this.detail({ ...loaded, employment: await this.mustFind(companyId, employment.id), assignments: await this.repo.listAssignments(companyId, employment.id) });
    });
  }

  /** New salary version from `validFrom`; the current one is closed the day before. */
  async setSalary(id: string, input: { baseSalary: string; validFrom: string }): Promise<EmployeeDetail> {
    const loaded = await this.loadForWrite(id, P.salaryUpdate);
    const { companyId, employment } = loaded;
    return problems(async () => {
      const { close } = planSalary(await this.repo.listSalaries(companyId, employment.id), employment.hireDate, input.validFrom);
      if (close) await this.repo.closeSalary(companyId, close.id, input.validFrom);
      await this.repo.insertSalary(companyId, employment.id, input);
      return this.detail(loaded);
    });
  }

  async setBank(id: string, input: { rib: string | null; bankName: string | null }): Promise<EmployeeDetail> {
    const loaded = await this.loadForWrite(id, P.bankUpdate);
    await this.repo.upsertSensitive(loaded.companyId, loaded.employment.personId, { rib: input.rib, bankName: input.bankName });
    return this.detail(loaded);
  }

  async setNss(id: string, input: { nss: string | null }): Promise<EmployeeDetail> {
    const loaded = await this.loadForWrite(id, P.nssUpdate);
    await this.repo.upsertSensitive(loaded.companyId, loaded.employment.personId, { nss: input.nss });
    return this.detail(loaded);
  }

  // ── known persons (docs/contracts/recruitment.md › Module boundaries) ───────────────────────────────────────────

  /**
   * A person of the company named by id or by NIN, with their latest employment — ONLY when the caller can read that
   * employment with employee.read (the rehire visibility rule, see {@link rehirePerson}); else null: other people's
   * records stay invisible. A person without any employment is not "known" (null). Read-only.
   */
  async knownPerson(ref: { personId: string } | { nin: string }): Promise<KnownPerson | null> {
    const [found] = await this.knownPersons([ref]);
    return found ?? null;
  }

  /** {@link knownPerson} for several references at once (same order; one NIN lookup for all of them). */
  async knownPersons(refs: readonly ({ personId: string } | { nin: string })[]): Promise<(KnownPerson | null)[]> {
    if (refs.length === 0) return [];
    const companyId = tenant();
    const today = this.clock.today();
    const byNin = await this.repo.personIdsByNin(companyId, [...new Set(refs.flatMap((r) => ('nin' in r ? [r.nin] : [])))]);
    const personIds = refs.map((r) => ('personId' in r ? r.personId : (byNin.get(r.nin) ?? null)));
    const resolved = new Map<string, KnownPerson | null>();
    let snapshots: UnitSnapshots | undefined;
    for (const personId of new Set(personIds.filter((id): id is string => id !== null))) {
      const person = await this.repo.findPerson(companyId, personId);
      const employments = person ? await this.repo.employmentsOf(companyId, personId) : [];
      const latest = employments[0];
      const unitId = latest ? scopeAssignment(await this.repo.listAssignments(companyId, latest.id), today)?.orgUnitId : undefined;
      if (!person || !latest || !unitId || !(await this.scopes.inScope(P.read, unitId))) {
        resolved.set(personId, null);
        continue;
      }
      snapshots ??= new UnitSnapshots(await this.repo.unitVersions(companyId));
      resolved.set(personId, {
        personId,
        person: { lastName: person.lastName, firstName: person.firstName, lastNameAr: person.lastNameAr, firstNameAr: person.firstNameAr },
        hasOpenEmployment: hasOpenEmployment(employments),
        latestEmployment: { id: latest.id, matricule: latest.matricule, hireDate: latest.hireDate, endDate: latest.endDate, unit: unitRef(unitId, snapshots.at(today).get(unitId)) },
      });
    }
    return personIds.map((id) => (id ? (resolved.get(id) ?? null) : null));
  }

  /**
   * The id and matricule of an employment when the caller can read it with employee.read, else null (the link from a
   * hired application to its employee: docs/contracts/recruitment.md › Phase B). Read-only.
   */
  async visibleEmployment(id: string): Promise<{ id: string; matricule: string } | null> {
    const companyId = tenant();
    const employment = await this.repo.findEmployment(companyId, id);
    if (!employment) return null;
    const unitId = scopeAssignment(await this.repo.listAssignments(companyId, id), this.clock.today())?.orgUnitId;
    return unitId && (await this.scopes.inScope(P.read, unitId)) ? { id: employment.id, matricule: employment.matricule } : null;
  }

  // ── helpers ───────────────────────────────────────────────────────────────────────────────────────────────────

  private async mustFind(companyId: string, id: string): Promise<EmploymentRow> {
    const employment = await this.repo.findEmployment(companyId, id);
    if (!employment) throw notFound();
    return employment;
  }

  /** The employment, readable by the caller (employee.read over its scope unit) — else 404. */
  private async load(id: string): Promise<Loaded> {
    const companyId = tenant();
    const employment = await this.repo.findEmployment(companyId, id);
    if (!employment) throw notFound();
    const assignments = await this.repo.listAssignments(companyId, id);
    const unitId = scopeAssignment(assignments, this.clock.today())?.orgUnitId;
    if (!unitId || !(await this.scopes.inScope(P.read, unitId))) throw notFound();
    return { companyId, employment, assignments, unitId };
  }

  /** {@link load} + `permission` over the scope unit (else 403 forbidden-scope) + the employment is still open. */
  private async loadForWrite(id: string, permission: string): Promise<Loaded> {
    const loaded = await this.load(id);
    if (!(await this.scopes.inScope(permission, loaded.unitId))) {
      throw forbiddenScope(`You cannot change this employee (outside your ${permission} scope).`);
    }
    try {
      assertOpen(loaded.employment.endDate);
    } catch (error) {
      throw toProblem(error);
    }
    return loaded;
  }

  /** A referenced unit must exist in the caller's company (422 on `orgUnitId` otherwise). */
  private async assertUnit(companyId: string, unitId: string): Promise<void> {
    if (!(await this.repo.unitExists(companyId, unitId))) throw invalid('orgUnitId', 'not_found', 'The org unit does not exist.');
  }

  private async assertSite(companyId: string, siteId: string | null): Promise<void> {
    if (siteId !== null && !(await this.repo.siteExists(companyId, siteId))) throw invalid('siteId', 'not_found', 'The site does not exist.');
  }

  /**
   * Rehire: the person exists and the caller can read their latest employment (else 422 personId not_found — other
   * people's records stay invisible), has no open employment (409 employment-open) and the new hire date follows the
   * previous end (409 hire-date).
   */
  private async rehirePerson(companyId: string, personId: string, hireDate: string): Promise<string> {
    const person = await this.repo.findPerson(companyId, personId);
    const employments = person ? await this.repo.employmentsOf(companyId, personId) : [];
    const latest = employments[0];
    let visible = person !== undefined;
    if (person && latest) {
      const unitId = scopeAssignment(await this.repo.listAssignments(companyId, latest.id), this.clock.today())?.orgUnitId;
      visible = unitId !== undefined && (await this.scopes.inScope(P.read, unitId));
    }
    if (!visible) throw invalid('personId', 'not_found', 'The person does not exist.');
    if (employments.some((e) => e.endDate === null)) {
      throw new EmploymentRuleViolation('employment-open', 'This person already has an open employment.', 'personId');
    }
    assertRehireDate(latest?.endDate ?? null, hireDate);
    return personId;
  }

  private async detail(loaded: Loaded, options: { skipRead?: boolean } = {}): Promise<EmployeeDetail> {
    const { companyId, employment, unitId } = loaded;
    const today = this.clock.today();
    const [person, salaries, sensitive, versions, employments] = await Promise.all([
      this.repo.findPerson(companyId, employment.personId),
      this.repo.listSalaries(companyId, employment.id),
      this.repo.findSensitive(companyId, employment.personId),
      this.repo.unitVersions(companyId),
      this.repo.employmentsOf(companyId, employment.personId),
    ]);
    if (!person) throw notFound();
    const can = async (code: string) => this.scopes.inScope(code, unitId);
    const [read, salaryRead, bankRead, nssRead, update, salaryUpdate, bankUpdate, nssUpdate] = await Promise.all([
      can(P.read), can(P.salaryRead), can(P.bankRead), can(P.nssRead), can(P.update), can(P.salaryUpdate), can(P.bankUpdate), can(P.nssUpdate),
    ]);
    if (!read && !options.skipRead) throw notFound();

    const snapshots = new UnitSnapshots(versions);
    const assignmentsNewestFirst = byStart(loaded.assignments).toReversed();
    const siteIds = new Set<string>();
    const resolved = assignmentsNewestFirst.map((a) => {
      const at = snapshots.unit(a.orgUnitId, referenceDate(a, today));
      const siteId = a.siteId ?? at?.siteId ?? null;
      if (siteId) siteIds.add(siteId);
      return { a, at, siteId };
    });
    const sites = new Map((await this.repo.sitesByIds(companyId, [...siteIds])).map((s) => [s.id, s]));
    const siteRef = (id: string | null): SiteRef | null => (id ? (sites.get(id) ?? null) : null);
    const assignments: AssignmentView[] = resolved.map(({ a, at, siteId }) => ({
      id: a.id,
      unit: { ...unitRef(a.orgUnitId, at?.unit), path: at?.path ?? [] },
      site: siteRef(siteId),
      siteInherited: a.siteId === null,
      jobTitle: a.jobTitle,
      validFrom: a.validFrom,
      validTo: a.validTo,
    }));
    const shown = scopeAssignment(loaded.assignments, today);
    const shownView = assignments.find((v) => v.id === shown?.id) ?? assignments[0];

    const redacted: FieldBlock[] = [];
    const detail: EmployeeDetail = {
      id: employment.id,
      matricule: employment.matricule,
      person: { ...personView(person), hasOpenEmployment: hasOpenEmployment(employments) },
      unit: shownView ? { id: shownView.unit.id, code: shownView.unit.code, name: shownView.unit.name, nameAr: shownView.unit.nameAr, kind: shownView.unit.kind } : unitRef(unitId, undefined),
      site: shownView?.site ?? null,
      jobTitle: shownView?.jobTitle ?? '',
      hireDate: employment.hireDate,
      endDate: employment.endDate,
      status: statusOf(employment.hireDate, employment.endDate, today),
      endReason: employment.endReason,
      assignments,
      _redacted: redacted,
      _actions: employeeActions(employment.endDate === null, { update, salaryUpdate, bankUpdate, nssUpdate }),
    };
    if (salaryRead) {
      const current = salaries.find((s) => s.validFrom <= today && (s.validTo === null || today < s.validTo));
      detail.salary = {
        current: current ? { baseSalary: current.baseSalary, currency: 'DZD', validFrom: current.validFrom } : null,
        history: salaries.toReversed().map((s) => ({ baseSalary: s.baseSalary, validFrom: s.validFrom, validTo: s.validTo })),
      };
    } else redacted.push('salary');
    if (bankRead) detail.bank = { rib: sensitive?.rib ?? null, bankName: sensitive?.bankName ?? null };
    else redacted.push('bank');
    if (nssRead) detail.nss = { nss: sensitive?.nss ?? null };
    else redacted.push('nss');
    return detail;
  }
}

function unitRef(id: string, unit: { code: string; name: string; nameAr?: string | null; kind: string } | undefined): UnitRef {
  return { id, code: unit?.code ?? '', name: unit?.name ?? '', nameAr: unit?.nameAr ?? null, kind: unit?.kind ?? '' };
}

function personView(p: PersonRow): Omit<EmployeeDetail['person'], 'hasOpenEmployment'> {
  return {
    id: p.id,
    lastName: p.lastName,
    firstName: p.firstName,
    lastNameAr: p.lastNameAr,
    firstNameAr: p.firstNameAr,
    birthDate: p.birthDate,
    birthPlace: p.birthPlace,
    sex: p.sex,
    nationality: p.nationality,
    nin: p.nin,
  };
}

function listItem(r: ListRow, asOf: string): EmployeeListItem {
  return {
    id: r.id,
    matricule: r.matricule,
    person: { id: r.person_id, lastName: r.last_name, firstName: r.first_name, lastNameAr: r.last_name_ar, firstNameAr: r.first_name_ar },
    unit: { id: r.unit_id, code: r.unit_code, name: r.unit_name ?? '', nameAr: r.unit_name_ar, kind: r.unit_kind },
    site: r.site_id && r.site_code && r.site_name ? { id: r.site_id, code: r.site_code, name: r.site_name } : null,
    jobTitle: r.job_title,
    hireDate: r.hire_date,
    endDate: r.end_date,
    status: statusOf(r.hire_date, r.end_date, asOf),
  };
}
