import { Module } from '@nestjs/common';
import { StaffingModule } from '../staffing/index.js';
import { WorkflowModule } from '../workflow/index.js';
import { ContractDecisionsController, ContractsController } from './api/contracts.controller.js';
import { ContractHooks } from './application/contract-hooks.js';
import { ContractsService } from './application/contracts.service.js';
import { DecisionsService } from './application/decisions.service.js';
import { ContractsRepository } from './infra/contracts.repository.js';

/**
 * Employment contracts and end-of-contract decisions (docs/contracts/contracts-deadlines.md). The Employment module
 * imports this one (initial contract on create, contract summaries) and registers its end use case in ContractHooks.
 */
@Module({
  imports: [StaffingModule, WorkflowModule],
  controllers: [ContractsController, ContractDecisionsController],
  providers: [ContractsService, DecisionsService, ContractsRepository, ContractHooks],
  exports: [ContractsService, DecisionsService, ContractHooks],
})
export class ContractsModule {}
