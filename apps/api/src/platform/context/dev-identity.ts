import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { ANONYMOUS, RequestIdentityResolver, type RequestIdentity } from './request-identity.js';

export const DEV_USER_HEADER = 'x-dev-user-id';
export const DEV_COMPANY_HEADER = 'x-dev-company-id';

/** Any 8-4-4-4-12 hex UUID (version/variant are not checked: seeded ids are hand-written UUIDv7s). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' ? value.trim() : undefined;
}

/**
 * DEVELOPMENT ONLY (wired when DEV_AUTH=true, which the env schema refuses outside development/test).
 * The caller is whoever the `X-Dev-User-Id` / `X-Dev-Company-Id` headers say. Both must be UUIDs;
 * anything missing or malformed makes the request anonymous (→ 401 on protected routes).
 */
@Injectable()
export class DevHeaderIdentityResolver extends RequestIdentityResolver {
  resolve(req: Request): Promise<RequestIdentity> {
    const userId = header(req, DEV_USER_HEADER);
    const companyId = header(req, DEV_COMPANY_HEADER);
    if (!userId || !companyId || !UUID.test(userId) || !UUID.test(companyId)) return Promise.resolve(ANONYMOUS);
    return Promise.resolve({ userId: userId.toLowerCase(), companyId: companyId.toLowerCase() });
  }
}
