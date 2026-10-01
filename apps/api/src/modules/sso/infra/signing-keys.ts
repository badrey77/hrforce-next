import { generateKeyPairSync, randomBytes, type JsonWebKey } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../platform/db/schema.js';
import { open, seal } from './oidc-crypto.js';

/**
 * The provider's ID-token signing keys (docs/contracts/sso.md › Keys, ADR 007 §5): RSA 2048 / RS256, the private JWK
 * sealed with the `aead` subkey of OIDC_KEY (AAD = kid) in oidc.signing_key. Statuses:
 *   next     published in the JWKS, not signing yet (`stage`)
 *   current  the signing key (exactly one; the API creates the first one at boot)
 *   retired  still published so older ID tokens verify; dropped by `prune` after 7 days
 * The API loads them once at boot (the provider's keystore is fixed at construction): restart after each CLI step.
 */

export type KeyStatus = 'next' | 'current' | 'retired';

export interface SigningKeyRow {
  kid: string;
  status: KeyStatus;
  jwkEnc: Buffer;
  createdAt: Date;
  activatedAt: Date | null;
  retiredAt: Date | null;
}

/** A private RSA JWK as the provider takes it. */
export type PrivateJwk = JsonWebKey & { kid: string; alg: 'RS256'; use: 'sig'; kty: string };

export type LoadedKeys = { ok: true; keys: PrivateJwk[]; signingKid: string; skipped: string[] } | { ok: false; reason: string };

type Db = Kysely<DB>;

const STATUS_ORDER = sql`case k.status when 'current' then 0 when 'next' then 1 else 2 end`;
/** A key must be published this long before `promote` makes it sign (clients cache the JWKS). */
export const PROMOTE_AFTER_HOURS = 24;
/** A retired key stays published this long (the ID tokens it signed live 5 minutes; logout hints are older). */
export const PRUNE_AFTER_DAYS = 7;

