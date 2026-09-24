import { Controller, Delete, Get, Post } from '@nestjs/common';
import { RequirePermission } from '../../../platform/authz/index.js';

@Controller('org-units')
export class OrgController {
  @Get()
  @RequirePermission('org_unit.read')
  list(): string[] {
    return [];
  }

  // deliberately unguarded (fixture)
  @Delete(':id')
  remove(): void {}

  @Post()
  @RequirePermission('org_unit.create')
  create(): void {}
}
