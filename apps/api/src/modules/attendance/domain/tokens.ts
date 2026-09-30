/**
 * The check-in's signed values (docs/contracts/attendance.md › Check-in, ADR 009 §2–3) — pure functions over keys.
 *
 *   QR token       base64url(0x01 ‖ companyId(16) ‖ deviceId(16) ‖ window(uint32 BE) ‖ MAC16)       → 71 characters
 *   scan receipt   base64url(0x01 ‖ companyId ‖ deviceId ‖ window(uint32) ‖ scannedAtMs(uint64 BE) ‖ MAC16)
 *   kiosk cookie   base64url(companyId(16) ‖ deviceId(16) ‖ secret(32))  (only SHA-256(secret) is stored)
 *   device ref     hex(HMAC(K_dev, hrf_dev value)[0..16])
 * MAC16 = the first 16 bytes of HMAC-SHA256(key, domain label ‖ the preceding bytes). Subkeys of ATTENDANCE_KEY:
 * K_qr = HMAC(key, "qr"), K_scan = HMAC(key, "scan"), K_dev = HMAC(key, "device").
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const WINDOW_SECONDS = 30;
/** Windows served to a kiosk: the current one and the next three (2 minutes of cover). */
export const KIOSK_WINDOWS = 4;
/**
 * A scan receipt is redeemable for 2 minutes (the sign-in in between). Owner decision 2026-09-30: shortened from 5 to
 * narrow the bearer-receipt relay window (docs/contracts/attendance.md › Settled by the verification).
 */
export const RECEIPT_TTL_SECONDS = 120;

const VERSION = 0x01;
const QR_LABEL = Buffer.from('hrforce.attendance.qr.v1\0', 'utf8');
const SCAN_LABEL = Buffer.from('hrforce.attendance.scan.v1\0', 'utf8');
const MAC_BYTES = 16;
const QR_BYTES = 1 + 16 + 16 + 4 + MAC_BYTES;
const RECEIPT_BYTES = 1 + 16 + 16 + 4 + 8 + MAC_BYTES;
const KIOSK_BYTES = 16 + 16 + 32;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const B64URL = /^[A-Za-z0-9_-]+$/;

export interface AttendanceKeys {
  qr: Buffer;
  scan: Buffer;
  device: Buffer;
}

export function deriveKeys(master: Buffer): AttendanceKeys {
  const sub = (label: string) => createHmac('sha256', master).update(label, 'utf8').digest();
  return { qr: sub('qr'), scan: sub('scan'), device: sub('device') };
}

/** The 30-second window of an instant. */
export function windowOf(ms: number): number {
  return Math.floor(ms / 1000 / WINDOW_SECONDS);
}

export function windowStartMs(window: number): number {
  return window * WINDOW_SECONDS * 1000;
}

function uuidBytes(id: string): Buffer {
  if (!UUID.test(id)) throw new Error('not a uuid');
  return Buffer.from(id.replace(/-/g, ''), 'hex');
}

