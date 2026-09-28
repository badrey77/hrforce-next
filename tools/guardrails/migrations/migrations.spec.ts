import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATION_FILE_PATTERN as MIGRATOR_PATTERN } from '../../../apps/api/src/platform/db/migrator.ts';
import { packageBin } from '../lib/node-bin.ts';
import { REPO_ROOT } from '../lib/report.ts';
import { checkImmutability, checkMigrationNames, checkMigrations, findSqlRaw, MIGRATION_FILE_PATTERN, resolveBase } from './migrations.ts';

const temps: string[] = [];
function tempRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'guard-migrations-'));
  temps.push(dir);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), content);
  }
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=guard@test', '-c', 'user.name=guard', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' });
const M = 'apps/api/migrations';

describe('migrations: naming and contiguity', () => {
  it('uses the same file pattern as the API migrator', () => {
    expect(MIGRATION_FILE_PATTERN.source).toBe(MIGRATOR_PATTERN.source);
  });

  it('accepts contiguous NNNN_description.sql files', () => {
    const root = tempRepo({ [`${M}/0001_a.sql`]: '', [`${M}/0002_b_c.sql`]: '' });
    expect(checkMigrationNames(root)).toEqual([]);
  });

  it('flags bad names, gaps and duplicates', () => {
    const root = tempRepo({
      [`${M}/0001_init.sql`]: '',
      [`${M}/0001_again.sql`]: '',
      [`${M}/0003_gap.sql`]: '',
      [`${M}/4_short.sql`]: '',
      [`${M}/0005_CamelCase.sql`]: '',
      [`${M}/notes.txt`]: '',
    });
    const found = checkMigrationNames(root).map((v) => `${v.file} ${v.rule} ${v.message}`);
    expect(found).toEqual([
      expect.stringMatching(/0005_CamelCase\.sql migrations\/naming/),
      expect.stringMatching(/4_short\.sql migrations\/naming/),
      expect.stringMatching(/notes\.txt migrations\/naming/),
      expect.stringMatching(/0001_init\.sql migrations\/contiguous duplicate migration version 0001 \(also 0001_again\.sql\)/),
      expect.stringMatching(/0003_gap\.sql migrations\/contiguous versions must be contiguous from 0001: expected 0002/),
    ]);
  });
});

function committedRepo(): string {
  const root = tempRepo({ [`${M}/0001_init.sql`]: 'create table a ();\n', [`${M}/0002_more.sql`]: 'create table b ();\n' });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  return root;
}

describe('migrations: committed files are immutable', () => {
  it('allows adding a new migration', () => {
    const root = committedRepo();
    writeFileSync(path.join(root, M, '0003_new.sql'), 'create table c ();\n');
    git(root, 'add', '.');
    expect(checkImmutability(root, 'HEAD')).toEqual([]);
  });

  it('flags modified (unstaged or committed) and deleted migrations', () => {
    const root = committedRepo();
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    writeFileSync(path.join(root, M, '0001_init.sql'), 'create table a (id int);\n');
    expect(checkImmutability(root, 'HEAD').map((v) => v.message)).toEqual([expect.stringMatching(/modified/)]);

    git(root, 'commit', '-q', '-am', 'edit applied migration');
    unlinkSync(path.join(root, M, '0002_more.sql'));
    const violations = checkImmutability(root, base);
    expect(violations.map((v) => `${v.file} ${v.message}`)).toEqual([
      expect.stringMatching(/0001_init\.sql already-committed migration modified/),
      expect.stringMatching(/0002_more\.sql already-committed migration deleted/),
    ]);
    // the override is how CI passes the pushed-before commit
    expect(resolveBase(root, { GUARD_MIGRATIONS_BASE: base })?.base).toBe(base);
    expect(resolveBase(root, { GUARD_MIGRATIONS_BASE: '0000000000000000000000000000000000000000' })?.base).toBe('HEAD');
  });

  it('is skipped with a warning outside a git work tree', () => {
    const root = tempRepo({ [`${M}/0001_init.sql`]: '' });
    const result = checkMigrations(root, {});
    expect(result.violations).toEqual([expect.objectContaining({ severity: 'warning', rule: 'migrations/immutable' })]);
  });
});

describe('migrations: sql.raw is banned', () => {
  it('finds sql.raw, aliased imports, computed access and destructuring', () => {
    const src = [
      "import { sql, sql as k } from 'kysely';",
      "const a = sql.raw('select 1');",
      "const b = k.raw(input);",
      "const c = sql['raw']('x');",
      'const { raw } = sql;',
      "const ok1 = sql`select ${a}`;",
      'const ok2 = String.raw`x`;',
      "const ok3 = sql.ref('col');",
    ].join('\n');
    expect(findSqlRaw('x.ts', src).map((v) => v.line)).toEqual([2, 3, 4, 5]);
  });

  it('is also enforced by oxlint (hrforce/no-sql-raw JS plugin)', () => {
    const dir = tempRepo({ 'bad.ts': "import { sql } from 'kysely';\nexport const q = sql.raw('drop table x');\n" });
    const { command, args } = packageBin('oxlint', ['-c', path.join(REPO_ROOT, '.oxlintrc.json'), path.join(dir, 'bad.ts')]);
    const result = spawnSync(command, args, { cwd: REPO_ROOT, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/no-sql-raw/);
  });
});
