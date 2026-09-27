import type { NestExpressApplication } from '@nestjs/platform-express';
import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PermissionEvaluator } from '../src/platform/authz/permission-evaluator.js';
import { currentTx } from '../src/platform/context/request-context.js';
import type { RequestIdentity } from '../src/platform/context/request-identity.js';
import { createTestApp } from './support/test-app.js';
import { createTestDatabase, type TestDatabase } from './support/test-database.js';

const COMPANY = '018f0000-0000-7000-8000-00000000000a';
const USER = '018f0000-0000-7000-8000-0000000000ee';

/** A DB-backed evaluator: reads the tenant settings through currentTx(), as the Authorization module will. */
class TxProbeEvaluator extends PermissionEvaluator {
  static seen: { companyId: string; userId: string; inTx: boolean }[] = [];
  async hasPermission(identity: RequestIdentity): Promise<boolean> {
    const tx = currentTx();
    const row = await sql<{ company_id: string; user_id: string }>`
      select current_setting('app.company_id', true) as company_id,
             current_setting('app.user_id', true) as user_id`.execute(tx);
    const r = row.rows[0];
    TxProbeEvaluator.seen.push({ companyId: r?.company_id ?? '', userId: r?.user_id ?? '', inTx: tx.isTransaction });
    return r?.company_id === identity.companyId;
  }
}

describe('Permission evaluation inside the request transaction (e2e)', () => {
  let db: TestDatabase;
  let app: NestExpressApplication;

  beforeAll(async () => {
    db = await createTestDatabase();
    app = await createTestApp(db, { evaluator: TxProbeEvaluator, mfa: 'off' }); // fictional tenant: no security policy
  });
  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });
  beforeEach(() => {
    TxProbeEvaluator.seen = [];
  });

  it('the evaluator runs with currentTx() scoped to the caller tenant (app.company_id / app.user_id set)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/_test/whoami')
      .set('X-Test-User', USER)
      .set('X-Test-Company', COMPANY)
      .expect(200);
    expect(res.body).toEqual({ userId: USER, companyId: COMPANY });
    expect(TxProbeEvaluator.seen).toEqual([{ companyId: COMPANY, userId: USER, inTx: true }]);
  });

  it('without a tenant the evaluator sees the nil company and denies → 403', async () => {
    await request(app.getHttpServer()).get('/api/_test/whoami').set('X-Test-User', USER).expect(403);
    expect(TxProbeEvaluator.seen).toEqual([{ companyId: '00000000-0000-0000-0000-000000000000', userId: USER, inTx: true }]);
  });

  it('anonymous callers are rejected by the guard (401) before any transaction/evaluator', async () => {
    await request(app.getHttpServer()).get('/api/_test/whoami').expect(401);
    expect(TxProbeEvaluator.seen).toEqual([]);
  });
});

describe('Deny-by-default without configureApp() (APP_GUARD / APP_INTERCEPTOR)', () => {
  let db: TestDatabase;
  let app: NestExpressApplication;

  beforeAll(async () => {
    db = await createTestDatabase();
    app = await createTestApp(db, { configure: false });
  });
  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  it('undecorated routes are still 403, protected routes 401/403, public routes open with a request tx', async () => {
    await request(app.getHttpServer()).get('/_test/undecorated').set('X-Test-User', USER).expect(403);
    await request(app.getHttpServer()).get('/_test/whoami').expect(401);
    await request(app.getHttpServer()).get('/_test/whoami').set('X-Test-User', USER).set('X-Test-Company', COMPANY).expect(403);
    const res = await request(app.getHttpServer()).get('/_test/context').expect(200);
    expect(res.body.hasTx).toBe(true);
  });
});

describe('DEV_AUTH wiring (e2e)', () => {
  let db: TestDatabase;
  let devApp: NestExpressApplication;
  let plainApp: NestExpressApplication;

  beforeAll(async () => {
    db = await createTestDatabase();
    devApp = await createTestApp(db, { devAuth: true, mfa: 'off' }); // fictional tenant: no security policy
    // DEV_AUTH=false with the env-driven defaults (anonymous resolver + deny-all evaluator).
    plainApp = await createTestApp(db, { devAuth: false, evaluator: null });
  });
  afterAll(async () => {
    await devApp?.close();
    await plainApp?.close();
    await db?.drop();
  });

  it('DEV_AUTH=true: X-Dev-* headers are the identity and every permission is granted', async () => {
    const res = await request(devApp.getHttpServer())
      .get('/api/_test/whoami')
      .set('X-Dev-User-Id', USER)
      .set('X-Dev-Company-Id', COMPANY)
      .expect(200);
    expect(res.body).toEqual({ userId: USER, companyId: COMPANY });
  });

  it('DEV_AUTH=true: missing or malformed headers are anonymous → 401', async () => {
    await request(devApp.getHttpServer()).get('/api/_test/whoami').expect(401);
    await request(devApp.getHttpServer())
      .get('/api/_test/whoami')
      .set('X-Dev-User-Id', 'not-a-uuid')
      .set('X-Dev-Company-Id', COMPANY)
      .expect(401);
  });

  it('DEV_AUTH=false: X-Dev-* headers are ignored (anonymous → 401)', async () => {
    await request(plainApp.getHttpServer())
      .get('/api/_test/whoami')
      .set('X-Dev-User-Id', USER)
      .set('X-Dev-Company-Id', COMPANY)
      .expect(401);
  });
});
