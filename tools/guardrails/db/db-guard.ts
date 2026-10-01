/**
 * DB-backed guardrails, run against ONE freshly migrated throwaway database:
 *   company-id       every public table: company_id uuid not null + ENABLE/FORCE RLS + tenant policy (or exempt);
 *                    the auth schema (no app privileges at all) is listed in the exemption file for documentation
 *   audit-per-write  every tenant table of public (company_id, plus company) has an audit% trigger
 *                    (AFTER INSERT OR UPDATE OR DELETE FOR EACH ROW), unless in tools/guardrails/audit-exempt.json
 *   schema-drift     `npm run db:codegen:verify -w @hrforce/api` (src/platform/db/schema.ts is up to date)
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm run guard:db
 * (GUARD_DATABASE_URL takes precedence; the URL must be a superuser/CREATEROLE+CREATEDB account.)
 * Migrations run through the real CLI (`npm run migrate -w @hrforce/api`) as hrforce_migrator.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import type { Client } from 'pg';
import { type Command, npmCommand, packageBin } from '../lib/node-bin.ts';
import { type GuardResult, isMain, printResult, REPO_ROOT, type Violation } from '../lib/report.ts';
import { MIGRATIONS_DIR } from '../migrations/migrations.ts';
import { evaluateAudited, evaluateCompanyId, isTenantTable, loadAuditExempt, loadCatalog, loadExempt, parseMigrationTables } from './catalog.ts';
import { createThrowawayDb, superuserUrlFromEnv, withClient } from './throwaway-db.ts';

const API_DIR = path.join(REPO_ROOT, 'apps/api');

function run({ command, args, shell = false }: Command, env: NodeJS.ProcessEnv, cwd = REPO_ROOT): { ok: boolean; output: string } {
  const result = spawnSync(command, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', shell });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? String(result.error) : ''}`.trim() };
}

/**
 * Runs apps/api's kysely-codegen (its .kysely-codegenrc.json) against `url`: `verify` compares with the schema
 * file instead of writing it. `outFile` overrides src/platform/db/schema.ts (tests).
 */
export function codegen(url: string, { verify = true, outFile }: { verify?: boolean; outFile?: string } = {}): { ok: boolean; output: string } {
  const args = [...(verify ? ['--verify'] : []), ...(outFile ? ['--out-file', outFile] : [])];
  return run(packageBin('kysely-codegen', args), { MIGRATOR_DATABASE_URL: url }, API_DIR);
}

export function schemaDriftViolation(output: string): Violation {
  return {
    file: 'apps/api/src/platform/db/schema.ts',
    rule: 'schema-drift',
    message: `schema.ts is stale — run \`npm run migrate -w @hrforce/api && npm run db:codegen -w @hrforce/api\` and commit it.\n${output}`,
  };
}

/** Tables of schema audit that are not partitions (change_log, event, masked_column). */
async function loadAuditParents(client: Client): Promise<string[]> {
  const { rows } = await client.query<{ name: string }>(
    `select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'audit' and c.relkind in ('r', 'p') and not c.relispartition order by 1`,
  );
  return rows.map((r) => r.name);
}

export async function checkDb(superuserUrl: string, root: string = REPO_ROOT): Promise<GuardResult[]> {
  const db = await createThrowawayDb(superuserUrl);
  try {
    const migrate = run(npmCommand(['run', 'migrate', '-w', '@hrforce/api']), { MIGRATOR_DATABASE_URL: db.migratorUrl, LOG_LEVEL: 'warn' }, root);
    if (!migrate.ok) {
      return [{ name: 'db (migrate)', violations: [{ file: MIGRATIONS_DIR, rule: 'db/migrate', message: `migrations failed:\n${migrate.output}` }] }];
    }
    const catalog = await withClient(db.superuserUrl, (client) => loadCatalog(client));
    const authTables = (await withClient(db.superuserUrl, (client) => loadCatalog(client, 'auth'))).map((t) => `auth.${t.name}`);
    // schema oidc (docs/contracts/sso.md): global provider state, documented in the exemption file like auth
    const oidcTables = (await withClient(db.superuserUrl, (client) => loadCatalog(client, 'oidc'))).map((t) => `oidc.${t.name}`);
    // audit schema: only the partitioned parents and the masking list are documented (monthly partitions come and go)
    const auditTables = (await withClient(db.superuserUrl, (client) => loadAuditParents(client))).map((name) => `audit.${name}`);
    const tables = parseMigrationTables(root, MIGRATIONS_DIR);
    const exempt = loadExempt(root);
    const auditExempt = loadAuditExempt(root);
    const tenants = catalog.filter(isTenantTable);
    // same command as `npm run db:codegen:verify -w @hrforce/api`
    const drift = codegen(db.migratorUrl);
    return [
      {
        name: 'company-id',
        violations: [...exempt.violations, ...evaluateCompanyId(catalog, exempt.entries, tables, undefined, [...authTables, ...oidcTables, ...auditTables])],
        info: `company-id: ${catalog.length} tables in public (${exempt.entries.length} exempt)`,
      },
      {
        name: 'audit-per-write',
        violations: [...auditExempt.violations, ...evaluateAudited(catalog, auditExempt.entries, tables)],
        info: `audit-per-write: ${tenants.length} tenant tables in public (${auditExempt.entries.length} exempt)`,
      },
      { name: 'schema-drift', violations: drift.ok ? [] : [schemaDriftViolation(drift.output)] },
    ];
  } finally {
    await db.drop();
  }
}

if (isMain(import.meta.url)) {
  const url = superuserUrlFromEnv();
  if (!url) {
    process.stderr.write('guard:db needs TEST_DATABASE_URL (or GUARD_DATABASE_URL): a superuser URL to a Postgres cluster\n');
    process.exitCode = 2;
  } else {
    try {
      const results = await checkDb(url);
      const ok = results.map((r) => printResult(r)).every(Boolean);
      if (!ok) process.exitCode = 1;
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      process.exitCode = 2;
    }
  }
}
