/**
 * Kiosk pairing codes (docs/contracts/attendance.md › Pairing): 8 characters of Crockford base32 (40 bits), shown
 * `XXXX-XXXX`, valid 10 minutes, single use, stored as SHA-256 of the 8 normalised characters. Input is
 * case-insensitive; hyphens and spaces are ignored; O reads as 0, I and L as 1.
 */
import { createHash } from 'node:crypto';

export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const PAIRING_TTL_MS = 10 * 60 * 1000;
export const PAIRING_CODE_LENGTH = 8;

/** 5 random bytes → 8 Crockford characters (not formatted). */
export function pairingCodeFrom(random: Buffer): string {
  if (random.length < 5) throw new Error('5 random bytes needed');
  let bits = 0n;
  for (const byte of random.subarray(0, 5)) bits = (bits << 8n) | BigInt(byte);
  let out = '';
  for (let i = PAIRING_CODE_LENGTH - 1; i >= 0; i--) out += CROCKFORD[Number((bits >> BigInt(i * 5)) & 31n)];
  return out;
}

/** "K7M29QXA" → "K7M2-9QXA". */
export function formatPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** User input → the 8 canonical characters, or null when it cannot be a code. */
export function normalizePairingCode(input: string): string | null {
  const s = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (s.length !== PAIRING_CODE_LENGTH) return null;
  for (const c of s) if (!CROCKFORD.includes(c)) return null;
  return s;
}

export function pairingCodeHash(normalized: string): Buffer {
  return createHash('sha256').update(normalized, 'utf8').digest();
}
