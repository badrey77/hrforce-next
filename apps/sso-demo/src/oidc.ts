/**
 * The relying-party side of the HRForce sign-in, with `openid-client` 6 (ADR 007, docs/contracts/sso.md):
 * authorization code + PKCE (S256) + state + nonce, client authentication `client_secret_basic`, RP-initiated logout.
 * The library does every protocol check (state, nonce, `iss` of the response, ID-token signature, audience, expiry).
 */
import * as client from 'openid-client';
import type { DemoEnv } from './env.js';

export const SCOPE = 'openid profile email hrforce';

export interface SignInRequest {
  url: URL;
  codeVerifier: string;
  state: string;
  nonce: string;
}

export interface SignInResult {
  claims: Record<string, unknown>;
  idToken: string;
}

/** The three operations the web routes need (a seam for tests). */
export interface RelyingParty {
  startSignIn(lang: string): Promise<SignInRequest>;
  /** `currentUrl` is the callback URL as received (built on SSO_DEMO_BASE_URL, never on the Host header). */
  finishSignIn(currentUrl: URL, checks: { codeVerifier: string; state: string; nonce: string }): Promise<SignInResult>;
  endSessionUrl(idToken: string): URL;
}

export function redirectUri(env: Pick<DemoEnv, 'baseUrl'>): string {
  return `${env.baseUrl}/callback`;
}

export function postLogoutRedirectUri(env: Pick<DemoEnv, 'baseUrl'>): string {
  return `${env.baseUrl}/signed-out`;
}

export function createRelyingParty(config: client.Configuration, env: Pick<DemoEnv, 'baseUrl'>): RelyingParty {
  return {
    async startSignIn(lang) {
      const codeVerifier = client.randomPKCECodeVerifier();
      const state = client.randomState();
      const nonce = client.randomNonce();
      const url = client.buildAuthorizationUrl(config, {
        redirect_uri: redirectUri(env),
        scope: SCOPE,
        code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
        code_challenge_method: 'S256',
        state,
        nonce,
        ui_locales: lang,
      });
      return { url, codeVerifier, state, nonce };
    },
    async finishSignIn(currentUrl, checks) {
      const tokens = await client.authorizationCodeGrant(config, currentUrl, {
        pkceCodeVerifier: checks.codeVerifier,
        expectedState: checks.state,
        expectedNonce: checks.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      if (!claims || !tokens.id_token) throw new client.ClientError('ID token missing');
      return { claims: { ...claims }, idToken: tokens.id_token };
    },
    endSessionUrl(idToken) {
      return client.buildEndSessionUrl(config, { id_token_hint: idToken, post_logout_redirect_uri: postLogoutRedirectUri(env) });
    },
  };
}

/** OpenID discovery of the HRForce issuer. `http://` issuers (development only, checked by env.ts) allow insecure requests. */
export function discover(env: Pick<DemoEnv, 'issuer' | 'clientId' | 'clientSecret'>): Promise<client.Configuration> {
  const issuer = new URL(env.issuer);
  return client.discovery(issuer, env.clientId, undefined, client.ClientSecretBasic(env.clientSecret), {
    execute: issuer.protocol === 'http:' ? [client.allowInsecureRequests] : [],
  });
}

export interface RetryOptions {
  intervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, error: unknown) => void;
}

/** Runs `attempt` until it succeeds, every `intervalMs` (2 s) for `timeoutMs` (60 s); then rethrows the last error. */
export async function withRetry<T>(attempt: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { intervalMs = 2000, timeoutMs = 60_000, now = Date.now, onRetry } = options;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + timeoutMs;
  for (let n = 1; ; n += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (now() + intervalMs > deadline) throw error;
      onRetry?.(n, error);
      await sleep(intervalMs);
    }
  }
}

/** A short, log-safe code for an error from the sign-in (never a description, a token or a URL). */
export function oauthErrorCode(error: unknown): string {
  const candidate =
    error instanceof client.AuthorizationResponseError || error instanceof client.ResponseBodyError ? error.error : undefined;
  return typeof candidate === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(candidate) ? candidate : 'invalid_response';
}
