/** Response shapes of docs/contracts/organization.md (the API layer returns them as-is). */
import type { OrgAction, OrgUnitKind } from '../domain/org-unit.js';

export interface OrgTreeNode {
  id: string;
  kind: OrgUnitKind;
  code: string;
  name: string;
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
}

export interface OrgUnitDetail extends OrgUnitSummary {
  createdAt: string;
  versions: OrgUnitVersionView[];
  _actions: OrgAction[];
}
