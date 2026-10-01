import { createServer } from 'node:net';

/**
 * A scripted browser for the SSO e2e tests (docs/contracts/sso.md › Test scenarios): real HTTP against the API on an
 * ephemeral port, redirect: manual, and a cookie jar that honours Path (one cookie per name AND path: each
 * interaction has its own `hrf_op_interaction` path) and deletions (Max-Age=0 / an expiry in the past).
 */

interface Cookie {
  name: string;
  value: string;
  path: string;
}

function defaultPath(url: URL): string {
  const i = url.pathname.lastIndexOf('/');
  return i <= 0 ? '/' : url.pathname.slice(0, i);
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath.charAt(cookiePath.length) === '/';
}

export class OidcJar {
  readonly cookies = new Map<string, Cookie>();

  store(setCookies: string[], url: URL): void {
    for (const line of setCookies) {
      const [pair = '', ...attrs] = line.split(';').map((p) => p.trim());
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      const lower = attrs.map((a) => a.toLowerCase());
      const path = attrs.find((a) => a.toLowerCase().startsWith('path='))?.slice(5) || defaultPath(url);
      const expires = attrs.find((a) => a.toLowerCase().startsWith('expires='))?.slice(8);
      const deleted = lower.includes('max-age=0') || (expires !== undefined && Date.parse(expires) < Date.now()) || value === '';
      const key = `${name}|${path}`;
      if (deleted) this.cookies.delete(key);
      else this.cookies.set(key, { name, value, path });
    }
  }

  header(url: URL): string {
    return [...this.cookies.values()]
      .filter((c) => pathMatches(url.pathname, c.path))
      .toSorted((a, b) => b.path.length - a.path.length)
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }

  get(name: string, path?: string): string | undefined {
    for (const c of this.cookies.values()) if (c.name === name && (path === undefined || c.path === path)) return c.value;
    return undefined;
  }

  find(name: string): Cookie[] {
    return [...this.cookies.values()].filter((c) => c.name === name);
  }

  delete(name: string): void {
    for (const [key, c] of this.cookies) if (c.name === name) this.cookies.delete(key);
  }

  copyFrom(other: OidcJar, names?: readonly string[]): void {
    for (const [key, c] of other.cookies) if (!names || names.includes(c.name)) this.cookies.set(key, { ...c });
  }
}

export interface Hop {
  status: number;
  url: string;
}

export class OidcBrowser {
  readonly jar = new OidcJar();

  constructor(
    readonly base: string,
    readonly headers: Record<string, string> = {},
  ) {}

  async go(url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}): Promise<Response> {
    const target = new URL(url, this.base);
    const cookie = this.jar.header(target);
    const res = await fetch(target, {
      method: init.method ?? 'GET',
      redirect: 'manual',
      headers: { ...this.headers, ...init.headers, ...(cookie ? { cookie } : {}) },
      ...(init.body !== undefined ? { body: init.body } : {}),
    });
    this.jar.store(res.headers.getSetCookie(), target);
    return res;
  }

  /** Follows redirects; stops (without fetching) at a URL starting with one of `stopAt`. */
  async follow(url: string, stopAt: readonly string[], init: { method?: string; body?: string; headers?: Record<string, string> } = {}): Promise<{ res: Response | null; url: string; hops: Hop[] }> {
    const hops: Hop[] = [];
    let current = new URL(url, this.base).href;
    let res = await this.go(current, init);
    hops.push({ status: res.status, url: current });
    for (let i = 0; i < 10 && res.status >= 300 && res.status < 400; i++) {
      current = new URL(res.headers.get('location') ?? '', current).href;
      if (stopAt.some((s) => current.startsWith(s))) return { res: null, url: current, hops };
      res = await this.go(current);
      hops.push({ status: res.status, url: current });
    }
    return { res, url: current, hops };
  }

  /** A same-origin XHR to the API with the XSRF header (the web's interceptor). */
  api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const xsrf = this.jar.get('XSRF-TOKEN');
    return this.go(path, {
      method,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(xsrf && method !== 'GET' ? { 'x-xsrf-token': xsrf } : {}), ...headers },
    });
  }

  async login(email: string, password: string): Promise<Response> {
    await this.api('GET', '/api/auth/csrf');
    return this.api('POST', '/api/auth/login', { email, password });
  }
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}
