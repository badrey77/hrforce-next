import { ForbiddenException, Logger, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnonymousIdentityResolver, RequestIdentityResolver, type RequestIdentity } from '../context/request-identity.js';
import { Public, RequirePermission } from './decorators.js';
import { DenyAllPermissionEvaluator, PermissionEvaluator } from './permission-evaluator.js';
import { PermissionGuard } from './permission.guard.js';

class Routes {
  @Public() open(): void {}
  @RequirePermission('employee.read') guarded(): void {}
  undecorated(): void {}
}

function contextFor(handler: keyof Routes): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => Routes.prototype[handler],
    getClass: () => Routes,
    switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }),
  } as unknown as ExecutionContext;
}

class FixedIdentity extends RequestIdentityResolver {
  resolve(): Promise<RequestIdentity> {
    return Promise.resolve({ userId: '018f0000-0000-7000-8000-000000000001', companyId: null });
  }
}

class AllowList extends PermissionEvaluator {
  hasPermission(_identity: RequestIdentity, permission: string): Promise<boolean> {
    return Promise.resolve(permission === 'employee.read');
  }
}

describe('PermissionGuard', () => {
  const reflector = new Reflector();
  beforeAll(() => Logger.overrideLogger(false));
  afterAll(() => Logger.overrideLogger(['log', 'error', 'warn']));

  it('allows @Public() routes', async () => {
    const guard = new PermissionGuard(reflector, new AnonymousIdentityResolver(), new DenyAllPermissionEvaluator());
    await expect(guard.canActivate(contextFor('open'))).resolves.toBe(true);
  });

  it('denies routes without any access decorator', async () => {
    const guard = new PermissionGuard(reflector, new FixedIdentity(), new AllowList());
    await expect(guard.canActivate(contextFor('undecorated'))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns 401 for anonymous callers of protected routes', async () => {
    const guard = new PermissionGuard(reflector, new AnonymousIdentityResolver(), new AllowList());
    await expect(guard.canActivate(contextFor('guarded'))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('denies by default (stub evaluator) and allows when the evaluator grants', async () => {
    const denied = new PermissionGuard(reflector, new FixedIdentity(), new DenyAllPermissionEvaluator());
    await expect(denied.canActivate(contextFor('guarded'))).rejects.toBeInstanceOf(ForbiddenException);
    const allowed = new PermissionGuard(reflector, new FixedIdentity(), new AllowList());
    await expect(allowed.canActivate(contextFor('guarded'))).resolves.toBe(true);
  });

  it('rejects malformed permission codes at decoration time', () => {
    expect(() => RequirePermission('Employee.Read')).toThrowError(/Invalid permission code/);
    expect(() => RequirePermission('employee')).toThrowError(/Invalid permission code/);
  });
});
