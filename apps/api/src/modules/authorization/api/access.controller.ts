import { Body, Controller, Get, HttpCode, NotFoundException, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { RequirePermission } from '../../../platform/authz/decorators.js';
import { ProblemException } from '../../../platform/http/problem-details.js';
import type { AccessUserView, GrantView, ItemsView, PermissionView, RoleView } from '../application/access-views.js';
import { GrantsService } from '../application/grants.service.js';
import { RolesService } from '../application/roles.service.js';
import { AccessRuleViolation } from '../domain/access-rules.js';
import { CreateGrantDto, CreateRoleDto, EndGrantDto, GrantsQueryDto, isUuid, UpdateRoleDto, UsersQueryDto } from './access.dto.js';

/** Rule violations → 409 problem+json with `errors[]` on the offending body field. */
async function problems<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AccessRuleViolation) {
      const errors = error.field ? [{ field: error.field, code: error.code, message: error.message }] : undefined;
      throw new ProblemException(409, error.slug, error.message, errors);
    }
    throw error;
  }
}

/** A malformed id cannot exist: 404 like any unknown / other-tenant / out-of-scope id. */
function idParam(id: string, what: string): string {
  if (!isUuid(id)) throw new NotFoundException(`${what} not found`);
  return id.toLowerCase();
}

/** Access administration — docs/contracts/authorization.md › New endpoints. */
@Controller('access')
export class AccessController {
  constructor(
    private readonly roles: RolesService,
    private readonly grants: GrantsService,
  ) {}

  @Get('permissions')
  @RequirePermission('access.read')
  permissions(): Promise<ItemsView<PermissionView>> {
    return this.roles.listPermissions();
  }

  @Get('roles')
  @RequirePermission('access.read')
  listRoles(): Promise<ItemsView<RoleView>> {
    return this.roles.listRoles();
  }

  @Post('roles')
  @RequirePermission('access.manage_roles')
  async createRole(@Body() body: CreateRoleDto, @Res({ passthrough: true }) res: Response): Promise<RoleView> {
    const role = await problems(() => this.roles.createRole(body));
    res.location(`/api/access/roles/${role.id}`);
    return role;
  }

  @Patch('roles/:id')
  @RequirePermission('access.manage_roles')
  updateRole(@Param('id') id: string, @Body() body: UpdateRoleDto): Promise<RoleView> {
    return problems(() => this.roles.updateRole(idParam(id, 'Role'), body));
  }

  @Get('users')
  @RequirePermission('access.read')
  users(@Query() query: UsersQueryDto): Promise<ItemsView<AccessUserView>> {
    return this.grants.listUsers(query.q);
  }

  @Get('grants')
  @RequirePermission('access.read')
  listGrants(@Query() query: GrantsQueryDto): Promise<ItemsView<GrantView>> {
    return this.grants.listGrants(query);
  }

  @Post('grants')
  @RequirePermission('access.grant')
  createGrant(@Body() body: CreateGrantDto): Promise<GrantView> {
    return problems(() => this.grants.createGrant(body));
  }

  @Post('grants/:id/end')
  @HttpCode(200)
  @RequirePermission('access.grant')
  endGrant(@Param('id') id: string, @Body() body: EndGrantDto): Promise<GrantView> {
    return problems(() => this.grants.endGrant(idParam(id, 'Grant'), body.validTo));
  }
}
