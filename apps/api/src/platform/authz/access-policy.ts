import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { AUTHENTICATED_KEY, PERMISSION_KEY, PUBLIC_KEY } from './decorators.js';

/** The access policy declared on a route: public, authenticated, a permission code, or misconfigured. */
export type AccessPolicy =
  | { kind: 'public' }
  | { kind: 'authenticated' }
  | { kind: 'permission'; permission: string }
  | { kind: 'invalid'; reason: string };

/** Nest metadata targets: the route handler or its controller class. */
type Target = ReturnType<ExecutionContext['getHandler']> | ReturnType<ExecutionContext['getClass']>;

function declaredOn(reflector: Reflector, target: Target): AccessPolicy | undefined {
  const isPublic = reflector.get<boolean | undefined>(PUBLIC_KEY, target) === true;
  const isAuthenticated = reflector.get<boolean | undefined>(AUTHENTICATED_KEY, target) === true;
  const permission = reflector.get<string | undefined>(PERMISSION_KEY, target);
  const count = [isPublic, isAuthenticated, permission !== undefined].filter(Boolean).length;
  if (count > 1) return { kind: 'invalid', reason: 'route has more than one of @Public, @Authenticated and @RequirePermission' };
  if (isPublic) return { kind: 'public' };
  if (isAuthenticated) return { kind: 'authenticated' };
  if (permission !== undefined) return { kind: 'permission', permission };
  return undefined;
}

/**
 * The handler's own declaration wins; otherwise the controller's (same rule as the route-scan guardrail).
 * Several declarations on the same target, or none at all, is a misconfiguration (denied).
 */
export function accessPolicyOf(reflector: Reflector, context: ExecutionContext): AccessPolicy {
  return (
    declaredOn(reflector, context.getHandler()) ??
    declaredOn(reflector, context.getClass()) ?? { kind: 'invalid', reason: 'route has no access policy; denied' }
  );
}
