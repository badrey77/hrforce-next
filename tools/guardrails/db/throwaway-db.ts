/**
 * Throwaway database on a Postgres cluster reachable with a superuser URL — same approach as the API's
 * test harness (apps/api/test/support/test-database.ts): create the two cluster roles if missing, create
 * `hrforce_guard_<random>` owned by hrforce_migrator, drop it afterwards.
 */
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';

export const ROLE_PASSWORDS = {
  hrforce_migrator: process.env['TEST_MIGRATOR_PASSWORD'] ?? 'hrforce_migrator_test',
  hrforce_app: process.env['TEST_APP_PASSWORD'] ?? 'hrforce_app_test',
} as const;

const PASSWORD_PATTERN = /^[A-Za-z0-9_.-]+$/;

export interface ThrowawayDb {
  name: string;
  superuserUrl: string;
  migratorUrl: string;
  drop(): Promise<void>;
}

export function superuserUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env['GUARD_DATABASE_URL'] || env['TEST_DATABASE_URL'] || undefined;
}

function withDatabase(base: string, database: string, user?: string, password?: string): string {
  const url = new URL(base);
  if (user !== undefined) url.username = user;
  if (password !== undefined) url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
}

export async function withClient<T>(url: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url, application_name: 'hrforce-guardrails' });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function ensureRoles(client: Client): Promise<void> {
  if (!Object.values(ROLE_PASSWORDS).every((p) => PASSWORD_PATTERN.test(p))) {
    throw new Error('TEST_*_PASSWORD may only contain [A-Za-z0-9_.-]');
  }
  for (let attempt = 0; ; attempt++) {
    try {
      await client.query(`
        do $$
        begin
          begin
            create role hrforce_migrator login bypassrls password '${ROLE_PASSWORDS.hrforce_migrator}';
          exception when duplicate_object or unique_violation then null;
          end;
          begin
            create role hrforce_app login nosuperuser nocreatedb nocreaterole nobypassrls password '${ROLE_PASSWORDS.hrforce_app}';
          exception when duplicate_object or unique_violation then null;
          end;
        end
        $$`);
      return;
    } catch (error) {
      if (attempt >= 3) throw error;
    }
  }
}

export async function createThrowawayDb(superuserUrl: string, prefix = 'hrforce_guard'): Promise<ThrowawayDb> {
  const name = `${prefix}_${randomBytes(6).toString('hex')}`;
  await withClient(superuserUrl, async (client) => {
    await ensureRoles(client);
    await client.query(`create database ${name} owner hrforce_migrator`);
  });
  return {
    name,
    superuserUrl: withDatabase(superuserUrl, name),
    migratorUrl: withDatabase(superuserUrl, name, 'hrforce_migrator', ROLE_PASSWORDS.hrforce_migrator),
    async drop() {
      await withClient(superuserUrl, (client) => client.query(`drop database if exists ${name} with (force)`));
    },
  };
}
