/**
 * Guardrail: migrations (CONVENTIONS.md › Database).
 *  1. apps/api/migrations holds only `NNNN_description.sql` files, contiguous from 0001.
 *  2. Migrations that exist on the base commit are never modified, renamed or deleted (forward-only).
 *     Base = $GUARD_MIGRATIONS_BASE, else `git merge-base HEAD origin/main`, else HEAD (local: uncommitted edits).
 *  3. `sql.raw` is banned anywhere in apps/api/src and apps/api/test (also an oxlint rule: hrforce/no-sql-raw).
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { type AstNode, importBindings, nameOf, parseTs, prop, propList, stringValue, walk } from '../lib/ast.ts';
import { listFiles } from '../lib/files.ts';
import { type GuardResult, isMain, REPO_ROOT, relativeTo, runCli, type Violation } from '../lib/report.ts';

/** Must stay identical to MIGRATION_FILE_PATTERN in apps/api/src/platform/db/migrator.ts (asserted by the spec). */
export const MIGRATION_FILE_PATTERN = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;
export const MIGRATIONS_DIR = 'apps/api/migrations';

const pad = (n: number): string => String(n).padStart(4, '0');

export function checkMigrationNames(root: string, dir = MIGRATIONS_DIR): Violation[] {
  const violations: Violation[] = [];
  let entries: string[];
  try {
    entries = readdirSync(path.join(root, dir)).toSorted();
  } catch {
    return [{ file: dir, rule: 'migrations/missing-dir', message: 'migrations directory not found' }];
  }
  const versions: { version: number; file: string }[] = [];
  for (const entry of entries) {
    const match = MIGRATION_FILE_PATTERN.exec(entry);
    if (!match) {
      violations.push({
        file: `${dir}/${entry}`,
        rule: 'migrations/naming',
        message: 'migration files must be named NNNN_description.sql (4 digits, lowercase snake_case)',
      });
      continue;
    }
    versions.push({ version: Number(match[1]), file: entry });
  }
  let expected = 1;
  versions.forEach(({ version, file }, index) => {
    const previous = versions[index - 1];
    if (previous?.version === version) {
      violations.push({ file: `${dir}/${file}`, rule: 'migrations/contiguous', message: `duplicate migration version ${pad(version)} (also ${previous.file})` });
      return;
    }
    if (version !== expected) {
      violations.push({ file: `${dir}/${file}`, rule: 'migrations/contiguous', message: `versions must be contiguous from 0001: expected ${pad(expected)}` });
    }
    expected = version + 1;
  });
  return violations;
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function gitOk(root: string, args: string[]): boolean {
  try {
    git(root, args);
    return true;
  } catch {
    return false;
  }
}

/** Commit whose migrations are considered "already committed" (see file header). */
export function resolveBase(root: string, env: NodeJS.ProcessEnv = process.env): { base: string; how: string } | undefined {
  if (!gitOk(root, ['rev-parse', '--is-inside-work-tree'])) return undefined;
  const override = env['GUARD_MIGRATIONS_BASE']?.trim();
  if (override && !/^0+$/.test(override) && gitOk(root, ['rev-parse', '--verify', '--quiet', `${override}^{commit}`])) {
    return { base: override, how: `$GUARD_MIGRATIONS_BASE (${override})` };
  }
  if (gitOk(root, ['rev-parse', '--verify', '--quiet', 'origin/main^{commit}'])) {
    try {
      return { base: git(root, ['merge-base', 'HEAD', 'origin/main']), how: 'merge-base HEAD origin/main' };
    } catch {
      // unrelated histories (shallow clone): fall through
    }
  }
  if (gitOk(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])) return { base: 'HEAD', how: 'HEAD' };
  return undefined;
}

/** Fails on modified / deleted / renamed migrations relative to `base` (working tree included). */
export function checkImmutability(root: string, base: string, dir = MIGRATIONS_DIR): Violation[] {
  const output = git(root, ['diff', '--no-renames', '--name-status', base, '--', dir]);
  const violations: Violation[] = [];
  for (const line of output.split('\n').filter(Boolean)) {
    const [status, file] = line.split('\t');
    if (!status || !file || status === 'A') continue;
    const what = status === 'D' ? 'deleted' : status === 'M' ? 'modified' : `changed (${status})`;
    violations.push({
      file,
      rule: 'migrations/immutable',
      message: `already-committed migration ${what} relative to ${base}: migrations are forward-only — add a new migration instead`,
    });
  }
  return violations;
}

/** Finds `sql.raw` / `sql['raw']` / `const { raw } = sql` for kysely's `sql` (any local alias). */
export function findSqlRaw(file: string, text: string): Violation[] {
  if (!text.includes('raw')) return [];
  const parsed = parseTs(file, text);
  const sqlNames = new Set(['sql']);
  for (const [local, binding] of importBindings(parsed.program)) {
    if (binding.source === 'kysely' && binding.imported === 'sql') sqlNames.add(local);
  }
  const isSql = (node: AstNode | undefined) => node?.type === 'Identifier' && sqlNames.has(node['name'] as string);
  const violations: Violation[] = [];
  const report = (node: AstNode) =>
    violations.push({
      file,
      ...parsed.lines.position(node.start),
      rule: 'migrations/no-sql-raw',
      message: '`sql.raw` is banned — use Kysely builders or the `sql` tagged template (sql.ref / sql.id / sql.lit for identifiers)',
    });
  walk(parsed.program, (node) => {
    if (node.type === 'MemberExpression' && isSql(prop(node, 'object'))) {
      const property = prop(node, 'property');
      const name = node['computed'] ? stringValue(property) : nameOf(property);
      if (name === 'raw') report(node);
    }
    if (node.type === 'VariableDeclarator' && isSql(prop(node, 'init')) && prop(node, 'id')?.type === 'ObjectPattern') {
      for (const p of propList(prop(node, 'id') as AstNode, 'properties')) {
        if (nameOf(prop(p, 'key')) === 'raw') report(p);
      }
    }
  });
  return violations;
}

export function checkNoSqlRaw(root: string, dirs = ['apps/api/src', 'apps/api/test']): Violation[] {
  return dirs.flatMap((dir) =>
    listFiles(path.join(root, dir), (f) => /\.(m?ts|m?js)$/.test(f) && !f.endsWith('.d.ts')).flatMap((file) =>
      findSqlRaw(relativeTo(root, file), readFileSync(file, 'utf8')),
    ),
  );
}

export function checkMigrations(root: string = REPO_ROOT, env: NodeJS.ProcessEnv = process.env): GuardResult {
  const violations = [...checkMigrationNames(root), ...checkNoSqlRaw(root)];
  const base = resolveBase(root, env);
  let info: string;
  if (base) {
    violations.push(...checkImmutability(root, base.base));
    info = `migrations: immutability checked against ${base.how}`;
  } else {
    info = 'migrations: not a git work tree — immutability check skipped';
    violations.push({ file: MIGRATIONS_DIR, rule: 'migrations/immutable', severity: 'warning', message: info });
  }
  return { name: 'migrations', violations, info };
}

if (isMain(import.meta.url)) await runCli(() => checkMigrations());
