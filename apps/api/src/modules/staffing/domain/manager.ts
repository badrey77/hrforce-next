/**
 * Manager resolution (docs/contracts/leave.md › Links added to M1 data). Pure domain code.
 *
 * Manager of an employee on date D = the head (on D) of the employee's assignment unit; if that unit has no head, or
 * the employee IS its head, walk up the tree (as of D) to the nearest ancestor with a head who is not the employee.
 * The approving USER is the user linked to that head's employment; a head without a linked user cannot approve
 * (the workflow escalates the step). No head up to the root → no manager (escalated too).
 */

export interface ChainLink {
  /** the employee's unit first (depth 0), then each ancestor up to the root */
  unitId: string;
  depth: number;
  headEmploymentId: string | null;
  headUserId: string | null;
}

export type ManagerResolution =
  | { kind: 'user'; userId: string; employmentId: string; unitId: string }
  | { kind: 'none'; reason: 'no-manager' }
  | { kind: 'none'; reason: 'manager-not-linked'; employmentId: string; unitId: string };

export function pickManager(chain: readonly ChainLink[], employeeEmploymentId: string): ManagerResolution {
  const ordered = chain.toSorted((a, b) => a.depth - b.depth);
  for (const link of ordered) {
    if (!link.headEmploymentId || link.headEmploymentId === employeeEmploymentId) continue;
    if (!link.headUserId) return { kind: 'none', reason: 'manager-not-linked', employmentId: link.headEmploymentId, unitId: link.unitId };
    return { kind: 'user', userId: link.headUserId, employmentId: link.headEmploymentId, unitId: link.unitId };
  }
  return { kind: 'none', reason: 'no-manager' };
}
