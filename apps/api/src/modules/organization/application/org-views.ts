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
  /** Effective site (own, else the nearest ancestor's). */
  site: SiteRef | null;
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
  /** Effective site. */
  site: SiteRef | null;
  path: { id: string; name: string }[];
}

export interface OrgUnitSearchView {
  items: OrgUnitSummary[];
}

export interface OrgUnitVersionView {
  validFrom: string;
  validTo: string | null;
  name: string;
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
