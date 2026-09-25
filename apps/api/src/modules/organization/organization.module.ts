import { Module } from '@nestjs/common';
import { OrgController } from './api/org.controller.js';
import { OrgActions } from './application/org-actions.js';
import { OrgClock } from './application/org-clock.js';
import { OrgUnitsService } from './application/org-units.service.js';
import { OrgUnitRepository } from './infra/org-unit.repository.js';

/** Organization: versioned org units (company → region → site) + closure table. */
@Module({
  controllers: [OrgController],
  providers: [OrgUnitsService, OrgUnitRepository, OrgActions, OrgClock],
  exports: [OrgUnitsService],
})
export class OrganizationModule {}
