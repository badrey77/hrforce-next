import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuditEvents } from '../../../platform/audit/audit-events.js';
import { ENV } from '../../../platform/config/config.module.js';
import type { Env } from '../../../platform/config/env.schema.js';
import { requireContext } from '../../../platform/context/request-context.js';
import { runInRequestTransaction } from '../../../platform/context/request-transaction.js';
import { KYSELY, type Database } from '../../../platform/db/database.js';
import { getRequestId } from '../../../platform/http/request-id.js';
import { ProblemException, ValidationProblemException } from '../../../platform/http/problem-details.js';
import {
  appendCookie,
  ATTENDANCE_COOKIE_PATH,
  DEVICE_REF_COOKIE,
  KIOSK_COOKIE,
  KIOSK_COOKIE_PATH,
  readCookie,
  SCAN_COOKIE,
} from '../../../platform/security/cookies.js';
import { addressAllowed } from '../domain/networks.js';
import { normalizePairingCode, pairingCodeHash } from '../domain/pairing.js';
import { algiersDate, algiersTime } from '../domain/time.js';
import {
  decodeKioskCookie,
  deviceRefOf,
  encodeKioskCookie,
  isAcceptedWindow,
  isDeviceCookie,
  KIOSK_WINDOWS,
  RECEIPT_TTL_SECONDS,
  secretMatches,
  sha256,
  signQrToken,
  signScanReceipt,
  verifyQrToken,
  verifyScanReceipt,
  windowOf,
  windowStartMs,
  WINDOW_SECONDS,
} from '../domain/tokens.js';
import { AttendanceRepository, type PunchRow } from '../infra/attendance.repository.js';
import { KiosksRepository, type DeviceRow } from '../infra/kiosks.repository.js';
import { SchedulesRepository } from '../infra/schedules.repository.js';
import { AttendanceClock, AttendanceKeys } from './attendance-clock.js';
import type { KioskQrView, KioskSessionView, PunchResultView, ReceiptView, ScanView } from './attendance-views.js';
import { isEmployedOn, PresenceEngine } from './presence-engine.js';
import { notLinked } from './presence.service.js';

/** 400 days, the browsers' cap on cookie lifetime. */
export const LONG_COOKIE_SECONDS = 34_560_000;

const unpaired = () => new ProblemException(401, 'kiosk-unpaired', 'This screen is not paired (or no longer): pair it again with a new code.');
const qrInvalid = () => new ProblemException(422, 'attendance-qr-invalid', 'This code is not a valid check-in code.');
const pairingGone = () => new ProblemException(410, 'kiosk-pairing-invalid', 'This pairing code is unknown, expired or already used.');
const noScan = () => new ProblemException(409, 'attendance-no-scan', 'Scan the code at the entrance again.');

function userAgentOf(req: Request): string | null {
  const ua = req.headers['user-agent'];
  return typeof ua === 'string' ? ua.slice(0, 300) : null;
}

/** The client address (Express `trust proxy` = TRUST_PROXY_HOPS, as the login throttle), without an IPv4-mapped prefix. */
function clientIp(req: Request): string | null {
  const ip = req.ip ?? req.socket.remoteAddress ?? null;
  if (!ip) return null;
  return ip.startsWith('::ffff:') && ip.includes('.') ? ip.slice(7) : ip;
}

/**
 * The QR check-in (docs/contracts/attendance.md › Check-in, ADR 009): kiosk pairing and credential, the kiosk's QR
 * windows, the public scan that hands the phone a signed receipt, and the redemption of that receipt as a punch.
 * The device routes have no user: they run in their own transactions bound to the company named by the (verified)
 * kiosk cookie or pairing code, with actor null.
 */
@Injectable()
export class CheckInService {
  constructor(
    @Inject(KYSELY) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly kiosks: KiosksRepository,
    private readonly repo: AttendanceRepository,
    private readonly schedules: SchedulesRepository,
    private readonly engine: PresenceEngine,
    private readonly clock: AttendanceClock,
    private readonly keys: AttendanceKeys,
    private readonly audit: AuditEvents,
  ) {}

  private inCompany<T>(req: Request, companyId: string | null, fn: () => Promise<T>): Promise<T> {
    return runInRequestTransaction(this.db, { requestId: getRequestId(req), companyId, userId: null }, fn);
  }

