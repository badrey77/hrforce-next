/**
 * DB-backed guardrails, run against ONE freshly migrated throwaway database:
 *   company-id       every public table: company_id uuid not null + ENABLE/FORCE RLS + tenant policy (or exempt);
 *                    the auth schema (no app privileges at all) is listed in the exemption file for documentation
 *   audit-per-write  `-- @audited` tables have an audit* trigger
 *   schema-drift     `npm run db:codegen:verify -w @hrforce/api` (src/platform/db/schema.ts is up to date)
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm run guard:db
 * (GUARD_DATABASE_URL takes precedence; the URL must be a superuser/CREATEROLE+CREATEDB account.)
 * Migrations run through the real CLI (`npm run migrate -w @hrforce/api`) as hrforce_migrator.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { type GuardResult, isMain, printResult, REPO_ROOT, type Violation } from '../lib/report.ts';
import { MIGRATIONS_DIR } from '../migrations/migrations.ts';
import { evaluateAudited, evaluateCompanyId, loadCatalog, loadExempt, parseMigrationTables } from './catalog.ts';
import { createThrowawayDb, superuserUrlFromEnv, withClient } from './throwaway-db.ts';

const API_DIR = path.join(REPO_ROOT, 'apps/api');

function run(command: string, args: string[], env: NodeJS.ProcessEnv, cwd = REPO_ROOT): { ok: boolean; output: string } {
  const result = spawnSync(command, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? String(result.error) : ''}`.trim() };
}

/**
 * Runs apps/api's kysely-codegen (its .kysely-codegenrc.json) against `url`: `verify` compares with the schema
 * file instead of writing it. `outFile` overrides src/platform/db/schema.ts (tests).
 */
export function codegen(url: string, { verify = true, outFile }: { verify?: boolean; outFile?: string } = {}): { ok: boolean; output: string } {
  const bin = path.join(REPO_ROOT, 'node_modules/.bin/kysely-codegen');
  const args = [...(verify ? ['--verify'] : []), ...(outFile ? ['--out-file', outFile] : [])];
  return run(bin, args, { MIGRATOR_DATABASE_URL: url }, API_DIR);
}

export function schemaDriftViolation(output: string): Violation {
  return {
    file: 'apps/api/src/platform/db/schema.ts',
    rule: 'schema-drift',
    message: `schema.ts is stale — run \`npm run migrate -w @hrforce/api && npm run db:codegen -w @hrforce/api\` and commit it.\n${output}`,
  };
}

export async function checkDb(superuserUrl: string, root: string = REPO_ROOT): Promise<GuardResult[]> {
  const db = await createThrowawayDb(superuserUrl);
  try {
    const migrate = run('npm', ['run', 'migrate', '-w', '@hrforce/api'], { MIGRATOR_DATABASE_URL: db.migratorUrl, LOG_LEVEL: 'warn' }, root);
    if (!migrate.ok) {
      return [{ name: 'db (migrate)', violations: [{ file: MIGRATIONS_DIR, rule: 'db/migrate', message: `migrations failed:\n${migrate.output}` }] }];
    }
    const catalog = await withClient(db.superuserUrl, (client) => loadCatalog(client));
    const authTables = (await withClient(db.superuserUrl, (client) => loadCatalog(client, 'auth'))).map((t) => `auth.${t.name}`);
    const tables = parseMigrationTables(root, MIGRATIONS_DIR);
    const exempt = loadExempt(root);
    // same command as `npm run db:codegen:verify -w @hrforce/api`
    const drift = codegen(db.migratorUrl);
    return [
      {
        name: 'company-id',
        violations: [...exempt.violations, ...evaluateCompanyId(catalog, exempt.entries, tables, undefined, authTables)],
        info: `company-id: ${catalog.length} tables in public (${exempt.entries.length} exempt)`,
      },
      {
        name: 'audit-per-write',
        violations: evaluateAudited(catalog, tables),
        info: `audit-per-write: ${tables.filter((t) => t.audited).length} table(s) marked -- @audited`,
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
