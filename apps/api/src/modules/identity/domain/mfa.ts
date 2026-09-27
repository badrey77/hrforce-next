import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * Two-step sign-in, pure rules (docs/contracts/mfa.md › Crypto): RFC 4648 base32, HOTP (RFC 4226) / TOTP (RFC 6238,
 * HMAC-SHA1, 6 digits, 30 s, current step ±1, replay refused), recovery codes. node:crypto only; no Nest, no Kysely.
 */

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Steps accepted around the current one (clock drift). */
export const TOTP_WINDOW = 1;
export const TOTP_SECRET_BYTES = 20;
export const MFA_MAX_FAILURES = 5;
export const MFA_CHALLENGE_TTL_SECONDS = 300;
export const RECOVERY_CODE_COUNT = 10;
export const RECOVERY_CODE_LENGTH = 10;
/** 32 characters, no ambiguous ones (no I, O, 0, 1). */
export const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const MFA_ISSUER = 'HRForce';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, upper case, without padding. */
export function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** Decodes base32 (case-insensitive, spaces and `=` ignored); null on any other character. */
export function base32Decode(text: string): Buffer | null {
  const clean = text.replace(/[\s=]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const index = BASE32.indexOf(ch);
    if (index < 0) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function newTotpSecret(): Buffer {
  return randomBytes(TOTP_SECRET_BYTES);
}

/** HOTP value (RFC 4226 dynamic truncation) of `counter`, zero-padded to `digits`. */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS, algorithm: 'sha1' | 'sha256' | 'sha512' = 'sha1'): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm, secret).update(message).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary = (((mac[offset] ?? 0) & 0x7f) << 24) | ((mac[offset + 1] ?? 0) << 16) | ((mac[offset + 2] ?? 0) << 8) | (mac[offset + 3] ?? 0);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The TOTP time step of `nowMs`. */
export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

export function totp(secret: Buffer, nowMs: number, digits = TOTP_DIGITS): string {
  return hotp(secret, totpStep(nowMs), digits);
}

function equalCodes(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export type TotpCheck = { ok: true; step: number } | { ok: false; reason: 'format' | 'mismatch' | 'replay' };

/**
 * Checks a 6-digit code against steps now-1 … now+1 (every candidate is compared, in constant time). A matching step
 * ≤ `lastUsedStep` is a replay (refused). The newest matching step wins.
 */
export function verifyTotp(secret: Buffer, code: string, nowMs: number, lastUsedStep: number | null): TotpCheck {
  if (!/^\d{6}$/.test(code)) return { ok: false, reason: 'format' };
  const current = totpStep(nowMs);
  let matched: number | null = null;
  for (let step = current - TOTP_WINDOW; step <= current + TOTP_WINDOW; step++) {
    if (equalCodes(hotp(secret, step), code)) matched = step;
  }
  if (matched === null) return { ok: false, reason: 'mismatch' };
  if (lastUsedStep !== null && matched <= lastUsedStep) return { ok: false, reason: 'replay' };
  return { ok: true, step: matched };
}

/** `otpauth://totp/HRForce:<email>?secret=…&issuer=HRForce&algorithm=SHA1&digits=6&period=30` */
export function otpauthUri(email: string, secretBase32: string): string {
  const label = `${MFA_ISSUER}:${encodeURIComponent(email)}`;
  const query = `secret=${secretBase32}&issuer=${MFA_ISSUER}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SECONDS}`;
  return `otpauth://totp/${label}?${query}`;
}

/** 10 new recovery codes, displayed `XXXXX-XXXXX`. */
export function newRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    let raw = '';
    for (let i = 0; i < RECOVERY_CODE_LENGTH; i++) raw += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

/** Upper case, without spaces or hyphens; null unless 10 characters of the recovery alphabet remain. */
export function normalizeRecoveryCode(input: string): string | null {
  const clean = input.replace(/[\s\-‐-―−]/g, '').toUpperCase();
  if (clean.length !== RECOVERY_CODE_LENGTH) return null;
  for (const ch of clean) if (!RECOVERY_ALPHABET.includes(ch)) return null;
  return clean;
}

/** sha-256 of the normalized code (the only stored form). */
export function hashRecoveryCode(normalized: string): Buffer {
  return createHash('sha256').update(normalized, 'utf8').digest();
}
