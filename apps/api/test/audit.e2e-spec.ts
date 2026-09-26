/**
 * Audit slice (docs/contracts/audit.md): trigger capture on every audited table, masking, append-only storage,
 * privileges, monthly partitions, application events, and GET /api/audit/timeline (merge, scope, pagination).
 * Plan exit criterion: "every write through the API produces an audit row with before and after values".
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_PASSWORD, inviteUser } from '../src/modules/identity/index.js';
import { createDatabase } from '../src/platform/db/database.js';
import { as, COMPANY_A, GRANTS, seedAccessFixture, unitA, unitB, USERS, type AccessFixture, type ActorName } from './support/access-fixture.js';
import { assertNoSecrets } from './support/assert-no-secrets.js';
import { Browser } from './support/cookie-jar.js';
import { createTestApp } from './support/test-app.js';
import { createTestDatabase, query, type TestDatabase } from './support/test-database.js';
import { fetchXsrf, type XsrfPair } from './support/xsrf.js';

interface ChangeRow {
  id: string;
  company_id: string;
  table_name: string;
  row_id: string | null;
  op: 'insert' | 'update' | 'delete';
  actor_user_id: string | null;
  request_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  changed: string[];
}

interface EventRow {
  company_id: string | null;
  actor_user_id: string | null;
  request_id: string | null;
  type: string;
  subject_type: string | null;
  subject_id: string | null;
  data: Record<string, unknown>;
}

interface Entry {
  id: string;
  at: string;
  actor: { id: string; displayName: string } | null;
  requestId: string | null;
  kind: 'change' | 'event';
  table?: string;
  op?: string;
  changes?: { field: string; before: unknown; after: unknown; masked: boolean }[];
  event?: { type: string; data: Record<string, unknown> };
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const AUDITED_TABLES = ['company', 'org_unit', 'org_unit_version', 'role', 'role_grant', 'role_permission', 'site'];
const C = '0190a5d0-0000-7000-8000-00000000c0de';

let db: TestDatabase;
let app: NestExpressApplication;
let fx: AccessFixture;
let xsrf: XsrfPair;
let seq = 0;

const client = (actor: ActorName) => as(app, actor, xsrf);
const tenant = (companyId: string) => [`select set_config('app.company_id', '${companyId}', true)`];
/** A day of January 2028 (future versions/grants that never collide with the other suites' dates). */
const day = (n: number) => new Date(Date.UTC(2028, 0, n)).toISOString().slice(0, 10);
const rid = (label: string) => `audit-e2e-${label}-${++seq}`;

function changes(where: string, values: unknown[] = []): Promise<ChangeRow[]> {
  return query<ChangeRow>(db.superuserUrl, `select id::text, company_id, table_name, row_id, op, actor_user_id, request_id, before, after, changed
                                              from audit.change_log where ${where} order by id`, values);
}

function events(where: string, values: unknown[] = []): Promise<EventRow[]> {
  return query<EventRow>(db.superuserUrl, `select company_id, actor_user_id, request_id, type, subject_type, subject_id, data
                                             from audit.event where ${where} order by id`, values);
}

/** Runs statements as one role in one transaction; returns the last result's rows. */
async function asRole(url: string, statements: (string | [string, unknown[]])[], { rollback = false } = {}): Promise<unknown[]> {
  const pg = new Client({ connectionString: url });
  await pg.connect();
  try {
    await pg.query('begin');
    let rows: unknown[] = [];
    for (const s of statements) rows = (typeof s === 'string' ? await pg.query(s) : await pg.query(s[0], s[1])).rows;
    await pg.query(rollback ? 'rollback' : 'commit');
    return rows;
  } catch (error) {
    await pg.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await pg.end();
  }
}

async function timeline(actor: ActorName, subject: string, extra = ''): Promise<{ status: number; items: Entry[]; nextCursor: string | null; body: unknown }> {
  const res = await client(actor).get(`/api/audit/timeline?subject=${subject}${extra}`);
  const body = res.body as { items?: Entry[]; nextCursor?: string | null };
  return { status: res.status, items: body.items ?? [], nextCursor: body.nextCursor ?? null, body: res.body };
}

beforeAll(async () => {
  db = await createTestDatabase();
  fx = await seedAccessFixture(db);
  app = await createTestApp(db, { devAuth: true, devPermissions: false });
  xsrf = await fetchXsrf(app);
});

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

