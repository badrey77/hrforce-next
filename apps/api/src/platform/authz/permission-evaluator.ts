import { Injectable } from '@nestjs/common';
import type { RequestIdentity } from '../context/request-identity.js';

/**
 * Seam for authorization: decides whether an authenticated identity holds a permission.
 * The Authorization module overrides this provider; the default denies everything.
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
