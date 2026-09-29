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
import type request from 'supertest';
import { base32Decode, DEMO_PASSWORD, hotp, inviteUser, MfaClock, totpStep } from '../src/modules/identity/index.js';
import { createDatabase } from '../src/platform/db/database.js';
import { DEMO_SIGNATORIES, demoPdf } from '../src/modules/documents/index.js';
import { as, COMPANY_A, EMPLOYEE_B, employeeA, GRANTS, seedAccessFixture, unitA, unitB, USERS, type AccessFixture, type ActorName } from './support/access-fixture.js';
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
/** The M1 tables exercised by the direct-SQL capture test (the leave tables are covered through the API writes). */
const M1_TABLES = [
  'assignment', 'company', 'employment', 'employment_salary', 'org_unit', 'org_unit_version', 'person', 'person_sensitive',
  'role', 'role_grant', 'role_permission', 'site',
];
const AUDITED_TABLES = [
  'assignment', 'company', 'company_profile', 'document_request', 'document_signatory', 'document_type', 'employee_file', 'employee_file_category',
  'employment', 'employment_salary',
  'issued_document', 'leave_ledger', 'leave_policy', 'leave_request', 'leave_type',
  'notification_preference', 'org_unit', 'org_unit_head', 'org_unit_version', 'person', 'person_sensitive', 'public_holiday',
  'role', 'role_grant', 'role_permission', 'security_policy', 'site', 'user_employment', 'workflow_definition', 'workflow_instance', 'workflow_task',
];
const C = '0190a5d0-0000-7000-8000-00000000c0de';

let db: TestDatabase;
let app: NestExpressApplication;
let fx: AccessFixture;
let xsrf: XsrfPair;
let seq = 0;
/** TOTP clock of the app (advanced one 30-second step per code: a step is never accepted twice). */
const mfaClock = { now: Date.now() };

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
  fx = await seedAccessFixture(db, undefined, { leave: true, documents: true });
  app = await createTestApp(db, { devAuth: true, devPermissions: false, overrides: [{ provide: MfaClock, useValue: { nowMs: () => mfaClock.now } }] });
  xsrf = await fetchXsrf(app);
});

afterAll(async () => {
  await app?.close();
  await db?.drop();
});

