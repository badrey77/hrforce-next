/**
 * Organization API types — copied from the binding contract `docs/contracts/organization.md`.
 * Keep these in sync with that file (field names and unions exactly); the API builds against the same text.
 * Plain TypeScript types: they vanish at runtime and only let `strictTemplates` and the compiler check our usage.
 *
 * Lives in core/ (not features/organization/) because other features — employees, permissions — will
 * need the org types and the picker too, and a feature must never import another feature.
 */

export type OrgUnitKind = 'company' | 'region' | 'site';
export type OrgAction = 'update' | 'create_child';

/** Kinds a client may create (the company root is created with the tenant). */
export type CreatableOrgUnitKind = Exclude<OrgUnitKind, 'company'>;

export interface OrgTreeNode {
  readonly id: string;
  readonly kind: OrgUnitKind;
  readonly code: string;
  readonly name: string;
  /** Sorted by code. */
  readonly children: readonly OrgTreeNode[];
  /** What the caller may do on this unit. */
  readonly _actions: readonly OrgAction[];
}

/** `GET /org/tree?asOf=` */
export interface OrgTree {
  readonly asOf: string;
  readonly root: OrgTreeNode;
}

export interface OrgUnitPathItem {
  readonly id: string;
  readonly name: string;
}

export interface OrgUnitSummary {
  readonly id: string;
  readonly kind: OrgUnitKind;
  readonly code: string;
  readonly name: string;
  /** Ancestors from the company root down to the parent (excludes self). */
  readonly path: readonly OrgUnitPathItem[];
}

/** `GET /org/units?q=&kind=&asOf=` (max 50 items) */
export interface OrgUnitSearchResult {
  readonly items: readonly OrgUnitSummary[];
}

export interface OrgUnitVersion {
  readonly validFrom: string;
  /** Exclusive end; `null` = still open. */
  readonly validTo: string | null;
  readonly name: string;
  readonly parentId: string | null;
}

/** `GET /org/units/:id`, and the response of POST / PATCH. */
export interface OrgUnitDetail extends OrgUnitSummary {
  readonly createdAt: string;
  /** Newest first. */
  readonly versions: readonly OrgUnitVersion[];
  readonly _actions: readonly OrgAction[];
}

/** `POST /org/units` body. `validFrom` defaults to today on the server. */
export interface CreateOrgUnit {
  readonly kind: CreatableOrgUnitKind;
  readonly code: string;
  readonly name: string;
  readonly parentId: string;
  readonly validFrom?: string;
}

/** `PATCH /org/units/:id` body — at least one of `name` / `parentId`. */
export interface ChangeOrgUnit {
  readonly name?: string;
  readonly parentId?: string;
  readonly validFrom?: string;
}

/** Query of `GET /org/units`. */
export interface OrgUnitSearch {
  readonly q?: string;
  readonly kind?: OrgUnitKind;
  readonly asOf?: string;
}

/** Contract "Parent rules": a region hangs under the company, a site under a region. */
export const PARENT_KIND: Readonly<Record<CreatableOrgUnitKind, OrgUnitKind>> = {
  region: 'company',
  site: 'region',
};

/** Kinds that may be created under a parent of the given kind (inverse of PARENT_KIND). */
export function childKindsOf(parentKind: OrgUnitKind): CreatableOrgUnitKind[] {
  return (Object.keys(PARENT_KIND) as CreatableOrgUnitKind[]).filter((kind) => PARENT_KIND[kind] === parentKind);
}

/** Kinds a unit of the given kind may be moved under (empty for the company root: it has no parent). */
export function parentKindsOf(kind: OrgUnitKind): OrgUnitKind[] {
  return kind === 'company' ? [] : [PARENT_KIND[kind]];
}

/** Problem `type`s of the contract's 409 business-rule violations. */
export const ORG_PROBLEM_PREFIX = 'urn:hrforce:problem:';
export type OrgProblemSlug =
  | 'org-unit-code-taken'
  | 'org-unit-invalid-parent'
  | 'org-unit-cycle'
  | 'org-unit-version-overlap'
  | 'org-unit-root-immutable';
