import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../lib/report.ts';
import { MIGRATIONS_DIR } from '../migrations/migrations.ts';
import {
  type AuditExemptEntry,
  decodeTriggerType,
  evaluateAudited,
  evaluateCompanyId,
  type ExemptEntry,
  loadAuditExempt,
  loadCatalog,
  loadExempt,
  parseMigrationTables,
  type TableInfo,
} from './catalog.ts';
import { codegen } from './db-guard.ts';
import { createThrowawayDb, superuserUrlFromEnv, type ThrowawayDb, withClient } from './throwaway-db.ts';

const FIXTURE_ROOT = import.meta.dirname;
const FIXTURE_DIR = '__fixtures__/migrations';
const FIXTURE_EXEMPT: ExemptEntry[] = [
  { table: 'company', reason: 'tenant table', rls: true },
  { table: 'ghost', reason: 'stale on purpose' },
];
const FIXTURE_AUDIT_EXEMPT: AuditExemptEntry[] = [
  { table: 'derived', reason: 'derived data' },
  { table: 'ghost', reason: 'stale on purpose' },
  { table: 'no_company', reason: 'not a tenant table: stale' },
];

const tenant = (name: string, overrides: Partial<TableInfo> = {}): TableInfo => ({
  name,
  companyIdType: 'uuid',
  companyIdNotNull: true,
  rowSecurity: true,
  forceRowSecurity: true,
  policies: [{ name: `${name}_isolation`, using: "(company_id = (current_setting('app.company_id'::text, true))::uuid)", withCheck: null }],
  triggers: [],
  ...overrides,
});

