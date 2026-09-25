/**
 * Organisation units — pure domain rules (no Nest, no Kysely). Contract: docs/contracts/organization.md (v2).
 * Dates are ISO `YYYY-MM-DD` strings throughout: they compare correctly as strings and never shift with time zones.
 * Unit kinds and their parent rules are data (tables org_unit_kind / org_unit_kind_parent): see {@link KindCatalogue}.
 */

/** A code from the kind catalogue (GET /org/kinds), e.g. `direction_generale`, `department`, `service`. */
export type OrgUnitKind = string;

export const ORG_UNIT_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{1,31}$/;
export const ORG_UNIT_NAME_MAX = 120;

export type OrgAction = 'update' | 'create_child';

/** Body fields a rule violation can point at (the web maps them to form controls). */
export type OrgField = 'name' | 'parentId' | 'siteId' | 'code' | 'kind' | 'validFrom';

export type OrgProblemSlug =
  | 'org-unit-code-taken'
  | 'org-unit-invalid-parent'
  | 'org-unit-cycle'
  | 'org-unit-version-overlap'
  | 'org-unit-root-immutable'
  | 'org-unit-root-site-required'
  | 'site-code-taken'
  | 'site-not-found';

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

/** Unit and site codes share the pattern `^[A-Z0-9][A-Z0-9_-]{1,31}$`. */
export function isOrgUnitCode(code: string): boolean {
  return ORG_UNIT_CODE_PATTERN.test(code);
}

/** Trimmed name, or null when it is empty / longer than {@link ORG_UNIT_NAME_MAX} after trimming. */
export function normalizeName(raw: string): string | null {
  const name = raw.trim();
  return name.length >= 1 && name.length <= ORG_UNIT_NAME_MAX ? name : null;
}

export interface OrgKindLabels {
  readonly fr: string;
  readonly ar: string;
  readonly en: string;
}

/** One entry of the kind catalogue (shape of GET /org/kinds items). */
export interface OrgKind {
  readonly code: OrgUnitKind;
  readonly isRoot: boolean;
  readonly sortOrder: number;
  readonly labels: OrgKindLabels;
  /** Kinds a unit of this kind may be placed under (empty for the root). */
  readonly allowedParents: readonly OrgUnitKind[];
}

/** The kind catalogue with the parent rules: `department` → `direction_generale`, `service` → `department|region|agency`… */
export class KindCatalogue {
  private readonly byCode: ReadonlyMap<string, OrgKind>;
  /** Sorted by sortOrder, then code. */
  readonly kinds: readonly OrgKind[];

  constructor(kinds: readonly OrgKind[]) {
    this.kinds = kinds.toSorted((a, b) => a.sortOrder - b.sortOrder || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
    this.byCode = new Map(this.kinds.map((k) => [k.code, k]));
  }

  get(code: string): OrgKind | undefined {
    return this.byCode.get(code);
  }

  has(code: string): boolean {
    return this.byCode.has(code);
  }

  isRoot(code: string): boolean {
    return this.byCode.get(code)?.isRoot ?? false;
  }

  /** Unknown kinds sort last. */
  sortOrder(code: string): number {
    return this.byCode.get(code)?.sortOrder ?? Number.MAX_SAFE_INTEGER;
  }

  allowsParent(childKind: string, parentKind: string): boolean {
    return this.byCode.get(childKind)?.allowedParents.includes(parentKind) ?? false;
  }

  /** True when some kind may be placed under `kind` — i.e. units of that kind offer `create_child`. */
  canHaveChildren(kind: string): boolean {
    return this.kinds.some((k) => k.allowedParents.includes(kind));
  }

  /** Kinds that can be created through the API (every non-root kind). */
  creatableKinds(): OrgUnitKind[] {
    return this.kinds.filter((k) => !k.isRoot).map((k) => k.code);
  }
}

/**
 * The parent of a `childKind` unit must exist (`parent` undefined = not found / other tenant) and have one of the
 * kind's allowed parent kinds. The root kind has no parent and cannot be moved.
 */
export function assertParentAllowed(catalogue: KindCatalogue, childKind: OrgUnitKind, parent: { kind: OrgUnitKind } | undefined): void {
  if (catalogue.isRoot(childKind)) {
    throw new OrgRuleViolation('org-unit-root-immutable', 'The root unit has no parent and cannot be moved.', 'parentId');
  }
  if (!parent) {
    throw new OrgRuleViolation('org-unit-invalid-parent', 'The parent unit does not exist.', 'parentId', 'not_found');
  }
  if (!catalogue.allowsParent(childKind, parent.kind)) {
    const allowed = catalogue.get(childKind)?.allowedParents ?? [];
    throw new OrgRuleViolation(
      'org-unit-invalid-parent',
      `A ${childKind} cannot be placed under a ${parent.kind} (allowed: ${allowed.join(', ') || 'none'}).`,
      'parentId',
      'invalid_parent_kind',
    );
  }
}

/** The root unit must always be hosted by a site (its descendants inherit it). */
export function assertRootSite(catalogue: KindCatalogue, kind: OrgUnitKind, siteId: string | null): void {
  if (catalogue.isRoot(kind) && siteId === null) {
    throw new OrgRuleViolation('org-unit-root-site-required', 'The root unit must have a site.', 'siteId');
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
