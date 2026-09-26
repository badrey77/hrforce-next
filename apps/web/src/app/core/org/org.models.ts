/**
 * Organization API types — copied from the binding contract `docs/contracts/organization.md` (v2).
 * Keep these in sync with that file (field names and unions exactly); the API builds against the same text.
 * Plain TypeScript types: they vanish at runtime and only let `strictTemplates` and the compiler check our usage.
 *
 * Lives in core/ (not features/organization/) because other features — employees, permissions — will
 * need the org types and the picker too, and a feature must never import another feature.
 *
 * v2: unit kinds are DATA (`GET /org/kinds`), not a TypeScript union. The web holds no kind rules or kind labels;
 * `KindCatalog` (kind-catalog.ts) serves both from the catalogue.
 */

/** A code from `GET /org/kinds` (e.g. `direction_generale`, `department`, `region`, `agency`, `service`). */
export type OrgUnitKind = string;
export type OrgAction = 'update' | 'create_child';

/** Kind labels in every UI language, written by the business in the reference catalogue. */
export interface OrgKindLabels {
  readonly fr: string;
  readonly ar: string;
  readonly en: string;
}

export interface OrgKind {
  readonly code: OrgUnitKind;
  readonly isRoot: boolean;
  readonly sortOrder: number;
  readonly labels: OrgKindLabels;
  /** Kinds a unit of this kind may hang under; empty for the root. */
  readonly allowedParents: readonly OrgUnitKind[];
}

/** `GET /org/kinds` (sorted by sortOrder). */
export interface OrgKindList {
  readonly items: readonly OrgKind[];
}

export interface SiteRef {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

/** A place that hosts units — not a node of the tree. */
export interface Site extends SiteRef {
  readonly wilaya: string;
  readonly address: string | null;
}

/** `GET /org/sites?q=` (max 200, sorted by code). */
export interface SiteList {
  readonly items: readonly Site[];
}

/** `POST /org/sites` body → 201 `Site`. */
export interface CreateSite {
  readonly code: string;
  readonly name: string;
  readonly wilaya: string;
  readonly address?: string;
}

export interface OrgTreeNode {
  readonly id: string;
  readonly kind: OrgUnitKind;
  readonly code: string;
  readonly name: string;
  /** Effective site (own, else the nearest ancestor's). */
  readonly site: SiteRef | null;
  /** Sorted by the API (kind sortOrder, then code) — the web keeps that order. */
  readonly children: readonly OrgTreeNode[];
  /** What the caller may do on this unit. */
  readonly _actions: readonly OrgAction[];
  /**
   * Authorization contract: `false` for an ancestor sent only as CONTEXT (the caller's `org_unit.read` scope is
   * below it); such a node has `_actions: []` and its detail answers 404. Treat a missing value as `true` (an API
   * from before the Authorization step sends the whole tree).
   */
  readonly inScope: boolean;
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
  /** Effective site. */
  readonly site: SiteRef | null;
  /** Ancestors from the root down to the parent (excludes self); empty for the root. */
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
  /** Own site on that version; `null` = inherited from an ancestor. */
  readonly siteId: string | null;
}

/** `GET /org/units/:id`, and the response of POST / PATCH. */
export interface OrgUnitDetail extends OrgUnitSummary {
  /** True when `site` comes from an ancestor. */
  readonly siteInherited: boolean;
  readonly createdAt: string;
  /** Newest first. */
  readonly versions: readonly OrgUnitVersion[];
  readonly _actions: readonly OrgAction[];
}

/** `POST /org/units` body. `validFrom` defaults to today on the server; `siteId` null/absent = inherit. */
export interface CreateOrgUnit {
  readonly kind: OrgUnitKind;
  readonly code: string;
  readonly name: string;
  readonly parentId: string;
  readonly siteId?: string | null;
  readonly validFrom?: string;
}

/** `PATCH /org/units/:id` body — at least one of `name` / `parentId` / `siteId` (`siteId: null` = inherit). */
export interface ChangeOrgUnit {
  readonly name?: string;
  readonly parentId?: string;
  readonly siteId?: string | null;
  readonly validFrom?: string;
}

/** Query of `GET /org/units`. Several kinds are sent as repeated params: `kind=region&kind=agency`. */
export interface OrgUnitSearch {
  readonly q?: string;
  readonly kinds?: readonly OrgUnitKind[];
  readonly asOf?: string;
}

/** Problem `type`s of the contract's 409 business-rule violations. */
export const ORG_PROBLEM_PREFIX = 'urn:hrforce:problem:';
export type OrgProblemSlug =
  | 'org-unit-code-taken'
  | 'org-unit-invalid-parent'
  | 'org-unit-cycle'
  | 'org-unit-version-overlap'
  | 'org-unit-root-immutable'
  | 'org-unit-root-site-required'
  | 'site-code-taken'
  | 'site-not-found'
  /** 403 (Authorization contract): the parent is readable but `org_unit.create`/`update` does not cover it. */
  | 'forbidden-scope';
