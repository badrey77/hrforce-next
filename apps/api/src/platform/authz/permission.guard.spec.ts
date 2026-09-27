import { ForbiddenException, Logger, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { currentContext, runWithContext } from '../context/request-context.js';
import { AnonymousIdentityResolver, RequestIdentityResolver, type RequestIdentity } from '../context/request-identity.js';
import { AllowWithoutMfa, Authenticated, Public, RequirePermission } from './decorators.js';
import { MfaRequirement, NoMfaRequirement } from './mfa-requirement.js';
import { PermissionCheck } from './permission-check.js';
import { DenyAllPermissionEvaluator, PermissionEvaluator } from './permission-evaluator.js';
import { PermissionGuard } from './permission.guard.js';

class Routes {
  @Public() open(): void {}
  @RequirePermission('employee.read') guarded(): void {}
  undecorated(): void {}
  @Public() @RequirePermission('employee.read') both(): void {}
  @Authenticated() signedIn(): void {}
  @Authenticated() @Public() authenticatedAndPublic(): void {}
  @Authenticated() @RequirePermission('employee.read') authenticatedAndPermission(): void {}
  @Authenticated() @AllowWithoutMfa() mfaExempt(): void {}
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

describe('@Authenticated()', () => {
  const reflector = new Reflector();
  beforeAll(() => Logger.overrideLogger(false));
  afterAll(() => Logger.overrideLogger(['log', 'error', 'warn']));

  it('guard: 401 when anonymous, allowed when authenticated', async () => {
    await expect(new PermissionGuard(reflector, new AnonymousIdentityResolver()).canActivate(contextFor('signedIn'))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(new PermissionGuard(reflector, new FixedIdentity()).canActivate(contextFor('signedIn'))).resolves.toBe(true);
  });

  it('check: no permission needed (even with a deny-all evaluator); 401 when anonymous', async () => {
    const check = new PermissionCheck(reflector, new DenyAllPermissionEvaluator(), new NoMfaRequirement());
    await expect(check.assertAllowed(contextFor('signedIn'), USER)).resolves.toBeUndefined();
    await expect(check.assertAllowed(contextFor('signedIn'), ANON)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('combined with @Public or @RequirePermission → misconfigured → 403', async () => {
    const guard = new PermissionGuard(reflector, new FixedIdentity());
    await expect(guard.canActivate(contextFor('authenticatedAndPublic'))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(guard.canActivate(contextFor('authenticatedAndPermission'))).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('PermissionCheck (permission decision)', () => {
  const reflector = new Reflector();

  it('denies by default (stub evaluator) and allows when the evaluator grants', async () => {
    await expect(new PermissionCheck(reflector, new DenyAllPermissionEvaluator(), new NoMfaRequirement()).assertAllowed(contextFor('guarded'), USER)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(new PermissionCheck(reflector, new AllowList(), new NoMfaRequirement()).assertAllowed(contextFor('guarded'), USER)).resolves.toBeUndefined();
  });

  it('fails closed on its own: misconfigured routes → 403, anonymous → 401, public → allowed', async () => {
    const check = new PermissionCheck(reflector, new AllowList(), new NoMfaRequirement());
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
    const check = new PermissionCheck(reflector, new Probe(), new NoMfaRequirement());
    await runWithContext({ requestId: 'req-in-ctx', userId: USER.userId, companyId: null, tx: null }, () =>
      check.assertAllowed(contextFor('guarded'), USER),
    );
    expect(seen).toHaveBeenCalledWith('req-in-ctx');
  });
});

describe('PermissionCheck (two-step sign-in enforcement)', () => {
  const reflector = new Reflector();
  class Required extends MfaRequirement {
    constructor(private readonly enabled: boolean) {
      super();
    }
    isRequired(): Promise<boolean> {
      return Promise.resolve(true);
    }
    isEnabled(): Promise<boolean> {
      return Promise.resolve(this.enabled);
    }
  }

  it('required and not enrolled → 403 mfa-enrollment-required everywhere except @AllowWithoutMfa and public routes', async () => {
    const check = new PermissionCheck(reflector, new AllowList(), new Required(false));
    await expect(check.assertAllowed(contextFor('guarded'), USER)).rejects.toMatchObject({ slug: 'mfa-enrollment-required', status: 403 });
    await expect(check.assertAllowed(contextFor('signedIn'), USER)).rejects.toMatchObject({ slug: 'mfa-enrollment-required' });
    await expect(check.assertAllowed(contextFor('mfaExempt'), USER)).resolves.toBeUndefined();
    await expect(check.assertAllowed(contextFor('open'), ANON)).resolves.toBeUndefined();
    await expect(check.assertAllowed(contextFor('mfaExempt'), ANON)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('required and enrolled → the normal decision', async () => {
    const check = new PermissionCheck(reflector, new AllowList(), new Required(true));
    await expect(check.assertAllowed(contextFor('guarded'), USER)).resolves.toBeUndefined();
    expect(check.isPublic(contextFor('open'))).toBe(true);
    expect(check.isPublic(contextFor('guarded'))).toBe(false);
  });
});
