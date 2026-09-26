/** Response shapes of docs/contracts/organization.md (v2; the API layer returns them as-is). */
import type { OrgAction, OrgKind, OrgUnitKind } from '../domain/org-unit.js';

export interface OrgKindsView {
  items: OrgKind[];
}

export interface SiteRef {
  id: string;
  code: string;
  name: string;
}

export interface Site extends SiteRef {
  wilaya: string;
  address: string | null;
}

export interface SitesView {
  items: Site[];
}

export interface OrgTreeNode {
  id: string;
  kind: OrgUnitKind;
  code: string;
  name: string;
  /** Arabic name (optional, date-effective like `name`). */
  nameAr: string | null;
  /** Effective site (own, else the nearest ancestor's). */
  site: SiteRef | null;
  /** false for context nodes: ancestors of in-scope units shown only to place them (no actions). */
  inScope: boolean;
  children: OrgTreeNode[];
  _actions: OrgAction[];
}

export interface OrgTreeView {
  asOf: string;
  root: OrgTreeNode;
}

export interface OrgUnitSummary {
  id: string;
  kind: OrgUnitKind;
  code: string;
  name: string;
  /** Arabic name (optional, date-effective like `name`). */
  nameAr: string | null;
  /** Effective site. */
  site: SiteRef | null;
  /** Ancestors root → parent; `nameAr` is an addition to the contract's `{id, name}` (Arabic UI). */
  path: { id: string; name: string; nameAr: string | null }[];
}

export interface OrgUnitSearchView {
  items: OrgUnitSummary[];
}

export interface OrgUnitVersionView {
  validFrom: string;
  validTo: string | null;
  name: string;
  nameAr: string | null;
  parentId: string | null;
  /** Own site on that version (null = inherited). */
  siteId: string | null;
}

export interface OrgUnitDetail extends OrgUnitSummary {
  siteInherited: boolean;
  createdAt: string;
  versions: OrgUnitVersionView[];
  _actions: OrgAction[];
}
