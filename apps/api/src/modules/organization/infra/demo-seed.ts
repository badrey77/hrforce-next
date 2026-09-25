import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../platform/db/schema.js';
import type { OrgUnitKind } from '../domain/org-unit.js';
import { rebuildClosure } from './closure.js';

type Executor = Kysely<DB> | Transaction<DB>;

export interface SeedUnit {
  id: string;
  kind: OrgUnitKind;
  code: string;
  name: string;
  /** Parent code (null for the company unit). */
  parent: string | null;
}

export interface SeedOrganization {
  company: { id: string; code: string; name: string };
  validFrom: string;
  units: SeedUnit[];
}

const id = (suffix: string) => `0190a5d0-0000-7000-8000-${suffix.padStart(12, '0')}`;

/** Fixed ids of the demo data (docs/contracts/organization.md › Development identity). */
export const DEMO_COMPANY_ID = id('1');
export const DEMO_USER_ID = id('aa');

export const DEMO_ORGANIZATION: SeedOrganization = {
  company: { id: DEMO_COMPANY_ID, code: 'DEMO', name: 'Groupe Démo' },
  validFrom: '2026-01-01',
  units: [
    { id: id('101'), kind: 'company', code: 'GROUPE', name: 'Groupe Démo', parent: null },
    { id: id('111'), kind: 'region', code: 'CENTRE', name: 'Région Centre', parent: 'GROUPE' },
    { id: id('112'), kind: 'region', code: 'EST', name: 'Région Est', parent: 'GROUPE' },
    { id: id('113'), kind: 'region', code: 'OUEST', name: 'Région Ouest', parent: 'GROUPE' },
    { id: id('121'), kind: 'site', code: 'ALG-HQ', name: 'Alger – Siège', parent: 'CENTRE' },
    { id: id('122'), kind: 'site', code: 'BLIDA', name: 'Blida', parent: 'CENTRE' },
    { id: id('123'), kind: 'site', code: 'CNE', name: 'Constantine', parent: 'EST' },
    { id: id('124'), kind: 'site', code: 'ANNABA', name: 'Annaba', parent: 'EST' },
    { id: id('125'), kind: 'site', code: 'ORAN', name: 'Oran', parent: 'OUEST' },
    { id: id('126'), kind: 'site', code: 'TLEMCEN', name: 'Tlemcen', parent: 'OUEST' },
  ],
};

/**
 * Idempotently creates a company, its units (one open-ended version each from `validFrom`) and rebuilds its
 * closure as of `today`. Runs with a role that bypasses RLS (the migrator): it writes company_id explicitly.
 * Existing units (same id) and units that already have versions are left untouched.
 */
export async function seedOrganization(db: Executor, spec: SeedOrganization, today: string): Promise<void> {
  const { company } = spec;
  await db.insertInto('company').values(company).onConflict((oc) => oc.column('id').doNothing()).execute();
  const idByCode = new Map(spec.units.map((u) => [u.code, u.id]));
  for (const unit of spec.units) {
    await db
      .insertInto('org_unit')
      .values({ id: unit.id, company_id: company.id, kind: unit.kind, code: unit.code })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
  }
  for (const unit of spec.units) {
    const parentId = unit.parent ? idByCode.get(unit.parent) : null;
    if (parentId === undefined) throw new Error(`seed: unknown parent code ${unit.parent ?? ''}`);
    await sql`
      insert into org_unit_version (company_id, org_unit_id, name, parent_id, valid)
      select ${company.id}::uuid, ${unit.id}::uuid, ${unit.name}, ${parentId}::uuid, daterange(${spec.validFrom}::date, null, '[)')
       where not exists (select 1 from org_unit_version where org_unit_id = ${unit.id}::uuid)`.execute(db);
  }
  await rebuildClosure(db, company.id, today);
}
