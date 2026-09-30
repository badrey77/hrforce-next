/**
 * The kiosk's time arithmetic (docs/contracts/attendance.md › Kiosk, ADR 009 §2 and §4). Plain TypeScript, no
 * Angular, so every rule is unit-tested with fixed numbers (kiosk-clock.spec.ts).
 *
 * The server is the only clock that decides anything. The tablet's own clock may be minutes off (cheap tablets, no
 * network time), so the kiosk measures the difference once per fetch and adds it to `Date.now()`:
 *
 *   offset = serverTime − (t_send + t_receive) / 2
 *
 * (the server stamped `serverTime` somewhere during the round trip; the middle is the best guess — the same idea
 * as NTP). "Corrected now" = `Date.now() + offset`. It picks the QR window to show and drives the display clock.
 */
import type { QrWindow } from '../../core/attendance/attendance.models';

/** Algiers is UTC+1 with no daylight saving (contract › Time). */
export const ALGIERS_OFFSET_MS = 3_600_000;
/** Retry period while the kiosk is offline (contract: every 5 s). */
export const OFFLINE_RETRY_MS = 5_000;
/** Random delay added after a window starts before fetching (spreads the load of many kiosks: 1–3 s). */
export const JITTER_MIN_MS = 1_000;
export const JITTER_MAX_MS = 3_000;
/** The session call renews the device cookie; once a day is plenty (it lives 400 days). */
export const SESSION_RENEW_MS = 24 * 3_600_000;

export function measureOffset(serverTimeIso: string, sentAt: number, receivedAt: number): number {
  const server = Date.parse(serverTimeIso);
  if (Number.isNaN(server)) return 0;
  return Math.round(server - (sentAt + receivedAt) / 2);
}

/** The window whose `[showFrom, showUntil)` contains `now` (corrected), or `null` → the kiosk shows "offline". */
export function activeWindow(windows: readonly QrWindow[], now: number): QrWindow | null {
  return windows.find((w) => Date.parse(w.showFrom) <= now && now < Date.parse(w.showUntil)) ?? null;
}

/** A jitter in [1 s, 3 s) from a random number in [0, 1). */
export function jitter(random: number): number {
  return JITTER_MIN_MS + Math.floor(random * (JITTER_MAX_MS - JITTER_MIN_MS));
}

/**
 * Milliseconds (device clock) until the next fetch: the start of the window after the active one, plus the jitter.
 * No active window → fetch now (0).
 */
export function nextFetchDelay(windows: readonly QrWindow[], now: number, jitterMs: number): number {
  const active = activeWindow(windows, now);
  if (!active) return 0;
  return Math.max(0, Date.parse(active.showUntil) - now) + jitterMs;
}

/** Share of the active window still to run, 1 → 0 (the thin countdown bar). */
export function remainingShare(window: QrWindow, now: number): number {
  const from = Date.parse(window.showFrom);
  const until = Date.parse(window.showUntil);
  if (until <= from) return 0;
  return Math.min(1, Math.max(0, (until - now) / (until - from)));
}

/** "HH:MM:SS" in Algiers for a corrected instant — independent of the tablet's time zone setting. */
export function algiersClock(now: number): string {
  return new Date(now + ALGIERS_OFFSET_MS).toISOString().slice(11, 19);
}

/**
 * True between 03:00:00 and 03:04:59 Algiers: the daily full reload that picks up a new release (contract). The
 * caller also checks that the page has been up for a while, so a reload at 03:01 does not reload again at 03:02.
 */
export function inReloadSlot(now: number): boolean {
  const clock = algiersClock(now);
  return clock >= '03:00:00' && clock < '03:05:00';
}
