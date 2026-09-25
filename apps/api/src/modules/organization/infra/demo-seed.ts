import { sql, type Kysely, type Transaction } from 'kysely';
import type { DB } from '../../../platform/db/schema.js';
import type { OrgUnitKind } from '../domain/org-unit.js';
import { rebuildClosure } from './closure.js';

type Executor = Kysely<DB> | Transaction<DB>;

export interface SeedSite {
  id: string;
  code: string;
  name: string;
  wilaya: string;
  address?: string | null;
}

export interface SeedUnit {
  id: string;
  kind: OrgUnitKind;
  code: string;
  name: string;
  /** Parent code (null for the root unit). */
  parent: string | null;
  /** Own site code (omitted = inherited from the nearest ancestor; required on the root). */
  site?: string;
}

export interface SeedOrganization {
  company: { id: string; code: string; name: string };
  validFrom: string;
  sites: SeedSite[];
  units: SeedUnit[];
}

const id = (suffix: string) => `0190a5d0-0000-7000-8000-${suffix.padStart(12, '0')}`;

/**
 * Fixed ids of the demo data (docs/contracts/organization.md › Development identity; also in apps/api/README.md):
 *   company …000000000001, dev user …0000000000aa
 *   units   …000000000101 DG; 111–113 departments; 121–123 regions; 131–136 agencies; 141–145 services
 *   sites   …000000000201–207
 */
export const DEMO_COMPANY_ID = id('1');
export const DEMO_USER_ID = id('aa');

export const DEMO_ORGANIZATION: SeedOrganization = {
  company: { id: DEMO_COMPANY_ID, code: 'DEMO', name: 'Groupe Démo' },
  validFrom: '2026-01-01',
  sites: [
    { id: id('201'), code: 'ALG-HQ', name: 'Alger – Siège', wilaya: 'Alger' },
    { id: id('202'), code: 'ALG-CTR', name: 'Alger Centre', wilaya: 'Alger' },
    { id: id('203'), code: 'BLIDA', name: 'Blida', wilaya: 'Blida' },
    { id: id('204'), code: 'CNE', name: 'Constantine', wilaya: 'Constantine' },
    { id: id('205'), code: 'ANNABA', name: 'Annaba', wilaya: 'Annaba' },
    { id: id('206'), code: 'ORAN', name: 'Oran', wilaya: 'Oran' },
    { id: id('207'), code: 'TLEMCEN', name: 'Tlemcen', wilaya: 'Tlemcen' },
  ],
  units: [
    { id: id('101'), kind: 'direction_generale', code: 'DG', name: 'Direction Générale', parent: null, site: 'ALG-HQ' },
    { id: id('111'), kind: 'department', code: 'DEP-RH', name: 'Département RH', parent: 'DG' },
    { id: id('112'), kind: 'department', code: 'DEP-FIN', name: 'Département Finances', parent: 'DG' },
    { id: id('113'), kind: 'department', code: 'DEP-RX', name: 'Département RX', parent: 'DG' },
    { id: id('121'), kind: 'region', code: 'REG-CTR', name: 'Région Centre', parent: 'DEP-RX', site: 'BLIDA' },
    { id: id('122'), kind: 'region', code: 'REG-EST', name: 'Région Est', parent: 'DEP-RX', site: 'CNE' },
    { id: id('123'), kind: 'region', code: 'REG-OUEST', name: 'Région Ouest', parent: 'DEP-RX', site: 'ORAN' },
    { id: id('131'), kind: 'agency', code: 'AG-ALG', name: 'Agence Alger Centre', parent: 'REG-CTR', site: 'ALG-CTR' },
    { id: id('132'), kind: 'agency', code: 'AG-BLIDA', name: 'Agence Blida', parent: 'REG-CTR', site: 'BLIDA' },
    { id: id('133'), kind: 'agency', code: 'AG-CNE', name: 'Agence Constantine', parent: 'REG-EST', site: 'CNE' },
    { id: id('134'), kind: 'agency', code: 'AG-ANNABA', name: 'Agence Annaba', parent: 'REG-EST', site: 'ANNABA' },
    { id: id('135'), kind: 'agency', code: 'AG-ORAN', name: 'Agence Oran', parent: 'REG-OUEST', site: 'ORAN' },
    { id: id('136'), kind: 'agency', code: 'AG-TLEMCEN', name: 'Agence Tlemcen', parent: 'REG-OUEST', site: 'TLEMCEN' },
    { id: id('141'), kind: 'service', code: 'SRV-PAIE', name: 'Service Paie', parent: 'DEP-RH' },
    { id: id('142'), kind: 'service', code: 'SRV-FORM', name: 'Service Formation', parent: 'DEP-RH' },
    { id: id('143'), kind: 'service', code: 'SRV-COMPTA', name: 'Service Comptabilité', parent: 'DEP-FIN' },
    { id: id('144'), kind: 'service', code: 'SRV-ADM-EST', name: 'Service Administration Est', parent: 'REG-EST' },
    { id: id('145'), kind: 'service', code: 'SRV-CLI-ANB', name: 'Service Clientèle', parent: 'AG-ANNABA' },
  ],
};

/**
 * Idempotently creates a company, its sites, its units (one open-ended version each from `validFrom`) and rebuilds
 * its closure as of `today`. Runs with a role that bypasses RLS (the migrator): it writes company_id explicitly.
 * Existing sites/units (same id) and units that already have versions are left untouched.
 */
export async function seedOrganization(db: Executor, spec: SeedOrganization, today: string): Promise<void> {
  const { company } = spec;
  await db.insertInto('company').values(company).onConflict((oc) => oc.column('id').doNothing()).execute();
  for (const site of spec.sites) {
    await db
      .insertInto('site')
      .values({ id: site.id, company_id: company.id, code: site.code, name: site.name, wilaya: site.wilaya, address: site.address ?? null })
      .onConflict((oc) => oc.column('id').doNothing())
      .execute();
  }
  const siteIdByCode = new Map(spec.sites.map((s) => [s.code, s.id]));
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
    const siteId = unit.site ? siteIdByCode.get(unit.site) : null;
    if (siteId === undefined) throw new Error(`seed: unknown site code ${unit.site ?? ''}`);
    await sql`
      insert into org_unit_version (company_id, org_unit_id, name, parent_id, site_id, valid)
      select ${company.id}::uuid, ${unit.id}::uuid, ${unit.name}, ${parentId}::uuid, ${siteId}::uuid, daterange(${spec.validFrom}::date, null, '[)')
       where not exists (select 1 from org_unit_version where org_unit_id = ${unit.id}::uuid)`.execute(db);
  }
  await rebuildClosure(db, company.id, today);
}
