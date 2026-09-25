import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { PERMISSION_KEY, PUBLIC_KEY } from './decorators.js';

/** The access policy declared on a route: public, a permission code, or misconfigured (neither / both). */
export type AccessPolicy = { kind: 'public' } | { kind: 'permission'; permission: string } | { kind: 'invalid'; reason: string };

export function accessPolicyOf(reflector: Reflector, context: ExecutionContext): AccessPolicy {
  const targets = [context.getHandler(), context.getClass()];
  const isPublic = reflector.getAllAndOverride<boolean | undefined>(PUBLIC_KEY, targets) === true;
  const permission = reflector.getAllAndOverride<string | undefined>(PERMISSION_KEY, targets);
  if (isPublic && permission !== undefined) return { kind: 'invalid', reason: 'route has both @Public and @RequirePermission' };
  if (isPublic) return { kind: 'public' };
  if (permission !== undefined) return { kind: 'permission', permission };
  return { kind: 'invalid', reason: 'route has no access policy; denied' };
}
