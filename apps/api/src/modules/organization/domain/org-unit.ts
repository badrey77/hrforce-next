/**
 * Organisation units — pure domain rules (no Nest, no Kysely). Contract: docs/contracts/organization.md.
 * Dates are ISO `YYYY-MM-DD` strings throughout: they compare correctly as strings and never shift with time zones.
 */

export const ORG_UNIT_KINDS = ['company', 'region', 'site'] as const;
export type OrgUnitKind = (typeof ORG_UNIT_KINDS)[number];
/** Kinds that can be created through the API (the company unit is created with the company). */
export const CREATABLE_KINDS = ['region', 'site'] as const satisfies readonly OrgUnitKind[];

export const ORG_UNIT_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,31}$/;
export const ORG_UNIT_NAME_MAX = 120;

export type OrgAction = 'update' | 'create_child';

/** Body fields a rule violation can point at (the web maps them to form controls). */
export type OrgField = 'name' | 'parentId' | 'code' | 'kind' | 'validFrom';

export type OrgProblemSlug =
  | 'org-unit-code-taken'
  | 'org-unit-invalid-parent'
  | 'org-unit-cycle'
  | 'org-unit-version-overlap'
  | 'org-unit-root-immutable';

/** A business-rule violation (→ 409 problem with `type: urn:hrforce:problem:<slug>`). */
export class OrgRuleViolation extends Error {
  constructor(
    readonly slug: OrgProblemSlug,
    message: string,
    readonly field?: OrgField,
    readonly code: string = slug,
  ) {
    super(message);
    this.name = 'OrgRuleViolation';
  }
}

export function isOrgUnitCode(code: string): boolean {
  return ORG_UNIT_CODE_PATTERN.test(code);
}

/** Trimmed name, or null when it is empty / longer than {@link ORG_UNIT_NAME_MAX} after trimming. */
export function normalizeName(raw: string): string | null {
  const name = raw.trim();
  return name.length >= 1 && name.length <= ORG_UNIT_NAME_MAX ? name : null;
}

/** The kind a unit's parent must have (null: the unit is the root and has no parent). */
export function requiredParentKind(kind: OrgUnitKind): OrgUnitKind | null {
  switch (kind) {
    case 'company':
      return null;
    case 'region':
      return 'company';
    case 'site':
      return 'region';
  }
}

/** Kinds that may have children — i.e. that offer the `create_child` action. */
export function canHaveChildren(kind: OrgUnitKind): boolean {
  return ORG_UNIT_KINDS.some((child) => requiredParentKind(child) === kind);
}

/** region → parent is the company unit; site → parent is a region. `parent` undefined = not found. */
export function assertParentAllowed(childKind: OrgUnitKind, parent: { kind: OrgUnitKind } | undefined): void {
  const expected = requiredParentKind(childKind);
  if (expected === null) {
    throw new OrgRuleViolation('org-unit-root-immutable', 'The company unit has no parent and cannot be moved.', 'parentId');
  }
  if (!parent) {
    throw new OrgRuleViolation('org-unit-invalid-parent', 'The parent unit does not exist.', 'parentId', 'not_found');
  }
  if (parent.kind !== expected) {
    throw new OrgRuleViolation(
      'org-unit-invalid-parent',
      `A ${childKind} must be placed under a ${expected}, not a ${parent.kind}.`,
      'parentId',
      'invalid_parent_kind',
    );
  }
}

/**
 * True when making `newParentId` the parent of `unitId` would create a cycle, i.e. `newParentId` is `unitId`
 * itself or one of its descendants. `parentOf` gives each unit's parent in the tree the change applies to.
 */
export function wouldCreateCycle(
  unitId: string,
  newParentId: string,
  parentOf: (id: string) => string | null | undefined,
): boolean {
  const seen = new Set<string>();
  let current: string | null | undefined = newParentId;
  while (current) {
    if (current === unitId) return true;
    if (seen.has(current)) return true; // pre-existing cycle: refuse rather than loop
    seen.add(current);
    current = parentOf(current);
  }
  return false;
}

/** Throws org-unit-cycle when {@link wouldCreateCycle}. */
export function assertNoCycle(unitId: string, newParentId: string, parentOf: (id: string) => string | null | undefined): void {
  if (wouldCreateCycle(unitId, newParentId, parentOf)) {
    throw new OrgRuleViolation('org-unit-cycle', 'A unit cannot be moved under itself or one of its sub-units.', 'parentId');
  }
}
