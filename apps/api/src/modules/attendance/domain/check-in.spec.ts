import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { addressAllowed, formatNetwork, parseNetwork } from './networks.js';
import { formatPairingCode, normalizePairingCode, pairingCodeFrom, pairingCodeHash } from './pairing.js';
import {
  decodeKioskCookie,
  deriveKeys,
  deviceRefOf,
  encodeKioskCookie,
  isAcceptedWindow,
  secretMatches,
  sha256,
  signQrToken,
  signScanReceipt,
  verifyQrToken,
  verifyScanReceipt,
  windowOf,
  windowStartMs,
} from './tokens.js';
import { validateWeek } from './week.js';

const COMPANY = '0190a5d0-0000-7000-8000-000000000001';
const DEVICE = '0190a5d0-0000-7000-9a70-000000000001';
const OTHER = '0190a5d0-0000-7000-9a70-000000000002';
const keys = deriveKeys(Buffer.alloc(32, 7));

describe('QR token', () => {
  it('is 71 base64url characters and round-trips', () => {
    const token = signQrToken(keys.qr, { companyId: COMPANY, deviceId: DEVICE, window: 59_000_000 });
    expect(token).toMatch(/^[A-Za-z0-9_-]{71}$/);
    expect(verifyQrToken(keys.qr, token)).toEqual({ companyId: COMPANY, deviceId: DEVICE, window: 59_000_000 });
  });

  it('current and previous window accepted; older and future refused', () => {
    const now = windowStartMs(1000) + 12_000;
    expect(windowOf(now)).toBe(1000);
    expect(isAcceptedWindow(1000, now)).toBe(true);
    expect(isAcceptedWindow(999, now)).toBe(true);
    expect(isAcceptedWindow(998, now)).toBe(false);
    expect(isAcceptedWindow(1001, now)).toBe(false);
  });

  it('tampered, truncated, other key, other version → null; the company and device are covered by the MAC', () => {
    const token = signQrToken(keys.qr, { companyId: COMPANY, deviceId: DEVICE, window: 5 });
    const bytes = Buffer.from(token, 'base64url');
    for (const i of [0, 1, 20, 36, 40, 70]) {
      if (i >= bytes.length) continue;
      const copy = Buffer.from(bytes);
      copy[i] = (copy[i] ?? 0) ^ 1;
      expect(verifyQrToken(keys.qr, copy.toString('base64url')), `byte ${i}`).toBeNull();
    }
    // another device / company in the body with the original MAC
    const swapped = Buffer.from(bytes);
    Buffer.from(OTHER.replace(/-/g, ''), 'hex').copy(swapped, 17);
    expect(verifyQrToken(keys.qr, swapped.toString('base64url'))).toBeNull();
    expect(verifyQrToken(keys.qr, token.slice(0, 70))).toBeNull();
    expect(verifyQrToken(keys.qr, `${token}A`)).toBeNull();
    expect(verifyQrToken(deriveKeys(Buffer.alloc(32, 8)).qr, token)).toBeNull();
    expect(verifyQrToken(keys.scan, token)).toBeNull();
    expect(verifyQrToken(keys.qr, 'not a token')).toBeNull();
  });
});

describe('scan receipt', () => {
  it('round-trips the scan instant; tampering and the QR key are refused', () => {
    const receipt = { companyId: COMPANY, deviceId: DEVICE, window: 42, scannedAtMs: 1_790_000_000_123 };
    const value = signScanReceipt(keys.scan, receipt);
    expect(verifyScanReceipt(keys.scan, value)).toEqual(receipt);
    expect(verifyScanReceipt(keys.qr, value)).toBeNull();
    const bytes = Buffer.from(value, 'base64url');
    bytes[44] = (bytes[44] ?? 0) ^ 1;
    expect(verifyScanReceipt(keys.scan, bytes.toString('base64url'))).toBeNull();
  });
});

describe('kiosk cookie and device ref', () => {
  it('encodes company ‖ device ‖ secret; only the SHA-256 of the secret is compared', () => {
    const secret = randomBytes(32);
    const cookie = encodeKioskCookie({ companyId: COMPANY, deviceId: DEVICE, secret });
    const decoded = decodeKioskCookie(cookie);
    expect(decoded).toMatchObject({ companyId: COMPANY, deviceId: DEVICE });
    expect(decoded && secretMatches(decoded.secret, sha256(secret))).toBe(true);
    expect(decoded && secretMatches(decoded.secret, sha256(randomBytes(32)))).toBe(false);
    expect(decoded && secretMatches(decoded.secret, null)).toBe(false);
    expect(decodeKioskCookie('garbage')).toBeNull();
  });

  it('device ref: 32 lower-case hex, stable per key and cookie', () => {
    const ref = deviceRefOf(keys.device, 'AAAAAAAAAAAAAAAAAAAAAA');
    expect(ref).toMatch(/^[0-9a-f]{32}$/);
    expect(deviceRefOf(keys.device, 'AAAAAAAAAAAAAAAAAAAAAA')).toBe(ref);
    expect(deviceRefOf(keys.qr, 'AAAAAAAAAAAAAAAAAAAAAA')).not.toBe(ref);
  });
});

