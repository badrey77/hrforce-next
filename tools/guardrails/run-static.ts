/**
 * `npm run guard` — every static guardrail (no database needed). Runs all of them, then fails if any failed.
 * DB-backed guardrails: `npm run guard:db` (tools/guardrails/db/db-guard.ts).
 */
import { checkBoundaries } from './boundaries/boundaries.ts';
import { checkCssLogical } from './css/css-logical.ts';
import { checkI18n } from './i18n/i18n-parity.ts';
import { type GuardResult, printResult } from './lib/report.ts';
import { checkMigrations } from './migrations/migrations.ts';
import { scanRoutes } from './route-scan/route-scan.ts';
import { checkNoSecrets } from './secrets/no-secrets.ts';

const guards: [string, () => GuardResult | Promise<GuardResult>][] = [
  ['boundaries', () => checkBoundaries()],
  ['route-scan', () => scanRoutes()],
  ['migrations', () => checkMigrations()],
  ['no-secrets-in-payload', () => checkNoSecrets()],
  ['i18n-parity', () => checkI18n()],
  ['css-logical', () => checkCssLogical()],
];

const failed: string[] = [];
for (const [name, guard] of guards) {
  try {
    if (!printResult(await guard())) failed.push(name);
  } catch (error) {
    process.stderr.write(`✖ ${name}: crashed — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    failed.push(name);
  }
}
process.stdout.write(failed.length ? '' : `\nAll ${guards.length} static guardrails passed.\n`);
if (failed.length) {
  process.stderr.write(`\n${failed.length} guardrail(s) failed: ${failed.join(', ')}\n`);
  process.exitCode = 1;
}
