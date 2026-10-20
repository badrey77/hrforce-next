import { Body, Controller, Get, NotFoundException, Param, Patch, Post, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Authenticated, RequirePermission } from '../../../platform/authz/decorators.js';
import type { ContractDecisionView, ContractListView, ContractView } from '../application/contract-views.js';
import { ContractsService } from '../application/contracts.service.js';
import { DecisionsService } from '../application/decisions.service.js';
import { CreateContractDto, PatchContractDto, ProposalDto } from './contracts.dto.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A malformed id cannot exist: 404 like any unknown / other-tenant / out-of-scope id. */
function id(value: string, what = 'Employee'): string {
  if (!UUID.test(value)) throw new NotFoundException(`${what} not found`);
  return value.toLowerCase();
}

/** Contracts of an employment — docs/contracts/contracts-deadlines.md › Contracts (`:id` = employment id). */
@Controller('employees/:id/contracts')
export class ContractsController {
  constructor(
    private readonly contracts: ContractsService,
    private readonly decisions: DecisionsService,
  ) {}

  @Get()
  @RequirePermission('employee.read')
  list(@Param('id') employmentId: string): Promise<ContractListView> {
    return this.contracts.list(id(employmentId));
  }

  @Post()
  @RequirePermission('employee.contract.manage')
  async create(@Param('id') employmentId: string, @Body() body: CreateContractDto, @Res({ passthrough: true }) res: Response): Promise<ContractView> {
    const view = await this.contracts.create(id(employmentId), body);
    res.location(`/api/employees/${employmentId}/contracts/${view.id}`);
    return view;
  }

  @Patch(':contractId')
  @RequirePermission('employee.contract.manage')
  patch(@Param('id') employmentId: string, @Param('contractId') contractId: string, @Body() body: PatchContractDto): Promise<ContractView> {
    return this.contracts.patch(id(employmentId), id(contractId, 'Contract'), body);
  }

  @Post(':contractId/decision')
  @RequirePermission('employee.contract.manage')
  async openDecision(@Param('id') employmentId: string, @Param('contractId') contractId: string, @Res({ passthrough: true }) res: Response): Promise<ContractDecisionView> {
    const view = await this.decisions.open(id(employmentId), id(contractId, 'Contract'));
    res.location(`/api/contract-decisions/${view.id}`);
    return view;
  }
}

/**
 * Contract decisions — the step's assignee (a unit head holds no permission for it: the engine's candidate rule
 * decides, else employee.read over the employee for reading) → @Authenticated, checked in the service.
 */
@Controller('contract-decisions')
export class ContractDecisionsController {
  constructor(private readonly decisions: DecisionsService) {}

  @Get(':id')
  @Authenticated()
  get(@Param('id') decisionId: string): Promise<ContractDecisionView> {
    return this.decisions.get(id(decisionId, 'Decision'));
  }

  @Put(':id/proposal')
  @Authenticated()
  propose(@Param('id') decisionId: string, @Body() body: ProposalDto): Promise<ContractDecisionView> {
    return this.decisions.propose(id(decisionId, 'Decision'), body);
  }
}
