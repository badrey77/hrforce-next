import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../lib/report.ts';
import { checkMfaExemptions, scanRoutes, scanSource } from './route-scan.ts';

const HEADER = `
import { Controller, Get, Post, Delete as Del } from '@nestjs/common';
import { Authenticated, Public, RequirePermission } from '../../platform/authz/decorators.js';
`;

function scan(body: string) {
  return scanSource('fixture.controller.ts', HEADER + body);
}

describe('route-scan', () => {
  it('flags a handler without @RequirePermission/@Public with file:line', () => {
    const { violations, routes } = scan(`
@Controller('employees')
export class EmployeesController {
  @Get()
  list() { return []; }
}`);
    expect(violations).toEqual([
      expect.objectContaining({ file: 'fixture.controller.ts', line: 8, rule: 'route-scan', message: expect.stringMatching(/EmployeesController\.list has no @RequirePermission/) }),
    ]);
    expect(routes).toEqual([expect.objectContaining({ method: 'GET', path: '/api/employees', access: 'UNGUARDED' })]);
  });

  it('accepts method-level and class-level decorators, method overriding class', () => {
    const { violations, routes } = scan(`
@Controller('employees')
@RequirePermission('employee.read')
export class EmployeesController {
  @Get(':id') one() {}
  @Post() @RequirePermission('employee.create') create() {}
  @Get('public/info') @Public() info() {}
  helper() {}
}
@Public()
@Controller({ path: 'auth' })
export class AuthController {
  @Post('login') login() {}
}`);
    expect(violations).toEqual([]);
    expect(routes.map((r) => `${r.method} ${r.path} ${r.access}`).toSorted()).toEqual([
      'GET /api/employees/:id employee.read',
      'GET /api/employees/public/info public',
      'POST /api/auth/login public',
      'POST /api/employees employee.create',
    ]);
  });

  it('accepts @Authenticated() (signed-in caller, no permission) and rejects it combined with another policy', () => {
    const { violations, routes } = scan(`
@Controller('me')
export class MeController {
  @Get() @Authenticated() me() {}
  @Get('x') @Authenticated() @Public() x() {}
  @Get('y') @Authenticated() @RequirePermission('employee.read') y() {}
}
@Authenticated()
@Controller('profile')
export class ProfileController {
  @Get() get() {}
  @Post() @RequirePermission('profile.update') update() {}
}`);
    expect(violations.map((v) => v.message)).toEqual([
      expect.stringMatching(/MeController\.x: @Authenticated\(\) combined with/),
      expect.stringMatching(/MeController\.y: @Authenticated\(\) combined with/),
    ]);
    expect(routes.map((r) => `${r.method} ${r.path} ${r.access}`)).toEqual([
      'GET /api/me authenticated',
      'GET /api/me/x public',
      'GET /api/me/y authenticated',
      'GET /api/profile authenticated',
      'POST /api/profile profile.update',
    ]);
  });

  it('resolves aliased imports (Delete as Del) and ignores non-controller classes', () => {
    const { violations } = scan(`
@Controller('x')
export class XController { @Del(':id') remove() {} }
export class NotAController { @Get() handler() {} }`);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/XController\.remove/);
  });

  it('rejects malformed and non-literal permission codes, and conflicting decorators', () => {
    const { violations } = scan(`
const CODE = 'employee.read';
@Controller('x')
export class XController {
  @Get('a') @RequirePermission('Employee.Read') a() {}
  @Get('b') @RequirePermission('employee') b() {}
  @Get('c') @RequirePermission(CODE) c() {}
  @Get('d') @Public() @RequirePermission('employee.read') d() {}
  @Get('e') @RequirePermission('employee.salary.update') e() {}
  @Get('f') @RequirePermission('employee.salary.update.more') f() {}
}`);
    const messages = violations.map((v) => v.message);
    expect(messages).toEqual([
      expect.stringMatching(/XController\.a: invalid permission code "Employee\.Read"/),
      expect.stringMatching(/XController\.b: invalid permission code "employee"/),
      expect.stringMatching(/XController\.c: .*must be a string literal/),
      expect.stringMatching(/XController\.d: both @Public\(\) and @RequirePermission\(\)/),
      expect.stringMatching(/XController\.f: invalid permission code "employee\.salary\.update\.more"/),
    ]);
  });

  it('scans a directory, skipping *.spec.ts, and builds the route table', () => {
    const result = scanRoutes(path.join(import.meta.dirname, '__fixtures__'), 'src');
    expect(result.violations).toEqual([
      expect.objectContaining({ file: 'src/modules/org/api/org.controller.ts', line: 14, message: expect.stringMatching(/OrgController\.remove/) }),
    ]);
    expect(result.routes.map((r) => `${r.method} ${r.path} ${r.access}`)).toEqual([
      'GET /api/org-units org_unit.read',
      'POST /api/org-units org_unit.create',
      'DELETE /api/org-units/:id UNGUARDED',
    ]);
    expect(result.info).toMatch(/METHOD\s+PATH\s+ACCESS/);
  });

  it("would flag the API's deliberately undecorated test route — which is why test/ is not scanned", () => {
    const result = scanRoutes(REPO_ROOT, 'apps/api/test');
    expect(result.violations.map((v) => v.message)).toEqual([expect.stringMatching(/TestRoutesController\.undecorated/)]);
  });
});

