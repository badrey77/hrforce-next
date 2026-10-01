/**
 * Test double of HRForce's OpenID provider, just enough for openid-client: discovery, JWKS, token endpoint
 * (client_secret_basic, PKCE S256 check, single-use codes) and RS256 ID tokens. The authorization step itself (the
 * HRForce sign-in) is skipped: the test calls `issueCode` with what the demo sent to /oidc/auth.
 */
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';

interface CodeGrant {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  nonce: string;
  claims: Record<string, unknown>;
}

export interface FakeProvider {
  issuer: string;
  issueCode(grant: Omit<CodeGrant, 'clientId'>): string;
  tokenCalls: number;
  close(): Promise<void>;
}

const b64url = (value: Buffer | string) => Buffer.from(value).toString('base64url');

export async function startFakeProvider(client: { clientId: string; clientSecret: string }): Promise<FakeProvider> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'test-key';
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  const codes = new Map<string, CodeGrant>();
  const app = express();
  let issuer = '';
  const state = { tokenCalls: 0 };

  app.get('/oidc/.well-known/openid-configuration', (_req, res) => {
    res.json({
      issuer,
      authorization_endpoint: `${issuer}/auth`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      end_session_endpoint: `${issuer}/session/end`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic'],
      authorization_response_iss_parameter_supported: true,
    });
  });
  app.get('/oidc/jwks', (_req, res) => {
    res.json({ keys: [jwk] });
  });
  app.post('/oidc/token', express.urlencoded({ extended: false }), (req, res) => {
    state.tokenCalls += 1;
    const [scheme, value] = (req.headers.authorization ?? '').split(' ');
    const [id, secret] = Buffer.from(value ?? '', 'base64').toString('utf8').split(':').map((p) => decodeURIComponent(p.replace(/\+/g, ' ')));
    if (scheme !== 'Basic' || id !== client.clientId || secret !== client.clientSecret) {
      res.status(401).json({ error: 'invalid_client' });
      return;
    }
    const body = req.body as Record<string, string>;
    const grant = codes.get(body['code'] ?? '');
    codes.delete(body['code'] ?? '');
    const challenge = createHash('sha256').update(body['code_verifier'] ?? '').digest('base64url');
    if (!grant || body['grant_type'] !== 'authorization_code' || grant.redirectUri !== body['redirect_uri'] || grant.codeChallenge !== challenge) {
      res.status(400).json({ error: 'invalid_grant' });
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }));
    const payload = b64url(
      JSON.stringify({ iss: issuer, aud: grant.clientId, iat: now, exp: now + 300, auth_time: now, amr: ['pwd'], nonce: grant.nonce, ...grant.claims }),
    );
    const signature = sign('sha256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
    res.json({
      access_token: randomBytes(16).toString('base64url'),
      token_type: 'Bearer',
      expires_in: 300,
      id_token: `${header}.${payload}.${signature}`,
      scope: 'openid profile email hrforce',
    });
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}/oidc`;

  return {
    issuer,
    issueCode(grant) {
      const code = randomBytes(16).toString('base64url');
      codes.set(code, { ...grant, clientId: client.clientId });
      return code;
    },
    get tokenCalls() {
      return state.tokenCalls;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
