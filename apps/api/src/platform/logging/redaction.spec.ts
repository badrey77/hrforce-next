import { Writable } from 'node:stream';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { REDACT_CENSOR, REDACT_PATHS } from './redaction.js';

describe('log redaction', () => {
  it('censors credentials, cookies and secret-like fields', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const logger = pino({ redact: { paths: [...REDACT_PATHS], censor: REDACT_CENSOR } }, sink);
    logger.info({
      req: { headers: { authorization: 'Bearer abc', cookie: 'sid=abc', accept: 'json' } },
      res: { headers: { 'set-cookie': 'sid=abc' } },
      user: { password: 'p', passwordHash: 'h', token: 't', refreshToken: 'r', secret: 's', name: 'Amina' },
    });
    const entry = JSON.parse(lines[0] ?? '{}') as Record<string, Record<string, Record<string, unknown>>>;
    expect(entry['req']?.['headers']).toEqual({ authorization: REDACT_CENSOR, cookie: REDACT_CENSOR, accept: 'json' });
    expect(entry['res']?.['headers']?.['set-cookie']).toBe(REDACT_CENSOR);
    expect(entry['user']).toEqual({
      password: REDACT_CENSOR,
      passwordHash: REDACT_CENSOR,
      token: REDACT_CENSOR,
      refreshToken: REDACT_CENSOR,
      secret: REDACT_CENSOR,
      name: 'Amina',
    });
  });
});

describe('log redaction (identity)', () => {
  it('censors passwords/tokens in request bodies and the hrf_* / XSRF cookies', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    const logger = pino({ redact: { paths: [...REDACT_PATHS], censor: REDACT_CENSOR } }, sink);
    logger.info({
      req: {
        body: { email: 'a@b.dz', password: 'hunter2-hunter2' },
        cookies: { hrf_at: 'jwt', hrf_rt: 'rt', 'XSRF-TOKEN': 'x' },
        headers: { cookie: 'hrf_at=jwt; hrf_rt=rt', 'x-xsrf-token': 'x' },
      },
      res: { headers: { 'set-cookie': ['hrf_at=jwt; Path=/api', 'hrf_rt=rt; Path=/api/auth'] } },
      setup: { body: { token: 'setup-token', password: 'pw' } },
      jar: { hrf_at: 'jwt', hrf_rt: 'rt', 'XSRF-TOKEN': 'x' },
    });
    const line = lines[0] ?? '';
    for (const leaked of ['hunter2', 'jwt', '"rt"', 'setup-token', 'hrf_rt=rt']) expect(line).not.toContain(leaked);
    const entry = JSON.parse(line) as Record<string, Record<string, Record<string, unknown>>>;
    expect(entry['req']?.['body']).toEqual({ email: 'a@b.dz', password: REDACT_CENSOR });
    expect(entry['req']?.['cookies']).toBe(REDACT_CENSOR);
    expect(entry['jar']).toEqual({ hrf_at: REDACT_CENSOR, hrf_rt: REDACT_CENSOR, 'XSRF-TOKEN': REDACT_CENSOR });
  });
});
