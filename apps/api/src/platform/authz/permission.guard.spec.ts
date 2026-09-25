import { ForbiddenException, Logger, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { currentContext, runWithContext } from '../context/request-context.js';
import { AnonymousIdentityResolver, RequestIdentityResolver, type RequestIdentity } from '../context/request-identity.js';
import { Public, RequirePermission } from './decorators.js';
import { PermissionCheck } from './permission-check.js';
import { DenyAllPermissionEvaluator, PermissionEvaluator } from './permission-evaluator.js';
import { PermissionGuard } from './permission.guard.js';

class Routes {
  @Public() open(): void {}
  @RequirePermission('employee.read') guarded(): void {}
  undecorated(): void {}
  @Public() @RequirePermission('employee.read') both(): void {}
}

function contextFor(handler: keyof Routes): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => Routes.prototype[handler],
    getClass: () => Routes,
    switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }),
  } as unknown as ExecutionContext;
}

const USER: RequestIdentity = { userId: '018f0000-0000-7000-8000-000000000001', companyId: null };
const ANON: RequestIdentity = { userId: null, companyId: null };

class FixedIdentity extends RequestIdentityResolver {
  resolve(): Promise<RequestIdentity> {
    return Promise.resolve(USER);
  }
}

class AllowList extends PermissionEvaluator {
  hasPermission(_identity: RequestIdentity, permission: string): Promise<boolean> {
    return Promise.resolve(permission === 'employee.read');
  }
}

describe('PermissionGuard (decorator presence + authentication)', () => {
  const reflector = new Reflector();
  beforeAll(() => Logger.overrideLogger(false));
  afterAll(() => Logger.overrideLogger(['log', 'error', 'warn']));

  it('allows @Public() routes', async () => {
    const guard = new PermissionGuard(reflector, new AnonymousIdentityResolver());
    await expect(guard.canActivate(contextFor('open'))).resolves.toBe(true);
  });

  it('denies routes without any access decorator, or with both', async () => {
    const guard = new PermissionGuard(reflector, new FixedIdentity());
    await expect(guard.canActivate(contextFor('undecorated'))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(guard.canActivate(contextFor('both'))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns 401 for anonymous callers of protected routes', async () => {
    const guard = new PermissionGuard(reflector, new AnonymousIdentityResolver());
    await expect(guard.canActivate(contextFor('guarded'))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('lets authenticated callers through to the in-transaction permission check', async () => {
    const guard = new PermissionGuard(reflector, new FixedIdentity());
    await expect(guard.canActivate(contextFor('guarded'))).resolves.toBe(true);
  });

  it('rejects malformed permission codes at decoration time', () => {
    expect(() => RequirePermission('Employee.Read')).toThrowError(/Invalid permission code/);
    expect(() => RequirePermission('employee')).toThrowError(/Invalid permission code/);
  });
});

describe('PermissionCheck (permission decision)', () => {
  const reflector = new Reflector();

  it('denies by default (stub evaluator) and allows when the evaluator grants', async () => {
    await expect(new PermissionCheck(reflector, new DenyAllPermissionEvaluator()).assertAllowed(contextFor('guarded'), USER)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(new PermissionCheck(reflector, new AllowList()).assertAllowed(contextFor('guarded'), USER)).resolves.toBeUndefined();
  });

  it('fails closed on its own: misconfigured routes → 403, anonymous → 401, public → allowed', async () => {
    const check = new PermissionCheck(reflector, new AllowList());
    await expect(check.assertAllowed(contextFor('undecorated'), USER)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(check.assertAllowed(contextFor('guarded'), ANON)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(check.assertAllowed(contextFor('open'), ANON)).resolves.toBeUndefined();
  });

  it('calls the evaluator inside the caller’s RequestContext', async () => {
    const seen = vi.fn();
    class Probe extends PermissionEvaluator {
      hasPermission(): Promise<boolean> {
        seen(currentContext()?.requestId);
        return Promise.resolve(true);
      }
    }
    const check = new PermissionCheck(reflector, new Probe());
    await runWithContext({ requestId: 'req-in-ctx', userId: USER.userId, companyId: null, tx: null }, () =>
      check.assertAllowed(contextFor('guarded'), USER),
    );
    expect(seen).toHaveBeenCalledWith('req-in-ctx');
  });
});
