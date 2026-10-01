import { createHash } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { Adapter, AdapterConstructor, AdapterPayload } from 'oidc-provider';
import type { DB } from '../../../platform/db/schema.js';

/**
 * The provider's storage (docs/contracts/sso.md › Data, ADR 007 §5): every model but `Client` in oidc.model_store,
 * keyed by sha-256 of the id. The ids are bearer values (authorization codes, access tokens, session ids), so neither
 * the key nor the payload ever holds one:
 *  - every top-level payload field equal to the id (`jti`, and `uid` of an Interaction) is dropped and its NAME kept in
 *    `__idFields`, then restored on `find` (the caller presents the id, so it is known again);
 *  - an Interaction's `session.cookie` (the provider session's id, which the library copies there and never reads) is
 *    dropped.
 * `grantId` → grant_id (revokeByGrantId), `uid` → uid_hash (Session.findByUid), `expiresIn` → expires_at (the daily
 * oidc.cleanup job deletes the expired rows). `Client` comes from sso_client (active clients, see {@link ClientSource}).
 * Runs on the root pool: the provider state is global, not tenant data (no request context).
 */

export interface ClientSource {
  /** Client metadata of an ACTIVE client, undefined otherwise (unknown, disabled, unreadable secret). */
  find(clientId: string): Promise<AdapterPayload | undefined>;
}

const ID_FIELDS_KEY = '__idFields';

export function hashId(id: string): Buffer {
  return createHash('sha256').update(id, 'utf8').digest();
}

/** The payload as stored: without any top-level field equal to `id` (their names in `__idFields`). */
export function stripIds(model: string, id: string, payload: AdapterPayload): Record<string, unknown> {
  const stored: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (value === id) dropped.push(key);
    else stored[key] = value;
  }
  if (model === 'Interaction' && stored['session'] && typeof stored['session'] === 'object') {
    const { cookie: _cookie, ...session } = stored['session'] as Record<string, unknown>;
    stored['session'] = session;
  }
  stored[ID_FIELDS_KEY] = dropped;
  return stored;
}

/** The payload as the provider expects it: id fields restored, `consumed` (epoch seconds) from consumed_at. */
export function restoreIds(id: string | null, stored: Record<string, unknown>, consumedAt: Date | null): AdapterPayload {
  const payload: Record<string, unknown> = { ...stored };
  const fields = Array.isArray(stored[ID_FIELDS_KEY]) ? (stored[ID_FIELDS_KEY] as unknown[]) : [];
  delete payload[ID_FIELDS_KEY];
  if (id !== null) for (const field of fields) if (typeof field === 'string') payload[field] = id;
  if (consumedAt) payload['consumed'] = Math.floor(consumedAt.getTime() / 1000);
  return payload as AdapterPayload;
}

interface StoredRow {
  payload: Record<string, unknown>;
  consumed_at: Date | null;
}

/** The adapter class for `new Provider(…, { adapter })`, bound to the root pool and the client source. */
export function pgAdapterClass(db: Kysely<DB>, clients: ClientSource): AdapterConstructor {
  return class PgOidcAdapter implements Adapter {
    constructor(private readonly model: string) {}

    async upsert(id: string, payload: AdapterPayload, expiresIn?: number): Promise<void> {
      const stored = stripIds(this.model, id, payload);
      const grantId = typeof payload.grantId === 'string' ? payload.grantId : null;
      const uid = typeof payload.uid === 'string' ? hashId(payload.uid) : null;
      const expires = typeof expiresIn === 'number' && Number.isFinite(expiresIn) ? Math.max(0, Math.floor(expiresIn)) : null;
      await sql`
        insert into oidc.model_store (model, id_hash, payload, grant_id, uid_hash, expires_at)
        values (${this.model}, ${hashId(id)}, ${JSON.stringify(stored)}::jsonb, ${grantId}, ${uid},
                case when ${expires}::int is null then null else now() + make_interval(secs => ${expires}::int) end)
        on conflict (model, id_hash) do update
          set payload = excluded.payload, grant_id = excluded.grant_id, uid_hash = excluded.uid_hash, expires_at = excluded.expires_at`.execute(db);
    }

    async find(id: string): Promise<AdapterPayload | undefined> {
      if (this.model === 'Client') return clients.find(id);
      const { rows } = await sql<StoredRow>`
        select payload, consumed_at from oidc.model_store
         where model = ${this.model} and id_hash = ${hashId(id)} and (expires_at is null or expires_at > now())`.execute(db);
      const row = rows[0];
      return row ? restoreIds(id, row.payload, row.consumed_at) : undefined;
    }

    /** Session.findByUid: the session id is not known here (it was never stored); the provider only reads the rest. */
    async findByUid(uid: string): Promise<AdapterPayload | undefined> {
      const { rows } = await sql<StoredRow>`
        select payload, consumed_at from oidc.model_store
         where model = ${this.model} and uid_hash = ${hashId(uid)} and (expires_at is null or expires_at > now())`.execute(db);
      const row = rows[0];
      return row ? restoreIds(null, row.payload, row.consumed_at) : undefined;
    }

    /** No device flow. */
    findByUserCode(): Promise<undefined> {
      return Promise.resolve(undefined);
    }

    async consume(id: string): Promise<void> {
      await sql`update oidc.model_store set consumed_at = now() where model = ${this.model} and id_hash = ${hashId(id)}`.execute(db);
    }

    async destroy(id: string): Promise<void> {
      await sql`delete from oidc.model_store where model = ${this.model} and id_hash = ${hashId(id)}`.execute(db);
    }

    async revokeByGrantId(grantId: string): Promise<void> {
      await sql`delete from oidc.model_store where grant_id = ${grantId}`.execute(db);
    }
  };
}
