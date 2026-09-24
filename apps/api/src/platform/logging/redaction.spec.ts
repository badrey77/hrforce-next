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
