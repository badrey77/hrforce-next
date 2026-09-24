import { cp, mkdtemp, rm, unlink, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_MIGRATIONS_DIR, loadMigrationFiles, runMigrations } from '../src/platform/db/migrator.js';
import { createTestDatabase, query, type TestDatabase } from './support/test-database.js';

describe('Migration runner (e2e)', () => {
  let db: TestDatabase;
  let dir: string;

  beforeAll(async () => {
    db = await createTestDatabase(); // already migrated once by the harness
    dir = await mkdtemp(path.join(tmpdir(), 'hrforce-migrations-'));
    await cp(DEFAULT_MIGRATIONS_DIR, dir, { recursive: true });
  });

  afterAll(async () => {
    await db?.drop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('records every migration with its sha256 checksum', async () => {
    const files = await loadMigrationFiles(DEFAULT_MIGRATIONS_DIR);
    const rows = await query<{ version: number; name: string; checksum: string }>(
      db.superuserUrl,
      'select version, name, checksum from schema_migrations order by version',
    );
    expect(rows).toEqual(files.map((f) => ({ version: f.version, name: f.name, checksum: f.checksum })));
    expect(rows[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is idempotent', async () => {
    const result = await runMigrations({ connectionString: db.migratorUrl, migrationsDir: dir });
    expect(result).toEqual({ applied: [], alreadyApplied: (await loadMigrationFiles(dir)).length });
  });

  it('applies a new migration, each in its own transaction, and serialises concurrent runners', async () => {
    const files = await loadMigrationFiles(dir);
    const next = String(files.length + 1).padStart(4, '0');
    await writeFile(path.join(dir, `${next}_add_probe.sql`), 'create table probe (id int primary key);\n');
    const results = await Promise.all([
      runMigrations({ connectionString: db.migratorUrl, migrationsDir: dir }),
      runMigrations({ connectionString: db.migratorUrl, migrationsDir: dir }),
    ]);
    expect(results.flatMap((r) => r.applied)).toEqual([`${next}_add_probe.sql`]);
  });

  it('rolls back a failing migration and does not record it', async () => {
    const files = await loadMigrationFiles(dir);
    const next = String(files.length + 1).padStart(4, '0');
    const file = path.join(dir, `${next}_broken.sql`);
    await writeFile(file, 'create table half_done (id int);\nselect * from no_such_table;\n');
    await expect(runMigrations({ connectionString: db.migratorUrl, migrationsDir: dir })).rejects.toThrow(
      /_broken\.sql failed/,
    );
    expect(await query(db.superuserUrl, `select 1 from pg_tables where tablename = 'half_done'`)).toHaveLength(0);
    await unlink(file);
  });

  it('detects tampering with an applied migration (checksum mismatch)', async () => {
    await appendFile(path.join(dir, '0002_company.sql'), '\n-- sneaky edit\n');
    await expect(runMigrations({ connectionString: db.migratorUrl, migrationsDir: dir })).rejects.toThrow(
      /Checksum mismatch for applied migration 0002_company\.sql/,
    );
  });

  it('rejects gaps and malformed file names', async () => {
    const gapDir = await mkdtemp(path.join(tmpdir(), 'hrforce-gap-'));
    try {
      await writeFile(path.join(gapDir, '0001_a.sql'), 'select 1;');
      await writeFile(path.join(gapDir, '0003_c.sql'), 'select 1;');
      await expect(loadMigrationFiles(gapDir)).rejects.toThrow(/contiguous.*expected 0002/);
      await writeFile(path.join(gapDir, '0002_Bad-Name.sql'), 'select 1;');
      await expect(loadMigrationFiles(gapDir)).rejects.toThrow(/Invalid migration file name/);
    } finally {
      await rm(gapDir, { recursive: true, force: true });
    }
  });

  it('fails when an applied migration is missing on disk', async () => {
    const shortDir = await mkdtemp(path.join(tmpdir(), 'hrforce-short-'));
    try {
      await cp(path.join(DEFAULT_MIGRATIONS_DIR, '0001_roles_and_privileges.sql'), path.join(shortDir, '0001_roles_and_privileges.sql'));
      await expect(runMigrations({ connectionString: db.migratorUrl, migrationsDir: shortDir })).rejects.toThrow(
        /missing from the migrations directory/,
      );
    } finally {
      await rm(shortDir, { recursive: true, force: true });
    }
  });
});
