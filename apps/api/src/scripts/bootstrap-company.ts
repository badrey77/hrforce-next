/**
 * First-run setup of a real company on an empty (or partly filled) database — used on staging/production, where the
 * demo seed must never run. Creates, in ONE transaction (as the migrator):
 *   company → its root unit (direction_generale) with its site → system roles → leave policy, leave types, holidays
 *   and workflow definitions (defaults, NOT the demo data) → the first admin account (INVITED, setup link to mail)
 *   → a grant of `admin_rh_central` on the root unit including sub-units, from `today`.
 * Refuses when a company with the same code already exists (it never modifies an existing company).
 */
import { randomUUID } from 'node:crypto';
import type { Transaction } from 'kysely';
import type { DB } from '../platform/db/schema.js';
import { seedGrants, seedSystemRoles } from '../modules/authorization/index.js';
import { inviteUser, type InviteResult } from '../modules/identity/index.js';
import { seedLeaveDefaults } from '../modules/leave/index.js';
import { seedOrganization } from '../modules/organization/index.js';

export interface BootstrapInput {
  companyCode: string;
  companyName: string;
  rootCode: string;
  rootName: string;
  rootNameAr?: string;
  siteCode: string;
  siteName: string;
  wilaya: string;
  adminEmail: string;
  adminName: string;
  adminLocale?: string;
}

export interface BootstrapResult {
  companyId: string;
  rootUnitId: string;
  admin: InviteResult;
}

const CODE = /^[A-Z0-9][A-Z0-9_-]{1,31}$/;

export async function bootstrapCompany(tx: Transaction<DB>, input: BootstrapInput, today: string): Promise<BootstrapResult> {
  for (const [field, value] of [['company-code', input.companyCode], ['root-code', input.rootCode], ['site-code', input.siteCode]] as const) {
    if (!CODE.test(value)) throw new Error(`--${field} must match ${CODE} (got "${value}")`);
  }
  const existing = await tx.selectFrom('company').select('id').where('code', '=', input.companyCode).executeTakeFirst();
  if (existing) {
    throw new Error(`company ${input.companyCode} already exists — bootstrap only creates new companies (use user:invite to add users)`);
  }

  const companyId = randomUUID();
  const rootUnitId = randomUUID();
  await seedOrganization(
    tx,
    {
      company: { id: companyId, code: input.companyCode, name: input.companyName },
      validFrom: today,
      sites: [{ id: randomUUID(), code: input.siteCode, name: input.siteName, wilaya: input.wilaya }],
      units: [
        {
          id: rootUnitId,
          kind: 'direction_generale',
          code: input.rootCode,
          name: input.rootName,
          ...(input.rootNameAr ? { nameAr: input.rootNameAr } : {}),
          parent: null,
          site: input.siteCode,
        },
      ],
    },
    today,
  );
  await seedSystemRoles(tx, companyId);
  await seedLeaveDefaults(tx, companyId);

  const admin = await inviteUser(tx, {
    email: input.adminEmail,
    displayName: input.adminName,
    companyCode: input.companyCode,
    ...(input.adminLocale ? { locale: input.adminLocale } : {}),
  });
  await seedGrants(tx, companyId, [
    { id: randomUUID(), userId: admin.userId, roleCode: 'admin_rh_central', orgUnitId: rootUnitId, includeDescendants: true, validFrom: today },
  ]);
  return { companyId, rootUnitId, admin };
}