  private setKioskCookie(res: Response, value: string): void {
    appendCookie(res, { name: KIOSK_COOKIE, value, path: KIOSK_COOKIE_PATH, maxAge: LONG_COOKIE_SECONDS, httpOnly: true, secure: this.env.COOKIE_SECURE });
  }

  private clearKioskCookie(res: Response): void {
    appendCookie(res, { name: KIOSK_COOKIE, value: '', path: KIOSK_COOKIE_PATH, maxAge: 0, httpOnly: true, secure: this.env.COOKIE_SECURE });
  }

  private sessionView(device: DeviceRow, companyName: string): KioskSessionView {
    return {
      kiosk: { id: device.id, labels: { fr: device.nameFr, ar: device.nameAr }, site: { code: device.siteCode, name: device.siteName } },
      company: { name: companyName },
      serverTime: new Date(this.clock.nowMs()).toISOString(),
      windowSeconds: WINDOW_SECONDS,
    };
  }

  // ── pairing ───────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * `POST /kiosk/pair {code}`: the code → (company, device) through the definer lookup, then — in a transaction bound
   * to that company, the device row locked — a new credential replaces the code and any previous credential.
   * Malformed → 422 `code` invalid; unknown / expired / used / revoked → 410 `kiosk-pairing-invalid`.
   */
  async pair(code: string, req: Request, res: Response): Promise<KioskSessionView> {
    const normalized = normalizePairingCode(code);
    if (!normalized) throw new ValidationProblemException([{ field: 'code', code: 'invalid', message: 'Eight characters, e.g. K7M2-9QXA.' }]);
    const hash = pairingCodeHash(normalized);
    const found = await this.inCompany(req, null, () => this.kiosks.pairingLookup(hash));
    if (!found) throw pairingGone();
    const secret = randomBytes(32);
    const view = await this.inCompany(req, found.companyId, async () => {
      const device = await this.kiosks.find(found.companyId, found.deviceId, { lock: true });
      const still = await this.kiosks.pairingLookup(hash);
      if (!device || device.status === 'revoked' || still?.deviceId !== device.id) throw pairingGone();
      const replacedCredential = device.credentialHash !== null;
      await this.kiosks.pair(found.companyId, device.id, sha256(secret));
      const ip = clientIp(req);
      const userAgent = userAgentOf(req);
      await this.kiosks.heartbeat(found.companyId, device.id, ip, userAgent);
      await this.audit.record({
        type: 'attendance.device_paired',
        subject: { type: 'attendance_device', id: device.id },
        data: { deviceId: device.id, ip, userAgent, replacedCredential },
      });
      return this.sessionView(device, await this.kiosks.companyName(found.companyId));
    });
    this.setKioskCookie(res, encodeKioskCookie({ companyId: found.companyId, deviceId: found.deviceId, secret }));
    return view;
  }

  /**
   * The kiosk behind the `hrf_kiosk` cookie, inside `fn`'s transaction (bound to its company): bad / unknown /
   * mismatched / not active → 401 `kiosk-unpaired` and the cookie is cleared; outside the allowed networks → 403
   * `kiosk-network-refused`. Each success refreshes the heartbeat (at most once a minute).
   */
  private async withKiosk<T>(req: Request, res: Response, fn: (device: DeviceRow, companyId: string) => Promise<T>): Promise<T> {
    const raw = readCookie(req, KIOSK_COOKIE);
    const credential = raw ? decodeKioskCookie(raw) : null;
    if (!credential) {
      if (raw) this.clearKioskCookie(res);
      throw unpaired();
    }
    try {
      return await this.inCompany(req, credential.companyId, async () => {
        const device = await this.kiosks.find(credential.companyId, credential.deviceId);
        if (!device || device.status !== 'active' || !secretMatches(credential.secret, device.credentialHash)) throw unpaired();
        if (!addressAllowed(clientIp(req), device.allowedNetworks)) {
          throw new ProblemException(403, 'kiosk-network-refused', 'This screen may only be used from its site network.');
        }
        await this.kiosks.heartbeat(credential.companyId, device.id, clientIp(req), userAgentOf(req));
        return fn(device, credential.companyId);
      });
    } catch (error) {
      if (error instanceof ProblemException && error.slug === 'kiosk-unpaired') this.clearKioskCookie(res);
      throw error;
    }
  }