// ---------------------------------------------------------------------------------------------------------------
describe('schema: coverage, partitions, privileges', () => {
  it('audit.capture() is attached to every tenant table except org_unit_closure and notification', async () => {
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
    const person = '0190a5d0-0000-7000-8000-00000000c006';
    const employment = '0190a5d0-0000-7000-8000-00000000c007';
    const assignment = '0190a5d0-0000-7000-8000-00000000c008';
    const salary = '0190a5d0-0000-7000-8000-00000000c009';
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
      `insert into person (id, company_id, last_name, first_name) values ('${person}', '${C}', 'Test', 'Audit')`,
      `update person set first_name = 'Audité' where id = '${person}'`,
      `insert into person_sensitive (person_id, company_id, nss) values ('${person}', '${C}', '991234567890')`,
      `update person_sensitive set nss = '990000000000' where person_id = '${person}'`,
      `insert into employment (id, company_id, person_id, matricule, hire_date) values ('${employment}', '${C}', '${person}', 'AUD-1', '2026-01-01')`,
      `insert into assignment (id, company_id, employment_id, org_unit_id, job_title, valid) values ('${assignment}', '${C}', '${employment}', '${unit}', 'Agent', '[2026-01-01,)')`,
      `update assignment set job_title = 'Chef' where id = '${assignment}'`,
      `insert into employment_salary (id, company_id, employment_id, base_salary, valid) values ('${salary}', '${C}', '${employment}', 50000, '[2026-01-01,)')`,
      `update employment_salary set base_salary = 55000 where id = '${salary}'`,
      `update employment set end_date = '2026-12-31', end_reason = 'other' where id = '${employment}'`,
      `delete from employment_salary where id = '${salary}'`,
      `delete from assignment where id = '${assignment}'`,
      `delete from employment where id = '${employment}'`,
      `delete from person_sensitive where person_id = '${person}'`,
      `delete from person where id = '${person}'`,
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
    for (const table of M1_TABLES) {
      const ops = byTable(table).map((r) => r.op);
      expect(ops, table).toEqual(table === 'role_permission' || table === 'org_unit' ? ['insert', 'delete'] : ['insert', 'update', 'delete']);
    }
    const [insertSite, updateSite, deleteSite] = byTable('site');
    expect(insertSite).toMatchObject({ row_id: site, before: null, changed: ['id', 'company_id', 'code', 'name', 'wilaya', 'address', 'created_at', 'south_supplement_days'] });
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
    // person_sensitive is keyed on its person; masked columns hold "***"
    expect(byTable('person_sensitive').map((r) => r.row_id)).toEqual([person, person, person]);
    expect(byTable('person_sensitive')[1]).toMatchObject({ changed: ['nss'], before: { nss: '***' }, after: { nss: '***' } });
    expect(byTable('employment_salary')[1]).toMatchObject({ changed: ['base_salary'], before: { base_salary: '***' }, after: { base_salary: '***' } });
    expect(JSON.stringify(rows)).not.toMatch(/99123456|55000/);
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
  /** POST routes that write nothing (a read with a body). */
  const READ_ONLY_POSTS = ['POST /api/leave/preview', 'POST /api/documents/preview'];
  /**
   * Writes to an AUDIT-EXEMPT table only (tools/guardrails/audit-exempt.json): marking one's own notifications read
   * changes notification.read_at — per-user UI state of derived rows whose source events are audited. No audit row
   * is expected (asserted below).
   */
  const AUDIT_EXEMPT_WRITES = ['POST /api/me/notifications/:id/read', 'POST /api/me/notifications/read-all'];
  /**
   * Writes to the auth schema only (two-step sign-in, docs/contracts/mfa.md): no tenant row changes, so each one is
   * audited by an APPLICATION EVENT in the request transaction (asserted below). enroll/start only stores a pending,
   * unusable secret: its effect is audited when confirmed (auth.mfa_enrolled).
   */
  const MFA_EVENT_WRITES: Record<string, string> = {
    'POST /api/me/mfa/enroll/confirm': 'auth.mfa_enrolled',
    'POST /api/me/mfa/recovery-codes': 'auth.mfa_recovery_regenerated',
    'POST /api/me/mfa/disable': 'auth.mfa_disabled',
    'POST /api/access/users/:id/mfa/reset': 'auth.mfa_reset',
  };
  const PENDING_ONLY_WRITES = ['POST /api/me/mfa/enroll/start'];
  const LV = { annual: '', recovery: '', holiday: '', holidayToDelete: '', ownRequest: '', approveTask: '', rejectTask: '', titreType: '', toVoid: '', ownDocRequest: '', fileCategory: '', diploma: '', fileToDelete: '' };

  beforeAll(async () => {
    const types = await query<{ id: string; code: string }>(db.superuserUrl, 'select id, code from leave_type where company_id = $1', [COMPANY_A]);
    LV.annual = types.find((t) => t.code === 'annual')?.id ?? '';
    LV.recovery = types.find((t) => t.code === 'recovery')?.id ?? '';
    const holiday = async (date: string) => (await query<{ id: string }>(db.superuserUrl, 'select id from public_holiday where company_id = $1 and date = $2', [COMPANY_A, date]))[0]?.id ?? '';
    LV.holiday = await holiday('2027-01-12');
    LV.holidayToDelete = await holiday('2027-08-15');
    // rh.admin gets a linked employment (EMP-0002, Direction Générale) for the self-service writes
    await query(db.superuserUrl, 'insert into user_employment (company_id, user_id, employment_id) values ($1, $2, $3)', [COMPANY_A, USERS.admin.id, employeeA(2)]);
    const body = (start: string) => ({ leaveTypeId: LV.annual, startDate: start, endDate: start });
    LV.ownRequest = (await client('admin').post('/api/me/leave/requests').send(body('2027-03-01')).expect(201)).body.id;
    // two agent.annaba requests past their manager step: open HR tasks rh.admin may act on
    const hrTask = async (start: string) => {
      const id = (await client('agent').post('/api/me/leave/requests').send(body(start)).expect(201)).body.id as string;
      const manager = ((await client('chef').get('/api/tasks')).body.items as { id: string; subject: { id: string } }[]).find((t) => t.subject.id === id);
      await client('chef').post(`/api/tasks/${manager?.id}/approve`).send({}).expect(200);
      return ((await client('admin').get('/api/tasks')).body.items as { id: string; subject: { id: string } }[]).find((t) => t.subject.id === id)?.id ?? '';
    };
    LV.approveTask = await hrTask('2027-03-10');
    LV.rejectTask = await hrTask('2027-03-12');
    // documents: a type to edit, a document to void, rh.admin's own pending attestation request (cancelled below)
    LV.titreType = (await query<{ id: string }>(db.superuserUrl, `select id from document_type where company_id = $1 and code = 'titre_conge'`, [COMPANY_A]))[0]?.id ?? '';
    LV.toVoid = (await client('admin').post('/api/documents').send({ typeCode: 'attestation_travail', employmentId: employeeA(28), language: 'fr' }).expect(201)).body.id;
    LV.ownDocRequest = (await client('admin').post('/api/me/documents/requests').send({ typeCode: 'attestation_travail', language: 'fr' }).expect(201)).body.id;
    // employee file: a category to edit, the diploma category, a file to delete
    const category = async (code: string) => (await query<{ id: string }>(db.superuserUrl, 'select id from employee_file_category where company_id = $1 and code = $2', [COMPANY_A, code]))[0]?.id ?? '';
    LV.fileCategory = await category('other');
    LV.diploma = await category('diploma');
    LV.fileToDelete = (
      await client('admin').post(`/api/employees/${employeeA(27)}/files`).field('categoryId', LV.diploma).field('title', 'À supprimer')
        .attach('file', demoPdf('TEST DATA - audit delete'), 'delete.pdf').expect(201)
    ).body.id;
    expect(Object.values(LV).every((v) => v !== '')).toBe(true);
  });

  interface Write {
    request: () => { path: string; body: object; upload?: Buffer; fields?: Record<string, string> };
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
    'POST /api/employees': {
      request: () => ({
        path: '/api/employees',
        body: {
          lastName: 'Audit', firstName: 'Nouvel', matricule: 'AUD-NEW', hireDate: '2026-09-01', orgUnitId: unitA('AG-CNE'), jobTitle: 'Agent',
          salary: { baseSalary: '60000.00' }, bank: { rib: '00799999000000000555', bankName: 'CPA' }, nss: { nss: '990000000555' },
        },
      }),
      tables: ['person', 'person_sensitive', 'employment', 'assignment', 'employment_salary'],
    },
    'PATCH /api/employees/:id/person': { request: () => ({ path: `/api/employees/${employeeA(1)}/person`, body: { birthPlace: 'Médéa' } }), tables: ['person'] },
    'POST /api/employees/:id/assignments': {
      request: () => ({ path: `/api/employees/${employeeA(15)}/assignments`, body: { orgUnitId: unitA('AG-BLIDA'), jobTitle: 'Chef d’agence', validFrom: '2026-11-01' } }),
      tables: ['assignment'],
    },
    'POST /api/employees/:id/end': { request: () => ({ path: `/api/employees/${employeeA(3)}/end`, body: { endDate: '2026-12-31', reason: 'resignation' } }), tables: ['employment', 'assignment', 'employment_salary'] },
    'PUT /api/employees/:id/salary': { request: () => ({ path: `/api/employees/${employeeA(4)}/salary`, body: { baseSalary: '99000.00', validFrom: '2026-10-01' } }), tables: ['employment_salary'] },
    'PUT /api/employees/:id/bank': { request: () => ({ path: `/api/employees/${employeeA(5)}/bank`, body: { rib: '00799999000000000005', bankName: 'BEA' } }), tables: ['person_sensitive'] },
    'PUT /api/employees/:id/nss': { request: () => ({ path: `/api/employees/${employeeA(9)}/nss`, body: { nss: '990000000009' } }), tables: ['person_sensitive'] },
    'PUT /api/access/users/:id/employment': {
      request: () => ({ path: `/api/access/users/${USERS.newbie.id}/employment`, body: { employmentId: employeeA(31) } }),
      tables: ['user_employment'],
    },
    'PUT /api/org/units/:id/head': {
      request: () => ({ path: `/api/org/units/${unitA('AG-CNE')}/head`, body: { employmentId: employeeA(27), validFrom: '2027-03-01' } }),
      tables: ['org_unit_head'],
    },
    'PUT /api/leave/types/:id': { request: () => ({ path: `/api/leave/types/${LV.annual}`, body: { maxDaysPerRequest: 30 } }), tables: ['leave_type'] },
    'POST /api/leave/holidays': {
      request: () => ({ path: '/api/leave/holidays', body: { date: '2028-01-01', labels: { fr: 'Jour de l’an', ar: 'رأس السنة الميلادية', en: 'New Year' } } }),
      tables: ['public_holiday'],
    },
    'PUT /api/leave/holidays/:id': {
      request: () => ({ path: `/api/leave/holidays/${LV.holiday}`, body: { date: '2027-01-12', labels: { fr: 'Yennayer 2977', ar: 'يناير', en: 'Yennayer' }, approximate: false } }),
      tables: ['public_holiday'],
    },
    'DELETE /api/leave/holidays/:id': { request: () => ({ path: `/api/leave/holidays/${LV.holidayToDelete}`, body: {} }), tables: ['public_holiday'] },
    'PUT /api/leave/policy': { request: () => ({ path: '/api/leave/policy', body: { referenceStartMonth: 7, weekendDays: [5, 6], entitlementDelayMonths: 11 } }), tables: ['leave_policy'] },
    'POST /api/me/leave/requests': {
      request: () => ({ path: '/api/me/leave/requests', body: { leaveTypeId: LV.annual, startDate: '2027-02-01', endDate: '2027-02-02' } }),
      tables: ['leave_request', 'workflow_instance', 'workflow_task'],
    },
    'POST /api/me/leave/requests/:id/cancel': {
      request: () => ({ path: `/api/me/leave/requests/${LV.ownRequest}/cancel`, body: {} }),
      tables: ['leave_request', 'workflow_instance', 'workflow_task'],
    },
    'POST /api/employees/:id/leave/requests': {
      request: () => ({ path: `/api/employees/${employeeA(27)}/leave/requests`, body: { leaveTypeId: LV.annual, startDate: '2027-02-07', endDate: '2027-02-08' } }),
      tables: ['leave_request', 'workflow_instance', 'workflow_task'],
    },
    'POST /api/employees/:id/leave/adjustments': {
      request: () => ({ path: `/api/employees/${employeeA(27)}/leave/adjustments`, body: { leaveTypeId: LV.recovery, periodStart: '2026-07-01', days: 1.5, note: 'Récupération' } }),
      tables: ['leave_ledger'],
    },
    'POST /api/leave/accruals/run': { request: () => ({ path: '/api/leave/accruals/run', body: { month: '2025-06' } }), tables: ['leave_ledger'] },
    'POST /api/tasks/:id/approve': {
      request: () => ({ path: `/api/tasks/${LV.approveTask}/approve`, body: { comment: 'Validé' } }),
      tables: ['workflow_task', 'workflow_instance', 'leave_request', 'leave_ledger'],
    },
    'POST /api/tasks/:id/reject': {
      request: () => ({ path: `/api/tasks/${LV.rejectTask}/reject`, body: { comment: 'Refusé' } }),
      tables: ['workflow_task', 'workflow_instance', 'leave_request'],
    },
    'PUT /api/access/security-policy': {
      request: () => ({ path: '/api/access/security-policy', body: { mfaEnforced: false, mfaRequiredPermissions: ['access.grant', 'employee.salary.read'] } }),
      tables: ['security_policy'],
    },
    'PUT /api/documents/types/:id': { request: () => ({ path: `/api/documents/types/${LV.titreType}`, body: { languages: ['fr'] } }), tables: ['document_type'] },
    'PUT /api/documents/settings/profile': {
      request: () => ({ path: '/api/documents/settings/profile', body: { legalNameFr: 'Entreprise Démo HRForce SPA', addressFr: '12 rue Didouche Mourad, Alger', cityFr: 'Alger', nif: '000016999999999' } }),
      tables: ['company_profile'],
    },
    // a header-only JPEG (SOI, SOF0 1 × 1 grey, EOI): the upload reads the frame header, nothing renders it here
    'PUT /api/documents/settings/profile/logo': { request: () => ({ path: '/api/documents/settings/profile/logo', body: {}, upload: Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 1, 0, 1, 1, 1, 0x11, 0, 0xff, 0xd9]) }), tables: ['company_profile'] },
    'DELETE /api/documents/settings/profile/logo': { request: () => ({ path: '/api/documents/settings/profile/logo', body: {} }), tables: ['company_profile'] },
    'POST /api/documents/settings/signatories': {
      request: () => ({ path: '/api/documents/settings/signatories', body: { orgUnitId: unitA('REG-OUEST'), names: { fr: 'Nadir Ouest', ar: 'نذير' }, titles: { fr: 'Directeur', ar: 'مدير' } } }),
      tables: ['document_signatory'],
    },
    'PATCH /api/documents/settings/signatories/:id': {
      request: () => ({ path: `/api/documents/settings/signatories/${DEMO_SIGNATORIES.hrDirector}`, body: { titles: { fr: 'DRH', ar: 'مدير الموارد البشرية' } } }),
      tables: ['document_signatory'],
    },
    'POST /api/documents': {
      request: () => ({ path: '/api/documents', body: { typeCode: 'attestation_travail', employmentId: employeeA(27), language: 'fr' } }),
      tables: ['issued_document'],
    },
    'POST /api/documents/:id/void': { request: () => ({ path: `/api/documents/${LV.toVoid}/void`, body: { reason: 'Erreur de saisie' } }), tables: ['issued_document'] },
    'POST /api/me/documents/requests/:id/cancel': {
      request: () => ({ path: `/api/me/documents/requests/${LV.ownDocRequest}/cancel`, body: {} }),
      tables: ['document_request', 'workflow_instance', 'workflow_task'],
    },
    'POST /api/me/documents/requests': {
      request: () => ({ path: '/api/me/documents/requests', body: { typeCode: 'attestation_travail', language: 'ar' } }),
      tables: ['document_request', 'workflow_instance', 'workflow_task'],
    },
    'POST /api/employee-files/categories': {
      request: () => ({ path: '/api/employee-files/categories', body: { code: 'aud_training', labels: { fr: 'Formations', ar: 'التكوين', en: 'Training' }, retentionYearsAfterEnd: 10 } }),
      tables: ['employee_file_category'],
    },
    'PUT /api/employee-files/categories/:id': {
      request: () => ({ path: `/api/employee-files/categories/${LV.fileCategory}`, body: { retentionYearsAfterEnd: 30 } }),
      tables: ['employee_file_category'],
    },
    'POST /api/employees/:id/files': {
      request: () => ({
        path: `/api/employees/${employeeA(27)}/files`,
        body: {},
        upload: demoPdf('TEST DATA - audit upload'),
        fields: { categoryId: LV.diploma, title: 'Diplôme', documentDate: '2015-06-30' },
      }),
      tables: ['employee_file'],
    },
    'POST /api/employees/:id/files/:fileId/delete': {
      request: () => ({ path: `/api/employees/${employeeA(27)}/files/${LV.fileToDelete}/delete`, body: { reason: 'Pièce erronée' } }),
      tables: ['employee_file'],
    },
    'PUT /api/me/notification-preferences': {
      request: () => ({ path: '/api/me/notification-preferences', body: [{ type: 'task.assigned', email: false }, { type: 'leave.cancelled', email: true }] }),
      tables: ['notification_preference'],
    },
  };

  it('covers every write route of the route-scan outside /api/auth', () => {
    const result = spawnSync(process.execPath, ['tools/guardrails/route-scan/route-scan.ts', '--json'], { cwd: REPO_ROOT, encoding: 'utf8' });
    const routes = (JSON.parse(result.stdout) as { routes: { method: string; path: string }[] }).routes;
    const writes = routes
      .filter((r) => r.method !== 'GET' && !r.path.startsWith('/api/auth/'))
      .map((r) => `${r.method} ${r.path}`)
      .filter((key) => !READ_ONLY_POSTS.includes(key) && !AUDIT_EXEMPT_WRITES.includes(key) && !PENDING_ONLY_WRITES.includes(key));
    expect([...Object.keys(WRITES), ...Object.keys(MFA_EVENT_WRITES)].toSorted()).toEqual(writes.toSorted());
  });

  it('two-step sign-in writes (auth schema only) each record their application event in the request transaction', async () => {
    const admin = client('admin');
    const start = await admin.post('/api/me/mfa/enroll/start').send({}).expect(200);
    assertNoSecrets(start.body, ['$.secret']);
    const secret = base32Decode(start.body.secret as string) ?? Buffer.alloc(0);
    const code = () => {
      mfaClock.now += 30_000;
      return hotp(secret, totpStep(mfaClock.now));
    };
    const calls: [string, () => request.Test][] = [
      ['POST /api/me/mfa/enroll/confirm', () => admin.post('/api/me/mfa/enroll/confirm').send({ code: code() })],
      ['POST /api/me/mfa/recovery-codes', () => admin.post('/api/me/mfa/recovery-codes').send({ code: code() })],
      ['POST /api/me/mfa/disable', () => admin.post('/api/me/mfa/disable').send({ code: code() })],
      ['POST /api/access/users/:id/mfa/reset', () => admin.post(`/api/access/users/${USERS.target.id}/mfa/reset`).send({})],
    ];
    for (const [key, call] of calls) {
      const requestId = rid('mfa');
      const res = await call().set('X-Request-Id', requestId);
      expect(res.status, `${key}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
      const rows = await events('request_id = $1', [requestId]);
      expect(rows.map((r) => r.type), key).toEqual([MFA_EVENT_WRITES[key]]);
      expect(rows[0]).toMatchObject({ company_id: COMPANY_A, actor_user_id: USERS.admin.id, subject_type: 'user' });
      expect(JSON.stringify(rows[0]?.data)).not.toMatch(/secret|code"|[A-Z2-9]{5}-[A-Z2-9]{5}/);
    }
  });

  it('marking notifications read (audit-exempt table) writes no audit row but does change read_at', async () => {
    const [mine] = await query<{ id: string }>(db.superuserUrl, `select id from notification where user_id = $1 and read_at is null order by created_at limit 1`, [USERS.admin.id]);
    expect(mine, 'rh.admin has unread notifications (task.assigned of the HR tasks above)').toBeDefined();
    const one = rid('read');
    await client('admin').post(`/api/me/notifications/${mine?.id}/read`).set('X-Request-Id', one).send({}).expect(204);
    const all = rid('read-all');
    await client('admin').post('/api/me/notifications/read-all').set('X-Request-Id', all).send({}).expect(204);
    expect(await changes('request_id = any($1)', [[one, all]])).toEqual([]);
    expect(await query(db.superuserUrl, 'select 1 from notification where user_id = $1 and read_at is null', [USERS.admin.id])).toEqual([]);
  });

  it.each(Object.keys(WRITES))('%s', async (key) => {
    const spec = WRITES[key];
    if (!spec) throw new Error(key);
    const { path: url, body, upload, fields } = spec.request();
    const requestId = rid('write');
    const admin = client('admin');
    const call = key.startsWith('PATCH') ? admin.patch(url) : key.startsWith('PUT') ? admin.put(url) : key.startsWith('DELETE') ? admin.delete(url) : admin.post(url);
    let multipart = call.set('X-Request-Id', requestId);
    for (const [k, v] of Object.entries(fields ?? {})) multipart = multipart.field(k, v);
    const res = upload ? await multipart.attach('file', upload, fields ? 'piece.pdf' : 'logo.png') : await call.set('X-Request-Id', requestId).send(body);
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
      // (a masked column shows "***" on both sides: the change itself is recorded, not the values)
      for (const field of row.changed) {
        if (row.before?.[field] === '***' && row.after?.[field] === '***') continue;
        expect(row.before?.[field], field).not.toEqual(row.after?.[field]);
      }
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
    // each request's rows, newest first within it: the move (insert of the 2027-07 version + close of the 2027-01 one)
    // and the rename. Which request comes first is the `at` order checked above (database clock, which can step back a
    // few ms between two requests on Docker Desktop), not the order they were sent in.
    expect(byAdmin).toHaveLength(4);
    const rowsOf = (res: { headers: Record<string, unknown> }) =>
      byAdmin.filter((i) => i.requestId === String(res.headers['x-request-id'])).map((i) => ({ table: i.table, op: i.op, changes: i.changes }));
    const [moveInsert, moveClose] = rowsOf(move);
    const [renameInsert, renameClose] = rowsOf(rename);
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

    // newest first by the stored timestamp, then id. The three requests ran one after the other, but `at` comes from
    // the database clock, which can step back a few ms (Docker Desktop's VM time sync): expect the order of the rows
    // as stored rather than the order the requests were sent in.
    const est = await timeline('admin', `user:${USERS.est.id}`);
    const stored = await query<{ type: string }>(
      db.superuserUrl,
      `select type from audit.event where subject_id = $1 and type like 'auth.%' order by at desc, id desc`,
      [USERS.est.id],
    );
    expect(stored.map((e) => e.type).toSorted()).toEqual(['auth.login', 'auth.logout', 'auth.session_reuse']);
    expect(est.items.map((i) => i.event?.type).filter(Boolean)).toEqual(stored.map((e) => e.type));
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
    expect((await timeline('admin', `employee:${USERS.admin.id}`)).status).toBe(404); // not an employment id
    expect((await timeline('admin', `employee:${EMPLOYEE_B.employmentId}`)).status).toBe(404); // other company
    const badType = await timeline('admin', `payslip:${USERS.admin.id}`);
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

  it('employee: employment + assignments + salaries + person + person_sensitive rows; masked values; employee scope', async () => {
    const emp = employeeA(23); // EMP-0023, Service Administration Est (Région Est)
    const salary = await client('admin').put(`/api/employees/${emp}/salary`).send({ baseSalary: '123456.78', validFrom: '2026-10-15' });
    expect(salary.status, JSON.stringify(salary.body)).toBe(200);
    const bank = await client('admin').put(`/api/employees/${emp}/bank`).send({ rib: '00799999000000000777', bankName: 'BADR' });
    expect(bank.status).toBe(200);
    const person = await client('admin').patch(`/api/employees/${emp}/person`).send({ birthPlace: 'Guelma' });
    expect(person.status).toBe(200);

    const { status, items, body } = await timeline('admin', `employee:${emp}`, '&limit=100');
    expect(status).toBe(200);
    assertNoSecrets(body);
    expect(new Set(items.map((i) => i.table))).toEqual(new Set(['employment', 'assignment', 'employment_salary', 'person', 'person_sensitive']));
    const salaryInsert = items.find((i) => i.table === 'employment_salary' && i.op === 'insert' && i.actor?.id === USERS.admin.id);
    expect(salaryInsert?.changes).toEqual(expect.arrayContaining([{ field: 'base_salary', before: null, after: '***', masked: true }]));
    const bankUpdate = items.find((i) => i.table === 'person_sensitive' && i.actor?.id === USERS.admin.id);
    expect(bankUpdate?.changes).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'rib', after: '***', masked: true })]));
    expect(JSON.stringify(body)).not.toMatch(/123456|00799999000000000777|BADR/);
    expect(items.find((i) => i.table === 'person' && i.op === 'update')?.changes).toEqual([{ field: 'birth_place', before: expect.any(String), after: 'Guelma', masked: false }]);
    // scope: admin_acces holds audit.read on REG-EST only; rh_regional has no audit.read; other company → 404
    expect((await timeline('acces', `employee:${emp}`)).status).toBe(200);
    expect((await timeline('acces', `employee:${employeeA(35)}`)).status).toBe(404); // Agence Oran
    expect((await timeline('est', `employee:${emp}`)).status).toBe(403);
    expect((await timeline('beta', `employee:${emp}`)).status).toBe(404);
    expect((await timeline('beta', `employee:${EMPLOYEE_B.employmentId}`)).status).toBe(200);
  });

  it('leave_request: the request, its workflow instance and tasks, workflow.* events; visible like the request (no audit.read needed)', async () => {
    const types = await query<{ id: string }>(db.superuserUrl, `select id from leave_type where company_id = $1 and code = 'annual'`, [COMPANY_A]);
    const create = async (start: string) =>
      (await client('agent').post('/api/me/leave/requests').send({ leaveTypeId: types[0]?.id, startDate: start, endDate: start }).expect(201)).body.id as string;
    const id = await create('2027-05-03');
    // chef.annaba is the current candidate (manager step): 200 before acting
    expect((await timeline('chef', `leave_request:${id}`)).status).toBe(200);
    const task = ((await client('chef').get('/api/tasks')).body.items as { id: string; subject: { id: string } }[]).find((t) => t.subject.id === id);
    await client('chef').post(`/api/tasks/${task?.id}/approve`).send({}).expect(200);

    const own = await timeline('agent', `leave_request:${id}`, '&limit=100');
    expect(own.status).toBe(200);
    assertNoSecrets(own.body);
    expect(new Set(own.items.filter((i) => i.kind === 'change').map((i) => i.table))).toEqual(new Set(['leave_request', 'workflow_instance', 'workflow_task']));
    expect(own.items.filter((i) => i.kind === 'event').map((i) => i.event?.type).toSorted()).toEqual(['workflow.approve', 'workflow.start']);
    expect(own.items.every((i) => i.kind === 'event' || ['leave_request', 'workflow_instance', 'workflow_task'].includes(i.table ?? ''))).toBe(true);
    // scope: leave.read over the unit (rh.est, rh.admin) → 200; the manager after acting, lecture, admin_acces (audit.read
    // but no leave.read), the other company → 404; unknown / malformed id → 404
    expect((await timeline('est', `leave_request:${id}`)).status).toBe(200);
    expect((await timeline('admin', `leave_request:${id}`)).status).toBe(200);
    for (const actor of ['chef', 'ouest', 'acces', 'beta'] as const) expect((await timeline(actor, `leave_request:${id}`)).status, actor).toBe(404);
    expect((await timeline('agent', 'leave_request:0190a5d0-0000-7000-8000-00000000dead')).status).toBe(404);
    expect((await timeline('agent', 'leave_request:nope')).status).toBe(404);
    // every other subject type still needs audit.read (403 before any validation)
    expect((await timeline('agent', `org_unit:${unitA('AG-ANNABA')}`)).status).toBe(403);
    expect((await timeline('agent', 'employee:nope')).status).toBe(403);

    // the employee's History includes their leave requests and the workflow events about them (audit.read scope)
    const employee = await timeline('admin', `employee:${employeeA(30)}`, '&limit=100');
    expect(employee.status).toBe(200);
    expect(employee.items.some((i) => i.table === 'leave_request' && i.op === 'insert')).toBe(true);
    expect(employee.items.some((i) => i.event?.type === 'workflow.approve')).toBe(true);
    expect(employee.items.some((i) => i.table === 'workflow_task')).toBe(false);
    expect((await timeline('acces', `employee:${employeeA(30)}`)).status).toBe(200); // REG-EST
    expect((await timeline('est', `employee:${employeeA(30)}`)).status).toBe(403);
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