// ---------------------------------------------------------------------------------------------------------------
describe('schema: coverage, partitions, privileges', () => {
  it('audit.capture() is attached to every tenant table except org_unit_closure', async () => {
    const rows = await query<{ table: string }>(
      db.superuserUrl,
      `select c.relname as table from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid
        where p.proname = 'capture' and p.pronamespace = 'audit'::regnamespace and c.relnamespace = 'public'::regnamespace
        order by 1`,
    );
    expect(rows.map((r) => r.table)).toEqual(AUDITED_TABLES);
  });

  it('partitions exist for the current month and the next 12, and rows land in the right one', async () => {
    const parts = await query<{ parent: string; child: string }>(
      db.superuserUrl,
      `select p.relname as parent, c.relname as child from pg_inherits i join pg_class c on c.oid = i.inhrelid
         join pg_class p on p.oid = i.inhparent where p.relnamespace = 'audit'::regnamespace order by 1, 2`,
    );
    const now = new Date();
    const months = Array.from({ length: 13 }, (_, i) => {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
      return `y${d.getUTCFullYear()}m${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    });
    for (const parent of ['change_log', 'event']) {
      expect(parts.filter((p) => p.parent === parent).map((p) => p.child)).toEqual([`${parent}_default`, ...months.map((m) => `${parent}_${m}`)]);
    }
    // the seed's rows went to this month's partition
    const [seeded] = await query<{ part: string }>(db.superuserUrl, `select tableoid::regclass::text as part from audit.change_log order by id desc limit 1`);
    expect(seeded?.part).toBe(`audit.change_log_${months[0]}`);
    // explicit timestamps (superuser, rolled back): month 5 ahead → its partition; beyond the horizon → default
    const routed = await asRole(db.superuserUrl, [
      [
        `insert into audit.change_log (company_id, at, table_name, op, after, changed)
         values ($1, date_trunc('month', now()) + interval '5 months 3 days', 'site', 'insert', '{}', '{}'),
                ($1, now() + interval '5 years', 'site', 'insert', '{}', '{}')
         returning tableoid::regclass::text as part`,
        [COMPANY_A],
      ],
    ], { rollback: true });
    expect(routed).toEqual([{ part: `audit.change_log_${months[5]}` }, { part: 'audit.change_log_default' }]);
  });

  it('ensure_partitions is idempotent (migrator)', async () => {
    const [row] = await asRole(db.migratorUrl, ['select audit.ensure_partitions(12) as created']);
    expect(row).toEqual({ created: 0 });
  });

  it('hrforce_app cannot write audit rows, read partitions or run ensure_partitions; it reads its tenant through the parents (RLS)', async () => {
    for (const statement of [
      `insert into audit.change_log (company_id, table_name, op, after, changed) values ('${COMPANY_A}', 'site', 'insert', '{}', '{}')`,
      `insert into audit.event (company_id, type) values ('${COMPANY_A}', 'x.y')`,
      'update audit.change_log set op = op',
      'delete from audit.change_log',
      'delete from audit.event',
      'update audit.event set type = type',
      'truncate audit.change_log',
      'select count(*) from audit.change_log_default',
      'select count(*) from audit.event_default',
      `select count(*) from audit.${(await query<{ n: string }>(db.superuserUrl, `select relname as n from pg_class where relname like 'change_log_y%' order by 1 limit 1`))[0]?.n}`,
      'select audit.ensure_partitions(1)',
      'insert into audit.masked_column values (\'site\', \'name\')',
    ]) {
      await expect(asRole(db.appUrl, [...tenant(COMPANY_A), statement]), statement).rejects.toThrow(/permission denied/);
    }
    const [mine] = (await asRole(db.appUrl, [...tenant(COMPANY_A), 'select count(*)::int as n, count(*) filter (where company_id <> current_setting(\'app.company_id\')::uuid)::int as foreign from audit.change_log'])) as { n: number; foreign: number }[];
    expect(mine?.n).toBeGreaterThan(0);
    expect(mine?.foreign).toBe(0);
    const total = await query<{ n: number }>(db.superuserUrl, 'select count(*)::int as n from audit.change_log');
    expect(mine?.n).toBeLessThan(total[0]?.n ?? 0);
    expect(await asRole(db.appUrl, [...tenant('00000000-0000-0000-0000-000000000000'), 'select count(*)::int as n from audit.change_log'])).toEqual([{ n: 0 }]);
  });

  it('append-only: UPDATE, DELETE and TRUNCATE raise for the migrator too unless audit.allow_purge is on', async () => {
    // (an event is recorded first in the same transaction so that the row triggers have a row to refuse)
    const seedEvent = `select audit.record_event('test.append_only', null, null, '{}')`;
    for (const statement of ['update audit.change_log set op = op', 'delete from audit.change_log', 'truncate audit.change_log', 'delete from audit.event', 'update audit.event set type = type', 'truncate audit.event']) {
      await expect(asRole(db.migratorUrl, [seedEvent, statement]), statement).rejects.toThrow(/append-only/);
    }
    const purged = await asRole(db.migratorUrl, [`set local audit.allow_purge = 'on'`, `with d as (delete from audit.change_log where table_name = 'site' returning 1) select count(*)::int as n from d`], { rollback: true });
    expect((purged[0] as { n: number }).n).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('capture (direct SQL as the migrator: actor and request id null)', () => {
  it('the seed was audited with actor null', async () => {
    const seeded = await changes(`company_id = $1 and table_name = 'company'`, [COMPANY_A]);
    expect(seeded[0]).toMatchObject({ op: 'insert', row_id: COMPANY_A, actor_user_id: null, request_id: null, before: null });
    expect(seeded[0]?.after).toMatchObject({ id: COMPANY_A, code: 'DEMO' });
  });

  it('every audited table records insert, update and delete with before/after/changed', async () => {
    const role = '0190a5d0-0000-7000-8000-00000000c001';
    const unit = '0190a5d0-0000-7000-8000-00000000c002';
    const version = '0190a5d0-0000-7000-8000-00000000c003';
    const site = '0190a5d0-0000-7000-8000-00000000c004';
    const grant = '0190a5d0-0000-7000-8000-00000000c005';
    const before = await query<{ n: string }>(db.superuserUrl, 'select coalesce(max(id), 0)::text as n from audit.change_log');
    await asRole(db.migratorUrl, [
      `insert into company (id, code, name) values ('${C}', 'AUDIT-C', 'Audit Co')`,
      `update company set name = 'Audit Company' where id = '${C}'`,
      `insert into site (id, company_id, code, name, wilaya) values ('${site}', '${C}', 'S-AUD', 'Site', 'Alger')`,
      `update site set wilaya = 'Oran', address = 'Rue 1' where id = '${site}'`,
      `insert into org_unit (id, company_id, kind, code) values ('${unit}', '${C}', 'direction_generale', 'AUD-DG')`,
      `update org_unit set axis = 'management' where id = '${unit}'`, // no-op: nothing recorded
      `insert into org_unit_version (id, company_id, org_unit_id, name, valid) values ('${version}', '${C}', '${unit}', 'DG', '[2026-01-01,)')`,
      `update org_unit_version set name = 'DG Audit', site_id = '${site}' where id = '${version}'`,
      `insert into role (id, company_id, code, name_fr, name_ar, name_en) values ('${role}', '${C}', 'aud_role', 'R', 'ر', 'R')`,
      `update role set name_fr = 'Rôle' where id = '${role}'`,
      `insert into role_permission (company_id, role_id, permission_code) values ('${C}', '${role}', 'site.read')`,
      `insert into role_grant (id, company_id, user_id, role_id, org_unit_id, valid_from) values ('${grant}', '${C}', '${USERS.newbie.id}', '${role}', '${unit}', '2026-01-01')`,
      `update role_grant set valid_to = '2026-06-01', ended_at = now() where id = '${grant}'`,
      `delete from role_grant where id = '${grant}'`,
      `delete from role_permission where role_id = '${role}'`,
      `delete from role where id = '${role}'`,
      `delete from org_unit_version where id = '${version}'`,
      `delete from org_unit where id = '${unit}'`,
      `delete from site where id = '${site}'`,
      `delete from company where id = '${C}'`,
    ]);
    const rows = await changes('id > $1', [before[0]?.n]);
    expect(rows.every((r) => r.company_id === C && r.actor_user_id === null && r.request_id === null)).toBe(true);
    const byTable = (t: string) => rows.filter((r) => r.table_name === t);
    for (const table of AUDITED_TABLES) {
      const ops = byTable(table).map((r) => r.op);
      expect(ops, table).toEqual(table === 'role_permission' || table === 'org_unit' ? ['insert', 'delete'] : ['insert', 'update', 'delete']);
    }
    const [insertSite, updateSite, deleteSite] = byTable('site');
    expect(insertSite).toMatchObject({ row_id: site, before: null, changed: ['id', 'company_id', 'code', 'name', 'wilaya', 'address', 'created_at'] });
    expect(insertSite?.after).toMatchObject({ id: site, code: 'S-AUD', wilaya: 'Alger', address: null });
    expect(updateSite).toMatchObject({ changed: ['wilaya', 'address'], before: { id: site, wilaya: 'Alger', address: null }, after: { id: site, wilaya: 'Oran', address: 'Rue 1' } });
    expect(deleteSite).toMatchObject({ after: null, before: { id: site, wilaya: 'Oran', address: 'Rue 1' } });
    // generated columns (name_search, valid of role_grant) are derived and left out
    const [, updateVersion] = byTable('org_unit_version');
    expect(updateVersion).toMatchObject({ changed: ['name', 'site_id'], before: { id: version, name: 'DG', site_id: null }, after: { id: version, name: 'DG Audit', site_id: site } });
    expect(byTable('org_unit_version')[0]?.changed).not.toContain('name_search');
    expect(byTable('role_grant')[1]).toMatchObject({ changed: ['valid_to', 'ended_at'], before: { valid_to: null } , after: { valid_to: '2026-06-01' } });
    expect(byTable('role_grant')[0]?.changed).not.toContain('valid');
    // role_permission is keyed on its role; company rows on their own id
    expect(byTable('role_permission').map((r) => r.row_id)).toEqual([role, role]);
    expect(byTable('role_permission')[0]?.after).toEqual({ company_id: C, role_id: role, permission_code: 'site.read' });
    expect(byTable('company')[1]).toMatchObject({ row_id: C, changed: ['name'], before: { id: C, name: 'Audit Co' }, after: { id: C, name: 'Audit Company' } });
  });

  it('an update that changes nothing writes no row', async () => {
    const count = async () => (await query<{ n: number }>(db.superuserUrl, 'select count(*)::int as n from audit.change_log'))[0]?.n;
    const n = await count();
    await asRole(db.migratorUrl, [`update site set name = name, wilaya = wilaya where company_id = '${COMPANY_A}'`, `update role set name_fr = name_fr`]);
    expect(await count()).toBe(n);
  });

  it('masked columns hold "***" (non-null values) but stay in `changed` — fixture table', async () => {
    const id = '0190a5d0-0000-7000-8000-00000000c010';
    await asRole(db.migratorUrl, [
      `create table public.audit_fixture_secret (id uuid primary key, company_id uuid not null, iban text, note text)`,
      `create trigger audit_capture_tg after insert or update or delete on public.audit_fixture_secret for each row execute function audit.capture()`,
      `insert into audit.masked_column (table_name, column_name) values ('audit_fixture_secret', 'iban')`,
    ]);
    try {
      await asRole(db.migratorUrl, [
        `insert into public.audit_fixture_secret values ('${id}', '${COMPANY_A}', 'DZ58 0001 2345', 'hello')`,
        `update public.audit_fixture_secret set iban = 'DZ58 9999 0000' where id = '${id}'`,
        `update public.audit_fixture_secret set note = 'bye' where id = '${id}'`,
        `update public.audit_fixture_secret set iban = null where id = '${id}'`,
        `delete from public.audit_fixture_secret where id = '${id}'`,
      ]);
      const rows = await changes(`table_name = 'audit_fixture_secret'`);
      expect(rows.map((r) => [r.op, r.changed, r.before, r.after])).toEqual([
        ['insert', ['id', 'company_id', 'iban', 'note'], null, { id, company_id: COMPANY_A, iban: '***', note: 'hello' }],
        ['update', ['iban'], { id, iban: '***' }, { id, iban: '***' }],
        ['update', ['note'], { id, note: 'hello' }, { id, note: 'bye' }],
        ['update', ['iban'], { id, iban: '***' }, { id, iban: null }],
        ['delete', ['id', 'company_id', 'iban', 'note'], { id, company_id: COMPANY_A, iban: null, note: 'bye' }, null],
      ]);
      expect(JSON.stringify(rows)).not.toMatch(/DZ58/);
    } finally {
      await asRole(db.migratorUrl, [`drop table public.audit_fixture_secret`, `delete from audit.masked_column where table_name = 'audit_fixture_secret'`]);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('exit criterion: every write through the API produces an audit row with before and after values', () => {
  interface Write {
    request: () => { path: string; body: object };
    /** tables that must have a row for this request */
    tables: string[];
  }
  const WRITES: Record<string, Write> = {
    'POST /api/org/units': {
      request: () => ({ path: '/api/org/units', body: { kind: 'service', code: 'AUD-SRV', name: 'Service Audit', parentId: unitA('REG-EST') } }),
      tables: ['org_unit', 'org_unit_version'],
    },
    'PATCH /api/org/units/:id': {
      request: () => ({ path: `/api/org/units/${unitA('AG-TLEMCEN')}`, body: { name: 'Agence Tlemcen Centre', validFrom: day(10) } }),
      tables: ['org_unit_version'],
    },
    'POST /api/org/sites': { request: () => ({ path: '/api/org/sites', body: { code: 'AUD-SITE', name: 'Site Audit', wilaya: 'Béjaïa' } }), tables: ['site'] },
    'POST /api/access/roles': {
      request: () => ({ path: '/api/access/roles', body: { code: 'aud_custom', names: { fr: 'Audit', ar: 'تدقيق', en: 'Audit' }, permissions: ['org_unit.read'] } }),
      tables: ['role', 'role_permission'],
    },
    'PATCH /api/access/roles/:id': {
      request: () => ({ path: `/api/access/roles/${fx.customA}`, body: { names: { fr: 'Personnalisé A', ar: 'مخصص أ', en: 'Custom A' }, permissions: ['site.read'] } }),
      tables: ['role', 'role_permission'],
    },
    'POST /api/access/grants': {
      request: () => ({ path: '/api/access/grants', body: { userId: USERS.newbie.id, roleId: fx.rolesA['lecture'], orgUnitId: unitA('AG-BLIDA'), includeDescendants: true, validFrom: day(1) } }),
      tables: ['role_grant'],
    },
    'POST /api/access/grants/:id/end': { request: () => ({ path: `/api/access/grants/${GRANTS.targetOran}/end`, body: { validTo: '2029-01-01' } }), tables: ['role_grant'] },
  };

  it('covers every write route of the route-scan outside /api/auth', () => {
    const result = spawnSync(process.execPath, ['tools/guardrails/route-scan/route-scan.ts', '--json'], { cwd: REPO_ROOT, encoding: 'utf8' });
    const routes = (JSON.parse(result.stdout) as { routes: { method: string; path: string }[] }).routes;
    const writes = routes.filter((r) => r.method !== 'GET' && !r.path.startsWith('/api/auth/')).map((r) => `${r.method} ${r.path}`);
    expect(Object.keys(WRITES).toSorted()).toEqual(writes.toSorted());
  });

  it.each(Object.keys(WRITES))('%s', async (key) => {
    const spec = WRITES[key];
    if (!spec) throw new Error(key);
    const { path: url, body } = spec.request();
    const requestId = rid('write');
    const call = key.startsWith('PATCH') ? client('admin').patch(url) : client('admin').post(url);
    const res = await call.set('X-Request-Id', requestId).send(body);
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    const rows = await changes('request_id = $1', [requestId]);
    expect(rows.length).toBeGreaterThan(0);
    expect([...new Set(rows.map((r) => r.table_name))].toSorted()).toEqual(expect.arrayContaining(spec.tables));
    for (const row of rows) {
      expect(row).toMatchObject({ company_id: COMPANY_A, actor_user_id: USERS.admin.id, request_id: requestId });
      if (row.op !== 'delete') expect(row.after, `${row.table_name} ${row.op}`).not.toBeNull();
      if (row.op !== 'insert') expect(row.before, `${row.table_name} ${row.op}`).not.toBeNull();
      expect(row.changed.length).toBeGreaterThan(0);
      for (const field of row.changed) {
        if (row.op !== 'delete') expect(row.after, field).toHaveProperty(field);
        if (row.op !== 'insert') expect(row.before, field).toHaveProperty(field);
      }
    }
    // an update carries both values of every changed column
    for (const row of rows.filter((r) => r.op === 'update')) {
      for (const field of row.changed) expect(row.before?.[field], field).not.toEqual(row.after?.[field]);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('application events', () => {
  it('auth.login, auth.logout and auth.session_reuse (own transaction, user company, request id)', async () => {
    const b = new Browser(app);
    const login = await b.login(USERS.est.email, DEMO_PASSWORD);
    expect(login.status).toBe(204);
    const loginRequest = String(login.headers['x-request-id']);
    const staleRefresh = b.jar.get('hrf_rt');
    expect((await b.post('/api/auth/logout')).status).toBe(204);
    // presenting the revoked refresh token again = reuse → the family is revoked, 401
    if (staleRefresh) b.jar.set('hrf_rt', staleRefresh, '/api/auth');
    const reuse = await b.post('/api/auth/refresh');
    expect(reuse.status).toBe(401);

    const rows = await events(`subject_id = $1 and type like 'auth.%'`, [USERS.est.id]);
    expect(rows.map((e) => e.type)).toEqual(['auth.login', 'auth.logout', 'auth.session_reuse']);
    expect(rows[0]).toMatchObject({ company_id: COMPANY_A, actor_user_id: USERS.est.id, request_id: loginRequest, subject_type: 'user' });
    expect(Object.keys(rows[0]?.data ?? {}).toSorted()).toEqual(['ip', 'userAgent']);
    expect(rows[0]?.data['ip']).toEqual(expect.any(String));
    expect(rows[1]).toMatchObject({ company_id: COMPANY_A, actor_user_id: USERS.est.id, data: {} });
    expect(rows[2]).toMatchObject({ company_id: COMPANY_A, actor_user_id: null, request_id: String(reuse.headers['x-request-id']) });
    expect(rows[2]?.data).toEqual({ familyId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  });

  it('a failed login writes no event', async () => {
    const before = (await events(`type = 'auth.login'`)).length;
    expect((await new Browser(app).login(USERS.est.email, 'wrong-password-123')).status).toBe(401);
    expect((await events(`type = 'auth.login'`)).length).toBe(before);
  });

  it('auth.password_set (setup link consumed)', async () => {
    const migrator = createDatabase({ connectionString: db.migratorUrl, maxConnections: 1 });
    const invited = await migrator
      .transaction()
      .execute((tx) => inviteUser(tx, { email: 'audit.invite@demo.dz', displayName: 'Invité Audit', companyCode: 'DEMO' }))
      .finally(() => migrator.destroy());
    const b = new Browser(app);
    await b.get('/api/auth/csrf');
    const res = await b.post('/api/auth/password/setup', { token: invited.setupToken, password: 'a-long-enough-passphrase-2026' });
    expect(res.status).toBe(204);
    expect(await events(`type = 'auth.password_set'`)).toEqual([
      { company_id: COMPANY_A, actor_user_id: invited.userId, request_id: String(res.headers['x-request-id']), type: 'auth.password_set', subject_type: 'user', subject_id: invited.userId, data: { purpose: 'setup' } },
    ]);
  });

  it('access.grant_created and access.grant_ended, in the request transaction, next to the role_grant rows', async () => {
    const created = await client('admin')
      .post('/api/access/grants')
      .set('X-Request-Id', rid('grant'))
      .send({ userId: USERS.newbie.id, roleId: fx.rolesA['lecture'], orgUnitId: unitA('AG-CNE'), includeDescendants: false, validFrom: '2027-02-01', validTo: '2027-12-01' });
    expect(created.status).toBe(201);
    const grantId = (created.body as { id: string }).id;
    const ended = await client('admin').post(`/api/access/grants/${grantId}/end`).send({ validTo: '2027-06-01' });
    expect(ended.status).toBe(200);
    const rows = await events(`type like 'access.grant_%' and data ->> 'grantId' = $1`, [grantId]);
    expect(rows).toEqual([
      {
        company_id: COMPANY_A, actor_user_id: USERS.admin.id, request_id: String(created.headers['x-request-id']), type: 'access.grant_created',
        subject_type: 'user', subject_id: USERS.newbie.id,
        data: { grantId, roleCode: 'lecture', unitId: unitA('AG-CNE'), validFrom: '2027-02-01', validTo: '2027-12-01' },
      },
      {
        company_id: COMPANY_A, actor_user_id: USERS.admin.id, request_id: String(ended.headers['x-request-id']), type: 'access.grant_ended',
        subject_type: 'user', subject_id: USERS.newbie.id,
        data: { grantId, roleCode: 'lecture', unitId: unitA('AG-CNE'), validFrom: '2027-02-01', validTo: '2027-06-01' },
      },
    ]);
    // the row trigger captured the same writes
    expect((await changes(`table_name = 'role_grant' and row_id = $1`, [grantId])).map((r) => r.op)).toEqual(['insert', 'update']);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('GET /api/audit/timeline', () => {
  it('org_unit: rename + future move, merged with its versions, actor names, newest first', async () => {
    const annaba = unitA('AG-ANNABA');
    const rename = await client('admin').patch(`/api/org/units/${annaba}`).send({ name: 'Agence Annaba Port', validFrom: '2027-01-01' });
    expect(rename.status, JSON.stringify(rename.body)).toBe(200);
    const move = await client('admin').patch(`/api/org/units/${annaba}`).send({ parentId: unitA('REG-OUEST'), validFrom: '2027-07-01' });
    expect(move.status, JSON.stringify(move.body)).toBe(200);

    const { status, items, body } = await timeline('admin', `org_unit:${annaba}`);
    expect(status).toBe(200);
    assertNoSecrets(body);
    expect(items.map((i) => Date.parse(i.at))).toEqual(items.map((i) => Date.parse(i.at)).toSorted((a, b) => b - a));
    const byAdmin = items.filter((i) => i.actor?.id === USERS.admin.id);
    expect(byAdmin.every((i) => i.actor?.displayName === USERS.admin.displayName && i.requestId)).toBe(true);
    // newest first: the move (insert of the 2027-07 version + close of the 2027-01 one), then the rename
    const [moveInsert, moveClose, renameInsert, renameClose] = byAdmin.map((i) => ({ table: i.table, op: i.op, changes: i.changes }));
    expect(moveInsert).toMatchObject({ table: 'org_unit_version', op: 'insert' });
    expect(moveInsert?.changes).toEqual(expect.arrayContaining([
      { field: 'parent_id', before: null, after: unitA('REG-OUEST'), masked: false },
      { field: 'name', before: null, after: 'Agence Annaba Port', masked: false },
      { field: 'valid', before: null, after: '[2027-07-01,)', masked: false },
    ]));
    expect(moveClose).toEqual({ table: 'org_unit_version', op: 'update', changes: [{ field: 'valid', before: '[2027-01-01,)', after: '[2027-01-01,2027-07-01)', masked: false }] });
    expect(renameInsert?.changes).toEqual(expect.arrayContaining([{ field: 'name', before: null, after: 'Agence Annaba Port', masked: false }]));
    expect(renameClose?.op).toBe('update');
    // the seed's rows (actor null) close the history: the unit itself and its first version
    const seeded = items.filter((i) => i.actor === null);
    expect(seeded.map((i) => `${i.table}:${i.op}`).toSorted()).toEqual(['org_unit:insert', 'org_unit_version:insert']);
    expect(items.every((i) => i.kind === 'change' && /^c:\d+$/.test(i.id))).toBe(true);
  });

  it('user: grant rows in scope + events about the user; role: role + role_permission rows', async () => {
    const user = await timeline('admin', `user:${USERS.newbie.id}`);
    expect(user.status).toBe(200);
    const types = user.items.map((i) => (i.kind === 'event' ? i.event?.type : `${i.table}:${i.op}`));
    expect(types).toEqual(expect.arrayContaining(['access.grant_created', 'access.grant_ended', 'role_grant:insert', 'role_grant:update']));
    const event = user.items.find((i) => i.event?.type === 'access.grant_created');
    expect(event).toMatchObject({ kind: 'event', actor: { id: USERS.admin.id, displayName: USERS.admin.displayName }, event: { data: { roleCode: 'lecture' } } });
    expect(event?.id).toMatch(/^e:\d+$/);
    // an event and its row change share the request's timestamp: the event is listed first
    const createdAt = event?.at;
    const sameInstant = user.items.filter((i) => i.at === createdAt).map((i) => i.kind);
    expect(sameInstant[0]).toBe('event');

    const est = await timeline('admin', `user:${USERS.est.id}`);
    expect(est.items.map((i) => i.event?.type).filter(Boolean)).toEqual(['auth.session_reuse', 'auth.logout', 'auth.login']);
    expect(est.items.find((i) => i.event?.type === 'auth.session_reuse')?.actor).toBeNull();

    const role = await timeline('admin', `role:${fx.customA}`);
    expect(role.status).toBe(200);
    expect(new Set(role.items.map((i) => i.table))).toEqual(new Set(['role', 'role_permission']));
    expect(role.items.find((i) => i.table === 'role_permission' && i.op === 'insert')?.changes).toEqual(
      expect.arrayContaining([{ field: 'permission_code', before: null, after: 'site.read', masked: false }]),
    );
    const site = await timeline('admin', `site:${(await query<{ id: string }>(db.superuserUrl, `select id from site where code = 'AUD-SITE'`))[0]?.id}`);
    expect(site.items.map((i) => `${i.table}:${i.op}:${i.actor?.displayName}`)).toEqual([`site:insert:${USERS.admin.displayName}`]);
  });

  it('scope: no audit.read → 403; admin_acces limited to REG-EST → 404 outside it; other company, unknown, malformed → 404; bad type/cursor → 422', async () => {
    expect((await timeline('est', `org_unit:${unitA('AG-CNE')}`)).status).toBe(403);
    expect((await timeline('ouest', `user:${USERS.ouest.id}`)).status).toBe(403);
    // acces: admin_acces (holds audit.read) on REG-EST (+)
    expect((await timeline('acces', `org_unit:${unitA('AG-CNE')}`)).status).toBe(200);
    expect((await timeline('acces', `org_unit:${unitA('AG-ORAN')}`)).status).toBe(404);
    expect((await timeline('acces', `org_unit:${unitA('DG')}`)).status).toBe(404);
    expect((await timeline('acces', `user:${USERS.ouest.id}`)).status).toBe(404); // grants on REG-OUEST only
    expect((await timeline('acces', `user:${USERS.newbie.id}`)).status).toBe(200); // a grant on AG-CNE
    // target holds grants on AG-CNE (in scope) and AG-ORAN (not): only the CNE grant's rows are listed
    const target = await timeline('acces', `user:${USERS.target.id}`);
    expect(target.status).toBe(200);
    const grantRows = target.items.filter((i) => i.table === 'role_grant').map((i) => i.changes?.find((c) => c.field === 'id')?.after);
    expect(grantRows).toContain(GRANTS.targetCne);
    expect(grantRows).not.toContain(GRANTS.targetOran);
    expect((await timeline('admin', `user:${USERS.target.id}`)).items.filter((i) => i.table === 'role_grant').length).toBeGreaterThan(target.items.filter((i) => i.table === 'role_grant').length);
    // grant events follow the grant's unit: one on AG-ORAN (out of scope) is not listed for acces
    const oran = await client('admin')
      .post('/api/access/grants')
      .send({ userId: USERS.target.id, roleId: fx.rolesA['lecture'], orgUnitId: unitA('AG-ORAN'), includeDescendants: false, validFrom: '2031-01-01' });
    expect(oran.status).toBe(201);
    const eventUnits = (who: ActorName) => timeline(who, `user:${USERS.target.id}`).then((t) => t.items.filter((i) => i.kind === 'event').map((i) => i.event?.data['unitId']));
    expect(await eventUnits('admin')).toContain(unitA('AG-ORAN'));
    expect(await eventUnits('acces')).not.toContain(unitA('AG-ORAN'));
    // roles and sites: company-wide with audit.read anywhere
    expect((await timeline('acces', `role:${fx.customA}`)).status).toBe(200);
    // other company / unknown / malformed
    expect((await timeline('admin', `org_unit:${unitB('BETA-RH')}`)).status).toBe(404);
    expect((await timeline('admin', `role:${fx.customB}`)).status).toBe(404);
    expect((await timeline('admin', `user:${USERS.beta.id}`)).status).toBe(404);
    expect((await timeline('beta', `user:${USERS.admin.id}`)).status).toBe(404);
    expect((await timeline('admin', 'site:0190a5d0-0000-7000-8000-00000000dead')).status).toBe(404);
    expect((await timeline('admin', 'org_unit:not-a-uuid')).status).toBe(404);
    const badType = await timeline('admin', `employee:${USERS.admin.id}`);
    expect(badType.status).toBe(422);
    expect(badType.body).toMatchObject({ errors: [{ field: 'subject', code: 'invalid_subject' }] });
    expect((await client('admin').get('/api/audit/timeline')).status).toBe(422);
    const badCursor = await timeline('admin', `org_unit:${unitA('DG')}`, '&before=bm9wZQ');
    expect(badCursor.status).toBe(422);
    expect(badCursor.body).toMatchObject({ errors: [{ field: 'before', code: 'invalid_cursor' }] });
    expect((await timeline('admin', `org_unit:${unitA('DG')}`, '&limit=0')).status).toBe(422);
    // the other company sees its own history
    expect((await timeline('beta', `org_unit:${unitB('BETA-RH')}`)).items.length).toBeGreaterThan(0);
  });

  it('pagination: stable cursor over (at, kind, id); pages concatenate to the full list', async () => {
    for (let n = 1; n <= 4; n++) {
      const res = await client('admin').patch(`/api/access/roles/${fx.customA}`).send({ names: { fr: `Page ${n}`, ar: 'مخصص', en: `Page ${n}` }, permissions: n % 2 ? ['org_unit.read', 'site.read'] : ['site.read'] });
      expect(res.status).toBe(200);
    }
    const all = await timeline('admin', `role:${fx.customA}`, '&limit=100');
    expect(all.nextCursor).toBeNull();
    expect(all.items.length).toBeGreaterThan(8);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Awaited<ReturnType<typeof timeline>> = await timeline('admin', `role:${fx.customA}`, `&limit=3${cursor ? `&before=${cursor}` : ''}`);
      expect(page.status).toBe(200);
      expect(page.items.length).toBeLessThanOrEqual(3);
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 50);
    expect(seen).toEqual(all.items.map((i) => i.id));
    expect(new Set(seen).size).toBe(seen.length);
    expect(pages).toBe(Math.ceil(all.items.length / 3));
  });
});