  /** `GET /kiosk/session`: which kiosk this is; the credential cookie is re-sent (400 days from now). */
  async session(req: Request, res: Response): Promise<KioskSessionView> {
    const view = await this.withKiosk(req, res, async (device, companyId) => this.sessionView(device, await this.kiosks.companyName(companyId)));
    const raw = readCookie(req, KIOSK_COOKIE);
    if (raw) this.setKioskCookie(res, raw);
    return view;
  }

  /** `GET /kiosk/qr`: the signed codes of the current window and the next three. */
  async qr(req: Request, res: Response): Promise<KioskQrView> {
    return this.withKiosk(req, res, (device, companyId) => {
      const now = this.clock.nowMs();
      const current = windowOf(now);
      const windows = Array.from({ length: KIOSK_WINDOWS }, (_, i) => {
        const window = current + i;
        const token = signQrToken(this.keys.keys.qr, { companyId, deviceId: device.id, window });
        return {
          window,
          qr: `${this.env.WEB_BASE_URL}/punch#${token}`,
          showFrom: new Date(windowStartMs(window)).toISOString(),
          showUntil: new Date(windowStartMs(window + 1)).toISOString(),
        };
      });
      return Promise.resolve({ serverTime: new Date(now).toISOString(), windowSeconds: WINDOW_SECONDS, windows });
    });
  }

  // ── the phone ─────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * `POST /attendance/scan {token}` (public, XSRF not bound to a session): verifies the code and hands the browser a
   * signed receipt of the scan instant (`hrf_scan`, 2 minutes) — and a random `hrf_dev` if it has none. Writes nothing.
   * Wrong length / version / MAC, unknown or non-active kiosk → 422 `attendance-qr-invalid`; a window other than the
   * current or the previous one → 410 `attendance-qr-expired`.
   */
  async scan(token: string, req: Request, res: Response): Promise<ScanView> {
    const claims = verifyQrToken(this.keys.keys.qr, token);
    if (!claims) throw qrInvalid();
    const now = this.clock.nowMs();
    if (!isAcceptedWindow(claims.window, now)) {
      throw new ProblemException(410, 'attendance-qr-expired', 'This code has expired: scan the code shown at the entrance again.');
    }
    const device = await this.inCompany(req, claims.companyId, () => this.kiosks.find(claims.companyId, claims.deviceId));
    if (!device || device.status !== 'active') throw qrInvalid();
    const receipt = signScanReceipt(this.keys.keys.scan, { ...claims, scannedAtMs: now });
    appendCookie(res, { name: SCAN_COOKIE, value: receipt, path: ATTENDANCE_COOKIE_PATH, maxAge: RECEIPT_TTL_SECONDS, httpOnly: true, secure: this.env.COOKIE_SECURE });
    const dev = readCookie(req, DEVICE_REF_COOKIE);
    if (!dev || !isDeviceCookie(dev)) {
      appendCookie(res, {
        name: DEVICE_REF_COOKIE,
        value: randomBytes(16).toString('base64url'),
        path: ATTENDANCE_COOKIE_PATH,
        maxAge: LONG_COOKIE_SECONDS,
        httpOnly: true,
        secure: this.env.COOKIE_SECURE,
      });
    }
    return {
      kiosk: { labels: { fr: device.nameFr, ar: device.nameAr }, site: { code: device.siteCode, name: device.siteName } },
      scannedAt: new Date(now).toISOString(),
      localTime: algiersTime(now),
      receiptExpiresAt: new Date(now + RECEIPT_TTL_SECONDS * 1000).toISOString(),
    };
  }

  /**
   * `POST /me/attendance/punches` (request transaction, attendance.punch_self): redeems the scan receipt as a punch at
   * the SCAN instant (docs/contracts/attendance.md › Punch, steps 1–7). 201 with the new punch; 200 `duplicate: true`
   * with the existing one for a second scan within the gap or the same (kiosk, window). Both clear the receipt.
   */
  /**
   * The checks shared by the punch and its preview, in the contract's order: 409 attendance-not-linked → 409
   * attendance-no-scan (missing, bad MAC, other company, older than 2 minutes or > 5 s in the future) → 422
   * attendance-qr-invalid (kiosk no longer active) → 409 attendance-not-employed.
   */
  private async redeemable(req: Request) {
    const { companyId, userId } = requireContext();
    if (!companyId || !userId) throw notLinked();
    const employmentId = await this.repo.linkedEmployment(companyId, userId);
    if (!employmentId) throw notLinked();

    const raw = readCookie(req, SCAN_COOKIE);
    const receipt = raw ? verifyScanReceipt(this.keys.keys.scan, raw) : null;
    const now = this.clock.nowMs();
    if (!receipt || receipt.companyId !== companyId || receipt.scannedAtMs > now + 5_000 || now - receipt.scannedAtMs > RECEIPT_TTL_SECONDS * 1000) throw noScan();
    const device = await this.kiosks.find(companyId, receipt.deviceId);
    if (!device || device.status !== 'active') throw qrInvalid();

    const workDate = algiersDate(receipt.scannedAtMs);
    const [employment] = await this.repo.employments(companyId, [employmentId]);
    if (!employment || !isEmployedOn(employment, workDate)) {
      throw new ProblemException(409, 'attendance-not-employed', 'You are not employed on this date.');
    }
    return { companyId, userId, employmentId, receipt, device, workDate };
  }