function yyyymmdd(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

/** A new RS256 key pair: `kid = k-<yyyymmdd>-<8 hex>`. */
export function newSigningJwk(now = new Date()): PrivateJwk {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = privateKey.export({ format: 'jwk' });
  return { ...jwk, kty: jwk.kty ?? 'RSA', kid: `k-${yyyymmdd(now)}-${randomBytes(4).toString('hex')}`, alg: 'RS256', use: 'sig' };
}

export async function listKeys(db: Db): Promise<SigningKeyRow[]> {
  const { rows } = await sql<SigningKeyRow>`
    select k.kid, k.status, k.jwk_enc as "jwkEnc", k.created_at as "createdAt", k.activated_at as "activatedAt", k.retired_at as "retiredAt"
      from oidc.signing_key k
     order by ${STATUS_ORDER}, k.created_at desc`.execute(db);
  return rows;
}

function decrypt(aead: Buffer, row: SigningKeyRow): PrivateJwk | null {
  const json = open(aead, row.jwkEnc, row.kid);
  if (json === null) return null;
  try {
    const jwk = JSON.parse(json) as PrivateJwk;
    return jwk.kid === row.kid ? jwk : null;
  } catch {
    return null;
  }
}

/**
 * The keys to hand to the provider, current first (it signs with the first RS256 key). A current or next key that
 * cannot be decrypted (OIDC_KEY lost or changed) makes the provider unavailable; an unreadable retired key is only
 * skipped (after `oidc:keys reset`, the unreadable keys are retired).
 */
export async function loadSigningKeys(db: Db, aead: Buffer): Promise<LoadedKeys> {
  const rows = await listKeys(db);
  const keys: PrivateJwk[] = [];
  const skipped: string[] = [];
  for (const row of rows) {
    const jwk = decrypt(aead, row);
    if (jwk) keys.push(jwk);
    else if (row.status === 'retired') skipped.push(row.kid);
    else return { ok: false, reason: `the ${row.status} signing key ${row.kid} cannot be decrypted with OIDC_KEY` };
  }
  const current = rows.find((r) => r.status === 'current');
  if (!current) return { ok: false, reason: 'no current signing key' };
  return { ok: true, keys, signingKid: current.kid, skipped };
}

async function insertKey(db: Db, aead: Buffer, status: 'current' | 'next'): Promise<string> {
  const jwk = newSigningJwk();
  await sql`insert into oidc.signing_key (kid, alg, status, jwk_enc, activated_at)
            values (${jwk.kid}, 'RS256', ${status}, ${seal(aead, JSON.stringify(jwk), jwk.kid)},
                    ${status === 'current' ? sql`now()` : sql`null`})`.execute(db);
  return jwk.kid;
}

/**
 * First boot: creates the `current` key when none exists, under a transaction-scoped advisory lock (two API processes
 * booting on one database create exactly one key). Returns the new kid, or null when a current key already existed.
 */
export async function ensureCurrentKey(db: Db, aead: Buffer): Promise<string | null> {
  return db.transaction().execute(async (tx) => {
    await sql`select pg_advisory_xact_lock(hashtext('oidc.signing_key'))`.execute(tx);
    const { rows } = await sql<{ kid: string }>`select kid from oidc.signing_key where status = 'current'`.execute(tx);
    if (rows.length > 0) return null;
    return insertKey(tx, aead, 'current');
  });
}

// ── rotation CLI (runs as the migrator: `npm run oidc:keys -w @hrforce/api -- <command>`) ─────────────────────────

export class OidcKeysCommandError extends Error {}

/** `stage`: a new `next` key, published by the JWKS after the next restart, not signing yet. */
export async function stageKey(db: Db, aead: Buffer): Promise<string> {
  return db.transaction().execute(async (tx) => {
    await sql`select pg_advisory_xact_lock(hashtext('oidc.signing_key'))`.execute(tx);
    const { rows } = await sql<{ kid: string }>`select kid from oidc.signing_key where status = 'next'`.execute(tx);
    if (rows[0]) throw new OidcKeysCommandError(`a next key is already staged (${rows[0].kid}): promote it first`);
    return insertKey(tx, aead, 'next');
  });
}

/** `promote`: next → current, current → retired. Only once the next key was published ≥ 24 h, unless `now`. */
export async function promoteKey(db: Db, options: { now: boolean }): Promise<{ current: string; retired: string | null }> {
  return db.transaction().execute(async (tx) => {
    await sql`select pg_advisory_xact_lock(hashtext('oidc.signing_key'))`.execute(tx);
    const { rows } = await sql<{ kid: string; old: boolean }>`
      select kid, created_at < now() - make_interval(hours => ${PROMOTE_AFTER_HOURS}) as old
        from oidc.signing_key where status = 'next'`.execute(tx);
    const next = rows[0];
    if (!next) throw new OidcKeysCommandError('no next key: run `stage` first');
    if (!next.old && !options.now) {
      throw new OidcKeysCommandError(`the next key ${next.kid} was staged less than ${PROMOTE_AFTER_HOURS} h ago (clients cache the JWKS); use --now to force`);
    }
    const { rows: retired } = await sql<{ kid: string }>`
      update oidc.signing_key set status = 'retired', retired_at = now() where status = 'current' returning kid`.execute(tx);
    await sql`update oidc.signing_key set status = 'current', activated_at = now() where kid = ${next.kid}`.execute(tx);
    return { current: next.kid, retired: retired[0]?.kid ?? null };
  });
}

/** `prune`: deletes retired keys retired more than 7 days ago (`now`: every retired key). */
export async function pruneKeys(db: Db, options: { now: boolean }): Promise<string[]> {
  const { rows } = await sql<{ kid: string }>`
    delete from oidc.signing_key
     where status = 'retired' and (${options.now} or retired_at < now() - make_interval(days => ${PRUNE_AFTER_DAYS}))
    returning kid`.execute(db);
  return rows.map((r) => r.kid);
}

/**
 * `reset` (after a lost OIDC_KEY): retires every key the current OIDC_KEY cannot decrypt and creates a fresh current
 * key when none readable is left. The apps' secrets are unreadable too: rotate each one (Access → Applications).
 */
export async function resetKeys(db: Db, aead: Buffer): Promise<{ retired: string[]; created: string | null }> {
  return db.transaction().execute(async (tx) => {
    await sql`select pg_advisory_xact_lock(hashtext('oidc.signing_key'))`.execute(tx);
    const rows = await listKeys(tx);
    const unreadable = rows.filter((r) => r.status !== 'retired' && decrypt(aead, r) === null).map((r) => r.kid);
    if (unreadable.length > 0) {
      await sql`update oidc.signing_key set status = 'retired', retired_at = now() where kid in (${sql.join(unreadable)})`.execute(tx);
    }
    const { rows: current } = await sql<{ kid: string }>`select kid from oidc.signing_key where status = 'current'`.execute(tx);
    const created = current.length === 0 ? await insertKey(tx, aead, 'current') : null;
    return { retired: unreadable, created };
  });
}

/** `status`: one line per key (never key material). */
export async function keyStatus(db: Db, aead: Buffer): Promise<string[]> {
  const rows = await listKeys(db);
  if (rows.length === 0) return ['no signing key yet (the API creates the first one at boot)'];
  return rows.map((r) => {
    const readable = decrypt(aead, r) !== null ? 'readable' : 'UNREADABLE with this OIDC_KEY';
    const when = [`created ${r.createdAt.toISOString()}`, r.activatedAt ? `activated ${r.activatedAt.toISOString()}` : null, r.retiredAt ? `retired ${r.retiredAt.toISOString()}` : null]
      .filter(Boolean)
      .join(', ');
    return `${r.status.padEnd(8)} ${r.kid}  ${when}  (${readable})`;
  });
}

/** The CLI (scripts/oidc-keys.ts): returns the lines to print; throws OidcKeysCommandError on a refused command. */
export async function runOidcKeysCommand(db: Db, aead: Buffer, argv: readonly string[]): Promise<string[]> {
  const [command, ...flags] = argv;
  const now = flags.includes('--now');
  const restart = 'Restart the API now (docker compose restart api, or the next deploy): the provider loads its keys at boot.';
  switch (command) {
    case 'status':
      return keyStatus(db, aead);
    case 'stage':
      return [`staged next key ${await stageKey(db, aead)} (published, not signing).`, `Promote it after ${PROMOTE_AFTER_HOURS} h: oidc:keys promote.`, restart];
    case 'promote': {
      const result = await promoteKey(db, { now });
      return [`current key: ${result.current}${result.retired ? `; retired: ${result.retired} (still published)` : ''}.`, restart];
    }
    case 'prune': {
      const pruned = await pruneKeys(db, { now });
      return [pruned.length > 0 ? `pruned: ${pruned.join(', ')}.` : 'nothing to prune.', ...(pruned.length > 0 ? [restart] : [])];
    }
    case 'reset': {
      const result = await resetKeys(db, aead);
      return [
        result.retired.length > 0 ? `retired unreadable keys: ${result.retired.join(', ')}.` : 'every current/next key is readable.',
        result.created ? `created current key ${result.created}.` : 'a readable current key exists.',
        'Rotate the secret of every connected app (Access → Applications): their secrets were sealed with the old OIDC_KEY.',
        restart,
      ];
    }
    default:
      throw new OidcKeysCommandError('usage: oidc:keys <status | stage | promote [--now] | prune [--now] | reset>');
  }
}
