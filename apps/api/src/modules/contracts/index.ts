/** Public surface of the Contracts module (the only file other modules — and the worker — may import). */
export { ContractsModule } from './contracts.module.js';
export { ContractsService, type ContractPatch, type InitialContractInput, type NewContractInput } from './application/contracts.service.js';
export { DecisionsService } from './application/decisions.service.js';
export { ContractHooks, type EndEmploymentHook } from './application/contract-hooks.js';
export type { ContractDecisionView, ContractListView, ContractSummary, ContractView } from './application/contract-views.js';
export { openDueContractDecisions } from './application/system-decisions.js';
export { initialContractBlock } from './api/contracts.dto.js';
export {
  addDays,
  addMonths,
  addYears,
  CONTRACT_TYPES,
  currentOf,
  daysBetween,
  isFixedTerm,
  type ContractKind,
  type ContractType,
  type Proposal,
} from './domain/contracts.js';
export { ContractsRepository, type ContractRow, type DecisionRow } from './infra/contracts.repository.js';
export { seedContractDefaults, seedDemoContracts, CONTRACT_DEFINITIONS } from './infra/contracts-seed.js';
