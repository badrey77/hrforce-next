import { AuthorizationResponseError } from 'openid-client';
import { describe, expect, it } from 'vitest';
import { oauthErrorCode, withRetry } from './oidc.js';

describe('withRetry (discovery at boot)', () => {
  it('retries every 2 s until success', async () => {
    let t = 0;
    const sleeps: number[] = [];
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('ECONNREFUSED');
        return 'ok';
      },
      {
        now: () => t,
        sleep: async (ms) => {
          sleeps.push(ms);
          t += ms;
        },
      },
    );
    expect(result).toBe('ok');
    expect(sleeps).toEqual([2000, 2000]);
  });

  it('gives up after 60 s with the last error', async () => {
    let t = 0;
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error(`down ${calls}`);
        },
        {
          now: () => t,
          sleep: async (ms) => {
            t += ms;
          },
        },
      ),
    ).rejects.toThrow('down 31');
  });
});

describe('oauthErrorCode', () => {
  it('keeps the OAuth code of an authorization response error, and nothing else', () => {
    const error = new AuthorizationResponseError('x', { cause: new URLSearchParams('error=access_denied&error_description=%3Cb%3E') });
    expect(oauthErrorCode(error)).toBe('access_denied');
    expect(oauthErrorCode(new Error('https://x/?code=secret'))).toBe('invalid_response');
    expect(oauthErrorCode('boom')).toBe('invalid_response');
  });
});