describe('route-scan: @AllowWithoutMfa', () => {
  const MFA_HEADER = `
import { Controller, Get, Post } from '@nestjs/common';
import { AllowWithoutMfa, Authenticated, Public, RequirePermission } from '../../platform/authz/decorators.js';
`;
  it('marks the routes (method or class) and refuses it on public / permission routes', () => {
    const { violations, routes } = scanSource(
      'fixture.controller.ts',
      `${MFA_HEADER}
@Controller('me/mfa')
@Authenticated()
@AllowWithoutMfa()
export class MfaController {
  @Get() status() {}
}
@Controller('x')
export class XController {
  @Get('a') @Authenticated() @AllowWithoutMfa() a() {}
  @Get('b') @Authenticated() b() {}
  @Get('c') @Public() @AllowWithoutMfa() c() {}
  @Post('d') @RequirePermission('employee.read') @AllowWithoutMfa() d() {}
}`,
    );
    expect(routes.map((r) => `${r.method} ${r.path} ${r.allowWithoutMfa}`)).toEqual([
      'GET /api/me/mfa true',
      'GET /api/x/a true',
      'GET /api/x/b false',
      'GET /api/x/c true',
      'POST /api/x/d true',
    ]);
    expect(violations.map((v) => v.message)).toEqual([
      expect.stringMatching(/XController\.c: @AllowWithoutMfa\(\) only applies to @Authenticated\(\) routes \(access is public\)/),
      expect.stringMatching(/XController\.d: @AllowWithoutMfa\(\) only applies to @Authenticated\(\) routes \(access is employee\.read\)/),
    ]);
  });

  it('every exempt route must be listed in mfa-exempt.json; stale or malformed entries fail', () => {
    const route = { method: 'GET', path: '/api/me', access: 'authenticated', allowWithoutMfa: true, controller: 'C', handler: 'h', file: 'f.ts', line: 3 };
    const other = { ...route, path: '/api/x', allowWithoutMfa: false };
    expect(checkMfaExemptions([route, other], [{ route: 'GET /api/me', reason: 'bootstrap' }])).toEqual([]);
    expect(checkMfaExemptions([route], []).map((v) => v.message)).toEqual([expect.stringMatching(/GET \/api\/me carries @AllowWithoutMfa\(\) but is not listed/)]);
    expect(checkMfaExemptions([other], [{ route: 'GET /api/x', reason: 'r' }]).map((v) => v.message)).toEqual([expect.stringMatching(/stale entry "GET \/api\/x"/)]);
    expect(checkMfaExemptions([], [{ route: 'GET /api/me' }]).map((v) => v.message)).toEqual([expect.stringMatching(/entry 0 must be/)]);
    expect(checkMfaExemptions([], {}).length).toBe(1);
  });

  it('the repository: exactly the contract’s exceptions carry it, and they are listed', () => {
    const result = scanRoutes();
    expect(result.violations).toEqual([]);
    expect(result.routes.filter((r) => r.allowWithoutMfa).map((r) => `${r.method} ${r.path}`).toSorted()).toEqual([
      'GET /api/branding/logos/:kind/:digest', // docs/contracts/branding.md: the shell's logos on the enrolment page
      'GET /api/me',
      'GET /api/me/mfa',
      'GET /api/me/notifications/unread-count',
      'POST /api/me/mfa/disable',
      'POST /api/me/mfa/enroll/confirm',
      'POST /api/me/mfa/enroll/start',
      'POST /api/me/mfa/recovery-codes',
    ]);
  });
});
