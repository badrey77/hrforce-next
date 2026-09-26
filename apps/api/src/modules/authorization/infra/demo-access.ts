import type { Kysely, Transaction } from 'kysely';
import type { DB } from '../../../platform/db/schema.js';
import { DEMO_USERS } from '../../identity/index.js';
import { DEMO_ORGANIZATION } from '../../organization/index.js';
import { seedGrants, seedSystemRoles, type SeedGrant } from './access-seed.js';

type Executor = Kysely<DB> | Transaction<DB>;

function userId(email: string): string {
  const user = DEMO_USERS.find((u) => u.email === email);
  if (!user) throw new Error(`demo access: unknown demo user ${email}`);
  return user.id;
}

function unitId(code: string): string {
  const unit = DEMO_ORGANIZATION.units.find((u) => u.code === code);
  if (!unit) throw new Error(`demo access: unknown demo unit ${code}`);
  return unit.id;
}

/**
 * Dev seed grants (docs/contracts/authorization.md › Dev seed), valid from 2026-01-01, with sub-units.
 * Fixed ids …000000000301–303 (apps/api/README.md).
 */
export const DEMO_GRANTS: readonly SeedGrant[] = [
  { id: '0190a5d0-0000-7000-8000-000000000301', userId: userId('rh.admin@demo.dz'), roleCode: 'admin_rh_central', orgUnitId: unitId('DG'), includeDescendants: true, validFrom: '2026-01-01' },
  { id: '0190a5d0-0000-7000-8000-000000000302', userId: userId('rh.est@demo.dz'), roleCode: 'rh_regional', orgUnitId: unitId('REG-EST'), includeDescendants: true, validFrom: '2026-01-01' },
  { id: '0190a5d0-0000-7000-8000-000000000303', userId: userId('lecture.ouest@demo.dz'), roleCode: 'lecture', orgUnitId: unitId('REG-OUEST'), includeDescendants: true, validFrom: '2026-01-01' },
];

/** System roles of the demo company + the demo grants (idempotent; the organisation and users must exist). */
export async function seedDemoAccess(db: Executor): Promise<void> {
  const companyId = DEMO_ORGANIZATION.company.id;
  await seedSystemRoles(db, companyId);
  await seedGrants(db, companyId, DEMO_GRANTS);
}
