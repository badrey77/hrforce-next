import { Injectable } from '@nestjs/common';
import { PermissionEvaluator } from './permission-evaluator.js';

/** DEVELOPMENT ONLY (wired when DEV_PERMISSIONS=allow_all): every authenticated caller holds every permission. */
@Injectable()
export class DevAllowAllPermissionEvaluator extends PermissionEvaluator {
  hasPermission(): Promise<boolean> {
    return Promise.resolve(true);
  }
}