function bytesUuid(bytes: Buffer): string {
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function mac(key: Buffer, label: Buffer, body: Buffer): Buffer {
  return createHmac('sha256', key).update(label).update(body).digest().subarray(0, MAC_BYTES);
}

function decode(value: string, length: number): Buffer | null {
  if (!B64URL.test(value)) return null;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === length && bytes.toString('base64url') === value ? bytes : null;
}

function sameMac(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── QR token ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface QrClaims {
  companyId: string;
  deviceId: string;
  window: number;
}

export function signQrToken(key: Buffer, claims: QrClaims): string {
  const body = Buffer.alloc(QR_BYTES - MAC_BYTES);
  body.writeUInt8(VERSION, 0);
  uuidBytes(claims.companyId).copy(body, 1);
  uuidBytes(claims.deviceId).copy(body, 17);
  body.writeUInt32BE(claims.window, 33);
  return Buffer.concat([body, mac(key, QR_LABEL, body)]).toString('base64url');
}

/** The claims of a well-formed token signed with `key` (any window); null for a wrong length, version or MAC. */
export function verifyQrToken(key: Buffer, token: string): QrClaims | null {
  const bytes = decode(token, QR_BYTES);
  if (!bytes || bytes.readUInt8(0) !== VERSION) return null;
  const body = bytes.subarray(0, QR_BYTES - MAC_BYTES);
  if (!sameMac(bytes.subarray(QR_BYTES - MAC_BYTES), mac(key, QR_LABEL, body))) return null;
  return { companyId: bytesUuid(body.subarray(1, 17)), deviceId: bytesUuid(body.subarray(17, 33)), window: body.readUInt32BE(33) };
}

/** A token is accepted in its own window and the next one: 30 to 60 seconds after it first shows. */
export function isAcceptedWindow(tokenWindow: number, nowMs: number): boolean {
  const current = windowOf(nowMs);
  return tokenWindow === current || tokenWindow === current - 1;
}

// ── scan receipt ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface ScanReceipt extends QrClaims {
  scannedAtMs: number;
}

export function signScanReceipt(key: Buffer, receipt: ScanReceipt): string {
  const body = Buffer.alloc(RECEIPT_BYTES - MAC_BYTES);
  body.writeUInt8(VERSION, 0);
  uuidBytes(receipt.companyId).copy(body, 1);
  uuidBytes(receipt.deviceId).copy(body, 17);
  body.writeUInt32BE(receipt.window, 33);
  body.writeBigUInt64BE(BigInt(receipt.scannedAtMs), 37);
  return Buffer.concat([body, mac(key, SCAN_LABEL, body)]).toString('base64url');
}

export function verifyScanReceipt(key: Buffer, value: string): ScanReceipt | null {
  const bytes = decode(value, RECEIPT_BYTES);
  if (!bytes || bytes.readUInt8(0) !== VERSION) return null;
  const body = bytes.subarray(0, RECEIPT_BYTES - MAC_BYTES);
  if (!sameMac(bytes.subarray(RECEIPT_BYTES - MAC_BYTES), mac(key, SCAN_LABEL, body))) return null;
  return {
    companyId: bytesUuid(body.subarray(1, 17)),
    deviceId: bytesUuid(body.subarray(17, 33)),
    window: body.readUInt32BE(33),
    scannedAtMs: Number(body.readBigUInt64BE(37)),
  };
}

// ── kiosk credential ─────────────────────────────────────────────────────────────────────────────────────────────

export interface KioskCredential {
  companyId: string;
  deviceId: string;
  secret: Buffer;
}

export function encodeKioskCookie(credential: KioskCredential): string {
  if (credential.secret.length !== 32) throw new Error('kiosk secret must be 32 bytes');
  return Buffer.concat([uuidBytes(credential.companyId), uuidBytes(credential.deviceId), credential.secret]).toString('base64url');
}

export function decodeKioskCookie(value: string): KioskCredential | null {
  const bytes = decode(value, KIOSK_BYTES);
  if (!bytes) return null;
  return { companyId: bytesUuid(bytes.subarray(0, 16)), deviceId: bytesUuid(bytes.subarray(16, 32)), secret: Buffer.from(bytes.subarray(32)) };
}

export function sha256(value: Buffer | string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Constant-time comparison of a presented secret with the stored SHA-256. */
export function secretMatches(secret: Buffer, storedHash: Buffer | null): boolean {
  if (!storedHash || storedHash.length !== 32) return false;
  return timingSafeEqual(sha256(secret), storedHash);
}

// ── per-browser identifier ───────────────────────────────────────────────────────────────────────────────────────

/** The random `hrf_dev` value: 16 bytes, base64url (22 characters). */
export function isDeviceCookie(value: string): boolean {
  return decode(value, 16) !== null;
}

export function deviceRefOf(key: Buffer, cookie: string): string {
  return createHmac('sha256', key).update(cookie, 'utf8').digest().subarray(0, 16).toString('hex');
}
