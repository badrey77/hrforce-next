import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../src/platform/db/database.js';
import { bootstrapCompany, type BootstrapInput } from '../src/scripts/bootstrap-company.js';
import { createTestDatabase, query, type TestDatabase } from './support/test-database.js';

const INPUT: BootstrapInput = {
  companyCode: 'ACME',
  companyName: 'ACME SPA',
  rootCode: 'DG',
  rootName: 'Direction Générale',
  rootNameAr: 'المديرية العامة',
  siteCode: 'HQ',
  siteName: 'Siège',
  wilaya: 'Alger',
  adminEmail: 'Admin@Acme.dz',
  adminName: 'Première Admin',
};

describe('bootstrap: first company and admin on an empty database (e2e)', () => {
  let tdb: TestDatabase;
  let db: Database;

  beforeAll(async () => {
    tdb = await createTestDatabase(); // migrated, no seed
    db = createDatabase({ connectionString: tdb.migratorUrl, maxConnections: 1, applicationName: 'bootstrap-test' });
  });

  afterAll(async () => {
    await db?.destroy();
    await tdb?.drop();
  });

  it('creates company, root unit, roles, leave defaults, invited admin and a company-wide admin grant', async () => {
    const result = await db.transaction().execute((tx) => bootstrapCompany(tx, INPUT, '2026-09-27'));
    expect(result.admin.created).toBe(true);
    expect(result.admin.setupToken).toEqual(expect.any(String));
    expect(result.admin.email).toBe('admin@acme.dz');

    const url = tdb.superuserUrl;
    const [unit] = await query<{ kind: string; name: string; name_ar: string | null }>(
      url,
      `select u.kind, v.name, v.name_ar from org_unit u join org_unit_version v on v.org_unit_id = u.id where u.id = $1`,
      [result.rootUnitId],
    );
    expect(unit).toEqual({ kind: 'direction_generale', name: 'Direction Générale', name_ar: 'المديرية العامة' });

    const roles = await query<{ code: string }>(url, 'select code from role where company_id = $1 and is_system order by code', [result.companyId]);
    expect(roles.map((r) => r.code)).toEqual(expect.arrayContaining(['admin_rh_central', 'rh_regional', 'lecture', 'admin_acces', 'employe']));

    const types = await query<{ n: string }>(url, 'select count(*)::text as n from leave_type where company_id = $1', [result.companyId]);
    expect(Number(types[0]?.n)).toBeGreaterThan(0);

    const grants = await query<{ code: string; include_descendants: boolean; valid_from: string }>(
      url,
      `select r.code, g.include_descendants, g.valid_from::text from role_grant g join role r on r.id = g.role_id
        where g.company_id = $1 and g.user_id = $2 and g.org_unit_id = $3`,
      [result.companyId, result.admin.userId, result.rootUnitId],
    );
    expect(grants).toEqual([{ code: 'admin_rh_central', include_descendants: true, valid_from: '2026-09-27' }]);

    const employees = await query<{ n: string }>(url, 'select count(*)::text as n from employment where company_id = $1', [result.companyId]);
    expect(employees[0]?.n).toBe('0'); // no demo data
  });

  it('refuses to touch an existing company', async () => {
    await expect(db.transaction().execute((tx) => bootstrapCompany(tx, INPUT, '2026-09-27'))).rejects.toThrow(/already exists/);
  });

  it('validates codes', async () => {
    await expect(
      db.transaction().execute((tx) => bootstrapCompany(tx, { ...INPUT, companyCode: 'bad code' }, '2026-09-27')),
    ).rejects.toThrow(/company-code/);
  });
});
