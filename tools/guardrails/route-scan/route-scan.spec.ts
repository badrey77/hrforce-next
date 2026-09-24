import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../lib/report.ts';
import { scanRoutes, scanSource } from './route-scan.ts';

const HEADER = `
import { Controller, Get, Post, Delete as Del } from '@nestjs/common';
import { Public, RequirePermission } from '../../platform/authz/decorators.js';
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
}`);
    const messages = violations.map((v) => v.message);
    expect(messages).toEqual([
      expect.stringMatching(/XController\.a: invalid permission code "Employee\.Read"/),
      expect.stringMatching(/XController\.b: invalid permission code "employee"/),
      expect.stringMatching(/XController\.c: .*must be a string literal/),
      expect.stringMatching(/XController\.d: both @Public\(\) and @RequirePermission\(\)/),
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
