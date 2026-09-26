import { Body, Controller, Get, NotFoundException, Param, Put } from '@nestjs/common';
import { z } from 'zod';
import { Authenticated, RequirePermission } from '../../../platform/authz/decorators.js';
import { createZodDto } from '../../../platform/http/zod-validation.pipe.js';
import { isIsoDate } from '../../organization/index.js';
import { StaffingService, type MyEmploymentView, type UnitHeadsView, type UserEmploymentView } from '../application/staffing.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = z
  .string()
  .regex(UUID, { message: 'Must be a UUID' })
  .transform((v) => v.toLowerCase());
const isoDate = z.string().refine(isIsoDate, { message: 'Must be a date written YYYY-MM-DD' });

export class SetUserEmploymentDto extends createZodDto(z.object({ employmentId: uuid.nullable() })) {}

export class SetUnitHeadDto extends createZodDto(z.object({ employmentId: uuid.nullable(), validFrom: isoDate.optional() })) {}

function idParam(id: string, what: string): string {
  if (!UUID.test(id)) throw new NotFoundException(`${what} not found`);
  return id.toLowerCase();
}

/**
 * Links added to M1 data (docs/contracts/leave.md): the caller's linked employment (self-service), a user's linked
 * employee (Access → user detail) and the head of a unit (Organization → unit detail).
 */
@Controller()
export class StaffingController {
  constructor(private readonly staffing: StaffingService) {}

  @Get('me/employment')
  @Authenticated()
  myEmployment(): Promise<MyEmploymentView> {
    return this.staffing.myEmployment();
  }

  @Put('access/users/:id/employment')
  @RequirePermission('access.grant')
  setUserEmployment(@Param('id') id: string, @Body() body: SetUserEmploymentDto): Promise<UserEmploymentView> {
    return this.staffing.setUserEmployment(idParam(id, 'User'), body.employmentId);
  }

  @Put('org/units/:id/head')
  @RequirePermission('org_unit.update')
  setUnitHead(@Param('id') id: string, @Body() body: SetUnitHeadDto): Promise<UnitHeadsView> {
    return this.staffing.setUnitHead(idParam(id, 'Org unit'), body.employmentId, body.validFrom);
  }
}
