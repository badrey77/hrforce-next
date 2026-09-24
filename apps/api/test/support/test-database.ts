import { randomBytes } from 'node:crypto';
import { Client, type QueryResultRow } from 'pg';
import { runMigrations } from '../../src/platform/db/migrator.js';

/**
 * Throwaway, fully migrated database per test file.
 *  - TEST_DATABASE_URL (superuser URL) set → creates a fresh database on that cluster;
 *  - otherwise → starts postgres:18-alpine with Testcontainers.
 * Roles are cluster-wide: they are created if missing (tolerating concurrent creation by parallel files).
 */

/**
 * Passwords used when the harness creates the roles. Existing roles are never modified: if your cluster
 * already has them with other passwords, set TEST_MIGRATOR_PASSWORD / TEST_APP_PASSWORD accordingly.
 */
export const TEST_ROLE_PASSWORDS = {
  hrforce_migrator: process.env['TEST_MIGRATOR_PASSWORD'] ?? 'hrforce_migrator_test',
  hrforce_app: process.env['TEST_APP_PASSWORD'] ?? 'hrforce_app_test',
} as const;

const PASSWORD_PATTERN = /^[A-Za-z0-9_.-]+$/;

export interface TestDatabase {
  readonly name: string;
  /** Superuser (bypasses RLS) — for seeding and assertions. */
  readonly superuserUrl: string;
  /** hrforce_migrator — owns the schema. */
  readonly migratorUrl: string;
  /** hrforce_app — what the API uses; subject to RLS. */
  readonly appUrl: string;
  drop(): Promise<void>;
}

function withCredentials(base: string, user: string, password: string, database: string): string {
  const url = new URL(base);
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
}

async function withClient<T>(url: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const CREATE_ROLES_SQL = `
do $$
begin
  begin
    create role hrforce_migrator login bypassrls password '${TEST_ROLE_PASSWORDS.hrforce_migrator}';
  exception when duplicate_object or unique_violation then null;
  end;
  begin
    create role hrforce_app login nosuperuser nocreatedb nocreaterole nobypassrls password '${TEST_ROLE_PASSWORDS.hrforce_app}';
  exception when duplicate_object or unique_violation then null;
  end;
end
$$`;

async function ensureRoles(client: Client): Promise<void> {
  if (!Object.values(TEST_ROLE_PASSWORDS).every((p) => PASSWORD_PATTERN.test(p))) {
    throw new Error('TEST_*_PASSWORD may only contain [A-Za-z0-9_.-]');
  }
  // Concurrent test files may race here; retry once on a serialization-style failure.
  for (let attempt = 0; ; attempt++) {
    try {
      await client.query(CREATE_ROLES_SQL);
      return;
    } catch (error) {
      if (attempt >= 3) throw error;
    }
  }
}

async function createOn(superuserBase: string, cleanup: () => Promise<void>): Promise<TestDatabase> {
  const name = `hrforce_test_${randomBytes(6).toString('hex')}`;
  await withClient(superuserBase, async (client) => {
    await ensureRoles(client);
    await client.query(`create database ${name} owner hrforce_migrator`);
  });
  const db: TestDatabase = {
    name,
    superuserUrl: withCredentials(superuserBase, new URL(superuserBase).username, decodeURIComponent(new URL(superuserBase).password), name),
    migratorUrl: withCredentials(superuserBase, 'hrforce_migrator', TEST_ROLE_PASSWORDS.hrforce_migrator, name),
    appUrl: withCredentials(superuserBase, 'hrforce_app', TEST_ROLE_PASSWORDS.hrforce_app, name),
    async drop() {
      await withClient(superuserBase, async (client) => {
        await client.query(`drop database if exists ${name} with (force)`);
      });
      await cleanup();
    },
  };
  try {
    await runMigrations({ connectionString: db.migratorUrl });
  } catch (error) {
    await db.drop();
    if (error instanceof Error && /password authentication failed/.test(error.message)) {
      throw new Error(
        'Roles hrforce_migrator/hrforce_app already exist with other passwords: set TEST_MIGRATOR_PASSWORD and TEST_APP_PASSWORD',
        { cause: error },
      );
    }
    throw error;
  }
  return db;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const superuserUrl = process.env['TEST_DATABASE_URL'];
  if (superuserUrl) return createOn(superuserUrl, () => Promise.resolve());

  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
  const container = await new PostgreSqlContainer('postgres:18-alpine').start();
  return createOn(container.getConnectionUri(), async () => {
    await container.stop();
  });
}

/** Runs `fn` with a plain pg client (e.g. superuser for seeding). */
export function query<T extends QueryResultRow>(url: string, text: string, values: unknown[] = []): Promise<T[]> {
  return withClient(url, async (client) => (await client.query<T>(text, values)).rows);
}
