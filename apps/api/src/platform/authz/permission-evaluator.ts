import { Injectable } from '@nestjs/common';
import type { RequestIdentity } from '../context/request-identity.js';

/**
 * Seam for authorization: decides whether an authenticated identity holds a permission.
 * The Authorization module overrides this provider; the default denies everything.
 *
 * It is always called INSIDE the request transaction (see PermissionCheck / RequestContextInterceptor), so a
 * DB-backed implementation reads grants with `currentTx()` under the caller's tenant (`app.company_id`) and RLS.
 */
export abstract class PermissionEvaluator {
  abstract hasPermission(identity: RequestIdentity, permission: string): Promise<boolean>;
}

@Injectable()
export class DenyAllPermissionEvaluator extends PermissionEvaluator {
  hasPermission(): Promise<boolean> {
    return Promise.resolve(false);
  }
}
