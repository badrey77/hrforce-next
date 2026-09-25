import type { Request } from 'express';
import { ACCESS_COOKIE, readCookie } from '../security/cookies.js';
import { verifyAccessToken } from '../security/jwt.js';
import { ANONYMOUS, RequestIdentityResolver, type RequestIdentity } from './request-identity.js';

/**
 * The real identity (docs/contracts/identity.md): a valid `hrf_at` access token (HS256, AUTH_ACCESS_SECRET) →
 * `{userId: sub, companyId: cid, sessionId: sid}`. Missing, malformed, tampered, wrong-alg or expired → anonymous
 * (the client then refreshes). Verified statelessly: no database access per request.
 * Built by identityResolverFactory (platform/authz/dev-auth.ts), not by DI.
 */
export class CookieIdentityResolver extends RequestIdentityResolver {
  constructor(private readonly accessSecret: string) {
    super();
  }

  resolve(req: Request): Promise<RequestIdentity> {
    const token = readCookie(req, ACCESS_COOKIE);
    const claims = token ? verifyAccessToken(this.accessSecret, token) : null;
    if (!claims) return Promise.resolve(ANONYMOUS);
    return Promise.resolve({ userId: claims.sub, companyId: claims.cid, sessionId: claims.sid });
  }
}

/** First resolver that yields a user wins (cookie before the DEV_AUTH headers). */
export class FirstMatchIdentityResolver extends RequestIdentityResolver {
  constructor(private readonly resolvers: readonly RequestIdentityResolver[]) {
    super();
  }

  async resolve(req: Request): Promise<RequestIdentity> {
    for (const resolver of this.resolvers) {
      const identity = await resolver.resolve(req);
      if (identity.userId) return identity;
    }
    return ANONYMOUS;
  }
}
