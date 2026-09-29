import { describe, expect, it } from 'vitest';
import { emailLockedUntil, ipThrottledUntil, retryAfterSeconds, throttleNow } from './throttle.js';

const T0 = Date.parse('2026-09-25T10:00:00Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

describe('e-mail lock (5 failures in 15 min → locked until 15 min after the 5th)', () => {
  it('4 failures: not locked', () => {
    expect(emailLockedUntil([at(0), at(1), at(2), at(3)], at(4))).toBeNull();
  });

  it('5 failures within 15 min: locked until the 5th + 15 min, then free', () => {
    const failures = [at(4), at(3), at(2), at(1), at(0)]; // newest first, as SQL returns them
    expect(emailLockedUntil(failures, at(4))).toEqual(at(19));
    expect(emailLockedUntil(failures, at(18.99))).toEqual(at(19));
    expect(emailLockedUntil(failures, at(19))).toBeNull();
  });

  it('5 failures spread over more than 15 min: not locked', () => {
    expect(emailLockedUntil([at(0), at(4), at(8), at(12), at(16)], at(16))).toBeNull();
  });

  it('a later qualifying run extends the lock', () => {
    const failures = [at(0), at(1), at(2), at(3), at(4), at(10)];
    expect(emailLockedUntil(failures, at(11))).toEqual(at(25));
  });
});

describe('IP throttle (30 failures in 15 min → 429 until the oldest of them leaves the window)', () => {
  const thirty = Array.from({ length: 30 }, (_, i) => at(i * 0.25)); // 0 … 7.25 min

  it('29 failures: allowed; 30: throttled', () => {
    expect(ipThrottledUntil(thirty.slice(1), at(8))).toBeNull();
    expect(ipThrottledUntil(thirty, at(8))).toEqual(at(15));
    expect(ipThrottledUntil(thirty, at(15))).toBeNull();
  });

  it('ignores failures outside the window', () => {
    expect(ipThrottledUntil([...thirty.slice(1), at(-20)], at(8))).toBeNull();
  });
});

describe('throttleNow (the database clock may step back)', () => {
  const thirty = Array.from({ length: 30 }, (_, i) => at(i * 0.25));

  it('is the database clock when every failure is older', () => {
    expect(throttleNow(at(8), thirty, [at(1)])).toEqual(at(8));
    expect(throttleNow(at(8))).toEqual(at(8));
  });

  it('never goes before the newest failure: a 30th failure 5 ms "in the future" still counts, Retry-After stays ≤ the lock', () => {
    const newest = thirty[29] as Date;
    const stepBack = new Date(newest.getTime() - 5);
    expect(ipThrottledUntil(thirty, stepBack)).toBeNull(); // the raw clock would miss it
    const now = throttleNow(stepBack, [], thirty);
    expect(now).toEqual(newest);
    expect(ipThrottledUntil(thirty, now)).toEqual(at(15));
    const five = [at(4), at(3), at(2), at(1), at(0)];
    const lockNow = throttleNow(new Date(at(4).getTime() - 5), five, []);
    expect(retryAfterSeconds(emailLockedUntil(five, lockNow) as Date, lockNow)).toBe(900);
  });
});

describe('Retry-After', () => {
  it('rounds up to whole seconds, at least 1', () => {
    expect(retryAfterSeconds(at(15), at(0))).toBe(900);
    expect(retryAfterSeconds(new Date(T0 + 1500), at(0))).toBe(2);
    expect(retryAfterSeconds(at(0), at(0))).toBe(1);
  });
});
