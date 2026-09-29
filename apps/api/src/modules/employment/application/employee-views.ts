/** Response shapes of docs/contracts/employment.md (the API layer returns them as-is). */
import type { EmployeeAction, EmployeeStatus, FieldBlock } from '../domain/employee.js';

export interface NamePair {
  lastName: string;
  firstName: string;
  lastNameAr: string | null;
  firstNameAr: string | null;
}

export interface UnitRef {
  id: string;
  code: string;
  name: string;
  nameAr: string | null;
  kind: string;
}

export interface SiteRef {
  id: string;
  code: string;
  name: string;
}

export interface EmployeeListItem {
  id: string;
  matricule: string;
  person: NamePair & { id: string };
  unit: UnitRef;
  /** Effective site: the assignment's own site, else the unit's (own, else the nearest ancestor's). */
  site: SiteRef | null;
  jobTitle: string;
  hireDate: string;
  endDate: string | null;
  status: EmployeeStatus;
}

export interface EmployeeListView {
  items: EmployeeListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AssignmentView {
  id: string;
  /** `path`: ancestors root → parent (`nameAr` is an addition to the contract's `{id, name}`). */
  unit: UnitRef & { path: { id: string; name: string; nameAr: string | null }[] };
  site: SiteRef | null;
  /** true when `site` is the unit's effective site (the assignment has no own site). */
  siteInherited: boolean;
  jobTitle: string;
  validFrom: string;
  /** Exclusive end (`[validFrom, validTo)`), null = open. */
  validTo: string | null;
}

export interface SalaryBlock {
  current: { baseSalary: string; currency: 'DZD'; validFrom: string } | null;
  history: { baseSalary: string; validFrom: string; validTo: string | null }[];
}

export interface EmployeeDetail extends EmployeeListItem {
  person: EmployeeListItem['person'] & {
    birthDate: string | null;
    birthPlace: string | null;
    sex: 'M' | 'F' | null;
    nationality: string;
    nin: string | null;
    /**
     * The same person has an employment that is not over today (no end date, or one on/after today) — this one or
     * another, whatever the caller's scope. A boolean only: never the other employment's id or unit.
     */
    hasOpenEmployment: boolean;
  };
  endReason: string | null;
  /** Newest first. */
  assignments: AssignmentView[];
  salary?: SalaryBlock;
  bank?: { rib: string | null; bankName: string | null };
  nss?: { nss: string | null };
  _redacted: FieldBlock[];
  _actions: EmployeeAction[];
}
