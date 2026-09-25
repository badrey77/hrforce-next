import { Body, Controller, Get, NotFoundException, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { RequirePermission } from '../../../platform/authz/decorators.js';
import { ProblemException } from '../../../platform/http/problem-details.js';
import { OrgUnitsService } from '../application/org-units.service.js';
import type { OrgKindsView, OrgTreeView, OrgUnitDetail, OrgUnitSearchView, Site, SitesView } from '../application/org-views.js';
import { SitesService } from '../application/sites.service.js';
import { OrgRuleViolation } from '../domain/org-unit.js';
import {
  ChangeOrgUnitDto,
  CreateOrgUnitDto,
  CreateSiteDto,
  isUuid,
  OrgTreeQueryDto,
  OrgUnitSearchQueryDto,
  SiteSearchQueryDto,
} from './org.dto.js';

/** Domain rule violations → 409 problem+json with `errors[]` on the offending body field. */
async function problems<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof OrgRuleViolation) {
      const errors = error.field ? [{ field: error.field, code: error.code, message: error.message }] : undefined;
      throw new ProblemException(409, error.slug, error.message, errors);
    }
    throw error;
  }
}

/** A malformed id cannot exist: 404 like any unknown / other-tenant id (not 422). */
function unitIdParam(id: string): string {
  if (!isUuid(id)) throw new NotFoundException('Org unit not found');
  return id.toLowerCase();
}

/** Organization endpoints — docs/contracts/organization.md (v2). */
@Controller('org')
export class OrgController {
  constructor(
    private readonly units: OrgUnitsService,
    private readonly sites: SitesService,
  ) {}

  @Get('kinds')
  @RequirePermission('org_unit.read')
  kinds(): Promise<OrgKindsView> {
    return this.units.listKinds();
  }

  @Get('tree')
  @RequirePermission('org_unit.read')
  tree(@Query() query: OrgTreeQueryDto): Promise<OrgTreeView> {
    return this.units.getTree(query.asOf);
  }

  @Get('units')
  @RequirePermission('org_unit.read')
  search(@Query() query: OrgUnitSearchQueryDto): Promise<OrgUnitSearchView> {
    return this.units.searchUnits(query);
  }

  @Get('units/:id')
  @RequirePermission('org_unit.read')
  get(@Param('id') id: string): Promise<OrgUnitDetail> {
    return this.units.getUnit(unitIdParam(id));
  }

  @Post('units')
  @RequirePermission('org_unit.create')
  async create(@Body() body: CreateOrgUnitDto, @Res({ passthrough: true }) res: Response): Promise<OrgUnitDetail> {
    const detail = await problems(() => this.units.createUnit(body));
    res.location(`/api/org/units/${detail.id}`);
    return detail;
  }

  @Patch('units/:id')
  @RequirePermission('org_unit.update')
  change(@Param('id') id: string, @Body() body: ChangeOrgUnitDto): Promise<OrgUnitDetail> {
    return problems(() => this.units.changeUnit(unitIdParam(id), body));
  }

  @Get('sites')
  @RequirePermission('site.read')
  listSites(@Query() query: SiteSearchQueryDto): Promise<SitesView> {
    return this.sites.list(query.q);
  }

  @Post('sites')
  @RequirePermission('site.create')
  createSite(@Body() body: CreateSiteDto): Promise<Site> {
    return problems(() => this.sites.create(body));
  }
}
