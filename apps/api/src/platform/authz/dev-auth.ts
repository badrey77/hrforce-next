import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.schema.js';
import { CookieIdentityResolver, FirstMatchIdentityResolver } from '../context/cookie-identity.js';
import { DevHeaderIdentityResolver } from '../context/dev-identity.js';
import type { RequestIdentityResolver } from '../context/request-identity.js';
import { DevAllowAllPermissionEvaluator } from './dev-permission-evaluator.js';
import { DenyAllPermissionEvaluator, type PermissionEvaluator } from './permission-evaluator.js';

/**
 * Default identity seam: the access-token cookie (CookieIdentityResolver). With DEV_AUTH=true (development/test
 * only) the X-Dev-* header identity is also accepted, but a valid cookie wins when both are present.
 */
export function identityResolverFactory(env: Env): RequestIdentityResolver {
  const cookie = new CookieIdentityResolver(env.AUTH_ACCESS_SECRET);
  return env.DEV_AUTH ? new FirstMatchIdentityResolver([cookie, new DevHeaderIdentityResolver()]) : cookie;
}

/**
 * Default permission seam: deny all; with DEV_PERMISSIONS=allow_all (development/test only) every AUTHENTICATED
 * caller holds every permission (anonymous callers are still 401). The Authorization module replaces this.
 */
export function permissionEvaluatorFactory(env: Env): PermissionEvaluator {
  return env.DEV_PERMISSIONS === 'allow_all' ? new DevAllowAllPermissionEvaluator() : new DenyAllPermissionEvaluator();
}

/** Logs a loud warning at boot when a development-only switch is active. */
@Injectable()
export class DevAuthWarning implements OnApplicationBootstrap {
  private readonly logger = new Logger('DevAuth');

  constructor(@Inject(ENV) private readonly env: Env) {}

  onApplicationBootstrap(): void {
    if (this.env.DEV_AUTH) {
      this.logger.warn(
        '!!! DEV_AUTH=true — INSECURE DEVELOPMENT IDENTITY: X-Dev-User-Id / X-Dev-Company-Id headers are trusted. ' +
          'Never enable this outside local development/tests. !!!',
      );
    }
    if (this.env.DEV_PERMISSIONS === 'allow_all') {
      this.logger.warn('!!! DEV_PERMISSIONS=allow_all — every authenticated caller holds EVERY permission. Development/tests only. !!!');
    }
  }
}
