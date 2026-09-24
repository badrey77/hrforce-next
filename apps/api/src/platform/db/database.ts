import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { DB } from './schema.js';

/** The nil UUID. Used as the "no tenant" value for `app.company_id`; no company may have this id. */
export const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** DI token for the root Kysely instance (hrforce_app role). Repositories must use `currentTx()` instead. */
export const KYSELY = Symbol.for('hrforce.kysely');

export type Database = Kysely<DB>;

export interface CreateDatabaseOptions {
  connectionString: string;
  maxConnections?: number;
  applicationName?: string;
}

/**
 * Creates the application's Kysely instance over a pg Pool.
 *
 * Every session starts with `app.company_id` = nil UUID so that, once a transaction-local
 * `set_config` ends, the setting resets to the nil UUID (matching no tenant) instead of `''`
 * (which would make the RLS `::uuid` cast fail).
 */
export function createDatabase(options: CreateDatabaseOptions): Database {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
    application_name: options.applicationName ?? 'hrforce-api',
    options: `-c app.company_id=${NIL_UUID}`,
  });
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}
