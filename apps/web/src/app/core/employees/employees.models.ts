/**
 * Employment API types — copied from the binding contract `docs/contracts/employment.md`.
 * Keep field names and unions exactly as written there: the API builds against the same text.
 * Plain TypeScript, no Angular: these types vanish at runtime and only let `strictTemplates` check our usage.
 *
 * Lives in core/ (not features/employees/): the list, the create page and the detail page all need them, and a
 * future feature (contracts, documents — M2) will too; a feature must never import another feature.
 *
 * **Money is a decimal STRING** (`"85000.00"`), never a `number`: `0.1 + 0.2 !== 0.3` in floating point, and a
 * salary must round-trip exactly. The web only formats it for display (DecimalPipe accepts numeric strings) and
 * sends back what the user typed, normalised to two decimals (see features/employees/employee-forms.ts).
 */

/** Latin names are required; Arabic ones optional (contract: "optional Arabic names for people and org units"). */
export interface NamePair {
  readonly lastName: string;
  readonly firstName: string;
  readonly lastNameAr: string | null;
  readonly firstNameAr: string | null;
}

export interface UnitRef {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly nameAr: string | null;
  readonly kind: string;
}

export interface EmployeeSiteRef {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

export type EmployeeStatus = 'active' | 'ended' | 'future';
export const EMPLOYEE_STATUSES: readonly EmployeeStatus[] = ['active', 'ended', 'future'];

export type Sex = 'M' | 'F';

export interface EmployeeListItem {
  /** The EMPLOYMENT id (`/employees/:id`), not the person's. */
  readonly id: string;
  readonly matricule: string;
  readonly person: NamePair & { readonly id: string };
  readonly unit: UnitRef;
  /** Effective site (own, else the unit's). */
  readonly site: EmployeeSiteRef | null;
  readonly jobTitle: string;
  readonly hireDate: string;
  readonly endDate: string | null;
  readonly status: EmployeeStatus;
}

export interface EmployeePerson extends NamePair {
  readonly id: string;
  readonly birthDate: string | null;
  readonly birthPlace: string | null;
  readonly sex: Sex | null;
  /** ISO-2, default `DZ`. */
  readonly nationality: string;
  /** 18 digits. */
  readonly nin: string | null;
}

export interface AssignmentUnit extends UnitRef {
  /** Ancestors from the root down to the parent. `nameAr` is not in the contract's path items; tolerated if sent. */
  readonly path: readonly { readonly id: string; readonly name: string; readonly nameAr?: string | null }[];
}

export interface Assignment {
  readonly id: string;
  readonly unit: AssignmentUnit;
  readonly site: EmployeeSiteRef | null;
  /** True when `site` is the unit's effective site (the assignment itself has none). */
  readonly siteInherited: boolean;
  readonly jobTitle: string;
  readonly validFrom: string;
  /** Exclusive end; `null` = open. */
  readonly validTo: string | null;
}

export interface SalaryVersion {
  readonly baseSalary: string;
  readonly validFrom: string;
  readonly validTo: string | null;
}

export interface EmployeeSalary {
  readonly current: { readonly baseSalary: string; readonly currency: 'DZD'; readonly validFrom: string } | null;
  readonly history: readonly SalaryVersion[];
}

export interface EmployeeBank {
  readonly rib: string | null;
  readonly bankName: string | null;
}

export interface EmployeeNss {
  readonly nss: string | null;
}

/** A block the caller may not read: omitted from the payload and named here. */
export type RedactedBlock = 'salary' | 'bank' | 'nss';
export type EmployeeAction = 'update' | 'assign' | 'end' | 'update_salary' | 'update_bank' | 'update_nss';

export interface EmployeeDetail extends EmployeeListItem {
  readonly person: EmployeePerson;
  readonly endReason: string | null;
  /** Newest first. */
  readonly assignments: readonly Assignment[];
  readonly salary?: EmployeeSalary;
  readonly bank?: EmployeeBank;
  readonly nss?: EmployeeNss;
  readonly _redacted: readonly RedactedBlock[];
  readonly _actions: readonly EmployeeAction[];
}

/** `_actions` without sprinkling lint exceptions through templates (the field name is the contract's). */
export function employeeActions(employee: Pick<EmployeeDetail, '_actions'>): readonly EmployeeAction[] {
  // oxlint-disable-next-line no-underscore-dangle -- contract field name
  return employee._actions ?? [];
}

/** `_redacted`; a block also counts as redacted when the API simply left it out. */
export function isRedacted(employee: EmployeeDetail, block: RedactedBlock): boolean {
  // oxlint-disable-next-line no-underscore-dangle -- contract field name
  return (employee._redacted ?? []).includes(block) || employee[block] === undefined;
}

// --- List query ------------------------------------------------------------------------------------------------

export type EmployeeSort = 'name' | 'matricule' | 'hireDate' | 'unit';
export const EMPLOYEE_SORTS: readonly EmployeeSort[] = ['name', 'matricule', 'hireDate', 'unit'];
export type SortDir = 'asc' | 'desc';
export type StatusFilter = 'active' | 'ended' | 'all';
export const STATUS_FILTERS: readonly StatusFilter[] = ['active', 'ended', 'all'];

export const EMPLOYEE_PAGE_SIZES: readonly number[] = [10, 25, 50, 100];
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/** `GET /employees` query, fully resolved (defaults applied). */
export interface EmployeeQuery {
  readonly q: string;
  readonly unitId: string | null;
  readonly includeSubUnits: boolean;
  readonly siteId: string | null;
  readonly status: StatusFilter;
  readonly asOf: string | null;
  readonly sort: EmployeeSort;
  readonly dir: SortDir;
  /** 1-based. */
  readonly page: number;
  readonly pageSize: number;
}

export const DEFAULT_EMPLOYEE_QUERY: EmployeeQuery = {
  q: '',
  unitId: null,
  includeSubUnits: true,
  siteId: null,
  status: 'active',
  asOf: null,
  sort: 'name',
  dir: 'asc',
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
};

export interface EmployeePage {
  readonly items: readonly EmployeeListItem[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

// --- Writes ----------------------------------------------------------------------------------------------------

/** Person fields of `POST /employees` and `PATCH /employees/:id/person`. */
export interface PersonInput {
  readonly lastName: string;
  readonly firstName: string;
  readonly lastNameAr: string | null;
  readonly firstNameAr: string | null;
  readonly birthDate: string | null;
  readonly birthPlace: string | null;
  readonly sex: Sex | null;
  readonly nationality: string;
  readonly nin: string | null;
}

export interface NewAssignment {
  readonly orgUnitId: string;
  /** `null`/absent = the unit's effective site. */
  readonly siteId?: string | null;
  readonly jobTitle: string;
  readonly validFrom: string;
}

/**
 * `POST /employees`. The contract lists the parts (person or `personId`, employment, first assignment, optional
 * `salary` / `bank` / `nss` blocks) without spelling the body; the API reads it FLAT — person and first-assignment
 * fields at the top level, so the 409 fields (`nin`, `matricule`, `personId`) name body properties — with the
 * sensitive blocks nested as in the detail (what `forbidden-field` names). The first assignment and the first salary
 * start at `hireDate`. The create FORM is nested by section; its submit flattens it (employee-create.page.ts).
 */
export interface CreateEmployee extends Partial<PersonInput> {
  readonly personId?: string;
  readonly matricule: string;
  readonly hireDate: string;
  readonly orgUnitId: string;
  /** `null`/absent = the unit's effective site. */
  readonly siteId?: string | null;
  readonly jobTitle: string;
  readonly salary?: { readonly baseSalary: string };
  readonly bank?: { readonly rib: string; readonly bankName: string | null };
  readonly nss?: { readonly nss: string };
}

export type EndReason = 'resignation' | 'retirement' | 'dismissal' | 'end_of_contract' | 'death' | 'other';
export const END_REASONS: readonly EndReason[] = [
  'resignation',
  'retirement',
  'dismissal',
  'end_of_contract',
  'death',
  'other',
];

export interface EndEmployment {
  readonly endDate: string;
  readonly reason: EndReason;
}

export interface NewSalary {
  readonly baseSalary: string;
  readonly validFrom: string;
}

/** 409 slugs of the contract (`urn:hrforce:problem:<slug>`), plus the 403s shared with the other slices. */
export type EmployeeProblemSlug =
  | 'matricule-taken'
  | 'nin-taken'
  | 'employment-open'
  | 'employment-ended'
  | 'assignment-date'
  | 'salary-date'
  | 'end-date'
  | 'forbidden-scope'
  | 'forbidden-field';
