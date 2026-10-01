import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** The subkeys of OIDC_KEY (docs/contracts/sso.md › Keys, secrets, environment): HKDF-SHA256, empty salt. */
export interface OidcKeyMaterial {
  /** AES-256-GCM key of sso_client.secret_enc and oidc.signing_key.jwk_enc */
  aead: Buffer;
  /** the provider's cookie-signing key (`cookies.keys`, base64url) */
  cookies: string;
}

export function deriveOidcKeys(master: Buffer): OidcKeyMaterial {
  if (master.length !== 32) throw new Error('OIDC_KEY must decode to 32 bytes');
  const subkey = (info: string) => Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), info, 32));
  return { aead: subkey('hrforce/oidc/aead'), cookies: subkey('hrforce/oidc/cookies').toString('base64url') };
}

/** AES-256-GCM: nonce (12) ‖ ciphertext ‖ tag (16), `aad` binds the value to its row (client_id, kid). */
export function seal(key: Buffer, plaintext: string, aad: string): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}

/** The plaintext, or null when the value was not sealed with this key for this `aad` (tampered, other key, copied row). */
export function open(key: Buffer, value: Buffer, aad: string): string | null {
  if (value.length <= NONCE_BYTES + TAG_BYTES) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, NONCE_BYTES));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(value.subarray(value.length - TAG_BYTES));
    return Buffer.concat([decipher.update(value.subarray(NONCE_BYTES, value.length - TAG_BYTES)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
