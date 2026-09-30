import type { QrWindow } from '../../core/attendance/attendance.models';
import {
  activeWindow,
  algiersClock,
  inReloadSlot,
  jitter,
  measureOffset,
  nextFetchDelay,
  remainingShare,
} from './kiosk-clock';

const T0 = Date.parse('2026-09-29T07:00:00Z');

function windows(start = T0, count = 4): QrWindow[] {
  return Array.from({ length: count }, (_, i) => ({
    window: 100 + i,
    qr: `https://hr.example/punch#t${i}`,
    showFrom: new Date(start + i * 30_000).toISOString(),
    showUntil: new Date(start + (i + 1) * 30_000).toISOString(),
  }));
}

describe('kiosk clock', () => {
  it('measures the offset against the middle of the round trip', () => {
    // Device clock 5 s behind: sent at T0 − 5 s − 100 ms, received at T0 − 5 s + 100 ms, server said T0.
    expect(measureOffset(new Date(T0).toISOString(), T0 - 5_100, T0 - 4_900)).toBe(5_000);
    expect(measureOffset('not a date', 1, 2)).toBe(0);
  });

  it('shows the window that contains the corrected now, none outside the four', () => {
    const w = windows();
    expect(activeWindow(w, T0)?.window).toBe(100);
    expect(activeWindow(w, T0 + 29_999)?.window).toBe(100);
    expect(activeWindow(w, T0 + 30_000)?.window).toBe(101);
    expect(activeWindow(w, T0 + 119_999)?.window).toBe(103);
    expect(activeWindow(w, T0 + 120_000)).toBeNull();
    expect(activeWindow(w, T0 - 1)).toBeNull();
  });

  it('fetches again at the start of the next window plus a 1–3 s jitter', () => {
    expect(jitter(0)).toBe(1_000);
    expect(jitter(0.999)).toBe(2_998);
    expect(nextFetchDelay(windows(), T0 + 10_000, 1_500)).toBe(21_500);
    expect(nextFetchDelay(windows(), T0 + 200_000, 1_500)).toBe(0);
  });

  it('reports the share of the window still to run', () => {
    const w = windows()[0] as QrWindow;
    expect(remainingShare(w, T0)).toBe(1);
    expect(remainingShare(w, T0 + 15_000)).toBe(0.5);
    expect(remainingShare(w, T0 + 60_000)).toBe(0);
  });

  it('shows Algiers time (UTC+1) and reloads between 03:00 and 03:05 there', () => {
    expect(algiersClock(Date.parse('2026-09-29T06:59:58Z'))).toBe('07:59:58');
    expect(inReloadSlot(Date.parse('2026-09-29T02:00:00Z'))).toBe(true);
    expect(inReloadSlot(Date.parse('2026-09-29T02:04:59Z'))).toBe(true);
    expect(inReloadSlot(Date.parse('2026-09-29T02:05:00Z'))).toBe(false);
    expect(inReloadSlot(Date.parse('2026-09-29T01:59:59Z'))).toBe(false);
  });
});
