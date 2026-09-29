/**
 * Login throttling math (docs/contracts/identity.md › Throttling), computed from `auth.login_event` timestamps.
 *  - e-mail: 5 failed attempts within 15 min → locked until 15 min after the 5th failure (423);
 *  - IP:    30 failed attempts within 15 min → 429 until the oldest of those 30 leaves the 15-min window.
 * The SQL side (auth.login_failures) returns e-mail failures of the last 30 min and IP failures of the last 15 min
 * (≤ 30), newest first — enough for these rules: a lock still running must end with a failure in the last 15 min,
 * and its window started at most 15 min before that.
 */
export const EMAIL_LOCK = { failures: 5, windowMs: 15 * 60_000, lockMs: 15 * 60_000 } as const;
export const IP_THROTTLE = { failures: 30, windowMs: 15 * 60_000 } as const;

/**
 * The instant the rules are evaluated at: the database clock, but never earlier than the newest failure it returned.
 * The database wall clock may step back a little (NTP or VM time sync — seen with Docker Desktop): a failure recorded
 * just before would then look a few milliseconds "in the future", be left out of the IP count (the 30th failure not
 * counted, no 429) and push a Retry-After past the lock length. Failures are facts; the clock only moves forward here.
 */
export function throttleNow(dbNow: Date, ...failures: readonly (readonly Date[])[]): Date {
  return new Date(Math.max(dbNow.getTime(), ...failures.flat().map((d) => d.getTime())));
}

/** When the e-mail lock ends, or null if the e-mail is not locked at `now`. */
export function emailLockedUntil(failures: readonly Date[], now: Date): Date | null {
  const times = failures.map((d) => d.getTime()).toSorted((a, b) => a - b);
  let until = -Infinity;
  for (let i = EMAIL_LOCK.failures - 1; i < times.length; i++) {
    const nth = times[i] as number;
    const first = times[i - (EMAIL_LOCK.failures - 1)] as number;
    if (nth - first < EMAIL_LOCK.windowMs) until = Math.max(until, nth + EMAIL_LOCK.lockMs);
  }
  return until > now.getTime() ? new Date(until) : null;
}

/** When the IP may try again, or null if the IP is not throttled at `now`. */
export function ipThrottledUntil(failures: readonly Date[], now: Date): Date | null {
  const recent = failures
    .map((d) => d.getTime())
    .filter((t) => t > now.getTime() - IP_THROTTLE.windowMs && t <= now.getTime())
    .toSorted((a, b) => b - a);
  if (recent.length < IP_THROTTLE.failures) return null;
  const oldestCounted = recent[IP_THROTTLE.failures - 1] as number;
  return new Date(oldestCounted + IP_THROTTLE.windowMs);
}

/** Retry-After value: whole seconds, rounded up, at least 1. */
export function retryAfterSeconds(until: Date, now: Date): number {
  return Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 1000));
}
