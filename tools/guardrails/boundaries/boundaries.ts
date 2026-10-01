/**
 * Guardrail: boundaries — runs dependency-cruiser with the root .dependency-cruiser.cjs
 * (CONVENTIONS.md › Module layout and boundaries + web feature isolation).
 *   npm run guard:boundaries
 */
import path from 'node:path';
import { cruise, type ICruiseResult } from 'dependency-cruiser';
import extractDepcruiseOptions from 'dependency-cruiser/config-utl/extract-depcruise-options';
import { type GuardResult, isMain, REPO_ROOT, runCli, type Violation } from '../lib/report.ts';

export const CONFIG_FILE = path.join(REPO_ROOT, '.dependency-cruiser.cjs');
export const SOURCE_DIRS = ['apps/api/src', 'apps/web/src', 'apps/sso-demo/src'];

/**
 * @param baseDir directory whose layout mirrors the repo (the repo root, or a test fixture)
 * @param dirs    directories (relative to baseDir) to cruise; missing ones are skipped
 */
export async function checkBoundaries(baseDir: string = REPO_ROOT, dirs: string[] = SOURCE_DIRS): Promise<GuardResult> {
  const options = await extractDepcruiseOptions(CONFIG_FILE);
  const { existsSync } = await import('node:fs');
  const present = dirs.filter((d) => existsSync(path.join(baseDir, d)));
  const previousCwd = process.cwd();
  // dependency-cruiser resolves the cruise roots and rule paths relative to the working directory.
  process.chdir(baseDir);
  let output: ICruiseResult;
  try {
    const result = await cruise(present, { ...options, baseDir, validate: true, outputType: 'json' });
    output = (typeof result.output === 'string' ? JSON.parse(result.output) : result.output) as ICruiseResult;
  } finally {
    process.chdir(previousCwd);
  }
  const violations: Violation[] = output.summary.violations
    .filter((v) => v.rule.severity === 'error' || v.rule.severity === 'warn')
    .map((v) => ({
      file: v.from,
      rule: `boundaries/${v.rule.name}`,
      severity: v.rule.severity === 'warn' ? ('warning' as const) : ('error' as const),
      message: v.cycle?.length
        ? `circular dependency: ${[v.from, ...v.cycle.map((c) => (typeof c === 'string' ? c : c.name))].join(' → ')}`
        : `must not import ${v.to}${v.comment ? ` (${v.comment})` : ''}`,
    }));
  return {
    name: 'boundaries',
    violations,
    info: `boundaries: ${output.summary.totalCruised} modules, ${output.summary.totalDependenciesCruised ?? 0} dependencies cruised`,
  };
}

if (isMain(import.meta.url)) await runCli(() => checkBoundaries());
