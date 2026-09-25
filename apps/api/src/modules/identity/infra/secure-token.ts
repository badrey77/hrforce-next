import { createHash, randomBytes } from 'node:crypto';

/** Opaque single-use tokens (refresh tokens, password links): 32 random bytes, base64url (43 chars). */
export const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function newOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

/** sha-256 of the token: the only form stored in the database. */
export function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** sha-256 of a well-formed opaque token, or null for anything else (never hits the database). */
export function hashOpaqueToken(value: string | undefined | null): Buffer | null {
  return typeof value === 'string' && OPAQUE_TOKEN_PATTERN.test(value) ? sha256(value) : null;
}
