import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

/**
 * Forward-only SQL migration runner.
 *
 * - Files: `NNNN_description.sql` (4 digits, contiguous from 0001, lowercase snake_case description).
 * - Tracked in `public.schema_migrations(version, name, checksum, applied_at)`; checksum = sha256 of the file.
 * - Serialised with a session-level advisory lock; each migration runs in its own transaction.
 * - Fails on: malformed file names, duplicate/missing versions (gaps), an applied migration missing on disk,
 *   or a changed checksum of an applied migration.
 */

export const MIGRATION_FILE_PATTERN = /^(\d{4})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;
/** Arbitrary constant key for pg_advisory_lock (unique to the HRForce migrator). */
const ADVISORY_LOCK_KEY = '7246870365';

export const DEFAULT_MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../migrations');

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

export interface MigrationFile {
  version: number;
  name: string;
  fileName: string;
  sql: string;
  checksum: string;
}

export interface MigrationLogger {
  info(obj: object, msg: string): void;
}

export interface RunMigrationsOptions {
  connectionString: string;
  migrationsDir?: string;
  logger?: MigrationLogger;
}

export interface RunMigrationsResult {
  applied: string[];
  alreadyApplied: number;
}

export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export async function loadMigrationFiles(dir: string): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((f) => f.endsWith('.sql')).toSorted();
  const files: MigrationFile[] = [];
  for (const fileName of entries) {
    const match = MIGRATION_FILE_PATTERN.exec(fileName);
    if (!match?.[1] || !match[2]) {
      throw new MigrationError(`Invalid migration file name "${fileName}" (expected NNNN_description.sql)`);
    }
    const sql = await readFile(path.join(dir, fileName), 'utf8');
    files.push({ version: Number(match[1]), name: match[2], fileName, sql, checksum: sha256(sql) });
  }
  files.forEach((file, index) => {
    if (file.version !== index + 1) {
      throw new MigrationError(
        `Migration versions must be contiguous from 0001: expected ${String(index + 1).padStart(4, '0')}, found ${file.fileName}`,
      );
    }
  });
  return files;
}

interface AppliedRow {
  version: number;
  name: string;
  checksum: string;
}

function verifyApplied(applied: AppliedRow[], files: MigrationFile[]): void {
  applied.forEach((row, index) => {
    if (row.version !== index + 1) {
      throw new MigrationError(`schema_migrations has a gap: expected version ${index + 1}, found ${row.version}`);
    }
    const file = files[index];
    if (!file) {
      throw new MigrationError(`Applied migration ${row.version} (${row.name}) is missing from the migrations directory`);
    }
    if (file.checksum !== row.checksum) {
      throw new MigrationError(
        `Checksum mismatch for applied migration ${file.fileName}: applied migrations must never be edited — add a new migration instead`,
      );
    }
  });
}

export async function runMigrations(options: RunMigrationsOptions): Promise<RunMigrationsResult> {
  const dir = options.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  const files = await loadMigrationFiles(dir);
  const client = new Client({ connectionString: options.connectionString, application_name: 'hrforce-migrator' });
  await client.connect();
  try {
    await client.query('select pg_advisory_lock($1::bigint)', [ADVISORY_LOCK_KEY]);
    try {
      await client.query(`
        create table if not exists public.schema_migrations (
          version integer primary key,
          name text not null,
          checksum text not null,
          applied_at timestamptz not null default now()
        )`);
      const { rows } = await client.query<AppliedRow>(
        'select version, name, checksum from public.schema_migrations order by version',
      );
      verifyApplied(rows, files);

      const applied: string[] = [];
      for (const file of files.slice(rows.length)) {
        await client.query('begin');
        try {
          await client.query(file.sql);
          await client.query('insert into public.schema_migrations (version, name, checksum) values ($1, $2, $3)', [
            file.version,
            file.name,
            file.checksum,
          ]);
          await client.query('commit');
        } catch (error) {
          await client.query('rollback');
          throw new MigrationError(`Migration ${file.fileName} failed: ${(error as Error).message}`);
        }
        applied.push(file.fileName);
        options.logger?.info({ migration: file.fileName }, 'migration applied');
      }
      return { applied, alreadyApplied: rows.length };
    } finally {
      await client.query('select pg_advisory_unlock($1::bigint)', [ADVISORY_LOCK_KEY]);
    }
  } finally {
    await client.end();
  }
}
