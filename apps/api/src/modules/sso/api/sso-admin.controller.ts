import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { RequirePermission } from '../../../platform/authz/decorators.js';
import { SsoAdminService } from '../application/sso-admin.service.js';
import type { SsoAppRoleView, SsoAssignmentView, SsoClientCreatedView, SsoClientView } from '../application/sso-views.js';
import { isUuid } from '../domain/validation.js';

function idParam(id: string, what: string): string {
  if (!isUuid(id)) throw new NotFoundException(`${what} not found`);
  return id.toLowerCase();
}

/**
 * Connected apps (docs/contracts/sso.md › Administration): apps, their show-once secrets, their roles and the role
 * assignments. Bodies are validated by the domain (contract codes); writes need the permission over the whole company
 * (checked by the service).
 */
@Controller('sso')
export class SsoAdminController {
  constructor(private readonly admin: SsoAdminService) {}

  @Get('clients')
  @RequirePermission('sso.read')
  list(): Promise<{ items: SsoClientView[] }> {
    return this.admin.list();
  }

  @Get('clients/:id')
  @RequirePermission('sso.read')
  detail(@Param('id') id: string): Promise<SsoClientView> {
    return this.admin.detail(idParam(id, 'App'));
  }

  @Post('clients')
  @RequirePermission('sso.manage_apps')
  create(@Body() body: unknown): Promise<SsoClientCreatedView> {
    return this.admin.create(body);
  }

  @Patch('clients/:id')
  @RequirePermission('sso.manage_apps')
  update(@Param('id') id: string, @Body() body: unknown): Promise<SsoClientView> {
    return this.admin.update(idParam(id, 'App'), body);
  }

  @Post('clients/:id/rotate-secret')
  @RequirePermission('sso.manage_apps')
  @HttpCode(200)
  rotateSecret(@Param('id') id: string): Promise<SsoClientCreatedView> {
    return this.admin.rotateSecret(idParam(id, 'App'));
  }

  @Post('clients/:id/disable')
  @RequirePermission('sso.manage_apps')
  @HttpCode(200)
  disable(@Param('id') id: string, @Body() body: unknown): Promise<SsoClientView> {
    return this.admin.disable(idParam(id, 'App'), body);
  }

  @Post('clients/:id/enable')
  @RequirePermission('sso.manage_apps')
  @HttpCode(200)
  enable(@Param('id') id: string): Promise<SsoClientView> {
    return this.admin.enable(idParam(id, 'App'));
  }

  @Post('clients/:id/roles')
  @RequirePermission('sso.manage_apps')
  createRole(@Param('id') id: string, @Body() body: unknown): Promise<SsoAppRoleView> {
    return this.admin.createRole(idParam(id, 'App'), body);
  }

  @Patch('roles/:roleId')
  @RequirePermission('sso.manage_apps')
  updateRole(@Param('roleId') roleId: string, @Body() body: unknown): Promise<SsoAppRoleView> {
    return this.admin.updateRole(idParam(roleId, 'App role'), body);
  }

  @Delete('roles/:roleId')
  @RequirePermission('sso.manage_apps')
  @HttpCode(204)
  deleteRole(@Param('roleId') roleId: string): Promise<void> {
    return this.admin.deleteRole(idParam(roleId, 'App role'));
  }

  @Get('assignments')
  @RequirePermission('sso.read')
  assignments(@Query() query: unknown): Promise<{ items: SsoAssignmentView[] }> {
    return this.admin.assignments(query);
  }

  @Post('assignments')
  @RequirePermission('sso.assign')
  assign(@Body() body: unknown): Promise<SsoAssignmentView> {
    return this.admin.assign(body);
  }

  @Delete('assignments/:id')
  @RequirePermission('sso.assign')
  @HttpCode(204)
  unassign(@Param('id') id: string): Promise<void> {
    return this.admin.unassign(idParam(id, 'Assignment'));
  }
}
