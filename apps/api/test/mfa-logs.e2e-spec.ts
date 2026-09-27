/**
 * Two-step sign-in (docs/contracts/mfa.md › log redaction): no TOTP secret, otpauth URI, QR image, code, recovery code
 * or pending hrf_mfa token reaches the logs, at LOG_LEVEL=trace. Its own file: the app must be the first of the process
 * (nestjs-pino keeps process-wide state).
 */
import fs from 'node:fs';
import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { base32Decode, DEMO_PASSWORD, hotp, MfaClock, totpStep } from '../src/modules/identity/index.js';
import { seedAccessFixture, USERS } from './support/access-fixture.js';
import { Browser } from './support/cookie-jar.js';
import { createTestApp, RecordingMailSender } from './support/test-app.js';
import { createTestDatabase, type TestDatabase } from './support/test-database.js';

const randomIp = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
const clock = { now: Date.now() };
const secrets = new Map<string, Buffer>();
const code = (userId: string) => {
  clock.now += 30_000;
  return hotp(secrets.get(userId) ?? Buffer.alloc(0), totpStep(clock.now));
};

describe('Two-step sign-in: logs (e2e)', () => {
  let db: TestDatabase;
  const mails = new RecordingMailSender();
  beforeAll(async () => {
    db = await createTestDatabase();
    await seedAccessFixture(db);
  });
  afterAll(async () => {
    await db?.drop();
  });

    it('no TOTP secret, code, recovery code or pending token reaches the logs (LOG_LEVEL=trace)', async () => {
      const lines: string[] = [];
      const capture = (fd: unknown, data: unknown) => {
        if (fd === 1 || fd === 2) lines.push(Buffer.isBuffer(data) ? data.toString() : String(data));
      };
      // pino writes through sonic-boom (fs.write / fs.writeSync on fd 1): capture stdout/stderr, pass everything else on
      const originalWriteSync = fs.writeSync;
      const originalWrite = fs.write;
      const writeSync = vi.spyOn(fs, 'writeSync').mockImplementation(((fd: number, data: string | Buffer, ...rest: unknown[]) => {
        if (fd !== 1 && fd !== 2) return (originalWriteSync as (...a: unknown[]) => number)(fd, data, ...rest);
        capture(fd, data);
        return typeof data === 'string' ? Buffer.byteLength(data) : data.length;
      }) as typeof fs.writeSync);
      const write = vi.spyOn(fs, 'write').mockImplementation(((fd: number, data: string | Buffer, ...rest: unknown[]) => {
        if (fd !== 1 && fd !== 2) return (originalWrite as (...a: unknown[]) => void)(fd, data, ...rest);
        capture(fd, data);
        const cb = rest.find((r) => typeof r === 'function') as ((e: null, n: number) => void) | undefined;
        cb?.(null, typeof data === 'string' ? Buffer.byteLength(data) : data.length);
      }) as unknown as typeof fs.write);
      const verbose = await createTestApp(db, {
        devAuth: true,
        devPermissions: false,
        mailSender: mails,
        env: { LOG_LEVEL: 'trace', TRUST_PROXY_HOPS: '1' },
        overrides: [{ provide: MfaClock, useValue: { nowMs: () => clock.now } }],
      });
      try {
        const b = new Browser(verbose, undefined, { 'X-Forwarded-For': randomIp() });
        await b.login(USERS.newbie.email, DEMO_PASSWORD);
        const start = await b.post('/api/me/mfa/enroll/start');
        const secret = start.body.secret as string;
        secrets.set(USERS.newbie.id, base32Decode(secret) ?? Buffer.alloc(0));
        const confirmCode = code(USERS.newbie.id);
        await b.post('/api/me/mfa/enroll/confirm', { code: '000000' });
        const codes = (await b.post('/api/me/mfa/enroll/confirm', { code: confirmCode })).body.recoveryCodes as string[];
        const login = new Browser(verbose, undefined, { 'X-Forwarded-For': randomIp() });
        await login.login(USERS.newbie.email, DEMO_PASSWORD);
        const pending = login.jar.get('hrf_mfa') ?? '';
        await login.post('/api/auth/mfa/verify', { code: '111111' });
        await login.post('/api/auth/mfa/verify', { recoveryCode: codes[0] ?? '' });
        const all = lines.join('\n');
        expect(all.length).toBeGreaterThan(0); // the capture works
        expect(all).toContain('/api/auth/mfa/verify');
        for (const leaked of [secret, confirmCode, '111111', (codes[0] ?? '').replace('-', ''), codes[0] ?? '', pending, 'otpauth://', 'data:image/png']) {
          expect(leaked.length).toBeGreaterThan(0);
          expect(all, leaked).not.toContain(leaked);
        }
      } finally {
        writeSync.mockRestore();
        write.mockRestore();
        await verbose.close();
      }
    });
});
