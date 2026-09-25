import type { NestExpressApplication } from '@nestjs/platform-express';
import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runInRequestTransaction } from '../src/platform/context/request-transaction.js';
import { currentTx } from '../src/platform/context/request-context.js';
import { createDatabase, type Database } from '../src/platform/db/database.js';
import { createTestApp, TestPermissionEvaluator } from './support/test-app.js';
import { createTestDatabase, query, type TestDatabase } from './support/test-database.js';

const COMPANY_A = '018f0000-0000-7000-8000-00000000000a';
const COMPANY_B = '018f0000-0000-7000-8000-00000000000b';
const USER = '018f0000-0000-7000-8000-0000000000ee';

const scoped = (companyId: string | null) => ({ requestId: 'rls-test', userId: USER, companyId });
const codes = () => currentTx().selectFrom('org_unit').select('code').orderBy('code').execute();

describe('Row-level security (e2e)', () => {
  let db: TestDatabase;
  let appDb: Database;
  let app: NestExpressApplication;

  beforeAll(async () => {
    db = await createTestDatabase();
    // Seed as superuser (bypasses RLS).
    await query(
      db.superuserUrl,
      `insert into company (id, code, name) values ($1, 'A', 'Company A'), ($2, 'B', 'Company B');
       `.trim(),
      [COMPANY_A, COMPANY_B],
    );
    await query(
      db.superuserUrl,
      `insert into org_unit (company_id, kind, code) values
         ($1, 'direction_generale', 'A-HQ'), ($1, 'department', 'A-OPS'), ($2, 'direction_generale', 'B-HQ')`,
      [COMPANY_A, COMPANY_B],
    );
    appDb = createDatabase({ connectionString: db.appUrl, maxConnections: 2 });
    app = await createTestApp(db);
  });

  afterAll(async () => {
    await app?.close();
    await appDb?.destroy();
    await db?.drop();
  });

  beforeEach(() => {
    TestPermissionEvaluator.granted = [];
  });

  it('the app role is not superuser, cannot bypass RLS and owns nothing', async () => {
    const [role] = await query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      db.superuserUrl,
      `select rolsuper, rolbypassrls from pg_roles where rolname = 'hrforce_app'`,
    );
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    const owned = await query(db.superuserUrl, `select 1 from pg_class c join pg_roles r on r.oid = c.relowner where r.rolname = 'hrforce_app'`);
    expect(owned).toHaveLength(0);
    const tables = await query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      db.superuserUrl,
      `select relname, relrowsecurity, relforcerowsecurity from pg_class where relname in ('company','org_unit','org_unit_version','org_unit_closure','site') order by relname`,
    );
    expect(tables).toHaveLength(5);
    expect(tables.every((t) => t.relrowsecurity && t.relforcerowsecurity)).toBe(true);
  });

  it('app role with app.company_id = A sees only A rows', async () => {
    const rows = await runInRequestTransaction(appDb, scoped(COMPANY_A), codes);
    expect(rows.map((r) => r.code)).toEqual(['A-HQ', 'A-OPS']);
    const companies = await runInRequestTransaction(appDb, scoped(COMPANY_A), () =>
      currentTx().selectFrom('company').select('code').execute(),
    );
    expect(companies.map((c) => c.code)).toEqual(['A']);
  });

  it('app role with app.company_id = B sees only B rows', async () => {
    const rows = await runInRequestTransaction(appDb, scoped(COMPANY_B), codes);
    expect(rows.map((r) => r.code)).toEqual(['B-HQ']);
  });

  it('app role with no company set sees nothing', async () => {
    expect(await runInRequestTransaction(appDb, scoped(null), codes)).toEqual([]);
    // A bare session (outside any request transaction) sees nothing either.
    const bare = await sql<{ n: string }>`select count(*)::text as n from org_unit`.execute(appDb);
    expect(bare.rows[0]?.n).toBe('0');
  });

  it('settings are transaction-local and do not leak across pooled connections', async () => {
    await runInRequestTransaction(appDb, scoped(COMPANY_A), codes);
    const after = await sql<{ n: string }>`select count(*)::text as n from org_unit`.execute(appDb);
    expect(after.rows[0]?.n).toBe('0');
  });

  it('cannot write rows for another company', async () => {
    await expect(
      runInRequestTransaction(appDb, scoped(COMPANY_A), () =>
        currentTx().insertInto('org_unit').values({ company_id: COMPANY_B, kind: 'region', code: 'XX' }).execute(),
      ),
    ).rejects.toThrow(/row-level security/);
    const updated = await runInRequestTransaction(appDb, scoped(COMPANY_A), () =>
      currentTx().updateTable('org_unit').set({ axis: 'management' }).where('code', '=', 'B-HQ').executeTakeFirst(),
    );
    expect(updated.numUpdatedRows).toBe(0n);
  });

  it('rejects a non-UUID company id before touching the database', async () => {
    await expect(runInRequestTransaction(appDb, scoped("x' or 1=1 --"), codes)).rejects.toThrow(/companyId must be a UUID/);
  });

  it('HTTP: the request transaction is scoped to the caller company and carries audit settings', async () => {
    TestPermissionEvaluator.granted = ['org_unit.read'];
    const res = await request(app.getHttpServer())
      .get('/api/_test/org-units')
      .set('X-Test-User', USER)
      .set('X-Test-Company', COMPANY_B)
      .expect(200);
    expect(res.body).toEqual({ codes: ['B-HQ'], settings: { companyId: COMPANY_B, userId: USER } });
  });

  it('HTTP: permission not granted → 403', async () => {
    await request(app.getHttpServer())
      .get('/api/_test/org-units')
      .set('X-Test-User', USER)
      .set('X-Test-Company', COMPANY_A)
      .expect(403);
  });

  it('HTTP: an error rolls back the request transaction', async () => {
    TestPermissionEvaluator.granted = ['org_unit.create'];
    await request(app.getHttpServer())
      .post('/api/_test/org-units/fail-after-insert')
      .set('X-Test-User', USER)
      .set('X-Test-Company', COMPANY_A)
      .send({ companyId: COMPANY_A, code: 'A-ROLLBACK' })
      .expect(500);
    const rows = await query(db.superuserUrl, `select 1 from org_unit where code = 'A-ROLLBACK'`);
    expect(rows).toHaveLength(0);
  });
});
