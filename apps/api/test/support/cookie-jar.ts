import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { setCookieHeaders } from './xsrf.js';

export interface StoredCookie {
  value: string;
  path: string;
  attributes: string[];
}

/** A minimal browser cookie jar: honours Path and Max-Age=0 (deletion); ignores Secure/SameSite (tests are same-site). */
export class CookieJar {
  readonly cookies = new Map<string, StoredCookie>();

  store(res: { headers: Record<string, unknown> }): void {
    for (const line of setCookieHeaders(res)) {
      const [pair = '', ...attributes] = line.split(';').map((p) => p.trim());
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      const path = attributes.find((a) => a.startsWith('Path='))?.slice(5) ?? '/';
      if (attributes.includes('Max-Age=0')) this.cookies.delete(name);
      else this.cookies.set(name, { value, path, attributes });
    }
  }

  get(name: string): string | undefined {
    return this.cookies.get(name)?.value;
  }

  set(name: string, value: string, path = '/'): void {
    this.cookies.set(name, { value, path, attributes: [] });
  }

  header(url: string): string {
    const path = url.split('?')[0] ?? url;
    return [...this.cookies.entries()]
      .filter(([, c]) => path === c.path || path.startsWith(c.path.endsWith('/') ? c.path : `${c.path}/`))
      .map(([name, c]) => `${name}=${c.value}`)
      .join('; ');
  }

  clone(): CookieJar {
    const copy = new CookieJar();
    for (const [name, c] of this.cookies) copy.cookies.set(name, { ...c, attributes: [...c.attributes] });
    return copy;
  }
}

/** A "browser": sends the jar's cookies (and the XSRF header on unsafe methods) and stores Set-Cookie responses. */
export class Browser {
  constructor(
    readonly app: NestExpressApplication,
    readonly jar = new CookieJar(),
    /** sent on every request (e.g. X-Forwarded-For to give each browser its own client IP) */
    readonly defaultHeaders: Record<string, string> = {},
  ) {}

  /** A second tab of the same browser: same cookies (copied now), same headers. */
  tab(): Browser {
    return new Browser(this.app, this.jar.clone(), this.defaultHeaders);
  }

  private async send(method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, body?: object, headers: Record<string, string> = {}) {
    let test = request(this.app.getHttpServer())[method](url);
    const cookie = this.jar.header(url);
    if (cookie) test = test.set('Cookie', cookie);
    const xsrf = this.jar.get('XSRF-TOKEN');
    if (method !== 'get' && xsrf) test = test.set('X-XSRF-TOKEN', xsrf);
    for (const [k, v] of Object.entries({ ...this.defaultHeaders, ...headers })) test = test.set(k, v);
    if (body !== undefined) test = test.send(body);
    const res = await test;
    this.jar.store(res);
    return res;
  }

  get(url: string, headers?: Record<string, string>) {
    return this.send('get', url, undefined, headers);
  }

  post(url: string, body?: object, headers?: Record<string, string>) {
    return this.send('post', url, body, headers);
  }

  put(url: string, body?: object, headers?: Record<string, string>) {
    return this.send('put', url, body, headers);
  }

  /** GET /api/auth/csrf then POST /api/auth/login. */
  async login(email: string, password: string) {
    await this.get('/api/auth/csrf');
    return this.post('/api/auth/login', { email, password });
  }
}
