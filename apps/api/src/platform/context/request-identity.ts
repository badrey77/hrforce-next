import { Injectable } from '@nestjs/common';
import type { Request } from 'express';

/** Who is calling and on behalf of which tenant. Both null = anonymous. */
export interface RequestIdentity {
  readonly userId: string | null;
  readonly companyId: string | null;
  /** Refresh session id (`sid`) when the identity comes from the access-token cookie; absent otherwise. */
  readonly sessionId?: string | null;
  /** Expiry of the credential behind the identity (seconds since epoch; access-token `exp`); absent = none known. */
  readonly expiresAt?: number | null;
}

export const ANONYMOUS: RequestIdentity = Object.freeze({ userId: null, companyId: null });

/**
 * Seam for authentication: resolves the caller of a request. Default: {@link CookieIdentityResolver}
 * (access-token cookie), plus the DEV_AUTH header identity in development/test (see platform/authz/dev-auth.ts).
 */
export abstract class RequestIdentityResolver {
  abstract resolve(req: Request): Promise<RequestIdentity>;
}

@Injectable()
export class AnonymousIdentityResolver extends RequestIdentityResolver {
  resolve(): Promise<RequestIdentity> {
    return Promise.resolve(ANONYMOUS);
  }
}

const cache = new WeakMap<Request, Promise<RequestIdentity>>();

/** Resolves the identity at most once per request (the guard and the interceptor both need it). */
export function identityOf(resolver: RequestIdentityResolver, req: Request): Promise<RequestIdentity> {
  let identity = cache.get(req);
  if (!identity) {
    identity = resolver.resolve(req);
    cache.set(req, identity);
  }
  return identity;
}
