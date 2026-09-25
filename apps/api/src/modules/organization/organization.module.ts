import { Module } from '@nestjs/common';
import { OrgController } from './api/org.controller.js';
import { OrgActions } from './application/org-actions.js';
import { OrgClock } from './application/org-clock.js';
import { OrgUnitsService } from './application/org-units.service.js';
import { SitesService } from './application/sites.service.js';
import { OrgKindRepository } from './infra/org-kind.repository.js';
import { OrgUnitRepository } from './infra/org-unit.repository.js';
import { SiteRepository } from './infra/site.repository.js';

/** Organization (v2): one management tree of versioned units (kinds from a catalogue) + closure table; sites. */
@Module({
  controllers: [OrgController],
  providers: [OrgUnitsService, SitesService, OrgUnitRepository, OrgKindRepository, SiteRepository, OrgActions, OrgClock],
  exports: [OrgUnitsService, SitesService],
})
export class OrganizationModule {}