describe('company-id / audit: pure evaluation', () => {
  it('parses CREATE TABLE lines from migrations', () => {
    const tables = parseMigrationTables(FIXTURE_ROOT, FIXTURE_DIR);
    expect(tables.map((t) => `${t.table} ${path.basename(t.file)}:${t.line}`)).toEqual([
      'company 0001_tenancy.sql:2',
      'good_tenant 0001_tenancy.sql:8',
      'no_company 0001_tenancy.sql:17',
      'nullable_company 0002_violations.sql:2',
      'text_company 0002_violations.sql:4',
      'not_forced 0002_violations.sql:9',
      'wrong_policy 0002_violations.sql:13',
      'audited_ok 0003_audit.sql:8',
      'audited_missing 0003_audit.sql:18',
      'audited_partial 0003_audit.sql:26',
      'derived 0003_audit.sql:34',
    ]);
  });

  it('accepts compliant tables and RLS-only exemptions', () => {
    const catalog = [tenant('employee'), tenant('company', { companyIdType: null, policies: [{ name: 'p', using: "(id = (current_setting('app.company_id'::text, true))::uuid)", withCheck: null }] })];
    expect(evaluateCompanyId(catalog, [{ table: 'company', reason: 'tenant', rls: true }])).toEqual([]);
  });

  it('flags each missing ingredient and stale exemptions', () => {
    const catalog = [
      tenant('a', { companyIdType: null }),
      tenant('b', { companyIdNotNull: false }),
      tenant('c', { companyIdType: 'text' }),
      tenant('d', { rowSecurity: false, forceRowSecurity: false, policies: [] }),
      tenant('e', { policies: [{ name: 'all', using: 'true', withCheck: null }] }),
      tenant('lookup', { companyIdType: null, rowSecurity: false, forceRowSecurity: false, policies: [] }),
    ];
    const messages = evaluateCompanyId(catalog, [{ table: 'lookup', reason: 'global catalogue' }, { table: 'gone', reason: 'x' }]).map((v) => v.message);
    expect(messages).toEqual([
      expect.stringMatching(/stale entry: table "gone"/),
      expect.stringMatching(/table a has no company_id column/),
      expect.stringMatching(/b\.company_id must be NOT NULL/),
      expect.stringMatching(/c\.company_id must be uuid \(is text\)/),
      expect.stringMatching(/table d: row level security is not enabled/),
      expect.stringMatching(/table d: row level security is not forced/),
      expect.stringMatching(/table d has no RLS policy/),
      expect.stringMatching(/table e: no policy references current_setting\('app\.company_id'\)/),
    ]);
  });

  it('schema-qualified exemptions document tables of other schemas: they must exist, nothing else is checked', () => {
    const catalog = [tenant('company', { companyIdType: null })];
    const exempt = [
      { table: 'company', reason: 'tenant', rls: true },
      { table: 'auth.user_account', reason: 'global identity' },
      { table: 'auth.gone', reason: 'x' },
    ];
    expect(evaluateCompanyId(catalog, exempt, [], 'exempt.json', ['auth.user_account']).map((v) => v.message)).toEqual([
      expect.stringMatching(/stale entry: table "auth\.gone"/),
    ]);
  });

  it('audit-per-write: every tenant table (company_id, plus company) needs an AFTER I/U/D row trigger named audit%', () => {
    const auditTg = { name: 'audit_capture_tg', function: 'capture', functionSchema: 'audit', ...decodeTriggerType(1 | 4 | 8 | 16) };
    const catalog = [
      tenant('ok', { triggers: [auditTg] }),
      tenant('company', { companyIdType: null, triggers: [] }),
      tenant('missing', { triggers: [{ name: 'touch', function: 'set_updated_at' }] }),
      tenant('statement', { triggers: [{ ...auditTg, ...decodeTriggerType(4 | 8 | 16) }] }),
      tenant('before', { triggers: [{ ...auditTg, ...decodeTriggerType(1 | 2 | 4 | 8 | 16) }] }),
      tenant('no_delete', { triggers: [{ ...auditTg, ...decodeTriggerType(1 | 4 | 16) }] }),
      tenant('derived'),
      tenant('lookup', { companyIdType: null }),
    ];
    const exempt = [
      { table: 'derived', reason: 'rebuilt' },
      { table: 'lookup', reason: 'not a tenant table' },
      { table: 'gone', reason: 'x' },
    ];
    expect(evaluateAudited(catalog, exempt, [{ table: 'missing', file: 'm.sql', line: 3 }], 'audit.json').map((v) => `${v.file}${v.line ? `:${v.line}` : ''} ${v.message}`)).toEqual([
      expect.stringMatching(/^audit\.json stale entry: table "lookup" is not a tenant table/),
      expect.stringMatching(/^audit\.json stale entry: table "gone" does not exist/),
      expect.stringMatching(/^\(database\) public\.company table company has no audit trigger/),
      expect.stringMatching(/^m\.sql:3 table missing has no audit trigger/),
      expect.stringMatching(/^\(database\) public\.statement table statement: trigger audit_capture_tg must be AFTER INSERT OR UPDATE OR DELETE … FOR EACH ROW/),
      expect.stringMatching(/table before: trigger audit_capture_tg must be AFTER/),
      expect.stringMatching(/table no_delete: trigger audit_capture_tg must be AFTER/),
    ]);
    expect(evaluateAudited([tenant('ok', { triggers: [auditTg] })], [])).toEqual([]);
  });

  it('decodes pg_trigger.tgtype', () => {
    expect(decodeTriggerType(29)).toEqual({ row: true, timing: 'after', events: ['insert', 'update', 'delete'] });
    expect(decodeTriggerType(19)).toEqual({ row: true, timing: 'before', events: ['update'] });
    expect(decodeTriggerType(32)).toEqual({ row: false, timing: 'after', events: ['truncate'] });
  });

  it('validates the audit exempt file shape', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'guard-audit-exempt-'));
    try {
      writeFileSync(path.join(root, 'audit.json'), JSON.stringify([{ table: 'a', reason: 'ok' }, { table: 'a', reason: 'dup' }, { table: 'b', reason: ' ' }]));
      const { entries, violations } = loadAuditExempt(root, 'audit.json');
      expect(entries.map((e) => e.table)).toEqual(['a', 'a']);
      expect(violations.map((v) => v.message)).toEqual([expect.stringMatching(/duplicate entry for "a"/), expect.stringMatching(/entry 2 must be/)]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('validates the exempt file shape', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'guard-exempt-'));
    try {
      const file = path.join(root, 'exempt.json');
      writeFileSync(file, JSON.stringify([{ table: 'a', reason: 'ok' }, { table: 'a', reason: 'dup' }, { table: 'b' }, { table: 'c', reason: 'x', rls: 'yes' }]));
      const { entries, violations } = loadExempt(root, 'exempt.json');
      expect(entries.map((e) => e.table)).toEqual(['a', 'a']);
      expect(violations.map((v) => v.message)).toEqual([
        expect.stringMatching(/duplicate entry for "a"/),
        expect.stringMatching(/entry 2 must be/),
        expect.stringMatching(/entry 3 must be/),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the repo's exempt lists are well-formed and name tables the migrations create", () => {
    const { entries, violations } = loadExempt(REPO_ROOT);
    expect(violations).toEqual([]);
    const created = new Set(['schema_migrations', ...parseMigrationTables(REPO_ROOT, MIGRATIONS_DIR).map((t) => t.table)]);
    for (const e of entries) expect(created, e.table).toContain(e.table);
    const audit = loadAuditExempt(REPO_ROOT);
    expect(audit.violations).toEqual([]);
    expect(audit.entries.map((e) => e.table)).toEqual(['org_unit_closure', 'notification', 'document_sequence', 'issued_document_file', 'employee_file_content', 'attendance_device_heartbeat']);
    for (const e of audit.entries) expect(created, e.table).toContain(e.table);
  });
});

const superuserUrl = superuserUrlFromEnv();

describe.skipIf(!superuserUrl)('company-id / audit / schema-drift against Postgres (TEST_DATABASE_URL)', () => {
  let db: ThrowawayDb;
  const temp = mkdtempSync(path.join(tmpdir(), 'guard-drift-'));

  beforeAll(async () => {
    db = await createThrowawayDb(superuserUrl as string, 'hrforce_guard_spec');
    await withClient(db.migratorUrl, async (client) => {
      for (const file of readdirSync(path.join(FIXTURE_ROOT, FIXTURE_DIR)).toSorted()) {
        await client.query(readFileSync(path.join(FIXTURE_ROOT, FIXTURE_DIR, file), 'utf8'));
      }
    });
  });
  afterAll(async () => {
    await db?.drop();
    rmSync(temp, { recursive: true, force: true });
  });

  it('reads the catalog and reports every fixture violation', async () => {
    const catalog = await withClient(db.superuserUrl, (client) => loadCatalog(client));
    expect(catalog.map((t) => t.name)).toEqual([
      'audited_missing',
      'audited_ok',
      'audited_partial',
      'company',
      'derived',
      'good_tenant',
      'no_company',
      'not_forced',
      'nullable_company',
      'text_company',
      'wrong_policy',
    ]);
    const tables = parseMigrationTables(FIXTURE_ROOT, FIXTURE_DIR);
    const companyId = evaluateCompanyId(catalog, FIXTURE_EXEMPT, tables, 'exempt.json').map(
      (v) => `${path.basename(v.file)}${v.line ? `:${v.line}` : ''} ${v.message}`,
    );
    expect(companyId).toEqual([
      expect.stringMatching(/^exempt\.json stale entry: table "ghost"/),
      expect.stringMatching(/^0001_tenancy\.sql:17 table no_company has no company_id column/),
      expect.stringMatching(/^0001_tenancy\.sql:17 table no_company: row level security is not enabled/),
      expect.stringMatching(/^0001_tenancy\.sql:17 table no_company: row level security is not forced/),
      expect.stringMatching(/^0001_tenancy\.sql:17 table no_company has no RLS policy/),
      expect.stringMatching(/^0002_violations\.sql:9 table not_forced: row level security is not forced/),
      expect.stringMatching(/^0002_violations\.sql:2 nullable_company\.company_id must be NOT NULL/),
      expect.stringMatching(/^0002_violations\.sql:2 table nullable_company: row level security is not enabled/),
      expect.stringMatching(/^0002_violations\.sql:2 table nullable_company: row level security is not forced/),
      expect.stringMatching(/^0002_violations\.sql:2 table nullable_company has no RLS policy/),
      expect.stringMatching(/^0002_violations\.sql:4 text_company\.company_id must be uuid \(is text\)/),
      expect.stringMatching(/^0002_violations\.sql:13 table wrong_policy: no policy references/),
    ]);
    expect(catalog.find((t) => t.name === 'audited_ok')?.triggers).toEqual([
      { name: 'audit_capture_tg', function: 'audit_row_change', functionSchema: 'public', row: true, timing: 'after', events: ['insert', 'update', 'delete'] },
    ]);
    const audited = evaluateAudited(catalog, FIXTURE_AUDIT_EXEMPT, tables, 'audit.json').map(
      (v) => `${path.basename(v.file)}${v.line ? `:${v.line}` : ''} ${v.message}`,
    );
    expect(audited).toEqual([
      expect.stringMatching(/^audit\.json stale entry: table "ghost" does not exist/),
      expect.stringMatching(/^audit\.json stale entry: table "no_company" is not a tenant table/),
      expect.stringMatching(/^0003_audit\.sql:18 table audited_missing has no audit trigger/),
      expect.stringMatching(/^0003_audit\.sql:26 table audited_partial: trigger audit_partial_tg must be AFTER INSERT OR UPDATE OR DELETE/),
      expect.stringMatching(/^0001_tenancy\.sql:2 table company has no audit trigger/),
      expect.stringMatching(/^0001_tenancy\.sql:8 table good_tenant has no audit trigger/),
      expect.stringMatching(/^0002_violations\.sql:9 table not_forced has no audit trigger/),
      expect.stringMatching(/^0002_violations\.sql:2 table nullable_company has no audit trigger/),
      expect.stringMatching(/^0002_violations\.sql:4 table text_company has no audit trigger/),
      expect.stringMatching(/^0002_violations\.sql:13 table wrong_policy has no audit trigger/),
    ]);
  });

  it('schema-drift: codegen --verify passes on a fresh schema file and fails once the DB changes', async () => {
    const schemaFile = path.join(temp, 'schema.ts');
    expect(codegen(db.migratorUrl, { verify: false, outFile: schemaFile }).ok).toBe(true);
    expect(codegen(db.migratorUrl, { outFile: schemaFile })).toEqual({ ok: true, output: expect.any(String) });

    await withClient(db.migratorUrl, (client) => client.query('alter table public.good_tenant add column hired_on date'));
    const drift = codegen(db.migratorUrl, { outFile: schemaFile });
    expect(drift.ok).toBe(false);
  });
});
