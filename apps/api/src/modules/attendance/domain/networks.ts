/**
 * A kiosk's optional allowed networks (docs/contracts/attendance.md › Kiosk credential, ADR 009 §1): IPv4 / IPv6
 * CIDR blocks (a bare address = one host). Host bits must be zero, as in Postgres' `cidr` type. Pure functions.
 */

export const MAX_ALLOWED_NETWORKS = 10;

interface Parsed {
  bytes: number[];
  family: 4 | 6;
}

function parseIpv4(text: string): number[] | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || (p.length > 1 && p.startsWith('0'))) return null;
    const n = Number(p);
    if (n > 255) return null;
    bytes.push(n);
  }
  return bytes;
}

const groupsOf = (s: string) => (s === '' ? [] : s.split(':'));

function parseIpv6(text: string): number[] | null {
  if (!/^[0-9a-fA-F:.]+$/.test(text)) return null;
  let tail: number[] = [];
  let body = text;
  if (text.includes('.')) {
    // an embedded IPv4 tail (e.g. ::ffff:192.0.2.1) stands for the last two groups
    const i = text.lastIndexOf(':');
    const v4 = parseIpv4(text.slice(i + 1));
    if (!v4) return null;
    tail = v4;
    body = text.slice(0, i + 1);
    if (!body.endsWith('::')) body = body.slice(0, -1);
  }
  const need = tail.length ? 6 : 8;
  const halves = body.split('::');
  if (halves.length > 2) return null;
  let groups: string[];
  if (halves.length === 1) {
    groups = groupsOf(halves[0] ?? '');
    if (groups.length !== need) return null;
  } else {
    const a = groupsOf(halves[0] ?? '');
    const b = groupsOf(halves[1] ?? '');
    if (a.length + b.length > need - 1) return null;
    groups = [...a, ...Array.from({ length: need - a.length - b.length }, () => '0'), ...b];
  }
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push(n >> 8, n & 255);
  }
  return [...bytes, ...tail];
}

function parseAddress(text: string): Parsed | null {
  const v4 = parseIpv4(text);
  if (v4) return { bytes: v4, family: 4 };
  const v6 = text.includes(':') ? parseIpv6(text) : null;
  if (!v6 || v6.length !== 16) return null;
  // IPv4-mapped IPv6 (::ffff:a.b.c.d): the IPv4 address
  if (v6.slice(0, 10).every((b) => b === 0) && v6[10] === 255 && v6[11] === 255) return { bytes: v6.slice(12), family: 4 };
  return { bytes: v6, family: 6 };
}

export interface Network {
  bytes: number[];
  prefix: number;
  family: 4 | 6;
}

function formatIpv6(bytes: number[]): string {
  const groups = Array.from({ length: 8 }, (_, i) => (((bytes[i * 2] ?? 0) << 8) | (bytes[i * 2 + 1] ?? 0)).toString(16));
  // longest run of zero groups (length ≥ 2) → ::
  let best = { start: -1, len: 0 };
  for (let i = 0; i < 8; ) {
    if (groups[i] !== '0') {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === '0') j++;
    if (j - i > best.len) best = { start: i, len: j - i };
    i = j;
  }
  if (best.len < 2) return groups.join(':');
  return `${groups.slice(0, best.start).join(':')}::${groups.slice(best.start + best.len).join(':')}`;
}

/** Canonical text, as Postgres' `cidr` prints it (e.g. "41.100.1.0/24", "2001:db8::/32"). */
export function formatNetwork(n: Network): string {
  return `${n.family === 4 ? n.bytes.join('.') : formatIpv6(n.bytes)}/${n.prefix}`;
}

/** "a.b.c.d", "a.b.c.d/n", "x::y/n" → the network; null when malformed or host bits are set. */
export function parseNetwork(text: string): Network | null {
  const trimmed = text.trim();
  const slash = trimmed.indexOf('/');
  const address = parseAddress(slash < 0 ? trimmed : trimmed.slice(0, slash));
  if (!address) return null;
  // a mapped address given with an IPv6 prefix is ambiguous: refuse it
  if (address.family === 4 && trimmed.includes(':') && slash >= 0) return null;
  const max = address.family === 4 ? 32 : 128;
  let prefix = max;
  if (slash >= 0) {
    const p = trimmed.slice(slash + 1);
    if (!/^\d{1,3}$/.test(p)) return null;
    prefix = Number(p);
    if (prefix > max) return null;
  }
  for (let bit = prefix; bit < max; bit++) {
    if (((address.bytes[bit >> 3] ?? 0) >> (7 - (bit & 7))) & 1) return null;
  }
  return { bytes: address.bytes, prefix, family: address.family };
}

/** True when `ip` (the client address; IPv4-mapped IPv6 accepted) lies inside one of `networks` (canonical texts). */
export function addressAllowed(ip: string | null | undefined, networks: readonly string[]): boolean {
  if (networks.length === 0) return true;
  const address = ip ? parseAddress(ip) : null;
  if (!address) return false;
  return networks.some((text) => {
    const n = parseNetwork(text);
    if (!n || n.family !== address.family) return false;
    for (let bit = 0; bit < n.prefix; bit++) {
      const a = ((address.bytes[bit >> 3] ?? 0) >> (7 - (bit & 7))) & 1;
      const b = ((n.bytes[bit >> 3] ?? 0) >> (7 - (bit & 7))) & 1;
      if (a !== b) return false;
    }
    return true;
  });
}
