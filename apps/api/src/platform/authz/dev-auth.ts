import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.schema.js';
import { AnonymousIdentityResolver, type RequestIdentityResolver } from '../context/request-identity.js';
import { DevHeaderIdentityResolver } from '../context/dev-identity.js';
import { DevAllowAllPermissionEvaluator } from './dev-permission-evaluator.js';
import { DenyAllPermissionEvaluator, type PermissionEvaluator } from './permission-evaluator.js';

/** Default identity seam: anonymous, or the dev header identity when DEV_AUTH=true. */
export function identityResolverFactory(env: Env): RequestIdentityResolver {
  return env.DEV_AUTH ? new DevHeaderIdentityResolver() : new AnonymousIdentityResolver();
}

/** Default permission seam: deny all, or allow all when DEV_AUTH=true. */
export function permissionEvaluatorFactory(env: Env): PermissionEvaluator {
  return env.DEV_AUTH ? new DevAllowAllPermissionEvaluator() : new DenyAllPermissionEvaluator();
}

/** Logs a loud warning at boot when the development identity is active. */
@Injectable()
export class DevAuthWarning implements OnApplicationBootstrap {
  private readonly logger = new Logger('DevAuth');

  constructor(@Inject(ENV) private readonly env: Env) {}

  onApplicationBootstrap(): void {
    if (!this.env.DEV_AUTH) return;
    this.logger.warn(
      '!!! DEV_AUTH=true — INSECURE DEVELOPMENT IDENTITY: X-Dev-User-Id / X-Dev-Company-Id headers are trusted and ' +
        'EVERY permission is granted. Never enable this outside local development/tests. !!!',
    );
  }
}
