import { createHash } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import {
  DEMO_KIOSKS,
  deriveKeys,
  encodeKioskCookie,
  seedAttendanceDefaults,
  seedDemoAttendanceSetup,
  signQrToken,
  signScanReceipt,
  windowOf,
} from '../../src/modules/attendance/index.js';
import { DEV_ATTENDANCE_KEY } from '../../src/platform/config/env.schema.js';
import type { DB } from '../../src/platform/db/schema.js';

/*
 * Attendance e2e helpers (docs/contracts/attendance.md › Seed: "the e2e fixture option `attendance: true` … plus the
 * tokens/receipts helpers"). The test apps run without ATTENDANCE_KEY, i.e. with the public development key, so the
 * tests can sign codes and receipts exactly like the API does. TEST DATA.
 */

const COMPANY_A = '0190a5d0-0000-7000-8000-000000000001';
const COMPANY_B = '0190a5d0-0000-7000-8000-00000000000b';

export const ATT_KEYS = deriveKeys(Buffer.from(DEV_ATTENDANCE_KEY, 'base64'));

/** BETA's active kiosk (site BETA-HQ) and its one fixture punch (EMPLOYEE_B). */
export const BETA_KIOSK = '0190a5d0-0000-7000-9a7b-000000000001';
export const BETA_PUNCH = '0190a5d0-0000-7000-9a7b-000000000002';
const BETA_SITE = '0190a5d0-0000-7000-8000-000000000b21';
const BETA_EMPLOYMENT = '0190a5d0-0000-7000-8000-00000000b502';

/** The known 32-byte secret of a fixture kiosk (its SHA-256 is stored as the credential). */
export function kioskSecret(deviceId: string): Buffer {
  return createHash('sha256').update(`test-kiosk:${deviceId}`).digest();
}

/** `hrf_kiosk=<credential>` for a fixture kiosk of `companyId` (default DEMO). */
export function kioskCookie(deviceId: string, companyId = COMPANY_A): string {
  return `hrf_kiosk=${encodeKioskCookie({ companyId, deviceId, secret: kioskSecret(deviceId) })}`;
}

export function qrToken(deviceId: string, window: number, companyId = COMPANY_A): string {
  return signQrToken(ATT_KEYS.qr, { companyId, deviceId, window });
}

/** `hrf_scan=<receipt>` as the scan route would set it at `scannedAtMs`. */
export function scanReceipt(deviceId: string, scannedAtMs: number, companyId = COMPANY_A, window = windowOf(scannedAtMs)): string {
  return `hrf_scan=${signScanReceipt(ATT_KEYS.scan, { companyId, deviceId, window, scannedAtMs })}`;
}

/**
 * DEMO: the demo setup (schedules `standard` + `agence`, the Ramadan override, the four kiosks) with KNOWN credentials
 * on the Annaba and Constantine kiosks; BETA: its defaults, one active kiosk with a known credential, one punch.
 */
export async function seedAttendanceFixture(tx: Transaction<DB>, nowMs = Date.now()): Promise<void> {
  await seedDemoAttendanceSetup(tx, nowMs);
  for (const id of [DEMO_KIOSKS.annaba.id, DEMO_KIOSKS.cne.id]) {
    await sql`update attendance_device set credential_hash = ${createHash('sha256').update(kioskSecret(id)).digest()} where id = ${id}::uuid`.execute(tx);
  }
  await seedAttendanceDefaults(tx, COMPANY_B);
  await sql`
    insert into attendance_device (id, company_id, site_id, name_fr, name_ar, status, credential_hash, paired_at)
    values (${BETA_KIOSK}::uuid, ${COMPANY_B}::uuid, ${BETA_SITE}::uuid, 'Beta — Entrée', 'بيتا — المدخل', 'active',
            ${createHash('sha256').update(kioskSecret(BETA_KIOSK)).digest()}, now())
    on conflict do nothing`.execute(tx);
  const at = new Date(Date.parse('2026-09-20T07:02:00Z'));
  await sql`
    insert into attendance_punch (id, company_id, employment_id, direction, occurred_at, source, device_id, qr_window, site_id)
    values (${BETA_PUNCH}::uuid, ${COMPANY_B}::uuid, ${BETA_EMPLOYMENT}::uuid, 'in', ${at}, 'qr', ${BETA_KIOSK}::uuid, ${windowOf(at.getTime())}, ${BETA_SITE}::uuid)
    on conflict do nothing`.execute(tx);
}