  /**
   * `GET /me/attendance/receipt` (attendance.punch_self): what redeeming the scan receipt WOULD record — the kiosk, the
   * scan time and the inferred direction — for the one-tap confirmation on /punch (owner decision 2026-09-30: a link
   * never punches silently). Writes nothing and keeps the receipt; same errors as the punch.
   */
  async receiptPreview(req: Request): Promise<ReceiptView> {
    const { companyId, employmentId, receipt, device, workDate } = await this.redeemable(req);
    const policy = await this.schedules.policy(companyId);
    const at = new Date(receipt.scannedAtMs);
    const existing = await this.repo.duplicateOf(companyId, employmentId, at, policy.minPunchGapSeconds, device.id, receipt.window);
    const last = existing ? undefined : await this.repo.lastLiveBefore(companyId, employmentId, workDate, at);
    return {
      kiosk: { labels: { fr: device.nameFr, ar: device.nameAr }, site: { code: device.siteCode, name: device.siteName } },
      scannedAt: at.toISOString(),
      // duplicate: the time of the punch already recorded (the one the person sees « Déjà enregistré » for), not the new scan's
      localTime: algiersTime(existing ? existing.occurredAt.getTime() : receipt.scannedAtMs),
      workDate,
      receiptExpiresAt: new Date(receipt.scannedAtMs + RECEIPT_TTL_SECONDS * 1000).toISOString(),
      direction: existing ? existing.direction : last?.direction === 'in' ? 'out' : 'in',
      duplicate: existing !== undefined,
    };
  }

  async punch(req: Request, res: Response): Promise<{ status: 200 | 201; view: PunchResultView }> {
    const { companyId, userId, employmentId, receipt, device, workDate } = await this.redeemable(req);
    await this.repo.lockEmployment(companyId, employmentId);
    const policy = await this.schedules.policy(companyId);
    const at = new Date(receipt.scannedAtMs);
    const existing = await this.repo.duplicateOf(companyId, employmentId, at, policy.minPunchGapSeconds, device.id, receipt.window);
    let punch: PunchRow | undefined = existing;
    if (!existing) {
      const last = await this.repo.lastLiveBefore(companyId, employmentId, workDate, at);
      const dev = readCookie(req, DEVICE_REF_COOKIE);
      const id = await this.repo.insertPunch(companyId, {
        employmentId,
        direction: last?.direction === 'in' ? 'out' : 'in',
        occurredAt: at,
        source: 'qr',
        deviceId: device.id,
        qrWindow: receipt.window,
        siteId: device.siteId,
        deviceRef: dev && isDeviceCookie(dev) ? deviceRefOf(this.keys.keys.device, dev) : null,
        reason: null,
        createdBy: userId,
      });
      punch = await this.repo.punch(companyId, id);
    }
    if (!punch) throw new Error('punch not found after insert');
    appendCookie(res, { name: SCAN_COOKIE, value: '', path: ATTENDANCE_COOKIE_PATH, maxAge: 0, httpOnly: true, secure: this.env.COOKIE_SECURE });
    const data = await this.engine.load(companyId, [employmentId], punch.workDate, punch.workDate);
    const facts = data.employment(employmentId);
    if (!facts) throw notLinked();
    const view: PunchResultView = {
      punch: data.punchView(punch, false),
      duplicate: existing !== undefined,
      day: data.day(facts, punch.workDate, { canManage: false, withPunches: false }).view,
    };
    return { status: existing ? 200 : 201, view };
  }
}
