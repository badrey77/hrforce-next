import { Injectable } from '@nestjs/common';
import type { Request } from 'express';

/** Who is calling and on behalf of which tenant. Both null = anonymous. */
export interface RequestIdentity {
  readonly userId: string | null;
  readonly companyId: string | null;
}

export const ANONYMOUS: RequestIdentity = Object.freeze({ userId: null, companyId: null });

/**
 * Seam for authentication: resolves the caller of a request. The Identity module will provide the real
 * implementation (session cookie → user/company) by overriding this provider; until then every request
 * is anonymous.
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