describe('pairing code', () => {
  it('8 Crockford characters from 40 bits, formatted XXXX-XXXX', () => {
    expect(pairingCodeFrom(Buffer.alloc(5, 0))).toBe('00000000');
    expect(pairingCodeFrom(Buffer.alloc(5, 0xff))).toBe('ZZZZZZZZ');
    const code = pairingCodeFrom(randomBytes(5));
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(formatPairingCode('K7M29QXA')).toBe('K7M2-9QXA');
  });

  it('normalises input: case, hyphens, spaces, O→0, I/L→1; refuses the rest', () => {
    expect(normalizePairingCode('demk-2026')).toBe('DEMK2026');
    expect(normalizePairingCode(' k7m2 9qxa ')).toBe('K7M29QXA');
    expect(normalizePairingCode('OIL0-abcd')).toBe('0110ABCD');
    expect(normalizePairingCode('UUUU-UUUU')).toBeNull();
    expect(normalizePairingCode('ABC')).toBeNull();
    expect(pairingCodeHash('DEMK2026')).toHaveLength(32);
  });
});

describe('allowed networks', () => {
  it('parses IPv4 / IPv6 blocks and bare addresses; refuses host bits and junk', () => {
    expect(formatNetwork(parseNetwork('41.100.1.0/24') ?? { bytes: [], prefix: 0, family: 4 })).toBe('41.100.1.0/24');
    expect(parseNetwork('41.100.1.5')?.prefix).toBe(32);
    expect(parseNetwork('41.100.1.5/24')).toBeNull();
    expect(parseNetwork('300.1.1.1')).toBeNull();
    expect(parseNetwork('2001:db8::/32')).not.toBeNull();
    expect(formatNetwork(parseNetwork('2001:0db8:0000::/48') ?? { bytes: [], prefix: 0, family: 6 })).toBe('2001:db8::/48');
    expect(parseNetwork('2001:db8::1/32')).toBeNull();
    expect(parseNetwork('nonsense')).toBeNull();
  });

  it('matches client addresses (IPv4-mapped IPv6 too); an empty list allows everything', () => {
    expect(addressAllowed('41.100.1.77', ['41.100.1.0/24'])).toBe(true);
    expect(addressAllowed('::ffff:41.100.1.77', ['41.100.1.0/24'])).toBe(true);
    expect(addressAllowed('41.100.2.1', ['41.100.1.0/24'])).toBe(false);
    expect(addressAllowed('2001:db8:1::5', ['2001:db8::/32'])).toBe(true);
    expect(addressAllowed(null, ['41.100.1.0/24'])).toBe(false);
    expect(addressAllowed(null, [])).toBe(true);
  });
});

const work = (day: number, extra: object = {}) => ({ day, start: '08:00', end: '16:30', breakStart: '12:00', breakEnd: '12:30', ...extra });
const week = (overrides: Record<number, object> = {}) => [1, 2, 3, 4, 5, 6, 7].map((d) => overrides[d] ?? (d === 5 || d === 6 ? { day: d, rest: true } : work(d)));
function weekErrors(w: unknown) {
  const r = validateWeek(w);
  return r.ok ? [] : r.errors;
}

describe('week validation', () => {

  it('accepts the standard week', () => {
    expect(validateWeek(week()).ok).toBe(true);
  });

  it('field errors: invalid_time, invalid_break, no_working_day, invalid shape', () => {
    const errors = weekErrors;
    expect(errors(week({ 1: work(1, { start: '17:00' }) }))).toEqual([expect.objectContaining({ field: 'week.0.end', code: 'invalid_time' })]);
    expect(errors(week({ 2: work(2, { start: '8h' }) }))).toEqual([expect.objectContaining({ field: 'week.1.start', code: 'invalid_time' })]);
    expect(errors(week({ 3: work(3, { breakEnd: null }) }))).toEqual([expect.objectContaining({ field: 'week.2.breakEnd', code: 'invalid_break' })]);
    expect(errors(week({ 4: work(4, { breakStart: '07:00' }) }))).toEqual([expect.objectContaining({ field: 'week.3.breakStart', code: 'invalid_break' })]);
    expect(errors([1, 2, 3, 4, 5, 6, 7].map((d) => ({ day: d, rest: true })))).toEqual([expect.objectContaining({ field: 'week', code: 'no_working_day' })]);
    expect(errors(week().slice(0, 6))).toEqual([expect.objectContaining({ field: 'week', code: 'invalid' })]);
    expect(errors(week({ 1: { ...work(2) } }))).toEqual([expect.objectContaining({ field: 'week.0.day', code: 'invalid' })]);
  });
});
